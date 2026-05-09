import { useState, useCallback, useEffect } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2, Loader2, AlertTriangle, AlertCircle, CheckCircle2, Copy, FileText, Zap } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { AudioFormat, SpeakerConfig, AssemblePromptRequest, AssemblePromptSuccess } from "../types";

const MAX_SPEAKERS = 2;

const EMOTION_TAGS = ["[happy]", "[sad]", "[excited]", "[calm]", "[angry]", "[nervous]", "[proud]"];
const EXPRESS_TAGS = ["[slow]", "[fast]", "[pause]", "[whisper]", "[shout]", "[sigh]", "[laugh]"];
const PARA_TAGS = { "情绪": EMOTION_TAGS, "表达": EXPRESS_TAGS, "副语言": ["[breath]", "[cough]", "[giggle]", "[gasp]", "[yawn]"] };

function displaySpeakerLabel(label: string): string {
  const match = label.match(/^Speaker\s+([A-Z])$/i);
  return match ? `说话者 ${match[1].toUpperCase()}` : label;
}

const DIRECTOR_FIELD_LABELS = {
  audioProfile: "音频画像",
  scene: "场景",
  directorNotes: "导演备注",
  sampleContext: "示例上下文",
  transcript: "台词文本",
};

type DirectorStep = "edit" | "preview" | "confirm";

export function DirectorPage() {
  const {
    generate, generatePhase, generateResult, resetGeneration,
    estimateCost, costEstimate,
    assemblePhase, assembleResult, assemblePrompt: assembleAction, resetAssemble,
    settings, voices,
  } = useAppState();

  // Director fields
  const [audioProfile, setAudioProfile] = useState("");
  const [scene, setScene] = useState("");
  const [directorNotes, setDirectorNotes] = useState("");
  const [sampleContext, setSampleContext] = useState("");
  const [transcript, setTranscript] = useState("");

  // Config
  const [voice, setVoice] = useState(settings.defaultVoice);
  const [format, setFormat] = useState<AudioFormat>(settings.defaultFormat);

  // Step tracking
  const [step, setStep] = useState<DirectorStep>("edit");
  const [lastAssembledPrompt, setLastAssembledPrompt] = useState<string>("");
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  // Voice options from backend
  const voiceOptions = voices.length > 0
    ? voices.map((v) => v.name)
    : ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda"];

  // Speakers
  const [speakers, setSpeakers] = useState<SpeakerConfig[]>([
    { id: "a", label: "Speaker A", name: "主持人", voice: "Zephyr", style: "专业、沉稳" },
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

  // Cost estimation
  useEffect(() => {
    estimateCost(transcript.length, format);
  }, [transcript.length, format, estimateCost]);

  // Speaker management
  const addSpeaker = useCallback(() => {
    if (speakers.length >= MAX_SPEAKERS) return;
    const id = String.fromCharCode(97 + speakers.length); // b
    setSpeakers((prev) => [
      ...prev,
      { id, label: `Speaker ${id.toUpperCase()}`, name: "", voice: "Zephyr", style: "" },
    ]);
  }, [speakers.length]);

  const removeSpeaker = useCallback((id: string) => {
    setSpeakers((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const updateSpeaker = useCallback((id: string, field: keyof SpeakerConfig, value: string) => {
    setSpeakers((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }, []);

  // Speaker limit warning
  const isSpeakerLimitReached = speakers.length >= MAX_SPEAKERS;

  // Assemble handler -- calls POST /api/prompts/assemble
  const handleAssemble = useCallback(async () => {
    if (transcript.trim().length === 0) return;

    const req: AssemblePromptRequest = {
      audioProfile: audioProfile.trim() || undefined,
      scene: scene.trim() || undefined,
      directorNotes: directorNotes.trim() || undefined,
      sampleContext: sampleContext.trim() || undefined,
      transcript: transcript.trim(),
      speakers: speakers.map((s) => ({
        id: s.id,
        label: s.label,
        name: s.name || undefined,
        voice: s.voice || undefined,
        style: s.style || undefined,
      })),
    };

    const result = await assembleAction(req);
    if (result && result.ok) {
      setLastAssembledPrompt((result as AssemblePromptSuccess).prompt);
      setStep("preview");
    }
  }, [audioProfile, scene, directorNotes, sampleContext, transcript, speakers, assembleAction]);

  // Generate handler -- uses the assembled prompt as input text
  const handleGenerate = useCallback(async () => {
    if (!lastAssembledPrompt || generatePhase === "loading") return;

    // Check if API Key is configured
    if (!settings.openRouterApiKey) {
      return;
    }

    await generate({
      text: lastAssembledPrompt,
      voice,
      format,
      speakers,
      audioProfile: audioProfile.trim(),
      scene: scene.trim(),
      directorNotes: directorNotes.trim(),
      sampleContext: sampleContext.trim(),
      transcript: transcript.trim(),
    });

    setStep("confirm");
  }, [lastAssembledPrompt, voice, format, speakers, audioProfile, scene, directorNotes, sampleContext, transcript, generatePhase, generate, settings.openRouterApiKey]);

  const handleReset = useCallback(() => {
    resetGeneration();
    resetAssemble();
    setStep("edit");
    setLastAssembledPrompt("");
  }, [resetGeneration, resetAssemble]);

  const handleBackToEdit = useCallback(() => {
    resetAssemble();
    setStep("edit");
  }, [resetAssemble]);

  const handleCopyPrompt = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setShowCopiedToast(true);
      setTimeout(() => setShowCopiedToast(false), 2000);
    } catch {
      // ignore
    }
  }, []);

  // Derive assemble success data
  const assembleSuccess = assembleResult?.phase === "success" && assembleResult.response?.ok
    ? (assembleResult.response as AssemblePromptSuccess)
    : null;

  const assembleError = assembleResult?.phase === "error"
    ? assembleResult.error
    : null;

  // Check if API key is configured
  const hasApiKey = !!settings.openRouterApiKey;

  // ─── Section component ──────────────────────────────────────────────────────

  const Section = ({ id, icon, title, children, required }: { id: string; icon: React.ReactNode; title: string; children: React.ReactNode; required?: boolean }) => {
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

  // ─── Speaker Limit Banner ───────────────────────────────────────────────────

  const SpeakerLimitBanner = () => (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-warning-muted border border-warning/20 text-xs text-warning">
      <AlertTriangle size={14} className="shrink-0" />
      <span>MVP 阶段最多支持 {MAX_SPEAKERS} 位说话者。如需更多，请关注后续版本更新。</span>
    </div>
  );

  // ─── Render Steps ────────────────────────────────────────────────────────────

  // Step: Edit (initial state)
  if (step === "edit") {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex overflow-hidden">
          {/* Left Column: Editor */}
          <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-4">
            <Section id="audioProfile" icon={<span className="text-text-tertiary text-xs">*</span>} title={DIRECTOR_FIELD_LABELS.audioProfile}>
              <textarea
                className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="例如：温暖、沉稳的中年男声，语气安心且有叙述感..."
                value={audioProfile}
                onChange={(e) => setAudioProfile(e.target.value)}
                disabled={assemblePhase === "loading"}
              />
            </Section>

            <Section id="scene" icon={<span className="text-text-tertiary text-xs">*</span>} title={DIRECTOR_FIELD_LABELS.scene}>
              <textarea
                className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="例如：壁炉轻响的温暖客厅，窗外正在下雨..."
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                disabled={assemblePhase === "loading"}
              />
            </Section>

            <Section id="directorNotes" icon={<span className="text-text-tertiary text-xs">*</span>} title={DIRECTOR_FIELD_LABELS.directorNotes}>
              <textarea
                className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="例如：语速放慢，思考感更强，关键句略作停顿..."
                value={directorNotes}
                onChange={(e) => setDirectorNotes(e.target.value)}
                disabled={assemblePhase === "loading"}
              />
            </Section>

            <Section id="sampleContext" icon={<span className="text-text-tertiary text-xs">*</span>} title={DIRECTOR_FIELD_LABELS.sampleContext}>
              <textarea
                className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                placeholder="补充背景信息：前情提要、角色经历、世界观设定等..."
                value={sampleContext}
                onChange={(e) => setSampleContext(e.target.value)}
                disabled={assemblePhase === "loading"}
              />
            </Section>

            <div className="border border-border-focus rounded-lg bg-bg-surface overflow-hidden flex-1 flex flex-col min-h-[200px]">
              <div className="h-9 px-3 flex items-center justify-between border-b border-border-subtle bg-bg-hover">
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <span className="text-accent">*</span> {DIRECTOR_FIELD_LABELS.transcript}
                </div>
                <span className="text-xs text-text-tertiary">{transcript.length} 字符</span>
              </div>
              <div className="p-3 bg-bg-sunken flex-1 flex flex-col">
                <textarea
                  className="w-full flex-1 bg-transparent outline-none resize-none text-sm text-text-primary placeholder:text-text-tertiary"
                  placeholder="在此输入需要朗读的完整台词..."
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  disabled={assemblePhase === "loading"}
                />
              </div>
            </div>
          </div>

          {/* Right Column: Config */}
          <div className="w-[400px] border-l border-border-subtle bg-bg-base overflow-y-auto p-6 flex flex-col gap-6">
            {/* Speakers */}
            <div className="flex flex-col gap-4">
              <h3 className="text-sm font-semibold text-text-primary flex items-center justify-between">
                说话者配置
                <button
                  className={`text-xs font-medium flex items-center gap-1 transition-colors ${
                    isSpeakerLimitReached
                      ? "text-text-tertiary cursor-not-allowed"
                      : "text-accent hover:text-accent-hover"
                  }`}
                  onClick={addSpeaker}
                  disabled={isSpeakerLimitReached}
                  title={isSpeakerLimitReached ? `MVP 阶段最多 ${MAX_SPEAKERS} 位说话者` : "添加说话者"}
                >
                  <Plus size={14} /> 添加说话者
                </button>
              </h3>

              {isSpeakerLimitReached && <SpeakerLimitBanner />}

              {speakers.map((speaker) => (
                <div key={speaker.id} className="border border-border rounded-md p-3 bg-bg-surface flex flex-col gap-3">
                  <div className="flex justify-between items-center text-xs font-medium text-text-secondary">
                    <span>{displaySpeakerLabel(speaker.label)}</span>
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
                      {voiceOptions.map((v) => <option key={v} value={v}>{v}</option>)}
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
              disabled={assemblePhase === "loading"}
            >
              {voiceOptions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>

            <div className="flex items-center bg-bg-surface border border-border rounded-md overflow-hidden text-sm">
              <button
                className={`px-3 py-1.5 transition-colors ${format === "wav" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"}`}
                onClick={() => setFormat("wav")}
                disabled={assemblePhase === "loading"}
              >
                WAV
              </button>
              <button
                className={`px-3 py-1.5 transition-colors ${format === "pcm" ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"}`}
                onClick={() => setFormat("pcm")}
                disabled={assemblePhase === "loading"}
              >
                PCM（原始）
              </button>
            </div>

            <span className="text-xs text-text-tertiary">
              预估 {costEstimate?.estimatedCost ?? "$0.0000"}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              className="px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-shadow-glow flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                backgroundColor: transcript.trim().length === 0 || assemblePhase === "loading"
                  ? "var(--color-bg-active)"
                  : "var(--color-accent)",
                color: "var(--color-bg-base)",
              }}
              onClick={handleAssemble}
              disabled={transcript.trim().length === 0 || assemblePhase === "loading"}
            >
              {assemblePhase === "loading" ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  组装中...
                </>
              ) : (
                <>
                  <FileText size={16} />
                  组装提示词
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step: Preview (assemble success, show prompt + warnings)
  if (step === "preview" && assembleSuccess) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold font-display text-text-primary">提示词组装结果</h2>
              <p className="text-text-tertiary text-xs mt-1">
                请求 ID: {assembleSuccess.requestId}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="text-xs text-accent hover:text-accent-hover transition-colors flex items-center gap-1"
                onClick={() => handleCopyPrompt(assembleSuccess.prompt)}
              >
                <Copy size={12} /> {showCopiedToast ? "已复制" : "复制提示词"}
              </button>
            </div>
          </div>

          {/* Warnings */}
          {assembleSuccess.warnings.length > 0 && (
            <div className="flex flex-col gap-2">
              {assembleSuccess.warnings.map((w, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 px-3 py-2 rounded-md text-xs border ${
                    w.code === "LEGACY_VOICE_ALIAS"
                      ? "bg-warning-muted border-warning/20 text-warning"
                      : "bg-accent-muted border-accent/20 text-accent"
                  }`}
                >
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{w.code}</span>
                    <span>{w.message}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Normalized speakers */}
          {assembleSuccess.normalized.speakers.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text-primary">规范化说话者信息</h3>
              <div className="grid gap-2">
                {assembleSuccess.normalized.speakers.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-md bg-bg-surface border border-border-subtle text-xs">
                    <span className="font-semibold text-text-primary">{displaySpeakerLabel(s.label)}</span>
                    {s.name && <span className="text-text-secondary">({s.name})</span>}
                    <span className="text-text-tertiary">音色:</span>
                    <span className="text-accent font-mono">{s.voice}</span>
                    {s.wasLegacyAlias && (
                      <span className="px-1.5 py-0.5 rounded bg-warning-muted text-warning border border-warning/20 text-[10px]">
                        旧音色别名已映射
                      </span>
                    )}
                    {s.style && (
                      <>
                        <span className="text-text-tertiary">风格:</span>
                        <span className="text-text-secondary">{s.style}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Five-element summary */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text-primary">五要素概要</h3>
            <div className="grid gap-2 text-xs">
              {[
                { label: DIRECTOR_FIELD_LABELS.audioProfile, value: assembleSuccess.normalized.audioProfile },
                { label: DIRECTOR_FIELD_LABELS.scene, value: assembleSuccess.normalized.scene },
                { label: DIRECTOR_FIELD_LABELS.directorNotes, value: assembleSuccess.normalized.directorNotes },
                { label: DIRECTOR_FIELD_LABELS.sampleContext, value: assembleSuccess.normalized.sampleContext },
                { label: DIRECTOR_FIELD_LABELS.transcript, value: assembleSuccess.normalized.transcript },
              ].map((el) => (
                <div key={el.label} className="flex items-start gap-2 px-3 py-1.5 rounded-md bg-bg-surface border border-border-subtle">
                  <span className="text-text-tertiary shrink-0 w-[110px]">{el.label}:</span>
                  <span className={`break-all ${el.value ? "text-text-secondary" : "text-text-tertiary italic"}`}>
                    {el.value || "未填写"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Assembled prompt preview */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text-primary">组装后的提示词</h3>
            <div className="bg-bg-sunken p-4 rounded-md border border-border font-mono text-xs text-text-secondary min-h-[160px] max-h-[40vh] overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {assembleSuccess.prompt}
            </div>
            <div className="flex items-center justify-between text-xs text-text-tertiary">
              <span>{assembleSuccess.prompt.length} 字符</span>
              <span>此步骤不消耗额度</span>
            </div>
          </div>
        </div>

        {/* Bottom Action Bar */}
        <div className="h-[52px] bg-bg-sunken border-t border-border-subtle shrink-0 px-6 flex items-center justify-between sticky bottom-0">
          <button
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            onClick={handleBackToEdit}
          >
            返回编辑
          </button>

          <div className="flex items-center gap-3">
            <span className="text-xs text-text-tertiary">
              预估 {costEstimate?.estimatedCost ?? "$0.0000"}
            </span>

            <button
              className="px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-shadow-glow flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                backgroundColor: generatePhase === "loading" || !hasApiKey
                  ? "var(--color-bg-active)"
                  : "var(--color-accent)",
                color: "var(--color-bg-base)",
              }}
              onClick={handleGenerate}
              disabled={generatePhase === "loading" || !hasApiKey}
            >
              {generatePhase === "loading" ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  生成中...
                </>
              ) : (
                <>
                  <Zap size={16} />
                  确认并生成语音
                </>
              )}
            </button>
          </div>
        </div>

        {/* No API Key warning overlay */}
        {!hasApiKey && (
          <div className="absolute inset-0 bg-bg-base/60 backdrop-blur-sm flex items-center justify-center z-10">
            <div className="bg-bg-elevated border border-border rounded-lg p-6 max-w-md flex flex-col gap-4 text-center shadow-shadow-lg">
              <div className="w-12 h-12 rounded-full bg-error-muted flex items-center justify-center mx-auto">
                <AlertCircle size={24} className="text-error" />
              </div>
              <h3 className="text-sm font-semibold text-text-primary">未配置 API 密钥</h3>
              <p className="text-xs text-text-secondary">
                生成语音需要调用 OpenRouter API，请先在设置页面配置 API 密钥。组装提示词不消耗额度，但实际生成需要有效的 API 密钥。
              </p>
              <button
                className="text-sm text-accent hover:text-accent-hover transition-colors"
                onClick={handleBackToEdit}
              >
                返回编辑
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Step: Confirm (generation result)
  if (step === "confirm") {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-5">
          {/* Generation result display */}
          {generatePhase === "loading" && (
            <div className="flex flex-col items-center justify-center flex-1 gap-4">
              <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center text-accent animate-pulse">
                <Loader2 size={32} className="animate-spin" />
              </div>
              <p className="text-text-secondary text-sm font-medium">正在调用 TTS 生成接口...</p>
              <p className="text-text-tertiary text-xs">请等待后端响应，此步骤将消耗 API 额度</p>
            </div>
          )}

          {generatePhase === "success" && generateResult && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={18} className="text-success" />
                <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-success-muted text-success border border-success/20">
                  生成成功
                </span>
                <span className="font-mono text-xs text-text-secondary">{generateResult.jobId}</span>
              </div>

              {generateResult.audioUrl && (
                <audio controls className="w-full" src={generateResult.audioUrl}>
                  当前浏览器不支持音频播放控件。
                </audio>
              )}

              <div className="flex flex-col gap-2 text-sm bg-bg-sunken p-4 rounded-md border border-border-subtle">
                <div className="flex justify-between">
                  <span className="text-text-tertiary">音色</span>
                  <span className="text-text-primary">{generateResult.voice}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-tertiary">格式</span>
                  <span className="text-text-primary font-mono text-xs">{generateResult.format}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-tertiary">字符数</span>
                  <span className="text-text-primary">{generateResult.charCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-tertiary">预估成本</span>
                  <span className="text-text-primary text-accent">{generateResult.estimatedCost}</span>
                </div>
              </div>
            </div>
          )}

          {generatePhase === "error" && generateResult && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-error-muted text-error border border-error/20">
                  生成失败
                </span>
                <span className="font-mono text-xs text-text-secondary">{generateResult.jobId}</span>
              </div>

              <div className="p-4 bg-error-muted/50 rounded-md border border-error/20 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm text-error font-medium">
                  <AlertCircle size={16} />
                  {generateResult.error?.code ?? "UNKNOWN"}
                </div>
                <p className="text-xs text-text-secondary">{generateResult.error?.message ?? "生成过程中发生错误"}</p>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Action Bar */}
        <div className="h-[52px] bg-bg-sunken border-t border-border-subtle shrink-0 px-6 flex items-center justify-between sticky bottom-0">
          <button
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            onClick={handleReset}
          >
            重新编辑
          </button>

          <div className="flex items-center gap-3">
            {generatePhase === "error" && (
              <button
                className="px-4 py-2 rounded-md text-sm font-medium bg-bg-surface hover:bg-bg-hover transition-colors border border-border flex items-center gap-1"
                onClick={handleGenerate}
                disabled={generatePhase === "loading"}
              >
                <Loader2 size={14} className={generatePhase === "loading" ? "animate-spin" : "hidden"} />
                重试生成
              </button>
            )}

            {generatePhase === "success" && (
              <button
                className="px-4 py-2 rounded-md text-sm font-medium bg-bg-surface hover:bg-bg-hover transition-colors border border-border flex items-center gap-1"
                onClick={handleReset}
              >
                重新生成
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Assemble error state
  if (assemblePhase === "error" && assembleError) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 p-6 overflow-y-auto flex flex-col items-center justify-center gap-4">
          <div className="w-16 h-16 rounded-full bg-error-muted flex items-center justify-center">
            <AlertCircle size={32} className="text-error" />
          </div>
          <p className="text-text-secondary text-sm font-medium">提示词组装失败</p>
          <div className="p-4 bg-error-muted/50 rounded-md border border-error/20 flex flex-col gap-2 max-w-lg">
            <div className="flex items-center gap-2 text-sm text-error font-medium">
              <AlertCircle size={16} />
              {assembleError.code}
            </div>
            <p className="text-xs text-text-secondary">{assembleError.message}</p>
            {assembleError.code === "DIRECTOR_SPEAKER_LIMIT_EXCEEDED" && (
              <p className="text-xs text-text-tertiary">
                MVP 阶段最多支持 {MAX_SPEAKERS} 位说话者。请返回编辑并减少说话者数量。
              </p>
            )}
          </div>
          <button
            className="px-4 py-2 rounded-md text-sm font-medium bg-bg-surface hover:bg-bg-hover transition-colors border border-border"
            onClick={handleBackToEdit}
          >
            返回编辑
          </button>
        </div>
      </div>
    );
  }

  return null;
}
