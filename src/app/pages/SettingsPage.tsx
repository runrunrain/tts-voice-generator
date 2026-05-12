import { useState, useCallback, useEffect, useRef } from "react";
import { Eye, EyeOff, RefreshCw, Loader2, Shield, Copy, Check, Trash2, AlertTriangle, ChevronDown, ChevronRight, Activity, Database, FolderOpen, Route, Clock, Bot, FileAudio } from "lucide-react";
import { useAppState } from "../state/AppContext";
import { apiRequest, getDiagnostics } from "../services/httpAdapter";
import { hasSavedOpenRouterKey, isSuccessfulSettingsConnection } from "../services/settingsKeyStatus";
import type { AppSettings, AudioFormat, ConnectionStatus, AgentAuthMode, Diagnostics, DiagnosticsPhase, AudioDirInfo } from "../types";

type SettingsConnectionTestResponse = {
  ok?: boolean;
  authValid?: boolean;
  checkedEndpoint?: string;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  providerMessage?: string;
  actionMessage?: string;
  error?: string | null;
};

function formatSettingsConnectionFailure(data: SettingsConnectionTestResponse): string {
  if (data.errorCode === "MISSING_API_KEY" || data.error === "MISSING_API_KEY") {
    return "未配置 OpenRouter API Key，请先保存 Key 后再测试音频认证。";
  }
  if (data.errorCode === "INVALID_API_KEY") {
    const providerMessage = data.providerMessage ? ` Provider 返回：${data.providerMessage}` : "";
    return `${data.errorMessage || "OpenRouter API Key 无效、已过期或账户不可用。"}${data.actionMessage ? ` ${data.actionMessage}` : " 请更新 API Key，并检查 OpenRouter 账户状态/余额。"}${providerMessage}`;
  }
  const message = data.errorMessage || data.actionMessage || data.error || "连接测试失败，请检查 API Key、账户状态和 OpenRouter 服务。";
  const providerMessage = data.providerMessage ? ` Provider 返回：${data.providerMessage}` : "";
  return `${message}${providerMessage}`;
}

export function SettingsPage() {
  const { settings, saveSettings, rotateLocalPluginToken, clearLocalPluginToken } = useAppState();

  // Local form state (synced on save)
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel);
  const [defaultVoice, setDefaultVoice] = useState(settings.defaultVoice);
  const [defaultFormat, setDefaultFormat] = useState<AudioFormat>(settings.defaultFormat);
  const [audioDir, setAudioDir] = useState(settings.audioDir);
  const [maxChars, setMaxChars] = useState(settings.maxChars);
  const [maxConcurrent, setMaxConcurrent] = useState(settings.maxConcurrent);

  // Agent form state
  const [agentAuthMode, setAgentAuthMode] = useState<AgentAuthMode>(settings.agent.authMode);
  const [agentMaxRequests, setAgentMaxRequests] = useState(settings.agent.maxRequests);
  const [agentMaxChars, setAgentMaxChars] = useState(settings.agent.maxChars);
  const [agentMaxCost, setAgentMaxCost] = useState(settings.agent.maxCost);
  const [agentSessionExpiry, setAgentSessionExpiry] = useState(settings.agent.sessionExpiry);

  // Token state
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenRotating, setTokenRotating] = useState(false);
  const [tokenClearing, setTokenClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Sync form when settings load from backend
  useEffect(() => {
    setDefaultModel(settings.defaultModel);
    setDefaultVoice(settings.defaultVoice);
    setDefaultFormat(settings.defaultFormat);
    setAudioDir(settings.audioDir);
    setMaxChars(settings.maxChars);
    setMaxConcurrent(settings.maxConcurrent);
    // Any non-empty sentinel or masked value means the backend has a saved key.
    setApiKeyMasked(hasSavedOpenRouterKey(settings.openRouterApiKey));
    // Sync agent fields
    setAgentAuthMode(settings.agent.authMode);
    setAgentMaxRequests(settings.agent.maxRequests);
    setAgentMaxChars(settings.agent.maxChars);
    setAgentMaxCost(settings.agent.maxCost);
    setAgentSessionExpiry(settings.agent.sessionExpiry);
  }, [settings.defaultModel, settings.defaultVoice, settings.defaultFormat, settings.audioDir, settings.maxChars, settings.maxConcurrent, settings.openRouterApiKey, settings.agent]);

  // Save feedback
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(settings.connectionStatus);
  const [connectionLatency, setConnectionLatency] = useState<number | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionErrorCode, setConnectionErrorCode] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaveStatus("saving");
    setSaveErrorMessage(null);

    const payload: Partial<AppSettings> = {
      openRouterApiKey: apiKey.trim() || undefined,
      defaultModel,
      defaultVoice,
      defaultFormat,
      audioDir,
      maxChars,
      maxConcurrent,
      agent: {
        authMode: agentAuthMode,
        maxRequests: agentMaxRequests,
        maxChars: agentMaxChars,
        maxCost: agentMaxCost,
        sessionExpiry: agentSessionExpiry,
        hasLocalPluginToken: settings.agent.hasLocalPluginToken,
        localPluginTokenFingerprint: settings.agent.localPluginTokenFingerprint,
      },
    };

    try {
      await saveSettings(payload);

      // If a new key was just saved, clear the plaintext from local state
      if (apiKey.trim()) {
        setApiKey("");
        setApiKeyMasked(true);
      } else {
        try {
          const res = await apiRequest("/api/settings");
          const data = await res.json();
          setApiKeyMasked(!!data.hasOpenRouterApiKey || hasSavedOpenRouterKey(data.keyMask) || hasSavedOpenRouterKey(data.openRouterApiKey));
        } catch {
          setApiKeyMasked(false);
        }
      }

      setConnectionStatus("untested");
      setConnectionLatency(null);
      setConnectionErrorCode(null);
      setConnectionMessage(apiKey.trim()
        ? "API Key 已保存；请点击测试连接验证音频生成认证是否通过。"
        : "设置已保存；连接状态尚未测试。"
      );
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      setSaveStatus("error");
      setSaveErrorMessage(err instanceof Error ? err.message : "保存设置时发生未知错误");
    }
  }, [apiKey, defaultModel, defaultVoice, defaultFormat, audioDir, maxChars, maxConcurrent, agentAuthMode, agentMaxRequests, agentMaxChars, agentMaxCost, agentSessionExpiry, saveSettings, settings.agent]);

  const handleTestConnection = useCallback(async () => {
    setConnectionStatus("testing");
    setConnectionLatency(null);
    setConnectionMessage("正在通过 OpenRouter 音频生成认证端点测试当前 Key...");
    setConnectionErrorCode(null);
    try {
      const res = await apiRequest("/api/settings/test", { method: "POST" });
      const data = await res.json() as SettingsConnectionTestResponse;
      if (data.error === "MISSING_API_KEY" || data.errorCode === "MISSING_API_KEY") {
        setConnectionStatus("failed");
        setConnectionErrorCode("MISSING_API_KEY");
        setConnectionMessage(formatSettingsConnectionFailure(data));
      } else if (isSuccessfulSettingsConnection(data)) {
        setConnectionStatus("connected");
        setConnectionLatency(data.latencyMs ?? null);
        setConnectionMessage("连接测试通过：当前 Key 已通过 OpenRouter 音频生成认证端点验证，可用于真实音频生成。已保存 Key 与连接测试通过是两个独立状态。");
      } else {
        setConnectionStatus("failed");
        setConnectionErrorCode(data.errorCode ?? null);
        setConnectionMessage(formatSettingsConnectionFailure(data));
      }
    } catch (err) {
      setConnectionStatus("failed");
      setConnectionErrorCode("NETWORK_ERROR");
      setConnectionMessage(err instanceof Error ? `连接测试请求失败：${err.message}` : "连接测试请求失败，请确认后端服务可用。");
    }
  }, []);

  // Token rotation: returns plaintext token shown once in component-local memory
  const handleRotateToken = useCallback(async () => {
    setTokenRotating(true);
    setRotatedToken(null);
    setTokenCopied(false);
    setTokenError(null);
    try {
      const token = await rotateLocalPluginToken();
      if (token) {
        setRotatedToken(token);
      } else {
        setTokenError("Token 轮换成功但未返回新 Token，请重试");
      }
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Token 轮换失败");
    } finally {
      setTokenRotating(false);
    }
  }, [rotateLocalPluginToken]);

  const handleClearToken = useCallback(async () => {
    setTokenClearing(true);
    setShowClearConfirm(false);
    setRotatedToken(null);
    setTokenError(null);
    try {
      await clearLocalPluginToken();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Token 清除失败");
    } finally {
      setTokenClearing(false);
    }
  }, [clearLocalPluginToken]);

  const handleCopyToken = useCallback(async () => {
    if (!rotatedToken) return;
    try {
      await navigator.clipboard.writeText(rotatedToken);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 3000);
    } catch {
      // ignore
    }
  }, [rotatedToken]);

  const hasToken = settings.agent.hasLocalPluginToken;
  const fingerprint = settings.agent.localPluginTokenFingerprint;

  // ── Diagnostics State ────────────────────────────────────────────────────
  const [diagExpanded, setDiagExpanded] = useState(false);
  const [diagPhase, setDiagPhase] = useState<DiagnosticsPhase>("idle");
  const [diagData, setDiagData] = useState<Diagnostics | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [diagCopied, setDiagCopied] = useState<"idle" | "success" | "failed">("idle");
  const diagRequestIdRef = useRef(0);

  const loadDiagnostics = useCallback(() => {
    const requestId = ++diagRequestIdRef.current;
    setDiagPhase("loading");
    setDiagError(null);

    getDiagnostics()
      .then((data) => {
        if (requestId !== diagRequestIdRef.current) return;
        setDiagData(data);
        setDiagPhase("success");
      })
      .catch((err) => {
        if (requestId !== diagRequestIdRef.current) return;
        setDiagData(null);
        setDiagPhase("error");
        setDiagError(err instanceof Error ? err.message : "无法获取诊断数据");
      });
  }, []);

  // Auto-load when panel expands
  useEffect(() => {
    if (diagExpanded && diagPhase === "idle") {
      loadDiagnostics();
    }
  }, [diagExpanded, diagPhase, loadDiagnostics]);

  const handleCopyDiagnostics = useCallback(async () => {
    if (!diagData) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagData, null, 2));
      setDiagCopied("success");
    } catch {
      setDiagCopied("failed");
    }
    setTimeout(() => setDiagCopied("idle"), 2500);
  }, [diagData]);

  const formatUptime = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  /** Format audioDir for display: handles both string and AudioDirInfo object */
  const formatAudioDir = (audioDir: string | AudioDirInfo | undefined): string => {
    if (!audioDir) return "unknown";
    if (typeof audioDir === "string") return audioDir;
    const info = audioDir as AudioDirInfo;
    const sizeStr = info.totalSizeBytes > 0
      ? ` | ${(info.totalSizeBytes / 1024 / 1024).toFixed(1)} MB`
      : "";
    const countStr = info.fileCount > 0 ? ` | ${info.fileCount} files` : "";
    return `${info.path}${countStr}${sizeStr}`;
  };

  /** Safe check field access: diagData.checks is already adapted by httpAdapter,
   *  but we use optional chaining as final defense */
  const checks = diagData?.checks;
  const failedJobs = diagData?.recentFailedJobs ?? [];
  const agentActions = diagData?.recentAgentActions ?? [];
  const recentJobs = diagData?.recentJobs ?? [];

  return (
    <div className="flex flex-col h-full bg-bg-base overflow-y-auto">
      <div className="max-w-[1848px] w-full mx-auto p-8 flex flex-col gap-8">

        <div className="h-12 shrink-0">
          <h2 className="text-2xl font-bold font-display text-text-primary">设置</h2>
        </div>

        <div className="flex gap-8 items-start">

          {/* Left Column */}
          <div className="flex-1 max-w-[640px] flex flex-col gap-6">

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">API Key 配置</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">OpenRouter API Key</label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => { setApiKey(e.target.value); setApiKeyMasked(false); }}
                        placeholder={apiKeyMasked ? "Key 已配置（已安全存储在后端）" : "在此输入 API Key..."}
                        className="w-full bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary placeholder:text-text-tertiary"
                      />
                      <button
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <button
                      className="px-4 py-2 bg-bg-base border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
                      onClick={handleTestConnection}
                      disabled={connectionStatus === "testing"}
                    >
                      {connectionStatus === "testing" ? <Loader2 size={14} className="animate-spin inline" /> : "测试连接"}
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary mt-1">
                    <Shield size={12} />
                    <span>API Key 由后端安全存储，前端不会保存明文 Key。保存后 Key 将被遮蔽显示。</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-text-tertiary">状态:</span>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                    connectionStatus === "connected"
                      ? "bg-success-muted text-success border-success/20"
                      : connectionStatus === "testing"
                      ? "bg-accent-muted text-accent border-accent/20"
                      : connectionStatus === "failed"
                      ? "bg-error-muted text-error border-error/20"
                      : "bg-bg-sunken text-text-tertiary border-border"
                  }`}>
                    {connectionStatus === "connected" ? `连接测试通过${connectionLatency ? ` (${connectionLatency}ms)` : ""}` :
                      connectionStatus === "testing" ? "测试中..." :
                     connectionStatus === "failed" ? `连接测试失败${connectionErrorCode ? ` (${connectionErrorCode})` : ""}` :
                     apiKeyMasked ? "已保存 Key（未验证连接）" : "未配置"}
                  </span>
                </div>
                {connectionMessage && (
                  <div className={`border rounded-md p-3 text-xs leading-5 ${
                    connectionStatus === "connected"
                      ? "border-success/30 bg-success-muted/10 text-success"
                      : connectionStatus === "failed"
                      ? "border-error/30 bg-error-muted/20 text-error"
                      : "border-border bg-bg-sunken text-text-tertiary"
                  }`}>
                    {connectionMessage}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">默认参数</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">默认模型:</label>
                  <select
                    className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus text-text-primary"
                    value={defaultModel}
                    onChange={(e) => setDefaultModel(e.target.value)}
                  >
                    <option value="google/gemini-3.1-flash-tts-preview">gemini-3.1-flash-tts</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">默认音色:</label>
                  <input
                    type="text"
                    className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus text-text-primary"
                    value={defaultVoice}
                    onChange={(e) => setDefaultVoice(e.target.value)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">默认格式:</label>
                  <div className="flex-1 flex gap-4">
                    <label className="flex items-center gap-2 text-sm cursor-pointer text-text-primary">
                      <input
                        type="radio"
                        name="format"
                        checked={defaultFormat === "wav"}
                        onChange={() => setDefaultFormat("wav")}
                        className="accent-accent"
                      /> WAV (推荐)
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer text-text-primary">
                      <input
                        type="radio"
                        name="format"
                        checked={defaultFormat === "pcm"}
                        onChange={() => setDefaultFormat("pcm")}
                        className="accent-accent"
                      /> PCM (raw)
                    </label>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-text-secondary w-32">音频目录:</label>
                  <input
                    type="text"
                    value={audioDir}
                    onChange={(e) => setAudioDir(e.target.value)}
                    className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                  />
                </div>
              </div>
            </div>

          </div>

          {/* Right Column */}
          <div className="flex-1 flex flex-col gap-6">

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">请求限制</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">单次最大字符数</label>
                  <input
                    type="number"
                    value={maxChars}
                    onChange={(e) => setMaxChars(Number(e.target.value))}
                    className="w-full bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">最大并发请求数</label>
                  <input
                    type="number"
                    value={maxConcurrent}
                    onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                    className="w-full bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">插件 Token</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">本地 Plugin Token</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={hasToken && fingerprint ? fingerprint : "未配置"}
                      className={`flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none font-mono ${
                        hasToken ? "text-text-secondary" : "text-text-tertiary"
                      }`}
                    />
                    <button
                      className="px-3 py-2 bg-bg-base border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors flex items-center gap-2 disabled:opacity-50"
                      onClick={handleRotateToken}
                      disabled={tokenRotating}
                    >
                      {tokenRotating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                      {hasToken ? "轮换" : "生成"}
                    </button>
                  </div>
                </div>

                {/* One-time plaintext token display after rotation */}
                {rotatedToken && (
                  <div className="border border-accent/30 rounded-md bg-accent-muted/20 p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-accent font-medium">
                      <AlertTriangle size={12} />
                      <span>Token 仅显示一次，关闭后无法再次查看。请立即复制并安全保存。</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-bg-base border border-border rounded px-3 py-2 text-xs font-mono text-text-primary break-all select-all">
                        {rotatedToken}
                      </code>
                      <button
                        className="shrink-0 px-3 py-2 border border-border rounded-md text-xs font-medium hover:bg-bg-hover transition-colors flex items-center gap-1.5"
                        onClick={handleCopyToken}
                      >
                        {tokenCopied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                        {tokenCopied ? "已复制" : "复制"}
                      </button>
                    </div>
                  </div>
                )}

                {tokenError && (
                  <div className="border border-error/30 rounded-md bg-error-muted/20 p-3 flex items-center gap-1.5 text-xs text-error font-medium">
                    <AlertTriangle size={12} />
                    <span>{tokenError}</span>
                  </div>
                )}

                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-text-tertiary">状态:</span>
                    <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                      hasToken
                        ? "bg-success-muted text-success border-success/20"
                        : "bg-bg-sunken text-text-tertiary border-border"
                    }`}>
                      {hasToken ? `已配置 (${fingerprint})` : "未配置"}
                    </span>
                  </div>
                  {hasToken && !showClearConfirm && (
                    <button
                      className="text-xs text-error hover:text-error/80 transition-colors flex items-center gap-1"
                      onClick={() => setShowClearConfirm(true)}
                      disabled={tokenClearing}
                    >
                      <Trash2 size={12} /> 清空 Token
                    </button>
                  )}
                  {showClearConfirm && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-error">确认清空?</span>
                      <button
                        className="px-2 py-1 bg-error text-bg-base rounded font-medium hover:bg-error/80 transition-colors"
                        onClick={handleClearToken}
                        disabled={tokenClearing}
                      >
                        {tokenClearing ? <Loader2 size={10} className="animate-spin" /> : "确认"}
                      </button>
                      <button
                        className="px-2 py-1 border border-border rounded font-medium hover:bg-bg-hover transition-colors"
                        onClick={() => setShowClearConfirm(false)}
                      >
                        取消
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* Agent Auth (Full Width) */}
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Agent 授权</h3>
          <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-6">

            <div className="flex items-center gap-6">
              <label className="text-sm text-text-secondary w-20">授权模式:</label>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm cursor-pointer text-text-primary">
                  <input
                    type="radio"
                    name="auth"
                    checked={agentAuthMode === "confirm_each"}
                    onChange={() => setAgentAuthMode("confirm_each")}
                    className="accent-accent"
                  /> 每次确认
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer text-text-primary">
                  <input
                    type="radio"
                    name="auth"
                    checked={agentAuthMode === "session_auto"}
                    onChange={() => setAgentAuthMode("session_auto")}
                    className="accent-accent"
                  /> 会话自动批准
                </label>
              </div>
            </div>

            <div className="border border-border-subtle rounded-md bg-bg-sunken p-4 flex flex-col gap-4">
              <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">会话限制 (Session Limits)</h4>

              <div className="grid grid-cols-4 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大请求数</label>
                  <input
                    type="number"
                    value={agentMaxRequests}
                    onChange={(e) => setAgentMaxRequests(Number(e.target.value))}
                    min={1}
                    max={1000}
                    className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大字符数</label>
                  <input
                    type="number"
                    value={agentMaxChars}
                    onChange={(e) => setAgentMaxChars(Number(e.target.value))}
                    min={1}
                    max={500000}
                    className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大费用</label>
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      value={agentMaxCost}
                      onChange={(e) => setAgentMaxCost(Number(e.target.value))}
                      min={0}
                      max={100}
                      className="w-full bg-bg-base border border-border rounded px-2 py-1 pl-5 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">过期时间 (秒)</label>
                  <input
                    type="number"
                    value={agentSessionExpiry}
                    onChange={(e) => setAgentSessionExpiry(Number(e.target.value))}
                    min={60}
                    max={604800}
                    className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono text-text-primary"
                  />
                </div>
              </div>

              <div className="h-px bg-border-subtle my-2" />

              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-text-tertiary">Plugin Token:</span>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                    hasToken
                      ? "bg-success-muted text-success border-success/20"
                      : "bg-bg-sunken text-text-tertiary border-border"
                  }`}>
                    {hasToken ? `已配置` : "未配置"}
                  </span>
                </div>

                <div className="flex items-center gap-4">
                  <span className="text-xs text-text-tertiary">
                    授权模式: {agentAuthMode === "confirm_each" ? "每次确认" : "会话自动批准"}
                  </span>
                </div>
              </div>

            </div>

          </div>
        </div>

        {/* ── System Diagnostics Panel (Full Width, Collapsible) ─────────── */}
        <div className="flex flex-col gap-3">
          <button
            className="flex items-center gap-2 text-sm font-semibold text-text-primary hover:text-accent transition-colors group"
            onClick={() => setDiagExpanded(!diagExpanded)}
          >
            {diagExpanded ? <ChevronDown size={16} className="text-text-tertiary group-hover:text-accent transition-colors" /> : <ChevronRight size={16} className="text-text-tertiary group-hover:text-accent transition-colors" />}
            <Activity size={16} className="text-accent" />
            系统诊断
          </button>

          {diagExpanded && (
            <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-5">

              {/* Toolbar: refresh + copy */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 bg-bg-base border border-border rounded-md text-xs font-medium hover:bg-bg-hover transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    onClick={loadDiagnostics}
                    disabled={diagPhase === "loading"}
                  >
                    {diagPhase === "loading" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    刷新
                  </button>
                  <button
                    className="px-3 py-1.5 bg-bg-base border border-border rounded-md text-xs font-medium hover:bg-bg-hover transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    onClick={handleCopyDiagnostics}
                    disabled={!diagData}
                  >
                    {diagCopied === "success" ? <Check size={12} className="text-success" /> : diagCopied === "failed" ? <AlertTriangle size={12} className="text-error" /> : <Copy size={12} />}
                    {diagCopied === "success" ? "已复制" : diagCopied === "failed" ? "复制失败" : "复制 JSON"}
                  </button>
                </div>
                {diagData && (
                  <span className="text-[10px] text-text-tertiary font-mono">
                    {diagData.version} | {formatUptime(diagData.uptime)} | {new Date(diagData.timestamp).toLocaleString("zh-CN")}
                  </span>
                )}
              </div>

              {/* Loading State */}
              {diagPhase === "loading" && (
                <div className="flex items-center justify-center py-12 gap-3 text-text-tertiary">
                  <Loader2 size={20} className="animate-spin" />
                  <span className="text-sm">正在加载诊断数据...</span>
                </div>
              )}

              {/* Error State */}
              {diagPhase === "error" && (
                <div className="border border-error/30 rounded-md bg-error-muted/20 p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 text-sm text-error font-medium">
                    <AlertTriangle size={14} />
                    诊断数据加载失败
                  </div>
                  <p className="text-xs text-error/80">{diagError}</p>
                  <p className="text-[10px] text-text-tertiary">请确认后端服务已启动并实现了 GET /api/diagnostics 接口</p>
                </div>
              )}

              {/* Success / Data State */}
              {diagPhase === "success" && diagData && (
                <>
                  {/* Health Checks Grid */}
                  <div className="grid grid-cols-4 gap-3">
                    <CheckItem icon={<Shield size={14} />} label="API Key" ok={checks?.keyConfigured ?? false} okText="已配置" failText="未配置" />
                    <CheckItem icon={<Database size={14} />} label="数据库" ok={checks?.dbOk ?? false} okText="正常" failText="异常" />
                    <CheckItem icon={<FolderOpen size={14} />} label="音频目录" ok={checks?.audioDirWritable ?? false} okText="可写" failText="不可写" />
                    <CheckItem icon={<Route size={14} />} label="路由" ok={checks?.routesReady ?? false} okText="就绪" failText="未就绪" />
                  </div>

                  {/* Overall status + audio dir */}
                  <div className="flex items-center gap-4 text-xs">
                    <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                      diagData.status === "healthy" || diagData.status === "ok"
                        ? "bg-success-muted text-success border-success/20"
                        : diagData.status === "degraded"
                        ? "bg-warning-muted text-warning border-warning/20"
                        : "bg-error-muted text-error border-error/20"
                    }`}>
                      {diagData.status === "healthy" || diagData.status === "ok" ? "健康" : diagData.status === "degraded" ? "降级" : diagData.status}
                    </span>
                    <span className="text-text-tertiary font-mono">音频目录: {formatAudioDir(diagData?.audioDir)}</span>
                  </div>

                  {/* Sub-tables: three columns */}
                  <div className="grid grid-cols-3 gap-4">

                    {/* Recent Failed Jobs */}
                    <div className="flex flex-col gap-2">
                      <h4 className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                        <AlertTriangle size={12} className="text-warning" />
                        最近失败任务
                      </h4>
                      <div className="border border-border-subtle rounded-md bg-bg-sunken p-3 min-h-[120px]">
                        {failedJobs.length === 0 ? (
                          <p className="text-[10px] text-text-tertiary py-4 text-center">无失败记录</p>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {failedJobs.map((job) => (
                              <div key={job.id} className="flex flex-col gap-0.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-mono text-text-secondary truncate max-w-[140px]">{job.id}</span>
                                  <span className="text-[10px] text-text-tertiary">{new Date(job.createdAt).toLocaleString("zh-CN")}</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] text-accent">{job.voice}</span>
                                  <span className="text-[10px] text-error truncate">{job.error}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Recent Agent Actions */}
                    <div className="flex flex-col gap-2">
                      <h4 className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                        <Bot size={12} className="text-accent" />
                        最近 Agent 操作
                      </h4>
                      <div className="border border-border-subtle rounded-md bg-bg-sunken p-3 min-h-[120px]">
                        {agentActions.length === 0 ? (
                          <p className="text-[10px] text-text-tertiary py-4 text-center">无 Agent 操作记录</p>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {agentActions.map((action) => (
                              <div key={action.id} className="flex flex-col gap-0.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-accent truncate max-w-[120px]">{action.action}</span>
                                  <span className={`text-[10px] font-medium ${
                                    action.status === "succeeded" || action.status === "approved" ? "text-success" :
                                    action.status === "failed" || action.status === "rejected" ? "text-error" :
                                    "text-text-tertiary"
                                  }`}>{action.status}</span>
                                </div>
                                <span className="text-[10px] text-text-tertiary">
                                  {new Date(action.createdAt).toLocaleString("zh-CN")}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Recent Job Summary */}
                    <div className="flex flex-col gap-2">
                      <h4 className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                        <FileAudio size={12} className="text-success" />
                        最近任务
                      </h4>
                      <div className="border border-border-subtle rounded-md bg-bg-sunken p-3 min-h-[120px]">
                        {recentJobs.length === 0 ? (
                          <p className="text-[10px] text-text-tertiary py-4 text-center">无任务记录</p>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {recentJobs.map((job) => (
                              <div key={job.id} className="flex flex-col gap-0.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-accent truncate max-w-[100px]">{job.voice}</span>
                                  <span className={`text-[10px] font-medium ${
                                    job.status === "succeeded" ? "text-success" :
                                    job.status === "failed" ? "text-error" :
                                    "text-text-tertiary"
                                  }`}>{job.status}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-text-tertiary">{job.source}</span>
                                  <span className="text-[10px] text-text-tertiary">{job.charCount} chars</span>
                                  <span className="text-[10px] text-text-tertiary">{new Date(job.createdAt).toLocaleString("zh-CN")}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Empty state: no data yet and not loading/error */}
              {diagPhase === "idle" && (
                <div className="flex items-center justify-center py-8 text-text-tertiary">
                  <span className="text-sm">点击"刷新"加载诊断数据</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="h-[52px] shrink-0 bg-bg-sunken border-t border-border-subtle mt-auto flex items-center justify-between px-8 sticky bottom-0 z-10">
        <div className="text-xs flex items-center gap-2">
          <span className="text-text-tertiary">设置通过后端 API 持久化保存</span>
          {saveStatus === "error" && saveErrorMessage && (
            <span className="text-error">{saveErrorMessage}</span>
          )}
        </div>
        <button
          className="px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-shadow-glow disabled:opacity-50"
          style={{
            backgroundColor: saveStatus === "saving"
              ? "var(--color-bg-active)"
              : saveStatus === "error"
              ? "var(--color-error)"
              : "var(--color-accent)",
            color: "var(--color-bg-base)",
          }}
          onClick={handleSave}
          disabled={saveStatus === "saving"}
        >
          {saveStatus === "saving" ? "保存中..." : saveStatus === "saved" ? "已保存" : saveStatus === "error" ? "保存失败" : "保存设置"}
        </button>
      </div>
    </div>
  );
}

// ── Diagnostics Sub-Components ─────────────────────────────────────────────

function CheckItem({ icon, label, ok, okText, failText }: {
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  okText: string;
  failText: string;
}) {
  return (
    <div className={`border rounded-md p-3 flex flex-col gap-1.5 ${
      ok
        ? "border-success/20 bg-success-muted/10"
        : "border-error/20 bg-error-muted/10"
    }`}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className={ok ? "text-success" : "text-error"}>{icon}</span>
        <span className="text-text-secondary font-medium">{label}</span>
      </div>
      <span className={`text-[11px] font-medium ${
        ok ? "text-success" : "text-error"
      }`}>
        {ok ? okText : failText}
      </span>
    </div>
  );
}
