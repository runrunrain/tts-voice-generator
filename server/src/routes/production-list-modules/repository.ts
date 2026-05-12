import { eq, desc } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { productionListVersion, voiceLine, directorProfile as dpTable } from "../../db/schema-extended.js";
import { SpeakerSchema } from "../../domain/validators.js";
import {
  readArtifact,
  readArtifactRaw,
  productionListArtifactName,
  productionListVersionArtifactName,
} from "../../services/artifact-store.js";

function logicalLineId(line: { id: string; lineId?: string | null }): string {
  return line.lineId ?? line.id;
}

export function getCurrentVersion(taskId: string): number {
  const db = getDb();
  const latest = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .limit(1)
    .get();
  return latest?.version ?? 0;
}

export function loadProductionList(taskId: string, versionId: string) {
  const db = getDb();
  const version = db.select().from(productionListVersion)
    .where(eq(productionListVersion.id, versionId))
    .get();
  if (!version) return null;

  const lines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, versionId))
    .orderBy(voiceLine.order)
    .all();

  const artifact = readArtifact<{
    schemaVersion?: string;
    lines: Array<Record<string, unknown>>;
    speakers: unknown[];
    promptProfiles?: Array<Record<string, unknown>>;
    directorProfiles?: Array<Record<string, unknown>>;
  }>(taskId, productionListArtifactName());

  const artifactLinesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(artifact?.lines)) {
    for (const line of artifact.lines) {
      if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
    }
  }

  const promptProfiles = resolvePromptProfiles(lines, artifact);
  const promptStatus = computePromptStructureStatus(lines, artifactLinesById, promptProfiles);

  return {
    schemaVersion: artifact?.schemaVersion ?? (promptProfiles.length > 0 ? "tts.production-list.v2" : "1.0"),
    taskId: version.taskId,
    version: version.version,
    versionId: version.id,
    lines: lines.map((l) => {
      const lineId = logicalLineId(l);
      const artifactLine = artifactLinesById.get(lineId) ?? {};
      return {
        id: lineId,
        order: l.order,
        moduleName: typeof artifactLine.moduleName === "string" ? artifactLine.moduleName : (artifactLine.moduleName === null ? null : undefined),
        title: typeof artifactLine.title === "string" ? artifactLine.title : (artifactLine.title === null ? null : undefined),
        speaker: l.speaker,
        text: l.text,
        transcript: typeof artifactLine.transcript === "string" ? artifactLine.transcript : l.text,
        voice: l.voice,
        style: l.style,
        notes: l.notes,
        status: l.status,
        model: typeof artifactLine.model === "string" ? artifactLine.model : "google/gemini-3.1-flash-tts-preview",
        responseFormat: artifactLine.responseFormat === "pcm" || artifactLine.responseFormat === "mp3" || artifactLine.responseFormat === "wav" ? artifactLine.responseFormat : "wav",
        promptProfileId: typeof artifactLine.promptProfileId === "string" ? artifactLine.promptProfileId : (l.directorProfileId ?? (typeof artifactLine.directorProfileId === "string" ? artifactLine.directorProfileId : null)),
        speakerLabel: typeof artifactLine.speakerLabel === "string" ? artifactLine.speakerLabel : null,
        promptOverride: artifactLine.promptOverride && typeof artifactLine.promptOverride === "object" ? artifactLine.promptOverride : null,
        directorProfileId: l.directorProfileId ?? (typeof artifactLine.directorProfileId === "string" ? artifactLine.directorProfileId : null),
        directorOverrideJson: l.directorOverrideJson ?? (typeof artifactLine.directorOverrideJson === "string" ? artifactLine.directorOverrideJson : null),
        generationStatus: l.generationStatus ?? (typeof artifactLine.generationStatus === "string" ? artifactLine.generationStatus : "draft"),
        relatedJobId: l.relatedJobId ?? (typeof artifactLine.relatedJobId === "string" ? artifactLine.relatedJobId : null),
        relatedAssetId: l.relatedAssetId ?? (typeof artifactLine.relatedAssetId === "number" ? artifactLine.relatedAssetId : null),
        lastGenerationSignature: l.lastGenerationSignature ?? (typeof artifactLine.lastGenerationSignature === "string" ? artifactLine.lastGenerationSignature : null),
        lastGenerationSnapshotJson: l.lastGenerationSnapshotJson ?? (typeof artifactLine.lastGenerationSnapshotJson === "string" ? artifactLine.lastGenerationSnapshotJson : null),
        generationErrorCode: l.generationStatus === "failed"
          ? (l.generationErrorCode ?? (typeof artifactLine.generationErrorCode === "string" ? artifactLine.generationErrorCode : null))
          : null,
        generationErrorMessage: l.generationStatus === "failed"
          ? (l.generationErrorMessage ?? (typeof artifactLine.generationErrorMessage === "string" ? artifactLine.generationErrorMessage : null))
          : null,
      };
    }),
    speakers: artifact?.speakers
      ? (Array.isArray(artifact.speakers)
        ? artifact.speakers.map((sp: unknown) => {
          const parsed = SpeakerSchema.safeParse(sp);
          return parsed.success ? parsed.data : null;
        }).filter((s: unknown): s is Record<string, unknown> => s !== null)
        : [])
      : [],
    directorProfileId: version.directorProfileId,
    promptProfiles,
    directorProfiles: promptProfiles,
    metadata: { ...(version.metadataJson ? JSON.parse(version.metadataJson) : {}), promptStructureStatus: promptStatus },
    createdAt: version.createdAt.toISOString(),
  };
}

function resolvePromptProfiles(
  lines: Array<{ directorProfileId: string | null }>,
  artifact: { promptProfiles?: Array<Record<string, unknown>>; directorProfiles?: Array<Record<string, unknown>> } | null,
): Array<Record<string, unknown>> {
  const artifactProfiles = Array.isArray(artifact?.promptProfiles)
    ? artifact!.promptProfiles!
    : (Array.isArray(artifact?.directorProfiles) ? artifact!.directorProfiles! : []);
  if (artifactProfiles.length > 0) return artifactProfiles;

  const profileIds = Array.from(new Set(lines.map((line) => line.directorProfileId).filter(Boolean) as string[]));
  if (profileIds.length === 0) return [];
  const db = getDb();
  const profiles: Array<Record<string, unknown>> = [];
  for (const profileId of profileIds) {
    const profile = db.select().from(dpTable).where(eq(dpTable.id, profileId)).get();
    if (!profile) continue;
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(profile.config || "{}"); } catch { config = {}; }
    profiles.push({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      ...config,
    });
  }
  return profiles;
}

function computePromptStructureStatus(
  lines: Array<{ id: string; directorProfileId: string | null }>,
  artifactLinesById: Map<string, Record<string, unknown>>,
  profiles: Array<Record<string, unknown>>,
): "complete" | "missing" | "incomplete" {
  if (lines.length === 0) return "missing";
  const profilesById = new Map(profiles.map((profile) => [String(profile.id ?? ""), profile]));
  let missing = 0;
  let incomplete = 0;
  for (const line of lines) {
    const artifactLine = artifactLinesById.get(logicalLineId(line)) ?? {};
    const profileId = typeof artifactLine.promptProfileId === "string" ? artifactLine.promptProfileId : line.directorProfileId;
    if (!profileId) {
      missing++;
      continue;
    }
    const profile = profilesById.get(profileId);
    if (!profile) {
      missing++;
      continue;
    }
    for (const field of ["audioProfile", "scene", "directorNotes", "sampleContext"] as const) {
      if (typeof profile[field] !== "string" || !profile[field].trim()) incomplete++;
    }
  }
  if (missing === lines.length) return "missing";
  if (missing > 0 || incomplete > 0) return "incomplete";
  return "complete";
}

export function loadVersionLines(taskId: string, versionRecord: { id: string; version: number }): Array<Record<string, unknown>> {
  const currentVersion = getCurrentVersion(taskId);
  const isCurrent = versionRecord.version === currentVersion;

  if (isCurrent) {
    const db = getDb();
    const dbLines = db.select().from(voiceLine)
      .where(eq(voiceLine.versionId, versionRecord.id))
      .orderBy(voiceLine.order)
      .all();

    if (dbLines.length > 0) {
      const artifact = readArtifact<{ lines?: Array<Record<string, unknown>> }>(taskId, productionListArtifactName());
      const artifactLinesById = new Map<string, Record<string, unknown>>();
      if (Array.isArray(artifact?.lines)) {
        for (const line of artifact.lines) {
          if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
        }
      }
      return dbLines.map((l) => ({
        ...(artifactLinesById.get(logicalLineId(l)) ?? {}),
        id: logicalLineId(l),
        order: l.order,
        speaker: l.speaker,
        text: l.text,
        voice: l.voice,
        style: l.style,
        notes: l.notes,
        status: l.status,
        directorProfileId: l.directorProfileId ?? null,
        directorOverrideJson: l.directorOverrideJson ?? null,
        generationStatus: l.generationStatus ?? "draft",
        generationErrorCode: l.generationErrorCode ?? null,
        generationErrorMessage: l.generationErrorMessage ?? null,
        relatedJobId: l.relatedJobId ?? null,
        relatedAssetId: l.relatedAssetId ?? null,
        lastGenerationSignature: l.lastGenerationSignature ?? null,
        lastGenerationSnapshotJson: l.lastGenerationSnapshotJson ?? null,
      }));
    }
  }

  const raw = readArtifactRaw(taskId, productionListVersionArtifactName(versionRecord.version));
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.lines)) {
        return parsed.lines.map((l: Record<string, unknown>) => ({
          ...l,
          id: l.id,
          order: typeof l.order === "number" ? l.order : 0,
          speaker: l.speaker ?? "narrator",
          text: l.text ?? "",
          voice: l.voice ?? "Zephyr",
          style: l.style ?? "",
          notes: l.notes ?? "",
          status: l.status ?? "pending",
          directorProfileId: l.directorProfileId ?? null,
          directorOverrideJson: l.directorOverrideJson ?? null,
          generationStatus: l.generationStatus ?? "draft",
          relatedJobId: l.relatedJobId ?? null,
          relatedAssetId: l.relatedAssetId ?? null,
          lastGenerationSignature: l.lastGenerationSignature ?? null,
          lastGenerationSnapshotJson: l.lastGenerationSnapshotJson ?? null,
          generationErrorCode: l.generationErrorCode ?? null,
          generationErrorMessage: l.generationErrorMessage ?? null,
        }));
      }
    } catch {
      // Historical artifact parse failures fall through to DB fallback.
    }
  }

  if (!isCurrent) {
    const db = getDb();
    const dbLines = db.select().from(voiceLine)
      .where(eq(voiceLine.versionId, versionRecord.id))
      .orderBy(voiceLine.order)
      .all();

    if (dbLines.length > 0) {
      return dbLines.map((l) => ({
        id: logicalLineId(l),
        order: l.order,
        speaker: l.speaker,
        text: l.text,
        voice: l.voice,
        style: l.style,
        notes: l.notes,
        status: l.status,
        directorProfileId: l.directorProfileId ?? null,
        directorOverrideJson: l.directorOverrideJson ?? null,
        generationStatus: l.generationStatus ?? "draft",
        generationErrorCode: l.generationErrorCode ?? null,
        generationErrorMessage: l.generationErrorMessage ?? null,
        relatedJobId: l.relatedJobId ?? null,
        relatedAssetId: l.relatedAssetId ?? null,
        lastGenerationSignature: l.lastGenerationSignature ?? null,
        lastGenerationSnapshotJson: l.lastGenerationSnapshotJson ?? null,
      }));
    }
  }

  return [];
}
