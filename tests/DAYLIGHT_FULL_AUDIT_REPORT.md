# Daylight — Functionality & Data-Fetching Audit

**Date:** 3 Nov 2026 · **Target:** https://kratveer.github.io/Deshboard/ (deployed build = local working copy; verified by SHA-256 of all 9 JS/HTML files after CRLF normalisation; `app.js?v=101`, SW `daylight-v87`) · **Worker:** `daylight-api.kratveer050.workers.dev`

**Scope of what was done:** a read-only audit. Nothing was committed, pushed or deployed, no worker settings were changed, no mail was sent, and Email Intelligence (Gemini) stayed **off**.

## How testing was done (evidence types)

| Label | Meaning |
|---|---|
| **LIVE** | Real Google account (kratveer050@gmail.com) through the deployed site in Claude's browser pane, after the owner signed in with "Stay signed in". Network timings, IndexedDB and localStorage were inspected, and direct read-only API probes were made with the same session token. |
| **DEMO** | Deployed site with `?demo=1` (built-in sample mail). |
| **CODE** | Static review of the exact deployed source (file:line). |
| **SYNTH** | Existing Node suites in `tests/`, re-run here. |

Not available: Microsoft 365 (no Entra app ID configured), Google Fit (no fitness grant), Gemini live path (consent off by request), offline/airplane-mode toggling (the browser pane can't throttle the network). These are marked **NOT TESTED**. The device link also dropped near the end, so one Health check stayed code-only.

---

## Executive summary

The plumbing mostly works: sign-in, session restore after reload, Calendar, Tasks, Drive, Contacts, email detail view, quick capture and markets. **The intelligence layer is not reliable on real mail**, and **one refresh exceeds Google's per-user Gmail quota**. The existing synthetic suites all pass (33/33, 26/26, 22/22, 13/13), but real-mailbox results are poor. Passing the synthetic tests says little about real usage.

Top problems, by impact:

1. **Gmail quota exhaustion on every refresh (Critical, LIVE).** One refresh sends **184 requests, 177 of them within one second**, costing about 9,600 Gmail quota units. Google's per-user limit is 6,000 units/min. I reproduced HTTP 403 *"Quota exceeded … Units per minute per user"*. The failed calls are **silently dropped** while the status line says "updated".
2. **The app invents payment tasks from receipts, refunds and promos (Critical, LIVE + DEMO).** On the real account it auto-created **13 "Pay …" tasks**, including "Pay Revolut · €100,000" (from a promotional mail), "Pay Indeed", "Pay Office, Department of Physics" and "Pay Anthropic" (a receipt). The due date it uses is the email's received date, so these show as **overdue**. In demo, a refund (money coming in) became "Pay PayPal €18.40", and an already-paid ČEZ invoice became a task.
3. **Wallet "tickets" are mostly wrong (High, LIVE).** 21 items were created; about 3 are real tickets. The rest are newsletters, promos, a GitHub issue, a job alert and a bank statement. 20 of 21 have no travel date, and the card shows the **date the item was added** (today) as if it were the trip date.
4. **Demo/preview mode writes into the real data stores (High, DEMO, reproduced).** `?demo=1` saved 5 fake "Pay" tasks, 3 wallet passes and 60 IndexedDB entities, labelled `mail:gmail:d9` etc., into the same keys real data uses.
5. **A temporary Google/server error permanently signs you out (High, CODE).** `serverToken()` treats a 502 `google_unavailable` as fatal and deletes the stay-signed-in session (`app.js:699`).
6. **Calendar incremental sync never engages (Medium, LIVE).** With `orderBy`/`timeMax` set, Google returns no `nextSyncToken` (verified). The syncToken code path is dead. If a token were ever stored, the restart path would also show empty upcoming events (CODE).
7. **Health shows sample numbers on Home for a real account without a label (Medium, LIVE).** Google Fit itself is blocked: Google stopped new Fit API sign-ups on 1 May 2024 and support ends at the end of 2026. Also, the worker never requests fitness scopes.

---

## Feature-by-feature results

### A. Authentication & session

| Feature | Result | Evidence | Expected vs actual | Files | Sev |
|---|---|---|---|---|---|
| Worker `/health`, auth enforcement | **PASS** | LIVE: `/health`→200; token/gemini/analyse without or with a fake Bearer → 401 `reauth` | As designed | `server/src/worker.js` | — |
| Stay-signed-in sign-in | **PASS (2nd attempt)** | LIVE: the first attempt left no session in storage (cause not captured). The second worked; granted scopes include `gmail.readonly` + `gmail.send` (+ legacy `gmail.metadata`, harmless: `format=full` returns 200) | — | `app.js:217-229`, worker `/auth/google/*` | Low |
| Stale session handling | **PASS** | LIVE: an expired stored session → worker 401 → app cleared it and showed "Google sign-in expired · reconnect" | Correct | `app.js:687-704` | — |
| Session restore after reload | **PASS** | LIVE: reload → 1 token call → full data reload, account `acct:google:…` active | Correct | `app.js:739` | — |
| Transient error handling | **FAIL** | CODE: a 502/`google_unavailable` (the worker's response for any non-`invalid_grant` refresh error, i.e. a Google hiccup) → `clearServerSession()` | Should keep the session and retry with backoff; actually deletes it, forcing a re-login | `app.js:699-703`; `worker.js:193` | **High** |
| Browser-only (GIS) token expiry | **PARTIAL** | CODE: a `setTimeout` nulls the token after about 59 min, with no silent re-request | Expected: silent renew or a clear prompt | `app.js:318` | Low |
| Token renewal (server) | **PASS** | CODE: renews `expires_in−180 s`, retries after 2 min on network failure, retries a 401 once | — | `app.js:731-733, 382` | — |
| Gemini rate limit | **PARTIAL** | CODE: per-session (not per-user) and not atomic across concurrent KV writes | Can be exceeded with several sessions or parallel calls | `worker.js:214-219` | Low |
| Microsoft 365 | **NOT TESTED** | No client ID configured | — | `app.js:356-373` | — |

### B. Data fetching per service

| Service | Result | LIVE evidence | Problems found | Files | Sev |
|---|---|---|---|---|---|
| **Gmail (loops/inbox pipeline)** | **FAIL** | One refresh: 8 list + **162 `messages.get` (152 `format=full`)** + 6 `threads.get` + profile. Only **113 unique** messages, so about **49 duplicate fetches** across overlapping queries. 3 of 6 thread fetches **403 quota**; the same 6 fetched one at a time later all returned 200 | (1) ~9.6k units/refresh against a 6k/min per-user limit, all fired at once (`Promise.all`). (2) `apiRetry` doesn't retry 403 `rateLimitExceeded`/`userRateLimitExceeded`. (3) `meta(id).catch(()=>null)` drops failed messages silently. (4) `listMeta` returns `[]` on error, then `recordSyncSuccess('gmail')` overwrites the failure, so a failed sync is recorded as a success | `app.js:896-909, 920-933, 965-977, 1040` | **Critical** |
| Gmail pagination / coverage | **PARTIAL** | INBOX has 72,664 messages (62,227 unread); the app reads the newest 50 + targeted searches | Fine for a dashboard, but there is no missing-record detection and no indication of how much was scanned | `app.js:966` | Low |
| Gmail incremental (history) | **PARTIAL** | LIVE: cursor stored; mode stays `full` | `history.list` only adds up to 20 `messagesAdded`; deletions and label changes (read/archived) are ignored. Every run is effectively a full re-fetch, so "incremental" brings no quota benefit | `app.js:941-964` | Medium |
| Gmail widget (headers) | **PASS** | 10 metadata gets, rendered | Separate fetch duplicating the loops pipeline | `app.js:414-419` | Low |
| Email detail / body | **PASS** | LIVE: opening a receipt fetched one message; body, amount and "paid" status shown correctly | The list view labelled the same mail "Pending", so list and detail disagree | `app.js:2499`, `5057` | Medium |
| **Calendar (today)** | **PASS** | API: 0 events today; UI: "Nothing on the calendar today" | — | `app.js:409-413` | — |
| Calendar (14-day / week view) | **PARTIAL** | API 14-day: 1 event; matches the full path | `calendarList` → **403 insufficient scope** (`calendar.events.readonly` can't list calendars), so only `primary` is ever shown; shared/subscribed calendars are invisible. Per-calendar errors are swallowed (`console.warn`) and show as "no events" | `app.js:2205-2240` | Medium |
| Calendar incremental (syncToken) | **FAIL** | LIVE probe: with `timeMin+timeMax+orderBy` → **no `nextSyncToken`**; with `timeMin` only → token present. IndexedDB shows `calendar.cursor=false` after several syncs | Dead path. Latent bug: if a cursor were stored, after an app restart `loopsData` is null, so the "incremental" result contains only changed events and the full fetch is skipped (`calMode==='incremental'`), leaving upcoming events empty | `app.js:979-1020` | Medium |
| **Google Tasks** | **PASS (small sample)** | API: 1 list, 1 open task; UI matches | Only the first 3 lists × 20 tasks × 8 shown are read, with no pagination | `app.js:420-439` | Low |
| **Drive** | **PASS** | 1 call, 200, rendered | — | `app.js:577-583` | — |
| **Contacts / birthdays** | **PASS** | 124 contacts, 0 with birthdays → "No birthdays" | 29 Feb rolls over to 1 Mar | `app.js:592-604` | Low |
| Markets (Frankfurter, CoinGecko) | **PASS** | LIVE: all 200, rendered | — | `app.js:617-644` | — |
| Weather (Open-Meteo) | **NOT TESTED** | Needs a geolocation prompt | Code path looks correct | `app.js:481-484` | — |
| **Health (Google Fit)** | **FAIL / blocked** | Health tab shows "Sample data is shown until you connect"; **Home shows "94/100, 8,862 steps" with no sample label** (LIVE) | The Fit API is closed to new sign-ups (since 1 May 2024) and supported only until the end of 2026. Fitness scopes are missing from the worker's `GOOGLE_SCOPES`. `requestFitnessAccess` needs `daylight-client-id`, which the server flow never sets, and the server's 50-min renew overwrites the stored scopes, dropping any fitness grant | `health-data.js`, `app.js:335-354, 4663`, `worker.js:14-22` | **High** (misleading) |
| Microsoft Calendar/Mail/To Do | **NOT TESTED** | — | CODE: `renderCalendar` parses Graph `dateTime` (UTC, no `Z`) as local time, so it is wrong by the UTC offset (only `todayEvents` corrects for it). To Do `dueDateTime` has the same issue. No `Prefer: outlook.timezone` header | `app.js:393, 449-459` | Medium |

### C. Data integrity & persistence

| Check | Result | Evidence | Sev |
|---|---|---|---|
| Duplicates on repeated refresh | **PASS** | LIVE: forced refresh → tasks 13→13, wallet 21→21 | — |
| Persistence after reload | **PASS** | LIVE: session, wallet and tasks survive; IndexedDB has 211 entities under the Google account | — |
| Account association | **PARTIAL** | LIVE: after the first sign-in, sync state was written under **both** `acct:local:device` and the Google account, because `loadLoops` starts before `loadProfile()` sets the active account (race) | Medium |
| Demo isolation | **FAIL** | DEMO: wrote `daylight-personal-tasks` (5 fake "Pay"), `daylight-wallet` (3), `daylight-orders` and 60 IndexedDB entities `mail:gmail:d*` into real stores. `daylight-demo=1` in localStorage also persists demo mode | **High** |
| Duplicate bill records | **FAIL** | DEMO: ČEZ invoice (Oct) + payment confirmation produced **two bill entities** (`bill:cez:2026-10`, `bill:cez:2026-11`) instead of marking the October bill paid | Medium |
| Date rollover | **FAIL** | CODE: `date/localMidnight/tomorrow` are computed once at load (`app.js:82-84`). Left open past midnight, "today" stays on the old day | Medium |
| HTML entities | **FAIL** | LIVE: snippets show `You&#39;re in`, `&amp;` (Gmail snippet is pre-escaped, then escaped again) | Low |
| Sender/initials parsing | **FAIL** | LIVE: a card shows sender "ment of tuition fees 1/3"; emoji senders render initials as `�Y` (surrogate split) | Low |
| Wallet date label | **FAIL** | When the travel date is unknown, `walletPassHTML` shows `item.at` (insertion time) as the date | `app.js:5223` · Medium |

### D. Classification / AI / automation (real mailbox, rules engine; Gemini off)

Method: a spot check of the first cards in each Inbox chip on the real account, judged by subject/snippet. These are my judgements on a sample, not a labelled dataset.

| Category | Cards | Spot-check precision | Notes |
|---|---|---|---|
| Tickets / Wallet | 17 inbox / 21 wallet | ~2 of 8 / ~3 of 21 | Pharmacy promos, food-delivery promos, a trading statement and an airline marketing mail are classed as tickets |
| Bills | 16 | ~0–1 of 8 | A conference ad, a Google security alert ("You allowed Claude for Gmail access…"), a train-ticket cancellation and promos |
| Subscriptions | 9 | ~2 of 8 | GitHub Actions comments, Google OAuth alerts, a bank newsletter |
| Receipts | 14 | ~3 of 8 | A personal email thread counted as receipts |
| Payments (pending) | 2 | 0 of 2 confirmed | A Revolut referral promo ("earn CZK 1,250") |
| Promotions | **0** | — | The chip exists, but the classifier has no promotion category (`CATEGORIES` in `email-classify.js:7`) and ignores Gmail's `CATEGORY_PROMOTIONS` label |
| Home brief | — | — | "32 need attention · 16 payments and 16 tasks overdue": almost all generated by the items above. "4 gifts with your purchase" and a job-alert mail are shown as **Reply** |

Root causes (CODE):

- `email-classify.js:342-349`: `uncertain-keep-top` keeps a weak top category (score ≥ 1.6) instead of `other`.
- `RX.ticket` matches `flight|rail|check-in|itinerary` anywhere in the subject, snippet and body, including marketing footers.
- `moneyKind` maps "payment successful / charged / payment received" to **`pending`** (`app.js:855`).
- `syncPaymentTaskSuggestions` turns every `bill`/`pending` item with an amount into a persisted task, using the received date as the due date (`app.js:3377-3391`).
- The Reply loop counts any unread mail from a non-noreply sender (`app.js:1414`). With 62k unread, that is mostly noise.

**AI module:** the status shows "Skipped AI (rules sufficient)". All real results above come from rules. Gemini was **NOT TESTED** live; the previous report's 13/13 used synthetic fixtures. The command-bar "Summarise project activity" is a placeholder ("A written AI summary … comes with the AI step"): **PARTIAL**.

### E. UI / navigation (DEMO unless noted)

| Feature | Result | Notes |
|---|---|---|
| Mobile tabs Home/Inbox/Wallet/Timeline/Health | **PASS** | All render, no JS errors (window error + unhandled-rejection hooks stayed empty) |
| Desktop drawer → Inbox / Calendar / Wallet | **FAIL** | Default preset has only `summary`+`loops` (`app.js:2006`). `goWidget()` finds the hidden card in the off-screen store and `scrollIntoView` does nothing, so the click has **no visible effect and no message** (`app.js:1805-1809`). The README describes a different default layout |
| Drawer "Inbox 0" badge (demo) | **FAIL** | Shows 0 while the demo inbox has 20+ items |
| Priority Actions dedupe | **FAIL** | The same Stripe mail appears 3× (Due / Reply / "Stripe failed") and Ana's mail 2× |
| Demo Timeline | **FAIL** | Demo calendar events (`upcoming`) never appear in Timeline/Today (those read `providerData`/live API only) |
| Command bar: ask | **PASS** | Tomorrow, bills, waiting-for-reply, last-week tasks and keyword search all return results from loaded data |
| Command bar: capture | **PASS** | "Remind me to call the dentist Friday 15:00" → Fri 6 Nov 15:00 local (14:00Z): correct timezone |
| Premium / plan | **PARTIAL** | 4 "Coming soon" buttons; honest dialog ("Checkout and prices are not available yet") |
| Email reply (gmail.send) | **NOT TESTED** | Deliberately not sent |
| Offline / service worker | **NOT TESTED** (live) | CODE: network-first app shell, API data not cached. Offline shows "Some connected data could not load" |

### F. Privacy and documentation accuracy

| Claim | Result | Evidence |
|---|---|---|
| README/Privacy: "mail headers… message text when you open a thread", "not sent to anyone else" | **FAIL** | The app downloads **full bodies of about 150 messages per refresh** (`format=full` with `body/data`), stores derived facts in IndexedDB, and sends every **sender domain to Google's favicon service and Clearbit** (`app.js:796-801`; observed `s2/favicons?domain=…` requests) |
| README "Gmail: up to six inbox message headers; no send" | **FAIL** | Out of date: the app requests `gmail.readonly` + `gmail.send` |
| Fitness scopes | **FAIL** | Requested by the client but not by the worker; the Fit API is closed to new projects |

### G. Existing test suites (SYNTH, re-run)

`oauth-scope-check` all pass · `ai-email-suite` 33/33 · `phase13-data` 26/26 · `phase14-travel-identity` 22/22 · `phase11-e2e` heuristics 13/13. **These pass, yet the real-mailbox precision above is low.** The fixtures are clean, single-purpose emails, with no promos, newsletters, receipts that resemble bills, or multilingual marketing. They need real-world negative fixtures.

---

## Prioritised fix plan (small, testable phases; awaiting approval)

| Phase | Fix | Files | Regression test |
|---|---|---|---|
| **1 · Quota & silent loss** | Use `format=metadata` for list pipelines (full body only on open or for the top-N candidates). Dedupe IDs across queries **before** fetching. Use a concurrency pool (≈8 parallel). Retry 403 `rateLimitExceeded/userRateLimitExceeded` + 429 with backoff. Count failed IDs and don't record `recordSyncSuccess` when lists failed; show "partial sync". Throttle `visibilitychange` refreshes | `app.js` 896-977, 485 | LIVE: one refresh < 3,000 units, 0×403, status reports partial if any fail |
| **2 · Stop fabricated money tasks** | `payment successful/charged/receipt/refund` → `paid`/`refund`, never `pending`. Auto-create "Pay" tasks only with an explicit due date and an unpaid signal, as *suggestions* the user accepts. Never use the received date as the due date. Add a one-time cleanup of `suggested:true` tasks (with user confirmation) | `app.js` 846-859, 3357-3405 | Fixtures: refund, receipt, promo with an amount, paid invoice → 0 tasks |
| **3 · Classifier precision** | Respect `CATEGORY_PROMOTIONS/SOCIAL/FORUMS`. Add a `promotion` category. Drop `uncertain-keep-top` (→ `other` + review). Restrict ticket regex to subject + sender brands + attachment, not footers. Wallet only for ticket + confidence ≥ threshold. Hide the date when unknown | `email-classify.js`, `app.js` 1319-1342, 5223 | Add ~30 real-world negative fixtures (anonymised) to `ai-email-suite` |
| **4 · Session resilience** | On 502/network errors keep the session and back off; clear only on 401 | `app.js` 699-703 | Mock worker 502 → session retained |
| **5 · Demo isolation** | Namespace all storage keys (`daylight-demo:*`) and use a separate IndexedDB name in demo; never persist `daylight-demo` | `app.js` 751, store open | DEMO then real: real stores untouched |
| **6 · Calendar** | Drop `orderBy/timeMax` for the syncToken bootstrap (or drop the dead path). Fix the restart merge. Add `calendar.readonly` *or* label as primary-only. Surface per-calendar errors | `app.js` 979-1020, 2205-2240 | LIVE: cursor stored; restart keeps events |
| **7 · Correctness polish** | Midnight rollover (recompute dates on visibility / timer). Graph UTC parsing. Decode snippet entities. Account-race fix (await profile before loops). Priority-action dedupe by `mailId`. Desktop nav: add the widget or toast. Health: label sample data on Home and hide Fit until a supported path exists (Health Connect) | various | Targeted unit + DEMO checks |
| **8 · Docs** | Update README/privacy to match reality (full-body reads, favicon/Clearbit domain lookups, scopes) | README.md, privacy.html | — |

## Side effects of this audit (for transparency)

- In **Claude's browser pane profile only** (not your Chrome), I cleared the sample-mode data my demo test created, with your approval. The pane now holds your new Daylight session plus the data Daylight itself generated on sign-in: **13 auto "Pay …" tasks and 21 wallet items**, i.e. finding #2/#3. I left them in place as evidence.
- An expired session ID in that profile was cleared by the app itself on page load (the worker had already rejected it).
- Sign-in, one forced refresh, one reload and my probes temporarily hit the Gmail per-minute quota; it recovered within about a minute.
- Running `tests/*.js` here rewrote the report JSONs **in the cloud copy only**; your local `tests/` files are unchanged.

## Sources

- Gmail API quota (per-user 6,000 units/min; `messages.get` full = 60 units): https://developers.google.com/gmail/api/reference/quota
- Google Fit migration FAQ (no sign-ups since 1 May 2024; supported until end of 2026): https://developer.android.com/health-and-fitness/guides/health-connect/migrate/migration-faq
