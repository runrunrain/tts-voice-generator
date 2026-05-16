import { useState, useCallback, useEffect, useRef } from "react";
import { Search, Filter, Play, Loader2, AlertTriangle, AlertCircle, RefreshCw } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { VoiceAuditionResult, VoiceStatus } from "../types";
import { formatVoiceCompactLabel, getVoiceDisplayMeta, voiceMatchesQuery } from "../utils/voiceDisplay";

type TabFilter = "all" | "verified" | "candidate" | "custom" | "failed";
type AuditionPhase = "idle" | "loading" | "playing" | "success" | "error";

interface AuditionUiState {
  phase: AuditionPhase;
  message?: string;
  code?: string;
  latencyMs?: number;
}

function statusDotClass(status: VoiceStatus) {
  switch (status) {
    case "success": return "bg-success";
    case "warning": return "bg-warning";
    case "error": return "bg-error";
    case "pending":
    default: return "bg-text-tertiary/60";
  }
}

function statusLabel(status: VoiceStatus) {
  switch (status) {
    case "success": return "已验证";
    case "warning": return "需关注";
    case "error": return "验证失败";
    case "pending":
    default: return "未验证";
  }
}

function formatAuditionFailure(error: VoiceAuditionResult["error"] | undefined) {
  const code = error?.code ?? "UNKNOWN";
  if (code === "MISSING_API_KEY") return "未配置 OpenRouter API Key，请前往设置页配置后重试。";
  if (code === "INVALID_API_KEY" || code === "FORBIDDEN") return "OpenRouter API Key 无效或无权限，请检查设置。";
  if (code === "INSUFFICIENT_CREDITS") return "OpenRouter 额度不足，无法生成试听音频。";
  if (code === "RATE_LIMITED") return "OpenRouter 请求过于频繁，请稍后重试。";
  if (code === "NETWORK_ERROR") return "无法连接后端服务，请检查网络或服务状态。";
  if (code === "REQUEST_TIMEOUT") return "上游试听请求超时，请稍后重试。";
  if (error?.category === "upstream") return `上游试听失败：${error.message}`;
  return error?.message || "试听失败，请稍后重试。";
}

export function VoicesPage() {
  const { voices, adapter, voicesLoading, voicesError, refreshVoices, voicesLoaded, voiceStats } = useAppState();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [selectedVoice, setSelectedVoice] = useState<string>("Zephyr");
  const [probeStatuses, setProbeStatuses] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});
  const [probeErrors, setProbeErrors] = useState<Record<string, string | null>>({});
  const [probeMeta, setProbeMeta] = useState<Record<string, { cached?: boolean; cacheTtlSeconds?: number | null; lastVerified?: string | null }>>({});
  const [auditionStates, setAuditionStates] = useState<Record<string, AuditionUiState>>({});
  const auditionStatesRef = useRef<Record<string, AuditionUiState>>({});
  const auditionLoadingRef = useRef<Set<string>>(new Set());
  const auditionResetTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const activeAuditionRef = useRef<{ voiceName: string; cleanup: () => void } | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    auditionStatesRef.current = auditionStates;
  }, [auditionStates]);

  const clearAuditionResetTimer = useCallback((voiceName: string) => {
    const timer = auditionResetTimersRef.current[voiceName];
    if (timer) {
      clearTimeout(timer);
      delete auditionResetTimersRef.current[voiceName];
    }
  }, []);

  const scheduleAuditionReset = useCallback((voiceName: string) => {
    clearAuditionResetTimer(voiceName);
    auditionResetTimersRef.current[voiceName] = setTimeout(() => {
      setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "idle" } }));
      delete auditionResetTimersRef.current[voiceName];
    }, 5000);
  }, [clearAuditionResetTimer]);

  const cleanupActiveAudition = useCallback((nextState?: AuditionUiState) => {
    const active = activeAuditionRef.current;
    if (!active) return;
    active.cleanup();
    activeAuditionRef.current = null;
    if (nextState) {
      setAuditionStates((prev) => ({ ...prev, [active.voiceName]: nextState }));
      scheduleAuditionReset(active.voiceName);
    }
  }, [scheduleAuditionReset]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanupActiveAudition();
      Object.values(auditionResetTimersRef.current).forEach(clearTimeout);
      auditionResetTimersRef.current = {};
      auditionLoadingRef.current.clear();
    };
  }, [cleanupActiveAudition]);

  // Filter voices
  const filteredVoices = voices.filter((v) => {
    if (searchQuery && !voiceMatchesQuery(v, searchQuery)) {
      return false;
    }
    switch (activeTab) {
      case "verified": return v.status === "success" && v.provider !== "Local";
      case "candidate": return v.status === "success" && !v.isDefault && v.provider !== "Local";
      case "custom": return v.provider === "Local" && v.status === "warning";
      case "failed": return v.status === "error";
      default: return true;
    }
  });

  // Tab counts
  const tabCounts: Record<TabFilter, number> = {
    all: voices.length,
    verified: voices.filter((v) => v.status === "success" && v.provider !== "Local").length,
    candidate: voices.filter((v) => v.status === "success" && !v.isDefault && v.provider !== "Local").length,
    custom: voices.filter((v) => v.provider === "Local" && v.status === "warning").length,
    failed: voices.filter((v) => v.status === "error").length,
  };

  const handleProbe = useCallback(async (voiceName: string, force = false) => {
    setProbeStatuses((prev) => ({ ...prev, [voiceName]: "loading" }));
    setProbeErrors((prev) => ({ ...prev, [voiceName]: null }));
    try {
      const result = await adapter.probeVoice(voiceName, force || undefined);
      setProbeMeta((prev) => ({ ...prev, [voiceName]: { cached: result.cached, cacheTtlSeconds: result.cacheTtlSeconds, lastVerified: result.lastVerified } }));
      if (result.status === "success") {
        setProbeStatuses((prev) => ({ ...prev, [voiceName]: "success" }));
      } else {
        setProbeStatuses((prev) => ({ ...prev, [voiceName]: "error" }));
        setProbeErrors((prev) => ({ ...prev, [voiceName]: result.error || null }));
      }
      refreshVoices();
    } catch {
      setProbeStatuses((prev) => ({ ...prev, [voiceName]: "error" }));
      setProbeErrors((prev) => ({ ...prev, [voiceName]: "NETWORK_ERROR" }));
    }
    setTimeout(() => {
      setProbeStatuses((prev) => ({ ...prev, [voiceName]: "idle" }));
    }, 5000);
  }, [adapter, refreshVoices]);

  const playAuditionUrl = useCallback(async (voiceName: string, objectUrl: string, latencyMs?: number) => {
    cleanupActiveAudition({ phase: "success", message: "已切换到新的试听音色" });

    const audio = new Audio(objectUrl);
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
    };

    const clearActiveIfCurrent = () => {
      if (activeAuditionRef.current?.voiceName === voiceName) activeAuditionRef.current = null;
    };

    const handleEnded = () => {
      cleanup();
      clearActiveIfCurrent();
      setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "success", message: "试听完成", latencyMs } }));
      scheduleAuditionReset(voiceName);
    };

    const handleError = () => {
      cleanup();
      clearActiveIfCurrent();
      setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "error", code: "PLAYBACK_ERROR", message: "音频播放失败，请重试。" } }));
      scheduleAuditionReset(voiceName);
    };

    audio.addEventListener("ended", handleEnded, { once: true });
    audio.addEventListener("error", handleError, { once: true });
    activeAuditionRef.current = { voiceName, cleanup };
    setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "playing", message: "正在播放试听", latencyMs } }));

    try {
      await audio.play();
    } catch {
      cleanup();
      clearActiveIfCurrent();
      if (!isMountedRef.current) return;
      setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "error", code: "PLAYBACK_BLOCKED", message: "浏览器阻止了音频播放，请再次点击试听。" } }));
      scheduleAuditionReset(voiceName);
    }
  }, [cleanupActiveAudition, scheduleAuditionReset]);

  const handleAudition = useCallback(async (voiceName: string) => {
    const currentState = auditionStatesRef.current[voiceName];
    if (currentState?.phase === "playing" && activeAuditionRef.current?.voiceName === voiceName) {
      cleanupActiveAudition({ phase: "success", message: "试听已停止" });
      return;
    }
    if (auditionLoadingRef.current.has(voiceName)) return;

    if (!adapter.auditionVoice) {
      setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "error", code: "UNSUPPORTED", message: "当前适配器不支持音色试听。" } }));
      scheduleAuditionReset(voiceName);
      return;
    }

    auditionLoadingRef.current.add(voiceName);
    clearAuditionResetTimer(voiceName);
    setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "loading", message: "正在生成试听音频" } }));

    try {
      const result = await adapter.auditionVoice(voiceName);
      if (!isMountedRef.current) {
        if (result.ok && result.objectUrl) URL.revokeObjectURL(result.objectUrl);
        return;
      }
      if (!result.ok) {
        setAuditionStates((prev) => ({
          ...prev,
          [voiceName]: {
            phase: "error",
            code: result.error?.code ?? "AUDITION_ERROR",
            message: formatAuditionFailure(result.error),
            latencyMs: result.latencyMs,
          },
        }));
        scheduleAuditionReset(voiceName);
        return;
      }

      const objectUrl = result.objectUrl ?? (result.audioBlob ? URL.createObjectURL(result.audioBlob) : undefined);
      if (!objectUrl) {
        setAuditionStates((prev) => ({ ...prev, [voiceName]: { phase: "error", code: "NO_AUDIO_URL", message: "后端已返回音频，但浏览器无法创建试听链接。", latencyMs: result.latencyMs } }));
        scheduleAuditionReset(voiceName);
        return;
      }

      await playAuditionUrl(voiceName, objectUrl, result.latencyMs);
    } catch (err) {
      if (!isMountedRef.current) return;
      setAuditionStates((prev) => ({
        ...prev,
        [voiceName]: {
          phase: "error",
          code: "UNEXPECTED",
          message: err instanceof Error ? err.message : "试听过程中发生未知错误。",
        },
      }));
      scheduleAuditionReset(voiceName);
    } finally {
      auditionLoadingRef.current.delete(voiceName);
    }
  }, [adapter, cleanupActiveAudition, clearAuditionResetTimer, playAuditionUrl, scheduleAuditionReset]);

  return (
    <div className="flex flex-col h-full">
      {/* ToolBar */}
      <div className="h-12 px-6 flex items-center justify-between border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              type="text"
              placeholder="搜索音色..."
              className="w-60 bg-bg-sunken border border-border rounded-md pl-8 pr-3 py-1.5 text-sm outline-none focus:border-border-focus text-text-primary placeholder:text-text-tertiary"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          </div>
        </div>

        <button className="flex items-center gap-1 px-3 py-1.5 bg-bg-surface border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors">
          <Filter size={14} />
          筛选
        </button>
      </div>

      {/* Tabs */}
      <div className="h-9 px-6 flex items-center border-b border-border-subtle text-sm shrink-0 bg-bg-base">
        {([
          ["all", "全部"],
          ["verified", "已验证"],
          ["candidate", "候选"],
          ["custom", "自定义"],
          ["failed", "失败"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            className={`h-full px-4 border-b-2 font-medium transition-colors ${
              activeTab === key
                ? "border-accent text-text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
            onClick={() => setActiveTab(key)}
          >
            {label} ({tabCounts[key]})
          </button>
        ))}
      </div>

      {/* Voice Stats Summary */}
      {voiceStats && (
        <div className="px-6 py-2.5 border-b border-border-subtle bg-bg-sunken shrink-0">
          <div className="flex items-center gap-4 text-xs flex-wrap">
            <span className="text-text-tertiary font-medium">可用性报告</span>
            <span className="text-text-secondary">总计 <span className="text-text-primary font-semibold">{voiceStats.total}</span></span>
            <span className="text-text-secondary">已验证 <span className="text-success font-semibold">{voiceStats.verified}</span></span>
            {voiceStats.failed > 0 && (
              <span className="text-text-secondary">失败 <span className="text-error font-semibold">{voiceStats.failed}</span></span>
            )}
            {voiceStats.unknown > 0 && (
              <span className="text-text-secondary">未知 <span className="text-text-tertiary font-semibold">{voiceStats.unknown}</span></span>
            )}
            {voiceStats.neverVerified > 0 && (
              <span className="text-text-secondary">未验证 <span className="text-text-tertiary font-semibold">{voiceStats.neverVerified}</span></span>
            )}
            {voiceStats.staleVerified > 0 && (
              <span className="text-text-secondary">过期 <span className="text-warning font-semibold">{voiceStats.staleVerified}</span></span>
            )}
            {voiceStats.avgLatencyMs != null && (
              <span className="text-text-secondary">平均延迟 <span className="text-text-primary font-mono">{(voiceStats.avgLatencyMs / 1000).toFixed(1)}s</span></span>
            )}
          </div>
          {voiceStats.errorSummary.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-border-subtle">
              <div className="text-[10px] text-text-tertiary mb-1">错误摘要 (近 {Math.min(voiceStats.errorSummary.length, 5)} 条)</div>
              <div className="flex flex-col gap-0.5">
                {voiceStats.errorSummary.slice(0, 5).map((e, i) => (
                  <div key={i} className="text-[11px] text-text-secondary flex items-center gap-2">
                    <span className="text-text-primary font-medium w-24 shrink-0 truncate">{e.voice || "--"}</span>
                    {e.errorCode && <span className="text-error font-mono shrink-0">{e.errorCode}</span>}
                    <span className="truncate flex-1">{e.errorMessage}</span>
                    <span className="text-text-tertiary shrink-0">({e.count}次)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 p-6 overflow-y-auto">
        {voicesLoading && voices.length === 0 ? (
          /* Loading: first-time fetch or retry with no fallback data */
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <Loader2 size={24} className="animate-spin text-text-tertiary mb-3" />
            <p className="text-text-tertiary text-sm">正在从后端加载音色列表...</p>
          </div>
        ) : voicesError && voices.length === 0 ? (
          /* Error: fetch failed and no fallback data available */
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <AlertCircle size={24} className="text-error mb-3" />
            <p className="text-error text-sm font-medium">加载音色列表失败</p>
            <p className="text-text-tertiary text-xs mt-1">{voicesError}</p>
            <button
              className="mt-4 flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-bg-surface border border-border hover:bg-bg-hover transition-colors"
              onClick={refreshVoices}
            >
              <RefreshCw size={14} /> 重试
            </button>
          </div>
        ) : voicesLoaded && voices.length === 0 && !voicesError ? (
          /* Empty: successful fetch returned empty list */
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <p className="text-text-tertiary text-sm">没有可用的音色</p>
            <p className="text-text-tertiary text-xs mt-1">后端返回空列表，请检查后端配置</p>
          </div>
        ) : (
          /* Data section: have voices (or filter cleared them all) */
          <>
            {/* Inline error banner when stale data is visible */}
            {voicesError && voices.length > 0 && (
              <div className="flex items-center gap-3 px-4 py-2 mb-4 rounded-md bg-error-muted/50 border border-error/20 text-sm">
                <AlertCircle size={16} className="text-error shrink-0" />
                <span className="text-error text-xs">刷新失败: {voicesError}</span>
                <button
                  className="ml-auto flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
                  onClick={refreshVoices}
                >
                  <RefreshCw size={12} /> 重试
                </button>
              </div>
            )}
            {/* Inline loading indicator when refreshing with existing data */}
            {voicesLoading && voices.length > 0 && (
              <div className="flex items-center gap-2 px-4 py-1.5 mb-4 rounded-md bg-accent-muted/30 border border-accent/10 text-xs text-text-tertiary">
                <Loader2 size={12} className="animate-spin" />
                正在刷新音色列表...
              </div>
            )}
            {filteredVoices.length === 0 ? (
              /* No match: filter produced no results */
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <p className="text-text-tertiary text-sm">没有匹配的音色</p>
                <p className="text-text-tertiary text-xs mt-1">尝试调整筛选条件</p>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {filteredVoices.map((v) => {
              const displayMeta = getVoiceDisplayMeta(v.name);
              const auditionState = auditionStates[v.name] ?? { phase: "idle" };
              const isAuditionLoading = auditionState.phase === "loading";
              const isAuditionPlaying = auditionState.phase === "playing";
              return <div
                 key={v.name}
                 className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                   selectedVoice === v.name
                    ? "bg-accent-subtle border-accent/30"
                    : "bg-bg-surface border-border hover:border-border-subtle hover:bg-bg-hover"
                }`}
                onClick={() => setSelectedVoice(v.name)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${statusDotClass(v.status)}`} />
                    <span className="font-semibold text-text-primary">{formatVoiceCompactLabel(v.name)}</span>
                    {v.isDefault && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-bg-sunken text-text-secondary border border-border-subtle">
                        默认
                      </span>
                    )}
                    <span className={`px-1.5 py-0.5 rounded text-[10px] border ${
                      v.status === "success" ? "bg-success-muted/20 text-success border-success/20"
                        : v.status === "warning" ? "bg-warning-muted/20 text-warning border-warning/20"
                          : v.status === "error" ? "bg-error-muted/20 text-error border-error/20"
                            : "bg-bg-sunken text-text-tertiary border-border-subtle"
                    }`}>
                      {statusLabel(v.status)}
                    </span>
                  </div>
                  {selectedVoice === v.name && <span className="text-[10px] text-accent">当前选中</span>}
                </div>

                <div className="flex flex-col gap-1 text-[11px] text-text-secondary mb-3">
                  <div className="flex">
                    <span className="w-12 text-text-tertiary">声线:</span>
                    <span className="text-text-primary truncate">{displayMeta.toneDescription || v.role || "--"}</span>
                  </div>
                  <div className="flex">
                    <span className="w-12 text-text-tertiary">英文:</span>
                    <span className="text-text-primary font-mono truncate">{v.name}</span>
                  </div>
                  <div className="flex">
                    <span className="w-12 text-text-tertiary">供应商:</span>
                    <span className="text-text-primary truncate">{v.provider}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-auto">
                  <span className="text-[10px] text-text-tertiary">{v.lastVerified ? `上次验证: ${v.lastVerified.slice(5)}` : "未验证"}</span>
                  <div className="flex items-center gap-2">
                    <button
                      className="text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                      onClick={(e) => { e.stopPropagation(); handleProbe(v.name); }}
                      disabled={probeStatuses[v.name] === "loading"}
                    >
                      {probeStatuses[v.name] === "loading" ? (
                        <Loader2 size={12} className="animate-spin inline" />
                      ) : probeStatuses[v.name] === "error" ? (
                        <span className="text-error flex items-center gap-1"><AlertTriangle size={10} /> {probeErrors[v.name] === "MISSING_API_KEY" ? "未配置 Key" : "探针失败"}</span>
                      ) : probeStatuses[v.name] === "success" ? (
                        <span className="flex items-center gap-1">
                          验证成功
                          {probeMeta[v.name]?.cached ? (
                            <span className="text-text-tertiary text-[10px]">(缓存)</span>
                          ) : probeMeta[v.name] !== undefined ? (
                            <span className="text-accent text-[10px]">(实时)</span>
                          ) : null}
                        </span>
                      ) : "探针"}
                    </button>
                    <button
                      className="text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      onClick={(e) => { e.stopPropagation(); handleProbe(v.name, true); }}
                      disabled={probeStatuses[v.name] === "loading"}
                      title="强制刷新探针"
                    >
                      <RefreshCw size={11} />
                    </button>
                    <button
                      className={`flex items-center gap-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        auditionState.phase === "error" ? "text-error hover:text-error" : isAuditionPlaying ? "text-success hover:text-success" : "text-accent hover:text-accent-hover"
                      }`}
                      onClick={(e) => { e.stopPropagation(); void handleAudition(v.name); }}
                      disabled={isAuditionLoading}
                      title={isAuditionLoading ? "正在生成试听音频" : isAuditionPlaying ? "点击停止试听" : "试听该音色"}
                      aria-label={`${formatVoiceCompactLabel(v.name)} ${isAuditionPlaying ? "停止试听" : "试听"}`}
                    >
                      {isAuditionLoading ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Play size={12} fill="currentColor" />
                      )}
                      {isAuditionLoading ? "生成中" : isAuditionPlaying ? "播放中" : auditionState.phase === "error" ? "重试试听" : "试听"}
                    </button>
                  </div>
                </div>
                {auditionState.phase !== "idle" && auditionState.message && (
                  <div
                    role={auditionState.phase === "error" ? "alert" : "status"}
                    className={`mt-2 flex items-start gap-1.5 rounded border px-2 py-1 text-[10px] leading-snug ${
                      auditionState.phase === "error"
                        ? "bg-error-muted/30 border-error/20 text-error"
                        : auditionState.phase === "playing"
                          ? "bg-success-muted/20 border-success/15 text-success"
                          : "bg-bg-sunken border-border-subtle text-text-tertiary"
                    }`}
                  >
                    {auditionState.phase === "loading" ? <Loader2 size={11} className="mt-0.5 shrink-0 animate-spin" /> : auditionState.phase === "error" ? <AlertTriangle size={11} className="mt-0.5 shrink-0" /> : <Play size={11} className="mt-0.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      {auditionState.message}
                      {auditionState.latencyMs != null && auditionState.phase !== "error" ? ` · ${(auditionState.latencyMs / 1000).toFixed(1)}s` : ""}
                      {auditionState.code && auditionState.phase === "error" ? ` (${auditionState.code})` : ""}
                    </span>
                  </div>
                )}
              </div>;
            })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
