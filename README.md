# Daylight

Daylight reads your Gmail **read-only** and turns it into one picture of your day: bills and payments, bookings and passes, deadlines and appointments, and people waiting for a reply. Everything Daylight works out stays in your browser on your device.

The app has five tabs — **Today · Inbox · Plan · Money · Wallet** — plus **Ask**, **Settings** (Connections, rules, appearance) and the **Privacy Centre**. On phones and tablets the tabs sit in a floating pill-shaped bar at the bottom; on wide screens they become a sidebar.

## How it works

- **Sign-in** goes through the small Cloudflare Worker in [`server/`](server/README.md). The only Google permission Daylight asks for is reading Gmail (`gmail.readonly`), plus your basic profile. The Worker keeps Google's long-term token encrypted and gives the app short-lived tokens; the app then talks to Gmail directly.
- **Gmail engine** (`gmail-sync.js`, `gmail-pipeline.js`, `gmail-cache.js`, `gmail-rules.js`, `gmail-batch.js`, `sync-scheduler.js`): history-driven discovery, metadata first, bodies only when needed, HTTP batch, a per-account cache in IndexedDB (`daylight-mail`) and a quota ceiling.
- **Item Graph** (`graph/`, `connectors/`, `classification/`, `actions/`): one model of Items (emails, bills, transactions, subscriptions, bookings, deadlines, people, organisations, passes, tasks) in IndexedDB (`daylight-graph`). Your actions (done, snooze, paid) and corrections are kept across syncs.
- **Interface** (`ui/`): `v2-app.js` (the app), `v2-model.js` (what each screen shows), `v2-scan.js` (Wallet scanner), `codes.js` (QR / Code 128 drawn locally — no code value is sent to any service), `code-reader.js` (local QR / Code 128 reader for browsers without BarcodeDetector), `v2-diagnostics.js` (developer diagnostics), `v2.css`.
- **Core** (`app.js`): sign-in, account confirmation, the sync loop and the bridge between the engine and the interface.
- **Accounts**: one Google account is signed in at a time. Data for other accounts on the same device stays hidden and can be deleted from Settings.
- **Privacy**: *Disconnect* revokes Daylight's Google access and deletes that account's Gmail data from the device. *Delete all Daylight data on this device* removes everything, including your own tasks and passes.
- **Optional AI** (off by default) answers *Ask AI* questions through the Worker and logs every request in the Privacy Centre. Email bodies are never sent.
- **Content-Security-Policy** in `index.html` limits the page to the app's own files, Google (sign-in, Gmail, profile picture) and the Worker. If you deploy the Worker under another address, add it to `connect-src`.
- **Fonts**: Inter is served from `ui/fonts` (SIL OFL 1.1, see `ui/fonts/OFL.txt`); no font service is contacted.
- **Privacy policy**: [`privacy.html`](privacy.html).

## Running it locally

Serve this folder over HTTP, for example `python -m http.server 8000`, and open `http://localhost:8000/?v2sample=1` to see the app with sample data (nothing real, nothing stored). Signing in needs the Worker; point the app at it with `localStorage.setItem('daylight-api', '<worker url>')`.

## Tests

Browser tests use Playwright with Google mocked (`tests/mock-gmail.js`), for example `node tests/v2-ui-e2e.js`, `node tests/v2-isolation-e2e.js`, `node tests/gmail-v2-browser-e2e.js`, `node tests/v2-nav-scan-e2e.js`, `node tests/sw-upgrade-e2e.js`. `node tests/privacy-audit-e2e.js` checks privacy.html against real requests and storage; `node tests/site-build-check.js` checks a clean checkout builds and serves the published site. `python3 tests/codes-decode-check.py` and `python3 tests/crosscheck/crosscheck.py` verify drawing and reading of codes against independent libraries (OpenCV, ZXing, ZBar, libqrencode). Unit tests run in Node, for example `node tests/v2-model-unit.js`.

## Deploying

The app is a static site (GitHub Pages). The workflow publishes only the files in `site-files.txt` (not tests, docs or server). Bump the service-worker cache name in `sw.js` and the `?v=` numbers in `index.html` when files change. Deploy the Worker with `npx wrangler deploy` in `server/`. Never commit tokens, secrets or `.env` files.
