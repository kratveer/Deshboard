# Daylight — personal connected dashboard

This personal build reads connected Google data in the browser after you authorize access. Microsoft 365 connection code is ready but needs an Entra app registration first. Daylight has no backend and does not upload your account data. Google access tokens stay in memory; Microsoft sign-in uses MSAL's browser session cache. Personal tasks and daily notes are saved in this browser's local storage. Weather uses browser location permission and Open-Meteo.

## Included live connections

- Google Calendar: today's primary calendar events (read only)
- Gmail: up to six inbox message headers (sender, subject, date, unread status); no email body, send, or delete access
- Google Tasks: open tasks in up to three task lists (read only)
- Google Drive: names, types and dates of your six most recently viewed files, linking to Drive (no file contents)
- Birthdays: upcoming birthdays (next 60 days) from your Google Contacts (read only)
- Markets: a watchlist of currency pairs (ECB daily reference rates via Frankfurter) and crypto prices (CoinGecko); no account needed, saved in this browser
- Today's timeline and focus suggestions: worked out in the browser from the calendar and tasks already loaded
- Personal tasks: add and complete tasks saved only in this browser
- Daily notes: one note per date saved only in this browser
- Weather: current conditions and today's high/low through Open-Meteo after you grant location access
- Outlook Calendar, Outlook Mail, and Microsoft To Do: available after you register the Microsoft app and connect it

## Microsoft setup

Register a Microsoft Entra single-page application that accepts work/school and personal Microsoft accounts. Set its redirect URI to `https://kratveer.github.io/Deshboard/` using the **Single-page application** platform. Add only delegated Microsoft Graph permissions `User.Read`, `Mail.ReadBasic`, `Calendars.ReadBasic`, and `Tasks.Read`. Do not create a client secret. Enter the application (client) ID in Daylight's Connections panel. Microsoft will ask the user to sign in and consent before any data loads.

## Google setup

1. In Google Cloud Console, enable Google Calendar API, Gmail API, Google Tasks API, Google Drive API, and People API.
2. Configure the OAuth consent screen as **External** and keep it in **Testing** for personal use. Add the Google account you will connect as a test user.
3. Create an OAuth client ID of type **Web application**. Add the exact site origin under Authorized JavaScript origins. For local development use `http://localhost:8000`; for GitHub Pages use `https://YOUR-USERNAME.github.io`.
4. Serve this folder over localhost or HTTPS. For example, from this directory run `python -m http.server 8000`, then visit `http://localhost:8000`.
5. Choose the chain-link button in Daylight, enter the OAuth Client ID, and select **Connect**. Review and approve the read-only scopes.

Google may show an unverified-app warning while the OAuth app is in Testing. Gmail's metadata scope is restricted by Google; public use may require verification and a security review. The personal test setup is not ready for public account connections.

## Deploying to GitHub Pages

Publish these files to a GitHub repository. Register the exact production URI with each provider. Do not commit access tokens or OAuth client secrets. OAuth client IDs are public identifiers; access is controlled by provider consent and registered origins.

## Current boundaries

Samsung Calendar is not connected. If it syncs to the same Google account, those events may already appear through Google Calendar. Apple Mail, Calendar, and Reminders need an Apple supported connection path; the web app does not ask for an Apple password. Social-media personal notifications are not included because there is no common notification API across platforms. The app does not yet support multiple accounts per provider, background sync, or user accounts for a public product.
