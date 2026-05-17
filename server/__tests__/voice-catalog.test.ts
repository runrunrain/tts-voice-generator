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
      expect(["male", "female"]).toContain(voice.perceivedGender);
    }
  });

  it("groups voices by Google/Provider table gender without a neutral category", () => {
    expect(getVoicesByPerceivedGender("female")).toEqual([
      "Zephyr",
      "Kore",
      "Leda",
      "Aoede",
      "Callirrhoe",
      "Autonoe",
      "Despina",
      "Erinome",
      "Laomedeia",
      "Achernar",
      "Gacrux",
      "Pulcherrima",
      "Vindemiatrix",
      "Sulafat",
    ]);
    expect(getVoicesByPerceivedGender("male")).toEqual([
      "Puck",
      "Charon",
      "Fenrir",
      "Orus",
      "Enceladus",
      "Iapetus",
      "Umbriel",
      "Algieba",
      "Algenib",
      "Rasalgethi",
      "Alnilam",
      "Schedar",
      "Achird",
      "Zubenelgenubi",
      "Sadachbia",
      "Sadaltager",
    ]);
    expect(getVoicesByPerceivedGender("female")).toHaveLength(14);
    expect(getVoicesByPerceivedGender("male")).toHaveLength(16);
  });

  it("formats guide and rules with Google/Provider no-neutral wording", () => {
    const guide = formatVoiceSelectionGuideForPrompt();
    expect(guide).toContain("Kore（珂瑞）：Google/Provider表性别=女");
    expect(guide).toContain("Charon（卡戎）：Google/Provider表性别=男");
    expect(guide).toContain("Zephyr（和风）：Google/Provider表性别=女");
    expect(guide).toContain("Gacrux（十字架一）：Google/Provider表性别=女");
    expect(guide).not.toContain("项目感知性别");
    expect(guide).not.toContain("=中性");

    const rules = formatVoiceGenderSelectionRulesForPrompt();
    expect(rules).toContain("Google/Provider voice tables classify every prebuilt Gemini TTS voice as either Female or Male");
    expect(rules).toContain("there is no neutral voice category");
    expect(rules).toContain("female voice: Zephyr, Kore, Leda, Aoede, Callirrhoe, Autonoe, Despina, Erinome, Laomedeia, Achernar, Gacrux, Pulcherrima, Vindemiatrix, Sulafat");
    expect(rules).toContain("male voice: Puck, Charon, Fenrir, Orus, Enceladus, Iapetus, Umbriel, Algieba, Algenib, Rasalgethi, Alnilam, Schedar, Achird, Zubenelgenubi, Sadachbia, Sadaltager");
    expect(rules).toContain("When gender is unknown, infer the intended speaker identity");
    expect(rules).toContain("Do not use or mention a neutral category");
    expect(rules).not.toContain("project-curated perceived gender");
    expect(rules).not.toContain("neutral or unspecified");
  });
});
