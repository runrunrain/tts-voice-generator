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

console.info(JSON.stringify({
  event: "desktop-runtime-prepared",
  target: target.targetId,
  stageDir,
}, null, 2));
