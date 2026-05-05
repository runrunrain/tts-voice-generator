/**
 * TTS Voice Generator - OpenCode Plugin
 *
 * Registers tools for voice production workflow:
 * - task management (create, list, get)
 * - document management (paste, upload)
 * - production list (get, validate)
 * - agent operations (normalize-requirements, button execute)
 * - chat sessions
 *
 * Usage: Import from OpenCode agent configuration.
 * All paths use forward-slash absolute paths.
 *
 * Note: This is a P0 skeleton. Tool registrations are structurally
 * complete but delegate to the API server for execution.
 */

const TTS_API_BASE = process.env.TTS_API_URL || "http://127.0.0.1:3001";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

interface PluginExport {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

// ─── HTTP Helper ───────────────────────────────────────────────────────────────

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${TTS_API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  return res.json();
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const taskCreate: ToolDefinition = {
  name: "tts_task_create",
  description: "Create a new voice production task",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title" },
      description: { type: "string", description: "Task description (optional)" },
    },
    required: ["title"],
  },
  execute: async (params) => {
    return apiCall("POST", "/api/tasks", {
      title: params.title,
      description: params.description || "",
    });
  },
};

const taskList: ToolDefinition = {
  name: "tts_task_list",
  description: "List all voice production tasks",
  parameters: { type: "object", properties: {} },
  execute: async () => apiCall("GET", "/api/tasks"),
};

const taskGet: ToolDefinition = {
  name: "tts_task_get",
  description: "Get details of a specific task",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
    },
    required: ["taskId"],
  },
  execute: async (params) => apiCall("GET", `/api/tasks/${params.taskId}`),
};

const documentPaste: ToolDefinition = {
  name: "tts_document_paste",
  description: "Paste text content as a requirement document for a task",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
      fileName: { type: "string", description: "Document file name" },
      content: { type: "string", description: "Document text content" },
    },
    required: ["taskId", "fileName", "content"],
  },
  execute: async (params) =>
    apiCall("POST", `/api/tasks/${params.taskId}/documents/paste`, {
      fileName: params.fileName,
      content: params.content,
    }),
};

const documentList: ToolDefinition = {
  name: "tts_document_list",
  description: "List documents for a task",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
    },
    required: ["taskId"],
  },
  execute: async (params) => apiCall("GET", `/api/tasks/${params.taskId}/documents`),
};

const productionGet: ToolDefinition = {
  name: "tts_production_get",
  description: "Get the production list for a task",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
    },
    required: ["taskId"],
  },
  execute: async (params) => apiCall("GET", `/api/tasks/${params.taskId}/production-list`),
};

const productionValidate: ToolDefinition = {
  name: "tts_production_validate",
  description: "Validate the production list for a task",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
    },
    required: ["taskId"],
  },
  execute: async (params) =>
    apiCall("POST", `/api/tasks/${params.taskId}/production-list/validate`, {}),
};

const normalizeRequirements: ToolDefinition = {
  name: "tts_normalize_requirements",
  description: "Normalize requirement documents into a production list using deterministic rules",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
    },
    required: ["taskId"],
  },
  execute: async (params) =>
    apiCall("POST", `/api/tasks/${params.taskId}/agent/normalize-requirements`, {}),
};

const buttonExecute: ToolDefinition = {
  name: "tts_button_execute",
  description: "Execute an agent button (shorten/expand/rewrite/style) on a specific voice line",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
      buttonKey: { type: "string", description: "Button key (e.g. shorten, expand, rewrite, style-formal)" },
      targetLineId: { type: "string", description: "Voice line ID to transform" },
      expectedVersion: { type: "number", description: "Current production list version for conflict detection" },
      parameters: { type: "object", description: "Additional parameters for the transform" },
    },
    required: ["taskId", "buttonKey", "targetLineId", "expectedVersion"],
  },
  execute: async (params) =>
    apiCall("POST", `/api/tasks/${params.taskId}/agent/buttons/${params.buttonKey}/execute`, {
      targetLineId: params.targetLineId,
      expectedVersion: params.expectedVersion,
      parameters: params.parameters || {},
    }),
};

const buttonsList: ToolDefinition = {
  name: "tts_buttons_list",
  description: "List available agent button presets",
  parameters: { type: "object", properties: {} },
  execute: async () => apiCall("GET", "/api/agent/buttons"),
};

const directorProfileList: ToolDefinition = {
  name: "tts_director_profiles",
  description: "List director profiles",
  parameters: { type: "object", properties: {} },
  execute: async () => apiCall("GET", "/api/director-profiles"),
};

const saveProductionList: ToolDefinition = {
  name: "tts_save_production_list",
  description: "Save (replace) the full production list for a task with version conflict detection. Use this after generating a complete production list from requirement documents.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
      expectedVersion: { type: "number", description: "Current production list version for conflict detection. Use 0 for new lists." },
      lines: {
        type: "array",
        description: "Array of voice lines. Each line must have: id, order, speaker, text, voice.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique line ID (e.g. line_001)" },
            order: { type: "number", description: "Sort order (0-based)" },
            speaker: { type: "string", description: "Speaker ID matching a speaker in the speakers array" },
            text: { type: "string", description: "Transcript text for TTS generation" },
            voice: { type: "string", description: "Voice name (e.g. Zephyr)" },
            style: { type: "string", description: "Optional style instruction" },
            notes: { type: "string", description: "Optional notes" },
            model: { type: "string", description: "TTS model (default: google/gemini-3.1-flash-tts-preview)" },
            responseFormat: { type: "string", enum: ["wav", "pcm", "mp3"], description: "Audio format (default: wav)" },
            directorProfileId: { type: "string", description: "Optional director profile ID to bind" },
          },
          required: ["id", "order", "speaker", "text", "voice"],
        },
      },
      speakers: {
        type: "array",
        description: "Array of speakers (max 2). Each speaker must have: id, label, voice.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Speaker ID (e.g. narrator)" },
            label: { type: "string", description: "Display label (e.g. Narrator)" },
            name: { type: "string", description: "Display name (e.g. narrator)" },
            voice: { type: "string", description: "Voice name" },
            style: { type: "string", description: "Style instruction" },
          },
          required: ["id", "label", "voice"],
        },
      },
      directorProfileId: { type: "string", description: "Optional default director profile ID for the list" },
      metadata: { type: "object", description: "Optional metadata object" },
    },
    required: ["taskId", "expectedVersion", "lines"],
  },
  execute: async (params) =>
    apiCall("PUT", `/api/tasks/${params.taskId}/production-list`, {
      expectedVersion: params.expectedVersion,
      lines: params.lines,
      speakers: params.speakers || [],
      directorProfileId: params.directorProfileId || null,
      metadata: params.metadata || {},
    }),
};

const patchVoiceLines: ToolDefinition = {
  name: "tts_patch_voice_lines",
  description: "Apply a domain-level patch to the production list. Supported operations: updateLine, addLine, removeLine, reorderLines, updateSpeakers, updateDirectorProfile.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
      op: {
        type: "string",
        enum: ["updateLine", "addLine", "removeLine", "reorderLines", "updateSpeakers", "updateDirectorProfile"],
        description: "Patch operation type",
      },
      payload: {
        type: "object",
        description: "Operation-specific payload. updateLine: {lineId, updates}. addLine: {afterLineId?, line}. removeLine: {lineId}. reorderLines: {lineIds}. updateSpeakers: {speakers}. updateDirectorProfile: {directorProfileId, lineIds?}.",
      },
      expectedVersion: { type: "number", description: "Current production list version for conflict detection" },
    },
    required: ["taskId", "op", "payload", "expectedVersion"],
  },
  execute: async (params) =>
    apiCall("PATCH", `/api/tasks/${params.taskId}/production-list`, {
      op: params.op,
      payload: params.payload,
      expectedVersion: params.expectedVersion,
    }),
};

// ─── Plugin Export ─────────────────────────────────────────────────────────────

const plugin: PluginExport = {
  name: "tts-voice-generator",
  version: "0.2.0",
  tools: [
    taskCreate,
    taskList,
    taskGet,
    documentPaste,
    documentList,
    productionGet,
    productionValidate,
    normalizeRequirements,
    buttonExecute,
    buttonsList,
    directorProfileList,
    saveProductionList,
    patchVoiceLines,
  ],
};

export default plugin;
export { plugin, TTS_API_BASE };
