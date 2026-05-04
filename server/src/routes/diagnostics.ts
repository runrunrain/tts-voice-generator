import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { getDb } from "../db/index.js";
import { agentActionLog, generationJob } from "../db/schema.js";
import { getAudioBaseDir } from "../utils/audio-fs.js";
import { buildReadinessSnapshot, serverStartTime } from "./health.js";

const diagnostics = new Hono();
const SERVER_VERSION = "0.1.0";
const MAX_TEXT_LENGTH = 120;

function truncateText(value: string | null | undefined): string | null {
  if (!value) return null;
  const redacted = value
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***redacted***")
    .replace(/lpt_[A-Za-z0-9_\-]{8,}/g, "lpt_***redacted***")
    .replace(/sha256:[a-fA-F0-9]{16,}/g, "sha256:***redacted***");
  return redacted.length > MAX_TEXT_LENGTH ? `${redacted.slice(0, MAX_TEXT_LENGTH)}...` : redacted;
}

function toIso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function getAudioDirInfo() {
  const baseDir = getAudioBaseDir();
  let writable = false;
  let fileCount = 0;
  let totalSizeBytes = 0;

  try {
    fs.mkdirSync(baseDir, { recursive: true });
    const probePath = path.join(baseDir, `.diagnostics-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probePath, "ok");
    fs.unlinkSync(probePath);
    writable = true;
  } catch {
    writable = false;
  }

  try {
    const stack = [baseDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || !fs.existsSync(current)) continue;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          fileCount += 1;
          totalSizeBytes += fs.statSync(fullPath).size;
        }
      }
    }
  } catch {
    fileCount = 0;
    totalSizeBytes = 0;
  }

  return {
    path: path.relative(process.cwd(), baseDir).replace(/\\/g, "/") || ".",
    writable,
    fileCount,
    totalSizeBytes,
  };
}

diagnostics.get("/api/diagnostics", (c) => {
  const readiness = buildReadinessSnapshot();
  const db = getDb();
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  const audioDirInfo = getAudioDirInfo();

  const failedJobs = db
    .select()
    .from(generationJob)
    .where(eq(generationJob.status, "failed"))
    .orderBy(desc(generationJob.createdAt))
    .limit(5)
    .all()
    .map((job) => ({
      id: job.id,
      status: job.status,
      source: job.source,
      voice: job.voice,
      format: job.responseFormat,
      inputCharCount: job.inputCharCount,
      charCount: job.inputCharCount,
      errorCode: job.errorCode,
      errorMessage: truncateText(job.errorMessage),
      error: truncateText(job.errorMessage) ?? job.errorCode ?? "Unknown error",
      createdAt: toIso(job.createdAt),
      completedAt: toIso(job.completedAt),
    }));

  const recentAgentActions = db
    .select()
    .from(agentActionLog)
    .orderBy(desc(agentActionLog.createdAt))
    .limit(5)
    .all()
    .map((action) => ({
      id: action.id,
      conversationId: truncateText(action.conversationId),
      actionType: action.actionType,
      action: action.actionType,
      toolName: action.toolName,
      approvalStatus: action.approvalStatus,
      status: action.errorCode ? "failed" : action.approvalStatus,
      approvalScope: action.approvalScope,
      relatedJobId: action.relatedJobId,
      inputSummary: truncateText(action.inputSummary),
      outputSummary: truncateText(action.outputSummary),
      errorCode: action.errorCode,
      errorMessage: truncateText(action.errorMessage),
      createdAt: toIso(action.createdAt),
      completedAt: toIso(action.completedAt),
    }));

  const recentJobs = db
    .select()
    .from(generationJob)
    .orderBy(desc(generationJob.createdAt))
    .limit(5)
    .all()
    .map((job) => ({
      id: job.id,
      status: job.status,
      source: job.source,
      voice: job.voice,
      format: job.responseFormat,
      inputCharCount: job.inputCharCount,
      charCount: job.inputCharCount,
      errorCode: job.status === "failed" ? job.errorCode : null,
      createdAt: toIso(job.createdAt),
      completedAt: toIso(job.completedAt),
    }));

  return c.json({
    ok: true,
    status: readiness.ready ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    version: SERVER_VERSION,
    uptime,
    server: {
      version: SERVER_VERSION,
      uptime,
      nodeEnv: env.nodeEnv,
    },
    ready: readiness.ready,
    checks: readiness.checks,
    summary: readiness.summary,
    dbOk: readiness.summary.dbOk,
    audioDirWritable: readiness.summary.audioDirWritable,
    keyConfigured: readiness.summary.keyConfigured,
    routesReady: readiness.summary.routesReady,
    failedJobs,
    recentFailedJobs: failedJobs,
    recentAgentActions,
    recentJobs,
    audioDir: audioDirInfo,
    audioDirPath: audioDirInfo.path,
  });
});

export default diagnostics;
