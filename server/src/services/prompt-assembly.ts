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
        message: `Speaker "${s.label}" uses legacy voice alias "${s.voice}", canonicalized to "${canonicalVoice}".`,
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
      message: "Audio Profile is empty. Consider adding audio quality/style guidance for better results.",
      field: "audioProfile",
    });
  }

  if (!input.scene.trim()) {
    warnings.push({
      code: "SUGGEST_SCENE",
      message: "Scene description is empty. Consider adding context about the setting or environment.",
      field: "scene",
    });
  }

  if (!input.directorNotes.trim()) {
    warnings.push({
      code: "SUGGEST_DIRECTOR_NOTES",
      message: "Director's Notes are empty. Consider adding pacing, emotion, or delivery instructions.",
      field: "directorNotes",
    });
  }

  if (!input.style?.trim() || !input.pacing?.trim() || !input.emotion?.trim()) {
    warnings.push({
      code: "SUGGEST_STYLE_FIELDS",
      message: "Style, pacing, and emotion are recommended for Gemini TTS director prompts.",
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
  const audioProfileTitle = primarySpeaker?.label || "TTS Voice Profile";
  const voiceSummary = params.speakers.length > 0
    ? params.speakers.map((speaker) => {
      const namePart = speaker.name ? ` (${speaker.name})` : "";
      const stylePart = speaker.style ? `, style: ${speaker.style}` : "";
      return `${speaker.label}${namePart}: ${speaker.voice}${stylePart}`;
    }).join("; ")
    : "Use the requested OpenRouter/Gemini voice.";
  const style = mergePromptNotes(
    params.style,
    ...params.speakers.map((speaker) => speaker.style ? `${speaker.label}: ${speaker.style}` : ""),
    params.lineStyle ? `Line Style Override: ${params.lineStyle}` : "",
  ) || "Natural, clear delivery that fits the transcript.";

  const performanceNotes = params.performanceNotes || "Keep all director metadata out of the spoken transcript.";

  return [
    "TTS the following script:",
    "",
    `# AUDIO PROFILE: ${audioProfileTitle}`,
    `Role/Identity: ${params.audioProfile.trim() || "General natural TTS narration."}`,
    `Voice: ${voiceSummary}`,
    "",
    "## THE SCENE",
    params.scene.trim() || "No specific scene context provided.",
    "",
    "### DIRECTOR'S NOTES",
    `Style: ${style}`,
    `Pacing: ${params.pacing.trim() || "Natural conversational pacing with clear pauses."}`,
    `Accent: ${params.accent.trim() || "No specific accent requirement; prioritize clear natural diction."}`,
    `Emotion: ${params.emotion.trim() || "Match the transcript context naturally."}`,
    `Performance Notes: ${performanceNotes}`,
    "",
    "### SAMPLE CONTEXT",
    params.sampleContext.trim() || "No additional sample context.",
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
