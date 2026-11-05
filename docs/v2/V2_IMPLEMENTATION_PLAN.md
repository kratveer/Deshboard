# Daylight V2 — Implementation Plan

Each phase is small, tested, and keeps existing features working. Nothing is committed, pushed or deployed without approval.

## Phase A — Gmail read-only OAuth, incremental scopes, disconnect-and-delete
- **Changes:** `server/src/worker.js` scopes = Gmail read-only; `add=` incremental consent; app `scopes`; remove `gmail.send`/Drive/Fit/Contacts/Calendar/Tasks from onboarding. Reply → "Open in Gmail". Calendar/Tasks/Birthdays/Drive loaders run only if their scope was granted. Disconnect deletes local Gmail data.
- **Files:** worker.js, app.js, index.html, new `privacy/data-reset.js`.
- **Risks:** an existing session has extra scopes → harmless; loaders gated by granted scopes. The Worker must be redeployed by the user.
- **Acceptance:** sign-in URL contains only Gmail read-only; no `messages/send` call path reachable; disconnect empties `daylight-mail`, graph Gmail Items, Gmail Wallet passes and ledger.

## Phase B — Quota-first Gmail discovery across all categories
- **Changes:** `gmail-pipeline.js` candidate triage (labels + targeted searches + known senders + user-rule senders); no category exclusion; daily recovery net; sent threads only when changed; per-operation transparency. `gmail-config.js` candidate queries.
- **Files:** gmail-pipeline.js, gmail-config.js, tests (bench, unit, E2E), new labelled all-category fixture.
- **Risks:** narrower discovery may miss mail → measured by recall on a labelled set with important mail in every category; the recovery net is the backstop.
- **Acceptance:** important-email recall ≥ old pipeline with exclusion removed; quota units per sync lower than "fetch everything"; Promotions receipts found; report old vs new.

## Phase C — Item Graph, connectors, classifier, corrections, applyAction — **done 2026-11-05** (see `V2_PHASE_C_GRAPH.md`)
- **Changes:** `graph/item-graph.js`, `connectors/connector-registry.js`, `connectors/gmail-connector.js`, `classification/classifier.js`, `classification/user-rules.js`, `actions/apply-action.js`, `privacy/processing-log.js`.
- **Risks:** double bookkeeping during migration → screens move to the graph one by one, old sources remain until each screen is switched.
- **Acceptance:** unit tests for dedupe (same message twice → one Item), multi-source Items, correction → visible rule → applied to next matching mail, action undo.

## Phase D — Five-tab experience — **built 2026-11-05** (see `V2_PHASE_D_UI.md`)
- **Changes:** Today (brief, needs-you, coming up, evening wrap, focus), Inbox (Messages/People/Updates + groups + search/sort/snooze/done, each row with summary, action, deadline, source), Plan (day/week timeline from Gmail deadlines + local tasks, unscheduled tray, projects), Money (month header, due soon, receipts, subscriptions, categories, duplicates, price increases), Wallet (existing stack + trips/events/warranties), Ask Daylight (global, source-linked), Settings + Connections + Privacy Centre. Health removed.
- **Acceptance:** each screen reads graph Items only; no fabricated data; demo only in the labelled sample mode.

## Phase E — Reliability, tests, docs
- Fixtures from all categories, acceptance checklist, regression suites, README + `.env.example`, deploy instructions.

## Phase F — Future connectors (docs only)
- Interface notes for Calendar, Tasks, Contacts, Outlook, Notion, Todoist, GitHub, Slack, Spotify.
