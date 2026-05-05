import { useCallback, useEffect, useState } from "react";
import { taskApi } from "../services/httpAdapter";
import type { AgentButton, AgentButtonListResult, OpencodeSession } from "../types";

type Phase = "idle" | "loading" | "running" | "success" | "error";

export function useAgentRuns(taskId: string | undefined) {
  const [buttons, setButtons] = useState<AgentButton[]>([]);
  const [sessions, setSessions] = useState<OpencodeSession[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<OpencodeSession | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [opencodeAvailable, setOpencodeAvailable] = useState(false);
  const [runnerMode, setRunnerMode] = useState<"opencode" | "fallback">("fallback");

  const refreshButtons = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const result = await taskApi.listAgentButtons();
      setButtons(result.buttons ?? []);
      setOpencodeAvailable(result.opencodeAvailable);
      setRunnerMode(result.runnerMode);
      setPhase("success");
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
      setSessions((result.sessions ?? []).filter((session) => session.kind !== "chat"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "OpenCode 会话加载失败");
    }
  }, [taskId]);

  useEffect(() => {
    refreshButtons();
  }, [refreshButtons]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const normalizeRequirements = useCallback(async () => {
    if (!taskId) return null;
    setPhase("running");
    setError(null);
    setLastMessage(null);
    try {
      const result = await taskApi.normalizeRequirements(taskId);
      setLastRun(null);
      setLastMessage(`需求已标准化：生成 ${result.productionList.lines.length} 行，版本 v${result.productionList.version}`);
      await refreshSessions();
      setPhase("success");
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "需求标准化执行失败");
      setPhase("error");
      return null;
    }
  }, [refreshSessions, taskId]);

  const executeButton = useCallback(async (buttonKey: string, lineId?: string) => {
    if (!taskId) return null;
    setPhase("running");
    setError(null);
    setLastMessage(null);
    try {
      const session = await taskApi.executeAgentButton(taskId, buttonKey, lineId ? { lineId } : undefined);
      setLastRun(session);
      setLastMessage(`按钮已执行：${buttonKey}`);
      setSessions((prev) => [session, ...prev.filter((item) => item.id !== session.id)]);
      setPhase("success");
      return session;
    } catch (err) {
      setError(err instanceof Error ? err.message : "OpenCode 执行失败");
      setPhase("error");
      return null;
    }
  }, [taskId]);

  return {
    buttons,
    sessions,
    phase,
    loading: phase === "loading",
    running: phase === "running",
    error,
    lastRun,
    lastMessage,
    opencodeAvailable,
    runnerMode,
    refreshButtons,
    refreshSessions,
    normalizeRequirements,
    executeButton,
  };
}
