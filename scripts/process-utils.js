import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM_COMMANDS = new Set(["npm", "npx"]);
const NPM_CLI_BASENAME = "npm-cli.js";

export function resolveProjectRoot(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

function basenameForPlatform(filePath, platform) {
  if (platform === "win32") {
    return path.win32.basename(filePath).toLowerCase();
  }
  return path.basename(filePath).toLowerCase();
}

function dirnameForPlatform(filePath, platform) {
  if (platform === "win32") {
    return path.win32.dirname(filePath);
  }
  return path.dirname(filePath);
}

function joinForPlatform(platform, ...segments) {
  if (platform === "win32") {
    return path.win32.join(...segments);
  }
  return path.join(...segments);
}

function npmCliCandidateFromExecPath(npmExecPath, platform) {
  if (!npmExecPath) {
    return null;
  }

  const basename = basenameForPlatform(npmExecPath, platform);
  if (basename === NPM_CLI_BASENAME) {
    return npmExecPath;
  }

  if (platform === "win32" && basename === "npm.cmd") {
    const candidate = joinForPlatform(platform, dirnameForPlatform(npmExecPath, platform), "node_modules", "npm", "bin", NPM_CLI_BASENAME);
    return fs.existsSync(candidate) ? candidate : null;
  }

  return null;
}

function npmCliCandidateFromPath(pathEnv, platform) {
  if (!pathEnv) {
    return null;
  }

  const delimiter = platform === "win32" ? path.win32.delimiter : path.delimiter;
  for (const entry of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = joinForPlatform(platform, entry, "node_modules", "npm", "bin", NPM_CLI_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveNpmCliPath(env, platform) {
  const npmExecPath = npmCliCandidateFromExecPath(env.npm_execpath, platform);
  if (npmExecPath) {
    return npmExecPath;
  }

  return npmCliCandidateFromPath(env.PATH ?? env.Path ?? env.path, platform);
}

export function resolveBin(command, platform = process.platform) {
  if (command === "node") {
    return process.execPath;
  }

  return command;
}

export function resolveProcessCommand(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const normalizedCommand = command.toLowerCase();

  if (command === "node") {
    return {
      command: execPath,
      args,
      shell: false,
      strategy: "node-execpath",
    };
  }

  if (platform === "win32" && NPM_COMMANDS.has(normalizedCommand)) {
    const npmCliPath = resolveNpmCliPath(env, platform);
    if (!npmCliPath) {
      throw new Error(`Unable to locate ${NPM_CLI_BASENAME} for ${command} on Windows without using a shell`);
    }

    return {
      command: execPath,
      args: normalizedCommand === "npx" ? [npmCliPath, "exec", "--", ...args] : [npmCliPath, ...args],
      shell: false,
      strategy: normalizedCommand === "npx" ? "npm-cli-exec" : "npm-cli",
    };
  }

  return {
    command: resolveBin(command, platform),
    args,
    shell: false,
    strategy: "direct",
  };
}

export function formatCommand(command, args = []) {
  return [command, ...args].join(" ");
}

export function spawnCrossPlatform(command, args, options = {}) {
  let resolved;
  try {
    resolved = resolveProcessCommand(command, args, {
      env: options.env ?? process.env,
    });
  } catch (error) {
    return {
      error,
      status: null,
      signal: null,
      output: null,
      pid: 0,
      stdout: null,
      stderr: null,
    };
  }

  return spawnSync(resolved.command, resolved.args, {
    ...options,
    shell: resolved.shell,
  });
}
