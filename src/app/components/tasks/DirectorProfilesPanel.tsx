import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Loader2, Plus, RefreshCw, Save, Search, Users } from "lucide-react";
import { taskApi } from "../../services/httpAdapter";
import { useAppState } from "../../state/AppContext";
import type { DirectorProfile, DirectorSpeakerProfile, VoiceLine } from "../../types";
import { findForbiddenStyleWords, formatForbiddenStyleWarning, getForbiddenMatchesForField } from "../../utils/forbiddenStyleWords";
import type { ForbiddenStyleUiMatch } from "../../utils/forbiddenStyleWords";
import { formatVoiceOptionLabel } from "../../utils/voiceDisplay";

type Phase = "idle" | "loading" | "saving" | "success" | "error";

const CONTROL_CLASS = "w-full bg-bg-base border border-border rounded px-2 py-1.5 text-xs text-text-primary outline-none focus:border-border-focus resize-none";

function emptySpeaker(id: string, label: string): DirectorSpeakerProfile {
  return { id, label, name: "", voice: "Zephyr", style: "" };
}

function emptyProfile(taskId: string): Partial<DirectorProfile> {
  return {
    taskId,
    source: "global",
    name: "新导演配置",
    audioProfile: "",
    scene: "",
    directorNotes: "",
    style: "",
    pacing: "",
    accent: "",
    emotion: "",
    performanceNotes: "",
    sampleContext: "",
    speakers: [emptySpeaker("a", "Speaker A")],
  };
}

export function DirectorProfilesPanel({
  taskId,
  profiles,
  productionLines = [],
  loading = false,
  loadError = null,
  onProfilesChange,
  onReload,
}: {
  taskId: string;
  profiles: DirectorProfile[];
  productionLines?: VoiceLine[];
  loading?: boolean;
  loadError?: string | null;
  onProfilesChange?: (profiles: DirectorProfile[]) => void;
  onReload?: () => void | Promise<void>;
}) {
  const { voices } = useAppState();
  const [selectedId, setSelectedId] = useState<string | "new">("new");
  const [draft, setDraft] = useState<Partial<DirectorProfile>>(emptyProfile(taskId));
  const [initializedTaskId, setInitializedTaskId] = useState<string | null>(null);
  const [autoSelectedTaskId, setAutoSelectedTaskId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const voiceOptions = useMemo(() => voices.length > 0 ? voices.map((voice) => voice.name) : ["Zephyr", "Puck", "Kore"], [voices]);
  const bindingMap = useMemo(() => buildProfileBindingMap(productionLines), [productionLines]);
  const selectedBinding = selectedId === "new" ? null : bindingMap.get(selectedId) ?? null;
  const filteredProfiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((profile) => [profile.name, profile.audioProfile, profile.scene, profile.directorNotes, profile.style, profile.pacing, profile.accent, profile.emotion, profile.performanceNotes, profile.speakers.map((speaker) => `${speaker.name} ${speaker.voice} ${speaker.style ?? ""}`).join(" ")].join(" ").toLowerCase().includes(q));
  }, [profiles, search]);

  useEffect(() => {
    if (initializedTaskId === taskId) return;
    setInitializedTaskId(taskId);
    setAutoSelectedTaskId(null);
    setSelectedId("new");
    setDraft(emptyProfile(taskId));
    setError(null);
    setSuccess(null);
  }, [initializedTaskId, taskId]);

  useEffect(() => {
    if (autoSelectedTaskId === taskId || profiles.length === 0 || selectedId !== "new") return;
    setSelectedId(profiles[0].id);
    setDraft(profiles[0]);
    setAutoSelectedTaskId(taskId);
  }, [autoSelectedTaskId, profiles, selectedId, taskId]);

  useEffect(() => {
    if (selectedId === "new") return;
    const latest = profiles.find((profile) => profile.id === selectedId);
    if (latest) {
      if (latest.source === "production-list") setDraft(latest);
      return;
    }
    if (profiles.length > 0) {
      setSelectedId(profiles[0].id);
      setDraft(profiles[0]);
    } else {
      setSelectedId("new");
      setDraft(emptyProfile(taskId));
    }
  }, [profiles, selectedId, taskId]);

  useEffect(() => {
    if (loadError) setError(loadError);
  }, [loadError]);

  const selectProfile = (id: string | "new") => {
    setSelectedId(id);
    setDraft(id === "new" ? emptyProfile(taskId) : profiles.find((profile) => profile.id === id) ?? emptyProfile(taskId));
    setError(null);
    setSuccess(null);
  };

  const updateSpeaker = (speakerId: string, patch: Partial<DirectorSpeakerProfile>) => {
    setDraft((prev) => ({
      ...prev,
      speakers: (prev.speakers ?? []).map((speaker) => speaker.id === speakerId ? { ...speaker, ...patch } : speaker),
    }));
  };

  const addSpeaker = () => {
    const speakers = draft.speakers ?? [];
    if (speakers.length >= 2) return;
    setDraft((prev) => ({ ...prev, speakers: [...speakers, emptySpeaker("b", "Speaker B")] }));
  };

  const removeSpeaker = (speakerId: string) => {
    setDraft((prev) => ({ ...prev, speakers: (prev.speakers ?? []).filter((speaker) => speaker.id !== speakerId) }));
  };

  const save = async () => {
    if (draft.source === "production-list") {
      setError("来自当前生产列表的配置为只读，不能保存为全局导演配置");
      return;
    }
    if (!draft.name?.trim()) {
      setError("请填写配置名称");
      return;
    }
    if ((draft.speakers ?? []).length > 2) {
      setError("最多支持 2 位 speakers");
      return;
    }
    const binding = selectedId === "new" ? null : bindingMap.get(selectedId);
    if (binding && binding.count > 1) {
      const confirmed = window.confirm(`此配置被 ${binding.count} 条语音共享（行号 ${binding.lineNumbers.join(", ")}）。确认保存共享配置并影响所有绑定行？`);
      if (!confirmed) return;
    }
    setPhase("saving");
    setError(null);
    setSuccess(null);
    try {
      const saved = selectedId === "new"
        ? await taskApi.createDirectorProfile(taskId, draft)
        : await taskApi.updateDirectorProfile(taskId, selectedId, draft.version ?? 0, draft);
      const next = selectedId === "new"
        ? [saved, ...profiles]
        : profiles.map((profile) => profile.id === saved.id ? saved : profile);
      onProfilesChange?.(next);
      setSelectedId(saved.id);
      setDraft(saved);
      setSuccess("导演配置已保存");
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导演配置保存失败");
      setPhase("error");
    }
  };

  const duplicateSelectedProfile = async () => {
    if (selectedId === "new") {
      setError("请先选择一个已有导演配置再复制");
      return;
    }
    const source = profiles.find((profile) => profile.id === selectedId);
    if (!source) return;
    setPhase("saving");
    setError(null);
    setSuccess(null);
    try {
      const saved = await taskApi.createDirectorProfile(taskId, {
        source: "global",
        name: `${source.name} - 独立副本 ${new Date().toLocaleTimeString("zh-CN")}`,
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
      onProfilesChange?.([saved, ...profiles]);
      setSelectedId(saved.id);
      setDraft(saved);
      setSuccess("已复制为新的全局导演配置；未自动修改任何生产行绑定。");
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制导演配置失败");
      setPhase("error");
    }
  };

  const isProductionListProfile = selectedId !== "new" && draft.source === "production-list";
  const canEdit = !isProductionListProfile;
  const savingDisabled = phase === "saving" || isProductionListProfile;
  const forbiddenMatches = useMemo(() => findForbiddenStyleWords([
    { field: "audioProfile", value: draft.audioProfile },
    { field: "style", value: draft.style },
    { field: "pacing", value: draft.pacing },
    { field: "performanceNotes", value: draft.performanceNotes },
    { field: "directorNotes", value: draft.directorNotes },
    ...(draft.speakers ?? []).map((speaker, index) => ({ field: `speakers[${index}].style`, value: speaker.style })),
  ]), [draft.audioProfile, draft.style, draft.pacing, draft.performanceNotes, draft.directorNotes, draft.speakers]);
  const getLocalForbiddenMatches = useCallback(
    (field: string) => getForbiddenMatchesForField(forbiddenMatches, field),
    [forbiddenMatches],
  );

  return (
    <section className="h-full min-h-0 min-w-0 overflow-hidden grid grid-cols-[240px_minmax(0,1fr)] min-[1200px]:grid-cols-[270px_minmax(0,1fr)] min-[1440px]:grid-cols-[300px_minmax(0,1fr)] border border-border-subtle bg-bg-surface">
      <aside className="min-w-0 min-h-0 overflow-hidden border-r border-border-subtle bg-bg-sunken/70 flex flex-col">
        <div className="min-h-11 px-3 py-2 border-b border-border-subtle flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex items-center gap-2 text-sm font-semibold"><Users size={15} className="shrink-0" /> <span className="truncate">导演配置</span></div>
          <div className="flex items-center gap-2">
            {onReload && <button className="text-xs text-text-tertiary hover:text-text-primary flex items-center gap-1 disabled:opacity-50" onClick={() => void onReload()} disabled={loading}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> 刷新</button>}
            <button className="text-xs text-accent hover:text-accent-hover flex items-center gap-1" onClick={() => selectProfile("new")}><Plus size={13} /> 新建</button>
          </div>
        </div>
        <div className="p-3 [@media(max-height:760px)]:p-2 border-b border-border-subtle flex flex-col gap-2">
          <label className="relative flex items-center">
            <Search size={12} className="absolute left-2 text-text-tertiary" />
            <input className="w-full h-8 bg-bg-base border border-border rounded pl-7 pr-2 text-xs outline-none focus:border-border-focus" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索配置、场景、音色" />
          </label>
          <div className="text-[10px] text-warning bg-warning-muted/30 border border-warning/20 rounded px-2 py-1">MVP 阶段最多 2 位 speakers，超出需拆分为多条生产行。</div>
        </div>
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
          {loading && profiles.length === 0 && <PanelNote text="正在加载导演配置" loading />}
          {!loading && profiles.length === 0 && <PanelNote text="暂无导演配置" hint="创建后可在生产行中引用" />}
          {!loading && profiles.length > 0 && filteredProfiles.length === 0 && <PanelNote text="没有匹配的导演配置" hint="请调整搜索关键词" />}
          {filteredProfiles.map((profile) => {
            const binding = bindingMap.get(profile.id);
            return <button key={profile.id} className={`w-full text-left px-3 py-3 border-b border-border-subtle hover:bg-bg-hover ${selectedId === profile.id ? "bg-accent-subtle" : ""}`} onClick={() => selectProfile(profile.id)}>
              <div className="text-sm font-medium truncate">{profile.name}</div>
              <div className="text-[10px] text-text-tertiary mt-1">{profile.speakers?.length ?? 0} 位说话者 · v{profile.version} · {profile.source === "production-list" ? "当前生产列表/只读" : "全局配置"}</div>
              <div className="mt-1 text-[10px] text-text-secondary">绑定语音: {binding?.count ?? 0} 条{binding && binding.lineNumbers.length > 0 ? ` · 行号 ${binding.lineNumbers.slice(0, 6).map((n) => String(n).padStart(2, "0")).join(", ")}${binding.lineNumbers.length > 6 ? "..." : ""}` : ""}</div>
            </button>;
          })}
        </div>
      </aside>

      <main className="min-w-0 min-h-0 overflow-hidden flex flex-col">
        <header className="min-h-11 px-4 py-2 border-b border-border-subtle flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold">{selectedId === "new" ? "新建配置" : isProductionListProfile ? "只读配置" : "编辑配置"}</div>
            {isProductionListProfile && <span className="px-2 py-0.5 rounded border border-warning/30 bg-warning-muted text-[10px] text-warning">来自当前生产列表/只读</span>}
            {selectedBinding && <span className="px-2 py-0.5 rounded border border-border bg-bg-sunken text-[10px] text-text-secondary">绑定 {selectedBinding.count} 行</span>}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button className="px-3 py-1.5 rounded border border-border text-xs hover:bg-bg-hover disabled:opacity-50 flex items-center gap-1" onClick={() => void duplicateSelectedProfile()} disabled={selectedId === "new" || phase === "saving"}><Copy size={13} /> 复制为独立配置</button>
            <button className="px-4 py-1.5 rounded bg-accent text-bg-base text-xs font-semibold hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1" onClick={save} disabled={savingDisabled} title={isProductionListProfile ? "来自当前生产列表的配置不能写入全局导演配置" : "保存全局导演配置"}>{phase === "saving" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {isProductionListProfile ? "只读不可保存" : "保存配置"}</button>
          </div>
        </header>

        {isProductionListProfile && <div className="mx-4 mt-3 px-3 py-2 rounded border border-warning/20 bg-warning-muted/30 text-xs text-warning">此配置来自当前任务的生产列表，仅用于查看和生产行绑定。为避免覆盖全局配置，本页不会调用全局导演配置保存接口。</div>}
        {selectedBinding && selectedBinding.count > 1 && <div className="mx-4 mt-3 px-3 py-2 rounded border border-warning/20 bg-warning-muted/30 text-xs text-warning">此配置被 {selectedBinding.count} 条语音共享，行号：{selectedBinding.lineNumbers.join(", ")}。直接保存会影响所有绑定行；保存前将再次确认。</div>}
        {selectedBinding && selectedBinding.count > 0 && selectedBinding.count <= 1 && <div className="mx-4 mt-3 px-3 py-2 rounded border border-border-subtle bg-bg-sunken text-xs text-text-secondary">绑定语音行号：{selectedBinding.lineNumbers.join(", ")}</div>}

        {(error || success) && <div className={`mx-4 mt-3 px-3 py-2 rounded border text-xs flex items-center gap-2 ${error ? "bg-error-muted border-error/20 text-error" : "bg-success-muted border-success/20 text-success"}`}>{error ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}{error || success}</div>}
        {forbiddenMatches.length > 0 && <div className="mx-4 mt-3 px-3 py-2 rounded border border-warning/20 bg-warning-muted/30 text-xs text-warning flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{formatForbiddenStyleWarning(forbiddenMatches)} 此提示不阻断保存；只读配置仅展示提醒。</span></div>}

        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-4 [@media(max-height:760px)]:p-3 grid grid-cols-1 min-[1200px]:grid-cols-2 gap-4 content-start">
          <Field label="配置名称" className="min-[1200px]:col-span-2"><input className={CONTROL_CLASS} value={draft.name ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} disabled={!canEdit} /></Field>
          <Field label="音频画像"><div className="rounded border border-border-subtle bg-bg-sunken px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary">建议包含角色身份、年龄感、声线质地、说话距离和情绪底色；优先写 close-mic、grounded confidence、gentle smile in the voice 这类具体表达。</div><textarea className={`${CONTROL_CLASS} h-28 [@media(max-height:760px)]:h-20`} value={draft.audioProfile ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, audioProfile: event.target.value }))} disabled={!canEdit} placeholder="例如：Warm late-30s documentary narrator, close-mic, grounded confidence..." /><FieldForbiddenWarning matches={getLocalForbiddenMatches("audioProfile")} /></Field>
          <Field label="场景"><textarea className={`${CONTROL_CLASS} h-28 [@media(max-height:760px)]:h-20`} value={draft.scene ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, scene: event.target.value }))} disabled={!canEdit} placeholder="未设置" /></Field>

          <div className="min-[1200px]:col-span-2 border border-border-subtle rounded-md bg-[linear-gradient(135deg,rgba(201,148,74,0.08),transparent_38%),var(--color-bg-sunken)] p-3">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-text-primary">表演风格参数</div>
                <div className="mt-1 text-[10px] text-text-tertiary">Profile 级导演控制字段；优先写具体动作、距离感、停顿，不写 quiet/flat/安静/平淡。</div>
              </div>
              <span className="rounded border border-border-subtle bg-bg-base px-2 py-1 text-[10px] text-text-tertiary">Gemini input 五要素</span>
            </div>
            <div className="grid grid-cols-1 min-[1200px]:grid-cols-2 gap-3">
              <Field label="表演风格"><input className={CONTROL_CLASS} value={draft.style ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, style: event.target.value }))} disabled={!canEdit} placeholder="未设置，例如克制但有重点、贴近叙述" /><FieldForbiddenWarning matches={getLocalForbiddenMatches("style")} /></Field>
              <Field label="语速节奏"><input className={CONTROL_CLASS} value={draft.pacing ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, pacing: event.target.value }))} disabled={!canEdit} placeholder="未设置，例如关键句前停顿、层次分明" /><FieldForbiddenWarning matches={getLocalForbiddenMatches("pacing")} /></Field>
              <Field label="口音发音"><input className={CONTROL_CLASS} value={draft.accent ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, accent: event.target.value }))} disabled={!canEdit} placeholder="未设置，例如清晰咬字、轻微地域口音" /></Field>
              <Field label="情绪基调"><input className={CONTROL_CLASS} value={draft.emotion ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, emotion: event.target.value }))} disabled={!canEdit} placeholder="未设置，例如克制愤怒、温柔安抚" /></Field>
              <Field label="表演备注" className="min-[1200px]:col-span-2"><textarea className={`${CONTROL_CLASS} h-20`} value={draft.performanceNotes ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, performanceNotes: event.target.value }))} disabled={!canEdit} placeholder="未设置，填写无法归类的导演表演提示" /><FieldForbiddenWarning matches={getLocalForbiddenMatches("performanceNotes")} /></Field>
            </div>
          </div>

          <Field label="导演备注（兼容旧字段）"><textarea className={`${CONTROL_CLASS} h-28 [@media(max-height:760px)]:h-20`} value={draft.directorNotes ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, directorNotes: event.target.value }))} disabled={!canEdit} placeholder="旧配置仍会作为表演备注进入 prompt" /><FieldForbiddenWarning matches={getLocalForbiddenMatches("directorNotes")} /></Field>
          <Field label="示例上下文"><textarea className={`${CONTROL_CLASS} h-28 [@media(max-height:760px)]:h-20`} value={draft.sampleContext ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, sampleContext: event.target.value }))} disabled={!canEdit} placeholder="未设置" /></Field>

          <div className="min-[1200px]:col-span-2 border border-border-subtle rounded-md bg-bg-sunken p-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold">说话者</span>
              <button className="text-xs text-accent disabled:text-text-tertiary flex items-center gap-1" onClick={addSpeaker} disabled={!canEdit || (draft.speakers ?? []).length >= 2}><Plus size={12} /> 添加说话者</button>
            </div>
            <div className="grid grid-cols-1 min-[1200px]:grid-cols-2 gap-3">
              {(draft.speakers ?? []).map((speaker, index) => (
                <div key={speaker.id} className="border border-border rounded-md bg-bg-base p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between text-xs font-semibold"><span>{displaySpeakerLabel(speaker.label)}</span>{speaker.id !== "a" && <button className="text-error disabled:text-text-tertiary" onClick={() => removeSpeaker(speaker.id)} disabled={!canEdit}>移除</button>}</div>
                  <input className={CONTROL_CLASS} placeholder="角色名" value={speaker.name} onChange={(event) => updateSpeaker(speaker.id, { name: event.target.value })} disabled={!canEdit} />
                  <select className={CONTROL_CLASS} value={speaker.voice} onChange={(event) => updateSpeaker(speaker.id, { voice: event.target.value })} disabled={!canEdit}>{voiceOptions.map((voice) => <option key={voice} value={voice}>{formatVoiceOptionLabel(voice)}</option>)}</select>
                  <input className={CONTROL_CLASS} placeholder="角色风格，未设置则继承 profile" value={speaker.style ?? ""} onChange={(event) => updateSpeaker(speaker.id, { style: event.target.value })} disabled={!canEdit} />
                  <FieldForbiddenWarning matches={getLocalForbiddenMatches(`speakers[${index}].style`)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </section>
  );
}

function displaySpeakerLabel(label: string): string {
  const match = label.match(/^Speaker\s+([A-Z])$/i);
  return match ? `说话者 ${match[1].toUpperCase()}` : label;
}

function buildProfileBindingMap(lines: VoiceLine[]) {
  const map = new Map<string, { count: number; lineIds: string[]; lineNumbers: number[] }>();
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

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`flex flex-col gap-1.5 text-xs text-text-tertiary ${className}`}><span>{label}</span>{children}</label>;
}

function FieldForbiddenWarning({ matches }: { matches: ForbiddenStyleUiMatch[] }) {
  if (matches.length === 0) return null;
  return <div className="flex items-start gap-1.5 rounded border border-warning/20 bg-warning-muted/30 px-2 py-1.5 text-[10px] leading-relaxed text-warning"><AlertTriangle size={12} className="mt-0.5 shrink-0" /><span>{formatForbiddenStyleWarning(matches)}</span></div>;
}

function PanelNote({ text, hint, loading }: { text: string; hint?: string; loading?: boolean }) {
  return <div className="h-40 flex flex-col items-center justify-center gap-2 text-text-tertiary text-xs">{loading && <Loader2 size={16} className="animate-spin" />}<span>{text}</span>{hint && <span className="text-[10px]">{hint}</span>}</div>;
}
