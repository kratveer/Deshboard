# Daylight — Gmail cost & resource optimisation (v2): implementation + benchmark report

Date: 4 Nov 2026 · **Synthetic / mocked Gmail only — your real account was not used.** Nothing committed, pushed or deployed.

## 1. Verdict

* **Steady-state Gmail cost drops by about 99 % or more.**
  * Opening or refreshing with no new mail now costs **1 quota unit**: one `getProfile`, no other calls. Today it costs 2,125–3,541 units per refresh.
  * Five slot syncs with 8 new emails each cost **2,860 units** in total, against 16,695 today when the app is reopened.
  * Label changes and deletions cost **13 units**, against about 3,560 today.
* **Recall for bills, travel, payments and refunds did not drop.** It rose in every test set, so no threshold change was needed.
  * On the 60-email hold-out (blind first run), accuracy went from 0.42 to **0.90**.
  * Today's engine only sees ~85 of 200 emails, and ~10 % at 1,000 emails, because of fixed search caps.
* **AI use falls to ≤ 5 % of new mail.** It is capped by a credit bucket, a daily cap and a `bodyHash` guard. The prompt-cache bug is fixed.
  * Five syncs a day now make **2 AI calls instead of 60**. Today the same unchanged emails are re-sent every 6 h, and the cache never hits.
* **The one-time cost is higher.** The first 30-day backfill reads every email in the window instead of ~100. For 1,000 emails that is ~59 k units, against 3.6 k today.
  * The backfill is spread over several syncs and never exceeds the per-minute quota (6,000 units/min/user).
  * This is the price of not missing ~90 % of the mail. You can lower it with `window.backfillDays` / `backfillMax` in `gmail-config.js`.
* **Not verified live:** whether the Gmail **batch endpoint accepts browser CORS requests**. If it does not, the automatic fallback to single GETs is tested and works; batching then just loses its latency benefit. Quota units are the same either way.

## 2. What was built

| File | Status | Purpose |
|---|---|---|
| `gmail-config.js` | new | Every number used by v2, with per-account overrides from `localStorage` (slots, window, thresholds, batch size, quota ceiling, AI caps, price table, attachment limits, engine switch `legacy`/`optimised`). |
| `sync-scheduler.js` | new | Slot logic in local time (DST-safe), "catch-up on open = one sync", 15-minute skip, cross-tab lock (Web Locks, falling back to a localStorage lease plus BroadcastChannel). The pure functions are ready for a Workers cron. |
| `gmail-cache.js` | new | Separate IndexedDB DB `daylight-mail` v1, account-scoped (schema below). There is also a memory backend for tests and Workers. |
| `gmail-rules.js` | new | Stage B rules in order: Gmail category → List-Unsubscribe → sender domain → keywords/regex. Each returns `{category, confidence, reason}`; unfamiliar senders are escalated. Stage C: JSON-LD + microdata parsing, then regex extraction (amount, currency, due date, merchant, reference). EN/CS/DE/HI. |
| `gmail-batch.js` | new | Gmail HTTP batch, at most 50 requests per batch, and kept within 25 % of the per-minute quota. Per-part parsing, per-part retry through the Phase 1 backoff path. |
| `ai-budget.js` | new | Text cleaning (HTML, quoted replies, signatures, footers, tracking links), 2,000-character limit, strict JSON with per-field confidence, daily cap (requests + USD), money ledger, domain learning (N = 3) behind `getDomainCategory` / `recordDomainCategory`. Gemini batch is behind an interface and **disabled** (as you chose). |
| `sync-metrics.js` | new | Builds the Sync Efficiency panel from per-day counters. |
| `gmail-pipeline.js` | new | Stage A (history.list from a checkpoint; on 404 or overflow, `newer_than:30d` list + reconcile, never a full scan), Stage B, Stage C, persistent body/AI queues, sent threads (only re-read when the mailbox changed), pools for the app, `runAi`, `resolveReview`, `fromCache`. |
| `gmail-sync.js` | small change | **Not rewritten.** It now exposes `call`/`newCtx` so v2 reuses the same budget, pool, backoff and accounting, plus a `maxAttempts` / `refundOnFailure` option. The Phase 1 sim still passes 69/69. |
| `app.js` | integration | Engine switch with automatic fallback to Phase 1. Every refresh goes through `v2GmailSync`: decide → lock → run or read the cache. The Mail widget reuses the same pass (0 extra calls). Also: slot timers while open, a BroadcastChannel so other tabs re-render from the cache, the AI path through the credit bucket, the **Quick check** review sheet (drawer), Sync Efficiency + "Scan older bills (180 days)" + "Clear mail cache" in Sync Diagnostics, and the finance flag "Email deleted in Gmail · record kept". |
| `daylight-ai.js` | small change | The cache key no longer includes `current_datetime`, so an unchanged email is never re-sent. Configurable truncation. Invalid JSON is retried **once**. `field_confidence` was added to the one schema. The system prompt is unchanged and identical on every call. |
| `email-classify.js`, `finance-intel.js` | 2–4 lines each | When a cached message's body was processed earlier, the stored result (same classifier version) stands in for the body, so bodies never need to be kept. |
| `index.html`, `sw.js` | — | Script tags, cache `daylight-v90`, **Quick check** drawer item. |
| `privacy.html` | 1 line | Describes the local 30-day mail index (sender, subject, preview, labels and conclusions; no full text) and how to clear it. Approved by you; it ships with the deploy. |

## 3. Storage — separate database, no migration of existing data

* A new IndexedDB `daylight-mail` v1 holds the stores `mailIndex`, `mailFacts`, `domainCategory`, `aiQueue`, `attachmentMeta`, `threads`, `syncMetrics` and `checkpoint`. Every key starts with `accountId`.
* **`daylight-db` (entities, facts, accounts) is untouched**; no version bump. The Phase 2 finance ledger, tasks and wallet are untouched.
* **Raw bodies are never stored**, only `bodyHash` plus extracted facts. The browser E2E (V11) checks that no base64 body or payload parts are in IndexedDB.
* A deleted Gmail message becomes a tombstone (`status: deleted`). Its facts are kept, and any finance record that came from it is **flagged, not removed** (E2E V6).
* The plan said the Phase 1 `historyId` would be read once to seed the checkpoint. In practice the new cache starts empty, so the first v2 run does a 30-day backfill anyway; nothing is read from or written to the old meta store.

## 4. Benchmark method

* `tests/gmail-cost-bench.js` compares **CURRENT** (the Phase 1 engine with the exact six-search plan and `wantsBody` regexes taken from `app.js`) against **OPTIMISED** (v2).
* It uses an in-process mock Gmail (`tests/mock-gmail.js`) with Google's 2026 unit table: get metadata 20, get full 60, list 5, history 2, threads.list 10, threads.get 40, profile 1. **Quota units are what the mock charged**, independent of the client's own accounting.
* The mock clock advances when the client waits for quota, so per-minute limits are respected.
* **CURRENT** treats each sync as a page load unless the row says "same tab", because the Phase 1 cache lives only in memory.
* **OPTIMISED** is measured after its one-time backlog is drained; the backfill cost is shown separately. In "3 accounts × 2 syncs", the backfill drain is shown separately (an extra 24,360 units, one-time).
* **AI assumptions:** Email Intelligence is ON with the financial opt-in OFF (the default). CURRENT replays `enrichWithDaylightAI` and `shouldCallGemini` with the real prompt builder. Token counts use 4 characters per token. Output is assumed to be 350 tokens (current) and 250 tokens (new). The price table is `gemini-3.5-flash-lite` at $0.10 / $0.40 per 1 M tokens. On your free tier the actual money cost is $0.
* **The AI stub never changes a category**, so the classification numbers below are **rules-only on both sides**.
* Network time is **modelled**: 90 ms per HTTP request, 6 in parallel.

## 5. Cost results

| Scenario | Quota units (cur → opt) | HTTP requests | Body downloads | AI calls | AI tokens in+out | AI est. USD | Modelled network time |
|---|---|---|---|---|---|---|---|
| 100 new emails — first sync | 2,881 → **4,711** | 81 → 11 | 30 → 40 | 12 → 5 | 21,819 → 5,677 | $0.0034 → $0.0009 | 1.3 s → 0.2 s |
| 100 new — backfill to steady state | 2,881 → **8,683** | 81 → 18 | 30 → 100 | 12 → 5 | 21,819 → 5,677 | $0.0034 → $0.0009 | 1.3 s → 0.4 s |
| 500 new — first sync | 3,461 → **4,676** | 110 → 13 | 30 → 0 | 12 → 0 | 21,756 → 0 | $0.0034 → $0.0000 | 1.7 s → 0.3 s |
| 500 new — backfill total | 3,461 → **32,797** | 110 → 55 | 30 → 368 | 12 → 25 | 21,756 → 28,384 | $0.0034 → $0.0047 | 1.7 s → 1.4 s |
| 1,000 new — first sync | 3,581 → **4,396** | 116 → 12 | 30 → 0 | 12 → 0 | 21,766 → 0 | $0.0034 → $0.0000 | 1.8 s → 0.2 s |
| 1,000 new — backfill total | 3,581 → **58,876** | 116 → 92 | 30 → 640 | 12 → 25 | 21,766 → 28,393 | $0.0034 → $0.0047 | 1.8 s → 2.3 s |
| 5,000 historical + 100 recent | 3,181 → **4,711** | 96 → 11 | 30 → 40 | 12 → 5 | 21,819 → 5,677 | $0.0034 → $0.0009 | 1.4 s → 0.2 s |
| 5 syncs in a day, 8 new each (app reopened) | 16,695 → **2,860** | 524 → 40 | 150 → 32 | 60 → 2 | 108,768 → 2,265 | $0.0172 → $0.0004 | 8.0 s → 0.9 s |
| 5 syncs in a day (same tab kept open) | 3,695 → **2,860** | 113 → 40 | 53 → 32 | 60 → 2 | 108,768 → 2,265 | $0.0172 → $0.0004 | 1.8 s → 0.9 s |
| 5 refreshes, no new mail (reopened) | 17,705 → **5** | 570 → 5 | 150 → 0 | 60 → 0 | 108,810 → 0 | $0.0172 → $0.0000 | 8.6 s → 0.5 s |
| 5 refreshes, no new mail (same tab) | 2,125 → **5** | 72 → 5 | 32 → 0 | 60 → 0 | 108,810 → 0 | $0.0172 → $0.0000 | 1.4 s → 0.5 s |
| 30 label changes | 3,563 → **13** | 116 → 3 | 30 → 0 | 12 → 0 | 21,751 → 0 | $0.0034 → $0.0000 | 1.8 s → 0.1 s |
| 10 deletions (2 financial) | 3,563 → **13** | 116 → 3 | 30 → 0 | 12 → 0 | 21,762 → 0 | $0.0034 → $0.0000 | 1.8 s → 0.1 s |
| Expired history checkpoint + 10 new | 3,543 → **723** | 115 → 11 | 30 → 8 | 12 → 1 | 21,765 → 1,131 | $0.0034 → $0.0002 | 1.8 s → 0.2 s |
| 3 accounts × 2 syncs | 21,072 → **15,357** | 678 → 60 | 180 → 15 | 72 → 3 | 130,617 → 3,393 | $0.0206 → $0.0006 | 10.3 s → 1.1 s |

Other measured results:
* **Expired checkpoint:** recovered with the windowed list plus two cheap ID lists (INBOX, UNREAD). It found all 10 new emails and marked 6 deletions.
* **Label changes:** all 30 updated without a single message or body GET.
* **3 accounts:** 220 rows per account and **0 cross-account rows**.
* **Failure injection:** with 15 % of metadata and full GETs returning 429, nothing was lost. Records were retried, and 13 deferred items were kept as `meta-pending` for the next sync. The status said "partly synced · 13 waiting for quota".
* **Batch transport failure:** after 2 failures the pipeline switched to single GETs, and all 214 records arrived.

## 6. Classification quality (precision / recall per category)

"unseen" counts as a miss: CURRENT never fetches mail outside its fixed searches. CURRENT also has no food, document, security, newsletter, social or personal categories (they fall into "other"), so its overall accuracy is not a like-for-like comparison. **The critical categories are bill, travel, payment and refund.**

### Hold-out (60 emails, written before the first run; blind first run — never tuned on)

| Category | n | Current P | Current R | Optimised P | Optimised R |
|---|---|---|---|---|---|
| bill | 8 | 0.75 | 0.75 | 1.00 | 1.00 |
| payment | 7 | 0.75 | 0.43 | 1.00 | 1.00 |
| refund | 5 | 1.00 | 0.60 | 1.00 | 0.80 |
| travel | 7 | 0.60 | 0.43 | 0.86 | 0.86 |
| food | 4 | – | 0.00 | 1.00 | 0.75 |
| subscription | 4 | 0.67 | 1.00 | 1.00 | 1.00 |
| receipt | 5 | 0.83 | 1.00 | 0.71 | 1.00 |
| document | 3 | – | 0.00 | 1.00 | 0.67 |
| security | 3 | – | 0.00 | 1.00 | 1.00 |
| promotion | 6 | 1.00 | 0.17 | 1.00 | 0.83 |
| newsletter | 3 | – | 0.00 | 0.75 | 1.00 |
| social | 2 | – | 0.00 | 1.00 | 1.00 |
| personal | 3 | – | 0.00 | 1.00 | 0.67 |
| **accuracy** | 60 | **0.417** | seen 53 | **0.9** | seen 60 |

**Confusion (optimised, hold-out blind)**

| exp \ pred | bill | payment | refund | travel | food | subscription | receipt | document | security | promotion | newsletter | social | personal | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bill | 8 | · | · | · | · | · | · | · | · | · | · | · | · | · |
| payment | · | 7 | · | · | · | · | · | · | · | · | · | · | · | · |
| refund | · | · | 4 | · | · | · | 1 | · | · | · | · | · | · | · |
| travel | · | · | · | 6 | · | · | · | · | · | · | · | · | · | 1 |
| food | · | · | · | · | 3 | · | 1 | · | · | · | · | · | · | · |
| subscription | · | · | · | · | · | 4 | · | · | · | · | · | · | · | · |
| receipt | · | · | · | · | · | · | 5 | · | · | · | · | · | · | · |
| document | · | · | · | · | · | · | · | 2 | · | · | · | · | · | 1 |
| security | · | · | · | · | · | · | · | · | 3 | · | · | · | · | · |
| promotion | · | · | · | · | · | · | · | · | · | 5 | 1 | · | · | · |
| newsletter | · | · | · | · | · | · | · | · | · | · | 3 | · | · | · |
| social | · | · | · | · | · | · | · | · | · | · | · | 2 | · | · |
| personal | · | · | · | 1 | · | · | · | · | · | · | · | · | 2 | · |

### 200 labelled set (rules were tuned on this set — not an accuracy claim)

| Category | n | Current P | Current R | Optimised P | Optimised R |
|---|---|---|---|---|---|
| bill | 22 | 0.73 | 0.36 | 1.00 | 1.00 |
| payment | 20 | 0.82 | 0.45 | 1.00 | 0.80 |
| refund | 14 | 1.00 | 0.14 | 1.00 | 1.00 |
| travel | 22 | 1.00 | 0.41 | 0.96 | 1.00 |
| food | 12 | – | 0.00 | 1.00 | 0.92 |
| subscription | 14 | 0.64 | 0.50 | 1.00 | 1.00 |
| receipt | 18 | 0.46 | 0.33 | 0.82 | 1.00 |
| document | 10 | – | 0.00 | 1.00 | 1.00 |
| security | 8 | – | 0.00 | 1.00 | 1.00 |
| promotion | 24 | 1.00 | 0.21 | 1.00 | 1.00 |
| newsletter | 14 | – | 0.00 | 1.00 | 1.00 |
| social | 10 | – | 0.00 | 1.00 | 1.00 |
| personal | 12 | – | 0.00 | 1.00 | 0.92 |
| **accuracy** | 200 | **0.23** | seen 85 | **0.97** | seen 200 |

**Confusion (optimised, 200 set)**

| exp \ pred | bill | payment | refund | travel | food | subscription | receipt | document | security | promotion | newsletter | social | personal | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bill | 22 | · | · | · | · | · | · | · | · | · | · | · | · | · |
| payment | · | 16 | · | · | · | · | 3 | · | · | · | · | · | · | 1 |
| refund | · | · | 14 | · | · | · | · | · | · | · | · | · | · | · |
| travel | · | · | · | 22 | · | · | · | · | · | · | · | · | · | · |
| food | · | · | · | · | 11 | · | 1 | · | · | · | · | · | · | · |
| subscription | · | · | · | · | · | 14 | · | · | · | · | · | · | · | · |
| receipt | · | · | · | · | · | · | 18 | · | · | · | · | · | · | · |
| document | · | · | · | · | · | · | · | 10 | · | · | · | · | · | · |
| security | · | · | · | · | · | · | · | · | 8 | · | · | · | · | · |
| promotion | · | · | · | · | · | · | · | · | · | 24 | · | · | · | · |
| newsletter | · | · | · | · | · | · | · | · | · | · | 14 | · | · | · |
| social | · | · | · | · | · | · | · | · | · | · | · | 10 | · | · |
| personal | · | · | · | 1 | · | · | · | · | · | · | · | · | 11 | · |

### 1,000 new emails in 30 days (volume; same templates)

| Category | n | Current P | Current R | Optimised P | Optimised R |
|---|---|---|---|---|---|
| bill | 110 | 0.75 | 0.11 | 1.00 | 0.98 |
| payment | 100 | 0.82 | 0.09 | 1.00 | 0.80 |
| refund | 70 | 1.00 | 0.01 | 1.00 | 0.99 |
| travel | 110 | 0.70 | 0.06 | 0.99 | 1.00 |
| food | 60 | – | 0.00 | 1.00 | 0.90 |
| subscription | 70 | 0.69 | 0.13 | 1.00 | 1.00 |
| receipt | 90 | 0.33 | 0.06 | 0.82 | 0.93 |
| document | 50 | 1.00 | 0.02 | 1.00 | 1.00 |
| security | 40 | – | 0.00 | 1.00 | 0.95 |
| promotion | 120 | 1.00 | 0.06 | 1.00 | 0.98 |
| newsletter | 70 | – | 0.00 | 1.00 | 0.97 |
| social | 50 | – | 0.00 | 1.00 | 1.00 |
| personal | 60 | – | 0.00 | 0.97 | 0.95 |
| **accuracy** | 1000 | **0.051** | seen 99 | **0.956** | seen 986 |

**Critical recall check (spec: must not drop):**

| Set | Bill | Travel | Payment | Refund |
|---|---|---|---|---|
| Hold-out (blind) | 0.75 → **1.00** | 0.43 → **0.86** | 0.43 → **1.00** | 0.60 → **0.80** |
| 200 set | 0.36 → 1.00 | 0.41 → 1.00 | 0.45 → 0.80 | 0.14 → 1.00 |
| 1,000 volume | 0.11 → 0.98 | 0.06 → 1.00 | 0.09 → 0.80 | 0.01 → 0.99 |

There was no drop, so no threshold change was needed. The rules **were tuned on the 200 set**, so its 0.97 is not a claim. The hold-out 0.90 is the honest estimate, and it is still synthetic.

**What the remaining errors look like:**
* **Hold-out (6 of 60 wrong):**
  * a refund read as a receipt
  * a travel email left as "other"
  * a food order read as a receipt
  * a document left as "other"
  * a promotion read as a newsletter
  * a personal email that mentions tickets, read as travel
* **200 set:** 3 card or app receipts labelled payment were classified as receipt. This is ambiguous by nature, and the finance ledger treats both as paid.

## 7. Tests run (all pass)

| Suite | Result |
|---|---|
| `tests/gmail-v2-unit.js` (new): scheduler, DST, catch-up = 1 sync, 15-min skip, lease and Web Locks (no overlap), cache isolation, label-only, tombstones, domain learning (N=3, conflicts, user override, no content), batch build/parse, cleaning, strict JSON, `bodyHash` guard, financial privacy, daily cap, price table, batch disabled, JSON-LD, microdata, escalation, no guessing of ambiguous dates | **39/39** |
| `tests/gmail-v2-browser-e2e.js` (new, real app in Chromium): cold backfill with batch and trimmed headers; reload → **0 Gmail requests**, identical Money view; manual refresh → 1 unit; history-only new mail; label-only; deleted bill → kept and flagged; **two tabs → one sync**; missed slots → one catch-up; batch failure → fallback; review → domain only; no bodies at rest; metrics recorded; no page errors | **19/19** |
| `tests/gmail-cost-bench.js` (new) | critical recall: no drop |
| Phase 2 finance E2E (now running on v2, with batch fallback) | 22/22 |
| Phase 1 browser E2E (engine set to `legacy`; proves the fallback path is intact) | 22/22 |
| Phase 1 Gmail sim | 69/69 |
| finance suite | 58/58, sequences 13/13, acceptance PASS |
| ai-email suite | 33/33 |
| oauth scope check | pass (**no scope change**) |
| phase 11 / 13 / 14 | pass / 26/26 / 22/22 |
| service worker (`daylight-v90`, offline reload) | pass |

## 8. Limits and honest caveats

1. **Everything is synthetic.** Real inboxes have far fewer high-value emails than this set (65 %), so real body and AI counts should be lower. That is not measured.
2. **The browser CORS behaviour of the batch endpoint is not verified.** Planned check: one batch of 2 metadata GETs on your account (about 40 units), **only with your approval**.
3. The first backfill is heavier than today's cold sync (see §1). On a large inbox it completes over several syncs; the status shows "N full texts queued / waiting for quota" until it is done.
4. **AI quality is not measured.** The stub returns no category, and only the call counts and costs are measured.
   * The AI backlog drains only as new mail adds credits.
   * Items waiting for AI keep their rules result. They are not dropped, but they may wait a long time in quiet periods.
5. **Attachments:** metadata is recorded (name, type, size, id). **Auto-download is OFF, as you chose, and that download path is not implemented.** Nothing new is uploaded anywhere.
6. **Gemini Batch:** the interface and config are in place, but submission is disabled. It would need a Worker change, a deploy and a privacy note, all pending your approval.
7. **Scheduled slots only fire while a Daylight tab is open.** Otherwise the next open does one catch-up sync. A server-side cron is not built.
8. **"Scan older bills (180 days)"** is manual only and metadata-first. It is not tested against real mail.
9. **Recall depends on the rules.** New senders or wording outside EN/CS/DE/HI may land in "personal/other". Escalation plus the body-matching ID searches reduce this but do not remove it.

## 9. Approval needed before deployment

Nothing is committed, pushed or deployed. When you approve, the deploy would include:
* the 8 new modules
* `app.js`, `daylight-ai.js`, `email-classify.js`, `finance-intel.js`, `gmail-sync.js`, `index.html`, `sw.js`, `privacy.html`
* the tests and reports

No OAuth scope changes. No existing data is deleted or migrated.
