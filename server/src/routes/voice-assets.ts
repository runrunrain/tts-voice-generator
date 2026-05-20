import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { evaluateLicenseGate } from "../services/license-gate.js";
import { selectGenerationRoute } from "../services/route-selector.js";
import { isProviderConfigured } from "../services/key-resolver.js";
import type { GenerationRoute } from "../services/provider-adapter.js";

const app = new Hono();

const VoiceAssetTypeSchema = z.enum(["gemini_preset", "fish_platform", "custom_cloned", "custom_designed", "custom_imported"]);
const VoiceAssetStatusSchema = z.enum(["draft", "license_pending", "legal_review_required", "ready_for_model_creation", "model_creating", "active", "revoked", "failed"]);
const ProviderSchema = z.enum(["openrouter-gemini", "elevenlabs", "fish-audio"]);
const GenerationRouteSchema = z.enum(["gemini_only", "gemini_elevenlabs_sts", "fish_audio_tts"]);

const CreateVoiceAssetSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: VoiceAssetTypeSchema,
  provider: ProviderSchema.optional(),
  providerVoiceId: z.string().trim().min(1).max(300).optional(),
  fishReferenceId: z.string().trim().min(1).max(300).optional(),
  licenseRecordId: z.string().trim().min(1).max(120).optional(),
  sourceTermsSnapshotId: z.string().trim().min(1).max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const UpdateVoiceAssetSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  status: VoiceAssetStatusSchema.optional(),
  licenseRecordId: z.string().trim().min(1).max(120).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const LicenseRecordSchema = z.object({
  voiceAssetId: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["pending", "approved", "revoked", "expired", "legal_review_required"]),
  scope: z.record(z.unknown()),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  evidenceUri: z.string().trim().max(2048).optional(),
  crossPlatformCloneAllowed: z.boolean().optional().default(false),
  notes: z.string().max(4000).optional(),
}).strict();

const SourceTermsSchema = z.object({
  sourceType: z.string().trim().min(1).max(120),
  sourceTool: z.string().trim().max(120).optional(),
  termsVersion: z.string().trim().max(120).optional(),
  contractUri: z.string().trim().max(2048).optional(),
  termsTextHash: z.string().trim().min(8).max(256).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict().refine((value) => !!value.termsTextHash || !!value.contractUri, {
  message: "termsTextHash or contractUri is required",
  path: ["termsTextHash"],
});

const RouteDecisionSchema = z.object({
  generationRoute: GenerationRouteSchema.optional(),
  characterVoiceMappingId: z.string().trim().min(1).optional(),
  voiceAssetId: z.string().trim().min(1).optional(),
  transcript: z.string().min(1),
  directorSnapshot: z.record(z.unknown()).optional(),
  providerOptions: z.record(z.unknown()).optional(),
}).strict();

const LicenseEvaluationSchema = z.object({
  voiceAssetId: z.string().trim().min(1).optional(),
  licenseRecordId: z.string().trim().min(1).optional(),
  action: z.enum(["create_model", "production_generate", "audition", "export"]),
  route: GenerationRouteSchema,
  sourceType: z.string().optional(),
  provider: ProviderSchema.optional(),
}).strict();

app.get("/api/voice-assets/capabilities", (c) => c.json({
  providers: {
    openrouterGemini: { configured: isProviderConfigured("openrouter"), routes: ["gemini_only", "gemini_elevenlabs_sts"] },
    elevenlabs: { configured: isProviderConfigured("elevenlabs"), routes: ["gemini_elevenlabs_sts"], endpoints: ["speech-to-speech"] },
    fishAudio: { configured: isProviderConfigured("fish-audio"), routes: ["fish_audio_tts"], endpoints: ["tts", "model"], modelVisibilityDefault: "private" },
  },
  routes: ["gemini_only", "gemini_elevenlabs_sts", "fish_audio_tts"],
  licenseGate: { enforcedBackend: true, defaultBlocks: ["LEGAL_REVIEW_REQUIRED", "LICENSE_REQUIRED", "CROSS_PLATFORM_CLONE_UNAPPROVED"] },
}));

app.get("/api/voice-assets", (c) => {
  const requestId = randomUUID();
  const filters = {
    type: c.req.query("type"),
    status: c.req.query("status"),
    provider: c.req.query("provider"),
    q: c.req.query("q"),
  };
  if (filters.type && !VoiceAssetTypeSchema.safeParse(filters.type).success) return jsonError(c, 400, "INVALID_FILTER", "Invalid voice asset type filter.", requestId);
  if (filters.status && !VoiceAssetStatusSchema.safeParse(filters.status).success) return jsonError(c, 400, "INVALID_FILTER", "Invalid voice asset status filter.", requestId);

  const rawDb = raw();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.type) { where.push("type = ?"); params.push(filters.type); }
  if (filters.status) { where.push("status = ?"); params.push(filters.status); }
  if (filters.provider) { where.push("provider = ?"); params.push(filters.provider); }
  if (filters.q) { where.push("name LIKE ?"); params.push(`%${filters.q}%`); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const items = rawDb.prepare(`SELECT * FROM voice_asset ${whereSql} ORDER BY updated_at DESC, created_at DESC LIMIT 200`).all(...params);
  return c.json({ items: items.map(mapVoiceAsset), total: items.length });
});

app.get("/api/voice-assets/:id", (c) => {
  const requestId = randomUUID();
  const row = raw().prepare("SELECT * FROM voice_asset WHERE id = ?").get(c.req.param("id"));
  if (!row) return jsonError(c, 404, "VOICE_ASSET_NOT_FOUND", "Voice asset was not found.", requestId);
  const licenses = raw().prepare("SELECT * FROM voice_license_record WHERE asset_id = ? OR id = ? ORDER BY created_at DESC").all(c.req.param("id"), (row as { license_record_id?: string | null }).license_record_id ?? "");
  const references = raw().prepare("SELECT * FROM voice_reference_asset WHERE voice_asset_id = ? ORDER BY created_at DESC").all(c.req.param("id"));
  return c.json({ voiceAsset: mapVoiceAsset(row), licenses: licenses.map(mapLicense), references: references.map(mapReference) });
});

app.post("/api/voice-assets", async (c) => {
  const requestId = randomUUID();
  const parsed = CreateVoiceAssetSchema.safeParse(await safeJson(c));
  if (!parsed.success) return jsonError(c, 400, "VALIDATION_ERROR", "Request validation failed.", requestId, parsed.error.flatten());
  const data = parsed.data;
  const custom = data.type.startsWith("custom_");
  if (custom && !data.licenseRecordId) return jsonError(c, 400, "LICENSE_REQUIRED", "Custom voice assets require licenseRecordId.", requestId);

  const id = randomUUID();
  const now = unixNow();
  const status = data.type === "custom_designed" ? "legal_review_required" : custom ? "license_pending" : "draft";
  raw().prepare(`INSERT INTO voice_asset (id, name, type, status, provider, provider_voice_id, fish_reference_id, license_record_id, source_terms_snapshot_id, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    data.name,
    data.type,
    status,
    data.provider ?? null,
    data.providerVoiceId ?? null,
    data.fishReferenceId ?? null,
    data.licenseRecordId ?? null,
    data.sourceTermsSnapshotId ?? null,
    JSON.stringify(data.metadata ?? {}),
    now,
    now,
  );
  const row = raw().prepare("SELECT * FROM voice_asset WHERE id = ?").get(id);
  return c.json({ voiceAsset: mapVoiceAsset(row), compliance: status === "legal_review_required" ? { blocked: true, blocks: ["LEGAL_REVIEW_REQUIRED"] } : { blocked: false, blocks: [] } }, 201);
});

app.patch("/api/voice-assets/:id", async (c) => {
  const requestId = randomUUID();
  const parsed = UpdateVoiceAssetSchema.safeParse(await safeJson(c));
  if (!parsed.success) return jsonError(c, 400, "VALIDATION_ERROR", "Request validation failed.", requestId, parsed.error.flatten());
  const existing = raw().prepare("SELECT * FROM voice_asset WHERE id = ?").get(c.req.param("id"));
  if (!existing) return jsonError(c, 404, "VOICE_ASSET_NOT_FOUND", "Voice asset was not found.", requestId);
  const data = parsed.data;
  if (data.status && !isValidStatusTransition((existing as { status: string }).status, data.status)) {
    return jsonError(c, 409, "INVALID_STATE_TRANSITION", "Requested status transition is not allowed.", requestId, { from: (existing as { status: string }).status, to: data.status });
  }
  if (data.status && data.status !== (existing as { status: string }).status && isControlledAvailabilityStatus(data.status)) {
    return jsonError(c, 409, "CONTROLLED_STATUS_REQUIRES_ACTION", "Activation and model-availability states must be reached through guarded action endpoints, not generic PATCH.", requestId, { status: data.status, action: data.status === "active" ? "POST /api/voice-assets/:id/activate" : "guarded_builder_action_required" });
  }
  const nextMetadata = data.metadata ? JSON.stringify(data.metadata) : (existing as { metadata_json: string }).metadata_json;
  const nextLicenseRecordId = data.licenseRecordId === undefined ? (existing as { license_record_id: string | null }).license_record_id : data.licenseRecordId;
  if ((existing as { status: string }).status === "active" && data.licenseRecordId !== undefined) {
    const compliance = evaluateLicenseGate({
      voiceAssetId: c.req.param("id"),
      licenseRecordId: nextLicenseRecordId,
      action: "production_generate",
      route: (existing as { fish_reference_id?: string | null }).fish_reference_id ? "fish_audio_tts" : (existing as { provider_voice_id?: string | null }).provider_voice_id ? "gemini_elevenlabs_sts" : "gemini_only",
      sourceType: (existing as { type: string }).type,
      provider: (existing as { fish_reference_id?: string | null }).fish_reference_id ? "fish-audio" : (existing as { provider_voice_id?: string | null }).provider_voice_id ? "elevenlabs" : "openrouter-gemini",
    });
    if (!compliance.allowed) return jsonError(c, 409, "LICENSE_BLOCKED", "Active voice asset license updates are blocked by license gate.", requestId, compliance);
  }
  raw().prepare(`UPDATE voice_asset SET name = ?, status = ?, license_record_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(
    data.name ?? (existing as { name: string }).name,
    data.status ?? (existing as { status: string }).status,
    nextLicenseRecordId,
    nextMetadata,
    unixNow(),
    c.req.param("id"),
  );
  return c.json({ voiceAsset: mapVoiceAsset(raw().prepare("SELECT * FROM voice_asset WHERE id = ?").get(c.req.param("id"))) });
});

app.post("/api/voice-assets/:id/activate", (c) => {
  const requestId = randomUUID();
  const asset = raw().prepare("SELECT * FROM voice_asset WHERE id = ?").get(c.req.param("id")) as { id: string; license_record_id: string | null; type: string } | undefined;
  if (!asset) return jsonError(c, 404, "VOICE_ASSET_NOT_FOUND", "Voice asset was not found.", requestId);
  const compliance = evaluateLicenseGate({ voiceAssetId: asset.id, licenseRecordId: asset.license_record_id, action: "production_generate", route: "fish_audio_tts", sourceType: asset.type, provider: "fish-audio" });
  if (!compliance.allowed) return jsonError(c, 409, "LICENSE_BLOCKED", "Voice asset activation is blocked by license gate.", requestId, compliance);
  raw().prepare("UPDATE voice_asset SET status = 'active', updated_at = ? WHERE id = ?").run(unixNow(), asset.id);
  return c.json({ voiceAsset: mapVoiceAsset(raw().prepare("SELECT * FROM voice_asset WHERE id = ?").get(asset.id)), compliance });
});

app.post("/api/voice-assets/:id/revoke", async (c) => {
  const requestId = randomUUID();
  const body = z.object({ reason: z.string().trim().min(1).max(1000) }).safeParse(await safeJson(c));
  if (!body.success) return jsonError(c, 400, "VALIDATION_ERROR", "Request validation failed.", requestId, body.error.flatten());
  const result = raw().prepare("UPDATE voice_asset SET status = 'revoked', metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.revokeReason', ?), updated_at = ? WHERE id = ?").run(body.data.reason, unixNow(), c.req.param("id"));
  if (result.changes === 0) return jsonError(c, 404, "VOICE_ASSET_NOT_FOUND", "Voice asset was not found.", requestId);
  return c.json({ voiceAsset: mapVoiceAsset(raw().prepare("SELECT * FROM voice_asset WHERE id = ?").get(c.req.param("id"))) });
});

app.post("/api/licenses", async (c) => {
  const requestId = randomUUID();
  const parsed = LicenseRecordSchema.safeParse(await safeJson(c));
  if (!parsed.success) return jsonError(c, 400, "INVALID_LICENSE_SCOPE", "Request validation failed.", requestId, parsed.error.flatten());
  const id = randomUUID();
  const data = parsed.data;
  const now = unixNow();
  raw().prepare(`INSERT INTO voice_license_record (id, asset_id, status, scope_json, valid_from, valid_until, evidence_uri, cross_platform_clone_allowed, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, data.voiceAssetId ?? null, data.status, JSON.stringify(data.scope), toUnix(data.validFrom), toUnix(data.validUntil), data.evidenceUri ?? null, data.crossPlatformCloneAllowed ? 1 : 0, data.notes ?? null, now, now);
  if (data.voiceAssetId) raw().prepare("UPDATE voice_asset SET license_record_id = ?, updated_at = ? WHERE id = ? AND license_record_id IS NULL").run(id, now, data.voiceAssetId);
  return c.json({ licenseRecord: mapLicense(raw().prepare("SELECT * FROM voice_license_record WHERE id = ?").get(id)) }, 201);
});

app.post("/api/source-terms", async (c) => {
  const requestId = randomUUID();
  const parsed = SourceTermsSchema.safeParse(await safeJson(c));
  if (!parsed.success) return jsonError(c, 400, "TERMS_REQUIRED", "Source terms evidence is required.", requestId, parsed.error.flatten());
  const id = randomUUID();
  const data = parsed.data;
  raw().prepare(`INSERT INTO source_terms_snapshot (id, source_type, source_tool, terms_version, terms_text_hash, contract_uri, captured_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, data.sourceType, data.sourceTool ?? null, data.termsVersion ?? null, data.termsTextHash ?? null, data.contractUri ?? null, unixNow(), JSON.stringify(data.metadata ?? {}));
  return c.json({ sourceTermsSnapshot: mapSourceTerms(raw().prepare("SELECT * FROM source_terms_snapshot WHERE id = ?").get(id)) }, 201);
});

app.post("/api/voice-routes/preview", async (c) => routeDecisionHandler(c));
app.post("/api/voice-routes/decision", async (c) => routeDecisionHandler(c));

app.post("/api/licenses/evaluate", async (c) => {
  const requestId = randomUUID();
  const parsed = LicenseEvaluationSchema.safeParse(await safeJson(c));
  if (!parsed.success) return jsonError(c, 400, "VALIDATION_ERROR", "Request validation failed.", requestId, parsed.error.flatten());
  return c.json({ requestId, compliance: evaluateLicenseGate(parsed.data) });
});

async function routeDecisionHandler(c: Context) {
  const requestId = randomUUID();
  const parsed = RouteDecisionSchema.safeParse(await safeJson(c));
  if (!parsed.success) return jsonError(c, 400, "VALIDATION_ERROR", "Request validation failed.", requestId, parsed.error.flatten());
  const decision = selectGenerationRoute({
    requestedRoute: parsed.data.generationRoute as GenerationRoute | undefined,
    characterVoiceMappingId: parsed.data.characterVoiceMappingId,
    voiceAssetId: parsed.data.voiceAssetId,
    transcript: parsed.data.transcript,
    directorSnapshot: parsed.data.directorSnapshot,
    providerOptions: parsed.data.providerOptions,
  });
  return c.json({ requestId, decision });
}

function raw() {
  const db = getDb();
  return (db as unknown as { $client: import("better-sqlite3").Database }).$client;
}

async function safeJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}

function jsonError(c: Context, status: 400 | 404 | 409, code: string, message: string, requestId: string, details?: unknown) {
  return c.json({ code, message, requestId, ...(details !== undefined ? { details } : {}) }, status);
}

function unixNow(): number { return Math.floor(Date.now() / 1000); }
function toUnix(value: string | undefined): number | null { return value ? Math.floor(Date.parse(value) / 1000) : null; }

function mapVoiceAsset(row: unknown) {
  const r = row as Record<string, unknown>;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status,
    provider: r.provider,
    providerVoiceId: r.provider_voice_id,
    fishReferenceId: r.fish_reference_id,
    licenseRecordId: r.license_record_id,
    sourceTermsSnapshotId: r.source_terms_snapshot_id,
    metadata: parseJson(r.metadata_json),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapLicense(row: unknown) {
  const r = row as Record<string, unknown>;
  return {
    id: r.id,
    voiceAssetId: r.asset_id,
    status: r.status,
    scope: parseJson(r.scope_json),
    validFrom: toIso(r.valid_from),
    validUntil: toIso(r.valid_until),
    revokedAt: toIso(r.revoked_at),
    evidenceUri: r.evidence_uri,
    crossPlatformCloneAllowed: r.cross_platform_clone_allowed === 1,
    notes: r.notes,
  };
}

function mapReference(row: unknown) {
  const r = row as Record<string, unknown>;
  return { id: r.id, voiceAssetId: r.voice_asset_id, audioAssetId: r.audio_asset_id, provider: r.provider, referenceId: r.reference_id, qualityStatus: r.quality_status, transcriptStatus: r.transcript_status, metadata: parseJson(r.metadata_json), createdAt: toIso(r.created_at) };
}

function mapSourceTerms(row: unknown) {
  const r = row as Record<string, unknown>;
  return { id: r.id, sourceType: r.source_type, sourceTool: r.source_tool, termsVersion: r.terms_version, termsTextHash: r.terms_text_hash, contractUri: r.contract_uri, capturedAt: toIso(r.captured_at), metadata: parseJson(r.metadata_json) };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function toIso(value: unknown): string | null {
  if (typeof value !== "number") return null;
  return new Date(value * 1000).toISOString();
}

function isValidStatusTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === "revoked") return false;
  if (to === "revoked" || to === "failed") return true;
  if (from === "legal_review_required" && to !== "license_pending") return false;
  return true;
}

function isControlledAvailabilityStatus(status: string): boolean {
  return status === "ready_for_model_creation" || status === "model_creating" || status === "active";
}

export default app;
