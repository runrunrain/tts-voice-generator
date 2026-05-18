/**
 * Regression tests: Director Profile binding synchronizes line voice
 *
 * Bug: updateDirectorProfile patch only wrote directorProfileId/promptProfileId
 * but did NOT sync the primary speaker voice from the director profile to line.voice.
 *
 * Fix: applyPatch("updateDirectorProfile", ...) now resolves the primary speaker
 * voice from (1) artifact profiles, (2) DB director_profile, and writes it to
 * line.voice when available.
 *
 * Tests prove:
 * 1. Binding a profile with a valid speaker[0].voice syncs line.voice.
 * 2. Missing profile / no voice / empty voice keeps original line.voice (safe fallback).
 * 3. Unbinding (directorProfileId=null) does NOT modify line.voice.
 * 4. Multiple lines can be bound in a single patch with voice synced.
 * 5. Line not in targetIds is unaffected.
 * 6. DB fallback works when artifact profiles lack the target profile.
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
  const tmp = np.join(no.tmpdir(), `tts-voice-sync-${process.pid}-${Date.now()}`);
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

import { closeDb, initSchema, getDb } from "../src/db/index.js";
import { directorProfile as dpTable } from "../src/db/schema-extended.js";
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
import { applyPatch } from "../src/routes/production-list-modules/patch.js";

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

async function setupProductionList(app: Hono, lines?: Array<Record<string, unknown>>): Promise<{ taskId: string; lineIds: string[]; version: number }> {
  const createRes = await req(app, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Voice Sync Regression Test" }),
  });
  const { task } = await jsonRes(createRes);
  const taskId = task.id;

  const defaultLines = lines ?? [
    { id: "line_1", order: 0, speaker: "narrator", text: "First line", voice: "Zephyr" },
    { id: "line_2", order: 1, speaker: "narrator", text: "Second line", voice: "Zephyr" },
    { id: "line_3", order: 2, speaker: "narrator", text: "Third line", voice: "Charon" },
  ];
  const speakers = [{ id: "narrator", label: "Narrator", voice: "Zephyr" }];

  const putRes = await req(app, `/api/tasks/${taskId}/production-list`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: 0, lines: defaultLines, speakers }),
  });
  expect(putRes.status).toBe(200);
  const putBody = await jsonRes(putRes);
  return {
    taskId,
    lineIds: putBody.productionList.lines.map((l: any) => l.id),
    version: putBody.productionList.version,
  };
}

async function createDirectorProfileInDB(profileId: string, speakers: Array<{ voice: string }>): Promise<void> {
  const db = getDb();
  const config = JSON.stringify({ speakers });
  // Use INSERT OR REPLACE to handle idempotent seeding
  db.insert(dpTable)
    .values({ id: profileId, name: `test-profile-${profileId}`, description: "", config })
    .onConflictDoUpdate({ target: dpTable.id, set: { config, name: `test-profile-${profileId}` } })
    .run();
}

// ─── applyPatch unit tests (no HTTP, no DB) ──────────────────────────────────

describe("applyPatch updateDirectorProfile: voice sync logic", () => {
  it("syncs voice from artifact profile speakers[0].voice", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
      { id: "l2", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-1", speakers: [{ label: "Alice", voice: "Puck" }] },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-1", lineIds: ["l1"] },
      lines,
      [],
      artifactProfiles,
    );

    // Assert
    const target = result.lines.find((l) => l.id === "l1");
    const other = result.lines.find((l) => l.id === "l2");
    expect(target.voice).toBe("Puck");
    expect(target.directorProfileId).toBe("dp-1");
    expect(target.promptProfileId).toBe("dp-1");
    expect(other.voice).toBe("Zephyr");
  });

  it("syncs voice from artifact profile config.speakers[0].voice when speakers is nested in config", () => {
    // Arrange: some profiles store speakers inside config
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-nested", config: JSON.stringify({ speakers: [{ label: "Bob", voice: "Kore" }] }) },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-nested" },
      lines,
      [],
      artifactProfiles,
    );

    // Assert
    expect(result.lines[0].voice).toBe("Kore");
  });

  it("does NOT modify voice when profile has empty speakers array", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-empty-speakers", speakers: [] },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-empty-speakers" },
      lines,
      [],
      artifactProfiles,
    );

    // Assert
    expect(result.lines[0].voice).toBe("Zephyr");
    expect(result.lines[0].directorProfileId).toBe("dp-empty-speakers");
  });

  it("does NOT modify voice when speakers[0].voice is empty string", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-blank-voice", speakers: [{ label: "Alice", voice: "  " }] },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-blank-voice" },
      lines,
      [],
      artifactProfiles,
    );

    // Assert
    expect(result.lines[0].voice).toBe("Zephyr");
  });

  it("does NOT modify voice when speakers[0] has no voice field", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-no-voice-field", speakers: [{ label: "Alice" }] },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-no-voice-field" },
      lines,
      [],
      artifactProfiles,
    );

    // Assert
    expect(result.lines[0].voice).toBe("Zephyr");
  });

  it("does NOT modify voice when unbinding (directorProfileId is null)", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Puck", directorProfileId: "dp-old", promptProfileId: "dp-old" },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: null },
      lines,
      [],
      [],
    );

    // Assert
    expect(result.lines[0].voice).toBe("Puck");
    expect(result.lines[0].directorProfileId).toBeNull();
    expect(result.lines[0].promptProfileId).toBeNull();
  });

  it("does NOT modify voice when unbinding with undefined directorProfileId", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Charon", directorProfileId: "dp-old", promptProfileId: "dp-old" },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: undefined },
      lines,
      [],
      [],
    );

    // Assert
    expect(result.lines[0].voice).toBe("Charon");
    expect(result.lines[0].directorProfileId).toBeNull();
  });

  it("syncs voice to ALL lines when lineIds is omitted", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
      { id: "l2", voice: "Puck", directorProfileId: null, promptProfileId: null },
      { id: "l3", voice: "Charon", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-unify", speakers: [{ label: "Alice", voice: "Kore" }] },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-unify" },
      lines,
      [],
      artifactProfiles,
    );

    // Assert: all lines synced to Kore
    for (const line of result.lines) {
      expect(line.voice).toBe("Kore");
      expect(line.directorProfileId).toBe("dp-unify");
    }
  });

  it("syncs voice only to specified lineIds", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
      { id: "l2", voice: "Puck", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-target", speakers: [{ label: "Alice", voice: "Charon" }] },
    ];

    // Act
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-target", lineIds: ["l1"] },
      lines,
      [],
      artifactProfiles,
    );

    // Assert
    const l1 = result.lines.find((l) => l.id === "l1");
    const l2 = result.lines.find((l) => l.id === "l2");
    expect(l1.voice).toBe("Charon");
    expect(l1.directorProfileId).toBe("dp-target");
    expect(l2.voice).toBe("Puck");
    expect(l2.directorProfileId).toBeNull();
  });

  it("keeps safe fallback when artifact profiles is empty array and no DB profile", () => {
    // Arrange: no artifact profiles, and getDb() will fail or return nothing
    // because we aren't in an integration test context here.
    // applyPatch should gracefully handle DB lookup failure.
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
    ];

    // Act: directorProfileId is a fake ID, no profiles provided
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-nonexistent" },
      lines,
      [],
      [],
    );

    // Assert: voice unchanged, profile ids set
    expect(result.lines[0].voice).toBe("Zephyr");
    expect(result.lines[0].directorProfileId).toBe("dp-nonexistent");
  });

  it("keeps safe fallback when profile not found in artifact profiles", () => {
    // Arrange
    const lines = [
      { id: "l1", voice: "Zephyr", directorProfileId: null, promptProfileId: null },
    ];
    const artifactProfiles = [
      { id: "dp-other", speakers: [{ label: "Alice", voice: "Puck" }] },
    ];

    // Act: requesting dp-missing which is not in artifact profiles
    const result = applyPatch(
      "updateDirectorProfile",
      { directorProfileId: "dp-missing" },
      lines,
      [],
      artifactProfiles,
    );

    // Assert: voice unchanged
    expect(result.lines[0].voice).toBe("Zephyr");
    expect(result.lines[0].directorProfileId).toBe("dp-missing");
  });
});

// ─── Integration tests via HTTP ──────────────────────────────────────────────

describe("PATCH updateDirectorProfile: voice sync via HTTP (integration)", () => {
  let app: Hono;
  let taskId: string;
  let lineIds: string[];
  let version: number;

  beforeEach(async () => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    _setSpawnRunner(async () => {
      throw new Error("opencode run not available in test environment");
    });
    app = createApp();
    const setup = await setupProductionList(app, [
      { id: "line_1", order: 0, speaker: "narrator", text: "First line", voice: "Zephyr" },
      { id: "line_2", order: 1, speaker: "narrator", text: "Second line", voice: "Puck" },
    ]);
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

  it("keeps original voice when binding to a nonexistent profile (no DB profile, no artifact profile)", async () => {
    // Arrange: line_1 has voice=Zephyr, bind to dp-nonexistent

    // Act
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-nonexistent", lineIds: [lineIds[0]] },
        expectedVersion: version,
      }),
    });

    // Assert
    expect(patchRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const targetLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
    expect(targetLine.directorProfileId).toBe("dp-nonexistent");
    expect(targetLine.voice).toBe("Zephyr");
  });

  it("syncs voice from DB director profile when no artifact profile exists", async () => {
    // Arrange: seed a DB director profile with speakers[0].voice=Kore
    await createDirectorProfileInDB("dp-kore-profile", [{ voice: "Kore" }]);

    // Act: bind line_1 (voice=Zephyr) to dp-kore-profile
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-kore-profile", lineIds: [lineIds[0]] },
        expectedVersion: version,
      }),
    });

    // Assert
    expect(patchRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const targetLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
    const otherLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[1]);
    expect(targetLine.voice).toBe("Kore");
    expect(targetLine.directorProfileId).toBe("dp-kore-profile");
    expect(otherLine.voice).toBe("Puck");
    expect(otherLine.directorProfileId).toBeFalsy();
  });

  it("does NOT change voice when unbinding (null directorProfileId)", async () => {
    // Arrange: first bind to a profile that sets voice
    await createDirectorProfileInDB("dp-unbind-test", [{ voice: "Kore" }]);
    await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-unbind-test", lineIds: [lineIds[0]] },
        expectedVersion: version,
      }),
    });

    // Act: unbind
    const unbindRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: null, lineIds: [lineIds[0]] },
        expectedVersion: version + 1,
      }),
    });

    // Assert: voice stays at Kore, profile cleared
    expect(unbindRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const targetLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
    expect(targetLine.voice).toBe("Kore");
    expect(targetLine.directorProfileId).toBeFalsy();
  });

  it("syncs voice to all lines when lineIds is omitted", async () => {
    // Arrange
    await createDirectorProfileInDB("dp-bulk-voice", [{ voice: "Charon" }]);

    // Act
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-bulk-voice" },
        expectedVersion: version,
      }),
    });

    // Assert: all lines now have voice=Charon
    expect(patchRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    for (const line of getBody.productionList.lines) {
      expect(line.voice).toBe("Charon");
      expect(line.directorProfileId).toBe("dp-bulk-voice");
    }
  });

  it("keeps voice when DB profile has no speakers", async () => {
    // Arrange: DB profile with empty speakers
    await createDirectorProfileInDB("dp-no-speakers", []);

    // Act
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-no-speakers", lineIds: [lineIds[0]] },
        expectedVersion: version,
      }),
    });

    // Assert
    expect(patchRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const targetLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
    expect(targetLine.voice).toBe("Zephyr");
    expect(targetLine.directorProfileId).toBe("dp-no-speakers");
  });

  it("keeps voice when DB profile speaker has empty voice string", async () => {
    // Arrange: DB profile with speaker that has empty voice
    await createDirectorProfileInDB("dp-empty-voice", [{ voice: "" }]);

    // Act
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-empty-voice", lineIds: [lineIds[0]] },
        expectedVersion: version,
      }),
    });

    // Assert
    expect(patchRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const targetLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
    expect(targetLine.voice).toBe("Zephyr");
    expect(targetLine.directorProfileId).toBe("dp-empty-voice");
  });

  it("does not crash when DB profile config is malformed JSON", async () => {
    // Arrange: insert a profile with invalid JSON config
    const db = getDb();
    db.insert(dpTable)
      .values({ id: "dp-bad-json", name: "bad-json-profile", description: "", config: "not-valid-json{{{" })
      .onConflictDoUpdate({ target: dpTable.id, set: { config: "not-valid-json{{{" } })
      .run();

    // Act
    const patchRes = await req(app, `/api/tasks/${taskId}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "updateDirectorProfile",
        payload: { directorProfileId: "dp-bad-json", lineIds: [lineIds[0]] },
        expectedVersion: version,
      }),
    });

    // Assert: should succeed with original voice preserved
    expect(patchRes.status).toBe(200);
    const getRes = await req(app, `/api/tasks/${taskId}/production-list`);
    const getBody = await jsonRes(getRes);
    const targetLine = getBody.productionList.lines.find((l: any) => l.id === lineIds[0]);
    expect(targetLine.voice).toBe("Zephyr");
    expect(targetLine.directorProfileId).toBe("dp-bad-json");
  });
});
