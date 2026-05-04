/**
 * TTS Generation route.
 * POST /api/tts/generate
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { GenerateSpeechSchema, generateSpeech } from "../services/tts-generator.js";

const app = new Hono();

app.post("/api/tts/generate", async (c) => {
  const requestId = uuidv4();
  const rawBody = await c.req.json();
  const parsed = GenerateSpeechSchema.safeParse(rawBody);

  if (!parsed.success) {
    return c.json({
      ok: false,
      requestId,
      jobId: null,
      status: "failed",
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        category: "validation" as const,
        retryable: false,
        metadata: { issues: parsed.error.flatten() },
      },
    }, 400);
  }

  const result = await generateSpeech(parsed.data, requestId, { source: "user" });
  return c.json(result.body, result.status as 200 | 400 | 500 | 503);
});

export default app;
