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
  responseFormat?: "mp3" | "pcm";
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
    if (req.providerOptions) {
      body.provider = req.providerOptions;
    }

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
            errorMessage: `Expected audio response but got ${contentType}: ${text.slice(0, 500)}`,
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
          : (err instanceof Error ? err.message : "Unknown network error"),
        retryable: true,
      };
    }
  }

  /**
   * Test API Key validity by fetching the models list.
   * Returns latency in ms. No retry on test connections.
   */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/models`, {
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
          },
          signal: controller.signal,
        });

        const latencyMs = Date.now() - start;

        if (response.ok) {
          return { ok: true, latencyMs };
        }

        const body = await response.text();
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : "Network error",
      };
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitize error metadata: remove sensitive fields like Authorization headers,
 * API keys, or other credentials from error data before storing/returning.
 */
function sanitizeErrorMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = new Set([
    "authorization",
    "api_key",
    "apikey",
    "key",
    "token",
    "secret",
    "password",
    "credential",
  ]);

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeErrorMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(data: Record<string, unknown>): string {
  // OpenRouter error format: { error: { message: "..." } }
  if (data.error && typeof data.error === "object") {
    const err = data.error as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
  }
  if (typeof data.message === "string") return data.message;
  if (typeof data.error === "string") return data.error;
  return JSON.stringify(data).slice(0, 300);
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

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const num = parseInt(value, 10);
  if (!isNaN(num)) return num;
  return undefined;
}
