/**
 * Agent Button Presets and Execution routes.
 *
 * GET  /api/agent/buttons                                       - List button presets
 * POST /api/tasks/:taskId/agent/normalize-requirements          - Normalize documents to production list
 * POST /api/tasks/:taskId/agent/buttons/:buttonKey/execute      - Execute button on a line
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { eq, and, desc, or } from "drizzle-orm";
import fs from "node:fs";
import { getDb } from "../db/index.js";
import {
  voiceTask,
  requirementDocument,
  productionListVersion,
  voiceLine,
  directorProfile,
  agentButtonPreset,
  agentButtonRun,
  operationAuditLog,
} from "../db/schema-extended.js";
import { ExecuteButtonSchema, VoiceLineSchema, NormalizeRequestBodySchema, validateRawPromptStructuredAgentDraft, validateBusinessQualityGate, RawPromptStructuredAgentDraftSchema, type BusinessQualityReport, type PromptProfile, type PromptSpeaker } from "../domain/validators.js";
import {
  writeArtifact,
  readArtifact,
  productionListArtifactName,
  productionListVersionArtifactName,
  buttonRunArtifactName,
} from "../services/artifact-store.js";
import { loadVersionLines } from "./production-list-modules/repository.js";
import {
  checkOpenCodeAvailability,
  runBundleOpenCodeNormalize,
  applyFallbackTransform,
  sanitizeError,
  sanitizeString,
  computeBundleNormalizeTimeout,
  extractCandidateLines,
  type RunnerStatus,
} from "../services/opencode-runner.js";
import {
  createNormalizeRun,
  generateNormalizeRequestBundle,
  writeNormalizeRequestBundle,
  writeCandidateLinesArtifact,
  writeInstructionMarkdown,
  writeValidationReport,
  writeCommitResult,
  writeRunProgress,
  readRunProgress,
  listNormalizeRunProgress,
  readNormalizeDraft,
  getNormalizeRunPaths,
  getDocumentArtifactPath,
  validateDraftInRunDir,
  type InstructionContext,
  type InputDocumentRef,
  type NormalizeRunProgress,
  type NormalizeRunStage,
  type RunPaths,
} from "../services/normalize-run-store.js";
import {
  generateProductionListSchemaSnapshot,
  writeSchemaSnapshot,
} from "../services/schema-exporter.js";
import { validateProductionList, type ValidationReport } from "../domain/validators.js";
import { getVoiceDisplayNameZh } from "../utils/voice.js";

const app = new Hono();

const TERMINAL_NORMALIZE_STAGES = new Set<NormalizeRunStage>(["completed", "failed"]);
const NORMALIZE_PROGRESS_STALE_GRACE_MS = 60_000;
const DEFAULT_NORMALIZE_SYNC_WAIT_MS = 30_000;
const activeNormalizeRuns = new Map<string, { runId: string; progressUrl: string }>();

function apiError(c: any, requestId: string, status: number, code: string, message: string, category: string, retryable = false, metadata?: unknown) {
  return c.json({ ok: false, requestId, error: { code, message, category, retryable, metadata } }, status);
}

function logicalLineId(line: { id: string; lineId?: string | null }): string {
  return line.lineId ?? line.id;
}

function auditLog(entityType: string, entityId: string, operation: string, actor: string, snapshot?: unknown, requestId?: string) {
  try {
    const db = getDb();
    db.insert(operationAuditLog).values({
      entityType,
      entityId,
      operation,
      actor,
      snapshotJson: snapshot ? JSON.stringify(snapshot) : null,
      requestId: requestId ?? null,
      createdAt: new Date(),
    }).run();
  } catch { /* non-critical */ }
}

const DIRECTOR_PROFILE_REQUIRED_FIELDS = ["audioProfile", "scene", "directorNotes", "sampleContext"] as const;
const DIRECTOR_PROFILE_STYLE_FIELDS = ["style", "pacing", "accent", "emotion", "performanceNotes"] as const;

function cjkCount(value: string): number {
  return value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
}

function latinCount(value: string): number {
  return value.match(/[A-Za-z]/g)?.length ?? 0;
}

function needsChineseDirectorRewrite(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const cjk = cjkCount(trimmed);
  const latin = latinCount(trimmed);
  return cjk === 0 || latin > cjk * 2;
}

function normalizeSpeakerLabel(label: string): string {
  return label.trim().toLowerCase() === "narrator" ? "旁白" : label.trim();
}

function profileChineseContext(profile: PromptProfile): { roleLabel: string; voice: string; voiceZh: string; speakerStyle: string } {
  const primarySpeaker = profile.speakers[0];
  const rawRoleLabel = primarySpeaker?.label?.trim() || profile.name.trim() || "旁白";
  const roleLabel = normalizeSpeakerLabel(rawRoleLabel) || "旁白";
  const voice = primarySpeaker?.voice?.trim() || "Zephyr";
  return {
    roleLabel,
    voice,
    voiceZh: getVoiceDisplayNameZh(voice),
    speakerStyle: primarySpeaker?.style?.trim() || "",
  };
}

function chineseDirectorFallback(
  profile: PromptProfile,
  field: typeof DIRECTOR_PROFILE_REQUIRED_FIELDS[number] | typeof DIRECTOR_PROFILE_STYLE_FIELDS[number] | "name" | "description" | "speakerStyle",
): string {
  const context = profileChineseContext(profile);
  const role = context.roleLabel;
  const voiceLabel = `${context.voiceZh}（${context.voice}）`;
  switch (field) {
    case "name":
      return `${role}导演配置`;
    case "description":
      return `${role}相关台词的中文导演配置。`;
    case "audioProfile":
      return `${role}使用${voiceLabel}音色，突出角色身份、年龄感、音色质感与台词语气。`;
    case "scene":
      return `用于${role}相关台词的语音生产场景，结合原始段落、角色关系和当前对白语境。`;
    case "directorNotes":
      return "按中文语境自然表演，保持台词清晰，不朗读字段名、注释或元数据。";
    case "sampleContext":
      return `这些台词来自${role}相关段落，需延续原文角色设定和上下文情绪。`;
    case "style":
      return context.speakerStyle && !needsChineseDirectorRewrite(context.speakerStyle)
        ? context.speakerStyle
        : `${role}的整体表演风格应贴合角色身份与台词含义。`;
    case "pacing":
      return "节奏自然清晰，按句意停顿，重要信息前后略作留白。";
    case "accent":
      return "以清晰标准的中文咬字为主；除非原文指定，不额外添加口音。";
    case "emotion":
      return "情绪基调根据台词语义和角色关系自然变化。";
    case "performanceNotes":
      return "避免朗读导演字段、标签或元数据，只输出台词正文。";
    case "speakerStyle":
      return `${role}身份明确，中文表达自然清晰。`;
  }
}

function ensureChineseDirectorText(
  profile: PromptProfile,
  field: Parameters<typeof chineseDirectorFallback>[1],
  value: unknown,
): string {
  const text = typeof value === "string" ? value.trim() : "";
  return needsChineseDirectorRewrite(text) ? chineseDirectorFallback(profile, field) : text;
}

function normalizePromptProfile(profile: PromptProfile): PromptProfile {
  const normalized: PromptProfile = {
    ...profile,
    id: profile.id.trim(),
    name: ensureChineseDirectorText(profile, "name", profile.name),
    description: typeof profile.description === "string" && profile.description.trim()
      ? ensureChineseDirectorText(profile, "description", profile.description)
      : chineseDirectorFallback(profile, "description"),
    audioProfile: ensureChineseDirectorText(profile, "audioProfile", profile.audioProfile),
    scene: ensureChineseDirectorText(profile, "scene", profile.scene),
    directorNotes: ensureChineseDirectorText(profile, "directorNotes", profile.directorNotes),
    sampleContext: ensureChineseDirectorText(profile, "sampleContext", profile.sampleContext),
    speakers: profile.speakers.map((speaker) => ({
      ...speaker,
      id: speaker.id.trim(),
      label: normalizeSpeakerLabel(speaker.label),
      name: typeof speaker.name === "string" ? speaker.name : undefined,
      voice: speaker.voice.trim(),
      style: typeof speaker.style === "string" && speaker.style.trim()
        ? ensureChineseDirectorText(profile, "speakerStyle", speaker.style)
        : "",
    })),
  };

  for (const field of DIRECTOR_PROFILE_STYLE_FIELDS) {
    normalized[field] = ensureChineseDirectorText(normalized, field, profile[field]);
  }

  return normalized;
}

function profileStorageName(taskId: string, profile: PromptProfile): string {
  const suffix = ` (${taskId.slice(0, 8)}:${profile.id.slice(0, 8)})`;
  const maxBaseLength = Math.max(1, 100 - suffix.length);
  return `${profile.name.slice(0, maxBaseLength)}${suffix}`;
}

// ─── GET /api/agent/buttons ────────────────────────────────────────────────────

app.get("/api/agent/buttons", async (c) => {
  const requestId = uuidv4();
  const db = getDb();
  const presets = db.select().from(agentButtonPreset).orderBy(agentButtonPreset.sortOrder).all();

  // Check real OpenCode CLI availability
  const availability = await checkOpenCodeAvailability();

  return c.json({
    ok: true,
    requestId,
    opencodeAvailable: availability.available,
    runnerMode: availability.available ? "opencode" as const : "fallback" as const,
    disabledReason: availability.available ? null : availability.error,
    buttons: presets.filter((p) => p.enabled).map((p) => ({
      id: p.id,
      buttonKey: p.buttonKey,
      name: p.name,
      description: p.description,
      promptTemplate: p.promptTemplate,
      targetPolicy: JSON.parse(p.targetPolicyJson || "{}"),
      sortOrder: p.sortOrder,
      runner: availability.available ? "opencode" as const : "fallback" as const,
    })),
  });
});

// ─── POST /api/tasks/:taskId/agent/normalize-requirements ─────────────────────
//
// Architecture: Bundle-driven Agent Normalize (v1)
//
// Main path (available=true):
//   1. Create normalize run directory and paths
//   2. Export production-list schema snapshot
//   3. Generate normalize-request.json bundle (paths, instruction, safety)
//   4. Write instruction.md
//   5. Call runBundleOpenCodeNormalize() with paths, NOT content
//   6. Agent reads files at paths, writes draft to draftPath
//   7. Backend reads draft, validates, commits to production list
//
// Failure policy for normalize:
//   Agent normalize is a strict Prompt-Structured Production List v2 main path.
//   OpenCode unavailable, runner failure, timeout, missing draft, or unreadable
//   draft returns a structured error with fallbackUsed=false. It must not commit
//   a legacy v1 fallback production list. Button line transforms keep their own
//   fallback behavior below and are intentionally separate from normalize.

type NormalizeDraft = NonNullable<ReturnType<typeof readNormalizeDraft>>;

function estimateNormalizeOutputLineCount(docInputs: Array<{ content: string }>): number {
  return docInputs.reduce((sum, doc) => {
    const nonEmptyLines = doc.content
      .split(/\r\n|\r|\n/)
      .filter((line) => line.trim().length > 0).length;
    return sum + nonEmptyLines;
  }, 0);
}

function responseContext(): { json: (body: unknown, status?: number) => Response } {
  return {
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

function progressUrlFor(taskId: string, runId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/agent/normalize-runs/${encodeURIComponent(runId)}/progress`;
}

function getNormalizeSyncWaitMs(configuredTimeoutMs: number): number {
  const raw = Number.parseInt(process.env.OPENCODE_NORMALIZE_HTTP_WAIT_MS ?? "", 10);
  const envWaitMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NORMALIZE_SYNC_WAIT_MS;
  const configured = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : envWaitMs;
  return Math.max(1, Math.min(envWaitMs, configured));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimeoutDraftRecoveryWaitMs(): number {
  const raw = Number.parseInt(process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

function getTimeoutDraftRecoveryWindowMs(): number {
  const rawWindow = Number.parseInt(process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WINDOW_MS ?? "", 10);
  if (Number.isFinite(rawWindow) && rawWindow >= 0) return rawWindow;

  // Backward-compatible test/operator escape hatch: setting the historical
  // immediate wait to 0 means "do not keep timeout runs pending" unless the new
  // async window is explicitly configured.
  const rawImmediateWait = Number.parseInt(process.env.OPENCODE_TIMEOUT_DRAFT_RECOVERY_WAIT_MS ?? "", 10);
  if (Number.isFinite(rawImmediateWait) && rawImmediateWait === 0) return 0;

  return 120_000;
}

function buildTimeoutRecoveryBasis(timeoutBasis: Record<string, unknown>, recoveryWindowMs = getTimeoutDraftRecoveryWindowMs()): Record<string, unknown> {
  const now = new Date();
  return {
    ...timeoutBasis,
    lateDraftRecovery: true,
    lateDraftRecoveryWindowMs: recoveryWindowMs,
    lateDraftRecoveryStartedAt: now.toISOString(),
    lateDraftRecoveryDeadlineAt: new Date(now.getTime() + recoveryWindowMs).toISOString(),
  };
}

async function waitForDraftAfterTimeout(draftPath: string, waitMs = getTimeoutDraftRecoveryWaitMs(), intervalMs = 250): Promise<NormalizeDraft | null> {
  if (waitMs <= 0) return readNormalizeDraft(draftPath);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const draft = readNormalizeDraft(draftPath);
    if (draft !== null) return draft;
    await sleep(Math.min(Math.max(50, intervalMs), Math.max(1, deadline - Date.now())));
  }
  return readNormalizeDraft(draftPath);
}

function buildNormalizeStillRunningResponse(options: {
  requestId: string;
  runId: string;
  taskId: string;
  configuredTimeoutMs: number;
  timeoutBasis: Record<string, unknown>;
  stage: NormalizeRunStage;
  elapsedMs: number;
  message?: string;
}) {
  return {
    ok: true,
    status: "accepted" as const,
    requestId: options.requestId,
    runId: options.runId,
    progressUrl: progressUrlFor(options.taskId, options.runId),
    stage: options.stage,
    timeoutMs: options.configuredTimeoutMs,
    timeoutBasis: options.timeoutBasis,
    runnerStatus: {
      status: "running",
      reasonCode: "opencode_success",
      elapsedMs: options.elapsedMs,
      timeoutMs: options.configuredTimeoutMs,
      fallbackUsed: false,
    },
    message: options.message ?? "OpenCode normalize is still running; poll progressUrl for the terminal result.",
  };
}

type CapabilityAvailability =
  | { available: true }
  | { available: false; code: string; reason: string };

type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

type AgentRunSummary = {
  runId: string;
  taskId: string;
  kind: "normalize" | "button";
  buttonKey: string;
  title: string;
  status: AgentRunStatus;
  runner: "opencode" | "fallback";
  targetLineIds: string[];
  beforeVersion?: number;
  afterVersion?: number;
  createdAt: string;
  completedAt?: string | null;
  error?: { code?: string | null; message: string } | null;
  retry: CapabilityAvailability;
  diff: CapabilityAvailability;
  cancel: CapabilityAvailability;
};

function safeJsonParse<T = Record<string, unknown>>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function readJsonFile<T = Record<string, unknown>>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function normalizeRunStageToStatus(stage: NormalizeRunStage): AgentRunStatus {
  if (stage === "completed") return "succeeded";
  if (stage === "failed") return "failed";
  if (stage === "queued") return "queued";
  return "running";
}

function buttonRunStatusToStatus(status: string): AgentRunStatus {
  if (status === "completed" || status === "succeeded") return "succeeded";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "pending" || status === "queued") return "queued";
  return "running";
}

function cancelAvailability(): CapabilityAvailability {
  return {
    available: false,
    code: "RUN_CANCEL_UNAVAILABLE",
    reason: "当前后端没有可中断该运行的执行句柄，无法保证取消后不提交结果。",
  };
}

function retryAvailability(status: AgentRunStatus, kind: "normalize" | "button"): CapabilityAvailability {
  if (status === "failed") return { available: true };
  return {
    available: false,
    code: "RUN_RETRY_UNAVAILABLE",
    reason: kind === "normalize" ? "仅失败的 Normalize 运行支持重试。" : "仅失败的按钮运行支持重试。",
  };
}

function diffAvailability(options: { inputSnapshot?: unknown; outputSnapshot?: unknown; beforeVersion?: number; afterVersion?: number }): CapabilityAvailability {
  if (options.inputSnapshot && options.outputSnapshot) return { available: true };
  if (Number.isInteger(options.beforeVersion) && Number.isInteger(options.afterVersion) && options.beforeVersion !== options.afterVersion) return { available: true };
  return {
    available: false,
    code: "RUN_DIFF_UNAVAILABLE",
    reason: "该历史运行缺少 beforeVersion/afterVersion 或快照 artifact，无法计算真实 diff。",
  };
}

function collectChangedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) changed.push(key);
  }
  return changed;
}

function computeLineChanges(beforeLines: Array<Record<string, unknown>>, afterLines: Array<Record<string, unknown>>) {
  const beforeMap = new Map(beforeLines.map((line) => [String(line.id ?? ""), line]));
  const afterMap = new Map(afterLines.map((line) => [String(line.id ?? ""), line]));
  const lineChanges: Array<{ lineId: string; before?: Record<string, unknown>; after?: Record<string, unknown>; fields: string[] }> = [];

  for (const [lineId, after] of afterMap) {
    if (!lineId) continue;
    const before = beforeMap.get(lineId);
    if (!before) {
      lineChanges.push({ lineId, after, fields: ["__added"] });
      continue;
    }
    const fields = collectChangedFields(before, after);
    if (fields.length > 0) lineChanges.push({ lineId, before, after, fields });
  }

  for (const [lineId, before] of beforeMap) {
    if (!lineId || afterMap.has(lineId)) continue;
    lineChanges.push({ lineId, before, fields: ["__removed"] });
  }

  return lineChanges;
}

function summarizeLineChanges(lineChanges: Array<{ fields: string[] }>) {
  return {
    addedCount: lineChanges.filter((change) => change.fields.includes("__added")).length,
    removedCount: lineChanges.filter((change) => change.fields.includes("__removed")).length,
    changedCount: lineChanges.filter((change) => !change.fields.includes("__added") && !change.fields.includes("__removed")).length,
  };
}

function getNormalizeVersionContext(taskId: string, runId: string, paths = getNormalizeRunPaths(taskId, runId)): { beforeVersion?: number; afterVersion?: number } {
  const request = readJsonFile<{ currentState?: { expectedVersion?: number } }>(paths.requestPath);
  const commit = readJsonFile<{ committed?: boolean; newVersion?: number }>(paths.commitResultPath);
  return {
    beforeVersion: typeof request?.currentState?.expectedVersion === "number" ? request.currentState.expectedVersion : undefined,
    afterVersion: commit?.committed === true && typeof commit.newVersion === "number" ? commit.newVersion : undefined,
  };
}

function summarizeNormalizeRun(taskId: string, runId: string, paths: RunPaths, progress: NormalizeRunProgress): AgentRunSummary {
  const versionContext = getNormalizeVersionContext(taskId, runId, paths);
  const status = normalizeRunStageToStatus(progress.stage);
  return {
    runId,
    taskId,
    kind: "normalize",
    buttonKey: "normalize-requirements",
    title: "Generate Production List",
    status,
    runner: "opencode",
    targetLineIds: [],
    ...versionContext,
    createdAt: progress.startedAt,
    completedAt: progress.completedAt ?? null,
    error: progress.error ? { code: progress.error.code, message: progress.error.message } : null,
    retry: retryAvailability(status, "normalize"),
    diff: diffAvailability(versionContext),
    cancel: cancelAvailability(),
  };
}

function summarizeButtonRun(run: typeof agentButtonRun.$inferSelect): AgentRunSummary {
  const artifact = readArtifact<{
    beforeVersion?: number;
    afterVersion?: number;
    inputSnapshot?: unknown;
    outputSnapshot?: unknown;
    title?: string;
  }>(run.taskId, buttonRunArtifactName(run.id));
  const inputSnapshot = safeJsonParse(run.inputSnapshotJson) ?? artifact?.inputSnapshot;
  const outputSnapshot = safeJsonParse(run.outputSnapshotJson) ?? artifact?.outputSnapshot;
  const beforeVersion = typeof artifact?.beforeVersion === "number" ? artifact.beforeVersion : undefined;
  const afterVersion = typeof artifact?.afterVersion === "number" ? artifact.afterVersion : undefined;
  const status = buttonRunStatusToStatus(run.status);
  return {
    runId: run.id,
    taskId: run.taskId,
    kind: "button",
    buttonKey: run.buttonKey,
    title: artifact?.title ?? run.buttonKey,
    status,
    runner: run.runner === "opencode" ? "opencode" : "fallback",
    targetLineIds: [run.targetLineId].filter(Boolean),
    beforeVersion,
    afterVersion,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    error: run.errorMessage ? { code: run.errorCode, message: run.errorMessage } : null,
    retry: retryAvailability(status, "button"),
    diff: diffAvailability({ inputSnapshot, outputSnapshot, beforeVersion, afterVersion }),
    cancel: cancelAvailability(),
  };
}

function parseAgentRun(taskId: string, runId: string): { kind: "normalize"; summary: AgentRunSummary; progress: NormalizeRunProgress; paths: RunPaths } | { kind: "button"; summary: AgentRunSummary; run: typeof agentButtonRun.$inferSelect; artifact: Record<string, unknown> | null } | null {
  try {
    const paths = getNormalizeRunPaths(taskId, runId);
    const progress = readRunProgress(paths.progressPath);
    if (progress) return { kind: "normalize", summary: summarizeNormalizeRun(taskId, runId, paths, progress), progress, paths };
  } catch {
    // Not a normalize run or invalid artifact; continue with button table lookup.
  }

  const db = getDb();
  const run = db.select().from(agentButtonRun).where(and(eq(agentButtonRun.taskId, taskId), eq(agentButtonRun.id, runId))).get();
  if (!run) return null;
  return {
    kind: "button",
    summary: summarizeButtonRun(run),
    run,
    artifact: readArtifact<Record<string, unknown>>(taskId, buttonRunArtifactName(run.id)),
  };
}

function isTerminalNormalizeStage(stage: NormalizeRunStage): boolean {
  return TERMINAL_NORMALIZE_STAGES.has(stage);
}

function summarizeZodIssues(error: z.ZodError): Array<{ path: string; code: string; message: string }> {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "body",
    code: issue.code,
    message: issue.message,
  }));
}

function getDraftProgressState(draftPath: string): NormalizeRunProgress["draft"] {
  if (!fs.existsSync(draftPath)) {
    return { exists: false, parseable: false, sizeBytes: 0 };
  }
  const stat = fs.statSync(draftPath);
  let parseable = false;
  try {
    const raw = fs.readFileSync(draftPath, "utf-8").trim();
    parseable = raw.length > 0 && typeof JSON.parse(raw) === "object";
  } catch {
    parseable = false;
  }
  return {
    exists: true,
    parseable,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function buildProgress(options: {
  taskId: string;
  runId: string;
  stage: NormalizeRunStage;
  startedAt: string;
  timeoutMs: number;
  timeoutBasis: Record<string, unknown>;
  candidateLineCount?: number;
  candidateQualitySummary?: unknown;
  draftPath: string;
  quality?: NormalizeRunProgress["quality"];
  runner?: NormalizeRunProgress["runner"];
  result?: NormalizeRunProgress["result"];
  error?: NormalizeRunProgress["error"];
  message: string;
}): NormalizeRunProgress {
  const now = new Date();
  return {
    ok: true,
    runId: options.runId,
    taskId: options.taskId,
    stage: options.stage,
    startedAt: options.startedAt,
    updatedAt: now.toISOString(),
    ...(options.stage === "completed" || options.stage === "failed" ? { completedAt: now.toISOString() } : {}),
    elapsedMs: Math.max(0, now.getTime() - Date.parse(options.startedAt)),
    timeoutMs: options.timeoutMs,
    timeoutBasis: options.timeoutBasis,
    candidateLineCount: options.candidateLineCount ?? 0,
    ...(options.candidateQualitySummary ? { candidateQualitySummary: options.candidateQualitySummary } : {}),
    draft: getDraftProgressState(options.draftPath),
    quality: options.quality ?? { checked: false },
    runner: options.runner ?? { status: "not_started" },
    ...(options.result ? { result: options.result } : {}),
    ...(options.error ? { error: options.error } : {}),
    message: options.message,
  };
}

function mergeRunProgress(
  paths: Pick<RunPaths, "progressPath" | "draftPath">,
  patch: Partial<NormalizeRunProgress> & Pick<NormalizeRunProgress, "stage" | "message">,
): void {
  const previous = readRunProgress(paths.progressPath);
  if (!previous) return;
  writeRunProgress(paths.progressPath, {
    ...previous,
    ...patch,
    draft: patch.draft ?? getDraftProgressState(paths.draftPath),
    quality: patch.quality ?? previous.quality,
    runner: patch.runner ?? previous.runner,
    elapsedMs: Math.max(0, Date.now() - Date.parse(previous.startedAt)),
    updatedAt: new Date().toISOString(),
    ...(patch.stage === "completed" || patch.stage === "failed" ? { completedAt: new Date().toISOString() } : {}),
  });
}

function qualityProgressSummary(report: BusinessQualityReport): NormalizeRunProgress["quality"] {
  return {
    checked: true,
    passed: report.passed,
    issueCount: report.issueCount,
    blockingIssueCount: report.blockingIssueCount,
    warningIssueCount: report.warningIssueCount,
    issuesPreview: report.issues.slice(0, 10).map((issue) => ({
      ...issue,
      transcriptSample: issue.transcriptSample?.slice(0, 160),
    })),
  };
}

function refreshOrTerminalizeProgress(
  taskId: string,
  paths: Pick<RunPaths, "progressPath" | "draftPath">,
  progress: NormalizeRunProgress,
): NormalizeRunProgress {
  if (isTerminalNormalizeStage(progress.stage)) {
    return {
      ...progress,
      elapsedMs: Math.max(0, Date.now() - Date.parse(progress.startedAt)),
      draft: getDraftProgressState(paths.draftPath),
    };
  }

  const nowMs = Date.now();
  const elapsedMs = Math.max(0, nowMs - Date.parse(progress.startedAt));
  const activeRun = activeNormalizeRuns.get(taskId);
  const isActiveInThisProcess = activeRun?.runId === progress.runId;

  const updatedAtMs = Date.parse(progress.updatedAt);
  const updatedAgeMs = Number.isFinite(updatedAtMs) ? nowMs - updatedAtMs : Number.POSITIVE_INFINITY;
  const appearsStaleAfterRestart = progress.stage !== "timeout_recovery" && !isActiveInThisProcess && updatedAgeMs > NORMALIZE_PROGRESS_STALE_GRACE_MS;

  return {
    ...progress,
    elapsedMs,
    draft: getDraftProgressState(paths.draftPath),
    runner: progress.runner.status === "not_started" ? { status: "running" } : progress.runner,
    message: appearsStaleAfterRestart
      ? "Normalize 仍处于非终态；未确认 OpenCode 已停止，继续等待进度恢复或最终 artifact。"
      : progress.message,
  };
}

function normalizeRunHasTimeoutFailure(progress: NormalizeRunProgress): boolean {
  const code = progress.error?.code ?? "";
  const message = `${progress.error?.message ?? ""} ${progress.message ?? ""}`;
  return code.includes("TIMEOUT") || /timed out|timeout/i.test(message);
}

function shouldAttemptLateDraftRecovery(taskId: string, paths: RunPaths, progress: NormalizeRunProgress): boolean {
  const draftState = getDraftProgressState(paths.draftPath);
  if (!draftState.exists || !draftState.parseable) return false;
  if (progress.stage === "completed") return false;
  if (progress.stage === "timeout_recovery") return true;
  if (progress.stage === "failed") return normalizeRunHasTimeoutFailure(progress);

  const activeRun = activeNormalizeRuns.get(taskId);
  const isActiveInThisProcess = activeRun?.runId === progress.runId;
  const updatedAtMs = Date.parse(progress.updatedAt);
  const updatedAgeMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
  return !isActiveInThisProcess && updatedAgeMs > NORMALIZE_PROGRESS_STALE_GRACE_MS;
}

function timeoutRecoveryDeadlineMs(progress: NormalizeRunProgress): number | null {
  const explicitDeadline = progress.timeoutBasis?.lateDraftRecoveryDeadlineAt;
  if (typeof explicitDeadline === "string") {
    const ms = Date.parse(explicitDeadline);
    if (Number.isFinite(ms)) return ms;
  }

  if (progress.stage !== "timeout_recovery") return null;
  const startedAtMs = Date.parse(progress.startedAt);
  if (!Number.isFinite(startedAtMs)) return Date.now();
  const windowMs = typeof progress.timeoutBasis?.lateDraftRecoveryWindowMs === "number"
    ? Math.max(0, progress.timeoutBasis.lateDraftRecoveryWindowMs)
    : getTimeoutDraftRecoveryWindowMs();
  return startedAtMs + Math.max(0, progress.timeoutMs) + windowMs;
}

function shouldFinalizeExpiredTimeoutRecovery(paths: RunPaths, progress: NormalizeRunProgress): boolean {
  if (progress.stage !== "timeout_recovery") return false;
  const draftState = getDraftProgressState(paths.draftPath);
  if (draftState.exists && draftState.parseable) return false;
  const deadlineMs = timeoutRecoveryDeadlineMs(progress);
  return deadlineMs !== null && Date.now() >= deadlineMs;
}

function finalizeExpiredTimeoutRecovery(options: {
  taskId: string;
  runId: string;
  paths: RunPaths;
  progress: NormalizeRunProgress;
}): NormalizeRunProgress {
  const { taskId, runId, paths, progress } = options;
  const message = "OpenCode Agent normalize timed out, and no recoverable draft appeared before the recovery window expired. No version created.";
  writeCommitResult(paths.commitResultPath, {
    committed: false,
    error: `OPENCODE_NORMALIZE_TIMEOUT: ${message}`,
    runId,
    taskId,
    committedAt: new Date().toISOString(),
  });
  mergeRunProgress(paths, {
    stage: "failed",
    message,
    runner: { status: "timeout" },
    error: {
      code: "OPENCODE_NORMALIZE_TIMEOUT",
      message,
      httpStatus: 504,
      recoverability: "retryable",
    },
  });
  return readRunProgress(paths.progressPath) ?? progress;
}

function recoverOrExpireTimeoutProgress(options: {
  c: any;
  db: ReturnType<typeof getDb>;
  requestId: string;
  taskId: string;
  runId: string;
  paths: RunPaths;
  progress: NormalizeRunProgress;
  reason: string;
}): NormalizeRunProgress {
  const { c, db, requestId, taskId, runId, paths, progress, reason } = options;
  if (shouldAttemptLateDraftRecovery(taskId, paths, progress)) {
    return attemptLateDraftRecoveryFromArtifacts({ c, db, requestId, taskId, runId, paths, progress, reason });
  }
  if (shouldFinalizeExpiredTimeoutRecovery(paths, progress)) {
    return finalizeExpiredTimeoutRecovery({ taskId, runId, paths, progress });
  }
  return progress;
}

function attemptLateDraftRecoveryFromArtifacts(options: {
  c: any;
  db: ReturnType<typeof getDb>;
  requestId: string;
  taskId: string;
  runId: string;
  paths: RunPaths;
  progress: NormalizeRunProgress;
  reason: string;
}): NormalizeRunProgress {
  const { c, db, requestId, taskId, runId, paths, progress, reason } = options;
  const bundle = readJsonFile<Record<string, unknown>>(paths.requestPath);
  const currentState = bundle && typeof bundle.currentState === "object" && bundle.currentState !== null
    ? bundle.currentState as Record<string, unknown>
    : {};
  const currentVersionAtStart = typeof currentState.expectedVersion === "number" ? currentState.expectedVersion : 0;
  const normalizeStartTime = Number.isFinite(Date.parse(progress.startedAt)) ? Date.parse(progress.startedAt) : Date.now() - progress.elapsedMs;

  finalizeBundleNormalizeDraft({
    c,
    db,
    requestId,
    taskId,
    runId,
    paths,
    draft: readNormalizeDraft(paths.draftPath),
    productionMetadata: {
      method: "opencode-bundle-run",
      durationMs: Math.max(0, Date.now() - normalizeStartTime),
      stdoutSummary: "(Recovered from late draft during normalize progress polling)",
      timeoutBasis: progress.timeoutBasis,
    },
    warnings: [],
    currentVersionAtStart,
    configuredTimeoutMs: progress.timeoutMs,
    normalizeStartTime,
    candidateLineCount: progress.candidateLineCount,
    voiceMetadataCount: typeof progress.candidateQualitySummary === "object" && progress.candidateQualitySummary !== null && typeof (progress.candidateQualitySummary as Record<string, unknown>).voiceMetadataCount === "number"
      ? (progress.candidateQualitySummary as Record<string, unknown>).voiceMetadataCount as number
      : 0,
    progressPaths: paths,
    recovery: {
      code: "OPENCODE_LATE_DRAFT_RECOVERY",
      message: "OpenCode timed out or lost process ownership after writing a parseable draft; server recovered and committed it from progress polling.",
      reason,
    },
  });

  return readRunProgress(paths.progressPath) ?? progress;
}

function findActiveNormalizeRun(taskId: string): { runId: string; progressUrl: string } | null {
  const activeRun = activeNormalizeRuns.get(taskId);
  if (activeRun) {
    try {
      const paths = getNormalizeRunPaths(taskId, activeRun.runId);
      const progress = readRunProgress(paths.progressPath);
      if (!progress) {
        activeNormalizeRuns.delete(taskId);
      } else {
        let refreshed = refreshOrTerminalizeProgress(taskId, paths, progress);
        refreshed = recoverOrExpireTimeoutProgress({
          c: responseContext(),
          db: getDb(),
          requestId: uuidv4(),
          taskId,
          runId: activeRun.runId,
          paths,
          progress: refreshed,
          reason: "active run lookup detected a parseable late draft",
        });
        if (isTerminalNormalizeStage(refreshed.stage)) {
          activeNormalizeRuns.delete(taskId);
        } else {
          return activeRun;
        }
      }
    } catch {
      activeNormalizeRuns.delete(taskId);
    }
  }

  for (const run of listNormalizeRunProgress(taskId)) {
    let refreshed = refreshOrTerminalizeProgress(taskId, run.paths, run.progress);
    refreshed = recoverOrExpireTimeoutProgress({
      c: responseContext(),
      db: getDb(),
      requestId: uuidv4(),
      taskId,
      runId: run.runId,
      paths: run.paths,
      progress: refreshed,
      reason: "run list detected a parseable late draft",
    });
    if (!isTerminalNormalizeStage(refreshed.stage)) {
      const recovered = { runId: run.runId, progressUrl: progressUrlFor(taskId, run.runId) };
      activeNormalizeRuns.set(taskId, recovered);
      return recovered;
    }
  }

  return null;
}

function releaseActiveNormalizeRun(taskId: string, runId: string): void {
  if (activeNormalizeRuns.get(taskId)?.runId === runId) {
    activeNormalizeRuns.delete(taskId);
  }
}

function finalizeBundleNormalizeDraft(options: {
  c: any;
  db: ReturnType<typeof getDb>;
  requestId: string;
  taskId: string;
  runId: string;
  paths: { draftPath: string; validationReportPath: string; commitResultPath: string; runDir: string };
  draft: NormalizeDraft | null;
  productionMetadata: Record<string, unknown>;
  warnings: Array<{ code: string; message: string }>;
  currentVersionAtStart: number;
  configuredTimeoutMs: number;
  normalizeStartTime: number;
  candidateLineCount: number;
  voiceMetadataCount?: number;
  progressPaths?: Pick<RunPaths, "progressPath" | "draftPath">;
  recovery?: { code: string; message: string; reason: string };
}) {
  const {
    c,
    db,
    requestId,
    taskId,
    runId,
    paths,
    draft,
    productionMetadata,
    warnings,
    currentVersionAtStart,
    configuredTimeoutMs,
    normalizeStartTime,
    candidateLineCount,
    voiceMetadataCount = 0,
    progressPaths,
    recovery,
  } = options;

  const responseWarnings = recovery
    ? [...warnings, { code: recovery.code, message: recovery.message }]
    : warnings;

  // ── R-M1-C/R-M1-D: Distinguish Agent failure vs. schema-invalid draft ──
  // readNormalizeDraft returns null only for missing/unparseable JSON. Any
  // parseable JSON must go through the strict raw v2 validation gate below.
  if (draft === null) {
    const elapsedMs = Date.now() - normalizeStartTime;
    const draftExists = fs.existsSync(paths.draftPath);
    const draftSize = draftExists ? fs.statSync(paths.draftPath).size : 0;
    const draftReason = draftExists
      ? (draftSize === 0 ? "draft_empty" : "draft_unreadable_or_invalid_json")
      : "draft_missing";
    const status = draftExists ? 422 : 502;
    const errorCode = draftExists ? "NORMALIZE_DRAFT_UNREADABLE" : "NORMALIZE_DRAFT_MISSING";
    const errorMessage = draftExists
      ? "OpenCode Agent did not produce a parseable Prompt-Structured Production List v2 draft. No version created."
      : "OpenCode Agent completed without writing a production-list draft. No version created.";

    writeValidationReport(paths.validationReportPath, {
      valid: false,
      issues: [{ severity: "error", code: errorCode, message: errorMessage }],
      stats: { totalLines: 0, speakers: [], maxOrder: -1 },
      source: "agent-draft",
    });

    writeCommitResult(paths.commitResultPath, {
      committed: false,
      error: `${errorCode}: ${draftReason}. No normalization applied.`,
      runId,
      taskId,
      committedAt: new Date().toISOString(),
    });

    if (progressPaths) {
      mergeRunProgress(progressPaths, {
        stage: "failed",
        message: errorMessage,
        runner: { status: "failed" },
        error: {
          code: errorCode,
          message: errorMessage,
          httpStatus: status,
          recoverability: "retryable",
        },
      });
    }

    return c.json({
      ok: false,
      requestId,
      attemptedRunner: "opencode",
      runId,
      error: {
        code: errorCode,
        message: errorMessage,
        category: "validation",
        retryable: true,
        metadata: {
          runId,
          reason: draftReason,
          draftPath: paths.draftPath,
          currentVersion: currentVersionAtStart,
        },
      },
      warnings: responseWarnings,
      runnerStatus: {
        status: "failed",
        reasonCode: "opencode_parse_failed",
        elapsedMs,
        timeoutMs: configuredTimeoutMs,
        fallbackUsed: false,
      } satisfies RunnerStatus,
    }, status);
  }

  const rawDraftForValidation = {
    schemaVersion: draft.schemaVersion,
    promptProfiles: draft.promptProfiles,
    directorProfiles: draft.directorProfiles,
    lines: draft.lines,
    speakers: draft.speakers || [],
    metadata: draft.metadata,
  };
  const rawValidationReport = validateRawPromptStructuredAgentDraft(rawDraftForValidation);

  writeValidationReport(paths.validationReportPath, {
    ...rawValidationReport,
    source: "agent-draft-raw",
  });

  const elapsedMs = Date.now() - normalizeStartTime;

  if (!rawValidationReport.valid) {
    const errorCount = rawValidationReport.issues.filter((i) => i.severity === "error").length;
    writeCommitResult(paths.commitResultPath, {
      committed: false,
      error: `Raw Agent draft validation failed: ${errorCount} error(s). No normalization applied.`,
      runId,
      taskId,
      committedAt: new Date().toISOString(),
    });

    if (progressPaths) {
      mergeRunProgress(progressPaths, {
        stage: "failed",
        message: "Agent draft is not a valid Prompt-Structured Production List v2. No version created.",
        runner: { status: "completed" },
        quality: { checked: false },
        error: {
          code: "RAW_DRAFT_VALIDATION_FAILED",
          message: "Agent draft is not a valid Prompt-Structured Production List v2. No version created.",
          httpStatus: 422,
          recoverability: "not_retryable",
        },
      });
    }

    return c.json({
      ok: false,
      requestId,
      attemptedRunner: "opencode",
      runId,
      error: {
        code: "RAW_DRAFT_VALIDATION_FAILED",
        message: "Agent draft is not a valid Prompt-Structured Production List v2. No version created.",
        category: "validation",
        retryable: false,
        metadata: {
          runId,
          recoveryCode: recovery?.code,
          validationReport: {
            valid: false,
            issueCount: rawValidationReport.issues.length,
            errorCount,
            warningCount: rawValidationReport.issues.filter((i) => i.severity === "warning").length,
            issues: rawValidationReport.issues.slice(0, 20),
          },
        },
      },
      warnings: responseWarnings,
      runnerStatus: {
        status: "failed",
        reasonCode: "opencode_parse_failed",
        elapsedMs,
        timeoutMs: configuredTimeoutMs,
        fallbackUsed: false,
      } satisfies RunnerStatus,
    }, 422);
  }

  const parsedPromptDraft = RawPromptStructuredAgentDraftSchema.parse(rawDraftForValidation);
  if (progressPaths) {
    mergeRunProgress(progressPaths, {
      stage: "validating",
      message: "正在校验 v2 schema 和内容质量",
      runner: { status: "completed" },
      draft: getDraftProgressState(paths.draftPath),
    });
  }

  const businessQuality = validateBusinessQualityGate({
    draft: parsedPromptDraft,
    candidateLineCount,
    voiceMetadataCount,
  });

  writeValidationReport(paths.validationReportPath, {
    ...rawValidationReport,
    issues: [
      ...rawValidationReport.issues,
      ...businessQuality.issues.map((issue) => ({
        severity: issue.severity === "blocking" ? "error" as const : "warning" as const,
        code: issue.code,
        message: issue.message,
        field: issue.lineIndex !== undefined ? `lines[${issue.lineIndex}].transcript` : undefined,
        lineId: issue.lineId,
      })),
    ],
    source: "agent-draft-raw",
    businessQuality,
  });

  if (progressPaths) {
    mergeRunProgress(progressPaths, {
      stage: "validating",
      message: businessQuality.passed ? "内容质量闸门通过" : "内容质量闸门发现阻断问题",
      quality: qualityProgressSummary(businessQuality),
      runner: { status: "completed" },
    });
  }

  if (!businessQuality.passed) {
    const errorMessage = "生产列表草稿质量门失败：Agent 生成的生产列表草稿已通过 schema 校验，但未通过业务质量检查；未创建新的生产列表版本，也未触发 TTS 音频生成。";
    writeCommitResult(paths.commitResultPath, {
      committed: false,
      error: `PRODUCTION_LIST_QUALITY_GATE_FAILED: ${businessQuality.blockingIssueCount} blocking issue(s). 未创建新的生产列表版本，未触发 TTS 音频生成。`,
      runId,
      taskId,
      committedAt: new Date().toISOString(),
    });

    if (progressPaths) {
      mergeRunProgress(progressPaths, {
        stage: "failed",
        message: errorMessage,
        quality: qualityProgressSummary(businessQuality),
        runner: { status: "completed" },
        error: {
          code: "PRODUCTION_LIST_QUALITY_GATE_FAILED",
          message: errorMessage,
          httpStatus: 422,
          recoverability: "user_action_required",
        },
      });
    }

    return c.json({
      ok: false,
      requestId,
      attemptedRunner: "opencode",
      runId,
      error: {
        code: "PRODUCTION_LIST_QUALITY_GATE_FAILED",
        message: errorMessage,
        category: "validation",
        retryable: false,
        metadata: {
          runId,
          qualityReport: businessQuality,
          currentVersion: currentVersionAtStart,
        },
      },
      warnings: responseWarnings,
      qualityReport: businessQuality,
      runnerStatus: {
        status: "failed",
        reasonCode: "opencode_parse_failed",
        elapsedMs,
        timeoutMs: configuredTimeoutMs,
        fallbackUsed: false,
      } satisfies RunnerStatus,
    }, 422);
  }

  const promptProfiles = parsedPromptDraft.promptProfiles.map(normalizePromptProfile);
  const profileById = new Map(promptProfiles.map((profile) => [profile.id, profile]));

  const speakersById = new Map<string, PromptSpeaker>();
  for (const profile of promptProfiles) {
    for (const speaker of profile.speakers) {
      if (!speakersById.has(speaker.id)) speakersById.set(speaker.id, speaker);
    }
  }
  const normalizedSpeakers = Array.from(speakersById.values()).map((speaker) => ({
    id: speaker.id,
    label: speaker.label,
    name: speaker.name,
    voice: speaker.voice,
    style: speaker.style ?? "",
  }));

  const lines: Array<Record<string, unknown>> = [];
  for (const rawLine of parsedPromptDraft.lines) {
    const profile = profileById.get(rawLine.promptProfileId);
    const promptSpeaker = profile?.speakers.find((speaker) => speaker.id === rawLine.speaker);
    const promptOverride = rawLine.promptOverride ?? null;
    const rawLineStyle = typeof rawLine.style === "string" ? rawLine.style.trim() : "";
    lines.push({
      id: rawLine.id,
      order: rawLine.order,
      moduleName: rawLine.moduleName ?? null,
      title: rawLine.title ?? null,
      speaker: rawLine.speaker,
      speakerLabel: normalizeSpeakerLabel(rawLine.speakerLabel ?? promptSpeaker?.label ?? rawLine.speaker),
      transcript: rawLine.transcript,
      text: rawLine.transcript,
      voice: rawLine.voice || promptSpeaker?.voice || "Zephyr",
      style: rawLineStyle && profile && needsChineseDirectorRewrite(rawLineStyle)
        ? chineseDirectorFallback(profile, "style")
        : rawLineStyle,
      notes: typeof rawLine.notes === "string" ? rawLine.notes : "",
      status: "pending",
      model: rawLine.model ?? "google/gemini-3.1-flash-tts-preview",
      responseFormat: rawLine.responseFormat ?? "wav",
      promptProfileId: rawLine.promptProfileId,
      directorProfileId: rawLine.promptProfileId,
      promptOverride,
      directorOverrideJson: promptOverride ? JSON.stringify(promptOverride) : null,
      generationStatus: rawLine.generationStatus ?? "draft",
    });
  }

  lines.sort((a, b) => (a.order as number) - (b.order as number));
  for (let i = 0; i < lines.length; i++) {
    lines[i].order = i;
  }

  const productionList = {
    schemaVersion: "tts.production-list.v2",
    lines,
    speakers: normalizedSpeakers,
    promptProfiles,
    directorProfiles: promptProfiles,
    metadata: {
      ...productionMetadata,
      ...(parsedPromptDraft.metadata ?? {}),
      schemaVersion: "tts.production-list.v2",
      ...(recovery ? {
        recoveryCode: recovery.code,
        opencodeProcessTimeoutAfterDraft: true,
        timeoutReason: recovery.reason.slice(0, 500),
      } : {}),
    },
  };

  let committedVersionNum: number;
  let versionId: string;
  let now: Date;
  try {
    if (progressPaths) {
      mergeRunProgress(progressPaths, {
        stage: "committing",
        message: "质量通过，正在写入生产列表",
        quality: qualityProgressSummary(businessQuality),
        runner: { status: "completed" },
      });
    }
    const commitResult = atomicCommitProductionList(
      db,
      taskId,
      currentVersionAtStart,
      lines,
      normalizedSpeakers as Array<Record<string, unknown>>,
      { ...productionList.metadata, runId, bundleMethod: "path-schema-instruction" },
      "opencode",
      promptProfiles,
    );
    committedVersionNum = commitResult.newVersion;
    versionId = commitResult.versionId;
    now = commitResult.now;
  } catch (txErr) {
    writeCommitResult(paths.commitResultPath, {
      committed: false,
      error: `Version conflict during atomic commit: ${txErr instanceof Error ? txErr.message : String(txErr)}`,
      runId,
      taskId,
      committedAt: new Date().toISOString(),
    });

    if (progressPaths) {
      mergeRunProgress(progressPaths, {
        stage: "failed",
        message: "生产列表写入时发生版本冲突",
        quality: qualityProgressSummary(businessQuality),
        runner: { status: "completed" },
        error: {
          code: "VERSION_CONFLICT",
          message: txErr instanceof Error ? txErr.message : String(txErr),
          httpStatus: 409,
          recoverability: "retryable",
        },
      });
    }

    return handleAtomicCommitConflict(txErr, currentVersionAtStart, taskId, requestId, c, runId);
  }

  writeArtifact(taskId, productionListArtifactName(), {
    schemaVersion: "tts.production-list.v2",
    version: committedVersionNum,
    versionId,
    lines,
    speakers: normalizedSpeakers,
    promptProfiles,
    directorProfiles: promptProfiles,
    directorProfileId: null,
    metadata: { ...productionList.metadata, runner: "opencode", schemaVersion: "tts.production-list.v2" },
    updatedAt: now.toISOString(),
  });

  writeCommitResult(paths.commitResultPath, {
    committed: true,
    newVersion: committedVersionNum,
    lineCount: lines.length,
    speakerCount: normalizedSpeakers.length,
    warnings: [
      ...rawValidationReport.issues
        .filter((i) => i.severity === "warning")
        .map((i) => i.message),
      ...responseWarnings.map((warning) => `${warning.code}: ${warning.message}`),
      ...businessQuality.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => `${issue.code}: ${issue.message}`),
    ],
    runId,
    taskId,
    committedAt: now.toISOString(),
  });

  auditLog("production_list", versionId, "normalize_requirements_bundle", "opencode",
    { taskId, runId, lineCount: lines.length, bundleMethod: "path-schema-instruction", recoveryCode: recovery?.code }, requestId);

  if (progressPaths) {
    mergeRunProgress(progressPaths, {
      stage: "completed",
      message: "Normalize 完成，生产列表已更新",
      quality: qualityProgressSummary(businessQuality),
      runner: { status: "completed" },
      result: { versionId, lineCount: lines.length },
      error: undefined,
    });
  }

  return c.json({
    ok: true,
    requestId,
    runner: "opencode",
    attemptedRunner: "opencode",
    runId,
    productionList: {
      schemaVersion: "tts.production-list.v2",
      taskId,
      version: committedVersionNum,
      lines,
      speakers: normalizedSpeakers,
      promptProfiles,
      directorProfiles: promptProfiles,
      metadata: productionList.metadata,
    },
    warnings: responseWarnings,
    runnerStatus: {
      status: "succeeded",
      reasonCode: "opencode_success",
      elapsedMs,
      timeoutMs: configuredTimeoutMs,
      fallbackUsed: false,
    },
    validationReport: {
      valid: rawValidationReport.valid,
      issueCount: rawValidationReport.issues.length + businessQuality.issueCount,
      errorCount: rawValidationReport.issues.filter((i) => i.severity === "error").length,
      warningCount: rawValidationReport.issues.filter((i) => i.severity === "warning").length + businessQuality.warningIssueCount,
    },
    qualityReport: businessQuality,
    bundleMeta: {
      method: "path-schema-instruction",
      runDir: paths.runDir,
      recoveryCode: recovery?.code,
    },
  });
}

app.post("/api/tasks/:taskId/agent/normalize-requirements", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  // M5: Parse optional request body for instruction, document selection, and expected version.
  // Empty body remains the compatibility default; malformed JSON or schema-invalid
  // body returns 400 with a safe issue summary instead of silently changing mode.
  let requestBody: z.infer<typeof NormalizeRequestBodySchema> = {};
  try {
    const rawText = await c.req.text();
    if (rawText.trim().length > 0) {
      let rawBody: unknown;
      try {
        rawBody = JSON.parse(rawText);
      } catch {
        return apiError(c, requestId, 400, "INVALID_REQUEST", "Request body must be valid JSON.", "validation", false, {
          issues: [{ path: "body", code: "invalid_json", message: "Request body must be valid JSON." }],
        });
      }
      const parsed = NormalizeRequestBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return apiError(c, requestId, 400, "INVALID_REQUEST", "Normalize request body is invalid.", "validation", false, {
          issues: summarizeZodIssues(parsed.error),
        });
      }
      requestBody = parsed.data;
    }
  } catch {
    requestBody = {};
  }

  // Load enabled documents
  const docs = db.select().from(requirementDocument)
    .where(eq(requirementDocument.taskId, taskId))
    .all();

  let enabledDocs = docs.filter((d) => d.enabled);

  // M5: If documentIds specified in request, filter to only those
  if (requestBody.documentIds && requestBody.documentIds.length > 0) {
    const requestedIds = new Set(requestBody.documentIds);
    enabledDocs = enabledDocs.filter((d) => requestedIds.has(d.id));
  }

  if (enabledDocs.length === 0) {
    return apiError(c, requestId, 400, "NO_ENABLED_DOCS", "No enabled documents to normalize.", "validation");
  }

  // Load document contents from artifacts
  const docInputs: Array<{ id: string; fileName: string; content: string; enabled: boolean }> = [];
  for (const doc of enabledDocs) {
    const artifact = readArtifact<{ fileName: string; content: string }>(taskId, `document-${doc.id}.json`);
    if (artifact) {
      docInputs.push({
        id: doc.id,
        fileName: doc.fileName,
        content: artifact.content,
        enabled: true,
      });
    }
  }

  if (docInputs.length === 0) {
    return apiError(c, requestId, 400, "NO_DOCUMENT_CONTENT", "Enabled documents have no content.", "validation");
  }

  // Check availability and decide main path vs fallback
  const availability = await checkOpenCodeAvailability();
  const normalizeStartTime = Date.now();

  // Compute input scale once; bundle timeout is finalized after current list
  // metadata is available because output complexity can dominate input size.
  const docCount = docInputs.length;
  const charCount = docInputs.reduce((sum, d) => sum + d.content.length, 0);
  const estimatedLineCount = estimateNormalizeOutputLineCount(docInputs);

  // Get current production list version
  // M2: expectedVersion is the CURRENT version, not the next one.
  // The new version number will be currentVersionAtStart + 1, computed at commit time
  // after re-verifying no concurrent writes occurred.
  const currentVersion = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .limit(1)
    .get();

  const currentVersionAtStart = currentVersion?.version ?? 0;

  // M2: If client provides expectedVersion, verify it matches current (fail-fast)
  if (requestBody.expectedVersion !== undefined && requestBody.expectedVersion !== currentVersionAtStart) {
    return c.json({
      ok: false,
      requestId,
      error: {
        code: "VERSION_CONFLICT",
        message: `Expected version ${requestBody.expectedVersion} but current is ${currentVersionAtStart}.`,
        category: "conflict",
        retryable: true,
        metadata: {
          expectedVersion: requestBody.expectedVersion,
          currentVersion: currentVersionAtStart,
        },
      },
    }, 409);
  }

  const currentListSummary = {
    lineCount: currentVersion?.lineCount ?? 0,
    speakers: (() => {
      try {
        const raw = currentVersion?.speakersJson;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.map((s: Record<string, unknown>) => String(s.label ?? s.id ?? "unknown"));
        }
      } catch { /* ignore */ }
      return [];
    })(),
  };
  const responseMode = requestBody.async === true || requestBody.responseMode === "async" ? "async" : "sync";
  const qualityPriority = requestBody.qualityPriority ?? true;
  const configuredTimeoutMs = computeBundleNormalizeTimeout({
    docCount,
    charCount,
    currentLineCount: currentListSummary.lineCount,
    estimatedLineCount,
    qualityPriority,
  });
  const timeoutBasis = {
    calculator: "computeBundleNormalizeTimeout.v2",
    mode: qualityPriority ? "quality-priority" : "standard",
    docCount,
    charCount,
    currentLineCount: currentListSummary.lineCount,
    estimatedLineCount,
    maxTimeoutMs: configuredTimeoutMs,
    selectedTimeoutMs: configuredTimeoutMs,
    timeoutMs: configuredTimeoutMs,
  };

  // ── Main path: bundle-driven Agent Normalize ──
  if (availability.available) {
    const existingActiveRun = findActiveNormalizeRun(taskId);
    if (existingActiveRun) {
      return c.json({
        ok: false,
        requestId,
        error: {
          code: "NORMALIZE_RUN_ALREADY_RUNNING",
          message: "A normalize run is already active for this task.",
          category: "conflict",
          retryable: true,
          metadata: {
            existingRunId: existingActiveRun.runId,
            progressUrl: existingActiveRun.progressUrl,
          },
        },
        existingRunId: existingActiveRun.runId,
        progressUrl: existingActiveRun.progressUrl,
      }, 409);
    }

    // Step 1: Create run directory and paths
    const { runId, paths } = createNormalizeRun(taskId);
    const startedAt = new Date(normalizeStartTime).toISOString();
    const progressPaths = { progressPath: paths.progressPath, draftPath: paths.draftPath };
    activeNormalizeRuns.set(taskId, { runId, progressUrl: progressUrlFor(taskId, runId) });
    writeRunProgress(paths.progressPath, buildProgress({
      taskId,
      runId,
      stage: "queued",
      startedAt,
      timeoutMs: configuredTimeoutMs,
      timeoutBasis,
      draftPath: paths.draftPath,
      runner: { status: "not_started" },
      message: "已创建 Normalize 任务",
    }));
    const activeContext = responseContext();
    let candidateLineCountForRun = 0;
    let voiceMetadataCountForRun = 0;

    const executeNormalize = async () => {
    try {
      mergeRunProgress(progressPaths, {
        stage: "preprocessing",
        message: "正在预处理文档和候选台词",
        runner: { status: "not_started" },
      });
      // Step 2: Export schema snapshot
      const schemaSnapshot = generateProductionListSchemaSnapshot();
      writeSchemaSnapshot(paths.schemaPath, schemaSnapshot);

      // Step 3: Build input document references with safe paths
      const inputDocRefs: InputDocumentRef[] = enabledDocs.map((doc) => ({
        documentId: doc.id,
        fileName: doc.fileName,
        source: (doc.source as "upload" | "paste" | "agent") || "paste",
        path: getDocumentArtifactPath(taskId, doc.id),
        contentPathType: "json-wrapper" as const,
        sha256: doc.contentSha256 || "",
        enabled: true,
        version: doc.version,
      }));

      // Step 4: Build instruction context
      // M5: Use user instruction from request body instead of hardcoded empty string
      const instructionContext: InstructionContext = {
        userInstruction: requestBody.instruction || "",
        taskTitle: task.title,
        taskDescription: task.description || "",
        targetDatasetType: "prompt-structured-production-list",
        language: "zh-CN",
        businessRules: schemaSnapshot.businessRules,
      };

      // Step 5: Preprocess deterministic candidate lines as compact OpenCode input.
      // These candidates are context only. They are never committed unless
      // OpenCode authors a schema-valid Prompt-Structured v2 draft from them.
      const candidateExtraction = extractCandidateLines({ documents: docInputs });
      candidateLineCountForRun = candidateExtraction.candidateLines.length;
      voiceMetadataCountForRun = candidateExtraction.voiceMetadata.length;
      const candidateLinesRef = writeCandidateLinesArtifact(paths.candidateLinesPath, candidateExtraction.candidateLines, candidateExtraction.voiceMetadata);
      mergeRunProgress(progressPaths, {
        stage: "preprocessing",
        message: "候选台词已提取并完成元信息过滤",
        candidateLineCount: candidateExtraction.candidateLines.length,
        candidateQualitySummary: candidateExtraction.qualitySummary,
        runner: { status: "not_started" },
      });

      // Step 6: Generate and write normalize-request.json bundle
      const bundle = generateNormalizeRequestBundle({
        taskId,
        runId,
        paths,
        inputDocuments: inputDocRefs,
        instructionContext,
        candidateLinesRef,
        currentState: {
          expectedVersion: currentVersionAtStart,
          currentProductionListPath: null,
          currentProductionListSummary: currentListSummary,
        },
      });
      writeNormalizeRequestBundle(bundle, paths.requestPath);

      // Step 7: Write instruction.md
      writeInstructionMarkdown(paths.instructionPath, instructionContext);

      // Step 8: Execute bundle-driven OpenCode run
      mergeRunProgress(progressPaths, {
        stage: "opencode_running",
        message: "OpenCode 正在生成 strict v2 生产列表",
        candidateLineCount: candidateExtraction.candidateLines.length,
        candidateQualitySummary: candidateExtraction.qualitySummary,
        runner: { status: "running" },
      });
      const bundleResult = await runBundleOpenCodeNormalize({
        normalizeRequestPath: paths.requestPath,
        schemaPath: paths.schemaPath,
        draftPath: paths.draftPath,
        instructionPath: paths.instructionPath,
        timeoutMs: configuredTimeoutMs,
      });
      mergeRunProgress(progressPaths, {
        stage: "draft_detected",
        message: "已检测到 draft，准备读取和校验",
        candidateLineCount: candidateExtraction.candidateLines.length,
        candidateQualitySummary: candidateExtraction.qualitySummary,
        runner: { status: "completed" },
      });

      // Step 9: Read, raw-validate, and commit the Agent draft through the shared v2 gate.
      return finalizeBundleNormalizeDraft({
        c: activeContext,
        db,
        requestId,
        taskId,
        runId,
        paths,
        draft: readNormalizeDraft(paths.draftPath),
        productionMetadata: { ...bundleResult.productionList.metadata, timeoutBasis },
        warnings: bundleResult.warnings,
        currentVersionAtStart,
        configuredTimeoutMs,
        normalizeStartTime,
        candidateLineCount: candidateExtraction.candidateLines.length,
        voiceMetadataCount: candidateExtraction.voiceMetadata.length,
        progressPaths,
      });
    } catch (bundleErr) {
      // Bundle-driven run failed. Normalize must not fall back to legacy v1.
      const failReason = sanitizeError(bundleErr);
      const elapsedMs = Date.now() - normalizeStartTime;

      // Determine reason code
      const isTimeout = failReason.includes("timed out") || failReason.includes("timeout");
      const reasonCode: RunnerStatus["reasonCode"] = isTimeout ? "opencode_timeout" : "opencode_unavailable_or_failed";
      const status = isTimeout ? 504 : 502;
      const errorCode = isTimeout ? "OPENCODE_NORMALIZE_TIMEOUT" : "OPENCODE_BUNDLE_RUN_FAILED";

      if (isTimeout) {
        const recoveryDraft = await waitForDraftAfterTimeout(paths.draftPath);
        if (recoveryDraft !== null) {
          return finalizeBundleNormalizeDraft({
            c: activeContext,
            db,
            requestId,
            taskId,
            runId,
            paths,
            draft: recoveryDraft,
            productionMetadata: {
              method: "opencode-bundle-run",
              durationMs: elapsedMs,
              stdoutSummary: "(Recovered from parseable draft after OpenCode process timeout)",
              timeoutBasis,
            },
            warnings: [],
            currentVersionAtStart,
            configuredTimeoutMs,
            normalizeStartTime,
            candidateLineCount: candidateLineCountForRun,
            voiceMetadataCount: voiceMetadataCountForRun,
            progressPaths,
            recovery: {
              code: "OPENCODE_PROCESS_TIMEOUT_AFTER_DRAFT",
              message: "OpenCode process timed out after writing a parseable draft; server validated and committed the draft without legacy fallback.",
              reason: failReason,
            },
          });
        }

        const recoveryWindowMs = getTimeoutDraftRecoveryWindowMs();
        if (recoveryWindowMs > 0) {
          const recoveryTimeoutBasis = buildTimeoutRecoveryBasis(timeoutBasis, recoveryWindowMs);
          const recoveryMessage = "OpenCode Agent normalize 已超过进程等待预算；继续轮询以等待可能稍后写入的 draft artifact。";
          mergeRunProgress(progressPaths, {
            stage: "timeout_recovery",
            message: recoveryMessage,
            candidateLineCount: candidateLineCountForRun,
            timeoutBasis: recoveryTimeoutBasis,
            runner: { status: "timeout" },
          });

          return activeContext.json(buildNormalizeStillRunningResponse({
            requestId,
            runId,
            taskId,
            configuredTimeoutMs,
            timeoutBasis: recoveryTimeoutBasis,
            stage: "timeout_recovery",
            elapsedMs,
            message: recoveryMessage,
          }), 202);
        }
      }

      writeCommitResult(paths.commitResultPath, {
        committed: false,
        error: `${errorCode}: ${failReason.slice(0, 500)}. No normalization applied.`,
        runId,
        taskId,
        committedAt: new Date().toISOString(),
      });

      mergeRunProgress(progressPaths, {
        stage: "failed",
        message: isTimeout
          ? "OpenCode Agent normalize timed out. No version created."
          : "OpenCode Agent normalize failed before producing a valid draft. No version created.",
        runner: { status: isTimeout ? "timeout" : "failed" },
        error: {
          code: errorCode,
          message: isTimeout
            ? "OpenCode Agent normalize timed out. No version created."
            : "OpenCode Agent normalize failed before producing a valid draft. No version created.",
          httpStatus: status,
          recoverability: "retryable",
        },
      });

      return activeContext.json({
        ok: false,
        requestId,
        attemptedRunner: "opencode",
        runId,
        error: {
          code: errorCode,
          message: isTimeout
            ? "OpenCode Agent normalize timed out. No version created."
            : "OpenCode Agent normalize failed before producing a valid draft. No version created.",
          category: "upstream",
          retryable: true,
          metadata: {
            runId,
            reason: failReason.slice(0, 500),
            currentVersion: currentVersionAtStart,
            timeoutBasis,
          },
        },
        runnerStatus: {
          status: "failed",
          reasonCode,
          elapsedMs,
          timeoutMs: configuredTimeoutMs,
          fallbackUsed: false,
        } satisfies RunnerStatus,
      }, status);
    }
    };

    if (responseMode === "async") {
      void executeNormalize().catch((err) => {
        const message = sanitizeError(err);
        mergeRunProgress(progressPaths, {
          stage: "failed",
          message: "Normalize 后台执行发生未处理错误。",
          runner: { status: "failed" },
          error: {
            code: "NORMALIZE_ASYNC_RUN_FAILED",
            message,
            httpStatus: 500,
            recoverability: "retryable",
          },
        });
      }).finally(() => {
        releaseActiveNormalizeRun(taskId, runId);
      });
      return c.json({
        ok: true,
        status: "accepted",
        requestId,
        runId,
        progressUrl: progressUrlFor(taskId, runId),
        stage: "queued",
        timeoutMs: configuredTimeoutMs,
        timeoutBasis,
      }, 202);
    }

    const executionPromise = executeNormalize()
      .catch((err) => {
        const message = sanitizeError(err);
        mergeRunProgress(progressPaths, {
          stage: "failed",
          message: "Normalize 执行发生未处理错误。",
          runner: { status: "failed" },
          error: {
            code: "NORMALIZE_RUN_FAILED",
            message,
            httpStatus: 500,
            recoverability: "retryable",
          },
        });
        return responseContext().json({
          ok: false,
          requestId,
          attemptedRunner: "opencode",
          runId,
          error: {
            code: "NORMALIZE_RUN_FAILED",
            message,
            category: "upstream",
            retryable: true,
            metadata: { runId, currentVersion: currentVersionAtStart, timeoutBasis },
          },
        }, 500);
      })
      .finally(() => {
        releaseActiveNormalizeRun(taskId, runId);
      });

    const syncWaitMs = getNormalizeSyncWaitMs(configuredTimeoutMs);
    const waitExpired = new Promise<"still_running">((resolve) => {
      setTimeout(() => resolve("still_running"), syncWaitMs);
    });
    const syncResult = await Promise.race([executionPromise, waitExpired]);
    if (syncResult !== "still_running") {
      return syncResult;
    }

    const latestProgress = readRunProgress(paths.progressPath);
    if (latestProgress && isTerminalNormalizeStage(latestProgress.stage)) {
      return executionPromise;
    }

    const runningProgress = latestProgress ?? buildProgress({
      taskId,
      runId,
      stage: "opencode_running",
      startedAt,
      timeoutMs: configuredTimeoutMs,
      timeoutBasis,
      draftPath: paths.draftPath,
      runner: { status: "running" },
      message: "OpenCode 正在生成 strict v2 生产列表",
    });

    return c.json(buildNormalizeStillRunningResponse({
      requestId,
      runId,
      taskId,
      configuredTimeoutMs,
      timeoutBasis,
      stage: runningProgress.stage,
      elapsedMs: runningProgress.elapsedMs,
      message: "OpenCode normalize 仍在运行，已切换为 progressUrl 轮询；不会因本地等待窗口到期标记失败。",
    }), 202);
  }

  // ── OpenCode unavailable: strict normalize returns 503, no legacy fallback ──
  return c.json({
    ok: false,
    requestId,
    attemptedRunner: "opencode",
    error: {
      code: "OPENCODE_UNAVAILABLE",
      message: "OpenCode is unavailable for Agent normalize. No version created.",
      category: "upstream",
      retryable: true,
        metadata: {
          reason: availability.error ?? "OpenCode availability check failed.",
          currentVersion: currentVersionAtStart,
          timeoutBasis,
        },
    },
    runnerStatus: {
      status: "failed",
      reasonCode: "opencode_unavailable_or_failed",
      elapsedMs: Date.now() - normalizeStartTime,
      timeoutMs: configuredTimeoutMs,
      fallbackUsed: false,
    } satisfies RunnerStatus,
  }, 503);
});

app.get("/api/tasks/:taskId/agent/normalize-runs/:runId/progress", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const runId = c.req.param("runId");
  try {
    const paths = getNormalizeRunPaths(taskId, runId);
    const progress = readRunProgress(paths.progressPath);
    if (!progress) {
      return apiError(c, requestId, 404, "NORMALIZE_PROGRESS_NOT_FOUND", "Normalize run progress artifact was not found.", "not_found");
    }

    let refreshedProgress = refreshOrTerminalizeProgress(taskId, paths, progress);
    refreshedProgress = recoverOrExpireTimeoutProgress({
      c,
      db: getDb(),
      requestId,
      taskId,
      runId,
      paths,
      progress: refreshedProgress,
      reason: "progress endpoint detected a parseable late draft",
    });
    if (isTerminalNormalizeStage(refreshedProgress.stage)) {
      releaseActiveNormalizeRun(taskId, runId);
    }
    return c.json({
      ...refreshedProgress,
      requestId,
    });
  } catch (err) {
    return apiError(
      c,
      requestId,
      400,
      "PROGRESS_ARTIFACT_INVALID",
      sanitizeError(err),
      "validation",
    );
  }
});

// ─── GET /api/tasks/:taskId/agent/runs ─────────────────────────────────────────

app.get("/api/tasks/:taskId/agent/runs", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const limitRaw = c.req.query("limit");
  const kind = c.req.query("kind");
  const limit = Math.min(Math.max(Number.parseInt(limitRaw ?? "20", 10) || 20, 1), 100);
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const runs: AgentRunSummary[] = [];
  if (!kind || kind === "normalize") {
    for (const run of listNormalizeRunProgress(taskId)) {
      let refreshed = refreshOrTerminalizeProgress(taskId, run.paths, run.progress);
      refreshed = recoverOrExpireTimeoutProgress({
        c: responseContext(),
        db,
        requestId,
        taskId,
        runId: run.runId,
        paths: run.paths,
        progress: refreshed,
        reason: "runs endpoint detected a parseable late draft",
      });
      runs.push(summarizeNormalizeRun(taskId, run.runId, run.paths, refreshed));
    }
  }
  if (!kind || kind === "button") {
    const buttonRuns = db.select().from(agentButtonRun)
      .where(eq(agentButtonRun.taskId, taskId))
      .orderBy(desc(agentButtonRun.createdAt))
      .limit(limit)
      .all();
    runs.push(...buttonRuns.map(summarizeButtonRun));
  }

  runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return c.json({ ok: true, requestId, runs: runs.slice(0, limit) });
});

// ─── GET /api/tasks/:taskId/agent/runs/:runId ──────────────────────────────────

app.get("/api/tasks/:taskId/agent/runs/:runId", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const runId = c.req.param("runId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const run = parseAgentRun(taskId, runId);
  if (!run) {
    return apiError(c, requestId, 404, "RUN_NOT_FOUND", `Run "${runId}" was not found for this task.`, "not_found");
  }

  if (run.kind === "normalize") {
    return c.json({
      ok: true,
      requestId,
      run: {
        ...run.summary,
        promptSummary: run.progress.message,
        normalizeProgress: run.progress,
        inputSnapshot: readJsonFile(run.paths.requestPath),
        outputSnapshot: readJsonFile(run.paths.commitResultPath),
        artifactRefs: [
          { label: "normalize-request", path: run.paths.requestPath, available: fs.existsSync(run.paths.requestPath) },
          { label: "draft", path: run.paths.draftPath, available: fs.existsSync(run.paths.draftPath) },
          { label: "validation-report", path: run.paths.validationReportPath, available: fs.existsSync(run.paths.validationReportPath) },
          { label: "commit-result", path: run.paths.commitResultPath, available: fs.existsSync(run.paths.commitResultPath) },
        ],
      },
    });
  }

  const inputSnapshot = safeJsonParse(run.run.inputSnapshotJson) ?? run.artifact?.inputSnapshot ?? null;
  const outputSnapshot = safeJsonParse(run.run.outputSnapshotJson) ?? run.artifact?.outputSnapshot ?? null;
  return c.json({
    ok: true,
    requestId,
    run: {
      ...run.summary,
      promptSummary: typeof run.artifact?.promptSummary === "string" ? run.artifact.promptSummary : undefined,
      inputSnapshot,
      outputSnapshot,
      artifactRefs: [
        { label: "button-run", available: Boolean(run.artifact) },
      ],
    },
  });
});

// ─── GET /api/tasks/:taskId/agent/runs/:runId/diff ─────────────────────────────

app.get("/api/tasks/:taskId/agent/runs/:runId/diff", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const runId = c.req.param("runId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const run = parseAgentRun(taskId, runId);
  if (!run) {
    return apiError(c, requestId, 404, "RUN_NOT_FOUND", `Run "${runId}" was not found for this task.`, "not_found");
  }

  const inputSnapshot = run.kind === "button" ? (safeJsonParse(run.run.inputSnapshotJson) ?? run.artifact?.inputSnapshot) : undefined;
  const outputSnapshot = run.kind === "button" ? (safeJsonParse(run.run.outputSnapshotJson) ?? run.artifact?.outputSnapshot) : undefined;
  if (inputSnapshot && outputSnapshot && typeof inputSnapshot === "object" && typeof outputSnapshot === "object") {
    const before = inputSnapshot as Record<string, unknown>;
    const after = outputSnapshot as Record<string, unknown>;
    const fields = collectChangedFields(before, after);
    return c.json({
      ok: true,
      requestId,
      diff: {
        runId,
        available: true,
        beforeVersion: run.summary.beforeVersion,
        afterVersion: run.summary.afterVersion,
        summary: { addedCount: 0, removedCount: 0, changedCount: fields.length > 0 ? 1 : 0 },
        lineChanges: fields.length > 0 ? [{ lineId: String(before.id ?? after.id ?? run.summary.targetLineIds[0] ?? runId), before, after, fields }] : [],
      },
    });
  }

  if (Number.isInteger(run.summary.beforeVersion) && Number.isInteger(run.summary.afterVersion) && run.summary.beforeVersion !== run.summary.afterVersion) {
    const beforeVersion = run.summary.beforeVersion!;
    const afterVersion = run.summary.afterVersion!;
    const beforeRecord = db.select().from(productionListVersion)
      .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, beforeVersion)))
      .get();
    const afterRecord = db.select().from(productionListVersion)
      .where(and(eq(productionListVersion.taskId, taskId), eq(productionListVersion.version, afterVersion)))
      .get();
    if (beforeRecord && afterRecord) {
      const lineChanges = computeLineChanges(loadVersionLines(taskId, beforeRecord), loadVersionLines(taskId, afterRecord));
      return c.json({
        ok: true,
        requestId,
        diff: {
          runId,
          available: true,
          beforeVersion,
          afterVersion,
          summary: summarizeLineChanges(lineChanges),
          lineChanges,
        },
      });
    }
  }

  return c.json({
    ok: true,
    requestId,
    diff: {
      runId,
      available: false,
      unavailableReason: "该历史运行缺少 beforeVersion/afterVersion 或快照 artifact，无法计算真实 diff。",
    },
  });
});

// ─── DELETE /api/tasks/:taskId/agent/runs/:runId ───────────────────────────────

app.delete("/api/tasks/:taskId/agent/runs/:runId", (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const runId = c.req.param("runId");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  const run = parseAgentRun(taskId, runId);
  if (!run) {
    return apiError(c, requestId, 404, "RUN_NOT_FOUND", `Run "${runId}" was not found for this task.`, "not_found");
  }

  return apiError(c, requestId, 409, "RUN_CANCEL_UNAVAILABLE", "当前后端没有可中断该运行的执行句柄，无法保证取消后不提交结果。", "capability", false, {
    runId,
    available: false,
    reason: "no_abort_handle",
  });
});

/**
 * Atomic commit helper shared by bundle main path and fallback/import paths.
 *
 * R-M2: All normalize commit paths MUST use this function to ensure:
 * 1. expectedVersion re-check + version insert + line inserts are atomic (in one transaction)
 * 2. Stale expectedVersion returns 409, not committed as next version
 * 3. DB-level unique index (task_id, version) provides backstop
 *
 * Returns { newVersion, versionId } on success.
 * Throws VERSION_CONFLICT on stale expectedVersion or unique constraint violation.
 */
function atomicCommitProductionList(
  db: ReturnType<typeof getDb>,
  taskId: string,
  expectedVersionAtStart: number,
  lines: Array<Record<string, unknown>>,
  speakers: Array<Record<string, unknown>>,
  metadata: Record<string, unknown>,
  runner: string,
  promptProfiles: PromptProfile[] = [],
): { newVersion: number; versionId: string; now: Date } {
  const versionId = uuidv4();
  const now = new Date();

  // M4: Sanitize metadata before writing to DB
  const safeMetadata = {
    ...metadata,
    runner,
    normalizedAt: now.toISOString(),
    stdoutSummary: sanitizeString(
      typeof metadata?.stdoutSummary === "string"
        ? metadata.stdoutSummary
        : "",
    ),
  };

  const committedVersionNum = db.transaction((tx) => {
    // Re-check current version WITHIN transaction (atomic with insert)
    const currentVersionNow = tx.select().from(productionListVersion)
      .where(eq(productionListVersion.taskId, taskId))
      .orderBy(desc(productionListVersion.version))
      .limit(1)
      .get();

    const currentVersionNum = currentVersionNow?.version ?? 0;
    if (currentVersionNum !== expectedVersionAtStart) {
      throw new Error(`VERSION_CONFLICT:${currentVersionNum}`);
    }

    const newVersionNum = expectedVersionAtStart + 1;

    for (const profile of promptProfiles) {
      const config = {
        audioProfile: profile.audioProfile,
        scene: profile.scene,
        directorNotes: profile.directorNotes,
        sampleContext: profile.sampleContext,
        defaultVoice: profile.speakers[0]?.voice ?? "Zephyr",
        defaultModel: "google/gemini-3.1-flash-tts-preview",
        defaultFormat: "wav",
        speakers: profile.speakers,
      };
      const existing = tx.select().from(directorProfile).where(eq(directorProfile.id, profile.id)).get();
      const storageName = profileStorageName(taskId, profile);
      if (existing) {
        tx.update(directorProfile).set({
          name: storageName,
          description: profile.description ?? "",
          config: JSON.stringify(config),
          updatedAt: now,
        }).where(eq(directorProfile.id, profile.id)).run();
      } else {
        tx.insert(directorProfile).values({
          id: profile.id,
          name: storageName,
          description: profile.description ?? "",
          config: JSON.stringify(config),
          createdAt: now,
          updatedAt: now,
        }).run();
      }
    }

    tx.insert(productionListVersion).values({
      id: versionId,
      taskId,
      version: newVersionNum,
      speakersJson: JSON.stringify(speakers),
      metadataJson: JSON.stringify(safeMetadata),
      lineCount: lines.length,
      createdAt: now,
    }).run();

    for (const line of lines) {
      tx.insert(voiceLine).values({
        id: uuidv4(),
        lineId: line.id as string,
        taskId,
        versionId,
        order: line.order as number,
        speaker: line.speaker as string,
        text: line.text as string,
        voice: line.voice as string,
        style: (line.style as string) ?? "",
        notes: (line.notes as string) ?? "",
        status: "pending",
        directorProfileId: (line as any).directorProfileId ?? null,
        directorOverrideJson: (line as any).directorOverrideJson ?? null,
        generationStatus: "draft",
        relatedJobId: null,
        relatedAssetId: null,
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    return newVersionNum;
  });

  return { newVersion: committedVersionNum, versionId, now };
}

/**
 * Handle VERSION_CONFLICT errors from atomic commit.
 * Returns a 409 response or re-throws non-conflict errors.
 */
function handleAtomicCommitConflict(
  txErr: unknown,
  expectedVersionAtStart: number,
  taskId: string,
  requestId: string,
  c: any,
  runId?: string,
) {
  const errMsg = txErr instanceof Error ? txErr.message : String(txErr);
  const isConflict = errMsg.startsWith("VERSION_CONFLICT:")
    || errMsg.includes("UNIQUE constraint failed")
    || errMsg.includes("unique");

  if (isConflict) {
    const conflictVersion = errMsg.startsWith("VERSION_CONFLICT:")
      ? errMsg.split(":")[1]
      : String(expectedVersionAtStart + 1);

    return c.json({
      ok: false,
      requestId,
      error: {
        code: "VERSION_CONFLICT",
        message: "Production list was modified during processing. Atomic commit detected conflict.",
        category: "conflict",
        retryable: true,
        metadata: {
          expectedVersion: expectedVersionAtStart,
          conflictingVersion: conflictVersion,
          runId,
        },
      },
    }, 409);
  }

  throw txErr;
}

/**
 * Discriminated union result from commitFallbackProductionList.
 *
 * R-M2-B: The caller MUST check the `kind` field:
 * - "response": a Hono Response (e.g., 409 conflict) that must be returned directly.
 *   Do NOT wrap it in another c.json() call or the HTTP status/body will be lost.
 * - "success": a plain data object that can be spread into a c.json() response.
 */
type FallbackCommitResult =
  | { kind: "response"; response: Response }
  | { kind: "success"; body: {
      ok: true;
      requestId: string;
      runner: string;
      productionList: {
        taskId: string;
        version: number;
        lines: unknown;
        speakers: unknown;
        metadata: unknown;
      };
      parseStats: unknown;
    } };

/**
 * Commit a fallback production list to the database and artifacts.
 *
 * R-M2: Now uses the same atomic commit helper as the bundle main path.
 * The expectedVersion re-check + version insert + line inserts are atomic.
 * Stale expectedVersion returns 409 instead of silently committing as next version.
 *
 * R-M2-B: Returns a discriminated union. Callers MUST check `result.kind`:
 * - If "response", return result.response directly (do NOT wrap in c.json).
 * - If "success", spread result.body into the response.
 */
function commitFallbackProductionList(
  taskId: string,
  result: import("../services/opencode-runner.js").NormalizeRequirementsOutput,
  requestId: string,
  db: ReturnType<typeof getDb>,
  expectedVersionAtStart: number,
  c: any,
): FallbackCommitResult {
  const { productionList, runner } = result;

  let committedVersionNum: number;
  let versionId: string;
  let commitNow: Date;

  try {
    const commitResult = atomicCommitProductionList(
      db,
      taskId,
      expectedVersionAtStart,
      productionList.lines as unknown as Array<Record<string, unknown>>,
      productionList.speakers as unknown as Array<Record<string, unknown>>,
      productionList.metadata || {},
      runner,
    );
    committedVersionNum = commitResult.newVersion;
    versionId = commitResult.versionId;
    commitNow = commitResult.now;
  } catch (txErr) {
    // R-M2-B: Return the conflict response directly via discriminated union.
    // The caller MUST return this response as-is, not wrap it.
    return { kind: "response", response: handleAtomicCommitConflict(txErr, expectedVersionAtStart, taskId, requestId, c) };
  }

  // DB transaction committed successfully. Write artifact AFTER commit.
  writeArtifact(taskId, productionListArtifactName(), {
    version: committedVersionNum,
    versionId,
    lines: productionList.lines,
    speakers: productionList.speakers,
    directorProfileId: null,
    metadata: { ...productionList.metadata, runner },
    updatedAt: commitNow.toISOString(),
  });

  auditLog("production_list", versionId, "normalize_requirements", runner, { taskId, lineCount: productionList.lines.length }, requestId);

  return {
    kind: "success",
    body: {
      ok: true,
      requestId,
      runner,
      productionList: {
        taskId,
        version: committedVersionNum,
        lines: productionList.lines,
        speakers: productionList.speakers,
        metadata: productionList.metadata,
      },
      parseStats: result.parseStats ?? undefined,
    },
  };
}

// ─── POST /api/tasks/:taskId/agent/buttons/:buttonKey/execute ─────────────────

app.post("/api/tasks/:taskId/agent/buttons/:buttonKey/execute", async (c) => {
  const requestId = uuidv4();
  const taskId = c.req.param("taskId");
  const buttonKey = c.req.param("buttonKey");
  const db = getDb();

  const task = db.select().from(voiceTask).where(eq(voiceTask.id, taskId)).get();
  if (!task) {
    return apiError(c, requestId, 404, "TASK_NOT_FOUND", `Task "${taskId}" not found.`, "validation");
  }

  // Validate button exists
  const preset = db.select().from(agentButtonPreset).where(eq(agentButtonPreset.buttonKey, buttonKey)).get();
  if (!preset) {
    return apiError(c, requestId, 404, "BUTTON_NOT_FOUND", `Button "${buttonKey}" not found.`, "validation");
  }

  // Validate button is enabled
  if (!preset.enabled) {
    return apiError(c, requestId, 403, "BUTTON_DISABLED", `Button "${buttonKey}" is disabled and cannot be executed.`, "validation");
  }

  // Parse target policy
  let targetPolicy: { allowedFields?: string[]; scope?: string };
  try {
    targetPolicy = JSON.parse(preset.targetPolicyJson || "{}");
  } catch {
    targetPolicy = {};
  }

  // Parse request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request body must be valid JSON.", "validation");
  }

  const parsed = ExecuteButtonSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Request validation failed.", "validation", false, { issues: parsed.error.flatten() });
  }

  const { expectedVersion, parameters } = parsed.data;
  const target = parsed.data.target ?? (parsed.data.targetLineId ? { scope: "line" as const, lineId: parsed.data.targetLineId } : undefined);
  if (!target) {
    return apiError(c, requestId, 400, "VALIDATION_ERROR", "Either targetLineId or target is required.", "validation");
  }

  if (target.scope !== "line") {
    return apiError(c, requestId, 501, "BUTTON_SCOPE_UNSUPPORTED", `Button scope "${target.scope}" is not supported by the current backend for button execution.`, "capability", false, {
      requestedScope: target.scope,
      supportedScopes: ["line"],
      target,
    });
  }
  const targetLineId = target.lineId;

  // Version conflict check
  const currentVersion = db.select().from(productionListVersion)
    .where(eq(productionListVersion.taskId, taskId))
    .orderBy(desc(productionListVersion.version))
    .limit(1)
    .get();

  if (!currentVersion) {
    return apiError(c, requestId, 404, "NO_PRODUCTION_LIST", "No production list exists for this task.", "validation");
  }

  if (expectedVersion !== currentVersion.version) {
    return apiError(c, requestId, 409, "VERSION_CONFLICT", `Expected version ${expectedVersion} but current is ${currentVersion.version}.`, "conflict", true, {
      expectedVersion,
      currentVersion: currentVersion.version,
    });
  }

  // Find target line
  const targetLine = db.select().from(voiceLine)
    .where(and(eq(voiceLine.versionId, currentVersion.id), or(eq(voiceLine.id, targetLineId), eq(voiceLine.lineId, targetLineId))))
    .get();

  if (!targetLine) {
    return apiError(c, requestId, 404, "LINE_NOT_FOUND", `Line "${targetLineId}" not found in current production list version.`, "validation");
  }

  // Execute button transform
  const runId = uuidv4();
  const now = new Date();
  const artifact = readArtifact<any>(taskId, productionListArtifactName());
  const artifactLinesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(artifact?.lines)) {
    for (const line of artifact.lines) {
      if (line && typeof line.id === "string") artifactLinesById.set(line.id, line);
    }
  }
  const targetLogicalLineId = logicalLineId(targetLine);
  const targetArtifactLine = artifactLinesById.get(targetLogicalLineId) ?? {};

  const inputSnapshot = {
    ...targetArtifactLine,
    id: targetLogicalLineId,
    order: targetLine.order,
    moduleName: typeof targetArtifactLine.moduleName === "string" ? targetArtifactLine.moduleName : (targetArtifactLine.moduleName === null ? null : undefined),
    title: typeof targetArtifactLine.title === "string" ? targetArtifactLine.title : (targetArtifactLine.title === null ? null : undefined),
    speaker: targetLine.speaker,
    text: targetLine.text,
    transcript: typeof targetArtifactLine.transcript === "string" ? targetArtifactLine.transcript : targetLine.text,
    voice: targetLine.voice,
    style: targetLine.style,
    notes: targetLine.notes,
    status: targetLine.status,
  };

  let newText = targetLine.text;
  let newStyle = targetLine.style;
  let runner: "opencode" | "fallback" = "fallback";

  try {
    const availability = await checkOpenCodeAvailability();

    if (availability.available) {
      // P0: would call OpenCode CLI here with promptTemplate
      // For now, use fallback to ensure deterministic behavior
      runner = "fallback";
    }

    // Apply transform based on button type
    const transformKey = buttonKey.startsWith("style-") ? "style" : buttonKey;
    if (targetPolicy.allowedFields?.includes("text")) {
      newText = applyFallbackTransform(transformKey, targetLine.text, parameters);
    }
    if (targetPolicy.allowedFields?.includes("style") && transformKey === "style") {
      const tone = buttonKey.replace("style-", "");
      newStyle = tone;
    }
  } catch (err) {
    // Record failed run
    db.insert(agentButtonRun).values({
      id: runId,
      taskId,
      buttonKey,
      targetLineId,
      runner,
      inputSnapshotJson: JSON.stringify(inputSnapshot),
      status: "failed",
      errorCode: "TRANSFORM_ERROR",
      errorMessage: sanitizeError(err),
      createdAt: now,
    }).run();

    return apiError(c, requestId, 500, "TRANSFORM_ERROR", sanitizeError(err), "internal");
  }

  const outputSnapshot = { ...inputSnapshot, text: newText, transcript: newText, style: newStyle };

  // Create new version with the modified line. The DB writes are atomic and use
  // a version-row id plus stable logical line id, so older version rows are not
  // deleted to reuse the primary key.
  const newVersionNum = currentVersion.version + 1;
  const newVersionId = uuidv4();

  // Copy all lines from current version, replacing the target
  const allCurrentLines = db.select().from(voiceLine)
    .where(eq(voiceLine.versionId, currentVersion.id))
    .orderBy(voiceLine.order)
    .all();

  // Update artifact
  const newLines = allCurrentLines.map((l) => ({
    ...(artifactLinesById.get(logicalLineId(l)) ?? {}),
    ...l,
    id: logicalLineId(l),
    text: logicalLineId(l) === targetLogicalLineId ? newText : l.text,
    style: logicalLineId(l) === targetLogicalLineId ? newStyle : l.style,
    status: logicalLineId(l) === targetLogicalLineId ? "pending" : l.status,
    model: typeof artifactLinesById.get(logicalLineId(l))?.model === "string" ? artifactLinesById.get(logicalLineId(l))?.model : "google/gemini-3.1-flash-tts-preview",
    responseFormat: ["wav", "pcm", "mp3"].includes(String(artifactLinesById.get(logicalLineId(l))?.responseFormat)) ? artifactLinesById.get(logicalLineId(l))?.responseFormat : "wav",
    transcript: typeof artifactLinesById.get(logicalLineId(l))?.transcript === "string"
      ? (logicalLineId(l) === targetLogicalLineId ? newText : artifactLinesById.get(logicalLineId(l))?.transcript)
      : (logicalLineId(l) === targetLogicalLineId ? newText : l.text),
    promptProfileId: artifactLinesById.get(logicalLineId(l))?.promptProfileId ?? l.directorProfileId ?? null,
    speakerLabel: artifactLinesById.get(logicalLineId(l))?.speakerLabel ?? null,
    promptOverride: artifactLinesById.get(logicalLineId(l))?.promptOverride ?? null,
  }));

  try {
    db.transaction((tx) => {
      const currentVersionNow = tx.select().from(productionListVersion)
        .where(eq(productionListVersion.taskId, taskId))
        .orderBy(desc(productionListVersion.version))
        .limit(1)
        .get();

      if (!currentVersionNow || currentVersionNow.version !== expectedVersion) {
        throw new Error(`VERSION_CONFLICT:${currentVersionNow?.version ?? 0}`);
      }

      tx.insert(productionListVersion).values({
        id: newVersionId,
        taskId,
        version: newVersionNum,
        directorProfileId: currentVersion.directorProfileId,
        speakersJson: currentVersion.speakersJson,
        metadataJson: currentVersion.metadataJson,
        lineCount: currentVersion.lineCount,
        createdAt: now,
      }).run();

      for (const line of allCurrentLines) {
        const lineId = logicalLineId(line);
        const isTarget = lineId === targetLogicalLineId;
        tx.insert(voiceLine).values({
          id: uuidv4(),
          lineId,
          taskId,
          versionId: newVersionId,
          order: line.order,
          speaker: line.speaker,
          text: isTarget ? newText : line.text,
          voice: line.voice,
          style: isTarget ? newStyle : line.style,
          notes: line.notes,
          status: isTarget ? "pending" : line.status,
          directorProfileId: line.directorProfileId ?? null,
          directorOverrideJson: line.directorOverrideJson ?? null,
          generationStatus: line.generationStatus ?? "draft",
          relatedJobId: line.relatedJobId ?? null,
          relatedAssetId: line.relatedAssetId ?? null,
          generationErrorCode: line.generationErrorCode ?? null,
          generationErrorMessage: line.generationErrorMessage ?? null,
          createdAt: now,
          updatedAt: now,
        }).run();
      }

      tx.insert(agentButtonRun).values({
        id: runId,
        taskId,
        buttonKey,
        targetLineId: targetLogicalLineId,
        runner,
        inputSnapshotJson: JSON.stringify(inputSnapshot),
        outputSnapshotJson: JSON.stringify(outputSnapshot),
        status: "completed",
        createdAt: now,
        completedAt: now,
      }).run();
    });
  } catch (txErr) {
    const errMsg = txErr instanceof Error ? txErr.message : String(txErr);
    if (errMsg.startsWith("VERSION_CONFLICT:") || errMsg.includes("UNIQUE constraint failed") || errMsg.includes("unique")) {
      return handleAtomicCommitConflict(txErr, expectedVersion, taskId, requestId, c, runId);
    }
    return apiError(c, requestId, 500, "BUTTON_COMMIT_FAILED", sanitizeError(txErr), "internal");
  }

  writeArtifact(taskId, productionListArtifactName(), {
    schemaVersion: artifact?.schemaVersion,
    version: newVersionNum,
    versionId: newVersionId,
    lines: newLines,
    speakers: artifact?.speakers ?? [],
    promptProfiles: artifact?.promptProfiles ?? artifact?.directorProfiles ?? [],
    directorProfiles: artifact?.directorProfiles ?? artifact?.promptProfiles ?? [],
    directorProfileId: currentVersion.directorProfileId,
    metadata: artifact?.metadata ?? {},
    updatedAt: now.toISOString(),
  });

  writeArtifact(taskId, productionListVersionArtifactName(newVersionNum), {
    schemaVersion: artifact?.schemaVersion,
    version: newVersionNum,
    versionId: newVersionId,
    lines: newLines,
    speakers: artifact?.speakers ?? [],
    promptProfiles: artifact?.promptProfiles ?? artifact?.directorProfiles ?? [],
    directorProfiles: artifact?.directorProfiles ?? artifact?.promptProfiles ?? [],
    directorProfileId: currentVersion.directorProfileId,
    metadata: artifact?.metadata ?? {},
    updatedAt: now.toISOString(),
  });

  writeArtifact(taskId, buttonRunArtifactName(runId), {
    buttonKey,
    targetLineId: targetLogicalLineId,
    runner,
    title: preset.name,
    inputSnapshot,
    outputSnapshot,
    beforeVersion: currentVersion.version,
    afterVersion: newVersionNum,
    version: newVersionNum,
    target: { scope: "line", lineId: targetLogicalLineId },
    automationSessionId: parsed.data.automationSessionId,
    executedAt: now.toISOString(),
  });

  auditLog("button_run", runId, `execute:${buttonKey}`, runner, { taskId, targetLineId: targetLogicalLineId, version: newVersionNum }, requestId);

  return c.json({
    ok: true,
    requestId,
    runId,
    runner,
    beforeVersion: currentVersion.version,
    version: newVersionNum,
    targetLine: outputSnapshot,
  });
});

export default app;
