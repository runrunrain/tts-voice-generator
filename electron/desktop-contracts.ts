export type DesktopActionResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

export type DesktopUpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type DesktopPlatformCapabilities = {
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
  packaged: boolean;
  systemTraySupported: boolean;
  hideOnCloseSupported: boolean;
  backgroundResidentSupported: boolean;
  singleInstanceSupported: boolean;
  updateCheckSupported: boolean;
  updateDownloadSupported: boolean;
  updateInstallSupported: boolean;
  updateInstallUnsupportedReason?: string;
  updateProvider: "generic";
  releasePageUrl: string;
};

export type DesktopUpdateInfo = {
  version: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string;
};

export type DesktopDownloadProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type DesktopUpdateState = {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  updateInfo?: DesktopUpdateInfo;
  progress?: DesktopDownloadProgress;
  error?: string;
  lastCheckedAt?: string;
};

export type DesktopUpdateCheckResult =
  | { ok: true; state: DesktopUpdateState }
  | { ok: false; code: string; error: string; state: DesktopUpdateState };

export type DesktopUpdateEvent =
  | { type: "state"; state: DesktopUpdateState }
  | { type: "progress"; state: DesktopUpdateState; progress: DesktopDownloadProgress };

export type QuitReason = "tray" | "system" | "update" | "startup-failure";
