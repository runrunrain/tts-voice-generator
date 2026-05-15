const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const helper = read("src/app/services/audioAsset.ts");
assert(helper.includes("apiRequest(path"), "audioAsset helper must fetch audio through apiRequest so desktop headers are attached");
assert(helper.includes("URL.createObjectURL(blob)"), "audioAsset helper must convert fetched audio Blob to an Object URL");
assert(helper.includes("link.href = object.objectUrl"), "audioAsset downloads must click an Object URL, not the protected API URL");
assert(!/ttsDesktop|getApiHeaders|X-TTS-Desktop-Token/.test(helper), "audioAsset helper must not access or serialize the desktop token directly");
assert(!/searchParams\.set\([^)]*token/i.test(helper), "audioAsset helper must not put a token in the URL query string");

const protectedConsumers = [
  "src/app/components/RightPanel.tsx",
  "src/app/pages/HistoryPage.tsx",
  "src/app/pages/HistoryDetailPage.tsx",
  "src/app/components/tasks/ProductionListEditor.tsx",
  "src/app/pages/DirectorPage.tsx",
];

for (const relativePath of protectedConsumers) {
  const source = read(relativePath);
  assert(
    source.includes("../services/audioAsset") || source.includes("../../services/audioAsset") || source.includes("../hooks/useAudioObjectUrl"),
    `${relativePath} must use the authenticated audio helper or hook`,
  );
  assert(
    !/new\s+Audio\(\s*(?:generateResult|detail|audioAccess|audioUrl|r\.)/m.test(source),
    `${relativePath} must not construct HTMLAudioElement from a protected /api/audio URL`,
  );
  assert(
    !/\.href\s*=\s*(?:generateResult|detail|audioAccess|downloadUrl|audioUrl|r\.)/m.test(source),
    `${relativePath} must not assign protected /api/audio URL directly to an anchor href`,
  );
  assert(
    !/src=\{\s*(?:generateResult|detail|audioUrl|r\.)/m.test(source),
    `${relativePath} must not assign protected /api/audio URL directly to media src`,
  );
}

console.log("Desktop audio access assertions passed.");
