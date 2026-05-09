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
  verifyError?: string;
}

// ─── Voice Stats ─────────────────────────────────────────────────────────────

export interface VoiceErrorSummary {
  voice?: string;
  errorCode?: string;
  errorMessage: string;
  count: number;
  lastOccurrence?: string;
  /** Legacy field: older backend versions may return { error, count } */
  error?: string;
}

export interface VoiceStats {
  total: number;
  verified: number;
  failed: number;
  unknown: number;
  staleVerified: number;
  neverVerified: number;
  avgLatencyMs: number | null;
  errorSummary: VoiceErrorSummary[];
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
export type HistorySource = "user" | "agent" | "cli";

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
  // Audio metadata
  sampleRate?: number | null;
  bitDepth?: number | null;
  channels?: number | null;
  // Agent context fields (present when source === "agent")
  agentConversationId?: string | null;
  agentActionLogId?: number | null;
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

export type AgentAuthMode = "confirm_each" | "session_auto";

export interface AgentSettings {
  authMode: AgentAuthMode;
  maxRequests: number;
  maxChars: number;
  maxCost: number;
  sessionExpiry: number;
  hasLocalPluginToken: boolean;
  localPluginTokenFingerprint: string | null;
}

// ─── OpenCode Agent Voice Production Tasks ───────────────────────────────────

export type TaskStatus = "draft" | "ready" | "running" | "blocked" | "completed" | "failed";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  description?: string | null;
  owner?: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  documentCount?: number;
  lineCount?: number;
  lastRunStatus?: AgentRunStatus | null;
  documents?: RequirementDocument[];
}

export interface RequirementDocument {
  id: string;
  taskId: string;
  title: string;
  filename?: string | null;
  content: string;
  contentType?: "markdown" | "json" | "text";
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type ResponseFormat = "wav" | "pcm" | "mp3";

export interface VoiceLine {
  id: string;
  isLocalDraft?: boolean;
  sortOrder: number;
  moduleName?: string | null;
  title?: string | null;
  transcript: string;
  voice: string;
  model: string;
  responseFormat: ResponseFormat;
  notes?: string;
  directorProfileId?: string | null;
  directorOverrideJson?: string | null;
  promptProfileId?: string | null;
  speakerLabel?: string | null;
  promptOverride?: PromptOverride | null;
  promptOverrideJson?: string | null;
  generationStatus?: "draft" | "ready" | "pending" | "running" | "succeeded" | "failed" | "needs_revision";
  relatedJobId?: string | null;
  relatedAssetId?: number | null;
  generationErrorCode?: string | null;
  generationErrorMessage?: string | null;
  validationErrors?: string[];
  version?: number;
}

export interface ProductionList {
  taskId: string;
  version: number;
  schemaVersion?: string;
  updatedAt?: string;
  lines: VoiceLine[];
  speakers?: ProductionListSpeaker[];
  directorProfileId?: string | null;
  promptProfiles?: PromptProfile[];
  directorProfiles?: DirectorProfile[];
  promptStructureStatus?: "complete" | "missing" | "incomplete";
  metadata?: Record<string, unknown>;
}

export interface ProductionListSpeaker {
  id: string;
  label: string;
  name?: string;
  voice: string;
  style?: string;
}

export interface DirectorSpeakerProfile {
  id: string;
  label: string;
  name: string;
  voice: string;
  style?: string;
}

export type DirectorProfileSource = "global" | "production-list";

export interface DirectorProfile {
  id: string;
  taskId: string;
  source: DirectorProfileSource;
  name: string;
  audioProfile: string;
  scene: string;
  directorNotes: string;
  sampleContext: string;
  speakers: DirectorSpeakerProfile[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PromptSpeaker extends DirectorSpeakerProfile {}

export interface PromptOverride {
  audioProfile?: string;
  scene?: string;
  directorNotes?: string;
  sampleContext?: string;
  speakers?: PromptSpeaker[];
}

export interface PromptProfile extends DirectorProfile {
  description?: string;
  reusePolicy?: "one-line" | "many-lines";
  sourceDocumentIds?: string[];
}

export interface ValidationIssue {
  lineId?: string;
  field?: keyof VoiceLine | string;
  severity: "error" | "warning";
  message: string;
}

export interface ProductionListValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

// ─── Generation Bridge ────────────────────────────────────────────────────────

export type LineGenerationStatus = "draft" | "ready" | "pending" | "running" | "succeeded" | "failed" | "needs_revision";

export interface LineGenerationResult {
  lineId: string;
  status: "succeeded" | "failed" | "skipped";
  jobId?: string | null;
  assetId?: number | null;
  audioUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface GenerateFromListRequest {
  expectedVersion?: number;
  lineIds?: string[];
  skipCompleted?: boolean;
  source?: "user" | "agent" | "cli";
  confirm?: boolean;
}

export interface GenerateFromListResponse {
  taskId: string;
  version: number;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  results: LineGenerationResult[];
}

export interface ProductionListVersionEntry {
  version: number;
  versionId: string;
  lineCount: number;
  directorProfileId?: string | null;
  createdAt: string;
}

export interface ProductionListDiff {
  fromVersion: number;
  toVersion: number;
  summary: {
    addedCount: number;
    removedCount: number;
    changedCount: number;
    unchangedCount: number;
    fromLineCount: number;
    toLineCount: number;
  };
  added: string[];
  removed: string[];
  changed: Array<{ lineId: string; fields: string[] }>;
}

export interface ProductionListRollbackResult {
  productionList: ProductionList;
  rollback: {
    fromVersion: number;
    targetVersion: number;
    newVersion: number;
  };
}

export type ProductionListExportFormat = "json" | "md" | "csv";

export interface ProductionListExportResult {
  format: ProductionListExportFormat;
  fileName: string;
  content: string;
  mimeType: string;
}

export interface ProductionListImportResult {
  productionList: ProductionList;
  import: {
    importedLines: number;
    skippedLines: number;
    errors?: Array<{ index: number; message: string }>;
    directorWarnings?: string[];
  };
}

export interface ProductionListQualityIssue {
  severity: "info" | "warning" | "error" | string;
  code: string;
  message: string;
  lineId?: string;
}

export interface ProductionListQualityReport {
  taskId: string;
  version: number;
  totalLines: number;
  generatedAt: string;
  metrics: {
    missingFields?: Record<string, number>;
    unboundDirectorCount?: number;
    invalidDirectorReferences?: string[];
    directorReuse?: {
      uniqueProfiles: number;
      sharedProfiles: number;
      maxReuseCount: number;
      reuseDetails: Array<{ profileId: string; lineCount: number }>;
    };
    suspectedDuplicates?: {
      groups: number;
      details: Array<{ text: string; lineIds: string[] }>;
    };
    longText?: {
      threshold: number;
      count: number;
      details: Array<{ lineId: string; length: number }>;
    };
    validationSummary?: Record<string, number>;
    generationSummary?: Record<string, number>;
    [key: string]: unknown;
  };
  issues: ProductionListQualityIssue[];
}

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentButton {
  key: string;
  label: string;
  description?: string;
  scope: "task" | "list" | "line" | "global";
  available: boolean;
  disabledReason?: string | null;
  runner?: "opencode" | "fallback";
}

export interface AgentButtonListResult {
  buttons: AgentButton[];
  opencodeAvailable: boolean;
  runnerMode: "opencode" | "fallback";
  disabledReason: string | null;
}

export interface OpencodeSession {
  id: string;
  taskId?: string | null;
  kind: "automation" | "chat";
  status: AgentRunStatus | "idle";
  buttonKey?: string | null;
  lineId?: string | null;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
}

export type AgentRunKind = "normalize" | "button";

export type CapabilityAvailability =
  | { available: true; reason?: string | null; code?: string | null }
  | { available: false; code: string; reason: string };

export interface AgentRunSummary {
  runId: string;
  taskId: string;
  kind: AgentRunKind;
  buttonKey: string;
  title: string;
  status: AgentRunStatus;
  runner: "opencode" | "fallback";
  targetLineIds: string[];
  beforeVersion?: number;
  afterVersion?: number;
  createdAt: string;
  completedAt?: string | null;
  error?: { code?: string; message: string } | null;
  retry: CapabilityAvailability;
  diff: CapabilityAvailability;
  cancel: CapabilityAvailability;
}

export interface AgentRunDetail extends AgentRunSummary {
  promptSummary?: string;
  inputSnapshot?: unknown;
  outputSnapshot?: unknown;
  normalizeProgress?: NormalizeRunProgress;
  artifactRefs: Array<{ label: string; path?: string; available: boolean }>;
}

export interface AgentRunDiff {
  runId: string;
  available: boolean;
  unavailableReason?: string;
  beforeVersion?: number;
  afterVersion?: number;
  summary?: {
    addedCount: number;
    removedCount: number;
    changedCount: number;
  };
  lineChanges?: Array<{
    lineId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    fields: string[];
  }>;
}

export interface AgentRunCancelResult {
  available: boolean;
  reason: string;
  code?: string;
}

export type NormalizeRunStage =
  | "queued"
  | "preprocessing"
  | "opencode_running"
  | "draft_detected"
  | "validating"
  | "committing"
  | "completed"
  | "failed";

export type NormalizeRunnerStatus = "not_started" | "running" | "completed" | "timeout" | "failed";

export type NormalizeIssueSeverity = "warning" | "blocking";

export interface CandidateExtractionQualitySummary {
  inputLineCount?: number;
  candidateLineCount?: number;
  skippedByReason?: Record<string, number>;
  examplesByReason?: Partial<Record<string, string[]>>;
}

export interface NormalizeQualityIssue {
  code: string;
  severity: NormalizeIssueSeverity | string;
  message: string;
  lineId?: string;
  lineIndex?: number;
  transcriptSample?: string;
  expected?: string;
  actual?: string;
}

export interface NormalizeTimeoutBasis {
  mode?: "quality-priority" | "standard" | string;
  baseTimeoutMs?: number;
  maxTimeoutMs?: number;
  selectedTimeoutMs?: number;
  timeoutMs?: number;
  estimatedLineCount?: number;
  docCount?: number;
  charCount?: number;
  [key: string]: unknown;
}

export interface NormalizeRunProgress {
  ok: true;
  requestId?: string;
  runId: string;
  taskId: string;
  stage: NormalizeRunStage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  elapsedMs: number;
  timeoutMs: number;
  timeoutBasis: NormalizeTimeoutBasis;
  candidateLineCount: number;
  candidateQualitySummary?: CandidateExtractionQualitySummary;
  draft: {
    exists: boolean;
    parseable: boolean;
    sizeBytes: number;
    updatedAt?: string;
  };
  quality: {
    checked: boolean;
    passed?: boolean;
    issueCount?: number;
    blockingIssueCount?: number;
    warningIssueCount?: number;
    issuesPreview?: NormalizeQualityIssue[];
  };
  runner: {
    status: NormalizeRunnerStatus;
  };
  result?: {
    versionId: string;
    lineCount: number;
  };
  error?: {
    code: string;
    message: string;
    httpStatus?: number;
    recoverability: "retryable" | "user_action_required" | "not_retryable" | string;
  };
  message: string;
}

export interface NormalizeStartResponse {
  ok: true;
  status: "accepted";
  requestId?: string;
  runId: string;
  progressUrl: string;
  stage: NormalizeRunStage;
  timeoutMs: number;
  timeoutBasis?: NormalizeTimeoutBasis;
}

export type AgentMessageRole = "user" | "assistant" | "system";

export interface AgentChatMessage {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  status?: "sending" | "sent" | "failed";
  error?: string | null;
}

export interface ExpectedVersionPayload {
  expectedVersion: number;
}

export interface AppSettings {
  openRouterApiKey: string;
  defaultModel: string;
  defaultVoice: string;
  defaultFormat: AudioFormat;
  audioDir: string;
  maxChars: number;
  maxConcurrent: number;
  connectionStatus: ConnectionStatus;
  agent: AgentSettings;
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

// ─── Diagnostics ──────────────────────────────────────────────────────────────

export type DiagnosticsPhase = "idle" | "loading" | "success" | "error";

export interface DiagnosticCheck {
  keyConfigured: boolean;
  dbOk: boolean;
  audioDirWritable: boolean;
  routesReady: boolean;
}

export interface DiagnosticFailedJob {
  id: string;
  voice: string;
  error: string;
  /** Original status from backend (e.g. "failed") */
  status?: string;
  /** Input character count (backend: inputCharCount) */
  charCount?: number;
  /** Error code from backend */
  errorCode?: string | null;
  createdAt: string;
}

export interface DiagnosticAgentAction {
  id: number;
  conversationId?: string | null;
  /** Action type -- adapted from backend actionType */
  action: string;
  /** Action status -- adapted from backend approvalStatus */
  status: string;
  /** Backend raw: actionType */
  actionType?: string;
  /** Backend raw: toolName */
  toolName?: string | null;
  /** Backend raw: approvalStatus */
  approvalStatus?: string;
  createdAt: string;
}

export interface DiagnosticJobSummary {
  id: string;
  voice: string;
  status: string;
  source: string;
  createdAt: string;
  /** Character count -- adapted from backend inputCharCount */
  charCount: number;
}

export interface AudioDirInfo {
  path: string;
  writable: boolean;
  fileCount: number;
  totalSizeBytes: number;
}

export interface Diagnostics {
  status: string;
  timestamp: string;
  uptime: number;
  version: string;
  checks: DiagnosticCheck;
  recentFailedJobs: DiagnosticFailedJob[];
  recentAgentActions: DiagnosticAgentAction[];
  recentJobs: DiagnosticJobSummary[];
  /** Audio directory -- either a plain path string or a structured info object */
  audioDir: string | AudioDirInfo;
}

// ─── Demo / Adapter Service Contract ─────────────────────────────────────────

export interface TtsServiceAdapter {
  generateSpeech(req: GenerateRequest): Promise<GenerateResult>;
  probeVoice(voiceName: string, force?: boolean): Promise<{ status: VoiceStatus; latency: string; cached?: boolean; cacheTtlSeconds?: number | null; lastVerified?: string | null; error?: string }>;
  testConnection(): Promise<ConnectionStatus>;
  listVoices(): VoiceProfile[];
  /** Async voice list for backend-backed adapters */
  listVoicesAsync?(): Promise<{ voices: VoiceProfile[]; stats: VoiceStats }>;
  listHistory(filter: HistoryFilter): { records: HistoryRecord[]; totalPages: number };
  /** Async history list for backend-backed adapters */
  listHistoryAsync?(filter: HistoryFilter): Promise<{ records: HistoryRecord[]; totalPages: number; totalRecords?: number }>;
  estimateCost(charCount: number, format: AudioFormat): CostEstimate;
  /** Director prompt assembly -- calls POST /api/prompts/assemble */
  assemblePrompt?(req: AssemblePromptRequest): Promise<AssemblePromptResponse>;
}
