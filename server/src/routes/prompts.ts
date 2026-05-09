/**
 * Prompt Assembly route.
 * POST /api/prompts/assemble
 *
 * Accepts Director five elements + speakers, validates constraints,
 * canonicalizes voices, and returns the assembled prompt text.
 *
 * Constraints:
 *   - speakers: maximum 2 (returns 400 DIRECTOR_SPEAKER_LIMIT_EXCEEDED)
 *   - transcript: required, non-empty (returns 400 validation error)
 *   - all speaker voices canonicalized via canonicalizeVoice
 *
 * Response:
 *   { ok, prompt, warnings, normalized }
 */

import { Hono } from "hono";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { assemblePrompt, MAX_SPEAKERS } from "../services/prompt-assembly.js";

const app = new Hono();

// ─── Validation Schema ────────────────────────────────────────────────────────

const SpeakerSchema = z.object({
  id: z.string().min(1, "Speaker id is required"),
  label: z.string().min(1, "Speaker label is required"),
  name: z.string().optional().default(""),
  voice: z.string().min(1, "Speaker voice is required"),
  style: z.string().optional().default(""),
});

const AssemblePromptSchema = z.object({
  audioProfile: z.string().optional().default(""),
  scene: z.string().optional().default(""),
  directorNotes: z.string().optional().default(""),
  sampleContext: z.string().optional().default(""),
  style: z.string().optional().default(""),
  pacing: z.string().optional().default(""),
  accent: z.string().optional().default(""),
  emotion: z.string().optional().default(""),
  performanceNotes: z.string().optional().default(""),
  lineStyle: z.string().optional().default(""),
  transcript: z.string().min(1, "Transcript is required and cannot be empty"),
  speakers: z.array(SpeakerSchema).optional().default([]),
});

// ─── POST /api/prompts/assemble ───────────────────────────────────────────────

app.post("/api/prompts/assemble", async (c) => {
  const requestId = uuidv4();

  // 1. Parse and validate request body
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({
      ok: false,
      requestId,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body must be valid JSON.",
        category: "validation" as const,
        retryable: false,
      },
    }, 400);
  }

  const parsed = AssemblePromptSchema.safeParse(rawBody);

  if (!parsed.success) {
    return c.json({
      ok: false,
      requestId,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        category: "validation" as const,
        retryable: false,
        metadata: { issues: parsed.error.flatten() },
      },
    }, 400);
  }

  const req = parsed.data;

  // 2. Enforce speaker limit
  if (req.speakers.length > MAX_SPEAKERS) {
    return c.json({
      ok: false,
      requestId,
      error: {
        code: "DIRECTOR_SPEAKER_LIMIT_EXCEEDED",
        message: `Maximum ${MAX_SPEAKERS} speakers allowed in Director mode. Received: ${req.speakers.length}.`,
        category: "validation" as const,
        retryable: false,
        metadata: {
          speakerCount: req.speakers.length,
          maxSpeakers: MAX_SPEAKERS,
        },
      },
    }, 400);
  }

  // 3. Assemble prompt
  const result = assemblePrompt({
    audioProfile: req.audioProfile,
    scene: req.scene,
    directorNotes: req.directorNotes,
    sampleContext: req.sampleContext,
    style: req.style,
    pacing: req.pacing,
    accent: req.accent,
    emotion: req.emotion,
    performanceNotes: req.performanceNotes,
    lineStyle: req.lineStyle,
    transcript: req.transcript,
    speakers: req.speakers,
  });

  // 4. Return result
  return c.json({
    ok: true,
    requestId,
    prompt: result.prompt,
    warnings: result.warnings,
    normalized: result.normalized,
  });
});

export default app;
