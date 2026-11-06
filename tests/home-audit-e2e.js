/**
 * End-to-end audit of Home (Daily Brief, Today's Schedule, Priority Actions), Inbox, Wallet and Timeline in the REAL app.
 * SYNTHETIC data only (tests/home-audit-scenario.js); Google Calendar, Tasks and Gmail are mocked; the clock is fixed at
 * Wed 4 Nov 2026 09:15 Europe/Prague. Read-only: nothing touches a real account. Writes tests/home-audit-raw.json.
 */
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
      ['calendar', 'tasks', 'contacts'].forEach((n) => localStorage.setItem('daylight-connector-' + n, '1')); // this scenario's user turned those connectors on
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

(async () => {
  const srv = await serve(appDir, 8781);
  const browser = await chromium.launch();
  const out = { now: new Date(S.NOW).toISOString(), mobile: {}, desktop: {} };
  try {
    // ---------------- mobile ----------------
    const g = makeGmail();
    const { page, errs } = await newPage(browser, g, { width: 390, height: 844 }, true);
    // second refresh so the full-text backlog is processed and repeat-sync duplicates can show up
    await page.evaluate(() => { document.querySelector('#sync-status').textContent = 'x refreshing'; document.querySelector('#refresh').click(); }); await settle(page);
    await clickTab(page, 'home');
    out.mobile.home = await page.evaluate(() => ({
      brief: document.querySelector('#m-brief')?.innerText || '',
      briefRows: [...document.querySelectorAll('#m-brief [data-brief-kind]')].map((r) => ({ kind: r.dataset.briefKind, id: r.dataset.briefId, href: r.dataset.briefHref || '', mail: r.dataset.briefMail || '', text: r.innerText.replace(/\s+/g, ' ') })),
      scheduleProse: document.querySelector('#m-schedule-prose')?.innerText || '',
      schedule: [...document.querySelectorAll('#m-schedule-rail .dl-ev, #m-schedule-rail li')].map((li) => ({ time: (li.querySelector('small')?.textContent || li.getAttribute('title') || '').slice(0, 11), title: li.querySelector('b')?.textContent || li.innerText.replace(/\s+/g, ' '), text: (li.getAttribute('title') || li.innerText).replace(/\s+/g, ' '), link: li.tagName === 'A' ? li.getAttribute('href') : '' })),
      allDay: [...document.querySelectorAll('#m-schedule-rail .dl-allday > *')].map((a) => ({ text: a.textContent, link: a.getAttribute('href') || '' })),
      priorityTotal: document.querySelector('#m-loop-total')?.textContent || '',
      priority: [...document.querySelectorAll('#m-loop-grid [data-loop]')].map((c) => ({ id: c.dataset.loop, text: c.innerText.replace(/\s+/g, ' ') })),
      seeAll: !document.querySelector('#m-loops-see')?.hidden
    }));
    // full priority list via "See All"
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.body.classList.toggle('dark', t === 'dark'); }, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(__dirname, `home-v3-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => document.body.classList.remove('dark'));
    out.mobile.priorityByChip = {};
    for (const chip of ['week', 'payments', 'deadlines', 'travel']) {
      out.mobile.priorityByChip[chip] = await page.evaluate(async (c) => { document.querySelector(`#m-prio-tabs [data-prio="${c}"]`)?.click(); await new Promise((r) => setTimeout(r, 400)); const b = document.querySelector('#m-loops-see'); const cards = [...document.querySelectorAll('#m-loop-grid [data-loop]')].map((x) => ({ id: x.dataset.loop, text: x.innerText.replace(/\s+/g, ' ') })); return { on: document.querySelector('#m-prio-tabs .on')?.dataset.prio, total: document.querySelector('#m-loop-total')?.textContent || '', cards, empty: document.querySelector('#m-loop-grid .m-empty')?.innerText || '' }; }, chip);
    }
    await page.evaluate(() => document.querySelector('#m-prio-tabs [data-prio="week"]')?.click());
    out.mobile.fetchedIds = [...fetchedIds];
    out.mobile.priorityAll = await page.evaluate(async () => { const b = document.querySelector('#m-loops-see'); if (b && !b.hidden) { b.click(); await new Promise((r) => setTimeout(r, 800)); } return [...document.querySelectorAll('#loops-pop-body [data-loop], #loops-pop-body [data-open-loop]')].map((c) => ({ id: c.dataset.loop || c.dataset.openLoop, text: c.innerText.replace(/\s+/g, ' ') })); });
    await page.evaluate(() => document.querySelector('[data-loops-close]')?.click());
    out.mobile.money = await page.evaluate(() => { window.DaylightMoneyUI.open(); const o = {}; document.querySelectorAll('#fin-body .fin-sec').forEach((s) => { o[s.querySelector('h4 span')?.textContent] = [...s.querySelectorAll('.fin-row')].map((r) => r.innerText.replace(/\s+/g, ' ').slice(0, 90)); }); window.DaylightMoneyUI.close(); return o; });
    // Inbox: every tab
    await clickTab(page, 'inbox');
    out.mobile.inbox = {};
    for (const f of ['all', 'subscriptions', 'payments', 'receipts', 'bills', 'tickets', 'important', 'promotions']) {
      await page.evaluate((x) => document.querySelector(`#m-inbox-tabs [data-inbox="${x}"]`)?.click(), f); await page.waitForTimeout(500);
      out.mobile.inbox[f] = await page.evaluate(() => [...document.querySelectorAll('#m-inbox .m-inbox-sec')].flatMap((sec) => [...sec.querySelectorAll('[data-inbox-open]')].map((c) => ({ section: sec.querySelector('h3')?.textContent || '', id: c.dataset.inboxOpen, title: c.querySelector('b')?.textContent || '', time: c.querySelector('time')?.textContent || '', snippet: c.querySelector('small')?.textContent || '', tag: c.querySelector('.m-pill-tag')?.textContent || '', unreadMark: /unread/i.test(c.className + c.innerHTML) }))));
    }
    out.mobile.inboxHasSearch = await page.evaluate(() => !!document.querySelector('#m-inbox-search, [data-inbox-search], input[type=search]'));
    await page.evaluate(() => document.querySelector('#m-inbox-tabs [data-inbox="all"]')?.click());
    // open first card → is there a link to the original Gmail message?
    out.mobile.inboxDetail = await page.evaluate(async () => { const c = document.querySelector('#m-inbox [data-inbox-open="t-novak"]') || document.querySelector('#m-inbox [data-inbox-open]'); if (!c) return null; c.click(); await new Promise((r) => setTimeout(r, 900)); const links = [...document.querySelectorAll('a[href*="mail.google.com"]')].filter((a) => a.offsetParent !== null).map((a) => a.href); const btns = [...document.querySelectorAll('button, a')].filter((b) => b.offsetParent !== null && /gmail|open email|open in/i.test(b.textContent)).map((b) => b.textContent.trim()).slice(0, 5); const sheetText = (document.querySelector('#loop-sheet')?.innerText || '').replace(/\s+/g, ' ').slice(0, 400); return { id: c.dataset.inboxOpen, gmailLinks: links.slice(0, 3), openButtons: btns, sheetText }; });
    await page.keyboard.press('Escape'); await page.evaluate(() => { document.querySelectorAll('[data-close],[data-loop-close],.m-sheet-close,[data-fin-close]').forEach((b) => { try { if (b.offsetParent) b.click(); } catch {} }); });
    // Wallet
    await clickTab(page, 'wallet');
    out.mobile.wallet = await page.evaluate(() => ({ dom: [...document.querySelectorAll('#m-wallet .m-wallet-sec')].map((sec) => ({ section: sec.querySelector('h3')?.innerText || '', passes: [...sec.querySelectorAll('[data-wid]')].map((p) => ({ wid: p.dataset.wid, text: p.innerText.replace(/\s+/g, ' ') })) })), store: JSON.parse(localStorage.getItem('daylight-wallet') || '[]') }));
    // Timeline (today + Nov 16 + Dec 3)
    await clickTab(page, 'assistant');
    const tl = async () => page.evaluate(() => [...document.querySelectorAll('#tl-list .tl-card')].map((c) => ({ time: c.querySelector('time')?.textContent || '', title: c.querySelector('b')?.textContent || '', meta: c.querySelector('small')?.textContent || '', href: c.dataset.tlHref || '', walletId: c.dataset.walletId || '', mailId: c.dataset.mailId || '', loop: c.dataset.openLoop || '' })));
    out.mobile.timelineToday = await tl();
    for (const d of ['2026-11-16', '2026-11-21', '2026-12-03']) {
      await page.evaluate(async (day) => { const [y, m, dd] = day.split('-').map(Number); const target = new Date(y, m - 1, dd); for (let i = 0; i < 8; i++) { const b = document.querySelector(`[data-tl-day="${day}"]`); if (b) { b.click(); return; } document.querySelector('[data-tl-wk="1"]')?.click(); await new Promise((r) => setTimeout(r, 700)); } }, d);
      await page.waitForTimeout(1500);
      out.mobile['timeline_' + d] = { heading: await page.evaluate(() => document.querySelector('#tl-heading')?.textContent || ''), items: await tl() };
    }
    out.mobile.calendarRequests = calLog.slice();
    // changed + cancelled events, then a manual refresh
    mutateCalendar();
    await clickTab(page, 'home');
    await page.evaluate(() => { document.querySelector('#sync-status').textContent = 'x refreshing'; document.querySelector('#refresh').click(); }); await settle(page);
    out.mobile.afterChange = { schedule: await page.evaluate(() => [...document.querySelectorAll('#m-schedule-rail li')].map((li) => li.innerText.replace(/\s+/g, ' '))) };
    await clickTab(page, 'assistant');
    await page.evaluate(() => document.querySelector('[data-tl-day="2026-11-04"]')?.click()); await page.waitForTimeout(1500);
    out.mobile.afterChange.timeline = await tl();
    await clickTab(page, 'inbox');
    out.mobile.afterChange.inboxAllCount = await page.evaluate(() => document.querySelectorAll('#m-inbox [data-inbox-open]').length);
    out.mobile.pageErrors = errs;
    // ---------------- desktop ----------------
    calLog.length = 0;
    delete require.cache[require.resolve('./home-audit-scenario.js')];
    Object.assign(S, require('./home-audit-scenario.js')); calStore.primary = S.CALENDAR; calStore['family@group.calendar.google.com'] = S.SECONDARY;
    const g2 = makeGmail();
    const d = await newPage(browser, g2, { width: 1440, height: 1000 }, false);
    out.desktop = await d.page.evaluate(() => ({
      summary: document.querySelector('#smart-summary')?.innerText || '',
      chips: [...document.querySelectorAll('#smart-chips > *')].map((c) => ({ text: c.innerText, href: c.getAttribute('href') || '' })),
      calendar: [...document.querySelectorAll('#events > *')].map((e) => ({ text: e.innerText.replace(/\s+/g, ' '), href: e.querySelector('a')?.getAttribute('href') || e.getAttribute('href') || '' })),
      eventCount: document.querySelector('#event-count')?.textContent || '',
      timeline: [...document.querySelectorAll('#timeline .tl-event')].map((e) => e.getAttribute('title')),
      loops: [...document.querySelectorAll('#loop-grid > *')].map((e) => ({ text: e.innerText.replace(/\s+/g, ' ').slice(0, 160), href: e.querySelector('a[href]')?.getAttribute('href') || '' })),
      headline: document.querySelector('#headline-note')?.innerText || ''
    }));
    out.desktop.calendarRequests = calLog.slice();
    out.desktop.pageErrors = d.errs;
  } finally { await browser.close(); srv.close(); }
  fs.writeFileSync(path.join(__dirname, 'home-audit-raw.json'), JSON.stringify(out, null, 2));
  console.log('written tests/home-audit-raw.json');
})().catch((e) => { console.error(e); process.exitCode = 1; });
