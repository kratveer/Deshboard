# Daylight — personal connected dashboard

This first personal build reads live data directly from Google in the browser after you authorize it. It does not send Google data or access tokens to a Daylight backend. Access tokens exist only in the open tab; your OAuth Client ID is saved in this browser's local storage. Weather uses browser location permission and Open-Meteo.

## Included live connections

- Google Calendar: today's primary-calendar events (read only)
- Gmail: up to six inbox message headers (sender, subject, date, unread status); no email body access, send, or delete permission
- Google Tasks: open tasks in up to three task lists (read only)
- Weather: current conditions and today's high/low based on browser location

## Google setup

1. In Google Cloud Console, create a project and enable Google Calendar API, Gmail API, and Google Tasks API.
2. Configure the OAuth consent screen as **External** and keep it in **Testing** for personal use. Add the Google account you will connect as a test user.
3. Create an OAuth client ID of type **Web application**. Add the exact site origin under Authorized JavaScript origins. For local development use `http://localhost:8000`; for GitHub Pages use `https://YOUR-USERNAME.github.io`.
4. Serve this folder over localhost or HTTPS. For example, from this directory run `python -m http.server 8000`, then visit `http://localhost:8000`.
5. Choose the chain-link button in Daylight, enter the OAuth Client ID, and select **Continue to Google**. Review and approve the read-only scopes.

Google may show an unverified-app warning while the OAuth app is in Testing. Continue only if the consent screen shows the Daylight app you configured and the scopes match the list in the dashboard. Gmail's metadata scope is classified as restricted by Google; a public app serving other users may require verification and additional security review. This personal test setup is not ready for public account connections.

## Deploying to GitHub Pages

Publish the contents of this directory to a GitHub repository, then select **Settings → Pages → Build and deployment → GitHub Actions**. The included workflow deploys each push to `main`. Add `https://YOUR-USERNAME.github.io` as an authorized JavaScript origin on the Google OAuth client. Do not commit tokens, private keys, or OAuth client secrets. A Google OAuth Client ID is public by design; access is controlled by Google's consent screen and the registered origins.

## Current boundaries

Samsung Calendar is not connected in this build. If Samsung Calendar is syncing to the same Google account, those events may already appear in Google Calendar. Social-media personal notifications are not included: available social tools generally provide analytics and publishing features, not a unified personal notification feed. The app does not yet support multiple Google accounts, background sync, notifications, or user accounts for a public product.

