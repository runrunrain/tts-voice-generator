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
  speakers?: Array<{ id: string; label: string; name?: string; voice?: string; style?: string }>;
};

type PromptOverrideSnapshot = Partial<Pick<PromptAssemblyInput, "audioProfile" | "scene" | "directorNotes" | "sampleContext" | "speakers">>;

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
  const speakers = normalizeSpeakers(raw.speakers);
  if (audioProfile) override.audioProfile = audioProfile;
  if (scene) override.scene = scene;
  if (directorNotes) override.directorNotes = directorNotes;
  if (sampleContext) override.sampleContext = sampleContext;
  if (speakers) override.speakers = speakers;
  return override;
}

export function resolvePromptAssemblyInput(
  line: { id: string; text: string; directorProfileId: string | null; directorOverrideJson: string | null },
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
    directorNotes: override.directorNotes ?? profile.directorNotes ?? "",
    sampleContext: override.sampleContext ?? profile.sampleContext ?? "",
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
