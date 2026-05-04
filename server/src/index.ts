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
import { cors } from "hono/cors";
import { logger } from "hono/logger";

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

// ─── Create Hono App ─────────────────────────────────────────────────────────

const app = new Hono();

// Global middleware
app.use("*", cors());
app.use("*", logger());

// ─── Register Routes ─────────────────────────────────────────────────────────

// Each route module registers its own paths under /api/*
app.route("/", healthRoutes);
app.route("/", settingsRoutes);
app.route("/", voicesRoutes);
app.route("/", ttsRoutes);
app.route("/", historyRoutes);
app.route("/", promptsRoutes);

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

// ─── Initialize and Start ────────────────────────────────────────────────────

function startServer() {
  console.log("[server] Initializing...");

  // Initialize database schema
  initSchema();
  console.log("[server] Database schema initialized");

  // Seed data
  seedDatabase();

  // Ensure audio output directory exists
  import("node:fs").then(fs => {
    const audioDir = env.audioOutputDir;
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
      console.log(`[server] Created audio output directory: ${audioDir}`);
    }
  });

  // Start HTTP server
  serve(
    {
      fetch: app.fetch,
      port: env.port,
    },
    (info) => {
      console.log(`[server] TTS Voice Generator API listening on http://127.0.0.1:${info.port}`);
      console.log(`[server] OpenRouter API Key configured: ${isOpenRouterConfigured() ? "yes" : "no"}`);
      console.log(`[server] Environment: ${env.nodeEnv}`);
    }
  );

  // Graceful shutdown
  const shutdown = () => {
    console.log("[server] Shutting down...");
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer();

export default app;
