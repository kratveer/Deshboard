# Daylight V2 — real-world validation report (interim, 2026-11-05)

**Status: pre-deployment.** Everything marked TESTED below was run in Chromium against synthetic mailboxes with Google mocked. **No real Gmail account has been tested yet**, neither yours nor the external tester's. Those rows say NOT RUN, and no result is claimed for them.

## 1. Scope and method

| Brief item | Status | How |
|---|---|---|
| 1. Every card comes from stored data | TESTED (synthetic) | Code review of every render path in `ui/v2-app.js`, plus an automated provenance check. Each card on every tab (including the People and Updates views) must resolve to a graph Item that has a source. The same check runs live in Diagnostics → Provenance. |
| 2. Deploy frontend, keep classic view | PARTLY DONE | Phase D is live (`daylight-v97` confirmed on GitHub Pages). The Phase E changes are in your local folder, waiting for you to push them (`daylight-v98`). The classic view (`?ui=v1`) is tested. |
| 3. Your account + an external tester | NOT RUN | Needs your sign-in on the live site and a tester (see `TESTER_GUIDE.md`). |
| 4. Classification, ranking, receipts, bookings, deadlines, Money, Wallet, Ask | TESTED (synthetic) only | Model unit tests, UI E2E and a two-account E2E with a small hand-made second mailbox. |
| 5. Isolation, disconnect-and-delete, undo, persistence | TESTED (synthetic) | `v2-isolation-e2e` 11/11, `v2-ui-e2e` 22/22, `v2-disconnect-e2e` 13/13. |
| 6. Real Gmail quota, missed and misclassified emails | NOT RUN | The Diagnostics view now records and shows the real counters; it needs a real sync. |
| 7. Intelligence Diagnostics | BUILT + TESTED | Settings → Developer, or `?diag=1`. |
| 8. Report | THIS DOCUMENT (interim) | The real-account sections are filled in after step 3. |

## 2. Issues found so far, by severity

| # | Severity | Issue | Found by | Status |
|---|---|---|---|---|
| 1 | **Critical** | **Bills lost their due date.** The rules store `dueDate` as `{date, raw, confidence}`, but the Gmail connector used it as a string. Effects: <br>• bills had no due date (Money showed "No due date found" everywhere) <br>• the fact read "[object Object]" <br>• a bill without a reference got an unstable key | Two-account E2E (second mailbox) | FIXED. The connector normalises the date, and a due date now means 23:59 local time. Existing data needs a one-time full re-ingest (automatic: watermark `x2`). Stale bills are removed and your Done/snooze is carried over to the corrected bill. Unit-tested. |
| 2 | **High** | **Cross-account leak on a shared device.** The V2 UI read every Item in the graph. A second Gmail account signing in on the same browser would have seen the first account's cards, and the first account's sender rules would have been applied to the second account's mail. | Code review, then E2E | FIXED. The UI shows only the active account (plus device-local tasks and passes), and rules are filtered by account. E2E: B never sees A's cards, Ask results or rules; A's actions survive switching. |
| 3 | **High** | **Travel email with a bare reference produced no booking.** For example, "Your ticket Brno → Praha, booking RJ55120" was typed as Travel, had no booking Item and did not appear in Wallet. | Two-account E2E | FIXED. A reference is now read after "booking/reservation" when it mixes letters and digits, and a travel email with a travel date becomes a booking even without a reference. |
| 4 | **Medium** | **A person asking about money was counted as spending.** "Landlord: could you confirm you sent the rent of 14 000 CZK?" became a 14 000 CZK payment in Money. | Two-account E2E | FIXED. It is now a Personal message to answer (Needs you), and no transaction is created. |
| 5 | Medium | Re-ingest never removed derived Items that an email no longer produces, after an extraction fix or reclassification. | Review while fixing #1 | FIXED. `detachSources` drops the stale link, deletes orphans and carries user state over. |
| 6 | Medium (design) | Disconnect deletes the Gmail data of **every** account stored on the device, not only the signed-in one. | Isolation E2E (documented, not changed) | OPEN — decision needed. It is safe for privacy, but surprising if two people share a browser. |
| 7 | Low | Device-local tasks and Wallet passes are visible to any account on that device. | Isolation E2E | OPEN — by design for now. The tester guide tells testers to use their own device. |
| 8 | Low | For a moment after switching accounts, the previous account's profile is used until the new profile loads. The UI reloads as soon as it changes. | Code review | OPEN — not observed in the E2E. Needs a real two-account check. |

## 3. What still has to happen with real accounts (NOT RUN)

1. **You:** push the Phase E files. Then, on the live site: sign in, wait for the first sync, and open `?diag=1`. I can read the Diagnostics view with you in the Claude browser if you allow it.
2. Record from Diagnostics:
   - quota units for the cold sync and a warm sync
   - Gmail categories indexed vs skipped
   - extraction coverage
   - duplicates and provenance
3. **Review emails:** label about 50 of the newest emails (type right/wrong, matters/doesn't). This gives real type accuracy, importance recall and false alarms.
4. Spot-check against Gmail:
   - every unpaid bill from the last 30 days appears in Money
   - every upcoming trip appears in Wallet
   - every dated deadline appears in Plan
   - Ask answers cite the right emails
5. **External tester:** add them as a Google OAuth test user, send `TESTER_GUIDE.md`, and collect their redacted report.
6. Fill in sections 4–6 below from those results. Nothing goes in them until it has been observed.

## 4. Real Gmail quota — NOT RUN
## 5. Classification and ranking on real mail — NOT RUN
## 6. External tester — NOT RUN

## 7. Regression status after these fixes (synthetic, 2026-11-05)

| Area | Suites (all passing) |
|---|---|
| V2 | v2-graph-unit 50/50, v2-model-unit 55/55, v2-diagnostics-unit 15/15, v2-ui-e2e 22/22, v2-isolation-e2e 11/11, v2-graph-e2e 9/9, v2-disconnect-e2e 13/13 |
| Gmail engine | gmail-v2-unit 39/39, v2-discovery-unit 23/23, discovery bench 8/8, gmail-sync-sim 69/69, gmail-v2-browser-e2e 19/19 |
| Phases 1, 2, 11, 13, 14 | phase1 E2E 22/22, phase2 finance E2E 22/22, finance suite 58/58, phase11 lifecycle OK, phase13 26/26, phase14 22/22 |
| Other | ai-email-suite 33/33, mail-dates 12/12, sw-check (`daylight-v98`), oauth-scope-check |
