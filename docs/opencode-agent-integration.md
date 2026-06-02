# OpenCode Agent Integration Guide

This document describes how an OpenCode CLI plugin (or any external AI coding agent) can call the TTS Voice Generator's Agent-Controlled API to generate speech programmatically with budget, approval, and audit controls.

## Prerequisites

- TTS Voice Generator server running locally on port 3001, or a reachable remote HTTPS deployment
- A local plugin token configured via Settings UI (or API)

## CLI Remote Connection

The project CLI in `scripts/tts-agent-cli.ts` reads the API base URL from `TTS_API_URL`. If the variable is not set, it connects to the local server at `http://127.0.0.1:3001`.

### Local default

Use the local default when the Hono server is running on the same machine:

```bash
TTS_API_URL=http://127.0.0.1:3001 npx tsx scripts/tts-agent-cli.ts task list
```

Because `http://127.0.0.1:3001` is the built-in default, the following command is equivalent:

```bash
npx tsx scripts/tts-agent-cli.ts task list
```

### Remote server

Point `TTS_API_URL` at the server origin, without a trailing `/api` path. The CLI appends API paths internally.

```bash
TTS_API_URL=https://tts.example.com npx tsx scripts/tts-agent-cli.ts task list
TTS_API_URL=https://tts.example.com npx tsx scripts/tts-agent-cli.ts production export --taskId <task-id> --format md --output production-list.md
```

If the server is exposed behind a reverse proxy, configure TLS, authentication, and network access at the proxy or deployment boundary. Do not expose an unauthenticated development server to the public internet.

### API key boundary

- The OpenRouter API key is configured only on the TTS server, either through the server-side `.env` file (`OPENROUTER_API_KEY=...`) or through the Settings UI where it is stored encrypted in the database.
- The CLI does not need, carry, print, or persist the OpenRouter API key. CLI commands only send task, document, production-list, and director-profile payloads to the configured TTS server.
- Do not add OpenRouter API keys to CLI command lines, shell history, exported logs, or generated documents.
- Local plugin tokens for `/api/agent/*` are separate from the OpenRouter API key. They authenticate agent actions to this server and must still be stored securely.

### Connection and approval troubleshooting

| Symptom | Likely cause | What to check |
|---------|--------------|---------------|
| `fetch failed`, `ECONNREFUSED`, `ENOTFOUND`, or timeout | `TTS_API_URL` points to a server that is not reachable from the CLI host | Confirm the origin is correct, omit `/api`, verify DNS/TLS/proxy routing, and check `GET <TTS_API_URL>/api/ready`. For local use, confirm the server listens on `127.0.0.1:3001`. |
| HTTP `401 UNAUTHORIZED` | Missing or invalid local plugin token for `/api/agent/*` requests, or the token was rotated/cleared | Generate or rotate the local plugin token in Settings, update the plugin configuration, and never print the token in logs. The production-list CLI commands in `scripts/tts-agent-cli.ts` do not send this token. |
| HTTP `403` or provider authorization/credit error during generation | The server reached OpenRouter but the server-side key, account, model access, or credit state is not accepted | Fix the server-side Settings or `.env` configuration. Do not pass the OpenRouter key through the CLI. Use `/api/ready` and the Settings connection test to separate server configuration problems from CLI connectivity problems. |
| HTTP `409` with `expectedVersion` or version conflict | The production list changed after the CLI fetched its current version, usually because another UI or CLI operation wrote a newer version | Re-run `production get` or `production versions`, review `production diff`, then retry import or rollback against the latest version. Do not force stale writes. |
| `approve-action` or cost confirmation fails | The action was already decided, the conversation ID does not match, `scope: "session"` is not allowed in `confirm_each`, or the estimated cost exceeds the configured budget | Re-read the original `approval_required` response, preserve its `conversationId` and `actionLogId`, verify allowed scopes, and adjust server-side agent budget settings before retrying. |

## Token Management

### Token Format

Local plugin tokens use the prefix `lpt_` followed by 32 random bytes in base64url encoding:

```
<LOCAL_PLUGIN_TOKEN>
```

### Generate or Rotate a Token

The token is generated server-side. The plaintext token is returned only once at creation time. After that, only the SHA-256 hash is stored in the database.

**Via Settings API:**

```bash
curl -X PUT http://localhost:3001/api/settings \
  -H "Content-Type: application/json" \
  -d '{"localPluginTokenAction": "rotate"}'
```

Response:
```json
{
  "ok": true,
  "openRouterKeySaved": false,
  "localPluginToken": "<LOCAL_PLUGIN_TOKEN>"
}
```

The returned `localPluginToken` is the plaintext token. Store it securely in the plugin's configuration. It will not be retrievable again.

**Via Settings UI:**

Navigate to the Settings page, find the Agent section, and click "Rotate Token". The new token will be displayed once.

### Clear a Token

```bash
curl -X PUT http://localhost:3001/api/settings \
  -H "Content-Type: application/json" \
  -d '{"localPluginTokenAction": "clear"}'
```

This invalidates all existing tokens. Existing agent sessions will fail authentication.

### Check Token Status

```bash
curl http://localhost:3001/api/settings
```

Response excerpt:
```json
{
  "agent": {
    "hasLocalPluginToken": true,
    "fingerprint": "sha256:abcd1234...efgh5678",
    "authMode": "confirm_each",
    "maxRequests": 10,
    "maxChars": 10000,
    "maxCost": 0.01,
    "sessionExpiry": 3600
  }
}
```

The `fingerprint` field shows the first and last 8 characters of the token hash, useful for verifying the correct token is in use without exposing the full hash.

## Authentication

All agent endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <LOCAL_PLUGIN_TOKEN>
```

The server:
1. Extracts the token from the `Authorization` header
2. Looks up the stored SHA-256 hash from the database settings row
3. Hashes the provided token with SHA-256
4. Compares using `crypto.timingSafeEqual` (constant-time comparison)

If any step fails, the server returns:

```json
{
  "ok": false,
  "requestId": "uuid-here",
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Local plugin token is invalid.",
    "category": "auth",
    "retryable": false
  }
}
```

## Approval Modes

The agent API supports two approval modes, configured via `agentAuthMode` in settings:

### `confirm_each` (Default)

Every speech generation request requires explicit approval. The workflow is:

```
Plugin:  POST /api/agent/generate-speech
Server:  202 { status: "approval_required", actionLogId: 42 }
Plugin:  POST /api/agent/approve-action { actionLogId: 42, decision: "approve", scope: "once" }
Server:  200 { ok: true, jobId: "...", audioUrl: "/api/audio/1" }
```

In this mode, `scope: "session"` is rejected -- only `"once"` scope is allowed.

### `session_auto`

After the first approval with `scope: "session"`, subsequent requests in the same conversation auto-execute within budget limits:

```
Plugin:  POST /api/agent/generate-speech
Server:  202 { status: "approval_required", actionLogId: 42 }
Plugin:  POST /api/agent/approve-action { actionLogId: 42, decision: "approve", scope: "session" }
Server:  200 { ok: true, sessionId: "session-uuid", jobId: "...", audioUrl: "/api/audio/1" }

-- Subsequent calls in the same conversation --

Plugin:  POST /api/agent/generate-speech (same conversationId)
Server:  200 { ok: true, sessionId: "session-uuid", jobId: "...", audioUrl: "/api/audio/2" }
```

The session is bounded by max requests, max characters, max cost, and expiry time. When any limit is reached, new requests return `approval_required` again.

## API Reference

### POST /api/agent/generate-speech

Initiate a speech generation request.

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <LOCAL_PLUGIN_TOKEN>
```

**Request Body (confirm_each mode -- approval required):**

```json
{
  "conversationId": "my-conversation-123",
  "model": "google/gemini-3.1-flash-tts-preview",
  "input": "Hello, this is a test of agent-controlled speech generation.",
  "voice": "Zephyr",
  "responseFormat": "wav",
  "directorSnapshot": null,
  "providerOptions": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `conversationId` | string | Yes | Unique identifier for the conversation context |
| `model` | string | Yes | TTS model ID |
| `input` | string | Yes | Text to convert to speech |
| `voice` | string | Yes | Voice name (e.g., "Zephyr") |
| `responseFormat` | string | No | Output format: `"wav"`, `"pcm"`, or `"mp3"`. Default: `"wav"` |
| `directorSnapshot` | object | No | Director mode scene data (speakers, transcript, profiles) |
| `providerOptions` | object | No | Additional provider-specific options |

**Response (approval required -- confirm_each mode):**

```json
{
  "ok": false,
  "requestId": "uuid-1",
  "status": "approval_required",
  "actionLogId": 42,
  "error": {
    "code": "APPROVAL_REQUIRED",
    "message": "Agent action requires approval.",
    "category": "approval",
    "retryable": false
  },
  "approval": {
    "required": true,
    "authMode": "confirm_each",
    "reason": "confirm_each",
    "allowedScopes": ["once"],
    "charCount": 57,
    "estimatedCost": 0.001197
  }
}
```

**Response (auto-approved -- session_auto mode with valid session):**

```json
{
  "ok": true,
  "requestId": "uuid-2",
  "jobId": "uuid-of-job",
  "status": "succeeded",
  "generationId": "gen-xyz",
  "assetId": 5,
  "audioUrl": "/api/audio/5",
  "contentType": "audio/wav",
  "duration": "0.5s",
  "sizeBytes": 49804,
  "charCount": 57,
  "estimatedCost": "$0.0012",
  "createdAt": "2026-05-05T12:00:00.000Z",
  "requestedFormat": "wav",
  "upstreamFormat": "pcm",
  "outputFormat": "wav",
  "sessionId": "session-uuid"
}
```

### POST /api/agent/approve-action

Approve or reject a pending agent action.

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <LOCAL_PLUGIN_TOKEN>
```

**Request Body:**

```json
{
  "actionLogId": 42,
  "conversationId": "my-conversation-123",
  "decision": "approve",
  "scope": "once"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `actionLogId` | number | Yes | The action log ID from the `approval_required` response |
| `conversationId` | string | Yes | Must match the conversation ID from the original request |
| `decision` | string | Yes | `"approve"` or `"reject"` |
| `scope` | string | No | `"once"` (default) or `"session"` (only in `session_auto` mode) |

**Response (approved -- once scope):**

```json
{
  "ok": true,
  "requestId": "uuid-3",
  "status": "succeeded",
  "jobId": "uuid-of-job",
  "assetId": 5,
  "audioUrl": "/api/audio/5",
  "contentType": "audio/wav",
  "duration": "0.5s",
  "sizeBytes": 49804,
  "charCount": 57,
  "estimatedCost": "$0.0012",
  "createdAt": "2026-05-05T12:00:00.000Z",
  "requestedFormat": "wav",
  "upstreamFormat": "pcm",
  "outputFormat": "wav"
}
```

**Response (approved -- session scope):**

Same as above, plus a `sessionId` field:
```json
{
  "ok": true,
  "sessionId": "uuid-of-session",
  ...
}
```

**Response (rejected):**

```json
{
  "ok": true,
  "requestId": "uuid-4",
  "status": "rejected",
  "actionLogId": 42
}
```

**Error Responses:**

| HTTP Status | Code | Meaning |
|-------------|------|---------|
| 401 | `UNAUTHORIZED` | Missing or invalid Bearer token |
| 404 | `ACTION_NOT_FOUND` | Action log ID does not exist |
| 409 | `CONVERSATION_MISMATCH` | conversationId does not match the original action |
| 409 | `ACTION_ALREADY_DECIDED` | Action was already approved or rejected |
| 409 | `SESSION_SCOPE_NOT_ALLOWED` | scope "session" requested in confirm_each mode |
| 409 | `AGENT_BUDGET_EXCEEDED` | Initial action exceeds session budget |

## Budget and Audit

### Session Budget Limits

| Limit | Default | Description |
|-------|---------|-------------|
| Max Requests | 10 | Total generate-speech calls per session |
| Max Characters | 10,000 | Cumulative input characters |
| Max Cost | $0.01 | Cumulative estimated cost (USD) |
| Expiry | 3600s | Session auto-expires after 1 hour |

### Cost Estimation

Cost is estimated at `charCount * 0.000021` (USD). Actual cost depends on the OpenRouter provider.

### Atomic Budget Reservation

When a session is active, each `generate-speech` request reserves budget atomically:

```sql
UPDATE agent_session
SET used_requests = used_requests + 1,
    used_chars = used_chars + ?,
    used_cost = round(used_cost + ?, 8),
    updated_at = unixepoch()
WHERE id = ?
  AND status = 'active'
  AND expires_at > unixepoch()
  AND used_requests + 1 <= max_requests
  AND used_chars + ? <= max_chars
  AND used_cost + ? <= max_cost
```

If the UPDATE affects zero rows (`changes === 0`), the budget has been exceeded and the request is rejected.

### Action Audit Log

Every agent action is recorded in the `agent_action_log` table with:

- `conversationId`: Which conversation initiated it
- `actionType`: Always `"generate_speech"` for TTS requests
- `toolName`: Always `"generate-speech"`
- `sessionId`: The session it belongs to (if any)
- `approvalStatus`: `"not_required"`, `"pending"`, `"approved"`, or `"rejected"`
- `approvalScope`: `"once"` or `"session"`
- `relatedJobId`: The generation job created
- `estimatedCost`: Cost estimate at submission time
- Timestamps for creation, approval, and completion

View recent actions via the diagnostics endpoint:

```bash
curl http://localhost:3001/api/diagnostics | jq '.recentAgentActions'
```

## Complete Workflow Example

### confirm_each Mode

```bash
# 1. Generate speech (approval required)
curl -s -X POST http://localhost:3001/api/agent/generate-speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <LOCAL_PLUGIN_TOKEN>" \
  -d '{
    "conversationId": "conv-001",
    "model": "google/gemini-3.1-flash-tts-preview",
    "input": "System check complete. All modules operational.",
    "voice": "Zephyr"
  }' | jq .

# Response includes actionLogId (e.g., 42)

# 2. Approve the action
curl -s -X POST http://localhost:3001/api/agent/approve-action \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <LOCAL_PLUGIN_TOKEN>" \
  -d '{
    "actionLogId": 42,
    "conversationId": "conv-001",
    "decision": "approve",
    "scope": "once"
  }' | jq .

# Response includes audioUrl for playback
```

### session_auto Mode

```bash
# 1. Generate speech (approval required -- no session yet)
curl -s -X POST http://localhost:3001/api/agent/generate-speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <LOCAL_PLUGIN_TOKEN>" \
  -d '{
    "conversationId": "conv-002",
    "model": "google/gemini-3.1-flash-tts-preview",
    "input": "Beginning build process.",
    "voice": "Zephyr"
  }' | jq .

# Response: approval_required, actionLogId = 43

# 2. Approve with session scope
curl -s -X POST http://localhost:3001/api/agent/approve-action \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <LOCAL_PLUGIN_TOKEN>" \
  -d '{
    "actionLogId": 43,
    "conversationId": "conv-002",
    "decision": "approve",
    "scope": "session"
  }' | jq .

# Response includes sessionId

# 3. Subsequent calls auto-execute (same conversationId)
curl -s -X POST http://localhost:3001/api/agent/generate-speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <LOCAL_PLUGIN_TOKEN>" \
  -d '{
    "conversationId": "conv-002",
    "model": "google/gemini-3.1-flash-tts-preview",
    "input": "Build completed successfully.",
    "voice": "Zephyr"
  }' | jq .

# Response: ok: true, auto-executed within session budget
```

## Security Considerations for Plugin Developers

### Token Storage

- Store the local plugin token securely. On Unix systems, use file permissions (`0600`). On Windows, restrict access to the plugin's config directory.
- Never commit the token to version control. Add the token file to `.gitignore`.
- Rotate tokens periodically. A token rotation invalidates the old token immediately.

### Request Validation

- Always verify the `conversationId` matches your expected context before sending `approve-action`.
- Check the `approval.allowedScopes` field in the `approval_required` response before deciding on a scope.
- Do not hard-code the `actionLogId` -- always capture it from the `approval_required` response.

### Error Handling

- Handle `401 UNAUTHORIZED`: Token expired or invalid. Prompt for token rotation.
- Handle `409 AGENT_BUDGET_EXCEEDED`: Session limits reached. Create a new conversation or wait for session expiry.
- Handle `409 ACTION_ALREADY_DECIDED`: A concurrent process may have already approved/rejected the action. Treat as a no-op.
- Handle `409 CONVERSATION_MISMATCH`: Indicates a bug in conversation tracking. Review your conversation ID management.

### Budget Awareness

- Before approving with `scope: "session"`, review the session budget limits in settings:
  - Default max cost: $0.01 per session
  - Default max characters: 10,000 per session
  - Default max requests: 10 per session
- Long-running conversations may need higher limits. Adjust via Settings API before creating the session.

## OpenCode Runtime

This section describes how the desktop application resolves and executes OpenCode. It covers the runtime selection strategy, resource layout, build configuration, and troubleshooting.

### Runtime Selection Order

The application resolves the OpenCode runtime in the following priority order. The first source that produces a usable runtime wins.

```
1. explicit  -- OPENCODE_BIN_PATH environment variable
2. local     -- User's locally installed OpenCode (PATH, npm, pnpm, bun, scoop, chocolatey, homebrew)
3. bundled   -- OpenCode binary embedded in the desktop application package
4. missing   -- No runtime found; diagnostics returned
```

**Local-first guarantee**: If the user has installed OpenCode on their machine, that installation is always preferred. The bundled runtime is only used when no local installation is found or when the local installation cannot safely execute `opencode run`.

### How It Works for Users

| User scenario | What happens |
|---------------|--------------|
| User has OpenCode installed via npm/pnpm/bun/scoop/chocolatey/homebrew | Application detects and uses the local version. Bundled runtime is ignored. |
| User has not installed OpenCode | Application falls back to the bundled runtime embedded in the desktop package. No manual installation required. |
| User sets `OPENCODE_BIN_PATH` | That path takes absolute priority over all other sources. |
| Neither local nor bundled is available | Application reports `runtimeSource: "missing"` with diagnostic details. Agent features are unavailable. |

### Checking Runtime Status

The runtime source and diagnostics are available through the status endpoint:

```bash
curl http://localhost:3001/api/settings/opencode/status
```

Response fields related to runtime resolution:

```json
{
  "availability": {
    "available": true,
    "installMethod": "bundled",
    "pathState": "bundled",
    "runtimeSource": "bundled",
    "bundledRuntime": {
      "candidateRoots": ["C:\\Program Files\\TTS Voice Generator\\resources\\opencode-runtime"],
      "executablePath": "C:\\Program Files\\TTS Voice Generator\\resources\\opencode-runtime\\bin\\opencode.exe",
      "manifestPath": "C:\\Program Files\\TTS Voice Generator\\resources\\opencode-runtime\\manifest.json",
      "version": "v1.x.x",
      "missingReason": null
    },
    "localResolutionError": null
  }
}
```

| Field | Values | Description |
|-------|--------|-------------|
| `runtimeSource` | `"explicit"`, `"local"`, `"bundled"`, `"missing"` | Which source provided the OpenCode runtime |
| `installMethod` | `"npm"`, `"chocolatey"`, `"scoop"`, `"path"`, `"bundled"`, `"unknown"` | How OpenCode was installed |
| `pathState` | `"system-path"`, `"augmented-path"`, `"bundled"`, `"not-found"` | Where in the resolution chain OpenCode was found |
| `bundledRuntime.candidateRoots` | Array of paths | All directories searched for bundled runtime |
| `bundledRuntime.executablePath` | String or null | Path to the found bundled binary |
| `bundledRuntime.missingReason` | String or null | Why bundled resolution failed, if applicable |
| `localResolutionError` | String or null | Why local resolution failed, if applicable |

### Resource Layout

The bundled runtime follows a consistent directory structure across development, staging, and production environments.

**Source directory (repository):**

```
resources/opencode-runtime/
  win32-x64/
    manifest.json
    bin/
      opencode.exe
  darwin-x64/
    manifest.json
    bin/
      opencode
  darwin-arm64/
    manifest.json
    bin/
      opencode
```

**Desktop stage directory (after `prepare-desktop-runtime`):**

```
dist-desktop/app-win32-x64/
  opencode-runtime/
    manifest.json
    bin/
      opencode.exe
```

**Electron packaged application (production):**

```
process.resourcesPath/
  opencode-runtime/
    manifest.json
    bin/
      opencode(.exe)
```

The `manifest.json` file tracks the bundled runtime metadata:

```json
{
  "name": "opencode",
  "source": "opencode reference repo or release artifact",
  "version": "v1.x.x",
  "target": "win32-x64",
  "binary": "bin/opencode.exe",
  "referenceHead": "8a17bc4de",
  "preparedAt": "2026-06-02T00:00:00.000Z"
}
```

Key points:
- Only the current platform's runtime is included in the package (not all platforms).
- The binary is placed outside the asar archive via `extraResources` in electron-builder configuration, ensuring it can be spawned directly.
- The manifest is required at build/package time -- `manifest.target` must match the target platform-arch for the build to succeed. At runtime, the binary works without the manifest, but the manifest provides version tracking for auditing and verification.

### Bundled Candidate Paths

At runtime, the resolver checks candidate directories in this order:

| Priority | Source | Path pattern | When used |
|----------|--------|-------------|-----------|
| 1 | `OPENCODE_BUNDLED_RUNTIME_DIR` env var | User-specified absolute path | Testing, development override, or manual fallback |
| 2 | Electron `process.resourcesPath` | `<resourcesPath>/opencode-runtime` | Production packaged app |
| 3 | Desktop stage app | `<cwd>/opencode-runtime` | Running from stage directory |
| 4 | Development source | `<cwd>/resources/opencode-runtime/<platform>-<arch>` | Development mode |

The `OPENCODE_BUNDLED_RUNTIME_DIR` environment variable only accepts absolute paths. Relative paths are silently skipped.

### Build and Packaging

#### Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENCODE_BUNDLED_RUNTIME_DIR` | Override source directory for the bundled runtime during build or at runtime | No |
| `OPENCODE_BUNDLED_RUNTIME_OPTIONAL` | Set to `true` to skip bundled runtime with a warning instead of failing the build | No (never set for release builds) |
| `OPENCODE_REFERENCE_REPO` | Path to the OpenCode reference repository for copying build artifacts | No (dev only) |

#### Prepare Script

`scripts/prepare-desktop-runtime.js` copies the bundled runtime into the stage directory. It searches for the runtime in this order:

1. `OPENCODE_BUNDLED_RUNTIME_DIR` (if set and exists)
2. `resources/opencode-runtime/<targetId>` (repository source directory)
3. `OPENCODE_REFERENCE_REPO/packages/opencode/dist/...` (dev build from reference repo)

If no runtime is found, the script fails with a clear error listing all searched locations. Set `OPENCODE_BUNDLED_RUNTIME_OPTIONAL=true` for development builds that do not need OpenCode.

#### Verify Script

`scripts/verify-opencode-runtime.js` validates the bundled runtime structure:

```bash
# Verify a specific stage directory
node scripts/verify-opencode-runtime.js --stage dist-desktop/app-win32-x64 --platform win32 --arch x64

# Verify a specific runtime directory
node scripts/verify-opencode-runtime.js --dir ./opencode-runtime --platform win32 --arch x64
```

The script checks:
- `manifest.json` exists and is valid JSON
- `manifest.target` is present, is a non-blank string, and matches the expected platform-arch
- Binary exists at `bin/opencode(.exe)` (or flat layout)
- Binary is not a `.cmd`/`.bat` file
- Runtime directory is not inside an asar archive

#### Electron Builder Configuration

`electron-builder.config.cjs` includes the runtime as an `extraResources` entry:

```js
extraResources: [
  // ... other resources ...
  {
    from: path.resolve(appDir, "opencode-runtime"),
    to: "opencode-runtime",
    filter: ["**/*"],
  },
]
```

This ensures the runtime binary is placed in `process.resourcesPath/opencode-runtime/`, outside the asar archive.

### Install Plan Behavior

When the bundled runtime is available, the install plan response changes:

- `controlledInstallAvailable` is `false`
- The warning message reads: "OpenCode 内嵌运行时已可用，无需手动安装。如需使用本地版本，可通过 npm/pnpm/bun 全局安装。"
- The user is not prompted to install OpenCode globally

When a local installation is found (not bundled), the warning reads: "OpenCode CLI 已安装且可执行，无需重新安装。"

### Security

The bundled runtime preserves all existing security boundaries:

- All `spawn()` calls use `shell: false`. No `cmd.exe /c` wrappers.
- The bundled binary must pass `isSafeOpenCodeNativeExecutableTarget()` validation: on Windows it must be named `opencode.exe`, on other platforms `opencode`. `.cmd` and `.bat` files are never accepted as bundled binaries.
- Child process environment uses the safe env filter -- no API keys, tokens, or secrets are passed through.
- The bundled runtime does not manage user credentials. Provider credentials (API keys) must still be configured separately.

### Troubleshooting

#### Local OpenCode is not used despite being installed

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Status shows `runtimeSource: "bundled"` but user has OpenCode installed | Local OpenCode is on PATH but the Windows `.cmd` shim cannot be safely resolved to a native executable | Check `localResolutionError` in the status response for the specific reason the local shim was rejected (e.g., shim target could not be resolved, or no safe Node executable found for the shim). The bundled runtime is used as a fallback. |
| Status shows `runtimeSource: "missing"` but `opencode --version` works in terminal | The application's PATH augmentation does not cover the installation location | Check `effectivePathCandidates` in the diagnostics. The install directory may not be in the augmented PATH (e.g., custom npm prefix, non-standard scoop directory). |

#### Bundled runtime is not found

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Desktop app shows `runtimeSource: "missing"`, `bundledRuntime.missingReason` is not null | The `opencode-runtime` directory is missing from the packaged resources | This indicates a build/packaging issue. Verify that `scripts/prepare-desktop-runtime.js` completed successfully and that `electron-builder.config.cjs` includes the `opencode-runtime` extraResources entry. |
| `bundledRuntime.candidateRoots` is empty | The application is not running in Electron context and no env override is set | Set `OPENCODE_BUNDLED_RUNTIME_DIR` to the directory containing `bin/opencode(.exe)`. This is expected in development or non-Electron server mode. |
| Binary exists but fails safety check | The file at the expected path is not a valid native `opencode`/`opencode.exe` binary | Check that the binary is the correct platform-native executable. `.cmd`, `.bat`, and files with wrong names are rejected. |

#### Provider credentials are missing

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Status shows `cliAvailable: true`, `runAvailable: true` but `available: false` | The bundled (or local) OpenCode CLI is present but no provider credentials are configured | This is expected behavior. The runtime provides the CLI; credentials are a separate concern. Configure provider credentials (API keys) through the Settings UI or OpenCode's own `auth.json`. The bundled runtime does not auto-configure credentials. |
| `opencode run` fails with provider error | OpenCode CLI is working but the configured provider rejected the request | Check the provider API key, account status, and model access. Use the Settings UI connection test to validate. |

### Version Updates

The bundled OpenCode version is fixed at application build time and ships with each release. It does not auto-update at runtime. To upgrade the bundled OpenCode:

1. Update the runtime files in `resources/opencode-runtime/<targetId>/`
2. Update `manifest.json` with the new version and `referenceHead`
3. Build and release a new version of the desktop application

Users who prefer the latest OpenCode version can install it locally -- the local version always takes priority over the bundled version.

## Limitations

1. **No streaming**: Audio is generated synchronously and returned as a complete file. Large inputs may take several seconds.
2. **No queue**: Requests above `maxConcurrentJobs` are rejected, not queued. The caller must retry.
3. **Single provider**: Only OpenRouter (Gemini TTS) is supported as the upstream provider.
4. **Local only**: The API is designed for localhost use. Do not expose port 3001 to the public internet without additional authentication and rate limiting.
5. **No webhook callbacks**: The agent must poll or use the response synchronously. There is no async callback mechanism.
