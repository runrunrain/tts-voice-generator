import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const nc = await import("node:crypto");
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const tmp = np.join(no.tmpdir(), `tts-history-api-${process.pid}-${Date.now()}`);
  nfs.mkdirSync(np.join(tmp, "audio"), { recursive: true });
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
import { productionListVersion, voiceLine, voiceTask } from "../src/db/schema-extended.js";
import historyRoutes from "../src/routes/history.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", historyRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

function insertJob(input: {
  id: string;
  input?: string;
  voice?: string;
  status?: string;
  directorSnapshot?: string | null;
  createdAt?: Date;
}) {
  const db = getDb();
  const inputText = input.input ?? `Assembled prompt for ${input.id}`;
  const createdAt = input.createdAt ?? new Date("2026-05-18T01:00:00.000Z");
  db.insert(generationJob).values({
    id: input.id,
    model: "google/gemini-3.1-flash-tts-preview",
    voice: input.voice ?? "Zephyr",
    responseFormat: "wav",
    input: inputText,
    inputCharCount: inputText.length,
    status: input.status ?? "succeeded",
    directorSnapshot: input.directorSnapshot ?? null,
    source: "user",
    createdAt,
    completedAt: createdAt,
  }).run();
}

function insertAsset(jobId: string, filePath: string, createdAt = new Date("2026-05-18T01:00:00.000Z")) {
  const db = getDb();
  db.insert(audioAsset).values({
    jobId,
    fileName: `${jobId}.wav`,
    filePath,
    mimeType: "audio/wav",
    sizeBytes: 24,
    duration: "1.2s",
    createdAt,
  }).run();
}

function insertTaskWithLine(input: {
  taskId: string;
  taskTitle?: string;
  lineId: string;
  relatedJobId: string;
  speaker?: string;
  text?: string;
  voice?: string;
  order?: number;
}) {
  const db = getDb();
  const createdAt = new Date("2026-05-18T00:00:00.000Z");
  const updatedAt = new Date("2026-05-18T00:30:00.000Z");
  const versionId = `${input.taskId}-version-1`;
  db.insert(voiceTask).values({
    id: input.taskId,
    title: input.taskTitle ?? "History Group Task",
    description: "",
    status: "draft",
    createdAt,
    updatedAt,
  }).run();
  db.insert(productionListVersion).values({
    id: versionId,
    taskId: input.taskId,
    version: 1,
    speakersJson: "[]",
    metadataJson: "{}",
    lineCount: 1,
    createdAt,
  }).run();
  db.insert(voiceLine).values({
    id: input.lineId,
    lineId: input.lineId,
    taskId: input.taskId,
    versionId,
    order: input.order ?? 0,
    speaker: input.speaker ?? "Narrator",
    text: input.text ?? "Production-list line transcript",
    voice: input.voice ?? "Puck",
    style: "",
    notes: "",
    status: "pending",
    generationStatus: "succeeded",
    relatedJobId: input.relatedJobId,
    createdAt,
    updatedAt,
  }).run();
}

async function getRecord(app: Hono, id: string) {
  const res = await req(app, "/api/history?page=1&pageSize=20");
  expect(res.status).toBe(200);
  const body = await res.json() as { records: Array<Record<string, unknown>> };
  const record = body.records.find((entry) => entry.id === id);
  expect(record).toBeDefined();
  return { body, record: record! };
}

async function getHistoryRecords(app: Hono, query: string) {
  const res = await req(app, `/api/history?${query}`);
  expect(res.status).toBe(200);
  return await res.json() as { records: Array<Record<string, unknown>>; totalRecords: number };
}

describe("GET /api/history task grouping metadata", () => {
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

  it("returns task and voice-line preview metadata for production-list generated jobs", async () => {
    insertJob({ id: "job-linked", input: "Assembled prompt should not be the primary preview", voice: "Zephyr" });
    insertAsset("job-linked", "2026/05/18/job-linked.wav");
    insertTaskWithLine({
      taskId: "task-linked",
      taskTitle: "Launch Narration",
      lineId: "line-linked",
      relatedJobId: "job-linked",
      speaker: "Hero",
      text: "We launch at dawn.",
      voice: "Puck",
      order: 7,
    });

    const { record } = await getRecord(app, "job-linked");

    expect(record).toMatchObject({
      taskId: "task-linked",
      taskTitle: "Launch Narration",
      taskName: "Launch Narration",
      taskGroupId: "task:task-linked",
      taskGroupKind: "task",
      taskDisplayTitle: "Launch Narration",
      voiceLineId: "line-linked",
      voiceLineOrder: 7,
      lineSpeaker: "Hero",
      lineText: "We launch at dawn.",
      lineVoice: "Puck",
      previewSpeaker: "Hero",
      previewText: "We launch at dawn.",
      previewSource: "voice_line",
      audioUrl: "/api/audio/1",
      downloadUrl: "/api/audio/1?download=1",
    });
    expect(record.taskCreatedAt).toBe("2026-05-18T00:00:00.000Z");
    expect(record.taskUpdatedAt).toBe("2026-05-18T00:30:00.000Z");
  });

  it("falls back to directorSnapshot transcript when voice-line text is missing", async () => {
    insertJob({
      id: "job-snapshot-fallback",
      input: "Audio Profile: Warm\nSpeaker A: Hidden assembled prompt",
      directorSnapshot: JSON.stringify({
        transcript: "Original director transcript",
        speakers: [{ id: "speaker-a", label: "Speaker A", name: "Host", voice: "Zephyr" }],
      }),
    });
    insertTaskWithLine({
      taskId: "task-snapshot",
      lineId: "line-snapshot",
      relatedJobId: "job-snapshot-fallback",
      speaker: "",
      text: "",
    });

    const { record } = await getRecord(app, "job-snapshot-fallback");

    expect(record).toMatchObject({
      lineText: null,
      speakerLabel: "Speaker A",
      speakerName: "Host",
      speakerVoice: "Zephyr",
      transcript: "Original director transcript",
      previewSpeaker: "Host",
      previewText: "Original director transcript",
      previewSource: "director_snapshot",
    });
  });

  it("keeps orphan jobs under synthetic no-task metadata", async () => {
    insertJob({ id: "job-orphan", input: "Standalone generation transcript", voice: "Orus" });

    const { record } = await getRecord(app, "job-orphan");

    expect(record).toMatchObject({
      taskId: null,
      taskTitle: null,
      taskName: null,
      taskCreatedAt: null,
      taskUpdatedAt: null,
      taskGroupId: "orphan",
      taskGroupKind: "orphan",
      taskDisplayTitle: "独立生成",
      voiceLineId: null,
      lineSpeaker: null,
      lineText: null,
      transcript: null,
      previewSpeaker: "Orus",
      previewText: "Standalone generation transcript",
      previewSource: "job_input",
    });
  });

  it("does not leak local audio paths in history responses", async () => {
    const privatePath = path.join(os.tmpdir(), "private-audio-root", "job-private.wav");
    insertJob({ id: "job-private-path", input: "Path safety check" });
    insertAsset("job-private-path", privatePath);

    const { body, record } = await getRecord(app, "job-private-path");
    const serialized = JSON.stringify(body);

    expect(record).toMatchObject({
      assetId: 1,
      audioUrl: "/api/audio/1",
      downloadUrl: "/api/audio/1?download=1",
    });
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain("private-audio-root");
  });

  it("accepts the UI success status alias while preserving successful records", async () => {
    insertJob({ id: "job-success-alias", status: "succeeded" });
    insertJob({ id: "job-success-excluded", status: "failed" });

    const body = await getHistoryRecords(app, "page=1&pageSize=20&status=success");
    const ids = body.records.map((entry) => entry.id);

    expect(body.totalRecords).toBe(1);
    expect(ids).toEqual(["job-success-alias"]);
  });

  it("keeps the raw succeeded status filter backward compatible", async () => {
    insertJob({ id: "job-raw-succeeded", status: "succeeded" });
    insertJob({ id: "job-raw-succeeded-excluded", status: "failed" });

    const body = await getHistoryRecords(app, "page=1&pageSize=20&status=succeeded");
    const ids = body.records.map((entry) => entry.id);

    expect(body.totalRecords).toBe(1);
    expect(ids).toEqual(["job-raw-succeeded"]);
  });

  it("accepts the UI error status alias for failed and cancelled jobs", async () => {
    insertJob({ id: "job-error-failed", status: "failed", createdAt: new Date("2026-05-18T01:02:00.000Z") });
    insertJob({ id: "job-error-cancelled", status: "cancelled", createdAt: new Date("2026-05-18T01:01:00.000Z") });
    insertJob({ id: "job-error-excluded", status: "succeeded", createdAt: new Date("2026-05-18T01:00:00.000Z") });

    const body = await getHistoryRecords(app, "page=1&pageSize=20&status=error");
    const ids = body.records.map((entry) => entry.id);

    expect(body.totalRecords).toBe(2);
    expect(ids).toEqual(["job-error-failed", "job-error-cancelled"]);
  });

  it("accepts the UI pending status alias for pending and running jobs", async () => {
    insertJob({ id: "job-pending-running", status: "running", createdAt: new Date("2026-05-18T01:02:00.000Z") });
    insertJob({ id: "job-pending-pending", status: "pending", createdAt: new Date("2026-05-18T01:01:00.000Z") });
    insertJob({ id: "job-pending-excluded", status: "succeeded", createdAt: new Date("2026-05-18T01:00:00.000Z") });

    const body = await getHistoryRecords(app, "page=1&pageSize=20&status=pending");
    const ids = body.records.map((entry) => entry.id);

    expect(body.totalRecords).toBe(2);
    expect(ids).toEqual(["job-pending-running", "job-pending-pending"]);
  });
});
