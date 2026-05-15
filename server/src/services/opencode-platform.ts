import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type PlatformLike = NodeJS.Platform | string;

export interface ResolvedExecutable {
  command: string;
  resolved: boolean;
}

export interface OpenCodeProcessContext {
  file: string;
  argsPrefix: string[];
  env: Record<string, string | undefined>;
  resolved: boolean;
  executionMode: "plain" | "native-executable" | "windows-node-shim";
  shimPath?: string;
}

export interface ResolvedNpmCommand {
  command: string;
  argsPrefix: string[];
  env: Record<string, string | undefined>;
  resolution: "plain" | "node-npm-cli" | "native-executable";
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

function extractNodeScriptCandidatesFromShim(shimPath: string, platform: PlatformLike): string[] {
  const shimContent = readTextFile(shimPath);
  if (!shimContent) return [];

  const candidates: string[] = [];
  const quotedPathPattern = /"([^"]*(?:node_modules|bin)[^"]*(?:opencode|open-code)[^"]*)"/gi;
  let match: RegExpExecArray | null;
  while ((match = quotedPathPattern.exec(shimContent)) !== null) {
    const expanded = normalizeForBase(expandNpmShimPathVariables(match[1], shimPath));
    const base = basenameFor(expanded).toLowerCase();
    if (base === "node.exe" || base === "node") continue;
    if (isSafeNodeScriptTarget(expanded, platform)) candidates.push(expanded);
  }

  return Array.from(new Set(candidates));
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
  if (appData) candidates.push(joinForBase(appData, "npm"));
  if (localAppData) candidates.push(joinForBase(localAppData, "npm"));
  return candidates;
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

function getWindowsExecutableExtensions(env: Record<string, string | undefined>): string[] {
  const defaults = [".exe", ".cmd", ".bat", ".com"];
  const fromEnv = (env.PATHEXT || "")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const ordered = [...defaults, ...fromEnv];
  return Array.from(new Set(ordered));
}

function candidateCommandNames(command: string, env: Record<string, string | undefined>, platform: PlatformLike): string[] {
  if (!isWindows(platform)) return [command];
  if (extnameFor(command)) return [command];
  return [command, ...getWindowsExecutableExtensions(env).map((ext) => `${command}${ext}`)];
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
    return {
      file: nodeExecPath,
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

export function resolveNpmCommand(
  safeEnv: Record<string, string | undefined>,
  platform: PlatformLike = process.platform,
  nodeExecPath: string = process.execPath,
): ResolvedNpmCommand | null {
  const env = buildOpenCodeChildEnv(safeEnv, platform);

  if (!isWindows(platform)) {
    return { command: "npm", argsPrefix: [], env, resolution: "plain" };
  }

  const npmExecPath = safeEnv.npm_execpath?.trim();
  const cliCandidates = [
    ...(npmExecPath ? [npmExecPath] : []),
    joinForBase(dirnameFor(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  const resolvedNpm = resolveExecutableOnPath("npm", env, platform);
  if (resolvedNpm.resolved) cliCandidates.push(...npmCliCandidatesFromResolvedNpm(resolvedNpm.command));

  for (const candidate of cliCandidates) {
    if (isSafeNpmCliPath(candidate, platform)) {
      return { command: nodeExecPath, argsPrefix: [normalizeForBase(candidate)], env, resolution: "node-npm-cli" };
    }
  }

  if (resolvedNpm.resolved) {
    const ext = extnameFor(resolvedNpm.command).toLowerCase();
    if (ext !== ".cmd" && ext !== ".bat") {
      return { command: resolvedNpm.command, argsPrefix: [], env, resolution: "native-executable" };
    }
  }

  return null;
}

export function getOpenCodeConfigPathCandidates(
  env: Record<string, string | undefined> = process.env,
  platform: PlatformLike = process.platform,
): string[] {
  if (isWindows(platform)) {
    const candidates: string[] = [];
    const appData = env.APPDATA?.trim();
    const localAppData = env.LOCALAPPDATA?.trim();
    if (appData && isAbsoluteForPlatform(appData, platform)) candidates.push(joinForBase(appData, "opencode", "opencode.json"));
    if (localAppData && isAbsoluteForPlatform(localAppData, platform)) candidates.push(joinForBase(localAppData, "opencode", "opencode.json"));
    const home = os.homedir();
    if (home) candidates.push(joinForBase(home, "AppData", "Roaming", "opencode", "opencode.json"));
    return Array.from(new Set(candidates.map(normalizeForBase)));
  }

  const candidates: string[] = [];
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome && isAbsoluteForPlatform(xdgConfigHome, platform)) {
    candidates.push(path.normalize(path.join(xdgConfigHome, "opencode", "opencode.json")));
  }
  candidates.push(path.normalize(path.join(os.homedir(), ".config", "opencode", "opencode.json")));
  return Array.from(new Set(candidates));
}

export function chooseOpenCodeConfigPath(
  env: Record<string, string | undefined> = process.env,
  platform: PlatformLike = process.platform,
): string {
  const candidates = getOpenCodeConfigPathCandidates(env, platform);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
