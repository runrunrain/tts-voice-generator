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
  speaker: z.string().min(1),
  text: z.string().min(1),
  voice: z.string().min(1),
  style: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  status: z.enum(["pending", "approved", "generating", "generated", "failed"]).optional().default("pending"),
  model: z.string().min(1).optional().default("google/gemini-3.1-flash-tts-preview"),
  responseFormat: z.enum(["wav", "pcm", "mp3"]).optional().default("wav"),
  directorProfileId: z.string().optional().nullable(),
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
  taskId: z.string().min(1),
  version: z.number().int().min(1),
  lines: z.array(VoiceLineSchema).min(0),
  speakers: z.array(SpeakerSchema).max(2, "Maximum 2 speakers allowed"),
  directorProfileId: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type ProductionList = z.infer<typeof ProductionListSchema>;

// ─── Director Profile Config ───────────────────────────────────────────────────

export const DirectorConfigSchema = z.object({
  audioProfile: z.string().optional().default(""),
  scene: z.string().optional().default(""),
  directorNotes: z.string().optional().default(""),
  sampleContext: z.string().optional().default(""),
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

// ─── Document Schemas ──────────────────────────────────────────────────────────

export const PasteDocumentSchema = z.object({
  fileName: z.string().min(1).max(255),
  content: z.string().min(1),
});

export const UploadDocumentBodySchema = z.object({
  fileName: z.string().min(1).max(255),
  content: z.string().min(1),
});

export const UpdateDocumentSchema = z.object({
  fileName: z.string().min(1).max(255).optional(),
  content: z.string().min(1).optional(),
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
  speakers: z.array(SpeakerSchema).max(2),
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
  targetLineId: z.string().min(1),
  expectedVersion: z.number().int().min(1),
  parameters: z.record(z.unknown()).optional().default({}),
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
});

// ─── Validation Functions ──────────────────────────────────────────────────────

/**
 * Validate a production list and return a detailed report.
 */
export function validateProductionList(list: {
  lines: VoiceLine[];
  speakers: Speaker[];
}): ValidationReport {
  const issues: ValidationIssue[] = [];

  // Check speaker count
  if (list.speakers.length > 2) {
    issues.push({
      severity: "error",
      code: "SPEAKER_LIMIT_EXCEEDED",
      message: `Maximum 2 speakers allowed, found ${list.speakers.length}`,
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
    if (!speakerIds.has(line.speaker) && list.speakers.length > 0) {
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
