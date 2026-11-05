# Daylight — Repository Audit (V2 baseline)

Date: 2026-11-05 · Scope: the Deshboard repository as it exists locally (C:\Users\kratv\Projects\Daylight), the live site https://kratveer.github.io/Deshboard/ and the Cloudflare Worker in `server/`.

## 1. Stack and deployment

| Aspect | Finding |
|---|---|
| Framework | None. Vanilla JavaScript, one large IIFE (`app.js`, ~6,900 lines) plus ~20 single-purpose modules loaded with `<script defer>` from `index.html`. No bundler, no npm dependencies in the web app. |
| Hosting | GitHub Pages (static). The user deploys with `git push`. `sw.js` caches the app shell (`daylight-v94`). |
| Backend | One Cloudflare Worker (`server/src/worker.js`, ~300 lines) with a KV namespace `SESSIONS`. Endpoints: `/auth/google/start`, `/auth/google/callback`, `/api/google/token`, `/auth/logout`, `/api/gemini/analyse`, `/api/gemini/status`, `/health`. No D1, no Queues. |
| Local storage | IndexedDB `daylight-db` (DaylightStore: accounts, entities, relationships, facts, actions, reminders, meta), IndexedDB `daylight-mail` (Gmail cache: mailIndex, mailFacts, domainCategory, aiQueue, attachmentMeta, threads, syncMetrics, checkpoint), ~40 localStorage keys (Wallet, finance ledger, AI extractions, settings). |
| Tests | 30+ Node / Playwright scripts in `tests/` with a mock Gmail (`tests/mock-gmail.js`), synthetic fixtures (`tests/fixtures/mail-200.js`, `mail-holdout.js`), regression suites for Phase 1/2/11/13/14, Gmail v2 unit + E2E, cost benchmark, responsive and home audits. No test runner; each file is run with `node`. |

## 2. Module inventory

| Module | Responsibility | V2 verdict |
|---|---|---|
| `app.js` | UI for every screen, Google/Microsoft sign-in, loaders (`loadCalendar`, `loadMail`, `loadTasks`, `loadDrive`, `loadBirthdays`, `loadLoops`), loop/priority computation, Wallet, Money, Timeline, Health, sheets, gestures | **Modify heavily.** Keep the screen code and gestures; route data through the graph; split new features into modules instead of growing it further. |
| `gmail-sync.js` | Phase 1 engine: quota budget (units/min), concurrency, retry/backoff, request accounting | **Reuse** as the transport for every Gmail call. |
| `gmail-pipeline.js` | v2 orchestration: discover (profile + history / backfill list) → metadata → rules → selective bodies → pools | **Modify**: replace "metadata for every new message" with candidate triage (see quota section). |
| `gmail-cache.js` | IndexedDB cache keyed `[accountId, messageId]`; no bodies stored | **Reuse.** |
| `gmail-rules.js` | Stage B metadata rules, Stage C body extraction (JSON-LD, regex) | **Reuse**, extend with V2 types. |
| `gmail-batch.js` | HTTP batch transport | **Reuse** for latency only. Google charges each batched call at its own unit cost, so batching saves round trips, not quota. |
| `gmail-config.js` | All tunables (slots, window, quota, searches, AI) | **Modify** (category coverage, candidate queries, recovery). |
| `ai-budget.js`, `sync-metrics.js`, `sync-scheduler.js` | AI credit bucket, metrics, slot scheduler with cross-tab lock | **Reuse.** |
| `email-classify.js` | Legacy 6-category classifier used by Inbox/Money | **Keep** for compatibility; superseded by the V2 classifier. |
| `finance-intel.js` | Bill/receipt ledger, due dates, obligations, duplicates | **Reuse** as the Money engine; output goes to graph Items. |
| `mail-dates.js` | Conservative key-date extraction (deadlines, reminders, travel) | **Reuse.** |
| `daylight-ai.js` | Gemini client through the Worker; prompt builder; consent gates | **Reuse** behind a provider-independent intelligence service. |
| `daylight-store.js` | Multi-account IndexedDB foundation with privacy classes | **Reuse** for accounts and sync state. The Item Graph gets its own database (see architecture). |
| `daylight-data.js` | Read adapter joining store + localStorage sidecars (Wallet identity) | **Reuse** during migration. |
| `scan-pipeline.js` | Camera/OCR document scan into Wallet | **Keep.** |
| `health-data.js` | Google Fit / Health Connect adapters | **Remove from navigation** (decision 2026-11-05). File kept but not loaded. |
| `dev-sample.js`, `tools/` | Local sample mode (127.0.0.1 only) | **Keep**, never deployed; becomes the explicit "demo mode". |

## 3. Working features to preserve

- Gmail v2 pipeline: history-based incremental sync, cache, rules, AI budget, metrics, cross-tab lock, slot scheduler.
- Finance intelligence: ledger, due dates, overdue detection, review queue, corrections.
- Key-date extraction feeding Priority Actions and the Daily brief.
- Wallet with travel identity (one pass per booking, cancellation handling) and the Apple-style card stack.
- Mobile app shell: tab slide transitions, edge-swipe back, pull-to-refresh, inbox swipe actions, sheets, laptop sidebar, dark mode.
- Local personal tasks and capture.
- Worker: encrypted refresh tokens (AES-GCM), state-validated OAuth callback, logout with Google revoke, Gemini proxy with per-session rate limit.

## 4. Gmail API usage today (redundant requests)

Unit costs (Google, Nov 2026): `messages.list` 5 · `messages.get` 20 (metadata) / 60 (full) · `history.list` 2 · `threads.get` 40 · `getProfile` 1. Batching does not change units.

| # | Where | What it costs | Problem |
|---|---|---|---|
| R1 | Pipeline backfill (`newer_than:30d`) | 5/page to list, then **20 per new message** | Every message in the window is metadata-fetched, whether or not it could matter. This is the dominant cost. |
| R2 | Incremental history | 2/page, then **20 per added message** | Same: every new message gets a metadata call. |
| R3 | Category exclusion (Promotions/Social/Forums) | 0 | Saves quota but creates a permanent blind spot. Receipts and bookings filed in Promotions are never seen. **Violates V2.** |
| R4 | Recovery reconcile | 3 full window lists | Acceptable (IDs only, 5/page), but runs on every recovery. |
| R5 | Sent threads (`threads.get` ×12) | 480 units per sync | Re-fetches unchanged threads. It should fetch only threads whose `historyId` moved. |
| R6 | `loadMail()` widget | 0 in v2 (reads pipeline pools); legacy path still present | Legacy query list in `loadLoops` (6 searches + bodies) is dead weight when v2 is on. |
| R7 | Body escalation | 60 per body | Correctly selective (capped at 40 per sync). Keep. |

## 5. Security and privacy findings

| # | Finding | Severity |
|---|---|---|
| S1 | OAuth asks for `gmail.send`, Drive metadata, Contacts, Calendar, Tasks (and optionally Fit) up front. The brief requires Gmail read-only only at onboarding. | High (scope minimisation) |
| S2 | `gmail.send` lets the app send mail as the user. Reply sends directly. | High |
| S3 | The browser receives short-lived **access** tokens (by design: local-first fetching). Refresh tokens never reach the browser in server mode. A legacy direct GIS mode also exists, which issues browser-only access tokens with no refresh. | Medium. Documented, acceptable. |
| S4 | Disconnect does not delete local Gmail data (IndexedDB caches, ledger, Wallet items derived from Gmail). | High (V2 requirement) |
| S5 | `ALLOWED_EMAILS` allowlist on the Worker. Correct for a private beta; blocks friends unless edited. | Info |
| S6 | Wallet, ledger and AI extractions live in localStorage (not account-scoped, readable by any script on the origin). | Medium |
| S7 | Email text sent to Gemini is wrapped in a prompt but not explicitly fenced as untrusted data. | Medium (prompt injection) |
| S8 | No processing log of what left the device. | Medium (V2 Privacy Centre) |
| S9 | `index.html` includes the 127.0.0.1-only sample loader. It is inert in production but should stay guarded. | Low |

## 6. Architectural limitations

1. **No shared Item model.** Screens rebuild their own lists from `loopsData`, the ledger, Wallet and calendar arrays, so one email can appear as separate, unlinked objects in Inbox, Money and Wallet.
2. **app.js monolith.** Rendering, data loading and business rules are interleaved, which makes changes risky.
3. **Provider code is hard-wired** (`token`, `microsoftAccount` globals; `providerData.google/microsoft`). There is no connector contract.
4. **Classification has two taxonomies** (`email-classify` 6 categories, `gmail-rules` 13) and neither matches the V2 17 types. There is no importance score beyond heuristics.
5. **Corrections** exist only for finance. There are no general sender/content rules the user can see and edit.
6. **No action dispatcher.** Done/snooze/complete are scattered handlers with no history or undo.
7. **Navigation** is Home · Inbox · Wallet · Timeline · Health. V2 wants Today · Inbox · Plan · Money · Wallet.

## 7. Live site vs source

The live site serves an older build (the last deploy the user pushed). The local repository is ahead: Home v3, responsive layout, Wallet stack and polish fixes are not yet pushed. V2 work continues on the local copy. Nothing is committed or deployed without approval.
