import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const nc = await import("node:crypto");
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const tmp = np.join(no.tmpdir(), `tts-audio-history-${process.pid}-${Date.now()}`);
  nfs.mkdirSync(np.join(tmp, "audio"), { recursive: true });
  nfs.mkdirSync(np.join(tmp, "tasks"), { recursive: true });
  const testDbPath = np.join(tmp, "test.db");
  testState.tmpDir = tmp;
  testState.dbFilePath = testDbPath;
  const SALT = "tts-voice-generator-key-encryption-v1";
  const ALGO = "aes-256-gcm";
  function key(): Buffer { return nc.scryptSync(testDbPath, SALT, 32); }
  function encryptApiKey(value: string): string {
    const iv = nc.randomBytes(16);
    const cipher = nc.createCipheriv(ALGO, key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }
  function decryptApiKey(ciphertext: string): string | null {
    try {
      const raw = Buffer.from(ciphertext, "base64");
      const decipher = nc.createDecipheriv(ALGO, key(), raw.subarray(0, 16));
      decipher.setAuthTag(raw.subarray(16, 32));
      return decipher.update(raw.subarray(32)) + decipher.final("utf8");
    } catch {
      return null;
    }
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
    maskApiKey: (value: string) => value.length > 12 ? `${value.slice(0, 3)}***...***${value.slice(-4)}` : "***configured***",
    isEnvApiKeyConfigured: () => false,
    requireEnvApiKey: () => { throw new Error("Not configured"); },
  };
});

import { closeDb, getDb, initSchema } from "../src/db/index.js";
import { audioAsset, generationJob } from "../src/db/schema.js";
import { productionListVersion, voiceLine } from "../src/db/schema-extended.js";
import tasksRoutes from "../src/routes/tasks.js";
import productionListRoutes from "../src/routes/production-list.js";
import {
  productionListArtifactName,
  productionListVersionArtifactName,
  readArtifact,
  writeArtifact,
} from "../src/services/artifact-store.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", tasksRoutes);
  app.route("/", productionListRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

async function jsonRes(res: Response) {
  return res.json() as Promise<any>;
}

async function createTask(app: Hono, title = "Audio History Test") {
  const res = await req(app, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return (await jsonRes(res)).task as { id: string };
}

async function putProductionList(app: Hono, taskId: string, expectedVersion: number, lines: Array<Record<string, unknown>>) {
  const res = await req(app, `/api/tasks/${taskId}/production-list`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedVersion,
      lines: lines.map((line, index) => ({
        id: line.id ?? `line-${index}`,
        order: index,
        speaker: "narrator",
        text: "Line text",
        voice: "Zephyr",
        generationStatus: "draft",
        ...line,
      })),
      speakers: [],
    }),
  });
  expect(res.status).toBe(200);
  return jsonRes(res);
}

function insertAudioAsset(jobId: string, filePath: string, createdAt: Date) {
  const db = getDb();
  db.insert(generationJob).values({
    id: jobId,
    model: "google/gemini-3.1-flash-tts-preview",
    voice: "Zephyr",
    responseFormat: "wav",
    input: "Line text",
    inputCharCount: 9,
    status: "succeeded",
    source: "user",
    createdAt,
    completedAt: createdAt,
  }).run();
  db.insert(audioAsset).values({
    jobId,
    fileName: `${jobId}.wav`,
    filePath,
    mimeType: "audio/wav",
    sizeBytes: 12,
    duration: "1.0s",
    createdAt,
  }).run();
  const asset = db.select().from(audioAsset).where(eq(audioAsset.jobId, jobId)).get();
  expect(asset).toBeTruthy();
  return asset!;
}

describe("production-list line audio history", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (testState.dbFilePath && fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("returns versioned audio history with only safe playback and download URLs", async () => {
    const task = await createTask(app);
    const assetOne = insertAudioAsset("job-history-1", "2026/05/18/job-history-1.wav", new Date("2026-05-18T01:00:00.000Z"));
    const assetTwo = insertAudioAsset("job-history-2", path.join(os.tmpdir(), "private-audio", "job-history-2.wav"), new Date("2026-05-18T02:00:00.000Z"));

    await putProductionList(app, task.id, 0, [{
      id: "line-1",
      relatedJobId: "job-history-1",
      relatedAssetId: assetOne.id,
      generationStatus: "succeeded",
    }]);
    await putProductionList(app, task.id, 1, [{
      id: "line-1",
      voice: "Puck",
      relatedJobId: "job-history-2",
      relatedAssetId: assetTwo.id,
      generationStatus: "succeeded",
    }]);

    const res = await req(app, `/api/tasks/${task.id}/production-list/lines/line-1/audio-history`);
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body).toMatchObject({ ok: true, taskId: task.id, lineId: "line-1" });
    expect(body.history).toHaveLength(2);
    expect(body.history.map((entry: any) => entry.version)).toEqual([2, 1]);
    expect(body.history[0]).toMatchObject({
      relatedJobId: "job-history-2",
      relatedAssetId: assetTwo.id,
      audioUrl: `/api/audio/${assetTwo.id}`,
      downloadUrl: `/api/audio/${assetTwo.id}?download=1`,
      isCurrent: true,
    });
    expect(body.history[1]).toMatchObject({
      relatedJobId: "job-history-1",
      relatedAssetId: assetOne.id,
      audioUrl: `/api/audio/${assetOne.id}`,
      downloadUrl: `/api/audio/${assetOne.id}?download=1`,
      isCurrent: false,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain(testState.tmpDir);
    expect(serialized).not.toContain("private-audio");
  });

  it("returns an empty history for lines without historical audio", async () => {
    const task = await createTask(app);
    await putProductionList(app, task.id, 0, [{ id: "line-empty", generationStatus: "draft" }]);

    const res = await req(app, `/api/tasks/${task.id}/production-list/lines/line-empty/audio-history`);
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.ok).toBe(true);
    expect(body.history).toEqual([]);
  });

  it("returns TASK_NOT_FOUND for missing tasks", async () => {
    const missingTaskId = crypto.randomUUID();
    const res = await req(app, `/api/tasks/${missingTaskId}/production-list/lines/line-1/audio-history`);
    expect(res.status).toBe(404);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("TASK_NOT_FOUND");
  });

  it("keeps history entries path-safe when an artifact references a missing asset", async () => {
    const task = await createTask(app);
    await putProductionList(app, task.id, 0, [{
      id: "line-missing-asset",
      relatedJobId: "missing-job",
      relatedAssetId: 987654,
      generationStatus: "succeeded",
    }]);

    const res = await req(app, `/api/tasks/${task.id}/production-list/lines/line-missing-asset/audio-history`);
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.history).toHaveLength(1);
    expect(body.history[0]).toMatchObject({
      relatedJobId: "missing-job",
      relatedAssetId: 987654,
      audioUrl: null,
      downloadUrl: null,
    });
    expect(JSON.stringify(body)).not.toContain("filePath");
  });

  it("preserves artifact-only display fields when director binding is patched after id fallback matching", async () => {
    const task = await createTask(app);
    const db = getDb();
    const versionId = crypto.randomUUID();
    const now = new Date("2026-05-18T03:00:00.000Z");
    db.insert(productionListVersion).values({
      id: versionId,
      taskId: task.id,
      version: 1,
      speakersJson: "[]",
      metadataJson: "{}",
      lineCount: 1,
      createdAt: now,
    }).run();
    db.insert(voiceLine).values({
      id: crypto.randomUUID(),
      lineId: "stable-line",
      taskId: task.id,
      versionId,
      order: 0,
      speaker: "narrator",
      text: "Stable transcript",
      voice: "Zephyr",
      style: "",
      notes: "",
      status: "pending",
      generationStatus: "draft",
      createdAt: now,
      updatedAt: now,
    }).run();
    const artifact = {
      version: 1,
      versionId,
      lines: [{
        id: "legacy-artifact-id",
        order: 0,
        moduleName: "Long Module",
        title: "Long Title",
        speaker: "narrator",
        speakerLabel: "Narrator Role",
        text: "Stable transcript",
        transcript: "Stable transcript",
        voice: "Zephyr",
        style: "",
        notes: "",
        status: "pending",
        model: "google/gemini-3.1-flash-tts-preview",
        responseFormat: "wav",
        generationStatus: "draft",
      }],
      speakers: [],
      metadata: {},
      updatedAt: now.toISOString(),
    };
    writeArtifact(task.id, productionListArtifactName(), artifact);
    writeArtifact(task.id, productionListVersionArtifactName(1), artifact);

    const res = await req(app, `/api/tasks/${task.id}/production-list`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        op: "updateDirectorProfile",
        payload: { lineIds: ["stable-line"], directorProfileId: "director-copy" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body.productionList.lines[0]).toMatchObject({
      id: "stable-line",
      moduleName: "Long Module",
      title: "Long Title",
      speakerLabel: "Narrator Role",
      directorProfileId: "director-copy",
      promptProfileId: "director-copy",
    });
    const currentArtifact = readArtifact<{ lines?: Array<Record<string, unknown>> }>(task.id, productionListArtifactName());
    expect(currentArtifact?.lines?.[0]).toMatchObject({
      id: "stable-line",
      moduleName: "Long Module",
      title: "Long Title",
      speakerLabel: "Narrator Role",
      directorProfileId: "director-copy",
      promptProfileId: "director-copy",
    });
  });
});
