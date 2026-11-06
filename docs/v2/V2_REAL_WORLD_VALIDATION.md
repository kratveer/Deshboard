# Daylight V2 — real-world validation report (interim, updated 2026-11-05 after pre-deployment hardening)

**Status: pre-deployment.** Everything marked TESTED below was run in Chromium against synthetic mailboxes with Google mocked. **No real Gmail account has been tested yet**, neither yours nor the external tester's. Those rows say NOT RUN, and no result is claimed for them.

> **2026-11-06 — Version 1 removed.** The classic view, its route (`?ui=v1`, the stored `daylight-ui` choice, demo mode) and the Settings switch are gone; the five-tab app is the only interface. Removed with it: Microsoft 365, browser-only Google sign-in (Client ID), GridStack widgets, the V1 stores (`daylight-store.js`, `daylight-data.js`, `health-data.js`) and the Phase 1 fallback Gmail engine (a failed V2 sync is now reported, not silently replaced). The Wallet scanner was ported (`ui/v2-scan.js`). Rows below that mention the classic view are historical.

> **2026-11-06 — v104 production-readiness pass.** Scanner codes are now drawn locally (`ui/codes.js`); no code value is sent to api.qrserver.com or bwipjs-api.metafloor.com, and image URLs stored by older releases are ignored. A Content-Security-Policy restricts the page to the app, Google and the Worker. `privacy.html` rewritten for the actual architecture. The unused Phase 1 sync engine was removed from `gmail-sync.js`. All of this is tested with Google mocked; real-account validation is still pending.

## 1. Scope and method

| Brief item | Status | How |
|---|---|---|
| 1. Every card comes from stored data | TESTED (synthetic) | Code review of every render path in `ui/v2-app.js`, plus an automated provenance check. Each card on every tab (including the People and Updates views) must resolve to a graph Item that has a source. The same check runs live in Diagnostics → Provenance. |
| 2. Deploy frontend, keep classic view | NOT DONE | The live site is still Phase D (`daylight-v97`, checked 2026-11-05). The hardened build (`daylight-v99`) is in your folder, waiting for the Worker deploy and then the push. The classic view (`?ui=v1`) passes its E2E suites. |
| 3. Your account + an external tester | NOT RUN | Needs your sign-in on the live site and a tester (see `TESTER_GUIDE.md`). |
| 4. Classification, ranking, receipts, bookings, deadlines, Money, Wallet, Ask | TESTED (synthetic) only | Model unit tests, UI E2E and a two-account E2E with a small hand-made second mailbox. |
| 5. Isolation, disconnect-and-delete, undo, persistence | TESTED (synthetic) | `v2-isolation-e2e` 21/21 (switching both ways, per-account disconnect, delete another account, Delete all), `v2-ui-e2e` 25/25, `v2-sample-safety-e2e` 5/5, `v2-disconnect-e2e` 13/13, Worker 10/10. |
| 6. Real Gmail quota, missed and misclassified emails | NOT RUN | The Diagnostics view now records and shows the real counters; it needs a real sync. |
| 7. Intelligence Diagnostics | BUILT + TESTED (synthetic) | Settings → Developer, or `?diag=1`. Extended in hardening (see 2b). |
| 8. Report | THIS DOCUMENT (interim) | The real-account sections are filled in after step 3. |

## 2. Issues found so far, by severity

| # | Severity | Issue | Found by | Status |
|---|---|---|---|---|
| 1 | **Critical** | **Bills lost their due date.** The rules store `dueDate` as `{date, raw, confidence}`, but the Gmail connector used it as a string. Effects: <br>• bills had no due date (Money showed "No due date found" everywhere) <br>• the fact read "[object Object]" <br>• a bill without a reference got an unstable key | Two-account E2E (second mailbox) | FIXED. The connector normalises the date, and a due date now means 23:59 local time. Existing data needs a one-time full re-ingest (automatic: watermark `x2`). Stale bills are removed and your Done/snooze is carried over to the corrected bill. Unit-tested. |
| 2 | **High** | **Cross-account leak on a shared device.** The V2 UI read every Item in the graph. A second Gmail account signing in on the same browser would have seen the first account's cards, and the first account's sender rules would have been applied to the second account's mail. | Code review, then E2E | FIXED. The UI shows only the active account (plus device-local tasks and passes), and rules are filtered by account. E2E: B never sees A's cards, Ask results or rules; A's actions survive switching. |
| 3 | **High** | **Travel email with a bare reference produced no booking.** For example, "Your ticket Brno → Praha, booking RJ55120" was typed as Travel, had no booking Item and did not appear in Wallet. | Two-account E2E | FIXED. A reference is now read after "booking/reservation" when it mixes letters and digits, and a travel email with a travel date becomes a booking even without a reference. |
| 4 | **Medium** | **A person asking about money was counted as spending.** "Landlord: could you confirm you sent the rent of 14 000 CZK?" became a 14 000 CZK payment in Money. | Two-account E2E | FIXED. It is now a Personal message to answer (Needs you), and no transaction is created. |
| 5 | Medium | Re-ingest never removed derived Items that an email no longer produces, after an extraction fix or reclassification. | Review while fixing #1 | FIXED. `detachSources` drops the stale link, deletes orphans and carries user state over. |
| 6 | High | Disconnect deleted the Gmail data of **every** account on the device. | Isolation E2E | FIXED (hardening). Deletion is per account, with a separate *Delete all Daylight data on this device*. Policy: `DATA_OWNERSHIP.md`. E2E: disconnecting A keeps B, disconnecting B keeps A, deleting another account from Settings, and Delete all. |
| 7 | Low | Device-local tasks and Wallet passes are visible to any account on that device. | Isolation E2E | DOCUMENTED policy (device-owned, deleted only by *Delete all*). Passes and suggested tasks that Daylight made from an account's email now belong to that account. |
| 8 | High | After switching accounts, the previous profile and Items could stay on screen until the new profile loaded. | Code review | FIXED (hardening). An identity gate shows nothing account-specific until Google confirms the new account. E2E with a frame-by-frame leak monitor (A→B and B→A): zero frames showed the other account's cards, state or name. |
| 9 | High | People and organisations were keyed by address only, so an organisation seen by two accounts was ONE Item shared across accounts. It survived the other account's disconnect and carried that account's sources. | Accounts E2E | FIXED (hardening). The keys are per account, and a one-time full re-ingest (`x3`) drops the old shared Items. |
| 10 | Medium | When a browser signed in again, the old server session (with its encrypted refresh token) stayed in Workers KV for up to 180 days. | Backend audit | FIXED. The client calls `logout?keep_grant=1`, but only when `/health` advertises it, because an older Worker would revoke the grant. Worker unit test 10/10. Sessions orphaned before this fix still expire on their own. |
| 12 | High | **Observed on the live site:** the Google session had expired, and the V2 app stayed on "Confirming your account…" with no way to reconnect from that screen. | Live site, Claude browser | FIXED locally (`daylight-v100`, not yet pushed). The app re-renders when sign-in state changes and shows a *Reconnect* banner. New E2E `v2-expired-session-e2e` 4/4. |
| 13 | **Critical** | **Observed on your account (2026-11-06):** after sign-in, V2 showed no Gmail items at all. On that browser the `daylight-mail` database existed at version 1 with **no object stores**, so every V2 Gmail sync failed ("object store not found"). The app then fell back to the classic engine without telling anyone, and no Gmail Items reached the graph. Diagnostics showed 0 runs, 0 indexed and 0 quota units. How the empty database got there is unknown. | Live site, Claude browser + console | FIXED locally (`daylight-v101`): the mail cache and the graph now heal themselves (missing stores are created in a version bump), and a V2 engine failure is shown as a banner and in Diagnostics instead of being hidden. New E2E `v2-db-heal-e2e` 4/4; it fails on the old code. |
| 14 | High | **Observed on your account:** the token Google issued carries **gmail.send, drive.metadata.readonly, calendar.events.readonly, tasks.readonly and contacts.readonly**, granted to an older Daylight version, even though V2 asks only for gmail.readonly. The Worker merged the old grants (`include_granted_scopes=true`), and the app would have used Calendar, Tasks and Contacts silently. | Live site (`daylight-google-scopes`) | FIXED locally: a normal sign-in no longer merges old grants (only adding a connector does). Calendar, Tasks, Contacts and Drive calls are blocked unless that connector was turned on in V2. Gmail settings warn about the extra permissions. Worker test 11/11, scope check passed, UI E2E check (no Calendar call). **You still need to revoke Daylight once at myaccount.google.com/permissions** to drop the old grant at Google. |
| 15 | Medium | Review of the v101 fixes: (a) the self-heal checked only for missing stores, not missing indexes; (b) a failed graph ingest was still silent, and the "error cleared" step ran after the ingest, which would have wiped an ingest error; (c) the browser-only (no server) sign-in still merged old grants; (d) the engine-error banner appeared only after the next re-render. | Code review + new tests | FIXED (`daylight-v102`): missing indexes are created too; the ingest stage is recorded and the error is cleared only after a successful sync; the browser-only sign-in no longer merges; the banner updates within 1.5 s. New `v2-idb-migration-e2e` 9/9 (real IndexedDB) and `v2-engine-error-e2e` 6/6. A service-worker upgrade from v99 to v102 was tested: the old cache is deleted, the new scripts load, and offline serves the new build. |
| 11 | Medium | The diagnostics labels used the words "accuracy" and "recall" for agreement on a user-chosen sample. | Review | FIXED. They are renamed to agreement on labelled emails, and a test fails if the words return. |

## 2b. Pre-deployment hardening (2026-11-05) — what changed

- **Account-specific deletion.**
  - `deleteGmailData({accountId, active, mailCache})` deletes one account's:
    - graph Items, links, rules and actions
    - processing-log entries
    - mail-cache rows
    - keys ending in `:<account>`
    - the Wallet passes and suggested tasks made from its email (ownership is checked against that account's mail cache)
  - Device-owned tasks and passes are kept.
  - Settings lists every Gmail account on the device, with a separate delete for accounts that are not signed in.
  - *Delete all Daylight data on this device* explains in full what it deletes.
- **Switching privacy:**
  - identity gate (`daylight-session-owner`)
  - immediate UI reset on `daylight:account`
  - "Confirming your account…" placeholder
  - graph ingest only for a confirmed account
  - token-email mismatch detection
  - *Sign in with another account* (`switch=1` → Google's account chooser)
- **Account filtering audit:**

  | Where | Filtering |
  |---|---|
  | UI and IndexedDB reads | Every screen, Ask (local and AI), search, badges and Today read only `S.items`, which is filtered by the confirmed account. |
  | Rules | Filtered by account in both the UI and the connector. |
  | Actions | Filtered to visible Items. |
  | Diagnostics | Uses the account's own mail cache, metrics and ingest log, and says how many other accounts' items are hidden. |
  | Mail cache | Was already keyed by account. |
  | Service-worker cache | Holds app files only, no data. |
- **Backend audit** (Worker, with a new Node test that needs no network):
  - every sign-in gets its own random session;
  - KV keys are SHA-256 of the session, and refresh tokens are AES-GCM sealed;
  - a session can only mint tokens for its own Google account, and the token response names that account;
  - unknown or malformed sessions get 401;
  - logout revokes at Google; `keep_grant=1` only forgets the session;
  - scopes are exactly `openid email profile gmail.readonly`.
- **Diagnostics:**
  - cold vs warm sync units, and a per-run table (discovered/metadata/bodies/skipped, failed/retries/deferred, units by call);
  - category coverage, errors and unresolved messages;
  - re-ingestion log (stale links dropped, your state carried over);
  - "Discovered but skipped", with an on-demand sender/subject view (20 units each, not stored);
  - **Compare with a Gmail search**, which classifies each Gmail result as in Daylight / skipped / pending / never discovered.
- **Sample safety:** sample mode never writes to device storage. Labels and reports stay in memory, and an E2E checks that nothing from the sample reaches the real account.

## 2c. Remaining risks (not closed by tests)

| Risk | Severity | Note |
|---|---|---|
| No real Gmail account has been tested yet | **Blocking** | Everything below "TESTED (synthetic)" is unproven on real mail. |
| Real quota, classification quality and extraction quality are unknown | High | Only mock numbers exist. |
| The session token is kept in localStorage | Medium (existing) | Anyone who could run script on the site could read it. There is no Content-Security-Policy yet. Not changed in this pass. |
| Classic view (V1) was not audited for account switching | Medium | The V1 caches are cleared on disconnect and rebuilt on sync, but the V1 screens themselves were not re-tested for a switch. Use V2 for the two-account test. |
| If Google userinfo fails for more than 8 s at sign-in, the Gmail pipeline may cache mail under the email address rather than the account id | Low | Nothing is shown and the graph ingest is skipped. It would appear as an extra account in Diagnostics. |
| Deleting a *non-signed-in* account does not clear its classic store rows (`daylight-db`) | Low | Cleared on that account's disconnect, or by *Delete all*. |
| Gmail web links use `#all/<messageId>` | Low | Unverified for every message type on real Gmail. |
| Performance with thousands of Items | Unknown | Not measured. The graph is queried on every render and every ingest. |

## 3. What still has to happen with real accounts (NOT RUN)
Follow `REAL_GMAIL_VALIDATION_CHECKLIST.md` step by step and record what is observed. Sections 4–6 stay empty until then.

## 3b. Live-site observations (2026-11-05, Claude browser on your computer)

- **Observed:** the Worker `/health` returns `{"ok":true,"features":["logout_keep_grant"]}`, so the hardened Worker is deployed.
- **Observed:** the frontend service worker is `daylight-v99`, so the hardened build is live.
- **Observed:** the stored Google session had expired (the token endpoint returned a reauth error). This exposed issue #12.
- **Observed 2026-11-06, after you signed in:** sign-in confirmed the account and the identity gate worked: no other account's data was shown. Then:
  - V2 graph: 25 Items, all device-owned (24 tickets, 1 document); 0 Gmail Items.
  - Mail cache: no stores; 0 V2 sync runs; 0 V2 quota units. The classic engine ran instead, and its quota is not recorded.
  - Console: `gmail v2 — falling back to the Phase 1 engine NotFoundError … object stores was not found`.
  - These are issues #13 and #14. No classification, extraction or quota result can be taken from this run.

## 4. Real Gmail quota — FIRST OBSERVATIONS (your account, 2026-11-06, v102, Claude browser)

**Observed.** These are numbers read from Diagnostics, not estimates.

- **Build check.** The live files are byte-identical to the v102 build. The cache is `daylight-v102`. The mail database was repaired, now `daylight-mail` v2 (it had no stores before). There is no V2 engine error.
- **Sync runs:**

  | Run | Units | Discovered | Metadata | Bodies | Skipped | Deferred | Time | Notes |
  |---|---|---|---|---|---|---|---|---|
  | 1 (cold, catch-up) | 4,551 | 880 | 200 | 0 | 391 | 289 | 8 s | getMeta 4,000, threadsGet 480, messages.list 60, threads.list 10, profile 1. Partial. |
  | 2 (manual, 38 s later) | 16 | | 0 | | | | | Everything deferred: the client's own 4,800 units/min ceiling was still spent. |
  | 3 (manual, +75 s) | 4,796 | | 239 | 0 | | 50 | | |
  | 4 (manual, +65 s) | 3,458 | | 51 | 40 | | 0 | | getFull 2,400. **Complete (not partial).** |

- **Total units so far: 12,821.** 207 messages are still queued for a full read. At 40 per sync and 60 units each, that is about 12,400 more units over at least 6 syncs.
- **Index:** 880 messages.
  - Read: 243 classified + 11 done + 29 review. Queued for a full read: 207. Skipped (never read): 391.
  - Skipped by category: promotions 217/286, updates 128/227, social 34/49, forums 10/10, primary 2/303, sent 0/5.
- **Graph:** 490 emails and 71 organisations; derived Items are 4 bills, 5 transactions, 1 subscription, 5 bookings, 7 deadlines, 3 appointments and 6 deliveries. Provenance: 103 cards checked, 0 problems, 0 malformed facts. 1 likely duplicate, not yet inspected. 33 links point to Items not present: probably Wallet passes from emails that have not been read yet. Not yet confirmed.
- **Not yet meaningful:** 85 money-type emails have no money Item, and bills have a due date only 1/4 times. Most bodies have not been read yet, so judge extraction only after the full-read queue is empty.
- **Still open:** the token still carries `gmail.send`, Drive, Calendar, Tasks and Contacts. The old Google grant was not revoked, or no fresh sign-in followed the revoke (the existing session still works). V2 does not call those APIs (the guard is in place), but the grant must be removed at Google.
- **UX finding:** the status text says "waiting for quota" when the limit is Daylight's own per-minute ceiling, not Google's.
## 5. Classification and ranking on real mail — NOT RUN
## 6. External tester — NOT RUN

## 7. Regression status after hardening (synthetic, 2026-11-05)

| Area | Suites (all passing) |
|---|---|
| V2 | v2-graph-unit 50/50, v2-model-unit 55/55, v2-diagnostics-unit 17/17, v2-ui-e2e 25/25, v2-isolation-e2e 21/21, v2-sample-safety-e2e 5/5, v2-graph-e2e 9/9, v2-disconnect-e2e 13/13 |
| Worker | worker-session-isolation 10/10 |
| Gmail engine | gmail-v2-unit 39/39, v2-discovery-unit 23/23, discovery bench 8/8, gmail-sync-sim 69/69, gmail-v2-browser-e2e 19/19 |
| Classic view and earlier phases | phase1 E2E 22/22, phase2 finance E2E 22/22, finance suite 58/58, phase11 lifecycle OK, phase13 26/26, phase14 22/22, home audit unchanged |
| Other | ai-email-suite 33/33, mail-dates 12/12, sw-check OK (`daylight-v99`), oauth-scope-check passed |

Daylight is **not** production-ready. It cannot be called production-ready until the real-account checklist is complete.
