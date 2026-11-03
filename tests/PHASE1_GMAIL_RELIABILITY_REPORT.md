# Daylight Remediation — Phase 1 Evidence Report: Gmail fetching reliability

**Date:** 3 Nov 2026 · **Status:** implemented in the working tree, **not committed, pushed or deployed** · Plan: `tests/PHASE1_PLAN.md`

## Results at a glance

| Metric (one refresh, same plan) | Before (v101) | After (Phase 1) | Evidence |
|---|---|---|---|
| Google requests, real mailbox | 184 | **138** cold · **20** warm | LIVE |
| Peak requests in 1 s, real mailbox | 177 | **18** | LIVE |
| Gmail quota units, real mailbox | ~9,600 (> 6,000/min limit) | **4,066** cold · **706** warm | LIVE |
| Quota 403 errors, real mailbox | yes (3/6 thread fetches; probe 403 "Units per minute per user") | **0** across 3 runs (197 calls, all HTTP 200) | LIVE |
| Duplicate message GETs, real mailbox | 49 (162 GETs / 113 unique) | **0** same-format duplicates (117 GETs for 114 unique = 3 planned metadata→full body upgrades; 38 overlapping search hits de-duplicated before fetching) | LIVE |
| Max requests in flight | 153 | **6** | SIM + E2E |
| Records lost silently (simulated quota contention) | 33 of 94 | **0** | SIM S1 |
| Status when records were lost | "Connected to Google · updated" | "Partial sync · Gmail partly synced · 3 failed … · last full sync 21:02" | E2E E2/E8 |
| Sync state stored under the right account | no (written to `acct:local:device`) | yes | E2E E1 |
| Duration, cold | ~2–4 s | 12.5 s live (quota-paced; 6 in flight) | LIVE |

LIVE = the new engine run read-only against your real account in Claude's browser pane, on Daylight's own origin (`privacy.html`, so the deployed dashboard didn't also run). SIM = `tests/gmail-sync-sim.js` (fake Gmail with a 6,000 units/min/user quota, virtual clock). E2E = `tests/phase1-browser-e2e.js` (the real `index.html` + `app.js` in Chromium with Google and the worker mocked; old build run side by side).

## What changed

| File | Change |
|---|---|
| `gmail-sync.js` (**new**, 440 lines) | Gmail engine. Every unique message is fetched once. Records end in one of six states. Truthful summary. Full list in the Engine section below. |
| `app.js` | **`loadLoops` Gmail section** replaced by `engine.sync()`; downstream message shape unchanged. **`loadMail`** goes through the engine, so it shares its cache and retries. **`api()`** errors now carry `reason` + `retryAfterMs`. **`apiRetry`** (Calendar/Tasks/Drive) uses the same retry policy: 429/403-rate/5xx/network, exponential + jitter, `Retry-After`. **Sync recording:** `recordSyncPartial` vs `recordSyncSuccess` with per-record details. **Status:** `refreshAll` status line, drawer card and Sync Diagnostics show partial/failed + last full sync; the last full sync time is restored from the store after a reload. **Account race fixed:** the profile is resolved before sync state is written. **Throttle:** tab-focus refresh at most every 2 min, never during a sync. **Engine reset** on disconnect/sign-out. |
| `daylight-store.js` | New `recordSyncPartial()` (additive; keeps `lastSuccessAt`). `recordSyncSuccess` also stores `details` and clears `lastPartialAt`. **No schema change or migration.** |
| `index.html` | Loads `gmail-sync.js?v=1`; `daylight-store.js?v=4`, `app.js?v=102`. |
| `sw.js` | Shell includes `gmail-sync.js`; cache `daylight-v88`. |
| `tests/gmail-sync-sim.js`, `tests/phase1-browser-e2e.js`, `tests/live-gmail-sync-probe.js` (**new**) | Tests + reproducible live probe. |

**Engine (`gmail-sync.js`) in detail:**

- 4,800 units/min budget (80% of Google's limit) with a quota cool-down; at most 6 requests in flight.
- Jittered exponential backoff (0.5 → 16 s, 5 attempts, honours `Retry-After`) for 429, 403 `rateLimitExceeded`, 5xx and network errors. A 401 stops the sync immediately.
- All searches are listed first and IDs are de-duplicated before any message is fetched.
- `format=metadata` by default; `format=full` only for finance/travel/document matches. Bodies are capped at 30 per sync and 70% of the budget; queued bodies arrive over the next refreshes.
- An in-memory cache, with `history.list` applying label changes and deletions. A threads `historyId` check means sent threads are re-fetched only when they changed.
- Every record ends as fetched / cached / stale / failed / deferred / deleted, and the summary reflects that.

Not changed: OAuth scopes, worker, stored user data, classification logic, the message objects downstream code reads. Email content is still **not** stored at rest (the cache is in memory only).

## Test results (all re-run on the final code)

| Suite | Result |
|---|---|
| `tests/gmail-sync-sim.js` (new) | **67/67** |
| `tests/phase1-browser-e2e.js` (new; Phase 1 + baseline builds) | **19/19** |
| `oauth-scope-check` | pass |
| `ai-email-suite` | 33/33 |
| `phase13-data` | 26/26 |
| `phase14-travel-identity` | 22/22 |
| `phase11-e2e` (heuristic path) | 13/13, lifecycle OK |

### Simulation scenarios (`gmail-sync-sim-report.json`)

| # | Scenario | Old pipeline | New engine |
|---|---|---|---|
| S1 | Realistic refresh, 600-message mailbox, overlapping searches | 183 req, 68 quota 403s, 58 duplicate GETs, **33 records lost**, reported success | 123 req, 3,766 units, 0 403s, 0 duplicates, 0 lost. Warm +30 s: 25 req, no metadata re-fetch. Refresh 4: 346 units |
| S2 | 5,000-message mailbox | 31 lost | 0 lost, < 6,000 units |
| S3 | Quota 5,500/6,000 already used by another tab | 236 403s, **82 lost**, reported success | backs off through 23 403s, **0 lost**; next sync complete |
| S4 | 35% HTTP 429 for 20 s (`Retry-After: 2`) | 40 lost | 0 lost, complete |
| S5 | 25% 403 rateLimitExceeded | 33 lost | 0 lost, complete |
| S6/S7 | 20% 5xx / 15% network drops | 46 / 23 lost | 0 lost, complete (an incomplete sent-mail check would be reported as partial) |
| S8 | Expired token: refresh works / refresh fails | — | Transparent / stops after 2 requests, "Google sign-in expired", cursor not advanced |
| S9 | Inbox page 2 always 500; one message always 503 | — | Page-1 results kept; failed message listed; reported partial |
| S10 | 4 repeated refreshes | — | No duplicates in any pool; bodies converge; refresh 4 ≤ 10% of cold |
| S11 | New, read, archived and deleted mail; then expired cursor (404) | added mail only, max 20; read/archive/delete ignored | All four reflected via `history.list`; incremental fetches only mail entering the window. 404 → recovery, labels re-checked, complete |
| S12 | Refresh where every message GET fails | data lost | Previous copies kept as **stale** (0 lost), reported partial; next sync fully recovers |
| S13 | One sent thread gets a reply | 12 threads re-fetched | Only the changed thread re-fetched |
| U | Error classification + backoff | — | 429/403-rate/5xx/network retried; `insufficientPermissions`, `dailyLimitExceeded` and 401 not retried; delays 0.5 → 16 s cap; `Retry-After` honoured |

### Browser E2E: what the user actually sees (`phase1-browser-e2e-report.json`)

| Scenario | Old build: status line | Phase 1: status line |
|---|---|---|
| E1 healthy | "updated" **with 68 quota 403s behind it** (records silently dropped); manual refresh 5 s later: 97 of 101 calls rejected with quota errors | "Connected to Google · updated", 0 403s; manual refresh re-fetches no unchanged mail |
| E2 3 messages permanently failing | "Some connected data could not load · Service unavailable" | "**Partial sync** · Gmail partly synced · 3 failed; Mail: 3 of 10 inbox messages could not refresh · no full sync yet". Drawer: "Partial sync"; stored `lastPartialAt`, `records.failed = 3`, `lastSuccessAt` empty |
| E3 429 storm 6 s | "Some connected data could not load · Too many requests" (data lost) | "updated" after retries (all records present) |
| E4 30% network drops 6 s | "… Failed to fetch" (data lost) | "updated" after retries (all present) |
| E5 quota nearly used by another tab | "updated" (**240 rejected calls**, data lost) | "updated" after 62 s of quota-paced retries, all present |
| E8 full sync → failures → reload → recovery | — | After reload: "Partial sync · … 2 failed … · **last full sync 9:02 PM**" (from the store). After the failures clear and a manual refresh: "updated", partial flag cleared |
| E6 worker 401 | "Google sign-in expired · reconnect" | same (unchanged, correct) |
| E7 worker 502 | session cleared | **same: known Phase 4 issue, not changed here** |

## Requirement checklist

| Requirement | Status | Evidence |
|---|---|---|
| 1. Investigate the pipeline | Done | Plan, root causes R1–R10 |
| 2. Fix the ~9,600-unit refresh; dedupe; controlled concurrency; metadata unless justified | **PASS** | LIVE 4,066 / 706 / 1,846 units, 0 duplicates, peak 18 req/s |
| 3. Exponential backoff for quota and 429 | **PASS** | SIM S3–S5, E2E E3/E5, unit checks |
| 4. Never silently discard records; separate counts | **PASS** | `recordsLost == failed + deferred` in every fault scenario; stale copies kept (S12) |
| 5. No false success; accurate status + last successful sync | **PASS** | E2E E2, E8; store `lastPartialAt` vs `lastSuccessAt`; account race fixed |
| 6. Pagination/incremental: new, modified, deleted | **PASS (simulated)** | S9, S11; live history path not exercised (mailbox didn't change during the probe) |
| 7. Preserve functionality, data, scopes, security | **PASS** | No scope/worker/schema changes; all prior suites green; no page errors in E2E |

## Known limits and honest caveats

- **Cold start is slower:** 12.5 s live vs ~3 s before, because requests are now paced by quota instead of bursting. Warm refreshes take 2–3 s.
- **Full texts fill in over time:** a cold sync fetches 30 bodies, so on your mailbox 49 finance/travel/document mails are first classified from snippet + headers. The next two refreshes filled 11 and then 30 more. Until then, those mails may be classified slightly differently.
- **The cache lives in memory only.** After a page reload the first sync is cold again (~4,000 units). Keeping a cache in IndexedDB would make reloads cheap, but it would store email content at rest, so it needs your decision.
- **Rejected calls:** the budget counts every attempt that reaches Google, including ones Google rejects. Network failures are refunded. This is conservative, because Google doesn't document whether rejected calls cost quota.
- **Not changed in this phase (planned in later phases):**
  - The session is cleared on a worker 502 (Phase 4; E7 documents it).
  - Classification accuracy (Phase 2/3).
  - The Calendar syncToken path (Phase 6).
- **Not live-verified:** the integrated `app.js` build against real Google (not deployed, by request). The engine itself is the same code used live.

## What I need from you

1. Review the diff (`git diff` in your folder; new files are untracked).
2. If you want the real end-to-end check, approve a deploy. The verification is: one refresh shows ≤ ~4,100 Gmail units, 0 quota 403s, and an accurate status. Alternatively, approve a commit only.
3. Approve Phase 2.
