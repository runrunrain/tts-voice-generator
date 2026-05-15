import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  Loader2,
  MonitorUp,
  Power,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { SettingsSection } from "../../components/SettingsSection";
import {
  getDesktopBridge,
  hasDesktopUpdateBridge,
  type TtsDesktopBridge,
} from "../../desktop/desktopBridge";
import type {
  DesktopDownloadProgress,
  DesktopPlatformCapabilities,
  DesktopUpdatePhase,
  DesktopUpdateState,
} from "../../../../electron/desktop-contracts";

type ActionPhase = "check" | "download" | "install" | "release" | null;
type LoadPhase = "loading" | "ready" | "web" | "error";
type Tone = "neutral" | "info" | "success" | "warning" | "error";

const PHASE_COPY: Record<DesktopUpdatePhase, { label: string; description: string; tone: Tone }> = {
  idle: { label: "等待检查", description: "手动检查更新，不会自动下载或重启。", tone: "neutral" },
  unsupported: { label: "当前环境不支持", description: "该能力需要桌面安装包与受控 preload API。", tone: "warning" },
  checking: { label: "正在检查", description: "正在查询 GitHub Release 更新元数据。", tone: "info" },
  "up-to-date": { label: "已是最新", description: "当前版本已与更新源同步。", tone: "success" },
  available: { label: "发现新版本", description: "可下载更新包；下载后再手动安装重启。", tone: "info" },
  downloading: { label: "正在下载", description: "更新包下载中，请保持网络连接。", tone: "info" },
  downloaded: { label: "已下载", description: "安装会关闭内嵌服务并重启应用。", tone: "success" },
  installing: { label: "准备重启", description: "正在交给主进程安装更新，请勿强制关闭。", tone: "warning" },
  error: { label: "更新失败", description: "检查或下载遇到问题，可重试或打开下载页。", tone: "error" },
};

function formatPlatform(capabilities: DesktopPlatformCapabilities | null) {
  if (!capabilities) return "浏览器预览";
  const platformLabel = capabilities.platform === "darwin"
    ? "macOS"
    : capabilities.platform === "win32"
      ? "Windows"
      : capabilities.platform;
  return `${platformLabel} ${capabilities.arch}`;
}

function formatBoolean(value: boolean | undefined, enabledText: string, disabledText: string) {
  if (value === undefined) return "未检测";
  return value ? enabledText : disabledText;
}

function formatDateTime(value: string | undefined) {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatBytes(bytes: number | undefined) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatSpeed(bytesPerSecond: number | undefined) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return "等待速度数据";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function clampPercent(percent: number | undefined) {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent ?? 0));
}

function getToneClass(tone: Tone) {
  switch (tone) {
    case "success":
      return "border-success/20 bg-success-muted/10 text-success";
    case "warning":
      return "border-warning/25 bg-warning-muted/10 text-warning";
    case "error":
      return "border-error/25 bg-error-muted/20 text-error";
    case "info":
      return "border-accent/25 bg-accent-muted/10 text-accent";
    case "neutral":
    default:
      return "border-border bg-bg-sunken text-text-secondary";
  }
}

function getPrimaryButtonClass(tone: "accent" | "success" | "warning" = "accent") {
  if (tone === "success") {
    return "border-success/40 bg-success-muted text-success hover:bg-success-muted/80 focus-visible:ring-success/40";
  }
  if (tone === "warning") {
    return "border-warning/40 bg-warning-muted text-warning hover:bg-warning-muted/80 focus-visible:ring-warning/40";
  }
  return "border-accent/40 bg-accent text-bg-base hover:bg-accent/90 focus-visible:ring-accent/40";
}

function CapabilityTile({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className={`min-w-0 rounded-md border p-3 ${getToneClass(tone)}`}>
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] opacity-80">{label}</div>
      <div className="mt-1 truncate text-xs font-mono" title={value}>{value}</div>
    </div>
  );
}

function StatusBanner({ tone, icon, title, children }: { tone: Tone; icon: ReactNode; title: string; children: ReactNode }) {
  const role = tone === "error" ? "alert" : "status";
  return (
    <div role={role} className={`rounded-md border p-3 ${getToneClass(tone)}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs leading-5 opacity-90">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ProgressMeter({ progress }: { progress?: DesktopDownloadProgress }) {
  const percent = clampPercent(progress?.percent);
  return (
    <div className="flex flex-col gap-2" aria-label="下载进度">
      <div
        className="h-2 overflow-hidden rounded-full border border-border bg-bg-sunken"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-tertiary">
        <span className="font-mono text-text-secondary">{percent.toFixed(1)}%</span>
        <span>{formatBytes(progress?.transferred)} / {formatBytes(progress?.total)}</span>
        <span>{formatSpeed(progress?.bytesPerSecond)}</span>
      </div>
    </div>
  );
}

function ReleaseNotes({ notes }: { notes?: string }) {
  const trimmedNotes = notes?.trim();
  if (!trimmedNotes) {
    return <p className="text-xs leading-5 text-text-tertiary">更新源未提供 release notes。可打开下载页查看完整发布说明。</p>;
  }
  const visibleNotes = trimmedNotes.length > 1200 ? `${trimmedNotes.slice(0, 1200)}\n...` : trimmedNotes;
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-sunken p-3 text-xs leading-5 text-text-secondary">
      {visibleNotes}
    </pre>
  );
}

async function refreshState(bridge: TtsDesktopBridge, setUpdateState: (state: DesktopUpdateState) => void) {
  const nextState = await bridge.update.getState();
  setUpdateState(nextState);
}

export function ApplicationUpdateSection() {
  const [loadPhase, setLoadPhase] = useState<LoadPhase>(() => hasDesktopUpdateBridge() ? "loading" : "web");
  const [capabilities, setCapabilities] = useState<DesktopPlatformCapabilities | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [actionPhase, setActionPhase] = useState<ActionPhase>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: Tone; text: string } | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.getPlatformCapabilities || !bridge.update?.getState || !bridge.update.onEvent) {
      setLoadPhase("web");
      return undefined;
    }

    let cancelled = false;
    setLoadPhase("loading");
    setActionMessage(null);

    const unsubscribe = bridge.update.onEvent((event) => {
      if (cancelled) return;
      setUpdateState(event.state);
    });

    Promise.all([bridge.getPlatformCapabilities(), bridge.update.getState()])
      .then(([nextCapabilities, nextState]) => {
        if (cancelled) return;
        setCapabilities(nextCapabilities);
        setUpdateState(nextState);
        setLoadPhase("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadPhase("error");
        setActionMessage({ tone: "error", text: error instanceof Error ? error.message : "无法读取桌面更新能力。" });
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const phase = updateState?.phase ?? (loadPhase === "web" ? "unsupported" : "idle");
  const phaseCopy = PHASE_COPY[phase];
  const isBusy = actionPhase !== null || phase === "checking" || phase === "downloading" || phase === "installing" || loadPhase === "loading";
  const bridgeAvailable = loadPhase === "ready" && hasDesktopUpdateBridge();
  const installUnsupportedReason = capabilities?.updateInstallUnsupportedReason;

  const capabilityTiles = useMemo(() => [
    { label: "当前版本", value: updateState?.currentVersion ?? capabilities?.appVersion ?? "未检测", tone: "neutral" as Tone },
    { label: "运行平台", value: formatPlatform(capabilities), tone: capabilities ? "neutral" as Tone : "warning" as Tone },
    { label: "托盘常驻", value: formatBoolean(capabilities?.systemTraySupported, "可用", "不可用"), tone: capabilities?.systemTraySupported ? "success" as Tone : "warning" as Tone },
    { label: "关闭隐藏", value: formatBoolean(capabilities?.hideOnCloseSupported, "关闭窗口隐藏", "关闭窗口退出"), tone: capabilities?.hideOnCloseSupported ? "success" as Tone : "warning" as Tone },
    { label: "检查更新", value: formatBoolean(capabilities?.updateCheckSupported, "可检查", "不可检查"), tone: capabilities?.updateCheckSupported ? "success" as Tone : "warning" as Tone },
    { label: "自动安装", value: formatBoolean(capabilities?.updateInstallSupported, "可安装重启", "需手动安装"), tone: capabilities?.updateInstallSupported ? "success" as Tone : "warning" as Tone },
  ], [capabilities, updateState?.currentVersion]);

  const handleCheck = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.update?.check) {
      setActionMessage({ tone: "warning", text: "普通浏览器中没有桌面更新 API；请在桌面应用中使用。" });
      return;
    }
    setActionPhase("check");
    setActionMessage(null);
    try {
      const result = await bridge.update.check();
      setUpdateState(result.state);
      setActionMessage(result.ok
        ? { tone: "success", text: "更新检查完成。" }
        : { tone: "error", text: result.error });
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : "检查更新失败。" });
    } finally {
      setActionPhase(null);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.update?.download) {
      setActionMessage({ tone: "warning", text: "普通浏览器中没有桌面更新 API；请在桌面应用中使用。" });
      return;
    }
    setActionPhase("download");
    setActionMessage(null);
    try {
      const result = await bridge.update.download();
      await refreshState(bridge, setUpdateState);
      setActionMessage(result.ok
        ? { tone: "success", text: "更新下载已启动或已完成。" }
        : { tone: "error", text: result.error });
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : "下载更新失败。" });
    } finally {
      setActionPhase(null);
    }
  }, []);

  const handleInstallAndRestart = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.update?.installAndRestart) {
      setActionMessage({ tone: "warning", text: "普通浏览器中没有桌面更新 API；请在桌面应用中使用。" });
      return;
    }
    const confirmed = window.confirm("安装更新会关闭当前窗口、停止内嵌服务并重启应用。确认现在安装并重启吗？");
    if (!confirmed) return;

    setActionPhase("install");
    setActionMessage(null);
    try {
      const result = await bridge.update.installAndRestart();
      if (!result.ok) {
        await refreshState(bridge, setUpdateState);
        setActionMessage({ tone: "error", text: result.error });
      } else {
        setActionMessage({ tone: "success", text: "已交给主进程安装更新，应用即将重启。" });
      }
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : "安装并重启失败。" });
    } finally {
      setActionPhase(null);
    }
  }, []);

  const handleOpenReleasePage = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.update?.openReleasePage) {
      setActionMessage({ tone: "warning", text: "普通浏览器中不调用主进程打开外部链接；请在桌面应用中使用。" });
      return;
    }
    setActionPhase("release");
    setActionMessage(null);
    try {
      const result = await bridge.update.openReleasePage();
      setActionMessage(result.ok
        ? { tone: "success", text: "已请求打开官方 Release 下载页。" }
        : { tone: "error", text: result.error });
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : "打开下载页失败。" });
    } finally {
      setActionPhase(null);
    }
  }, []);

  const checkDisabled = isBusy || !bridgeAvailable || capabilities?.updateCheckSupported === false;
  const downloadDisabled = isBusy || !bridgeAvailable || !capabilities?.updateDownloadSupported || phase !== "available";
  const installDisabled = isBusy || !bridgeAvailable || !capabilities?.updateInstallSupported || phase !== "downloaded";
  const releaseDisabled = isBusy || !bridgeAvailable;

  return (
    <SettingsSection
      title="应用更新 / 版本升级"
      description="桌面安装包的手动检查、下载、安装重启，以及托盘常驻行为说明。"
      icon={<MonitorUp size={16} />}
      defaultOpen
    >
      <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-5">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
          <div className="min-w-0 flex flex-col gap-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium ${getToneClass(phaseCopy.tone)}`}>
                    {phase === "checking" || phase === "downloading" || phase === "installing" ? <Loader2 size={12} className="animate-spin" /> : <Info size={12} />}
                    {phaseCopy.label}
                  </span>
                  {updateState?.latestVersion && (
                    <span className="rounded border border-accent/20 bg-accent-muted/10 px-2 py-1 text-xs font-mono text-accent">
                      最新版本 {updateState.latestVersion}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-5 text-text-tertiary">{phaseCopy.description}</p>
              </div>
              <div className="text-left text-[11px] text-text-tertiary sm:text-right">
                <div>上次检查</div>
                <div className="font-mono text-text-secondary">{formatDateTime(updateState?.lastCheckedAt)}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {capabilityTiles.map((tile) => (
                <CapabilityTile key={tile.label} label={tile.label} value={tile.value} tone={tile.tone} />
              ))}
            </div>

            {loadPhase === "loading" && (
              <StatusBanner tone="info" icon={<Loader2 size={14} className="animate-spin" />} title="正在读取桌面能力">
                正在通过 preload 白名单 API 获取版本、平台和更新状态。
              </StatusBanner>
            )}

            {loadPhase === "web" && (
              <StatusBanner tone="warning" icon={<AlertTriangle size={14} />} title="普通浏览器预览模式">
                未检测到 window.ttsDesktop。页面会保持可渲染，但检查、下载、安装和打开下载页均需要桌面应用内的安全 preload API。
              </StatusBanner>
            )}

            {loadPhase === "error" && actionMessage && (
              <StatusBanner tone="error" icon={<AlertTriangle size={14} />} title="桌面能力读取失败">
                {actionMessage.text}
              </StatusBanner>
            )}

            {phase === "unsupported" && loadPhase !== "web" && (
              <StatusBanner tone="warning" icon={<AlertTriangle size={14} />} title="应用内更新当前不可用">
                {updateState?.error || installUnsupportedReason || "请使用正式打包安装的桌面应用检查更新。"}
              </StatusBanner>
            )}

            {installUnsupportedReason && capabilities?.updateCheckSupported && (
              <StatusBanner tone="warning" icon={<Info size={14} />} title="自动安装降级说明">
                {installUnsupportedReason} 仍可检查更新，并通过官方下载页手动安装。
              </StatusBanner>
            )}

            {phase === "downloading" && <ProgressMeter progress={updateState?.progress} />}

            {phase === "error" && updateState?.error && (
              <StatusBanner tone="error" icon={<AlertTriangle size={14} />} title="更新错误">
                {updateState.error}
              </StatusBanner>
            )}

            {actionMessage && loadPhase !== "error" && (
              <StatusBanner tone={actionMessage.tone} icon={actionMessage.tone === "error" ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} title="操作反馈">
                {actionMessage.text}
              </StatusBanner>
            )}

            {(phase === "available" || phase === "downloaded") && (
              <div className="rounded-md border border-border-subtle bg-bg-sunken p-4 flex flex-col gap-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-text-primary">
                      {updateState?.updateInfo?.releaseName || `版本 ${updateState?.latestVersion ?? updateState?.updateInfo?.version ?? "未知"}`}
                    </div>
                    <div className="text-[11px] text-text-tertiary">
                      发布日期：{formatDateTime(updateState?.updateInfo?.releaseDate)}
                    </div>
                  </div>
                </div>
                <ReleaseNotes notes={updateState?.updateInfo?.releaseNotes} />
              </div>
            )}
          </div>

          <aside className="flex flex-col gap-3 rounded-md border border-border-subtle bg-bg-sunken p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Power size={14} className="text-accent" /> 托盘常驻说明
            </div>
            <p className="text-xs leading-5 text-text-tertiary">
              关闭窗口会隐藏到系统托盘或 macOS 菜单栏状态项，语音服务继续在后台运行。需要彻底退出时，请使用托盘菜单“退出 TTS Voice Generator”，或在应用提供的明确退出入口中退出。
            </p>
            <div className="grid grid-cols-1 gap-2 text-[11px]">
              <div className="rounded border border-border bg-bg-base p-2 text-text-secondary">显示窗口：从托盘恢复并聚焦主窗口。</div>
              <div className="rounded border border-border bg-bg-base p-2 text-text-secondary">隐藏窗口：仅隐藏界面，不停止内嵌服务。</div>
              <div className="rounded border border-border bg-bg-base p-2 text-text-secondary">退出应用：先关闭内嵌服务，再退出进程。</div>
            </div>
          </aside>
        </div>

        <div className="flex flex-col gap-2 border-t border-border-subtle pt-4 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            onClick={handleCheck}
            disabled={checkDisabled}
            aria-label="检查应用更新"
            className={`inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${getPrimaryButtonClass()}`}
          >
            {actionPhase === "check" || phase === "checking" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {phase === "up-to-date" || phase === "error" ? "重新检查" : "检查更新"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloadDisabled}
            aria-label="下载应用更新"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-bg-base px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionPhase === "download" || phase === "downloading" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            下载更新
          </button>
          <button
            type="button"
            onClick={handleInstallAndRestart}
            disabled={installDisabled}
            aria-label="安装应用更新并重启"
            className={`inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${getPrimaryButtonClass("success")}`}
          >
            {actionPhase === "install" || phase === "installing" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            安装并重启
          </button>
          <button
            type="button"
            onClick={handleOpenReleasePage}
            disabled={releaseDisabled}
            aria-label="打开官方 Release 下载页"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-bg-base px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionPhase === "release" ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
            打开下载页
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}
