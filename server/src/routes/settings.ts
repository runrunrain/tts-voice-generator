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

const app = new Hono();

// ─── Validation Schemas ──────────────────────────────────────────────────────

const SettingsSchema = z.object({
  openRouterApiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultVoice: z.string().optional(),
  defaultFormat: z.enum(["mp3", "pcm"]).optional(),
  audioOutputDir: z.string().optional(),
  maxCharsPerRequest: z.number().int().min(100).max(50000).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(10).optional(),
});

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
      defaultFormat: "mp3",
      audioOutputDir: "./data/audio",
      maxCharsPerRequest: 5000,
      maxConcurrentJobs: 2,
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
    defaultFormat: row.defaultFormat,
    audioOutputDir: row.audioOutputDir,
    maxCharsPerRequest: row.maxCharsPerRequest,
    maxConcurrentJobs: row.maxConcurrentJobs,
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
  if (data.defaultFormat !== undefined) updateValues.defaultFormat = data.defaultFormat;
  if (data.audioOutputDir !== undefined) updateValues.audioOutputDir = data.audioOutputDir;
  if (data.maxCharsPerRequest !== undefined) updateValues.maxCharsPerRequest = data.maxCharsPerRequest;
  if (data.maxConcurrentJobs !== undefined) updateValues.maxConcurrentJobs = data.maxConcurrentJobs;

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
