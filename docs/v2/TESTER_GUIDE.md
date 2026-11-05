# Daylight V2 — guide for an external tester (about 20 minutes)

Thank you for helping. Daylight reads your Gmail **read-only**: it cannot send, delete or change mail. Everything it finds stays in your browser on your device. What you send back is a small **redacted** report: counts, percentages and sender domains only. It contains no subjects, names, amounts or message text.

## Before you start (for Kratveer)
- While the Google OAuth app is in *Testing* mode, add the tester's Gmail address under **Google Cloud Console → APIs & Services → OAuth consent screen → Test users**. Otherwise Google blocks the sign-in.
- The tester uses their **own device and browser profile**. On a shared device, Daylight hides other accounts' email items. However, tasks and Wallet passes created on that device are visible to everyone who uses it.

## Steps
1. Open https://kratveer.github.io/Deshboard/ and choose **Continue with Google**. Allow the single permission (read Gmail).
2. Wait for the ring at the top right to stop spinning. The first sync can take a minute.
3. Look through the five tabs. Note anything that surprises you: something wrong, missing, duplicated or in the wrong place.
4. Open **profile picture → Settings → Developer → Review emails**. For as many of the newest emails as you like (30 or more is ideal):
   - **Type right** or **Wrong** (and pick the correct type)
   - **Matters** or **Doesn't**: would you want this on your Today screen?
5. If something important is missing entirely, use **Intelligence Diagnostics → Report a missed email**. Choose what it was and enter the sender's domain only.
6. In **Intelligence Diagnostics → Export → Redacted report (for testers)**, a JSON file downloads. Open it if you like and check that it contains no personal content. Then send it to Kratveer.
7. Optional: **Settings → Connections → Gmail → Disconnect and delete**. This revokes access and deletes everything Daylight stored. You can also remove access at https://myaccount.google.com/permissions.

## Also worth trying
- Mark a bill paid, then tap **Undo**.
- Snooze something, then reload the page and check it stays snoozed.
- Ask: "What bills do I have to pay?" and check the sources it lists.
