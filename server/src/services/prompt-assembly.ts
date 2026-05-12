/**
 * Prompt Assembly Service
 *
 * Assembles Director-mode prompts for Gemini TTS using the five elements:
 *   Audio Profile / Scene / Director's Notes / Sample Context / Transcript
 *
 * Constraints:
 *   - Maximum 2 speakers (enforced at route level with 400 error)
 *   - All speaker voices canonicalized via canonicalizeVoice (alloy -> Zephyr)
 *   - Warnings for missing optional elements and legacy voice alias usage
 *   - Empty transcript rejected at route level (validation error)
 *
 * The assembled prompt is a single text string suitable for passing as `input`
 * to POST /api/tts/generate.
 */

import { canonicalizeVoice, isLegacyAlias } from "../utils/voice.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpeakerInput {
  id: string;
  label: string;
  name?: string;
  voice: string;
  style?: string;
}

export interface NormalizedSpeaker {
  id: string;
  label: string;
  name: string;
  voice: string;
  style: string;
  wasLegacyAlias: boolean;
}

export interface PromptAssemblyInput {
  audioProfile: string;
  scene: string;
  directorNotes: string;
  sampleContext: string;
  style?: string;
  pacing?: string;
  accent?: string;
  emotion?: string;
  performanceNotes?: string;
  lineStyle?: string;
  transcript: string;
  speakers: SpeakerInput[];
}

export interface PromptWarning {
  code: string;
  message: string;
  field?: string;
}

export interface PromptAssemblyResult {
  prompt: string;
  warnings: PromptWarning[];
  normalized: {
    speakers: NormalizedSpeaker[];
    audioProfile: string;
    scene: string;
    directorNotes: string;
    sampleContext: string;
    style: string;
    pacing: string;
    accent: string;
    emotion: string;
    performanceNotes: string;
    lineStyle: string;
    transcript: string;
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of speakers allowed in Director mode */
export const MAX_SPEAKERS = 2;

// ─── Assembly Logic ────────────────────────────────────────────────────────────

/**
 * Normalize and assemble a Director prompt from the five Gemini TTS elements.
 *
 * This function does NOT enforce speaker limits (handled at route level).
 * It focuses on:
 *   1. Canonicalizing all speaker voices
 *   2. Building the assembled prompt text
 *   3. Generating warnings for missing elements and legacy aliases
 */
export function assemblePrompt(input: PromptAssemblyInput): PromptAssemblyResult {
  const warnings: PromptWarning[] = [];

  // 1. Normalize speakers
  const normalizedSpeakers: NormalizedSpeaker[] = input.speakers.map((s) => {
    const canonicalVoice = canonicalizeVoice(s.voice);
    const usedLegacy = s.voice !== canonicalVoice;

    if (usedLegacy) {
      warnings.push({
        code: "LEGACY_VOICE_ALIAS",
        message: `说话人“${s.label}”使用了旧音色别名“${s.voice}”，已规范为“${canonicalVoice}”。`,
        field: `speakers[${s.id}].voice`,
      });
    }

    return {
      id: s.id,
      label: s.label,
      name: s.name || "",
      voice: canonicalVoice,
      style: s.style || "",
      wasLegacyAlias: usedLegacy,
    };
  });

  // 2. Warnings for missing optional Director elements
  if (!input.audioProfile.trim()) {
    warnings.push({
      code: "SUGGEST_AUDIO_PROFILE",
      message: "音频档案为空。建议补充音质、声线和角色身份说明，以获得更稳定的效果。",
      field: "audioProfile",
    });
  }

  if (!input.scene.trim()) {
    warnings.push({
      code: "SUGGEST_SCENE",
      message: "场景说明为空。建议补充空间、氛围和上下文信息。",
      field: "scene",
    });
  }

  if (!input.directorNotes.trim()) {
    warnings.push({
      code: "SUGGEST_DIRECTOR_NOTES",
      message: "导演备注为空。建议补充节奏、情绪或表演方式。",
      field: "directorNotes",
    });
  }

  if (!input.style?.trim() || !input.pacing?.trim() || !input.emotion?.trim()) {
    warnings.push({
      code: "SUGGEST_STYLE_FIELDS",
      message: "建议为 Gemini TTS 导演提示补充风格、节奏和情绪字段。",
      field: "style,pacing,emotion",
    });
  }

  const performanceNotes = mergePromptNotes(input.performanceNotes, input.directorNotes);

  // 3. Build the assembled prompt
  const prompt = buildPromptText({
    audioProfile: input.audioProfile,
    scene: input.scene,
    directorNotes: input.directorNotes,
    sampleContext: input.sampleContext,
    style: input.style ?? "",
    pacing: input.pacing ?? "",
    accent: input.accent ?? "",
    emotion: input.emotion ?? "",
    performanceNotes,
    lineStyle: input.lineStyle ?? "",
    transcript: input.transcript,
    speakers: normalizedSpeakers,
  });

  return {
    prompt,
    warnings,
    normalized: {
      speakers: normalizedSpeakers,
      audioProfile: input.audioProfile,
      scene: input.scene,
      directorNotes: input.directorNotes,
      sampleContext: input.sampleContext,
      style: input.style ?? "",
      pacing: input.pacing ?? "",
      accent: input.accent ?? "",
      emotion: input.emotion ?? "",
      performanceNotes,
      lineStyle: input.lineStyle ?? "",
      transcript: input.transcript,
    },
  };
}

// ─── Prompt Text Builder ──────────────────────────────────────────────────────

/**
 * Build the final prompt text from the five Director elements and speakers.
 *
 * Format follows Gemini TTS prompt conventions:
 *   - Director instructions (audio profile, scene, notes) as preamble
 *   - Speaker definitions with voice assignments
 *   - Transcript as the main content
 */
function buildPromptText(params: {
  audioProfile: string;
  scene: string;
  directorNotes: string;
  sampleContext: string;
  style: string;
  pacing: string;
  accent: string;
  emotion: string;
  performanceNotes: string;
  lineStyle: string;
  transcript: string;
  speakers: NormalizedSpeaker[];
}): string {
  const primarySpeaker = params.speakers[0];
  const audioProfileTitle = primarySpeaker?.label || "TTS 声音配置";
  const voiceSummary = params.speakers.length > 0
    ? params.speakers.map((speaker) => {
      const namePart = speaker.name ? ` (${speaker.name})` : "";
      const stylePart = speaker.style ? `，风格：${speaker.style}` : "";
      return `${speaker.label}${namePart}: ${speaker.voice}${stylePart}`;
    }).join("; ")
    : "使用请求中指定的 OpenRouter/Gemini 音色。";
  const style = mergePromptNotes(
    params.style,
    ...params.speakers.map((speaker) => speaker.style ? `${speaker.label}: ${speaker.style}` : ""),
    params.lineStyle ? `本行风格覆盖：${params.lineStyle}` : "",
  ) || "自然、清晰，并贴合台词语义的表达。";

  const performanceNotes = params.performanceNotes || "不要朗读任何导演元数据、字段名或标签，只输出台词正文。";

  return [
    "请为以下脚本生成语音：",
    "",
    `# 音频档案：${audioProfileTitle}`,
    `角色/身份：${params.audioProfile.trim() || "通用、自然、清晰的中文旁白。"}`,
    `音色：${voiceSummary}`,
    "",
    "## 场景",
    params.scene.trim() || "未提供特定场景；按台词上下文自然处理。",
    "",
    "### 导演备注",
    `风格：${style}`,
    `节奏：${params.pacing.trim() || "自然口语节奏，停顿清楚。"}`,
    `口音/咬字：${params.accent.trim() || "无特定口音要求，优先清晰自然的中文咬字。"}`,
    `情绪：${params.emotion.trim() || "根据台词上下文自然匹配情绪。"}`,
    `表演备注：${performanceNotes}`,
    "",
    "### 示例上下文",
    params.sampleContext.trim() || "无额外示例上下文。",
    "",
    "#### 台词",
    params.transcript.trim(),
  ].join("\n");
}

function mergePromptNotes(...values: Array<string | undefined | null>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged.join("; ");
}
