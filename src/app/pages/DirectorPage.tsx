import { useState, useCallback, useEffect } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2, Loader2 } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { AudioFormat, SpeakerConfig } from "../types";

const VOICE_OPTIONS = ["alloy", "echo", "nova", "shimmer", "fable", "onyx"];

const EMOTION_TAGS = ["[happy]", "[sad]", "[excited]", "[calm]", "[angry]", "[nervous]", "[proud]"];
const EXPRESS_TAGS = ["[slow]", "[fast]", "[pause]", "[whisper]", "[shout]", "[sigh]", "[laugh]"];
const PARA_TAGS = {"情绪": EMOTION_TAGS, "表达": EXPRESS_TAGS, "副语言": ["[breath]", "[cough]", "[giggle]", "[gasp]", "[yawn]"]};

export function DirectorPage() {
  const { generate, generatePhase, generateResult, resetGeneration, estimateCost, costEstimate, settings } = useAppState();

  // Director fields
  const [audioProfile, setAudioProfile] = useState("");
  const [scene, setScene] = useState("");
  const [directorNotes, setDirectorNotes] = useState("");
  const [transcript, setTranscript] = useState("");

  // Config
  const [voice, setVoice] = useState(settings.defaultVoice);
  const [format, setFormat] = useState<AudioFormat>(settings.defaultFormat);

  // Speakers
  const [speakers, setSpeakers] = useState<SpeakerConfig[]>([
    { id: "a", label: "Speaker A", name: "主持人", voice: "alloy", style: "专业、沉稳" },
  ]);

  // Collapse state for each section
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Tag insertion
  const [activeTagTab, setActiveTagTab] = useState<"情绪" | "表达" | "副语言">("情绪");
  const insertTag = (tag: string) => {
    setTranscript((prev) => prev + (prev.length > 0 && !prev.endsWith(" ") ? " " : "") + tag + " ");
  };

  // Build prompt and store in sessionStorage for RightPanel
  useEffect(() => {
    const parts: string[] = [];
    if (audioProfile.trim()) parts.push(`<audio_profile>\n${audioProfile.trim()}\n</audio_profile>`);
    if (scene.trim()) parts.push(`<scene>\n${scene.trim()}\n</scene>`);
    if (directorNotes.trim()) parts.push(`<director_notes>\n${directorNotes.trim()}\n</director_notes>`);
    if (speakers.length > 0) {
      const speakerLines = speakers.map((s) => `  ${s.label} (${s.name}): voice=${s.voice}, style="${s.style}"`).join("\n");
      parts.push(`<speakers>\n${speakerLines}\n</speakers>`);
    }
    if (transcript.trim()) parts.push(`<transcript>\n${transcript.trim()}\n</transcript>`);

    const fullPrompt = parts.join("\n\n");
    const tokenEstimate = Math.ceil(fullPrompt.length / 4);

    try {
      sessionStorage.setItem("director-prompt", JSON.stringify({ fullPrompt, tokenEstimate }));
    } catch {
      // ignore
    }
  }, [audioProfile, scene, directorNotes, transcript, speakers]);

  // Cost estimation
  useEffect(() => {
    estimateCost(transcript.length, format);
  }, [transcript.length, format, estimateCost]);

  // Speaker management
  const addSpeaker = useCallback(() => {
    const id = String.fromCharCode(97 + speakers.length); // b, c, d...
    setSpeakers((prev) => [
      ...prev,
      { id, label: `Speaker ${id.toUpperCase()}`, name: "", voice: "alloy", style: "" },
    ]);
  }, [speakers.length]);

  const removeSpeaker = useCallback((id: string) => {
    setSpeakers((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const updateSpeaker = useCallback((id: string, field: keyof SpeakerConfig, value: string) => {
    setSpeakers((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }, []);

  // Generate
  const handleGenerate = useCallback(async () => {
    if (transcript.trim().length === 0 || generatePhase === "loading") return;
    await generate({
      text: transcript.trim(),
      voice,
      format,
      speakers,
      audioProfile,
      scene,
      directorNotes,
    });
  }, [transcript, voice, format, speakers, audioProfile, scene, directorNotes, generatePhase, generate]);

  const handleReset = useCallback(() => {
    resetGeneration();
  }, [resetGeneration]);

  // Section component
  const Section = ({ id, icon, title, children }: { id: string; icon: React.ReactNode; title: string; children: React.ReactNode }) => {
    const isCollapsed = collapsed[id] ?? false;
    return (
      <div className={`border rounded-lg bg-bg-surface overflow-hidden ${isCollapsed ? "" : "flex-1 flex flex-col min-h-[120px]"}`}>
        <div
          className="h-9 px-3 flex items-center justify-between border-b border-border-subtle cursor-pointer hover:bg-bg-hover transition-colors shrink-0"
          onClick={() => toggleCollapse(id)}
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            {title}
          </div>
          {isCollapsed ? <ChevronDown size={16} className="text-text-tertiary" /> : <ChevronUp size={16} className="text-text-tertiary" />}
        </div>
        {!isCollapsed && <div className="p-3 bg-bg-sunken flex-1">{children}</div>}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Editor */}
        <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-4">
          <Section id="audioProfile" icon={<span className="text-accent text-xs">*</span>} title="Audio Profile">
            <textarea
              className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
              placeholder="A warm, middle-aged male voice with a calm, reassuring tone..."
              value={audioProfile}
              onChange={(e) => setAudioProfile(e.target.value)}
              disabled={generatePhase === "loading"}
            />
          </Section>

          <Section id="scene" icon={<span className="text-text-tertiary text-xs">*</span>} title="Scene">
            <textarea
              className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
              placeholder="A cozy living room with a crackling fireplace..."
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              disabled={generatePhase === "loading"}
            />
          </Section>

          <Section id="directorNotes" icon={<span className="text-text-tertiary text-xs">*</span>} title="Director's Notes">
            <textarea
              className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
              placeholder="Speak slowly and thoughtfully. Emphasize key words..."
              value={directorNotes}
              onChange={(e) => setDirectorNotes(e.target.value)}
              disabled={generatePhase === "loading"}
            />
          </Section>

          <div className={`border border-border-focus rounded-lg bg-bg-surface overflow-hidden flex-1 flex flex-col min-h-[200px]`}>
            <div className="h-9 px-3 flex items-center justify-between border-b border-border-subtle bg-bg-hover">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <span className="text-accent">*</span> Transcript
              </div>
              <span className="text-xs text-text-tertiary">{transcript.length} 字符</span>
            </div>
            <div className="p-3 bg-bg-sunken flex-1 flex flex-col">
              <textarea
                className="w-full flex-1 bg-transparent outline-none resize-none text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="Type the exact transcript here..."
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                disabled={generatePhase === "loading"}
              />
            </div>
          </div>
        </div>

        {/* Right Column: Config */}
        <div className="w-[400px] border-l border-border-subtle bg-bg-base overflow-y-auto p-6 flex flex-col gap-6">
          {/* Speakers */}
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-text-primary flex items-center justify-between">
              Speaker Config
              <button
                className="text-accent text-xs font-medium hover:text-accent-hover flex items-center gap-1"
                onClick={addSpeaker}
                disabled={speakers.length >= 4}
              >
                <Plus size={14} /> 添加 Speaker
              </button>
            </h3>

            {speakers.map((speaker) => (
              <div key={speaker.id} className="border border-border rounded-md p-3 bg-bg-surface flex flex-col gap-3">
                <div className="flex justify-between items-center text-xs font-medium text-text-secondary">
                  <span>{speaker.label}</span>
                  {speaker.id !== "a" && (
                    <button
                      className="text-error hover:text-error/80 transition-colors"
                      onClick={() => removeSpeaker(speaker.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <label className="w-10 text-text-tertiary">名称:</label>
                  <input
                    className="flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus text-text-primary"
                    value={speaker.name}
                    onChange={(e) => updateSpeaker(speaker.id, "name", e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <label className="w-10 text-text-tertiary">音色:</label>
                  <select
                    className="flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus text-text-primary"
                    value={speaker.voice}
                    onChange={(e) => updateSpeaker(speaker.id, "voice", e.target.value)}
                  >
                    {VOICE_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <label className="w-10 text-text-tertiary">风格:</label>
                  <input
                    className="flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus text-text-primary"
                    value={speaker.style}
                    onChange={(e) => updateSpeaker(speaker.id, "style", e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Quick Tags */}
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-text-primary">快速标签</h3>
            <div className="border border-border rounded-md bg-bg-surface overflow-hidden">
              <div className="flex text-xs border-b border-border-subtle bg-bg-sunken">
                {(Object.keys(PARA_TAGS) as Array<keyof typeof PARA_TAGS>).map((tab) => (
                  <button
                    key={tab}
                    className={`flex-1 py-2 font-medium transition-colors ${
                      activeTagTab === tab
                        ? "text-accent border-b border-accent"
                        : "text-text-secondary hover:text-text-primary"
                    }`}
                    onClick={() => setActiveTagTab(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="p-3 flex flex-wrap gap-2">
                {PARA_TAGS[activeTagTab].map((tag) => (
                  <button
                    key={tag}
                    className="px-2 py-1 rounded bg-bg-base border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border transition-colors"
                    onClick={() => insertTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Action Bar */}
      <div className="h-[52px] bg-bg-sunken border-t border-border-subtle shrink-0 px-6 flex items-center justify-between sticky bottom-0">
        <div className="flex items-center gap-4">
          <select
            className="bg-bg-surface border border-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-border-focus transition-colors text-text-primary"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            disabled={generatePhase === "loading"}
          >
            {VOICE_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>

          <div className="flex items-center bg-bg-surface border border-border rounded-md overflow-hidden text-sm">
            <button
              className={`px-3 py-1.5 transition-colors ${format === "mp3" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"}`}
              onClick={() => setFormat("mp3")}
              disabled={generatePhase === "loading"}
            >
              mp3
            </button>
            <button
              className={`px-3 py-1.5 transition-colors ${format === "pcm" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"}`}
              onClick={() => setFormat("pcm")}
              disabled={generatePhase === "loading"}
            >
              pcm
            </button>
          </div>

          {generatePhase !== "idle" && (
            <button
              className="text-sm text-text-secondary hover:text-text-primary transition-colors"
              onClick={handleReset}
            >
              重置
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            className="px-4 py-2 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            onClick={() => {
              // Force RightPanel open and navigate to prompt preview
              const panel = document.querySelector("[data-right-panel-trigger]");
              if (panel) (panel as HTMLElement).click();
            }}
          >
            预览提示词
          </button>
          <button
            className="px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-shadow-glow flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              backgroundColor: generatePhase === "loading" ? "var(--color-bg-active)" : "var(--color-accent)",
              color: "var(--color-bg-base)",
            }}
            onClick={handleGenerate}
            disabled={transcript.trim().length === 0 || generatePhase === "loading"}
          >
            {generatePhase === "loading" ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                生成中...
              </>
            ) : generatePhase === "success" ? "重新生成" : generatePhase === "error" ? "重试" : "组装并生成"}
            <span className="text-bg-base/70 text-xs border-l border-bg-base/20 pl-2">
              预估 {costEstimate?.estimatedCost ?? "$0.0000"}
            </span>
          </button>
        </div>
      </div>

      {/* Demo Notice */}
      {generateResult?.isDemo && (
        <div className="px-6 py-1.5 bg-warning-muted border-t border-warning/20 text-xs text-warning text-center shrink-0">
          演示模式：当前输出为本地演示数据，不代表真实模型输出。
        </div>
      )}
    </div>
  );
}
