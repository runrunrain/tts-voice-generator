import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { audioAsset, generationJob, settings } from "../db/schema.js";
import { isOpenRouterConfigured, requireApiKey, requireProviderApiKey } from "./key-resolver.js";
import { OpenRouterProvider, sanitizeText } from "./openrouter-provider.js";
import { FishAudioProvider } from "./fish-audio-provider.js";
import { selectGenerationRoute } from "./route-selector.js";
import type { GenerationRoute, ProviderChainEntry } from "./provider-adapter.js";
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
  generationRoute: z.enum(["gemini_only", "gemini_elevenlabs_sts", "fish_audio_tts"]).optional(),
  characterVoiceMappingId: z.string().optional(),
  voiceAssetId: z.string().optional(),
  promptAssembly: z.object({
    geminiAudioTags: z.array(z.string().min(1).max(80)).max(20).optional(),
    styleGuidance: z.string().max(1000).optional(),
    source: z.string().max(120).optional(),
  }).optional().nullable(),
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
  const routeDecision = selectGenerationRoute({
    requestedRoute: req.generationRoute,
    characterVoiceMappingId: req.characterVoiceMappingId,
    voiceAssetId: req.voiceAssetId,
    transcript: req.input,
    directorSnapshot: req.directorSnapshot ?? undefined,
    providerOptions: req.providerOptions ?? undefined,
  });

  if (routeDecision.blocked) {
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
      errorCode: "ROUTE_BLOCKED",
      errorMessage: "Generation route is blocked by provider configuration or license gate.",
      errorMetadata: JSON.stringify({ complianceBlocks: routeDecision.complianceBlocks }),
      generationRoute: routeDecision.route,
      providerChainJson: JSON.stringify(routeDecision.providerChain),
      voiceAssetId: routeDecision.voiceAssetId ?? null,
      licenseRecordId: routeDecision.licenseRecordId ?? null,
      routeDecisionJson: JSON.stringify(routeDecision),
      complianceJson: JSON.stringify({ blocked: true, blocks: routeDecision.complianceBlocks, licenseGate: routeDecision.licenseGate }),
      source: sourceContext.source,
      agentConversationId: sourceContext.agentConversationId ?? null,
      agentActionLogId: sourceContext.agentActionLogId ?? null,
      createdAt: new Date(),
      completedAt: new Date(),
    }).run();
    return {
      status: 400,
      body: {
        ok: false,
        requestId,
        jobId,
        status: "failed",
        generationRoute: routeDecision.route,
        providerChain: routeDecision.providerChain,
        voiceAssetId: routeDecision.voiceAssetId,
        licenseRecordId: routeDecision.licenseRecordId,
        compliance: { blocked: true, blocks: routeDecision.complianceBlocks, warnings: routeDecision.licenseGate?.warnings ?? [] },
        error: {
          code: routeDecision.complianceBlocks.some((block) => block.startsWith("PROVIDER_KEY_MISSING")) ? "PROVIDER_KEY_MISSING" : "ROUTE_BLOCKED",
          message: "Generation route is blocked by provider configuration or license gate.",
          category: "validation" as const,
          retryable: false,
          metadata: { routeDecision },
        },
        charCount: req.input.length,
        createdAt: new Date().toISOString(),
      },
    };
  }

  if (routeDecision.route === "fish_audio_tts") {
    return generateFishSpeech(req, requestId, sourceContext, routeDecision, formatPlan.outputFormat);
  }

  if (routeDecision.route === "gemini_elevenlabs_sts") {
    return buildRouteNotImplementedResult(req, requestId, sourceContext, routeDecision, canonicalVoice, formatPlan.outputFormat);
  }

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
      generationRoute: routeDecision.route,
      providerChainJson: JSON.stringify(routeDecision.providerChain),
      routeDecisionJson: JSON.stringify(routeDecision),
      complianceJson: JSON.stringify({ blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] }),
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
        generationRoute: routeDecision.route,
        providerChain: routeDecision.providerChain,
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
      generationRoute: routeDecision.route,
      providerChainJson: JSON.stringify(routeDecision.providerChain),
      routeDecisionJson: JSON.stringify(routeDecision),
      complianceJson: JSON.stringify({ blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] }),
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
        generationRoute: routeDecision.route,
        providerChain: routeDecision.providerChain,
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
    generationRoute: routeDecision.route,
    providerChainJson: JSON.stringify(routeDecision.providerChain),
    voiceAssetId: routeDecision.voiceAssetId ?? null,
    licenseRecordId: routeDecision.licenseRecordId ?? null,
    routeDecisionJson: JSON.stringify(routeDecision),
    costMetadataJson: JSON.stringify({ estimatedUsd: estimateCostNumber(req.input.length), route: routeDecision.route }),
    complianceJson: JSON.stringify({ blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] }),
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
        pipelineStage: "final",
        provider: "openrouter-gemini",
        model: req.model,
        voiceAssetId: routeDecision.voiceAssetId ?? null,
        aiDisclosureJson: JSON.stringify({ aiGenerated: true, providerChain: routeDecision.providerChain, route: routeDecision.route }),
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
          generationRoute: routeDecision.route,
          providerChain: attachAssetToFinalStage(routeDecision.providerChain, assetId),
          voiceAssetId: routeDecision.voiceAssetId,
          licenseRecordId: routeDecision.licenseRecordId,
          compliance: { blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] },
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
        generationRoute: routeDecision.route,
        providerChain: routeDecision.providerChain,
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
        generationRoute: routeDecision.route,
        providerChain: routeDecision.providerChain,
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

async function generateFishSpeech(
  req: GenerateSpeechRequest,
  requestId: string,
  sourceContext: SourceContext,
  routeDecision: ReturnType<typeof selectGenerationRoute>,
  outputFormat: AudioFormat,
): Promise<GenerateSpeechResult> {
  const db = getDb();
  const settingsRow = db.select().from(settings).where(eq(settings.id, 1)).get();
  const maxChars = settingsRow?.maxCharsPerRequest || 5000;
  const maxConcurrent = settingsRow?.maxConcurrentJobs || 2;
  const canonicalVoice = canonicalizeVoice(req.voice);
  const createdAt = new Date();

  if (req.input.length > maxChars) {
    const jobId = uuidv4();
    db.insert(generationJob).values({
      id: jobId,
      model: readNestedOption(req.providerOptions, ["fish", "model"]) ?? "speech-1.5",
      voice: canonicalVoice,
      responseFormat: outputFormat,
      input: req.input,
      inputCharCount: req.input.length,
      status: "failed",
      errorCode: "TEXT_TOO_LONG",
      errorMessage: `Input text exceeds maximum length of ${maxChars} characters (got ${req.input.length}).`,
      generationRoute: routeDecision.route,
      providerChainJson: JSON.stringify(routeDecision.providerChain),
      voiceAssetId: routeDecision.voiceAssetId ?? null,
      licenseRecordId: routeDecision.licenseRecordId ?? null,
      routeDecisionJson: JSON.stringify(routeDecision),
      complianceJson: JSON.stringify({ blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] }),
      source: sourceContext.source,
      agentConversationId: sourceContext.agentConversationId ?? null,
      agentActionLogId: sourceContext.agentActionLogId ?? null,
      createdAt,
      completedAt: createdAt,
    }).run();
    return {
      status: 400,
      body: {
        ok: false,
        requestId,
        jobId,
        status: "failed",
        generationRoute: routeDecision.route,
        providerChain: routeDecision.providerChain,
        error: { code: "TEXT_TOO_LONG", message: `Input text exceeds maximum length of ${maxChars} characters (got ${req.input.length}).`, category: "validation" as const, retryable: false },
        charCount: req.input.length,
        createdAt: createdAt.toISOString(),
      },
    };
  }

  const slotResult = acquireSlot(maxConcurrent);
  if (!slotResult.allowed) {
    return {
      status: 503,
      body: { ok: false, requestId, jobId: null, status: "failed", generationRoute: routeDecision.route, providerChain: routeDecision.providerChain, error: slotResult.error, charCount: req.input.length, createdAt: createdAt.toISOString() },
    };
  }

  const jobId = uuidv4();
  const model = readNestedOption(req.providerOptions, ["fish", "model"]) ?? "speech-1.5";
  const responseFormat = normalizeExternalFormat(readNestedOption(req.providerOptions, ["fish", "format"]) ?? outputFormat);
  const estimatedUsd = Number((Buffer.byteLength(req.input, "utf8") * 0.000015).toFixed(8));
  db.insert(generationJob).values({
    id: jobId,
    model,
    voice: routeDecision.fishReferenceId ?? canonicalVoice,
    responseFormat,
    input: req.input,
    inputCharCount: req.input.length,
    status: "running",
    estimatedCost: `$${estimatedUsd.toFixed(4)}`,
    providerOptions: req.providerOptions ? JSON.stringify(req.providerOptions) : null,
    directorSnapshot: req.directorSnapshot ? JSON.stringify(req.directorSnapshot) : null,
    generationRoute: routeDecision.route,
    providerChainJson: JSON.stringify(routeDecision.providerChain),
    voiceAssetId: routeDecision.voiceAssetId ?? null,
    licenseRecordId: routeDecision.licenseRecordId ?? null,
    routeDecisionJson: JSON.stringify(routeDecision),
    costMetadataJson: JSON.stringify({ estimatedUsd, inputBytes: Buffer.byteLength(req.input, "utf8"), route: routeDecision.route }),
    complianceJson: JSON.stringify({ blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] }),
    source: sourceContext.source,
    agentConversationId: sourceContext.agentConversationId ?? null,
    agentActionLogId: sourceContext.agentActionLogId ?? null,
    createdAt,
  }).run();

  try {
    const provider = new FishAudioProvider(requireProviderApiKey("fish-audio"));
    const result = await provider.generateSpeech({
      text: req.input,
      referenceId: routeDecision.fishReferenceId ?? "",
      model,
      format: responseFormat,
    });
    const now = new Date();
    if (!result.ok || !result.audioBuffer) {
      db.update(generationJob).set({
        status: "failed",
        errorCode: result.ok ? "UNEXPECTED_RESPONSE_TYPE" : result.errorCode,
        errorMessage: result.ok ? "Fish response did not include audio." : sanitizeText(result.errorMessage),
        errorMetadata: JSON.stringify(result.safeMetadata ?? {}),
        completedAt: now,
      }).where(eq(generationJob.id, jobId)).run();
      releaseSlot(slotResult.slotId);
      return {
        status: result.ok ? 502 : providerHttpStatus(result.statusCode),
        body: {
          ok: false,
          requestId,
          jobId,
          status: "failed",
          generationRoute: routeDecision.route,
          providerChain: routeDecision.providerChain,
          voiceAssetId: routeDecision.voiceAssetId,
          licenseRecordId: routeDecision.licenseRecordId,
          compliance: { blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] },
          error: {
            code: result.ok ? "UNEXPECTED_RESPONSE_TYPE" : result.errorCode,
            message: result.ok ? "Fish response did not include audio." : sanitizeText(result.errorMessage),
            category: result.ok ? "upstream" as const : classifyErrorCategory(result.errorCode),
            retryable: result.ok ? false : result.retryable,
            metadata: result.ok ? undefined : result.safeMetadata,
          },
          charCount: req.input.length,
          createdAt: now.toISOString(),
        },
      };
    }

    const extension = responseFormat === "mp3" ? "mp3" : responseFormat === "pcm" ? "pcm" : "wav";
    const filePath = writeAudioFile(jobId, extension, result.audioBuffer, now);
    const sha256 = computeSha256(result.audioBuffer);
    const audioAnalysis: WavAnalysisResult = extension === "wav" ? analyzeWavBuffer(result.audioBuffer) : { ok: false, code: "UNSUPPORTED_CONTAINER", message: "Non-WAV output is not analyzed as WAV." };
    const usableAudioAnalysis = getUsableAudioAnalysis(audioAnalysis);
    const duration = usableAudioAnalysis ? `${usableAudioAnalysis.durationSeconds.toFixed(1)}s` : `${Math.max(0.5, req.input.length * 0.007).toFixed(1)}s`;
    const providerChain = attachLatencyToFinalStage(routeDecision.providerChain, result.latencyMs, result.providerRequestId ?? null);
    db.update(generationJob).set({
      status: "succeeded",
      generationId: result.providerRequestId ?? null,
      actualCost: `$${estimatedUsd.toFixed(4)}`,
      providerChainJson: JSON.stringify(providerChain),
      completedAt: now,
    }).where(eq(generationJob.id, jobId)).run();
    const assetResult = db.insert(audioAsset).values({
      jobId,
      fileName: `${jobId}.${extension}`,
      filePath,
      mimeType: result.contentType ?? mimeForFormat(responseFormat),
      sizeBytes: result.audioBuffer.length,
      sha256,
      duration,
      sampleRate: usableAudioAnalysis ? usableAudioAnalysis.sampleRate : null,
      bitDepth: usableAudioAnalysis ? usableAudioAnalysis.bitsPerSample : null,
      channels: usableAudioAnalysis ? usableAudioAnalysis.channels : null,
      pipelineStage: "final",
      provider: "fish-audio",
      model,
      voiceAssetId: routeDecision.voiceAssetId ?? null,
      aiDisclosureJson: JSON.stringify({ aiGenerated: true, providerChain, route: routeDecision.route, safeProviderMetadata: result.safeMetadata }),
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
        generationId: result.providerRequestId,
        generationRoute: routeDecision.route,
        providerChain: attachAssetToFinalStage(providerChain, assetId),
        voiceAssetId: routeDecision.voiceAssetId,
        licenseRecordId: routeDecision.licenseRecordId,
        compliance: { blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] },
        cost: { estimatedUsd, actualUsd: estimatedUsd, budgetStatus: "within_budget" },
        assetId,
        audioUrl: `/api/audio/${assetId}`,
        contentType: result.contentType ?? mimeForFormat(responseFormat),
        duration,
        sizeBytes: result.audioBuffer.length,
        charCount: req.input.length,
        estimatedCost: `$${estimatedUsd.toFixed(4)}`,
        createdAt: now.toISOString(),
      },
    };
  } catch (error) {
    releaseSlot(slotResult.slotId);
    const now = new Date();
    const safeMessage = sanitizeText(error instanceof Error ? error.message : "Fish generation failed.");
    db.update(generationJob).set({ status: "failed", errorCode: "PROVIDER_ERROR", errorMessage: safeMessage, completedAt: now }).where(eq(generationJob.id, jobId)).run();
    return {
      status: 502,
      body: { ok: false, requestId, jobId, status: "failed", generationRoute: routeDecision.route, providerChain: routeDecision.providerChain, error: { code: "PROVIDER_ERROR", message: safeMessage, category: "upstream" as const, retryable: true }, charCount: req.input.length, createdAt: now.toISOString() },
    };
  }
}

function buildRouteNotImplementedResult(
  req: GenerateSpeechRequest,
  requestId: string,
  sourceContext: SourceContext,
  routeDecision: ReturnType<typeof selectGenerationRoute>,
  canonicalVoice: string,
  outputFormat: AudioFormat,
): GenerateSpeechResult {
  const jobId = uuidv4();
  const now = new Date();
  getDb().insert(generationJob).values({
    id: jobId,
    model: req.model,
    voice: canonicalVoice,
    responseFormat: outputFormat,
    input: req.input,
    inputCharCount: req.input.length,
    status: "failed",
    errorCode: "ROUTE_NOT_ENABLED",
    errorMessage: "Gemini + ElevenLabs STS generation route is not enabled in this backend foundation slice.",
    generationRoute: routeDecision.route,
    providerChainJson: JSON.stringify(routeDecision.providerChain),
    voiceAssetId: routeDecision.voiceAssetId ?? null,
    licenseRecordId: routeDecision.licenseRecordId ?? null,
    routeDecisionJson: JSON.stringify(routeDecision),
    complianceJson: JSON.stringify({ blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] }),
    source: sourceContext.source,
    agentConversationId: sourceContext.agentConversationId ?? null,
    agentActionLogId: sourceContext.agentActionLogId ?? null,
    createdAt: now,
    completedAt: now,
  }).run();
  return {
    status: 501,
    body: {
      ok: false,
      requestId,
      jobId,
      status: "failed",
      generationRoute: routeDecision.route,
      providerChain: routeDecision.providerChain,
      voiceAssetId: routeDecision.voiceAssetId,
      licenseRecordId: routeDecision.licenseRecordId,
      compliance: { blocked: false, warnings: routeDecision.licenseGate?.warnings ?? [] },
      error: { code: "ROUTE_NOT_ENABLED", message: "Gemini + ElevenLabs STS generation route is not enabled in this backend foundation slice.", category: "validation" as const, retryable: false },
      charCount: req.input.length,
      createdAt: now.toISOString(),
    },
  };
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

function readNestedOption(source: Record<string, unknown> | null | undefined, path: string[]): string | null {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

function normalizeExternalFormat(value: string): "wav" | "pcm" | "mp3" {
  return value === "mp3" || value === "pcm" || value === "wav" ? value : "wav";
}

function mimeForFormat(value: "wav" | "pcm" | "mp3"): string {
  if (value === "mp3") return "audio/mpeg";
  if (value === "pcm") return "audio/L16";
  return "audio/wav";
}

function providerHttpStatus(statusCode: number): 400 | 401 | 402 | 429 | 502 | 504 {
  if (statusCode === 400 || statusCode === 404) return 400;
  if (statusCode === 401 || statusCode === 403) return 401;
  if (statusCode === 402) return 402;
  if (statusCode === 429) return 429;
  if (statusCode === 504) return 504;
  return 502;
}

function attachLatencyToFinalStage(chain: ProviderChainEntry[], latencyMs: number, requestId: string | null): ProviderChainEntry[] {
  return chain.map((entry, index) => index === chain.length - 1 ? { ...entry, latencyMs, requestId } : entry);
}

function attachAssetToFinalStage(chain: ProviderChainEntry[], assetId: number): ProviderChainEntry[] {
  return chain.map((entry, index) => index === chain.length - 1 ? { ...entry, assetId } : entry);
}
