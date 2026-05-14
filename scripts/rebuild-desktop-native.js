import fs from "node:fs";
import path from "node:path";
import { getStageDir, requireMatchingHost, resolveTarget } from "./desktop-targets.js";
import { resolveProjectRoot, spawnCrossPlatform } from "./process-utils.js";

const projectRoot = resolveProjectRoot(import.meta.url);

function readElectronVersion() {
  const lockfile = path.join(projectRoot, "package-lock.json");
  if (!fs.existsSync(lockfile)) {
    throw new Error("package-lock.json is required for deterministic Electron rebuild");
  }
  const electronPackage = path.join(projectRoot, "node_modules/electron/package.json");
  if (!fs.existsSync(electronPackage)) {
    throw new Error("node_modules/electron/package.json is missing; run npm install first");
  }
  return JSON.parse(fs.readFileSync(electronPackage, "utf8")).version;
}

function findNativeAddons(directory) {
  const matches = [];
  if (!fs.existsSync(directory)) return matches;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findNativeAddons(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      matches.push(entryPath);
    }
  }
  return matches;
}

const target = resolveTarget(process.argv.slice(2));
requireMatchingHost(target);

const electronVersion = readElectronVersion();
const stageDir = path.join(projectRoot, getStageDir(target));
const moduleDir = path.join(stageDir, "server");

if (!fs.existsSync(path.join(moduleDir, "node_modules/better-sqlite3"))) {
  throw new Error(`better-sqlite3 is missing in ${moduleDir}; run npm ci --omit=dev --prefix ${moduleDir} first`);
}

const result = spawnCrossPlatform("npx", [
  "electron-rebuild",
  "--module-dir", moduleDir,
  "--only", "better-sqlite3",
  "--version", electronVersion,
  "--arch", target.arch,
  "--force",
], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_arch: target.arch,
    npm_config_target_arch: target.arch,
  },
});

if (result.error) {
  console.error(`[desktop-native] failed to start electron-rebuild: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const nativeAddons = findNativeAddons(path.join(moduleDir, "node_modules/better-sqlite3/build"));
if (nativeAddons.length === 0) {
  throw new Error("better-sqlite3 rebuild finished but no .node addon was found");
}

console.info(JSON.stringify({
  event: "desktop-native-rebuilt",
  target: target.targetId,
  electronVersion,
  hostPlatform: process.platform,
  hostArch: process.arch,
  nativeAddons,
}, null, 2));
