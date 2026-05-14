#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCrossPlatform } from "./process-utils.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = path.join(SCRIPT_DIR, "dependency-manifest.json");
const APP_NAME = "TTS Voice Generator";
const STRICT_INSTALL_LOCATION = `/Applications/${APP_NAME}.app`;
const SECRET_KEY_PATTERN = /(token|secret|key|password|credential)/i;

function printHelp() {
  console.info(`Usage: node scripts/quick-build-deploy.mjs [options]

Build and safely replace the current macOS TTS Voice Generator app.

Options:
  --dry-run                     Print the plan only; do not install, build, quit, replace, smoke, or launch.
  --skip-npm-install            Skip root and server npm ci. Build commands still run unless --dry-run is set.
  --no-launch                   Do not launch /Applications/TTS Voice Generator.app after deployment.
  --no-smoke                    Do not run ELECTRON_SMOKE_TEST after deployment.
  --install-system-deps         Print system dependency install guidance. This script does not silently install system dependencies.
  --allow-npm-install-fallback  Allow npm install fallback only when a package-lock.json is missing.
  --no-quit-running-app         Stop if the app is running instead of asking macOS to quit it gracefully.
  --help                        Show this help.

Safety controls:
  - Project npm dependencies may be installed by default with npm ci.
  - System dependencies are never installed silently.
  - Only /Applications/TTS Voice Generator.app can be replaced.
  - ~/Library/Application Support/TTS Voice Generator is never deleted or moved.
  - No git commands are executed.
`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipNpmInstall: false,
    launch: true,
    smoke: true,
    installSystemDeps: false,
    allowNpmInstallFallback: false,
    quitRunningApp: true,
    help: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-npm-install":
        options.skipNpmInstall = true;
        break;
      case "--no-launch":
        options.launch = false;
        break;
      case "--no-smoke":
        options.smoke = false;
        break;
      case "--install-system-deps":
        options.installSystemDeps = true;
        break;
      case "--allow-npm-install-fallback":
        options.allowNpmInstallFallback = true;
        break;
      case "--no-quit-running-app":
        options.quitRunningApp = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.dryRun) {
    options.launch = false;
    options.smoke = false;
  }

  return options;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest.schemaVersion !== "tts.quick-deploy.dependency-manifest.v1") {
    errors.push("schemaVersion must be tts.quick-deploy.dependency-manifest.v1");
  }
  if (!manifest.project?.id || !manifest.project?.productName || !manifest.project?.appId) {
    errors.push("project.id, project.productName and project.appId are required");
  }
  if (!Array.isArray(manifest.npmProjects) || manifest.npmProjects.length === 0) {
    errors.push("npmProjects must be a non-empty array");
  }
  if (!Array.isArray(manifest.systemDependencies) || manifest.systemDependencies.length === 0) {
    errors.push("systemDependencies must be a non-empty array");
  }
  if (!Array.isArray(manifest.desktopTargets) || manifest.desktopTargets.length === 0) {
    errors.push("desktopTargets must be a non-empty array");
  }
  const darwinTarget = manifest.desktopTargets?.find((target) => target.id === "darwin-current");
  if (!darwinTarget) {
    errors.push("desktopTargets must include darwin-current");
  } else {
    if (darwinTarget.installLocation !== STRICT_INSTALL_LOCATION) {
      errors.push(`darwin-current installLocation must be ${STRICT_INSTALL_LOCATION}`);
    }
    if (!Array.isArray(darwinTarget.buildCommands) || darwinTarget.buildCommands.length === 0) {
      errors.push("darwin-current buildCommands must be a non-empty array");
    }
  }
  if (manifest.installPolicy?.macAppReplacement?.neverDeleteUserData !== true) {
    errors.push("installPolicy.macAppReplacement.neverDeleteUserData must be true");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid dependency manifest:\n- ${errors.join("\n- ")}`);
  }
}

function expandHome(inputPath) {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function templateValue(input, values) {
  return input.replaceAll("${targetArch}", values.targetArch);
}

function parseVersion(versionText) {
  const match = String(versionText).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function satisfiesRange(versionText, range) {
  const version = parseVersion(versionText);
  if (!version) {
    return false;
  }
  const parts = range.split(/\s+/).filter(Boolean);
  return parts.every((part) => {
    const match = part.match(/^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/);
    if (!match) {
      throw new Error(`Unsupported version range expression: ${part}`);
    }
    const operator = match[1] ?? "=";
    const expected = parseVersion(match[2]);
    const cmp = compareVersions(version, expected);
    if (operator === ">=") return cmp >= 0;
    if (operator === ">") return cmp > 0;
    if (operator === "<=") return cmp <= 0;
    if (operator === "<") return cmp < 0;
    return cmp === 0;
  });
}

function findExecutable(command) {
  const pathEnv = process.env.PATH ?? "";
  const candidates = pathEnv.split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, command));
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

function safeCommandLabel(command, args) {
  return [command, ...args].map((part) => SECRET_KEY_PATTERN.test(part) ? "[redacted]" : part).join(" ");
}

function runCommand(command, args, options = {}) {
  const cwd = options.cwd ?? PROJECT_ROOT;
  const label = safeCommandLabel(command, args);
  console.info(`[quick-deploy] run: ${label}`);
  const result = spawnCrossPlatform(command, args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: options.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    shell: false,
  });
  const status = result.status ?? (result.error ? 1 : 0);
  if (result.error) {
    throw new Error(`Command failed to start: ${label}: ${result.error.message}`);
  }
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(status)) {
    const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : "";
    const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";
    throw new Error(`Command failed (${status}): ${label}${stdout}${stderr}`);
  }
  return result;
}

function runDetectCommand(commandSpec) {
  const [command, ...args] = commandSpec.command;
  const result = spawnCrossPlatform(command, args, {
    cwd: PROJECT_ROOT,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });
  return {
    command: commandSpec.command,
    status: result.status ?? (result.error ? 1 : 0),
    ok: !result.error && (commandSpec.successExitCodes ?? [0]).includes(result.status ?? 0),
    error: result.error?.message ?? null,
  };
}

function getTargetArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

function getDarwinTarget(manifest) {
  const target = manifest.desktopTargets.find((candidate) => candidate.id === "darwin-current");
  if (!target) {
    throw new Error("dependency manifest is missing darwin-current target");
  }
  return target;
}

function getInstallCommandForProject(npmProject, options) {
  const lockPath = path.join(PROJECT_ROOT, npmProject.lockfile);
  const hasLockfile = fs.existsSync(lockPath);
  if (hasLockfile) {
    return { command: npmProject.install.defaultCommand, lockPath, mode: "lockfile" };
  }
  if (!options.allowNpmInstallFallback) {
    throw new Error(`Lockfile missing for ${npmProject.id}; refusing fallback npm install without --allow-npm-install-fallback`);
  }
  if (npmProject.install.useFallbackOnlyWhenLockfileMissing !== true || !Array.isArray(npmProject.install.fallbackCommand)) {
    throw new Error(`Lockfile missing for ${npmProject.id}, but no safe npm install fallback is configured in the dependency manifest`);
  }
  console.warn(`[quick-deploy] lockfile missing for ${npmProject.id}; using explicit npm install fallback because --allow-npm-install-fallback was provided`);
  return { command: npmProject.install.fallbackCommand, lockPath, mode: "fallback" };
}

function assertProjectFiles(manifest, options) {
  for (const npmProject of manifest.npmProjects) {
    const packagePath = path.join(PROJECT_ROOT, npmProject.packageJson);
    if (!fs.existsSync(packagePath)) {
      throw new Error(`Missing package.json for ${npmProject.id}: ${packagePath}`);
    }
    const packageJson = loadJson(packagePath);
    for (const scriptName of npmProject.requiredScripts ?? []) {
      if (!packageJson.scripts?.[scriptName]) {
        throw new Error(`Missing npm script ${scriptName} in ${npmProject.packageJson}`);
      }
    }
    getInstallCommandForProject(npmProject, options);
  }
}

function printSystemInstallGuidance(manifest) {
  console.info("[quick-deploy] System dependency install guidance only; no system changes will be made.");
  for (const dependency of manifest.systemDependencies) {
    if (dependency.manualInstallHint) {
      console.info(`- ${dependency.id}: ${dependency.manualInstallHint}`);
    }
  }
}

function preflight(manifest, options) {
  if (process.platform !== "darwin") {
    throw new Error(`quick-build-deploy currently supports macOS only; current platform is ${process.platform}`);
  }

  const nodeVersion = process.version.replace(/^v/, "");
  if (!satisfiesRange(nodeVersion, manifest.runtime.node.range)) {
    throw new Error(`Node.js ${nodeVersion} does not satisfy ${manifest.runtime.node.range}. ${manifest.runtime.node.manualInstallHint}`);
  }

  const npmVersion = runCommand("npm", ["--version"], { inherit: false }).stdout.trim();
  if (!satisfiesRange(npmVersion, manifest.runtime.npm.range)) {
    throw new Error(`npm ${npmVersion} does not satisfy ${manifest.runtime.npm.range}. ${manifest.runtime.npm.manualInstallHint}`);
  }

  assertProjectFiles(manifest, options);

  for (const dependency of manifest.systemDependencies) {
    if (!dependency.platforms.includes("darwin")) {
      continue;
    }
    const detect = dependency.detect ?? {};
    for (const executable of detect.executables ?? []) {
      if (!findExecutable(executable)) {
        throw new Error(`Missing required executable ${executable} for ${dependency.id}. ${dependency.manualInstallHint}`);
      }
    }
    if (detect.command) {
      const result = runDetectCommand(detect);
      if (!result.ok) {
        throw new Error(`System dependency ${dependency.id} check failed for ${safeCommandLabel(result.command[0], result.command.slice(1))}. ${dependency.manualInstallHint}`);
      }
    }
  }

  if (options.installSystemDeps) {
    printSystemInstallGuidance(manifest);
  }
}

function installProjectDependencies(manifest, options) {
  if (options.skipNpmInstall) {
    console.info("[quick-deploy] skip npm install: --skip-npm-install was provided");
    return;
  }
  for (const npmProject of manifest.npmProjects) {
    const { command } = getInstallCommandForProject(npmProject, options);
    runCommand(command[0], command.slice(1), { cwd: PROJECT_ROOT, inherit: true });
  }
}

function runBuildCommands(target, targetArch) {
  for (const command of target.buildCommands) {
    const templated = command.map((part) => templateValue(part, { targetArch }));
    runCommand(templated[0], templated.slice(1), { cwd: PROJECT_ROOT, inherit: true });
  }
}

function findAppBundles(rootDir, appName) {
  const results = [];
  if (!fs.existsSync(rootDir)) {
    return results;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    if (path.basename(current) === `${appName}.app`) {
      results.push({ appPath: current, mtimeMs: stat.mtimeMs });
      continue;
    }
    if (current.endsWith(".app")) {
      continue;
    }
    for (const entry of fs.readdirSync(current)) {
      stack.push(path.join(current, entry));
    }
  }
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.appPath);
}

function findLatestDmg(outputDir) {
  if (!fs.existsSync(outputDir)) {
    return null;
  }
  const entries = fs.readdirSync(outputDir)
    .filter((entry) => entry.endsWith(".dmg") && entry.startsWith(`${APP_NAME}-`))
    .map((entry) => {
      const fullPath = path.join(outputDir, entry);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]?.fullPath ?? null;
}

function parseMountPoint(output) {
  for (const line of output.split(/\r?\n/)) {
    const marker = "/Volumes/";
    const index = line.indexOf(marker);
    if (index >= 0) {
      return line.slice(index).trim();
    }
  }
  return null;
}

function mountDmgReadOnly(dmgPath) {
  const result = runCommand("hdiutil", ["attach", "-readonly", "-nobrowse", dmgPath], { inherit: false });
  const mountPoint = parseMountPoint(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (!mountPoint) {
    throw new Error(`Unable to detect mount point for ${dmgPath}`);
  }
  return mountPoint;
}

function detachDmg(mountPoint) {
  runCommand("hdiutil", ["detach", mountPoint], { inherit: true });
}

function locateBuiltApp(target, targetArch) {
  const outputDir = path.join(PROJECT_ROOT, templateValue(target.outputDir, { targetArch }));
  const directApps = findAppBundles(outputDir, APP_NAME);
  if (directApps.length > 0) {
    return { appPath: directApps[0], mountedDmg: null };
  }
  const dmgPath = findLatestDmg(outputDir);
  if (!dmgPath) {
    throw new Error(`No ${APP_NAME}.app or dmg found under ${outputDir}`);
  }
  const mountPoint = mountDmgReadOnly(dmgPath);
  const mountedApps = findAppBundles(mountPoint, APP_NAME);
  if (mountedApps.length === 0) {
    detachDmg(mountPoint);
    throw new Error(`No ${APP_NAME}.app found inside ${dmgPath}`);
  }
  return { appPath: mountedApps[0], mountedDmg: mountPoint };
}

function readBundleIdentifier(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) {
    throw new Error(`Missing Info.plist: ${plistPath}`);
  }
  const result = runCommand("plutil", ["-extract", "CFBundleIdentifier", "raw", plistPath], { inherit: false });
  return result.stdout.trim();
}

function validateAppBundle(appPath, target) {
  const validation = target.bundleValidation;
  if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
    throw new Error(`App bundle does not exist: ${appPath}`);
  }
  const bundleId = readBundleIdentifier(appPath);
  if (bundleId !== validation.expectedBundleIdentifier) {
    throw new Error(`Bundle id mismatch for ${appPath}: expected ${validation.expectedBundleIdentifier}, got ${bundleId}`);
  }
  for (const relativePath of validation.requiredRelativePaths) {
    const fullPath = path.join(appPath, relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Required packaged app path is missing: ${fullPath}`);
    }
  }
  const executablePath = path.join(appPath, "Contents", "MacOS", validation.expectedExecutableName);
  fs.accessSync(executablePath, fs.constants.X_OK);
  return { bundleId, executablePath };
}

function isAppRunning() {
  const result = spawnSync("pgrep", ["-x", APP_NAME], {
    cwd: PROJECT_ROOT,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
  });
  return result.status === 0;
}

function quitRunningAppIfNeeded(options) {
  if (!isAppRunning()) {
    return false;
  }
  if (!options.quitRunningApp) {
    throw new Error(`${APP_NAME} is running. Close it and retry, or omit --no-quit-running-app to request a graceful quit.`);
  }
  console.info(`[quick-deploy] ${APP_NAME} is running; requesting graceful quit with osascript`);
  runCommand("osascript", ["-e", `tell application \"${APP_NAME}\" to quit`], { inherit: false });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isAppRunning()) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`${APP_NAME} did not quit within 30 seconds. Refusing to force kill.`);
}

function assertStrictInstallPath(installPath) {
  if (installPath !== STRICT_INSTALL_LOCATION) {
    throw new Error(`Refusing to replace non-strict install path: ${installPath}`);
  }
}

function removeExistingAppBundleOnly(installPath, target) {
  assertStrictInstallPath(installPath);
  if (!fs.existsSync(installPath)) {
    return;
  }
  validateAppBundle(installPath, target);
  fs.rmSync(installPath, { recursive: true, force: false });
}

function restoreBackupOverInstallPath(backupPath, installPath, target, reason) {
  assertStrictInstallPath(installPath);
  validateAppBundle(backupPath, target);
  console.error(`[quick-deploy] rollback: restoring backup after ${reason}: ${backupPath} -> ${installPath}`);
  if (fs.existsSync(installPath)) {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
  runCommand("ditto", [backupPath, installPath], { inherit: true });
  validateAppBundle(installPath, target);
}

function restoreBackupOrThrowCritical(backupPath, installPath, target, originalError, reason) {
  try {
    restoreBackupOverInstallPath(backupPath, installPath, target, reason);
  } catch (restoreError) {
    throw new Error(`Critical: ${reason} failed (${originalError.message}); rollback restore failed: ${restoreError.message}`);
  }
}

function replaceApplicationsApp(sourceApp, target, userDataPath) {
  const installPath = target.installLocation;
  assertStrictInstallPath(installPath);
  validateAppBundle(sourceApp, target);
  fs.mkdirSync(userDataPath, { recursive: true });
  const backupRoot = path.join(userDataPath, "deploy-backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const tempApp = path.join("/Applications", `.${APP_NAME}.app.new.${process.pid}`);
  const backupPath = path.join(backupRoot, `${APP_NAME}.app.${timestamp}`);
  if (fs.existsSync(tempApp)) {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }

  let backupCreated = false;
  try {
    runCommand("ditto", [sourceApp, tempApp], { inherit: true });
    validateAppBundle(tempApp, target);
    if (fs.existsSync(installPath)) {
      validateAppBundle(installPath, target);
      runCommand("ditto", [installPath, backupPath], { inherit: true });
      backupCreated = true;
    }
    removeExistingAppBundleOnly(installPath, target);
    fs.renameSync(tempApp, installPath);
    validateAppBundle(installPath, target);
    return { installPath, backupPath: backupCreated ? backupPath : null };
  } catch (error) {
    if (fs.existsSync(tempApp)) {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
    if (backupCreated) {
      restoreBackupOrThrowCritical(backupPath, installPath, target, error, "app replacement validation");
    }
    throw error;
  }
}

function runSmoke(target) {
  const executablePath = path.join(target.installLocation, "Contents", "MacOS", APP_NAME);
  runCommand(executablePath, [], {
    cwd: PROJECT_ROOT,
    inherit: true,
    env: { ELECTRON_SMOKE_TEST: "true" },
  });
}

function runPostInstallValidation(target, installResult, options) {
  if (!options.smoke) {
    return;
  }
  try {
    runSmoke(target);
  } catch (error) {
    if (installResult.backupPath) {
      restoreBackupOrThrowCritical(installResult.backupPath, installResult.installPath, target, error, "post-install smoke validation");
    }
    throw error;
  }
}

function launchApp(target) {
  runCommand("open", [target.installLocation], { cwd: PROJECT_ROOT, inherit: true });
}

function printDryRunPlan(manifest, target, targetArch, options) {
  const userDataPath = expandHome(target.userDataLocations[0]);
  const outputDir = path.join(PROJECT_ROOT, templateValue(target.outputDir, { targetArch }));
  const npmInstallCommands = options.skipNpmInstall
    ? []
    : manifest.npmProjects.map((project) => {
      const installPlan = getInstallCommandForProject(project, options);
      return {
        project: project.id,
        mode: installPlan.mode,
        command: installPlan.command,
      };
    });
  console.info(JSON.stringify({
    event: "quick-build-deploy-dry-run",
    projectRoot: PROJECT_ROOT,
    manifestPath: MANIFEST_PATH,
    target: target.id,
    targetArch,
    installPath: target.installLocation,
    userDataPath,
    outputDir,
    skipNpmInstall: options.skipNpmInstall,
    launch: options.launch,
    smoke: options.smoke,
    npmInstallCommands,
    buildCommands: target.buildCommands,
    systemDependencyPolicy: "System dependencies are not installed silently; --install-system-deps prints guidance only.",
    safety: [
      `Only ${STRICT_INSTALL_LOCATION} may be replaced.`,
      `${userDataPath} is preserved and never deleted.`,
      "No git command is executed."
    ]
  }, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const manifest = loadJson(MANIFEST_PATH);
  validateManifest(manifest);
  const target = getDarwinTarget(manifest);
  const targetArch = getTargetArch();
  const userDataPath = expandHome(target.userDataLocations[0]);

  if (options.dryRun) {
    assertProjectFiles(manifest, options);
    if (options.installSystemDeps) {
      printSystemInstallGuidance(manifest);
    }
    printDryRunPlan(manifest, target, targetArch, options);
    console.info("[quick-deploy] dry run complete. No install, build, app replacement, smoke, launch, or git command executed.");
    return;
  }

  let located = null;
  try {
    preflight(manifest, options);
    installProjectDependencies(manifest, options);
    runBuildCommands(target, targetArch);
    located = locateBuiltApp(target, targetArch);
    validateAppBundle(located.appPath, target);
    quitRunningAppIfNeeded(options);
    const installResult = replaceApplicationsApp(located.appPath, target, userDataPath);
    runPostInstallValidation(target, installResult, options);
    if (options.launch) {
      launchApp(target);
    }
    console.info(JSON.stringify({
      event: "quick-build-deploy-complete",
      target: target.id,
      targetArch,
      builtApp: located.appPath,
      installPath: installResult.installPath,
      backupPath: installResult.backupPath,
      userDataPath,
      smoke: options.smoke ? "ran" : "skipped",
      launch: options.launch ? "ran" : "skipped",
      git: "No git command executed"
    }, null, 2));
  } finally {
    if (located?.mountedDmg) {
      detachDmg(located.mountedDmg);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`[quick-deploy] failed: ${error.message}`);
  console.error(`[quick-deploy] rollback notes: ${STRICT_INSTALL_LOCATION} is the only install target. If a backup was created, restore it from ~/Library/Application Support/TTS Voice Generator/deploy-backups with ditto. User data was not deleted by this script.`);
  process.exit(1);
}
