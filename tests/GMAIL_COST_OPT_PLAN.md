# Daylight — Gmail cost & resource optimisation v2: current flow + plan (for approval)

Date: 4 Nov 2026 · Status: **inspection only, no code changed.** Base: the Phase 1 + Phase 2 build now in your local folder (not deployed).

## 1. Current flow (as built today)

### Triggers
| Trigger | Where | Behaviour |
|---|---|---|
| App load with "Stay signed in" | `app.js` `serverToken().then(refreshAll)` | full sync on every page load |
| Manual refresh | drawer **Retry**, pull-to-refresh | full sync (`force`) |
| Tab becomes visible | `visibilitychange` | full sync if the last one started more than 2 min ago |
| Connect / reconnect | OAuth callbacks | full sync |

* No time-of-day schedule.
* Overlap protection is a per-tab `syncBusy` flag only, so **two open tabs run two syncs**.

### Gmail pipeline (`gmail-sync.js`, called by `loadLoops` in `app.js`)
1. **`getProfile`** (1 unit) gives the current `historyId`.
2. **`history.list`** (2 units/page) runs from the stored cursor.
   * It applies deletions and label changes to the **in-memory** cache and adds up to 25 new IDs.
   * On 404 or overflow it marks the whole cache stale.
3. **Six `messages.list` searches run on every sync, whatever history says** (5 units each):
   * `inbox`: INBOX, 50 messages, metadata unless `wantsBody`
   * `moneyA`: 120 days, 30 messages, **full**
   * `moneyB`: 90 days, updates category, 20 messages, **full**
   * `moneyC`: 180 days, 10 known billers, 25 messages, **full**
   * `travel`: 45 days, 15 messages, **full**
   * `docs`: 45 days, has attachment, 12 messages, **full**
4. The IDs are merged and de-duplicated. Each unique message is fetched once:
   * `format=metadata` costs **20 units**, `format=full` costs **60 units**.
   * At most 30 full bodies per sync; the rest are queued for the next sync.
   * Metadata requests send no `metadataHeaders`, so all headers come back. That costs bytes, not units.
5. **Sent threads**: `threads.list` (10 units) plus up to 12 `threads.get` (40 units each), used for "waiting on a reply" loops. Results are cached by thread `historyId`, in memory only.
6. **Classification and extraction:**
   * `email-classify.js` (rules) runs on everything.
   * `finance-intel.js` (Phase 2 rules, **no AI**) runs on everything.
   * `daylight-ai.js` (Gemini, through the Worker) runs on at most 12 messages per sync, only with AI consent.
7. Results are written to `daylight-db` (entities, facts) and `localStorage` (finance ledger, AI extractions).

### Where Gmail quota goes (measured live on your account, Phase 1, 3 Nov)
| Run | Requests | Units | Breakdown |
|---|---|---|---|
| Cold (every page load) | 138 | **4,066** | 87 metadata × 20 = **1,740 (43%)** · 30 full × 60 = **1,800 (44%)** · 12 threads.get × 40 = **480 (12%)** · 7 lists, profile, threads.list = 46 |
| Warm +30 s | 20 | 706 | 7 lists (35) + 11 queued bodies (660) |
| Warm +2.5 min | 39 | 1,846 | 7 lists + 30 queued bodies (1,800) |

Root causes:
1. **The message cache is memory-only, so every page load or reload is a cold sync (~4,000 units).** This is by far the largest cost.
2. The six searches are re-listed on every sync, even when history shows nothing new.
3. Long look-back windows (90–180 days) pull many old messages, and those need full bodies.
4. There is a full-body backlog of about 49 per cold sync, which drains over the following syncs at 60 units each.
5. Opening the app several times a day, or keeping several tabs, repeats all of the above.

### Where AI money goes (`daylight-ai.js`)
* Gemini (`gemini-3.5-flash-lite`) is reached through the Worker. It is **off unless you consented**. Bills, payments and subscriptions are never sent unless the separate opt-in is on.
* Up to **12 calls per sync**. An unchanged message is **re-sent after 6 hours**: the skip rule is "Gemini result younger than 6 h".
* The response cache key is a hash of the prompt. The prompt includes `current_datetime`, so **the cache almost never hits**.
* The body is truncated at 6,000 characters. HTML, quotes and signatures are not stripped.
* No daily cap. Usage counts calls and prompt/output tokens in `localStorage`, but there is no cost estimate.
* Phase 2 financial intelligence uses no AI, so it adds no money cost.

### Data model today
* **IndexedDB `daylight-db` v2** has these stores:
  * `accounts`
  * `entities` (account-scoped, with `sourceKey`)
  * `relationships`
  * `facts` (versioned, with change detection)
  * `actions`
  * `reminders`
  * `meta`, which holds the per-account sync state including the Gmail `historyId` cursor
* There is **no per-message store**.
* **`localStorage`** holds the finance ledger, corrections and confirmed reminders (Phase 2), the AI cache, AI usage and AI extractions, and tasks.
* **Attachments**: only metadata is parsed. A file is downloaded **only when you tap it**; nothing is downloaded automatically.

## 2. Plan — files to add / change

### New modules (no DOM, unit-testable, usable later from a Worker)
| File | Purpose |
|---|---|
| `gmail-config.js` | One config object holding every number in this spec (slots, window, thresholds, batch size, AI cap, prices, attachment limits). Per-account overrides. |
| `sync-scheduler.js` | Pure slot logic (`nextSlot`, `missedSlots`, `shouldRunOnOpen`). A cross-tab lock: Web Locks, falling back to a BroadcastChannel plus a `localStorage` lease with a TTL. Browser triggers (open, visible, timers while open) live in a thin adapter, so a Workers cron can call the same `runSync()` later. |
| `gmail-cache.js` | Account-scoped IndexedDB message index and facts store (schema in §3). Diff logic: decides new / label-only / deleted / unchanged. |
| `gmail-rules.js` | Stage B: the ordered rule pipeline, each rule returning `{category, confidence, reason}`. Stage C: JSON-LD and microdata parsing plus regex extraction. Unfamiliar senders that mention money, dates or bookings are escalated, not discarded. The domain cache sits behind `getDomainCategory` / `recordDomainCategory`. |
| `gmail-batch.js` | Gmail HTTP batch (`multipart/mixed`, at most 50 per batch). It parses each part's response, and per-part 429/5xx goes back into the existing backoff. **If the batch endpoint fails CORS or errors, it falls back to single GETs automatically.** |
| `ai-budget.js` | Text cleaning (HTML, quoted replies, signatures, footers, tracking links), truncation to 2,000 characters, a strict JSON schema with per-field confidence, one retry at most, a `bodyHash` guard, a daily cap with deferral, a token and cost ledger with a price table, and domain learning (N = 3). |
| `sync-metrics.js` | Per-day, per-account counters for the Sync Efficiency panel. |

### Changed
| File | Change |
|---|---|
| `gmail-sync.js` | **Not rewritten.** Its retry, backoff, budget and accounting stay. Additions: a new **incremental plan mode** (history-driven discovery, list only on cold start or recovery, `newer_than:30d`), cache-backed lookups through `gmail-cache.js`, and batch fetches through `gmail-batch.js`. The current six-query plan stays available behind a config flag, so this is reversible. |
| `app.js` | Wire up the scheduler, replacing the load, visibility and 2-minute triggers. Feed Stage B/C results into the existing `applyEmailClassification`, `finance-intel` and `daylight-ai`. Add a small review queue in the Money/Inbox sheet. Add the Sync Efficiency section in Sync Diagnostics. |
| `daylight-ai.js` | Use `ai-budget.js`. Remove `current_datetime` from the cache key and pass it as a separate field. Make the system prompt fixed. Guard on `bodyHash` instead of 6 hours. |
| `index.html`, `sw.js` | Script tags and shell cache bump. |
| `server/src` (Worker) | **Only if you approve the Gemini Batch decision below.** Not deployed. |

### Tests
* `tests/fixtures/mail-200.js`: about 200 labelled synthetic emails covering every category, including tricky ones (unfamiliar senders, mixed CZ/HI/EN, forwarded receipts, look-alike promotions, JSON-LD).
* `tests/gmail-cost-bench.js`: a mock Gmail with history, labels, deletions, expired cursors, multiple accounts, batch support and quota accounting. It runs **current vs optimised** on every scenario in §8 and measures calls, units, bodies, AI calls, tokens, cost, time, and per-category precision and recall.
* Unit tests for the scheduler (slots, catch-up = one sync, 15-minute skip, two-tab lock), the cache diff, the rules and the AI budget.
* All Phase 1 and Phase 2 suites are re-run.

## 3. Storage — recommendation: a **separate** IndexedDB database, no migration of `daylight-db`

The data is the same either way: a new DB `daylight-mail` v1, or bumping `daylight-db` to v3. A separate DB is safer:
* Bumping `daylight-db` to v3 would break any **older cached copy of the app**. A service-worker tab still running the v2 code would get a `VersionError` opening it, and that copy is where your entities, facts and accounts live.
* A separate DB leaves `daylight-db` completely untouched. It can be cleared on its own ("reset mail cache") without touching financial records.

```js
// daylight-mail v1 — all keys are account-scoped
mailIndex:      keyPath ['accountId','messageId']   indexes: byAccount, byAccountThread ['accountId','threadId'], byAccountStatus ['accountId','status']
  { accountId, messageId, threadId, historyId, labels[], internalDate, from, fromDomain, subject, snippet,   // ← see decision 2
    category, confidence, ruleStage, ruleReason, status: 'new'|'classified'|'review'|'body-queued'|'done'|'deleted',
    bodyFetched, bodyHash, factsId, attachments:[{name,mimeType,size,attachmentId}], aiAt, lastProcessedAt }
mailFacts:      keyPath 'id'                        indexes: byAccountMessage ['accountId','messageId']
  { id, accountId, messageId, kind, fields{…with per-field confidence}, source: 'jsonld'|'regex'|'ai', bodyHash, at }
domainCategory: keyPath ['accountId','domain']      { domain, category, hits, source: 'user'|'ai'|'seed', at }   // domain → category only, no content
aiQueue:        keyPath 'id'                        indexes: byAccountState  { id, accountId, messageId, bodyHash, reason, state, attempts, notBefore }
attachmentMeta: keyPath ['accountId','messageId','attachmentId']  index: byHash  { name, mimeType, size, sha256?, downloaded }
syncMetrics:    keyPath ['accountId','day']         { counters… }
checkpoint:     keyPath 'accountId'                 { historyId, windowDays, backfilledAt, lastSyncAt, lastSlot }
```

* Raw bodies are **never stored**; only `bodyHash` and the extracted facts are kept.
* A deleted message gets `status: 'deleted'`. Any finance-ledger record linked to it is **flagged for review**, never removed.
* Nothing existing is migrated or deleted. The Phase 1 `historyId` cursor in `daylight-db` meta is read once, to seed `checkpoint`.

## 4. Expected effect (estimates, to be measured by the benchmark)

| Situation | Today (measured) | Target |
|---|---|---|
| App open, no new mail | ~4,066 units (cold every load) | ~3–15 units: profile + history (+ threads.list) |
| App open, 20 new mails | ~4,066 | ~400 metadata + a few bodies at 60 each, so roughly 500–800 |
| Five slot syncs a day, little mail | 5 × 700–4,000 | a small fraction of that |
| AI calls | up to 12 per sync, unchanged mails re-sent every 6 h | < 5% of new mail, never on an unchanged `bodyHash`, daily cap |

**Batching does not save quota.** Google counts each request inside a batch at its normal cost. It saves HTTP round trips, latency and per-request overhead, and the dashboard will report it that way.

## 5. Decisions needed from you
1. **Look-back window.** Today's money searches look back 120–180 days, which is how annual subscriptions and older unpaid invoices are found. A strict 30-day window will by definition miss mail older than 30 days on a fresh device. My proposal:
   * 30-day backfill by default;
   * finance records already in the ledger are kept;
   * a manual **"Scan older bills (180 days)"** button, metadata-first.
   * The benchmark will report recall both within the 30-day window and against today's 180-day reach.
2. **What the persistent cache may hold at rest.** Phase 1 deliberately kept no email content at rest.
   * To avoid re-fetching on every open, the index needs `from`, `subject` and `snippet` locally, in your browser only, like the finance ledger.
   * The alternative is IDs, labels and classification only. It saves less, because every open must re-fetch metadata at 20 units per message shown.
   * Recommendation: store from/subject/snippet locally, never bodies, with a "Clear mail cache" button. The privacy page text would need a one-line update, which ships with the deploy and needs your approval.
3. **Gemini Batch API.** It is cheaper, but asynchronous: results arrive minutes to hours later. Using it needs a **Worker change and deploy**. Prompts would sit with Google for the life of the job, and the privacy page would need a matching note.
   * Recommendation: build the client-side queue and the interface now, with batch submission **disabled**, and use live calls with the daily cap.
   * On your current free-tier model the money cost is ≈ $0 either way; the price table makes this visible.
4. **Automatic attachment download.** Today nothing is downloaded until you tap. The spec allows automatic download (PDF, image or `.pkpass` under 5 MB, relevant categories only), at 20 units each.
   * Recommendation: record metadata always, and add a config flag for auto-download that is **off by default**. When it is on, files stay in the browser and are never uploaded.
5. **Headers.** The spec's `metadataHeaders` list is From, Subject, Date, List-Unsubscribe and Content-Type. The app also reads `To` for inbox reply logic, so I would add `To`. `Reply-To`, `Message-ID` and `References` are only needed when you open a thread, and that view already fetches the full message.

## 6. Verification limits
* Benchmarks use synthetic or mocked Gmail only; your account is not touched.
* One small live check would still be needed later: whether the Gmail batch endpoint accepts browser CORS requests. If it doesn't, the automatic fallback means batching only loses its latency benefit. I will ask before running it.
* No deployment, no commit, no scope change, no data deletion.
