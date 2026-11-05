/** V2 multi-account privacy: two Gmail accounts on one device. Switching (both directions) never shows the previous account; each account sees only its own Items, rules, Ask and diagnostics; disconnecting either account deletes only that account; Delete all wipes the device. Synthetic data, mocked Google. */
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
    if (u.origin === WORKER && u.pathname === '/health') return json(route, 200, { ok: true, features: ['logout_keep_grant'] });
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
  const srv = await serve(appDir, 8784);
  const browser = await chromium.launch();
  const out = {}; const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
  try {
    const st = { who: 'A', box: { A: makeGmail(), B: mailboxB() }, logouts: [] };
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Europe/Prague', locale: 'en-GB' });
    await ctx.addInitScript(({ w }) => {
      if (!localStorage.getItem('dl-iso-seeded') && !sessionStorage.getItem('dl-noseed')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('daylight-personal-tasks', JSON.stringify([{ id: 'own1', title: 'My own task' }])); localStorage.setItem('dl-iso-seeded', '1'); }
      // leak monitor: from the first frame, record any moment the screen or the UI state shows an Item of the account we just left
      const forbid = JSON.parse(sessionStorage.getItem('dl-forbid') || 'null');
      if (forbid) { window.__leaks = []; const scan = () => { const U = window.DaylightV2UI; const v2 = document.getElementById('v2'); if (U && U.state.items.some((x) => x.accountId === forbid.acct)) window.__leaks.push('state'); if (v2) { if ([...v2.querySelectorAll('[data-open],[data-sw],[data-person]')].some((n) => forbid.ids.includes(n.dataset.open || n.dataset.sw || n.dataset.person))) window.__leaks.push('dom'); if (forbid.name && v2.innerText.includes(forbid.name)) window.__leaks.push('name'); } }; setInterval(scan, 15); document.addEventListener('DOMContentLoaded', () => new MutationObserver(scan).observe(document.documentElement, { subtree: true, childList: true, characterData: true })); }
    }, { w: WORKER });
    const page = await ctx.newPage(); await page.clock.setFixedTime(new Date(S.NOW)); await mockGoogle2(page, st);
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    const items = () => page.evaluate(() => window.DaylightV2UI.state.items.map((x) => ({ id: x.id, a: x.accountId, t: x.title, type: x.type })));
    const graphByAcct = () => page.evaluate(async () => { const all = await window.DaylightV2.graph.query(); const c = {}; all.forEach((x) => { c[x.accountId] = (c[x.accountId] || 0) + 1; }); return c; });
    const rulesByAcct = () => page.evaluate(async () => { const r = await window.DaylightV2.graph.rules.all(); const c = {}; r.forEach((x) => { c[x.accountId] = (c[x.accountId] || 0) + 1; }); return c; });
    const mailRows = () => page.evaluate(async () => new Promise((res) => { const r = indexedDB.open('daylight-mail'); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('mailIndex')) { d.close(); return res({}); } const q = d.transaction('mailIndex', 'readonly').objectStore('mailIndex').getAll(); q.onsuccess = () => { const c = {}; q.result.forEach((x) => { c[x.accountId] = (c[x.accountId] || 0) + 1; }); d.close(); res(c); }; }; r.onerror = () => res({ err: 1 }); }));
    const switchTo = async (who, forbid) => {
      st.who = who;
      await page.evaluate((f) => sessionStorage.setItem('dl-forbid', JSON.stringify(f)), forbid);
      await page.goto('http://127.0.0.1:8784/blank.txt').catch(() => {});
      await page.goto(`http://127.0.0.1:8784/index.html#daylight_session=${(who === 'A' ? 'A' : 'B').repeat(20)}${Date.now()}&daylight_gmail_readonly=1`, { waitUntil: 'domcontentloaded' });
    };
    // ---- account A ----
    await page.goto('http://127.0.0.1:8784/index.html', { waitUntil: 'domcontentloaded' });
    await waitIngest(page, '42'); await page.waitForTimeout(1500);
    const a1 = await items();
    const aEmail = a1.find((x) => x.type === 'email'), aBill = a1.find((x) => x.type === 'bill');
    await page.evaluate(async (id) => window.DaylightV2UI.act(id, 'done', {}, { silent: true }), aBill.id);
    await page.evaluate(async (id) => window.DaylightV2UI.act(id, 'correct_type', { type: 'newsletter' }, { silent: true }), aEmail.id);
    check('A: only A Items shown', a1.length > 20 && a1.every((x) => x.a === '42' || x.a === 'local'));
    const aIds = a1.filter((x) => x.a === '42').map((x) => x.id);
    // ---- A → B: a new sign-in on the same browser ----
    await switchTo('B', { acct: '42', ids: aIds, name: 'Ravi Kumar' });
    await waitIngest(page, '77'); await page.waitForTimeout(2000);
    const leaksAB = await page.evaluate(() => window.__leaks || ['monitor missing']);
    check('A → B: from the first frame, no A card, A state or A name is ever rendered', leaksAB.length === 0, [...new Set(leaksAB)]);
    check('A → B: the old server session is forgotten (keep_grant), not left behind', st.logouts.some((l) => l.keepGrant && l.session === 'SSSSS'), st.logouts);
    const b1 = await items();
    check('B: only B Items are shown (A stays stored but hidden)', b1.length > 0 && b1.every((x) => x.a === '77' || x.a === 'local') && (await graphByAcct())['42'] > 0);
    let domAny = false; for (const tab of ['today', 'inbox', 'plan', 'money', 'wallet']) { await page.click(`.v-tab[data-tab=${tab}]`); await page.waitForTimeout(200); const ids = await page.$$eval('#v2 [data-open]', (els) => els.map((e) => e.dataset.open)); if (ids.some((id) => aIds.includes(id))) domAny = true; }
    check('B: no A card on any tab', !domAny);
    const askA = await page.evaluate((q) => window.DaylightV2Model.askLocal(window.DaylightV2UI.state.items, q, Date.now()).ids, aEmail.t);
    check("B: Ask never returns A's Items", !askA.some((id) => aIds.includes(id)));
    const diagB = await page.evaluate(async () => { await window.DaylightV2UI.openDiagnostics(); await new Promise((r) => setTimeout(r, 800)); const t = document.querySelector('.v-sheet .bd').innerText; const sync = await window.DaylightV2Host.syncDiagnostics(); return { t, acct: sync.account, indexed: sync.index.total }; });
    check('B: diagnostics report B only (account 77, B mail cache, A hidden count shown)', diagB.acct === '77' && diagB.indexed === 5 && /account 77/.test(diagB.t) && /other accounts on this device are hidden/.test(diagB.t), { acct: diagB.acct, indexed: diagB.indexed });
    await page.evaluate(() => { while (window.DaylightV2UI.state.sheets.length) document.querySelector('.v-sheet [data-close]')?.click(); });
    if (process.env.SHOTS) { await page.click('[data-open-settings]'); await page.waitForTimeout(500); await page.screenshot({ path: process.env.SHOTS + '/acct-settings.png' }); await page.evaluate(() => { const el = [...document.querySelectorAll('.v-sheet .v-section h4')].find((h) => /accounts on this device/i.test(h.textContent)); el && el.scrollIntoView(); }); await page.waitForTimeout(300); await page.screenshot({ path: process.env.SHOTS + '/acct-list.png' }); await page.click('.v-sheet [data-conn=gmail]'); await page.waitForTimeout(500); await page.evaluate(() => { const b = document.querySelector('.v-sheet .bd'); b.scrollTop = b.scrollHeight; }); await page.waitForTimeout(300); await page.screenshot({ path: process.env.SHOTS + '/acct-gmail.png' }); await page.evaluate(() => { while (window.DaylightV2UI.state.sheets.length) document.querySelector('.v-sheet [data-close]')?.click(); }); await page.waitForTimeout(400); }
    check("B: A's correction rule is not shown for B", (await page.evaluate(() => window.DaylightV2UI.state.rules.length)) === 0);
    const bTypes = b1.filter((x) => !['organisation', 'person', 'email'].includes(x.type)).map((x) => x.type);
    check("B: B's bill, booking and deadline were found", ['bill', 'booking', 'deadline'].every((t) => bTypes.includes(t)), bTypes);
    const bRent = b1.find((x) => /Rent for November/.test(x.t));
    await page.evaluate(async (id) => window.DaylightV2UI.act(id, 'snooze', { until: Date.now() + 2 * 86400000 }, { silent: true }), bRent.id);
    await page.evaluate(async (id) => window.DaylightV2UI.act(id, 'correct_type', { type: 'personal' }, { silent: true }), b1.find((x) => /RegioJet|Brno/.test(x.t) && x.type === 'email').id);
    await page.evaluate(() => sessionStorage.removeItem('dl-forbid'));
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitIngest(page, '77'); await page.waitForTimeout(1500);
    check('B: snooze survives a refresh', (await page.evaluate(async (id) => (await window.DaylightV2.graph.getItem(id)).status, bRent.id)) === 'snoozed');
    const bIds = (await items()).filter((x) => x.a === '77').map((x) => x.id);
    // ---- B → A ----
    await switchTo('A', { acct: '77', ids: bIds, name: 'Tess Tester' });
    await waitIngest(page, '42'); await page.waitForTimeout(2000);
    const leaksBA = await page.evaluate(() => window.__leaks || ['monitor missing']);
    check('B → A: from the first frame, no B card, B state or B name is ever rendered', leaksBA.length === 0, [...new Set(leaksBA)]);
    const back = await page.evaluate(async ([b, e]) => ({ bill: (await window.DaylightV2.graph.getItem(b)).status, email: (await window.DaylightV2.graph.getItem(e)).classification.type }), [aBill.id, aEmail.id]);
    check("A again: A's Done and correction persisted across both switches", back.bill === 'done' && back.email === 'newsletter', back);
    // ---- disconnect A only ----
    const beforeDc = { graph: await graphByAcct(), rules: await rulesByAcct(), mail: await mailRows() };
    const rep = await page.evaluate(() => window.DaylightV2Host.disconnect()); await page.waitForTimeout(2500);
    out.leftA = await page.evaluate(async () => (await window.DaylightV2.graph.query({ accountId: '42' })).map((x) => ({ type: x.type, title: x.title, sources: x.sources, meta: x.meta })));
    const afterA = { graph: await graphByAcct(), rules: await rulesByAcct(), mail: await mailRows(), ingestKeys: await page.evaluate(() => Object.keys(localStorage).filter((k) => /graph-ingest|ledger|last-sync/.test(k))), tasks: await page.evaluate(() => JSON.parse(localStorage.getItem('daylight-personal-tasks') || '[]').map((t) => t.title)) };
    out.disconnectA = { beforeDc, afterA, rep };
    check('disconnect A: A Items, rules and mail rows deleted', !afterA.graph['42'] && !afterA.rules['42'] && !afterA.mail['42'] && beforeDc.graph['42'] > 0 && beforeDc.rules['42'] === 1, { before: beforeDc, after: afterA, left: out.leftA });
    check('disconnect A: B Items, B rules and B mail rows are kept', afterA.graph['77'] === beforeDc.graph['77'] && afterA.rules['77'] === 1 && afterA.mail['77'] === beforeDc.mail['77'], { before: beforeDc, after: afterA });
    check("disconnect A: A's account keys removed, B's kept; your own task kept", !afterA.ingestKeys.some((k) => k.endsWith(':42')) && afterA.ingestKeys.some((k) => k.endsWith(':77')) && afterA.tasks.includes('My own task'), afterA.ingestKeys);
    check('disconnect A: revokes at the server (no keep_grant)', st.logouts.some((l) => !l.keepGrant), st.logouts);
    // ---- sign in as B again, then disconnect B ----
    await switchTo('B', { acct: '42', ids: aIds, name: 'Ravi Kumar' });
    await waitIngest(page, '77'); await page.waitForTimeout(1500);
    const bAgain = await page.evaluate(async (id) => (await window.DaylightV2.graph.getItem(id)).status, bRent.id);
    check('B again: B data intact after A was disconnected (snooze kept)', bAgain === 'snoozed', bAgain);
    await page.evaluate(() => window.DaylightV2Host.disconnect()); await page.waitForTimeout(2500);
    const afterB = { graph: await graphByAcct(), rules: await rulesByAcct(), tasks: await page.evaluate(() => JSON.parse(localStorage.getItem('daylight-personal-tasks') || '[]').map((t) => t.title)) };
    check('disconnect B: no Gmail Items or rules left; your own task stays (device-owned)', !afterB.graph['77'] && !afterB.graph['42'] && !Object.keys(afterB.rules).length && afterB.tasks.includes('My own task') && afterB.graph.local >= 1, afterB);
    // ---- delete a non-signed-in account's data from Settings ----
    await switchTo('A', { acct: '77', ids: [], name: '' }); await waitIngest(page, '42'); await page.waitForTimeout(1200);
    await switchTo('B', { acct: '42', ids: aIds, name: 'Ravi Kumar' }); await waitIngest(page, '77'); await page.waitForTimeout(1200);
    const pre = await graphByAcct();
    await page.click('[data-open-settings]'); await page.waitForTimeout(400);
    await page.click('.v-sheet [data-delacct="42"]'); await page.waitForTimeout(200); await page.click('.v-sheet [data-ok]'); await page.waitForTimeout(2500);
    const post = { graph: await graphByAcct(), mail: await mailRows(), signedIn: await page.evaluate(() => window.DaylightV2Host.accountId()) };
    check("Settings → delete another account's data: A removed, signed-in B untouched", pre['42'] > 0 && !post.graph['42'] && !post.mail['42'] && post.graph['77'] === pre['77'] && post.signedIn === '77', { pre, post });
    await page.evaluate(() => { while (window.DaylightV2UI.state.sheets.length) document.querySelector('.v-sheet [data-close]')?.click(); });
    // ---- delete all ----
    await page.evaluate(() => { sessionStorage.setItem('dl-noseed', '1'); window.DaylightV2Host.deleteAll().catch(() => {}); }); await page.waitForTimeout(4000);
    const wiped = await page.evaluate(async () => {
      const count = (db, store) => new Promise((res) => { const r = indexedDB.open(db); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains(store)) { d.close(); return res(0); } const q = d.transaction(store, 'readonly').objectStore(store).count(); q.onsuccess = () => { d.close(); res(q.result); }; }; r.onerror = () => res(-1); });
      const BOOT = ['daylight-mtab', 'daylight-v2-tab']; // UI preferences the app writes again on start, holding no data
      return { keys: Object.keys(localStorage).filter((k) => /^(daylight-|dl-)/.test(k) && !BOOT.includes(k)), graphItems: await count('daylight-graph', 'items'), mailRows: await count('daylight-mail', 'mailIndex'), session: localStorage.getItem('daylight-session') };
    });
    check('Delete all: after reload no Daylight data keys, no graph Items, no mail rows, signed out', wiped.keys.length === 0 && !wiped.graphItems && !wiped.mailRows && !wiped.session, wiped);
    check('no page errors', errs.length === 0, errs);
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 600))); if (!ok) fail++; });
  console.log(`Accounts E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
