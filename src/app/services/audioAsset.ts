import { ApiError, apiRequest } from "./httpAdapter";

export type AudioObjectUrl = {
  objectUrl: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  revoke: () => void;
};

type FetchAudioOptions = {
  download?: boolean;
  fallbackFileName?: string;
};

const AUDIO_API_PREFIX = "/api/audio/";
const DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS = 30_000;

function assertBrowserRuntime() {
  if (typeof window === "undefined" || typeof URL === "undefined") {
    throw new Error("音频资源只能在浏览器窗口中访问");
  }
}

function toSameOriginAudioApiPath(audioUrl: string, download: boolean): string {
  assertBrowserRuntime();
  const parsed = new URL(audioUrl, window.location.href);
  if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith(AUDIO_API_PREFIX)) {
    throw new Error("拒绝访问非同源音频资源");
  }
  if (download) parsed.searchParams.set("download", "1");
  else parsed.searchParams.delete("download");
  return `${parsed.pathname}${parsed.search}`;
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }

  const quoted = disposition.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const plain = disposition.match(/filename=([^;]+)/i);
  return plain?.[1]?.trim() || fallback;
}

function extensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("pcm")) return "pcm";
  return "wav";
}

async function fetchAudioBlob(audioUrl: string, options: FetchAudioOptions = {}) {
  const path = toSameOriginAudioApiPath(audioUrl, options.download === true);
  const response = await apiRequest(path, { method: "GET" });
  if (!response.ok) {
    throw new ApiError(response.status, `音频请求失败 (HTTP ${response.status})`, null);
  }

  const blob = await response.blob();
  const mimeType = response.headers.get("Content-Type") ?? blob.type ?? "audio/wav";
  const fallbackFileName = options.fallbackFileName ?? `audio.${extensionFromMime(mimeType)}`;
  const fileName = filenameFromDisposition(response.headers.get("Content-Disposition"), fallbackFileName);
  return { blob, mimeType, fileName };
}

export async function createAudioObjectUrl(audioUrl: string, options: FetchAudioOptions = {}): Promise<AudioObjectUrl> {
  const { blob, mimeType, fileName } = await fetchAudioBlob(audioUrl, options);
  const objectUrl = URL.createObjectURL(blob);
  let revoked = false;
  return {
    objectUrl,
    blob,
    fileName,
    mimeType,
    revoke: () => {
      if (revoked) return;
      URL.revokeObjectURL(objectUrl);
      revoked = true;
    },
  };
}

export async function createAudioElementFromAsset(audioUrl: string): Promise<{ audio: HTMLAudioElement; cleanup: () => void }> {
  const object = await createAudioObjectUrl(audioUrl);
  const audio = new Audio(object.objectUrl);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    object.revoke();
  };
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", cleanup, { once: true });
  return { audio, cleanup };
}

export async function downloadAudioAsset(audioUrl: string, fallbackFileName?: string): Promise<void> {
  const object = await createAudioObjectUrl(audioUrl, { download: true, fallbackFileName });
  const link = document.createElement("a");
  link.href = object.objectUrl;
  link.download = object.fileName || fallbackFileName || "audio.wav";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(object.revoke, DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS);
}

export const audioAssetTestExports = {
  toSameOriginAudioApiPath,
};
