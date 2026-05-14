import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_COMMANDS = new Map([
  ["npm", "npm.cmd"],
  ["npx", "npx.cmd"],
]);

export function resolveProjectRoot(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

export function resolveBin(command) {
  if (command === "node") {
    return process.execPath;
  }

  if (process.platform !== "win32") {
    return command;
  }

  return WINDOWS_COMMANDS.get(command.toLowerCase()) ?? command;
}

export function formatCommand(command, args = []) {
  return [command, ...args].join(" ");
}

export function spawnCrossPlatform(command, args, options = {}) {
  return spawnSync(resolveBin(command), args, {
    ...options,
    shell: false,
  });
}
