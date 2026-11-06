/**
 * Phase 0 — orphan protection in the real app (Google, Worker and Microsoft Graph MOCKED; synthetic data):
 *  1. Microsoft account A connected and synced; the user pins and annotates one of its Items
 *  2. the server now returns a different account B (replaced): A is hidden at once, a delete prompt appears on Today,
 *     Settings lists A with its deletion date; "Keep for now" keeps it hidden
 *  3. 30-day retention: warning from day 23, deletion only after the warning (at the later of day 30 / warning + 7 days)
 *  4. the server loses B (404): B hidden and listed; reconnecting B restores it with the pin and note, no duplicates
 *  5. data of another login on this device and old pre-Phase-0 orphans are detected; other logins never auto-deleted
 *  6. disconnect during a running sync: nothing of that account comes back
 *  Every deletion leaves Gmail, other accounts, local tasks and Wallet passes untouched.
 * Run: node tests/account-orphans-e2e.js
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
const NOW = S.NOW, DAY = 86400000; const iso = (s) => new Date(Date.parse(s)).toISOString();
const person = (name, address) => ({ emailAddress: { name, address } });
function mailbox(tag) {
  const g = createMockGraph({ pageSize: 5 });
  g.add('inbox', { id: tag + '-bill', conversationId: tag + 'c1', subject: `Nová faktura ${tag}-2026115566`, from: person('Vodafone CZ', 'ebill@vodafone.cz'), receivedDateTime: iso('2026-11-03T08:00:00Z'), bodyPreview: 'Faktura. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.' }, { html: '<p>Celkem k úhradě: <b>712,00 Kč</b></p><p>Datum splatnosti: 3. 12. 2026</p>' });
  g.add('inbox', { id: tag + '-q', conversationId: tag + 'c2', subject: `Question from ${tag}`, from: person('Tomas Bauer', 'tomas.bauer@fzu.cz'), receivedDateTime: iso('2026-11-03T15:00:00Z'), bodyPreview: 'Could you send me the slides before Thursday?' }, { text: 'Could you send me the slides before Thursday?' });
  g.addFile({ id: tag + '-f', name: `Notes_${tag}.docx`, size: 1000, lastModifiedDateTime: iso('2026-11-01T09:00:00Z'), file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }, 'x');
  return g;
}
(async () => {
  const srv = await serve(8794); const browser = await chromium.launch();
  try {
    const gm = createMockGmail({ now: NOW, extraHeaders: 2 }); [...S.GMAIL, ...S.SENT].forEach((x) => gm.add(Object.assign({}, x, { labelIds: x.labelIds.slice() })));
    const boxes = { A: mailbox('A'), B: mailbox('B') };
    const ws = { who: 'A', connected: true, slow: 0 };
    const ID = { A: { account: 'ms-aaa', email: 'a@outlook.com' }, B: { account: 'ms-bbb', email: 'b@outlook.com' } };
    const errs = [], csp = [];
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB' });
    await ctx.addInitScript(({ w }) => { if (!localStorage.getItem('dl-orph-seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-ms-pending', '1'); localStorage.setItem('daylight-wallet', JSON.stringify([{ id: 'w-gym', title: 'Gym membership', kind: 'others', barcode: 'MEMBER-1', barcodeFormat: 'code_128', createdAt: 1 }])); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('dl-orph-seeded', '1'); } }, { w: WORKER });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = new URL(req.url());
      if (u.hostname === '127.0.0.1') return route.continue();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (u.origin === WORKER) {
        if (u.pathname === '/api/google/token') return json(route, 200, { access_token: 'g-fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', gmail_readonly: true });
        if (u.pathname === '/api/microsoft/token') { if (!ws.connected) return json(route, 404, { error: 'ms_not_connected' }); const id = ID[ws.who]; return json(route, 200, { access_token: 'ms-at-' + ws.who, expires_in: 3600, scope: 'Mail.Read Files.Read', email: id.email, name: ws.who, account: id.account, mail_read: true, files_read: true }); }
        if (u.pathname === '/api/microsoft/disconnect') { ws.connected = false; return json(route, 200, { ok: true }); }
        return json(route, 404, {});
      }
      if (u.hostname === 'graph.microsoft.com' || u.hostname === 'mockdl.files.1drv.com') {
        if (ws.slow) await new Promise((r) => setTimeout(r, ws.slow));
        const who = /ms-at-(\w)/.exec(req.headers().authorization || '') || [0, ws.who];
        const r = await boxes[who[1]].fetch(req.url(), { method: req.method(), headers: { Authorization: req.headers().authorization || '', Prefer: req.headers().prefer || '' }, body: req.postData() });
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
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
    let clock = NOW; const setClock = async (t) => { clock = t; await page.clock.setFixedTime(new Date(t)); };
    await page.clock.setFixedTime(new Date(NOW));
    const settle = async () => { await page.waitForFunction(() => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); return !s.busy && (s.lastAt > 0 || !!s.error) && !(h.microsoft && h.microsoft().busy); }, null, { timeout: 180000 }); await page.waitForTimeout(1200); };
    await page.goto('http://127.0.0.1:8794/index.html', { waitUntil: 'domcontentloaded' }); await settle();
    const state = () => page.evaluate(async () => {
      const all = await window.DaylightV2.graph.query({}); const U = window.DaylightV2UI;
      const by = (a) => all.filter((x) => x.accountId === a).length; const vis = (a) => U.state.items.filter((x) => x.accountId === a).length;
      const cacheRows = await new Promise((res) => { const r = indexedDB.open('daylight-mail'); r.onsuccess = () => { const q = r.result.transaction('mailIndex').objectStore('mailIndex').getAllKeys(); q.onsuccess = () => { const m = {}; q.result.forEach((k) => { m[k[0]] = (m[k[0]] || 0) + 1; }); res(m); }; }; });
      return { stored: { A: by('ms-aaa'), B: by('ms-bbb'), gmail: by('42'), local: by('local'), old: by('ms-old'), other: by('ms-ccc') }, visible: { A: vis('ms-aaa'), B: vis('ms-bbb'), gmail: vis('42'), old: vis('ms-old'), other: vis('ms-ccc') }, cache: cacheRows, inv: (await window.DaylightV2Host.accountInventory()).map((r) => ({ key: r.key, status: r.status, items: r.items, warn: !!r.warn, warnedAt: r.warnedAt, deleteAt: r.deleteAt, deletable: r.deletable, reason: r.reason })), prompt: window.DaylightV2Host.replacedPrompt(), wallet: localStorage.getItem('daylight-wallet'), keysA: Object.keys(localStorage).filter((k) => k.includes('ms-aaa') && k !== 'daylight-device-accounts'), banners: [...document.querySelectorAll('[data-acct-banner]')].map((b) => b.innerText.replace(/\s+/g, ' ').slice(0, 160)) };
    });
    // ---- 1: account A ----
    const s1 = await state();
    check('1: Microsoft A connected and synced (visible: emails, bill, file)', s1.visible.A >= 4 && s1.stored.A === s1.visible.A && s1.cache['ms-aaa'] >= 2, s1);
    const userState = await page.evaluate(async () => { const V = window.DaylightV2; const it = (await V.graph.query({ accountId: 'ms-aaa' })).find((x) => x.type === 'email'); await V.actions.applyAction(it.id, 'pin', {}); await V.actions.applyAction(it.id, 'add_note', { text: 'A note' }); return it.id; });
    const base = { gmail: s1.stored.gmail, local: s1.stored.local, wallet: s1.wallet };
    // ---- 2: replaced by B ----
    ws.who = 'B'; await setClock(NOW + 2 * 3600000);
    await page.evaluate(async () => { await window.DaylightV2Host.syncMicrosoft(); await window.DaylightV2UI.load(); });
    await page.evaluate(() => window.DaylightV2UI.setTab('today')); await page.waitForTimeout(400);
    const s2 = await state(); const invA = s2.inv.find((r) => r.key === 'ms-aaa') || {};
    check('2: A is hidden immediately; B is shown', s2.visible.A === 0 && s2.stored.A === s1.stored.A && s2.visible.B >= 4, { visible: s2.visible, stored: s2.stored });
    check('2: A is an orphan (replaced), deletion planned ~30 days out', invA.status === 'orphan' && invA.reason === 'replaced' && invA.deleteAt >= NOW + 29 * DAY, invA);
    check('2: Today asks to delete A\'s data (n items), B named', s2.prompt && s2.prompt.old[0].key === 'ms-aaa' && s2.banners.some((b) => /You connected b@outlook\.com\. Delete the data of a@outlook\.com/.test(b)), s2.banners);
    await page.click('[data-replaced-keep]'); await page.waitForTimeout(600);
    await page.evaluate(() => window.DaylightV2UI.openSettings()); await page.waitForTimeout(500);
    const settingsTxt = await page.evaluate(() => (document.querySelector('[data-accounts-section]') || {}).innerText || '');
    check('2: "Keep for now" → prompt gone, A listed in Settings → Accounts on this device with its deletion date', !(await page.evaluate(() => window.DaylightV2Host.replacedPrompt())) && /a@outlook\.com/.test(settingsTxt) && /No longer connected \(replaced\) · deleted on/.test(settingsTxt) && /Keep 30 more days/.test(settingsTxt), settingsTxt);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    // ---- 3: retention ----
    await setClock(NOW + 22 * DAY); await page.evaluate(async () => { await window.DaylightV2UI.load(); window.DaylightV2UI.setTab('today'); }); await page.waitForTimeout(400);
    let s3 = await state(); let a3 = s3.inv.find((r) => r.key === 'ms-aaa');
    check('3: day 22: no warning yet, not deletable', a3 && !a3.warn && !a3.deletable && !s3.banners.some((b) => /will be deleted/.test(b)), a3);
    await setClock(NOW + 24 * DAY); await page.evaluate(async () => { await window.DaylightV2UI.load(); window.DaylightV2UI.setTab('today'); window.DaylightV2UI.render(); }); await page.waitForTimeout(800);
    s3 = await state(); a3 = s3.inv.find((r) => r.key === 'ms-aaa');
    check('3: day 24: Today shows "will be deleted on …" and the warning is recorded', s3.banners.some((b) => /Data from a@outlook\.com .* will be deleted from this device on/.test(b)) && a3.warnedAt === NOW + 24 * DAY, { banners: s3.banners, a3 });
    await setClock(NOW + 30.5 * DAY); await page.evaluate(() => window.DaylightV2Host.syncNow()); await settle();
    s3 = await state();
    check('3: day 30.5 (warning only 6.5 days ago): nothing deleted', s3.stored.A === s1.stored.A, s3.stored);
    await setClock(NOW + 31.5 * DAY); await page.evaluate(() => window.DaylightV2Host.syncNow()); await settle();
    s3 = await state();
    check('3: day 31.5: A deleted — Items, mail index rows, A\'s keys; tombstoned', s3.stored.A === 0 && !s3.cache['ms-aaa'] && s3.keysA.length === 0 && !s3.inv.some((r) => r.key === 'ms-aaa'), { stored: s3.stored, cache: s3.cache, keys: s3.keysA });
    check('3: …Gmail, B, local tasks and Wallet untouched', s3.stored.gmail === base.gmail && s3.stored.B === s2.stored.B && s3.stored.local === base.local && s3.wallet === base.wallet, { s3: s3.stored, base });
    // ---- 4: connection lost, reconnect restores ----
    const bItem = await page.evaluate(async () => { const V = window.DaylightV2; const it = (await V.graph.query({ accountId: 'ms-bbb' })).find((x) => x.type === 'email'); await V.actions.applyAction(it.id, 'pin', {}); await V.actions.applyAction(it.id, 'add_note', { text: 'B note' }); return it.id; });
    ws.connected = false; await setClock(clock + 2 * 3600000);
    await page.evaluate(async () => { await window.DaylightV2Host.syncMicrosoft(); await window.DaylightV2UI.load(); });
    let s4 = await state(); const b4 = s4.inv.find((r) => r.key === 'ms-bbb') || {};
    check('4: server lost the token (404): B hidden at once, listed as orphan (connection lost), data kept', s4.visible.B === 0 && s4.stored.B === s3.stored.B && b4.status === 'orphan' && b4.reason === 'connection lost', { s4: s4.visible, b4 });
    ws.connected = true; await page.evaluate(() => localStorage.setItem('daylight-ms-pending', '1'));
    await page.evaluate(async () => { await window.DaylightV2Host.syncMicrosoft(); await window.DaylightV2UI.load(); });
    s4 = await state();
    const restored = await page.evaluate(async (id) => { const it = await window.DaylightV2.graph.getItem(id); return { pinned: !!it.pinned, notes: (it.notes || []).map((n) => n.text), hist: (it.actionHistory || []).map((h) => h.kind) }; }, bItem);
    check('4: reconnecting B restores it: visible again, pin, note and history kept, no duplicates', s4.visible.B === s3.stored.B && s4.stored.B === s3.stored.B && restored.pinned && restored.notes.join() === 'B note' && restored.hist.join() === 'pin,add_note' && !s4.inv.find((r) => r.key === 'ms-bbb' && r.status !== 'active'), { s4: s4.stored, restored });
    // ---- 5: pre-Phase-0 orphan and another login's account ----
    await page.evaluate(async () => {
      const V = window.DaylightV2;
      await V.graph.upsertMany([{ key: 'outlook:ms-old:o1', accountId: 'ms-old', type: 'email', title: 'old', sources: [{ app: 'outlook', accountId: 'ms-old', itemId: 'o1' }] }, { key: 'outlook:ms-ccc:c1', accountId: 'ms-ccc', type: 'email', title: 'other login', sources: [{ app: 'outlook', accountId: 'ms-ccc', itemId: 'c1' }] }]);
      localStorage.setItem('daylight-ms-link:99', JSON.stringify({ account: 'ms-ccc', email: 'c@outlook.com' }));
      await window.DaylightV2UI.load();
    });
    let s5 = await state();
    check('5: data left by an earlier version (no link) is found as an orphan and hidden', s5.inv.find((r) => r.key === 'ms-old').status === 'orphan' && s5.visible.old === 0, s5.inv);
    check('5: another login\'s Microsoft account is hidden and marked "other-login"', s5.inv.find((r) => r.key === 'ms-ccc').status === 'other-login' && s5.visible.other === 0);
    await setClock(clock + 90 * DAY); await page.evaluate(async () => { await window.DaylightV2UI.load(); window.DaylightV2UI.render(); }); await page.waitForTimeout(500);
    await page.evaluate(() => window.DaylightV2Host.syncNow()); await settle();
    await setClock(clock + 8 * DAY); await page.evaluate(() => window.DaylightV2Host.syncNow()); await settle();
    s5 = await state();
    check('5: after the warning and 30+ days the old orphan is deleted; the other login\'s data is never auto-deleted', s5.stored.old === 0 && s5.stored.other === 1, s5.stored);
    // delete from Settings (manual)
    await page.evaluate(() => window.DaylightV2UI.openSettings()); await page.waitForTimeout(500);
    await page.click('[data-inv-del="ms-ccc"]'); await page.waitForTimeout(200); await page.click('[data-confirm] [data-ok]'); await page.waitForTimeout(1500);
    s5 = await state();
    check('5: Settings → Delete removes exactly that account (other login link removed too)', s5.stored.other === 0 && !(await page.evaluate(() => localStorage.getItem('daylight-ms-link:99'))) && s5.stored.B === s3.stored.B && s5.stored.gmail === base.gmail, s5.stored);
    await page.keyboard.press('Escape');
    // ---- 6: disconnect during a running sync ----
    boxes.B.add('inbox', { id: 'B-new', conversationId: 'Bc9', subject: 'New mail during disconnect', from: person('X', 'x@example.com'), receivedDateTime: iso('2026-11-04T09:00:00Z'), bodyPreview: 'hello' }, { text: 'hello' });
    ws.slow = 600;
    await page.evaluate(async () => { const H = window.DaylightV2Host; const p = H.syncMicrosoft(); await new Promise((r) => setTimeout(r, 300)); const d = H.disconnectMicrosoft(); await Promise.all([p.catch(() => {}), d]); await window.DaylightV2UI.load(); });
    ws.slow = 0; await page.waitForTimeout(1500);
    const s6 = await state();
    check('6: disconnect while a sync runs: nothing of B remains or comes back (Items, mail index)', s6.stored.B === 0 && !s6.cache['ms-bbb'], { stored: s6.stored, cache: s6.cache });
    check('6: …Gmail, local tasks and Wallet untouched throughout', s6.stored.gmail === base.gmail && s6.stored.local === base.local && s6.wallet === base.wallet, { s6: s6.stored, base });
    check('no page errors, no CSP violations', errs.length === 0 && csp.length === 0, { errs, csp });
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 700))); if (!ok) fail++; });
  console.log(`Account orphans E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
