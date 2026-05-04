# Frontend API Integration Report

## Overview

| Item | Detail |
|------|--------|
| Task | Frontend real API integration -- replace demo data with backend endpoints |
| Changed Files | 8 |
| Design Direction | Production API-first, zero demo artifacts, backend-driven state |

## Design Decisions

1. **All demo text removed from pages/components**: No "Demo API: simulated", "演示模式", or mock status indicators remain. All UI reflects real backend state.
2. **Dynamic voice list from backend**: GeneratePage, DirectorPage, and VoicesPage now pull voice options from `/api/voices` via AppContext instead of hardcoded `VOICE_OPTIONS` array.
3. **MISSING_API_KEY error path**: All generation/probe/test-connection flows correctly surface the `MISSING_API_KEY` error code from backend, with actionable UI ("go to Settings" link in RightPanel error state, "no-key" probe status in VoicesPage).
4. **Settings page real API integration**: Form state syncs from `GET /api/settings`, save sends real values via `PUT /api/settings`, test-connection calls `POST /api/settings/test`, key masking displayed from backend `***configured***` response.
5. **HistoryDetailPage fully dynamic**: Loads real job data from `GET /api/jobs/:jobId`, displays real audio player/download, director snapshot, parameter snapshot, error details. No static demo content.

## Code Change List

| File | Change Type | Description |
|------|------------|-------------|
| `src/app/components/TopBar.tsx` | Rewritten | Fetches `/api/health` on mount, shows dynamic status indicator (green=OK+Key, yellow=OK/Key missing, red=unreachable) |
| `src/app/components/BottomBar.tsx` | Rewritten | Polls `/api/health` every 30s, shows backend version, history record count, real connection status |
| `src/app/components/RightPanel.tsx` | Modified | Removed all demo text; added Settings link for MISSING_API_KEY errors; download uses real format extension; playback uses `/api/audio/:assetId`; removed demo audio blob reference |
| `src/app/pages/GeneratePage.tsx` | Modified | Voice options from backend via AppContext; removed demo placeholder text; removed demo notice block; syncs default voice from settings |
| `src/app/pages/SettingsPage.tsx` | Rewritten | Real API Key save via PUT; test-connection via POST `/api/settings/test`; key masking from backend; latency display; form syncs from backend on load; removed all demo text |
| `src/app/pages/VoicesPage.tsx` | Modified | Loading state while fetching voices; MISSING_API_KEY probe status with warning icon; handles empty lastVerified; loading spinner |
| `src/app/pages/HistoryPage.tsx` | Modified | Better empty state (no records at all vs filtered empty); removed demo-specific imports |
| `src/app/pages/HistoryDetailPage.tsx` | Rewritten | Full backend data fetch from `/api/jobs/:jobId`; real audio player/download via `/api/audio/:assetId`; error state with retry; loading state; director snapshot display; parameter snapshot from real data |
| `src/app/pages/DirectorPage.tsx` | Modified | Voice options from backend; removed demo notice block |

## Self-Test Report

| Check | Status | Notes |
|-------|--------|-------|
| Build passes | PASS | `npm run build` completed in 1.89s, no errors |
| All demo text removed | PASS | `grep` for "demo/Demo/演示/DEMO" in pages/ and components/ returns zero matches |
| httpAdapter only (no demoAdapter imports) | PASS | Only `httpAdapter` imported in AppContext, demoAdapter exists but unused |
| Backend health endpoint verified | PASS | `GET /api/health` returns `{status: "ok", openRouterConfigured: false}` |
| Settings GET verified | PASS | `GET /api/settings` returns masked key + real defaults |
| Settings test-connection verified | PASS | `POST /api/settings/test` returns `{ok: false, error: "MISSING_API_KEY"}` |
| Voices list verified | PASS | `GET /api/voices` returns 30 voice profiles |
| TTS generate error verified | PASS | `POST /api/tts/generate` returns `{status: "failed", error: {code: "MISSING_API_KEY"}}` |
| History endpoint verified | PASS | `GET /api/history` returns records from failed generation attempts |
| Dynamic voice options | PASS | GeneratePage and DirectorPage use voices from AppContext (fetched via `/api/voices`) |
| RightPanel MISSING_API_KEY link | PASS | Error state shows "go to Settings" Link component when code === "MISSING_API_KEY" |
| Settings page key masking | PASS | Shows placeholder when backend returns `***configured***`, does not expose plaintext |
| HistoryDetailPage real data | PASS | Fetches from `/api/jobs/:jobId`, displays loading/error/success states |

## Verification Commands and Results

```bash
# Build verification
cd D:/workpace-maorun/tts-voice-generator && npm run build
# Result: PASS - 1622 modules transformed, no errors

# Backend API verification (with server running on :3001)
curl http://127.0.0.1:3001/api/health
# Result: {"status":"ok","version":"0.1.0","openRouterConfigured":false,...}

curl http://127.0.0.1:3001/api/settings
# Result: {"openRouterApiKey":"***configured***","defaultModel":"google/gemini-3.1-flash-tts-preview",...}

curl -X POST http://127.0.0.1:3001/api/settings/test
# Result: {"ok":false,"latencyMs":0,"modelAvailable":false,"error":"MISSING_API_KEY"}

curl http://127.0.0.1:3001/api/voices
# Result: 30 voice profiles returned

curl -X POST http://127.0.0.1:3001/api/tts/generate -H 'Content-Type: application/json' -d '{"model":"google/gemini-3.1-flash-tts-preview","input":"test","voice":"alloy","responseFormat":"mp3"}'
# Result: {"status":"failed","error":{"code":"MISSING_API_KEY","message":"OpenRouter API Key is not configured..."}}

curl http://127.0.0.1:3001/api/history?page=1&pageSize=10
# Result: Real records from failed generation attempts
```

## Remaining Issues (require backend/tester collaboration)

| Issue | Owner | Description |
|-------|-------|-------------|
| Key reloaded on server restart | Coder | `process.env.OPENROUTER_API_KEY` is not reloaded from DB on server restart. `/api/health` shows `openRouterConfigured: false` even when DB has a key. Need startup routine to read key from DB into env. |
| Audio waveform is placeholder | Designer | The audio waveform bars in RightPanel and HistoryDetailPage are still random height divs, not a real waveform visualizer. This is cosmetic and can be addressed in a later phase. |
| History voice filter hardcoded | Designer | HistoryPage voice filter dropdown uses hardcoded options. Should be populated from `/api/voices` response for dynamic voice list. |
| History audio playback in list | Designer | HistoryPage list "play" button does not yet call `/api/audio/:assetId`. Currently only HistoryDetailPage has full audio playback. |
| Agent auth settings | Coder | SettingsPage Agent auth section shows "pending implementation" status. Backend `/api/settings` does not yet return agent auth fields. |
| Plugin token | Coder | SettingsPage plugin token section shows "pending implementation". Backend endpoint not yet available. |
| Voice probe result refresh | Designer | After successful probe in VoicesPage, the voice status in the list should refresh from `/api/voices` to show updated `verifiedStatus`. Currently only probeStatuses local state updates. |
| E2E browser testing | Tester | Full browser E2E verification with `agent-browser` skill needed to confirm all states render correctly. |

## Suggested Next Steps

- **谛听 (reviewer)**: Review all 8 changed files for code quality, type safety, and API contract alignment
- **鲁班 (coder)**: Fix the server startup key reload issue (read `openRouterApiKey` from DB into `process.env` on init)
- **孙悟空 (tester)**: E2E browser testing of the no-key error flow across all pages
