import { Hono, type Context } from "hono";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import { agentActionLog, agentSession, settings } from "../db/schema.js";
import { verifyLocalPluginToken } from "../services/agent-auth.js";
import { estimateCostNumber, GenerateSpeechSchema, generateSpeech, type GenerateSpeechRequest } from "../services/tts-generator.js";

const app = new Hono();

const AgentGenerateSchema = GenerateSpeechSchema.extend({
  conversationId: z.string().min(1),
});

const ApproveActionSchema = z.object({
  actionLogId: z.number().int().positive(),
  conversationId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  scope: z.enum(["once", "session"]).optional().default("once"),
});

app.post("/api/agent/generate-speech", async (c) => {
  const requestId = uuidv4();
  const auth = authenticate(c.req.header("Authorization"));
  if (!auth.ok) return agentError(c, requestId, 401, "UNAUTHORIZED", auth.message, "auth", false);

  const body = await c.req.json();
  const parsed = AgentGenerateSchema.safeParse(body);
  if (!parsed.success) {
    return agentError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed", "validation", false, { issues: parsed.error.flatten() });
  }

  const db = getDb();
  const cfg = auth.settings;
  const payload = parsed.data;
  const ttsRequest = toTtsRequest(payload);
  const estimate = estimateCostNumber(payload.input.length);
  const activeSession = cfg.agentAuthMode === "confirm_each" ? null : findUsableSession(payload.conversationId, payload.input.length, estimate);

  const actionLogId = createActionLog(payload.conversationId, ttsRequest, estimate, activeSession?.id ?? null, activeSession ? "not_required" : "pending");

  if (cfg.agentAuthMode === "confirm_each" || !activeSession) {
    return c.json({
      ok: false,
      requestId,
      status: "approval_required",
      actionLogId,
      error: {
        code: "APPROVAL_REQUIRED",
        message: cfg.agentAuthMode === "confirm_each" ? "Agent action requires approval." : "No valid auto-approval session is available.",
        category: "approval",
        retryable: false,
      },
      approval: approvalInfo(cfg, cfg.agentAuthMode === "confirm_each" ? "confirm_each" : "no_session", payload.input.length, estimate),
    }, 202);
  }

  const result = await executeApprovedAction(actionLogId, payload.conversationId, ttsRequest, activeSession.id, "session");
  return c.json({ ...result.body, sessionId: activeSession.id }, result.status as 200 | 400 | 500 | 503);
});

app.post("/api/agent/approve-action", async (c) => {
  const requestId = uuidv4();
  const auth = authenticate(c.req.header("Authorization"));
  if (!auth.ok) return agentError(c, requestId, 401, "UNAUTHORIZED", auth.message, "auth", false);

  const parsed = ApproveActionSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return agentError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed", "validation", false, { issues: parsed.error.flatten() });
  }

  const db = getDb();
  const action = db.select().from(agentActionLog).where(eq(agentActionLog.id, parsed.data.actionLogId)).get();
  if (!action) return agentError(c, requestId, 404, "ACTION_NOT_FOUND", "Pending action was not found.", "validation", false);
  if (action.conversationId !== parsed.data.conversationId) {
    return agentError(c, requestId, 409, "CONVERSATION_MISMATCH", "Action does not belong to the requested conversation.", "validation", false);
  }
  if (action.approvalStatus !== "pending") return agentError(c, requestId, 409, "ACTION_ALREADY_DECIDED", "Action has already been decided.", "validation", false);
  if (action.actionType !== "generate_speech" || action.toolName !== "generate-speech") {
    return agentError(c, requestId, 400, "INVALID_ACTION_TYPE", "Action type or tool name is not supported for this endpoint.", "validation", false);
  }

  const payload = parseInputPayload(action.inputPayload);
  if (!payload) return agentError(c, requestId, 400, "INVALID_ACTION_PAYLOAD", "Stored action payload is invalid.", "validation", false);

  if (auth.settings.agentAuthMode === "confirm_each" && parsed.data.scope === "session") {
    return agentError(c, requestId, 409, "SESSION_SCOPE_NOT_ALLOWED", "Session approval scope is not allowed in confirm_each mode.", "approval", false);
  }

  if (parsed.data.decision === "reject") {
    if (!claimRejectedAction(action.id, parsed.data.scope)) {
      return agentError(c, requestId, 409, "ACTION_ALREADY_DECIDED", "Action has already been decided.", "validation", false);
    }
    return c.json({ ok: true, requestId, status: "rejected", actionLogId: action.id });
  }

  const estimate = estimateCostNumber(payload.input.length);
  let sessionId: string | null = action.sessionId ?? null;
  if (parsed.data.scope === "session") {
    if (payload.input.length > auth.settings.agentMaxChars || estimate > auth.settings.agentMaxCost) {
      return agentError(c, requestId, 409, "AGENT_BUDGET_EXCEEDED", "Initial action exceeds session budget.", "validation", false);
    }
  }

  if (!claimApprovedAction(action.id, parsed.data.scope)) {
    return agentError(c, requestId, 409, "ACTION_ALREADY_DECIDED", "Action has already been decided.", "validation", false);
  }

  if (parsed.data.scope === "session") {
    sessionId = createSession(action.conversationId, auth.settings);
    db.update(agentActionLog).set({ sessionId }).where(eq(agentActionLog.id, action.id)).run();
  }

  const result = await executeApprovedAction(action.id, action.conversationId, payload, sessionId, parsed.data.scope);
  return c.json(sessionId ? { ...result.body, sessionId } : result.body, result.status as 200 | 400 | 500 | 503);
});

function authenticate(header: string | undefined): { ok: true; settings: typeof settings.$inferSelect } | { ok: false; message: string } {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return { ok: false, message: "Authorization Bearer token is required." };
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row?.localPluginToken) return { ok: false, message: "Local plugin token is not configured." };
  if (!verifyLocalPluginToken(match[1], row.localPluginToken)) return { ok: false, message: "Local plugin token is invalid." };
  return { ok: true, settings: row };
}

function createActionLog(conversationId: string, payload: GenerateSpeechRequest, estimate: number, sessionId: string | null, status: "pending" | "not_required") {
  const db = getDb();
  const result = db.insert(agentActionLog).values({
    conversationId,
    actionType: "generate_speech",
    toolName: "generate-speech",
    sessionId,
    inputSummary: payload.input.slice(0, 160),
    inputPayload: JSON.stringify(payload),
    estimatedCost: `$${estimate.toFixed(4)}`,
    approvalStatus: status,
    createdAt: new Date(),
  }).run();
  return Number(result.lastInsertRowid);
}

async function executeApprovedAction(actionLogId: number, conversationId: string, payload: GenerateSpeechRequest, sessionId: string | null, scope: "once" | "session") {
  const db = getDb();
  if (sessionId && !reserveSessionBudget(sessionId, payload.input.length, estimateCostNumber(payload.input.length))) {
    const body = {
      ok: false,
      requestId: uuidv4(),
      status: "failed",
      error: { code: "AGENT_BUDGET_EXCEEDED", message: "Agent session budget is exhausted.", category: "validation", retryable: false },
      charCount: payload.input.length,
      createdAt: new Date().toISOString(),
    };
    db.update(agentActionLog).set({
      approvalScope: scope,
      completedAt: new Date(),
      outputSummary: "Approved action was not executed because the session budget was exhausted.",
      errorCode: "AGENT_BUDGET_EXCEEDED",
      errorMessage: "Agent session budget is exhausted.",
    }).where(eq(agentActionLog.id, actionLogId)).run();
    return { status: 409, body };
  }
  const result = await generateSpeech(payload, uuidv4(), { source: "agent", agentConversationId: conversationId, agentActionLogId: actionLogId });
  const body = result.body;
  const ok = body.ok === true;
  db.update(agentActionLog).set({
    relatedJobId: typeof body.jobId === "string" ? body.jobId : null,
    outputSummary: ok ? `Generated job ${String(body.jobId)}` : errorMessageFromBody(body),
    completedAt: new Date(),
    errorCode: ok ? null : errorCodeFromBody(body),
    errorMessage: ok ? null : errorMessageFromBody(body),
  }).where(eq(agentActionLog.id, actionLogId)).run();
  return result;
}

function findUsableSession(conversationId: string, chars: number, cost: number) {
  const db = getDb();
  const now = new Date();
  const sessions = db.select().from(agentSession).where(and(eq(agentSession.conversationId, conversationId), eq(agentSession.status, "active"))).all();
  for (const session of sessions) {
    if (session.expiresAt.getTime() <= now.getTime()) {
      db.update(agentSession).set({ status: "expired", updatedAt: now }).where(eq(agentSession.id, session.id)).run();
      continue;
    }
    if (canSpend(session.id, chars, cost)) return session;
  }
  return null;
}

function createSession(conversationId: string, cfg: typeof settings.$inferSelect): string {
  const db = getDb();
  const now = new Date();
  const id = uuidv4();
  db.insert(agentSession).values({
    id,
    conversationId,
    status: "active",
    maxRequests: cfg.agentMaxRequests,
    usedRequests: 0,
    maxChars: cfg.agentMaxChars,
    usedChars: 0,
    maxCost: cfg.agentMaxCost,
    usedCost: 0,
    expiresAt: new Date(now.getTime() + cfg.agentSessionExpiry * 1000),
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

function canSpend(sessionId: string | null, chars: number, cost: number): boolean {
  if (!sessionId) return true;
  const db = getDb();
  const session = db.select().from(agentSession).where(eq(agentSession.id, sessionId)).get();
  if (!session || session.status !== "active" || session.expiresAt.getTime() <= Date.now()) return false;
  return session.usedRequests + 1 <= session.maxRequests
    && session.usedChars + chars <= session.maxChars
    && session.usedCost + cost <= session.maxCost;
}

function reserveSessionBudget(sessionId: string, chars: number, cost: number): boolean {
  const db = getDb();
  const rawDb = (db as unknown as { $client: Database.Database }).$client;
  const result = rawDb.prepare(`
    UPDATE agent_session
    SET used_requests = used_requests + 1,
        used_chars = used_chars + ?,
        used_cost = round(used_cost + ?, 8),
        updated_at = unixepoch()
    WHERE id = ?
      AND status = 'active'
      AND expires_at > unixepoch()
      AND used_requests + 1 <= max_requests
      AND used_chars + ? <= max_chars
      AND used_cost + ? <= max_cost
  `).run(chars, cost, sessionId, chars, cost);
  return result.changes === 1;
}

function claimApprovedAction(actionLogId: number, scope: "once" | "session"): boolean {
  const db = getDb();
  const result = db.update(agentActionLog).set({
    approvalStatus: "approved",
    approvalScope: scope,
    approvedAt: new Date(),
  }).where(and(eq(agentActionLog.id, actionLogId), eq(agentActionLog.approvalStatus, "pending"))).run();
  return result.changes === 1;
}

function claimRejectedAction(actionLogId: number, scope: "once" | "session"): boolean {
  const db = getDb();
  const result = db.update(agentActionLog).set({
    approvalStatus: "rejected",
    approvalScope: scope,
    completedAt: new Date(),
    errorCode: "ACTION_REJECTED",
    errorMessage: "Agent action was rejected.",
  }).where(and(eq(agentActionLog.id, actionLogId), eq(agentActionLog.approvalStatus, "pending"))).run();
  return result.changes === 1;
}

function parseInputPayload(payload: string | null): GenerateSpeechRequest | null {
  if (!payload) return null;
  try {
    const parsed = GenerateSpeechSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toTtsRequest(payload: z.infer<typeof AgentGenerateSchema>): GenerateSpeechRequest {
  const { conversationId: _conversationId, ...ttsPayload } = payload;
  return ttsPayload;
}

function errorCodeFromBody(body: Record<string, unknown>): string | null {
  const error = body.error as { code?: unknown } | undefined;
  return typeof error?.code === "string" ? error.code : null;
}

function errorMessageFromBody(body: Record<string, unknown>): string | null {
  const error = body.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : null;
}

function approvalInfo(cfg: typeof settings.$inferSelect, reason: "confirm_each" | "no_session", charCount: number, estimatedCost: number) {
  return {
    required: true,
    authMode: cfg.agentAuthMode,
    reason,
    allowedScopes: cfg.agentAuthMode === "confirm_each" ? ["once"] : ["once", "session"],
    charCount,
    estimatedCost,
  };
}

function agentError(c: Context, requestId: string, status: number, code: string, message: string, category: string, retryable: boolean, metadata?: unknown) {
  return c.json({ ok: false, requestId, error: { code, message, category, retryable, metadata } }, status as 400 | 401 | 404 | 409);
}

export default app;
