# TTS Voice Generator

AI-powered text-to-speech generator built with React, Hono, and OpenRouter Gemini TTS. A full-stack single-page application that converts text to natural-sounding speech, manages voice profiles, supports director-mode multi-speaker scene assembly, and exposes controlled API endpoints for integration with AI coding agents (e.g., OpenCode CLI plugins).

## Features

- **Text-to-Speech Generation**: Convert text to audio via OpenRouter's Gemini TTS models. Supports WAV output with automatic PCM-to-WAV wrapping (24 kHz, 16-bit, mono).
- **Multi-Voice Management**: Browse, verify, and manage voice profiles. Track verification status per voice.
- **Director Mode**: Assemble multi-speaker scenes with role assignments, transcript blocks, and audio profiles.
- **Generation History**: Full audit trail of every generation job with status, cost estimates, error codes, and audio playback/download.
- **Agent-Controlled API**: Dedicated endpoints for external AI agents to generate speech under budget, concurrency, and approval controls (`confirm_each` and `session_auto` modes).
- **Security**: OpenRouter API keys encrypted at rest (AES-256-GCM); local plugin tokens hashed (SHA-256) with timing-safe verification; credential patterns redacted from all error messages and logs.
- **Diagnostics Dashboard**: `/api/ready` preflight checks and `/api/diagnostics` deep-dive endpoint providing server health, DB status, recent failures, and agent action logs.
- **Production Static Hosting**: Hono server serves the built React SPA alongside API routes from a single Node.js process.

## Architecture Overview

```
+-----------------------+       +----------------------------+
|   React 18 SPA        |       |   Hono API Server (:3001)  |
|   (Vite + Tailwind)   |       |   Node.js                  |
|                       |       |                            |
|  src/                 |  dev  |  server/src/               |
|   app/                | proxy |   routes/                  |
|    pages/             |<----->|    health.ts    /api/health|
|    components/        |   or  |    settings.ts  /api/set...|
|    services/          | static|    voices.ts    /api/voice*|
|    state/             | serve |    tts.ts       /api/tts/* |
+-----------------------+       |    history.ts   /api/hist* |
                                |    agent.ts     /api/agent*|
                                |    diagnostics  /api/diag* |
                                |                            |
                                |   services/                |
                                |    openrouter-provider.ts  |
                                |    tts-generator.ts        |
                                |    agent-auth.ts           |
                                |    key-resolver.ts         |
                                |    concurrency.ts          |
                                |                            |
                                |   db/ (Drizzle ORM)        |
                                |    SQLite (WAL mode)       |
                                |   data/                    |
                                |    db/tts-generator.db     |
                                |    audio/YYYY/MM/DD/*.wav  |
                                +----------------------------+

External:
  OpenRouter API (https://openrouter.ai/api/v1/audio/speech)
  OpenCode CLI Plugin -> /api/agent/generate-speech
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite 6, Tailwind CSS 4, Radix UI, MUI |
| Routing | react-router 7 |
| Backend | Hono 4, Node.js, TypeScript |
| Database | SQLite (better-sqlite3), Drizzle ORM |
| TTS Provider | OpenRouter (Gemini TTS) |
| Validation | Zod |
| Testing | Vitest |
| Build Tooling | tsc, Vite, concurrently, tsx |

### Project Structure

```
tts-voice-generator/
  src/                    # React frontend source
    app/                  # Application pages, components, state, services
    main.tsx              # Vite entry point
    index.html            # HTML shell
  server/                 # Hono backend source
    src/
      routes/             # API route handlers
      services/           # Business logic (TTS, auth, concurrency)
      config/             # Environment config, encryption utilities
      db/                 # Drizzle ORM schema, seeds, DB init
      utils/              # Audio format, voice helpers, file I/O
    __tests__/            # Vitest test suites
    package.json          # Server-specific dependencies
  data/                   # Runtime data (DB + audio files), gitignored
    audio/                # Generated audio files, organized by date
    db/                   # SQLite database file
  dist/                   # Frontend and server build output
  guidelines/             # Development guidelines for AI coding agents
  docs/                   # Integration and reference documentation
```

## Quick Start

### Prerequisites

- Node.js 20+
- npm 10+
- An OpenRouter API key (https://openrouter.ai/keys)

### Setup

```bash
# Install all dependencies (frontend + server)
npm install
cd server && npm install && cd ..

# Create .env file with your OpenRouter API key
echo "OPENROUTER_API_KEY=<your-openrouter-key>" > .env
```

### Development Mode

**One-click quick start** (recommended for first-time use):

```bash
npm run quickstart
```

On Windows, you can also **double-click `start.bat`** in Explorer.

This launches both services concurrently with unified log output:
- Vite dev server on `http://localhost:5173` (with `/api/*` proxied to backend)
- Hono API server on `http://localhost:3001`

Press **Ctrl+C** or close the terminal window to stop all services. No orphan processes will be left behind.

**Alternative** -- use `concurrently` (the original dev command):

```bash
npm run dev:all
```

**Smoke test** -- verify both services start and respond, then auto-exit:

```bash
npm run smoke
```

This is useful for CI/CD or automated validation. It starts the services, checks health endpoints, and exits with code 0 on success or 1 on failure.

The API key can also be configured through the Settings page in the UI (stored encrypted in the database). The `.env` file serves as a fallback.

### Production Mode

```bash
# Build frontend + server, then start
npm run start:all
```

Or run the steps individually:

```bash
npm run build:all        # Builds Vite frontend to dist/ + compiles server TypeScript
npm run server:start     # Starts the production server on port 3001
```

In production, the Hono server serves the built React SPA from `dist/` alongside all API routes. No separate frontend server is needed.

### Desktop Packaging

The Electron desktop app embeds the built Hono server and serves the SPA through a loopback-only HTTP endpoint. Packaged desktop mode binds the API to `127.0.0.1`, stores the SQLite database and generated audio under the OS user data directory, and protects `/api/*` requests with a per-session `X-TTS-Desktop-Token` header injected by the preload bridge.

```bash
npm run electron:build          # build Electron main/preload into dist-electron/
npm run desktop:package:mac     # build the current macOS arch dmg
npm run desktop:dist:win:x64    # run on Windows x64 to build NSIS installer
```

Platform wrapper scripts are also available: `scripts/build-desktop.sh` on macOS and `scripts/build-desktop.bat` on Windows. Desktop artifacts are written to `release/desktop/<platform>-<arch>/`; each target uses an independent `dist-desktop/app-<platform>-<arch>/` staging directory and rebuilds `better-sqlite3` against the installed Electron version.

## Environment Variables

All variables are defined in `server/src/config/env.ts`:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | (none) | OpenRouter API key (sk-or-v1-...). Fallback if not set in DB. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base URL |
| `PORT` | `3001` | Server listen port |
| `AUDIO_OUTPUT_DIR` | `./data/audio` | Directory for generated audio files |
| `DB_PATH` | `./data/db/tts-generator.db` | SQLite database path |
| `DATA_DIR` | `./data` | Root data directory |
| `NODE_ENV` | `development` | Environment (`development` or `production`) |

The `.env` file is gitignored. Never commit API keys or tokens to version control.

## Data Directory

```
data/
  db/
    tts-generator.db       # SQLite database (WAL mode)
    tts-generator.db-wal   # WAL journal file
    tts-generator.db-shm   # WAL shared memory file
  audio/
    YYYY/MM/DD/
      {uuid}.wav           # Generated audio files, organized by creation date
```

The entire `data/` directory is gitignored. Audio files are named by job UUID, organized by date for manageable file counts per directory.

## Security Model

### OpenRouter API Key Protection

- **At Rest**: API keys stored in the SQLite database are encrypted with AES-256-GCM. The encryption key is derived from the DB file path + a fixed salt using `crypto.scryptSync`, ensuring the key cannot be recovered from the DB alone without the server environment.
- **In Transit**: Keys are sent to OpenRouter over HTTPS. The `/api/settings` GET endpoint returns only a masked version (e.g., `sk-***...****`). The plaintext key is never exposed to the frontend.
- **Resolution Order**: DB-first, then `.env` fallback. The DB path is prioritized because it is encrypted; `.env` is a convenience for first-time setup.
- **Error Sanitization**: All error responses, logs, and stored error metadata are scanned for credential patterns (`Bearer sk-...`, `apiKey=...`, etc.) and redacted before returning or persisting.

### Local Plugin Token

- Agent-facing endpoints (`/api/agent/*`) require a Bearer token for authentication.
- Tokens use the prefix `lpt_` followed by 32 random bytes (base64url-encoded).
- Only the **SHA-256 hash** of the token is stored in the database -- never the plaintext.
- Verification uses `crypto.timingSafeEqual` to prevent timing attacks.
- Token fingerprint (first 8 + last 8 characters of the hash) is exposed in the settings UI for identification without revealing the full hash.

### CORS

Only whitelisted local development origins are allowed:
- `http://localhost:5173`
- `http://127.0.0.1:5173`
- `http://localhost:5174`
- `http://127.0.0.1:5174`

Programmatic access (curl, agent plugins) does not require CORS headers and works without origin restrictions.

## Core API Reference

All endpoints are prefixed with `/api/` unless noted otherwise.

### Health and Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Basic health check (uptime, key status, active jobs) |
| GET | `/api/runtime/health` | Alias for `/api/health` (frontend compatibility) |
| GET | `/api/ready` | Readiness preflight: checks DB, audio dir, key config, route registration. Does NOT call OpenRouter. |
| GET | `/api/diagnostics` | Deep diagnostics: server info, recent failures, agent action log, audio directory stats |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | Read current settings (key masked, agent token fingerprint) |
| PUT | `/api/settings` | Update settings (key encrypted on save, token rotate/clear) |
| POST | `/api/settings/test` | Test OpenRouter connection (key validity, latency) |
| POST | `/api/settings/test-connection` | Alias for test endpoint |

### TTS Generation

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tts/generate` | Generate speech from text. Requires `model`, `input`, `voice`, optional `responseFormat` (wav/pcm/mp3), `directorSnapshot`. |

### History and Audio

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/history` | List generation jobs (paginated, filterable by voice/status/source/date) |
| GET | `/api/jobs/:jobId` | Get single job detail with associated audio asset metadata |
| GET | `/api/audio/:assetId` | Stream/download audio file. Append `?download=1` for Content-Disposition: attachment. |

### Voice Profiles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/voices` | List all voice profiles |
| GET | `/api/voices/:voiceId` | Future endpoint for single voice profile details |

### Agent-Controlled Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agent/generate-speech` | Agent-initiated speech generation (approval gated) |
| POST | `/api/agent/approve-action` | Approve or reject a pending agent action |

See `docs/opencode-agent-integration.md` for detailed integration guide.

### Agent CLI Remote Connection

`scripts/tts-agent-cli.ts` uses `TTS_API_URL` as the server origin and defaults to `http://127.0.0.1:3001`:

```bash
# Local default
TTS_API_URL=http://127.0.0.1:3001 npx tsx scripts/tts-agent-cli.ts task list

# Remote server; do not append /api
TTS_API_URL=https://tts.example.com npx tsx scripts/tts-agent-cli.ts production export --taskId <task-id> --format md
```

OpenRouter API keys stay on the server side only, in `.env` or encrypted Settings storage. CLI requests do not carry or print the OpenRouter API key. See [CLI Remote Connection](./docs/opencode-agent-integration.md#cli-remote-connection) for remote examples and troubleshooting for connection failures, 401/403, `expectedVersion` conflicts, and approval/cost confirmation failures.

## Agent-Controlled API Flow

The agent API follows a two-phase approval model:

### Mode: `confirm_each` (default)

```
Agent Plugin                  TTS Server
     |                            |
     |-- POST /api/agent/generate-speech -->|
     |   (Bearer <token>)                   |
     |                            |-- Validate token
     |                            |-- Check settings (agentAuthMode, budget)
     |                            |-- Create pending action log
     |<-- 202 { status: "approval_required" }
     |                            |
     |-- POST /api/agent/approve-action --->|
     |   { actionLogId, decision: "approve", scope: "once" }
     |                            |-- Claim action (optimistic concurrency)
     |                            |-- Execute generateSpeech()
     |                            |-- Update action log
     |<-- 200 { ok: true, jobId, audioUrl, ... }
```

### Mode: `session_auto`

When an approval with `scope: "session"` is granted, the server creates a bounded session (max requests, max characters, max cost, expiry). Subsequent generate-speech requests within the same conversation and within budget auto-execute without further approval prompts.

```
Agent Plugin                  TTS Server
     |                            |
     |-- approve-action (scope: "session") -->|
     |                            |-- Create session (budget caps applied)
     |                            |-- Execute first action
     |<-- 200 { ok: true, sessionId, ... }
     |                            |
     |-- generate-speech (same conversationId) -->|
     |                            |-- Find active session
     |                            |-- Reserve budget (atomic UPDATE with guard)
     |                            |-- Execute immediately (no approval needed)
     |<-- 200 { ok: true, ... }
```

### Budget Tracking

Each session enforces three concurrent limits:
- **Max Requests**: Maximum number of generate-speech calls per session
- **Max Characters**: Total input characters across all calls
- **Max Cost**: Total estimated cost (based on `charCount * 0.000021`)

Budget reservation uses an atomic SQL UPDATE with guard clauses to prevent race conditions from concurrent agent requests.

## Configuration

The following settings can be configured via `PUT /api/settings` or the Settings page in the UI:

| Setting | Default | Description |
|---------|---------|-------------|
| `defaultModel` | `google/gemini-3.1-flash-tts-preview` | Default TTS model |
| `defaultVoice` | `Zephyr` | Default voice |
| `defaultFormat` | `wav` | Default output format |
| `maxCharsPerRequest` | `5000` | Maximum input characters per generation request |
| `maxConcurrentJobs` | `2` | Maximum concurrent generation jobs |
| `agentAuthMode` | `confirm_each` | Agent approval mode (`confirm_each` or `session_auto`) |
| `agentMaxRequests` | `10` | Maximum agent requests per session |
| `agentMaxChars` | `10000` | Maximum total characters per agent session |
| `agentMaxCost` | `0.01` | Maximum estimated cost (USD) per agent session |
| `agentSessionExpiry` | `3600` | Agent session expiry in seconds (1 hour) |

## Release Packaging

The project includes a release packaging script that produces a self-contained, distributable `.tar.gz` archive with all built assets, configuration templates, and documentation.

### Package Release

```bash
# Build everything and create release archive in one command
npm run package:release
```

This single command:
1. Runs `npm run build:all` (frontend Vite build + server TypeScript compilation)
2. Stages a clean `release/staging/` directory with only production-ready files
3. Generates `release-manifest.json` with sha256 checksums for every file
4. Creates `release/tts-voice-generator-v<version>-<commit>.tar.gz`
5. Validates the archive for completeness and security

### What Gets Included

| Path | Description |
|------|-------------|
| `dist/` | Built React SPA (HTML, JS, CSS assets) |
| `server/dist/` | Compiled server TypeScript (production JavaScript) |
| `server/package.json` | Server dependency manifest |
| `server/package-lock.json` | Server dependency lockfile |
| `package.json` | Root dependency manifest |
| `package-lock.json` | Root dependency lockfile |
| `.env.example` | Environment variable template (no real keys) |
| `README.md` | This documentation |
| `ATTRIBUTIONS.md` | Third-party licenses |
| `docs/` | Integration and reference documentation |
| `guidelines/` | Development guidelines |
| `scripts/start.js` | Quick-start launcher |
| `release-manifest.json` | Build metadata, file list, sha256 checksums |

### What Gets Excluded

The following are intentionally excluded from the release package:

| Path/Pattern | Reason |
|-------------|--------|
| `node_modules/` | Runtime dependency; installed on target via `npm install --production` |
| `data/` (db, audio) | Runtime data; created on target at first launch |
| `.env` | Contains real API keys; use `.env.example` as template |
| `APIkey.md` | Credential file; never distributed |
| `agent-outputs/` | Build/test artifacts; not needed in production |
| `.git/`, `.opencode/` | Development tooling |
| `release/` | Build staging; prevents recursive packaging |
| `*.log`, `.DS_Store`, `Thumbs.db` | System/temporary files |

### Release Manifest

The `release-manifest.json` in the archive root contains:

```json
{
  "appName": "tts-voice-generator",
  "version": "0.0.1",
  "serverVersion": "0.1.0",
  "buildTime": "2026-05-07T...",
  "nodeVersion": "v20.x.x",
  "git": { "commit": "abc1234", "branch": "main" },
  "includedPaths": ["dist/index.html", "server/dist/index.js", ...],
  "excludedPatterns": ["node_modules/", "data/", ".env", ...],
  "fileCount": 42,
  "fileChecksums": { "dist/index.html": "sha256hex...", ... }
}
```

### Deploy from Release Archive

```bash
# 1. Extract
tar -xzf tts-voice-generator-v0.0.1-abc1234.tar.gz -C /opt/tts-voice-generator

# 2. Install production dependencies
cd /opt/tts-voice-generator/server && npm install --production && cd ..

# 3. Configure environment
cp .env.example .env
# Edit .env and set OPENROUTER_API_KEY

# 4. Start the server (serves both API and static frontend)
node server/dist/index.js
```

### Security Guarantee

The release packaging script:
- Never reads or includes `.env` files (real API keys)
- Never includes `APIkey.md` or any credential file
- Scans the generated manifest for leaked secret patterns
- Validates that forbidden paths are absent from the archive
- Exits with non-zero code if any validation fails

## Verification and Testing

### Test Suite

```bash
# Run all server tests
npm test

# Run with watch mode
cd server && npm run test:watch
```

### Readiness Check

```bash
curl http://localhost:3001/api/ready
```

Returns:
```json
{
  "ready": true,
  "checks": [
    {"name": "keyConfigured", "ok": true, "detail": "API key is available"},
    {"name": "dbOk", "ok": true, "detail": "DB accessible, settings row exists"},
    {"name": "audioDirWritable", "ok": true, "detail": "Audio dir: ./data/audio"},
    {"name": "routesReady", "ok": true, "detail": "Core API routes are registered and responding"}
  ],
  "summary": {
    "keyConfigured": true,
    "dbOk": true,
    "audioDirWritable": true,
    "routesReady": true
  },
  "realOpenRouterVerified": false
}
```

### Diagnostics

```bash
curl http://localhost:3001/api/diagnostics
```

Returns server version, uptime, readiness checks, recent failed jobs, recent agent actions, and audio directory stats with sensitive field redaction.

### Real OpenRouter Smoke Test

The project includes a smoke test (`server/__tests__/smoke-real-openrouter.test.ts`) that performs end-to-end validation against the real OpenRouter API. It runs only when the `OPENROUTER_API_KEY` environment variable is set.

**With Key**: Executes full generation, file verification, job detail, audio streaming, and history checks.

**Without Key**: Writes a structured `blocked` report to `agent-outputs/tester/phase4-real-openrouter-smoke/` with `realOpenRouterVerified: false`. This is an explicit precondition marker -- the test does not constitute a pass when no key is available.

In the current automated environment, the OpenRouter API key is not configured, so the real smoke test reports as blocked/skipped. This is expected and documented.

## Troubleshooting

### Server won't start

Check that port 3001 is not in use:
```bash
# Windows
netstat -ano | findstr :3001
```

### API returns "MISSING_API_KEY"

Configure your OpenRouter API key either:
1. Via the Settings page in the UI (stored encrypted in DB)
2. Via `.env` file: `OPENROUTER_API_KEY=<your-openrouter-key>`

### /api/ready reports keyConfigured=false

Check that the key is set in either the DB (via Settings UI) or the `.env` file. The readiness endpoint checks both sources via the `key-resolver` service.

### Agent endpoints return 401

Ensure:
1. A local plugin token has been generated (Settings page -> rotate/clear token)
2. The `Authorization: Bearer <token>` header is sent with the correct token
3. The token prefix is `lpt_` (e.g., `Authorization: Bearer lpt_...`)

### Audio files not found

Check that `data/audio/` exists and is writable:
```bash
ls -la data/audio/   # Unix
dir data\audio\      # Windows
```

If the directory is missing, the server will create it on startup.

## License

Proprietary. See [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) for third-party component licenses.
