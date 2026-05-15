import type {
  DesktopActionResult,
  DesktopPlatformCapabilities,
  DesktopUpdateCheckResult,
  DesktopUpdateEvent,
  DesktopUpdateState,
} from "../../../electron/desktop-contracts";

export type TtsDesktopBridge = {
  getApiHeaders: () => Promise<{ "X-TTS-Desktop-Token": string }>;
  getServerStatus: () => Promise<{ running: boolean; port: number | null }>;
  openDataDirectory: () => Promise<DesktopActionResult>;
  openOpenCodeConfig: () => Promise<DesktopActionResult>;
  getPlatformCapabilities: () => Promise<DesktopPlatformCapabilities>;
  update: {
    getState: () => Promise<DesktopUpdateState>;
    check: () => Promise<DesktopUpdateCheckResult>;
    download: () => Promise<DesktopActionResult>;
    installAndRestart: () => Promise<DesktopActionResult>;
    openReleasePage: () => Promise<DesktopActionResult>;
    onEvent: (callback: (event: DesktopUpdateEvent) => void) => () => void;
  };
};

declare global {
  interface Window {
    ttsDesktop?: TtsDesktopBridge;
  }
}

export function getDesktopBridge() {
  return typeof window === "undefined" ? undefined : window.ttsDesktop;
}

export function isDesktop() {
  return Boolean(getDesktopBridge());
}

export function hasDesktopUpdateBridge() {
  const bridge = getDesktopBridge();
  return Boolean(
    bridge?.getPlatformCapabilities
    && bridge.update?.getState
    && bridge.update.check
    && bridge.update.download
    && bridge.update.installAndRestart
    && bridge.update.openReleasePage
    && bridge.update.onEvent,
  );
}

export async function getDesktopPlatformCapabilities() {
  return getDesktopBridge()?.getPlatformCapabilities();
}

export async function getDesktopUpdateState() {
  return getDesktopBridge()?.update.getState();
}

export async function checkDesktopUpdate() {
  return getDesktopBridge()?.update.check();
}

export async function downloadDesktopUpdate() {
  return getDesktopBridge()?.update.download();
}

export async function installDesktopUpdateAndRestart() {
  return getDesktopBridge()?.update.installAndRestart();
}

export async function openDesktopReleasePage() {
  return getDesktopBridge()?.update.openReleasePage();
}
