import { useState } from "react";
import { Link } from "react-router";

export function GeneratePage() {
  const [text, setText] = useState("");

  return (
    <div className="flex flex-col h-full py-6 px-8">
      <div className="mb-4 shrink-0">
        <h2 className="text-2xl font-bold font-display text-text-primary">语音生成</h2>
        <p className="text-text-secondary text-sm mt-1">输入文本，选择音色，一键生成</p>
      </div>

      <div className="flex-1 min-h-[200px] mb-4 relative rounded-md border border-border bg-bg-sunken focus-within:border-border-focus transition-colors">
        <textarea 
          className="w-full h-full bg-transparent resize-none outline-none p-4 text-sm text-text-primary placeholder:text-text-tertiary"
          placeholder="输入要转为语音的文本内容..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="absolute bottom-3 right-3 text-xs text-text-tertiary">
          字符计数: {text.length}/5000
        </div>
      </div>

      <div className="h-12 shrink-0 flex items-center gap-4 mb-2">
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary">音色</label>
          <select className="bg-bg-surface border border-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-border-focus transition-colors">
            <option>alloy</option>
            <option>echo</option>
            <option>nova</option>
          </select>
        </div>
        
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary">格式</label>
          <div className="flex items-center bg-bg-surface border border-border rounded-md overflow-hidden text-sm">
            <button className="px-3 py-1.5 bg-bg-active text-text-primary">mp3</button>
            <button className="px-3 py-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors">pcm</button>
          </div>
        </div>
      </div>

      <div className="h-12 shrink-0 flex items-center justify-end gap-4">
        <Link 
          to="/generate/director" 
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          Director 模式 →
        </Link>
        <button 
          className="flex items-center gap-2 px-6 py-2 rounded-md bg-accent text-bg-base text-sm font-medium hover:bg-accent-hover active:bg-accent-active transition-colors shadow-shadow-glow"
        >
          生成语音
          <span className="text-bg-base/70 text-xs ml-2 border-l border-bg-base/20 pl-2">预估 $0.0005</span>
        </button>
      </div>
    </div>
  );
}
