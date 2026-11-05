# Daylight V2 — data ownership and deletion

Every piece of data Daylight keeps on a device belongs to exactly one of three owners. Deletion follows ownership.

## 1. Gmail account data (owned by one Gmail account)

Everything Daylight derived from one Gmail account:

- **Item Graph:**
  - Items whose source is that account's Gmail: emails, bills, payments, subscriptions, bookings, deadlines, appointments and deliveries.
  - People and organisations seen in that account's mail. They are keyed **per account**, so two accounts never share a person or organisation Item.
  - Their links.
  - The user's corrections and sender rules for that account.
  - The action history on those Items.
  - Processing-log entries about that account's messages.
- **Mail cache** (`daylight-mail`): that account's message index, facts, checkpoint, sync metrics, AI queue, threads and attachments metadata.
- **Keys ending in `:<account>`:** `daylight-graph-ingest:*`, `daylight-v2-ingest-log`, `daylight-v2-validation`, `daylight-v2-missed`, `daylight-gmail-last-sync`, `daylight-finance-ledger`. The account's name in `daylight-v2-account-names` also belongs here.
- **Wallet passes and suggested tasks that Daylight created from that account's email.** Ownership is decided by checking the pass's or task's `mailId` against that account's mail cache. Tasks you created yourself that link to one of its emails stay, but the link is removed.

**Deleted by:** *Disconnect this account* (signed-in account: also signs out and revokes Google access), or *Gmail accounts on this device → Delete* (an account that is not signed in: local data only — remove its Google access at myaccount.google.com/permissions or by signing in as it and disconnecting). Other accounts are never touched.

## 2. Device data (owned by this device)

- Tasks you typed (V1 personal tasks, V2 quick add, Add to Plan, Follow up).
- Passes and documents you scanned or typed into Wallet.
- Settings: theme, motion, daily rhythm, spending limits, tab.

They are not Gmail data. Any account signed in on the device can see them, and they survive disconnecting any account.

**Deleted by:** *Delete all Daylight data on this device* only.

## 3. Active-session data (owned by whoever is signed in now)

- Credentials: `daylight-session`, `daylight-session-owner`, `daylight-google-scopes`, `daylight-profile`.
- Classic-view caches (`daylight-loops`, `daylight-seen`, `daylight-ai-extractions` …). These were never account-scoped in V1 and always mirror the signed-in account.

**Deleted by:** disconnecting the signed-in account, or *Delete all*. Another account rebuilds the classic caches on its next sync.

## Delete all Daylight data on this device

Signs out at the server, revokes the Google grant, and deletes:

- every `daylight-*` / `dl-*` key
- the `daylight-mail`, `daylight-graph` and `daylight-db` databases
- the offline caches

Then it reloads. Gmail itself is never changed.

## Account switching

A new sign-in (a new server session, or a new Google token in the browser-only mode) hides the previous profile and every account Item **immediately**. Nothing account-specific is shown until Google's userinfo confirms who is signed in. The confirmed owner is stored with a hash of the session (`daylight-session-owner`). The server keeps one record per sign-in. When a browser signs in again, the old record is deleted with `POST /auth/logout?keep_grant=1`. This forgets the stored refresh token but does not revoke Google's grant, which the new sign-in may share. The client only calls it when `/health` advertises `logout_keep_grant`.
