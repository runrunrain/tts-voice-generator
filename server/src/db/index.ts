/**
 * Database connection factory and initialization.
 *
 * Uses better-sqlite3 + Drizzle ORM.
 * Creates data/db/ directory and initialises schema on first run.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import path from "node:path";
import fs from "node:fs";
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
