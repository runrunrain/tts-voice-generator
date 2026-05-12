import { spawnSync } from "node:child_process";
import path from "node:path";
import { getStageDir, resolveTarget } from "./desktop-targets.js";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const target = resolveTarget(process.argv.slice(2));

function run(command, args, options = {}) {
  console.info(`[desktop-build] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
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
