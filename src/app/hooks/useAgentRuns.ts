import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, taskApi } from "../services/httpAdapter";
import type { AgentButton, AgentRunCancelResult, AgentRunDetail, AgentRunDiff, AgentRunSummary, OpencodeSession, NormalizeRunProgress, NormalizeStartResponse, NormalizeTimeoutBasis } from "../types";

type Phase = "idle" | "loading" | "running" | "success" | "error";

const NORMALIZE_POLL_INTERVAL_MS = 2_000;
const DEFAULT_NORMALIZE_LOCAL_TIMEOUT_MS = 15 * 60_000;
const NORMALIZE_PENDING_STORAGE_PREFIX = "tts-voice-generator:normalize-pending:";

type PendingNormalizeRun = {
  taskId: string;
  runId: string;
  startedAt: string;
  timeoutMs: number;
  progressUrl: string;
};

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function pendingStorageKey(taskId: string) {
  return `${NORMALIZE_PENDING_STORAGE_PREFIX}${encodeURIComponent(taskId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function readPendingNormalizeRun(taskId: string): PendingNormalizeRun | null {
  const storage = getBrowserStorage();
  if (!storage) return null;
  const key = pendingStorageKey(taskId);
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid pending normalize payload");
    const pending: PendingNormalizeRun = {
      taskId: typeof parsed.taskId === "string" ? parsed.taskId : "",
      runId: typeof parsed.runId === "string" ? parsed.runId : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      timeoutMs: typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs) ? parsed.timeoutMs : 0,
      progressUrl: typeof parsed.progressUrl === "string" ? parsed.progressUrl : "",
    };
    if (pending.taskId !== taskId || !pending.runId || !parseIsoMs(pending.startedAt)) {
      throw new Error("stale pending normalize payload");
    }
    return pending;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function writePendingNormalizeRun(pending: PendingNormalizeRun) {
  const storage = getBrowserStorage();
  if (!storage) return;
  try {
    storage.setItem(pendingStorageKey(pending.taskId), JSON.stringify(pending));
  } catch {
    // localStorage can be unavailable in private mode or quota pressure; progress still works in memory.
  }
}

function clearPendingNormalizeRun(taskId: string, runId?: string) {
  const storage = getBrowserStorage();
  if (!storage) return;
  const key = pendingStorageKey(taskId);
  if (!runId) {
    storage.removeItem(key);
    return;
  }
  const pending = readPendingNormalizeRun(taskId);
  if (!pending || pending.runId === runId) storage.removeItem(key);
}

function pendingFromProgress(progress: NormalizeRunProgress, progressUrl = ""): PendingNormalizeRun {
  return {
    taskId: progress.taskId,
    runId: progress.runId,
    startedAt: progress.startedAt,
    timeoutMs: resolveNormalizeTimeoutMs(progress.timeoutMs, progress.timeoutBasis),
    progressUrl,
  };
}

function pendingFromAccepted(taskId: string, accepted: NormalizeStartResponse, startedAt: string): PendingNormalizeRun {
  return {
    taskId,
    runId: accepted.runId,
    startedAt,
    timeoutMs: resolveNormalizeTimeoutMs(accepted.timeoutMs, accepted.timeoutBasis),
    progressUrl: accepted.progressUrl,
  };
}

function extractNormalizeConflictRun(err: unknown): Pick<PendingNormalizeRun, "runId" | "progressUrl"> | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !isRecord(err.body)) return null;
  const body = err.body;
  const error = isRecord(body.error) ? body.error : null;
  const metadata = error && isRecord(error.metadata) ? error.metadata : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const runId = typeof body.existingRunId === "string" ? body.existingRunId : typeof metadata?.existingRunId === "string" ? metadata.existingRunId : "";
  const progressUrl = typeof body.progressUrl === "string" ? body.progressUrl : typeof metadata?.progressUrl === "string" ? metadata.progressUrl : "";
  if (code !== "NORMALIZE_RUN_ALREADY_RUNNING" || !runId) return null;
  return { runId, progressUrl };
}

function asPositiveMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveNormalizeTimeoutMs(timeoutMs: unknown, timeoutBasis?: NormalizeTimeoutBasis): number {
  return (
    asPositiveMs(timeoutMs) ??
    asPositiveMs(timeoutBasis?.timeoutMs) ??
    asPositiveMs(timeoutBasis?.selectedTimeoutMs) ??
    asPositiveMs(timeoutBasis?.maxTimeoutMs) ??
    DEFAULT_NORMALIZE_LOCAL_TIMEOUT_MS
  );
}

function isNormalizeTerminalStage(progress: NormalizeRunProgress) {
  return progress.stage === "completed" || progress.stage === "failed";
}

export function useAgentRuns(taskId: string | undefined) {
  const [buttons, setButtons] = useState<AgentButton[]>([]);
  const [sessions, setSessions] = useState<OpencodeSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [runDetails, setRunDetails] = useState<Record<string, AgentRunDetail>>({});
  const [runDiffs, setRunDiffs] = useState<Record<string, AgentRunDiff>>({});
  const [cancelWarning, setCancelWarning] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<OpencodeSession | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [opencodeAvailable, setOpencodeAvailable] = useState(false);
  const [runnerMode, setRunnerMode] = useState<"opencode" | "fallback">("fallback");
  const [normalizeRunId, setNormalizeRunId] = useState<string | null>(null);
  const [normalizeProgress, setNormalizeProgress] = useState<NormalizeRunProgress | null>(null);
  const [normalizeProgressError, setNormalizeProgressError] = useState<string | null>(null);
  const runTokenRef = useRef(0);
  const pollDelayRef = useRef<{ id: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);
  const normalizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPollDelay = useCallback(() => {
    if (pollDelayRef.current) {
      clearTimeout(pollDelayRef.current.id);
      pollDelayRef.current.resolve();
      pollDelayRef.current = null;
    }
  }, []);

  const clearNormalizeTimeout = useCallback(() => {
    if (normalizeTimeoutRef.current) {
      clearTimeout(normalizeTimeoutRef.current);
      normalizeTimeoutRef.current = null;
    }
  }, []);

  const cancelNormalizePolling = useCallback(() => {
    runTokenRef.current += 1;
    clearPollDelay();
    clearNormalizeTimeout();
  }, [clearNormalizeTimeout, clearPollDelay]);

  const waitForNextPoll = useCallback((ms: number) => new Promise<void>((resolve) => {
    const id = setTimeout(() => {
      if (pollDelayRef.current?.id === id) pollDelayRef.current = null;
      resolve();
    }, ms);
    pollDelayRef.current = { id, resolve };
  }), []);

  const armLocalNormalizeTimeout = useCallback((_progress: NormalizeRunProgress, _startedAtMs: number, _token: number) => {
    clearNormalizeTimeout();
  }, [clearNormalizeTimeout]);

  const refreshButtons = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const result = await taskApi.listAgentButtons();
      setButtons(result.buttons ?? []);
      setOpencodeAvailable(result.opencodeAvailable);
      setRunnerMode(result.runnerMode);
      setPhase((current) => current === "running" ? current : "success");
    } catch (err) {
      setButtons([]);
      setError(err instanceof Error ? err.message : "OpenCode 按钮加载失败");
      setPhase("error");
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!taskId) return;
    try {
      const result = await taskApi.listOpencodeSessions(taskId);
      const automationSessions = (result.sessions ?? []).filter((session) => session.kind !== "chat");
      setSessions(automationSessions);
      setSelectedSessionId((prev) => prev ?? automationSessions[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "OpenCode 会话加载失败");
    }
  }, [taskId]);

  const refreshRuns = useCallback(async () => {
    if (!taskId) return;
    try {
      const result = await taskApi.listAgentRuns(taskId, 30);
      setRuns(result.runs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent 运行历史加载失败");
    }
  }, [taskId]);

  useEffect(() => {
    refreshButtons();
  }, [refreshButtons]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => () => {
    cancelNormalizePolling();
  }, [cancelNormalizePolling]);

  const makeAcceptedProgress = useCallback((accepted: NormalizeStartResponse): NormalizeRunProgress => {
    const now = new Date().toISOString();
    return {
      ok: true,
      requestId: accepted.requestId,
      runId: accepted.runId,
      taskId: taskId ?? "",
      stage: accepted.stage,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      timeoutMs: accepted.timeoutMs,
      timeoutBasis: accepted.timeoutBasis ?? {},
      candidateLineCount: 0,
      draft: { exists: false, parseable: false, sizeBytes: 0 },
      quality: { checked: false },
      runner: { status: "not_started" },
      message: "已创建 Normalize 任务，正在等待后端进度。",
    };
  }, [taskId]);

  const formatProgressFailure = useCallback((progress: NormalizeRunProgress) => {
    const errorCode = progress.error?.code ?? "NORMALIZE_FAILED";
    const httpStatus = progress.error?.httpStatus;
    const quality = progress.quality;
    if (httpStatus === 422 || errorCode.includes("QUALITY")) {
      const issueCount = quality.blockingIssueCount ?? quality.issueCount ?? 0;
      return `质量闸门拒绝提交：${issueCount} 个阻断问题。${progress.error?.message ?? progress.message}`;
    }
    if (httpStatus === 504 || errorCode.includes("TIMEOUT")) {
      return `OpenCode 上游处理超时：${progress.error?.message ?? progress.message}`;
    }
    if (httpStatus === 503 || errorCode.includes("UNAVAILABLE")) {
      return `OpenCode 上游不可用：${progress.error?.message ?? progress.message}`;
    }
    return progress.error?.message ?? progress.message ?? "需求标准化执行失败";
  }, []);

  const completeNormalizeProgress = useCallback(async (progress: NormalizeRunProgress) => {
    clearPendingNormalizeRun(progress.taskId, progress.runId);
    clearNormalizeTimeout();
    setNormalizeProgress(progress);
    setNormalizeProgressError(null);

    if (progress.stage === "completed") {
      setLastRun(null);
      setLastMessage(
        `Normalize 完成：生成 ${progress.result?.lineCount ?? 0} 行` +
        (progress.result?.versionId ? ` | versionId=${progress.result.versionId.slice(0, 8)}...` : "") +
        ` | runId=${progress.runId.slice(0, 8)}...`,
      );
      await refreshSessions();
      await refreshRuns();
      setPhase("success");
      return progress;
    }

    const message = formatProgressFailure(progress);
    setError(message);
    setLastMessage(null);
    await refreshSessions();
    await refreshRuns();
    setPhase("error");
    return null;
  }, [clearNormalizeTimeout, formatProgressFailure, refreshRuns, refreshSessions]);

  const pollNormalizeProgress = useCallback(async (initialProgress: NormalizeRunProgress, progressUrl: string, token: number) => {
    const startedAtMs = parseIsoMs(initialProgress.startedAt) ?? Math.max(0, Date.now() - initialProgress.elapsedMs);

    if (isNormalizeTerminalStage(initialProgress)) {
      return completeNormalizeProgress(initialProgress);
    }

    writePendingNormalizeRun(pendingFromProgress(initialProgress, progressUrl));
    armLocalNormalizeTimeout(initialProgress, startedAtMs, token);

    let consecutiveProgressFailures = 0;
    while (runTokenRef.current === token) {
      await waitForNextPoll(NORMALIZE_POLL_INTERVAL_MS);
      if (runTokenRef.current !== token) return null;

      try {
        const progress = await taskApi.getNormalizeProgress(initialProgress.taskId, initialProgress.runId);
        if (runTokenRef.current !== token) return null;
        consecutiveProgressFailures = 0;
        setNormalizeProgressError(null);
        setNormalizeProgress(progress);

        if (isNormalizeTerminalStage(progress)) {
          return completeNormalizeProgress(progress);
        }

        writePendingNormalizeRun(pendingFromProgress(progress, progressUrl));
        armLocalNormalizeTimeout(progress, startedAtMs, token);
      } catch (pollErr) {
        const message = pollErr instanceof Error ? pollErr.message : "进度读取失败";
        if (pollErr instanceof ApiError && pollErr.status === 404) {
          clearPendingNormalizeRun(initialProgress.taskId, initialProgress.runId);
          setNormalizeProgressError(null);
          setError(`Normalize 进度记录不存在或已过期：${message}`);
          setLastMessage(null);
          await refreshSessions();
          await refreshRuns();
          setPhase("error");
          return null;
        }

        consecutiveProgressFailures += 1;
        if (consecutiveProgressFailures <= 2) {
          setNormalizeProgressError("进度读取暂时失败，Normalize 任务可能仍在运行。正在继续重试。");
          continue;
        }
        setNormalizeProgressError(message);
        setError(`进度读取连续失败：${message}`);
        await refreshSessions();
        await refreshRuns();
        setPhase("error");
        return null;
      }
    }
    return null;
  }, [armLocalNormalizeTimeout, completeNormalizeProgress, refreshRuns, refreshSessions, waitForNextPoll]);

  const resumeNormalizeRun = useCallback(async (pending: PendingNormalizeRun, token: number) => {
    setPhase("running");
    setError(null);
    setLastMessage(null);
    setNormalizeRunId(pending.runId);
    setNormalizeProgressError(null);
    try {
      const progress = await taskApi.getNormalizeProgress(pending.taskId, pending.runId);
      if (runTokenRef.current !== token) return null;
      const normalizedProgressUrl = pending.progressUrl || `/api/tasks/${encodeURIComponent(pending.taskId)}/agent/normalize-runs/${encodeURIComponent(pending.runId)}/progress`;
      setNormalizeRunId(progress.runId);
      setNormalizeProgress(progress);
      if (isNormalizeTerminalStage(progress)) {
        return completeNormalizeProgress(progress);
      }
      writePendingNormalizeRun(pendingFromProgress(progress, normalizedProgressUrl));
      return pollNormalizeProgress(progress, normalizedProgressUrl, token);
    } catch (err) {
      if (runTokenRef.current !== token) return null;
      const message = err instanceof Error ? err.message : "进度读取失败";
      if (err instanceof ApiError && err.status === 404) {
        clearPendingNormalizeRun(pending.taskId, pending.runId);
        setError(`Normalize 进度记录不存在或已过期：${message}`);
      } else {
        setError(`Normalize 进度恢复失败：${message}`);
      }
      setNormalizeProgressError(null);
      setLastMessage(null);
      await refreshSessions();
      await refreshRuns();
      setPhase("error");
      return null;
    }
  }, [completeNormalizeProgress, pollNormalizeProgress, refreshRuns, refreshSessions]);

  useEffect(() => {
    cancelNormalizePolling();
    setNormalizeRunId(null);
    setNormalizeProgress(null);
    setNormalizeProgressError(null);

    if (!taskId) return;
    const pending = readPendingNormalizeRun(taskId);
    if (!pending) return;

    const token = runTokenRef.current;
    void resumeNormalizeRun(pending, token);
  }, [cancelNormalizePolling, resumeNormalizeRun, taskId]);

  const normalizeRequirements = useCallback(async () => {
    if (!taskId) return null;
    cancelNormalizePolling();
    const token = runTokenRef.current;
    setPhase("running");
    setError(null);
    setLastMessage(null);
    setNormalizeRunId(null);
    setNormalizeProgress(null);
    setNormalizeProgressError(null);
    try {
      const accepted = await taskApi.startNormalizeRequirements(taskId);
      if (runTokenRef.current !== token) return null;
      const acceptedProgress = makeAcceptedProgress(accepted);
      writePendingNormalizeRun(pendingFromAccepted(taskId, accepted, acceptedProgress.startedAt));
      setNormalizeRunId(accepted.runId);
      setNormalizeProgress(acceptedProgress);
      setLastMessage(`Normalize 任务已启动：runId=${accepted.runId.slice(0, 8)}...`);
      return pollNormalizeProgress(acceptedProgress, accepted.progressUrl, token);
    } catch (err) {
      if (runTokenRef.current !== token) return null;
      const conflictRun = extractNormalizeConflictRun(err);
      if (conflictRun) {
        const pending: PendingNormalizeRun = {
          taskId,
          runId: conflictRun.runId,
          startedAt: new Date().toISOString(),
          timeoutMs: DEFAULT_NORMALIZE_LOCAL_TIMEOUT_MS,
          progressUrl: conflictRun.progressUrl,
        };
        writePendingNormalizeRun(pending);
        setLastMessage(`检测到正在执行的 Normalize 任务，已恢复进度：runId=${conflictRun.runId.slice(0, 8)}...`);
        return resumeNormalizeRun(pending, token);
      }
      const apiErrorBody = err instanceof ApiError && err.body && typeof err.body === "object"
        ? err.body as Record<string, unknown>
        : null;
      const structuredError = apiErrorBody && typeof apiErrorBody.error === "object" && apiErrorBody.error !== null
        ? apiErrorBody.error as Record<string, unknown>
        : null;
      const message = typeof structuredError?.message === "string"
        ? structuredError.message
        : err instanceof Error ? err.message : "需求标准化执行失败";
      const code = typeof structuredError?.code === "string" ? structuredError.code : null;
      if (code === "OPENCODE_UNAVAILABLE" || (err instanceof ApiError && err.status === 503)) {
        setError(`OpenCode 上游不可用：${message}`);
      } else if (err instanceof ApiError && err.status === 409) {
        setError(`Normalize 任务冲突：${message}`);
      } else {
        setError(message);
      }
      setPhase("error");
      return null;
    } finally {
      if (runTokenRef.current === token) {
        clearPollDelay();
        clearNormalizeTimeout();
      }
    }
  }, [cancelNormalizePolling, clearNormalizeTimeout, clearPollDelay, makeAcceptedProgress, pollNormalizeProgress, resumeNormalizeRun, taskId]);

  const executeButton = useCallback(async (buttonKey: string, lineIdOrTarget?: string | { scope: "line"; lineId: string } | { scope: "selection"; lineIds: string[] } | { scope: "list" } | { scope: "task" }, expectedVersion?: number) => {
    if (!taskId) return null;
    setPhase("running");
    setError(null);
    setLastMessage(null);
    try {
      const target = typeof lineIdOrTarget === "string" ? { scope: "line" as const, lineId: lineIdOrTarget } : lineIdOrTarget;
      const run = await taskApi.executeAgentButton(taskId, buttonKey, { target, expectedVersion, automationSessionId: selectedSessionId ?? undefined });
      setLastRun({
        id: run.runId,
        taskId,
        kind: "automation",
        status: run.status,
        buttonKey: run.buttonKey,
        lineId: run.targetLineIds[0] ?? null,
        title: run.title,
        createdAt: run.createdAt,
        updatedAt: run.completedAt ?? run.createdAt,
        error: run.error?.message ?? null,
      });
      setLastMessage(`按钮已执行：${buttonKey}`);
      setRuns((prev) => [run, ...prev.filter((item) => item.runId !== run.runId)]);
      await refreshRuns();
      setPhase("success");
      return run;
    } catch (err) {
      setError(err instanceof Error ? err.message : "OpenCode 执行失败");
      setPhase("error");
      return null;
    }
  }, [refreshRuns, selectedSessionId, taskId]);

  const createAutomationSession = useCallback(async () => {
    if (!taskId) return null;
    setError(null);
    try {
      const session = await taskApi.createOpencodeSession({ taskId, kind: "automation", title: `Automation ${new Date().toLocaleTimeString("zh-CN")}` });
      setSessions((prev) => [session, ...prev.filter((item) => item.id !== session.id)]);
      setSelectedSessionId(session.id);
      return session;
    } catch (err) {
      setError(err instanceof Error ? err.message : "自动化会话创建失败");
      return null;
    }
  }, [taskId]);

  const loadRunDetail = useCallback(async (runId: string) => {
    if (!taskId) return null;
    if (runDetails[runId]) return runDetails[runId];
    const detail = await taskApi.getAgentRunDetail(taskId, runId);
    setRunDetails((prev) => ({ ...prev, [runId]: detail }));
    return detail;
  }, [runDetails, taskId]);

  const loadRunDiff = useCallback(async (runId: string) => {
    if (!taskId) return null;
    if (runDiffs[runId]) return runDiffs[runId];
    const diff = await taskApi.getAgentRunDiff(taskId, runId);
    setRunDiffs((prev) => ({ ...prev, [runId]: diff }));
    return diff;
  }, [runDiffs, taskId]);

  const cancelRun = useCallback(async (runId: string): Promise<AgentRunCancelResult | null> => {
    if (!taskId) return null;
    const result = await taskApi.cancelAgentRun(taskId, runId);
    if (!result.available) setCancelWarning(result.reason);
    await refreshRuns();
    return result;
  }, [refreshRuns, taskId]);

  return {
    buttons,
    sessions,
    selectedSessionId,
    setSelectedSessionId,
    runs,
    runDetails,
    runDiffs,
    cancelWarning,
    phase,
    loading: phase === "loading",
    running: phase === "running",
    error,
    lastRun,
    lastMessage,
    normalizeRunId,
    normalizeProgress,
    normalizeProgressError,
    opencodeAvailable,
    runnerMode,
    refreshButtons,
    refreshSessions,
    refreshRuns,
    createAutomationSession,
    normalizeRequirements,
    executeButton,
    loadRunDetail,
    loadRunDiff,
    cancelRun,
  };
}
