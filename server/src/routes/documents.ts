/**
 * Document management routes.
 *
 * POST   /api/tasks/:taskId/documents/upload  - Upload document (JSON body)
 * POST   /api/tasks/:taskId/documents/paste   - Paste document content
 * GET    /api/tasks/:taskId/documents          - List documents
 * GET    /api/tasks/:taskId/documents/:documentId  - Get document
 * PATCH  /api/tasks/:taskId/documents/:documentId  - Update document
 * DELETE /api/tasks/:taskId/documents/:documentId  - Delete document
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { voiceTask, requirementDocument, operationAuditLog } from "../db/schema-extended.js";
import {
  PasteDocumentSchema,
  UploadDocumentBodySchema,
  UpdateDocumentSchema,
  MAX_DOCUMENT_BYTES,
} from "../domain/validators.js";
import {
  writeArtifact,
  readArtifact,
  deleteArtifact,
  documentArtifactName,
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

async function verifyTask(taskId: string, requestId: string, c: any) {
  const db = getDb();
  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return { error: apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation") };
  }
  return { task };
}

function docToResponse(doc: any) {
  return {
    id: doc.id,
    taskId: doc.taskId,
    fileName: doc.fileName,
    source: doc.source,
    enabled: doc.enabled,
    contentSha256: doc.contentSha256,
    contentSizeBytes: doc.contentSizeBytes,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── POST /api/tasks/:taskId/documents/upload ──────────────────────────────────

app.post("/api/tasks/:taskId/documents/upload", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const taskCheck = await verifyTask(taskId, requestId, c);
  if ("error" in taskCheck) return taskCheck.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = UploadDocumentBodySchema.safeParse(body);
  if (!parsed.success) {
    // Check if the failure was specifically due to content size for a 413 response
    const sizeIssue = parsed.error.issues.find(
      (i) => i.message.includes("exceeds maximum size"),
    );
    if (sizeIssue) {
      return apiError(c, requestId, 413, "DOCUMENT_TOO_LARGE",
        `Document content exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes.`,
        "validation");
    }
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { fileName, content } = parsed.data;
  const id = uuidv4();
  const now = new Date();
  const contentBuffer = Buffer.from(content, "utf-8");
  const sha256 = crypto.createHash("sha256").update(contentBuffer).digest("hex");
  const db = getDb();

  db.insert(requirementDocument).values({
    id,
    taskId,
    fileName,
    source: "upload",
    enabled: true,
    contentSha256: sha256,
    contentSizeBytes: contentBuffer.length,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }).run();

  // Store content in artifact
  writeArtifact(taskId, documentArtifactName(id), { fileName, content, uploadedAt: now.toISOString() });

  auditLog("document", id, "upload", "user", { taskId, fileName, sizeBytes: contentBuffer.length }, requestId);

  const doc = db.select().from(requirementDocument).where(eq(requirementDocument.id, id)).get()!;
  return c.json({ ok: true, requestId, document: docToResponse(doc) }, 201);
});

// ─── POST /api/tasks/:taskId/documents/paste ───────────────────────────────────

app.post("/api/tasks/:taskId/documents/paste", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const taskCheck = await verifyTask(taskId, requestId, c);
  if ("error" in taskCheck) return taskCheck.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = PasteDocumentSchema.safeParse(body);
  if (!parsed.success) {
    // Check if the failure was specifically due to content size for a 413 response
    const sizeIssue = parsed.error.issues.find(
      (i) => i.message.includes("exceeds maximum size"),
    );
    if (sizeIssue) {
      return apiError(c, requestId, 413, "DOCUMENT_TOO_LARGE",
        `Document content exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes.`,
        "validation");
    }
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { fileName, content } = parsed.data;
  const id = uuidv4();
  const now = new Date();
  const contentBuffer = Buffer.from(content, "utf-8");
  const sha256 = crypto.createHash("sha256").update(contentBuffer).digest("hex");
  const db = getDb();

  db.insert(requirementDocument).values({
    id,
    taskId,
    fileName,
    source: "paste",
    enabled: true,
    contentSha256: sha256,
    contentSizeBytes: contentBuffer.length,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }).run();

  writeArtifact(taskId, documentArtifactName(id), { fileName, content, pastedAt: now.toISOString() });

  auditLog("document", id, "paste", "user", { taskId, fileName, sizeBytes: contentBuffer.length }, requestId);

  const doc = db.select().from(requirementDocument).where(eq(requirementDocument.id, id)).get()!;
  return c.json({ ok: true, requestId, document: docToResponse(doc) }, 201);
});

// ─── GET /api/tasks/:taskId/documents ──────────────────────────────────────────

app.get("/api/tasks/:taskId/documents", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const docs = db.select().from(requirementDocument).where(eq(requirementDocument.taskId, taskId)).all();
  return c.json({
    ok: true,
    requestId,
    documents: docs.map(docToResponse),
  });
});

// ─── GET /api/tasks/:taskId/documents/:documentId ──────────────────────────────

app.get("/api/tasks/:taskId/documents/:documentId", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const documentId = c.req.param("documentId");
  const db = getDb();

  const doc = db.select().from(requirementDocument).where(
    and(eq(requirementDocument.id, documentId), eq(requirementDocument.taskId, taskId))
  ).get();

  if (!doc) {
    return apiError(c, requestId, 404, "DOCUMENT_NOT_FOUND", `Document "${documentId}" not found in task "${taskId}".`, "validation");
  }

  // Load content from artifact
  const artifact = readArtifact<{ fileName: string; content: string }>(taskId, documentArtifactName(documentId));

  return c.json({
    ok: true,
    requestId,
    document: {
      ...docToResponse(doc),
      content: artifact?.content ?? null,
    },
  });
});

// ─── PATCH /api/tasks/:taskId/documents/:documentId ────────────────────────────

app.patch("/api/tasks/:taskId/documents/:documentId", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const documentId = c.req.param("documentId");
  const db = getDb();

  const existing = db.select().from(requirementDocument).where(
    and(eq(requirementDocument.id, documentId), eq(requirementDocument.taskId, taskId))
  ).get();

  if (!existing) {
    return apiError(c, requestId, 404, "DOCUMENT_NOT_FOUND", `Document "${documentId}" not found in task "${taskId}".`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = UpdateDocumentSchema.safeParse(body);
  if (!parsed.success) {
    // Check if the failure was specifically due to content size for a 413 response
    const sizeIssue = parsed.error.issues.find(
      (i) => i.message.includes("exceeds maximum size"),
    );
    if (sizeIssue) {
      return apiError(c, requestId, 413, "DOCUMENT_TOO_LARGE",
        `Document content exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes.`,
        "validation");
    }
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const updates = parsed.data;
  const { expectedVersion } = updates;
  const now = new Date();
  const setValues: Record<string, unknown> = { updatedAt: now };

  // Version conflict check
  if (existing.version !== expectedVersion) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${existing.version}.`, "conflict", true, {
      expectedVersion,
      currentVersion: existing.version,
    });
  }

  setValues.version = existing.version + 1;

  if (updates.fileName !== undefined) setValues.fileName = updates.fileName;
  if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

  let sha256 = existing.contentSha256;
  let sizeBytes = existing.contentSizeBytes;

  if (updates.content !== undefined) {
    const contentBuffer = Buffer.from(updates.content, "utf-8");
    sha256 = crypto.createHash("sha256").update(contentBuffer).digest("hex");
    sizeBytes = contentBuffer.length;
    setValues.contentSha256 = sha256;
    setValues.contentSizeBytes = sizeBytes;

    writeArtifact(taskId, documentArtifactName(documentId), {
      fileName: updates.fileName ?? existing.fileName,
      content: updates.content,
      updatedAt: now.toISOString(),
    });
  }

  db.update(requirementDocument).set(setValues).where(eq(requirementDocument.id, documentId)).run();

  auditLog("document", documentId, "update", "user", { taskId, updatedFields: Object.keys(updates) }, requestId);

  const updated = db.select().from(requirementDocument).where(eq(requirementDocument.id, documentId)).get()!;
  return c.json({ ok: true, requestId, document: docToResponse(updated) });
});

// ─── DELETE /api/tasks/:taskId/documents/:documentId ───────────────────────────

app.delete("/api/tasks/:taskId/documents/:documentId", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const documentId = c.req.param("documentId");
  const db = getDb();

  const existing = db.select().from(requirementDocument).where(
    and(eq(requirementDocument.id, documentId), eq(requirementDocument.taskId, taskId))
  ).get();

  if (!existing) {
    return apiError(c, requestId, 404, "DOCUMENT_NOT_FOUND", `Document "${documentId}" not found in task "${taskId}".`, "validation");
  }

  db.delete(requirementDocument).where(eq(requirementDocument.id, documentId)).run();
  deleteArtifact(taskId, documentArtifactName(documentId));

  auditLog("document", documentId, "delete", "user", { taskId, fileName: existing.fileName }, requestId);

  return c.json({ ok: true, requestId, deleted: documentId });
});

export default app;
