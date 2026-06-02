/**
 * Verify OpenCode bundled runtime structure.
 *
 * Usage:
 *   node scripts/verify-opencode-runtime.js --stage dist-desktop/app-win32-x64 --platform win32 --arch x64
 *   node scripts/verify-opencode-runtime.js --dir ./opencode-runtime --platform win32 --arch x64
 *
 * Checks:
 * - manifest.json exists and is parseable
 * - Binary exists at bin/opencode(.exe)
 * - Binary is not inside an asar archive
 * - manifest.target matches expected target
 */

import fs from "node:fs";
import path from "node:path";
import { resolveProjectRoot } from "./process-utils.js";

const projectRoot = resolveProjectRoot(import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stage") { args.stage = argv[++i]; continue; }
    if (argv[i] === "--dir") { args.dir = argv[++i]; continue; }
    if (argv[i] === "--platform") { args.platform = argv[++i]; continue; }
    if (argv[i] === "--arch") { args.arch = argv[++i]; continue; }
  }
  return args;
}

function fail(message) {
  console.error(`VERIFY FAILED: ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const platform = args.platform || process.platform;
const arch = args.arch || process.arch;
const targetId = `${platform}-${arch}`;

// Resolve the runtime directory
let runtimeDir;
if (args.dir) {
  runtimeDir = path.resolve(args.dir);
} else if (args.stage) {
  runtimeDir = path.resolve(projectRoot, args.stage, "opencode-runtime");
} else {
  // Default: try Electron resourcesPath-style and stage
  runtimeDir = path.resolve(projectRoot, "dist-desktop", `app-${targetId}`, "opencode-runtime");
}

console.info(`Verifying OpenCode runtime at: ${runtimeDir}`);
console.info(`Target: ${targetId}`);

if (!fs.existsSync(runtimeDir)) {
  fail(`Runtime directory not found: ${runtimeDir}`);
}

// Check manifest.json
const manifestPath = path.join(runtimeDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  fail(`manifest.json not found at: ${manifestPath}`);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (err) {
  fail(`manifest.json is not valid JSON: ${err.message}`);
}

console.info(`  manifest.name: ${manifest.name || "(missing)"}`);
console.info(`  manifest.version: ${manifest.version || "(missing)"}`);
console.info(`  manifest.target: ${manifest.target || "(missing)"}`);
console.info(`  manifest.referenceHead: ${manifest.referenceHead || "(missing)"}`);

// Verify target is present, is a non-blank string, and matches expected target
if (typeof manifest.target !== "string" || manifest.target.trim() === "") {
  fail(
    `manifest.target is required and must be a non-blank string. ` +
    `Expected: "${targetId}", got: ${manifest.target === undefined ? "undefined" : JSON.stringify(manifest.target)}`
  );
}
if (manifest.target !== targetId) {
  fail(`Manifest target mismatch: manifest.target "${manifest.target}" does not match expected "${targetId}"`);
}

// Check binary
const binaryName = platform === "win32" ? "opencode.exe" : "opencode";
const binPath = path.join(runtimeDir, "bin", binaryName);
if (!fs.existsSync(binPath)) {
  // Try flat layout
  const flatBinPath = path.join(runtimeDir, binaryName);
  if (!fs.existsSync(flatBinPath)) {
    fail(`Binary not found at: ${binPath} or ${flatBinPath}`);
  }
  console.info(`  binary: ${flatBinPath} (flat layout)`);
} else {
  console.info(`  binary: ${binPath}`);
}

// Check not inside asar
const resolvedPath = path.resolve(runtimeDir);
if (resolvedPath.includes(".asar")) {
  fail(`Runtime directory is inside an asar archive: ${resolvedPath}. Binaries must be placed via extraResources.`);
}

console.info("\nVERIFY PASSED: OpenCode bundled runtime structure is valid.");
