import { getDb } from "../db/index.js";
import { isProviderConfigured } from "./key-resolver.js";
import { evaluateLicenseGate, type LicenseGateAction, type LicenseGateResult } from "./license-gate.js";
import type { GenerationRoute, ProviderChainEntry } from "./provider-adapter.js";

export interface RouteSelectorInput {
  requestedRoute?: GenerationRoute | null;
  characterVoiceMappingId?: string | null;
  voiceAssetId?: string | null;
  transcript: string;
  directorSnapshot?: Record<string, unknown> | null;
  providerOptions?: Record<string, unknown> | null;
  action?: LicenseGateAction;
}

export interface RouteDecision {
  route: GenerationRoute;
  providerChain: ProviderChainEntry[];
  voiceAssetId?: string;
  providerVoiceId?: string;
  fishReferenceId?: string;
  licenseRecordId?: string;
  complianceBlocks: string[];
  licenseGate?: LicenseGateResult;
  reasons: string[];
  blocked: boolean;
}

type VoiceAssetRouteRow = {
  id: string;
  status: string;
  type: string;
  provider: string | null;
  provider_voice_id: string | null;
  fish_reference_id: string | null;
  license_record_id: string | null;
};

type MappingRow = {
  id: string;
  default_generation_route: string;
  voice_asset_id: string | null;
  provider_voice_id: string | null;
  fish_reference_id: string | null;
};

type VoiceReferenceRouteRow = {
  reference_id: string | null;
};

export function selectGenerationRoute(input: RouteSelectorInput): RouteDecision {
  const db = getDb();
  const rawDb = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  const reasons: string[] = [];
  const complianceBlocks: string[] = [];

  const mapping = input.characterVoiceMappingId
    ? rawDb.prepare("SELECT id, default_generation_route, voice_asset_id, provider_voice_id, fish_reference_id FROM character_voice_mapping WHERE id = ?").get(input.characterVoiceMappingId) as MappingRow | undefined
    : undefined;
  if (input.characterVoiceMappingId && !mapping) complianceBlocks.push("CHARACTER_VOICE_MAPPING_NOT_FOUND");

  const route = normalizeRoute(input.requestedRoute ?? (mapping?.default_generation_route as GenerationRoute | undefined) ?? "gemini_only");
  if (input.requestedRoute) reasons.push("explicit_route_requested");
  else if (mapping?.default_generation_route) reasons.push("character_mapping_default_route");
  else reasons.push("default_gemini_only_no_mapping");

  const voiceAssetId = input.voiceAssetId ?? mapping?.voice_asset_id ?? undefined;
  const asset = voiceAssetId
    ? rawDb.prepare("SELECT id, status, type, provider, provider_voice_id, fish_reference_id, license_record_id FROM voice_asset WHERE id = ?").get(voiceAssetId) as VoiceAssetRouteRow | undefined
    : undefined;
  if (voiceAssetId && !asset) complianceBlocks.push("VOICE_ASSET_NOT_FOUND");

  const requestedProviderVoiceId = readNestedString(input.providerOptions, ["elevenlabs", "voiceId"])
    ?? readNestedString(input.providerOptions, ["elevenlabs", "voice_id"]);
  const requestedFishReferenceId = readNestedString(input.providerOptions, ["fish", "referenceId"])
    ?? readNestedString(input.providerOptions, ["fish", "reference_id"]);
  const providerVoiceResolution = resolveBoundExternalId({
    rawDb,
    voiceAssetId,
    provider: "elevenlabs",
    assetBoundId: asset?.provider_voice_id ?? null,
    mappingBoundId: mapping?.provider_voice_id ?? null,
    requestedOverrideId: requestedProviderVoiceId,
    mismatchCode: "PROVIDER_ID_LICENSE_MISMATCH",
  });
  const fishReferenceResolution = resolveBoundExternalId({
    rawDb,
    voiceAssetId,
    provider: "fish-audio",
    assetBoundId: asset?.fish_reference_id ?? null,
    mappingBoundId: mapping?.fish_reference_id ?? null,
    requestedOverrideId: requestedFishReferenceId,
    mismatchCode: "REFERENCE_ASSET_MISMATCH",
  });
  const providerVoiceId = providerVoiceResolution.value;
  const fishReferenceId = fishReferenceResolution.value;
  if (route === "gemini_elevenlabs_sts" && providerVoiceResolution.mismatchCode) complianceBlocks.push(providerVoiceResolution.mismatchCode);
  if (route === "fish_audio_tts" && fishReferenceResolution.mismatchCode) complianceBlocks.push(fishReferenceResolution.mismatchCode);

  const providerChain = buildProviderChain(route, input.providerOptions);
  if (route === "gemini_elevenlabs_sts") {
    if (!isProviderConfigured("elevenlabs")) complianceBlocks.push("PROVIDER_KEY_MISSING:elevenlabs");
    if (!providerVoiceId) complianceBlocks.push("PROVIDER_VOICE_ID_REQUIRED");
    if (!voiceAssetId) complianceBlocks.push("VOICE_ASSET_REQUIRED");
    if (asset && asset.status !== "active") complianceBlocks.push("VOICE_ASSET_NOT_ACTIVE");
  }
  if (route === "fish_audio_tts") {
    if (!isProviderConfigured("fish-audio")) complianceBlocks.push("PROVIDER_KEY_MISSING:fish-audio");
    if (!fishReferenceId) complianceBlocks.push("FISH_REFERENCE_ID_REQUIRED");
    if (!voiceAssetId) complianceBlocks.push("VOICE_ASSET_REQUIRED");
    if (asset && asset.status !== "active") complianceBlocks.push("VOICE_ASSET_NOT_ACTIVE");
  }

  let licenseGate: LicenseGateResult | undefined;
  if (route !== "gemini_only" || voiceAssetId) {
    licenseGate = evaluateLicenseGate({
      voiceAssetId,
      licenseRecordId: asset?.license_record_id ?? undefined,
      action: input.action ?? "production_generate",
      route,
      sourceType: asset?.type ?? null,
      provider: route === "fish_audio_tts" ? "fish-audio" : route === "gemini_elevenlabs_sts" ? "elevenlabs" : "openrouter-gemini",
    });
    complianceBlocks.push(...licenseGate.blocks.map((block) => block.code));
  }

  return {
    route,
    providerChain,
    ...(voiceAssetId ? { voiceAssetId } : {}),
    ...(providerVoiceId ? { providerVoiceId } : {}),
    ...(fishReferenceId ? { fishReferenceId } : {}),
    ...(licenseGate?.licenseRecordId ? { licenseRecordId: licenseGate.licenseRecordId } : asset?.license_record_id ? { licenseRecordId: asset.license_record_id } : {}),
    complianceBlocks: [...new Set(complianceBlocks)],
    licenseGate,
    reasons,
    blocked: complianceBlocks.length > 0 || licenseGate?.allowed === false,
  };
}

function buildProviderChain(route: GenerationRoute, providerOptions?: Record<string, unknown> | null): ProviderChainEntry[] {
  if (route === "gemini_elevenlabs_sts") {
    return [
      { stage: "base_tts", provider: "openrouter-gemini", model: readNestedString(providerOptions, ["gemini", "model"]) ?? "google/gemini-3.1-flash-tts-preview" },
      { stage: "voice_conversion", provider: "elevenlabs", model: readNestedString(providerOptions, ["elevenlabs", "modelId"]) ?? "eleven_multilingual_sts_v2" },
      { stage: "final", provider: "elevenlabs" },
    ];
  }
  if (route === "fish_audio_tts") {
    return [{ stage: "final", provider: "fish-audio", model: readNestedString(providerOptions, ["fish", "model"]) ?? "speech-1.5" }];
  }
  return [{ stage: "final", provider: "openrouter-gemini", model: readNestedString(providerOptions, ["gemini", "model"]) ?? "google/gemini-3.1-flash-tts-preview" }];
}

function resolveBoundExternalId(input: {
  rawDb: import("better-sqlite3").Database;
  voiceAssetId?: string;
  provider: "elevenlabs" | "fish-audio";
  assetBoundId: string | null;
  mappingBoundId: string | null;
  requestedOverrideId: string | null;
  mismatchCode: "PROVIDER_ID_LICENSE_MISMATCH" | "REFERENCE_ASSET_MISMATCH";
}): { value?: string; mismatchCode?: string } {
  const permitted = new Set<string>();
  if (input.assetBoundId) permitted.add(input.assetBoundId);
  for (const activeReferenceId of lookupActiveProviderReferences(input.rawDb, input.voiceAssetId, input.provider)) {
    permitted.add(activeReferenceId);
  }

  if (input.requestedOverrideId) {
    if (!permitted.has(input.requestedOverrideId)) {
      return { value: firstPermittedId(permitted), mismatchCode: input.mismatchCode };
    }
    return { value: input.requestedOverrideId };
  }

  if (input.assetBoundId) return { value: input.assetBoundId };
  if (input.mappingBoundId) {
    if (!permitted.has(input.mappingBoundId)) {
      return { value: firstPermittedId(permitted), mismatchCode: input.mismatchCode };
    }
    return { value: input.mappingBoundId };
  }
  return { value: firstPermittedId(permitted) };
}

function firstPermittedId(permitted: Set<string>): string | undefined {
  for (const value of permitted) return value;
  return undefined;
}

function lookupActiveProviderReferences(rawDb: import("better-sqlite3").Database, voiceAssetId: string | undefined, provider: "elevenlabs" | "fish-audio"): string[] {
  if (!voiceAssetId) return [];
  const rows = rawDb.prepare("SELECT reference_id FROM voice_reference_asset WHERE voice_asset_id = ? AND provider = ? AND quality_status IN ('passed', 'active') AND reference_id IS NOT NULL ORDER BY created_at DESC").all(voiceAssetId, provider) as VoiceReferenceRouteRow[];
  return rows.map((row) => row.reference_id).filter((referenceId): referenceId is string => typeof referenceId === "string" && referenceId.trim().length > 0);
}

function normalizeRoute(value: string | null | undefined): GenerationRoute {
  if (value === "gemini_elevenlabs_sts" || value === "fish_audio_tts" || value === "gemini_only") return value;
  return "gemini_only";
}

function readNestedString(source: Record<string, unknown> | null | undefined, path: string[]): string | null {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}
