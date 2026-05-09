import { AlertCircle, CheckCircle2, Download, GitCompareArrows, Loader2, RotateCcw, ShieldAlert, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, taskApi } from "../../services/httpAdapter";
import type { ProductionListDiff, ProductionListExportFormat, ProductionListImportResult, ProductionListQualityReport, ProductionListVersionEntry } from "../../types";

type Phase = "idle" | "loading" | "success" | "error" | "conflict";
type ImportFormat = "json" | "csv";

interface Props {
  taskId: string;
  currentVersion: number;
  disabled?: boolean;
  onChanged: () => Promise<void> | void;
}

export function ProductionListP1Panel({ taskId, currentVersion, disabled, onChanged }: Props) {
  const [versions, setVersions] = useState<ProductionListVersionEntry[]>([]);
  const [versionPhase, setVersionPhase] = useState<Phase>("idle");
  const [versionError, setVersionError] = useState<string | null>(null);
  const [fromVersion, setFromVersion] = useState<number>(0);
  const [toVersion, setToVersion] = useState<number>(0);
  const [targetVersion, setTargetVersion] = useState<number>(0);
  const [diff, setDiff] = useState<ProductionListDiff | null>(null);
  const [diffPhase, setDiffPhase] = useState<Phase>("idle");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [rollbackPhase, setRollbackPhase] = useState<Phase>("idle");
  const [rollbackMessage, setRollbackMessage] = useState<string | null>(null);
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false);
  const [exportFormat, setExportFormat] = useState<ProductionListExportFormat>("json");
  const [exportPhase, setExportPhase] = useState<Phase>("idle");
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<string>("");
  const [importFormat, setImportFormat] = useState<ImportFormat>("json");
  const [importText, setImportText] = useState("");
  const [importPhase, setImportPhase] = useState<Phase>("idle");
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ProductionListImportResult["import"] | null>(null);
  const [quality, setQuality] = useState<ProductionListQualityReport | null>(null);
  const [qualityPhase, setQualityPhase] = useState<Phase>("idle");
  const [qualityError, setQualityError] = useState<string | null>(null);

  const hasRollbackTarget = targetVersion > 0 && currentVersion > 0 && targetVersion < currentVersion;
  const versionOptions = versions.length > 0 ? versions : (currentVersion > 0 ? [{ version: currentVersion, versionId: "current", lineCount: 0, createdAt: new Date().toISOString() }] : []);

  const loadVersions = useCallback(async () => {
    setVersionPhase("loading");
    setVersionError(null);
    try {
      const result = await taskApi.listProductionListVersions(taskId);
      setVersions(result.versions);
      const newest = result.versions[0]?.version ?? currentVersion;
      const previous = result.versions.find((entry) => entry.version < newest)?.version ?? result.versions[1]?.version ?? 0;
      setToVersion((value) => value > 0 ? value : newest);
      setFromVersion((value) => value > 0 ? value : previous);
      setTargetVersion((value) => value > 0 ? value : previous);
      setVersionPhase("success");
    } catch (err) {
      setVersionError(err instanceof Error ? err.message : "版本历史加载失败");
      setVersionPhase("error");
    }
  }, [currentVersion, taskId]);

  const loadQuality = useCallback(async () => {
    setQualityPhase("loading");
    setQualityError(null);
    try {
      const report = await taskApi.getProductionListQualityReport(taskId);
      setQuality(report);
      setQualityPhase("success");
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : "质量报告加载失败");
      setQualityPhase("error");
    }
  }, [taskId]);

  useEffect(() => {
    loadVersions();
    loadQuality();
  }, [loadQuality, loadVersions]);

  const loadDiff = async () => {
    if (!fromVersion || !toVersion || fromVersion === toVersion) {
      setDiffPhase("error");
      setDiffError("请选择两个不同版本进行 diff");
      return;
    }
    setDiffPhase("loading");
    setDiffError(null);
    try {
      const next = await taskApi.getProductionListDiff(taskId, fromVersion, toVersion);
      setDiff(next);
      setDiffPhase("success");
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : "diff 加载失败");
      setDiffPhase("error");
    }
  };

  const rollback = async () => {
    if (!hasRollbackTarget || !rollbackConfirmed) return;
    setRollbackPhase("loading");
    setRollbackMessage(null);
    try {
      const result = await taskApi.rollbackProductionList(taskId, currentVersion, targetVersion, `frontend rollback to v${targetVersion}`);
      setRollbackMessage(`已从 v${result.rollback.fromVersion} 回滚到 v${result.rollback.targetVersion}，新版本 v${result.rollback.newVersion}`);
      setRollbackPhase("success");
      setRollbackConfirmed(false);
      await onChanged();
      await loadVersions();
      await loadQuality();
    } catch (err) {
      setRollbackPhase(err instanceof ApiError && err.isConflict ? "conflict" : "error");
      setRollbackMessage(err instanceof Error ? err.message : "回滚失败");
    }
  };

  const exportList = async () => {
    setExportPhase("loading");
    setExportMessage(null);
    setExportPreview("");
    try {
      const result = await taskApi.exportProductionList(taskId, exportFormat);
      const blob = new Blob([result.content], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportPreview(result.content.slice(0, 1800));
      setExportMessage(`已导出 ${result.fileName}`);
      setExportPhase("success");
    } catch (err) {
      setExportMessage(err instanceof Error ? err.message : "导出失败");
      setExportPhase("error");
    }
  };

  const importValidation = useMemo(() => validateImport(importFormat, importText), [importFormat, importText]);

  const importList = async () => {
    if (!importValidation.ok || currentVersion < 0) {
      setImportPhase("error");
      setImportMessage(importValidation.message);
      return;
    }
    setImportPhase("loading");
    setImportMessage(null);
    setImportResult(null);
    try {
      const result = await taskApi.importProductionList(taskId, currentVersion, importFormat, importValidation.data, `frontend ${importFormat} import`);
      setImportResult(result.import);
      setImportMessage(`导入完成：${result.import.importedLines} 条写入，${result.import.skippedLines} 条跳过`);
      setImportPhase("success");
      await onChanged();
      await loadVersions();
      await loadQuality();
    } catch (err) {
      setImportPhase(err instanceof ApiError && err.isConflict ? "conflict" : "error");
      setImportMessage(err instanceof Error ? err.message : "导入失败");
    }
  };

  return (
    <div className="mx-4 mt-3 grid grid-cols-[minmax(520px,1.1fr)_minmax(420px,0.9fr)] gap-3 text-xs xl:grid-cols-[minmax(620px,1.15fr)_minmax(520px,0.85fr)]">
      <section className="border border-border-subtle bg-bg-sunken/70">
        <PanelTitle icon={<GitCompareArrows size={14} />} title="版本、Diff 与回滚" phase={versionPhase} />
        <div className="p-3 grid grid-cols-[1fr_1fr_auto] gap-2 border-b border-border-subtle items-end">
          <VersionSelect label="From" value={fromVersion} versions={versionOptions} onChange={setFromVersion} disabled={disabled || versionPhase === "loading"} />
          <VersionSelect label="To" value={toVersion || currentVersion} versions={versionOptions} onChange={setToVersion} disabled={disabled || versionPhase === "loading"} />
          <button className="h-8 px-3 rounded border border-border hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={loadDiff} disabled={disabled || diffPhase === "loading" || versionOptions.length < 2}>{diffPhase === "loading" ? <Loader2 size={13} className="animate-spin" /> : <GitCompareArrows size={13} />} 查看 Diff</button>
        </div>
        {versionError && <InlineNotice tone="error" message={versionError} />}
        {diffPhase === "success" && diff ? <DiffSummary diff={diff} /> : <EmptyStrip text={diffPhase === "loading" ? "正在计算版本差异" : diffError ?? "选择两个版本查看新增、删除、修改摘要"} tone={diffError ? "error" : "neutral"} />}
        <div className="p-3 grid grid-cols-[180px_1fr_auto] gap-2 items-center border-t border-border-subtle">
          <VersionSelect label="回滚目标" value={targetVersion} versions={versionOptions.filter((entry) => entry.version < currentVersion)} onChange={setTargetVersion} disabled={disabled || rollbackPhase === "loading"} />
          <label className="flex items-center gap-2 text-text-secondary"><input type="checkbox" className="accent-accent" checked={rollbackConfirmed} onChange={(event) => setRollbackConfirmed(event.target.checked)} disabled={!hasRollbackTarget || disabled} />确认以 expectedVersion v{currentVersion} 回滚，历史版本保留并生成新版本</label>
          <button className="h-8 px-3 rounded border border-warning/40 text-warning hover:bg-warning-muted disabled:opacity-50 flex items-center gap-1" onClick={rollback} disabled={disabled || rollbackPhase === "loading" || !hasRollbackTarget || !rollbackConfirmed}>{rollbackPhase === "loading" ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} 回滚</button>
        </div>
        {rollbackMessage && <InlineNotice tone={rollbackPhase === "success" ? "success" : rollbackPhase === "conflict" ? "warning" : "error"} message={rollbackMessage} />}
      </section>

      <section className="border border-border-subtle bg-bg-sunken/70">
        <PanelTitle icon={<ShieldAlert size={14} />} title="质量报告" phase={qualityPhase} />
        {qualityPhase === "loading" && <EmptyStrip text="正在加载质量报告" />}
        {qualityError && <InlineNotice tone="error" message={qualityError} />}
        {qualityPhase === "success" && quality && <QualityPanel report={quality} />}
      </section>

      <section className="border border-border-subtle bg-bg-sunken/70">
        <PanelTitle icon={<Download size={14} />} title="导出" phase={exportPhase} />
        <div className="p-3 grid grid-cols-[160px_auto_1fr] gap-2 items-center">
          <select className="h-8 bg-bg-base border border-border rounded px-2 outline-none focus:border-border-focus" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ProductionListExportFormat)} disabled={disabled || exportPhase === "loading"}>
            <option value="json">JSON</option>
            <option value="md">Markdown</option>
            <option value="csv">CSV</option>
          </select>
          <button className="h-8 px-3 rounded border border-border hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={exportList} disabled={disabled || exportPhase === "loading" || currentVersion <= 0}>{exportPhase === "loading" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} 下载</button>
          <span className="text-text-tertiary font-mono">当前版本 v{currentVersion}</span>
        </div>
        {exportMessage && <InlineNotice tone={exportPhase === "success" ? "success" : "error"} message={exportMessage} />}
        {exportPreview && <pre className="mx-3 mb-3 max-h-28 overflow-auto border border-border-subtle bg-bg-base p-2 text-[10px] text-text-tertiary font-mono whitespace-pre-wrap">{exportPreview}</pre>}
      </section>

      <section className="border border-border-subtle bg-bg-sunken/70">
        <PanelTitle icon={<Upload size={14} />} title="导入与校验" phase={importPhase} />
        <div className="p-3 grid grid-cols-[120px_1fr_auto] gap-2 items-center border-b border-border-subtle">
          <select className="h-8 bg-bg-base border border-border rounded px-2 outline-none focus:border-border-focus" value={importFormat} onChange={(event) => setImportFormat(event.target.value as ImportFormat)} disabled={disabled || importPhase === "loading"}>
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
          <input type="file" accept={importFormat === "json" ? ".json,application/json" : ".csv,text/csv"} className="text-[10px] text-text-tertiary file:mr-3 file:h-8 file:border file:border-border file:bg-bg-base file:text-text-secondary file:rounded file:px-3" onChange={async (event) => setImportText(await (event.target.files?.[0]?.text() ?? Promise.resolve(importText)))} disabled={disabled || importPhase === "loading"} />
          <button className="h-8 px-3 rounded border border-accent/40 text-accent hover:bg-accent-muted disabled:opacity-50 flex items-center gap-1" onClick={importList} disabled={disabled || importPhase === "loading" || !importValidation.ok || currentVersion < 0}>{importPhase === "loading" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} 导入</button>
        </div>
        <textarea className="m-3 w-[calc(100%-1.5rem)] h-28 bg-bg-base border border-border rounded p-2 font-mono text-[10px] outline-none resize-none focus:border-border-focus" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={importFormat === "json" ? "粘贴 { promptProfiles: [...], lines: [...] } JSON，旧 v1 lines 仍支持 transcript 映射" : "粘贴 CSV，需包含 id,text,voice 等列"} disabled={disabled || importPhase === "loading"} />
        <InlineNotice tone={importValidation.ok ? "success" : "warning"} message={importValidation.message} />
        {importMessage && <InlineNotice tone={importPhase === "success" ? "success" : importPhase === "conflict" ? "warning" : "error"} message={importMessage} />}
        {importResult && <ImportResultStrip result={importResult} />}
      </section>
    </div>
  );
}

function validateImport(format: ImportFormat, text: string): { ok: boolean; message: string; data: unknown } {
  if (!text.trim()) return { ok: false, message: "等待导入内容", data: null };
  if (format === "csv") {
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < 2) return { ok: false, message: "CSV 至少需要表头和一行数据", data: text };
    const headers = lines[0].split(",").map((item) => item.trim());
    if (!headers.includes("text")) return { ok: false, message: "CSV 表头必须包含 text 列", data: text };
    return { ok: true, message: `CSV 校验通过：${lines.length - 1} 行待导入`, data: text };
  }
  try {
    const parsed = JSON.parse(text) as { lines?: unknown[]; speakers?: unknown[] };
    if (!Array.isArray(parsed.lines)) return { ok: false, message: "JSON 必须包含 lines 数组", data: parsed };
    const normalized = {
      ...parsed,
      lines: parsed.lines.map((raw, index) => {
        const line = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        return {
          ...line,
          id: typeof line.id === "string" ? line.id : `imported_${index}`,
          order: typeof line.order === "number" ? line.order : typeof line.sortOrder === "number" ? line.sortOrder - 1 : index,
          text: typeof line.text === "string" ? line.text : typeof line.transcript === "string" ? line.transcript : "",
          voice: typeof line.voice === "string" ? line.voice : "Zephyr",
          speaker: typeof line.speaker === "string" ? line.speaker : "narrator",
        };
      }),
    };
    const emptyCount = normalized.lines.filter((line) => !String((line as Record<string, unknown>).text ?? "").trim()).length;
    if (emptyCount > 0) return { ok: false, message: `JSON 有 ${emptyCount} 行缺少 text/transcript`, data: normalized };
    return { ok: true, message: `JSON 校验通过：${normalized.lines.length} 行待导入`, data: normalized };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? `JSON 解析失败：${err.message}` : "JSON 解析失败", data: null };
  }
}

function PanelTitle({ icon, title, phase }: { icon: React.ReactNode; title: string; phase: Phase }) {
  return <div className="h-9 px-3 border-b border-border-subtle flex items-center justify-between bg-bg-base/50"><span className="font-semibold text-text-secondary flex items-center gap-2">{icon}{title}</span><span className="font-mono text-[10px] text-text-tertiary">{phase}</span></div>;
}

function VersionSelect({ label, value, versions, disabled, onChange }: { label: string; value: number; versions: ProductionListVersionEntry[]; disabled?: boolean; onChange: (value: number) => void }) {
  return <label className="flex flex-col gap-1 text-[10px] text-text-tertiary"><span>{label}</span><select className="h-8 bg-bg-base border border-border rounded px-2 text-xs text-text-secondary outline-none focus:border-border-focus" value={value || ""} onChange={(event) => onChange(Number(event.target.value))} disabled={disabled || versions.length === 0}><option value="">选择版本</option>{versions.map((entry) => <option key={`${label}-${entry.version}`} value={entry.version}>v{entry.version} · {entry.lineCount} 行</option>)}</select></label>;
}

function DiffSummary({ diff }: { diff: ProductionListDiff }) {
  const metrics = diff.summary;
  return <div className="p-3"><div className="grid grid-cols-6 border border-border-subtle bg-bg-base text-[10px]"><Metric label="新增" value={metrics.addedCount} tone="success" /><Metric label="删除" value={metrics.removedCount} tone="error" /><Metric label="修改" value={metrics.changedCount} tone="warning" /><Metric label="未变" value={metrics.unchangedCount} /><Metric label="From 行" value={metrics.fromLineCount} /><Metric label="To 行" value={metrics.toLineCount} /></div><div className="mt-2 max-h-24 overflow-auto border border-border-subtle bg-bg-base p-2 font-mono text-[10px] text-text-tertiary">{diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0 ? "无结构化差异" : [...diff.added.slice(0, 6).map((id) => `+ ${id}`), ...diff.removed.slice(0, 6).map((id) => `- ${id}`), ...diff.changed.slice(0, 8).map((item) => `~ ${item.lineId}: ${item.fields.join(", ")}`)].join("\n")}</div></div>;
}

function QualityPanel({ report }: { report: ProductionListQualityReport }) {
  const missing = report.metrics.missingFields ?? {};
  const reuse = report.metrics.directorReuse;
  const duplicates = report.metrics.suspectedDuplicates;
  const longText = report.metrics.longText;
  const missingPromptStructureCount = Number(report.metrics.missingPromptStructureCount ?? missing.promptStructure ?? missing.promptProfile ?? missing.directorProfile ?? report.metrics.unboundDirectorCount ?? 0);
  const incompletePromptProfileCount = Number(report.metrics.incompletePromptProfileCount ?? missing.incompletePromptProfile ?? 0);
  const promptIssueCodes = new Set(["MISSING_PROMPT_STRUCTURE", "INCOMPLETE_BOUND_PROMPT_PROFILE", "MISSING_PROMPT_PROFILE_BINDING", "UNKNOWN_PROMPT_PROFILE_REFERENCE"]);
  const sortedIssues = [...report.issues].sort((a, b) => {
    const aPrompt = promptIssueCodes.has(a.code) ? 0 : 1;
    const bPrompt = promptIssueCodes.has(b.code) ? 0 : 1;
    if (aPrompt !== bPrompt) return aPrompt - bPrompt;
    const severityOrder = (severity: string) => severity === "error" ? 0 : severity === "warning" ? 1 : 2;
    return severityOrder(a.severity) - severityOrder(b.severity);
  });
  return <div className="p-3 flex flex-col gap-2"><div className="grid grid-cols-5 border border-border-subtle bg-bg-base text-[10px]"><Metric label="总行数" value={report.totalLines} /><Metric label="缺完整提示" value={missingPromptStructureCount} tone={missingPromptStructureCount > 0 ? "error" : undefined} /><Metric label="Profile 不完整" value={incompletePromptProfileCount} tone={incompletePromptProfileCount > 0 ? "error" : undefined} /><Metric label="重复组" value={duplicates?.groups ?? 0} tone={(duplicates?.groups ?? 0) > 0 ? "warning" : undefined} /><Metric label="过长" value={longText?.count ?? 0} tone={(longText?.count ?? 0) > 0 ? "warning" : undefined} /></div><div className="grid grid-cols-2 gap-2 text-[10px]"><InfoBox title="Prompt Structure" data={{ missingPromptStructureCount, incompletePromptProfileCount }} /><InfoBox title="缺失字段" data={missing} /><InfoBox title="导演复用" data={reuse ?? { uniqueProfiles: 0, sharedProfiles: 0, maxReuseCount: 0 }} /><InfoBox title="Generation" data={report.metrics.generationSummary ?? {}} /></div><div className="max-h-24 overflow-auto border border-border-subtle bg-bg-base p-2 text-[10px] text-text-tertiary">{sortedIssues.length === 0 ? "质量报告无阻断问题" : sortedIssues.slice(0, 8).map((issue) => `${issue.severity} · ${issue.code}${issue.lineId ? ` · ${issue.lineId}` : ""}: ${issue.message}`).join("\n")}</div></div>;
}

function InfoBox({ title, data }: { title: string; data: unknown }) {
  return <div className="border border-border-subtle bg-bg-base p-2"><div className="mb-1 text-text-secondary font-semibold">{title}</div><pre className="max-h-16 overflow-auto font-mono text-text-tertiary whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre></div>;
}

function ImportResultStrip({ result }: { result: ProductionListImportResult["import"] }) {
  return <div className="mx-3 mb-3 border border-border-subtle bg-bg-base p-2 text-[10px] text-text-tertiary"><div>写入 {result.importedLines} 行，跳过 {result.skippedLines} 行</div>{result.directorWarnings && result.directorWarnings.length > 0 && <div className="mt-1 text-warning">导演警告：{result.directorWarnings.slice(0, 3).join("；")}</div>}{result.errors && result.errors.length > 0 && <div className="mt-1 text-error">错误：{result.errors.slice(0, 3).map((item) => `#${item.index} ${item.message}`).join("；")}</div>}</div>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "error" }) {
  return <div className="px-2 py-2 border-r border-border-subtle last:border-r-0"><span className="text-text-tertiary">{label}</span><span className={`ml-2 font-mono ${tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "error" ? "text-error" : "text-text-secondary"}`}>{value}</span></div>;
}

function EmptyStrip({ text, tone = "neutral" }: { text: string; tone?: "neutral" | "error" }) {
  return <div className={`m-3 px-3 py-2 border text-[10px] ${tone === "error" ? "border-error/20 bg-error-muted text-error" : "border-border-subtle bg-bg-base text-text-tertiary"}`}>{text}</div>;
}

function InlineNotice({ tone, message }: { tone: "success" | "warning" | "error"; message: string }) {
  const icon = tone === "success" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />;
  const style = tone === "success" ? "bg-success-muted border-success/20 text-success" : tone === "warning" ? "bg-warning-muted border-warning/20 text-warning" : "bg-error-muted border-error/20 text-error";
  return <div role={tone === "error" ? "alert" : "status"} className={`mx-3 my-2 px-3 py-2 rounded border text-[10px] flex items-center gap-2 ${style}`}>{icon}{message}</div>;
}
