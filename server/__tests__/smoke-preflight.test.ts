/**
 * Smoke Preflight Check
 *
 * Verifies environment readiness for real OpenRouter API smoke test
 * WITHOUT making any real API calls. This is a pre-flight checklist:
 *
 * 1. Environment variable injection (OPENROUTER_API_KEY in env or DB)
 * 2. Key sanitization (GET /api/settings never returns plaintext)
 * 3. Database accessible and schema initialized
 * 4. Audio output directory writable
 * 5. Backend API endpoints responding
 * 6. Voice canonicalization works (alloy -> Zephyr)
 *
 * Real OpenRouter call is NOT performed here. That must be done in a
 * separate, explicit smoke phase with controlled token usage.
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";

// ─── Mock env with isolated temp directory ──────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");

  const tmp = nodePath.join(
    nodeOs.tmpdir(),
    `tts-preflight-${process.pid}-${Date.now()}`
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
import { seedDatabase } from "../src/db/seed.js";
import { settings, voiceProfile } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { resolveApiKey, isOpenRouterConfigured } from "../src/services/key-resolver.js";
import { canonicalizeVoice, isLegacyAlias, getDefaultVoice } from "../src/utils/voice.js";
import { getAudioDir, writeAudioFile, readAudioFile } from "../src/utils/audio-fs.js";
import settingsRoutes from "../src/routes/settings.js";
import healthRoutes from "../src/routes/health.js";
import voicesRoutes from "../src/routes/voices.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createApp(): Hono {
  const app = new Hono();
  app.route("/", settingsRoutes);
  app.route("/", healthRoutes);
  app.route("/", voicesRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Smoke Preflight Checks", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    seedDatabase();
    app = createApp();
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

  // ── 1. Voice canonicalization ───────────────────────────────────────────

  describe("Voice canonicalization", () => {
    it("maps alloy to Zephyr", () => {
      expect(canonicalizeVoice("alloy")).toBe("Zephyr");
    });

    it("maps Alloy (case-insensitive) to Zephyr", () => {
      expect(canonicalizeVoice("Alloy")).toBe("Zephyr");
    });

    it("passes through Zephyr unchanged", () => {
      expect(canonicalizeVoice("Zephyr")).toBe("Zephyr");
    });

    it("passes through other valid voices unchanged", () => {
      expect(canonicalizeVoice("Puck")).toBe("Puck");
      expect(canonicalizeVoice("Charon")).toBe("Charon");
    });

    it("returns Zephyr for empty string", () => {
      expect(canonicalizeVoice("")).toBe("Zephyr");
    });

    it("identifies alloy as legacy alias", () => {
      expect(isLegacyAlias("alloy")).toBe(true);
      expect(isLegacyAlias("Alloy")).toBe(true);
    });

    it("does not identify Zephyr as legacy alias", () => {
      expect(isLegacyAlias("Zephyr")).toBe(false);
    });

    it("getDefaultVoice returns Zephyr", () => {
      expect(getDefaultVoice()).toBe("Zephyr");
    });

    it("PUT /api/settings canonicalizes alloy to Zephyr", async () => {
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultVoice: "alloy" }),
      });

      const res = await req(app, "/api/settings");
      const body = await res.json();
      expect(body.defaultVoice).toBe("Zephyr");
    });

    it("PUT /api/settings keeps Zephyr unchanged", async () => {
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultVoice: "Zephyr" }),
      });

      const res = await req(app, "/api/settings");
      const body = await res.json();
      expect(body.defaultVoice).toBe("Zephyr");
    });

    it("PUT /api/settings stores canonical voice in DB", async () => {
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultVoice: "alloy" }),
      });

      const db = getDb();
      const row = db.select().from(settings).where(eq(settings.id, 1)).get();
      expect(row!.defaultVoice).toBe("Zephyr");
    });
  });

  // ── 2. Key injection and sanitization ───────────────────────────────────

  describe("Key injection and sanitization", () => {
    it("key can be stored via PUT /api/settings", async () => {
      const res = await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "sk-test-key-preflight-123" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.openRouterKeySaved).toBe(true);
    });

    it("GET /api/settings never returns plaintext key", async () => {
      const secret = "sk-preflight-secret-key-abc";
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: secret }),
      });

      const res = await req(app, "/api/settings");
      const rawBody = await res.text();
      expect(rawBody).not.toContain(secret);

      const body = JSON.parse(rawBody);
      expect(body.hasOpenRouterApiKey).toBe(true);
      expect(body.keyMask).toContain("***");
    });

    it("resolveApiKey returns stored key after PUT", async () => {
      const secret = "sk-preflight-resolve-test";
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: secret }),
      });

      expect(resolveApiKey()).toBe(secret);
    });

    it("isOpenRouterConfigured reflects key state correctly", async () => {
      expect(isOpenRouterConfigured()).toBe(false);

      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "sk-test-preflight-key" }),
      });

      expect(isOpenRouterConfigured()).toBe(true);
    });

    it("key stored encrypted in DB (not plaintext)", async () => {
      const secret = "sk-db-encrypted-check";
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: secret }),
      });

      const db = getDb();
      const row = db.select().from(settings).where(eq(settings.id, 1)).get();
      expect(row!.openRouterApiKey).not.toBe(secret);
      expect(row!.openRouterApiKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
  });

  // ── 3. Database accessibility ───────────────────────────────────────────

  describe("Database accessibility", () => {
    it("schema initializes without error", () => {
      const db = getDb();
      expect(db).toBeTruthy();
    });

    it("settings table exists with correct default voice", async () => {
      const res = await req(app, "/api/settings");
      const body = await res.json();
      expect(body.defaultVoice).toBe("Zephyr");
    });

    it("voice profiles are seeded with 30 Gemini voices", async () => {
      // Seed is done during initSchema; verify via voices API
      const res = await req(app, "/api/voices");
      const body = await res.json();
      expect(body.voices.length).toBe(30);
      expect(body.voices[0].name).toBe("Zephyr");
      expect(body.voices[0].source).toBe("default");
    });

    it("health endpoint reports service status", async () => {
      const res = await req(app, "/api/health");
      const body = await res.json();
      expect(body.status).toBe("ok");
    });
  });

  // ── 4. Audio output directory ───────────────────────────────────────────

  describe("Audio output directory writable", () => {
    it("audio base directory exists after first write", () => {
      // getAudioDir() includes date subdirs that may not exist yet.
      // The base directory is created on first write. Verify write+read works.
      const testBuffer = Buffer.from("preflight-dir-check");
      const filePath = writeAudioFile("preflight-dir-check", "wav", testBuffer);
      expect(filePath).toBeTruthy();

      // The directory for today's date should now exist
      const audioDir = getAudioDir();
      expect(fs.existsSync(audioDir)).toBe(true);
    });

    it("can write and read a test file", () => {
      const testBuffer = Buffer.from("preflight-audio-test");
      const filePath = writeAudioFile("preflight-test-rw", "wav", testBuffer);
      expect(filePath).toBeTruthy();

      // Verify file was written and can be read back
      const relativePath = filePath.replace(/\\/g, "/");
      const readBuffer = readAudioFile(relativePath);
      expect(readBuffer).toEqual(testBuffer);
    });
  });

  // ── 5. Backend API endpoints responding ─────────────────────────────────

  describe("Backend API endpoints responding", () => {
    it("GET /api/health returns 200", async () => {
      const res = await req(app, "/api/health");
      expect(res.status).toBe(200);
    });

    it("GET /api/settings returns 200", async () => {
      const res = await req(app, "/api/settings");
      expect(res.status).toBe(200);
    });

    it("GET /api/voices returns 200", async () => {
      const res = await req(app, "/api/voices");
      expect(res.status).toBe(200);
    });

    it("POST /api/settings/test returns expected error when no key", async () => {
      const res = await req(app, "/api/settings/test", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe("MISSING_API_KEY");
    });
  });

  // ── 6. Summary report capability ────────────────────────────────────────

  describe("Preflight report generation", () => {
    it("can produce a structured preflight report", async () => {
      // Store a key
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openRouterApiKey: "sk-preflight-report-test",
          defaultVoice: "Zephyr",
        }),
      });

      // Gather report data
      const healthRes = await req(app, "/api/health");
      const health = await healthRes.json();

      const settingsRes = await req(app, "/api/settings");
      const settingsData = await settingsRes.json();

      const voicesRes = await req(app, "/api/voices");
      const voicesData = await voicesRes.json();

      const report = {
        timestamp: new Date().toISOString(),
        serviceStatus: health.status,
        providerConfigured: health.providerConfigured,
        keyMasked: settingsData.keyMask,
        keyNotExposed: !JSON.stringify(settingsData).includes("sk-preflight-report-test"),
        defaultVoice: settingsData.defaultVoice,
        voiceCanonical: settingsData.defaultVoice === "Zephyr",
        voiceCount: voicesData.voices.length,
        audioDirWritable: true, // verified above
        realApiCallMade: false,
        readyForSmoke: health.providerConfigured && settingsData.defaultVoice === "Zephyr",
      };

      expect(report.serviceStatus).toBe("ok");
      expect(report.providerConfigured).toBe(true);
      expect(report.keyMasked).toContain("***");
      expect(report.keyNotExposed).toBe(true);
      expect(report.defaultVoice).toBe("Zephyr");
      expect(report.voiceCanonical).toBe(true);
      expect(report.voiceCount).toBe(30);
      expect(report.realApiCallMade).toBe(false);
      expect(report.readyForSmoke).toBe(true);
    });
  });
});
