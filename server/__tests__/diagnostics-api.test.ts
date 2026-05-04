import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");
  const tmp = nodePath.join(nodeOs.tmpdir(), `tts-diagnostics-${process.pid}-${Date.now()}`);
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
import { agentActionLog, generationJob, settings } from "../src/db/schema.js";
import { encryptApiKey } from "../src/config/env.js";
import healthRoutes from "../src/routes/health.js";
import diagnosticsRoutes from "../src/routes/diagnostics.js";
import { createApp } from "../src/index.js";

function createDiagnosticsApp(): Hono {
  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", diagnosticsRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

describe("Diagnostics API", () => {
  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("returns diagnostics structure without leaking keys, plugin tokens, or hashes", async () => {
    const secretKey = "sk-diagnostics-secret-key-12345678";
    const pluginToken = "lpt_diagnostics_secret_token_12345678";
    const pluginHash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const db = getDb();

    db.insert(settings).values({
      id: 1,
      openRouterApiKey: encryptApiKey(secretKey),
      localPluginToken: pluginHash,
      defaultModel: "google/gemini-3.1-flash-tts-preview",
      defaultVoice: "Zephyr",
      defaultFormat: "wav",
      audioOutputDir: path.join(testState.tmpDir, "audio"),
      maxCharsPerRequest: 5000,
      maxConcurrentJobs: 2,
    }).run();

    db.insert(generationJob).values({
      id: "failed-job-1",
      model: "google/gemini-3.1-flash-tts-preview",
      voice: "Zephyr",
      responseFormat: "wav",
      input: `long input ${secretKey} ${pluginToken}`,
      inputCharCount: 42,
      status: "failed",
      source: "agent",
      errorCode: "PROVIDER_ERROR",
      errorMessage: `provider failed with ${secretKey} and ${pluginToken}`,
      createdAt: new Date(),
    }).run();

    db.insert(agentActionLog).values({
      conversationId: "conversation-1",
      actionType: "generate_speech",
      toolName: "local-tts",
      inputSummary: `summary ${secretKey} ${pluginToken} ${pluginHash}`,
      inputPayload: JSON.stringify({ secretKey, pluginToken, pluginHash }),
      approvalStatus: "approved",
      createdAt: new Date(),
    }).run();

    const res = await req(createDiagnosticsApp(), "/api/diagnostics");
    expect(res.status).toBe(200);
    const body = await res.json();
    const raw = JSON.stringify(body);

    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("checks");
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("failedJobs");
    expect(body).toHaveProperty("recentFailedJobs");
    expect(body).toHaveProperty("recentAgentActions");
    expect(body).toHaveProperty("recentJobs");
    expect(body).toHaveProperty("audioDir");
    expect(body).toHaveProperty("audioDirPath");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(body.keyConfigured).toBe(true);
    expect(body.dbOk).toBe(true);
    expect(body.audioDirWritable).toBe(true);
    expect(body.routesReady).toBe(true);
    expect(body.failedJobs[0].id).toBe("failed-job-1");
    expect(body.recentFailedJobs[0].id).toBe("failed-job-1");
    expect(body.recentFailedJobs[0].error).toContain("provider failed");
    expect(body.recentAgentActions[0].action).toBe("generate_speech");
    expect(body.recentAgentActions[0].status).toBe("approved");
    expect(body.recentAgentActions[0].createdAt).toEqual(expect.any(String));
    expect(body.recentJobs[0].charCount).toBe(42);
    expect(typeof body.audioDir.path).toBe("string");
    expect(body.audioDirPath).toBe(body.audioDir.path);
    expect(body.failedJobs[0]).not.toHaveProperty("input");
    expect(body.recentAgentActions[0]).not.toHaveProperty("inputPayload");

    expect(raw).not.toContain(secretKey);
    expect(raw).not.toContain(pluginToken);
    expect(raw).not.toContain(pluginHash);
  });

  it("keeps /api/health JSON response available in full app with static fallback registered", async () => {
    const app = createApp();
    const res = await req(app, "/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
