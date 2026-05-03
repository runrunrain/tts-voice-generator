import { Link } from "react-router";
import { Filter, Play, Download, Copy, ChevronRight } from "lucide-react";

export function HistoryPage() {
  const records = [
    { id: "gen-abc123", text: "从前有个叫小明的小朋友，有一天他走进了一片神秘的森林...", voice: "alloy", format: "mp3", date: "2026-05-03 14:30", source: "用户", duration: "3.2s", status: "success", active: true },
    { id: "gen-def456", text: "Welcome to the future of voice generation. This is a test...", voice: "nova", format: "mp3", date: "2026-05-03 12:15", source: "Agent", duration: "4.5s", status: "success", active: false },
    { id: "gen-err789", text: "测试文本用于验证 API 的容错能力，特别是长文本截断...", voice: "alloy", format: "pcm", date: "2026-05-03 10:05", source: "用户", duration: "0.0s", status: "error", error: "RATE_LIMITED", active: false },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Filter Bar */}
      <div className="h-11 px-4 flex items-center justify-between border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <select className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-text-primary">
              <option>音色</option>
            </select>
            <select className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-text-primary">
              <option>状态</option>
            </select>
            <select className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-text-primary">
              <option>来源</option>
            </select>
            <button className="text-text-secondary hover:text-text-primary transition-colors">日期范围</button>
            <button className="text-text-tertiary hover:text-text-secondary transition-colors ml-2">清除</button>
          </div>
        </div>
        
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          当前: 
          <span className="flex items-center gap-1 bg-bg-surface px-1.5 py-0.5 rounded border border-border">alloy <button className="hover:text-text-primary">×</button></span>
          <span className="flex items-center gap-1 bg-bg-surface px-1.5 py-0.5 rounded border border-border">成功 <button className="hover:text-text-primary">×</button></span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-[2px]">
        {records.map((r, i) => (
          <div 
            key={i} 
            className={`group flex items-center px-4 h-14 rounded-md cursor-pointer transition-colors ${
              r.active ? "bg-accent-subtle" : "hover:bg-bg-hover"
            }`}
          >
            <div className="flex items-center w-6 shrink-0">
              <div className={`w-2 h-2 rounded-full ${
                r.status === 'success' ? 'bg-success' : 'bg-error'
              }`} />
            </div>
            
            <div className="flex-1 min-w-0 pr-4">
              <div className="text-sm text-text-primary truncate font-medium">
                {r.text}
              </div>
              <div className="text-xs text-text-tertiary flex items-center gap-2 mt-0.5">
                <span className="text-text-secondary">{r.voice}</span>
                <span className="w-px h-2.5 bg-border-subtle" />
                <span>{r.status === 'error' ? `错误: ${r.error}` : r.format}</span>
                <span className="w-px h-2.5 bg-border-subtle" />
                <span>{r.date}</span>
                <span className="w-px h-2.5 bg-border-subtle" />
                <span>{r.source}</span>
                {r.status === 'success' && (
                  <>
                    <span className="w-px h-2.5 bg-border-subtle" />
                    <span>{r.duration}</span>
                  </>
                )}
              </div>
            </div>
            
            <div className={`flex items-center gap-1 shrink-0 ${r.active ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
              {r.status === 'success' ? (
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
              <Link to={`/history/${r.id}`} className="w-8 h-8 rounded flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent-subtle transition-colors ml-1" title="详情">
                <ChevronRight size={16} />
              </Link>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="h-10 px-4 flex items-center justify-center border-t border-border-subtle bg-bg-base shrink-0 text-sm text-text-secondary">
        <div className="flex items-center gap-4">
          <button className="hover:text-text-primary disabled:opacity-50">{'<'}</button>
          <span>第 1 页 / 共 5 页</span>
          <button className="hover:text-text-primary disabled:opacity-50">{'>'}</button>
          
          <span className="ml-4">每页</span>
          <select className="bg-bg-surface border border-border rounded px-1 py-0.5 outline-none text-text-primary text-xs">
            <option>20</option>
            <option>50</option>
          </select>
        </div>
      </div>
    </div>
  );
}
