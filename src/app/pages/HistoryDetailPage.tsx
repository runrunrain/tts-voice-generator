import { useState, useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { Play, Download, Copy, ChevronLeft, Loader2, AlertCircle } from "lucide-react";
import { useAppState } from "../state/AppContext";

interface JobDetail {
  job: {
    id: string;
    model: string;
    voice: string;
    responseFormat: string;
    input: string;
    inputCharCount: number;
    status: string;
    generationId: string | null;
    estimatedCost: string | null;
    actualCost: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    source: string;
    directorSnapshot: {
      audioProfile?: string;
      scene?: string;
      directorNotes?: string;
      sampleContext?: string;
      transcript?: string;
      speakers?: Array<{
        id: string;
        label: string;
        name?: string;
        voice?: string;
        style?: string;
      }>;
    } | null;
    providerOptions: unknown;
    createdAt: string | null;
    completedAt: string | null;
  };
  audio: {
    id: number;
    audioUrl: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    duration: string | null;
  } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive the actual audio format to display for a job detail.
 *
 * Priority:
 * 1. audio.mimeType -> infer from MIME (e.g. "audio/wav" -> "wav")
 * 2. audio.fileName -> infer from extension (e.g. "xxx.wav" -> "wav")
 * 3. job.responseFormat -> the format stored on the job record (last resort)
 *
 * This ensures that when a legacy "mp3" request actually produced a "wav" asset,
 * the detail page shows the real format the user can download.
 */
function deriveActualFormat(detail: JobDetail): string {
  const audio = detail.audio;
  if (audio) {
    // Prefer MIME type inference
    const mime = audio.mimeType?.toLowerCase() ?? "";
    if (mime.includes("wav")) return "wav";
    if (mime.includes("pcm")) return "pcm";
    if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";

    // Fallback to file extension
    const ext = audio.fileName?.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "wav") return "wav";
    if (ext === "pcm") return "pcm";
    if (ext === "mp3") return "mp3";
  }
  return detail.job.responseFormat || "wav";
}

export function HistoryDetailPage() {
  const { jobId } = useParams();
  const { generate } = useAppState();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/jobs/${jobId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Job not found (${res.status})`);
        return res.json();
      })
      .then((data: JobDetail) => {
        setDetail(data);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load job");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [jobId]);

  const handlePlay = () => {
    if (detail?.audio?.audioUrl) {
      if (audioRef.current) audioRef.current.pause();
      const audio = new Audio(detail.audio.audioUrl);
      audio.onended = () => setIsPlaying(false);
      audio.play().catch(() => {});
      audioRef.current = audio;
      setIsPlaying(true);
    }
  };

  const handleDownload = () => {
    if (detail?.audio?.audioUrl) {
      const a = document.createElement("a");
      a.href = detail.audio.audioUrl;
      a.download = detail.audio.fileName;
      a.click();
    }
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleRegenerate = () => {
    if (detail?.job) {
      const ds = detail.job.directorSnapshot;
      generate({
        text: detail.job.input,
        voice: detail.job.voice,
        format: detail.job.responseFormat as "wav" | "pcm" | "mp3",
        audioProfile: ds?.audioProfile,
        scene: ds?.scene,
        directorNotes: ds?.directorNotes,
        sampleContext: ds?.sampleContext,
        // Preserve the original transcript from directorSnapshot.
        // Only fall back to job.input if no snapshot transcript exists.
        transcript: ds?.transcript || detail.job.input,
        speakers: ds?.speakers?.map((s) => ({
          id: s.id,
          label: s.label,
          name: s.name || "",
          voice: s.voice || "Zephyr",
          style: s.style || "",
        })),
      });
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <Loader2 size={24} className="animate-spin text-text-tertiary" />
        <p className="text-text-tertiary text-sm mt-3">正在加载任务详情...</p>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <AlertCircle size={24} className="text-error mb-3" />
        <p className="text-error text-sm">{error || "任务不存在"}</p>
        <Link to="/history" className="text-sm text-accent hover:text-accent-hover mt-3">
          返回列表
        </Link>
      </div>
    );
  }

  const job = detail.job;
  const audio = detail.audio;
  const isSucceeded = job.status === "succeeded";

  return (
    <div className="flex flex-col h-full bg-bg-base overflow-y-auto">
      <div className="max-w-[1848px] w-full mx-auto p-6 flex flex-col gap-6">

        <div className="h-10 flex items-center gap-4 text-sm shrink-0">
          <Link to="/history" className="flex items-center gap-1 text-text-secondary hover:text-text-primary transition-colors">
            <ChevronLeft size={16} /> 返回列表
          </Link>
          <span className="text-text-tertiary">/</span>
          <span className="font-mono text-text-primary">{jobId}</span>
        </div>

        <div className="h-20 flex flex-col justify-center shrink-0">
          <div className="flex items-center gap-3 mb-2">
            <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              isSucceeded
                ? "bg-success-muted text-success border border-success/20"
                : "bg-error-muted text-error border border-error/20"
            }`}>
              {isSucceeded ? "成功" : "失败"}
            </span>
            <h1 className="text-2xl font-bold font-mono text-text-primary">{jobId}</h1>
            <span className="text-sm text-text-tertiary ml-auto">
              创建: {job.createdAt ? new Date(job.createdAt).toLocaleString("zh-CN") : "--"}
            </span>
          </div>
          <div className="text-sm text-text-secondary">
            来源: {job.source === "user" ? "用户" : "Agent"}
            {audio?.duration ? ` | 耗时: ${audio.duration}` : ""}
            {job.completedAt ? ` | 完成: ${new Date(job.completedAt).toLocaleString("zh-CN")}` : ""}
          </div>
        </div>

        {!isSucceeded && job.errorMessage && (
          <div className="p-4 bg-error-muted/50 rounded-md border border-error/20 flex flex-col gap-1">
            <span className="text-sm text-error font-medium">{job.errorCode || "ERROR"}</span>
            <span className="text-xs text-text-secondary">{job.errorMessage}</span>
          </div>
        )}

        <div className="flex gap-6 items-start">

          {/* Left Column */}
          <div className="flex-1 flex flex-col gap-6">
            {isSucceeded && audio && (
              <div className="p-6 bg-bg-surface rounded-lg border border-border flex flex-col gap-4">
                <div className="flex items-center gap-4">
                  <button
                    className="w-10 h-10 rounded-full bg-accent text-bg-base flex items-center justify-center hover:bg-accent-hover transition-colors shrink-0"
                    onClick={handlePlay}
                  >
                    {isPlaying ? <span className="text-xs font-bold">||</span> : <Play fill="currentColor" size={18} className="ml-0.5" />}
                  </button>
                  <div className="flex-1 h-10 flex items-center gap-1">
                    {Array.from({length: 40}).map((_, i) => (
                      <div key={i} className="flex-1 bg-border rounded-full" style={{ height: `${Math.max(10, Math.random() * 100)}%` }} />
                    ))}
                  </div>
                  <span className="font-mono text-sm w-12 text-right">{audio.duration?.replace("s", "") || "--"}</span>
                </div>
                <div className="flex justify-end">
                  <button
                    className="flex items-center gap-2 px-4 py-2 rounded-md bg-bg-base border border-border text-sm font-medium hover:bg-bg-hover transition-colors"
                    onClick={handleDownload}
                  >
                    <Download size={16} /> 下载 {deriveActualFormat(detail).toUpperCase()}
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                输入文本
                <button
                  className="text-xs text-text-tertiary hover:text-text-primary transition-colors flex items-center gap-1"
                  onClick={() => handleCopy(job.input, "input")}
                >
                  <Copy size={12} /> {copied === "input" ? "已复制" : "复制"}
                </button>
              </h3>
              <div className="p-4 bg-bg-sunken rounded-md border border-border-subtle font-mono text-sm leading-relaxed text-text-primary min-h-[160px] whitespace-pre-wrap">
                {job.input}
              </div>
            </div>

            {job.directorSnapshot && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  Director Prompt
                  <button
                    className="text-xs text-text-tertiary hover:text-text-primary transition-colors flex items-center gap-1"
                    onClick={() => handleCopy(JSON.stringify(job.directorSnapshot, null, 2), "director")}
                  >
                    <Copy size={12} /> {copied === "director" ? "已复制" : "复制"}
                  </button>
                </h3>
                <div className="p-4 bg-bg-sunken rounded-md border border-border-subtle font-mono text-xs leading-relaxed text-text-secondary min-h-[100px] whitespace-pre-wrap">
                  {job.directorSnapshot.audioProfile && `<audio_profile>\n${job.directorSnapshot.audioProfile}\n</audio_profile>\n\n`}
                  {job.directorSnapshot.scene && `<scene>\n${job.directorSnapshot.scene}\n</scene>\n\n`}
                  {job.directorSnapshot.directorNotes && `<director_notes>\n${job.directorSnapshot.directorNotes}\n</director_notes>\n\n`}
                  {job.directorSnapshot.sampleContext && `<sample_context>\n${job.directorSnapshot.sampleContext}\n</sample_context>\n\n`}
                  {job.directorSnapshot.speakers && job.directorSnapshot.speakers.length > 0 && (
                    `<speakers>\n` +
                    job.directorSnapshot.speakers.map((s) =>
                      `  ${s.label}${s.name ? ` (${s.name})` : ''} [Voice: ${s.voice || 'default'}]${s.style ? ` [Style: ${s.style}]` : ''}`
                    ).join('\n') +
                    `\n</speakers>\n\n`
                  )}
                  {job.directorSnapshot.transcript && `<transcript>\n${job.directorSnapshot.transcript}\n</transcript>`}
                </div>
              </div>
            )}
          </div>

          {/* Right Column */}
          <div className="w-[560px] shrink-0 flex flex-col gap-6">

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">参数快照</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5">
                <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-sm">
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">模型</div>
                    <div className="text-text-primary font-medium font-mono text-xs">{job.model}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">音色</div>
                    <div className="text-text-primary font-medium">{job.voice}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">格式</div>
                    <div className="text-text-primary font-mono text-xs">{deriveActualFormat(detail)}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">字符数</div>
                    <div className="text-text-primary font-medium">{job.inputCharCount}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">成本</div>
                    <div className="text-text-primary font-medium text-accent">{job.estimatedCost || "--"}</div>
                  </div>
                  <div>
                    <div className="text-text-tertiary text-xs mb-1">Generation ID</div>
                    <div className="text-text-primary font-mono text-xs truncate" title={job.generationId || ""}>{job.generationId || "--"}</div>
                  </div>
                  {audio && (
                    <>
                      <div>
                        <div className="text-text-tertiary text-xs mb-1">文件大小</div>
                        <div className="text-text-primary font-medium">{(audio.sizeBytes / 1024).toFixed(1)} KB</div>
                      </div>
                      <div>
                        <div className="text-text-tertiary text-xs mb-1">时长</div>
                        <div className="text-text-primary font-medium">{audio.duration || "--"}</div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-text-primary">来源信息</h3>
              <div className="bg-bg-surface border border-border rounded-lg p-5 flex flex-col gap-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-tertiary">来源</span>
                  <span className="text-text-primary">{job.source === "user" ? "用户" : "Agent"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-tertiary">状态</span>
                  <span className={isSucceeded ? "text-success" : "text-error"}>{job.status}</span>
                </div>
                {job.completedAt && (
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">完成时间</span>
                    <span className="text-text-primary font-mono text-xs">{new Date(job.completedAt).toLocaleString("zh-CN")}</span>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Sticky Bottom Bar */}
      <div className="h-[52px] shrink-0 bg-bg-sunken border-t border-border-subtle mt-auto flex items-center justify-between px-6 sticky bottom-0 z-10">
        <button
          className="px-4 py-2 rounded-md bg-bg-surface border border-border text-sm font-medium hover:bg-bg-hover transition-colors"
          onClick={handleRegenerate}
        >
          使用相同参数重新生成
        </button>
        <Link to="/history" className="px-4 py-2 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">
          返回列表
        </Link>
      </div>
    </div>
  );
}
