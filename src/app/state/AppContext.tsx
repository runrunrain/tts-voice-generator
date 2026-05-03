/**
 * Global state context for TTS Voice Generator.
 *
 * Provides shared generation state between GeneratePage / DirectorPage and RightPanel,
 * as well as access to the service adapter and application settings.
 *
 * DEMO NOTE: All state mutations go through the demo adapter. When a real backend
 * is ready, swap the adapter implementation in the provider.
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
import { demoAdapter } from "../services/demoAdapter";

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
  saveSettings: () => Promise<void>;
  testConnection: () => Promise<ConnectionStatus>;

  // Voices
  voices: VoiceProfile[];

  // History
  historyRecords: HistoryRecord[];
  historyTotalPages: number;
  historyFilter: HistoryFilter;
  setHistoryFilter: (filter: Partial<HistoryFilter>) => void;
  refreshHistory: () => void;

  // Demo metadata
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
        jobId: `demo-err-empty-${Date.now().toString(36)}`,
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
        isDemo: true,
      });
      return;
    }

    abortRef.current = false;
    setLastRequest(req);
    setGeneratePhase("loading");
    setGenerateResult(null);

    try {
      const result = await demoAdapter.generateSpeech(req);
      if (abortRef.current) return;
      setGenerateResult(result);
      setGeneratePhase(result.phase);
    } catch (err) {
      if (abortRef.current) return;
      setGeneratePhase("error");
      setGenerateResult({
        jobId: `demo-err-${Date.now().toString(36)}`,
        phase: "error",
        voice: req.voice,
        format: req.format,
        charCount: req.text.length,
        duration: "0.0s",
        estimatedCost: "$0.00",
        error: {
          code: "UNEXPECTED",
          message: err instanceof Error ? err.message : "演示过程发生异常",
        },
        timestamp: new Date().toISOString(),
        isDemo: true,
      });
    }
  }, []);

  const resetGeneration = useCallback(() => {
    abortRef.current = true;
    setGeneratePhase("idle");
    setGenerateResult(null);
  }, []);

  const estimateCost = useCallback((charCount: number, format: AudioFormat) => {
    const est = demoAdapter.estimateCost(charCount, format);
    setCostEstimate(est);
  }, []);

  // --- Settings ---
  const [settings, setSettings] = useState<AppSettings>({
    openRouterApiKey: "",
    defaultModel: "gemini-3.1-flash",
    defaultVoice: "alloy",
    defaultFormat: "mp3",
    audioDir: "./data/audio",
    maxChars: 5000,
    maxConcurrent: 2,
    connectionStatus: "untested",
  });

  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const saveSettings = useCallback(async () => {
    // Demo: simulate saving with delay
    await new Promise((resolve) => setTimeout(resolve, 400));
    // In production this would persist to localStorage or backend
    try {
      localStorage.setItem("tts-demo-settings", JSON.stringify(settings));
    } catch {
      // Silently ignore storage errors
    }
  }, [settings]);

  const testConnection = useCallback(async (): Promise<ConnectionStatus> => {
    setSettings((prev) => ({ ...prev, connectionStatus: "testing" }));
    const status = await demoAdapter.testConnection();
    setSettings((prev) => ({ ...prev, connectionStatus: status }));
    return status;
  }, []);

  // --- Voices ---
  const [voices] = useState<VoiceProfile[]>(() => demoAdapter.listVoices());

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
    const result = demoAdapter.listHistory(historyFilter);
    setHistoryRecords(result.records);
    setHistoryTotalPages(result.totalPages);
  }, [historyFilter]);

  // Load history on mount and whenever filter changes
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // Demo today generation count (static demo value)
  const demoTodayCount = 3;

  const value: AppState = {
    generateResult,
    generatePhase,
    generate,
    resetGeneration,
    lastRequest,
    costEstimate,
    estimateCost,
    adapter: demoAdapter,
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
