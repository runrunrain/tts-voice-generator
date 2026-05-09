/**
 * Major fix verification tests.
 *
 * Covers:
 * 1. Disabled button cannot be executed (403 BUTTON_DISABLED)
 * 2. Speakers/metadata/directorProfileId preserved after save -> GET
 * 3. Document PATCH expectedVersion conflict (409 VERSION_CONFLICT)
 * 4. Line directorProfileId artifact round-trip preservation
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const nc = await import("node:crypto");
  const tmp = np.join(no.tmpdir(), `tts-major-${process.pid}-${Date.now()}`);
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
import { _setExecRunner, _resetExecRunner } from "../src/services/opencode-runner.js";
import Database from "better-sqlite3";

// ─── Test App ────────────────────────────────────────────────────────────────

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/", tasksRoutes);
  app.route("/", documentsRoutes);
  app.route("/", productionListRoutes);
  app.route("/", directorProfilesRoutes);
  app.route("/", agentButtonsRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

async function jsonRes(res: Response) {
  return res.json();
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let app: Hono;
let testTaskId: string;

beforeAll(() => {
  _setExecRunner(async () => {
    throw new Error("opencode unavailable in test environment");
  });
  initSchema();
  app = createTestApp();
});

afterAll(() => {
  _resetExecRunner();
  closeDb();
  try {
    if (testState.tmpDir) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// Helper: create a task and return its ID
async function createTask(title = "Test Task"): Promise<string> {
  const res = await req(app, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title, description: "test" }),
    headers: { "Content-Type": "application/json" },
  });
  const body = await jsonRes(res);
  return body.task.id;
}

// ─── Test 1: Disabled button cannot be executed ──────────────────────────────

describe("Major 4: Button disabled cannot be executed", () => {
  let taskId: string;
  let lineId: string;

  beforeAll(async () => {
    taskId = await createTask("Button disabled test");
    lineId = uuidv4();

    // Create a production list with a line
    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: 0,
        lines: [
          { id: lineId, order: 0, speaker: "narrator", text: "Hello world test", voice: "Zephyr" },
        ],
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const putBody = await jsonRes(putRes);
    expect(putBody.ok).toBe(true);
  });

  it("should return 403 BUTTON_DISABLED when executing a disabled button", async () => {
    // Insert a disabled button directly in DB
    const sqlite = new Database(testState.dbFilePath);
    sqlite.pragma("foreign_keys = ON");
    const btnId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO agent_button_preset (id, button_key, name, description, prompt_template, target_policy_json, sort_order, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(btnId, "test-disabled-btn", "Disabled Test", "desc", "tpl", '{"allowedFields":["text"],"scope":"line"}', 99, now, now);
    sqlite.close();

    // Get current version
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const version = getBody.productionList.version;

    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/test-disabled-btn/execute`, {
      method: "POST",
      body: JSON.stringify({ targetLineId: lineId, expectedVersion: version, parameters: {} }),
      headers: { "Content-Type": "application/json" },
    });

    expect(execRes.status).toBe(403);
    const execBody = await jsonRes(execRes);
    expect(execBody.ok).toBe(false);
    expect(execBody.error.code).toBe("BUTTON_DISABLED");
    expect(execBody.error.message).toContain("disabled");
  });

  it("should allow executing an enabled button", async () => {
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const version = getBody.productionList.version;
    const lines = getBody.productionList.lines;
    expect(lines.length).toBeGreaterThan(0);

    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/shorten/execute`, {
      method: "POST",
      body: JSON.stringify({ targetLineId: lines[0].id, expectedVersion: version, parameters: {} }),
      headers: { "Content-Type": "application/json" },
    });

    expect(execRes.status).toBe(200);
    const execBody = await jsonRes(execRes);
    expect(execBody.ok).toBe(true);
    expect(execBody.runId).toBeDefined();
    expect(execBody.version).toBe(version + 1);
  });
});

// ─── Test 2: Speakers/metadata/directorProfileId preserved ──────────────────

describe("Major 2: Speakers/metadata/directorProfileId preserved after save", () => {
  let taskId: string;

  beforeAll(async () => {
    taskId = await createTask("Speakers preservation test");
  });

  it("should preserve speakers, metadata, and directorProfileId through save-GET cycle", async () => {
    // Get current version (0 = empty)
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const version = getBody.productionList.version;

    const newLineId = uuidv4();
    const directorProfileId = uuidv4();
    const speakers = [
      { id: "speaker-a", label: "Speaker A", name: "Alice", voice: "Zephyr", style: "bright" },
      { id: "speaker-b", label: "Speaker B", name: "Bob", voice: "Puck", style: "calm" },
    ];
    const metadata = { source: "manual-edit", priority: "high", tags: ["test", "save"] };

    // PUT with speakers, directorProfileId, and metadata
    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: version,
        lines: [
          { id: newLineId, order: 0, speaker: "speaker-a", text: "Test preservation", voice: "Zephyr", style: "bright", notes: "test note" },
        ],
        speakers,
        directorProfileId,
        metadata,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const putBody = await jsonRes(putRes);
    expect(putBody.ok).toBe(true);

    // GET and verify
    const getRes2 = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody2 = await jsonRes(getRes2);

    expect(getBody2.productionList.speakers).toHaveLength(2);
    expect(getBody2.productionList.speakers[0].id).toBe("speaker-a");
    expect(getBody2.productionList.speakers[0].name).toBe("Alice");
    expect(getBody2.productionList.speakers[0].voice).toBe("Zephyr");
    expect(getBody2.productionList.speakers[1].id).toBe("speaker-b");
    expect(getBody2.productionList.speakers[1].name).toBe("Bob");

    expect(getBody2.productionList.directorProfileId).toBe(directorProfileId);
    expect(getBody2.productionList.metadata).toMatchObject(metadata);
  });
});

// ─── Test 3: Document PATCH expectedVersion conflict ─────────────────────────

describe("Major 6: Document version conflict protection", () => {
  let taskId: string;

  beforeAll(async () => {
    taskId = await createTask("Document version test");
  });

  it("should create document with version 1", async () => {
    const pasteRes = await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      body: JSON.stringify({ fileName: "version-test.md", content: "Initial content" }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await jsonRes(pasteRes);
    expect(pasteRes.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.document.version).toBe(1);
  });

  it("should reject PATCH with wrong expectedVersion (409 VERSION_CONFLICT)", async () => {
    // Create a document
    const pasteRes = await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      body: JSON.stringify({ fileName: "conflict-test.md", content: "Original content" }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await jsonRes(pasteRes);
    const docId = body.document.id;

    // Patch with correct version
    const patchRes1 = await req(app, `/api/tasks/${taskId}/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "Updated content v2", expectedVersion: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    const patchBody1 = await jsonRes(patchRes1);
    expect(patchRes1.status).toBe(200);
    expect(patchBody1.document.version).toBe(2);

    // Patch with stale version (1) should fail with 409
    const patchRes2 = await req(app, `/api/tasks/${taskId}/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "Stale update attempt", expectedVersion: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    const patchBody2 = await jsonRes(patchRes2);
    expect(patchRes2.status).toBe(409);
    expect(patchBody2.error.code).toBe("VERSION_CONFLICT");
    expect(patchBody2.error.metadata.expectedVersion).toBe(1);
    expect(patchBody2.error.metadata.currentVersion).toBe(2);
  });

  it("should accept PATCH with correct expectedVersion and increment version", async () => {
    const pasteRes = await req(app, `/api/tasks/${taskId}/documents/paste`, {
      method: "POST",
      body: JSON.stringify({ fileName: "version-increment.md", content: "v1 content" }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await jsonRes(pasteRes);
    const docId = body.document.id;

    // Patch with version 1 -> should bump to 2
    const patchRes = await req(app, `/api/tasks/${taskId}/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "v2 content", expectedVersion: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    const patchBody = await jsonRes(patchRes);
    expect(patchRes.status).toBe(200);
    expect(patchBody.document.version).toBe(2);

    // Patch with version 2 -> should bump to 3
    const patchRes2 = await req(app, `/api/tasks/${taskId}/documents/${docId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "v3 content", expectedVersion: 2 }),
      headers: { "Content-Type": "application/json" },
    });
    const patchBody2 = await jsonRes(patchRes2);
    expect(patchRes2.status).toBe(200);
    expect(patchBody2.document.version).toBe(3);
  });
});

// ─── Test 4: Line directorProfileId artifact round-trip ──────────────────────

describe("Major 3: Line directorProfileId preserved via artifact", () => {
  let taskId: string;

  beforeAll(async () => {
    taskId = await createTask("DirectorProfileId round-trip test");
  });

  it("should preserve line.directorProfileId through PUT -> GET cycle", async () => {
    // Get current version
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const version = getBody.productionList.version;

    // Create a director profile
    const profileRes = await req(app, "/api/director-profiles", {
      method: "POST",
      body: JSON.stringify({
        name: `Test Director ${Date.now()}`,
        description: "For line profile test",
        config: { audioProfile: "warm", scene: "indoor" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const profileBody = await jsonRes(profileRes);
    const realProfileId = profileBody.profile.id;

    const lineId = uuidv4();

    // PUT with line having directorProfileId
    const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: version,
        lines: [
          { id: lineId, order: 0, speaker: "narrator", text: "Director profiled line", voice: "Zephyr", directorProfileId: realProfileId },
        ],
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const putBody = await jsonRes(putRes);
    expect(putBody.ok).toBe(true);

    // GET and verify directorProfileId on the line
    const getRes2 = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody2 = await jsonRes(getRes2);

    expect(getBody2.productionList.lines).toHaveLength(1);
    expect(getBody2.productionList.lines[0].directorProfileId).toBe(realProfileId);
  });

  it("should preserve line.directorProfileId through button execute", async () => {
    // Get current production list
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const version = getBody.productionList.version;
    const lines = getBody.productionList.lines;
    expect(lines.length).toBeGreaterThan(0);

    const line = lines[0];
    const profileId = line.directorProfileId;

    // Execute a button on this line
    const execRes = await req(app, `/api/tasks/${taskId}/agent/buttons/shorten/execute`, {
      method: "POST",
      body: JSON.stringify({ targetLineId: line.id, expectedVersion: version, parameters: {} }),
      headers: { "Content-Type": "application/json" },
    });
    const execBody = await jsonRes(execRes);
    expect(execBody.ok).toBe(true);

    // GET and verify directorProfileId is still there
    const getRes2 = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody2 = await jsonRes(getRes2);

    // After button execution, a new version is created with replacement lines.
    // The directorProfileId should be preserved through artifact merge.
    if (profileId) {
      const preservedLine = getBody2.productionList.lines.find((l: any) =>
        l.directorProfileId === profileId
      );
      expect(preservedLine).toBeDefined();
    }
  });

  it("should preserve artifact-only fields through production-list PATCH", async () => {
    const patchTaskId = await createTask("Patch artifact preservation test");
    const profileId = uuidv4();
    const lineId = uuidv4();

    const putRes = await req(app, `/api/tasks/${patchTaskId}/production-list`, {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: 0,
        lines: [
          {
            id: lineId,
            order: 0,
            speaker: "narrator",
            text: "Patch should keep artifact-only fields",
            voice: "Zephyr",
            model: "google/gemini-3.1-flash-tts-preview",
            responseFormat: "pcm",
            directorProfileId: profileId,
          },
        ],
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(putRes.status).toBe(200);

    const patchRes = await req(app, `/api/tasks/${patchTaskId}/production-list`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateLine",
        payload: { lineId, updates: { text: "Patched text only" } },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(patchRes.status).toBe(200);

    const getRes = await req(app, `/api/tasks/${patchTaskId}/production-list`);
    const getBody = await jsonRes(getRes);
    expect(getBody.productionList.version).toBe(2);
    expect(getBody.productionList.lines).toHaveLength(1);
    expect(getBody.productionList.lines[0].text).toBe("Patched text only");
    expect(getBody.productionList.lines[0].directorProfileId).toBe(profileId);
    expect(getBody.productionList.lines[0].model).toBe("google/gemini-3.1-flash-tts-preview");
    expect(getBody.productionList.lines[0].responseFormat).toBe("pcm");
  });
});
