/**
 * Database connection factory and initialization.
 *
 * Uses better-sqlite3 + Drizzle ORM.
 * Creates data/db/ directory and initialises schema on first run.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import * as schemaExtended from "./schema-extended.js";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { env } from "../config/env.js";

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Get or create the Drizzle database instance.
 * Ensures the directory and file exist.
 */
export function getDb() {
  if (_db) return _db;

  const dbPath = path.resolve(env.dbPath);
  const dbDir = path.dirname(dbPath);

  // Ensure data/db directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Create better-sqlite3 connection with WAL mode for performance
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  _db = drizzle(sqlite, { schema });
  return _db;
}

/**
 * Run DDL to create tables if they don't exist.
 * This is a lightweight alternative to drizzle-kit migrate for MVP.
 */
export function initSchema() {
  const db = getDb();
  const rawDb = (db as unknown as { $client: Database.Database }).$client;

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      open_router_api_key TEXT,
      default_model TEXT NOT NULL DEFAULT 'google/gemini-3.1-flash-tts-preview',
      default_voice TEXT NOT NULL DEFAULT 'Zephyr',
      default_format TEXT NOT NULL DEFAULT 'wav',
      audio_output_dir TEXT NOT NULL DEFAULT './data/audio',
      max_chars_per_request INTEGER NOT NULL DEFAULT 5000,
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
      local_plugin_token TEXT,
      agent_auth_mode TEXT NOT NULL DEFAULT 'confirm_each',
      agent_max_requests INTEGER NOT NULL DEFAULT 10,
      agent_max_chars INTEGER NOT NULL DEFAULT 10000,
      agent_max_cost REAL NOT NULL DEFAULT 0.01,
      agent_session_expiry INTEGER NOT NULL DEFAULT 3600,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS voice_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'openrouter',
      model TEXT,
      role TEXT,
      source TEXT NOT NULL DEFAULT 'candidate',
      verified_status TEXT NOT NULL DEFAULT 'unknown',
      last_verified INTEGER,
      verify_duration INTEGER,
      verify_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS generation_job (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      voice TEXT NOT NULL,
      response_format TEXT NOT NULL,
      input TEXT NOT NULL,
      input_char_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      generation_id TEXT,
      provider_options TEXT,
      director_snapshot TEXT,
      estimated_cost TEXT,
      actual_cost TEXT,
      error_code TEXT,
      error_message TEXT,
      error_metadata TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      agent_conversation_id TEXT,
      agent_action_log_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS audio_asset (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES generation_job(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT,
      duration TEXT,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS agent_action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      session_id TEXT,
      input_summary TEXT,
      input_payload TEXT,
      output_summary TEXT,
      estimated_cost TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      approval_scope TEXT,
      related_job_id TEXT,
      approved_at INTEGER,
      completed_at INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS agent_session (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      max_requests INTEGER NOT NULL,
      used_requests INTEGER NOT NULL DEFAULT 0,
      max_chars INTEGER NOT NULL,
      used_chars INTEGER NOT NULL DEFAULT 0,
      max_cost REAL NOT NULL,
      used_cost REAL NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  addColumnIfMissing(rawDb, "settings", "local_plugin_token", "TEXT");
  addColumnIfMissing(rawDb, "settings", "agent_auth_mode", "TEXT NOT NULL DEFAULT 'confirm_each'");
  addColumnIfMissing(rawDb, "settings", "agent_max_requests", "INTEGER NOT NULL DEFAULT 10");
  addColumnIfMissing(rawDb, "settings", "agent_max_chars", "INTEGER NOT NULL DEFAULT 10000");
  addColumnIfMissing(rawDb, "settings", "agent_max_cost", "REAL NOT NULL DEFAULT 0.01");
  addColumnIfMissing(rawDb, "settings", "agent_session_expiry", "INTEGER NOT NULL DEFAULT 3600");
  addColumnIfMissing(rawDb, "generation_job", "source", "TEXT NOT NULL DEFAULT 'user'");
  addColumnIfMissing(rawDb, "generation_job", "agent_conversation_id", "TEXT");
  addColumnIfMissing(rawDb, "generation_job", "agent_action_log_id", "INTEGER");
  addColumnIfMissing(rawDb, "agent_action_log", "session_id", "TEXT");
  addColumnIfMissing(rawDb, "agent_action_log", "input_payload", "TEXT");
  addColumnIfMissing(rawDb, "agent_action_log", "approved_at", "INTEGER");
  addColumnIfMissing(rawDb, "agent_action_log", "completed_at", "INTEGER");
  addColumnIfMissing(rawDb, "agent_action_log", "error_code", "TEXT");
  addColumnIfMissing(rawDb, "agent_action_log", "error_message", "TEXT");
  addColumnIfMissing(rawDb, "audio_asset", "sample_rate", "INTEGER");
  addColumnIfMissing(rawDb, "audio_asset", "bit_depth", "INTEGER");
  addColumnIfMissing(rawDb, "audio_asset", "channels", "INTEGER");

  // ─── P0 Voice Production Extended Tables ──────────────────────────────────

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS voice_task (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS requirement_document (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'paste',
      enabled INTEGER NOT NULL DEFAULT 1,
      content_sha256 TEXT,
      content_size_bytes INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS director_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS production_list_version (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      director_profile_id TEXT,
      speakers_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      line_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS voice_line (
      id TEXT PRIMARY KEY,
      line_id TEXT,
      task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL REFERENCES production_list_version(id) ON DELETE CASCADE,
      "order" INTEGER NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      voice TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      director_profile_id TEXT,
      director_override_json TEXT,
      generation_status TEXT NOT NULL DEFAULT 'draft',
      related_job_id TEXT,
      related_asset_id INTEGER,
      last_generation_signature TEXT,
      last_generation_snapshot_json TEXT,
      generation_error_code TEXT,
      generation_error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS opencode_session (
      id TEXT PRIMARY KEY,
      session_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      task_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS agent_button_preset (
      id TEXT PRIMARY KEY,
      button_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt_template TEXT NOT NULL DEFAULT '',
      target_policy_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS agent_button_run (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
      button_key TEXT NOT NULL,
      target_line_id TEXT NOT NULL,
      runner TEXT NOT NULL DEFAULT 'fallback',
      input_snapshot_json TEXT,
      output_snapshot_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS agent_chat_session (
      id TEXT PRIMARY KEY,
      opencode_session_id TEXT,
      task_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS agent_chat_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_chat_session(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS operation_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      snapshot_json TEXT,
      request_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Document version conflict protection migration (must be after table creation)
  addColumnIfMissing(rawDb, "requirement_document", "version", "INTEGER NOT NULL DEFAULT 1");

  // R-M2: Unique index on (task_id, version) to prevent concurrent normalize runs
  // from creating duplicate versions. This is the DB-level backstop for the
  // application-level version check inside the DB transaction.
  rawDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS production_list_version_task_id_version_unique
    ON production_list_version(task_id, version)
  `);

  // Task list/detail statistics query indexes. These are intentionally
  // idempotent and backward-compatible for existing local databases.
  rawDb.exec(`
    CREATE INDEX IF NOT EXISTS requirement_document_task_id_idx
    ON requirement_document(task_id);

    CREATE INDEX IF NOT EXISTS production_list_version_task_id_idx
    ON production_list_version(task_id);

    CREATE INDEX IF NOT EXISTS voice_line_version_id_idx
    ON voice_line(version_id);

    CREATE INDEX IF NOT EXISTS voice_line_task_id_idx
    ON voice_line(task_id);
  `);

  // Voice line director binding + generation tracking (P2-phase1 schema extension)
  // All new columns allow NULL or have safe defaults for backward compatibility.
  addColumnIfMissing(rawDb, "voice_line", "line_id", "TEXT");
  addColumnIfMissing(rawDb, "voice_line", "director_profile_id", "TEXT");
  addColumnIfMissing(rawDb, "voice_line", "director_override_json", "TEXT");
  addColumnIfMissing(rawDb, "voice_line", "generation_status", "TEXT NOT NULL DEFAULT 'draft'");
  addColumnIfMissing(rawDb, "voice_line", "related_job_id", "TEXT");
  addColumnIfMissing(rawDb, "voice_line", "related_asset_id", "INTEGER");
  addColumnIfMissing(rawDb, "voice_line", "last_generation_signature", "TEXT");
  addColumnIfMissing(rawDb, "voice_line", "last_generation_snapshot_json", "TEXT");
  addColumnIfMissing(rawDb, "voice_line", "updated_at", "INTEGER");
  // Generation error tracking fields (MIN-2)
  addColumnIfMissing(rawDb, "voice_line", "generation_error_code", "TEXT");
  addColumnIfMissing(rawDb, "voice_line", "generation_error_message", "TEXT");

  // Seed default button presets if empty
  seedButtonPresets(rawDb);
}

function seedButtonPresets(rawDb: Database.Database) {
  const count = (rawDb.prepare("SELECT COUNT(*) as c FROM agent_button_preset").get() as { c: number }).c;
  if (count > 0) return;

  const now = Math.floor(Date.now() / 1000);
  const presets = [
    {
      buttonKey: "normalize-requirements",
      name: "Generate Production List",
      description: "Normalize requirement documents into a structured production list with voice lines",
      promptTemplate: "Read the requirement documents for task {{taskId}} and generate a production list. Each voice line must have: id, order, speaker, text, voice. Include a speakers array (max 2). Return the result using tts_save_production_list.",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text", "voice", "speaker", "style", "notes"], scope: "task" }),
      sortOrder: 0,
    },
    {
      buttonKey: "complete-director-fields",
      name: "Complete Director Fields",
      description: "Fill in missing director profile fields for lines that lack director binding",
      promptTemplate: "For each voice line in the production list that has no directorProfileId, suggest appropriate audio profile, scene, and director notes based on the line content. Use tts_patch_voice_lines to update the directorProfileId field.",
      targetPolicyJson: JSON.stringify({ allowedFields: ["directorProfileId", "directorOverrideJson"], scope: "list" }),
      sortOrder: 7,
    },
    {
      buttonKey: "fix-validation-errors",
      name: "Fix Validation Errors",
      description: "Automatically fix validation errors in the production list (missing fields, invalid speaker references, etc.)",
      promptTemplate: "Check the production list for validation errors using tts_production_validate. For each error found, fix the issue using tts_patch_voice_lines. Common fixes: ensure speaker references match speakers array, fill empty text fields, correct voice names.",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text", "voice", "speaker", "style", "notes"], scope: "list" }),
      sortOrder: 8,
    },
    {
      buttonKey: "shorten",
      name: "Shorten",
      description: "Shorten the target line text while preserving meaning",
      promptTemplate: "Shorten the following voice line while preserving its meaning and natural flow for speech: {{text}}",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text"], scope: "line" }),
      sortOrder: 10,
    },
    {
      buttonKey: "expand",
      name: "Expand",
      description: "Expand the target line text with more detail",
      promptTemplate: "Expand the following voice line with more descriptive detail while keeping it natural for speech: {{text}}",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text"], scope: "line" }),
      sortOrder: 11,
    },
    {
      buttonKey: "rewrite",
      name: "Rewrite",
      description: "Rewrite the target line with instruction",
      promptTemplate: "Rewrite the following voice line according to the instruction: {{instruction}}. Original: {{text}}",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text"], scope: "line" }),
      sortOrder: 12,
    },
    {
      buttonKey: "style-formal",
      name: "Style: Formal",
      description: "Apply formal tone to the target line",
      promptTemplate: "Rewrite the following voice line in a formal tone: {{text}}",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text", "style"], scope: "line" }),
      sortOrder: 13,
    },
    {
      buttonKey: "style-casual",
      name: "Style: Casual",
      description: "Apply casual tone to the target line",
      promptTemplate: "Rewrite the following voice line in a casual, friendly tone: {{text}}",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text", "style"], scope: "line" }),
      sortOrder: 14,
    },
    {
      buttonKey: "style-dramatic",
      name: "Style: Dramatic",
      description: "Apply dramatic tone to the target line",
      promptTemplate: "Rewrite the following voice line in a dramatic, expressive tone: {{text}}",
      targetPolicyJson: JSON.stringify({ allowedFields: ["text", "style"], scope: "line" }),
      sortOrder: 15,
    },
  ];

  const stmt = rawDb.prepare(
    `INSERT INTO agent_button_preset (id, button_key, name, description, prompt_template, target_policy_json, sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );

  for (const p of presets) {
    stmt.run(
      crypto.randomUUID(),
      p.buttonKey,
      p.name,
      p.description,
      p.promptTemplate,
      p.targetPolicyJson,
      p.sortOrder,
      now,
      now,
    );
  }
}

function addColumnIfMissing(rawDb: Database.Database, table: string, column: string, definition: string) {
  const columns = rawDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    rawDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Close the database connection (for graceful shutdown).
 */
export function closeDb() {
  if (_db) {
    const rawDb = (_db as unknown as { $client: Database.Database }).$client;
    rawDb.close();
    _db = null;
  }
}
