import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, FileJson, Loader2, RefreshCw, Shield, Terminal, Wrench } from "lucide-react";
import { apiRequest, ApiError } from "../../services/httpAdapter";
import { SettingsSection } from "../../components/SettingsSection";
import type {
  ControlledInstallResponse,
  OpenCodeConfigDisplayResponse,
  OpenCodeConfigUpdateResponse,
  OpenCodeInstallPlanResponse,
  OpenCodeRuntimeCapabilities,
  OpenCodeStatusResponse,
} from "../../types";

type ProviderForm = {
  name: string;
  baseURL: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  apiKeyInput: string;
  apiKeyAction: "keep" | "set" | "clear";
  editable: boolean;
  modelOptions: Array<{ key: string; name?: string | null }>;
};

type LoadPhase = "idle" | "loading" | "success" | "error";
type SavePhase = "idle" | "dirty" | "saving" | "success" | "error" | "conflict";
type InstallPhase = "idle" | "planning" | "confirming" | "installing" | "success" | "error";
type OpenPhase = "idle" | "opening" | "success" | "error";

type OpenConfigResponse = {
  ok: true;
  runtime: string;
  configPathLabel: string;
  copyableConfigPath: string | null;
  desktopIpcChannel: string | null;
};

const OPENCODE_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function responseErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const value = record.message ?? record.error ?? record.detail;
    if (typeof value === "string" && value.trim()) return value;
  }
  if (typeof body === "string" && body.trim()) return body.slice(0, 200);
  if (status === 403) return "当前运行环境不允许访问本机 OpenCode 配置。";
  if (status === 409) return "OpenCode 配置文件已在外部变化，请刷新后重试。";
  return `请求失败 (HTTP ${status})`;
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiRequest(path, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, responseErrorMessage(response.status, body), body);
  }
  return body as T;
}

async function copyTextWithTimeout(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      const clipboardWrite = Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1200)),
      ]);
      if (await clipboardWrite) return true;
    } catch {
      // Fall back to the legacy selection path below. Some browser automation
      // environments expose clipboard.writeText but deny permission synchronously.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

function providersFromConfig(config: OpenCodeConfigDisplayResponse): ProviderForm[] {
  return config.providers.map((provider) => ({
    name: provider.name,
    baseURL: provider.baseURL ?? "",
    hasApiKey: provider.hasApiKey,
    apiKeyMasked: provider.apiKeyMasked,
    apiKeyInput: "",
    apiKeyAction: "keep",
    editable: provider.editable,
    modelOptions: provider.models,
  }));
}

function runtimeLabel(capabilities: OpenCodeRuntimeCapabilities | null): string {
  if (!capabilities) return "unknown";
  if (capabilities.runtime === "desktop") return "Desktop";
  if (capabilities.runtime === "local") return "Local";
  if (capabilities.runtime === "remote") return "Remote";
  return "Web";
}

function capabilityRows(capabilities: OpenCodeRuntimeCapabilities | null): Array<{ label: string; enabled: boolean }> {
  if (!capabilities) return [];
  return [
    { label: "检测 CLI", enabled: capabilities.canDetectLocalOpenCode },
    { label: "读取配置", enabled: capabilities.canReadConfig },
    { label: "写入配置", enabled: capabilities.canWriteConfig },
    { label: "受控安装", enabled: capabilities.canInstall },
    { label: "打开 JSON", enabled: capabilities.canOpenConfig || capabilities.canReturnConfigPathForCopy },
  ];
}

function safeStatusLabel(status: OpenCodeStatusResponse | null): string {
  if (!status) return "未检测";
  if (!status.availability) return "不可检测";
  if (status.availability.available) return "已安装";
  return "未安装或不可用";
}

function installMethodLabel(method: "npm" | "chocolatey" | "scoop" | "path" | "unknown" | null | undefined): string {
  if (method === "npm") return "npm";
  if (method === "chocolatey") return "Chocolatey";
  if (method === "scoop") return "Scoop";
  if (method === "path") return "PATH";
  return "未知";
}

function pathStateLabel(pathState: OpenCodeStatusResponse["pathState"] | undefined): string {
  if (pathState === "system-path") return "系统 PATH";
  if (pathState === "augmented-path") return "应用补全 PATH";
  return "未找到";
}

function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const left = a.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function OpenCodeSettingsPanel() {
  const [status, setStatus] = useState<OpenCodeStatusResponse | null>(null);
  const [config, setConfig] = useState<OpenCodeConfigDisplayResponse | null>(null);
  const [loadPhase, setLoadPhase] = useState<LoadPhase>("idle");
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [providers, setProviders] = useState<ProviderForm[]>([]);
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  const [installPlan, setInstallPlan] = useState<OpenCodeInstallPlanResponse | null>(null);
  const [installConfirmation, setInstallConfirmation] = useState("");
  const [installResult, setInstallResult] = useState<ControlledInstallResponse | null>(null);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [openPhase, setOpenPhase] = useState<OpenPhase>("idle");
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const requestIdRef = useRef(0);

  const capabilities = status?.capabilities ?? null;
  const localDisabledReason = capabilities?.reason ?? "当前运行环境无法访问本机 OpenCode 能力。";
  const canEditConfig = !!capabilities?.canWriteConfig && !!config?.parseOk;
  const canUseLocalButtons = !!capabilities?.canDetectLocalOpenCode;
  const modelOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const provider of providers) {
      for (const option of provider.modelOptions) {
        options.set(option.key, option.name ? `${option.key} (${option.name})` : option.key);
      }
    }
    return Array.from(options.entries()).map(([key, label]) => ({ key, label }));
  }, [providers]);

  const loadOpenCodeSettings = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadPhase("loading");
    setLoadMessage("正在检测 OpenCode 运行状态...");
    setSaveMessage(null);
    setOpenMessage(null);
    try {
      const nextStatus = await readJson<OpenCodeStatusResponse>("/api/settings/opencode/status");
      if (requestId !== requestIdRef.current) return;
      setStatus(nextStatus);

      if (nextStatus.capabilities.canReadConfig) {
        const nextConfig = await readJson<OpenCodeConfigDisplayResponse>("/api/settings/opencode/config");
        if (requestId !== requestIdRef.current) return;
        setConfig(nextConfig);
        setModel(nextConfig.model);
        setProviders(providersFromConfig(nextConfig));
        setLoadMessage("OpenCode 状态与配置已刷新。明文 API Key 不会回显。 ");
      } else {
        setConfig(null);
        setModel("");
        setProviders([]);
        setLoadMessage(nextStatus.message ?? nextStatus.capabilities.reason ?? "当前环境只展示能力信息，不能读取本机配置。");
      }
      setLoadPhase("success");
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setLoadPhase("error");
      setLoadMessage(error instanceof Error ? error.message : "OpenCode 设置加载失败");
    }
  }, []);

  useEffect(() => {
    void loadOpenCodeSettings();
  }, [loadOpenCodeSettings]);

  const markDirty = useCallback(() => {
    setSaveMessage(null);
    setSavePhase((phase) => phase === "saving" ? phase : "dirty");
  }, []);

  const updateProvider = useCallback((name: string, updater: (provider: ProviderForm) => ProviderForm) => {
    setProviders((current) => current.map((provider) => provider.name === name ? updater(provider) : provider));
    markDirty();
  }, [markDirty]);

  const saveOpenCodeConfig = useCallback(async () => {
    if (!config || !capabilities?.canWriteConfig) {
      setSavePhase("error");
      setSaveMessage(localDisabledReason);
      return;
    }
    if (!config.parseOk) {
      setSavePhase("conflict");
      setSaveMessage("OpenCode JSON 解析失败，请先打开配置文件修复后再保存。 ");
      return;
    }

    setSavePhase("saving");
    setSaveMessage("正在保存 OpenCode model/baseURL/API Key 动作...");
    try {
      const providerPayload = providers
        .filter((provider) => provider.editable)
        .map((provider) => {
          if (provider.apiKeyAction === "set" && !provider.apiKeyInput.trim()) {
            throw new Error(`${provider.name} 选择了设置 API Key，但输入为空。`);
          }
          return {
            name: provider.name,
            baseURL: provider.baseURL.trim() || null,
            apiKeyAction: provider.apiKeyAction,
            ...(provider.apiKeyAction === "set" ? { apiKey: provider.apiKeyInput.trim() } : {}),
            ...(provider.apiKeyAction === "clear" ? { clearApiKey: true } : {}),
          };
        });

      await readJson<OpenCodeConfigUpdateResponse>("/api/settings/opencode/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: config.revision,
          model,
          providers: providerPayload,
        }),
      });
      const fresh = await readJson<OpenCodeConfigDisplayResponse>("/api/settings/opencode/config");
      setConfig(fresh);
      setModel(fresh.model);
      setProviders(providersFromConfig(fresh));
      setSavePhase("success");
      setSaveMessage("已保存。API Key 输入框已清空，界面只显示脱敏状态。 ");
      void readJson<OpenCodeStatusResponse>("/api/settings/opencode/status").then(setStatus).catch(() => undefined);
    } catch (error) {
      if (error instanceof ApiError && error.isConflict) {
        setSavePhase("conflict");
        setSaveMessage(error.message);
        return;
      }
      setSavePhase("error");
      setSaveMessage(error instanceof Error ? error.message : "保存 OpenCode 配置失败");
    }
  }, [capabilities?.canWriteConfig, config, localDisabledReason, model, providers]);

  const startInstallPlan = useCallback(async () => {
    if (!capabilities?.canInstall) {
      setInstallPhase("error");
      setInstallMessage(localDisabledReason);
      return;
    }
    setInstallPhase("planning");
    setInstallMessage("正在生成受控安装确认信息...");
    setInstallResult(null);
    setInstallConfirmation("");
    try {
      const plan = await readJson<OpenCodeInstallPlanResponse>("/api/settings/opencode/install-plan", { method: "POST" });
      setInstallPlan(plan);
      setInstallPhase("confirming");
      setInstallMessage("请确认固定安装命令。前端不会传入任意命令或参数。 ");
    } catch (error) {
      setInstallPhase("error");
      setInstallMessage(error instanceof Error ? error.message : "生成安装确认失败");
    }
  }, [capabilities?.canInstall, localDisabledReason]);

  const runControlledInstall = useCallback(async () => {
    if (!installPlan) return;
    if (installConfirmation.trim() !== installPlan.confirmationPhrase) {
      setInstallPhase("error");
      setInstallMessage(`请输入确认短语 ${installPlan.confirmationPhrase} 后再安装。`);
      return;
    }
    setInstallPhase("installing");
    setInstallMessage("正在执行受控安装，命令由后端 allowlist 固定。 ");
    try {
      const result = await readJson<ControlledInstallResponse>("/api/settings/opencode/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nonce: installPlan.nonce,
          confirmationPhrase: installPlan.confirmationPhrase,
          confirm: true,
        }),
      });
      setInstallResult(result);
      setInstallPhase(result.ok ? "success" : "error");
      setInstallMessage(result.ok ? "OpenCode 安装流程已完成，并已重新检测 CLI 状态。" : (result.error ?? "OpenCode 安装未成功。"));
      setInstallPlan(null);
      setInstallConfirmation("");
      await loadOpenCodeSettings();
    } catch (error) {
      setInstallPhase("error");
      setInstallMessage(error instanceof Error ? error.message : "OpenCode 安装失败");
    }
  }, [installConfirmation, installPlan, loadOpenCodeSettings]);

  const openConfigFile = useCallback(async () => {
    if (!capabilities?.canOpenConfig && !capabilities?.canReturnConfigPathForCopy) {
      setOpenPhase("error");
      setOpenMessage(localDisabledReason);
      return;
    }
    setOpenPhase("opening");
    setOpenMessage("正在请求固定 OpenCode JSON 配置路径...");
    setCopiedPath(false);
    try {
      const response = await readJson<OpenConfigResponse>("/api/settings/opencode/open-config", { method: "POST" });
      if (response.desktopIpcChannel) {
        const bridgeResult = await window.ttsDesktop?.openOpenCodeConfig?.();
        if (!bridgeResult) throw new Error("桌面桥不可用，无法打开固定配置文件。 ");
        if (!bridgeResult.ok) throw new Error(bridgeResult.error || "打开 OpenCode 配置文件失败");
        setOpenPhase("success");
        setOpenMessage(`已请求桌面端打开 ${response.configPathLabel}`);
        return;
      }
      if (response.copyableConfigPath) {
        const copied = await copyTextWithTimeout(response.copyableConfigPath);
        setCopiedPath(copied);
        setOpenPhase("success");
        setOpenMessage(copied
          ? "本地开发模式不使用 Electron 打开文件，已复制固定配置路径。 "
          : `本地开发模式不使用 Electron 打开文件；自动复制不可用，请手动复制固定路径：${response.copyableConfigPath}`);
        return;
      }
      throw new Error("当前环境没有可用的打开或复制配置路径能力。 ");
    } catch (error) {
      setOpenPhase("error");
      setOpenMessage(error instanceof Error ? error.message : "打开 OpenCode 配置文件失败");
    }
  }, [capabilities?.canOpenConfig, capabilities?.canReturnConfigPathForCopy, localDisabledReason]);

  const statusTone = status?.availability?.available
    ? "border-success/25 bg-success-muted/10 text-success"
    : canUseLocalButtons
      ? "border-warning/25 bg-warning-muted/10 text-warning"
      : "border-border bg-bg-sunken text-text-tertiary";
  const updateAvailable = compareSemver(status?.latestVersion, status?.availability?.version) > 0;
  const packageManagerRows = status?.packageManagers ? (Object.entries(status.packageManagers) as Array<["npm" | "pnpm" | "bun" | "corepack", { available: boolean; version: string | null; resolution?: string | null }]>) : [];
  const saveDisabled = savePhase === "saving" || !canEditConfig || providers.length === 0;
  const installDisabled = installPhase === "planning" || installPhase === "installing" || !capabilities?.canInstall;
  const openDisabled = openPhase === "opening" || (!capabilities?.canOpenConfig && !capabilities?.canReturnConfigPathForCopy);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">OpenCode 管理</h3>
          <span className="text-[10px] text-text-tertiary border border-border-subtle rounded-full px-2 py-0.5">安全编辑 opencode.json</span>
        </div>
        <button
          className="px-3 py-1.5 bg-bg-base border border-border rounded-md text-xs font-medium hover:bg-bg-hover active:bg-bg-active transition-colors flex items-center gap-1.5 disabled:opacity-50"
          onClick={loadOpenCodeSettings}
          disabled={loadPhase === "loading"}
        >
          {loadPhase === "loading" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          刷新检测
        </button>
      </div>

      <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-5">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.35fr] gap-4">
          <SettingsSection title="CLI 状态" description="检测本机 OpenCode、npm、Provider 与运行时能力。" icon={<Terminal size={14} />} defaultOpen contentClassName="border border-border-subtle rounded-md bg-bg-sunken p-4 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">CLI 状态</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${statusTone}`}>{safeStatusLabel(status)}</span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium border border-border bg-bg-base text-text-secondary">{runtimeLabel(capabilities)}</span>
                </div>
              </div>
              {loadPhase === "loading" && <Loader2 size={16} className="animate-spin text-accent" />}
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <InfoTile label="版本" value={status?.availability?.version ?? "未获取"} />
              <InfoTile label="最新版本" value={status?.latestVersion ?? "未获取"} />
              <InfoTile label="安装来源" value={installMethodLabel(status?.availability?.installMethod)} />
              <InfoTile label="PATH 状态" value={pathStateLabel(status?.availability?.pathState ?? status?.pathState)} />
              <InfoTile label="npm" value={status?.npm ? (status.npm.available ? status.npm.version ?? "可用" : "不可用") : "未检测"} />
              <InfoTile label="Provider 数" value={String(status?.availability?.providerMetadata.providerCount ?? config?.providers.length ?? 0)} />
              <InfoTile label="Model 数" value={String(status?.availability?.providerMetadata.modelCount ?? modelOptions.length)} />
            </div>

            {updateAvailable && (
              <InlineMessage tone="warning" message={`检测到 OpenCode 新版本 ${status?.latestVersion}，可通过下方受控安装执行固定更新命令。`} />
            )}

            {status?.availability?.pathState === "augmented-path" && (
              <InlineMessage tone="warning" message="OpenCode 不在系统 PATH 中，仅通过应用补全 PATH 检测到。若终端和桌面行为不一致，请检查 npm global prefix、Scoop 或 Chocolatey 路径。" />
            )}

            {status?.availability?.resolutionError && (
              <InlineMessage tone="error" message={`安全解析失败：${status.availability.resolutionError}`} />
            )}

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-secondary">Package managers</span>
              <div className="grid grid-cols-2 gap-2">
                {packageManagerRows.map(([name, manager]) => (
                  <span key={name} className={`px-2 py-1 rounded border text-[11px] ${manager.available ? "border-success/20 bg-success-muted/10 text-success" : "border-border bg-bg-base text-text-tertiary"}`}>
                    {name}: {manager.available ? manager.version ?? manager.resolution ?? "可用" : "不可用"}
                  </span>
                ))}
                {packageManagerRows.length === 0 && <span className="text-[11px] text-text-tertiary">未检测</span>}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-text-secondary">Runtime capabilities</span>
              <div className="flex flex-wrap gap-2">
                {capabilityRows(capabilities).map((item) => (
                  <span key={item.label} className={`px-2 py-1 rounded border text-[11px] ${item.enabled ? "border-success/20 bg-success-muted/10 text-success" : "border-border bg-bg-base text-text-tertiary"}`}>
                    {item.label}: {item.enabled ? "可用" : "禁用"}
                  </span>
                ))}
              </div>
              {capabilities?.reason && (
                <p className="text-[11px] leading-5 text-text-tertiary border border-border-subtle rounded bg-bg-base px-3 py-2">{capabilities.reason}</p>
              )}
            </div>

            {loadMessage && (
              <InlineMessage tone={loadPhase === "error" ? "error" : loadPhase === "success" ? "success" : "neutral"} message={loadMessage} />
            )}
          </SettingsSection>

          <SettingsSection title="配置文件" description="查看固定 opencode.json 路径，并按运行环境打开或复制。" icon={<FileJson size={14} />} defaultOpen contentClassName="border border-border-subtle rounded-md bg-bg-sunken p-4 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">配置文件</span>
                <span className="text-sm font-mono text-text-primary break-all">{config?.configPathLabel ?? "需在 desktop/local 环境读取"}</span>
              </div>
              <button
                className="shrink-0 px-3 py-1.5 bg-bg-base border border-border rounded-md text-xs font-medium hover:bg-bg-hover active:bg-bg-active transition-colors flex items-center gap-1.5 disabled:opacity-50"
                onClick={openConfigFile}
                disabled={openDisabled}
                title={openDisabled ? localDisabledReason : undefined}
              >
                {openPhase === "opening" ? <Loader2 size={12} className="animate-spin" /> : copiedPath ? <Check size={12} className="text-success" /> : capabilities?.canReturnConfigPathForCopy && !capabilities?.canOpenConfig ? <Copy size={12} /> : <ExternalLink size={12} />}
                {capabilities?.canReturnConfigPathForCopy && !capabilities?.canOpenConfig ? "复制 JSON 路径" : "打开 JSON 配置文件"}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3 text-xs">
              <InfoTile label="文件状态" value={config ? (config.exists ? "已存在" : "将创建") : "不可读"} />
              <InfoTile label="JSON" value={config ? (config.parseOk ? "可安全编辑" : "解析失败") : "未加载"} />
              <InfoTile label="API Key" value={providers.some((provider) => provider.hasApiKey) ? "已配置" : "未配置"} />
            </div>

            {config?.warnings.length ? (
              <div className="flex flex-col gap-2">
                {config.warnings.map((warning) => (
                  <InlineMessage key={`${warning.code}-${warning.message}`} tone="warning" message={`${warning.code}: ${warning.message}`} />
                ))}
              </div>
            ) : null}

            {openMessage && <InlineMessage tone={openPhase === "error" ? "error" : openPhase === "success" ? "success" : "neutral"} message={openMessage} />}
          </SettingsSection>
        </div>

        <div className="grid grid-cols-1 2xl:grid-cols-[1.5fr_1fr] gap-4">
          <SettingsSection title="可视化配置" description="编辑 model、provider baseURL 与 API Key 动作；不会回显明文密钥。" icon={<FileJson size={14} />} defaultOpen contentClassName="border border-border-subtle rounded-md bg-bg-sunken p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileJson size={14} className="text-accent" />
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">可视化配置</span>
              </div>
              <button
                className="px-4 py-2 bg-accent text-bg-base rounded-md text-sm font-medium hover:bg-accent/90 active:bg-accent/80 transition-colors flex items-center gap-2 disabled:opacity-50"
                onClick={saveOpenCodeConfig}
                disabled={saveDisabled}
                title={!canEditConfig ? localDisabledReason : undefined}
              >
                {savePhase === "saving" ? <Loader2 size={14} className="animate-spin" /> : savePhase === "success" ? <Check size={14} /> : <Shield size={14} />}
                {savePhase === "saving" ? "保存中" : savePhase === "success" ? "已保存" : "保存配置"}
              </button>
            </div>

            {!config && !capabilities?.canReadConfig ? (
              <DisabledPanel message={localDisabledReason} />
            ) : !config?.parseOk ? (
              <DisabledPanel message="OpenCode JSON 解析失败。为避免覆盖高级配置，请先打开 JSON 文件修复。" />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary">model</label>
                  <input
                    list="opencode-model-options"
                    value={model}
                    onChange={(event) => { setModel(event.target.value); markDirty(); }}
                    disabled={!canEditConfig}
                    placeholder="例如 openrouter/google/gemini-3.1-flash-tts-preview"
                    className="w-full bg-bg-base border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
                  />
                  <datalist id="opencode-model-options">
                    {modelOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                  </datalist>
                </div>

                <div className="flex flex-col gap-3">
                  {providers.map((provider) => (
                    <div key={provider.name} className="border border-border-subtle rounded-md bg-bg-base p-3 flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-text-primary font-mono">{provider.name}</span>
                          <span className={`px-2 py-0.5 rounded text-[11px] border ${provider.hasApiKey ? "bg-success-muted/10 text-success border-success/20" : "bg-bg-sunken text-text-tertiary border-border"}`}>
                            {provider.hasApiKey ? `API Key 已配置 ${provider.apiKeyMasked ?? "***"}` : "API Key 未配置"}
                          </span>
                        </div>
                        {!provider.editable && <span className="text-[11px] text-warning">结构不可安全编辑</span>}
                      </div>

                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs text-text-tertiary">baseURL</label>
                          <input
                            value={provider.baseURL}
                            onChange={(event) => updateProvider(provider.name, (current) => ({ ...current, baseURL: event.target.value }))}
                            disabled={!canEditConfig || !provider.editable}
                            placeholder={OPENCODE_DEFAULT_BASE_URL}
                            className="w-full bg-bg-sunken border border-border rounded px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs text-text-tertiary">apiKeyAction</label>
                          <select
                            value={provider.apiKeyAction}
                            onChange={(event) => updateProvider(provider.name, (current) => ({ ...current, apiKeyAction: event.target.value as ProviderForm["apiKeyAction"], apiKeyInput: event.target.value === "set" ? current.apiKeyInput : "" }))}
                            disabled={!canEditConfig || !provider.editable}
                            className="w-full bg-bg-sunken border border-border rounded px-3 py-2 text-sm outline-none focus:border-border-focus text-text-primary disabled:opacity-60"
                          >
                            <option value="keep">keep: 保留现有密钥</option>
                            <option value="set">set: 写入新密钥</option>
                            <option value="clear">clear: 清除密钥</option>
                          </select>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-text-tertiary">API Key</label>
                        <input
                          type="password"
                          value={provider.apiKeyInput}
                          onChange={(event) => updateProvider(provider.name, (current) => ({ ...current, apiKeyInput: event.target.value, apiKeyAction: event.target.value ? "set" : current.apiKeyAction }))}
                          disabled={!canEditConfig || !provider.editable || provider.apiKeyAction === "clear"}
                          placeholder={provider.hasApiKey ? `已配置 ${provider.apiKeyMasked ?? "***"}；不回显，留空则保留` : "输入后保存；不会写入浏览器存储"}
                          autoComplete="off"
                          className="w-full bg-bg-sunken border border-border rounded px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {saveMessage && (
              <InlineMessage tone={savePhase === "success" ? "success" : savePhase === "conflict" ? "warning" : savePhase === "error" ? "error" : "neutral"} message={saveMessage} />
            )}
          </SettingsSection>

          <SettingsSection title="受控安装" description="低频且高风险操作，默认收起；命令由后端 allowlist 固定。" icon={<Wrench size={14} />} defaultOpen={false} contentClassName="border border-border-subtle rounded-md bg-bg-sunken p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Wrench size={14} className="text-accent" />
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">受控安装</span>
              </div>
              <button
                className="px-3 py-1.5 bg-bg-base border border-border rounded-md text-xs font-medium hover:bg-bg-hover active:bg-bg-active transition-colors flex items-center gap-1.5 disabled:opacity-50"
                onClick={startInstallPlan}
                disabled={installDisabled}
                title={!capabilities?.canInstall ? localDisabledReason : undefined}
              >
                {installPhase === "planning" || installPhase === "installing" ? <Loader2 size={12} className="animate-spin" /> : <Terminal size={12} />}
                安装 OpenCode
              </button>
            </div>

            <p className="text-xs leading-5 text-text-tertiary">安装只走后端固定 allowlist：不接收包名、命令、参数、cwd 或 env。web/remote 环境按钮会被禁用。</p>

            {installPlan && installPhase === "confirming" && (
              <div className="border border-warning/25 bg-warning-muted/10 rounded-md p-3 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-xs text-warning font-medium">
                  <AlertTriangle size={13} />
                  二次确认固定命令
                </div>
                <code className="bg-bg-base border border-border rounded px-3 py-2 text-xs font-mono text-text-primary select-all">{installPlan.commandPreview}</code>
                {installPlan.installCandidates.length > 0 && (
                  <div className="flex flex-col gap-1 text-[11px] text-text-tertiary">
                    <span>可用安装候选：</span>
                    {installPlan.installCandidates.map((candidate) => <code key={candidate} className="font-mono">{candidate}</code>)}
                  </div>
                )}
                <input
                  value={installConfirmation}
                  onChange={(event) => setInstallConfirmation(event.target.value)}
                  placeholder={`输入 ${installPlan.confirmationPhrase} 确认`}
                  className="w-full bg-bg-base border border-border rounded px-3 py-2 text-sm outline-none focus:border-border-focus font-mono text-text-primary placeholder:text-text-tertiary"
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-text-tertiary">nonce 有效至 {new Date(installPlan.nonceExpiresAt).toLocaleString("zh-CN")}</span>
                  <button
                    className="px-3 py-1.5 bg-accent text-bg-base rounded-md text-xs font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
                    onClick={runControlledInstall}
                    disabled={installConfirmation.trim() !== installPlan.confirmationPhrase}
                  >
                    确认安装
                  </button>
                </div>
              </div>
            )}

            {installMessage && (
              <InlineMessage tone={installPhase === "success" ? "success" : installPhase === "error" ? "error" : installPhase === "confirming" ? "warning" : "neutral"} message={installMessage} />
            )}

            {installResult && (
              <div className="border border-border-subtle rounded-md bg-bg-base p-3 flex flex-col gap-2 text-[11px] text-text-tertiary">
                <span>packageManager: {installResult.packageManager ?? "none"} | exitCode: {installResult.exitCode ?? "null"} | duration: {installResult.durationMs}ms | timeout: {installResult.timedOut ? "yes" : "no"}</span>
                {installResult.stderrTail && <code className="font-mono break-all text-error/90">stderr: {installResult.stderrTail}</code>}
                {installResult.attempts?.length ? (
                  <div className="flex flex-col gap-1">
                    <span>尝试记录：</span>
                    {installResult.attempts.map((attempt, index) => (
                      <code key={`${attempt.packageManager}-${index}`} className="font-mono break-all">
                        {attempt.commandPreview} | resolved={String(attempt.resolved)} | exit={attempt.exitCode ?? "null"} | error={attempt.error ?? "none"}
                      </code>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border-subtle rounded bg-bg-base px-3 py-2 flex flex-col gap-1 min-w-0">
      <span className="text-[10px] text-text-tertiary uppercase tracking-wider">{label}</span>
      <span className="text-xs text-text-primary font-mono truncate" title={value}>{value}</span>
    </div>
  );
}

function InlineMessage({ tone, message }: { tone: "neutral" | "success" | "warning" | "error"; message: string }) {
  const toneClass = tone === "success"
    ? "border-success/30 bg-success-muted/10 text-success"
    : tone === "warning"
      ? "border-warning/30 bg-warning-muted/10 text-warning"
      : tone === "error"
        ? "border-error/30 bg-error-muted/20 text-error"
        : "border-border bg-bg-base text-text-tertiary";
  return (
    <div className={`border rounded-md px-3 py-2 text-xs leading-5 ${toneClass}`}>
      {message}
    </div>
  );
}

function DisabledPanel({ message }: { message: string }) {
  return (
    <div className="border border-border rounded-md bg-bg-base px-4 py-8 flex flex-col items-center justify-center gap-2 text-center">
      <AlertTriangle size={18} className="text-warning" />
      <p className="text-sm text-text-secondary">{message}</p>
    </div>
  );
}
