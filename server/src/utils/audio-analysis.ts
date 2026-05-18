export type AudioAnalysisErrorCode =
  | "INVALID_WAV"
  | "UNSUPPORTED_CONTAINER"
  | "UNSUPPORTED_AUDIO_FORMAT"
  | "UNSUPPORTED_BIT_DEPTH"
  | "MISSING_FMT_CHUNK"
  | "MISSING_DATA_CHUNK"
  | "EMPTY_AUDIO_DATA";

export interface WavAnalysisSuccess {
  ok: true;
  container: "wav";
  audioFormat: "pcm";
  durationSeconds: number;
  duration: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  rms: number;
  peak: number;
}

export interface WavAnalysisFailure {
  ok: false;
  code: AudioAnalysisErrorCode;
  message: string;
}

export type WavAnalysisResult = WavAnalysisSuccess | WavAnalysisFailure;

export interface WavPcmDataView {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
  byteRate: number;
  dataStart: number;
  dataBytes: number;
}

interface ParsedWavChunks {
  fmt?: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  };
  data?: {
    start: number;
    size: number;
  };
}

export function analyzeWavBuffer(buffer: Buffer): WavAnalysisResult {
  const parsed = parseWavPcmDataView(buffer);
  if (!parsed.ok) return parsed;

  const { sampleRate, channels, bitsPerSample, dataStart, dataBytes } = parsed;
  if (bitsPerSample !== 16) {
    return failure("UNSUPPORTED_BIT_DEPTH", `Only 16-bit PCM WAV RMS/peak analysis is currently supported; got ${bitsPerSample}-bit.`);
  }

  const bytesPerSampleFrame = channels * (bitsPerSample / 8);
  const durationSeconds = dataBytes / (sampleRate * bytesPerSampleFrame);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return failure("INVALID_WAV", "WAV duration metadata is not finite and positive.");
  }
  const audioData = buffer.subarray(dataStart, dataStart + dataBytes);
  const sampleCount = Math.floor(audioData.length / 2);
  if (sampleCount <= 0) return failure("EMPTY_AUDIO_DATA", "WAV data chunk does not contain complete PCM samples.");

  let squareSum = 0;
  let peak = 0;
  for (let offset = 0; offset + 1 < audioData.length; offset += 2) {
    const sample = audioData.readInt16LE(offset);
    const normalized = Math.abs(sample) / 32768;
    squareSum += normalized * normalized;
    if (normalized > peak) peak = normalized;
  }

  const rms = Math.sqrt(squareSum / sampleCount);
  return {
    ok: true,
    container: "wav",
    audioFormat: "pcm",
    durationSeconds,
    duration: `${durationSeconds.toFixed(1)}s`,
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    rms,
    peak,
  };
}

export function parseWavPcmDataView(buffer: Buffer): (WavPcmDataView & { ok: true }) | WavAnalysisFailure {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return failure("INVALID_WAV", "WAV buffer is shorter than the minimum 44-byte header.");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return failure("UNSUPPORTED_CONTAINER", "Buffer is not a RIFF/WAVE container.");
  }

  const chunks = parseChunks(buffer);
  if (!chunks) return failure("INVALID_WAV", "WAV chunk table is truncated or invalid.");
  if (!chunks.fmt) return failure("MISSING_FMT_CHUNK", "WAV fmt chunk is missing.");
  if (!chunks.data) return failure("MISSING_DATA_CHUNK", "WAV data chunk is missing.");
  if (chunks.fmt.audioFormat !== 1) {
    return failure("UNSUPPORTED_AUDIO_FORMAT", `Only PCM WAV is supported; got audio format ${chunks.fmt.audioFormat}.`);
  }
  if (chunks.data.size <= 0) return failure("EMPTY_AUDIO_DATA", "WAV data chunk is empty.");
  if (chunks.fmt.sampleRate <= 0) return failure("INVALID_WAV", `WAV sample rate must be positive; got ${chunks.fmt.sampleRate}.`);
  if (chunks.fmt.channels <= 0) return failure("INVALID_WAV", `WAV channel count must be positive; got ${chunks.fmt.channels}.`);
  if (chunks.fmt.bitsPerSample <= 0) return failure("INVALID_WAV", `WAV bit depth must be positive; got ${chunks.fmt.bitsPerSample}.`);
  if (chunks.fmt.blockAlign <= 0) return failure("INVALID_WAV", `WAV blockAlign must be positive; got ${chunks.fmt.blockAlign}.`);
  if (chunks.fmt.byteRate <= 0) return failure("INVALID_WAV", `WAV byteRate must be positive; got ${chunks.fmt.byteRate}.`);
  if (![8, 16, 24, 32].includes(chunks.fmt.bitsPerSample)) {
    return failure("UNSUPPORTED_BIT_DEPTH", `Unsupported PCM bit depth: ${chunks.fmt.bitsPerSample}.`);
  }

  const bytesPerSample = chunks.fmt.bitsPerSample / 8;
  const expectedBlockAlign = chunks.fmt.channels * bytesPerSample;
  if (!Number.isInteger(bytesPerSample) || chunks.fmt.blockAlign !== expectedBlockAlign) {
    return failure(
      "INVALID_WAV",
      `WAV blockAlign ${chunks.fmt.blockAlign} does not match channels * bytesPerSample (${expectedBlockAlign}).`,
    );
  }

  const expectedByteRate = chunks.fmt.sampleRate * chunks.fmt.blockAlign;
  if (chunks.fmt.byteRate !== expectedByteRate) {
    return failure(
      "INVALID_WAV",
      `WAV byteRate ${chunks.fmt.byteRate} does not match sampleRate * blockAlign (${expectedByteRate}).`,
    );
  }

  if (chunks.data.size % chunks.fmt.blockAlign !== 0) {
    return failure("INVALID_WAV", "WAV data chunk size is not aligned to complete PCM frames.");
  }

  const durationSeconds = chunks.data.size / chunks.fmt.byteRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return failure("INVALID_WAV", "WAV duration metadata is not finite and positive.");
  }

  return {
    ok: true,
    sampleRate: chunks.fmt.sampleRate,
    channels: chunks.fmt.channels,
    bitsPerSample: chunks.fmt.bitsPerSample,
    blockAlign: chunks.fmt.blockAlign,
    byteRate: chunks.fmt.byteRate,
    dataStart: chunks.data.start,
    dataBytes: chunks.data.size,
  };
}

function parseChunks(buffer: Buffer): ParsedWavChunks | null {
  const chunks: ParsedWavChunks = {};
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) return null;

    if (id === "fmt ") {
      if (size < 16) return null;
      chunks.fmt = {
        audioFormat: buffer.readUInt16LE(dataStart),
        channels: buffer.readUInt16LE(dataStart + 2),
        sampleRate: buffer.readUInt32LE(dataStart + 4),
        byteRate: buffer.readUInt32LE(dataStart + 8),
        blockAlign: buffer.readUInt16LE(dataStart + 12),
        bitsPerSample: buffer.readUInt16LE(dataStart + 14),
      };
    } else if (id === "data") {
      chunks.data = { start: dataStart, size };
    }

    offset = dataEnd + (size % 2);
  }

  return chunks;
}

function failure(code: AudioAnalysisErrorCode, message: string): WavAnalysisFailure {
  return { ok: false, code, message };
}
