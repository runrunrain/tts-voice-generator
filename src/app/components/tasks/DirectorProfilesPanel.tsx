import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, Save, Users } from "lucide-react";
import { taskApi } from "../../services/httpAdapter";
import { useAppState } from "../../state/AppContext";
import type { DirectorProfile, DirectorSpeakerProfile } from "../../types";

type Phase = "idle" | "loading" | "saving" | "success" | "error";

const CONTROL_CLASS = "w-full bg-bg-base border border-border rounded px-2 py-1.5 text-xs text-text-primary outline-none focus:border-border-focus resize-none";

function emptySpeaker(id: string, label: string): DirectorSpeakerProfile {
  return { id, label, name: "", voice: "Zephyr", style: "" };
}

function emptyProfile(taskId: string): Partial<DirectorProfile> {
  return {
    taskId,
    name: "新导演配置",
    audioProfile: "",
    scene: "",
    directorNotes: "",
    sampleContext: "",
    speakers: [emptySpeaker("a", "Speaker A")],
  };
}

export function DirectorProfilesPanel({ taskId, onProfilesChange }: { taskId: string; onProfilesChange?: (profiles: DirectorProfile[]) => void }) {
  const { voices } = useAppState();
  const [profiles, setProfiles] = useState<DirectorProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | "new">("new");
  const [draft, setDraft] = useState<Partial<DirectorProfile>>(emptyProfile(taskId));
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const voiceOptions = useMemo(() => voices.length > 0 ? voices.map((voice) => voice.name) : ["Zephyr", "Puck", "Kore"], [voices]);

  const loadProfiles = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const result = await taskApi.listDirectorProfiles(taskId);
      const list = result.profiles ?? [];
      setProfiles(list);
      onProfilesChange?.(list);
      if (list.length > 0) {
        setSelectedId(list[0].id);
        setDraft(list[0]);
      } else {
        setSelectedId("new");
        setDraft(emptyProfile(taskId));
      }
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导演配置加载失败");
      setPhase("error");
    }
  }, [onProfilesChange, taskId]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

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
    if (!draft.name?.trim()) {
      setError("请填写配置名称");
      return;
    }
    if ((draft.speakers ?? []).length > 2) {
      setError("最多支持 2 位 speakers");
      return;
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
      setProfiles(next);
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

  return (
    <section className="h-full min-h-[520px] grid grid-cols-[300px_1fr] border border-border-subtle bg-bg-surface">
      <aside className="border-r border-border-subtle bg-bg-sunken/70 flex flex-col">
        <div className="h-11 px-3 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold"><Users size={15} /> 导演配置</div>
          <button className="text-xs text-accent hover:text-accent-hover flex items-center gap-1" onClick={() => selectProfile("new")}><Plus size={13} /> 新建</button>
        </div>
        <div className="p-3 border-b border-border-subtle text-[10px] text-warning bg-warning-muted/30">MVP 阶段最多 2 位 speakers，超出需拆分为多条生产行。</div>
        <div className="flex-1 overflow-y-auto">
          {phase === "loading" && profiles.length === 0 && <PanelNote text="正在加载导演配置" loading />}
          {phase !== "loading" && profiles.length === 0 && <PanelNote text="暂无导演配置" hint="创建后可在生产行中引用" />}
          {profiles.map((profile) => (
            <button key={profile.id} className={`w-full text-left px-3 py-3 border-b border-border-subtle hover:bg-bg-hover ${selectedId === profile.id ? "bg-accent-subtle" : ""}`} onClick={() => selectProfile(profile.id)}>
              <div className="text-sm font-medium truncate">{profile.name}</div>
              <div className="text-[10px] text-text-tertiary mt-1">{profile.speakers?.length ?? 0} speakers · v{profile.version}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex flex-col">
        <header className="h-11 px-4 border-b border-border-subtle flex items-center justify-between">
          <div className="text-sm font-semibold">{selectedId === "new" ? "新建配置" : "编辑配置"}</div>
          <button className="px-4 py-1.5 rounded bg-accent text-bg-base text-xs font-semibold hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1" onClick={save} disabled={phase === "saving"}>{phase === "saving" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存配置</button>
        </header>

        {(error || success) && <div className={`mx-4 mt-3 px-3 py-2 rounded border text-xs flex items-center gap-2 ${error ? "bg-error-muted border-error/20 text-error" : "bg-success-muted border-success/20 text-success"}`}>{error ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}{error || success}</div>}

        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-4 content-start">
          <Field label="配置名称" className="col-span-2"><input className={CONTROL_CLASS} value={draft.name ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} /></Field>
          <Field label="Audio Profile"><textarea className={`${CONTROL_CLASS} h-28`} value={draft.audioProfile ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, audioProfile: event.target.value }))} /></Field>
          <Field label="Scene"><textarea className={`${CONTROL_CLASS} h-28`} value={draft.scene ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, scene: event.target.value }))} /></Field>
          <Field label="Director Notes"><textarea className={`${CONTROL_CLASS} h-28`} value={draft.directorNotes ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, directorNotes: event.target.value }))} /></Field>
          <Field label="Sample Context"><textarea className={`${CONTROL_CLASS} h-28`} value={draft.sampleContext ?? ""} onChange={(event) => setDraft((prev) => ({ ...prev, sampleContext: event.target.value }))} /></Field>

          <div className="col-span-2 border border-border-subtle rounded-md bg-bg-sunken p-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold">Speakers</span>
              <button className="text-xs text-accent disabled:text-text-tertiary flex items-center gap-1" onClick={addSpeaker} disabled={(draft.speakers ?? []).length >= 2}><Plus size={12} /> 添加 speaker</button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(draft.speakers ?? []).map((speaker) => (
                <div key={speaker.id} className="border border-border rounded-md bg-bg-base p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between text-xs font-semibold"><span>{speaker.label}</span>{speaker.id !== "a" && <button className="text-error" onClick={() => removeSpeaker(speaker.id)}>移除</button>}</div>
                  <input className={CONTROL_CLASS} placeholder="角色名" value={speaker.name} onChange={(event) => updateSpeaker(speaker.id, { name: event.target.value })} />
                  <select className={CONTROL_CLASS} value={speaker.voice} onChange={(event) => updateSpeaker(speaker.id, { voice: event.target.value })}>{voiceOptions.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select>
                  <input className={CONTROL_CLASS} placeholder="风格" value={speaker.style ?? ""} onChange={(event) => updateSpeaker(speaker.id, { style: event.target.value })} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </section>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`flex flex-col gap-1.5 text-xs text-text-tertiary ${className}`}><span>{label}</span>{children}</label>;
}

function PanelNote({ text, hint, loading }: { text: string; hint?: string; loading?: boolean }) {
  return <div className="h-40 flex flex-col items-center justify-center gap-2 text-text-tertiary text-xs">{loading && <Loader2 size={16} className="animate-spin" />}<span>{text}</span>{hint && <span className="text-[10px]">{hint}</span>}</div>;
}
