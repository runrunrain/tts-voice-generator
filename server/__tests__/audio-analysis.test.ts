import { describe, expect, it } from "vitest";
import { analyzeWavBuffer } from "../src/utils/audio-analysis.js";
import { wrapPcm16LeToWav } from "../src/utils/audio-format.js";

describe("audio-analysis", () => {
  it("parses 16-bit PCM WAV metadata and computes RMS/peak", () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(0, 0);
    pcm.writeInt16LE(32767, 2);
    pcm.writeInt16LE(-32768, 4);
    pcm.writeInt16LE(16384, 6);
    const wav = wrapPcm16LeToWav(pcm, { sampleRate: 4, channels: 1, bitDepth: 16 });

    const result = analyzeWavBuffer(wav);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.container).toBe("wav");
    expect(result.audioFormat).toBe("pcm");
    expect(result.durationSeconds).toBe(1);
    expect(result.duration).toBe("1.0s");
    expect(result.sampleRate).toBe(4);
    expect(result.channels).toBe(1);
    expect(result.bitsPerSample).toBe(16);
    expect(result.dataBytes).toBe(8);
    expect(result.peak).toBeCloseTo(1, 5);
    expect(result.rms).toBeCloseTo(0.75, 3);
  });

  it("finds fmt and data chunks when an extra chunk is present", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(-1000, 2);
    const base = wrapPcm16LeToWav(pcm, { sampleRate: 2, channels: 1, bitDepth: 16 });
    const junkHeader = Buffer.alloc(8);
    junkHeader.write("JUNK", 0, "ascii");
    junkHeader.writeUInt32LE(4, 4);
    const withJunk = Buffer.concat([base.subarray(0, 12), junkHeader, Buffer.from([1, 2, 3, 4]), base.subarray(12)]);
    withJunk.writeUInt32LE(withJunk.length - 8, 4);

    const result = analyzeWavBuffer(withJunk);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duration).toBe("1.0s");
    expect(result.sampleRate).toBe(2);
  });

  it("returns INVALID_WAV for a truncated buffer without throwing", () => {
    const result = analyzeWavBuffer(Buffer.from([1, 2, 3]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_WAV");
  });

  it("returns UNSUPPORTED_CONTAINER for non-WAV data", () => {
    const buffer = Buffer.alloc(44);
    buffer.write("NOTW", 0, "ascii");
    buffer.write("DATA", 8, "ascii");
    const result = analyzeWavBuffer(buffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_CONTAINER");
  });

  it("returns UNSUPPORTED_AUDIO_FORMAT for non-PCM WAV", () => {
    const wav = Buffer.from(wrapPcm16LeToWav(Buffer.from([0, 0]), { sampleRate: 1, channels: 1, bitDepth: 16 }));
    wav.writeUInt16LE(3, 20);
    const result = analyzeWavBuffer(wav);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_AUDIO_FORMAT");
  });

  it("returns INVALID_WAV for malformed WAV with sampleRate=0", () => {
    const wav = Buffer.from(wrapPcm16LeToWav(Buffer.from([0, 0]), { sampleRate: 24000, channels: 1, bitDepth: 16 }));
    wav.writeUInt32LE(0, 24);

    const result = analyzeWavBuffer(wav);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_WAV");
  });

  it("returns INVALID_WAV for malformed WAV with channels=0", () => {
    const wav = Buffer.from(wrapPcm16LeToWav(Buffer.from([0, 0]), { sampleRate: 24000, channels: 1, bitDepth: 16 }));
    wav.writeUInt16LE(0, 22);

    const result = analyzeWavBuffer(wav);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_WAV");
  });

  it("returns INVALID_WAV for malformed WAV with blockAlign mismatch", () => {
    const wav = Buffer.from(wrapPcm16LeToWav(Buffer.from([0, 0, 0, 0]), { sampleRate: 2, channels: 1, bitDepth: 16 }));
    wav.writeUInt16LE(4, 32);

    const result = analyzeWavBuffer(wav);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_WAV");
  });

  it("returns INVALID_WAV for malformed WAV with misaligned data chunk", () => {
    const wav = wrapPcm16LeToWav(Buffer.from([0, 1, 2]), { sampleRate: 2, channels: 1, bitDepth: 16 });

    const result = analyzeWavBuffer(wav);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_WAV");
  });

  it("returns EMPTY_AUDIO_DATA for WAV with empty data chunk", () => {
    const result = analyzeWavBuffer(wrapPcm16LeToWav(Buffer.alloc(0), { sampleRate: 24000, channels: 1, bitDepth: 16 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EMPTY_AUDIO_DATA");
  });

  it("returns UNSUPPORTED_BIT_DEPTH rather than fake RMS for non-16-bit PCM", () => {
    const wav = wrapPcm16LeToWav(Buffer.from([128, 129]), { sampleRate: 2, channels: 1, bitDepth: 8 });
    const result = analyzeWavBuffer(wav);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_BIT_DEPTH");
  });
});
