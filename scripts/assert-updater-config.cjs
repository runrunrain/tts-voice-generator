const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const configPath = path.join(projectRoot, "electron-builder.config.cjs");
const platformCapabilitiesPath = path.join(projectRoot, "electron", "platform-capabilities.ts");
const updaterServicePath = path.join(projectRoot, "electron", "updater-service.ts");
const mainPath = path.join(projectRoot, "electron", "main.ts");

function loadBuilderConfig(extraEnv = {}) {
  const managedKeys = [
    "DESKTOP_TARGET_PLATFORM",
    "DESKTOP_TARGET_ARCH",
    "DESKTOP_APP_DIR",
    "DESKTOP_OUTPUT_DIR",
    "DESKTOP_UPDATE_FEED_URL",
    "GITHUB_REPOSITORY",
  ];
  const previousEnv = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));
  for (const key of managedKeys) delete process.env[key];
  Object.assign(process.env, {
    DESKTOP_TARGET_PLATFORM: "win32",
    DESKTOP_TARGET_ARCH: "x64",
    DESKTOP_APP_DIR: projectRoot,
    DESKTOP_OUTPUT_DIR: path.join(projectRoot, "dist-desktop-test"),
    ...extraEnv,
  });

  try {
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  } finally {
    for (const key of managedKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
}

const defaultConfig = loadBuilderConfig();
assert.deepEqual(defaultConfig.publish, [
  {
    provider: "generic",
    url: "https://github.com/runrunrain/tts-voice-generator/releases/latest/download/",
  },
]);

const customFeedConfig = loadBuilderConfig({
  DESKTOP_UPDATE_FEED_URL: "https://updates.example.com/tts-voice-generator",
});
assert.equal(customFeedConfig.publish[0].provider, "generic");
assert.equal(customFeedConfig.publish[0].url, "https://updates.example.com/tts-voice-generator/");

const customRepositoryConfig = loadBuilderConfig({
  GITHUB_REPOSITORY: "example-owner/example-repo",
});
assert.equal(customRepositoryConfig.publish[0].provider, "generic");
assert.equal(customRepositoryConfig.publish[0].url, "https://github.com/example-owner/example-repo/releases/latest/download/");

assert.throws(
  () => loadBuilderConfig({ DESKTOP_UPDATE_FEED_URL: "http://updates.example.com/tts-voice-generator" }),
  /DESKTOP_UPDATE_FEED_URL must use https:\/\//,
);
assert.throws(
  () => loadBuilderConfig({ DESKTOP_UPDATE_FEED_URL: "https://token@updates.example.com/tts-voice-generator?secret=value" }),
  /DESKTOP_UPDATE_FEED_URL must not contain credentials/,
);

const builderConfigSource = fs.readFileSync(configPath, "utf8");
assert(!builderConfigSource.includes('provider: "github"'), "electron-builder must not use the GitHub provider");
assert(!builderConfigSource.includes("releases.atom"), "electron-builder config must not reference releases.atom");

const platformCapabilitiesSource = fs.readFileSync(platformCapabilitiesPath, "utf8");
assert(platformCapabilitiesSource.includes('DEFAULT_GITHUB_REPOSITORY = "runrunrain/tts-voice-generator"'));
assert(platformCapabilitiesSource.includes('updateProvider: "generic"'));
assert(!platformCapabilitiesSource.includes('DEFAULT_GITHUB_REPOSITORY = "maorun/tts-voice-generator"'));

const updaterServiceSource = fs.readFileSync(updaterServicePath, "utf8");
assert(updaterServiceSource.includes("describeUpdaterError"));
assert(updaterServiceSource.includes("应用内更新不能内置 GitHub Token"));

const mainSource = fs.readFileSync(mainPath, "utf8");
assert(mainSource.includes("gh[REDACTED]"));
assert(mainSource.includes("access_token|auth|token"));

console.info("Updater configuration assertions passed.");
