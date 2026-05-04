/**
 * TTS Generation route.
 * POST /api/tts/generate
 *
 * Flow:
 * 1. Validate request body
 * 2. Check API Key is configured
 * 3. Call OpenRouter Provider
 * 4. On success: save job + audio asset + write file
 * 5. On failure: save job with error, no file write
 * 6. Return JSON response
 */

import { Hono } from "hono";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/index.js";
import { generationJob, audioAsset, settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { isOpenRouterConfigured, requireApiKey } from "../services/key-resolver.js";
import { OpenRouterProvider } from "../services/openrouter-provider.js";
import {
  writeAudioFile,
  computeSha256,
  getMimeType,
  getExtension,
} from "../utils/audio-fs.js";

const app = new Hono();

// ─── Validation Schema ───────────────────────────────────────────────────────

const GenerateSchema = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().min(1),
  responseFormat: z.enum(["mp3", "pcm"]).optional().default("mp3"),
  providerOptions: z.record(z.unknown()).optional().nullable(),
  directorSnapshot: z.object({
    audioProfile: z.string().optional(),
    scene: z.string().optional(),
    directorNotes: z.string().optional(),
    transcript: z.string().optional(),
  }).optional().nullable(),
});

// ─── POST /api/tts/generate ──────────────────────────────────────────────────

app.post("/api/tts/generate", async (c) => {
  // 1. Parse and validate request
  const rawBody = await c.req.json();
  const parsed = GenerateSchema.safeParse(rawBody);

  if (!parsed.success) {
    return c.json({
      jobId: null,
      status: "failed",
      error: {
        code: "VALIDATION_ERROR",
        message: parsed.error.flatten(),
      },
    }, 400);
  }

  const req = parsed.data;

  // 2. Check API Key
  if (!isOpenRouterConfigured()) {
    // Save a failed job record for traceability
    const jobId = uuidv4();
    const db = getDb();
    db.insert(generationJob).values({
      id: jobId,
      model: req.model,
      voice: req.voice,
      responseFormat: req.responseFormat,
      input: req.input,
      inputCharCount: req.input.length,
      status: "failed",
      errorCode: "MISSING_API_KEY",
      errorMessage: "OpenRouter API Key is not configured. Please go to Settings and configure your API key.",
      source: "user",
      createdAt: new Date(),
    }).run();

    return c.json({
      jobId,
      status: "failed",
      error: {
        code: "MISSING_API_KEY",
        message: "OpenRouter API Key is not configured. Please go to Settings and configure your API key.",
      },
      charCount: req.input.length,
      createdAt: new Date().toISOString(),
    }, 200);
  }

  // 3. Read maxCharsPerRequest from settings
  const db = getDb();
  const settingsRow = db.select().from(settings).where(eq(settings.id, 1)).get();
  const maxChars = settingsRow?.maxCharsPerRequest || 5000;

  if (req.input.length > maxChars) {
    const jobId = uuidv4();
    db.insert(generationJob).values({
      id: jobId,
      model: req.model,
      voice: req.voice,
      responseFormat: req.responseFormat,
      input: req.input,
      inputCharCount: req.input.length,
      status: "failed",
      errorCode: "TEXT_TOO_LONG",
      errorMessage: `Input text exceeds maximum length of ${maxChars} characters (got ${req.input.length}).`,
      source: "user",
      createdAt: new Date(),
    }).run();

    return c.json({
      jobId,
      status: "failed",
      error: {
        code: "TEXT_TOO_LONG",
        message: `Input text exceeds maximum length of ${maxChars} characters (got ${req.input.length}).`,
      },
      charCount: req.input.length,
      createdAt: new Date().toISOString(),
    }, 400);
  }

  // 4. Create pending job
  const jobId = uuidv4();
  const estimatedCost = estimateCost(req.input.length);

  db.insert(generationJob).values({
    id: jobId,
    model: req.model,
    voice: req.voice,
    responseFormat: req.responseFormat,
    input: req.input,
    inputCharCount: req.input.length,
    status: "running",
    estimatedCost,
    providerOptions: req.providerOptions ? JSON.stringify(req.providerOptions) : null,
    directorSnapshot: req.directorSnapshot ? JSON.stringify(req.directorSnapshot) : null,
    source: "user",
    createdAt: new Date(),
  }).run();

  // 5. Call OpenRouter Provider
  try {
    const apiKey = requireApiKey();
    const provider = new OpenRouterProvider(apiKey);

    const result = await provider.generateSpeech({
      model: req.model,
      input: req.input,
      voice: req.voice,
      responseFormat: req.responseFormat,
      providerOptions: req.providerOptions || undefined,
    });

    if (result.ok) {
      // ─── Success path ─────────────────────────────────────────────
      const ext = getExtension(req.responseFormat);
      const mimeType = getMimeType(req.responseFormat);
      const now = new Date();

      // Write audio file to disk
      const filePath = writeAudioFile(jobId, ext, result.audioBuffer, now);
      const sha256 = computeSha256(result.audioBuffer);

      // Estimate duration (rough: ~150 chars/sec for Gemini TTS)
      const durationSec = Math.max(0.5, req.input.length * 0.007).toFixed(1);
      const duration = `${durationSec}s`;

      // Update job status to succeeded
      db.update(generationJob)
        .set({
          status: "succeeded",
          generationId: result.generationId,
          actualCost: estimatedCost,
          completedAt: now,
        })
        .where(eq(generationJob.id, jobId))
        .run();

      // Insert audio asset record
      const assetResult = db.insert(audioAsset).values({
        jobId,
        fileName: `${jobId}.${ext}`,
        filePath,
        mimeType,
        sizeBytes: result.audioBuffer.length,
        sha256,
        duration,
        createdAt: now,
      }).run();

      const assetId = Number(assetResult.lastInsertRowid);

      return c.json({
        jobId,
        status: "succeeded",
        generationId: result.generationId,
        assetId,
        audioUrl: `/api/audio/${assetId}`,
        contentType: mimeType,
        duration,
        sizeBytes: result.audioBuffer.length,
        charCount: req.input.length,
        estimatedCost,
        createdAt: now.toISOString(),
      });
    } else {
      // ─── Failure path (API error) ─────────────────────────────────
      db.update(generationJob)
        .set({
          status: "failed",
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          errorMetadata: result.errorMetadata ? JSON.stringify(result.errorMetadata) : null,
          completedAt: new Date(),
        })
        .where(eq(generationJob.id, jobId))
        .run();

      return c.json({
        jobId,
        status: "failed",
        error: {
          code: result.errorCode,
          message: result.errorMessage,
          metadata: result.errorMetadata,
        },
        charCount: req.input.length,
        createdAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    // ─── Unexpected error ─────────────────────────────────────────
    db.update(generationJob)
      .set({
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        completedAt: new Date(),
      })
      .where(eq(generationJob.id, jobId))
      .run();

    return c.json({
      jobId,
      status: "failed",
      error: {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "An unexpected error occurred",
      },
      charCount: req.input.length,
      createdAt: new Date().toISOString(),
    }, 500);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Estimate cost based on character count.
 * OpenRouter pricing: $1/M input tokens + $20/M output tokens
 * Rough approximation: ~$0.000021 per character
 */
function estimateCost(charCount: number): string {
  const cost = charCount * 0.000021;
  return `$${cost.toFixed(4)}`;
}

export default app;
