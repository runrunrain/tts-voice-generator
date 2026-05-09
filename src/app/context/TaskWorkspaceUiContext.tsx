import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ValidationIssue, VoiceLine } from "../types";

export type WorkspaceTab = "documents" | "production" | "directors" | "audit";

export interface TaskWorkspaceValidationSummary {
  errorCount: number;
  warningCount: number;
  issuesByLineId: Record<string, ValidationIssue[]>;
}

export interface TaskWorkspaceSnapshot {
  taskId: string | null;
  taskTitle?: string;
  activeTab: WorkspaceTab;
  productionVersion: number | null;
  lines: VoiceLine[];
  selectedLineIds: string[];
  validationSummary: TaskWorkspaceValidationSummary;
  dirty: boolean;
  refreshProduction?: () => Promise<void>;
  refreshProfiles?: () => Promise<void>;
}

interface TaskWorkspaceUiContextValue extends TaskWorkspaceSnapshot {
  setActiveTab(tab: WorkspaceTab): void;
  setSelectedLineIds(ids: string[]): void;
  patchSnapshot(patch: Partial<TaskWorkspaceSnapshot>): void;
  resetSnapshot(): void;
}

const EMPTY_VALIDATION: TaskWorkspaceValidationSummary = {
  errorCount: 0,
  warningCount: 0,
  issuesByLineId: {},
};

const initialSnapshot: TaskWorkspaceSnapshot = {
  taskId: null,
  activeTab: "documents",
  productionVersion: null,
  lines: [],
  selectedLineIds: [],
  validationSummary: EMPTY_VALIDATION,
  dirty: false,
};

const TaskWorkspaceUiContext = createContext<TaskWorkspaceUiContextValue | null>(null);

export function TaskWorkspaceUiProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<TaskWorkspaceSnapshot>(initialSnapshot);

  const setActiveTab = useCallback((activeTab: WorkspaceTab) => {
    setSnapshot((prev) => ({ ...prev, activeTab }));
  }, []);

  const setSelectedLineIds = useCallback((selectedLineIds: string[]) => {
    setSnapshot((prev) => ({ ...prev, selectedLineIds }));
  }, []);

  const patchSnapshot = useCallback((patch: Partial<TaskWorkspaceSnapshot>) => {
    setSnapshot((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetSnapshot = useCallback(() => {
    setSnapshot(initialSnapshot);
  }, []);

  const value = useMemo<TaskWorkspaceUiContextValue>(() => ({
    ...snapshot,
    setActiveTab,
    setSelectedLineIds,
    patchSnapshot,
    resetSnapshot,
  }), [patchSnapshot, resetSnapshot, setActiveTab, setSelectedLineIds, snapshot]);

  return <TaskWorkspaceUiContext.Provider value={value}>{children}</TaskWorkspaceUiContext.Provider>;
}

export function useTaskWorkspaceUi() {
  const context = useContext(TaskWorkspaceUiContext);
  if (!context) {
    throw new Error("useTaskWorkspaceUi must be used inside TaskWorkspaceUiProvider");
  }
  return context;
}

export function buildValidationSummary(issues: ValidationIssue[] = []): TaskWorkspaceValidationSummary {
  const issuesByLineId: Record<string, ValidationIssue[]> = {};
  let errorCount = 0;
  let warningCount = 0;
  issues.forEach((issue) => {
    if (issue.severity === "error") errorCount += 1;
    if (issue.severity === "warning") warningCount += 1;
    if (!issue.lineId) return;
    issuesByLineId[issue.lineId] = [...(issuesByLineId[issue.lineId] ?? []), issue];
  });
  return { errorCount, warningCount, issuesByLineId };
}
