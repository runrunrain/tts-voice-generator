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
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
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

// ─── Create Hono App ─────────────────────────────────────────────────────────

export function createApp() {
const app = new Hono();

// Global middleware

// CORS: only allow local dev frontend origins. No-origin requests (curl, SSR)
// pass through without CORS headers, which is correct for same-host or
// programmatic access. Non-whitelisted origins receive no allow headers,
// causing browsers to block the response.
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

app.use("*", cors({
  origin: ALLOWED_ORIGINS,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["Content-Length"],
  maxAge: 86400,
  credentials: true,
}));
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

function startServer() {
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

  // Start HTTP server
  serve(
    {
      fetch: app.fetch,
      port: env.port,
    },
    (info) => {
      console.info(`[server] TTS Voice Generator API listening on http://127.0.0.1:${info.port}`);
      console.info(`[server] OpenRouter API Key configured: ${isOpenRouterConfigured() ? "yes" : "no"}`);
      console.info(`[server] Environment: ${env.nodeEnv}`);
    }
  );

  // Graceful shutdown
  const shutdown = () => {
    console.info("[server] Shutting down...");
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  startServer();
}

export default app;
