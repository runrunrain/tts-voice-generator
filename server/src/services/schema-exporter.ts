/**
 * Schema Exporter - Generates a production-list schema snapshot from
 * Zod validators for Agent consumption.
 *
 * The schema snapshot includes field definitions, constraints, enums,
 * speaker rules, and business validation logic in a format the Agent
 * can use to produce valid JSON drafts.
 *
 * Security: No API keys, tokens, or environment values are included.
 */

import fs from "node:fs";

export interface SchemaField {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "array" | "object";
  required: boolean;
  description: string;
  constraints?: string[];
  enumValues?: string[];
  defaultValue?: unknown;
}

export interface SchemaSnapshot {
  name: "PromptStructuredProductionList";
  version: "2.0";
  description: string;
  rootType: "object";
  fields: SchemaField[];
  nestedSchemas: {
    VoiceLine: SchemaField[];
    Speaker: SchemaField[];
    PromptProfile: SchemaField[];
    PromptSpeaker: SchemaField[];
    PromptOverride: SchemaField[];
  };
  businessRules: string[];
  examples: {
    validLine: Record<string, unknown>;
    validSpeaker: Record<string, unknown>;
  };
}

/**
 * Generate the ProductionList schema snapshot.
 * This is derived from the Zod schemas in validators.ts to ensure
 * consistency between Agent-facing schema and backend validation.
 */
export function generateProductionListSchemaSnapshot(): SchemaSnapshot {
  return {
    name: "PromptStructuredProductionList",
    version: "2.0",
    description:
      "A Prompt-Structured Production List v2 containing reusable promptProfiles and line transcripts. " +
      "Each generated line must bind to a complete prompt profile with Audio Profile, Scene, structured Director's Notes fields (style, pacing, accent, emotion, performanceNotes), Sample Context, speakers, and a clean Transcript.",
    rootType: "object",
    fields: [
      {
        name: "schemaVersion",
        type: "string",
        required: true,
        description: "Must be exactly tts.production-list.v2 for Agent normalize output.",
        constraints: ["Use tts.production-list.v2"],
        defaultValue: "tts.production-list.v2",
      },
      {
        name: "promptProfiles",
        type: "array",
        required: true,
        description: "Reusable complete prompt profiles. Each line must reference one by promptProfileId.",
        constraints: ["At least 1 profile", "Each profile has complete five-element prompt fields", "Profile speakers: 1 to 2"],
      },
      {
        name: "lines",
        type: "array",
        required: true,
        description: "Array of transcript lines to generate. Each line is a single TTS unit bound to a prompt profile.",
        constraints: ["At least 1 line for Agent normalize output", "Each line must include transcript and promptProfileId"],
      },
      {
        name: "speakers",
        type: "array",
        required: false,
        description: "Compatibility aggregate speaker list. It may be omitted by the Agent or derived by the server from promptProfiles[].speakers.",
        constraints: ["Each speaker must have unique id when present", "Must align with promptProfiles[].speakers when present"],
      },
    ],
    nestedSchemas: {
      VoiceLine: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Unique identifier for the line. Use UUID v4 format.",
          constraints: ["Must be non-empty"],
          defaultValue: "auto-generated UUID",
        },
        {
          name: "order",
          type: "number",
          required: true,
          description: "Sequential order index starting from 0.",
          constraints: ["Integer >= 0", "Must be unique across all lines"],
          defaultValue: 0,
        },
        {
          name: "speaker",
          type: "string",
          required: true,
          description: "ID of the speaker for this line. Must reference a valid speaker id.",
          constraints: ["Must match a speaker id in the speakers array"],
          defaultValue: "narrator",
        },
        {
          name: "transcript",
          type: "string",
          required: true,
          description: "The exact line transcript to speak. This is the v2 semantic source for TTS content.",
          constraints: ["Must be non-empty", "Must contain semantic characters", "If text is also present it must match transcript after trim"],
        },
        {
          name: "text",
          type: "string",
          required: false,
          description:
            "Compatibility alias for transcript. If present it must match transcript after trim.",
          constraints: [
            "Must match transcript after trim",
          ],
        },
        {
          name: "promptProfileId",
          type: "string",
          required: true,
          description: "ID of the prompt profile that supplies Audio Profile, Scene, Director's Notes, Sample Context, and speakers.",
          constraints: ["Must reference an existing promptProfiles[].id"],
        },
        {
          name: "speakerLabel",
          type: "string",
          required: false,
          description: "Human readable speaker label used in transcript context.",
        },
        {
          name: "voice",
          type: "string",
          required: true,
          description: "Voice name for TTS generation.",
          constraints: ["Must be non-empty"],
          defaultValue: "Zephyr",
        },
        {
          name: "style",
          type: "string",
          required: false,
          description: "Line-level performance or delivery override. This is director metadata and MUST NOT be copied into transcript/text.",
          constraints: ["Keep concise", "Use only when this line changes delivery", "Never duplicate as spoken transcript"],
          defaultValue: "",
        },
        {
          name: "notes",
          type: "string",
          required: false,
          description: "Notes or comments about this line.",
          defaultValue: "",
        },
        {
          name: "status",
          type: "enum",
          required: false,
          description: "Processing status of the line.",
          enumValues: ["pending", "approved", "generating", "generated", "failed"],
          defaultValue: "pending",
        },
        {
          name: "model",
          type: "string",
          required: false,
          description: "TTS model identifier.",
          defaultValue: "google/gemini-3.1-flash-tts-preview",
        },
        {
          name: "responseFormat",
          type: "enum",
          required: false,
          description: "Audio output format.",
          enumValues: ["wav", "pcm", "mp3"],
          defaultValue: "wav",
        },
        {
          name: "directorProfileId",
          type: "string",
          required: false,
          description: "Compatibility alias for promptProfileId. Set to the same value when present.",
        },
        {
          name: "promptOverride",
          type: "object",
          required: false,
          description: "Optional per-line override for profile prompt fields. It must not override transcript.",
        },
        {
          name: "generationStatus",
          type: "enum",
          required: false,
          description: "TTS generation tracking status.",
          enumValues: ["draft", "ready", "pending", "running", "succeeded", "failed", "needs_revision"],
          defaultValue: "draft",
        },
      ],
      Speaker: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Unique speaker identifier. Lowercase, hyphenated.",
          constraints: ["Must be non-empty", "Unique across speakers"],
          defaultValue: "narrator",
        },
        {
          name: "label",
          type: "string",
          required: true,
          description: "Human-readable speaker name.",
          constraints: ["Must be non-empty"],
          defaultValue: "Narrator",
        },
        {
          name: "name",
          type: "string",
          required: false,
          description: "Optional full name of the speaker.",
          defaultValue: "",
        },
        {
          name: "voice",
          type: "string",
          required: true,
          description: "Voice name for this speaker.",
          defaultValue: "Zephyr",
        },
        {
          name: "style",
          type: "string",
          required: false,
          description: "Voice style for this speaker.",
          defaultValue: "",
        },
      ],
      PromptProfile: [
        { name: "id", type: "string", required: true, description: "Dataset-unique profile id, e.g. profile_vendor_market.", constraints: ["Must be non-empty", "Unique within promptProfiles"] },
        { name: "name", type: "string", required: true, description: "Human-readable profile name.", constraints: ["Must be non-empty"] },
        { name: "description", type: "string", required: false, description: "Optional profile description." },
        { name: "audioProfile", type: "string", required: true, description: "Gemini Audio Profile: character, voice texture, age, tone, identity.", constraints: ["Must be non-empty", "Must not be placeholder text"] },
        { name: "scene", type: "string", required: true, description: "Gemini Scene: setting, space, atmosphere, narrative context.", constraints: ["Must be non-empty", "Must not be placeholder text"] },
        { name: "directorNotes", type: "string", required: true, description: "Legacy Gemini Director's Notes. Keep for compatibility; residual notes also go to performanceNotes.", constraints: ["Must be non-empty", "Must not be placeholder text"] },
        { name: "sampleContext", type: "string", required: true, description: "Gemini Sample Context: brief context that places the model in the scenario.", constraints: ["Must be non-empty", "Must not be placeholder text"] },
        { name: "style", type: "string", required: false, description: "Overall performance style for the profile, e.g. restrained battlefield narration or warm instructional delivery.", defaultValue: "" },
        { name: "pacing", type: "string", required: false, description: "Speed, rhythm, and pause pattern. Do not rely on provider speed for Gemini/OpenRouter.", defaultValue: "" },
        { name: "accent", type: "string", required: false, description: "Accent, diction, or pronunciation requirement. Leave empty when there is no source evidence.", defaultValue: "" },
        { name: "emotion", type: "string", required: false, description: "Baseline emotional tone for the profile.", defaultValue: "" },
        { name: "performanceNotes", type: "string", required: false, description: "Residual director-performance guidance that does not fit style, pacing, accent, or emotion. Never put this text in transcript.", defaultValue: "" },
        { name: "speakers", type: "array", required: true, description: "Speakers used by lines bound to this profile.", constraints: ["1 to 2 speakers", "Each speaker has id, label, voice"] },
        { name: "reusePolicy", type: "enum", required: false, description: "Whether this profile is intended for one or many lines.", enumValues: ["one-line", "many-lines"] },
        { name: "sourceDocumentIds", type: "array", required: false, description: "Requirement document ids used to derive this profile." },
      ],
      PromptSpeaker: [
        { name: "id", type: "string", required: true, description: "Speaker id referenced by line.speaker.", constraints: ["Must be non-empty"] },
        { name: "label", type: "string", required: true, description: "Speaker label used in transcript and prompt.", constraints: ["Must be non-empty"] },
        { name: "name", type: "string", required: false, description: "Optional speaker name." },
        { name: "voice", type: "string", required: true, description: "Gemini/OpenRouter voice name.", constraints: ["Must be non-empty"] },
        { name: "style", type: "string", required: false, description: "Optional speaker style descriptor for role-specific delivery; do not copy it into transcript." },
      ],
      PromptOverride: [
        { name: "audioProfile", type: "string", required: false, description: "Optional Audio Profile override." },
        { name: "scene", type: "string", required: false, description: "Optional Scene override." },
        { name: "directorNotes", type: "string", required: false, description: "Optional legacy Director's Notes override; merged into Performance Notes." },
        { name: "sampleContext", type: "string", required: false, description: "Optional Sample Context override." },
        { name: "style", type: "string", required: false, description: "Optional line/profile Style override for Director's Notes." },
        { name: "pacing", type: "string", required: false, description: "Optional line/profile Pacing override for Director's Notes." },
        { name: "accent", type: "string", required: false, description: "Optional line/profile Accent override for Director's Notes." },
        { name: "emotion", type: "string", required: false, description: "Optional line/profile Emotion override for Director's Notes." },
        { name: "performanceNotes", type: "string", required: false, description: "Optional performance note override; never write into transcript." },
        { name: "speakers", type: "array", required: false, description: "Optional speakers override, still limited to 1 to 2 speakers." },
      ],
    },
    businessRules: [
      "Agent normalize output MUST be Prompt-Structured Production List v2 with schemaVersion tts.production-list.v2.",
      "promptProfiles is required and must contain at least one complete prompt profile.",
      "Each prompt profile must include non-empty audioProfile, scene, directorNotes, sampleContext, and speakers, and should include concise style, pacing, accent, emotion, and performanceNotes when supported by the source.",
      "For every promptProfile, extract director-performance fields: style, pacing, accent, emotion, and performanceNotes; do not collapse all guidance into transcript.",
      "lines[].style is a line-level delivery override only. It may preserve stage directions or mood labels, but must never be written into transcript/text.",
      "Transcript/text must contain only spoken words. Move Style:, Pacing:, Accent:, Emotion:, Director's Notes:, Performance Notes:, and markdown prompt headings out of transcript.",
      "Do not invent inline audio tags or insert unsupported tags into transcript. Use natural-language style fields unless an explicit allowlist is introduced.",
      "Placeholder prompt fields such as TODO, TBD, N/A, 待补充, 暂无, 空 are invalid.",
      "Each profile may define 1 to 2 speakers; each speaker must have id, label, and voice.",
      "Every line must include transcript and promptProfileId; text is only a compatibility alias for transcript.",
      "line.promptProfileId must reference an existing promptProfiles[].id.",
      "line.speaker must be one of the bound profile's speaker ids.",
      "Generate-ready prompt materialization is profile or override plus line transcript.",
      "Speaker limits are profile-scoped: each promptProfile supports 1 to 2 speakers, but different promptProfiles may define different role speakers across the dataset.",
      'Default voice is "Zephyr", default model is "google/gemini-3.1-flash-tts-preview".',
      'Default responseFormat is "wav".',
      "Each line transcript must have semantic content.",
      "Lines with only punctuation or Markdown syntax are rejected (e.g. ：：：, ！！！, 。。。, ---).",
      "Speaker IDs in lines must reference valid speakers in the bound promptProfile speakers array.",
      "Line orders must be unique and sequential starting from 0.",
      "All IDs should be UUID v4 format for consistency.",
      "Detect speaker prefixes like 'A:', 'B:', 'Speaker1:' in source text and map to speaker IDs.",
      "For Markdown requirement documents, derive line.speakerLabel, line.voice, and promptProfiles[].speakers from section headings plus voice metadata fields such as 声线, 音色, 角色, 说话人, speaker, voice, character, and role.",
      "Multiple source roles with different voice metadata must not all be emitted as Narrator with Zephyr; available voice names may be reused by reasonable groups, but speakerLabel and profile speakers must preserve role differences.",
      "Each promptProfile's speakers must match the role and voice metadata of the lines bound to that profile.",
      "Split long content into logical sentences or dialogue turns.",
    ],
    examples: {
      validLine: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        order: 0,
        speaker: "narrator",
        speakerLabel: "Narrator",
        transcript: "你好，世界！这是第一条语音台词。",
        text: "你好，世界！这是第一条语音台词。",
        promptProfileId: "profile_narrator_default",
        directorProfileId: "profile_narrator_default",
        voice: "Zephyr",
        style: "",
        notes: "",
        status: "pending",
        model: "google/gemini-3.1-flash-tts-preview",
        responseFormat: "wav",
        generationStatus: "draft",
      },
      validSpeaker: {
        id: "narrator",
        label: "Narrator",
        voice: "Zephyr",
        style: "",
      },
    },
  };
}

/**
 * Write the schema snapshot to a file.
 * Uses atomic write (temp file + rename).
 */
export function writeSchemaSnapshot(schemaPath: string, snapshot?: SchemaSnapshot): void {
  const data = snapshot ?? generateProductionListSchemaSnapshot();
  const content = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(content, "utf-8");
  const tempPath = schemaPath + ".tmp";

  try {
    fs.writeFileSync(tempPath, buffer, "utf-8");
    fs.renameSync(tempPath, schemaPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}
