/**
 * Daylight Phase 2 — browser end-to-end check of financial intelligence in the REAL app.
 * Serves the app, mocks Google with the 58 single-email fixtures from finance-intel-suite.js
 * (receipts, refunds, promos, unpaid bills, …) and checks what the user sees and what is stored:
 *  - no task is created automatically; legacy auto "Pay" tasks are shown as unconfirmed suggestions;
 *  - Home payments / Money "To pay" contain only obligations with a written due date;
 *  - receipts, refunds and promotions never appear as payments to make;
 *  - corrections and dismissals persist across reloads; confirming a suggestion creates exactly one task;
 *  - repeated refreshes do not duplicate financial records; preview (demo) mode writes no ledger.
 * Run: node tests/phase2-finance-e2e.js   (synthetic data only)
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const S = require('./finance-intel-suite.js');
const F = require('../finance-intel.js');

const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.test';
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

// Re-date fixtures to "now" so due dates keep their relation to today
const shift = Date.now() - S.NOW;
const fixtures = S.C.map((c) => {
  const m = JSON.parse(JSON.stringify(c.m));
  m.internalDate = String(Number(m.internalDate) + shift);
  return { ...c, m };
});
const byId = new Map(fixtures.map((f) => [f.m.id, f]));
const legacyTasks = [
  { id: 'legacy-1', title: 'Pay Revolut · €100,000', dueDate: '', project: 'Payments', suggested: true, mailId: 'x1', created: '2026-11-01T10:00:00Z' },
  { id: 'legacy-2', title: 'Pay Anthropic, PBC · $11.80', dueDate: new Date(Date.now() - 3 * 864e5).toISOString(), project: 'Payments', suggested: true, mailId: 'x2', created: '2026-11-01T10:00:00Z' },
  { id: 'legacy-3', title: 'Pay Office, Department of Physics', dueDate: new Date().toISOString(), project: 'Payments', suggested: true, mailId: 'x3', created: '2026-11-01T10:00:00Z' },
  { id: 'user-1', title: 'Pay rent', dueDate: new Date().toISOString(), project: '', created: '2026-11-01T10:00:00Z' }
];

function serve(dir, port) {
  return new Promise((r) => {
    const srv = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(dir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); });
    srv.listen(port, '127.0.0.1', () => r(srv));
  });
}
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let gmailCalls = 0; const fetchedIds = new Set();
async function mockGoogle(page) {
  await page.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.origin === WORKER) return json(route, 200, { access_token: 'fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', gmail_readonly: true });
    if (u.hostname === 'gmail.googleapis.com') {
      gmailCalls++;
      const p = u.pathname.replace('/gmail/v1/users/me', '');
      if (p === '/profile') return json(route, 200, { historyId: '900' });
      if (p === '/messages') { const max = Number(u.searchParams.get('maxResults') || 100), start = Number(u.searchParams.get('pageToken') || 0), page = fixtures.slice(start, start + max); return json(route, 200, { messages: page.map((f) => ({ id: f.m.id, threadId: f.m.threadId })), nextPageToken: start + max < fixtures.length ? String(start + max) : undefined, resultSizeEstimate: fixtures.length }); }
      if (p.startsWith('/messages/')) {
        const f = byId.get(decodeURIComponent(p.split('/')[2])); if (f) fetchedIds.add(f.m.id); if (!f) return json(route, 404, { error: { code: 404 } });
        const full = u.searchParams.get('format') === 'full';
        const m = full ? f.m : { ...f.m, payload: { mimeType: f.m.payload.mimeType, headers: f.m.payload.headers } };
        return json(route, 200, m);
      }
      if (p === '/threads') return json(route, 200, { threads: [] });
      if (p === '/history') return json(route, 200, { history: [], historyId: '900' });
      return json(route, 404, {});
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '42', email: 'test@example.com', name: 'Test User' });
    if (u.hostname === 'www.googleapis.com' && u.pathname.includes('/calendar/')) return json(route, u.pathname.includes('calendarList') ? 403 : 200, { items: [] });
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/drive/')) return json(route, 200, { files: [] });
    if (u.hostname === 'tasks.googleapis.com') return json(route, 200, { items: u.pathname.endsWith('/lists') ? [{ id: 'L1', title: 'My Tasks' }] : [] });
    if (u.hostname === 'people.googleapis.com') return json(route, 200, { connections: [] });
    return route.abort('blockedbyclient');
  });
}
async function settle(page) {
  await page.waitForFunction(() => /updated|Partial sync|Sync failed/.test(document.querySelector('#sync-status')?.textContent || '') && !/refreshing/.test(document.querySelector('#sync-status')?.textContent || ''), null, { timeout: 120000 });
  await page.waitForTimeout(800);
}
const state = (page) => page.evaluate(() => {
  const tasks = JSON.parse(localStorage.getItem('daylight-personal-tasks') || '[]');
  const ledgerKey = Object.keys(localStorage).find((k) => k.startsWith('daylight-finance-ledger'));
  const ledger = ledgerKey ? JSON.parse(localStorage.getItem(ledgerKey)) : null;
  return { tasks: tasks.map((t) => ({ id: t.id, title: t.title, suggested: !!t.suggested, financeConfirmed: !!t.financeConfirmed })), ledgerKey, ledgerCount: ledger ? ledger.length : null, ledgerKeys: ledger ? ledger.map((r) => r.key) : [], corrections: JSON.parse(localStorage.getItem('daylight-finance-corrections') || '{}') };
});
const sheet = (page) => page.evaluate(() => {
  window.DaylightMoneyUI.open();
  const secs = [...document.querySelectorAll('#fin-body .fin-sec')].map((s) => ({ title: s.querySelector('h4 span')?.textContent, count: +s.querySelector('h4 span:last-child')?.textContent, rows: [...s.querySelectorAll('.fin-row')].map((r) => ({ key: r.dataset.finOpen || null, text: r.innerText.replace(/\s+/g, ' ').slice(0, 140) })) }));
  return secs;
});

(async () => {
  const srv = await serve(appDir, 8777);
  const browser = await chromium.launch();
  const checks = []; const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.log('  FAIL', name, JSON.stringify(detail).slice(0, 400)); };
  const errs = [];
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(({ w, legacy }) => {
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-personal-tasks', JSON.stringify(legacy)); sessionStorage.setItem('seeded', '1'); }
    }, { w: WORKER, legacy: legacyTasks });
    const page = await ctx.newPage(); await mockGoogle(page);
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('http://127.0.0.1:8777/index.html?ui=v1', { waitUntil: 'domcontentloaded' });
    await settle(page);
    const s1 = await state(page);
    // ---- expected ledger computed by the engine on the same fixtures
    const expLedger = F.buildLedger(fixtures.filter((f) => fetchedIds.has(f.m.id)).map((f) => F.classify(f.m)), { now: Date.now() });
    const keysOf = (b) => expLedger.records.filter((r) => r.bucket === b).map((r) => r.key).sort();
    const expOut = keysOf('outstanding'), expUp = keysOf('upcoming'), expDue = [...expOut, ...expUp];
    const negIds = new Set(fixtures.filter((f) => f.exp.neg).map((f) => f.m.id));

    ck('App fetched most fixtures (mail window)', fetchedIds.size >= 40, { fetched: fetchedIds.size, of: fixtures.length });
    ck('No task created automatically (4 seeded → 4)', s1.tasks.length === 4, s1.tasks.map((t) => t.title));
    const secs = await sheet(page);
    const sec = (t) => secs.find((x) => x.title === t) || { count: 0, rows: [] };
    const keysIn = (t) => sec(t).rows.map((r) => r.key).filter(Boolean).sort();
    const dueKeys = [...keysIn('To pay now'), ...keysIn('Upcoming')];
    ck('Money “To pay now” equals the engine’s outstanding records', JSON.stringify(keysIn('To pay now')) === JSON.stringify(expOut), { ui: keysIn('To pay now'), exp: expOut });
    ck('Money “Upcoming” equals the engine’s upcoming records', JSON.stringify(keysIn('Upcoming')) === JSON.stringify(expUp), { ui: keysIn('Upcoming'), exp: expUp, whereMissing: expUp.filter((k) => !keysIn('Upcoming').includes(k)).map((k) => [k, (secs.find((x) => x.rows.some((r) => r.key === k)) || {}).title || 'absent']), stored: await page.evaluate((ks) => { const k = Object.keys(localStorage).find((x) => x.startsWith('daylight-finance-ledger')); const L = k ? JSON.parse(localStorage.getItem(k)) : []; return L.filter((r) => ks.includes(r.key)).map((r) => [r.key, r.category, r.bucket, r.status]); }, expUp.filter((k) => !keysIn('Upcoming').includes(k))) });
    const recOf = (k) => expLedger.records.find((r) => r.key === k) || {};
    const actionable = (k) => recOf(k).category === 'unpaid_bill' && recOf(k).status === 'unpaid';
    const negInDue = dueKeys.filter((k) => (recOf(k).mailIds || []).some((id) => negIds.has(id)) && (actionable(k) || recOf(k).suggestion));
    ck('No negative-set email (receipt, refund, promo, paid invoice, …) is a payment to make', negInDue.length === 0, negInDue);
    ck('Every “To pay” item has a written due date in the email', dueKeys.filter(actionable).every((k) => recOf(k).dueDate && recOf(k).dueDateRaw), dueKeys.filter(actionable).map((k) => [k, recOf(k).dueDateRaw]));
    ck('Direct-debit and processing payments shown as Upcoming with no reminder offered', dueKeys.filter((k) => !actionable(k) && recOf(k).category !== 'subscription_renewal').every((k) => !recOf(k).suggestion), dueKeys.filter((k) => !actionable(k)));
    ck('Refunds shown under Refunded, never To pay', sec('Refunded').count >= 4 && !dueKeys.some((k) => /refund/.test(recOf(k).category || '')), sec('Refunded'));
    ck('Paid invoice + its earlier unpaid invoice merged into one paid record', sec('Paid').rows.some((r) => /ČEZ/.test(r.text)) && !dueKeys.some((k) => /2026104455/.test(k)), sec('Paid').rows.filter((r) => /ČEZ/.test(r.text)));
    ck('Legacy auto Pay tasks listed as unconfirmed (3)', sec('Old automatic payment tasks (unconfirmed)').count === 3, sec('Old automatic payment tasks (unconfirmed)'));
    ck('Needs review section present with uncertain bills', sec('Needs review').count >= 3, sec('Needs review').rows.map((r) => r.text));

    // Home: payments only from obligations (+ the user-created task)
    await page.evaluate(() => window.DaylightMoneyUI.close());
    const home = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    const brief = await page.evaluate(() => document.querySelector('#smart-summary')?.innerText || '');
    ck('Home briefing does not lead with or count old automatic Pay tasks', !/Revolut · €100,000|Anthropic, PBC|Office, Department/.test(brief), brief);
    const nOut = expOut.length + 1; // + the user's own “Pay rent” task due today
    ck('Home briefing counts only real payments to make this week', new RegExp(`${nOut} payments? to make`).test(brief) && !/pending payments/.test(brief), { brief, expected: nOut });

    // Correction: mark the first review record as paid invoice → persists after reload
    const reviewKey = sec('Needs review').rows.find((r) => r.key)?.key;
    await page.evaluate((k) => { window.DaylightMoneyUI.open(k); }, reviewKey);
    await page.evaluate((k) => { const sel = document.querySelector('#fin-sheet select[data-fin-correct]'); sel.value = 'paid_invoice'; sel.dispatchEvent(new Event('change', { bubbles: true })); }, reviewKey);
    await page.waitForTimeout(300);
    const afterCorr = await state(page);
    ck('Correction saved', Object.values(afterCorr.corrections).some((c) => c.category === 'paid_invoice'), afterCorr.corrections);

    // Confirm a suggestion → exactly one task; clicking again → no duplicate
    const sugKey = expLedger.records.find((r) => r.suggestion && dueKeys.includes(r.key))?.key;
    await page.evaluate((k) => { window.DaylightMoneyUI.open(k); document.querySelector(`#fin-sheet [data-fin-confirm="${CSS.escape(k)}"]`)?.click(); }, sugKey);
    await page.waitForTimeout(300);
    await page.evaluate((k) => { window.DaylightMoneyUI.open(k); document.querySelector(`#fin-sheet [data-fin-confirm="${CSS.escape(k)}"]`)?.click(); }, sugKey);
    await page.waitForTimeout(300);
    const afterConfirm = await state(page);
    ck('Confirming a suggestion creates exactly one confirmed task', afterConfirm.tasks.filter((t) => t.financeConfirmed).length === 1 && afterConfirm.tasks.length === 5, afterConfirm.tasks);

    // Dismiss a review record
    const dismissKey = sec('Needs review').rows.map((r) => r.key).filter(Boolean).find((k) => k !== reviewKey);
    await page.evaluate((k) => { window.DaylightMoneyUI.open(k); document.querySelector(`#fin-sheet [data-fin-dismiss]`)?.click(); }, dismissKey);
    await page.waitForTimeout(300);

    // Repeated refreshes: no duplicate records
    const before = (await state(page)).ledgerCount;
    for (let i = 0; i < 2; i++) { await page.evaluate(() => { document.querySelector('#sync-status').textContent = 'x refreshing'; document.querySelector('#refresh').click(); }); await settle(page); }
    const s2 = await state(page);
    ck('Repeated refreshes keep the same number of financial records', s2.ledgerCount === before && new Set(s2.ledgerKeys).size === s2.ledgerKeys.length, { before, after: s2.ledgerCount });

    // Reload: corrections, dismissals and confirmed reminder persist; still no automatic task
    await page.reload({ waitUntil: 'domcontentloaded' }); await settle(page);
    const s3 = await state(page); const secs3 = await sheet(page);
    const sec3 = (t) => secs3.find((x) => x.title === t) || { count: 0, rows: [] };
    ck('After reload: corrected record is under Paid', sec3('Paid').rows.some((r) => r.key === reviewKey), sec3('Paid').rows.map((r) => r.key));
    ck('After reload: dismissed record is under Dismissed', sec3('Dismissed').rows.some((r) => r.key === dismissKey), sec3('Dismissed'));
    ck('After reload: still exactly one confirmed task, no automatic tasks', s3.tasks.length === 5 && s3.tasks.filter((t) => t.financeConfirmed).length === 1, s3.tasks.map((t) => t.title));

    // Mobile inbox: receipts/refunds are not tagged as due
    const mctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mctx.addInitScript(({ w }) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); sessionStorage.setItem('seeded', '1'); } }, { w: WORKER });
    const mp = await mctx.newPage(); await mockGoogle(mp); mp.on('pageerror', (e) => errs.push('mobile: ' + e.message));
    await mp.goto('http://127.0.0.1:8777/index.html?ui=v1', { waitUntil: 'domcontentloaded' }); await settle(mp);
    await mp.evaluate(() => document.querySelector('[data-tab="inbox"]').click()); await mp.waitForTimeout(1200);
    const cards = await mp.evaluate(() => [...document.querySelectorAll('.m-swipe')].map((c) => c.innerText.split('\n').filter((x) => x && !/^(Snooze|Task|Done)$/.test(x)).join(' · ').slice(0, 160)));
    const badTags = cards.filter((t) => /(receipt|refund|You paid|Payment received|platba proběhla|Zahlung erhalten)/i.test(t) && /(Due |Overdue|Pending)/.test(t));
    ck('Mobile inbox: no receipt/refund/payment-confirmation tagged Due/Overdue/Pending', badTags.length === 0 && cards.length > 10, { badTags, n: cards.length });
    const homeM = await mp.evaluate(() => { document.querySelector('[data-tab="home"]').click(); return new Promise((r) => setTimeout(() => r(document.body.innerText.replace(/\s+/g, ' ').slice(0, 600)), 1000)); });
    await mctx.close();

    // Demo / preview mode writes no ledger and creates no tasks
    const dctx = await browser.newContext({ serviceWorkers: 'block' });
    const dp = await dctx.newPage(); await dp.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()); dp.on('pageerror', (e) => errs.push('demo: ' + e.message));
    await dp.goto('http://127.0.0.1:8777/index.html?demo=1', { waitUntil: 'load' }); await dp.waitForTimeout(3500);
    const ds = await state(dp);
    ck('Demo mode: no financial ledger stored, no automatic tasks', !ds.ledgerKey && ds.tasks.length === 0, ds);
    await dctx.close();

    ck('No page errors', errs.length === 0, errs);
    const report = { generatedAt: new Date().toISOString(), gmailCalls, expectedObligations: expDue, homeMobile: homeM, checks, passed: checks.filter((c) => c.ok).length, total: checks.length };
    fs.writeFileSync(path.join(__dirname, 'phase2-finance-e2e-report.json'), JSON.stringify(report, null, 2));
    console.log(`Phase 2 finance E2E: ${report.passed}/${report.total} checks passed`);
    if (report.passed !== report.total) process.exitCode = 1;
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
