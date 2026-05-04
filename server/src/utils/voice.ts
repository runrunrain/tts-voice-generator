/**
 * Voice canonicalization utilities.
 *
 * Policy:
 * - `Zephyr` is the canonical default voice (Gemini TTS).
 * - `alloy` is a legacy alias that maps to `Zephyr`.
 * - All new configuration output must use canonical names.
 * - Legacy alias is accepted as input for backward compatibility.
 */

/** Map of legacy alias -> canonical voice name */
const VOICE_ALIAS_MAP: ReadonlyMap<string, string> = new Map([
  ["alloy", "Zephyr"],
]);

/**
 * Canonicalize a voice name.
 *
 * - If the voice is a known legacy alias, returns the canonical name.
 * - Otherwise returns the voice unchanged (pass-through for valid Gemini voices).
 * - Case-insensitive for alias matching.
 */
export function canonicalizeVoice(voice: string): string {
  if (!voice) return "Zephyr";
  const mapped = VOICE_ALIAS_MAP.get(voice.toLowerCase());
  return mapped ?? voice;
}

/**
 * Check if a voice name is a known legacy alias.
 */
export function isLegacyAlias(voice: string): boolean {
  return VOICE_ALIAS_MAP.has(voice.toLowerCase());
}

/**
 * Get the canonical default voice name.
 */
export function getDefaultVoice(): string {
  return "Zephyr";
}
