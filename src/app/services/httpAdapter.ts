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
  GenerateRequest,
  GenerateResult,
  GeneratePhase,
  HistoryFilter,
  HistoryRecord,
  HistoryStatus,
  HistorySource,
  VoiceProfile,
  VoiceStatus,
  TtsServiceAdapter,
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

      if (req.audioProfile || req.scene || req.directorNotes) {
        body.directorSnapshot = {
          audioProfile: req.audioProfile,
          scene: req.scene,
          directorNotes: req.directorNotes,
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
      }>("/api/tts/generate", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (result.status === "succeeded") {
        return {
          jobId: result.jobId,
          phase: "success",
          voice: req.voice,
          format: req.format,
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

  async probeVoice(voiceName: string): Promise<{ status: VoiceStatus; latency: string }> {
    try {
      const result = await apiFetch<{
        voice: string;
        verifiedStatus: string;
        latencyMs: number;
        error: string | null;
      }>("/api/voices/probe", {
        method: "POST",
        body: JSON.stringify({
          voice: voiceName,
          model: "google/gemini-3.1-flash-tts-preview",
          format: "mp3",
        }),
      });

      if (result.error === "MISSING_API_KEY") {
        return { status: "error" as VoiceStatus, latency: "N/A" };
      }

      return {
        status: result.verifiedStatus === "verified" ? "success" : "error",
        latency: `${(result.latencyMs / 1000).toFixed(1)}s`,
      };
    } catch {
      return { status: "error", latency: "N/A" };
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

  async listVoicesAsync(): Promise<VoiceProfile[]> {
    try {
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
        }>;
        stats: Record<string, number>;
      }>("/api/voices");

      return result.voices.map((v) => ({
        name: v.name,
        isDefault: v.source === "default",
        role: v.role || "",
        provider: v.provider === "openrouter" ? "OpenRouter" : v.provider,
        status: mapVoiceStatus(v.verifiedStatus),
        lastVerified: v.lastVerified ? new Date(v.lastVerified).toISOString().split("T")[0] : "",
        verifyDuration: v.verifyDuration ? `${(v.verifyDuration / 1000).toFixed(1)}s` : undefined,
      }));
    } catch {
      return [];
    }
  },

  listHistory(filter: HistoryFilter): { records: HistoryRecord[]; totalPages: number } {
    // This is synchronous in the interface, but we'll handle it via async in AppContext.
    // Return empty - real data loaded via listHistoryAsync.
    return { records: [], totalPages: 1 };
  },

  async listHistoryAsync(filter: HistoryFilter): Promise<{ records: HistoryRecord[]; totalPages: number; totalRecords?: number }> {
    try {
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
          format: r.format as AudioFormat,
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
        })),
        totalPages: result.totalPages,
        totalRecords: result.totalRecords,
      };
    } catch {
      return { records: [], totalPages: 1 };
    }
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
