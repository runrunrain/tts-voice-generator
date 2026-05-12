/**
 * GAP Fix Tests: OpenCode Timeout Strategy + Fallback Markdown Parser
 *
 * Covers both Major gaps from real API browser production validation:
 *
 * GAP-1: OpenCode normalize timeout was hardcoded at 30s, causing premature fallback.
 *   - computeNormalizeTimeout defaults to 120s
 *   - Env var override (OPENCODE_NORMALIZE_TIMEOUT_MS)
 *   - Env var clamped to min/max range
 *   - Document scale adaptive computation
 *   - Timeout kill + fallback with runnerStatus
 *   - Metadata does not contain sensitive fields
 *
 * GAP-2: Fallback normalize treated Markdown table separator rows as voice lines.
 *   - |---|---| is NOT a voice line
 *   - | :--- | ---: | is NOT a voice line
 *   - Table body rows with semantic content ARE voice lines
 *   - Pure syntax lines are skipped
 *   - Horizontal rules are skipped
 *   - parseStats track skipped rows
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

import {
  computeBundleNormalizeTimeout,
  computeNormalizeTimeout,
  extractCandidateLines,
  fallbackNormalize,
  isTableSeparator,
  isSyntaxOnlyLine,
  runOpenCodeNormalize,
  sanitizeError,
  _setSpawnRunner,
  _resetSpawnRunner,
} from "../src/services/opencode-runner.js";
import { validateProductionList } from "../src/domain/validators.js";

// ─── GAP-1: Timeout Configuration ──────────────────────────────────────────────

describe("GAP-1: computeNormalizeTimeout", () => {
  const originalTimeout = process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
  const originalMaxTimeout = process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;

  afterEach(() => {
    // Restore env vars
    if (originalTimeout !== undefined) {
      process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    }
    if (originalMaxTimeout !== undefined) {
      process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = originalMaxTimeout;
    } else {
      delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    }
  });

  it("defaults to 120s base + scale for a small document", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 500 });
    // base=120000, scaleByChars=ceil(500/4000)*30000 = 1*30000 = 30000
    // scaleByDocs=max(0,1-1)*10000 = 0
    // computed = 120000+30000+0 = 150000
    expect(timeout).toBe(150_000);
  });

  it("returns at least 120s for a small document", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 0 });
    // base=120000, scaleByChars=ceil(0/4000)*30000 = 0
    // scaleByDocs=0
    // computed = 120000
    expect(timeout).toBe(120_000);
  });

  it("scales up with document character count", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // 8000 chars -> ceil(8000/4000)*30000 = 2*30000 = 60000
    // base=120000 + 60000 + 0 = 180000
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 8000 });
    expect(timeout).toBe(180_000);
  });

  it("scales up with document count", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // 3 docs, 1000 chars
    // base=120000, scaleByChars=ceil(1000/4000)*30000=30000
    // scaleByDocs=max(0,3-1)*10000=20000
    // computed = 120000+30000+20000 = 170000
    const timeout = computeNormalizeTimeout({ docCount: 3, charCount: 1000 });
    expect(timeout).toBe(170_000);
  });

  it("clamps to max timeout (300s default)", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // Very large: 50 docs, 100000 chars
    // base=120000, scaleByChars=ceil(100000/4000)*30000=25*30000=750000
    // scaleByDocs=max(0,50-1)*10000=490000
    // computed = 120000+750000+490000 = 1360000 -> clamped to 300000
    const timeout = computeNormalizeTimeout({ docCount: 50, charCount: 100_000 });
    expect(timeout).toBe(300_000);
  });

  it("respects OPENCODE_NORMALIZE_TIMEOUT_MS env var", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "180000";
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // base=180000, scaleByChars=ceil(500/4000)*30000=30000
    // computed = 180000+30000 = 210000
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 500 });
    expect(timeout).toBe(210_000);
  });

  it("clamps OPENCODE_NORMALIZE_TIMEOUT_MS below minimum to 30s", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "5000"; // below 30s min
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // base clamped to 30000
    // scaleByChars=ceil(0/4000)*30000 = 0
    // computed = 30000
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 0 });
    expect(timeout).toBe(30_000);
  });

  it("clamps OPENCODE_NORMALIZE_TIMEOUT_MS above maximum to 300s", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "999999";
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // base clamped to 300000 (max)
    // computed = 300000 (clamped by max)
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 0 });
    expect(timeout).toBe(300_000);
  });

  it("falls back to default for non-numeric env var", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "not-a-number";
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // base=120000 (fallback to default)
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 0 });
    expect(timeout).toBe(120_000);
  });

  it("respects OPENCODE_NORMALIZE_MAX_TIMEOUT_MS env var", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "120000";
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "200000";
    // base=120000, scaleByChars for 8000 chars = 60000
    // computed = 180000, clamped to 200000 -> 180000 (under max)
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 8000 });
    expect(timeout).toBe(180_000);

    // Now test that max actually clamps
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "150000";
    // computed = 180000, clamped to 150000
    const timeout2 = computeNormalizeTimeout({ docCount: 1, charCount: 8000 });
    expect(timeout2).toBe(150_000);
  });

  it("OPENCODE_NORMALIZE_MAX_TIMEOUT_MS cannot exceed 300s hard cap", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "120000";
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "600000"; // Attempt to set 600s
    // maxTimeout clamped to 300000 (hard cap)
    // base=120000, scaleByChars for 8000 chars = 60000
    // computed = 180000, clamped to 300000 -> 180000 (under max anyway)
    const timeout = computeNormalizeTimeout({ docCount: 1, charCount: 8000 });
    expect(timeout).toBe(180_000);

    // Verify 600s env is clamped by testing a case where computed > 300s
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "120000";
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "600000";
    // Large docs: 50 docs, 100000 chars
    // base=120000, scaleByChars=25*30000=750000, scaleByDocs=490000
    // computed = 1360000, clamped to 300000 (not 600000!)
    const timeout2 = computeNormalizeTimeout({ docCount: 50, charCount: 100_000 });
    expect(timeout2).toBe(300_000);
  });

  it("handles docCount=0 gracefully", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    // docCount=0, charCount=0
    // scaleByDocs=max(0,0-1)*10000 = max(0,-1)*10000 = 0
    const timeout = computeNormalizeTimeout({ docCount: 0, charCount: 0 });
    expect(timeout).toBe(120_000);
  });
});

describe("GAP-1B: computeBundleNormalizeTimeout", () => {
  const originalTimeout = process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
  const originalMaxTimeout = process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout !== undefined) {
      process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    }
    if (originalMaxTimeout !== undefined) {
      process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = originalMaxTimeout;
    } else {
      delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    }
  });

  it("keeps a small bundle document at the normal adaptive timeout", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;

    const timeout = computeBundleNormalizeTimeout({
      docCount: 1,
      charCount: 500,
      currentLineCount: 0,
      estimatedLineCount: 1,
    });

    expect(timeout).toBe(150_000);
  });

  it("raises a large output bundle with 192 current lines to the 300s budget", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;

    const timeout = computeBundleNormalizeTimeout({
      docCount: 1,
      charCount: 500,
      currentLineCount: 192,
      estimatedLineCount: 1,
    });

    expect(timeout).toBe(300_000);
  });

  it("respects a lower OPENCODE_NORMALIZE_MAX_TIMEOUT_MS test cap", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "30000";
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "60000";

    const timeout = computeBundleNormalizeTimeout({
      docCount: 1,
      charCount: 500,
      currentLineCount: 192,
      estimatedLineCount: 1,
    });

    expect(timeout).toBe(60_000);
  });

  it("allows quality-priority bundle normalize to exceed the standard 300s cap", () => {
    delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;

    const timeout = computeBundleNormalizeTimeout({
      docCount: 1,
      charCount: 500,
      currentLineCount: 192,
      estimatedLineCount: 1,
      qualityPriority: true,
    });

    expect(timeout).toBeGreaterThan(300_000);
    expect(timeout).toBe(900_000);
  });

  it("quality-priority bundle normalize still respects a lower test cap", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "30000";
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "60000";

    const timeout = computeBundleNormalizeTimeout({
      docCount: 1,
      charCount: 500,
      currentLineCount: 192,
      estimatedLineCount: 1,
      qualityPriority: true,
    });

    expect(timeout).toBe(60_000);
  });
});

describe("Quality candidate extraction filtering", () => {
  it("filters source, title, scrape time, field labels, voice labels, urls, and section markers", () => {
    const result = extractCandidateLines({
      documents: [{
        id: "doc-quality",
        fileName: "polluted.md",
        enabled: true,
        content: [
          "来源：https://example.com/source",
          "标题：这不是台词",
          "抓取时间：2026-05-08 10:00:00",
          "https://example.com/only-url",
          "第 1 章",
          "台词：",
          "声线：温柔女声",
          "角色：旁白",
          "台词：真正可播报的一句话。",
          "Narrator: 第二句真实台词。",
        ].join("\n"),
      }],
    });

    expect(result.candidateLines.map((line) => line.transcript)).toEqual([
      "真正可播报的一句话。",
      "第二句真实台词。",
    ]);
    expect(result.qualitySummary.skippedByReason.metadata_source).toBeGreaterThan(0);
    expect(result.qualitySummary.skippedByReason.metadata_title).toBeGreaterThan(0);
    expect(result.qualitySummary.skippedByReason.metadata_scrape_time).toBeGreaterThan(0);
    expect(result.qualitySummary.skippedByReason.url_only).toBeGreaterThan(0);
    expect(result.qualitySummary.skippedByReason.label_only).toBeGreaterThanOrEqual(1);
    expect(result.qualitySummary.skippedByReason.voice_metadata).toBeGreaterThanOrEqual(2);
  });
});

// ─── GAP-1: Timeout kill + fallback with runnerStatus ──────────────────────────

describe("GAP-1: Timeout kill + fallback with runnerStatus", () => {
  afterEach(() => {
    _resetSpawnRunner();
  });

  it("timeout kill triggers fallback with runnerStatus containing timeout info", async () => {
    _setSpawnRunner(async () => {
      throw new Error("opencode run timed out after 120000ms");
    });

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello world\nSecond line", enabled: true },
      ],
    };

    // The normalize route catches the error and calls fallbackNormalize
    // Here we test that runOpenCodeNormalize throws with the right message
    await expect(runOpenCodeNormalize(input)).rejects.toThrow("OPENCODE_RUN_FAILED");
    await expect(runOpenCodeNormalize(input)).rejects.toThrow("timed out after 120000ms");
  });

  it("timeout message is sanitized (no secrets)", async () => {
    _setSpawnRunner(async () => {
      throw new Error("opencode run timed out after 120000ms, stderr contained sk-secret-key-12345678");
    });

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Test", enabled: true },
      ],
    };

    try {
      await runOpenCodeNormalize(input);
      expect.unreachable("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("sk-secret-key-12345678");
      expect(message).toContain("[REDACTED]");
    }
  });
});

// ─── GAP-2: Markdown Table Separator Detection ─────────────────────────────────

describe("GAP-2: isTableSeparator", () => {
  it("detects basic table separator |---|---|", () => {
    expect(isTableSeparator("|---|---|")).toBe(true);
  });

  it("detects table separator with alignment colons | :--- | ---: |", () => {
    expect(isTableSeparator("| :--- | ---: |")).toBe(true);
  });

  it("detects table separator with center alignment | :---: |", () => {
    expect(isTableSeparator("| :---: |")).toBe(true);
  });

  it("detects multi-column separator |---|---|---|", () => {
    expect(isTableSeparator("|---|---|---|")).toBe(true);
  });

  it("detects separator without leading/trailing pipe ---|---|", () => {
    expect(isTableSeparator("---|---|")).toBe(true);
  });

  it("detects separator with spaces around pipes | --- | --- |", () => {
    expect(isTableSeparator("| --- | --- |")).toBe(true);
  });

  it("does NOT match regular text", () => {
    expect(isTableSeparator("Hello world")).toBe(false);
  });

  it("does NOT match table header row | Name | Age |", () => {
    expect(isTableSeparator("| Name | Age |")).toBe(false);
  });

  it("does NOT match table body row | Alice | 30 |", () => {
    expect(isTableSeparator("| Alice | 30 |")).toBe(false);
  });

  it("does NOT match Chinese text", () => {
    expect(isTableSeparator("| 上好的绿豆，买些吧！ |")).toBe(false);
  });

  it("does NOT match empty string", () => {
    expect(isTableSeparator("")).toBe(false);
  });

  it("does NOT match plain ---", () => {
    // Plain --- is a horizontal rule, not a table separator
    // It has only one column (no pipe separator), so it should NOT match
    expect(isTableSeparator("---")).toBe(false);
  });
});

describe("GAP-2: isSyntaxOnlyLine", () => {
  it("detects horizontal rule ---", () => {
    expect(isSyntaxOnlyLine("---")).toBe(true);
  });

  it("detects horizontal rule ***", () => {
    expect(isSyntaxOnlyLine("***")).toBe(true);
  });

  it("detects horizontal rule ___", () => {
    expect(isSyntaxOnlyLine("___")).toBe(true);
  });

  it("detects empty line", () => {
    expect(isSyntaxOnlyLine("")).toBe(true);
    expect(isSyntaxOnlyLine("   ")).toBe(true);
  });

  it("detects pipe-only line ||||", () => {
    expect(isSyntaxOnlyLine("||||")).toBe(true);
  });

  it("detects dash-only line ----", () => {
    expect(isSyntaxOnlyLine("----")).toBe(true);
  });

  it("detects table separator |---|---|", () => {
    expect(isSyntaxOnlyLine("|---|---|")).toBe(true);
  });

  it("does NOT match Chinese text line", () => {
    expect(isSyntaxOnlyLine("上好的绿豆，买些吧！")).toBe(false);
  });

  it("does NOT match English text line", () => {
    expect(isSyntaxOnlyLine("Hello world")).toBe(false);
  });

  it("does NOT match numbered list with content", () => {
    expect(isSyntaxOnlyLine("1. First item")).toBe(false);
  });

  it("does NOT match markdown bold with text", () => {
    expect(isSyntaxOnlyLine("**Important notice**")).toBe(false);
  });

  it("rejects pure fullwidth punctuation ？？？", () => {
    expect(isSyntaxOnlyLine("？？？")).toBe(true);
  });

  it("rejects pure fullwidth punctuation ！！！", () => {
    expect(isSyntaxOnlyLine("！！！")).toBe(true);
  });

  it("rejects pure fullwidth colon ：：：", () => {
    expect(isSyntaxOnlyLine("：：：")).toBe(true);
  });

  it("rejects pure CJK ideographic full stop 。。。", () => {
    expect(isSyntaxOnlyLine("。。。")).toBe(true);
  });

  it("rejects mixed CJK/fullwidth punctuation ，。！？：；", () => {
    expect(isSyntaxOnlyLine("，。！？：；")).toBe(true);
  });

  it("rejects fullwidth brackets （）", () => {
    expect(isSyntaxOnlyLine("（）")).toBe(true);
  });

  it("rejects Chinese curly quotation marks only", () => {
    expect(isSyntaxOnlyLine("\u201C\u201D\u2018\u2019")).toBe(true);
  });

  it("does NOT match Chinese text with punctuation", () => {
    expect(isSyntaxOnlyLine("你好，世界！")).toBe(false);
  });
});

// ─── GAP-2: Fallback Normalize with Markdown Tables ────────────────────────────

describe("GAP-2: fallbackNormalize skips table separator rows", () => {
  it("does NOT produce voice lines from |---|---| separator, skips header, extracts column", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| Role | Line |\n|---|---|\n| NPC | 上好的绿豆，买些吧！ |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.runner).toBe("fallback");
    // Header row "| Role | Line |" is SKIPPED (not a voice line)
    // The separator row |---|---| is SKIPPED
    // Body row extracts the "Line" column -> "上好的绿豆，买些吧！"
    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("|---|---|");
    // Header must NOT be a voice line
    expect(allTexts).not.toContain("| Role | Line |");
    // Only the transcript column content should appear
    expect(allTexts).not.toContain("| NPC | 上好的绿豆，买些吧！ |");
    // Body row must extract "Line" column, not the whole row
    expect(allTexts).toContain("上好的绿豆，买些吧！");
    // Verify table block stats
    expect(result.parseStats!.tableBlocks).toBe(1);
    expect(result.parseStats!.tableRowsParsed).toBe(1);
    expect(result.parseStats!.tableSeparatorRowsSkipped).toBe(1);
    expect(result.parseStats!.voiceLinesCreated).toBe(1);
  });

  it("skips multiple table separator rows and headers, extracts columns", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: [
            "| Role | Line |",
            "|---|---|",
            "| NPC1 | 上好的绿豆 |",
            "",
            "| Character | Text |",
            "| :--- | ---: |",
            "| NPC2 | 新打捞的鱼 |",
          ].join("\n"),
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("|---|---|");
    expect(allTexts).not.toContain("| :--- | ---: |");
    // Headers must NOT be voice lines
    expect(allTexts).not.toContain("| Role | Line |");
    expect(allTexts).not.toContain("| Character | Text |");
    // Body rows extract transcript column, not whole row
    expect(allTexts).toContain("上好的绿豆");
    expect(allTexts).toContain("新打捞的鱼");
    // 2 table blocks, 2 body rows parsed
    expect(result.parseStats!.tableBlocks).toBe(2);
    expect(result.parseStats!.tableRowsParsed).toBe(2);
    expect(result.productionList.lines).toHaveLength(2);
  });

  it("skips horizontal rules ---, ***, ___", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "First line\n---\nSecond line\n***\nThird line\n___\nFourth line",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("---");
    expect(allTexts).not.toContain("***");
    expect(allTexts).not.toContain("___");
    expect(result.productionList.lines).toHaveLength(4);
    expect(result.productionList.lines[0].text).toBe("First line");
    expect(result.productionList.lines[1].text).toBe("Second line");
    expect(result.productionList.lines[2].text).toBe("Third line");
    expect(result.productionList.lines[3].text).toBe("Fourth line");
  });

  it("table body rows extract transcript column by header mapping", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| Role | Line |\n|---|---|\n| NPC1 | 千里草，何青青 |\n| NPC2 | 十日卜，不得生 |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    // Header row is SKIPPED (not a voice line)
    // Body rows extract transcript from "Line" column
    // Total: 2 voice lines (header skipped, separator skipped)
    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("|---|---|");
    expect(allTexts).not.toContain("| Role | Line |");
    // Transcript is extracted by column, not whole row
    expect(allTexts).not.toContain("| NPC1 | 千里草，何青青 |");
    expect(allTexts).not.toContain("| NPC2 | 十日卜，不得生 |");
    // Exact transcript column content
    expect(allTexts).toContain("千里草，何青青");
    expect(allTexts).toContain("十日卜，不得生");
    expect(result.productionList.lines).toHaveLength(2);
    // Speaker from "Role" column
    const speakers = result.productionList.speakers.map((s) => s.label);
    expect(speakers).toContain("NPC1");
    expect(speakers).toContain("NPC2");
  });

  it("skips pure pipe/symbol lines", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "|||\n----\n: :\nReal content here",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("|||");
    expect(allTexts).not.toContain("----");
    expect(allTexts).toContain("Real content here");
  });

  it("parseStats correctly tracks skipped rows (no table blocks)", () => {
    // Standalone separators (no header before them) are not table blocks
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "Line one\n|---|---|\n| :--- | ---: |\n---\n***\nLine two",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.parseStats).toBeDefined();
    expect(result.parseStats!.rawLines).toBe(6); // 6 non-empty lines in input
    expect(result.parseStats!.tableBlocks).toBe(0); // No valid table blocks
    expect(result.parseStats!.tableRowsParsed).toBe(0);
    expect(result.parseStats!.tableSeparatorRowsSkipped).toBe(2);
    expect(result.parseStats!.syntaxOnlyRowsSkipped).toBe(2); // --- and ***
    expect(result.parseStats!.voiceLinesCreated).toBe(2);
  });

  it("preserves original behavior for plain text documents", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.txt",
          content: "Line one\nLine two\n# Comment\nLine three",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.runner).toBe("fallback");
    expect(result.productionList.lines).toHaveLength(3);
    expect(result.productionList.lines[0].text).toBe("Line one");
    expect(result.productionList.lines[1].text).toBe("Line two");
    expect(result.productionList.lines[2].text).toBe("Line three");
  });

  it("preserves multi-speaker detection", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.txt",
          content: "Alice: Hello\nBob: Hi there\n|---|---|\nAlice: How are you?",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.productionList.speakers).toHaveLength(2);
    expect(result.productionList.lines).toHaveLength(3);
    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("|---|---|");
  });

  it("handles empty enabled documents gracefully", () => {
    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Content", enabled: false },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.runner).toBe("fallback");
    expect(result.productionList.lines).toHaveLength(0);
    expect(result.attemptedRunner).toBe("none");
    expect(result.parseStats?.voiceLinesCreated).toBe(0);
    expect(result.warnings.some((w) => w.code === "NO_ENABLED_DOCS")).toBe(true);
  });

  it("attemptedRunner is 'none' for fallback-only path", () => {
    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello", enabled: true },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.attemptedRunner).toBe("none");
  });
});

// ─── GAP-2: Real-world Markdown table scenario from test data ──────────────────

describe("GAP-2: Real-world Markdown table scenario", () => {
  it("correctly parses the RAGE NPC dialogue document format", () => {
    // Simulating the actual test document structure:
    // Markdown tables with | 角色 | 台词 | headers
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "rage-npc-dialogue.md",
          content: [
            "# RAGE NPC Dialogue",
            "",
            "## Scene 1: Market",
            "",
            "| 角色 | 台词 | 备注 |",
            "|------|------|------|",
            "| 小贩A | 上好的绿豆，买些吧！ | 热情 |",
            "| 小贩B | 卖鱼咯，新打捞的鱼！ | 大声 |",
            "",
            "## Scene 2: Battlefield",
            "",
            "| Character | Line | Notes |",
            "| :--- | ---: | :---: |",
            "| Soldier | 千里草，何青青！十日卜，不得生！ | Battle cry |",
            "| Blacksmith | 哇，好威风啊，我长大了... | Musing |",
            "",
            "---",
            "",
            "## Scene 3: Dialogue",
            "",
            "Scholar: 若非世家望族，何以至此？",
            "Friend: 兄实高见！",
          ].join("\n"),
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    // The table separator rows MUST NOT be voice lines
    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("|------|------|------|");
    expect(allTexts).not.toContain("| :--- | ---: | :---: |");

    // Table headers MUST NOT be voice lines
    expect(allTexts).not.toContain("| 角色 | 台词 | 备注 |");
    expect(allTexts).not.toContain("| Character | Line | Notes |");

    // Body rows must extract transcript column, not whole row
    expect(allTexts).not.toContain("| 小贩A | 上好的绿豆，买些吧！ | 热情 |");
    expect(allTexts).not.toContain("| Soldier | 千里草，何青青！十日卜，不得生！ | Battle cry |");

    // Extracted transcript column content
    expect(allTexts).toContain("上好的绿豆，买些吧！");
    expect(allTexts).toContain("卖鱼咯，新打捞的鱼！");
    expect(allTexts).toContain("千里草，何青青！十日卜，不得生！");
    expect(allTexts).toContain("哇，好威风啊，我长大了...");

    // Non-table dialogue lines
    expect(allTexts).toContain("若非世家望族，何以至此？");
    expect(allTexts).toContain("兄实高见！");

    // Verify parseStats
    expect(result.parseStats).toBeDefined();
    expect(result.parseStats!.tableBlocks).toBe(2);
    expect(result.parseStats!.tableRowsParsed).toBe(4); // 2 body rows per table
    expect(result.parseStats!.tableSeparatorRowsSkipped).toBeGreaterThanOrEqual(2);
    expect(result.parseStats!.voiceLinesCreated).toBe(6); // 4 table + 2 dialogue
  });
});

// ─── Metadata Safety: No secrets in response ────────────────────────────────────

describe("Metadata safety in normalize output", () => {
  afterEach(() => {
    _resetSpawnRunner();
  });

  it("normalize response metadata contains no API key patterns", async () => {
    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Test line", enabled: true },
      ],
    };

    const result = fallbackNormalize(input);

    const serialized = JSON.stringify(result);
    // Should not contain any key-like patterns
    expect(serialized).not.toMatch(/apiKey/i);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(serialized).not.toMatch(/Bearer\s+\S+/);
    expect(serialized).not.toMatch(/OPENROUTER_API_KEY/i);

    // parseStats should be present and contain only numeric counts
    expect(result.parseStats).toBeDefined();
    const statsSerialized = JSON.stringify(result.parseStats);
    expect(statsSerialized).not.toMatch(/apiKey/i);
  });

  it("runnerStatus from successful opencode run contains no secrets", async () => {
    const validOutput = {
      lines: [
        { id: crypto.randomUUID(), order: 0, speaker: "narrator", text: "Test", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr", style: "" },
      ],
    };

    _setSpawnRunner(async () => ({
      stdout: JSON.stringify({ content: JSON.stringify(validOutput) }),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Test", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("opencode");
    expect(result.attemptedRunner).toBe("opencode");
    expect(result.runnerStatus).toBeDefined();
    expect(result.runnerStatus!.status).toBe("succeeded");
    expect(result.runnerStatus!.reasonCode).toBe("opencode_success");
    expect(result.runnerStatus!.fallbackUsed).toBe(false);
    expect(typeof result.runnerStatus!.elapsedMs).toBe("number");
    expect(typeof result.runnerStatus!.timeoutMs).toBe("number");

    // No secrets in runnerStatus
    const serialized = JSON.stringify(result.runnerStatus);
    expect(serialized).not.toMatch(/apiKey/i);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it("sanitizeError removes api_key patterns", () => {
    const err = new Error("Failed with api_key=sk-secret-12345678");
    const sanitized = sanitizeError(err);
    expect(sanitized).not.toContain("sk-secret-12345678");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("sanitizeError removes token= patterns", () => {
    const err = new Error("Error: token=abc123def456");
    const sanitized = sanitizeError(err);
    expect(sanitized).not.toContain("abc123def456");
    expect(sanitized).toContain("[REDACTED]");
  });
});

// ─── M1: Table Block Detection and Column Mapping ──────────────────────────────

describe("M1: Table header is skipped (never becomes a voice line)", () => {
  it("Chinese header row | 角色 | 台词 | 备注 | is NOT a voice line", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| 角色 | 台词 | 备注 |\n|------|------|------|\n| 小贩 | 上好的绿豆 | 热情 |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("| 角色 | 台词 | 备注 |");
    // Body extracts "台词" column
    expect(allTexts).toContain("上好的绿豆");
    expect(allTexts).not.toContain("| 小贩 | 上好的绿豆 | 热情 |");
  });

  it("English header row | Role | Line | Notes | is NOT a voice line", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| Role | Line | Notes |\n|------|------|------|\n| NPC | Hello world | Test |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("| Role | Line | Notes |");
    expect(allTexts).toContain("Hello world");
  });

  it("tableBlocks count reflects number of detected table blocks", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: [
            "| Speaker | Text |",
            "|---|---|",
            "| A | First |",
            "",
            "Plain text line",
            "",
            "| Character | Line |",
            "|---|---|",
            "| B | Second |",
          ].join("\n"),
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.parseStats!.tableBlocks).toBe(2);
    expect(result.parseStats!.tableRowsParsed).toBe(2);
    // 1 header skipped per table = 2 headers
    expect(result.parseStats!.syntaxOnlyRowsSkipped).toBeGreaterThanOrEqual(2);
    // 2 table voice lines + 1 plain text line = 3
    expect(result.parseStats!.voiceLinesCreated).toBe(3);
  });
});

describe("M1: Table with no recognized transcript column", () => {
  it("skips table body and emits warning when no transcript column found", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| A | B |\n|---|---|\n| X | Y |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    // No voice lines from table body (no transcript column)
    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).not.toContain("| X | Y |");
    expect(allTexts).not.toContain("X");
    // Warning about missing transcript column
    expect(result.warnings.some((w) => w.code === "TABLE_NO_TRANSCRIPT_COLUMN")).toBe(true);
  });
});

describe("M1: Table column extraction with Chinese headers", () => {
  it("extracts transcript from 台词 column and speaker from 角色 column", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| 角色 | 台词 | 备注 |\n|------|------|------|\n| 老王 | 今天的天气真好 | 自言自语 |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).toContain("今天的天气真好");
    expect(allTexts).not.toContain("今天的天气真好 | 自言自语");
    // Speaker from 角色 column
    expect(result.productionList.speakers.some((s) => s.label === "老王")).toBe(true);
  });
});

describe("M1: <br> splitting in table cells", () => {
  it("splits <br> in transcript cell into separate voice lines", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| Speaker | Line |\n|---|---|\n| A | First line<br>Second line |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).toContain("First line");
    expect(allTexts).toContain("Second line");
    expect(allTexts).not.toContain("First line<br>Second line");
  });

  it("splits <br/> and <BR> variants", () => {
    const input = {
      documents: [
        {
          id: "doc-1",
          fileName: "test.md",
          content: "| Speaker | Line |\n|---|---|\n| A | Alpha<br/>Beta<BR>Gamma |",
          enabled: true,
        },
      ],
    };

    const result = fallbackNormalize(input);

    const allTexts = result.productionList.lines.map((l) => l.text);
    expect(allTexts).toContain("Alpha");
    expect(allTexts).toContain("Beta");
    expect(allTexts).toContain("Gamma");
  });
});

// ─── M2: Validator Syntax-Only Transcript Check ────────────────────────────────

describe("M2: validateProductionList rejects Markdown syntax-only transcript", () => {
  it("rejects table separator |---|---| as transcript", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "|---|---|", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects horizontal rule --- as transcript", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "---", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects pure pipe line ||||| as transcript", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "|||||", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects pure colon-dash line | :--- | ---: | as transcript", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "| :--- | ---: |", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("allows normal Chinese transcript", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "上好的绿豆，买些吧！", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(true);
    expect(report.issues.every((i) => i.severity !== "error")).toBe(true);
  });

  it("allows English transcript with punctuation", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "Hello, world! How are you?", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(true);
  });

  it("rejects pure fullwidth punctuation ？？？", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "？？？", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects pure fullwidth punctuation ！！！", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "！！！", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects pure fullwidth colon ：：：", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "：：：", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects pure CJK ideographic punctuation 。。。", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "。。。", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects pure CJK ideographic comma 、、、", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "、、、", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects mixed CJK/fullwidth punctuation ，。！？：；", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "，。！？：；", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects Chinese quotation marks only (curly double + single)", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "\u201C\u201D\u2018\u2019", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects fullwidth brackets （）", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "（）", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("allows normal Chinese text with surrounding punctuation", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "你好，世界！", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(true);
    expect(report.issues.every((i) => i.severity !== "error")).toBe(true);
  });

  it("allows Chinese text with heavy punctuation (not punctuation-only)", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "「千里草，何青青！」", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(true);
  });

  it("allows single Chinese character as transcript", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "是", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(true);
  });

  it("rejects ellipsis ……", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "……", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("rejects em dash ——", () => {
    const report = validateProductionList({
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "——", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "" }],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });
});

// ─── M3: Timeout 300s Hard Cap ─────────────────────────────────────────────────

describe("M3: OPENCODE_NORMALIZE_MAX_TIMEOUT_MS hard cap at 300s", () => {
  const originalTimeout = process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
  const originalMaxTimeout = process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout !== undefined) {
      process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.OPENCODE_NORMALIZE_TIMEOUT_MS;
    }
    if (originalMaxTimeout !== undefined) {
      process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = originalMaxTimeout;
    } else {
      delete process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS;
    }
  });

  it("clamps OPENCODE_NORMALIZE_MAX_TIMEOUT_MS=600000 to 300s", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "120000";
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "600000";
    // Even with 600000 env, maxTimeout is clamped to 300000
    // Large docs would compute > 300s but must be capped
    const timeout = computeNormalizeTimeout({ docCount: 50, charCount: 100_000 });
    expect(timeout).toBe(300_000);
  });

  it("timeout never exceeds 300s regardless of env", () => {
    process.env.OPENCODE_NORMALIZE_TIMEOUT_MS = "500000"; // Above 300s
    process.env.OPENCODE_NORMALIZE_MAX_TIMEOUT_MS = "999999"; // Way above
    // base clamped to 300000, maxTimeout clamped to 300000
    const timeout = computeNormalizeTimeout({ docCount: 100, charCount: 1_000_000 });
    expect(timeout).toBe(300_000);
  });
});
