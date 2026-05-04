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

  // 3. Build the assembled prompt
  const prompt = buildPromptText({
    audioProfile: input.audioProfile,
    scene: input.scene,
    directorNotes: input.directorNotes,
    sampleContext: input.sampleContext,
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
  transcript: string;
  speakers: NormalizedSpeaker[];
}): string {
  const sections: string[] = [];

  // Preamble: Director instructions
  const preambleLines: string[] = [];

  if (params.audioProfile.trim()) {
    preambleLines.push(`Audio Profile: ${params.audioProfile.trim()}`);
  }

  if (params.scene.trim()) {
    preambleLines.push(`Scene: ${params.scene.trim()}`);
  }

  if (params.directorNotes.trim()) {
    preambleLines.push(`Director's Notes: ${params.directorNotes.trim()}`);
  }

  if (params.sampleContext.trim()) {
    preambleLines.push(`Sample Context: ${params.sampleContext.trim()}`);
  }

  if (preambleLines.length > 0) {
    sections.push(preambleLines.join("\n\n"));
  }

  // Speaker definitions
  if (params.speakers.length > 0) {
    const speakerLines = params.speakers.map((s) => {
      const parts: string[] = [s.label];
      if (s.name) parts.push(`(${s.name})`);
      parts.push(`[Voice: ${s.voice}]`);
      if (s.style) parts.push(`[Style: ${s.style}]`);
      return parts.join(" ");
    });
    sections.push(`Speakers:\n${speakerLines.join("\n")}`);
  }

  // Transcript (always present - validated at route level)
  sections.push(params.transcript);

  return sections.join("\n\n");
}
