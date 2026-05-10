import { AlertCircle, CheckCircle2, Circle, Copy, Download, FileWarning, Loader2, Lock, PanelBottomOpen, Play, Plus, RefreshCw, Save, Scissors, Square, Trash2, Wand2, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../../state/AppContext";
import { useProductionList } from "../../hooks/useProductionList";
import { getLineGenerationStatus, isGeneratableVoiceLine, useProductionGeneration } from "../../hooks/useProductionGeneration";
import { taskApi } from "../../services/httpAdapter";
import { ProductionListP1Panel } from "./ProductionListP1Panel";
import type { DirectorProfile, LineGenerationResult, LineGenerationStatus, ProductionListValidationReport, ResponseFormat, ValidationIssue, VoiceLine } from "../../types";

const FORMAT_OPTIONS: ResponseFormat[] = ["wav", "pcm", "mp3"];
const MAX_TRANSCRIPT_CHARS = 5000;
const CONTROL_CLASS = "w-full bg-bg-base border border-border rounded px-2 py-1.5 text-xs text-text-primary outline-none focus:border-border-focus resize-none disabled:opacity-60";
const AUDIO_ENDPOINT_PREFIX = "/api/audio/";

type ProductionListController = ReturnType<typeof useProductionList>;

type ProfileBindingInfo = {
  count: number;
  lineIds: string[];
  lineNumbers: number[];
};

interface ProductionListEditorProps {
  taskId: string;
  directorProfiles?: DirectorProfile[];
  selectedLineIds?: string[];
  onSelectedLineIdsChange?: (ids: string[]) => void;
  onExecuteLine?: (lineId: string, buttonKey?: string) => void | Promise<void>;
  controller?: ProductionListController;
}

export function ProductionListEditor(props: ProductionListEditorProps) {
  const controller = useProductionList(props.taskId);
  return <ProductionListEditorView {...props} controller={props.controller ?? controller} />;
}

export function ProductionListEditorView({ taskId, directorProfiles = [], selectedLineIds, onSelectedLineIdsChange, onExecuteLine, controller }: ProductionListEditorProps & { controller: ProductionListController }) {
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
    updateLines,
    replaceLines,
    addLine,
    deleteLine,
    validateRemote,
    save,
    refresh,
    discardLocal,
    clearConflict,
  } = controller;
  const { generating, result: generationResult, message: generationMessage, tone: generationTone, generateLines } = useProductionGeneration(taskId);
  const [internalSelected, setInternalSelected] = useState<string[]>([]);
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showP1, setShowP1] = useState(false);
  const [bulkProfileId, setBulkProfileId] = useState("");
  const [bulkVoice, setBulkVoice] = useState(settings.defaultVoice || "Zephyr");
  const [lineCloneMessage, setLineCloneMessage] = useState<string | null>(null);
  const [lineCloneError, setLineCloneError] = useState<string | null>(null);

  const selectedIds = selectedLineIds ?? internalSelected;
  const setSelectedIds = onSelectedLineIdsChange ?? setInternalSelected;
  const voiceOptions = useMemo(() => voices.length > 0 ? voices.map((voice) => voice.name) : [settings.defaultVoice || "Zephyr", "Puck", "Kore"], [settings.defaultVoice, voices]);
  const localReport = useMemo(() => buildLocalIssues(draftLines), [draftLines]);
  const mergedIssues = useMemo(() => mergeIssues(localReport.issues, validationReport?.issues ?? []), [localReport, validationReport]);
  const issueMap = useMemo(() => groupIssuesByLine(mergedIssues), [mergedIssues]);
  const validationSummary = useMemo(() => ({
    errorCount: mergedIssues.filter((issue) => issue.severity === "error").length,
    warningCount: mergedIssues.filter((issue) => issue.severity === "warning").length,
  }), [mergedIssues]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const resultByLineId = useMemo(() => new Map(generationResult?.results.map((item) => [item.lineId, item]) ?? []), [generationResult]);
  const localDraftText = JSON.stringify({ lines: draftLines }, null, 2);
  const selectedLines = useMemo(() => draftLines.filter((line) => selectedSet.has(line.id)), [draftLines, selectedSet]);
  const selectedEligible = useMemo(() => selectedLines.filter(isGeneratableVoiceLine), [selectedLines]);
  const allSelected = draftLines.length > 0 && selectedIds.length === draftLines.length;
  const profileBindingMap = useMemo(() => buildProfileBindingMap(draftLines), [draftLines]);

  useEffect(() => {
    const visibleLineIds = new Set(draftLines.map((line) => line.id));
    const next = selectedIds.filter((lineId) => visibleLineIds.has(lineId));
    if (next.length !== selectedIds.length) setSelectedIds(next);
  }, [draftLines, selectedIds, setSelectedIds]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!saving && !generating && list) void save();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [generating, list, save, saving]);

  const toggleLineSelection = (lineId: string) => {
    setSelectedIds(selectedSet.has(lineId) ? selectedIds.filter((item) => item !== lineId) : [...selectedIds, lineId]);
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : draftLines.map((line) => line.id));
  };

  const runGeneration = async (scope: "selection" | "eligible") => {
    const generation = await generateLines(list ? { ...list, lines: draftLines } : null, scope, scope === "selection" ? selectedIds : []);
    if (generation) await refresh();
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(localDraftText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const bindProfileToSelected = () => {
    if (!bulkProfileId || selectedIds.length === 0) return;
    updateLines(selectedIds, { directorProfileId: bulkProfileId, promptProfileId: bulkProfileId });
  };

  const bindVoiceToSelected = () => {
    if (!bulkVoice || selectedIds.length === 0) return;
    updateLines(selectedIds, { voice: bulkVoice });
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    const confirmed = window.confirm(`确认删除选中的 ${selectedIds.length} 条生产行？删除会先进入草稿，点击保存后才写入服务端。`);
    if (!confirmed) return;
    const selected = new Set(selectedIds);
    replaceLines((lines) => lines.filter((line) => !selected.has(line.id)));
    setSelectedIds([]);
    if (expandedLineId && selected.has(expandedLineId)) setExpandedLineId(null);
  };

  const duplicateProfileForLine = async (line: VoiceLine) => {
    const profileId = line.promptProfileId ?? line.directorProfileId;
    const source = directorProfiles.find((profile) => profile.id === profileId);
    if (!source) {
      setLineCloneError("当前行尚未绑定可复制的导演配置");
      return;
    }
    setLineCloneError(null);
    setLineCloneMessage(null);
    try {
      const saved = await taskApi.createDirectorProfile(taskId, {
        source: "global",
        name: `${source.name} - 独立副本 ${String(line.sortOrder).padStart(2, "0")}`,
        audioProfile: source.audioProfile,
        scene: source.scene,
        directorNotes: source.directorNotes,
        style: source.style,
        pacing: source.pacing,
        accent: source.accent,
        emotion: source.emotion,
        performanceNotes: source.performanceNotes,
        sampleContext: source.sampleContext,
        speakers: source.speakers.map((speaker) => ({ ...speaker })),
      });
      updateLine(line.id, { directorProfileId: saved.id, promptProfileId: saved.id });
      setLineCloneMessage("新导演配置已创建；当前行绑定仍是未保存的生产列表草稿，请点击保存生产列表。刷新导演配置后可在配置页查看副本。");
    } catch (err) {
      setLineCloneError(err instanceof Error ? err.message : "复制独立配置失败");
    }
  };

  if (loading && draftLines.length === 0) {
    return <ProductionListSkeleton />;
  }

  return (
    <section className="h-full min-h-0 min-w-0 overflow-hidden flex flex-col border border-border-subtle bg-bg-surface relative">
      <header className="shrink-0 px-4 py-3 [@media(max-height:760px)]:py-2 border-b border-border-subtle bg-bg-sunken/60 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">生产列表编辑器</div>
          <div className="text-[10px] text-text-tertiary font-mono">v{list?.version ?? "--"} · {draftLines.length} 行 · Ctrl+S 保存 · expectedVersion 写入</div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={() => void runGeneration("eligible")} disabled={saving || generating || !list}><Play size={13} /> 全部待生成</button>
          <button className="px-3 py-1.5 rounded border border-accent/40 text-accent text-xs hover:bg-accent-muted disabled:opacity-50 flex items-center gap-1" onClick={() => void runGeneration("selection")} disabled={saving || generating || !list || selectedIds.length === 0}><Play size={13} /> 生成选中</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={() => void refresh()} disabled={saving || validating || generating}><RefreshCw size={13} /> 刷新</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={() => void validateRemote()} disabled={saving || validating || generating}>{validating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 校验</button>
          <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={addLine} disabled={saving || generating}><Plus size={13} /> 新增行</button>
          <button className="px-4 py-1.5 rounded bg-accent text-bg-base text-xs font-semibold hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1" onClick={() => void save()} disabled={saving || generating || !list}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存</button>
        </div>
      </header>

      {(error || saveMessage || generationMessage || lineCloneMessage || lineCloneError) && (
        <Notice
          tone={error || lineCloneError || generationTone === "error" ? "error" : generationTone === "warning" ? "warning" : "success"}
          text={error || lineCloneError || generationMessage || lineCloneMessage || saveMessage || ""}
        />
      )}

      <div className="shrink-0 px-4 py-2 [@media(max-height:760px)]:py-1.5 border-b border-border-subtle bg-bg-base flex flex-wrap items-center justify-between gap-3 text-[10px]">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-success">valid {Math.max(0, draftLines.length - validationSummary.errorCount - validationSummary.warningCount)}</span>
          <span className="text-warning">warning {validationSummary.warningCount}</span>
          <span className="text-error">error {validationSummary.errorCount}</span>
          <span className="text-text-tertiary">选中 {selectedIds.length} 条，可生成 {selectedEligible.length} 条</span>
        </div>
        <button className="text-accent hover:text-accent-hover flex items-center gap-1" onClick={() => setShowP1((prev) => !prev)}><PanelBottomOpen size={12} /> 版本历史 / 导入导出 / 质量报告</button>
      </div>

      {generationResult && <GenerationResultSummary result={generationResult} />}
      {showP1 && list && <div className="shrink-0 max-h-[min(32vh,360px)] overflow-auto border-b border-border-subtle"><ProductionListP1Panel taskId={taskId} currentVersion={list.version} disabled={saving || generating} onChanged={refresh} /></div>}

      <div className="flex-1 min-h-0 min-w-0 overflow-auto overscroll-contain">
        {draftLines.length === 0 ? (
          <PanelState icon={<Plus size={18} />} title="暂无生产行" hint="点击新增行创建第一条语音台词，或在右侧 Agent 面板执行 Normalize。" />
        ) : (
          <table className="w-full min-w-[1120px] min-[1200px]:min-w-[1240px] min-[1440px]:min-w-[1360px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-bg-sunken text-text-tertiary border-b border-border-subtle">
              <tr>
                <Th className="w-16"><label className="flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={allSelected} onChange={toggleAll} disabled={saving || generating} /> #</label></Th>
                <Th className="w-28">模块</Th>
                <Th className="w-40">标题</Th>
                <Th className="w-28">角色</Th>
                <Th>语音文本</Th>
                <Th className="w-48">行级风格</Th>
                <Th className="w-32">音色</Th>
                <Th className="w-36">导演</Th>
                <Th className="w-36">状态</Th>
                <Th className="w-28">操作</Th>
              </tr>
            </thead>
            <tbody>
              {draftLines.map((line, index) => {
                const issues = issueMap.get(line.id) ?? [];
                return (
                  <ProductionRow
                    key={line.id}
                    line={line}
                    index={index}
                    voices={voiceOptions}
                    directorProfiles={directorProfiles}
                    profileBindingMap={profileBindingMap}
                    issues={issues}
                    selected={selectedSet.has(line.id)}
                    result={resultByLineId.get(line.id)}
                    disabled={saving || generating}
                    expanded={expandedLineId === line.id}
                    onToggleSelected={() => toggleLineSelection(line.id)}
                    onToggleExpanded={() => setExpandedLineId((prev) => prev === line.id ? null : line.id)}
                    onChange={(patch) => updateLine(line.id, patch)}
                    onDelete={() => deleteLine(line.id)}
                    onExecute={onExecuteLine ? async (buttonKey) => { await onExecuteLine(line.id, buttonKey); await refresh(); } : undefined}
                    onDuplicateProfile={() => void duplicateProfileForLine(line)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <BulkActionBar
        selectedCount={selectedIds.length}
        directorProfiles={directorProfiles}
        voices={voiceOptions}
        bulkProfileId={bulkProfileId}
        bulkVoice={bulkVoice}
        disabled={saving || generating || selectedIds.length === 0}
        generating={generating}
        onProfileChange={setBulkProfileId}
        onVoiceChange={setBulkVoice}
        onBindProfile={bindProfileToSelected}
        onBindVoice={bindVoiceToSelected}
        onGenerate={() => void runGeneration("selection")}
        onDelete={deleteSelected}
        onClear={() => setSelectedIds([])}
      />

      {conflictError && (
        <div className="absolute inset-0 z-30 bg-bg-base/70 backdrop-blur-sm flex items-center justify-center">
          <div className="w-[560px] border border-warning/30 bg-bg-elevated shadow-shadow-lg rounded-lg p-5 flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-warning shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-text-primary">版本冲突，未覆盖服务端数据</h3>
                <p className="text-xs text-text-secondary mt-1">你编辑的版本与服务器当前版本不一致。请先复制本地草稿，再刷新或丢弃本地修改。</p>
                <p className="text-[10px] text-warning mt-2">{conflictError.message}</p>
              </div>
            </div>
            <textarea className="h-32 bg-bg-sunken border border-border rounded p-2 text-[10px] font-mono text-text-tertiary" readOnly value={localDraftText} />
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover flex items-center gap-1" onClick={() => void copyDraft()}><Copy size={12} /> {copied ? "已复制" : "复制草稿"}</button>
              <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover" onClick={() => { clearConflict(); void refresh(); }}>刷新服务端</button>
              <button className="px-3 py-1.5 rounded bg-warning text-bg-base text-xs font-semibold" onClick={discardLocal}>丢弃本地</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProductionRow({ line, index, voices, directorProfiles, profileBindingMap, issues, selected, result, disabled, expanded, onToggleSelected, onToggleExpanded, onChange, onDelete, onExecute, onDuplicateProfile }: {
  line: VoiceLine;
  index: number;
  voices: string[];
  directorProfiles: DirectorProfile[];
  profileBindingMap: Map<string, ProfileBindingInfo>;
  issues: ValidationIssue[];
  selected: boolean;
  result?: LineGenerationResult;
  disabled: boolean;
  expanded: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<VoiceLine>) => void;
  onDelete: () => void;
  onExecute?: (buttonKey?: string) => void | Promise<void>;
  onDuplicateProfile: () => void;
}) {
  const generationStatus = getLineGenerationStatus(line);
  const rowLocked = generationStatus === "running" || generationStatus === "pending";
  const hasError = issues.some((issue) => issue.severity === "error");
  const hasWarning = !hasError && issues.some((issue) => issue.severity === "warning");
  const toneClass = rowLocked ? "border-l-[3px] border-l-accent bg-accent-muted/20" : hasError ? "border-l-[3px] border-l-error" : hasWarning ? "border-l-[3px] border-l-warning" : selected ? "border-l-[3px] border-l-accent" : "border-l-[3px] border-l-transparent";
  const currentProfileId = line.promptProfileId ?? line.directorProfileId ?? "";
  const currentProfile = directorProfiles.find((profile) => profile.id === currentProfileId);
  const charCount = line.transcript.length;

  return (
    <>
      <tr aria-selected={selected} className={`border-b border-border-subtle hover:bg-bg-hover/60 ${selected ? "bg-accent-muted/30" : ""} ${toneClass}`}>
        <Td className="text-text-tertiary font-mono"><label className="flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={selected} onChange={onToggleSelected} disabled={disabled} aria-label={`选择第 ${index + 1} 行`} />{rowLocked && <LockIcon />} {String(index + 1).padStart(2, "0")}</label></Td>
        <Td><ShortInput value={line.moduleName ?? ""} onChange={(value) => onChange({ moduleName: value })} disabled={disabled || rowLocked} placeholder="未分组" /></Td>
        <Td><ShortInput value={line.title ?? ""} onChange={(value) => onChange({ title: value })} disabled={disabled || rowLocked} placeholder={line.transcript.slice(0, 18) || "标题"} /></Td>
        <Td><ShortInput value={line.speakerLabel ?? ""} onChange={(value) => onChange({ speakerLabel: value })} disabled={disabled || rowLocked} placeholder="Narrator" /></Td>
        <Td><div className="truncate text-text-secondary max-w-[280px] min-[1200px]:max-w-[360px] min-[1440px]:max-w-[420px]" title={line.transcript}>{line.transcript || <span className="text-text-tertiary">待填写台词</span>}</div><div className={`mt-1 text-[10px] ${charCount > MAX_TRANSCRIPT_CHARS ? "text-warning" : "text-text-tertiary"}`}>{charCount}/{MAX_TRANSCRIPT_CHARS} 字符</div></Td>
        <Td><LineStyleSummary value={line.style} /></Td>
        <Td><select className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={line.voice} onChange={(event) => onChange({ voice: event.target.value })} disabled={disabled || rowLocked}>{voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></Td>
        <Td><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${currentProfileId ? "bg-success" : "bg-error"}`} /><span className="truncate" title={currentProfile?.name ?? "未绑定"}>{currentProfile?.name ?? "未绑定"}</span></div></Td>
        <Td><StatusStack status={generationStatus} issues={issues} result={result} line={line} /></Td>
        <Td><div className="flex items-center gap-1"><button className="p-1.5 rounded border border-border hover:bg-bg-hover" onClick={onToggleExpanded} title={expanded ? "收起详情" : "展开详情"}><PanelBottomOpen size={13} /></button><button className="p-1.5 rounded border border-border text-error hover:bg-error-muted disabled:opacity-50" onClick={onDelete} disabled={disabled || rowLocked} title="删除行"><Trash2 size={13} /></button></div></Td>
      </tr>
      {expanded && (
        <tr className="border-b border-border-subtle bg-bg-base">
          <td colSpan={10} className="p-0">
            <LineDetailPanel
              line={line}
              voices={voices}
              directorProfiles={directorProfiles}
              profileBindingMap={profileBindingMap}
              issues={issues}
              result={result}
              rowLocked={rowLocked}
              disabled={disabled}
              onChange={onChange}
              onExecute={onExecute}
              onDuplicateProfile={onDuplicateProfile}
              onClose={onToggleExpanded}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function LineDetailPanel({ line, voices, directorProfiles, profileBindingMap, issues, result, rowLocked, disabled, onChange, onExecute, onDuplicateProfile, onClose }: {
  line: VoiceLine;
  voices: string[];
  directorProfiles: DirectorProfile[];
  profileBindingMap: Map<string, ProfileBindingInfo>;
  issues: ValidationIssue[];
  result?: LineGenerationResult;
  rowLocked: boolean;
  disabled: boolean;
  onChange: (patch: Partial<VoiceLine>) => void;
  onExecute?: (buttonKey?: string) => void | Promise<void>;
  onDuplicateProfile: () => void;
  onClose: () => void;
}) {
  const currentProfileId = line.promptProfileId ?? line.directorProfileId ?? "";
  const currentProfile = directorProfiles.find((profile) => profile.id === currentProfileId);
  const sharedBinding = currentProfileId ? profileBindingMap.get(currentProfileId) ?? null : null;
  const editDisabled = disabled || rowLocked;
  return (
    <div className="min-w-0 p-4 [@media(max-height:760px)]:p-3 border-l-[3px] border-l-accent bg-[linear-gradient(90deg,rgba(201,148,74,0.06),transparent_28%),var(--color-bg-base)]">
      <div className="grid min-w-0 grid-cols-1 min-[1200px]:grid-cols-[minmax(360px,1.3fr)_minmax(280px,0.7fr)] min-[1440px]:grid-cols-[minmax(420px,1.3fr)_minmax(320px,0.7fr)] gap-4">
        <section className="grid grid-cols-2 gap-3 content-start">
          <Field label="语音文本" className="col-span-2"><textarea className={`${CONTROL_CLASS} h-28`} value={line.transcript} onChange={(event) => onChange({ transcript: event.target.value })} disabled={editDisabled} /></Field>
          <Field label="模块"><input className={CONTROL_CLASS} value={line.moduleName ?? ""} onChange={(event) => onChange({ moduleName: event.target.value })} disabled={editDisabled} /></Field>
          <Field label="标题"><input className={CONTROL_CLASS} value={line.title ?? ""} onChange={(event) => onChange({ title: event.target.value })} disabled={editDisabled} /></Field>
          <Field label="角色"><input className={CONTROL_CLASS} value={line.speakerLabel ?? ""} onChange={(event) => onChange({ speakerLabel: event.target.value })} disabled={editDisabled} /></Field>
          <Field label="音色"><select className={CONTROL_CLASS} value={line.voice} onChange={(event) => onChange({ voice: event.target.value })} disabled={editDisabled}>{voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></Field>
          <Field label="模型"><input className={`${CONTROL_CLASS} font-mono`} value={line.model} onChange={(event) => onChange({ model: event.target.value })} disabled={editDisabled} /></Field>
          <Field label="格式"><select className={`${CONTROL_CLASS} font-mono`} value={line.responseFormat} onChange={(event) => onChange({ responseFormat: event.target.value as ResponseFormat })} disabled={editDisabled}>{FORMAT_OPTIONS.map((format) => <option key={format} value={format}>{format}</option>)}</select></Field>
          <Field label="行级风格" className="col-span-2">
            <textarea
              className={`${CONTROL_CLASS} h-16`}
              value={line.style ?? ""}
              onChange={(event) => onChange({ style: event.target.value })}
              disabled={editDisabled}
              placeholder="未设置，使用导演配置/角色风格"
            />
            <span className="text-[10px] text-text-tertiary">仅保存到 style 字段；制作备注请写入下方备注，不会互相回填。</span>
          </Field>
          <Field label="备注" className="col-span-2"><textarea className={`${CONTROL_CLASS} h-16`} value={line.notes ?? ""} onChange={(event) => onChange({ notes: event.target.value })} disabled={editDisabled} placeholder="制作备注，不作为行级风格" /></Field>
          <div className={`col-span-2 text-[10px] ${line.transcript.length > MAX_TRANSCRIPT_CHARS ? "text-warning" : "text-text-tertiary"}`}>字符数 {line.transcript.length}/{MAX_TRANSCRIPT_CHARS}</div>
        </section>

        <section className="flex flex-col gap-3">
          <InfoCard title="导演绑定">
            <select className={CONTROL_CLASS} value={currentProfileId} onChange={(event) => onChange({ directorProfileId: event.target.value || null, promptProfileId: event.target.value || null })} disabled={editDisabled}>
              <option value="">未绑定导演配置</option>
              {directorProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            {currentProfile ? <p className="mt-2 text-[10px] text-text-secondary">当前配置：{currentProfile.name} · {currentProfile.source === "production-list" ? "生产列表配置" : "全局配置"}</p> : <p className="mt-2 text-[10px] text-warning">未绑定导演配置，校验和生成可能失败。</p>}
            {sharedBinding && <p className="mt-2 text-[10px] text-text-secondary">该配置当前绑定 {sharedBinding.count} 行，行号：{sharedBinding.lineNumbers.map((lineNumber) => String(lineNumber).padStart(2, "0")).join(", ")}。</p>}
            {currentProfile && <button className="mt-2 px-2 py-1 rounded border border-border text-[10px] hover:bg-bg-hover disabled:opacity-50" onClick={onDuplicateProfile} disabled={editDisabled}>复制为该行独立配置</button>}
            {sharedBinding && sharedBinding.count > 1 && <p className="mt-2 text-[10px] text-warning">该配置被 {sharedBinding.count} 条语音共享；如仅修改本行，建议先复制为该行独立配置。</p>}
          </InfoCard>
          <InfoCard title="校验问题">
            {issues.length === 0 ? <p className="text-[10px] text-success">当前行没有本地或远端校验问题。</p> : <div className="space-y-1">{issues.map((issue, index) => <div key={`${issue.field}-${index}`} className={`px-2 py-1 border text-[10px] ${issue.severity === "error" ? "border-error/20 bg-error-muted/30 text-error" : "border-warning/20 bg-warning-muted/30 text-warning"}`}>{issue.severity} · {issue.field ?? "line"}: {issue.message}</div>)}</div>}
          </InfoCard>
          <InfoCard title="生成状态">
            <StatusStack status={getLineGenerationStatus(line)} issues={[]} result={result} line={line} />
          </InfoCard>
          <InfoCard title="行级 Agent 按钮">
            <div className="grid grid-cols-3 gap-2">
              <AgentSmallButton label="重写" icon={<Wand2 size={12} />} disabled={!onExecute || rowLocked} onClick={() => void onExecute?.("rewrite")} />
              <AgentSmallButton label="缩短" icon={<Scissors size={12} />} disabled={!onExecute || rowLocked} onClick={() => void onExecute?.("shorten")} />
              <AgentSmallButton label="拆分" icon={<FileWarning size={12} />} disabled title="后端未提供真实拆分按钮时不可伪造" onClick={() => undefined} />
            </div>
          </InfoCard>
          <button className="self-end px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover" onClick={onClose}>收起详情</button>
        </section>
      </div>
    </div>
  );
}

function BulkActionBar({ selectedCount, directorProfiles, voices, bulkProfileId, bulkVoice, disabled, generating, onProfileChange, onVoiceChange, onBindProfile, onBindVoice, onGenerate, onDelete, onClear }: {
  selectedCount: number;
  directorProfiles: DirectorProfile[];
  voices: string[];
  bulkProfileId: string;
  bulkVoice: string;
  disabled: boolean;
  generating: boolean;
  onProfileChange: (value: string) => void;
  onVoiceChange: (value: string) => void;
  onBindProfile: () => void;
  onBindVoice: () => void;
  onGenerate: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <footer className="shrink-0 max-h-24 min-h-12 overflow-y-auto px-4 py-2 border-t border-border-subtle bg-bg-sunken flex flex-wrap items-center gap-2 text-xs">
      <span className="mr-2 text-text-secondary">已选 {selectedCount} 条</span>
      <select className="h-8 min-w-0 max-w-[220px] bg-bg-base border border-border rounded px-2 text-xs" value={bulkProfileId} onChange={(event) => onProfileChange(event.target.value)} disabled={disabled || directorProfiles.length === 0}><option value="">选择导演配置</option>{directorProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>
      <button className="px-3 h-8 rounded border border-border hover:bg-bg-hover disabled:opacity-50" onClick={onBindProfile} disabled={disabled || !bulkProfileId}>批量绑定导演</button>
      <select className="h-8 min-w-0 max-w-[180px] bg-bg-base border border-border rounded px-2 text-xs" value={bulkVoice} onChange={(event) => onVoiceChange(event.target.value)} disabled={disabled}>{voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select>
      <button className="px-3 h-8 rounded border border-border hover:bg-bg-hover disabled:opacity-50" onClick={onBindVoice} disabled={disabled || !bulkVoice}>批量修改音色</button>
      <button className="px-3 h-8 rounded border border-accent/40 text-accent hover:bg-accent-muted disabled:opacity-50 flex items-center gap-1" onClick={onGenerate} disabled={disabled || generating}>{generating ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 批量提交生成</button>
      <button className="px-3 h-8 rounded border border-error/30 text-error hover:bg-error-muted disabled:opacity-50" onClick={onDelete} disabled={disabled}>批量删除</button>
      <button className="px-3 h-8 rounded border border-border hover:bg-bg-hover disabled:opacity-50" onClick={onClear} disabled={selectedCount === 0}>清除选择</button>
      <span className="ml-auto min-w-[220px] text-[10px] text-text-tertiary">批量绑定/改音色/删除仅修改 draft；保存时使用 expectedVersion。</span>
    </footer>
  );
}

function LineStyleSummary({ value }: { value?: string }) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return <span className="inline-flex max-w-full rounded border border-border-subtle bg-bg-sunken px-2 py-1 text-[10px] text-text-tertiary">继承导演配置/角色风格</span>;
  }
  return <span className="block max-w-[180px] truncate rounded border border-accent/20 bg-accent-muted/25 px-2 py-1 text-[10px] text-accent" title={trimmed}>{trimmed}</span>;
}

function StatusStack({ status, issues, result, line }: { status: LineGenerationStatus; issues: ValidationIssue[]; result?: LineGenerationResult; line: VoiceLine }) {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return <div className="flex flex-col gap-1"><ValidationBadge errorCount={errorCount} warningCount={warningCount} /><GenerationStatusBadge status={status} jobId={line.relatedJobId} assetId={line.relatedAssetId} result={result} line={line} /></div>;
}

function ValidationBadge({ errorCount, warningCount }: { errorCount: number; warningCount: number }) {
  if (errorCount > 0) return <span className="inline-flex w-fit items-center gap-1 rounded border border-error/20 bg-error-muted/30 px-2 py-0.5 text-[10px] text-error"><XCircle size={11} /> error {errorCount}</span>;
  if (warningCount > 0) return <span className="inline-flex w-fit items-center gap-1 rounded border border-warning/20 bg-warning-muted/30 px-2 py-0.5 text-[10px] text-warning"><Circle size={11} /> warning {warningCount}</span>;
  return <span className="inline-flex w-fit items-center gap-1 rounded border border-success/20 bg-success-muted/30 px-2 py-0.5 text-[10px] text-success"><CheckCircle2 size={11} /> valid</span>;
}

function GenerationStatusBadge({ status, jobId, assetId, result, line }: { status: LineGenerationStatus; jobId?: string | null; assetId?: number | null; result?: LineGenerationResult; line?: VoiceLine }) {
  const style = status === "succeeded" ? "bg-success-muted border-success/20 text-success" : status === "failed" ? "bg-error-muted border-error/20 text-error" : status === "running" || status === "pending" ? "bg-accent-muted border-accent/20 text-accent" : status === "ready" || status === "needs_revision" ? "bg-warning-muted border-warning/20 text-warning" : "bg-bg-base border-border text-text-tertiary";
  const icon = status === "succeeded" ? <CheckCircle2 size={11} /> : status === "failed" ? <XCircle size={11} /> : status === "running" || status === "pending" ? <Loader2 size={11} className="animate-spin" /> : <Circle size={11} />;
  const errorMessage = result?.errorMessage ?? (status === "failed" ? line?.generationErrorMessage : null) ?? null;
  const errorCode = result?.errorCode ?? (status === "failed" ? line?.generationErrorCode : null) ?? null;
  const audioAccess = resolveGenerationAudioAccess({ status, jobId, assetId, result, line });
  const message = errorMessage ?? errorCode ?? audioAccess.tooltip;
  return (
    <div className="flex w-fit max-w-[210px] flex-col gap-1">
      <span className={`inline-flex w-fit items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-mono ${style}`} title={message}>{icon}{status}</span>
      {status === "succeeded" && (
        audioAccess.hasPlayableAsset ? (
          <AudioAssetControls audioAccess={audioAccess} />
        ) : (
          <span className="inline-flex w-fit items-start gap-1 rounded border border-warning/20 bg-warning-muted/30 px-2 py-1 text-[10px] leading-snug text-warning" role="status" title="generationStatus=succeeded，但后端未返回 relatedAssetId、assetId 或 audioUrl，不能伪造播放入口。">
            <AlertCircle size={11} className="mt-0.5 shrink-0" />
            成功状态缺少音频资产
          </span>
        )
      )}
    </div>
  );
}

type AudioAccessInput = {
  status: LineGenerationStatus;
  jobId?: string | null;
  assetId?: number | null;
  result?: LineGenerationResult;
  line?: VoiceLine;
};

type ResolvedAudioAccess = {
  hasPlayableAsset: boolean;
  audioUrl: string | null;
  downloadUrl: string | null;
  jobId: string | null;
  assetId: number | null;
  tooltip: string;
};

export function resolveGenerationAudioAccess({ status, jobId, assetId, result, line }: AudioAccessInput): ResolvedAudioAccess {
  const resolvedAssetId = firstNumber(result?.assetId, assetId, line?.relatedAssetId);
  const resolvedJobId = result?.jobId ?? jobId ?? line?.relatedJobId ?? null;
  const audioUrl = result?.audioUrl ?? (typeof resolvedAssetId === "number" ? `${AUDIO_ENDPOINT_PREFIX}${encodeURIComponent(String(resolvedAssetId))}` : null);
  const downloadUrl = result?.downloadUrl ?? buildDownloadUrl(resolvedAssetId, audioUrl);
  const metadata = [
    resolvedJobId ? `job ${resolvedJobId}` : null,
    typeof resolvedAssetId === "number" ? `asset ${resolvedAssetId}` : null,
  ].filter(Boolean).join(" · ");

  return {
    hasPlayableAsset: status === "succeeded" && Boolean(audioUrl),
    audioUrl,
    downloadUrl,
    jobId: resolvedJobId,
    assetId: resolvedAssetId,
    tooltip: metadata || (status === "succeeded" ? "成功状态缺少音频资产" : "未生成"),
  };
}

function firstNumber(...values: Array<number | null | undefined>) {
  return values.find((value): value is number => typeof value === "number") ?? null;
}

function buildDownloadUrl(assetId: number | null, audioUrl: string | null) {
  if (typeof assetId === "number") return `${AUDIO_ENDPOINT_PREFIX}${encodeURIComponent(String(assetId))}?download=1`;
  if (audioUrl?.startsWith(AUDIO_ENDPOINT_PREFIX)) {
    const [path] = audioUrl.split("?");
    return `${path}?download=1`;
  }
  return null;
}

function AudioAssetControls({ audioAccess }: { audioAccess: ResolvedAudioAccess }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setPlaying(false);
  };

  const play = () => {
    if (!audioAccess.audioUrl) return;
    if (playing) {
      stop();
      return;
    }
    if (audioRef.current) stop();
    const audio = new Audio(audioAccess.audioUrl);
    audio.addEventListener("ended", () => {
      audioRef.current = null;
      setPlaying(false);
    });
    audio.addEventListener("error", () => {
      audioRef.current = null;
      setPlaying(false);
    });
    audioRef.current = audio;
    setPlaying(true);
    void audio.play().catch(() => {
      audioRef.current = null;
      setPlaying(false);
    });
  };

  const download = () => {
    if (!audioAccess.downloadUrl) return;
    const link = document.createElement("a");
    link.href = audioAccess.downloadUrl;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex flex-col gap-1 rounded border border-success/15 bg-success-muted/15 px-2 py-1" title={audioAccess.tooltip}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded border border-success/25 px-2 text-[10px] text-success hover:bg-success-muted disabled:opacity-50"
          onClick={play}
          disabled={!audioAccess.audioUrl}
          title={playing ? "停止试听" : "试听音频"}
          aria-label={playing ? "停止试听" : "试听音频"}
        >
          {playing ? <Square size={11} /> : <Play size={11} />}
          {playing ? "停止" : "试听"}
        </button>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[10px] text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={download}
          disabled={!audioAccess.downloadUrl}
          title={audioAccess.downloadUrl ? "下载音频" : "缺少可下载的资产 URL"}
          aria-label="下载音频"
        >
          <Download size={11} />
          下载
        </button>
      </div>
      <div className="max-w-[190px] truncate font-mono text-[9px] text-text-tertiary">
        {audioAccess.assetId != null ? `asset ${audioAccess.assetId}` : "asset --"}{audioAccess.jobId ? ` · job ${audioAccess.jobId}` : ""}
      </div>
    </div>
  );
}

function buildLocalIssues(lines: VoiceLine[]): ProductionListValidationReport {
  const issues: ValidationIssue[] = [];
  lines.forEach((line, index) => {
    const row = index + 1;
    if (!line.transcript.trim()) issues.push({ lineId: line.id, field: "transcript", severity: "error", message: `第 ${row} 行缺少语音文本` });
    if (!line.voice.trim()) issues.push({ lineId: line.id, field: "voice", severity: "error", message: `第 ${row} 行缺少音色` });
    if (!line.model.trim()) issues.push({ lineId: line.id, field: "model", severity: "warning", message: `第 ${row} 行未指定模型，将使用服务端默认值` });
    if (line.transcript.length > MAX_TRANSCRIPT_CHARS) issues.push({ lineId: line.id, field: "transcript", severity: "warning", message: `第 ${row} 行超过 ${MAX_TRANSCRIPT_CHARS} 字符` });
    (line.validationErrors ?? []).forEach((message) => issues.push({ lineId: line.id, severity: "error", message }));
  });
  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

function mergeIssues(local: ValidationIssue[], remote: ValidationIssue[]) {
  const seen = new Set<string>();
  return [...local, ...remote].filter((issue) => {
    const key = `${issue.lineId ?? ""}:${issue.field ?? ""}:${issue.severity}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupIssuesByLine(issues: ValidationIssue[]) {
  const map = new Map<string, ValidationIssue[]>();
  issues.forEach((issue) => {
    if (!issue.lineId) return;
    map.set(issue.lineId, [...(map.get(issue.lineId) ?? []), issue]);
  });
  return map;
}

function buildProfileBindingMap(lines: VoiceLine[]) {
  const map = new Map<string, ProfileBindingInfo>();
  lines.forEach((line, index) => {
    const profileId = line.promptProfileId ?? line.directorProfileId;
    if (!profileId) return;
    const current = map.get(profileId) ?? { count: 0, lineIds: [], lineNumbers: [] };
    current.count += 1;
    current.lineIds.push(line.id);
    current.lineNumbers.push(index + 1);
    map.set(profileId, current);
  });
  return map;
}

function ProductionListSkeleton() {
  return <section className="h-full min-h-0 min-w-0 overflow-hidden border border-border-subtle bg-bg-surface p-4"><div className="h-9 w-56 bg-bg-sunken animate-pulse border border-border-subtle" /><div className="mt-4 space-y-2 overflow-hidden">{Array.from({ length: 10 }).map((_, index) => <div key={index} className="h-12 bg-bg-sunken/80 border border-border-subtle animate-pulse" />)}</div></section>;
}

function GenerationResultSummary({ result }: { result: { requestedCount: number; succeededCount: number; failedCount: number; skippedCount: number } }) {
  return <div className="mx-4 mt-3 grid grid-cols-4 border border-border-subtle bg-bg-sunken text-[10px] text-text-secondary"><Metric label="请求" value={result.requestedCount} /><Metric label="成功" value={result.succeededCount} tone="success" /><Metric label="失败" value={result.failedCount} tone={result.failedCount > 0 ? "error" : undefined} /><Metric label="跳过" value={result.skippedCount} /></div>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "error" }) {
  return <div className="px-3 py-2 border-r border-border-subtle last:border-r-0"><span className="text-text-tertiary">{label}</span><span className={`ml-2 font-mono ${tone === "success" ? "text-success" : tone === "error" ? "text-error" : "text-text-secondary"}`}>{value}</span></div>;
}

function LockIcon() { return <Lock size={12} className="text-accent" aria-label="Agent 正在修改此行" />; }
function ShortInput({ value, onChange, disabled, placeholder }: { value: string; onChange: (value: string) => void; disabled?: boolean; placeholder?: string }) { return <input className="w-full h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder={placeholder} />; }
function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <th className={`px-3 py-2 text-left font-semibold border-r border-border-subtle last:border-r-0 ${className}`}>{children}</th>; }
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <td className={`px-3 py-2 align-top border-r border-border-subtle last:border-r-0 ${className}`}>{children}</td>; }
function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) { return <label className={`flex flex-col gap-1.5 text-xs text-text-tertiary ${className}`}><span>{label}</span>{children}</label>; }
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) { return <div className="border border-border-subtle bg-bg-sunken/60 p-3"><div className="mb-2 text-xs font-semibold text-text-primary">{title}</div>{children}</div>; }
function AgentSmallButton({ label, icon, disabled, title, onClick }: { label: string; icon: React.ReactNode; disabled?: boolean; title?: string; onClick: () => void }) { return <button className="px-2 py-1.5 rounded border border-border text-[10px] hover:bg-bg-hover disabled:opacity-50 flex items-center justify-center gap-1" disabled={disabled} title={title ?? (disabled ? "请先确认后端提供真实按钮能力" : label)} onClick={onClick}>{icon}{label}</button>; }
function PanelState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) { return <div className="h-full min-h-[320px] flex flex-col items-center justify-center gap-2 text-text-tertiary text-center">{icon}<div className="text-sm font-medium">{title}</div>{hint && <div className="text-xs max-w-md">{hint}</div>}</div>; }
function Notice({ tone, text }: { tone: "success" | "warning" | "error"; text: string }) { const cls = tone === "error" ? "bg-error-muted border-error/20 text-error" : tone === "warning" ? "bg-warning-muted border-warning/20 text-warning" : "bg-success-muted border-success/20 text-success"; const icon = tone === "error" ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />; return <div role={tone === "error" ? "alert" : "status"} className={`mx-4 mt-3 px-3 py-2 rounded border text-xs flex items-center gap-2 ${cls}`}>{icon}{text}</div>; }
