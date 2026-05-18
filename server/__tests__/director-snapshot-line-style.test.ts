import { describe, expect, it } from "vitest";
import { resolvePromptAssemblyInput } from "../src/routes/production-list-modules/director-snapshot.js";
import { assemblePrompt } from "../src/services/prompt-assembly.js";

const profile = {
  id: "profile_line_style",
  name: "Line style profile",
  audioProfile: "Warm, clear narrator voice for backend tests.",
  scene: "Controlled studio scene for prompt assembly.",
  directorNotes: "Maintain clear pronunciation and steady direction.",
  sampleContext: "Use this context only as performance guidance.",
  style: "Director baseline style.",
  pacing: "Natural pace.",
  accent: "Standard Mandarin.",
  emotion: "Neutral and attentive.",
  performanceNotes: "Keep delivery consistent.",
  speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "Speaker baseline style." }],
};

const baseLine = {
  id: "line_1",
  text: "默认语音文本。",
  style: "",
  directorProfileId: profile.id,
  directorOverrideJson: null,
};

describe("director snapshot lineStyle resolution", () => {
  it("keeps artifact line style above stored line style and derived style", () => {
    const result = resolvePromptAssemblyInput(
      { ...baseLine, text: "你准备好了吗？", style: "stored manual style" },
      { id: "line_1", transcript: "你准备好了吗？", promptProfileId: profile.id, style: "artifact manual style" },
      [profile],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.lineStyle).toBe("artifact manual style");
  });

  it("keeps stored line style above derived style when artifact style is empty", () => {
    const result = resolvePromptAssemblyInput(
      { ...baseLine, text: "你准备好了吗？", style: "stored manual style" },
      { id: "line_1", transcript: "你准备好了吗？", promptProfileId: profile.id, style: "" },
      [profile],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.lineStyle).toBe("stored manual style");
  });

  it("derives transient line style for empty manual styles and includes it in assembled prompt", () => {
    const result = resolvePromptAssemblyInput(
      { ...baseLine, text: "默认语音文本。", style: "" },
      { id: "line_1", transcript: "你准备好了吗？", promptProfileId: profile.id, style: "" },
      [profile],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.transcript).toBe("你准备好了吗？");
    expect(result.input.lineStyle).toContain("提问语气");
    expect(result.input.lineStyle).toContain("尾音自然上扬");

    const assembled = assemblePrompt(result.input);
    expect(assembled.prompt).toContain(`Line style override: ${result.input.lineStyle}`);
    expect(assembled.normalized.lineStyle).toBe(result.input.lineStyle);
  });

  it("returns empty line style when transcript has no readable content", () => {
    const result = resolvePromptAssemblyInput(
      { ...baseLine, text: "", style: "" },
      { id: "line_1", transcript: "[pause]", promptProfileId: profile.id, style: "" },
      [profile],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.transcript).toBe("[pause]");
    expect(result.input.lineStyle).toBe("");
  });
});
