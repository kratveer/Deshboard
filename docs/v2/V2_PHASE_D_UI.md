# V2 Phase D — the five-tab app (Today · Inbox · Plan · Money · Wallet)

Status: **built and tested on synthetic data with Google mocked. Not yet tried on a real mailbox.** This is a new design rather than a restyle of V1. Every screen reads Item Graph Items through `ui/v2-model.js`, and every tap goes through `applyAction`, so it can be undone. The V1 interface is still available as the **classic view** (`?ui=v1`, or Settings → *Switch to the classic view*); `?ui=v2` switches back.

## Files

| File | What it does |
|---|---|
| `ui/v2-model.js` | Pure view models (no DOM): today, brief, now card, needs-you, inbox groups, people, plan, free gaps, suggested plan, conflicts, money, bill history, wallet/trips, badges, search, local Ask, the AI context filter and the AI citation check. Tested in Node. |
| `ui/v2-app.js` | The app: shell, tabs, sheets, gestures, toast with Undo, quick add, focus, Ask, Settings/Connections/Rules, Privacy Centre, welcome screen, labelled sample mode. |
| `ui/v2.css` | Design tokens (light and dark), phone, tablet (side sheet) and laptop (sidebar) layouts. Respects reduced motion (system setting or the in-app toggle). |
| `ui/v2-sample.js` | Invented data for *Try with sample data*. It lives only in memory and is never saved; a "Sample data — nothing here is real" banner stays visible the whole time. |
| `connectors/local-connector.js` | Brings the Wallet passes and V1 personal tasks on this device into the graph. Tasks created in V2 exist only in the graph. A pass that Daylight saved from a booking email is merged into that booking's Item, so the trip is not shown twice. Passes or tasks that have been removed lose their Items. |
| `actions/apply-action.js` | New `schedule`/`unschedule` actions (a time block in Plan) and `correct_type` with `noRule` (change just this one email). |
| `app.js` | `mountV2UI` bridge: sign-in, sync, sync state, disconnect, delete everything, theme, scanner and the AI relay for Ask. The local import runs after each Gmail ingest. |

## Screens

- **Today**
  - Date header with day switching.
  - Brief: clickable sentences, each built from the Items it counts.
  - Now card for the next 2 hours, with a live countdown.
  - Needs you: ranked list. A bill, deadline or booking is shown instead of the email it came from, with "N related" underneath.
  - Day strip with free gaps (tap a gap to place a task).
  - Start focus: 25/50/90 minutes with a ring timer, and a "while you were focused" summary.
  - Coming up for the next 7 days.
  - Evening wrap after the day ends: *Move all to tomorrow*, with Undo.
  - Empty state: "You're clear".
- **Inbox**
  - Messages, People and Updates tabs; search covers subject, sender, amounts and references; sort by importance or newest.
  - Source chips show only connected sources.
  - Groups: Needs you, Waiting on others, Money, Travel, Documents.
  - Message sheet:
    - summary (what it is, what it asks, by when)
    - fact chips (tap to copy)
    - Reply in Gmail, Done, Snooze, Add to Plan, Not needed, Pin, Open in Gmail
    - Connected items, Notes, Why it's here, and *Not right?*: change the type, by default for every email from that sender (this creates a rule).
  - People:
    - waiting on you, you're waiting on, pinned, people, organisations
    - a person page with Message (opens Gmail), Follow up, Pin and Notes.
  - Updates are grouped by sender, with *Clear all from X* (undoable).
- **Plan**
  - Day, 3 days and Week views, plus Projects (an honest empty state until Notion, GitHub or Todoist are connected).
  - Time grid with a now line, and all-day chips for deadlines.
  - Conflict banner with Resolve: move a task, snooze, or keep both.
  - Tap a slot to add or place a task there.
  - *Not scheduled yet* tray with Place, which suggests free gaps.
  - **Suggest a plan** (rule-based, no AI): fills free gaps, focus hours first. If the day is too full it says so ("6 h of tasks, 3 h free — 2 won't fit"). Accept all or one at a time; Undo available.
- **Money**
  - Month header (due/paid, with other currencies listed separately).
  - Due soon with Mark paid.
  - Bill sheet with reference and history.
  - Subscriptions with *Price went up*, worked out from the receipts' amount facts, and *Remind me before it renews*.
  - Spending by category with soft limits (warning at 80 %).
  - Recent payments.
- **Wallet**
  - Up next.
  - Trips built automatically: bookings within 3 days of each other form one trip, with an itinerary sheet.
  - Events.
  - Documents: expiry warning 90 days ahead, never sent to AI.
  - Coupons, warranties and past items.
  - Add: Scan (reuses the V1 scanner) or type it in.
- **Ask**
  - Answered on the device first: day, tomorrow, bills, subscriptions, waiting, trips, deadlines, deliveries, or search. Every answer lists its source Items.
  - *Ask AI instead* (only when AI is on): sends at most 60 items' titles, dates and amounts; never bodies, identity documents or people. The reply must cite item ids, and any sentence without a real source is dropped.
  - Each AI request is written to the processing log.
- **Settings**
  - Connections grid: Gmail is live; Calendar, Tasks, Contacts, Outlook, Notion, Todoist, GitHub, Slack and Spotify are marked **Planned** and cannot be connected.
  - Gmail page:
    - status and items by kind
    - what Daylight reads
    - write access: Off
    - Disconnect and delete, which names how many items will go.
  - Daily rhythm, Your rules (on/off, delete), Appearance (theme, motion), Privacy Centre, classic view.
- **Privacy Centre**
  - What is stored, by kind.
  - AI processing toggle.
  - *What left your device* log.
  - Export as JSON (a download the user starts).
  - Delete everything: signs out of the server, revokes Google access, wipes all Daylight storage and reloads.

**Gestures:**

- Swipe right: done (dismiss in Updates).
- Swipe left: snooze menu.
- Long swipe left: tomorrow at 09:00.
- Long press: quick menu.
- Tap: the sheet grows out of the card.
- Esc / back: closes the sheet.
- Ctrl/Cmd+K: Ask.

**Removed:** Health.

## Not built, on purpose (needs connectors or write access this release doesn't have)

- Not built because they need other apps:
  - Calendar events on Plan/Today
  - birthdays
  - Spotify in focus
  - projects
  - bank matching
  - cash-flow chart
  - smart replies / AI drafts
- Not built because Gmail is read-only: sending, archiving or labelling in Gmail.
- Not built yet, for other reasons:
  - dragging items onto the timeline (tap to place instead)
  - pinch to zoom
  - the command palette gesture
  - Live Activities and widgets (need the native apps)
- Each of these is labelled in the UI or simply absent; nothing pretends to work.

## Test evidence (2026-11-05)

| Suite | Result |
|---|---|
| `tests/v2-model-unit.js` | 55/55: Today ranking and folding, Now card, cited brief, evening wrap, empty state, inbox groups/updates/search, people and waiting, plan views/tray/suggestion/over-full/conflicts, money totals/due/price rise/categories/history, wallet trips/documents/events, Ask (local, no match, AI context filter, citation check), schedule + undo, snooze/done effects, badges, local connector (import, dedupe, real QR only, identity excluded, done survives re-import, reconcile, V2 tasks kept, pass merged into booking) |
| `tests/v2-ui-e2e.js` (Chromium, mocked Gmail) | 19/19: five tabs and no Health; every card on every tab opens a real graph Item; Today matches the model; Inbox/Updates/People; Money shows bills; Mark paid → done and Undo → open; Snooze; *Not right?* → rule listed in Settings; Connections (only Gmail live); Privacy Centre; Ask with real sources; Quick add → Plan tray; V1 tasks imported; Disconnect → no Gmail Items left; no page errors; classic view still works |
| Regression | v2-graph-unit 45/45, v2-graph-e2e 9/9, v2-disconnect-e2e 13/13, gmail-v2-browser-e2e 19/19, phase1 E2E 22/22, phase2 finance E2E 22/22, gmail-sync-sim 69/69, gmail-v2-unit 39/39, discovery unit 23/23, discovery bench 8/8, ai-email-suite 33/33, mail-dates 12/12, phase13 26/26, phase14 22/22, phase11 lifecycle OK, finance suite 58/58, sw-check OK (`daylight-v97`), oauth-scope-check passed |

The classic-UI browser suites now load `?ui=v1`, because they test V1 screens.

## Known limits

- The view models have only been checked against synthetic fixtures. Ranking and wording need tuning on a real mailbox.
- Real-account performance (graph query on every render) has not been measured with thousands of Items.
- Visual QA: layouts were checked by screenshot at 390 px (light and dark) and 1280 px. There is no device testing yet.
