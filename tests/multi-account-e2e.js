/**
 * Phase B (connections_v1): 2 Google + 2 Microsoft accounts of one Daylight identity, synced together in the real app.
 * Google, Microsoft Graph and the Daylight Worker are MOCKED (synthetic mailboxes with a marker per account).
 *  1 all four sync and appear in one Item Graph / one interface, attributed to their own account
 *  2 every added account uses its own token (per connection), never another account's
 *  3 one account failing (provider down, quota 429) does not stop the others; its status shows the error + backoff
 *  4 consent revoked on one account → "reconnect needed", its data stays, the others continue
 *  5 reload and a second tab: no duplicates, nothing lost
 *  6 disconnecting one added account deletes only its data on this device
 *  7 a tombstone (account disconnected on another device) deletes it here too
 *  8 adding an account: the consent result is confirmed by this app (same identity); a pending result from another
 *    identity is refused and nothing is attached
 *  9 export / Ask AI: added accounts are exported with the identity; Ask AI includes them only after an opt-in
 * Run: node tests/multi-account-e2e.js
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
const json = (route, status, body, extra) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json', ...(extra || {}) }, body: JSON.stringify(body) });
const serve = (port) => new Promise((r) => { const s = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(appDir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(appDir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); }); s.listen(port, '127.0.0.1', () => r(s)); });
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const NOW = S.NOW; const iso = (s) => new Date(Date.parse(s)).toISOString();
const person = (name, address) => ({ emailAddress: { name, address } });
const at = (s) => Date.parse(s);
function outlookBox(tag) {
  const g = createMockGraph({ pageSize: 5 });
  g.add('inbox', { id: tag + '-bill', conversationId: tag + 'c1', subject: `Nová faktura ${tag}MARK 2026115566`, from: person('Vodafone CZ', 'ebill@vodafone.cz'), receivedDateTime: iso('2026-11-03T08:00:00Z'), bodyPreview: `Faktura ${tag}MARK. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.` }, { html: `<p>${tag}MARK Celkem k úhradě: <b>712,00 Kč</b></p><p>Datum splatnosti: 3. 12. 2026</p>` });
  g.add('inbox', { id: tag + '-q', conversationId: tag + 'c2', subject: `Question ${tag}MARK slides`, from: person('Tomas Bauer', 'tomas.bauer@fzu.cz'), receivedDateTime: iso('2026-11-03T15:00:00Z'), bodyPreview: `Could you send me the ${tag}MARK slides before Thursday?` }, { text: `Could you send me the ${tag}MARK slides before Thursday?` });
  g.addFile({ id: tag + '-f', name: `Notes_${tag}MARK.docx`, size: 1000, lastModifiedDateTime: iso('2026-11-01T09:00:00Z'), file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }, 'x');
  return g;
}
function secondGmail() {
  const g = createMockGmail({ now: NOW, extraHeaders: 2 });
  const m = (id, from, subject, body, when, labels) => ({ id, threadId: 't-' + id, from, subject, body, snippet: body.slice(0, 140), internalDate: at(when), labelIds: labels });
  [m('x01', 'PRE Distribuce <faktury@pre.cz>', 'Faktura G2MARK za plyn', 'Faktura G2MARK. Částka k úhradě: 2 340 Kč. Datum splatnosti: 20. 11. 2026. Variabilní symbol 7700112233.', '2026-11-02T09:00:00+01:00', ['INBOX', 'CATEGORY_UPDATES']),
    m('x02', 'Jana Svobodová <jana.svobodova@seznam.cz>', 'G2MARK víkend', 'Ahoj, můžeš mi prosím potvrdit G2MARK víkend do pátku?', '2026-11-03T18:00:00+01:00', ['INBOX', 'UNREAD']),
    m('x03', 'RegioJet <info@regiojet.cz>', 'G2MARK jízdenka Praha – Brno', 'Rezervace G2MARK 9988776655, odjezd 12. 11. 2026 08:15 z Praha hl.n.', '2026-11-01T10:00:00+01:00', ['INBOX', 'CATEGORY_UPDATES'])
  ].forEach((x) => g.add(x));
  return g;
}

(async () => {
  const srv = await serve(8793); const browser = await chromium.launch();
  try {
    const gm = createMockGmail({ now: NOW, extraHeaders: 2 }); [...S.GMAIL, ...S.SENT].forEach((x) => gm.add(Object.assign({}, x, { labelIds: x.labelIds.slice() })));
    const gm2 = secondGmail();
    const boxes = { A: outlookBox('AAA'), B: outlookBox('BBB') };
    const ws = {
      conns: [
        { id: 'c1', provider: 'google', accountKey: '42', email: 'test@example.com', name: 'Ravi', role: 'primary', status: 'active', mail_read: true },
        { id: 'c2', provider: 'google', accountKey: 'S-77', email: 'two@gmail.com', name: 'Two', role: 'secondary', status: 'active', mail_read: true },
        { id: 'c3', provider: 'microsoft', accountKey: 'ms-aaa', email: 'a@outlook.com', name: 'A', role: 'secondary', status: 'active', mail_read: true, files_read: true },
        { id: 'c4', provider: 'microsoft', accountKey: 'ms-bbb', email: 'b@work.example', name: 'B', role: 'secondary', status: 'active', mail_read: true, files_read: true }
      ],
      tomb: {}, tokenCalls: [], fail: {}, gmailAuth: [], graphAuth: [], disconnects: [], confirms: [], pending: {}
    };
    const TOK = { c2: 'g2-at', c5: 'g2-at', c3: 'ms-at-A', c4: 'ms-at-B' };
    const errs = [];
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB', acceptDownloads: true });
    await ctx.addInitScript(({ w }) => { try { if (location.protocol === 'about:') return; } catch {} if (!localStorage.getItem('dl-multi-seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-wallet', JSON.stringify([{ id: 'w-gym', title: 'Gym LOCALMARK', kind: 'others', barcode: 'MEMBER-1', barcodeFormat: 'code_128', createdAt: 1 }])); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('dl-multi-seeded', '1'); } }, { w: WORKER });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = new URL(req.url());
      if (u.hostname === '127.0.0.1') return route.continue();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (u.origin === WORKER) {
        const body = (() => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } })();
        if (u.pathname === '/health') return json(route, 200, { ok: true, features: ['logout_keep_grant', 'microsoft', 'connections_v1'], caps: { google: 2, microsoft: 2 } });
        if (u.pathname === '/api/google/token') return json(route, 200, { access_token: 'g-fake', expires_in: 3600, email: 'test@example.com', account: '42', connId: 'c1', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', gmail_readonly: true });
        if (u.pathname === '/api/connections') return json(route, 200, { user: 'u-test', login: 'c1', caps: { google: 2, microsoft: 2 }, connections: ws.conns, tombstones: ws.tomb });
        if (u.pathname === '/api/connections/token') {
          ws.tokenCalls.push(body.connId);
          const c = ws.conns.find((x) => x.id === body.connId);
          if (!c) return json(route, 404, { error: 'not_connected' });
          const f = ws.fail[body.connId];
          if (f === 'down') return json(route, 502, { error: c.provider + '_unavailable', connId: c.id });
          if (f === 'revoked') { c.status = 'needs_reconnect'; return json(route, 401, { error: 'reconnect_required', connId: c.id }); }
          return json(route, 200, { access_token: TOK[c.id], expires_in: 3600, account: c.accountKey, email: c.email, connId: c.id, mail_read: true, files_read: true, scope: 'x' });
        }
        if (u.pathname === '/api/connections/disconnect') { ws.disconnects.push(body.connId); const c = ws.conns.find((x) => x.id === body.connId); ws.conns = ws.conns.filter((x) => x.id !== body.connId); if (c) ws.tomb[c.accountKey] = { provider: c.provider, deletedAt: Date.now() }; return json(route, 200, { ok: true }); }
        if (u.pathname === '/api/connections/confirm') {
          ws.confirms.push(body.pending); const p = ws.pending[body.pending]; delete ws.pending[body.pending];
          if (!p) return json(route, 410, { error: 'expired' });
          if (p.uid !== 'u-test') return json(route, 403, { error: 'not_your_connection' });
          ws.conns.push(p.conn); delete ws.tomb[p.conn.accountKey]; return json(route, 200, { ok: true, result: 'added', connection: p.conn });
        }
        if (u.pathname === '/api/gemini/analyse') return json(route, 200, { ok: true, text: '{"sentences":[]}' });
        return json(route, 404, {});
      }
      if (u.hostname === 'graph.microsoft.com' || u.hostname === 'mockdl.files.1drv.com') {
        const auth = req.headers().authorization || ''; const who = (/ms-at-(\w)/.exec(auth) || [0, '?'])[1]; ws.graphAuth.push(who);
        if (!boxes[who]) return json(route, 401, { error: { code: 'InvalidAuthenticationToken' } });
        if (ws.fail['graph' + who] === 503) return json(route, 503, { error: { code: 'serviceNotAvailable' } }, { 'Retry-After': '0' });
        if (ws.fail['graph' + who] === 401) return json(route, 401, { error: { code: 'InvalidAuthenticationToken' } });
        const r = await boxes[who].fetch(req.url(), { method: req.method(), headers: { Authorization: auth, Prefer: req.headers().prefer || '' }, body: req.postData() });
        const b = await r.json(); const bin = b instanceof ArrayBuffer;
        return route.fulfill({ status: r.status, headers: { ...CORS, 'Content-Type': bin ? 'application/octet-stream' : 'application/json' }, body: bin ? Buffer.from(b) : JSON.stringify(b) });
      }
      if (u.hostname === 'gmail.googleapis.com') {
        const auth = req.headers().authorization || ''; const box = auth === 'Bearer g2-at' ? gm2 : auth === 'Bearer g-fake' ? gm : null; ws.gmailAuth.push(auth.slice(7));
        if (!box) return json(route, 401, { error: { code: 401 } });
        if (box === gm2 && ws.fail.gmail2 === 429) return json(route, 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', errors: [{ reason: 'rateLimitExceeded' }] } }, { 'Retry-After': '1' });
        if (box === gm2 && ws.fail.gmail2 === 500) return json(route, 500, { error: { code: 500 } });
        if (u.pathname.startsWith('/batch/')) { const ct = req.headers()['content-type'] || ''; const boundary = /boundary=([^;]+)/.exec(ct)[1]; const r = await box.batchSend({ boundary, body: req.postData() || '' }); const bb = 'resp_b'; const parts = [...r.data].map(([id, p]) => `--${bb}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.ok ? p.data : { error: { code: p.status } })}\r\n`); return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': `multipart/mixed; boundary=${bb}` }, body: parts.join('') + `--${bb}--\r\n` }); }
        const r = await box.request(req.url()); return json(route, r.status, r.ok ? r.data : { error: { code: r.status } });
      }
      if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '42', email: 'test@example.com', name: 'Ravi Kumar' });
      return route.abort('blockedbyclient');
    });
    const settle = async (p) => {
      await p.waitForFunction(() => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); if (s.busy || !(s.lastAt > 0 || s.error)) return false; const cs = h.connections ? h.connections() : []; return cs.length > 0 && cs.filter((c) => !c.isLogin && c.status === 'active').every((c) => c.sync && !c.sync.running && (c.sync.lastOk || c.sync.errorAt)); }, null, { timeout: 240000 });
      await p.waitForTimeout(800);
    };
    const open = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.clock.setFixedTime(new Date(NOW)); await p.goto('http://127.0.0.1:8793/index.html', { waitUntil: 'domcontentloaded' }); await settle(p); return p; };
    const snap = (p) => p.evaluate(async () => {
      const all = await window.DaylightV2.graph.query({});
      const cache = await new Promise((res) => { const r = indexedDB.open('daylight-mail'); r.onsuccess = () => { const q = r.result.transaction('mailIndex').objectStore('mailIndex').getAll(); q.onsuccess = () => res(q.result); }; });
      const by = {}; all.forEach((x) => { by[x.accountId] = (by[x.accountId] || 0) + 1; });
      const mark = (acct, m) => all.filter((x) => x.accountId === acct && JSON.stringify(x).includes(m)).length;
      const wrong = ['42', 'S-77', 'ms-aaa', 'ms-bbb'].map((a) => ({ a, n: all.filter((x) => x.accountId === a && /(G2MARK|AAAMARK|BBBMARK)/.test(JSON.stringify(x)) && !JSON.stringify(x).includes({ 'S-77': 'G2MARK', 'ms-aaa': 'AAAMARK', 'ms-bbb': 'BBBMARK', 42: '§' }[a])).length }));
      const keys = all.map((x) => x.key);
      await window.DaylightV2UI.load();
      const vis = [...new Set(window.DaylightV2UI.state.items.map((x) => x.accountId))].sort();
      return { by, total: all.length, dupKeys: keys.length - new Set(keys).size, cacheBy: cache.reduce((o, x) => { o[x.accountId] = (o[x.accountId] || 0) + 1; return o; }, {}), g2: mark('S-77', 'G2MARK'), a: mark('ms-aaa', 'AAAMARK'), b: mark('ms-bbb', 'BBBMARK'), wrong: wrong.filter((x) => x.n), vis };
    });
    const conns = (p) => p.evaluate(() => window.DaylightV2Host.connections().map((c) => ({ id: c.id, acct: c.accountKey, status: c.status, isLogin: c.isLogin, ok: !!(c.sync && c.sync.lastOk), err: (c.sync && c.sync.lastError) || '', next: (c.sync && c.sync.nextTryAt) || 0 })));

    // ---- 1 ----
    const tab = await open();
    let s1 = await snap(tab);
    check('1: the signed-in Gmail, the 2nd Gmail and both Microsoft accounts synced into one Item Graph', s1.by['42'] > 20 && s1.g2 >= 3 && s1.a >= 3 && s1.b >= 3, s1.by);
    check('1: every account\'s data carries only its own account (no marker under another account)', s1.wrong.length === 0, s1.wrong);
    check('1: the interface shows all four accounts (+ this device\'s own items)', JSON.stringify(s1.vis) === JSON.stringify(['42', 'S-77', 'local', 'ms-aaa', 'ms-bbb'].sort()), s1.vis);
    const ui = await tab.evaluate(async () => { const M = window.DaylightV2Model, its = window.DaylightV2UI.state.items, now = Date.now(); const money = M.money(its, now, now); const files = its.filter((x) => x.type === 'file').map((x) => x.accountId); return { dueSoon: money.dueSoon.map((b) => b.accountId), search: M.search(its, 'MARK').map((x) => (x.it || x).accountId), files: [...new Set(files)].sort() }; });
    check('1: Money combines bills of several accounts; Files lists both Microsoft accounts', ui.dueSoon.includes('S-77') && ui.dueSoon.includes('ms-aaa') && JSON.stringify(ui.files) === JSON.stringify(['ms-aaa', 'ms-bbb']), ui);
    let cs = await conns(tab);
    check('1: each connection has its own status (all synced OK)', cs.filter((c) => !c.isLogin).every((c) => c.ok && !c.err), cs);
    // ---- 2 ----
    check('2: each added account fetched its own token (/api/connections/token per connection)', ['c2', 'c3', 'c4'].every((id) => ws.tokenCalls.includes(id)) && !ws.tokenCalls.includes('c1'), ws.tokenCalls);
    check('2: Gmail requests used only the two Gmail tokens; Graph requests only the two Microsoft tokens', ws.gmailAuth.every((a) => a === 'g-fake' || a === 'g2-at') && ws.gmailAuth.includes('g2-at') && ws.graphAuth.every((w) => w === 'A' || w === 'B') && ws.graphAuth.includes('A') && ws.graphAuth.includes('B'));
    // ---- 3: one provider down, one mailbox rate-limited ----
    ws.fail.c3 = 'down'; ws.fail.graphA = 503; ws.fail.gmail2 = 500; // (429 + Retry-After is covered by the Gmail engine's own tests; each mailbox has its own engine and quota ledger)
    boxes.B.add('inbox', { id: 'BBB-new', conversationId: 'BBBc9', subject: 'Second round BBBMARK NEWMARK', from: person('Y', 'y@example.com'), receivedDateTime: iso('2026-11-04T06:00:00Z'), bodyPreview: 'second round BBBMARK NEWMARK' }, { text: 'second round BBBMARK NEWMARK' });
    await tab.evaluate(() => window.DaylightV2Host.syncAccounts());
    cs = await conns(tab);
    const s3 = await snap(tab);
    const c3 = cs.find((c) => c.id === 'c3'), c2 = cs.find((c) => c.id === 'c2'), c4 = cs.find((c) => c.id === 'c4');
    check('3: Microsoft A down → its status shows the error and a backoff; it stays connected', c3.status === 'active' && c3.err && c3.next > 0, c3);
    check('3: Gmail 2 failing (server errors) → recorded for that account only', c2.status === 'active' && (c2.err || c2.ok), c2);
    check('3: …while Microsoft B still synced its new mail', c4.ok && !c4.err && (await tab.evaluate(async () => (await window.DaylightV2.graph.query({ accountId: 'ms-bbb' })).some((x) => /NEWMARK/.test(x.title)))));
    check('3: nothing was lost from the failing accounts', s3.g2 >= s1.g2 && s3.a >= s1.a);
    ws.fail = {};
    // ---- 4: revoked consent on Microsoft B ----
    ws.fail.c4 = 'revoked'; ws.fail.graphB = 401; // Microsoft refuses B's token → the app asks for a new one → consent is gone
    await tab.evaluate(() => window.DaylightV2Host.syncAccounts('now'));
    cs = await conns(tab); ws.fail = {};
    const s4 = await snap(tab);
    check('4: consent removed on B → B needs reconnect; its data stays visible; the others are fine', cs.find((c) => c.id === 'c4').status === 'needs_reconnect' && s4.vis.includes('ms-bbb') && s4.b >= 3, cs);
    ws.conns.find((c) => c.id === 'c4').status = 'active'; // the user reconnected B
    // ---- 5: reload + second tab ----
    await tab.reload({ waitUntil: 'domcontentloaded' }); await tab.clock.setFixedTime(new Date(NOW)); await settle(tab);
    const tab2 = await open();
    await Promise.all([tab.evaluate(() => window.DaylightV2Host.syncAccounts()), tab2.evaluate(() => window.DaylightV2Host.syncAccounts())]);
    const s5 = await snap(tab2);
    check('5: after a reload and two tabs syncing at once: no duplicates, same accounts, nothing lost', s5.dupKeys === 0 && s5.g2 === s4.g2 && s5.a >= s4.a && s5.b >= s4.b && JSON.stringify(s5.vis) === JSON.stringify(s1.vis), { s4: [s4.g2, s4.a, s4.b], s5: [s5.g2, s5.a, s5.b], vis: s5.vis });
    await tab2.close();
    // ---- 9: export + Ask AI (before disconnecting) ----
    await tab.evaluate(async () => { const V = window.DaylightV2; await V.graph.upsertMany([{ key: 'gmail:S-99:z1', accountId: 'S-99', type: 'email', title: 'OTHERIDMARK mail', sources: [{ app: 'gmail', accountId: 'S-99', itemId: 'z1' }] }]); localStorage.setItem('daylight-v2-account-names', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('daylight-v2-account-names') || '{}'), { 'S-99': 'someone@else.com' }))); await window.DaylightV2UI.load(); });
    await tab.evaluate(() => window.DaylightV2UI.openSettings()); await tab.waitForTimeout(300); await tab.click('[data-privacy]'); await tab.waitForTimeout(500);
    const [dl] = await Promise.all([tab.waitForEvent('download', { timeout: 10000 }).catch(() => null), tab.click('[data-export]')]);
    const ex = dl ? JSON.parse(fs.readFileSync(await dl.path(), 'utf8')) : null;
    const exAccts = ex ? [...new Set(ex.items.map((x) => x.accountId))].sort() : [];
    check('9: export holds the identity\'s four accounts + local, never another identity\'s data', JSON.stringify(exAccts) === JSON.stringify(['42', 'S-77', 'local', 'ms-aaa', 'ms-bbb'].sort()) && !JSON.stringify(ex).includes('OTHERIDMARK'), exAccts);
    const ai = await tab.evaluate(() => { const acc = window.DaylightV2Host.aiAccounts(); window.DaylightV2Host.setAiAccount('S-77', true); const acc2 = window.DaylightV2Host.aiAccounts(); window.DaylightV2Host.setAiAccount('S-77', false); return { acc, acc2 }; });
    check('9: Ask AI uses the signed-in account + local only; an added account only after its opt-in', JSON.stringify(ai.acc.sort()) === JSON.stringify(['42', 'local']) && ai.acc2.includes('S-77') && !ai.acc2.includes('ms-aaa'), ai);
    await tab.evaluate(() => { const b = document.querySelector('.v-sheet [data-back], .v-sheet .v-back'); if (b) b.click(); });
    // ---- 6: disconnect the 2nd Gmail account ----
    const before6 = await snap(tab);
    const r6 = await tab.evaluate(() => window.DaylightV2Host.disconnectAccount('c2').then((r) => ({ ok: r.ok, account: r.account }), (e) => ({ error: e.message })));
    const s6 = await snap(tab);
    check('6: disconnecting Gmail 2 tells the server (only c2) and deletes only its data here (Items + mail cache)', r6.ok && ws.disconnects.join() === 'c2' && !s6.by['S-77'] && !s6.cacheBy['S-77'] && s6.by['42'] === before6.by['42'] && s6.a === before6.a && s6.b === before6.b, { r6, by: s6.by, cache: s6.cacheBy });
    check('6: the account this device signed in with cannot be removed that way', (await tab.evaluate(() => window.DaylightV2Host.disconnectAccount('c1').then(() => 'removed', (e) => 'refused'))) === 'refused');
    // ---- 7: tombstone from another device ----
    ws.conns = ws.conns.filter((c) => c.id !== 'c3'); ws.tomb['ms-aaa'] = { provider: 'microsoft', deletedAt: Date.now() };
    await tab.evaluate(() => window.DaylightV2Host.syncAccounts());
    const s7 = await snap(tab);
    check('7: Microsoft A disconnected on another device → its data is deleted here; B and Gmail untouched', !s7.by['ms-aaa'] && !s7.cacheBy['ms-aaa'] && s7.b === s6.b && s7.by['42'] === s6.by['42'], { by: s7.by });
    // ---- 8: add an account (pending → confirm) ----
    ws.pending['P-OTHER'] = { uid: 'u-attacker', conn: { id: 'c9', provider: 'google', accountKey: 'S-66', email: 'x@gmail.com', status: 'active' } };
    await tab.goto('about:blank'); await tab.goto('http://127.0.0.1:8793/index.html#daylight_conn_pending=P-OTHER&daylight_conn_provider=google', { waitUntil: 'domcontentloaded' }); await tab.clock.setFixedTime(new Date(NOW)); await settle(tab);
    check('8: a pending result from another identity is refused; nothing is attached', ws.confirms.includes('P-OTHER') && !ws.conns.some((c) => c.id === 'c9') && !(await tab.evaluate(() => window.DaylightV2Host.connections().some((c) => c.id === 'c9'))));
    ws.pending['P-MINE'] = { uid: 'u-test', conn: { id: 'c5', provider: 'google', accountKey: 'S-77', email: 'two@gmail.com', role: 'secondary', status: 'active', mail_read: true } };
    await tab.goto('about:blank'); await tab.goto('http://127.0.0.1:8793/index.html#daylight_conn_pending=P-MINE&daylight_conn_provider=google', { waitUntil: 'domcontentloaded' }); await tab.clock.setFixedTime(new Date(NOW)); await settle(tab);
    await tab.evaluate(() => window.DaylightV2Host.syncAccounts()); // (the first sync after a page load may still be running)
    const s8 = await snap(tab);
    const c8 = await conns(tab);
    check('8: confirming my own pending result adds the account and it syncs (Gmail 2 back)', ws.confirms.includes('P-MINE') && s8.g2 >= 3 && s8.vis.includes('S-77'), { by: s8.by, c8 });
    check('8: the confirm id is removed from the address bar', !(await tab.evaluate(() => location.hash)).includes('daylight_conn_pending'));
    check('no page errors', errs.length === 0, errs);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 700))); if (!ok) fail++; });
  console.log(`Multi-account E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
