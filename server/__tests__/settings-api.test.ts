/**
 * Settings API, Health API, and Key Security Tests
 *
 * Covers:
 * - Key safety: GET never returns plaintext, PUT stores encrypted
 * - Health: providerConfigured reflects key state
 * - Key resolver: DB-first resolution
 */

import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Mock env module with isolated temp directory ────────────────────────────
// vi.hoisted ensures variables are available in the hoisted vi.mock factory.

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");

  const tmp = nodePath.join(
    nodeOs.tmpdir(),
    `tts-settings-${process.pid}-${Date.now()}`
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

  function key(): Buffer {
    return crypto.scryptSync(testDbPath, SALT, 32);
  }

  function encryptApiKey(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LEN);
    const c = crypto.createCipheriv(ALGO, key(), iv);
    const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }

  function decryptApiKey(ct: string): string | null {
    try {
      const raw = Buffer.from(ct, "base64");
      const d = crypto.createDecipheriv(
        ALGO,
        key(),
        raw.subarray(0, IV_LEN)
      );
      d.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
      return (
        d.update(raw.subarray(IV_LEN + TAG_LEN)) + d.final("utf8")
      );
    } catch {
      return null;
    }
  }

  function maskApiKey(k: string): string {
    return k.length > 12
      ? `${k.slice(0, 3)}***...***${k.slice(-4)}`
      : "***configured***";
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
    requireEnvApiKey: () => {
      throw new Error("OPENROUTER_API_KEY is not configured");
    },
  };
});

// ─── Imports (resolve against mocked env) ────────────────────────────────────

import { initSchema, closeDb, getDb } from "../src/db/index.js";
import { settings } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import settingsRoutes from "../src/routes/settings.js";
import healthRoutes from "../src/routes/health.js";
import { resolveApiKey, isOpenRouterConfigured } from "../src/services/key-resolver.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createApp(): Hono {
  const app = new Hono();
  app.route("/", settingsRoutes);
  app.route("/", healthRoutes);
  return app;
}

function req(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Settings API", () => {
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

  // ── GET /api/settings ────────────────────────────────────────────────────

  describe("GET /api/settings", () => {
    it("returns defaults when no settings row exists", async () => {
      const res = await req(app, "/api/settings");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.hasOpenRouterApiKey).toBe(false);
      expect(body.keyMask).toBeNull();
      expect(body.defaultModel).toBe("google/gemini-3.1-flash-tts-preview");
      expect(body.defaultVoice).toBe("Zephyr");
      expect(body.defaultFormat).toBe("mp3");
    });

    it("never exposes plaintext API key in any response field", async () => {
      // Arrange: store a key via PUT
      const secret = "sk-super-secret-key-12345678";
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: secret }),
      });

      // Act
      const res = await req(app, "/api/settings");
      const body = await res.json();

      // Assert: key is masked, plaintext never appears
      expect(body.hasOpenRouterApiKey).toBe(true);
      expect(body.keyMask).toContain("***");
      expect(body.keyMask).not.toContain(secret);
      // openRouterApiKey backward-compat field must also be masked
      expect(body.openRouterApiKey).toBe(body.keyMask);
      // Entire response body must not contain plaintext
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(secret);
    });

    it("shows hasOpenRouterApiKey=false after key is cleared", async () => {
      // Set then clear
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "sk-test-key-12345678" }),
      });
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "" }),
      });

      const res = await req(app, "/api/settings");
      const body = await res.json();
      expect(body.hasOpenRouterApiKey).toBe(false);
      expect(body.keyMask).toBeNull();
    });
  });

  // ── PUT /api/settings ────────────────────────────────────────────────────

  describe("PUT /api/settings", () => {
    it("saves key and subsequent GET returns masked version", async () => {
      const res = await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "sk-test-key-12345678" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.openRouterKeySaved).toBe(true);

      // Verify via GET
      const getRes = await req(app, "/api/settings");
      const getBody = await getRes.json();
      expect(getBody.hasOpenRouterApiKey).toBe(true);
      expect(getBody.keyMask).toMatch(/^sk-\*{3}\.\.\.\*{3}\d{4}$/);
    });

    it("stores key encrypted in DB (never plaintext)", async () => {
      const secret = "sk-my-secret-key-999";
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: secret }),
      });

      const db = getDb();
      const row = db
        .select()
        .from(settings)
        .where(eq(settings.id, 1))
        .get();

      // Stored value is NOT plaintext
      expect(row!.openRouterApiKey).not.toBe(secret);
      expect(row!.openRouterApiKey).not.toBeNull();
      // Should be base64 (encrypted blob)
      expect(row!.openRouterApiKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("clears key when empty string sent", async () => {
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "sk-test-key-12345678" }),
      });
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "" }),
      });

      const db = getDb();
      const row = db
        .select()
        .from(settings)
        .where(eq(settings.id, 1))
        .get();
      expect(row!.openRouterApiKey).toBeNull();
    });

    it("rejects invalid maxCharsPerRequest (negative)", async () => {
      const res = await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxCharsPerRequest: -1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("rejects invalid maxCharsPerRequest (over 50000)", async () => {
      const res = await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxCharsPerRequest: 99999 }),
      });

      expect(res.status).toBe(400);
    });

    it("saves valid non-key settings and persists", async () => {
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: "google/gemini-2.5-flash-tts",
          defaultVoice: "Puck",
          maxCharsPerRequest: 10000,
        }),
      });

      const res = await req(app, "/api/settings");
      const body = await res.json();
      expect(body.defaultModel).toBe("google/gemini-2.5-flash-tts");
      expect(body.defaultVoice).toBe("Puck");
      expect(body.maxCharsPerRequest).toBe(10000);
    });
  });

  // ── POST /api/settings/test ──────────────────────────────────────────────

  describe("POST /api/settings/test", () => {
    it("returns MISSING_API_KEY when no key configured", async () => {
      const res = await req(app, "/api/settings/test", { method: "POST" });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("MISSING_API_KEY");
    });
  });

  // ── GET /api/health ──────────────────────────────────────────────────────

  describe("GET /api/health", () => {
    it("returns providerConfigured=false when no key anywhere", async () => {
      const res = await req(app, "/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.providerConfigured).toBe(false);
      expect(body.openRouterConfigured).toBe(false);
    });

    it("returns providerConfigured=true when key stored in DB", async () => {
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "sk-test-key-12345678" }),
      });

      const res = await req(app, "/api/health");
      const body = await res.json();
      expect(body.providerConfigured).toBe(true);
      expect(body.openRouterConfigured).toBe(true);
    });

    it("/api/runtime/health alias works identically", async () => {
      const res = await req(app, "/api/runtime/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });
  });

  // ── Key Resolver ─────────────────────────────────────────────────────────

  describe("Key Resolver", () => {
    it("resolveApiKey returns null when nothing configured", () => {
      expect(resolveApiKey()).toBeNull();
    });

    it("resolveApiKey returns plaintext from DB after PUT", async () => {
      const secret = "sk-db-key-12345678";
      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: secret }),
      });

      const resolved = resolveApiKey();
      expect(resolved).toBe(secret);
    });

    it("isOpenRouterConfigured reflects key state", async () => {
      expect(isOpenRouterConfigured()).toBe(false);

      await req(app, "/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openRouterApiKey: "sk-test-12345678" }),
      });

      expect(isOpenRouterConfigured()).toBe(true);
    });
  });
});
