import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, taskApi } from "../services/httpAdapter";
import type { Task, TaskStatus } from "../types";

type LoadState = "idle" | "loading" | "success" | "error";

function formatTaskDeleteError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "任务正在运行或存在活跃执行，请等待完成后再删除。";
    }
    if (err.status === 500) {
      return "任务删除失败，请稍后重试。";
    }
  }
  return err instanceof Error ? err.message : "任务删除失败";
}

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

  const deleteTask = useCallback(async (taskId: string) => {
    setError(null);
    setSuccessMessage(null);
    try {
      await taskApi.deleteTask(taskId);
      setTasks((prev) => prev.filter((item) => item.id !== taskId));
      setSuccessMessage("任务已删除");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setTasks((prev) => prev.filter((item) => item.id !== taskId));
        setSuccessMessage("任务已不存在，列表已更新");
        return;
      }
      const message = formatTaskDeleteError(err);
      setError(message);
      throw new Error(message);
    }
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
    deleteTask,
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
