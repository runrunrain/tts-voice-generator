import fs from "node:fs";
import path from "node:path";
import { getStageDir, requireMatchingHost, resolveTarget } from "./desktop-targets.js";
import { resolveProjectRoot } from "./process-utils.js";

const projectRoot = resolveProjectRoot(import.meta.url);

function requirePath(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Required build artifact is missing: ${relativePath}`);
  }
  return absolutePath;
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function writeRuntimePackage(stageDir) {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const runtimePackage = {
    name: rootPackage.name,
    version: rootPackage.version,
    private: true,
    type: "module",
    main: "dist-electron/main.cjs",
  };
  fs.writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);
}

/**
 * Validate the structure of a bundled OpenCode runtime directory.
 * Reuses the same logic as verify-opencode-runtime.js to ensure:
 * - manifest.json exists and is parseable
 * - Binary exists at bin/opencode(.exe)
 * - manifest.target matches expected target (if manifest has target)
 * - Runtime is not inside an asar archive
 *
 * @param {string} runtimeDir - The runtime directory to validate
 * @param {{ platform: string, arch: string, targetId: string }} target - Target info
 * @throws {Error} On validation failure
 */
function validateBundledRuntimeStructure(runtimeDir, target) {
  if (!fs.existsSync(runtimeDir)) {
    throw new Error(`Bundled runtime directory does not exist: ${runtimeDir}`);
  }

  // Check not inside asar
  const resolvedPath = path.resolve(runtimeDir);
  if (resolvedPath.includes(".asar")) {
    throw new Error(
      `Bundled runtime directory is inside an asar archive: ${resolvedPath}. ` +
      "Binaries must be placed via extraResources."
    );
  }

  // Check manifest.json
  const manifestPath = path.join(runtimeDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Bundled runtime manifest.json not found at: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Bundled runtime manifest.json is not valid JSON: ${err.message}`);
  }

  // Verify target is present, is a non-blank string, and matches expected target
  if (typeof manifest.target !== "string" || manifest.target.trim() === "") {
    throw new Error(
      `Bundled runtime manifest.target is required and must be a non-blank string. ` +
      `Expected: "${target.targetId}", got: ${manifest.target === undefined ? "undefined" : JSON.stringify(manifest.target)}`
    );
  }
  if (manifest.target !== target.targetId) {
    throw new Error(
      `Manifest target mismatch: manifest.target "${manifest.target}" does not match expected "${target.targetId}"`
    );
  }

  // Check binary exists
  const binaryName = target.platform === "win32" ? "opencode.exe" : "opencode";
  const binPath = path.join(runtimeDir, "bin", binaryName);
  const flatBinPath = path.join(runtimeDir, binaryName);

  if (!fs.existsSync(binPath) && !fs.existsSync(flatBinPath)) {
    throw new Error(
      `Bundled runtime binary not found at: ${binPath} or ${flatBinPath}`
    );
  }

  // Verify binary is not a .cmd/.bat
  const foundBinPath = fs.existsSync(binPath) ? binPath : flatBinPath;
  const ext = path.extname(foundBinPath).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    throw new Error(
      `Bundled runtime binary must be a native executable, not a .cmd/.bat: ${foundBinPath}`
    );
  }

  console.info(`[opencode-runtime] Validation passed for ${runtimeDir}`);
  console.info(`  manifest.name: ${manifest.name || "(missing)"}`);
  console.info(`  manifest.version: ${manifest.version || "(missing)"}`);
  console.info(`  manifest.target: ${manifest.target || "(missing)"}`);
  console.info(`  binary: ${foundBinPath}`);
}

/**
 * Prepare the bundled OpenCode runtime for the desktop stage directory.
 *
 * Resolution order for source:
 * 1. OPENCODE_BUNDLED_RUNTIME_DIR env var (pre-prepared directory)
 * 2. resources/opencode-runtime/<targetId> (CI artifact or dev setup)
 * 3. OPENCODE_REFERENCE_REPO/packages/opencode/dist/<platform-specific> (dev build from reference repo)
 *
 * When OPENCODE_BUNDLED_RUNTIME_OPTIONAL=true, missing runtime is a warning, not an error.
 * Release builds should NOT set this flag.
 *
 * After copying, the runtime structure is validated (manifest, binary, target, non-asar).
 * A bad directory will NOT be reported as included.
 */
function prepareBundledRuntime(stageDir, target) {
  const runtimeDest = path.join(stageDir, "opencode-runtime");
  const envOptional = (process.env.OPENCODE_BUNDLED_RUNTIME_OPTIONAL ?? "").trim().toLowerCase();
  const isOptional = envOptional === "true" || envOptional === "1";

  /** @type {string|null} Source directory that was copied, or null if nothing found */
  let sourceDir = null;

  // 1. Explicit env override
  const envRuntimeDir = (process.env.OPENCODE_BUNDLED_RUNTIME_DIR ?? "").trim();
  if (envRuntimeDir && fs.existsSync(envRuntimeDir)) {
    console.info(`[opencode-runtime] Copying from OPENCODE_BUNDLED_RUNTIME_DIR: ${envRuntimeDir}`);
    sourceDir = envRuntimeDir;
  }

  // 2. resources/opencode-runtime/<targetId>
  if (!sourceDir) {
    const targetRuntimeDir = path.join(projectRoot, "resources", "opencode-runtime", target.targetId);
    if (fs.existsSync(targetRuntimeDir)) {
      console.info(`[opencode-runtime] Copying from resources: ${targetRuntimeDir}`);
      sourceDir = targetRuntimeDir;
    }
  }

  // 3. Reference repo build output (dev only, not for release)
  if (!sourceDir) {
    const refRepo = (process.env.OPENCODE_REFERENCE_REPO ?? "").trim();
    if (refRepo && fs.existsSync(refRepo)) {
      // Try common build output locations
      const platformPkgDir = target.platform === "win32"
        ? path.join(refRepo, "packages", "opencode", "dist", `opencode-windows-${target.arch === "x64" ? "x64" : "arm64"}`)
        : target.platform === "darwin"
          ? path.join(refRepo, "packages", "opencode", "dist", `opencode-darwin-${target.arch === "x64" ? "x64" : "arm64"}`)
          : null;

      if (platformPkgDir && fs.existsSync(platformPkgDir)) {
        console.info(`[opencode-runtime] Copying from reference repo: ${platformPkgDir}`);
        sourceDir = platformPkgDir;
      }

      // Try flat dist directory
      if (!sourceDir) {
        const flatDistDir = path.join(refRepo, "packages", "opencode", "dist");
        if (fs.existsSync(flatDistDir)) {
          const binaryName = target.platform === "win32" ? "opencode.exe" : "opencode";
          const binCandidates = [
            path.join(flatDistDir, binaryName),
            path.join(flatDistDir, "bin", binaryName),
          ];
          for (const candidate of binCandidates) {
            if (fs.existsSync(candidate)) {
              console.info(`[opencode-runtime] Copying from reference repo flat dist: ${flatDistDir}`);
              // For flat dist, we need to create a proper structure
              fs.mkdirSync(runtimeDest, { recursive: true });
              fs.mkdirSync(path.join(runtimeDest, "bin"), { recursive: true });
              fs.copyFileSync(candidate, path.join(runtimeDest, "bin", binaryName));
              sourceDir = runtimeDest; // Points to what we just created
              break;
            }
          }
        }
      }
    }
  }

  // Not found
  if (!sourceDir) {
    if (isOptional) {
      console.warn(`[opencode-runtime] WARNING: Bundled OpenCode runtime not found for ${target.targetId}. Continuing without it (OPENCODE_BUNDLED_RUNTIME_OPTIONAL=true).`);
      return false;
    }

    throw new Error(
      `Bundled OpenCode runtime not found for ${target.targetId}. ` +
      `Searched:\n` +
      `  - OPENCODE_BUNDLED_RUNTIME_DIR: ${envRuntimeDir || "(not set)"}\n` +
      `  - resources/opencode-runtime/${target.targetId}\n` +
      `  - OPENCODE_REFERENCE_REPO: ${(process.env.OPENCODE_REFERENCE_REPO ?? "").trim() || "(not set)"}\n` +
      `Set OPENCODE_BUNDLED_RUNTIME_OPTIONAL=true to skip this check for development.`
    );
  }

  // Copy source to destination (unless already there from flat dist handling)
  if (sourceDir !== runtimeDest) {
    copyDirectory(sourceDir, runtimeDest);
  }

  // Validate the copied runtime structure (fail closed)
  try {
    validateBundledRuntimeStructure(runtimeDest, target);
  } catch (validationError) {
    // Clean up the invalid copy
    try {
      fs.rmSync(runtimeDest, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    throw new Error(
      `Bundled runtime structure validation failed for ${target.targetId}: ${validationError.message}. ` +
      "The runtime directory was removed. Ensure the source contains manifest.json, bin/opencode(.exe), and correct target."
    );
  }

  return true;
}

const target = resolveTarget(process.argv.slice(2));
requireMatchingHost(target);

const stageDir = path.join(projectRoot, getStageDir(target));
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, "server"), { recursive: true });

copyDirectory(requirePath("dist"), path.join(stageDir, "dist"));
copyDirectory(requirePath("dist-electron"), path.join(stageDir, "dist-electron"));
copyDirectory(requirePath("server/dist"), path.join(stageDir, "server/dist"));
fs.copyFileSync(requirePath("server/package.json"), path.join(stageDir, "server/package.json"));
fs.copyFileSync(requirePath("server/package-lock.json"), path.join(stageDir, "server/package-lock.json"));
writeRuntimePackage(stageDir);

// Prepare bundled OpenCode runtime
const runtimePrepared = prepareBundledRuntime(stageDir, target);
const runtimeStatus = runtimePrepared ? "included" : "skipped";

console.info(JSON.stringify({
  event: "desktop-runtime-prepared",
  target: target.targetId,
  stageDir,
  bundledRuntime: runtimeStatus,
}, null, 2));
