/** Responsive layout check: phone, tablet, laptop in light + dark with the synthetic Home scenario. Writes tests/responsive-*.png and tests/responsive-report.json. Read-only, mocked Google. */
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
    if (u.origin === WORKER) return json(route, 200, { access_token: 'fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks.readonly', gmail_readonly: true });
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
  await page.goto('http://127.0.0.1:8781/index.html', { waitUntil: 'domcontentloaded' });
  await settle(page);
  return { ctx, page, errs };
}
const clickTab = async (page, t) => { await page.evaluate((x) => document.querySelector(`[data-tab="${x}"]`)?.click(), t); await page.waitForTimeout(1500); };

(async () => {
  const srv = await serve(appDir, 8781);
  const browser = await chromium.launch();
  const report = {};
  const sizes = [['phone', { width: 390, height: 844 }, true], ['tablet', { width: 834, height: 1112 }, true], ['laptop', { width: 1440, height: 900 }, false]];
  const only = process.argv[2];
  try {
    for (const [name, vp, mob] of sizes) {
      if (only && only !== name) continue;
      const { ctx, page, errs } = await newPage(browser, makeGmail(), vp, mob);
      await clickTab(page, 'home');
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => { document.body.classList.toggle('dark', t === 'dark'); }, theme);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(__dirname, `responsive-${name}-${theme}.png`) });
      }
      await page.evaluate(() => document.body.classList.remove('dark'));
      const info = await page.evaluate(() => {
        const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), display: cs.display, vis: cs.visibility, op: cs.opacity }; };
        return { m: document.body.classList.contains('m'), tabs: r('.m-tabs'), mapp: r('#mapp'), brief: r('#m-brief'), widgets: r('.layout'), hscroll: document.documentElement.scrollWidth > innerWidth + 1, bodyBg: getComputedStyle(document.body).backgroundColor };
      });
      // scroll behaviour: scroll down → bar hides; scroll up → bar returns
      const scroll = {};
      for (const tab of ['home', 'inbox', 'wallet', 'assistant']) {
        await clickTab(page, tab);
        const sc = await page.evaluate(async () => {
          const se = document.querySelector('#mapp .m-screen.is-active') || document.scrollingElement; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          se.scrollTop = 0; await wait(200);
          for (let i = 1; i <= 8; i++) { se.scrollTop = i * 60; await wait(40); }
          await wait(300); const afterDown = document.body.classList.contains('tabs-hide'); const max = se.scrollHeight - se.clientHeight;
          for (let i = 1; i <= 4; i++) { se.scrollTop = 480 - i * 40; await wait(40); }
          await wait(300); const afterUp = document.body.classList.contains('tabs-hide');
          se.scrollTop = 0; await wait(200);
          return { scrollable: max, hiddenAfterDown: afterDown, hiddenAfterUp: afterUp };
        });
        scroll[tab] = sc;
      }
      for (const tab of ['inbox', 'wallet']) { await clickTab(page, tab); await page.screenshot({ path: path.join(__dirname, `responsive-${name}-${tab}.png`) }); }
      // sheets / panels at this size
      await clickTab(page, 'home');
      const shoot = async (label, sel) => { await page.evaluate((q) => { const e = document.querySelector(q); e && e.click(); }, sel); await page.waitForTimeout(900); await page.screenshot({ path: path.join(__dirname, `responsive-${name}-${label}.png`) }); await page.keyboard.press('Escape'); await page.waitForTimeout(700); await page.evaluate(() => history.length && document.querySelector('.overlay.show,.loop-sheet.show,.notif-panel.show,.brief-pop.show') && history.back()); await page.waitForTimeout(700); };
      await shoot('sheet', '#m-loop-grid [data-loop]');
      await shoot('notif', '#m-bell');
      report[name] = { info, scroll, errors: errs };
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  fs.writeFileSync(path.join(__dirname, 'responsive-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
})();
