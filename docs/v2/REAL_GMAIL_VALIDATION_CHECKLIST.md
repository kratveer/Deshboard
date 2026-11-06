# Real Gmail validation checklist (Daylight V2)

Record every result as **observed**, with a date. If a step was not done, write NOT RUN; never "passed".

**Where to read numbers:** Settings → Developer → Intelligence Diagnostics (or `…/Deshboard/?diag=1`).

## 0. Before you start

- [ ] Worker redeployed (`npx wrangler deploy` in `server/`). Check that `https://daylight-api.kratveer050.workers.dev/health` shows `"features":["logout_keep_grant"]`.
- [ ] Frontend pushed. On the site, DevTools → Application → Cache Storage shows `daylight-v104`. If an old version sticks, reload twice.
- [ ] `https://kratveer.github.io/Deshboard/?ui=v1` opens the same app (the classic view has been removed), and Settings has no classic-view switch.
- [ ] Google Cloud → OAuth consent screen:
  - [ ] the scopes are exactly `openid`, `email`, `profile` and `gmail.readonly`;
  - [ ] the tester is listed under Test users;
  - [ ] if `ALLOWED_EMAILS` is set on the Worker, it includes the tester.
- [ ] Optional, for a clean cold sync: in a fresh browser profile, open the site and use *Delete all Daylight data on this device* first.

## 1. First connection and cold sync (your account)

- [ ] *Continue with Google*. The consent screen lists only reading email, plus your basic profile. Write down anything else it asks for.
- [ ] While it loads, the screen says "Confirming your account…" and shows no cards.
- [ ] After the ring stops, open Diagnostics and write down:
  - [ ] **Gmail API quota → Cold sync units:** ____
  - [ ] **Last syncs:** discovered / metadata / bodies / skipped: ____
  - [ ] **Gmail category coverage:** per category, discovered / metadata read / skipped / body read
  - [ ] **Errors, retries and unresolved:** failed ____, retries ____, unresolved ____
  - [ ] **Graph ingestion:** first row `full`, emails ____ → items ____
  - [ ] **Provenance:** cards without a graph Item or source = 0? ____
  - [ ] **Extraction:** malformed facts = 0? ____; money emails with no money Item ____; travel emails with no booking ____
  - [ ] **Duplicates:** count ____ (open each one and decide whether it is real)
- [ ] Export the **Full report** and keep it privately.

## 2. Warm sync

- [ ] Wait more than 5 minutes, then pull a sync: Settings → Gmail → *Sync now*.
- [ ] **Warm sync units:** ____ (should be far below the cold number). **Graph ingestion:** an `incremental` row, emails ____.
- [ ] Send yourself a test email with an amount and a due date (e.g. "Invoice 123, 450 CZK, due 20 Nov"). Sync again, and check it appears in Money with the right amount and due date.

## 3. Content checks against Gmail (spend 20–30 minutes)

For each item, search Gmail for the last 30 days and compare with Daylight.

- [ ] **Bills:** every unpaid bill appears in Money → Due soon, with the right amount, currency and due date. Note any missing, wrong or doubled.
- [ ] **Receipts:** a sample of 5 receipts appears in Spending / Recent payments, and none of them is shown as a bill to pay.
- [ ] **Subscriptions:** each recurring charge appears once. "Price went up" is shown only if the price really rose.
- [ ] **Bookings:** every upcoming trip or ticket appears in Wallet with the right date and reference, and is not doubled.
- [ ] **Deadlines and appointments:** each dated request appears in Plan and Today, on the right day.
- [ ] **Personal requests:** people waiting for your reply appear in Needs you and in People → Waiting on you.
- [ ] **Promotions:** none appear in Needs you. Real receipts or bookings that arrived under Promotions are still found.
- [ ] **Diagnostics → Compare with a Gmail search** (each costs about 5–10 units). Run the four suggested searches. For every message marked "Never discovered" or "Skipped" that matters, use *Show sender and subject*, then *Report a missed email*.
- [ ] **Diagnostics → Discovered but skipped:** look at the 20 newest. Write down any that should have been read.

## 4. Classification review and corrections

- [ ] In *Review emails*, label at least 50 recent emails: **Type right / Wrong** and **Matters / Doesn't**.
- [ ] Write down from Diagnostics → *Your review labels*:
  - agreed with the type ____ of ____
  - marked "matters" and shown in Needs you ____ of ____
  - "doesn't matter" but shown ____
  - the confusion pairs
  - This is agreement on your sample, not accuracy.
- [ ] Correct one wrong email with *Not right? → Always for this sender*. The rule appears in Settings → Your rules, and the sender's next email is typed the same way.
- [ ] Turn that rule off and on, then delete it.

## 5. Actions, undo and persistence

- [ ] Mark a bill paid, then Undo; it is back.
- [ ] Mark it paid again, reload the page, then sync. It stays paid.
- [ ] Snooze an item to tomorrow, then reload. It is hidden and comes back on time.
- [ ] Place a task in Plan, then reload. It is still placed.

## 6. Ask

Ask each of the following. Every answer lists sources, and each source opens the right email or item.

- [ ] "What bills do I have to pay?"
- [ ] "What's tomorrow?"
- [ ] "Who is waiting for a reply?"
- [ ] A free-text question about a specific sender.

Optional, only with AI switched on in Privacy:

- [ ] *Ask AI instead*: every sentence shows a source chip.
- [ ] The Privacy Centre log shows the request.

## 7. Disconnect and reconnect

- [ ] Settings → Gmail → *Disconnect this account*. The text names what will be deleted and what is kept.
- [ ] Afterwards:
  - [ ] no Gmail cards;
  - [ ] your own tasks remain;
  - [ ] Diagnostics shows 0 Gmail items.
- [ ] At myaccount.google.com/permissions, Daylight's access is gone.
- [ ] Reconnect. The cold sync runs again; write down its units. Old corrections are gone, because they were deleted.

## 8. Two real accounts in one browser

- [ ] Sign in as account 1 and wait for the sync.
- [ ] Sign in as account 2: Settings → Connections → Gmail → *Sign in with another account*, then pick account 2 in Google's chooser. From the first frame, none of account 1's names, cards, Ask answers or rules are visible.
- [ ] Settings → *Gmail accounts on this device* lists both. Account 1 is marked "hidden while another account is signed in".
- [ ] Switch back the same way: *Sign in with another account*, then pick account 1. Each switch is a new Google sign-in, because only one account is signed in at a time. Account 1's Done / snooze / corrections are intact.
- [ ] Disconnect account 2. Account 1's data is still in the list. Sign in as account 1 and check that it is intact.
- [ ] Optional: *Delete* account 1's data from the list while signed in as account 2. Only account 1's items disappear.

## 9. External tester on a separate device

- [ ] Send `TESTER_GUIDE.md`.
- [ ] Receive their **redacted report** (JSON). Check that it has no subjects or names before reading it.
- [ ] Record from it:
  - cold sync units
  - category coverage
  - extraction problems
  - duplicates
  - agreement on their labels
  - missed reports by kind and sender domain

## 10. After validation

- [ ] Fill sections 4–6 of `V2_REAL_WORLD_VALIDATION.md` with what was observed: numbers, dates, issue list.
- [ ] Rank each new issue by severity: Critical (wrong money or dates, data leak, data loss) > High > Medium > Low.
- [ ] Only then decide on production readiness.
