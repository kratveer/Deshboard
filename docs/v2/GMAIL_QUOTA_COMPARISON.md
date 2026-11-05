# Gmail quota comparison: old vs V2 discovery

**Goal:** find the most important emails per Gmail quota unit, not download the most email.

**Evidence:** synthetic tests only (mock Gmail charging Google's unit table). These numbers have **not** been measured on a real mailbox yet.

## Gmail quota prices

Source: Google's Gmail API quota page, checked 2026-11-05.

| Call | Units | Returns |
|---|---|---|
| `messages.list` | 5 per page | Up to 500 message IDs, no content |
| `history.list` | 2 per page | IDs added, deleted or relabelled since a checkpoint, with labels |
| `messages.get` (metadata) | 20 | Headers and snippet |
| `messages.get` (full) | 60 | Full body |
| `threads.list` / `threads.get` | 10 / 40 | Sent threads for "waiting on reply" |
| `getProfile` | 1 | Current historyId |

The limit is 6,000 units per minute per user; Daylight stays under 4,800. An HTTP batch is charged per part, so batching saves round trips, not quota. Daylight logs batch units under the operation they carry (`batch:getMeta`, `batch:getFull`).

## Old behaviour (what the audit found)

1. **First sync:** listed every message from the last 30 days, then fetched metadata for **every** listed message (20 units each).
2. **Later syncs:** the History API returned new IDs, then metadata was fetched for **every** new message.
3. **Category exclusion:** Promotions, Social and Forums were never listed or fetched. That saved quota by never seeing important mail filed there (receipts, bookings, tickets, renewals).
4. **Bodies:** selective, capped at 40 per sync. This was already good and is kept.

## V2 behaviour

1. **History first.** `history.list` from the saved historyId gives new IDs with their labels. Nothing is downloaded at this step.
2. **Free triage by label.** Primary and Sent always get metadata. Updates, Promotions, Social and Forums get metadata only when a targeted search matches the message. These searches return IDs only (5 units per page):
   - money, travel and document words (they also feed the rules as hints);
   - important non-money words: deadlines, appointments, orders, deliveries, applications, exams, meetings, confirmations, requests;
   - one `from:(…)` search over up to 40 transactional senders, learned from your mail or seeded.
3. **Nothing is silently skipped.** Every message outside those matches is stored as `skipped` (ID and labels, no content) and counted in the sync report per category. A later search or the daily recovery net promotes it.
4. **Daily recovery net.** One broader ID-only search over non-Primary mail from the last 3 days.
5. **First sync / expired historyId.** One ID-only list per category labels every message (6 lists in total); targeted searches pick the candidates. There is no mailbox download.
6. **Bodies only on evidence.** A content search match in a marketing category now also justifies a body fetch. Sender-only and safety-net matches do not.
7. **Category is never a verdict.** Promotions, Social and Forums labels are only a prior once a content search matched. Two body rules then classify the message:
   - an order number plus an amount plus confirmation words turns a "promotion" into a **receipt**;
   - a request, deadline or invitation inside Social/Forums mail becomes **important personal** communication.

## Results

Test mailbox (`tests/fixtures/mail-v2-categories.js`):

- **Size:** 306 messages, of which 26 are important.
- **Where the important ones are:** Primary 6, Updates 10, Promotions 6, Social 2, Forums 2.
- **Noise:** 280 realistic noise messages.

Sequence: connect (30-day backfill), then 8 slot syncs over 4 days with new mail arriving, then an expired-history recovery. Run with `node tests/gmail-discovery-bench.js`.

### Totals

| | Old (categories excluded) | Fetch everything | **V2** |
|---|---|---|---|
| Important emails found | **16 / 26 (62%)** | 26 / 26 | **26 / 26 (100%)** |
| Promotions / Social / Forums found | 0/6 · 0/2 · 0/2 | 6/6 · 2/2 · 2/2 | 6/6 · 2/2 · 2/2 |
| Important found that are also typed as important (not promotion/newsletter/social) | 16 | 23 | **26** |
| Noise typed as important | 0 | 0 | 0 |
| Noise that got a metadata call | 40 / 280 | 280 / 280 | 48 / 280 |
| **Quota units (whole scenario)** | 2,108 | 7,638 | **3,508** |
| Metadata calls | 62 | 313 | 80 |
| Body calls | 7 | 14 | 20 |
| List calls (IDs only) | 16 | 34 | 68 |
| History calls | 9 | 9 | 9 |
| Important emails found per 1,000 units | 7.6 | 3.4 | **7.4** |

### Initial vs routine sync

| | Old (excluded) | Fetch everything | **V2** |
|---|---|---|---|
| **Initial sync** (connect + backlog) | 1,451 units · 44 metadata · 5 bodies | 4,771 · 210 · 9 | **2,086 · 47 · 14** |
| **Routine syncs** (8 slots, 4 days) | 629 units (~79 per sync) · 18 metadata | 2,804 (~350 per sync) · 102 | **1,344 (~168 per sync) · 33** |
| **Expired-history recovery** | 28 units | 63 | 78 |
| **Repeat sync, no new mail** | 1 (profile) | 1 | 1 |

### What this means

- V2 finds **all** important emails for **54% fewer units** than downloading everything.
- Compared with the old build, V2 costs about 1,400 more units over this scenario and finds 10 more important emails. Those 10 are in Promotions, Social and Forums, where the old build was blind.
- Important emails found per unit stays about the same as the old build (7.4 vs 7.6).
- Every important email found is also **typed** correctly (26/26). Fetching everything types only 23/26, because Social/Forums requests and an order in Promotions never get the body evidence they need.
- The extra list calls (68 vs 16) are the price of category coverage. They are 5-unit ID lists, a few per sync.

## Quality on the older 200-email set

`node tests/gmail-cost-bench.js --quick` → **CRITICAL RECALL: no drop** (bills, travel, payments, refunds) on the 200-email set, the volume set and the hold-out set.

## Tests

| Test | Result | Covers |
|---|---|---|
| `tests/oauth-scope-check.js` | pass | Onboarding = Gmail read-only only (worker and app); no gmail.send; optional connectors added incrementally; reply opens Gmail; disconnect wired to data deletion |
| `tests/v2-disconnect-e2e.js` | 12/12 | Real app, synthetic data. Deleted on disconnect: Gmail cache (messages, facts, AI queue, checkpoint), account entities/relationships/facts, Gmail Wallet passes, finance ledger, Gmail keys, suggested tasks, mail links on your own tasks, session token. Worker logout (Google revoke) is called. Kept: manual Wallet card, your own tasks, theme, filters, server address. Still empty after reload. |
| `tests/v2-discovery-unit.js` | 23/23 | No category excluded; every category covered on connect; skipped mail keeps no content and never shows in the app; at most one metadata call per message; a repeat sync costs 1 unit; incremental sync uses History (Promotions order found, Promotions sale skipped, metadata for 2 candidates only); checkpoint advances; expired history recovers without re-download and still finds a new bill; pagination over 1,200+ IDs; 15% injected rate-limit failures without losing important mail |
| `tests/gmail-discovery-bench.js` | 8/8 | Recall, typing, noise and quota against the old build and fetch-everything |
| Regression suites | pass | Gmail v2 unit 39/39, sync sim 69/69, v2 browser E2E 19/19, Phase 1 E2E 22/22, Phase 2 E2E 22/22, finance acceptance, AI email, Phase 11/13/14, mail-dates 12/12, home audit, service worker v95 offline reload |

## Remaining risks and limitations

1. **Synthetic only.** Recall and units come from a mock mailbox. Real mail is messier. The next step is the read-only real-account validation plan: log discovery counts per category for a week and spot-check skipped mail.
2. **Word-based search.** An important email in Promotions/Social/Forums/Updates with none of the search words, from an unknown sender, stays skipped until the daily net, a sender rule or a later search matches it. The mock matches substrings; real Gmail matches whole words, so real recall can be a little lower.
3. **Recovery costs more than before** (78 vs 28 units): one list per category. It is still bounded and rare.
4. **Travel and retail brands' marketing.** Senders such as Wizz Air or Ryanair are in the transactional sender list, so their promotions get metadata calls. Rules then keep them out of Today/Priority.
5. **Old sessions keep old scopes.** Anyone signed in before this change still holds the broader Google grant until they reconnect. Daylight no longer uses the extra scopes; it only loads Calendar, Tasks or Contacts if those scopes are granted. Removing the old grant requires disconnecting or revoking at myaccount.google.com.
6. **The Worker must be redeployed** for Gmail-read-only sign-in. Until then the live Worker still asks for the old scope list.
7. **No embeddings or search index exist yet.** Disconnect deletes everything that exists today. When the Item Graph lands (Phase C), it must register with the same delete path. `privacy/data-reset.js` already removes `daylight-graph`.
8. **Restricted scope.** `gmail.readonly` needs Google verification for a public launch. Unverified apps are capped at about 100 users and show a warning.
9. **Desktop widgets and the legacy Phase 1 query plan** are still in the code as fallbacks. They are unused when v2 is on and are left for a cleanup phase.
