/**
 * Audio Path Security Tests
 *
 * Covers:
 * - /api/audio/:assetId input validation (non-numeric, negative, non-existent)
 * - readAudioFile path traversal rejection
 * - readAudioFile accepts valid paths
 * - No arbitrary file read via audio endpoint
 */

import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
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
    `tts-audio-${process.pid}-${Date.now()}`
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
import historyRoutes from "../src/routes/history.js";
import { readAudioFile } from "../src/utils/audio-fs.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createApp(): Hono {
  const app = new Hono();
  app.route("/", historyRoutes);
  return app;
}

function r(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Audio Path Security", () => {
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

  // ── GET /api/audio/:assetId ──────────────────────────────────────────────

  describe("GET /api/audio/:assetId", () => {
    it("rejects non-numeric assetId with 400", async () => {
      const res = await r(app, "/api/audio/abc");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid");
    });

    it("rejects path-traversal assetId (e.g. ../etc/passwd)", async () => {
      const res = await r(app, "/api/audio/..%2F..%2Fetc%2Fpasswd");
      // Hono decodes the param; parseInt("../../etc/passwd") = NaN
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent asset ID", async () => {
      const res = await r(app, "/api/audio/99999");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("not found");
    });

    it("returns 404 for negative asset ID", async () => {
      const res = await r(app, "/api/audio/-1");
      expect(res.status).toBe(404);
    });

    it("returns 404 when asset exists in DB but file missing on disk", async () => {
      // Insert a job + asset record
      const db = getDb();
      db.insert(generationJob).values({
        id: "test-job-audio-1",
        model: "google/gemini-3.1-flash-tts-preview",
        voice: "Zephyr",
        responseFormat: "mp3",
        input: "test",
        inputCharCount: 4,
        status: "succeeded",
        source: "user",
        createdAt: new Date(),
      }).run();

      const result = db.insert(audioAsset).values({
        jobId: "test-job-audio-1",
        fileName: "test.mp3",
        filePath: "data/audio/nonexistent/test.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 100,
        sha256: "abc123",
        duration: "1.0s",
        createdAt: new Date(),
      }).run();

      const assetId = Number(result.lastInsertRowid);
      const res = await r(app, `/api/audio/${assetId}`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });
  });

  // ── readAudioFile path traversal ─────────────────────────────────────────

  describe("readAudioFile path traversal guard", () => {
    it("rejects ../../etc/passwd", () => {
      expect(() => readAudioFile("../../etc/passwd")).toThrow(
        /path traversal/i
      );
    });

    it("rejects absolute path outside audio dir", () => {
      expect(() => readAudioFile("/etc/passwd")).toThrow(/path traversal/i);
    });

    it("rejects ../../../windows/system32/config/sam", () => {
      expect(() =>
        readAudioFile("../../../windows/system32/config/sam")
      ).toThrow(/path traversal/i);
    });

    it("throws 'not found' for valid path but missing file", () => {
      // This path is under ./data/audio/ so it passes traversal check
      // but the file doesn't exist
      expect(() =>
        readAudioFile("data/audio/2026/01/01/nonexistent.mp3")
      ).toThrow(/not found/i);
    });
  });

  // ── GET /api/history smoke ───────────────────────────────────────────────

  describe("GET /api/history", () => {
    it("returns empty records for fresh DB", async () => {
      const res = await r(app, "/api/history");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.records).toEqual([]);
      expect(body.totalPages).toBe(1);
      expect(body.totalRecords).toBe(0);
    });
  });
});
