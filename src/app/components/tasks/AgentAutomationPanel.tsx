import { AlertCircle, Bot, CheckCircle2, Loader2, RefreshCw, ShieldAlert, Wand2 } from "lucide-react";
import { useAgentRuns } from "../../hooks/useAgentRuns";
import type { VoiceLine } from "../../types";

export function AgentAutomationPanel({ taskId, lines = [], onProductionListChanged }: { taskId: string; lines?: VoiceLine[]; onProductionListChanged?: () => void | Promise<void> }) {
  const {
    buttons,
    sessions,
    loading,
    running,
    error,
    lastRun,
    lastMessage,
    opencodeAvailable,
    runnerMode,
    refreshButtons,
    refreshSessions,
    normalizeRequirements,
    executeButton,
  } = useAgentRuns(taskId);

  const taskButtons = buttons.filter((button) => button.scope !== "line");
  const lineButtons = buttons.filter((button) => button.scope === "line");

  const handleNormalize = async () => {
    const result = await normalizeRequirements();
    if (result) await onProductionListChanged?.();
  };

  const handleExecute = async (buttonKey: string, lineId?: string) => {
    const result = await executeButton(buttonKey, lineId);
    if (result) await onProductionListChanged?.();
  };

  return (
    <section className="h-full min-h-[520px] grid grid-cols-[1fr_360px] gap-4">
      <div className="border border-border-subtle bg-bg-surface flex flex-col">
        <header className="h-12 px-4 border-b border-border-subtle bg-bg-sunken/60 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold flex items-center gap-2"><Bot size={15} /> OpenCode-Agent 自动化</div>
            <div className="text-[10px] text-text-tertiary">自动化 session 与右下角 Dock chat session 隔离</div>
          </div>
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={() => { refreshButtons(); refreshSessions(); }} disabled={loading || running}><RefreshCw size={13} /> 刷新</button>
          </div>
        </header>

        <div className="p-4 flex flex-col gap-4 overflow-y-auto">
          {loading && <Banner tone="info" icon={<Loader2 size={14} className="animate-spin" />} text="正在探测 OpenCode 能力" />}
          {error && <Banner tone="error" icon={<AlertCircle size={14} />} text={`OpenCode 不可用或执行失败：${error}`} />}
          {!loading && !opencodeAvailable && runnerMode === "fallback" && (
            <Banner tone="warning" icon={<ShieldAlert size={14} />} text="OpenCode CLI 不可用，当前使用本地受控 fallback 模式。按钮仍可执行但结果由本地规则引擎生成，非 AI 驱动。" />
          )}
          {lastMessage && <Banner tone="success" icon={<CheckCircle2 size={14} />} text={lastMessage} />}
          {lastRun && <Banner tone={lastRun.status === "failed" ? "error" : "success"} icon={<CheckCircle2 size={14} />} text={`最近运行：${lastRun.title ?? lastRun.buttonKey ?? lastRun.id} · ${lastRun.status}`} />}

          <div className="grid grid-cols-3 gap-3">
            <ActionCard
              title="Normalize Requirements"
              description="整理需求文档、生成结构化生产前置条件"
              disabled={running || !opencodeAvailable}
              busy={running}
              onClick={handleNormalize}
            />
            {taskButtons.map((button) => (
              <ActionCard key={button.key} title={button.label} description={button.description ?? button.key} disabled={running || !button.available} disabledReason={button.disabledReason ?? undefined} busy={running} onClick={() => handleExecute(button.key)} />
            ))}
          </div>

          <div className="border border-border-subtle bg-bg-sunken rounded-md overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle text-xs font-semibold flex items-center justify-between">
              <span>行级自动化</span>
              <span className="text-text-tertiary">{lines.length} 行</span>
            </div>
            {lines.length === 0 ? (
              <div className="h-28 flex items-center justify-center text-xs text-text-tertiary">暂无生产行，先在生产列表中新增台词</div>
            ) : (
              <div className="max-h-[320px] overflow-y-auto divide-y divide-border-subtle">
                {lines.map((line, index) => (
                  <div key={line.id} className="p-3 grid grid-cols-[40px_1fr_auto] gap-3 items-center text-xs">
                    <span className="font-mono text-text-tertiary">{String(index + 1).padStart(2, "0")}</span>
                    <div className="min-w-0">
                      <div className="truncate text-text-secondary">{line.transcript || "空台词"}</div>
                      <div className="text-[10px] text-text-tertiary mt-1">{line.voice} · {line.responseFormat}</div>
                    </div>
                    <div className="flex gap-1">
                      {lineButtons.length === 0 ? (
                        <button className="px-2 py-1 rounded border border-border text-text-tertiary" disabled>无按钮</button>
                      ) : lineButtons.map((button) => (
                        <button key={button.key} className={`px-2 py-1 rounded border border-border hover:bg-bg-hover disabled:opacity-50 ${button.runner === "fallback" ? "border-dashed" : ""}`} disabled={running || !button.available || !line.transcript.trim()} onClick={() => handleExecute(button.key, line.id)} title={`${button.disabledReason ?? button.description ?? button.key}${button.runner === "fallback" ? " [fallback/本地受控]" : ""}`}>{button.label}{button.runner === "fallback" ? "*" : ""}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <aside className="border border-border-subtle bg-bg-surface flex flex-col">
        <header className="h-12 px-4 border-b border-border-subtle bg-bg-sunken/60 flex items-center justify-between">
          <div className="text-sm font-semibold">Run 状态</div>
          <span className={`text-[10px] px-2 py-0.5 rounded border ${running ? "text-accent border-accent/20 bg-accent-muted" : "text-text-tertiary border-border"}`}>{running ? "运行中" : "空闲"}</span>
        </header>
        <div className="flex-1 overflow-y-auto divide-y divide-border-subtle">
          {sessions.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-text-tertiary text-center px-6">暂无 automation session。触发上方按钮后，后端返回的真实运行记录会显示在这里。</div>
          ) : sessions.map((session) => (
            <div key={session.id} className="p-3 text-xs flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-text-secondary truncate">{session.id}</span>
                <span className={`shrink-0 ${session.status === "failed" ? "text-error" : session.status === "succeeded" ? "text-success" : "text-accent"}`}>{session.status}</span>
              </div>
              <div className="text-text-tertiary truncate">{session.title ?? session.buttonKey ?? "automation"}</div>
              {session.error && <div className="text-error">{session.error}</div>}
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
}

function ActionCard({ title, description, disabled, disabledReason, busy, onClick }: { title: string; description: string; disabled: boolean; disabledReason?: string; busy: boolean; onClick: () => void }) {
  return (
    <button className="min-h-[118px] text-left p-4 rounded-md border border-border bg-bg-sunken hover:border-accent/50 hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-bg-sunken" onClick={onClick} disabled={disabled} title={disabledReason}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-primary">{title}</span>
        {busy ? <Loader2 size={15} className="animate-spin text-accent" /> : <Wand2 size={15} className="text-accent" />}
      </div>
      <p className="text-xs text-text-secondary mt-2 leading-5">{description}</p>
      {disabledReason && <p className="text-[10px] text-warning mt-2">{disabledReason}</p>}
    </button>
  );
}

function Banner({ tone, icon, text }: { tone: "info" | "warning" | "error" | "success"; icon: React.ReactNode; text: string }) {
  const cls = tone === "error" ? "bg-error-muted border-error/20 text-error" : tone === "warning" ? "bg-warning-muted border-warning/20 text-warning" : tone === "success" ? "bg-success-muted border-success/20 text-success" : "bg-accent-muted border-accent/20 text-accent";
  return <div className={`px-3 py-2 rounded border text-xs flex items-center gap-2 ${cls}`}>{icon}<span>{text}</span></div>;
}
