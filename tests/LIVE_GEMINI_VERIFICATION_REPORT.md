# LIVE GEMINI VERIFICATION REPORT

**Commit under test:** `8dfa25b` (plus Phase 9 verification fixes)  
**Generated:** see `tests/live-gemini-verify-report.json`  
**Harness:** `node tests/live-gemini-verify.js`  
**Production ready:** **NO**

---

## Executive verdict

The Gemini integration exists in the **repository**, but the **deployed Cloudflare Worker does not serve the new routes yet**. Live `/api/gemini/*` calls against `https://daylight-api.kratveer050.workers.dev` return **HTTP 404**.

No `GEMINI_API_KEY` was available in this environment, so **Section B (actual Gemini API tests) did not run**. Local heuristics and Worker probe results must not be counted as successful Gemini calls.

---

## A. Local heuristic tests

| Metric | Result |
|--------|--------|
| Ran | Yes |
| Fixtures | 10 (Gemini-priority invoice/subscription excluded from A) |
| Passed | **10/10** |
| Full synthetic suite | **33/33** (`tests/ai-email-suite.js`) |

Covered here: Amazon confirm/delivery/delay, flight book/cancel/reschedule, hotel, ambiguous date, non-English, promo-noise.

**Bugs found and fixed during verification**

1. Order ID regex captured the word `confirmed` from “Order confirmed” and missed `#112-…` tokens.  
2. PNR regex treated `confirmation LH400` as a PNR, so booking/cancel keys diverged (`LH400` vs `ABC12X`).

After fix: same Amazon order ID and same flight PNR across lifecycle emails.

---

## B. Actual Gemini API tests

| Metric | Result |
|--------|--------|
| Ran | **NO** |
| Reason | `GEMINI_API_KEY` not set in the verification environment |
| Model intended | `gemini-3.5-flash-lite` (default updated; `gemini-2.5-flash-lite` is restricted for many new projects) |
| Gemini calls | **0** |
| Success / fail | n/a |
| Classification / intent / date / event accuracy | **not measured on live Gemini** |
| Token usage / cost | **n/a** |

To run Section B locally (key never logged):

```powershell
$env:GEMINI_API_KEY="your-key"
$env:GEMINI_MODEL="gemini-3.5-flash-lite"
node tests/live-gemini-verify.js
```

Invoice and subscription fixtures are marked `geminiOnly` and are scored only in Section B.

---

## C. End-to-end Daylight / Worker integration tests

Worker base: `https://daylight-api.kratveer050.workers.dev`

| Check | Result |
|-------|--------|
| `GET /health` | **200** `{"ok":true}` |
| `GET /api/gemini/status` (no auth) | **404** Not found |
| `GET /api/gemini/status` (fake Bearer) | **404** Not found |
| `POST /api/gemini/analyse` (fake Bearer) | **404** Not found |
| Routes deployed | **false** |
| Session auth / rate-limit on live Worker | **cannot verify** (routes absent) |
| `GEMINI_API_KEY` read server-side on live Worker | **cannot verify** (routes absent; secret not confirmed) |
| Consent off blocks `shouldCallGemini` | **pass** |
| Financial opt-in enforced | **pass** (bills blocked unless `daylight-ai-allow-financial=1`) |
| Fallback without server (no fake Gemini success) | **pass** |
| Ambiguous local results set `requires_confirmation` | **pass** |

Frontend wiring (code review / static):

- Consent + enable + financial toggles in Connections UI  
- Enrichment calls Worker only with `serverUrl` + session  
- API errors fall back to rules/heuristics (`fallback-error` / `fallback-no-server`)  
- High-confidence local results still escalate when `requires_confirmation` is true (fix applied this phase)

---

## D. Lifecycle / dedupe (extraction layer)

| Check | Result |
|-------|--------|
| Same Amazon order ID across confirm → delivery → delay | **pass** (after order-id fix) |
| Delivery date changes on delay email | **pass** |
| Same PNR across flight book → cancel | **pass** (after PNR fix) |
| Cancellation intent detected | **pass** |
| Reschedule produces field changes | **pass** |
| Cancellation disables AI reminders for entity | **code fix applied** (needs live UI confirmation after deploy) |
| Wallet / Upcoming E2E with live Gemini | **not verified** (blocked by Worker 404 + no API key) |

Duplicate creation rate at extraction keys: **0** for the Amazon + Lufthansa synthetic chains after fixes.

---

## Performance metrics

| Metric | Value |
|--------|-------|
| Actual Gemini API calls | **0** |
| Successful Gemini requests | **0** |
| Failed Gemini requests | **0** (not attempted) |
| Classification accuracy (live Gemini) | **unverified** |
| Intent accuracy (live Gemini) | **unverified** |
| Date extraction accuracy (live Gemini) | **unverified** |
| Event extraction accuracy (live Gemini) | **unverified** |
| Duplicate creation rate (synthetic keys) | **0** post-fix |
| False reminder rate | **unverified** live; uncertain reminders still require confirmation before create |
| Average processing time (Gemini) | **n/a** |
| Token usage / estimated cost | **n/a** |

---

## Fixes applied (supported by test results only)

1. Escalate to Gemini when local heuristic sets `requires_confirmation`.  
2. Default model → `gemini-3.5-flash-lite`.  
3. Cancellation disables AI-generated reminders for the same `entityKey`.  
4. Correct Amazon order-id and flight PNR extraction (lifecycle dedupe).  
5. Added `tests/live-gemini-verify.js` harness separating A / B / C / D.

---

## Manual steps required before production readiness

1. Paste the real Cloudflare KV namespace id into `server/wrangler.toml` (`SESSIONS`).  
2. Redeploy Worker from `server/` so `/api/gemini/analyse` and `/api/gemini/status` exist.  
3. `npx wrangler secret put GEMINI_API_KEY`  
4. Set var `GEMINI_MODEL=gemini-3.5-flash-lite` (and optional `GEMINI_MAX_PER_HOUR`).  
5. Re-run:

```powershell
$env:GEMINI_API_KEY="…"
node tests/live-gemini-verify.js
```

Expect Section C `routesDeployed: true`, auth **401** without a real session, and Section B scored against live JSON.

6. In the app: Stay signed in → Connections → consent + enable Email Intelligence → sync mail.

Until those complete, **do not claim production readiness**.
