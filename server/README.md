# Daylight server — stay signed in to Google

Without this server, Google access in the dashboard lasts about an hour. This small Cloudflare Worker keeps you connected:

- You sign in once with **Stay signed in**. Google gives the server a long-term refresh token.
- The server stores it **encrypted** (AES-GCM) in Cloudflare KV. It never reaches the browser.
- The dashboard asks the server for short-lived access tokens and renews them automatically.
- Only the Google accounts in `ALLOWED_EMAILS` and the sites in `ALLOWED_ORIGINS` can use it.
- **Sign out everywhere** revokes Google access and deletes the stored token.

The free Cloudflare Workers plan is enough for personal use.

## 1. Google Cloud setup

In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials, open the **Web application** OAuth client the dashboard already uses:

1. Under **Authorized redirect URIs**, add `https://daylight-api.<your-subdomain>.workers.dev/auth/google/callback` (you get the exact address in step 2; come back and add it).
2. Copy the **Client ID**. Create or copy a **Client secret** — keep it private.
3. OAuth consent screen: while the app's publishing status is **Testing**, Google expires refresh tokens after 7 days, so you would need to sign in again weekly. Choosing **Publish app** (In production) avoids that. For personal use you can stay unverified; Google shows an "unverified app" warning that you can continue past.

## 2. Deploy from the Cloudflare dashboard (no installs)

1. **Workers & Pages → Create → Create Worker.** Name it `daylight-api` and deploy the starter.
2. **Edit code**, replace everything with the contents of [`src/worker.js`](src/worker.js), and **Deploy**. Note the address, e.g. `https://daylight-api.<your-subdomain>.workers.dev`.
3. **Storage & Databases → KV → Create** a namespace named `daylight-sessions`.
4. Back in the Worker: **Settings → Bindings → Add → KV namespace**. Variable name `SESSIONS`, namespace `daylight-sessions`.
5. **Settings → Variables and Secrets**, add:

   | Name | Type | Value |
   |---|---|---|
   | `ALLOWED_ORIGINS` | Text | `https://kratveer.github.io,http://localhost:8000` |
   | `ALLOWED_EMAILS` | Text | your Gmail address (comma separate several) |
   | `GOOGLE_CLIENT_ID` | Text | the OAuth client ID |
   | `GOOGLE_CLIENT_SECRET` | Secret | the OAuth client secret |
   | `TOKEN_KEY` | Secret | 32 random bytes, base64 (below) |

   Generate `TOKEN_KEY` in PowerShell:

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
   ```

   Keep it safe: changing it later signs everyone out.
6. Deploy again, then open `https://daylight-api.<your-subdomain>.workers.dev/health` — it should show `{"ok":true}`.

### Or deploy with Wrangler (needs Node.js 18+)

```
cd server
npx wrangler login
npx wrangler kv namespace create SESSIONS     # paste the id into wrangler.toml
# fill ALLOWED_EMAILS and GOOGLE_CLIENT_ID in wrangler.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_KEY
npx wrangler deploy
```

## 3. Connect the dashboard

Open Daylight → link icon → **Stay signed in (uses your Daylight server)** → enter the server address → **Stay signed in**, and approve on Google's screen. The connections panel then shows **Connected · stays signed in**.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/google/start?return=<dashboard url>` | Starts Google sign-in |
| GET | `/auth/google/callback` | Google returns here; stores the encrypted token |
| POST | `/api/google/token` | Bearer session → short-lived access token |
| POST | `/auth/logout` | Revokes Google access and deletes the session |
| GET | `/health` | Health check |
| POST | `/api/gemini/analyse` | Bearer session → Gemini JSON analysis (requires `GEMINI_API_KEY`) |
| GET | `/api/gemini/status` | Bearer session → whether Gemini is configured |

The dashboard keeps only a random session ID in local storage. Anyone holding it could get short-lived read-only Google tokens for your account until you choose **Sign out everywhere**, so treat the browsers you sign in on as trusted.

## 4. Optional: Gemini Email Intelligence

Email Intelligence is **off until the user consents** in the Connections panel. The browser never receives `GEMINI_API_KEY`.

1. Create an API key at [Google AI Studio](https://aistudio.google.com/apikey).
2. In the Worker: **Settings → Variables and Secrets**:

   | Name | Type | Value |
   |---|---|---|
   | `GEMINI_API_KEY` | Secret | your key |
   | `GEMINI_MODEL` | Text | `gemini-3.5-flash-lite` (or another free-tier model; avoid retired/restricted 2.0/2.5 IDs on new projects) |
   | `GEMINI_MAX_PER_HOUR` | Text | `40` |

3. Redeploy the Worker.
4. In Daylight → Connections → **Email Intelligence** → consent + enable.

Without the key, Daylight still classifies mail with local rules/heuristics and never fails open by dropping messages.

## V2 permissions (Gmail read-only)

Sign-in asks Google for `openid email profile https://www.googleapis.com/auth/gmail.readonly` only. Daylight never asks for send, compose, modify, Drive, Fit, Calendar, Tasks or Contacts at sign-in.

Optional connectors are added one at a time with their own consent screen. `GET /auth/google/start?add=calendar|tasks|contacts` requests that one extra read-only scope with `include_granted_scopes=true` (incremental authorisation).

After updating `src/worker.js`, redeploy the Worker (`npx wrangler deploy`, or paste the file into the Cloudflare editor). Sessions created before the change keep their older, broader grant until the user disconnects or reconnects. Daylight only uses an optional scope when Google reports it as granted.
