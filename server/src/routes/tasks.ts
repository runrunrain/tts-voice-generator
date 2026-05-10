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
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { voiceTask, operationAuditLog } from "../db/schema-extended.js";
import { CreateTaskSchema, UpdateTaskSchema } from "../domain/validators.js";
import { deleteTaskDir } from "../services/artifact-store.js";

const app = new Hono();

type VoiceTaskRow = typeof voiceTask.$inferSelect;

interface TaskStats {
  documentCount: number;
  activeDocumentCount: number;
  productionVersionCount: number;
  latestProductionVersion: number | null;
  latestLineCount: number;
  lineCount: number;
  generatedLineCount: number;
  failedLineCount: number;
  runningJobCount?: number;
}

type NormalizedTaskStatus = "draft" | "ready" | "running" | "blocked" | "completed" | "failed";

type StatusDerivation = {
  status: NormalizedTaskStatus;
  reason: string;
};

function emptyTaskStats(): TaskStats {
  return {
    documentCount: 0,
    activeDocumentCount: 0,
    productionVersionCount: 0,
    latestProductionVersion: null,
    latestLineCount: 0,
    lineCount: 0,
    generatedLineCount: 0,
    failedLineCount: 0,
    runningJobCount: 0,
  };
}

export function normalizeTaskStatus(value: unknown): NormalizedTaskStatus | null {
  switch (value) {
    case "draft":
    case "ready":
    case "running":
    case "blocked":
    case "completed":
    case "failed":
      return value;
    case "in_progress":
      return "running";
    case "archived":
      return "completed";
    default:
      return null;
  }
}

function deriveTaskStatus(task: VoiceTaskRow, stats: TaskStats): StatusDerivation {
  const rawStatus = normalizeTaskStatus(task.status);
  const totalLines = stats.latestLineCount || stats.lineCount;

  if (rawStatus === "failed") return { status: "failed", reason: "raw_failed" };
  if (stats.failedLineCount > 0) return { status: "failed", reason: "failed_lines_present" };
  if (rawStatus === "blocked") return { status: "blocked", reason: "raw_blocked" };
  if ((stats.runningJobCount ?? 0) > 0) return { status: "running", reason: "active_generation_jobs" };
  if (totalLines > 0 && stats.generatedLineCount >= totalLines) return { status: "completed", reason: "all_lines_succeeded" };
  if (totalLines > 0 && stats.generatedLineCount > 0 && stats.generatedLineCount < totalLines) return { status: "running", reason: "partial_generation_succeeded" };
  if (totalLines > 0 || stats.productionVersionCount > 0) return { status: "ready", reason: "production_list_ready" };
  if (stats.activeDocumentCount > 0 || stats.documentCount > 0) return { status: "ready", reason: "documents_ready" };
  if (rawStatus === "running" || rawStatus === "ready" || rawStatus === "completed") return { status: rawStatus, reason: "raw_status_fallback" };

  return { status: "draft", reason: "empty_task" };
}

function chunkTaskIds(taskIds: string[], size = 500): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < taskIds.length; i += size) {
    chunks.push(taskIds.slice(i, i + size));
  }
  return chunks;
}

function getRawDb(db: ReturnType<typeof getDb>): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client;
}

function getTaskStatsMap(db: ReturnType<typeof getDb>, taskIds: string[]): Map<string, TaskStats> {
  const statsByTaskId = new Map<string, TaskStats>();
  const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
  for (const taskId of uniqueTaskIds) {
    statsByTaskId.set(taskId, emptyTaskStats());
  }
  if (uniqueTaskIds.length === 0) return statsByTaskId;

  const rawDb = getRawDb(db);

  for (const chunk of chunkTaskIds(uniqueTaskIds)) {
    const placeholders = chunk.map(() => "?").join(", ");

    const documentRows = rawDb.prepare(`
      SELECT
        task_id AS taskId,
        COUNT(*) AS documentCount,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS activeDocumentCount
      FROM requirement_document
      WHERE task_id IN (${placeholders})
      GROUP BY task_id
    `).all(...chunk) as Array<{ taskId: string; documentCount: number; activeDocumentCount: number | null }>;

    for (const row of documentRows) {
      const stats = statsByTaskId.get(row.taskId) ?? emptyTaskStats();
      stats.documentCount = Number(row.documentCount) || 0;
      stats.activeDocumentCount = Number(row.activeDocumentCount) || 0;
      statsByTaskId.set(row.taskId, stats);
    }

    const versionRows = rawDb.prepare(`
      SELECT
        task_id AS taskId,
        COUNT(*) AS productionVersionCount,
        MAX(version) AS latestProductionVersion
      FROM production_list_version
      WHERE task_id IN (${placeholders})
      GROUP BY task_id
    `).all(...chunk) as Array<{ taskId: string; productionVersionCount: number; latestProductionVersion: number | null }>;

    for (const row of versionRows) {
      const stats = statsByTaskId.get(row.taskId) ?? emptyTaskStats();
      stats.productionVersionCount = Number(row.productionVersionCount) || 0;
      stats.latestProductionVersion = row.latestProductionVersion === null ? null : Number(row.latestProductionVersion);
      statsByTaskId.set(row.taskId, stats);
    }

    const latestLineRows = rawDb.prepare(`
      WITH latest AS (
        SELECT plv.*
        FROM production_list_version plv
        INNER JOIN (
          SELECT task_id, MAX(version) AS latest_version
          FROM production_list_version
          WHERE task_id IN (${placeholders})
          GROUP BY task_id
        ) mx ON mx.task_id = plv.task_id AND mx.latest_version = plv.version
      )
      SELECT
        latest.task_id AS taskId,
        latest.version AS latestProductionVersion,
        COALESCE(NULLIF(COUNT(vl.id), 0), latest.line_count, 0) AS latestLineCount,
        SUM(CASE WHEN vl.generation_status = 'succeeded' THEN 1 ELSE 0 END) AS generatedLineCount,
        SUM(CASE WHEN vl.generation_status = 'failed' THEN 1 ELSE 0 END) AS failedLineCount
      FROM latest
      LEFT JOIN voice_line vl ON vl.version_id = latest.id
      GROUP BY latest.task_id, latest.version, latest.line_count
    `).all(...chunk) as Array<{
      taskId: string;
      latestProductionVersion: number;
      latestLineCount: number;
      generatedLineCount: number | null;
      failedLineCount: number | null;
    }>;

    for (const row of latestLineRows) {
      const stats = statsByTaskId.get(row.taskId) ?? emptyTaskStats();
      stats.latestProductionVersion = Number(row.latestProductionVersion);
      stats.latestLineCount = Number(row.latestLineCount) || 0;
      stats.lineCount = stats.latestLineCount;
      stats.generatedLineCount = Number(row.generatedLineCount) || 0;
      stats.failedLineCount = Number(row.failedLineCount) || 0;
      statsByTaskId.set(row.taskId, stats);
    }
  }

  return statsByTaskId;
}

function serializeTask(task: VoiceTaskRow, stats: TaskStats = emptyTaskStats()) {
  const derived = deriveTaskStatus(task, stats);
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: derived.status,
    rawStatus: task.status,
    statusReason: derived.reason,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    documentCount: stats.documentCount,
    activeDocumentCount: stats.activeDocumentCount,
    productionVersionCount: stats.productionVersionCount,
    latestProductionVersion: stats.latestProductionVersion,
    latestLineCount: stats.latestLineCount,
    lineCount: stats.lineCount,
    generatedLineCount: stats.generatedLineCount,
    failedLineCount: stats.failedLineCount,
    runningJobCount: stats.runningJobCount ?? 0,
  };
}

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
  const statusQuery = c.req.query("status");
  const normalizedStatus = statusQuery && statusQuery !== "all" ? normalizeTaskStatus(statusQuery) : null;
  if (statusQuery && statusQuery !== "all" && !normalizedStatus) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", `Unknown task status filter "${statusQuery}".`, "validation", false, { status: statusQuery });
  }

  const db = getDb();
  const tasks = db.select().from(voiceTask).orderBy(desc(voiceTask.createdAt)).all();
  const statsByTaskId = getTaskStatsMap(db, tasks.map((t) => t.id));
  const serializedTasks = tasks.map((t) => serializeTask(t, statsByTaskId.get(t.id) ?? emptyTaskStats()));
  const filteredTasks = normalizedStatus ? serializedTasks.filter((task) => task.status === normalizedStatus) : serializedTasks;

  return c.json({
    ok: true,
    requestId,
    tasks: filteredTasks,
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
    task: serializeTask({ id, title, description: description ?? "", status: "draft", createdAt: now, updatedAt: now } as VoiceTaskRow),
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

  const statsByTaskId = getTaskStatsMap(db, [taskId]);

  return c.json({
    ok: true,
    requestId,
    task: serializeTask(task, statsByTaskId.get(task.id) ?? emptyTaskStats()),
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
    task: serializeTask(updated, getTaskStatsMap(db, [taskId]).get(taskId) ?? emptyTaskStats()),
  });
});

export default app;
