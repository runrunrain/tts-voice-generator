import assert from "node:assert/strict";
import { resolveProcessCommand } from "./process-utils.js";

const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
const windowsNpmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";

function assertNoWindowsCmdShellFalse(plan) {
  assert.notEqual(plan.command.toLowerCase(), "npm.cmd");
  assert.notEqual(plan.command.toLowerCase(), "npx.cmd");
  assert.equal(plan.shell, false);
}

const windowsNpmPlan = resolveProcessCommand("npm", ["run", "build:all"], {
  platform: "win32",
  execPath: windowsNode,
  env: { npm_execpath: windowsNpmCli },
});
assertNoWindowsCmdShellFalse(windowsNpmPlan);
assert.equal(windowsNpmPlan.command, windowsNode);
assert.deepEqual(windowsNpmPlan.args, [windowsNpmCli, "run", "build:all"]);
assert.equal(windowsNpmPlan.strategy, "npm-cli");

const windowsNpxPlan = resolveProcessCommand("npx", ["electron-builder", "--version"], {
  platform: "win32",
  execPath: windowsNode,
  env: { npm_execpath: windowsNpmCli },
});
assertNoWindowsCmdShellFalse(windowsNpxPlan);
assert.equal(windowsNpxPlan.command, windowsNode);
assert.deepEqual(windowsNpxPlan.args, [windowsNpmCli, "exec", "--", "electron-builder", "--version"]);
assert.equal(windowsNpxPlan.strategy, "npm-cli-exec");

const nonWindowsNpmPlan = resolveProcessCommand("npm", ["--version"], {
  platform: "darwin",
  execPath: "/opt/homebrew/bin/node",
  env: {},
});
assert.equal(nonWindowsNpmPlan.command, "npm");
assert.deepEqual(nonWindowsNpmPlan.args, ["--version"]);
assert.equal(nonWindowsNpmPlan.shell, false);

const nodePlan = resolveProcessCommand("node", ["--version"], {
  platform: "win32",
  execPath: windowsNode,
  env: {},
});
assert.equal(nodePlan.command, windowsNode);
assert.deepEqual(nodePlan.args, ["--version"]);
assert.equal(nodePlan.shell, false);

console.info(JSON.stringify({
  event: "process-utils-test-pass",
  cases: [
    "win32 npm uses node plus npm-cli.js",
    "win32 npx uses npm exec through npm-cli.js",
    "non-windows npm remains direct shell:false",
    "node resolves to process execPath shell:false",
  ],
}, null, 2));
