import { useState } from "react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";

export function DirectorPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Editor */}
        <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-6">
          
          <div className="border border-border rounded-lg bg-bg-surface overflow-hidden">
            <div className="h-9 px-3 flex items-center justify-between border-b border-border-subtle cursor-pointer hover:bg-bg-hover transition-colors">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles size={16} className="text-accent" />
                Audio Profile
              </div>
              <ChevronDown size={16} className="text-text-tertiary" />
            </div>
            <div className="p-3 bg-bg-sunken">
              <textarea 
                className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="A warm, middle-aged male voice with a calm, reassuring tone..."
              />
            </div>
          </div>

          <div className="border border-border rounded-lg bg-bg-surface overflow-hidden">
            <div className="h-9 px-3 flex items-center justify-between border-b border-border-subtle cursor-pointer hover:bg-bg-hover transition-colors">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="text-text-tertiary">🎬</span> Scene
              </div>
              <ChevronDown size={16} className="text-text-tertiary" />
            </div>
            <div className="p-3 bg-bg-sunken">
              <textarea 
                className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="A cozy living room with a crackling fireplace..."
              />
            </div>
          </div>

          <div className="border border-border rounded-lg bg-bg-surface overflow-hidden">
            <div className="h-9 px-3 flex items-center justify-between border-b border-border-subtle cursor-pointer hover:bg-bg-hover transition-colors">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="text-text-tertiary">📝</span> Director's Notes
              </div>
              <ChevronDown size={16} className="text-text-tertiary" />
            </div>
            <div className="p-3 bg-bg-sunken">
              <textarea 
                className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="Speak slowly and thoughtfully. Emphasize key words..."
              />
            </div>
          </div>

          <div className="border border-border-focus rounded-lg bg-bg-surface overflow-hidden flex-1 flex flex-col min-h-[240px]">
            <div className="h-9 px-3 flex items-center justify-between border-b border-border-subtle bg-bg-hover">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <span className="text-accent">*</span> Transcript
              </div>
            </div>
            <div className="p-3 bg-bg-sunken flex-1 flex flex-col">
              <textarea 
                className="w-full flex-1 bg-transparent outline-none resize-none text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="Type the exact transcript here..."
              />
            </div>
          </div>

        </div>

        {/* Right Column: Config */}
        <div className="w-[400px] border-l border-border-subtle bg-bg-base overflow-y-auto p-6 flex flex-col gap-6">
          
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-text-primary flex items-center justify-between">
              Speaker Config
              <button className="text-accent text-xs font-medium hover:text-accent-hover flex items-center gap-1">
                <Plus size={14} /> 添加 Speaker
              </button>
            </h3>

            <div className="border border-border rounded-md p-3 bg-bg-surface flex flex-col gap-3">
              <div className="flex justify-between items-center text-xs font-medium text-text-secondary">
                Speaker A
              </div>
              <div className="flex items-center gap-2 text-sm">
                <label className="w-10 text-text-tertiary">名称:</label>
                <input className="flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus" defaultValue="主持人" />
              </div>
              <div className="flex items-center gap-2 text-sm">
                <label className="w-10 text-text-tertiary">音色:</label>
                <select className="flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus">
                  <option>alloy</option>
                  <option>nova</option>
                </select>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <label className="w-10 text-text-tertiary">风格:</label>
                <input className="flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus" defaultValue="专业、沉稳" />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-text-primary">快速标签</h3>
            <div className="border border-border rounded-md bg-bg-surface overflow-hidden">
              <div className="flex text-xs border-b border-border-subtle bg-bg-sunken">
                <button className="flex-1 py-2 text-accent border-b border-accent font-medium">情绪</button>
                <button className="flex-1 py-2 text-text-secondary hover:text-text-primary transition-colors">表达</button>
                <button className="flex-1 py-2 text-text-secondary hover:text-text-primary transition-colors">副语言</button>
              </div>
              <div className="p-3 flex flex-wrap gap-2">
                {['[happy]', '[sad]', '[excited]', '[calm]', '[angry]', '[whisper]', '[shout]'].map(tag => (
                  <button key={tag} className="px-2 py-1 rounded bg-bg-base border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border transition-colors">
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Bottom Action Bar */}
      <div className="h-[52px] bg-bg-sunken border-t border-border-subtle shrink-0 px-6 flex items-center justify-between sticky bottom-0">
        <div className="flex items-center gap-4">
          <select className="bg-bg-surface border border-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-border-focus transition-colors">
            <option>alloy</option>
            <option>echo</option>
            <option>nova</option>
          </select>
          
          <div className="flex items-center bg-bg-surface border border-border rounded-md overflow-hidden text-sm">
            <button className="px-3 py-1.5 bg-bg-active text-text-primary">mp3</button>
            <button className="px-3 py-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors">pcm</button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button className="px-4 py-2 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
            预览提示词
          </button>
          <button className="px-6 py-2 rounded-md bg-accent text-bg-base text-sm font-medium hover:bg-accent-hover active:bg-accent-active transition-colors shadow-shadow-glow flex items-center gap-2">
            组装并生成
            <span className="text-bg-base/70 text-xs border-l border-bg-base/20 pl-2">预估 $0.0012</span>
          </button>
        </div>
      </div>
    </div>
  );
}
