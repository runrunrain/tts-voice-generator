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

export type ProviderKeyId = "openrouter" | "elevenlabs" | "fish-audio";

const PROVIDER_KEY_FIELDS: Record<ProviderKeyId, keyof typeof settings.$inferSelect> = {
  openrouter: "openRouterApiKey",
  elevenlabs: "elevenLabsApiKey",
  "fish-audio": "fishAudioApiKey",
};

const PROVIDER_ENV_FALLBACK: Record<ProviderKeyId, string | null> = {
  openrouter: env.openRouterApiKey,
  elevenlabs: env.elevenLabsApiKey,
  "fish-audio": env.fishAudioApiKey,
};

/**
 * Resolve API key with DB-first priority.
 * Returns null if no key is configured anywhere.
 */
export function resolveApiKey(): string | null {
  return resolveProviderApiKey("openrouter");
}

export function resolveProviderApiKey(provider: ProviderKeyId): string | null {
  // Try DB first
  try {
    const db = getDb();
    const fieldName = PROVIDER_KEY_FIELDS[provider];
    const row = db.select().from(settings).where(eq(settings.id, 1)).get() as
      | Partial<Record<typeof fieldName, string | null>>
      | undefined;

    const storedKey = row?.[fieldName];
    if (storedKey) {
      // Try to decrypt (new encrypted format)
      const decrypted = decryptApiKey(storedKey);
      if (decrypted) return decrypted;

      // Legacy: plaintext stored before encryption was introduced
      if (storedKey.length > 0) return storedKey;
    }
  } catch {
    // DB not ready yet (very early startup) -- fall through to env
  }

  // Fallback to process.env
  return PROVIDER_ENV_FALLBACK[provider];
}

/**
 * Check if OpenRouter API Key is configured (DB or env).
 */
export function isOpenRouterConfigured(): boolean {
  return isProviderConfigured("openrouter");
}

export function isProviderConfigured(provider: ProviderKeyId): boolean {
  const key = resolveProviderApiKey(provider);
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Get the API key. Throws if not configured anywhere.
 * Resolves from DB first, then env.
 */
export function requireApiKey(): string {
  return requireProviderApiKey("openrouter");
}

export function requireProviderApiKey(provider: ProviderKeyId): string {
  const key = resolveProviderApiKey(provider);
  if (!key) {
    throw new Error(`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY is not configured`);
  }
  return key;
}
