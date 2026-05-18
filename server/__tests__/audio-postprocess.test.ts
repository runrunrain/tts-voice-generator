import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { concatWavBuffers, normalizeLoudnessIfEnabled } from "../src/utils/audio-postprocess.js";
import { analyzeWavBuffer } from "../src/utils/audio-analysis.js";
import { wrapPcm16LeToWav } from "../src/utils/audio-format.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("audio-postprocess", () => {
  it("returns the original buffer with disabled status when normalization is off", async () => {
    const wav = sampleWav();
    const result = await normalizeLoudnessIfEnabled(wav, { enabled: false, targetLufs: -16 });
    expect(result.buffer).toBe(wav);
    expect(result.status).toEqual({
      enabled: false,
      applied: false,
      reason: "disabled",
      targetLufs: -16,
      tool: "ffmpeg-loudnorm",
    });
  });

  it("returns unsupported_format for invalid WAV input", async () => {
    const buffer = Buffer.from("not wav");
    const result = await normalizeLoudnessIfEnabled(buffer, {
      enabled: true,
      targetLufs: -16,
      ffmpegPath: missingExecutablePath(),
    });
    expect(result.buffer).toBe(buffer);
    expect(result.status.reason).toBe("unsupported_format");
  });

  it("gracefully returns ffmpeg_not_found when the executable is missing", async () => {
    const wav = sampleWav();
    const result = await normalizeLoudnessIfEnabled(wav, {
      enabled: true,
      targetLufs: -16,
      ffmpegPath: missingExecutablePath(),
    });
    expect(result.buffer).toBe(wav);
    expect(result.status.enabled).toBe(true);
    expect(result.status.applied).toBe(false);
    expect(result.status.reason).toBe("ffmpeg_not_found");
  });

  it("returns applied when a compatible ffmpeg executable writes a valid WAV", async () => {
    const wav = sampleWav();
    const ffmpegPath = createFakeFfmpeg("success");
    const result = await normalizeLoudnessIfEnabled(wav, {
      enabled: true,
      targetLufs: -18,
      ffmpegPath,
    });
    expect(result.status.applied).toBe(true);
    expect(result.status.reason).toBe("applied");
    expect(result.status.targetLufs).toBe(-18);
    expect(analyzeWavBuffer(result.buffer).ok).toBe(true);
  });

  it("returns failed with sanitized error message when ffmpeg exits non-zero", async () => {
    const wav = sampleWav();
    const ffmpegPath = createFakeFfmpeg("fail");
    const result = await normalizeLoudnessIfEnabled(wav, {
      enabled: true,
      targetLufs: -16,
      ffmpegPath,
    });
    expect(result.buffer).toBe(wav);
    expect(result.status.reason).toBe("failed");
    expect(result.status.errorMessage).toContain("token=***");
    expect(result.status.errorMessage).not.toContain("secret-token-value");
  });

  it("concatenates same-format PCM WAV buffers and rewrites duration metadata", () => {
    const first = sampleWav([1000, -1000], 4);
    const second = sampleWav([2000, -2000], 4);
    const result = concatWavBuffers([first, second]);

    expect(result.ok).toBe(true);
    if (!result.ok || !result.buffer) return;
    const analysis = analyzeWavBuffer(result.buffer);
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;
    expect(analysis.sampleRate).toBe(4);
    expect(analysis.dataBytes).toBe(8);
    expect(analysis.duration).toBe("1.0s");
  });

  it("rejects concat when WAV formats do not match", () => {
    const first = sampleWav([1000], 4);
    const second = sampleWav([1000], 8);
    const result = concatWavBuffers([first, second]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FORMAT_MISMATCH");
  });
});

function sampleWav(samples = [1000, -1000, 2000, -2000], sampleRate = 4): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  return wrapPcm16LeToWav(pcm, { sampleRate, channels: 1, bitDepth: 16 });
}

function missingExecutablePath(): string {
  return path.join(os.tmpdir(), `tts-missing-ffmpeg-${process.pid}-${Date.now()}`);
}

function createFakeFfmpeg(mode: "success" | "fail"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-fake-ffmpeg-"));
  tempDirs.push(dir);
  const script = path.join(dir, "ffmpeg-fake.js");
  const body = mode === "success" ? successFakeFfmpegScript() : failFakeFfmpegScript();
  fs.writeFileSync(script, body, { mode: 0o755 });
  return script;
}

function successFakeFfmpegScript(): string {
  return `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('-version')) process.exit(0);
const inputIndex = process.argv.indexOf('-i') + 1;
const inputPath = process.argv[inputIndex];
const outputPath = process.argv[process.argv.length - 1];
fs.copyFileSync(inputPath, outputPath);
process.exit(0);
`;
}

function failFakeFfmpegScript(): string {
  return `#!/usr/bin/env node
if (process.argv.includes('-version')) process.exit(0);
process.stderr.write('failed token=secret-token-value');
process.exit(2);
`;
}
