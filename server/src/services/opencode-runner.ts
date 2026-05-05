/**
 * OpenCode Runner - CLI availability detection, execution, and fallback.
 *
 * Responsibilities:
 * - Detect if OpenCode CLI is available
 * - Execute OpenCode commands with proper error handling
 * - Provide deterministic fallback for requirement normalization
 * - Sanitize errors (no token/key leaks)
 *
 * The fallback is NOT a fake agent. It is a deterministic, local
 * rule-based normalizer that produces verifiable output.
 * All results are tagged with runner="opencode" or runner="fallback".
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import type { VoiceLine } from "../domain/validators.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface FallbackSpeaker {
  id: string;
  label: string;
  name?: string;
  voice: string;
  style?: string;
}

const execFileAsync = promisify(execFile);

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface OpenCodeAvailability {
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface OpenCodeRunResult {
  runner: "opencode" | "fallback";
  success: boolean;
  output: string;
  error: string | null;
  durationMs: number;
}

export interface NormalizeRequirementsInput {
  documents: Array<{
    id: string;
    fileName: string;
    content: string;
    enabled: boolean;
  }>;
  directorProfileId?: string | null;
}

export interface NormalizeRequirementsOutput {
  runner: "opencode" | "fallback";
  productionList: {
    lines: VoiceLine[];
    speakers: FallbackSpeaker[];
    metadata: Record<string, unknown>;
  };
  warnings: Array<{ code: string; message: string }>;
}

// ─── CLI Detection ─────────────────────────────────────────────────────────────

let cachedAvailability: OpenCodeAvailability | null = null;
let lastCheckTime = 0;
const CHECK_INTERVAL_MS = 60_000; // re-check every 60s

/**
 * Check if OpenCode CLI is available.
 * Results are cached for 60 seconds.
 */
export async function checkOpenCodeAvailability(): Promise<OpenCodeAvailability> {
  const now = Date.now();
  if (cachedAvailability && now - lastCheckTime < CHECK_INTERVAL_MS) {
    return cachedAvailability;
  }

  try {
    const { stdout } = await execFileAsync("opencode", ["--version"], {
      timeout: 5000,
      windowsHide: true,
    });

    const version = stdout.trim();
    cachedAvailability = { available: true, version, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Sanitize - don't leak paths or tokens
    const safeMessage = message
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "sk-[REDACTED]");

    cachedAvailability = {
      available: false,
      version: null,
      error: safeMessage,
    };
  }

  lastCheckTime = now;
  return cachedAvailability;
}

/**
 * Invalidate the cached availability check (for testing).
 */
export function invalidateAvailabilityCache(): void {
  cachedAvailability = null;
  lastCheckTime = 0;
}

// ─── Deterministic Fallback Normalizer ─────────────────────────────────────────

/**
 * Deterministic, rule-based normalization from requirement documents to a
 * production list. This is NOT an AI agent - it's a local, verifiable,
 * rule-based transformation.
 *
 * Rules:
 * 1. Only use "enabled" documents
 * 2. Split content by lines
 * 3. Assign speaker "Narrator" by default
 * 4. Detect multi-speaker markers like "A:" "B:" or "Speaker1:" "Speaker2:"
 * 5. Skip empty lines and comment lines (starting with #)
 * 6. Assign sequential orders
 */
export function fallbackNormalize(input: NormalizeRequirementsInput): NormalizeRequirementsOutput {
  const warnings: Array<{ code: string; message: string }> = [];
  const enabledDocs = input.documents.filter((d) => d.enabled);

  if (enabledDocs.length === 0) {
    warnings.push({ code: "NO_ENABLED_DOCS", message: "No enabled documents found for normalization" });
    return {
      runner: "fallback",
      productionList: { lines: [], speakers: [], metadata: {} },
      warnings,
    };
  }

  const speakerMap = new Map<string, FallbackSpeaker>();
  const lines: VoiceLine[] = [];
  let order = 0;

  for (const doc of enabledDocs) {
    const rawLines = doc.content.split(/\r?\n/);

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();

      // Skip empty and comment lines
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Detect speaker prefix: "A: text", "B: text", "Speaker1: text"
      const speakerMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+)$/);

      let speakerLabel: string;
      let text: string;

      if (speakerMatch) {
        speakerLabel = speakerMatch[1];
        text = speakerMatch[2].trim();
      } else {
        speakerLabel = "Narrator";
        text = trimmed;
      }

      if (!text) continue;

      // Register speaker if new
      if (!speakerMap.has(speakerLabel)) {
        if (speakerMap.size >= 2) {
          // Already have 2 speakers, map remaining to the second
          warnings.push({
            code: "SPEAKER_MAPPED",
            message: `Speaker "${speakerLabel}" mapped to existing speaker (max 2).`,
          });
          const existing = Array.from(speakerMap.keys());
          speakerLabel = existing[existing.length - 1];
        } else {
          speakerMap.set(speakerLabel, {
            id: speakerLabel.toLowerCase().replace(/\s+/g, "-"),
            label: speakerLabel,
            voice: "Zephyr",
            style: "",
          });
        }
      }

      lines.push({
        id: crypto.randomUUID(),
        order,
        speaker: speakerMap.has(speakerLabel)
          ? speakerMap.get(speakerLabel)!.id
          : Array.from(speakerMap.values())[0]?.id ?? "narrator",
        text,
        voice: speakerMap.get(speakerLabel)?.voice ?? "Zephyr",
        style: "",
        notes: "",
        status: "pending",
        model: "google/gemini-3.1-flash-tts-preview",
        responseFormat: "wav",
      });

      order++;
    }
  }

  return {
    runner: "fallback",
    productionList: {
      lines,
      speakers: Array.from(speakerMap.values()),
      metadata: {
        sourceDocuments: enabledDocs.map((d) => d.fileName),
        normalizedAt: new Date().toISOString(),
        method: "fallback-rule-based",
      },
    },
    warnings,
  };
}

// ─── Fallback Button Transformations ───────────────────────────────────────────

export type ButtonTransformType = "rewrite" | "shorten" | "expand" | "style";

const BUTTON_TRANSFORMS: Record<string, (text: string, params: Record<string, unknown>) => string> = {
  shorten: (text) => {
    // Simple deterministic shortening: take first sentence or truncate to 60% length
    const sentences = text.split(/[.!?。！？]+/).filter((s) => s.trim());
    if (sentences.length <= 1) {
      const targetLen = Math.ceil(text.length * 0.6);
      return text.slice(0, targetLen).trimEnd();
    }
    return sentences.slice(0, Math.ceil(sentences.length * 0.6)).join(". ").trim();
  },
  expand: (text) => {
    // Simple deterministic expansion: repeat key phrases with connectors
    if (text.length < 10) return text;
    return `${text}... ${text.split(/[.!?。！？]/)[0].trim()}, that is to say, ${text}.`;
  },
  style: (text, params) => {
    // Style transformation with hints from params
    const tone = typeof params.tone === "string" ? params.tone : "neutral";
    const prefix: Record<string, string> = {
      formal: "[Formal] ",
      casual: "[Casual] ",
      dramatic: "[Dramatic] ",
      whisper: "[Whisper] ",
      energetic: "[Energetic] ",
    };
    return `${prefix[tone] || ""}${text}`;
  },
  rewrite: (text, params) => {
    // Rewrite using instruction hint
    const instruction = typeof params.instruction === "string" ? params.instruction : "";
    if (!instruction) return text;
    // Deterministic rewrite: just note the intent, don't hallucinate
    return `[Rewrite: ${instruction}] ${text}`;
  },
};

/**
 * Apply a button transformation to a line's text.
 * This is the fallback (non-AI) version.
 */
export function applyFallbackTransform(
  type: string,
  text: string,
  params: Record<string, unknown>,
): string {
  const transform = BUTTON_TRANSFORMS[type];
  if (!transform) {
    throw new Error(`Unknown button transform type: ${type}`);
  }
  return transform(text, params);
}

// ─── Sanitize Error ────────────────────────────────────────────────────────────

/**
 * Sanitize error messages to prevent token/key leaks.
 */
export function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unknown error";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bapi[_-]?key\s*=\s*\S+/gi, "api_key=[REDACTED]")
    .replace(/\btoken\s*=\s*\S+/gi, "token=[REDACTED]")
    .slice(0, 500);
}
