/** V2 must never fall back to the classic engine silently: a failing V2 sync or graph ingest is recorded, shown as a banner and in Diagnostics, and cleared by the next successful sync. Synthetic data, mocked Google. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const S = require('./home-audit-scenario.js');

const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.kratveer050.workers.dev'; // mocked: every request to it is answered by the test (the real Worker is never contacted); same host as production, so the page's Content-Security-Policy applies unchanged
const T = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function serve(dir, port) {
  return new Promise((r) => {
    const srv = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(dir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); });
    srv.listen(port, '127.0.0.1', () => r(srv));
  });
}

// ---------- mocks ----------
const fetchedIds = new Set();
function makeGmail() {
  const g = createMockGmail({ now: S.NOW, extraHeaders: 2 });
  [...S.GMAIL, ...S.SENT].forEach((x) => g.add(Object.assign({}, x, { labelIds: x.labelIds.slice() })));
  const req = g.request, bs = g.batchSend;
  g.request = async (url) => { const mm = /\/messages\/([^/?]+)/.exec(url); if (mm) fetchedIds.add(decodeURIComponent(mm[1])); return req(url); };
  g.batchSend = async (b) => { (b.body.match(/\/messages\/([^/?\s]+)/g) || []).forEach((x) => fetchedIds.add(decodeURIComponent(x.split('/').pop()))); return bs(b); };
  return g;
}
const calStore = { primary: S.CALENDAR, 'family@group.calendar.google.com': S.SECONDARY };
const evBounds = (e) => {
  if (e.start.date) return [Date.parse(e.start.date + 'T00:00:00+01:00'), Date.parse(e.end.date + 'T00:00:00+01:00')];
  return [Date.parse(e.start.dateTime), Date.parse(e.end.dateTime)];
};
const calLog = [];
let calVersion = 1;
function mutateCalendar() { // Dentist moved to 16:00–16:45, lunch cancelled
  calVersion++;
  const d = S.CALENDAR.find((e) => e.id === 'e09'); d.start = { dateTime: '2026-11-04T16:00:00+01:00', timeZone: 'Europe/Prague' }; d.end = { dateTime: '2026-11-04T16:45:00+01:00', timeZone: 'Europe/Prague' }; d._v = calVersion;
  const l = S.CALENDAR.find((e) => e.id === 'e06'); l.status = 'cancelled'; l._v = calVersion;
}
function calendarEvents(calId, u) {
  const items = (calStore[calId] || []).filter((e) => u.searchParams.get('showDeleted') === 'true' || e.status !== 'cancelled');
  const tMin = u.searchParams.get('timeMin') ? Date.parse(u.searchParams.get('timeMin')) : -Infinity;
  const tMax = u.searchParams.get('timeMax') ? Date.parse(u.searchParams.get('timeMax')) : Infinity;
  if (u.searchParams.get('syncToken')) { const since = Number(String(u.searchParams.get('syncToken')).replace('sync-', '')) || 0; return { items: (calStore[calId] || []).filter((e) => (e._v || 0) > since), nextSyncToken: 'sync-' + calVersion }; }
  const inRange = items.filter((e) => { const [s, en] = evBounds(e); return en > tMin && s < tMax; }).sort((a, b) => evBounds(a)[0] - evBounds(b)[0]);
  const max = Number(u.searchParams.get('maxResults') || 250), start = Number(u.searchParams.get('pageToken') || 0);
  const page = inRange.slice(start, start + max);
  calLog.push({ calId, timeMin: u.searchParams.get('timeMin'), timeMax: u.searchParams.get('timeMax'), max, returned: page.length, total: inRange.length });
  return { items: page, nextPageToken: start + max < inRange.length ? String(start + max) : undefined, nextSyncToken: start + max >= inRange.length ? 'sync-' + calVersion : undefined, timeZone: 'Europe/Prague' };
}
const ID = { A: { sub: '42', email: 'ravi@example.com', name: 'Ravi Kumar' }, B: { sub: '77', email: 'tester@example.org', name: 'Tess Tester' } };
const DAYMS = 86400000;
function mailboxB() {
  const g = createMockGmail({ now: S.NOW, extraHeaders: 2 });
  const add = (id, from, subject, snippet, labels, ago) => g.add({ id, threadId: 't' + id, from, subject, snippet, body: snippet, labelIds: labels, internalDate: S.NOW - ago * 3600000 });
  add('b1', 'Landlord Jana <jana.landlord@gmail.com>', 'Rent for November — please confirm', 'Hi Tess, could you confirm you sent the rent of 14 000 CZK by Friday?', ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'], 3);
  add('b2', 'PRE <faktury@pre.cz>', 'Vyúčtování elektřiny — faktura 88812', 'Částka k úhradě 2 310 Kč, splatnost 12. 11. 2026, variabilní symbol 88812.', ['INBOX', 'CATEGORY_UPDATES'], 20);
  add('b3', 'RegioJet <info@regiojet.cz>', 'Your ticket Brno → Praha, booking RJ55120', 'Departure 14 Nov 2026 08:15, coach 3 seat 21. Booking RJ55120.', ['INBOX', 'CATEGORY_UPDATES'], 30);
  add('b4', 'Newsletter <news@shop-b.test>', 'Weekend sale for Tess', 'Up to 50 % off', ['INBOX', 'CATEGORY_PROMOTIONS'], 5);
  add('b5', 'Prof. Black <black@uni-b.edu>', 'Lab report deadline', 'Please submit the lab report by 10 November 2026, 23:59.', ['INBOX', 'CATEGORY_PERSONAL'], 26);
  return g;
}
async function mockGoogle2(page, st) {
  await page.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const who = ID[st.who];
    if (u.origin === WORKER && u.pathname === '/auth/logout') { st.logouts.push({ keepGrant: u.searchParams.get('keep_grant') === '1', session: (req.headers().authorization || '').slice(7, 12) }); return json(route, 200, { ok: true }); }
    if (u.origin === WORKER) return json(route, 200, { access_token: 'tok-' + st.who, expires_in: 3600, email: who.email, scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' });
    if (u.hostname === 'gmail.googleapis.com') {
      const g = st.box[st.who];
      if (u.pathname.startsWith('/batch/')) {
        const ct = req.headers()['content-type'] || ''; const boundary = /boundary=([^;]+)/.exec(ct)[1];
        const r = await g.batchSend({ boundary, body: req.postData() || '' });
        const b = 'resp_b'; const parts = [...r.data].map(([id, p]) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.ok ? p.data : { error: { code: p.status } })}\r\n`);
        return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': `multipart/mixed; boundary=${b}` }, body: parts.join('') + `--${b}--\r\n` });
      }
      if (/\/profile$/.test(u.pathname)) { const r = await g.request(req.url()); return json(route, 200, Object.assign({}, r.data, { emailAddress: who.email })); }
      const r = await g.request(req.url());
      return json(route, r.status, r.ok ? r.data : { error: { code: r.status, message: r.message } });
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, who);
    return route.abort('blockedbyclient');
  });
}
const waitIngest = (page, sub) => page.waitForFunction((s) => { const U = window.DaylightV2UI; return window.DaylightV2 && window.DaylightV2.lastIngest && U && U.state.account === s && U.state.items.some((x) => x.type === 'email'); }, sub, { timeout: 90000 });
(async () => {
  const srv = await serve(appDir, 8789);
  const browser = await chromium.launch();
  const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
  try {
    const st = { who: 'A', box: { A: makeGmail() }, logouts: [] };
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB' });
    await ctx.addInitScript(({ w }) => {
      if (!localStorage.getItem('dl-e')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('dl-e', '1'); }
      // fault injection for this test only: make the V2 pipeline or the graph ingest throw
      const hook = (prop, wrap) => { let v; Object.defineProperty(window, prop, { configurable: true, get: () => v, set: (x) => { v = wrap(x); } }); };
      hook('DaylightMailPipeline', (api) => Object.assign({}, api, { createMailPipeline: (o) => { const p = api.createMailPipeline(o); return Object.assign({}, p, { run: async (...a) => { if (sessionStorage.getItem('dl-fail') === 'sync') throw new Error('injected: object store not found'); return p.run(...a); } }); } }));
      hook('DaylightGmailConnector', (api) => Object.assign({}, api, { createGmailConnector: (o) => { const c = api.createGmailConnector(o); const ing = c.ingest; c.ingest = async (...a) => { if (sessionStorage.getItem('dl-fail') === 'ingest') throw new Error('injected: graph write failed'); return ing(...a); }; return c; } }));
    }, { w: WORKER });
    const page = await ctx.newPage(); await page.clock.setFixedTime(new Date(S.NOW)); await mockGoogle2(page, st);
    const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errs.push('CSP: ' + m.text().slice(0, 200)); });
    const state = () => page.evaluate(async () => { const d = await window.DaylightV2Host.syncDiagnostics(); return { err: d.engineError, banner: !document.querySelector('[data-engineerr]').hidden, emails: window.DaylightV2UI.state.items.filter((x) => x.type === 'email').length }; });
    const waitUI = () => page.waitForFunction(() => window.DaylightV2UI && window.DaylightV2Host && window.DaylightV2Host.accountId() && (() => { const st = window.DaylightV2Host.syncState(); return !st.busy && (st.lastAt > 0 || !!st.error); })(), null, { timeout: 90000 });
    // 1) V2 sync fails
    await page.goto('http://127.0.0.1:8789/blank.txt').catch(() => {}); await page.evaluate(() => sessionStorage.setItem('dl-fail', 'sync'));
    await page.goto('http://127.0.0.1:8789/index.html', { waitUntil: 'domcontentloaded' }); await waitUI(); await page.waitForTimeout(2500);
    const s1 = await state();
    check('V2 sync failure is recorded (stage + message), not silent', s1.err && s1.err.stage === 'gmail sync' && /object store/.test(s1.err.message), s1.err);
    check('…and a banner tells the user what they see may be incomplete', s1.banner);
    await page.evaluate(async () => { await window.DaylightV2UI.openDiagnostics(); await new Promise((r) => setTimeout(r, 800)); });
    const diagText = await page.evaluate(() => document.querySelector('.v-sheet .bd').innerText);
    check('…and Diagnostics names the failure', /Gmail engine failed on the last sync/.test(diagText) && /injected: object store not found/.test(diagText));
    // 2) graph ingest fails after a good sync
    await page.evaluate(() => sessionStorage.setItem('dl-fail', 'ingest'));
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitUI(); await page.waitForTimeout(2500);
    const s2 = await state();
    check('a graph-ingest failure is recorded too (stage graph ingest)', s2.err && s2.err.stage === 'graph ingest' && s2.banner, s2.err);
    // 3) next fully successful sync clears it
    await page.evaluate(() => sessionStorage.removeItem('dl-fail'));
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitUI(); await page.waitForTimeout(3000);
    const s3 = await state();
    check('a successful sync + ingest clears the error and the banner; Gmail Items arrive', !s3.err && !s3.banner && s3.emails > 10, s3);
    check('no page errors', errs.length === 0, errs);
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); if (!ok) fail++; });
  console.log(`Engine error E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
