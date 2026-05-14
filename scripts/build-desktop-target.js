import path from "node:path";
import { getStageDir, resolveTarget } from "./desktop-targets.js";
import { formatCommand, resolveProjectRoot, spawnCrossPlatform } from "./process-utils.js";

const projectRoot = resolveProjectRoot(import.meta.url);
const target = resolveTarget(process.argv.slice(2));

function run(command, args, options = {}) {
  console.info(`[desktop-build] ${formatCommand(command, args)}`);
  const result = spawnCrossPlatform(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    console.error(`[desktop-build] failed to start: ${formatCommand(command, args)}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.info(JSON.stringify({
  event: "desktop-target-build-start",
  target: target.targetId,
  node: process.version,
  npmUserAgent: process.env.npm_config_user_agent ?? null,
  hostPlatform: process.platform,
  hostArch: process.arch,
}, null, 2));

run("npm", ["run", "build:all"]);
run("npm", ["run", "electron:build"]);
run("node", ["scripts/prepare-desktop-runtime.js", "--platform", target.platform, "--arch", target.arch]);
run("npm", ["ci", "--omit=dev", "--prefix", path.join(projectRoot, getStageDir(target), "server")]);
run("node", ["scripts/rebuild-desktop-native.js", "--platform", target.platform, "--arch", target.arch]);
run("node", ["scripts/package-desktop-target.js", "--platform", target.platform, "--arch", target.arch]);

console.info(JSON.stringify({
  event: "desktop-target-build-complete",
  target: target.targetId,
}, null, 2));
