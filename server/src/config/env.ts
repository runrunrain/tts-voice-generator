/**
 * Environment configuration loader.
 * Reads from process.env and optional .env file.
 * API Key is ONLY accessible server-side.
 *
 * For runtime API key resolution (DB-first), use resolveApiKey() from
 * ../services/key-resolver.js instead of reading env.openRouterApiKey directly.
 */

import "dotenv/config";
import crypto from "node:crypto";

interface EnvConfig {
  port: number;
  openRouterApiKey: string | null;
  openRouterBaseUrl: string;
  audioOutputDir: string;
  dbPath: string;
  dataDir: string;
  nodeEnv: string;
  enableLoudnessNormalization: boolean;
  loudnessTargetLufs: number;
  ffmpegPath: string | null;
}

function loadEnv(): EnvConfig {
  return {
    port: parseInt(process.env.PORT || "3001", 10),
    openRouterApiKey: process.env.OPENROUTER_API_KEY || null,
    openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    audioOutputDir: process.env.AUDIO_OUTPUT_DIR || "./data/audio",
    dbPath: process.env.DB_PATH || "./data/db/tts-generator.db",
    dataDir: process.env.DATA_DIR || "./data",
    nodeEnv: process.env.NODE_ENV || "development",
    enableLoudnessNormalization: process.env.ENABLE_LOUDNESS_NORMALIZATION === "true",
    loudnessTargetLufs: parseLoudnessTarget(process.env.LOUDNESS_TARGET_LUFS),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || null,
  };
}

function parseLoudnessTarget(value: string | undefined): number {
  if (!value) return -16;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= -30 && parsed <= -6 ? parsed : -16;
}

export const env = loadEnv();

// ─── API Key Encryption ───────────────────────────────────────────────────────
// Local encryption using a derived key from env + fixed salt.
// This prevents plaintext keys from being stored in the DB while remaining
// fully self-contained (no external KMS dependency).
// Trade-off documented: this is NOT equivalent to a hardware security module,
// but it prevents casual DB inspection from revealing keys.

const ENCRYPTION_KEY_SALT = "tts-voice-generator-key-encryption-v1";

function getEncryptionKey(): Buffer {
  // Derive a 32-byte key from DB path (stable per deployment) + fixed salt
  const dbPath = env.dbPath || "./data/db/tts-generator.db";
  return crypto.scryptSync(dbPath, ENCRYPTION_KEY_SALT, 32);
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt a plaintext string. Returns a base64-encoded ciphertext.
 */
export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv + authTag + ciphertext, all base64
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64-encoded ciphertext back to plaintext.
 * Returns null if decryption fails (corrupted data, wrong key, etc.).
 */
export function decryptApiKey(ciphertext: string): string | null {
  try {
    const key = getEncryptionKey();
    const raw = Buffer.from(ciphertext, "base64");
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch {
    return null;
  }
}

/**
 * Mask an API key for frontend display.
 * Returns "sk-***...****" with first 3 and last 4 chars visible if long enough,
 * otherwise "***configured***".
 */
export function maskApiKey(key: string): string {
  if (key.length > 12) {
    return `${key.slice(0, 3)}***...***${key.slice(-4)}`;
  }
  return "***configured***";
}

/**
 * Check if OpenRouter API Key is configured in env only.
 * For full resolution (DB + env), use isOpenRouterConfigured() from key-resolver.
 */
export function isEnvApiKeyConfigured(): boolean {
  return typeof env.openRouterApiKey === "string" && env.openRouterApiKey.trim().length > 0;
}

/**
 * Get the API key from env only. Throws if not configured.
 * For full resolution (DB + env), use requireApiKey() from key-resolver.
 */
export function requireEnvApiKey(): string {
  if (!env.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return env.openRouterApiKey;
}
