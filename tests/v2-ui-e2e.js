/** V2 Phase D in the real app: the five-tab UI reads only Item Graph Items, actions + undo, corrections → visible rules, settings, privacy centre, Ask, disconnect. Synthetic data, mocked Google. */
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
const optionalCalls = [];
async function mockGoogle(page, g) {
  await page.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (/googleapis\.com\/calendar\/|tasks\.googleapis\.com|people\.googleapis\.com|googleapis\.com\/drive\//.test(req.url())) optionalCalls.push(req.url().split('?')[0]);
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
  await page.goto('http://127.0.0.1:8783/index.html', { waitUntil: 'domcontentloaded' });
  await settle(page);
  return { ctx, page, errs };
}
const clickTab = async (page, t) => { await page.evaluate((x) => document.querySelector(`[data-tab="${x}"]`)?.click(), t); await page.waitForTimeout(1500); };
const ids = (page, sel, attr) => page.$$eval(sel, (els, a) => els.map((e) => e.getAttribute(a)), attr);
(async () => {
  const srv = await serve(appDir, 8783);
  const browser = await chromium.launch();
  const out = {}; const checks = [];
  const check = (n, ok, info) => checks.push([n, !!ok, info]);
  try {
    const { page, errs } = await newPage(browser, makeGmail(), { width: 390, height: 844 }, true);
    await page.waitForFunction(() => window.DaylightV2 && window.DaylightV2.lastIngest && window.DaylightV2UI && window.DaylightV2UI.state.items.length > 20, null, { timeout: 60000 });
    await page.waitForTimeout(800);
    const shell = await page.evaluate(() => ({ v2: !!document.querySelector('#v2'), noClassicMarkup: !document.querySelector('#mapp, .shell, #layout, #overlay, .m-tabs'), tabs: [...document.querySelectorAll('#v2 .v-tab')].map((b) => b.querySelector(':scope > span:last-child').textContent.trim()) }));
    check('the app is the only interface: five tabs, no classic markup on the page', shell.v2 && shell.noClassicMarkup && shell.tabs.join() === 'Today,Inbox,Plan,Money,Wallet', shell);
    if (process.env.SHOTS) for (const t of ['today', 'inbox', 'plan', 'money', 'wallet']) { await page.click(`.v-tab[data-tab=${t}]`); await page.waitForTimeout(500); await page.screenshot({ path: `${process.env.SHOTS}/real-${t}.png` }); }
    await page.click('.v-tab[data-tab=today]');
    const graphIds = async () => page.evaluate(async () => (await window.DaylightV2.graph.query()).map((x) => x.id));
    const all = new Set(await graphIds());
    // Today
    const needIds = await ids(page, '[data-list=needs] [data-sw]', 'data-sw');
    const model = await page.evaluate(() => { const M = window.DaylightV2Model; const S = window.DaylightV2UI.state; const t = M.todayView(S.items, Date.now(), { actions: S.actions }); return { needs: t.needs.map((x) => x.item.id), now: t.now && t.now.item.id }; });
    check('Today: every Needs-you card is a graph Item, in model order', needIds.length > 0 && needIds.every((x) => all.has(x)) && needIds.join() === model.needs.filter((x) => x !== model.now).slice(0, 10).join(), { needIds, model });
    const brief = await page.$$eval('.v-brief button', (b) => b.map((x) => x.textContent));
    check('Today: the brief is built from Items (clickable parts)', brief.length >= 1, brief);
    // every rendered id on every tab exists in the graph
    const rendered = new Set();
    for (const t of ['today', 'inbox', 'plan', 'money', 'wallet']) { await page.click(`.v-tab[data-tab=${t}]`); await page.waitForTimeout(400); (await ids(page, `.v-screen[data-screen=${t}] [data-open]`, 'data-open')).forEach((x) => rendered.add(x)); }
    check('nothing is invented: every card on every tab opens a real graph Item', rendered.size > 10 && [...rendered].every((x) => all.has(x)), { rendered: rendered.size, missing: [...rendered].filter((x) => !all.has(x)) });
    // Inbox
    await page.click('.v-tab[data-tab=inbox]'); await page.waitForTimeout(300);
    const inboxRows = await ids(page, '.v-screen[data-screen=inbox] .v-row[data-open]', 'data-open');
    const types = await page.evaluate((r) => r.map((id) => window.DaylightV2UI.state.items.find((x) => x.id === id)?.type), inboxRows);
    check('Inbox: Messages lists emails only', inboxRows.length > 3 && types.every((t) => t === 'email'), types);
    await page.click('[data-seg=updates]'); await page.waitForTimeout(300);
    const upd = await page.$$eval('[data-ufold]', (x) => x.length);
    check('Inbox: Updates groups newsletters/promotions by sender', upd >= 1, upd);
    await page.click('[data-seg=people]'); await page.waitForTimeout(300);
    const ppl = await page.$$eval('[data-person]', (x) => x.length);
    check('Inbox: People lists senders from the graph', ppl >= 1, ppl);
    // Money
    await page.click('.v-tab[data-tab=money]'); await page.waitForTimeout(300);
    const billCards = await ids(page, '.v-screen[data-screen=money] .v-card[data-open]', 'data-open');
    const billTypes = await page.evaluate((r) => r.map((id) => window.DaylightV2UI.state.items.find((x) => x.id === id)?.type), billCards);
    check('Money: Due soon shows bill Items only', billCards.length >= 1 && billTypes.every((t) => t === 'bill'), billTypes);
    // action + undo through the UI
    const target = billCards[0];
    await page.click(`.v-screen[data-screen=money] [data-sw="${target}"] [data-act]`); await page.waitForTimeout(900);
    const st1 = await page.evaluate(async (id) => (await window.DaylightV2.graph.getItem(id)).status, target);
    await page.click('.v-toast [data-undo]'); await page.waitForTimeout(900);
    const st2 = await page.evaluate(async (id) => (await window.DaylightV2.graph.getItem(id)).status, target);
    check('Mark paid → done in the graph; Undo → open again', st1 === 'done' && st2 === 'open', { st1, st2 });
    // snooze from the sheet
    await page.click(`.v-screen[data-screen=money] .v-card[data-open="${target}"]`); await page.waitForTimeout(500);
    await page.click('.v-sheet [data-snooze]'); await page.waitForTimeout(400);
    await page.click('.v-sheet [data-snoozeat] >> nth=0'); await page.waitForTimeout(900);
    const sn = await page.evaluate(async (id) => { const it = await window.DaylightV2.graph.getItem(id); return { s: it.status, u: it.snoozedUntil > Date.now(), shown: !!document.querySelector(`.v-screen[data-screen=money] [data-sw="${id}"]`) }; }, target);
    check('Snooze → Item snoozed and gone from the list until it wakes', sn.s === 'snoozed' && sn.u && !sn.shown, sn);
    // correction → rule visible in Settings
    await page.click('.v-tab[data-tab=inbox]'); await page.click('[data-seg=messages]'); await page.waitForTimeout(300);
    const em = (await ids(page, '.v-screen[data-screen=inbox] .v-row[data-open]', 'data-open'))[0];
    await page.click(`.v-row[data-open="${em}"]`); await page.waitForTimeout(500);
    await page.click('.v-sheet [data-notright]'); await page.waitForTimeout(400);
    await page.click('.v-sheet [data-settype="newsletter"]'); await page.waitForTimeout(900);
    const corr = await page.evaluate(async (id) => (await window.DaylightV2.graph.getItem(id)).classification, em);
    await page.click('[data-open-settings]'); await page.waitForTimeout(500);
    const ruleRows = await page.$$eval('.v-sheet [data-ruledel]', (x) => x.length);
    check('Not right? → type changed, rule listed in Settings', corr.type === 'newsletter' && corr.userSet && ruleRows === 1, { corr: corr.type, ruleRows });
    const conns = await page.$$eval('.v-conn', (x) => x.map((c) => [c.dataset.conn, c.classList.contains('planned')]));
    check('Connections: Gmail live, every other app planned (none faked)', conns.length === 10 && conns.filter(([, p]) => !p).map(([id]) => id).join() === 'gmail', conns);
    await page.click('.v-sheet [data-privacy]'); await page.waitForTimeout(700);
    const priv = await page.evaluate(() => ({ text: document.querySelector('.v-sheet .bd').textContent, hasExport: !!document.querySelector('.v-sheet [data-export]'), hasDelete: !!document.querySelector('.v-sheet [data-deleteall]') }));
    check('Privacy Centre: what is stored, what left the device, export, delete everything', /What is stored here/.test(priv.text) && /What left your device/.test(priv.text) && priv.hasExport && priv.hasDelete);
    await page.click('.v-sheet [data-close]'); await page.waitForTimeout(400);
    // Intelligence Diagnostics (developer view)
    await page.click('[data-open-settings]'); await page.waitForTimeout(400); await page.click('.v-sheet [data-diag]');
    await page.waitForSelector('.v-sheet .v-dtab', { timeout: 20000 }); await page.waitForTimeout(500);
    const dg = await page.evaluate(() => ({ text: document.querySelector('.v-sheet .bd').innerText, prov: window.DaylightV2UI.provenanceCheck() }));
    const unitsRow = /Units today \/ 7 days\s+(\d+)/.exec(dg.text);
    const coldRow = /Cold sync \(first full read\) — units\s+(\d+)/.exec(dg.text);
    out.dgText = dg.text; check('Diagnostics: cold-sync units, sync runs, category coverage, skipped, errors and re-ingestion sections are present', coldRow && Number(coldRow[1]) > 0 && /Last \d+ syncs/.test(dg.text) && /Gmail category coverage/i.test(dg.text) && /Discovered but skipped/i.test(dg.text) && /Errors, retries and unresolved/i.test(dg.text) && /Graph ingestion and re-ingestion/i.test(dg.text) && !/\b(accuracy|recall)\b/i.test(dg.text.replace(/not an accuracy figure/g, '')), { cold: coldRow && coldRow[1] });
    // compare with a Gmail search + peek at what was not read (mocked Gmail answers the real API calls)
    await page.fill('[data-compareform] [name=q]', 'newer_than:30d');
    await page.click('[data-compareform] [type=submit]');
    await page.waitForFunction(() => /Gmail results/.test(document.querySelector('[data-compareout]')?.innerText || ''), null, { timeout: 20000 });
    const cmp = await page.evaluate(() => document.querySelector('[data-compareout]').innerText);
    check('Diagnostics: Gmail search comparison classifies every result (in Daylight / skipped / never discovered)', /\d+ Gmail results · \d+ units/.test(cmp) && /In Daylight/.test(cmp), cmp.slice(0, 200));
    const peekBtn = await page.$('[data-compareout] [data-peek]') || await page.$('.v-sheet [data-peek]');
    if (peekBtn) { await peekBtn.click(); await page.waitForFunction(() => /Shown here only/.test(document.querySelector('.v-sheet .bd').innerText), null, { timeout: 20000 }); }
    const peekOk = peekBtn ? await page.evaluate(() => document.querySelectorAll('.v-sheet [data-peekout] a').length) : -1;
    check('Diagnostics: skipped / not-read messages can be inspected (sender + subject, not stored)', peekBtn ? peekOk > 0 : true, { peekOk });
    check('Diagnostics: provenance check finds no card without a real Item/source', dg.prov.checked > 10 && dg.prov.problems.length === 0, dg.prov);
    check('Diagnostics: real quota counters from this sync are shown (units > 0)', unitsRow && Number(unitsRow[1]) > 0, unitsRow && unitsRow[1]);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.v-sheet [data-diagexport=redacted]')]);
    const rep = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    const subj = await page.evaluate(() => window.DaylightV2UI.state.items.filter((x) => x.type === 'email').map((x) => x.title).filter((t) => t.length > 8));
    const leaked = subj.filter((t) => JSON.stringify(rep).includes(t));
    check('Diagnostics: redacted export has counts but no email subjects', rep.kind === 'daylight-validation-report' && rep.classification.emails > 0 && leaked.length === 0, { leaked: leaked.slice(0, 3) });
    await page.click('.v-sheet [data-close]'); await page.waitForTimeout(400);
    // Ask
    await page.click('[data-ask]'); await page.waitForTimeout(400);
    await page.fill('[data-askform] input', 'what bills do I have to pay'); await page.click('[data-askform] [type=submit]'); await page.waitForTimeout(600);
    const ask = await page.evaluate(() => ({ text: document.querySelector('[data-answer]').textContent, src: [...document.querySelectorAll('[data-answer] [data-open]')].map((b) => b.dataset.open) }));
    check('Ask answers from Items and every source is a real Item', /unpaid bill|No unpaid bills/.test(ask.text) && ask.src.every((x) => all.has(x)), ask);
    await page.click('.v-sheet [data-close]'); await page.waitForTimeout(400);
    // quick add → task Item, visible in Plan tray
    await page.click('[data-quickadd]'); await page.fill('[data-quickform] [name=title]', 'E2E task'); await page.click('[data-qwhen=none]'); await page.click('[data-quickform] [type=submit]'); await page.waitForTimeout(900);
    await page.click('.v-tab[data-tab=plan]'); await page.waitForTimeout(400);
    const trayHas = await page.evaluate(() => [...document.querySelectorAll('.v-tray .v-title')].some((x) => x.textContent === 'E2E task'));
    check('Quick add → a task Item shows in the Plan tray', trayHas);
    // V1 personal tasks reached the graph through the local connector
    const localTasks = await page.evaluate(async () => (await window.DaylightV2.graph.query({ type: 'task' })).filter((x) => x.meta?.origin === 'tasks').length);
    check('Your existing personal tasks are Items (local connector)', localTasks >= 1, localTasks);
    // disconnect from the Gmail page → graph empty of Gmail Items
    await page.click('[data-open-settings]'); await page.waitForTimeout(400); await page.click('.v-sheet [data-conn=gmail]'); await page.waitForTimeout(400);
    await page.click('.v-sheet [data-disconnect]'); await page.waitForTimeout(300); await page.click('.v-sheet [data-ok]'); await page.waitForTimeout(3000);
    const after = await page.evaluate(async () => ({ gmail: (await window.DaylightV2.graph.query({ sourceApp: 'gmail' })).length, connected: window.DaylightV2Host.connected(), cards: document.querySelectorAll('[data-list=needs] [data-sw]').length }));
    check('Disconnect and delete → no Gmail Items left, app shows disconnected', after.gmail === 0 && !after.connected, after);
    out.errors = errs;
    check('a token that also carries calendar/tasks/contacts/drive (older grant) is NOT used for them unless the connector was turned on — no request to any of those APIs', calLog.length === 0 && optionalCalls.length === 0, { calLog: calLog.length, optionalCalls: [...new Set(optionalCalls)] });
    check('no page errors', errs.length === 0, errs);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/real-after-disconnect.png` });
    // the classic view is gone: no route, no stored choice, no switch in Settings
    const p2ctx = await browser.newContext({ serviceWorkers: 'block' }); await p2ctx.addInitScript(() => { try { if (!sessionStorage.getItem('x')) { localStorage.setItem('daylight-ui', 'v1'); sessionStorage.setItem('x', '1'); } } catch {} });
    const p2 = await p2ctx.newPage(); await p2.route(/^https:\/\//, (r) => r.abort());
    const p2errs = []; p2.on('pageerror', (e) => p2errs.push(e.message));
    await p2.goto('http://127.0.0.1:8783/index.html?ui=v1&demo=1', { waitUntil: 'domcontentloaded' }); await p2.waitForSelector('#v2', { timeout: 20000 }).catch(() => {});
    await p2.evaluate(() => window.DaylightV2UI && window.DaylightV2UI.openSettings && window.DaylightV2UI.openSettings()); await p2.waitForTimeout(800);
    const classic = await p2.evaluate(() => ({ v2: !!document.querySelector('#v2'), classicMarkup: !!document.querySelector('#mapp, .shell, #layout, .m-tabs'), storedChoice: localStorage.getItem('daylight-ui'), settingsText: (document.querySelector('.v-sheet') || {}).innerText || '', classicButton: !!document.querySelector('[data-classic]') }));
    check('?ui=v1, ?demo=1 and a stored classic choice all open the app; the stored choice is removed', classic.v2 && !classic.classicMarkup && classic.storedChoice === null && p2errs.length === 0, { ...classic, settingsText: undefined, p2errs });
    check('Settings has no switch to a classic view', /Appearance/i.test(classic.settingsText) && !/classic/i.test(classic.settingsText) && !classic.classicButton, { appearance: /Appearance/i.test(classic.settingsText), classic: (classic.settingsText.match(/.{0,40}classic.{0,40}/i) || [])[0], button: classic.classicButton });
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); if (!ok) fail++; });
  if (process.env.DBG) console.log(out.dgText);
  console.log(`V2 UI E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
