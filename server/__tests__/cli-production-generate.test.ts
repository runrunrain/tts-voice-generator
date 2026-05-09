/**
 * CLI `production generate` subcommand tests.
 *
 * Tests the CLI-level argument parsing and cost guard behavior using a
 * lightweight HTTP intercept approach. The CLI script is invoked as a
 * subprocess so we can verify stdout/stderr/exit-code without modifying
 * the script itself.
 *
 * Coverage:
 *  1. Missing --taskId -> error exit
 *  2. Missing --confirm -> error exit, no HTTP request sent
 *  3. Invalid --source value -> error exit
 *  4. With --confirm, --source cli -> correct POST payload forwarded
 *  5. With --confirm, --source agent -> correct POST payload forwarded
 *  6. --lineIds comma-separated parsing
 *  7. --skipCompleted false parsing
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

const execFile = promisify(execFileCb);

// The CLI script lives at the project root, not inside server/
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI_SCRIPT = path.join(PROJECT_ROOT, "scripts", "tts-agent-cli.ts");

// ─── Lightweight mock server ──────────────────────────────────────────────────
// Captures the request so we can assert on method/path/body.

let captured: {
  method: string;
  url: string;
  body: unknown;
} | null = null;

let server: http.Server;
let baseUrl: string;

function startMockServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        captured = {
          method: req.method ?? "",
          url: req.url ?? "",
          body: body.length > 0 ? JSON.parse(body) : null,
        };
        // Respond with a mock generation result
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            requestId: "mock-request-id",
            generation: {
              taskId: "test-task-1",
              version: 1,
              requestedCount: 1,
              succeededCount: 0,
              failedCount: 1,
              skippedCount: 0,
              results: [
                {
                  lineId: "line_1",
                  status: "failed",
                  errorCode: "MISSING_API_KEY",
                  errorMessage: "API key not configured",
                },
              ],
            },
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server.on("error", reject);
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) return resolve();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// Helper to run the CLI script with given arguments
function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const env = { ...process.env, TTS_API_URL: baseUrl };
    execFile(
      "npx",
      ["tsx", CLI_SCRIPT, ...args],
      {
        cwd: PROJECT_ROOT,
        env,
        timeout: 30_000,
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: err && "code" in err ? (err.code as number) : err ? 1 : 0,
        });
      }
    );
  });
}

describe("CLI production generate subcommand", () => {
  beforeAll(async () => {
    await startMockServer();
  });

  afterAll(async () => {
    await stopMockServer();
  });

  // Reset captured request between tests
  // (Vitest runs tests sequentially within a describe block by default)

  it("exits with error when --taskId is missing", async () => {
    captured = null;
    const result = await runCli(["production", "generate", "--confirm"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--taskId is required");
    // No HTTP request should have been sent
    expect(captured).toBeNull();
  }, 15_000);

  it("exits with error when --confirm is not provided", async () => {
    captured = null;
    const result = await runCli(["production", "generate", "--taskId", "task-1"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--confirm is required");
    // No HTTP request should have been sent
    expect(captured).toBeNull();
  }, 15_000);

  it("exits with error when --source is invalid", async () => {
    captured = null;
    const result = await runCli(["production", "generate", "--taskId", "task-1", "--confirm", "--source", "user"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--source must be cli or agent");
    // No HTTP request should have been sent
    expect(captured).toBeNull();
  }, 15_000);

  it("sends correct payload with --confirm and default --source cli", async () => {
    captured = null;
    const result = await runCli(["production", "generate", "--taskId", "task-1", "--confirm"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Production generate result");

    // Verify the HTTP request was correct
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toBe("/api/tasks/task-1/production-list/generate");
    expect(captured!.body).toEqual({
      source: "cli",
      confirm: true,
      skipCompleted: true,
    });
  }, 15_000);

  it("sends correct payload with --source agent and --confirm", async () => {
    captured = null;
    const result = await runCli([
      "production", "generate",
      "--taskId", "task-2",
      "--source", "agent",
      "--confirm",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Production generate result");

    expect(captured).not.toBeNull();
    expect(captured!.body).toEqual({
      source: "agent",
      confirm: true,
      skipCompleted: true,
    });
  }, 15_000);

  it("sends --lineIds as parsed array in payload", async () => {
    captured = null;
    const result = await runCli([
      "production", "generate",
      "--taskId", "task-3",
      "--lineIds", "line-a,line-b,line-c",
      "--confirm",
    ]);
    expect(result.exitCode).toBe(0);

    expect(captured).not.toBeNull();
    expect((captured!.body as Record<string, unknown>).lineIds).toEqual(["line-a", "line-b", "line-c"]);
  }, 15_000);

  it("sends skipCompleted=false when explicitly set to false", async () => {
    captured = null;
    const result = await runCli([
      "production", "generate",
      "--taskId", "task-4",
      "--skipCompleted", "false",
      "--confirm",
    ]);
    expect(result.exitCode).toBe(0);

    expect(captured).not.toBeNull();
    expect((captured!.body as Record<string, unknown>).skipCompleted).toBe(false);
  }, 15_000);

  it("sends skipCompleted=true (default) when not specified", async () => {
    captured = null;
    const result = await runCli([
      "production", "generate",
      "--taskId", "task-5",
      "--confirm",
    ]);
    expect(result.exitCode).toBe(0);

    expect(captured).not.toBeNull();
    expect((captured!.body as Record<string, unknown>).skipCompleted).toBe(true);
  }, 15_000);

  it("does not include lineIds in payload when --lineIds is omitted", async () => {
    captured = null;
    const result = await runCli([
      "production", "generate",
      "--taskId", "task-6",
      "--confirm",
    ]);
    expect(result.exitCode).toBe(0);

    expect(captured).not.toBeNull();
    const body = captured!.body as Record<string, unknown>;
    expect(body.lineIds).toBeUndefined();
  }, 15_000);

  it("outputs JSON format when --json is passed", async () => {
    captured = null;
    const result = await runCli([
      "production", "generate",
      "--taskId", "task-7",
      "--confirm",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);

    // Should be valid JSON
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.generation).toBeDefined();
    expect(parsed.generation.taskId).toBe("test-task-1");
  }, 15_000);
});
