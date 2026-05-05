/**
 * Director Profile CRUD routes.
 *
 * GET    /api/director-profiles              - List profiles
 * POST   /api/director-profiles              - Create profile
 * GET    /api/director-profiles/:profileId   - Get profile
 * PATCH  /api/director-profiles/:profileId   - Update profile
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { directorProfile, operationAuditLog } from "../db/schema-extended.js";
import {
  CreateDirectorProfileSchema,
  UpdateDirectorProfileSchema,
  DirectorConfigSchema,
} from "../domain/validators.js";

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

function profileToResponse(p: any) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    config: JSON.parse(p.config || "{}"),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ─── GET /api/director-profiles ────────────────────────────────────────────────

app.get("/api/director-profiles", (c) => {
  const requestId = uuidv4();
  const db = getDb();
  const profiles = db.select().from(directorProfile).all();

  return c.json({
    ok: true,
    requestId,
    profiles: profiles.map(profileToResponse),
  });
});

// ─── POST /api/director-profiles ───────────────────────────────────────────────

app.post("/api/director-profiles", async (c) => {
  const requestId = uuidv4();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = CreateDirectorProfileSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { name, description, config } = parsed.data;

  // Validate config
  const configParsed = DirectorConfigSchema.safeParse(config);
  if (!configParsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Director config validation failed.", "validation", false, { issues: configParsed.error.flatten() });
  }

  const id = uuidv4();
  const now = new Date();
  const db = getDb();

  try {
    db.insert(directorProfile).values({
      id,
      name,
      description,
      config: JSON.stringify(configParsed.data),
      createdAt: now,
      updatedAt: now,
    }).run();
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return apiError(c, requestId, 409, "NAME_ALREADY_EXISTS", `Director profile "${name}" already exists.`, "validation");
    }
    throw err;
  }

  auditLog("director_profile", id, "create", "user", { name }, requestId);

  const profile = db.select().from(directorProfile).where(eq(directorProfile.id, id)).get()!;
  return c.json({ ok: true, requestId, profile: profileToResponse(profile) }, 201);
});

// ─── GET /api/director-profiles/:profileId ─────────────────────────────────────

app.get("/api/director-profiles/:profileId", (c) => {
  const requestId = uuidv4();
  const profileId = c.req.param("profileId");
  const db = getDb();

  const profile = db.select().from(directorProfile).where(eq(directorProfile.id, profileId)).get();
  if (!profile) {
    return apiError(c, requestId, 404, "PROFILE_NOT_FOUND", `Director profile "${profileId}" not found.`, "validation");
  }

  return c.json({ ok: true, requestId, profile: profileToResponse(profile) });
});

// ─── PATCH /api/director-profiles/:profileId ───────────────────────────────────

app.patch("/api/director-profiles/:profileId", async (c) => {
  const requestId = uuidv4();
  const profileId = c.req.param("profileId");
  const db = getDb();

  const existing = db.select().from(directorProfile).where(eq(directorProfile.id, profileId)).get();
  if (!existing) {
    return apiError(c, requestId, 404, "PROFILE_NOT_FOUND", `Director profile "${profileId}" not found.`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = UpdateDirectorProfileSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const updates = parsed.data;
  const now = new Date();
  const setValues: Record<string, unknown> = { updatedAt: now };

  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.description !== undefined) setValues.description = updates.description;
  if (updates.config !== undefined) {
    const configParsed = DirectorConfigSchema.safeParse(updates.config);
    if (!configParsed.success) {
      return apiError(c, requestId, 400, "VALIDATION_ERROR", "Director config validation failed.", "validation", false, { issues: configParsed.error.flatten() });
    }
    setValues.config = JSON.stringify(configParsed.data);
  }

  try {
    db.update(directorProfile).set(setValues).where(eq(directorProfile.id, profileId)).run();
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return apiError(c, requestId, 409, "NAME_ALREADY_EXISTS", `Director profile name "${updates.name}" already exists.`, "validation");
    }
    throw err;
  }

  auditLog("director_profile", profileId, "update", "user", { updatedFields: Object.keys(updates) }, requestId);

  const updated = db.select().from(directorProfile).where(eq(directorProfile.id, profileId)).get()!;
  return c.json({ ok: true, requestId, profile: profileToResponse(updated) });
});

export default app;
