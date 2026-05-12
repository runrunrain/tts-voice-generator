/**
 * Audio format resolution and PCM-to-WAV wrapping utilities.
 *
 * Gemini TTS on OpenRouter only supports response_format="pcm" (24kHz/16-bit/mono).
 * This module:
 *   1. Resolves user-requested format to upstream format and output format
 *   2. Wraps raw PCM buffers into standard RIFF WAV files for browser playback
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type AudioFormat = "wav" | "pcm" | "mp3";

export interface TtsFormatPlan {
  /** Format string to send to the upstream provider API */
  upstreamFormat: "pcm" | "mp3";
  /** Actual output format after any local transformation */
  outputFormat: AudioFormat;
  /** MIME type of the output */
  mimeType: string;
  /** File extension of the output */
  extension: string;
  /** Whether the PCM buffer needs to be wrapped into WAV before writing */
  wrapPcmToWav: boolean;
  /** PCM parameters for upstream/raw PCM audio metadata and WAV wrapping */
  pcmParams?: WavHeaderOptions;
}

// ─── Format Resolution ────────────────────────────────────────────────────────

/**
 * Determine the upstream request format and local output format for a TTS request.
 *
 * Strategy:
 * - Gemini TTS models: upstream pcm, output wav (default) or pcm (raw)
 * - Other models: passthrough (not currently used, but future-proof)
 * - Legacy "mp3" input from old clients: normalized to wav for Gemini
 */
export function resolveTtsFormat(
  model: string,
  requestedFormat: AudioFormat,
): TtsFormatPlan {
  const isGeminiTts = isGeminiTtsModel(model);

  if (isGeminiTts) {
    // Gemini TTS only supports upstream "pcm"
    if (requestedFormat === "pcm") {
      // Raw PCM output (advanced users)
      return {
        upstreamFormat: "pcm",
        outputFormat: "pcm",
        mimeType: "audio/pcm",
        extension: "pcm",
        wrapPcmToWav: false,
        pcmParams: DEFAULT_WAV_OPTIONS,
      };
    }
    // Default: wav (or legacy mp3 -> wav)
    return {
      upstreamFormat: "pcm",
      outputFormat: "wav",
      mimeType: "audio/wav",
      extension: "wav",
      wrapPcmToWav: true,
      pcmParams: DEFAULT_WAV_OPTIONS,
    };
  }

  // Non-Gemini models: passthrough (future-proof)
  const mimeType = getMimeType(requestedFormat);
  const extension = getExtension(requestedFormat);
  return {
    upstreamFormat: requestedFormat === "pcm" ? "pcm" : "mp3",
    outputFormat: requestedFormat,
    mimeType,
    extension,
    wrapPcmToWav: false,
  };
}

/**
 * Check if a model string refers to a Gemini TTS model.
 */
export function isGeminiTtsModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini") &&
    lower.includes("tts")
  );
}

// ─── PCM to WAV Wrapping ──────────────────────────────────────────────────────

export interface WavHeaderOptions {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

const DEFAULT_WAV_OPTIONS: WavHeaderOptions = {
  sampleRate: 24000,
  channels: 1,
  bitDepth: 16,
};

/**
 * Wrap a raw PCM 16-bit little-endian buffer into a standard RIFF WAV file.
 *
 * WAV header layout (44 bytes):
 *   0-3:   "RIFF"
 *   4-7:   file size - 8 (uint32 LE)
 *   8-11:  "WAVE"
 *   12-15: "fmt "
 *   16-19: 16 (fmt chunk size, uint32 LE)
 *   20-21: 1 (PCM format, uint16 LE)
 *   22-23: channels (uint16 LE)
 *   24-27: sampleRate (uint32 LE)
 *   28-31: byteRate (uint32 LE) = sampleRate * channels * bitDepth/8
 *   32-33: blockAlign (uint16 LE) = channels * bitDepth/8
 *   34-35: bitDepth (uint16 LE)
 *   36-39: "data"
 *   40-43: data size (uint32 LE)
 *   44+:   raw PCM data
 */
export function wrapPcm16LeToWav(
  pcmBuffer: Buffer,
  options: Partial<WavHeaderOptions> = {},
): Buffer {
  const opts = { ...DEFAULT_WAV_OPTIONS, ...options };
  const { sampleRate, channels, bitDepth } = opts;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const fileSize = dataSize + headerSize - 8;

  const header = Buffer.alloc(headerSize);
  let offset = 0;

  // RIFF chunk descriptor
  header.write("RIFF", offset); offset += 4;
  header.writeUInt32LE(fileSize, offset); offset += 4;
  header.write("WAVE", offset); offset += 4;

  // fmt sub-chunk
  header.write("fmt ", offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4;       // Sub-chunk size (16 for PCM)
  header.writeUInt16LE(1, offset); offset += 2;        // Audio format (1 = PCM)
  header.writeUInt16LE(channels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(bitDepth, offset); offset += 2;

  // data sub-chunk
  header.write("data", offset); offset += 4;
  header.writeUInt32LE(dataSize, offset); offset += 4;

  return Buffer.concat([header, pcmBuffer]);
}

// ─── Utility Functions ────────────────────────────────────────────────────────

/**
 * Normalize a legacy or user-supplied format string to a valid AudioFormat.
 * "mp3" is treated as legacy input and normalized to "wav" for Gemini TTS.
 */
export function normalizeFormat(format: string): AudioFormat {
  const lower = format.toLowerCase();
  if (lower === "wav") return "wav";
  if (lower === "pcm") return "pcm";
  // Legacy "mp3" or any unknown -> default to wav
  return "wav";
}

/**
 * Get MIME type from format string.
 */
function getMimeType(format: string): string {
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
function getExtension(format: string): string {
  switch (format.toLowerCase()) {
    case "mp3": return "mp3";
    case "pcm": return "pcm";
    case "wav": return "wav";
    default: return format.toLowerCase();
  }
}
