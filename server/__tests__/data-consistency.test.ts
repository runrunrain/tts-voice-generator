/**
 * Data Consistency Tests -- Phase 4 Quality Gate
 *
 * Explicitly asserts:
 * - Succeeded TTS job has audio_asset with file on disk, valid sha256, reasonable sizeBytes
 * - MISSING_API_KEY / TEXT_TOO_LONG / upstream-error failed jobs do NOT create audio_asset
 *   and do NOT leave visible success audio files
 * - After error paths, no orphan temp files remain
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");

  const tmp = nodePath.join(
    nodeOs.tmpdir(),
    `tts-consistency-${process.pid}-${Date.now()}`
  );
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

// ─── Imports ─────────────────────────────────────────────────────────────────

import { initSchema, closeDb, getDb } from "../src/db/index.js";
import { generationJob, audioAsset } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import settingsRoutes from "../src/routes/settings.js";
import ttsRoutes from "../src/routes/tts.js";
import historyRoutes from "../src/routes/history.js";
import { scanOrphanFiles, getAudioBaseDir, computeSha256 } from "../src/utils/audio-fs.js";
import { wrapPcm16LeToWav } from "../src/utils/audio-format.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createApp(): Hono {
  const app = new Hono();
  app.route("/", settingsRoutes);
  app.route("/", ttsRoutes);
  app.route("/", historyRoutes);
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

function validGenerateBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "google/gemini-3.1-flash-tts-preview",
    input: "Hello, this is a test.",
    voice: "Zephyr",
    responseFormat: "wav",
    ...overrides,
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Data Consistency: succeeded job has audio asset", () => {
  let app: Hono;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    const audioDir = getAudioBaseDir();
    if (fs.existsSync(audioDir)) fs.rmSync(audioDir, { recursive: true, force: true });
    fs.mkdirSync(audioDir, { recursive: true });
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

  it("succeeded job creates audio_asset with file on disk, valid sha256 and sizeBytes", async () => {
    await seedKey(app);

    const pcmBytes = new Uint8Array([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
      0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
      0x0C, 0x0D, 0x0E, 0x0F,
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(pcmBytes, {
        status: 200,
        headers: {
          "content-type": "audio/pcm",
          "x-generation-id": "gen-consistency-test",
        },
      })
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("succeeded");
    expect(body.jobId).toBeTruthy();

    // 1. Verify job record is "succeeded"
    const db = getDb();
    const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
    expect(job).toBeTruthy();
    expect(job!.status).toBe("succeeded");
    expect(job!.generationId).toBe("gen-consistency-test");

    // 2. Verify audio_asset exists
    const asset = db.select().from(audioAsset).where(eq(audioAsset.jobId, body.jobId)).get();
    expect(asset).toBeTruthy();
    expect(asset!.mimeType).toBe("audio/wav");
    expect(asset!.sampleRate).toBe(24000);
    expect(asset!.bitDepth).toBe(16);
    expect(asset!.channels).toBe(1);
    // WAV size = 44 header + PCM data
    expect(asset!.sizeBytes).toBe(44 + pcmBytes.length);
    expect(asset!.sizeBytes).toBeGreaterThan(0);
    expect(asset!.sha256).toBeTruthy();
    // sha256 should be a 64-char hex string
    expect(asset!.sha256).toMatch(/^[a-f0-9]{64}$/);
    // Verify sha256 matches actual WAV content (header + PCM)
    const wavBuffer = wrapPcm16LeToWav(Buffer.from(pcmBytes));
    const expectedSha256 = computeSha256(wavBuffer);
    expect(asset!.sha256).toBe(expectedSha256);
    expect(asset!.filePath).toBeTruthy();

    // 3. Verify file exists on disk
    const baseDir = getAudioBaseDir();
    const fullPath = path.join(baseDir, asset!.filePath);
    expect(fs.existsSync(fullPath)).toBe(true);
    const fileContent = fs.readFileSync(fullPath);
    expect(fileContent.length).toBe(44 + pcmBytes.length);

    const detailRes = await r(app, `/api/jobs/${body.jobId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.audio.sampleRate).toBe(24000);
    expect(detailBody.audio.bitDepth).toBe(16);
    expect(detailBody.audio.channels).toBe(1);
  });

  it("succeeded job audio is retrievable via /api/audio/:assetId", async () => {
    await seedKey(app);

    const pcmBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    mockFetch.mockResolvedValueOnce(
      new Response(pcmBytes, {
        status: 200,
        headers: {
          "content-type": "audio/pcm",
          "x-generation-id": "gen-audio-retrieve",
        },
      })
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const body = await res.json();
    expect(body.status).toBe("succeeded");
    const assetId = body.assetId;

    // Retrieve via audio endpoint
    const audioRes = await r(app, `/api/audio/${assetId}`);
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers.get("Content-Type")).toBe("audio/wav");
    const returnedBuffer = Buffer.from(await audioRes.arrayBuffer());
    // WAV = 44 header + PCM data
    expect(returnedBuffer.length).toBe(44 + pcmBytes.length);
  });
});

describe("Data Consistency: failed jobs do NOT create audio assets", () => {
  let app: Hono;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    const audioDir = getAudioBaseDir();
    if (fs.existsSync(audioDir)) fs.rmSync(audioDir, { recursive: true, force: true });
    fs.mkdirSync(audioDir, { recursive: true });
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

  it("MISSING_API_KEY failed job creates no audio_asset and no audio file", async () => {
    // No key seeded, so request fails with MISSING_API_KEY

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("MISSING_API_KEY");
    expect(body.jobId).toBeTruthy();

    // No audio_asset record
    const db = getDb();
    const assets = db.select().from(audioAsset).all();
    expect(assets.length).toBe(0);

    // Job record exists but is failed
    const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
    expect(job).toBeTruthy();
    expect(job!.status).toBe("failed");

    // No audio files in output dir
    const baseDir = getAudioBaseDir();
    const mp3Files = findFilesRecursive(baseDir, ".mp3");
    expect(mp3Files.length).toBe(0);
  });

  it("TEXT_TOO_LONG failed job creates no audio_asset and no audio file", async () => {
    await seedKey(app);

    const longInput = "A".repeat(5001);
    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody({ input: longInput }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("TEXT_TOO_LONG");

    // No audio_asset
    const db = getDb();
    const assets = db.select().from(audioAsset).all();
    expect(assets.length).toBe(0);

    // No audio files
    const baseDir = getAudioBaseDir();
    const mp3Files = findFilesRecursive(baseDir, ".mp3");
    expect(mp3Files.length).toBe(0);
  });

  it("upstream error (401 INVALID_API_KEY) creates no audio_asset", async () => {
    await seedKey(app);

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Invalid auth" } }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("INVALID_API_KEY");

    // No audio_asset
    const db = getDb();
    const assets = db.select().from(audioAsset).all();
    expect(assets.length).toBe(0);

    // No audio files
    const baseDir = getAudioBaseDir();
    const mp3Files = findFilesRecursive(baseDir, ".mp3");
    expect(mp3Files.length).toBe(0);
  });

  it("upstream error (500 PROVIDER_ERROR) creates no audio_asset", async () => {
    await seedKey(app);

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "Internal error" } }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("PROVIDER_ERROR");

    // No audio_asset
    const db = getDb();
    const assets = db.select().from(audioAsset).all();
    expect(assets.length).toBe(0);
  });

  it("network error creates no audio_asset", async () => {
    await seedKey(app);

    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("NETWORK_ERROR");

    // No audio_asset
    const db = getDb();
    const assets = db.select().from(audioAsset).all();
    expect(assets.length).toBe(0);
  });

  it("validation error (missing model) creates no audio_asset and no job", async () => {
    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi", voice: "Zephyr" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");

    // No audio_asset
    const db = getDb();
    const assets = db.select().from(audioAsset).all();
    expect(assets.length).toBe(0);

    // Validation errors don't create jobs either
    const jobs = db.select().from(generationJob).all();
    expect(jobs.length).toBe(0);
  });
});

describe("Data Consistency: no orphan temp files after errors", () => {
  let app: Hono;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    const audioDir = getAudioBaseDir();
    if (fs.existsSync(audioDir)) fs.rmSync(audioDir, { recursive: true, force: true });
    fs.mkdirSync(audioDir, { recursive: true });
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

  it("no .tmp orphan files remain after MISSING_API_KEY error", async () => {
    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });
    const body = await res.json();

    // Use negative maxAgeMs so even brand-new files count as orphans
    const orphans = scanOrphanFiles(-10000);
    const tmpOrphans = orphans.filter(o => o.path.endsWith(".tmp"));
    expect(tmpOrphans.length).toBe(0);
  });

  it("no .tmp orphan files remain after upstream 500 error", async () => {
    await seedKey(app);

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "Server error" } }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });
    const body = await res.json();

    const orphans = scanOrphanFiles(-10000);
    const tmpOrphans = orphans.filter(o => o.path.endsWith(".tmp"));
    expect(tmpOrphans.length).toBe(0);
  });

  it("no .tmp orphan files remain after network error", async () => {
    await seedKey(app);

    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const orphans = scanOrphanFiles(-10000);
    const tmpOrphans = orphans.filter(o => o.path.endsWith(".tmp"));
    expect(tmpOrphans.length).toBe(0);
  });

  it("successful write leaves no .tmp files", async () => {
    await seedKey(app);

    const pcmBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    mockFetch.mockResolvedValueOnce(
      new Response(pcmBytes, {
        status: 200,
        headers: {
          "content-type": "audio/pcm",
          "x-generation-id": "gen-orphan-test",
        },
      })
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });
    const body = await res.json();

    // No temp files after successful write
    const orphans = scanOrphanFiles(-10000);
    const tmpOrphans = orphans.filter(o => o.path.endsWith(".tmp"));
    expect(tmpOrphans.length).toBe(0);

    // But the real file for this job should exist (not .tmp) - now WAV format
    const asset = getDb().select().from(audioAsset).where(eq(audioAsset.jobId, body.jobId)).get();
    expect(asset).toBeTruthy();
    const baseDir = getAudioBaseDir();
    expect(fs.existsSync(path.join(baseDir, asset!.filePath))).toBe(true);
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function findFilesRecursive(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}
