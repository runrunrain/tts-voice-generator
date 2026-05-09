/**
 * Artifact Store - File-based storage for task-related JSON artifacts.
 *
 * Each task gets a directory: data/tasks/{taskId}/
 * Artifacts are JSON files stored with atomic writes.
 *
 * Security:
 * - Task IDs validated as UUID format
 * - Path traversal prevention via allowlist
 * - All content stored as UTF-8
 * - Content hashing (SHA-256)
 * - Atomic writes (temp file + rename)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ARTIFACT_NAMES = new Set([
  "production-list.json",
  "requirements.json",
  "director-config.json",
]);
const TEMP_SUFFIX = ".tmp";

// ─── Validation ────────────────────────────────────────────────────────────────

function validateTaskId(taskId: string): void {
  if (!UUID_REGEX.test(taskId)) {
    throw new Error(`Invalid task ID format: ${taskId}`);
  }
}

function validateArtifactName(name: string): void {
  if (!ALLOWED_ARTIFACT_NAMES.has(name) &&
      !name.startsWith("document-") &&
      !name.startsWith("button-run-") &&
      !name.startsWith("production-list.v") &&
      !isRunArtifactPath(name)) {
    throw new Error(`Artifact name not in allowlist: ${name}`);
  }
  if (name.includes("..") || name.includes("\\") || name.includes("/..") ||
      (name.includes("/") && !isRunArtifactPath(name))) {
    throw new Error(`Artifact name contains invalid characters: ${name}`);
  }
}

/**
 * Check if a path is a valid run-scoped artifact path.
 * Format: agent-runs/normalize-{uuid}/{fixed-name}.json
 */
function isRunArtifactPath(name: string): boolean {
  // Match: agent-runs/normalize-{uuid}/known-artifact.json
  const runArtifactPattern = /^agent-runs\/normalize-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(normalize-request|production-list\.schema|candidate-lines|run-progress|production-list\.draft|instruction|validation-report|commit-result)\.json$/;
  const runArtifactMdPattern = /^agent-runs\/normalize-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/instruction\.md$/;
  return runArtifactPattern.test(name) || runArtifactMdPattern.test(name);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

// ─── Path Helpers ──────────────────────────────────────────────────────────────

function getTasksBaseDir(): string {
  return path.resolve(env.dataDir || "./data", "tasks");
}

function getTaskDir(taskId: string): string {
  return path.join(getTasksBaseDir(), taskId);
}

function getArtifactPath(taskId: string, artifactName: string): string {
  validateTaskId(taskId);
  validateArtifactName(artifactName);
  const taskDir = getTaskDir(taskId);
  return path.join(taskDir, artifactName);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ─── Core Operations ───────────────────────────────────────────────────────────

export interface ArtifactMeta {
  path: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Write an artifact with atomic write pattern.
 * Returns metadata including SHA-256 hash.
 */
export function writeArtifact(taskId: string, artifactName: string, data: unknown): ArtifactMeta {
  const filePath = getArtifactPath(taskId, sanitizeFileName(artifactName));
  const taskDir = path.dirname(filePath);
  ensureDir(taskDir);

  const content = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(content, "utf-8");
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  const tempPath = filePath + TEMP_SUFFIX;

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }

  return {
    path: filePath.replace(/\\/g, "/"),
    sha256,
    sizeBytes: buffer.length,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Read an artifact and parse as JSON.
 * Returns null if the artifact does not exist.
 * For reads, we skip the allowlist check since we're only reading, not writing.
 */
export function readArtifact<T = unknown>(taskId: string, artifactName: string): T | null {
  validateTaskId(taskId);
  // Only validate against path traversal for reads, not allowlist
  if (artifactName.includes("..") || artifactName.includes("/") || artifactName.includes("\\")) {
    return null;
  }
  const safeName = sanitizeFileName(artifactName);
  const taskDir = getTaskDir(taskId);
  const filePath = path.join(taskDir, safeName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Delete an artifact file.
 */
export function deleteArtifact(taskId: string, artifactName: string): boolean {
  const filePath = getArtifactPath(taskId, sanitizeFileName(artifactName));

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

/**
 * Check if an artifact exists.
 */
export function artifactExists(taskId: string, artifactName: string): boolean {
  const filePath = getArtifactPath(taskId, sanitizeFileName(artifactName));
  return fs.existsSync(filePath);
}

/**
 * Delete an entire task directory and all its artifacts.
 */
export function deleteTaskDir(taskId: string): boolean {
  validateTaskId(taskId);
  const taskDir = getTaskDir(taskId);

  if (!fs.existsSync(taskDir)) {
    return false;
  }

  fs.rmSync(taskDir, { recursive: true, force: true });
  return true;
}

/**
 * List all artifact files in a task directory.
 */
export function listArtifacts(taskId: string): string[] {
  validateTaskId(taskId);
  const taskDir = getTaskDir(taskId);

  if (!fs.existsSync(taskDir)) {
    return [];
  }

  return fs.readdirSync(taskDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\\/g, "/"));
}

/**
 * Generate a document artifact name from document ID.
 */
export function documentArtifactName(documentId: string): string {
  return `document-${sanitizeFileName(documentId)}.json`;
}

/**
 * Generate a button run artifact name from run ID.
 */
export function buttonRunArtifactName(runId: string): string {
  return `button-run-${sanitizeFileName(runId)}.json`;
}

/**
 * Get the production list artifact name.
 */
export function productionListArtifactName(): string {
  return "production-list.json";
}

/**
 * Get a versioned production list artifact name.
 * Format: production-list.v{n}.json
 */
export function productionListVersionArtifactName(version: number): string {
  return `production-list.v${version}.json`;
}

/**
 * Read raw text content of an artifact.
 * Returns null if the artifact does not exist.
 */
export function readArtifactRaw(taskId: string, artifactName: string): string | null {
  validateTaskId(taskId);
  if (artifactName.includes("..") || artifactName.includes("/") && !isRunArtifactPath(artifactName) && !artifactName.startsWith("agent-runs/")) {
    return null;
  }
  const taskDir = getTaskDir(taskId);
  const filePath = path.join(taskDir, artifactName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Write an artifact to a run-scoped path.
 * The path must be in the form: agent-runs/normalize-{uuid}/name.json
 * Returns metadata including SHA-256 hash.
 */
export function writeRunArtifact(
  taskId: string,
  relativePath: string,
  data: unknown,
): ArtifactMeta {
  validateTaskId(taskId);
  if (!isRunArtifactPath(relativePath) && !isRunArtifactMdPath(relativePath)) {
    throw new Error(`Run artifact path not in allowlist: ${relativePath}`);
  }
  const taskDir = getTaskDir(taskId);
  const filePath = path.join(taskDir, relativePath);
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const buffer = Buffer.from(content, "utf-8");
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  const tempPath = filePath + TEMP_SUFFIX;

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }

  return {
    path: filePath.replace(/\\/g, "/"),
    sha256,
    sizeBytes: buffer.length,
    createdAt: new Date().toISOString(),
  };
}

function isRunArtifactMdPath(name: string): boolean {
  const pattern = /^agent-runs\/normalize-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/instruction\.md$/;
  return pattern.test(name);
}
