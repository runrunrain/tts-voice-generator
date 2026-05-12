# TTS Voice Generator -- Development Guidelines

This document defines coding standards, architectural conventions, and quality gates for AI coding agents working on this project. All agents must follow these rules.

## 1. Architecture and Layering

### Frontend (`src/`)

- **Framework**: React 18 with TypeScript, functional components only (no class components).
- **Styling**: Tailwind CSS 4 utility classes. Do NOT add new CSS files. Use the existing `tailwind.config` setup.
- **UI Components**: Radix UI primitives wrapped in `src/app/components/ui/`. MUI for complex components (icons, data tables). shadcn/ui pattern for component composition.
- **State Management**: React Context (`AppContext.tsx`) for global state. Keep context providers minimal -- only store truly global data. Component-local state via `useState`/`useReducer` for everything else.
- **Routing**: react-router 7. All routes defined in `src/app/routes.tsx`.
- **API Adapters**: `src/app/services/` uses `httpAdapter.ts` for real backend API calls. Keep frontend data flows wired to the Hono API; do not add demo/offline adapters to production code paths.
- **File Organization**: Page components in `src/app/pages/`. Reusable shared components in `src/app/components/`. Keep files under 300 lines. Split large components into sub-components.

### Backend (`server/`)

- **Framework**: Hono 4 running on `@hono/node-server`. Route handlers are pure functions receiving `Context`.
- **Database**: SQLite via `better-sqlite3` with Drizzle ORM. Schema defined in `server/src/db/schema.ts`. Use Drizzle's query builder -- never write raw SQL unless for atomic operations (e.g., `reserveSessionBudget`).
- **Service Layer**: Business logic in `server/src/services/`. Routes delegate to services -- route handlers must not contain business logic.
- **Configuration**: All env vars centralized in `server/src/config/env.ts`. Import from this module only; never read `process.env` directly elsewhere.
- **API Key Resolution**: Use `server/src/services/key-resolver.ts` (`resolveApiKey()`, `requireApiKey()`, `isOpenRouterConfigured()`). Never read `env.openRouterApiKey` directly outside of `key-resolver.ts`.

### Layer Boundaries

```
Route handlers -> Services -> Provider / Auth / DB
     |              |
     v              v
  Request        Business
  validation     logic only
  only
```

- Route handlers: validate input (Zod), call service, format response.
- Services: execute business logic, interact with DB, call external APIs.
- Routes must never import each other. Services must never import route modules.

## 2. TypeScript Standards

- **Strict mode**: `strict: true` in `tsconfig.json`. No `any` types in production code. Use `unknown` and type guards.
- **Explicit return types**: Functions exported from modules must have explicit return type annotations.
- **Zod for validation**: All API input must be validated with Zod schemas. Use `safeParse`, never `parse` (which throws). Return structured error responses from `safeParse` failures.
- **Interfaces over types**: Prefer `interface` for object shapes, `type` for unions and intersections.
- **Named exports**: Prefer named exports over default exports for better IDE support and tree-shaking. Exception: route modules use `export default app` (Hono convention).

## 3. Error Handling

### API Responses

All error responses must follow this structure:

```typescript
{
  ok: false,
  requestId: string,        // UUID for tracing
  jobId: string | null,     // Present if a job was created before failure
  status: "failed",
  error: {
    code: string,           // Machine-readable error code (e.g., "MISSING_API_KEY", "TEXT_TOO_LONG")
    message: string,        // Human-readable error message
    category: "validation" | "auth" | "throttle" | "upstream" | "internal" | "unknown",
    retryable: boolean,
    metadata?: object       // Additional structured context
  },
  charCount?: number,
  createdAt: string         // ISO 8601
}
```

### Error Categories

| Category | HTTP Status | When to Use |
|----------|-------------|-------------|
| `validation` | 400 | Bad input, text too long, model not found |
| `auth` | 401/402/403 | Missing/invalid key, insufficient credits |
| `throttle` | 429/503 | Rate limited, concurrency limit |
| `upstream` | 502/503 | Provider errors, network failures, timeouts |
| `internal` | 500 | Unhandled server errors |
| `unknown` | -- | Unclassified errors |

### Key Principles

- Never throw exceptions to signal expected error conditions. Return error response objects instead.
- Catch all exceptions in route handlers with a `.onError` handler that returns structured JSON.
- Log errors to console with `[server]` prefix. Never log API keys, tokens, or raw error metadata without sanitization.
- Error messages in responses must not contain sensitive data (keys, tokens, internal paths). Use `sanitizeText()` from `openrouter-provider.ts`.

## 4. Security Requirements

### API Key Protection

- **NEVER** return plaintext API keys in any response (GET, POST error messages, logs, diagnostics).
- **NEVER** log API keys. Use the `maskApiKey()` function for display purposes.
- **NEVER** store API keys in plaintext in the database. Always encrypt with `encryptApiKey()` before storing.
- **NEVER** include API keys in test files, commit messages, or documentation. Use placeholder values.
- **ALWAYS** sanitize error metadata with `sanitizeErrorMetadata()` before storing or returning.

### Agent Token Protection

- **NEVER** store plaintext local plugin tokens. Store only the SHA-256 hash.
- Use `crypto.timingSafeEqual` for token comparison to prevent timing attacks.
- Tokens must use the `lpt_` prefix. Reject tokens without it.

### General

- Input validation: Every endpoint must validate input with Zod before processing.
- CORS: Only whitelist local development origins. Production serves SPA from the same origin (no CORS needed).
- File paths: Sanitize any user-supplied paths. Audio file access goes through asset IDs, never raw file paths.
- SQL injection: Use Drizzle ORM's parameterized queries. Raw SQL in `reserveSessionBudget` is atomic and parameterized -- review carefully if modifying.

## 5. Testing Standards

### Test Framework

- **Runner**: Vitest
- **Location**: `server/__tests__/`
- **Naming**: `*.test.ts` for unit/integration tests

### Required Test Coverage

| Area | Minimum | Notes |
|------|---------|-------|
| API endpoints | All routes | Each route must have at least one happy-path test |
| Validation | All Zod schemas | Test edge cases (empty string, max length, invalid enum) |
| Error handling | All error categories | Test that each error code is returned correctly |
| Security | Key encryption, token auth | Verify masked responses, token rejection |
| Agent flow | confirm_each + session_auto | Both approval modes must be tested |

### Test Principles

- Tests must be self-contained. Each test sets up its own state.
- Do NOT rely on real external APIs in unit tests. Mock `fetch` for OpenRouter calls.
- The real OpenRouter smoke test (`smoke-real-openrouter.test.ts`) is an exception: it runs against the real API but only when `OPENROUTER_API_KEY` is set.
- Never mock a successful API call when the key is not configured. Write the test to explicitly report `blocked` status.
- Tests must not contain real API keys. Use environment variables.

### Browser Verification

- Frontend changes that affect user interaction must be verified in a real browser.
- Use the `agent-browser` skill or equivalent tool to:
  1. Navigate to the page in question
  2. Verify key UI elements render correctly
  3. Test user interaction flows (form submission, navigation, audio playback)
  4. Verify loading, empty, error, and success states
- Do NOT substitute API-level testing for browser verification of UI features.

## 6. Quality Gates (Per-Phase)

Before claiming a phase is complete, verify:

1. All tests pass for the phase's test suite
2. The server starts without errors
3. `/api/ready` returns all checks passing (except `keyConfigured` if no key is set)
4. No TypeScript errors (`npm run typecheck` in server/, build succeeds for frontend)
5. No real API keys or tokens in test output, error messages, or logs

## 7. Prohibited Practices

These are hard violations. Code containing any of these will be rejected:

| Practice | Why Prohibited |
|----------|---------------|
| Mocking success when real API is unavailable | Must report blocked/skip, not fake a pass |
| Hardcoding API keys, tokens, or credentials | Security violation |
| `console.log` as error handling | Use proper error response objects |
| TODO/FIXME/HACK as business logic | Must implement or remove before delivery |
| Skipping input validation | All external input must be validated |
| Exposing internal paths in error messages | Information leak |
| Returning raw `Error.message` to clients without sanitization | May leak internals |
| Using `parse()` instead of `safeParse()` for API input | Crashes the request instead of returning a structured error |
| Reading `process.env` directly outside `env.ts` | Violates single source of truth for config |

## 8. Commit and Version Control

- Never commit `.env` files or any file containing real credentials
- Never commit `data/` directory contents
- Never commit `node_modules/` or `dist/`
- Commit messages should describe what changed and why
- Each phase completion should be a separate logical commit

## 9. OpenRouter API Usage Notes

- **Model**: `google/gemini-3.1-flash-tts-preview` is the primary TTS model.
- **Response Format**: Gemini TTS only supports upstream `pcm` (24 kHz, 16-bit, mono). The server wraps raw PCM into RIFF WAV for browser compatibility.
- **Cost**: Estimated at $0.000021 per character. Actual cost may vary.
- **Rate Limiting**: The provider implements exponential backoff with jitter for retryable errors (429, 5xx, network). Maximum 3 attempts with 30-second max delay.
- **Concurrency**: Server-level concurrency control rejects requests above `maxConcurrentJobs` (default 2).

## 10. Documentation Standards

- README must reflect the current state of the project. Update it when adding new features, endpoints, or configuration options.
- Agent integration documentation must use placeholders for tokens (e.g., `<LOCAL_PLUGIN_TOKEN>`), never real tokens.
- API documentation must include request/response examples.
- Error codes must be documented with their meaning and resolution steps where applicable.
