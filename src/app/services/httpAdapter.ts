/**
 * HTTP Service Adapter
 *
 * Real implementation of TtsServiceAdapter that communicates with the
 * backend Hono API server. Replaces demoAdapter for production use.
 *
 * Every method calls the actual /api/* endpoints and maps responses
 * to the existing type definitions.
 */

import type {
  AudioFormat,
  CostEstimate,
  ConnectionStatus,
  Diagnostics,
  GenerateRequest,
  GenerateResult,
  GeneratePhase,
  HistoryFilter,
  HistoryRecord,
  HistoryStatus,
  HistorySource,
  VoiceProfile,
  VoiceStats,
  VoiceStatus,
  TtsServiceAdapter,
  AssemblePromptRequest,
  AssemblePromptResponse,
  AgentButton,
  AgentButtonListResult,
  AgentChatMessage,
  AgentRunCancelResult,
  AgentRunDetail,
  AgentRunDiff,
  AgentRunSummary,
  AgentRunStatus,
  CandidateExtractionQualitySummary,
  DirectorProfile,
  NormalizeRunProgress,
  NormalizeRunStage,
  NormalizeStartResponse,
  NormalizeTimeoutBasis,
  PromptOverride,
  PromptProfile,
  PromptSpeaker,
  OpencodeSession,
  ProductionList,
  ProductionListSpeaker,
  ProductionListValidationReport,
  RequirementDocument,
  ResponseFormat,
  Task,
  TaskStatus,
  VoiceLine,
  GenerateFromListRequest,
  GenerateFromListResponse,
  ProductionListDiff,
  ProductionListExportFormat,
  ProductionListExportResult,
  ProductionListImportResult,
  ProductionListQualityReport,
  ProductionListRollbackResult,
  ProductionListVersionEntry,
} from "../types";
import { getVoiceDisplayMeta } from "../utils/voiceDisplay";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = status === 409 ? "VersionConflictError" : "ApiError";
    this.status = status;
    this.body = body;
  }

  get isConflict() {
    return this.status === 409;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromBody(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.detail;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof body === "string" && body.length > 0) return body.slice(0, 200);
  if (status === 409) return "版本冲突：服务端数据已更新";
  return `API Error ${status}`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new ApiError(response.status, errorMessageFromBody(response.status, body), body);
  }

  const body = await readResponseBody(response);
  return body as T;
}

function mapVoiceStatus(status: string): VoiceStatus {
  switch (status) {
    case "verified": return "success";
    case "failed": return "error";
    case "unknown": return "pending";
    default: return "pending";
  }
}

function mapHistorySource(source: string | null | undefined): HistorySource {
  const normalized = (source ?? "").trim().toLowerCase();
  if (normalized === "cli") return "cli";
  if (normalized === "agent") return "agent";
  if (normalized === "user") return "user";

  // Backward-compatible mapping for legacy localized values that older
  // adapters could still emit. Unknown values fall back to user rather than
  // agent so CLI-originated records are never merged into the Agent bucket.
  if (source === "Agent") return "agent";
  if (source === "用户") return "user";
  return "user";
}

// ─── Format Resolution ────────────────────────────────────────────────────────

/**
 * Resolve the actual audio format from the backend response.
 *
 * Priority:
 * 1. outputFormat field (explicit, always correct)
 * 2. Infer from Content-Type header (fallback for older backends)
 * 3. Fall back to the user-requested format (last resort)
 */
function resolveActualFormat(
  outputFormat: AudioFormat | undefined,
  contentType: string | undefined,
  fallback: AudioFormat,
): AudioFormat {
  if (outputFormat === "wav" || outputFormat === "pcm" || outputFormat === "mp3") {
    return outputFormat;
  }

  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("wav")) return "wav";
    if (ct.includes("pcm")) return "pcm";
    if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  }

  return fallback;
}

/**
 * Resolve the display format for a history record.
 *
 * Priority:
 * 1. assetFormat - the actual format of the audio file on disk (from mimeType)
 * 2. job format  - the requested/response format stored on the job record (fallback)
 *
 * This ensures that when a legacy "mp3" request actually produces a "wav" file
 * (because the upstream provider only outputs PCM, which gets wrapped to WAV),
 * the history list shows the real format the user can download.
 */
function resolveHistoryFormat(assetFormat: string | null | undefined, jobFormat: string | undefined): string {
  if (assetFormat && (assetFormat === "wav" || assetFormat === "pcm" || assetFormat === "mp3")) {
    return assetFormat;
  }
  if (jobFormat && (jobFormat === "wav" || jobFormat === "pcm" || jobFormat === "mp3")) {
    return jobFormat;
  }
  return "wav";
}

// ─── Adapter Implementation ──────────────────────────────────────────────────

export const httpAdapter: TtsServiceAdapter = {
  async generateSpeech(req: GenerateRequest): Promise<GenerateResult> {
    if (!req.text.trim()) {
      return {
        jobId: `err-empty-${Date.now().toString(36)}`,
        phase: "error" as GeneratePhase,
        voice: req.voice,
        format: req.format,
        charCount: 0,
        duration: "0.0s",
        estimatedCost: "$0.00",
        error: {
          code: "EMPTY_TEXT",
          message: "文本内容不能为空。",
        },
        timestamp: new Date().toISOString(),
        isDemo: false,
      };
    }

    try {
      const body: Record<string, unknown> = {
        model: "google/gemini-3.1-flash-tts-preview",
        input: req.text,
        voice: req.voice,
        responseFormat: req.format,
      };

      const hasDirectorFields = req.audioProfile?.trim() || req.scene?.trim() || req.directorNotes?.trim() || req.style?.trim() || req.pacing?.trim() || req.accent?.trim() || req.emotion?.trim() || req.performanceNotes?.trim() || req.sampleContext?.trim() || req.transcript?.trim() || (req.speakers && req.speakers.length > 0);
      if (hasDirectorFields) {
        body.directorSnapshot = {
          audioProfile: req.audioProfile?.trim() || undefined,
          scene: req.scene?.trim() || undefined,
          directorNotes: req.directorNotes?.trim() || undefined,
          style: req.style?.trim() || undefined,
          pacing: req.pacing?.trim() || undefined,
          accent: req.accent?.trim() || undefined,
          emotion: req.emotion?.trim() || undefined,
          performanceNotes: req.performanceNotes?.trim() || undefined,
          sampleContext: req.sampleContext?.trim() || undefined,
          // Preserve the original user transcript, not the assembled prompt.
          // req.transcript is the raw user input; req.text is the assembled TTS prompt.
          // Fall back to req.text only when no explicit transcript was provided.
          transcript: req.transcript?.trim() || req.text,
          speakers: req.speakers?.map((s) => ({
            id: s.id,
            label: s.label,
            name: s.name || undefined,
            voice: s.voice || undefined,
            style: s.style || undefined,
          })),
        };
      }

      const result = await apiFetch<{
        jobId: string;
        status: string;
        error?: { code: string; message: string; metadata?: unknown };
        charCount?: number;
        audioUrl?: string;
        contentType?: string;
        duration?: string;
        sizeBytes?: number;
        estimatedCost?: string;
        createdAt?: string;
        generationId?: string;
        assetId?: number;
        /** Actual output format after server-side resolution (e.g. "wav" when user requested "mp3" for Gemini) */
        outputFormat?: AudioFormat;
        /** The format the user originally requested */
        requestedFormat?: AudioFormat;
        /** The format sent to the upstream provider */
        upstreamFormat?: "pcm" | "mp3";
      }>("/api/tts/generate", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (result.status === "succeeded") {
        // Resolve the actual output format: prefer outputFormat from backend,
        // fall back to inferring from contentType, and finally to req.format.
        const actualFormat = resolveActualFormat(
          result.outputFormat,
          result.contentType,
          req.format,
        );

        return {
          jobId: result.jobId,
          phase: "success",
          voice: req.voice,
          format: actualFormat,
          charCount: result.charCount || req.text.length,
          duration: result.duration || "0.0s",
          estimatedCost: result.estimatedCost || "$0.00",
          audioUrl: result.audioUrl,
          timestamp: result.createdAt || new Date().toISOString(),
          isDemo: false,
        };
      } else {
        return {
          jobId: result.jobId || `err-${Date.now().toString(36)}`,
          phase: "error" as GeneratePhase,
          voice: req.voice,
          format: req.format,
          charCount: result.charCount || req.text.length,
          duration: "0.0s",
          estimatedCost: "$0.00",
          error: result.error || {
            code: "UNKNOWN",
            message: "Generation failed with unknown error",
          },
          timestamp: result.createdAt || new Date().toISOString(),
          isDemo: false,
        };
      }
    } catch (err) {
      return {
        jobId: `err-net-${Date.now().toString(36)}`,
        phase: "error" as GeneratePhase,
        voice: req.voice,
        format: req.format,
        charCount: req.text.length,
        duration: "0.0s",
        estimatedCost: "$0.00",
        error: {
          code: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : "Network error: cannot reach backend server",
        },
        timestamp: new Date().toISOString(),
        isDemo: false,
      };
    }
  },

  async probeVoice(voiceName: string, force?: boolean): Promise<{ status: VoiceStatus; latency: string; cached?: boolean; cacheTtlSeconds?: number | null; lastVerified?: string | null }> {
    try {
      const result = await apiFetch<{
        voice: string;
        verifiedStatus: string;
        latencyMs: number;
        error: string | null;
        cached?: boolean;
        cacheTtlSeconds?: number | null;
        lastVerified?: string | null;
      }>("/api/voices/probe", {
        method: "POST",
        body: JSON.stringify({
          voice: voiceName,
          model: "google/gemini-3.1-flash-tts-preview",
          format: "wav",
          ...(force ? { force: true } : {}),
        }),
      });

      if (result.error) {
        return { status: "error" as VoiceStatus, latency: "N/A", error: result.error };
      }

      return {
        status: result.verifiedStatus === "verified" ? "success" : "error",
        latency: `${(result.latencyMs / 1000).toFixed(1)}s`,
        cached: result.cached,
        cacheTtlSeconds: result.cacheTtlSeconds,
        lastVerified: result.lastVerified,
      };
    } catch {
      return { status: "error", latency: "N/A", error: "NETWORK_ERROR" };
    }
  },

  async testConnection(): Promise<ConnectionStatus> {
    try {
      const result = await apiFetch<{
        ok: boolean;
        authValid?: boolean;
        errorCode?: string;
        error: string | null;
      }>("/api/settings/test", { method: "POST" });

      if (result.error === "MISSING_API_KEY" || result.errorCode === "MISSING_API_KEY" || result.authValid === false) {
        return "failed";
      }
      return result.ok && result.authValid !== false ? "connected" : "failed";
    } catch {
      return "failed";
    }
  },

  listVoices(): VoiceProfile[] {
    // This is called synchronously, so we return the cached/default list.
    // The real data is fetched via the backend in AppContext.
    // For now, return a minimal list that will be replaced by async load.
    return [];
  },

  async listVoicesAsync(): Promise<{ voices: VoiceProfile[]; stats: VoiceStats }> {
    const result = await apiFetch<{
      voices: Array<{
        id: number;
        name: string;
        provider: string;
        model: string | null;
        role: string | null;
        source: string;
        verifiedStatus: string;
        lastVerified: number | null;
        verifyDuration: number | null;
        verifyError: string | null;
      }>;
      stats: {
        total: number;
        verified: number;
        failed: number;
        unknown: number;
        staleVerified: number;
        neverVerified: number;
        avgLatencyMs: number | null;
        errorSummary: Array<{
          voice?: string;
          errorCode?: string;
          errorMessage?: string;
          error?: string;
          count: number;
          lastOccurrence?: string;
        }>;
      };
    }>("/api/voices");

    return {
      voices: result.voices.map((v) => ({
        name: v.name,
        displayName: getVoiceDisplayMeta(v.name).displayName,
        toneDescription: getVoiceDisplayMeta(v.name).toneDescription,
        isDefault: v.source === "default",
        role: v.role || "",
        provider: v.provider === "openrouter" ? "OpenRouter" : v.provider,
        status: mapVoiceStatus(v.verifiedStatus),
        lastVerified: v.lastVerified ? new Date(v.lastVerified).toISOString().split("T")[0] : "",
        verifyDuration: v.verifyDuration ? `${(v.verifyDuration / 1000).toFixed(1)}s` : undefined,
        verifyError: v.verifyError || undefined,
      })),
      stats: {
        ...result.stats,
        errorSummary: result.stats.errorSummary.map((e) => ({
          voice: e.voice,
          errorCode: e.errorCode,
          errorMessage: e.errorMessage || e.error || "未知错误",
          count: e.count,
          lastOccurrence: e.lastOccurrence,
        })),
      },
    };
  },

  listHistory(filter: HistoryFilter): { records: HistoryRecord[]; totalPages: number } {
    // This is synchronous in the interface, but we'll handle it via async in AppContext.
    // Return empty - real data loaded via listHistoryAsync.
    return { records: [], totalPages: 1 };
  },

  async listHistoryAsync(filter: HistoryFilter): Promise<{ records: HistoryRecord[]; totalPages: number; totalRecords?: number }> {
    const params = new URLSearchParams();
    params.set("page", filter.page.toString());
    params.set("pageSize", filter.pageSize.toString());
    if (filter.voice) params.set("voice", filter.voice);
    if (filter.status) params.set("status", filter.status);
    if (filter.source) params.set("source", filter.source);

    const result = await apiFetch<{
      records: Array<{
        id: string;
        textPreview: string;
        voice: string;
        format: string;
        status: string;
        source: string;
        charCount: number;
        cost: string | null;
        createdAt: string | null;
        error?: string;
        assetId: number | null;
        audioUrl: string | null;
        downloadUrl: string | null;
        durationMs: number | null;
        assetFormat: string | null;
        sizeBytes: number | null;
        sampleRate?: number | null;
        bitDepth?: number | null;
        channels?: number | null;
        agentConversationId?: string | null;
        agentActionLogId?: number | null;
      }>;
      totalPages: number;
      currentPage: number;
      totalRecords: number;
    }>(`/api/history?${params.toString()}`);

    return {
      records: result.records.map((r) => ({
        id: r.id,
        text: r.textPreview,
        voice: r.voice,
        format: resolveHistoryFormat(r.assetFormat, r.format) as AudioFormat,
        date: r.createdAt ? new Date(r.createdAt).toLocaleString("zh-CN") : "",
        source: mapHistorySource(r.source),
        duration: r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "0.0s",
        status: mapHistoryStatus(r.status),
        cost: r.cost || undefined,
        charCount: r.charCount,
        error: r.error,
        assetId: r.assetId,
        audioUrl: r.audioUrl,
        downloadUrl: r.downloadUrl,
        durationMs: r.durationMs,
        assetFormat: r.assetFormat,
        sizeBytes: r.sizeBytes,
        sampleRate: r.sampleRate,
        bitDepth: r.bitDepth,
        channels: r.channels,
        agentConversationId: r.agentConversationId ?? null,
        agentActionLogId: r.agentActionLogId ?? null,
      })),
      totalPages: result.totalPages,
      totalRecords: result.totalRecords,
    };
  },

  estimateCost(charCount: number, _format: AudioFormat): CostEstimate {
    // Client-side cost estimation: ~$0.000021 per char
    // Based on OpenRouter pricing: $1/M input + $20/M output tokens
    const cost = charCount * 0.000021;
    return {
      chars: charCount,
      estimatedCost: `$${cost.toFixed(4)}`,
      formula: `${charCount} chars x ~$0.000021/char (OpenRouter Gemini TTS)`,
    };
  },

  async assemblePrompt(req: AssemblePromptRequest): Promise<AssemblePromptResponse> {
    try {
      const response = await fetch("/api/prompts/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioProfile: req.audioProfile ?? "",
          scene: req.scene ?? "",
          directorNotes: req.directorNotes ?? "",
          style: req.style ?? "",
          pacing: req.pacing ?? "",
          accent: req.accent ?? "",
          emotion: req.emotion ?? "",
          performanceNotes: req.performanceNotes ?? "",
          sampleContext: req.sampleContext ?? "",
          transcript: req.transcript,
          speakers: (req.speakers ?? []).map((s) => ({
            id: s.id,
            label: s.label,
            name: s.name ?? "",
            voice: s.voice ?? "Zephyr",
            style: s.style ?? "",
          })),
        }),
      });

      // Parse JSON body regardless of HTTP status -- the backend returns
      // structured error objects with code/message/category/retryable
      // for 400 responses (VALIDATION_ERROR, DIRECTOR_SPEAKER_LIMIT_EXCEEDED, etc.)
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // Non-JSON response (network proxy, CDN, etc.)
        return {
          ok: false,
          requestId: `err-${Date.now().toString(36)}`,
          error: {
            code: "NETWORK_ERROR",
            message: `Unexpected response (HTTP ${response.status}): non-JSON body`,
            category: "internal",
            retryable: false,
          },
        };
      }

      // If the body is a valid AssemblePromptResponse (has ok field), return it directly.
      // The backend always returns { ok, requestId, ... } for both success and error.
      if (body && typeof body === "object" && "ok" in body) {
        return body as AssemblePromptResponse;
      }

      // Fallback for unexpected body shape
      return {
        ok: false,
        requestId: `err-${Date.now().toString(36)}`,
        error: {
          code: "NETWORK_ERROR",
          message: `Unexpected response format (HTTP ${response.status})`,
          category: "internal",
          retryable: false,
        },
      };
    } catch (err) {
      // Network-level error: fetch itself threw (CORS, DNS, connection refused, timeout)
      return {
        ok: false,
        requestId: `err-${Date.now().toString(36)}`,
        error: {
          code: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : "Cannot reach backend server",
          category: "internal",
          retryable: true,
        },
      };
    }
  },
};

function mapHistoryStatus(status: string): HistoryStatus {
  switch (status) {
    case "succeeded": return "success";
    case "failed": return "error";
    case "pending":
    case "running": return "pending";
    default: return "pending";
  }
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

/**
 * Backend diagnostics raw row shapes.
 * These reflect the ACTUAL fields returned by GET /api/diagnostics,
 * which differ significantly from the frontend Diagnostics type.
 */
interface BackendFailedJob {
  id: string;
  status?: string;
  source?: string;
  voice?: string;
  format?: string;
  inputCharCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  error?: string;
  createdAt?: string | null;
  completedAt?: string | null;
}

interface BackendAgentAction {
  id: number;
  conversationId?: string | null;
  action?: string;
  status?: string;
  actionType?: string;
  toolName?: string | null;
  approvalStatus?: string;
  approvalScope?: string | null;
  relatedJobId?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
}

interface BackendRecentJob {
  id: string;
  status?: string;
  source?: string;
  voice?: string;
  format?: string;
  inputCharCount?: number;
  charCount?: number;
  errorCode?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
}

interface BackendDiagnosticsResponse {
  ok?: boolean;
  timestamp?: string;
  server?: { version?: string; uptime?: number; nodeEnv?: string };
  ready?: boolean;
  checks?: Array<{ name: string; ok: boolean; detail?: string; latencyMs?: number }>;
  summary?: {
    keyConfigured?: boolean;
    dbOk?: boolean;
    audioDirWritable?: boolean;
    routesReady?: boolean;
    orphanFiles?: number;
    activeJobs?: number;
  };
  // Top-level convenience booleans (aliases into summary)
  dbOk?: boolean;
  audioDirWritable?: boolean;
  keyConfigured?: boolean;
  routesReady?: boolean;
  // Data arrays -- note the backend field names differ from frontend
  failedJobs?: BackendFailedJob[];
  recentAgentActions?: BackendAgentAction[];
  recentJobs?: BackendRecentJob[];
  audioDir?: string | { path?: string; writable?: boolean; fileCount?: number; totalSizeBytes?: number };
  // Frontend aliases (backend may also add these; defense-in-depth: prefer backend names)
  status?: string;
  uptime?: number;
  version?: string;
  recentFailedJobs?: BackendFailedJob[];
  audioDirPath?: string;
}

/**
 * Defensive string extraction: coerces null/undefined to a fallback.
 */
function safeStr(val: unknown, fallback: string): string {
  if (typeof val === "string" && val.length > 0) return val;
  return fallback;
}

/**
 * Defensive number extraction: coerces undefined/null/NaN to a fallback.
 */
function safeNum(val: unknown, fallback: number): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  return fallback;
}

/**
 * Extract the readiness summary as a flat checks object.
 * The backend returns checks as an array of { name, ok } and a summary object.
 * We prefer the summary object for simplicity, falling back to scanning the checks array.
 */
function extractChecks(raw: BackendDiagnosticsResponse): {
  keyConfigured: boolean;
  dbOk: boolean;
  audioDirWritable: boolean;
  routesReady: boolean;
} {
  const summary = raw.summary;
  if (summary && typeof summary === "object") {
    return {
      keyConfigured: summary.keyConfigured ?? raw.keyConfigured ?? false,
      dbOk: summary.dbOk ?? raw.dbOk ?? false,
      audioDirWritable: summary.audioDirWritable ?? raw.audioDirWritable ?? false,
      routesReady: summary.routesReady ?? raw.routesReady ?? false,
    };
  }

  // Fallback: scan the checks array for known names
  const checksMap: Record<string, boolean> = {};
  if (Array.isArray(raw.checks)) {
    for (const c of raw.checks) {
      if (c && typeof c === "object" && typeof c.name === "string") {
        checksMap[c.name] = c.ok ?? false;
      }
    }
  }

  return {
    keyConfigured: checksMap["keyConfigured"] ?? raw.keyConfigured ?? false,
    dbOk: checksMap["dbOk"] ?? raw.dbOk ?? false,
    audioDirWritable: checksMap["audioDirWritable"] ?? raw.audioDirWritable ?? false,
    routesReady: checksMap["routesReady"] ?? raw.routesReady ?? false,
  };
}

/**
 * Adapt backend failedJobs array to frontend DiagnosticFailedJob[].
 * Backend uses: errorMessage (not error), inputCharCount (not charCount).
 * Frontend expects: error, charCount.
 */
function adaptFailedJobs(jobs: BackendFailedJob[] | undefined): Diagnostics["recentFailedJobs"] {
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => ({
    id: safeStr(j.id, "unknown"),
    voice: safeStr(j.voice, "unknown"),
    error: safeStr(j.errorMessage ?? j.error, "Unknown error"),
    status: j.status,
    charCount: safeNum(j.inputCharCount, 0),
    errorCode: j.errorCode ?? null,
    createdAt: safeStr(j.createdAt, new Date().toISOString()),
  }));
}

/**
 * Adapt backend recentAgentActions to frontend DiagnosticAgentAction[].
 * Backend uses: actionType, approvalStatus (not action, status).
 * Frontend expects: action, status.
 */
function adaptAgentActions(actions: BackendAgentAction[] | undefined): Diagnostics["recentAgentActions"] {
  if (!Array.isArray(actions)) return [];
  return actions.map((a) => ({
    id: a.id ?? 0,
    conversationId: a.conversationId ?? null,
    action: safeStr(a.action ?? a.actionType ?? a.toolName, "unknown"),
    status: safeStr(a.status ?? a.approvalStatus, "unknown"),
    actionType: a.actionType,
    toolName: a.toolName ?? null,
    approvalStatus: a.approvalStatus,
    createdAt: safeStr(a.createdAt, new Date().toISOString()),
  }));
}

/**
 * Adapt backend recentJobs to frontend DiagnosticJobSummary[].
 * Backend uses: inputCharCount (not charCount).
 * Frontend expects: charCount.
 */
function adaptRecentJobs(jobs: BackendRecentJob[] | undefined): Diagnostics["recentJobs"] {
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => ({
    id: safeStr(j.id, "unknown"),
    voice: safeStr(j.voice, "unknown"),
    status: safeStr(j.status, "unknown"),
    source: safeStr(j.source, "unknown"),
    charCount: safeNum(j.charCount ?? j.inputCharCount, 0),
    createdAt: safeStr(j.createdAt, new Date().toISOString()),
  }));
}

/**
 * Adapt audioDir field.
 * Backend returns an object { path, writable, fileCount, totalSizeBytes }.
 * Frontend type allows string | AudioDirInfo.
 * We pass through whatever the backend sends.
 */
function adaptAudioDir(val: unknown, pathAlias?: string): Diagnostics["audioDir"] {
  if (typeof pathAlias === "string" && pathAlias.length > 0) return pathAlias;
  if (typeof val === "string") return val;
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    return {
      path: safeStr(obj.path, "unknown"),
      writable: !!obj.writable,
      fileCount: safeNum(obj.fileCount, 0),
      totalSizeBytes: safeNum(obj.totalSizeBytes, 0),
    };
  }
  return "unknown";
}

export async function getDiagnostics(): Promise<Diagnostics> {
  const response = await fetch("/api/diagnostics");

  if (!response.ok) {
    const label = response.status === 404
      ? "诊断接口不可用 (404) -- 后端尚未实现此接口"
      : `诊断请求失败 (HTTP ${response.status})`;
    throw new Error(label);
  }

  const raw = await response.json() as BackendDiagnosticsResponse;

  // Sanitize: ensure no key/token/hash leaked into the response
  // (defense-in-depth; backend should already strip these)
  if (typeof raw === "object" && raw !== null) {
    const forbidden = ["apiKey", "api_key", "token", "hash", "secret", "password", "openRouterApiKey"];
    for (const key of forbidden) {
      if (key in raw) {
        throw new Error(`安全检查失败: 响应包含敏感字段 "${key}"，已拒绝接收`);
      }
    }
  }

  // Extract version/uptime from nested server object or flat aliases
  const server = raw.server;
  const version = safeStr(server?.version ?? raw.version, "unknown");
  const uptime = safeNum(server?.uptime ?? raw.uptime, 0);

  // Derive status from ready/ok flags
  const status = raw.ready === true || raw.ok === true ? "healthy" : (raw.status ?? "unknown");

  return {
    status,
    timestamp: safeStr(raw.timestamp, new Date().toISOString()),
    uptime,
    version,
    checks: extractChecks(raw),
    recentFailedJobs: adaptFailedJobs(raw.failedJobs ?? raw.recentFailedJobs),
    recentAgentActions: adaptAgentActions(raw.recentAgentActions),
    recentJobs: adaptRecentJobs(raw.recentJobs),
    audioDir: adaptAudioDir(raw.audioDir, raw.audioDirPath),
  };
}

// ─── Task Domain API ──────────────────────────────────────────────────────────

function taskQuery(status?: TaskStatus | "all") {
  if (!status || status === "all") return "";
  const params = new URLSearchParams({ status });
  return `?${params.toString()}`;
}

function withExpectedVersion(expectedVersion: number, payload?: Record<string, unknown>) {
  return JSON.stringify({ ...(payload ?? {}), expectedVersion });
}

const DEFAULT_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function unwrapEnvelope<T>(data: unknown, key: string): T {
  if (isRecord(data) && key in data) return data[key] as T;
  return data as T;
}

function mapTaskStatus(status: unknown): TaskStatus {
  switch (status) {
    case "draft":
    case "ready":
    case "running":
    case "blocked":
    case "completed":
    case "failed":
      return status;
    case "in_progress":
      return "running";
    case "archived":
      return "completed";
    default:
      return "draft";
  }
}

function mapTaskStatusToBackend(status: TaskStatus): string {
  if (status === "running") return "in_progress";
  return status;
}

function mapTask(raw: unknown): Task {
  const t = isRecord(raw) ? raw : {};
  return {
    id: asString(t.id, "unknown"),
    title: asString(t.title, "未命名任务"),
    description: asNullableString(t.description),
    status: mapTaskStatus(t.status),
    rawStatus: asNullableString(t.rawStatus),
    statusReason: asNullableString(t.statusReason),
    owner: asNullableString(t.owner),
    createdAt: asString(t.createdAt, new Date().toISOString()),
    updatedAt: asString(t.updatedAt, asString(t.createdAt, new Date().toISOString())),
    version: asNumber(t.version, 0),
    documentCount: asNumber(t.documentCount, undefined as unknown as number),
    lineCount: asNumber(t.lineCount, undefined as unknown as number),
    activeDocumentCount: asNumber(t.activeDocumentCount, 0),
    productionVersionCount: asNumber(t.productionVersionCount, 0),
    latestProductionVersion: typeof t.latestProductionVersion === "number" ? t.latestProductionVersion : null,
    latestLineCount: asNumber(t.latestLineCount, 0),
    generatedLineCount: asNumber(t.generatedLineCount, 0),
    failedLineCount: asNumber(t.failedLineCount, 0),
    lastRunStatus: (typeof t.lastRunStatus === "string" ? t.lastRunStatus : null) as Task["lastRunStatus"],
    documents: Array.isArray(t.documents) ? t.documents.map(mapRequirementDocument) : undefined,
  };
}

function mapRequirementDocument(raw: unknown): RequirementDocument {
  const d = isRecord(raw) ? raw : {};
  const fileName = asString(d.fileName ?? d.filename ?? d.title, "未命名文档");
  return {
    id: asString(d.id, "unknown"),
    taskId: asString(d.taskId),
    title: asString(d.title ?? d.fileName ?? d.filename, fileName),
    filename: fileName,
    content: typeof d.content === "string" ? d.content : "",
    contentType: (d.contentType === "markdown" || d.contentType === "json" || d.contentType === "text") ? d.contentType : "text",
    enabled: asBoolean(d.enabled, true),
    sortOrder: asNumber(d.sortOrder ?? d.order, 0),
    createdAt: asString(d.createdAt, new Date().toISOString()),
    updatedAt: asString(d.updatedAt, asString(d.createdAt, new Date().toISOString())),
    version: asNumber(d.version, 0),
    ...(typeof d.contentSizeBytes === "number" ? { contentSizeBytes: d.contentSizeBytes } : {}),
  };
}

function toBackendDocumentPayload(payload: Partial<RequirementDocument> & { filename?: string | null; title?: string | null; content?: string }) {
  const fileName = payload.filename ?? payload.title ?? undefined;
  return {
    ...(fileName ? { fileName } : {}),
    ...(payload.content !== undefined ? { content: payload.content } : {}),
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
  };
}

function normalizeResponseFormat(value: unknown): ResponseFormat {
  return value === "pcm" || value === "mp3" || value === "wav" ? value : "wav";
}

function normalizeLineGenerationStatus(value: unknown): VoiceLine["generationStatus"] {
  return value === "ready" || value === "pending" || value === "running" || value === "succeeded" || value === "failed" || value === "needs_revision" ? value : "draft";
}

function mapPromptSpeaker(raw: unknown, index: number): PromptSpeaker {
  const s = isRecord(raw) ? raw : {};
  return {
    id: asString(s.id, index === 0 ? "a" : `speaker-${index + 1}`),
    label: asString(s.label, index === 0 ? "Speaker A" : `Speaker ${index + 1}`),
    name: asString(s.name ?? s.label),
    voice: asString(s.voice, "Zephyr"),
    style: asString(s.style),
  };
}

function mapPromptOverride(raw: unknown): PromptOverride | null {
  if (!isRecord(raw)) return null;
  const override: PromptOverride = {};
  if (typeof raw.audioProfile === "string") override.audioProfile = raw.audioProfile;
  if (typeof raw.scene === "string") override.scene = raw.scene;
  if (typeof raw.directorNotes === "string") override.directorNotes = raw.directorNotes;
  if (typeof raw.style === "string") override.style = raw.style;
  if (typeof raw.pacing === "string") override.pacing = raw.pacing;
  if (typeof raw.accent === "string") override.accent = raw.accent;
  if (typeof raw.emotion === "string") override.emotion = raw.emotion;
  if (typeof raw.performanceNotes === "string") override.performanceNotes = raw.performanceNotes;
  if (typeof raw.sampleContext === "string") override.sampleContext = raw.sampleContext;
  if (Array.isArray(raw.speakers)) override.speakers = raw.speakers.map(mapPromptSpeaker);
  return Object.keys(override).length > 0 ? override : null;
}

function parsePromptOverrideJson(raw: unknown): PromptOverride | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return mapPromptOverride(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizePromptStructureStatus(value: unknown): ProductionList["promptStructureStatus"] | undefined {
  return value === "complete" || value === "missing" || value === "incomplete" ? value : undefined;
}

function mapVoiceLine(raw: unknown): VoiceLine {
  const l = isRecord(raw) ? raw : {};
  const order = asNumber(l.sortOrder ?? l.order, 0);
  const promptProfileId = asNullableString(l.promptProfileId ?? l.directorProfileId);
  const directorProfileId = asNullableString(l.directorProfileId ?? l.promptProfileId);
  return {
    id: asString(l.id, `line-${order}`),
    isLocalDraft: false,
    sortOrder: l.sortOrder !== undefined ? asNumber(l.sortOrder, order) : order + 1,
    moduleName: asNullableString(l.moduleName) ?? "",
    title: asNullableString(l.title) ?? "",
    transcript: asString(l.transcript ?? l.text),
    voice: asString(l.voice, "Zephyr"),
    model: asString(l.model, DEFAULT_TTS_MODEL),
    responseFormat: normalizeResponseFormat(l.responseFormat ?? l.format),
    style: asString(l.style, ""),
    notes: asString(l.notes, ""),
    directorProfileId,
    directorOverrideJson: asNullableString(l.directorOverrideJson),
    promptProfileId,
    speakerLabel: asNullableString(l.speakerLabel),
    promptOverride: mapPromptOverride(l.promptOverride) ?? parsePromptOverrideJson(l.promptOverrideJson ?? l.directorOverrideJson),
    promptOverrideJson: asNullableString(l.promptOverrideJson ?? l.directorOverrideJson),
    generationStatus: normalizeLineGenerationStatus(l.generationStatus),
    relatedJobId: asNullableString(l.relatedJobId),
    relatedAssetId: typeof l.relatedAssetId === "number" ? l.relatedAssetId : null,
    lastGenerationSignature: asNullableString(l.lastGenerationSignature),
    lastGenerationSnapshotJson: asNullableString(l.lastGenerationSnapshotJson),
    generationErrorCode: asNullableString(l.generationErrorCode),
    generationErrorMessage: asNullableString(l.generationErrorMessage),
    validationErrors: Array.isArray(l.validationErrors) ? l.validationErrors.filter((item): item is string => typeof item === "string") : undefined,
    version: asNumber(l.version, undefined as unknown as number),
    ...(typeof l.speaker === "string" ? { speaker: l.speaker } : {}),
    ...(typeof l.status === "string" ? { status: l.status } : {}),
  };
}

function toBackendVoiceLine(line: VoiceLine, index: number) {
  const raw = line as unknown as RawRecord;
  const promptProfileId = line.promptProfileId ?? line.directorProfileId ?? null;
  const directorProfileId = line.directorProfileId ?? line.promptProfileId ?? null;
  const promptOverrideJson = line.promptOverrideJson ?? line.directorOverrideJson ?? null;
  return {
    id: line.id,
    order: index,
    moduleName: line.moduleName ?? null,
    title: line.title ?? null,
    speaker: asString(raw.speaker, "narrator"),
    speakerLabel: line.speakerLabel ?? null,
    transcript: line.transcript,
    text: line.transcript,
    voice: line.voice,
    style: line.style ?? "",
    notes: line.notes ?? "",
    status: asString(raw.status, "pending"),
    model: line.model || DEFAULT_TTS_MODEL,
    responseFormat: line.responseFormat || "wav",
    directorProfileId,
    promptProfileId,
    directorOverrideJson: promptOverrideJson,
    promptOverride: line.promptOverride ?? null,
    promptOverrideJson,
    generationStatus: line.generationStatus ?? "draft",
    relatedJobId: line.relatedJobId ?? null,
    relatedAssetId: line.relatedAssetId ?? null,
    lastGenerationSignature: line.lastGenerationSignature ?? null,
    lastGenerationSnapshotJson: line.lastGenerationSnapshotJson ?? null,
    generationErrorCode: line.generationErrorCode ?? null,
    generationErrorMessage: line.generationErrorMessage ?? null,
  };
}

function mapProductionList(raw: unknown): ProductionList {
  const pl = isRecord(raw) ? raw : {};
  const directorProfiles = asArray(pl.directorProfiles).map(mapDirectorProfile);
  const promptProfiles = asArray(pl.promptProfiles).length > 0
    ? asArray(pl.promptProfiles).map(mapPromptProfile)
    : directorProfiles.map((profile) => profile as PromptProfile);
  const metadata = isRecord(pl.metadata) ? pl.metadata as Record<string, unknown> : {};
  const promptStructureStatus = normalizePromptStructureStatus(pl.promptStructureStatus ?? metadata.promptStructureStatus);
  return {
    taskId: asString(pl.taskId),
    version: asNumber(pl.version, 0),
    schemaVersion: asString(pl.schemaVersion ?? metadata.schemaVersion, undefined as unknown as string),
    updatedAt: asString(pl.updatedAt ?? pl.createdAt, undefined as unknown as string),
    lines: asArray(pl.lines).map(mapVoiceLine).sort((a, b) => a.sortOrder - b.sortOrder),
    speakers: asArray(pl.speakers).map((s): ProductionListSpeaker => {
      const rec = isRecord(s) ? s : {};
      return {
        id: asString(rec.id, `speaker-${Date.now()}`),
        label: asString(rec.label, "Speaker"),
        name: asString(rec.name, ""),
        voice: asString(rec.voice, "Zephyr"),
        style: asString(rec.style, ""),
      };
    }),
    directorProfileId: asNullableString(pl.directorProfileId),
    promptProfiles,
    directorProfiles: directorProfiles.length > 0 ? directorProfiles : promptProfiles,
    promptStructureStatus,
    metadata,
  };
}

function mapProductionListVersion(raw: unknown): ProductionListVersionEntry {
  const v = isRecord(raw) ? raw : {};
  return {
    version: asNumber(v.version, 0),
    versionId: asString(v.versionId ?? v.id, ""),
    lineCount: asNumber(v.lineCount, 0),
    directorProfileId: asNullableString(v.directorProfileId),
    createdAt: asString(v.createdAt, new Date().toISOString()),
  };
}

function mapProductionListDiff(raw: unknown): ProductionListDiff {
  const root = isRecord(raw) ? raw : {};
  const diff = isRecord(root.diff) ? root.diff : root;
  const summary = isRecord(diff.summary) ? diff.summary : {};
  return {
    fromVersion: asNumber(diff.fromVersion, 0),
    toVersion: asNumber(diff.toVersion, 0),
    summary: {
      addedCount: asNumber(summary.addedCount, 0),
      removedCount: asNumber(summary.removedCount, 0),
      changedCount: asNumber(summary.changedCount, 0),
      unchangedCount: asNumber(summary.unchangedCount, 0),
      fromLineCount: asNumber(summary.fromLineCount, 0),
      toLineCount: asNumber(summary.toLineCount, 0),
    },
    added: asArray(diff.added).filter((item): item is string => typeof item === "string"),
    removed: asArray(diff.removed).filter((item): item is string => typeof item === "string"),
    changed: asArray(diff.changed).map((item) => {
      const change = isRecord(item) ? item : {};
      return {
        lineId: asString(change.lineId),
        fields: asArray(change.fields).filter((field): field is string => typeof field === "string"),
      };
    }),
  };
}

function mapProductionListQualityReport(raw: unknown): ProductionListQualityReport {
  const root = isRecord(raw) ? raw : {};
  const report = isRecord(root.qualityReport) ? root.qualityReport : root;
  const metrics = isRecord(report.metrics) ? report.metrics : {};
  return {
    taskId: asString(report.taskId),
    version: asNumber(report.version, 0),
    totalLines: asNumber(report.totalLines, 0),
    generatedAt: asString(report.generatedAt, new Date().toISOString()),
    metrics: metrics as ProductionListQualityReport["metrics"],
    issues: asArray(report.issues).map((item) => {
      const issue = isRecord(item) ? item : {};
      return {
        severity: asString(issue.severity, "info"),
        code: asString(issue.code, "QUALITY_ISSUE"),
        message: asString(issue.message, "质量问题"),
        lineId: asNullableString(issue.lineId) ?? undefined,
      };
    }),
  };
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const quoted = disposition.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const plain = disposition.match(/filename=([^;]+)/i);
  return plain?.[1]?.trim() || fallback;
}

function toBackendProductionPayload(expectedVersion: number, list: Pick<ProductionList, "lines"> & Partial<Pick<ProductionList, "speakers" | "directorProfileId" | "metadata" | "promptProfiles" | "directorProfiles" | "schemaVersion" | "promptStructureStatus">>) {
  const stripProfileSource = (profile: DirectorProfile | PromptProfile) => {
    const { source, ...rest } = profile;
    void source;
    return rest;
  };
  return {
    expectedVersion,
    lines: list.lines.map(toBackendVoiceLine),
    speakers: Array.isArray(list.speakers) ? list.speakers : [],
    directorProfileId: typeof list.directorProfileId === "string" ? list.directorProfileId : null,
    ...(list.schemaVersion ? { schemaVersion: list.schemaVersion } : {}),
    ...(Array.isArray(list.promptProfiles) ? { promptProfiles: list.promptProfiles.map(stripProfileSource) } : {}),
    ...(Array.isArray(list.directorProfiles) ? { directorProfiles: list.directorProfiles.map(stripProfileSource) } : {}),
    ...(list.promptStructureStatus ? { promptStructureStatus: list.promptStructureStatus } : {}),
    metadata: isRecord(list.metadata) ? list.metadata : {},
  };
}

function mapValidationReport(raw: unknown): ProductionListValidationReport {
  const root = isRecord(raw) ? raw : {};
  const validation = isRecord(root.validation) ? root.validation : root;
  const issues = asArray(validation.issues).map((issue) => {
    const i = isRecord(issue) ? issue : {};
    return {
      lineId: asNullableString(i.lineId) ?? undefined,
      field: asString(i.field, undefined as unknown as string),
      severity: i.severity === "error" ? "error" : "warning",
      message: asString(i.message, asString(i.code, "校验问题")),
    };
  });
  return { ok: validation.valid === true || root.ok === true && !issues.some((i) => i.severity === "error"), issues };
}

function mapDirectorProfile(raw: unknown): DirectorProfile {
  const p = isRecord(raw) ? raw : {};
  const config = isRecord(p.config) ? p.config : {};
  const source = p.source === "production-list" ? "production-list" : "global";
  return {
    id: asString(p.id, "unknown"),
    taskId: asString(p.taskId),
    source,
    name: asString(p.name, "未命名导演配置"),
    audioProfile: asString(p.audioProfile ?? config.audioProfile),
    scene: asString(p.scene ?? config.scene),
    directorNotes: asString(p.directorNotes ?? config.directorNotes),
    style: asString(p.style ?? config.style),
    pacing: asString(p.pacing ?? config.pacing),
    accent: asString(p.accent ?? config.accent),
    emotion: asString(p.emotion ?? config.emotion),
    performanceNotes: asString(p.performanceNotes ?? config.performanceNotes),
    sampleContext: asString(p.sampleContext ?? config.sampleContext),
    speakers: asArray(p.speakers ?? config.speakers).map((speaker, index) => {
      const s = isRecord(speaker) ? speaker : {};
      return {
        id: asString(s.id, index === 0 ? "a" : `speaker-${index + 1}`),
        label: asString(s.label, index === 0 ? "Speaker A" : `Speaker ${index + 1}`),
        name: asString(s.name),
        voice: asString(s.voice, "Zephyr"),
        style: asString(s.style),
      };
    }),
    createdAt: asString(p.createdAt, new Date().toISOString()),
    updatedAt: asString(p.updatedAt, asString(p.createdAt, new Date().toISOString())),
    version: asNumber(p.version, 0),
  };
}

function mapPromptProfile(raw: unknown): PromptProfile {
  const p = isRecord(raw) ? raw : {};
  const base = mapDirectorProfile(raw);
  const description = asString(p.description, undefined as unknown as string);
  const reusePolicy = p.reusePolicy === "one-line" || p.reusePolicy === "many-lines" ? p.reusePolicy : undefined;
  const sourceDocumentIds = asArray(p.sourceDocumentIds).filter((item): item is string => typeof item === "string");
  return {
    ...base,
    speakers: asArray(p.speakers ?? (isRecord(p.config) ? p.config.speakers : undefined)).map(mapPromptSpeaker),
    ...(description !== undefined ? { description } : {}),
    ...(reusePolicy ? { reusePolicy } : {}),
    ...(sourceDocumentIds.length > 0 ? { sourceDocumentIds } : {}),
  };
}

function toBackendDirectorProfilePayload(payload: Partial<DirectorProfile>) {
  const raw = payload as Partial<DirectorProfile> & { description?: string };
  return {
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    config: {
      audioProfile: payload.audioProfile ?? "",
      scene: payload.scene ?? "",
      directorNotes: payload.directorNotes ?? "",
      style: payload.style ?? "",
      pacing: payload.pacing ?? "",
      accent: payload.accent ?? "",
      emotion: payload.emotion ?? "",
      performanceNotes: payload.performanceNotes ?? "",
      sampleContext: payload.sampleContext ?? "",
      speakers: payload.speakers ?? [],
      defaultVoice: payload.speakers?.[0]?.voice ?? "Zephyr",
      defaultModel: DEFAULT_TTS_MODEL,
      defaultFormat: "wav",
    },
  };
}

const AGENT_BUTTON_LABELS_ZH: Record<string, string> = {
  "complete-director-fields": "补全导演字段",
  "fix-validation-errors": "修复校验问题",
  shorten: "缩短",
  expand: "扩写",
  rewrite: "改写",
  "style-formal": "正式风格",
  "style-casual": "口语风格",
  "style-dramatic": "戏剧化风格",
};

function displayAgentButtonLabel(key: string, rawLabel: string): string {
  return AGENT_BUTTON_LABELS_ZH[key.trim().toLowerCase()] ?? rawLabel;
}

function productionListProfilesForTask(list: ProductionList, taskId: string): DirectorProfile[] {
  const taskVersion = list.version > 0 ? list.version : 0;
  return [...(list.promptProfiles ?? []), ...(list.directorProfiles ?? [])].map((profile) => ({
    ...profile,
    source: "production-list" as const,
    taskId: profile.taskId || taskId,
    version: profile.version > 0 ? profile.version : taskVersion,
  }));
}

function mergeDirectorProfilesById(primary: DirectorProfile[], secondary: DirectorProfile[]): DirectorProfile[] {
  const byId = new Map<string, DirectorProfile>();
  [...primary, ...secondary].forEach((profile) => {
    const id = profile.id.trim();
    if (!id || byId.has(id)) return;
    byId.set(id, profile);
  });
  return Array.from(byId.values());
}

function mapAgentButton(raw: unknown): AgentButton {
  const b = isRecord(raw) ? raw : {};
  const policy = isRecord(b.targetPolicy) ? b.targetPolicy : {};
  const scope = policy.scope === "task" || policy.scope === "global" || policy.scope === "line" || policy.scope === "list" ? policy.scope : "line";
  const runner = b.runner === "opencode" ? "opencode" as const : "fallback" as const;
  const key = asString(b.key ?? b.buttonKey, "unknown");
  const rawLabel = asString(b.label ?? b.name, asString(b.buttonKey, "Agent Button"));
  return {
    key,
    label: displayAgentButtonLabel(key, rawLabel),
    description: asString(b.description),
    scope,
    available: true,
    disabledReason: asNullableString(b.disabledReason),
    runner,
  };
}

function mapRunStatus(status: unknown): AgentRunStatus | "idle" {
  switch (status) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
    case "idle":
      return status;
    case "active":
      return "running";
    case "completed":
      return "succeeded";
    default:
      return "idle";
  }
}

function mapOpencodeSession(raw: unknown): OpencodeSession {
  const s = isRecord(raw) ? raw : {};
  const metadata = isRecord(s.metadata) ? s.metadata : {};
  const kind = s.kind === "automation" || s.kind === "chat" ? s.kind : (s.sessionType === "chat" ? "chat" : "automation");
  return {
    id: asString(s.id, "unknown"),
    taskId: asNullableString(s.taskId),
    kind,
    status: mapRunStatus(s.status),
    buttonKey: asNullableString(s.buttonKey ?? metadata.buttonKey),
    lineId: asNullableString(s.lineId ?? s.targetLineId ?? metadata.lineId),
    title: asNullableString(s.title ?? metadata.title),
    createdAt: asString(s.createdAt, new Date().toISOString()),
    updatedAt: asString(s.updatedAt ?? s.completedAt ?? s.createdAt, new Date().toISOString()),
    error: asNullableString(s.error ?? s.errorMessage),
  };
}

function mapNormalizeStage(value: unknown): NormalizeRunStage {
  switch (value) {
    case "queued":
    case "preprocessing":
    case "opencode_running":
    case "timeout_recovery":
    case "draft_detected":
    case "validating":
    case "committing":
    case "completed":
    case "failed":
      return value;
    default:
      return "queued";
  }
}

function mapNormalizeTimeoutBasis(value: unknown): NormalizeTimeoutBasis {
  return isRecord(value) ? value as NormalizeTimeoutBasis : {};
}

function mapCandidateQualitySummary(value: unknown): CandidateExtractionQualitySummary | undefined {
  if (!isRecord(value)) return undefined;
  const skippedByReason = isRecord(value.skippedByReason)
    ? Object.fromEntries(Object.entries(value.skippedByReason).map(([key, count]) => [key, asNumber(count, 0)]))
    : undefined;
  const examplesByReason = isRecord(value.examplesByReason) ? value.examplesByReason as Record<string, string[]> : undefined;
  return {
    inputLineCount: typeof value.inputLineCount === "number" ? value.inputLineCount : undefined,
    candidateLineCount: typeof value.candidateLineCount === "number" ? value.candidateLineCount : undefined,
    skippedByReason,
    examplesByReason,
  };
}

function mapNormalizeStartResponse(raw: unknown): NormalizeStartResponse {
  const record = isRecord(raw) ? raw : {};
  return {
    ok: true,
    status: "accepted",
    requestId: asNullableString(record.requestId) ?? undefined,
    runId: asString(record.runId),
    progressUrl: asString(record.progressUrl),
    stage: mapNormalizeStage(record.stage),
    timeoutMs: asNumber(record.timeoutMs, asNumber(isRecord(record.timeoutBasis) ? record.timeoutBasis.timeoutMs : undefined, 0)),
    timeoutBasis: mapNormalizeTimeoutBasis(record.timeoutBasis),
  };
}

function mapNormalizeRunProgress(raw: unknown, taskId: string, runId: string): NormalizeRunProgress {
  const record = isRecord(raw) ? raw : {};
  const draft = isRecord(record.draft) ? record.draft : {};
  const quality = isRecord(record.quality) ? record.quality : {};
  const runner = isRecord(record.runner) ? record.runner : {};
  const result = isRecord(record.result) ? record.result : null;
  const error = isRecord(record.error) ? record.error : null;

  return {
    ok: true,
    requestId: asNullableString(record.requestId) ?? undefined,
    runId: asString(record.runId, runId),
    taskId: asString(record.taskId, taskId),
    stage: mapNormalizeStage(record.stage),
    startedAt: asString(record.startedAt, new Date().toISOString()),
    updatedAt: asString(record.updatedAt, new Date().toISOString()),
    completedAt: asNullableString(record.completedAt) ?? undefined,
    elapsedMs: asNumber(record.elapsedMs, 0),
    timeoutMs: asNumber(record.timeoutMs, asNumber(isRecord(record.timeoutBasis) ? record.timeoutBasis.timeoutMs : undefined, 0)),
    timeoutBasis: mapNormalizeTimeoutBasis(record.timeoutBasis),
    candidateLineCount: asNumber(record.candidateLineCount, 0),
    candidateQualitySummary: mapCandidateQualitySummary(record.candidateQualitySummary),
    draft: {
      exists: asBoolean(draft.exists, false),
      parseable: asBoolean(draft.parseable, false),
      sizeBytes: asNumber(draft.sizeBytes, 0),
      updatedAt: asNullableString(draft.updatedAt) ?? undefined,
    },
    quality: {
      checked: asBoolean(quality.checked, false),
      passed: typeof quality.passed === "boolean" ? quality.passed : undefined,
      issueCount: typeof quality.issueCount === "number" ? quality.issueCount : undefined,
      blockingIssueCount: typeof quality.blockingIssueCount === "number" ? quality.blockingIssueCount : undefined,
      warningIssueCount: typeof quality.warningIssueCount === "number" ? quality.warningIssueCount : undefined,
      issuesPreview: asArray(quality.issuesPreview).map((item) => {
        const issue = isRecord(item) ? item : {};
        return {
          code: asString(issue.code, "QUALITY_ISSUE"),
          severity: asString(issue.severity, "warning"),
          message: asString(issue.message, "质量检查问题"),
          lineId: asNullableString(issue.lineId) ?? undefined,
          lineIndex: typeof issue.lineIndex === "number" ? issue.lineIndex : undefined,
          transcriptSample: asNullableString(issue.transcriptSample) ?? undefined,
          expected: asNullableString(issue.expected) ?? undefined,
          actual: asNullableString(issue.actual) ?? undefined,
        };
      }),
    },
    runner: {
      status: runner.status === "running" || runner.status === "completed" || runner.status === "timeout" || runner.status === "failed" || runner.status === "not_started" ? runner.status : "not_started",
    },
    result: result ? {
      versionId: asString(result.versionId),
      lineCount: asNumber(result.lineCount, 0),
    } : undefined,
    error: error ? {
      code: asString(error.code, "NORMALIZE_FAILED"),
      message: asString(error.message, "Normalize 执行失败"),
      httpStatus: typeof error.httpStatus === "number" ? error.httpStatus : undefined,
      recoverability: asString(error.recoverability, "retryable"),
    } : undefined,
    message: asString(record.message, "Normalize 任务状态已更新"),
  };
}

function mapCapabilityAvailability(raw: unknown, fallbackAvailable: boolean): AgentRunSummary["retry"] {
  if (isRecord(raw)) {
    const available = asBoolean(raw.available, fallbackAvailable);
    if (available) return { available: true, reason: asNullableString(raw.reason), code: asNullableString(raw.code) };
    return {
      available: false,
      code: asString(raw.code, "CAPABILITY_UNAVAILABLE"),
      reason: asString(raw.reason ?? raw.message, "该能力当前不可用"),
    };
  }
  return fallbackAvailable
    ? { available: true }
    : { available: false, code: "CAPABILITY_UNAVAILABLE", reason: "该能力当前不可用" };
}

function mapAgentRunSummary(raw: unknown, taskIdFallback = ""): AgentRunSummary {
  const r = isRecord(raw) ? raw : {};
  const error = isRecord(r.error) ? r.error : null;
  const kind = r.kind === "normalize" || r.kind === "button" ? r.kind : (asString(r.runId ?? r.id).startsWith("normalize") ? "normalize" : "button");
  const status = mapRunStatus(r.status);
  const normalizedStatus: AgentRunStatus = status === "idle" ? "queued" : status;
  const runId = asString(r.runId ?? r.id, "unknown");
  const targetLineIds = asArray(r.targetLineIds ?? r.lineIds ?? r.targetLines)
    .filter((item): item is string => typeof item === "string");
  const lineId = asNullableString(r.lineId ?? r.targetLineId);
  return {
    runId,
    taskId: asString(r.taskId, taskIdFallback),
    kind,
    buttonKey: asString(r.buttonKey, kind === "normalize" ? "normalize-requirements" : "unknown"),
    title: asString(r.title ?? r.label, kind === "normalize" ? "Normalize Requirements" : asString(r.buttonKey, "Agent Run")),
    status: normalizedStatus,
    runner: r.runner === "opencode" ? "opencode" : "fallback",
    targetLineIds: targetLineIds.length > 0 ? targetLineIds : lineId ? [lineId] : [],
    beforeVersion: typeof r.beforeVersion === "number" ? r.beforeVersion : undefined,
    afterVersion: typeof r.afterVersion === "number" ? r.afterVersion : undefined,
    createdAt: asString(r.createdAt ?? r.startedAt, new Date().toISOString()),
    completedAt: asNullableString(r.completedAt ?? r.updatedAt),
    error: error ? { code: asNullableString(error.code) ?? undefined, message: asString(error.message, "运行失败") } : asNullableString(r.error) ? { message: asString(r.error) } : null,
    retry: mapCapabilityAvailability(r.retry, normalizedStatus === "failed"),
    diff: mapCapabilityAvailability(r.diff, false),
    cancel: mapCapabilityAvailability(r.cancel, false),
  };
}

function mapAgentRunDetail(raw: unknown, taskId: string, runId: string): AgentRunDetail {
  const record = isRecord(raw) ? raw : {};
  const detail = isRecord(record.run) ? record.run : record;
  const summary = mapAgentRunSummary({ ...detail, runId: detail.runId ?? runId }, taskId);
  return {
    ...summary,
    promptSummary: asNullableString(detail.promptSummary ?? detail.prompt) ?? undefined,
    inputSnapshot: detail.inputSnapshot,
    outputSnapshot: detail.outputSnapshot,
    normalizeProgress: isRecord(detail.normalizeProgress) ? mapNormalizeRunProgress(detail.normalizeProgress, taskId, runId) : undefined,
    artifactRefs: asArray(detail.artifactRefs).map((item) => {
      const ref = isRecord(item) ? item : {};
      return {
        label: asString(ref.label, "artifact"),
        path: asNullableString(ref.path) ?? undefined,
        available: asBoolean(ref.available, Boolean(ref.path)),
      };
    }),
  };
}

function mapAgentRunDiff(raw: unknown, runId: string): AgentRunDiff {
  const record = isRecord(raw) ? raw : {};
  const diff = isRecord(record.diff) ? record.diff : record;
  const summary = isRecord(diff.summary) ? diff.summary : null;
  return {
    runId: asString(diff.runId, runId),
    available: asBoolean(diff.available, false),
    unavailableReason: asNullableString(diff.unavailableReason ?? diff.reason) ?? undefined,
    beforeVersion: typeof diff.beforeVersion === "number" ? diff.beforeVersion : undefined,
    afterVersion: typeof diff.afterVersion === "number" ? diff.afterVersion : undefined,
    summary: summary ? {
      addedCount: asNumber(summary.addedCount, 0),
      removedCount: asNumber(summary.removedCount, 0),
      changedCount: asNumber(summary.changedCount, 0),
    } : undefined,
    lineChanges: asArray(diff.lineChanges ?? diff.changed).map((item) => {
      const change = isRecord(item) ? item : {};
      return {
        lineId: asString(change.lineId, "unknown"),
        before: isRecord(change.before) ? change.before : undefined,
        after: isRecord(change.after) ? change.after : undefined,
        fields: asArray(change.fields).filter((field): field is string => typeof field === "string"),
      };
    }),
  };
}

function mapAgentRunCancelResult(err: ApiError): AgentRunCancelResult {
  const body = isRecord(err.body) ? err.body : {};
  const error = isRecord(body.error) ? body.error : {};
  const metadata = isRecord(error.metadata) ? error.metadata : {};
  return {
    available: asBoolean(metadata.available, false),
    reason: asString(metadata.reason ?? error.message, err.message),
    code: asString(error.code, "RUN_CANCEL_UNAVAILABLE"),
  };
}

function mapAgentChatMessage(raw: unknown): AgentChatMessage {
  const m = isRecord(raw) ? raw : {};
  const role = m.role === "assistant" || m.role === "system" || m.role === "user" ? m.role : "assistant";
  return {
    id: asString(m.id, `message-${Date.now().toString(36)}`),
    sessionId: asString(m.sessionId),
    role,
    content: asString(m.content),
    createdAt: asString(m.createdAt, new Date().toISOString()),
    status: m.status === "sending" || m.status === "failed" ? m.status : "sent",
    error: asNullableString(m.error),
  };
}

export const taskApi = {
  async listTasks(status?: TaskStatus | "all") {
    const data = await apiFetch<unknown>(`/api/tasks${taskQuery(status)}`);
    const tasks = Array.isArray(data) ? data : asArray(isRecord(data) ? data.tasks : undefined);
    return { tasks: tasks.map(mapTask) };
  },

  async createTask(payload: { title: string; description?: string }) {
    const data = await apiFetch<unknown>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return mapTask(unwrapEnvelope(data, "task"));
  },

  async updateTask(taskId: string, expectedVersion: number, payload: Partial<Pick<Task, "title" | "description" | "status">>) {
    const backendPayload = {
      ...payload,
      ...(payload.status ? { status: mapTaskStatusToBackend(payload.status) } : {}),
    };
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: withExpectedVersion(expectedVersion, backendPayload as Record<string, unknown>),
    });
    return mapTask(unwrapEnvelope(data, "task"));
  },

  async getTask(taskId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}`);
    return mapTask(unwrapEnvelope(data, "task"));
  },

  async uploadDocument(taskId: string, payload: { filename?: string; fileName?: string; content: string }) {
    const fileName = payload.fileName ?? payload.filename ?? "uploaded-document.txt";
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/documents/upload`, {
      method: "POST",
      body: JSON.stringify({ fileName, content: payload.content }),
    });
    return { ...mapRequirementDocument(unwrapEnvelope(data, "document")), content: payload.content };
  },

  async pasteDocument(taskId: string, payload: { title?: string; filename?: string; fileName?: string; content: string }) {
    const fileName = payload.fileName ?? payload.filename ?? payload.title ?? "pasted-requirements.md";
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/documents/paste`, {
      method: "POST",
      body: JSON.stringify({ fileName, content: payload.content }),
    });
    return { ...mapRequirementDocument(unwrapEnvelope(data, "document")), title: fileName, content: payload.content };
  },

  async listDocuments(taskId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/documents`);
    const documents = Array.isArray(data) ? data : asArray(isRecord(data) ? data.documents : undefined);
    return { documents: documents.map(mapRequirementDocument) };
  },

  async getDocument(taskId: string, documentId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(documentId)}`);
    return mapRequirementDocument(unwrapEnvelope(data, "document"));
  },

  async updateDocument(taskId: string, documentId: string, expectedVersion: number, payload: Partial<RequirementDocument>) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...toBackendDocumentPayload(payload), expectedVersion }),
    });
    return mapRequirementDocument(unwrapEnvelope(data, "document"));
  },

  deleteDocument(taskId: string, documentId: string) {
    return apiFetch<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
    });
  },

  async getProductionList(taskId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list`);
    return mapProductionList(unwrapEnvelope(data, "productionList"));
  },

  async saveProductionList(taskId: string, expectedVersion: number, list: Pick<ProductionList, "lines"> & Partial<Pick<ProductionList, "speakers" | "directorProfileId" | "metadata" | "promptProfiles" | "directorProfiles" | "schemaVersion" | "promptStructureStatus">>) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list`, {
      method: "PUT",
      body: JSON.stringify(toBackendProductionPayload(expectedVersion, list)),
    });
    return mapProductionList(unwrapEnvelope(data, "productionList"));
  },

  async patchProductionList(taskId: string, expectedVersion: number, payload: Partial<ProductionList>) {
    const backendPayload = payload.lines
      ? { ...payload, lines: payload.lines.map(toBackendVoiceLine) }
      : payload;
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list`, {
      method: "PATCH",
      body: withExpectedVersion(expectedVersion, backendPayload as Record<string, unknown>),
    });
    return mapProductionList(unwrapEnvelope(data, "productionList"));
  },

  async validateProductionList(taskId: string, list: Pick<ProductionList, "lines">) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list/validate`, {
      method: "POST",
      body: JSON.stringify({ lines: list.lines.map(toBackendVoiceLine), speakers: [] }),
    });
    return mapValidationReport(data);
  },

  async generateLines(taskId: string, payload: GenerateFromListRequest) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list/generate`, {
      method: "POST",
      body: JSON.stringify({
        ...(payload.expectedVersion !== undefined ? { expectedVersion: payload.expectedVersion } : {}),
        ...(payload.lineIds && payload.lineIds.length > 0 ? { lineIds: payload.lineIds } : {}),
        skipCompleted: payload.skipCompleted ?? true,
        forceRegenerate: payload.forceRegenerate ?? false,
        source: payload.source ?? "user",
        confirm: payload.confirm ?? false,
      }),
    });
    const record = isRecord(data) ? data : {};
    const generation = isRecord(record.generation) ? record.generation : {};
    return {
      taskId: asString(generation.taskId, taskId),
      version: typeof generation.version === "number" ? generation.version : 0,
      requestedCount: typeof generation.requestedCount === "number" ? generation.requestedCount : 0,
      succeededCount: typeof generation.succeededCount === "number" ? generation.succeededCount : 0,
      failedCount: typeof generation.failedCount === "number" ? generation.failedCount : 0,
      skippedCount: typeof generation.skippedCount === "number" ? generation.skippedCount : 0,
      results: asArray(generation.results).map((r: unknown) => {
        const item = isRecord(r) ? r : {};
        return {
          lineId: asString(item.lineId),
          status: (item.status === "succeeded" || item.status === "failed" || item.status === "skipped" ? item.status : "failed") as "succeeded" | "failed" | "skipped",
          jobId: asNullableString(item.jobId),
          assetId: typeof item.assetId === "number" ? item.assetId : null,
          audioUrl: asNullableString(item.audioUrl),
          downloadUrl: asNullableString(item.downloadUrl),
          errorCode: asNullableString(item.errorCode),
          errorMessage: asNullableString(item.errorMessage),
        };
      }),
    } as GenerateFromListResponse;
  },

  async listProductionListVersions(taskId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list/versions`);
    const versions = Array.isArray(data) ? data : asArray(isRecord(data) ? data.versions : undefined);
    return { versions: versions.map(mapProductionListVersion).filter((version) => version.version > 0) };
  },

  async getProductionListDiff(taskId: string, fromVersion: number, toVersion: number) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list/versions/${encodeURIComponent(String(fromVersion))}/diff/${encodeURIComponent(String(toVersion))}`);
    return mapProductionListDiff(data);
  },

  async rollbackProductionList(taskId: string, expectedVersion: number, targetVersion: number, summary?: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list/rollback`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion, targetVersion, summary: summary ?? "frontend rollback" }),
    });
    const record = isRecord(data) ? data : {};
    return {
      productionList: mapProductionList(record.productionList),
      rollback: {
        fromVersion: asNumber(isRecord(record.rollback) ? record.rollback.fromVersion : undefined, expectedVersion),
        targetVersion: asNumber(isRecord(record.rollback) ? record.rollback.targetVersion : undefined, targetVersion),
        newVersion: asNumber(isRecord(record.rollback) ? record.rollback.newVersion : undefined, expectedVersion + 1),
      },
    } as ProductionListRollbackResult;
  },

  async exportProductionList(taskId: string, format: ProductionListExportFormat): Promise<ProductionListExportResult> {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/production-list/export?format=${encodeURIComponent(format)}`);
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new ApiError(response.status, errorMessageFromBody(response.status, body), body);
    }
    const mimeType = response.headers.get("Content-Type") ?? (format === "csv" ? "text/csv" : format === "md" ? "text/markdown" : "application/json");
    const rawText = await response.text();
    let content = rawText;
    if (format === "json") {
      try {
        content = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch { /* keep raw JSON text */ }
    }
    return {
      format,
      fileName: filenameFromDisposition(response.headers.get("Content-Disposition"), `production-list.${format === "md" ? "md" : format}`),
      content,
      mimeType,
    };
  },

  async importProductionList(taskId: string, expectedVersion: number, format: "json" | "csv", data: unknown, summary?: string) {
    const response = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list/import`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion, format, data, summary: summary ?? "frontend import" }),
    });
    const record = isRecord(response) ? response : {};
    const importInfo = isRecord(record.import) ? record.import : {};
    return {
      productionList: mapProductionList(record.productionList),
      import: {
        importedLines: asNumber(importInfo.importedLines, 0),
        skippedLines: asNumber(importInfo.skippedLines, 0),
        errors: asArray(importInfo.errors).map((item) => {
          const err = isRecord(item) ? item : {};
          return { index: asNumber(err.index, 0), message: asString(err.message, "导入错误") };
        }),
        directorWarnings: asArray(importInfo.directorWarnings).filter((item): item is string => typeof item === "string"),
      },
    } as ProductionListImportResult;
  },

  async getProductionListQualityReport(taskId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list/quality-report`);
    return mapProductionListQualityReport(data);
  },

  async listDirectorProfiles(taskId?: string) {
    const globalProfilesRequest = apiFetch<unknown>("/api/director-profiles");

    if (!taskId) {
      const data = await globalProfilesRequest;
      const profiles = Array.isArray(data) ? data : asArray(isRecord(data) ? data.profiles : undefined);
      return { profiles: profiles.map(mapDirectorProfile) };
    }

    const [globalResult, productionListResult] = await Promise.allSettled([
      globalProfilesRequest,
      apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/production-list`),
    ]);

    const globalProfiles = globalResult.status === "fulfilled"
      ? (Array.isArray(globalResult.value) ? globalResult.value : asArray(isRecord(globalResult.value) ? globalResult.value.profiles : undefined)).map(mapDirectorProfile)
      : [];
    const taskProfiles = productionListResult.status === "fulfilled"
      ? productionListProfilesForTask(mapProductionList(unwrapEnvelope(productionListResult.value, "productionList")), taskId)
      : [];

    if (globalResult.status === "rejected" && productionListResult.status === "rejected") {
      throw globalResult.reason instanceof Error ? globalResult.reason : productionListResult.reason;
    }

    return { profiles: mergeDirectorProfilesById(taskProfiles, globalProfiles) };
  },

  async createDirectorProfile(_taskId: string, payload: Partial<DirectorProfile>) {
    const data = await apiFetch<unknown>("/api/director-profiles", {
      method: "POST",
      body: JSON.stringify(toBackendDirectorProfilePayload(payload)),
    });
    return mapDirectorProfile(unwrapEnvelope(data, "profile"));
  },

  async updateDirectorProfile(_taskId: string, profileId: string, _expectedVersion: number, payload: Partial<DirectorProfile>) {
    const data = await apiFetch<unknown>(`/api/director-profiles/${encodeURIComponent(profileId)}`, {
      method: "PATCH",
      body: JSON.stringify(toBackendDirectorProfilePayload(payload)),
    });
    return mapDirectorProfile(unwrapEnvelope(data, "profile"));
  },

  async listAgentButtons() {
    const data = await apiFetch<unknown>("/api/agent/buttons");
    const record = isRecord(data) ? data : {};
    const buttons = Array.isArray(record.buttons) ? record.buttons : asArray(isRecord(data) ? data.buttons : undefined);
    return {
      buttons: buttons.map(mapAgentButton),
      opencodeAvailable: asBoolean(record.opencodeAvailable, false),
      runnerMode: (record.runnerMode === "opencode" ? "opencode" : "fallback") as "opencode" | "fallback",
      disabledReason: asNullableString(record.disabledReason),
    };
  },

  async normalizeRequirements(taskId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/normalize-requirements`, {
      method: "POST",
    });
    const record = isRecord(data) ? data : {};
    const bundleMeta = isRecord(record.bundleMeta) ? record.bundleMeta : null;
    const runnerStatus = isRecord(record.runnerStatus) ? record.runnerStatus : null;
    const validationReport = isRecord(record.validationReport) ? record.validationReport : null;
    return {
      productionList: mapProductionList(record.productionList),
      runner: asString(record.runner, "fallback"),
      warnings: asArray(record.warnings).map((warning) => isRecord(warning) ? { code: asString(warning.code), message: asString(warning.message) } : { code: "WARNING", message: String(warning) }),
      runId: asNullableString(record.runId),
      attemptedRunner: asString(record.attemptedRunner, "none"),
      fallbackUsed: asBoolean(record.fallbackUsed, false),
      fallbackReason: asNullableString(record.fallbackReason),
      bundleMethod: bundleMeta ? asString(bundleMeta.method, "legacy") : null,
      runnerStatus: runnerStatus ? {
        status: asString(runnerStatus.status, "idle"),
        reasonCode: asString(runnerStatus.reasonCode),
        elapsedMs: runnerStatus.elapsedMs as number | undefined,
        fallbackUsed: asBoolean(runnerStatus.fallbackUsed, false),
      } : null,
      validationReport: validationReport ? {
        valid: asBoolean(validationReport.valid, true),
        errorCount: (validationReport.errorCount as number) ?? 0,
        warningCount: (validationReport.warningCount as number) ?? 0,
        issueCount: (validationReport.issueCount as number) ?? 0,
      } : null,
    };
  },

  async startNormalizeRequirements(taskId: string): Promise<NormalizeStartResponse> {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/normalize-requirements`, {
      method: "POST",
      body: JSON.stringify({ async: true, qualityPriority: true }),
    });
    return mapNormalizeStartResponse(data);
  },

  async getNormalizeProgress(taskId: string, runId: string): Promise<NormalizeRunProgress> {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/normalize-runs/${encodeURIComponent(runId)}/progress`);
    return mapNormalizeRunProgress(data, taskId, runId);
  },

  async executeAgentButton(taskId: string, buttonKey: string, payload?: { lineId?: string; targetLineId?: string; target?: { scope: "line"; lineId: string } | { scope: "selection"; lineIds: string[] } | { scope: "list" } | { scope: "task" }; expectedVersion?: number; automationSessionId?: string; parameters?: Record<string, unknown> }) {
    const targetLineId = payload?.targetLineId ?? payload?.lineId ?? (payload?.target?.scope === "line" ? payload.target.lineId : undefined);
    const productionList = payload?.expectedVersion !== undefined ? null : await this.getProductionList(taskId);
    const expectedVersion = payload?.expectedVersion ?? productionList?.version ?? 0;
    if (expectedVersion <= 0) {
      throw new Error("当前任务还没有可执行的生产列表版本，请先保存或标准化需求");
    }
    if (targetLineId && productionList && !productionList.lines.some((line) => line.id === targetLineId)) {
      throw new Error("目标生产行不在当前生产列表版本中，请刷新后重试");
    }
    const target = payload?.target ?? (targetLineId ? { scope: "line" as const, lineId: targetLineId } : { scope: "list" as const });
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/buttons/${encodeURIComponent(buttonKey)}/execute`, {
      method: "POST",
      body: JSON.stringify({ ...(targetLineId ? { targetLineId } : {}), target, expectedVersion, automationSessionId: payload?.automationSessionId, parameters: payload?.parameters ?? {} }),
    });
    const record = isRecord(data) ? data : {};
    return mapAgentRunSummary({
      ...record,
      runId: record.runId,
      taskId,
      kind: "button",
      status: record.status ?? "succeeded",
      buttonKey,
      targetLineIds: target.scope === "selection" ? target.lineIds : targetLineId ? [targetLineId] : [],
      title: `${buttonKey} · ${asString(record.runner, "fallback")}`,
      runner: record.runner,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },

  async listOpencodeSessions(taskId?: string) {
    const query = new URLSearchParams({ sessionType: "automation" });
    if (taskId) query.set("taskId", taskId);
    const data = await apiFetch<unknown>(`/api/opencode/sessions?${query.toString()}`);
    const sessions = (Array.isArray(data) ? data : asArray(isRecord(data) ? data.sessions : undefined)).map(mapOpencodeSession);
    return { sessions: taskId ? sessions.filter((session) => session.taskId === taskId) : sessions };
  },

  async createOpencodeSession(payload: Partial<OpencodeSession>) {
    const data = await apiFetch<unknown>("/api/opencode/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionType: payload.kind ?? "automation", taskId: payload.taskId, metadata: { title: payload.title, buttonKey: payload.buttonKey, lineId: payload.lineId } }),
    });
    return mapOpencodeSession(unwrapEnvelope(data, "session"));
  },

  async listAgentRuns(taskId: string, limit = 20) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/runs?limit=${encodeURIComponent(String(limit))}`);
    const runs = Array.isArray(data) ? data : asArray(isRecord(data) ? data.runs : undefined);
    return { runs: runs.map((run) => mapAgentRunSummary(run, taskId)) };
  },

  async getAgentRunDetail(taskId: string, runId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/runs/${encodeURIComponent(runId)}`);
    return mapAgentRunDetail(data, taskId, runId);
  },

  async getAgentRunDiff(taskId: string, runId: string) {
    const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/runs/${encodeURIComponent(runId)}/diff`);
    return mapAgentRunDiff(data, runId);
  },

  async cancelAgentRun(taskId: string, runId: string) {
    try {
      const data = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/agent/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
      const record = isRecord(data) ? data : {};
      return { available: asBoolean(record.available ?? record.ok, true), reason: asString(record.reason, "运行已取消") } as AgentRunCancelResult;
    } catch (err) {
      if (err instanceof ApiError) return mapAgentRunCancelResult(err);
      throw err;
    }
  },

  async createChatSession(payload: { taskId?: string; pagePath?: string; title?: string }) {
    const data = await apiFetch<unknown>("/api/agent/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionType: "chat", taskId: payload.taskId, metadata: { pagePath: payload.pagePath, title: payload.title } }),
    });
    return mapOpencodeSession({ ...(unwrapEnvelope(data, "session") as RawRecord), kind: "chat", title: payload.title });
  },

  async listChatMessages(sessionId: string) {
    const data = await apiFetch<unknown>(`/api/agent/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
    const messages = Array.isArray(data) ? data : asArray(isRecord(data) ? data.messages : undefined);
    return { messages: messages.map(mapAgentChatMessage) };
  },

  async sendChatMessage(sessionId: string, content: string, metadata?: { pagePath?: string; title?: string }) {
    const data = await apiFetch<unknown>(`/api/agent/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content, metadata: metadata ?? {} }),
    });
    if (isRecord(data) && Array.isArray(data.messages)) {
      return { messages: data.messages.map(mapAgentChatMessage) };
    }
    const record = isRecord(data) ? data : {};
    const messages = [record.message, record.assistantMessage]
      .filter((message) => message !== undefined)
      .map(mapAgentChatMessage);
    if (messages.length > 0) return { messages };
    return {
      messages: [{
        id: `assistant-unavailable-${Date.now().toString(36)}`,
        sessionId,
        role: "assistant" as const,
        content: "Agent Chat 暂未返回可展示消息，请稍后重试或检查 OpenCode 可用性。",
        createdAt: new Date().toISOString(),
        status: "sent" as const,
      }],
    };
  },
};
