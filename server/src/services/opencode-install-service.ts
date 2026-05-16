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
import { resolvePackageManagerCommand, type PackageManagerName } from "./opencode-platform.js";

export const OPENCODE_INSTALL_PACKAGE = "opencode-ai@latest" as const;
export const OPENCODE_INSTALL_COMMAND_PREVIEW = "npm install -g opencode-ai@latest" as const;
export const OPENCODE_INSTALL_CONFIRMATION_PHRASE = "INSTALL_OPENCODE" as const;
export const OPENCODE_INSTALL_ARGS = ["install", "-g", OPENCODE_INSTALL_PACKAGE] as const;
export const OPENCODE_PNPM_INSTALL_ARGS = ["add", "-g", OPENCODE_INSTALL_PACKAGE] as const;
export const OPENCODE_BUN_INSTALL_ARGS = ["add", "-g", OPENCODE_INSTALL_PACKAGE] as const;
export const OPENCODE_COREPACK_ENABLE_PNPM_ARGS = ["enable", "pnpm"] as const;
export const OPENCODE_VERSION_QUERY_ARGS = ["view", "opencode-ai", "version"] as const;
const INSTALL_TIMEOUT_MS = 30_000;
const INSTALL_OUTPUT_LIMIT_BYTES = 32 * 1024;
const INSTALL_TAIL_CHARS = 4_000;
const NONCE_TTL_MS = 5 * 60_000;

export interface NpmAvailability {
  available: boolean;
  version: string | null;
}

export type PackageManagerAvailability = NpmAvailability & {
  resolution: string | null;
};

export type PackageManagersAvailability = Record<PackageManagerName, PackageManagerAvailability>;

export interface OpenCodeInstallAttempt {
  packageManager: PackageManagerName;
  commandPreview: string;
  resolved: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
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
  packageManagers: PackageManagersAvailability;
  installCandidates: string[];
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
  packageManager: PackageManagerName | null;
  attempts: OpenCodeInstallAttempt[];
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

function commandPreview(packageManager: PackageManagerName, args: readonly string[]): string {
  return [packageManager, ...args].join(" ");
}

function emptyPackageManagersAvailability(): PackageManagersAvailability {
  return {
    npm: { available: false, version: null, resolution: null },
    pnpm: { available: false, version: null, resolution: null },
    bun: { available: false, version: null, resolution: null },
    corepack: { available: false, version: null, resolution: null },
  };
}

function isOpenCodeCliInstalled(availability: OpenCodeAvailability): boolean {
  return availability.available || availability.cliAvailable === true;
}

function installArgsFor(packageManager: PackageManagerName): readonly string[] {
  if (packageManager === "npm") return OPENCODE_INSTALL_ARGS;
  if (packageManager === "pnpm") return OPENCODE_PNPM_INSTALL_ARGS;
  if (packageManager === "bun") return OPENCODE_BUN_INSTALL_ARGS;
  return OPENCODE_COREPACK_ENABLE_PNPM_ARGS;
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
    const npmCommand = resolvePackageManagerCommand("npm", buildSafeChildEnv());
    if (!npmCommand) return { available: false, version: null };
    const { stdout } = await execRunner(npmCommand.command, [...npmCommand.argsPrefix, "--version"], {
      timeout: 3_000,
      windowsHide: true,
      env: npmCommand.env,
    });
    return { available: true, version: stdout.trim() || null };
  } catch {
    return { available: false, version: null };
  }
}

export async function checkPackageManagersAvailability(): Promise<PackageManagersAvailability> {
  const safeEnv = buildSafeChildEnv();
  const result = emptyPackageManagersAvailability();
  await Promise.all((Object.keys(result) as PackageManagerName[]).map(async (packageManager) => {
    try {
      const command = resolvePackageManagerCommand(packageManager, safeEnv);
      if (!command) return;
      const { stdout } = await execRunner(command.command, [...command.argsPrefix, "--version"], {
        timeout: 3_000,
        windowsHide: true,
        shell: false,
        env: command.env,
      });
      result[packageManager] = {
        available: true,
        version: stdout.trim().split(/\r?\n/)[0]?.trim() || null,
        resolution: command.resolution,
      };
    } catch {
      result[packageManager] = { available: false, version: null, resolution: null };
    }
  }));
  return result;
}

export async function getLatestOpenCodeVersion(): Promise<string | null> {
  const safeEnv = buildSafeChildEnv();
  for (const packageManager of ["npm", "pnpm"] as PackageManagerName[]) {
    try {
      const command = resolvePackageManagerCommand(packageManager, safeEnv);
      if (!command) continue;
      const { stdout } = await execRunner(command.command, [...command.argsPrefix, ...OPENCODE_VERSION_QUERY_ARGS], {
        timeout: 10_000,
        windowsHide: true,
        shell: false,
        env: command.env,
      });
      const version = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return version;
    } catch {
      continue;
    }
  }
  return null;
}

export async function createOpenCodeInstallPlan(): Promise<OpenCodeInstallPlanResponse> {
  const currentAvailability = await availabilityChecker();
  if (isOpenCodeCliInstalled(currentAvailability)) {
    const nonce = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + NONCE_TTL_MS;
    nonces.set(nonce, expiresAt);
    const packageManagers = emptyPackageManagersAvailability();
    return {
      ok: true,
      controlledInstallAvailable: false,
      packageName: OPENCODE_INSTALL_PACKAGE,
      commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
      confirmationPhrase: OPENCODE_INSTALL_CONFIRMATION_PHRASE,
      nonce,
      nonceExpiresAt: new Date(expiresAt).toISOString(),
      npm: packageManagers.npm,
      packageManagers,
      installCandidates: [],
      warnings: ["OpenCode CLI 已安装且可执行，无需重新安装。"],
    };
  }

  const packageManagers = await checkPackageManagersAvailability();
  const npm = packageManagers.npm;
  const installCandidates = (["npm", "pnpm", "bun"] as PackageManagerName[])
    .filter((packageManager) => packageManagers[packageManager].available)
    .map((packageManager) => commandPreview(packageManager, installArgsFor(packageManager)));
  const nonce = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, expiresAt);
  return {
    ok: true,
    controlledInstallAvailable: installCandidates.length > 0,
    packageName: OPENCODE_INSTALL_PACKAGE,
    commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
    confirmationPhrase: OPENCODE_INSTALL_CONFIRMATION_PHRASE,
    nonce,
    nonceExpiresAt: new Date(expiresAt).toISOString(),
    npm,
    packageManagers,
    installCandidates,
    warnings: installCandidates.length > 0 ? [] : ["npm/pnpm/bun 均不可用，无法执行应用内受控安装。"],
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
  const startedAt = Date.now();

  const currentAvailability = await availabilityChecker();
  if (isOpenCodeCliInstalled(currentAvailability)) {
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
      exitCode: 0,
      timedOut: false,
      stdoutTail: "",
      stderrTail: "",
      availabilityAfterInstall: currentAvailability,
      packageManager: null,
      attempts: [],
      error: null,
    };
  }

  if (installInProgress) {
    throw new OpenCodeInstallError(409, "INSTALL_IN_PROGRESS", "已有 OpenCode 安装任务正在执行。");
  }

  installInProgress = true;
  const attempts: OpenCodeInstallAttempt[] = [];

  const recordAttempt = (attempt: OpenCodeInstallAttempt) => {
    attempts.push(attempt);
  };

  const runPackageManagerInstall = async (packageManager: PackageManagerName): Promise<ControlledInstallResponse | null> => {
    const args = installArgsFor(packageManager);
    const preview = commandPreview(packageManager, args);
    const command = resolvePackageManagerCommand(packageManager, buildSafeChildEnv());
    if (!command) {
      recordAttempt({
        packageManager,
        commandPreview: preview,
        resolved: false,
        exitCode: null,
        timedOut: false,
        stdoutTail: "",
        stderrTail: "",
        error: `${packageManager} 可执行入口不可用，已跳过。`,
      });
      return null;
    }

    try {
      const result = await installProcessRunner(command.command, [...command.argsPrefix, ...args], {
        shell: false,
        timeout: INSTALL_TIMEOUT_MS,
        env: command.env,
      });
      invalidateAvailabilityCache();
      const availabilityAfterInstall = result.exitCode === 0 && !result.timedOut ? await availabilityChecker() : null;
      const ok = result.exitCode === 0 && !result.timedOut && !!availabilityAfterInstall?.available;
      const error = ok
        ? null
        : result.timedOut
          ? `${packageManager} 安装命令超时。`
          : result.exitCode !== 0
            ? `${packageManager} 安装命令退出码 ${result.exitCode ?? "unknown"}。`
            : "安装命令完成，但 OpenCode 安装后验证未通过。";
      const attempt: OpenCodeInstallAttempt = {
        packageManager,
        commandPreview: preview,
        resolved: true,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
        error,
      };
      recordAttempt(attempt);
      if (!ok) return null;
      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutTail: attempt.stdoutTail,
        stderrTail: attempt.stderrTail,
        availabilityAfterInstall,
        packageManager,
        attempts,
        error: null,
      };
    } catch (error) {
      invalidateAvailabilityCache();
      recordAttempt({
        packageManager,
        commandPreview: preview,
        resolved: true,
        exitCode: null,
        timedOut: /timeout|timed out/i.test(error instanceof Error ? error.message : String(error)),
        stdoutTail: "",
        stderrTail: "",
        error: sanitizeString(error instanceof Error ? error.message : String(error)),
      });
      return null;
    }
  };

  const runCorepackEnablePnpm = async (): Promise<void> => {
    const command = resolvePackageManagerCommand("corepack", buildSafeChildEnv());
    const preview = commandPreview("corepack", OPENCODE_COREPACK_ENABLE_PNPM_ARGS);
    if (!command) {
      recordAttempt({ packageManager: "corepack", commandPreview: preview, resolved: false, exitCode: null, timedOut: false, stdoutTail: "", stderrTail: "", error: "corepack 不可用，跳过 pnpm 启用步骤。" });
      return;
    }
    try {
      const result = await installProcessRunner(command.command, [...command.argsPrefix, ...OPENCODE_COREPACK_ENABLE_PNPM_ARGS], {
        shell: false,
        timeout: INSTALL_TIMEOUT_MS,
        env: command.env,
      });
      recordAttempt({
        packageManager: "corepack",
        commandPreview: preview,
        resolved: true,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
        error: result.exitCode === 0 && !result.timedOut ? null : `corepack enable pnpm 未成功，退出码 ${result.exitCode ?? "unknown"}。`,
      });
    } catch (error) {
      recordAttempt({ packageManager: "corepack", commandPreview: preview, resolved: true, exitCode: null, timedOut: /timeout|timed out/i.test(error instanceof Error ? error.message : String(error)), stdoutTail: "", stderrTail: "", error: sanitizeString(error instanceof Error ? error.message : String(error)) });
    }
  };

  try {
    const npmResult = await runPackageManagerInstall("npm");
    if (npmResult) return npmResult;

    if (!resolvePackageManagerCommand("pnpm", buildSafeChildEnv())) {
      await runCorepackEnablePnpm();
    }
    const pnpmResult = await runPackageManagerInstall("pnpm");
    if (pnpmResult) return pnpmResult;

    const bunResult = await runPackageManagerInstall("bun");
    if (bunResult) return bunResult;

    const lastExitAttempt = [...attempts].reverse().find((attempt) => attempt.exitCode !== null);
    const lastStdoutAttempt = [...attempts].reverse().find((attempt) => attempt.stdoutTail);
    const lastStderrAttempt = [...attempts].reverse().find((attempt) => attempt.stderrTail);
    const error = `OpenCode 受控安装失败，已尝试 ${attempts.length} 个步骤：${attempts.map((attempt) => `${attempt.commandPreview}: ${attempt.error ?? "未通过验证"}${attempt.stderrTail ? `; stderr=${attempt.stderrTail}` : ""}`).join(" | ")}`;
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      commandPreview: OPENCODE_INSTALL_COMMAND_PREVIEW,
      exitCode: lastExitAttempt?.exitCode ?? null,
      timedOut: attempts.some((attempt) => attempt.timedOut),
      stdoutTail: lastStdoutAttempt?.stdoutTail ?? "",
      stderrTail: lastStderrAttempt?.stderrTail ?? "",
      availabilityAfterInstall: null,
      packageManager: null,
      attempts,
      error: sanitizeString(error),
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
      packageManager: null,
      attempts,
      error: sanitizeString(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    installInProgress = false;
  }
}
