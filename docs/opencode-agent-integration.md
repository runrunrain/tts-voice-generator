# OpenCode Agent Integration Guide

This document describes how an OpenCode CLI plugin (or any external AI coding agent) can call the TTS Voice Generator's Agent-Controlled API to generate speech programmatically with budget, approval, and audit controls.

## Prerequisites

- TTS Voice Generator server running locally on port 3001
- A local plugin token configured via Settings UI (or API)

## Token Management

### Token Format

Local plugin tokens use the prefix `lpt_` followed by 32 random bytes in base64url encoding:

```
lpt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
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
  "localPluginToken": "lpt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
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
Authorization: Bearer lpt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
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

## Limitations

1. **No streaming**: Audio is generated synchronously and returned as a complete file. Large inputs may take several seconds.
2. **No queue**: Requests above `maxConcurrentJobs` are rejected, not queued. The caller must retry.
3. **Single provider**: Only OpenRouter (Gemini TTS) is supported as the upstream provider.
4. **Local only**: The API is designed for localhost use. Do not expose port 3001 to the public internet without additional authentication and rate limiting.
5. **No webhook callbacks**: The agent must poll or use the response synchronously. There is no async callback mechanism.
