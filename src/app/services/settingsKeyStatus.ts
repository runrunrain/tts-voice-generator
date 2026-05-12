export const CONFIGURED_OPENROUTER_KEY_SENTINEL = "***configured***";

type SettingsApiPayload = {
  hasOpenRouterApiKey?: unknown;
  keyMask?: unknown;
  openRouterApiKey?: unknown;
};

export type SettingsConnectionTestPayload = {
  ok?: unknown;
  authValid?: unknown;
};

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function hasSavedOpenRouterKey(value: unknown): boolean {
  return nonEmptyString(value) !== null;
}

export function hasSavedOpenRouterKeyFromPayload(payload: SettingsApiPayload): boolean {
  return payload.hasOpenRouterApiKey === true
    || hasSavedOpenRouterKey(payload.keyMask)
    || hasSavedOpenRouterKey(payload.openRouterApiKey);
}

export function getOpenRouterKeyDisplayValue(payload: SettingsApiPayload): string {
  if (!hasSavedOpenRouterKeyFromPayload(payload)) return "";
  return nonEmptyString(payload.keyMask)
    ?? nonEmptyString(payload.openRouterApiKey)
    ?? CONFIGURED_OPENROUTER_KEY_SENTINEL;
}

export function isMaskedOrSentinelOpenRouterKey(value: unknown): boolean {
  const keyValue = nonEmptyString(value);
  if (!keyValue) return false;
  return keyValue === CONFIGURED_OPENROUTER_KEY_SENTINEL || keyValue.includes("***");
}

export function shouldSendOpenRouterApiKey(value: unknown): value is string {
  return hasSavedOpenRouterKey(value) && !isMaskedOrSentinelOpenRouterKey(value);
}

export function isSuccessfulSettingsConnection(payload: SettingsConnectionTestPayload): boolean {
  return payload.ok === true && payload.authValid === true;
}
