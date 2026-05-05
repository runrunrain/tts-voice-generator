import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, taskApi } from "../services/httpAdapter";
import type { ProductionList, ProductionListValidationReport, VoiceLine } from "../types";

type Phase = "idle" | "loading" | "saving" | "validating" | "success" | "error" | "conflict";

const DEFAULT_MODEL = "google/gemini-3.1-flash-tts-preview";

export function createEmptyVoiceLine(sortOrder: number): VoiceLine {
  return {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    sortOrder,
    transcript: "",
    voice: "Zephyr",
    model: DEFAULT_MODEL,
    responseFormat: "wav",
    notes: "",
    directorProfileId: null,
  };
}

export function useProductionList(taskId: string | undefined) {
  const [list, setList] = useState<ProductionList | null>(null);
  const [draftLines, setDraftLines] = useState<VoiceLine[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [validationReport, setValidationReport] = useState<ProductionListValidationReport | null>(null);
  const [conflictError, setConflictError] = useState<ApiError | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    const requestId = ++requestRef.current;
    setPhase("loading");
    setError(null);
    setConflictError(null);
    try {
      const result = await taskApi.getProductionList(taskId);
      if (requestId !== requestRef.current) return;
      const normalized = { ...result, lines: result.lines ?? [] };
      setList(normalized);
      setDraftLines(normalized.lines);
      setPhase("success");
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "生产列表加载失败");
      setPhase("error");
    }
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateLine = useCallback((lineId: string, patch: Partial<VoiceLine>) => {
    setDraftLines((prev) => prev.map((line) => line.id === lineId ? { ...line, ...patch } : line));
  }, []);

  const addLine = useCallback(() => {
    setDraftLines((prev) => [...prev, createEmptyVoiceLine(prev.length + 1)]);
  }, []);

  const deleteLine = useCallback((lineId: string) => {
    setDraftLines((prev) => prev.filter((line) => line.id !== lineId).map((line, index) => ({ ...line, sortOrder: index + 1 })));
  }, []);

  const validateLocal = useCallback((): ProductionListValidationReport => {
    const issues: ProductionListValidationReport["issues"] = [];
    draftLines.forEach((line, index) => {
      if (!line.transcript.trim()) issues.push({ lineId: line.id, field: "transcript", severity: "error", message: `第 ${index + 1} 行缺少台词` });
      if (!line.voice.trim()) issues.push({ lineId: line.id, field: "voice", severity: "error", message: `第 ${index + 1} 行缺少音色` });
      if (!line.model.trim()) issues.push({ lineId: line.id, field: "model", severity: "warning", message: `第 ${index + 1} 行未指定模型，将使用服务端默认值` });
    });
    return { ok: !issues.some((item) => item.severity === "error"), issues };
  }, [draftLines]);

  const validateRemote = useCallback(async () => {
    if (!taskId) return validateLocal();
    setPhase("validating");
    setError(null);
    try {
      const report = await taskApi.validateProductionList(taskId, { lines: draftLines });
      setValidationReport(report);
      setPhase("success");
      return report;
    } catch (err) {
      const localReport = validateLocal();
      setValidationReport(localReport);
      setError(err instanceof Error ? `远端校验不可用，已执行本地校验：${err.message}` : "远端校验不可用，已执行本地校验");
      setPhase("error");
      return localReport;
    }
  }, [draftLines, taskId, validateLocal]);

  const save = useCallback(async () => {
    if (!taskId || !list) return null;
    const localReport = validateLocal();
    setValidationReport(localReport);
    if (!localReport.ok) {
      setError("生产列表存在必填项错误，请修复后保存");
      setPhase("error");
      return null;
    }
    setPhase("saving");
    setError(null);
    setSaveMessage(null);
    setConflictError(null);
    try {
      const saved = await taskApi.saveProductionList(taskId, list.version, {
        lines: draftLines,
        speakers: list.speakers ?? [],
        directorProfileId: list.directorProfileId ?? null,
        metadata: list.metadata ?? {},
      });
      const normalized = { ...saved, lines: saved.lines ?? [] };
      setList(normalized);
      setDraftLines(normalized.lines);
      setSaveMessage("生产列表已保存");
      setPhase("success");
      return normalized;
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        setConflictError(err);
        setPhase("conflict");
        return null;
      }
      setError(err instanceof Error ? err.message : "保存生产列表失败");
      setPhase("error");
      return null;
    }
  }, [draftLines, list, taskId, validateLocal]);

  const discardLocal = useCallback(() => {
    if (!list) return;
    setDraftLines(list.lines);
    setConflictError(null);
    setPhase("success");
  }, [list]);

  return {
    list,
    draftLines,
    phase,
    loading: phase === "loading",
    saving: phase === "saving",
    validating: phase === "validating",
    error,
    saveMessage,
    validationReport,
    conflictError,
    setDraftLines,
    updateLine,
    addLine,
    deleteLine,
    validateLocal,
    validateRemote,
    save,
    refresh,
    discardLocal,
    clearSaveMessage: () => setSaveMessage(null),
    clearConflict: () => setConflictError(null),
  };
}
