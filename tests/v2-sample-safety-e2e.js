/** Sample data can never leak into a real account: sample mode works on an in-memory graph and writes nothing to this device; exiting it shows the real account untouched. Synthetic data, mocked Google. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const S = require('./home-audit-scenario.js');

const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.test';
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
  const srv = await serve(appDir, 8785);
  const browser = await chromium.launch();
  const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
  try {
    const st = { who: 'A', box: { A: makeGmail() }, logouts: [] };
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB' });
    await ctx.addInitScript(({ w }) => { if (!localStorage.getItem('dl-s-seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('daylight-personal-tasks', JSON.stringify([{ id: 'own1', title: 'My own task' }])); localStorage.setItem('dl-s-seeded', '1'); } }, { w: WORKER });
    const page = await ctx.newPage(); await page.clock.setFixedTime(new Date(S.NOW)); await mockGoogle2(page, st);
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('http://127.0.0.1:8785/index.html', { waitUntil: 'domcontentloaded' });
    await waitIngest(page, '42'); await page.waitForTimeout(1500);
    const snap = () => page.evaluate(async () => { const all = await window.DaylightV2.graph.query(); const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!/^(daylight-v2-tab|daylight-mtab)$/.test(k)) ls[k] = localStorage.getItem(k); } return { n: all.length, sample: all.filter((x) => x.accountId === 'sample' || /sample/i.test(x.key || '')).length, titles: all.map((x) => x.title), ls }; });
    const before = await snap();
    // enter sample mode in the same browser, do everything a user could do
    await page.goto('http://127.0.0.1:8785/index.html?v2sample=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.DaylightV2UI && window.DaylightV2UI.state.sample && window.DaylightV2UI.state.items.length > 20, null, { timeout: 30000 });
    const inSample = await page.evaluate(() => ({ banner: !document.querySelector('[data-sample-banner]').hidden, accts: [...new Set(window.DaylightV2UI.state.items.map((x) => x.accountId))] }));
    check('sample mode shows a banner and only sample Items', inSample.banner && inSample.accts.every((a) => a === 'sample' || a === 'local'), inSample);
    await page.evaluate(async () => { const U = window.DaylightV2UI; const S = U.state; const bill = S.items.find((x) => x.type === 'bill' && x.status === 'open'); await U.act(bill.id, 'done', {}, { silent: true }); const em = S.items.find((x) => x.type === 'email'); await U.act(em.id, 'correct_type', { type: 'newsletter' }, { silent: true }); });
    await page.click('[data-quickadd]'); await page.fill('[data-quickform] [name=title]', 'SAMPLE-ONLY task'); await page.click('[data-quickform] [type=submit]'); await page.waitForTimeout(600);
    await page.click('.v-tab[data-tab=wallet]'); await page.click('.v-screen[data-screen=wallet] [data-addpass]'); await page.fill('[data-passform] [name=title]', 'SAMPLE-ONLY pass'); await page.click('[data-passform] [type=submit]'); await page.waitForTimeout(600);
    await page.click('[data-open-settings]'); await page.click('.v-sheet [data-label]'); await page.waitForTimeout(300); await page.click('.v-sheet [data-lok] >> nth=0'); await page.waitForTimeout(300);
    const aiOff = await page.evaluate(() => !document.querySelector('[data-askai]'));
    const during = await snap();
    const SAMPLE_RX = /SAMPLE-ONLY|Dental Clinic Vinohrady|Hotel Am Stephansplatz|Petra Nov|ABX42K|sample1\b/;
    check('while in sample mode nothing from the sample reaches the real graph or storage (the real account keeps syncing in the background)', during.sample === 0 && !during.titles.some((t) => SAMPLE_RX.test(t)) && !Object.keys(during.ls).some((k) => /:sample$/.test(k)) && !SAMPLE_RX.test(JSON.stringify(during.ls)), { n: [before.n, during.n], changedKeys: Object.keys(during.ls).filter((k) => during.ls[k] !== before.ls[k]) });
    // leave sample mode
    await page.evaluate(() => sessionStorage.removeItem('daylight-v2-sample'));
    await page.goto('http://127.0.0.1:8785/index.html', { waitUntil: 'domcontentloaded' });
    await waitIngest(page, '42'); await page.waitForTimeout(1200);
    const after = await snap();
    const ui = await page.evaluate(() => window.DaylightV2UI.state.items.map((x) => x.title));
    check('after leaving sample mode: no sample Item, task, pass or label in the real account', after.sample === 0 && !ui.some((t) => /SAMPLE-ONLY|Dental Clinic Vinohrady|Hotel Am Stephansplatz/.test(t)) && !Object.keys(after.ls).some((k) => /validation:sample|missed:sample/.test(k)) && !/SAMPLE-ONLY/.test(JSON.stringify(after.ls)), { sample: after.sample, keys: Object.keys(after.ls).filter((k) => /sample/.test(k)) });
    check('sample data is excluded from Ask AI (no AI button in sample mode)', aiOff);
    check('no page errors', errs.length === 0, errs);
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); if (!ok) fail++; });
  console.log(`Sample safety E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
