#!/usr/bin/env node

/**
 * TTS Voice Generator - One-Click Quick Start
 *
 * Launches frontend (Vite) and backend (Hono/tsx) concurrently with unified
 * log output.  On Windows (and Unix), closing this process via Ctrl+C, window
 * close, SIGINT/SIGTERM, or an unhandled child crash will kill the entire
 * descendant process tree so no stale Node/Vite/tsx processes remain.
 *
 * Modes:
 *   node scripts/start.js             # normal mode (runs until Ctrl+C)
 *   node scripts/start.js --smoke     # smoke test: start, check health, exit
 *
 * npm scripts:
 *   npm run quickstart                 # normal mode
 *   npm run smoke                      # smoke test mode
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const isWin = platform() === "win32";

// ---------------------------------------------------------------------------
// Resolve project paths (ESM-safe)
// ---------------------------------------------------------------------------

// import.meta.url gives file:///D:/.../scripts/start.js
// scripts/start.js is one level inside the project root, so ".." resolves to root.
const thisFile = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(thisFile);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, "..");
const SERVER_DIR = path.join(PROJECT_ROOT, "server");

/**
 * Resolve server-local tsx through its JS CLI.
 * This keeps runtime cwd at the project root while using server's own
 * devDependency instead of requiring tsx in root node_modules.
 */
const TSX_CLI = path.join(SERVER_DIR, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_ENTRY = path.join(SERVER_DIR, "src", "index.ts");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_BACKEND_PORT = 3001;
const MIN_PORT = 1;
const MAX_PORT = 65535;

function parsePortEnv(name, defaultPort) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultPort;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== rawValue.trim() ||
    parsed < MIN_PORT ||
    parsed > MAX_PORT
  ) {
    console.warn(
      `[start] Ignoring invalid ${name}=${JSON.stringify(rawValue)}; using ${defaultPort}.`
    );
    return defaultPort;
  }

  return parsed;
}

const FRONTEND_PORT = parsePortEnv("FRONTEND_PORT", DEFAULT_FRONTEND_PORT);
const BACKEND_PORT = parsePortEnv("BACKEND_PORT", DEFAULT_BACKEND_PORT);
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const BACKEND_HEALTH_URL = `${BACKEND_URL}/api/health`;

// ANSI helpers (best-effort; Windows CMD may ignore some)
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const SMOKE_MODE = args.includes("--smoke") || args.includes("--once");

// ---------------------------------------------------------------------------
// Child process registry & cleanup
// ---------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let cleaning = false;

/**
 * Kill an entire process tree synchronously on Windows.
 * This MUST be synchronous because process.on("exit") handlers cannot
 * use async operations -- the event loop is already stopped.
 *
 * On Unix we fall back to process-kill which is synchronous.
 */
function killTreeSync(proc) {
  if (!proc) return;
  const pid = proc.pid;
  if (!pid) return;

  try {
    if (isWin) {
      // execSync is synchronous and will complete before the process exits.
      // /T = kill tree (all descendants), /F = force
      execSync(`taskkill /T /F /PID ${pid}`, {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // Already dead or permission denied -- ignore
  }
}

/**
 * Kill a single child process (best-effort async version for signal handlers
 * where we still have time before exit).
 */
function killTreeAsync(proc) {
  if (!proc) return;
  const pid = proc.pid;
  if (!pid) return;

  try {
    if (isWin) {
      // Use synchronous kill in signal handlers too -- async spawn can be
      // unreliable when the event loop is winding down.
      execSync(`taskkill /T /F /PID ${pid}`, {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // Already dead
  }
}

function killPortListenersSync(port) {
  if (isWin) return;
  try {
    const output = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    for (const rawPid of output.split(/\s+/)) {
      const pid = Number(rawPid);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      let args = "";
      try {
        args = execSync(`ps -p ${pid} -o args=`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        });
      } catch {
        continue;
      }
      if (!args.includes(PROJECT_ROOT)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead or permission denied -- ignore.
      }
    }
  } catch {
    // lsof not available or no listeners -- ignore.
  }
}

function cleanup(reason) {
  if (cleaning) return;
  cleaning = true;

  console.log(
    `\n${C.yellow}[start]${C.reset} Cleaning up (${reason || "exit"})...`
  );

  for (const child of children) {
    killTreeAsync(child);
  }

  console.log(`${C.green}[start]${C.reset} All processes stopped.`);

  // Give OS a moment to release ports, then exit
  setTimeout(() => {
    process.exit(0);
  }, 800);
}

// Register cleanup on every termination signal
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => cleanup(sig));
}

// On Windows, when the user closes the console window the parent just gets
// killed.  We listen for the `exit` event as a last resort.  This MUST use
// synchronous killing because async operations are not guaranteed in exit handlers.
process.on("exit", () => {
  for (const child of children) {
    killTreeSync(child);
  }
});

// Unhandled errors should also trigger cleanup
process.on("uncaughtException", (err) => {
  console.error(`${C.red}[start]${C.reset} Unhandled exception:`, err);
  cleanup("unhandled exception");
});

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

/**
 * Prefix every line of `data` with a coloured tag.
 */
function prefixLines(tag, colour, data) {
  const lines = String(data).split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    process.stdout.write(`${colour}[${tag}]${C.reset} ${line}\n`);
  }
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

function launch(name, command, args, opts = {}) {
  const colour = opts.colour || C.cyan;
  const env = { ...process.env, ...(opts.env || {}) };

  // Force coloured output from child processes
  env.FORCE_COLOR = "1";
  env.NODE_OPTIONS = (env.NODE_OPTIONS || "") + " --enable-source-maps";

  const child = spawn(command, args, {
    cwd: opts.cwd || PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // On Unix, start a new process group so we can kill the tree
    detached: !isWin,
    windowsHide: true,
    shell: opts.shell ?? isWin,
    windowsVerbatimArguments: !isWin,
  });

  child.stdout.on("data", (d) => prefixLines(name, colour, d));
  child.stderr.on("data", (d) => prefixLines(name, colour, d));

  child.on("error", (err) => {
    console.error(
      `${C.red}[start]${C.reset} Failed to start ${name}: ${err.message}`
    );
    cleanup(`${name} spawn error`);
  });

  child.on("exit", (code, signal) => {
    if (!cleaning) {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      console.log(
        `${colour}[${name}]${C.reset} exited (${detail})`
      );
      // If one child dies unexpectedly, tear down the other as well.
      // Clean up regardless of exit code to prevent orphan processes.
      cleanup(`${name} exited with ${detail}`);
    }
  });

  children.push(child);
  return child;
}

// ---------------------------------------------------------------------------
// Health check helper
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait for a URL to return a successful response.
 * @param {string} url - URL to check
 * @param {string} label - Human-readable label for logging
 * @param {number} timeoutMs - Maximum wait time in ms
 * @param {function} [validateFn] - Optional function(response) => boolean for extra validation
 * @returns {Promise<boolean>}
 */
async function waitForUrl(url, label, timeoutMs = 20000, validateFn) {
  const start = Date.now();
  process.stdout.write(
    `${C.dim}[start]${C.reset} Waiting for ${label} at ${url} ...`
  );

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      const ok = res.ok || res.status === 200;
      if (ok && (!validateFn || validateFn(res))) {
        process.stdout.write(` ${C.green}OK${C.reset}\n`);
        return true;
      }
    } catch {
      // Not up yet
    }
    await sleep(500);
  }

  process.stdout.write(` ${C.red}TIMEOUT${C.reset}\n`);
  return false;
}

// ---------------------------------------------------------------------------
// Smoke test mode
// ---------------------------------------------------------------------------

/**
 * Smoke test: start both services, verify they respond, then clean up and exit.
 * Returns exit code 0 on success, 1 on failure.
 */
async function smokeTest() {
  console.log("");
  console.log(
    `${C.bold}${C.yellow}[SMOKE TEST]${C.reset} Starting services for verification...`
  );
  console.log("");

  // -----------------------------------------------------------------------
  // Resolve npm executable
  // -----------------------------------------------------------------------
  const npmCmd = isWin ? "npm.cmd" : "npm";

  // -----------------------------------------------------------------------
  // Launch backend using server's own tsx (cwd = PROJECT_ROOT so .env and
  // data/ resolve consistently with README and production semantics)
  // -----------------------------------------------------------------------
  console.log(
    `${C.green}[backend]${C.reset} Starting Hono API server on ${BACKEND_URL}`
  );
  console.log(
    `${C.dim}[backend]${C.reset}   Running '${process.execPath} ${TSX_CLI} watch ${SERVER_ENTRY}' (cwd: project root)`
  );
  launch("backend", process.execPath, [TSX_CLI, "watch", SERVER_ENTRY], {
    colour: C.green,
    cwd: PROJECT_ROOT,
    env: {
      BACKEND_PORT: String(BACKEND_PORT),
      PORT: String(BACKEND_PORT),
    },
    shell: false,
  });

  // -----------------------------------------------------------------------
  // Launch frontend using root npm run dev (Vite)
  // -----------------------------------------------------------------------
  console.log(
    `${C.cyan}[frontend]${C.reset} Starting via 'npm run dev'`
  );
  launch(
    "frontend",
    npmCmd,
    ["run", "dev", "--", "--port", String(FRONTEND_PORT)],
    {
      colour: C.cyan,
      cwd: PROJECT_ROOT,
      env: {
        FRONTEND_PORT: String(FRONTEND_PORT),
        BACKEND_PORT: String(BACKEND_PORT),
      },
      shell: isWin,
    }
  );

  console.log("");

  // -----------------------------------------------------------------------
  // Wait for services
  // -----------------------------------------------------------------------
  const backendOk = await waitForUrl(BACKEND_HEALTH_URL, "backend (health)", 30000);
  const frontendOk = await waitForUrl(FRONTEND_URL, "frontend", 30000);

  console.log("");

  // -----------------------------------------------------------------------
  // Report results
  // -----------------------------------------------------------------------
  if (backendOk && frontendOk) {
    console.log(
      `${C.green}${C.bold}[SMOKE TEST] PASSED${C.reset} - All services responded successfully.`
    );
    console.log(
      `${C.green}[SMOKE TEST]${C.reset}  Backend:  ${BACKEND_HEALTH_URL} OK`
    );
    console.log(
      `${C.green}[SMOKE TEST]${C.reset}  Frontend: ${FRONTEND_URL} OK`
    );
  } else {
    console.log(
      `${C.red}${C.bold}[SMOKE TEST] FAILED${C.reset} - Some services did not respond.`
    );
    if (!backendOk) {
      console.log(
        `${C.red}[SMOKE TEST]${C.reset}  Backend:  ${BACKEND_HEALTH_URL} TIMEOUT`
      );
    }
    if (!frontendOk) {
      console.log(
        `${C.red}[SMOKE TEST]${C.reset}  Frontend: ${FRONTEND_URL} TIMEOUT`
      );
    }
  }

  console.log("");
  console.log(`${C.yellow}[SMOKE TEST]${C.reset} Cleaning up services...`);

  // Set the cleaning flag BEFORE killing children so that the child "exit"
  // handlers don't re-trigger the normal-mode cleanup() path.
  cleaning = true;

  for (const child of children) {
    killTreeAsync(child);
  }

  // Wait briefly for ports to be released
  await sleep(1500);

  // Some package managers/dev servers can outlive their parent process group on
  // macOS. In smoke mode only, clean up any remaining listener on the dedicated
  // development ports before declaring the run failed as a leak.
  for (const port of [BACKEND_PORT, FRONTEND_PORT]) {
    killPortListenersSync(port);
  }
  await sleep(500);

  // Verify ports are released
  let portsReleased = true;
  for (const port of [BACKEND_PORT, FRONTEND_PORT]) {
    try {
      const res = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      // If we get here, the port is still responding
      console.log(
        `${C.red}[SMOKE TEST]${C.reset}  Port ${port} still in use after cleanup!`
      );
      portsReleased = false;
    } catch {
      // Expected -- port is released
      console.log(
        `${C.green}[SMOKE TEST]${C.reset}  Port ${port} released.`
      );
    }
  }

  const exitCode = (backendOk && frontendOk && portsReleased) ? 0 : 1;
  console.log("");
  console.log(
    `${exitCode === 0 ? C.green : C.red}[SMOKE TEST] Exiting with code ${exitCode}${C.reset}`
  );
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Main (normal mode)
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(
    `${C.bold}${C.cyan}============================================================${C.reset}`
  );
  console.log(
    `${C.bold}${C.cyan}        TTS Voice Generator - Quick Start${C.reset}`
  );
  console.log(
    `${C.bold}${C.cyan}============================================================${C.reset}`
  );
  console.log("");

  // -----------------------------------------------------------------------
  // Resolve npm executable
  // -----------------------------------------------------------------------
  const npmCmd = isWin ? "npm.cmd" : "npm";

  // -----------------------------------------------------------------------
  // Launch backend using server's own tsx (cwd = PROJECT_ROOT so .env and
  // data/ resolve consistently with README and production semantics)
  // -----------------------------------------------------------------------
  console.log(
    `${C.green}[backend]${C.reset} Starting Hono API server on ${BACKEND_URL}`
  );
  console.log(
    `${C.dim}[backend]${C.reset}   Running '${process.execPath} ${TSX_CLI} watch ${SERVER_ENTRY}' (cwd: project root)`
  );
  launch("backend", process.execPath, [TSX_CLI, "watch", SERVER_ENTRY], {
    colour: C.green,
    cwd: PROJECT_ROOT,
    env: {
      BACKEND_PORT: String(BACKEND_PORT),
      PORT: String(BACKEND_PORT),
    },
    shell: false,
  });

  // -----------------------------------------------------------------------
  // Launch frontend using root npm run dev (Vite dev server)
  // -----------------------------------------------------------------------
  console.log(
    `${C.cyan}[frontend]${C.reset} Starting Vite dev server on ${FRONTEND_URL}`
  );
  launch(
    "frontend",
    npmCmd,
    ["run", "dev", "--", "--port", String(FRONTEND_PORT)],
    {
      colour: C.cyan,
      cwd: PROJECT_ROOT,
      env: {
        FRONTEND_PORT: String(FRONTEND_PORT),
        BACKEND_PORT: String(BACKEND_PORT),
      },
      shell: isWin,
    }
  );

  console.log("");

  // -----------------------------------------------------------------------
  // Wait for services to become available
  // -----------------------------------------------------------------------
  const backendOk = await waitForUrl(BACKEND_HEALTH_URL, "backend", 20000);
  const frontendOk = await waitForUrl(FRONTEND_URL, "frontend", 20000);

  console.log("");

  if (backendOk && frontendOk) {
    console.log(
      `${C.green}${C.bold}[start] All services are running!${C.reset}`
    );
  } else {
    console.log(
      `${C.yellow}${C.bold}[start] Some services may not be ready yet.${C.reset}`
    );
    if (!backendOk) {
      console.log(
        `${C.yellow}[start]${C.reset}  Backend: ${BACKEND_URL} - not responding`
      );
    }
    if (!frontendOk) {
      console.log(
        `${C.yellow}[start]${C.reset}  Frontend: ${FRONTEND_URL} - not responding`
      );
    }
  }

  console.log("");
  console.log(
    `${C.bold}  Frontend:${C.reset}  ${FRONTEND_URL}`
  );
  console.log(
    `${C.bold}  Backend:${C.reset}   ${BACKEND_HEALTH_URL}`
  );
  console.log(
    `${C.bold}  Stop:${C.reset}      Press Ctrl+C or close this window`
  );
  console.log("");

  // -----------------------------------------------------------------------
  // Keep the process alive until a child exits (which triggers cleanup)
  // -----------------------------------------------------------------------
  await new Promise(() => {
    // The child "exit" handlers above will call cleanup(), which calls
    // process.exit(). This promise intentionally never resolves in normal
    // operation.
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (SMOKE_MODE) {
  smokeTest().catch((err) => {
    console.error(`${C.red}[SMOKE TEST]${C.reset} Fatal:`, err);
    for (const child of children) {
      killTreeAsync(child);
    }
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(`${C.red}[start]${C.reset} Fatal:`, err);
    cleanup("fatal error");
  });
}
