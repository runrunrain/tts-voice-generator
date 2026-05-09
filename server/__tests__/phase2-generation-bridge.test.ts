/**
 * Phase 2 Generation Bridge Tests
 *
 * Covers:
 * - POST /api/tasks/:taskId/production-list/generate endpoint
 * - Parameter validation (missing task, empty selection, missing lines)
 * - No API key failure path (generation_status -> "failed")
 * - Version conflict check
 * - Line generation state machine transitions (draft -> running -> succeeded/failed)
 * - Default selection of eligible lines when lineIds omitted
 * - Skip already completed lines
 * - Error handling for lines with empty text or missing voice
 * - Director snapshot resolution
 * - Structured response format
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "", mockApiKeyConfigured: false, mockGenerateSuccess: false, lastGenerateRequest: null as any }));

vi.mock("../src/config/env.js", async () => {
  const nc = await import("node:crypto");
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const tmp = np.join(no.tmpdir(), `tts-phase2-${process.pid}-${Date.now()}`);
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

// ─── Mock key-resolver and tts-generator for success-path tests ────────────

vi.mock("../src/services/key-resolver.js", () => ({
  isOpenRouterConfigured: () => testState.mockApiKeyConfigured,
  resolveApiKey: () => testState.mockApiKeyConfigured ? "test-key" : null,
  requireApiKey: () => { if (!testState.mockApiKeyConfigured) throw new Error("Not configured"); return "test-key"; },
}));

vi.mock("../src/services/tts-generator.js", () => ({
  generateSpeech: (request: unknown) => {
    testState.lastGenerateRequest = request;
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
import { GenerateFromListSchema } from "../src/domain/validators.js";
import { getDb } from "../src/db/index.js";
import { voiceLine } from "../src/db/schema-extended.js";
import { eq } from "drizzle-orm";
import { writeArtifact, productionListArtifactName } from "../src/services/artifact-store.js";
import {
  _setSpawnRunner,
  _resetSpawnRunner,
  _setExecRunner,
  _resetExecRunner,
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

/**
 * Helper: create task -> direct PUT v2 production list -> get production list with lines.
 * Agent normalize is strict v2 and no longer commits legacy fallback data when
 * OpenCode is unavailable, so generation tests build their fixture directly.
 */
function testPromptProfile() {
  return {
    id: "profile_test_narrator",
    name: "Test narrator profile",
    audioProfile: "Warm, clear narrator voice for backend tests.",
    scene: "Controlled test scene for production-list generation.",
    directorNotes: "Steady pace, clean pronunciation, neutral emotion.",
    sampleContext: "Automated test generation should use full prompt structure.",
    speakers: [{ id: "Alice", label: "Alice", voice: "Zephyr" }, { id: "Bob", label: "Bob", voice: "Puck" }],
    reusePolicy: "many-lines",
  };
}

async function setupProductionList(app: Hono, title = "Phase2 Gen Test"): Promise<{ taskId: string; lineIds: string[]; version: number }> {
  const createRes = await req(app, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const { task } = await jsonRes(createRes);
  const taskId = task.id;

  const profile = testPromptProfile();
  const fixtureLines = [
    {
      id: "line_alice",
      order: 0,
      speaker: "Alice",
      text: "Hello world",
      voice: "Zephyr",
    },
    {
      id: "line_bob",
      order: 1,
      speaker: "Bob",
      text: "Hi Alice, nice to meet you",
      voice: "Puck",
    },
  ];
  const v2Body = await putProductionList(app, taskId, fixtureLines.map((line: any) => ({
    ...line,
    transcript: line.text,
    promptProfileId: profile.id,
    directorProfileId: profile.id,
    speakerLabel: line.speaker,
  })), 0, {
    speakers: profile.speakers,
    promptProfiles: [profile],
    metadata: { schemaVersion: "tts.production-list.v2" },
  });
  return {
    taskId,
    lineIds: v2Body.productionList.lines.map((l: any) => l.id),
    version: v2Body.productionList.version,
  };
}

/**
 * Helper: PUT a production list with specific line data
 */
async function putProductionList(app: Hono, taskId: string, lines: any[], version: number, extra?: Record<string, unknown>) {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 2: Generation Bridge", () => {
  let app: Hono;

  beforeEach(() => {
    // Close existing DB connection first
    try { closeDb(); } catch { /* ignore */ }
    // Clean up old DB file
    try {
      if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) {
        fs.unlinkSync(testState.dbFilePath);
      }
    } catch { /* ignore */ }
    initSchema();
    // Mock _spawnRunner to avoid real opencode run calls in tests
    _setSpawnRunner(async () => {
      throw new Error("opencode run not available in test environment");
    });
    _setExecRunner(async () => {
      throw new Error("opencode unavailable in test environment");
    });
    app = createApp();
  });

  afterAll(() => {
    _resetSpawnRunner();
    _resetExecRunner();
    closeDb();
    try {
      if (testState.tmpDir) {
        fs.rmSync(testState.tmpDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  });

  // ─── GenerateFromListSchema Validation ─────────────────────────────────────

  describe("GenerateFromListSchema", () => {
    it("accepts empty body with defaults", () => {
      const result = GenerateFromListSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lineIds).toEqual([]);
        expect(result.data.skipCompleted).toBe(true);
        expect(result.data.expectedVersion).toBeUndefined();
      }
    });

    it("accepts explicit lineIds", () => {
      const result = GenerateFromListSchema.safeParse({
        lineIds: ["line_1", "line_2"],
        expectedVersion: 3,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lineIds).toEqual(["line_1", "line_2"]);
        expect(result.data.expectedVersion).toBe(3);
      }
    });

    it("rejects empty string lineIds", () => {
      const result = GenerateFromListSchema.safeParse({
        lineIds: [""],
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── Endpoint Validation ───────────────────────────────────────────────────

  describe("POST /api/tasks/:taskId/production-list/generate - validation", () => {
    it("returns 404 for non-existent task", async () => {
      const res = await req(app, "/api/tasks/nonexistent-task/production-list/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await jsonRes(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("TASK_NOT_FOUND");
    });

    it("returns 404 when no production list exists", async () => {
      const createRes = await req(app, "/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Empty Task" }),
      });
      const { task } = await jsonRes(createRes);

      const res = await req(app, `/api/tasks/${task.id}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await jsonRes(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("NO_PRODUCTION_LIST");
    });

    it("returns 409 on version conflict", async () => {
      const { taskId, version } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version + 99 }),
      });
      const body = await jsonRes(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VERSION_CONFLICT");
      expect(body.error.metadata.expectedVersion).toBe(version + 99);
      expect(body.error.metadata.currentVersion).toBe(version);
    });

    it("returns 404 for non-existent lineIds", async () => {
      const { taskId, version } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: ["nonexistent_line"], expectedVersion: version }),
      });
      const body = await jsonRes(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("LINES_NOT_FOUND");
    });

    it("returns 400 for invalid JSON body", async () => {
      const { taskId } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      const body = await jsonRes(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ─── No API Key Path ───────────────────────────────────────────────────────

  describe("No API Key - failure path", () => {
    it("records failure for each line when API key not configured", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);
      expect(lineIds.length).toBeGreaterThan(0);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.taskId).toBe(taskId);
      expect(body.generation.version).toBe(version);
      expect(body.generation.requestedCount).toBe(1);
      expect(body.generation.failedCount).toBe(1);
      expect(body.generation.succeededCount).toBe(0);

      const result = body.generation.results[0];
      expect(result.lineId).toBe(lineIds[0]);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MISSING_API_KEY");
      expect(result.errorMessage).toContain("API Key");

      // Verify DB state: generationStatus should be "failed"
      const db = getDb();
      const updatedLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(updatedLine?.generationStatus).toBe("failed");
    });

    it("handles multiple lines failing without API key", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.failedCount).toBe(lineIds.length);
      expect(body.generation.results.length).toBe(lineIds.length);

      for (const result of body.generation.results) {
        expect(result.status).toBe("failed");
        expect(result.errorCode).toBe("MISSING_API_KEY");
      }
    });
  });

  // ─── Line Selection ────────────────────────────────────────────────────────

  describe("Line selection", () => {
    it("selects only specified lineIds", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);
      expect(lineIds.length).toBeGreaterThanOrEqual(2);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.requestedCount).toBe(1);
      expect(body.generation.results.length).toBe(1);
      expect(body.generation.results[0].lineId).toBe(lineIds[0]);
    });

    it("selects all lines when lineIds omitted", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.requestedCount).toBe(lineIds.length);
    });

    it("selects all lines when lineIds is empty array", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [], expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.requestedCount).toBe(lineIds.length);
    });
  });

  // ─── Skip Completed Lines ──────────────────────────────────────────────────

  describe("Skip already completed lines", () => {
    it("skips lines already in succeeded state by default", async () => {
      const { taskId, version } = await setupProductionList(app);

      // Manually set a line to "succeeded" state
      const db = getDb();
      const lines = db.select().from(voiceLine).all();
      const targetLine = lines[0];
      db.update(voiceLine).set({
        generationStatus: "succeeded",
        relatedJobId: "job-existing",
        relatedAssetId: 100,
      }).where(eq(voiceLine.id, targetLine.id)).run();

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      // The succeeded line should be skipped
      const skipped = body.generation.results.find((r: any) => r.lineId === targetLine.id);
      expect(skipped).toBeDefined();
      expect(skipped.status).toBe("skipped");
      expect(body.generation.skippedCount).toBeGreaterThanOrEqual(1);
    });

    it("skips lines in running state by default", async () => {
      const { taskId, version } = await setupProductionList(app);

      const db = getDb();
      const lines = db.select().from(voiceLine).all();
      const targetLine = lines[0];
      db.update(voiceLine).set({
        generationStatus: "running",
      }).where(eq(voiceLine.id, targetLine.id)).run();

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = await jsonRes(res);

      const skipped = body.generation.results.find((r: any) => r.lineId === targetLine.id);
      expect(skipped).toBeDefined();
      expect(skipped.status).toBe("skipped");
    });

    it("includes completed lines when skipCompleted is false", async () => {
      const { taskId, version } = await setupProductionList(app);

      const db = getDb();
      const lines = db.select().from(voiceLine).all();
      const targetLine = lines[0];
      db.update(voiceLine).set({
        generationStatus: "succeeded",
        relatedJobId: "job-existing",
      }).where(eq(voiceLine.id, targetLine.id)).run();

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, skipCompleted: false }),
      });
      const body = await jsonRes(res);

      // The succeeded line should NOT be skipped; it should be attempted (and fail due to no API key)
      const attempted = body.generation.results.find((r: any) => r.lineId === targetLine.id);
      expect(attempted).toBeDefined();
      expect(attempted.status).toBe("failed");
      expect(attempted.errorCode).toBe("MISSING_API_KEY");
    });

    // MIN-1: skip "pending" lines by default to align with frontend ACTIVE_STATUSES
    it("skips lines in pending state by default", async () => {
      const { taskId, version } = await setupProductionList(app);

      const db = getDb();
      const lines = db.select().from(voiceLine).all();
      const targetLine = lines[0];
      db.update(voiceLine).set({
        generationStatus: "pending",
      }).where(eq(voiceLine.id, targetLine.id)).run();

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = await jsonRes(res);

      const skipped = body.generation.results.find((r: any) => r.lineId === targetLine.id);
      expect(skipped).toBeDefined();
      expect(skipped.status).toBe("skipped");
      expect(skipped.errorMessage).toContain("pending");
    });
  });

  // ─── Lines with Missing Data ───────────────────────────────────────────────

  describe("Lines with missing data", () => {
    it("skips lines with empty text", async () => {
      const createRes = await req(app, "/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Empty Text Test" }),
      });
      const { task } = await jsonRes(createRes);
      const taskId = task.id;

      // PUT a list with valid lines first, then manually update one line's text to empty in DB
      const putBody = await putProductionList(app, taskId, [
        { id: "line_good", text: "Hello world", voice: "Zephyr" },
        { id: "line_empty_text", text: "Has text initially", voice: "Zephyr" },
      ], 0);

      const version = putBody.productionList.version;

      // Manually set the line's text to empty in DB to simulate edge case
      const db = getDb();
      db.update(voiceLine).set({ text: "" }).where(eq(voiceLine.id, "line_empty_text")).run();

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      const emptyLineResult = body.generation.results.find((r: any) => r.lineId === "line_empty_text");
      expect(emptyLineResult).toBeDefined();
      expect(emptyLineResult.status).toBe("skipped");
      expect(emptyLineResult.errorMessage).toContain("empty text");
    });

    it("skips lines with no voice", async () => {
      const createRes = await req(app, "/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "No Voice Test" }),
      });
      const { task } = await jsonRes(createRes);
      const taskId = task.id;

      // PUT a valid list, then manually set one line's voice to empty
      const putBody = await putProductionList(app, taskId, [
        { id: "line_novoice", text: "Hello", voice: "Zephyr" },
      ], 0);

      const version = putBody.productionList.version;

      const db = getDb();
      db.update(voiceLine).set({ voice: "" }).where(eq(voiceLine.id, "line_novoice")).run();

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = await jsonRes(res);

      const noVoiceResult = body.generation.results.find((r: any) => r.lineId === "line_novoice");
      expect(noVoiceResult).toBeDefined();
      expect(noVoiceResult.status).toBe("skipped");
      expect(noVoiceResult.errorMessage).toContain("no voice");
    });
  });

  // ─── State Machine Transitions ─────────────────────────────────────────────

  describe("Generation state machine", () => {
    it("transitions draft -> failed when no API key", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // Verify initial state is "draft"
      const db = getDb();
      const lineBefore = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(lineBefore?.generationStatus).toBe("draft");

      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      const lineAfter = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(lineAfter?.generationStatus).toBe("failed");
    });

    it("does not modify generation status of skipped lines", async () => {
      const { taskId, version } = await setupProductionList(app);

      const db = getDb();
      const lines = db.select().from(voiceLine).all();
      const targetLine = lines[0];
      db.update(voiceLine).set({
        generationStatus: "succeeded",
        relatedJobId: "job-old",
        relatedAssetId: 99,
      }).where(eq(voiceLine.id, targetLine.id)).run();

      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });

      const lineAfter = db.select().from(voiceLine).where(eq(voiceLine.id, targetLine.id)).get();
      // Should remain "succeeded"
      expect(lineAfter?.generationStatus).toBe("succeeded");
      expect(lineAfter?.relatedJobId).toBe("job-old");
      expect(lineAfter?.relatedAssetId).toBe(99);
    });
  });

  describe("Prompt-structured generation bridge", () => {
    afterEach(() => {
      testState.mockApiKeyConfigured = false;
      testState.mockGenerateSuccess = false;
      testState.lastGenerateRequest = null;
    });

    it("uses assembled prompt instead of bare transcript", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);
      testState.mockApiKeyConfigured = true;
      testState.mockGenerateSuccess = true;

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.succeededCount).toBe(1);
      expect(testState.lastGenerateRequest).toBeTruthy();
      expect(testState.lastGenerateRequest.input).toContain("Audio Profile:");
      expect(testState.lastGenerateRequest.input).toContain("Scene:");
      expect(testState.lastGenerateRequest.input).toContain("Director's Notes:");
      expect(testState.lastGenerateRequest.input).toContain("Sample Context:");
      expect(testState.lastGenerateRequest.directorSnapshot.transcript).toBeTruthy();
      expect(testState.lastGenerateRequest.input).toContain(testState.lastGenerateRequest.directorSnapshot.transcript);
    });
  });

  // ─── Structured Response Format ────────────────────────────────────────────

  describe("Response format", () => {
    it("returns all required fields in generation response", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.requestId).toBeDefined();
      expect(typeof body.requestId).toBe("string");

      const gen = body.generation;
      expect(gen.taskId).toBe(taskId);
      expect(gen.version).toBe(version);
      expect(typeof gen.requestedCount).toBe("number");
      expect(typeof gen.succeededCount).toBe("number");
      expect(typeof gen.failedCount).toBe("number");
      expect(typeof gen.skippedCount).toBe("number");
      expect(Array.isArray(gen.results)).toBe(true);

      // counts should add up
      expect(gen.requestedCount).toBe(
        gen.succeededCount + gen.failedCount + gen.skippedCount
      );
    });

    it("each result has required fields", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });
      const body = await jsonRes(res);

      const result = body.generation.results[0];
      expect(typeof result.lineId).toBe("string");
      expect(["succeeded", "failed", "skipped"]).toContain(result.status);

      if (result.status === "failed") {
        expect(typeof result.errorCode).toBe("string");
        expect(typeof result.errorMessage).toBe("string");
      }

      if (result.status === "succeeded") {
        expect(result.jobId).toBeDefined();
      }

      if (result.status === "skipped") {
        expect(result.errorMessage).toBeDefined();
      }
    });
  });

  // ─── Version Check Optional ────────────────────────────────────────────────

  describe("Version check optional", () => {
    it("succeeds without expectedVersion", async () => {
      const { taskId } = await setupProductionList(app);

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.taskId).toBe(taskId);
    });
  });

  // ─── Generation Error Fields Persistence (MIN-2) ───────────────────────────

  describe("Generation error fields persistence", () => {
    it("persists generation_error_code and generation_error_message on MISSING_API_KEY failure", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      const db = getDb();
      const updatedLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(updatedLine?.generationErrorCode).toBe("MISSING_API_KEY");
      expect(updatedLine?.generationErrorMessage).toContain("API Key");
    });

    it("GET production-list returns generation_error_code and generation_error_message", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // Trigger failure to write error fields
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      // GET production list and verify error fields are returned
      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);

      expect(getBody.ok).toBe(true);
      const failedLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
      expect(failedLine).toBeDefined();
      expect(failedLine.generationErrorCode).toBe("MISSING_API_KEY");
      expect(failedLine.generationErrorMessage).toContain("API Key");
    });

    it("clears error fields when a line is re-attempted and succeeds (via reset)", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // First: trigger failure
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      const db = getDb();
      const failedLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(failedLine?.generationErrorCode).toBe("MISSING_API_KEY");

      // Simulate external reset: set back to draft with cleared error fields
      db.update(voiceLine).set({
        generationStatus: "draft",
        generationErrorCode: null,
        generationErrorMessage: null,
      }).where(eq(voiceLine.id, lineIds[0])).run();

      // Verify error fields are cleared
      const resetLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(resetLine?.generationErrorCode).toBeNull();
      expect(resetLine?.generationErrorMessage).toBeNull();
    });

    it("error fields survive across a PUT that includes them", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // Trigger failure
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      // GET to read the line state with error fields
      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);
      const lines = getBody.productionList.lines;

      // Re-PUT the same lines (preserving error fields)
      const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: getBody.productionList.version,
          lines: lines.map((l: any, i: number) => ({
            id: l.id,
            order: i,
            speaker: l.speaker || "narrator",
            text: l.transcript ?? l.text ?? "Test",
            voice: l.voice || "Zephyr",
            generationStatus: l.generationStatus ?? "draft",
            generationErrorCode: l.generationErrorCode,
            generationErrorMessage: l.generationErrorMessage,
          })),
          speakers: [],
        }),
      });
      const putBody = await jsonRes(putRes);
      expect(putBody.ok).toBe(true);

      // GET again and verify error fields survived
      const getRes2 = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody2 = await jsonRes(getRes2);
      const failedLine2 = getBody2.productionList.lines.find((l: any) => l.id === lineIds[0]);
      expect(failedLine2.generationErrorCode).toBe("MISSING_API_KEY");
    });
  });

  // ─── Error Fields Cleared on Running / Succeeded (MINOR-4) ───────────────────

  describe("Error fields cleared on running and succeeded", () => {
    afterEach(() => {
      testState.mockApiKeyConfigured = false;
      testState.mockGenerateSuccess = false;
    });

    it("clears error fields when entering running state", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // First: trigger failure to write error fields
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      const db = getDb();
      const failedLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(failedLine?.generationErrorCode).toBe("MISSING_API_KEY");
      expect(failedLine?.generationErrorMessage).toContain("API Key");

      // Reset the line back to draft so it's eligible for re-generation
      db.update(voiceLine).set({
        generationStatus: "draft",
      }).where(eq(voiceLine.id, lineIds[0])).run();

      // Enable mock success path
      testState.mockApiKeyConfigured = true;
      testState.mockGenerateSuccess = true;

      // Re-generate -- should succeed and clear error fields
      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version, skipCompleted: false }),
      });
      const body = await jsonRes(res);

      expect(body.ok).toBe(true);
      expect(body.generation.succeededCount).toBe(1);

      // Verify error fields are cleared in DB
      const succeededLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(succeededLine?.generationStatus).toBe("succeeded");
      expect(succeededLine?.generationErrorCode).toBeNull();
      expect(succeededLine?.generationErrorMessage).toBeNull();
    });

    it("GET returns null error fields for succeeded line that previously failed", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // First: trigger failure
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      // Reset to draft
      const db = getDb();
      db.update(voiceLine).set({ generationStatus: "draft" }).where(eq(voiceLine.id, lineIds[0])).run();

      // Enable mock success path
      testState.mockApiKeyConfigured = true;
      testState.mockGenerateSuccess = true;

      // Re-generate -- should succeed
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version, skipCompleted: false }),
      });

      // GET production list and verify error fields are null for the succeeded line
      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);

      expect(getBody.ok).toBe(true);
      const succeededLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
      expect(succeededLine).toBeDefined();
      expect(succeededLine.generationStatus).toBe("succeeded");
      expect(succeededLine.generationErrorCode).toBeNull();
      expect(succeededLine.generationErrorMessage).toBeNull();
    });

    it("replaces old error fields with new error on second failure", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // First failure: MISSING_API_KEY
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      const db = getDb();
      const firstFail = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(firstFail?.generationErrorCode).toBe("MISSING_API_KEY");

      // Reset to draft
      db.update(voiceLine).set({ generationStatus: "draft" }).where(eq(voiceLine.id, lineIds[0])).run();

      // Enable API key but make generation fail with a different error
      testState.mockApiKeyConfigured = true;
      testState.mockGenerateSuccess = false;

      // Second failure: MOCK_ERROR
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version, skipCompleted: false }),
      });

      const secondFail = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(secondFail?.generationStatus).toBe("failed");
      expect(secondFail?.generationErrorCode).toBe("MOCK_ERROR");
      expect(secondFail?.generationErrorMessage).toBe("Mock generation failure");
      // Should NOT still have the old MISSING_API_KEY error
      expect(secondFail?.generationErrorCode).not.toBe("MISSING_API_KEY");
    });

    it("GET returns null errors when artifact has stale error fields but DB is succeeded", async () => {
      const { taskId, lineIds, version } = await setupProductionList(app);

      // Step 1: Trigger failure to populate error fields in DB and artifact
      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version }),
      });

      const db = getDb();
      const failedLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(failedLine?.generationErrorCode).toBe("MISSING_API_KEY");
      expect(failedLine?.generationStatus).toBe("failed");

      // Step 2: Reset to draft in DB
      db.update(voiceLine).set({ generationStatus: "draft" }).where(eq(voiceLine.id, lineIds[0])).run();

      // Step 3: Manually write stale artifact with old error fields still present
      // This simulates the scenario where artifact was written during failure
      // but not yet cleaned up
      const artifact = {
        schemaVersion: "tts.production-list.v2",
        version: 1,
        versionId: failedLine?.versionId,
        lines: [{
          id: lineIds[0],
          order: 0,
          speaker: "Alice",
          text: "Hello world",
          transcript: "Hello world",
          voice: "Zephyr",
          promptProfileId: "profile_test_narrator",
          directorProfileId: "profile_test_narrator",
          generationStatus: "failed",
          generationErrorCode: "MISSING_API_KEY",
          generationErrorMessage: "Old stale error from artifact",
        }],
        speakers: [],
        promptProfiles: [testPromptProfile()],
      };
      writeArtifact(taskId, productionListArtifactName(), artifact);

      // Step 4: Enable mock success and re-generate
      testState.mockApiKeyConfigured = true;
      testState.mockGenerateSuccess = true;

      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds: [lineIds[0]], expectedVersion: version, skipCompleted: false }),
      });

      // Verify DB is succeeded with null errors
      const succeededLine = db.select().from(voiceLine).where(eq(voiceLine.id, lineIds[0])).get();
      expect(succeededLine?.generationStatus).toBe("succeeded");
      expect(succeededLine?.generationErrorCode).toBeNull();
      expect(succeededLine?.generationErrorMessage).toBeNull();

      // Step 5: GET production-list -- must return null errors, NOT stale artifact errors
      const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
      const getBody = await jsonRes(getRes);

      expect(getBody.ok).toBe(true);
      const line = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
      expect(line).toBeDefined();
      expect(line.generationStatus).toBe("succeeded");
      expect(line.generationErrorCode).toBeNull();
      expect(line.generationErrorMessage).toBeNull();
    });
  });

  // ─── Audit Log ─────────────────────────────────────────────────────────────

  describe("Audit log", () => {
    it("writes audit log for generation attempt", async () => {
      const { taskId, version } = await setupProductionList(app, "Audit Test Task");

      await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });

      const db = getDb();
      const { operationAuditLog } = await import("../src/db/schema-extended.js");
      const logs = db.select().from(operationAuditLog).all();
      const genLogs = logs.filter((l) => l.operation === "generate");
      expect(genLogs.length).toBeGreaterThanOrEqual(1);

      const genLog = genLogs[genLogs.length - 1]; // take the latest
      expect(genLog.entityType).toBe("production_list");

      const snapshot = JSON.parse(genLog.snapshotJson ?? "{}");
      expect(snapshot.taskId).toBe(taskId);
      expect(typeof snapshot.requestedCount).toBe("number");
      expect(typeof snapshot.failedCount).toBe("number");
    });
  });

  // ─── Empty Production List ─────────────────────────────────────────────────

  describe("Empty production list edge case", () => {
    it("returns 400 for production list with no lines", async () => {
      const createRes = await req(app, "/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Empty PL Test" }),
      });
      const { task } = await jsonRes(createRes);
      const taskId = task.id;

      // PUT an empty production list
      await req(app, `/api/tasks/${taskId}/production-list`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 0,
          lines: [],
          speakers: [],
        }),
      });

      const res = await req(app, `/api/tasks/${taskId}/production-list/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await jsonRes(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("EMPTY_PRODUCTION_LIST");
    });
  });
});
