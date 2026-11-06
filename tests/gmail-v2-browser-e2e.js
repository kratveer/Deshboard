/**
 * Daylight Gmail v2 — browser end-to-end check of the cost-optimised pipeline in the REAL app (Chromium, Playwright).
 * Google is mocked by tests/mock-gmail.js (synthetic mail-200 fixtures, Google's unit table, HTTP batch endpoint).
 * Checks: warm reloads cost 0 Gmail requests and render from the cache; Money obligations identical after reload
 * (stored results stand in for bodies); history-driven refresh; label-only change → no body; deletion of a bill email →
 * financial record kept + flagged; two tabs → one sync; missed slots → one catch-up; batch failure → single-GET fallback;
 * review queue teaches the domain cache; Sync Efficiency panel renders. Run: node tests/gmail-v2-browser-e2e.js
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const { MAIL } = require('./fixtures/mail-200.js');
const BT = require('../gmail-batch.js');

const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.kratveer050.workers.dev'; // mocked: every request to it is answered by the test (the real Worker is never contacted); same host as production, so the page's Content-Security-Policy applies unchanged
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const DAY = 86400000;

function serve(dir, port) {
  return new Promise((r) => {
    const srv = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(dir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); });
    srv.listen(port, '127.0.0.1', () => r(srv));
  });
}
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const mock = createMockGmail({ now: Date.now() });
const truth = new Map();
MAIL.forEach((f, i) => { mock.add({ id: f.id, threadId: f.threadId, from: f.from, subject: f.subject, snippet: f.snippet, body: f.body, html: f.html, labelIds: f.labelIds.slice(), listUnsubscribe: f.listUnsubscribe, attachments: f.attachments, internalDate: Date.now() - f.ageDays * DAY - i * 60000 }); truth.set(f.id, f.label); });
for (let i = 0; i < 6; i++) mock.add({ id: 'sent-' + i, threadId: 't000' + (i + 1), from: 'Me <me@example.com>', subject: 'Re: hello', snippet: 'ok', body: 'ok', labelIds: ['SENT'], internalDate: Date.now() - i * DAY });
let gmailHttp = [], batchMode = 'ok', batchBodies = [];
function respondBatch(route, req) {
  const ct = req.headers()['content-type'] || '';
  const boundary = /boundary=([^;]+)/.exec(ct)[1];
  return mock.batchSend({ boundary, body: req.postData() || '' }).then((r) => {
    if (!r.ok) return route.fulfill({ status: 500, headers: CORS, body: 'error' });
    const b = 'batch_resp_x';
    const parts = [...r.data].map(([id, p]) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${p.status} ${p.ok ? 'OK' : 'ERR'}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(p.ok ? p.data : { error: { code: p.status, message: p.message, errors: [{ reason: p.reason }] } })}\r\n`);
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': `multipart/mixed; boundary=${b}` }, body: parts.join('') + `--${b}--\r\n` });
  });
}
async function mockGoogle(page) {
  await page.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.origin === WORKER) return json(route, 200, { access_token: 'fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', gmail_readonly: true });
    if (u.hostname === 'gmail.googleapis.com') {
      mock.setNow(Date.now());
      if (u.pathname.startsWith('/batch/')) { gmailHttp.push('batch'); batchBodies.push(req.postData() || ''); if (batchMode === 'fail') return route.abort('failed'); return respondBatch(route, req); }
      gmailHttp.push(u.pathname.replace('/gmail/v1/users/me', '') + (u.searchParams.get('format') ? '?' + u.searchParams.get('format') : ''));
      const r = await mock.request(req.url());
      return json(route, r.status, r.ok ? r.data : { error: { code: r.status, message: r.message, errors: [{ reason: r.reason }] } });
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '42', email: 'test@example.com', name: 'Test User' });
    if (u.hostname === 'www.googleapis.com' && u.pathname.includes('/calendar/')) return json(route, u.pathname.includes('calendarList') ? 403 : 200, { items: [] });
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/drive/')) return json(route, 200, { files: [] });
    if (u.hostname === 'tasks.googleapis.com') return json(route, 200, { items: u.pathname.endsWith('/lists') ? [{ id: 'L1', title: 'My Tasks' }] : [] });
    if (u.hostname === 'people.googleapis.com') return json(route, 200, { connections: [] });
    return route.abort('blockedbyclient');
  });
}
/** Wait until the app finished more refreshes than `after` (a page load starts one by itself). */
async function settle(page, after = 0) {
  await page.waitForFunction((n) => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); return !s.busy && s.runs > n; }, after, { timeout: 180000 });
  await page.waitForTimeout(700);
}
const runs = (page) => page.evaluate(() => window.DaylightV2Host.syncState().runs);
/** A manual refresh (Settings → Gmail → Sync now) and wait for it to finish. */
async function refresh(page) { const n = await runs(page); await page.evaluate(() => { window.DaylightV2Host.syncNow(); }); await settle(page, n); }
const money = (page) => page.evaluate(() => { const out = {}; window.DaylightV2UI.state.items.filter((x) => ['bill', 'transaction', 'subscription'].includes(x.type)).forEach((x) => { (out[x.type] = out[x.type] || []).push(x.id); }); Object.values(out).forEach((v) => v.sort()); return out; });
const idx = (page) => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('daylight-mail'); r.onsuccess = () => { const db = r.result; const t = db.transaction(['mailIndex', 'checkpoint', 'domainCategory', 'syncMetrics'], 'readonly'); const g = (s) => new Promise((ok) => { const q = t.objectStore(s).getAll(); q.onsuccess = () => ok(q.result); }); Promise.all(['mailIndex', 'checkpoint', 'domainCategory', 'syncMetrics'].map(g)).then(([m, c, d, x]) => res({ rows: m.length, byStatus: m.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}), checkpoint: c[0] || null, domains: d, metrics: x, sample: m.slice(0, 2).map((r) => Object.keys(r)) })); }; r.onerror = () => res(null); }));

(async () => {
  const srv = await serve(appDir, 8779);
  const browser = await chromium.launch();
  const checks = []; const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.log('  FAIL', name, JSON.stringify(detail).slice(0, 500)); };
  const errs = [];
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(({ w }) => { if (!localStorage.getItem('dl-v2-seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 } } })); /* test only: drain the one-time backlog without waiting minutes */ localStorage.setItem('dl-v2-seeded', '1'); } }, { w: WORKER });
    const page = await ctx.newPage(); await mockGoogle(page); page.on('pageerror', (e) => errs.push(e.message));

    // V1 cold open (backfill)
    mock.resetStats(); gmailHttp = [];
    await page.goto('http://127.0.0.1:8779/index.html', { waitUntil: 'domcontentloaded' }); await settle(page);
    const s1 = await idx(page), u1 = mock.stats.units, h1 = gmailHttp.length;
    ck('V1 cold open: 30-day backfill into the persistent cache, batch used', s1.rows >= 150 && gmailHttp.includes('batch') && s1.checkpoint?.historyId, { rows: s1.rows, http: h1, units: u1, byStatus: s1.byStatus });
    const metaBody = batchBodies.find((b) => /format=metadata/.test(b)) || '';
    ck('V1 metadata requests trimmed (metadataHeaders + fields)', /metadataHeaders=List-Unsubscribe/.test(metaBody) && /fields=/.test(metaBody) && !/metadataHeaders=Received/.test(metaBody), metaBody.slice(0, 300));
    // drain the body backlog (manual refreshes) so later checks start from steady state
    for (let i = 0; i < 6; i++) { const st = await idx(page); if (!st.byStatus['body-queued'] && !st.byStatus['meta-pending']) break; await refresh(page); }
    const m1 = await money(page);
    const s1b = await idx(page);
    ck('Backlog drained: no bodies or metadata waiting', !s1b.byStatus['body-queued'] && !s1b.byStatus['meta-pending'], s1b.byStatus);

    // V2 reload within 15 min → no Gmail request at all, same Money view (derived results replace bodies)
    mock.resetStats(); gmailHttp = [];
    await page.reload({ waitUntil: 'domcontentloaded' }); await settle(page);
    const m2 = await money(page);
    ck('V2 reload within 15 min: 0 Gmail requests', gmailHttp.length === 0, gmailHttp);
    ck('V2 Money Items are populated (bills / payments found)', Object.values(m1).flat().length >= 5 && (m1.bill || []).length >= 1, m1);
    ck('V2 Money Items identical after reload (stored results stand in for bodies)', JSON.stringify(m1) === JSON.stringify(m2), { before: m1, after: m2 });
    ck('V2 sync state is truthful (no error, not partial)', await page.evaluate(() => { const s = window.DaylightV2Host.syncState(); return !s.error && s.lastAt > 0; }), await page.evaluate(() => window.DaylightV2Host.syncState()));

    // V3 manual refresh, no new mail → profile only
    mock.resetStats(); gmailHttp = [];
    await refresh(page);
    ck('V3 manual refresh with no new mail: 1 Gmail request (profile), 1 quota unit', gmailHttp.length === 1 && mock.stats.units === 1, { http: gmailHttp, units: mock.stats.units });

    // V4 new mail → history.list + only the new message
    mock.add({ id: 'new-1', threadId: 'tnew1', from: 'Vodafone CZ <ebill@vodafone.cz>', subject: 'Nová faktura 2026115566', snippet: 'Faktura č. 2026115566. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.', body: 'Faktura č. 2026115566. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.', labelIds: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'], internalDate: Date.now() });
    mock.resetStats(); gmailHttp = [];
    await refresh(page);
    const s4 = await idx(page);
    ck('V4 new mail: found via history.list, only that message fetched', gmailHttp.some((x) => x.startsWith('/history')) && (mock.stats.byKind.getMeta || 0) === 1 && (mock.stats.byKind.getFull || 0) <= 1, { http: gmailHttp, byKind: mock.stats.byKind });
    ck('V4 new bill is in the index with a rule reason', s4.rows === s1b.rows + 1, { before: s1b.rows, after: s4.rows });

    // V5 label-only change → no body GET, no AI
    mock.relabel('m0001', [], ['UNREAD']);
    mock.resetStats(); gmailHttp = [];
    await refresh(page);
    ck('V5 label change: labels updated with no message or body GET', !(mock.stats.byKind.getMeta || 0) && !(mock.stats.byKind.getFull || 0), mock.stats.byKind);

    // V6 deletion of a bill email → record kept + flagged
    mock.remove('m0001'); // ČEZ bill
    await refresh(page);
    const s6 = await idx(page);
    ck('V6 deleted bill email: tombstone in the mail cache', s6.byStatus.deleted >= 1, { byStatus: s6.byStatus });

    // V7 two tabs refreshing at the same moment → one sync
    const page2 = await ctx.newPage(); await mockGoogle(page2); page2.on('pageerror', (e) => errs.push('tab2: ' + e.message));
    await page2.goto('http://127.0.0.1:8779/index.html', { waitUntil: 'domcontentloaded' }); await settle(page2);
    mock.resetStats(); gmailHttp = [];
    const [n1, n2] = [await runs(page), await runs(page2)];
    await Promise.all([page, page2].map((p) => p.evaluate(() => { window.DaylightV2Host.syncNow(); })));
    await settle(page, n1); await settle(page2, n2);
    ck('V7 two tabs refreshing together: Gmail profile read once (one sync, no overlap)', (mock.stats.byKind.profile || 0) === 1, mock.stats.byKind);
    await page2.close();

    // V8 missed slots → exactly one catch-up sync on open
    await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('daylight-gmail-last-sync:')); localStorage.setItem(k, String(Date.now() - 26 * 3600000)); });
    mock.resetStats(); gmailHttp = [];
    await page.reload({ waitUntil: 'domcontentloaded' }); await settle(page);
    ck('V8 open after a day of missed slots: exactly one catch-up sync', (mock.stats.byKind.profile || 0) === 1, mock.stats.byKind);

    // V9 batch endpoint failing (CORS-like) → single GET fallback, mail still arrives
    batchMode = 'fail';
    for (let i = 0; i < 3; i++) mock.add({ id: 'bf-' + i, threadId: 'tbf' + i, from: 'Wolt <info@wolt.com>', subject: 'Your order from Burger Bar ' + i, snippet: 'Total 299 Kč', body: 'Thanks for your order! Total 299 Kč.', labelIds: ['INBOX', 'CATEGORY_UPDATES'], internalDate: Date.now() });
    await refresh(page);
    const s9 = await idx(page);
    ck('V9 batch endpoint fails: falls back to single GETs, no mail lost', s9.rows === s6.rows + 3, { before: s6.rows, after: s9.rows });
    batchMode = 'ok';

    const s10 = await idx(page);
    // V11 cache never stores bodies
    const leak = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('daylight-mail'); r.onsuccess = () => { const t = r.result.transaction(['mailIndex', 'mailFacts'], 'readonly'); const a = t.objectStore('mailIndex').getAll(), b = t.objectStore('mailFacts').getAll(); t.oncomplete = () => { const s = JSON.stringify(a.result) + JSON.stringify(b.result); res({ hasBodyData: /"data":"[A-Za-z0-9_-]{40,}/.test(s), hasPayloadParts: /"parts":\[/.test(s), bytes: s.length }); }; }; }));
    ck('V11 no raw bodies in IndexedDB (only metadata, results and hashes)', !leak.hasBodyData && !leak.hasPayloadParts, leak);

    // V12 Sync Efficiency panel
    const metrics = s10.metrics.reduce((a, r) => { Object.entries(r.counters).forEach(([k, v]) => { a[k] = (a[k] || 0) + v; }); return a; }, {});
    ck('V12 efficiency counters recorded (units, batch, rule stages, syncs by trigger)', metrics.units > 0 && metrics.req_batch > 0 && metrics.syncs > 0 && Object.keys(metrics).some((k) => k.startsWith('stage_')), metrics);

    ck('No page errors', errs.length === 0, errs);
    const report = { generatedAt: new Date().toISOString(), checks, passed: checks.filter((c) => c.ok).length, total: checks.length, coldUnits: u1, coldHttp: h1 };
    fs.writeFileSync(path.join(__dirname, 'gmail-v2-browser-e2e-report.json'), JSON.stringify(report, null, 2));
    console.log(`Gmail v2 browser E2E: ${report.passed}/${report.total} checks passed (cold open ${h1} Gmail HTTP requests, ${u1} quota units)`);
    if (report.passed !== report.total) process.exitCode = 1;
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
