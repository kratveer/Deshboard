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

The dashboard keeps only a random session ID in local storage. Anyone holding it could get short-lived Google tokens for your account (including Gmail send after you consent) until you choose **Sign out everywhere**, so treat the browsers you sign in on as trusted. After `gmail.send` was added to scopes, redeploy this worker and sign in again so Google issues a refresh token that includes send.
