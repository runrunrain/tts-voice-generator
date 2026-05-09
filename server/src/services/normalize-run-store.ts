/**
 * Normalize Run Store - Run-scoped artifact management for Agent Normalize.
 *
 * Creates isolated run directories under agent-runs/normalize-{runId}/
 * with fixed artifact names. All paths are generated server-side;
 * no client-supplied paths are accepted.
 *
 * Security:
 * - runId is always a server-generated UUID
 * - All paths are validated against path traversal
 * - Fixed artifact names enforced via allowlist
 * - No API keys, secrets, or environment values written to artifacts
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import type { VoiceLine, Speaker } from "../domain/validators.js";
import type { CandidateLine, VoiceMetadata } from "./opencode-runner.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Fixed artifact file names allowed in a normalize run directory */
const RUN_ARTIFACT_NAMES = new Set([
  "normalize-request.json",
  "production-list.schema.json",
  "instruction.md",
  "candidate-lines.json",
  "run-progress.json",
  "production-list.draft.json",
  "validation-report.json",
  "commit-result.json",
]);

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface InputDocumentRef {
  documentId: string;
  fileName: string;
  source: "upload" | "paste" | "agent";
  /** Server-generated absolute path to the document artifact */
  path: string;
  /** Content type wrapper -- current artifacts store { fileName, content } */
  contentPathType: "json-wrapper";
  sha256: string;
  enabled: boolean;
  version: number;
}

export interface InstructionContext {
  userInstruction: string;
  taskTitle: string;
  taskDescription: string;
  targetDatasetType: "production-list" | "prompt-structured-production-list";
  language: "zh-CN";
  businessRules: string[];
}

export interface DatasetSchemaRef {
  name: "ProductionList" | "PromptStructuredProductionList";
  version: "1.0" | "2.0";
  /** Server-generated absolute path to schema snapshot */
  path: string;
}

export interface CurrentState {
  expectedVersion: number;
  currentProductionListPath: string | null;
  currentProductionListSummary: {
    lineCount: number;
    speakers: string[];
  };
}

export interface OutputContract {
  /** Server-generated absolute path where Agent writes draft */
  draftPath: string;
  writeMode: "draft-file-then-server-commit";
}

export interface CandidateLinesRef {
  path: string;
  count: number;
  contentPathType: "candidate-lines-v1";
  sha256: string;
}

export interface SafetyConstraints {
  allowedReadPaths: string[];
  allowedWritePaths: string[];
  noSecrets: true;
}

export interface NormalizeRequestBundle {
  schemaVersion: "tts.normalize-request.v1";
  taskId: string;
  runId: string;
  createdAt: string;
  conversionGoal: string;
  instructionContext: InstructionContext;
  inputDocuments: InputDocumentRef[];
  candidateLines?: CandidateLinesRef;
  datasetSchema: DatasetSchemaRef;
  currentState: CurrentState;
  outputContract: OutputContract;
  safety: SafetyConstraints;
}

export interface RunPaths {
  runDir: string;
  requestPath: string;
  schemaPath: string;
  instructionPath: string;
  candidateLinesPath: string;
  progressPath: string;
  draftPath: string;
  validationReportPath: string;
  commitResultPath: string;
}

export type NormalizeRunStage =
  | "queued"
  | "preprocessing"
  | "opencode_running"
  | "draft_detected"
  | "validating"
  | "committing"
  | "completed"
  | "failed";

export interface NormalizeRunProgress {
  ok: true;
  runId: string;
  taskId: string;
  stage: NormalizeRunStage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  elapsedMs: number;
  timeoutMs: number;
  timeoutBasis: Record<string, unknown>;
  candidateLineCount: number;
  candidateQualitySummary?: unknown;
  draft: {
    exists: boolean;
    parseable: boolean;
    sizeBytes: number;
    updatedAt?: string;
  };
  quality: {
    checked: boolean;
    passed?: boolean;
    issueCount?: number;
    blockingIssueCount?: number;
    warningIssueCount?: number;
    issuesPreview?: unknown[];
  };
  runner: {
    status: "not_started" | "running" | "completed" | "timeout" | "failed";
  };
  result?: {
    versionId: string;
    lineCount: number;
  };
  error?: {
    code: string;
    message: string;
    httpStatus?: number;
    recoverability: "retryable" | "user_action_required" | "not_retryable";
  };
  message: string;
}

// ─── Path Helpers ──────────────────────────────────────────────────────────────

function getTasksBaseDir(): string {
  return path.resolve(env.dataDir || "./data", "tasks");
}

function getTaskDir(taskId: string): string {
  validateTaskId(taskId);
  return path.join(getTasksBaseDir(), taskId);
}

function validateTaskId(taskId: string): void {
  if (!UUID_REGEX.test(taskId)) {
    throw new Error(`Invalid task ID format: ${taskId}`);
  }
}

function validateRunId(runId: string): void {
  if (!UUID_REGEX.test(runId)) {
    throw new Error(`Invalid run ID format: ${runId}`);
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Validate that a path does not contain traversal sequences.
 * Returns the normalized absolute path or throws.
 */
function safeNormalizePath(baseDir: string, relativePath: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  // Ensure the resolved path is still under baseDir
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return resolved;
}

// ─── Core Operations ───────────────────────────────────────────────────────────

/**
 * Create a new normalize run directory and return all fixed artifact paths.
 *
 * Directory layout:
 *   data/tasks/{taskId}/agent-runs/normalize-{runId}/
 *     normalize-request.json
 *     production-list.schema.json
 *     instruction.md
 *     candidate-lines.json
 *     production-list.draft.json
 *     validation-report.json
 *     commit-result.json
 */
export function createNormalizeRun(taskId: string): { runId: string; paths: RunPaths } {
  validateTaskId(taskId);
  const runId = crypto.randomUUID();
  const runDirName = `normalize-${runId}`;
  const taskDir = getTaskDir(taskId);

  // Validate the run directory name doesn't contain path traversal
  const runDir = safeNormalizePath(taskDir, path.join("agent-runs", runDirName));
  ensureDir(runDir);

  const paths: RunPaths = {
    runDir,
    requestPath: path.join(runDir, "normalize-request.json"),
    schemaPath: path.join(runDir, "production-list.schema.json"),
    instructionPath: path.join(runDir, "instruction.md"),
    candidateLinesPath: path.join(runDir, "candidate-lines.json"),
    progressPath: path.join(runDir, "run-progress.json"),
    draftPath: path.join(runDir, "production-list.draft.json"),
    validationReportPath: path.join(runDir, "validation-report.json"),
    commitResultPath: path.join(runDir, "commit-result.json"),
  };

  return { runId, paths };
}

export function getNormalizeRunPaths(taskId: string, runId: string): RunPaths {
  validateTaskId(taskId);
  validateRunId(runId);
  const taskDir = getTaskDir(taskId);
  const runDir = safeNormalizePath(taskDir, path.join("agent-runs", `normalize-${runId}`));
  return {
    runDir,
    requestPath: path.join(runDir, "normalize-request.json"),
    schemaPath: path.join(runDir, "production-list.schema.json"),
    instructionPath: path.join(runDir, "instruction.md"),
    candidateLinesPath: path.join(runDir, "candidate-lines.json"),
    progressPath: path.join(runDir, "run-progress.json"),
    draftPath: path.join(runDir, "production-list.draft.json"),
    validationReportPath: path.join(runDir, "validation-report.json"),
    commitResultPath: path.join(runDir, "commit-result.json"),
  };
}

export function listNormalizeRunProgress(taskId: string): Array<{ runId: string; paths: RunPaths; progress: NormalizeRunProgress }> {
  validateTaskId(taskId);
  const taskDir = getTaskDir(taskId);
  const agentRunsDir = safeNormalizePath(taskDir, "agent-runs");
  if (!fs.existsSync(agentRunsDir)) return [];

  const entries = fs.readdirSync(agentRunsDir, { withFileTypes: true });
  const runs: Array<{ runId: string; paths: RunPaths; progress: NormalizeRunProgress }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("normalize-")) continue;
    const runId = entry.name.slice("normalize-".length);
    try {
      validateRunId(runId);
      const paths = getNormalizeRunPaths(taskId, runId);
      const progress = readRunProgress(paths.progressPath);
      if (progress) runs.push({ runId, paths, progress });
    } catch {
      // Ignore malformed or partial run directories when looking for active runs.
    }
  }

  return runs.sort((a, b) => Date.parse(b.progress.updatedAt) - Date.parse(a.progress.updatedAt));
}

function isTerminalStage(stage: NormalizeRunStage): boolean {
  return stage === "completed" || stage === "failed";
}

export function writeRunProgress(progressPath: string, progress: NormalizeRunProgress): void {
  const existing = readRunProgress(progressPath);
  if (existing && isTerminalStage(existing.stage) && !isTerminalStage(progress.stage)) {
    return;
  }
  const content = JSON.stringify(progress, null, 2);
  const buffer = Buffer.from(content, "utf-8");
  const tempPath = progressPath + ".tmp";

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, progressPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}

export function readRunProgress(progressPath: string): NormalizeRunProgress | null {
  if (!fs.existsSync(progressPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || parsed.ok !== true) {
    throw new Error("Invalid normalize run progress artifact");
  }
  return parsed as NormalizeRunProgress;
}

/**
 * Generate the full normalize-request.json bundle.
 *
 * This bundle is the Agent Normalize Bundle Contract v1.
 * It contains file paths (not content), instruction context,
 * dataset schema reference, current state, and safety constraints.
 */
export function generateNormalizeRequestBundle(options: {
  taskId: string;
  runId: string;
  paths: RunPaths;
  inputDocuments: InputDocumentRef[];
  instructionContext: InstructionContext;
  currentState: CurrentState;
  candidateLinesRef?: CandidateLinesRef;
}): NormalizeRequestBundle {
  const { taskId, runId, paths, inputDocuments, instructionContext, currentState, candidateLinesRef } = options;

  const allowedReadPaths = [
    ...inputDocuments.map((d) => d.path),
    paths.schemaPath,
  ];
  if (candidateLinesRef) {
    allowedReadPaths.push(candidateLinesRef.path);
  }

  return {
    schemaVersion: "tts.normalize-request.v1",
    taskId,
    runId,
    createdAt: new Date().toISOString(),
    conversionGoal: "Convert enabled requirement documents into a prompt-structured voice production dataset.",
    instructionContext,
    inputDocuments,
    ...(candidateLinesRef ? { candidateLines: candidateLinesRef } : {}),
    datasetSchema: {
      name: "PromptStructuredProductionList",
      version: "2.0",
      path: paths.schemaPath,
    },
    currentState,
    outputContract: {
      draftPath: paths.draftPath,
      writeMode: "draft-file-then-server-commit",
    },
    safety: {
      allowedReadPaths,
      allowedWritePaths: [paths.draftPath],
      noSecrets: true,
    },
  };
}

/**
 * Write deterministic candidate lines for OpenCode input context.
 * These lines are not a commit source; the server only commits a validated raw
 * Prompt-Structured v2 draft authored by OpenCode.
 */
export function writeCandidateLinesArtifact(candidateLinesPath: string, candidateLines: CandidateLine[], voiceMetadata: VoiceMetadata[] = []): CandidateLinesRef {
  const content = JSON.stringify({
    schemaVersion: "tts.candidate-lines.v1",
    generatedAt: new Date().toISOString(),
    count: candidateLines.length,
    voiceMetadataCount: voiceMetadata.length,
    candidateLines,
    voiceMetadata,
  });
  const buffer = Buffer.from(content, "utf-8");
  const tempPath = candidateLinesPath + ".tmp";

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, candidateLinesPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }

  return {
    path: candidateLinesPath,
    count: candidateLines.length,
    contentPathType: "candidate-lines-v1",
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Write the normalize-request.json bundle to the run directory.
 * Uses atomic write (temp file + rename).
 */
export function writeNormalizeRequestBundle(bundle: NormalizeRequestBundle, requestPath: string): void {
  const content = JSON.stringify(bundle, null, 2);
  const buffer = Buffer.from(content, "utf-8");
  const tempPath = requestPath + ".tmp";

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, requestPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}

/**
 * Write the instruction.md file to the run directory.
 */
export function writeInstructionMarkdown(instructionPath: string, context: InstructionContext): void {
  const lines: string[] = [
    `# Normalize Instructions`,
    ``,
    `## Task`,
    `- Title: ${context.taskTitle}`,
    `- Description: ${context.taskDescription}`,
    `- Target Dataset: ${context.targetDatasetType}`,
    `- Language: ${context.language}`,
    ``,
    `## Conversion Goal`,
    `Convert the referenced requirement documents into a valid Prompt-Structured Production List v2.`,
    ``,
    `## Prompt-Structured Production List v2 Requirements`,
    `- Output schemaVersion must be "tts.production-list.v2".`,
    `- Output must contain top-level promptProfiles and lines arrays.`,
    `- Each prompt profile must contain non-empty audioProfile, scene, directorNotes, sampleContext, and 1 to 2 speakers.`,
    `- For every promptProfile, produce concise director-performance fields: style, pacing, accent, emotion, and performanceNotes.`,
    `- style is the overall performance style; pacing is speed/rhythm/pause pattern; accent is pronunciation/diction and may be empty when unsupported; emotion is the baseline tone; performanceNotes contains residual delivery guidance.`,
    `- Each line must contain transcript and promptProfileId; promptProfileId must reference an existing profile.`,
    `- A profile may be reused by many lines when role, scene, and delivery style are shared.`,
    `- Do not write placeholder prompt fields such as TODO, TBD, N/A, 待补充, 暂无, 空, or 无.`,
    `- text is only a compatibility alias for transcript and must match transcript if present.`,
    `- Derive line.speakerLabel, line.voice, and promptProfiles[].speakers from source section headings plus 声线/音色/角色/说话人/speaker/voice/character/role metadata.`,
    `- Multiple distinct source roles or voice metadata sections must not collapse to all Narrator/Zephyr. Voice names may be reused by reasonable groups, but speakerLabel and profile speakers must preserve role differences.`,
    `- Speaker limits are profile-scoped: each promptProfile may contain at most 2 speakers; the full dataset may contain different speakers across different profiles.`,
    `- Each promptProfile's speakers must match the role and voice metadata of the lines bound to that profile.`,
    `- Keep every line transcript/text clean: only words intended to be spoken belong there.`,
    `- Move stage directions, mood labels, bracketed delivery hints, and labels such as Style:, Pacing:, Accent:, Emotion:, Director's Notes:, Performance Notes:, 音色:, 风格:, 情绪:, 语速: out of transcript/text into line.style or promptOverride.`,
    `- Preserve line.style when it changes delivery for that line. Do not omit style merely because it is optional; avoid only repeated empty/default values.`,
    `- Do not invent unsupported inline audio tags and do not insert free-form tags into transcript. Use natural-language style fields unless a future allowlist explicitly enables tags.`,
    ``,
    `## Business Rules`,
    ...context.businessRules.map((rule, i) => `${i + 1}. ${rule}`),
    ``,
    `## User Instructions`,
    context.userInstruction || "(none provided)",
    ``,
    `## Safety`,
    `- Only read files listed in normalize-request.json safety.allowedReadPaths`,
    `- Only write to the file listed in safety.allowedWritePaths`,
    `- Never include API keys, tokens, or secrets in output`,
    `- Output must be valid JSON conforming to production-list.schema.json`,
  ];

  const content = lines.join("\n");
  const buffer = Buffer.from(content, "utf-8");
  const tempPath = instructionPath + ".tmp";

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, instructionPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}

/**
 * Read the draft file produced by the Agent.
 *
 * Returns null only when the draft file does not exist or is not valid JSON.
 * When the file IS valid JSON, returns the raw parsed object even if the
 * structure is wrong (missing "lines"/"speakers" or wrong types) -- the caller
 * is responsible for running RawAgentDraftSchema validation.
 *
 * R-M1-C: We no longer return null for structurally-wrong JSON (missing lines/speakers).
 * A parseable-but-schema-invalid draft must go through the raw validation gate
 * and be rejected with 422, NOT silently fall through to fallback.
 *
 * R-M1-D: We no longer return null for parseable primitive JSON (null, string, number,
 * boolean). Any parseable JSON value is an Agent draft attempt. Primitive/null values
 * will have empty lines/speakers arrays, which the raw validation gate will reject
 * with 422 (lines.min(1), speakers.min(1)). Only file-not-found and JSON parse errors
 * return null (genuine Agent/transport failures that warrant fallback).
 */
export function readNormalizeDraft(draftPath: string): {
  lines: unknown[];
  speakers: unknown[];
  promptProfiles: unknown[];
  directorProfiles: unknown[];
  metadata?: Record<string, unknown>;
  schemaVersion?: unknown;
} | null {
  if (!fs.existsSync(draftPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(draftPath, "utf-8");
    const parsed = JSON.parse(content);

    // R-M1-D: Any parseable JSON (including primitives/null) is an Agent draft attempt.
    // Only file-not-found (above) and JSON parse errors (below) return null.
    // Primitive/null values will result in empty lines/speakers, which the raw
    // validation gate (RawAgentDraftSchema) will reject with 422.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { lines: [], speakers: [], promptProfiles: [], directorProfiles: [] };
    }

    // R-M1-C: Return whatever lines/speakers the draft has (or empty arrays if
    // missing/wrong-type). The raw validation gate will catch missing/invalid fields.
    return {
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
      promptProfiles: Array.isArray(parsed.promptProfiles) ? parsed.promptProfiles : [],
      directorProfiles: Array.isArray(parsed.directorProfiles) ? parsed.directorProfiles : [],
      metadata: parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
        ? parsed.metadata as Record<string, unknown>
        : undefined,
      schemaVersion: parsed.schemaVersion,
    };
  } catch {
    // JSON parse error -- the draft is genuinely unparseable (Agent failure)
    return null;
  }
}

/**
 * Write the validation report artifact.
 */
export function writeValidationReport(
  validationReportPath: string,
  report: {
    valid: boolean;
    issues: Array<{ severity: string; code: string; message: string; field?: string; lineId?: string }>;
    stats: { totalLines: number; speakers: string[]; maxOrder: number };
    source: "agent-draft" | "agent-draft-raw" | "fallback-draft";
    businessQuality?: unknown;
  },
): void {
  const content = JSON.stringify(report, null, 2);
  const buffer = Buffer.from(content, "utf-8");
  const tempPath = validationReportPath + ".tmp";

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, validationReportPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}

/**
 * Write the commit result artifact.
 */
export function writeCommitResult(
  commitResultPath: string,
  result: {
    committed: boolean;
    newVersion?: number;
    lineCount?: number;
    speakerCount?: number;
    warnings?: string[];
    error?: string;
    runId: string;
    taskId: string;
    committedAt: string;
  },
): void {
  const content = JSON.stringify(result, null, 2);
  const buffer = Buffer.from(content, "utf-8");
  const tempPath = commitResultPath + ".tmp";

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, commitResultPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}

/**
 * Get the document artifact absolute path for a given task and document ID.
 * Returns the path whether or not the file exists.
 */
export function getDocumentArtifactPath(taskId: string, documentId: string): string {
  validateTaskId(taskId);
  // Sanitize: remove path separators, dots, and other dangerous characters
  const sanitizedDocId = documentId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const taskDir = getTaskDir(taskId);
  return path.join(taskDir, `document-${sanitizedDocId}.json`);
}

/**
 * Get the production list artifact absolute path.
 */
export function getProductionListArtifactPath(taskId: string): string {
  validateTaskId(taskId);
  const taskDir = getTaskDir(taskId);
  return path.join(taskDir, "production-list.json");
}

/**
 * Validate that a draft path belongs to the expected run directory.
 * Prevents reading drafts from arbitrary locations.
 */
export function validateDraftInRunDir(draftPath: string, runDir: string): void {
  const normalizedDraft = path.resolve(draftPath);
  const normalizedRunDir = path.resolve(runDir);
  if (!normalizedDraft.startsWith(normalizedRunDir + path.sep) &&
      normalizedDraft !== path.join(normalizedRunDir, "production-list.draft.json")) {
    throw new Error(`Draft path is not within the expected run directory`);
  }
}
