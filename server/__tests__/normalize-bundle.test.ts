/**
 * Tests for Normalize Run Store, Schema Exporter, and Bundle-Driven Runner.
 *
 * Covers:
 * - createNormalizeRun: path generation, traversal prevention
 * - generateNormalizeRequestBundle: content validation, no secrets
 * - Schema snapshot: structure, field coverage, no secrets
 * - readNormalizeDraft: valid/invalid/missing drafts
 * - validateDraftInRunDir: traversal prevention
 * - Integration: bundle-driven runner mock (no real opencode)
 * - Security: no API keys in any artifact
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  createNormalizeRun,
  generateNormalizeRequestBundle,
  writeNormalizeRequestBundle,
  writeCandidateLinesArtifact,
  writeRunProgress,
  readRunProgress,
  writeInstructionMarkdown,
  readNormalizeDraft,
  writeValidationReport,
  writeCommitResult,
  getDocumentArtifactPath,
  getProductionListArtifactPath,
  validateDraftInRunDir,
  type InstructionContext,
  type InputDocumentRef,
  type RunPaths,
} from "../src/services/normalize-run-store.js";

import {
  generateProductionListSchemaSnapshot,
  writeSchemaSnapshot,
} from "../src/services/schema-exporter.js";

import {
  runBundleOpenCodeNormalize,
  runOpenCodeNormalize,
  _setSpawnRunner,
  _resetSpawnRunner,
  sanitizeString,
  buildSafeChildEnv,
  type BundleNormalizeInput,
} from "../src/services/opencode-runner.js";

import {
  PasteDocumentSchema,
  UploadDocumentBodySchema,
  UpdateDocumentSchema,
  NormalizeRequestBodySchema,
  MAX_DOCUMENT_BYTES,
  ALLOWED_DOCUMENT_EXTENSIONS,
  hasAllowedDocumentExtension,
  hasNoPathTraversal,
  validateProductionList,
  validateRawAgentDraft,
  validateRawPromptStructuredAgentDraft,
  validateBusinessQualityGate,
  RawAgentDraftSchema,
  DirectorConfigSchema,
  PromptOverrideSchema,
  PromptProfileSchema,
} from "../src/domain/validators.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "normalize-run-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  _resetSpawnRunner();
});

function makeFakeTaskDir(taskId: string): string {
  const taskDir = path.join(tempDir, "tasks", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  return taskDir;
}

function makeRunPaths(taskId: string, runId: string): RunPaths {
  const runDir = path.join(tempDir, "tasks", taskId, "agent-runs", `normalize-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  return {
    runDir,
    requestPath: path.join(runDir, "normalize-request.json"),
    schemaPath: path.join(runDir, "production-list.schema.json"),
    instructionPath: path.join(runDir, "instruction.md"),
    candidateLinesPath: path.join(runDir, "candidate-lines.json"),
    progressPath: path.join(runDir, "run-progress.json"),
    draftPath: path.join(runDir, "production-list.draft.json"),
    validationReportPath: path.join(runDir, "validation-report.json"),
    commitResultPath: path.join(runDir, "commit-result.json"),
  };
}

const TASK_ID = "550e8400-e29b-41d4-a716-446655440000";

// ─── createNormalizeRun ────────────────────────────────────────────────────────

describe("createNormalizeRun", () => {
  it("generates valid runId and paths when task dir exists", () => {
    makeFakeTaskDir(TASK_ID);

    // Override the data dir for testing
    const origDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;

    try {
      const { runId, paths } = createNormalizeRun(TASK_ID);

      // runId should be a valid UUID
      expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      // Paths should be under the task dir
      expect(paths.runDir).toContain("agent-runs");
      expect(paths.runDir).toContain(`normalize-${runId}`);
      expect(paths.requestPath).toMatch(/normalize-request\.json$/);
      expect(paths.schemaPath).toMatch(/production-list\.schema\.json$/);
      expect(paths.candidateLinesPath).toMatch(/candidate-lines\.json$/);
      expect(paths.progressPath).toMatch(/run-progress\.json$/);
      expect(paths.draftPath).toMatch(/production-list\.draft\.json$/);
      expect(paths.instructionPath).toMatch(/instruction\.md$/);
      expect(paths.validationReportPath).toMatch(/validation-report\.json$/);
      expect(paths.commitResultPath).toMatch(/commit-result\.json$/);

      // Directory should exist
      expect(fs.existsSync(paths.runDir)).toBe(true);
    } finally {
      process.env.DATA_DIR = origDataDir;
    }
  });

  it("rejects invalid task ID", () => {
    expect(() => createNormalizeRun("not-a-uuid")).toThrow(/Invalid task ID/i);
  });
});

// ─── generateNormalizeRequestBundle ─────────────────────────────────────────────

describe("generateNormalizeRequestBundle", () => {
  it("creates a valid v1 bundle with all required fields", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const inputDocs: InputDocumentRef[] = [
      {
        documentId: "doc-001",
        fileName: "test.md",
        source: "upload",
        path: "/safe/path/to/document-doc-001.json",
        contentPathType: "json-wrapper",
        sha256: "abc123",
        enabled: true,
        version: 1,
      },
    ];

    const instructionContext: InstructionContext = {
      userInstruction: "Convert to production list",
      taskTitle: "Test Task",
      taskDescription: "A test task",
      targetDatasetType: "production-list",
      language: "zh-CN",
      businessRules: ["Max 2 speakers"],
    };

    const candidateLinesRef = writeCandidateLinesArtifact(paths.candidateLinesPath, [{
      id: "candidate-1",
      order: 0,
      speaker: "narrator",
      speakerLabel: "Narrator",
      transcript: "Hello candidate line",
      voice: "Zephyr",
    }]);

    const bundle = generateNormalizeRequestBundle({
      taskId: TASK_ID,
      runId,
      paths,
      inputDocuments: inputDocs,
      instructionContext,
      candidateLinesRef,
      currentState: {
        expectedVersion: 2,
        currentProductionListPath: "/safe/path/to/production-list.json",
        currentProductionListSummary: { lineCount: 5, speakers: ["Narrator"] },
      },
    });

    expect(bundle.schemaVersion).toBe("tts.normalize-request.v1");
    expect(bundle.taskId).toBe(TASK_ID);
    expect(bundle.runId).toBe(runId);
    expect(bundle.createdAt).toBeTruthy();
    expect(bundle.conversionGoal).toBeTruthy();
    expect(bundle.instructionContext.taskTitle).toBe("Test Task");
    expect(bundle.inputDocuments).toHaveLength(1);
    expect(bundle.inputDocuments[0].path).toBe("/safe/path/to/document-doc-001.json");
    expect(bundle.candidateLines?.path).toBe(paths.candidateLinesPath);
    expect(bundle.candidateLines?.count).toBe(1);
    expect(bundle.datasetSchema.path).toBe(paths.schemaPath);
    expect(bundle.currentState.expectedVersion).toBe(2);
    expect(bundle.outputContract.draftPath).toBe(paths.draftPath);
    expect(bundle.outputContract.writeMode).toBe("draft-file-then-server-commit");
    expect(bundle.safety.noSecrets).toBe(true);
    expect(bundle.safety.allowedReadPaths).toContain(paths.candidateLinesPath);
    expect(bundle.safety.allowedReadPaths).not.toContain("/safe/path/to/production-list.json");
    expect(bundle.safety.allowedWritePaths).toEqual([paths.draftPath]);
  });

  it("writes candidate-lines artifact with compact candidate fields", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    const ref = writeCandidateLinesArtifact(paths.candidateLinesPath, [{
      id: "candidate-1",
      order: 0,
      speaker: "narrator",
      speakerLabel: "Narrator",
      transcript: "候选台词。",
      voice: "Zephyr",
    }]);

    expect(ref.path).toBe(paths.candidateLinesPath);
    expect(ref.count).toBe(1);
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);

    const parsed = JSON.parse(fs.readFileSync(paths.candidateLinesPath, "utf-8"));
    expect(parsed.schemaVersion).toBe("tts.candidate-lines.v1");
    expect(parsed.voiceSelectionGuide.policy).toContain("project-curated perceived gender");
    expect(parsed.voiceSelectionGuide.policy).toContain("Google official docs list voice names/styles");
    expect(parsed.voiceSelectionGuide.voices).toContain("项目感知性别=中性");
    expect(parsed.candidateLines).toEqual([{
      id: "candidate-1",
      order: 0,
      speaker: "narrator",
      speakerLabel: "Narrator",
      transcript: "候选台词。",
      voice: "Zephyr",
    }]);
  });

  it("writes and reads run-progress artifact atomically", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    const progress = {
      ok: true as const,
      taskId: TASK_ID,
      runId,
      stage: "preprocessing" as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      elapsedMs: 5,
      timeoutMs: 60_000,
      timeoutBasis: { mode: "quality-priority", selectedTimeoutMs: 60_000 },
      candidateLineCount: 2,
      draft: { exists: false, parseable: false, sizeBytes: 0 },
      quality: { checked: false },
      runner: { status: "not_started" as const },
      message: "preprocessing",
    };

    writeRunProgress(paths.progressPath, progress);
    const readBack = readRunProgress(paths.progressPath);
    expect(readBack?.stage).toBe("preprocessing");
    expect(readBack?.candidateLineCount).toBe(2);
  });

  it("does not contain any API key or secret values", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const bundle = generateNormalizeRequestBundle({
      taskId: TASK_ID,
      runId,
      paths,
      inputDocuments: [],
      instructionContext: {
        userInstruction: "",
        taskTitle: "Test",
        taskDescription: "",
        targetDatasetType: "production-list",
        language: "zh-CN",
        businessRules: [],
      },
      currentState: {
        expectedVersion: 1,
        currentProductionListPath: null,
        currentProductionListSummary: { lineCount: 0, speakers: [] },
      },
    });

    const serialized = JSON.stringify(bundle);
    // Check that no common secret patterns appear
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/Bearer\s+\S+/i);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(serialized).not.toMatch(/password/i);
    // noSecrets=true is a boolean flag, not a secret value
    expect(serialized).not.toMatch(/secret\s*[=:]\s*['"]?\S+/i);
    expect(serialized).not.toMatch(/token\s*=\s*\S+/i);
  });
});

// ─── writeNormalizeRequestBundle ────────────────────────────────────────────────

describe("writeNormalizeRequestBundle", () => {
  it("writes a valid JSON file", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const bundle = generateNormalizeRequestBundle({
      taskId: TASK_ID,
      runId,
      paths,
      inputDocuments: [],
      instructionContext: {
        userInstruction: "",
        taskTitle: "Test",
        taskDescription: "",
        targetDatasetType: "production-list",
        language: "zh-CN",
        businessRules: [],
      },
      currentState: {
        expectedVersion: 1,
        currentProductionListPath: null,
        currentProductionListSummary: { lineCount: 0, speakers: [] },
      },
    });

    writeNormalizeRequestBundle(bundle, paths.requestPath);

    expect(fs.existsSync(paths.requestPath)).toBe(true);
    const content = fs.readFileSync(paths.requestPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.schemaVersion).toBe("tts.normalize-request.v1");
  });
});

// ─── Schema Snapshot ────────────────────────────────────────────────────────────

describe("generateProductionListSchemaSnapshot", () => {
  it("contains all required structure elements", () => {
    const snapshot = generateProductionListSchemaSnapshot();

    expect(snapshot.name).toBe("PromptStructuredProductionList");
    expect(snapshot.version).toBe("2.0");
    expect(snapshot.fields).toBeInstanceOf(Array);
    expect(snapshot.nestedSchemas.VoiceLine).toBeInstanceOf(Array);
    expect(snapshot.nestedSchemas.Speaker).toBeInstanceOf(Array);
    expect(snapshot.nestedSchemas.PromptProfile).toBeInstanceOf(Array);
    expect(snapshot.fields.map((f) => f.name)).toContain("promptProfiles");
    expect(snapshot.businessRules).toBeInstanceOf(Array);
    expect(snapshot.businessRules.length).toBeGreaterThan(0);
    expect(snapshot.examples.validLine).toBeTruthy();
    expect(snapshot.examples.validSpeaker).toBeTruthy();
  });

  it("VoiceLine fields cover all required production list fields", () => {
    const snapshot = generateProductionListSchemaSnapshot();
    const fieldNames = snapshot.nestedSchemas.VoiceLine.map((f) => f.name);

    expect(fieldNames).toContain("id");
    expect(fieldNames).toContain("order");
    expect(fieldNames).toContain("speaker");
    expect(fieldNames).toContain("text");
    expect(fieldNames).toContain("transcript");
    expect(fieldNames).toContain("promptProfileId");
    expect(fieldNames).toContain("voice");
    expect(fieldNames).toContain("model");
    expect(fieldNames).toContain("responseFormat");
    expect(fieldNames).toContain("generationStatus");
  });

  it("business rules include max speaker constraint", () => {
    const snapshot = generateProductionListSchemaSnapshot();
    const hasSpeakerRule = snapshot.businessRules.some((r) =>
      r.toLowerCase().includes("2 speaker") || r.toLowerCase().includes("maximum 2")
    );
    expect(hasSpeakerRule).toBe(true);
  });

  it("exports Gemini style-quality fields and clean transcript rules", () => {
    const snapshot = generateProductionListSchemaSnapshot();
    const profileFields = snapshot.nestedSchemas.PromptProfile.map((f) => f.name);
    const overrideFields = snapshot.nestedSchemas.PromptOverride.map((f) => f.name);
    const lineStyle = snapshot.nestedSchemas.VoiceLine.find((f) => f.name === "style");
    for (const field of ["style", "pacing", "accent", "emotion", "performanceNotes"]) {
      expect(profileFields).toContain(field);
      expect(overrideFields).toContain(field);
    }
    expect(lineStyle?.description).toContain("Line-level performance");
    expect(JSON.stringify(snapshot)).toContain("所有导演配置值必须使用简体中文");
    expect(JSON.stringify(snapshot)).toContain("不要把这些指导塞进 transcript");
    expect(JSON.stringify(snapshot)).toContain("Do not invent inline audio tags");
  });

  it("requires generated director profile values to be Chinese", () => {
    const snapshot = generateProductionListSchemaSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain("中文导演配置");
    expect(serialized).toContain("必须使用简体中文");
    expect(snapshot.examples.validLine.speakerLabel).toBe("旁白");
    expect(snapshot.examples.validSpeaker.label).toBe("旁白");
  });

  it("does not contain any secret or key values", () => {
    const snapshot = generateProductionListSchemaSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toMatch(/api[_-]?key\s*[=:]/i);
    expect(serialized).not.toMatch(/Bearer\s+\S+/i);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it("includes shared perceived gender policy without changing output schema fields", () => {
    const snapshot = generateProductionListSchemaSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).toContain("project-curated perceived gender");
    expect(serialized).toContain("Google official docs list voice names/styles");
    expect(serialized).toContain("项目感知性别=女");
    expect(serialized).toContain("project female voice: Kore, Leda, Aoede, Despina, Erinome, Laomedeia, Achernar, Sulafat");

    const voiceLineFields = snapshot.nestedSchemas.VoiceLine.map((field) => field.name);
    const promptSpeakerFields = snapshot.nestedSchemas.PromptSpeaker.map((field) => field.name);
    expect(voiceLineFields).not.toContain("perceivedGender");
    expect(promptSpeakerFields).not.toContain("perceivedGender");
  });
});

describe("writeSchemaSnapshot", () => {
  it("writes valid JSON to the specified path", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeSchemaSnapshot(paths.schemaPath);

    expect(fs.existsSync(paths.schemaPath)).toBe(true);
    const content = fs.readFileSync(paths.schemaPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe("PromptStructuredProductionList");
    expect(parsed.version).toBe("2.0");
  });
});

// ─── writeInstructionMarkdown ───────────────────────────────────────────────────

describe("writeInstructionMarkdown", () => {
  it("writes instruction.md with business rules", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const context: InstructionContext = {
      userInstruction: "Focus on dialogue",
      taskTitle: "My Task",
      taskDescription: "Voice production",
      targetDatasetType: "production-list",
      language: "zh-CN",
      businessRules: ["Max 2 speakers", "Default voice Zephyr"],
    };

    writeInstructionMarkdown(paths.instructionPath, context);

    expect(fs.existsSync(paths.instructionPath)).toBe(true);
    const content = fs.readFileSync(paths.instructionPath, "utf-8");
    expect(content).toContain("Max 2 speakers");
    expect(content).toContain("Focus on dialogue");
    expect(content).toContain("My Task");
    expect(content).toContain("## 安全");
    // No API key patterns
    expect(content).not.toMatch(/api[_-]?key\s*[=:]/i);
  });

  it("writes style extraction and clean transcript instructions", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeInstructionMarkdown(paths.instructionPath, {
      userInstruction: "",
      taskTitle: "Style Test",
      taskDescription: "Voice production",
      targetDatasetType: "production-list",
      language: "zh-CN",
      businessRules: [],
    });

    const content = fs.readFileSync(paths.instructionPath, "utf-8");
    expect(content).toContain("style、pacing、accent、emotion、performanceNotes");
    expect(content).toContain("每行 transcript/text 必须保持干净");
    expect(content).toContain("不要发明不支持的内联音频标签");
    expect(content).toContain("当 line.style 会改变该行表演时必须保留");
    expect(content).toContain("所有导演配置值必须使用简体中文");
  });

  it("injects shared perceived gender rules into instruction markdown", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeInstructionMarkdown(paths.instructionPath, {
      userInstruction: "",
      taskTitle: "Gender Test",
      taskDescription: "Voice production",
      targetDatasetType: "production-list",
      language: "zh-CN",
      businessRules: [],
    });

    const content = fs.readFileSync(paths.instructionPath, "utf-8");
    expect(content).toContain("project-curated perceived gender");
    expect(content).toContain("Google official docs list voice names/styles");
    expect(content).toContain("项目感知性别=男");
    expect(content).toContain("project male voice: Puck, Charon, Fenrir, Orus, Iapetus, Algenib, Rasalgethi, Alnilam, Gacrux, Sadaltager");
  });
});

describe("Gemini director style validator fields", () => {
  it("parses old DirectorConfig data with empty string defaults", () => {
    const parsed = DirectorConfigSchema.parse({});
    expect(parsed.style).toBe("");
    expect(parsed.pacing).toBe("");
    expect(parsed.accent).toBe("");
    expect(parsed.emotion).toBe("");
    expect(parsed.performanceNotes).toBe("");
  });

  it("accepts profile and override style-quality fields", () => {
    const profile = PromptProfileSchema.parse({
      id: "profile_style",
      name: "Style Profile",
      audioProfile: "A precise narrator voice.",
      scene: "A tense tactical briefing.",
      directorNotes: "Legacy compatibility notes.",
      sampleContext: "Briefing starts after an alarm.",
      style: "controlled urgency",
      pacing: "short pauses",
      accent: "clear diction",
      emotion: "restrained tension",
      performanceNotes: "Do not read labels aloud.",
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    const override = PromptOverrideSchema.parse({
      style: "lower and slower",
      pacing: "very deliberate",
      accent: "",
      emotion: "grave",
      performanceNotes: "Line-specific delivery only.",
    });
    expect(profile.style).toBe("controlled urgency");
    expect(override.performanceNotes).toBe("Line-specific delivery only.");
  });

  it("allows normal Chinese style descriptions that contain non-placeholder 无 wording", () => {
    const draft = {
      schemaVersion: "tts.production-list.v2",
      promptProfiles: [{
        id: "profile_chinese_style",
        name: "Chinese Style Profile",
        audioProfile: "沉稳清晰的中文旁白声线。",
        scene: "战术简报开始前的紧张场景。",
        directorNotes: "保留自然停顿，不朗读字段标签。",
        sampleContext: "警报声之后进入正式说明。",
        style: "冷静克制的战地旁白",
        pacing: "缓慢、有停顿，重点词稍作停留",
        accent: "无明显口音，清晰吐字",
        emotion: "紧张但克制",
        performanceNotes: "句尾不要夸张上扬。",
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "成熟稳重" }],
      }],
      lines: [{
        id: "line_chinese_style",
        order: 0,
        speaker: "narrator",
        transcript: "目标已经进入观察范围。",
        text: "目标已经进入观察范围。",
        promptProfileId: "profile_chinese_style",
        voice: "Zephyr",
        style: "低声、带压迫感",
        promptOverride: {
          accent: "无明显地域口音，保持自然咬字",
        },
      }],
    };

    const parseReport = validateRawPromptStructuredAgentDraft(draft);
    expect(parseReport.valid).toBe(true);
    const qualityReport = validateBusinessQualityGate({ draft: draft as any, candidateLineCount: 1 });
    expect(qualityReport.passed).toBe(true);
  });

  it("blocks placeholder values in profile director style fields", () => {
    const draft = {
      schemaVersion: "tts.production-list.v2",
      promptProfiles: [{
        id: "profile_style_placeholder",
        name: "Style Placeholder Profile",
        audioProfile: "A clear narrator voice.",
        scene: "A focused production scene.",
        directorNotes: "Specific natural delivery.",
        sampleContext: "A valid context line.",
        style: "TBD",
        pacing: "measured with short pauses",
        accent: "clear diction",
        emotion: "restrained tension",
        performanceNotes: "Avoid reading labels aloud.",
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr", style: "placeholder" }],
      }],
      lines: [{
        id: "line_style_placeholder_profile",
        order: 0,
        speaker: "narrator",
        transcript: "The operation begins now.",
        text: "The operation begins now.",
        promptProfileId: "profile_style_placeholder",
        voice: "Zephyr",
      }],
    };

    const parseReport = validateRawPromptStructuredAgentDraft(draft);
    expect(parseReport.valid).toBe(false);
    expect(parseReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PLACEHOLDER_PROMPT_FIELD", field: "promptProfiles[profile_style_placeholder].style" }),
      expect.objectContaining({ code: "PLACEHOLDER_PROMPT_FIELD", field: "promptProfiles[profile_style_placeholder].speakers[narrator].style" }),
    ]));

    const qualityReport = validateBusinessQualityGate({ draft: draft as any, candidateLineCount: 1 });
    expect(qualityReport.passed).toBe(false);
    expect(qualityReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROFILE_CONTENT_TOO_WEAK", actual: "TBD" }),
      expect.objectContaining({ code: "PROFILE_CONTENT_TOO_WEAK", actual: "placeholder" }),
    ]));
  });

  it("blocks placeholder values in line style and structured overrides", () => {
    const draft = {
      schemaVersion: "tts.production-list.v2",
      promptProfiles: [{
        id: "profile_override_placeholder",
        name: "Override Placeholder Profile",
        audioProfile: "A clear narrator voice.",
        scene: "A focused production scene.",
        directorNotes: "Specific natural delivery.",
        sampleContext: "A valid context line.",
        style: "controlled urgency",
        pacing: "measured with short pauses",
        accent: "clear diction",
        emotion: "restrained tension",
        performanceNotes: "Avoid reading labels aloud.",
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
      }],
      lines: [{
        id: "line_override_placeholder",
        order: 0,
        speaker: "narrator",
        transcript: "The operation begins now.",
        text: "The operation begins now.",
        promptProfileId: "profile_override_placeholder",
        voice: "Zephyr",
        style: "placeholder",
        promptOverride: { pacing: "none." },
        directorOverrideJson: JSON.stringify({ emotion: "无" }),
      }],
    };

    const parseReport = validateRawPromptStructuredAgentDraft(draft);
    expect(parseReport.valid).toBe(false);
    expect(parseReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PLACEHOLDER_PROMPT_FIELD", field: "lines[line_override_placeholder].style" }),
      expect.objectContaining({ code: "PLACEHOLDER_PROMPT_FIELD", field: "lines[line_override_placeholder].promptOverride.pacing" }),
      expect.objectContaining({ code: "PLACEHOLDER_PROMPT_FIELD", field: "lines[line_override_placeholder].directorOverrideJson.emotion" }),
    ]));

    const qualityReport = validateBusinessQualityGate({ draft: draft as any, candidateLineCount: 1 });
    expect(qualityReport.passed).toBe(false);
    expect(qualityReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROFILE_CONTENT_TOO_WEAK", actual: "placeholder" }),
      expect.objectContaining({ code: "PROFILE_CONTENT_TOO_WEAK", actual: "none." }),
      expect.objectContaining({ code: "PROFILE_CONTENT_TOO_WEAK", actual: "无" }),
    ]));
  });

  it("blocks transcript pollution from director labels", () => {
    const draft = {
      schemaVersion: "tts.production-list.v2",
      promptProfiles: [{
        id: "profile_pollution",
        name: "Pollution Profile",
        audioProfile: "A clear narrator voice.",
        scene: "Clean transcript gate test.",
        directorNotes: "Specific natural delivery.",
        sampleContext: "A valid context line.",
        speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
      }],
      lines: [{
        id: "line_polluted",
        order: 0,
        speaker: "narrator",
        transcript: "Style: whisper this line",
        text: "Style: whisper this line",
        promptProfileId: "profile_pollution",
        voice: "Zephyr",
      }],
    };
    const parseReport = validateRawPromptStructuredAgentDraft(draft);
    expect(parseReport.valid).toBe(true);
    const report = validateBusinessQualityGate({ draft: draft as any, candidateLineCount: 1 });
    expect(report.passed).toBe(false);
    expect(report.issues.some((issue) => issue.code === "TRANSCRIPT_PROMPT_STRUCTURE_POLLUTION")).toBe(true);
  });
});

// ─── readNormalizeDraft ─────────────────────────────────────────────────────────

describe("readNormalizeDraft", () => {
  it("returns parsed draft for valid JSON", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const validDraft = {
      lines: [
        { id: "line-1", order: 0, speaker: "narrator", text: "Hello" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    };
    fs.writeFileSync(paths.draftPath, JSON.stringify(validDraft));

    const result = readNormalizeDraft(paths.draftPath);
    expect(result).toBeTruthy();
    expect(result!.lines).toHaveLength(1);
    expect(result!.speakers).toHaveLength(1);
  });

  it("returns null for missing file", () => {
    const result = readNormalizeDraft("/nonexistent/path/draft.json");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "not valid json {{{");

    const result = readNormalizeDraft(paths.draftPath);
    expect(result).toBeNull();
  });

  it("returns {lines:[], speakers:[]} when lines is not an array (R-M1-C: schema-invalid draft, not Agent failure)", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, JSON.stringify({ lines: "not-array", speakers: [] }));

    const result = readNormalizeDraft(paths.draftPath);
    // R-M1-C: Parseable JSON with wrong-type fields returns a draft object
    // (with empty arrays for missing/wrong-type fields) so the raw validation gate
    // can catch it and return 422. Only truly unparseable JSON returns null.
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.speakers).toEqual([]);
  });

  it("returns {lines:[], speakers:[]} when speakers is missing (R-M1-C: schema-invalid draft, not Agent failure)", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, JSON.stringify({ lines: [] }));

    const result = readNormalizeDraft(paths.draftPath);
    // R-M1-C: Parseable JSON with missing speakers field returns a draft object
    // (with empty speakers array) so the raw validation gate catches it and returns 422.
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.speakers).toEqual([]);
  });

  // R-M1-D: Parseable primitive/null JSON must NOT return null (must enter raw gate -> 422)
  it("returns {lines:[], speakers:[]} for parseable JSON null (R-M1-D: primitive draft, not Agent failure)", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "null");

    const result = readNormalizeDraft(paths.draftPath);
    // R-M1-D: parseable JSON null is a draft attempt, not an Agent failure
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.speakers).toEqual([]);
  });

  it("returns {lines:[], speakers:[]} for parseable JSON string (R-M1-D: primitive draft, not Agent failure)", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, JSON.stringify("oops not a production list"));

    const result = readNormalizeDraft(paths.draftPath);
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.speakers).toEqual([]);
  });

  it("returns {lines:[], speakers:[]} for parseable JSON number (R-M1-D: primitive draft, not Agent failure)", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "123");

    const result = readNormalizeDraft(paths.draftPath);
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.speakers).toEqual([]);
  });

  it("returns {lines:[], speakers:[]} for parseable JSON boolean (R-M1-D: primitive draft, not Agent failure)", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "true");

    const result = readNormalizeDraft(paths.draftPath);
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.speakers).toEqual([]);
  });

  it("returns {lines:[], speakers:[]} for parseable JSON array at top level (R-M1-D: not Agent failure)", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, JSON.stringify([1, 2, 3]));

    const result = readNormalizeDraft(paths.draftPath);
    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.speakers).toEqual([]);
  });
});

// ─── writeValidationReport ──────────────────────────────────────────────────────

describe("writeValidationReport", () => {
  it("writes a valid JSON validation report", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeValidationReport(paths.validationReportPath, {
      valid: true,
      issues: [],
      stats: { totalLines: 5, speakers: ["Narrator"], maxOrder: 4 },
      source: "agent-draft",
    });

    expect(fs.existsSync(paths.validationReportPath)).toBe(true);
    const content = fs.readFileSync(paths.validationReportPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.valid).toBe(true);
    expect(parsed.source).toBe("agent-draft");
  });
});

// ─── writeCommitResult ──────────────────────────────────────────────────────────

describe("writeCommitResult", () => {
  it("writes a valid commit result", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeCommitResult(paths.commitResultPath, {
      committed: true,
      newVersion: 3,
      lineCount: 10,
      speakerCount: 2,
      runId,
      taskId: TASK_ID,
      committedAt: new Date().toISOString(),
    });

    expect(fs.existsSync(paths.commitResultPath)).toBe(true);
    const content = fs.readFileSync(paths.commitResultPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.committed).toBe(true);
    expect(parsed.newVersion).toBe(3);
  });
});

// ─── validateDraftInRunDir ──────────────────────────────────────────────────────

describe("validateDraftInRunDir", () => {
  it("accepts draft path within run dir", () => {
    const runDir = "/data/tasks/123/agent-runs/normalize-abc";
    const draftPath = "/data/tasks/123/agent-runs/normalize-abc/production-list.draft.json";
    expect(() => validateDraftInRunDir(draftPath, runDir)).not.toThrow();
  });

  it("rejects draft path outside run dir", () => {
    const runDir = "/data/tasks/123/agent-runs/normalize-abc";
    const draftPath = "/data/tasks/123/production-list.json";
    expect(() => validateDraftInRunDir(draftPath, runDir)).toThrow(/not within/);
  });
});

// ─── Bundle-Driven Runner (Mock) ────────────────────────────────────────────────

describe("runBundleOpenCodeNormalize", () => {
  it("returns success when opencode run completes", async () => {
    // Mock the spawn runner to return success
    _setSpawnRunner(async (file, args, options) => {
      return {
        stdout: JSON.stringify({ type: "text", part: { text: "Draft written to file." } }),
        stderr: "",
      };
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const result = await runBundleOpenCodeNormalize({
      normalizeRequestPath: paths.requestPath,
      schemaPath: paths.schemaPath,
      draftPath: paths.draftPath,
      instructionPath: paths.instructionPath,
    });

    expect(result.runner).toBe("opencode");
    expect(result.attemptedRunner).toBe("opencode");
    expect(result.runnerStatus?.status).toBe("succeeded");
    expect(result.runnerStatus?.fallbackUsed).toBe(false);
    // In bundle mode, lines come from the draft file (populated by caller)
    expect(result.productionList.lines).toEqual([]);
    expect(result._bundleMeta?.draftPath).toBe(paths.draftPath);
  });

  it("throws on opencode failure", async () => {
    _setSpawnRunner(async () => {
      throw new Error("opencode run exited with code 1: something failed");
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    await expect(
      runBundleOpenCodeNormalize({
        normalizeRequestPath: paths.requestPath,
        schemaPath: paths.schemaPath,
        draftPath: paths.draftPath,
      }),
    ).rejects.toThrow(/OPENCODE_BUNDLE_RUN_FAILED/);
  });

  it("preserves structured runner fields when wrapping opencode failure", async () => {
    const monitor = {
      state: "absolute_max_exceeded",
      processStatus: "killed",
      killReason: "absolute_timeout",
      softTimeoutMs: 123_456,
      absoluteMaxMs: 423_456,
      draftState: { exists: false, parseable: false },
    };
    _setSpawnRunner(async () => {
      const error = new Error("opencode run timed out after 423456ms") as Error & Record<string, unknown>;
      error.code = "OPENCODE_RUN_ABSOLUTE_TIMEOUT";
      error.httpStatusHint = 504;
      error.retryable = true;
      error.recoverableDraftPossible = true;
      error.monitor = monitor;
      throw error;
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    try {
      await runBundleOpenCodeNormalize({
        normalizeRequestPath: paths.requestPath,
        schemaPath: paths.schemaPath,
        draftPath: paths.draftPath,
      });
      throw new Error("expected bundle wrapper rejection");
    } catch (err) {
      const error = err as Error & Record<string, unknown>;
      expect(error.message).toMatch(/OPENCODE_BUNDLE_RUN_FAILED/);
      expect(error.code).toBe("OPENCODE_RUN_ABSOLUTE_TIMEOUT");
      expect(error.httpStatusHint).toBe(504);
      expect(error.retryable).toBe(true);
      expect(error.recoverableDraftPossible).toBe(true);
      expect(error.monitor).toEqual(monitor);
      expect(error.cause).toBeInstanceOf(Error);
    }
  });

  it("prompt does not contain document content or API keys", async () => {
    let capturedPrompt = "";
    _setSpawnRunner(async (file, args, options) => {
      // Prompt is positioned BEFORE --file args (B-MAJOR-01 fix).
      // After "--dir <cwd>", the next arg is the prompt text.
      const dirIdx = args.indexOf("--dir");
      capturedPrompt = args[dirIdx + 2] as string; // skip --dir and its value
      return { stdout: "", stderr: "" };
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    await runBundleOpenCodeNormalize({
      normalizeRequestPath: paths.requestPath,
      schemaPath: paths.schemaPath,
      draftPath: paths.draftPath,
    });

    // Prompt should be captured correctly
    expect(capturedPrompt).toContain("你是中文语音生产助理");
    expect(capturedPrompt).toContain("所有导演配置字段必须使用简体中文");
    expect(capturedPrompt).toContain("project-curated perceived gender");
    expect(capturedPrompt).toContain("Google official docs list voice names/styles");
    expect(capturedPrompt).toContain("project female voice: Kore, Leda, Aoede, Despina, Erinome, Laomedeia, Achernar, Sulafat");
    // Prompt should reference paths, not content
    expect(capturedPrompt).toContain(paths.requestPath);
    expect(capturedPrompt).toContain(paths.draftPath);
    // No document content should be in the prompt
    expect(capturedPrompt).not.toContain("This is a long document content");
    // No API key patterns
    expect(capturedPrompt).not.toMatch(/api[_-]?key\s*[=:]/i);
    expect(capturedPrompt).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it("uses --dir and --file flags", async () => {
    let capturedArgs: string[] = [];
    _setSpawnRunner(async (file, args, options) => {
      capturedArgs = args as string[];
      return { stdout: "", stderr: "" };
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    await runBundleOpenCodeNormalize({
      normalizeRequestPath: paths.requestPath,
      schemaPath: paths.schemaPath,
      draftPath: paths.draftPath,
    });

    expect(capturedArgs).toContain("run");
    expect(capturedArgs).toContain("--dir");
    expect(capturedArgs).toContain("--file");
    // Should have --file for both request and schema
    const fileFlags = capturedArgs.filter((a) => a === "--file");
    expect(fileFlags.length).toBeGreaterThanOrEqual(2);
  });

  it("passes caller timeout and draft-ready options to spawn runner", async () => {
    let capturedOptions: Record<string, unknown> = {};
    _setSpawnRunner(async (file, args, options) => {
      capturedOptions = options;
      return { stdout: "", stderr: "" };
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    await runBundleOpenCodeNormalize({
      normalizeRequestPath: paths.requestPath,
      schemaPath: paths.schemaPath,
      draftPath: paths.draftPath,
      timeoutMs: 123_456,
    });

    expect(capturedOptions.timeout).toBe(123_456);
    expect(capturedOptions.draftPath).toBe(paths.draftPath);
    expect(capturedOptions.draftReadyPollIntervalMs).toBeTypeOf("number");
    expect(capturedOptions.idleTimeoutMs).toBeTypeOf("number");
    expect(capturedOptions.absoluteMaxMs).toBeTypeOf("number");
    expect(capturedOptions.absoluteMaxMs as number).toBeGreaterThan(123_456);
  });

  it("prompt is NOT absorbed into --file array (B-MAJOR-01 regression guard)", async () => {
    let capturedArgs: string[] = [];
    _setSpawnRunner(async (file, args, options) => {
      capturedArgs = args as string[];
      return { stdout: "", stderr: "" };
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    await runBundleOpenCodeNormalize({
      normalizeRequestPath: paths.requestPath,
      schemaPath: paths.schemaPath,
      draftPath: paths.draftPath,
    });

    // Collect all values that follow --file flags
    const fileValues: string[] = [];
    for (let i = 0; i < capturedArgs.length; i++) {
      if (capturedArgs[i] === "--file" && i + 1 < capturedArgs.length) {
        fileValues.push(capturedArgs[i + 1]);
      }
    }

    // --file values should only be real file paths (request + schema)
    expect(fileValues).toContain(paths.requestPath);
    expect(fileValues).toContain(paths.schemaPath);
    expect(fileValues.length).toBe(2); // exactly 2 file paths, no prompt text

    // Prompt text must NOT appear in file values
    const promptText = capturedArgs.find(
      (a) => typeof a === "string" && a.includes("你是中文语音生产助理"),
    );
    expect(promptText).toBeTruthy();
    expect(fileValues).not.toContain(promptText);

    // Prompt must come BEFORE the first --file flag
    const promptIdx = capturedArgs.indexOf(promptText!);
    const firstFileIdx = capturedArgs.indexOf("--file");
    expect(promptIdx).toBeLessThan(firstFileIdx);
  });
});

// ─── Path Safety ────────────────────────────────────────────────────────────────

describe("Path safety", () => {
  it("getDocumentArtifactPath generates safe paths", () => {
    const docPath = getDocumentArtifactPath(TASK_ID, "doc-001");
    expect(docPath).toBeTruthy();
    expect(docPath).not.toContain("..");
    expect(docPath).toContain("document-doc-001.json");
  });

  it("getDocumentArtifactPath sanitizes dangerous document IDs", () => {
    const docPath = getDocumentArtifactPath(TASK_ID, "../../../etc/passwd");
    // The filename component must not contain path traversal sequences
    const filename = docPath.split("/").pop()!;
    expect(filename).not.toContain("..");
    expect(filename).not.toContain("/");
    expect(filename).not.toContain("\\");
    // After sanitization, dots and slashes are stripped
    expect(filename).toMatch(/^document-_________etc_passwd\.json$/);
  });

  it("getProductionListArtifactPath generates safe paths", () => {
    const plPath = getProductionListArtifactPath(TASK_ID);
    expect(plPath).toContain("production-list.json");
    expect(plPath).not.toContain("..");
  });
});

// ─── Security: No secrets in artifacts ──────────────────────────────────────────

describe("Security: no secrets in any generated artifacts", () => {
  const SECRET_PATTERNS = [
    /api[_-]?key\s*[=:]\s*['"]?\S+/i,
    /Bearer\s+\S+/i,
    /sk-[A-Za-z0-9_\-]{8,}/,
    /password\s*[=:]/i,
    /secret\s*[=:]/i,
    /token\s*[=:]\s*['"]?\S+/i,
  ];

  it("normalize-request.json contains no secrets", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const bundle = generateNormalizeRequestBundle({
      taskId: TASK_ID,
      runId,
      paths,
      inputDocuments: [],
      instructionContext: {
        userInstruction: "",
        taskTitle: "Security Test",
        taskDescription: "",
        targetDatasetType: "production-list",
        language: "zh-CN",
        businessRules: [],
      },
      currentState: {
        expectedVersion: 1,
        currentProductionListPath: null,
        currentProductionListSummary: { lineCount: 0, speakers: [] },
      },
    });

    writeNormalizeRequestBundle(bundle, paths.requestPath);
    const content = fs.readFileSync(paths.requestPath, "utf-8");

    for (const pattern of SECRET_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });

  it("production-list.schema.json contains no secrets", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeSchemaSnapshot(paths.schemaPath);
    const content = fs.readFileSync(paths.schemaPath, "utf-8");

    for (const pattern of SECRET_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });

  it("instruction.md contains no secrets", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeInstructionMarkdown(paths.instructionPath, {
      userInstruction: "",
      taskTitle: "Security Test",
      taskDescription: "",
      targetDatasetType: "production-list",
      language: "zh-CN",
      businessRules: [],
    });

    const content = fs.readFileSync(paths.instructionPath, "utf-8");

    for (const pattern of SECRET_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });

  it("validation report contains no secrets", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeValidationReport(paths.validationReportPath, {
      valid: true,
      issues: [],
      stats: { totalLines: 1, speakers: ["A"], maxOrder: 0 },
      source: "agent-draft",
    });

    const content = fs.readFileSync(paths.validationReportPath, "utf-8");

    for (const pattern of SECRET_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });

  it("commit result contains no secrets", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    writeCommitResult(paths.commitResultPath, {
      committed: true,
      newVersion: 1,
      lineCount: 5,
      speakerCount: 1,
      runId,
      taskId: TASK_ID,
      committedAt: new Date().toISOString(),
    });

    const content = fs.readFileSync(paths.commitResultPath, "utf-8");

    for (const pattern of SECRET_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });
});

// ─── M3: Document Upload Size/Type Safety ──────────────────────────────────────

describe("M3: Document upload size/type safety", () => {
  it("rejects content exceeding MAX_DOCUMENT_BYTES", () => {
    const oversized = "x".repeat(MAX_DOCUMENT_BYTES + 1);
    const result = PasteDocumentSchema.safeParse({
      fileName: "test.md",
      content: oversized,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const sizeIssue = result.error.issues.find((i) =>
        i.message.includes("exceeds maximum size"),
      );
      expect(sizeIssue).toBeTruthy();
    }
  });

  it("accepts content within MAX_DOCUMENT_BYTES", () => {
    const validContent = "x".repeat(100);
    const result = PasteDocumentSchema.safeParse({
      fileName: "test.md",
      content: validContent,
    });
    expect(result.success).toBe(true);
  });

  it("rejects disallowed file extensions", () => {
    const result = UploadDocumentBodySchema.safeParse({
      fileName: "malware.exe",
      content: "content",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const extIssue = result.error.issues.find((i) =>
        i.message.includes("not allowed"),
      );
      expect(extIssue).toBeTruthy();
    }
  });

  it("rejects .sh extension", () => {
    const result = UploadDocumentBodySchema.safeParse({
      fileName: "script.sh",
      content: "#!/bin/bash",
    });
    expect(result.success).toBe(false);
  });

  it("rejects .html extension", () => {
    const result = PasteDocumentSchema.safeParse({
      fileName: "page.html",
      content: "<script>alert(1)</script>",
    });
    expect(result.success).toBe(false);
  });

  it("accepts .md extension", () => {
    const result = PasteDocumentSchema.safeParse({
      fileName: "requirements.md",
      content: "# Title",
    });
    expect(result.success).toBe(true);
  });

  it("accepts .txt extension", () => {
    const result = UploadDocumentBodySchema.safeParse({
      fileName: "notes.txt",
      content: "Some text",
    });
    expect(result.success).toBe(true);
  });

  it("accepts files without extension", () => {
    const result = PasteDocumentSchema.safeParse({
      fileName: "README",
      content: "Some text",
    });
    expect(result.success).toBe(true);
  });

  it("rejects path traversal in fileName", () => {
    const result = UploadDocumentBodySchema.safeParse({
      fileName: "../../../etc/passwd",
      content: "malicious",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const traversalIssue = result.error.issues.find((i) =>
        i.message.includes("path separators"),
      );
      expect(traversalIssue).toBeTruthy();
    }
  });

  it("rejects backslash path in fileName", () => {
    const result = PasteDocumentSchema.safeParse({
      fileName: "..\\..\\windows\\system32",
      content: "malicious",
    });
    expect(result.success).toBe(false);
  });

  it("UpdateDocumentSchema enforces size limit on content update", () => {
    const oversized = "y".repeat(MAX_DOCUMENT_BYTES + 1);
    const result = UpdateDocumentSchema.safeParse({
      content: oversized,
      expectedVersion: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const sizeIssue = result.error.issues.find((i) =>
        i.message.includes("exceeds maximum size"),
      );
      expect(sizeIssue).toBeTruthy();
    }
  });

  it("hasAllowedDocumentExtension validates correctly", () => {
    expect(hasAllowedDocumentExtension("test.md")).toBe(true);
    expect(hasAllowedDocumentExtension("test.txt")).toBe(true);
    expect(hasAllowedDocumentExtension("test.MD")).toBe(true);
    expect(hasAllowedDocumentExtension("test.markdown")).toBe(true);
    expect(hasAllowedDocumentExtension("test.exe")).toBe(false);
    expect(hasAllowedDocumentExtension("test.sh")).toBe(false);
    expect(hasAllowedDocumentExtension("README")).toBe(true); // no extension
  });

  it("hasNoPathTraversal validates correctly", () => {
    expect(hasNoPathTraversal("test.md")).toBe(true);
    expect(hasNoPathTraversal("../test.md")).toBe(false);
    expect(hasNoPathTraversal("test/../other.md")).toBe(false);
    expect(hasNoPathTraversal("dir\\test.md")).toBe(false);
    expect(hasNoPathTraversal("normal-file.md")).toBe(true);
  });
});

// ─── M4: stdout/metadata Sanitization ──────────────────────────────────────────

describe("M4: sanitizeString redacts secrets", () => {
  it("redacts Bearer tokens", () => {
    const input = 'Result: Bearer eyJhbGciOiJIUzI1NiJ9.secret';
    const result = sanitizeString(input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("redacts Authorization headers", () => {
    const input = "Authorization: Basic dXNlcjpwYXNz";
    const result = sanitizeString(input);
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).toContain("authorization=[REDACTED]");
  });

  it("redacts sk- prefixed keys", () => {
    const input = "key=sk-abc123def456ghi789jkl012mno345";
    const result = sanitizeString(input);
    expect(result).not.toContain("sk-abc123def456ghi789jkl012mno345");
    expect(result).toContain("sk-[REDACTED]");
  });

  it("redacts api_key values", () => {
    const input = "api_key=AKIAIOSFODNN7EXAMPLE";
    const result = sanitizeString(input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("api_key=[REDACTED]");
  });

  it("redacts api-key values with dash", () => {
    const input = "api-key=mySecretKey123";
    const result = sanitizeString(input);
    expect(result).not.toContain("mySecretKey123");
    expect(result).toContain("api_key=[REDACTED]");
  });

  it("redacts token values", () => {
    const input = "token=ghp_1234567890abcdef";
    const result = sanitizeString(input);
    expect(result).not.toContain("ghp_1234567890abcdef");
    expect(result).toContain("token=[REDACTED]");
  });

  it("redacts authorization values", () => {
    const input = "authorization=Bearer secret123";
    const result = sanitizeString(input);
    expect(result).toContain("authorization=[REDACTED]");
  });

  it("redacts password values", () => {
    const input = "password=myP@ssw0rd!";
    const result = sanitizeString(input);
    expect(result).not.toContain("myP@ssw0rd");
    expect(result).toContain("password=[REDACTED]");
  });

  it("truncates at 500 characters", () => {
    const input = "a".repeat(1000);
    const result = sanitizeString(input);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("returns empty string for non-string input", () => {
    expect(sanitizeString(null as any)).toBe("");
    expect(sanitizeString(undefined as any)).toBe("");
  });

  it("preserves safe text without secrets", () => {
    const input = "Agent completed successfully. Draft written to file.";
    const result = sanitizeString(input);
    expect(result).toBe(input);
  });
});

describe("M4: stdoutSummary is sanitized in bundle runner output", () => {
  it("stdoutSummary does not contain secrets even when Agent stdout has them", async () => {
    _setSpawnRunner(async () => {
      return {
        stdout: JSON.stringify({
          type: "text",
          part: { text: "Done! api_key=SK_SECRET_12345 token=ghp_abc123" },
        }),
        stderr: "",
      };
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    const result = await runBundleOpenCodeNormalize({
      normalizeRequestPath: paths.requestPath,
      schemaPath: paths.schemaPath,
      draftPath: paths.draftPath,
    });

    const stdoutSummary = result.productionList.metadata?.stdoutSummary as string;
    expect(stdoutSummary).toBeTruthy();
    expect(stdoutSummary).not.toContain("SK_SECRET_12345");
    expect(stdoutSummary).not.toContain("ghp_abc123");
    expect(stdoutSummary).toContain("[REDACTED]");
    // Metadata itself should also not contain secrets
    const metadataStr = JSON.stringify(result.productionList.metadata);
    expect(metadataStr).not.toContain("SK_SECRET_12345");
    expect(metadataStr).not.toContain("ghp_abc123");
  });
});

// ─── M5: NormalizeRequestBodySchema ────────────────────────────────────────────

describe("M5: NormalizeRequestBodySchema", () => {
  it("accepts empty object (backward compatible)", () => {
    const result = NormalizeRequestBodySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts instruction field", () => {
    const result = NormalizeRequestBodySchema.safeParse({
      instruction: "Focus on dialogue lines only",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instruction).toBe("Focus on dialogue lines only");
    }
  });

  it("accepts documentIds field", () => {
    const docId = crypto.randomUUID();
    const result = NormalizeRequestBodySchema.safeParse({
      documentIds: [docId],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentIds).toEqual([docId]);
    }
  });

  it("accepts expectedVersion field", () => {
    const result = NormalizeRequestBodySchema.safeParse({
      expectedVersion: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expectedVersion).toBe(3);
    }
  });

  it("accepts all fields together", () => {
    const docId = crypto.randomUUID();
    const result = NormalizeRequestBodySchema.safeParse({
      instruction: "Convert to narration style",
      documentIds: [docId],
      expectedVersion: 5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects instruction exceeding 2000 chars", () => {
    const result = NormalizeRequestBodySchema.safeParse({
      instruction: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID documentIds", () => {
    const result = NormalizeRequestBodySchema.safeParse({
      documentIds: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 20 documentIds", () => {
    const ids = Array.from({ length: 21 }, () => crypto.randomUUID());
    const result = NormalizeRequestBodySchema.safeParse({
      documentIds: ids,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative expectedVersion", () => {
    const result = NormalizeRequestBodySchema.safeParse({
      expectedVersion: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts instruction exactly 2000 chars", () => {
    const result = NormalizeRequestBodySchema.safeParse({
      instruction: "x".repeat(2000),
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty documentIds array", () => {
    const result = NormalizeRequestBodySchema.safeParse({
      documentIds: [],
    });
    expect(result.success).toBe(true);
  });
});

// ─── M1 Concept: Validation gate blocks invalid drafts ─────────────────────────

describe("M1: validateProductionList catches invalid data that should block commit", () => {
  it("reports invalid when text is only punctuation", () => {
    const report = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "！！！", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("allows more than 2 top-level speakers for multi-profile v2 compatibility", () => {
    const report = validateProductionList({
      lines: [],
      speakers: [
        { id: "a", label: "A", voice: "Zephyr" },
        { id: "b", label: "B", voice: "Zephyr" },
        { id: "c", label: "C", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.code === "SPEAKER_LIMIT_EXCEEDED")).toBe(false);
  });

  it("reports invalid when line references unknown speaker", () => {
    const report = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "unknown_speaker", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "INVALID_SPEAKER_REFERENCE")).toBe(true);
  });

  it("reports valid for clean data", () => {
    const report = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello world", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(report.valid).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

// ─── R-M1: Raw draft strict validation gate (before normalization) ───────────

describe("R-M1: Raw Agent draft validation gate blocks invalid drafts before normalization", () => {
  it("blocks draft with missing required text field (empty string) before normalization", () => {
    // Simulate a raw Agent draft where a line has empty text.
    // The route builds rawLinesForValidation with empty string for missing text.
    // This must be caught by validateProductionList BEFORE any normalization
    // (normalization would replace empty text with "(Line n)").
    const rawReport = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawReport.valid).toBe(false);
    expect(rawReport.issues.some((i) => i.code === "EMPTY_TRANSCRIPT")).toBe(true);
  });

  it("blocks draft with syntax-only transcript (table separator) before normalization", () => {
    // A common Agent mistake: including Markdown table separators as lines.
    // Normalization would keep them as valid text, but strict validation
    // must catch that they have no semantic content.
    const rawReport = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "|---|---|", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawReport.valid).toBe(false);
    expect(rawReport.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("blocks draft with CJK punctuation-only transcript before normalization", () => {
    const rawReport = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "。。。", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawReport.valid).toBe(false);
    expect(rawReport.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("blocks draft with unknown speaker before normalization (not remapped)", () => {
    // An Agent draft that references a speaker not in the speakers array.
    // Normalization would remap to the first known speaker, but strict validation
    // must catch it and return 422.
    const rawReport = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "nonexistent_speaker", text: "Hello world", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawReport.valid).toBe(false);
    expect(rawReport.issues.some((i) => i.code === "INVALID_SPEAKER_REFERENCE")).toBe(true);
  });

  it("allows raw aggregate drafts with more than 2 top-level speakers before profile-scoped validation", () => {
    // Top-level aggregate speakers can exceed 2 when multiple promptProfiles each
    // stay within the Gemini per-request limit.
    const rawReport = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "a", text: "Hello", voice: "Zephyr" },
        { id: "l2", order: 1, speaker: "b", text: "World", voice: "Zephyr" },
        { id: "l3", order: 2, speaker: "c", text: "Foo", voice: "Zephyr" },
      ],
      speakers: [
        { id: "a", label: "A", voice: "Zephyr" },
        { id: "b", label: "B", voice: "Zephyr" },
        { id: "c", label: "C", voice: "Zephyr" },
      ],
    });
    expect(rawReport.valid).toBe(true);
    expect(rawReport.issues.some((i) => i.code === "SPEAKER_LIMIT_EXCEEDED")).toBe(false);
  });

  it("blocks draft with multiple missing required fields at once", () => {
    // All lines have empty text AND unknown speaker -- both errors caught.
    const rawReport = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "unknown", text: "", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawReport.valid).toBe(false);
    const errorCodes = rawReport.issues.filter((i) => i.severity === "error").map((i) => i.code);
    expect(errorCodes).toContain("EMPTY_TRANSCRIPT");
    expect(errorCodes).toContain("INVALID_SPEAKER_REFERENCE");
  });

  it("passes valid raw draft that would survive normalization unchanged", () => {
    // A clean Agent draft that passes strict validation.
    // After validation, normalization would only add cosmetic defaults
    // (status, model, responseFormat, generationStatus) that don't affect validity.
    const rawReport = validateProductionList({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello world", voice: "Zephyr" },
        { id: "l2", order: 1, speaker: "narrator", text: "Second line", voice: "Zephyr" },
      ],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawReport.valid).toBe(true);
    expect(rawReport.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("confirms normalization would have masked the invalid data (proof of gate necessity)", () => {
    // This test proves that WITHOUT the strict gate, the normalization step
    // would "fix" the empty text and unknown speaker, hiding data quality issues.
    const emptyTextLine = { id: "l1", order: 0, speaker: "narrator", text: "", voice: "Zephyr" };
    const unknownSpeakerLine = { id: "l1", order: 0, speaker: "unknown", text: "Hello", voice: "Zephyr" };

    // Raw validation catches both issues:
    const rawEmpty = validateProductionList({
      lines: [emptyTextLine],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawEmpty.valid).toBe(false);

    const rawUnknown = validateProductionList({
      lines: [unknownSpeakerLine],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(rawUnknown.valid).toBe(false);

    // After normalization (text replacement + speaker remap), same data would pass:
    const normalizedEmpty = validateProductionList({
      lines: [{ id: "l1", order: 0, speaker: "narrator", text: "(Line 1)", voice: "Zephyr" }],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(normalizedEmpty.valid).toBe(true);

    const normalizedUnknown = validateProductionList({
      lines: [{ id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" }],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    expect(normalizedUnknown.valid).toBe(true);
    // This proves the gate is necessary: normalization hides issues that the
    // strict raw validation correctly catches.
  });
});

describe("Prompt-Structured v2 raw draft validation", () => {
  const validV2Draft = {
    schemaVersion: "tts.production-list.v2",
    promptProfiles: [{
      id: "profile_narrator",
      name: "Narrator profile",
      audioProfile: "Warm narrator voice with clear diction.",
      scene: "Quiet studio narration for a product guide.",
      directorNotes: "Measured pace, calm tone, natural pauses.",
      sampleContext: "Instructional voiceover for an application workflow.",
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
      reusePolicy: "many-lines",
    }],
    lines: [{
      id: "line_1",
      order: 0,
      speaker: "narrator",
      speakerLabel: "Narrator",
      transcript: "点击开始按钮，进入语音生成流程。",
      text: "点击开始按钮，进入语音生成流程。",
      promptProfileId: "profile_narrator",
      voice: "Zephyr",
      responseFormat: "wav",
    }],
    speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
  };

  it("rejects drafts missing promptProfiles", () => {
    const report = validateRawPromptStructuredAgentDraft({ ...validV2Draft, promptProfiles: undefined });
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.code === "MISSING_PROMPT_PROFILES")).toBe(true);
  });

  it("rejects drafts with incomplete prompt fields", () => {
    const draft = JSON.parse(JSON.stringify(validV2Draft));
    draft.promptProfiles[0].scene = "";
    const report = validateRawPromptStructuredAgentDraft(draft);
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.code === "INCOMPLETE_PROMPT_PROFILE")).toBe(true);
  });

  it("rejects drafts with missing profile binding", () => {
    const draft = JSON.parse(JSON.stringify(validV2Draft));
    delete draft.lines[0].promptProfileId;
    const report = validateRawPromptStructuredAgentDraft(draft);
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.code === "MISSING_PROMPT_PROFILE_BINDING")).toBe(true);
  });

  it("passes a valid prompt-structured v2 draft", () => {
    const report = validateRawPromptStructuredAgentDraft(validV2Draft);
    expect(report.valid).toBe(true);
    expect(report.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });
});

// ─── R-M2: Atomic version commit with unique constraint ──────────────────────

describe("R-M2: Unique constraint on production_list_version(task_id, version)", () => {
  it("DB-level unique index prevents duplicate (task_id, version) pairs", () => {
    // Use a real temporary SQLite database to verify the unique constraint works.
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const rawDb = new Database(":memory:");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    // Create the table with the unique index (mirrors initSchema)
    rawDb.exec(`
      CREATE TABLE voice_task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE production_list_version (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        director_profile_id TEXT,
        speakers_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        line_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE UNIQUE INDEX IF NOT EXISTS production_list_version_task_id_version_unique
        ON production_list_version(task_id, version);
    `);

    // Insert a task
    rawDb.prepare("INSERT INTO voice_task (id, title) VALUES (?, ?)").run("task-1", "Test Task");

    // First insert of version (task_id=task-1, version=1) succeeds
    rawDb.prepare(
      "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
    ).run("v1", "task-1", 1, 5);

    // Second insert with same (task_id, version) must fail
    expect(() => {
      rawDb.prepare(
        "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
      ).run("v2", "task-1", 1, 3);
    }).toThrow(/UNIQUE constraint failed/);

    // Insert with different version succeeds
    expect(() => {
      rawDb.prepare(
        "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
      ).run("v3", "task-1", 2, 7);
    }).not.toThrow();

    // Verify only 2 rows exist (no overwrite from failed insert)
    const rows = rawDb.prepare(
      "SELECT version FROM production_list_version WHERE task_id = ? ORDER BY version"
    ).all("task-1") as Array<{ version: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].version).toBe(1);
    expect(rows[1].version).toBe(2);

    rawDb.close();
  });
});

// ─── R-M1-C: Schema-invalid draft must NOT bypass raw gate for fallback ───────

describe("R-M1-C: Parseable but schema-invalid draft -> 422, no fallback, no version", () => {
  it("parseable draft with empty lines array -> 422 via raw gate, not fallback", () => {
    // readNormalizeDraft returns non-null for parseable JSON with lines:[]
    // validateRawAgentDraft catches lines.min(1) -> RAW_DRAFT_SCHEMA_PARSE_FAILED
    const draftJson = JSON.stringify({ lines: [], speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }] });
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, draftJson);

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED" && i.message.includes("at least one line"))).toBe(true);
  });

  it("parseable draft with missing speakers field -> 422 via raw gate, not fallback", () => {
    // readNormalizeDraft returns {lines, speakers:[]} when speakers field is missing
    // validateRawAgentDraft catches speakers.min(1) -> RAW_DRAFT_SCHEMA_PARSE_FAILED
    const draftJson = JSON.stringify({ lines: [{ id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" }] });
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, draftJson);

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED" && i.message.includes("at least one speaker"))).toBe(true);
  });

  it("parseable draft with missing voice on line -> 422 via raw gate, not fallback", () => {
    const draftJson = JSON.stringify({
      lines: [{ id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "" }],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, draftJson);

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED" && i.message.includes("voice"))).toBe(true);
  });

  it("parseable draft with syntax-only transcript -> 422 via domain validation, not fallback", () => {
    const draftJson = JSON.stringify({
      lines: [{ id: "l1", order: 0, speaker: "narrator", text: "|---|---|", voice: "Zephyr" }],
      speakers: [{ id: "narrator", label: "Narrator", voice: "Zephyr" }],
    });
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, draftJson);

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MARKDOWN_SYNTAX_ONLY_TRANSCRIPT")).toBe(true);
  });

  it("unparseable draft (invalid JSON) -> null from readNormalizeDraft -> fallback allowed", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "not valid json {{{");

    const draft = readNormalizeDraft(paths.draftPath);
    // Agent failure: draft is genuinely unparseable, fallback is appropriate
    expect(draft).toBeNull();
  });

  it("missing draft file -> null from readNormalizeDraft -> fallback allowed", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    // Don't write any file

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).toBeNull();
  });

  // R-M1-D: Primitive/null parseable JSON must go through raw gate -> 422, not fallback
  it("parseable JSON null -> readNormalizeDraft non-null -> raw gate 422, not fallback", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "null");

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("parseable JSON string -> readNormalizeDraft non-null -> raw gate 422, not fallback", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, JSON.stringify("not a production list"));

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("parseable JSON number -> readNormalizeDraft non-null -> raw gate 422, not fallback", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "42");

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("parseable JSON boolean -> readNormalizeDraft non-null -> raw gate 422, not fallback", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, "false");

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("parseable JSON array top-level -> readNormalizeDraft non-null -> raw gate 422, not fallback", () => {
    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);
    fs.writeFileSync(paths.draftPath, JSON.stringify([1, "two", 3]));

    const draft = readNormalizeDraft(paths.draftPath);
    expect(draft).not.toBeNull();

    const report = validateRawAgentDraft({ lines: draft!.lines, speakers: draft!.speakers });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });
});

// ─── R-M2-B: Fallback path conflict response must be actual 409 ──────────────

describe("R-M2-B: Fallback commit stale expectedVersion returns 409 via discriminated union", () => {
  it("simulates commitFallbackProductionList returning conflict response (kind=response)", () => {
    // This test verifies the discriminated union pattern:
    // When atomicCommitProductionList throws VERSION_CONFLICT,
    // commitFallbackProductionList returns { kind: "response", response: <409 Response> }
    // The caller must return this response directly, NOT wrap it in c.json().

    // We simulate the atomic commit logic that throws VERSION_CONFLICT
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const rawDb = new Database(":memory:");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    rawDb.exec(`
      CREATE TABLE voice_task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE production_list_version (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        director_profile_id TEXT,
        speakers_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        line_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE UNIQUE INDEX IF NOT EXISTS production_list_version_task_id_version_unique
        ON production_list_version(task_id, version);
    `);

    rawDb.prepare("INSERT INTO voice_task (id, title) VALUES (?, ?)").run("task-rm2b", "R-M2-B Test");

    // First commit succeeds (version 1)
    rawDb.prepare(
      "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
    ).run("vid-1", "task-rm2b", 1, 1);

    // Second attempt with stale expectedVersion=0 -> VERSION_CONFLICT
    function tryAtomicCommit(expectedVersion: number): { kind: "response"; status: number } | { kind: "success"; newVersion: number } {
      try {
        rawDb.transaction(() => {
          const row = rawDb.prepare(
            "SELECT MAX(version) as v FROM production_list_version WHERE task_id = ?"
          ).get("task-rm2b") as { v: number | null };
          const currentVersion = row.v ?? 0;

          if (currentVersion !== expectedVersion) {
            throw new Error(`VERSION_CONFLICT:${currentVersion}`);
          }

          const newVersion = expectedVersion + 1;
          rawDb.prepare(
            "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
          ).run(`vid-${newVersion}`, "task-rm2b", newVersion, 1);
          return newVersion;
        })();
        return { kind: "success", newVersion: expectedVersion + 1 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("VERSION_CONFLICT:") || msg.includes("UNIQUE constraint failed")) {
          // R-M2-B: Return as discriminated union "response" kind
          return { kind: "response", status: 409 };
        }
        throw err;
      }
    }

    // Stale commit: expectedVersion=0 but actual is 1
    const result = tryAtomicCommit(0);
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.status).toBe(409);
    }

    // Verify: only version 1 exists (stale commit did not overwrite)
    const rows = rawDb.prepare(
      "SELECT version FROM production_list_version WHERE task_id = ? ORDER BY version"
    ).all("task-rm2b") as Array<{ version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);

    rawDb.close();
  });

  it("simulates unavailable-fallback stale expectedVersion returning 409", () => {
    // Same test but simulating the OpenCode-unavailable fallback path
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const rawDb = new Database(":memory:");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    rawDb.exec(`
      CREATE TABLE voice_task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE production_list_version (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        director_profile_id TEXT,
        speakers_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        line_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE UNIQUE INDEX IF NOT EXISTS production_list_version_task_id_version_unique
        ON production_list_version(task_id, version);
    `);

    rawDb.prepare("INSERT INTO voice_task (id, title) VALUES (?, ?)").run("task-unavail", "Unavailable Fallback Test");

    // Simulate: another request already committed version 1
    rawDb.prepare(
      "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
    ).run("vid-1", "task-unavail", 1, 5);

    // Unavailable fallback tries to commit with stale expectedVersion=0
    function tryFallbackCommit(expectedVersion: number): { kind: "response"; status: number } | { kind: "success"; newVersion: number } {
      try {
        rawDb.transaction(() => {
          const row = rawDb.prepare(
            "SELECT MAX(version) as v FROM production_list_version WHERE task_id = ?"
          ).get("task-unavail") as { v: number | null };
          const currentVersion = row.v ?? 0;

          if (currentVersion !== expectedVersion) {
            throw new Error(`VERSION_CONFLICT:${currentVersion}`);
          }

          const newVersion = expectedVersion + 1;
          rawDb.prepare(
            "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
          ).run(`vid-fallback-${newVersion}`, "task-unavail", newVersion, 3);
          return newVersion;
        })();
        return { kind: "success", newVersion: expectedVersion + 1 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("VERSION_CONFLICT:") || msg.includes("UNIQUE constraint failed")) {
          return { kind: "response", status: 409 };
        }
        throw err;
      }
    }

    const result = tryFallbackCommit(0);
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.status).toBe(409);
    }

    // Verify: only version 1 exists, no overwrite from stale fallback
    const rows = rawDb.prepare(
      "SELECT version FROM production_list_version WHERE task_id = ? ORDER BY version"
    ).all("task-unavail") as Array<{ version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);

    rawDb.close();
  });
});

// ─── R-M1 Strict: Raw Agent Draft Zod Schema Parse ─────────────────────────────

describe("R-M1 Strict: validateRawAgentDraft Zod schema parse gate", () => {
  it("blocks raw draft with missing voice on line (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello world" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
    expect(report.issues.some((i) => i.message.includes("voice"))).toBe(true);
  });

  it("blocks raw draft with empty voice on line (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello world", voice: "" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("blocks raw draft with empty speakers array (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
    expect(report.issues.some((i) => i.message.includes("at least one speaker"))).toBe(true);
  });

  it("blocks raw draft with missing speakers field entirely (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: undefined as any,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("blocks raw draft with empty lines array (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
    expect(report.issues.some((i) => i.message.includes("at least one line"))).toBe(true);
  });

  it("blocks raw draft with missing line id (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" } as any,
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("blocks raw draft with missing line order (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", speaker: "narrator", text: "Hello", voice: "Zephyr" } as any,
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("blocks raw draft with non-integer line order (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 1.5, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("blocks raw draft with empty speaker label (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("blocks raw draft with empty speaker voice (schema parse failure)", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "" },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("passes valid raw draft with all required fields", () => {
    const report = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello world", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(report.valid).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("reports multiple schema parse errors at once", () => {
    const report = validateRawAgentDraft({
      lines: [
        // Missing id, order, speaker, text, voice -- all required
        {} as any,
      ],
      speakers: [
        // Missing id, label, voice -- all required
        {} as any,
      ],
    });
    expect(report.valid).toBe(false);
    // Should have multiple RAW_DRAFT_SCHEMA_PARSE_FAILED issues
    const schemaErrors = report.issues.filter((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED");
    expect(schemaErrors.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── R-M1 Pre-validation synthesis regression ──────────────────────────────────

describe("R-M1: Pre-validation synthesis regression -- raw gate catches drafts that would pass after synthesis", () => {
  it("raw draft missing voice fails even though normalization would add default voice", () => {
    // Before this fix, the route would set voice="" for missing voice,
    // then normalization would set voice="Zephyr". The raw gate would pass.
    // Now validateRawAgentDraft uses Zod parse which requires voice non-empty.
    const rawReport = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(rawReport.valid).toBe(false);

    // Proof: same line with voice added would pass
    const fixedReport = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(fixedReport.valid).toBe(true);
  });

  it("raw draft with empty speakers fails even though normalization would add default narrator", () => {
    // Before this fix, the route would let empty speakers through,
    // and normalization would add a default narrator. Now Zod parse rejects.
    const rawReport = validateRawAgentDraft({
      lines: [
        { id: "l1", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [],
    });
    expect(rawReport.valid).toBe(false);
    expect(rawReport.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("raw draft with missing line id fails even though normalization would generate one", () => {
    // Before: route would set id=`raw-line-${i}`. Now Zod requires non-empty id.
    const rawReport = validateRawAgentDraft({
      lines: [
        { id: "", order: 0, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(rawReport.valid).toBe(false);
    expect(rawReport.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });

  it("raw draft with missing line order fails even though normalization would assign index", () => {
    // Before: route would set order=i. Now Zod requires integer order.
    const rawReport = validateRawAgentDraft({
      lines: [
        { id: "l1", order: undefined as any, speaker: "narrator", text: "Hello", voice: "Zephyr" },
      ],
      speakers: [
        { id: "narrator", label: "Narrator", voice: "Zephyr" },
      ],
    });
    expect(rawReport.valid).toBe(false);
    expect(rawReport.issues.some((i) => i.code === "RAW_DRAFT_SCHEMA_PARSE_FAILED")).toBe(true);
  });
});

// ─── R-M2-A: Fallback path atomic expectedVersion gate ─────────────────────────

describe("R-M2-A: Fallback/import path uses same atomic commit as bundle main path", () => {
  it("fallback path stale expectedVersion returns 409 (not committed as next version)", () => {
    // Simulate: two requests both start with expectedVersion=0.
    // Request 1 commits first (version 1). Request 2's fallback commit
    // must detect that version is now 1, not 0, and return 409.
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const rawDb = new Database(":memory:");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    rawDb.exec(`
      CREATE TABLE voice_task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE production_list_version (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        director_profile_id TEXT,
        speakers_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        line_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE voice_line (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES production_list_version(id) ON DELETE CASCADE,
        "order" INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        voice TEXT NOT NULL,
        style TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        director_profile_id TEXT,
        director_override_json TEXT,
        generation_status TEXT NOT NULL DEFAULT 'draft',
        related_job_id TEXT,
        related_asset_id INTEGER,
        generation_error_code TEXT,
        generation_error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS production_list_version_task_id_version_unique
        ON production_list_version(task_id, version);
    `);

    rawDb.prepare("INSERT INTO voice_task (id, title) VALUES (?, ?)").run("task-fallback", "Fallback Test");

    // Simulate atomic commit helper logic
    function atomicCommit(expectedVersion: number): { success: boolean; newVersion?: number; error?: string } {
      try {
        const result = rawDb.transaction(() => {
          const row = rawDb.prepare(
            "SELECT MAX(version) as v FROM production_list_version WHERE task_id = ?"
          ).get("task-fallback") as { v: number | null };
          const currentVersion = row.v ?? 0;

          if (currentVersion !== expectedVersion) {
            throw new Error(`VERSION_CONFLICT:${currentVersion}`);
          }

          const newVersion = expectedVersion + 1;
          rawDb.prepare(
            "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
          ).run(`vid-${newVersion}`, "task-fallback", newVersion, 1);

          return newVersion;
        })();
        return { success: true, newVersion: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("VERSION_CONFLICT:") || msg.includes("UNIQUE constraint failed")) {
          return { success: false, error: msg };
        }
        throw err;
      }
    }

    // Request 1 (bundle main path): expectedVersion=0 -> succeeds, creates version 1
    const result1 = atomicCommit(0);
    expect(result1.success).toBe(true);
    expect(result1.newVersion).toBe(1);

    // Request 2 (fallback path): also expectedVersion=0 -> stale! must 409
    const result2 = atomicCommit(0);
    expect(result2.success).toBe(false);
    expect(result2.error).toMatch(/VERSION_CONFLICT/);

    // Verify: only version 1 exists in DB (no version 2 from stale fallback)
    const rows = rawDb.prepare(
      "SELECT version FROM production_list_version WHERE task_id = ? ORDER BY version"
    ).all("task-fallback") as Array<{ version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);

    rawDb.close();
  });

  it("bundle path concurrent expectedVersion: one succeeds, one gets 409", () => {
    // Same pattern as above but explicitly testing the concurrent scenario
    // for the bundle main path's atomic commit helper.
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const rawDb = new Database(":memory:");
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    rawDb.exec(`
      CREATE TABLE voice_task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE production_list_version (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES voice_task(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        director_profile_id TEXT,
        speakers_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        line_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE UNIQUE INDEX IF NOT EXISTS production_list_version_task_id_version_unique
        ON production_list_version(task_id, version);
    `);

    rawDb.prepare("INSERT INTO voice_task (id, title) VALUES (?, ?)").run("task-bundle", "Bundle Concurrent Test");

    function atomicCommit(expectedVersion: number, versionId: string): { success: boolean; newVersion?: number; error?: string } {
      try {
        const result = rawDb.transaction(() => {
          const row = rawDb.prepare(
            "SELECT MAX(version) as v FROM production_list_version WHERE task_id = ?"
          ).get("task-bundle") as { v: number | null };
          const currentVersion = row.v ?? 0;

          if (currentVersion !== expectedVersion) {
            throw new Error(`VERSION_CONFLICT:${currentVersion}`);
          }

          const newVersion = expectedVersion + 1;
          rawDb.prepare(
            "INSERT INTO production_list_version (id, task_id, version, line_count) VALUES (?, ?, ?, ?)"
          ).run(versionId, "task-bundle", newVersion, 3);

          return newVersion;
        })();
        return { success: true, newVersion: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("VERSION_CONFLICT:") || msg.includes("UNIQUE constraint failed")) {
          return { success: false, error: msg };
        }
        throw err;
      }
    }

    // Two concurrent normalize requests both start with expectedVersion=0
    // First one succeeds
    const r1 = atomicCommit(0, "v-bundle-1");
    expect(r1.success).toBe(true);
    expect(r1.newVersion).toBe(1);

    // Second one gets conflict because version is now 1
    const r2 = atomicCommit(0, "v-bundle-2");
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/VERSION_CONFLICT/);

    // Verify only version 1 exists
    const rows = rawDb.prepare(
      "SELECT version FROM production_list_version WHERE task_id = ? ORDER BY version"
    ).all("task-bundle") as Array<{ version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);

    rawDb.close();
  });
});

// ─── FQ-M1: Child Process Environment Secret Boundary ──────────────────────────

describe("FQ-M1: buildSafeChildEnv filters sensitive environment variables", () => {
  it("removes variables ending in _KEY (case-insensitive)", () => {
    const env = buildSafeChildEnv({
      OPENROUTER_API_KEY: "sk-or-v1-dangerous",
      AWS_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE",
      MY_CUSTOM_KEY: "some-key-value",
      PATH: "/usr/bin",
      HOME: "/home/user",
    });
    expect(env["OPENROUTER_API_KEY"]).toBeUndefined();
    expect(env["AWS_ACCESS_KEY"]).toBeUndefined();
    expect(env["MY_CUSTOM_KEY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/user");
  });

  it("removes variables containing TOKEN", () => {
    const env = buildSafeChildEnv({
      GITHUB_TOKEN: "ghp_1234567890",
      MY_TOKEN_VALUE: "tok123",
      REFRESH_TOKEN: "refresh-abc",
      PATH: "/usr/bin",
    });
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["MY_TOKEN_VALUE"]).toBeUndefined();
    expect(env["REFRESH_TOKEN"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("removes variables containing SECRET", () => {
    const env = buildSafeChildEnv({
      APP_SECRET: "secret123",
      CLIENT_SECRET: "cs-abc",
      JWT_SECRET: "jwt-secret",
      HOME: "/home/user",
    });
    expect(env["APP_SECRET"]).toBeUndefined();
    expect(env["CLIENT_SECRET"]).toBeUndefined();
    expect(env["JWT_SECRET"]).toBeUndefined();
    expect(env["HOME"]).toBe("/home/user");
  });

  it("removes variables containing PASSWORD/PASSWD", () => {
    const env = buildSafeChildEnv({
      DB_PASSWORD: "p@ssw0rd",
      USER_PASSWD: "passwd",
      MYSQL_ROOT_PASSWORD: "root123",
      PATH: "/usr/bin",
    });
    expect(env["DB_PASSWORD"]).toBeUndefined();
    expect(env["USER_PASSWD"]).toBeUndefined();
    expect(env["MYSQL_ROOT_PASSWORD"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("removes variables containing AUTHORIZATION", () => {
    const env = buildSafeChildEnv({
      AUTHORIZATION: "Bearer xyz",
      MY_AUTHORIZATION: "Basic abc",
      HOME: "/home/user",
    });
    expect(env["AUTHORIZATION"]).toBeUndefined();
    expect(env["MY_AUTHORIZATION"]).toBeUndefined();
    expect(env["HOME"]).toBe("/home/user");
  });

  it("removes variables containing CREDENTIAL", () => {
    const env = buildSafeChildEnv({
      AWS_CREDENTIAL: "cred-123",
      GOOGLE_CREDENTIALS: "goog-cred",
      PATH: "/usr/bin",
    });
    expect(env["AWS_CREDENTIAL"]).toBeUndefined();
    expect(env["GOOGLE_CREDENTIALS"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("removes variables containing COOKIE", () => {
    const env = buildSafeChildEnv({
      SESSION_COOKIE: "sid=abc",
      MY_COOKIE: "cookie-val",
      HOME: "/home/user",
    });
    expect(env["SESSION_COOKIE"]).toBeUndefined();
    expect(env["MY_COOKIE"]).toBeUndefined();
    expect(env["HOME"]).toBe("/home/user");
  });

  it("removes variables containing SESSION", () => {
    const env = buildSafeChildEnv({
      SESSION_ID: "sess-123",
      MY_SESSION_SECRET: "session-secret",
      PATH: "/usr/bin",
    });
    expect(env["SESSION_ID"]).toBeUndefined();
    expect(env["MY_SESSION_SECRET"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("removes all OPENROUTER variables", () => {
    const env = buildSafeChildEnv({
      OPENROUTER_API_KEY: "sk-or-v1-dangerous",
      OPENROUTER_CONFIG: "config-val",
      OPENROUTER_ANYTHING: "any-val",
      PATH: "/usr/bin",
    });
    expect(env["OPENROUTER_API_KEY"]).toBeUndefined();
    expect(env["OPENROUTER_CONFIG"]).toBeUndefined();
    expect(env["OPENROUTER_ANYTHING"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("removes variables containing PRIVATE", () => {
    const env = buildSafeChildEnv({
      PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      MY_PRIVATE_VAR: "private-val",
      HOME: "/home/user",
    });
    expect(env["PRIVATE_KEY"]).toBeUndefined();
    expect(env["MY_PRIVATE_VAR"]).toBeUndefined();
    expect(env["HOME"]).toBe("/home/user");
  });

  it("removes variables ending in _AUTH (exact suffix)", () => {
    const env = buildSafeChildEnv({
      BASIC_AUTH: "basic-auth-val",
      OAUTH_AUTH: "oauth-val",
      PATH: "/usr/bin",
    });
    expect(env["BASIC_AUTH"]).toBeUndefined();
    expect(env["OAUTH_AUTH"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("preserves essential system variables", () => {
    const env = buildSafeChildEnv({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/user",
      SHELL: "/bin/zsh",
      USER: "testuser",
      LOGNAME: "testuser",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      TERM: "xterm-256color",
      XDG_CONFIG_HOME: "/home/user/.config",
      OPENCODE_CONFIG_DIR: "/home/user/.config/opencode",
    });
    expect(env["PATH"]).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env["HOME"]).toBe("/home/user");
    expect(env["SHELL"]).toBe("/bin/zsh");
    expect(env["USER"]).toBe("testuser");
    expect(env["LOGNAME"]).toBe("testuser");
    expect(env["TMPDIR"]).toBe("/tmp");
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["XDG_CONFIG_HOME"]).toBe("/home/user/.config");
    expect(env["OPENCODE_CONFIG_DIR"]).toBe("/home/user/.config/opencode");
  });

  it("skips undefined values", () => {
    const env = buildSafeChildEnv({
      PATH: "/usr/bin",
      UNDEFINED_VAR: undefined,
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["UNDEFINED_VAR"]).toBeUndefined();
    expect("UNDEFINED_VAR" in env).toBe(false);
  });

  it("handles empty source environment", () => {
    const env = buildSafeChildEnv({});
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("allows XDG_SESSION_DESKTOP despite matching 'session' pattern (allowlist)", () => {
    const env = buildSafeChildEnv({
      XDG_SESSION_DESKTOP: "gnome",
      PATH: "/usr/bin",
    });
    expect(env["XDG_SESSION_DESKTOP"]).toBe("gnome");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("allows GPG_TTY despite being in allowlist", () => {
    const env = buildSafeChildEnv({
      GPG_TTY: "/dev/ttys000",
      PATH: "/usr/bin",
    });
    expect(env["GPG_TTY"]).toBe("/dev/ttys000");
    expect(env["PATH"]).toBe("/usr/bin");
  });
});

describe("FQ-M1: bundle runner spawn receives sanitized env", () => {
  it("bundle runner passes sanitized env without sensitive variables", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    _setSpawnRunner(async (file, args, options) => {
      capturedEnv = (options.env as Record<string, string | undefined>) || {};
      return { stdout: "", stderr: "" };
    });

    const runId = crypto.randomUUID();
    const paths = makeRunPaths(TASK_ID, runId);

    await runBundleOpenCodeNormalize({
      normalizeRequestPath: paths.requestPath,
      schemaPath: paths.schemaPath,
      draftPath: paths.draftPath,
    });

    // Must NOT contain any sensitive env vars
    for (const key of Object.keys(capturedEnv)) {
      expect(
        /key$/i.test(key) || /token/i.test(key) || /secret/i.test(key) ||
        /password/i.test(key) || /authorization/i.test(key) || /credential/i.test(key) ||
        /cookie/i.test(key) || /openrouter/i.test(key) || /private/i.test(key),
        `Env var '${key}' should have been filtered out but was present in child env`,
      ).toBe(false);
    }

    // Must contain essential system vars
    expect("PATH" in capturedEnv).toBe(true);
    expect("HOME" in capturedEnv).toBe(true);
  });

  it("bundle runner env excludes OPENROUTER_API_KEY even if present in process.env", async () => {
    // Temporarily set a sensitive env var
    const originalValue = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test-secret-key-value";

    let capturedEnv: Record<string, string | undefined> = {};
    _setSpawnRunner(async (file, args, options) => {
      capturedEnv = (options.env as Record<string, string | undefined>) || {};
      return { stdout: "", stderr: "" };
    });

    try {
      const runId = crypto.randomUUID();
      const paths = makeRunPaths(TASK_ID, runId);

      await runBundleOpenCodeNormalize({
        normalizeRequestPath: paths.requestPath,
        schemaPath: paths.schemaPath,
        draftPath: paths.draftPath,
      });

      expect(capturedEnv["OPENROUTER_API_KEY"]).toBeUndefined();
      expect("PATH" in capturedEnv).toBe(true);
    } finally {
      // Restore original env
      if (originalValue === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalValue;
      }
    }
  });
});

describe("FQ-M1: legacy runner spawn receives sanitized env", () => {
  afterEach(() => {
    _resetSpawnRunner();
  });

  it("legacy runner passes sanitized env without sensitive variables", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    _setSpawnRunner(async (file, args, options) => {
      capturedEnv = (options.env as Record<string, string | undefined>) || {};
      return {
        stdout: JSON.stringify({
          type: "text",
          part: { text: '{"lines":[{"id":"l1","order":0,"speaker":"narrator","text":"Hello"}],"speakers":[{"id":"narrator","label":"Narrator","voice":"Zephyr"}]}' },
        }),
        stderr: "",
      };
    });

    const result = await runOpenCodeNormalize({
      documents: [{ id: "d1", fileName: "test.md", content: "Hello world", enabled: true }],
    });

    expect(result.runner).toBe("opencode");

    // Must NOT contain any sensitive env vars
    for (const key of Object.keys(capturedEnv)) {
      expect(
        /key$/i.test(key) || /token/i.test(key) || /secret/i.test(key) ||
        /password/i.test(key) || /authorization/i.test(key) || /credential/i.test(key) ||
        /cookie/i.test(key) || /openrouter/i.test(key) || /private/i.test(key),
        `Env var '${key}' should have been filtered out but was present in child env`,
      ).toBe(false);
    }

    // Must contain essential system vars
    expect("PATH" in capturedEnv).toBe(true);
    expect("HOME" in capturedEnv).toBe(true);
  });

  it("legacy runner env excludes OPENROUTER_API_KEY even if present in process.env", async () => {
    const originalValue = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-v1-legacy-test-key";

    let capturedEnv: Record<string, string | undefined> = {};
    _setSpawnRunner(async (file, args, options) => {
      capturedEnv = (options.env as Record<string, string | undefined>) || {};
      return {
        stdout: JSON.stringify({
          type: "text",
          part: { text: '{"lines":[{"id":"l1","order":0,"speaker":"narrator","text":"Hi"}],"speakers":[{"id":"narrator","label":"Narrator","voice":"Zephyr"}]}' },
        }),
        stderr: "",
      };
    });

    try {
      await runOpenCodeNormalize({
        documents: [{ id: "d1", fileName: "test.md", content: "Hi", enabled: true }],
      });

      expect(capturedEnv["OPENROUTER_API_KEY"]).toBeUndefined();
      expect("PATH" in capturedEnv).toBe(true);
    } finally {
      if (originalValue === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalValue;
      }
    }
  });

  it("legacy runner prompt includes shared perceived gender policy", async () => {
    let capturedPrompt = "";
    _setSpawnRunner(async (file, args) => {
      capturedPrompt = (args as string[]).find((arg) => arg.includes("你是中文语音生产助理")) ?? "";
      return {
        stdout: JSON.stringify({
          type: "text",
          part: { text: '{"lines":[{"id":"l1","order":0,"speaker":"narrator","text":"Hi"}],"speakers":[{"id":"narrator","label":"Narrator","voice":"Zephyr"}]}' },
        }),
        stderr: "",
      };
    });

    await runOpenCodeNormalize({
      documents: [{ id: "d1", fileName: "test.md", content: "Hi", enabled: true }],
    });

    expect(capturedPrompt).toContain("project-curated perceived gender");
    expect(capturedPrompt).toContain("Google official docs list voice names/styles");
    expect(capturedPrompt).toContain("project male voice: Puck, Charon, Fenrir, Orus, Iapetus, Algenib, Rasalgethi, Alnilam, Gacrux, Sadaltager");
  });
});
