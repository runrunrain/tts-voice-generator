import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useLocation, useParams } from "react-router";
import { taskApi } from "../services/httpAdapter";
import type { AgentChatMessage, OpencodeSession } from "../types";

type Phase = "idle" | "creating" | "loading" | "sending" | "success" | "error";

interface UseGlobalAgentDockOptions {
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
}

function pageLabel(pathname: string) {
  if (pathname.startsWith("/tasks/")) return "任务工作台";
  if (pathname === "/tasks") return "任务总览";
  if (pathname.startsWith("/generate/director")) return "Director";
  if (pathname.startsWith("/voices")) return "音色";
  if (pathname.startsWith("/history")) return "历史";
  if (pathname.startsWith("/settings")) return "设置";
  return "生成";
}

export function useGlobalAgentDock(options: UseGlobalAgentDockOptions = {}) {
  const location = useLocation();
  const params = useParams();
  const { isOpen: controlledIsOpen, onOpenChange } = options;
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const [session, setSession] = useState<OpencodeSession | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const context = useMemo(() => ({
    pagePath: location.pathname,
    pageLabel: pageLabel(location.pathname),
    taskId: params.taskId,
  }), [location.pathname, params.taskId]);

  const isControlled = typeof controlledIsOpen === "boolean";
  const isOpen = controlledIsOpen ?? internalIsOpen;

  const setIsOpen: Dispatch<SetStateAction<boolean>> = useCallback((nextOpen) => {
    const resolvedOpen = typeof nextOpen === "function" ? nextOpen(isOpen) : nextOpen;
    if (isControlled) {
      onOpenChange?.(resolvedOpen);
      return;
    }
    setInternalIsOpen(resolvedOpen);
  }, [isControlled, isOpen, onOpenChange]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, [setIsOpen]);

  useEffect(() => {
    setSession(null);
    setMessages([]);
    setError(null);
    setPhase("idle");
  }, [context.pagePath, context.taskId]);

  const ensureSession = useCallback(async () => {
    if (session) return session;
    setPhase("creating");
    const created = await taskApi.createChatSession({
      taskId: context.taskId,
      pagePath: context.pagePath,
      title: `Dock chat - ${context.pageLabel}`,
    });
    setSession(created);
    return created;
  }, [context.pageLabel, context.pagePath, context.taskId, session]);

  const loadMessages = useCallback(async (sessionId: string) => {
    setPhase("loading");
    const result = await taskApi.listChatMessages(sessionId);
    setMessages(result.messages ?? []);
    setPhase("success");
  }, []);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || phase === "sending") return;
    setDraft("");
    setError(null);
    const optimistic: AgentChatMessage = {
      id: `pending-${Date.now().toString(36)}`,
      sessionId: session?.id ?? "pending",
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      status: "sending",
    };
    setMessages((prev) => [...prev, optimistic]);
    setPhase("sending");
    try {
      const activeSession = await ensureSession();
      const result = await taskApi.sendChatMessage(activeSession.id, content);
      if (result.messages.length > 0) {
        setMessages(result.messages);
      } else {
        setMessages((prev) => prev.map((message) => message.id === optimistic.id ? { ...message, sessionId: activeSession.id, status: "sent" } : message));
        await loadMessages(activeSession.id);
      }
      setPhase("success");
    } catch (err) {
      setMessages((prev) => prev.map((message) => message.id === optimistic.id ? { ...message, status: "failed", error: "发送失败" } : message));
      setError(err instanceof Error ? err.message : "Agent Chat 发送失败");
      setPhase("error");
    }
  }, [draft, ensureSession, loadMessages, phase, session?.id]);

  return {
    isOpen,
    setIsOpen,
    toggle,
    context,
    session,
    messages,
    draft,
    setDraft,
    phase,
    sending: phase === "sending" || phase === "creating",
    error,
    send,
  };
}
