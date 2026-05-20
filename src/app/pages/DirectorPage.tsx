import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2, Loader2, AlertTriangle, AlertCircle, CheckCircle2, Copy, FileText, Zap, Route, ShieldAlert, ShieldCheck } from "lucide-react";
import { useAppState } from "../state/AppContext";
import type { AudioFormat, SpeakerConfig, AssemblePromptRequest, AssemblePromptSuccess, GenerationRoute, VoiceAsset, VoiceAssetCapabilities, VoiceRoutePreviewResult } from "../types";
import { formatVoiceOptionLabel } from "../utils/voiceDisplay";
import { PromptTextBlock } from "../components/PromptTextBlock";
import { useAudioObjectUrl } from "../hooks/useAudioObjectUrl";
import { findForbiddenStyleWords, formatForbiddenStyleWarning, getForbiddenMatchesForField } from "../utils/forbiddenStyleWords";
import type { ForbiddenStyleUiMatch } from "../utils/forbiddenStyleWords";

const MAX_SPEAKERS = 2;

const EMOTION_TAGS = ["[happy]", "[sad]", "[excited]", "[calm]", "[angry]", "[nervous]", "[proud]"];
const EXPRESS_TAGS = ["[slow]", "[fast]", "[pause]", "[whisper]", "[shout]", "[sigh]", "[laugh]"];
const PARA_TAGS = { "情绪": EMOTION_TAGS, "表达": EXPRESS_TAGS, "副语言": ["[breath]", "[cough]", "[giggle]", "[gasp]", "[yawn]"] };

const EMOTIONAL_SCENES = [
  {
    id: "EMPATHY_SUPPORT",
    label: "共情安抚",
    description: "适合安慰、道歉、解释坏消息。重点是贴近、温暖、可依赖。",
    tags: ["[warm]", "[gentle]", "[soft-spoken]", "[pause]"],
  },
  {
    id: "CLARIFY_EXPLAIN",
    label: "澄清解释",
    description: "适合教学、说明、复杂概念拆解。重点是清晰、分层、关键处停顿。",
    tags: ["[clear]", "[measured]", "[pause]", "[emphasis]"],
  },
  {
    id: "TRANSACTIONAL_GUIDE",
    label: "事务引导",
    description: "适合步骤提示、确认信息、流程引导。重点是简洁、可信、节奏稳定但不平。",
    tags: ["[confident]", "[concise]", "[steady]", "[emphasis]"],
  },
  {
    id: "WARM_FRIENDLY",
    label: "温暖友好",
    description: "适合欢迎、陪伴、轻松对话。重点是自然笑意和轻松亲近。",
    tags: ["[friendly]", "[smile]", "[light laugh]", "[bright]"],
  },
] as const;

type EmotionalSceneId = (typeof EMOTIONAL_SCENES)[number]["id"];

const ROUTE_OPTIONS: Array<{ value: GenerationRoute; label: string; description: string }> = [
  { value: "gemini_only", label: "Gemini-only", description: "默认安全路线，使用 OpenRouter Gemini TTS。" },
  { value: "gemini_elevenlabs_sts", label: "Gemini + ElevenLabs STS", description: "路线 A：先生成 Gemini base audio，再走 ElevenLabs speech-to-speech；缺授权或 key 必须阻断。" },
  { value: "fish_audio_tts", label: "Fish direct TTS + reference voice", description: "路线 B：Fish 直接文本转语音 + active reference voice，不是 Fish 音色转换。" },
];

const GEMINI_STYLE_TAGS = ["[warm]", "[gentle]", "[clear]", "[measured]", "[pause]", "[emphasis]", "[whisper]", "[laugh]"];

function routeLabel(route: GenerationRoute | undefined) {
  return ROUTE_OPTIONS.find((item) => item.value === route)?.label ?? route ?? "未选择";
}

function displaySpeakerLabel(label: string): string {
  const match = label.match(/^Speaker\s+([A-Z])$/i);
  return match ? `说话者 ${match[1].toUpperCase()}` : label;
}

function ForbiddenStyleWarningStrip({ matches }: { matches: ForbiddenStyleUiMatch[] }) {
  if (matches.length === 0) return null;
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md border border-warning/25 bg-warning-muted/35 px-3 py-2 text-xs text-warning">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>{formatForbiddenStyleWarning(matches)}</span>
    </div>
  );
}

function CapabilityLine({ label, configured }: { label: string; configured: boolean | undefined }) {
  const known = configured !== undefined;
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className={`rounded px-1.5 py-0.5 text-[10px] ${!known ? "bg-bg-base text-text-tertiary" : configured ? "bg-success-muted text-success" : "bg-warning-muted text-warning"}`}>
        {!known ? "unknown" : configured ? "configured" : "missing"}
      </span>
    </div>
  );
}

function AuthenticatedAudioControls({ audioUrl }: { audioUrl: string }) {
  const { objectUrl, loading, error } = useAudioObjectUrl(audioUrl);

  if (loading) {
    return <div className="rounded-md border border-border bg-bg-sunken px-3 py-2 text-xs text-text-tertiary">正在加载音频...</div>;
  }

  if (error) {
    return <div className="rounded-md border border-error/20 bg-error-muted/40 px-3 py-2 text-xs text-error">音频加载失败：{error}</div>;
  }

  if (!objectUrl) return null;

  return (
    <audio controls className="w-full" src={objectUrl}>
      当前浏览器不支持音频播放控件。
    </audio>
  );
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
    settings, voices, adapter,
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
  const [generationRoute, setGenerationRoute] = useState<GenerationRoute>("gemini_only");
  const [selectedVoiceAssetId, setSelectedVoiceAssetId] = useState("");
  const [voiceAssets, setVoiceAssets] = useState<VoiceAsset[]>([]);
  const [capabilities, setCapabilities] = useState<VoiceAssetCapabilities | null>(null);
  const [routePreviewPhase, setRoutePreviewPhase] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [routePreview, setRoutePreview] = useState<VoiceRoutePreviewResult | null>(null);
  const [routePreviewError, setRoutePreviewError] = useState<string | null>(null);
  const [routePreviewNeedsRefresh, setRoutePreviewNeedsRefresh] = useState(false);
  const [geminiAudioTags, setGeminiAudioTags] = useState<string[]>([]);
  const [styleGuidance, setStyleGuidance] = useState("");
  const currentRoutePreviewSignatureRef = useRef("");
  const lastRoutePreviewSignatureRef = useRef<string | null>(null);

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
  const [activeSceneId, setActiveSceneId] = useState<EmotionalSceneId>("EMPATHY_SUPPORT");
  const toggleGeminiTag = (tag: string) => {
    setGeminiAudioTags((prev) => prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]);
  };

  const activeScene = EMOTIONAL_SCENES.find((sceneOption) => sceneOption.id === activeSceneId) ?? EMOTIONAL_SCENES[0];

  const forbiddenMatches = useMemo(() => findForbiddenStyleWords([
    { field: "audioProfile", value: audioProfile },
    { field: "directorNotes", value: directorNotes },
    ...speakers.map((speaker, index) => ({ field: `speakers[${index}].style`, value: speaker.style })),
  ]), [audioProfile, directorNotes, speakers]);

  const getLocalForbiddenMatches = useCallback(
    (field: string) => getForbiddenMatchesForField(forbiddenMatches, field),
    [forbiddenMatches],
  );

  // Cost estimation
  useEffect(() => {
    estimateCost(transcript.length, format);
  }, [transcript.length, format, estimateCost]);

  useEffect(() => {
    let cancelled = false;
    async function loadRouteInputs() {
      try {
        const [capabilityResult, assetResult] = await Promise.all([
          adapter.getVoiceAssetCapabilities?.(),
          adapter.listVoiceAssets?.({ status: "active" }),
        ]);
        if (cancelled) return;
        if (capabilityResult) setCapabilities(capabilityResult);
        if (assetResult) setVoiceAssets(assetResult.items);
      } catch {
        if (!cancelled) {
          setCapabilities(null);
          setVoiceAssets([]);
        }
      }
    }
    void loadRouteInputs();
    return () => { cancelled = true; };
  }, [adapter]);

  const routePreviewInputSignature = useMemo(() => JSON.stringify({
    generationRoute,
    selectedVoiceAssetId: selectedVoiceAssetId || null,
    transcript: transcript.trim(),
    audioProfile: audioProfile.trim(),
    scene: scene.trim(),
    directorNotes: directorNotes.trim(),
    geminiAudioTags: [...geminiAudioTags].sort(),
    styleGuidance: styleGuidance.trim(),
  }), [audioProfile, directorNotes, geminiAudioTags, generationRoute, scene, selectedVoiceAssetId, styleGuidance, transcript]);

  useEffect(() => {
    currentRoutePreviewSignatureRef.current = routePreviewInputSignature;
    if (lastRoutePreviewSignatureRef.current && lastRoutePreviewSignatureRef.current !== routePreviewInputSignature) {
      setRoutePreview(null);
      setRoutePreviewPhase("idle");
      setRoutePreviewError(null);
      setRoutePreviewNeedsRefresh(true);
    }
  }, [routePreviewInputSignature]);

  const handleRoutePreview = useCallback(async () => {
    if (!adapter.previewVoiceRoute) return;
    if (!transcript.trim()) {
      setRoutePreviewPhase("error");
      setRoutePreviewError("请先输入台词文本；Route Preview 只读取原文，不会改写 transcript。");
      setRoutePreview(null);
      setRoutePreviewNeedsRefresh(false);
      return;
    }
    setRoutePreviewPhase("loading");
    setRoutePreviewError(null);
    setRoutePreviewNeedsRefresh(false);
    const requestSignature = routePreviewInputSignature;
    try {
      const result = await adapter.previewVoiceRoute({
        generationRoute,
        voiceAssetId: selectedVoiceAssetId || undefined,
        transcript: transcript.trim(),
        directorSnapshot: {
          audioProfile: audioProfile.trim() || undefined,
          scene: scene.trim() || undefined,
          directorNotes: directorNotes.trim() || undefined,
          transcript: transcript.trim(),
          promptAssembly: {
            geminiAudioTags,
            styleGuidance: styleGuidance.trim() || undefined,
            source: "frontend-style-metadata",
          },
        },
      });
      if (currentRoutePreviewSignatureRef.current !== requestSignature) {
        setRoutePreview(null);
        setRoutePreviewPhase("idle");
        setRoutePreviewError(null);
        setRoutePreviewNeedsRefresh(true);
        return;
      }
      lastRoutePreviewSignatureRef.current = requestSignature;
      setRoutePreview(result);
      setRoutePreviewPhase("success");
    } catch (err) {
      if (currentRoutePreviewSignatureRef.current !== requestSignature) {
        setRoutePreview(null);
        setRoutePreviewPhase("idle");
        setRoutePreviewError(null);
        setRoutePreviewNeedsRefresh(true);
        return;
      }
      setRoutePreviewPhase("error");
      setRoutePreviewError(err instanceof Error ? err.message : "Route Preview 请求失败");
    }
  }, [adapter, audioProfile, directorNotes, geminiAudioTags, generationRoute, routePreviewInputSignature, scene, selectedVoiceAssetId, styleGuidance, transcript]);

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
      generationRoute,
      voiceAssetId: selectedVoiceAssetId || undefined,
      promptAssembly: {
        geminiAudioTags,
        styleGuidance: styleGuidance.trim() || undefined,
        source: "frontend-style-metadata",
      },
    });

    setStep("confirm");
  }, [lastAssembledPrompt, voice, format, speakers, audioProfile, scene, directorNotes, sampleContext, transcript, generationRoute, selectedVoiceAssetId, geminiAudioTags, styleGuidance, generatePhase, generate]);

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

  const hasKnownMissingRouteProvider = generationRoute === "gemini_only"
    ? capabilities?.providers.openrouterGemini.configured === false
    : generationRoute === "gemini_elevenlabs_sts"
      ? capabilities?.providers.openrouterGemini.configured === false || capabilities?.providers.elevenlabs.configured === false
      : capabilities?.providers.fishAudio.configured === false;

  // ─── Section component ──────────────────────────────────────────────────────

  const Section = ({ id, icon, title, children, required }: { id: string; icon: React.ReactNode; title: string; children: React.ReactNode; required?: boolean }) => {
    const isCollapsed = collapsed[id] ?? false;
    return (
      <div className={`border rounded-lg bg-bg-surface overflow-hidden ${isCollapsed ? "" : "@5xl/director:flex-1 @5xl/director:flex @5xl/director:flex-col @5xl/director:min-h-[120px]"}`}>
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
      <div className="@container/director flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto @5xl/director:grid @5xl/director:grid-cols-[minmax(0,1fr)_320px] @5xl/director:overflow-hidden @6xl/director:grid-cols-[minmax(0,1fr)_360px] @7xl/director:grid-cols-[minmax(0,1fr)_400px]">
          {/* Left Column: Editor */}
          <div className="min-h-0 min-w-0 p-4 [@media(max-height:760px)]:p-3 @6xl/director:p-6 overflow-visible @5xl/director:overflow-y-auto flex flex-col gap-4 [@media(max-height:760px)]:gap-3">
            <Section id="audioProfile" icon={<span className="text-text-tertiary text-xs">*</span>} title={DIRECTOR_FIELD_LABELS.audioProfile}>
              <div className="flex flex-col gap-2">
                <div className="rounded-md border border-border-subtle bg-bg-surface/70 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                  建议写成具体角色画像：角色身份 + 年龄感 + 声线质地 + 说话距离 + 情绪底色。示例：Warm late-30s documentary narrator, close-mic, grounded confidence, gentle smile in the voice. 避免只写 quiet / flat / 安静 / 平淡 这类低信息词。
                </div>
                <textarea
                  className="w-full min-h-[80px] bg-transparent outline-none resize-y text-sm text-text-primary placeholder:text-text-tertiary"
                  placeholder="例如：Warm late-30s documentary narrator, close-mic, grounded confidence, gentle smile in the voice..."
                  value={audioProfile}
                  onChange={(e) => setAudioProfile(e.target.value)}
                  disabled={assemblePhase === "loading"}
                />
                <ForbiddenStyleWarningStrip matches={getLocalForbiddenMatches("audioProfile")} />
              </div>
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
              <ForbiddenStyleWarningStrip matches={getLocalForbiddenMatches("directorNotes")} />
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

            <div className="border border-border-focus rounded-lg bg-bg-surface overflow-hidden flex flex-col min-h-[220px] @5xl/director:flex-1 @5xl/director:min-h-[200px]">
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
          <aside className="min-h-0 min-w-0 border-t @5xl/director:border-t-0 @5xl/director:border-l border-border-subtle bg-bg-base p-4 [@media(max-height:760px)]:p-3 @6xl/director:p-5 @7xl/director:p-6 overflow-visible @5xl/director:overflow-y-auto flex flex-col gap-5 [@media(max-height:760px)]:gap-4 @7xl/director:gap-6">
            {/* Speakers */}
            <div className="flex flex-col gap-4">
              <h3 className="text-sm font-semibold text-text-primary flex items-center justify-between">
                说话者配置
                <button
                  className={`text-xs font-medium flex min-w-0 items-center gap-1 transition-colors ${
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

              {speakers.map((speaker, index) => (
                <div key={speaker.id} className="min-w-0 border border-border rounded-md p-3 bg-bg-surface flex flex-col gap-3">
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
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <label className="w-10 text-text-tertiary">名称:</label>
                    <input
                      className="min-w-0 flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus text-text-primary"
                      value={speaker.name}
                      onChange={(e) => updateSpeaker(speaker.id, "name", e.target.value)}
                    />
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <label className="w-10 text-text-tertiary">音色:</label>
                    <select
                      className="min-w-0 flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus text-text-primary"
                      value={speaker.voice}
                      onChange={(e) => updateSpeaker(speaker.id, "voice", e.target.value)}
                    >
                      {voiceOptions.map((v) => <option key={v} value={v}>{formatVoiceOptionLabel(v)}</option>)}
                    </select>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <label className="w-10 text-text-tertiary">风格:</label>
                    <input
                      className="min-w-0 flex-1 bg-bg-sunken border border-border rounded px-2 py-1 outline-none focus:border-border-focus text-text-primary"
                      value={speaker.style}
                      onChange={(e) => updateSpeaker(speaker.id, "style", e.target.value)}
                    />
                  </div>
                  <ForbiddenStyleWarningStrip matches={getLocalForbiddenMatches(`speakers[${index}].style`)} />
                </div>
              ))}
            </div>

            {/* Emotional Scenes */}
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">情感场景</h3>
                <p className="mt-1 text-xs text-text-tertiary">先选场景，再按需加入 Gemini style metadata；不会修改 transcript 原文。</p>
              </div>
              <div className="border border-border rounded-md bg-bg-surface overflow-hidden">
                <div className="grid grid-cols-2 border-b border-border-subtle bg-bg-sunken text-xs">
                  {EMOTIONAL_SCENES.map((sceneOption) => (
                    <button
                      key={sceneOption.id}
                      className={`px-3 py-2 text-left font-medium leading-snug transition-colors ${
                        activeSceneId === sceneOption.id
                          ? "bg-bg-active text-accent"
                          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                      }`}
                      onClick={() => setActiveSceneId(sceneOption.id)}
                      type="button"
                    >
                      {sceneOption.label}
                    </button>
                  ))}
                </div>
                <div className="p-3 flex flex-col gap-3">
                  <p className="text-xs leading-relaxed text-text-secondary">{activeScene.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {activeScene.tags.map((tag) => (
                      <button
                        key={tag}
                        className={`px-2 py-1 rounded border text-xs transition-colors ${geminiAudioTags.includes(tag) ? "bg-accent-muted border-accent/30 text-accent" : "bg-bg-base border-border-subtle text-text-secondary hover:text-text-primary hover:border-border"}`}
                        onClick={() => toggleGeminiTag(tag)}
                        type="button"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
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
                      className={`px-2 py-1 rounded border text-xs transition-colors ${geminiAudioTags.includes(tag) ? "bg-accent-muted border-accent/30 text-accent" : "bg-bg-base border-border-subtle text-text-secondary hover:text-text-primary hover:border-border"}`}
                      onClick={() => toggleGeminiTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Route and style metadata */}
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-surface p-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Route size={15} /> 路线与音色资产</h3>
                <p className="mt-1 text-xs leading-relaxed text-text-tertiary">Gemini audio tags / style guidance 作为 metadata 发送，不会改写 transcript 原文。路线 A/B 缺授权、key 或资产绑定时按后端结果阻断。</p>
              </div>

              <div className="space-y-2">
                {ROUTE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${generationRoute === option.value ? "border-accent/40 bg-accent-subtle text-text-primary" : "border-border-subtle bg-bg-sunken text-text-secondary hover:bg-bg-hover"}`}
                    onClick={() => setGenerationRoute(option.value)}
                  >
                    <div className="text-xs font-semibold">{option.label}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-text-tertiary">{option.description}</div>
                  </button>
                ))}
              </div>

              {generationRoute !== "gemini_only" && (
                <select className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-xs text-text-primary" value={selectedVoiceAssetId} onChange={(e) => setSelectedVoiceAssetId(e.target.value)}>
                  <option value="">选择 active voice asset</option>
                  {voiceAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · {asset.provider ?? "provider?"}</option>)}
                </select>
              )}

              <div className="rounded-md border border-border-subtle bg-bg-sunken p-2 text-[11px] text-text-secondary">
                <div className="mb-1 font-medium text-text-primary">Provider capabilities</div>
                <div className="grid gap-1">
                  <CapabilityLine label="Gemini" configured={capabilities?.providers.openrouterGemini.configured} />
                  <CapabilityLine label="ElevenLabs STS" configured={capabilities?.providers.elevenlabs.configured} />
                  <CapabilityLine label="Fish Audio TTS" configured={capabilities?.providers.fishAudio.configured} />
                </div>
              </div>

              <textarea className="min-h-[70px] w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary" placeholder="Style guidance metadata，例如：closer mic, gentle smile, measured pauses。不会拼入 transcript。" value={styleGuidance} onChange={(e) => setStyleGuidance(e.target.value)} />
              <div className="flex flex-wrap gap-1.5 text-[10px]">
                {GEMINI_STYLE_TAGS.map((tag) => <button key={tag} type="button" className={`rounded border px-2 py-1 ${geminiAudioTags.includes(tag) ? "border-accent/30 bg-accent-muted text-accent" : "border-border-subtle bg-bg-sunken text-text-secondary hover:bg-bg-hover"}`} onClick={() => toggleGeminiTag(tag)}>{tag}</button>)}
              </div>

              <button type="button" className="flex items-center justify-center gap-2 rounded-md border border-border bg-bg-sunken px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:opacity-50" onClick={handleRoutePreview} disabled={routePreviewPhase === "loading"}>
                {routePreviewPhase === "loading" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Route Preview
              </button>
              {routePreviewNeedsRefresh && routePreviewPhase === "idle" && (
                <div className="rounded-md border border-warning/20 bg-warning-muted/20 p-2 text-[11px] text-warning">
                  路线、音色资产或上下文已变化；旧 Route Preview 已清空，请重新预览后再依据后端 Gate 判断。
                </div>
              )}
              {routePreviewPhase === "success" && routePreview && (
                <div className={`rounded-md border p-2 text-[11px] ${routePreview.decision.blocked ? "border-warning/25 bg-warning-muted/25 text-warning" : "border-success/20 bg-success-muted/20 text-success"}`}>
                  <div className="flex items-center gap-1 font-semibold">{routePreview.decision.blocked ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />} {routeLabel(routePreview.decision.route)} · {routePreview.decision.blocked ? "Blocked" : "Allowed"}</div>
                  {routePreview.decision.complianceBlocks.length > 0 && <div className="mt-1 font-mono">{routePreview.decision.complianceBlocks.join(" | ")}</div>}
                  {routePreview.decision.providerChain.length > 0 && <div className="mt-1 text-text-secondary">chain: {routePreview.decision.providerChain.map((item) => `${item.stage}:${item.provider}`).join(" -> ")}</div>}
                </div>
              )}
              {routePreviewPhase === "error" && routePreviewError && <div className="rounded-md border border-error/20 bg-error-muted/25 p-2 text-[11px] text-error">{routePreviewError}</div>}
            </div>
          </aside>
        </div>

        {/* Bottom Action Bar */}
        <div className="min-h-[52px] h-auto max-h-[104px] overflow-y-auto bg-bg-sunken border-t border-border-subtle shrink-0 px-4 py-2 sm:px-6 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
            <select
              className="min-w-0 max-w-full bg-bg-surface border border-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-border-focus transition-colors text-text-primary"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={assemblePhase === "loading"}
            >
              {voiceOptions.map((v) => <option key={v} value={v}>{formatVoiceOptionLabel(v)}</option>)}
            </select>

            <div className="flex min-w-0 items-center bg-bg-surface border border-border rounded-md overflow-hidden text-sm">
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

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
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
      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 min-w-0 p-4 sm:p-6 overflow-y-auto flex flex-col gap-5">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold font-display text-text-primary">提示词组装结果</h2>
              <p className="text-text-tertiary text-xs mt-1">
                请求 ID: {assembleSuccess.requestId}
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                    w.code === "LEGACY_VOICE_ALIAS" || w.code === "FORBIDDEN_STYLE_WORDS"
                      ? "bg-warning-muted border-warning/20 text-warning"
                      : "bg-accent-muted border-accent/20 text-accent"
                  }`}
                >
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{w.code}</span>
                    <span>{w.message}</span>
                    {w.code === "FORBIDDEN_STYLE_WORDS" && w.details?.matches && w.details.matches.length > 0 && (
                      <span className="text-[11px] opacity-90">
                        命中字段：{w.details.matches.map((match) => `${match.field}:${match.term}`).join("；")}
                      </span>
                    )}
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
                <div key={el.label} className="grid grid-cols-1 sm:grid-cols-[120px_minmax(0,1fr)] items-start gap-1.5 sm:gap-2 px-3 py-1.5 rounded-md bg-bg-surface border border-border-subtle min-w-0">
                  <span className="text-text-tertiary shrink-0">{el.label}:</span>
                  <span className={`min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:normal] text-left ${el.value ? "text-text-secondary" : "text-text-tertiary italic"}`} style={{ writingMode: "horizontal-tb", unicodeBidi: "plaintext" }}>
                    {el.value || "未填写"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-accent/15 bg-accent-muted/10 p-3 text-xs text-text-secondary">
            <div className="mb-1 font-semibold text-text-primary">Style metadata（不修改 transcript 原文）</div>
            <div>生成路线：<span className="text-accent">{routeLabel(generationRoute)}</span>{selectedVoiceAssetId ? <span className="ml-2 font-mono text-text-tertiary">asset {selectedVoiceAssetId}</span> : null}</div>
            <div className="mt-1">Gemini audio tags：{geminiAudioTags.length ? geminiAudioTags.join(" ") : "未选择"}</div>
            <div className="mt-1">Style guidance：{styleGuidance.trim() || "未填写"}</div>
          </div>

          {/* Assembled prompt preview */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text-primary">组装后的提示词</h3>
            <PromptTextBlock minHeightClass="min-h-[160px]" maxHeightClass="max-h-[40vh]">
              {assembleSuccess.prompt}
            </PromptTextBlock>
            <div className="flex items-center justify-between text-xs text-text-tertiary">
              <span>{assembleSuccess.prompt.length} 字符</span>
              <span>此步骤不消耗额度</span>
            </div>
          </div>
        </div>

        {/* Bottom Action Bar */}
        <div className="min-h-[52px] h-auto max-h-[104px] overflow-y-auto bg-bg-sunken border-t border-border-subtle shrink-0 px-4 py-2 sm:px-6 flex flex-wrap items-center justify-between gap-2">
          <button
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            onClick={handleBackToEdit}
          >
            返回编辑
          </button>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
            <span className="text-xs text-text-tertiary">
              预估 {costEstimate?.estimatedCost ?? "$0.0000"}
            </span>

            <button
              className="px-6 py-2 rounded-md text-sm font-medium transition-colors shadow-shadow-glow flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                backgroundColor: generatePhase === "loading"
                  ? "var(--color-bg-active)"
                  : "var(--color-accent)",
                color: "var(--color-bg-base)",
              }}
              onClick={handleGenerate}
              disabled={generatePhase === "loading"}
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
            {hasKnownMissingRouteProvider && (
              <div className="basis-full text-right text-[11px] text-warning">
                当前路线存在未配置 Provider；仍会提交到后端，由结构化 Route / License Gate 返回最终阻断原因。
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Step: Confirm (generation result)
  if (step === "confirm") {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 min-w-0 p-4 sm:p-6 overflow-y-auto flex flex-col gap-5">
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

              {generateResult.audioUrl && <AuthenticatedAudioControls audioUrl={generateResult.audioUrl} />}

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
                <div className="flex justify-between gap-4">
                  <span className="text-text-tertiary">生成路线</span>
                  <span className="text-text-primary">{routeLabel(generateResult.generationRoute)}</span>
                </div>
                {generateResult.providerChain && generateResult.providerChain.length > 0 && (
                  <div className="flex justify-between gap-4">
                    <span className="text-text-tertiary">Provider Chain</span>
                    <span className="text-right text-xs text-text-secondary">{generateResult.providerChain.map((item) => `${item.stage}:${item.provider}`).join(" -> ")}</span>
                  </div>
                )}
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
                {(generateResult.compliance?.blocks?.length || generateResult.providerChain?.length || generateResult.generationRoute) && (
                  <div className="mt-2 rounded border border-error/15 bg-bg-base/50 p-2 text-[11px] text-text-secondary">
                    <div>路线：{routeLabel(generateResult.generationRoute)}</div>
                    {generateResult.compliance?.blocks?.length ? <div className="mt-1 font-mono text-error">Blocks: {generateResult.compliance.blocks.join(" | ")}</div> : null}
                    {generateResult.providerChain?.length ? <div className="mt-1">Chain: {generateResult.providerChain.map((item) => `${item.stage}:${item.provider}`).join(" -> ")}</div> : null}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Action Bar */}
        <div className="min-h-[52px] h-auto max-h-[104px] overflow-y-auto bg-bg-sunken border-t border-border-subtle shrink-0 px-4 py-2 sm:px-6 flex flex-wrap items-center justify-between gap-2">
          <button
            className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            onClick={handleReset}
          >
            重新编辑
          </button>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
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
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 min-w-0 p-4 sm:p-6 overflow-y-auto flex flex-col items-center justify-center gap-4">
          <div className="w-16 h-16 rounded-full bg-error-muted flex items-center justify-center">
            <AlertCircle size={32} className="text-error" />
          </div>
          <p className="text-text-secondary text-sm font-medium">提示词组装失败</p>
          <div className="p-4 bg-error-muted/50 rounded-md border border-error/20 flex flex-col gap-2 max-w-[32rem]">
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
