/**
 * Settings routes.
 * GET    /api/settings          - Read current settings (Key masked)
 * PUT    /api/settings          - Save settings (including API Key, stored encrypted)
 * POST   /api/settings/test     - Test OpenRouter connection
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { encryptApiKey, decryptApiKey, maskApiKey } from "../config/env.js";
import { isOpenRouterConfigured, requireApiKey } from "../services/key-resolver.js";
import { OpenRouterProvider, sanitizeText } from "../services/openrouter-provider.js";
import { canonicalizeVoice } from "../utils/voice.js";
import { normalizeFormat, type AudioFormat } from "../utils/audio-format.js";
import { fingerprintFromHash, generateLocalPluginToken } from "../services/agent-auth.js";
import { checkOpenCodeAvailability } from "../services/opencode-runner.js";
import {
  getOpenCodeRuntimeCapabilities,
  type OpenCodeRuntimeCapabilities,
} from "../services/opencode-runtime-gate.js";
import {
  OpenCodeConfigError,
  getOpenCodeConfigPathInfo,
  readOpenCodeConfigDisplay,
  updateOpenCodeConfig,
} from "../services/opencode-config-service.js";
import {
  OPENCODE_INSTALL_CONFIRMATION_PHRASE,
  OpenCodeInstallError,
  checkPackageManagersAvailability,
  checkNpmAvailability,
  createOpenCodeInstallPlan,
  getLatestOpenCodeVersion,
  installOpenCodeControlled,
} from "../services/opencode-install-service.js";

const app = new Hono();

// ─── Validation Schemas ──────────────────────────────────────────────────────

const SettingsSchema = z.object({
  openRouterApiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultVoice: z.string().optional(),
  defaultFormat: z.enum(["wav", "pcm", "mp3"]).optional(),
  audioOutputDir: z.string().optional(),
  maxCharsPerRequest: z.number().int().min(100).max(50000).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(10).optional(),
  agentAuthMode: z.enum(["confirm_each", "session_auto"]).optional(),
  agentMaxRequests: z.number().int().min(1).max(1000).optional(),
  agentMaxChars: z.number().int().min(1).max(500000).optional(),
  agentMaxCost: z.number().min(0).max(100).optional(),
  agentSessionExpiry: z.number().int().min(60).max(604800).optional(),
  localPluginTokenAction: z.enum(["rotate", "clear"]).optional(),
  agent: z.object({
    authMode: z.enum(["confirm_each", "session_auto"]).optional(),
    maxRequests: z.number().int().min(1).max(1000).optional(),
    maxChars: z.number().int().min(1).max(500000).optional(),
    maxCost: z.number().min(0).max(100).optional(),
    sessionExpiry: z.number().int().min(60).max(604800).optional(),
    tokenAction: z.enum(["rotate", "clear"]).optional(),
  }).optional(),
});

const OpenCodeProviderConfigUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  baseURL: z.string().nullable().optional(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  apiKeyAction: z.enum(["keep", "set", "clear"]).optional(),
}).strict();

const OpenCodeConfigUpdateSchema = z.object({
  expectedRevision: z.string().min(1),
  model: z.string().optional(),
  providers: z.array(OpenCodeProviderConfigUpdateSchema).max(20).optional(),
}).strict();

const OpenCodeInstallSchema = z.object({
  nonce: z.string().min(16),
  confirmationPhrase: z.literal(OPENCODE_INSTALL_CONFIRMATION_PHRASE),
  confirm: z.literal(true),
}).strict();

function defaults() {
  return {
    agentAuthMode: "confirm_each" as const,
    agentMaxRequests: 10,
    agentMaxChars: 10000,
    agentMaxCost: 0.01,
    agentSessionExpiry: 3600,
  };
}

function agentSettingsPayload(row: typeof settings.$inferSelect | undefined) {
  const d = defaults();
  const hash = row?.localPluginToken ?? null;
  return {
    hasLocalPluginToken: !!hash,
    localPluginTokenFingerprint: fingerprintFromHash(hash),
    agentAuthMode: row?.agentAuthMode ?? d.agentAuthMode,
    agentMaxRequests: row?.agentMaxRequests ?? d.agentMaxRequests,
    agentMaxChars: row?.agentMaxChars ?? d.agentMaxChars,
    agentMaxCost: row?.agentMaxCost ?? d.agentMaxCost,
    agentSessionExpiry: row?.agentSessionExpiry ?? d.agentSessionExpiry,
    agent: {
      hasLocalPluginToken: !!hash,
      fingerprint: fingerprintFromHash(hash),
      authMode: row?.agentAuthMode ?? d.agentAuthMode,
      maxRequests: row?.agentMaxRequests ?? d.agentMaxRequests,
      maxChars: row?.agentMaxChars ?? d.agentMaxChars,
      maxCost: row?.agentMaxCost ?? d.agentMaxCost,
      sessionExpiry: row?.agentSessionExpiry ?? d.agentSessionExpiry,
    },
  };
}

function localCapabilityError(capabilities: OpenCodeRuntimeCapabilities) {
  return {
    ok: false,
    runtime: capabilities.runtime,
    capabilities,
    error: capabilities.reason ?? "当前运行环境不支持此 OpenCode 本地能力。",
  };
}

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function mapConfigError(error: unknown) {
  if (error instanceof OpenCodeConfigError) {
    return { status: error.status, body: { ok: false, code: error.code, error: error.message } };
  }
  return { status: 500, body: { ok: false, code: "OPENCODE_CONFIG_FAILED", error: "OpenCode 配置处理失败。" } };
}

function mapInstallError(error: unknown) {
  if (error instanceof OpenCodeInstallError) {
    return { status: error.status, body: { ok: false, code: error.code, error: error.message } };
  }
  return { status: 500, body: { ok: false, code: "OPENCODE_INSTALL_FAILED", error: "OpenCode 安装处理失败。" } };
}

// ─── GET /api/settings ───────────────────────────────────────────────────────

app.get("/api/settings", (c) => {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();

  if (!row) {
    return c.json({
      hasOpenRouterApiKey: false,
      keyMask: null,
      defaultModel: "google/gemini-3.1-flash-tts-preview",
      defaultVoice: "Zephyr",
      defaultFormat: "wav",
      audioOutputDir: "./data/audio",
      maxCharsPerRequest: 5000,
      maxConcurrentJobs: 2,
      ...agentSettingsPayload(undefined),
    });
  }

  // Determine if key exists and compute mask -- never return plaintext
  let hasKey = false;
  let keyMask: string | null = null;

  if (row.openRouterApiKey) {
    // Try to decrypt to get the real key for masking
    const decrypted = decryptApiKey(row.openRouterApiKey);
    if (decrypted) {
      hasKey = true;
      keyMask = maskApiKey(decrypted);
    } else {
      // Legacy plaintext stored key
      hasKey = true;
      keyMask = maskApiKey(row.openRouterApiKey);
    }
  }

  return c.json({
    hasOpenRouterApiKey: hasKey,
    keyMask,
    // Backward compat: also return openRouterApiKey field for older frontend
    openRouterApiKey: hasKey ? keyMask : null,
    defaultModel: row.defaultModel,
    defaultVoice: canonicalizeVoice(row.defaultVoice),
    defaultFormat: normalizeFormat(row.defaultFormat),
    audioOutputDir: row.audioOutputDir,
    maxCharsPerRequest: row.maxCharsPerRequest,
    maxConcurrentJobs: row.maxConcurrentJobs,
    ...agentSettingsPayload(row),
  });
});

// ─── PUT /api/settings ───────────────────────────────────────────────────────

app.put("/api/settings", async (c) => {
  const body = await c.req.json();
  const parsed = SettingsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const data = parsed.data;
  const now = new Date();
  const tokenAction = data.localPluginTokenAction ?? data.agent?.tokenAction;
  let rotatedToken: string | null = null;

  // Build update values - only include fields that were provided
  const updateValues: Record<string, unknown> = { updatedAt: now };

  if (data.openRouterApiKey !== undefined) {
    if (data.openRouterApiKey && data.openRouterApiKey.trim().length > 0) {
      // Encrypt the key before storing in DB
      updateValues.openRouterApiKey = encryptApiKey(data.openRouterApiKey.trim());
    } else {
      // Clear the key
      updateValues.openRouterApiKey = null;
    }
  }
  if (data.defaultModel !== undefined) updateValues.defaultModel = data.defaultModel;
  if (data.defaultVoice !== undefined) updateValues.defaultVoice = canonicalizeVoice(data.defaultVoice);
  if (data.defaultFormat !== undefined) updateValues.defaultFormat = normalizeFormat(data.defaultFormat);
  if (data.audioOutputDir !== undefined) updateValues.audioOutputDir = data.audioOutputDir;
  if (data.maxCharsPerRequest !== undefined) updateValues.maxCharsPerRequest = data.maxCharsPerRequest;
  if (data.maxConcurrentJobs !== undefined) updateValues.maxConcurrentJobs = data.maxConcurrentJobs;
  if (data.agentAuthMode !== undefined || data.agent?.authMode !== undefined) updateValues.agentAuthMode = data.agentAuthMode ?? data.agent?.authMode;
  if (data.agentMaxRequests !== undefined || data.agent?.maxRequests !== undefined) updateValues.agentMaxRequests = data.agentMaxRequests ?? data.agent?.maxRequests;
  if (data.agentMaxChars !== undefined || data.agent?.maxChars !== undefined) updateValues.agentMaxChars = data.agentMaxChars ?? data.agent?.maxChars;
  if (data.agentMaxCost !== undefined || data.agent?.maxCost !== undefined) updateValues.agentMaxCost = data.agentMaxCost ?? data.agent?.maxCost;
  if (data.agentSessionExpiry !== undefined || data.agent?.sessionExpiry !== undefined) updateValues.agentSessionExpiry = data.agentSessionExpiry ?? data.agent?.sessionExpiry;
  if (tokenAction === "rotate") {
    const generated = generateLocalPluginToken();
    updateValues.localPluginToken = generated.hash;
    rotatedToken = generated.token;
  } else if (tokenAction === "clear") {
    updateValues.localPluginToken = null;
  }

  // Upsert: update row id=1, or insert if not exists
  const existing = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (existing) {
    db.update(settings)
      .set(updateValues)
      .where(eq(settings.id, 1))
      .run();
  } else {
    db.insert(settings).values({
      id: 1,
      ...updateValues,
    }).run();
  }

  return c.json({
    ok: true,
    openRouterKeySaved: !!data.openRouterApiKey,
    localPluginToken: rotatedToken ?? undefined,
  });
});

// ─── POST /api/settings/test ─────────────────────────────────────────────────

app.post("/api/settings/test", async (c) => {
  if (!isOpenRouterConfigured()) {
    return c.json({
      ok: false,
      provider: "openrouter",
      checkedEndpoint: "audio_speech",
      latencyMs: 0,
      modelAvailable: false,
      authValid: false,
      errorCode: "MISSING_API_KEY",
      errorMessage: "OpenRouter API Key 未配置。",
      actionMessage: "请先在 Settings 保存 OpenRouter API Key。",
      error: "MISSING_API_KEY",
    });
  }

  try {
    const apiKey = requireApiKey();
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.id, 1)).get();
    const provider = new OpenRouterProvider(apiKey);
    const defaultFormat = normalizeFormat(row?.defaultFormat ?? "wav");
    const result = await provider.testConnection({
      model: row?.defaultModel ?? "google/gemini-3.1-flash-tts-preview",
      voice: canonicalizeVoice(row?.defaultVoice ?? "Zephyr"),
      responseFormat: defaultFormat === "mp3" ? "mp3" : "pcm",
    });

    return c.json({
      ok: result.ok,
      provider: result.provider,
      checkedEndpoint: result.checkedEndpoint,
      latencyMs: result.latencyMs,
      modelAvailable: result.modelAvailable,
      authValid: result.authValid,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      providerMessage: result.providerMessage,
      actionMessage: result.actionMessage,
      error: result.error || null,
    });
  } catch (err) {
    return c.json({
      ok: false,
      provider: "openrouter",
      checkedEndpoint: "audio_speech",
      latencyMs: 0,
      modelAvailable: false,
      authValid: false,
      errorCode: "PROVIDER_UNAVAILABLE",
      errorMessage: "OpenRouter 连接测试失败。",
      actionMessage: "请稍后重试；如果持续失败，请检查网络连接或 OpenRouter 服务状态。",
      error: err instanceof Error ? sanitizeText(err.message) : "Test connection failed",
    });
  }
});

// ─── OpenCode Settings: Runtime Status ───────────────────────────────────────

app.get("/api/settings/opencode/status", async (c) => {
  const capabilities = getOpenCodeRuntimeCapabilities(c.req.raw);
  if (!capabilities.canDetectLocalOpenCode) {
    return c.json({
      ok: true,
      runtime: capabilities.runtime,
      capabilities,
      availability: null,
      npm: null,
      packageManagers: null,
      latestVersion: null,
      pathState: "not-found",
      message: capabilities.reason ?? "当前运行环境不支持本地 OpenCode 检测。",
    });
  }

  const [availability, npm, packageManagers, latestVersion] = await Promise.all([
    checkOpenCodeAvailability(),
    checkNpmAvailability(),
    checkPackageManagersAvailability(),
    getLatestOpenCodeVersion(),
  ]);

  return c.json({
    ok: true,
    runtime: capabilities.runtime,
    capabilities,
    availability: {
      available: availability.available,
      version: availability.version,
      error: availability.error,
      installMethod: availability.installMethod ?? null,
      pathState: availability.pathState ?? "not-found",
      effectivePathCandidates: availability.effectivePathCandidates ?? [],
      resolutionError: availability.resolutionError ?? null,
      providerMetadata: availability.providerMetadata ?? { hasConfig: false, providerCount: 0, modelCount: 0 },
      checkedAt: new Date().toISOString(),
      cacheTtlMs: 60_000,
    },
    npm,
    packageManagers,
    latestVersion,
    pathState: availability.pathState ?? "not-found",
    message: null,
  });
});

// ─── OpenCode Settings: Config Read/Write ────────────────────────────────────

app.get("/api/settings/opencode/config", async (c) => {
  const capabilities = getOpenCodeRuntimeCapabilities(c.req.raw);
  if (!capabilities.canReadConfig) {
    return c.json(localCapabilityError(capabilities), 403);
  }

  try {
    return c.json(await readOpenCodeConfigDisplay(capabilities.runtime));
  } catch (error) {
    const mapped = mapConfigError(error);
    return c.json(mapped.body, mapped.status as 400 | 403 | 409 | 500);
  }
});

app.put("/api/settings/opencode/config", async (c) => {
  const capabilities = getOpenCodeRuntimeCapabilities(c.req.raw);
  if (!capabilities.canWriteConfig) {
    return c.json(localCapabilityError(capabilities), 403);
  }

  const parsed = OpenCodeConfigUpdateSchema.safeParse(await safeJson(c));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await updateOpenCodeConfig(parsed.data));
  } catch (error) {
    const mapped = mapConfigError(error);
    return c.json(mapped.body, mapped.status as 400 | 403 | 409 | 500);
  }
});

// ─── OpenCode Settings: Controlled Install ───────────────────────────────────

app.post("/api/settings/opencode/install-plan", async (c) => {
  const capabilities = getOpenCodeRuntimeCapabilities(c.req.raw);
  if (!capabilities.canInstall) {
    return c.json(localCapabilityError(capabilities), 403);
  }

  try {
    return c.json(await createOpenCodeInstallPlan());
  } catch (error) {
    const mapped = mapInstallError(error);
    return c.json(mapped.body, mapped.status as 400 | 403 | 409 | 500);
  }
});

app.post("/api/settings/opencode/install", async (c) => {
  const capabilities = getOpenCodeRuntimeCapabilities(c.req.raw);
  if (!capabilities.canInstall) {
    return c.json(localCapabilityError(capabilities), 403);
  }

  const parsed = OpenCodeInstallSchema.safeParse(await safeJson(c));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.flatten() }, 400);
  }

  try {
    return c.json(await installOpenCodeControlled(parsed.data));
  } catch (error) {
    const mapped = mapInstallError(error);
    return c.json(mapped.body, mapped.status as 400 | 403 | 409 | 500);
  }
});

// Desktop opens the fixed file through Electron IPC. This endpoint exposes only
// fixed capability metadata and never accepts a path/command from the renderer.
app.post("/api/settings/opencode/open-config", async (c) => {
  const capabilities = getOpenCodeRuntimeCapabilities(c.req.raw);
  if (!capabilities.canOpenConfig && !capabilities.canReturnConfigPathForCopy) {
    return c.json(localCapabilityError(capabilities), 403);
  }

  const pathInfo = getOpenCodeConfigPathInfo();
  return c.json({
    ok: true,
    runtime: capabilities.runtime,
    configPathLabel: pathInfo.label,
    copyableConfigPath: capabilities.canReturnConfigPathForCopy ? pathInfo.filePath : null,
    desktopIpcChannel: capabilities.canOpenConfig ? "tts-desktop:open-opencode-config" : null,
  });
});

// Alias: /api/settings/test-connection (plan specifies this path)
app.post("/api/settings/test-connection", async (c) => {
  // Reuse the same handler
  return app.fetch(new Request("http://localhost/api/settings/test", { method: "POST" }), {} as any);
});

export default app;
