import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import settingsRoutes from "../src/routes/settings.js";
import {
  maskApiKey,
  readOpenCodeConfigDisplay,
  resolveOpenCodeConfigPath,
  updateOpenCodeConfig,
} from "../src/services/opencode-config-service.js";
import { getOpenCodeRuntimeCapabilities } from "../src/services/opencode-runtime-gate.js";
import {
  OPENCODE_INSTALL_ARGS,
  _resetInstallServiceForTests,
  _setInstallProcessRunner,
  _setNpmCheckRunner,
  _setPostInstallAvailabilityChecker,
  checkPackageManagersAvailability,
  createOpenCodeInstallPlan,
  getLatestOpenCodeVersion,
  installOpenCodeControlled,
} from "../src/services/opencode-install-service.js";
import { resolveNpmCommand } from "../src/services/opencode-platform.js";

async function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await fn();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

function createApp() {
  const app = new Hono();
  app.route("/", settingsRoutes);
  return app;
}

function localRequest(pathname = "/api/settings/opencode/status", init?: RequestInit) {
  return new Request(`http://127.0.0.1:3001${pathname}`, {
    ...init,
    headers: {
      Host: "127.0.0.1:3001",
      Origin: "http://127.0.0.1:5173",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

describe("OpenCode settings backend services", () => {
  const originalEnv = { ...process.env };
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-settings-"));
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
    process.env = { ...originalEnv };
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("masks API keys without exposing short secrets", () => {
    expect(maskApiKey("short")).toBe("***");
    expect(maskApiKey("sk-very-secret-value")).toBe("sk-...lue");
  });

  it("resolves Windows OpenCode config path to official global location when no config exists", () => {
    const home = path.join(tmpDir, "UserHome");
    const appData = path.join(tmpDir, "AppData", "Roaming");
    const localAppData = path.join(tmpDir, "AppData", "Local");
    const resolved = resolveOpenCodeConfigPath({ HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData }, "win32");
    expect(resolved).toBe(path.join(home, ".config", "opencode", "opencode.json"));
  });

  it("prefers existing Windows official OpenCode config path over legacy AppData paths", () => {
    const home = path.join(tmpDir, "UserHome");
    const appData = path.join(tmpDir, "AppData", "Roaming");
    const officialConfig = path.join(home, ".config", "opencode", "opencode.json");
    const legacyConfig = path.join(appData, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(officialConfig), { recursive: true });
    fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
    fs.writeFileSync(officialConfig, "{}", "utf8");
    fs.writeFileSync(legacyConfig, "{}", "utf8");

    const resolved = resolveOpenCodeConfigPath({ HOME: home, USERPROFILE: home, APPDATA: appData }, "win32");
    expect(resolved).toBe(officialConfig);
  });

  it("uses OPENCODE_CONFIG absolute path ahead of discovered Windows config files", () => {
    const home = path.join(tmpDir, "UserHome");
    const overrideConfig = path.join(tmpDir, "custom", "opencode.json");
    const resolved = resolveOpenCodeConfigPath({ HOME: home, USERPROFILE: home, OPENCODE_CONFIG: overrideConfig }, "win32");
    expect(resolved).toBe(overrideConfig);
  });

  it("falls back to existing Windows legacy AppData OpenCode config path", () => {
    const home = path.join(tmpDir, "UserHome");
    const appData = path.join(tmpDir, "AppData", "Roaming");
    const legacyConfig = path.join(appData, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
    fs.writeFileSync(legacyConfig, "{}", "utf8");

    const resolved = resolveOpenCodeConfigPath({ HOME: home, USERPROFILE: home, APPDATA: appData }, "win32");
    expect(resolved).toBe(legacyConfig);
  });

  it("creates, keeps, sets, and clears OpenCode apiKey without returning plaintext", async () => {
    const initial = await readOpenCodeConfigDisplay("local");
    expect(initial.exists).toBe(false);
    expect(initial.providers[0].name).toBe("openrouter");

    const secret = "sk-test-secret-123456789";
    const saved = await updateOpenCodeConfig({
      expectedRevision: initial.revision,
      model: "openrouter/test-model",
      providers: [{ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKeyAction: "set", apiKey: secret }],
    });

    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(saved.providers[0].hasApiKey).toBe(true);
    expect(saved.providers[0].apiKeyMasked).toBe("sk-...789");

    const filePath = resolveOpenCodeConfigPath();
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(written.provider.openrouter.options.apiKey).toBe(secret);

    const display = await readOpenCodeConfigDisplay("local");
    const kept = await updateOpenCodeConfig({
      expectedRevision: display.revision,
      providers: [{ name: "openrouter", baseURL: "https://example.com/v1", apiKeyAction: "keep" }],
    });
    expect(JSON.stringify(kept)).not.toContain(secret);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).provider.openrouter.options.apiKey).toBe(secret);

    const afterKeep = await readOpenCodeConfigDisplay("local");
    const cleared = await updateOpenCodeConfig({
      expectedRevision: afterKeep.revision,
      providers: [{ name: "openrouter", apiKeyAction: "clear" }],
    });
    expect(cleared.providers[0].hasApiKey).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).provider.openrouter.options.apiKey).toBeUndefined();
  });

  it("rejects invalid model and production http baseURL", async () => {
    const display = await readOpenCodeConfigDisplay("local");
    await expect(updateOpenCodeConfig({ expectedRevision: display.revision, model: "" })).rejects.toMatchObject({ status: 400, code: "INVALID_MODEL" });
    await expect(updateOpenCodeConfig({
      expectedRevision: display.revision,
      providers: [{ name: "openrouter", baseURL: "http://api.example.com/v1" }],
    })).rejects.toMatchObject({ status: 400, code: "INVALID_BASE_URL" });
  });

  it("classifies desktop/local/web/remote runtime without enabling local capability by default", () => {
    let caps = getOpenCodeRuntimeCapabilities(localRequest());
    expect(caps.runtime).toBe("web");
    expect(caps.canDetectLocalOpenCode).toBe(false);

    process.env.OPENCODE_LOCAL_CAPABILITIES = "enabled";
    caps = getOpenCodeRuntimeCapabilities(localRequest());
    expect(caps.runtime).toBe("local");
    expect(caps.canInstall).toBe(true);

    caps = getOpenCodeRuntimeCapabilities(new Request("http://example.com/api/settings/opencode/status", { headers: { Host: "example.com", Origin: "https://evil.example" } }));
    expect(caps.runtime).toBe("remote");
    expect(caps.canReadConfig).toBe(false);

    process.env.ELECTRON_MODE = "true";
    process.env.DESKTOP_API_TOKEN = "desktop-secret";
    caps = getOpenCodeRuntimeCapabilities(localRequest("/api/settings/opencode/status", { headers: { "X-TTS-Desktop-Token": "desktop-secret" } }));
    expect(caps.runtime).toBe("desktop");
    expect(caps.canOpenConfig).toBe(true);
  });

  it("keeps web status from probing local machine and gates config routes", async () => {
    const app = createApp();
    const status = await app.fetch(localRequest());
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.runtime).toBe("web");
    expect(statusBody.availability).toBeNull();
    expect(statusBody.npm).toBeNull();

    const config = await app.fetch(localRequest("/api/settings/opencode/config"));
    expect(config.status).toBe(403);
  });

  it("uses a fixed npm install allowlist with no shell and requires confirmation", async () => {
    _setNpmCheckRunner(async () => ({ stdout: "10.0.0\n", stderr: "" }));
    const availabilityResults = [
      { available: false, version: null, error: "not installed" },
      { available: false, version: null, error: "not installed" },
      { available: false, version: null, error: "not installed" },
      { available: true, version: "v1.0.0", error: null },
    ];
    _setPostInstallAvailabilityChecker(async () => availabilityResults.shift() ?? { available: true, version: "v1.0.0", error: null });
    const captured: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    _setInstallProcessRunner(async (file, args, options) => {
      captured.push({ file, args, options });
      return { exitCode: 0, timedOut: false, stdout: "installed sk-secret-value-123456", stderr: "" };
    });

    const plan = await withProcessPlatform("linux", async () => createOpenCodeInstallPlan());
    await expect(installOpenCodeControlled({ nonce: plan.nonce, confirmationPhrase: "INSTALL_OPENCODE", confirm: false as true })).rejects.toMatchObject({ status: 400 });

    const { result } = await withProcessPlatform("linux", async () => {
      const plan2 = await createOpenCodeInstallPlan();
      return { result: await installOpenCodeControlled({ nonce: plan2.nonce, confirmationPhrase: "INSTALL_OPENCODE", confirm: true }) };
    });
    expect(result.ok).toBe(true);
    expect(result.stdoutTail).not.toContain("sk-secret-value-123456");
    expect(captured).toHaveLength(1);
    expect(captured[0].file).toBe("npm");
    expect(captured[0].args).toEqual(OPENCODE_INSTALL_ARGS);
    expect(captured[0].options.shell).toBe(false);
  });

  it("returns a no-install plan when OpenCode CLI is already executable", async () => {
    let npmChecked = false;
    _setNpmCheckRunner(async () => {
      npmChecked = true;
      return { stdout: "10.0.0\n", stderr: "" };
    });
    _setPostInstallAvailabilityChecker(async () => ({
      available: false,
      cliAvailable: true,
      runAvailable: false,
      version: "v1.0.0",
      error: "provider credentials are not configured",
    }));

    const plan = await createOpenCodeInstallPlan();

    expect(plan.ok).toBe(true);
    expect(plan.controlledInstallAvailable).toBe(false);
    expect(plan.installCandidates).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("无需重新安装");
    expect(npmChecked).toBe(false);
  });

  it("short-circuits controlled install after nonce when OpenCode CLI is already executable", async () => {
    _setNpmCheckRunner(async () => ({ stdout: "10.0.0\n", stderr: "" }));
    const availabilityResults = [
      { available: false, version: null, error: "not installed" },
      {
        available: false,
        cliAvailable: true,
        runAvailable: false,
        version: "v1.0.0",
        error: "provider credentials are not configured",
      },
    ];
    _setPostInstallAvailabilityChecker(async () => availabilityResults.shift() ?? { available: true, version: "v1.0.0", error: null });
    const captured: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    _setInstallProcessRunner(async (file, args, options) => {
      captured.push({ file, args, options });
      throw new Error("install runner should not be called when OpenCode is already available");
    });

    const plan = await createOpenCodeInstallPlan();
    const result = await installOpenCodeControlled({ nonce: plan.nonce, confirmationPhrase: "INSTALL_OPENCODE", confirm: true });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.packageManager).toBeNull();
    expect(result.availabilityAfterInstall?.available).toBe(false);
    expect(result.availabilityAfterInstall?.cliAvailable).toBe(true);
    expect(result.attempts).toEqual([]);
    expect(captured).toEqual([]);
  });

  it("resolves Windows npm through node plus npm-cli.js instead of npm.cmd", () => {
    const nodeDir = path.join(tmpDir, "nodejs");
    const npmBin = path.join(nodeDir, "node_modules", "npm", "bin");
    fs.mkdirSync(npmBin, { recursive: true });
    const npmCli = path.join(npmBin, "npm-cli.js");
    fs.writeFileSync(npmCli, "// npm cli fixture\n", "utf8");
    const shimDir = path.join(tmpDir, "npm-shims");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "npm.cmd"), "@echo off\r\n", "utf8");
    const nodeExe = path.join(nodeDir, "node.exe");
    fs.writeFileSync(nodeExe, "", "utf8");

    const resolved = resolveNpmCommand({ PATH: shimDir }, "win32", nodeExe);
    expect(resolved).not.toBeNull();
    expect(resolved?.command).toBe(nodeExe);
    expect(resolved?.argsPrefix).toEqual([npmCli]);
  });

  it("uses Windows-safe npm resolution for availability and controlled install", async () => {
    const npmBin = path.join(tmpDir, "npm-cli-bin");
    fs.mkdirSync(npmBin, { recursive: true });
    const npmCli = path.join(npmBin, "npm-cli.js");
    fs.writeFileSync(npmCli, "// npm cli fixture\n", "utf8");
    process.env.npm_execpath = npmCli;
    process.env.PATH = "C:\\Windows\\System32";

    const npmChecks: Array<{ file: string; args: string[] }> = [];
    _setNpmCheckRunner(async (file, args) => {
      npmChecks.push({ file, args });
      return { stdout: "10.0.0\n", stderr: "" };
    });
    const availabilityResults = [
      { available: false, version: null, error: "not installed" },
      { available: false, version: null, error: "not installed" },
      { available: true, version: "v1.0.0", error: null },
    ];
    _setPostInstallAvailabilityChecker(async () => availabilityResults.shift() ?? { available: true, version: "v1.0.0", error: null });

    const installs: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    _setInstallProcessRunner(async (file, args, options) => {
      installs.push({ file, args, options });
      return { exitCode: 0, timedOut: false, stdout: "installed", stderr: "" };
    });

    await withProcessPlatform("win32", async () => {
      const plan = await createOpenCodeInstallPlan();
      expect(plan.npm.available).toBe(true);
      const result = await installOpenCodeControlled({ nonce: plan.nonce, confirmationPhrase: "INSTALL_OPENCODE", confirm: true });
      expect(result.ok).toBe(true);
    });

    const npmVersionChecks = npmChecks.filter((call) => call.file === process.execPath && call.args.join("\0") === [npmCli, "--version"].join("\0"));
    expect(npmVersionChecks).toHaveLength(1);
    expect(installs).toHaveLength(1);
    expect(installs[0].file).toBe(process.execPath);
    expect(installs[0].args).toEqual([npmCli, ...OPENCODE_INSTALL_ARGS]);
    expect(installs[0].options.shell).toBe(false);
  });

  it("falls back from npm to pnpm and returns sanitized attempt records", async () => {
    _setNpmCheckRunner(async () => ({ stdout: "10.0.0\n", stderr: "" }));
    const availabilityResults = [
      { available: false, version: null, error: "not installed" },
      { available: false, version: null, error: "not installed" },
      { available: true, version: "v1.0.0", error: null },
    ];
    _setPostInstallAvailabilityChecker(async () => availabilityResults.shift() ?? { available: true, version: "v1.0.0", error: null });

    const installs: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    _setInstallProcessRunner(async (file, args, options) => {
      installs.push({ file, args, options });
      if (file === "npm") return { exitCode: 1, timedOut: false, stdout: "", stderr: "failed sk-secret-value-123456" };
      if (file === "pnpm") return { exitCode: 0, timedOut: false, stdout: "installed", stderr: "" };
      throw new Error(`unexpected install command ${file}`);
    });

    const { result } = await withProcessPlatform("linux", async () => {
      const plan = await createOpenCodeInstallPlan();
      return { result: await installOpenCodeControlled({ nonce: plan.nonce, confirmationPhrase: "INSTALL_OPENCODE", confirm: true }) };
    });

    expect(result.ok).toBe(true);
    expect(result.packageManager).toBe("pnpm");
    expect(installs.map((item) => item.file)).toEqual(["npm", "pnpm"]);
    expect(installs[0].args).toEqual(["install", "-g", "opencode-ai@latest"]);
    expect(installs[1].args).toEqual(["add", "-g", "opencode-ai@latest"]);
    expect(installs.every((item) => item.options.shell === false)).toBe(true);
    expect(result.attempts[0].stderrTail).not.toContain("sk-secret-value-123456");
  });

  it("reports package manager availability and latest OpenCode version without throwing on failures", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    _setNpmCheckRunner(async (file, args) => {
      calls.push({ file, args });
      if (args.join(" ") === "view opencode-ai version") return { stdout: "1.2.3\n", stderr: "" };
      if (args.join(" ") === "--version") return { stdout: `${file}-1.0.0\n`, stderr: "" };
      throw new Error("unexpected args");
    });

    const { managers, latest } = await withProcessPlatform("linux", async () => ({
      managers: await checkPackageManagersAvailability(),
      latest: await getLatestOpenCodeVersion(),
    }));

    expect(managers.npm.available).toBe(true);
    expect(managers.pnpm.available).toBe(true);
    expect(latest).toBe("1.2.3");
    expect(calls.some((call) => call.args.join(" ") === "view opencode-ai version")).toBe(true);
  });
});
