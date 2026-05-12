/**
 * OpenRouter TTS Provider
 *
 * Handles real HTTP communication with OpenRouter's /api/v1/audio/speech endpoint.
 * Correctly handles:
 * - Raw audio stream success responses (2xx + audio content-type)
 * - Non-2xx JSON error responses
 * - X-Generation-Id header extraction
 * - Error classification (client vs server, retryable)
 * - Exponential backoff retry for retryable errors (429, 5xx, network)
 * - Retry-After header respect
 * - Request timeout
 */

import { env } from "../config/env.js";
import { requireApiKey } from "./key-resolver.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenRouterTtsRequest {
  model: string;
  input: string;
  voice: string;
  responseFormat?: "mp3" | "pcm" | "wav";
  speed?: number;
  providerOptions?: Record<string, unknown>;
}

export interface OpenRouterTtsSuccess {
  ok: true;
  audioBuffer: Buffer;
  contentType: string;
  generationId: string | null;
}

export interface OpenRouterTtsError {
  ok: false;
  statusCode: number;
  errorCode: string;
  errorMessage: string;
  errorMetadata?: Record<string, unknown>;
  retryable: boolean;
  retryAfter?: number;
  attempts?: number;
}

export type OpenRouterTtsResult = OpenRouterTtsSuccess | OpenRouterTtsError;

export type OpenRouterConnectionErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_API_KEY"
  | "INSUFFICIENT_CREDITS"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "UNEXPECTED_RESPONSE_TYPE"
  | "BAD_REQUEST"
  | "UNKNOWN";

export interface OpenRouterConnectionTestResult {
  ok: boolean;
  provider: "openrouter";
  checkedEndpoint: "audio_speech";
  latencyMs: number;
  modelAvailable: boolean;
  authValid: boolean;
  errorCode?: OpenRouterConnectionErrorCode;
  errorMessage?: string;
  providerMessage?: string;
  actionMessage?: string;
  error?: string | null;
}

export interface OpenRouterConnectionTestOptions {
  model?: string;
  voice?: string;
  responseFormat?: "mp3" | "pcm" | "wav";
}

// ─── Retry Configuration ─────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;   // 1 second initial delay
const DEFAULT_MAX_DELAY_MS = 30000;   // 30 seconds max delay
const DEFAULT_TIMEOUT_MS = 60000;     // 60 seconds per request

// ─── Provider ────────────────────────────────────────────────────────────────

export class OpenRouterProvider {
  private apiKey: string;
  private baseUrl: string;
  private maxAttempts: number;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private timeoutMs: number;

  constructor(apiKey?: string, baseUrl?: string, options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    timeoutMs?: number;
  }) {
    this.apiKey = apiKey || requireApiKey();
    this.baseUrl = baseUrl || env.openRouterBaseUrl;
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Generate speech via OpenRouter TTS API with retry support.
   *
   * Retry policy:
   * - Only retry on retryable errors (429, 5xx, network)
   * - Exponential backoff: base * 2^attempt + jitter
   * - Respect Retry-After header for 429
   * - Maximum attempts controlled by maxAttempts
   * - Each attempt has its own timeout covering headers AND body reading
   */
  async generateSpeech(req: OpenRouterTtsRequest): Promise<OpenRouterTtsResult> {
    let lastResult: OpenRouterTtsError | null = null;
    let attempt = 0;

    while (attempt < this.maxAttempts) {
      attempt++;
      const result = await this.singleAttempt(req);

      // Success - return immediately
      if (result.ok) {
        return result;
      }

      // Non-retryable error - return immediately
      if (!result.retryable) {
        return { ...result, attempts: attempt };
      }

      lastResult = result;

      // If this was the last allowed attempt, don't sleep
      if (attempt >= this.maxAttempts) {
        break;
      }

      // Calculate delay
      const delay = this.calculateDelay(attempt, result.retryAfter);
      await sleep(delay);
    }

    // All retries exhausted
    return {
      ...lastResult!,
      attempts: attempt,
    };
  }

  /**
   * Single attempt to generate speech (no retry).
   */
  private async singleAttempt(req: OpenRouterTtsRequest): Promise<OpenRouterTtsResult> {
    const url = `${this.baseUrl}/audio/speech`;

    const body: Record<string, unknown> = {
      model: req.model,
      input: req.input,
      voice: req.voice,
    };

    if (req.responseFormat) {
      body.response_format = req.responseFormat;
    }
    if (req.speed !== undefined) {
      body.speed = req.speed;
    }
    applyProviderOptions(body, req.providerOptions);

    try {
      // Use AbortController for timeout covering the full attempt
      // (headers + body reading). Timer is only cleared in finally,
      // so body hang will be caught by the abort.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const contentType = response.headers.get("content-type") || "";

        // Extract X-Generation-Id
        const generationId = response.headers.get("x-generation-id");

        if (response.ok && contentType.includes("audio")) {
          // Success: read audio body as ArrayBuffer -> Buffer
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = Buffer.from(arrayBuffer);

          return {
            ok: true,
            audioBuffer,
            contentType,
            generationId,
          };
        }

        if (response.ok && !contentType.includes("audio")) {
          // 2xx but not audio - unexpected, treat as error
          const text = await response.text();
          return {
            ok: false,
            statusCode: response.status,
            errorCode: "UNEXPECTED_RESPONSE_TYPE",
            errorMessage: sanitizeText(`Expected audio response but got ${contentType}: ${text.slice(0, 500)}`),
            retryable: false,
          };
        }

        // Non-2xx: read JSON error body
        let errorData: Record<string, unknown>;
        try {
          errorData = await response.json() as Record<string, unknown>;
        } catch {
          const text = await response.text();
          errorData = { message: text.slice(0, 500) };
        }

        const errorMsg = extractErrorMessage(errorData);
        const retryable = response.status === 429 || response.status >= 500;
        const retryAfter = response.status === 429
          ? parseRetryAfter(response.headers.get("retry-after"))
          : undefined;

        return {
          ok: false,
          statusCode: response.status,
          errorCode: classifyErrorCode(response.status, errorData),
          errorMessage: errorMsg,
          errorMetadata: sanitizeErrorMetadata(errorData),
          retryable,
          retryAfter,
        };
      } finally {
        // Timer covers headers AND body reading; clean up only when
        // the entire attempt is done (success, error, or abort).
        clearTimeout(timeoutId);
      }
    } catch (err) {
      // Network-level error (DNS, timeout, abort, etc.)
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      return {
        ok: false,
        statusCode: 0,
        errorCode: isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        errorMessage: isTimeout
          ? `Request timed out after ${this.timeoutMs}ms`
          : sanitizeText(err instanceof Error ? err.message : "Unknown network error"),
        retryable: true,
      };
    }
  }

  /**
   * Test API Key validity against the real audio authentication path.
   *
   * /models is only a best-effort model availability signal because it can be
   * public or permissive for invalid keys. The final ok/authValid result is
   * decided by a tiny /audio/speech probe, without creating generation_job or
   * persisting audio assets.
   */
  async testConnection(options: OpenRouterConnectionTestOptions = {}): Promise<OpenRouterConnectionTestResult> {
    const start = Date.now();
    const modelAvailable = await this.checkModelsAvailable();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: options.model ?? "google/gemini-3.1-flash-tts-preview",
            input: ".",
            voice: options.voice ?? "Zephyr",
            response_format: options.responseFormat ?? "pcm",
          }),
          signal: controller.signal,
        });

        const latencyMs = Date.now() - start;
        const contentType = response.headers.get("content-type") || "";

        if (response.ok && contentType.includes("audio")) {
          await response.arrayBuffer();
          return {
            ok: true,
            provider: "openrouter",
            checkedEndpoint: "audio_speech",
            latencyMs,
            modelAvailable,
            authValid: true,
            error: null,
          };
        }

        if (response.ok) {
          const text = await response.text();
          const providerMessage = sanitizeText(`Expected audio response but got ${contentType}: ${text.slice(0, 200)}`);
          return buildConnectionFailure({
            latencyMs,
            modelAvailable,
            authValid: true,
            errorCode: "UNEXPECTED_RESPONSE_TYPE",
            providerMessage,
          });
        }

        let errorData: Record<string, unknown>;
        try {
          errorData = await response.json() as Record<string, unknown>;
        } catch {
          const text = await response.text();
          errorData = { message: text.slice(0, 500) };
        }

        const providerMessage = extractErrorMessage(errorData);
        return buildConnectionFailure({
          latencyMs,
          modelAvailable,
          authValid: false,
          errorCode: classifyConnectionErrorCode(response.status, errorData),
          providerMessage,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      return {
        ok: false,
        provider: "openrouter",
        checkedEndpoint: "audio_speech",
        latencyMs: Date.now() - start,
        modelAvailable,
        authValid: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        errorMessage: isTimeout ? "OpenRouter 音频认证探针超时。" : "OpenRouter 音频认证探针暂不可用。",
        providerMessage: isTimeout ? `Request timed out after ${this.timeoutMs}ms` : sanitizeText(err instanceof Error ? err.message : "Network error"),
        actionMessage: "请稍后重试；如果持续失败，请检查网络连接或 OpenRouter 服务状态。",
        error: isTimeout ? "PROVIDER_UNAVAILABLE: request timed out" : "PROVIDER_UNAVAILABLE",
      };
    }
  }

  private async checkModelsAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 10000));
      try {
        const response = await fetch(`${this.baseUrl}/models`, {
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
          },
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return false;
    }
  }

  /**
   * Calculate delay for retry attempt using exponential backoff with jitter.
   * Respects Retry-After header when present.
   */
  private calculateDelay(attempt: number, retryAfter?: number): number {
    // If server sent Retry-After, use it (but cap at maxDelay)
    if (retryAfter !== undefined) {
      const retryAfterMs = retryAfter * 1000;
      return Math.min(retryAfterMs, this.maxDelayMs);
    }

    // Exponential backoff: base * 2^(attempt-1) + random jitter
    const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * this.baseDelayMs;
    return Math.min(exponentialDelay + jitter, this.maxDelayMs);
  }
}

function applyProviderOptions(body: Record<string, unknown>, providerOptions?: Record<string, unknown>): void {
  if (!providerOptions) return;

  const { provider, ...topLevelOptions } = providerOptions;
  const nativeOptions: Record<string, unknown> = {};
  const routingOptions: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(topLevelOptions)) {
    if (OPENROUTER_NATIVE_TOP_LEVEL_KEYS.has(key)) {
      nativeOptions[key] = value;
      continue;
    }
    if (OPENROUTER_REQUEST_RESERVED_KEYS.has(key)) {
      continue;
    }
    routingOptions[key] = value;
  }

  // Preserve the OpenRouter routing-object use case when callers pass provider
  // routing explicitly, while allowing model/provider-native request fields such
  // as Gemini `generationConfig` to be sent at the request top level.
  if (provider && typeof provider === "object" && !Array.isArray(provider)) {
    body.provider = { ...routingOptions, ...(provider as Record<string, unknown>) };
  } else if (Object.keys(routingOptions).length > 0) {
    body.provider = routingOptions;
  }

  for (const [key, value] of Object.entries(nativeOptions)) {
    body[key] = value;
  }
}

const OPENROUTER_NATIVE_TOP_LEVEL_KEYS = new Set([
  "generationConfig",
]);

const OPENROUTER_REQUEST_RESERVED_KEYS = new Set([
  "model",
  "input",
  "voice",
  "response_format",
  "responseFormat",
  "speed",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sensitive key names for metadata redaction.
 * Any object property matching one of these (case-insensitive) will be fully redacted.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "key",
  "token",
  "secret",
  "password",
  "credential",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
]);

/**
 * Sanitize error metadata: remove sensitive fields like Authorization headers,
 * API keys, or other credentials from error data before storing/returning.
 * Uses unified recursive sanitization for arbitrary-depth objects/arrays/strings.
 */
function sanitizeErrorMetadata(data: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(data);
}

/**
 * Recursively sanitize an object's entries.
 * Sensitive key names are redacted; string values are sanitized for credential patterns.
 */
function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = sanitizeEntry(key, value);
  }
  return result;
}

/**
 * Unified recursive sanitization for a single key-value pair.
 * - Sensitive key -> [REDACTED] regardless of value type
 * - String -> sanitizeText() for credential pattern redaction
 * - Object -> recurse into properties
 * - Array -> recurse into each element
 * - Primitives (number, boolean, null, undefined) -> pass through
 */
function sanitizeEntry(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEntry("", item));
  }
  if (typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(data: Record<string, unknown>): string {
  // OpenRouter error format: { error: { message: "..." } }
  let raw: string;
  if (data.error && typeof data.error === "object") {
    const err = data.error as Record<string, unknown>;
    if (typeof err.message === "string") {
      raw = err.message;
    } else {
      raw = typeof data.message === "string" ? data.message
        : typeof data.error === "string" ? data.error
        : JSON.stringify(sanitizeErrorMetadata(data)).slice(0, 300);
    }
  } else if (typeof data.message === "string") {
    raw = data.message;
  } else if (typeof data.error === "string") {
    raw = data.error;
  } else {
    raw = JSON.stringify(sanitizeErrorMetadata(data)).slice(0, 300);
  }
  return sanitizeText(raw);
}

/**
 * Sanitize text by redacting sensitive patterns that could leak API keys
 * or auth tokens from upstream error messages.
 *
 * Patterns covered:
 *   - "Bearer sk-..." / "Bearer ..."
 *   - "sk-..." (OpenAI-style keys)
 *   - "apiKey=..." / "api_key=..."
 *   - "access_token=..."
 *   - "authorization_header=..."
 *
 * Designed to be conservative: only removes known credential patterns,
 * preserving ordinary error messages for debugging.
 */
export function sanitizeText(text: string): string {
  return text
    // "Bearer sk-<secret>" or "Bearer <long-token>"
    .replace(/Bearer\s+[A-Za-z0-9_\-]{8,}/gi, "Bearer [REDACTED]")
    // "Bearer <anything-looking-like-token>"
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    // sk-<key> (OpenAI / OpenRouter key prefix)
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "sk-[REDACTED]")
    // apiKey=... / api_key=...
    .replace(/\bapi[_-]?key\s*=\s*\S+/gi, "api_key=[REDACTED]")
    // access_token=...
    .replace(/\baccess_token\s*=\s*\S+/gi, "access_token=[REDACTED]")
    // authorization_header=...
    .replace(/\bauthorization_header\s*=\s*\S+/gi, "authorization_header=[REDACTED]");
}

function classifyErrorCode(status: number, data: Record<string, unknown>): string {
  // Check for known error codes in response body
  if (data.error && typeof data.error === "object") {
    const err = data.error as Record<string, unknown>;
    if (typeof err.code === "string") return err.code;
  }
  if (typeof data.code === "string") return data.code;

  // Classify by HTTP status
  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401: return "INVALID_API_KEY";
    case 402: return "INSUFFICIENT_CREDITS";
    case 403: return "FORBIDDEN";
    case 404: return "MODEL_NOT_FOUND";
    case 429: return "RATE_LIMITED";
    case 500: return "PROVIDER_ERROR";
    case 502: return "BAD_GATEWAY";
    case 503: return "SERVICE_UNAVAILABLE";
    default: return `HTTP_${status}`;
  }
}

function classifyConnectionErrorCode(status: number, data: Record<string, unknown>): OpenRouterConnectionErrorCode {
  const bodyCode = readProviderErrorCode(data);
  if (bodyCode === "INSUFFICIENT_CREDITS") return "INSUFFICIENT_CREDITS";
  if (bodyCode === "RATE_LIMITED") return "RATE_LIMITED";
  if (bodyCode === "INVALID_API_KEY" || bodyCode === "UNAUTHORIZED" || bodyCode === "FORBIDDEN") return "INVALID_API_KEY";

  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401:
    case 403:
      return "INVALID_API_KEY";
    case 402: return "INSUFFICIENT_CREDITS";
    case 429: return "RATE_LIMITED";
    case 500:
    case 502:
    case 503:
    case 504:
      return "PROVIDER_UNAVAILABLE";
    default: return "UNKNOWN";
  }
}

function readProviderErrorCode(data: Record<string, unknown>): string | null {
  if (data.error && typeof data.error === "object") {
    const err = data.error as Record<string, unknown>;
    if (typeof err.code === "string") return err.code;
  }
  return typeof data.code === "string" ? data.code : null;
}

function buildConnectionFailure(args: {
  latencyMs: number;
  modelAvailable: boolean;
  authValid: boolean;
  errorCode: OpenRouterConnectionErrorCode;
  providerMessage?: string;
}): OpenRouterConnectionTestResult {
  const providerMessage = args.providerMessage ? sanitizeText(args.providerMessage) : undefined;
  const { errorMessage, actionMessage } = connectionErrorCopy(args.errorCode);
  return {
    ok: false,
    provider: "openrouter",
    checkedEndpoint: "audio_speech",
    latencyMs: args.latencyMs,
    modelAvailable: args.modelAvailable,
    authValid: args.authValid,
    errorCode: args.errorCode,
    errorMessage,
    providerMessage,
    actionMessage,
    error: `${args.errorCode}${providerMessage ? `: ${providerMessage}` : ""}`,
  };
}

function connectionErrorCopy(errorCode: OpenRouterConnectionErrorCode): { errorMessage: string; actionMessage: string } {
  switch (errorCode) {
    case "MISSING_API_KEY":
      return {
        errorMessage: "OpenRouter API Key 未配置。",
        actionMessage: "请先在 Settings 保存 OpenRouter API Key。",
      };
    case "INVALID_API_KEY":
      return {
        errorMessage: "OpenRouter API Key 无效、已过期或账户不可用。",
        actionMessage: "请到 Settings 更新 API Key，并检查 OpenRouter 账户状态或余额。",
      };
    case "INSUFFICIENT_CREDITS":
      return {
        errorMessage: "OpenRouter 账户额度或计费状态异常。",
        actionMessage: "请检查 OpenRouter 账户余额、额度限制或计费状态。",
      };
    case "RATE_LIMITED":
      return {
        errorMessage: "OpenRouter 请求过于频繁。",
        actionMessage: "请稍后重试，或检查 OpenRouter 账户的速率限制。",
      };
    case "PROVIDER_UNAVAILABLE":
      return {
        errorMessage: "OpenRouter 音频认证探针暂不可用。",
        actionMessage: "请稍后重试；如果持续失败，请检查网络连接或 OpenRouter 服务状态。",
      };
    case "UNEXPECTED_RESPONSE_TYPE":
      return {
        errorMessage: "OpenRouter 音频认证探针返回了非音频响应。",
        actionMessage: "请检查默认模型/音色是否支持音频生成，或稍后重试。",
      };
    case "BAD_REQUEST":
      return {
        errorMessage: "OpenRouter 音频认证探针请求被拒绝。",
        actionMessage: "请检查默认模型和音色设置是否支持音频生成。",
      };
    default:
      return {
        errorMessage: "OpenRouter 连接测试失败。",
        actionMessage: "请检查 API Key、账户状态和 OpenRouter 服务状态后重试。",
      };
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const num = parseInt(value, 10);
  if (!isNaN(num)) return num;
  return undefined;
}
