/**
 * TTS Generation API Tests
 *
 * Covers:
 * - Validation errors (missing fields, bad format)
 * - MISSING_API_KEY when no key
 * - TEXT_TOO_LONG over maxCharsPerRequest
 * - Success path (mock provider)
 * - Provider error mapping (401, 429, 500, network)
 * - No fake audio generated on error paths
 * - Real file I/O chain: write audio to temp dir, read back via /api/audio/:assetId
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");

  const tmp = nodePath.join(
    nodeOs.tmpdir(),
    `tts-tts-${process.pid}-${Date.now()}`
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
import { settings, generationJob, audioAsset } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import settingsRoutes from "../src/routes/settings.js";
import ttsRoutes from "../src/routes/tts.js";
import historyRoutes from "../src/routes/history.js";

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
    responseFormat: "mp3",
    ...overrides,
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("TTS Generate API", () => {
  let app: Hono;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
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

  // ── Validation ───────────────────────────────────────────────────────────

  describe("Request validation", () => {
    it("rejects missing model with VALIDATION_ERROR", async () => {
      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "hi", voice: "Zephyr" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.status).toBe("failed");
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects empty input with VALIDATION_ERROR", async () => {
      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({ input: "" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects missing voice with VALIDATION_ERROR", async () => {
      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", input: "hi" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid responseFormat", async () => {
      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({ responseFormat: "wav" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── MISSING_API_KEY ──────────────────────────────────────────────────────

  describe("MISSING_API_KEY", () => {
    it("returns MISSING_API_KEY error when no key configured", async () => {
      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody(),
      });

      // Route returns 200 with failed status (by design: saves failed job)
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("failed");
      expect(body.error.code).toBe("MISSING_API_KEY");
      expect(body.jobId).toBeTruthy();
      // Must NOT generate fake success audio
      expect(body.assetId).toBeUndefined();
      expect(body.audioUrl).toBeUndefined();
    });

    it("saves a failed job record for traceability", async () => {
      await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody(),
      });

      const db = getDb();
      const jobs = db.select().from(generationJob).all();
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe("failed");
      expect(jobs[0].errorCode).toBe("MISSING_API_KEY");
    });
  });

  // ── TEXT_TOO_LONG ────────────────────────────────────────────────────────

  describe("TEXT_TOO_LONG", () => {
    it("rejects input exceeding maxCharsPerRequest", async () => {
      await seedKey(app);

      // Default maxChars is 5000 when no settings row
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
      expect(body.charCount).toBe(5001);
    });
  });

  // ── Success path (mock provider, REAL file I/O) ──────────────────────────

  describe("Success path (mock provider)", () => {
    it("returns succeeded with asset info when provider returns audio", async () => {
      await seedKey(app);

      // Mock OpenRouter to return audio
      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-test-123",
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
      expect(body.generationId).toBe("gen-test-123");
      expect(body.assetId).toBeDefined();
      expect(body.audioUrl).toMatch(/^\/api\/audio\/\d+$/);
      expect(body.contentType).toBe("audio/mpeg");
      expect(body.charCount).toBe("Hello, this is a test.".length);

      // Verify mock was called with the real key
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/audio/speech");
      expect((init as RequestInit).headers).toHaveProperty("Authorization");
    });
  });

  // ── Provider error mapping ───────────────────────────────────────────────

  describe("Provider error mapping", () => {
    beforeEach(async () => {
      await seedKey(app);
    });

    it("maps 401 to INVALID_API_KEY", async () => {
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
    });

    it("maps 429 to RATE_LIMITED with retry info", async () => {
      // Provider retries on 429 (retryable), mock needs fresh Response each call
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: "Slow down" } }),
            { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }
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
      expect(body.error.code).toBe("RATE_LIMITED");
      // Provider should have retried (at least 1 attempt, up to maxRetries)
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("maps 500 to PROVIDER_ERROR", async () => {
      // Provider retries on 5xx (retryable), mock needs fresh Response each call
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
    });

    it("prefers error body code over HTTP status classification", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "INSUFFICIENT_CREDITS", message: "Out of credits" } }),
          { status: 402, headers: { "content-type": "application/json" } }
        )
      );

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody(),
      });

      const body = await res.json();
      expect(body.status).toBe("failed");
      expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("handles network errors gracefully (provider catches, returns NETWORK_ERROR)", async () => {
      // Provider retries on network errors, so mock needs multiple rejections
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody(),
      });

      // Provider catches network errors internally and returns ok:false
      // Route treats it as a normal failure (not exception)
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("failed");
      expect(body.error.code).toBe("NETWORK_ERROR");
    });
  });

  // ── Real file I/O chain ──────────────────────────────────────────────────

  describe("Real file I/O chain", () => {
    it("writes audio to disk and /api/audio/:assetId returns correct MIME and bytes", async () => {
      await seedKey(app);

      // Mock OpenRouter to return specific audio bytes
      const audioBytes = new Uint8Array([
        0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, // ID3 header (MP3-like)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      mockFetch.mockResolvedValueOnce(
        new Response(audioBytes, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-real-io-test",
          },
        })
      );

      // 1. Generate audio via API
      const genRes = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody(),
      });

      expect(genRes.status).toBe(200);
      const genBody = await genRes.json();
      expect(genBody.status).toBe("succeeded");
      expect(genBody.assetId).toBeDefined();
      expect(genBody.audioUrl).toMatch(/^\/api\/audio\/\d+$/);

      const assetId = genBody.assetId;

      // 2. Verify job record in DB
      const db = getDb();
      const job = db.select().from(generationJob).where(eq(generationJob.id, genBody.jobId)).get();
      expect(job).toBeTruthy();
      expect(job!.status).toBe("succeeded");
      expect(job!.generationId).toBe("gen-real-io-test");

      // 3. Verify audio_asset record in DB
      const asset = db.select().from(audioAsset).where(eq(audioAsset.id, assetId)).get();
      expect(asset).toBeTruthy();
      expect(asset!.mimeType).toBe("audio/mpeg");
      expect(asset!.sizeBytes).toBe(audioBytes.length);
      expect(asset!.filePath).toBeTruthy();

      // 4. Verify the file actually exists on disk
      const fullFilePath = path.resolve(testState.tmpDir, "audio", path.relative(
        path.resolve(testState.tmpDir, "audio"),
        path.resolve(asset!.filePath)
      ).replace(/\\/g, "/"));
      // The file path in DB is relative to CWD; with env mock, audioOutputDir = tmp/audio
      // readAudioFile resolves relative to audioOutputDir, so just verify via the API

      // 5. Read audio back via /api/audio/:assetId
      const audioRes = await r(app, `/api/audio/${assetId}`);
      expect(audioRes.status).toBe(200);
      expect(audioRes.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(audioRes.headers.get("Content-Disposition")).toContain("inline");

      // 6. Verify the returned bytes match the original audio
      const returnedBuffer = Buffer.from(await audioRes.arrayBuffer());
      expect(returnedBuffer.length).toBe(audioBytes.length);
      expect(returnedBuffer).toEqual(Buffer.from(audioBytes));
    });

    it("returns 404 for non-existent asset ID", async () => {
      const res = await r(app, "/api/audio/999999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid asset ID", async () => {
      const res = await r(app, "/api/audio/not-a-number");
      expect(res.status).toBe(400);
    });

    it("sets Content-Disposition to attachment when ?download=1", async () => {
      await seedKey(app);

      const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(audioBytes, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-dl-test",
          },
        })
      );

      const genRes = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody(),
      });

      const genBody = await genRes.json();
      expect(genBody.status).toBe("succeeded");

      const assetId = genBody.assetId;

      // Request with download=1
      const dlRes = await r(app, `/api/audio/${assetId}?download=1`);
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get("Content-Disposition")).toContain("attachment");
    });

    it("history list includes audio asset info for succeeded jobs", async () => {
      await seedKey(app);

      const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(audioBytes, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-history-test",
          },
        })
      );

      // Generate a job
      const genRes = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody(),
      });
      const genBody = await genRes.json();
      expect(genBody.status).toBe("succeeded");

      // Fetch history
      const historyRes = await r(app, "/api/history");
      expect(historyRes.status).toBe(200);
      const historyBody = await historyRes.json();

      expect(historyBody.records.length).toBeGreaterThanOrEqual(1);
      const succeededRecord = historyBody.records.find(
        (rec: { status: string }) => rec.status === "succeeded"
      );
      expect(succeededRecord).toBeDefined();
      expect(succeededRecord.assetId).toBeDefined();
      expect(succeededRecord.audioUrl).toMatch(/^\/api\/audio\/\d+$/);
      expect(succeededRecord.downloadUrl).toMatch(/^\/api\/audio\/\d+\?download=1$/);
      expect(succeededRecord.durationMs).toBeGreaterThan(0);
      expect(succeededRecord.assetFormat).toBe("mp3");
      expect(succeededRecord.sizeBytes).toBe(audioBytes.length);
    });
  });

  // ── directorSnapshot with sampleContext ────────────────────────────────

  describe("directorSnapshot with sampleContext", () => {
    it("accepts directorSnapshot with sampleContext and persists to job", async () => {
      await seedKey(app);

      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-snapshot-test",
          },
        })
      );

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({
          directorSnapshot: {
            audioProfile: "Warm podcast",
            scene: "Living room",
            directorNotes: "Relaxed tone",
            sampleContext: "Previous episode established the hosts",
            transcript: "Speaker A: Welcome back!",
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("succeeded");
      expect(body.jobId).toBeTruthy();

      // Verify directorSnapshot persisted with sampleContext
      const db = getDb();
      const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
      expect(job).toBeTruthy();
      expect(job!.directorSnapshot).toBeTruthy();

      const snapshot = JSON.parse(job!.directorSnapshot!);
      expect(snapshot.audioProfile).toBe("Warm podcast");
      expect(snapshot.scene).toBe("Living room");
      expect(snapshot.directorNotes).toBe("Relaxed tone");
      expect(snapshot.sampleContext).toBe("Previous episode established the hosts");
      expect(snapshot.transcript).toBe("Speaker A: Welcome back!");
    });

    it("accepts directorSnapshot without sampleContext (backward compatible)", async () => {
      await seedKey(app);

      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-no-samplectx",
          },
        })
      );

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({
          directorSnapshot: {
            audioProfile: "Warm",
            scene: "Room",
            directorNotes: "Notes",
            transcript: "Hello",
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("succeeded");

      const db = getDb();
      const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
      const snapshot = JSON.parse(job!.directorSnapshot!);
      expect(snapshot.audioProfile).toBe("Warm");
      // sampleContext is optional, may be undefined or absent
      expect(snapshot.sampleContext).toBeUndefined();
    });

    it("strips unknown fields from directorSnapshot via Zod strip", async () => {
      await seedKey(app);

      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-strip-test",
          },
        })
      );

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({
          directorSnapshot: {
            audioProfile: "Test",
            unknownExtraField: "should be stripped",
            sampleContext: "This should pass through",
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("succeeded");

      const db = getDb();
      const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
      const snapshot = JSON.parse(job!.directorSnapshot!);
      expect(snapshot.audioProfile).toBe("Test");
      expect(snapshot.sampleContext).toBe("This should pass through");
      // Unknown field stripped by Zod's default .strip() behavior
      expect(snapshot.unknownExtraField).toBeUndefined();
    });

    it("persists speakers in directorSnapshot", async () => {
      await seedKey(app);

      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-speakers-snapshot",
          },
        })
      );

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({
          directorSnapshot: {
            audioProfile: "Warm podcast",
            scene: "Living room",
            directorNotes: "Relaxed tone",
            sampleContext: "Previous episode",
            transcript: "Speaker A: Welcome back!",
            speakers: [
              { id: "a", label: "Speaker A", name: "Host", voice: "Zephyr", style: "conversational" },
              { id: "b", label: "Speaker B", name: "Guest", voice: "Puck", style: "friendly" },
            ],
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("succeeded");

      const db = getDb();
      const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
      const snapshot = JSON.parse(job!.directorSnapshot!);

      // Verify five elements
      expect(snapshot.audioProfile).toBe("Warm podcast");
      expect(snapshot.scene).toBe("Living room");
      expect(snapshot.directorNotes).toBe("Relaxed tone");
      expect(snapshot.sampleContext).toBe("Previous episode");
      expect(snapshot.transcript).toBe("Speaker A: Welcome back!");

      // Verify speakers persisted
      expect(Array.isArray(snapshot.speakers)).toBe(true);
      expect(snapshot.speakers.length).toBe(2);
      expect(snapshot.speakers[0]).toEqual({
        id: "a",
        label: "Speaker A",
        name: "Host",
        voice: "Zephyr",
        style: "conversational",
      });
      expect(snapshot.speakers[1]).toEqual({
        id: "b",
        label: "Speaker B",
        name: "Guest",
        voice: "Puck",
        style: "friendly",
      });
    });

    it("persists directorSnapshot with transcript but no speakers", async () => {
      await seedKey(app);

      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-transcript-no-speakers",
          },
        })
      );

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({
          directorSnapshot: {
            audioProfile: "Narrator",
            transcript: "The story begins here.",
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("succeeded");

      const db = getDb();
      const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
      const snapshot = JSON.parse(job!.directorSnapshot!);
      expect(snapshot.audioProfile).toBe("Narrator");
      expect(snapshot.transcript).toBe("The story begins here.");
      expect(snapshot.speakers).toBeUndefined();
    });

    it("directorSnapshot speakers are retrievable via GET /api/jobs/:jobId", async () => {
      await seedKey(app);

      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-retrieve-speakers",
          },
        })
      );

      const genRes = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({
          directorSnapshot: {
            audioProfile: "Interview",
            scene: "Studio",
            transcript: "Welcome to the show.",
            speakers: [
              { id: "a", label: "Host", voice: "Zephyr" },
            ],
          },
        }),
      });

      const genBody = await genRes.json();
      expect(genBody.status).toBe("succeeded");

      // Retrieve job detail
      const detailRes = await r(app, `/api/jobs/${genBody.jobId}`);
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(detail.job.directorSnapshot).toBeTruthy();
      expect(detail.job.directorSnapshot.speakers).toHaveLength(1);
      expect(detail.job.directorSnapshot.speakers[0].id).toBe("a");
      expect(detail.job.directorSnapshot.speakers[0].voice).toBe("Zephyr");
      expect(detail.job.directorSnapshot.transcript).toBe("Welcome to the show.");
    });

    it("preserves original transcript separately from assembled prompt input", async () => {
      // This test validates the Director frontend flow:
      // - `input` (req.text) = the assembled prompt sent to TTS
      // - `directorSnapshot.transcript` = the user's raw transcript
      // They must be stored independently; the assembled prompt must NOT
      // overwrite the original transcript.
      await seedKey(app);

      const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeAudio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen-transcript-vs-input",
          },
        })
      );

      const assembledPrompt = "Audio Profile: Warm\nScene: Room\nDirector's Notes: Slow\nSpeaker A: Hello world!";
      const originalTranscript = "Hello world!";

      const res = await r(app, "/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validGenerateBody({
          input: assembledPrompt,
          directorSnapshot: {
            audioProfile: "Warm",
            scene: "Room",
            directorNotes: "Slow",
            transcript: originalTranscript,
            speakers: [
              { id: "a", label: "Speaker A", name: "Host", voice: "Zephyr", style: "calm" },
            ],
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("succeeded");
      expect(body.charCount).toBe(assembledPrompt.length);

      const db = getDb();
      const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
      expect(job).toBeTruthy();

      // The `input` column stores the assembled prompt (sent to TTS)
      expect(job!.input).toBe(assembledPrompt);

      // The `directorSnapshot.transcript` stores the original user transcript
      const snapshot = JSON.parse(job!.directorSnapshot!);
      expect(snapshot.transcript).toBe(originalTranscript);
      expect(snapshot.transcript).not.toBe(assembledPrompt);

      // Other director fields preserved
      expect(snapshot.audioProfile).toBe("Warm");
      expect(snapshot.scene).toBe("Room");
      expect(snapshot.directorNotes).toBe("Slow");
      expect(snapshot.speakers).toHaveLength(1);
      expect(snapshot.speakers[0].name).toBe("Host");
      expect(snapshot.speakers[0].voice).toBe("Zephyr");
      expect(snapshot.speakers[0].style).toBe("calm");
    });
  });
});
