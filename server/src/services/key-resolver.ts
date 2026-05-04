/**
 * API Key Resolver -- DB-first, env-fallback.
 *
 * All routes that need to check or use the OpenRouter API key should import
 * from this module instead of reading env.openRouterApiKey directly.
 *
 * Resolution order:
 * 1. DB settings row (encrypted value -> decrypt)
 * 2. DB settings row (legacy plaintext)
 * 3. process.env.OPENROUTER_API_KEY (fallback)
 *
 * This module imports db/index and db/schema directly (no circular deps:
 * db does not import config/env, and config/env no longer imports db).
 */

import { getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { env, decryptApiKey } from "../config/env.js";

/**
 * Resolve API key with DB-first priority.
 * Returns null if no key is configured anywhere.
 */
export function resolveApiKey(): string | null {
  // Try DB first
  try {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.id, 1)).get() as
      | { openRouterApiKey: string | null }
      | undefined;

    if (row?.openRouterApiKey) {
      // Try to decrypt (new encrypted format)
      const decrypted = decryptApiKey(row.openRouterApiKey);
      if (decrypted) return decrypted;

      // Legacy: plaintext stored before encryption was introduced
      if (row.openRouterApiKey.length > 0) return row.openRouterApiKey;
    }
  } catch {
    // DB not ready yet (very early startup) -- fall through to env
  }

  // Fallback to process.env
  return env.openRouterApiKey;
}

/**
 * Check if OpenRouter API Key is configured (DB or env).
 */
export function isOpenRouterConfigured(): boolean {
  const key = resolveApiKey();
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Get the API key. Throws if not configured anywhere.
 * Resolves from DB first, then env.
 */
export function requireApiKey(): string {
  const key = resolveApiKey();
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return key;
}
