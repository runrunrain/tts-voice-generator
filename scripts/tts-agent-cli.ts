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
 */

import { parseArgs } from "node:util";

const BASE_URL = process.env.TTS_API_URL || "http://127.0.0.1:3001";

// ─── HTTP Helpers ──────────────────────────────────────────────────────────────

async function apiGet(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
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
        default: console.error(`Unknown production subcommand: ${restArgs[0]}`); printUsage(); process.exit(1);
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
