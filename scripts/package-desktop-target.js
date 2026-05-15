import fs from "node:fs";
import path from "node:path";
import { getOutputDir, getStageDir, requireMatchingHost, resolveTarget } from "./desktop-targets.js";
import { resolveProjectRoot, spawnCrossPlatform } from "./process-utils.js";

const projectRoot = resolveProjectRoot(import.meta.url);

const target = resolveTarget(process.argv.slice(2));
requireMatchingHost(target);

const stageDir = path.join(projectRoot, getStageDir(target));
const outputDir = path.join(projectRoot, getOutputDir(target));

if (!fs.existsSync(path.join(stageDir, "dist-electron/main.cjs"))) {
  throw new Error(`Desktop app staging is missing Electron main bundle: ${stageDir}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const builderTarget = target.platform === "darwin" ? ["--mac", "dmg", "zip"] : ["--win", "nsis"];
const archFlag = target.arch === "arm64" ? "--arm64" : "--x64";
const result = spawnCrossPlatform("npx", [
  "electron-builder",
  "--config", "electron-builder.config.cjs",
  ...builderTarget,
  archFlag,
  "--publish", "never",
], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    DESKTOP_TARGET_PLATFORM: target.platform,
    DESKTOP_TARGET_ARCH: target.arch,
    DESKTOP_APP_DIR: stageDir,
    DESKTOP_OUTPUT_DIR: outputDir,
  },
});

if (result.error) {
  console.error(`[desktop-package] failed to start electron-builder: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const outputs = fs.readdirSync(outputDir).map((entry) => path.join(outputDir, entry));
console.info(JSON.stringify({
  event: "desktop-target-packaged",
  target: target.targetId,
  outputDir,
  outputs,
}, null, 2));
