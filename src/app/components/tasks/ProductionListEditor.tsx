import { AlertCircle, CheckCircle2, Circle, Copy, Loader2, Play, Plus, RefreshCw, Save, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAppState } from "../../state/AppContext";
import { useProductionList } from "../../hooks/useProductionList";
import { getLineGenerationStatus, isGeneratableVoiceLine, useProductionGeneration } from "../../hooks/useProductionGeneration";
import type { DirectorProfile, LineGenerationResult, LineGenerationStatus, ResponseFormat, VoiceLine } from "../../types";

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
  const { generating, result: generationResult, message: generationMessage, tone: generationTone, generateLines } = useProductionGeneration(taskId);
  const [copied, setCopied] = useState(false);
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);

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
  const eligibleLineIds = useMemo(() => draftLines.filter(isGeneratableVoiceLine).map((line) => line.id), [draftLines]);
  const selectedEligibleLineIds = useMemo(() => selectedLineIds.filter((lineId) => eligibleLineIds.includes(lineId)), [eligibleLineIds, selectedLineIds]);
  const resultByLineId = useMemo(() => new Map(generationResult?.results.map((item) => [item.lineId, item]) ?? []), [generationResult]);
  const allEligibleSelected = eligibleLineIds.length > 0 && selectedEligibleLineIds.length === eligibleLineIds.length;

  useEffect(() => {
    const visibleLineIds = new Set(draftLines.map((line) => line.id));
    setSelectedLineIds((prev) => prev.filter((lineId) => visibleLineIds.has(lineId)));
  }, [draftLines]);

  const toggleLineSelection = (lineId: string) => {
    setSelectedLineIds((prev) => prev.includes(lineId) ? prev.filter((item) => item !== lineId) : [...prev, lineId]);
  };

  const toggleAllEligible = () => {
    setSelectedLineIds((prev) => allEligibleSelected ? prev.filter((lineId) => !eligibleLineIds.includes(lineId)) : Array.from(new Set([...prev, ...eligibleLineIds])));
  };

  const runGeneration = async (scope: "selection" | "eligible") => {
    const generation = await generateLines(list ? { ...list, lines: draftLines } : null, scope, scope === "selection" ? selectedLineIds : []);
    if (generation) await refresh();
  };

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
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={() => runGeneration("eligible")} disabled={saving || generating || !list} aria-label="生成全部待生成生产行">{generating ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 全部待生成</button>
          <button className="px-3 py-1.5 rounded border border-accent/40 text-accent text-xs hover:bg-accent-muted disabled:opacity-50 flex items-center gap-1" onClick={() => runGeneration("selection")} disabled={saving || generating || !list} aria-label="生成选中的生产行"><Play size={13} /> 生成选中</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={refresh} disabled={saving || validating || generating} aria-label="刷新生产列表"><RefreshCw size={13} /> 刷新</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={() => validateRemote()} disabled={saving || validating || generating} aria-label="校验生产列表">{validating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 校验</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={addLine} disabled={saving || generating} aria-label="新增生产行"><Plus size={13} /> 新增行</button>
          <button className="px-4 py-1.5 rounded bg-accent text-bg-base text-xs font-semibold hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1" onClick={save} disabled={saving || generating || !list} aria-label="保存生产列表">{saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存</button>
        </div>
      </header>

      {(error || saveMessage || generationMessage) && (
        <div role={error || generationTone === "error" ? "alert" : "status"} aria-live={error || generationTone === "error" ? "assertive" : "polite"} className={`mx-4 mt-3 px-3 py-2 rounded border text-xs flex items-center gap-2 ${error || generationTone === "error" ? "bg-error-muted border-error/20 text-error" : generationTone === "warning" ? "bg-warning-muted border-warning/20 text-warning" : "bg-success-muted border-success/20 text-success"}`}>
          {error ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
          {error || generationMessage || saveMessage}
        </div>
      )}

      {generationResult && <GenerationResultSummary result={generationResult} />}

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
                <Th className="w-16"><input type="checkbox" className="accent-accent" checked={allEligibleSelected} onChange={toggleAllEligible} aria-label="选择全部可生成生产行" disabled={saving || generating || eligibleLineIds.length === 0} /> #</Th>
                <Th className="w-[360px]">Transcript</Th>
                <Th className="w-40">Voice</Th>
                <Th className="w-64">Model</Th>
                <Th className="w-28">Format</Th>
                <Th className="w-48">Director Profile</Th>
                <Th>Notes</Th>
                <Th className="w-44">Generation</Th>
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
                  selected={selectedLineIds.includes(line.id)}
                  result={resultByLineId.get(line.id)}
                  disabled={saving || generating}
                  onToggleSelected={() => toggleLineSelection(line.id)}
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
        <span>已选 {selectedLineIds.length} 条，可生成 {eligibleLineIds.length} 条；保存使用服务端 expectedVersion 防止覆盖他人修改。</span>
        <span>{phase === "conflict" ? "发现版本冲突" : generating ? "正在生成生产行" : "生产控制台就绪"}</span>
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

function ProductionRow({ line, index, voices, directorProfiles, issues, selected, result, disabled, onToggleSelected, onChange, onDelete, onExecute }: {
  line: VoiceLine;
  index: number;
  voices: string[];
  directorProfiles: DirectorProfile[];
  issues: string[];
  selected: boolean;
  result?: LineGenerationResult;
  disabled: boolean;
  onToggleSelected: () => void;
  onChange: (patch: Partial<VoiceLine>) => void;
  onDelete: () => void;
  onExecute?: () => void | Promise<void>;
}) {
  const generationStatus = getLineGenerationStatus(line);
  const rowLocked = generationStatus === "running" || generationStatus === "pending";
  const canSelect = isGeneratableVoiceLine(line);
  return (
    <tr aria-selected={selected} className={`border-b border-border-subtle hover:bg-bg-hover/60 ${selected ? "bg-accent-muted/30" : issues.length ? "bg-warning-muted/20" : ""} ${rowLocked ? "opacity-80" : ""}`}>
      <Td className="text-text-tertiary font-mono"><label className="flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={selected} onChange={onToggleSelected} disabled={disabled || !canSelect} aria-label={`选择第 ${index + 1} 行用于生成`} />{String(index + 1).padStart(2, "0")}</label></Td>
      <Td>
        <textarea className="w-full h-16 bg-bg-base border border-border rounded p-2 text-xs outline-none resize-none focus:border-border-focus" value={line.transcript} onChange={(event) => onChange({ transcript: event.target.value })} disabled={disabled || rowLocked} placeholder="输入该行台词" />
        {issues.length > 0 && <div className="mt-1 text-[10px] text-warning">{issues.join("；")}</div>}
      </Td>
      <Td><select className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={line.voice} onChange={(event) => onChange({ voice: event.target.value })} disabled={disabled || rowLocked}>{voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></Td>
      <Td><input className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus font-mono" value={line.model} onChange={(event) => onChange({ model: event.target.value })} disabled={disabled || rowLocked} /></Td>
      <Td><select className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus font-mono" value={line.responseFormat} onChange={(event) => onChange({ responseFormat: event.target.value as ResponseFormat })} disabled={disabled || rowLocked}>{FORMAT_OPTIONS.map((format) => <option key={format} value={format}>{format}</option>)}</select></Td>
      <Td><select className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={line.directorProfileId ?? ""} onChange={(event) => onChange({ directorProfileId: event.target.value || null })} disabled={disabled || rowLocked}><option value="">无</option>{directorProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Td>
      <Td><input className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={line.notes ?? ""} onChange={(event) => onChange({ notes: event.target.value })} disabled={disabled || rowLocked} placeholder="制片备注" /></Td>
      <Td><GenerationStatusBadge status={generationStatus} jobId={line.relatedJobId} assetId={line.relatedAssetId} result={result} line={line} /></Td>
      <Td>
        <div className="flex items-center gap-1">
          <button className="p-1.5 rounded border border-border text-text-secondary hover:text-accent hover:bg-bg-sunken disabled:opacity-50" onClick={onExecute} disabled={disabled || rowLocked || !onExecute || !line.transcript.trim()} title="行级 Agent 执行" aria-label={`对第 ${index + 1} 行执行 Agent 操作`}><CheckCircle2 size={13} /></button>
          <button className="p-1.5 rounded border border-border text-text-secondary hover:text-error hover:bg-error-muted disabled:opacity-50" onClick={onDelete} disabled={disabled || rowLocked} title="删除行" aria-label={`删除第 ${index + 1} 行`}><Trash2 size={13} /></button>
        </div>
      </Td>
    </tr>
  );
}

function GenerationResultSummary({ result }: { result: { requestedCount: number; succeededCount: number; failedCount: number; skippedCount: number } }) {
  return (
    <div className="mx-4 mt-3 grid grid-cols-4 border border-border-subtle bg-bg-sunken text-[10px] text-text-secondary">
      <Metric label="请求" value={result.requestedCount} />
      <Metric label="成功" value={result.succeededCount} tone="success" />
      <Metric label="失败" value={result.failedCount} tone={result.failedCount > 0 ? "error" : undefined} />
      <Metric label="跳过" value={result.skippedCount} />
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "error" }) {
  return <div className="px-3 py-2 border-r border-border-subtle last:border-r-0"><span className="text-text-tertiary">{label}</span><span className={`ml-2 font-mono ${tone === "success" ? "text-success" : tone === "error" ? "text-error" : "text-text-secondary"}`}>{value}</span></div>;
}

function GenerationStatusBadge({ status, jobId, assetId, result, line }: { status: LineGenerationStatus; jobId?: string | null; assetId?: number | null; result?: LineGenerationResult; line?: VoiceLine }) {
  const style = status === "succeeded" ? "bg-success-muted border-success/20 text-success" : status === "failed" ? "bg-error-muted border-error/20 text-error" : status === "running" || status === "pending" ? "bg-accent-muted border-accent/20 text-accent" : status === "ready" || status === "needs_revision" ? "bg-warning-muted border-warning/20 text-warning" : "bg-bg-base border-border text-text-tertiary";
  const icon = status === "succeeded" ? <CheckCircle2 size={12} /> : status === "failed" ? <XCircle size={12} /> : status === "running" || status === "pending" ? <Loader2 size={12} className="animate-spin" /> : <Circle size={12} />;
  // Only use persisted error fields when status is "failed" to avoid showing
  // stale errors from a previous failure on lines that have since succeeded.
  const errorMessage = result?.errorMessage ?? (status === "failed" ? line?.generationErrorMessage : null) ?? null;
  const errorCode = result?.errorCode ?? (status === "failed" ? line?.generationErrorCode : null) ?? null;
  const message = errorMessage ?? errorCode ?? (jobId ? `job ${jobId}` : assetId ? `asset ${assetId}` : "未生成");
  return (
    <div className="flex flex-col gap-1" title={message}>
      <span className={`inline-flex w-fit items-center gap-1 rounded border px-2 py-1 font-mono ${style}`}>{icon}{status}</span>
      {status === "failed" && errorMessage && (
        <span className="truncate text-[10px] text-error font-mono" title={errorMessage}>{errorMessage.length > 40 ? `${errorMessage.slice(0, 40)}...` : errorMessage}</span>
      )}
      {status !== "failed" && (
        <span className="truncate text-[10px] text-text-tertiary font-mono">{assetId ? `asset ${assetId}` : jobId ? `job ${jobId.slice(0, 10)}` : result?.status ?? "--"}</span>
      )}
    </div>
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
