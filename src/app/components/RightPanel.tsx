import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, Link } from "react-router";
import { X, Play, Download, Loader2, PlayCircle, AlertCircle, RefreshCw, Clock, Settings, CheckCircle2 } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { VoiceProfile } from "../types";
import { AgentAutomationPanel } from "./tasks/AgentAutomationPanel";
import { useTaskWorkspaceUi } from "../context/TaskWorkspaceUiContext";
import { formatVoiceCompactLabel, formatVoiceOptionLabel, getVoiceDisplayMeta } from "../utils/voiceDisplay";
import { PromptTextBlock } from "./PromptTextBlock";

function displaySpeakerLabel(label: string): string {
  const match = label.match(/^Speaker\s+([A-Z])$/i);
  return match ? `说话者 ${match[1].toUpperCase()}` : label;
}

interface RightPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function RightPanel({ isOpen, onClose }: RightPanelProps) {
  const location = useLocation();
  const isTaskWorkspace = /^\/tasks\/[^/]+$/.test(location.pathname);

  if (!isOpen) return null;

  return (
    <div className="w-full h-full min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div className="h-12 min-w-0 px-4 flex items-center justify-between gap-3 border-b border-border-subtle shrink-0">
        <h3 className="min-w-0 truncate font-semibold text-sm">
          {isTaskWorkspace ? "Agent 自动化"
            : location.pathname.includes("/voices") ? "音色详情"
            : location.pathname.includes("/history") ? "记录预览"
            : location.pathname.includes("/director") ? "提示词预览"
            : "生成输出"}
        </h3>
        <button
          onClick={onClose}
          className="shrink-0 p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          aria-label="关闭 Agent 面板"
        >
          <X size={16} />
        </button>
      </div>

      <div className={`flex-1 min-w-0 min-h-0 ${isTaskWorkspace ? "overflow-hidden p-0" : "overflow-y-auto overflow-x-hidden p-5"}`}>
        <PanelContent path={location.pathname} />
      </div>
    </div>
  );
}

// ─── Director Prompt Preview ──────────────────────────────────────────────────

function DirectorPreview() {
  const { assembleResult, assemblePhase } = useAppState();

  // Show assemble result if available
  const assembleSuccess = assembleResult?.phase === "success" && assembleResult.response?.ok
    ? (assembleResult.response as import("../types").AssemblePromptSuccess)
    : null;

  const assembleError = assembleResult?.phase === "error"
    ? assembleResult.error
    : null;

  // Idle / no result state
  if (assemblePhase === "idle" || !assembleResult) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">提示词预览</span>
        </div>
        <PromptTextBlock minHeightClass="min-h-[200px]" maxHeightClass="max-h-[60vh]">
          // 在导演模式页面点击「组装提示词」后，组装结果将在此处展示
        </PromptTextBlock>
        <div className="text-[10px] text-text-tertiary text-center border-t border-border-subtle pt-3 mt-2">
          组装提示词不会消耗 API 额度
        </div>
      </div>
    );
  }

  // Loading state
  if (assemblePhase === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">提示词预览</span>
        </div>
        <div className="bg-bg-sunken p-4 rounded-md border border-accent/20 font-mono text-xs text-accent min-h-[200px] flex items-center justify-center">
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            正在组装提示词...
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (assembleError) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">提示词预览</span>
        </div>
        <div className="bg-error-muted/50 p-4 rounded-md border border-error/20 text-xs text-error">
          <div className="font-medium mb-1">{assembleError.code}</div>
          <div>{assembleError.message}</div>
        </div>
      </div>
    );
  }

  // Success state
  if (assembleSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">组装结果</span>
          <span className="text-xs text-success flex items-center gap-1">
            <CheckCircle2 size={12} /> 成功
          </span>
        </div>

        {/* Warnings */}
        {assembleSuccess.warnings.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {assembleSuccess.warnings.map((w, i) => (
              <div key={i} className={`flex items-start gap-1.5 text-[10px] px-2 py-1.5 rounded ${
                w.code === "LEGACY_VOICE_ALIAS"
                  ? "bg-warning-muted text-warning"
                  : "bg-accent-muted text-accent"
              }`}>
                <AlertCircle size={10} className="shrink-0 mt-0.5" />
                <span>{w.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* Prompt preview */}
        <PromptTextBlock minHeightClass="min-h-[120px]" maxHeightClass="max-h-[50vh]">
          {assembleSuccess.prompt}
        </PromptTextBlock>

        {/* Speaker summary */}
        {assembleSuccess.normalized.speakers.length > 0 && (
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-text-tertiary">说话者规范化:</span>
            {assembleSuccess.normalized.speakers.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-text-secondary">
                <span className="font-medium text-text-primary">{displaySpeakerLabel(s.label)}</span>
                <span className="font-mono text-accent">{s.voice}</span>
                {s.wasLegacyAlias && (
                  <span className="text-warning text-[10px]">（旧别名已映射）</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-text-tertiary">
          <span>{assembleSuccess.prompt.length} 字符</span>
          <span>不消耗额度</span>
        </div>

        <div className="text-[10px] text-text-tertiary text-center border-t border-border-subtle pt-3 mt-2">
          提示词由后端 /api/prompts/assemble 生成
        </div>
      </div>
    );
  }

  return null;
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
        <p className="text-text-tertiary text-xs mt-1">请等待后端响应</p>
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
          {generateResult.error?.code === "MISSING_API_KEY" && (
            <Link
              to="/settings"
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-surface border border-border text-xs font-medium text-accent hover:bg-bg-hover transition-colors w-fit"
            >
              <Settings size={12} />
              前往设置页配置 OpenRouter API Key
            </Link>
          )}
        </div>

        <div className="flex flex-col gap-2 text-sm bg-bg-sunken p-4 rounded-md border border-border-subtle">
          <div className="flex justify-between">
            <span className="text-text-tertiary">音色</span>
            <span className="text-text-primary">{formatVoiceCompactLabel(generateResult.voice)}</span>
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
        a.download = `${generateResult.jobId}.${generateResult.format}`;
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
                {isPlaying ? <span className="text-xs">||</span> : <Play fill="currentColor" size={14} className="ml-0.5" />}
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
                <Download size={14} /> 下载 {generateResult.format.toUpperCase()}
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
      </div>
    );
  }

  return null;
}

// ─── Voices Detail Panel ─────────────────────────────────────────────────────

function VoicesDetailPanel() {
  const { voices, adapter, voicesLoading, voicesError, voicesLoaded, refreshVoices } = useAppState();
  const [selectedVoice, setSelectedVoice] = useState<VoiceProfile | null>(voices[0] ?? null);
  const [probeStatus, setProbeStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [probeLatency, setProbeLatency] = useState("");
  const [probeError, setProbeError] = useState<string | null>(null);

  // Sync selectedVoice when voices populate after initial empty state
  useEffect(() => {
    if (!selectedVoice && voices.length > 0) {
      setSelectedVoice(voices[0]);
    }
  }, [voices, selectedVoice]);

  // If selectedVoice was removed from the list (e.g. after a refresh that returns different data),
  // fall back to the first available voice
  useEffect(() => {
    if (selectedVoice && voices.length > 0 && !voices.some((v) => v.name === selectedVoice.name)) {
      setSelectedVoice(voices[0]);
    }
  }, [voices, selectedVoice]);

  const handleProbe = async () => {
    if (!selectedVoice) return;
    setProbeStatus("loading");
    setProbeError(null);
    const result = await adapter.probeVoice(selectedVoice.name);
    setProbeLatency(result.latency);
    if (result.status === "success") {
      setProbeStatus("success");
    } else {
      setProbeStatus("error");
      setProbeError(result.error || null);
    }
    setTimeout(() => setProbeStatus("idle"), 3000);
  };

  // --- Loading: first-time fetch, no data yet ---
  if (voicesLoading && voices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Loader2 size={20} className="animate-spin text-text-tertiary mb-3" />
        <p className="text-text-tertiary text-xs">正在加载音色列表...</p>
      </div>
    );
  }

  // --- Error: fetch failed and no fallback data ---
  if (voicesError && voices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <AlertCircle size={20} className="text-error mb-3" />
        <p className="text-error text-xs font-medium">加载音色列表失败</p>
        <p className="text-text-tertiary text-[10px] mt-1">{voicesError}</p>
        <button
          className="mt-3 flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-bg-surface border border-border hover:bg-bg-hover transition-colors"
          onClick={refreshVoices}
        >
          <RefreshCw size={12} /> 重试
        </button>
      </div>
    );
  }

  // --- Empty: successful fetch returned empty list ---
  if (voicesLoaded && voices.length === 0 && !voicesError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <p className="text-text-tertiary text-xs">没有可用的音色</p>
        <p className="text-text-tertiary text-[10px] mt-1">后端返回空列表</p>
      </div>
    );
  }

  // --- No selected voice (should not happen with sync effects above, but defensive) ---
  if (!selectedVoice) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <p className="text-text-tertiary text-xs">请选择一个音色</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Inline error banner when stale data is visible */}
      {voicesError && voices.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-error-muted/50 border border-error/20 text-xs">
          <AlertCircle size={12} className="text-error shrink-0" />
          <span className="text-error text-[10px]">刷新失败: {voicesError}</span>
          <button
            className="ml-auto flex items-center gap-1 text-[10px] text-text-secondary hover:text-text-primary transition-colors"
            onClick={refreshVoices}
          >
            <RefreshCw size={10} /> 重试
          </button>
        </div>
      )}

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
          <option key={v.name} value={v.name}>{formatVoiceOptionLabel(v.name, v.role)}</option>
        ))}
      </select>

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent text-lg font-semibold">
          {selectedVoice.name[0].toUpperCase()}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{formatVoiceCompactLabel(selectedVoice.name)}</h2>
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
          <span className="text-text-primary">{getVoiceDisplayMeta(selectedVoice.name).toneDescription || selectedVoice.role}</span>
        </div>
        <div className="flex items-center py-1">
          <span className="w-20 text-text-tertiary">英文名</span>
          <span className="text-text-primary font-mono text-xs">{selectedVoice.name}</span>
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
           `验证失败${probeError === "MISSING_API_KEY" ? ": 未配置 API Key" : ""}`}
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
        探针结果来自后端真实验证
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
                <Download size={14} /> 下载音频
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 text-sm bg-bg-sunken p-4 rounded-md border border-border-subtle">
        <div className="flex justify-between">
          <span className="text-text-tertiary">音色</span>
          <span className="text-text-primary">{formatVoiceCompactLabel(record.voice)}</span>
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
        数据来自后端持久化存储
      </div>
    </div>
  );
}

// ─── Panel Router ────────────────────────────────────────────────────────────

function PanelContent({ path }: { path: string }) {
  const taskWorkspaceMatch = path.match(/^\/tasks\/([^/]+)$/);
  if (taskWorkspaceMatch) {
    return <TaskWorkspaceAgentPanel taskId={decodeURIComponent(taskWorkspaceMatch[1])} />;
  }

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

function TaskWorkspaceAgentPanel({ taskId }: { taskId: string }) {
  const workspace = useTaskWorkspaceUi();
  return (
    <AgentAutomationPanel
      taskId={taskId}
      lines={workspace.lines}
      selectedLineIds={workspace.selectedLineIds}
      productionVersion={workspace.productionVersion}
      validationSummary={workspace.validationSummary}
      onProductionListChanged={async () => {
        await workspace.refreshProduction?.();
        await workspace.refreshProfiles?.();
      }}
    />
  );
}
