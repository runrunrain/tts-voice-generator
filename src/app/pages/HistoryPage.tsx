import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Link } from "react-router";
import { Play, Square, Download, Copy, ChevronRight, Search, Loader2, AlertCircle, RefreshCw, ArrowLeft, FileAudio, FolderOpen } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { HistoryRecord, HistoryStatus, HistorySource, TaskHistoryGroup, TaskHistoryStatusSummary } from "../types";
import { createAudioElementFromAsset, downloadAudioAsset } from "../services/audioAsset";

const HISTORY_SOURCE_LABEL: Record<HistorySource, string> = {
  user: "用户",
  agent: "Agent",
  cli: "CLI",
};

const HISTORY_SOURCE_BADGE_CLASS: Record<HistorySource, string> = {
  user: "bg-bg-surface text-text-secondary border-border",
  agent: "bg-accent-muted text-accent border-accent/20",
  cli: "bg-warning-muted text-warning border-warning/20",
};

const HISTORY_STATUS_META: Record<HistoryStatus, { label: string; dot: string; badge: string }> = {
  success: { label: "成功", dot: "bg-success", badge: "border-success/20 bg-success-muted/20 text-success" },
  error: { label: "错误", dot: "bg-error", badge: "border-error/20 bg-error-muted/30 text-error" },
  pending: { label: "处理中", dot: "bg-accent", badge: "border-accent/20 bg-accent-muted/30 text-accent" },
};

const PREVIEW_SOURCE_LABEL: Record<HistoryRecord["previewSource"], string> = {
  voice_line: "任务台词",
  director_snapshot: "Director 台词",
  job_input: "旧记录兜底",
  empty: "无台词",
};

const EMPTY_STATUS_SUMMARY: TaskHistoryStatusSummary = { success: 0, error: 0, pending: 0 };
const INDEPENDENT_GROUP_TITLE = "独立生成";

function cloneEmptySummary(): TaskHistoryStatusSummary {
  return { ...EMPTY_STATUS_SUMMARY };
}

function shortId(id: string | null | undefined): string {
  if (!id) return "no-task";
  return id.length <= 10 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function safeTimeValue(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestIsoLikeDate(left: string | null, right: string | null | undefined): string | null {
  if (!right) return left;
  if (!left) return right;
  return safeTimeValue(right) >= safeTimeValue(left) ? right : left;
}

function formatTaskTime(value: string | null | undefined, fallback = "暂无时间"): string {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString("zh-CN");
}

function cleanHistoryTitle(value: string | null | undefined): string | null {
  const title = value?.trim();
  return title ? title : null;
}

function taskTitleForRecord(record: HistoryRecord): string {
  if (!record.taskId) return cleanHistoryTitle(record.taskDisplayTitle) || INDEPENDENT_GROUP_TITLE;

  const taskDisplayTitle = cleanHistoryTitle(record.taskDisplayTitle);
  return (
    cleanHistoryTitle(record.taskTitle) ||
    cleanHistoryTitle(record.taskName) ||
    (taskDisplayTitle && taskDisplayTitle !== INDEPENDENT_GROUP_TITLE ? taskDisplayTitle : null) ||
    `未命名任务 ${shortId(record.taskId)}`
  );
}

function getRecordTimestamp(record: HistoryRecord): string | null {
  return record.taskUpdatedAt || record.taskCreatedAt || record.createdAt || null;
}

function compareHistoryItems(a: HistoryRecord, b: HistoryRecord): number {
  const aOrder = typeof a.voiceLineOrder === "number" ? a.voiceLineOrder : null;
  const bOrder = typeof b.voiceLineOrder === "number" ? b.voiceLineOrder : null;
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
  if (aOrder !== null && bOrder === null) return -1;
  if (aOrder === null && bOrder !== null) return 1;
  return safeTimeValue(b.createdAt) - safeTimeValue(a.createdAt);
}

function buildTaskHistoryGroups(records: HistoryRecord[]): TaskHistoryGroup[] {
  const groups = new Map<string, TaskHistoryGroup>();

  for (const record of records) {
    const hasTask = Boolean(record.taskId);
    const groupKind: TaskHistoryGroup["groupKind"] = hasTask ? "task" : "orphan";
    const groupId = hasTask ? `task:${record.taskId}` : (record.taskGroupId || "orphan");
    const existing = groups.get(groupId);
    const group = existing ?? {
      groupId,
      groupKind,
      taskId: record.taskId ?? null,
      taskTitle: taskTitleForRecord(record),
      taskCreatedAt: record.taskCreatedAt ?? null,
      taskUpdatedAt: record.taskUpdatedAt ?? null,
      latestRecordAt: getRecordTimestamp(record),
      audioCount: 0,
      statusSummary: cloneEmptySummary(),
      items: [],
    };

    group.items.push(record);
    group.audioCount += 1;
    group.statusSummary[record.status] += 1;
    group.latestRecordAt = latestIsoLikeDate(group.latestRecordAt, getRecordTimestamp(record));
    group.taskUpdatedAt = latestIsoLikeDate(group.taskUpdatedAt, record.taskUpdatedAt);
    groups.set(groupId, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, items: [...group.items].sort(compareHistoryItems) }))
    .sort((a, b) => safeTimeValue(b.latestRecordAt) - safeTimeValue(a.latestRecordAt));
}

function recordSearchHaystack(record: HistoryRecord): string {
  return [
    record.id,
    record.taskId,
    record.taskTitle,
    record.taskName,
    record.taskDisplayTitle,
    record.previewSpeaker,
    record.previewText,
    record.lineSpeaker,
    record.lineText,
    record.speakerLabel,
    record.speakerName,
    record.speakerRole,
    record.transcript,
    record.text,
    record.voice,
  ].filter(Boolean).join(" ").toLowerCase();
}

function statusSummaryLabel(summary: TaskHistoryStatusSummary): string {
  const parts = [
    summary.success > 0 ? `成功 ${summary.success}` : "",
    summary.error > 0 ? `错误 ${summary.error}` : "",
    summary.pending > 0 ? `处理中 ${summary.pending}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "暂无状态";
}

function previewLine(record: HistoryRecord): string {
  const speaker = record.previewSpeaker || record.lineSpeaker || record.speakerName || record.speakerLabel || record.voice || "旁白";
  const text = record.previewText || record.lineText || record.transcript || "（无台词）";
  return `${speaker}：${text}`;
}

export function HistoryPage() {
  const {
    historyRecords,
    historyTotalPages,
    historyFilter,
    setHistoryFilter,
    historyLoading,
    historyError,
    clearHistoryError,
  } = useAppState();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [activeRecord, setActiveRecord] = useState<string>(historyRecords[0]?.id ?? "");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<{ audio: HTMLAudioElement; cleanup: () => void } | null>(null);

  const stopPlayback = useCallback(() => {
    audioRef.current?.cleanup();
    audioRef.current = null;
    setPlayingId(null);
  }, []);

  useEffect(() => () => {
    audioRef.current?.cleanup();
    audioRef.current = null;
  }, []);

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const displayedRecords = useMemo(() => {
    if (!normalizedSearchQuery) return historyRecords;
    return historyRecords.filter((record) => recordSearchHaystack(record).includes(normalizedSearchQuery));
  }, [historyRecords, normalizedSearchQuery]);

  const taskGroups = useMemo(() => buildTaskHistoryGroups(displayedRecords), [displayedRecords]);
  const selectedGroup = useMemo(
    () => taskGroups.find((group) => group.groupId === selectedGroupId) ?? null,
    [taskGroups, selectedGroupId],
  );

  useEffect(() => {
    if (selectedGroupId && !selectedGroup) setSelectedGroupId(null);
  }, [selectedGroup, selectedGroupId]);

  useEffect(() => {
    const visibleRecords = selectedGroup ? selectedGroup.items : displayedRecords;
    if (visibleRecords.length === 0) {
      if (activeRecord) setActiveRecord("");
      return;
    }
    if (!visibleRecords.some((record) => record.id === activeRecord)) {
      setActiveRecord(visibleRecords[0].id);
    }
  }, [activeRecord, displayedRecords, selectedGroup]);

  const handlePlay = useCallback(async (recordId: string, audioUrl: string | null | undefined) => {
    if (!audioUrl) return;

    if (playingId === recordId && audioRef.current) {
      stopPlayback();
      return;
    }

    stopPlayback();

    try {
      const playback = await createAudioElementFromAsset(audioUrl);
      playback.audio.addEventListener("ended", () => stopPlayback(), { once: true });
      playback.audio.addEventListener("error", () => stopPlayback(), { once: true });
      audioRef.current = playback;
      setPlayingId(recordId);
      await playback.audio.play();
    } catch {
      stopPlayback();
    }
  }, [playingId, stopPlayback]);

  const handleDownload = useCallback(async (downloadUrl: string | null | undefined, fileName?: string) => {
    if (!downloadUrl) return;
    await downloadAudioAsset(downloadUrl, fileName);
  }, []);

  const totalPages = historyTotalPages;

  const activeFilters: string[] = [];
  if (historyFilter.voice) activeFilters.push(historyFilter.voice);
  if (historyFilter.status) activeFilters.push(historyFilter.status === "success" ? "成功" : historyFilter.status === "error" ? "错误" : "处理中");
  if (historyFilter.source) activeFilters.push(HISTORY_SOURCE_LABEL[historyFilter.source]);

  const clearFilters = useCallback(() => {
    setHistoryFilter({ voice: undefined, status: undefined, source: undefined, page: 1 });
    setSearchQuery("");
    setSelectedGroupId(null);
  }, [setHistoryFilter]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-11 px-4 flex items-center justify-between border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-3">
          <div className="relative">
            <input
              type="text"
              placeholder="搜索任务、角色或台词..."
              className="w-56 bg-bg-sunken border border-border rounded-md pl-7 pr-3 py-1 text-sm outline-none focus:border-border-focus text-text-primary placeholder:text-text-tertiary"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSelectedGroupId(null); }}
            />
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
          </div>
          <select
            className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-sm text-text-primary focus:border-border-focus"
            value={historyFilter.voice ?? ""}
            onChange={(e) => {
              setHistoryFilter({ voice: (e.target.value || undefined) as string | undefined, page: 1 });
              setSelectedGroupId(null);
            }}
          >
            <option value="">全部音色</option>
            <option value="Zephyr">Zephyr</option>
            <option value="Puck">Puck</option>
            <option value="Charon">Charon</option>
            <option value="Kore">Kore</option>
            <option value="Fenrir">Fenrir</option>
            <option value="Leda">Leda</option>
            <option value="alloy">alloy (legacy)</option>
          </select>
          <select
            className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-sm text-text-primary focus:border-border-focus"
            value={historyFilter.status ?? ""}
            onChange={(e) => {
              setHistoryFilter({
                status: (e.target.value || undefined) as HistoryStatus | undefined,
                page: 1,
              });
              setSelectedGroupId(null);
            }}
          >
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="error">错误</option>
            <option value="pending">处理中</option>
          </select>
          <select
            className="bg-bg-surface border border-border rounded px-2 py-1 outline-none text-sm text-text-primary focus:border-border-focus"
            value={historyFilter.source ?? ""}
            onChange={(e) => {
              setHistoryFilter({
                source: (e.target.value || undefined) as HistorySource | undefined,
                page: 1,
              });
              setSelectedGroupId(null);
            }}
          >
            <option value="">全部来源</option>
            <option value="user">用户</option>
            <option value="agent">Agent</option>
            <option value="cli">CLI</option>
          </select>
          {activeFilters.length > 0 && (
            <button
              className="text-text-tertiary hover:text-text-secondary transition-colors text-xs"
              onClick={clearFilters}
            >
              清除筛选
            </button>
          )}
        </div>

        {activeFilters.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            当前:
            {activeFilters.map((filterLabel, index) => (
              <span key={`${filterLabel}-${index}`} className="flex items-center gap-1 bg-bg-surface px-1.5 py-0.5 rounded border border-border">
                {filterLabel}
                <button
                  className="hover:text-text-primary"
                  onClick={() => {
                    if (filterLabel === historyFilter.voice) setHistoryFilter({ voice: undefined, page: 1 });
                    else if (filterLabel === "成功" || filterLabel === "错误" || filterLabel === "处理中") setHistoryFilter({ status: undefined, page: 1 });
                    else if (historyFilter.source && filterLabel === HISTORY_SOURCE_LABEL[historyFilter.source]) setHistoryFilter({ source: undefined, page: 1 });
                    setSelectedGroupId(null);
                  }}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {historyLoading && historyRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <Loader2 size={24} className="animate-spin text-text-tertiary mb-3" />
            <p className="text-text-tertiary text-sm">正在加载历史记录...</p>
          </div>
        ) : historyError && historyRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <AlertCircle size={24} className="text-error mb-3" />
            <p className="text-error text-sm font-medium">加载历史记录失败</p>
            <p className="text-text-tertiary text-xs mt-1">{historyError}</p>
            <button
              className="mt-4 flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-bg-surface border border-border hover:bg-bg-hover transition-colors"
              onClick={clearHistoryError}
            >
              <RefreshCw size={14} /> 重试
            </button>
          </div>
        ) : historyRecords.length === 0 && searchQuery === "" && !historyFilter.voice && !historyFilter.status && !historyFilter.source ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <p className="text-text-tertiary text-sm">暂无历史记录</p>
            <p className="text-text-tertiary text-xs mt-1">完成语音生成后记录将出现在此处</p>
          </div>
        ) : displayedRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <p className="text-text-tertiary text-sm">暂无匹配的历史记录</p>
            <p className="text-text-tertiary text-xs mt-1">调整筛选条件或清除筛选</p>
          </div>
        ) : (
          <>
            {historyError && historyRecords.length > 0 && (
              <div className="flex items-center gap-3 px-4 py-2 mb-1 rounded-md bg-error-muted/50 border border-error/20 text-sm">
                <AlertCircle size={16} className="text-error shrink-0" />
                <span className="text-error text-xs">刷新失败: {historyError}</span>
                <button
                  className="ml-auto flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
                  onClick={clearHistoryError}
                >
                  <RefreshCw size={12} /> 重试
                </button>
              </div>
            )}
            {historyLoading && historyRecords.length > 0 && (
              <div className="flex items-center gap-2 px-4 py-1.5 mb-1 rounded-md bg-accent-muted/30 border border-accent/10 text-xs text-text-tertiary">
                <Loader2 size={12} className="animate-spin" />
                正在刷新...
              </div>
            )}

            {selectedGroup ? (
              <section className="flex flex-col gap-2">
                <div className="rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle bg-bg-sunken/60 flex items-center gap-3">
                    <button
                      className="h-8 px-3 rounded border border-border bg-bg-base text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
                      onClick={() => setSelectedGroupId(null)}
                    >
                      <ArrowLeft size={14} /> 返回任务列表
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileAudio size={15} className="text-accent shrink-0" />
                        <h2 className="text-sm font-semibold text-text-primary truncate">{selectedGroup.taskTitle}</h2>
                        <span className="shrink-0 rounded border border-border-subtle bg-bg-base px-2 py-0.5 text-[10px] text-text-tertiary">
                          {selectedGroup.groupKind === "orphan" ? "无任务归属" : shortId(selectedGroup.taskId)}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-text-tertiary">
                        本页 {selectedGroup.audioCount} 条音频 · {statusSummaryLabel(selectedGroup.statusSummary)} · 最新 {formatTaskTime(selectedGroup.latestRecordAt)}
                      </p>
                    </div>
                  </div>

                  {selectedGroup.items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-center">
                      <p className="text-text-tertiary text-sm">该任务暂无音频历史</p>
                      <p className="text-text-tertiary text-xs mt-1">返回任务列表选择其他任务</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-[2px] p-2">
                      {selectedGroup.items.map((record) => (
                        <HistoryRecordRow
                          key={record.id}
                          record={record}
                          active={activeRecord === record.id}
                          playing={playingId === record.id}
                          onSelect={() => setActiveRecord(record.id)}
                          onPlay={() => void handlePlay(record.id, record.audioUrl)}
                          onDownload={() => void handleDownload(record.downloadUrl)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between px-2 py-1 text-xs text-text-tertiary">
                  <span>一级任务视图 · 本页 {taskGroups.length} 个任务分组</span>
                  <span>点击任务进入二级语音列表</span>
                </div>
                {taskGroups.map((group) => (
                  <TaskGroupCard key={group.groupId} group={group} onOpen={() => setSelectedGroupId(group.groupId)} />
                ))}
              </section>
            )}
          </>
        )}
      </div>

      <div className="h-10 px-4 flex items-center justify-center border-t border-border-subtle bg-bg-base shrink-0 text-sm text-text-secondary">
        <div className="flex items-center gap-4">
          <button
            className="hover:text-text-primary disabled:opacity-50"
            disabled={historyFilter.page <= 1}
            onClick={() => { setHistoryFilter({ page: historyFilter.page - 1 }); setSelectedGroupId(null); }}
          >
            {"<"}
          </button>
          <span>第 {historyFilter.page} 页 / 共 {totalPages} 页</span>
          <button
            className="hover:text-text-primary disabled:opacity-50"
            disabled={historyFilter.page >= totalPages}
            onClick={() => { setHistoryFilter({ page: historyFilter.page + 1 }); setSelectedGroupId(null); }}
          >
            {">"}
          </button>

          <span className="ml-4">每页</span>
          <select
            className="bg-bg-surface border border-border rounded px-1 py-0.5 outline-none text-text-primary text-xs"
            value={historyFilter.pageSize}
            onChange={(e) => { setHistoryFilter({ pageSize: Number(e.target.value), page: 1 }); setSelectedGroupId(null); }}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function TaskGroupCard({ group, onOpen }: { group: TaskHistoryGroup; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full rounded-lg border border-border-subtle bg-bg-surface hover:bg-bg-hover hover:border-border transition-colors text-left overflow-hidden"
    >
      <div className="px-4 py-3 flex items-center gap-4">
        <div className="h-10 w-10 rounded-lg border border-accent/20 bg-[linear-gradient(135deg,rgba(201,148,74,0.16),transparent_60%)] flex items-center justify-center text-accent shrink-0">
          <FolderOpen size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold text-text-primary truncate">{group.taskTitle}</h2>
            <span className="shrink-0 rounded border border-border-subtle bg-bg-sunken px-2 py-0.5 text-[10px] text-text-tertiary">
              {group.groupKind === "orphan" ? "无任务" : shortId(group.taskId)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-tertiary">
            <span>创建 {formatTaskTime(group.taskCreatedAt, "未知")}</span>
            <span className="w-px h-2.5 bg-border-subtle" />
            <span>更新 {formatTaskTime(group.taskUpdatedAt || group.latestRecordAt, "未知")}</span>
            <span className="w-px h-2.5 bg-border-subtle" />
            <span>本页 {group.audioCount} 条音频</span>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 shrink-0">
          <StatusCount label="成功" count={group.statusSummary.success} status="success" />
          <StatusCount label="错误" count={group.statusSummary.error} status="error" />
          <StatusCount label="处理中" count={group.statusSummary.pending} status="pending" />
        </div>
        <ChevronRight size={16} className="text-text-tertiary group-hover:text-accent transition-colors shrink-0" />
      </div>
    </button>
  );
}

function StatusCount({ label, count, status }: { label: string; count: number; status: HistoryStatus }) {
  return (
    <span className={`rounded border px-2 py-1 text-[10px] ${HISTORY_STATUS_META[status].badge}`}>
      {label} {count}
    </span>
  );
}

function HistoryRecordRow({
  record,
  active,
  playing,
  onSelect,
  onPlay,
  onDownload,
}: {
  record: HistoryRecord;
  active: boolean;
  playing: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onDownload: () => void;
}) {
  const canPlay = record.status === "success" && Boolean(record.audioUrl);
  const canDownload = record.status === "success" && Boolean(record.downloadUrl);

  return (
    <div
      className={`group flex items-center px-4 min-h-16 rounded-md cursor-pointer transition-colors ${
        active ? "bg-accent-subtle" : "hover:bg-bg-hover"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center w-6 shrink-0">
        <div className={`w-2 h-2 rounded-full ${HISTORY_STATUS_META[record.status].dot}`} />
      </div>

      <div className="flex-1 min-w-0 pr-4 py-2">
        <div className="text-sm text-text-primary truncate font-medium" title={previewLine(record)}>
          {previewLine(record)}
        </div>
        <div className="text-xs text-text-tertiary flex flex-wrap items-center gap-2 mt-1">
          <span className="text-text-secondary">{record.voice}</span>
          <span className="w-px h-2.5 bg-border-subtle" />
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${HISTORY_STATUS_META[record.status].badge}`}>
            {record.status === "error" ? `错误${record.error ? `: ${record.error}` : ""}` : HISTORY_STATUS_META[record.status].label}
          </span>
          <span className="w-px h-2.5 bg-border-subtle" />
          <span>{record.format}</span>
          <span className="w-px h-2.5 bg-border-subtle" />
          <span>{record.date}</span>
          <span className="w-px h-2.5 bg-border-subtle" />
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${HISTORY_SOURCE_BADGE_CLASS[record.source]}`}>{HISTORY_SOURCE_LABEL[record.source]}</span>
          <span className="px-1.5 py-0.5 rounded border border-border-subtle bg-bg-sunken text-[10px] text-text-tertiary">{PREVIEW_SOURCE_LABEL[record.previewSource]}</span>
          {record.status === "success" && record.durationMs != null && (
            <>
              <span className="w-px h-2.5 bg-border-subtle" />
              <span>{(record.durationMs / 1000).toFixed(1)}s</span>
            </>
          )}
        </div>
      </div>

      <div className={`flex items-center gap-1 shrink-0 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
        {record.status === "success" ? (
          <>
            <button
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                playing
                  ? "text-accent bg-accent-subtle"
                  : canPlay
                    ? "text-text-secondary hover:text-text-primary hover:bg-bg-surface"
                    : "text-text-tertiary cursor-not-allowed"
              }`}
              title={playing ? "停止" : "播放"}
              disabled={!canPlay}
              onClick={(event) => { event.stopPropagation(); onPlay(); }}
            >
              {playing ? <Square size={16} /> : <Play size={16} />}
            </button>
            <button
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                canDownload
                  ? "text-text-secondary hover:text-text-primary hover:bg-bg-surface"
                  : "text-text-tertiary cursor-not-allowed"
              }`}
              title="下载"
              disabled={!canDownload}
              onClick={(event) => { event.stopPropagation(); onDownload(); }}
            >
              <Download size={16} />
            </button>
            <button className="w-8 h-8 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors" title="复制参数" onClick={(event) => event.stopPropagation()}>
              <Copy size={16} />
            </button>
          </>
        ) : (
          <button className="px-3 py-1.5 text-xs font-medium bg-bg-surface border border-border rounded hover:bg-bg-hover transition-colors" onClick={(event) => event.stopPropagation()}>
            重试
          </button>
        )}
        <Link to={`/history/${record.id}`} className="w-8 h-8 rounded flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent-subtle transition-colors ml-1" title="详情" onClick={(event) => event.stopPropagation()}>
          <ChevronRight size={16} />
        </Link>
      </div>
    </div>
  );
}
