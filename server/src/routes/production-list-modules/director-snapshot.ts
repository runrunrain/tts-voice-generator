import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { directorProfile as dpTable } from "../../db/schema-extended.js";
import type { GenerateSpeechRequest } from "../../services/tts-generator.js";
import type { PromptAssemblyInput } from "../../services/prompt-assembly.js";

type PromptProfileSnapshot = {
  id: string;
  name?: string;
  audioProfile?: string;
  scene?: string;
  directorNotes?: string;
  sampleContext?: string;
  style?: string;
  pacing?: string;
  accent?: string;
  emotion?: string;
  performanceNotes?: string;
  speakers?: Array<{ id: string; label: string; name?: string; voice?: string; style?: string }>;
};

type PromptOverrideSnapshot = Partial<Pick<PromptAssemblyInput, "audioProfile" | "scene" | "directorNotes" | "sampleContext" | "style" | "pacing" | "accent" | "emotion" | "performanceNotes" | "speakers">>;

export type PromptAssemblyResolution =
  | { ok: true; input: PromptAssemblyInput; profileId: string; transcript: string }
  | { ok: false; code: "MISSING_PROMPT_STRUCTURE"; message: string; missingFields: string[] };

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function combineNotes(...values: Array<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged.join("; ");
}

function normalizeSpeakers(value: unknown): PromptAssemblyInput["speakers"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const speakers: PromptAssemblyInput["speakers"] = [];
  for (const speaker of value) {
    if (!speaker || typeof speaker !== "object") continue;
    const raw = speaker as Record<string, unknown>;
    const id = readString(raw.id);
    const label = readString(raw.label);
    const voice = readString(raw.voice);
    if (!id || !label || !voice) continue;
    speakers.push({
      id,
      label,
      name: readString(raw.name),
      voice,
      style: readString(raw.style),
    });
  }
  return speakers.length > 0 ? speakers.slice(0, 2) : undefined;
}

function profileFromDb(profileId: string): PromptProfileSnapshot | null {
  try {
    const db = getDb();
    const profile = db.select().from(dpTable).where(eq(dpTable.id, profileId)).get();
    if (!profile?.config) return null;
    const config = parseJsonObject(profile.config);
    if (!config) return null;
    return {
      id: profileId,
      name: profile.name,
      audioProfile: readString(config.audioProfile),
      scene: readString(config.scene),
      directorNotes: readString(config.directorNotes),
      sampleContext: readString(config.sampleContext),
      style: readString(config.style),
      pacing: readString(config.pacing),
      accent: readString(config.accent),
      emotion: readString(config.emotion),
      performanceNotes: readString(config.performanceNotes),
      speakers: normalizeSpeakers(config.speakers),
    };
  } catch {
    return null;
  }
}

function normalizeOverride(value: unknown): PromptOverrideSnapshot {
  const raw = parseJsonObject(value);
  if (!raw) return {};
  const override: PromptOverrideSnapshot = {};
  const audioProfile = readString(raw.audioProfile);
  const scene = readString(raw.scene);
  const directorNotes = readString(raw.directorNotes);
  const sampleContext = readString(raw.sampleContext);
  const style = readString(raw.style);
  const pacing = readString(raw.pacing);
  const accent = readString(raw.accent);
  const emotion = readString(raw.emotion);
  const performanceNotes = readString(raw.performanceNotes);
  const speakers = normalizeSpeakers(raw.speakers);
  if (audioProfile) override.audioProfile = audioProfile;
  if (scene) override.scene = scene;
  if (directorNotes) override.directorNotes = directorNotes;
  if (sampleContext) override.sampleContext = sampleContext;
  if (style) override.style = style;
  if (pacing) override.pacing = pacing;
  if (accent) override.accent = accent;
  if (emotion) override.emotion = emotion;
  if (performanceNotes) override.performanceNotes = performanceNotes;
  if (speakers) override.speakers = speakers;
  return override;
}

export function resolvePromptAssemblyInput(
  line: { id: string; text: string; style?: string | null; directorProfileId: string | null; directorOverrideJson: string | null },
  artifactLine: Record<string, unknown>,
  artifactProfiles: PromptProfileSnapshot[] = [],
): PromptAssemblyResolution {
  const profileId = readString(artifactLine.promptProfileId)
    ?? readString(artifactLine.directorProfileId)
    ?? line.directorProfileId
    ?? null;
  if (!profileId) {
    return { ok: false, code: "MISSING_PROMPT_STRUCTURE", message: `Line "${line.id}" has no promptProfileId/directorProfileId binding.`, missingFields: ["promptProfileId"] };
  }

  const artifactProfile = artifactProfiles.find((profile) => profile && profile.id === profileId) ?? null;
  const dbProfile = artifactProfile ? null : profileFromDb(profileId);
  const profile = artifactProfile ?? dbProfile;
  if (!profile) {
    return { ok: false, code: "MISSING_PROMPT_STRUCTURE", message: `Line "${line.id}" references missing prompt profile "${profileId}".`, missingFields: ["promptProfile"] };
  }

  const override = {
    ...normalizeOverride(artifactLine.promptOverride),
    ...normalizeOverride(artifactLine.directorOverrideJson),
    ...normalizeOverride(line.directorOverrideJson),
  };

  const input: PromptAssemblyInput = {
    audioProfile: override.audioProfile ?? profile.audioProfile ?? "",
    scene: override.scene ?? profile.scene ?? "",
    directorNotes: combineNotes(profile.directorNotes, override.directorNotes),
    sampleContext: override.sampleContext ?? profile.sampleContext ?? "",
    style: override.style ?? profile.style ?? "",
    pacing: override.pacing ?? profile.pacing ?? "",
    accent: override.accent ?? profile.accent ?? "",
    emotion: override.emotion ?? profile.emotion ?? "",
    performanceNotes: combineNotes(profile.performanceNotes, override.performanceNotes),
    lineStyle: readString(artifactLine.style) ?? readString(line.style) ?? "",
    transcript: readString(artifactLine.transcript) ?? readString(artifactLine.text) ?? line.text,
    speakers: override.speakers ?? normalizeSpeakers(profile.speakers) ?? [],
  };

  const missingFields: string[] = [];
  for (const field of ["audioProfile", "scene", "directorNotes", "sampleContext", "transcript"] as const) {
    if (!input[field].trim()) missingFields.push(field);
  }
  if (input.speakers.length < 1) missingFields.push("speakers");

  if (missingFields.length > 0) {
    return {
      ok: false,
      code: "MISSING_PROMPT_STRUCTURE",
      message: `Line "${line.id}" is missing complete prompt structure: ${missingFields.join(", ")}.`,
      missingFields,
    };
  }

  return { ok: true, input, profileId, transcript: input.transcript };
}

export function resolveDirectorSnapshot(
  line: { directorProfileId: string | null; directorOverrideJson: string | null },
  artifactLine: Record<string, unknown>,
): GenerateSpeechRequest["directorSnapshot"] {
  if (artifactLine.directorOverrideJson && typeof artifactLine.directorOverrideJson === "string") {
    try {
      const override = JSON.parse(artifactLine.directorOverrideJson);
      if (override && typeof override === "object") {
        return {
          audioProfile: typeof override.audioProfile === "string" ? override.audioProfile : undefined,
          scene: typeof override.scene === "string" ? override.scene : undefined,
          directorNotes: typeof override.directorNotes === "string" ? override.directorNotes : undefined,
          sampleContext: typeof override.sampleContext === "string" ? override.sampleContext : undefined,
          style: typeof override.style === "string" ? override.style : undefined,
          pacing: typeof override.pacing === "string" ? override.pacing : undefined,
          accent: typeof override.accent === "string" ? override.accent : undefined,
          emotion: typeof override.emotion === "string" ? override.emotion : undefined,
          performanceNotes: typeof override.performanceNotes === "string" ? override.performanceNotes : undefined,
          transcript: typeof override.transcript === "string" ? override.transcript : undefined,
        };
      }
    } catch {
      // Invalid JSON falls through to the next snapshot source.
    }
  }

  if (line.directorOverrideJson) {
    try {
      const override = JSON.parse(line.directorOverrideJson);
      if (override && typeof override === "object") {
        return {
          audioProfile: typeof override.audioProfile === "string" ? override.audioProfile : undefined,
          scene: typeof override.scene === "string" ? override.scene : undefined,
          directorNotes: typeof override.directorNotes === "string" ? override.directorNotes : undefined,
            sampleContext: typeof override.sampleContext === "string" ? override.sampleContext : undefined,
            style: typeof override.style === "string" ? override.style : undefined,
            pacing: typeof override.pacing === "string" ? override.pacing : undefined,
            accent: typeof override.accent === "string" ? override.accent : undefined,
            emotion: typeof override.emotion === "string" ? override.emotion : undefined,
            performanceNotes: typeof override.performanceNotes === "string" ? override.performanceNotes : undefined,
          };
      }
    } catch {
      // Invalid JSON falls through to profile resolution.
    }
  }

  const profileId = line.directorProfileId ?? (typeof artifactLine.directorProfileId === "string" ? artifactLine.directorProfileId : null);
  if (profileId) {
    try {
      const db = getDb();
      const profile = db.select().from(dpTable).where(eq(dpTable.id, profileId)).get();
      if (profile?.config) {
        const config = JSON.parse(typeof profile.config === "string" ? profile.config : "{}");
        if (config && typeof config === "object") {
          return {
            audioProfile: typeof config.audioProfile === "string" ? config.audioProfile : undefined,
            scene: typeof config.scene === "string" ? config.scene : undefined,
            directorNotes: typeof config.directorNotes === "string" ? config.directorNotes : undefined,
            sampleContext: typeof config.sampleContext === "string" ? config.sampleContext : undefined,
            style: typeof config.style === "string" ? config.style : undefined,
            pacing: typeof config.pacing === "string" ? config.pacing : undefined,
            accent: typeof config.accent === "string" ? config.accent : undefined,
            emotion: typeof config.emotion === "string" ? config.emotion : undefined,
            performanceNotes: typeof config.performanceNotes === "string" ? config.performanceNotes : undefined,
            speakers: Array.isArray(config.speakers) ? config.speakers.map((sp: Record<string, unknown>) => ({
              id: typeof sp.id === "string" ? sp.id : "",
              label: typeof sp.label === "string" ? sp.label : "",
              name: typeof sp.name === "string" ? sp.name : undefined,
              voice: typeof sp.voice === "string" ? sp.voice : undefined,
              style: typeof sp.style === "string" ? sp.style : undefined,
            })) : undefined,
          };
        }
      }
    } catch {
      // Profile resolution is best-effort; generation can proceed without it.
    }
  }

  return null;
}
