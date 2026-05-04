/**
 * Settings routes.
 * GET    /api/settings          - Read current settings (Key masked)
 * PUT    /api/settings          - Save settings (including API Key, stored encrypted)
 * POST   /api/settings/test     - Test OpenRouter connection
 */

import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { encryptApiKey, decryptApiKey, maskApiKey } from "../config/env.js";
import { isOpenRouterConfigured, requireApiKey } from "../services/key-resolver.js";
import { OpenRouterProvider } from "../services/openrouter-provider.js";
import { canonicalizeVoice } from "../utils/voice.js";
import { normalizeFormat, type AudioFormat } from "../utils/audio-format.js";
import { fingerprintFromHash, generateLocalPluginToken } from "../services/agent-auth.js";

const app = new Hono();

// ─── Validation Schemas ──────────────────────────────────────────────────────

const SettingsSchema = z.object({
  openRouterApiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultVoice: z.string().optional(),
  defaultFormat: z.enum(["wav", "pcm", "mp3"]).optional(),
  audioOutputDir: z.string().optional(),
  maxCharsPerRequest: z.number().int().min(100).max(50000).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(10).optional(),
  agentAuthMode: z.enum(["confirm_each", "session_auto"]).optional(),
  agentMaxRequests: z.number().int().min(1).max(1000).optional(),
  agentMaxChars: z.number().int().min(1).max(500000).optional(),
  agentMaxCost: z.number().min(0).max(100).optional(),
  agentSessionExpiry: z.number().int().min(60).max(604800).optional(),
  localPluginTokenAction: z.enum(["rotate", "clear"]).optional(),
  agent: z.object({
    authMode: z.enum(["confirm_each", "session_auto"]).optional(),
    maxRequests: z.number().int().min(1).max(1000).optional(),
    maxChars: z.number().int().min(1).max(500000).optional(),
    maxCost: z.number().min(0).max(100).optional(),
    sessionExpiry: z.number().int().min(60).max(604800).optional(),
    tokenAction: z.enum(["rotate", "clear"]).optional(),
  }).optional(),
});

function defaults() {
  return {
    agentAuthMode: "confirm_each" as const,
    agentMaxRequests: 10,
    agentMaxChars: 10000,
    agentMaxCost: 0.01,
    agentSessionExpiry: 3600,
  };
}

function agentSettingsPayload(row: typeof settings.$inferSelect | undefined) {
  const d = defaults();
  const hash = row?.localPluginToken ?? null;
  return {
    hasLocalPluginToken: !!hash,
    localPluginTokenFingerprint: fingerprintFromHash(hash),
    agentAuthMode: row?.agentAuthMode ?? d.agentAuthMode,
    agentMaxRequests: row?.agentMaxRequests ?? d.agentMaxRequests,
    agentMaxChars: row?.agentMaxChars ?? d.agentMaxChars,
    agentMaxCost: row?.agentMaxCost ?? d.agentMaxCost,
    agentSessionExpiry: row?.agentSessionExpiry ?? d.agentSessionExpiry,
    agent: {
      hasLocalPluginToken: !!hash,
      fingerprint: fingerprintFromHash(hash),
      authMode: row?.agentAuthMode ?? d.agentAuthMode,
      maxRequests: row?.agentMaxRequests ?? d.agentMaxRequests,
      maxChars: row?.agentMaxChars ?? d.agentMaxChars,
      maxCost: row?.agentMaxCost ?? d.agentMaxCost,
      sessionExpiry: row?.agentSessionExpiry ?? d.agentSessionExpiry,
    },
  };
}

// ─── GET /api/settings ───────────────────────────────────────────────────────

app.get("/api/settings", (c) => {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();

  if (!row) {
    return c.json({
      hasOpenRouterApiKey: false,
      keyMask: null,
      defaultModel: "google/gemini-3.1-flash-tts-preview",
      defaultVoice: "Zephyr",
      defaultFormat: "wav",
      audioOutputDir: "./data/audio",
      maxCharsPerRequest: 5000,
      maxConcurrentJobs: 2,
      ...agentSettingsPayload(undefined),
    });
  }

  // Determine if key exists and compute mask -- never return plaintext
  let hasKey = false;
  let keyMask: string | null = null;

  if (row.openRouterApiKey) {
    // Try to decrypt to get the real key for masking
    const decrypted = decryptApiKey(row.openRouterApiKey);
    if (decrypted) {
      hasKey = true;
      keyMask = maskApiKey(decrypted);
    } else {
      // Legacy plaintext stored key
      hasKey = true;
      keyMask = maskApiKey(row.openRouterApiKey);
    }
  }

  return c.json({
    hasOpenRouterApiKey: hasKey,
    keyMask,
    // Backward compat: also return openRouterApiKey field for older frontend
    openRouterApiKey: hasKey ? keyMask : null,
    defaultModel: row.defaultModel,
    defaultVoice: canonicalizeVoice(row.defaultVoice),
    defaultFormat: normalizeFormat(row.defaultFormat),
    audioOutputDir: row.audioOutputDir,
    maxCharsPerRequest: row.maxCharsPerRequest,
    maxConcurrentJobs: row.maxConcurrentJobs,
    ...agentSettingsPayload(row),
  });
});

// ─── PUT /api/settings ───────────────────────────────────────────────────────

app.put("/api/settings", async (c) => {
  const body = await c.req.json();
  const parsed = SettingsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const data = parsed.data;
  const now = new Date();
  const tokenAction = data.localPluginTokenAction ?? data.agent?.tokenAction;
  let rotatedToken: string | null = null;

  // Build update values - only include fields that were provided
  const updateValues: Record<string, unknown> = { updatedAt: now };

  if (data.openRouterApiKey !== undefined) {
    if (data.openRouterApiKey && data.openRouterApiKey.trim().length > 0) {
      // Encrypt the key before storing in DB
      updateValues.openRouterApiKey = encryptApiKey(data.openRouterApiKey.trim());
    } else {
      // Clear the key
      updateValues.openRouterApiKey = null;
    }
  }
  if (data.defaultModel !== undefined) updateValues.defaultModel = data.defaultModel;
  if (data.defaultVoice !== undefined) updateValues.defaultVoice = canonicalizeVoice(data.defaultVoice);
  if (data.defaultFormat !== undefined) updateValues.defaultFormat = normalizeFormat(data.defaultFormat);
  if (data.audioOutputDir !== undefined) updateValues.audioOutputDir = data.audioOutputDir;
  if (data.maxCharsPerRequest !== undefined) updateValues.maxCharsPerRequest = data.maxCharsPerRequest;
  if (data.maxConcurrentJobs !== undefined) updateValues.maxConcurrentJobs = data.maxConcurrentJobs;
  if (data.agentAuthMode !== undefined || data.agent?.authMode !== undefined) updateValues.agentAuthMode = data.agentAuthMode ?? data.agent?.authMode;
  if (data.agentMaxRequests !== undefined || data.agent?.maxRequests !== undefined) updateValues.agentMaxRequests = data.agentMaxRequests ?? data.agent?.maxRequests;
  if (data.agentMaxChars !== undefined || data.agent?.maxChars !== undefined) updateValues.agentMaxChars = data.agentMaxChars ?? data.agent?.maxChars;
  if (data.agentMaxCost !== undefined || data.agent?.maxCost !== undefined) updateValues.agentMaxCost = data.agentMaxCost ?? data.agent?.maxCost;
  if (data.agentSessionExpiry !== undefined || data.agent?.sessionExpiry !== undefined) updateValues.agentSessionExpiry = data.agentSessionExpiry ?? data.agent?.sessionExpiry;
  if (tokenAction === "rotate") {
    const generated = generateLocalPluginToken();
    updateValues.localPluginToken = generated.hash;
    rotatedToken = generated.token;
  } else if (tokenAction === "clear") {
    updateValues.localPluginToken = null;
  }

  // Upsert: update row id=1, or insert if not exists
  const existing = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (existing) {
    db.update(settings)
      .set(updateValues)
      .where(eq(settings.id, 1))
      .run();
  } else {
    db.insert(settings).values({
      id: 1,
      ...updateValues,
    }).run();
  }

  return c.json({
    ok: true,
    openRouterKeySaved: !!data.openRouterApiKey,
    localPluginToken: rotatedToken ?? undefined,
  });
});

// ─── POST /api/settings/test ─────────────────────────────────────────────────

app.post("/api/settings/test", async (c) => {
  if (!isOpenRouterConfigured()) {
    return c.json({
      ok: false,
      latencyMs: 0,
      modelAvailable: false,
      error: "MISSING_API_KEY",
    });
  }

  try {
    const apiKey = requireApiKey();
    const provider = new OpenRouterProvider(apiKey);
    const result = await provider.testConnection();

    return c.json({
      ok: result.ok,
      latencyMs: result.latencyMs,
      modelAvailable: result.ok,
      error: result.error || null,
    });
  } catch (err) {
    return c.json({
      ok: false,
      latencyMs: 0,
      modelAvailable: false,
      error: err instanceof Error ? err.message : "Test connection failed",
    });
  }
});

// Alias: /api/settings/test-connection (plan specifies this path)
app.post("/api/settings/test-connection", async (c) => {
  // Reuse the same handler
  return app.fetch(new Request("http://localhost/api/settings/test", { method: "POST" }), {} as any);
});

export default app;
