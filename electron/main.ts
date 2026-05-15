import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDesktopPlatformCapabilities } from "./platform-capabilities";
import { QuitCoordinator } from "./quit-coordinator";
import { DesktopTrayService } from "./tray-service";
import { DesktopUpdaterService } from "./updater-service";
import type { DesktopActionResult } from "./desktop-contracts";

const LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_TOKEN_HEADER = "X-TTS-Desktop-Token";
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 250;

type StartedServer = {
  port: number;
  hostname: string;
  url: string;
  close: () => Promise<void>;
};

type ServerModule = {
  startServer?: (options: {
    port?: number;
    hostname?: string;
    installSignalHandlers?: boolean;
    desktopSecurity?: { enabled: boolean; token: string };
  }) => Promise<unknown>;
};

let mainWindow: BrowserWindow | null = null;
let startedServer: StartedServer | null = null;
let desktopApiToken: string | null = null;
let desktopDataDir: string | null = null;
let quitCoordinator: QuitCoordinator | null = null;
let trayService: DesktopTrayService | null = null;
let updaterService: DesktopUpdaterService | null = null;

function ensureDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
}

function sanitizeDesktopError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(os.homedir(), "~")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "sk-[REDACTED]")
    .slice(0, 300);
}

function resolveOpenCodeConfigPath() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const configRoot = xdgConfigHome && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.join(os.homedir(), ".config");
  return path.normalize(path.join(configRoot, "opencode", "opencode.json"));
}

function ensureOpenCodeConfigFile(filePath: string) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms/filesystems that do not support POSIX modes.
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "{}\n", { mode: 0o600, flag: "wx" });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support POSIX modes.
  }
}

function configureDesktopEnvironment(token: string) {
  const dataDir = app.getPath("userData");
  const dbDir = path.join(dataDir, "db");
  const audioDir = path.join(dataDir, "audio");

  ensureDirectory(dataDir);
  ensureDirectory(dbDir);
  ensureDirectory(audioDir);

  process.env.ELECTRON_MODE = "true";
  process.env.DESKTOP_API_TOKEN = token;
  process.env.PORT = "0";
  process.env.HOST = LOOPBACK_HOST;
  process.env.DB_PATH = path.join(dbDir, "tts-generator.db");
  process.env.AUDIO_OUTPUT_DIR = audioDir;
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = process.env.NODE_ENV || "production";

  desktopDataDir = dataDir;
}

function resolveServerEntryPath() {
  return path.resolve(__dirname, "../server/dist/index.js");
}

function assertStartedServer(candidate: unknown): StartedServer {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Server start contract failed: result is not an object");
  }

  const record = candidate as Partial<StartedServer>;
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65_535) {
    throw new Error("Server start contract failed: invalid port");
  }
  if (record.hostname !== LOOPBACK_HOST) {
    throw new Error("Server start contract failed: server is not bound to 127.0.0.1");
  }

  const expectedUrl = `http://${LOOPBACK_HOST}:${record.port}`;
  if (record.url !== expectedUrl) {
    throw new Error("Server start contract failed: unexpected server URL");
  }
  if (typeof record.close !== "function") {
    throw new Error("Server start contract failed: close handle is missing");
  }

  return record as StartedServer;
}

async function startEmbeddedServer(token: string) {
  const serverEntryPath = resolveServerEntryPath();
  if (!fs.existsSync(serverEntryPath)) {
    throw new Error(`Server bundle not found at ${serverEntryPath}. Run npm run build:all first.`);
  }

  const serverModule = await import(pathToFileURL(serverEntryPath).href) as ServerModule;
  if (typeof serverModule.startServer !== "function") {
    throw new Error("Server module contract failed: startServer export is missing");
  }

  const started = assertStartedServer(await serverModule.startServer({
    port: 0,
    hostname: LOOPBACK_HOST,
    installSignalHandlers: false,
    desktopSecurity: {
      enabled: true,
      token,
    },
  }));

  process.env.CORS_ORIGINS = started.url;
  startedServer = started;
}

async function waitForHealth(serverUrl: string) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health check failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Health check failed");
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw lastError ?? new Error("Health check timed out");
}

async function runSmokeChecks() {
  if (!startedServer || !desktopApiToken) {
    throw new Error("Smoke checks require an initialized server and token");
  }

  const noTokenResponse = await fetch(`${startedServer.url}/api/settings`);
  const wrongTokenResponse = await fetch(`${startedServer.url}/api/settings`, {
    headers: { [DESKTOP_TOKEN_HEADER]: "invalid-token" },
  });
  const wrongOriginResponse = await fetch(`${startedServer.url}/api/settings`, {
    headers: {
      [DESKTOP_TOKEN_HEADER]: desktopApiToken,
      Origin: "http://127.0.0.1:9",
    },
  });

  if (noTokenResponse.status !== 401) {
    throw new Error(`Smoke check failed: no-token request returned HTTP ${noTokenResponse.status}`);
  }
  if (wrongTokenResponse.status !== 401) {
    throw new Error(`Smoke check failed: wrong-token request returned HTTP ${wrongTokenResponse.status}`);
  }
  if (wrongOriginResponse.status !== 403) {
    throw new Error(`Smoke check failed: wrong-origin request returned HTTP ${wrongOriginResponse.status}`);
  }

  console.info(JSON.stringify({
    event: "electron-smoke-pass",
    server: {
      hostname: startedServer.hostname,
      port: startedServer.port,
    },
    checks: {
      health: 200,
      noToken: noTokenResponse.status,
      wrongToken: wrongTokenResponse.status,
      wrongOrigin: wrongOriginResponse.status,
    },
  }, null, 2));
}

function createMainWindow() {
  if (!startedServer) {
    throw new Error("Cannot create window before server is running");
  }

  const preloadPath = path.join(__dirname, "preload.cjs");
  const allowedOrigin = new URL(startedServer.url).origin;

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
    trayService?.refreshMenu();
  });

  window.on("close", (event) => {
    if (!quitCoordinator?.isQuitRequested() && trayService?.isAvailable()) {
      event.preventDefault();
      window.hide();
      trayService?.refreshMenu();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    trayService?.refreshMenu();
  });

  window.webContents.on("will-navigate", (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== allowedOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void window.loadURL(startedServer.url);
  mainWindow = window;
  trayService?.refreshMenu();
  return window;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!startedServer) return null;
    createMainWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  trayService?.refreshMenu();
  return mainWindow;
}

async function closeServer() {
  const server = startedServer;
  startedServer = null;
  if (server) {
    await server.close();
  }
}

function getQuitCoordinator() {
  if (!quitCoordinator) {
    quitCoordinator = new QuitCoordinator({
      closeServer,
      sanitizeError: sanitizeDesktopError,
      onBeforeQuit: () => {
        trayService?.dispose();
      },
    });
  }
  return quitCoordinator;
}

function unsupportedUpdateResult(): DesktopActionResult {
  return {
    ok: false,
    code: "updater-not-initialized",
    error: "桌面更新服务尚未初始化。",
  };
}

async function boot() {
  getQuitCoordinator();
  desktopApiToken = crypto.randomBytes(32).toString("base64url");
  configureDesktopEnvironment(desktopApiToken);

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  await startEmbeddedServer(desktopApiToken);
  await waitForHealth(startedServer!.url);
  if (process.env.ELECTRON_SMOKE_TEST === "true") {
    await runSmokeChecks();
    await closeServer();
    app.exit(0);
    return;
  }
  createMainWindow();
  trayService = new DesktopTrayService({
    getWindow: () => mainWindow,
    showWindow: showMainWindow,
    requestQuit: () => getQuitCoordinator().requestQuit("tray"),
    sanitizeError: sanitizeDesktopError,
  });
  trayService.initialize();
  updaterService = new DesktopUpdaterService({
    getWindow: () => mainWindow,
    getCapabilities: getDesktopPlatformCapabilities,
    quitCoordinator: getQuitCoordinator(),
    sanitizeError: sanitizeDesktopError,
  });
}

ipcMain.handle("tts-desktop:get-api-headers", () => {
  if (!desktopApiToken) {
    throw new Error("Desktop API token is not initialized");
  }
  return { [DESKTOP_TOKEN_HEADER]: desktopApiToken };
});

ipcMain.handle("tts-desktop:get-server-status", () => ({
  running: Boolean(startedServer),
  port: startedServer?.port ?? null,
}));

ipcMain.handle("tts-desktop:open-data-directory", async () => {
  if (!desktopDataDir) {
    return { ok: false, code: "data-directory-uninitialized", error: "Data directory is not initialized" };
  }
  const result = await shell.openPath(desktopDataDir);
  return result ? { ok: false, code: "open-data-directory-failed", error: sanitizeDesktopError(result) } : { ok: true };
});

ipcMain.handle("tts-desktop:open-opencode-config", async () => {
  try {
    const filePath = resolveOpenCodeConfigPath();
    ensureOpenCodeConfigFile(filePath);
    const result = await shell.openPath(filePath);
    return result ? { ok: false, code: "open-opencode-config-failed", error: sanitizeDesktopError(result) } : { ok: true };
  } catch (error) {
    return { ok: false, code: "open-opencode-config-failed", error: sanitizeDesktopError(error) };
  }
});

ipcMain.handle("tts-desktop:get-platform-capabilities", () => getDesktopPlatformCapabilities());

ipcMain.handle("tts-desktop:update:get-state", () => {
  if (updaterService) return updaterService.getState();
  const capabilities = getDesktopPlatformCapabilities();
  return {
    phase: "unsupported",
    currentVersion: capabilities.appVersion,
    error: "桌面更新服务尚未初始化。",
  };
});

ipcMain.handle("tts-desktop:update:check", async () => {
  if (!updaterService) {
    const capabilities = getDesktopPlatformCapabilities();
    return {
      ok: false,
      code: "updater-not-initialized",
      error: "桌面更新服务尚未初始化。",
      state: {
        phase: "unsupported",
        currentVersion: capabilities.appVersion,
        error: "桌面更新服务尚未初始化。",
      },
    };
  }
  return updaterService.check();
});

ipcMain.handle("tts-desktop:update:download", async () => updaterService?.download() ?? unsupportedUpdateResult());

ipcMain.handle("tts-desktop:update:install-and-restart", async () => updaterService?.installAndRestart() ?? unsupportedUpdateResult());

ipcMain.handle("tts-desktop:update:open-release-page", async () => updaterService?.openReleasePage() ?? unsupportedUpdateResult());

app.on("window-all-closed", () => {
  if (!trayService?.isAvailable() && !getQuitCoordinator().isQuitRequested()) {
    void getQuitCoordinator().requestQuit("system");
    return;
  }
  trayService?.refreshMenu();
});

app.on("activate", () => {
  if (startedServer) showMainWindow();
});

app.on("before-quit", (event) => {
  getQuitCoordinator().handleBeforeQuit(event);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady()
    .then(boot)
    .catch(async (error) => {
      await closeServer().catch(() => undefined);
      const message = sanitizeDesktopError(error instanceof Error ? error : "Unknown startup error");
      dialog.showErrorBox("TTS Voice Generator failed to start", message);
      app.exit(1);
    });
}
