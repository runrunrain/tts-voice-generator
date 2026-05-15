import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopActionResult,
  DesktopPlatformCapabilities,
  DesktopUpdateCheckResult,
  DesktopUpdateEvent,
  DesktopUpdateState,
} from "./desktop-contracts";

const desktopApi = {
  getApiHeaders: async (): Promise<{ "X-TTS-Desktop-Token": string }> => {
    return ipcRenderer.invoke("tts-desktop:get-api-headers");
  },
  getServerStatus: async (): Promise<{ running: boolean; port: number | null }> => {
    return ipcRenderer.invoke("tts-desktop:get-server-status");
  },
  openDataDirectory: async (): Promise<DesktopActionResult> => {
    return ipcRenderer.invoke("tts-desktop:open-data-directory");
  },
  openOpenCodeConfig: async (): Promise<DesktopActionResult> => {
    return ipcRenderer.invoke("tts-desktop:open-opencode-config");
  },
  getPlatformCapabilities: async (): Promise<DesktopPlatformCapabilities> => {
    return ipcRenderer.invoke("tts-desktop:get-platform-capabilities");
  },
  update: {
    getState: async (): Promise<DesktopUpdateState> => {
      return ipcRenderer.invoke("tts-desktop:update:get-state");
    },
    check: async (): Promise<DesktopUpdateCheckResult> => {
      return ipcRenderer.invoke("tts-desktop:update:check");
    },
    download: async (): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke("tts-desktop:update:download");
    },
    installAndRestart: async (): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke("tts-desktop:update:install-and-restart");
    },
    openReleasePage: async (): Promise<DesktopActionResult> => {
      return ipcRenderer.invoke("tts-desktop:update:open-release-page");
    },
    onEvent: (callback: (event: DesktopUpdateEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, updateEvent: DesktopUpdateEvent) => {
        callback(updateEvent);
      };
      ipcRenderer.on("tts-desktop:update:event", listener);
      return () => {
        ipcRenderer.removeListener("tts-desktop:update:event", listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld("ttsDesktop", desktopApi);
