import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";

const testState = vi.hoisted(() => ({ tmpDir: "", dbFilePath: "" }));

vi.mock("../src/config/env.js", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");
  const tmp = nodePath.join(nodeOs.tmpdir(), `tts-voice-assets-security-${process.pid}-${Date.now()}`);
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
import { selectGenerationRoute } from "../src/services/route-selector.js";
import voiceAssetsRoutes from "../src/routes/voice-assets.js";

function raw() {
  return (getDb() as unknown as { $client: import("better-sqlite3").Database }).$client;
}

function createApp(): Hono {
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
} = {}) {
  const assetId = input.assetId ?? "asset-licensed";
  const licenseId = input.licenseId ?? `${assetId}-license`;
  const now = Math.floor(Date.now() / 1000);
  raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, provider_voice_id, fish_reference_id, license_record_id, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'custom_cloned', ?, 'fish-audio', ?, ?, ?, '{}', ?, ?)`).run(
    assetId,
    `Asset ${assetId}`,
    input.status ?? "active",
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

describe("Voice asset provider binding security", () => {
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

  it("blocks Fish referenceId injection that does not belong to the licensed voice asset", () => {
    const { assetId } = seedApprovedVoiceAsset({ fishReferenceId: "fish-owned" });

    const decision = selectGenerationRoute({
      requestedRoute: "fish_audio_tts",
      voiceAssetId: assetId,
      transcript: "hello",
      providerOptions: { fish: { referenceId: "fish-attacker" } },
    });

    expect(decision.blocked).toBe(true);
    expect(decision.complianceBlocks).toContain("REFERENCE_ASSET_MISMATCH");
    expect(decision.fishReferenceId).toBe("fish-owned");
    expect(decision.fishReferenceId).not.toBe("fish-attacker");
  });

  it("blocks ElevenLabs voiceId injection that does not match the licensed voice asset", () => {
    const { assetId } = seedApprovedVoiceAsset({ providerVoiceId: "eleven-owned" });

    const decision = selectGenerationRoute({
      requestedRoute: "gemini_elevenlabs_sts",
      voiceAssetId: assetId,
      transcript: "hello",
      providerOptions: { elevenlabs: { voiceId: "eleven-attacker" } },
    });

    expect(decision.blocked).toBe(true);
    expect(decision.complianceBlocks).toContain("PROVIDER_ID_LICENSE_MISMATCH");
    expect(decision.providerVoiceId).toBe("eleven-owned");
    expect(decision.providerVoiceId).not.toBe("eleven-attacker");
  });

  it("allows request override only when it exactly matches an active reference record for the same asset", () => {
    const { assetId } = seedApprovedVoiceAsset({ fishReferenceId: null });
    seedReference({ id: "ref-active", assetId, provider: "fish-audio", referenceId: "fish-active", qualityStatus: "passed" });

    const decision = selectGenerationRoute({
      requestedRoute: "fish_audio_tts",
      voiceAssetId: assetId,
      transcript: "hello",
      providerOptions: { fish: { referenceId: "fish-active" } },
    });

    expect(decision.complianceBlocks).not.toContain("REFERENCE_ASSET_MISMATCH");
    expect(decision.blocked).toBe(false);
    expect(decision.fishReferenceId).toBe("fish-active");
  });

  it("does not treat pending reference records as usable provider bindings", () => {
    const { assetId } = seedApprovedVoiceAsset({ fishReferenceId: null });
    seedReference({ id: "ref-pending", assetId, provider: "fish-audio", referenceId: "fish-pending", qualityStatus: "pending" });

    const decision = selectGenerationRoute({
      requestedRoute: "fish_audio_tts",
      voiceAssetId: assetId,
      transcript: "hello",
      providerOptions: { fish: { referenceId: "fish-pending" } },
    });

    expect(decision.blocked).toBe(true);
    expect(decision.complianceBlocks).toContain("REFERENCE_ASSET_MISMATCH");
    expect(decision.fishReferenceId).toBeUndefined();
  });
});

describe("Voice asset PATCH license gate regressions", () => {
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

  it("rejects generic PATCH attempts to set active status without the guarded activate endpoint", async () => {
    const { assetId } = seedApprovedVoiceAsset({ status: "license_pending" });

    const res = await request(app, `/api/voice-assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    const body = await res.json() as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONTROLLED_STATUS_REQUIRES_ACTION");
    const row = raw().prepare("SELECT status FROM voice_asset WHERE id = ?").get(assetId) as { status: string };
    expect(row.status).toBe("license_pending");
  });

  it("re-runs license gate before changing the license record on an active asset", async () => {
    const { assetId } = seedApprovedVoiceAsset({ status: "active", fishReferenceId: "fish-owned" });
    const now = Math.floor(Date.now() / 1000);
    raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, cross_platform_clone_allowed, created_at, updated_at)
      VALUES ('license-revoked', ?, 'revoked', ?, 1, ?, ?)`).run(assetId, JSON.stringify({ actions: ["production_generate"] }), now, now);

    const res = await request(app, `/api/voice-assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseRecordId: "license-revoked" }),
    });
    const body = await res.json() as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("LICENSE_BLOCKED");
    const row = raw().prepare("SELECT license_record_id FROM voice_asset WHERE id = ?").get(assetId) as { license_record_id: string };
    expect(row.license_record_id).not.toBe("license-revoked");
  });

  it("rejects clearing the license record on an active asset", async () => {
    const { assetId, licenseId } = seedApprovedVoiceAsset({ status: "active", fishReferenceId: "fish-owned" });

    const res = await request(app, `/api/voice-assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseRecordId: null }),
    });
    const body = await res.json() as { code: string; details?: { blocks?: Array<{ code: string }> } };

    expect(res.status).toBe(409);
    expect(body.code).toBe("LICENSE_BLOCKED");
    expect(body.details?.blocks?.map((block) => block.code)).toContain("LICENSE_REQUIRED");
    const row = raw().prepare("SELECT license_record_id FROM voice_asset WHERE id = ?").get(assetId) as { license_record_id: string };
    expect(row.license_record_id).toBe(licenseId);
  });
});
