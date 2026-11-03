# Daylight — Phase 2: Financial intelligence accuracy — evidence report

Date: 3 Nov 2026 · Scope: Part A (Phase 1 final verification) + Part B (Phase 2) · Nothing committed, pushed or deployed. The changed files are written to your local folder only, uncommitted.

## 1. Verdict

| Question | Answer |
|---|---|
| Phase 1 unresolved critical issues? | **None.** 4 issues found in verification were fixed (V1–V4). Details: `tests/PHASE1_FINAL_VERIFICATION.md`. |
| Phase 2 acceptance criteria met? | **Yes, on synthetic tests and in the real app with mocked Gmail.** Not yet proven on a real unpaid bill (none in the real sample). |
| Production-ready claim? | **No.** It needs a deploy plus a check on your real inbox, including the receipt/refund/promo mail that previously produced fake "Pay" tasks. |
| Accuracy you should believe | The **blind first runs** on unseen cases: 0.73 (30 cases) and 0.55 (20 cases) category accuracy. Both had **0 fabricated payment suggestions** and lost recall on real bills (shown in *Needs review* rather than missed silently). The 100% on the main set is on cases the rules were written against. It is **not** an accuracy claim. |

## 2. What changed for the user

* Daylight **no longer creates any task by itself** from email. Every "Pay …" task now requires your tap on **Create reminder**. The button appears only for an unpaid bill with an amount and a **due date written in the email**, at ≥ 0.75 confidence and with no conflicts.
* New **Money** sheet (drawer › Money, desktop "Money" widget, links from mail detail) with sections: *To pay now* (≤ 7 days / overdue), *Upcoming*, *Needs review*, *Paid*, *Refunded*, *Incoming*, *Other financial mail*, *Dismissed*.
  * Every line shows the category, confidence and evidence quotes from the email. It also offers "Open email", a category correction, *Not financial* and *Dismiss/Restore*.
* Receipts, paid invoices, refunds, payment confirmations and promotions are **information only**. They never count as payments, never drive Home "payments", the briefing or Priority, and are never tagged *Due/Overdue* in the inbox.
* The received date is **never** used as a due date. A date without a year is marked "(year assumed)" and gets no reminder unless confidence ≥ 0.85. Ambiguous numeric dates such as 03/04 → no date, flagged as a conflict → *Needs review*.
* The 13 "Pay …" tasks that the old version auto-created in your profile are **kept untouched**. They are listed as *Old automatic payment tasks (unconfirmed)* and no longer feed the briefing, loops or payment counts. See the cleanup plan in §8.

## 3. Engine (`finance-intel.js`, new, 580 lines, no network, no AI)

* **Categories (15):** the 13 requested, plus `payment_failed` and `not_financial`.
* **Decision chain, in priority order:**
  1. Promotions need real offer wording **and** promo signals, so a promo mentioning an amount stays a promo.
  2. Refunds
  3. Failed
  4. Pending
  5. Success
  6. Paid invoice
  7. Direct debit, which becomes `unpaid_bill`/`scheduled_debit` (shown as Upcoming "Auto-pay", no reminder)
  8. Unpaid bill. This needs unpaid context such as "due", "please pay" or "splatnost", not just an amount.
  9. Receipt
  10. Subscription
  11. Incoming / outgoing
  12. Card transaction
  13. Statement
* **Extraction:** amounts are taken by role (total, amount due, refund amount, multi-currency, EU/US number formats). The engine extracts invoice number, reference, order ID, issue date, due date, payment date, renewal date, refund date and status, merchant, direction and source email ID. Unknown fields stay `null`.
* **Languages:** EN, CS, DE, ES, FR. Matching uses Unicode-aware word boundaries.
* **Ledger:**
  * Stable keys: `inv:merchant:number`, `sub:`, `ord:`, `ref:`, else `mail:id`. Rebuilding the ledger is idempotent and merges with prior syncs, so there are no duplicates across syncs.
  * Invoice↔payment, purchase↔receipt, refund↔purchase and subscription↔renewal are linked **only on identifiers**.
  * A link on amount + merchant + time alone is accepted only when it is unique in both directions. Even then it only sets *possibly paid* and moves the bill to *Needs review*. It never auto-closes the bill.
* **Storage:** the ledger is stored compactly per account in `localStorage` (`daylight-finance-ledger:<account>`), with corrections in `daylight-finance-corrections` and confirmed reminders in `daylight-finance-confirmed`. Nothing is stored in preview/demo mode.

## 4. Tests run (this session, all pass)

| Suite | Data | Result |
|---|---|---|
| `tests/finance-intel-suite.js` — main set | 58 synthetic emails (13 categories, 51 negatives for payment tasks, CS/DE/ES/FR, 4 look-alikes of real mail) | 58/58, 13/13 sequence checks (linking, dedupe across syncs, corrections), acceptance PASS |
| same — hold-out 1 | 30 cases written **before** tuning | blind first run 21/30 (saved: `finance-holdout1-blind-result.json`); now 28/30 |
| same — hold-out 2 | 20 cases written after round 1, **before** tuning | blind first run 11/20 (saved: `finance-holdout2-blind-result.json`); now 20/20 |
| Real mailbox sample v1 | 81 real messages from your inbox, read in the browser pane, **labels by Claude, not by you** | 15-class accuracy 0.765 (0.90 if promo vs not-financial merged); 0 obligations, 0 suggestions predicted — correct, since the sample had no genuine unpaid bill |
| **`tests/phase2-finance-e2e.js` (new)** | Real app in Chromium, Google mocked with the 58 fixtures + 3 legacy tasks + 1 user task | **22/22** |
| `phase1-browser-e2e.js` | real app, mocked Gmail failure modes | 22/22 |
| `gmail-sync-sim.js` | Phase 1 sync engine | 69/69 |
| `phase1-sw-check.js` | service worker `daylight-v89`, offline reload | pass |
| `oauth-scope-check`, `ai-email-suite`, `phase13-data`, `phase14-travel-identity`, `phase11-e2e` | existing regressions | all pass (26/26, 22/22, 100%/100%, phase11 pass) |

The **Phase 2 E2E** checks:
* no automatic task (4 → 4);
* *To pay now* and *Upcoming* equal the engine's ledger on exactly the mail the app fetched (50 of 58; the app's normal mail window);
* no negative-set email is a payment to make;
* every bill to pay has a written due date;
* direct debits and processing payments get no reminder;
* refunds only under Refunded;
* paid invoice merged with its earlier unpaid invoice;
* 3 legacy tasks flagged;
* Home briefing counts only real payments;
* a correction persists after reload;
* a dismissal persists after reload;
* confirming a reminder twice creates exactly one task;
* repeated refreshes leave the record count unchanged;
* mobile inbox has no receipt or refund tagged Due/Overdue/Pending;
* demo mode stores no ledger and no tasks;
* 0 page errors.

### Bug found and fixed by the E2E
The Home briefing still read: *"3 things asking for you today — starting with Pay Anthropic, PBC · $11.80 … 6 pending payments from Studio Pixel."* The overdue legacy auto task led the briefing, and "pending payments" counted bills due weeks later.
* **Fix:** legacy auto tasks no longer feed loops, the pending list or the briefing. The briefing now says *"2 payments to make this week — next: Studio Pixel, 4 later. 11 money emails need a quick check."*

## 5. Acceptance criteria

| Criterion | Evidence | Result |
|---|---|---|
| Zero fabricated tasks in the negative set | 51 negatives in the main set, 0 suggestions in the hold-out blind runs, 0 on real mail, E2E task count unchanged | PASS |
| No receipt / paid invoice as outstanding | suite acceptance + E2E check | PASS |
| No refund as owed | suite + E2E (Refunded only) | PASS |
| No invented due date | `inventedDueDates: []`; E2E: every bill to pay has `dueDateRaw` from the email | PASS |
| No duplicates across syncs | sequence checks + E2E repeated refresh + reload | PASS |
| Invoice↔payment linked correctly | sequences A–H (ID links; amount-only links → review, never auto-paid) | PASS (synthetic) |
| Ambiguous mail → review | `ambiguousFlagged: []` misses; E2E *Needs review* populated | PASS |
| No regressions | all suites in §4 | PASS |

## 6. Accuracy per category

n = expected cases, P = precision, R = recall. "–" means not present or not computable. Main-set numbers are on **seen** data. The hold-out columns are the **blind first runs before any fix**, which is the honest estimate for unseen mail. The real-mail labels are Claude's, not yours.

| Category | Main set (n, P, R) | Hold-out 1 blind (n, P, R) | Hold-out 2 blind (n, P, R) | Real mail v1 (n, P, R) |
|---|---|---|---|---|
| unpaid_bill | 11, 1.00, 1.00 | 6, 1.00, 0.33 | 5, 1.00, 0.60 | – |
| paid_invoice | 4, 1.00, 1.00 | 1, 0.00, 0.00 | 1, 1.00, 1.00 | – |
| payment_pending | 2, 1.00, 1.00 | – | 1, –, 0.00 | 1, –, 0.00 |
| payment_successful | 3, 1.00, 1.00 | 1, 0.50, 1.00 | – | – |
| payment_failed | 3, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| refund_received | 2, 1.00, 1.00 | 1, –, 0.00 | 1, –, 0.00 | – |
| refund_pending | 2, 1.00, 1.00 | 4, 1.00, 0.75 | 1, 0.00, 0.00 | – |
| incoming_money | 4, 1.00, 1.00 | 3, 1.00, 1.00 | 1, 0.00, 0.00 | 0, 0.00, – |
| outgoing_payment | 1, 1.00, 1.00 | 1, 0.00, 0.00 | 1, 1.00, 1.00 | 1, 1.00, 1.00 |
| subscription_renewal | 4, 1.00, 1.00 | 2, 1.00, 1.00 | 2, 1.00, 0.50 | 1, 1.00, 1.00 |
| purchase_receipt | 4, 1.00, 1.00 | 3, 0.75, 1.00 | 2, 1.00, 0.50 | 4, 0.40, 1.00 |
| promotional_offer | 7, 1.00, 1.00 | 5, 1.00, 1.00 | 2, 1.00, 1.00 | 25, 0.69, 1.00 |
| bank_transaction | 2, 1.00, 1.00 | – | 1, –, 0.00 | – |
| financial_statement | 1, 1.00, 1.00 | 1, 1.00, 1.00 | 0, 0.00, – | 1, 1.00, 1.00 |
| not_financial | 8, 1.00, 1.00 | 1, 0.20, 1.00 | 1, 0.14, 1.00 | 47, 0.97, 0.62 |


**Main set** (rows = expected, columns = predicted; only non-empty categories)

| exp \\ pred | unpaid bill | paid invoice | payment pending | payment successful | payment failed | refund received | refund pending | incoming money | outgoing payment | subscription renewal | purchase receipt | promotional offer | bank transaction | financial statement | not financial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| unpaid bill | 11 | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| paid invoice | · | 4 | · | · | · | · | · | · | · | · | · | · | · | · | · |
| payment pending | · | · | 2 | · | · | · | · | · | · | · | · | · | · | · | · |
| payment successful | · | · | · | 3 | · | · | · | · | · | · | · | · | · | · | · |
| payment failed | · | · | · | · | 3 | · | · | · | · | · | · | · | · | · | · |
| refund received | · | · | · | · | · | 2 | · | · | · | · | · | · | · | · | · |
| refund pending | · | · | · | · | · | · | 2 | · | · | · | · | · | · | · | · |
| incoming money | · | · | · | · | · | · | · | 4 | · | · | · | · | · | · | · |
| outgoing payment | · | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · |
| subscription renewal | · | · | · | · | · | · | · | · | · | 4 | · | · | · | · | · |
| purchase receipt | · | · | · | · | · | · | · | · | · | · | 4 | · | · | · | · |
| promotional offer | · | · | · | · | · | · | · | · | · | · | · | 7 | · | · | · |
| bank transaction | · | · | · | · | · | · | · | · | · | · | · | · | 2 | · | · |
| financial statement | · | · | · | · | · | · | · | · | · | · | · | · | · | 1 | · |
| not financial | · | · | · | · | · | · | · | · | · | · | · | · | · | · | 8 |


**Hold-out 1, blind first run** (rows = expected, columns = predicted; only non-empty categories)

| exp \\ pred | unpaid bill | paid invoice | payment successful | payment failed | refund received | refund pending | incoming money | outgoing payment | subscription renewal | purchase receipt | promotional offer | financial statement | not financial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| unpaid bill | 2 | 1 | · | · | · | · | · | 1 | · | · | · | · | 2 |
| paid invoice | · | · | 1 | · | · | · | · | · | · | · | · | · | · |
| payment successful | · | · | 1 | · | · | · | · | · | · | · | · | · | · |
| payment failed | · | · | · | 1 | · | · | · | · | · | · | · | · | · |
| refund received | · | · | · | · | · | · | · | · | · | · | · | · | 1 |
| refund pending | · | · | · | · | · | 3 | · | · | · | · | · | · | 1 |
| incoming money | · | · | · | · | · | · | 3 | · | · | · | · | · | · |
| outgoing payment | · | · | · | · | · | · | · | · | · | 1 | · | · | · |
| subscription renewal | · | · | · | · | · | · | · | · | 2 | · | · | · | · |
| purchase receipt | · | · | · | · | · | · | · | · | · | 3 | · | · | · |
| promotional offer | · | · | · | · | · | · | · | · | · | · | 5 | · | · |
| financial statement | · | · | · | · | · | · | · | · | · | · | · | 1 | · |
| not financial | · | · | · | · | · | · | · | · | · | · | · | · | 1 |


**Hold-out 2, blind first run** (rows = expected, columns = predicted; only non-empty categories)

| exp \\ pred | unpaid bill | paid invoice | payment pending | payment failed | refund received | refund pending | incoming money | outgoing payment | subscription renewal | purchase receipt | promotional offer | bank transaction | not financial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| unpaid bill | 3 | · | · | · | · | · | · | · | · | · | · | · | 1 |
| paid invoice | · | 1 | · | · | · | · | · | · | · | · | · | · | · |
| payment pending | · | · | · | · | · | · | · | · | · | · | · | · | 1 |
| payment failed | · | · | · | 1 | · | · | · | · | · | · | · | · | · |
| refund received | · | · | · | · | · | 1 | · | · | · | · | · | · | · |
| refund pending | · | · | · | · | · | · | 1 | · | · | · | · | · | · |
| incoming money | · | · | · | · | · | · | · | · | · | · | · | · | 1 |
| outgoing payment | · | · | · | · | · | · | · | 1 | · | · | · | · | · |
| subscription renewal | · | · | · | · | · | · | · | · | 1 | · | · | · | 1 |
| purchase receipt | · | · | · | · | · | · | · | · | · | 1 | · | · | 1 |
| promotional offer | · | · | · | · | · | · | · | · | · | · | 2 | · | · |
| bank transaction | · | · | · | · | · | · | · | · | · | · | · | · | 1 |
| not financial | · | · | · | · | · | · | · | · | · | · | · | · | 1 |


**Real mailbox sample v1 (81 messages, labels by Claude)** (rows = expected, columns = predicted; only non-empty categories)

| exp \\ pred | financial statement | not financial | promotional offer | payment pending | purchase receipt | payment failed | outgoing payment | subscription renewal | incoming money |
|---|---|---|---|---|---|---|---|---|---|
| financial statement | 1 | · | · | · | · | · | · | · | · |
| not financial | · | 29 | 11 | · | 6 | · | · | · | 1 |
| promotional offer | · | · | 25 | · | · | · | · | · | · |
| payment pending | · | 1 | · | · | · | · | · | · | · |
| purchase receipt | · | · | · | · | 4 | · | · | · | · |
| payment failed | · | · | · | · | · | 1 | · | · | · |
| outgoing payment | · | · | · | · | · | · | 1 | · | · |
| subscription renewal | · | · | · | · | · | · | · | 1 | · |
| incoming money | · | · | · | · | · | · | · | · | · |


### What the blind runs show
* **Errors were conservative.** Of the 6 real bills missed across both blind runs, 5 fell to `not_financial`/`statement`/`outgoing payment`, so Daylight would have stayed silent rather than invent a payment. One Stripe "your invoice is ready" mail (status unclear) was called a paid invoice. That kind of case now goes to *Needs review*.
* Every blind miss was then fixed and is kept as a regression case. Hold-out 1 still has 2 intended misses:
  * a day+month-only due date gets no reminder by design;
  * a PayPal "you sent" email is classified as a receipt (harmless: Paid).
* **Real mail v1.** Most errors were non-money marketing called *promotional offer*, plus work travel-order threads called receipts. Both were fixed, but **v2 has not been re-measured on real mail.**

## 7. Known limitations / risks

1. Rule-based. New senders, wording or languages beyond EN/CS/DE/ES/FR will mostly land in *Not financial* or *Needs review*. That is safe, but recall is limited (blind recall on unpaid bills: 0.33 and 0.60).
2. Only the mail inside Daylight's normal fetch window is checked. Older bills are seen only if they were in an earlier sync.
3. The ledger lives in this browser's `localStorage` per account. It does not sync between devices, and clearing site data resets corrections.
4. Not verified on a real unpaid bill or a real invoice→payment pair from your inbox.
5. Phase 1 carry-over: a worker 502 still clears the session (planned for Phase 4), and the mail cache is memory-only.

## 8. Proposed cleanup plan — NEEDS YOUR APPROVAL (nothing has been deleted or reclassified)

| Item | Where | Proposal |
|---|---|---|
| 13 "Pay …" tasks auto-created by the old version (receipts, refunds, promos among them) | your Daylight task list (`daylight-personal-tasks`, `suggested:true, project:'Payments'`) | **A (recommended):** keep them. Add per-item *Keep as reminder* / *Remove* buttons in the Money sheet so you decide one by one. **B:** after you review the list, delete the ones you name. No bulk delete. |
| Old `bill:*` / `payment:*` / `subscription:*` entities from email-classify | IndexedDB `daylight-store` | Keep. The app already ignores them when a finance ledger exists. Optional purge only on approval. |
| `daylight-pay-suggested` key | localStorage | Unused since Phase 2. Remove on approval (contains only email IDs). |
| `daylight-pay-amounts` key | localStorage | Still used for amount-change notices. Keep. |

## 9. Files changed (not committed)

* `finance-intel.js` (new)
* `app.js` (finance integration, Money sheet, briefing/loop fixes)
* `daylight-data.js` (inbox bucket from finance)
* `index.html` (scripts, `app.js?v=103`, Money drawer button)
* `sw.js` (`daylight-v89`, shell includes `finance-intel.js`)
* `tests/finance-intel-suite.js`, `tests/phase2-finance-e2e.js` (new), `tests/phase1-sw-check.js`
* reports: `finance-intel-report.json`, `finance-holdout1/2-blind-result.json`, `finance-real-mail-eval-v1.json`, `phase2-finance-e2e-report.json`, `phase1-sw-check-report.json`, `PHASE1_FINAL_VERIFICATION.md`, this file

No OAuth scope changes, no emails sent, no production data changed. `.env` was never read or staged.

## 10. Next

* **Deploy** to GitHub Pages: needs your approval. That means `git add` of the files above, a commit and a push to the Pages branch.
* After the deploy: a re-check on your real inbox (v2 real-mail measurement + your review of the 13 legacy tasks).
* Then Phase 3, on your approval.
