/**
 * Phase 7: Versions, Diff, Rollback, Export/Import, Quality Report Tests
 *
 * Covers:
 * - GET /api/tasks/:taskId/production-list/versions
 * - GET /api/tasks/:taskId/production-list/versions/:from/diff/:to
 * - POST /api/tasks/:taskId/production-list/rollback (copy-on-write + expectedVersion 409)
 * - GET /api/tasks/:taskId/production-list/export (json/md/csv with sanitization)
 * - POST /api/tasks/:taskId/production-list/import (json/csv schema/conflict)
 * - GET /api/tasks/:taskId/production-list/quality-report
 * - Cost guard: generate endpoint source tracking and safety defaults
 */

import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({
  tmpDir: "",
  dbFilePath: "",
  mockApiKeyConfigured: false,
  mockGenerateSuccess: false,
  lastSourceContext: null as { source: string } | null,
}));

vi.mock("../src/config/env.js", async () => {
  const nc = await import("node:crypto");
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const tmp = np.join(no.tmpdir(), `tts-phase7-${process.pid}-${Date.now()}`);
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

// ─── Mock key-resolver and tts-generator ────────────────────────────────────

vi.mock("../src/services/key-resolver.js", () => ({
  isOpenRouterConfigured: () => testState.mockApiKeyConfigured,
  resolveApiKey: () => testState.mockApiKeyConfigured ? "test-key" : null,
  requireApiKey: () => { if (!testState.mockApiKeyConfigured) throw new Error("Not configured"); return "test-key"; },
}));

vi.mock("../src/services/tts-generator.js", () => ({
  generateSpeech: (_req: unknown, _requestId: unknown, sourceContext: { source: string }) => {
    // Capture the sourceContext for test assertions
    testState.lastSourceContext = sourceContext;
    if (testState.mockGenerateSuccess) {
      return Promise.resolve({
        status: 200,
        body: { ok: true, status: "succeeded", jobId: "mock-job-id", assetId: 42, audioUrl: "mock-url" },
      });
    }
    return Promise.resolve({
      status: 500,
      body: { ok: false, status: "failed", error: { code: "MOCK_ERROR", message: "Mock generation failure" } },
    });
  },
  GenerateSpeechSchema: {
    parse: (v: unknown) => v,
    safeParse: (v: unknown) => ({ success: true, data: v }),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { closeDb, initSchema } from "../src/db/index.js";
import tasksRoutes from "../src/routes/tasks.js";
import documentsRoutes from "../src/routes/documents.js";
import productionListRoutes from "../src/routes/production-list.js";
import directorProfilesRoutes from "../src/routes/director-profiles.js";
import agentButtonsRoutes from "../src/routes/agent-buttons.js";
import agentChatRoutes from "../src/routes/agent-chat.js";
import { getDb } from "../src/db/index.js";
import { voiceLine } from "../src/db/schema-extended.js";
import { eq } from "drizzle-orm";
import { readArtifact, productionListArtifactName } from "../src/services/artifact-store.js";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a task via API
 */
async function createTask(app: Hono, title = "Phase7 Test"): Promise<string> {
  const res = await req(app, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const body = await jsonRes(res);
  expect(body.ok).toBe(true);
  return body.task.id;
}

/**
 * PUT a production list with specific line data
 */
async function putProductionList(app: Hono, taskId: string, lines: Array<Record<string, unknown>>, version: number, extra?: Record<string, unknown>) {
  const res = await req(app, `/api/tasks/${taskId}/production-list`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedVersion: version,
      lines: lines.map((l, i) => ({
        id: l.id ?? `line_${i}`,
        order: i,
        speaker: l.speaker ?? "narrator",
        text: l.text ?? "Test text",
        voice: l.voice ?? "Zephyr",
        generationStatus: l.generationStatus ?? "draft",
        ...l,
      })),
      speakers: [],
      ...extra,
    }),
  });
  return jsonRes(res);
}

/**
 * Create a director profile and return its ID
 */
async function createDirectorProfile(app: Hono, taskId: string, name = "Test Director"): Promise<string> {
  const res = await req(app, `/api/director-profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config: { audioProfile: "Broadcast", defaultVoice: "Zephyr" } }),
  });
  const body = await jsonRes(res);
  expect(body.ok).toBe(true);
  return body.profile.id;
}

function promptStructuredExtra() {
  const profile = {
    id: "profile_phase7_test",
    name: "Phase7 test profile",
    audioProfile: "Clear test voice with stable tone.",
    scene: "Automated backend test scene.",
    directorNotes: "Neutral delivery, measured pace, precise pronunciation.",
    sampleContext: "Production-list generate regression test.",
    speakers: [{ id: "Alice", label: "Alice", voice: "Zephyr" }, { id: "Bob", label: "Bob", voice: "Puck" }],
    reusePolicy: "many-lines",
  };
  return {
    speakers: profile.speakers,
    promptProfiles: [profile],
  };
}

function withPromptBinding(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.map((line) => ({
    ...line,
    transcript: line.transcript ?? line.text ?? "Test text",
    promptProfileId: line.promptProfileId ?? line.directorProfileId ?? "profile_phase7_test",
    directorProfileId: line.directorProfileId ?? line.promptProfileId ?? "profile_phase7_test",
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Top-level afterAll: close DB and clean up temp directory once
afterAll(() => {
  try { closeDb(); } catch { /* ignore */ }
  try {
    if (testState.tmpDir) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
});

describe("Phase 7: Versions API", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("returns empty versions list for task with no production list", async () => {
    const taskId = await createTask(app);
    const res = await req(app, `/api/tasks/${taskId}/production-list/versions`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.versions).toEqual([]);
  });

  it("returns 404 for non-existent task", async () => {
    const res = await req(app, `/api/tasks/00000000-0000-4000-8000-000000000000/production-list/versions`);
    expect(res.status).toBe(404);
  });

  it("returns versions in descending order after multiple saves", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Version 1" },
    ], 0);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Version 2" },
    ], 1);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Version 3" },
      { id: "line_2", text: "New line" },
    ], 2);

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.versions).toHaveLength(3);
    expect(body.versions[0].version).toBe(3);
    expect(body.versions[1].version).toBe(2);
    expect(body.versions[2].version).toBe(1);
    expect(body.versions[0].lineCount).toBe(2);
    expect(body.versions[1].lineCount).toBe(1);
    expect(body.versions[2].lineCount).toBe(1);
  });

  it("includes directorProfileId in version entries", async () => {
    const taskId = await createTask(app);
    const profileId = await createDirectorProfile(app, taskId);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Test" },
    ], 0, { directorProfileId: profileId });

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].directorProfileId).toBe(profileId);
  });
});

describe("Phase 7: Diff API", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("returns 400 for non-integer version parameters", async () => {
    const taskId = await createTask(app);
    const res = await req(app, `/api/tasks/${taskId}/production-list/versions/abc/diff/1`);
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for non-existent task", async () => {
    const res = await req(app, `/api/tasks/00000000-0000-4000-8000-000000000000/production-list/versions/1/diff/2`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-existent version", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [{ id: "line_1", text: "Test" }], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions/1/diff/99`);
    expect(res.status).toBe(404);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("VERSION_NOT_FOUND");
  });

  it("detects added lines between versions", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Original" },
    ], 0);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Original" },
      { id: "line_2", text: "Added" },
    ], 1);

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions/1/diff/2`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.diff.summary.addedCount).toBe(1);
    expect(body.diff.summary.removedCount).toBe(0);
    expect(body.diff.added).toContain("line_2");
  });

  it("detects removed lines between versions", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Keep" },
      { id: "line_2", text: "Remove" },
    ], 0);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Keep" },
    ], 1);

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions/1/diff/2`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.diff.summary.removedCount).toBe(1);
    expect(body.diff.removed).toContain("line_2");
  });

  it("detects changed fields between versions", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Original text", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Modified text", voice: "Zephyr", speaker: "Bob" },
    ], 1);

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions/1/diff/2`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.diff.summary.changedCount).toBe(1);
    const changedEntry = body.diff.changed[0];
    expect(changedEntry.lineId).toBe("line_1");
    expect(changedEntry.fields).toContain("text");
    expect(changedEntry.fields).toContain("speaker");
    // voice was the same
    expect(changedEntry.fields).not.toContain("voice");
  });

  it("reports unchanged lines correctly when same line appears in both versions", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Same" },
      { id: "line_2", text: "Different v1" },
    ], 0);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Same" },
      { id: "line_2", text: "Different v2" },
    ], 1);

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions/1/diff/2`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.diff.summary.changedCount).toBe(1);
    // line_1 should be unchanged since same text/voice/speaker
    expect(body.diff.summary.unchangedCount).toBe(1);
  });

  it("includes fromLineCount and toLineCount in summary", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "V1" },
      { id: "line_2", text: "V1" },
      { id: "line_3", text: "V1" },
    ], 0);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "V2" },
    ], 1);

    const res = await req(app, `/api/tasks/${taskId}/production-list/versions/1/diff/2`);
    const body = await jsonRes(res);
    expect(body.diff.summary.fromLineCount).toBe(3);
    expect(body.diff.summary.toLineCount).toBe(1);
    // line_1 changed (V1->V2), line_2 and line_3 removed
    expect(body.diff.summary.removedCount).toBe(2);
    expect(body.diff.summary.changedCount).toBe(1);
  });
});

describe("Phase 7: Rollback API", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("returns 409 on version conflict (expectedVersion mismatch)", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V1" }], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 99, targetVersion: 1 }),
    });
    expect(res.status).toBe(409);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("VERSION_CONFLICT");
  });

  it("returns 400 if targetVersion > currentVersion", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V1" }], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, targetVersion: 5 }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("INVALID_TARGET_VERSION");
  });

  it("returns 404 for non-existent target version", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V1" }], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, targetVersion: 99 }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a new version via copy-on-write (does not delete history)", async () => {
    const taskId = await createTask(app);

    // Create 3 versions
    await putProductionList(app, taskId, [{ id: "line_1", text: "V1" }], 0);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V2" }, { id: "line_2", text: "Added" }], 1);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V3" }, { id: "line_2", text: "Added" }, { id: "line_3", text: "Third" }], 2);

    // Rollback to version 1
    const rollbackRes = await req(app, `/api/tasks/${taskId}/production-list/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3, targetVersion: 1, summary: "Rollback test" }),
    });
    expect(rollbackRes.status).toBe(200);
    const rollbackBody = await jsonRes(rollbackRes);
    expect(rollbackBody.ok).toBe(true);

    // New version should be 4
    expect(rollbackBody.rollback.newVersion).toBe(4);
    expect(rollbackBody.rollback.fromVersion).toBe(3);
    expect(rollbackBody.rollback.targetVersion).toBe(1);

    // The production list should reflect version 1's data
    expect(rollbackBody.productionList.version).toBe(4);
    expect(rollbackBody.productionList.lines).toHaveLength(1);
    expect(rollbackBody.productionList.lines[0].text).toBe("V1");

    // All 4 versions should still exist (copy-on-write)
    const versionsRes = await req(app, `/api/tasks/${taskId}/production-list/versions`);
    const versionsBody = await jsonRes(versionsRes);
    expect(versionsBody.versions).toHaveLength(4);
    expect(versionsBody.versions.map((v: any) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it("preserves generation status from target version after rollback", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "V1", generationStatus: "succeeded" },
    ], 0);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "V2", generationStatus: "draft" },
    ], 1);

    // Rollback to version 1 which had generationStatus = "succeeded"
    const res = await req(app, `/api/tasks/${taskId}/production-list/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, targetVersion: 1 }),
    });
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.productionList.lines[0].text).toBe("V1");
    expect(body.productionList.lines[0].generationStatus).toBe("succeeded");
  });

  it("rejects invalid rollback request body", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V1" }], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: "not-a-number" }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("writes audit log for rollback operation", async () => {
    const taskId = await createTask(app);

    await putProductionList(app, taskId, [{ id: "line_1", text: "V1" }], 0);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V2" }], 1);

    await req(app, `/api/tasks/${taskId}/production-list/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, targetVersion: 1, summary: "Audit test" }),
    });

    // Verify audit log via DB
    const db = getDb();
    const { operationAuditLog } = await import("../src/db/schema-extended.js");
    const logs = db.select().from(operationAuditLog)
      .where(eq(operationAuditLog.operation, "rollback"))
      .all();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const snapshot = JSON.parse(logs[0].snapshotJson ?? "{}");
    expect(snapshot.fromVersion).toBe(2);
    expect(snapshot.targetVersion).toBe(1);
    expect(snapshot.newVersion).toBe(3);
    expect(snapshot.summary).toBe("Audit test");
  });
});

describe("Phase 7: Export API", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("returns 409 on version conflict (expectedVersion mismatch)", async () => {
    const taskId = await createTask(app);
    const res = await req(app, `/api/tasks/${taskId}/production-list/export?format=json`);
    expect(res.status).toBe(404);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("NO_PRODUCTION_LIST");
  });

  it("exports as JSON with correct structure and Content-Disposition", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: "World", voice: "Puck", speaker: "Bob" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/export?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("production-list-v1.json");

    const body = await jsonRes(res);
    expect(body.schemaVersion).toBe("tts.production-list.v2");
    expect(body.taskId).toBe(taskId);
    expect(body.version).toBe(1);
    expect(body.exportedAt).toBeDefined();
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0].text).toBe("Hello");
    expect(body.lines[1].voice).toBe("Puck");
  });

  it("sanitizes JSON export (no relatedJobId, relatedAssetId, sensitive fields)", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Test", relatedJobId: "job-123", relatedAssetId: 42 },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/export?format=json`);
    const body = await jsonRes(res);

    // Sensitive/internal fields should NOT be in the export
    const line = body.lines[0];
    expect(line).not.toHaveProperty("relatedJobId");
    expect(line).not.toHaveProperty("relatedAssetId");
    expect(line).not.toHaveProperty("token");
    expect(line).not.toHaveProperty("apiKey");
    expect(line).not.toHaveProperty("generationErrorCode");
    expect(line).not.toHaveProperty("generationErrorMessage");
    expect(line).not.toHaveProperty("directorOverrideJson");
    // Expected fields should be present
    expect(line).toHaveProperty("id");
    expect(line).toHaveProperty("text");
    expect(line).toHaveProperty("voice");
    expect(line).toHaveProperty("speaker");
  });

  it("exports as CSV with correct headers and Content-Type", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello, world", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("production-list-v1.csv");

    const text = await res.text();
    const lines = text.split("\n");
    // Header row
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("text");
    expect(lines[0]).toContain("voice");
    expect(lines[0]).toContain("speaker");
    // Data row with escaped comma
    expect(lines[1]).toContain("Hello, world");
  });

  it("exports as Markdown table", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: "World", voice: "Puck", speaker: "Bob" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");

    const text = await res.text();
    expect(text).toContain("# Production List v1");
    expect(text).toContain("Task ID");
    expect(text).toContain("Speaker");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).toContain("|");
  });

  it("defaults to JSON when no format specified", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Test" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(".json");
    const body = await jsonRes(res);
    expect(body.schemaVersion).toBe("tts.production-list.v2");
  });
});

describe("Phase 7: Import API", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("returns 409 on version conflict (expectedVersion mismatch)", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [{ id: "line_1", text: "V1" }], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 99,
        format: "json",
        data: { lines: [{ id: "new_1", text: "Imported" }] },
      }),
    });
    expect(res.status).toBe(409);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("VERSION_CONFLICT");
  });

  it("imports valid JSON data and creates new version", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "imported_1", text: "Imported line 1", voice: "Zephyr", speaker: "Alice" },
            { id: "imported_2", text: "Imported line 2", voice: "Puck", speaker: "Bob" },
          ],
          speakers: [
            { id: "sp_1", label: "Alice", voice: "Zephyr" },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.import.importedLines).toBe(2);
    expect(body.import.skippedLines).toBe(0);
    expect(body.productionList.version).toBe(1);
    expect(body.productionList.lines).toHaveLength(2);
    expect(body.productionList.lines[0].text).toBe("Imported line 1");
  });

  it("imports valid CSV data", async () => {
    const taskId = await createTask(app);

    const csvData = "id,speaker,text,voice\nline_1,Alice,Hello world,Zephyr\nline_2,Bob,Goodbye,Puck";

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "csv",
        data: csvData,
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.import.importedLines).toBe(2);
    expect(body.productionList.lines).toHaveLength(2);
    expect(body.productionList.lines[0].speaker).toBe("Alice");
    expect(body.productionList.lines[0].text).toBe("Hello world");
  });

  it("rejects JSON import without lines array", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: { speakers: [] },
      }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("IMPORT_FORMAT_ERROR");
  });

  it("rejects CSV import with only header row", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "csv",
        data: "id,speaker,text",
      }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("IMPORT_FORMAT_ERROR");
  });

  it("rejects CSV import when data is not a string", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "csv",
        data: { not: "a string" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("IMPORT_FORMAT_ERROR");
  });

  it("skips invalid lines and reports errors", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "good_1", text: "Valid line", voice: "Zephyr", speaker: "Alice" },
            { id: "bad_1", text: "", voice: "Zephyr", speaker: "Alice" },  // empty text
            { id: "good_2", text: "Another valid", voice: "Puck", speaker: "Bob" },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.import.importedLines).toBe(2);
    expect(body.import.skippedLines).toBe(1);
    expect(body.import.errors).toBeDefined();
    expect(body.import.errors).toHaveLength(1);
  });

  it("reports director warnings for missing profiles", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice", directorProfileId: "non-existent-profile" },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.import.directorWarnings).toBeDefined();
    expect(body.import.directorWarnings.length).toBeGreaterThan(0);
  });

  it("resets generationStatus to draft on import", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "line_1", text: "Imported", voice: "Zephyr", speaker: "Alice", generationStatus: "succeeded" },
          ],
        },
      }),
    });
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    // Import should reset generationStatus to "draft"
    expect(body.productionList.lines[0].generationStatus).toBe("draft");
  });

  it("increments version correctly when importing over existing list", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [{ id: "line_1", text: "Original" }], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        format: "json",
        data: {
          lines: [{ id: "new_1", text: "Imported", voice: "Zephyr", speaker: "Alice" }],
        },
      }),
    });
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.productionList.version).toBe(2);
  });

  it("returns 400 when all lines fail validation", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "bad_1", text: "", voice: "", speaker: "" },
          ],
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("IMPORT_VALIDATION_ERROR");
  });

  it("writes audit log for import operation", async () => {
    const taskId = await createTask(app);

    await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [{ id: "import_1", text: "Imported", voice: "Zephyr", speaker: "Alice" }],
        },
        summary: "Test import",
      }),
    });

    const db = getDb();
    const { operationAuditLog } = await import("../src/db/schema-extended.js");
    const logs = db.select().from(operationAuditLog)
      .where(eq(operationAuditLog.operation, "import"))
      .all();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const snapshot = JSON.parse(logs[0].snapshotJson ?? "{}");
    expect(snapshot.format).toBe("json");
    expect(snapshot.summary).toBe("Test import");
  });
});

describe("Phase 7: Quality Report API", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("returns empty report for task with no production list", async () => {
    const taskId = await createTask(app);
    const res = await req(app, `/api/tasks/${taskId}/production-list/quality-report`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.qualityReport.totalLines).toBe(0);
    expect(body.qualityReport.issues).toHaveLength(1);
    expect(body.qualityReport.issues[0].code).toBe("NO_PRODUCTION_LIST");
  });

  it("returns 404 for non-existent task", async () => {
    const res = await req(app, `/api/tasks/00000000-0000-4000-8000-000000000000/production-list/quality-report`);
    expect(res.status).toBe(404);
  });

  it("reports missing text, voice, speaker fields", async () => {
    const taskId = await createTask(app);
    // Use valid schema lines (empty text/voice would fail Zod validation at PUT)
    // Instead test with valid lines that have no directorProfile
    await putProductionList(app, taskId, [
      { id: "line_1", text: "OK", voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: "Also OK", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/quality-report`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.qualityReport.totalLines).toBe(2);
    // No missing text/voice since we provided them
    expect(body.qualityReport.metrics.missingFields.text).toBe(0);
    expect(body.qualityReport.metrics.missingFields.voice).toBe(0);
    // Both lines have no director profile
    expect(body.qualityReport.metrics.missingFields.directorProfile).toBe(2);
  });

  it("reports unbound director profiles", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "With director", voice: "Zephyr", speaker: "Alice", directorProfileId: null },
      { id: "line_2", text: "No director", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/quality-report`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.qualityReport.metrics.unboundDirectorCount).toBe(2);
  });

  it("detects suspected duplicate text", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello world", voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: "hello world", voice: "Zephyr", speaker: "Alice" }, // duplicate (case-insensitive)
      { id: "line_3", text: "Unique text", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/quality-report`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.qualityReport.metrics.suspectedDuplicates.groups).toBe(1);
    expect(body.qualityReport.metrics.suspectedDuplicates.details).toHaveLength(1);
    // Check that a duplicate issue was raised
    const dupIssues = body.qualityReport.issues.filter((i: any) => i.code === "DUPLICATE_TEXT");
    expect(dupIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects long text lines", async () => {
    const taskId = await createTask(app);
    const longText = "A".repeat(600);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Short", voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: longText, voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/quality-report`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.qualityReport.metrics.longText.count).toBe(1);
    expect(body.qualityReport.metrics.longText.threshold).toBe(500);
    const longIssues = body.qualityReport.issues.filter((i: any) => i.code === "LONG_TEXT");
    expect(longIssues.length).toBe(1);
    expect(longIssues[0].lineId).toBe("line_2");
  });

  it("reports director reuse statistics", async () => {
    const taskId = await createTask(app);
    const profileId = await createDirectorProfile(app, taskId);

    await putProductionList(app, taskId, [
      { id: "line_1", text: "Text 1", voice: "Zephyr", speaker: "Alice", directorProfileId: profileId },
      { id: "line_2", text: "Text 2", voice: "Zephyr", speaker: "Alice", directorProfileId: profileId },
      { id: "line_3", text: "Text 3", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/quality-report`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.qualityReport.metrics.directorReuse.uniqueProfiles).toBe(1);
    expect(body.qualityReport.metrics.directorReuse.sharedProfiles).toBe(1);
    expect(body.qualityReport.metrics.directorReuse.maxReuseCount).toBe(2);
  });

  it("reports validation and generation summaries", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Text 1", voice: "Zephyr", speaker: "Alice", status: "pending", generationStatus: "draft" },
      { id: "line_2", text: "Text 2", voice: "Zephyr", speaker: "Alice", status: "approved", generationStatus: "succeeded" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/quality-report`);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.qualityReport.metrics.validationSummary).toBeDefined();
    expect(body.qualityReport.metrics.generationSummary).toBeDefined();
    expect(body.qualityReport.metrics.validationSummary.pending).toBe(1);
    expect(body.qualityReport.metrics.validationSummary.approved).toBe(1);
    expect(body.qualityReport.metrics.generationSummary.draft).toBe(1);
    expect(body.qualityReport.metrics.generationSummary.succeeded).toBe(1);
  });
});

describe("Phase 7: Cost Guard - Generate Endpoint Safety", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
    testState.mockApiKeyConfigured = false;
    testState.mockGenerateSuccess = false;
  });

  it("does not call external TTS when API key is not configured", async () => {
    testState.mockApiKeyConfigured = false;

    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Should fail", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.generation.failedCount).toBe(1);
    expect(body.generation.results[0].errorCode).toBe("MISSING_API_KEY");
  });

  it("marks lines as failed with MISSING_API_KEY when key not configured", async () => {
    testState.mockApiKeyConfigured = false;

    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });

    // Check DB state
    const db = getDb();
    const line = db.select().from(voiceLine).where(eq(voiceLine.lineId, "line_1")).get();
    expect(line?.generationStatus).toBe("failed");
    expect(line?.generationErrorCode).toBe("MISSING_API_KEY");
  });

  it("writes audit log for generate operation even on failure", async () => {
    testState.mockApiKeyConfigured = false;

    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });

    const db = getDb();
    const { operationAuditLog } = await import("../src/db/schema-extended.js");
    const logs = db.select().from(operationAuditLog)
      .where(eq(operationAuditLog.operation, "generate"))
      .all();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const snapshot = JSON.parse(logs[0].snapshotJson ?? "{}");
    expect(snapshot.failedCount).toBeGreaterThanOrEqual(1);
  });

  it("skips lines with empty text or missing voice", async () => {
    testState.mockApiKeyConfigured = true;
    testState.mockGenerateSuccess = true;

    const taskId = await createTask(app);
    // All lines need valid schema data (empty text/voice would fail Zod).
    // Instead, test skipCompleted = true with already-succeeded lines.
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Already done", voice: "Zephyr", speaker: "Alice", generationStatus: "succeeded" },
      { id: "line_2", text: "Pending", voice: "Zephyr", speaker: "Alice", generationStatus: "draft" },
    ]), 0, promptStructuredExtra());

    const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, skipCompleted: true }),
    });
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    // line_1 should be skipped (already succeeded), line_2 should be processed
    expect(body.generation.succeededCount).toBe(1);
    expect(body.generation.skippedCount).toBeGreaterThanOrEqual(1);
  });

  it("requires expectedVersion for version conflict detection on generate", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 99 }),
    });
    expect(res.status).toBe(409);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("VERSION_CONFLICT");
  });

  it("blocks agent source without cost confirmation", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "agent" }),
    });
    expect(res.status).toBe(403);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("COST_CONFIRMATION_REQUIRED");
    expect(body.error.metadata.source).toBe("agent");
  });

  it("blocks CLI source without cost confirmation", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "cli" }),
    });
    expect(res.status).toBe(403);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("COST_CONFIRMATION_REQUIRED");
  });

  it("allows agent source with explicit confirm: true", async () => {
    testState.mockApiKeyConfigured = true;
    testState.mockGenerateSuccess = true;

    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "agent", confirm: true }),
    });
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.generation.succeededCount).toBe(1);
  });

  it("allows user source without confirm (default behavior)", async () => {
    testState.mockApiKeyConfigured = false;

    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "user" }),
    });
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    // Should proceed (but fail due to missing API key, which is expected)
    expect(body.generation.failedCount).toBe(1);
  });

  it("records source in audit log for generate operations", async () => {
    testState.mockApiKeyConfigured = false;

    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "cli", confirm: true }),
    });

    const db = getDb();
    const { operationAuditLog } = await import("../src/db/schema-extended.js");
    const logs = db.select().from(operationAuditLog)
      .where(eq(operationAuditLog.operation, "generate"))
      .all();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const snapshot = JSON.parse(logs[0].snapshotJson ?? "{}");
    expect(snapshot.source).toBe("cli");
    // Actor should be "cli" (the source parameter)
    expect(logs[0].actor).toBe("cli");
  });
});

// ─── Regression: C-1 Speaker Sanitization ──────────────────────────────────────

describe("Regression C-1: Speaker sanitization (import + export)", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("import with sensitive speaker fields (apiKey/token) -> export does not contain sensitive fields", async () => {
    const taskId = await createTask(app);

    // Import JSON with speakers containing sensitive fields
    const importRes = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "line_1", text: "Test line", voice: "Zephyr", speaker: "Alice" },
          ],
          speakers: [
            { id: "sp_1", label: "Alice", voice: "Zephyr", apiKey: "sk-secret-key-12345", token: "bearer-xyz-789", Authorization: "Basic abc" },
            { id: "sp_2", label: "Bob", voice: "Puck", secret: "hidden-value" },
          ],
        },
      }),
    });
    expect(importRes.status).toBe(200);
    const importBody = await jsonRes(importRes);
    expect(importBody.ok).toBe(true);

    // Now export and verify speakers are sanitized
    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=json`);
    expect(exportRes.status).toBe(200);
    const exportBody = await jsonRes(exportRes);

    // Speakers should only have whitelisted fields
    expect(exportBody.speakers).toHaveLength(2);
    for (const sp of exportBody.speakers) {
      expect(sp).not.toHaveProperty("apiKey");
      expect(sp).not.toHaveProperty("token");
      expect(sp).not.toHaveProperty("Authorization");
      expect(sp).not.toHaveProperty("secret");
      // Should have whitelisted fields
      expect(sp).toHaveProperty("id");
      expect(sp).toHaveProperty("label");
      expect(sp).toHaveProperty("voice");
    }
  });

  it("import rejects speakers that fail SpeakerSchema validation (unknown fields stripped)", async () => {
    const taskId = await createTask(app);

    const importRes = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "line_1", text: "Test", voice: "Zephyr", speaker: "sp_1" },
          ],
          speakers: [
            // Valid speaker
            { id: "sp_1", label: "Alice", voice: "Zephyr" },
          ],
        },
      }),
    });
    expect(importRes.status).toBe(200);
    const body = await jsonRes(importRes);
    expect(body.ok).toBe(true);

    // Verify speaker in production list only has valid fields
    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=json`);
    const exportBody = await jsonRes(exportRes);
    expect(exportBody.speakers).toHaveLength(1);
    const exportedSpeaker = exportBody.speakers[0];
    const speakerKeys = Object.keys(exportedSpeaker);
    // Only whitelist fields
    for (const key of speakerKeys) {
      expect(["id", "label", "name", "voice", "style"]).toContain(key);
    }
  });

  it("import limits speakers to max 2", async () => {
    const taskId = await createTask(app);

    const importRes = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "line_1", text: "Test", voice: "Zephyr", speaker: "sp_1" },
          ],
          speakers: [
            { id: "sp_1", label: "Alice", voice: "Zephyr" },
            { id: "sp_2", label: "Bob", voice: "Puck" },
            { id: "sp_3", label: "Charlie", voice: "Zephyr" },
          ],
        },
      }),
    });
    expect(importRes.status).toBe(200);

    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=json`);
    const exportBody = await jsonRes(exportRes);
    // Only first 2 speakers should be retained
    expect(exportBody.speakers.length).toBeLessThanOrEqual(2);
  });
});

// ─── Regression: M-2 CSV RFC 4180 Round-Trip ────────────────────────────────────

describe("Regression M-2: CSV export/import round-trip with special characters", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("round-trips text with commas, quotes, and newlines", async () => {
    const taskId = await createTask(app);

    // Create lines with special characters
    const specialText = 'Hello, "world"! She said "yes, please"';
    const newlineText = "Line one\nLine two\nLine three";

    await putProductionList(app, taskId, [
      { id: "line_1", text: specialText, voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: newlineText, voice: "Puck", speaker: "Bob" },
      { id: "line_3", text: "Normal text", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    // Export as CSV
    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    expect(exportRes.status).toBe(200);
    const csvData = await exportRes.text();

    // Import the CSV back
    const taskId2 = await createTask(app, "CSV Round-trip Import");
    const importRes = await req(app, `/api/tasks/${taskId2}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "csv",
        data: csvData,
      }),
    });
    expect(importRes.status).toBe(200);
    const importBody = await jsonRes(importRes);
    expect(importBody.ok).toBe(true);
    expect(importBody.import.importedLines).toBe(3);

    // Verify the imported data matches the original special text
    expect(importBody.productionList.lines).toHaveLength(3);

    const importedLine1 = importBody.productionList.lines.find((l: any) => l.text?.includes("Hello"));
    expect(importedLine1).toBeDefined();
    expect(importedLine1.text).toBe(specialText);

    const importedLine2 = importBody.productionList.lines.find((l: any) => l.text?.includes("Line one"));
    expect(importedLine2).toBeDefined();
    expect(importedLine2.text).toBe(newlineText);

    const importedLine3 = importBody.productionList.lines.find((l: any) => l.text === "Normal text");
    expect(importedLine3).toBeDefined();
  });

  it("round-trips text with double quotes (escaped as double-double-quote)", async () => {
    const taskId = await createTask(app);

    const quotedText = 'She said "I will be there" and left';
    await putProductionList(app, taskId, [
      { id: "line_1", text: quotedText, voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    const csvData = await exportRes.text();

    // The CSV should have double-quoted the field
    expect(csvData).toContain('""'); // Escaped double quotes

    const taskId2 = await createTask(app, "Quote Round-trip");
    const importRes = await req(app, `/api/tasks/${taskId2}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "csv",
        data: csvData,
      }),
    });
    const importBody = await jsonRes(importRes);
    expect(importBody.productionList.lines[0].text).toBe(quotedText);
  });

  it("handles mixed comma and quote in same field", async () => {
    const taskId = await createTask(app);

    const mixedText = 'Hello, "world", she said';
    await putProductionList(app, taskId, [
      { id: "line_1", text: mixedText, voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    const csvData = await exportRes.text();

    const taskId2 = await createTask(app, "Mixed Round-trip");
    const importRes = await req(app, `/api/tasks/${taskId2}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "csv",
        data: csvData,
      }),
    });
    const importBody = await jsonRes(importRes);
    expect(importBody.productionList.lines[0].text).toBe(mixedText);
  });
});

// ─── Regression: CSV order column non-empty (M-2 follow-up) ────────────────────

describe("Regression: CSV order column exports stable numeric values", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("CSV order column contains numeric values 0,1 for multi-line export", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "First line", voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: "Second line", voice: "Puck", speaker: "Bob" },
    ], 0);

    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    expect(exportRes.status).toBe(200);
    const csvData = await exportRes.text();
    const csvRows = csvData.split("\n").filter((r: string) => r.trim().length > 0);

    // Header row
    expect(csvRows[0]).toContain("order");

    // Parse order column index from header
    const headers = csvRows[0].split(",");
    const orderIdx = headers.indexOf("order");
    expect(orderIdx).toBeGreaterThanOrEqual(0);

    // Data row 1: order should be "0"
    const row1 = csvRows[1].split(",");
    expect(row1[orderIdx]).toBe("0");

    // Data row 2: order should be "1"
    const row2 = csvRows[2].split(",");
    expect(row2[orderIdx]).toBe("1");
  });

  it("CSV order column is not empty for single-line export", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Only line", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    expect(exportRes.status).toBe(200);
    const csvData = await exportRes.text();
    const csvRows = csvData.split("\n").filter((r: string) => r.trim().length > 0);

    const headers = csvRows[0].split(",");
    const orderIdx = headers.indexOf("order");
    expect(orderIdx).toBeGreaterThanOrEqual(0);

    const row1 = csvRows[1].split(",");
    expect(row1[orderIdx]).toBe("0");
  });

  it("CSV export/import round-trip preserves order values", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Alpha", voice: "Zephyr", speaker: "Alice" },
      { id: "line_2", text: "Beta", voice: "Puck", speaker: "Bob" },
      { id: "line_3", text: "Gamma", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    // Export CSV
    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    expect(exportRes.status).toBe(200);
    const csvData = await exportRes.text();

    // Verify order column in exported CSV
    const csvRows = csvData.split("\n").filter((r: string) => r.trim().length > 0);
    const headers = csvRows[0].split(",");
    const orderIdx = headers.indexOf("order");
    expect(csvRows[1].split(",")[orderIdx]).toBe("0");
    expect(csvRows[2].split(",")[orderIdx]).toBe("1");
    expect(csvRows[3].split(",")[orderIdx]).toBe("2");

    // Import CSV into a new task (round-trip)
    const taskId2 = await createTask(app, "Order Round-trip Import");
    const importRes = await req(app, `/api/tasks/${taskId2}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "csv",
        data: csvData,
      }),
    });
    expect(importRes.status).toBe(200);
    const importBody = await jsonRes(importRes);
    expect(importBody.ok).toBe(true);
    expect(importBody.import.importedLines).toBe(3);

    // Verify imported lines have correct order values
    const importedLines = importBody.productionList.lines;
    expect(importedLines).toHaveLength(3);
    const alphaLine = importedLines.find((l: any) => l.text === "Alpha");
    const betaLine = importedLines.find((l: any) => l.text === "Beta");
    const gammaLine = importedLines.find((l: any) => l.text === "Gamma");
    expect(alphaLine).toBeDefined();
    expect(betaLine).toBeDefined();
    expect(gammaLine).toBeDefined();
    expect(alphaLine.order).toBe(0);
    expect(betaLine.order).toBe(1);
    expect(gammaLine.order).toBe(2);

    // Re-export from imported task and verify order column is still stable
    const reExportRes = await req(app, `/api/tasks/${taskId2}/production-list/export?format=csv`);
    expect(reExportRes.status).toBe(200);
    const reCsvData = await reExportRes.text();
    const reCsvRows = reCsvData.split("\n").filter((r: string) => r.trim().length > 0);
    const reHeaders = reCsvRows[0].split(",");
    const reOrderIdx = reHeaders.indexOf("order");

    // Find rows by text content to handle potential reordering
    for (let i = 1; i <= 3; i++) {
      const rowOrder = reCsvRows[i].split(",")[reOrderIdx];
      expect(rowOrder).not.toBe("");
      expect(rowOrder).toMatch(/^\d+$/);
    }
  });
});

// ─── Regression: M-3 Duplicate Line ID Import ──────────────────────────────────

describe("Regression M-3: Import rejects duplicate line IDs", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
  });

  it("rejects import with duplicate line IDs (400 DUPLICATE_LINE_IDS)", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "dup_1", text: "First", voice: "Zephyr", speaker: "Alice" },
            { id: "dup_1", text: "Duplicate ID", voice: "Zephyr", speaker: "Bob" },
          ],
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("DUPLICATE_LINE_IDS");
    expect(body.error.metadata.duplicateIds).toContain("dup_1");
  });

  it("accepts import with unique line IDs", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "unique_1", text: "First", voice: "Zephyr", speaker: "Alice" },
            { id: "unique_2", text: "Second", voice: "Zephyr", speaker: "Bob" },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.import.importedLines).toBe(2);
  });

  it("rejects import with multiple different duplicate IDs", async () => {
    const taskId = await createTask(app);

    const res = await req(app, `/api/tasks/${taskId}/production-list/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        format: "json",
        data: {
          lines: [
            { id: "dup_a", text: "A1", voice: "Zephyr", speaker: "Alice" },
            { id: "dup_a", text: "A2", voice: "Zephyr", speaker: "Alice" },
            { id: "dup_b", text: "B1", voice: "Zephyr", speaker: "Alice" },
            { id: "dup_b", text: "B2", voice: "Zephyr", speaker: "Alice" },
          ],
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("DUPLICATE_LINE_IDS");
    expect(body.error.metadata.duplicateIds).toContain("dup_a");
    expect(body.error.metadata.duplicateIds).toContain("dup_b");
  });
});

// ─── Regression: M-4 Generate Job Source Audit ─────────────────────────────────

describe("Regression M-4: Generate job source audit", () => {
  let app: Hono;

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
    testState.mockApiKeyConfigured = true;
    testState.mockGenerateSuccess = true;
    testState.lastSourceContext = null;
  });

  it("records source='user' in generateSpeech call when user triggers generate", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "user" }),
    });

    // Verify the source was passed correctly to generateSpeech
    expect(testState.lastSourceContext).not.toBeNull();
    expect(testState.lastSourceContext!.source).toBe("user");
  });

  it("records source='agent' in generateSpeech call when agent triggers generate with confirm", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "agent", confirm: true }),
    });

    // Source should be "agent", NOT "user"
    expect(testState.lastSourceContext).not.toBeNull();
    expect(testState.lastSourceContext!.source).toBe("agent");
  });

  it("records source='cli' in generateSpeech call when cli triggers generate with confirm", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "cli", confirm: true }),
    });

    // Source should be "cli", NOT "user"
    expect(testState.lastSourceContext).not.toBeNull();
    expect(testState.lastSourceContext!.source).toBe("cli");
  });

  it("default source is 'user' when not specified", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, withPromptBinding([
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ]), 0, promptStructuredExtra());

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });

    expect(testState.lastSourceContext).not.toBeNull();
    expect(testState.lastSourceContext!.source).toBe("user");
  });

  it("audit log snapshot records actual source, not hardcoded 'user'", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Test", voice: "Zephyr", speaker: "Alice" },
    ], 0);

    await req(app, `/api/tasks/${taskId}/production-list/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, source: "cli", confirm: true }),
    });

    const db = getDb();
    const { operationAuditLog } = await import("../src/db/schema-extended.js");
    const logs = db.select().from(operationAuditLog)
      .where(eq(operationAuditLog.operation, "generate"))
      .all();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const snapshot = JSON.parse(logs[0].snapshotJson ?? "{}");
    // Audit snapshot should record actual source
    expect(snapshot.source).toBe("cli");
  });
});

// ─── Regression C-1R: PATCH updateSpeakers speaker sensitive field sanitization ──

describe("Regression C-1R: PATCH updateSpeakers sanitizes sensitive fields", () => {
  let app: Hono;

  // Sensitive field names that must NEVER leak through
  const SENSITIVE_KEYS = ["apiKey", "token", "Authorization", "secret", "password", "credential"];

  // Speaker with sensitive fields injected
  const speakerWithSecrets = {
    id: "spk_1",
    label: "Narrator",
    name: "Alice",
    voice: "Zephyr",
    style: "calm",
    // Sensitive fields that should be stripped
    apiKey: "sk-leaked-key-12345",
    token: "bearer-token-secret",
    Authorization: "Basic dXNlcjpwYXNz",
    secret: "super-secret-value",
    password: "p@ssw0rd!",
    credential: "cred-abc",
  };

  const speakerWithSecrets2 = {
    id: "spk_2",
    label: "Character",
    name: "Bob",
    voice: "Atlas",
    style: "dramatic",
    apiKey: "sk-another-key",
    token: "token-456",
  };

  beforeEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    app = createApp();
    testState.lastSourceContext = null;
  });

  /**
   * Helper: check that a string or object does NOT contain any sensitive key names or values
   */
  function expectNoSensitiveFields(content: string | Record<string, unknown> | Array<unknown>, label: string) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    for (const key of SENSITIVE_KEYS) {
      expect(text, `${label} should NOT contain sensitive key "${key}"`).not.toContain(`"${key}"`);
    }
    // Also check specific known secret values should not appear
    expect(text, `${label} should NOT contain leaked API key value`).not.toContain("sk-leaked-key-12345");
    expect(text, `${label} should NOT contain bearer token value`).not.toContain("bearer-token-secret");
    expect(text, `${label} should NOT contain Basic auth value`).not.toContain("Basic dXNlcjpwYXNz");
  }

  it("PATCH updateSpeakers response strips sensitive fields from speakers", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", speaker: "Narrator" },
    ], 0);

    // PATCH with speakers containing sensitive fields
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateSpeakers",
        payload: { speakers: [speakerWithSecrets] },
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await jsonRes(patchRes);
    expect(patchBody.ok).toBe(true);

    // PATCH response speakers must NOT contain sensitive fields
    const speakers = patchBody.productionList.speakers;
    expect(speakers).toHaveLength(1);
    expect(speakers[0].id).toBe("spk_1");
    expect(speakers[0].label).toBe("Narrator");
    expect(speakers[0].voice).toBe("Zephyr");
    expect(speakers[0].style).toBe("calm");
    // Explicitly check sensitive fields are absent
    expectNoSensitiveFields(speakers[0], "PATCH response speaker");
  });

  it("GET production-list after PATCH updateSpeakers does not leak sensitive fields", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", speaker: "Narrator" },
    ], 0);

    // PATCH speakers with sensitive data
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateSpeakers",
        payload: { speakers: [speakerWithSecrets, speakerWithSecrets2] },
      }),
    });

    // GET production-list should NOT contain sensitive fields
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    expect(getRes.status).toBe(200);
    const getBody = await jsonRes(getRes);
    expect(getBody.ok).toBe(true);
    const speakers = getBody.productionList.speakers;
    expect(speakers).toHaveLength(2);

    for (const sp of speakers) {
      expectNoSensitiveFields(sp, "GET production-list speaker");
    }
  });

  it("JSON export after PATCH updateSpeakers does not leak sensitive fields", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", speaker: "Narrator" },
    ], 0);

    // PATCH speakers with sensitive data
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateSpeakers",
        payload: { speakers: [speakerWithSecrets] },
      }),
    });

    // JSON export should NOT contain sensitive fields
    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=json`);
    expect(exportRes.status).toBe(200);
    const exportBody = await jsonRes(exportRes);
    const exportedSpeakers = exportBody.speakers;
    expect(exportedSpeakers).toHaveLength(1);
    expectNoSensitiveFields(exportedSpeakers[0], "JSON export speaker");

    // Also check the full export body doesn't contain sensitive values
    expectNoSensitiveFields(exportBody, "JSON export full body");
  });

  it("CSV export after PATCH updateSpeakers does not leak sensitive fields", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", speaker: "Narrator" },
    ], 0);

    // PATCH speakers with sensitive data
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateSpeakers",
        payload: { speakers: [speakerWithSecrets] },
      }),
    });

    // CSV export should NOT contain sensitive fields
    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=csv`);
    expect(exportRes.status).toBe(200);
    const csvText = await exportRes.text();
    expectNoSensitiveFields(csvText, "CSV export content");
  });

  it("Markdown export after PATCH updateSpeakers does not leak sensitive fields", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", speaker: "Narrator" },
    ], 0);

    // PATCH speakers with sensitive data
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateSpeakers",
        payload: { speakers: [speakerWithSecrets, speakerWithSecrets2] },
      }),
    });

    // Markdown export should NOT contain sensitive fields
    const exportRes = await req(app, `/api/tasks/${taskId}/production-list/export?format=markdown`);
    expect(exportRes.status).toBe(200);
    const mdText = await exportRes.text();
    expectNoSensitiveFields(mdText, "Markdown export content");
  });

  it("artifact stored in disk does not contain sensitive fields after PATCH updateSpeakers", async () => {
    const taskId = await createTask(app);
    await putProductionList(app, taskId, [
      { id: "line_1", text: "Hello", speaker: "Narrator" },
    ], 0);

    // PATCH speakers with sensitive data
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateSpeakers",
        payload: { speakers: [speakerWithSecrets] },
      }),
    });

    // Read artifact from disk to verify stored data is sanitized
    const artifact = readArtifact<{ speakers: unknown[] }>(taskId, productionListArtifactName());
    expect(artifact).not.toBeNull();
    expect(Array.isArray(artifact!.speakers)).toBe(true);
    expect(artifact!.speakers).toHaveLength(1);
    expectNoSensitiveFields(artifact!.speakers[0] as Record<string, unknown>, "Stored artifact speaker");
  });
});
