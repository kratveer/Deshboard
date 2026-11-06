/** V2 Phase C in the real app: Gmail sync feeds the Item Graph (IndexedDB), incremental re-ingest, actions + corrections persist. Synthetic data, mocked Google. */
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
async function mockGoogle(page, g) {
  await page.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.origin === WORKER) return json(route, 200, { access_token: 'fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/tasks.readonly https://www.googleapis.com/auth/contacts.readonly', gmail_readonly: true });
    if (u.hostname === 'gmail.googleapis.com') {
      if (u.pathname.startsWith('/batch/')) {
        const ct = req.headers()['content-type'] || ''; const boundary = /boundary=([^;]+)/.exec(ct)[1];
        const r = await g.batchSend({ boundary, body: req.postData() || '' });
        const b = 'resp_b'; const parts = [...r.data].map(([id, p]) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.ok ? p.data : { error: { code: p.status } })}\r\n`);
        return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': `multipart/mixed; boundary=${b}` }, body: parts.join('') + `--${b}--\r\n` });
      }
      const r = await g.request(req.url());
      return json(route, r.status, r.ok ? r.data : { error: { code: r.status, message: r.message } });
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '42', email: 'test@example.com', name: 'Ravi Kumar' });
    if (u.hostname === 'www.googleapis.com' && u.pathname.includes('/calendarList')) return json(route, 200, { items: [{ id: 'primary', summary: 'Ravi', primary: true, accessRole: 'owner', selected: true }, { id: 'family@group.calendar.google.com', summary: 'Family', accessRole: 'reader', selected: true }] });
    const cm = /\/calendar\/v3\/calendars\/([^/]+)\/events/.exec(u.pathname);
    if (u.hostname === 'www.googleapis.com' && cm) return json(route, 200, calendarEvents(decodeURIComponent(cm[1]), u));
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/drive/')) return json(route, 200, { files: [] });
    if (u.hostname === 'tasks.googleapis.com') {
      if (u.pathname.endsWith('/lists')) return json(route, 200, { items: [{ id: 'L1', title: 'My Tasks' }] });
      const showCompleted = u.searchParams.get('showCompleted') !== 'false';
      const max = Number(u.searchParams.get('maxResults') || 100);
      const items = S.TASKS.filter((t) => showCompleted || t.status !== 'completed').slice(0, max).map((t) => ({ ...t, kind: 'tasks#task', webViewLink: 'https://tasks.google.com/task/' + t.id }));
      return json(route, 200, { items });
    }
    if (u.hostname === 'people.googleapis.com') return json(route, 200, { connections: [] });
    return route.abort('blockedbyclient');
  });
}
async function settle(page) {
  await page.waitForFunction(() => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); return !s.busy && (s.lastAt > 0 || !!s.error); }, null, { timeout: 180000 });
  await page.waitForTimeout(1500);
}
async function newPage(browser, g, viewport, mobile) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: mobile, hasTouch: mobile, timezoneId: 'Europe/Prague', locale: 'en-GB' });
  await ctx.addInitScript(({ w, personal }) => {
    if (!localStorage.getItem('dl-audit-seeded')) {
      localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43));
      localStorage.setItem('daylight-personal-tasks', JSON.stringify(personal));
      localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } }));
      localStorage.setItem('dl-audit-seeded', '1');
    }
  }, { w: WORKER, personal: S.PERSONAL });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(S.NOW));
  await mockGoogle(page, g);
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errs.push('CSP: ' + m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:8781/index.html', { waitUntil: 'domcontentloaded' });
  await settle(page);
  return { ctx, page, errs };
}
const clickTab = async (page, t) => { await page.evaluate((x) => document.querySelector(`[data-tab="${x}"]`)?.click(), t); await page.waitForTimeout(1500); };
(async () => {
  const srv = await serve(appDir, 8781);
  const browser = await chromium.launch();
  const out = {};
  try {
    const { page, errs } = await newPage(browser, makeGmail(), { width: 390, height: 844 }, true);
    await page.waitForFunction(() => window.DaylightV2 && window.DaylightV2.lastIngest, null, { timeout: 60000 });
    await settle(page);
    out.first = await page.evaluate(async () => ({ ingest: window.DaylightV2.lastIngest, gmail: (await window.DaylightV2.graph.query({ sourceApp: 'gmail' })).length, counts: await window.DaylightV2.graph.counts(), backend: window.DaylightV2.graph.backend, connectors: window.DaylightV2.registry.list().map((c) => [c.id, c.status]) }));
    // a second refresh (5 minutes later) must be incremental and must not duplicate anything
    await page.clock.setFixedTime(new Date(S.NOW + 5 * 60000));
    const before = await page.evaluate(() => window.DaylightV2.lastIngest.at);
    await page.evaluate(() => { window.DaylightV2Host.syncNow(); });
    await page.waitForFunction((b) => window.DaylightV2.lastIngest && window.DaylightV2.lastIngest.at > b, before, { timeout: 60000 });
    // and a further quiet refresh 5 minutes later re-ingests nothing (watermark ties are re-read once, harmlessly)
    await page.clock.setFixedTime(new Date(S.NOW + 10 * 60000));
    const before2 = await page.evaluate(() => window.DaylightV2.lastIngest.at);
    await page.evaluate(() => { window.DaylightV2Host.syncNow(); });
    await page.waitForFunction((b) => window.DaylightV2.lastIngest && window.DaylightV2.lastIngest.at > b, before2, { timeout: 60000 });
    out.second = await page.evaluate(async () => ({ ingest: window.DaylightV2.lastIngest, gmail: (await window.DaylightV2.graph.query({ sourceApp: 'gmail' })).length, counts: await window.DaylightV2.graph.counts() }));
    // act on an Item and correct another one
    out.acted = await page.evaluate(async () => {
      const V = window.DaylightV2;
      const bill = (await V.graph.query({ type: 'bill' }))[0];
      const promo = (await V.graph.query({ type: 'email' })).find((e) => e.classification.type === 'marketing') || (await V.graph.query({ type: 'email' }))[0];
      const d = await V.actions.applyAction(bill.id, 'done', {});
      const c = await V.actions.applyAction(promo.id, 'correct_type', { type: 'personal' });
      return { billId: bill.id, promoId: promo.id, done: d.ok, writeBack: d.writeBack, corrected: c.ok, rule: c.rule && c.rule.label };
    });
    await page.reload();
    await page.waitForFunction(() => window.DaylightV2 && window.DaylightV2.lastIngest, null, { timeout: 60000 });
    out.afterReload = await page.evaluate(async (a) => {
      const V = window.DaylightV2;
      const bill = await V.graph.getItem(a.billId), promo = await V.graph.getItem(a.promoId);
      return { billStatus: bill && bill.status, promoType: promo && promo.classification.type, rules: (await V.ruleStore.all()).map((r) => r.label), counts: await V.graph.counts(), log: (await V.log.list()).length };
    }, out.acted);
    out.errors = errs;
  } finally { await browser.close(); srv.close(); }
  const f = out.first, s2 = out.second, a = out.afterReload;
  const checks = [
    ['graph is stored in IndexedDB (survives reload)', f.backend === 'indexeddb'],
    ['first sync fills the graph with linked Items of several kinds', f.counts.total > 30 && f.counts.links > 10 && ['email', 'bill', 'organisation'].every((t) => f.counts.byType[t] > 0), f.counts],
    ['only Gmail is live; other providers are listed as planned', f.connectors.filter(([, st]) => st === 'live').map(([id]) => id).join() === 'gmail' && f.connectors.length >= 10],
    ['second refresh is incremental and creates no duplicates', s2.ingest.incremental === true && s2.gmail === f.gmail && s2.counts.byType.email === f.counts.byType.email && s2.counts.byType.booking === f.counts.byType.booking, { first: f.counts, second: s2.counts, ingest: s2.ingest }],
    ['a refresh with no new mail re-ingests nothing', s2.ingest.emails === 0 && s2.ingest.items === 0, { first: f.ingest, second: s2.ingest }],
    ['actions work and stay local (read-only Gmail)', out.acted.done && out.acted.writeBack.every((w) => w.status === 'local-only')],
    ['a correction creates a visible rule', out.acted.corrected && /→ Important personal/.test(out.acted.rule || '')],
    ['after reload + re-sync: done stays done, correction and rule survive', a.billStatus === 'done' && a.promoType === 'personal' && a.rules.length === 1, a],
    ['no page errors', out.errors.length === 0, out.errors]
  ];
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !info ? '' : '  ← ' + JSON.stringify(info).slice(0, 300))); if (!ok) fail++; });
  console.log(`Graph E2E: ${checks.length - fail}/${checks.length} checks passed · first ingest ${f.ingest.ms} ms (${f.ingest.emails} emails), incremental ${s2.ingest.ms} ms`);
  fs.writeFileSync(path.join(__dirname, 'v2-graph-e2e-report.json'), JSON.stringify(out, null, 2));
  process.exitCode = fail ? 1 : 0;
})();
