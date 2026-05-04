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
} from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API Error ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

function mapVoiceStatus(status: string): VoiceStatus {
  switch (status) {
    case "verified": return "success";
    case "failed": return "error";
    case "unknown": return "pending";
    default: return "pending";
  }
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

      const hasDirectorFields = req.audioProfile?.trim() || req.scene?.trim() || req.directorNotes?.trim() || req.sampleContext?.trim() || req.transcript?.trim() || (req.speakers && req.speakers.length > 0);
      if (hasDirectorFields) {
        body.directorSnapshot = {
          audioProfile: req.audioProfile?.trim() || undefined,
          scene: req.scene?.trim() || undefined,
          directorNotes: req.directorNotes?.trim() || undefined,
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
        error: string | null;
      }>("/api/settings/test", { method: "POST" });

      if (result.error === "MISSING_API_KEY") {
        return "failed";
      }
      return result.ok ? "connected" : "failed";
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
    if (filter.source) params.set("source", filter.source === "用户" ? "user" : "agent");

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
        source: (r.source === "用户" ? "用户" : "Agent") as HistorySource,
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
