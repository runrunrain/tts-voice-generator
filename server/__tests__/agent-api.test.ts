import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");
  const tmp = nodePath.join(nodeOs.tmpdir(), `tts-agent-${process.pid}-${Date.now()}`);
  nodeFs.mkdirSync(nodePath.join(tmp, "audio"), { recursive: true });
  const testDbPath = nodePath.join(tmp, "test.db");
  testState.tmpDir = tmp;
  testState.dbFilePath = testDbPath;
  const SALT = "tts-voice-generator-key-encryption-v1";
  const ALGO = "aes-256-gcm";
  function key(): Buffer { return crypto.scryptSync(testDbPath, SALT, 32); }
  function encryptApiKey(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv(ALGO, key(), iv);
    const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  }
  function decryptApiKey(ct: string): string | null {
    try {
      const raw = Buffer.from(ct, "base64");
      const d = crypto.createDecipheriv(ALGO, key(), raw.subarray(0, 16));
      d.setAuthTag(raw.subarray(16, 32));
      return d.update(raw.subarray(32)) + d.final("utf8");
    } catch { return null; }
  }
  return {
    env: {
      port: 3001,
      openRouterApiKey: null as string | null,
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
      audioOutputDir: nodePath.join(tmp, "audio"),
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

import { closeDb, getDb, initSchema } from "../src/db/index.js";
import { agentActionLog, agentSession, generationJob, settings } from "../src/db/schema.js";
import settingsRoutes from "../src/routes/settings.js";
import ttsRoutes from "../src/routes/tts.js";
import agentRoutes from "../src/routes/agent.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", settingsRoutes);
  app.route("/", ttsRoutes);
  app.route("/", agentRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

function agentBody(input = "Hello from agent") {
  return { conversationId: "conv-1", model: "google/gemini-3.1-flash-tts-preview", input, voice: "Zephyr", responseFormat: "wav" };
}

async function putSettings(app: Hono, body: Record<string, unknown>) {
  return req(app, "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function rotateToken(app: Hono) {
  const res = await putSettings(app, { localPluginTokenAction: "rotate" });
  const body = await res.json();
  return body.localPluginToken as string;
}

function auth(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

describe("Agent controlled API", () => {
  let app: Hono;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    app = createApp();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    await putSettings(app, { openRouterApiKey: "sk-test-api-key-12345678" });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("rotates token without returning hash or storing plaintext, invalidates old token, and clear disables auth", async () => {
    const token1 = await rotateToken(app);
    expect(token1).toMatch(/^lpt_/);
    const get1 = await req(app, "/api/settings");
    const body1 = await get1.json();
    expect(JSON.stringify(body1)).not.toContain(token1);
    expect(body1.hasLocalPluginToken).toBe(true);
    expect(body1.agent.fingerprint).toMatch(/^sha256:/);
    const row1 = getDb().select().from(settings).where(eq(settings.id, 1)).get()!;
    expect(row1.localPluginToken).not.toBe(token1);

    const token2 = await rotateToken(app);
    expect(token2).not.toBe(token1);
    const oldRes = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token1), body: JSON.stringify(agentBody()) });
    expect(oldRes.status).toBe(401);

    await putSettings(app, { localPluginTokenAction: "clear" });
    const clearRes = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token2), body: JSON.stringify(agentBody()) });
    expect(clearRes.status).toBe(401);
  });

  it("validates and persists agent settings fields", async () => {
    const bad = await putSettings(app, { agentAuthMode: "bad" });
    expect(bad.status).toBe(400);
    await putSettings(app, { agent: { authMode: "session_auto", maxRequests: 2, maxChars: 50, maxCost: 0.5, sessionExpiry: 120 } });
    const res = await req(app, "/api/settings");
    const body = await res.json();
    expect(body.agent.authMode).toBe("session_auto");
    expect(body.agent.maxRequests).toBe(2);
    expect(body.agent.maxChars).toBe(50);
    expect(body.agent.maxCost).toBe(0.5);
    expect(body.agent.sessionExpiry).toBe(120);
  });

  it("confirm_each returns pending, approve executes, and reject does not create a job", async () => {
    const token = await rotateToken(app);
    const pending = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody()) });
    expect(pending.status).toBe(202);
    const pendingBody = await pending.json();
    expect(pendingBody.status).toBe("approval_required");

    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/pcm", "x-generation-id": "gen-agent-approved" } }));
    const approved = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pendingBody.actionLogId, conversationId: "conv-1", decision: "approve", scope: "once" }) });
    const approvedBody = await approved.json();
    expect(approvedBody.status).toBe("succeeded");
    const job = getDb().select().from(generationJob).where(eq(generationJob.id, approvedBody.jobId)).get()!;
    expect(job.source).toBe("agent");
    expect(job.agentConversationId).toBe("conv-1");
    expect(job.agentActionLogId).toBe(pendingBody.actionLogId);

    const pending2 = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("Reject me")) });
    const pending2Body = await pending2.json();
    const beforeJobs = getDb().select().from(generationJob).all().length;
    const rejected = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pending2Body.actionLogId, conversationId: "conv-1", decision: "reject" }) });
    expect(rejected.status).toBe(200);
    const rejectedLog = getDb().select().from(agentActionLog).where(eq(agentActionLog.id, pending2Body.actionLogId)).get()!;
    expect(rejectedLog.approvalStatus).toBe("rejected");
    expect(rejectedLog.approvedAt).toBeNull();
    expect(getDb().select().from(generationJob).all().length).toBe(beforeJobs);
  });

  it("confirm_each rejects session scope and ignores an existing active session", async () => {
    const token = await rotateToken(app);
    getDb().insert(agentSession).values({
      id: "existing-session",
      conversationId: "conv-1",
      status: "active",
      maxRequests: 10,
      usedRequests: 0,
      maxChars: 1000,
      usedChars: 0,
      maxCost: 1,
      usedCost: 0,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    const pending = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("confirm each ignores session")) });
    expect(pending.status).toBe(202);
    const pendingBody = await pending.json();
    expect(pendingBody.status).toBe("approval_required");
    expect(pendingBody.approval.allowedScopes).toEqual(["once"]);
    const log = getDb().select().from(agentActionLog).where(eq(agentActionLog.id, pendingBody.actionLogId)).get()!;
    expect(log.sessionId).toBeNull();
    expect(log.approvalStatus).toBe("pending");

    const scoped = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pendingBody.actionLogId, conversationId: "conv-1", decision: "approve", scope: "session" }) });
    expect(scoped.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects approve-action when conversationId does not match", async () => {
    const token = await rotateToken(app);
    const pending = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("conversation guard")) });
    const pendingBody = await pending.json();

    const mismatched = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pendingBody.actionLogId, conversationId: "other-conv", decision: "approve", scope: "once" }) });
    expect(mismatched.status).toBe(409);
    expect((await mismatched.json()).error.code).toBe("CONVERSATION_MISMATCH");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("only one duplicate approve can execute the same pending action", async () => {
    const token = await rotateToken(app);
    const pending = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("duplicate approve")) });
    const pendingBody = await pending.json();
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/pcm" } }));

    const first = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pendingBody.actionLogId, conversationId: "conv-1", decision: "approve", scope: "once" }) });
    const second = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pendingBody.actionLogId, conversationId: "conv-1", decision: "approve", scope: "once" }) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("ACTION_ALREADY_DECIDED");
    expect(getDb().select().from(generationJob).all()).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("session_auto creates a session, auto-executes subsequent requests, and stops at budget", async () => {
    const token = await rotateToken(app);
    await putSettings(app, { agent: { authMode: "session_auto", maxRequests: 2, maxChars: 100, maxCost: 1, sessionExpiry: 300 } });
    const pending = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("first")) });
    const pendingBody = await pending.json();
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/pcm" } }));
    const approved = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pendingBody.actionLogId, conversationId: "conv-1", decision: "approve", scope: "session" }) });
    const approvedBody = await approved.json();
    expect(approvedBody.status).toBe("succeeded");
    expect(approvedBody.sessionId).toBeTruthy();
    expect(getDb().select().from(agentSession).all()).toHaveLength(1);

    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([3, 4]), { status: 200, headers: { "content-type": "audio/pcm" } }));
    const auto = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("second")) });
    expect(auto.status).toBe(200);
    const autoBody = await auto.json();
    expect(autoBody.status).toBe("succeeded");
    expect(autoBody.sessionId).toBe(approvedBody.sessionId);
    const exhausted = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("third")) });
    expect(exhausted.status).toBe(202);
  });

  it("session budget exhaustion does not call upstream fetch", async () => {
    const token = await rotateToken(app);
    await putSettings(app, { agent: { authMode: "session_auto", maxRequests: 1, maxChars: 100, maxCost: 1, sessionExpiry: 300 } });
    const pending = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("first")) });
    const pendingBody = await pending.json();
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/pcm" } }));
    const approved = await req(app, "/api/agent/approve-action", { method: "POST", headers: auth(token), body: JSON.stringify({ actionLogId: pendingBody.actionLogId, conversationId: "conv-1", decision: "approve", scope: "session" }) });
    expect(approved.status).toBe(200);

    const autoPending = await req(app, "/api/agent/generate-speech", { method: "POST", headers: auth(token), body: JSON.stringify(agentBody("second")) });
    expect(autoPending.status).toBe(202);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("regular /api/tts/generate remains source=user", async () => {
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/pcm" } }));
    const res = await req(app, "/api/tts/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "google/gemini-3.1-flash-tts-preview", input: "user path", voice: "Zephyr", responseFormat: "wav" }) });
    const body = await res.json();
    const job = getDb().select().from(generationJob).where(eq(generationJob.id, body.jobId)).get()!;
    expect(job.source).toBe("user");
    expect(job.agentConversationId).toBeNull();
  });
});
