import { useState, useCallback } from "react";
import { Search, Filter, Play, Loader2 } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { VoiceStatus } from "../types";

type TabFilter = "all" | "verified" | "candidate" | "custom" | "failed";

export function VoicesPage() {
  const { voices, adapter } = useAppState();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [selectedVoice, setSelectedVoice] = useState<string>("alloy");
  const [probeStatuses, setProbeStatuses] = useState<Record<string, "idle" | "loading" | "success" | "error">>({});

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

  const handleProbe = useCallback(async (voiceName: string) => {
    setProbeStatuses((prev) => ({ ...prev, [voiceName]: "loading" }));
    const result = await adapter.probeVoice(voiceName);
    setProbeStatuses((prev) => ({ ...prev, [voiceName]: result.status === "success" ? "success" : "error" }));
    setTimeout(() => {
      setProbeStatuses((prev) => ({ ...prev, [voiceName]: "idle" }));
    }, 3000);
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

      {/* Grid */}
      <div className="flex-1 p-6 overflow-y-auto">
        {filteredVoices.length === 0 ? (
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
                    <span className="text-text-primary truncate">{v.role}</span>
                  </div>
                  <div className="flex">
                    <span className="w-12 text-text-tertiary">供应商:</span>
                    <span className="text-text-primary truncate">{v.provider}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-auto">
                  <span className="text-[10px] text-text-tertiary">上次验证: {v.lastVerified.slice(5)}</span>
                  <div className="flex gap-2">
                    <button
                      className="text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                      onClick={(e) => { e.stopPropagation(); handleProbe(v.name); }}
                      disabled={probeStatuses[v.name] === "loading"}
                    >
                      {probeStatuses[v.name] === "loading" ? (
                        <Loader2 size={12} className="animate-spin inline" />
                      ) : probeStatuses[v.name] === "success" ? "验证成功" : probeStatuses[v.name] === "error" ? "验证失败" : "探针"}
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
      </div>
    </div>
  );
}
