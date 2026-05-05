/**
 * Production List routes with versioning.
 *
 * GET    /api/tasks/:taskId/production-list              - Get current production list
 * PUT    /api/tasks/:taskId/production-list              - Replace production list (with expectedVersion)
 * PATCH  /api/tasks/:taskId/production-list              - Domain-level patches
 * POST   /api/tasks/:taskId/production-list/validate     - Validate production list
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  voiceTask,
  productionListVersion,
  voiceLine,
  operationAuditLog,
} from "../db/schema-extended.js";
import {
  ProductionListPutSchema,
  ProductionListPatchSchema,
  VoiceLineSchema,
  SpeakerSchema,
  validateProductionList,
} from "../domain/validators.js";
import {
  writeArtifact,
  readArtifact,
  productionListArtifactName,
} from "../services/artifact-store.js";

const app = new Hono();

function apiError(c: any, requestId: string, status: number, code: string, message: string, category: string, retryable = false, metadata?: unknown) {
  return c.json({ ok: false, requestId, error: { code, message, category, retryable, metadata } }, status);
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

/**
 * Get current production list version number for a task.
 */
function getCurrentVersion(taskId: string): number {
  const db = getDb();
  const latest = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .limit(1)
    .get();
  return latest?.version ?? 0;
}

/**
 * Load production list from artifact + DB.
 */
function loadProductionList(taskId: string, versionId: string) {
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
    lines: Array<Record<string, unknown>>;
    speakers: unknown[];
  }>(taskId, productionListArtifactName());

  const artifactLinesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(artifact?.lines)) {
    for (const line of artifact.lines) {
      if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
    }
  }

  return {
    taskId: version.taskId,
    version: version.version,
    versionId: version.id,
    lines: lines.map((l) => {
      const artifactLine = artifactLinesById.get(l.id) ?? {};
      return {
        id: l.id,
        order: l.order,
        speaker: l.speaker,
        text: l.text,
        voice: l.voice,
        style: l.style,
        notes: l.notes,
        status: l.status,
        model: typeof artifactLine.model === "string" ? artifactLine.model : "google/gemini-3.1-flash-tts-preview",
        responseFormat: artifactLine.responseFormat === "pcm" || artifactLine.responseFormat === "mp3" || artifactLine.responseFormat === "wav" ? artifactLine.responseFormat : "wav",
        directorProfileId: typeof artifactLine.directorProfileId === "string" ? artifactLine.directorProfileId : null,
      };
    }),
    speakers: artifact?.speakers ? JSON.parse(JSON.stringify(artifact.speakers)) : [],
    directorProfileId: version.directorProfileId,
    metadata: version.metadataJson ? JSON.parse(version.metadataJson) : {},
    createdAt: version.createdAt.toISOString(),
  };
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

  const { expectedVersion, lines, speakers, directorProfileId, metadata } = parsed.data;

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

  // Insert voice lines
  for (const line of lines) {
    // voice_line.id is the semantic line id in the current schema. A new
    // production-list version may legitimately carry the same semantic line id,
    // so replace the index row before inserting the latest version row.
    db.delete(voiceLine).where(eq(voiceLine.id, line.id)).run();
    db.insert(voiceLine).values({
      id: line.id || uuidv4(),
      taskId,
      versionId,
      order: line.order,
      speaker: line.speaker,
      text: line.text,
      voice: line.voice,
      style: line.style ?? "",
      notes: line.notes ?? "",
      status: line.status ?? "pending",
      createdAt: now,
    }).run();
  }

  // Store full production list in artifact
  writeArtifact(taskId, productionListArtifactName(), {
    version: newVersion,
    versionId,
    lines,
    speakers,
    directorProfileId,
    metadata,
    updatedAt: now.toISOString(),
  });

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
  const artifactLinesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(currentArtifact?.lines)) {
    for (const line of currentArtifact.lines) {
      if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
    }
  }
  const mergedCurrentLines = currentLines.map((line) => ({
    ...artifactLinesById.get(line.id),
    id: line.id,
    order: line.order,
    speaker: line.speaker,
    text: line.text,
    voice: line.voice,
    style: line.style,
    notes: line.notes,
    status: line.status,
  }));

  // Apply domain-level patch
  let newLines: any[];
  try {
    newLines = applyPatch(op, payload, mergedCurrentLines);
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

  // Get current speakers from artifact
  const speakers = currentArtifact?.speakers ?? [];

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
    db.delete(voiceLine).where(eq(voiceLine.id, (line as any).id)).run();
    db.insert(voiceLine).values({
      id: (line as any).id || uuidv4(),
      taskId,
      versionId,
      order: (line as any).order,
      speaker: (line as any).speaker,
      text: (line as any).text,
      voice: (line as any).voice,
      style: (line as any).style ?? "",
      notes: (line as any).notes ?? "",
      status: (line as any).status ?? "pending",
      createdAt: now,
    }).run();
  }

  writeArtifact(taskId, productionListArtifactName(), {
    version: newVersion,
    versionId,
    lines: validatedLines,
    speakers,
    directorProfileId: latestVersion.directorProfileId,
    metadata: latestVersion.metadataJson ? JSON.parse(latestVersion.metadataJson) : {},
    updatedAt: now.toISOString(),
  });

  auditLog("production_list", versionId, `patch:${op}`, "user", { taskId, version: newVersion, op }, requestId);

  const pl = loadProductionList(taskId, versionId);
  return c.json({ ok: true, requestId, productionList: pl });
});

function applyPatch(op: string, payload: Record<string, unknown>, currentLines: any[]): any[] {
  const lines = [...currentLines];

  switch (op) {
    case "updateLine": {
      const { lineId, updates } = payload as { lineId: string; updates: Record<string, unknown> };
      const idx = lines.findIndex((l) => l.id === lineId);
      if (idx === -1) throw new Error(`Line "${lineId}" not found`);
      const allowed = ["text", "voice", "style", "notes", "speaker", "model", "responseFormat", "directorProfileId"];
      for (const key of Object.keys(updates)) {
        if (allowed.includes(key)) {
          (lines[idx] as any)[key] = updates[key];
        }
      }
      return lines;
    }
    case "addLine": {
      const { afterLineId, line } = payload as { afterLineId?: string; line: Record<string, unknown> };
      const newLine = {
        id: (line.id as string) || uuidv4(),
        order: 0,
        speaker: line.speaker as string || "narrator",
        text: line.text as string || "",
        voice: line.voice as string || "Zephyr",
        style: (line.style as string) || "",
        notes: (line.notes as string) || "",
        status: "pending",
        model: (line.model as string) || "google/gemini-3.1-flash-tts-preview",
        responseFormat: (line.responseFormat as string) || "wav",
        directorProfileId: typeof line.directorProfileId === "string" ? line.directorProfileId : null,
      };

      if (afterLineId) {
        const idx = lines.findIndex((l) => l.id === afterLineId);
        if (idx === -1) throw new Error(`After-line "${afterLineId}" not found`);
        lines.splice(idx + 1, 0, newLine);
      } else {
        lines.push(newLine);
      }

      // Re-order
      lines.forEach((l, i) => { l.order = i; });
      return lines;
    }
    case "removeLine": {
      const { lineId } = payload as { lineId: string };
      const filtered = lines.filter((l) => l.id !== lineId);
      filtered.forEach((l, i) => { l.order = i; });
      return filtered;
    }
    case "reorderLines": {
      const { lineIds } = payload as { lineIds: string[] };
      const reordered = lineIds.map((id: string, i: number) => {
        const line = lines.find((l) => l.id === id);
        if (!line) throw new Error(`Line "${id}" not found for reorder`);
        return { ...line, order: i };
      });
      return reordered;
    }
    case "updateSpeakers": {
      // Speakers are stored in artifact, not in lines; just return lines unchanged
      return lines;
    }
    case "updateDirectorProfile": {
      // Director profile reference is on the version; lines unchanged
      return lines;
    }
    default:
      throw new Error(`Unknown patch operation: ${op}`);
  }
}

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
      id: l.id,
      order: l.order,
      speaker: l.speaker,
      text: l.text,
      voice: l.voice,
      style: l.style,
      notes: l.notes,
      status: l.status as "pending" | "approved" | "generating" | "generated" | "failed",
      model: "google/gemini-3.1-flash-tts-preview",
      responseFormat: "wav" as const,
    })),
    speakers,
  });

  return c.json({ ok: true, requestId, validation: report });
});

export default app;
