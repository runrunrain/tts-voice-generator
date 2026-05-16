import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");

  const tmp = nodePath.join(nodeOs.tmpdir(), `tts-voices-${process.pid}-${Date.now()}`);
  nodeFs.mkdirSync(tmp, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(tmp, "audio"), { recursive: true });
  const testDbPath = nodePath.join(tmp, "test.db");
  testState.tmpDir = tmp;
  testState.dbFilePath = testDbPath;

  const SALT = "tts-voice-generator-key-encryption-v1";
  const ALGO = "aes-256-gcm";
  const IV_LEN = 16;
  const TAG_LEN = 16;

  function encKey(): Buffer {
    return crypto.scryptSync(testDbPath, SALT, 32);
  }

  function encryptApiKey(p: string): string {
    const iv = crypto.randomBytes(IV_LEN);
    const c = crypto.createCipheriv(ALGO, encKey(), iv);
    const enc = Buffer.concat([c.update(p, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  }

  function decryptApiKey(ct: string): string | null {
    try {
      const raw = Buffer.from(ct, "base64");
      const d = crypto.createDecipheriv(ALGO, encKey(), raw.subarray(0, IV_LEN));
      d.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
      return d.update(raw.subarray(IV_LEN + TAG_LEN)) + d.final("utf8");
    } catch {
      return null;
    }
  }

  function maskApiKey(k: string): string {
    return k.length > 12 ? `${k.slice(0, 3)}***...***${k.slice(-4)}` : "***configured***";
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
    maskApiKey,
    isEnvApiKeyConfigured: () => false,
    requireEnvApiKey: () => { throw new Error("Not configured"); },
  };
});

import { initSchema, closeDb, getDb } from "../src/db/index.js";
import { audioAsset, generationJob, settings, voiceProfile } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import settingsRoutes from "../src/routes/settings.js";
import voicesRoutes from "../src/routes/voices.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", settingsRoutes);
  app.route("/", voicesRoutes);
  return app;
}

function r(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

async function seedKey(app: Hono, key = "sk-test-api-key-12345678") {
  await r(app, "/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ openRouterApiKey: key }),
  });
}

function seedVoice(name = "Zephyr") {
  getDb().insert(voiceProfile).values({
    name,
    role: "明亮",
    source: name === "Zephyr" ? "default" : "candidate",
    model: "google/gemini-3.1-flash-tts-preview",
    verifiedStatus: "unknown",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run();
}

function probeBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ voice: "Zephyr", ...overrides });
}

function auditionBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ voice: "Zephyr", ...overrides });
}

function resetAudioDir() {
  const audioDir = path.join(testState.tmpDir, "audio");
  fs.rmSync(audioDir, { recursive: true, force: true });
  fs.mkdirSync(audioDir, { recursive: true });
}

function listRelativeFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(path.relative(root, fullPath).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Voices API probe and availability stats", () => {
  let app: Hono;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    resetAudioDir();
    initSchema();
    app = createApp();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) {
      fs.rmSync(testState.tmpDir, { recursive: true, force: true });
    }
  });

  it("probe succeeds and records uncached verification metadata", async () => {
    seedVoice();
    await seedKey(app);
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/pcm" },
    }));

    const res = await r(app, "/api/voices/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.voice).toBe("Zephyr");
    expect(body.verifiedStatus).toBe("verified");
    expect(body.error).toBeNull();
    expect(body.cached).toBe(false);
    expect(body.cacheTtlSeconds).toBe(30);
    expect(body.lastVerified).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("probe failure keeps real sanitized error and records failed status", async () => {
    seedVoice();
    await seedKey(app);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "voice not available" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));

    const res = await r(app, "/api/voices/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verifiedStatus).toBe("failed");
    expect(body.error).toContain("voice not available");
    expect(body.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("probe without API key returns real missing-key failure and does not call fetch", async () => {
    seedVoice();

    const res = await r(app, "/api/voices/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody(),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.verifiedStatus).toBe("failed");
    expect(body.error).toBe("MISSING_API_KEY");
    expect(body.cached).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("probe missing voice returns validation error", async () => {
    await seedKey(app);

    const res = await r(app, "/api/voices/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("recent verified probe returns TTL cache without calling fetch", async () => {
    seedVoice();
    await seedKey(app);
    const now = new Date();
    getDb().update(voiceProfile).set({
      verifiedStatus: "verified",
      lastVerified: now,
      verifyDuration: 123,
      verifyError: null,
      updatedAt: now,
    }).where(eq(voiceProfile.name, "Zephyr")).run();

    const res = await r(app, "/api/voices/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody(),
    });

    const body = await res.json();
    expect(body.verifiedStatus).toBe("verified");
    expect(body.cached).toBe(true);
    expect(body.latencyMs).toBe(123);
    expect(Math.abs(Date.parse(body.lastVerified) - now.getTime())).toBeLessThan(1000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("probe without API key ignores fresh verified cache and returns missing-key failure", async () => {
    seedVoice();
    const now = new Date();
    getDb().update(voiceProfile).set({
      verifiedStatus: "verified",
      lastVerified: now,
      verifyDuration: 123,
      verifyError: null,
      updatedAt: now,
    }).where(eq(voiceProfile.name, "Zephyr")).run();

    const res = await r(app, "/api/voices/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody(),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.verifiedStatus).toBe("failed");
    expect(body.error).toBe("MISSING_API_KEY");
    expect(body.cached).toBe(false);
    expect(body.latencyMs).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("concurrent same voice probes share one OpenRouter request and result", async () => {
    seedVoice();
    await seedKey(app);
    const pending = deferredResponse();
    mockFetch.mockReturnValueOnce(pending.promise);

    const requests = [1, 2, 3].map(() => r(app, "/api/voices/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody(),
    }));

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    pending.resolve(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/pcm" },
    }));

    const bodies = await Promise.all((await Promise.all(requests)).map((res) => res.json()));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(3);
    expect(bodies.every((body) => body.verifiedStatus === "verified")).toBe(true);
    expect(bodies.every((body) => body.cached === false)).toBe(true);
    expect(bodies.every((body) => body.error === null)).toBe(true);
  });

  it("force=true skips recent cache and calls OpenRouter", async () => {
    seedVoice();
    await seedKey(app);
    const now = new Date();
    getDb().update(voiceProfile).set({
      verifiedStatus: "verified",
      lastVerified: now,
      verifyDuration: 123,
      updatedAt: now,
    }).where(eq(voiceProfile.name, "Zephyr")).run();
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([5, 6]), {
      status: 200,
      headers: { "content-type": "audio/pcm" },
    }));

    const res = await r(app, "/api/voices/probe?force=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody(),
    });

    const body = await res.json();
    expect(body.verifiedStatus).toBe("verified");
    expect(body.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("audition succeeds with playable wav bytes and does not write generation history", async () => {
    seedVoice();
    await seedKey(app);
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/pcm", "x-generation-id": "gen-audition" },
    }));

    const res = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-audition-voice")).toBe("Zephyr");
    expect(res.headers.get("x-tts-audition-cache")).toBe("miss");
    expect(res.headers.get("x-tts-audition-cache-key")).toMatch(/^sha256:[a-f0-9]{64}$/);
    const audioBytes = Buffer.from(await res.arrayBuffer());
    expect(audioBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(audioBytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(audioBytes.length).toBe(48);
    expect(getDb().select().from(generationJob).all()).toHaveLength(0);
    expect(getDb().select().from(audioAsset).all()).toHaveLength(0);
    expect(getDb().select().from(voiceProfile).where(eq(voiceProfile.name, "Zephyr")).get()?.verifiedStatus).toBe("unknown");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("audition without API key returns structured missing-key error and does not call fetch", async () => {
    seedVoice();

    const res = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.voice).toBe("Zephyr");
    expect(body.error).toMatchObject({
      code: "MISSING_API_KEY",
      category: "auth",
      retryable: false,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("audition upstream failure returns sanitized structured error", async () => {
    seedVoice();
    await seedKey(app);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "voice denied Bearer sk-secretvalue123", code: "BAD_REQUEST" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));

    const res = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.category).toBe("validation");
    expect(body.error.message).toContain("Bearer [REDACTED]");
    expect(body.error.message).not.toContain("sk-secretvalue123");
    expect(getDb().select().from(generationJob).all()).toHaveLength(0);
    expect(getDb().select().from(audioAsset).all()).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("audition cache hit returns cached audio without another OpenRouter call", async () => {
    seedVoice();
    await seedKey(app);
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/pcm" },
    }));

    const first = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });
    const firstBytes = Buffer.from(await first.arrayBuffer());

    const second = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });
    const secondBytes = Buffer.from(await second.arrayBuffer());

    expect(first.status).toBe(200);
    expect(first.headers.get("x-tts-audition-cache")).toBe("miss");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-tts-audition-cache")).toBe("hit");
    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getDb().select().from(generationJob).all()).toHaveLength(0);
    expect(getDb().select().from(audioAsset).all()).toHaveLength(0);
  });

  it("audition forceRefresh regenerates and replaces the active cache", async () => {
    seedVoice();
    await seedKey(app);
    mockFetch
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/pcm" },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([5, 6, 7, 8]), {
        status: 200,
        headers: { "content-type": "audio/pcm" },
      }));

    const first = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });
    const firstBytes = Buffer.from(await first.arrayBuffer());

    const refreshed = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody({ forceRefresh: true }),
    });
    const refreshedBytes = Buffer.from(await refreshed.arrayBuffer());

    const hit = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });
    const hitBytes = Buffer.from(await hit.arrayBuffer());

    expect(first.headers.get("x-tts-audition-cache")).toBe("miss");
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("x-tts-audition-cache")).toBe("refresh");
    expect(refreshedBytes.equals(firstBytes)).toBe(false);
    expect(hit.headers.get("x-tts-audition-cache")).toBe("hit");
    expect(hitBytes.equals(refreshedBytes)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("audition refresh failure preserves the old cache for subsequent hits", async () => {
    seedVoice();
    await seedKey(app);
    mockFetch
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/pcm" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporary upstream failure", code: "BAD_REQUEST" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }));

    const first = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const firstContentSha = first.headers.get("x-tts-audition-content-sha256");

    const failedRefresh = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody({ forceRefresh: true }),
    });
    const errorBody = await failedRefresh.json();

    const hit = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody(),
    });
    const hitBytes = Buffer.from(await hit.arrayBuffer());

    expect(failedRefresh.status).toBe(400);
    expect(errorBody.error.metadata.cachePreserved).toBe(true);
    expect(errorBody.error.metadata.existingGeneratedAt).toEqual(expect.any(String));
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-tts-audition-cache")).toBe("hit");
    expect(hit.headers.get("x-tts-audition-content-sha256")).toBe(firstContentSha);
    expect(hitBytes.equals(firstBytes)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("audition cache path uses hashed directories without raw voice names", async () => {
    await seedKey(app);
    const unsafeVoice = "../Unsafe/音色";
    mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/pcm" },
    }));

    const res = await r(app, "/api/voices/audition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: auditionBody({ voice: unsafeVoice }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tts-audition-cache")).toBe("miss");
    const files = listRelativeFiles(path.join(testState.tmpDir, "audio"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.every((file) => /^voice-auditions\/v1\/[a-f0-9]{64}\//.test(file))).toBe(true);
    expect(files.some((file) => file.includes("Unsafe") || file.includes("音色") || file.includes(".."))).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("concurrent force=true probes skip TTL cache but still share one OpenRouter request", async () => {
    seedVoice();
    await seedKey(app);
    const now = new Date();
    getDb().update(voiceProfile).set({
      verifiedStatus: "verified",
      lastVerified: now,
      verifyDuration: 123,
      verifyError: null,
      updatedAt: now,
    }).where(eq(voiceProfile.name, "Zephyr")).run();
    const pending = deferredResponse();
    mockFetch.mockReturnValueOnce(pending.promise);

    const requests = [1, 2].map(() => r(app, "/api/voices/probe?force=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: probeBody({ force: true }),
    }));

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    pending.resolve(new Response(new Uint8Array([5, 6]), {
      status: 200,
      headers: { "content-type": "audio/pcm" },
    }));

    const bodies = await Promise.all((await Promise.all(requests)).map((res) => res.json()));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(bodies.every((body) => body.verifiedStatus === "verified")).toBe(true);
    expect(bodies.every((body) => body.cached === false)).toBe(true);
  });

  it("stats include availability report fields", async () => {
    const db = getDb();
    db.insert(settings).values({ id: 1, updatedAt: new Date() }).run();
    const now = new Date();
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    db.insert(voiceProfile).values([
      { name: "Zephyr", source: "default", role: "明亮", verifiedStatus: "verified", lastVerified: old, verifyDuration: 100, createdAt: now, updatedAt: now },
      { name: "Puck", source: "candidate", role: "欢快", verifiedStatus: "failed", lastVerified: now, verifyDuration: 300, verifyError: "voice not available", createdAt: now, updatedAt: now },
      { name: "Kore", source: "custom", role: "坚定", verifiedStatus: "failed", lastVerified: now, verifyDuration: 500, verifyError: "voice not available", createdAt: now, updatedAt: now },
      { name: "Charon", source: "candidate", role: "信息丰富", verifiedStatus: "unknown", createdAt: now, updatedAt: now },
    ]).run();

    const res = await r(app, "/api/voices");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats.total).toBe(4);
    expect(body.stats.verified).toBe(1);
    expect(body.stats.failed).toBe(2);
    expect(body.stats.unknown).toBe(1);
    expect(body.stats.staleVerified).toBe(1);
    expect(body.stats.neverVerified).toBe(1);
    expect(body.stats.avgLatencyMs).toBe(300);
    expect(body.stats.errorSummary).toMatchObject([
      {
        voice: "Kore",
        errorCode: "VOICE_PROBE_FAILED",
        errorMessage: "voice not available",
        count: 1,
      },
      {
        voice: "Puck",
        errorCode: "VOICE_PROBE_FAILED",
        errorMessage: "voice not available",
        count: 1,
      },
    ]);
    expect(body.stats.errorSummary[0].lastOccurrence).toEqual(expect.any(String));
    expect(body.stats.errorSummary[1].lastOccurrence).toEqual(expect.any(String));
  });
});
