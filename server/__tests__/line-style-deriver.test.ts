import { describe, expect, it } from "vitest";
import { deriveLineStyleFromTranscript } from "../src/utils/line-style-deriver.js";

function phraseCount(value: string): number {
  return value ? value.split("，").length : 0;
}

describe("deriveLineStyleFromTranscript", () => {
  it("returns empty style for empty, whitespace, tag-only, and one-character text", () => {
    expect(deriveLineStyleFromTranscript("")).toBe("");
    expect(deriveLineStyleFromTranscript("   \n\t  ")).toBe("");
    expect(deriveLineStyleFromTranscript("[happy] [pause]")).toBe("");
    expect(deriveLineStyleFromTranscript("啊")).toBe("");
  });

  it("derives question performance style", () => {
    const style = deriveLineStyleFromTranscript("你准备好了吗？");
    expect(style).toContain("提问语气");
    expect(style).toContain("尾音自然上扬");
  });

  it("derives exclamation performance style", () => {
    const style = deriveLineStyleFromTranscript("太好了！我们终于完成了！");
    expect(style).toContain("感叹表达");
    expect(style).toContain("情绪更饱满");
  });

  it("derives task guidance performance style", () => {
    const style = deriveLineStyleFromTranscript("请先打开设置，然后确认音色。");
    expect(style).toContain("事务引导");
    expect(style).toContain("表达清晰");
  });

  it("derives dialogue performance style", () => {
    const style = deriveLineStyleFromTranscript("他说：“我会回来。”");
    expect(style).toContain("对话感自然");
  });

  it("derives dialogue performance style for colon-led speech", () => {
    expect(deriveLineStyleFromTranscript("旁白：你好，欢迎回来。")).toContain("对话感自然");
    expect(deriveLineStyleFromTranscript("他说：我会回来。")).toContain("对话感自然");
  });

  it("derives long narration performance style", () => {
    const style = deriveLineStyleFromTranscript("这是一段用于测试长段叙述规则的文字。".repeat(12));
    expect(style).toContain("长段叙述");
    expect(style).toContain("分句停顿清晰");
  });

  it("uses default narration style for ordinary statements", () => {
    expect(deriveLineStyleFromTranscript("今天的课程将介绍语音生成系统的核心流程和注意事项。"))
      .toBe("自然叙述，语气清晰可信，节奏平稳");
  });

  it("keeps multi-rule output short and limited to three phrases", () => {
    const style = deriveLineStyleFromTranscript("[whisper] 为什么你终于确认完成了？！请告诉我下一步怎么处理，然后选择继续。".repeat(4));
    expect(style).toContain("轻声贴近");
    expect(style).toContain("提问语气");
    expect(style.length).toBeLessThanOrEqual(64);
    expect(phraseCount(style)).toBeLessThanOrEqual(3);
  });
});
