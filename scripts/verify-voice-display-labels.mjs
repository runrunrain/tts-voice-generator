import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendSourcePath = resolve(repoRoot, "src/app/utils/voiceDisplay.ts");
const serverSourcePath = resolve(repoRoot, "server/src/utils/voice.ts");

const frontendSource = readFileSync(frontendSourcePath, "utf8");
const serverSource = readFileSync(serverSourcePath, "utf8");

function extractLiteralAfter(source, marker, opener, closer) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing marker: ${marker}`);
  const assignmentIndex = source.indexOf("=", markerIndex);
  assert.notEqual(assignmentIndex, -1, `Missing assignment after marker: ${marker}`);
  const start = source.indexOf(opener, assignmentIndex);
  assert.notEqual(start, -1, `Missing literal opener after marker: ${marker}`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated literal after marker: ${marker}`);
}

function evaluateLiteral(literal) {
  return Function(`"use strict"; return (${literal});`)();
}

const voiceDisplay = evaluateLiteral(
  extractLiteralAfter(frontendSource, "export const GEMINI_VOICE_DISPLAY", "{", "}"),
);
const serverCatalog = evaluateLiteral(
  extractLiteralAfter(serverSource, "export const GEMINI_VOICE_CATALOG", "[", "]"),
);

const genderLabel = {
  male: "男声",
  female: "女声",
};

function getVoiceDisplayMeta(voiceName) {
  return voiceDisplay[voiceName] ?? { displayName: voiceName, toneDescription: "自定义音色" };
}

function formatVoiceOptionLabel(voiceName, role = null) {
  const meta = getVoiceDisplayMeta(voiceName);
  const tone = role?.trim() || meta.toneDescription;
  const nameLabel = meta.displayName === voiceName ? voiceName : `${voiceName}（${meta.displayName}）`;
  const perceivedGender = meta.perceivedGender ? genderLabel[meta.perceivedGender] : null;
  return [nameLabel, perceivedGender, tone].filter(Boolean).join(" · ");
}

assert.equal(Object.keys(voiceDisplay).length, 30, "Frontend display catalog must cover 30 Gemini voices");
assert.equal(serverCatalog.length, 30, "Server catalog must cover 30 Gemini voices");

const serverGenderByName = new Map(serverCatalog.map((voice) => [voice.name, voice.perceivedGender]));
for (const [voiceName, meta] of Object.entries(voiceDisplay)) {
  assert.ok(["male", "female"].includes(meta.perceivedGender), `${voiceName} must have a male/female perceivedGender`);
  assert.equal(meta.perceivedGender, serverGenderByName.get(voiceName), `${voiceName} frontend perceivedGender must match server catalog`);
}

assert.equal(frontendSource.includes("中性"), false, "Frontend voice display source must not render a neutral Chinese label");
assert.equal(
  Object.values(voiceDisplay).some((meta) => meta.perceivedGender === "neutral"),
  false,
  "Frontend voice display catalog must not contain neutral entries",
);

assert.deepEqual(
  Object.entries(voiceDisplay).filter(([, meta]) => meta.perceivedGender === "female").map(([name]) => name),
  ["Zephyr", "Kore", "Leda", "Aoede", "Callirrhoe", "Autonoe", "Despina", "Erinome", "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat"],
  "Female voice mapping must match Google/Provider no-neutral catalog",
);
assert.deepEqual(
  Object.entries(voiceDisplay).filter(([, meta]) => meta.perceivedGender === "male").map(([name]) => name),
  ["Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Achird", "Zubenelgenubi", "Sadachbia", "Sadaltager"],
  "Male voice mapping must match Google/Provider no-neutral catalog",
);

assert.equal(formatVoiceOptionLabel("Kore"), "Kore（珂瑞） · 女声 · 坚定、果断");
assert.equal(formatVoiceOptionLabel("Charon"), "Charon（卡戎） · 男声 · 低沉、信息量强");
assert.equal(formatVoiceOptionLabel("Zephyr"), "Zephyr（和风） · 女声 · 明亮、自然");
assert.equal(formatVoiceOptionLabel("Gacrux"), "Gacrux（十字架一） · 女声 · 成熟、稳健");
assert.equal(formatVoiceOptionLabel("Enceladus"), "Enceladus（恩克拉多斯） · 男声 · 气声、虚弱感");
assert.equal(formatVoiceOptionLabel("Kore", "女将宣告"), "Kore（珂瑞） · 女声 · 女将宣告");
assert.equal(formatVoiceOptionLabel("CustomVoice"), "CustomVoice · 自定义音色");

assert.match(frontendSource, /return \[nameLabel, genderLabel, tone\]\.filter\(Boolean\)\.join\(" · "\);/, "Runtime formatter must join name, gender, and tone labels");
console.log("Voice display label verification passed");
