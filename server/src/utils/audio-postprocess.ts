import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeWavBuffer, parseWavPcmDataView } from "./audio-analysis.js";
import { wrapPcm16LeToWav } from "./audio-format.js";

export type AudioPostprocessReason =
  | "applied"
  | "disabled"
  | "ffmpeg_not_found"
  | "unsupported_format"
  | "failed";

export interface LoudnessNormalizationOptions {
  enabled: boolean;
  targetLufs: number;
  ffmpegPath?: string | null;
  timeoutMs?: number;
}

export interface AudioPostprocessStatus {
  enabled: boolean;
  applied: boolean;
  reason: AudioPostprocessReason;
  targetLufs: number;
  tool: "ffmpeg-loudnorm";
  errorMessage?: string;
}

export interface AudioPostprocessResult {
  buffer: Buffer;
  status: AudioPostprocessStatus;
}

export interface WavConcatResult {
  ok: boolean;
  buffer?: Buffer;
  error?: { code: "EMPTY_INPUT" | "INVALID_WAV" | "FORMAT_MISMATCH"; message: string };
}

interface SpawnResult {
  ok: boolean;
  code?: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut?: boolean;
}

export async function normalizeLoudnessIfEnabled(
  wavBuffer: Buffer,
  options: LoudnessNormalizationOptions,
): Promise<AudioPostprocessResult> {
  const targetLufs = normalizeTargetLufs(options.targetLufs);
  const enabled = options.enabled === true;
  if (!enabled) return { buffer: wavBuffer, status: buildStatus(false, false, "disabled", targetLufs) };

  const analysis = analyzeWavBuffer(wavBuffer);
  if (!analysis.ok) return { buffer: wavBuffer, status: buildStatus(true, false, "unsupported_format", targetLufs) };

  const ffmpeg = options.ffmpegPath?.trim() || "ffmpeg";
  const probe = await runProcess(ffmpeg, ["-version"], options.timeoutMs ?? 30_000);
  if (!probe.ok) {
    const reason = probe.errorCode === "ENOENT" ? "ffmpeg_not_found" : "failed";
    return {
      buffer: wavBuffer,
      status: buildStatus(true, false, reason, targetLufs, reason === "failed" ? sanitizeProcessMessage(probe.stderr) : undefined),
    };
  }

  let tempDir: string | null = null;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tts-loudnorm-"));
    const inputPath = path.join(tempDir, "input.wav");
    const outputPath = path.join(tempDir, "output.wav");
    await fs.writeFile(inputPath, wavBuffer);

    const result = await runProcess(ffmpeg, [
      "-y",
      "-i",
      inputPath,
      "-af",
      `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`,
      "-ar",
      String(analysis.sampleRate),
      "-ac",
      String(analysis.channels),
      outputPath,
    ], options.timeoutMs ?? 30_000);

    if (!result.ok) {
      return {
        buffer: wavBuffer,
        status: buildStatus(
          true,
          false,
          result.errorCode === "ENOENT" ? "ffmpeg_not_found" : "failed",
          targetLufs,
          result.errorCode === "ENOENT" ? undefined : sanitizeProcessMessage(result.stderr || `ffmpeg exited with code ${result.code ?? "unknown"}`),
        ),
      };
    }

    const processed = await fs.readFile(outputPath);
    const processedAnalysis = analyzeWavBuffer(processed);
    if (!processedAnalysis.ok) {
      return { buffer: wavBuffer, status: buildStatus(true, false, "failed", targetLufs, "ffmpeg output was not a supported PCM WAV file.") };
    }
    return { buffer: processed, status: buildStatus(true, true, "applied", targetLufs) };
  } catch (error) {
    return { buffer: wavBuffer, status: buildStatus(true, false, "failed", targetLufs, sanitizeProcessMessage(error instanceof Error ? error.message : "Audio postprocess failed.")) };
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function concatWavBuffers(buffers: Buffer[]): WavConcatResult {
  if (buffers.length === 0) {
    return { ok: false, error: { code: "EMPTY_INPUT", message: "At least one WAV buffer is required." } };
  }

  const views = buffers.map((buffer) => ({ buffer, view: parseWavPcmDataView(buffer) }));
  const invalid = views.find(({ view }) => !view.ok);
  if (invalid) {
    const view = invalid.view;
    return { ok: false, error: { code: "INVALID_WAV", message: view.ok ? "Invalid WAV input." : view.message } };
  }

  const first = views[0].view;
  if (!first.ok) return { ok: false, error: { code: "INVALID_WAV", message: "Invalid WAV input." } };
  for (const { view } of views.slice(1)) {
    if (!view.ok) return { ok: false, error: { code: "INVALID_WAV", message: view.message } };
    if (view.sampleRate !== first.sampleRate || view.channels !== first.channels || view.bitsPerSample !== first.bitsPerSample) {
      return { ok: false, error: { code: "FORMAT_MISMATCH", message: "All WAV buffers must share sampleRate, channels, and bitsPerSample." } };
    }
  }

  const data = Buffer.concat(views.map(({ buffer, view }) => {
    if (!view.ok) return Buffer.alloc(0);
    return buffer.subarray(view.dataStart, view.dataStart + view.dataBytes);
  }));
  return {
    ok: true,
    buffer: wrapPcm16LeToWav(data, {
      sampleRate: first.sampleRate,
      channels: first.channels,
      bitDepth: first.bitsPerSample,
    }),
  };
}

function buildStatus(
  enabled: boolean,
  applied: boolean,
  reason: AudioPostprocessReason,
  targetLufs: number,
  errorMessage?: string,
): AudioPostprocessStatus {
  return {
    enabled,
    applied,
    reason,
    targetLufs,
    tool: "ffmpeg-loudnorm",
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function normalizeTargetLufs(value: number): number {
  return Number.isFinite(value) && value >= -30 && value <= -6 ? value : -16;
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr, timedOut: true, errorCode: "ETIMEDOUT" });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message, errorCode: error.code });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function sanitizeProcessMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(api[_-]?key|token|authorization)(\s*[=:]\s*)\S+/gi, "$1$2***")
    .slice(0, 300);
}
