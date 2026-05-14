import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import {
  buildSafeChildEnv,
  checkOpenCodeAvailability,
  invalidateAvailabilityCache,
  sanitizeString,
  type OpenCodeAvailability,
} from "./opencode-runner.js";

export const OPENCODE_INSTALL_PACKAGE = "opencode-ai@latest" as const;
export const OPENCODE_INSTALL_COMMAND_PREVIEW = "npm install -g opencode-ai@latest" as const;
export const OPENCODE_INSTALL_CONFIRMATION_PHRASE = "INSTALL_OPENCODE" as const;
export const OPENCODE_INSTALL_ARGS = ["install", "-g", OPENCODE_INSTALL_PACKAGE] as const;
const INSTALL_TIMEOUT_MS = 30_000;
const INSTALL_OUTPUT_LIMIT_BYTES = 32 * 1024;
const INSTALL_TAIL_CHARS = 4_000;
const NONCE_TTL_MS = 5 * 60_000;

export interface NpmAvailability {
  available: boolean;
  version: string | null;
}

export interface OpenCodeInstallPlanResponse {
  ok: true;
  controlledInstallAvailable: boolean;
  packageName: typeof OPENCODE_INSTALL_PACKAGE;
  commandPreview: typeof OPENCODE_INSTALL_COMMAND_PREVIEW;
  confirmationPhrase: typeof OPENCODE_INSTALL_CONFIRMATION_PHRASE;
  nonce: string;
  nonceExpiresAt: string;
  npm: NpmAvailability;
  warnings: string[];
}

export interface ControlledInstallRequest {
  nonce: string;
  confirmationPhrase: typeof OPENCODE_INSTALL_CONFIRMATION_PHRASE;
  confirm: true;
}

export interface ControlledInstallResponse {
  ok: boolean;
  durationMs: number;
  commandPreview: typeof OPENCODE_INSTALL_COMMAND_PREVIEW;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  availabilityAfterInstall: OpenCodeAvailability | null;
  error: string | null;
}

export class OpenCodeInstallError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OpenCodeInstallError";
    this.status = status;
    this.code = code;
  }
}

const execFileAsync = promisify(execFile);
let execRunner: (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }> =
  execFileAsync as unknown as (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;

export type InstallProcessRunner = (file: string, args: readonly string[], options: Record<string, unknown>) => Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}>;

let installProcessRunner: InstallProcessRunner = defaultInstallProcessRunner;
let availabilityChecker: () => Promise<OpenCodeAvailability> = checkOpenCodeAvailability;
let installInProgress = false;
const nonces = new Map<string, number>();

export function _setNpmCheckRunner(runner: typeof execRunner): void {
  execRunner = runner;
}

export function _setInstallProcessRunner(runner: InstallProcessRunner): void {
  installProcessRunner = runner;
}

export function _setPostInstallAvailabilityChecker(runner: () => Promise<OpenCodeAvailability>): void {
  availabilityChecker = runner;
}

export function _resetInstallServiceForTests(): void {
  execRunner = execFileAsync as unknown as typeof execRunner;
  installProcessRunner = defaultInstallProcessRunner;
  availabilityChecker = checkOpenCodeAvailability;
  installInProgress = false;
  nonces.clear();
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf8") <= INSTALL_OUTPUT_LIMIT_BYTES) return next;
  return next.slice(-INSTALL_OUTPUT_LIMIT_BYTES);
}

function tail(input: string): string {
  return sanitizeString(input).slice(-INSTALL_TAIL_CHARS);
}

function defaultInstallProcessRunner(file: string, args: readonly string[], options: Record<string, unknown>): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: options.env as NodeJS.ProcessEnv,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = typeof options.timeout === "number" ? options.timeout : INSTALL_TIMEOUT_MS;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_500);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, timedOut, stdout, stderr });
    });
  });
}

export async function checkNpmAvailability(): Promise<NpmAvailability> {
  try {
    const { stdout } = await execRunner("npm", ["--version"], {
      timeout: 3_000,
      windowsHide: true,
      env: buildSafeChildEnv(),
    });
    return { available: true, version: stdout.trim() || null };
  } catch {
    return { available: false, version: null };
  }
}

export async function createOpenCodeInstallPlan(): Promise<OpenCodeInstallPlanResponse> {
  const npm = await checkNpmAvailability();
  const nonce = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, expiresAt);
  return {
    ok: true,
    controlledInstallAvailable: npm.available,
    packageName: OPENCODE_INSTALL_PACKAGE,
    commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
    confirmationPhrase: OPENCODE_INSTALL_CONFIRMATION_PHRASE,
    nonce,
    nonceExpiresAt: new Date(expiresAt).toISOString(),
    npm,
    warnings: npm.available ? [] : ["npm 不可用，无法执行应用内受控安装。"],
  };
}

function consumeNonce(nonce: string): void {
  const expiresAt = nonces.get(nonce);
  nonces.delete(nonce);
  if (!expiresAt || Date.now() > expiresAt) {
    throw new OpenCodeInstallError(400, "INVALID_NONCE", "安装确认已过期，请重新生成安装计划。");
  }
}

export async function installOpenCodeControlled(input: ControlledInstallRequest): Promise<ControlledInstallResponse> {
  if (input.confirm !== true || input.confirmationPhrase !== OPENCODE_INSTALL_CONFIRMATION_PHRASE) {
    throw new OpenCodeInstallError(400, "CONFIRMATION_REQUIRED", "必须确认固定安装命令后才能执行安装。");
  }
  consumeNonce(input.nonce);

  if (installInProgress) {
    throw new OpenCodeInstallError(409, "INSTALL_IN_PROGRESS", "已有 OpenCode 安装任务正在执行。");
  }

  installInProgress = true;
  const startedAt = Date.now();
  try {
    const result = await installProcessRunner("npm", OPENCODE_INSTALL_ARGS, {
      shell: false,
      timeout: INSTALL_TIMEOUT_MS,
      env: buildSafeChildEnv(),
    });
    invalidateAvailabilityCache();
    const availabilityAfterInstall = await availabilityChecker();
    const error = result.exitCode === 0 && !result.timedOut
      ? null
      : result.timedOut
        ? "OpenCode 安装命令超时。"
        : `OpenCode 安装命令退出码 ${result.exitCode ?? "unknown"}。`;

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      durationMs: Date.now() - startedAt,
      commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      availabilityAfterInstall,
      error,
    };
  } catch (error) {
    invalidateAvailabilityCache();
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
      exitCode: null,
      timedOut: /timeout|timed out/i.test(error instanceof Error ? error.message : String(error)),
      stdoutTail: "",
      stderrTail: "",
      availabilityAfterInstall: null,
      error: sanitizeString(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    installInProgress = false;
  }
}
