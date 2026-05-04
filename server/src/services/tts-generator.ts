import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { audioAsset, generationJob, settings } from "../db/schema.js";
import { isOpenRouterConfigured, requireApiKey } from "./key-resolver.js";
import { OpenRouterProvider, sanitizeText } from "./openrouter-provider.js";
import { acquireSlot, releaseSlot } from "./concurrency.js";
import { canonicalizeVoice } from "../utils/voice.js";
import { computeSha256, writeAudioFile } from "../utils/audio-fs.js";
import { resolveTtsFormat, wrapPcm16LeToWav, type AudioFormat } from "../utils/audio-format.js";

export const GenerateSpeechSchema = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().min(1),
  responseFormat: z.enum(["wav", "pcm", "mp3"]).optional().default("wav"),
  providerOptions: z.record(z.unknown()).optional().nullable(),
  directorSnapshot: z.object({
    audioProfile: z.string().optional(),
    scene: z.string().optional(),
    directorNotes: z.string().optional(),
    sampleContext: z.string().optional(),
    transcript: z.string().optional(),
    speakers: z.array(z.object({
      id: z.string(),
      label: z.string(),
      name: z.string().optional(),
      voice: z.string().optional(),
      style: z.string().optional(),
    })).optional(),
  }).optional().nullable(),
});

export type GenerateSpeechRequest = z.infer<typeof GenerateSpeechSchema>;

export interface SourceContext {
  source: "user" | "agent";
  agentConversationId?: string;
  agentActionLogId?: number;
}

export interface GenerateSpeechResult {
  body: Record<string, unknown>;
  status: number;
}

export async function generateSpeech(
  req: GenerateSpeechRequest,
  requestId: string,
  sourceContext: SourceContext = { source: "user" },
): Promise<GenerateSpeechResult> {
  const canonicalVoice = canonicalizeVoice(req.voice);
  const formatPlan = resolveTtsFormat(req.model, req.responseFormat as AudioFormat);

  if (!isOpenRouterConfigured()) {
    const jobId = uuidv4();
    const db = getDb();
    db.insert(generationJob).values({
      id: jobId,
      model: req.model,
      voice: canonicalVoice,
      responseFormat: formatPlan.outputFormat,
      input: req.input,
      inputCharCount: req.input.length,
      status: "failed",
      errorCode: "MISSING_API_KEY",
      errorMessage: "OpenRouter API Key is not configured. Please go to Settings and configure your API key.",
      source: sourceContext.source,
      agentConversationId: sourceContext.agentConversationId ?? null,
      agentActionLogId: sourceContext.agentActionLogId ?? null,
      createdAt: new Date(),
    }).run();

    return {
      status: 200,
      body: {
        ok: false,
        requestId,
        jobId,
        status: "failed",
        error: {
          code: "MISSING_API_KEY",
          message: "OpenRouter API Key is not configured. Please go to Settings and configure your API key.",
          category: "auth" as const,
          retryable: false,
        },
        charCount: req.input.length,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const db = getDb();
  const settingsRow = db.select().from(settings).where(eq(settings.id, 1)).get();
  const maxChars = settingsRow?.maxCharsPerRequest || 5000;
  const maxConcurrent = settingsRow?.maxConcurrentJobs || 2;

  if (req.input.length > maxChars) {
    const jobId = uuidv4();
    db.insert(generationJob).values({
      id: jobId,
      model: req.model,
      voice: canonicalVoice,
      responseFormat: formatPlan.outputFormat,
      input: req.input,
      inputCharCount: req.input.length,
      status: "failed",
      errorCode: "TEXT_TOO_LONG",
      errorMessage: `Input text exceeds maximum length of ${maxChars} characters (got ${req.input.length}).`,
      source: sourceContext.source,
      agentConversationId: sourceContext.agentConversationId ?? null,
      agentActionLogId: sourceContext.agentActionLogId ?? null,
      createdAt: new Date(),
    }).run();

    return {
      status: 400,
      body: {
        ok: false,
        requestId,
        jobId,
        status: "failed",
        error: {
          code: "TEXT_TOO_LONG",
          message: `Input text exceeds maximum length of ${maxChars} characters (got ${req.input.length}).`,
          category: "validation" as const,
          retryable: false,
          metadata: { maxChars, actualChars: req.input.length },
        },
        charCount: req.input.length,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const slotResult = acquireSlot(maxConcurrent);
  if (!slotResult.allowed) {
    return {
      status: 503,
      body: {
        ok: false,
        requestId,
        jobId: null,
        status: "failed",
        error: slotResult.error,
        charCount: req.input.length,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const jobId = uuidv4();
  const estimatedCost = estimateCost(req.input.length);
  db.insert(generationJob).values({
    id: jobId,
    model: req.model,
    voice: canonicalVoice,
    responseFormat: formatPlan.outputFormat,
    input: req.input,
    inputCharCount: req.input.length,
    status: "running",
    estimatedCost,
    providerOptions: req.providerOptions ? JSON.stringify(req.providerOptions) : null,
    directorSnapshot: req.directorSnapshot ? JSON.stringify(req.directorSnapshot) : null,
    source: sourceContext.source,
    agentConversationId: sourceContext.agentConversationId ?? null,
    agentActionLogId: sourceContext.agentActionLogId ?? null,
    createdAt: new Date(),
  }).run();

  try {
    const apiKey = requireApiKey();
    const provider = new OpenRouterProvider(apiKey);
    const result = await provider.generateSpeech({
      model: req.model,
      input: req.input,
      voice: canonicalVoice,
      responseFormat: formatPlan.upstreamFormat,
      providerOptions: req.providerOptions || undefined,
    });

    if (result.ok) {
      let audioBuffer = result.audioBuffer;
      if (formatPlan.wrapPcmToWav) audioBuffer = wrapPcm16LeToWav(audioBuffer, formatPlan.pcmParams);

      const now = new Date();
      const filePath = writeAudioFile(jobId, formatPlan.extension, audioBuffer, now);
      const sha256 = computeSha256(audioBuffer);
      const duration = `${Math.max(0.5, req.input.length * 0.007).toFixed(1)}s`;

      db.update(generationJob).set({
        status: "succeeded",
        generationId: result.generationId,
        actualCost: estimatedCost,
        completedAt: now,
      }).where(eq(generationJob.id, jobId)).run();

      const assetResult = db.insert(audioAsset).values({
        jobId,
        fileName: `${jobId}.${formatPlan.extension}`,
        filePath,
        mimeType: formatPlan.mimeType,
        sizeBytes: audioBuffer.length,
        sha256,
        duration,
        sampleRate: formatPlan.pcmParams?.sampleRate ?? null,
        bitDepth: formatPlan.pcmParams?.bitDepth ?? null,
        channels: formatPlan.pcmParams?.channels ?? null,
        createdAt: now,
      }).run();

      releaseSlot(slotResult.slotId);
      const assetId = Number(assetResult.lastInsertRowid);
      return {
        status: 200,
        body: {
          ok: true,
          requestId,
          jobId,
          status: "succeeded",
          generationId: result.generationId,
          assetId,
          audioUrl: `/api/audio/${assetId}`,
          contentType: formatPlan.mimeType,
          duration,
          sizeBytes: audioBuffer.length,
          charCount: req.input.length,
          estimatedCost,
          createdAt: now.toISOString(),
          requestedFormat: req.responseFormat,
          upstreamFormat: formatPlan.upstreamFormat,
          outputFormat: formatPlan.outputFormat,
        },
      };
    }

    const now = new Date();
    db.update(generationJob).set({
      status: "failed",
      errorCode: result.errorCode,
      errorMessage: sanitizeText(result.errorMessage),
      errorMetadata: result.errorMetadata ? JSON.stringify(result.errorMetadata) : null,
      completedAt: now,
    }).where(eq(generationJob.id, jobId)).run();

    releaseSlot(slotResult.slotId);
    return {
      status: 200,
      body: {
        ok: false,
        requestId,
        jobId,
        status: "failed",
        error: {
          code: result.errorCode,
          message: sanitizeText(result.errorMessage),
          category: classifyErrorCategory(result.errorCode),
          retryable: result.retryable,
          metadata: result.errorMetadata || undefined,
        },
        charCount: req.input.length,
        createdAt: now.toISOString(),
      },
    };
  } catch (err) {
    releaseSlot(slotResult.slotId);
    const safeErrMsg = sanitizeText(err instanceof Error ? err.message : "Unknown error");
    db.update(generationJob).set({
      status: "failed",
      errorCode: "INTERNAL_ERROR",
      errorMessage: safeErrMsg,
      completedAt: new Date(),
    }).where(eq(generationJob.id, jobId)).run();

    return {
      status: 500,
      body: {
        ok: false,
        requestId,
        jobId,
        status: "failed",
        error: {
          code: "INTERNAL_ERROR",
          message: safeErrMsg,
          category: "internal" as const,
          retryable: false,
        },
        charCount: req.input.length,
        createdAt: new Date().toISOString(),
      },
    };
  }
}

export function estimateCost(charCount: number): string {
  return `$${(charCount * 0.000021).toFixed(4)}`;
}

export function estimateCostNumber(charCount: number): number {
  return Number((charCount * 0.000021).toFixed(8));
}

export function classifyErrorCategory(code: string): "validation" | "auth" | "throttle" | "upstream" | "internal" | "unknown" {
  switch (code) {
    case "VALIDATION_ERROR":
    case "TEXT_TOO_LONG":
    case "BAD_REQUEST":
    case "MODEL_NOT_FOUND":
      return "validation";
    case "MISSING_API_KEY":
    case "INVALID_API_KEY":
    case "INSUFFICIENT_CREDITS":
    case "FORBIDDEN":
      return "auth";
    case "RATE_LIMITED":
    case "CONCURRENCY_LIMIT":
      return "throttle";
    case "PROVIDER_ERROR":
    case "BAD_GATEWAY":
    case "SERVICE_UNAVAILABLE":
    case "NETWORK_ERROR":
    case "REQUEST_TIMEOUT":
      return "upstream";
    case "INTERNAL_ERROR":
    case "UNEXPECTED_RESPONSE_TYPE":
      return "internal";
    default:
      return "unknown";
  }
}
