/**
 * Extended Drizzle ORM schema for Voice Production P0 tables.
 *
 * New tables:
 * - voice_task: voice production tasks
 * - requirement_document: requirement documents attached to tasks
 * - director_profile: reusable director configurations
 * - production_list_version: production list version history
 * - opencode_session: OpenCode session tracking
 * - agent_button_preset: predefined agent button templates
 * - agent_button_run: execution records for agent buttons
 * - agent_chat_session: chat session tracking
 * - agent_chat_message: individual chat messages
 * - operation_audit_log: audit trail for all operations
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ─── Voice Task ────────────────────────────────────────────────────────────────

export const voiceTask = sqliteTable("voice_task", {
  id: text("id").primaryKey(), // UUID v4
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("draft"), // draft | in_progress | completed | archived
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Requirement Document ──────────────────────────────────────────────────────

export const requirementDocument = sqliteTable("requirement_document", {
  id: text("id").primaryKey(), // UUID v4
  taskId: text("task_id").notNull().references(() => voiceTask.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  source: text("source").notNull().default("paste"), // upload | paste | agent
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  contentSha256: text("content_sha256"),
  contentSizeBytes: integer("content_size_bytes"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Director Profile ──────────────────────────────────────────────────────────

export const directorProfile = sqliteTable("director_profile", {
  id: text("id").primaryKey(), // UUID v4
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  config: text("config").notNull().default("{}"), // JSON string of DirectorConfig
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Production List Version ───────────────────────────────────────────────────

export const productionListVersion = sqliteTable("production_list_version", {
  id: text("id").primaryKey(), // UUID v4
  taskId: text("task_id").notNull().references(() => voiceTask.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  directorProfileId: text("director_profile_id"),
  speakersJson: text("speakers_json").notNull().default("[]"), // JSON
  metadataJson: text("metadata_json").notNull().default("{}"), // JSON
  lineCount: integer("line_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Voice Line (stored in artifact, indexed for queries) ──────────────────────

export const voiceLine = sqliteTable("voice_line", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => voiceTask.id, { onDelete: "cascade" }),
  versionId: text("version_id").notNull().references(() => productionListVersion.id, { onDelete: "cascade" }),
  order: integer("order").notNull(),
  speaker: text("speaker").notNull(),
  text: text("text").notNull(),
  voice: text("voice").notNull(),
  style: text("style").notNull().default(""),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending | approved | generating | generated | failed
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── OpenCode Session ──────────────────────────────────────────────────────────

export const opencodeSession = sqliteTable("opencode_session", {
  id: text("id").primaryKey(), // UUID v4
  sessionType: text("session_type").notNull(), // automation | chat
  status: text("status").notNull().default("active"), // active | completed | failed
  metadataJson: text("metadata_json").notNull().default("{}"),
  taskId: text("task_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

// ─── Agent Button Preset ───────────────────────────────────────────────────────

export const agentButtonPreset = sqliteTable("agent_button_preset", {
  id: text("id").primaryKey(), // UUID v4
  buttonKey: text("button_key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  promptTemplate: text("prompt_template").notNull().default(""),
  targetPolicyJson: text("target_policy_json").notNull().default("{}"), // JSON: allowedFields, allowedLineFields
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Agent Button Run ──────────────────────────────────────────────────────────

export const agentButtonRun = sqliteTable("agent_button_run", {
  id: text("id").primaryKey(), // UUID v4
  taskId: text("task_id").notNull().references(() => voiceTask.id, { onDelete: "cascade" }),
  buttonKey: text("button_key").notNull(),
  targetLineId: text("target_line_id").notNull(),
  runner: text("runner").notNull().default("fallback"), // opencode | fallback
  inputSnapshotJson: text("input_snapshot_json"), // JSON snapshot before
  outputSnapshotJson: text("output_snapshot_json"), // JSON snapshot after
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

// ─── Agent Chat Session ────────────────────────────────────────────────────────

export const agentChatSession = sqliteTable("agent_chat_session", {
  id: text("id").primaryKey(), // UUID v4
  opencodeSessionId: text("opencode_session_id"),
  taskId: text("task_id"),
  status: text("status").notNull().default("active"), // active | closed
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Agent Chat Message ────────────────────────────────────────────────────────

export const agentChatMessage = sqliteTable("agent_chat_message", {
  id: text("id").primaryKey(), // UUID v4
  sessionId: text("session_id").notNull().references(() => agentChatSession.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant | system
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Operation Audit Log ───────────────────────────────────────────────────────

export const operationAuditLog = sqliteTable("operation_audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entityType: text("entity_type").notNull(), // task | document | production_list | director_profile | ...
  entityId: text("entity_id").notNull(),
  operation: text("operation").notNull(), // create | update | delete | normalize | button_execute | ...
  actor: text("actor").notNull().default("user"), // user | agent | opencode
  snapshotJson: text("snapshot_json"), // JSON snapshot of entity state
  requestId: text("request_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
