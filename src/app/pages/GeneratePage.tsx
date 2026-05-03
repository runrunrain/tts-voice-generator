import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";
import { Loader2, AlertTriangle } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { AudioFormat } from "../types";

const MAX_CHARS = 5000;

const VOICE_OPTIONS = ["alloy", "echo", "nova", "shimmer", "fable", "onyx"];

export function GeneratePage() {
  const { generate, generatePhase, generateResult, resetGeneration, estimateCost, costEstimate, settings } = useAppState();

  const [text, setText] = useState("");
  const [voice, setVoice] = useState(settings.defaultVoice);
  const [format, setFormat] = useState<AudioFormat>(settings.defaultFormat);

  // Real-time cost estimation
  useEffect(() => {
    estimateCost(text.length, format);
  }, [text.length, format, estimateCost]);

  const charCount = text.length;
  const isOverLimit = charCount > MAX_CHARS;
  const isEmpty = text.trim().length === 0;

  const handleGenerate = useCallback(async () => {
    if (isEmpty || isOverLimit || generatePhase === "loading") return;
    await generate({ text: text.trim(), voice, format });
  }, [text, voice, format, isEmpty, isOverLimit, generatePhase, generate]);

  const handleReset = useCallback(() => {
    resetGeneration();
  }, [resetGeneration]);

  return (
    <div className="flex flex-col h-full py-6 px-8">
      <div className="mb-4 shrink-0">
        <h2 className="text-2xl font-bold font-display text-text-primary">语音生成</h2>
        <p className="text-text-secondary text-sm mt-1">输入文本，选择音色，一键生成</p>
      </div>

      {/* Text Area */}
      <div className="flex-1 min-h-[200px] mb-4 relative rounded-md border bg-bg-sunken focus-within:border-border-focus transition-colors"
        style={{ borderColor: isOverLimit ? "var(--color-error)" : undefined }}
      >
        <textarea
          className="w-full h-full bg-transparent resize-none outline-none p-4 text-sm text-text-primary placeholder:text-text-tertiary"
          placeholder="输入要转为语音的文本内容...&#10;&#10;提示：输入包含 [error] 的文本可触发演示错误态"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={generatePhase === "loading"}
        />
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          {isOverLimit && (
            <span className="text-xs text-error flex items-center gap-1">
              <AlertTriangle size={12} /> 超出限制
            </span>
          )}
          <span className={`text-xs ${isOverLimit ? "text-error" : "text-text-tertiary"}`}>
            {charCount}/{MAX_CHARS}
          </span>
        </div>
      </div>

      {/* Controls Row */}
      <div className="h-12 shrink-0 flex items-center gap-4 mb-2">
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary">音色</label>
          <select
            className="bg-bg-surface border border-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-border-focus transition-colors"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            disabled={generatePhase === "loading"}
          >
            {VOICE_OPTIONS.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary">格式</label>
          <div className="flex items-center bg-bg-surface border border-border rounded-md overflow-hidden text-sm">
            <button
              className={`px-3 py-1.5 transition-colors ${format === "mp3" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"}`}
              onClick={() => setFormat("mp3")}
              disabled={generatePhase === "loading"}
            >
              mp3
            </button>
            <button
              className={`px-3 py-1.5 transition-colors ${format === "pcm" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"}`}
              onClick={() => setFormat("pcm")}
              disabled={generatePhase === "loading"}
            >
              pcm
            </button>
          </div>
        </div>
      </div>

      {/* Action Row */}
      <div className="h-12 shrink-0 flex items-center justify-end gap-4">
        <Link
          to="/generate/director"
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          Director 模式 →
        </Link>

        {generatePhase !== "idle" && (
          <button
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            onClick={handleReset}
          >
            重置
          </button>
        )}

        <button
          className="flex items-center gap-2 px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-shadow-glow disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            backgroundColor: isEmpty || isOverLimit || generatePhase === "loading"
              ? "var(--color-bg-active)"
              : "var(--color-accent)",
            color: "var(--color-bg-base)",
          }}
          onClick={handleGenerate}
          disabled={isEmpty || isOverLimit || generatePhase === "loading"}
        >
          {generatePhase === "loading" ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              生成中...
            </>
          ) : generatePhase === "success" ? (
            "重新生成"
          ) : generatePhase === "error" ? (
            "重试生成"
          ) : (
            "生成语音"
          )}
          <span className="text-bg-base/70 text-xs ml-2 border-l border-bg-base/20 pl-2">
            预估 {costEstimate?.estimatedCost ?? "$0.0000"}
          </span>
        </button>
      </div>

      {/* Demo Notice */}
      {generateResult?.isDemo && (
        <div className="mt-2 px-3 py-1.5 rounded-md bg-warning-muted border border-warning/20 text-xs text-warning text-center shrink-0">
          演示模式：当前输出为本地演示数据，不代表真实模型输出。后续接入后端后将替换为实际生成结果。
        </div>
      )}
    </div>
  );
}
