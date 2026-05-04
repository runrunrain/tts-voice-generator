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

export type AudioFormat = "wav" | "pcm" | "mp3";

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
  sampleContext?: string;
  /**
   * Original user transcript (before prompt assembly).
   * Stored in directorSnapshot.transcript so the assembled prompt
   * (passed as `text`) does not overwrite the user's raw input.
   */
  transcript?: string;
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
  // Audio asset fields from backend (null when no asset)
  assetId?: number | null;
  audioUrl?: string | null;
  downloadUrl?: string | null;
  durationMs?: number | null;
  assetFormat?: string | null;
  sizeBytes?: number | null;
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

// ─── Prompt Assembly (Director) ──────────────────────────────────────────────

export interface AssembleSpeakerInput {
  id: string;
  label: string;
  name?: string;
  voice?: string;
  style?: string;
}

export interface AssemblePromptRequest {
  audioProfile?: string;
  scene?: string;
  directorNotes?: string;
  sampleContext?: string;
  transcript: string;
  speakers?: AssembleSpeakerInput[];
}

export interface PromptWarning {
  code: string;
  message: string;
  field?: string;
}

export interface NormalizedSpeaker {
  id: string;
  label: string;
  name: string;
  voice: string;
  style: string;
  wasLegacyAlias: boolean;
}

export interface AssemblePromptSuccess {
  ok: true;
  requestId: string;
  prompt: string;
  warnings: PromptWarning[];
  normalized: {
    speakers: NormalizedSpeaker[];
    audioProfile: string;
    scene: string;
    directorNotes: string;
    sampleContext: string;
    transcript: string;
  };
}

export interface AssemblePromptError {
  ok: false;
  requestId: string;
  error: {
    code: string;
    message: string;
    category?: string;
    retryable?: boolean;
    metadata?: Record<string, unknown>;
  };
}

export type AssemblePromptResponse = AssemblePromptSuccess | AssemblePromptError;

export type AssemblePhase = "idle" | "loading" | "success" | "error";

export interface AssembleResult {
  phase: AssemblePhase;
  response: AssemblePromptResponse | null;
  error?: {
    code: string;
    message: string;
  };
}

// ─── Demo / Adapter Service Contract ─────────────────────────────────────────

export interface TtsServiceAdapter {
  generateSpeech(req: GenerateRequest): Promise<GenerateResult>;
  probeVoice(voiceName: string): Promise<{ status: VoiceStatus; latency: string }>;
  testConnection(): Promise<ConnectionStatus>;
  listVoices(): VoiceProfile[];
  /** Async voice list for backend-backed adapters */
  listVoicesAsync?(): Promise<VoiceProfile[]>;
  listHistory(filter: HistoryFilter): { records: HistoryRecord[]; totalPages: number };
  /** Async history list for backend-backed adapters */
  listHistoryAsync?(filter: HistoryFilter): Promise<{ records: HistoryRecord[]; totalPages: number; totalRecords?: number }>;
  estimateCost(charCount: number, format: AudioFormat): CostEstimate;
  /** Director prompt assembly -- calls POST /api/prompts/assemble */
  assemblePrompt?(req: AssemblePromptRequest): Promise<AssemblePromptResponse>;
}
