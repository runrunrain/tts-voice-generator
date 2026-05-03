/**
 * Environment configuration loader.
 * Reads from process.env and optional .env file.
 * API Key is ONLY accessible server-side.
 */

import "dotenv/config";

interface EnvConfig {
  port: number;
  openRouterApiKey: string | null;
  openRouterBaseUrl: string;
  audioOutputDir: string;
  dbPath: string;
  dataDir: string;
  nodeEnv: string;
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
  };
}

export const env = loadEnv();

/**
 * Check if OpenRouter API Key is configured.
 * Returns true only if a non-empty key exists in env.
 */
export function isOpenRouterConfigured(): boolean {
  return typeof env.openRouterApiKey === "string" && env.openRouterApiKey.trim().length > 0;
}

/**
 * Get the API key. Throws if not configured.
 * Use this in routes that require the key.
 */
export function requireApiKey(): string {
  if (!env.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return env.openRouterApiKey;
}
