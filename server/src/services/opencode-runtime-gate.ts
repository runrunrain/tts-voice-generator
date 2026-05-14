import crypto from "node:crypto";

export type OpenCodeRuntime = "desktop" | "local" | "web" | "remote";

export interface OpenCodeRuntimeCapabilities {
  runtime: OpenCodeRuntime;
  canDetectLocalOpenCode: boolean;
  canReadConfig: boolean;
  canWriteConfig: boolean;
  canInstall: boolean;
  canOpenConfig: boolean;
  canReturnConfigPathForCopy: boolean;
  reason: string | null;
}

const DESKTOP_TOKEN_HEADER = "X-TTS-Desktop-Token";

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function hostnameFromHostHeader(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end).toLowerCase() : null;
  }
  return trimmed.split(":")[0].toLowerCase();
}

function isLoopbackHostname(hostname: string | null): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isLoopbackOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function forwardedHeadersAreLocal(headers: Headers): boolean {
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost && !isLoopbackHostname(hostnameFromHostHeader(forwardedHost.split(",")[0]))) {
    return false;
  }

  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0].trim().replace(/^\[|\]$/g, "");
    if (!isLoopbackHostname(first)) return false;
  }

  const forwarded = headers.get("forwarded");
  if (forwarded && /for=|host=/i.test(forwarded)) {
    const firstSegment = forwarded.split(",")[0];
    const hostMatch = firstSegment.match(/host="?([^;,"]+)"?/i);
    if (hostMatch && !isLoopbackHostname(hostnameFromHostHeader(hostMatch[1]))) return false;
    const forMatch = firstSegment.match(/for="?([^;,"]+)"?/i);
    if (forMatch && !isLoopbackHostname(hostnameFromHostHeader(forMatch[1]))) return false;
  }

  return true;
}

function isAuthenticatedDesktopRequest(headers: Headers, env: NodeJS.ProcessEnv): boolean {
  const token = env.DESKTOP_API_TOKEN;
  const provided = headers.get(DESKTOP_TOKEN_HEADER) ?? "";
  return env.ELECTRON_MODE === "true" && !!token && !!provided && timingSafeEqualString(provided, token);
}

function capabilitiesFor(runtime: OpenCodeRuntime, reason: string | null): OpenCodeRuntimeCapabilities {
  if (runtime === "desktop") {
    return {
      runtime,
      canDetectLocalOpenCode: true,
      canReadConfig: true,
      canWriteConfig: true,
      canInstall: true,
      canOpenConfig: true,
      canReturnConfigPathForCopy: false,
      reason,
    };
  }

  if (runtime === "local") {
    return {
      runtime,
      canDetectLocalOpenCode: true,
      canReadConfig: true,
      canWriteConfig: true,
      canInstall: true,
      canOpenConfig: false,
      canReturnConfigPathForCopy: true,
      reason,
    };
  }

  return {
    runtime,
    canDetectLocalOpenCode: false,
    canReadConfig: false,
    canWriteConfig: false,
    canInstall: false,
    canOpenConfig: false,
    canReturnConfigPathForCopy: false,
    reason,
  };
}

export function getOpenCodeRuntimeCapabilities(request: Request, env: NodeJS.ProcessEnv = process.env): OpenCodeRuntimeCapabilities {
  const headers = request.headers;

  if (isAuthenticatedDesktopRequest(headers, env)) {
    return capabilitiesFor("desktop", null);
  }

  const hostHeader = headers.get("host") ?? (() => {
    try { return new URL(request.url).host; } catch { return null; }
  })();
  const hostIsLoopback = isLoopbackHostname(hostnameFromHostHeader(hostHeader));
  const originIsLoopback = isLoopbackOrigin(headers.get("origin"));
  const forwardedIsLocal = forwardedHeadersAreLocal(headers);

  if (!hostIsLoopback || !originIsLoopback || !forwardedIsLocal) {
    return capabilitiesFor("remote", "当前请求不是可信本机访问，已禁用本地 OpenCode 能力。");
  }

  if (env.OPENCODE_LOCAL_CAPABILITIES === "enabled") {
    return capabilitiesFor("local", null);
  }

  return capabilitiesFor("web", "当前运行环境未启用本机 OpenCode 能力，请使用桌面版或显式启用本机开发模式。");
}

export function assertOpenCodeCapability(
  capabilities: OpenCodeRuntimeCapabilities,
  capability: keyof Pick<OpenCodeRuntimeCapabilities, "canDetectLocalOpenCode" | "canReadConfig" | "canWriteConfig" | "canInstall" | "canOpenConfig" | "canReturnConfigPathForCopy">,
): void {
  if (!capabilities[capability]) {
    throw new Error(capabilities.reason ?? "当前运行环境不支持此 OpenCode 本地能力。");
  }
}
