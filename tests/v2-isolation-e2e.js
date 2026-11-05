/** V2 multi-account isolation: two Gmail accounts on one device. Each account sees only its own Items, rules and actions; actions persist across reloads and account switches. Synthetic data, mocked Google. */
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
  const srv = await serve(appDir, 8784);
  const browser = await chromium.launch();
  const out = {}; const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
  try {
    const st = { who: 'A', box: { A: makeGmail(), B: mailboxB() } };
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Europe/Prague', locale: 'en-GB' });
    await ctx.addInitScript(({ w }) => { if (!localStorage.getItem('dl-iso-seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('dl-iso-seeded', '1'); } }, { w: WORKER });
    const page = await ctx.newPage(); await page.clock.setFixedTime(new Date(S.NOW)); await mockGoogle2(page, st);
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    const items = () => page.evaluate(() => window.DaylightV2UI.state.items.map((x) => ({ id: x.id, a: x.accountId, t: x.title, type: x.type })));
    // ---- account A ----
    await page.goto('http://127.0.0.1:8784/index.html', { waitUntil: 'domcontentloaded' });
    await waitIngest(page, '42'); await page.waitForTimeout(1500);
    const a1 = await items();
    const aEmail = a1.find((x) => x.type === 'email');
    const aBill = a1.find((x) => x.type === 'bill');
    await page.evaluate(async (id) => window.DaylightV2UI.act(id, 'done', {}, { silent: true }), aBill.id);
    await page.evaluate(async (id) => window.DaylightV2UI.act(id, 'correct_type', { type: 'newsletter' }, { silent: true }), aEmail.id);
    const aRules = await page.evaluate(() => window.DaylightV2UI.state.rules.length);
    check('A: signed in as A, only A Items shown', a1.length > 20 && a1.every((x) => x.a === '42' || x.a === 'local'), { n: a1.length });
    // ---- switch to account B on the same device (no disconnect) ----
    st.who = 'B';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitIngest(page, '77'); await page.waitForTimeout(2000);
    const b1 = await items();
    const stored = await page.evaluate(async () => { const all = await window.DaylightV2.graph.query(); const c = {}; all.forEach((x) => { c[x.accountId] = (c[x.accountId] || 0) + 1; }); return c; });
    check('B: only B Items are shown (A stays on the device but hidden)', b1.length > 0 && b1.every((x) => x.a === '77' || x.a === 'local') && stored['42'] > 0, { shown: b1.length, stored });
    const domHasA = await page.evaluate((t) => { const tx = document.querySelector('#v2').innerText; return tx.includes(t); }, aEmail.t);
    let domAny = false; for (const tab of ['today', 'inbox', 'plan', 'money', 'wallet']) { await page.click(`.v-tab[data-tab=${tab}]`); await page.waitForTimeout(250); const ids = await page.$$eval('#v2 [data-open]', (els) => els.map((e) => e.dataset.open)); if (ids.some((id) => a1.some((x) => x.id === id && x.a === '42'))) domAny = true; }
    check('B: no A card appears on any tab', !domHasA && !domAny);
    const askA = await page.evaluate((q) => window.DaylightV2Model.askLocal(window.DaylightV2UI.state.items, q, Date.now()).ids, aEmail.t);
    check("B: Ask never returns A's Items", !askA.some((id) => a1.some((x) => x.id === id && x.a === '42')), askA);
    out.bDetails = await page.evaluate(() => window.DaylightV2UI.state.items.filter((x) => x.type === 'email').map((x) => ({ t: x.title, type: x.classification.type, cat: x.classification.pipelineCategory, why: x.classification.pipelineReason, facts: x.extractedFacts.map((f) => f.key + '=' + f.value) })));
    const bRules = await page.evaluate(() => window.DaylightV2UI.state.rules.length);
    check("B: A's correction rule is not shown or applied for B", bRules === 0 && aRules === 1, { aRules, bRules });
    const bRent = b1.find((x) => /Rent for November/.test(x.t));
    const bBill = b1.find((x) => x.type === 'bill');
    const bBooking = b1.find((x) => x.type === 'booking');
    const bDeadline = b1.find((x) => x.type === 'deadline');
    check("B: B's own bill, booking and deadline were found", !!bBill && !!bBooking && !!bDeadline, b1.filter((x) => x.type !== 'organisation' && x.type !== 'person').map((x) => [x.type, x.t]));
    if (bRent) await page.evaluate(async (id) => window.DaylightV2UI.act(id, 'snooze', { until: Date.now() + 2 * 86400000 }, { silent: true }), bRent.id);
    // persistence after refresh
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitIngest(page, '77'); await page.waitForTimeout(1500);
    const bState = bRent ? await page.evaluate(async (id) => (await window.DaylightV2.graph.getItem(id)).status, bRent.id) : 'none';
    check('B: snooze survives a refresh and re-sync', bState === 'snoozed', bState);
    // ---- back to A ----
    st.who = 'A';
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitIngest(page, '42'); await page.waitForTimeout(2000);
    const a2 = await items();
    const back = await page.evaluate(async ([b, e]) => ({ bill: (await window.DaylightV2.graph.getItem(b)).status, email: (await window.DaylightV2.graph.getItem(e)).classification.type }), [aBill.id, aEmail.id]);
    check('back to A: A sees only A Items again', a2.every((x) => x.a === '42' || x.a === 'local') && !a2.some((x) => x.a === '77'));
    check("back to A: A's done bill and correction persisted across the switch", back.bill === 'done' && back.email === 'newsletter', back);
    // quick-add task is device-local: visible to both (documented behaviour)
    // ---- disconnect from A ----
    await page.evaluate(() => window.DaylightV2Host.disconnect()); await page.waitForTimeout(3000);
    const afterDc = await page.evaluate(async () => { const all = await window.DaylightV2.graph.query(); const c = {}; all.forEach((x) => { c[x.accountId] = (c[x.accountId] || 0) + 1; }); return c; });
    check('disconnect deletes Gmail Items of every account on this device (only local tasks/passes stay)', !afterDc['42'] && !afterDc['77'], afterDc);
    check('no page errors', errs.length === 0, errs);
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); if (!ok) fail++; });
  console.log(`Isolation E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
