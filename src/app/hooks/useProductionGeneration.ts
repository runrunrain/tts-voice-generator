import { useCallback, useState } from "react";
import { ApiError, taskApi } from "../services/httpAdapter";
import type { GenerateFromListResponse, LineGenerationStatus, ProductionList, VoiceLine } from "../types";

type GenerationTone = "idle" | "loading" | "success" | "warning" | "error";
type GenerationScope = "selection" | "eligible";

const ACTIVE_STATUSES: LineGenerationStatus[] = ["pending", "running"];

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "sk-[REDACTED]");
}

function formatInvalidApiKeyMessage(providerMessage?: string | null): string {
  const safeProviderMessage = providerMessage ? sanitizeProviderMessage(providerMessage) : null;
  const providerText = safeProviderMessage ? `Provider 返回：${safeProviderMessage}` : "Provider 未返回更多错误信息。";
  return `OpenRouter API Key 无效、已过期或账户不可用。请到 Settings 更新 API Key，并检查 OpenRouter 账户状态/余额。${providerText}`;
}

export function getLineGenerationStatus(line: VoiceLine): LineGenerationStatus {
  return line.generationStatus ?? "draft";
}

export function isPersistedVoiceLine(line: VoiceLine): boolean {
  return line.isLocalDraft !== true;
}

export function isGeneratableVoiceLine(line: VoiceLine): boolean {
  const status = getLineGenerationStatus(line);
  return isPersistedVoiceLine(line) && line.transcript.trim().length > 0 && !ACTIVE_STATUSES.includes(status);
}

export function buildGenerationMessage(result: GenerateFromListResponse): string {
  const invalidApiKeyFailure = result.results.find((line) => line.status === "failed" && line.errorCode === "INVALID_API_KEY");
  if (invalidApiKeyFailure) {
    const prefix = result.succeededCount > 0
      ? `音频生成部分完成：成功 ${result.succeededCount} 条，失败 ${result.failedCount} 条。`
      : `音频生成失败：${result.failedCount} 条未完成。`;
    return `${prefix}${formatInvalidApiKeyMessage(invalidApiKeyFailure.errorMessage)}`;
  }

  if (result.failedCount > 0 && result.succeededCount > 0) {
    return `音频生成部分完成：成功 ${result.succeededCount} 条，失败 ${result.failedCount} 条，跳过 ${result.skippedCount} 条`;
  }
  if (result.failedCount > 0) {
    return `音频生成失败：${result.failedCount} 条未完成，跳过 ${result.skippedCount} 条`;
  }
  return `音频生成完成：成功 ${result.succeededCount} 条，跳过 ${result.skippedCount} 条`;
}

function classifyGenerationTone(result: GenerateFromListResponse): GenerationTone {
  if (result.failedCount > 0 && result.succeededCount > 0) return "warning";
  if (result.failedCount > 0) return "error";
  return "success";
}

function readApiErrorDetails(err: ApiError) {
  if (!err.body || typeof err.body !== "object") return { code: null as string | null, message: err.message };
  const body = err.body as Record<string, unknown>;
  const nestedError = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : null;
  const code = typeof nestedError?.code === "string"
    ? nestedError.code
    : typeof body.code === "string"
      ? body.code
      : null;
  const message = typeof nestedError?.message === "string"
    ? nestedError.message
    : typeof body.message === "string"
      ? body.message
      : err.message;
  return { code, message };
}

export function formatGenerationApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const { code, message } = readApiErrorDetails(err);
    switch (code) {
      case "MISSING_API_KEY":
        return "音频生成失败：OpenRouter API Key 未配置，请到 Settings 配置。";
      case "INVALID_API_KEY": {
        return `音频生成失败：${formatInvalidApiKeyMessage(message)}`;
      }
      case "GENERATION_FAILED":
        return `音频生成失败：${message || "TTS provider 返回失败"}`;
      case "LINES_NOT_FOUND":
        return "选中行不在当前生产列表版本中，请刷新生产列表后重试。";
      case "VERSION_CONFLICT":
        return "生产列表版本已变化，请刷新后重试。";
      case "TASK_NOT_FOUND":
        return "任务不存在，无法生成音频。";
      case "VALIDATION_ERROR":
        return `音频生成请求参数无效：${message}`;
      case "NO_PRODUCTION_LIST":
        return "请先生成或保存生产列表，再生成音频。";
      case "EMPTY_PRODUCTION_LIST":
        return "当前生产列表没有可生成行。";
      case "COST_CONFIRMATION_REQUIRED":
        return "音频生成被成本保护拦截：请求缺少显式确认。";
      case "INTERNAL_ERROR":
        return `音频生成内部异常：${message}`;
      case "PRODUCTION_LIST_QUALITY_GATE_FAILED":
        return "音频生成链路异常：收到了生产列表草稿质量门错误（PRODUCTION_LIST_QUALITY_GATE_FAILED）。请确认是否点击了右侧“重新生成生产列表草稿”；若确认点击的是左侧“生成选中音频”，请保留请求记录排查路由串接。";
      default:
        return code ? `音频生成请求失败（${code}）：${message}` : `音频生成请求失败：${message}`;
    }
  }
  if (err instanceof Error) return `音频生成请求失败：${err.message}`;
  return "音频生成请求失败";
}

export function useProductionGeneration(taskId: string | undefined) {
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateFromListResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<GenerationTone>("idle");

  const generateLines = useCallback(async (list: ProductionList | null, scope: GenerationScope, selectedLineIds: string[] = []) => {
    if (!taskId || !list) {
      setTone("error");
      setMessage("生产列表尚未加载，无法提交生成");
      return null;
    }

    const sourceLines = scope === "selection" ? list.lines.filter((line) => selectedLineIds.includes(line.id)) : list.lines;
    if (scope === "selection" && selectedLineIds.length === 0) {
      setTone("warning");
      setMessage("请先选择至少一条可生成的生产行");
      return null;
    }

    if (sourceLines.some((line) => !isPersistedVoiceLine(line))) {
      setTone("warning");
      setMessage("选中行包含未保存的新行，请先保存生产列表后再生成");
      return null;
    }

    const lineIds = sourceLines.filter(isGeneratableVoiceLine).map((line) => line.id);
    if (lineIds.length === 0) {
      setTone("warning");
      setMessage(scope === "selection" ? "选中行没有可生成内容：请确认台词非空且未处于生成中" : "当前列表没有待生成或可重新生成的行");
      return null;
    }
    const forceRegenerate = scope === "selection" && sourceLines.some((line) => getLineGenerationStatus(line) === "succeeded");

    setGenerating(true);
    setTone("loading");
    setMessage(`正在提交 ${lineIds.length} 条生产行进入生成链路${forceRegenerate ? "（包含成功行重新生成）" : ""}`);
    try {
      const generation = await taskApi.generateLines(taskId, {
        expectedVersion: list.version,
        lineIds,
        skipCompleted: true,
        forceRegenerate,
        source: "user",
        confirm: true,
      });
      setResult(generation);
      setTone(classifyGenerationTone(generation));
      setMessage(buildGenerationMessage(generation));
      return generation;
    } catch (err) {
      setTone("error");
      setMessage(formatGenerationApiError(err));
      return null;
    } finally {
      setGenerating(false);
    }
  }, [taskId]);

  return { generating, result, message, tone, generateLines, clearGenerationMessage: () => setMessage(null) };
}
