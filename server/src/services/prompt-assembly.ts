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
import {
  buildForbiddenStyleWarningDetails,
  findForbiddenStyleWordMatches,
  FORBIDDEN_STYLE_WARNING_FIELD,
  formatForbiddenStyleWarningMessage,
  type ForbiddenStyleField,
} from "../utils/forbidden-style-words.js";

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
  details?: {
    matches?: Array<{ field: string; term: string }>;
    severity?: "info" | "warning";
  };
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

const PROMPT_DEFAULTS = {
  audioProfile: "A professional narrator with a clear, warm mid-range voice. Confident and approachable.",
  scene: "A quiet, well-treated recording studio. The narrator is focused and prepared.",
  style: "Conversational clarity with warmth. Each word is articulated clearly without sounding stiff.",
  pacing: "Natural conversational rhythm. Slight pause before key points.",
  accent: "Standard Mandarin, clearly articulated, professional broadcast quality.",
  sampleContext: "No additional example context.",
  audioProfileTitle: "TTS Voice Profile",
  voiceSummary: "Use the OpenRouter/Gemini voice selected in the request.",
} as const;

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

  const forbiddenMatches = findForbiddenStyleWordMatches([
    { field: "audioProfile", value: input.audioProfile },
    { field: "style", value: input.style },
    { field: "pacing", value: input.pacing },
    { field: "performanceNotes", value: input.performanceNotes },
    { field: "directorNotes", value: input.directorNotes },
    { field: "lineStyle", value: input.lineStyle },
    ...input.speakers.map((speaker, index) => ({
      field: `speakers[${index}].style` as ForbiddenStyleField,
      value: speaker.style,
    })),
  ]);
  if (forbiddenMatches.length > 0) {
    warnings.push({
      code: "FORBIDDEN_STYLE_WORDS",
      message: formatForbiddenStyleWarningMessage(forbiddenMatches),
      field: FORBIDDEN_STYLE_WARNING_FIELD,
      details: buildForbiddenStyleWarningDetails(forbiddenMatches),
    });
  }

  // 3. Build the assembled prompt
  const prompt = buildPromptText({
    audioProfile: input.audioProfile,
    scene: input.scene,
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
  const audioProfileTitle = primarySpeaker?.label || PROMPT_DEFAULTS.audioProfileTitle;
  const voiceSummary = params.speakers.length > 0
    ? params.speakers.map((speaker) => {
      const namePart = speaker.name ? ` (${speaker.name})` : "";
      const stylePart = speaker.style ? `, style: ${speaker.style}` : "";
      return `${speaker.label}${namePart}: ${speaker.voice}${stylePart}`;
    }).join("; ")
    : PROMPT_DEFAULTS.voiceSummary;
  const style = mergePromptNotes(
    params.style,
    ...params.speakers.map((speaker) => speaker.style ? `${speaker.label}: ${speaker.style}` : ""),
    params.lineStyle ? `Line style override: ${params.lineStyle}` : "",
  ) || PROMPT_DEFAULTS.style;

  const resolvedAudioProfile = params.audioProfile.trim() || PROMPT_DEFAULTS.audioProfile;
  const resolvedScene = params.scene.trim() || PROMPT_DEFAULTS.scene;
  const resolvedPacing = params.pacing.trim() || PROMPT_DEFAULTS.pacing;
  const resolvedAccent = params.accent.trim() || PROMPT_DEFAULTS.accent;
  const emotion = params.emotion.trim();
  const performanceNotes = params.performanceNotes.trim();
  const resolvedSampleContext = params.sampleContext.trim() || PROMPT_DEFAULTS.sampleContext;

  const performanceLines = [
    `Style: ${style}`,
    `Pace: ${resolvedPacing}`,
    `Accent: ${resolvedAccent}`,
  ];
  if (emotion) performanceLines.push(`Emotion: ${emotion}`);
  if (performanceNotes) performanceLines.push(`Notes: ${performanceNotes}`);

  return [
    "Synthesize speech for the performance defined below.",
    "The audio profile, scene, performance notes, and context are direction only.",
    "Do NOT speak them. Speak ONLY the lines under #### TRANSCRIPT.",
    "",
    `# AUDIO PROFILE: ${audioProfileTitle}`,
    resolvedAudioProfile,
    `Voice: ${voiceSummary}`,
    "",
    "## SCENE",
    resolvedScene,
    "",
    "### PERFORMANCE",
    ...performanceLines,
    "",
    "### CONTEXT",
    resolvedSampleContext,
    "",
    "#### TRANSCRIPT",
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
