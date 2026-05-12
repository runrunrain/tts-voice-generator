export const SUPPORTED_TARGETS = new Set([
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
]);

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      args.platform = argv[index + 1];
      index += 1;
    } else if (arg === "--arch") {
      args.arch = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

export function resolveTarget(argv) {
  const args = parseArgs(argv);
  const platform = args.platform || process.platform;
  const arch = args.arch || process.arch;
  const targetId = `${platform}-${arch}`;

  if (!SUPPORTED_TARGETS.has(targetId)) {
    throw new Error(`Unsupported desktop target ${targetId}. Supported targets: ${[...SUPPORTED_TARGETS].join(", ")}`);
  }
  return { platform, arch, targetId };
}

export function requireMatchingHost(target) {
  if (process.platform !== target.platform) {
    throw new Error(`Target ${target.targetId} must be built on ${target.platform}; current host is ${process.platform}`);
  }
  if (process.arch !== target.arch) {
    throw new Error(`Target ${target.targetId} requires ${target.arch} Node/toolchain; current arch is ${process.arch}`);
  }
}

export function getStageDir(target) {
  return `dist-desktop/app-${target.platform}-${target.arch}`;
}

export function getOutputDir(target) {
  return `release/desktop/${target.platform}-${target.arch}`;
}
