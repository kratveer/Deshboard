# Daylight audit — Home (Daily Brief, Today's Schedule, Priority Actions), Inbox, Wallet, Timeline

Date: 4 Nov 2026 · **Synthetic data only.** No code was changed and nothing was committed, pushed or deployed. Your real account was not touched.

## How it was tested

* **Build tested:** the current local build in your Daylight folder (Phase 1 + Phase 2 + Gmail v2, **not deployed**). The live site runs an older version, so it will differ in places.
* **Harness:** `tests/home-audit-e2e.js` runs the real app in Chromium with Google mocked, then reads what is actually on screen.
* **The test day:** `tests/home-audit-scenario.js` defines one realistic day with ground truth. The clock is fixed at Wed 4 Nov 2026 09:15, Europe/Prague, mobile 390 px and desktop 1440 px.
  * **Calendar:** 16 events on the primary calendar plus 1 on a second ("Family") calendar. Cases covered: overlaps, an event in the India time zone, a declined event, a cancelled event, an event carried over from the night before, a flight crossing midnight, multi-day and single-day all-day events, and tomorrow's events.
  * **Tasks:** 11 Google Tasks (overdue, due today, due tomorrow, undated, completed) and 2 Daylight tasks.
  * **Gmail:** 30 emails — bills, receipts, a refund, promotions, newsletters, security and automated mail, people waiting for a reply, a deadline that exists only in an email, a flight booking with boarding pass, hotel booking then cancellation, restaurant, train, a flight schedule change, concert e-tickets — plus 1 sent email.
* **Settings:** AI was **off**, which is the default, and the Gmail sync ran 3 times.
* Raw on-screen capture: `tests/home-audit-raw.json`.

Severity: **S1** = shows wrong or missing information the user relies on · **S2** = misleading or noisy · **S3** = polish.

---

## 1. Today's Schedule (Home, mobile) and the desktop Calendar widget / timeline

**Expected:** 13 timed events (12 on the primary calendar + 1 on the Family calendar) and 2 all-day events, without the declined "Vendor demo".

| | Result |
|---|---|
| Timed events shown | **7 of 13 correct** (54 %) |
| Missing | Dentist, Seminar, Parents' evening, Yoga, Taxi to airport, **Flight to Dublin** |
| False positive | Vendor demo (you **declined** it) |
| All-day events | 2/2 correct; tomorrow's all-day event correctly not shown |
| Times / time zone | correct (India-time call shown at 11:00); flight not shown at all |
| Changed / cancelled event | correct after a refresh (Dentist moved to 16:00, lunch removed) |
| Traceability | **none**: schedule rows and desktop calendar rows have no link to the Calendar event |

**Errors and root causes:**
* **S1 · 12-event cap on today's calendar fetch.** `loadCalendar` requests `maxResults=12` with no paging, so a busy day is cut off. Here the four latest events (Seminar, Yoga, Taxi, Flight) disappeared.
* **S1 · Primary calendar only.** Home and the desktop widget never read your other calendars, so "Parents' evening" (Family calendar) is missing. Timeline does read every calendar, so the two views disagree.
* **S1 · The Home list shows only the first 8 events.** It still says "You have 9 events today", so the Dentist was counted but not listed.
* **S1 · Desktop "Quiet window for focus 15:45–20:00" is false.** Seminar, Parents' evening and Yoga fall in that window, but they were cut off by the 12-event cap.
* **S2 · Declined events are shown and counted.** Responses of "declined" are not filtered.
* **S3 · An event that ran overnight into today** ("Night observation run", 22:00–01:00) shows on desktop and Timeline but not on mobile Home.

## 2. Daily Brief (mobile Home card and desktop "Daily briefing")

**What it said:**
* Mobile: "7 tasks · 3 payments · 11 events… two payments and four tasks are overdue… starting at 00:00".
* Desktop: "4 things asking for you today — starting with Renew passport photos… 3 payments to make… 8 trips on the radar… quiet window 15:45–20:00".

**Expected:**
* 6 actions: Submit TBZ SI revisions, Prepare seminar slides, the Organic Letters revision deadline, and replies to Prof. Novák and Li Wei, plus 2 overdue tasks.
* 3 payments: ČEZ due today, Studio Pixel overdue, and the rent due today, which arrived as both a task and an email.
* 15 events.

| Bucket | Correct | Missing | False / duplicate |
|---|---|---|---|
| To do (7 shown) | 4 unique real items | **Submit TBZ SI revisions**, **Organic Letters revision due today**, reply to Prof. Novák, reply to Li Wei | each overdue task counted twice (once as a task, once as "Reschedule: …"), Prepare seminar slides counted twice, "Reply to Substack AI Weekly" (a newsletter) |
| Payments (3 shown) | ČEZ, Studio Pixel | **Rent 18,500 Kč due today** (from the task and from the email) | **"Renew passport photos" counted as an overdue payment** |
| Events (11 shown) | 9 | 6 events missing (see §1) | declined event; "starting at 00:00" (an all-day event treated as midnight) |

**Errors and root causes:**
* **S1 · Only 8 Google Tasks are kept** (`loadTasks … .slice(0,8)`, and lists are read in their own order). Tasks further down the list, including two due today, are dropped. They are also missing from Timeline and Priority Actions.
* **S1 · False payment reminder.** Any task whose title matches the money keywords (here "*Renew*" in "Renew passport photos") becomes a payment obligation. It is also listed in Inbox › Needs Attention as "Due soon".
* **S1 · Missed rent due date.** The email says "prosím zaplať do 4. 11. 2026" ("please pay by 4 Nov 2026"). The finance engine does not recognise "zaplať do" or "do <date>" as a due date, so the rent sat in *Needs review* with "no due date in the email" and never reached the brief.
* **S1 · Deadlines that exist only in an email are never detected.** Deadline items come only from calendar titles and tasks, so the journal's "revision due 4 Nov 2026 23:59" never appears.
* **S2 · Duplicates.** Each overdue or due-today task is counted twice, because both the task list and the loop engine feed the brief.
* **S2 · Newsletters are treated as people waiting for a reply.** The automated-sender filter misses addresses like `aiweekly@substack.com`. Replies younger than 2 hours (Prof. Novák, 08:10) are not counted, and replies from yesterday (Li Wei) are excluded from "today".
* **S2 · "Starting at 00:00"** appears whenever there is an all-day event. **"8 trips on the radar"** is inflated by the Wallet false positives (§5).
* **S3 · Not traceable from the card.** The mobile brief card shows only a summary and counts. The per-item list, with links, lives in a pop-up (`openBriefPop`) that **nothing in the app opens**.

## 3. Priority Actions (mobile Home)

**Expected:**
* Must appear: Prof. Novák (once), the Organic Letters deadline, today's flight / boarding pass, ČEZ due today, Studio Pixel overdue.
* Should appear: Li Wei (waiting since yesterday), rent due today, the recruiter.

| | Result |
|---|---|
| Entries shown | **21** (6 on Home + "See All"); about 6 expected |
| Must-have items found | 4 of 5 — **Organic Letters deadline missing** |
| Should-have items found | 1 of 3 (recruiter) — Li Wei and rent missing |
| Irrelevant entries | Black Friday promotion, "Arriving today" parcel, newsletter (×3), LinkedIn invitation, refund, Alza receipt (×2), "Reply to Ryanair" for a boarding pass |
| Duplicates | Prof. Novák thread ×4, boarding pass ×3, newsletter ×3, receipt ×2, parcel ×2, recruiter ×2 |
| Relevant share | **about 25 %** (5 relevant unique items in 21 entries) |
| Order | by time received, so ČEZ (due **today**) is last. Needs attention is not first. |
| Traceability | good: every entry opens the email with "Open in Gmail" |

**Errors and root causes:**
* **S1 · The "important email today" rule promotes promotions, receipts and deliveries.** It excludes the categories `promotions` and `newsletters`, but the email classifier never produces those category names. It only produces `subscription / payment / bill / ticket / shopping / other`, so promotions classified as `shopping` pass straight through.
* **S1 · Three overlapping sources with no shared de-duplication.** Loops, classified mail and raw unread mail all add entries, each with its own id prefix (`reply:`, `prio:`, `inbox-prio:`). Duplicates are not grouped by thread.
* **S1 · Missing items:** the email-only deadline (same root cause as §2), yesterday's unanswered personal mail, and the rent (missed due date).
* **S2 · Any unread email from a non-automated sender becomes "Reply to …"**, including a boarding-pass email.

## 4. Inbox (mobile)

| | Result |
|---|---|
| Received emails shown | **27 of 27** (none missing) |
| False items | sent email "Me — Question about the apartment" (shown as a Ticket); task "Renew passport photos" (shown as a bill "Due soon") |
| Duplicates across 3 syncs | none (29 cards before and after) |
| Category accuracy (16 labelled emails) | **14/16** — RegioJet train ticket → Important; Netflix renewal → Important, so the **Subscriptions tab is empty** |
| Promotions | 3/3 only in the Promotions tab ✔ |
| Unread status | **not shown** on any card (18 unread emails) |
| Search | **none** |
| Threading | one card per message; the 2 Prof. Novák messages and the 2 Eurowings messages share the same card id, so **tapping the second card opens the first** |
| Sender / snippet | correct display name and snippet |
| Order | "Needs Attention" also contains a newsletter and a LinkedIn invitation, marked "Needs review". "This Week" lists bookings received in October. |
| Traceability | "Open in Gmail" in the detail sheet ✔ |

**Root causes:**
* **S1 · Sent mail leaks into Inbox and Wallet.** The v2 30-day backfill lists all mail, and the category pools do not exclude `SENT`.
* **S1 · Money-keyword tasks are mixed into Inbox** (same root cause as the false payment).
* **S2 · Thread grouping and card ids.** Card ids are thread ids, but each message is its own card.
* **S2 · No unread indicator and no search.**
* **S2 · Bulk mail flagged for review.** Newsletters and social notifications become "Needs review" because they fall through every rule.

## 5. Wallet

**Expected:**
* 5 genuine items: Ryanair flight ABC12D today 21:40 (booking + boarding pass = one item), restaurant Field 21 Nov 19:30, RegioJet train 16 Nov 07:05, Eurowings EWQ7Z1 3 Dec **11:40** (after the schedule change), concert e-tickets 28 Nov 19:30.
* The Lisbon hotel must show as cancelled.

| | Result |
|---|---|
| Genuine items present | 4 of 5 — **train ticket missing** |
| Correct date / time | **0 of 5.** No item has a date. The flight leaving today is not marked as today. |
| Booking references | 3 of 5 correct (ABC12D, 99812, EWQ7Z1); hotel's became **"NUMBER"**; concert's missing |
| Changed booking | the schedule change became a **second Eurowings pass**; the new 11:40 time is not applied |
| Cancelled booking | the hotel is still under **Upcoming** as an active pass, next to a separate "Cancelled" pass |
| Duplicates | Ryanair ×2 (booking + boarding pass), Eurowings ×2 |
| False positives | **Ryanair promotion "Flights from €19.99" as a ticket**, Booking.com "Last-minute deals", the Booking.com refund email, your **sent** email |
| Invented dates | **4**: e.g. "19 Mar 2034" taken from the price "€19.99", "20 Feb 2027" from "€82.00"; destination "YOUR CARD" or "ROME" taken from body text |
| Source links | every pass links to its email ✔ |

**Root causes:**
* **S1 · The Wallet date parser reads prices as dates** (`parseFlexibleDateOrNull`: "19.99" → day 19, month 99). It also does not understand "4 Nov 2026" (day before month) or Czech "16. 11. 2026" (with spaces), so real dates are lost while fake ones are invented.
* **S1 · Wallet ignores structured booking data.** The flight, hotel and restaurant emails contain schema.org booking data that the v2 pipeline already extracts, but Wallet does not use it.
* **S1 · No promotion/newsletter gate before creating passes.** Wallet also has no linking of booking ↔ boarding pass ↔ change ↔ cancellation by booking reference.
* **S2 · Without AI, Wallet details depend on keyword rules**, which produce text like "YOUR CARD" or "coach D".

## 6. Timeline (mobile)

**Today, expected:** 13 events + 2 all-day + 3 tasks (Submit TBZ SI, Pay rent, Prepare seminar slides at 14:00). Email-only items due today (ČEZ bill, Organic Letters deadline) should also appear.

| | Result |
|---|---|
| Calendar events | **13/13** (all calendars, all pages) ✔ — plus the declined Vendor demo ✗ and the overnight run (acceptable) |
| All-day | 2/2 ✔ |
| Tasks | 1 of 3. **Submit TBZ SI and Pay rent are missing** (8-task cap). Prepare seminar slides is shown at **00:00 instead of 14:00**. |
| Emails, bookings and deadlines from Gmail | **none.** Only Wallet passes with a date would appear, and none have a date. |
| Future days (16 Nov train, 21 Nov restaurant, 28 Nov concert, 3 Dec flight) | **empty** on all of them |
| Duplicates | none (flight shown once) |
| Order | all-day first, then chronological. There is no "needs attention first" ordering. |
| Wrong context | 5 meetings show an unrelated "Mail: Position at QuantumTech" or "Mail: Anita wants to connect" |
| Traceability | events link to Calendar ✔; Daylight tasks have no link |

**Root causes:**
* **S1 · Related-mail matching counts *you* as a meeting guest.** Every email addressed to you scores as related to every meeting, so meetings get random emails attached. In a real inbox this will happen on almost every meeting.
* **S1 · Timeline only shows calendar events, tasks and dated Wallet passes.** Bills due, deadlines and replies from Gmail are never placed on it.
* **S2 · Timed tasks are truncated to midnight** (`dueDay()` drops the time).
* **S2 · Declined events are not filtered** (same as §1).

---

## 7. Required fixes (proposed — none applied, awaiting your approval)

| # | Fix | Sections | Sev |
|---|---|---|---|
| F1 | Home and desktop calendar: read **all selected calendars**, page through results (no 12-event cap), share one event source with Timeline, drop **declined** events, show every event (no 8-row cap), and recompute the free window from the full list | Schedule, Brief, Timeline | S1 |
| F2 | Tasks: page through all lists and all tasks, sort by due date, remove the 8-task cap, keep time-of-day for timed tasks | Brief, Priority, Timeline | S1 |
| F3 | Payments: only Phase 2 obligations and tasks **you mark as payments** count; no keyword-matched tasks ("Renew…") | Brief, Inbox, Money | S1 |
| F4 | Finance due dates: add "zaplať do / uhraďte do / do <date> / pay by" patterns. Link the "Pay rent" task with the rent email as one obligation. | Brief, Priority, Money | S1 |
| F5 | Detect deadlines inside emails (due / deadline / "submit by" + an explicit date) and surface them in Brief, Priority and Timeline, with a link to the email | Brief, Priority, Timeline | S1 |
| F6 | Priority Actions: one entry per thread, merging all sources; exclude promotions, newsletters, social, receipts, refunds, deliveries and security mail, using the v2 categories, not the missing category names; widen the automated-sender list; order by **attention first** (overdue → due today → needs reply → travel today → rest), then by time; include unanswered personal mail up to N days old | Priority, Brief | S1 |
| F7 | Brief: remove task/loop double counting; no "00:00" for all-day events; make the per-item list reachable from the card (each row linked to its source) | Brief | S2 |
| F8 | Inbox: exclude `SENT` mail and tasks; group by thread (one card, message count, latest message); show unread; add search; send bulk / unknown-sender mail to "Other" instead of "Needs review"; fix the subscription and train categories | Inbox | S1/S2 |
| F9 | Wallet: build passes from **structured booking data first**, then from fixed date parsing (day-month, Czech format, never prices); gate out promotions, newsletters and refunds; link booking ↔ boarding pass ↔ change ↔ cancellation by booking reference (one pass, latest time, cancelled status) | Wallet, Timeline | S1 |
| F10 | Timeline: add Gmail-sourced dated items (bills due, deadlines, bookings from Wallet), optional "needs attention" ordering, fix the related-mail matcher (ignore yourself as a guest; require a subject or guest match) | Timeline | S1 |
| F11 | Add a calendar link to every schedule row and a task link to Daylight tasks | Schedule, Timeline | S3 |
| F12 | Regression: turn this harness into a pass/fail suite (`tests/home-audit-e2e.js` + scenario) so each fix is measured against the same day | all | — |

Suggested order: F1, F2, F3, F6 and F9 first (largest user-visible errors), then F4, F5, F8, F10, then F7 and F11.

## 8. Read-only real-account validation plan (needs your approval before running)

**Goal:** confirm the synthetic findings on your real Gmail, Calendar and Tasks, and measure real accuracy, **without changing anything**.

1. **Access and safety**
   * Use the existing signed-in session in Claude's browser pane.
   * **No new permissions.** Only the current read scopes are used.
   * Only GET requests to Gmail, Calendar and Tasks. **No** label changes, mark-as-read, sends, task edits, wallet or task creation, or AI calls (AI stays off).
   * The probe runs on `privacy.html`, like the Phase 1 probe, so the dashboard's own sync and storage do not run.
2. **Choice of days:** today plus two busy days you pick (one with travel). Gmail window: the last 30 days.
3. **What the probe reads (read-only, about 3,000–6,000 quota units in total, well under Google's 6,000 units per minute per user limit, spread over time):**
   * Calendar: all your calendars for those days, including declined and cancelled events.
   * Tasks: all lists, including tasks due on those days.
   * Gmail: metadata for the 30-day window, plus full text only for bills, bookings and travel, and deadlines.
4. **Comparison:** the current local build's logic runs on that data in memory, and the probe produces, per section, what Daylight *would* show.
   * You then mark each item ✔/✗ in a checklist. It shows subject, sender and date only, never message bodies.
   * You add anything that is missing, using your Gmail, Calendar and Tasks as the reference.
5. **Measurements**
   * Per section: recall, precision, duplicates and wrong dates/times.
   * Wallet: per-field accuracy (date, time, place, reference).
   * Priority Actions: relevant share.
   * Inbox: missing or duplicated emails against Gmail's own counts.
6. **Data handling**
   * Results are kept in this session only: counts, message ids hashed, and your ✔/✗ marks.
   * Nothing goes to any server, and nothing is written to your accounts or to the Daylight data stores in your browser.
   * The report contains no email bodies.
7. **Stop rule:** the probe stops immediately on any quota error, and a single command clears its temporary memory.

## 9. Limits of this audit

* Synthetic data, one fixed day, English UI, Prague time zone, AI off. With AI on, some Wallet or Inbox details may improve; that was not tested.
* One check is not verified by the test: Timeline after an event change. The harness's day navigation left Timeline on another day. Reading the code, Timeline re-reads all calendars on refresh and drops cancelled events.
* Desktop was checked for the briefing, calendar widget, timeline strip and loops. Other desktop widgets were not audited.
