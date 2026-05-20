/**
 * Drizzle ORM schema definitions for TTS Voice Generator.
 *
 * 6 tables:
 * - settings: single-row application settings
 * - voice_profile: voice catalog with probe status
 * - generation_job: TTS generation records
 * - audio_asset: generated audio file metadata
 * - agent_action_log: agent operation audit log
 * - agent_session: bounded agent auto-approval sessions
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ─── Settings (single-row table) ──────────────────────────────────────────────

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  openRouterApiKey: text("open_router_api_key"),
  elevenLabsApiKey: text("elevenlabs_api_key"),
  fishAudioApiKey: text("fish_audio_api_key"),
  defaultModel: text("default_model").notNull().default("google/gemini-3.1-flash-tts-preview"),
  defaultVoice: text("default_voice").notNull().default("Zephyr"),
  defaultFormat: text("default_format").notNull().default("wav"),
  audioOutputDir: text("audio_output_dir").notNull().default("./data/audio"),
  maxCharsPerRequest: integer("max_chars_per_request").notNull().default(5000),
  maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(2),
  localPluginToken: text("local_plugin_token"),
  agentAuthMode: text("agent_auth_mode").notNull().default("confirm_each"),
  agentMaxRequests: integer("agent_max_requests").notNull().default(10),
  agentMaxChars: integer("agent_max_chars").notNull().default(10000),
  agentMaxCost: real("agent_max_cost").notNull().default(0.01),
  agentSessionExpiry: integer("agent_session_expiry").notNull().default(3600),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Voice Profile ───────────────────────────────────────────────────────────

export const voiceProfile = sqliteTable("voice_profile", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  provider: text("provider").notNull().default("openrouter"),
  model: text("model"),
  role: text("role"),
  source: text("source").notNull().default("candidate"), // default | candidate | custom
  verifiedStatus: text("verified_status").notNull().default("unknown"), // unknown | verified | failed
  lastVerified: integer("last_verified", { mode: "timestamp" }),
  verifyDuration: integer("verify_duration"), // ms
  verifyError: text("verify_error"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Generation Job ──────────────────────────────────────────────────────────

export const generationJob = sqliteTable("generation_job", {
  id: text("id").primaryKey(), // UUID v4
  model: text("model").notNull(),
  voice: text("voice").notNull(),
  responseFormat: text("response_format").notNull(),
  input: text("input").notNull(),
  inputCharCount: integer("input_char_count").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | succeeded | failed | cancelled
  generationId: text("generation_id"), // OpenRouter X-Generation-Id
  providerOptions: text("provider_options"), // JSON string
  directorSnapshot: text("director_snapshot"), // JSON string
  estimatedCost: text("estimated_cost"),
  actualCost: text("actual_cost"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  errorMetadata: text("error_metadata"), // JSON string
  generationRoute: text("generation_route").notNull().default("gemini_only"),
  providerChainJson: text("provider_chain_json"),
  voiceAssetId: text("voice_asset_id"),
  licenseRecordId: text("license_record_id"),
  intermediateAudioAssetId: integer("intermediate_audio_asset_id"),
  routeDecisionJson: text("route_decision_json"),
  costMetadataJson: text("cost_metadata_json"),
  complianceJson: text("compliance_json"),
  source: text("source").notNull().default("user"), // user | agent | cli
  agentConversationId: text("agent_conversation_id"),
  agentActionLogId: integer("agent_action_log_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

// ─── Audio Asset ─────────────────────────────────────────────────────────────

export const audioAsset = sqliteTable("audio_asset", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => generationJob.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(), // relative to audio base dir: YYYY/MM/DD/{jobId}.{ext}
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256"),
  duration: text("duration"), // "3.2s"
  sampleRate: integer("sample_rate"),
  bitDepth: integer("bit_depth"),
  channels: integer("channels"),
  parentAssetId: integer("parent_asset_id"),
  pipelineStage: text("pipeline_stage"),
  provider: text("provider"),
  model: text("model"),
  voiceAssetId: text("voice_asset_id"),
  aiDisclosureJson: text("ai_disclosure_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Voice Asset Registry And Provenance ─────────────────────────────────────

export const voiceAsset = sqliteTable("voice_asset", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("draft"),
  provider: text("provider"),
  providerVoiceId: text("provider_voice_id"),
  fishReferenceId: text("fish_reference_id"),
  licenseRecordId: text("license_record_id"),
  sourceTermsSnapshotId: text("source_terms_snapshot_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const voiceLicenseRecord = sqliteTable("voice_license_record", {
  id: text("id").primaryKey(),
  assetId: text("asset_id"),
  status: text("status").notNull().default("pending"),
  scopeJson: text("scope_json").notNull().default("{}"),
  validFrom: integer("valid_from", { mode: "timestamp" }),
  validUntil: integer("valid_until", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  evidenceUri: text("evidence_uri"),
  crossPlatformCloneAllowed: integer("cross_platform_clone_allowed", { mode: "boolean" }).notNull().default(false),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const voiceReferenceAsset = sqliteTable("voice_reference_asset", {
  id: text("id").primaryKey(),
  voiceAssetId: text("voice_asset_id").notNull(),
  audioAssetId: integer("audio_asset_id"),
  provider: text("provider").notNull(),
  referenceId: text("reference_id"),
  qualityStatus: text("quality_status").notNull().default("pending"),
  transcriptStatus: text("transcript_status").notNull().default("pending"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const sourceTermsSnapshot = sqliteTable("source_terms_snapshot", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceTool: text("source_tool"),
  termsVersion: text("terms_version"),
  termsTextHash: text("terms_text_hash"),
  contractUri: text("contract_uri"),
  capturedAt: integer("captured_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  metadataJson: text("metadata_json").notNull().default("{}"),
});

export const fishVoiceModel = sqliteTable("fish_voice_model", {
  id: text("id").primaryKey(),
  voiceAssetId: text("voice_asset_id").notNull(),
  fishModelId: text("fish_model_id"),
  referenceId: text("reference_id"),
  trainMode: text("train_mode").notNull().default("fast"),
  visibility: text("visibility").notNull().default("private"),
  status: text("status").notNull().default("pending"),
  errorJson: text("error_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const audioToVoiceBuild = sqliteTable("audio_to_voice_build", {
  id: text("id").primaryKey(),
  sourceAudioAssetId: integer("source_audio_asset_id").notNull(),
  voiceAssetId: text("voice_asset_id"),
  state: text("state").notNull().default("draft"),
  qualityJson: text("quality_json").notNull().default("{}"),
  transcriptText: text("transcript_text"),
  transcriptMode: text("transcript_mode"),
  licenseRecordId: text("license_record_id"),
  errorJson: text("error_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const characterVoiceMapping = sqliteTable("character_voice_mapping", {
  id: text("id").primaryKey(),
  characterId: text("character_id"),
  characterName: text("character_name").notNull(),
  defaultGenerationRoute: text("default_generation_route").notNull().default("gemini_only"),
  voiceAssetId: text("voice_asset_id"),
  providerVoiceId: text("provider_voice_id"),
  fishReferenceId: text("fish_reference_id"),
  routeOptionsJson: text("route_options_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Agent Action Log (reserved for Phase 6) ────────────────────────────────

export const agentActionLog = sqliteTable("agent_action_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id").notNull(),
  actionType: text("action_type").notNull(), // generate_speech | probe_voice | assemble_prompt
  toolName: text("tool_name").notNull(),
  sessionId: text("session_id"),
  inputSummary: text("input_summary"),
  inputPayload: text("input_payload"),
  outputSummary: text("output_summary"),
  estimatedCost: text("estimated_cost"),
  approvalStatus: text("approval_status").notNull().default("pending"), // not_required | pending | approved | rejected
  approvalScope: text("approval_scope"), // once | session
  relatedJobId: text("related_job_id"),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const agentSession = sqliteTable("agent_session", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  status: text("status").notNull().default("active"), // active | revoked | expired
  maxRequests: integer("max_requests").notNull(),
  usedRequests: integer("used_requests").notNull().default(0),
  maxChars: integer("max_chars").notNull(),
  usedChars: integer("used_chars").notNull().default(0),
  maxCost: real("max_cost").notNull(),
  usedCost: real("used_cost").notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
