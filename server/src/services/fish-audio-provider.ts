import { env } from "../config/env.js";
import { sanitizeText } from "./openrouter-provider.js";
import { buildMissingProviderKey, type ProviderAdapterResult } from "./provider-adapter.js";

export interface FishTtsInput {
  text: string;
  referenceId: string;
  model?: string;
  format?: "wav" | "mp3" | "pcm";
}

export interface FishCreateModelInput {
  voiceAssetId: string;
  referenceAudio: Buffer;
  transcriptText: string;
  trainMode?: "fast";
  visibility?: "private";
}

export interface FishCreateModelSuccess {
  ok: true;
  fishModelId: string | null;
  referenceId: string | null;
  providerRequestId?: string | null;
  latencyMs: number;
  safeMetadata: Record<string, unknown>;
}

export type FishCreateModelResult = FishCreateModelSuccess | Extract<ProviderAdapterResult, { ok: false }>;

export class FishAudioProvider {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string | null, baseUrl = env.fishAudioBaseUrl, timeoutMs = 60000) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async generateSpeech(input: FishTtsInput): Promise<ProviderAdapterResult> {
    const started = Date.now();
    if (!this.apiKey) return buildMissingProviderKey("fish-audio");
    if (!input.referenceId.trim()) {
      return buildProviderFailure(started, 400, "FISH_REFERENCE_ID_REQUIRED", "Fish reference_id is required for fish_audio_tts.", false);
    }

    const body = {
      text: input.text,
      reference_id: input.referenceId,
      model: input.model ?? "speech-1.5",
      format: input.format ?? "wav",
    };

    const response = await this.postJson("/v1/tts", body, started);
    if (!response.ok) return response;

    if (!response.audioBuffer) {
      return buildProviderFailure(started, 502, "UNEXPECTED_RESPONSE_TYPE", "Fish response did not include audio.", false, { provider: "fish-audio" });
    }
    const contentType = response.contentType ?? "audio/wav";
    return {
      ok: true,
      audioBuffer: response.audioBuffer,
      contentType,
      providerRequestId: response.providerRequestId,
      latencyMs: response.latencyMs,
      safeMetadata: {
        provider: "fish-audio",
        endpoint: "tts",
        model: body.model,
        referenceId: input.referenceId,
        responseBytes: response.audioBuffer.length,
      },
      costInput: { inputBytes: Buffer.byteLength(input.text, "utf8") },
    };
  }

  async createModel(input: FishCreateModelInput): Promise<FishCreateModelResult> {
    const started = Date.now();
    if (!this.apiKey) return buildMissingProviderKey("fish-audio");
    if (!input.transcriptText.trim()) {
      return buildProviderFailure(started, 400, "TRANSCRIPT_NOT_CONFIRMED", "Confirmed transcript text is required before Fish model creation.", false);
    }

    const form = new FormData();
    form.set("train_mode", input.trainMode ?? "fast");
    form.set("visibility", "private");
    form.set("transcript", input.transcriptText);
    form.set("metadata", JSON.stringify({ voiceAssetId: input.voiceAssetId }));
    form.set("audio", new Blob([new Uint8Array(input.referenceAudio)], { type: "audio/wav" }), "reference.wav");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/model`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");

      if (!response.ok) {
        const data = await readSafeError(response);
        return buildProviderFailure(
          started,
          response.status,
          classifyFishError(response.status, data),
          extractMessage(data) ?? `Fish model creation failed with HTTP ${response.status}.`,
          response.status === 429 || response.status >= 500,
          { provider: "fish-audio", endpoint: "model", requestId },
        );
      }

      const data = await response.json() as Record<string, unknown>;
      const fishModelId = readString(data, ["id", "model_id", "modelId"]);
      const referenceId = readString(data, ["reference_id", "referenceId", "reference"]);
      return {
        ok: true,
        fishModelId,
        referenceId,
        providerRequestId: requestId,
        latencyMs,
        safeMetadata: {
          provider: "fish-audio",
          endpoint: "model",
          trainMode: input.trainMode ?? "fast",
          visibility: "private",
          hasFishModelId: !!fishModelId,
          hasReferenceId: !!referenceId,
        },
      };
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === "AbortError";
      return buildProviderFailure(
        started,
        isTimeout ? 504 : 502,
        isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        isTimeout ? `Fish model creation timed out after ${this.timeoutMs}ms.` : sanitizeText(error instanceof Error ? error.message : "Fish network error."),
        true,
        { provider: "fish-audio", endpoint: "model" },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postJson(path: string, body: Record<string, unknown>, started: number): Promise<ProviderAdapterResult & { audioBuffer?: Buffer; contentType?: string; providerRequestId?: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      const contentType = response.headers.get("content-type") ?? "";
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");

      if (response.ok && contentType.includes("audio")) {
        return {
          ok: true,
          audioBuffer: Buffer.from(await response.arrayBuffer()),
          contentType,
          providerRequestId: requestId,
          latencyMs,
          safeMetadata: {},
          costInput: {},
        };
      }
      if (response.ok) {
        return buildProviderFailure(started, response.status, "UNEXPECTED_RESPONSE_TYPE", `Expected Fish audio response but got ${contentType}.`, false, { provider: "fish-audio", requestId });
      }
      const data = await readSafeError(response);
      return buildProviderFailure(started, response.status, classifyFishError(response.status, data), extractMessage(data) ?? `Fish request failed with HTTP ${response.status}.`, response.status === 429 || response.status >= 500, { provider: "fish-audio", requestId });
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === "AbortError";
      return buildProviderFailure(started, isTimeout ? 504 : 502, isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", isTimeout ? `Fish request timed out after ${this.timeoutMs}ms.` : sanitizeText(error instanceof Error ? error.message : "Fish network error."), true, { provider: "fish-audio" });
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
  if (typeof data.message === "string") return sanitizeText(data.message);
  if (typeof data.error === "string") return sanitizeText(data.error);
  if (data.error && typeof data.error === "object" && typeof (data.error as Record<string, unknown>).message === "string") {
    return sanitizeText((data.error as Record<string, string>).message);
  }
  return null;
}

function classifyFishError(status: number, data: Record<string, unknown>): string {
  if (typeof data.code === "string") return sanitizeText(data.code);
  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401: return "INVALID_API_KEY";
    case 403: return "FORBIDDEN";
    case 404: return "FISH_REFERENCE_NOT_FOUND";
    case 429: return "RATE_LIMITED";
    default: return status >= 500 ? "PROVIDER_ERROR" : `HTTP_${status}`;
  }
}

function readString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function buildProviderFailure(started: number, statusCode: number, errorCode: string, errorMessage: string, retryable: boolean, safeMetadata?: Record<string, unknown>): Extract<ProviderAdapterResult, { ok: false }> {
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
