# Daylight Remediation — Phase 1 Plan: Gmail fetching reliability

Baseline: `tests/DAYLIGHT_FULL_AUDIT_REPORT.md` (3 Nov 2026). Live baseline per refresh: **184 Google requests, 177 in one second, ~9,600 Gmail quota units** (limit 6,000 units/min/user), 162 `messages.get` for 113 unique IDs (~49 duplicates), 3/6 thread fetches lost to 403 quota, status line still "updated".

## Root causes (from code)

| # | Cause | Where (baseline `app.js`) |
|---|---|---|
| R1 | Six list queries run in parallel, then each fetches its own IDs with `Promise.all`; overlapping results are fetched again before the `byId` dedupe | 921-975 |
| R2 | Every message fetched `format=full` (60 units) even though most consumers need headers/snippet only | 920 |
| R3 | No concurrency limit or quota budget → ~177 requests/second burst | 928, 952, 977 |
| R4 | `apiRetry` treats 403 `rateLimitExceeded`/`userRateLimitExceeded` as fatal; 3 attempts, ≤ 4 s backoff, ignores `Retry-After` | 896-909 |
| R5 | `meta(id).catch(()=>null)` and `listMeta` → `[]` drop failures silently | 928, 933, 972, 977 |
| R6 | `recordSyncSuccess('gmail')` always runs, overwriting the failure; `refreshAll` only sees rejected promises, and `loadLoops` never rejects | 1038-1043, 467-475 |
| R7 | `history.list` reads only `messageAdded`, one page, max 20; deleted and label changes are ignored; cursor cache never used | 941-964 |
| R8 | Nothing is cached between refreshes; `visibilitychange` triggers a full refresh every time the tab is focused | 485, 912 |
| R9 | `loadMail` fetches the same INBOX messages again in parallel with a different header subset | 414-419 |
| R10 | Sent-thread check re-downloads all 12 threads (40 units each) on every refresh | 976-977 |

## Design

**New module `gmail-sync.js`** (`window.DaylightGmailSync`, Node-testable, no DOM), one shared instance per page:

1. **Quota budget**: sliding 60-second ledger of units spent (costs from Google's table: list 5, get metadata 20, get full 60, threads.get 40, history 2, profile 1). Default ceiling 4,800 units/min (80% of 6,000, leaving room for other widgets). It waits for capacity when the wait is ≤ 20 s; otherwise the record is **deferred**, never dropped. After a quota error it enters a cool-down so later requests don't hammer.
2. **Request pool**: at most 6 Gmail requests in flight. Requests for the same message and format share one in-flight promise.
3. **Backoff**: retries 429; 403 with reason `rateLimitExceeded`/`userRateLimitExceeded` or a "quota exceeded … per minute" message; 500/502/503/504; network errors and timeouts (20 s abort). Exponential backoff with jitter (0.5 s → 16 s, 5 attempts) and honours `Retry-After`. A 401 is passed to the app's token refresh once, then the sync stops (no wasted calls). `dailyLimitExceeded`, insufficient permissions, 400 and 404 are not retried.
4. **Collect, dedupe, then fetch**: all list queries run first (paginated, IDs only). IDs are unioned, with a record of which queries returned each. Every unique ID is fetched **once**.
5. **Metadata first, body only when justified**:
   - IDs returned by the finance/travel/documents searches → `format=full` (bodies feed amounts, dates and attachments).
   - Inbox-only IDs → `format=metadata` (headers, labels, snippet).
   - An inbox message is upgraded to full only if it is not Promotions/Social/Forums and its subject/sender/snippet matches the money, travel or document patterns.
   - Full fetches are capped per sync (30, newest first; full bodies limited to 70% of the budget). Over the cap the message is still shown from metadata and marked `bodyDeferred`; the next sync upgrades it.
6. **Session cache**: messages are immutable apart from labels. Cached messages cost nothing on the next refresh. `history.list` (all pages; `messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved`) patches labels and removes deleted messages. A 404/expired cursor or history failure marks the cache stale, and those messages are re-checked. List queries stay authoritative for membership, so new and archived mail is always reflected. The cache is **in memory only**: no new email content is stored at rest.
7. **Sent threads**: `threads.list` (returns each thread's `historyId`) replaces `messages.list`. A thread is re-fetched only when its `historyId` changed.
8. **Per-record accounting**: every ID ends as `fetched` / `cached` / `stale` (refresh failed, previous copy kept) / `failed` / `deferred` / `deleted`. The report also has per-query errors, requests by kind, units, retries, duplicates avoided and duration. `partial = true` whenever anything failed or was deferred.
9. **Truthful status**:
   - Full success → `recordSyncSuccess`.
   - Partial → new `recordSyncPartial` (keeps `lastSuccessAt`; stores counts and reason).
   - The status line, drawer and Sync Diagnostics show "Partial sync — N failed, M waiting · last full sync HH:MM", or "Gmail sync failed · …", with the last successful time loaded from the store after a reload.
   - The history cursor only advances to the `historyId` read at the start of a sync, so nothing that changed during the sync is missed.
10. **Refresh throttle**: a tab-focus refresh is skipped if one ran less than 2 minutes ago (manual Refresh is unaffected).

**Not changed:** OAuth scopes, worker code, IndexedDB schema (no migration; `recordSyncPartial` writes into the existing `meta` row), stored user data, the downstream message shape (`payload.headers`, `labelIds`, `snippet`, `internalDate`, parts), classification logic (Phase 3), and the session-clearing-on-502 bug (Phase 4; documented by a test).

## Affected files

| File | Change |
|---|---|
| `gmail-sync.js` | **new**: engine (budget, pool, backoff, dedupe, history, threads, report) |
| `app.js` | `api()` adds `reason` + `retryAfterMs` to errors; `apiRetry` uses the shared backoff policy; `loadMail` goes through the engine (shared cache); `loadLoops` Gmail section replaced by `engine.sync()`; sync recording; `refreshAll` status; `renderDrawerSync`; Sync Diagnostics rows; `visibilitychange` throttle; last-success time restored from the store |
| `daylight-store.js` | add `recordSyncPartial()` (additive) |
| `index.html` | load `gmail-sync.js?v=1`; bump `app.js?v=102`, `daylight-store.js?v=4` |
| `sw.js` | add `gmail-sync.js` to the shell; cache `daylight-v88` |
| `tests/gmail-sync-sim.js` | **new**: fake Gmail with a virtual clock and quota enforcement; legacy vs new pipeline metrics; failure scenarios |
| `tests/phase1-browser-e2e.js` | **new**: Playwright run of the real app against a mocked Google + worker; checks the UI status text |
| `tests/live-gmail-sync-probe.js` | **new**: read-only snippet to measure the engine against a real mailbox in the browser |

## Tests and evidence

- **Simulation** (deterministic, virtual time): large inbox (5,000 messages) with overlapping queries; quota exhaustion; 429 / 403-rate / 5xx storms with `Retry-After`; network drops; expired token (401 → refresh → success, and 401 → refresh fails); partial list pages; duplicates over repeated refreshes; history add/delete/label changes and an expired cursor; recovery after a failed sync. Old and new pipeline measured on the same fake mailbox.
- **Browser E2E**: the real `index.html` and `app.js` with Google and the worker mocked; assert status-line and drawer text for healthy, partial and failed runs, and after reload.
- **Regression**: existing suites (`oauth-scope-check`, `ai-email-suite`, `phase11-e2e`, `phase13-data`, `phase14-travel-identity`).
- **Live, read-only**: run the engine in the browser pane against the real account (cold, then warm) and compare with the baseline of 184 requests / ~9,600 units.
