import { contextBridge, ipcRenderer } from "electron";

const desktopApi = {
  getApiHeaders: async (): Promise<{ "X-TTS-Desktop-Token": string }> => {
    return ipcRenderer.invoke("tts-desktop:get-api-headers");
  },
  getServerStatus: async (): Promise<{ running: boolean; port: number | null }> => {
    return ipcRenderer.invoke("tts-desktop:get-server-status");
  },
  openDataDirectory: async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    return ipcRenderer.invoke("tts-desktop:open-data-directory");
  },
};

contextBridge.exposeInMainWorld("ttsDesktop", desktopApi);
