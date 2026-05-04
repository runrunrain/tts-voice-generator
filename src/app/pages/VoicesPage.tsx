import { useState, useCallback, useEffect } from "react";
import { Search, Filter, Play, Loader2, AlertTriangle, AlertCircle, RefreshCw } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { VoiceStatus } from "../types";

type TabFilter = "all" | "verified" | "candidate" | "custom" | "failed";

export function VoicesPage() {
  const { voices, adapter, voicesLoading, voicesError, refreshVoices, voicesLoaded, voiceStats } = useAppState();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [selectedVoice, setSelectedVoice] = useState<string>("Zephyr");
  const [probeStatuses, setProbeStatuses] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});
  const [probeErrors, setProbeErrors] = useState<Record<string, string | null>>({});
  const [probeMeta, setProbeMeta] = useState<Record<string, { cached?: boolean; cacheTtlSeconds?: number | null; lastVerified?: string | null }>>({});

  // Filter voices
  const filteredVoices = voices.filter((v) => {
    if (searchQuery && !v.name.toLowerCase().includes(searchQuery.toLowerCase()) && !v.role.includes(searchQuery)) {
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
    const result = await adapter.probeVoice(voiceName, force || undefined);
    setProbeMeta((prev) => ({ ...prev, [voiceName]: { cached: result.cached, cacheTtlSeconds: result.cacheTtlSeconds, lastVerified: result.lastVerified } }));
    if (result.status === "success") {
      setProbeStatuses((prev) => ({ ...prev, [voiceName]: "success" }));
    } else {
      setProbeStatuses((prev) => ({ ...prev, [voiceName]: "error" }));
      setProbeErrors((prev) => ({ ...prev, [voiceName]: result.error || null }));
    }
    setTimeout(() => {
      setProbeStatuses((prev) => ({ ...prev, [voiceName]: "idle" }));
    }, 5000);
  }, [adapter]);

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
              <span className="text-text-secondary">未知 <span className="text-warning font-semibold">{voiceStats.unknown}</span></span>
            )}
            {voiceStats.neverVerified > 0 && (
              <span className="text-text-secondary">未验证 <span className="text-warning font-semibold">{voiceStats.neverVerified}</span></span>
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
            {filteredVoices.map((v) => (
              <div
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
                    <div className={`w-2 h-2 rounded-full ${
                      v.status === "success" ? "bg-success" : v.status === "warning" ? "bg-warning" : "bg-error"
                    }`} />
                    <span className="font-semibold text-text-primary">{v.name}</span>
                    {v.isDefault && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-bg-sunken text-text-secondary border border-border-subtle">
                        默认
                      </span>
                    )}
                  </div>
                  {selectedVoice === v.name && <span className="text-[10px] text-accent">当前选中</span>}
                </div>

                <div className="flex flex-col gap-1 text-[11px] text-text-secondary mb-3">
                  <div className="flex">
                    <span className="w-12 text-text-tertiary">角色:</span>
                    <span className="text-text-primary truncate">{v.role || "--"}</span>
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
                      className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover transition-colors"
                      onClick={(e) => { e.stopPropagation(); }}
                    >
                      <Play size={12} fill="currentColor" />
                      试听
                    </button>
                  </div>
                </div>
              </div>
            ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
