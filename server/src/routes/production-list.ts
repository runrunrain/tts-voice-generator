/**
 * Production List routes with versioning.
 *
 * GET    /api/tasks/:taskId/production-list              - Get current production list
 * PUT    /api/tasks/:taskId/production-list              - Replace production list (with expectedVersion)
 * PATCH  /api/tasks/:taskId/production-list              - Domain-level patches
 * POST   /api/tasks/:taskId/production-list/validate     - Validate production list
 * POST   /api/tasks/:taskId/production-list/generate     - Generate speech from lines
 * GET    /api/tasks/:taskId/production-list/versions     - Version history
 * GET    /api/tasks/:taskId/production-list/versions/:from/diff/:to - Version diff
 * POST   /api/tasks/:taskId/production-list/rollback     - Rollback to target version
 * GET    /api/tasks/:taskId/production-list/export       - Export (json/md/csv)
 * POST   /api/tasks/:taskId/production-list/import       - Import (json/csv)
 * GET    /api/tasks/:taskId/production-list/quality-report - Quality report
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import crypto from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { directorProfile as dpTable } from "../db/schema-extended.js";
import {
  voiceTask,
  productionListVersion,
  voiceLine,
  operationAuditLog,
} from "../db/schema-extended.js";
import { audioAsset } from "../db/schema.js";
import {
  ProductionListPutSchema,
  ProductionListPatchSchema,
  VoiceLineSchema,
  SpeakerSchema,
  validateProductionList,
  GenerateFromListSchema,
  type LineGenerationResult,
  type GenerateFromListResponse,
  type LineGenerationStatus,
} from "../domain/validators.js";
import {
  writeArtifact,
  readArtifact,
  productionListArtifactName,
  productionListVersionArtifactName,
} from "../services/artifact-store.js";
import { generateSpeech, type GenerateSpeechRequest } from "../services/tts-generator.js";
import { isOpenRouterConfigured } from "../services/key-resolver.js";
import { parseCsv } from "./production-list-modules/csv.js";
import { resolvePromptAssemblyInput } from "./production-list-modules/director-snapshot.js";
import { assemblePrompt } from "../services/prompt-assembly.js";
import {
  buildProductionListExportData,
  formatProductionListCsv,
  formatProductionListMarkdown,
  sanitizeLinesForExport,
} from "./production-list-modules/export-formatters.js";
import { applyPatch } from "./production-list-modules/patch.js";
import { buildQualityReportMetrics } from "./production-list-modules/quality-report.js";
import {
  buildArtifactLineIndexes,
  getCurrentVersion,
  loadProductionList,
  loadVersionLines,
  resolveArtifactLineForDbLine,
} from "./production-list-modules/repository.js";

const app = new Hono();

type VoiceLineRow = typeof voiceLine.$inferSelect;
type PromptResolutionSuccess = Extract<ReturnType<typeof resolvePromptAssemblyInput>, { ok: true }>;

type PreparedGeneration = {
  artifactLine: Record<string, unknown>;
  promptResolution: PromptResolutionSuccess;
  assembledPrompt: ReturnType<typeof assemblePrompt>;
  ttsRequest: GenerateSpeechRequest;
  signature: string;
  snapshotJson: string;
};

function apiError(c: any, requestId: string, status: number, code: string, message: string, category: string, retryable = false, metadata?: unknown) {
  return c.json({ ok: false, requestId, error: { code, message, category, retryable, metadata } }, status);
}

function logicalLineId(line: { id: string; lineId?: string | null }): string {
  return line.lineId ?? line.id;
}

function auditLog(entityType: string, entityId: string, operation: string, actor: string, snapshot?: unknown, requestId?: string) {
  try {
    const db = getDb();
    db.insert(operationAuditLog).values({
      entityType,
      entityId,
      operation,
      actor,
      snapshotJson: snapshot ? JSON.stringify(snapshot) : null,
      requestId: requestId ?? null,
      createdAt: new Date(),
    }).run();
  } catch { /* non-critical */ }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildGenerationSnapshot(input: {
  line: VoiceLineRow;
  lineId: string;
  artifactLine: Record<string, unknown>;
  promptResolution: PromptResolutionSuccess;
  assembledPrompt: ReturnType<typeof assemblePrompt>;
  ttsRequest: GenerateSpeechRequest;
}) {
  const { line, lineId, artifactLine, promptResolution, assembledPrompt, ttsRequest } = input;
  return {
    schemaVersion: "tts.line-generation-snapshot.v1",
    lineId,
    transcript: line.text,
    voice: line.voice,
    model: ttsRequest.model,
    responseFormat: ttsRequest.responseFormat,
    promptProfileId: promptResolution.profileId,
    directorProfileId: line.directorProfileId ?? null,
    directorOverrideJson: line.directorOverrideJson ?? null,
    promptOverride: artifactLine.promptOverride ?? null,
    promptInput: promptResolution.input,
    assembledPromptHash: sha256Hex(assembledPrompt.prompt),
    directorSnapshot: assembledPrompt.normalized,
  };
}

function parseHistoryLimit(rawLimit: string | undefined): number {
  const parsed = rawLimit ? parseInt(rawLimit, 10) : 50;
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 100);
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function findAudioAsset(assetId: number | null, jobId: string | null) {
  const db = getDb();
  if (assetId !== null) {
    return db.select().from(audioAsset).where(eq(audioAsset.id, assetId)).get() ?? null;
  }
  if (jobId !== null) {
    return db.select().from(audioAsset)
      .where(eq(audioAsset.jobId, jobId))
      .orderBy(desc(audioAsset.createdAt), desc(audioAsset.id))
      .limit(1)
      .get() ?? null;
  }
  return null;
}

function prepareGenerationForLine(input: {
  line: VoiceLineRow;
  productionArtifact: { lines?: Array<Record<string, unknown>> } | null;
  artifactProfiles: Array<Record<string, unknown>>;
}): { ok: true; prepared: PreparedGeneration } | { ok: false; code: string; message: string } {
  const { line, productionArtifact, artifactProfiles } = input;
  const lineId = logicalLineId(line);
  const artifactLine = productionArtifact?.lines?.find((al) => al?.id === lineId) ?? {};
  const promptResolution = resolvePromptAssemblyInput(line, artifactLine, artifactProfiles as any);
  if (!promptResolution.ok) {
    return { ok: false, code: promptResolution.code, message: promptResolution.message };
  }

  const assembledPrompt = assemblePrompt(promptResolution.input);
  const ttsRequest: GenerateSpeechRequest = {
    model: typeof artifactLine.model === "string" ? artifactLine.model : "google/gemini-3.1-flash-tts-preview",
    input: assembledPrompt.prompt,
    voice: line.voice,
    responseFormat: (artifactLine.responseFormat === "pcm" || artifactLine.responseFormat === "mp3" || artifactLine.responseFormat === "wav")
      ? artifactLine.responseFormat
      : "wav",
    directorSnapshot: assembledPrompt.normalized,
  };
  const snapshot = buildGenerationSnapshot({ line, lineId, artifactLine, promptResolution, assembledPrompt, ttsRequest });
  const signature = sha256Hex(stableStringify(snapshot));
  const snapshotJson = JSON.stringify({ ...snapshot, signature });
  return { ok: true, prepared: { artifactLine, promptResolution, assembledPrompt, ttsRequest, signature, snapshotJson } };
}

// ─── GET /api/tasks/:taskId/production-list ────────────────────────────────────

app.get("/api/tasks/:taskId/production-list", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const currentVersion = getCurrentVersion(taskId);
  if (currentVersion === 0) {
    return c.json({
      ok: true,
      requestId,
      productionList: {
        taskId,
        version: 0,
        lines: [],
        speakers: [],
        directorProfileId: null,
        metadata: {},
      },
    });
  }

  const latestVersion = db.select().from(productionListVersion)
    .where(and(
      eq(productionListVersion.taskId, taskId),
      eq(productionListVersion.version, currentVersion),
    ))
    .get();

  if (!latestVersion) {
    return c.json({
      ok: true,
      requestId,
      productionList: {
        taskId,
        version: 0,
        lines: [],
        speakers: [],
        directorProfileId: null,
        metadata: {},
      },
    });
  }

  const pl = loadProductionList(taskId, latestVersion.id);
  return c.json({ ok: true, requestId, productionList: pl });
});

// ─── PUT /api/tasks/:taskId/production-list ────────────────────────────────────

app.put("/api/tasks/:taskId/production-list", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = ProductionListPutSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { expectedVersion, lines, speakers, promptProfiles, directorProfiles, directorProfileId, metadata } = parsed.data;

  // Version conflict check
  const currentVersion = getCurrentVersion(taskId);
  if (expectedVersion !== currentVersion) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${currentVersion}.`, "conflict", true, {
      expectedVersion,
      currentVersion,
    });
  }

  const newVersion = currentVersion + 1;
  const versionId = uuidv4();
  const now = new Date();

  // Create version record
  db.insert(productionListVersion).values({
    id: versionId,
    taskId,
    version: newVersion,
    directorProfileId: directorProfileId ?? null,
    speakersJson: JSON.stringify(speakers),
    metadataJson: JSON.stringify(metadata),
    lineCount: lines.length,
    createdAt: now,
  }).run();

  // Insert voice-line index rows. `voice_line.id` is now a version-row id while
  // `voice_line.line_id` keeps the stable logical line id used by artifacts/API.
  // Do not delete prior version rows: historical DB indexes must remain intact.
  for (const line of lines) {
    db.insert(voiceLine).values({
      id: uuidv4(),
      lineId: line.id || uuidv4(),
      taskId,
      versionId,
      order: line.order,
      speaker: line.speaker,
      text: line.text,
      voice: line.voice,
      style: line.style ?? "",
      notes: line.notes ?? "",
      status: line.status ?? "pending",
      directorProfileId: line.directorProfileId ?? line.promptProfileId ?? null,
      directorOverrideJson: line.directorOverrideJson ?? null,
      generationStatus: line.generationStatus ?? "draft",
      relatedJobId: line.relatedJobId ?? null,
      relatedAssetId: line.relatedAssetId ?? null,
      lastGenerationSignature: line.lastGenerationSignature ?? null,
      lastGenerationSnapshotJson: line.lastGenerationSnapshotJson ?? null,
      generationErrorCode: line.generationErrorCode ?? null,
      generationErrorMessage: line.generationErrorMessage ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  // Store full production list in current artifact
  const artifactData = {
    schemaVersion: promptProfiles.length > 0 || directorProfiles.length > 0 ? "tts.production-list.v2" : metadata.schemaVersion,
    version: newVersion,
    versionId,
    lines: lines.map((line) => ({
      ...line,
      transcript: line.transcript ?? line.text,
      promptProfileId: line.promptProfileId ?? line.directorProfileId ?? null,
      directorProfileId: line.directorProfileId ?? line.promptProfileId ?? null,
    })),
    speakers,
    promptProfiles: promptProfiles.length > 0 ? promptProfiles : directorProfiles,
    directorProfiles: directorProfiles.length > 0 ? directorProfiles : promptProfiles,
    directorProfileId,
    metadata: {
      ...metadata,
      ...(promptProfiles.length > 0 || directorProfiles.length > 0 ? { schemaVersion: "tts.production-list.v2" } : {}),
    },
    updatedAt: now.toISOString(),
  };
  writeArtifact(taskId, productionListArtifactName(), artifactData);

  // Also write a versioned snapshot so rollback/diff can read historical data
  writeArtifact(taskId, productionListVersionArtifactName(newVersion), artifactData);

  auditLog("production_list", versionId, "put", "user", { taskId, version: newVersion, lineCount: lines.length }, requestId);

  const pl = loadProductionList(taskId, versionId);
  return c.json({ ok: true, requestId, productionList: pl });
});

// ─── PATCH /api/tasks/:taskId/production-list ──────────────────────────────────

app.patch("/api/tasks/:taskId/production-list", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = ProductionListPatchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { op, payload, expectedVersion } = parsed.data;

  // Version conflict check
  const currentVersion = getCurrentVersion(taskId);
  if (expectedVersion !== currentVersion) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${currentVersion}.`, "conflict", true, {
      expectedVersion,
      currentVersion,
    });
  }

  // Get current version
  const latestVersion = db.select().from(productionListVersion)
    .where(and(
      eq(productionListVersion.taskId, taskId),
      eq(productionListVersion.version, currentVersion),
    ))
    .get();

  if (!latestVersion) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "No production list exists for this task.", "validation");
  }

  // Get current lines. DB stores query indexes; artifact stores the full voice-line
  // contract (model/responseFormat/directorProfileId and future extension fields).
  // PATCH must start from the merged view, otherwise any patch operation would
  // silently drop artifact-only fields when writing the next version.
  const currentLines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, latestVersion.id))
    .orderBy(voiceLine.order)
    .all();

  const currentArtifact = readArtifact<{ lines?: Array<Record<string, unknown>>; speakers?: unknown[] }>(taskId, productionListArtifactName());
  const artifactLineIndexes = buildArtifactLineIndexes(currentArtifact?.lines);
  const mergedCurrentLines = currentLines.map((line) => {
    const artifactLine = resolveArtifactLineForDbLine(line, artifactLineIndexes, currentLines.length) ?? {};
    return {
      ...artifactLine,
      id: logicalLineId(line),
      order: line.order,
      speaker: line.speaker,
      text: line.text,
      voice: line.voice,
      style: line.style,
      notes: line.notes,
      status: line.status,
      directorProfileId: line.directorProfileId ?? (artifactLine.directorProfileId ?? null),
      directorOverrideJson: line.directorOverrideJson ?? (artifactLine.directorOverrideJson ?? null),
      generationStatus: line.generationStatus ?? (artifactLine.generationStatus ?? "draft"),
      relatedJobId: line.relatedJobId ?? (artifactLine.relatedJobId ?? null),
      relatedAssetId: line.relatedAssetId ?? (artifactLine.relatedAssetId ?? null),
      lastGenerationSignature: line.lastGenerationSignature ?? (artifactLine.lastGenerationSignature ?? null),
      lastGenerationSnapshotJson: line.lastGenerationSnapshotJson ?? (artifactLine.lastGenerationSnapshotJson ?? null),
      generationErrorCode: line.generationErrorCode ?? (artifactLine.generationErrorCode ?? null),
      generationErrorMessage: line.generationErrorMessage ?? (artifactLine.generationErrorMessage ?? null),
    };
  });

  // Apply domain-level patch
  let newLines: any[];
  let newSpeakers: unknown[] | undefined;
  try {
    const patchResult = applyPatch(op, payload, mergedCurrentLines, currentArtifact?.speakers ?? []);
    newLines = patchResult.lines;
    newSpeakers = patchResult.speakers;
  } catch (patchErr) {
    const msg = patchErr instanceof Error ? patchErr.message : "Patch operation failed";
    if (msg.includes("not found")) {
      return apiError(c, requestId, 404, "PATCH_TARGET_NOT_FOUND", msg, "validation");
    }
    return apiError(c, requestId, 400, "PATCH_ERROR", msg, "validation");
  }

  // Validate patched lines
  const lineValidation = newLines.map((l) => VoiceLineSchema.safeParse(l));
  const invalidLines = lineValidation.filter((v) => !v.success);
  if (invalidLines.length > 0) {
    return apiError(c, requestId, 400, "PATCH_VALIDATION_ERROR", "Patched lines failed validation.", "validation", false, {
      issues: invalidLines.map((v) => v.success ? null : (v as any).error?.flatten()),
    });
  }

  // Create new version with patched lines
  const validatedLines = lineValidation.map((v) => v.success ? v.data : null).filter(Boolean);

  // Get current speakers from artifact (may be overridden by patch)
  const speakers = newSpeakers ?? currentArtifact?.speakers ?? [];

  const newVersion = currentVersion + 1;
  const versionId = uuidv4();
  const now = new Date();

  db.insert(productionListVersion).values({
    id: versionId,
    taskId,
    version: newVersion,
    directorProfileId: latestVersion.directorProfileId,
    speakersJson: JSON.stringify(speakers),
    metadataJson: latestVersion.metadataJson,
    lineCount: validatedLines.length,
    createdAt: now,
  }).run();

  for (const line of validatedLines) {
    db.insert(voiceLine).values({
      id: uuidv4(),
      lineId: (line as any).id || uuidv4(),
      taskId,
      versionId,
      order: (line as any).order,
      speaker: (line as any).speaker,
      text: (line as any).text,
      voice: (line as any).voice,
      style: (line as any).style ?? "",
      notes: (line as any).notes ?? "",
      status: (line as any).status ?? "pending",
      directorProfileId: (line as any).directorProfileId ?? null,
      directorOverrideJson: (line as any).directorOverrideJson ?? null,
      generationStatus: (line as any).generationStatus ?? "draft",
      relatedJobId: (line as any).relatedJobId ?? null,
      relatedAssetId: (line as any).relatedAssetId ?? null,
      lastGenerationSignature: (line as any).lastGenerationSignature ?? null,
      lastGenerationSnapshotJson: (line as any).lastGenerationSnapshotJson ?? null,
      generationErrorCode: (line as any).generationErrorCode ?? null,
      generationErrorMessage: (line as any).generationErrorMessage ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  const patchArtifactData = {
    schemaVersion: (currentArtifact as any)?.schemaVersion,
    version: newVersion,
    versionId,
    lines: validatedLines.map((line: any) => ({
      ...line,
      transcript: line.transcript ?? line.text,
      promptProfileId: line.promptProfileId ?? line.directorProfileId ?? null,
      directorProfileId: line.directorProfileId ?? line.promptProfileId ?? null,
    })),
    speakers,
    promptProfiles: (currentArtifact as any)?.promptProfiles ?? (currentArtifact as any)?.directorProfiles ?? [],
    directorProfiles: (currentArtifact as any)?.directorProfiles ?? (currentArtifact as any)?.promptProfiles ?? [],
    directorProfileId: latestVersion.directorProfileId,
    metadata: latestVersion.metadataJson ? JSON.parse(latestVersion.metadataJson) : {},
    updatedAt: now.toISOString(),
  };
  writeArtifact(taskId, productionListArtifactName(), patchArtifactData);

  // Also write a versioned snapshot so rollback/diff can read historical data
  writeArtifact(taskId, productionListVersionArtifactName(newVersion), patchArtifactData);

  auditLog("production_list", versionId, `patch:${op}`, "user", { taskId, version: newVersion, op }, requestId);

  const pl = loadProductionList(taskId, versionId);
  return c.json({ ok: true, requestId, productionList: pl });
});

// ─── POST /api/tasks/:taskId/production-list/validate ──────────────────────────

app.post("/api/tasks/:taskId/production-list/validate", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }

  if (body && typeof body === "object" && Array.isArray((body as any).lines)) {
    const lines = (body as any).lines;
    const speakers = Array.isArray((body as any).speakers) ? (body as any).speakers : [];
    const lineValidation = lines.map((line: unknown) => VoiceLineSchema.safeParse(line));
    const speakerValidation = speakers.map((speaker: unknown) => SpeakerSchema.safeParse(speaker));
    const invalidLineIssues = lineValidation
      .map((result: any, index: number) => result.success ? null : ({ severity: "error", code: "INVALID_LINE", message: `Line ${index + 1} failed schema validation`, field: `lines[${index}]` }))
      .filter(Boolean);
    const invalidSpeakerIssues = speakerValidation
      .map((result: any, index: number) => result.success ? null : ({ severity: "error", code: "INVALID_SPEAKER", message: `Speaker ${index + 1} failed schema validation`, field: `speakers[${index}]` }))
      .filter(Boolean);

    if (invalidLineIssues.length > 0 || invalidSpeakerIssues.length > 0) {
      return c.json({
        ok: true,
        requestId,
        validation: {
          valid: false,
          issues: [...invalidLineIssues, ...invalidSpeakerIssues],
          stats: { totalLines: lines.length, speakers: [], maxOrder: -1 },
        },
      });
    }

    const report = validateProductionList({
      lines: lineValidation.map((result: any) => result.data),
      speakers: speakerValidation.map((result: any) => result.data),
    });

    return c.json({ ok: true, requestId, validation: report });
  }

  const currentVersion = getCurrentVersion(taskId);
  if (currentVersion === 0) {
    return c.json({
      ok: true,
      requestId,
      validation: {
        valid: false,
        issues: [{ severity: "info", code: "NO_PRODUCTION_LIST", message: "No production list exists for this task." }],
        stats: { totalLines: 0, speakers: [], maxOrder: -1 },
      },
    });
  }

  const latestVersion = db.select().from(productionListVersion)
    .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, currentVersion)))
    .get();

  if (!latestVersion) {
    return c.json({
      ok: true,
      requestId,
      validation: {
        valid: false,
        issues: [{ severity: "error", code: "VERSION_NOT_FOUND", message: "Current version record not found." }],
        stats: { totalLines: 0, speakers: [], maxOrder: -1 },
      },
    });
  }

  const lines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, latestVersion.id))
    .orderBy(voiceLine.order)
    .all();

  const speakers: any[] = [];
  try {
    const parsed = JSON.parse(latestVersion.speakersJson);
    if (Array.isArray(parsed)) speakers.push(...parsed);
  } catch { /* ignore */ }

  const report = validateProductionList({
    lines: lines.map((l) => ({
      id: logicalLineId(l),
      order: l.order,
      speaker: l.speaker,
      text: l.text,
      voice: l.voice,
      style: l.style,
      notes: l.notes,
      status: l.status as "pending" | "approved" | "generating" | "generated" | "failed",
      model: "google/gemini-3.1-flash-tts-preview",
      responseFormat: "wav" as const,
      generationStatus: (l.generationStatus ?? "draft") as "draft" | "ready" | "pending" | "running" | "succeeded" | "failed" | "needs_revision",
    })),
    speakers,
  });

  return c.json({ ok: true, requestId, validation: report });
});

// ─── POST /api/tasks/:taskId/production-list/generate ──────────────────────────

app.post("/api/tasks/:taskId/production-list/generate", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  // 1. Task existence check
  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  // 2. Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = GenerateFromListSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { expectedVersion, lineIds, skipCompleted, forceRegenerate, source, confirm } = parsed.data;

  // 2.5 Cost guard: non-user sources must explicitly confirm cost action
  if (source !== "user" && !confirm) {
    return apiError(c, requestId, 403, "COST_CONFIRMATION_REQUIRED",
      `Generation from source "${source}" requires explicit cost confirmation (confirm: true). ` +
      `This prevents automated tools from silently triggering real external cost actions.`,
      "auth", false, { source, hint: "Set confirm: true in the request body to proceed." });
  }

  // 3. Version conflict check (only if expectedVersion provided)
  const currentVersion = getCurrentVersion(taskId);
  if (currentVersion === 0) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "No production list exists for this task.", "validation");
  }

  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${currentVersion}.`, "conflict", true, {
      expectedVersion,
      currentVersion,
    });
  }

  // 4. Load current version lines
  const latestVersion = db.select().from(productionListVersion)
    .where(and(
      eq(productionListVersion.taskId, taskId),
      eq(productionListVersion.version, currentVersion),
    ))
    .get();

  if (!latestVersion) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "Current version record not found.", "validation");
  }

  const allLines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, latestVersion.id))
    .orderBy(voiceLine.order)
    .all();

  const productionArtifact = readArtifact<{
    lines?: Array<Record<string, unknown>>;
    promptProfiles?: Array<Record<string, unknown>>;
    directorProfiles?: Array<Record<string, unknown>>;
  }>(taskId, productionListArtifactName());
  const artifactProfiles = Array.isArray(productionArtifact?.promptProfiles)
    ? productionArtifact.promptProfiles
    : (Array.isArray(productionArtifact?.directorProfiles) ? productionArtifact.directorProfiles : []);

  if (allLines.length === 0) {
    return apiError(c, requestId, 400, "EMPTY_PRODUCTION_LIST", "Production list has no lines to generate.", "validation");
  }

  // 5. Determine target lines
  let targetLines = allLines;
  if (lineIds && lineIds.length > 0) {
    // Explicit selection
    const requestedIds = new Set(lineIds);
    targetLines = allLines.filter((l) => requestedIds.has(logicalLineId(l)));

    // Check for missing line IDs
    const foundIds = new Set(targetLines.map((l) => logicalLineId(l)));
    const missingIds = lineIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      return apiError(c, requestId, 404, "LINES_NOT_FOUND", `Lines not found in current version: ${missingIds.join(", ")}`, "validation");
    }
  }

  // 6. Filter out ineligible lines
  const results: LineGenerationResult[] = [];
  const preparedByLineId = new Map<string, PreparedGeneration>();
  const eligibleLines = targetLines.filter((line) => {
    const lineId = logicalLineId(line);
    const genStatus = (line.generationStatus ?? "draft") as LineGenerationStatus;
    // MIN-1: also skip "pending" to align with frontend ACTIVE_STATUSES = ["pending", "running"]
    if (genStatus === "running" || genStatus === "pending") {
      results.push({
        lineId,
        status: "skipped",
        jobId: line.relatedJobId,
        assetId: line.relatedAssetId,
        errorMessage: `Line already in "${genStatus}" state`,
      });
      return false;
    }
    if (!line.text || line.text.trim().length === 0) {
      results.push({
        lineId,
        status: "skipped",
        errorMessage: "Line has empty text",
      });
      return false;
    }
    if (!line.voice || line.voice.trim().length === 0) {
      results.push({
        lineId,
        status: "skipped",
        errorMessage: "Line has no voice configured",
      });
      return false;
    }
    const prepared = prepareGenerationForLine({
      line,
      productionArtifact: productionArtifact ?? null,
      artifactProfiles: artifactProfiles as Array<Record<string, unknown>>,
    });
    if (prepared.ok) {
      preparedByLineId.set(lineId, prepared.prepared);
      if (skipCompleted && genStatus === "succeeded" && !forceRegenerate) {
        if (!line.lastGenerationSignature) {
          results.push({
            lineId,
            status: "skipped",
            jobId: line.relatedJobId,
            assetId: line.relatedAssetId,
            errorMessage: "Line already succeeded and has no generation snapshot; select it explicitly to force regeneration",
          });
          return false;
        }
        if (line.lastGenerationSignature === prepared.prepared.signature) {
          results.push({
            lineId,
            status: "skipped",
            jobId: line.relatedJobId,
            assetId: line.relatedAssetId,
            errorMessage: "Line already succeeded and current content/director signature is unchanged",
          });
          return false;
        }
      }
    }
    return true;
  });

  if (eligibleLines.length === 0) {
    // All lines were skipped
    return c.json({
      ok: true,
      requestId,
      generation: {
        taskId,
        version: currentVersion,
        requestedCount: targetLines.length,
        succeededCount: 0,
        failedCount: 0,
        skippedCount: results.length,
        results,
      } satisfies GenerateFromListResponse,
    });
  }

  // 7. Check API key availability
  const apiKeyConfigured = isOpenRouterConfigured();

  // 8. Process each eligible line
  let succeededCount = 0;
  let failedCount = 0;

  for (const line of eligibleLines) {
    const lineId = logicalLineId(line);

    // Mark as running -- clear stale error fields from previous failure
    db.update(voiceLine).set({
      generationStatus: "running",
      generationErrorCode: null,
      generationErrorMessage: null,
      updatedAt: new Date(),
    }).where(eq(voiceLine.id, line.id)).run();

    if (!apiKeyConfigured) {
      // No API key - record failure with error details and continue
      db.update(voiceLine).set({
        generationStatus: "failed",
        generationErrorCode: "MISSING_API_KEY",
        generationErrorMessage: "OpenRouter API Key is not configured. Please go to Settings and configure your API key.",
        updatedAt: new Date(),
      }).where(eq(voiceLine.id, line.id)).run();

      results.push({
        lineId,
        status: "failed",
        errorCode: "MISSING_API_KEY",
        errorMessage: "OpenRouter API Key is not configured. Please go to Settings and configure your API key.",
      });
      failedCount++;
      continue;
    }

    let preparedGeneration = preparedByLineId.get(lineId);
    if (!preparedGeneration) {
      const preparedResult = prepareGenerationForLine({
        line,
        productionArtifact: productionArtifact ?? null,
        artifactProfiles: artifactProfiles as Array<Record<string, unknown>>,
      });
      if (!preparedResult.ok) {
        db.update(voiceLine).set({
          generationStatus: "failed",
          generationErrorCode: preparedResult.code,
          generationErrorMessage: preparedResult.message,
          updatedAt: new Date(),
        }).where(eq(voiceLine.id, line.id)).run();

        results.push({
          lineId,
          status: "failed",
          errorCode: preparedResult.code,
          errorMessage: preparedResult.message,
        });
        failedCount++;
        continue;
      }
      preparedGeneration = preparedResult.prepared;
    }
    if (!preparedGeneration) {
      db.update(voiceLine).set({
        generationStatus: "failed",
        generationErrorCode: "INTERNAL_ERROR",
        generationErrorMessage: "Generation preparation failed without details",
        updatedAt: new Date(),
      }).where(eq(voiceLine.id, line.id)).run();

      results.push({
        lineId,
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        errorMessage: "Generation preparation failed without details",
      });
      failedCount++;
      continue;
    }
    const ttsRequest = preparedGeneration.ttsRequest;

    try {
      const genResult = await generateSpeech(ttsRequest, uuidv4(), { source });
      const genBody = genResult.body;

      if (genBody.ok && genBody.status === "succeeded") {
        // Success - update line with job/asset references, clear any stale error fields
        db.update(voiceLine).set({
          generationStatus: "succeeded",
          relatedJobId: typeof genBody.jobId === "string" ? genBody.jobId : null,
          relatedAssetId: typeof genBody.assetId === "number" ? genBody.assetId : null,
          lastGenerationSignature: preparedGeneration.signature,
          lastGenerationSnapshotJson: preparedGeneration.snapshotJson,
          generationErrorCode: null,
          generationErrorMessage: null,
          updatedAt: new Date(),
        }).where(eq(voiceLine.id, line.id)).run();

        if (line.relatedJobId || line.relatedAssetId) {
          auditLog("voice_line", lineId, "regenerate", source, {
            taskId,
            version: currentVersion,
            previousJobId: line.relatedJobId ?? null,
            previousAssetId: line.relatedAssetId ?? null,
            nextJobId: typeof genBody.jobId === "string" ? genBody.jobId : null,
            nextAssetId: typeof genBody.assetId === "number" ? genBody.assetId : null,
            lastGenerationSignature: preparedGeneration.signature,
          }, requestId);
        }

        results.push({
          lineId,
          status: "succeeded",
          jobId: typeof genBody.jobId === "string" ? genBody.jobId : null,
          assetId: typeof genBody.assetId === "number" ? genBody.assetId : null,
          audioUrl: typeof genBody.audioUrl === "string" ? genBody.audioUrl : null,
        });
        succeededCount++;
      } else {
        // Generation failed - record error with persistent error fields
        const errorCode = (genBody.error as { code?: string })?.code ?? "GENERATION_FAILED";
        const errorMessage = (genBody.error as { message?: string })?.message ?? "Generation failed";

        db.update(voiceLine).set({
          generationStatus: "failed",
          relatedJobId: typeof genBody.jobId === "string" ? genBody.jobId : null,
          generationErrorCode: errorCode,
          generationErrorMessage: errorMessage,
          updatedAt: new Date(),
        }).where(eq(voiceLine.id, line.id)).run();

        results.push({
          lineId,
          status: "failed",
          jobId: typeof genBody.jobId === "string" ? genBody.jobId : null,
          errorCode,
          errorMessage,
        });
        failedCount++;
      }
    } catch (err) {
      // Unexpected error
      const safeMsg = err instanceof Error ? err.message : "Unknown generation error";

      db.update(voiceLine).set({
        generationStatus: "failed",
        generationErrorCode: "INTERNAL_ERROR",
        generationErrorMessage: safeMsg,
        updatedAt: new Date(),
      }).where(eq(voiceLine.id, line.id)).run();

      results.push({
        lineId,
        status: "failed",
        errorCode: "INTERNAL_ERROR",
        errorMessage: safeMsg,
      });
      failedCount++;
    }
  }

  // 9. Write audit log
  auditLog("production_list", latestVersion.id, "generate", source, {
    taskId,
    version: currentVersion,
    requestedCount: targetLines.length,
    succeededCount,
    failedCount,
    skippedCount: results.filter((r) => r.status === "skipped").length,
    source,
  }, requestId);

  return c.json({
    ok: true,
    requestId,
    generation: {
      taskId,
      version: currentVersion,
      requestedCount: targetLines.length,
      succeededCount,
      failedCount,
      skippedCount: results.filter((r) => r.status === "skipped").length,
      results,
    } satisfies GenerateFromListResponse,
  });
});

// ─── GET /api/tasks/:taskId/production-list/lines/:lineId/audio-history ──────

app.get("/api/tasks/:taskId/production-list/lines/:lineId/audio-history", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const lineId = c.req.param("lineId");
  const limit = parseHistoryLimit(c.req.query("limit"));
  const db = getDb();

  if (!lineId || lineId.trim().length === 0) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Line id is required.", "validation");
  }

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const currentVersion = getCurrentVersion(taskId);
  const versions = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .limit(limit)
    .all();

  const history = [];
  for (const version of versions) {
    const versionLines = loadVersionLines(taskId, version);
    const line = versionLines.find((candidate) => candidate.id === lineId);
    if (!line) continue;

    const relatedJobId = normalizeNullableString(line.relatedJobId);
    const rawAssetId = normalizeNullableNumber(line.relatedAssetId);
    if (relatedJobId === null && rawAssetId === null) continue;

    const asset = findAudioAsset(rawAssetId, relatedJobId);
    const relatedAssetId = rawAssetId ?? asset?.id ?? null;
    const hasAvailableAsset = asset !== null && relatedAssetId !== null;

    history.push({
      version: version.version,
      versionId: version.id,
      lineId,
      sortOrder: typeof line.order === "number" ? line.order : null,
      generationStatus: typeof line.generationStatus === "string" ? line.generationStatus : "draft",
      voice: normalizeNullableString(line.voice),
      relatedJobId,
      relatedAssetId,
      audioUrl: hasAvailableAsset ? `/api/audio/${relatedAssetId}` : null,
      downloadUrl: hasAvailableAsset ? `/api/audio/${relatedAssetId}?download=1` : null,
      createdAt: version.createdAt.toISOString(),
      isCurrent: version.version === currentVersion,
    });
  }

  return c.json({
    ok: true,
    requestId,
    taskId,
    lineId,
    history,
  });
});

// ─── GET /api/tasks/:taskId/production-list/versions ────────────────────────

app.get("/api/tasks/:taskId/production-list/versions", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const versions = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .all();

  return c.json({
    ok: true,
    requestId,
    versions: versions.map((v) => ({
      version: v.version,
      versionId: v.id,
      lineCount: v.lineCount,
      directorProfileId: v.directorProfileId,
      createdAt: v.createdAt.toISOString(),
    })),
  });
});

// ─── GET /api/tasks/:taskId/production-list/versions/:fromVersion/diff/:toVersion ─

app.get("/api/tasks/:taskId/production-list/versions/:fromVersion/diff/:toVersion", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const fromVersion = parseInt(c.req.param("fromVersion"), 10);
  const toVersion = parseInt(c.req.param("toVersion"), 10);
  const db = getDb();

  if (isNaN(fromVersion) || isNaN(toVersion)) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Version parameters must be integers.", "validation");
  }

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const fromVer = db.select().from(productionListVersion)
    .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, fromVersion)))
    .get();
  const toVer = db.select().from(productionListVersion)
    .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, toVersion)))
    .get();

  if (!fromVer) {
    return apiError(c, requestId, 404, "VERSION_NOT_FOUND", `Version ${fromVersion} not found.`, "validation");
  }
  if (!toVer) {
    return apiError(c, requestId, 404, "VERSION_NOT_FOUND", `Version ${toVersion} not found.`, "validation");
  }

  // Load lines for both versions (from DB for current, from versioned artifact for historical)
  const fromLinesRaw = loadVersionLines(taskId, fromVer);
  const toLinesRaw = loadVersionLines(taskId, toVer);

  type LineLike = { id: string; order?: number; text?: string; speaker?: string; voice?: string; style?: string; notes?: string; directorProfileId?: string | null; generationStatus?: string; status?: string };
  const fromLines = fromLinesRaw as LineLike[];
  const toLines = toLinesRaw as LineLike[];

  // Compute diff
  const fromMap = new Map(fromLines.map((l) => [l.id, l]));
  const toMap = new Map(toLines.map((l) => [l.id, l]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ lineId: string; fields: string[] }> = [];
  const unchanged: string[] = [];

  for (const [id] of toMap) {
    if (!fromMap.has(id)) added.push(id);
  }
  for (const [id] of fromMap) {
    if (!toMap.has(id)) removed.push(id);
  }
  for (const [id, toLine] of toMap) {
    const fromLine = fromMap.get(id);
    if (!fromLine) continue;
    const diffFields: string[] = [];
    if (fromLine.text !== toLine.text) diffFields.push("text");
    if (fromLine.speaker !== toLine.speaker) diffFields.push("speaker");
    if (fromLine.voice !== toLine.voice) diffFields.push("voice");
    if (fromLine.style !== toLine.style) diffFields.push("style");
    if (fromLine.notes !== toLine.notes) diffFields.push("notes");
    if (fromLine.directorProfileId !== toLine.directorProfileId) diffFields.push("directorProfileId");
    if (fromLine.generationStatus !== toLine.generationStatus) diffFields.push("generationStatus");
    if (fromLine.order !== toLine.order) diffFields.push("order");
    if (diffFields.length > 0) {
      changed.push({ lineId: id, fields: diffFields });
    } else {
      unchanged.push(id);
    }
  }

  return c.json({
    ok: true,
    requestId,
    diff: {
      fromVersion,
      toVersion,
      summary: {
        addedCount: added.length,
        removedCount: removed.length,
        changedCount: changed.length,
        unchangedCount: unchanged.length,
        fromLineCount: fromLines.length,
        toLineCount: toLines.length,
      },
      added,
      removed,
      changed,
    },
  });
});

// ─── POST /api/tasks/:taskId/production-list/rollback ───────────────────────

const RollbackSchema = z.object({
  expectedVersion: z.number().int().min(0),
  targetVersion: z.number().int().min(1),
  summary: z.string().optional().default(""),
});

app.post("/api/tasks/:taskId/production-list/rollback", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = RollbackSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { expectedVersion, targetVersion, summary } = parsed.data;

  // Version conflict check
  const currentVersion = getCurrentVersion(taskId);
  if (expectedVersion !== currentVersion) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${currentVersion}.`, "conflict", true, {
      expectedVersion,
      currentVersion,
    });
  }

  if (targetVersion > currentVersion) {
    return apiError(c, requestId, 400, "INVALID_TARGET_VERSION", `Target version ${targetVersion} is newer than current version ${currentVersion}.`, "validation");
  }

  // Load target version
  const targetVer = db.select().from(productionListVersion)
    .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, targetVersion)))
    .get();

  if (!targetVer) {
    return apiError(c, requestId, 404, "VERSION_NOT_FOUND", `Target version ${targetVersion} not found.`, "validation");
  }

  // Load target lines from versioned artifact (DB only holds current version rows)
  const targetLinesRaw = loadVersionLines(taskId, targetVer);
  type TargetLine = { id: string; order?: number; speaker?: string; text?: string; voice?: string; style?: string; notes?: string; status?: string; directorProfileId?: string | null; directorOverrideJson?: string | null; generationStatus?: string; relatedJobId?: string | null; relatedAssetId?: number | null; generationErrorCode?: string | null; generationErrorMessage?: string | null };
  const targetLines = targetLinesRaw as TargetLine[];

  // Copy-on-write: create a new version from the target version's data
  const newVersion = currentVersion + 1;
  const versionId = uuidv4();
  const now = new Date();

  // Build merged lines for artifact (using target artifact data when available)
  const mergedLinesForArtifact = targetLines.map((l) => ({
    ...l,
    id: l.id,
    order: l.order ?? 0,
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
    generationErrorCode: l.generationErrorCode ?? null,
    generationErrorMessage: l.generationErrorMessage ?? null,
  }));

  // Create new version record
  db.insert(productionListVersion).values({
    id: versionId,
    taskId,
    version: newVersion,
    directorProfileId: targetVer.directorProfileId,
    speakersJson: targetVer.speakersJson,
    metadataJson: targetVer.metadataJson,
    lineCount: targetLines.length,
    createdAt: now,
  }).run();

  // Insert voice lines for the new version
  for (const line of targetLines) {
    db.insert(voiceLine).values({
      id: uuidv4(),
      lineId: line.id,
      taskId,
      versionId,
      order: line.order ?? 0,
      speaker: line.speaker ?? "narrator",
      text: line.text ?? "",
      voice: line.voice ?? "Zephyr",
      style: line.style ?? "",
      notes: line.notes ?? "",
      status: line.status ?? "pending",
      directorProfileId: line.directorProfileId ?? null,
      directorOverrideJson: line.directorOverrideJson ?? null,
      generationStatus: line.generationStatus ?? "draft",
      relatedJobId: line.relatedJobId ?? null,
      relatedAssetId: line.relatedAssetId ?? null,
      generationErrorCode: line.generationErrorCode ?? null,
      generationErrorMessage: line.generationErrorMessage ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  // Update current artifact
  const speakers = (() => {
    try { return JSON.parse(targetVer.speakersJson); } catch { return []; }
  })();

  writeArtifact(taskId, productionListArtifactName(), {
    version: newVersion,
    versionId,
    lines: mergedLinesForArtifact,
    speakers,
    directorProfileId: targetVer.directorProfileId,
    metadata: (() => { try { return JSON.parse(targetVer.metadataJson); } catch { return {}; } })(),
    updatedAt: now.toISOString(),
    rolledBackFrom: targetVersion,
  });

  // Also save a versioned snapshot
  writeArtifact(taskId, productionListVersionArtifactName(newVersion), {
    version: newVersion,
    versionId,
    lines: mergedLinesForArtifact,
    speakers,
    directorProfileId: targetVer.directorProfileId,
    metadata: (() => { try { return JSON.parse(targetVer.metadataJson); } catch { return {}; } })(),
    updatedAt: now.toISOString(),
    rolledBackFrom: targetVersion,
  });

  auditLog("production_list", versionId, "rollback", "user", {
    taskId,
    fromVersion: currentVersion,
    targetVersion,
    newVersion,
    summary,
  }, requestId);

  const pl = loadProductionList(taskId, versionId);
  return c.json({
    ok: true,
    requestId,
    productionList: pl,
    rollback: {
      fromVersion: currentVersion,
      targetVersion,
      newVersion,
    },
  });
});

// ─── GET /api/tasks/:taskId/production-list/export ──────────────────────────

app.get("/api/tasks/:taskId/production-list/export", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const format = c.req.query("format") || "json";
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const currentVersion = getCurrentVersion(taskId);
  if (currentVersion === 0) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "No production list exists for this task.", "validation");
  }

  const latestVersion = db.select().from(productionListVersion)
    .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, currentVersion)))
    .get();

  if (!latestVersion) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "Current version record not found.", "validation");
  }

  const lines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, latestVersion.id))
    .orderBy(voiceLine.order)
    .all();

  // Read artifact for extended line data
  const artifact = readArtifact<{ lines?: Array<Record<string, unknown>>; speakers?: unknown[]; promptProfiles?: Array<Record<string, unknown>>; directorProfiles?: Array<Record<string, unknown>> }>(taskId, productionListArtifactName());
  const artifactLinesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(artifact?.lines)) {
    for (const line of artifact.lines) {
      if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
    }
  }

  const sanitizedLines = sanitizeLinesForExport(lines, artifactLinesById);
  const speakers = (() : Array<Record<string, unknown>> => {
    try {
      const parsedSpeakers = JSON.parse(latestVersion.speakersJson);
      return Array.isArray(parsedSpeakers) ? parsedSpeakers : [];
    } catch {
      return [];
    }
  })();
  const exportProfiles = Array.isArray(artifact?.promptProfiles)
    ? artifact.promptProfiles
    : (Array.isArray(artifact?.directorProfiles) ? artifact.directorProfiles : []);
  const exportData = buildProductionListExportData(taskId, currentVersion, speakers, sanitizedLines, exportProfiles);

  if (format === "csv") {
    return c.text(formatProductionListCsv(sanitizedLines), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="production-list-v${currentVersion}.csv"`,
    });
  }

  if (format === "md" || format === "markdown") {
    const exportSpeakers = Array.isArray(exportData.speakers) ? exportData.speakers as Array<Record<string, unknown>> : [];
    return c.text(formatProductionListMarkdown(taskId, currentVersion, exportData.exportedAt, exportSpeakers, sanitizedLines, exportProfiles), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="production-list-v${currentVersion}.md"`,
    });
  }

  // JSON export (default)
  return c.json(exportData, 200, {
    "Content-Disposition": `attachment; filename="production-list-v${currentVersion}.json"`,
  });
});

// ─── POST /api/tasks/:taskId/production-list/import ─────────────────────────

const ImportSchema = z.object({
  expectedVersion: z.number().int().min(0),
  format: z.enum(["json", "csv"]).optional().default("json"),
  data: z.unknown(),
  summary: z.string().optional().default(""),
});

app.post("/api/tasks/:taskId/production-list/import", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { expectedVersion, format, data, summary } = parsed.data;

  // Version conflict check
  const currentVersion = getCurrentVersion(taskId);
  if (expectedVersion !== currentVersion) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${currentVersion}.`, "conflict", true, {
      expectedVersion,
      currentVersion,
    });
  }

  let importedLines: unknown[];
  let importedPromptProfiles: Array<Record<string, unknown>> = [];

  if (format === "json") {
    // JSON import: expect { lines: [...], speakers?: [...] }
    if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>).lines)) {
      return apiError(c, requestId, 400, "IMPORT_FORMAT_ERROR", "JSON import data must contain a 'lines' array.", "validation");
    }
    importedLines = (data as Record<string, unknown>).lines as unknown[];
    const rawProfiles = (data as Record<string, unknown>).promptProfiles ?? (data as Record<string, unknown>).directorProfiles;
    importedPromptProfiles = Array.isArray(rawProfiles) ? rawProfiles.filter((profile): profile is Record<string, unknown> => Boolean(profile && typeof profile === "object" && !Array.isArray(profile))) : [];
  } else {
    // CSV import: data should be a string
    if (typeof data !== "string") {
      return apiError(c, requestId, 400, "IMPORT_FORMAT_ERROR", "CSV import data must be a string.", "validation");
    }
    const csvRows = parseCsv(data);
    if (csvRows.length < 2) {
      return apiError(c, requestId, 400, "IMPORT_FORMAT_ERROR", "CSV must have at least a header row and one data row.", "validation");
    }
    // First row is headers; remaining rows are data
    const headers = csvRows[0].map((h) => h.trim());
    importedLines = [];
    for (let i = 1; i < csvRows.length; i++) {
      const values = csvRows[i];
      // Skip empty rows
      if (values.length === 0 || (values.length === 1 && values[0].trim() === "")) continue;
      const line: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        line[headers[j]] = values[j] ?? "";
      }
      importedLines.push(line);
    }
  }

  // Validate each imported line through VoiceLineSchema
  const validatedLines: Array<z.infer<typeof VoiceLineSchema>> = [];
  const importErrors: Array<{ index: number; message: string }> = [];

  for (let i = 0; i < importedLines.length; i++) {
    const line = importedLines[i];
    // Ensure required defaults
    const normalized = {
      id: (line as Record<string, unknown>).id || `imported_${i}`,
      order: typeof (line as Record<string, unknown>).order === "number" ? (line as Record<string, unknown>).order : i,
      moduleName: (line as Record<string, unknown>).moduleName ?? null,
      title: (line as Record<string, unknown>).title ?? null,
      speaker: (line as Record<string, unknown>).speaker || "narrator",
      text: (line as Record<string, unknown>).text || "",
      voice: (line as Record<string, unknown>).voice || "Zephyr",
      style: (line as Record<string, unknown>).style || "",
      notes: (line as Record<string, unknown>).notes || "",
      status: (line as Record<string, unknown>).status || "pending",
      model: (line as Record<string, unknown>).model || "google/gemini-3.1-flash-tts-preview",
      responseFormat: (line as Record<string, unknown>).responseFormat || "wav",
      directorProfileId: (line as Record<string, unknown>).directorProfileId ?? null,
      promptProfileId: (line as Record<string, unknown>).promptProfileId ?? (line as Record<string, unknown>).directorProfileId ?? null,
      speakerLabel: (line as Record<string, unknown>).speakerLabel ?? null,
      transcript: (line as Record<string, unknown>).transcript ?? (line as Record<string, unknown>).text ?? "",
      promptOverride: (line as Record<string, unknown>).promptOverride ?? null,
      directorOverrideJson: (line as Record<string, unknown>).directorOverrideJson ?? null,
      generationStatus: "draft" as const,
    };

    const result = VoiceLineSchema.safeParse(normalized);
    if (!result.success) {
      importErrors.push({
        index: i,
        message: result.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; "),
      });
      continue;
    }
    validatedLines.push(result.data);
  }

  // Check for duplicate line IDs within the import batch
  const seenIds = new Set<string>();
  const duplicateIds: string[] = [];
  for (const line of validatedLines) {
    if (seenIds.has(line.id)) {
      duplicateIds.push(line.id);
    } else {
      seenIds.add(line.id);
    }
  }
  if (duplicateIds.length > 0) {
    return apiError(c, requestId, 400, "DUPLICATE_LINE_IDS",
      `Import contains duplicate line IDs: ${[...new Set(duplicateIds)].join(", ")}. Each line must have a unique ID.`,
      "validation", false, { duplicateIds: [...new Set(duplicateIds)] });
  }

  if (importErrors.length > 0 && validatedLines.length === 0) {
    return apiError(c, requestId, 400, "IMPORT_VALIDATION_ERROR", "All imported lines failed validation.", "validation", false, { errors: importErrors });
  }

  // Director completeness check: warn but do not block for import
  const directorWarnings: string[] = [];
  for (const line of validatedLines) {
    if (!line.directorProfileId) {
      directorWarnings.push(`Line "${line.id}" has no director profile bound`);
    } else {
      const profile = db.select().from(dpTable).where(eq(dpTable.id, line.directorProfileId)).get();
      if (!profile) {
        directorWarnings.push(`Line "${line.id}" references non-existent director profile "${line.directorProfileId}"`);
      }
    }
  }

  // Create new version
  const newVersion = currentVersion + 1;
  const versionId = uuidv4();
  const now = new Date();

  // Import speakers: validate through SpeakerSchema whitelist and enforce max 2
  const rawImportSpeakers = (format === "json" && data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).speakers))
    ? ((data as Record<string, unknown>).speakers as unknown[])
    : [];

  const speakers: Array<{ id: string; label: string; name?: string; voice: string; style?: string }> = [];
  for (const sp of rawImportSpeakers.slice(0, 2)) {
    const parsed = SpeakerSchema.safeParse(sp);
    if (parsed.success) {
      speakers.push(parsed.data);
    }
    // Silently drop speakers that fail schema validation (contain unknown/sensitive fields)
  }

  db.insert(productionListVersion).values({
    id: versionId,
    taskId,
    version: newVersion,
    directorProfileId: null,
    speakersJson: JSON.stringify(speakers),
    metadataJson: JSON.stringify({ imported: true, importedAt: now.toISOString() }),
    lineCount: validatedLines.length,
    createdAt: now,
  }).run();

  for (const line of validatedLines) {
    db.insert(voiceLine).values({
      id: uuidv4(),
      lineId: line.id,
      taskId,
      versionId,
      order: line.order,
      speaker: line.speaker,
      text: line.text,
      voice: line.voice,
      style: line.style ?? "",
      notes: line.notes ?? "",
      status: line.status ?? "pending",
      directorProfileId: line.directorProfileId ?? line.promptProfileId ?? null,
      directorOverrideJson: line.directorOverrideJson ?? null,
      generationStatus: "draft",
      relatedJobId: null,
      relatedAssetId: null,
      generationErrorCode: null,
      generationErrorMessage: null,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  writeArtifact(taskId, productionListArtifactName(), {
    schemaVersion: importedPromptProfiles.length > 0 ? "tts.production-list.v2" : undefined,
    version: newVersion,
    versionId,
    lines: validatedLines.map((line) => ({
      ...line,
      transcript: line.transcript ?? line.text,
      promptProfileId: line.promptProfileId ?? line.directorProfileId ?? null,
      directorProfileId: line.directorProfileId ?? line.promptProfileId ?? null,
    })),
    speakers,
    promptProfiles: importedPromptProfiles,
    directorProfiles: importedPromptProfiles,
    directorProfileId: null,
    metadata: { imported: true, importedAt: now.toISOString(), ...(importedPromptProfiles.length > 0 ? { schemaVersion: "tts.production-list.v2" } : {}) },
    updatedAt: now.toISOString(),
  });

  writeArtifact(taskId, productionListVersionArtifactName(newVersion), {
    schemaVersion: importedPromptProfiles.length > 0 ? "tts.production-list.v2" : undefined,
    version: newVersion,
    versionId,
    lines: validatedLines.map((line) => ({
      ...line,
      transcript: line.transcript ?? line.text,
      promptProfileId: line.promptProfileId ?? line.directorProfileId ?? null,
      directorProfileId: line.directorProfileId ?? line.promptProfileId ?? null,
    })),
    speakers,
    promptProfiles: importedPromptProfiles,
    directorProfiles: importedPromptProfiles,
    directorProfileId: null,
    metadata: { imported: true, importedAt: now.toISOString(), ...(importedPromptProfiles.length > 0 ? { schemaVersion: "tts.production-list.v2" } : {}) },
    updatedAt: now.toISOString(),
  });

  auditLog("production_list", versionId, "import", "user", {
    taskId,
    version: newVersion,
    lineCount: validatedLines.length,
    importErrors: importErrors.length,
    format,
    summary,
  }, requestId);

  const pl = loadProductionList(taskId, versionId);
  return c.json({
    ok: true,
    requestId,
    productionList: pl,
    import: {
      importedLines: validatedLines.length,
      skippedLines: importErrors.length,
      errors: importErrors.length > 0 ? importErrors : undefined,
      directorWarnings: directorWarnings.length > 0 ? directorWarnings : undefined,
    },
  });
});

// ─── GET /api/tasks/:taskId/production-list/quality-report ──────────────────

app.get("/api/tasks/:taskId/production-list/quality-report", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const currentVersion = getCurrentVersion(taskId);
  if (currentVersion === 0) {
    return c.json({
      ok: true,
      requestId,
      qualityReport: {
        taskId,
        version: 0,
        totalLines: 0,
        generatedAt: new Date().toISOString(),
        metrics: {},
        issues: [{ severity: "info", code: "NO_PRODUCTION_LIST", message: "No production list exists for this task." }],
      },
    });
  }

  const latestVersion = db.select().from(productionListVersion)
    .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, currentVersion)))
    .get();

  if (!latestVersion) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "Current version record not found.", "validation");
  }

  const lines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, latestVersion.id))
    .orderBy(voiceLine.order)
    .all();

  const artifact = readArtifact<{ lines?: Array<Record<string, unknown>>; promptProfiles?: Array<Record<string, unknown>>; directorProfiles?: Array<Record<string, unknown>> }>(taskId, productionListArtifactName());
  const artifactLinesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(artifact?.lines)) {
    for (const line of artifact.lines) {
      if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
    }
  }

  const { metrics, issues } = buildQualityReportMetrics(
    lines,
    artifactLinesById,
    (profileId) => Boolean(db.select().from(dpTable).where(eq(dpTable.id, profileId)).get()),
    Array.isArray(artifact?.promptProfiles) ? artifact.promptProfiles : (artifact?.directorProfiles ?? []),
  );

  return c.json({
    ok: true,
    requestId,
    qualityReport: {
      taskId,
      version: currentVersion,
      totalLines: lines.length,
      generatedAt: new Date().toISOString(),
      metrics,
      issues,
    },
  });
});

export default app;
