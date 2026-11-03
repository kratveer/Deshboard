# Daylight — Phase 1 Final Verification

**Date:** 3 Nov 2026 · **Verdict:** no unresolved critical issues; Phase 1 is ready to deploy once you approve. Nothing has been committed, pushed or deployed.

## 1. Diff review

The diff against the pre-Phase-1 baseline covers 4 modified files and 1 new module (plus tests):

| File | Δ | Reviewed for |
|---|---|---|
| `gmail-sync.js` (new) | +450 | budget/backoff logic, cache invalidation, epoch reset, failure accounting |
| `app.js` | +130 / −82 | every changed hunk: `api()`, `gmailRequest`, `loadMail`, `loadTasks`, `refreshAll`, `apiRetry`, `loadLoops`, drawer/diagnostics, visibility throttle, session reset |
| `daylight-store.js` | +24 | additive `recordSyncPartial`; `recordSyncSuccess` keeps all previous fields |
| `index.html`, `sw.js` | 2 / 4 | load order (`gmail-sync.js` before `app.js`), cache bump, shell list |

## 2. Issues found during verification (all fixed, all re-tested)

| # | Severity | Issue | Fix |
|---|---|---|---|
| V1 | Medium | Mobile **pull-to-refresh** always toasted "Updated", even after a partial or failed sync | The toast now reflects the result ("Partly updated · see the status") |
| V2 | Medium | Engine **cache had no upper bound**: in a long-running tab, messages that left every search window stayed in memory | Entries unseen for 5 syncs are dropped. S14: cache plateaus at ~194 entries over 12 churning syncs |
| V3 | Low | A new browser-only Google grant (possibly another account) reused the in-memory mail cache | Cache reset when the access token changes on a new grant |
| V4 | Low (pre-existing, not from Phase 1) | Tapping the current mobile tab threw `Cannot read properties of undefined (reading 'force')` (`setTab(t)` without options). Exists in the baseline | `opts?.force` |

## 3. Integration across screens (browser E2E, mocked Google, same mailbox for both builds)

| Mobile tab | Baseline build | Phase 1 build |
|---|---|---|
| Home / Inbox / Wallet / Timeline / Health | render; inbox **33** cards (records lost to 68 quota 403s) | render; inbox **42** cards, 0 quota errors, no page errors |
| Manual refresh right after | 101 calls, 97 rejected by quota, status "could not load · Quota exceeded…" | 25 calls, 1,006 units, "updated" |

Downstream code reads metadata-only messages (no `parts`) without errors on every screen: E9 plus all other scenarios report no page errors.

## 4. Race conditions, cache, service worker

- **Concurrent refreshes** (start-up + manual + brief pop-up): share one engine. In-flight requests for the same message are reused, and the budget is shared. Repeated-refresh tests show no duplicates.
- **Account association:** sync state was previously written to `acct:local:device` on first sign-in (confirmed in the baseline E2E). The profile is now resolved first.
- **Brief pop-up / reply refresh** call `loadLoops()` directly. Their data is accounted for and stored as partial when needed, but they don't update the status line. Known, low.
- **Service worker** (`tests/phase1-sw-check.js`): `daylight-v88` installs, caches 14 shell files including `gmail-sync.js`, and an offline reload boots the app with the module present.

## 5. Data preservation and secrets

- No IndexedDB schema change or migration. No localStorage keys removed. Existing sync rows under the old local account are left untouched. No scopes or worker changes.
- No new `console` output in the engine. Changed app code logs only error objects, as before.
- Stored diagnostics contain counts, message IDs and Google error text, never email content.
- Test reports contain only synthetic data and a fake token. The live probe file holds counts only.
- Email bodies stay in memory and are never written to storage.

## 6. Test results (final code)

| Suite | Result |
|---|---|
| `gmail-sync-sim.js` | **69/69** (adds S14 cache bound) |
| `phase1-browser-e2e.js` (Phase 1 + baseline) | **22/22** (adds E9 mobile tabs) |
| `phase1-sw-check.js` (new) | pass |
| `oauth-scope-check`, `ai-email-suite` 33/33, `phase13-data` 26/26, `phase14-travel-identity` 22/22, `phase11-e2e` 13/13 | pass |
| Live probe on the real account (earlier today) | 138 / 20 / 39 requests, 4,066 / 706 / 1,846 units, 0 errors |

## 7. Remaining risks

- The worker 502 clears the session (Phase 4).
- The memory-only cache makes each reload a cold sync (~4,000 units).
- The first sync is quota-paced (~12 s live).
- The live incremental-history path has only been exercised in simulation.
- The integrated build hasn't run against real Google, because it isn't deployed.

## 8. Deployment requirements (when approved)

1. Commit: `gmail-sync.js`, `app.js`, `daylight-store.js`, `index.html`, `sw.js` + tests. No worker redeploy, no secrets, no scope changes.
2. After the Pages deploy, hard-reload once (SW `daylight-v88`). Check that `gmail-sync.js?v=1` loads.
3. Acceptance on the real account:
   - Sync Diagnostics shows ≤ ~4,100 units cold, 0 quota errors, `records.failed = 0`.
   - The status says "updated", or "Partial sync" with specific reasons.
   - A second refresh within 2 min uses < 1,000 units.
4. Rollback: revert the commit. No data migration to undo.
