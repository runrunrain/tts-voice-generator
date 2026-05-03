import { useLocation } from "react-router";
import { X, Play, Download, Loader2, PlayCircle, StopCircle } from "lucide-react";

interface RightPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function RightPanel({ isOpen, onClose }: RightPanelProps) {
  const location = useLocation();

  if (!isOpen) return null;

  return (
    <div className="w-full h-full flex flex-col">
      <div className="h-12 px-4 flex items-center justify-between border-b border-border-subtle shrink-0">
        <h3 className="font-semibold text-sm">
          {location.pathname.includes("/voices") ? "音色详情" 
            : location.pathname.includes("/history") ? "记录预览" 
            : location.pathname.includes("/director") ? "提示词预览"
            : "生成输出"}
        </h3>
        <button 
          onClick={onClose}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 p-5 overflow-y-auto">
        <PanelContent path={location.pathname} />
      </div>
    </div>
  );
}

function PanelContent({ path }: { path: string }) {
  if (path.includes("/director")) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">提示词预览</span>
          <button className="text-xs text-accent hover:text-accent-hover transition-colors">复制</button>
        </div>
        
        <div className="bg-bg-sunken p-4 rounded-md border border-border font-mono text-xs text-text-secondary h-[60vh] overflow-y-auto whitespace-pre-wrap">
{`<audio_profile>
A warm, middle-aged male voice with a calm, reassuring tone. Deep resonance.
</audio_profile>

<scene>
A cozy living room with a crackling fireplace in the background. The speaker is sitting in a comfortable armchair, reading a book.
</scene>

<director_notes>
Speak slowly and thoughtfully. Emphasize key words with slight pauses.
</director_notes>

<transcript>
Once upon a time, in a land far away...
</transcript>`}
        </div>

        <div className="flex items-center justify-between text-xs">
          <span className="text-text-tertiary">Token 估算:</span>
          <span className="text-text-secondary">~1,200 / 8,192</span>
        </div>
      </div>
    );
  }

  if (path.includes("/voices")) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent">
            A
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">alloy</h2>
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-bg-surface border border-border text-text-secondary">默认</span>
            </div>
            <div className="text-xs text-success flex items-center gap-1 mt-1">
              <div className="w-1.5 h-1.5 rounded-full bg-success" />
              已验证
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center py-1">
            <span className="w-20 text-text-tertiary">角色</span>
            <span className="text-text-primary">通用中性音色</span>
          </div>
          <div className="flex items-center py-1">
            <span className="w-20 text-text-tertiary">供应商</span>
            <span className="text-text-primary">OpenRouter</span>
          </div>
          <div className="flex items-center py-1">
            <span className="w-20 text-text-tertiary">模型</span>
            <span className="text-text-primary">Gemini 3.1 Flash</span>
          </div>
          <div className="flex items-center py-1">
            <span className="w-20 text-text-tertiary">上次验证</span>
            <span className="text-text-primary">2026-05-03</span>
          </div>
          <div className="flex items-center py-1">
            <span className="w-20 text-text-tertiary">验证耗时</span>
            <span className="text-text-primary">2.3s</span>
          </div>
        </div>

        <div className="h-px w-full bg-border-subtle" />

        <div className="flex gap-2">
          <button className="flex-1 py-2 rounded-md bg-bg-surface hover:bg-bg-hover text-sm font-medium transition-colors border border-border">
            探针验证
          </button>
          <button className="flex-1 py-2 rounded-md bg-accent text-bg-base text-sm font-medium hover:bg-accent-hover transition-colors shadow-shadow-glow">
            试听样本
          </button>
        </div>
      </div>
    );
  }

  if (path.includes("/history")) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-success-muted text-success border border-success/20">
              成功
            </span>
            <span className="font-mono text-xs text-text-secondary">gen-abc123</span>
          </div>
        </div>

        <div className="flex flex-col gap-1 text-xs text-text-tertiary">
          <span>2026-05-03 14:30:00</span>
          <span>来源: 用户 | 耗时: 5.2s</span>
        </div>

        <div className="p-4 bg-bg-surface rounded-lg border border-border flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button className="w-8 h-8 rounded-full bg-accent text-bg-base flex items-center justify-center hover:bg-accent-hover transition-colors shrink-0">
              <Play fill="currentColor" size={14} className="ml-0.5" />
            </button>
            <div className="flex-1 h-8 flex items-center gap-1">
              {Array.from({length: 20}).map((_, i) => (
                <div key={i} className="flex-1 bg-border rounded-full" style={{ height: `${Math.max(10, Math.random() * 100)}%` }} />
              ))}
            </div>
            <span className="text-xs font-mono w-10 text-right">03.2</span>
          </div>
          <div className="flex justify-end gap-2">
            <button className="text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1">
              <Download size={14} /> 下载 MP3
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 text-sm bg-bg-sunken p-4 rounded-md border border-border-subtle">
          <div className="flex justify-between">
            <span className="text-text-tertiary">音色</span>
            <span className="text-text-primary">alloy</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">格式</span>
            <span className="text-text-primary font-mono text-xs">mp3</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">字符数</span>
            <span className="text-text-primary">247</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">预估成本</span>
            <span className="text-text-primary">$0.0004</span>
          </div>
        </div>

        <button className="text-sm text-accent hover:text-accent-hover transition-colors w-full text-left">
          查看完整详情 →
        </button>
      </div>
    );
  }

  // Default: Generate Output (Empty State)
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4">
      <div className="w-16 h-16 rounded-full bg-bg-surface flex items-center justify-center text-text-tertiary mb-4">
        <PlayCircle size={32} />
      </div>
      <p className="text-text-secondary mb-1 text-sm font-medium">输入文本后点击生成</p>
      <p className="text-text-tertiary text-xs">结果将在此处展示</p>
    </div>
  );
}
