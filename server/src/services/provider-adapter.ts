export type ProviderId = "openrouter-gemini" | "elevenlabs" | "fish-audio";
export type GenerationRoute = "gemini_only" | "gemini_elevenlabs_sts" | "fish_audio_tts";
export type PipelineStage = "base_tts" | "voice_conversion" | "final" | "audition";

export interface ProviderChainEntry {
  stage: PipelineStage;
  provider: ProviderId;
  model?: string;
  assetId?: number;
  latencyMs?: number;
  requestId?: string | null;
}

export interface ProviderCostInput {
  inputChars?: number;
  inputBytes?: number;
  audioBytes?: number;
  estimatedUsd?: number;
}

export interface ProviderAdapterSuccess {
  ok: true;
  audioBuffer?: Buffer;
  contentType?: string;
  providerRequestId?: string | null;
  latencyMs: number;
  safeMetadata: Record<string, unknown>;
  costInput: ProviderCostInput;
}

export interface ProviderAdapterFailure {
  ok: false;
  statusCode: number;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  latencyMs: number;
  safeMetadata?: Record<string, unknown>;
}

export type ProviderAdapterResult = ProviderAdapterSuccess | ProviderAdapterFailure;

export function buildMissingProviderKey(provider: "elevenlabs" | "fish-audio", latencyMs = 0): ProviderAdapterFailure {
  return {
    ok: false,
    statusCode: 401,
    errorCode: "PROVIDER_KEY_MISSING",
    errorMessage: `${provider} API key is not configured or this provider is not authorized for use.`,
    retryable: false,
    latencyMs,
    safeMetadata: { provider, configured: false },
  };
}
