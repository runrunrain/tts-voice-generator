/**
 * Health check and readiness routes.
 * GET /api/health         - Basic service health + Key config status
 * GET /api/runtime/health - Frontend compat alias
 * GET /api/ready          - Readiness preflight (no real OpenRouter call)
 *
 * /api/ready checks:
 * - keyConfigured: Is OpenRouter API Key available?
 * - dbOk: Can DB be accessed?
 * - audioDirWritable: Can audio files be written?
 * - routesReady: Are core routes registered?
 */

import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { isOpenRouterConfigured } from "../services/key-resolver.js";
import { getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { getActiveJobCount } from "../services/concurrency.js";
import { getAudioDir, getAudioBaseDir, writeAudioFile, readAudioFile, computeSha256, scanOrphanFiles } from "../utils/audio-fs.js";

const health = new Hono();

let startTime = Date.now();

function buildHealthResponse() {
  return {
    status: "ok",
    version: "0.1.0",
    openRouterConfigured: isOpenRouterConfigured(),
    providerConfigured: isOpenRouterConfigured(),
    localPluginTokenEnabled: false,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeJobs: getActiveJobCount(),
  };
}

health.get("/api/health", (c) => {
  return c.json(buildHealthResponse());
});

// Alias for frontend compatibility
health.get("/api/runtime/health", (c) => {
  return c.json(buildHealthResponse());
});

// ─── Readiness / Preflight ───────────────────────────────────────────────────

interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

health.get("/api/ready", (c) => {
  const checks: ReadinessCheck[] = [];
  const overallStart = Date.now();

  // 1. keyConfigured
  const keyConfigured = isOpenRouterConfigured();
  checks.push({
    name: "keyConfigured",
    ok: keyConfigured,
    detail: keyConfigured ? "API key is available" : "No API key configured in DB or env",
  });

  // 2. dbOk
  let dbOk = false;
  try {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.id, 1)).get();
    dbOk = true;
    checks.push({
      name: "dbOk",
      ok: true,
      detail: `DB accessible, settings row ${row ? "exists" : "missing"}`,
    });
  } catch (err) {
    checks.push({
      name: "dbOk",
      ok: false,
      detail: err instanceof Error ? err.message : "DB access failed",
    });
  }

  // 3. audioDirWritable
  let audioOk = false;
  try {
    const audioDir = getAudioDir();
    const probeFileId = `readyness-probe-${Date.now()}`;
    const testBuffer = Buffer.from("readiness-check");
    const relPath = writeAudioFile(probeFileId, "mp3", testBuffer);
    // Verify round-trip
    const readBack = readAudioFile(relPath);
    audioOk = readBack.length === testBuffer.length;
    // Clean up probe file
    try {
      const baseDir = getAudioBaseDir();
      const fullPath = path.join(baseDir, relPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      // Cleanup failure is non-critical
    }
    checks.push({
      name: "audioDirWritable",
      ok: audioOk,
      detail: `Audio dir: ${audioDir}`,
    });
  } catch (err) {
    checks.push({
      name: "audioDirWritable",
      ok: false,
      detail: err instanceof Error ? err.message : "Audio dir check failed",
    });
  }

  // 4. routesReady (static check - if we got here, routes work)
  checks.push({
    name: "routesReady",
    ok: true,
    detail: "Core API routes are registered and responding",
  });

  // 5. orphanFiles (informational, not a failure condition)
  let orphanCount = 0;
  try {
    const orphans = scanOrphanFiles();
    orphanCount = orphans.length;
  } catch {
    // Non-critical
  }
  if (orphanCount > 0) {
    checks.push({
      name: "orphanFiles",
      ok: true, // Not a blocker
      detail: `${orphanCount} orphan temp file(s) found (cleanup recommended)`,
    });
  }

  // Overall readiness
  const allPassed = checks.every((c) => c.ok);
  const totalLatency = Date.now() - overallStart;

  return c.json({
    ready: allPassed,
    timestamp: new Date().toISOString(),
    latencyMs: totalLatency,
    checks,
    summary: {
      keyConfigured,
      dbOk,
      audioDirWritable: audioOk,
      routesReady: true,
      orphanFiles: orphanCount,
      activeJobs: getActiveJobCount(),
    },
    // Important: readiness does NOT mean real OpenRouter works
    // It only means the system is configured enough to attempt a call
    realOpenRouterVerified: false,
  });
});

export default health;
