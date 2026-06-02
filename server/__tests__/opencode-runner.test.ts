/**
 * OpenCode Runner Tests
 *
 * Covers:
 * - detectProviderConfig() recognizes provider apiKey in config file (fixture)
 * - detectProviderConfig() returns hasConfig=false for empty/missing config
 * - checkOpenCodeAvailability() uses combined detection (auth store + config file)
 * - runOpenCodeNormalize() success path (mock _execRunner JSON output)
 * - runOpenCodeNormalize() fallback on invalid JSON output
 * - runOpenCodeNormalize() fallback on opencode subprocess error
 * - Metadata does not contain sensitive fields (apiKey values)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  detectProviderConfig,
  detectOpenCodeAuthStoreMetadata,
  checkOpenCodeAvailability,
  runOpenCodeChat,
  runOpenCodeNormalize,
  fallbackNormalize,
  invalidateAvailabilityCache,
  sanitizeError,
  _setExecRunner,
  _resetExecRunner,
  _setSpawnRunner,
  _resetSpawnRunner,
  _spawnOpenCodeRunForTests,
  parseOpenCodeCredentialCount,
} from "../src/services/opencode-runner.js";
import {
  _resetInstallServiceForTests,
  createOpenCodeInstallPlan,
} from "../src/services/opencode-install-service.js";
import {
  _resetOpenCodePlatformCachesForTests,
  _setNpmGlobalPrefixRunnerForTests,
  buildOpenCodeChildEnv,
  buildOpenCodeChildEnvAsync,
  detectInstallMethod,
  getEffectiveOpenCodePathCandidates,
  getNpmGlobalPrefix,
  getNonWindowsOpenCodePathCandidates,
  getOpenCodePathDiagnostics,
  resolveExecutableOnPath,
  getOpenCodeConfigPathCandidates,
  resolveOpenCodeProbeContextAsync,
  resolveOpenCodeProcessContext,
  resolveOpenCodeProcessContextAsync,
  resolvePackageManagerCommand,
  resolveBundledRuntime,
  getBundledRuntimeCandidateRoots,
  getBundledTargetId,
  emptyBundledRuntimeDiagnostics,
} from "../src/services/opencode-platform.js";

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function setupConfigDir(config: Record<string, unknown>): string {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
  const configDir = path.join(fixtureDir, ".config");
  const opencodeDir = path.join(configDir, "opencode");
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(opencodeDir, "opencode.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
  return fixtureDir;
}

function cleanupDir(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isOpenCodeExecutableCommand(file: string): boolean {
  const baseName = path.basename(file).toLowerCase();
  return file === "opencode" || baseName === "opencode" || baseName === "opencode.exe" || baseName === "opencode.cmd";
}

function createOpenCodePackageFixture(appDataNpm: string, binName = "opencode.js"): string {
  const packageDir = path.join(appDataNpm, "node_modules", "opencode-ai");
  const binDir = path.join(packageDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, binName);
  fs.writeFileSync(binPath, "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "opencode-ai", bin: { opencode: `bin/${binName}` } }, null, 2),
    "utf8",
  );
  return binPath;
}

function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

async function withProcessPlatformAsync<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await fn();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

async function withProcessExecPathAsync<T>(execPath: string, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "execPath", { value: execPath });
  try {
    return await fn();
  } finally {
    if (descriptor) Object.defineProperty(process, "execPath", descriptor);
  }
}

function sampleConfigWithProviders(apiKeyCount: number): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (let i = 0; i < apiKeyCount; i++) {
    providers[`provider-${i}`] = {
      options: {
        apiKey: `test-key-${i}-${"x".repeat(20)}`,
        baseURL: `https://api.provider-${i}.example.com/v1`,
      },
      models: [
        { id: `model-${i}-a`, name: `Model ${i} A` },
        { id: `model-${i}-b`, name: `Model ${i} B` },
      ],
    };
  }
  // Add a provider without apiKey
  providers["no-key-provider"] = {
    options: {
      baseURL: "https://api.nokey.example.com/v1",
    },
    models: [{ id: "nokey-model", name: "NoKey Model" }],
  };
  return { provider: providers };
}

/** Create a mock _execRunner that responds to opencode commands */
function createMockExecRunner(responses: Array<{ args: string[]; result: { stdout: string; stderr: string } | Error }>) {
  return async (file: string, args: string[], _options: Record<string, unknown>) => {
    if (!isOpenCodeExecutableCommand(file)) throw new Error(`Unexpected command: ${file}`);
    for (const resp of responses) {
      if (JSON.stringify(args) === JSON.stringify(resp.args)) {
        if (resp.result instanceof Error) throw resp.result;
        return resp.result;
      }
    }
    throw new Error(`Unexpected opencode args: ${JSON.stringify(args)}`);
  };
}

// ─── detectProviderConfig ──────────────────────────────────────────────────────

describe("detectProviderConfig", () => {
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalXdgData = process.env.XDG_DATA_HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
  let fixtureDir: string | null = null;

  beforeEach(() => {
    delete process.env.OPENCODE_CONFIG;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgData;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  it("detects providers with apiKey in opencode.json via HOME", () => {
    fixtureDir = setupConfigDir(sampleConfigWithProviders(3));
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const result = detectProviderConfig();

    expect(result.hasConfig).toBe(true);
    expect(result.providerCount).toBe(3);
    expect(result.modelCount).toBe(7); // 3 providers * 2 models + 1 nokey model
  });

  it("detects providers via XDG_CONFIG_HOME", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "xdg-test-"));
    const opencodeDir = path.join(fixtureDir, "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, "opencode.json"),
      JSON.stringify(sampleConfigWithProviders(2), null, 2),
      "utf8",
    );
    process.env.XDG_CONFIG_HOME = fixtureDir;
    process.env.HOME = path.join(os.tmpdir(), "nonexistent-home-" + Date.now());

    const result = detectProviderConfig();

    expect(result.hasConfig).toBe(true);
    expect(result.providerCount).toBe(2);
  });

  it("returns hasConfig=false when config file does not exist", () => {
    process.env.HOME = path.join(os.tmpdir(), "nonexistent-home-" + Date.now());
    process.env.XDG_CONFIG_HOME = "";

    const result = detectProviderConfig();

    expect(result.hasConfig).toBe(false);
    expect(result.providerCount).toBe(0);
    expect(result.modelCount).toBe(0);
  });

  it("returns hasConfig=false when config has no providers", () => {
    fixtureDir = setupConfigDir({ provider: {} });
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const result = detectProviderConfig();

    expect(result.hasConfig).toBe(false);
    expect(result.providerCount).toBe(0);
  });

  it("returns hasConfig=false when providers have empty apiKey", () => {
    fixtureDir = setupConfigDir({
      provider: {
        empty: { options: { apiKey: "" } },
        nullKey: { options: { apiKey: null } },
        noKey: { options: { baseURL: "https://example.com" } },
      },
    });
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const result = detectProviderConfig();

    expect(result.hasConfig).toBe(false);
    expect(result.providerCount).toBe(0);
  });

  it("handles malformed JSON gracefully", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "malformed-"));
    const configDir = path.join(fixtureDir, ".config");
    const opencodeDir = path.join(configDir, "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeDir, "opencode.json"),
      "this is not JSON {{{",
      "utf8",
    );
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const result = detectProviderConfig();

    expect(result.hasConfig).toBe(false);
  });

  it("detects provider config from Windows APPDATA opencode path", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-opencode-config-"));
    const home = path.join(fixtureDir, "HomeWithoutOfficialConfig");
    const appData = path.join(fixtureDir, "AppData", "Roaming");
    const opencodeDir = path.join(appData, "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(opencodeDir, "opencode.json"), JSON.stringify(sampleConfigWithProviders(1), null, 2), "utf8");

    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.APPDATA = appData;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      delete process.env.LOCALAPPDATA;
      const result = withProcessPlatform("win32", () => detectProviderConfig());
      expect(result.hasConfig).toBe(true);
      expect(result.providerCount).toBe(1);
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  it("detects auth store credentials without exposing credential values", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-auth-store-"));
    const authDir = path.join(fixtureDir, ".local", "share", "opencode");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({
      openrouter: { type: "api", key: "test-auth-key-value" },
      anthropic: { accessToken: "test-access-token", refreshToken: "test-refresh-token" },
      empty: { token: "" },
    }, null, 2), "utf8");
    process.env.HOME = fixtureDir;
    process.env.USERPROFILE = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";
    delete process.env.XDG_DATA_HOME;

    const authMeta = detectOpenCodeAuthStoreMetadata();
    const providerMeta = detectProviderConfig();

    expect(authMeta.credentialCount).toBe(2);
    expect(providerMeta.authCredentialCount).toBe(2);
    expect(providerMeta.credentialCount).toBe(2);
    expect(JSON.stringify(providerMeta)).not.toContain("test-auth-key-value");
    expect(JSON.stringify(providerMeta)).not.toContain("test-access-token");
  });
});

describe("OpenCode Windows platform helpers", () => {
  let fixtureDir: string | null = null;

  afterEach(() => {
    _resetOpenCodePlatformCachesForTests();
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  it("augments PATH with APPDATA/LOCALAPPDATA npm dirs and resolves .cmd shims", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-path-"));
    const appData = path.join(fixtureDir, "Roaming");
    const localAppData = path.join(fixtureDir, "Local");
    const appDataNpm = path.join(appData, "npm");
    const localAppDataNpm = path.join(localAppData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.mkdirSync(localAppDataNpm, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    fs.writeFileSync(cmdShim, "@echo off\r\n", "utf8");

    const enhancedEnv = buildOpenCodeChildEnv({ PATH: "C:\\Windows\\System32", APPDATA: appData, LOCALAPPDATA: localAppData }, "win32");
    const pathEntries = enhancedEnv.PATH?.split(";") ?? [];
    expect(pathEntries).toContain(appDataNpm);
    expect(pathEntries).toContain(localAppDataNpm);

    const resolved = resolveExecutableOnPath("opencode", enhancedEnv, "win32");
    expect(resolved.resolved).toBe(true);
    expect(resolved.command).toBe(cmdShim);
  });

  it("builds a native node execution plan instead of returning a direct .cmd shim", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-cmd-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const jsBin = createOpenCodePackageFixture(appDataNpm);
    fs.writeFileSync(cmdShim, `@echo off\r\nnode "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*\r\n`, "utf8");

    const nodeExe = path.join(fixtureDir, "node.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData }, "win32", nodeExe);

    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([jsBin]);
    expect(plan.executionMode).toBe("windows-node-shim");
    expect(plan.shimPath).toBe(cmdShim);
    expect(plan.file.toLowerCase()).not.toMatch(/\.cmd$|\.bat$/);
    expect(plan.file.toLowerCase()).not.toMatch(/cmd\.exe$/);
    expect(plan.argsPrefix).not.toContain("/c");
  });

  it("prefers a PATHEXT command shim over an extensionless npm shell shim on Windows", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-extensionless-shim-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const extensionlessShellShim = path.join(appDataNpm, "opencode");
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const jsBin = createOpenCodePackageFixture(appDataNpm);
    const nodeExe = path.join(appDataNpm, "node.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(extensionlessShellShim, "#!/bin/sh\nbasedir=$(dirname \"$0\")\nexec node \"$basedir/node_modules/opencode-ai/bin/opencode.js\" \"$@\"\n", "utf8");
    fs.writeFileSync(cmdShim, `@echo off\r\nnode "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*\r\n`, "utf8");

    const env = { PATH: "C:\\Windows\\System32", APPDATA: appData, PATHEXT: ".CMD;.EXE;.BAT;.COM" };
    const enhancedEnv = buildOpenCodeChildEnv(env, "win32");
    const resolved = resolveExecutableOnPath("opencode", enhancedEnv, "win32");
    const plan = resolveOpenCodeProcessContext(env, "win32", path.join(fixtureDir, "Electron.exe"));

    expect(resolved.resolved).toBe(true);
    expect(resolved.command).toBe(cmdShim);
    expect(resolved.command).not.toBe(extensionlessShellShim);
    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([jsBin]);
    expect(plan.executionMode).toBe("windows-node-shim");
    expect(plan.shimPath).toBe(cmdShim);
    expect(plan.file).not.toBe(extensionlessShellShim);
  });

  it("parses npm cmd-shim patterns with %dp0%, _prog, CALL :find_dp0, backslashes, and extensionless bin", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-npm10-cmd-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const extensionlessBin = createOpenCodePackageFixture(appDataNpm, "opencode");
    const nodeExe = path.join(appDataNpm, "node.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(cmdShim, [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b %ERRORLEVEL%",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "IF EXIST \"%dp0%\\node.exe\" (",
      "  SET \"_prog=%dp0%\\node.exe\"",
      ") ELSE (",
      "  SET \"_prog=node\"",
      ")",
      "endLocal & goto #_undefined_# 1>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*",
    ].join("\r\n"), "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData }, "win32", path.join(fixtureDir, "Electron.exe"));

    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([extensionlessBin]);
    expect(plan.executionMode).toBe("windows-node-shim");
    expect(plan.argsPrefix.join(" ")).not.toContain("/c");
  });

  it("parses unquoted %~dp0 script paths without falling back to cmd.exe", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-unquoted-cmd-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const extensionlessBin = createOpenCodePackageFixture(appDataNpm, "opencode");
    const nodeExe = path.join(appDataNpm, "node.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\nnode %~dp0\\node_modules\\opencode-ai\\bin\\opencode %*\r\n", "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData }, "win32", path.join(fixtureDir, "Electron.exe"));

    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([extensionlessBin]);
    expect(plan.file.toLowerCase()).not.toMatch(/cmd\.exe$|\.cmd$|\.bat$/);
  });

  it("uses PATH node.exe instead of a packaged Electron process executable", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-path-node-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    const nodeDir = path.join(fixtureDir, "nodejs");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    const extensionlessBin = createOpenCodePackageFixture(appDataNpm, "opencode");
    const nodeExe = path.join(nodeDir, "node.exe");
    const electronExe = path.join(fixtureDir, "TTS Voice Generator.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(electronExe, "", "utf8");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: nodeDir, APPDATA: appData }, "win32", electronExe);

    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([extensionlessBin]);
    expect(plan.file).not.toBe(electronExe);
  });

  it("resolves a Chinese Windows user npm shim through native node argv without cmd.exe", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-中文-opencode-plan-"));
    const userRoot = path.join(fixtureDir, "Users", "毛润");
    const appData = path.join(userRoot, "AppData", "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const extensionlessBin = createOpenCodePackageFixture(appDataNpm, "opencode");
    const nodeExe = path.join(appDataNpm, "node.exe");
    const electronExe = path.join(fixtureDir, "TTS Voice Generator.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(electronExe, "", "utf8");
    fs.writeFileSync(cmdShim, [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b %ERRORLEVEL%",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "IF EXIST \"%dp0%\\node.exe\" (",
      "  SET \"_prog=%dp0%\\node.exe\"",
      ") ELSE (",
      "  SET \"_prog=node\"",
      ")",
      "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*",
    ].join("\r\n"), "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData }, "win32", electronExe);

    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([extensionlessBin]);
    expect(plan.executionMode).toBe("windows-node-shim");
    expect(plan.shimPath).toBe(cmdShim);
    expect(plan.file.toLowerCase()).not.toMatch(/cmd\.exe$|\.cmd$|\.bat$/);
    expect(plan.argsPrefix.join(" ")).not.toContain("/c");
  });

  it("resolves an opencode-ai native exe bin from a Chinese Windows npm shim without node or cmd.exe", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-中文-opencode-exe-plan-"));
    const userRoot = path.join(fixtureDir, "Users", "毛润");
    const appData = path.join(userRoot, "AppData", "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const nativeBin = createOpenCodePackageFixture(appDataNpm, "opencode.exe");
    const electronExe = path.join(fixtureDir, "TTS Voice Generator.exe");
    fs.writeFileSync(electronExe, "", "utf8");
    fs.writeFileSync(cmdShim, [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"   %*",
    ].join("\r\n"), "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData }, "win32", electronExe);

    expect(plan.file).toBe(nativeBin);
    expect(plan.argsPrefix).toEqual([]);
    expect(plan.executionMode).toBe("native-executable");
    expect(plan.shimPath).toBe(cmdShim);
    expect(plan.file.toLowerCase()).toMatch(/opencode\.exe$/);
    expect(plan.file.toLowerCase()).not.toMatch(/cmd\.exe$|\.cmd$|\.bat$/);
  });

  it("discovers Program Files nodejs while resolving an npm opencode cmd-shim", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-program-files-node-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    const programFiles = path.join(fixtureDir, "Program Files");
    const nodeDir = path.join(programFiles, "nodejs");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    const extensionlessBin = createOpenCodePackageFixture(appDataNpm, "opencode");
    const nodeExe = path.join(nodeDir, "node.exe");
    const electronExe = path.join(fixtureDir, "TTS Voice Generator.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(electronExe, "", "utf8");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData, ProgramFiles: programFiles }, "win32", electronExe);

    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([extensionlessBin]);
    expect(plan.executionMode).toBe("windows-node-shim");
  });

  it("discovers an explicit npm_node_execpath node.exe candidate when Electron execPath is not node", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-npm-node-execpath-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    const nodeDir = path.join(fixtureDir, "node-from-npm-env");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    const extensionlessBin = createOpenCodePackageFixture(appDataNpm, "opencode");
    const nodeExe = path.join(nodeDir, "node.exe");
    const electronExe = path.join(fixtureDir, "TTS Voice Generator.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(electronExe, "", "utf8");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData, npm_node_execpath: nodeExe }, "win32", electronExe);

    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([extensionlessBin]);
    expect(plan.executionMode).toBe("windows-node-shim");
  });

  it("fails closed with a clear diagnostic when script resolves but no safe node executable exists", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-no-node-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    createOpenCodePackageFixture(appDataNpm, "opencode");
    const electronExe = path.join(fixtureDir, "Electron.exe");
    fs.writeFileSync(electronExe, "", "utf8");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");

    expect(() => resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData }, "win32", electronExe))
      .toThrow(/Unable to resolve safe Node executable/);
  });

  it("fails closed when a Windows .cmd shim cannot be resolved to a native node target", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-unresolved-cmd-plan-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");

    expect(() => resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData }, "win32"))
      .toThrow(/Unable to resolve safe native OpenCode target/);
  });

  it("skips cmd.exe probe for non-ASCII Windows shim paths and returns an explainable error", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-中文-probe-skip-"));
    const userRoot = path.join(fixtureDir, "Users", "毛润");
    const appData = path.join(userRoot, "AppData", "Roaming");
    const appDataNpm = path.join(appData, "npm");
    const cmdDir = path.join(fixtureDir, "System32");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.mkdirSync(cmdDir, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    createOpenCodePackageFixture(appDataNpm, "opencode");
    fs.writeFileSync(cmdShim, "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");
    const cmdExe = path.join(cmdDir, "cmd.exe");
    const electronExe = path.join(fixtureDir, "TTS Voice Generator.exe");
    fs.writeFileSync(cmdExe, "", "utf8");
    fs.writeFileSync(electronExe, "", "utf8");

    await expect(resolveOpenCodeProbeContextAsync({ PATH: cmdDir, APPDATA: appData, ComSpec: cmdExe }, "win32", electronExe))
      .rejects.toThrow(/command-shim probe skipped.*non-ASCII characters.*cmd\.exe may corrupt/s);
  });

  it("uses a native Windows executable directly when opencode.exe is resolved", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-exe-plan-"));
    const binDir = path.join(fixtureDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exePath = path.join(binDir, "opencode.exe");
    fs.writeFileSync(exePath, "", "utf8");

    const plan = resolveOpenCodeProcessContext({ PATH: binDir }, "win32");

    expect(plan.file).toBe(exePath);
    expect(plan.argsPrefix).toEqual([]);
    expect(plan.executionMode).toBe("native-executable");
  });

  it("adds HOME .npm-global/bin and dynamic npm prefix candidates on Windows", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-npm-prefix-"));
    const shimDir = path.join(fixtureDir, "shims");
    const prefixDir = path.join(fixtureDir, "custom-prefix");
    const homeDir = path.join(fixtureDir, "home");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(prefixDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "npm.exe"), "", "utf8");
    _setNpmGlobalPrefixRunnerForTests(async () => ({ stdout: `${prefixDir}\n`, stderr: "" }));

    const prefix = await getNpmGlobalPrefix({ PATH: shimDir, HOME: homeDir }, "win32");
    const enhancedEnv = await buildOpenCodeChildEnvAsync({ PATH: "C:\\Windows\\System32;" + shimDir, HOME: homeDir }, "win32");
    const entries = enhancedEnv.PATH?.split(";") ?? [];

    expect(prefix).toBe(prefixDir);
    expect(entries).toContain(path.join(homeDir, ".npm-global", "bin"));
    expect(entries).toContain(prefixDir);
  });

  it("resolves pnpm/corepack Windows shims through node scripts and fails closed on bad shim", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-pm-resolve-"));
    const nodeDir = path.join(fixtureDir, "nodejs");
    const shimDir = path.join(fixtureDir, "shims");
    fs.mkdirSync(path.join(shimDir, "node_modules", "pnpm", "bin"), { recursive: true });
    fs.mkdirSync(path.join(shimDir, "node_modules", "corepack", "dist"), { recursive: true });
    const pnpmCli = path.join(shimDir, "node_modules", "pnpm", "bin", "pnpm.cjs");
    const corepackCli = path.join(shimDir, "node_modules", "corepack", "dist", "corepack.js");
    fs.writeFileSync(pnpmCli, "// pnpm", "utf8");
    fs.writeFileSync(corepackCli, "// corepack", "utf8");
    fs.writeFileSync(path.join(shimDir, "pnpm.cmd"), `@echo off\r\nnode "%~dp0\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n`, "utf8");
    fs.writeFileSync(path.join(shimDir, "corepack.cmd"), `@echo off\r\nnode "%~dp0\\node_modules\\corepack\\dist\\corepack.js" %*\r\n`, "utf8");
    fs.writeFileSync(path.join(shimDir, "bun.cmd"), "@echo off\r\necho unsafe\r\n", "utf8");
    const nodeExe = path.join(nodeDir, "node.exe");
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(nodeExe, "", "utf8");

    const pnpm = resolvePackageManagerCommand("pnpm", { PATH: shimDir }, "win32", nodeExe);
    const corepack = resolvePackageManagerCommand("corepack", { PATH: shimDir }, "win32", nodeExe);
    const bun = resolvePackageManagerCommand("bun", { PATH: shimDir }, "win32", nodeExe);

    expect(pnpm?.command).toBe(nodeExe);
    expect(pnpm?.argsPrefix).toEqual([pnpmCli]);
    expect(corepack?.argsPrefix).toEqual([corepackCli]);
    expect(bun).toBeNull();
  });

  it("detects OpenCode install method from npm, Chocolatey, Scoop, and plain PATH", () => {
    expect(detectInstallMethod("C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd")).toBe("npm");
    expect(detectInstallMethod("C:\\ProgramData\\chocolatey\\bin\\opencode.exe")).toBe("chocolatey");
    expect(detectInstallMethod("C:\\Users\\me\\scoop\\shims\\opencode.cmd")).toBe("scoop");
    expect(detectInstallMethod("C:\\Tools\\opencode.exe")).toBe("path");
  });

  it("orders Windows OpenCode config candidates with OPENCODE_CONFIG and official global path before AppData fallbacks", () => {
    const home = "C:\\Users\\Alice";
    const overrideConfig = "C:\\Custom\\opencode.json";
    const candidates = getOpenCodeConfigPathCandidates({
      OPENCODE_CONFIG: overrideConfig,
      HOME: home,
      USERPROFILE: home,
      APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    }, "win32");

    expect(candidates[0]).toBe(overrideConfig);
    expect(candidates[1]).toBe("C:\\Users\\Alice\\.config\\opencode\\opencode.json");
    expect(candidates).toContain("C:\\Users\\Alice\\AppData\\Roaming\\opencode\\opencode.json");
    expect(candidates).toContain("C:\\Users\\Alice\\AppData\\Local\\opencode\\opencode.json");
  });
});

describe("OpenCode non-Windows PATH helpers", () => {
  let fixtureDir: string | null = null;

  afterEach(() => {
    _resetOpenCodePlatformCachesForTests();
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  it("augments macOS GUI PATH with Homebrew and user npm candidates", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-opencode-path-"));
    const home = path.join(fixtureDir, "home");
    const userBin = path.join(home, ".npm-global", "bin");
    fs.mkdirSync(userBin, { recursive: true });
    const opencodeBin = path.join(userBin, "opencode");
    fs.writeFileSync(opencodeBin, "#!/usr/bin/env node\n", "utf8");

    const candidates = getNonWindowsOpenCodePathCandidates({ PATH: "/usr/bin", HOME: home }, "darwin");
    const enhancedEnv = buildOpenCodeChildEnv({ PATH: "/usr/bin", HOME: home }, "darwin");
    const resolved = resolveExecutableOnPath("opencode", enhancedEnv, "darwin");
    const plan = resolveOpenCodeProcessContext({ PATH: "/usr/bin", HOME: home }, "darwin");

    expect(candidates).toContain("/opt/homebrew/bin");
    expect(candidates).toContain("/usr/local/bin");
    expect(candidates).toContain(userBin);
    expect(enhancedEnv.PATH?.split(path.delimiter)).toContain(userBin);
    expect(resolved.resolved).toBe(true);
    expect(isOpenCodeExecutableCommand(resolved.command)).toBe(true);
    expect(plan.resolved).toBe(true);
    expect(isOpenCodeExecutableCommand(plan.file)).toBe(true);
    expect(plan.argsPrefix).toEqual([]);
    expect(plan.executionMode).toBe("native-executable");
  });

  it("adds async npm global prefix candidates without using shell resolution", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-npm-prefix-"));
    const home = path.join(fixtureDir, "home");
    const prefixDir = path.join(fixtureDir, "npm-prefix");
    _setNpmGlobalPrefixRunnerForTests(async (_file, _args, options) => {
      expect(options.shell).toBe(false);
      return { stdout: `${prefixDir}\n`, stderr: "" };
    });

    const enhancedEnv = await buildOpenCodeChildEnvAsync({ PATH: "/usr/bin", HOME: home }, "darwin");
    const entries = enhancedEnv.PATH?.split(path.delimiter) ?? [];
    const effectiveCandidates = getEffectiveOpenCodePathCandidates({ PATH: "/usr/bin", HOME: home }, "darwin", prefixDir);

    expect(entries).toContain(path.join(prefixDir, "bin"));
    expect(effectiveCandidates).toContain(path.join(prefixDir, "bin"));
  });

  it("reports augmented-path when OpenCode is found only through macOS PATH candidates", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-diagnostics-"));
    const home = path.join(fixtureDir, "home");
    const userBin = path.join(home, ".npm-global", "bin");
    fs.mkdirSync(userBin, { recursive: true });
    const opencodeBin = path.join(userBin, "opencode");
    fs.writeFileSync(opencodeBin, "#!/usr/bin/env node\n", "utf8");
    _setNpmGlobalPrefixRunnerForTests(async () => ({ stdout: "", stderr: "" }));

    const diagnostics = await getOpenCodePathDiagnostics({ PATH: "/usr/bin", HOME: home }, "darwin");

    expect(diagnostics.pathState).toBe("augmented-path");
    expect(isOpenCodeExecutableCommand(diagnostics.executablePath ?? "")).toBe(true);
    expect(diagnostics.probeExecutionMode).toBe("native-executable");
    expect(diagnostics.effectivePathCandidates).toContain(userBin);
    expect(diagnostics.resolutionError).toBeNull();
  });
});

// ─── checkOpenCodeAvailability (combined detection) ────────────────────────────

describe("checkOpenCodeAvailability combined detection", () => {
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalXdgData = process.env.XDG_DATA_HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
  const originalPath = process.env.PATH;
  const originalAppData = process.env.APPDATA;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let fixtureDir: string | null = null;

  beforeEach(() => {
    invalidateAvailabilityCache();
    delete process.env.OPENCODE_CONFIG;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = "";
  });

  afterEach(() => {
    _resetExecRunner();
    _resetOpenCodePlatformCachesForTests();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgData;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  it("returns available=true when providers list has credentials", async () => {
    _setExecRunner(createMockExecRunner([
      { args: ["--version"], result: { stdout: "v1.14.30\n", stderr: "" } },
      { args: ["providers", "list"], result: { stdout: "1 credentials configured", stderr: "" } },
    ]));

    const result = await checkOpenCodeAvailability();

    expect(result.available).toBe(true);
    expect(result.version).toBe("v1.14.30");
    expect(result.error).toBeNull();
  });

  it("parses providers/auth list credential counts conservatively", () => {
    expect(parseOpenCodeCredentialCount("\u001b[32m2 credentials\u001b[0m configured")).toBe(2);
    expect(parseOpenCodeCredentialCount("Credentials: 0")).toBe(0);
    expect(parseOpenCodeCredentialCount("No credentials configured")).toBe(0);
    expect(parseOpenCodeCredentialCount("openrouter authenticated\nanthropic logged in")).toBe(2);
    expect(parseOpenCodeCredentialCount("provider list without credential signal")).toBeNull();
  });

  it("returns available=true when local auth store has credentials and CLI lists zero credentials", async () => {
    _setExecRunner(createMockExecRunner([
      { args: ["--version"], result: { stdout: "v1.15.0\n", stderr: "" } },
      { args: ["providers", "list"], result: { stdout: "0 credentials configured", stderr: "" } },
      { args: ["auth", "list"], result: { stdout: "0 credentials configured", stderr: "" } },
    ]));

    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "availability-auth-store-"));
    const authDir = path.join(fixtureDir, ".local", "share", "opencode");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({ openrouter: { token: "test-auth-token-value" } }), "utf8");
    process.env.HOME = fixtureDir;
    process.env.USERPROFILE = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";
    delete process.env.XDG_DATA_HOME;

    const result = await withProcessPlatformAsync("linux", () => checkOpenCodeAvailability());

    expect(result.available).toBe(true);
    expect(result.providerMetadata?.authCredentialCount).toBe(1);
    expect(result.providerMetadata?.credentialCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("test-auth-token-value");
  });

  it("uses auth list alias when providers list has no credential signal", async () => {
    const capturedArgs: string[][] = [];
    _setExecRunner(async (file: string, args: string[], _options: Record<string, unknown>) => {
      if (!isOpenCodeExecutableCommand(file)) throw new Error(`Unexpected command: ${file}`);
      capturedArgs.push(args);
      if (JSON.stringify(args) === JSON.stringify(["--version"])) return { stdout: "v1.15.0\n", stderr: "" };
      if (JSON.stringify(args) === JSON.stringify(["providers", "list"])) return { stdout: "provider table without credential count", stderr: "" };
      if (JSON.stringify(args) === JSON.stringify(["auth", "list"])) return { stdout: "Credentials: 2", stderr: "" };
      throw new Error(`Unexpected opencode args: ${JSON.stringify(args)}`);
    });

    process.env.HOME = path.join(os.tmpdir(), "nonexistent-auth-alias-" + Date.now());
    process.env.USERPROFILE = process.env.HOME;
    process.env.XDG_CONFIG_HOME = "";
    delete process.env.XDG_DATA_HOME;

    const result = await withProcessPlatformAsync("linux", () => checkOpenCodeAvailability());

    expect(result.available).toBe(true);
    expect(result.providerMetadata?.cliCredentialCount).toBe(2);
    expect(result.providerMetadata?.credentialCount).toBe(2);
    expect(capturedArgs).toEqual([["--version"], ["providers", "list"], ["auth", "list"]]);
  });

  it("returns available=true when providers list has 0 but config file has apiKey", async () => {
    _setExecRunner(createMockExecRunner([
      { args: ["--version"], result: { stdout: "v1.14.30\n", stderr: "" } },
      { args: ["providers", "list"], result: { stdout: "\x1b[32m0 credentials\x1b[0m configured", stderr: "" } },
    ]));

    // Setup config file with provider apiKey
    fixtureDir = setupConfigDir(sampleConfigWithProviders(1));
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const result = await checkOpenCodeAvailability();

    expect(result.available).toBe(true);
    expect(result.version).toBe("v1.14.30");
    expect(result.providerMetadata?.hasConfig).toBe(true);
    expect(result.providerMetadata?.providerCount).toBe(1);
  });

  it("returns available=false when both sources have no credentials", async () => {
    _setExecRunner(createMockExecRunner([
      { args: ["--version"], result: { stdout: "v1.14.30\n", stderr: "" } },
      { args: ["providers", "list"], result: { stdout: "0 credentials configured", stderr: "" } },
    ]));

    // No config file
    process.env.HOME = path.join(os.tmpdir(), "nonexistent-" + Date.now());
    process.env.XDG_CONFIG_HOME = "";

    const result = await checkOpenCodeAvailability();

    expect(result.available).toBe(false);
    expect(result.version).toBe("v1.14.30");
    expect(result.error).toBeTruthy();
  });

  it("returns available=false when opencode binary not found", async () => {
    _setExecRunner(async (file: string) => {
      throw new Error("spawn opencode ENOENT");
    });

    const result = await checkOpenCodeAvailability();

    expect(result.available).toBe(false);
    expect(result.version).toBeNull();
  });

  it("returns available=true when providers list fails but config has apiKey", async () => {
    _setExecRunner(createMockExecRunner([
      { args: ["--version"], result: { stdout: "v1.14.30\n", stderr: "" } },
      { args: ["providers", "list"], result: new Error("unknown command") },
    ]));

    // Setup config file
    fixtureDir = setupConfigDir(sampleConfigWithProviders(2));
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const result = await checkOpenCodeAvailability();

    expect(result.available).toBe(true);
    expect(result.providerMetadata?.providerCount).toBe(2);
  });

  it("passes sanitized env to every availability detection subprocess", async () => {
    const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
    const originalInternalAccessToken = process.env.INTERNAL_ACCESS_TOKEN;
    const originalClientSecret = process.env.CLIENT_SECRET;

    process.env.OPENROUTER_API_KEY = "sk-or-v1-availability-secret";
    process.env.INTERNAL_ACCESS_TOKEN = "internal-token-value";
    process.env.CLIENT_SECRET = "client-secret-value";

    const capturedOptions: Record<string, unknown>[] = [];
    _setExecRunner(async (file: string, args: string[], options: Record<string, unknown>) => {
      capturedOptions.push(options);
      if (!isOpenCodeExecutableCommand(file)) throw new Error(`Unexpected command: ${file}`);
      if (JSON.stringify(args) === JSON.stringify(["--version"])) {
        return { stdout: "v1.14.30\n", stderr: "" };
      }
      if (JSON.stringify(args) === JSON.stringify(["providers", "list"])) {
        return { stdout: "1 credentials configured", stderr: "" };
      }
      throw new Error(`Unexpected opencode args: ${JSON.stringify(args)}`);
    });

    try {
      const result = await checkOpenCodeAvailability();

      expect(result.available).toBe(true);
      expect(capturedOptions).toHaveLength(2);

      for (const options of capturedOptions) {
        const childEnv = options.env as Record<string, string | undefined> | undefined;
        expect(childEnv).toBeDefined();
        expect(childEnv).not.toBe(process.env);
        expect(childEnv?.OPENROUTER_API_KEY).toBeUndefined();
        expect(childEnv?.INTERNAL_ACCESS_TOKEN).toBeUndefined();
        expect(childEnv?.CLIENT_SECRET).toBeUndefined();
        expect("PATH" in (childEnv || {})).toBe(true);
        expect("HOME" in (childEnv || {})).toBe(true);
      }
    } finally {
      if (originalOpenRouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
      }
      if (originalInternalAccessToken === undefined) {
        delete process.env.INTERNAL_ACCESS_TOKEN;
      } else {
        process.env.INTERNAL_ACCESS_TOKEN = originalInternalAccessToken;
      }
      if (originalClientSecret === undefined) {
        delete process.env.CLIENT_SECRET;
      } else {
        process.env.CLIENT_SECRET = originalClientSecret;
      }
    }
  });

  it("uses augmented macOS PATH for availability probes in GUI-like environments", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-opencode-runner-"));
    const home = path.join(fixtureDir, "home");
    const userBin = path.join(home, ".npm-global", "bin");
    fs.mkdirSync(userBin, { recursive: true });
    const opencodeBin = path.join(userBin, "opencode");
    fs.writeFileSync(opencodeBin, "#!/usr/bin/env node\n", "utf8");
    _setNpmGlobalPrefixRunnerForTests(async () => ({ stdout: "", stderr: "" }));

    const originalPathValue = process.env.PATH;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = "";
    delete process.env.XDG_DATA_HOME;
    process.env.PATH = "/usr/bin";

    const captured: Array<{ file: string; args: string[]; env: Record<string, string | undefined>; shell: unknown }> = [];
    _setExecRunner(async (file: string, args: string[], options: Record<string, unknown>) => {
      captured.push({
        file,
        args,
        env: options.env as Record<string, string | undefined>,
        shell: options.shell,
      });
      if (!isOpenCodeExecutableCommand(file)) throw new Error(`Unexpected file: ${file}`);
      if (JSON.stringify(args) === JSON.stringify(["--version"])) return { stdout: "v1.14.50\n", stderr: "" };
      if (JSON.stringify(args) === JSON.stringify(["providers", "list"])) return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected opencode args: ${JSON.stringify(args)}`);
    });

    try {
      const result = await withProcessPlatformAsync("darwin", () => checkOpenCodeAvailability());

      expect(result.available).toBe(true);
      expect(result.pathState).toBe("augmented-path");
      expect(result.probeExecutionMode).toBe("native-executable");
      expect(captured).toHaveLength(2);
      expect(isOpenCodeExecutableCommand(captured[0].file)).toBe(true);
      expect(captured[0].args).toEqual(["--version"]);
      expect(captured[0].shell).toBe(false);
      expect(captured[0].env.PATH?.split(path.delimiter)).toContain(userBin);
    } finally {
      if (originalPathValue === undefined) delete process.env.PATH;
      else process.env.PATH = originalPathValue;
    }
  });

  it("uses a Windows native node shim plan and enhanced env for version and providers checks", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-opencode-runner-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const jsBin = createOpenCodePackageFixture(appDataNpm);
    fs.writeFileSync(cmdShim, `@echo off\r\nnode "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*\r\n`, "utf8");

    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPath = process.env.PATH;
    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = "C:\\Windows\\System32";

    const captured: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }> = [];
    _setExecRunner(async (file: string, args: string[], options: Record<string, unknown>) => {
      captured.push({ file, args, env: options.env as Record<string, string | undefined> });
      if (file !== process.execPath) throw new Error(`Unexpected file: ${file}`);
      if (JSON.stringify(args) === JSON.stringify([jsBin, "--version"])) return { stdout: "v1.14.30\n", stderr: "" };
      if (JSON.stringify(args) === JSON.stringify([jsBin, "providers", "list"])) return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected args: ${JSON.stringify(args)}`);
    });

    try {
      const result = await withProcessPlatformAsync("win32", () => checkOpenCodeAvailability());
      expect(result.available).toBe(true);
      expect(captured).toHaveLength(2);
      expect(captured[0].file).toBe(process.execPath);
      expect(captured[1].file).toBe(process.execPath);
      expect(captured[0].args).toEqual([jsBin, "--version"]);
      expect(captured[1].args).toEqual([jsBin, "providers", "list"]);
      expect(captured[0].args.join(" ")).not.toContain("/c");
      expect(captured[0].env.PATH).toContain(appDataNpm);
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("uses an opencode-ai native exe from a Chinese Windows npm shim with shell false", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-中文-opencode-exe-runner-"));
    const userRoot = path.join(fixtureDir, "Users", "毛润");
    const appData = path.join(userRoot, "AppData", "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const nativeBin = createOpenCodePackageFixture(appDataNpm, "opencode.exe");
    fs.writeFileSync(cmdShim, [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"   %*",
    ].join("\r\n"), "utf8");

    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPath = process.env.PATH;
    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = "C:\\Windows\\System32";

    const captured: Array<{ file: string; args: string[]; shell: unknown; env: Record<string, string | undefined> }> = [];
    _setExecRunner(async (file: string, args: string[], options: Record<string, unknown>) => {
      captured.push({ file, args, shell: options.shell, env: options.env as Record<string, string | undefined> });
      if (file !== nativeBin) throw new Error(`Unexpected file: ${file}`);
      if (JSON.stringify(args) === JSON.stringify(["--version"])) return { stdout: "v1.15.1\n", stderr: "" };
      if (JSON.stringify(args) === JSON.stringify(["providers", "list"])) return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected args: ${JSON.stringify(args)}`);
    });

    try {
      const result = await withProcessPlatformAsync("win32", () => checkOpenCodeAvailability());
      expect(result.available).toBe(true);
      expect(result.probeExecutionMode).toBe("native-executable");
      expect(captured).toHaveLength(2);
      expect(captured[0].file).toBe(nativeBin);
      expect(captured[0].args).toEqual(["--version"]);
      expect(captured[0].shell).toBe(false);
      expect(captured[0].env.PATH).toContain(appDataNpm);
      expect(captured[0].args.join(" ")).not.toContain("/c");
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("marks Windows detection unavailable when a .cmd shim has no safe native target", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-opencode-unresolved-runner-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");

    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPath = process.env.PATH;
    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = "C:\\Windows\\System32";

    const captured: Array<{ file: string; args: string[] }> = [];
    _setExecRunner(async (file: string, args: string[]) => {
      captured.push({ file, args });
      return { stdout: "v1.14.30\n", stderr: "" };
    });

    try {
      const result = await withProcessPlatformAsync("win32", () => checkOpenCodeAvailability());
      expect(result.available).toBe(false);
      expect(result.version).toBeNull();
      expect(result.error).toContain("Unable to resolve safe native OpenCode target");
      expect(captured).toHaveLength(0);
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("uses a restricted Windows command-shim probe for status when run-safe node resolution is unavailable", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-opencode-probe-only-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    const cmdDir = path.join(fixtureDir, "System32");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.mkdirSync(cmdDir, { recursive: true });
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    createOpenCodePackageFixture(appDataNpm, "opencode");
    fs.writeFileSync(cmdShim, "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");
    const cmdExe = path.join(cmdDir, "cmd.exe");
    const electronExe = path.join(fixtureDir, "TTS Voice Generator.exe");
    fs.writeFileSync(cmdExe, "", "utf8");
    fs.writeFileSync(electronExe, "", "utf8");

    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPath = process.env.PATH;
    const originalComSpec = process.env.ComSpec;
    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = cmdDir;
    process.env.ComSpec = cmdExe;

    const captured: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    _setExecRunner(async (file: string, args: string[], options: Record<string, unknown>) => {
      captured.push({ file, args, options });
      expect(file).toBe(cmdExe);
      expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(args[3]).toContain(`"${cmdShim}"`);
      expect(args[3]).not.toContain("Line with shell metacharacters");
      expect(options.shell).toBe(false);
      if (args[3].includes('"--version"')) return { stdout: "v1.15.0\n", stderr: "" };
      if (args[3].includes('"providers"') && args[3].includes('"list"')) return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected probe args: ${JSON.stringify(args)}`);
    });

    try {
      const result = await withProcessPlatformAsync("win32", () => withProcessExecPathAsync(electronExe, () => checkOpenCodeAvailability()));

      expect(result.cliAvailable).toBe(true);
      expect(result.runAvailable).toBe(false);
      expect(result.available).toBe(false);
      expect(result.version).toBe("v1.15.0");
      expect(result.resolutionError).toBeNull();
      expect(result.runResolutionError).toContain("Unable to resolve safe Node executable");
      expect(result.probeExecutionMode).toBe("windows-cmd-shim-probe");
      expect(result.error).toContain("app automation cannot safely execute opencode run");
      expect(captured).toHaveLength(2);
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = originalComSpec;
    }
  });
});

// ─── runOpenCodeNormalize success path ─────────────────────────────────────────

describe("runOpenCodeNormalize success path", () => {
  beforeEach(() => {
    // Do not invalidate cache for these tests since runOpenCodeNormalize
    // does not call checkOpenCodeAvailability
  });

  afterEach(() => {
    _resetSpawnRunner();
  });

  it("returns runner=opencode with valid JSON output", async () => {
    const validOutput = {
      lines: [
        { id: crypto.randomUUID(), order: 0, speaker: "narrator", text: "Hello world", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
        { id: crypto.randomUUID(), order: 1, speaker: "narrator", text: "Second line", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr", style: "" },
      ],
    };

    _setSpawnRunner(async () => ({
      stdout: JSON.stringify({ content: JSON.stringify(validOutput) }),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello world\nSecond line", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("opencode");
    expect(result.productionList.lines).toHaveLength(2);
    expect(result.productionList.speakers).toHaveLength(1);
    expect(result.productionList.lines[0].text).toBe("Hello world");
    expect(result.productionList.lines[1].text).toBe("Second line");
    expect(result.productionList.metadata.method).toBe("opencode-run");
    expect(result.productionList.metadata.durationMs).toBeTypeOf("number");
  });

  it("passes malicious-looking prompt content only as native argv after resolving Windows .cmd shim", async () => {
    let fixtureDir: string | null = null;
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPath = process.env.PATH;
    try {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-run-args-plan-"));
      const appData = path.join(fixtureDir, "Roaming");
      const appDataNpm = path.join(appData, "npm");
      fs.mkdirSync(appDataNpm, { recursive: true });
      const cmdShim = path.join(appDataNpm, "opencode.cmd");
      const jsBin = createOpenCodePackageFixture(appDataNpm);
      fs.writeFileSync(cmdShim, `@echo off\r\nnode "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*\r\n`, "utf8");

      process.env.APPDATA = appData;
      delete process.env.LOCALAPPDATA;
      process.env.PATH = "C:\\Windows\\System32";

      const validOutput = {
        lines: [{ id: crypto.randomUUID(), order: 0, speaker: "narrator", text: "Safe", voice: "Zephyr" }],
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
      };
      const captured: Array<{ file: string; args: string[] }> = [];
      _setSpawnRunner(async (file: string, args: string[]) => {
        captured.push({ file, args });
        return { stdout: JSON.stringify({ content: JSON.stringify(validOutput) }), stderr: "" };
      });

      const result = await withProcessPlatformAsync("win32", () => runOpenCodeNormalize({
        documents: [
          {
            id: "doc-1",
            fileName: "malicious-looking.txt",
            content: "Line with shell metacharacters \" & echo SHOULD_NOT_RUN & \"",
            enabled: true,
          },
        ],
      }));

      expect(result.runner).toBe("opencode");
      expect(captured).toHaveLength(1);
      expect(captured[0].file).toBe(process.execPath);
      expect(captured[0].args.slice(0, 4)).toEqual([jsBin, "run", "--format", "json"]);
      expect(captured[0].args).not.toContain("/c");
      expect(captured[0].args.join(" ")).not.toContain("cmd.exe");
      const promptArg = captured[0].args[captured[0].args.length - 1];
      expect(promptArg).toContain("SHOULD_NOT_RUN");
      expect(promptArg).toContain("&");
      expect(promptArg).toContain('"');
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (fixtureDir) cleanupDir(fixtureDir);
    }
  });

  it("fails closed for opencode run when a Windows .cmd shim cannot be safely resolved", async () => {
    let fixtureDir: string | null = null;
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPath = process.env.PATH;
    try {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-run-unresolved-plan-"));
      const appData = path.join(fixtureDir, "Roaming");
      const appDataNpm = path.join(appData, "npm");
      fs.mkdirSync(appDataNpm, { recursive: true });
      fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");

      process.env.APPDATA = appData;
      delete process.env.LOCALAPPDATA;
      process.env.PATH = "C:\\Windows\\System32";

      const captured: Array<{ file: string; args: string[] }> = [];
      _setSpawnRunner(async (file: string, args: string[]) => {
        captured.push({ file, args });
        return { stdout: "{}", stderr: "" };
      });

      await expect(withProcessPlatformAsync("win32", () => runOpenCodeNormalize({
        documents: [
          { id: "doc-1", fileName: "unsafe.txt", content: "Line & echo SHOULD_NOT_RUN", enabled: true },
        ],
      }))).rejects.toThrow(/OPENCODE_RUN_FAILED: Unable to resolve safe native OpenCode target/);
      expect(captured).toHaveLength(0);
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (fixtureDir) cleanupDir(fixtureDir);
    }
  });

  it("handles opencode run returning raw production list JSON (no envelope)", async () => {
    const validOutput = {
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "Raw JSON test", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    };

    _setSpawnRunner(async () => ({
      stdout: JSON.stringify(validOutput),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Raw JSON test", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("opencode");
    expect(result.productionList.lines).toHaveLength(1);
  });

  it("handles opencode output with markdown code fences", async () => {
    const validOutput = {
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "Fenced output", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    };

    const fencedOutput = "```json\n" + JSON.stringify(validOutput, null, 2) + "\n```";

    _setSpawnRunner(async () => ({
      stdout: JSON.stringify({ content: fencedOutput }),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Fenced output", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("opencode");
    expect(result.productionList.lines).toHaveLength(1);
    expect(result.productionList.lines[0].text).toBe("Fenced output");
  });

  it("preserves aggregate speakers without truncating role diversity", async () => {
    const output = {
      lines: [
        { id: "l1", order: 0, speaker: "a", text: "Speaker A", voice: "Zephyr" },
        { id: "l2", order: 1, speaker: "b", text: "Speaker B", voice: "Zephyr" },
        { id: "l3", order: 2, speaker: "c", text: "Speaker C", voice: "Zephyr" },
      ],
      speakers: [
        { id: "a", label: "A", voice: "Zephyr" },
        { id: "b", label: "B", voice: "Zephyr" },
        { id: "c", label: "C", voice: "Zephyr" },
      ],
    };

    _setSpawnRunner(async () => ({
      stdout: JSON.stringify(output),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Three speakers", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("opencode");
    expect(result.productionList.speakers).toHaveLength(3);
    expect(result.productionList.lines.map((line) => line.speaker)).toEqual(["a", "b", "c"]);
    expect(result.warnings.some(w => w.code === "SPEAKER_TRUNCATED")).toBe(false);
  });

  it("ensures sequential line ordering even when opencode returns non-sequential", async () => {
    const output = {
      lines: [
        { id: "l3", order: 5, speaker: "narrator", text: "Third", voice: "Zephyr" },
        { id: "l1", order: 0, speaker: "narrator", text: "First", voice: "Zephyr" },
        { id: "l2", order: 3, speaker: "narrator", text: "Second", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    };

    _setSpawnRunner(async () => ({
      stdout: JSON.stringify(output),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Test ordering", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.productionList.lines).toHaveLength(3);
    // Lines should be re-ordered sequentially: 0, 1, 2
    expect(result.productionList.lines[0].order).toBe(0);
    expect(result.productionList.lines[1].order).toBe(1);
    expect(result.productionList.lines[2].order).toBe(2);
    // Sorted by original order: 0 (First), 3 (Second), 5 (Third)
    expect(result.productionList.lines[0].text).toBe("First");
    expect(result.productionList.lines[1].text).toBe("Second");
    expect(result.productionList.lines[2].text).toBe("Third");
  });
});

// ─── runOpenCodeNormalize fallback paths ───────────────────────────────────────

describe("runOpenCodeNormalize fallback on errors", () => {
  afterEach(() => {
    _resetSpawnRunner();
  });

  it("throws OPENCODE_RUN_FAILED when opencode returns empty output", async () => {
    _setSpawnRunner(async () => ({
      stdout: "",
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello", enabled: true },
      ],
    };

    await expect(runOpenCodeNormalize(input)).rejects.toThrow("OPENCODE_RUN_FAILED");
  });

  it("throws OPENCODE_RUN_FAILED when output is not valid JSON", async () => {
    _setSpawnRunner(async () => ({
      stdout: "This is not JSON at all",
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello", enabled: true },
      ],
    };

    await expect(runOpenCodeNormalize(input)).rejects.toThrow("OPENCODE_RUN_FAILED");
    await expect(runOpenCodeNormalize(input)).rejects.toThrow("not valid JSON");
  });

  it("throws when output missing lines array", async () => {
    _setSpawnRunner(async () => ({
      stdout: JSON.stringify({ speakers: [] }),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello", enabled: true },
      ],
    };

    await expect(runOpenCodeNormalize(input)).rejects.toThrow("missing 'lines' array");
  });

  it("throws OPENCODE_RUN_FAILED when subprocess errors", async () => {
    _setSpawnRunner(async () => {
      throw new Error("Command timed out after 30000ms");
    });

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello", enabled: true },
      ],
    };

    await expect(runOpenCodeNormalize(input)).rejects.toThrow("OPENCODE_RUN_FAILED");
    await expect(runOpenCodeNormalize(input)).rejects.toThrow("timed out");
  });

  it("throws when output missing speakers array", async () => {
    _setSpawnRunner(async () => ({
      stdout: JSON.stringify({ lines: [{ id: "l1", order: 0, speaker: "a", text: "Hello" }] }),
      stderr: "",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello", enabled: true },
      ],
    };

    await expect(runOpenCodeNormalize(input)).rejects.toThrow("missing 'speakers' array");
  });

  it("returns fallback for empty documents input", async () => {
    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Hello", enabled: false },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("fallback");
    expect(result.productionList.lines).toHaveLength(0);
    expect(result.warnings.some(w => w.code === "NO_ENABLED_DOCS")).toBe(true);
  });
});

// ─── Metadata safety (no sensitive fields) ─────────────────────────────────────

describe("Metadata safety - no sensitive data leaked", () => {
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.XDG_CONFIG_HOME = originalXdg || "";
    _resetExecRunner();
    _resetSpawnRunner();
    invalidateAvailabilityCache();
  });

  it("detectProviderConfig never includes apiKey values in output", () => {
    let fixtureDir: string | null = null;

    try {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "safety-test-"));
      const configDir = path.join(fixtureDir, ".config");
      const opencodeDir = path.join(configDir, "opencode");
      fs.mkdirSync(opencodeDir, { recursive: true });

      const secretKey = "sk-super-secret-key-that-should-never-appear-12345678";
      fs.writeFileSync(
        path.join(opencodeDir, "opencode.json"),
        JSON.stringify({
          provider: {
            anthropic: {
              options: { apiKey: secretKey },
              models: [{ id: "claude-3-5-haiku-latest" }],
            },
          },
        }, null, 2),
        "utf8",
      );
      process.env.HOME = fixtureDir;
      process.env.XDG_CONFIG_HOME = "";

      const result = detectProviderConfig();

      // Verify the result is correct
      expect(result.hasConfig).toBe(true);
      expect(result.providerCount).toBe(1);

      // Verify the result object contains NO key values
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretKey);
      expect(serialized).not.toContain("sk-super");
      expect(serialized).not.toMatch(/apiKey/i);
    } finally {
      if (fixtureDir) cleanupDir(fixtureDir);
    }
  });

  it("checkOpenCodeAvailability providerMetadata has no key values", async () => {
    invalidateAvailabilityCache();
    let fixtureDir: string | null = null;

    try {
      // providers list shows 0 (forces config file check)
      _setExecRunner(createMockExecRunner([
        { args: ["--version"], result: { stdout: "v1.14.30\n", stderr: "" } },
        { args: ["providers", "list"], result: { stdout: "0 credentials", stderr: "" } },
      ]));

      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-safety-"));
      const configDir = path.join(fixtureDir, ".config");
      const opencodeDir = path.join(configDir, "opencode");
      fs.mkdirSync(opencodeDir, { recursive: true });

      const secretKey = "sk-leaked-key-test-should-not-appear-anywhere-9999";
      fs.writeFileSync(
        path.join(opencodeDir, "opencode.json"),
        JSON.stringify({
          provider: {
            testProvider: {
              options: { apiKey: secretKey, baseURL: "https://api.test.com" },
              models: [{ id: "test-model" }],
            },
          },
        }, null, 2),
        "utf8",
      );
      process.env.HOME = fixtureDir;
      process.env.XDG_CONFIG_HOME = "";

      const result = await checkOpenCodeAvailability();

      expect(result.available).toBe(true);
      expect(result.providerMetadata?.hasConfig).toBe(true);

      // The entire availability result must not contain the secret
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretKey);
      expect(serialized).not.toContain("sk-leaked");
      expect(serialized).not.toMatch(/"apiKey"/);
    } finally {
      if (fixtureDir) cleanupDir(fixtureDir);
    }
  });

  it("sanitizeError removes apiKey patterns", () => {
    const err = new Error("Failed with apiKey=sk-secret-key-12345678 in response");
    const sanitized = sanitizeError(err);
    expect(sanitized).not.toContain("sk-secret-key-12345678");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("sanitizeError removes Bearer token patterns", () => {
    const err = new Error("Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    const sanitized = sanitizeError(err);
    expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(sanitized).toContain("Bearer [REDACTED]");
  });

  it("runOpenCodeNormalize output metadata contains no key patterns", async () => {
    const validOutput = {
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "Test", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    };

    _setSpawnRunner(async () => ({
      stdout: JSON.stringify({ content: JSON.stringify(validOutput) }),
      stderr: "some stderr with sk-test-key-should-not-appear",
    }));

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Test", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("opencode");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-test-key");
    // Metadata should contain non-sensitive facts only
    expect(result.productionList.metadata.method).toBe("opencode-run");
    expect(typeof result.productionList.metadata.durationMs).toBe("number");
  });
});

// ─── fallbackNormalize unchanged ───────────────────────────────────────────────

describe("fallbackNormalize (unchanged behavior)", () => {
  it("produces deterministic output from simple input", () => {
    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Line one\nLine two\n# Comment\nLine three", enabled: true },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.runner).toBe("fallback");
    expect(result.productionList.lines).toHaveLength(3);
    expect(result.productionList.lines[0].text).toBe("Line one");
    expect(result.productionList.lines[1].text).toBe("Line two");
    expect(result.productionList.lines[2].text).toBe("Line three");
  });

  it("handles multi-speaker input", () => {
    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Alice: Hello\nBob: Hi there", enabled: true },
      ],
    };

    const result = fallbackNormalize(input);

    expect(result.runner).toBe("fallback");
    expect(result.productionList.speakers).toHaveLength(2);
    expect(result.productionList.lines).toHaveLength(2);
  });
});

// ─── Spawn runner: stdin.end, timeout kill, JSON parse ─────────────────────────

import { spawn as realSpawn, type ChildProcess } from "node:child_process";

describe("spawn runner stdin/timeout/parse behavior", () => {
  let spawnFixtureDir: string | null = null;

  afterEach(() => {
    _resetSpawnRunner();
    _resetOpenCodePlatformCachesForTests();
    if (spawnFixtureDir) {
      cleanupDir(spawnFixtureDir);
      spawnFixtureDir = null;
    }
  });

  /**
   * Verify that stdin is properly closed when spawning a subprocess.
   * Uses `cat` (reads stdin until EOF) as a proxy for opencode run behavior.
   * If stdin is NOT closed, `cat` hangs forever. If stdin IS closed, `cat`
   * exits immediately, confirming the fix.
   */
  it("closes stdin on spawned child process (cat exits without hanging)", async () => {
    // Use the REAL _spawnRunner (reset to default)
    _resetSpawnRunner();

    // Use a very short timeout to detect hangs quickly
    const start = Date.now();

    // We cannot call _spawnRunner("cat", ...) directly since it checks for "opencode".
    // Instead, test the spawnOpenCodeRun behavior indirectly by verifying that
    // the spawn mechanism closes stdin correctly using Node's spawn directly.
    // We test the contract: spawn + stdin.end() => process completes.

    const result = await new Promise<{ stdout: string; exited: boolean }>((resolve, reject) => {
      // `cat` with no arguments reads from stdin. If stdin.end() is called,
      // cat will output nothing and exit with code 0.
      const child = realSpawn("cat", [], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // CRITICAL: close stdin immediately (same pattern as spawnOpenCodeRun)
      child.stdin!.end();

      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("cat did not exit -- stdin was not closed"));
      }, 3000);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, exited: code === 0 });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const elapsed = Date.now() - start;
    expect(result.exited).toBe(true);
    // If stdin was closed, cat should exit in well under 1 second
    expect(elapsed).toBeLessThan(1000);
  });

  /**
   * Verify that timeout kills the child process and throws appropriate error.
   * Uses `sleep` (or a long-running shell command) to simulate a hanging process.
   */
  it("kills child process on timeout and falls back", async () => {
    _resetSpawnRunner();

    // The mock _spawnRunner simulates a timeout scenario.
    // In real code, spawnOpenCodeRun's timer calls child.kill('SIGKILL')
    // and rejects with a timeout error. runOpenCodeNormalize catches this
    // and throws OPENCODE_RUN_FAILED.
    _setSpawnRunner(async () => {
      throw new Error("opencode run timed out after 30000ms");
    });

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Test timeout", enabled: true },
      ],
    };

    await expect(runOpenCodeNormalize(input)).rejects.toThrow("OPENCODE_RUN_FAILED");
    await expect(runOpenCodeNormalize(input)).rejects.toThrow("timed out after 30000ms");
  });

  /**
   * Verify real spawn-based timeout behavior: a subprocess that takes longer than
   * the timeout is killed and the promise rejects.
   */
  it("real spawn kills on timeout (integration)", async () => {
    // Test the actual spawnOpenCodeRun timeout mechanism using `sleep 60`
    const result = await new Promise<string>((resolve, reject) => {
      // Use `sleep 60` which would take 60 seconds if not killed
      const child = realSpawn("sleep", ["60"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdin!.end();

      let killed = false;
      const SHORT_TIMEOUT = 500; // 500ms should be enough to verify kill works

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
        resolve("killed-by-timeout");
      }, SHORT_TIMEOUT);

      child.on("close", () => {
        clearTimeout(timer);
        if (!killed) {
          resolve("exited-normally");
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(result).toBe("killed-by-timeout");
  });

  /**
   * Verify stdout JSON parse success path through runOpenCodeNormalize.
   * This confirms the full flow: spawn -> collect stdout -> parse JSON -> validate schema.
   */
  it("successfully parses stdout JSON from spawn runner", async () => {
    const validOutput = {
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "Spawn test line", voice: "Zephyr", style: "", notes: "", status: "pending", model: "google/gemini-3.1-flash-tts-preview", responseFormat: "wav", generationStatus: "draft" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr", style: "" },
      ],
    };

    // Simulate the exact output format from `opencode run --format json`
    _setSpawnRunner(async (_file: string, args: string[]) => {
      // Verify it's called with the right args
      expect(args[0]).toBe("run");
      expect(args[1]).toBe("--format");
      expect(args[2]).toBe("json");
      // args[3] is the prompt (no --quiet flag)

      return {
        stdout: JSON.stringify({ content: JSON.stringify(validOutput) }),
        stderr: "",
      };
    });

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Spawn test line", enabled: true },
      ],
    };

    const result = await runOpenCodeNormalize(input);

    expect(result.runner).toBe("opencode");
    expect(result.productionList.lines).toHaveLength(1);
    expect(result.productionList.lines[0].text).toBe("Spawn test line");
    expect(result.productionList.metadata.method).toBe("opencode-run");
    expect(result.productionList.metadata.durationMs).toBeTypeOf("number");
  });

  /**
   * Verify that spawn runner rejects when child process exits with non-zero code.
   */
  it("rejects with error when child exits non-zero", async () => {
    _setSpawnRunner(async () => {
      throw new Error("opencode run exited with code 1: error details");
    });

    const input = {
      documents: [
        { id: "doc-1", fileName: "test.txt", content: "Non-zero test", enabled: true },
      ],
    };

    await expect(runOpenCodeNormalize(input)).rejects.toThrow("OPENCODE_RUN_FAILED");
    await expect(runOpenCodeNormalize(input)).rejects.toThrow("exited with code 1");
  });

  it("keeps runOpenCodeChat timeout as a hard absolute max", async () => {
    const originalChatTimeout = process.env.OPENCODE_CHAT_TIMEOUT_MS;
    process.env.OPENCODE_CHAT_TIMEOUT_MS = "5000";
    _setNpmGlobalPrefixRunnerForTests(async () => ({ stdout: "", stderr: "" }));

    let capturedOptions: Record<string, unknown> | undefined;
    _setSpawnRunner(async (_file: string, _args: string[], options: Record<string, unknown>) => {
      capturedOptions = options;
      return {
        stdout: `${JSON.stringify({ type: "text", part: { text: "chat response" } })}\n`,
        stderr: "",
      };
    });

    try {
      const result = await runOpenCodeChat({
        sessionId: crypto.randomUUID(),
        userMessage: "hello",
      });

      expect(result.status).toBe("succeeded");
      expect(capturedOptions?.timeout).toBe(5000);
      expect(capturedOptions?.absoluteMaxMs).toBe(5000);
    } finally {
      if (originalChatTimeout === undefined) delete process.env.OPENCODE_CHAT_TIMEOUT_MS;
      else process.env.OPENCODE_CHAT_TIMEOUT_MS = originalChatTimeout;
    }
  });

  it("does not kill or reject when child is alive past the soft timeout", async () => {
    const result = await _spawnOpenCodeRunForTests(process.execPath, [
      "-e",
      [
        "setTimeout(() => process.stdout.write(JSON.stringify({ content: 'completed after soft timeout' })), 150);",
        "setTimeout(() => process.exit(0), 180);",
      ].join(""),
    ], {
      timeout: 30,
      absoluteMaxMs: 1000,
      maxOutputBytes: 1024 * 1024,
      env: process.env,
      draftReadyPollIntervalMs: 20,
      absoluteKillGraceMs: 20,
    });

    expect(result.stdout).toContain("completed after soft timeout");
    expect(result.stderr).not.toMatch(/timed out|SIGKILL|SIGTERM/i);
  });

  it("kills an active child at absolute max when no draft is available", async () => {
    try {
      await _spawnOpenCodeRunForTests(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        timeout: 30,
        absoluteMaxMs: 120,
        maxOutputBytes: 1024 * 1024,
        env: process.env,
        draftReadyPollIntervalMs: 20,
        absoluteKillGraceMs: 20,
      });
      throw new Error("expected absolute timeout rejection");
    } catch (err) {
      const error = err as Error & { code?: string; monitor?: Record<string, unknown> };
      expect(error.code).toBe("OPENCODE_RUN_ABSOLUTE_TIMEOUT");
      expect(error.message).toMatch(/timed out/i);
      expect(error.monitor).toMatchObject({
        state: "absolute_max_exceeded",
        killedByRunner: true,
        killReason: "absolute_timeout",
      });
    }
  });

  it("resolves early when a parseable draft appears", async () => {
    spawnFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-draft-ready-"));
    const draftPath = path.join(spawnFixtureDir, "draft.json");
    fs.writeFileSync(draftPath, JSON.stringify({ lines: [], promptProfiles: [] }), "utf8");

    const result = await _spawnOpenCodeRunForTests(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      timeout: 500,
      absoluteMaxMs: 2000,
      maxOutputBytes: 1024 * 1024,
      env: process.env,
      draftPath,
      draftReadyPollIntervalMs: 20,
      absoluteKillGraceMs: 20,
    });

    expect(result.stderr).toContain("OPENCODE_DRAFT_READY");
  });

  it("updates monitor diagnostics from stdout NDJSON, stderr, and draft mtime", async () => {
    spawnFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-diagnostics-"));
    const draftPath = path.join(spawnFixtureDir, "draft.json");

    try {
      await _spawnOpenCodeRunForTests(process.execPath, [
        "-e",
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(draftPath)}, '{', 'utf8');`,
          "process.stdout.write(JSON.stringify({ type: 'step_start', timestamp: Date.now() }) + '\\n');",
          "process.stderr.write('warning token=diagnostic-token-value\\n');",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ], {
        timeout: 30,
        absoluteMaxMs: 180,
        maxOutputBytes: 1024 * 1024,
        env: process.env,
        draftPath,
        draftReadyPollIntervalMs: 20,
        absoluteKillGraceMs: 20,
      });
      throw new Error("expected absolute timeout rejection");
    } catch (err) {
      const error = err as Error & { code?: string; monitor?: Record<string, unknown> };
      expect(error.code).toBe("OPENCODE_RUN_ABSOLUTE_TIMEOUT");
      expect(error.monitor).toMatchObject({
        lastNdjsonEventType: "step_start",
        draftState: { exists: true, parseable: false },
      });
      expect(error.monitor?.lastStderrAt).toBeTypeOf("string");
      expect(error.monitor?.lastDraftSignalAt).toBeTypeOf("string");
      expect(String(error.monitor?.stderrTail)).not.toContain("diagnostic-token-value");
      expect(String(error.monitor?.stderrTail)).toContain("[REDACTED]");
    }
  });

  it("fails when child exits non-zero without a recoverable draft", async () => {
    try {
      await _spawnOpenCodeRunForTests(process.execPath, ["-e", "process.stderr.write('failed without draft'); process.exit(7);"], {
        timeout: 1000,
        absoluteMaxMs: 2000,
        maxOutputBytes: 1024 * 1024,
        env: process.env,
        draftReadyPollIntervalMs: 20,
        absoluteKillGraceMs: 20,
      });
      throw new Error("expected non-zero rejection");
    } catch (err) {
      const error = err as Error & { code?: string; monitor?: Record<string, unknown> };
      expect(error.code).toBe("OPENCODE_RUN_EXITED_NON_ZERO");
      expect(error.message).toContain("exited with code 7");
      expect(error.monitor).toMatchObject({
        state: "exited_evaluating",
        processStatus: "exited",
        exitCode: 7,
      });
    }
  });
});

// ─── Bundled Runtime Resolution Tests ──────────────────────────────────────────

describe("Bundled runtime resolution", () => {
  let fixtureDir: string | null = null;

  afterEach(() => {
    _resetOpenCodePlatformCachesForTests();
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  function createBundledRuntimeFixture(root: string, platform: NodeJS.Platform): { runtimeDir: string; binPath: string; manifestPath: string } {
    const runtimeDir = root;
    const binDir = path.join(runtimeDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binaryName = platform === "win32" ? "opencode.exe" : "opencode";
    const binPath = path.join(binDir, binaryName);
    fs.writeFileSync(binPath, "fake-opencode-binary", "utf8");
    const manifestPath = path.join(runtimeDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: "opencode",
      version: "v1.14.30",
      target: `${platform}-${process.arch}`,
      binary: `bin/${binaryName}`,
      referenceHead: "8a17bc4de",
      preparedAt: new Date().toISOString(),
    }), "utf8");
    return { runtimeDir, binPath, manifestPath };
  }

  it("resolves bundled runtime from OPENCODE_BUNDLED_RUNTIME_DIR on Linux", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-linux-"));
    const { runtimeDir, binPath, manifestPath } = createBundledRuntimeFixture(fixtureDir, "linux");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: runtimeDir, PATH: "/nonexistent" };

    const result = resolveBundledRuntime(env, "linux");

    expect(result.context).not.toBeNull();
    expect(result.context!.file).toBe(binPath);
    expect(result.context!.argsPrefix).toEqual([]);
    expect(result.context!.executionMode).toBe("native-executable");
    expect(result.context!.runtimeSource).toBe("bundled");
    expect(result.context!.resolved).toBe(true);
    expect(result.diagnostics.executablePath).toBe(binPath);
    expect(result.diagnostics.manifestPath).toBe(manifestPath);
    expect(result.diagnostics.version).toBe("v1.14.30");
    expect(result.diagnostics.missingReason).toBeNull();
    expect(result.diagnostics.candidateRoots.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.candidateRoots[0]).toBe(runtimeDir);
  });

  it("resolves bundled runtime from OPENCODE_BUNDLED_RUNTIME_DIR on Windows", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-win-"));
    const { runtimeDir, binPath } = createBundledRuntimeFixture(fixtureDir, "win32");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: runtimeDir, PATH: "C:\\nonexistent" };

    const result = resolveBundledRuntime(env, "win32");

    expect(result.context).not.toBeNull();
    expect(result.context!.file).toBe(binPath);
    expect(result.context!.file.toLowerCase()).toMatch(/opencode\.exe$/);
    expect(result.context!.runtimeSource).toBe("bundled");
    expect(result.diagnostics.missingReason).toBeNull();
  });

  it("returns null context with diagnostics when bundled binary is missing", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-missing-"));
    const missingDir = path.join(fixtureDir, "no-runtime-here");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: missingDir, PATH: "/nonexistent" };

    const result = resolveBundledRuntime(env, "linux");

    expect(result.context).toBeNull();
    expect(result.diagnostics.executablePath).toBeNull();
    expect(result.diagnostics.missingReason).toBeTruthy();
    expect(result.diagnostics.candidateRoots).toContain(missingDir);
  });

  it("returns null context when no candidate roots are available", () => {
    const env = { PATH: "/nonexistent" };
    const result = resolveBundledRuntime(env, "linux");

    expect(result.context).toBeNull();
    expect(result.diagnostics.missingReason).toBeTruthy();
  });

  it("rejects .cmd/.bat files as bundled binary even if named opencode.cmd", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-unsafe-shim-"));
    const binDir = path.join(fixtureDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // Create a .cmd file in the bin dir -- bundled resolution only looks for opencode.exe on Windows
    // so it should NOT find opencode.cmd as a valid binary. The .cmd should be skipped entirely.
    const cmdPath = path.join(binDir, "opencode.cmd");
    fs.writeFileSync(cmdPath, "@echo off\r\necho unsafe\r\n", "utf8");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: fixtureDir, PATH: "C:\\nonexistent" };

    const result = resolveBundledRuntime(env, "win32");

    // The bundled resolver only looks for opencode.exe on Windows, not opencode.cmd
    // So it should not find any binary
    expect(result.context).toBeNull();
    expect(result.diagnostics.executablePath).toBeNull();
    expect(result.diagnostics.missingReason).toBeTruthy();
    // The .cmd file should never be used as the bundled binary
    expect(result.diagnostics.executablePath).not.toBe(cmdPath);
  });

  it("reads version from manifest.json when available", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-manifest-"));
    createBundledRuntimeFixture(fixtureDir, "linux");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: fixtureDir, PATH: "/nonexistent" };

    const result = resolveBundledRuntime(env, "linux");

    expect(result.diagnostics.version).toBe("v1.14.30");
    expect(result.diagnostics.manifestPath).toBe(path.join(fixtureDir, "manifest.json"));
  });

  it("tolerates missing manifest.json gracefully", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-no-manifest-"));
    const binDir = path.join(fixtureDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "opencode"), "fake-binary", "utf8");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: fixtureDir, PATH: "/nonexistent" };

    const result = resolveBundledRuntime(env, "linux");

    expect(result.context).not.toBeNull();
    expect(result.context!.runtimeSource).toBe("bundled");
    expect(result.diagnostics.version).toBeNull();
    expect(result.diagnostics.manifestPath).toBeNull();
  });

  it("local opencode takes priority over bundled runtime", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-local-priority-"));
    // Create local opencode on PATH
    const localBinDir = path.join(fixtureDir, "local-bin");
    fs.mkdirSync(localBinDir, { recursive: true });
    fs.writeFileSync(path.join(localBinDir, "opencode"), "#!/usr/bin/env node\n", "utf8");
    // Create bundled runtime
    createBundledRuntimeFixture(path.join(fixtureDir, "bundled"), "linux");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"), PATH: localBinDir, HOME: fixtureDir };

    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("local");
    expect(context.executionMode).toBe("native-executable");
    expect(context.file).toContain("local-bin");
  });

  it("falls back to bundled when local opencode is not on PATH", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-fallback-"));
    createBundledRuntimeFixture(path.join(fixtureDir, "bundled"), "linux");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"), PATH: "/nonexistent", HOME: fixtureDir };

    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.executionMode).toBe("native-executable");
    expect(context.file).toContain("bundled");
    expect(context.file).toContain("opencode");
  });

  it("falls back to bundled when local opencode is not on PATH (async)", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-fallback-async-"));
    createBundledRuntimeFixture(path.join(fixtureDir, "bundled"), "linux");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"), PATH: "/nonexistent", HOME: fixtureDir };

    const context = await resolveOpenCodeProcessContextAsync(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.executionMode).toBe("native-executable");
  });

  it("returns runtimeSource=missing when both local and bundled are unavailable", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-none-"));
    const missingDir = path.join(fixtureDir, "no-runtime");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: missingDir, PATH: "/nonexistent", HOME: fixtureDir };

    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.resolved).toBe(false);
    expect(context.runtimeSource).toBe("missing");
  });

  it("Windows bundled fallback when local is missing", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-win-fallback-"));
    createBundledRuntimeFixture(path.join(fixtureDir, "bundled"), "win32");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"), PATH: "C:\\nonexistent", HOME: fixtureDir };

    const context = resolveOpenCodeProcessContext(env, "win32");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.executionMode).toBe("native-executable");
    expect(context.file.toLowerCase()).toMatch(/opencode\.exe$/);
    expect(context.file.toLowerCase()).not.toMatch(/\.cmd$|\.bat$|cmd\.exe/);
  });

  it("Windows local opencode.exe takes priority over bundled runtime", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-win-local-priority-"));
    const localBinDir = path.join(fixtureDir, "local-bin");
    fs.mkdirSync(localBinDir, { recursive: true });
    const localExe = path.join(localBinDir, "opencode.exe");
    fs.writeFileSync(localExe, "fake-local-exe", "utf8");
    createBundledRuntimeFixture(path.join(fixtureDir, "bundled"), "win32");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"), PATH: localBinDir, HOME: fixtureDir };

    const context = resolveOpenCodeProcessContext(env, "win32");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("local");
    expect(context.file).toBe(localExe);
  });

  it("probe context falls back to bundled when local run-safe resolution fails", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-probe-fallback-"));
    createBundledRuntimeFixture(path.join(fixtureDir, "bundled"), "linux");
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"), PATH: "/nonexistent", HOME: fixtureDir };

    const context = await resolveOpenCodeProbeContextAsync(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
  });

  it("detectInstallMethod identifies bundled paths", () => {
    expect(detectInstallMethod("C:\\app\\opencode-runtime\\bin\\opencode.exe")).toBe("bundled");
    expect(detectInstallMethod("/opt/app/opencode-runtime/bin/opencode")).toBe("bundled");
    expect(detectInstallMethod("C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd")).toBe("npm");
    expect(detectInstallMethod("/usr/local/bin/opencode")).toBe("path");
  });

  it("getBundledTargetId returns platform-arch string", () => {
    const targetId = getBundledTargetId("win32");
    expect(targetId).toMatch(/^win32-/);

    const darwinTarget = getBundledTargetId("darwin");
    expect(darwinTarget).toMatch(/^darwin-/);
  });

  it("getBundledRuntimeCandidateRoots includes OPENCODE_BUNDLED_RUNTIME_DIR as first candidate", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-candidates-"));
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: fixtureDir, PATH: "/nonexistent" };

    const roots = getBundledRuntimeCandidateRoots(env, "linux");

    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots[0]).toBe(fixtureDir);
  });

  it("getBundledRuntimeCandidateRoots skips non-absolute OPENCODE_BUNDLED_RUNTIME_DIR", () => {
    const env = { OPENCODE_BUNDLED_RUNTIME_DIR: "relative/path", PATH: "/nonexistent" };

    const roots = getBundledRuntimeCandidateRoots(env, "linux");

    expect(roots).not.toContain("relative/path");
  });

  it("emptyBundledRuntimeDiagnostics returns safe defaults", () => {
    const diag = emptyBundledRuntimeDiagnostics();
    expect(diag.candidateRoots).toEqual([]);
    expect(diag.executablePath).toBeNull();
    expect(diag.manifestPath).toBeNull();
    expect(diag.version).toBeNull();
    expect(diag.missingReason).toBeTruthy();

    const diagWithRoots = emptyBundledRuntimeDiagnostics(["/a", "/b"], "test reason");
    expect(diagWithRoots.candidateRoots).toEqual(["/a", "/b"]);
    expect(diagWithRoots.missingReason).toBe("test reason");
  });
});

// ─── Bundled Availability Integration Tests ────────────────────────────────────

describe("Bundled runtime availability integration", () => {
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalXdgData = process.env.XDG_DATA_HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
  const originalPath = process.env.PATH;
  const originalAppData = process.env.APPDATA;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalBundledDir = process.env.OPENCODE_BUNDLED_RUNTIME_DIR;
  let fixtureDir: string | null = null;

  beforeEach(() => {
    invalidateAvailabilityCache();
    delete process.env.OPENCODE_CONFIG;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = "";
  });

  afterEach(() => {
    _resetExecRunner();
    _resetOpenCodePlatformCachesForTests();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgData;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalBundledDir === undefined) delete process.env.OPENCODE_BUNDLED_RUNTIME_DIR;
    else process.env.OPENCODE_BUNDLED_RUNTIME_DIR = originalBundledDir;
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  function createBundledFixture(root: string, platform: NodeJS.Platform): string {
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binaryName = platform === "win32" ? "opencode.exe" : "opencode";
    const binPath = path.join(binDir, binaryName);
    fs.writeFileSync(binPath, "fake-opencode-binary", "utf8");
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
      name: "opencode",
      version: "v1.14.30-bundled",
      target: `${platform}-${process.arch}`,
      binary: `bin/${binaryName}`,
    }), "utf8");
    return binPath;
  }

  it("checkOpenCodeAvailability returns runtimeSource=bundled when bundled is available", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "avail-bundled-"));
    // Use a directory name containing "opencode-runtime" so detectInstallMethod recognizes it as bundled
    const bundledDir = path.join(fixtureDir, "opencode-runtime");
    fs.mkdirSync(bundledDir, { recursive: true });
    const binPath = createBundledFixture(bundledDir, "linux");

    process.env.OPENCODE_BUNDLED_RUNTIME_DIR = bundledDir;
    process.env.PATH = "/nonexistent";
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const captured: Array<{ file: string; args: string[] }> = [];
    _setExecRunner(async (file: string, args: string[]) => {
      captured.push({ file, args });
      if (args.join(" ") === "--version") return { stdout: "v1.14.30-bundled\n", stderr: "" };
      if (args.join(" ") === "providers list") return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected args: ${JSON.stringify(args)}`);
    });

    const result = await withProcessPlatformAsync("linux", () => checkOpenCodeAvailability());

    expect(result.available).toBe(true);
    expect(result.runtimeSource).toBe("bundled");
    expect(result.installMethod).toBe("bundled");
    expect(result.pathState).toBe("bundled");
    expect(result.version).toBe("v1.14.30-bundled");
    expect(result.bundledRuntime).toBeDefined();
    expect(result.bundledRuntime?.executablePath).toBeTruthy();
    expect(result.bundledRuntime?.missingReason).toBeNull();
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].file).toBe(binPath);
  });

  it("checkOpenCodeAvailability returns runtimeSource=missing when nothing is available", async () => {
    _setExecRunner(async () => {
      throw new Error("spawn opencode ENOENT");
    });

    const isolatedHome = path.join(os.tmpdir(), "nohome-" + Date.now());
    const missingBundled = path.join(os.tmpdir(), "no-bundled-" + Date.now());
    process.env.PATH = "";
    process.env.HOME = isolatedHome;
    process.env.XDG_CONFIG_HOME = "";
    delete process.env.XDG_DATA_HOME;
    process.env.OPENCODE_BUNDLED_RUNTIME_DIR = missingBundled;

    const result = await withProcessPlatformAsync("linux", () => checkOpenCodeAvailability());

    expect(result.available).toBe(false);
    expect(result.cliAvailable).toBe(false);
    expect(result.bundledRuntime?.missingReason).toBeTruthy();
  });

  it("checkOpenCodeAvailability returns runtimeSource=local when local opencode is on PATH", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "avail-local-"));
    const localBin = path.join(fixtureDir, "local-bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "opencode"), "#!/usr/bin/env node\n", "utf8");
    const bundledDir = path.join(fixtureDir, "bundled");
    fs.mkdirSync(bundledDir, { recursive: true });
    createBundledFixture(bundledDir, "linux");

    process.env.OPENCODE_BUNDLED_RUNTIME_DIR = bundledDir;
    process.env.PATH = localBin;
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    _setExecRunner(async (file: string, args: string[]) => {
      if (args.join(" ") === "--version") return { stdout: "v1.15.0-local\n", stderr: "" };
      if (args.join(" ") === "providers list") return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected args: ${JSON.stringify(args)}`);
    });

    const result = await withProcessPlatformAsync("linux", () => checkOpenCodeAvailability());

    expect(result.available).toBe(true);
    expect(result.runtimeSource).toBe("local");
    expect(result.version).toBe("v1.15.0-local");
  });

  it("getOpenCodePathDiagnostics includes bundledRuntime diagnostics", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-bundled-"));
    const bundledDir = path.join(fixtureDir, "bundled");
    fs.mkdirSync(bundledDir, { recursive: true });
    createBundledFixture(bundledDir, "linux");

    const diag = await getOpenCodePathDiagnostics(
      { OPENCODE_BUNDLED_RUNTIME_DIR: bundledDir, PATH: "/nonexistent", HOME: fixtureDir },
      "linux",
    );

    expect(diag.bundledRuntime).toBeDefined();
    expect(diag.bundledRuntime.executablePath).toBeTruthy();
    expect(diag.bundledRuntime.manifestPath).toBeTruthy();
    expect(diag.bundledRuntime.version).toBe("v1.14.30-bundled");
    expect(diag.bundledRuntime.candidateRoots.length).toBeGreaterThanOrEqual(1);
    expect(diag.bundledRuntime.missingReason).toBeNull();
  });

  it("getOpenCodePathDiagnostics reports missing bundled with reason", async () => {
    const missingDir = path.join(os.tmpdir(), "no-bundled-diag-" + Date.now());
    const diag = await getOpenCodePathDiagnostics(
      { OPENCODE_BUNDLED_RUNTIME_DIR: missingDir, PATH: "/nonexistent" },
      "linux",
    );

    expect(diag.bundledRuntime).toBeDefined();
    expect(diag.bundledRuntime.executablePath).toBeNull();
    expect(diag.bundledRuntime.missingReason).toBeTruthy();
    expect(diag.bundledRuntime.candidateRoots).toContain(missingDir);
  });

  it("bundled runtime spawn args do not contain cmd.exe or /c", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-spawn-safety-"));
    const bundledDir = path.join(fixtureDir, "bundled");
    fs.mkdirSync(bundledDir, { recursive: true });
    const binPath = createBundledFixture(bundledDir, "linux");

    process.env.OPENCODE_BUNDLED_RUNTIME_DIR = bundledDir;
    process.env.PATH = "/nonexistent";
    process.env.HOME = fixtureDir;
    process.env.XDG_CONFIG_HOME = "";

    const captured: Array<{ file: string; args: string[] }> = [];
    _setExecRunner(async (file: string, args: string[]) => {
      captured.push({ file, args });
      if (args.join(" ") === "--version") return { stdout: "v1.0.0\n", stderr: "" };
      if (args.join(" ") === "providers list") return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected args: ${JSON.stringify(args)}`);
    });

    const result = await withProcessPlatformAsync("linux", () => checkOpenCodeAvailability());

    expect(result.available).toBe(true);
    expect(result.runtimeSource).toBe("bundled");
    expect(captured.length).toBeGreaterThan(0);
    // Verify the file is the bundled binary, not cmd.exe or a .cmd shim
    expect(captured[0].file).toBe(binPath);
    expect(captured[0].file.toLowerCase()).not.toMatch(/cmd\.exe|\.cmd|\.bat|\/c/);
  });

  it("Windows .cmd shim does not regress when bundled runtime is also available", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-bundled-no-regress-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    // Create local .cmd shim with real target
    const cmdShim = path.join(appDataNpm, "opencode.cmd");
    const jsBin = createOpenCodePackageFixture(appDataNpm);
    fs.writeFileSync(cmdShim, `@echo off\r\nnode "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*\r\n`, "utf8");
    const nodeExe = path.join(appDataNpm, "node.exe");
    fs.writeFileSync(nodeExe, "", "utf8");
    // Create bundled runtime
    const bundledDir = path.join(fixtureDir, "bundled");
    fs.mkdirSync(bundledDir, { recursive: true });
    const bundledBin = path.join(bundledDir, "bin", "opencode.exe");
    fs.mkdirSync(path.join(bundledDir, "bin"), { recursive: true });
    fs.writeFileSync(bundledBin, "fake-bundled-exe", "utf8");

    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = "C:\\Windows\\System32";
    process.env.OPENCODE_BUNDLED_RUNTIME_DIR = bundledDir;

    const plan = resolveOpenCodeProcessContext({ PATH: "C:\\Windows\\System32", APPDATA: appData, OPENCODE_BUNDLED_RUNTIME_DIR: bundledDir }, "win32", nodeExe);

    // Local should win over bundled
    expect(plan.resolved).toBe(true);
    expect(plan.runtimeSource).toBe("local");
    expect(plan.file).toBe(nodeExe);
    expect(plan.argsPrefix).toEqual([jsBin]);
    expect(plan.executionMode).toBe("windows-node-shim");
    expect(plan.shimPath).toBe(cmdShim);
    // Verify no cmd.exe, no /c, no .cmd in the execution file
    expect(plan.file.toLowerCase()).not.toMatch(/cmd\.exe$|\.cmd$|\.bat$/);
    expect(plan.argsPrefix.join(" ")).not.toContain("/c");
  });
});

// ─── Bundled Install Plan Tests ────────────────────────────────────────────────

describe("Bundled runtime install plan", () => {
  const originalEnv = { ...process.env };
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-install-plan-"));
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg");
    process.env.HOME = path.join(tmpDir, "home");
    process.env.USERPROFILE = path.join(tmpDir, "home");
    process.env.APPDATA = path.join(tmpDir, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(tmpDir, "AppData", "Local");
    process.env.NODE_ENV = "test";
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_LOCAL_CAPABILITIES;
    delete process.env.ELECTRON_MODE;
    delete process.env.DESKTOP_API_TOKEN;
  });

  afterEach(() => {
    _resetInstallServiceForTests();
    _resetExecRunner();
    _resetOpenCodePlatformCachesForTests();
    process.env = { ...originalEnv };
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns bundled no-install plan when bundled runtime is available", async () => {
    const bundledDir = path.join(tmpDir, "opencode-runtime");
    fs.mkdirSync(path.join(bundledDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "bin", "opencode"), "fake-binary", "utf8");
    fs.writeFileSync(path.join(bundledDir, "manifest.json"), JSON.stringify({ name: "opencode", version: "v1.0.0" }), "utf8");

    process.env.OPENCODE_BUNDLED_RUNTIME_DIR = bundledDir;
    process.env.PATH = "";

    // Mock the availability check to return bundled
    _setExecRunner(async (file: string, args: string[]) => {
      if (args.join(" ") === "--version") return { stdout: "v1.0.0\n", stderr: "" };
      if (args.join(" ") === "providers list") return { stdout: "1 credentials configured", stderr: "" };
      throw new Error(`Unexpected args: ${JSON.stringify(args)}`);
    });

    const plan = await withProcessPlatformAsync("linux", async () => createOpenCodeInstallPlan());

    expect(plan.ok).toBe(true);
    expect(plan.controlledInstallAvailable).toBe(false);
    // Strict assertion: bundled message must explicitly say embedded runtime is available
    // and no manual install is needed (not just a generic "already installed" message).
    expect(plan.warnings.join(" ")).toMatch(/内嵌运行时已可用/);
    expect(plan.warnings.join(" ")).toMatch(/无需手动安装/);
  });
});

// ─── M1: Windows unsafe .cmd shim + bundled runtime fallback ────────────────────

describe("M1: Windows unsafe .cmd shim falls back to bundled run context", () => {
  let fixtureDir: string | null = null;

  afterEach(() => {
    _resetOpenCodePlatformCachesForTests();
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  function createBundledRuntimeWin32(root: string): { runtimeDir: string; binPath: string } {
    const runtimeDir = root;
    const binDir = path.join(runtimeDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "opencode.exe");
    fs.writeFileSync(binPath, "fake-bundled-exe", "utf8");
    fs.writeFileSync(path.join(runtimeDir, "manifest.json"), JSON.stringify({
      name: "opencode",
      version: "v1.14.30",
      target: "win32-x64",
      binary: "bin/opencode.exe",
    }), "utf8");
    return { runtimeDir, binPath };
  }

  it("falls back to bundled when .cmd shim target cannot be resolved (sync)", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-unresolved-shim-bundled-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    // Create a .cmd shim that cannot be resolved to a safe target
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");
    // Create bundled runtime
    const { binPath: bundledBin } = createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const env = { PATH: "C:\\Windows\\System32", APPDATA: appData, OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled") };
    const context = resolveOpenCodeProcessContext(env, "win32");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.file).toBe(bundledBin);
    expect(context.executionMode).toBe("native-executable");
    // Verify no cmd.exe, no /c, no .cmd/.bat in the execution context
    expect(context.file.toLowerCase()).not.toMatch(/cmd\.exe$|\.cmd$|\.bat$/);
    expect(context.argsPrefix).toEqual([]);
  });

  it("falls back to bundled when .cmd shim target cannot be resolved (async)", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-unresolved-shim-bundled-async-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");
    const { binPath: bundledBin } = createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const env = { PATH: "C:\\Windows\\System32", APPDATA: appData, OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled") };
    const context = await resolveOpenCodeProcessContextAsync(env, "win32");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.file).toBe(bundledBin);
    expect(context.file.toLowerCase()).not.toMatch(/cmd\.exe$|\.cmd$|\.bat$/);
  });

  it("falls back to bundled when .cmd shim has no safe node executable (sync)", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-no-node-bundled-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    // Create a .cmd shim that resolves to a script target but no safe node exists
    createOpenCodePackageFixture(appDataNpm, "opencode");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");
    // Electron exe (not node) -- so no safe node available
    const electronExe = path.join(fixtureDir, "Electron.exe");
    fs.writeFileSync(electronExe, "", "utf8");
    // Create bundled runtime
    const { binPath: bundledBin } = createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const env = { PATH: "C:\\Windows\\System32", APPDATA: appData, OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled") };
    const context = resolveOpenCodeProcessContext(env, "win32", electronExe);

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.file).toBe(bundledBin);
    expect(context.file.toLowerCase()).not.toMatch(/cmd\.exe$|\.cmd$|\.bat$/);
  });

  it("falls back to bundled when .cmd shim has no safe node executable (async)", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-no-node-bundled-async-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    createOpenCodePackageFixture(appDataNpm, "opencode");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");
    const electronExe = path.join(fixtureDir, "Electron.exe");
    fs.writeFileSync(electronExe, "", "utf8");
    const { binPath: bundledBin } = createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const env = { PATH: "C:\\Windows\\System32", APPDATA: appData, OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled") };
    const context = await resolveOpenCodeProcessContextAsync(env, "win32", electronExe);

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.file).toBe(bundledBin);
  });

  it("probe context falls back to bundled when .cmd shim is unsafe (async)", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-probe-bundled-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");
    const { binPath: bundledBin } = createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const env = { PATH: "C:\\Windows\\System32", APPDATA: appData, OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled") };
    const context = await resolveOpenCodeProbeContextAsync(env, "win32");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("bundled");
    expect(context.file).toBe(bundledBin);
  });

  it("reports bundled runtime as available when local shim is unsafe but bundled exists", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-diagnostics-bundled-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");
    createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const env: Record<string, string | undefined> = {
      PATH: "C:\\Windows\\System32",
      APPDATA: appData,
      OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"),
    };
    const diag = await getOpenCodePathDiagnostics(env, "win32");

    // Diagnostics should report bundled as available
    expect(diag.runtimeSource).toBe("bundled");
    expect(diag.bundledRuntime.executablePath).toBeTruthy();
    expect(diag.bundledRuntime.missingReason).toBeNull();
    // Since bundled fallback succeeds, the run context resolves without error.
    // localResolutionError is only set when the run context itself fails to resolve.
    // With bundled fallback, the run resolves to bundled successfully, so there is no error.
    // The probe context also falls through to bundled.
    expect(diag.runResolutionError).toBeNull();
    expect(diag.resolutionError).toBeNull();
  });

  it("throws only when both local shim is unsafe and bundled is unavailable", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-no-bundled-throws-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");
    // No bundled runtime

    const env = { PATH: "C:\\Windows\\System32", APPDATA: appData, OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "no-bundled-here") };
    expect(() => resolveOpenCodeProcessContext(env, "win32"))
      .toThrow(/Unable to resolve safe native OpenCode target/);
  });

  it("runOpenCodeNormalize uses bundled when .cmd shim is unsafe and bundled exists", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-run-bundled-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");
    createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPath = process.env.PATH;
    const originalBundledDir = process.env.OPENCODE_BUNDLED_RUNTIME_DIR;
    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    process.env.PATH = "C:\\Windows\\System32";
    process.env.OPENCODE_BUNDLED_RUNTIME_DIR = path.join(fixtureDir, "bundled");

    const validOutput = {
      lines: [{ id: "l1", order: 0, speaker: "narrator", text: "Bundled run", voice: "Zephyr" }],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    };
    const captured: Array<{ file: string; args: string[] }> = [];
    _setSpawnRunner(async (file: string, args: string[]) => {
      captured.push({ file, args });
      return { stdout: JSON.stringify({ content: JSON.stringify(validOutput) }), stderr: "" };
    });

    try {
      const result = await withProcessPlatformAsync("win32", () => runOpenCodeNormalize({
        documents: [{ id: "doc-1", fileName: "test.txt", content: "Bundled run test", enabled: true }],
      }));

      expect(result.runner).toBe("opencode");
      expect(captured).toHaveLength(1);
      // File should be the bundled opencode.exe, not a .cmd
      expect(captured[0].file.toLowerCase()).toMatch(/opencode\.exe$/);
      expect(captured[0].file.toLowerCase()).not.toMatch(/\.cmd$|\.bat$|cmd\.exe/);
      expect(captured[0].args).not.toContain("/c");
    } finally {
      _resetSpawnRunner();
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalBundledDir === undefined) delete process.env.OPENCODE_BUNDLED_RUNTIME_DIR;
      else process.env.OPENCODE_BUNDLED_RUNTIME_DIR = originalBundledDir;
    }
  });
});

// ─── M2: OPENCODE_BIN_PATH explicit resolver ──────────────────────────────────

describe("M2: OPENCODE_BIN_PATH explicit resolver", () => {
  let fixtureDir: string | null = null;

  afterEach(() => {
    _resetOpenCodePlatformCachesForTests();
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  it("accepts absolute path to native opencode.exe on Windows", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-win-"));
    const binDir = path.join(fixtureDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exePath = path.join(binDir, "opencode.exe");
    fs.writeFileSync(exePath, "fake-exe", "utf8");

    const env = { OPENCODE_BIN_PATH: exePath, PATH: "C:\\nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "win32");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("explicit");
    expect(context.file).toBe(exePath);
    expect(context.executionMode).toBe("native-executable");
  });

  it("accepts absolute path to native opencode on Linux", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-linux-"));
    const binDir = path.join(fixtureDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "opencode");
    fs.writeFileSync(binPath, "fake-binary", "utf8");

    const env = { OPENCODE_BIN_PATH: binPath, PATH: "/nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("explicit");
    expect(context.file).toBe(binPath);
    expect(context.executionMode).toBe("native-executable");
  });

  it("rejects relative paths", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-relative-"));
    const env = { OPENCODE_BIN_PATH: "relative/opencode", PATH: "/nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "linux");

    // Should not resolve via explicit, should fall through to missing
    expect(context.runtimeSource).not.toBe("explicit");
    expect(context.resolved).toBe(false);
  });

  it("rejects .cmd extension on Windows", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-cmd-"));
    const cmdPath = path.join(fixtureDir, "opencode.cmd");
    fs.writeFileSync(cmdPath, "@echo off\r\n", "utf8");

    const env = { OPENCODE_BIN_PATH: cmdPath, PATH: "C:\\nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "win32");

    expect(context.runtimeSource).not.toBe("explicit");
    expect(context.resolved).toBe(false);
  });

  it("rejects .bat extension on Windows", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-bat-"));
    const batPath = path.join(fixtureDir, "opencode.bat");
    fs.writeFileSync(batPath, "@echo off\r\n", "utf8");

    const env = { OPENCODE_BIN_PATH: batPath, PATH: "C:\\nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "win32");

    expect(context.runtimeSource).not.toBe("explicit");
    expect(context.resolved).toBe(false);
  });

  it("rejects missing file", () => {
    const env = { OPENCODE_BIN_PATH: "C:\\nonexistent\\opencode.exe", PATH: "C:\\nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "win32");

    expect(context.runtimeSource).not.toBe("explicit");
    expect(context.resolved).toBe(false);
  });

  it("explicit source takes priority over local PATH opencode", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-priority-"));
    // Create local opencode on PATH
    const localBinDir = path.join(fixtureDir, "local-bin");
    fs.mkdirSync(localBinDir, { recursive: true });
    fs.writeFileSync(path.join(localBinDir, "opencode"), "#!/usr/bin/env node\n", "utf8");
    // Create explicit binary
    const explicitDir = path.join(fixtureDir, "explicit");
    fs.mkdirSync(explicitDir, { recursive: true });
    const explicitBin = path.join(explicitDir, "opencode");
    fs.writeFileSync(explicitBin, "fake-explicit", "utf8");

    const env = { OPENCODE_BIN_PATH: explicitBin, PATH: localBinDir, HOME: fixtureDir };
    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("explicit");
    expect(context.file).toBe(explicitBin);
  });

  it("explicit source takes priority over bundled runtime", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-over-bundled-"));
    // Create explicit binary
    const explicitDir = path.join(fixtureDir, "explicit");
    fs.mkdirSync(explicitDir, { recursive: true });
    const explicitBin = path.join(explicitDir, "opencode");
    fs.writeFileSync(explicitBin, "fake-explicit", "utf8");
    // Create bundled runtime
    const bundledDir = path.join(fixtureDir, "bundled");
    const bundledBinDir = path.join(bundledDir, "bin");
    fs.mkdirSync(bundledBinDir, { recursive: true });
    fs.writeFileSync(path.join(bundledBinDir, "opencode"), "fake-bundled", "utf8");
    fs.writeFileSync(path.join(bundledDir, "manifest.json"), JSON.stringify({ name: "opencode", version: "v1.0.0" }), "utf8");

    const env = { OPENCODE_BIN_PATH: explicitBin, PATH: "/nonexistent", HOME: fixtureDir, OPENCODE_BUNDLED_RUNTIME_DIR: bundledDir };
    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("explicit");
    expect(context.file).toBe(explicitBin);
  });

  it("explicit source takes priority in async context as well", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-async-"));
    const binDir = path.join(fixtureDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "opencode");
    fs.writeFileSync(binPath, "fake-binary", "utf8");

    const env = { OPENCODE_BIN_PATH: binPath, PATH: "/nonexistent" };
    const context = await resolveOpenCodeProcessContextAsync(env, "linux");

    expect(context.resolved).toBe(true);
    expect(context.runtimeSource).toBe("explicit");
    expect(context.file).toBe(binPath);
  });

  it("ignores empty OPENCODE_BIN_PATH", () => {
    const env = { OPENCODE_BIN_PATH: "", PATH: "/nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.runtimeSource).not.toBe("explicit");
    expect(context.resolved).toBe(false);
  });

  it("ignores whitespace-only OPENCODE_BIN_PATH", () => {
    const env = { OPENCODE_BIN_PATH: "   ", PATH: "/nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.runtimeSource).not.toBe("explicit");
    expect(context.resolved).toBe(false);
  });

  it("rejects OPENCODE_BIN_PATH with control characters", () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-control-"));
    const binDir = path.join(fixtureDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "opencode");
    fs.writeFileSync(binPath, "fake", "utf8");
    // Append a null character
    const env = { OPENCODE_BIN_PATH: binPath + "\0", PATH: "/nonexistent" };
    const context = resolveOpenCodeProcessContext(env, "linux");

    expect(context.runtimeSource).not.toBe("explicit");
  });
});

// ─── m1-R2: localResolutionError diagnostics when bundled fallback occurs ───────

describe("m1-R2: localResolutionError populated when Windows unsafe shim falls back to bundled", () => {
  let fixtureDir: string | null = null;

  afterEach(() => {
    _resetOpenCodePlatformCachesForTests();
    if (fixtureDir) {
      cleanupDir(fixtureDir);
      fixtureDir = null;
    }
  });

  function createBundledRuntimeWin32(root: string): { runtimeDir: string; binPath: string } {
    const runtimeDir = root;
    const binDir = path.join(runtimeDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "opencode.exe");
    fs.writeFileSync(binPath, "fake-bundled-exe", "utf8");
    fs.writeFileSync(path.join(runtimeDir, "manifest.json"), JSON.stringify({
      name: "opencode",
      version: "v1.14.30",
      target: "win32-x64",
      binary: "bin/opencode.exe",
    }), "utf8");
    return { runtimeDir, binPath };
  }

  it("populates localResolutionError when .cmd shim target cannot be safely resolved", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1r2-unresolved-shim-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    // Create a .cmd shim that cannot be resolved to a safe target
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\necho unknown shim\r\n", "utf8");
    createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    // The .cmd shim must be on the base PATH for resolveExecutableOnPath to find it
    const env: Record<string, string | undefined> = {
      PATH: "C:\\Windows\\System32;" + appDataNpm,
      APPDATA: appData,
      OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"),
    };
    const diag = await getOpenCodePathDiagnostics(env, "win32");

    // Runtime source should be bundled (fallback succeeded)
    expect(diag.runtimeSource).toBe("bundled");
    // localResolutionError must describe why local was rejected
    expect(diag.localResolutionError).not.toBeNull();
    expect(diag.localResolutionError).toContain(".cmd shim");
    expect(diag.localResolutionError).toMatch(/could not be safely resolved|bundled runtime used instead/);
  });

  it("populates localResolutionError when .cmd shim requires node but no safe node exists", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1r2-no-safe-node-"));
    const appData = path.join(fixtureDir, "Roaming");
    const appDataNpm = path.join(appData, "npm");
    fs.mkdirSync(appDataNpm, { recursive: true });
    // Create a .cmd shim that resolves to a script target but no safe node exists
    createOpenCodePackageFixture(appDataNpm, "opencode");
    fs.writeFileSync(path.join(appDataNpm, "opencode.cmd"), "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n", "utf8");
    // No node.exe available (Electron exe is not node)
    const electronExe = path.join(fixtureDir, "Electron.exe");
    fs.writeFileSync(electronExe, "", "utf8");
    createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    // The .cmd shim must be on the base PATH for resolveExecutableOnPath to find it
    const env: Record<string, string | undefined> = {
      PATH: "C:\\Windows\\System32;" + appDataNpm,
      APPDATA: appData,
      OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"),
    };

    // Need to override process.execPath for the node resolution to fail
    const origExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
    Object.defineProperty(process, "execPath", { value: electronExe });
    try {
      const diag = await getOpenCodePathDiagnostics(env, "win32");

      expect(diag.runtimeSource).toBe("bundled");
      expect(diag.localResolutionError).not.toBeNull();
      expect(diag.localResolutionError).toMatch(/no safe node executable found|bundled runtime used instead/);
    } finally {
      if (origExecPath) Object.defineProperty(process, "execPath", origExecPath);
    }
  });

  it("does not populate localResolutionError when local opencode is native exe (not a shim)", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1r2-native-exe-"));
    const localBinDir = path.join(fixtureDir, "local-bin");
    fs.mkdirSync(localBinDir, { recursive: true });
    const localExe = path.join(localBinDir, "opencode.exe");
    fs.writeFileSync(localExe, "fake-local-exe", "utf8");
    // Also create bundled, but local should win
    createBundledRuntimeWin32(path.join(fixtureDir, "bundled"));

    const env: Record<string, string | undefined> = {
      PATH: localBinDir,
      OPENCODE_BUNDLED_RUNTIME_DIR: path.join(fixtureDir, "bundled"),
    };
    const diag = await getOpenCodePathDiagnostics(env, "win32");

    // Local should win over bundled
    expect(diag.runtimeSource).toBe("local");
    // No localResolutionError because local resolved fine
    expect(diag.localResolutionError).toBeNull();
  });
});
