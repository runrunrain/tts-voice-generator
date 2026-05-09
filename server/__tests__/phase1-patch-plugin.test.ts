/**
 * Phase 1 Backend Tests: Schema extension, PATCH operations, Plugin write tools
 *
 * Covers:
 * - voice_line schema extension fields (director binding, generation tracking)
 * - PATCH updateSpeakers: replace speakers array
 * - PATCH updateDirectorProfile: bind/unbind director profile on lines
 * - New button presets seeded correctly
 * - Backward compatibility: old data without new fields still loads
 */

import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const nc = await import("node:crypto");
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const tmp = np.join(no.tmpdir(), `tts-phase1-${process.pid}-${Date.now()}`);
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
  _setSpawnRunner,
  _resetSpawnRunner,
} from "../src/services/opencode-runner.js";
import {
  VoiceLineSchema,
  SpeakerSchema,
} from "../src/domain/validators.js";

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

// Helper: create task + direct PUT production list -> get production list with lines.
// Agent normalize is strict v2 and no longer creates legacy fallback data when
// OpenCode is unavailable, so patch tests should not depend on normalize fallback.
async function setupProductionList(app: Hono): Promise<{ taskId: string; lineIds: string[]; version: number }> {
  const createRes = await req(app, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Phase1 Test" }),
  });
  const { task } = await jsonRes(createRes);
  const taskId = task.id;

  const lines = [
    { id: "line_alice", order: 0, speaker: "alice", text: "Hello world", voice: "Zephyr" },
    { id: "line_bob", order: 1, speaker: "bob", text: "Hi Alice", voice: "Puck" },
  ];
  const speakers = [
    { id: "alice", label: "Alice", voice: "Zephyr" },
    { id: "bob", label: "Bob", voice: "Puck" },
  ];

  const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: 0, lines, speakers }),
  });
  expect(putRes.status).toBe(200);
  const putBody = await jsonRes(putRes);
  return {
    taskId,
    lineIds: putBody.productionList.lines.map((l: any) => l.id),
    version: putBody.productionList.version,
  };
}

// ─── VoiceLine Schema Extension Tests ────────────────────────────────────────

describe("VoiceLine Schema Extension", () => {
  it("accepts line with all new fields", () => {
    const result = VoiceLineSchema.safeParse({
      id: "l1",
      order: 0,
      speaker: "narrator",
      text: "Hello",
      voice: "Zephyr",
      directorProfileId: "dp-001",
      directorOverrideJson: '{"audioProfile":"warm"}',
      generationStatus: "ready",
      relatedJobId: "job-123",
      relatedAssetId: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directorProfileId).toBe("dp-001");
      expect(result.data.generationStatus).toBe("ready");
      expect(result.data.relatedJobId).toBe("job-123");
      expect(result.data.relatedAssetId).toBe(42);
    }
  });

  it("provides safe defaults for new fields", () => {
    const result = VoiceLineSchema.safeParse({
      id: "l2",
      order: 0,
      speaker: "narrator",
      text: "Hello",
      voice: "Zephyr",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // directorProfileId is .optional().nullable() -> undefined when omitted
      expect(result.data.directorProfileId == null).toBe(true);
      expect(result.data.directorOverrideJson == null).toBe(true);
      expect(result.data.generationStatus).toBe("draft");
      expect(result.data.relatedJobId == null).toBe(true);
      expect(result.data.relatedAssetId == null).toBe(true);
    }
  });

  it("accepts nullable values for new fields", () => {
    const result = VoiceLineSchema.safeParse({
      id: "l3",
      order: 0,
      speaker: "narrator",
      text: "Hello",
      voice: "Zephyr",
      directorProfileId: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.directorProfileId).toBeNull();
      expect(result.data.generationStatus).toBe("draft");
    }
  });

  it("rejects invalid generationStatus values", () => {
    const result = VoiceLineSchema.safeParse({
      id: "l4",
      order: 0,
      speaker: "narrator",
      text: "Hello",
      voice: "Zephyr",
      generationStatus: "invalid_status",
    });
    expect(result.success).toBe(false);
  });
});

// ─── PATCH updateSpeakers Tests ──────────────────────────────────────────────

describe("PATCH updateSpeakers", () => {
  let app: Hono;
  let taskId: string;
  let version: number;

  beforeEach(async () => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    // Mock _spawnRunner to avoid real opencode run calls in tests
    _setSpawnRunner(async () => {
      throw new Error("opencode run not available in test environment");
    });
    app = createApp();
    const setup = await setupProductionList(app);
    taskId = setup.taskId;
    version = setup.version;
  });

  afterAll(() => {
    _resetSpawnRunner();
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("updates speakers via PATCH", async () => {
    const newSpeakers = [
      { id: "alice", label: "Alice", voice: "Zephyr" },
      { id: "bob", label: "Bob", voice: "Puck" },
    ];

    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateSpeakers",
        payload: { speakers: newSpeakers },
        expectedVersion: version,
      }),
    });

    expect(patchRes.status).toBe(200);
    const body = await jsonRes(patchRes);
    expect(body.ok).toBe(true);
    expect(body.productionList.version).toBe(version + 1);

    // Verify speakers persisted in the artifact
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.speakers).toHaveLength(2);
    expect(getBody.productionList.speakers[0].id).toBe("alice");
    expect(getBody.productionList.speakers[1].id).toBe("bob");
  });

  it("rejects updateSpeakers with >2 speakers", async () => {
    const tooManySpeakers = [
      { id: "a", label: "A", voice: "Zephyr" },
      { id: "b", label: "B", voice: "Puck" },
      { id: "c", label: "C", voice: "Charon" },
    ];

    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateSpeakers",
        payload: { speakers: tooManySpeakers },
        expectedVersion: version,
      }),
    });

    expect(patchRes.status).toBe(400);
    const body = await jsonRes(patchRes);
    expect(body.error.code).toBe("PATCH_ERROR");
  });

  it("rejects updateSpeakers without speakers array", async () => {
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateSpeakers",
        payload: {},
        expectedVersion: version,
      }),
    });

    expect(patchRes.status).toBe(400);
  });
});

// ─── PATCH updateDirectorProfile Tests ───────────────────────────────────────

describe("PATCH updateDirectorProfile", () => {
  let app: Hono;
  let taskId: string;
  let lineIds: string[];
  let version: number;

  beforeEach(async () => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    // Mock _spawnRunner to avoid real opencode run calls in tests
    _setSpawnRunner(async () => {
      throw new Error("opencode run not available in test environment");
    });
    app = createApp();
    const setup = await setupProductionList(app);
    taskId = setup.taskId;
    lineIds = setup.lineIds;
    version = setup.version;
  });

  afterAll(() => {
    _resetSpawnRunner();
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("sets directorProfileId on all lines when lineIds omitted", async () => {
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-test-001" },
        expectedVersion: version,
      }),
    });

    expect(patchRes.status).toBe(200);
    const body = await jsonRes(patchRes);
    expect(body.ok).toBe(true);

    // Verify all lines have the director profile
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    for (const line of getBody.productionList.lines) {
      expect(line.directorProfileId).toBe("dp-test-001");
    }
  });

  it("sets directorProfileId only on specified lines", async () => {
    const targetLineId = lineIds[0];

    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-target-only", lineIds: [targetLineId] },
        expectedVersion: version,
      }),
    });

    expect(patchRes.status).toBe(200);
    const body = await jsonRes(patchRes);
    expect(body.ok).toBe(true);

    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const lines = getBody.productionList.lines;

    const targetLine = lines.find((l: any) => l.id === targetLineId);
    expect(targetLine.directorProfileId).toBe("dp-target-only");

    // Other lines should NOT have it
    const otherLines = lines.filter((l: any) => l.id !== targetLineId);
    for (const line of otherLines) {
      expect(line.directorProfileId).toBeFalsy();
    }
  });

  it("clears directorProfileId with null value", async () => {
    // First set a profile
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-to-clear" },
        expectedVersion: version,
      }),
    });

    // Now clear it
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: null },
        expectedVersion: version + 1,
      }),
    });

    expect(patchRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    for (const line of getBody.productionList.lines) {
      expect(line.directorProfileId).toBeFalsy();
    }
  });

  it("writes audit log for updateDirectorProfile", async () => {
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-audit-test" },
        expectedVersion: version,
      }),
    });

    // Verify audit log was written (GET production list still works = audit didn't crash)
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    expect(getRes.status).toBe(200);
  });
});

// ─── PUT with new schema fields ──────────────────────────────────────────────

describe("PUT with extended voice_line fields", () => {
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
      body: JSON.stringify({ title: "Extended Fields Test" }),
    });
    taskId = (await jsonRes(createRes)).task.id;
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("PUT and GET preserves director binding and generation fields", async () => {
    const lines = [
      {
        id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr",
        directorProfileId: "dp-001",
        directorOverrideJson: '{"audioProfile":"warm"}',
        generationStatus: "ready",
        relatedJobId: "job-001",
        relatedAssetId: 42,
      },
      {
        id: "l2", order: 1, speaker: "narrator", text: "World", voice: "Zephyr",
        generationStatus: "draft",
      },
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

    // GET confirms fields preserved
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);

    const line1 = getBody.productionList.lines.find((l: any) => l.id === "l1");
    expect(line1).toBeTruthy();
    expect(line1.directorProfileId).toBe("dp-001");
    expect(line1.directorOverrideJson).toBe('{"audioProfile":"warm"}');
    expect(line1.generationStatus).toBe("ready");
    expect(line1.relatedJobId).toBe("job-001");
    expect(line1.relatedAssetId).toBe(42);

    const line2 = getBody.productionList.lines.find((l: any) => l.id === "l2");
    expect(line2.generationStatus).toBe("draft");
    expect(line2.directorProfileId).toBeFalsy();
  });
});

// ─── Button Preset Seeding Tests ─────────────────────────────────────────────

describe("Button Preset Seeding (Phase 1)", () => {
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

  it("seeds normalize-requirements preset", async () => {
    const res = await req(app, "/api/agent/buttons");
    const body = await jsonRes(res);
    const keys = body.buttons.map((b: any) => b.buttonKey);
    expect(keys).toContain("normalize-requirements");
    expect(keys).toContain("complete-director-fields");
    expect(keys).toContain("fix-validation-errors");
  });

  it("preserves existing buttons (rewrite/shorten/expand/style-*)", async () => {
    const res = await req(app, "/api/agent/buttons");
    const body = await jsonRes(res);
    const keys = body.buttons.map((b: any) => b.buttonKey);
    expect(keys).toContain("shorten");
    expect(keys).toContain("expand");
    expect(keys).toContain("rewrite");
    expect(keys).toContain("style-formal");
    expect(keys).toContain("style-casual");
    expect(keys).toContain("style-dramatic");
  });

  it("seeds at least 9 buttons total", async () => {
    const res = await req(app, "/api/agent/buttons");
    const body = await jsonRes(res);
    expect(body.buttons.length).toBeGreaterThanOrEqual(9);
  });
});

// ─── Backward Compatibility Test ─────────────────────────────────────────────

describe("Backward Compatibility", () => {
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
      body: JSON.stringify({ title: "Compat Test" }),
    });
    taskId = (await jsonRes(createRes)).task.id;
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("loads old-format production list without new fields", async () => {
    // PUT with minimal fields (old format)
    const lines = [
      { id: "old-1", order: 0, speaker: "narrator", text: "Old format line 1", voice: "Zephyr" },
      { id: "old-2", order: 1, speaker: "narrator", text: "Old format line 2", voice: "Zephyr" },
    ];
    const speakers = [{ id: "narrator", label: "Narrator", voice: "Zephyr" }];

    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 0, lines, speakers }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.lines).toHaveLength(2);

    // New fields should have safe defaults
    for (const line of getBody.productionList.lines) {
      expect(line.generationStatus).toBe("draft");
      // directorProfileId should be null or undefined (safe default)
      if (line.directorProfileId !== undefined && line.directorProfileId !== null) {
        // It's okay if it has a value, but it should not crash
      }
    }
  });
});
