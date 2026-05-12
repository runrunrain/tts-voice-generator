/**
 * P0 Voice Production Backend Tests
 *
 * Covers:
 * - Domain validators (schema, production list, director profile)
 * - Artifact store (read, write, delete, path safety)
 * - API routes (tasks, documents, production list, director profiles, agent buttons, chat)
 * - Version conflict detection (409 VERSION_CONFLICT)
 * - Session isolation (automation vs chat)
 * - Button target policy enforcement
 * - OpenCode runner fallback
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const nc = await import("node:crypto");
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const tmp = np.join(no.tmpdir(), `tts-p0-${process.pid}-${Date.now()}`);
  nfs.mkdirSync(np.join(tmp, "audio"), { recursive: true });
  nfs.mkdirSync(np.join(tmp, "tasks"), { recursive: true });
  const testDbPath = np.join(tmp, "test.db");
  testState.tmpDir = tmp;
  testState.dbFilePath = testDbPath;
  const SALT = "tts-voice-generator-key-encryption-v1";
  const ALGO = "aes-256-gcm";
  function key(): Buffer { return nc.scryptSync(testDbPath, SALT, 32); }
  function encryptApiKey(p: string): string {
    const iv = nc.randomBytes(16);
    const c = nc.createCipheriv(ALGO, key(), iv);
    const enc = Buffer.concat([c.update(p, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  }
  function decryptApiKey(ct: string): string | null {
    try {
      const raw = Buffer.from(ct, "base64");
      const d = nc.createDecipheriv(ALGO, key(), raw.subarray(0, 16));
      d.setAuthTag(raw.subarray(16, 32));
      return d.update(raw.subarray(32)) + d.final("utf8");
    } catch { return null; }
  }
  return {
    env: {
      port: 3001,
      openRouterApiKey: null as string | null,
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
      audioOutputDir: np.join(tmp, "audio"),
      dbPath: testDbPath,
      dataDir: tmp,
      nodeEnv: "test",
    },
    encryptApiKey,
    decryptApiKey,
    maskApiKey: (k: string) => k.length > 12 ? `${k.slice(0, 3)}***...***${k.slice(-4)}` : "***configured***",
    isEnvApiKeyConfigured: () => false,
    requireEnvApiKey: () => { throw new Error("Not configured"); },
  };
});

// ─── Imports ─────────────────────────────────────────────────────────────────

import { closeDb, getDb, initSchema } from "../src/db/index.js";
import { and, eq } from "drizzle-orm";
import tasksRoutes from "../src/routes/tasks.js";
import documentsRoutes from "../src/routes/documents.js";
import productionListRoutes from "../src/routes/production-list.js";
import directorProfilesRoutes from "../src/routes/director-profiles.js";
import agentButtonsRoutes from "../src/routes/agent-buttons.js";
import agentChatRoutes from "../src/routes/agent-chat.js";
import { productionListVersion, voiceLine, agentButtonPreset, opencodeSession, agentChatSession } from "../src/db/schema-extended.js";
import {
  VoiceLineSchema,
  ProductionListSchema,
  SpeakerSchema,
  DirectorConfigSchema,
  CreateTaskSchema,
  PasteDocumentSchema,
  validateProductionList,
  validateRawPromptStructuredAgentDraft,
} from "../src/domain/validators.js";
import {
  writeArtifact,
  readArtifact,
  deleteArtifact,
  artifactExists,
} from "../src/services/artifact-store.js";
import {
  fallbackNormalize,
  applyFallbackTransform,
  checkOpenCodeAvailability,
  runOpenCodeChat,
  _setSpawnRunner,
  _resetSpawnRunner,
  _setExecRunner,
  _resetExecRunner,
  extractCandidateLines,
} from "../src/services/opencode-runner.js";
import {
  createNormalizeRun,
  writeRunProgress,
} from "../src/services/normalize-run-store.js";

// ─── Test App ────────────────────────────────────────────────────────────────

function createApp(): Hono {
  const app = new Hono();
  app.route("/", tasksRoutes);
  app.route("/", documentsRoutes);
  app.route("/", productionListRoutes);
  app.route("/", directorProfilesRoutes);
  app.route("/", agentButtonsRoutes);
  app.route("/", agentChatRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

async function jsonRes(res: Response) {
  return res.json();
}

// ─── Domain Validator Tests ──────────────────────────────────────────────────

describe("Domain Validators", () => {
  it("validates a valid voice line", () => {
    const result = VoiceLineSchema.safeParse({
      id: "test-line-1",
      order: 0,
      speaker: "narrator",
      text: "Hello world",
      voice: "Zephyr",
    });
    expect(result.success).toBe(true);
  });

  it("rejects voice line with empty text", () => {
    const result = VoiceLineSchema.safeParse({
      id: "test-line-1",
      order: 0,
      speaker: "narrator",
      text: "",
      voice: "Zephyr",
    });
    expect(result.success).toBe(false);
  });

  it("validates production list with max 2 speakers", () => {
    const result = ProductionListSchema.safeParse({
      taskId: "task-1",
      version: 1,
      lines: [],
      speakers: [
        { id: "a", label: "A", voice: "Zephyr" },
        { id: "b", label: "B", voice: "Puck" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("allows production list with >2 top-level speakers for multi-profile v2 datasets", () => {
    const result = ProductionListSchema.safeParse({
      taskId: "task-1",
      version: 1,
      lines: [],
      speakers: [
        { id: "a", label: "A", voice: "Zephyr" },
        { id: "b", label: "B", voice: "Puck" },
        { id: "c", label: "C", voice: "Charon" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("validates director config", () => {
    const result = DirectorConfigSchema.safeParse({
      audioProfile: "Broadcast quality",
      scene: "Studio recording",
      directorNotes: "Warm tone",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultVoice).toBe("Zephyr");
      expect(result.data.defaultFormat).toBe("wav");
    }
  });

  it("validates create task schema", () => {
    const result = CreateTaskSchema.safeParse({ title: "My Task", description: "desc" });
    expect(result.success).toBe(true);
    expect(CreateTaskSchema.safeParse({}).success).toBe(false);
    expect(CreateTaskSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("validates paste document schema", () => {
    expect(PasteDocumentSchema.safeParse({ fileName: "test.txt", content: "hello" }).success).toBe(true);
    expect(PasteDocumentSchema.safeParse({ fileName: "", content: "hello" }).success).toBe(false);
    expect(PasteDocumentSchema.safeParse({ fileName: "test.txt", content: "" }).success).toBe(false);
  });

  it("validateProductionList allows more than 2 top-level speakers", () => {
    const report = validateProductionList({
      lines: [],
      speakers: [
        { id: "a", label: "A", voice: "Zephyr" },
        { id: "b", label: "B", voice: "Puck" },
        { id: "c", label: "C", voice: "Charon" },
      ],
    });
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.code === "SPEAKER_LIMIT_EXCEEDED")).toBe(false);
  });

  it("validates multi-profile v2 draft with more than 2 aggregate speakers but max 2 per profile", () => {
    const report = validateRawPromptStructuredAgentDraft({
      schemaVersion: "tts.production-list.v2",
      promptProfiles: [
        {
          id: "profile_ab",
          name: "Dialogue profile",
          audioProfile: "Two-person dialogue with distinct voices.",
          scene: "A short conversation scene.",
          directorNotes: "Natural pacing and clear turns.",
          sampleContext: "A and B exchange short lines.",
          speakers: [
            { id: "a", label: "A", voice: "Zephyr" },
            { id: "b", label: "B", voice: "Puck" },
          ],
        },
        {
          id: "profile_c",
          name: "Third role profile",
          audioProfile: "Older authoritative role voice.",
          scene: "A separate NPC role section.",
          directorNotes: "Steady and authoritative delivery.",
          sampleContext: "C speaks in a separate section.",
          speakers: [{ id: "c", label: "C", voice: "Charon" }],
        },
      ],
      lines: [
        { id: "l1", order: 0, speaker: "a", speakerLabel: "A", transcript: "Hello", promptProfileId: "profile_ab", voice: "Zephyr" },
        { id: "l2", order: 1, speaker: "b", speakerLabel: "B", transcript: "Hi", promptProfileId: "profile_ab", voice: "Puck" },
        { id: "l3", order: 2, speaker: "c", speakerLabel: "C", transcript: "Welcome", promptProfileId: "profile_c", voice: "Charon" },
      ],
    });
    expect(report.valid).toBe(true);
  });

  it("validateProductionList catches invalid speaker reference", () => {
    const report = validateProductionList({
      lines: [{
        id: "l1", order: 0, speaker: "unknown", text: "Hello", voice: "Zephyr",
      }],
      speakers: [{ id: "a", label: "A", voice: "Zephyr" }],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "INVALID_SPEAKER_REFERENCE")).toBe(true);
  });

  it("validateProductionList returns valid for correct input", () => {
    const report = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "a", text: "Hello", voice: "Zephyr" },
        { id: "l2", order: 1, speaker: "a", text: "World", voice: "Zephyr" },
      ],
      speakers: [{ id: "a", label: "Narrator", voice: "Zephyr" }],
    });
    expect(report.valid).toBe(true);
    expect(report.stats.totalLines).toBe(2);
    expect(report.stats.speakers).toEqual(["Narrator"]);
  });
});

// ─── Artifact Store Tests ────────────────────────────────────────────────────

describe("Artifact Store", () => {
  const validTaskId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

  it("writes and reads an artifact", () => {
    const data = { lines: [{ id: "l1", text: "Hello" }] };
    const meta = writeArtifact(validTaskId, "production-list.json", data);
    expect(meta.sha256).toBeTruthy();
    expect(meta.sizeBytes).toBeGreaterThan(0);

    const loaded = readArtifact(validTaskId, "production-list.json");
    expect(loaded).toEqual(data);
  });

  it("returns null for non-existent artifact", () => {
    const loaded = readArtifact(validTaskId, "nonexistent.json");
    expect(loaded).toBeNull();
  });

  it("rejects invalid task IDs", () => {
    expect(() => writeArtifact("not-a-uuid", "production-list.json", {})).toThrow("Invalid task ID");
    expect(() => writeArtifact("../../../etc/passwd", "production-list.json", {})).toThrow("Invalid task ID");
  });

  it("rejects artifact names with path traversal", () => {
    expect(() => writeArtifact(validTaskId, "../../../etc/passwd", {})).toThrow();
    expect(() => writeArtifact(validTaskId, "../production-list.json", {})).toThrow();
  });

  it("deletes an artifact", () => {
    writeArtifact(validTaskId, "production-list.json", { test: true });
    expect(artifactExists(validTaskId, "production-list.json")).toBe(true);
    const deleted = deleteArtifact(validTaskId, "production-list.json");
    expect(deleted).toBe(true);
    expect(artifactExists(validTaskId, "production-list.json")).toBe(false);
  });
});

// ─── OpenCode Runner Tests ───────────────────────────────────────────────────

describe("OpenCode Runner", () => {
  it("fallbackNormalize handles empty docs", () => {
    const result = fallbackNormalize({ documents: [] });
    expect(result.runner).toBe("fallback");
    expect(result.productionList.lines).toEqual([]);
    expect(result.warnings.some((w) => w.code === "NO_ENABLED_DOCS")).toBe(true);
  });

  it("fallbackNormalize parses single-speaker content", () => {
    const result = fallbackNormalize({
      documents: [{
        id: "d1",
        fileName: "script.txt",
        content: "Hello world\nThis is a test\n# comment line\n",
        enabled: true,
      }],
    });
    expect(result.runner).toBe("fallback");
    expect(result.productionList.lines).toHaveLength(2);
    expect(result.productionList.lines[0].text).toBe("Hello world");
    expect(result.productionList.lines[0].speaker).toBe("narrator");
    expect(result.productionList.speakers).toHaveLength(1);
    expect(result.productionList.speakers[0].label).toBe("旁白");
  });

  it("fallbackNormalize parses multi-speaker content", () => {
    const result = fallbackNormalize({
      documents: [{
        id: "d1",
        fileName: "dialogue.txt",
        content: "Alice: Hello there\nBob: Hi Alice\nAlice: How are you?",
        enabled: true,
      }],
    });
    expect(result.productionList.lines).toHaveLength(3);
    expect(result.productionList.speakers).toHaveLength(2);
  });

  it("fallbackNormalize preserves more than 2 detected speakers without global collapse", () => {
    const result = fallbackNormalize({
      documents: [{
        id: "d1",
        fileName: "multi.txt",
        content: "Alice: Line 1\nBob: Line 2\nCharlie: Line 3",
        enabled: true,
      }],
    });
    expect(result.productionList.speakers).toHaveLength(3);
    expect(result.warnings.some((w) => w.code === "SPEAKER_MAPPED")).toBe(false);
  });

  it("extractCandidateLines retains 声线 metadata and associates section role with candidate lines", () => {
    const result = extractCandidateLines({
      documents: [{
        id: "doc-role-1",
        fileName: "roles.md",
        enabled: true,
        content: [
          "### 1. 世家大族/门阀子弟/年轻名士",
          "",
          "**声线**：男青年到中青年，带天然优越感与轻慢感，语速从容",
          "",
          "**台词**：",
          "- 卖猪屠夫位列三公，简直令天下士人耻笑。",
          "### 2. 士族女眷",
          "**声线**：年轻女性，聪慧活泼的贵族女性，少女感",
          "- 真定玉梨，大如拳，甘如蜜，脆如菱。",
        ].join("\n"),
      }],
    });

    expect(result.voiceMetadata).toHaveLength(2);
    expect(result.qualitySummary.skippedByReason.voice_metadata).toBe(2);
    expect(result.qualitySummary.skippedByReason.label_only).toBe(1);
    expect(result.voiceMetadata[0]).toMatchObject({
      sectionTitle: "1. 世家大族/门阀子弟/年轻名士",
      inferredSpeakerLabel: "世家大族/门阀子弟/年轻名士",
      lineRange: { start: 3, end: 3 },
    });
    expect(result.candidateLines[0]).toMatchObject({
      speakerLabel: "世家大族/门阀子弟/年轻名士",
      sectionTitle: "1. 世家大族/门阀子弟/年轻名士",
      voiceMetadataId: result.voiceMetadata[0].id,
    });
    expect(result.candidateLines[1]).toMatchObject({
      speakerLabel: "士族女眷",
      voice: "Leda",
      voiceMetadataId: result.voiceMetadata[1].id,
    });
  });

  it("applyFallbackTransform shortens text", () => {
    const result = applyFallbackTransform("shorten", "This is a long sentence. And another one. And a third.", {});
    expect(result.length).toBeLessThan("This is a long sentence. And another one. And a third.".length);
  });

  it("applyFallbackTransform applies style prefix", () => {
    const result = applyFallbackTransform("style", "Hello world", { tone: "dramatic" });
    expect(result).toContain("[Dramatic]");
    expect(result).toContain("Hello world");
  });

  it("applyFallbackTransform throws for unknown type", () => {
    expect(() => applyFallbackTransform("unknown", "text", {})).toThrow("Unknown button transform type");
  });

  it("runOpenCodeChat rejects taskId path traversal before spawning", async () => {
    let spawned = false;
    _setSpawnRunner(async () => {
      spawned = true;
      return { stdout: "", stderr: "" };
    });

    try {
      const invalidTaskIds = [
        "../db",
        "tasks/other",
        "/tmp/other-task",
        "c0a8012e-1111-4111-8111-123456789abc/child",
        "c0a8012e-1111-4111-8111-123456789abc\\child",
        " c0a8012e-1111-4111-8111-123456789abc ",
      ];

      for (const taskId of invalidTaskIds) {
        await expect(runOpenCodeChat({
          sessionId: crypto.randomUUID(),
          taskId,
          userMessage: "hello",
        })).rejects.toThrow("Invalid chat taskId");
      }
      expect(spawned).toBe(false);
    } finally {
      _resetSpawnRunner();
    }
  });

  it("checkOpenCodeAvailability returns result (likely unavailable in test env)", async () => {
    const result = await checkOpenCodeAvailability();
    expect(result).toHaveProperty("available");
    expect(typeof result.available).toBe("boolean");
  });
});

// ─── API Route Tests ─────────────────────────────────────────────────────────

describe("API Routes - Tasks", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();
  });

  afterEach(() => {
    _resetSpawnRunner();
    _resetExecRunner();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("creates and lists tasks", async () => {
    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test Task", description: "A test" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await jsonRes(createRes);
    expect(createBody.ok).toBe(true);
    expect(createBody.task.title).toBe("Test Task");
    expect(createBody.task.status).toBe("draft");

    const listRes = await req(app, "/api/tasks");
    expect(listRes.status).toBe(200);
    const listBody = await jsonRes(listRes);
    expect(listBody.ok).toBe(true);
    expect(listBody.tasks).toHaveLength(1);
    expect(listBody.tasks[0].title).toBe("Test Task");
  });

  it("gets a single task by ID", async () => {
    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Get Test" }),
    });
    const { task } = await jsonRes(createRes);

    const getRes = await req(app, `/api/tasks/${task.id}`);
    expect(getRes.status).toBe(200);
    const getBody = await jsonRes(getRes);
    expect(getBody.task.id).toBe(task.id);
  });

  it("returns real task statistics from latest production version", async () => {
    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Stats Test" }),
    });
    const { task } = await jsonRes(createRes);

    await req(app, `/api/tasks/${task.id}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "a.txt", content: "A" }),
    });
    await req(app, `/api/tasks/${task.id}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "b.txt", content: "B" }),
    });

    const speakers = [{ id: "narrator", label: "Narrator", voice: "Zephyr" }];
    await req(app, `/api/tasks/${task.id}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        speakers,
        lines: [
          { id: "v1-l1", order: 0, speaker: "narrator", text: "Line 1", voice: "Zephyr" },
          { id: "v1-l2", order: 1, speaker: "narrator", text: "Line 2", voice: "Zephyr" },
        ],
      }),
    });
    await req(app, `/api/tasks/${task.id}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        speakers,
        lines: [
          { id: "v2-l1", order: 0, speaker: "narrator", text: "Line 1", voice: "Zephyr", generationStatus: "succeeded" },
          { id: "v2-l2", order: 1, speaker: "narrator", text: "Line 2", voice: "Zephyr", generationStatus: "failed" },
          { id: "v2-l3", order: 2, speaker: "narrator", text: "Line 3", voice: "Zephyr" },
        ],
      }),
    });

    const listRes = await req(app, "/api/tasks");
    expect(listRes.status).toBe(200);
    const listBody = await jsonRes(listRes);
    const listedTask = listBody.tasks.find((entry: any) => entry.id === task.id);
    expect(listedTask.documentCount).toBe(2);
    expect(listedTask.productionVersionCount).toBe(2);
    expect(listedTask.latestProductionVersion).toBe(2);
    expect(listedTask.latestLineCount).toBe(3);
    expect(listedTask.lineCount).toBe(3);
    expect(listedTask.generatedLineCount).toBe(1);
    expect(listedTask.failedLineCount).toBe(1);
    expect(listedTask.status).toBe("failed");
    expect(listedTask.rawStatus).toBe("draft");
    expect(listedTask.statusReason).toBe("failed_lines_present");

    const getRes = await req(app, `/api/tasks/${task.id}`);
    const getBody = await jsonRes(getRes);
    expect(getBody.task.documentCount).toBe(2);
    expect(getBody.task.productionVersionCount).toBe(2);
    expect(getBody.task.latestProductionVersion).toBe(2);
    expect(getBody.task.latestLineCount).toBe(3);
    expect(getBody.task.lineCount).toBe(3);
    expect(getBody.task.status).toBe("failed");
  });

  it("derives task status from real stats and filters by normalized status query", async () => {
    async function createTask(title: string) {
      const createRes = await req(app, "/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      expect(createRes.status).toBe(201);
      const { task } = await jsonRes(createRes);
      return task;
    }

    async function putList(taskId: string, statuses: string[]) {
      const res = await req(app, `/api/tasks/${taskId}/production-list`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 0,
          speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
          lines: statuses.map((generationStatus, index) => ({
            id: `line-${taskId}-${index}`,
            order: index,
            speaker: "narrator",
            text: `Line ${index + 1}`,
            voice: "Zephyr",
            generationStatus,
          })),
        }),
      });
      expect(res.status).toBe(200);
    }

    const draft = await createTask("Status Draft");
    const docsReady = await createTask("Status Docs Ready");
    await req(app, `/api/tasks/${docsReady.id}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "requirements.md", content: "Need voice lines" }),
    });

    const productionReady = await createTask("Status Production Ready");
    await putList(productionReady.id, ["draft", "draft"]);

    const running = await createTask("Status Running");
    await putList(running.id, ["succeeded", "draft"]);

    const completed = await createTask("Status Completed");
    await putList(completed.id, ["succeeded"]);

    const failed = await createTask("Status Failed");
    await putList(failed.id, ["succeeded", "failed"]);

    const blocked = await createTask("Status Blocked");
    await req(app, `/api/tasks/${blocked.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked" }),
    });

    const listRes = await req(app, "/api/tasks");
    expect(listRes.status).toBe(200);
    const listBody = await jsonRes(listRes);
    const byId = new Map(listBody.tasks.map((entry: any) => [entry.id, entry]));

    expect(byId.get(draft.id).status).toBe("draft");
    expect(byId.get(draft.id).statusReason).toBe("empty_task");
    expect(byId.get(docsReady.id).status).toBe("ready");
    expect(byId.get(docsReady.id).statusReason).toBe("documents_ready");
    expect(byId.get(productionReady.id).status).toBe("ready");
    expect(byId.get(productionReady.id).statusReason).toBe("production_list_ready");
    expect(byId.get(running.id).status).toBe("running");
    expect(byId.get(running.id).statusReason).toBe("partial_generation_succeeded");
    expect(byId.get(completed.id).status).toBe("completed");
    expect(byId.get(completed.id).statusReason).toBe("all_lines_succeeded");
    expect(byId.get(failed.id).status).toBe("failed");
    expect(byId.get(failed.id).statusReason).toBe("failed_lines_present");
    expect(byId.get(blocked.id).status).toBe("blocked");
    expect(byId.get(blocked.id).statusReason).toBe("raw_blocked");
    expect(byId.get(running.id).rawStatus).toBe("draft");
    expect(byId.get(running.id).generatedLineCount).toBe(1);
    expect(byId.get(running.id).failedLineCount).toBe(0);

    const runningRes = await req(app, "/api/tasks?status=running");
    expect(runningRes.status).toBe(200);
    const runningBody = await jsonRes(runningRes);
    expect(runningBody.tasks.map((entry: any) => entry.id)).toEqual([running.id]);
    expect(runningBody.tasks.every((entry: any) => entry.status === "running")).toBe(true);

    const inProgressRes = await req(app, "/api/tasks?status=in_progress");
    expect(inProgressRes.status).toBe(200);
    const inProgressBody = await jsonRes(inProgressRes);
    expect(inProgressBody.tasks.map((entry: any) => entry.id)).toEqual([running.id]);

    const readyRes = await req(app, "/api/tasks?status=ready");
    expect(readyRes.status).toBe(200);
    const readyBody = await jsonRes(readyRes);
    expect(new Set(readyBody.tasks.map((entry: any) => entry.id))).toEqual(new Set([docsReady.id, productionReady.id]));
    expect(readyBody.tasks.every((entry: any) => entry.status === "ready")).toBe(true);

    const invalidRes = await req(app, "/api/tasks?status=unknown");
    expect(invalidRes.status).toBe(400);
    const invalidBody = await jsonRes(invalidRes);
    expect(invalidBody.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for non-existent task", async () => {
    const res = await req(app, "/api/tasks/nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("patches a task", async () => {
    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Before" }),
    });
    const { task } = await jsonRes(createRes);

    const patchRes = await req(app, `/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "After", status: "in_progress" }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await jsonRes(patchRes);
    expect(patchBody.task.title).toBe("After");
    expect(patchBody.task.status).toBe("running");
    expect(patchBody.task.rawStatus).toBe("in_progress");
    expect(patchBody.task.statusReason).toBe("raw_status_fallback");
  });

  it("rejects invalid task creation", async () => {
    const res = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("API Routes - Documents", () => {
  let app: Hono;
  let taskId: string;

  beforeEach(async () => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();

    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Doc Test" }),
    });
    const body = await jsonRes(createRes);
    taskId = body.task.id;
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("pastes a document and retrieves it", async () => {
    const pasteRes = await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "script.txt", content: "Hello world\nThis is a test" }),
    });
    expect(pasteRes.status).toBe(201);
    const pasteBody = await jsonRes(pasteRes);
    expect(pasteBody.ok).toBe(true);
    expect(pasteBody.document.fileName).toBe("script.txt");
    expect(pasteBody.document.contentSha256).toBeTruthy();

    const docId = pasteBody.document.id;

    // Get single document with content
    const getRes = await req(app, `/api/tasks/${taskId}/documents/${docId}`);
    expect(getRes.status).toBe(200);
    const getBody = await jsonRes(getRes);
    expect(getBody.document.content).toBe("Hello world\nThis is a test");
  });

  it("lists documents for a task", async () => {
    await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "a.txt", content: "A" }),
    });
    await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "b.txt", content: "B" }),
    });

    const listRes = await req(app, `/api/tasks/${taskId}/documents`);
    const listBody = await jsonRes(listRes);
    expect(listBody.documents).toHaveLength(2);
  });

  it("deletes a document", async () => {
    const pasteRes = await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "delete.txt", content: "bye" }),
    });
    const docId = (await jsonRes(pasteRes)).document.id;

    const deleteRes = await req(app, `/api/tasks/${taskId}/documents/${docId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    const listRes = await req(app, `/api/tasks/${taskId}/documents`);
    const listBody = await jsonRes(listRes);
    expect(listBody.documents).toHaveLength(0);
  });

  it("rejects paste for non-existent task", async () => {
    const res = await req(app, "/api/tasks/nonexistent/documents/paste", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "x.txt", content: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("API Routes - Production List", () => {
  let app: Hono;
  let taskId: string;

  beforeEach(async () => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();

    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "PL Test" }),
    });
    taskId = (await jsonRes(createRes)).task.id;
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty production list for new task", async () => {
    const res = await req(app, `/api/tasks/${taskId}/production-list`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.productionList.version).toBe(0);
    expect(body.productionList.lines).toEqual([]);
  });

  it("PUT creates production list and GET retrieves it", async () => {
    const lines = [
      { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      { id: "l2", order: 1, speaker: "narrator", text: "World", voice: "Zephyr" },
    ];
    const speakers = [{ id: "narrator", label: "Narrator", voice: "Zephyr" }];

    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, lines, speakers }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await jsonRes(putRes);
    expect(putBody.productionList.version).toBe(1);
    expect(putBody.productionList.lines).toHaveLength(2);

    // GET confirms
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.version).toBe(1);
    expect(getBody.productionList.lines).toHaveLength(2);
  });

  it("roundtrips artifact-only moduleName and title without DB columns", async () => {
    const lines = [
      {
        id: "l1",
        order: 0,
        moduleName: "开场模块",
        title: "欢迎语",
        speaker: "narrator",
        speakerLabel: "旁白",
        text: "欢迎使用语音生产工具。",
        transcript: "欢迎使用语音生产工具。",
        voice: "Zephyr",
      },
    ];
    const speakers = [{ id: "narrator", label: "Narrator", voice: "Zephyr" }];

    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, lines, speakers, metadata: { schemaVersion: "tts.production-list.v2" } }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await jsonRes(putRes);
    expect(putBody.productionList.lines[0].moduleName).toBe("开场模块");
    expect(putBody.productionList.lines[0].title).toBe("欢迎语");

    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.lines[0].moduleName).toBe("开场模块");
    expect(getBody.productionList.lines[0].title).toBe("欢迎语");

    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateLine",
        payload: { lineId: "l1", updates: { title: "欢迎语修订", notes: "keep artifact fields" } },
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await jsonRes(patchRes);
    expect(patchBody.productionList.lines[0].moduleName).toBe("开场模块");
    expect(patchBody.productionList.lines[0].title).toBe("欢迎语修订");
  });

  it("PUT returns 409 on version conflict", async () => {
    // Create v1
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        lines: [{ id: "l1", order: 0, speaker: "n", text: "A", voice: "Zephyr" }],
        speakers: [{ id: "n", label: "N", voice: "Zephyr" }],
      }),
    });

    // Try with wrong expectedVersion
    const conflictRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0, // should be 1
        lines: [{ id: "l2", order: 0, speaker: "n", text: "B", voice: "Zephyr" }],
        speakers: [{ id: "n", label: "N", voice: "Zephyr" }],
      }),
    });
    expect(conflictRes.status).toBe(409);
    const body = await jsonRes(conflictRes);
    expect(body.error.code).toBe("VERSION_CONFLICT");
    expect(body.error.metadata.currentVersion).toBe(1);
  });

  it("validate endpoint reports issues", async () => {
    // Create with speaker limit violation via direct PUT (speakers > 2 rejected by schema)
    // Instead, create valid list then validate
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        lines: [{ id: "l1", order: 0, speaker: "n", text: "Valid line", voice: "Zephyr" }],
        speakers: [{ id: "n", label: "Narrator", voice: "Zephyr" }],
      }),
    });

    const validateRes = await req(app, `/api/tasks/${taskId}/production-list/validate`, { method: "POST" });
    expect(validateRes.status).toBe(200);
    const vBody = await jsonRes(validateRes);
    expect(vBody.validation.valid).toBe(true);
  });
});

describe("API Routes - Director Profiles", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("creates and lists director profiles", async () => {
    const createRes = await req(app, "/api/director-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Podcast",
        description: "Podcast style",
        config: { audioProfile: "Warm", scene: "Studio" },
      }),
    });
    expect(createRes.status).toBe(201);
    const body = await jsonRes(createRes);
    expect(body.profile.name).toBe("Podcast");
    expect(body.profile.config.audioProfile).toBe("Warm");

    const listRes = await req(app, "/api/director-profiles");
    const listBody = await jsonRes(listRes);
    expect(listBody.profiles).toHaveLength(1);
  });

  it("rejects duplicate profile names", async () => {
    await req(app, "/api/director-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unique" }),
    });
    const dupRes = await req(app, "/api/director-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unique" }),
    });
    expect(dupRes.status).toBe(409);
  });

  it("patches a profile", async () => {
    const createRes = await req(app, "/api/director-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Patchable" }),
    });
    const { profile } = await jsonRes(createRes);

    const patchRes = await req(app, `/api/director-profiles/${profile.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Patched", description: "Updated" }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await jsonRes(patchRes);
    expect(patchBody.profile.name).toBe("Patched");
    expect(patchBody.profile.description).toBe("Updated");
  });
});

describe("API Routes - Agent Buttons", () => {
  let app: Hono;
  let taskId: string;

  beforeEach(async () => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();

    // Mock _spawnRunner to avoid real opencode run calls in tests.
    // Without this mock, real opencode AI inference would run and timeout.
    _setSpawnRunner(async () => {
      throw new Error("opencode run not available in test environment");
    });

    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Button Test" }),
    });
    taskId = (await jsonRes(createRes)).task.id;
  });

  afterEach(() => {
    _resetSpawnRunner();
    _resetExecRunner();
  });

  afterAll(() => {
    _resetSpawnRunner();
    _resetExecRunner();
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("lists button presets (seeded)", async () => {
    const res = await req(app, "/api/agent/buttons");
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.buttons.length).toBeGreaterThanOrEqual(3);
    expect(body.buttons.map((b: any) => b.buttonKey)).toContain("shorten");
    expect(body.buttons.map((b: any) => b.buttonKey)).toContain("expand");
  });

  async function pasteDocument(content = "Alice: Hello\nBob: Hi there") {
    return req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "script.txt", content }),
    });
  }

  async function expectProductionListUnchanged(expectedVersion: number) {
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    expect(getRes.status).toBe(200);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.version).toBe(expectedVersion);
    if (expectedVersion === 0) {
      expect(getBody.productionList.lines).toHaveLength(0);
      expect(getBody.productionList.schemaVersion).not.toBe("1.0");
      expect(getBody.productionList.promptProfiles).toBeUndefined();
    } else {
      expect(getBody.productionList.schemaVersion).toBe("tts.production-list.v2");
      expect(getBody.productionList.promptProfiles?.length).toBeGreaterThan(0);
    }
  }

  function mockOpenCodeAvailable() {
    _setExecRunner(async (_file, args) => {
      if (args.includes("--version")) return { stdout: "opencode 1.0.0", stderr: "" };
      if (args.includes("providers")) return { stdout: "Provider 1 credential", stderr: "" };
      return { stdout: "", stderr: "" };
    });
  }

  function extractDraftPathFromArgs(args: string[]): string {
    const promptArg = args.find((arg) => typeof arg === "string" && arg.includes("Write the result to:")) ?? "";
    const draftPath = String(promptArg).match(/Write the result to: (.+)$/m)?.[1]?.trim();
    expect(draftPath).toBeTruthy();
    return draftPath!;
  }

  function extractNormalizeRequestPathFromArgs(args: string[]): string {
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--file" && String(args[i + 1]).endsWith("normalize-request.json")) {
        return String(args[i + 1]);
      }
    }
    const promptArg = args.find((arg) => typeof arg === "string" && arg.includes("Read the normalize request at:")) ?? "";
    const requestPath = String(promptArg).match(/Read the normalize request at: (.+)$/m)?.[1]?.trim();
    expect(requestPath).toBeTruthy();
    return requestPath!;
  }

  function writeValidV2Draft(draftPath: string, transcript = "进入语音生成流程。") {
    fs.writeFileSync(draftPath, JSON.stringify({
      schemaVersion: "tts.production-list.v2",
      promptProfiles: [{
        id: "profile_agent_narrator",
        name: "Agent narrator profile",
        audioProfile: "Clear narrator voice with warm tone.",
        scene: "In-app voice generation workflow guidance.",
        directorNotes: "Calm pace, natural pauses, precise pronunciation.",
        sampleContext: "A product workflow narration converted by the Agent.",
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
        reusePolicy: "many-lines",
      }],
      lines: [{
        id: "line_agent_1",
        order: 0,
        speaker: "narrator",
        speakerLabel: "Narrator",
        transcript,
        text: transcript,
        promptProfileId: "profile_agent_narrator",
        voice: "Zephyr",
        responseFormat: "wav",
      }],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    }));
  }

  async function waitForNormalizeProgress(runId: string, expectedStage: string, maxAttempts = 25) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const progressRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${runId}/progress`);
      expect(progressRes.status).toBe(200);
      const progress = await jsonRes(progressRes);
      if (progress.stage === expectedStage) return progress;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${runId}/progress`);
    const finalProgress = await jsonRes(finalRes);
    throw new Error(`Progress did not reach ${expectedStage}; latest stage ${finalProgress.stage}`);
  }

  function writeMinimalCompactV2DraftFromRequest(normalizeRequestPath: string, draftPath: string) {
    const bundle = JSON.parse(fs.readFileSync(normalizeRequestPath, "utf-8"));
    const candidatesArtifact = JSON.parse(fs.readFileSync(bundle.candidateLines.path, "utf-8"));
    const candidates = candidatesArtifact.candidateLines.slice(0, 2);
    expect(candidates.length).toBeGreaterThan(0);

    fs.writeFileSync(draftPath, JSON.stringify({
      schemaVersion: "tts.production-list.v2",
      promptProfiles: [{
        id: "profile_compact_narrator",
        name: "Compact narrator profile",
        audioProfile: "Clear narrator voice with warm tone.",
        scene: "Compact normalized voice production flow.",
        directorNotes: "Calm pace, natural pauses, precise pronunciation.",
        sampleContext: "Candidate lines are bound to a reusable prompt profile.",
        speakers: [{ id: candidates[0].speaker, label: candidates[0].speakerLabel, voice: candidates[0].voice }],
        reusePolicy: "many-lines",
      }],
      lines: candidates.map((candidate: any) => ({
        id: candidate.id,
        order: candidate.order,
        speaker: candidate.speaker,
        speakerLabel: candidate.speakerLabel,
        transcript: candidate.transcript,
        promptProfileId: "profile_compact_narrator",
        voice: candidate.voice,
      })),
    }));
  }

  function writeRoleAwareV2DraftFromRequest(normalizeRequestPath: string, draftPath: string) {
    const bundle = JSON.parse(fs.readFileSync(normalizeRequestPath, "utf-8"));
    const candidatesArtifact = JSON.parse(fs.readFileSync(bundle.candidateLines.path, "utf-8"));
    const candidates = candidatesArtifact.candidateLines;
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidatesArtifact.voiceMetadata.length).toBeGreaterThan(1);

    const bySpeaker = new Map<string, any[]>();
    for (const candidate of candidates) {
      const existing = bySpeaker.get(candidate.speaker) ?? [];
      existing.push(candidate);
      bySpeaker.set(candidate.speaker, existing);
    }

    const promptProfiles = Array.from(bySpeaker.entries()).map(([speakerId, speakerCandidates], index) => {
      const first = speakerCandidates[0];
      return {
        id: `profile_role_${index + 1}`,
        name: `${first.speakerLabel} profile`,
        audioProfile: `Role-aware voice profile for ${first.speakerLabel}.`,
        scene: `NPC requirement section ${first.sectionTitle ?? first.speakerLabel}.`,
        directorNotes: `Deliver with style derived from source voice metadata for ${first.speakerLabel}.`,
        sampleContext: `Candidate lines from ${first.speakerLabel} section.`,
        speakers: [{ id: speakerId, label: first.speakerLabel, voice: first.voice }],
        reusePolicy: "many-lines",
      };
    });

    const profileBySpeaker = new Map(promptProfiles.map((profile) => [profile.speakers[0].id, profile.id]));
    fs.writeFileSync(draftPath, JSON.stringify({
      schemaVersion: "tts.production-list.v2",
      promptProfiles,
      lines: candidates.map((candidate: any) => ({
        id: candidate.id,
        order: candidate.order,
        speaker: candidate.speaker,
        speakerLabel: candidate.speakerLabel,
        transcript: candidate.transcript,
        promptProfileId: profileBySpeaker.get(candidate.speaker),
        voice: candidate.voice,
      })),
    }));
  }

  async function createManualProductionList() {
    const longButtonText = "This is a very long sentence that should be shortened by the button transform for testing purposes";
    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        schemaVersion: "tts.production-list.v2",
        promptProfiles: [{
          id: "profile_manual",
          name: "Manual narrator",
          audioProfile: "Clear narrator voice.",
          scene: "Manual setup scene.",
          directorNotes: "Speak clearly.",
          sampleContext: "Manual production list setup.",
          speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
        }],
        lines: [{
          id: "l1",
          order: 0,
          speaker: "narrator",
          text: longButtonText,
          transcript: longButtonText,
          voice: "Zephyr",
          promptProfileId: "profile_manual",
          directorProfileId: "profile_manual",
        }],
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
        metadata: { schemaVersion: "tts.production-list.v2" },
      }),
    });
    expect(putRes.status).toBe(200);
  }

  async function createCurrentProductionListWithLineCount(lineCount: number) {
    const lines = Array.from({ length: lineCount }, (_, index) => ({
      id: crypto.randomUUID(),
      order: index,
      speaker: "narrator",
      speakerLabel: "Narrator",
      transcript: `Existing production line ${index + 1}`,
      text: `Existing production line ${index + 1}`,
      promptProfileId: "profile_manual_large",
      voice: "Zephyr",
      responseFormat: "wav",
    }));

    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        schemaVersion: "tts.production-list.v2",
        promptProfiles: [{
          id: "profile_manual_large",
          name: "Manual large narrator",
          audioProfile: "Clear narrator voice for a large existing production list.",
          scene: "Large existing production list timeout calculation.",
          directorNotes: "Speak clearly and consistently.",
          sampleContext: "A large current production list used for bundle timeout budgeting.",
          speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
        }],
        lines,
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
      }),
    });
    expect(putRes.status).toBe(200);
  }

  it("normalize-requirements returns 503 when OpenCode unavailable and does not create fallback v1", async () => {
    _setExecRunner(async () => {
      throw new Error("opencode unavailable in test");
    });
    // Paste a document first
    await pasteDocument();

    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(503);
    const body = await jsonRes(normRes);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("OPENCODE_UNAVAILABLE");
    expect(body.runnerStatus.fallbackUsed).toBe(false);
    expect(body.fallbackUsed).not.toBe(true);
    await expectProductionListUnchanged(0);
  });

  it("normalize-requirements commits valid prompt-structured v2 draft from OpenCode", async () => {
    await pasteDocument("Narrator: 进入语音生成流程");

    mockOpenCodeAvailable();
    _setSpawnRunner(async (_file, args) => {
      writeValidV2Draft(extractDraftPathFromArgs(args));
      return { stdout: JSON.stringify({ type: "text", part: { text: "Draft written." } }), stderr: "" };
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(200);
      const body = await jsonRes(normRes);
      expect(body.ok).toBe(true);
      expect(body.runner).toBe("opencode");
      expect(body.productionList.schemaVersion).toBe("tts.production-list.v2");
      expect(body.productionList.promptProfiles).toHaveLength(1);
      const profile = body.productionList.promptProfiles[0];
      for (const field of ["name", "description", "audioProfile", "scene", "directorNotes", "sampleContext", "style", "pacing", "accent", "emotion", "performanceNotes"]) {
        expect(profile[field]).toMatch(/[\u4e00-\u9fff]/);
      }
      expect(profile.speakers[0].label).toBe("旁白");
      expect(body.productionList.lines[0].speakerLabel).toBe("旁白");
      expect(body.productionList.lines[0].promptProfileId).toBe("profile_agent_narrator");
      expect(body.productionList.lines[0].directorProfileId).toBe("profile_agent_narrator");

      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);
      expect(getBody.productionList.promptProfiles).toHaveLength(1);
      expect(getBody.productionList.lines[0].transcript).toBe("进入语音生成流程。");
    } finally {
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements provides candidate lines and commits minimal compact v2 draft", async () => {
    await pasteDocument("Narrator: 第一条候选台词\nNarrator: 第二条候选台词");

    mockOpenCodeAvailable();
    let capturedNormalizeRequestPath = "";
    _setSpawnRunner(async (_file, args) => {
      capturedNormalizeRequestPath = extractNormalizeRequestPathFromArgs(args);
      writeMinimalCompactV2DraftFromRequest(capturedNormalizeRequestPath, extractDraftPathFromArgs(args));
      return { stdout: JSON.stringify({ type: "text", part: { text: "Compact draft written." } }), stderr: "" };
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(200);
      const body = await jsonRes(normRes);
      expect(body.ok).toBe(true);
      expect(body.productionList.schemaVersion).toBe("tts.production-list.v2");
      expect(body.productionList.lines).toHaveLength(2);
      expect(body.productionList.lines[0].text).toBe("第一条候选台词");
      expect(body.productionList.lines[0].transcript).toBe("第一条候选台词");
      expect(body.productionList.lines[0].model).toBe("google/gemini-3.1-flash-tts-preview");
      expect(body.productionList.lines[0].responseFormat).toBe("wav");
      expect(body.productionList.speakers).toHaveLength(1);

      const bundle = JSON.parse(fs.readFileSync(capturedNormalizeRequestPath, "utf-8"));
      expect(bundle.candidateLines.path).toMatch(/candidate-lines\.json$/);
      expect(bundle.candidateLines.count).toBe(2);
      expect(bundle.currentState.currentProductionListPath).toBeNull();
      expect(bundle.safety.allowedReadPaths).toContain(bundle.candidateLines.path);
      expect(bundle.safety.allowedReadPaths.some((p: string) => p.endsWith("production-list.json"))).toBe(false);

      const candidatesArtifact = JSON.parse(fs.readFileSync(bundle.candidateLines.path, "utf-8"));
      expect(candidatesArtifact.candidateLines[0]).toMatchObject({
        order: 0,
        speaker: "narrator",
        speakerLabel: "Narrator",
        transcript: "第一条候选台词",
        voice: "Zephyr",
      });
    } finally {
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements candidate artifact preserves voice metadata and commits multi-role speakers", async () => {
    await pasteDocument([
      "### 1. 世家大族/门阀子弟/年轻名士",
      "**声线**：男青年到中青年，带天然优越感与轻慢感，语速从容",
      "- 卖猪屠夫位列三公，简直令天下士人耻笑。",
      "### 2. 士族女眷",
      "**声线**：年轻女性，聪慧活泼的贵族女性，少女感",
      "- 真定玉梨，大如拳，甘如蜜，脆如菱。",
    ].join("\n"));

    mockOpenCodeAvailable();
    let capturedNormalizeRequestPath = "";
    _setSpawnRunner(async (_file, args) => {
      capturedNormalizeRequestPath = extractNormalizeRequestPathFromArgs(args);
      writeRoleAwareV2DraftFromRequest(capturedNormalizeRequestPath, extractDraftPathFromArgs(args));
      return { stdout: JSON.stringify({ type: "text", part: { text: "Role-aware draft written." } }), stderr: "" };
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(200);
      const body = await jsonRes(normRes);
      expect(body.ok).toBe(true);
      expect(new Set(body.productionList.lines.map((line: any) => line.speakerLabel)).size).toBeGreaterThan(1);
      expect(body.productionList.promptProfiles).toHaveLength(2);
      expect(body.productionList.speakers).toHaveLength(2);

      const bundle = JSON.parse(fs.readFileSync(capturedNormalizeRequestPath, "utf-8"));
      const candidatesArtifact = JSON.parse(fs.readFileSync(bundle.candidateLines.path, "utf-8"));
      expect(candidatesArtifact.voiceMetadata).toHaveLength(2);
      expect(candidatesArtifact.voiceMetadata[0]).toMatchObject({
        sectionTitle: "1. 世家大族/门阀子弟/年轻名士",
        inferredSpeakerLabel: "世家大族/门阀子弟/年轻名士",
      });
      expect(candidatesArtifact.candidateLines[0].voiceMetadataId).toBe(candidatesArtifact.voiceMetadata[0].id);
    } finally {
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements rejects schema-valid polluted transcript with 422 and no DB write", async () => {
    await pasteDocument("Narrator: 正常候选台词");
    mockOpenCodeAvailable();
    _setSpawnRunner(async (_file, args) => {
      writeValidV2Draft(extractDraftPathFromArgs(args), "来源：https://polluted.example/script");
      return { stdout: JSON.stringify({ type: "text", part: { text: "Polluted draft written." } }), stderr: "" };
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(422);
      const body = await jsonRes(normRes);
      expect(body.error.code).toBe("PRODUCTION_LIST_QUALITY_GATE_FAILED");
      expect(body.error.message).toContain("生产列表草稿质量门失败");
      expect(body.error.message).toContain("未触发 TTS 音频生成");
      expect(body.qualityReport.blockingIssueCount).toBeGreaterThan(0);
      expect(body.qualityReport.issues.map((issue: any) => issue.code)).toContain("TRANSCRIPT_METADATA_SOURCE");
      await expectProductionListUnchanged(0);

      const progressRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${body.runId}/progress`);
      expect(progressRes.status).toBe(200);
      const progress = await jsonRes(progressRes);
      expect(progress.stage).toBe("failed");
      expect(progress.error.code).toBe("PRODUCTION_LIST_QUALITY_GATE_FAILED");
      expect(progress.error.message).toContain("生产列表草稿质量门失败");
      expect(progress.quality.blockingIssueCount).toBeGreaterThan(0);
    } finally {
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements blocks multi-voice metadata drafts collapsed to Narrator/Zephyr", async () => {
    await pasteDocument([
      "### 1. 世家大族/门阀子弟/年轻名士",
      "**声线**：男青年到中青年，带天然优越感与轻慢感，语速从容",
      "- 卖猪屠夫位列三公，简直令天下士人耻笑。",
      "### 2. 士族女眷",
      "**声线**：年轻女性，聪慧活泼的贵族女性，少女感",
      "- 真定玉梨，大如拳，甘如蜜，脆如菱。",
    ].join("\n"));
    mockOpenCodeAvailable();
    _setSpawnRunner(async (_file, args) => {
      const normalizeRequestPath = extractNormalizeRequestPathFromArgs(args);
      const bundle = JSON.parse(fs.readFileSync(normalizeRequestPath, "utf-8"));
      const candidatesArtifact = JSON.parse(fs.readFileSync(bundle.candidateLines.path, "utf-8"));
      const candidates = candidatesArtifact.candidateLines;
      fs.writeFileSync(extractDraftPathFromArgs(args), JSON.stringify({
        schemaVersion: "tts.production-list.v2",
        promptProfiles: [{
          id: "profile_narrator_collapse",
          name: "Collapsed narrator profile",
          audioProfile: "Clear narrator voice with warm tone.",
          scene: "Incorrectly collapsed multi-role NPC requirements.",
          directorNotes: "Calm narration that ignores role differences.",
          sampleContext: "All lines incorrectly bound to one narrator.",
          speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
          reusePolicy: "many-lines",
        }],
        lines: candidates.map((candidate: any, index: number) => ({
          id: candidate.id,
          order: index,
          speaker: "narrator",
          speakerLabel: "Narrator",
          transcript: candidate.transcript,
          promptProfileId: "profile_narrator_collapse",
          voice: "Zephyr",
        })),
      }));
      return { stdout: JSON.stringify({ type: "text", part: { text: "Collapsed draft written." } }), stderr: "" };
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(422);
      const body = await jsonRes(normRes);
      expect(body.error.code).toBe("PRODUCTION_LIST_QUALITY_GATE_FAILED");
      expect(body.error.message).toContain("生产列表草稿质量门失败");
      expect(body.error.message).toContain("未触发 TTS 音频生成");
      expect(body.qualityReport.issues.map((issue: any) => issue.code)).toContain("ROLE_VOICE_COLLAPSE");
      await expectProductionListUnchanged(0);
    } finally {
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements async mode returns runId and exposes running and completed progress", async () => {
    await pasteDocument("Narrator: 异步进度台词");
    mockOpenCodeAvailable();
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      _setSpawnRunner(async (_file, args) => {
        resolve();
        await new Promise<void>((release) => { releaseRunner = release; });
        writeValidV2Draft(extractDraftPathFromArgs(args), "异步进度台词。");
        return { stdout: JSON.stringify({ type: "text", part: { text: "Async draft written." } }), stderr: "" };
      });
    });

    try {
      const startRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ async: true, expectedVersion: 0, instruction: "保持原句" }),
      });
      expect(startRes.status).toBe(202);
      const startBody = await jsonRes(startRes);
      expect(startBody.runId).toBeTruthy();
      expect(startBody.progressUrl).toContain(startBody.runId);

      await runnerStarted;
      const runningRes = await req(app, startBody.progressUrl);
      expect(runningRes.status).toBe(200);
      const runningProgress = await jsonRes(runningRes);
      expect(runningProgress.stage).toBe("opencode_running");
      expect(runningProgress.runner.status).toBe("running");
      expect(runningProgress.timeoutMs).toBe(startBody.timeoutMs);

      releaseRunner();
      const completedProgress = await waitForNormalizeProgress(startBody.runId, "completed");
      expect(completedProgress.result.lineCount).toBe(1);
      expect(completedProgress.quality.passed).toBe(true);
    } finally {
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements async mode rejects concurrent active run with existing run metadata", async () => {
    await pasteDocument("Narrator: 并发防重入台词");
    mockOpenCodeAvailable();
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      _setSpawnRunner(async (_file, args) => {
        resolve();
        await new Promise<void>((release) => { releaseRunner = release; });
        writeValidV2Draft(extractDraftPathFromArgs(args), "并发防重入台词。");
        return { stdout: JSON.stringify({ type: "text", part: { text: "Concurrent draft written." } }), stderr: "" };
      });
    });

    try {
      const firstRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseMode: "async", expectedVersion: 0 }),
      });
      expect(firstRes.status).toBe(202);
      const firstBody = await jsonRes(firstRes);
      await runnerStarted;

      const secondRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseMode: "async", expectedVersion: 0 }),
      });
      expect(secondRes.status).toBe(409);
      const secondBody = await jsonRes(secondRes);
      expect(secondBody.error.code).toBe("NORMALIZE_RUN_ALREADY_RUNNING");
      expect(secondBody.existingRunId).toBe(firstBody.runId);
      expect(secondBody.progressUrl).toBe(firstBody.progressUrl);
      expect(secondBody.error.metadata.existingRunId).toBe(firstBody.runId);

      releaseRunner();
      const completedProgress = await waitForNormalizeProgress(firstBody.runId, "completed");
      expect(completedProgress.result.lineCount).toBe(1);
    } finally {
      if (releaseRunner) releaseRunner();
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements sync wait expiry returns 202 while OpenCode is still running", async () => {
    await pasteDocument("Narrator: 同步等待窗口到期但进程仍运行");
    mockOpenCodeAvailable();
    const originalHttpWait = process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS;
    process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS = "10";
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      _setSpawnRunner(async () => {
        resolve();
        await new Promise<void>((release) => { releaseRunner = release; });
        return { stdout: JSON.stringify({ type: "text", part: { text: "No draft written." } }), stderr: "" };
      });
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseMode: "sync", expectedVersion: 0 }),
      });
      expect(normRes.status).toBe(202);
      const body = await jsonRes(normRes);
      expect(body.ok).toBe(true);
      expect(body.status).toBe("accepted");
      expect(body.progressUrl).toContain(body.runId);
      expect(body.message).toContain("不会因本地等待窗口到期标记失败");

      await runnerStarted;
      const progressRes = await req(app, body.progressUrl);
      expect(progressRes.status).toBe(200);
      const progress = await jsonRes(progressRes);
      expect(progress.stage).toBe("opencode_running");
      expect(progress.runner.status).toBe("running");
      expect(progress.error).toBeUndefined();

      releaseRunner();
      await waitForNormalizeProgress(body.runId, "failed");
    } finally {
      if (releaseRunner) releaseRunner();
      if (originalHttpWait === undefined) delete process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS;
      else process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS = originalHttpWait;
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements fails only after OpenCode exits without a draft", async () => {
    await pasteDocument("Narrator: 进程退出后没有 draft 才失败");
    mockOpenCodeAvailable();
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      _setSpawnRunner(async () => {
        resolve();
        await new Promise<void>((release) => { releaseRunner = release; });
        return { stdout: JSON.stringify({ type: "text", part: { text: "Finished without draft." } }), stderr: "" };
      });
    });

    try {
      const startRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ async: true, expectedVersion: 0 }),
      });
      expect(startRes.status).toBe(202);
      const startBody = await jsonRes(startRes);
      await runnerStarted;

      const runningRes = await req(app, startBody.progressUrl);
      const running = await jsonRes(runningRes);
      expect(running.stage).toBe("opencode_running");
      expect(running.error).toBeUndefined();

      releaseRunner();
      const failedProgress = await waitForNormalizeProgress(startBody.runId, "failed");
      expect(failedProgress.error.code).toBe("NORMALIZE_DRAFT_MISSING");
      expect(failedProgress.runner.status).toBe("failed");
      await expectProductionListUnchanged(0);
    } finally {
      if (releaseRunner) releaseRunner();
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements completes when OpenCode writes a valid draft after sync wait expiry", async () => {
    await pasteDocument("Narrator: 等待窗口之后写出有效 draft");
    mockOpenCodeAvailable();
    const originalHttpWait = process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS;
    process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS = "10";
    _setSpawnRunner(async (_file, args) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeValidV2Draft(extractDraftPathFromArgs(args), "等待窗口之后写出的有效草稿。");
      return { stdout: JSON.stringify({ type: "text", part: { text: "Late draft written." } }), stderr: "" };
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseMode: "sync", expectedVersion: 0 }),
      });
      expect(normRes.status).toBe(202);
      const body = await jsonRes(normRes);
      expect(body.progressUrl).toContain(body.runId);

      const completedProgress = await waitForNormalizeProgress(body.runId, "completed");
      expect(completedProgress.result.lineCount).toBe(1);
      expect(completedProgress.quality.passed).toBe(true);
      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);
      expect(getBody.productionList.version).toBe(1);
      expect(getBody.productionList.lines[0].transcript).toBe("等待窗口之后写出的有效草稿。");
    } finally {
      if (originalHttpWait === undefined) delete process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS;
      else process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS = originalHttpWait;
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize progress keeps stale non-terminal progress running until OpenCode stops", async () => {
    const { runId, paths } = createNormalizeRun(taskId);
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const updatedAt = new Date(Date.now() - 120_000).toISOString();
    writeRunProgress(paths.progressPath, {
      ok: true,
      runId,
      taskId,
      stage: "opencode_running",
      startedAt,
      updatedAt,
      elapsedMs: 120_000,
      timeoutMs: 30_000,
      timeoutBasis: { mode: "quality-priority", selectedTimeoutMs: 30_000 },
      candidateLineCount: 1,
      draft: { exists: false, parseable: false, sizeBytes: 0 },
      quality: { checked: false },
      runner: { status: "running" },
      message: "OpenCode 正在生成 strict v2 生产列表",
    });

    const progressRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${runId}/progress`);
    expect(progressRes.status).toBe(200);
    const progress = await jsonRes(progressRes);
    expect(progress.stage).toBe("opencode_running");
    expect(progress.runner.status).toBe("running");
    expect(progress.error).toBeUndefined();
    expect(progress.completedAt).toBeUndefined();
    expect(progress.message).toContain("未确认 OpenCode 已停止");

    const persistedRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${runId}/progress`);
    const persisted = await jsonRes(persistedRes);
    expect(persisted.stage).toBe("opencode_running");
    expect(persisted.error).toBeUndefined();
  });

  it("normalize-requirements returns 400 for invalid request body schema", async () => {
    const invalidRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responseMode: "background" }),
    });
    expect(invalidRes.status).toBe(400);
    const body = await jsonRes(invalidRes);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.metadata.issues[0]).toMatchObject({ path: "responseMode" });
  });

  it("normalize-requirements async mode records failed progress when runner fails", async () => {
    await pasteDocument("Narrator: 异步失败台词");
    mockOpenCodeAvailable();
    const originalRecoveryWaitMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = "0";
    _setSpawnRunner(async () => {
      throw new Error("opencode run timed out after 60000ms");
    });

    try {
      const startRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ async: true }),
      });
      expect(startRes.status).toBe(202);
      const startBody = await jsonRes(startRes);
      const failedProgress = await waitForNormalizeProgress(startBody.runId, "failed");
      expect(failedProgress.error.code).toBe("OPENCODE_NORMALIZE_TIMEOUT");
      expect(failedProgress.runner.status).toBe("timeout");
      await expectProductionListUnchanged(0);
    } finally {
      if (originalRecoveryWaitMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = originalRecoveryWaitMs;
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements recovers valid v2 draft after OpenCode timeout", async () => {
    await pasteDocument("Narrator: timeout after draft path");
    mockOpenCodeAvailable();
    _setSpawnRunner(async (_file, args) => {
      writeValidV2Draft(extractDraftPathFromArgs(args), "超时前已经写好草稿。");
      throw new Error("opencode run timed out after 300000ms");
    });

    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(200);
    const body = await jsonRes(normRes);
    expect(body.ok).toBe(true);
    expect(body.runnerStatus.fallbackUsed).toBe(false);
    expect(body.warnings.map((w: any) => w.code)).toContain("OPENCODE_PROCESS_TIMEOUT_AFTER_DRAFT");
    expect(body.productionList.schemaVersion).toBe("tts.production-list.v2");
    expect(body.productionList.version).toBe(1);
    expect(body.productionList.promptProfiles).toHaveLength(1);
    expect(body.productionList.lines[0].promptProfileId).toBe("profile_agent_narrator");
    expect(body.productionList.metadata.recoveryCode).toBe("OPENCODE_PROCESS_TIMEOUT_AFTER_DRAFT");

    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.version).toBe(1);
    expect(getBody.productionList.schemaVersion).toBe("tts.production-list.v2");
    expect(getBody.productionList.promptProfiles).toHaveLength(1);
    expect(getBody.productionList.schemaVersion).not.toBe("1.0");
  });

  it("normalize-requirements waits briefly for a draft that appears right after timeout", async () => {
    await pasteDocument("Narrator: delayed timeout recovery path");
    mockOpenCodeAvailable();
    _setSpawnRunner(async (_file, args) => {
      const draftPath = extractDraftPathFromArgs(args);
      setTimeout(() => writeValidV2Draft(draftPath, "超时后短暂延迟才落盘的草稿。"), 100);
      throw new Error("opencode run timed out after 150000ms");
    });

    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(200);
    const body = await jsonRes(normRes);
    expect(body.ok).toBe(true);
    expect(body.warnings.map((w: any) => w.code)).toContain("OPENCODE_PROCESS_TIMEOUT_AFTER_DRAFT");
    expect(body.productionList.version).toBe(1);
    expect(body.productionList.lines[0].transcript).toBe("超时后短暂延迟才落盘的草稿。");
  });

  it("normalize-requirements passes route-computed timeout to bundle runner", async () => {
    const originalTimeout = process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    const originalMaxTimeout = process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "30000";
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;

    try {
      await createCurrentProductionListWithLineCount(192);
      await pasteDocument("Narrator: timeout option path");
      mockOpenCodeAvailable();
      let capturedTimeout: unknown;
      _setSpawnRunner(async (_file, args, options) => {
        capturedTimeout = options.timeout;
        writeValidV2Draft(extractDraftPathFromArgs(args), "实际超时配置已传入运行器。");
        return { stdout: JSON.stringify({ type: "text", part: { text: "Draft written." } }), stderr: "" };
      });

      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(200);
      const body = await jsonRes(normRes);
      expect(capturedTimeout).toBe(body.runnerStatus.timeoutMs);
      expect(capturedTimeout).toBe(900_000);
      expect(body.productionList.metadata.timeoutBasis.currentLineCount).toBe(192);
      expect(body.productionList.metadata.timeoutBasis.mode).toBe("quality-priority");
      expect(body.productionList.metadata.timeoutBasis.timeoutMs).toBe(900_000);
    } finally {
      if (originalTimeout === undefined) delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
      else process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = originalTimeout;
      if (originalMaxTimeout === undefined) delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
      else process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = originalMaxTimeout;
    }
  });

  it("normalize-requirements returns 504 on OpenCode timeout and leaves version unchanged", async () => {
    await pasteDocument("Narrator: timeout path");
    mockOpenCodeAvailable();
    const originalRecoveryWaitMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = "0";
    _setSpawnRunner(async () => {
      throw new Error("opencode run timed out after 300000ms");
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(504);
      const body = await jsonRes(normRes);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("OPENCODE_NORMALIZE_TIMEOUT");
      expect(body.runnerStatus.fallbackUsed).toBe(false);
      const progressRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${body.runId}/progress`);
      expect(progressRes.status).toBe(200);
      const progress = await jsonRes(progressRes);
      expect(progress.stage).toBe("failed");
      expect(progress.error.code).toBe("OPENCODE_NORMALIZE_TIMEOUT");
      expect(progress.timeoutMs).toBe(body.runnerStatus.timeoutMs);
      await expectProductionListUnchanged(0);
    } finally {
      if (originalRecoveryWaitMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = originalRecoveryWaitMs;
    }
  });

  it("normalize-requirements keeps timeout runs non-terminal while waiting for late draft recovery", async () => {
    await pasteDocument("Narrator: timeout recovery window path");
    mockOpenCodeAvailable();
    const originalRecoveryWaitMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
    const originalRecoveryWindowMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS;
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = "0";
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS = "5000";
    _setSpawnRunner(async (_file, args) => {
      const draftPath = extractDraftPathFromArgs(args);
      setTimeout(() => writeValidV2Draft(draftPath, "恢复窗口内落盘的迟到草稿。"), 80);
      throw new Error("opencode run timed out after 150000ms");
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(202);
      const body = await jsonRes(normRes);
      expect(body.ok).toBe(true);
      expect(body.stage).toBe("timeout_recovery");
      expect(body.progressUrl).toContain(body.runId);
      expect(body.timeoutBasis.lateDraftRecovery).toBe(true);
      expect(body.timeoutBasis.lateDraftRecoveryWindowMs).toBe(5000);
      await expectProductionListUnchanged(0);

      const pendingRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${body.runId}/progress`);
      expect(pendingRes.status).toBe(200);
      const pendingProgress = await jsonRes(pendingRes);
      expect(pendingProgress.stage).toBe("timeout_recovery");
      expect(pendingProgress.error).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 120));
      const completedRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${body.runId}/progress`);
      expect(completedRes.status).toBe(200);
      const completedProgress = await jsonRes(completedRes);
      expect(completedProgress.stage).toBe("completed");
      expect(completedProgress.error).toBeUndefined();

      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);
      expect(getBody.productionList.version).toBe(1);
      expect(getBody.productionList.lines[0].transcript).toBe("恢复窗口内落盘的迟到草稿。");
      expect(getBody.productionList.metadata.recoveryCode).toBe("OPENCODE_LATE_DRAFT_RECOVERY");
    } finally {
      if (originalRecoveryWaitMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = originalRecoveryWaitMs;
      if (originalRecoveryWindowMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS = originalRecoveryWindowMs;
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements finalizes timeout_recovery as failed when recovery window expires without draft", async () => {
    await pasteDocument("Narrator: expired timeout recovery path");
    mockOpenCodeAvailable();
    const originalRecoveryWaitMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
    const originalRecoveryWindowMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS;
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = "0";
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS = "1";
    _setSpawnRunner(async () => {
      throw new Error("opencode run timed out after 150000ms");
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(202);
      const body = await jsonRes(normRes);
      expect(body.stage).toBe("timeout_recovery");
      await expectProductionListUnchanged(0);

      await new Promise((resolve) => setTimeout(resolve, 20));
      const progressRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${body.runId}/progress`);
      expect(progressRes.status).toBe(200);
      const progress = await jsonRes(progressRes);
      expect(progress.stage).toBe("failed");
      expect(progress.runner.status).toBe("timeout");
      expect(progress.error.code).toBe("OPENCODE_NORMALIZE_TIMEOUT");
      expect(progress.message).toContain("no recoverable draft appeared");
      await expectProductionListUnchanged(0);
    } finally {
      if (originalRecoveryWaitMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = originalRecoveryWaitMs;
      if (originalRecoveryWindowMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS = originalRecoveryWindowMs;
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements recovers a late draft from the progress endpoint after timeout failure", async () => {
    await pasteDocument("Narrator: late progress recovery path");
    mockOpenCodeAvailable();
    const originalRecoveryWaitMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = "0";
    _setSpawnRunner(async (_file, args) => {
      const draftPath = extractDraftPathFromArgs(args);
      setTimeout(() => writeValidV2Draft(draftPath, "进度轮询恢复的迟到草稿。"), 80);
      throw new Error("opencode run timed out after 150000ms");
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(504);
      const body = await jsonRes(normRes);
      expect(body.error.code).toBe("OPENCODE_NORMALIZE_TIMEOUT");
      await expectProductionListUnchanged(0);

      await new Promise((resolve) => setTimeout(resolve, 120));
      const progressRes = await req(app, `/api/tasks/${taskId}/agent/normalize-runs/${body.runId}/progress`);
      expect(progressRes.status).toBe(200);
      const progress = await jsonRes(progressRes);
      expect(progress.stage).toBe("completed");
      expect(progress.error).toBeUndefined();
      expect(progress.result.lineCount).toBe(1);
      expect(progress.message).toBe("Normalize 完成，生产列表已更新");

      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);
      expect(getBody.productionList.version).toBe(1);
      expect(getBody.productionList.lines[0].transcript).toBe("进度轮询恢复的迟到草稿。");
      expect(getBody.productionList.metadata.recoveryCode).toBe("OPENCODE_LATE_DRAFT_RECOVERY");
    } finally {
      if (originalRecoveryWaitMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = originalRecoveryWaitMs;
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements recovers a late draft when listing normalize runs", async () => {
    await pasteDocument("Narrator: late runs endpoint recovery path");
    mockOpenCodeAvailable();
    const originalRecoveryWaitMs = process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
    process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = "0";
    _setSpawnRunner(async (_file, args) => {
      const draftPath = extractDraftPathFromArgs(args);
      setTimeout(() => writeValidV2Draft(draftPath, "运行列表恢复的迟到草稿。"), 80);
      throw new Error("opencode run timed out after 150000ms");
    });

    try {
      const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
      expect(normRes.status).toBe(504);
      const body = await jsonRes(normRes);
      await expectProductionListUnchanged(0);

      await new Promise((resolve) => setTimeout(resolve, 120));
      const runsRes = await req(app, `/api/tasks/${taskId}/agent/runs?kind=normalize`);
      expect(runsRes.status).toBe(200);
      const runsBody = await jsonRes(runsRes);
      const recoveredRun = runsBody.runs.find((run: any) => run.runId === body.runId);
      expect(recoveredRun.status).toBe("succeeded");
      expect(recoveredRun.error).toBeNull();

      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);
      expect(getBody.productionList.version).toBe(1);
      expect(getBody.productionList.lines[0].transcript).toBe("运行列表恢复的迟到草稿。");
      expect(getBody.productionList.metadata.recoveryCode).toBe("OPENCODE_LATE_DRAFT_RECOVERY");
    } finally {
      if (originalRecoveryWaitMs === undefined) delete process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS;
      else process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS = originalRecoveryWaitMs;
      _resetSpawnRunner();
      _resetExecRunner();
    }
  });

  it("normalize-requirements returns 422 for invalid JSON draft and does not create fallback v1", async () => {
    await pasteDocument("Narrator: invalid json draft path");
    mockOpenCodeAvailable();
    _setSpawnRunner(async (_file, args) => {
      const promptArg = args.find((arg) => typeof arg === "string" && arg.includes("Write the result to:")) ?? "";
      const draftPath = String(promptArg).match(/Write the result to: (.+)$/m)?.[1]?.trim();
      expect(draftPath).toBeTruthy();
      fs.writeFileSync(draftPath!, "not valid json {{{");
      return { stdout: JSON.stringify({ type: "text", part: { text: "Invalid draft written." } }), stderr: "" };
    });

    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(422);
    const body = await jsonRes(normRes);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NORMALIZE_DRAFT_UNREADABLE");
    expect(body.runnerStatus.fallbackUsed).toBe(false);
    await expectProductionListUnchanged(0);
  });

  it("normalize-requirements keeps parseable schema-invalid v2 as 422 with no fallback", async () => {
    await pasteDocument("Narrator: schema invalid draft path");
    mockOpenCodeAvailable();
    _setSpawnRunner(async (_file, args) => {
      const promptArg = args.find((arg) => typeof arg === "string" && arg.includes("Write the result to:")) ?? "";
      const draftPath = String(promptArg).match(/Write the result to: (.+)$/m)?.[1]?.trim();
      expect(draftPath).toBeTruthy();
      fs.writeFileSync(draftPath!, JSON.stringify({
        schemaVersion: "tts.production-list.v2",
        promptProfiles: [],
        lines: [],
        speakers: [],
      }));
      return { stdout: JSON.stringify({ type: "text", part: { text: "Schema-invalid draft written." } }), stderr: "" };
    });

    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(422);
    const body = await jsonRes(normRes);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("RAW_DRAFT_VALIDATION_FAILED");
    expect(body.error.metadata.validationReport.valid).toBe(false);
    await expectProductionListUnchanged(0);
  });

  it("normalize-requirements fails without enabled documents", async () => {
    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(400);
  });

  it("button execute shortens a line", async () => {
    // Setup: create production list directly. Button line transforms still keep fallback behavior.
    await createManualProductionList();
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const lineId = getBody.productionList.lines[0].id;

    // Execute shorten button
    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/shorten/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetLineId: lineId,
        expectedVersion: 1,
      }),
    });

    expect(execRes.status).toBe(200);
    const execBody = await jsonRes(execRes);
    expect(execBody.ok).toBe(true);
    expect(execBody.runner).toBe("fallback");
    expect(execBody.version).toBe(2);
    expect(execBody.targetLine.text.length).toBeLessThan(
      "This is a very long sentence that should be shortened by the button transform for testing purposes".length,
    );
  });

  it("button execute accepts target object and returns run detail, real diff, and cancel unavailable", async () => {
    await createManualProductionList();
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const lineId = getBody.productionList.lines[0].id;

    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/shorten/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { scope: "line", lineId },
        expectedVersion: 1,
      }),
    });
    expect(execRes.status).toBe(200);
    const execBody = await jsonRes(execRes);
    expect(execBody.runId).toBeTruthy();
    expect(execBody.beforeVersion).toBe(1);
    expect(execBody.version).toBe(2);

    const listRes = await req(app, `/api/tasks/${taskId}/agent/runs?kind=button`);
    expect(listRes.status).toBe(200);
    const listBody = await jsonRes(listRes);
    expect(listBody.runs.some((run: any) => run.runId === execBody.runId && run.diff.available === true)).toBe(true);

    const detailRes = await req(app, `/api/tasks/${taskId}/agent/runs/${execBody.runId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await jsonRes(detailRes);
    expect(detailBody.run.runId).toBe(execBody.runId);
    expect(detailBody.run.inputSnapshot.text).toContain("very long sentence");
    expect(detailBody.run.outputSnapshot.text.length).toBeLessThan(detailBody.run.inputSnapshot.text.length);

    const diffRes = await req(app, `/api/tasks/${taskId}/agent/runs/${execBody.runId}/diff`);
    expect(diffRes.status).toBe(200);
    const diffBody = await jsonRes(diffRes);
    expect(diffBody.diff.available).toBe(true);
    expect(diffBody.diff.summary.changedCount).toBe(1);
    expect(diffBody.diff.lineChanges[0].fields).toContain("text");

    const cancelRes = await req(app, `/api/tasks/${taskId}/agent/runs/${execBody.runId}`, { method: "DELETE" });
    expect(cancelRes.status).toBe(409);
    const cancelBody = await jsonRes(cancelRes);
    expect(cancelBody.error.code).toBe("RUN_CANCEL_UNAVAILABLE");
    expect(cancelBody.error.metadata.available).toBe(false);
  });

  it("button execute preserves historical DB rows, GET state, and version diff", async () => {
    await createManualProductionList();
    const db = getDb();
    const versionOne = db.select().from(productionListVersion)
      .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, 1)))
      .get();
    expect(versionOne).toBeTruthy();
    const versionOneRowsBefore = db.select().from(voiceLine)
      .where(eq(voiceLine.versionId, versionOne!.id))
      .all();
    expect(versionOneRowsBefore).toHaveLength(1);
    expect(versionOneRowsBefore[0].lineId ?? versionOneRowsBefore[0].id).toBe("l1");

    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/shorten/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { scope: "line", lineId: "l1" },
        expectedVersion: 1,
      }),
    });
    expect(execRes.status).toBe(200);

    const versionOneRowsAfter = db.select().from(voiceLine)
      .where(eq(voiceLine.versionId, versionOne!.id))
      .all();
    expect(versionOneRowsAfter).toHaveLength(1);
    expect(versionOneRowsAfter[0].id).toBe(versionOneRowsBefore[0].id);
    expect(versionOneRowsAfter[0].text).toBe(versionOneRowsBefore[0].text);

    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    expect(getRes.status).toBe(200);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.version).toBe(2);
    expect(getBody.productionList.lines[0].id).toBe("l1");
    expect(getBody.productionList.lines[0].text.length).toBeLessThan(versionOneRowsBefore[0].text.length);

    const diffRes = await req(app, `/api/tasks/${taskId}/production-list/versions/1/diff/2`);
    expect(diffRes.status).toBe(200);
    const diffBody = await jsonRes(diffRes);
    expect(diffBody.diff.summary.addedCount).toBe(0);
    expect(diffBody.diff.summary.removedCount).toBe(0);
    expect(diffBody.diff.summary.changedCount).toBe(1);
    expect(diffBody.diff.changed[0]).toMatchObject({ lineId: "l1" });
    expect(diffBody.diff.changed[0].fields).toContain("text");
  });

  it("button transform failure does not create a half production-list version", async () => {
    await createManualProductionList();
    const db = getDb();
    db.insert(agentButtonPreset).values({
      id: crypto.randomUUID(),
      buttonKey: "unknown-transform-test",
      name: "Unknown Transform Test",
      description: "For transaction failure regression coverage",
      promptTemplate: "Trigger deterministic fallback failure",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text"], scope: "line" }),
      sortOrder: 999,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/unknown-transform-test/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { scope: "line", lineId: "l1" },
        expectedVersion: 1,
      }),
    });
    expect(execRes.status).toBe(500);
    const execBody = await jsonRes(execRes);
    expect(execBody.error.code).toBe("TRANSFORM_ERROR");

    const versions = db.select().from(productionListVersion)
      .where(eq(productionListVersion.taskId, taskId))
      .all();
    expect(versions.map((version) => version.version)).toEqual([1]);

    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.version).toBe(1);
    expect(getBody.productionList.lines[0].id).toBe("l1");
  });

  it("button execute keeps legacy targetLineId compatibility", async () => {
    await createManualProductionList();
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const lineId = getBody.productionList.lines[0].id;

    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/rewrite/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetLineId: lineId,
        expectedVersion: 1,
        parameters: { instruction: "Make it concise" },
      }),
    });
    expect(execRes.status).toBe(200);
    const body = await jsonRes(execRes);
    expect(body.ok).toBe(true);
    expect(body.runId).toBeTruthy();
  });

  it("button execute returns structured unsupported for selection scope", async () => {
    await createManualProductionList();
    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/shorten/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { scope: "selection", lineIds: ["l1"] },
        expectedVersion: 1,
      }),
    });
    expect(execRes.status).toBe(501);
    const body = await jsonRes(execRes);
    expect(body.error.code).toBe("BUTTON_SCOPE_UNSUPPORTED");
    expect(body.error.metadata.supportedScopes).toEqual(["line"]);
  });

  it("button execute returns 409 on version conflict", async () => {
    // Setup: create production list directly; normalize no longer commits legacy fallback.
    await createManualProductionList();

    // Now try with wrong expectedVersion
    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/shorten/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetLineId: "any",
        expectedVersion: 999, // wrong version (current is 1)
      }),
    });
    expect(execRes.status).toBe(409);
    const body = await jsonRes(execRes);
    expect(body.error.code).toBe("VERSION_CONFLICT");
  });

  it("button execute returns 404 for unknown button", async () => {
    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/nonexistent/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetLineId: "any",
        expectedVersion: 0,
      }),
    });
    expect(execRes.status).toBe(404);
  });
});

describe("API Routes - Chat Sessions", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("creates chat session and returns real OpenCode output when available", async () => {
    let capturedArgs: string[] = [];
    let capturedOptions: Record<string, unknown> = {};
    _setExecRunner(async (_file, args) => {
      if (args[0] === "--version") return { stdout: "opencode 1.0.0", stderr: "" };
      if (args[0] === "providers" && args[1] === "list") return { stdout: "1 credentials", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    _setSpawnRunner(async (_file, args, options) => {
      capturedArgs = args;
      capturedOptions = options;
      return {
        stdout: JSON.stringify({ type: "text", part: { text: "真实执行输出" } }) + "\n",
        stderr: "",
      };
    });

    const createTaskRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Chat Task Scope" }),
    });
    expect(createTaskRes.status).toBe(201);
    const { task } = await jsonRes(createTaskRes);

    // Create session
    const createRes = await req(app, "/api/agent/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "chat", taskId: task.id, metadata: { pagePath: "/tasks", title: "Task overview" } }),
    });
    expect(createRes.status).toBe(201);
    const { session } = await jsonRes(createRes);
    expect(session.id).toBeTruthy();
    expect(session.status).toBe("active");
    expect(session.taskId).toBe(task.id);

    // Post message
    const msgRes = await req(app, `/api/agent/chat/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: "Hello agent" }),
    });
    expect(msgRes.status).toBe(200);
    const msgBody = await jsonRes(msgRes);
    expect(msgBody.messages.length).toBeGreaterThanOrEqual(2); // user + assistant

    const assistantMsg = msgBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
    expect(assistantMsg.content).toBe("真实执行输出");
    expect(assistantMsg.content).not.toContain("Full CLI integration is pending");
    expect(assistantMsg.metadata.runStatus ?? assistantMsg.metadata.status).toBe("succeeded");
    expect(msgBody.run.status).toBe("succeeded");
    expect(capturedArgs).toContain("--format");
    expect(capturedArgs).toContain("--dir");
    const expectedCwd = path.join(testState.tmpDir, "tasks", task.id);
    expect(capturedArgs).toContain(expectedCwd);
    expect(capturedArgs[capturedArgs.length - 1]).toContain("- pagePath: /tasks");
    expect(capturedArgs[capturedArgs.length - 1]).not.toContain("pagePath: unknown");
    expect(String(capturedOptions.cwd)).toBe(expectedCwd);
    expect((capturedOptions.env as Record<string, string | undefined>).OPENROUTER_API_KEY).toBeUndefined();
  });

  it("rejects invalid or non-existent chat taskId before creating sessions", async () => {
    const invalidTaskIds = [
      "",
      "   ",
      "../db",
      "tasks/other",
      "/tmp/other-task",
      "c0a8012e-1111-4111-8111-123456789abc/child",
      "c0a8012e-1111-4111-8111-123456789abc\\child",
    ];

    for (const taskId of invalidTaskIds) {
      const res = await req(app, "/api/agent/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionType: "chat", taskId }),
      });
      expect(res.status).toBe(400);
      const body = await jsonRes(res);
      expect(body.error.code).toBe("INVALID_TASK_ID");
    }

    for (const taskId of invalidTaskIds) {
      const res = await req(app, "/api/opencode/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionType: "automation", taskId }),
      });
      expect(res.status).toBe(400);
      const body = await jsonRes(res);
      expect(body.error.code).toBe("INVALID_TASK_ID");
    }

    const nullChatTaskRes = await req(app, "/api/agent/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "chat", taskId: null }),
    });
    expect(nullChatTaskRes.status).toBe(201);
    const nullChatTaskBody = await jsonRes(nullChatTaskRes);
    expect(nullChatTaskBody.session.taskId).toBeNull();

    const nullOpenCodeTaskRes = await req(app, "/api/opencode/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "automation", taskId: null }),
    });
    expect(nullOpenCodeTaskRes.status).toBe(201);
    const nullOpenCodeTaskBody = await jsonRes(nullOpenCodeTaskRes);
    expect(nullOpenCodeTaskBody.session.taskId).toBeNull();

    const missingTaskId = crypto.randomUUID();
    const missingRes = await req(app, "/api/agent/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "chat", taskId: missingTaskId }),
    });
    expect(missingRes.status).toBe(404);
    const missingBody = await jsonRes(missingRes);
    expect(missingBody.error.code).toBe("TASK_NOT_FOUND");
  });

  it("rejects historical chat sessions with empty taskId before sending messages", async () => {
    let spawned = false;
    _setSpawnRunner(async () => {
      spawned = true;
      return { stdout: "", stderr: "" };
    });

    const db = getDb();
    const now = new Date();
    for (const taskId of ["", "   "]) {
      const opencodeSessionId = crypto.randomUUID();
      const chatSessionId = crypto.randomUUID();
      db.insert(opencodeSession).values({
        id: opencodeSessionId,
        sessionType: "chat",
        status: "active",
        metadataJson: "{}",
        taskId,
        createdAt: now,
      }).run();
      db.insert(agentChatSession).values({
        id: chatSessionId,
        opencodeSessionId,
        taskId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }).run();

      const msgRes = await req(app, `/api/agent/chat/sessions/${chatSessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: "Hello agent" }),
      });
      expect(msgRes.status).toBe(400);
      const msgBody = await jsonRes(msgRes);
      expect(msgBody.error.code).toBe("INVALID_TASK_ID");
    }

    expect(spawned).toBe(false);
  });

  it("persists readable OpenCode failure without leaking secrets", async () => {
    _setExecRunner(async (_file, args) => {
      if (args[0] === "--version") return { stdout: "opencode 1.0.0", stderr: "" };
      if (args[0] === "providers" && args[1] === "list") return { stdout: "1 credentials", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    _setSpawnRunner(async () => {
      throw new Error("boom sk-1234567890 token=secret-token-value");
    });

    const createRes = await req(app, "/api/agent/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "chat" }),
    });
    const { session } = await jsonRes(createRes);
    const msgRes = await req(app, `/api/agent/chat/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: "Hello agent" }),
    });

    expect(msgRes.status).toBe(200);
    const msgBody = await jsonRes(msgRes);
    const assistantMsg = msgBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg.content).toContain("OpenCode execution failed");
    expect(assistantMsg.content).not.toContain("sk-1234567890");
    expect(assistantMsg.content).not.toContain("secret-token-value");
    expect(assistantMsg.content).not.toContain("Full CLI integration is pending");
    expect(msgBody.run.status).toBe("failed");
    expect(msgBody.run.error.code).toBe("OPENCODE_FAILED");
  });

  it("returns real unavailable reason when OpenCode cannot run", async () => {
    _setExecRunner(async () => {
      throw new Error("opencode missing sk-1234567890");
    });

    const createRes = await req(app, "/api/agent/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "chat" }),
    });
    const { session } = await jsonRes(createRes);
    const msgRes = await req(app, `/api/agent/chat/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: "Hello agent" }),
    });

    expect(msgRes.status).toBe(200);
    const msgBody = await jsonRes(msgRes);
    const assistantMsg = msgBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg.content).toContain("OpenCode is unavailable");
    expect(assistantMsg.content).not.toContain("sk-1234567890");
    expect(assistantMsg.content).not.toContain("Full CLI integration is pending");
    expect(msgBody.run.status).toBe("unavailable");
  });

  it("session isolation: automation sessions are separate from chat", async () => {
    // Create automation session via opencode endpoint
    const autoRes = await req(app, "/api/opencode/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "automation" }),
    });
    expect(autoRes.status).toBe(201);

    // Create chat session
    const chatRes = await req(app, "/api/agent/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "chat" }),
    });
    expect(chatRes.status).toBe(201);

    // List opencode sessions filtered by type
    const listAutoRes = await req(app, "/api/opencode/sessions?sessionType=automation");
    const listAuto = await jsonRes(listAutoRes);
    expect(listAuto.sessions.every((s: any) => s.sessionType === "automation")).toBe(true);

    const listChatRes = await req(app, "/api/opencode/sessions?sessionType=chat");
    const listChat = await jsonRes(listChatRes);
    expect(listChat.sessions.every((s: any) => s.sessionType === "chat")).toBe(true);
  });

  it("persists automation OpenCode session taskId and supports task-scoped refresh query", async () => {
    const createTaskRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Automation Session Task" }),
    });
    expect(createTaskRes.status).toBe(201);
    const { task } = await jsonRes(createTaskRes);

    const otherTaskRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Other Automation Session Task" }),
    });
    const { task: otherTask } = await jsonRes(otherTaskRes);

    const createRes = await req(app, "/api/opencode/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionType: "automation",
        taskId: task.id,
        metadata: { source: "right-panel" },
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await jsonRes(createRes);
    expect(createBody.session.taskId).toBe(task.id);

    await req(app, "/api/opencode/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "automation", taskId: otherTask.id }),
    });

    const refreshRes = await req(app, `/api/opencode/sessions?sessionType=automation&taskId=${task.id}`);
    expect(refreshRes.status).toBe(200);
    const refreshBody = await jsonRes(refreshRes);
    expect(refreshBody.sessions).toHaveLength(1);
    expect(refreshBody.sessions[0].id).toBe(createBody.session.id);
    expect(refreshBody.sessions[0].taskId).toBe(task.id);
    expect(refreshBody.sessions[0].metadata.source).toBe("right-panel");
  });

  it("returns 404 for non-existent session messages", async () => {
    const res = await req(app, "/api/agent/chat/sessions/nonexistent/messages");
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-existent session on message post", async () => {
    const res = await req(app, "/api/agent/chat/sessions/nonexistent/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: "test" }),
    });
    expect(res.status).toBe(404);
  });
});
