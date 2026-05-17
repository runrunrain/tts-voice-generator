import { describe, expect, it } from "vitest";

import {
  formatVoiceGenderSelectionRulesForPrompt,
  formatVoiceSelectionGuideForPrompt,
  GEMINI_VOICE_CATALOG,
  getVoicesByPerceivedGender,
} from "../src/utils/voice.js";

describe("Gemini voice catalog perceived gender metadata", () => {
  it("covers all 30 Gemini voices with valid perceivedGender values", () => {
    expect(GEMINI_VOICE_CATALOG).toHaveLength(30);
    for (const voice of GEMINI_VOICE_CATALOG) {
      expect(["male", "female", "neutral"]).toContain(voice.perceivedGender);
    }
  });

  it("groups voices by project-curated perceived gender", () => {
    expect(getVoicesByPerceivedGender("female")).toEqual([
      "Kore",
      "Leda",
      "Aoede",
      "Despina",
      "Erinome",
      "Laomedeia",
      "Achernar",
      "Sulafat",
    ]);
    expect(getVoicesByPerceivedGender("male")).toEqual([
      "Puck",
      "Charon",
      "Fenrir",
      "Orus",
      "Iapetus",
      "Algenib",
      "Rasalgethi",
      "Alnilam",
      "Gacrux",
      "Sadaltager",
    ]);
    expect(getVoicesByPerceivedGender("neutral")).toEqual([
      "Zephyr",
      "Callirrhoe",
      "Autonoe",
      "Enceladus",
      "Umbriel",
      "Algieba",
      "Schedar",
      "Pulcherrima",
      "Achird",
      "Zubenelgenubi",
      "Vindemiatrix",
      "Sadachbia",
    ]);
  });

  it("formats guide and rules with official-vs-project wording", () => {
    const guide = formatVoiceSelectionGuideForPrompt();
    expect(guide).toContain("Kore（珂瑞）：项目感知性别=女");
    expect(guide).toContain("Charon（卡戎）：项目感知性别=男");
    expect(guide).toContain("Zephyr（和风）：项目感知性别=中性");

    const rules = formatVoiceGenderSelectionRulesForPrompt();
    expect(rules).toContain("Google official docs list voice names/styles");
    expect(rules).toContain("project-curated perceived gender");
    expect(rules).toContain("project female voice: Kore, Leda, Aoede, Despina, Erinome, Laomedeia, Achernar, Sulafat");
    expect(rules).toContain("project male voice: Puck, Charon, Fenrir, Orus, Iapetus, Algenib, Rasalgethi, Alnilam, Gacrux, Sadaltager");
    expect(rules).toContain("neutral or unspecified, do not invent gender");
  });
});
