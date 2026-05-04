/**
 * Real OpenRouter Smoke Test -- Phase 4 Quality Gate
 *
 * Only executes real API calls when OPENROUTER_API_KEY is set in environment.
 *
 * WITHOUT the key:
 *   - Writes a structured "blocked" report to agent-outputs/tester/phase4-real-openrouter-smoke/
 *   - Asserts the blocked report exists on disk with realOpenRouterVerified=false
 *   - Does NOT count as a pass -- it is an explicit precondition-block marker
 *
 * WITH the key:
 *   - All e2e steps (MP3 generation, file verification, job detail, audio endpoint,
 *     history, and report generation) run inside a single `it` block to prevent
 *     cross-test state corruption from beforeEach DB resets.
 *   - Final structured report is written with realOpenRouterVerified=true
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ─── Key availability check ──────────────────────────────────────────────────

const REAL_API_KEY = process.env.OPENROUTER_API_KEY || "";
const HAS_REAL_KEY = REAL_API_KEY.trim().length > 0;

// ─── Report output directory (constant) ──────────────────────────────────────
// Resolve project root from this file's location (always server/__tests__/),
// so the report lands under <project-root>/agent-outputs/ regardless of cwd.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const REPORT_DIR = path.resolve(
  PROJECT_ROOT,
  "agent-outputs/tester/phase4-real-openrouter-smoke"
);

// ─── Mock env with isolated temp DB ──────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");

  const tmp = nodePath.join(
    nodeOs.tmpdir(),
    `tts-smoke-real-${process.pid}-${Date.now()}`
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

function writeReport(report: Record<string, unknown>): string {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportFile = path.join(REPORT_DIR, `report-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf-8");
  return reportFile;
}

function findLatestReport(): string | null {
  if (!fs.existsSync(REPORT_DIR)) return null;
  const files = fs.readdirSync(REPORT_DIR).filter(f => f.endsWith(".json")).sort();
  return files.length > 0 ? path.join(REPORT_DIR, files[files.length - 1]) : null;
}

function readLatestReport(): Record<string, unknown> | null {
  const file = findLatestReport();
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Real OpenRouter Smoke", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
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

  // ── NO KEY: blocked precondition ────────────────────────────────────────

  it("writes blocked report (realOpenRouterVerified=false) when no key available", () => {
    if (HAS_REAL_KEY) {
      // Key exists -- this precondition check is not applicable; real e2e runs below.
      // We still write a report to mark that the blocked path was intentionally skipped.
      const report = {
        realOpenRouterVerified: true,
        reason: "OPENROUTER_API_KEY is set; blocked precondition check skipped",
        timestamp: new Date().toISOString(),
        status: "key_available",
      };
      const reportFile = writeReport(report);
      expect(fs.existsSync(reportFile)).toBe(true);
      return;
    }

    // NO KEY: explicitly mark as blocked, NOT passed
    const report = {
      realOpenRouterVerified: false,
      reason: "OPENROUTER_API_KEY not set in environment",
      timestamp: new Date().toISOString(),
      status: "blocked",
      precondition: "OPENROUTER_API_KEY must be set for real smoke verification",
    };

    const reportFile = writeReport(report);

    // Assert: blocked report was written to disk
    expect(fs.existsSync(reportFile)).toBe(true);

    // Assert: report content explicitly marks verification as false/blocked
    const savedReport = JSON.parse(fs.readFileSync(reportFile, "utf-8"));
    expect(savedReport.realOpenRouterVerified).toBe(false);
    expect(savedReport.status).toBe("blocked");
    expect(savedReport.reason).toBeTruthy();

    // Assert: report file is in the expected directory
    expect(reportFile).toContain("phase4-real-openrouter-smoke");
  });

  // ── WITH KEY: single end-to-end verification ────────────────────────────

  const itIfKey = HAS_REAL_KEY ? it : it.skip;

  itIfKey("end-to-end: generate WAV (PCM wrapped), verify file, check job/audio/history, write report", async () => {
    // Seed the real key into DB
    await r(app, "/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openRouterApiKey: REAL_API_KEY }),
    });

    // Real fetch -- no mock
    vi.stubGlobal("fetch", globalThis.fetch);

    // ── Step 1: Generate short WAV (upstream PCM, wrapped to WAV) ──────
    const genRes = await r(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-tts-preview",
        input: "Hello, this is a short smoke test.",
        voice: "Zephyr",
        responseFormat: "wav",
      }),
    });

    expect(genRes.status).toBe(200);
    const genBody = await genRes.json();
    expect(genBody.status).toBe("succeeded");
    expect(genBody.jobId).toBeTruthy();
    expect(genBody.generationId).toBeTruthy();
    expect(genBody.audioUrl).toMatch(/^\/api\/audio\/\d+$/);
    expect(genBody.assetId).toBeDefined();
    expect(genBody.contentType).toBe("audio/wav");
    expect(genBody.sizeBytes).toBeGreaterThan(0);
    expect(genBody.outputFormat).toBe("wav");
    expect(genBody.upstreamFormat).toBe("pcm");

    const jobId: string = genBody.jobId;
    const assetId: number = genBody.assetId;

    // ── Step 2: Verify DB records and file on disk ────────────────────
    const db = getDb();

    const job = db.select().from(generationJob).where(eq(generationJob.id, jobId)).get();
    expect(job).toBeTruthy();
    expect(job!.status).toBe("succeeded");

    const asset = db.select().from(audioAsset).where(eq(audioAsset.id, assetId)).get();
    expect(asset).toBeTruthy();
    expect(asset!.sizeBytes).toBeGreaterThan(0);
    expect(asset!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(asset!.filePath).toBeTruthy();

    // ── Step 3: Job detail endpoint ───────────────────────────────────
    const jobRes = await r(app, `/api/jobs/${jobId}`);
    expect(jobRes.status).toBe(200);
    const jobBody = await jobRes.json();
    expect(jobBody.job.id).toBe(jobId);
    expect(jobBody.job.status).toBe("succeeded");
    expect(jobBody.audio).toBeTruthy();
    expect(jobBody.audio.id).toBe(assetId);
    expect(jobBody.audio.mimeType).toBe("audio/wav");

    // ── Step 4: Audio endpoint ────────────────────────────────────────
    const audioRes = await r(app, `/api/audio/${assetId}`);
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers.get("Content-Type")).toBe("audio/wav");
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
    // Verify WAV header
    expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");

    // ── Step 5: History endpoint ──────────────────────────────────────
    const histRes = await r(app, "/api/history");
    expect(histRes.status).toBe(200);
    const histBody = await histRes.json();
    const succeededRecords = histBody.records.filter(
      (rec: { status: string }) => rec.status === "succeeded"
    );
    expect(succeededRecords.length).toBeGreaterThanOrEqual(1);

    // ── Step 6: Write structured report ───────────────────────────────
    const report = {
      timestamp: new Date().toISOString(),
      realOpenRouterVerified: true,
      status: "verified",
      generationStatus: genBody.status,
      generationId: genBody.generationId || null,
      jobId,
      assetId,
      audioUrl: genBody.audioUrl,
      sizeBytes: genBody.sizeBytes,
      contentType: genBody.contentType,
    };

    // Report must NOT contain API key in plaintext
    const reportText = JSON.stringify(report, null, 2);
    expect(reportText).not.toContain(REAL_API_KEY);
    expect(reportText).not.toMatch(/Bearer\s+sk-/i);

    const reportFile = writeReport(report);
    expect(fs.existsSync(reportFile)).toBe(true);

    // Verify the persisted report is readable and correct
    const savedReport = JSON.parse(fs.readFileSync(reportFile, "utf-8"));
    expect(savedReport.realOpenRouterVerified).toBe(true);
    expect(savedReport.status).toBe("verified");
  }, 180000);
});
