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
import { isGeminiTtsModel, resolveTtsFormat, wrapPcm16LeToWav, type AudioFormat } from "../utils/audio-format.js";
import { analyzeWavBuffer, type WavAnalysisResult, type WavAnalysisSuccess } from "../utils/audio-analysis.js";
import { normalizeLoudnessIfEnabled, type AudioPostprocessStatus } from "../utils/audio-postprocess.js";
import { env } from "../config/env.js";

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
    style: z.string().optional(),
    pacing: z.string().optional(),
    accent: z.string().optional(),
    emotion: z.string().optional(),
    performanceNotes: z.string().optional(),
    lineStyle: z.string().optional(),
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

const DEFAULT_GEMINI_TTS_TEMPERATURE = 0.2;

export interface SourceContext {
  source: "user" | "agent" | "cli";
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
  const effectiveProviderOptions = buildEffectiveProviderOptions(req.model, canonicalVoice, req.providerOptions || undefined);

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
    providerOptions: effectiveProviderOptions ? JSON.stringify(effectiveProviderOptions) : null,
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
      providerOptions: effectiveProviderOptions,
    });

    if (result.ok) {
      let audioBuffer = result.audioBuffer;
      if (formatPlan.wrapPcmToWav) audioBuffer = wrapPcm16LeToWav(audioBuffer, formatPlan.pcmParams);

      const postprocess = formatPlan.outputFormat === "wav"
        ? await normalizeLoudnessIfEnabled(audioBuffer, {
          enabled: env.enableLoudnessNormalization === true,
          targetLufs: Number.isFinite(env.loudnessTargetLufs) ? env.loudnessTargetLufs : -16,
          ffmpegPath: env.ffmpegPath,
        })
        : {
          buffer: audioBuffer,
          status: buildAudioPostprocessStatus(
            env.enableLoudnessNormalization === true,
            env.enableLoudnessNormalization === true ? "unsupported_format" : "disabled",
            Number.isFinite(env.loudnessTargetLufs) ? env.loudnessTargetLufs : -16,
          ),
        };
      audioBuffer = postprocess.buffer;

      const audioAnalysis: WavAnalysisResult = formatPlan.outputFormat === "wav"
        ? analyzeWavBuffer(audioBuffer)
        : {
          ok: false,
          code: "UNSUPPORTED_CONTAINER",
          message: "Raw PCM output is not analyzed as WAV.",
        };
      const usableAudioAnalysis = getUsableAudioAnalysis(audioAnalysis);

      const now = new Date();
      const filePath = writeAudioFile(jobId, formatPlan.extension, audioBuffer, now);
      const sha256 = computeSha256(audioBuffer);
      const duration = usableAudioAnalysis
        ? `${usableAudioAnalysis.durationSeconds.toFixed(1)}s`
        : `${Math.max(0.5, req.input.length * 0.007).toFixed(1)}s`;

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
        sampleRate: usableAudioAnalysis ? usableAudioAnalysis.sampleRate : formatPlan.pcmParams?.sampleRate ?? null,
        bitDepth: usableAudioAnalysis ? usableAudioAnalysis.bitsPerSample : formatPlan.pcmParams?.bitDepth ?? null,
        channels: usableAudioAnalysis ? usableAudioAnalysis.channels : formatPlan.pcmParams?.channels ?? null,
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
          audioAnalysis: usableAudioAnalysis
            ? {
              ok: true,
              durationSeconds: usableAudioAnalysis.durationSeconds,
              sampleRate: usableAudioAnalysis.sampleRate,
              channels: usableAudioAnalysis.channels,
              bitsPerSample: usableAudioAnalysis.bitsPerSample,
              rms: usableAudioAnalysis.rms,
              peak: usableAudioAnalysis.peak,
            }
            : { ok: false, code: audioAnalysis.ok ? "INVALID_WAV" : audioAnalysis.code },
          audioPostprocess: postprocess.status,
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

function buildEffectiveProviderOptions(
  model: string,
  canonicalVoice: string,
  providerOptions?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isGeminiTtsModel(model)) return providerOptions;

  const base = providerOptions ? { ...providerOptions } : {};
  const existingGenerationConfig = isPlainObject(base.generationConfig)
    ? base.generationConfig as Record<string, unknown>
    : {};
  const existingSpeechConfig = isPlainObject(existingGenerationConfig.speechConfig)
    ? existingGenerationConfig.speechConfig as Record<string, unknown>
    : {};
  const existingVoiceConfig = isPlainObject(existingSpeechConfig.voiceConfig)
    ? existingSpeechConfig.voiceConfig as Record<string, unknown>
    : {};
  const existingPrebuiltVoiceConfig = isPlainObject(existingVoiceConfig.prebuiltVoiceConfig)
    ? existingVoiceConfig.prebuiltVoiceConfig as Record<string, unknown>
    : {};
  const hasExplicitTemperature = Object.prototype.hasOwnProperty.call(
    existingGenerationConfig,
    "temperature",
  );
  const resolvedTemperature = hasExplicitTemperature
    ? existingGenerationConfig.temperature
    : DEFAULT_GEMINI_TTS_TEMPERATURE;

  return {
    ...base,
    generationConfig: {
      ...existingGenerationConfig,
      temperature: resolvedTemperature,
      responseModalities: ["AUDIO"],
      speechConfig: {
        ...existingSpeechConfig,
        voiceConfig: {
          ...existingVoiceConfig,
          prebuiltVoiceConfig: {
            ...existingPrebuiltVoiceConfig,
            voiceName: canonicalVoice,
          },
        },
      },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildAudioPostprocessStatus(
  enabled: boolean,
  reason: AudioPostprocessStatus["reason"],
  targetLufs: number,
): AudioPostprocessStatus {
  return {
    enabled,
    applied: false,
    reason,
    targetLufs: Number.isFinite(targetLufs) && targetLufs >= -30 && targetLufs <= -6 ? targetLufs : -16,
    tool: "ffmpeg-loudnorm",
  };
}

function getUsableAudioAnalysis(analysis: WavAnalysisResult): WavAnalysisSuccess | null {
  if (!analysis.ok) return null;

  if (!isFinitePositiveNumber(analysis.durationSeconds)) return null;
  if (!isFinitePositiveNumber(analysis.sampleRate)) return null;
  if (!isFinitePositiveNumber(analysis.channels)) return null;
  if (!isFinitePositiveNumber(analysis.bitsPerSample)) return null;
  if (!isFinitePositiveNumber(analysis.dataBytes)) return null;
  if (!Number.isFinite(analysis.rms) || analysis.rms < 0) return null;
  if (!Number.isFinite(analysis.peak) || analysis.peak < 0) return null;

  return analysis;
}

function isFinitePositiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
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
