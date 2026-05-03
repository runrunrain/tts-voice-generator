import { useState, useCallback } from "react";
import { Link } from "react-router";
import { Play, Download, Copy, ChevronRight, Search } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { HistoryStatus, HistorySource } from "../types";

export function HistoryPage() {
  const {
    historyRecords,
    historyTotalPages,
    historyFilter,
    setHistoryFilter,
    refreshHistory,
  } = useAppState();

  // Local UI states not covered by context filter
  const [searchQuery, setSearchQuery] = useState("");
  const [activeRecord, setActiveRecord] = useState<string>(
    historyRecords[0]?.id ?? ""
  );

  // Client-side search on top of server-side filtered records
  const displayedRecords = searchQuery
    ? historyRecords.filter(
        (r) =>
          r.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
          r.id.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : historyRecords;

  const totalPages = historyTotalPages;

  // Active filters for display
  const activeFilters: string[] = [];
  if (historyFilter.voice) activeFilters.push(historyFilter.voice);
  if (historyFilter.status)
    activeFilters.push(historyFilter.status === "success" ? "成功" : "错误");
  if (historyFilter.source) activeFilters.push(historyFilter.source);

  const clearFilters = useCallback(() => {
    setHistoryFilter({ voice: undefined, status: undefined, source: undefined, page: 1 });
    setSearchQuery("");
  }, [setHistoryFilter]);

  return (
    <div className="flex flex-col h-full">
      {/* Filter Bar */}
      <div className="h-11 px-4 flex items-center justify-between border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-3">
          <div className="relative">
            <input
              type="text"
              placeholder="搜索记录..."
              className="w-48 bg-bg-sunken border border-border rounded-md pl-7 pr-3 py-1 text-sm outline-none focus:border-border-focus text-text-primary placeholder:text-text-tertiary"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); }}
            />
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
          </div>
          <select
            className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-sm text-text-primary focus:border-border-focus"
            value={historyFilter.voice ?? ""}
            onChange={(e) => {
              setHistoryFilter({ voice: (e.target.value || undefined) as string | undefined, page: 1 });
            }}
          >
            <option value="">全部音色</option>
            <option value="alloy">alloy</option>
            <option value="nova">nova</option>
            <option value="echo">echo</option>
            <option value="shimmer">shimmer</option>
          </select>
          <select
            className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-sm text-text-primary focus:border-border-focus"
            value={historyFilter.status ?? ""}
            onChange={(e) => {
              setHistoryFilter({
                status: (e.target.value || undefined) as HistoryStatus | undefined,
                page: 1,
              });
            }}
          >
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="error">错误</option>
          </select>
          <select
            className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-sm text-text-primary focus:border-border-focus"
            value={historyFilter.source ?? ""}
            onChange={(e) => {
              setHistoryFilter({
                source: (e.target.value || undefined) as HistorySource | undefined,
                page: 1,
              });
            }}
          >
            <option value="">全部来源</option>
            <option value="用户">用户</option>
            <option value="Agent">Agent</option>
          </select>
          {activeFilters.length > 0 && (
            <button
              className="text-text-tertiary hover:text-text-secondary transition-colors text-xs"
              onClick={clearFilters}
            >
              清除筛选
            </button>
          )}
        </div>

        {activeFilters.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            当前:
            {activeFilters.map((f, i) => (
              <span key={i} className="flex items-center gap-1 bg-bg-surface px-1.5 py-0.5 rounded border border-border">
                {f}
                <button
                  className="hover:text-text-primary"
                  onClick={() => {
                    if (f === historyFilter.voice) setHistoryFilter({ voice: undefined, page: 1 });
                    else if (f === "成功" || f === "错误") setHistoryFilter({ status: undefined, page: 1 });
                    else if (f === historyFilter.source) setHistoryFilter({ source: undefined, page: 1 });
                  }}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-[2px]">
        {displayedRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <p className="text-text-tertiary text-sm">暂无匹配的历史记录</p>
            <p className="text-text-tertiary text-xs mt-1">调整筛选条件或清除筛选</p>
          </div>
        ) : (
          displayedRecords.map((r) => (
            <div
              key={r.id}
              className={`group flex items-center px-4 h-14 rounded-md cursor-pointer transition-colors ${
                activeRecord === r.id ? "bg-accent-subtle" : "hover:bg-bg-hover"
              }`}
              onClick={() => setActiveRecord(r.id)}
            >
              <div className="flex items-center w-6 shrink-0">
                <div className={`w-2 h-2 rounded-full ${
                  r.status === "success" ? "bg-success" : "bg-error"
                }`} />
              </div>

              <div className="flex-1 min-w-0 pr-4">
                <div className="text-sm text-text-primary truncate font-medium">
                  {r.text}
                </div>
                <div className="text-xs text-text-tertiary flex items-center gap-2 mt-0.5">
                  <span className="text-text-secondary">{r.voice}</span>
                  <span className="w-px h-2.5 bg-border-subtle" />
                  <span>{r.status === "error" ? `错误: ${r.error}` : r.format}</span>
                  <span className="w-px h-2.5 bg-border-subtle" />
                  <span>{r.date}</span>
                  <span className="w-px h-2.5 bg-border-subtle" />
                  <span>{r.source}</span>
                  {r.status === "success" && (
                    <>
                      <span className="w-px h-2.5 bg-border-subtle" />
                      <span>{r.duration}</span>
                    </>
                  )}
                </div>
              </div>

              <div className={`flex items-center gap-1 shrink-0 ${activeRecord === r.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
                {r.status === "success" ? (
                  <>
                    <button className="w-8 h-8 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors" title="播放">
                      <Play size={16} />
                    </button>
                    <button className="w-8 h-8 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors" title="下载">
                      <Download size={16} />
                    </button>
                    <button className="w-8 h-8 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors" title="复制参数">
                      <Copy size={16} />
                    </button>
                  </>
                ) : (
                  <button className="px-3 py-1.5 text-xs font-medium bg-bg-surface border border-border rounded hover:bg-bg-hover transition-colors">
                    重试
                  </button>
                )}
                <Link to={`/history/${r.id}`} className="w-8 h-8 rounded flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent-subtle transition-colors ml-1" title="详情" onClick={(e) => e.stopPropagation()}>
                  <ChevronRight size={16} />
                </Link>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      <div className="h-10 px-4 flex items-center justify-center border-t border-border-subtle bg-bg-base shrink-0 text-sm text-text-secondary">
        <div className="flex items-center gap-4">
          <button
            className="hover:text-text-primary disabled:opacity-50"
            disabled={historyFilter.page <= 1}
            onClick={() => setHistoryFilter({ page: historyFilter.page - 1 })}
          >
            {"<"}
          </button>
          <span>第 {historyFilter.page} 页 / 共 {totalPages} 页</span>
          <button
            className="hover:text-text-primary disabled:opacity-50"
            disabled={historyFilter.page >= totalPages}
            onClick={() => setHistoryFilter({ page: historyFilter.page + 1 })}
          >
            {">"}
          </button>

          <span className="ml-4">每页</span>
          <select
            className="bg-bg-surface border border-border rounded px-1 py-0.5 outline-none text-text-primary text-xs"
            value={historyFilter.pageSize}
            onChange={(e) => setHistoryFilter({ pageSize: Number(e.target.value), page: 1 })}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
          </select>
        </div>
      </div>
    </div>
  );
}
