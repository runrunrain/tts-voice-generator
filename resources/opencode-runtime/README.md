# OpenCode Bundled Runtime

This directory holds platform-specific OpenCode runtime binaries for desktop packaging.

Actual binaries are injected by CI or `scripts/prepare-desktop-runtime.js` and must NOT be committed to the repository.

Expected structure per target:
```
resources/opencode-runtime/<targetId>/
  manifest.json
  bin/
    opencode(.exe)
```

Supported targets: `win32-x64`, `darwin-x64`, `darwin-arm64`
