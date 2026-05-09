/**
 * Prompt Assembly API Tests
 *
 * Covers:
 * - Prompt assembly with full five elements
 * - Prompt assembly with minimal elements (only transcript)
 * - Speaker limit enforcement (max 2, returns 400)
 * - Empty transcript validation (returns 400)
 * - Legacy voice alias canonicalization (alloy -> Zephyr)
 * - Warnings for missing optional elements (audioProfile, scene, directorNotes)
 * - Warning for legacy voice alias usage
 * - Route registration and response format
 * - Invalid JSON body handling
 * - Missing required fields handling
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
    `tts-prompts-${process.pid}-${Date.now()}`
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

import { initSchema, closeDb } from "../src/db/index.js";
import promptsRoutes from "../src/routes/prompts.js";
import { assemblePrompt, MAX_SPEAKERS } from "../src/services/prompt-assembly.js";
import { canonicalizeVoice, isLegacyAlias } from "../src/utils/voice.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createApp(): Hono {
  const app = new Hono();
  app.route("/", promptsRoutes);
  return app;
}

function r(app: Hono, url: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${url}`, init));
}

function validAssembleBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    audioProfile: "Warm, conversational podcast",
    scene: "A cozy living room",
    directorNotes: "Keep it relaxed and natural",
    sampleContext: "Previous episode established the hosts",
    style: "warm conversational host delivery",
    pacing: "relaxed with natural pauses",
    accent: "neutral clear diction",
    emotion: "welcoming and friendly",
    performanceNotes: "Legacy notes should be merged into this section.",
    transcript: "Speaker A: Welcome back! Speaker B: Thanks for having me.",
    speakers: [
      { id: "a", label: "Speaker A", name: "Host", voice: "Zephyr", style: "conversational" },
      { id: "b", label: "Speaker B", name: "Guest", voice: "Puck", style: "friendly" },
    ],
    ...overrides,
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Prompt Assembly API", () => {
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

  // ── Route Registration & Response Format ──────────────────────────────────

  describe("Route registration and response format", () => {
    it("POST /api/prompts/assemble is registered and returns 200 for valid input", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validAssembleBody(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.requestId).toBeTruthy();
      expect(body.prompt).toBeTruthy();
      expect(body.warnings).toBeDefined();
      expect(body.normalized).toBeDefined();
    });

    it("response contains all required fields: ok, requestId, prompt, warnings, normalized", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validAssembleBody(),
      });

      const body = await res.json();
      expect(body).toHaveProperty("ok", true);
      expect(body).toHaveProperty("requestId");
      expect(body).toHaveProperty("prompt");
      expect(body).toHaveProperty("warnings");
      expect(body).toHaveProperty("normalized");
    });

    it("normalized contains all five elements and speakers", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validAssembleBody(),
      });

      const body = await res.json();
      expect(body.normalized).toHaveProperty("audioProfile");
      expect(body.normalized).toHaveProperty("scene");
      expect(body.normalized).toHaveProperty("directorNotes");
      expect(body.normalized).toHaveProperty("sampleContext");
      expect(body.normalized).toHaveProperty("transcript");
      expect(body.normalized).toHaveProperty("speakers");
      expect(Array.isArray(body.normalized.speakers)).toBe(true);
    });
  });

  // ── Prompt Assembly Content ───────────────────────────────────────────────

  describe("Prompt assembly content", () => {
    it("assembles prompt with all five elements", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validAssembleBody(),
      });

      const body = await res.json();
      const prompt: string = body.prompt;

      expect(prompt).toContain("TTS the following script:");
      expect(prompt).toContain("# AUDIO PROFILE: Speaker A");
      expect(prompt).toContain("Role/Identity: Warm, conversational podcast");
      expect(prompt).toContain("## THE SCENE");
      expect(prompt).toContain("A cozy living room");
      expect(prompt).toContain("### DIRECTOR'S NOTES");
      expect(prompt).toContain("Style: warm conversational host delivery");
      expect(prompt).toContain("Pacing: relaxed with natural pauses");
      expect(prompt).toContain("Accent: neutral clear diction");
      expect(prompt).toContain("Emotion: welcoming and friendly");
      expect(prompt).toContain("Performance Notes: Legacy notes should be merged into this section.; Keep it relaxed and natural");
      expect(prompt).toContain("### SAMPLE CONTEXT");
      expect(prompt).toContain("Previous episode established the hosts");
      expect(prompt).toContain("#### TRANSCRIPT");
      expect(prompt).toContain("Speaker A: Welcome back! Speaker B: Thanks for having me.");
    });

    it("includes speaker definitions in the prompt", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validAssembleBody(),
      });

      const body = await res.json();
      const prompt: string = body.prompt;

      expect(prompt).toContain("Voice:");
      expect(prompt).toContain("Speaker A");
      expect(prompt).toContain("Zephyr");
      expect(prompt).toContain("Speaker B");
      expect(prompt).toContain("Puck");
    });

    it("assembles prompt with only transcript (minimal input)", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Hello world, this is a test.",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.prompt).toContain("Hello world, this is a test.");
      expect(body.prompt).toContain("TTS the following script:");
      expect(body.prompt).toContain("#### TRANSCRIPT");
    });

    it("omits empty optional sections from the prompt", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioProfile: "",
          scene: "",
          directorNotes: "",
          transcript: "Just the transcript.",
          speakers: [],
        }),
      });

      const body = await res.json();
      expect(body.prompt).toContain("TTS the following script:");
      expect(body.prompt).toContain("#### TRANSCRIPT\nJust the transcript.");
    });
  });

  // ── Speaker Limit ─────────────────────────────────────────────────────────

  describe("Speaker limit enforcement", () => {
    it("accepts exactly 2 speakers", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validAssembleBody(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.normalized.speakers.length).toBe(2);
    });

    it("rejects 3 speakers with DIRECTOR_SPEAKER_LIMIT_EXCEEDED", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Some text",
          speakers: [
            { id: "a", label: "Speaker A", voice: "Zephyr" },
            { id: "b", label: "Speaker B", voice: "Puck" },
            { id: "c", label: "Speaker C", voice: "Charon" },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DIRECTOR_SPEAKER_LIMIT_EXCEEDED");
      expect(body.error.message).toContain("Maximum 2 speakers");
      expect(body.error.metadata.speakerCount).toBe(3);
      expect(body.error.metadata.maxSpeakers).toBe(2);
    });

    it("rejects 5 speakers with DIRECTOR_SPEAKER_LIMIT_EXCEEDED", async () => {
      const speakers = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        label: `Speaker ${i + 1}`,
        voice: "Zephyr",
      }));

      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Multi-speaker test",
          speakers,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("DIRECTOR_SPEAKER_LIMIT_EXCEEDED");
    });

    it("accepts 0 speakers", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "No speakers, just text.",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.normalized.speakers.length).toBe(0);
    });

    it("accepts 1 speaker", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Single speaker test",
          speakers: [
            { id: "a", label: "Narrator", voice: "Zephyr" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.normalized.speakers.length).toBe(1);
    });
  });

  // ── Empty Transcript ──────────────────────────────────────────────────────

  describe("Empty transcript validation", () => {
    it("rejects empty transcript with VALIDATION_ERROR", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects missing transcript with VALIDATION_ERROR", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioProfile: "Some profile",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── Legacy Voice Alias ────────────────────────────────────────────────────

  describe("Legacy voice alias canonicalization", () => {
    it("canonicalizes 'alloy' to 'Zephyr' in normalized speakers", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Test with legacy voice",
          speakers: [
            { id: "a", label: "Host", voice: "alloy" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.normalized.speakers[0].voice).toBe("Zephyr");
    });

    it("includes LEGACY_VOICE_ALIAS warning when using alloy", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Test with legacy voice",
          speakers: [
            { id: "a", label: "Host", voice: "alloy" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const legacyWarning = body.warnings.find(
        (w: { code: string }) => w.code === "LEGACY_VOICE_ALIAS"
      );
      expect(legacyWarning).toBeDefined();
      expect(legacyWarning.message).toContain("alloy");
      expect(legacyWarning.message).toContain("Zephyr");
    });

    it("canonicalizes 'alloy' in assembled prompt text", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Hello there",
          speakers: [
            { id: "a", label: "Host", voice: "alloy" },
          ],
        }),
      });

      const body = await res.json();
      expect(body.prompt).toContain("Voice: Host: Zephyr");
      expect(body.prompt).not.toContain("alloy");
    });

    it("does not warn when using canonical voice name", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Test with canonical voice",
          speakers: [
            { id: "a", label: "Host", voice: "Zephyr" },
          ],
        }),
      });

      const body = await res.json();
      const legacyWarning = body.warnings.find(
        (w: { code: string }) => w.code === "LEGACY_VOICE_ALIAS"
      );
      expect(legacyWarning).toBeUndefined();
    });

    it("canonicalizes multiple speakers with mixed legacy and canonical", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Mixed voices test",
          speakers: [
            { id: "a", label: "Speaker A", voice: "alloy" },
            { id: "b", label: "Speaker B", voice: "Puck" },
          ],
        }),
      });

      const body = await res.json();
      expect(body.normalized.speakers[0].voice).toBe("Zephyr");
      expect(body.normalized.speakers[1].voice).toBe("Puck");

      const legacyWarnings = body.warnings.filter(
        (w: { code: string }) => w.code === "LEGACY_VOICE_ALIAS"
      );
      expect(legacyWarnings.length).toBe(1);
    });
  });

  // ── Warnings ──────────────────────────────────────────────────────────────

  describe("Warnings for missing optional elements", () => {
    it("warns when audioProfile is empty", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioProfile: "",
          scene: "A scene",
          directorNotes: "Some notes",
          transcript: "Hello world",
        }),
      });

      const body = await res.json();
      const warning = body.warnings.find(
        (w: { code: string }) => w.code === "SUGGEST_AUDIO_PROFILE"
      );
      expect(warning).toBeDefined();
      expect(warning.field).toBe("audioProfile");
    });

    it("warns when scene is empty", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioProfile: "Some profile",
          scene: "",
          directorNotes: "Some notes",
          transcript: "Hello world",
        }),
      });

      const body = await res.json();
      const warning = body.warnings.find(
        (w: { code: string }) => w.code === "SUGGEST_SCENE"
      );
      expect(warning).toBeDefined();
      expect(warning.field).toBe("scene");
    });

    it("warns when directorNotes is empty", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioProfile: "Some profile",
          scene: "A scene",
          directorNotes: "",
          transcript: "Hello world",
        }),
      });

      const body = await res.json();
      const warning = body.warnings.find(
        (w: { code: string }) => w.code === "SUGGEST_DIRECTOR_NOTES"
      );
      expect(warning).toBeDefined();
      expect(warning.field).toBe("directorNotes");
    });

    it("warns about all three missing when all optional fields are empty", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Just transcript",
        }),
      });

      const body = await res.json();
      const codes = body.warnings.map((w: { code: string }) => w.code);
      expect(codes).toContain("SUGGEST_AUDIO_PROFILE");
      expect(codes).toContain("SUGGEST_SCENE");
      expect(codes).toContain("SUGGEST_DIRECTOR_NOTES");
    });

    it("does not warn when all optional fields are provided", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validAssembleBody(),
      });

      const body = await res.json();
      const suggestWarnings = body.warnings.filter(
        (w: { code: string }) =>
          w.code === "SUGGEST_AUDIO_PROFILE" ||
          w.code === "SUGGEST_SCENE" ||
          w.code === "SUGGEST_DIRECTOR_NOTES"
      );
      expect(suggestWarnings.length).toBe(0);
    });

    it("does not warn about empty sampleContext (not a suggested field)", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioProfile: "Profile",
          scene: "Scene",
          directorNotes: "Notes",
          sampleContext: "",
          transcript: "Hello",
        }),
      });

      const body = await res.json();
      const scWarning = body.warnings.find(
        (w: { code: string }) => w.code === "SUGGEST_SAMPLE_CONTEXT"
      );
      expect(scWarning).toBeUndefined();
    });
  });

  // ── Invalid Input ─────────────────────────────────────────────────────────

  describe("Invalid input handling", () => {
    it("rejects invalid JSON body", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json {",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects empty body", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects speaker with empty voice", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Test",
          speakers: [
            { id: "a", label: "Host", voice: "" },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects speaker with missing id", async () => {
      const res = await r(app, "/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: "Test",
          speakers: [
            { label: "Host", voice: "Zephyr" },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ── Unit Tests for Service Layer ──────────────────────────────────────────

  describe("assemblePrompt service (unit)", () => {
    it("MAX_SPEAKERS constant is 2", () => {
      expect(MAX_SPEAKERS).toBe(2);
    });

    it("returns prompt string with all sections", () => {
      const result = assemblePrompt({
        audioProfile: "Warm podcast",
        scene: "Living room",
        directorNotes: "Relaxed tone",
        sampleContext: "Previous episode",
        transcript: "Hello and welcome!",
        speakers: [
          { id: "a", label: "Host", voice: "Zephyr" },
        ],
      });

      expect(result.prompt).toContain("TTS the following script:");
      expect(result.prompt).toContain("# AUDIO PROFILE: Host");
      expect(result.prompt).toContain("Role/Identity: Warm podcast");
      expect(result.prompt).toContain("Living room");
      expect(result.prompt).toContain("Performance Notes: Relaxed tone");
      expect(result.prompt).toContain("Previous episode");
      expect(result.prompt).toContain("Hello and welcome!");
      expect(result.prompt).toContain("Voice: Host: Zephyr");
    });

    it("includes speaker name and style in prompt when provided", () => {
      const result = assemblePrompt({
        audioProfile: "",
        scene: "",
        directorNotes: "",
        sampleContext: "",
        transcript: "Hello",
        speakers: [
          { id: "a", label: "Speaker A", name: "Alice", voice: "Zephyr", style: "cheerful" },
        ],
      });

      expect(result.prompt).toContain("(Alice)");
      expect(result.prompt).toContain("Style: Speaker A: cheerful");
    });

    it("places line style in Director's Notes and keeps transcript clean", () => {
      const result = assemblePrompt({
        audioProfile: "Tactical commander",
        scene: "Night battlefield briefing",
        directorNotes: "Legacy notes remain compatible.",
        sampleContext: "The squad is waiting for orders.",
        style: "low restrained command",
        pacing: "slow with firm pauses",
        accent: "clear diction",
        emotion: "controlled tension",
        performanceNotes: "Avoid melodrama.",
        lineStyle: "near whisper on the final phrase",
        transcript: "Hold the line until dawn.",
        speakers: [
          { id: "commander", label: "Commander", voice: "Orus", style: "firm" },
        ],
      });

      const transcriptSection = result.prompt.split("#### TRANSCRIPT")[1] ?? "";
      expect(result.prompt).toContain("Line Style Override: near whisper on the final phrase");
      expect(result.prompt).toContain("Performance Notes: Avoid melodrama.; Legacy notes remain compatible.");
      expect(transcriptSection).toContain("Hold the line until dawn.");
      expect(transcriptSection).not.toContain("Line Style Override");
      expect(transcriptSection).not.toContain("Style:");
    });

    it("keeps old directorNotes compatible by merging into Performance Notes", () => {
      const result = assemblePrompt({
        audioProfile: "Narrator",
        scene: "Archive narration",
        directorNotes: "measured pace, restrained pride",
        sampleContext: "Historical monologue",
        transcript: "The old city gates opened.",
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
      });

      expect(result.prompt).toContain("Performance Notes: measured pace, restrained pride");
      expect(result.normalized.performanceNotes).toBe("measured pace, restrained pride");
    });

    it("normalized.speakers contains wasLegacyAlias flag", () => {
      const result = assemblePrompt({
        audioProfile: "",
        scene: "",
        directorNotes: "",
        sampleContext: "",
        transcript: "Test",
        speakers: [
          { id: "a", label: "Host", voice: "alloy" },
          { id: "b", label: "Guest", voice: "Puck" },
        ],
      });

      expect(result.normalized.speakers[0].wasLegacyAlias).toBe(true);
      expect(result.normalized.speakers[1].wasLegacyAlias).toBe(false);
    });

    it("handles transcript-only input cleanly", () => {
      const result = assemblePrompt({
        audioProfile: "",
        scene: "",
        directorNotes: "",
        sampleContext: "",
        transcript: "Just a plain transcript.",
        speakers: [],
      });

      expect(result.prompt).toContain("#### TRANSCRIPT\nJust a plain transcript.");
      expect(result.warnings.length).toBe(4); // audioProfile, scene, directorNotes, style fields
    });

    it("canonicalizeVoice handles empty string as Zephyr", () => {
      expect(canonicalizeVoice("")).toBe("Zephyr");
    });

    it("isLegacyAlias identifies alloy correctly", () => {
      expect(isLegacyAlias("alloy")).toBe(true);
      expect(isLegacyAlias("Alloy")).toBe(true);
      expect(isLegacyAlias("ALLOY")).toBe(true);
      expect(isLegacyAlias("Zephyr")).toBe(false);
      expect(isLegacyAlias("Puck")).toBe(false);
    });
  });
});
