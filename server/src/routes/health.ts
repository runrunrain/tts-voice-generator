/**
 * Health check route.
 * GET /api/health  (also registered as /api/runtime/health for frontend compat)
 */

import { Hono } from "hono";
import { isOpenRouterConfigured, env } from "../config/env.js";

const health = new Hono();

let startTime = Date.now();

health.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    version: "0.1.0",
    openRouterConfigured: isOpenRouterConfigured(),
    localPluginTokenEnabled: false,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// Alias for frontend compatibility
health.get("/api/runtime/health", (c) => {
  return c.json({
    status: "ok",
    version: "0.1.0",
    openRouterConfigured: isOpenRouterConfigured(),
    localPluginTokenEnabled: false,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

export default health;
