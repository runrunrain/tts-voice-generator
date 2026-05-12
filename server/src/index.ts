/**
 * TTS Voice Generator - Backend Server Entry Point
 *
 * Hono API server running on Node.js, port 3001.
 * Handles:
 * - Health check
 * - Settings CRUD
 * - Voice management
 * - TTS generation (OpenRouter proxy)
 * - History and audio serving
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "./config/env.js";
import { initSchema, closeDb } from "./db/index.js";
import { seedDatabase } from "./db/seed.js";
import { isOpenRouterConfigured } from "./services/key-resolver.js";

// Import route modules
import healthRoutes from "./routes/health.js";
import settingsRoutes from "./routes/settings.js";
import voicesRoutes from "./routes/voices.js";
import ttsRoutes from "./routes/tts.js";
import historyRoutes from "./routes/history.js";
import promptsRoutes from "./routes/prompts.js";
import agentRoutes from "./routes/agent.js";
import diagnosticsRoutes from "./routes/diagnostics.js";
import tasksRoutes from "./routes/tasks.js";
import documentsRoutes from "./routes/documents.js";
import productionListRoutes from "./routes/production-list.js";
import directorProfilesRoutes from "./routes/director-profiles.js";
import agentButtonsRoutes from "./routes/agent-buttons.js";
import agentChatRoutes from "./routes/agent-chat.js";

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

const DESKTOP_TOKEN_HEADER = "X-TTS-Desktop-Token";
const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export type DesktopSecurityOptions = {
  enabled: boolean;
  token: string;
};

type DesktopOriginRef = {
  expectedOrigin: string | null;
};

export type CreateAppOptions = {
  desktopSecurity?: DesktopSecurityOptions;
  desktopOriginRef?: DesktopOriginRef;
};

export type StartServerOptions = {
  port?: number;
  hostname?: string;
  installSignalHandlers?: boolean;
  desktopSecurity?: DesktopSecurityOptions;
};

export type StartedServer = {
  port: number;
  hostname: string;
  url: string;
  close: () => Promise<void>;
};

function parseCorsOrigins(rawOrigins: string | undefined): string[] {
  if (!rawOrigins) return DEFAULT_CORS_ORIGINS;

  const extraOrigins = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .filter((origin) => origin !== "*")
    .filter((origin) => {
      try {
        const parsed = new URL(origin);
        return parsed.origin === origin && ["http:", "https:"].includes(parsed.protocol);
      } catch {
        return false;
      }
    });

  return [...new Set([...DEFAULT_CORS_ORIGINS, ...extraOrigins])];
}

function isDesktopSecurityEnabled(options: DesktopSecurityOptions | undefined): options is DesktopSecurityOptions {
  return options?.enabled === true && typeof options.token === "string" && options.token.length > 0;
}

function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function isAllowedDesktopReferer(referer: string, expectedOrigin: string | null): boolean {
  if (!expectedOrigin) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

// ─── Create Hono App ─────────────────────────────────────────────────────────

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();
  const desktopSecurity = options.desktopSecurity;
  const desktopSecurityEnabled = isDesktopSecurityEnabled(desktopSecurity);
  const desktopOriginRef = options.desktopOriginRef ?? { expectedOrigin: null };

// Global middleware

  app.use("*", async (c, next) => {
    if (!desktopSecurityEnabled) {
      await next();
      return;
    }

    const origin = c.req.header("Origin");
    if (origin && origin !== desktopOriginRef.expectedOrigin) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const referer = c.req.header("Referer");
    if (referer && !isAllowedDesktopReferer(referer, desktopOriginRef.expectedOrigin)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const requestPath = c.req.path;
    const method = c.req.method.toUpperCase();
    const isHealthRead = requestPath === "/api/health" && method === "GET";
    const isCorsPreflight = method === "OPTIONS";

    if (!isHealthRead && !isCorsPreflight && requestPath.startsWith("/api/")) {
      const providedToken = c.req.header(DESKTOP_TOKEN_HEADER) ?? "";
      if (!timingSafeTokenEqual(providedToken, desktopSecurity.token)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    await next();
  });

// CORS: only allow local dev frontend origins. No-origin requests (curl, SSR)
// pass through without CORS headers, which is correct for same-host or
// programmatic access. Non-whitelisted origins receive no allow headers,
// causing browsers to block the response.
  const allowedOrigins = desktopSecurityEnabled ? [] : parseCorsOrigins(process.env.CORS_ORIGINS);

  app.use("*", cors({
    origin: (origin: string) => {
      if (desktopSecurityEnabled) {
        return origin === desktopOriginRef.expectedOrigin ? origin : null;
      }
      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", DESKTOP_TOKEN_HEADER],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
    credentials: !desktopSecurityEnabled,
  }));

  if (desktopSecurityEnabled) {
    app.use("*", async (c, next) => {
      await next();
      if (!c.req.path.startsWith("/api/")) {
        c.header("Content-Security-Policy", DESKTOP_CSP);
      }
    });
  }

  app.use("*", logger());

// ─── Register Routes ─────────────────────────────────────────────────────────

// Each route module registers its own paths under /api/*
  app.route("/", healthRoutes);
  app.route("/", settingsRoutes);
  app.route("/", voicesRoutes);
  app.route("/", ttsRoutes);
  app.route("/", historyRoutes);
  app.route("/", promptsRoutes);
  app.route("/", agentRoutes);
  app.route("/", diagnosticsRoutes);
  app.route("/", tasksRoutes);
  app.route("/", documentsRoutes);
  app.route("/", productionListRoutes);
  app.route("/", directorProfilesRoutes);
  app.route("/", agentButtonsRoutes);
  app.route("/", agentChatRoutes);

// Keep API semantics JSON-only. Static SPA fallback is registered after this
// guard so missing /api/* routes never return index.html.
  app.all("/api/*", (c) => {
    return c.json({ error: "Not found", path: c.req.path }, 404);
  });

// ─── Production Static Frontend ───────────────────────────────────────────────

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDistDir = path.resolve(moduleDir, "../../dist");
  const frontendIndexPath = path.join(frontendDistDir, "index.html");

  app.get("*", serveStatic({ root: frontendDistDir }));
  app.get("*", serveStatic({ path: frontendIndexPath }));

// ─── 404 Fallback ────────────────────────────────────────────────────────────

  app.notFound((c) => {
    return c.json({ error: "Not found", path: c.req.path }, 404);
  });

// ─── Global Error Handler ────────────────────────────────────────────────────

  app.onError((err, c) => {
    console.error("[server] Unhandled error:", err);
    return c.json({
      error: "Internal server error",
      message: env.nodeEnv === "development" ? err.message : undefined,
    }, 500);
  });

  return app;
}

const app = createApp();

// ─── Initialize and Start ────────────────────────────────────────────────────

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  console.info("[server] Initializing...");

  // Initialize database schema
  initSchema();
  console.info("[server] Database schema initialized");

  // Seed data
  seedDatabase();

  // Ensure audio output directory exists
  const audioDir = env.audioOutputDir;
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    console.info(`[server] Created audio output directory: ${audioDir}`);
  }

  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? env.port;
  const desktopOriginRef: DesktopOriginRef = { expectedOrigin: null };
  const runtimeApp = createApp({
    desktopSecurity: options.desktopSecurity,
    desktopOriginRef,
  });

  const started = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
    let settled = false;
    const server = serve(
      {
        fetch: runtimeApp.fetch,
        port,
        hostname,
      },
      (info) => {
        settled = true;
        resolve({ server, port: info.port });
      }
    );
    server.once("error", (error) => {
      if (!settled) reject(error);
    });
  });

  const url = `http://${hostname}:${started.port}`;
  desktopOriginRef.expectedOrigin = url;
  console.info(`[server] TTS Voice Generator API listening on ${url}`);
  console.info(`[server] OpenRouter API Key configured: ${isOpenRouterConfigured() ? "yes" : "no"}`);
  console.info(`[server] Environment: ${env.nodeEnv}`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      started.server.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    closeDb();
  };

  // Graceful shutdown
  if (options.installSignalHandlers !== false) {
  const shutdown = () => {
    console.info("[server] Shutting down...");
    close()
      .catch((error) => {
        console.error("[server] Error while shutting down:", error);
      })
      .finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  }

  return {
    port: started.port,
    hostname,
    url,
    close,
  };
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  startServer();
}

export default app;
