import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { taskApi } from "../../services/httpAdapter";
import type { RequirementDocument } from "../../types";

type Phase = "idle" | "loading" | "saving" | "success" | "error";

export function RequirementDocsPanel({ taskId }: { taskId: string }) {
  const [documents, setDocuments] = useState<RequirementDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pasteTitle, setPasteTitle] = useState("粘贴需求");
  const [pasteContent, setPasteContent] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadDocuments = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const result = await taskApi.listDocuments(taskId);
      const docs = result.documents ?? [];
      const sorted = [...docs].sort((a, b) => a.sortOrder - b.sortOrder);
      setDocuments(sorted);
      setSelectedId((prev) => prev ?? sorted[0]?.id ?? null);
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "需求文档加载失败");
      setPhase("error");
    }
  }, [taskId]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const selected = documents.find((doc) => doc.id === selectedId) ?? documents[0] ?? null;

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setContentLoading(true);
    setError(null);
    taskApi.getDocument(taskId, selectedId)
      .then((doc) => {
        if (cancelled) return;
        setDocuments((prev) => prev.map((item) => item.id === doc.id ? { ...item, ...doc } : item));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "文档内容加载失败");
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, taskId]);

  const handleFile = async (file: File) => {
    setPhase("saving");
    setError(null);
    setSuccess(null);
    try {
      const content = await file.text();
      const doc = await taskApi.uploadDocument(taskId, { fileName: file.name, content });
      setDocuments((prev) => [...prev, doc].sort((a, b) => a.sortOrder - b.sortOrder));
      setSelectedId(doc.id);
      setSuccess("文档已上传");
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "文档上传失败");
      setPhase("error");
    }
  };

  const handlePaste = async () => {
    if (!pasteContent.trim()) return;
    setPhase("saving");
    setError(null);
    setSuccess(null);
    try {
      const fileName = pasteTitle.trim() || "粘贴需求.md";
      const doc = await taskApi.pasteDocument(taskId, { fileName, content: pasteContent.trim() });
      setDocuments((prev) => [...prev, doc].sort((a, b) => a.sortOrder - b.sortOrder));
      setSelectedId(doc.id);
      setPasteContent("");
      setSuccess("需求文本已保存");
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "粘贴需求保存失败");
      setPhase("error");
    }
  };

  const toggleEnabled = async (doc: RequirementDocument) => {
    setPhase("saving");
    setError(null);
    try {
      const updated = await taskApi.updateDocument(taskId, doc.id, doc.version, { enabled: !doc.enabled });
      setDocuments((prev) => prev.map((item) => item.id === doc.id ? updated : item));
      setSuccess(updated.enabled ? "文档已启用" : "文档已禁用");
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "文档状态更新失败");
      setPhase("error");
    }
  };

  const deleteDocument = async (doc: RequirementDocument) => {
    setPhase("saving");
    setError(null);
    try {
      await taskApi.deleteDocument(taskId, doc.id);
      setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
      setSelectedId((prev) => prev === doc.id ? null : prev);
      setSuccess("文档已删除");
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "文档删除失败");
      setPhase("error");
    }
  };

  return (
    <section className="h-full min-h-0 min-w-0 overflow-hidden grid grid-cols-[240px_minmax(0,1fr)] [@media(min-width:1200px)]:grid-cols-[270px_minmax(0,1fr)] [@media(min-width:1440px)]:grid-cols-[320px_minmax(0,1fr)] border border-border-subtle bg-bg-surface">
      <aside className="min-h-0 min-w-0 overflow-hidden border-r border-border-subtle bg-bg-sunken/70 flex flex-col">
        <div className="h-11 shrink-0 px-3 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold"><FileText size={15} /> 需求文档</div>
          <button className="text-text-tertiary hover:text-text-primary" onClick={loadDocuments} disabled={phase === "loading"} title="刷新文档">
            <RefreshCw size={14} className={phase === "loading" ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="shrink-0 p-3 [@media(max-height:760px)]:p-2 border-b border-border-subtle flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.json,.txt"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) handleFile(file);
              event.currentTarget.value = "";
            }}
          />
          <button
            className="h-8 rounded-md bg-accent text-bg-base text-xs font-semibold hover:bg-accent-hover disabled:opacity-50 flex items-center justify-center gap-2"
            onClick={() => fileInputRef.current?.click()}
            disabled={phase === "saving"}
          >
            {phase === "saving" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} 上传 md/json
          </button>
          <input
            className="h-8 bg-bg-base border border-border rounded px-2 text-xs outline-none focus:border-border-focus"
            value={pasteTitle}
            onChange={(event) => setPasteTitle(event.target.value)}
            placeholder="文档标题"
          />
          <textarea
            className="h-24 [@media(max-height:760px)]:h-16 bg-bg-base border border-border rounded p-2 text-xs outline-none resize-none focus:border-border-focus"
            value={pasteContent}
            onChange={(event) => setPasteContent(event.target.value)}
            placeholder="粘贴需求文本，保存后纳入任务上下文"
          />
          <button
            className="h-8 rounded-md bg-bg-surface border border-border text-xs hover:bg-bg-hover disabled:opacity-50"
            onClick={handlePaste}
            disabled={!pasteContent.trim() || phase === "saving"}
          >
            保存粘贴文本
          </button>
        </div>

        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
          {phase === "loading" && documents.length === 0 && <StateNote icon={<Loader2 size={16} className="animate-spin" />} text="正在加载文档" />}
          {phase !== "loading" && documents.length === 0 && <StateNote icon={<FileText size={16} />} text="暂无需求文档" hint="上传或粘贴后开始整理需求" />}
          {documents.map((doc, index) => (
            <button
              key={doc.id}
              className={`w-full text-left px-3 py-3 border-b border-border-subtle hover:bg-bg-hover transition-colors ${selected?.id === doc.id ? "bg-accent-subtle" : ""}`}
              onClick={() => setSelectedId(doc.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-tertiary font-mono">#{String(index + 1).padStart(2, "0")}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${doc.enabled ? "text-success border-success/20 bg-success-muted" : "text-text-tertiary border-border bg-bg-base"}`}>{doc.enabled ? "启用" : "禁用"}</span>
              </div>
              <div className="text-sm font-medium text-text-primary truncate mt-1">{doc.title || doc.filename || "未命名文档"}</div>
              <div className="text-[10px] text-text-tertiary mt-1 truncate">v{doc.version} · {doc.filename || doc.title || "无文件名"}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-h-0 min-w-0 overflow-hidden flex flex-col">
        <div className="h-11 shrink-0 px-4 border-b border-border-subtle flex items-center justify-between gap-3">
          <div className="text-sm font-semibold truncate">{selected ? selected.title || selected.filename : "文档预览"}</div>
          {selected && (
            <div className="shrink-0 flex items-center gap-2">
              <button className="px-2 py-1 rounded border border-border text-xs hover:bg-bg-hover" onClick={() => toggleEnabled(selected)} disabled={phase === "saving"}>{selected.enabled ? "禁用" : "启用"}</button>
              <button className="px-2 py-1 rounded border border-error/30 text-xs text-error hover:bg-error-muted" onClick={() => deleteDocument(selected)} disabled={phase === "saving"}><Trash2 size={12} /></button>
            </div>
          )}
        </div>

        {(error || success) && (
          <div className={`shrink-0 mx-4 mt-4 px-3 py-2 rounded border text-xs flex items-center gap-2 ${error ? "bg-error-muted border-error/20 text-error" : "bg-success-muted border-success/20 text-success"}`}>
            {error ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
            {error || success}
          </div>
        )}

        <div className="flex-1 min-h-0 min-w-0 overflow-auto p-4 [@media(max-height:760px)]:p-3">
          {selected ? (
            <pre className="min-h-full whitespace-pre-wrap break-words rounded-md bg-bg-sunken border border-border-subtle p-4 text-xs leading-6 text-text-secondary font-mono">
              {contentLoading ? "正在加载文档内容..." : selected.content || "文档内容为空"}
            </pre>
          ) : (
            <div className="h-full flex items-center justify-center text-center text-text-tertiary text-sm">选择左侧文档查看预览</div>
          )}
        </div>
      </main>
    </section>
  );
}

function StateNote({ icon, text, hint }: { icon: React.ReactNode; text: string; hint?: string }) {
  return (
    <div className="h-44 flex flex-col items-center justify-center text-center gap-2 text-text-tertiary">
      {icon}
      <div className="text-xs font-medium">{text}</div>
      {hint && <div className="text-[10px]">{hint}</div>}
    </div>
  );
}
