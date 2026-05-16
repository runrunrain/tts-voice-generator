/**
 * Voices routes.
 * GET  /api/voices        - List all voice profiles with stats
 * POST /api/voices/probe  - Probe a specific voice for availability
 * POST /api/voices/audition - Generate a transient audition clip without history writes
 * GET  /api/voices/refresh - Refresh voice list (re-read from DB)
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { voiceProfile } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { resolveApiKey } from "../services/key-resolver.js";
import { OpenRouterProvider } from "../services/openrouter-provider.js";
import { sanitizeText } from "../services/openrouter-provider.js";
import { classifyErrorCategory } from "../services/tts-generator.js";
import {
  commitAuditionCacheEntry,
  computeAuditionCacheKey,
  readAuditionCache,
  type AuditionCacheEntry,
} from "../services/voice-audition-cache.js";
import { canonicalizeVoice } from "../utils/voice.js";
import { resolveTtsFormat, wrapPcm16LeToWav, type AudioFormat } from "../utils/audio-format.js";

const app = new Hono();
const DEFAULT_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";
const AUDITION_TEXT = "Hello, this is a voice audition.";
const PROBE_CACHE_TTL_SECONDS = 30;
const STALE_VERIFICATION_MS = 24 * 60 * 60 * 1000;
const inFlightProbes = new Map<string, Promise<ProbeResponse>>();
const inFlightAuditionGenerations = new Map<string, Promise<AuditionCacheEntry>>();

type VoiceProfileRow = typeof voiceProfile.$inferSelect;

type ProbeResponse = {
  voice: string;
  verifiedStatus: "verified" | "failed";
  latencyMs: number;
  probeJobId: null;
  error: string | null;
  cached: boolean;
  cacheTtlSeconds: number;
  lastVerified?: string;
  profile?: VoiceProfileRow;
};

// ─── GET /api/voices ─────────────────────────────────────────────────────────

app.get("/api/voices", (c) => {
  const db = getDb();
  const voices = db.select().from(voiceProfile).all();

  const nowMs = Date.now();
  const durations = voices
    .map((v) => v.verifyDuration)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const errorCounts = new Map<string, { voice: string; errorMessage: string; count: number; lastOccurrenceMs: number | null }>();
  for (const voice of voices) {
    if (!voice.verifyError) continue;
    const key = `${voice.name}\u0000${voice.verifyError}`;
    const lastOccurrenceMs = toTimestampMs(voice.lastVerified);
    const existing = errorCounts.get(key);
    if (existing) {
      existing.count += 1;
      if (lastOccurrenceMs != null && (existing.lastOccurrenceMs == null || lastOccurrenceMs > existing.lastOccurrenceMs)) {
        existing.lastOccurrenceMs = lastOccurrenceMs;
      }
    } else {
      errorCounts.set(key, {
        voice: voice.name,
        errorMessage: voice.verifyError,
        count: 1,
        lastOccurrenceMs,
      });
    }
  }

  // Compute stats. Keep legacy fields while adding availability report fields.
  const stats = {
    total: voices.length,
    verified: voices.filter(v => v.verifiedStatus === "verified").length,
    candidate: voices.filter(v => v.source === "candidate").length,
    custom: voices.filter(v => v.source === "custom").length,
    failed: voices.filter(v => v.verifiedStatus === "failed").length,
    unknown: voices.filter(v => v.verifiedStatus === "unknown").length,
    staleVerified: voices.filter(v => v.verifiedStatus === "verified" && isOlderThan(v.lastVerified, nowMs, STALE_VERIFICATION_MS)).length,
    neverVerified: voices.filter(v => !v.lastVerified).length,
    avgLatencyMs: durations.length > 0
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null,
    errorSummary: Array.from(errorCounts.values())
      .sort((a, b) => b.count - a.count || a.errorMessage.localeCompare(b.errorMessage) || a.voice.localeCompare(b.voice))
      .slice(0, 5)
      .map((entry) => ({
        voice: entry.voice,
        errorCode: classifyVoiceError(entry.errorMessage),
        errorMessage: entry.errorMessage,
        count: entry.count,
        lastOccurrence: entry.lastOccurrenceMs == null ? "" : new Date(entry.lastOccurrenceMs).toISOString(),
      })),
  };

  return c.json({ voices, stats });
});

// ─── POST /api/voices/probe ──────────────────────────────────────────────────

const ProbeSchema = z.object({
  voice: z.string().min(1),
  model: z.string().optional().default(DEFAULT_TTS_MODEL),
  format: z.enum(["wav", "pcm", "mp3"]).optional().default("wav"),
  force: z.boolean().optional().default(false),
});

app.post("/api/voices/probe", async (c) => {
  const body = await c.req.json();
  const parsed = ProbeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { voice: voiceName, model, format } = parsed.data;
  const force = parsed.data.force || c.req.query("force")?.toLowerCase() === "true";
  const canonicalName = canonicalizeVoice(voiceName);
  const db = getDb();
  const existingProfile = db.select().from(voiceProfile).where(eq(voiceProfile.name, canonicalName)).get();

  const apiKey = resolveApiKey();
  if (!apiKey) return c.json(buildMissingApiKeyResponse(canonicalName, existingProfile), 200);

  // Resolve format for upstream: for Gemini TTS, always use upstream "pcm"
  const formatPlan = resolveTtsFormat(model, format as AudioFormat);

  if (!force) {
    const cachedResult = buildCachedProbeResponse(existingProfile);
    if (cachedResult) return c.json(cachedResult);
  }

  const inFlightKey = buildProbeKey({ voice: canonicalName, model, format: formatPlan.upstreamFormat, force });
  const existingProbe = inFlightProbes.get(inFlightKey);
  if (existingProbe) return c.json(await existingProbe);

  const probePromise = runOpenRouterProbe({
    apiKey,
    model,
    voice: canonicalName,
    upstreamFormat: formatPlan.upstreamFormat,
  });
  inFlightProbes.set(inFlightKey, probePromise);

  try {
    return c.json(await probePromise);
  } finally {
    inFlightProbes.delete(inFlightKey);
  }
});

// ─── POST /api/voices/audition ───────────────────────────────────────────────

const AuditionSchema = z.object({
  voice: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200).optional().default(DEFAULT_TTS_MODEL),
  format: z.enum(["wav", "pcm", "mp3"]).optional().default("wav"),
  forceRefresh: z.boolean().optional().default(false),
});

app.post("/api/voices/audition", async (c) => {
  const requestId = randomUUID();
  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(buildAuditionError({
      requestId,
      code: "VALIDATION_ERROR",
      message: "Request body must be valid JSON.",
      category: "validation",
      retryable: false,
    }), 400);
  }

  const parsed = AuditionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(buildAuditionError({
      requestId,
      code: "VALIDATION_ERROR",
      message: "Request validation failed.",
      category: "validation",
      retryable: false,
      metadata: { issues: parsed.error.flatten() },
    }), 400);
  }

  const { voice: voiceName, model, format, forceRefresh } = parsed.data;
  const canonicalName = canonicalizeVoice(voiceName);
  const formatPlan = resolveTtsFormat(model, format as AudioFormat);
  const cacheKey = computeAuditionCacheKey({
    canonicalVoice: canonicalName,
    model,
    requestedFormat: format as AudioFormat,
    outputFormat: formatPlan.outputFormat,
    contentType: formatPlan.mimeType,
    auditionText: AUDITION_TEXT,
  });

  const existingCache = await readAuditionCache(cacheKey);
  if (!forceRefresh && existingCache) {
    return buildAuditionAudioResponse(existingCache, "hit");
  }

  const apiKey = resolveApiKey();

  if (!apiKey) {
    return c.json(buildAuditionError({
      requestId,
      voice: canonicalName,
      code: "MISSING_API_KEY",
      message: "OpenRouter API Key is not configured. Please go to Settings and configure your API key.",
      category: "auth",
      retryable: false,
    }), 401);
  }

  try {
    const generationKey = cacheKey;
    let generationPromise = inFlightAuditionGenerations.get(generationKey);
    if (!generationPromise) {
      generationPromise = generateAndCommitAudition({
        apiKey,
        originalVoice: voiceName,
        canonicalVoice: canonicalName,
        model,
        requestedFormat: format as AudioFormat,
        cacheKey,
        formatPlan,
      });
      inFlightAuditionGenerations.set(generationKey, generationPromise);
    }

    try {
      const entry = await generationPromise;
      return buildAuditionAudioResponse(entry, forceRefresh ? "refresh" : "miss");
    } finally {
      if (inFlightAuditionGenerations.get(generationKey) === generationPromise) {
        inFlightAuditionGenerations.delete(generationKey);
      }
    }
  } catch (err) {
    if (err instanceof AuditionProviderError) {
      return c.json(buildAuditionError({
        requestId,
        voice: canonicalName,
        code: err.code,
        message: err.message,
        category: err.category,
        retryable: err.retryable,
        metadata: buildAuditionFailureMetadata(err.metadata, forceRefresh, existingCache),
      }), err.status);
    }

    return c.json(buildAuditionError({
      requestId,
      voice: canonicalName,
      code: "INTERNAL_ERROR",
      message: sanitizeText(err instanceof Error ? err.message : "Audition failed"),
      category: "internal",
      retryable: false,
      metadata: forceRefresh && existingCache ? {
        cachePreserved: true,
        existingGeneratedAt: existingCache.metadata.generatedAt,
      } : undefined,
    }), 500);
  }
});

async function generateAndCommitAudition(input: {
  apiKey: string;
  originalVoice: string;
  canonicalVoice: string;
  model: string;
  requestedFormat: AudioFormat;
  cacheKey: string;
  formatPlan: ReturnType<typeof resolveTtsFormat>;
}): Promise<AuditionCacheEntry> {
  const provider = new OpenRouterProvider(input.apiKey);
  const result = await provider.generateSpeech({
    model: input.model,
    input: AUDITION_TEXT,
    voice: input.canonicalVoice,
    responseFormat: input.formatPlan.upstreamFormat,
  });

  if (!result.ok) {
    const safeCode = sanitizeText(result.errorCode || "UPSTREAM_ERROR");
    throw new AuditionProviderError({
      code: safeCode,
      message: sanitizeText(result.errorMessage),
      category: classifyErrorCategory(safeCode),
      retryable: result.retryable,
      status: auditionHttpStatus(safeCode, result.statusCode),
      metadata: result.errorMetadata,
    });
  }

  let audioBuffer = result.audioBuffer;
  if (input.formatPlan.wrapPcmToWav) audioBuffer = wrapPcm16LeToWav(audioBuffer, input.formatPlan.pcmParams);

  return commitAuditionCacheEntry({
    cacheKey: input.cacheKey,
    originalVoice: input.originalVoice,
    canonicalVoice: input.canonicalVoice,
    model: input.model,
    requestedFormat: input.requestedFormat,
    outputFormat: input.formatPlan.outputFormat,
    contentType: input.formatPlan.mimeType,
    auditionText: AUDITION_TEXT,
    audioBuffer,
    extension: input.formatPlan.extension,
  });
}

function buildAuditionAudioResponse(entry: AuditionCacheEntry, cacheStatus: "hit" | "miss" | "refresh"): Response {
  const responseBody = entry.audioBuffer.buffer.slice(
    entry.audioBuffer.byteOffset,
    entry.audioBuffer.byteOffset + entry.audioBuffer.byteLength,
  ) as ArrayBuffer;
  const safeVoiceHeader = toSafeHeaderValue(entry.metadata.canonicalVoice);

  return new Response(responseBody, {
    status: 200,
    headers: {
      "Content-Type": entry.metadata.contentType,
      "Content-Length": String(entry.audioBuffer.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Audition-Voice": safeVoiceHeader,
      "X-Audio-Format": entry.metadata.outputFormat,
      "X-TTS-Audition-Cache": cacheStatus,
      "X-TTS-Audition-Generated-At": entry.metadata.generatedAt,
      "X-TTS-Audition-Voice": safeVoiceHeader,
      "X-TTS-Audition-Cache-Key": `sha256:${entry.cacheKey}`,
      "X-TTS-Audition-Content-Sha256": entry.metadata.contentSha256,
    },
  });
}

function toSafeHeaderValue(value: string): string {
  return /^[\x20-\x7E]+$/.test(value) ? value : encodeURIComponent(value);
}

class AuditionProviderError extends Error {
  readonly code: string;
  readonly category: "validation" | "auth" | "throttle" | "upstream" | "internal" | "unknown";
  readonly retryable: boolean;
  readonly status: 400 | 401 | 402 | 429 | 502 | 504;
  readonly metadata?: Record<string, unknown>;

  constructor(input: {
    code: string;
    message: string;
    category: "validation" | "auth" | "throttle" | "upstream" | "internal" | "unknown";
    retryable: boolean;
    status: 400 | 401 | 402 | 429 | 502 | 504;
    metadata?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "AuditionProviderError";
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable;
    this.status = input.status;
    this.metadata = input.metadata;
  }
}

function buildAuditionFailureMetadata(
  upstreamMetadata: Record<string, unknown> | undefined,
  forceRefresh: boolean,
  existingCache: AuditionCacheEntry | null,
): Record<string, unknown> | undefined {
  if (!forceRefresh || !existingCache) return upstreamMetadata;
  return {
    ...(upstreamMetadata ?? {}),
    cachePreserved: true,
    existingGeneratedAt: existingCache.metadata.generatedAt,
  };
}

async function runOpenRouterProbe(input: {
  apiKey: string;
  model: string;
  voice: string;
  upstreamFormat: AudioFormat;
}): Promise<ProbeResponse> {
  const { apiKey, model, voice: canonicalName, upstreamFormat } = input;
  const db = getDb();

  const start = Date.now();
  try {
    const provider = new OpenRouterProvider(apiKey);

    // Use a short probe text
    const result = await provider.generateSpeech({
      model,
      input: "Hello, this is a voice test.",
      voice: canonicalName,
      responseFormat: upstreamFormat,
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

      return {
        voice: canonicalName,
        verifiedStatus: "verified",
        latencyMs,
        probeJobId: null,
        error: null,
        cached: false,
        cacheTtlSeconds: PROBE_CACHE_TTL_SECONDS,
        lastVerified: updatedProfile?.lastVerified ? toIsoString(updatedProfile.lastVerified) : undefined,
        profile: updatedProfile || undefined,
      };
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

      return {
        voice: canonicalName,
        verifiedStatus: "failed",
        latencyMs,
        probeJobId: null,
        error: sanitizeText(result.errorMessage),
        cached: false,
        cacheTtlSeconds: PROBE_CACHE_TTL_SECONDS,
        lastVerified: new Date().toISOString(),
      };
    }
  } catch (err) {
    const latencyMs = Date.now() - start;
    const rawMsg = err instanceof Error ? err.message : "Probe failed";
    return {
      voice: canonicalName,
      verifiedStatus: "failed",
      latencyMs,
      probeJobId: null,
      error: sanitizeText(rawMsg),
      cached: false,
      cacheTtlSeconds: PROBE_CACHE_TTL_SECONDS,
    };
  }
}

function buildMissingApiKeyResponse(canonicalName: string, existingProfile: VoiceProfileRow | undefined): ProbeResponse {
  return {
    voice: canonicalName,
    verifiedStatus: "failed",
    latencyMs: 0,
    probeJobId: null,
    error: "MISSING_API_KEY",
    cached: false,
    cacheTtlSeconds: PROBE_CACHE_TTL_SECONDS,
    lastVerified: existingProfile?.lastVerified ? toIsoString(existingProfile.lastVerified) : undefined,
    profile: existingProfile || undefined,
  };
}

function buildProbeKey(input: { voice: string; model: string; format: string; force: boolean }): string {
  return `${input.force ? "force" : "normal"}\u0000${input.voice}\u0000${input.model}\u0000${input.format}`;
}

function buildCachedProbeResponse(profile: VoiceProfileRow | undefined): ProbeResponse | null {
  if (!profile?.lastVerified) return null;
  if (profile.verifiedStatus !== "verified" && profile.verifiedStatus !== "failed") return null;

  const lastVerifiedMs = toTimestampMs(profile.lastVerified);
  if (lastVerifiedMs == null) return null;

  const ageMs = Date.now() - lastVerifiedMs;
  if (ageMs < 0 || ageMs > PROBE_CACHE_TTL_SECONDS * 1000) return null;

  return {
    voice: profile.name,
    verifiedStatus: profile.verifiedStatus,
    latencyMs: profile.verifyDuration ?? 0,
    probeJobId: null,
    error: profile.verifiedStatus === "failed" ? profile.verifyError : null,
    cached: true,
    cacheTtlSeconds: PROBE_CACHE_TTL_SECONDS,
    lastVerified: toIsoString(profile.lastVerified),
    profile,
  };
}

function classifyVoiceError(errorMessage: string): string {
  return errorMessage === "MISSING_API_KEY" ? "MISSING_API_KEY" : "VOICE_PROBE_FAILED";
}

function buildAuditionError(input: {
  requestId: string;
  voice?: string;
  code: string;
  message: string;
  category: "validation" | "auth" | "throttle" | "upstream" | "internal" | "unknown";
  retryable: boolean;
  metadata?: Record<string, unknown>;
}): {
  ok: false;
  requestId: string;
  voice?: string;
  error: {
    code: string;
    message: string;
    category: "validation" | "auth" | "throttle" | "upstream" | "internal" | "unknown";
    retryable: boolean;
    metadata?: Record<string, unknown>;
  };
} {
  return {
    ok: false,
    requestId: input.requestId,
    ...(input.voice ? { voice: input.voice } : {}),
    error: {
      code: sanitizeText(input.code),
      message: sanitizeText(input.message),
      category: input.category,
      retryable: input.retryable,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  };
}

function auditionHttpStatus(code: string, providerStatusCode: number): 400 | 401 | 402 | 429 | 502 | 504 {
  switch (code) {
    case "BAD_REQUEST":
    case "MODEL_NOT_FOUND":
      return 400;
    case "INVALID_API_KEY":
    case "FORBIDDEN":
      return 401;
    case "INSUFFICIENT_CREDITS":
      return 402;
    case "RATE_LIMITED":
      return 429;
    case "REQUEST_TIMEOUT":
      return 504;
    default:
      if (providerStatusCode === 400 || providerStatusCode === 404) return 400;
      if (providerStatusCode === 401 || providerStatusCode === 403) return 401;
      if (providerStatusCode === 402) return 402;
      if (providerStatusCode === 429) return 429;
      if (providerStatusCode === 504) return 504;
      return 502;
  }
}

function isOlderThan(value: Date | null, nowMs: number, thresholdMs: number): boolean {
  const timestamp = toTimestampMs(value);
  return timestamp != null && nowMs - timestamp > thresholdMs;
}

function toTimestampMs(value: Date | number | string | null): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toIsoString(value: Date | number | string): string {
  const timestamp = toTimestampMs(value);
  return timestamp == null ? new Date(0).toISOString() : new Date(timestamp).toISOString();
}

export default app;
