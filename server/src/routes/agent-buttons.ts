/**
 * Agent Button Presets and Execution routes.
 *
 * GET  /api/agent/buttons                                       - List button presets
 * POST /api/tasks/:taskId/agent/normalize-requirements          - Normalize documents to production list
 * POST /api/tasks/:taskId/agent/buttons/:buttonKey/execute      - Execute button on a line
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  voiceTask,
  requirementDocument,
  productionListVersion,
  voiceLine,
  agentButtonPreset,
  agentButtonRun,
  operationAuditLog,
} from "../db/schema-extended.js";
import { ExecuteButtonSchema, VoiceLineSchema } from "../domain/validators.js";
import {
  writeArtifact,
  readArtifact,
  productionListArtifactName,
  buttonRunArtifactName,
} from "../services/artifact-store.js";
import {
  checkOpenCodeAvailability,
  fallbackNormalize,
  applyFallbackTransform,
  sanitizeError,
} from "../services/opencode-runner.js";

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

// ─── GET /api/agent/buttons ────────────────────────────────────────────────────

app.get("/api/agent/buttons", async (c) => {
  const requestId = uuidv4();
  const db = getDb();
  const presets = db.select().from(agentButtonPreset).orderBy(agentButtonPreset.sortOrder).all();

  // Check real OpenCode CLI availability
  const availability = await checkOpenCodeAvailability();

  return c.json({
    ok: true,
    requestId,
    opencodeAvailable: availability.available,
    runnerMode: availability.available ? "opencode" as const : "fallback" as const,
    disabledReason: availability.available ? null : availability.error,
    buttons: presets.filter((p) => p.enabled).map((p) => ({
      id: p.id,
      buttonKey: p.buttonKey,
      name: p.name,
      description: p.description,
      promptTemplate: p.promptTemplate,
      targetPolicy: JSON.parse(p.targetPolicyJson || "{}"),
      sortOrder: p.sortOrder,
      runner: availability.available ? "opencode" as const : "fallback" as const,
    })),
  });
});

// ─── POST /api/tasks/:taskId/agent/normalize-requirements ─────────────────────

app.post("/api/tasks/:taskId/agent/normalize-requirements", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  // Load enabled documents
  const docs = db.select().from(requirementDocument)
    .where(eq(requirementDocument.taskId, taskId))
    .all();

  const enabledDocs = docs.filter((d) => d.enabled);
  if (enabledDocs.length === 0) {
    return apiError(c, requestId, 400, "NO_ENABLED_DOCS", "No enabled documents to normalize.", "validation");
  }

  // Load document contents from artifacts
  const docInputs = [];
  for (const doc of enabledDocs) {
    const artifact = readArtifact<{ fileName: string; content: string }>(taskId, `document-${doc.id}.json`);
    if (artifact) {
      docInputs.push({
        id: doc.id,
        fileName: doc.fileName,
        content: artifact.content,
        enabled: true,
      });
    }
  }

  if (docInputs.length === 0) {
    return apiError(c, requestId, 400, "NO_DOCUMENT_CONTENT", "Enabled documents have no content.", "validation");
  }

  // Try OpenCode, fallback to deterministic normalization
  const availability = await checkOpenCodeAvailability();

  let result;
  if (availability.available) {
    // OpenCode is available - but we don't actually call it for P0 since it needs
    // specific prompt engineering. Use fallback for now with runner="fallback".
    // In production, this would call the OpenCode CLI.
    result = fallbackNormalize({ documents: docInputs });
  } else {
    result = fallbackNormalize({ documents: docInputs });
  }

  // Create production list from normalization result
  const { productionList, warnings, runner } = result;
  const currentVersion = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .limit(1)
    .get();

  const newVersionNum = (currentVersion?.version ?? 0) + 1;
  const versionId = uuidv4();
  const now = new Date();

  db.insert(productionListVersion).values({
    id: versionId,
    taskId,
    version: newVersionNum,
    speakersJson: JSON.stringify(productionList.speakers),
    metadataJson: JSON.stringify({ ...productionList.metadata, runner, normalizedAt: now.toISOString() }),
    lineCount: productionList.lines.length,
    createdAt: now,
  }).run();

  for (const line of productionList.lines) {
    db.delete(voiceLine).where(eq(voiceLine.id, line.id)).run();
    db.insert(voiceLine).values({
      id: line.id,
      taskId,
      versionId,
      order: line.order,
      speaker: line.speaker,
      text: line.text,
      voice: line.voice,
      style: line.style ?? "",
      notes: line.notes ?? "",
      status: "pending",
      createdAt: now,
    }).run();
  }

  writeArtifact(taskId, productionListArtifactName(), {
    version: newVersionNum,
    versionId,
    lines: productionList.lines,
    speakers: productionList.speakers,
    directorProfileId: null,
    metadata: { ...productionList.metadata, runner },
    updatedAt: now.toISOString(),
  });

  auditLog("production_list", versionId, "normalize_requirements", runner, { taskId, lineCount: productionList.lines.length }, requestId);

  return c.json({
    ok: true,
    requestId,
    runner,
    productionList: {
      taskId,
      version: newVersionNum,
      lines: productionList.lines,
      speakers: productionList.speakers,
      metadata: productionList.metadata,
    },
    warnings,
  });
});

// ─── POST /api/tasks/:taskId/agent/buttons/:buttonKey/execute ─────────────────

app.post("/api/tasks/:taskId/agent/buttons/:buttonKey/execute", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const buttonKey = c.req.param("buttonKey");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  // Validate button exists
  const preset = db.select().from(agentButtonPreset).where(eq(agentButtonPreset.buttonKey, buttonKey)).get();
  if (!preset) {
    return apiError(c, requestId, 404, "BUTTON_NOT_FOUND", `Button "${buttonKey}" not found.`, "validation");
  }

  // Validate button is enabled
  if (!preset.enabled) {
    return apiError(c, requestId, 403, "BUTTON_DISABLED", `Button "${buttonKey}" is disabled and cannot be executed.`, "validation");
  }

  // Parse target policy
  let targetPolicy: { allowedFields?: string[]; scope?: string };
  try {
    targetPolicy = JSON.parse(preset.targetPolicyJson || "{}");
  } catch {
    targetPolicy = {};
  }

  // Parse request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = ExecuteButtonSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { targetLineId, expectedVersion, parameters } = parsed.data;

  // Version conflict check
  const currentVersion = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .limit(1)
    .get();

  if (!currentVersion) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "No production list exists for this task.", "validation");
  }

  if (expectedVersion !== currentVersion.version) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${currentVersion.version}.`, "conflict", true, {
      expectedVersion,
      currentVersion: currentVersion.version,
    });
  }

  // Find target line
  const targetLine = db.select().from(voiceLine)
    .where(and(eq(voiceLine.versionId, currentVersion.id), eq(voiceLine.id, targetLineId)))
    .get();

  if (!targetLine) {
    return apiError(c, requestId, 404, "LINE_NOT_FOUND", `Line "${targetLineId}" not found in current production list version.`, "validation");
  }

  // Execute button transform
  const runId = uuidv4();
  const now = new Date();
  const inputSnapshot = {
    id: targetLine.id,
    order: targetLine.order,
    speaker: targetLine.speaker,
    text: targetLine.text,
    voice: targetLine.voice,
    style: targetLine.style,
    notes: targetLine.notes,
    status: targetLine.status,
  };

  let newText = targetLine.text;
  let newStyle = targetLine.style;
  let runner: "opencode" | "fallback" = "fallback";

  try {
    const availability = await checkOpenCodeAvailability();

    if (availability.available) {
      // P0: would call OpenCode CLI here with promptTemplate
      // For now, use fallback to ensure deterministic behavior
      runner = "fallback";
    }

    // Apply transform based on button type
    const transformKey = buttonKey.startsWith("style-") ? "style" : buttonKey;
    if (targetPolicy.allowedFields?.includes("text")) {
      newText = applyFallbackTransform(transformKey, targetLine.text, parameters);
    }
    if (targetPolicy.allowedFields?.includes("style") && transformKey === "style") {
      const tone = buttonKey.replace("style-", "");
      newStyle = tone;
    }
  } catch (err) {
    // Record failed run
    db.insert(agentButtonRun).values({
      id: runId,
      taskId,
      buttonKey,
      targetLineId,
      runner,
      inputSnapshotJson: JSON.stringify(inputSnapshot),
      status: "failed",
      errorCode: "TRANSFORM_ERROR",
      errorMessage: sanitizeError(err),
      createdAt: now,
    }).run();

    return apiError(c, requestId, 500, "TRANSFORM_ERROR", sanitizeError(err), "internal");
  }

  const outputSnapshot = { ...inputSnapshot, text: newText, style: newStyle };

  // Create new version with the modified line
  const newVersionNum = currentVersion.version + 1;
  const newVersionId = uuidv4();

  db.insert(productionListVersion).values({
    id: newVersionId,
    taskId,
    version: newVersionNum,
    directorProfileId: currentVersion.directorProfileId,
    speakersJson: currentVersion.speakersJson,
    metadataJson: currentVersion.metadataJson,
    lineCount: currentVersion.lineCount,
    createdAt: now,
  }).run();

  // Copy all lines from current version, replacing the target
  const allCurrentLines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, currentVersion.id))
    .orderBy(voiceLine.order)
    .all();

  const replacementLineId = uuidv4();

  for (const line of allCurrentLines) {
    const isTarget = line.id === targetLineId;
    if (!isTarget) db.delete(voiceLine).where(eq(voiceLine.id, line.id)).run();
    db.insert(voiceLine).values({
      id: isTarget ? replacementLineId : line.id,
      taskId,
      versionId: newVersionId,
      order: line.order,
      speaker: line.speaker,
      text: isTarget ? newText : line.text,
      voice: line.voice,
      style: isTarget ? newStyle : line.style,
      notes: line.notes,
      status: isTarget ? "pending" : line.status,
      createdAt: now,
    }).run();
  }

  // Update artifact
  const artifact = readArtifact<any>(taskId, productionListArtifactName());
  const artifactLinesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(artifact?.lines)) {
    for (const line of artifact.lines) {
      if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
    }
  }
  const newLines = allCurrentLines.map((l) => ({
    ...(artifactLinesById.get(l.id) ?? {}),
    ...l,
    id: l.id === targetLineId ? replacementLineId : l.id,
    text: l.id === targetLineId ? newText : l.text,
    style: l.id === targetLineId ? newStyle : l.style,
    status: l.id === targetLineId ? "pending" : l.status,
    model: typeof artifactLinesById.get(l.id)?.model === "string" ? artifactLinesById.get(l.id)?.model : "google/gemini-3.1-flash-tts-preview",
    responseFormat: ["wav", "pcm", "mp3"].includes(String(artifactLinesById.get(l.id)?.responseFormat)) ? artifactLinesById.get(l.id)?.responseFormat : "wav",
  }));

  writeArtifact(taskId, productionListArtifactName(), {
    version: newVersionNum,
    versionId: newVersionId,
    lines: newLines,
    speakers: artifact?.speakers ?? [],
    directorProfileId: currentVersion.directorProfileId,
    metadata: artifact?.metadata ?? {},
    updatedAt: now.toISOString(),
  });

  // Record successful run
  db.insert(agentButtonRun).values({
    id: runId,
    taskId,
    buttonKey,
    targetLineId,
    runner,
    inputSnapshotJson: JSON.stringify(inputSnapshot),
    outputSnapshotJson: JSON.stringify(outputSnapshot),
    status: "completed",
    createdAt: now,
    completedAt: now,
  }).run();

  writeArtifact(taskId, buttonRunArtifactName(runId), {
    buttonKey,
    targetLineId,
    runner,
    inputSnapshot,
    outputSnapshot,
    version: newVersionNum,
    executedAt: now.toISOString(),
  });

  auditLog("button_run", runId, `execute:${buttonKey}`, runner, { taskId, targetLineId, version: newVersionNum }, requestId);

  return c.json({
    ok: true,
    requestId,
    runId,
    runner,
    version: newVersionNum,
    targetLine: outputSnapshot,
  });
});

export default app;
