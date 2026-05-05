import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { AlertCircle, Bot, FileText, Loader2, ListChecks, Settings2, SlidersHorizontal } from "lucide-react";
import { AgentAutomationPanel } from "../components/tasks/AgentAutomationPanel";
import { DirectorProfilesPanel } from "../components/tasks/DirectorProfilesPanel";
import { ProductionListEditor } from "../components/tasks/ProductionListEditor";
import { RequirementDocsPanel } from "../components/tasks/RequirementDocsPanel";
import { useAgentRuns } from "../hooks/useAgentRuns";
import { useProductionList } from "../hooks/useProductionList";
import { useTask } from "../hooks/useTasks";
import { taskApi } from "../services/httpAdapter";
import type { DirectorProfile } from "../types";

type WorkspaceTab = "documents" | "production" | "directors" | "automation";

const TABS: Array<{ key: WorkspaceTab; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = [
  { key: "documents", label: "需求文档", icon: FileText },
  { key: "production", label: "生产列表", icon: ListChecks },
  { key: "directors", label: "导演配置", icon: SlidersHorizontal },
  { key: "automation", label: "Agent 自动化", icon: Bot },
];

export function TaskWorkspacePage() {
  const params = useParams();
  const taskId = params.taskId;
  const { task, loading, error, refresh } = useTask(taskId);
  const [tab, setTab] = useState<WorkspaceTab>("documents");
  const [profiles, setProfiles] = useState<DirectorProfile[]>([]);
  const productionForAutomation = useProductionList(tab === "automation" ? taskId : undefined);
  const agentRuns = useAgentRuns(taskId);

  const loadProfiles = useCallback(async () => {
    try {
      const result = await taskApi.listDirectorProfiles(taskId);
      setProfiles(result.profiles);
    } catch { /* profiles remain empty, editor shows no dropdown options */ }
  }, [taskId]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

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
    <div className="h-full flex flex-col bg-bg-base relative">
      <TaskHeader taskId={taskId} title={task?.title ?? "任务工作台"} status={task?.status ?? "draft"} updatedAt={task?.updatedAt} onRefresh={refresh} />

      <div className="h-11 shrink-0 border-b border-border-subtle bg-bg-sunken px-6 flex items-center gap-2">
        {TABS.map((item) => {
          const Icon = item.icon;
          return <button key={item.key} className={`h-8 px-3 rounded-md text-xs border flex items-center gap-2 transition-colors ${tab === item.key ? "border-accent/40 bg-accent-muted text-accent" : "border-border text-text-secondary hover:bg-bg-hover"}`} onClick={() => setTab(item.key)}><Icon size={14} /> {item.label}</button>;
        })}
      </div>

      <main className="flex-1 overflow-hidden p-5">
        {tab === "documents" && <RequirementDocsPanel taskId={taskId} />}
        {tab === "production" && <ProductionListEditor taskId={taskId} directorProfiles={profiles} onExecuteLine={async (lineId) => { await agentRuns.executeButton("shorten", lineId); }} />}
        {tab === "directors" && <DirectorProfilesPanel taskId={taskId} onProfilesChange={setProfiles} />}
        {tab === "automation" && <AgentAutomationPanel taskId={taskId} lines={productionForAutomation.draftLines} onProductionListChanged={productionForAutomation.refresh} />}
      </main>
    </div>
  );
}

function TaskHeader({ taskId, title, status, updatedAt, onRefresh }: { taskId: string; title: string; status: string; updatedAt?: string; onRefresh: () => void }) {
  return (
    <header className="shrink-0 px-6 py-4 border-b border-border-subtle bg-[linear-gradient(90deg,rgba(201,148,74,0.12),transparent_42%),var(--color-bg-base)]">
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
  return <div className="h-full flex flex-col items-center justify-center gap-3 text-text-tertiary text-center">{icon}<div className="text-sm font-semibold text-text-secondary">{title}</div>{hint && <div className="text-xs max-w-md leading-5">{hint}</div>}{action}</div>;
}
