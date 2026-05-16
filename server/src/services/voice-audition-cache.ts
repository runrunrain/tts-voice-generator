import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAudioBaseDir, computeSha256 } from "../utils/audio-fs.js";
import type { AudioFormat } from "../utils/audio-format.js";

const AUDITION_CACHE_LAYOUT_VERSION = "voice-audition-cache-v1";
const AUDITION_TEXT_VERSION = "audition-text-v1";
const POINTER_SCHEMA_VERSION = "voice-audition-cache-pointer.v1";
const ENTRY_SCHEMA_VERSION = "voice-audition-cache-entry.v1";
const CACHE_ROOT_SEGMENTS = ["voice-auditions", "v1"];
const HEX_SHA256_RE = /^[a-f0-9]{64}$/;

export interface AuditionCacheIdentity {
  canonicalVoice: string;
  model: string;
  requestedFormat: AudioFormat;
  outputFormat: AudioFormat;
  contentType: string;
  auditionText: string;
}

export interface AuditionCacheCommitInput extends AuditionCacheIdentity {
  cacheKey: string;
  originalVoice: string;
  audioBuffer: Buffer;
  extension: string;
}

export interface AuditionCacheEntry {
  cacheKey: string;
  audioBuffer: Buffer;
  metadata: AuditionCacheMetadata;
}

export interface AuditionCacheMetadata {
  schemaVersion: typeof ENTRY_SCHEMA_VERSION;
  cacheKey: string;
  canonicalVoice: string;
  originalVoice: string;
  model: string;
  requestedFormat: AudioFormat;
  outputFormat: AudioFormat;
  contentType: string;
  auditionTextVersion: typeof AUDITION_TEXT_VERSION;
  auditionTextSha256: string;
  generatedAt: string;
  source: "openrouter";
  sizeBytes: number;
  contentSha256: string;
  cacheLayoutVersion: typeof AUDITION_CACHE_LAYOUT_VERSION;
}

interface AuditionCachePointer {
  schemaVersion: typeof POINTER_SCHEMA_VERSION;
  cacheKey: string;
  activeContentSha256: string;
  audioFile: string;
  metadataFile: string;
  committedAt: string;
}

export function computeAuditionCacheKey(input: AuditionCacheIdentity): string {
  const auditionTextSha256 = sha256Text(input.auditionText);
  const cacheKeyInput = JSON.stringify({
    layoutVersion: AUDITION_CACHE_LAYOUT_VERSION,
    textVersion: AUDITION_TEXT_VERSION,
    textSha256: auditionTextSha256,
    canonicalVoice: input.canonicalVoice,
    model: input.model,
    requestedFormat: input.requestedFormat,
    outputFormat: input.outputFormat,
    contentType: input.contentType,
  });
  return sha256Text(cacheKeyInput);
}

export function getAuditionCacheRoot(): string {
  return path.join(getAudioBaseDir(), ...CACHE_ROOT_SEGMENTS);
}

export function getAuditionCacheDir(cacheKey: string): string {
  assertSafeSha256(cacheKey, "cache key");
  return resolveInside(getAuditionCacheRoot(), cacheKey);
}

export async function readAuditionCache(cacheKey: string): Promise<AuditionCacheEntry | null> {
  assertSafeSha256(cacheKey, "cache key");
  const cacheDir = getAuditionCacheDir(cacheKey);
  const pointerPath = resolveInside(cacheDir, "current.json");

  try {
    const pointer = parsePointer(await fs.promises.readFile(pointerPath, "utf8"));
    if (!pointer || pointer.cacheKey !== cacheKey) return null;
    if (!isSafeBasename(pointer.audioFile) || !isSafeBasename(pointer.metadataFile)) return null;

    const metadataPath = resolveInside(cacheDir, pointer.metadataFile);
    const metadata = parseMetadata(await fs.promises.readFile(metadataPath, "utf8"));
    if (!metadata || metadata.cacheKey !== cacheKey) return null;
    if (metadata.contentSha256 !== pointer.activeContentSha256) return null;

    const audioPath = resolveInside(cacheDir, pointer.audioFile);
    const audioBuffer = await fs.promises.readFile(audioPath);
    if (audioBuffer.byteLength !== metadata.sizeBytes) return null;
    if (computeSha256(audioBuffer) !== metadata.contentSha256) return null;

    return { cacheKey, audioBuffer, metadata };
  } catch {
    return null;
  }
}

export async function commitAuditionCacheEntry(input: AuditionCacheCommitInput): Promise<AuditionCacheEntry> {
  assertSafeSha256(input.cacheKey, "cache key");
  const cacheDir = getAuditionCacheDir(input.cacheKey);
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const contentSha256 = computeSha256(input.audioBuffer);
  const contentPrefix = contentSha256.slice(0, 16);
  const safeExtension = normalizeExtension(input.extension);
  const audioFile = `audio-${contentPrefix}.${safeExtension}`;
  const metadataFile = `meta-${contentPrefix}.json`;
  const generatedAt = new Date().toISOString();
  const metadata: AuditionCacheMetadata = {
    schemaVersion: ENTRY_SCHEMA_VERSION,
    cacheKey: input.cacheKey,
    canonicalVoice: input.canonicalVoice,
    originalVoice: input.originalVoice,
    model: input.model,
    requestedFormat: input.requestedFormat,
    outputFormat: input.outputFormat,
    contentType: input.contentType,
    auditionTextVersion: AUDITION_TEXT_VERSION,
    auditionTextSha256: sha256Text(input.auditionText),
    generatedAt,
    source: "openrouter",
    sizeBytes: input.audioBuffer.byteLength,
    contentSha256,
    cacheLayoutVersion: AUDITION_CACHE_LAYOUT_VERSION,
  };
  const pointer: AuditionCachePointer = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    cacheKey: input.cacheKey,
    activeContentSha256: contentSha256,
    audioFile,
    metadataFile,
    committedAt: generatedAt,
  };

  await atomicWriteFile(resolveInside(cacheDir, audioFile), input.audioBuffer);
  await atomicWriteFile(resolveInside(cacheDir, metadataFile), Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"));
  await atomicWriteFile(resolveInside(cacheDir, "current.json"), Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8"));

  return { cacheKey: input.cacheKey, audioBuffer: input.audioBuffer, metadata };
}

function parsePointer(raw: string): AuditionCachePointer | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AuditionCachePointer>;
    if (parsed.schemaVersion !== POINTER_SCHEMA_VERSION) return null;
    if (!isSafeSha256(parsed.cacheKey) || !isSafeSha256(parsed.activeContentSha256)) return null;
    if (typeof parsed.audioFile !== "string" || typeof parsed.metadataFile !== "string") return null;
    if (typeof parsed.committedAt !== "string") return null;
    return parsed as AuditionCachePointer;
  } catch {
    return null;
  }
}

function parseMetadata(raw: string): AuditionCacheMetadata | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AuditionCacheMetadata>;
    if (parsed.schemaVersion !== ENTRY_SCHEMA_VERSION) return null;
    if (!isSafeSha256(parsed.cacheKey) || !isSafeSha256(parsed.contentSha256)) return null;
    if (parsed.cacheLayoutVersion !== AUDITION_CACHE_LAYOUT_VERSION) return null;
    if (parsed.auditionTextVersion !== AUDITION_TEXT_VERSION) return null;
    if (!isAudioFormat(parsed.requestedFormat) || !isAudioFormat(parsed.outputFormat)) return null;
    if (typeof parsed.contentType !== "string" || !parsed.contentType.startsWith("audio/")) return null;
    if (typeof parsed.generatedAt !== "string" || Number.isNaN(Date.parse(parsed.generatedAt))) return null;
    if (typeof parsed.sizeBytes !== "number" || !Number.isSafeInteger(parsed.sizeBytes) || parsed.sizeBytes < 0) return null;
    if (typeof parsed.canonicalVoice !== "string" || typeof parsed.originalVoice !== "string" || typeof parsed.model !== "string") return null;
    if (parsed.source !== "openrouter") return null;
    return parsed as AuditionCacheMetadata;
  } catch {
    return null;
  }
}

async function atomicWriteFile(finalPath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(finalPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = resolveInside(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.promises.writeFile(tempPath, data);
    await fsyncBestEffort(tempPath);
    await fs.promises.rename(tempPath, finalPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // keep original error
    }
    throw err;
  }
}

async function fsyncBestEffort(filePath: string): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    await handle.sync();
  } catch {
    // rename still provides atomic visibility
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function resolveInside(baseDir: string, child: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, child);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid audition cache path: path traversal detected");
  }
  return resolved;
}

function normalizeExtension(extension: string): string {
  const safe = extension.toLowerCase().replace(/[^a-z0-9]/g, "");
  return safe || "wav";
}

function isSafeBasename(fileName: string): boolean {
  return fileName === path.basename(fileName) && !fileName.includes("/") && !fileName.includes("\\");
}

function assertSafeSha256(value: string, label: string): void {
  if (!isSafeSha256(value)) throw new Error(`Invalid ${label}`);
}

function isSafeSha256(value: unknown): value is string {
  return typeof value === "string" && HEX_SHA256_RE.test(value);
}

function isAudioFormat(value: unknown): value is AudioFormat {
  return value === "wav" || value === "pcm" || value === "mp3";
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
