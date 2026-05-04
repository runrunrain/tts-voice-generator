/**
 * Voices routes.
 * GET  /api/voices        - List all voice profiles with stats
 * POST /api/voices/probe  - Probe a specific voice for availability
 * GET  /api/voices/refresh - Refresh voice list (re-read from DB)
 */

import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { voiceProfile } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { isOpenRouterConfigured, requireApiKey } from "../services/key-resolver.js";
import { OpenRouterProvider } from "../services/openrouter-provider.js";
import { sanitizeText } from "../services/openrouter-provider.js";
import { canonicalizeVoice } from "../utils/voice.js";
import { resolveTtsFormat, type AudioFormat } from "../utils/audio-format.js";

const app = new Hono();

// ─── GET /api/voices ─────────────────────────────────────────────────────────

app.get("/api/voices", (c) => {
  const db = getDb();
  const voices = db.select().from(voiceProfile).all();

  // Compute stats
  const stats = {
    total: voices.length,
    verified: voices.filter(v => v.verifiedStatus === "verified").length,
    candidate: voices.filter(v => v.source === "candidate").length,
    custom: voices.filter(v => v.source === "custom").length,
    failed: voices.filter(v => v.verifiedStatus === "failed").length,
  };

  return c.json({ voices, stats });
});

// ─── POST /api/voices/probe ──────────────────────────────────────────────────

const ProbeSchema = z.object({
  voice: z.string().min(1),
  model: z.string().optional().default("google/gemini-3.1-flash-tts-preview"),
  format: z.enum(["wav", "pcm", "mp3"]).optional().default("wav"),
});

app.post("/api/voices/probe", async (c) => {
  if (!isOpenRouterConfigured()) {
    return c.json({
      voice: null,
      verifiedStatus: "failed",
      latencyMs: 0,
      probeJobId: null,
      error: "MISSING_API_KEY",
    }, 200);
  }

  const body = await c.req.json();
  const parsed = ProbeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { voice: voiceName, model, format } = parsed.data;
  const canonicalName = canonicalizeVoice(voiceName);
  const db = getDb();

  // Resolve format for upstream: for Gemini TTS, always use upstream "pcm"
  const formatPlan = resolveTtsFormat(model, format as AudioFormat);

  const start = Date.now();
  try {
    const apiKey = requireApiKey();
    const provider = new OpenRouterProvider(apiKey);

    // Use a short probe text
    const result = await provider.generateSpeech({
      model,
      input: "Hello, this is a voice test.",
      voice: canonicalName,
      responseFormat: formatPlan.upstreamFormat,
    });

    const latencyMs = Date.now() - start;

    if (result.ok) {
      // Voice is verified - update database
      db.update(voiceProfile)
        .set({
          verifiedStatus: "verified",
          lastVerified: new Date(),
          verifyDuration: latencyMs,
          verifyError: null,
          updatedAt: new Date(),
        })
        .where(eq(voiceProfile.name, canonicalName))
        .run();

      // Read back the updated profile to return to frontend
      const updatedProfile = db.select().from(voiceProfile).where(eq(voiceProfile.name, canonicalName)).get();

      return c.json({
        voice: canonicalName,
        verifiedStatus: "verified",
        latencyMs,
        probeJobId: null,
        error: null,
        profile: updatedProfile || undefined,
      });
    } else {
      // Voice probe failed - update database
      db.update(voiceProfile)
        .set({
          verifiedStatus: "failed",
          lastVerified: new Date(),
          verifyDuration: latencyMs,
          verifyError: sanitizeText(result.errorMessage),
          updatedAt: new Date(),
        })
        .where(eq(voiceProfile.name, canonicalName))
        .run();

      return c.json({
        voice: canonicalName,
        verifiedStatus: "failed",
        latencyMs,
        probeJobId: null,
        error: sanitizeText(result.errorMessage),
      });
    }
  } catch (err) {
    const latencyMs = Date.now() - start;
    const rawMsg = err instanceof Error ? err.message : "Probe failed";
    return c.json({
      voice: canonicalName,
      verifiedStatus: "failed",
      latencyMs,
      probeJobId: null,
      error: sanitizeText(rawMsg),
    });
  }
});

export default app;
