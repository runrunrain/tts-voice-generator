/**
 * Global state context for TTS Voice Generator.
 *
 * Provides shared generation state between GeneratePage / DirectorPage and RightPanel,
 * as well as access to the service adapter and application settings.
 *
 * Uses httpAdapter for real backend communication via /api/* endpoints.
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import type {
  AudioFormat,
  AppSettings,
  ConnectionStatus,
  CostEstimate,
  GeneratePhase,
  GenerateRequest,
  GenerateResult,
  HistoryFilter,
  HistoryRecord,
  VoiceProfile,
  TtsServiceAdapter,
} from "../types";
import { httpAdapter } from "../services/httpAdapter";

// ─── Context Value ───────────────────────────────────────────────────────────

interface AppState {
  // Generation
  generateResult: GenerateResult | null;
  generatePhase: GeneratePhase;
  generate: (req: GenerateRequest) => Promise<void>;
  resetGeneration: () => void;
  /** The last request that was submitted (for retry on error) */
  lastRequest: GenerateRequest | null;

  // Cost estimation
  costEstimate: CostEstimate | null;
  estimateCost: (charCount: number, format: AudioFormat) => void;

  // Adapter passthrough
  adapter: TtsServiceAdapter;

  // Settings
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  saveSettings: (payload?: Partial<AppSettings>) => Promise<void>;
  testConnection: () => Promise<ConnectionStatus>;

  // Voices
  voices: VoiceProfile[];

  // History
  historyRecords: HistoryRecord[];
  historyTotalPages: number;
  historyFilter: HistoryFilter;
  setHistoryFilter: (filter: Partial<HistoryFilter>) => void;
  refreshHistory: () => void;

  // Demo metadata (kept for backward compat, always 0 with real backend)
  demoTodayCount: number;
}

const AppContext = createContext<AppState | null>(null);

// ─── Provider ────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  // --- Generation state ---
  const [generateResult, setGenerateResult] = useState<GenerateResult | null>(null);
  const [generatePhase, setGeneratePhase] = useState<GeneratePhase>("idle");
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [lastRequest, setLastRequest] = useState<GenerateRequest | null>(null);
  const abortRef = useRef(false);

  const generate = useCallback(async (req: GenerateRequest) => {
    // Defensive: reject empty text at context level
    if (!req.text.trim()) {
      setGeneratePhase("error");
      setGenerateResult({
        jobId: `err-empty-${Date.now().toString(36)}`,
        phase: "error",
        voice: req.voice,
        format: req.format,
        charCount: 0,
        duration: "0.0s",
        estimatedCost: "$0.00",
        error: {
          code: "EMPTY_TEXT",
          message: "文本内容不能为空，请输入文本后重试。",
        },
        timestamp: new Date().toISOString(),
        isDemo: false,
      });
      return;
    }

    abortRef.current = false;
    setLastRequest(req);
    setGeneratePhase("loading");
    setGenerateResult(null);

    try {
      const result = await httpAdapter.generateSpeech(req);
      if (abortRef.current) return;
      setGenerateResult(result);
      setGeneratePhase(result.phase);
    } catch (err) {
      if (abortRef.current) return;
      setGeneratePhase("error");
      setGenerateResult({
        jobId: `err-${Date.now().toString(36)}`,
        phase: "error",
        voice: req.voice,
        format: req.format,
        charCount: req.text.length,
        duration: "0.0s",
        estimatedCost: "$0.00",
        error: {
          code: "UNEXPECTED",
          message: err instanceof Error ? err.message : "生成过程发生异常",
        },
        timestamp: new Date().toISOString(),
        isDemo: false,
      });
    }
  }, []);

  const resetGeneration = useCallback(() => {
    abortRef.current = true;
    setGeneratePhase("idle");
    setGenerateResult(null);
  }, []);

  const estimateCost = useCallback((charCount: number, format: AudioFormat) => {
    const est = httpAdapter.estimateCost(charCount, format);
    setCostEstimate(est);
  }, []);

  // --- Settings ---
  const [settings, setSettings] = useState<AppSettings>({
    openRouterApiKey: "",
    defaultModel: "google/gemini-3.1-flash-tts-preview",
    defaultVoice: "Zephyr",
    defaultFormat: "mp3",
    audioDir: "./data/audio",
    maxChars: 5000,
    maxConcurrent: 2,
    connectionStatus: "untested",
  });

  // Load settings from backend on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        // Handle both new format (hasOpenRouterApiKey/keyMask) and legacy format (openRouterApiKey)
        const hasKey = data.hasOpenRouterApiKey || data.openRouterApiKey === "***configured***";
        setSettings((prev) => ({
          ...prev,
          openRouterApiKey: hasKey ? (data.keyMask || data.openRouterApiKey || "***configured***") : "",
          defaultModel: data.defaultModel || prev.defaultModel,
          defaultVoice: data.defaultVoice || prev.defaultVoice,
          defaultFormat: data.defaultFormat || prev.defaultFormat,
          audioDir: data.audioOutputDir || prev.audioDir,
          maxChars: data.maxCharsPerRequest || prev.maxChars,
          maxConcurrent: data.maxConcurrentJobs || prev.maxConcurrent,
        }));
      })
      .catch(() => {
        // Backend not available, keep defaults
      });
  }, []);

  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  /**
   * Save settings to the backend.
   *
   * Accepts an optional explicit payload to bypass stale-closure issues.
   * If no payload is given, falls back to current React state (may be stale
   * if called right after updateSettings in the same render cycle).
   *
   * After a successful PUT, re-fetches settings from the backend so the
   * UI reflects the authoritative hasOpenRouterApiKey / keyMask values.
   */
  const saveSettings = useCallback(async (payload?: Partial<AppSettings>) => {
    // Merge: explicit payload wins, then current state
    const source = payload
      ? { ...settings, ...payload }
      : settings;

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Send the actual key string only when provided by the user.
          // Masked sentinel values ("***configured***") must be translated to
          // undefined so the backend doesn't overwrite the stored key.
          openRouterApiKey: source.openRouterApiKey &&
            source.openRouterApiKey !== "***configured***" &&
            source.openRouterApiKey !== ""
            ? source.openRouterApiKey
            : undefined,
          defaultModel: source.defaultModel,
          defaultVoice: source.defaultVoice,
          defaultFormat: source.defaultFormat,
          audioOutputDir: source.audioDir,
          maxCharsPerRequest: source.maxChars,
          maxConcurrentJobs: source.maxConcurrent,
        }),
      });

      if (!res.ok) {
        console.error("Failed to save settings:", res.status, await res.text());
        return;
      }

      // Re-fetch authoritative settings from backend after save
      const freshRes = await fetch("/api/settings");
      if (freshRes.ok) {
        const data = await freshRes.json();
        const hasKey = data.hasOpenRouterApiKey || data.openRouterApiKey === "***configured***";
        setSettings((prev) => ({
          ...prev,
          openRouterApiKey: hasKey ? (data.keyMask || data.openRouterApiKey || "***configured***") : "",
          defaultModel: data.defaultModel || prev.defaultModel,
          defaultVoice: data.defaultVoice || prev.defaultVoice,
          defaultFormat: data.defaultFormat || prev.defaultFormat,
          audioDir: data.audioOutputDir || prev.audioDir,
          maxChars: data.maxCharsPerRequest || prev.maxChars,
          maxConcurrent: data.maxConcurrentJobs || prev.maxConcurrent,
        }));
      }
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }, [settings]);

  const testConnection = useCallback(async (): Promise<ConnectionStatus> => {
    setSettings((prev) => ({ ...prev, connectionStatus: "testing" }));
    const status = await httpAdapter.testConnection();
    setSettings((prev) => ({ ...prev, connectionStatus: status }));
    return status;
  }, []);

  // --- Voices ---
  const [voices, setVoices] = useState<VoiceProfile[]>([]);

  // Load voices from backend on mount
  useEffect(() => {
    if (httpAdapter.listVoicesAsync) {
      httpAdapter.listVoicesAsync().then(setVoices).catch(() => {
        // Backend not available, keep empty list
      });
    }
  }, []);

  // --- History ---
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [historyFilter, setHistoryFilterState] = useState<HistoryFilter>({
    page: 1,
    pageSize: 20,
  });

  const setHistoryFilter = useCallback((partial: Partial<HistoryFilter>) => {
    setHistoryFilterState((prev) => {
      const next = { ...prev, ...partial };
      // Reset to page 1 if filters change (except page itself)
      if (partial.page === undefined) next.page = 1;
      return next;
    });
  }, []);

  const refreshHistory = useCallback(() => {
    if (httpAdapter.listHistoryAsync) {
      httpAdapter.listHistoryAsync(historyFilter).then((result) => {
        setHistoryRecords(result.records);
        setHistoryTotalPages(result.totalPages);
      }).catch(() => {
        // Backend not available
      });
    }
  }, [historyFilter]);

  // Load history on mount and whenever filter changes
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // Demo today generation count (0 with real backend)
  const demoTodayCount = 0;

  const value: AppState = {
    generateResult,
    generatePhase,
    generate,
    resetGeneration,
    lastRequest,
    costEstimate,
    estimateCost,
    adapter: httpAdapter,
    settings,
    updateSettings,
    saveSettings,
    testConnection,
    voices,
    historyRecords,
    historyTotalPages,
    historyFilter,
    setHistoryFilter,
    refreshHistory,
    demoTodayCount,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useAppState must be used within an AppProvider");
  }
  return ctx;
}
