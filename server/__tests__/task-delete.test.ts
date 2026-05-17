import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const nc = await import("node:crypto");
  const np = await import("node:path");
  const no = await import("node:os");
  const nfs = await import("node:fs");
  const tmp = np.join(no.tmpdir(), `tts-task-delete-${process.pid}-${Date.now()}`);
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
import tasksRoutes from "../src/routes/tasks.js";
import {
  agentButtonRun,
  agentChatMessage,
  agentChatSession,
  opencodeSession,
  operationAuditLog,
  productionListVersion,
  requirementDocument,
  voiceLine,
  voiceTask,
} from "../src/db/schema-extended.js";
import { artifactExists, writeArtifact } from "../src/services/artifact-store.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", tasksRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

async function jsonRes(res: Response) {
  return res.json() as Promise<any>;
}

async function createTask(app: Hono, title = "Delete Test") {
  const createRes = await req(app, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  expect(createRes.status).toBe(201);
  return (await jsonRes(createRes)).task as { id: string; title: string };
}

function rawDb() {
  return (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
}

function tableCount(tableName: string, whereClause: string, value: string): number {
  const row = rawDb().prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereClause}`).get(value) as { count: number };
  return Number(row.count);
}

describe("DELETE /api/tasks/:taskId", () => {
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

  it("deletes a task, cascaded data, manual session associations, artifact directory, and writes audit log", async () => {
    const task = await createTask(app, "Delete Success");
    const db = getDb();
    const now = new Date();
    const versionId = crypto.randomUUID();
    const chatSessionId = crypto.randomUUID();

    db.insert(requirementDocument).values({
      id: crypto.randomUUID(),
      taskId: task.id,
      fileName: "requirements.md",
      source: "paste",
      enabled: true,
      contentSha256: "sha256",
      contentSizeBytes: 12,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
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
      lineId: "line-1",
      taskId: task.id,
      versionId,
      order: 0,
      speaker: "narrator",
      text: "Line",
      voice: "Zephyr",
      style: "",
      notes: "",
      status: "pending",
      generationStatus: "succeeded",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(agentButtonRun).values({
      id: crypto.randomUUID(),
      taskId: task.id,
      buttonKey: "shorten",
      targetLineId: "line-1",
      runner: "fallback",
      status: "completed",
      createdAt: now,
      completedAt: now,
    }).run();
    db.insert(opencodeSession).values({
      id: crypto.randomUUID(),
      sessionType: "automation",
      status: "completed",
      metadataJson: "{}",
      taskId: task.id,
      createdAt: now,
      completedAt: now,
    }).run();
    db.insert(agentChatSession).values({
      id: chatSessionId,
      opencodeSessionId: null,
      taskId: task.id,
      status: "closed",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(agentChatMessage).values({
      id: crypto.randomUUID(),
      sessionId: chatSessionId,
      role: "user",
      content: "hello",
      metadataJson: "{}",
      createdAt: now,
    }).run();
    writeArtifact(task.id, "production-list.json", { lines: [] });
    expect(artifactExists(task.id, "production-list.json")).toBe(true);

    const deleteRes = await req(app, `/api/tasks/${task.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const body = await jsonRes(deleteRes);
    expect(body).toMatchObject({ ok: true, deletedTaskId: task.id, deleted: task.id, artifactCleanup: { attempted: true, deleted: true } });

    expect(db.select().from(voiceTask).all()).toHaveLength(0);
    expect(tableCount("requirement_document", "task_id = ?", task.id)).toBe(0);
    expect(tableCount("production_list_version", "task_id = ?", task.id)).toBe(0);
    expect(tableCount("voice_line", "task_id = ?", task.id)).toBe(0);
    expect(tableCount("agent_button_run", "task_id = ?", task.id)).toBe(0);
    expect(tableCount("opencode_session", "task_id = ?", task.id)).toBe(0);
    expect(tableCount("agent_chat_session", "task_id = ?", task.id)).toBe(0);
    expect(tableCount("agent_chat_message", "session_id = ?", chatSessionId)).toBe(0);
    expect(fs.existsSync(path.join(testState.tmpDir, "tasks", task.id))).toBe(false);

    const auditLogs = db.select().from(operationAuditLog).all();
    expect(auditLogs.some((entry) => entry.entityType === "task" && entry.entityId === task.id && entry.operation === "delete")).toBe(true);
    const deleteLog = auditLogs.find((entry) => entry.entityType === "task" && entry.entityId === task.id && entry.operation === "delete");
    expect(deleteLog?.snapshotJson).not.toContain(testState.tmpDir);
    expect(deleteLog?.snapshotJson).not.toContain("hello");
  });

  it("returns 404 for a nonexistent task without attempting deletion", async () => {
    const res = await req(app, "/api/tasks/00000000-0000-4000-8000-000000000000", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("TASK_NOT_FOUND");
  });

  it("returns 409 for raw running status and preserves task data and artifacts", async () => {
    const task = await createTask(app, "Running Task");
    const db = getDb();
    db.update(voiceTask).set({ status: "running", updatedAt: new Date() }).run();
    writeArtifact(task.id, "production-list.json", { lines: [] });

    const res = await req(app, `/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("TASK_DELETE_CONFLICT");
    expect(body.error.metadata.blockers).toContainEqual({ type: "task_status", status: "running" });
    expect(tableCount("voice_task", "id = ?", task.id)).toBe(1);
    expect(artifactExists(task.id, "production-list.json")).toBe(true);
  });

  it("returns 409 for raw in_progress status and preserves task data and artifacts", async () => {
    const task = await createTask(app, "In Progress Task");
    const db = getDb();
    db.update(voiceTask).set({ status: "in_progress", updatedAt: new Date() }).run();
    writeArtifact(task.id, "production-list.json", { lines: [] });

    const res = await req(app, `/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("TASK_DELETE_CONFLICT");
    expect(body.error.metadata.blockers).toContainEqual({ type: "task_status", status: "in_progress" });
    expect(tableCount("voice_task", "id = ?", task.id)).toBe(1);
    expect(artifactExists(task.id, "production-list.json")).toBe(true);
  });

  it("succeeds with artifactCleanup.deleted false when task directory does not exist", async () => {
    const task = await createTask(app, "No Artifact Task");
    const db = getDb();

    // Task has no artifact directory -- verify it doesn't exist
    expect(fs.existsSync(path.join(testState.tmpDir, "tasks", task.id))).toBe(false);

    const res = await req(app, `/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await jsonRes(res);
    expect(body).toMatchObject({ ok: true, deletedTaskId: task.id, artifactCleanup: { attempted: true, deleted: false } });
    expect(db.select().from(voiceTask).all()).toHaveLength(0);
  });

  it("returns 409 for active child work blockers and leaves associations untouched", async () => {
    const task = await createTask(app, "Blocked Task");
    const db = getDb();
    const now = new Date();
    const versionId = crypto.randomUUID();
    const chatSessionId = crypto.randomUUID();

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
      lineId: "line-running",
      taskId: task.id,
      versionId,
      order: 0,
      speaker: "narrator",
      text: "Line",
      voice: "Zephyr",
      style: "",
      notes: "",
      status: "pending",
      generationStatus: "pending",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(opencodeSession).values({
      id: crypto.randomUUID(),
      sessionType: "automation",
      status: "active",
      metadataJson: "{}",
      taskId: task.id,
      createdAt: now,
    }).run();
    db.insert(agentButtonRun).values({
      id: crypto.randomUUID(),
      taskId: task.id,
      buttonKey: "shorten",
      targetLineId: "line-running",
      runner: "fallback",
      status: "running",
      createdAt: now,
    }).run();
    db.insert(agentChatSession).values({
      id: chatSessionId,
      opencodeSessionId: null,
      taskId: task.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    writeArtifact(task.id, "production-list.json", { lines: [] });

    const res = await req(app, `/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await jsonRes(res);
    expect(body.error.code).toBe("TASK_DELETE_CONFLICT");
    expect(body.error.metadata.blockers).toEqual(expect.arrayContaining([
      { type: "voice_line_generation", status: "pending", count: 1 },
      { type: "opencode_session", status: "active", count: 1 },
      { type: "agent_button_run", status: "running", count: 1 },
      { type: "agent_chat_session", status: "active", count: 1 },
    ]));
    expect(tableCount("voice_task", "id = ?", task.id)).toBe(1);
    expect(tableCount("voice_line", "task_id = ?", task.id)).toBe(1);
    expect(tableCount("opencode_session", "task_id = ?", task.id)).toBe(1);
    expect(tableCount("agent_button_run", "task_id = ?", task.id)).toBe(1);
    expect(tableCount("agent_chat_session", "task_id = ?", task.id)).toBe(1);
    expect(artifactExists(task.id, "production-list.json")).toBe(true);
  });
});
