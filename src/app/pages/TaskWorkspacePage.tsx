import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { AlertCircle, FileText, Loader2, ListChecks, Settings2, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { DirectorProfilesPanel } from "../components/tasks/DirectorProfilesPanel";
import { ProductionListEditorView } from "../components/tasks/ProductionListEditor";
import { RequirementDocsPanel } from "../components/tasks/RequirementDocsPanel";
import { buildValidationSummary, useTaskWorkspaceUi, type WorkspaceTab } from "../context/TaskWorkspaceUiContext";
import { useProductionList } from "../hooks/useProductionList";
import { useTask } from "../hooks/useTasks";
import { taskApi } from "../services/httpAdapter";
import type { DirectorProfile, ValidationIssue } from "../types";

const TABS: Array<{ key: WorkspaceTab; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = [
  { key: "documents", label: "需求文档", icon: FileText },
  { key: "production", label: "生产列表", icon: ListChecks },
  { key: "directors", label: "导演配置", icon: SlidersHorizontal },
  { key: "audit", label: "审计", icon: ShieldAlert },
];

export function TaskWorkspacePage() {
  const params = useParams();
  const taskId = params.taskId;
  const { task, loading, error, refresh } = useTask(taskId);
  const [tab, setTab] = useState<WorkspaceTab>("documents");
  const [profiles, setProfiles] = useState<DirectorProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const production = useProductionList(taskId);
  const workspace = useTaskWorkspaceUi();
  const { selectedLineIds, setSelectedLineIds, setActiveTab, patchSnapshot, resetSnapshot } = workspace;

  const loadProfiles = useCallback(async () => {
    if (!taskId) return;
    setProfilesLoading(true);
    setProfilesError(null);
    try {
      const result = await taskApi.listDirectorProfiles(taskId);
      setProfiles(result.profiles);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : "导演配置加载失败");
      /* profiles remain unchanged so the editor keeps any previously loaded dropdown options */
    } finally {
      setProfilesLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const validationSummary = useMemo(() => buildValidationSummary(buildWorkspaceIssues(production.draftLines, production.validationReport?.issues ?? [])), [production.draftLines, production.validationReport]);

  useEffect(() => {
    if (!taskId) {
      resetSnapshot();
      return;
    }
    patchSnapshot({
      taskId,
      taskTitle: task?.title,
      activeTab: tab,
      productionVersion: production.list?.version ?? null,
      lines: production.draftLines,
      validationSummary,
      dirty: Boolean(production.list && JSON.stringify(production.list.lines) !== JSON.stringify(production.draftLines)),
      refreshProduction: production.refresh,
      refreshProfiles: loadProfiles,
    });
  }, [loadProfiles, patchSnapshot, production.draftLines, production.list, production.refresh, resetSnapshot, tab, task?.title, taskId, validationSummary]);

  useEffect(() => () => resetSnapshot(), [resetSnapshot]);

  const setWorkspaceTab = (nextTab: WorkspaceTab) => {
    setTab(nextTab);
    setActiveTab(nextTab);
  };

  if (!taskId) {
    return <WorkspaceState title="缺少任务 ID" hint="请从任务列表进入工作台" />;
  }

  if (loading && !task) {
    return <WorkspaceState title="正在装载工作台" icon={<Loader2 size={24} className="animate-spin" />} />;
  }

  if (error && !task) {
    return <WorkspaceState title="工作台加载失败" hint={error} icon={<AlertCircle size={24} />} action={<button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover" onClick={refresh}>重试</button>} />;
  }

  return (
    <div className="h-full min-h-0 min-w-0 overflow-hidden flex flex-col bg-bg-base relative">
      <TaskHeader taskId={taskId} title={task?.title ?? "任务工作台"} status={task?.status ?? "draft"} updatedAt={task?.updatedAt} onRefresh={refresh} />

      <div className="h-11 [@media(max-height:760px)]:h-10 shrink-0 border-b border-border-subtle bg-bg-sunken px-6 [@media(max-height:760px)]:px-4 flex items-center gap-2 overflow-x-auto overflow-y-hidden">
        {TABS.map((item) => {
          const Icon = item.icon;
            return <button key={item.key} className={`h-8 px-3 rounded-md text-xs border flex items-center gap-2 transition-colors ${tab === item.key ? "border-accent/40 bg-accent-muted text-accent" : "border-border text-text-secondary hover:bg-bg-hover"}`} onClick={() => setWorkspaceTab(item.key)}><Icon size={14} /> {item.label}</button>;
        })}
      </div>

      <main className="flex-1 min-h-0 min-w-0 overflow-hidden p-5 [@media(max-height:760px)]:p-3">
        <div className="h-full min-h-0 min-w-0 overflow-hidden">
          {tab === "documents" && <RequirementDocsPanel taskId={taskId} />}
          {tab === "production" && <ProductionListEditorView taskId={taskId} controller={production} directorProfiles={profiles} selectedLineIds={selectedLineIds} onSelectedLineIdsChange={setSelectedLineIds} />}
          {tab === "directors" && <DirectorProfilesPanel taskId={taskId} profiles={profiles} productionLines={production.draftLines} loading={profilesLoading} loadError={profilesError} onProfilesChange={setProfiles} onReload={loadProfiles} />}
          {tab === "audit" && <AuditUnavailableState />}
        </div>
      </main>
    </div>
  );
}

function buildWorkspaceIssues(lines: import("../types").VoiceLine[], remoteIssues: ValidationIssue[]) {
  const localIssues: ValidationIssue[] = [];
  lines.forEach((line, index) => {
    if (!line.transcript.trim()) localIssues.push({ lineId: line.id, field: "transcript", severity: "error", message: `第 ${index + 1} 行缺少语音文本` });
    if (!line.voice.trim()) localIssues.push({ lineId: line.id, field: "voice", severity: "error", message: `第 ${index + 1} 行缺少音色` });
    if (line.transcript.length > 5000) localIssues.push({ lineId: line.id, field: "transcript", severity: "warning", message: `第 ${index + 1} 行超过 5000 字符` });
  });
  return [...localIssues, ...remoteIssues];
}

function AuditUnavailableState() {
  return (
    <div className="h-full border border-border-subtle bg-bg-surface flex flex-col items-center justify-center gap-3 text-center text-text-tertiary">
      <ShieldAlert size={22} className="text-warning" />
      <div className="text-sm font-semibold text-text-secondary">审计记录暂不可用</div>
      <div className="max-w-[28rem] text-xs leading-5">当前前端未发现任务审计时间线 API；此处保持真实不可用空态，不渲染假审计日志。Agent run 历史可在右侧 Agent 自动化面板查看。</div>
    </div>
  );
}

function TaskHeader({ taskId, title, status, updatedAt, onRefresh }: { taskId: string; title: string; status: string; updatedAt?: string; onRefresh: () => void }) {
  return (
    <header className="shrink-0 px-6 [@media(max-height:760px)]:px-4 py-4 [@media(max-height:760px)]:py-2 border-b border-border-subtle bg-[linear-gradient(90deg,rgba(201,148,74,0.12),transparent_42%),var(--color-bg-base)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-text-tertiary"><Link to="/tasks" className="hover:text-accent">任务</Link><span>/</span><span className="font-mono truncate">{taskId}</span></div>
          <h1 className="mt-2 text-xl font-display font-bold text-text-primary truncate">{title}</h1>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-text-tertiary font-mono"><span className="px-2 py-0.5 rounded border border-border bg-bg-sunken text-text-secondary">{status}</span><span>updated: {updatedAt ? new Date(updatedAt).toLocaleString("zh-CN") : "--"}</span></div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={onRefresh}><Settings2 size={13} /> 刷新任务</button>
        </div>
      </div>
    </header>
  );
}

function WorkspaceState({ title, hint, icon, action }: { title: string; hint?: string; icon?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="h-full flex flex-col items-center justify-center gap-3 text-text-tertiary text-center">{icon}<div className="text-sm font-semibold text-text-secondary">{title}</div>{hint && <div className="text-xs max-w-[28rem] leading-5">{hint}</div>}{action}</div>;
}
