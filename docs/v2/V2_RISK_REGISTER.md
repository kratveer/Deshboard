# Daylight V2 — Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Narrower Gmail discovery misses important mail in Updates/Promotions | Medium | High | Labelled all-category fixture with recall gate; daily recovery search; user rules add senders to discovery | Claude |
| R2 | Google verification: `gmail.readonly` is a restricted scope; unverified apps show a warning and are capped at ~100 users | Certain | Medium | Fine for personal + friends; start verification before a public launch | User |
| R3 | Removing Calendar/Tasks/Contacts scopes hides working features | Certain | Medium | Planned connectors with incremental consent; screens show "Connect Calendar" instead of empty or fake data | Claude |
| R4 | Worker change requires redeploy; old sessions keep old scopes | High | Low | Extra scopes are harmless; loaders gated by granted scope; user re-consents when convenient | User |
| R5 | IndexedDB upgrade breaks existing data | Low | High | Graph uses a new database; existing stores untouched | Claude |
| R6 | app.js changes regress existing gestures/screens | Medium | Medium | Run all regression suites after each increment; screen-by-screen migration | Claude |
| R7 | Prompt injection through email text | Medium | High | Untrusted-data fencing, JSON-only output, no action triggered by AI, facts must cite sources | Claude |
| R8 | Sensitive documents (passport, ID) sent to AI | Low | High | Privacy class `identity` blocks AI; detection keywords; never extracted automatically | Claude |
| R9 | Disconnect leaves data behind | Medium | High | Central `deleteAccountData()` with a test that every store is empty afterwards | Claude |
| R10 | Gmail quota exhaustion during recovery | Low | Medium | Per-minute budget (80% of 6,000), per-sync caps, deferred queues | Claude |
| R11 | Browser storage cleared by the user/OS | Medium | Medium | Next sync rebuilds from Gmail (30-day window); corrections/rules exportable | Claude |
| R12 | Scope creep: spec features that need native apps (widgets, Live Activities, watch, voice, haptics) | Certain | Low | Marked "native later" in the plan; not attempted on web | — |
