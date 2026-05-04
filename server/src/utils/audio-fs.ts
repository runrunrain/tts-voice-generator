/**
 * Audio file system utilities.
 *
 * Handles local audio storage with path constraint:
 *   Audio base dir: ./data/audio
 *   File: {audioBaseDir}/YYYY/MM/DD/{jobId}.{ext}
 *   DB stores: YYYY/MM/DD/{jobId}.{ext} (relative to audio base dir)
 *
 * Security: rejects any path traversal attempt using path.relative check.
 * Reads the audio base directory from env/settings configuration.
 *
 * Atomic writes: writes to a temp file first, then renames to final path.
 * On failure, temp files are cleaned up. Orphan scanner provided but
 * does NOT auto-delete user assets.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEMP_FILE_SUFFIX = ".tmp";

// ─── Directory Helpers ────────────────────────────────────────────────────────

/**
 * Resolve the audio base directory from configuration.
 * Falls back to "./data/audio" if not configured.
 */
export function getAudioBaseDir(): string {
  return path.resolve(env.audioOutputDir || "./data/audio");
}

/**
 * Get the audio output directory for a given date.
 * Format: {audioDir}/YYYY/MM/DD
 */
export function getAudioDir(date: Date = new Date()): string {
  const y = date.getFullYear().toString();
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return path.join(getAudioBaseDir(), y, m, d);
}

/**
 * Get the full file path for an audio asset.
 * Enforces the {audioDir}/YYYY/MM/DD/{jobId}.{ext} pattern.
 */
export function getAudioFilePath(jobId: string, ext: string, date: Date = new Date()): string {
  const dir = getAudioDir(date);
  // Sanitize jobId and ext to prevent path traversal
  const safeJobId = jobId.replace(/[^a-zA-Z0-9\-_]/g, "");
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "");
  return path.join(dir, `${safeJobId}.${safeExt}`);
}

/**
 * Ensure the directory exists for a given audio file path.
 */
export function ensureAudioDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Atomic Write ─────────────────────────────────────────────────────────────

/**
 * Write audio buffer to file system using atomic write (temp file + rename).
 *
 * Steps:
 * 1. Write to a temp file in the same directory (with .tmp suffix)
 * 2. Rename temp file to final path (atomic on same filesystem)
 * 3. On failure, clean up the temp file
 *
 * Returns the relative file path from project root.
 *
 * @param jobId - Job identifier (sanitized for filesystem safety)
 * @param ext - File extension (mp3, pcm, wav)
 * @param buffer - Audio data to write
 * @param date - Date for directory structure (default: now)
 * @returns Relative file path for database storage
 */
export function writeAudioFile(jobId: string, ext: string, buffer: Buffer, date: Date = new Date()): string {
  const finalPath = getAudioFilePath(jobId, ext, date);
  ensureAudioDir(finalPath);

  // Generate temp file path in the same directory
  const tempPath = finalPath + TEMP_FILE_SUFFIX;

  try {
    // Step 1: Write to temp file
    fs.writeFileSync(tempPath, buffer);

    // Step 2: Sync to disk for durability (best effort, may fail on some FS)
    try {
      const fd = fs.openSync(tempPath, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // fsync may fail on some filesystems (e.g., tmp dirs on Windows)
      // This is non-critical; the rename still provides atomicity
    }

    // Step 3: Atomic rename
    fs.renameSync(tempPath, finalPath);
  } catch (err) {
    // Clean up temp file on failure (best effort)
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Clean up failure is non-critical; don't mask the original error
    }
    throw err;
  }

  // Return path relative to audio base dir for database storage.
  // This path is used by readAudioFile() which resolves relative to audio base dir.
  // Format: YYYY/MM/DD/{jobId}.{ext}
  return path.relative(getAudioBaseDir(), finalPath).replace(/\\/g, "/");
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read an audio file from disk.
 * Validates that the file path is within the configured audio directory
 * to prevent path traversal attacks.
 *
 * Uses path.relative check: the resolved target must not start with ".."
 * and must not be an absolute path outside the base directory.
 */
export function readAudioFile(relativePath: string): Buffer {
  const baseDir = getAudioBaseDir();
  const resolvedPath = path.resolve(baseDir, relativePath);

  // Security: use path.relative to detect traversal.
  // If the resolved path escapes the base dir, the relative path will
  // start with ".." or be an absolute path on another drive (Windows).
  const relative = path.relative(baseDir, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid audio path: path traversal detected");
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Audio file not found: ${relativePath}`);
  }

  return fs.readFileSync(resolvedPath);
}

// ─── Orphan Scanner ───────────────────────────────────────────────────────────

export interface OrphanFile {
  path: string;
  size: number;
  modified: Date;
  type: "temp" | "unknown";
}

/**
 * Scan audio directories for orphan temp files (.tmp suffix).
 *
 * This only identifies orphans; it does NOT delete them automatically.
 * Returns a list of orphan file info for review or manual cleanup.
 *
 * @param maxAgeMs - Minimum age in ms for a file to be considered orphan (default: 1 hour)
 * @returns Array of orphan file info
 */
export function scanOrphanFiles(maxAgeMs: number = 60 * 60 * 1000): OrphanFile[] {
  const baseDir = getAudioBaseDir();
  const orphans: OrphanFile[] = [];
  const cutoffTime = Date.now() - maxAgeMs;

  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(TEMP_FILE_SUFFIX)) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs <= cutoffTime) {
          orphans.push({
            path: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
            size: stat.size,
            modified: stat.mtime,
            type: "temp",
          });
        }
      }
    }
  }

  scanDir(baseDir);
  return orphans;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a buffer.
 */
export function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Get mime type from format string.
 */
export function getMimeType(format: string): string {
  switch (format.toLowerCase()) {
    case "mp3": return "audio/mpeg";
    case "pcm": return "audio/pcm";
    case "wav": return "audio/wav";
    default: return "application/octet-stream";
  }
}

/**
 * Get file extension from format string.
 */
export function getExtension(format: string): string {
  switch (format.toLowerCase()) {
    case "mp3": return "mp3";
    case "pcm": return "pcm";
    case "wav": return "wav";
    default: return format.toLowerCase();
  }
}
