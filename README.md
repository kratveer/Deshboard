# Daylight — personal connected dashboard

This personal build reads Google and Microsoft 365 data in the browser after you authorize access. It does not send account data or access tokens to a Daylight backend. Google access tokens are held in memory; Microsoft sign-in uses MSAL's browser session cache. Weather uses browser location permission and Open-Meteo.

## Included live connections

- Google Calendar: today's primary calendar events (read only)
- Gmail: up to six inbox message headers (sender, subject, date, unread status); no email body, send, or delete access
- Google Tasks: open tasks in up to three task lists (read only)
- Outlook Calendar: today's events (read only)
- Outlook Mail: up to eight inbox headers (sender, subject, time, unread status); no email body or sending access
- Microsoft To Do: open tasks from up to three lists (read only)
- Weather: current conditions and today's high/low based on browser location

## Microsoft setup

Register a Microsoft Entra single-page application that accepts work/school and personal Microsoft accounts. Set its redirect URI to `https://kratveer.github.io/Deshboard/` using the **Single-page application** platform. Add only delegated Microsoft Graph permissions `User.Read`, `Mail.ReadBasic`, `Calendars.ReadBasic`, and `Tasks.Read`. Do not create a client secret. Enter the application (client) ID in Daylight's Connections panel. Microsoft will ask the user to sign in and consent before any data loads.

## Google setup

1. In Google Cloud Console, enable Google Calendar API, Gmail API, and Google Tasks API.
2. Configure the OAuth consent screen as **External** and keep it in **Testing** for personal use. Add the Google account you will connect as a test user.
3. Create an OAuth client ID of type **Web application**. Add the exact site origin under Authorized JavaScript origins. For local development use `http://localhost:8000`; for GitHub Pages use `https://YOUR-USERNAME.github.io`.
4. Serve this folder over localhost or HTTPS. For example, from this directory run `python -m http.server 8000`, then visit `http://localhost:8000`.
5. Choose the chain-link button in Daylight, enter the OAuth Client ID, and select **Connect**. Review and approve the read-only scopes.

Google may show an unverified-app warning while the OAuth app is in Testing. Gmail's metadata scope is restricted by Google; public use may require verification and a security review. The personal test setup is not ready for public account connections.

## Deploying to GitHub Pages

Publish these files to a GitHub repository. Register the exact production URI with each provider. Do not commit access tokens or OAuth client secrets. OAuth client IDs are public identifiers; access is controlled by provider consent and registered origins.

## Current boundaries

Samsung Calendar is not connected. If it syncs to the same Google account, those events may already appear through Google Calendar. Apple Reminders need a separate native or supported sync route. Social-media personal notifications are not included because the major platforms generally do not offer a common personal notification feed. The app does not yet support multiple accounts per provider, background sync, or user accounts for a public product.

