/**
 * Task CRUD routes.
 *
 * GET    /api/tasks          - List all tasks
 * POST   /api/tasks          - Create task
 * GET    /api/tasks/:taskId  - Get single task
 * PATCH  /api/tasks/:taskId  - Update task
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { voiceTask, operationAuditLog } from "../db/schema-extended.js";
import { CreateTaskSchema, UpdateTaskSchema } from "../domain/validators.js";
import { deleteTaskDir } from "../services/artifact-store.js";

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
  } catch {
    // Audit log failure should not break the operation
  }
}

// ─── GET /api/tasks ────────────────────────────────────────────────────────────

app.get("/api/tasks", (c) => {
  const requestId = uuidv4();
  const db = getDb();
  const tasks = db.select().from(voiceTask).orderBy(desc(voiceTask.createdAt)).all();

  return c.json({
    ok: true,
    requestId,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  });
});

// ─── POST /api/tasks ───────────────────────────────────────────────────────────

app.post("/api/tasks", async (c) => {
  const requestId = uuidv4();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { title, description } = parsed.data;
  const id = uuidv4();
  const now = new Date();
  const db = getDb();

  db.insert(voiceTask).values({
    id,
    title,
    description,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  }).run();

  auditLog("task", id, "create", "user", { title, description }, requestId);

  return c.json({
    ok: true,
    requestId,
    task: {
      id,
      title,
      description,
      status: "draft",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  }, 201);
});

// ─── GET /api/tasks/:taskId ────────────────────────────────────────────────────

app.get("/api/tasks/:taskId", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  return c.json({
    ok: true,
    requestId,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
  });
});

// ─── PATCH /api/tasks/:taskId ──────────────────────────────────────────────────

app.patch("/api/tasks/:taskId", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const existing = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!existing) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = UpdateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const updates = parsed.data;
  const now = new Date();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.title !== undefined) setValues.title = updates.title;
  if (updates.description !== undefined) setValues.description = updates.description;
  if (updates.status !== undefined) setValues.status = updates.status;

  db.update(voiceTask).set(setValues).where(eq(voiceTask.id, taskId)).run();

  auditLog("task", taskId, "update", "user", { before: { title: existing.title, status: existing.status }, after: updates }, requestId);

  const updated = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get()!;

  return c.json({
    ok: true,
    requestId,
    task: {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      status: updated.status,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

export default app;
