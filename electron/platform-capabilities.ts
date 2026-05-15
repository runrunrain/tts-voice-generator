import { app } from "electron";
import type { DesktopPlatformCapabilities } from "./desktop-contracts";

const DEFAULT_GITHUB_REPOSITORY = "maorun/tts-voice-generator";

function resolveGitHubRepository() {
  const rawRepository = process.env.GITHUB_REPOSITORY?.trim() || DEFAULT_GITHUB_REPOSITORY;
  const [owner, repo] = rawRepository.split("/").map((part) => part.trim());
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    const [defaultOwner, defaultRepo] = DEFAULT_GITHUB_REPOSITORY.split("/");
    return { owner: defaultOwner, repo: defaultRepo };
  }
  return { owner, repo };
}

export function getReleasePageUrl() {
  const { owner, repo } = resolveGitHubRepository();
  return `https://github.com/${owner}/${repo}/releases/latest`;
}

function isSupportedDesktopPlatform(platform: NodeJS.Platform) {
  return platform === "darwin" || platform === "win32";
}

function resolveInstallUnsupportedReason(platform: NodeJS.Platform, packaged: boolean) {
  if (!packaged) {
    return "应用内更新仅在已打包安装的桌面应用中可用。";
  }
  if (!isSupportedDesktopPlatform(platform)) {
    return "当前平台暂不支持应用内更新安装。";
  }
  if (platform === "darwin" && process.env.TTS_ENABLE_MAC_AUTO_UPDATE !== "true") {
    return "macOS 自动安装需要签名和公证；当前构建仅支持检查更新和打开下载页。";
  }
  return undefined;
}

export function getDesktopPlatformCapabilities(): DesktopPlatformCapabilities {
  const platform = process.platform;
  const packaged = app.isPackaged;
  const platformSupported = isSupportedDesktopPlatform(platform);
  const updateInstallUnsupportedReason = resolveInstallUnsupportedReason(platform, packaged);
  const updateCheckSupported = packaged && platformSupported;
  const updateInstallSupported = updateCheckSupported && !updateInstallUnsupportedReason;

  return {
    platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    packaged,
    systemTraySupported: platformSupported,
    hideOnCloseSupported: platformSupported,
    backgroundResidentSupported: platformSupported,
    singleInstanceSupported: platformSupported,
    updateCheckSupported,
    updateDownloadSupported: updateCheckSupported,
    updateInstallSupported,
    ...(updateInstallUnsupportedReason ? { updateInstallUnsupportedReason } : {}),
    updateProvider: "github",
    releasePageUrl: getReleasePageUrl(),
  };
}

export function isTrustedReleasePageUrl(url: string) {
  const releasePageUrl = new URL(getReleasePageUrl());
  const candidate = new URL(url);
  return candidate.protocol === "https:"
    && candidate.hostname === "github.com"
    && candidate.pathname === releasePageUrl.pathname;
}
