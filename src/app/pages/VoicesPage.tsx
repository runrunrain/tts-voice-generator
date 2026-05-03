import { Search, Filter, Play } from "lucide-react";

export function VoicesPage() {
  const voices = [
    { name: "alloy", default: true, role: "通用中性音色", provider: "OpenRouter", status: "success", date: "05-03" },
    { name: "echo", default: false, role: "成熟男性", provider: "OpenRouter", status: "success", date: "05-03" },
    { name: "nova", default: false, role: "女性知性", provider: "OpenRouter", status: "success", date: "05-03" },
    { name: "shimmer", default: false, role: "温暖女性", provider: "OpenRouter", status: "success", date: "05-03" },
    { name: "fable", default: false, role: "年轻男性", provider: "OpenRouter", status: "success", date: "05-03" },
    { name: "onyx", default: false, role: "深沉男性", provider: "OpenRouter", status: "success", date: "05-03" },
    { name: "custom-1", default: false, role: "自定义角色", provider: "Local", status: "warning", date: "05-02" },
    { name: "custom-fail", default: false, role: "未知", provider: "Local", status: "error", date: "05-01" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* ToolBar */}
      <div className="h-12 px-6 flex items-center justify-between border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative">
            <input 
              type="text" 
              placeholder="自定义音色输入..." 
              className="w-60 bg-bg-sunken border border-border rounded-md pl-8 pr-3 py-1.5 text-sm outline-none focus:border-border-focus text-text-primary placeholder:text-text-tertiary"
            />
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          </div>
          <button className="px-3 py-1.5 bg-bg-surface border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors">
            添加
          </button>
        </div>
        
        <button className="flex items-center gap-1 px-3 py-1.5 bg-bg-surface border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors">
          <Filter size={14} />
          筛选
        </button>
      </div>

      {/* Tabs */}
      <div className="h-9 px-6 flex items-center border-b border-border-subtle text-sm shrink-0 bg-bg-base">
        <button className="h-full px-4 border-b-2 border-accent text-text-primary font-medium">
          全部 (32)
        </button>
        <button className="h-full px-4 border-b-2 border-transparent text-text-secondary hover:text-text-primary transition-colors">
          已验证 (2)
        </button>
        <button className="h-full px-4 border-b-2 border-transparent text-text-secondary hover:text-text-primary transition-colors">
          候选 (28)
        </button>
        <button className="h-full px-4 border-b-2 border-transparent text-text-secondary hover:text-text-primary transition-colors">
          自定义 (1)
        </button>
        <button className="h-full px-4 border-b-2 border-transparent text-text-secondary hover:text-text-primary transition-colors">
          失败 (1)
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {voices.map((v, i) => (
            <div 
              key={i} 
              className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                i === 0 ? "bg-accent-subtle border-accent/30" : "bg-bg-surface border-border hover:border-border-subtle hover:bg-bg-hover"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    v.status === 'success' ? 'bg-success' : v.status === 'warning' ? 'bg-warning' : 'bg-error'
                  }`} />
                  <span className="font-semibold text-text-primary">{v.name}</span>
                  {v.default && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-bg-sunken text-text-secondary border border-border-subtle">
                      默认
                    </span>
                  )}
                </div>
                {i === 0 && <span className="text-[10px] text-accent">当前选中</span>}
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
                <span className="text-[10px] text-text-tertiary">上次验证: {v.date}</span>
                <div className="flex gap-2">
                  <button className="text-xs font-medium text-text-secondary hover:text-text-primary transition-colors">探针</button>
                  <button className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover transition-colors">
                    <Play size={12} fill="currentColor" />
                    试听
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
