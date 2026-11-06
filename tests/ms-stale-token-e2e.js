/**
 * v112 fix F1 (+ F2 in the real app): two tabs, Microsoft account replaced in one while the other still holds the old
 * account's token or is waiting for a slow response. Google, Worker, Gemini and Microsoft Graph are MOCKED; synthetic data.
 *  1 tab A syncs Microsoft A · 2 tab B replaces A with B · 3 tab A syncs again with its cached A token
 *  4 A's token is never used after the replace (no Graph request with it) · 5 a delayed A response in flight during the
 *  replace is discarded · 6 no A data under B in storage, Search, local Ask or the Ask AI payload · 7 reconnecting A
 *  later restores only A's data · 8/9 Export holds the current login's accounts + local Items and nothing of other logins,
 *  replaced or orphaned accounts in any collection · 10 Privacy Centre counts and log cover only this login; hidden data is
 *  two totals; another login's mail-derived Wallet pass is not shown · 11 an unproven older pass stays hidden until the
 *  user assigns it in Privacy Centre.
 * Run: node tests/ms-stale-token-e2e.js
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const { createMockGraph } = require('./mock-graph.js');
const S = require('./home-audit-scenario.js');
const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.kratveer050.workers.dev';
const T = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Prefer', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const serve = (port) => new Promise((r) => { const s = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(appDir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(appDir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); }); s.listen(port, '127.0.0.1', () => r(s)); });
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const NOW = S.NOW; const iso = (s) => new Date(Date.parse(s)).toISOString();
const person = (name, address) => ({ emailAddress: { name, address } });
function mailbox(tag) {
  const g = createMockGraph({ pageSize: 5 });
  g.add('inbox', { id: tag + '-bill', conversationId: tag + 'c1', subject: `Nová faktura ${tag}MARK 2026115566`, from: person('Vodafone CZ', 'ebill@vodafone.cz'), receivedDateTime: iso('2026-11-03T08:00:00Z'), bodyPreview: `Faktura ${tag}MARK. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.` }, { html: `<p>${tag}MARK Celkem k úhradě: <b>712,00 Kč</b></p><p>Datum splatnosti: 3. 12. 2026</p>` });
  g.add('inbox', { id: tag + '-q', conversationId: tag + 'c2', subject: `Question ${tag}MARK slides`, from: person('Tomas Bauer', 'tomas.bauer@fzu.cz'), receivedDateTime: iso('2026-11-03T15:00:00Z'), bodyPreview: `Could you send me the ${tag}MARK slides before Thursday?` }, { text: `Could you send me the ${tag}MARK slides before Thursday?` });
  g.addFile({ id: tag + '-f', name: `Notes_${tag}MARK.docx`, size: 1000, lastModifiedDateTime: iso('2026-11-01T09:00:00Z'), file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }, 'x');
  return g;
}
(async () => {
  const srv = await serve(8792); const browser = await chromium.launch();
  try {
    const gm = createMockGmail({ now: NOW, extraHeaders: 2 }); [...S.GMAIL, ...S.SENT].forEach((x) => gm.add(Object.assign({}, x, { labelIds: x.labelIds.slice() })));
    const boxes = { A: mailbox('AAA'), B: mailbox('BBB') };
    const ws = { who: 'A', slow: 0, gemini: [], graphLog: [] };
    const ID = { A: { account: 'ms-aaa', email: 'a@outlook.com' }, B: { account: 'ms-bbb', email: 'b@outlook.com' } };
    const errs = [];
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB', acceptDownloads: true });
    await ctx.addInitScript(({ w }) => { if (!localStorage.getItem('dl-stale-seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-ms-pending', '1'); localStorage.setItem('daylight-wallet', JSON.stringify([{ id: 'w-gym', title: 'Gym LOCALMARK', kind: 'others', barcode: 'MEMBER-1', barcodeFormat: 'code_128', createdAt: 1 }])); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('dl-stale-seeded', '1'); } }, { w: WORKER });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = new URL(req.url());
      if (u.hostname === '127.0.0.1') return route.continue();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (u.origin === WORKER) {
        if (u.pathname === '/api/google/token') return json(route, 200, { access_token: 'g-fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', gmail_readonly: true });
        if (u.pathname === '/api/microsoft/token') { const id = ID[ws.who]; return json(route, 200, { access_token: 'ms-at-' + ws.who, expires_in: 3600, scope: 'Mail.Read Files.Read', email: id.email, name: ws.who, account: id.account, mail_read: true, files_read: true }); }
        if (u.pathname === '/api/gemini/analyse') { ws.gemini.push(req.postData() || ''); return json(route, 200, { ok: true, text: '{"sentences":[]}' }); }
        return json(route, 404, {});
      }
      if (u.hostname === 'graph.microsoft.com' || u.hostname === 'mockdl.files.1drv.com') {
        const who = (/ms-at-(\w)/.exec(req.headers().authorization || '') || [0, 'A'])[1];
        ws.graphLog.push({ at: Date.now(), who, url: req.url() });
        if (ws.slow) await new Promise((r) => setTimeout(r, ws.slow));
        const r = await boxes[who].fetch(req.url(), { method: req.method(), headers: { Authorization: req.headers().authorization || '', Prefer: req.headers().prefer || '' }, body: req.postData() });
        const body = await r.json(); const bin = body instanceof ArrayBuffer;
        return route.fulfill({ status: r.status, headers: { ...CORS, 'Content-Type': bin ? 'application/octet-stream' : 'application/json' }, body: bin ? Buffer.from(body) : JSON.stringify(body) });
      }
      if (u.hostname === 'gmail.googleapis.com') {
        if (u.pathname.startsWith('/batch/')) { const ct = req.headers()['content-type'] || ''; const boundary = /boundary=([^;]+)/.exec(ct)[1]; const r = await gm.batchSend({ boundary, body: req.postData() || '' }); const b = 'resp_b'; const parts = [...r.data].map(([id, p]) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.ok ? p.data : { error: { code: p.status } })}\r\n`); return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': `multipart/mixed; boundary=${b}` }, body: parts.join('') + `--${b}--\r\n` }); }
        const r = await gm.request(req.url()); return json(route, r.status, r.ok ? r.data : { error: { code: r.status } });
      }
      if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '42', email: 'test@example.com', name: 'Ravi Kumar' });
      return route.abort('blockedbyclient');
    });
    const settle = async (p) => { await p.waitForFunction(() => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); return !s.busy && (s.lastAt > 0 || !!s.error) && !(h.microsoft && h.microsoft().busy); }, null, { timeout: 180000 }); await p.waitForTimeout(1000); };
    const open = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.clock.setFixedTime(new Date(NOW)); await p.goto('http://127.0.0.1:8792/index.html', { waitUntil: 'domcontentloaded' }); await settle(p); return p; };
    const storage = (p) => p.evaluate(async () => {
      const all = await window.DaylightV2.graph.query({});
      const cache = await new Promise((res) => { const r = indexedDB.open('daylight-mail'); r.onsuccess = () => { const q = r.result.transaction('mailIndex').objectStore('mailIndex').getAll(); q.onsuccess = () => res(q.result); }; });
      const under = (acct, mark) => all.filter((x) => x.accountId === acct && JSON.stringify(x).includes(mark)).length + cache.filter((x) => x.accountId === acct && JSON.stringify(x).includes(mark)).length;
      return { aUnderB: under('ms-bbb', 'AAAMARK'), bUnderA: under('ms-aaa', 'BBBMARK'), late: all.filter((x) => JSON.stringify(x).includes('LATEMARK')).length + cache.filter((x) => JSON.stringify(x).includes('LATEMARK')).length, items: all.reduce((o, x) => { o[x.accountId] = (o[x.accountId] || 0) + 1; return o; }, {}) };
    });
    // ---- 1 ----
    const tabA = await open();
    let st = await storage(tabA);
    check('1: tab A synced Microsoft A', st.items['ms-aaa'] >= 4, st.items);
    const tabB = await open();
    // ---- 5 (slow A response in flight during the replace) ----
    boxes.A.add('inbox', { id: 'AAA-late', conversationId: 'AAAc9', subject: 'Late LATEMARK AAAMARK mail', from: person('X', 'x@example.com'), receivedDateTime: iso('2026-11-04T07:00:00Z'), bodyPreview: 'late LATEMARK AAAMARK' }, { text: 'late LATEMARK AAAMARK' });
    ws.slow = 900;
    const inflight = tabA.evaluate(() => window.DaylightV2Host.syncMicrosoft().then(() => 'returned').catch((e) => 'threw ' + e.message));
    await tabA.waitForTimeout(450);
    // ---- 2: tab B replaces A with B (consent round trip → reload with pending) ----
    ws.who = 'B';
    await tabB.evaluate(() => localStorage.setItem('daylight-ms-pending', '1'));
    await tabB.reload({ waitUntil: 'domcontentloaded' }); await tabB.clock.setFixedTime(new Date(NOW)); await settle(tabB);
    const replacedAt = Date.now();
    await tabB.evaluate(() => window.DaylightV2Host.dismissReplaced()); // keep A (hidden) for the reconnect test
    const r5 = await inflight; ws.slow = 0;
    st = await storage(tabB);
    check('5: the A sync in flight during the replace returned without storing its late response (under A or B)', r5 && st.late === 0 && st.aUnderB === 0, { r5, st });
    // ---- 3 + 4: tab A syncs again with its cached A token ----
    const reqsBefore = ws.graphLog.length;
    const r3 = await tabA.evaluate(async () => { const out = await window.DaylightV2Host.syncMicrosoft(); return { ran: !!out, err: window.DaylightV2Host.microsoft().error, link: (window.DaylightV2Host.microsoft().link || {}).account }; });
    const after = ws.graphLog.slice(reqsBefore);
    check('3: tab A sees the replacement (link is B) when it syncs again', r3.link === 'ms-bbb', r3);
    check('4: A\'s cached token is never used after the replace — no Graph request with it from any tab', !ws.graphLog.some((l) => l.who === 'A' && l.at > replacedAt) && after.every((l) => l.who === 'B'), { afterWho: [...new Set(after.map((l) => l.who))], aAfter: ws.graphLog.filter((l) => l.who === 'A' && l.at > replacedAt).length });
    st = await storage(tabA);
    check('6: no A data stored under B (graph Items or mail index), none of the late mail anywhere', st.aUnderB === 0 && st.late === 0, st);
    // surfaces in tab B
    const surf = await tabB.evaluate(async () => { await window.DaylightV2UI.load(); const M = window.DaylightV2Model, its = window.DaylightV2UI.state.items, now = Date.now(); return { search: JSON.stringify(M.search(its, 'MARK').map((x) => (x.it || x).title)), ask: JSON.stringify(M.askLocal(its, 'MARK slides', now)), ctx: JSON.stringify(M.aiContext(its, now, 200)), vis: [...new Set(its.map((x) => x.accountId))] }; });
    check('6: Search, local Ask and the AI context show B, never A', !/AAAMARK|LATEMARK/.test(surf.search + surf.ask + surf.ctx) && /BBBMARK/.test(surf.search) && !surf.vis.includes('ms-aaa'), surf);
    await tabB.evaluate(() => { try { window.DaylightAI.setConsent(true); window.DaylightAI.setEnabled(true); } catch {} window.DaylightV2Host.ai.setEnabled(true); window.DaylightV2UI.openAsk(); });
    await tabB.waitForTimeout(300); await tabB.fill('[data-askform] input', 'MARK slides'); await tabB.press('[data-askform] input', 'Enter'); await tabB.waitForTimeout(700);
    const aiBtn = await tabB.$('[data-askai]'); if (aiBtn) { await aiBtn.click(); await tabB.waitForTimeout(1500); }
    // v113: an added (non-sign-in) account goes into Ask AI only after the user switches it on for that account
    check('6: before B is switched on for Ask AI, the request holds none of B\'s (or A\'s) items', ws.gemini.length >= 1 && ws.gemini.every((b) => !/AAAMARK|LATEMARK|BBBMARK/.test(b)), { n: ws.gemini.length, aiBtn: !!aiBtn });
    await tabB.evaluate(() => window.DaylightV2Host.setAiAccount('ms-bbb', true)); const n6 = ws.gemini.length;
    await tabB.press('[data-askform] input', 'Enter'); await tabB.waitForTimeout(700);
    { const b2 = await tabB.$('[data-askai]'); if (b2) { await b2.click(); await tabB.waitForTimeout(1500); } }
    check('6: the Ask AI request that left the device has B data and no A data', ws.gemini.length > n6 && ws.gemini.every((b) => !/AAAMARK|LATEMARK/.test(b)) && /BBBMARK/.test(ws.gemini[ws.gemini.length - 1]), { n: ws.gemini.length, aiBtn: !!aiBtn });
    await tabB.keyboard.press('Escape');
    // user state on B (for the export check)
    await tabB.evaluate(async () => { const V = window.DaylightV2; const e = (await V.graph.query({ accountId: 'ms-bbb', type: 'email' }))[0]; await V.actions.applyAction(e.id, 'pin', {}); await V.actions.applyAction(e.id, 'correct_type', { type: 'newsletter' }); window.DaylightPrivacyLog.add({ kind: 'ai', dest: 'test', what: 'BBBMARK log', accountId: 'ms-bbb' }); });
    // ---- 7: reconnect A later ----
    ws.who = 'A';
    await tabB.evaluate(() => localStorage.setItem('daylight-ms-pending', '1'));
    await tabB.reload({ waitUntil: 'domcontentloaded' }); await tabB.clock.setFixedTime(new Date(NOW)); await settle(tabB);
    await tabB.evaluate(() => window.DaylightV2UI.load());
    const r7 = await tabB.evaluate(() => { const its = window.DaylightV2UI.state.items; return { vis: [...new Set(its.map((x) => x.accountId))], a: its.filter((x) => x.accountId === 'ms-aaa').map((x) => x.title), bVisible: its.filter((x) => x.accountId === 'ms-bbb').length }; });
    st = await storage(tabB);
    check('7: reconnecting A restores A (its Items visible again), B hidden; A holds no B data and B holds no A data', r7.vis.includes('ms-aaa') && !r7.vis.includes('ms-bbb') && r7.a.length >= 4 && r7.a.every((t) => !/BBBMARK/.test(t)) && st.bUnderA === 0 && st.aUnderB === 0, { r7, st });
    // ---- 8/9: export ----
    await tabB.evaluate(async () => {
      const V = window.DaylightV2; const mk = (acct, app, id, title) => ({ key: `${app}:${acct}:${id}`, accountId: acct, type: 'email', title, sources: [{ app, accountId: acct, itemId: id }] });
      await V.graph.upsertMany([mk('ms-ccc', 'outlook', 'c1', 'CCCMARK mail'), mk('77', 'gmail', 'g1', 'GGGMARK mail')]);
      localStorage.setItem('daylight-ms-link:99', JSON.stringify({ account: 'ms-ccc', email: 'c@outlook.com' }));
      const n = JSON.parse(localStorage.getItem('daylight-v2-account-names') || '{}'); n['77'] = 'other@gmail.com'; localStorage.setItem('daylight-v2-account-names', JSON.stringify(n));
      const c = (await V.graph.query({ accountId: 'ms-ccc' }))[0]; await V.actions.applyAction(c.id, 'pin', {});
      const g7 = (await V.graph.query({ accountId: '77' }))[0]; await V.actions.applyAction(g7.id, 'correct_type', { type: 'newsletter' });
      window.DaylightPrivacyLog.add({ kind: 'ai', dest: 'test', what: 'GGGMARK log', accountId: '77' });
      // a Wallet pass an older release saved from the other login's email (v112 wallet ownership)
      const w = JSON.parse(localStorage.getItem('daylight-wallet') || '[]'); w.push({ id: 'mail:g1', kind: 'tickets', title: 'GGGMARK pass', mailId: 'g1', source: 'gmail' }); localStorage.setItem('daylight-wallet', JSON.stringify(w));
      await V.local.importLocal();
      await window.DaylightV2UI.load();
    });
    const countAll = () => tabB.evaluate(async () => { const V = window.DaylightV2; return { b: (await V.graph.query({ accountId: 'ms-bbb' })).length, c: (await V.graph.query({ accountId: 'ms-ccc' })).length, g: (await V.graph.query({ accountId: '77' })).length, items: (await V.graph.query({})).length, links: (await V.graph.links()).length, actions: (await V.graph.actions.all()).length, rules: (await V.ruleStore.all()).length, log: (await V.graph.log.all()).length }; });
    const pre = await countAll();
    await tabB.evaluate(() => window.DaylightV2UI.openSettings()); await tabB.waitForTimeout(300); await tabB.click('[data-privacy]'); await tabB.waitForTimeout(500);
    // ---- 10: Privacy Centre counts are this login's; hidden data is two totals, never details ----
    const pc = await tabB.evaluate(async () => { const sh = document.querySelector('.v-sheet:last-of-type') || document.body; const V = window.DaylightV2; const vis = (await V.graph.query({})).filter((x) => ['42', 'ms-aaa', 'local'].includes(x.accountId)).length; const rows = [...sh.querySelectorAll('.v-mini')].slice(0, 1).flatMap((m) => [...m.querySelectorAll('button')].map((b) => b.textContent)); const typeSum = rows.filter((t) => !/Links|rules|Actions/.test(t)).reduce((n, t) => n + Number((t.match(/(\d+)$/) || [0, 0])[1]), 0); const hid = [...sh.querySelectorAll('[data-hidden-counts] button')].map((b) => b.textContent); return { text: sh.textContent, vis, typeSum, hid }; });
    check('10: Privacy Centre "What is stored here" counts only this login\'s items (+ linked Microsoft + local)', pc.typeSum === pc.vis, { typeSum: pc.typeSum, vis: pc.vis });
    check('10: hidden data appears only as totals for other logins and for disconnected data', pc.hid.length === 2 && /other Daylight accounts/.test(pc.hid[0]) && /disconnected/.test(pc.hid[1]), pc.hid);
    check('10: Privacy Centre shows nothing of other logins or disconnected accounts (incl. the log)', !/BBBMARK|CCCMARK|GGGMARK|ms-bbb|ms-ccc|other@gmail/.test(pc.text), (pc.text.match(/BBBMARK|CCCMARK|GGGMARK|ms-bbb|ms-ccc|other@gmail/g)));
    check('10: the other login\'s mail-derived Wallet pass is not shown', await tabB.evaluate(() => !window.DaylightV2UI.state.items.some((x) => /GGGMARK/.test(x.title))));
    const [dl] = await Promise.all([tabB.waitForEvent('download', { timeout: 10000 }).catch(() => null), tabB.click('[data-export]')]);
    const ex = dl ? JSON.parse(fs.readFileSync(await dl.path(), 'utf8')) : null;
    const accts = ex ? [...new Set(ex.items.map((x) => x.accountId))].sort() : [];
    check('8: export includes the signed-in Gmail account, the connected Microsoft account and local Items', ex && accts.join() === ['42', 'local', 'ms-aaa'].sort().join() && ex.items.some((x) => /LOCALMARK/.test(x.title)) && ex.items.some((x) => /AAAMARK/.test(x.title)), accts);
    const hiddenIn = (coll) => ex ? JSON.stringify(ex[coll] || []).match(/BBBMARK|CCCMARK|GGGMARK|ms-bbb|ms-ccc|"77"/g) : ['no export'];
    for (const coll of ['items', 'links', 'rules', 'actions', 'log', 'accounts']) check(`9: export.${coll} has nothing of the replaced (B), other-login Microsoft (ccc) or other Gmail login (77)`, !hiddenIn(coll), hiddenIn(coll));
    const post = await countAll();
    check('9: export filtering changed nothing stored (B, ccc, 77 still on the device; same items, links, actions, rules)', post.b > 0 && post.c === 1 && post.g === 2 && ['items', 'links', 'actions', 'rules'].every((k) => post[k] === pre[k]) && post.log === pre.log + 1, { pre, post }); // the export adds exactly one log entry (v112: ids no longer collide under the test's frozen clock)
    // ---- 11: an older pass whose account cannot be proven stays hidden until the user assigns it ----
    await tabB.evaluate(async () => { const w = JSON.parse(localStorage.getItem('daylight-wallet') || '[]'); w.push({ id: 'mail:nomail1', kind: 'tickets', title: 'UNPROVENMARK pass' }); localStorage.setItem('daylight-wallet', JSON.stringify(w)); await window.DaylightV2.local.importLocal(); await window.DaylightV2UI.load(); });
    const hiddenU = await tabB.evaluate(() => !window.DaylightV2UI.state.items.some((x) => /UNPROVENMARK/.test(x.title)));
    await tabB.evaluate(() => window.DaylightV2UI.openSettings()); await tabB.waitForTimeout(300); await tabB.click('[data-privacy]'); await tabB.waitForTimeout(500);
    const banner = await tabB.evaluate(() => { const b = document.querySelector('[data-unassigned-passes]'); return b ? b.textContent : null; });
    check('11: an unproven older pass is hidden, and Privacy Centre offers it by count only (no title)', hiddenU && banner && /^1 Wallet pass/.test(banner.trim()) && !/UNPROVENMARK/.test(banner), banner);
    await tabB.click('[data-assign-passes]'); await tabB.waitForTimeout(200); await tabB.click('[data-confirm] [data-ok]'); await tabB.waitForTimeout(800);
    const assigned = await tabB.evaluate(() => { const rec = JSON.parse(localStorage.getItem('daylight-wallet')).find((p) => p.id === 'mail:nomail1'); return { rec, shown: window.DaylightV2UI.state.items.some((x) => /UNPROVENMARK/.test(x.title) && x.accountId === '42') }; });
    check('11: after the user confirms, it belongs to this account (recorded as the user\'s choice) and is shown', assigned.shown && assigned.rec.ownerAccount === '42' && assigned.rec.ownerAssignedBy === 'user', assigned);
    check('no page errors', errs.length === 0, errs);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 700))); if (!ok) fail++; });
  console.log(`MS stale-token E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
