/**
 * Drizzle ORM schema definitions for TTS Voice Generator.
 *
 * 5 tables:
 * - settings: single-row application settings
 * - voice_profile: voice catalog with probe status
 * - generation_job: TTS generation records
 * - audio_asset: generated audio file metadata
 * - agent_action_log: agent operation audit log (reserved)
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ─── Settings (single-row table) ──────────────────────────────────────────────

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  openRouterApiKey: text("open_router_api_key"),
  defaultModel: text("default_model").notNull().default("google/gemini-3.1-flash-tts-preview"),
  defaultVoice: text("default_voice").notNull().default("Zephyr"),
  defaultFormat: text("default_format").notNull().default("mp3"),
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
  source: text("source").notNull().default("user"), // user | agent
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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Agent Action Log (reserved for Phase 6) ────────────────────────────────

export const agentActionLog = sqliteTable("agent_action_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id").notNull(),
  actionType: text("action_type").notNull(), // generate_speech | probe_voice | assemble_prompt
  toolName: text("tool_name").notNull(),
  inputSummary: text("input_summary"),
  outputSummary: text("output_summary"),
  estimatedCost: text("estimated_cost"),
  approvalStatus: text("approval_status").notNull().default("pending"), // not_required | pending | approved | rejected
  approvalScope: text("approval_scope"), // once | session
  relatedJobId: text("related_job_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
