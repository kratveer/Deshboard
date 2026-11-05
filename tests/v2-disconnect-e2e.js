/** V2 Phase A: disconnect-and-delete in the real app (synthetic data, mocked Google + Worker). Writes tests/v2-disconnect-report.json. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const S = require('./home-audit-scenario.js');

const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.test';
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
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
  await page.waitForFunction(() => { const t = document.querySelector('#sync-status')?.textContent || ''; return /updated|Partial sync|Sync failed/.test(t) && !/refreshing/.test(t); }, null, { timeout: 180000 });
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
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:8781/index.html?ui=v1', { waitUntil: 'domcontentloaded' });
  await settle(page);
  return { ctx, page, errs };
}
const clickTab = async (page, t) => { await page.evaluate((x) => document.querySelector(`[data-tab="${x}"]`)?.click(), t); await page.waitForTimeout(1500); };

const inventory = (page) => page.evaluate(async () => {
  const idbCount = (db, store) => new Promise((res) => {
    const r = indexedDB.open(db); let created = false;
    r.onupgradeneeded = () => { created = true; };
    r.onsuccess = () => { const d = r.result; if (created || !d.objectStoreNames.contains(store)) { d.close(); if (created) indexedDB.deleteDatabase(db); return res(0); } const t = d.transaction(store, 'readonly').objectStore(store).count(); t.onsuccess = () => { res(t.result); d.close(); }; t.onerror = () => { res(-1); d.close(); }; };
    r.onerror = () => res(-1);
  });
  const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
  const wallet = JSON.parse(ls['daylight-wallet'] || '[]'), tasks = JSON.parse(ls['daylight-personal-tasks'] || '[]');
  return {
    mailIndex: await idbCount('daylight-mail', 'mailIndex'), mailFacts: await idbCount('daylight-mail', 'mailFacts'), aiQueue: await idbCount('daylight-mail', 'aiQueue'), checkpoint: await idbCount('daylight-mail', 'checkpoint'),
    graphItems: await idbCount('daylight-graph', 'items'), graphLinks: await idbCount('daylight-graph', 'links'),
    graphGmailItems: await new Promise((res) => { const r = indexedDB.open('daylight-graph'); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('items')) { d.close(); return res(0); } const q = d.transaction('items', 'readonly').objectStore('items').getAll(); q.onsuccess = () => { d.close(); res(q.result.filter((x) => (x.sources || []).some((s) => s.app === 'gmail') || x.meta?.mailId).length); }; q.onerror = () => res(-1); }; r.onerror = () => res(-1); }),
    entities: await idbCount('daylight-db', 'entities'), relationships: await idbCount('daylight-db', 'relationships'), facts: await idbCount('daylight-db', 'facts'),
    walletFromMail: wallet.filter((p) => p.mailId || /^mail:/.test(p.id || '')).length, walletManual: wallet.filter((p) => !(p.mailId || /^mail:/.test(p.id || ''))).map((p) => p.id),
    tasksSuggested: tasks.filter((t) => t.suggested || t.aiGenerated).length, tasksWithMail: tasks.filter((t) => t.mailId).length, tasksOwn: tasks.filter((t) => !(t.suggested || t.aiGenerated)).map((t) => t.title),
    ledgerKeys: Object.keys(ls).filter((k) => k.startsWith('daylight-finance-ledger')).length,
    gmailKeys: ['daylight-ai-extractions', 'daylight-google-scopes', 'daylight-profile', 'daylight-loops', 'daylight-seen'].filter((k) => ls[k] != null),
    session: ls['daylight-session'] || '', theme: ls['daylight-theme'] || '', serverUrl: ls['daylight-api'] || '', prio: ls['daylight-prio-range'] || '',
    inboxCards: document.querySelectorAll('#m-inbox .m-inbox-card').length, prioCards: document.querySelectorAll('#m-loop-grid .pa-row').length
  };
});

(async () => {
  const srv = await serve(appDir, 8781);
  const browser = await chromium.launch();
  const out = {};
  try {
    const { page, errs } = await newPage(browser, makeGmail(), { width: 390, height: 844 }, true);
    const workerCalls = []; page.on('request', (r) => { if (r.url().startsWith('https://daylight-api.test')) workerCalls.push(new URL(r.url()).pathname); });
    // unrelated data that must survive: theme, a filter, the user's own task, a manually added Wallet card
    await page.evaluate(() => {
      localStorage.setItem('daylight-theme', 'dark'); localStorage.setItem('daylight-prio-range', 'payments');
      const w = JSON.parse(localStorage.getItem('daylight-wallet') || '[]'); w.push({ id: 'manual-gym', kind: 'others', title: 'Gym card', note: 'added by hand', at: Date.now() }); localStorage.setItem('daylight-wallet', JSON.stringify(w));
    });
    await clickTab(page, 'inbox');
    out.before = await inventory(page);
    await page.evaluate(() => document.querySelector('[data-da="signout"]').click());
    await page.waitForFunction(() => /Gmail data deleted|disconnected/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    out.after = await inventory(page);
    out.workerCalls = [...new Set(workerCalls)];
    out.errors = errs;
    await page.reload(); await page.waitForTimeout(2500);
    out.afterReload = await inventory(page);
  } finally { await browser.close(); srv.close(); }
  const b = out.before, a = out.after, r = out.afterReload;
  const checks = [
    ['there was Gmail data to delete', b.mailIndex > 0 && b.walletFromMail > 0 && b.ledgerKeys > 0 && b.graphItems > 0],
    ['Gmail cache (messages, facts, AI queue, checkpoint) empty', a.mailIndex === 0 && a.mailFacts === 0 && a.aiQueue === 0 && a.checkpoint === 0],
    ['entities / relationships / facts for the account cleared', a.entities === 0 && a.relationships === 0 && a.facts === 0],
    ['Item Graph had Gmail Items and now has none (items, links); only your own tasks remain', b.graphGmailItems > 0 && a.graphGmailItems === 0 && a.graphLinks === 0, { before: b.graphGmailItems, after: a.graphGmailItems, links: a.graphLinks, left: a.graphItems }],
    ['Wallet passes from Gmail removed', a.walletFromMail === 0],
    ['manual Wallet card kept', a.walletManual.includes('manual-gym')],
    ['finance ledger and Gmail keys removed', a.ledgerKeys === 0 && a.gmailKeys.length === 0],
    ['suggested tasks from email removed, own tasks kept, no task keeps a mail link', a.tasksSuggested === 0 && a.tasksWithMail === 0 && a.tasksOwn.length >= 1],
    ['session token removed and Worker logout (Google revoke) called', !a.session && out.workerCalls.includes('/auth/logout')],
    ['unrelated settings kept (theme, filter, server address)', a.theme === 'dark' && a.prio === 'payments' && !!a.serverUrl],
    ['nothing from Gmail shown after disconnect', a.inboxCards === 0 && a.prioCards === 0],
    ['still empty after reload (no re-sync without sign-in)', r.mailIndex === 0 && r.walletFromMail === 0 && !r.session],
    ['no page errors', out.errors.length === 0]
  ];
  let fail = 0; checks.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fail++; });
  out.checks = checks.map(([n, ok]) => ({ n, ok }));
  fs.writeFileSync(path.join(__dirname, 'v2-disconnect-report.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ before: b, after: a }, null, 0).slice(0, 900));
  console.log(`Disconnect E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})();
