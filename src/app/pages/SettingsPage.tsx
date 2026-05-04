import { useState, useCallback, useEffect } from "react";
import { Eye, EyeOff, RefreshCw, Loader2, Shield, Settings } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { AppSettings, AudioFormat, ConnectionStatus } from "../types";

export function SettingsPage() {
  const { settings, saveSettings, testConnection } = useAppState();

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

  // Sync form when settings load from backend
  useEffect(() => {
    setDefaultModel(settings.defaultModel);
    setDefaultVoice(settings.defaultVoice);
    setDefaultFormat(settings.defaultFormat);
    setAudioDir(settings.audioDir);
    setMaxChars(settings.maxChars);
    setMaxConcurrent(settings.maxConcurrent);
    // If backend reports key is configured, show masked state
    if (settings.openRouterApiKey === "***configured***") {
      setApiKeyMasked(true);
    } else {
      setApiKeyMasked(false);
    }
  }, [settings.defaultModel, settings.defaultVoice, settings.defaultFormat, settings.audioDir, settings.maxChars, settings.maxConcurrent, settings.openRouterApiKey]);

  // Save feedback
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(settings.connectionStatus);
  const [connectionLatency, setConnectionLatency] = useState<number | null>(null);

  const handleSave = useCallback(async () => {
    setSaveStatus("saving");

    // Build the payload directly from local form state -- this avoids the
    // stale-closure bug where saveSettings would read the old `settings` value
    // because updateSettings hasn't triggered a re-render yet.
    const payload: Partial<AppSettings> = {
      openRouterApiKey: apiKey.trim() || undefined,
      defaultModel,
      defaultVoice,
      defaultFormat,
      audioDir,
      maxChars,
      maxConcurrent,
    };

    await saveSettings(payload);

    // If a new key was just saved, clear the plaintext from local state
    if (apiKey.trim()) {
      setApiKey("");
      setApiKeyMasked(true);
    } else {
      // User explicitly cleared the key field -- check if backend still has one
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        setApiKeyMasked(!!data.hasOpenRouterApiKey);
      } catch {
        setApiKeyMasked(false);
      }
    }

    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
  }, [apiKey, defaultModel, defaultVoice, defaultFormat, audioDir, maxChars, maxConcurrent, saveSettings]);

  const handleTestConnection = useCallback(async () => {
    setConnectionStatus("testing");
    setConnectionLatency(null);
    try {
      const res = await fetch("/api/settings/test", { method: "POST" });
      const data = await res.json();
      if (data.error === "MISSING_API_KEY") {
        setConnectionStatus("failed");
      } else if (data.ok) {
        setConnectionStatus("connected");
        setConnectionLatency(data.latencyMs ?? null);
      } else {
        setConnectionStatus("failed");
      }
    } catch {
      setConnectionStatus("failed");
    }
  }, []);

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
                    {connectionStatus === "connected" ? `已连接${connectionLatency ? ` (${connectionLatency}ms)` : ""}` :
                     connectionStatus === "testing" ? "测试中..." :
                     connectionStatus === "failed" ? "连接失败 -- 请检查 API Key 是否正确" :
                     apiKeyMasked ? "Key 已配置" : "未配置"}
                  </span>
                </div>
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
                        checked={defaultFormat === "mp3"}
                        onChange={() => setDefaultFormat("mp3")}
                        className="accent-accent"
                      /> mp3
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer text-text-primary">
                      <input
                        type="radio"
                        name="format"
                        checked={defaultFormat === "pcm"}
                        onChange={() => setDefaultFormat("pcm")}
                        className="accent-accent"
                      /> pcm
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
                  <label className="text-sm text-text-secondary">本地 Token</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value="--- 本地 Token 由系统管理 ---"
                      readOnly
                      className="flex-1 bg-bg-sunken border border-border rounded-md px-3 py-2 text-sm outline-none font-mono text-text-tertiary"
                    />
                    <button className="px-3 py-2 bg-bg-base border border-border rounded-md text-sm font-medium hover:bg-bg-hover transition-colors flex items-center gap-2">
                      <RefreshCw size={14} /> 生成新
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-text-tertiary">状态:</span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-bg-sunken text-text-tertiary border border-border">
                    待实现
                  </span>
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
                  <input type="radio" name="auth" className="accent-accent" /> 每次确认
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer text-text-primary">
                  <input type="radio" name="auth" defaultChecked className="accent-accent" /> 会话自动批准
                </label>
              </div>
            </div>

            <div className="border border-border-subtle rounded-md bg-bg-sunken p-4 flex flex-col gap-4">
              <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">会话限制 (Session Limits)</h4>

              <div className="grid grid-cols-4 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大请求数</label>
                  <input type="number" defaultValue={10} className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono text-text-primary" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大字符数</label>
                  <input type="number" defaultValue={10000} className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono text-text-primary" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">最大费用</label>
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-sm">$</span>
                    <input type="number" step="0.01" defaultValue={0.01} className="w-full bg-bg-base border border-border rounded px-2 py-1 pl-5 text-sm outline-none focus:border-border-focus font-mono text-text-primary" />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-tertiary">过期时间 (秒)</label>
                  <input type="number" defaultValue={3600} className="w-full bg-bg-base border border-border rounded px-2 py-1 text-sm outline-none focus:border-border-focus font-mono text-text-primary" />
                </div>
              </div>

              <div className="h-px bg-border-subtle my-2" />

              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-text-tertiary">当前会话状态:</span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-bg-sunken text-text-tertiary border border-border">
                    待实现
                  </span>
                </div>

                <div className="flex items-center gap-4">
                  <button className="text-xs text-error hover:text-error/80 transition-colors">
                    撤销授权
                  </button>
                </div>
              </div>

            </div>

          </div>
        </div>
      </div>

      <div className="h-[52px] shrink-0 bg-bg-sunken border-t border-border-subtle mt-auto flex items-center justify-between px-8 sticky bottom-0 z-10">
        <div className="text-xs text-text-tertiary">
          设置通过后端 API 持久化保存
        </div>
        <button
          className="px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-shadow-glow disabled:opacity-50"
          style={{
            backgroundColor: saveStatus === "saving" ? "var(--color-bg-active)" : "var(--color-accent)",
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
