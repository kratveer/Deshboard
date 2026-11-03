/**
 * Daylight Phase 1 — browser end-to-end check of the REAL app (index.html + app.js) with Google mocked.
 *
 * - Serves the app folder on localhost, blocks external CDNs, and answers Gmail with the fake Gmail
 *   from gmail-sync-sim.js (real clock, 6,000 units/min/user quota, fault injection).
 * - Mocks the Daylight worker token endpoint and the other Google APIs (empty calendar/tasks/drive/contacts).
 * - Asserts what the USER sees: the status line, the drawer sync card and the stored sync state.
 * - Optionally runs the same scenarios against the baseline build (--baseline <dir>) for before/after.
 *
 * Run: node tests/phase1-browser-e2e.js [--baseline ../base]
 * Synthetic data only; no real accounts or tokens.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { makeGmail } = require('./gmail-sync-sim.js');

const args = process.argv.slice(2);
const baselineDir = args.includes('--baseline') ? path.resolve(args[args.indexOf('--baseline') + 1]) : null;
const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

function serve(dir, port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let f = path.join(dir, decodeURIComponent(u.pathname));
    if (u.pathname.endsWith('/')) f = path.join(f, 'index.html');
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function scenario(browser, port, name, setup) {
  const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const gmail = makeGmail({ clock, size: 600, seed: 11, latencyMs: 40 });
  const env = { worker: { status: 200 }, netDrop: null };
  if (setup) setup({ gmail, env });
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((w) => {
    if (!sessionStorage.getItem('dl-seeded')) {
      localStorage.setItem('daylight-api', w);
      localStorage.setItem('daylight-session', 'S'.repeat(43));
      sessionStorage.setItem('dl-seeded', '1');
    }
  }, WORKER);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) consoleErrors.push(m.text()); });
  const counts = { gmail: 0, gmailAborted: 0, worker: 0 };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.origin === WORKER) {
      counts.worker++;
      if (u.pathname === '/api/google/token') {
        if (env.worker.status !== 200) return json(route, env.worker.status, { error: env.worker.status === 401 ? 'reauth' : 'google_unavailable' });
        return json(route, 200, { access_token: 'fake-access-token', expires_in: 3600, email: 'test@example.com', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/tasks.readonly https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/contacts.readonly', gmail_readonly: true, gmail_send: true, needs_gmail_upgrade: false });
      }
      return json(route, 404, {});
    }
    if (u.hostname === 'gmail.googleapis.com') {
      counts.gmail++;
      if (env.netDrop && Date.now() < env.netDrop.until && Math.random() < env.netDrop.rate) { counts.gmailAborted++; return route.abort('failed'); }
      try {
        const r = await gmail.transport(req.url());
        const headers = { ...CORS, 'Content-Type': 'application/json' };
        if (r.retryAfter != null) headers['Retry-After'] = String(r.retryAfter);
        return route.fulfill({ status: r.status, headers, body: JSON.stringify(r.body || {}) });
      } catch { counts.gmailAborted++; return route.abort('failed'); }
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '1234567890', email: 'test@example.com', name: 'Test User' });
    if (u.hostname === 'www.googleapis.com' && u.pathname.includes('/calendarList')) return json(route, 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } });
    if (u.hostname === 'www.googleapis.com' && u.pathname.includes('/calendar/')) return json(route, 200, { items: [], timeZone: 'Europe/Prague' });
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/drive/')) return json(route, 200, { files: [] });
    if (u.hostname === 'tasks.googleapis.com' && u.pathname.endsWith('/lists')) return json(route, 200, { items: [{ id: 'L1', title: 'My Tasks' }] });
    if (u.hostname === 'tasks.googleapis.com') return json(route, 200, { items: [] });
    if (u.hostname === 'people.googleapis.com') return json(route, 200, { connections: [] });
    return route.abort('blockedbyclient'); // CDNs, fonts, favicons, markets
  });

  const t0 = Date.now();
  gmail.resetStats();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  const settle = async (timeoutMs) => {
    await page.waitForFunction(() => {
      const s = document.querySelector('#sync-status')?.textContent || '';
      return /updated|Partial sync|Sync failed|sign-in expired|needs refresh|could not load/i.test(s) && !/refreshing/i.test(s);
    }, null, { timeout: timeoutMs || 120000 }).catch(() => {});
    await page.waitForTimeout(700);
  };
  await settle();
  const snap = async () => page.evaluate(async () => {
    const status = document.querySelector('#sync-status')?.textContent || '';
    const drawer = { title: document.querySelector('#drawer-sync-title')?.textContent || '', meta: document.querySelector('#drawer-sync-meta')?.textContent || '' };
    let sync = null;
    try {
      const S = window.DaylightStore; const id = await S.getActiveAccountId(); const st = await S.getSyncState(id);
      const g = st.gmail || {};
      sync = { accountId: id, lastSuccessAt: g.lastSuccessAt, lastPartialAt: g.lastPartialAt || null, lastError: g.lastError, mode: g.mode, cursor: !!g.cursor, runs: g.runs, records: g.details?.records || null, sent: g.details?.sent || null, queryErrors: g.details?.queryErrors ?? null, failures: g.details?.failures || null, units: g.details?.units ?? null, requests: g.details?.requests ?? null };
    } catch (e) { sync = { error: String(e) }; }
    return { status, drawer, sync, hasSession: !!localStorage.getItem('daylight-session') };
  });
  const first = await snap();
  const firstStats = { byKind: { ...gmail.stats.byKind }, requests: gmail.stats.calls, quotaUnits: gmail.stats.units, quota403: gmail.stats.rejectedQuota, injected: gmail.stats.injected, aborted: counts.gmailAborted, peakConcurrent: gmail.stats.peakConcurrent, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  const out = { name, first, firstStats };
  if (setup && setup.after) out.after = await setup.after({ page, gmail, env, settle, snap, counts });
  out.consoleErrors = consoleErrors.slice(0, 5);
  await ctx.close();
  return out;
}

async function runAll(dir, port, label) {
  const srv = await serve(dir, port);
  const browser = await chromium.launch();
  const res = {};
  const S = (n, setup) => scenario(browser, port, n, setup).then((r) => { res[n] = r; console.log(`[${label}] ${n}: ${r.first.status.slice(0, 150)}`); });
  try {
    // E1 healthy refresh, then a manual refresh 5 s later, then a reload (persistence of "last full sync")
    const e1 = ({ gmail }) => {};
    e1.after = async ({ page, gmail, settle, snap }) => {
      await page.waitForTimeout(5000);
      gmail.resetStats();
      await page.evaluate(() => { document.querySelector('#sync-status').textContent = 'manual check · refreshing'; document.querySelector('#refresh').click(); });
      await settle();
      const manual = { ...(await snap()), byKind: { ...gmail.stats.byKind }, requests: gmail.stats.calls, quotaUnits: gmail.stats.units, quota403: gmail.stats.rejectedQuota };
      gmail.resetStats();
      await page.reload({ waitUntil: 'domcontentloaded' });
      const early = await page.evaluate(() => new Promise((r) => setTimeout(() => r({ title: document.querySelector('#drawer-sync-title')?.textContent, meta: document.querySelector('#drawer-sync-meta')?.textContent }), 300)));
      await settle();
      return { manualRefresh: manual, reload: { drawerEarly: early, ...(await snap()), requests: gmail.stats.calls, quotaUnits: gmail.stats.units } };
    };
    await S('E1_healthy', e1);
    // E2 three messages permanently failing (503) → must be reported partial, never "updated"
    await S('E2_permanent_failures', ({ gmail }) => {
      const victims = gmail.msgs().filter((m) => m.labels.includes('INBOX')).slice(2, 5).map((m) => m.id);
      gmail.faults.rules.push({ type: '503', rate: 1, match: (u, kind) => kind.startsWith('get') && victims.some((v) => u.pathname.endsWith('/' + v)) });
    });
    // E3 429 storm for 6 s (Retry-After: 1) → retries, then complete
    await S('E3_429_storm', ({ gmail }) => { gmail.faults.rules.push({ type: '429', rate: 0.4, retryAfter: 1, until: Date.now() + 6000 }); });
    // E4 network interruption: 30% of Gmail requests dropped for 6 s
    await S('E4_network_drops', ({ env }) => { env.netDrop = { rate: 0.3, until: Date.now() + 6000 }; });
    // E5 quota mostly used by another tab (5,600 / 6,000 units in the last minute)
    await S('E5_quota_exhausted', ({ gmail }) => { gmail.preload(5600); });
    // E8 recovery semantics across a reload: full sync, then failures appear, reload → partial + previous full-sync time;
    //    then failures clear and a manual refresh → back to "updated".
    const e8 = () => {};
    e8.after = async ({ page, gmail, settle, snap }) => {
      const victims = gmail.msgs().filter((m) => m.labels.includes('INBOX')).slice(0, 2).map((m) => m.id);
      gmail.faults.rules.push({ type: '503', rate: 1, match: (u, kind) => kind.startsWith('get') && victims.some((v) => u.pathname.endsWith('/' + v)) });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle();
      const afterReload = await snap();
      gmail.faults.rules.length = 0;
      await page.evaluate(() => { document.querySelector('#sync-status').textContent = 'manual · refreshing'; document.querySelector('#refresh').click(); });
      await settle();
      return { afterReload, afterRecovery: await snap() };
    };
    await S('E8_reload_partial_then_recover', e8);
    // E6 Google sign-in expired at the worker (401) → reconnect prompt
    await S('E6_worker_401', ({ env }) => { env.worker.status = 401; });
    // E7 temporary worker/Google outage (502) — documents the Phase 4 issue (session cleared)
    await S('E7_worker_502', ({ env }) => { env.worker.status = 502; });
  } finally { await browser.close(); srv.close(); }
  return res;
}

(async () => {
  const report = { generatedAt: new Date().toISOString(), phase1: await runAll(appDir, 8765, 'phase1') };
  if (baselineDir) report.baseline = await runAll(baselineDir, 8766, 'baseline');
  // Assertions on the Phase 1 build
  const p = report.phase1, checks = [];
  const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.log('  FAIL', name, JSON.stringify(detail).slice(0, 300)); };
  ck('E1 status says updated', /Connected to Google · updated/.test(p.E1_healthy.first.status), p.E1_healthy.first.status);
  ck('E1 zero quota 403s', p.E1_healthy.firstStats.quota403 === 0, p.E1_healthy.firstStats);
  ck('E1 units < 6,000', p.E1_healthy.firstStats.quotaUnits < 6000, p.E1_healthy.firstStats.quotaUnits);
  ck('E1 stored sync = success with records', p.E1_healthy.first.sync.lastSuccessAt && p.E1_healthy.first.sync.records && !p.E1_healthy.first.sync.lastPartialAt, p.E1_healthy.first.sync);
  ck('E1 manual refresh re-fetches no unchanged mail (only queued bodies)', !p.E1_healthy.after.manualRefresh.byKind.getMeta && (p.E1_healthy.after.manualRefresh.byKind.getFull || 0) <= 30, p.E1_healthy.after.manualRefresh.byKind);
  ck('E1 manual refresh status updated', /updated/.test(p.E1_healthy.after.manualRefresh.status), p.E1_healthy.after.manualRefresh.status);
  ck('E1 reload: drawer shows last full sync before refresh ends', /Last full sync|syncing/i.test(p.E1_healthy.after.reload.drawerEarly.meta + ' ' + p.E1_healthy.after.reload.drawerEarly.title), p.E1_healthy.after.reload.drawerEarly);
  ck('E2 status partial, not updated', /Partial sync/.test(p.E2_permanent_failures.first.status) && !/· updated/.test(p.E2_permanent_failures.first.status), p.E2_permanent_failures.first.status);
  ck('E2 status names the failures', /\d+ failed/.test(p.E2_permanent_failures.first.status), p.E2_permanent_failures.first.status);
  ck('E2 stored: partial recorded, the 3 broken messages accounted for', p.E2_permanent_failures.first.sync.lastPartialAt && !p.E2_permanent_failures.first.sync.lastSuccessAt && ((p.E2_permanent_failures.first.sync.records?.failed || 0) + (p.E2_permanent_failures.first.sync.records?.deferred || 0)) === 3, p.E2_permanent_failures.first.sync);
  ck('E2 drawer: Partial sync + last full sync', /Partial sync/.test(p.E2_permanent_failures.first.drawer.title) && /full sync/i.test(p.E2_permanent_failures.first.drawer.meta), p.E2_permanent_failures.first.drawer);
  for (const k of ['E3_429_storm', 'E4_network_drops', 'E5_quota_exhausted']) {
    const r = p[k], rec = r.first.sync.records || {};
    const sent = r.first.sync.sent || {};
    const incomplete = (rec.failed || 0) + (rec.deferred || 0) + (rec.stale || 0) > 0 || (sent.failed || 0) > 0 || !!sent.error || (r.first.sync.queryErrors || 0) > 0;
    ck(`${k} status truthful (partial ⇔ incomplete records)`, incomplete ? /Partial sync/.test(r.first.status) : /updated/.test(r.first.status), { status: r.first.status, rec, sent, failures: (r.first.sync.failures || []).slice(0, 3) });
  }
  const e8r = p.E8_reload_partial_then_recover.after;
  ck('E8 after reload with failures: partial + last full sync time shown', /Partial sync/.test(e8r.afterReload.status) && /last full sync \d/.test(e8r.afterReload.status), e8r.afterReload.status);
  ck('E8 stored lastSuccessAt preserved during partial', e8r.afterReload.sync.lastSuccessAt && e8r.afterReload.sync.lastPartialAt > e8r.afterReload.sync.lastSuccessAt, e8r.afterReload.sync);
  ck('E8 recovery: back to updated, partial cleared', /updated/.test(e8r.afterRecovery.status) && !e8r.afterRecovery.sync.lastPartialAt && e8r.afterRecovery.sync.records.failed === 0, { s: e8r.afterRecovery.status, sync: e8r.afterRecovery.sync });
  ck('E6 401 → reconnect prompt', /sign-in expired/i.test(p.E6_worker_401.first.status), p.E6_worker_401.first.status);
  report.knownIssues = [{ id: 'E7', phase: 4, observed: p.E7_worker_502.first.status, sessionKept: p.E7_worker_502.first.hasSession, note: 'Worker 502 clears the stay-signed-in session (app.js serverToken). Out of Phase 1 scope; fix planned in Phase 4.' }];
  ck('No page errors in any scenario', Object.values(p).every((r) => !r.consoleErrors.some((e) => /pageerror/.test(e))), Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.consoleErrors])));
  report.checks = checks; report.passed = checks.filter((c) => c.ok).length; report.total = checks.length;
  fs.writeFileSync(path.join(__dirname, 'phase1-browser-e2e-report.json'), JSON.stringify(report, null, 2));
  console.log(`\nBrowser E2E: ${report.passed}/${report.total} checks passed`);
  if (report.passed !== report.total) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
