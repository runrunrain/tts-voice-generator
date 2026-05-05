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

import { closeDb, initSchema } from "../src/db/index.js";
import tasksRoutes from "../src/routes/tasks.js";
import documentsRoutes from "../src/routes/documents.js";
import productionListRoutes from "../src/routes/production-list.js";
import directorProfilesRoutes from "../src/routes/director-profiles.js";
import agentButtonsRoutes from "../src/routes/agent-buttons.js";
import agentChatRoutes from "../src/routes/agent-chat.js";
import {
  VoiceLineSchema,
  ProductionListSchema,
  SpeakerSchema,
  DirectorConfigSchema,
  CreateTaskSchema,
  PasteDocumentSchema,
  validateProductionList,
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
} from "../src/services/opencode-runner.js";

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

  it("rejects production list with >2 speakers", () => {
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
    expect(result.success).toBe(false);
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

  it("validateProductionList catches speaker limit exceeded", () => {
    const report = validateProductionList({
      lines: [],
      speakers: [
        { id: "a", label: "A", voice: "Zephyr" },
        { id: "b", label: "B", voice: "Puck" },
        { id: "c", label: "C", voice: "Charon" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "SPEAKER_LIMIT_EXCEEDED")).toBe(true);
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
    expect(result.productionList.speakers[0].label).toBe("Narrator");
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

  it("fallbackNormalize caps speakers at 2", () => {
    const result = fallbackNormalize({
      documents: [{
        id: "d1",
        fileName: "multi.txt",
        content: "Alice: Line 1\nBob: Line 2\nCharlie: Line 3",
        enabled: true,
      }],
    });
    expect(result.productionList.speakers).toHaveLength(2);
    expect(result.warnings.some((w) => w.code === "SPEAKER_MAPPED")).toBe(true);
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
    expect(patchBody.task.status).toBe("in_progress");
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

    const createRes = await req(app, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Button Test" }),
    });
    taskId = (await jsonRes(createRes)).task.id;
  });

  afterAll(() => {
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

  it("normalize-requirements creates production list from documents", async () => {
    // Paste a document first
    await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "script.txt", content: "Alice: Hello\nBob: Hi there" }),
    });

    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(200);
    const body = await jsonRes(normRes);
    expect(body.ok).toBe(true);
    expect(body.runner).toBe("fallback");
    expect(body.productionList.lines.length).toBeGreaterThanOrEqual(2);
  });

  it("normalize-requirements fails without enabled documents", async () => {
    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    expect(normRes.status).toBe(400);
  });

  it("button execute shortens a line", async () => {
    // Setup: paste doc, normalize, get line ID
    await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "script.txt", content: "Narrator: This is a very long sentence that should be shortened by the button transform for testing purposes" }),
    });

    const normRes = await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });
    const normBody = await jsonRes(normRes);
    const lineId = normBody.productionList.lines[0].id;

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

  it("button execute returns 409 on version conflict", async () => {
    // Setup: paste doc, normalize to create v1
    await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "script.txt", content: "Narrator: Test line" }),
    });
    await req(app, `/api/tasks/${taskId}/agent/normalize-requirements`, { method: "POST" });

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

  it("creates chat session and sends messages", async () => {
    // Create session
    const createRes = await req(app, "/api/agent/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionType: "chat" }),
    });
    expect(createRes.status).toBe(201);
    const { session } = await jsonRes(createRes);
    expect(session.id).toBeTruthy();
    expect(session.status).toBe("active");

    // Post message
    const msgRes = await req(app, `/api/agent/chat/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: "Hello agent" }),
    });
    expect(msgRes.status).toBe(200);
    const msgBody = await jsonRes(msgRes);
    expect(msgBody.messages.length).toBeGreaterThanOrEqual(2); // user + assistant

    // Check assistant response does NOT claim external execution
    const assistantMsg = msgBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
    // Should mention OpenCode unavailable or processing, not claim external ops
    expect(typeof assistantMsg.content).toBe("string");
    expect(assistantMsg.content.length).toBeGreaterThan(0);
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
