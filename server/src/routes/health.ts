/**
 * Health check route.
 * GET /api/health  (also registered as /api/runtime/health for frontend compat)
 *
 * providerConfigured is true when an API key exists in DB settings or process.env.
 */

import { Hono } from "hono";
import { isOpenRouterConfigured } from "../services/key-resolver.js";

const health = new Hono();

let startTime = Date.now();

function buildHealthResponse() {
  return {
    status: "ok",
    version: "0.1.0",
    openRouterConfigured: isOpenRouterConfigured(),
    providerConfigured: isOpenRouterConfigured(),
    localPluginTokenEnabled: false,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

health.get("/api/health", (c) => {
  return c.json(buildHealthResponse());
});

// Alias for frontend compatibility
health.get("/api/runtime/health", (c) => {
  return c.json(buildHealthResponse());
});

export default health;
