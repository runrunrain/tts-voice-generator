import { AlertCircle, CheckCircle2, Copy, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAppState } from "../../state/AppContext";
import { useProductionList } from "../../hooks/useProductionList";
import type { DirectorProfile, ResponseFormat, VoiceLine } from "../../types";

const FORMAT_OPTIONS: ResponseFormat[] = ["wav", "pcm", "mp3"];

export function ProductionListEditor({ taskId, directorProfiles = [], onExecuteLine }: { taskId: string; directorProfiles?: DirectorProfile[]; onExecuteLine?: (lineId: string) => void | Promise<void> }) {
  const { voices, settings } = useAppState();
  const {
    draftLines,
    list,
    phase,
    loading,
    saving,
    validating,
    error,
    saveMessage,
    validationReport,
    conflictError,
    updateLine,
    addLine,
    deleteLine,
    validateRemote,
    save,
    refresh,
    discardLocal,
    clearConflict,
  } = useProductionList(taskId);
  const [copied, setCopied] = useState(false);

  const voiceOptions = voices.length > 0 ? voices.map((voice) => voice.name) : [settings.defaultVoice || "Zephyr"];
  const lineIssues = useMemo(() => {
    const map = new Map<string, string[]>();
    validationReport?.issues.forEach((issue) => {
      if (!issue.lineId) return;
      const next = map.get(issue.lineId) ?? [];
      next.push(issue.message);
      map.set(issue.lineId, next);
    });
    return map;
  }, [validationReport]);

  const localDraftText = JSON.stringify({ lines: draftLines }, null, 2);

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(localDraftText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (loading && draftLines.length === 0) {
    return <PanelState icon={<Loader2 size={18} className="animate-spin" />} title="正在加载生产列表" />;
  }

  return (
    <section className="h-full min-h-[560px] flex flex-col border border-border-subtle bg-bg-surface">
      <header className="h-12 shrink-0 px-4 border-b border-border-subtle flex items-center justify-between bg-bg-sunken/60">
        <div>
          <div className="text-sm font-semibold">生产列表编辑器</div>
          <div className="text-[10px] text-text-tertiary font-mono">v{list?.version ?? "--"} · {draftLines.length} 行 · expectedVersion 保存</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={refresh} disabled={saving || validating}><RefreshCw size={13} /> 刷新</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={() => validateRemote()} disabled={saving || validating}>{validating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 校验</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={addLine} disabled={saving}><Plus size={13} /> 新增行</button>
          <button className="px-4 py-1.5 rounded bg-accent text-bg-base text-xs font-semibold hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1" onClick={save} disabled={saving || !list}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存</button>
        </div>
      </header>

      {(error || saveMessage) && (
        <div className={`mx-4 mt-3 px-3 py-2 rounded border text-xs flex items-center gap-2 ${error ? "bg-error-muted border-error/20 text-error" : "bg-success-muted border-success/20 text-success"}`}>
          {error ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
          {error || saveMessage}
        </div>
      )}

      {validationReport && (
        <div className="mx-4 mt-3 px-3 py-2 rounded border border-border-subtle bg-bg-sunken text-xs flex items-center justify-between">
          <span className={validationReport.ok ? "text-success" : "text-warning"}>校验报告：{validationReport.ok ? "可保存" : "需要处理"}</span>
          <span className="text-text-tertiary">{validationReport.issues.length} 条问题</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {draftLines.length === 0 ? (
          <PanelState icon={<Plus size={18} />} title="暂无生产行" hint="点击新增行创建第一条语音台词" />
        ) : (
          <table className="w-full min-w-[1180px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-bg-sunken text-text-tertiary border-b border-border-subtle">
              <tr>
                <Th className="w-12">#</Th>
                <Th className="w-[360px]">Transcript</Th>
                <Th className="w-40">Voice</Th>
                <Th className="w-64">Model</Th>
                <Th className="w-28">Format</Th>
                <Th className="w-48">Director Profile</Th>
                <Th>Notes</Th>
                <Th className="w-28">Action</Th>
              </tr>
            </thead>
            <tbody>
              {draftLines.map((line, index) => (
                <ProductionRow
                  key={line.id}
                  line={line}
                  index={index}
                  voices={voiceOptions}
                  directorProfiles={directorProfiles}
                  issues={lineIssues.get(line.id) ?? []}
                  disabled={saving}
                  onChange={(patch) => updateLine(line.id, patch)}
                  onDelete={() => deleteLine(line.id)}
                  onExecute={onExecuteLine ? async () => { await onExecuteLine(line.id); await refresh(); } : undefined}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="h-9 shrink-0 px-4 border-t border-border-subtle bg-bg-sunken flex items-center justify-between text-[10px] text-text-tertiary">
        <span>键盘可直接 Tab 到单元格编辑；保存使用服务端 expectedVersion 防止覆盖他人修改。</span>
        <span>{phase === "conflict" ? "发现版本冲突" : "生产控制台就绪"}</span>
      </footer>

      {conflictError && (
        <div className="absolute inset-0 z-30 bg-bg-base/70 backdrop-blur-sm flex items-center justify-center">
          <div className="w-[520px] border border-warning/30 bg-bg-elevated shadow-shadow-lg rounded-lg p-5 flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-warning shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-text-primary">版本冲突，未覆盖服务端数据</h3>
                <p className="text-xs text-text-secondary mt-1">保存携带的 expectedVersion 已过期。请刷新查看服务端最新版本，或先复制本地草稿后再丢弃本地修改。</p>
                <p className="text-[10px] text-warning mt-2">{conflictError.message}</p>
              </div>
            </div>
            <textarea className="h-28 bg-bg-sunken border border-border rounded p-2 text-[10px] font-mono text-text-tertiary" readOnly value={localDraftText} />
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={copyDraft}><Copy size={12} /> {copied ? "已复制" : "复制草稿"}</button>
              <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover" onClick={() => { clearConflict(); refresh(); }}>刷新服务端</button>
              <button className="px-3 py-1.5 rounded bg-warning text-bg-base text-xs font-semibold" onClick={discardLocal}>丢弃本地</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProductionRow({ line, index, voices, directorProfiles, issues, disabled, onChange, onDelete, onExecute }: {
  line: VoiceLine;
  index: number;
  voices: string[];
  directorProfiles: DirectorProfile[];
  issues: string[];
  disabled: boolean;
  onChange: (patch: Partial<VoiceLine>) => void;
  onDelete: () => void;
  onExecute?: () => void | Promise<void>;
}) {
  return (
    <tr className={`border-b border-border-subtle hover:bg-bg-hover/60 ${issues.length ? "bg-warning-muted/20" : ""}`}>
      <Td className="text-text-tertiary font-mono">{String(index + 1).padStart(2, "0")}</Td>
      <Td>
        <textarea className="w-full h-16 bg-bg-base border border-border rounded p-2 text-xs outline-none resize-none focus:border-border-focus" value={line.transcript} onChange={(event) => onChange({ transcript: event.target.value })} disabled={disabled} placeholder="输入该行台词" />
        {issues.length > 0 && <div className="mt-1 text-[10px] text-warning">{issues.join("；")}</div>}
      </Td>
      <Td><select className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={line.voice} onChange={(event) => onChange({ voice: event.target.value })} disabled={disabled}>{voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></Td>
      <Td><input className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus font-mono" value={line.model} onChange={(event) => onChange({ model: event.target.value })} disabled={disabled} /></Td>
      <Td><select className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus font-mono" value={line.responseFormat} onChange={(event) => onChange({ responseFormat: event.target.value as ResponseFormat })} disabled={disabled}>{FORMAT_OPTIONS.map((format) => <option key={format} value={format}>{format}</option>)}</select></Td>
      <Td><select className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={line.directorProfileId ?? ""} onChange={(event) => onChange({ directorProfileId: event.target.value || null })} disabled={disabled}><option value="">无</option>{directorProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Td>
      <Td><input className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={line.notes ?? ""} onChange={(event) => onChange({ notes: event.target.value })} disabled={disabled} placeholder="制片备注" /></Td>
      <Td>
        <div className="flex items-center gap-1">
          <button className="p-1.5 rounded border border-border text-text-secondary hover:text-accent hover:bg-bg-sunken disabled:opacity-50" onClick={onExecute} disabled={disabled || !onExecute || !line.transcript.trim()} title="行级 Agent 执行"><CheckCircle2 size={13} /></button>
          <button className="p-1.5 rounded border border-border text-text-secondary hover:text-error hover:bg-error-muted disabled:opacity-50" onClick={onDelete} disabled={disabled} title="删除行"><Trash2 size={13} /></button>
        </div>
      </Td>
    </tr>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left font-semibold border-r border-border-subtle last:border-r-0 ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top border-r border-border-subtle last:border-r-0 ${className}`}>{children}</td>;
}

function PanelState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="h-full min-h-[320px] flex flex-col items-center justify-center gap-2 text-text-tertiary">
      {icon}
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="text-xs">{hint}</div>}
    </div>
  );
}
