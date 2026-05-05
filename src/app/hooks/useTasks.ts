import { useCallback, useEffect, useRef, useState } from "react";
import { taskApi } from "../services/httpAdapter";
import type { Task, TaskStatus } from "../types";

type LoadState = "idle" | "loading" | "success" | "error";

export function useTasks(initialStatus: TaskStatus | "all" = "all") {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">(initialStatus);
  const [phase, setPhase] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setPhase("loading");
    setError(null);
    try {
      const result = await taskApi.listTasks(statusFilter);
      if (requestId !== requestRef.current) return;
      setTasks(result.tasks ?? []);
      setPhase("success");
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "任务列表加载失败");
      setPhase("error");
    }
  }, [statusFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createTask = useCallback(async (payload: { title: string; description?: string }) => {
    setError(null);
    setSuccessMessage(null);
    const task = await taskApi.createTask(payload);
    setTasks((prev) => [task, ...prev.filter((item) => item.id !== task.id)]);
    setSuccessMessage("任务已创建");
    return task;
  }, []);

  return {
    tasks,
    statusFilter,
    setStatusFilter,
    phase,
    loading: phase === "loading",
    error,
    successMessage,
    clearSuccessMessage: () => setSuccessMessage(null),
    refresh,
    createTask,
  };
}

export function useTask(taskId: string | undefined) {
  const [task, setTask] = useState<Task | null>(null);
  const [phase, setPhase] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    const requestId = ++requestRef.current;
    setPhase("loading");
    setError(null);
    try {
      const result = await taskApi.getTask(taskId);
      if (requestId !== requestRef.current) return;
      setTask(result);
      setPhase("success");
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "任务加载失败");
      setPhase("error");
    }
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { task, phase, loading: phase === "loading", error, refresh };
}
