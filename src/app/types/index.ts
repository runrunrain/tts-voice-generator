/**
 * TTS Voice Generator - Type Definitions
 *
 * These types define the contract between the UI layer and the service/adapter layer.
 * When real backend integration happens, adapters implement these interfaces.
 */

// ─── Voice ───────────────────────────────────────────────────────────────────

export type VoiceStatus = "success" | "warning" | "error" | "pending";

export interface VoiceProfile {
  name: string;
  isDefault: boolean;
  role: string;
  provider: string;
  status: VoiceStatus;
  lastVerified: string;
  verifyDuration?: string;
}

// ─── Generation Request / Result ─────────────────────────────────────────────

export type AudioFormat = "mp3" | "pcm";

export interface GenerateRequest {
  text: string;
  voice: string;
  format: AudioFormat;
  style?: string;
  /** Optional speaker config for Director mode */
  speakers?: SpeakerConfig[];
  /** Optional director fields */
  audioProfile?: string;
  scene?: string;
  directorNotes?: string;
}

export type GeneratePhase = "idle" | "loading" | "success" | "error";

export interface GenerateResult {
  jobId: string;
  phase: GeneratePhase;
  voice: string;
  format: AudioFormat;
  charCount: number;
  duration: string;
  estimatedCost: string;
  audioUrl?: string;
  error?: {
    code: string;
    message: string;
  };
  timestamp: string;
  /** Demo flag -- true means this is not real output */
  isDemo: boolean;
}

// ─── Director ────────────────────────────────────────────────────────────────

export interface SpeakerConfig {
  id: string;
  label: string;     // "Speaker A" / "Speaker B"
  name: string;      // display name e.g. "主持人"
  voice: string;
  style: string;
}

// ─── History ─────────────────────────────────────────────────────────────────

export type HistoryStatus = "success" | "error" | "pending";
export type HistorySource = "用户" | "Agent";

export interface HistoryRecord {
  id: string;
  text: string;
  voice: string;
  format: AudioFormat;
  date: string;
  source: HistorySource;
  duration: string;
  status: HistoryStatus;
  error?: string;
  cost?: string;
  charCount?: number;
}

export interface HistoryFilter {
  voice?: string;
  status?: HistoryStatus;
  source?: HistorySource;
  page: number;
  pageSize: number;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export type ConnectionStatus = "untested" | "testing" | "connected" | "failed";

export interface AppSettings {
  openRouterApiKey: string;
  defaultModel: string;
  defaultVoice: string;
  defaultFormat: AudioFormat;
  audioDir: string;
  maxChars: number;
  maxConcurrent: number;
  connectionStatus: ConnectionStatus;
}

// ─── Cost Estimation ─────────────────────────────────────────────────────────

export interface CostEstimate {
  chars: number;
  estimatedCost: string;
  /** Formula label for display */
  formula: string;
}

// ─── Demo / Adapter Service Contract ─────────────────────────────────────────

export interface TtsServiceAdapter {
  generateSpeech(req: GenerateRequest): Promise<GenerateResult>;
  probeVoice(voiceName: string): Promise<{ status: VoiceStatus; latency: string }>;
  testConnection(): Promise<ConnectionStatus>;
  listVoices(): VoiceProfile[];
  listHistory(filter: HistoryFilter): { records: HistoryRecord[]; totalPages: number };
  estimateCost(charCount: number, format: AudioFormat): CostEstimate;
}
