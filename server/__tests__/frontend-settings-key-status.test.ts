import { describe, expect, it } from "vitest";
import {
  CONFIGURED_OPENROUTER_KEY_SENTINEL,
  getOpenRouterKeyDisplayValue,
  hasSavedOpenRouterKey,
  hasSavedOpenRouterKeyFromPayload,
  isSuccessfulSettingsConnection,
  shouldSendOpenRouterApiKey,
} from "../../src/app/services/settingsKeyStatus";

describe("frontend Settings saved key and connection status", () => {
  it("treats a backend masked key as saved so the page does not show unconfigured", () => {
    const payload = {
      hasOpenRouterApiKey: true,
      keyMask: "sk-***...***1234",
      openRouterApiKey: "sk-***...***1234",
    };

    const displayValue = getOpenRouterKeyDisplayValue(payload);

    expect(displayValue).toBe("sk-***...***1234");
    expect(hasSavedOpenRouterKey(displayValue)).toBe(true);
    expect(hasSavedOpenRouterKeyFromPayload(payload)).toBe(true);
  });

  it("treats the legacy sentinel as saved but empty values as unconfigured", () => {
    expect(getOpenRouterKeyDisplayValue({ openRouterApiKey: CONFIGURED_OPENROUTER_KEY_SENTINEL })).toBe(CONFIGURED_OPENROUTER_KEY_SENTINEL);
    expect(hasSavedOpenRouterKey(getOpenRouterKeyDisplayValue({ hasOpenRouterApiKey: false, keyMask: null, openRouterApiKey: "" }))).toBe(false);
  });

  it("does not send masked or sentinel key values back to the settings API", () => {
    expect(shouldSendOpenRouterApiKey("sk-new-real-key-12345678")).toBe(true);
    expect(shouldSendOpenRouterApiKey("sk-***...***1234")).toBe(false);
    expect(shouldSendOpenRouterApiKey(CONFIGURED_OPENROUTER_KEY_SENTINEL)).toBe(false);
    expect(shouldSendOpenRouterApiKey("")).toBe(false);
  });

  it("requires explicit authValid=true before showing connection test success", () => {
    expect(isSuccessfulSettingsConnection({ ok: true, authValid: true })).toBe(true);
    expect(isSuccessfulSettingsConnection({ ok: true, authValid: false })).toBe(false);
    expect(isSuccessfulSettingsConnection({ ok: true })).toBe(false);
    expect(isSuccessfulSettingsConnection({ ok: false, authValid: true })).toBe(false);
  });
});
