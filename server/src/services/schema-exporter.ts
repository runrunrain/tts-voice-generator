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
import { formatVoiceGenderSelectionRulesForPrompt, formatVoiceSelectionGuideForPrompt } from "../utils/voice.js";

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
      "Prompt-Structured Production List v2，包含可复用的中文 promptProfiles 与台词 lines。" +
      "每条台词必须绑定完整的中文导演配置：音频档案、场景、导演备注字段（style、pacing、accent、emotion、performanceNotes）、示例上下文、说话人和干净台词。",
    rootType: "object",
    fields: [
      {
        name: "schemaVersion",
        type: "string",
        required: true,
          description: "Agent normalize 输出必须固定为 tts.production-list.v2。",
          constraints: ["使用 tts.production-list.v2"],
        defaultValue: "tts.production-list.v2",
      },
      {
        name: "promptProfiles",
        type: "array",
        required: true,
          description: "可复用的完整中文导演配置。每条 line 必须通过 promptProfileId 引用其中一个 profile。",
          constraints: ["至少 1 个 profile", "每个 profile 具有完整五要素中文提示字段", "每个 profile 的 speakers 为 1 到 2 个"],
      },
      {
        name: "lines",
        type: "array",
        required: true,
          description: "待生成的台词数组。每条 line 是绑定到 prompt profile 的单个 TTS 单元。",
          constraints: ["Agent normalize 输出至少 1 条 line", "每条 line 必须包含 transcript 和 promptProfileId"],
      },
      {
        name: "speakers",
        type: "array",
        required: false,
          description: "兼容用聚合 speaker 列表。Agent 可以省略，由服务端从 promptProfiles[].speakers 推导。",
          constraints: ["如果出现，每个 speaker 必须有唯一 id", "如果出现，必须与 promptProfiles[].speakers 对齐"],
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
          description: "Gemini/OpenRouter voice name selected for this line's role, emotion, scene, and transcript semantics.",
          constraints: ["Must be non-empty", "Must match the line text and role context; Zephyr is only a neutral fallback"],
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
        { name: "id", type: "string", required: true, description: "数据集内唯一 profile id，例如 profile_vendor_market。", constraints: ["必须非空", "在 promptProfiles 内唯一"] },
        { name: "name", type: "string", required: true, description: "中文可读 profile 名称。", constraints: ["必须非空", "必须使用简体中文"] },
        { name: "description", type: "string", required: false, description: "可选中文 profile 描述。" },
        { name: "audioProfile", type: "string", required: true, description: "Gemini 音频档案：用简体中文描述角色、声线质感、年龄感、音色和身份。", constraints: ["必须非空", "必须使用简体中文", "不得为占位文本"] },
        { name: "scene", type: "string", required: true, description: "Gemini 场景：用简体中文描述环境、空间、氛围和叙事上下文。", constraints: ["必须非空", "必须使用简体中文", "不得为占位文本"] },
        { name: "directorNotes", type: "string", required: true, description: "中文导演备注。为兼容保留；其他表演备注也可写入 performanceNotes。", constraints: ["必须非空", "必须使用简体中文", "不得为占位文本"] },
        { name: "sampleContext", type: "string", required: true, description: "Gemini 示例上下文：用简体中文说明模型需要进入的情境。", constraints: ["必须非空", "必须使用简体中文", "不得为占位文本"] },
        { name: "style", type: "string", required: false, description: "中文整体表演风格，例如克制的战地旁白、温和的教学说明。", defaultValue: "" },
        { name: "pacing", type: "string", required: false, description: "中文节奏说明：速度、韵律和停顿模式。Gemini/OpenRouter 不应依赖 provider speed。", defaultValue: "" },
        { name: "accent", type: "string", required: false, description: "中文口音、咬字或发音要求；没有来源证据时可说明普通清晰咬字。", defaultValue: "" },
        { name: "emotion", type: "string", required: false, description: "中文基础情绪基调。", defaultValue: "" },
        { name: "performanceNotes", type: "string", required: false, description: "中文表演备注；不得写入 transcript。", defaultValue: "" },
        { name: "speakers", type: "array", required: true, description: "绑定到此 profile 的台词使用的说话人。", constraints: ["1 到 2 个 speakers", "每个 speaker 有 id、label、voice"] },
        { name: "reusePolicy", type: "enum", required: false, description: "此 profile 用于单行还是多行。", enumValues: ["one-line", "many-lines"] },
        { name: "sourceDocumentIds", type: "array", required: false, description: "用于推导此 profile 的需求文档 id。" },
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
      "Agent normalize 输出必须是 Prompt-Structured Production List v2，schemaVersion 为 tts.production-list.v2。",
      "promptProfiles 必填，且必须至少包含一个完整的中文 prompt profile。",
      "所有导演配置值必须使用简体中文；字段名、id、Gemini voice 名称和 model 名称保持英文枚举。",
      "每个 prompt profile 必须包含非空中文 audioProfile、scene、directorNotes、sampleContext 和 speakers；来源支持时应包含简洁中文 style、pacing、accent、emotion 和 performanceNotes。",
      "每个 promptProfile 都要提取中文导演表演字段：style、pacing、accent、emotion 和 performanceNotes；不要把这些指导塞进 transcript。",
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
      "Voice selection must match source metadata, role, scene, emotion, and transcript semantics; do not blindly choose the default voice for all lines.",
      formatVoiceGenderSelectionRulesForPrompt(),
      `Available Gemini voice guide:\n${formatVoiceSelectionGuideForPrompt()}`,
      'Default voice is "Zephyr" only when no source role, voice metadata, or transcript cue suggests a better match; default model is "google/gemini-3.1-flash-tts-preview".',
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
        speakerLabel: "旁白",
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
        label: "旁白",
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
