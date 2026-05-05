import { useCallback, useState } from "react";
import { ApiError, taskApi } from "../services/httpAdapter";
import type { GenerateFromListResponse, LineGenerationStatus, ProductionList, VoiceLine } from "../types";

type GenerationTone = "idle" | "loading" | "success" | "warning" | "error";
type GenerationScope = "selection" | "eligible";

const ACTIVE_STATUSES: LineGenerationStatus[] = ["pending", "running"];

export function getLineGenerationStatus(line: VoiceLine): LineGenerationStatus {
  return line.generationStatus ?? "draft";
}

export function isPersistedVoiceLine(line: VoiceLine): boolean {
  return !line.id.startsWith("local-");
}

export function isGeneratableVoiceLine(line: VoiceLine): boolean {
  const status = getLineGenerationStatus(line);
  return isPersistedVoiceLine(line) && line.transcript.trim().length > 0 && status !== "succeeded" && !ACTIVE_STATUSES.includes(status);
}

function buildGenerationMessage(result: GenerateFromListResponse): string {
  if (result.failedCount > 0 && result.succeededCount > 0) {
    return `生成部分完成：成功 ${result.succeededCount} 条，失败 ${result.failedCount} 条，跳过 ${result.skippedCount} 条`;
  }
  if (result.failedCount > 0) {
    return `生成失败：${result.failedCount} 条未完成，跳过 ${result.skippedCount} 条`;
  }
  return `生成完成：成功 ${result.succeededCount} 条，跳过 ${result.skippedCount} 条`;
}

function classifyGenerationTone(result: GenerateFromListResponse): GenerationTone {
  if (result.failedCount > 0 && result.succeededCount > 0) return "warning";
  if (result.failedCount > 0) return "error";
  return "success";
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
      setMessage(scope === "selection" ? "选中行没有可生成内容：请确认台词非空且未处于生成中或已成功状态" : "当前列表没有待生成行");
      return null;
    }

    setGenerating(true);
    setTone("loading");
    setMessage(`正在提交 ${lineIds.length} 条生产行进入生成链路`);
    try {
      const generation = await taskApi.generateLines(taskId, {
        expectedVersion: list.version,
        lineIds,
        skipCompleted: true,
      });
      setResult(generation);
      setTone(classifyGenerationTone(generation));
      setMessage(buildGenerationMessage(generation));
      return generation;
    } catch (err) {
      setTone("error");
      setMessage(err instanceof ApiError || err instanceof Error ? err.message : "生产列表生成请求失败");
      return null;
    } finally {
      setGenerating(false);
    }
  }, [taskId]);

  return { generating, result, message, tone, generateLines, clearGenerationMessage: () => setMessage(null) };
}
