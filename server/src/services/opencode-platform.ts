import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type PlatformLike = NodeJS.Platform | string;

export type PackageManagerName = "npm" | "pnpm" | "bun" | "corepack";
export type OpenCodeInstallMethod = "npm" | "chocolatey" | "scoop" | "path" | "unknown";
export type OpenCodePathState = "system-path" | "augmented-path" | "not-found";

export interface ResolvedExecutable {
  command: string;
  resolved: boolean;
}

export interface OpenCodeProcessContext {
  file: string;
  argsPrefix: string[];
  env: Record<string, string | undefined>;
  resolved: boolean;
  executionMode: "plain" | "native-executable" | "windows-node-shim" | "windows-cmd-shim-probe";
  shimPath?: string;
  restrictedToReadOnlyProbe?: boolean;
}

export interface ResolvedNpmCommand {
  command: string;
  argsPrefix: string[];
  env: Record<string, string | undefined>;
  resolution: "plain" | "node-npm-cli" | "node-package-cli" | "native-executable";
  packageManager?: PackageManagerName;
}

export type ResolvedPackageManagerCommand = ResolvedNpmCommand;

export interface OpenCodePathDiagnostics {
  pathState: OpenCodePathState;
  installMethod: OpenCodeInstallMethod | null;
  executablePath: string | null;
  effectivePathCandidates: string[];
  resolutionError: string | null;
  runResolutionError: string | null;
  probeExecutionMode: OpenCodeProcessContext["executionMode"] | null;
}

const execFileAsync = promisify(execFile);
let npmPrefixRunner: (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }> =
  execFileAsync as unknown as (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
const npmGlobalPrefixCache = new Map<string, string | null>();

export function _setNpmGlobalPrefixRunnerForTests(runner: typeof npmPrefixRunner): void {
  npmPrefixRunner = runner;
  npmGlobalPrefixCache.clear();
}

export function _resetOpenCodePlatformCachesForTests(): void {
  npmPrefixRunner = execFileAsync as unknown as typeof npmPrefixRunner;
  npmGlobalPrefixCache.clear();
}

function isWindows(platform: PlatformLike): boolean {
  return platform === "win32";
}

function pathDelimiterFor(platform: PlatformLike): string {
  return isWindows(platform) ? ";" : path.delimiter;
}

function isDriveAbsolute(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(filePath);
}

function isAbsoluteForPlatform(filePath: string, platform: PlatformLike): boolean {
  if (isWindows(platform)) {
    return isDriveAbsolute(filePath) || path.win32.isAbsolute(filePath) || path.posix.isAbsolute(filePath);
  }
  return path.isAbsolute(filePath);
}

function usesWinSeparators(filePath: string): boolean {
  return isDriveAbsolute(filePath) || filePath.includes("\\");
}

function joinForBase(base: string, ...segments: string[]): string {
  return usesWinSeparators(base) ? path.win32.join(base, ...segments) : path.join(base, ...segments);
}

function dirnameFor(filePath: string): string {
  return usesWinSeparators(filePath) ? path.win32.dirname(filePath) : path.dirname(filePath);
}

function basenameFor(filePath: string): string {
  return usesWinSeparators(filePath) ? path.win32.basename(filePath) : path.basename(filePath);
}

function extnameFor(filePath: string): string {
  return usesWinSeparators(filePath) ? path.win32.extname(filePath) : path.extname(filePath);
}

function isWindowsCommandShim(filePath: string): boolean {
  const ext = extnameFor(filePath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function normalizeForBase(filePath: string): string {
  return usesWinSeparators(filePath) ? path.win32.normalize(filePath) : path.normalize(filePath);
}

function hasPathSeparator(input: string): boolean {
  return input.includes("/") || input.includes("\\");
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isSafeShimDerivedPath(filePath: string, platform: PlatformLike): boolean {
  return !!filePath && !/[\0\r\n]/.test(filePath) && isAbsoluteForPlatform(filePath, platform);
}

function isSafeNodeScriptTarget(filePath: string, platform: PlatformLike): boolean {
  if (!isSafeShimDerivedPath(filePath, platform) || !fileExists(filePath)) return false;
  const ext = extnameFor(filePath).toLowerCase();
  return ext !== ".cmd" && ext !== ".bat" && ext !== ".exe" && ext !== ".com";
}

function isSafeNativeNodeExecutable(filePath: string | undefined, platform: PlatformLike): boolean {
  if (!filePath) return false;
  const normalized = normalizeForBase(filePath);
  if (!isSafeShimDerivedPath(normalized, platform) || !fileExists(normalized)) return false;
  const base = basenameFor(normalized).toLowerCase();
  return base === "node.exe" || base === "node";
}

function trailingSeparatorForBase(base: string): string {
  if (base.endsWith("/") || base.endsWith("\\")) return "";
  return usesWinSeparators(base) ? "\\" : path.sep;
}

function expandNpmShimPathVariables(input: string, shimPath: string): string {
  const shimDir = dirnameFor(shimPath);
  const dp0 = `${shimDir}${trailingSeparatorForBase(shimDir)}`;
  return input
    .replace(/%~dp0[\\/]?/gi, dp0)
    .replace(/%dp0%[\\/]?/gi, dp0)
    .replace(/\$basedir[\\/]?/gi, dp0);
}

function pushShimPathCandidate(candidates: string[], rawCandidate: string, shimPath: string, platform: PlatformLike): void {
  const cleaned = rawCandidate.trim();
  if (!cleaned) return;
  const remainingVariables = cleaned.replace(/%~dp0|%dp0%|\$basedir/gi, "");
  if (/[%!][a-z_][a-z0-9_]*[%!]?/i.test(remainingVariables)) return;
  const expanded = normalizeForBase(expandNpmShimPathVariables(cleaned, shimPath));
  if (isSafeShimDerivedPath(expanded, platform)) candidates.push(expanded);
}

function extractQuotedPathCandidatesFromShim(shimContent: string, shimPath: string, platform: PlatformLike): string[] {
  const candidates: string[] = [];
  const quotedPathPattern = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = quotedPathPattern.exec(shimContent)) !== null) {
    const raw = match[1];
    const assignmentValue = raw.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/)?.[1] ?? raw;
    pushShimPathCandidate(candidates, assignmentValue, shimPath, platform);
  }
  return candidates;
}

function extractSetAssignmentPathCandidatesFromShim(shimContent: string, shimPath: string, platform: PlatformLike): string[] {
  const candidates: string[] = [];
  const setAssignmentPattern = /\bSET\s+"?[A-Za-z_][A-Za-z0-9_]*=([^"\r\n]+)"?/gi;
  let match: RegExpExecArray | null;
  while ((match = setAssignmentPattern.exec(shimContent)) !== null) {
    pushShimPathCandidate(candidates, match[1], shimPath, platform);
  }
  return candidates;
}

function extractUnquotedPathCandidatesFromShim(shimContent: string, shimPath: string, platform: PlatformLike): string[] {
  const candidates: string[] = [];
  const unquotedPathPattern = /((?:%~dp0|%dp0%|\$basedir)[^\s"'()<>|&]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = unquotedPathPattern.exec(shimContent)) !== null) {
    pushShimPathCandidate(candidates, match[1], shimPath, platform);
  }
  return candidates;
}

function extractNodeScriptCandidatesFromShim(shimPath: string, platform: PlatformLike): string[] {
  const shimContent = readTextFile(shimPath);
  if (!shimContent) return [];

  const candidates: string[] = [];
  const rawCandidates = [
    ...extractQuotedPathCandidatesFromShim(shimContent, shimPath, platform),
    ...extractSetAssignmentPathCandidatesFromShim(shimContent, shimPath, platform),
    ...extractUnquotedPathCandidatesFromShim(shimContent, shimPath, platform),
  ];

  for (const expanded of rawCandidates) {
    const base = basenameFor(expanded).toLowerCase();
    if (base === "node.exe" || base === "node") continue;
    if (isSafeNodeScriptTarget(expanded, platform)) candidates.push(expanded);
  }

  return Array.from(new Set(candidates));
}

function extractNodeExecutableCandidatesFromShim(shimPath: string, platform: PlatformLike): string[] {
  const shimContent = readTextFile(shimPath);
  if (!shimContent) return [];
  const rawCandidates = [
    ...extractQuotedPathCandidatesFromShim(shimContent, shimPath, platform),
    ...extractSetAssignmentPathCandidatesFromShim(shimContent, shimPath, platform),
    ...extractUnquotedPathCandidatesFromShim(shimContent, shimPath, platform),
  ];
  return Array.from(new Set(rawCandidates.filter((candidate) => {
    const base = basenameFor(candidate).toLowerCase();
    return base === "node.exe" || base === "node";
  })));
}

function parsePackageJsonBinCandidates(packageDir: string, platform: PlatformLike): string[] {
  const packageJsonPath = joinForBase(packageDir, "package.json");
  const raw = readTextFile(packageJsonPath);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as { bin?: unknown };
    const bin = parsed.bin;
    const values: string[] = [];
    if (typeof bin === "string") {
      values.push(bin);
    } else if (bin && typeof bin === "object") {
      const record = bin as Record<string, unknown>;
      const preferred = record.opencode ?? record["opencode-ai"] ?? record.openCode;
      if (typeof preferred === "string") values.push(preferred);
      for (const value of Object.values(record)) {
        if (typeof value === "string") values.push(value);
      }
    }

    return values
      .map((value) => normalizeForBase(isAbsoluteForPlatform(value, platform) ? value : joinForBase(packageDir, value)))
      .filter((candidate, index, array) => array.indexOf(candidate) === index);
  } catch {
    return [];
  }
}

function opencodePackageDirectoriesFromShim(shimPath: string): string[] {
  const shimDir = dirnameFor(shimPath);
  const parentDir = dirnameFor(shimDir);
  const packageNames = [
    ["opencode-ai"],
    ["@opencode-ai", "opencode"],
    ["opencode"],
  ];
  const packageRoots = [
    joinForBase(shimDir, "node_modules"),
    joinForBase(parentDir, "node_modules"),
    parentDir,
  ];

  const candidates: string[] = [];
  for (const root of packageRoots) {
    for (const packageName of packageNames) {
      candidates.push(joinForBase(root, ...packageName));
    }
  }
  return Array.from(new Set(candidates.map(normalizeForBase)));
}

function fixedOpenCodeBinCandidates(packageDir: string): string[] {
  return [
    joinForBase(packageDir, "bin", "opencode"),
    joinForBase(packageDir, "bin", "opencode.js"),
    joinForBase(packageDir, "dist", "index.js"),
    joinForBase(packageDir, "index.js"),
  ];
}

function resolveOpenCodeNodeShimTarget(shimPath: string, platform: PlatformLike): string | null {
  const candidates = [
    ...extractNodeScriptCandidatesFromShim(shimPath, platform),
    ...opencodePackageDirectoriesFromShim(shimPath).flatMap((packageDir) => [
      ...parsePackageJsonBinCandidates(packageDir, platform),
      ...fixedOpenCodeBinCandidates(packageDir),
    ]),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeForBase(candidate);
    if (isSafeNodeScriptTarget(normalized, platform)) return normalized;
  }
  return null;
}

function getPathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function splitPathList(value: string | undefined, platform: PlatformLike): string[] {
  if (!value) return [];
  return value.split(pathDelimiterFor(platform)).map((entry) => entry.trim()).filter(Boolean);
}

function withPathValue(env: Record<string, string | undefined>, value: string, platform: PlatformLike): Record<string, string | undefined> {
  const next = { ...env };
  const pathKey = getPathKey(next);
  if (isWindows(platform)) {
    for (const key of Object.keys(next)) {
      if (key.toLowerCase() === "path" && key !== pathKey) delete next[key];
    }
  }
  next[pathKey] = value;
  return next;
}

function appendUniquePathEntries(basePath: string | undefined, additions: string[], platform: PlatformLike): string {
  const delimiter = pathDelimiterFor(platform);
  const entries = splitPathList(basePath, platform);
  const seen = new Set(entries.map((entry) => isWindows(platform) ? entry.toLowerCase() : entry));
  for (const addition of additions) {
    if (!addition) continue;
    const normalized = normalizeForBase(addition);
    const key = isWindows(platform) ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    entries.push(normalized);
    seen.add(key);
  }
  return entries.join(delimiter);
}

export function getWindowsNpmGlobalPathCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const candidates: string[] = [];
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  const programData = env.ProgramData?.trim() || env.PROGRAMDATA?.trim();
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim();
  const programFilesX86 = env["ProgramFiles(x86)"]?.trim() || env["PROGRAMFILES(X86)"]?.trim();
  const programW6432 = env.ProgramW6432?.trim() || env.PROGRAMW6432?.trim();
  const chocolateyInstall = env.ChocolateyInstall?.trim() || env.CHOCOLATEYINSTALL?.trim();
  const scoop = env.SCOOP?.trim();
  if (appData) candidates.push(joinForBase(appData, "npm"));
  if (localAppData) candidates.push(joinForBase(localAppData, "npm"));
  if (localAppData) candidates.push(joinForBase(localAppData, "Programs", "nodejs"));
  for (const root of [programFiles, programFilesX86, programW6432]) {
    if (root) candidates.push(joinForBase(root, "nodejs"));
  }
  if (home) {
    candidates.push(joinForBase(home, ".npm-global", "bin"));
    candidates.push(joinForBase(home, "scoop", "shims"));
  }
  if (scoop) candidates.push(joinForBase(scoop, "shims"));
  if (programData) candidates.push(joinForBase(programData, "chocolatey", "bin"));
  if (chocolateyInstall) candidates.push(joinForBase(chocolateyInstall, "bin"));
  return Array.from(new Set(candidates.map(normalizeForBase)));
}

function dynamicPrefixPathCandidates(prefix: string, platform: PlatformLike): string[] {
  const normalized = normalizeForBase(prefix.trim());
  if (!normalized || !isAbsoluteForPlatform(normalized, platform)) return [];
  if (!isWindows(platform)) return [joinForBase(normalized, "bin")];
  return [normalized, joinForBase(normalized, "bin")];
}

function npmPrefixCacheKey(safeEnv: Record<string, string | undefined>, platform: PlatformLike): string {
  const pathKey = getPathKey(safeEnv);
  return [platform, safeEnv[pathKey] ?? "", safeEnv.npm_execpath ?? "", safeEnv.APPDATA ?? "", safeEnv.LOCALAPPDATA ?? ""].join("\0");
}

export async function getNpmGlobalPrefix(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
): Promise<string | null> {
  const cacheKey = npmPrefixCacheKey(safeEnv, platform);
  if (npmGlobalPrefixCache.has(cacheKey)) return npmGlobalPrefixCache.get(cacheKey) ?? null;

  try {
    const npmCommand = resolveNpmCommand(safeEnv, platform);
    if (!npmCommand) {
      npmGlobalPrefixCache.set(cacheKey, null);
      return null;
    }
    const { stdout } = await npmPrefixRunner(npmCommand.command, [...npmCommand.argsPrefix, "prefix", "-g"], {
      timeout: 10_000,
      windowsHide: true,
      shell: false,
      env: npmCommand.env,
    });
    const prefix = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
    const valid = prefix && isAbsoluteForPlatform(prefix, platform) && !/[\0\r\n]/.test(prefix) ? normalizeForBase(prefix) : null;
    npmGlobalPrefixCache.set(cacheKey, valid);
    return valid;
  } catch {
    npmGlobalPrefixCache.set(cacheKey, null);
    return null;
  }
}

export function buildOpenCodeChildEnv(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
): Record<string, string | undefined> {
  if (!isWindows(platform)) return { ...safeEnv };
  const pathKey = getPathKey(safeEnv);
  const nextPath = appendUniquePathEntries(safeEnv[pathKey], getWindowsNpmGlobalPathCandidates(safeEnv), platform);
  return withPathValue(safeEnv, nextPath, platform);
}

export async function buildOpenCodeChildEnvAsync(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
): Promise<Record<string, string | undefined>> {
  if (!isWindows(platform)) return { ...safeEnv };
  const pathKey = getPathKey(safeEnv);
  const prefix = await getNpmGlobalPrefix(safeEnv, platform);
  const additions = [
    ...getWindowsNpmGlobalPathCandidates(safeEnv),
    ...(prefix ? dynamicPrefixPathCandidates(prefix, platform) : []),
  ];
  const nextPath = appendUniquePathEntries(safeEnv[pathKey], additions, platform);
  return withPathValue(safeEnv, nextPath, platform);
}

function getWindowsExecutableExtensions(env: Record<string, string | undefined>): string[] {
  const defaults = [".exe", ".cmd", ".bat", ".com"];
  const fromEnv = (env.PATHEXT || "")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const ordered = fromEnv.length > 0 ? [...fromEnv, ...defaults] : defaults;
  return Array.from(new Set(ordered));
}

function candidateCommandNames(command: string, env: Record<string, string | undefined>, platform: PlatformLike): string[] {
  if (!isWindows(platform)) return [command];
  if (extnameFor(command)) return [command];
  return [...getWindowsExecutableExtensions(env).map((ext) => `${command}${ext}`), command];
}

export function resolveExecutableOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env,
  platform: PlatformLike = process.platform,
): ResolvedExecutable {
  const names = candidateCommandNames(command, env, platform);

  if (hasPathSeparator(command) || isAbsoluteForPlatform(command, platform)) {
    for (const name of names) {
      if (fileExists(name)) return { command: normalizeForBase(name), resolved: true };
    }
    return { command, resolved: false };
  }

  const pathKey = getPathKey(env);
  for (const directory of splitPathList(env[pathKey], platform)) {
    for (const name of names) {
      const candidate = joinForBase(directory, name);
      if (fileExists(candidate)) return { command: normalizeForBase(candidate), resolved: true };
    }
  }

  return { command, resolved: false };
}

function resolveNativeNodeOnPath(env: Record<string, string | undefined>, platform: PlatformLike): string | null {
  const pathKey = getPathKey(env);
  const names = isWindows(platform) ? ["node.exe", "node"] : ["node"];
  for (const directory of splitPathList(env[pathKey], platform)) {
    for (const name of names) {
      const candidate = normalizeForBase(joinForBase(directory, name));
      if (isSafeNativeNodeExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function resolveSafeNodeExecutableForShim(
  shimPath: string,
  env: Record<string, string | undefined>,
  platform: PlatformLike,
  preferredNodeExecPath?: string,
): string | null {
  const shimDir = dirnameFor(shimPath);
  const pathNode = resolveNativeNodeOnPath(env, platform);
  const candidates = [
    joinForBase(shimDir, "node.exe"),
    ...extractNodeExecutableCandidatesFromShim(shimPath, platform),
    ...(pathNode ? [pathNode] : []),
    preferredNodeExecPath ?? "",
  ];

  for (const candidate of Array.from(new Set(candidates.map((value) => value ? normalizeForBase(value) : value)))) {
    if (isSafeNativeNodeExecutable(candidate, platform)) return candidate;
  }
  return null;
}

function isSafeWindowsCommandInterpreter(filePath: string | undefined, platform: PlatformLike): boolean {
  if (!isWindows(platform) || !filePath) return false;
  const normalized = normalizeForBase(filePath);
  if (!isSafeShimDerivedPath(normalized, platform) || !fileExists(normalized)) return false;
  return basenameFor(normalized).toLowerCase() === "cmd.exe";
}

function resolveWindowsCommandInterpreterForProbe(
  env: Record<string, string | undefined>,
  platform: PlatformLike,
): string | null {
  if (!isWindows(platform)) return null;
  const comspec = env.ComSpec?.trim() || env.COMSPEC?.trim() || process.env.ComSpec?.trim() || process.env.COMSPEC?.trim();
  const candidates = [
    comspec ?? "",
    resolveExecutableOnPath("cmd.exe", env, platform).command,
    resolveExecutableOnPath("cmd", env, platform).command,
  ];
  for (const candidate of Array.from(new Set(candidates.map((value) => value ? normalizeForBase(value) : value)))) {
    if (isSafeWindowsCommandInterpreter(candidate, platform)) return candidate;
  }
  return null;
}

function isSafeWindowsShimProbeToken(token: string): boolean {
  return !!token && !/[\0\r\n"%!]/.test(token);
}

function quoteWindowsShimProbeToken(token: string): string {
  if (!isSafeWindowsShimProbeToken(token)) {
    throw new Error("Unsafe Windows command-shim probe token");
  }
  return `"${token}"`;
}

function buildRestrictedWindowsShimProbeCommand(shimPath: string, probeArgs: readonly string[]): string {
  const allowedProbeArgs = new Set(["--version", "providers", "auth", "list"]);
  for (const arg of probeArgs) {
    if (!allowedProbeArgs.has(arg) || !isSafeWindowsShimProbeToken(arg)) {
      throw new Error("Unsafe Windows command-shim probe arguments");
    }
  }
  return `"${[shimPath, ...probeArgs].map(quoteWindowsShimProbeToken).join(" ")}"`;
}

function resolveWindowsCommandShimProbeContext(
  env: Record<string, string | undefined>,
  platform: PlatformLike,
): OpenCodeProcessContext | null {
  if (!isWindows(platform)) return null;
  const resolved = resolveExecutableOnPath("opencode", env, platform);
  if (!resolved.resolved || !isWindowsCommandShim(resolved.command)) return null;
  const shimPath = normalizeForBase(resolved.command);
  if (!isSafeShimDerivedPath(shimPath, platform) || !fileExists(shimPath) || !isSafeWindowsShimProbeToken(shimPath)) return null;
  const commandInterpreter = resolveWindowsCommandInterpreterForProbe(env, platform);
  if (!commandInterpreter) return null;
  return {
    file: commandInterpreter,
    argsPrefix: [],
    env,
    resolved: true,
    executionMode: "windows-cmd-shim-probe",
    shimPath,
    restrictedToReadOnlyProbe: true,
  };
}

export function appendReadOnlyProbeArgs(
  context: OpenCodeProcessContext,
  probeArgs: readonly string[],
): string[] {
  if (context.executionMode !== "windows-cmd-shim-probe") return [...context.argsPrefix, ...probeArgs];
  if (!context.shimPath) throw new Error("Windows command-shim probe context is missing shimPath");
  return ["/d", "/s", "/c", buildRestrictedWindowsShimProbeCommand(context.shimPath, probeArgs)];
}

export function resolveOpenCodeProcessContext(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
  nodeExecPath: string = process.execPath,
): OpenCodeProcessContext {
  const env = buildOpenCodeChildEnv(safeEnv, platform);
  if (!isWindows(platform)) {
    return { file: "opencode", argsPrefix: [], env, resolved: false, executionMode: "plain" };
  }
  const resolved = resolveExecutableOnPath("opencode", env, platform);
  if (resolved.resolved && isWindowsCommandShim(resolved.command)) {
    const scriptTarget = resolveOpenCodeNodeShimTarget(resolved.command, platform);
    if (!scriptTarget) {
      throw new Error(
        `Unable to resolve safe native OpenCode target from Windows command shim at ${resolved.command}; refusing to execute .cmd/.bat through cmd.exe /c`,
      );
    }
    const nodeCommand = resolveSafeNodeExecutableForShim(resolved.command, env, platform, nodeExecPath);
    if (!nodeCommand) {
      throw new Error(
        `Unable to resolve safe Node executable for OpenCode Windows command shim at ${resolved.command}; refusing to execute .cmd/.bat through cmd.exe /c`,
      );
    }
    return {
      file: nodeCommand,
      argsPrefix: [scriptTarget],
      env,
      resolved: true,
      executionMode: "windows-node-shim",
      shimPath: resolved.command,
    };
  }
  return {
    file: resolved.command,
    argsPrefix: [],
    env,
    resolved: resolved.resolved,
    executionMode: resolved.resolved ? "native-executable" : "plain",
  };
}

export async function resolveOpenCodeProcessContextAsync(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
  nodeExecPath: string = process.execPath,
): Promise<OpenCodeProcessContext> {
  const env = await buildOpenCodeChildEnvAsync(safeEnv, platform);
  if (!isWindows(platform)) {
    return { file: "opencode", argsPrefix: [], env, resolved: false, executionMode: "plain" };
  }
  const resolved = resolveExecutableOnPath("opencode", env, platform);
  if (resolved.resolved && isWindowsCommandShim(resolved.command)) {
    const scriptTarget = resolveOpenCodeNodeShimTarget(resolved.command, platform);
    if (!scriptTarget) {
      throw new Error(
        `Unable to resolve safe native OpenCode target from Windows command shim at ${resolved.command}; refusing to execute .cmd/.bat through cmd.exe /c`,
      );
    }
    const nodeCommand = resolveSafeNodeExecutableForShim(resolved.command, env, platform, nodeExecPath);
    if (!nodeCommand) {
      throw new Error(
        `Unable to resolve safe Node executable for OpenCode Windows command shim at ${resolved.command}; refusing to execute .cmd/.bat through cmd.exe /c`,
      );
    }
    return {
      file: nodeCommand,
      argsPrefix: [scriptTarget],
      env,
      resolved: true,
      executionMode: "windows-node-shim",
      shimPath: resolved.command,
    };
  }
  return {
    file: resolved.command,
    argsPrefix: [],
    env,
    resolved: resolved.resolved,
    executionMode: resolved.resolved ? "native-executable" : "plain",
  };
}

export async function resolveOpenCodeProbeContextAsync(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
  nodeExecPath: string = process.execPath,
): Promise<OpenCodeProcessContext> {
  try {
    return await resolveOpenCodeProcessContextAsync(safeEnv, platform, nodeExecPath);
  } catch (strictError) {
    const env = await buildOpenCodeChildEnvAsync(safeEnv, platform);
    const probeContext = resolveWindowsCommandShimProbeContext(env, platform);
    if (probeContext) return probeContext;
    throw strictError;
  }
}

function isSafeNpmCliPath(filePath: string, platform: PlatformLike): boolean {
  const base = basenameFor(filePath).toLowerCase();
  return isAbsoluteForPlatform(filePath, platform) && (base === "npm-cli.js" || base === "cli.js") && fileExists(filePath);
}

function npmCliCandidatesFromResolvedNpm(npmCommand: string): string[] {
  const npmDir = dirnameFor(npmCommand);
  return [
    joinForBase(npmDir, "node_modules", "npm", "bin", "npm-cli.js"),
    joinForBase(dirnameFor(npmDir), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

function packageManagerCliBaseNames(manager: PackageManagerName): string[] {
  if (manager === "npm") return ["npm-cli.js", "cli.js"];
  if (manager === "pnpm") return ["pnpm.cjs", "pnpm.js", "pnpm-cli.js"];
  if (manager === "corepack") return ["corepack.js"];
  return ["bun.js", "cli.js"];
}

function packageManagerPackageNames(manager: PackageManagerName): string[] {
  if (manager === "npm") return ["npm"];
  if (manager === "pnpm") return ["pnpm"];
  if (manager === "corepack") return ["corepack"];
  return ["bun"];
}

function fixedPackageManagerCliCandidates(packageDir: string, manager: PackageManagerName): string[] {
  if (manager === "npm") return [joinForBase(packageDir, "bin", "npm-cli.js")];
  if (manager === "pnpm") return [
    joinForBase(packageDir, "bin", "pnpm.cjs"),
    joinForBase(packageDir, "pnpm.cjs"),
    joinForBase(packageDir, "dist", "pnpm.cjs"),
  ];
  if (manager === "corepack") return [
    joinForBase(packageDir, "dist", "corepack.js"),
    joinForBase(packageDir, "corepack.js"),
  ];
  return [
    joinForBase(packageDir, "bin", "bun.js"),
    joinForBase(packageDir, "bun.js"),
  ];
}

function packageManagerCliCandidatesFromResolvedCommand(commandPath: string, manager: PackageManagerName, nodeExecPath: string): string[] {
  const commandDir = dirnameFor(commandPath);
  const nodeDir = dirnameFor(nodeExecPath);
  const roots = [
    commandDir,
    dirnameFor(commandDir),
    nodeDir,
    dirnameFor(nodeDir),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const packageName of packageManagerPackageNames(manager)) {
      const packageDirs = [
        joinForBase(root, "node_modules", packageName),
        joinForBase(root, packageName),
      ];
      for (const packageDir of packageDirs) candidates.push(...fixedPackageManagerCliCandidates(packageDir, manager));
    }
  }
  return candidates;
}

function extractPackageManagerScriptCandidatesFromShim(shimPath: string, manager: PackageManagerName, platform: PlatformLike): string[] {
  const shimContent = readTextFile(shimPath);
  if (!shimContent) return [];
  const allowedBaseNames = new Set(packageManagerCliBaseNames(manager));
  const candidates: string[] = [];
  const quotedPathPattern = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = quotedPathPattern.exec(shimContent)) !== null) {
    const expanded = normalizeForBase(expandNpmShimPathVariables(match[1], shimPath));
    if (allowedBaseNames.has(basenameFor(expanded).toLowerCase()) && isSafeNodeScriptTarget(expanded, platform)) {
      candidates.push(expanded);
    }
  }
  return Array.from(new Set(candidates));
}

function isSafePackageManagerCliPath(filePath: string, manager: PackageManagerName, platform: PlatformLike): boolean {
  const base = basenameFor(filePath).toLowerCase();
  return packageManagerCliBaseNames(manager).includes(base) && isSafeNodeScriptTarget(filePath, platform);
}

export function resolvePackageManagerCommand(
  manager: PackageManagerName,
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
  nodeExecPath: string = process.execPath,
): ResolvedPackageManagerCommand | null {
  const env = buildOpenCodeChildEnv(safeEnv, platform);

  if (!isWindows(platform)) {
    return { command: manager, argsPrefix: [], env, resolution: "plain", packageManager: manager };
  }

  const resolvedCommand = resolveExecutableOnPath(manager, env, platform);
  const directCliCandidates = manager === "npm" && safeEnv.npm_execpath?.trim() ? [safeEnv.npm_execpath.trim()] : [];
  const cliCandidates = [
    ...directCliCandidates,
    ...extractPackageManagerScriptCandidatesFromShim(resolvedCommand.command, manager, platform),
    ...packageManagerCliCandidatesFromResolvedCommand(resolvedCommand.command, manager, nodeExecPath),
  ];

  for (const candidate of cliCandidates) {
    if (isSafePackageManagerCliPath(candidate, manager, platform)) {
      const nodeCommand = resolveSafeNodeExecutableForShim(resolvedCommand.command, env, platform, nodeExecPath);
      if (!nodeCommand) return null;
      const resolution = manager === "npm" ? "node-npm-cli" : "node-package-cli";
      return { command: nodeCommand, argsPrefix: [normalizeForBase(candidate)], env, resolution, packageManager: manager };
    }
  }

  if (resolvedCommand.resolved) {
    const ext = extnameFor(resolvedCommand.command).toLowerCase();
    if (manager === "bun" && ext === ".exe") {
      return { command: resolvedCommand.command, argsPrefix: [], env, resolution: "native-executable", packageManager: manager };
    }
    if (ext !== ".cmd" && ext !== ".bat") {
      return { command: resolvedCommand.command, argsPrefix: [], env, resolution: "native-executable", packageManager: manager };
    }
  }

  return null;
}

export function resolveNpmCommand(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
  nodeExecPath: string = process.execPath,
): ResolvedNpmCommand | null {
  return resolvePackageManagerCommand("npm", safeEnv, platform, nodeExecPath);
}

function normalizePathForDetection(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function homeDirCandidate(env: Record<string, string | undefined>, platform: PlatformLike): string | null {
  const rawHome = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  if (!rawHome || !isAbsoluteForPlatform(rawHome, platform)) return null;
  return normalizeForBase(rawHome);
}

function pushAbsoluteCandidate(candidates: string[], candidate: string | undefined, platform: PlatformLike): void {
  const trimmed = candidate?.trim();
  if (!trimmed || !isAbsoluteForPlatform(trimmed, platform) || /[\0\r\n]/.test(trimmed)) return;
  candidates.push(normalizeForBase(trimmed));
}

export function detectInstallMethod(executablePath: string | null | undefined): OpenCodeInstallMethod | null {
  if (!executablePath) return null;
  const normalized = normalizePathForDetection(executablePath);
  if (
    normalized.includes("/node_modules/") ||
    normalized.includes("/appdata/roaming/npm/") ||
    normalized.includes("/appdata/local/npm/") ||
    normalized.includes("/.npm-global/bin/") ||
    normalized.endsWith("/.npm-global/bin/opencode") ||
    normalized.endsWith("/.npm-global/bin/opencode.cmd")
  ) {
    return "npm";
  }
  if (normalized.includes("/programdata/chocolatey/") || normalized.includes("/chocolatey/bin/")) {
    return "chocolatey";
  }
  if (normalized.includes("/scoop/apps/") || normalized.includes("/scoop/shims/")) {
    return "scoop";
  }
  return "path";
}

export function getEffectiveOpenCodePathCandidates(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
  npmGlobalPrefix?: string | null,
): string[] {
  if (!isWindows(platform)) return [];
  return Array.from(new Set([
    ...getWindowsNpmGlobalPathCandidates(safeEnv),
    ...(npmGlobalPrefix ? dynamicPrefixPathCandidates(npmGlobalPrefix, platform) : []),
  ].map(normalizeForBase)));
}

export async function getOpenCodePathDiagnostics(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
): Promise<OpenCodePathDiagnostics> {
  const systemResolved = resolveExecutableOnPath("opencode", safeEnv, platform);
  const prefix = isWindows(platform) ? await getNpmGlobalPrefix(safeEnv, platform) : null;
  const effectivePathCandidates = getEffectiveOpenCodePathCandidates(safeEnv, platform, prefix);
  let resolutionError: string | null = null;
  let runResolutionError: string | null = null;

  try {
    const context = await resolveOpenCodeProbeContextAsync(safeEnv, platform);
    try {
      await resolveOpenCodeProcessContextAsync(safeEnv, platform);
    } catch (error) {
      runResolutionError = error instanceof Error ? error.message : String(error);
    }
    const executablePath = context.shimPath ?? (context.resolved ? context.file : null);
    const pathState: OpenCodePathState = systemResolved.resolved
      ? "system-path"
      : context.resolved
        ? "augmented-path"
        : "not-found";
    return {
      pathState,
      installMethod: detectInstallMethod(executablePath),
      executablePath,
      effectivePathCandidates,
      resolutionError,
      runResolutionError,
      probeExecutionMode: context.executionMode,
    };
  } catch (error) {
    resolutionError = error instanceof Error ? error.message : String(error);
    const executablePath = systemResolved.resolved ? systemResolved.command : null;
    return {
      pathState: systemResolved.resolved ? "system-path" : "not-found",
      installMethod: detectInstallMethod(executablePath),
      executablePath,
      effectivePathCandidates,
      resolutionError,
      runResolutionError: null,
      probeExecutionMode: null,
    };
  }
}

export function getOpenCodeConfigPathCandidates(
  env: Record<string, string | undefined> = process.env,
  platform: PlatformLike = process.platform,
): string[] {
  const candidates: string[] = [];
  pushAbsoluteCandidate(candidates, env.OPENCODE_CONFIG, platform);

  if (isWindows(platform)) {
    const home = homeDirCandidate(env, platform);
    if (home) candidates.push(joinForBase(home, ".config", "opencode", "opencode.json"));

    const appData = env.APPDATA?.trim();
    const localAppData = env.LOCALAPPDATA?.trim();
    if (appData && isAbsoluteForPlatform(appData, platform)) candidates.push(joinForBase(appData, "opencode", "opencode.json"));
    if (localAppData && isAbsoluteForPlatform(localAppData, platform)) candidates.push(joinForBase(localAppData, "opencode", "opencode.json"));
    return Array.from(new Set(candidates.map(normalizeForBase)));
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome && isAbsoluteForPlatform(xdgConfigHome, platform)) {
    candidates.push(path.normalize(path.join(xdgConfigHome, "opencode", "opencode.json")));
  }
  const home = homeDirCandidate(env, platform);
  if (home) candidates.push(path.normalize(path.join(home, ".config", "opencode", "opencode.json")));
  return Array.from(new Set(candidates));
}

export function getOpenCodeAuthPathCandidates(
  env: Record<string, string | undefined> = process.env,
  platform: PlatformLike = process.platform,
): string[] {
  const candidates: string[] = [];
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome && isAbsoluteForPlatform(xdgDataHome, platform)) {
    candidates.push(joinForBase(xdgDataHome, "opencode", "auth.json"));
  }

  const home = homeDirCandidate(env, platform);
  if (home) candidates.push(joinForBase(home, ".local", "share", "opencode", "auth.json"));

  if (isWindows(platform)) {
    const localAppData = env.LOCALAPPDATA?.trim();
    const appData = env.APPDATA?.trim();
    if (localAppData && isAbsoluteForPlatform(localAppData, platform)) candidates.push(joinForBase(localAppData, "opencode", "auth.json"));
    if (appData && isAbsoluteForPlatform(appData, platform)) candidates.push(joinForBase(appData, "opencode", "auth.json"));
  }

  return Array.from(new Set(candidates.map(normalizeForBase)));
}

export function chooseOpenCodeConfigPath(
  env: Record<string, string | undefined> = process.env,
  platform: PlatformLike = process.platform,
): string {
  const explicitConfig = env.OPENCODE_CONFIG?.trim();
  if (explicitConfig && isAbsoluteForPlatform(explicitConfig, platform) && !/[\0\r\n]/.test(explicitConfig)) {
    return normalizeForBase(explicitConfig);
  }
  const candidates = getOpenCodeConfigPathCandidates(env, platform);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
