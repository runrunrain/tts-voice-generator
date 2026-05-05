import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { AlertCircle, CheckCircle2, Factory, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { useTasks } from "../hooks/useTasks";
import type { Task, TaskStatus } from "../types";

const STATUS_OPTIONS: Array<TaskStatus | "all"> = ["all", "draft", "ready", "running", "blocked", "completed", "failed"];

const STATUS_LABEL: Record<TaskStatus | "all", string> = {
  all: "全部",
  draft: "草稿",
  ready: "就绪",
  running: "生产中",
  blocked: "阻塞",
  completed: "完成",
  failed: "失败",
};

export function TasksPage() {
  const navigate = useNavigate();
  const { tasks, statusFilter, setStatusFilter, loading, phase, error, successMessage, clearSuccessMessage, refresh, createTask } = useTasks();
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const filtered = tasks.filter((task) => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return true;
    return task.title.toLowerCase().includes(keyword) || (task.description ?? "").toLowerCase().includes(keyword);
  });

  const submit = async () => {
    if (!title.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const task = await createTask({ title: title.trim(), description: description.trim() || undefined });
      setTitle("");
      setDescription("");
      setDialogOpen(false);
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "任务创建失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg-base">
      <div className="shrink-0 px-8 py-6 border-b border-border-subtle bg-[linear-gradient(135deg,rgba(201,148,74,0.10),transparent_38%),var(--color-bg-base)]">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-accent font-mono">Voice Production Control</div>
            <h1 className="mt-2 text-2xl font-display font-bold text-text-primary">OpenCode-Agent 语音生产任务</h1>
            <p className="mt-1 text-sm text-text-secondary">PC 高密任务台：需求文档、生产列表、导演配置与自动化执行统一编排。</p>
          </div>
          <button className="px-4 py-2 rounded-md bg-accent text-bg-base text-sm font-semibold hover:bg-accent-hover shadow-shadow-glow flex items-center gap-2" onClick={() => { clearSuccessMessage(); setDialogOpen(true); }}><Plus size={16} /> 创建任务</button>
        </div>
      </div>

      <div className="shrink-0 px-8 py-3 border-b border-border-subtle flex items-center justify-between gap-4 bg-bg-sunken">
        <div className="flex items-center gap-2">
          {STATUS_OPTIONS.map((status) => (
            <button key={status} className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${statusFilter === status ? "border-accent/40 bg-accent-muted text-accent" : "border-border text-text-secondary hover:bg-bg-hover"}`} onClick={() => setStatusFilter(status)}>{STATUS_LABEL[status]}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="h-8 w-64 flex items-center gap-2 px-2 rounded-md bg-bg-base border border-border focus-within:border-border-focus">
            <Search size={13} className="text-text-tertiary" />
            <input className="flex-1 bg-transparent outline-none text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务标题或描述" />
          </label>
          <button className="h-8 px-3 rounded-md border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={refresh} disabled={loading}><RefreshCw size={13} className={loading ? "animate-spin" : ""} /> 刷新</button>
        </div>
      </div>

      {(error || successMessage) && <div className={`mx-8 mt-4 px-3 py-2 rounded border text-xs flex items-center gap-2 ${error ? "bg-error-muted border-error/20 text-error" : "bg-success-muted border-success/20 text-success"}`}>{error ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}{error || successMessage}</div>}

      <main className="flex-1 overflow-auto px-8 py-5">
        {loading && tasks.length === 0 ? (
          <StateBlock icon={<Loader2 size={22} className="animate-spin" />} title="正在加载任务" />
        ) : phase === "error" && tasks.length === 0 ? (
          <StateBlock icon={<AlertCircle size={22} />} title="任务加载失败" hint={error ?? "请稍后重试"} action={<button className="px-3 py-1.5 rounded-md border border-border text-xs hover:bg-bg-hover" onClick={refresh}>重试</button>} />
        ) : filtered.length === 0 ? (
          <StateBlock icon={<Factory size={24} />} title="暂无任务" hint="创建一个任务后进入工业级语音制片工作台" action={<button className="px-3 py-1.5 rounded-md bg-accent text-bg-base text-xs font-semibold" onClick={() => setDialogOpen(true)}>创建任务</button>} />
        ) : (
          <div className="border border-border-subtle bg-bg-surface overflow-hidden">
            <table className="w-full min-w-[980px] text-xs border-collapse">
              <thead className="bg-bg-sunken text-text-tertiary border-b border-border-subtle">
                <tr>
                  <Th>任务</Th><Th className="w-28">状态</Th><Th className="w-24">文档</Th><Th className="w-24">生产行</Th><Th className="w-44">更新时间</Th><Th className="w-32">入口</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((task) => <TaskRow key={task.id} task={task} />)}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {dialogOpen && (
        <div className="absolute inset-0 z-30 bg-bg-base/70 backdrop-blur-sm flex items-center justify-center">
          <div className="w-[520px] rounded-lg border border-border bg-bg-elevated shadow-shadow-lg p-5 flex flex-col gap-4">
            <div><h2 className="text-lg font-display font-semibold">创建生产任务</h2><p className="text-xs text-text-tertiary mt-1">任务创建后进入 /tasks/:taskId 工作台继续配置。</p></div>
            {createError && <div className="px-3 py-2 rounded border border-error/20 bg-error-muted text-error text-xs">{createError}</div>}
            <label className="flex flex-col gap-1 text-xs text-text-tertiary">任务标题<input className="bg-bg-sunken border border-border rounded px-3 py-2 text-sm text-text-primary outline-none focus:border-border-focus" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label>
            <label className="flex flex-col gap-1 text-xs text-text-tertiary">描述<textarea className="h-24 bg-bg-sunken border border-border rounded px-3 py-2 text-sm text-text-primary outline-none resize-none focus:border-border-focus" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <div className="flex justify-end gap-2"><button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover" onClick={() => setDialogOpen(false)} disabled={creating}>取消</button><button className="px-4 py-1.5 rounded bg-accent text-bg-base text-xs font-semibold disabled:opacity-50" onClick={submit} disabled={!title.trim() || creating}>{creating ? "创建中" : "创建并进入"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return <tr className="border-b border-border-subtle hover:bg-bg-hover/60"><td className="px-3 py-3"><div className="font-medium text-text-primary">{task.title}</div><div className="text-[10px] text-text-tertiary mt-1 font-mono">{task.id}</div><div className="text-xs text-text-secondary mt-1 truncate max-w-[520px]">{task.description || "无描述"}</div></td><td className="px-3 py-3"><StatusBadge status={task.status} /></td><td className="px-3 py-3 text-text-secondary">{task.documentCount ?? task.documents?.length ?? 0}</td><td className="px-3 py-3 text-text-secondary">{task.lineCount ?? 0}</td><td className="px-3 py-3 text-text-tertiary font-mono">{new Date(task.updatedAt).toLocaleString("zh-CN")}</td><td className="px-3 py-3"><Link className="px-3 py-1.5 rounded border border-accent/30 text-accent hover:bg-accent-muted" to={`/tasks/${task.id}`}>进入工作台</Link></td></tr>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const tone = status === "failed" || status === "blocked" ? "text-error bg-error-muted border-error/20" : status === "completed" ? "text-success bg-success-muted border-success/20" : status === "running" ? "text-accent bg-accent-muted border-accent/20" : "text-text-secondary bg-bg-sunken border-border";
  return <span className={`px-2 py-0.5 rounded border text-[10px] ${tone}`}>{STATUS_LABEL[status]}</span>;
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <th className={`px-3 py-2 text-left font-semibold border-r border-border-subtle last:border-r-0 ${className}`}>{children}</th>; }

function StateBlock({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) { return <div className="h-full min-h-[360px] flex flex-col items-center justify-center gap-3 text-text-tertiary text-center">{icon}<div className="text-sm font-semibold text-text-secondary">{title}</div>{hint && <div className="text-xs max-w-md leading-5">{hint}</div>}{action}</div>; }
