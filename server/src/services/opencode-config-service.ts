import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeError, sanitizeString } from "./opencode-runner.js";
import { chooseOpenCodeConfigPath } from "./opencode-platform.js";
import type { OpenCodeRuntime } from "./opencode-runtime-gate.js";

export interface OpenCodeConfigWarning {
  code: string;
  message: string;
}

export interface OpenCodeProviderDisplay {
  name: string;
  baseURL: string | null;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  models: Array<{ key: string; name?: string | null }>;
  editable: boolean;
  source: "existing" | "default-openrouter";
}

export interface OpenCodeConfigDisplayResponse {
  ok: true;
  exists: boolean;
  parseOk: boolean;
  revision: string;
  configPathLabel: string;
  copyableConfigPath: string | null;
  model: string;
  providers: OpenCodeProviderDisplay[];
  warnings: OpenCodeConfigWarning[];
}

export type ApiKeyAction = "keep" | "set" | "clear";

export interface OpenCodeProviderUpdate {
  name: string;
  baseURL?: string | null;
  apiKey?: string;
  clearApiKey?: boolean;
  apiKeyAction?: ApiKeyAction;
}

export interface OpenCodeConfigUpdateRequest {
  expectedRevision: string;
  model?: string;
  providers?: OpenCodeProviderUpdate[];
}

export interface OpenCodeConfigUpdateResponse {
  ok: true;
  revision: string;
  model: string;
  providers: Array<{
    name: string;
    baseURL: string | null;
    hasApiKey: boolean;
    apiKeyMasked: string | null;
  }>;
  saved: {
    modelChanged: boolean;
    providersChanged: string[];
    apiKeyUpdatedFor: string[];
    apiKeyClearedFor: string[];
  };
  warnings: OpenCodeConfigWarning[];
}

export class OpenCodeConfigError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OpenCodeConfigError";
    this.status = status;
    this.code = code;
  }
}

const PROVIDER_NAME_REGEX = /^[a-zA-Z0-9._-]{1,80}$/;
const DEFAULT_PROVIDER_NAME = "openrouter";
const DEFAULT_REVISION = "missing";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeHomeLabel(filePath: string): string {
  const home = os.homedir();
  if (home && filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath.replace(home, "~");
}

export function resolveOpenCodeConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform | string = process.platform): string {
  if (platform === "win32") {
    return chooseOpenCodeConfigPath(env, platform);
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome && path.isAbsolute(xdgConfigHome)) {
    return path.normalize(path.join(xdgConfigHome, "opencode", "opencode.json"));
  }
  return path.normalize(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
}

export function getOpenCodeConfigPathInfo(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform | string = process.platform): { filePath: string; label: string; warnings: OpenCodeConfigWarning[] } {
  const warnings: OpenCodeConfigWarning[] = [];
  const rawXdg = env.XDG_CONFIG_HOME?.trim();
  if (platform !== "win32" && rawXdg && !path.isAbsolute(rawXdg)) {
    warnings.push({ code: "RELATIVE_XDG_CONFIG_HOME_IGNORED", message: "XDG_CONFIG_HOME 不是绝对路径，已使用默认 OpenCode 配置路径。" });
  }
  const filePath = resolveOpenCodeConfigPath(env, platform);
  return { filePath, label: safeHomeLabel(filePath), warnings };
}

export function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 10) return "***";
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`;
}

function sanitizeConfigError(error: unknown): string {
  return sanitizeError(error).replace(os.homedir(), "~");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function computeRevision(filePath: string): Promise<string> {
  try {
    const [stat, content] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    return `${Math.floor(stat.mtimeMs)}:${stat.size}:${hash}`;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return DEFAULT_REVISION;
    throw error;
  }
}

async function readRawConfig(filePath: string): Promise<{ exists: boolean; parseOk: boolean; revision: string; data: JsonObject | null; warnings: OpenCodeConfigWarning[] }> {
  const exists = await fileExists(filePath);
  const revision = await computeRevision(filePath);
  if (!exists) return { exists: false, parseOk: true, revision, data: {}, warnings: [] };

  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return {
        exists: true,
        parseOk: false,
        revision,
        data: null,
        warnings: [{ code: "CONFIG_NOT_OBJECT", message: "OpenCode 配置文件顶层不是 JSON object，无法安全编辑。" }],
      };
    }
    return { exists: true, parseOk: true, revision, data: parsed, warnings: [] };
  } catch {
    return {
      exists: true,
      parseOk: false,
      revision,
      data: null,
      warnings: [{ code: "CONFIG_PARSE_FAILED", message: "OpenCode 配置文件不是有效 JSON，请先打开文件修复。" }],
    };
  }
}

function extractModels(models: unknown): Array<{ key: string; name?: string | null }> {
  if (Array.isArray(models)) {
    const extracted: Array<{ key: string; name?: string | null }> = [];
    models.forEach((entry, index) => {
        if (typeof entry === "string") {
          extracted.push({ key: entry, name: null });
          return;
        }
        if (isRecord(entry)) {
          const key = typeof entry.id === "string" ? entry.id : typeof entry.key === "string" ? entry.key : String(index);
          const name = typeof entry.name === "string" ? entry.name : null;
          extracted.push({ key, name });
        }
      });
    return extracted;
  }
  if (isRecord(models)) {
    return Object.entries(models).map(([key, value]) => ({
      key,
      name: isRecord(value) && typeof value.name === "string" ? value.name : null,
    }));
  }
  return [];
}

function providerDisplays(data: JsonObject): OpenCodeProviderDisplay[] {
  const providerRoot = data.provider;
  if (!isRecord(providerRoot) || Object.keys(providerRoot).length === 0) {
    return [{
      name: DEFAULT_PROVIDER_NAME,
      baseURL: null,
      hasApiKey: false,
      apiKeyMasked: null,
      models: [],
      editable: true,
      source: "default-openrouter",
    }];
  }

  return Object.entries(providerRoot).map(([name, value]) => {
    const provider = isRecord(value) ? value : {};
    const options = isRecord(provider.options) ? provider.options : {};
    const apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : null;
    return {
      name,
      baseURL: typeof options.baseURL === "string" ? options.baseURL : null,
      hasApiKey: !!apiKey,
      apiKeyMasked: apiKey ? maskApiKey(apiKey) : null,
      models: extractModels(provider.models),
      editable: PROVIDER_NAME_REGEX.test(name) && isRecord(value) && (!provider.options || isRecord(provider.options)),
      source: "existing",
    };
  });
}

export async function readOpenCodeConfigDisplay(runtime: OpenCodeRuntime): Promise<OpenCodeConfigDisplayResponse> {
  const pathInfo = getOpenCodeConfigPathInfo();
  const raw = await readRawConfig(pathInfo.filePath);
  const warnings = [...pathInfo.warnings, ...raw.warnings];
  const model = raw.data && typeof raw.data.model === "string" ? raw.data.model : "";

  return {
    ok: true,
    exists: raw.exists,
    parseOk: raw.parseOk,
    revision: raw.revision,
    configPathLabel: pathInfo.label,
    copyableConfigPath: runtime === "local" ? pathInfo.filePath : null,
    model,
    providers: raw.parseOk && raw.data ? providerDisplays(raw.data) : [],
    warnings,
  };
}

function assertValidModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) throw new OpenCodeConfigError(400, "INVALID_MODEL", "model 不能为空。");
  if (trimmed.length > 512) throw new OpenCodeConfigError(400, "INVALID_MODEL", "model 长度不能超过 512 个字符。");
  if (/[\r\n\u0000]/.test(trimmed)) throw new OpenCodeConfigError(400, "INVALID_MODEL", "model 包含非法控制字符。");
  return trimmed;
}

function assertValidProviderName(name: string): string {
  const trimmed = name.trim();
  if (!PROVIDER_NAME_REGEX.test(trimmed)) throw new OpenCodeConfigError(400, "INVALID_PROVIDER_NAME", "provider name 只能包含字母、数字、点、下划线和连字符，长度 1-80。");
  return trimmed;
}

function normalizeBaseURL(input: string | null, nodeEnv: string | undefined): string | null {
  if (input === null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OpenCodeConfigError(400, "INVALID_BASE_URL", "baseURL 必须是有效 URL。");
  }
  const isHttps = parsed.protocol === "https:";
  const isDevLoopback = nodeEnv === "development" && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!isHttps && !isDevLoopback) {
    throw new OpenCodeConfigError(400, "INVALID_BASE_URL", "baseURL 只允许 https；开发模式下仅允许 http loopback。 ");
  }
  return parsed.toString().replace(/\/$/, "");
}

function resolveApiKeyAction(update: OpenCodeProviderUpdate): ApiKeyAction {
  if (update.clearApiKey === true) {
    if (update.apiKey !== undefined || update.apiKeyAction === "set") {
      throw new OpenCodeConfigError(400, "INVALID_API_KEY_ACTION", "apiKey set 与 clear 不能同时出现。");
    }
    return "clear";
  }
  if (update.apiKeyAction) return update.apiKeyAction;
  return update.apiKey !== undefined ? "set" : "keep";
}

function ensureProvider(data: JsonObject, name: string): JsonObject {
  if (data.provider === undefined) data.provider = {};
  if (!isRecord(data.provider)) throw new OpenCodeConfigError(409, "UNSAFE_PROVIDER_STRUCTURE", "provider 不是 object，无法安全写入。");
  const providers = data.provider;
  const existing = providers[name];
  if (existing === undefined) {
    if (name !== DEFAULT_PROVIDER_NAME || Object.keys(providers).length > 0) {
      throw new OpenCodeConfigError(409, "PROVIDER_NOT_EDITABLE", "P0 仅允许编辑已有 provider，或在空配置中创建 openrouter provider。");
    }
    providers[name] = { options: {} };
  }
  if (!isRecord(providers[name])) throw new OpenCodeConfigError(409, "UNSAFE_PROVIDER_STRUCTURE", "目标 provider 不是 object，无法安全写入。");
  const provider = providers[name] as JsonObject;
  if (provider.options === undefined) provider.options = {};
  if (!isRecord(provider.options)) throw new OpenCodeConfigError(409, "UNSAFE_OPTIONS_STRUCTURE", "provider options 不是 object，无法安全写入。");
  return provider;
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const tmpPath = path.join(directory, `.opencode.json.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw new OpenCodeConfigError(500, "WRITE_FAILED", `写入 OpenCode 配置失败：${sanitizeConfigError(error)}`);
  }
}

export async function updateOpenCodeConfig(input: OpenCodeConfigUpdateRequest, env: NodeJS.ProcessEnv = process.env): Promise<OpenCodeConfigUpdateResponse> {
  const pathInfo = getOpenCodeConfigPathInfo(env);
  const before = await readRawConfig(pathInfo.filePath);
  if (!before.parseOk || !before.data) {
    throw new OpenCodeConfigError(409, "CONFIG_PARSE_FAILED", "OpenCode 配置文件解析失败，拒绝覆盖。请先打开文件修复。 ");
  }
  if (before.revision !== input.expectedRevision) {
    throw new OpenCodeConfigError(409, "REVISION_CONFLICT", "OpenCode 配置文件已被外部修改，请重新加载后再保存。 ");
  }

  const data = structuredClone(before.data) as JsonObject;
  const saved = {
    modelChanged: false,
    providersChanged: [] as string[],
    apiKeyUpdatedFor: [] as string[],
    apiKeyClearedFor: [] as string[],
  };

  if (input.model !== undefined) {
    const nextModel = assertValidModel(input.model);
    saved.modelChanged = data.model !== nextModel;
    data.model = nextModel;
  }

  for (const providerUpdate of input.providers ?? []) {
    const name = assertValidProviderName(providerUpdate.name);
    const provider = ensureProvider(data, name);
    const options = provider.options as JsonObject;
    let changed = false;

    if (providerUpdate.baseURL !== undefined) {
      const nextBaseURL = normalizeBaseURL(providerUpdate.baseURL, env.NODE_ENV);
      if (nextBaseURL === null) {
        if ("baseURL" in options) changed = true;
        delete options.baseURL;
      } else if (options.baseURL !== nextBaseURL) {
        options.baseURL = nextBaseURL;
        changed = true;
      }
    }

    const action = resolveApiKeyAction(providerUpdate);
    if (action === "set") {
      const apiKey = providerUpdate.apiKey?.trim() ?? "";
      if (!apiKey) throw new OpenCodeConfigError(400, "INVALID_API_KEY", "apiKeyAction=set 时 apiKey 不能为空。");
      options.apiKey = apiKey;
      saved.apiKeyUpdatedFor.push(name);
      changed = true;
    } else if (action === "clear") {
      if ("apiKey" in options) changed = true;
      delete options.apiKey;
      saved.apiKeyClearedFor.push(name);
    } else if (providerUpdate.apiKey !== undefined) {
      throw new OpenCodeConfigError(400, "INVALID_API_KEY_ACTION", "apiKeyAction=keep 时不能同时提供 apiKey。");
    }

    if (changed && !saved.providersChanged.includes(name)) saved.providersChanged.push(name);
  }

  const latestRevision = await computeRevision(pathInfo.filePath);
  if (latestRevision !== input.expectedRevision) {
    throw new OpenCodeConfigError(409, "REVISION_CONFLICT", "OpenCode 配置文件已被外部修改，请重新加载后再保存。 ");
  }

  await atomicWriteJson(pathInfo.filePath, data);
  const afterRevision = await computeRevision(pathInfo.filePath);
  const displayProviders = providerDisplays(data).map((provider) => ({
    name: provider.name,
    baseURL: provider.baseURL,
    hasApiKey: provider.hasApiKey,
    apiKeyMasked: provider.apiKeyMasked,
  }));

  return {
    ok: true,
    revision: afterRevision,
    model: typeof data.model === "string" ? data.model : "",
    providers: displayProviders,
    saved,
    warnings: pathInfo.warnings.map((warning) => ({ code: warning.code, message: sanitizeString(warning.message) })),
  };
}
