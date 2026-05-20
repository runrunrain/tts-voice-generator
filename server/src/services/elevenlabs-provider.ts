import { env } from "../config/env.js";
import { sanitizeText } from "./openrouter-provider.js";
import { buildMissingProviderKey, type ProviderAdapterResult } from "./provider-adapter.js";

export interface ElevenLabsStsInput {
  baseAudio: Buffer;
  voiceId: string;
  modelId?: string;
  outputFormat?: string;
  voiceSettings?: Record<string, unknown>;
}

export class ElevenLabsProvider {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string | null, baseUrl = env.elevenLabsBaseUrl, timeoutMs = 60000) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async convertSpeech(input: ElevenLabsStsInput): Promise<ProviderAdapterResult> {
    const started = Date.now();
    if (!this.apiKey) return buildMissingProviderKey("elevenlabs");
    if (!input.voiceId.trim()) {
      return buildAdapterFailure(started, 400, "PROVIDER_VOICE_ID_REQUIRED", "ElevenLabs voice_id is required.", false);
    }

    const form = new FormData();
    form.set("model_id", input.modelId ?? "eleven_multilingual_sts_v2");
    form.set("audio", new Blob([new Uint8Array(input.baseAudio)], { type: "audio/wav" }), "base.wav");
    if (input.voiceSettings && Object.keys(input.voiceSettings).length > 0) {
      form.set("voice_settings", JSON.stringify(input.voiceSettings));
    }
    if (input.outputFormat) form.set("output_format", input.outputFormat);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/speech-to-speech/${encodeURIComponent(input.voiceId)}`, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
        body: form,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      const contentType = response.headers.get("content-type") ?? "";
      const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id");

      if (response.ok && contentType.includes("audio")) {
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return {
          ok: true,
          audioBuffer,
          contentType,
          providerRequestId: requestId,
          latencyMs,
          safeMetadata: {
            provider: "elevenlabs",
            endpoint: "speech-to-speech",
            modelId: input.modelId ?? "eleven_multilingual_sts_v2",
            voiceId: input.voiceId,
            responseBytes: audioBuffer.length,
          },
          costInput: { audioBytes: input.baseAudio.length },
        };
      }

      const errorData = await readSafeError(response);
      return buildAdapterFailure(
        started,
        response.status,
        classifyElevenLabsError(response.status, errorData),
        extractMessage(errorData) ?? `ElevenLabs request failed with HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
        { provider: "elevenlabs", contentType, requestId },
      );
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === "AbortError";
      return buildAdapterFailure(
        started,
        isTimeout ? 504 : 502,
        isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        isTimeout ? `ElevenLabs request timed out after ${this.timeoutMs}ms.` : sanitizeText(error instanceof Error ? error.message : "ElevenLabs network error."),
        true,
        { provider: "elevenlabs" },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readSafeError(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return { message: sanitizeText((await response.text()).slice(0, 500)) };
  }
}

function extractMessage(data: Record<string, unknown>): string | null {
  const detail = data.detail;
  if (typeof detail === "string") return sanitizeText(detail);
  if (detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).message === "string") {
    return sanitizeText((detail as Record<string, string>).message);
  }
  if (typeof data.message === "string") return sanitizeText(data.message);
  return null;
}

function classifyElevenLabsError(status: number, data: Record<string, unknown>): string {
  if (typeof data.code === "string") return sanitizeText(data.code);
  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401: return "INVALID_API_KEY";
    case 403: return "FORBIDDEN";
    case 404: return "PROVIDER_VOICE_NOT_FOUND";
    case 429: return "RATE_LIMITED";
    default: return status >= 500 ? "PROVIDER_ERROR" : `HTTP_${status}`;
  }
}

function buildAdapterFailure(
  started: number,
  statusCode: number,
  errorCode: string,
  errorMessage: string,
  retryable: boolean,
  safeMetadata?: Record<string, unknown>,
): ProviderAdapterResult {
  return {
    ok: false,
    statusCode,
    errorCode: sanitizeText(errorCode),
    errorMessage: sanitizeText(errorMessage),
    retryable,
    latencyMs: Date.now() - started,
    safeMetadata,
  };
}
