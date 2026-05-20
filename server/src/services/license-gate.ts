import { getDb } from "../db/index.js";
import type { GenerationRoute, ProviderId } from "./provider-adapter.js";

export type LicenseGateAction = "create_model" | "production_generate" | "audition" | "export";

export interface LicenseGateInput {
  voiceAssetId?: string | null;
  licenseRecordId?: string | null;
  action: LicenseGateAction;
  route: GenerationRoute;
  sourceType?: string | null;
  provider?: ProviderId | null;
}

export interface LicenseGateResult {
  allowed: boolean;
  blocks: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  warnings: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  licenseRecordId?: string;
}

type VoiceAssetRow = {
  id: string;
  type: string;
  status: string;
  license_record_id: string | null;
  provider: string | null;
};

type LicenseRow = {
  id: string;
  asset_id: string | null;
  status: string;
  scope_json: string;
  valid_from: number | null;
  valid_until: number | null;
  revoked_at: number | null;
  cross_platform_clone_allowed: number | null;
};

const LICENSE_REQUIRED_ACTIONS = new Set<LicenseGateAction>(["create_model", "production_generate", "audition", "export"]);

export function evaluateLicenseGate(input: LicenseGateInput): LicenseGateResult {
  const blocks: LicenseGateResult["blocks"] = [];
  const warnings: LicenseGateResult["warnings"] = [];

  if (input.route === "gemini_only" && !input.voiceAssetId && !input.licenseRecordId) {
    return { allowed: true, blocks, warnings: [{ code: "GEMINI_PRESET_ROUTE", message: "Gemini-only route without custom voice asset does not require a custom license record." }] };
  }

  if (!input.voiceAssetId && LICENSE_REQUIRED_ACTIONS.has(input.action)) {
    blocks.push({ code: "VOICE_ASSET_REQUIRED", message: "A voice asset is required for licensed custom voice actions." });
    return { allowed: false, blocks, warnings };
  }

  const db = getDb();
  const rawDb = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  const asset = input.voiceAssetId
    ? rawDb.prepare("SELECT id, type, status, license_record_id, provider FROM voice_asset WHERE id = ?").get(input.voiceAssetId) as VoiceAssetRow | undefined
    : undefined;

  if (input.voiceAssetId && !asset) {
    blocks.push({ code: "VOICE_ASSET_NOT_FOUND", message: "Voice asset was not found." });
    return { allowed: false, blocks, warnings };
  }

  if (asset?.status === "legal_review_required" || input.sourceType === "elevenlabs_voice_design") {
    blocks.push({ code: "LEGAL_REVIEW_REQUIRED", message: "This voice source requires legal review before model creation or production use." });
  }
  if (asset?.status === "revoked") {
    blocks.push({ code: "VOICE_ASSET_REVOKED", message: "This voice asset has been revoked." });
  }
  if (asset?.status === "failed") {
    blocks.push({ code: "VOICE_ASSET_FAILED", message: "This voice asset is in failed state and cannot be used." });
  }

  const effectiveLicenseRecordId = Object.prototype.hasOwnProperty.call(input, "licenseRecordId")
    ? input.licenseRecordId ?? null
    : asset?.license_record_id ?? null;
  if (!effectiveLicenseRecordId) {
    blocks.push({ code: "LICENSE_REQUIRED", message: "A licenseRecordId is required for custom voice actions." });
    return { allowed: false, blocks, warnings };
  }

  const license = rawDb.prepare("SELECT id, asset_id, status, scope_json, valid_from, valid_until, revoked_at, cross_platform_clone_allowed FROM voice_license_record WHERE id = ?").get(effectiveLicenseRecordId) as LicenseRow | undefined;
  if (!license) {
    blocks.push({ code: "LICENSE_RECORD_NOT_FOUND", message: "License record was not found." });
    return { allowed: false, blocks, warnings };
  }

  if (license.asset_id && asset?.id && license.asset_id !== asset.id) {
    blocks.push({ code: "LICENSE_ASSET_MISMATCH", message: "License record is bound to a different voice asset." });
  }
  if (license.status === "legal_review_required") {
    blocks.push({ code: "LEGAL_REVIEW_REQUIRED", message: "License record is pending legal review." });
  } else if (license.status !== "approved") {
    blocks.push({ code: "LICENSE_BLOCKED", message: `License status '${license.status}' is not approved.` });
  }
  if (license.revoked_at) blocks.push({ code: "LICENSE_REVOKED", message: "License record has been revoked." });

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (license.valid_from && license.valid_from > nowSeconds) {
    blocks.push({ code: "LICENSE_NOT_YET_VALID", message: "License validity window has not started." });
  }
  if (license.valid_until && license.valid_until < nowSeconds) {
    blocks.push({ code: "LICENSE_EXPIRED", message: "License record has expired." });
  }

  const scope = parseJsonObject(license.scope_json);
  const allowedActions = Array.isArray(scope.actions) ? scope.actions.filter((v): v is string => typeof v === "string") : [];
  if (allowedActions.length > 0 && !allowedActions.includes(input.action)) {
    blocks.push({ code: "LICENSE_SCOPE_DENIED", message: "License scope does not allow this action.", details: { action: input.action } });
  }

  const crossProviderClone = input.route === "fish_audio_tts" && (asset?.type === "custom_designed" || input.sourceType === "elevenlabs_voice_design");
  if (crossProviderClone && license.cross_platform_clone_allowed !== 1) {
    blocks.push({ code: "CROSS_PLATFORM_CLONE_UNAPPROVED", message: "Cross-platform clone approval is required before Fish model creation or Fish production use." });
  }

  return {
    allowed: blocks.length === 0,
    blocks,
    warnings,
    licenseRecordId: effectiveLicenseRecordId,
  };
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
