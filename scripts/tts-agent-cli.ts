#!/usr/bin/env npx tsx
/**
 * TTS Agent CLI - Command-line interface for voice production tasks.
 *
 * Usage:
 *   npx tsx scripts/tts-agent-cli.ts <command> [options]
 *
 * Commands:
 *   task create --title "My Task" [--description "desc"]
 *   task list [--json]
 *   task get --taskId <id> [--json]
 *   document paste --taskId <id> --fileName "name.txt" --content "text"
 *   production get --taskId <id> [--json]
 *   production validate --taskId <id> [--json]
 *   production versions --taskId <id> [--json]
 *   production diff --taskId <id> --from <n> --to <n> [--json]
 *   production rollback --taskId <id> --target <n> [--json]
 *   production export --taskId <id> --format json|md|csv [--output <path>]
 *   production import --taskId <id> --file <path> [--format json|csv] [--json]
 *   production generate --taskId <id> [--lineIds <ids>] [--skipCompleted true|false] [--source cli|agent] --confirm [--json]
 *   production quality --taskId <id> [--json]
 *   director list [--taskId <id>] [--json]
 *   director create --taskId <id> --name <name> [--config <json>] [--json]
 */

import { parseArgs } from "node:util";
import fs from "node:fs";

const BASE_URL = process.env.TTS_API_URL || "http://127.0.0.1:3001";

// ─── HTTP Helpers ──────────────────────────────────────────────────────────────

async function apiGet(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

async function apiGetRaw(path: string): Promise<{ text: () => Promise<string>; status: number; headers: Headers }> {
  const res = await fetch(`${BASE_URL}${path}`);
  return { text: () => res.text(), status: res.status, headers: res.headers };
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiPatch(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Command Handlers ──────────────────────────────────────────────────────────

async function taskCreate(args: Record<string, string | boolean | undefined>, json: boolean) {
  const title = args.title as string;
  if (!title) {
    console.error("Error: --title is required");
    process.exit(1);
  }

  const result = await apiPost("/api/tasks", {
    title,
    description: (args.description as string) || "",
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    console.log(`Task created: ${result.task.id}`);
    console.log(`  Title: ${result.task.title}`);
    console.log(`  Status: ${result.task.status}`);
  }
}

async function taskList(args: Record<string, string | boolean | undefined>, json: boolean) {
  const result = await apiGet("/api/tasks");

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    if (result.tasks.length === 0) {
      console.log("No tasks found.");
      return;
    }
    console.log(`Tasks (${result.tasks.length}):`);
    for (const t of result.tasks) {
      console.log(`  ${t.id}  [${t.status}]  ${t.title}`);
      if (t.description) console.log(`    ${t.description}`);
    }
  }
}

async function taskGet(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  if (!taskId) {
    console.error("Error: --taskId is required");
    process.exit(1);
  }

  const result = await apiGet(`/api/tasks/${taskId}`);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    const t = result.task;
    console.log(`Task: ${t.id}`);
    console.log(`  Title: ${t.title}`);
    console.log(`  Description: ${t.description || "(none)"}`);
    console.log(`  Status: ${t.status}`);
    console.log(`  Created: ${t.createdAt}`);
    console.log(`  Updated: ${t.updatedAt}`);
  }
}

async function documentPaste(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  const fileName = args.fileName as string;
  const content = args.content as string;

  if (!taskId || !fileName || !content) {
    console.error("Error: --taskId, --fileName, and --content are required");
    process.exit(1);
  }

  const result = await apiPost(`/api/tasks/${taskId}/documents/paste`, {
    fileName,
    content,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    console.log(`Document pasted: ${result.document.id}`);
    console.log(`  File: ${result.document.fileName}`);
    console.log(`  Size: ${result.document.contentSizeBytes} bytes`);
  }
}

async function productionGet(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  if (!taskId) {
    console.error("Error: --taskId is required");
    process.exit(1);
  }

  const result = await apiGet(`/api/tasks/${taskId}/production-list`);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    const pl = result.productionList;
    console.log(`Production List (v${pl.version}):`);
    console.log(`  Lines: ${pl.lines?.length ?? 0}`);
    console.log(`  Speakers: ${pl.speakers?.map((s: any) => s.label).join(", ") ?? "none"}`);
    for (const line of pl.lines ?? []) {
      console.log(`  [${line.order}] ${line.speaker}: ${line.text.slice(0, 60)}${line.text.length > 60 ? "..." : ""}`);
    }
  }
}

async function productionValidate(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  if (!taskId) {
    console.error("Error: --taskId is required");
    process.exit(1);
  }

  const result = await apiPost(`/api/tasks/${taskId}/production-list/validate`, {});

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    const v = result.validation;
    console.log(`Validation: ${v.valid ? "PASS" : "FAIL"}`);
    console.log(`  Lines: ${v.stats.totalLines}`);
    console.log(`  Speakers: ${v.stats.speakers.join(", ") || "none"}`);
    for (const issue of v.issues) {
      const icon = issue.severity === "error" ? "!" : issue.severity === "warning" ? "?" : "i";
      console.log(`  [${icon}] ${issue.code}: ${issue.message}`);
    }
  }
}

async function productionVersions(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  if (!taskId) {
    console.error("Error: --taskId is required");
    process.exit(1);
  }

  const result = await apiGet(`/api/tasks/${taskId}/production-list/versions`);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    const versions = result.versions;
    if (versions.length === 0) {
      console.log("No versions found.");
      return;
    }
    console.log(`Versions (${versions.length}):`);
    for (const v of versions) {
      console.log(`  v${v.version}  lines=${v.lineCount}  ${v.createdAt}`);
    }
  }
}

async function productionDiff(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  const from = args.from as string;
  const to = args.to as string;

  if (!taskId || !from || !to) {
    console.error("Error: --taskId, --from, and --to are required");
    process.exit(1);
  }

  const result = await apiGet(`/api/tasks/${taskId}/production-list/versions/${from}/diff/${to}`);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    const diff = result.diff;
    console.log(`Diff: v${diff.fromVersion} -> v${diff.toVersion}`);
    console.log(`  Summary: +${diff.summary.addedCount} added, -${diff.summary.removedCount} removed, ~${diff.summary.changedCount} changed, =${diff.summary.unchangedCount} unchanged`);
    if (diff.added.length > 0) console.log(`  Added: ${diff.added.join(", ")}`);
    if (diff.removed.length > 0) console.log(`  Removed: ${diff.removed.join(", ")}`);
    if (diff.changed.length > 0) {
      for (const c of diff.changed) {
        console.log(`  Changed: ${c.lineId} (${c.fields.join(", ")})`);
      }
    }
  }
}

async function productionRollback(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  const target = parseInt(args.target as string, 10);

  if (!taskId || isNaN(target)) {
    console.error("Error: --taskId and --target (version number) are required");
    process.exit(1);
  }

  // Get current version first
  const plResult = await apiGet(`/api/tasks/${taskId}/production-list`);
  if (!plResult.ok) {
    console.error(`Error: ${plResult.error?.message || "Failed to get current production list"}`);
    process.exit(1);
  }
  const currentVersion = plResult.productionList.version;

  const result = await apiPost(`/api/tasks/${taskId}/production-list/rollback`, {
    expectedVersion: currentVersion,
    targetVersion: target,
    summary: `CLI rollback from v${currentVersion} to v${target}`,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    console.log(`Rollback successful:`);
    console.log(`  From: v${result.rollback.fromVersion}`);
    console.log(`  Target: v${result.rollback.targetVersion}`);
    console.log(`  New version: v${result.rollback.newVersion}`);
    console.log(`  Lines: ${result.productionList.lines.length}`);
  }
}

async function productionExport(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  const format = (args.format as string) || "json";
  const output = args.output as string | undefined;

  if (!taskId) {
    console.error("Error: --taskId is required");
    process.exit(1);
  }

  if (!["json", "md", "csv", "markdown"].includes(format)) {
    console.error("Error: --format must be json, md, or csv");
    process.exit(1);
  }

  const url = `/api/tasks/${taskId}/production-list/export?format=${format}`;
  const response = await apiGetRaw(url);
  const text = await response.text();

  if (response.status !== 200) {
    console.error(`Error: ${text}`);
    process.exit(1);
  }

  if (output) {
    fs.writeFileSync(output, text, "utf-8");
    console.log(`Exported to ${output}`);
  } else {
    console.log(text);
  }
}

async function productionImport(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  const file = args.file as string;
  const format = (args.format as string) || "json";

  if (!taskId || !file) {
    console.error("Error: --taskId and --file are required");
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error(`Error: File not found: ${file}`);
    process.exit(1);
  }

  const content = fs.readFileSync(file, "utf-8");
  let data: unknown;

  if (format === "json") {
    try {
      data = JSON.parse(content);
    } catch {
      console.error("Error: File is not valid JSON");
      process.exit(1);
    }
  } else {
    data = content; // CSV: pass raw string
  }

  // Get current version
  const plResult = await apiGet(`/api/tasks/${taskId}/production-list`);
  if (!plResult.ok) {
    console.error(`Error: ${plResult.error?.message || "Failed to get current production list"}`);
    process.exit(1);
  }
  const currentVersion = plResult.productionList.version;

  const result = await apiPost(`/api/tasks/${taskId}/production-list/import`, {
    expectedVersion: currentVersion,
    format,
    data,
    summary: `CLI import from ${file}`,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    console.log(`Import successful:`);
    console.log(`  Imported lines: ${result.import.importedLines}`);
    console.log(`  Skipped lines: ${result.import.skippedLines}`);
    if (result.import.errors) {
      for (const err of result.import.errors) {
        console.log(`  Error at line ${err.index}: ${err.message}`);
      }
    }
    if (result.import.directorWarnings) {
      for (const w of result.import.directorWarnings) {
        console.log(`  Warning: ${w}`);
      }
    }
    console.log(`  New version: ${result.productionList.version}`);
  }
}

async function productionGenerate(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  if (!taskId) {
    console.error("Error: --taskId is required");
    process.exit(1);
  }

  const source = (args.source as string) || "cli";
  if (source !== "cli" && source !== "agent") {
    console.error("Error: --source must be cli or agent");
    process.exit(1);
  }

  const confirm = args.confirm === true;
  if (!confirm) {
    // Non-user sources without explicit confirm must refuse to send the request
    // to prevent accidental real cost actions.
    console.error(
      `Error: --confirm is required for source "${source}". ` +
      `This prevents automated tools from silently triggering real external cost actions.`
    );
    process.exit(1);
  }

  const lineIdsStr = args.lineIds as string | undefined;
  const lineIds = lineIdsStr
    ? lineIdsStr.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  const skipCompletedStr = (args.skipCompleted as string) || "true";
  const skipCompleted = skipCompletedStr !== "false";

  const payload: Record<string, unknown> = {
    source,
    confirm: true,
    skipCompleted,
  };
  if (lineIds.length > 0) {
    payload.lineIds = lineIds;
  }

  const result = await apiPost(`/api/tasks/${taskId}/production-list/generate`, payload);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || result.error?.code || "Unknown error"}`);
      if (result.error?.metadata) {
        console.error(`  Code: ${result.error.code}`);
        console.error(`  Metadata: ${JSON.stringify(result.error.metadata)}`);
      }
      process.exit(1);
    }
    const g = result.generation;
    console.log(`Production generate result:`);
    console.log(`  Task: ${g.taskId}`);
    console.log(`  Version: ${g.version}`);
    console.log(`  Requested: ${g.requestedCount}`);
    console.log(`  Succeeded: ${g.succeededCount}`);
    console.log(`  Failed: ${g.failedCount}`);
    console.log(`  Skipped: ${g.skippedCount}`);

    if (g.results && g.results.length > 0) {
      console.log(`  Lines:`);
      for (const r of g.results) {
        const parts = [`[${r.status}]`, `lineId=${r.lineId}`];
        if (r.jobId) parts.push(`job=${r.jobId}`);
        if (r.assetId !== undefined && r.assetId !== null) parts.push(`asset=${r.assetId}`);
        if (r.errorCode) parts.push(`error=${r.errorCode}`);
        if (r.errorMessage) parts.push(`(${r.errorMessage.slice(0, 80)})`);
        console.log(`    ${parts.join(" ")}`);
      }
    }
  }
}

async function productionQuality(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  if (!taskId) {
    console.error("Error: --taskId is required");
    process.exit(1);
  }

  const result = await apiGet(`/api/tasks/${taskId}/production-list/quality-report`);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    const report = result.qualityReport;
    console.log(`Quality Report (v${report.version}):`);
    console.log(`  Total lines: ${report.totalLines}`);

    if (report.metrics.missingFields) {
      const mf = report.metrics.missingFields;
      console.log(`  Missing fields: text=${mf.text}, voice=${mf.voice}, speaker=${mf.speaker}, director=${mf.directorProfile}`);
    }
    if (report.metrics.directorReuse) {
      const dr = report.metrics.directorReuse;
      console.log(`  Director reuse: ${dr.uniqueProfiles} unique, ${dr.sharedProfiles} shared (max reuse: ${dr.maxReuseCount})`);
    }
    if (report.metrics.suspectedDuplicates) {
      console.log(`  Suspected duplicates: ${report.metrics.suspectedDuplicates.groups} groups`);
    }
    if (report.metrics.longText) {
      console.log(`  Long text (>500 chars): ${report.metrics.longText.count} lines`);
    }
    if (report.metrics.validationSummary) {
      const vs = report.metrics.validationSummary;
      console.log(`  Status summary: ${Object.entries(vs).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (report.metrics.generationSummary) {
      const gs = report.metrics.generationSummary;
      console.log(`  Generation summary: ${Object.entries(gs).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }

    if (report.issues && report.issues.length > 0) {
      console.log(`  Issues (${report.issues.length}):`);
      for (const issue of report.issues) {
        const icon = issue.severity === "error" ? "!" : issue.severity === "warning" ? "?" : "i";
        console.log(`    [${icon}] ${issue.code}: ${issue.message}`);
      }
    }
  }
}

async function directorList(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  const path = taskId ? `/api/tasks/${taskId}/director-profiles` : "/api/director-profiles";

  const result = await apiGet(path);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    const profiles = result.profiles ?? result.directorProfiles ?? [];
    if (profiles.length === 0) {
      console.log("No director profiles found.");
      return;
    }
    console.log(`Director Profiles (${profiles.length}):`);
    for (const p of profiles) {
      console.log(`  ${p.id}  ${p.name}`);
    }
  }
}

async function directorCreate(args: Record<string, string | boolean | undefined>, json: boolean) {
  const taskId = args.taskId as string;
  const name = args.name as string;
  const configStr = args.config as string;

  if (!taskId || !name) {
    console.error("Error: --taskId and --name are required");
    process.exit(1);
  }

  let config = {};
  if (configStr) {
    try {
      config = JSON.parse(configStr);
    } catch {
      console.error("Error: --config must be valid JSON");
      process.exit(1);
    }
  }

  const result = await apiPost(`/api/tasks/${taskId}/director-profiles`, {
    name,
    config,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`Error: ${result.error?.message || "Unknown error"}`);
      process.exit(1);
    }
    console.log(`Director profile created: ${result.profile.id}`);
    console.log(`  Name: ${result.profile.name}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
TTS Agent CLI - Voice production command-line interface

Usage:
  npx tsx scripts/tts-agent-cli.ts <command> [options]

Commands:
  task create   --title <title> [--description <desc>]  Create a task
  task list     [--json]                                List tasks
  task get      --taskId <id> [--json]                  Get task details
  document paste --taskId <id> --fileName <name> --content <text>  Paste document
  production get      --taskId <id> [--json]            Get production list
  production validate --taskId <id> [--json]            Validate production list
  production versions --taskId <id> [--json]            List version history
  production diff     --taskId <id> --from <n> --to <n> [--json]  Version diff
  production rollback --taskId <id> --target <n> [--json]  Rollback to version
  production export   --taskId <id> --format json|md|csv [--output <path>]
  production import   --taskId <id> --file <path> [--format json|csv] [--json]
  production generate --taskId <id> [--lineIds <ids>] [--skipCompleted true|false] [--source cli|agent] --confirm [--json]
  production quality  --taskId <id> [--json]            Quality report
  director list       [--taskId <id>] [--json]          List director profiles
  director create     --taskId <id> --name <name> [--config <json>] [--json]

Environment:
  TTS_API_URL  API base URL (default: http://127.0.0.1:3001)
`);
}

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  printUsage();
  process.exit(0);
}

const command = rawArgs[0];
const restArgs = rawArgs.slice(1);

// Parse remaining arguments
const parsedArgs: Record<string, string | boolean | undefined> = {};
for (let i = 0; i < restArgs.length; i++) {
  if (restArgs[i].startsWith("--")) {
    const key = restArgs[i].slice(2);
    if (i + 1 < restArgs.length && !restArgs[i + 1].startsWith("--")) {
      parsedArgs[key] = restArgs[i + 1];
      i++;
    } else {
      parsedArgs[key] = true;
    }
  }
}

const json = parsedArgs.json === true;

try {
  switch (command) {
    case "task":
      switch (restArgs[0]) {
        case "create": await taskCreate(parsedArgs, json); break;
        case "list": await taskList(parsedArgs, json); break;
        case "get": await taskGet(parsedArgs, json); break;
        default: console.error(`Unknown task subcommand: ${restArgs[0]}`); printUsage(); process.exit(1);
      }
      break;
    case "document":
      switch (restArgs[0]) {
        case "paste": await documentPaste(parsedArgs, json); break;
        default: console.error(`Unknown document subcommand: ${restArgs[0]}`); printUsage(); process.exit(1);
      }
      break;
    case "production":
      switch (restArgs[0]) {
        case "get": await productionGet(parsedArgs, json); break;
        case "validate": await productionValidate(parsedArgs, json); break;
        case "versions": await productionVersions(parsedArgs, json); break;
        case "diff": await productionDiff(parsedArgs, json); break;
        case "rollback": await productionRollback(parsedArgs, json); break;
        case "export": await productionExport(parsedArgs, json); break;
        case "import": await productionImport(parsedArgs, json); break;
        case "generate": await productionGenerate(parsedArgs, json); break;
        case "quality": await productionQuality(parsedArgs, json); break;
        default: console.error(`Unknown production subcommand: ${restArgs[0]}`); printUsage(); process.exit(1);
      }
      break;
    case "director":
      switch (restArgs[0]) {
        case "list": await directorList(parsedArgs, json); break;
        case "create": await directorCreate(parsedArgs, json); break;
        default: console.error(`Unknown director subcommand: ${restArgs[0]}`); printUsage(); process.exit(1);
      }
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
} catch (err) {
  console.error(`Fatal: ${err instanceof Error ? err.message : "Unknown error"}`);
  process.exit(1);
}
