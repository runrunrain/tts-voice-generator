/**
 * OpenRouter TTS Provider
 *
 * Handles real HTTP communication with OpenRouter's /api/v1/audio/speech endpoint.
 * Correctly handles:
 * - Raw audio stream success responses (2xx + audio content-type)
 * - Non-2xx JSON error responses
 * - X-Generation-Id header extraction
 * - Error classification (client vs server, retryable)
 */

import { env, requireApiKey } from "../config/env.js";

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
}

export type OpenRouterTtsResult = OpenRouterTtsSuccess | OpenRouterTtsError;

// ─── Provider ────────────────────────────────────────────────────────────────

export class OpenRouterProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || requireApiKey();
    this.baseUrl = baseUrl || env.openRouterBaseUrl;
  }

  /**
   * Generate speech via OpenRouter TTS API.
   *
   * Response handling:
   * - 2xx + Content-Type includes "audio" -> read body as Buffer (success)
   * - 2xx + Content-Type is JSON -> treat as unexpected error
   * - Non-2xx -> read body as JSON error
   */
  async generateSpeech(req: OpenRouterTtsRequest): Promise<OpenRouterTtsResult> {
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
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
        errorMetadata: errorData.error ? (errorData.error as Record<string, unknown>) : errorData,
        retryable,
        retryAfter,
      };
    } catch (err) {
      // Network-level error (DNS, timeout, etc.)
      return {
        ok: false,
        statusCode: 0,
        errorCode: "NETWORK_ERROR",
        errorMessage: err instanceof Error ? err.message : "Unknown network error",
        retryable: true,
      };
    }
  }

  /**
   * Test API Key validity by fetching the models list.
   * Returns latency in ms.
   */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
        },
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
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
