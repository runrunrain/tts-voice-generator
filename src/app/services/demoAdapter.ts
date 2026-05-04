/**
 * Demo Service Adapter
 *
 * This adapter provides local demonstration behaviour that mirrors the expected
 * real API contract (TtsServiceAdapter). Every function returns realistic-looking
 * demo data and introduces small artificial delays to simulate network latency.
 *
 * IMPORTANT: All results are flagged with `isDemo: true` and the UI must clearly
 * label them as demonstration outputs. When a real backend is ready, create a
 * new adapter implementing the same interface and swap via the context provider.
 */

import type {
  AudioFormat,
  CostEstimate,
  GeneratePhase,
  GenerateRequest,
  GenerateResult,
  HistoryFilter,
  HistoryRecord,
  HistorySource,
  VoiceProfile,
  VoiceStatus,
  ConnectionStatus,
  TtsServiceAdapter,
} from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateJobId(): string {
  return `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const VOICE_CATALOG: VoiceProfile[] = [
  { name: "Zephyr", isDefault: true, role: "明亮", provider: "OpenRouter", status: "success", lastVerified: "2026-05-03", verifyDuration: "2.3s" },
  { name: "Puck", isDefault: false, role: "欢快", provider: "OpenRouter", status: "success", lastVerified: "2026-05-03", verifyDuration: "1.8s" },
  { name: "Charon", isDefault: false, role: "信息丰富", provider: "OpenRouter", status: "success", lastVerified: "2026-05-03", verifyDuration: "2.1s" },
  { name: "Kore", isDefault: false, role: "坚定", provider: "OpenRouter", status: "success", lastVerified: "2026-05-03", verifyDuration: "1.9s" },
  { name: "Fenrir", isDefault: false, role: "兴奋", provider: "OpenRouter", status: "success", lastVerified: "2026-05-02", verifyDuration: "2.5s" },
  { name: "Leda", isDefault: false, role: "青春", provider: "OpenRouter", status: "success", lastVerified: "2026-05-02", verifyDuration: "2.0s" },
  { name: "custom-1", isDefault: false, role: "自定义角色", provider: "Local", status: "warning", lastVerified: "2026-05-02" },
  { name: "custom-fail", isDefault: false, role: "未知", provider: "Local", status: "error", lastVerified: "2026-05-01" },
];

const DEMO_HISTORY: HistoryRecord[] = [
  { id: "demo-abc123", text: "从前有个叫小明的小朋友，有一天他走进了一片神秘的森林...", voice: "Zephyr", format: "mp3", date: "2026-05-03 14:30", source: "用户", duration: "3.2s", status: "success", cost: "$0.0004", charCount: 247 },
  { id: "demo-def456", text: "Welcome to the future of voice generation. This is a sample output for demonstration purposes.", voice: "Puck", format: "mp3", date: "2026-05-03 12:15", source: "Agent", duration: "4.5s", status: "success", cost: "$0.0006", charCount: 89 },
  { id: "demo-err789", text: "测试文本用于验证 API 的容错能力，特别是长文本截断...", voice: "Zephyr", format: "pcm", date: "2026-05-03 10:05", source: "用户", duration: "0.0s", status: "error", error: "RATE_LIMITED" },
];

// ─── Generate Demo Audio Blob ────────────────────────────────────────────────
/**
 * Creates a short silent WAV blob using the Web Audio API.
 * This is used as a placeholder audio file for demo playback.
 */
function createDemoAudioBlob(): Blob {
  const sampleRate = 22050;
  const durationSec = 1.5;
  const numSamples = Math.floor(sampleRate * durationSec);
  // Simple sinusoid to produce an audible tone so user can verify playback
  const frequency = 440;
  const amplitude = 0.15;

  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);  // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude;
    const intSample = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    view.setInt16(44 + i * 2, intSample, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Cache the demo blob URL so we don't recreate it every time
let _demoAudioUrl: string | null = null;

function getDemoAudioUrl(): string {
  if (!_demoAudioUrl) {
    const blob = createDemoAudioBlob();
    _demoAudioUrl = URL.createObjectURL(blob);
  }
  return _demoAudioUrl;
}

// ─── Adapter Implementation ──────────────────────────────────────────────────

export const demoAdapter: TtsServiceAdapter = {
  async generateSpeech(req: GenerateRequest): Promise<GenerateResult> {
    // Defensive: reject empty text at adapter level
    if (!req.text.trim()) {
      return {
        jobId: generateJobId(),
        phase: "error" as GeneratePhase,
        voice: req.voice,
        format: req.format,
        charCount: 0,
        duration: "0.0s",
        estimatedCost: "$0.00",
        error: {
          code: "EMPTY_TEXT",
          message: "文本内容不能为空。",
        },
        timestamp: new Date().toISOString(),
        isDemo: true,
      };
    }

    // Simulate network latency
    await delay(800 + Math.random() * 600);

    const charCount = req.text.length;

    // Trigger error demo if text contains [error]
    if (req.text.toLowerCase().includes("[error]")) {
      return {
        jobId: generateJobId(),
        phase: "error" as GeneratePhase,
        voice: req.voice,
        format: req.format,
        charCount,
        duration: "0.0s",
        estimatedCost: "$0.00",
        error: {
          code: "DEMO_ERROR",
          message: "演示错误：输入包含 [error] 触发词，用于展示错误态交互。",
        },
        timestamp: new Date().toISOString(),
        isDemo: true,
      };
    }

    const estCost = demoAdapter.estimateCost(charCount, req.format);
    const durSec = Math.max(0.5, charCount * 0.012).toFixed(1);

    return {
      jobId: generateJobId(),
      phase: "success",
      voice: req.voice,
      format: req.format,
      charCount,
      duration: `${durSec}s`,
      estimatedCost: estCost.estimatedCost,
      audioUrl: getDemoAudioUrl(),
      timestamp: new Date().toISOString(),
      isDemo: true,
    };
  },

  async probeVoice(voiceName: string): Promise<{ status: VoiceStatus; latency: string }> {
    await delay(600 + Math.random() * 400);
    const voice = VOICE_CATALOG.find((v) => v.name === voiceName);
    if (!voice) {
      return { status: "error", latency: "N/A" };
    }
    return { status: voice.status, latency: `${(1.5 + Math.random() * 1.5).toFixed(1)}s` };
  },

  async testConnection(): Promise<ConnectionStatus> {
    await delay(900 + Math.random() * 500);
    return "connected";
  },

  listVoices(): VoiceProfile[] {
    return VOICE_CATALOG;
  },

  listHistory(filter: HistoryFilter): { records: HistoryRecord[]; totalPages: number } {
    let records = [...DEMO_HISTORY];

    if (filter.voice) {
      records = records.filter((r) => r.voice === filter.voice);
    }
    if (filter.status) {
      records = records.filter((r) => r.status === filter.status);
    }
    if (filter.source) {
      records = records.filter((r) => r.source === filter.source);
    }

    const totalPages = Math.max(1, Math.ceil(records.length / filter.pageSize));
    const start = (filter.page - 1) * filter.pageSize;
    const page = records.slice(start, start + filter.pageSize);

    return { records: page, totalPages };
  },

  estimateCost(charCount: number, _format: AudioFormat): CostEstimate {
    // Demo cost formula: $0.000002 per character (placeholder)
    const cost = charCount * 0.000002;
    return {
      chars: charCount,
      estimatedCost: `$${cost.toFixed(4)}`,
      formula: `${charCount} chars x $0.000002/char (预估)`,
    };
  },
};
