import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { directorProfile as dpTable } from "../../db/schema-extended.js";
import { SpeakerSchema } from "../../domain/validators.js";

export interface PatchResult {
  lines: Array<Record<string, unknown>>;
  speakers?: unknown[];
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readPrimarySpeakerVoice(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const primarySpeaker = value[0];
  if (!primarySpeaker || typeof primarySpeaker !== "object" || Array.isArray(primarySpeaker)) return undefined;
  return readNonEmptyString((primarySpeaker as Record<string, unknown>).voice);
}

function readProfileSpeakerVoice(profile: unknown): string | undefined {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return undefined;
  const rawProfile = profile as Record<string, unknown>;

  const directVoice = readPrimarySpeakerVoice(rawProfile.speakers);
  if (directVoice) return directVoice;

  const config = parseJsonObject(rawProfile.config);
  return readPrimarySpeakerVoice(config?.speakers);
}

function resolveDirectorProfileSpeakerVoice(
  directorProfileId: string | null | undefined,
  currentProfiles: Array<Record<string, unknown>>,
): string | undefined {
  const profileId = readNonEmptyString(directorProfileId);
  if (!profileId) return undefined;

  const artifactProfile = currentProfiles.find((profile) => readNonEmptyString(profile.id) === profileId);
  const artifactVoice = readProfileSpeakerVoice(artifactProfile);
  if (artifactVoice) return artifactVoice;

  try {
    const db = getDb();
    const profile = db.select().from(dpTable).where(eq(dpTable.id, profileId)).get();
    return readProfileSpeakerVoice(profile);
  } catch {
    return undefined;
  }
}

export function applyPatch(
  op: string,
  payload: Record<string, unknown>,
  currentLines: Array<Record<string, unknown>>,
  currentSpeakers: unknown[],
  currentProfiles: Array<Record<string, unknown>> = [],
): PatchResult {
  const lines = [...currentLines];
  let speakers: unknown[] | undefined;
  void currentSpeakers;

  switch (op) {
    case "updateLine": {
      const { lineId, updates } = payload as { lineId: string; updates: Record<string, unknown> };
      const idx = lines.findIndex((l) => l.id === lineId);
      if (idx === -1) throw new Error(`Line "${lineId}" not found`);
      const allowed = ["text", "transcript", "moduleName", "title", "voice", "style", "notes", "speaker", "speakerLabel", "model", "responseFormat", "directorProfileId", "promptProfileId", "directorOverrideJson"];
      for (const key of Object.keys(updates)) {
        if (allowed.includes(key)) {
          lines[idx][key] = updates[key];
        }
      }
      return { lines };
    }
    case "addLine": {
      const { afterLineId, line } = payload as { afterLineId?: string; line: Record<string, unknown> };
      const newLine = {
        id: (line.id as string) || uuidv4(),
        order: 0,
        moduleName: typeof line.moduleName === "string" ? line.moduleName : null,
        title: typeof line.title === "string" ? line.title : null,
        speaker: (line.speaker as string) || "narrator",
        text: (line.text as string) || "",
        voice: (line.voice as string) || "Zephyr",
        style: (line.style as string) || "",
        notes: (line.notes as string) || "",
        status: "pending",
        model: (line.model as string) || "google/gemini-3.1-flash-tts-preview",
        responseFormat: (line.responseFormat as string) || "wav",
        directorProfileId: typeof line.directorProfileId === "string" ? line.directorProfileId : null,
        directorOverrideJson: typeof line.directorOverrideJson === "string" ? line.directorOverrideJson : null,
        generationStatus: typeof line.generationStatus === "string" ? line.generationStatus : "draft",
        relatedJobId: null,
        relatedAssetId: null,
      };

      if (afterLineId) {
        const idx = lines.findIndex((l) => l.id === afterLineId);
        if (idx === -1) throw new Error(`After-line "${afterLineId}" not found`);
        lines.splice(idx + 1, 0, newLine);
      } else {
        lines.push(newLine);
      }

      lines.forEach((l, i) => { l.order = i; });
      return { lines };
    }
    case "removeLine": {
      const { lineId } = payload as { lineId: string };
      const filtered = lines.filter((l) => l.id !== lineId);
      filtered.forEach((l, i) => { l.order = i; });
      return { lines: filtered };
    }
    case "reorderLines": {
      const { lineIds } = payload as { lineIds: string[] };
      const reordered = lineIds.map((id: string, i: number) => {
        const line = lines.find((l) => l.id === id);
        if (!line) throw new Error(`Line "${id}" not found for reorder`);
        return { ...line, order: i };
      });
      return { lines: reordered };
    }
    case "updateSpeakers": {
      const { speakers: incomingSpeakers } = payload as { speakers: unknown[] };
      if (!Array.isArray(incomingSpeakers)) {
        throw new Error("updateSpeakers payload must include a 'speakers' array");
      }
      if (incomingSpeakers.length > 2) {
        throw new Error("Maximum 2 speakers allowed");
      }

      const sanitizedSpeakers: Array<{ id: string; label: string; name?: string; voice: string; style?: string }> = [];
      for (const sp of incomingSpeakers) {
        const result = SpeakerSchema.safeParse(sp);
        if (!result.success) {
          throw new Error(`Invalid speaker in updateSpeakers: ${JSON.stringify(result.error.flatten())}`);
        }
        sanitizedSpeakers.push(result.data);
      }
      speakers = sanitizedSpeakers;
      return { lines, speakers };
    }
    case "updateDirectorProfile": {
      const { directorProfileId, lineIds } = payload as {
        directorProfileId?: string | null;
        lineIds?: string[];
      };
      const targetIds = lineIds && lineIds.length > 0
        ? new Set(lineIds)
        : new Set(lines.map((l) => l.id));
      const resolvedVoice = resolveDirectorProfileSpeakerVoice(directorProfileId, currentProfiles);
      for (const line of lines) {
        if (targetIds.has(line.id)) {
          line.directorProfileId = directorProfileId ?? null;
          line.promptProfileId = directorProfileId ?? null;
          if (resolvedVoice) {
            line.voice = resolvedVoice;
          }
        }
      }
      return { lines };
    }
    default:
      throw new Error(`Unknown patch operation: ${op}`);
  }
}
