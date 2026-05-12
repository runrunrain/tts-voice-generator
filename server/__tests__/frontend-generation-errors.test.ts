import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/app/services/httpAdapter";
import { buildGenerationMessage, formatGenerationApiError } from "../../src/app/hooks/useProductionGeneration";

describe("frontend generation error messages", () => {
  it("shows actionable guidance for INVALID_API_KEY with sanitized provider message", () => {
    const message = formatGenerationApiError(new ApiError(502, "Provider failed", {
      error: {
        code: "INVALID_API_KEY",
        message: "User not found.",
      },
    }));

    expect(message).toContain("OpenRouter API Key 无效");
    expect(message).toContain("Settings");
    expect(message).toContain("更新 API Key");
    expect(message).toContain("账户状态/余额");
    expect(message).toContain("Provider 返回：User not found.");
    expect(message).not.toContain("sk-");
  });

  it("keeps MISSING_API_KEY guidance unchanged", () => {
    const message = formatGenerationApiError(new ApiError(502, "Missing key", {
      error: {
        code: "MISSING_API_KEY",
        message: "Missing key",
      },
    }));

    expect(message).toBe("音频生成失败：OpenRouter API Key 未配置，请到 Settings 配置。");
  });

  it("shows actionable guidance when per-line generation result fails with INVALID_API_KEY", () => {
    const message = buildGenerationMessage({
      taskId: "task-1",
      version: 2,
      requestedCount: 1,
      succeededCount: 0,
      failedCount: 1,
      skippedCount: 0,
      results: [{
        lineId: "line-1",
        status: "failed",
        errorCode: "INVALID_API_KEY",
        errorMessage: "Bearer sk-secret123456789 User not found.",
      }],
    });

    expect(message).toContain("音频生成失败：1 条未完成");
    expect(message).toContain("OpenRouter API Key 无效");
    expect(message).toContain("Settings");
    expect(message).toContain("账户状态/余额");
    expect(message).toContain("Provider 返回");
    expect(message).not.toContain("sk-secret");
    expect(message).toContain("Bearer [REDACTED]");
  });
});
