/**
 * OpenCode Sessions and Agent Chat routes.
 *
 * GET  /api/opencode/sessions              - List OpenCode sessions
 * POST /api/opencode/sessions              - Create OpenCode session
 * POST /api/agent/chat/sessions            - Create chat session
 * GET  /api/agent/chat/sessions/:sessionId/messages  - Get messages
 * POST /api/agent/chat/sessions/:sessionId/messages  - Post message
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  opencodeSession,
  agentChatSession,
  agentChatMessage,
  operationAuditLog,
} from "../db/schema-extended.js";
import {
  CreateOpenCodeSessionSchema,
  ChatMessageSchema,
} from "../domain/validators.js";
import { checkOpenCodeAvailability, sanitizeError } from "../services/opencode-runner.js";

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

// ─── GET /api/opencode/sessions ────────────────────────────────────────────────

app.get("/api/opencode/sessions", (c) => {
  const requestId = uuidv4();
  const sessionType = c.req.query("sessionType");
  const db = getDb();

  let sessions;
  if (sessionType) {
    sessions = db.select().from(opencodeSession)
      .where(eq(opencodeSession.sessionType, sessionType))
      .orderBy(desc(opencodeSession.createdAt))
      .all();
  } else {
    sessions = db.select().from(opencodeSession)
      .orderBy(desc(opencodeSession.createdAt))
      .all();
  }

  return c.json({
    ok: true,
    requestId,
    sessions: sessions.map((s) => ({
      id: s.id,
      sessionType: s.sessionType,
      status: s.status,
      metadata: JSON.parse(s.metadataJson || "{}"),
      taskId: s.taskId,
      createdAt: s.createdAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
    })),
  });
});

// ─── POST /api/opencode/sessions ───────────────────────────────────────────────

app.post("/api/opencode/sessions", async (c) => {
  const requestId = uuidv4();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = CreateOpenCodeSessionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { sessionType, metadata } = parsed.data;
  const id = uuidv4();
  const now = new Date();
  const db = getDb();

  db.insert(opencodeSession).values({
    id,
    sessionType,
    status: "active",
    metadataJson: JSON.stringify(metadata),
    taskId: null,
    createdAt: now,
  }).run();

  auditLog("opencode_session", id, "create", "user", { sessionType }, requestId);

  return c.json({
    ok: true,
    requestId,
    session: {
      id,
      sessionType,
      status: "active",
      metadata,
      taskId: null,
      createdAt: now.toISOString(),
      completedAt: null,
    },
  }, 201);
});

// ─── POST /api/agent/chat/sessions ─────────────────────────────────────────────

app.post("/api/agent/chat/sessions", async (c) => {
  const requestId = uuidv4();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const chatSessionSchema = z.object({
    sessionType: z.enum(["automation", "chat"]).optional().default("chat"),
    metadata: z.record(z.unknown()).optional().default({}),
    taskId: z.string().optional(),
  });
  const parsed = chatSessionSchema.safeParse(body);

  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { sessionType, metadata, taskId } = parsed.data;

  // Create linked OpenCode session
  const opencodeSessionId = uuidv4();
  const chatSessionId = uuidv4();
  const now = new Date();
  const db = getDb();

  db.insert(opencodeSession).values({
    id: opencodeSessionId,
    sessionType,
    status: "active",
    metadataJson: JSON.stringify(metadata),
    taskId: taskId ?? null,
    createdAt: now,
  }).run();

  db.insert(agentChatSession).values({
    id: chatSessionId,
    opencodeSessionId,
    taskId: taskId ?? null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();

  auditLog("chat_session", chatSessionId, "create", "user", { sessionType, taskId }, requestId);

  return c.json({
    ok: true,
    requestId,
    session: {
      id: chatSessionId,
      opencodeSessionId,
      sessionType,
      status: "active",
      taskId: taskId ?? null,
      createdAt: now.toISOString(),
    },
  }, 201);
});

// ─── GET /api/agent/chat/sessions/:sessionId/messages ──────────────────────────

app.get("/api/agent/chat/sessions/:sessionId/messages", (c) => {
  const requestId = uuidv4();
  const sessionId = c.req.param("sessionId");
  const db = getDb();

  const session = db.select().from(agentChatSession).where(eq(agentChatSession.id, sessionId)).get();
  if (!session) {
    return apiError(c, requestId, 404, "SESSION_NOT_FOUND", `Chat session "${sessionId}" not found.`, "validation");
  }

  const messages = db.select().from(agentChatMessage)
    .where(eq(agentChatMessage.sessionId, sessionId))
    .orderBy(agentChatMessage.createdAt)
    .all();

  return c.json({
    ok: true,
    requestId,
    messages: messages.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.content,
      metadata: JSON.parse(m.metadataJson || "{}"),
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

// ─── POST /api/agent/chat/sessions/:sessionId/messages ─────────────────────────

app.post("/api/agent/chat/sessions/:sessionId/messages", async (c) => {
  const requestId = uuidv4();
  const sessionId = c.req.param("sessionId");
  const db = getDb();

  const session = db.select().from(agentChatSession).where(eq(agentChatSession.id, sessionId)).get();
  if (!session) {
    return apiError(c, requestId, 404, "SESSION_NOT_FOUND", `Chat session "${sessionId}" not found.`, "validation");
  }

  if (session.status !== "active") {
    return apiError(c, requestId, 409, "SESSION_CLOSED", `Chat session "${sessionId}" is not active.`, "validation");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = ChatMessageSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { role, content, metadata } = parsed.data;
  const userMsgId = uuidv4();
  const now = new Date();

  // Store user message
  db.insert(agentChatMessage).values({
    id: userMsgId,
    sessionId,
    role,
    content,
    metadataJson: JSON.stringify(metadata),
    createdAt: now,
  }).run();

  auditLog("chat_message", userMsgId, "create", "user", { sessionId, role }, requestId);

  // Generate assistant response
  // P0 non-streaming: If OpenCode not available, return explanatory message
  // that does NOT claim to have executed external operations
  const availability = await checkOpenCodeAvailability();
  let assistantContent: string;

  if (role === "user") {
    if (!availability.available) {
      assistantContent = "OpenCode CLI is not available. I can help you with local operations only. " +
        "Please configure OpenCode CLI for full agent capabilities. " +
        "In the meantime, you can use the normalize-requirements endpoint and button actions for deterministic transforms.";
    } else {
      // OpenCode is available - would integrate with CLI here
      // P0: acknowledge and indicate what would happen
      assistantContent = `Received your message. Processing via OpenCode session (${session.opencodeSessionId}). ` +
        `Full CLI integration is pending. Your message has been recorded.`;
    }

    const assistantMsgId = uuidv4();
    db.insert(agentChatMessage).values({
      id: assistantMsgId,
      sessionId,
      role: "assistant",
      content: assistantContent,
      metadataJson: JSON.stringify({ opencodeAvailable: availability.available }),
      createdAt: new Date(),
    }).run();

    auditLog("chat_message", assistantMsgId, "create", "agent", { sessionId, opencodeAvailable: availability.available }, requestId);
  }

  // Return all messages in the session
  const messages = db.select().from(agentChatMessage)
    .where(eq(agentChatMessage.sessionId, sessionId))
    .orderBy(agentChatMessage.createdAt)
    .all();

  return c.json({
    ok: true,
    requestId,
    messages: messages.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.content,
      metadata: JSON.parse(m.metadataJson || "{}"),
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

export default app;
