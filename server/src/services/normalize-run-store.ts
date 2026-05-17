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
import { formatVoiceGenderSelectionRulesForPrompt, formatVoiceSelectionGuideForPrompt } from "../utils/voice.js";

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
  | "timeout_recovery"
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
    voiceSelectionGuide: {
      policy: [
        "Choose a Gemini voice by matching source metadata, role, scene, emotion, transcript semantics, and the Google/Provider voice table gender when source gender is explicit. Candidate voice is a hint; explicit source voice metadata is stronger evidence.",
        formatVoiceGenderSelectionRulesForPrompt(),
      ].join("\n"),
      voices: formatVoiceSelectionGuideForPrompt(),
    },
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
    `# 标准化指令`,
    ``,
    `## 任务`,
    `- 标题：${context.taskTitle}`,
    `- 描述：${context.taskDescription}`,
    `- 目标数据集：${context.targetDatasetType}`,
    `- 输出语言：${context.language}`,
    ``,
    `## 转换目标`,
    `将引用的需求文档转换为合法的 Prompt-Structured Production List v2。`,
    `所有导演配置值必须使用简体中文；字段名、id、Gemini voice 名称、model 名称保持英文枚举。`,
    ``,
    `## Prompt-Structured Production List v2 要求`,
    `- 输出 schemaVersion 必须为 "tts.production-list.v2"。`,
    `- 输出必须包含顶层 promptProfiles 和 lines 数组。`,
    `- 每个 promptProfile 必须包含非空且为简体中文的 audioProfile、scene、directorNotes、sampleContext，以及 1 到 2 个 speakers。`,
    `- 每个 promptProfile 都应生成简洁中文导演表演字段：style、pacing、accent、emotion、performanceNotes。`,
    `- style 表示整体表演风格；pacing 表示速度、节奏和停顿；accent 表示发音/咬字要求；emotion 表示基础情绪；performanceNotes 保存其他表演指导。`,
    `- 每行必须包含 transcript 和 promptProfileId；promptProfileId 必须引用已存在的 profile。`,
    `- 当角色、场景和表演方式一致时，可以复用同一个 profile。`,
    `- 不要写入 TODO、TBD、N/A、待补充、暂无、空、无 等占位字段。`,
    `- text 只是 transcript 的兼容别名；如果出现，必须与 transcript trim 后一致。`,
    `- 音色选择必须匹配真实台词和角色语境，不能只使用默认值。候选行 voice 是提示；原文明确的 声线/音色 元数据优先级更高。`,
    `- 可用 Gemini 音色指南：`,
    formatVoiceSelectionGuideForPrompt(),
    formatVoiceGenderSelectionRulesForPrompt(),
    `- 只有在角色、章节标题、源元数据和台词都没有更好信号时，才使用 Zephyr 作为默认明亮兜底音色。`,
    `- 高能战斗/愤怒/紧急台词优先 Fenrir 或 Alnilam；长者/权威/讲解优先 Charon、Sadaltager、Rasalgethi 或 Orus；年轻/俏皮台词优先 Puck 或 Sadachbia；温柔/安抚台词优先 Achernar 或 Vindemiatrix；市井口语优先 Zubenelgenubi 或 Aoede。`,
    `- 从源章节标题以及 声线/音色/角色/说话人/speaker/voice/character/role 元数据中推导 line.speakerLabel、line.voice 和 promptProfiles[].speakers。`,
    `- 多个不同角色或音色元数据段不能全部塌缩为 旁白/Zephyr。音色名可以合理复用，但 speakerLabel 和 profile speakers 必须保留角色差异。`,
    `- 说话人限制是 profile 级别：每个 promptProfile 最多 2 个 speakers；完整数据集可通过多个 profiles 承载不同角色。`,
    `- 每个 promptProfile 的 speakers 必须匹配绑定到该 profile 的台词角色和音色元数据。`,
    `- 每行 transcript/text 必须保持干净：只放真正要朗读的词句。`,
    `- 将舞台说明、情绪标签、括号表演提示，以及 Style:, Pacing:, Accent:, Emotion:, Director's Notes:, Performance Notes:, 音色:, 风格:, 情绪:, 语速: 等标签移出 transcript/text，写入 line.style 或 promptOverride。`,
    `- 当 line.style 会改变该行表演时必须保留；不要因为可选就删掉明确风格，只避免重复空值/默认值。`,
    `- 不要发明不支持的内联音频标签，也不要把自由格式标签插入 transcript；请使用自然语言中文风格字段。`,
    ``,
    `## 业务规则`,
    ...context.businessRules.map((rule, i) => `${i + 1}. ${rule}`),
    ``,
    `## 用户指令`,
    context.userInstruction || "（未提供）",
    ``,
    `## 安全`,
    `- 只能读取 normalize-request.json 中 safety.allowedReadPaths 列出的文件。`,
    `- 只能写入 safety.allowedWritePaths 中列出的文件。`,
    `- 输出中绝不能包含 API keys、tokens 或 secrets。`,
    `- 输出必须是符合 production-list.schema.json 的合法 JSON。`,
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
