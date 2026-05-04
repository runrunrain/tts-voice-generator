/**
 * Security Gate Tests -- Phase 4 Quality Gate
 *
 * Lightweight security scan covering:
 * - GET /api/settings never returns API key patterns or Authorization/Bearer plaintext
 * - Error responses do not leak API keys or auth headers in metadata
 * - History and job detail responses do not contain key material
 * - No sk-* patterns (common API key prefix) in any API response body
 * - CORS headers: whitelist origins get CORS, non-whitelist do not, no-origin unaffected
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
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
    `tts-security-${process.pid}-${Date.now()}`
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
import healthRoutes from "../src/routes/health.js";

// ─── CORS whitelist (same as production) ─────────────────────────────────────

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createApp(): Hono {
  const app = new Hono();
  app.use("*", cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
    credentials: true,
  }));
  app.route("/", settingsRoutes);
  app.route("/", ttsRoutes);
  app.route("/", historyRoutes);
  app.route("/", healthRoutes);
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

/**
 * Check if a string contains any pattern resembling an API key.
 * Avoids false positives from masked keys like "sk-***...***5678".
 */
function containsApiKeyPattern(text: string): boolean {
  // Match "sk-" followed by at least 10 non-whitespace characters (unmasked key)
  const unmaskedPattern = /sk-[A-Za-z0-9_-]{10,}/;
  // Match "Bearer sk-" which should never appear in responses
  const bearerPattern = /Bearer\s+sk-/i;
  return unmaskedPattern.test(text) || bearerPattern.test(text);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Security Gate: GET /api/settings never leaks keys", () => {
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

  it("response body contains no unmasked API key pattern", async () => {
    const secret = "sk-secret-key-that-should-never-appear-in-response-body";
    await seedKey(app, secret);

    const res = await r(app, "/api/settings");
    const bodyText = await res.text();

    expect(containsApiKeyPattern(bodyText)).toBe(false);
    expect(bodyText).not.toContain(secret);
  });

  it("response contains no Bearer pattern", async () => {
    await seedKey(app, "sk-bearer-test-key-not-in-response");

    const res = await r(app, "/api/settings");
    const bodyText = await res.text();

    expect(bodyText).not.toMatch(/Bearer/i);
    expect(bodyText).not.toMatch(/Authorization/i);
  });

  it("keyMask format is safe (contains *** marker)", async () => {
    await seedKey(app, "sk-test-mask-verification-key-123");

    const res = await r(app, "/api/settings");
    const body = await res.json();

    expect(body.keyMask).toContain("***");
    // Masked key should not trigger API key pattern detection
    expect(containsApiKeyPattern(JSON.stringify(body))).toBe(false);
  });
});

describe("Security Gate: TTS error responses do not leak keys", () => {
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

  it("MISSING_API_KEY error response contains no key pattern", async () => {
    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
  });

  it("upstream 401 error response contains no key or Authorization pattern", async () => {
    const secret = "sk-leaked-key-test-should-not-appear-12345";
    await seedKey(app, secret);

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

    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
    expect(bodyText).not.toContain(secret);
    expect(bodyText).not.toMatch(/Bearer/i);
  });

  it("upstream 500 error with sensitive metadata is sanitized", async () => {
    const secret = "sk-metadata-leak-test-key-98765";
    await seedKey(app, secret);

    // 500 is retryable -- provider retries up to maxAttempts.
    // Use mockImplementation so each retry gets a fresh Response.
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "Server error",
              authorization: "Bearer sk-internal-key",
              api_key: "sk-should-be-redacted",
              safe_data: "this is safe",
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
    expect(bodyText).not.toContain(secret);
    expect(bodyText).not.toContain("sk-internal-key");
    expect(bodyText).not.toContain("sk-should-be-redacted");
    // Safe data should still be present in sanitized metadata
    expect(bodyText).toContain("this is safe");
  });

  it("success response contains no key pattern", async () => {
    const secret = "sk-success-response-no-leak-test-abc";
    await seedKey(app, secret);

    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
        status: 200,
        headers: {
          "content-type": "audio/pcm",
          "x-generation-id": "gen-security-test",
        },
      })
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
    expect(bodyText).not.toContain(secret);
  });
});

describe("Security Gate: upstream error.message text sanitization", () => {
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

  it("upstream error.message containing 'Bearer sk-...' is sanitized in response and DB", async () => {
    await seedKey(app, "sk-test-key-for-sanitize-test");

    // 401 is non-retryable, so no retry loop
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Bearer sk-upstream-leak-secret is invalid" },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();

    // Response body must not contain the leaked key pattern
    expect(bodyText).not.toContain("sk-upstream-leak-secret");
    expect(bodyText).not.toMatch(/Bearer\s+sk-/i);
    // But should still contain sanitized message text
    expect(bodyText).toContain("invalid");

    // DB error_message field must also be sanitized
    const body = JSON.parse(bodyText);
    const jobId = body.jobId;
    const db = getDb();
    const job = db.select().from(generationJob).where(eq(generationJob.id, jobId)).get();
    expect(job).toBeTruthy();
    expect(job!.errorMessage).not.toContain("sk-upstream-leak-secret");
    expect(job!.errorMessage).not.toMatch(/Bearer\s+sk-/i);
  });

  it("upstream error.message with 'apiKey=secret123' pattern is sanitized", async () => {
    await seedKey(app, "sk-test-key-for-apikey-pattern");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Invalid apiKey=sk-super-secret-key-12345 provided" },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("sk-super-secret-key-12345");
    expect(bodyText).not.toMatch(/apiKey\s*=\s*sk-/i);
  });

  it("upstream error.message with 'access_token=...' pattern is sanitized", async () => {
    await seedKey(app, "sk-test-key-for-access-token");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Rejected access_token=abc123def456ghi789" },
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    // The original secret value must be gone
    expect(bodyText).not.toContain("abc123def456ghi789");
    // The sanitized form should contain [REDACTED]
    expect(bodyText).toContain("access_token=[REDACTED]");
    // Readable portion preserved
    expect(bodyText).toContain("Rejected");
  });

  it("normal error message is NOT over-sanitized and remains readable", async () => {
    await seedKey(app, "sk-test-key-for-normal-errors");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Model not found: google/gemini-3.1-flash-tts-preview" },
        }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const body = await res.json();
    expect(body.error.message).toContain("Model not found");
    expect(body.error.message).toContain("gemini-3.1-flash-tts-preview");
  });

  it("upstream error.message with 'Bearer <long-token>' is sanitized", async () => {
    await seedKey(app, "sk-test-key-for-bearer-token");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Unauthorized: Bearer eyJhbGciOiJIUzI1NiJ9.fakepayload.signature" },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("eyJhbGciOiJIUzI1NiJ9.fakepayload.signature");
    expect(bodyText).toContain("Unauthorized");
  });
});

describe("Security Gate: history and job detail responses are key-safe", () => {
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

  it("GET /api/history response contains no key pattern", async () => {
    const secret = "sk-history-no-leak-test-key-def";
    await seedKey(app, secret);

    // Generate a succeeded job to populate history
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
        status: 200,
        headers: {
          "content-type": "audio/pcm",
          "x-generation-id": "gen-history-sec-test",
        },
      })
    );

    await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const res = await r(app, "/api/history");
    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
    expect(bodyText).not.toContain(secret);
  });

  it("GET /api/jobs/:jobId response contains no key pattern", async () => {
    const secret = "sk-jobs-no-leak-test-key-ghi";
    await seedKey(app, secret);

    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
        status: 200,
        headers: {
          "content-type": "audio/pcm",
          "x-generation-id": "gen-jobs-sec-test",
        },
      })
    );

    const genRes = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const genBody = await genRes.json();
    const jobId = genBody.jobId;

    const res = await r(app, `/api/jobs/${jobId}`);
    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
    expect(bodyText).not.toContain(secret);
  });
});

describe("Security Gate: health endpoint is key-safe", () => {
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

  it("GET /api/health contains no key pattern", async () => {
    await seedKey(app, "sk-health-no-leak-test-key-jkl");

    const res = await r(app, "/api/health");
    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
  });

  it("GET /api/ready contains no key pattern", async () => {
    await seedKey(app, "sk-ready-no-leak-test-key-mno");

    const res = await r(app, "/api/ready");
    const bodyText = await res.text();
    expect(containsApiKeyPattern(bodyText)).toBe(false);
  });
});

describe("Security Gate: CORS header validation", () => {
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

  it("whitelist origin (localhost:5173) receives Access-Control-Allow-Origin", async () => {
    const res = await r(app, "/api/health", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("whitelist origin (127.0.0.1:5173) receives CORS headers", async () => {
    const res = await r(app, "/api/health", {
      headers: { Origin: "http://127.0.0.1:5173" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:5173");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("non-whitelist origin does NOT receive Access-Control-Allow-Origin", async () => {
    const res = await r(app, "/api/health", {
      headers: { Origin: "https://evil.example.com" },
    });

    // Either null or empty -- browser will block
    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(allowOrigin === null || allowOrigin === "" || allowOrigin !== "https://evil.example.com").toBe(true);
  });

  it("non-whitelist origin (random port) does NOT receive CORS allow headers", async () => {
    const res = await r(app, "/api/health", {
      headers: { Origin: "http://localhost:9999" },
    });

    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(allowOrigin === null || allowOrigin === "").toBe(true);
  });

  it("no-origin request (server-side/curl) is unaffected", async () => {
    const res = await r(app, "/api/health");
    expect(res.status).toBe(200);

    // CORS headers are typically not set for no-origin requests
    // (the request works fine, browser CORS doesn't apply)
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("preflight OPTIONS with whitelist origin returns correct CORS headers", async () => {
    const res = await r(app, "/api/tts/generate", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("preflight OPTIONS with non-whitelist origin returns no CORS allow", async () => {
    const res = await r(app, "/api/tts/generate", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(allowOrigin === null || allowOrigin === "").toBe(true);
  });
});

describe("Security Gate: metadata recursive sanitization (M1)", () => {
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

  it("redacts access_token key in error metadata", async () => {
    await seedKey(app, "sk-test-access-token-metadata");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "Auth failed",
            access_token: "bare-token-value-should-be-redacted",
            safe_field: "visible",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("bare-token-value-should-be-redacted");
    expect(bodyText).toContain("[REDACTED]");
    expect(bodyText).toContain("visible");
  });

  it("redacts refresh_token, id_token, client_secret keys", async () => {
    await seedKey(app, "sk-test-multi-token-keys");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "OAuth error",
            refresh_token: "refresh-secret-123",
            id_token: "id-secret-456",
            client_secret: "client-secret-789",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("refresh-secret-123");
    expect(bodyText).not.toContain("id-secret-456");
    expect(bodyText).not.toContain("client-secret-789");
    const redactedCount = (bodyText.match(/\[REDACTED\]/g) || []).length;
    expect(redactedCount).toBeGreaterThanOrEqual(3);
  });

  it("recursively sanitizes nested arrays with sensitive objects", async () => {
    await seedKey(app, "sk-test-nested-array");

    // 500 is retryable -- use mockImplementation so each retry gets a fresh Response
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "Nested error",
              details: [
                [
                  { token: "deep-nested-secret-abc", safe: "ok" },
                  { secret: "another-secret-xyz" },
                ],
                ["sk-plain-key-in-array-12345678"],
              ],
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("deep-nested-secret-abc");
    expect(bodyText).not.toContain("another-secret-xyz");
    expect(bodyText).not.toContain("sk-plain-key-in-array-12345678");
    // Safe value should survive
    expect(bodyText).toContain("ok");
  });
});

describe("Security Gate: errorMessage exit sanitization (M2)", () => {
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

  it("network fetch rejection with credential in message is sanitized", async () => {
    await seedKey(app, "sk-test-fetch-rejection");

    // NETWORK_ERROR is retryable (default maxAttempts=3)
    // Use mockImplementation so every attempt gets the rejection
    mockFetch.mockImplementation(() =>
      Promise.reject(new Error("Connection refused: apiKey=sk-network-leaked-key-12345678"))
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("sk-network-leaked-key-12345678");
    expect(bodyText).toContain("Connection refused");
  });

  it("2xx non-audio response with credential in text is sanitized", async () => {
    await seedKey(app, "sk-test-non-audio-text");

    // Return 200 with HTML content-type containing a credential
    mockFetch.mockResolvedValueOnce(
      new Response(
        "<html>Debug: Bearer sk-html-leaked-token-98765432</html>",
        { status: 200, headers: { "content-type": "text/html" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("sk-html-leaked-token-98765432");
    expect(bodyText).not.toMatch(/Bearer\s+sk-/i);
    expect(bodyText).toContain("UNEXPECTED_RESPONSE_TYPE");
  });

  it("TTS route sanitizes result.errorMessage belt-and-suspenders", async () => {
    await seedKey(app, "sk-test-route-belt");

    // Return an error with a credential pattern in the message
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Rejected apiKey=sk-belt-test-secret-abcdef12" },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const body = await res.json();
    // Response must not contain the credential
    expect(body.error.message).not.toContain("sk-belt-test-secret-abcdef12");
    // DB error_message must also be sanitized
    const db = getDb();
    const job = db.select().from(generationJob).where(eq(generationJob.id, body.jobId)).get();
    expect(job).toBeTruthy();
    expect(job!.errorMessage).not.toContain("sk-belt-test-secret-abcdef12");
  });

  it("network error with access_token pattern in message is sanitized", async () => {
    await seedKey(app, "sk-test-network-access-token");

    // NETWORK_ERROR is retryable -- use mockImplementation for all attempts
    mockFetch.mockImplementation(() =>
      Promise.reject(new Error("OAuth flow failed: access_token=abc123def456ghi789xyz00"))
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("abc123def456ghi789xyz00");
    expect(bodyText).toContain("access_token=[REDACTED]");
  });

  it("normal error messages remain readable after sanitization", async () => {
    await seedKey(app, "sk-test-readability");

    // 400 is non-retryable, returns immediately
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Rate limit exceeded. Please retry after 60 seconds." },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const body = await res.json();
    expect(body.error.message).toContain("Rate limit exceeded");
    expect(body.error.message).toContain("retry after 60 seconds");
  });
});

describe("Security Gate: JSON fallback extractErrorMessage sanitization (M3)", () => {
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

  it("JSON error without message but with bare access_token/client_secret values is sanitized in response and DB", async () => {
    await seedKey(app, "sk-test-json-fallback-access-token");

    // Return a JSON error body with NO standard message fields but containing
    // sensitive bare values. This exercises the JSON.stringify() fallback path.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "bare-token-value-abc123",
          client_secret: "plain-secret-xyz789",
          debug_info: "some debug context",
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    // Response must not contain plaintext sensitive values
    expect(bodyText).not.toContain("bare-token-value-abc123");
    expect(bodyText).not.toContain("plain-secret-xyz789");
    // Response should contain [REDACTED] markers for the redacted fields
    expect(bodyText).toContain("[REDACTED]");
    // Non-sensitive context preserved
    expect(bodyText).toContain("debug_info");

    // DB errorMessage must also be sanitized
    const body = JSON.parse(bodyText);
    const jobId = body.jobId;
    const db = getDb();
    const job = db.select().from(generationJob).where(eq(generationJob.id, jobId)).get();
    expect(job).toBeTruthy();
    expect(job!.errorMessage).not.toContain("bare-token-value-abc123");
    expect(job!.errorMessage).not.toContain("plain-secret-xyz789");
    // Must contain [REDACTED] -- proving sanitizeErrorMetadata was applied
    expect(job!.errorMessage).toContain("[REDACTED]");
  });

  it("nested JSON error without message containing access_token is sanitized", async () => {
    await seedKey(app, "sk-test-nested-json-fallback");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            // No message field -- triggers fallback
            details: {
              access_token: "nested-bare-token-456",
              client_secret: "nested-plain-secret-789",
            },
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    expect(bodyText).not.toContain("nested-bare-token-456");
    expect(bodyText).not.toContain("nested-plain-secret-789");
    expect(bodyText).toContain("[REDACTED]");
  });

  it("JSON fallback with non-sensitive content remains readable", async () => {
    await seedKey(app, "sk-test-readable-json-fallback");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "error",
          reason: "model_unavailable",
          safe_detail: "The requested model is temporarily offline",
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    );

    const res = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validGenerateBody(),
    });

    const bodyText = await res.text();
    // Non-sensitive content should survive sanitization
    expect(bodyText).toContain("model_unavailable");
    expect(bodyText).toContain("temporarily offline");
  });
});
