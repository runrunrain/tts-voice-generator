/**
 * Domain validators for Voice Production P0.
 *
 * Zod schemas for ProductionList, VoiceLine, DirectorProfile,
 * and related types. All write operations must pass through these validators.
 */

import { z } from "zod";

// ─── Voice Line ────────────────────────────────────────────────────────────────

export const VoiceLineSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().min(0),
  moduleName: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  speaker: z.string().min(1),
  speakerLabel: z.string().optional().nullable(),
  transcript: z.string().optional(),
  text: z.string().min(1),
  voice: z.string().min(1),
  style: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  status: z.enum(["pending", "approved", "generating", "generated", "failed"]).optional().default("pending"),
  model: z.string().min(1).optional().default("google/gemini-3.1-flash-tts-preview"),
  responseFormat: z.enum(["wav", "pcm", "mp3"]).optional().default("wav"),
  promptProfileId: z.string().optional().nullable(),
  promptOverride: z.record(z.unknown()).optional().nullable(),
  directorProfileId: z.string().optional().nullable(),
  directorOverrideJson: z.string().optional().nullable(),
  // Generation tracking fields
  generationStatus: z.enum(["draft", "ready", "pending", "running", "succeeded", "failed", "needs_revision"]).optional().default("draft"),
  relatedJobId: z.string().optional().nullable(),
  relatedAssetId: z.number().int().optional().nullable(),
  lastGenerationSignature: z.string().optional().nullable(),
  lastGenerationSnapshotJson: z.string().optional().nullable(),
  // Generation error tracking (persisted failure reason per line)
  generationErrorCode: z.string().optional().nullable(),
  generationErrorMessage: z.string().optional().nullable(),
});

export type VoiceLine = z.infer<typeof VoiceLineSchema>;

// ─── Speaker ───────────────────────────────────────────────────────────────────

export const SpeakerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  name: z.string().optional().default(""),
  voice: z.string().min(1),
  style: z.string().optional().default(""),
});

export type Speaker = z.infer<typeof SpeakerSchema>;

// ─── Production List ───────────────────────────────────────────────────────────

export const ProductionListSchema = z.object({
  schemaVersion: z.string().optional(),
  taskId: z.string().min(1),
  version: z.number().int().min(1),
  lines: z.array(VoiceLineSchema).min(0),
  speakers: z.array(SpeakerSchema),
  promptProfiles: z.array(z.record(z.unknown())).optional().default([]),
  directorProfiles: z.array(z.record(z.unknown())).optional().default([]),
  directorProfileId: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type ProductionList = z.infer<typeof ProductionListSchema>;

// ─── Director Profile Config ───────────────────────────────────────────────────

const DirectorStyleFieldsSchema = {
  style: z.string().optional().default(""),
  pacing: z.string().optional().default(""),
  accent: z.string().optional().default(""),
  emotion: z.string().optional().default(""),
  performanceNotes: z.string().optional().default(""),
};

const PromptDirectorStyleFieldsSchema = {
  style: z.string().optional().default(""),
  pacing: z.string().optional().default(""),
  accent: z.string().optional().default(""),
  emotion: z.string().optional().default(""),
  performanceNotes: z.string().optional().default(""),
};

export const DirectorConfigSchema = z.object({
  audioProfile: z.string().optional().default(""),
  scene: z.string().optional().default(""),
  directorNotes: z.string().optional().default(""),
  sampleContext: z.string().optional().default(""),
  ...DirectorStyleFieldsSchema,
  defaultVoice: z.string().optional().default("Zephyr"),
  defaultModel: z.string().optional().default("google/gemini-3.1-flash-tts-preview"),
  defaultFormat: z.enum(["wav", "pcm", "mp3"]).optional().default("wav"),
  speakers: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    name: z.string().optional().default(""),
    voice: z.string().min(1),
    style: z.string().optional().default(""),
  })).max(2).optional().default([]),
});

export type DirectorConfig = z.infer<typeof DirectorConfigSchema>;

export const DirectorProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().optional().default(""),
  config: DirectorConfigSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type DirectorProfile = z.infer<typeof DirectorProfileSchema>;

export const CreateDirectorProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional().default(""),
  config: DirectorConfigSchema.optional().default({}),
});

export type CreateDirectorProfile = z.infer<typeof CreateDirectorProfileSchema>;

export const UpdateDirectorProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  config: DirectorConfigSchema.optional(),
});

// ─── Task Schemas ──────────────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional().default(""),
});

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  status: z.enum(["draft", "ready", "running", "in_progress", "blocked", "completed", "failed", "archived"]).optional(),
});

// ─── Document Upload Safety Constants ──────────────────────────────────────────

/** Maximum document content size in bytes (512 KB) */
export const MAX_DOCUMENT_BYTES = 512 * 1024;

/** Allowed file extensions for uploaded/pasted requirement documents */
export const ALLOWED_DOCUMENT_EXTENSIONS = [".md", ".txt", ".markdown", ".text", ".mdx"];

/**
 * Check if a file name has an allowed extension for requirement documents.
 * Files without an extension are accepted (common for pasted content).
 */
export function hasAllowedDocumentExtension(fileName: string): boolean {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) return true; // No extension is OK for paste-style input
  const ext = fileName.toLowerCase().substring(lastDot);
  return ALLOWED_DOCUMENT_EXTENSIONS.includes(ext);
}

/**
 * Check that a file name does not contain path traversal or separator characters.
 */
export function hasNoPathTraversal(fileName: string): boolean {
  return !fileName.includes("/") && !fileName.includes("\\") && !fileName.includes("..");
}

// ─── Document Schemas ──────────────────────────────────────────────────────────

export const PasteDocumentSchema = z.object({
  fileName: z.string().min(1).max(255)
    .refine(hasNoPathTraversal, { message: "File name must not contain path separators or traversal sequences" })
    .refine(hasAllowedDocumentExtension, { message: `File extension not allowed. Allowed: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ")}` }),
  content: z.string().min(1)
    .refine((c) => Buffer.byteLength(c, "utf-8") <= MAX_DOCUMENT_BYTES,
      { message: `Document content exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes` }),
});

export const UploadDocumentBodySchema = z.object({
  fileName: z.string().min(1).max(255)
    .refine(hasNoPathTraversal, { message: "File name must not contain path separators or traversal sequences" })
    .refine(hasAllowedDocumentExtension, { message: `File extension not allowed. Allowed: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ")}` }),
  content: z.string().min(1)
    .refine((c) => Buffer.byteLength(c, "utf-8") <= MAX_DOCUMENT_BYTES,
      { message: `Document content exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes` }),
});

export const UpdateDocumentSchema = z.object({
  fileName: z.string().min(1).max(255)
    .refine(hasNoPathTraversal, { message: "File name must not contain path separators or traversal sequences" })
    .refine(hasAllowedDocumentExtension, { message: `File extension not allowed. Allowed: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ")}` })
    .optional(),
  content: z.string().min(1)
    .refine((c) => Buffer.byteLength(c, "utf-8") <= MAX_DOCUMENT_BYTES,
      { message: `Document content exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes` })
    .optional(),
  enabled: z.boolean().optional(),
  expectedVersion: z.number().int().min(1),
});

// ─── Validation Report ─────────────────────────────────────────────────────────

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  field?: string;
  lineId?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  stats: {
    totalLines: number;
    speakers: string[];
    maxOrder: number;
  };
}

// ─── Version Conflict ──────────────────────────────────────────────────────────

export const ProductionListPutSchema = z.object({
  expectedVersion: z.number().int().min(0),
  lines: z.array(VoiceLineSchema),
  speakers: z.array(SpeakerSchema),
  promptProfiles: z.array(z.record(z.unknown())).optional().default([]),
  directorProfiles: z.array(z.record(z.unknown())).optional().default([]),
  directorProfileId: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export const ProductionListPatchSchema = z.object({
  /** Allowed patch operations for domain-level changes */
  op: z.enum(["updateLine", "addLine", "removeLine", "reorderLines", "updateSpeakers", "updateDirectorProfile"]),
  payload: z.record(z.unknown()),
  expectedVersion: z.number().int().min(0),
});

// ─── Agent Button ──────────────────────────────────────────────────────────────

export const ExecuteButtonSchema = z.object({
  targetLineId: z.string().min(1).optional(),
  automationSessionId: z.string().min(1).optional(),
  target: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("line"), lineId: z.string().min(1) }),
    z.object({ scope: z.literal("selection"), lineIds: z.array(z.string().min(1)).min(1) }),
    z.object({ scope: z.literal("list") }),
    z.object({ scope: z.literal("task") }),
  ]).optional(),
  expectedVersion: z.number().int().min(1),
  parameters: z.record(z.unknown()).optional().default({}),
}).refine((value) => Boolean(value.targetLineId || value.target), {
  message: "Either targetLineId or target is required.",
  path: ["target"],
});

// ─── Normalize Requirements ────────────────────────────────────────────────────

export const NormalizeRequirementsResultSchema = z.object({
  runner: z.enum(["opencode", "fallback"]),
  productionList: ProductionListSchema,
  warnings: z.array(z.object({
    code: z.string(),
    message: z.string(),
  })),
});

/**
 * Request body schema for the normalize-requirements endpoint.
 * All fields are optional -- the endpoint works without a body for backward compatibility.
 * When provided, instruction and documentIds allow the caller to customize the Agent bundle.
 */
export const NormalizeRequestBodySchema = z.object({
  /** Non-breaking async start mode for progress polling */
  async: z.boolean().optional(),
  responseMode: z.enum(["sync", "async"]).optional(),
  /** Quality-priority mode extends OpenCode timeout budget without relaxing gates */
  qualityPriority: z.boolean().optional(),
  /** User-provided instruction supplementing the task context */
  instruction: z.string().max(2000).optional(),
  /** Specific document IDs to include (must belong to this task and be enabled) */
  documentIds: z.array(z.string().uuid()).max(20).optional(),
  /** Expected current production list version for conflict detection */
  expectedVersion: z.number().int().min(0).optional(),
});

// ─── Generation Bridge ──────────────────────────────────────────────────────────

export const GenerateFromListSchema = z.object({
  /** Optional version check; if omitted, no version conflict check is performed. */
  expectedVersion: z.number().int().min(0).optional(),
  /** Explicit line IDs to generate. If omitted/empty, all eligible lines are selected. */
  lineIds: z.array(z.string().min(1)).optional().default([]),
  /** Whether to skip lines already in succeeded/running state. Default true. */
  skipCompleted: z.boolean().optional().default(true),
  /** Explicitly regenerate succeeded lines even when their last input signature is unchanged. */
  forceRegenerate: z.boolean().optional().default(false),
  /**
   * Request source: "user" (frontend), "agent" (OpenCode plugin), "cli" (CLI tool).
   * Default "user". Non-user sources require explicit confirm=true to proceed.
   */
  source: z.enum(["user", "agent", "cli"]).optional().default("user"),
  /**
   * Explicit cost confirmation. Required when source is "agent" or "cli".
   * When true, the caller confirms they are intentionally triggering a real cost action.
   * Default false to prevent silent cost triggers from automated sources.
   */
  confirm: z.boolean().optional().default(false),
});

export type GenerateFromListRequest = z.infer<typeof GenerateFromListSchema>;

export type LineGenerationStatus = "draft" | "ready" | "pending" | "running" | "succeeded" | "failed" | "needs_revision";

export interface LineGenerationResult {
  lineId: string;
  status: "succeeded" | "failed" | "skipped";
  jobId?: string | null;
  assetId?: number | null;
  audioUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface GenerateFromListResponse {
  taskId: string;
  version: number;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  results: LineGenerationResult[];
}

// ─── Chat Message ──────────────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional().default({}),
});

// ─── OpenCode Session ──────────────────────────────────────────────────────────

export const CreateOpenCodeSessionSchema = z.object({
  sessionType: z.enum(["automation", "chat"]),
  metadata: z.record(z.unknown()).optional().default({}),
  taskId: z.string().nullable().optional(),
});

// ─── Raw Agent Draft Strict Schema ────────────────────────────────────────────
//
// R-M1: These schemas enforce that the raw Agent draft has all required fields
// BEFORE any normalization/synthesis. They validate the draft as-is from the
// Agent output, without any default synthesis or fixing.
// Missing voice, empty speakers, invalid order, etc. must all fail here.

/** Strict raw draft voice line: requires non-empty id, integer order, non-empty speaker/text/voice */
const RawDraftLineSchema = z.object({
  id: z.string().min(1, "Line id is required"),
  order: z.number({ required_error: "Line order is required", invalid_type_error: "Line order must be a number" }).int("Line order must be an integer"),
  speaker: z.string().min(1, "Line speaker is required"),
  text: z.string().min(1, "Line text is required"),
  voice: z.string().min(1, "Line voice is required"),
});

/** Strict raw draft speaker: requires non-empty id, label, voice */
const RawDraftSpeakerSchema = z.object({
  id: z.string().min(1, "Speaker id is required"),
  label: z.string().min(1, "Speaker label is required"),
  voice: z.string().min(1, "Speaker voice is required"),
});

/** Strict raw draft top-level: lines must be array, speakers must be non-empty array */
export const RawAgentDraftSchema = z.object({
  lines: z.array(RawDraftLineSchema).min(1, "Draft must have at least one line"),
  speakers: z.array(RawDraftSpeakerSchema).min(1, "Draft must have at least one speaker"),
});

export type RawAgentDraft = z.infer<typeof RawAgentDraftSchema>;

// ─── Prompt-Structured Production List v2 Raw Agent Draft ─────────────────────

const NonEmptyTrimmedString = z.string().refine((value) => value.trim().length > 0, {
  message: "Field must be a non-empty string after trimming",
});

export const PromptSpeakerSchema = z.object({
  id: NonEmptyTrimmedString,
  label: NonEmptyTrimmedString,
  name: z.string().optional(),
  voice: NonEmptyTrimmedString,
  style: z.string().optional(),
}).passthrough();

export const PromptOverrideSchema = z.object({
  audioProfile: z.string().optional(),
  scene: z.string().optional(),
  directorNotes: z.string().optional(),
  sampleContext: z.string().optional(),
  style: z.string().optional(),
  pacing: z.string().optional(),
  accent: z.string().optional(),
  emotion: z.string().optional(),
  performanceNotes: z.string().optional(),
  speakers: z.array(PromptSpeakerSchema).min(1).max(2).optional(),
}).passthrough();

export const PromptProfileSchema = z.object({
  id: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  description: z.string().optional(),
  audioProfile: NonEmptyTrimmedString,
  scene: NonEmptyTrimmedString,
  directorNotes: NonEmptyTrimmedString,
  sampleContext: NonEmptyTrimmedString,
  ...PromptDirectorStyleFieldsSchema,
  speakers: z.array(PromptSpeakerSchema).min(1, "Profile must have at least one speaker").max(2, "Profile supports at most 2 speakers"),
  reusePolicy: z.enum(["one-line", "many-lines"]).optional(),
  sourceDocumentIds: z.array(z.string()).optional(),
}).passthrough();

export const PromptStructuredLineSchema = z.object({
  id: NonEmptyTrimmedString,
  order: z.number({ required_error: "Line order is required", invalid_type_error: "Line order must be a number" }).int().min(0),
  speaker: NonEmptyTrimmedString,
  moduleName: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  speakerLabel: z.string().optional(),
  transcript: NonEmptyTrimmedString,
  text: z.string().optional(),
  promptProfileId: NonEmptyTrimmedString,
  directorProfileId: z.string().optional().nullable(),
  promptOverride: PromptOverrideSchema.optional().nullable(),
  directorOverrideJson: z.string().optional().nullable(),
  voice: NonEmptyTrimmedString,
  model: z.string().optional(),
  responseFormat: z.enum(["wav", "pcm", "mp3"]).optional(),
  notes: z.string().optional(),
  style: z.string().max(500, "Line style must be concise and must not contain transcript text").optional(),
  generationStatus: z.enum(["draft", "ready", "pending", "running", "succeeded", "failed", "needs_revision"]).optional(),
  lastGenerationSignature: z.string().optional().nullable(),
  lastGenerationSnapshotJson: z.string().optional().nullable(),
}).passthrough();

export const RawPromptStructuredAgentDraftSchema = z.object({
  schemaVersion: z.string().optional(),
  taskId: z.string().optional(),
  sourceRevision: z.record(z.unknown()).optional(),
  promptProfiles: z.array(PromptProfileSchema).min(1, "Draft must include at least one prompt profile"),
  directorProfiles: z.array(PromptProfileSchema).optional(),
  speakers: z.array(PromptSpeakerSchema).optional(),
  lines: z.array(PromptStructuredLineSchema).min(1, "Draft must include at least one line"),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

export type PromptSpeaker = z.infer<typeof PromptSpeakerSchema>;
export type PromptOverride = z.infer<typeof PromptOverrideSchema>;
export type PromptProfile = z.infer<typeof PromptProfileSchema>;
export type PromptStructuredLine = z.infer<typeof PromptStructuredLineSchema>;
export type RawPromptStructuredAgentDraft = z.infer<typeof RawPromptStructuredAgentDraftSchema>;

export type QualityIssueSeverity = "warning" | "blocking";

export type QualityIssueCode =
  | "TRANSCRIPT_METADATA_SOURCE"
  | "TRANSCRIPT_METADATA_TITLE"
  | "TRANSCRIPT_METADATA_SCRAPE_TIME"
  | "TRANSCRIPT_LABEL_ONLY"
  | "TRANSCRIPT_FIELD_LABEL_PREFIX"
  | "TRANSCRIPT_URL_ONLY"
  | "TRANSCRIPT_EMPTY_OR_PUNCTUATION_ONLY"
  | "TRANSCRIPT_SECTION_MARKER"
  | "TRANSCRIPT_PROMPT_STRUCTURE_POLLUTION"
  | "TRANSCRIPT_NON_SPEECH_DESCRIPTION"
  | "LOW_CANDIDATE_COVERAGE"
  | "MISSING_PROMPT_PROFILES"
  | "INVALID_PROMPT_PROFILE_BINDING"
  | "PROFILE_CONTENT_TOO_WEAK"
  | "ROLE_VOICE_COLLAPSE";

export interface QualityIssue {
  code: QualityIssueCode;
  severity: QualityIssueSeverity;
  message: string;
  lineId?: string;
  lineIndex?: number;
  transcriptSample?: string;
  expected?: string;
  actual?: string;
}

export interface BusinessQualityReport {
  passed: boolean;
  issueCount: number;
  blockingIssueCount: number;
  warningIssueCount: number;
  candidateLineCount: number;
  producedLineCount: number;
  candidateCoverageRatio: number | null;
  issues: QualityIssue[];
}

const PROMPT_PLACEHOLDER_VALUES = new Set([
  "todo",
  "tbd",
  "placeholder",
  "n/a",
  "na",
  "none",
  "null",
  "占位",
  "占位符",
  "待补充",
  "待定",
  "空",
  "暂无",
  "无",
]);

const PROMPT_STYLE_FIELD_NAMES = ["style", "pacing", "accent", "emotion", "performanceNotes"] as const;

type PromptStyleFieldName = typeof PROMPT_STYLE_FIELD_NAMES[number];

const PROMPT_PLACEHOLDER_EDGE_CHARS = /^[\s"'“”‘’`【】\[\]（）(){}<>《》]+|[\s"'“”‘’`【】\[\]（）(){}<>《》，,。.!！?？:：;；]+$/g;

function normalizePromptPlaceholderValue(value: string): string {
  return value.trim().toLowerCase().replace(PROMPT_PLACEHOLDER_EDGE_CHARS, "");
}

function isPlaceholderPromptValue(value: string): boolean {
  const normalized = normalizePromptPlaceholderValue(value);
  return PROMPT_PLACEHOLDER_VALUES.has(normalized);
}

function readPromptStyleField(source: unknown, field: PromptStyleFieldName): string | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasSemanticTranscript(value: string): boolean {
  return /[A-Za-z0-9\u4e00-\u9fff\u3400-\u4dbf]/.test(value.trim());
}

function truncateTranscriptSample(value: string): string {
  return value.trim().slice(0, 160);
}

function classifyTranscriptQualityIssue(transcript: string): QualityIssueCode | null {
  const normalized = transcript.trim();
  if (!normalized || !hasSemanticTranscript(normalized)) return "TRANSCRIPT_EMPTY_OR_PUNCTUATION_ONLY";
  if (/^(?:style|pacing|accent|emotion|director(?:'s|s)?\s+notes|performance\s+notes|audio\s+profile|sample\s+context)\s*[：:].+$/i.test(normalized)) {
    return "TRANSCRIPT_PROMPT_STRUCTURE_POLLUTION";
  }
  if (/^(?:风格|语速|节奏|口音|发音|情绪|导演备注|表演备注|音频档案|场景|示例上下文)\s*[：:].+$/i.test(normalized)) {
    return "TRANSCRIPT_PROMPT_STRUCTURE_POLLUTION";
  }
  if (/^#{1,6}\s*(?:audio\s+profile|the\s+scene|director(?:'s|s)?\s+notes|sample\s+context|transcript)\b/i.test(normalized)) {
    return "TRANSCRIPT_PROMPT_STRUCTURE_POLLUTION";
  }
  if (/^#{1,6}\s*(?:音频档案|场景|导演备注|表演备注|示例上下文|台词|对白)\b/i.test(normalized)) {
    return "TRANSCRIPT_PROMPT_STRUCTURE_POLLUTION";
  }
  if (/(?:^|\n)#{3,4}\s*(?:DIRECTOR(?:'S|S)?\s+NOTES|TRANSCRIPT|SAMPLE\s+CONTEXT)\b/i.test(normalized)) {
    return "TRANSCRIPT_PROMPT_STRUCTURE_POLLUTION";
  }
  if (/^https?:\/\/\S+$/i.test(normalized)) return "TRANSCRIPT_URL_ONLY";
  if (/^(?:来源|出处|数据来源|source|url|link|链接)\s*[：:].*$/i.test(normalized)) return "TRANSCRIPT_METADATA_SOURCE";
  if (/^(?:标题|题目|title)\s*[：:].*$/i.test(normalized)) return "TRANSCRIPT_METADATA_TITLE";
  if (/^(?:抓取时间|采集时间|爬取时间|发布时间|更新时间|创建时间|scrape\s*time|crawl\s*time|published\s*at|updated\s*at)\s*[：:].*$/i.test(normalized)) {
    return "TRANSCRIPT_METADATA_SCRAPE_TIME";
  }
  if (/^(?:第\s*[一二三四五六七八九十百千万\d]+\s*[章节幕集段]|章节|小节|模块|场景|section|chapter|part)\s*([：:].*)?$/i.test(normalized)) {
    return "TRANSCRIPT_SECTION_MARKER";
  }
  if (/^(?:台词|对白|文本|内容|声线|音色|角色|说话人|speaker|voice|voice\s*name|character|role)\s*[：:]\s*$/i.test(normalized)) {
    return "TRANSCRIPT_LABEL_ONLY";
  }
  if (/^(?:台词|对白|文本|内容|transcript|line|text)\s*[：:].+$/i.test(normalized)) {
    return "TRANSCRIPT_FIELD_LABEL_PREFIX";
  }
  if (/^(?:声线|音色|角色|说话人|speaker|voice|voice\s*name|character|role)\s*[：:].+$/i.test(normalized)) {
    return "TRANSCRIPT_LABEL_ONLY";
  }
  if (/^(?:以下是|下面是|本段内容|本文内容|整理后|整理如下|章节说明|备注|说明)\b.*(?:台词|对白|内容|整理|来源|说明)/i.test(normalized)) {
    return "TRANSCRIPT_NON_SPEECH_DESCRIPTION";
  }
  return null;
}

export function validateBusinessQualityGate(options: {
  draft: RawPromptStructuredAgentDraft;
  candidateLineCount: number;
  voiceMetadataCount?: number;
}): BusinessQualityReport {
  const issues: QualityIssue[] = [];
  const candidateLineCount = Math.max(0, Math.floor(options.candidateLineCount));
  const producedLineCount = options.draft.lines.length;
  const candidateCoverageRatio = candidateLineCount > 0 ? producedLineCount / candidateLineCount : null;
  const voiceMetadataCount = Math.max(0, Math.floor(options.voiceMetadataCount ?? 0));

  if (options.draft.promptProfiles.length === 0) {
    issues.push({
      code: "MISSING_PROMPT_PROFILES",
      severity: "blocking",
      message: "Draft must include at least one prompt profile before production commit.",
      expected: "promptProfiles.length >= 1",
      actual: "0",
    });
  }

  const profileIds = new Set(options.draft.promptProfiles.map((profile) => profile.id.trim()));
  for (const [index, line] of options.draft.lines.entries()) {
    const transcript = line.transcript.trim();
    const code = classifyTranscriptQualityIssue(transcript);
    if (code) {
      issues.push({
        code,
        severity: "blocking",
        message: `Line "${line.id}" transcript appears to be metadata, a field label, or non-speech content and cannot be committed.`,
        lineId: line.id,
        lineIndex: index,
        transcriptSample: truncateTranscriptSample(transcript),
      });
    }

    if (!profileIds.has(line.promptProfileId.trim())) {
      issues.push({
        code: "INVALID_PROMPT_PROFILE_BINDING",
        severity: "blocking",
        message: `Line "${line.id}" references prompt profile "${line.promptProfileId}" that is not present in promptProfiles.`,
        lineId: line.id,
        lineIndex: index,
        expected: "promptProfileId present in promptProfiles",
        actual: line.promptProfileId,
      });
    }

    const lineStyle = typeof line.style === "string" ? line.style : "";
    if (lineStyle.trim() && isPlaceholderPromptValue(lineStyle)) {
      issues.push({
        code: "PROFILE_CONTENT_TOO_WEAK",
        severity: "blocking",
        message: `Line "${line.id}" field "style" uses a placeholder value and cannot enter the final prompt.`,
        lineId: line.id,
        lineIndex: index,
        expected: "specific non-placeholder line style or empty string",
        actual: lineStyle,
      });
    }

    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const overrideValue = readPromptStyleField(line.promptOverride, field);
      if (overrideValue?.trim() && isPlaceholderPromptValue(overrideValue)) {
        issues.push({
          code: "PROFILE_CONTENT_TOO_WEAK",
          severity: "blocking",
          message: `Line "${line.id}" promptOverride field "${field}" uses a placeholder value and cannot enter the final prompt.`,
          lineId: line.id,
          lineIndex: index,
          expected: "specific non-placeholder override content or empty string",
          actual: overrideValue,
        });
      }
    }

    const directorOverride = parseJsonRecord(line.directorOverrideJson);
    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const overrideValue = readPromptStyleField(directorOverride, field);
      if (overrideValue?.trim() && isPlaceholderPromptValue(overrideValue)) {
        issues.push({
          code: "PROFILE_CONTENT_TOO_WEAK",
          severity: "blocking",
          message: `Line "${line.id}" directorOverrideJson field "${field}" uses a placeholder value and cannot enter the final prompt.`,
          lineId: line.id,
          lineIndex: index,
          expected: "specific non-placeholder override content or empty string",
          actual: overrideValue,
        });
      }
    }
  }

  for (const profile of options.draft.promptProfiles) {
    for (const field of ["audioProfile", "scene", "directorNotes", "sampleContext"] as const) {
      if (profile[field].trim().length < 6 || isPlaceholderPromptValue(profile[field])) {
        issues.push({
          code: "PROFILE_CONTENT_TOO_WEAK",
          severity: "blocking",
          message: `Prompt profile "${profile.id}" field "${field}" is too weak for production quality commit.`,
          expected: "specific non-placeholder content",
          actual: profile[field],
        });
      }
    }
    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const value = typeof profile[field] === "string" ? profile[field] : "";
      if (value.trim() && isPlaceholderPromptValue(value)) {
        issues.push({
          code: "PROFILE_CONTENT_TOO_WEAK",
          severity: "blocking",
          message: `Prompt profile "${profile.id}" field "${field}" uses a placeholder value and cannot enter the final prompt.`,
          expected: "specific non-placeholder style content or empty string",
          actual: value,
        });
      }
    }
    for (const speaker of profile.speakers) {
      if (speaker.style?.trim() && isPlaceholderPromptValue(speaker.style)) {
        issues.push({
          code: "PROFILE_CONTENT_TOO_WEAK",
          severity: "blocking",
          message: `Prompt profile "${profile.id}" speaker "${speaker.id}" field "style" uses a placeholder value and cannot enter the final prompt.`,
          expected: "specific non-placeholder speaker style or empty string",
          actual: speaker.style,
        });
      }
    }
  }

  for (const profile of options.draft.directorProfiles ?? []) {
    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const value = typeof profile[field] === "string" ? profile[field] : "";
      if (value.trim() && isPlaceholderPromptValue(value)) {
        issues.push({
          code: "PROFILE_CONTENT_TOO_WEAK",
          severity: "blocking",
          message: `Director profile "${profile.id}" field "${field}" uses a placeholder value and cannot enter the final prompt.`,
          expected: "specific non-placeholder style content or empty string",
          actual: value,
        });
      }
    }
    for (const speaker of profile.speakers) {
      if (speaker.style?.trim() && isPlaceholderPromptValue(speaker.style)) {
        issues.push({
          code: "PROFILE_CONTENT_TOO_WEAK",
          severity: "blocking",
          message: `Director profile "${profile.id}" speaker "${speaker.id}" field "style" uses a placeholder value and cannot enter the final prompt.`,
          expected: "specific non-placeholder speaker style or empty string",
          actual: speaker.style,
        });
      }
    }
  }

  if (candidateLineCount >= 10 && candidateCoverageRatio !== null) {
    if (candidateCoverageRatio < 0.1) {
      issues.push({
        code: "LOW_CANDIDATE_COVERAGE",
        severity: "blocking",
        message: `Draft produced ${producedLineCount} line(s) from ${candidateLineCount} candidates; coverage is too low for safe production commit.`,
        expected: ">= 10% candidate coverage",
        actual: `${Math.round(candidateCoverageRatio * 100)}%`,
      });
    } else if (candidateCoverageRatio < 0.3) {
      issues.push({
        code: "LOW_CANDIDATE_COVERAGE",
        severity: "warning",
        message: `Draft produced ${producedLineCount} line(s) from ${candidateLineCount} candidates; coverage is lower than expected.`,
        expected: ">= 30% candidate coverage",
        actual: `${Math.round(candidateCoverageRatio * 100)}%`,
      });
    }
  }

  if (voiceMetadataCount >= 2 && producedLineCount >= 2) {
    const normalizedLineLabels = new Set(
      options.draft.lines.map((line) => (line.speakerLabel ?? line.speaker).trim()).filter(Boolean),
    );
    const normalizedLineVoices = new Set(
      options.draft.lines.map((line) => line.voice.trim()).filter(Boolean),
    );
    const profileSpeakerSignatures = new Set(
      options.draft.promptProfiles.flatMap((profile) => profile.speakers.map((speaker) => `${speaker.label.trim()}|${speaker.voice.trim()}`)),
    );
    if (normalizedLineLabels.size <= 1 && normalizedLineVoices.size <= 1 && profileSpeakerSignatures.size <= 1) {
      issues.push({
        code: "ROLE_VOICE_COLLAPSE",
        severity: "blocking",
        message: "Input contains multiple role or voice metadata sections, but the draft collapsed all line speakerLabel, line voice, and profile speakers to one identity.",
        expected: "multiple role-aware speaker labels, voices, or profile speaker identities derived from source metadata",
        actual: `voiceMetadataCount=${voiceMetadataCount}, lineSpeakerLabels=${normalizedLineLabels.size}, lineVoices=${normalizedLineVoices.size}, profileSpeakerIdentities=${profileSpeakerSignatures.size}`,
      });
    }
  }

  const blockingIssueCount = issues.filter((issue) => issue.severity === "blocking").length;
  const warningIssueCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    passed: blockingIssueCount === 0,
    issueCount: issues.length,
    blockingIssueCount,
    warningIssueCount,
    candidateLineCount,
    producedLineCount,
    candidateCoverageRatio,
    issues,
  };
}

// ─── Validation Functions ──────────────────────────────────────────────────────

/**
 * Validate a raw Agent draft against the strict schema (Zod parse + domain rules).
 *
 * This is the R-M1 gate: the raw draft is validated as-is from Agent output,
 * without any synthesis of default values. Missing required fields (voice, id,
 * order, speaker, text) or empty speakers cause immediate failure.
 *
 * Returns a ValidationReport with schema parse errors and domain validation issues.
 */
export function validateRawAgentDraft(rawDraft: {
  lines: unknown[];
  speakers: unknown[];
}): ValidationReport {
  const issues: ValidationIssue[] = [];

  // Step 1: Strict Zod schema parse
  const schemaResult = RawAgentDraftSchema.safeParse(rawDraft);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      const fieldPath = issue.path.join(".");
      issues.push({
        severity: "error",
        code: "RAW_DRAFT_SCHEMA_PARSE_FAILED",
        message: `Schema validation failed at ${fieldPath || "root"}: ${issue.message}`,
        field: fieldPath || undefined,
      });
    }
    // Schema parse failed -- return immediately, no business validation needed
    return {
      valid: false,
      issues,
      stats: { totalLines: 0, speakers: [], maxOrder: -1 },
    };
  }

  // Step 2: Schema parse passed. Run business validation on the parsed data.
  // The parsed data is now guaranteed to have all required fields with correct types.
  // Cast through unknown to VoiceLine[] / Speaker[] since Zod parse guarantees
  // the required fields exist but doesn't add optional defaults that the types expect.
  return validateProductionList({
    lines: schemaResult.data.lines as unknown as VoiceLine[],
    speakers: schemaResult.data.speakers as unknown as Speaker[],
  });
}

/**
 * Validate the Agent normalize main-path draft as Prompt-Structured Production List v2.
 *
 * This gate is intentionally stricter than legacy ProductionList validation:
 * every Agent-produced line must bind to an explicit prompt profile containing
 * audioProfile, scene, directorNotes, sampleContext, speakers, and a line-level
 * transcript. Invalid parseable drafts return a failed report and must not be
 * normalized, fixed, or committed by callers.
 */
export function validateRawPromptStructuredAgentDraft(rawDraft: unknown): ValidationReport {
  const issues: ValidationIssue[] = [];
  const schemaResult = RawPromptStructuredAgentDraftSchema.safeParse(rawDraft);

  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      const fieldPath = issue.path.join(".");
      let code = "RAW_PROMPT_STRUCTURED_SCHEMA_PARSE_FAILED";
      if (fieldPath === "promptProfiles" || fieldPath.startsWith("promptProfiles.")) {
        code = "MISSING_PROMPT_PROFILES";
      }
      if (/audioProfile|scene|directorNotes|sampleContext/.test(fieldPath)) {
        code = "INCOMPLETE_PROMPT_PROFILE";
      }
      if (fieldPath.includes("promptProfileId")) {
        code = "MISSING_PROMPT_PROFILE_BINDING";
      }
      if (fieldPath.includes("transcript")) {
        code = "EMPTY_TRANSCRIPT";
      }
      issues.push({
        severity: "error",
        code,
        message: `Prompt-structured draft validation failed at ${fieldPath || "root"}: ${issue.message}`,
        field: fieldPath || undefined,
      });
    }
    return {
      valid: false,
      issues,
      stats: { totalLines: 0, speakers: [], maxOrder: -1 },
    };
  }

  const draft = schemaResult.data;
  const profileIds = new Set<string>();
  const profileById = new Map<string, PromptProfile>();

  for (const profile of draft.promptProfiles) {
    const profileId = profile.id.trim();
    if (profileIds.has(profileId)) {
      issues.push({
        severity: "error",
        code: "DUPLICATE_PROMPT_PROFILE_ID",
        message: `Duplicate prompt profile id "${profileId}"`,
        field: `promptProfiles[${profileId}].id`,
      });
    }
    profileIds.add(profileId);
    profileById.set(profileId, profile);

    for (const field of ["audioProfile", "scene", "directorNotes", "sampleContext"] as const) {
      if (isPlaceholderPromptValue(profile[field])) {
        issues.push({
          severity: "error",
          code: "PLACEHOLDER_PROMPT_FIELD",
          message: `Prompt profile "${profileId}" field "${field}" uses a placeholder value`,
          field: `promptProfiles[${profileId}].${field}`,
        });
      }
    }

    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const value = profile[field];
      if (value.trim() && isPlaceholderPromptValue(value)) {
        issues.push({
          severity: "error",
          code: "PLACEHOLDER_PROMPT_FIELD",
          message: `Prompt profile "${profileId}" field "${field}" uses a placeholder value`,
          field: `promptProfiles[${profileId}].${field}`,
        });
      }
    }

    for (const speaker of profile.speakers) {
      if (speaker.style?.trim() && isPlaceholderPromptValue(speaker.style)) {
        issues.push({
          severity: "error",
          code: "PLACEHOLDER_PROMPT_FIELD",
          message: `Prompt profile "${profileId}" speaker "${speaker.id}" field "style" uses a placeholder value`,
          field: `promptProfiles[${profileId}].speakers[${speaker.id}].style`,
        });
      }
    }

    if (profile.speakers.length < 1 || profile.speakers.length > 2) {
      issues.push({
        severity: "error",
        code: "INVALID_PROMPT_SPEAKER_COUNT",
        message: `Prompt profile "${profileId}" must define 1 to 2 speakers`,
        field: `promptProfiles[${profileId}].speakers`,
      });
    }

  }

  for (const profile of draft.directorProfiles ?? []) {
    const profileId = profile.id.trim();
    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const value = profile[field];
      if (value.trim() && isPlaceholderPromptValue(value)) {
        issues.push({
          severity: "error",
          code: "PLACEHOLDER_PROMPT_FIELD",
          message: `Director profile "${profileId}" field "${field}" uses a placeholder value`,
          field: `directorProfiles[${profileId}].${field}`,
        });
      }
    }

    for (const speaker of profile.speakers) {
      if (speaker.style?.trim() && isPlaceholderPromptValue(speaker.style)) {
        issues.push({
          severity: "error",
          code: "PLACEHOLDER_PROMPT_FIELD",
          message: `Director profile "${profileId}" speaker "${speaker.id}" field "style" uses a placeholder value`,
          field: `directorProfiles[${profileId}].speakers[${speaker.id}].style`,
        });
      }
    }
  }

  const orders = draft.lines.map((line) => line.order);
  if (new Set(orders).size !== orders.length) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_LINE_ORDER",
      message: "Line orders must be unique",
      field: "lines.order",
    });
  }

  for (const line of draft.lines) {
    const transcript = line.transcript.trim();
    if (!hasSemanticTranscript(transcript)) {
      issues.push({
        severity: "error",
        code: "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT",
        message: `Line "${line.id}" has transcript without semantic content`,
        field: `lines[${line.id}].transcript`,
        lineId: line.id,
      });
    }

    if (line.style?.trim() && isPlaceholderPromptValue(line.style)) {
      issues.push({
        severity: "error",
        code: "PLACEHOLDER_PROMPT_FIELD",
        message: `Line "${line.id}" field "style" uses a placeholder value`,
        field: `lines[${line.id}].style`,
        lineId: line.id,
      });
    }

    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const overrideValue = readPromptStyleField(line.promptOverride, field);
      if (overrideValue?.trim() && isPlaceholderPromptValue(overrideValue)) {
        issues.push({
          severity: "error",
          code: "PLACEHOLDER_PROMPT_FIELD",
          message: `Line "${line.id}" promptOverride field "${field}" uses a placeholder value`,
          field: `lines[${line.id}].promptOverride.${field}`,
          lineId: line.id,
        });
      }
    }

    const directorOverride = parseJsonRecord(line.directorOverrideJson);
    for (const field of PROMPT_STYLE_FIELD_NAMES) {
      const overrideValue = readPromptStyleField(directorOverride, field);
      if (overrideValue?.trim() && isPlaceholderPromptValue(overrideValue)) {
        issues.push({
          severity: "error",
          code: "PLACEHOLDER_PROMPT_FIELD",
          message: `Line "${line.id}" directorOverrideJson field "${field}" uses a placeholder value`,
          field: `lines[${line.id}].directorOverrideJson.${field}`,
          lineId: line.id,
        });
      }
    }

    if (typeof line.text === "string" && line.text.trim() !== transcript) {
      issues.push({
        severity: "error",
        code: "LINE_TEXT_TRANSCRIPT_MISMATCH",
        message: `Line "${line.id}" has text that differs from transcript`,
        field: `lines[${line.id}].text`,
        lineId: line.id,
      });
    }

    const profile = profileById.get(line.promptProfileId.trim());
    if (!profile) {
      issues.push({
        severity: "error",
        code: "UNKNOWN_PROMPT_PROFILE_REFERENCE",
        message: `Line "${line.id}" references unknown prompt profile "${line.promptProfileId}"`,
        field: `lines[${line.id}].promptProfileId`,
        lineId: line.id,
      });
      continue;
    }

    const speakerIds = new Set(profile.speakers.map((speaker) => speaker.id.trim()));
    if (!speakerIds.has(line.speaker.trim())) {
      issues.push({
        severity: "error",
        code: "INVALID_LINE_SPEAKER_FOR_PROFILE",
        message: `Line "${line.id}" speaker "${line.speaker}" is not defined by prompt profile "${profile.id}"`,
        field: `lines[${line.id}].speaker`,
        lineId: line.id,
      });
    }
  }

  const speakerLabels = Array.from(new Set(
    draft.promptProfiles.flatMap((profile) => profile.speakers.map((speaker) => speaker.label)),
  ));

  return {
    valid: issues.filter((issue) => issue.severity === "error").length === 0,
    issues,
    stats: {
      totalLines: draft.lines.length,
      speakers: speakerLabels,
      maxOrder: draft.lines.length > 0 ? Math.max(...draft.lines.map((line) => line.order)) : -1,
    },
  };
}

/**
 * Validate a production list and return a detailed report.
 */
export function validateProductionList(list: {
  lines: VoiceLine[];
  speakers: Speaker[];
}): ValidationReport {
  const issues: ValidationIssue[] = [];

  // R-M1-B: If lines exist but speakers is empty, that's an error.
  // The raw gate should not allow drafts with lines but no speakers
  // to pass through (normalization would create a default narrator).
  if (list.lines.length > 0 && list.speakers.length === 0) {
    issues.push({
      severity: "error",
      code: "MISSING_SPEAKERS",
      message: "Draft has lines but no speakers defined. At least one speaker is required.",
      field: "speakers",
    });
  }

  // Check line orders are sequential and unique
  const orders = list.lines.map((l) => l.order);
  const uniqueOrders = new Set(orders);
  if (uniqueOrders.size !== orders.length) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_LINE_ORDER",
      message: "Line orders must be unique",
      field: "lines",
    });
  }

  // Collect all speaker IDs from speakers array
  const speakerIds = new Set(list.speakers.map((s) => s.id));

  // Check each line references a valid speaker
  for (const line of list.lines) {
    // R-M1-B: Always check speaker reference regardless of speakers.length.
    // Previously skipped when speakers was empty (which the MISSING_SPEAKERS
    // check above now catches), but for robustness, check unconditionally.
    if (!speakerIds.has(line.speaker)) {
      issues.push({
        severity: "error",
        code: "INVALID_SPEAKER_REFERENCE",
        message: `Line "${line.id}" references unknown speaker "${line.speaker}"`,
        field: `lines[${line.id}].speaker`,
        lineId: line.id,
      });
    }

    // Check transcript non-empty
    if (!line.text.trim()) {
      issues.push({
        severity: "error",
        code: "EMPTY_TRANSCRIPT",
        message: `Line "${line.id}" has empty transcript text`,
        field: `lines[${line.id}].text`,
        lineId: line.id,
      });
    }

    // Check for Markdown syntax-only transcript (no semantic content).
    // Catches cases where parser may let through syntax-only lines like
    // table separators (|---|---|), horizontal rules (---), pure symbols,
    // or pure CJK/fullwidth punctuation (：：：, ！！！, 。。。).
    // Only Unicode letters, digits, and CJK ideographs count as semantic.
    const hasSemanticChar = /[A-Za-z0-9\u4e00-\u9fff\u3400-\u4dbf]/.test(line.text.trim());
    if (line.text.trim() && !hasSemanticChar) {
      issues.push({
        severity: "error",
        code: "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT",
        message: `Line "${line.id}" has Markdown syntax-only transcript: "${line.text.slice(0, 50)}"`,
        field: `lines[${line.id}].text`,
        lineId: line.id,
      });
    }
  }

  const speakerLabels = list.speakers.map((s) => s.label);

  // Warnings
  if (list.lines.length === 0) {
    issues.push({
      severity: "warning",
      code: "EMPTY_PRODUCTION_LIST",
      message: "Production list has no voice lines",
    });
  }

  return {
    valid: issues.filter((i) => i.severity === "error").length === 0,
    issues,
    stats: {
      totalLines: list.lines.length,
      speakers: speakerLabels,
      maxOrder: list.lines.length > 0 ? Math.max(...list.lines.map((l) => l.order)) : -1,
    },
  };
}
