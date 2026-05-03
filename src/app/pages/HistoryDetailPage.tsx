import { Link, useParams } from "react-router";
import { Play, Download, Copy, ChevronLeft } from "lucide-react";

export function HistoryDetailPage() {
  const { jobId } = useParams();

  return (
    <div className="flex flex-col h-full bg-bg-base overflow-y-auto">
      <div className="max-w-[1848px] w-full mx-auto p-6 flex flex-col gap-6">
        
        <div className="h-10 flex items-center gap-4 text-sm shrink-0">
          <Link to="/history" className="flex items-center gap-1 text-text-secondary hover:text-text-primary transition-colors">
            <ChevronLeft size={16} /> 返回列表
          </Link>
          <span className="text-text-tertiary">/</span>
          <span className="font-mono text-text-primary">{jobId}</span>
        </div>

        <div className="h-20 flex flex-col justify-center shrink-0">
          <div className="flex items-center gap-3 mb-2">
            <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-success-muted text-success border border-success/20">
              成功
            </span>
            <h1 className="text-2xl font-bold font-mono text-text-primary">{jobId}</h1>
            <span className="text-sm text-text-tertiary ml-auto">创建: 2026-05-03 14:30</span>
          </div>
          <div className="text-sm text-text-secondary">
            来源: 用户 | 耗时: 5.2s
          </div>
        </div>

        <div className="flex gap-6 items-start">
          
          {/* Left Column */}
          <div className="flex-1 flex flex-col gap-6">
            <div className="p-6 bg-bg-surface rounded-lg border border-border flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <button className="w-10 h-10 rounded-full bg-accent text-bg-base flex items-center justify-center hover:bg-accent-hover transition-colors shrink-0">
                  <Play fill="currentColor" size={18} className="ml-0.5" />
                </button>
                <div className="flex-1 h-10 flex items-center gap-1">
                  {Array.from({length: 40}).map((_, i) => (
                    <div key={i} className="flex-1 bg-border rounded-full" style={{ height: `${Math.max(10, Math.random() * 100)}%` }} />
                  ))}
                </div>
                <span className="font-mono text-sm w-12 text-right">03.2</span>
              </div>
              <div className="flex justify-end">
                <button className="flex items-center gap-2 px-4 py-2 rounded-md bg-bg-base border border-border text-sm font-medium hover:bg-bg-hover transition-colors">
                  <Download size={16} /> 下载 MP3
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                输入文本
                <button className="text-xs text-text-tertiary hover:text-text-primary transition-colors flex items-center gap-1">
                  <Copy size={12} /> 复制
                </button>
              </h3>
              <div className="p-4 bg-bg-sunken rounded-md border border-border-subtle font-mono text-sm leading-relaxed text-text-primary min-h-[160px] whitespace-pre-wrap">
                从前有个叫小明的小朋友，有一天他走进了一片神秘的森林。森林里有会说话的兔子，还有闪闪发光的蘑菇...
              </div>
            </div>
            
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                Director Prompt
                <button className="text-xs text-text-tertiary hover:text-text-primary transition-colors flex items-center gap-1">
                  <Copy size={12} /> 复制
                </button>
              </h3>
              <div className="p-4 bg-bg-sunken rounded-md border border-border-subtle font-mono text-xs leading-relaxed text-text-secondary min-h-[100px] whitespace-pre-wrap">
{`<audio_profile>
A warm, middle-aged male voice...
</audio_profile>`}
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="w-[560px] shrink-0 flex flex-col gap-6">
            
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">参数快照</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5">
                <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-sm">
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">模型</div>
                    <div className="text-text-primary font-medium">gemini-3.1-flash</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">音色</div>
                    <div className="text-text-primary font-medium">alloy</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">格式</div>
                    <div className="text-text-primary font-mono text-xs">mp3</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">字符数</div>
                    <div className="text-text-primary font-medium">247</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">成本</div>
                    <div className="text-text-primary font-medium text-accent">$0.0004</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">Agent 信息</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-tertiary">会话</span>
                  <span className="text-text-primary font-mono text-xs">conv-abc123</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-tertiary">工具</span>
                  <span className="text-text-primary font-mono text-xs">generate_speech</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-tertiary">确认状态</span>
                  <span className="text-success">approved</span>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Sticky Bottom Bar */}
      <div className="h-[52px] shrink-0 bg-bg-sunken border-t border-border-subtle mt-auto flex items-center justify-between px-6 sticky bottom-0 z-10">
        <button className="px-4 py-2 rounded-md bg-bg-surface border border-border text-sm font-medium hover:bg-bg-hover transition-colors">
          使用相同参数重新生成
        </button>
        <Link to="/history" className="px-4 py-2 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">
          返回列表
        </Link>
      </div>
    </div>
  );
}
