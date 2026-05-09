#!/usr/bin/env node

/**
 * TTS Voice Generator - Release Packaging Script
 *
 * 7-step pipeline: builds frontend + server, runs server tests, stages a
 * clean release directory, performs pre-archive validation (secret scan +
 * forbidden paths), generates a complete manifest with validation metadata
 * (testsRun, secretScan, forbiddenPathScan, archiveFileCount), creates a
 * .tar.gz archive (excluding macOS AppleDouble metadata), and verifies
 * archive-manifest consistency post-archive.
 *
 * Usage:
 *   npm run package:release            # full pipeline (build + test + pack)
 *   npm run package:release -- --skip-tests  # skip test step
 *
 * Security:
 *   - Never copies .env, APIkey.md, data/, node_modules, agent-outputs/
 *   - Manifest contains only file paths and sha256 digests, no secrets
 *   - Content-level secret scan on all staged text files
 *   - macOS AppleDouble (._*) and .DS_Store excluded from archive
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths (ESM-safe)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, "..");

const RELEASE_DIR = path.join(PROJECT_ROOT, "release");
const STAGING_DIR = path.join(RELEASE_DIR, "staging");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(tag, msg) {
  const colours = {
    info: "\x1b[36m",
    ok: "\x1b[32m",
    warn: "\x1b[33m",
    err: "\x1b[31m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  };
  const c = colours[tag] || colours.info;
  console.log(`${c}[release]${colours.reset} ${msg}`);
}

function run(cmd, opts = {}) {
  log("info", `Running: ${cmd}`);
  try {
    execSync(cmd, {
      cwd: opts.cwd || PROJECT_ROOT,
      stdio: opts.silent ? "pipe" : "inherit",
      env: opts.env || { ...process.env, FORCE_COLOR: "1" },
    });
  } catch (err) {
    log("err", `Command failed: ${cmd}`);
    throw err;
  }
}

/**
 * Compute sha256 hex digest of a file.
 */
function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

/**
 * Recursively copy files from src to dst, respecting exclude patterns.
 * Returns array of relative paths copied (relative to src).
 */
function copyDirRecursive(src, dst, excludePatterns = []) {
  const copied = [];
  const excludeRegexes = excludePatterns.map((p) => new RegExp(p));

  function walk(dir, relBase) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

      // Check exclusions
      const excluded = excludeRegexes.some((re) => re.test(relPath) || re.test(entry.name));
      if (excluded) continue;

      const srcPath = path.join(dir, entry.name);
      const dstPath = path.join(dst, relPath);

      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        walk(srcPath, relPath);
      } else {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
        copied.push(relPath);
      }
    }
  }

  walk(src, "");
  return copied;
}

/**
 * Copy a single file, creating directories as needed.
 */
function copyFile(src, dst, relPath) {
  const dstPath = path.join(dst, relPath);
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.copyFileSync(src, dstPath);
  return relPath;
}

// ---------------------------------------------------------------------------
// App version helpers
// ---------------------------------------------------------------------------

function readRootPackage() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
}

function readServerPackage() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "server", "package.json"), "utf-8"));
}

function getGitCommitHash() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getGitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main packaging logic
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log("");
  log("bold", "============================================================");
  log("bold", "  TTS Voice Generator - Release Packaging");
  log("bold", "============================================================");
  console.log("");

  // -----------------------------------------------------------------------
  // 1. Read version info
  // -----------------------------------------------------------------------
  const rootPkg = readRootPackage();
  const serverPkg = readServerPackage();
  const version = rootPkg.version || "0.0.0";
  const commitHash = getGitCommitHash();
  const branch = getGitBranch();

  log("info", `Version: ${version}`);
  if (commitHash) log("info", `Commit:  ${commitHash}`);
  if (branch) log("info", `Branch:  ${branch}`);
  console.log("");

  // -----------------------------------------------------------------------
  // 2. Build all
  // -----------------------------------------------------------------------
  log("info", "Step 1/6: Building frontend and server...");
  run("npm run build:all");
  log("ok", "Build completed.");
  console.log("");

  // -----------------------------------------------------------------------
  // 2b. Run server tests (default: on; skip with --skip-tests)
  // -----------------------------------------------------------------------
  const skipTests = process.argv.includes("--skip-tests");
  let testsRun = false;
  if (skipTests) {
    log("warn", "Step 2/6: Server tests SKIPPED (--skip-tests flag provided).");
  } else {
    log("info", "Step 2/6: Running server tests...");
    run("npm test --prefix server");
    testsRun = true;
    log("ok", "Server tests passed.");
  }
  console.log("");

  // -----------------------------------------------------------------------
  // 3. Prepare staging directory
  // -----------------------------------------------------------------------
  log("info", "Step 3/6: Preparing staging directory...");

  // Clean previous staging
  if (fs.existsSync(STAGING_DIR)) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const allCopiedFiles = [];

  // Patterns to exclude during copy (macOS metadata, system junk)
  const osMetadataPatterns = [
    /^\._/,           // AppleDouble files (._*)
    /^\.DS_Store$/,   // macOS folder metadata
    /^Thumbs\.db$/,   // Windows thumbnail cache
  ];

  // -- Frontend dist (from root dist/) --
  const frontendDistSrc = path.join(PROJECT_ROOT, "dist");
  if (!fs.existsSync(frontendDistSrc)) {
    log("err", "Frontend dist/ not found. Build may have failed.");
    process.exit(1);
  }
  const frontendFiles = copyDirRecursive(frontendDistSrc, path.join(STAGING_DIR, "dist"), osMetadataPatterns);
  frontendFiles.forEach((f) => allCopiedFiles.push(`dist/${f}`));
  log("info", `  Frontend dist: ${frontendFiles.length} files`);

  // -- Server dist (from server/dist/) --
  const serverDistSrc = path.join(PROJECT_ROOT, "server", "dist");
  if (!fs.existsSync(serverDistSrc)) {
    log("err", "Server dist/ not found. Build may have failed.");
    process.exit(1);
  }
  const serverFiles = copyDirRecursive(serverDistSrc, path.join(STAGING_DIR, "server", "dist"), osMetadataPatterns);
  serverFiles.forEach((f) => allCopiedFiles.push(`server/dist/${f}`));
  log("info", `  Server dist:   ${serverFiles.length} files`);

  // -- Server package.json + package-lock.json --
  allCopiedFiles.push(copyFile(
    path.join(PROJECT_ROOT, "server", "package.json"),
    STAGING_DIR,
    "server/package.json"
  ));
  log("info", "  server/package.json");

  const serverLockPath = path.join(PROJECT_ROOT, "server", "package-lock.json");
  if (fs.existsSync(serverLockPath)) {
    allCopiedFiles.push(copyFile(serverLockPath, STAGING_DIR, "server/package-lock.json"));
    log("info", "  server/package-lock.json");
  }

  // -- Root package.json + package-lock.json --
  allCopiedFiles.push(copyFile(
    path.join(PROJECT_ROOT, "package.json"),
    STAGING_DIR,
    "package.json"
  ));
  log("info", "  package.json");

  const rootLockPath = path.join(PROJECT_ROOT, "package-lock.json");
  if (fs.existsSync(rootLockPath)) {
    allCopiedFiles.push(copyFile(rootLockPath, STAGING_DIR, "package-lock.json"));
    log("info", "  package-lock.json");
  }

  // -- Server tsconfig.json (for reference) --
  allCopiedFiles.push(copyFile(
    path.join(PROJECT_ROOT, "server", "tsconfig.json"),
    STAGING_DIR,
    "server/tsconfig.json"
  ));
  log("info", "  server/tsconfig.json");

  // -- README.md --
  allCopiedFiles.push(copyFile(
    path.join(PROJECT_ROOT, "README.md"),
    STAGING_DIR,
    "README.md"
  ));
  log("info", "  README.md");

  // -- ATTRIBUTIONS.md --
  const attributionsPath = path.join(PROJECT_ROOT, "ATTRIBUTIONS.md");
  if (fs.existsSync(attributionsPath)) {
    allCopiedFiles.push(copyFile(attributionsPath, STAGING_DIR, "ATTRIBUTIONS.md"));
    log("info", "  ATTRIBUTIONS.md");
  }

  // -- .env.example --
  const envExampleSrc = path.join(PROJECT_ROOT, ".env.example");
  if (fs.existsSync(envExampleSrc)) {
    allCopiedFiles.push(copyFile(envExampleSrc, STAGING_DIR, ".env.example"));
    log("info", "  .env.example");
  } else {
    log("warn", "  .env.example not found, skipping");
  }

  // -- docs/ directory --
  const docsSrc = path.join(PROJECT_ROOT, "docs");
  if (fs.existsSync(docsSrc)) {
    const docsFiles = copyDirRecursive(docsSrc, path.join(STAGING_DIR, "docs"), osMetadataPatterns);
    docsFiles.forEach((f) => allCopiedFiles.push(`docs/${f}`));
    log("info", `  docs/:         ${docsFiles.length} files`);
  }

  // -- guidelines/ directory --
  const guidelinesSrc = path.join(PROJECT_ROOT, "guidelines");
  if (fs.existsSync(guidelinesSrc)) {
    const guideFiles = copyDirRecursive(guidelinesSrc, path.join(STAGING_DIR, "guidelines"), osMetadataPatterns);
    guideFiles.forEach((f) => allCopiedFiles.push(`guidelines/${f}`));
    log("info", `  guidelines/:   ${guideFiles.length} files`);
  }

  // -- scripts/ (start.js only, not tts-agent-cli.ts which needs tsx dev dep) --
  const startJsSrc = path.join(PROJECT_ROOT, "scripts", "start.js");
  if (fs.existsSync(startJsSrc)) {
    fs.mkdirSync(path.join(STAGING_DIR, "scripts"), { recursive: true });
    allCopiedFiles.push(copyFile(startJsSrc, STAGING_DIR, "scripts/start.js"));
    log("info", "  scripts/start.js");
  }

  // -- index.html (root shell) --
  const indexHtmlSrc = path.join(PROJECT_ROOT, "index.html");
  if (fs.existsSync(indexHtmlSrc)) {
    allCopiedFiles.push(copyFile(indexHtmlSrc, STAGING_DIR, "index.html"));
    log("info", "  index.html");
  }

  // -- postcss.config.mjs (build reference) --
  const postcssSrc = path.join(PROJECT_ROOT, "postcss.config.mjs");
  if (fs.existsSync(postcssSrc)) {
    allCopiedFiles.push(copyFile(postcssSrc, STAGING_DIR, "postcss.config.mjs"));
    log("info", "  postcss.config.mjs");
  }

  // -- vite.config.ts (build reference) --
  const viteConfigSrc = path.join(PROJECT_ROOT, "vite.config.ts");
  if (fs.existsSync(viteConfigSrc)) {
    allCopiedFiles.push(copyFile(viteConfigSrc, STAGING_DIR, "vite.config.ts"));
    log("info", "  vite.config.ts");
  }

  console.log("");
  log("ok", `Staging complete: ${allCopiedFiles.length} files`);

  // -----------------------------------------------------------------------
  // 4. Pre-archive validation: secret scan + forbidden path check
  // -----------------------------------------------------------------------
  log("info", "Step 4/7: Pre-archive validation (secret scan + forbidden paths)...");

  // Content-level secret scan on all staged text files (before archive creation)
  const secretPatterns = [
    { name: "OpenRouter API key", pattern: /sk-or-v1-[a-zA-Z0-9]{10,}/ },
    { name: "Generic long secret", pattern: /sk-[a-zA-Z0-9]{20,}/ },
    { name: "Bearer token (real)", pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/ },
    { name: "apiKey assignment", pattern: /apiKey\s*[:=]\s*["'][a-zA-Z0-9]{10,}["']/ },
    { name: "API key in env value", pattern: /OPENROUTER_API_KEY\s*[:=]\s*["']sk-/ },
    { name: "Local plugin token (real)", pattern: /lpt_[a-zA-Z0-9+/=_-]{20,}/ },
  ];

  // Text file extensions to scan
  const textExtensions = new Set([
    ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
    ".json", ".md", ".txt", ".yaml", ".yml", ".toml",
    ".env", ".env.example", ".env.local",
    ".html", ".css", ".scss", ".less",
    ".sh", ".bash", ".zsh", ".fish",
    ".py", ".rb", ".go", ".rs", ".java",
    ".xml", ".svg", ".plist",
    ".cfg", ".conf", ".ini",
  ]);

  // Also scan by name for dotfiles without extensions
  const textFilenames = new Set([
    ".env", ".env.example", ".env.local", ".env.production",
  ]);

  function isTextFile(relPath) {
    const ext = path.extname(relPath).toLowerCase();
    const base = path.basename(relPath);
    return textExtensions.has(ext) || textFilenames.has(base);
  }

  let secretScanHits = 0;
  const secretHitFiles = [];
  const textFilesScannedCount = allCopiedFiles.filter(isTextFile).length;
  for (const relPath of allCopiedFiles) {
    if (!isTextFile(relPath)) continue;
    const absPath = path.join(STAGING_DIR, relPath);
    if (!fs.existsSync(absPath)) continue;
    const stat = fs.statSync(absPath);
    // Skip files larger than 1MB for performance
    if (stat.size > 1024 * 1024) continue;

    const content = fs.readFileSync(absPath, "utf-8");
    for (const { name, pattern } of secretPatterns) {
      if (pattern.test(content)) {
        secretScanHits++;
        secretHitFiles.push({ file: relPath, rule: name });
        log("err", `  [SECRET LEAK] ${relPath} matched rule: ${name}`);
      }
    }
  }

  if (secretScanHits === 0) {
    log("ok", `  [CLEAN] Content secret scan: no secrets found (${textFilesScannedCount} text files scanned)`);
  }

  // Forbidden path check on staged file list (before archive)
  const forbiddenPatterns = [
    /node_modules/,
    /^data\/(db|audio)/,
    /\.env$/,
    /\.env\.local$/,
    /APIkey\.md/,
    /agent-outputs/,
    /^._/,             // AppleDouble files (._*)
    /^\.DS_Store$/,    // macOS folder metadata
    /Thumbs\.db$/,     // Windows thumbnail cache
  ];

  let forbiddenHits = 0;
  for (const relPath of allCopiedFiles) {
    if (forbiddenPatterns.some((p) => p.test(relPath))) {
      log("err", `  [FORBIDDEN] Staged file violates pattern: ${relPath}`);
      forbiddenHits++;
    }
  }
  if (forbiddenHits === 0) {
    log("ok", "  [CLEAN] No forbidden paths in staged files");
  }

  console.log("");

  // -----------------------------------------------------------------------
  // 5. Generate complete manifest (including all validation metadata)
  // -----------------------------------------------------------------------
  log("info", "Step 5/7: Generating complete release manifest...");

  // Compute sha256 for every content file in staging
  const fileChecksums = {};
  for (const relPath of allCopiedFiles) {
    const absPath = path.join(STAGING_DIR, relPath);
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      fileChecksums[relPath] = sha256File(absPath);
    }
  }

  // Manifest self-inclusion strategy:
  // The manifest declares itself in includedPaths but cannot contain its own
  // stable sha256 (the hash value is part of the content being hashed).
  // Integrity is verified via archive-level sha256 and includedPaths membership.
  const manifestSelfEntry = "release-manifest.json";
  const allFilesIncludingManifest = [...allCopiedFiles, manifestSelfEntry].sort();
  const totalFileCount = allFilesIncludingManifest.length;

  // Self-referential checksum: manifest cannot hash its own content
  fileChecksums[manifestSelfEntry] = "self-referential-omitted";

  const manifest = {
    appName: "tts-voice-generator",
    version: version,
    serverVersion: serverPkg.version || "0.1.0",
    buildTime: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    git: {
      commit: commitHash,
      branch: branch,
    },
    includedPaths: allFilesIncludingManifest,
    excludedPatterns: [
      "node_modules/",
      "data/",
      "data/db/",
      "data/audio/",
      ".env",
      ".env.local",
      ".env.*.local",
      "APIkey.md",
      "agent-outputs/",
      ".git/",
      ".opencode/",
      "release/",
      "*.log",
      ".DS_Store",
      "Thumbs.db",
      "._*",     // macOS AppleDouble files
    ],
    fileCount: totalFileCount,
    fileChecksums: fileChecksums,
    selfReferentialFile: manifestSelfEntry,
    selfReferentialStrategy: "Manifest cannot contain its own stable sha256 because the hash value is part of the content being hashed. Integrity verified via archive-level sha256 and includedPaths membership.",
    testsRun: testsRun,
    secretScan: {
      scanned: true,
      textFilesScanned: textFilesScannedCount,
      hits: secretScanHits,
    },
    forbiddenPathScan: {
      performed: true,
      hits: forbiddenHits,
    },
    archiveFileCount: totalFileCount,
  };

  const manifestPath = path.join(STAGING_DIR, "release-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // Track manifest as part of the file set
  allCopiedFiles.push(manifestSelfEntry);

  log("ok", `Manifest written: ${manifestPath}`);
  log("info", `  Content files: ${totalFileCount - 1}`);
  log("info", `  Total files (incl. manifest): ${totalFileCount}`);
  log("info", `  archiveFileCount: ${manifest.archiveFileCount}`);
  log("info", `  testsRun: ${manifest.testsRun}`);
  log("info", `  secretScan: scanned=${manifest.secretScan.scanned}, textFilesScanned=${manifest.secretScan.textFilesScanned}, hits=${manifest.secretScan.hits}`);
  log("info", `  forbiddenPathScan: performed=${manifest.forbiddenPathScan.performed}, hits=${manifest.forbiddenPathScan.hits}`);
  console.log("");

  // -----------------------------------------------------------------------
  // 6. Create tar.gz archive (with macOS metadata exclusion)
  // -----------------------------------------------------------------------
  log("info", "Step 6/7: Creating tar.gz archive...");

  const archiveName = `tts-voice-generator-v${version}${commitHash ? "-" + commitHash : ""}.tar.gz`;
  const archivePath = path.join(RELEASE_DIR, archiveName);

  // Remove previous archive if it exists
  if (fs.existsSync(archivePath)) {
    fs.unlinkSync(archivePath);
  }

  // Create tar.gz from staging directory with macOS metadata excluded:
  // - COPYFILE_DISABLE=1 prevents macOS from adding ._ files during tar
  // - --exclude patterns as a safety net for any that slipped through
  run(
    `tar -czf "${archivePath}" ` +
    `--exclude="._*" --exclude=".DS_Store" --exclude="Thumbs.db" ` +
    `-C "${STAGING_DIR}" .`,
    {
      silent: true,
      env: { ...process.env, COPYFILE_DISABLE: "1", FORCE_COLOR: "1" },
    }
  );

  const archiveStats = fs.statSync(archivePath);
  const archiveSha256 = sha256File(archivePath);
  const archiveSizeMB = (archiveStats.size / 1024 / 1024).toFixed(2);

  log("ok", `Archive created: ${archiveName}`);
  log("info", `  Path:   ${archivePath}`);
  log("info", `  Size:   ${archiveSizeMB} MB`);
  log("info", `  SHA256: ${archiveSha256}`);
  console.log("");

  // -----------------------------------------------------------------------
  // 7. Post-archive verification
  // -----------------------------------------------------------------------
  log("info", "Step 7/7: Post-archive verification...");

  let validationPassed = (secretScanHits === 0) && (forbiddenHits === 0);

  // Parse tar listing
  const tarListOutput = execSync(`tar -tzf "${archivePath}"`, {
    cwd: RELEASE_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim();
  const tarEntries = tarListOutput.split("\n").map((l) => l.trim().replace(/^\.\//, ""));

  // Separate files from directories
  const tarFiles = tarEntries.filter((e) => e && !e.endsWith("/"));

  // Check critical files exist in archive
  const requiredFiles = [
    "dist/index.html",
    "server/dist/index.js",
    "server/package.json",
    "package.json",
    "README.md",
    ".env.example",
    "release-manifest.json",
  ];

  for (const req of requiredFiles) {
    const found = tarFiles.some((e) => e === req);
    if (found) {
      log("ok", `  [PRESENT] ${req}`);
    } else {
      log("err", `  [MISSING] ${req}`);
      validationPassed = false;
    }
  }

  // Double-check forbidden patterns are NOT present in archive listing
  let archiveForbiddenHits = 0;
  for (const pattern of forbiddenPatterns) {
    const violations = tarEntries.filter((e) => pattern.test(e));
    if (violations.length > 0) {
      log("err", `  [FORBIDDEN] Pattern ${pattern} matched ${violations.length} entries in archive`);
      archiveForbiddenHits += violations.length;
      validationPassed = false;
    }
  }
  if (archiveForbiddenHits === 0) {
    log("ok", "  [CLEAN] No forbidden paths in archive listing");
  }

  // Verify archive file count matches manifest archiveFileCount
  if (tarFiles.length !== manifest.archiveFileCount) {
    log("err", `  [MISMATCH] Archive has ${tarFiles.length} files, manifest.archiveFileCount=${manifest.archiveFileCount}`);
    validationPassed = false;
  } else {
    log("ok", `  [MATCH] Archive file count (${tarFiles.length}) matches manifest.archiveFileCount`);
  }

  // Verify manifest-consistency: every tar file declared in manifest and vice versa
  const manifestFileSet = new Set(manifest.includedPaths);
  const tarFileSet = new Set(tarFiles);

  const undeclaredFiles = tarFiles.filter((f) => !manifestFileSet.has(f));
  if (undeclaredFiles.length > 0) {
    log("err", `  [MISMATCH] ${undeclaredFiles.length} files in archive not declared in manifest:`);
    undeclaredFiles.slice(0, 10).forEach((f) => log("err", `    - ${f}`));
    validationPassed = false;
  } else {
    log("ok", `  [MATCH] All archive files declared in manifest.includedPaths`);
  }

  const missingFromArchive = manifest.includedPaths.filter((f) => !tarFileSet.has(f));
  if (missingFromArchive.length > 0) {
    log("err", `  [MISMATCH] ${missingFromArchive.length} manifest files missing from archive:`);
    missingFromArchive.forEach((f) => log("err", `    - ${f}`));
    validationPassed = false;
  } else {
    log("ok", `  [MATCH] All manifest.includedPaths exist in archive`);
  }

  console.log("");


  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log("bold", "============================================================");
  if (validationPassed) {
    log("ok", `Release package PASSED validation (${elapsed}s)`);
  } else {
    log("err", `Release package FAILED validation (${elapsed}s)`);
  }
  log("bold", "============================================================");
  console.log("");
  log("info", "Release artifacts:");
  log("info", `  Archive:  ${archivePath}`);
  log("info", `  Manifest: ${manifestPath}`);
  log("info", `  Staging:  ${STAGING_DIR}`);
  log("info", `  SHA256:   ${archiveSha256}`);
  console.log("");
  log("info", "To deploy:");
  log("info", "  1. Extract: tar -xzf " + archiveName);
  log("info", "  2. Install: cd server && npm install --production && cd ..");
  log("info", "  3. Configure: cp .env.example .env && edit .env");
  log("info", "  4. Start: node server/dist/index.js");
  console.log("");

  if (!validationPassed) {
    process.exit(1);
  }

  // Return summary for programmatic use
  return {
    archivePath,
    archiveName,
    archiveSha256,
    archiveSizeMB,
    manifestPath,
    fileCount: manifest.fileCount,
    validationPassed,
  };
}

main().catch((err) => {
  log("err", `Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
