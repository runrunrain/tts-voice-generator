import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "react-router";
import { X, Play, Download, Loader2, PlayCircle, AlertCircle, RefreshCw, Clock } from "lucide-react";
import { useAppState } from "../state/AppContext";

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

// ─── Director Prompt Preview (reads from sessionStorage set by DirectorPage) ─

function DirectorPreview() {
  const [prompt, setPrompt] = useState<string>("");
  const [tokens, setTokens] = useState({ used: 0, total: 8192 });

  useEffect(() => {
    const update = () => {
      try {
        const raw = sessionStorage.getItem("director-prompt");
        if (raw) {
          const parsed = JSON.parse(raw);
          setPrompt(parsed.fullPrompt || "");
          setTokens({ used: parsed.tokenEstimate ?? 0, total: 8192 });
        }
      } catch {
        // ignore
      }
    };
    update();
    const interval = setInterval(update, 500);
    return () => clearInterval(interval);
  }, []);

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [prompt]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">提示词预览</span>
        <button
          className="text-xs text-accent hover:text-accent-hover transition-colors"
          onClick={handleCopy}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>

      <div className="bg-bg-sunken p-4 rounded-md border border-border font-mono text-xs text-text-secondary min-h-[200px] max-h-[60vh] overflow-y-auto whitespace-pre-wrap">
        {prompt || "// 在左侧编辑器中输入内容后，提示词将在此处实时更新"}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-text-tertiary">Token 估算:</span>
        <span className="text-text-secondary">~{tokens.used} / {tokens.total}</span>
      </div>

      <div className="text-[10px] text-text-tertiary text-center border-t border-border-subtle pt-3 mt-2">
        演示模式 -- Token 估算为粗略计算，不代表实际 API 消耗
      </div>
    </div>
  );
}

// ─── Generate Output Panel ───────────────────────────────────────────────────

function GenerateOutputPanel() {
  const { generatePhase, generateResult, generate, lastRequest, resetGeneration } = useAppState();
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Idle state
  if (generatePhase === "idle") {
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

  // Loading state
  if (generatePhase === "loading") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-4">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center text-accent mb-4 animate-pulse">
          <Loader2 size={32} className="animate-spin" />
        </div>
        <p className="text-text-secondary text-sm font-medium">正在生成语音...</p>
        <p className="text-text-tertiary text-xs mt-1">演示模式，模拟延迟中</p>
      </div>
    );
  }

  // Error state
  if (generatePhase === "error" && generateResult) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-error-muted text-error border border-error/20">
            错误
          </span>
          <span className="font-mono text-xs text-text-secondary">{generateResult.jobId}</span>
        </div>

        <div className="p-4 bg-error-muted/50 rounded-md border border-error/20 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-error font-medium">
            <AlertCircle size={16} />
            {generateResult.error?.code ?? "UNKNOWN"}
          </div>
          <p className="text-xs text-text-secondary">{generateResult.error?.message ?? "生成过程中发生错误"}</p>
        </div>

        <div className="flex flex-col gap-2 text-sm bg-bg-sunken p-4 rounded-md border border-border-subtle">
          <div className="flex justify-between">
            <span className="text-text-tertiary">音色</span>
            <span className="text-text-primary">{generateResult.voice}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">格式</span>
            <span className="text-text-primary font-mono text-xs">{generateResult.format}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">字符数</span>
            <span className="text-text-primary">{generateResult.charCount}</span>
          </div>
        </div>

        <div className="flex gap-2">
          {lastRequest ? (
            <button
              className="flex-1 py-2 rounded-md bg-bg-surface hover:bg-bg-hover text-sm font-medium transition-colors border border-border flex items-center justify-center gap-1"
              onClick={() => {
                generate(lastRequest);
              }}
            >
              <RefreshCw size={14} /> 重试
            </button>
          ) : (
            <button
              className="flex-1 py-2 rounded-md bg-bg-surface text-sm font-medium transition-colors border border-border flex items-center justify-center gap-1 opacity-50 cursor-not-allowed"
              disabled
              title="无原始请求可重试，请返回输入区重新输入"
            >
              <RefreshCw size={14} /> 无原始请求
            </button>
          )}
          <button
            className="flex-1 py-2 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            onClick={resetGeneration}
          >
            返回
          </button>
        </div>

        {generateResult.isDemo && (
          <div className="text-[10px] text-text-tertiary text-center pt-2 border-t border-border-subtle">
            演示模式 -- 错误信息为模拟数据
          </div>
        )}
      </div>
    );
  }

  // Success state
  if (generatePhase === "success" && generateResult) {
    const handlePlay = () => {
      if (generateResult.audioUrl) {
        if (audioRef.current) {
          audioRef.current.pause();
        }
        const audio = new Audio(generateResult.audioUrl);
        audio.onended = () => setIsPlaying(false);
        audio.play();
        audioRef.current = audio;
        setIsPlaying(true);
      }
    };

    const handleDownload = () => {
      if (generateResult.audioUrl) {
        const a = document.createElement("a");
        a.href = generateResult.audioUrl;
        // Demo adapter produces WAV blobs; download extension matches actual format
        a.download = `${generateResult.jobId}.wav`;
        a.click();
      }
    };

    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-success-muted text-success border border-success/20">
            成功
          </span>
          <span className="font-mono text-xs text-text-secondary">{generateResult.jobId}</span>
        </div>

        <div className="flex items-center gap-1 text-xs text-text-tertiary">
          <Clock size={12} />
          <span>{new Date(generateResult.timestamp).toLocaleString("zh-CN")}</span>
          <span className="mx-1">|</span>
          <span>来源: 用户</span>
          <span className="mx-1">|</span>
          <span>耗时: {generateResult.duration}</span>
        </div>

        {/* Audio Player */}
        {generateResult.audioUrl && (
          <div className="p-4 bg-bg-surface rounded-lg border border-border flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <button
                className="w-8 h-8 rounded-full bg-accent text-bg-base flex items-center justify-center hover:bg-accent-hover transition-colors shrink-0"
                onClick={handlePlay}
              >
                <Play fill="currentColor" size={14} className="ml-0.5" />
              </button>
              <div className="flex-1 h-8 flex items-center gap-[2px]">
                {Array.from({ length: 30 }).map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 rounded-full transition-all ${isPlaying ? "bg-accent" : "bg-border"}`}
                    style={{ height: `${10 + Math.sin(i * 0.5) * 30 + Math.random() * 40}%` }}
                  />
                ))}
              </div>
              <span className="text-xs font-mono w-10 text-right">{generateResult.duration.replace("s", "")}</span>
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1"
                onClick={handleDownload}
              >
                <Download size={14} /> 下载
              </button>
            </div>
          </div>
        )}

        {/* Metadata */}
        <div className="flex flex-col gap-2 text-sm bg-bg-sunken p-4 rounded-md border border-border-subtle">
          <div className="flex justify-between">
            <span className="text-text-tertiary">音色</span>
            <span className="text-text-primary">{generateResult.voice}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">格式</span>
            <span className="text-text-primary font-mono text-xs">{generateResult.format}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">字符数</span>
            <span className="text-text-primary">{generateResult.charCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">预估成本</span>
            <span className="text-text-primary text-accent">{generateResult.estimatedCost}</span>
          </div>
        </div>

        {generateResult.isDemo && (
          <div className="text-[10px] text-warning text-center border-t border-border-subtle pt-3">
            演示音频，不代表真实模型输出。音频为本地生成的示意音波。
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ─── Voices Detail Panel ─────────────────────────────────────────────────────

function VoicesDetailPanel() {
  const { voices, adapter } = useAppState();
  const [selectedVoice, setSelectedVoice] = useState(voices[0]);
  const [probeStatus, setProbeStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [probeLatency, setProbeLatency] = useState("");

  const handleProbe = async () => {
    setProbeStatus("loading");
    const result = await adapter.probeVoice(selectedVoice.name);
    setProbeLatency(result.latency);
    setProbeStatus(result.status === "success" ? "success" : "error");
    setTimeout(() => setProbeStatus("idle"), 3000);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Voice selector */}
      <select
        className="bg-bg-sunken border border-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-border-focus"
        value={selectedVoice.name}
        onChange={(e) => {
          const v = voices.find((v) => v.name === e.target.value);
          if (v) setSelectedVoice(v);
        }}
      >
        {voices.map((v) => (
          <option key={v.name} value={v.name}>{v.name}</option>
        ))}
      </select>

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent text-lg font-semibold">
          {selectedVoice.name[0].toUpperCase()}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{selectedVoice.name}</h2>
            {selectedVoice.isDefault && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-bg-surface border border-border text-text-secondary">默认</span>
            )}
          </div>
          <div className={`text-xs flex items-center gap-1 mt-1 ${
            selectedVoice.status === "success" ? "text-success" :
            selectedVoice.status === "warning" ? "text-warning" : "text-error"
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${
              selectedVoice.status === "success" ? "bg-success" :
              selectedVoice.status === "warning" ? "bg-warning" : "bg-error"
            }`} />
            {selectedVoice.status === "success" ? "已验证" :
             selectedVoice.status === "warning" ? "待验证" : "验证失败"}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <div className="flex items-center py-1">
          <span className="w-20 text-text-tertiary">角色</span>
          <span className="text-text-primary">{selectedVoice.role}</span>
        </div>
        <div className="flex items-center py-1">
          <span className="w-20 text-text-tertiary">供应商</span>
          <span className="text-text-primary">{selectedVoice.provider}</span>
        </div>
        <div className="flex items-center py-1">
          <span className="w-20 text-text-tertiary">上次验证</span>
          <span className="text-text-primary">{selectedVoice.lastVerified}</span>
        </div>
        {selectedVoice.verifyDuration && (
          <div className="flex items-center py-1">
            <span className="w-20 text-text-tertiary">验证耗时</span>
            <span className="text-text-primary">{selectedVoice.verifyDuration}</span>
          </div>
        )}
      </div>

      {/* Probe status feedback */}
      {probeStatus !== "idle" && (
        <div className={`text-xs px-3 py-2 rounded-md border ${
          probeStatus === "loading" ? "bg-accent-muted border-accent/20 text-accent" :
          probeStatus === "success" ? "bg-success-muted border-success/20 text-success" :
          "bg-error-muted border-error/20 text-error"
        }`}>
          {probeStatus === "loading" ? "正在验证..." :
           probeStatus === "success" ? `验证成功，延迟 ${probeLatency}` :
           `验证失败${probeLatency ? `，${probeLatency}` : ""}`}
        </div>
      )}

      <div className="h-px w-full bg-border-subtle" />

      <div className="flex gap-2">
        <button
          className="flex-1 py-2 rounded-md bg-bg-surface hover:bg-bg-hover text-sm font-medium transition-colors border border-border disabled:opacity-50"
          onClick={handleProbe}
          disabled={probeStatus === "loading"}
        >
          探针验证
        </button>
        <button
          className="flex-1 py-2 rounded-md bg-accent text-bg-base text-sm font-medium hover:bg-accent-hover transition-colors shadow-shadow-glow"
          onClick={() => {
            const audio = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=");
            audio.play().catch(() => {});
          }}
        >
          试听样本
        </button>
      </div>

      <div className="text-[10px] text-text-tertiary text-center border-t border-border-subtle pt-3">
        演示模式 -- 探针验证为模拟返回
      </div>
    </div>
  );
}

// ─── History Preview Panel ───────────────────────────────────────────────────

function HistoryPreviewPanel() {
  const { historyRecords } = useAppState();
  const record = historyRecords.find((r) => r.status === "success") ?? historyRecords[0];

  if (!record) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-4">
        <p className="text-text-tertiary text-xs">暂无历史记录预览</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
            record.status === "success" ? "bg-success-muted text-success border border-success/20" : "bg-error-muted text-error border border-error/20"
          }`}>
            {record.status === "success" ? "成功" : "错误"}
          </span>
          <span className="font-mono text-xs text-text-secondary">{record.id}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs text-text-tertiary">
        <span>{record.date}</span>
        <span>来源: {record.source} {record.duration !== "0.0s" ? `| 耗时: ${record.duration}` : ""}</span>
      </div>

      {record.status === "success" && (
        <div className="p-4 bg-bg-surface rounded-lg border border-border flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button className="w-8 h-8 rounded-full bg-accent text-bg-base flex items-center justify-center hover:bg-accent-hover transition-colors shrink-0">
              <Play fill="currentColor" size={14} className="ml-0.5" />
            </button>
            <div className="flex-1 h-8 flex items-center gap-[2px]">
              {Array.from({ length: 20 }).map((_, i) => (
                <div key={i} className="flex-1 bg-border rounded-full" style={{ height: `${Math.max(10, Math.sin(i * 0.7) * 50 + Math.random() * 40)}%` }} />
              ))}
            </div>
            <span className="text-xs font-mono w-10 text-right">{record.duration.replace("s", "")}</span>
          </div>
          <div className="flex justify-end gap-2">
            <button className="text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1">
              <Download size={14} /> 下载 WAV (演示)
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 text-sm bg-bg-sunken p-4 rounded-md border border-border-subtle">
        <div className="flex justify-between">
          <span className="text-text-tertiary">音色</span>
          <span className="text-text-primary">{record.voice}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-tertiary">格式</span>
          <span className="text-text-primary font-mono text-xs">{record.format}</span>
        </div>
        {record.charCount !== undefined && (
          <div className="flex justify-between">
            <span className="text-text-tertiary">字符数</span>
            <span className="text-text-primary">{record.charCount}</span>
          </div>
        )}
        {record.cost && (
          <div className="flex justify-between">
            <span className="text-text-tertiary">预估成本</span>
            <span className="text-text-primary">{record.cost}</span>
          </div>
        )}
      </div>

      <button className="text-sm text-accent hover:text-accent-hover transition-colors w-full text-left">
        查看完整详情 →
      </button>

      <div className="text-[10px] text-text-tertiary text-center border-t border-border-subtle pt-3">
        演示模式 -- 历史记录为模拟演示数据
      </div>
    </div>
  );
}

// ─── Panel Router ────────────────────────────────────────────────────────────

function PanelContent({ path }: { path: string }) {
  if (path.includes("/director")) {
    return <DirectorPreview />;
  }

  if (path.includes("/voices")) {
    return <VoicesDetailPanel />;
  }

  if (path.includes("/history")) {
    return <HistoryPreviewPanel />;
  }

  // Default: Generate output panel
  return <GenerateOutputPanel />;
}
