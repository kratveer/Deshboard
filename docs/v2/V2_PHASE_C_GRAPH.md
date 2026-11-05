# V2 Phase C — Item Graph, connectors, classifier, corrections, applyAction

Status: **implemented and tested in the engine. No UI yet** (that is Phase D). The existing screens still read their current sources. The graph is built alongside them after every Gmail sync, so nothing the user sees changes in this phase.

## What was built

| Module | Global | Purpose |
|---|---|---|
| `graph/item-graph.js` | `DaylightItemGraph` | IndexedDB `daylight-graph` (stores: items, links, rules, actions, log). There is a memory backend for tests. Items use stable ids derived from natural keys. |
| `connectors/connector-registry.js` | `DaylightConnectors` | The connector contract: connect, disconnect, getConnectionStatus, fetchItems, normalise, getCapabilities, getPermissions, sync, validateConnection. Gmail is the only live connector. Calendar, Tasks, Contacts, Outlook, Notion, Todoist, GitHub, Slack and Spotify are registered as **planned** and refuse `connect()` with `not_available`, so they never fake a connection. |
| `connectors/gmail-connector.js` | `DaylightGmailConnector` | Turns the mail cache into the graph. Each email Item gets a sender (org/person) Item, plus derived bill, transaction, subscription, booking, deadline, appointment or delivery Items when the email supports them. Every derived Item cites its source message. |
| `classification/classifier.js` | `DaylightClassifier` | Assigns 18 message types and an importance score/band with reasons. User rules are applied first. Gmail's UNREAD and IMPORTANT labels are ignored. |
| `classification/user-rules.js` | `DaylightUserRules` | Turns a correction into a visible, editable rule, for example "Email from zara.com → Receipt". Freemail senders match on the exact address; everyone else matches on the domain. |
| `actions/apply-action.js` | `DaylightActions` | `applyAction(itemId, kind, payload)` supports done, reopen, dismiss, snooze, pin, unpin, set_priority, add_note and correct_type. Each action is validated, applied locally, recorded with the previous state and can be undone. It rolls back on a storage error. |
| `privacy/processing-log.js` | `DaylightProcessingLog` | Records what was processed or sent and where. It never stores message content (the `what` field is capped at 160 characters). Capped at 500 entries. |

**Message types:** urgent_action, personal, university_work, financial, receipt, invoice, subscription, travel, booking, delivery, documents, appointment, deadline, follow_up, newsletter, social_notification, marketing, automated.

**Item kinds:** email, person, organisation, bill, transaction, subscription, booking, trip, ticket, delivery, deadline, appointment, task, event, project, document, warranty.

## Key rules

- **Dedupe:**
  - An email has the key `gmail:<account>:<messageId>`.
  - A booking has the key `booking:<account>:<REF>`, so several emails about one booking produce one Item.
  - A date has the key `date:<account>:<threadId>:<type>`.
  - Ingesting the same data twice gives an identical graph.
- **Multi-source:**
  - Merging adds sources instead of duplicating Items.
  - `deleteBySource('gmail')` keeps an Item that another source still supports.
  - `removeSourceItem` drops an email that Gmail deleted.
- **User-owned fields survive sync:** status, snoozedUntil, pinned, userCorrections, actionHistory, userPriority, notes, and any classification the user set.
- **Corrections:**
  - A correction re-types that Item and creates one rule.
  - The rule immediately re-types the user's other matching emails, except ones the user set by hand.
  - The rule applies to future mail, so the same question is not asked twice.
  - Undoing the correction removes the rule.
- **Read-only:** every write-back is `local-only` because Gmail is read-only. `pendingWrites()` is empty. Nothing is sent to Google.
- **Identity documents** (passport, ID, visa…) get `aiExclude`, produce no derived Items and are never sent to AI. The AI prompt also fences email text as untrusted data, so instructions inside an email are not followed.
- **Incremental ingest:**
  - App wiring: after `v2GmailSync`, `v2IngestGmail()` ingests only rows whose `lastProcessedAt` is at or after the last ingest's start time (stored in localStorage as `daylight-graph-ingest:<account>`).
  - A timestamp tie is re-read once. This is harmless because ingest is idempotent.
- **Disconnect** deletes the graph's Gmail Items, links, rules and actions, plus the ingest watermark.

## Test evidence (run 2026-11-05, synthetic data, mocked Google)

| Suite | Result |
|---|---|
| `tests/v2-graph-unit.js` | 45/45: dedupe, multi-source, user state survives, links, deleteBySource, classifier, registry, Gmail connector over a real pipeline run, correction → rule → next matching mail, rule disable, actions + undo, snooze wake, processing log |
| `tests/v2-graph-e2e.js` (real app, Chromium) | 9/9: graph stored in IndexedDB; first sync gives 93 Items (42 email, 27 organisation, 5 bill, 4 transaction, 4 booking, 3 appointment, 3 delivery, 2 deadline, 2 person, 1 subscription) and 75 links; only Gmail is live; refresh creates no duplicates; a quiet refresh re-ingests nothing; actions stay local; correction → visible rule; after reload and re-sync the done status, the correction and the rule survive |
| `tests/v2-disconnect-e2e.js` | 13/13, including graph 93 Items / 75 links → 0 |
| Regression | gmail-v2-unit 39/39, v2-discovery-unit 23/23, discovery bench 8/8, gmail-sync-sim 69/69, gmail-v2-browser-e2e 19/19, phase1 E2E 22/22, phase2 finance E2E 22/22, finance suite 58/58, ai-email-suite 33/33, mail-dates 12/12, phase13 26/26, phase14 22/22, phase11 lifecycle OK, sw-check OK (`daylight-v96`), oauth-scope-check passed |

`tests/home-audit-raw.json` was re-recorded. Its Home output is identical before and after Phase C. The difference from the 4 Nov baseline comes from Phase B's all-category discovery: one work email now outranks a GitHub notification.

## Known limits

- No screen reads the graph yet. Corrections and actions can only be made through `window.DaylightV2.actions` until Phase D adds the UI.
- The classifier is rule-based. Its accuracy has been measured on the synthetic fixtures only, not on a real mailbox.
- Trip, ticket, task, event, project, document and warranty Item kinds exist in the schema but are not produced from Gmail yet.
- The graph is on this device only. There is no cross-device sync.
