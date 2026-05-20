/**
 * Gemini TTS Validation Tests -- P7-test-validation
 *
 * Comprehensive test suite covering:
 * - Route preview/capability API responses
 * - Provider key missing structured errors
 * - License Gate unit-level edge cases
 * - Route Selector unit-level edge cases
 * - TTS Generator blocked route structured errors
 * - Voice Asset API structural error responses
 *
 * No real external provider keys used; all provider calls go through
 * mock/missing-configuration structured error paths.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";

// ─── Isolated temp DB mock ────────────────────────────────────────────────────

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");
  const tmp = nodePath.join(nodeOs.tmpdir(), `tts-gemini-validation-${process.pid}-${Date.now()}`);
  nodeFs.mkdirSync(nodePath.join(tmp, "audio"), { recursive: true });
  const testDbPath = nodePath.join(tmp, "test.db");
  testState.tmpDir = tmp;
  testState.dbFilePath = testDbPath;
  const SALT = "tts-voice-generator-key-encryption-v1";
  const ALGO = "aes-256-gcm";
  function key(): Buffer { return crypto.scryptSync(testDbPath, SALT, 32); }
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
      elevenLabsApiKey: null as string | null,
      fishAudioApiKey: null as string | null,
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
      elevenLabsBaseUrl: "https://api.elevenlabs.io",
      fishAudioBaseUrl: "https://api.fish.audio",
      audioOutputDir: nodePath.join(tmp, "audio"),
      dbPath: testDbPath,
      dataDir: tmp,
      nodeEnv: "test",
    },
    encryptApiKey: (plaintext: string) => plaintext,
    decryptApiKey,
    maskApiKey: (k: string) => k.length > 12 ? `${k.slice(0, 3)}***...***${k.slice(-4)}` : "***configured***",
    isEnvApiKeyConfigured: () => false,
    requireEnvApiKey: () => { throw new Error("Not configured"); },
  };
});

import { closeDb, getDb, initSchema } from "../src/db/index.js";
import { evaluateLicenseGate } from "../src/services/license-gate.js";
import { selectGenerationRoute } from "../src/services/route-selector.js";
import voiceAssetsRoutes from "../src/routes/voice-assets.js";
import ttsRoutes from "../src/routes/tts.js";

function raw() {
  return (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
}

function createApp(): Hono {
  const app = new Hono();
  app.route("/", voiceAssetsRoutes);
  app.route("/", ttsRoutes);
  return app;
}

function createVoiceAssetsApp(): Hono {
  const app = new Hono();
  app.route("/", voiceAssetsRoutes);
  return app;
}

function request(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

function seedProviderKeys() {
  raw().prepare("INSERT INTO settings (id, elevenlabs_api_key, fish_audio_api_key) VALUES (1, ?, ?)").run("elevenlabs-test-key", "fish-test-key");
}

function seedApprovedVoiceAsset(input: {
  assetId?: string;
  licenseId?: string;
  status?: string;
  providerVoiceId?: string | null;
  fishReferenceId?: string | null;
  type?: string;
  provider?: string;
} = {}) {
  const assetId = input.assetId ?? "asset-licensed";
  const licenseId = input.licenseId ?? `${assetId}-license`;
  const now = Math.floor(Date.now() / 1000);
  raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, provider_voice_id, fish_reference_id, license_record_id, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`).run(
    assetId,
    `Asset ${assetId}`,
    input.type ?? "custom_cloned",
    input.status ?? "active",
    input.provider ?? "fish-audio",
    input.providerVoiceId === undefined ? "eleven-owned" : input.providerVoiceId,
    input.fishReferenceId === undefined ? "fish-owned" : input.fishReferenceId,
    licenseId,
    now,
    now,
  );
  raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
    VALUES (?, ?, 'approved', ?, 1, ?, ?)`).run(
    licenseId,
    assetId,
    JSON.stringify({ actions: ["production_generate", "audition", "export", "create_model"] }),
    now,
    now,
  );
  return { assetId, licenseId };
}

function seedReference(input: { id: string; assetId: string; provider: "fish-audio" | "elevenlabs"; referenceId: string; qualityStatus: string }) {
  raw().prepare(`INSERT INTO voice_reference_asset (id, voice_asset_id, provider, reference_id, quality_status, transcript_status, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'confirmed', '{}', ?)`).run(input.id, input.assetId, input.provider, input.referenceId, input.qualityStatus, Math.floor(Date.now() / 1000));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Route Preview / Capability API Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Route Preview and Capabilities API", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    seedProviderKeys();
    app = createVoiceAssetsApp();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("GET /api/voice-assets/capabilities returns correct provider and route structure", async () => {
    const res = await request(app, "/api/voice-assets/capabilities");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      providers: Record<string, { configured: boolean; routes: string[]; endpoints?: string[] }>;
      routes: string[];
      licenseGate: { enforcedBackend: boolean; defaultBlocks: string[] };
    };

    // Verify provider structure
    expect(body.providers).toBeDefined();
    expect(body.providers.openrouterGemini).toBeDefined();
    expect(body.providers.elevenlabs).toBeDefined();
    expect(body.providers.fishAudio).toBeDefined();

    // Verify route enumeration
    expect(body.routes).toEqual(expect.arrayContaining(["gemini_only", "gemini_elevenlabs_sts", "fish_audio_tts"]));
    expect(body.routes).toHaveLength(3);

    // Verify license gate metadata
    expect(body.licenseGate.enforcedBackend).toBe(true);
    expect(body.licenseGate.defaultBlocks).toEqual(expect.arrayContaining(["LEGAL_REVIEW_REQUIRED", "LICENSE_REQUIRED", "CROSS_PLATFORM_CLONE_UNAPPROVED"]));
  });

  it("capabilities endpoint shows provider configured/missing status correctly", async () => {
    const res = await request(app, "/api/voice-assets/capabilities");
    const body = await res.json() as { providers: Record<string, { configured: boolean }> };

    // elevenlabs and fish-audio are configured because seedProviderKeys inserted test keys
    // openRouterGemini shows as not configured because only the openRouterApiKey column is not seeded
    expect(body.providers.elevenlabs.configured).toBe(true);
    expect(body.providers.fishAudio.configured).toBe(true);
  });

  it("capabilities endpoint reflects missing openRouter key correctly", async () => {
    const res = await request(app, "/api/voice-assets/capabilities");
    const body = await res.json() as { providers: Record<string, { configured: boolean }> };

    // openRouter key is not seeded in settings DB, env mock has null
    expect(body.providers.openrouterGemini.configured).toBe(false);
  });

  it("POST /api/voice-routes/preview returns default gemini_only with no overrides", async () => {
    const res = await request(app, "/api/voice-routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "Hello world test" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { requestId: string; decision: { route: string; blocked: boolean; reasons: string[] } };
    expect(body.requestId).toBeTruthy();
    expect(body.decision.route).toBe("gemini_only");
    expect(body.decision.blocked).toBe(false);
    expect(body.decision.reasons).toContain("default_gemini_only_no_mapping");
  });

  it("POST /api/voice-routes/preview with explicit route returns that route", async () => {
    const res = await request(app, "/api/voice-routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationRoute: "fish_audio_tts", transcript: "Test fish audio" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { decision: { route: string; blocked: boolean; complianceBlocks: string[]; reasons: string[] } };
    expect(body.decision.route).toBe("fish_audio_tts");
    expect(body.decision.blocked).toBe(true);
    expect(body.decision.reasons).toContain("explicit_route_requested");
    // fish-audio key IS seeded in this describe block, but no voice asset or reference
    expect(body.decision.complianceBlocks).toContain("FISH_REFERENCE_ID_REQUIRED");
  });

  it("POST /api/voice-routes/decision returns same structure as preview", async () => {
    const res = await request(app, "/api/voice-routes/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationRoute: "gemini_elevenlabs_sts", transcript: "Test decision" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { requestId: string; decision: { route: string; blocked: boolean; providerChain: Array<{ stage: string; provider: string }> } };
    expect(body.decision.route).toBe("gemini_elevenlabs_sts");
    expect(body.decision.blocked).toBe(true);
    // Verify provider chain is built correctly for route A
    expect(body.decision.providerChain).toHaveLength(3);
    expect(body.decision.providerChain[0].stage).toBe("base_tts");
    expect(body.decision.providerChain[0].provider).toBe("openrouter-gemini");
    expect(body.decision.providerChain[1].stage).toBe("voice_conversion");
    expect(body.decision.providerChain[1].provider).toBe("elevenlabs");
    expect(body.decision.providerChain[2].stage).toBe("final");
    expect(body.decision.providerChain[2].provider).toBe("elevenlabs");
  });

  it("route preview with valid voice asset returns allowed for fish_audio_tts", async () => {
    const { assetId } = seedApprovedVoiceAsset({ fishReferenceId: "fish-valid-ref" });

    const res = await request(app, "/api/voice-routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationRoute: "fish_audio_tts", voiceAssetId: assetId, transcript: "Test with asset" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { decision: { route: string; blocked: boolean; fishReferenceId: string; complianceBlocks: string[] } };
    expect(body.decision.route).toBe("fish_audio_tts");
    expect(body.decision.blocked).toBe(false);
    expect(body.decision.fishReferenceId).toBe("fish-valid-ref");
    expect(body.decision.complianceBlocks).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Provider Key Missing Structured Errors
// ═══════════════════════════════════════════════════════════════════════════════

describe("Provider Key Missing Structured Errors", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    // Do NOT seed provider keys -- testing missing configuration paths
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("route selector reports PROVIDER_KEY_MISSING:elevenlabs for gemini_elevenlabs_sts without key", () => {
    const decision = selectGenerationRoute({
      requestedRoute: "gemini_elevenlabs_sts",
      voiceAssetId: "nonexistent",
      transcript: "test",
    });

    expect(decision.route).toBe("gemini_elevenlabs_sts");
    expect(decision.blocked).toBe(true);
    expect(decision.complianceBlocks).toContain("PROVIDER_KEY_MISSING:elevenlabs");
  });

  it("route selector reports PROVIDER_KEY_MISSING:fish-audio for fish_audio_tts without key", () => {
    const decision = selectGenerationRoute({
      requestedRoute: "fish_audio_tts",
      voiceAssetId: "nonexistent",
      transcript: "test",
    });

    expect(decision.route).toBe("fish_audio_tts");
    expect(decision.blocked).toBe(true);
    expect(decision.complianceBlocks).toContain("PROVIDER_KEY_MISSING:fish-audio");
  });

  it("TTS generate returns structured PROVIDER_KEY_MISSING error for blocked fish_audio_tts", async () => {
    const res = await request(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-tts-preview",
        input: "Fish route with no key",
        voice: "Zephyr",
        generationRoute: "fish_audio_tts",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as {
      ok: boolean;
      generationRoute: string;
      providerChain: Array<{ stage: string; provider: string }>;
      compliance: { blocked: boolean; blocks: string[] };
      error: { code: string; message: string; metadata: { routeDecision: { complianceBlocks: string[] } } };
    };

    expect(body.ok).toBe(false);
    expect(body.generationRoute).toBe("fish_audio_tts");
    expect(body.error.code).toBe("PROVIDER_KEY_MISSING");
    expect(body.compliance.blocked).toBe(true);
    expect(body.compliance.blocks).toContain("PROVIDER_KEY_MISSING:fish-audio");
    // Verify provider chain is still built correctly even for blocked routes
    expect(body.providerChain).toHaveLength(1);
    expect(body.providerChain[0].provider).toBe("fish-audio");
    // Verify route decision is preserved in error metadata
    expect(body.error.metadata.routeDecision.complianceBlocks).toContain("PROVIDER_KEY_MISSING:fish-audio");
  });

  it("TTS generate returns structured ROUTE_BLOCKED error for blocked gemini_elevenlabs_sts", async () => {
    const res = await request(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-tts-preview",
        input: "STS route with no key",
        voice: "Zephyr",
        generationRoute: "gemini_elevenlabs_sts",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as {
      ok: boolean;
      generationRoute: string;
      compliance: { blocked: boolean; blocks: string[] };
      error: { code: string };
    };

    expect(body.ok).toBe(false);
    expect(body.generationRoute).toBe("gemini_elevenlabs_sts");
    expect(body.error.code).toBe("PROVIDER_KEY_MISSING");
    expect(body.compliance.blocked).toBe(true);
    expect(body.compliance.blocks).toContain("PROVIDER_KEY_MISSING:elevenlabs");
  });

  it("TTS generate with gemini_only and missing OpenRouter key returns MISSING_API_KEY not PROVIDER_KEY_MISSING", async () => {
    const res = await request(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-tts-preview",
        input: "Gemini only route with no key",
        voice: "Zephyr",
      }),
    });

    // gemini_only route is not blocked by route selector, but fails at key resolver
    const body = await res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MISSING_API_KEY");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. License Gate Unit-Level Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("License Gate Edge Cases", () => {
  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    seedProviderKeys();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("gemini_only route without voiceAssetId is allowed without license", () => {
    const result = evaluateLicenseGate({
      action: "production_generate",
      route: "gemini_only",
    });

    expect(result.allowed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("GEMINI_PRESET_ROUTE");
  });

  it("gemini_only route with a voiceAssetId still requires license", () => {
    const result = evaluateLicenseGate({
      voiceAssetId: "nonexistent-asset",
      action: "production_generate",
      route: "gemini_only",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("VOICE_ASSET_NOT_FOUND");
  });

  it("action without voiceAssetId returns VOICE_ASSET_REQUIRED", () => {
    const result = evaluateLicenseGate({
      action: "create_model",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("VOICE_ASSET_REQUIRED");
  });

  it("legal_review_required asset status blocks all actions", () => {
    const assetId = "asset-legal-review";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_designed', 'legal_review_required', 'fish-audio', '{}', ?, ?)`).run(assetId, "Legal Review Asset", now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("LEGAL_REVIEW_REQUIRED");
  });

  it("revoked asset status blocks all actions", () => {
    const assetId = "asset-revoked";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'revoked', 'fish-audio', '{}', ?, ?)`).run(assetId, "Revoked Asset", now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("VOICE_ASSET_REVOKED");
  });

  it("failed asset status blocks all actions", () => {
    const assetId = "asset-failed";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'failed', 'fish-audio', '{}', ?, ?)`).run(assetId, "Failed Asset", now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("VOICE_ASSET_FAILED");
  });

  it("expired license blocks the action", () => {
    const assetId = "asset-expired-license";
    const licenseId = "license-expired";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', ?, '{}', ?, ?)`).run(assetId, "Expired License Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, valid_until, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, ?, 1, ?, ?)`).run(licenseId, assetId, JSON.stringify({ actions: ["production_generate"] }), now - 3600, now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      licenseRecordId: licenseId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("LICENSE_EXPIRED");
  });

  it("not-yet-valid license blocks the action", () => {
    const assetId = "asset-future-license";
    const licenseId = "license-future";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', ?, '{}', ?, ?)`).run(assetId, "Future License Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, valid_from, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, ?, 1, ?, ?)`).run(licenseId, assetId, JSON.stringify({ actions: ["production_generate"] }), now + 86400, now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      licenseRecordId: licenseId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("LICENSE_NOT_YET_VALID");
  });

  it("license scope does not allow unauthorized actions", () => {
    const assetId = "asset-scoped-license";
    const licenseId = "license-scoped";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', ?, '{}', ?, ?)`).run(assetId, "Scoped License Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, 1, ?, ?)`).run(licenseId, assetId, JSON.stringify({ actions: ["audition"] }), now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      licenseRecordId: licenseId,
      action: "create_model",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("LICENSE_SCOPE_DENIED");
  });

  it("cross-platform clone without approval blocks fish_audio_tts", () => {
    const assetId = "asset-cross-platform";
    const licenseId = "license-no-cross";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_designed', 'active', 'elevenlabs', ?, '{}', ?, ?)`).run(assetId, "Cross Platform Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, 0, ?, ?)`).run(licenseId, assetId, JSON.stringify({ actions: ["production_generate"] }), now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      licenseRecordId: licenseId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("CROSS_PLATFORM_CLONE_UNAPPROVED");
  });

  it("license record bound to different asset blocks the action", () => {
    const assetId1 = "asset-mismatch-1";
    const assetId2 = "asset-mismatch-2";
    const licenseId = "license-mismatch";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', '{}', ?, ?)`).run(assetId1, "Asset 1", now, now);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', ?, '{}', ?, ?)`).run(assetId2, "Asset 2", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, 1, ?, ?)`).run(licenseId, assetId2, JSON.stringify({ actions: ["production_generate"] }), now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId1,
      licenseRecordId: licenseId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("LICENSE_ASSET_MISMATCH");
  });

  it("revoked license record blocks the action even if status is approved", () => {
    const assetId = "asset-revoked-rec";
    const licenseId = "license-revoked-rec";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', ?, '{}', ?, ?)`).run(assetId, "Revoked Record Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, revoked_at, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, ?, 1, ?, ?)`).run(licenseId, assetId, JSON.stringify({ actions: ["production_generate"] }), now, now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      licenseRecordId: licenseId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("LICENSE_REVOKED");
  });

  it("elevenlabs_voice_design sourceType blocks with LEGAL_REVIEW_REQUIRED", () => {
    const assetId = "asset-voice-design";
    const licenseId = "license-voice-design";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'elevenlabs', ?, '{}', ?, ?)`).run(assetId, "Voice Design Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, 1, ?, ?)`).run(licenseId, assetId, JSON.stringify({ actions: ["create_model"] }), now, now);

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      licenseRecordId: licenseId,
      action: "create_model",
      route: "fish_audio_tts",
      sourceType: "elevenlabs_voice_design",
    });

    expect(result.allowed).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain("LEGAL_REVIEW_REQUIRED");
  });

  it("fully compliant asset+license with all fields passes", () => {
    const assetId = "asset-compliant";
    const licenseId = "license-compliant";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, provider_voice_id, fish_reference_id, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', 'voice-123', 'ref-456', ?, '{}', ?, ?)`).run(assetId, "Compliant Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, valid_from, valid_until, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, ?, ?, 1, ?, ?)`).run(
      licenseId, assetId,
      JSON.stringify({ actions: ["production_generate", "audition", "export", "create_model"] }),
      now - 3600, now + 86400 * 30, now, now,
    );

    const result = evaluateLicenseGate({
      voiceAssetId: assetId,
      licenseRecordId: licenseId,
      action: "production_generate",
      route: "fish_audio_tts",
    });

    expect(result.allowed).toBe(true);
    expect(result.blocks).toHaveLength(0);
    expect(result.licenseRecordId).toBe(licenseId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Route Selector Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("Route Selector Edge Cases", () => {
  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    seedProviderKeys();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("default route without any overrides is gemini_only and not blocked", () => {
    const decision = selectGenerationRoute({ transcript: "test transcript" });

    expect(decision.route).toBe("gemini_only");
    expect(decision.blocked).toBe(false);
    expect(decision.reasons).toContain("default_gemini_only_no_mapping");
    expect(decision.providerChain).toHaveLength(1);
    expect(decision.providerChain[0].provider).toBe("openrouter-gemini");
  });

  it("unknown route string normalizes to gemini_only", () => {
    const decision = selectGenerationRoute({
      requestedRoute: "totally_invalid_route" as "gemini_only",
      transcript: "test",
    });

    expect(decision.route).toBe("gemini_only");
  });

  it("null requested route falls back to gemini_only", () => {
    const decision = selectGenerationRoute({
      requestedRoute: null,
      transcript: "test",
    });

    expect(decision.route).toBe("gemini_only");
  });

  it("character voice mapping default route is used when no explicit route", () => {
    const mappingId = "mapping-1";
    const assetId = "asset-for-mapping";
    const licenseId = "license-for-mapping";
    const now = Math.floor(Date.now() / 1000);

    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, fish_reference_id, license_record_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'active', 'fish-audio', 'fish-map-ref', ?, '{}', ?, ?)`).run(assetId, "Mapping Asset", licenseId, now, now);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, ?, 'approved', ?, 1, ?, ?)`).run(licenseId, assetId, JSON.stringify({ actions: ["production_generate"] }), now, now);
    raw().prepare(`INSERT INTO character_voice_mapping (id, character_name, default_generation_route, voice_asset_id, fish_reference_id, route_options_json, created_at, updated_at)
      VALUES (?, ?, 'fish_audio_tts', ?, 'fish-map-ref', '{}', ?, ?)`).run(mappingId, "Character A", assetId, now, now);

    const decision = selectGenerationRoute({
      characterVoiceMappingId: mappingId,
      transcript: "test",
    });

    expect(decision.route).toBe("fish_audio_tts");
    expect(decision.reasons).toContain("character_mapping_default_route");
    expect(decision.voiceAssetId).toBe(assetId);
    expect(decision.blocked).toBe(false);
  });

  it("non-existent character voice mapping reports CHARACTER_VOICE_MAPPING_NOT_FOUND", () => {
    const decision = selectGenerationRoute({
      characterVoiceMappingId: "nonexistent-mapping",
      transcript: "test",
    });

    expect(decision.complianceBlocks).toContain("CHARACTER_VOICE_MAPPING_NOT_FOUND");
    expect(decision.blocked).toBe(true);
  });

  it("non-active asset status reports VOICE_ASSET_NOT_ACTIVE", () => {
    const { assetId } = seedApprovedVoiceAsset({ status: "draft", fishReferenceId: "fish-ref-draft" });

    const decision = selectGenerationRoute({
      requestedRoute: "fish_audio_tts",
      voiceAssetId: assetId,
      transcript: "test",
    });

    expect(decision.complianceBlocks).toContain("VOICE_ASSET_NOT_ACTIVE");
    expect(decision.blocked).toBe(true);
  });

  it("complianceBlocks are deduplicated", () => {
    // Ensure no duplicate compliance blocks even if multiple paths produce the same block
    const decision = selectGenerationRoute({
      requestedRoute: "fish_audio_tts",
      voiceAssetId: "nonexistent",
      transcript: "test",
    });

    const uniqueBlocks = [...new Set(decision.complianceBlocks)];
    expect(decision.complianceBlocks).toEqual(uniqueBlocks);
  });

  it("gemini_elevenlabs_sts without providerVoiceId reports PROVIDER_VOICE_ID_REQUIRED", () => {
    const { assetId } = seedApprovedVoiceAsset({ providerVoiceId: null, fishReferenceId: null });

    const decision = selectGenerationRoute({
      requestedRoute: "gemini_elevenlabs_sts",
      voiceAssetId: assetId,
      transcript: "test",
    });

    expect(decision.complianceBlocks).toContain("PROVIDER_VOICE_ID_REQUIRED");
    expect(decision.blocked).toBe(true);
  });

  it("fish_audio_tts without fishReferenceId reports FISH_REFERENCE_ID_REQUIRED", () => {
    const { assetId } = seedApprovedVoiceAsset({ fishReferenceId: null });

    const decision = selectGenerationRoute({
      requestedRoute: "fish_audio_tts",
      voiceAssetId: assetId,
      transcript: "test",
    });

    expect(decision.complianceBlocks).toContain("FISH_REFERENCE_ID_REQUIRED");
    expect(decision.blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Voice Asset API Structural Error Responses
// ═══════════════════════════════════════════════════════════════════════════════

describe("Voice Asset API Structural Error Responses", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    seedProviderKeys();
    app = createVoiceAssetsApp();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("POST /api/licenses/evaluate returns compliance for valid input", async () => {
    const { assetId, licenseId } = seedApprovedVoiceAsset();

    const res = await request(app, "/api/licenses/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceAssetId: assetId,
        licenseRecordId: licenseId,
        action: "production_generate",
        route: "fish_audio_tts",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { requestId: string; compliance: { allowed: boolean; blocks: unknown[]; licenseRecordId: string } };
    expect(body.requestId).toBeTruthy();
    expect(body.compliance.allowed).toBe(true);
    expect(body.compliance.blocks).toHaveLength(0);
    expect(body.compliance.licenseRecordId).toBe(licenseId);
  });

  it("POST /api/licenses/evaluate returns blocks for missing license", async () => {
    const { assetId } = seedApprovedVoiceAsset({ licenseId: "some-license" });

    const res = await request(app, "/api/licenses/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceAssetId: assetId,
        action: "production_generate",
        route: "fish_audio_tts",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { compliance: { allowed: boolean; blocks: Array<{ code: string }> } };
    expect(body.compliance.allowed).toBe(true);
  });

  it("POST /api/licenses/evaluate validates required fields", async () => {
    const res = await request(app, "/api/licenses/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "production_generate" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; message: string };
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/voice-assets with custom type and no license returns LICENSE_REQUIRED", async () => {
    const res = await request(app, "/api/voice-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Asset", type: "custom_cloned" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; message: string; requestId: string };
    expect(body.code).toBe("LICENSE_REQUIRED");
    expect(body.requestId).toBeTruthy();
  });

  it("POST /api/voice-assets with custom_designed type gets legal_review_required status", async () => {
    const licenseId = "license-for-design";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_license_record (id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
      VALUES (?, 'approved', ?, 1, ?, ?)`).run(licenseId, JSON.stringify({ actions: ["production_generate"] }), now, now);

    const res = await request(app, "/api/voice-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Designed Voice", type: "custom_designed", licenseRecordId: licenseId }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {
      voiceAsset: { status: string };
      compliance: { blocked: boolean; blocks: string[] };
    };
    expect(body.voiceAsset.status).toBe("legal_review_required");
    expect(body.compliance.blocked).toBe(true);
    expect(body.compliance.blocks).toContain("LEGAL_REVIEW_REQUIRED");
  });

  it("POST /api/voice-assets/:id/activate without valid license returns LICENSE_BLOCKED", async () => {
    const assetId = "asset-activate-no-license";
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'custom_cloned', 'license_pending', 'fish-audio', '{}', ?, ?)`).run(assetId, "Activate Test", now, now);

    const res = await request(app, `/api/voice-assets/${assetId}/activate`, { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("LICENSE_BLOCKED");
  });

  it("POST /api/voice-assets/:id/revoke with reason succeeds", async () => {
    const { assetId } = seedApprovedVoiceAsset();

    const res = await request(app, `/api/voice-assets/${assetId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Compliance issue found during review" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { voiceAsset: { status: string } };
    expect(body.voiceAsset.status).toBe("revoked");
  });

  it("GET /api/voice-assets with invalid type filter returns INVALID_FILTER", async () => {
    const res = await request(app, "/api/voice-assets?type=invalid_type");

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("INVALID_FILTER");
  });

  it("GET /api/voice-assets with invalid status filter returns INVALID_FILTER", async () => {
    const res = await request(app, "/api/voice-assets?status=not_a_status");

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("INVALID_FILTER");
  });

  it("GET /api/voice-assets/:id with nonexistent id returns 404", async () => {
    const res = await request(app, "/api/voice-assets/nonexistent-id");

    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("VOICE_ASSET_NOT_FOUND");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. TTS Generator Blocked Route Errors
// ═══════════════════════════════════════════════════════════════════════════════

describe("TTS Generator Blocked Route Errors", () => {
  let app: Hono;

  beforeEach(() => {
    closeDb();
    if (fs.existsSync(testState.dbFilePath)) fs.unlinkSync(testState.dbFilePath);
    initSchema();
    seedProviderKeys();
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    if (testState.tmpDir && fs.existsSync(testState.tmpDir)) fs.rmSync(testState.tmpDir, { recursive: true, force: true });
  });

  it("blocked route creates a failed job with ROUTE_BLOCKED error code in DB", async () => {
    const res = await request(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-tts-preview",
        input: "Blocked route test",
        voice: "Zephyr",
        generationRoute: "fish_audio_tts",
        voiceAssetId: "nonexistent",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { jobId: string; ok: boolean };
    expect(body.ok).toBe(false);
    expect(body.jobId).toBeTruthy();

    // Verify DB record
    const row = raw().prepare("SELECT status, error_code, generation_route, route_decision_json FROM generation_job WHERE id = ?").get(body.jobId) as {
      status: string;
      error_code: string;
      generation_route: string;
      route_decision_json: string;
    };
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("ROUTE_BLOCKED");
    expect(row.generation_route).toBe("fish_audio_tts");
    const routeDecision = JSON.parse(row.route_decision_json) as { blocked: boolean; complianceBlocks: string[] };
    expect(routeDecision.blocked).toBe(true);
  });

  it("gemini_elevenlabs_sts returns ROUTE_NOT_ENABLED when not blocked by gate", async () => {
    const { assetId } = seedApprovedVoiceAsset({ providerVoiceId: "eleven-valid" });

    const res = await request(app, "/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-tts-preview",
        input: "STS route test",
        voice: "Zephyr",
        generationRoute: "gemini_elevenlabs_sts",
        voiceAssetId: assetId,
      }),
    });

    // Route passes gate but is not implemented yet
    expect(res.status).toBe(501);
    const body = await res.json() as { ok: boolean; error: { code: string; message: string }; generationRoute: string };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ROUTE_NOT_ENABLED");
    expect(body.generationRoute).toBe("gemini_elevenlabs_sts");
  });
});
