/**
 * v108 upgrade in the real app (synthetic mailbox, Google mocked — NOT live Gmail validation):
 * a device that ran v107 (x4 watermark, user actions, a Wallet pass, a task) opens v108.
 *  1) exactly one full re-ingest (x5), then normal incremental ingests on later opens
 *  2) no duplicate emails or Money Items; actions, notes, pins, snoozes, corrections, Wallet and tasks survive
 *  3) an ingest that fails leaves the x5 watermark unwritten; the next sync does the full re-ingest and recovers
 *  4) two tabs opening v108 at the same time: one Gmail sync (cross-tab lock), same final graph as one tab
 * The v107 app is taken from git (the commit that introduced cache daylight-v107), override with V107_REF.
 * Run: node tests/x5-reingest-e2e.js
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const S = require('./home-audit-scenario.js');

const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.kratveer050.workers.dev'; // mocked; the real Worker is never contacted
const ref = process.env.V107_REF || cp.execSync(`git log --format=%H -S"const CACHE='daylight-v107'" -- sw.js`, { cwd: appDir }).toString().trim().split('\n').pop();
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-v107-'));
cp.execSync(`git archive ${ref} | tar -x -C "${oldDir}"`, { cwd: appDir, shell: '/bin/bash' });
const ref108 = process.env.V108_REF || cp.execSync(`git log --format=%H -S"const CACHE='daylight-v108'" -- sw.js`, { cwd: appDir }).toString().trim().split('\n').pop();
const v108Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-v108-'));
cp.execSync(`git archive ${ref108} | tar -x -C "${v108Dir}"`, { cwd: appDir, shell: '/bin/bash' });
for (const d of [oldDir, v108Dir]) for (const f of ['icon-192.png', 'icon-512.png']) if (!fs.existsSync(path.join(d, f))) fs.copyFileSync(path.join(appDir, f), path.join(d, f));
let ROOT = oldDir;
const T = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const serve = (port) => new Promise((r) => { const s = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(ROOT, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); }); s.listen(port, '127.0.0.1', () => r(s)); });

let gmailHits = 0;
function makeGmail() { const g = createMockGmail({ now: S.NOW, extraHeaders: 2 }); [...S.GMAIL, ...S.SENT].forEach((x) => g.add(Object.assign({}, x, { labelIds: x.labelIds.slice() }))); return g; }
async function mockGoogle(page, g) {
  await page.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.origin === WORKER) return json(route, 200, { access_token: 'fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', gmail_readonly: true });
    if (u.hostname === 'gmail.googleapis.com') {
      gmailHits++;
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
    return route.abort('blockedbyclient');
  });
}
const settle = async (page) => { await page.waitForFunction(() => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); return !s.busy && (s.lastAt > 0 || !!s.error); }, null, { timeout: 180000 }); await page.waitForTimeout(1200); };
const WALLET = [{ id: 'w-gym', title: 'Gym membership', kind: 'others', qrPayload: 'MEMBER-778812', barcode: 'MEMBER-778812', barcodeFormat: 'code_128', createdAt: S.NOW - 86400000 }];
async function newContext(browser) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB' });
  await ctx.addInitScript(({ w, personal, wallet }) => {
    if (!localStorage.getItem('dl-x5-seeded')) {
      localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43));
      localStorage.setItem('daylight-personal-tasks', JSON.stringify(personal));
      localStorage.setItem('daylight-wallet', JSON.stringify(wallet));
      localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } }));
      localStorage.setItem('dl-x5-seeded', '1');
    }
  }, { w: WORKER, personal: S.PERSONAL, wallet: WALLET });
  return ctx;
}
async function open(ctx, g, t) {
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errs.push('CSP: ' + m.text().slice(0, 200)); });
  await page.clock.setFixedTime(new Date(t)); await mockGoogle(page, g);
  await page.goto('http://127.0.0.1:8783/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.DaylightV2 && window.DaylightV2.lastIngest, null, { timeout: 120000 }); await settle(page);
  return { page, errs };
}
// what the user sees and did, without timestamps that legitimately change
const SNAP = () => (async () => {
  const its = await window.DaylightV2.graph.query({});
  return its.map((it) => ({ key: it.key, type: it.type, status: it.status, title: it.title, pinned: !!it.pinned, snoozedUntil: it.snoozedUntil || null, notes: (it.notes || []).map((n) => n.text), hist: (it.actionHistory || []).map((h) => h.kind), userType: it.classification && it.classification.userSet ? it.classification.type : null, src: (it.sources || []).map((s) => s.itemId).sort() })).sort((a, b) => a.key < b.key ? -1 : 1);
})();
const state = (page) => page.evaluate(() => { const k = Object.keys(localStorage); return { x4: k.filter((x) => x.startsWith('daylight-graph-ingest:x4:')).length, x5: k.filter((x) => x.startsWith('daylight-graph-ingest:x5:')).map((x) => Number(localStorage.getItem(x))), log: JSON.parse(localStorage.getItem(k.find((x) => x.startsWith('daylight-v2-ingest-log:')) || '[]') || '[]').map((l) => ({ full: !l.incremental, emails: l.emails })), engineErr: k.filter((x) => x.startsWith('daylight-v2-engine-error:')).map((x) => JSON.parse(localStorage.getItem(x))), wallet: localStorage.getItem('daylight-wallet'), tasks: localStorage.getItem('daylight-personal-tasks'), last: window.DaylightV2.lastIngest }; });
async function actOnV107(page) {
  return page.evaluate(async () => {
    const V = window.DaylightV2; const q = (t) => V.graph.query({ type: t });
    const bills = await q('bill'), tx = await q('transaction'), emails = await q('email'), bookings = await q('booking');
    const out = {};
    if (bills[0]) { out.done = bills[0].key; await V.actions.applyAction(bills[0].id, 'done', {}); }
    if (bills[1]) { out.snoozed = bills[1].key; await V.actions.applyAction(bills[1].id, 'snooze', { until: Date.now() + 2 * 86400000 }); }
    const t = tx[0] || bookings[0]; if (t) { out.pinned = t.key; await V.actions.applyAction(t.id, 'pin', {}); await V.actions.applyAction(t.id, 'add_note', { text: 'keep this' }); }
    const e = emails.find((x) => x.classification.type === 'marketing') || emails[0]; out.corrected = e.key; await V.actions.applyAction(e.id, 'correct_type', { type: 'personal', noRule: true });
    return out;
  });
}
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const dupes = (snap) => { const per = {}; snap.filter((x) => ['bill', 'transaction', 'subscription'].includes(x.type)).forEach((x) => x.src.forEach((s) => { per[s] = (per[s] || 0) + 1; })); const emails = snap.filter((x) => x.type === 'email'); return { money: Object.entries(per).filter(([, n]) => n > 1), emails: emails.length - new Set(emails.map((x) => x.src.join())).size }; };

(async () => {
  const srv = await serve(8783); const browser = await chromium.launch();
  const T0 = S.NOW, MIN = 60000;
  try {
    // ---- A: one tab ----
    const g = makeGmail(); const ctx = await newContext(browser);
    ROOT = oldDir;
    let { page, errs } = await open(ctx, g, T0);
    const acted = await actOnV107(page);
    const v107 = await page.evaluate(SNAP); const s107 = await state(page);
    check('setup: v107 ran (x4 watermark, no x5), the user acted on Items', s107.x4 === 1 && s107.x5.length === 0 && acted.done && acted.pinned && acted.corrected, { s107: { x4: s107.x4, x5: s107.x5 }, acted });
    await page.close();
    // open v108
    ROOT = appDir; const hits0 = gmailHits;
    ({ page, errs } = await open(ctx, g, T0 + 5 * MIN));
    const v108 = await page.evaluate(SNAP); const s1 = await state(page);
    const logAfter = s1.log.slice(s107.log.length);
    check('1a first v108 open: one full re-ingest (x5 written, ingest reported full)', s1.x5.length === 1 && s1.last.incremental === false && logAfter.filter((l) => l.full).length === 1, { last: s1.last, logAfter });
    const d1 = dupes(v108);
    check('2a no duplicate email Items and no email supporting two Money Items', d1.emails === 0 && d1.money.length === 0, d1);
    check('2b same Items as v107 (same keys) — the re-ingest added or removed nothing on this mailbox', JSON.stringify(v108.map((x) => x.key)) === JSON.stringify(v107.map((x) => x.key)), { added: v108.filter((x) => !v107.some((y) => y.key === x.key)).map((x) => x.key), removed: v107.filter((x) => !v108.some((y) => y.key === x.key)).map((x) => x.key) });
    const by = (s, k) => s.find((x) => x.key === k) || {};
    check('2c done, snooze, pin, note, action history and the type correction survive', by(v108, acted.done).status === 'done' && by(v108, acted.snoozed).snoozedUntil && by(v108, acted.pinned).pinned && by(v108, acted.pinned).notes.join() === 'keep this' && by(v108, acted.pinned).hist.join() === 'pin,add_note' && by(v108, acted.corrected).userType === 'personal', { done: by(v108, acted.done), pinned: by(v108, acted.pinned), corrected: by(v108, acted.corrected) });
    check('2d every Item is unchanged in what the user sees and did (this mailbox has no receipt/tax-document cases)', JSON.stringify(v108) === JSON.stringify(v107), v108.filter((x) => JSON.stringify(x) !== JSON.stringify(by(v107, x.key))).slice(0, 3));
    check('2e Wallet pass and tasks untouched (storage and graph)', s1.wallet === s107.wallet && s1.tasks === s107.tasks && v108.filter((x) => /^local:|^wallet|^task/.test(x.key)).length === v107.filter((x) => /^local:|^wallet|^task/.test(x.key)).length);
    check('2f the upgrade did not refetch the mailbox (re-ingest reads the local mail index)', gmailHits - hits0 < 40, { gmailRequests: gmailHits - hits0 });
    await page.close();
    // later opens are incremental
    ({ page, errs } = await open(ctx, g, T0 + 25 * MIN));
    const s2 = await state(page); const v2 = await page.evaluate(SNAP);
    check('1b next open: incremental ingest, no second full re-ingest, graph unchanged', s2.last.incremental === true && s2.log.slice(s107.log.length).filter((l) => l.full).length === 1 && JSON.stringify(v2) === JSON.stringify(v108), { last: s2.last });
    // a failing ingest, then recovery
    const fr = await page.evaluate(async () => {
      const k = Object.keys(localStorage).find((x) => x.startsWith('daylight-graph-ingest:x5:')); localStorage.removeItem(k); // as on a device opening v108 for the first time
      const gm = window.DaylightV2.gmail, real = gm.ingest; gm.ingest = async () => { gm.ingest = real; throw new Error('simulated ingest failure'); };
      await window.DaylightV2Host.syncNow();
      const after1 = { x5: localStorage.getItem(k), err: JSON.parse(localStorage.getItem(Object.keys(localStorage).find((x) => x.startsWith('daylight-v2-engine-error:')) || 'null')), last: window.DaylightV2.lastIngest };
      return { k, after1 };
    });
    await page.clock.setFixedTime(new Date(T0 + 45 * MIN));
    await page.evaluate(() => window.DaylightV2Host.syncNow());
    const s3 = await state(page); const v3 = await page.evaluate(SNAP);
    check('3a a failed ingest is recorded and leaves the x5 watermark unwritten', fr.after1.x5 === null && fr.after1.err && fr.after1.err.stage === 'graph ingest', fr.after1);
    check('3b the next sync does the full re-ingest and ends in the same graph', s3.x5.length === 1 && s3.last.incremental === false && JSON.stringify(v3) === JSON.stringify(v108), { last: s3.last });
    // the Anthropic receipt in the real UI: Money → Recent payments (not Due soon), the sheet opens its email in Gmail
    const ui = await page.evaluate(async () => {
      const V = window.DaylightV2, acct = V.gmail.getAccountId ? V.gmail.getAccountId() : Object.keys(localStorage).find((x) => x.startsWith('daylight-graph-ingest:x5:')).split(':').pop();
      const rec = { messageId: 'anth-rcpt', threadId: 'anth-thread', from: 'Anthropic, PBC <invoice+statements@mail.anthropic.com>', subject: 'Your receipt from Anthropic, PBC #2615-9581-3414', snippet: 'Your receipt from Anthropic, PBC #2615-9581-3414', labels: ['UNREAD', 'IMPORTANT', 'CATEGORY_UPDATES', 'INBOX'], internalDate: Date.parse('2026-11-02T09:00:00Z'), category: 'bill', status: 'done' };
      const n = V.gmail.normalise(rec, { fields: { amount: { value: 10, currency: 'USD' }, merchant: 'Anthropic, PBC' } }, { accountId: acct, now: Date.now() });
      await V.graph.upsertMany(n.items); await V.graph.linkMany(n.links, acct);
      await window.DaylightV2UI.load(); window.DaylightV2UI.setTab('money'); await new Promise((r) => setTimeout(r, 600));
      const it = window.DaylightV2UI.state.items.find((x) => x.type !== 'email' && (x.sources || []).some((s) => s.itemId === 'anth-rcpt') && x.type !== 'organisation' && x.type !== 'person');
      const txt = document.querySelector('#v2').innerText.toLowerCase();
      const recentIdx = txt.indexOf('recent payments'), dueIdx = txt.indexOf('due soon');
      const inRecent = recentIdx >= 0 && txt.slice(recentIdx).includes('anthropic');
      const dueBlock = dueIdx >= 0 ? txt.slice(dueIdx, recentIdx > dueIdx ? recentIdx : undefined) : '';
      window.DaylightV2UI.openItem(it.id); await new Promise((r) => setTimeout(r, 500));
      const sh = [...document.querySelectorAll('.v-sheet')].pop(); const a = sh && [...sh.querySelectorAll('a')].find((x) => /Open in Gmail/.test(x.textContent));
      return { type: it.type, category: it.meta.category, inRecent, inDueSoon: /anthropic/.test(dueBlock), gmailHref: a ? a.getAttribute('href') : null };
    });
    check('5 Anthropic receipt in the app: a receipt transaction, in Recent payments, not in Due soon, "Open in Gmail" links its email', ui.type === 'transaction' && ui.category === 'receipt' && ui.inRecent && !ui.inDueSoon && /anth-thread/.test(ui.gmailHref || ''), ui);
    check('no page errors or CSP violations (one tab)', errs.length === 0, errs);
    await ctx.close();

    // ---- B: two tabs open v108 at the same time ----
    const g2 = makeGmail(); const ctx2 = await newContext(browser);
    ROOT = oldDir;
    const o = await open(ctx2, g2, T0); await actOnV107(o.page); const sB = await state(o.page); await o.page.close();
    ROOT = appDir; const prof0 = (g2.stats.byKind.profile || 0);
    // 20 minutes later: past the 15-minute sync skip, so a Gmail sync is due and both tabs want it
    const [p1, p2] = await Promise.all([open(ctx2, g2, T0 + 20 * MIN), open(ctx2, g2, T0 + 20 * MIN)]);
    const r1 = await state(p1.page), r2 = await state(p2.page); const vb = await p1.page.evaluate(SNAP);
    const profileReads = (g2.stats.byKind.profile || 0) - prof0;
    const fulls = [r1.last, r2.last].filter((l) => l && l.incremental === false).length;
    check('4a two tabs: final graph identical to the one-tab upgrade (no duplicated Items, notes or history)', JSON.stringify(vb) === JSON.stringify(v108), vb.filter((x) => JSON.stringify(x) !== JSON.stringify(by(v108, x.key))).slice(0, 3));
    check('4b two tabs: no duplicates', dupes(vb).emails === 0 && dupes(vb).money.length === 0);
    check('4c two tabs: x5 written once per account and the log shows the full re-ingest(s) only at upgrade', r2.x5.length === 1 && r2.log.slice(sB.log.length).filter((l) => l.full).length === fulls, { fulls, log: r2.log.slice(sB.log.length) });
    check('4d two tabs: the cross-tab lock let only one tab run the Gmail sync (Gmail profile read once)', profileReads === 1, { profileReads, stats: g2.stats.byKind });
    check('no page errors or CSP violations (two tabs)', p1.errs.length === 0 && p2.errs.length === 0, [p1.errs, p2.errs]);
    console.log(`INFO two tabs: ${fulls} tab(s) ran the full re-ingest; Gmail profile reads during the two-tab open: ${profileReads}`);
    await ctx2.close();

    // ---- C: a device that already ran the first v108 build (x5 done) opens the fixed build: no second full re-ingest ----
    const g3 = makeGmail(); const ctx3 = await newContext(browser);
    ROOT = oldDir; const c1 = await open(ctx3, g3, T0); await actOnV107(c1.page); await c1.page.close();
    ROOT = v108Dir; const c2 = await open(ctx3, g3, T0 + 5 * MIN); const s108 = await state(c2.page); const snap108 = await c2.page.evaluate(SNAP); await c2.page.close();
    ROOT = appDir; const c3 = await open(ctx3, g3, T0 + 25 * MIN); const s109 = await state(c3.page); const snap109 = await c3.page.evaluate(SNAP);
    check('6a setup: the deployed v108 build did the x5 full re-ingest', s108.last.incremental === false && s108.x5.length === 1, s108.last);
    // v112 adds one full re-ingest of its own (review / feedback requests are no bookings: fb1 watermark); the x5 one is not repeated
    check('6b opening the current build after deployed v108: exactly one more full re-ingest (v112 feedback rules, not x5), x5 kept, same graph', s109.log.filter((l) => l.full).length === s108.log.filter((l) => l.full).length + 1 && s109.x5.length === 1 && JSON.stringify(snap109) === JSON.stringify(snap108), { last: s109.last });
    await c3.page.close(); const c4 = await open(ctx3, g3, T0 + 45 * MIN); const s110 = await state(c4.page); const snap110 = await c4.page.evaluate(SNAP);
    check('6c the next open is incremental: no further full re-ingest, same graph', s110.last.incremental === true && s110.log.filter((l) => l.full).length === s109.log.filter((l) => l.full).length && JSON.stringify(snap110) === JSON.stringify(snap108), { last: s110.last });
    await c4.page.close();
    check('no page errors or CSP violations (v108 → fixed)', c3.errs.length === 0 && c4.errs.length === 0, [c3.errs, c4.errs]);
    await ctx3.close();
  } finally { await browser.close(); srv.close(); fs.rmSync(oldDir, { recursive: true, force: true }); fs.rmSync(v108Dir, { recursive: true, force: true }); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 600))); if (!ok) fail++; });
  console.log(`x5 re-ingest E2E (v107 ${ref.slice(0, 7)}, deployed v108 ${ref108.slice(0, 7)} → current): ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
