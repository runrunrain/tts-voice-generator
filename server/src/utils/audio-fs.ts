/**
 * Audio file system utilities.
 *
 * Handles local audio storage with path constraint:
 *   data/audio/YYYY/MM/DD/{jobId}.{ext}
 *
 * Security: rejects any path traversal attempt.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const AUDIO_BASE_DIR = path.resolve("./data/audio");

/**
 * Get the audio output directory for a given date.
 * Format: data/audio/YYYY/MM/DD
 */
export function getAudioDir(date: Date = new Date()): string {
  const y = date.getFullYear().toString();
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return path.join(AUDIO_BASE_DIR, y, m, d);
}

/**
 * Get the full file path for an audio asset.
 * Enforces the data/audio/YYYY/MM/DD/{jobId}.{ext} pattern.
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

/**
 * Write audio buffer to file system.
 * Returns the relative file path from project root.
 */
export function writeAudioFile(jobId: string, ext: string, buffer: Buffer, date: Date = new Date()): string {
  const filePath = getAudioFilePath(jobId, ext, date);
  ensureAudioDir(filePath);
  fs.writeFileSync(filePath, buffer);

  // Return relative path for database storage
  return path.relative(path.resolve("."), filePath).replace(/\\/g, "/");
}

/**
 * Read an audio file from disk.
 * Validates that the file path is within the audio directory to prevent path traversal.
 */
export function readAudioFile(relativePath: string): Buffer {
  // Normalize and validate path
  const resolvedPath = path.resolve(relativePath);
  const normalizedBase = path.resolve(AUDIO_BASE_DIR);

  // Security: ensure the resolved path is under the audio directory
  if (!resolvedPath.startsWith(normalizedBase)) {
    throw new Error("Invalid audio path: path traversal detected");
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Audio file not found: ${relativePath}`);
  }

  return fs.readFileSync(resolvedPath);
}

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
