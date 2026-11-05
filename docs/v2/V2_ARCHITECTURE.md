# Daylight V2 — Architecture

## Principles

- **Local-first.** The browser fetches from each provider, processes on the device and stores Items in IndexedDB. The server signs in, holds refresh tokens and relays AI calls. It never stores mail content.
- **One Item Graph.** Every screen reads the same Items. A Gmail receipt is one email Item linked to one transaction Item and one merchant entity. It is never copied into each screen.
- **Rules first, AI only when unsure.** Deterministic extraction (amounts, dates, references, schema.org) runs before any model. Every AI fact points to its source Item.
- **Read-only by default.** The first release requests only `gmail.readonly`. Write actions are queued through `applyAction()` but no provider write is enabled.
- **No build step.** Static files on GitHub Pages; each module is a plain script exposing one global, testable under Node.

## Layers

```
Google (Gmail now; Calendar/Tasks/Contacts later, each with its own consent)
   │  fetch directly with a 1-hour access token (from the Worker)
   ▼
connectors/            connector-registry.js (contract + catalogue)
                       gmail-connector.js   (wraps gmail-pipeline → normalised source records)
   ▼
classification/        classifier.js  (17 V2 types, importance score, explanation)
                       user-rules.js  (corrections → visible, editable sender/content rules)
   ▼
graph/                 item-graph.js  (IndexedDB "daylight-graph": items, sources, links, rules, actions, log)
   ▼
intelligence/          brief, ask (retrieval + optional AI with source refs), money engine (finance-intel),
                       travel (wallet identity), dates (mail-dates), dedupe
actions/               apply-action.js (validate → local update → queue write-back → history → undo)
privacy/               processing log (what left the device), delete-all, disconnect-and-delete
   ▼
ui (app.js)            Today · Inbox · Plan · Money · Wallet · Ask · Settings/Connections · Privacy Centre
```

Existing modules stay where they are (repository root) to avoid breaking paths and the service worker. New modules live in the folders above.

## Item model

```js
Item {
  id,                 // 'it_' + stable hash of (type, primary source key)
  type,               // email | transaction | bill | subscription | booking | trip | ticket | delivery |
                      // deadline | task | event | person | organisation | document | warranty
  title, description,
  status,             // open | done | snoozed | dismissed | archived
  priority,           // 0–100 importance score
  createdAt, updatedAt, dueAt,
  sourceApp, sourceAccountId, sourceItemId, sourceUrl,   // primary source
  sources: [{ app, accountId, itemId, url, role }],      // all sources (one logical Item, many refs)
  relatedItemIds: [],
  extractedEntities: { people: [], organisations: [], merchant, references: [] },
  extractedFacts: [{ key, value, sourceItemId, method: 'rule'|'schema'|'ai', confidence }],
  confidence, classification: { type, importance, reasons: [], ruleIds: [] },
  userCorrections: [], actionHistory: []
}
Link { id, from, to, kind }   // email→transaction, transaction→merchant, booking→trip, person→email …
```

**Storage:** IndexedDB database `daylight-graph`, separate from `daylight-db` so the upgrade cannot damage existing account data. Stores: `items` (key `id`, indexes `byType`, `byStatus`, `bySource` = `[sourceApp, sourceItemId]`, `byDue`), `links`, `rules`, `actions`, `log`. Every row carries `accountId`. Clearing an account or a connector deletes by index.

**Dedupe:** the email Item key is `gmail:<accountId>:<messageId>`. Derived Items are keyed by their own natural key (invoice number + merchant, booking reference, etc.), so re-syncing the same message updates rather than duplicates.

## Connector contract

```js
{
  id: 'gmail', name, status: 'live' | 'planned',
  getCapabilities() → { read: ['email'], write: [] },
  getPermissions()  → [{ scope, why }],
  getConnectionStatus() → { connected, account, lastSync, lastError, scopes },
  connect(), disconnect({ deleteData: true }), validateConnection(),
  sync({ trigger }) → { records, report },
  fetchItems(), normalise(record) → { items, links }
}
```

Gmail is live. Google Calendar, Tasks, Contacts, Outlook, Notion, Todoist, GitHub, Slack and Spotify are registered as **planned**: shown in Connections with what they would read, never presented as working.

## Gmail discovery (quota-first)

| Step | Cost | Rule |
|---|---|---|
| `getProfile` | 1 | current historyId |
| `history.list` from the saved historyId | 2/page | IDs + labels of added/deleted/relabelled mail. No `get` yet. |
| Triage by labels | 0 | Primary (no `CATEGORY_*` or `CATEGORY_PERSONAL`) and SENT → candidates. Updates / Promotions / Social / Forums → candidates **only if** matched below. |
| Targeted searches over non-Primary categories since the last sync | 5/page | transactional terms (receipt, invoice, order, booking, ticket, due…) + known transactional sender domains + user-rule senders |
| `messages.get format=metadata` | 20 each | candidates only, never twice (cache) |
| Rules on metadata; body only on signals | 60 each | receipt/booking/deadline signals, capped per sync |
| Daily recovery net | ~5–15 | a broader search over non-Primary categories for the last 3 days catches what the narrow queries missed |
| Expired historyId | bounded | recovery = Primary list + targeted searches over the window. Never a full mailbox download. |

Every operation is counted by kind (`profile`, `history`, `list`, `getMeta`, `getFull`, `threads`) with units. The Connections page shows discovered / metadata fetched / bodies fetched / categories covered / requests / units.

## OAuth (Worker)

- Onboarding requests `openid email profile https://www.googleapis.com/auth/gmail.readonly`.
- `/auth/google/start?add=calendar|tasks|contacts` requests one extra read-only scope with `include_granted_scopes=true` (incremental). It is not used until those connectors go live.
- The state parameter is random, single-use, stored 10 minutes in KV (CSRF). The refresh token is AES-GCM encrypted at rest. `/auth/logout` revokes at Google and deletes the session.
- Disconnect in the app calls logout, then deletes `daylight-mail`, the Gmail Items in `daylight-graph`, the Gmail-derived Wallet passes, the ledger and AI extractions for that account.

## AI

`daylight-ai.js` stays the only caller, through the Worker. Email text is wrapped as quoted, untrusted data with an instruction never to follow it. Outputs are validated JSON whose facts must cite the source Item. Results are cached by body hash. Every AI call is written to the privacy log (what was sent, size, when). Passports, IDs and similar documents are never sent.

## What leaves the device

| To | What |
|---|---|
| Google | Read requests (Gmail now). Nothing is written. |
| Worker | Session id for token refresh; at most 2,000 characters of an email the rules could not classify, for Gemini, within the daily cap. |
| Nowhere | Items, Wallet, ledger, rules, action history, logs. |
