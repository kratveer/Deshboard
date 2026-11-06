/**
 * v113 Phase C: the multi-account user interface, in the real app with 2 Google + 2 Microsoft accounts of one identity.
 * Google, Microsoft Graph and the Daylight Worker are MOCKED (synthetic mailboxes, a marker per account).
 *  A Settings → Your accounts: one row per account (provider, email, type, status, last sync), Add disabled at the cap,
 *    the signed-in account cannot be disconnected there
 *  B account filter on Today, Inbox, Plan, Money, Wallet and Files: every item shown belongs to the chosen account;
 *    "This device" shows only local items; "All" restores everything; search keeps working inside a filter
 *  C attribution: every account tag names the item's own account; the item sheet names its account
 *  D sync status: one account failing → amber ring + that row's error, the app stays connected, the others "Synced";
 *    "needs reconnect" → banner + Reconnect button that starts the consent for that connection
 *  E Ask AI: added accounts are left out until switched on; the AI request never contains an excluded account's items;
 *    the answer shows which accounts were used
 *  F disconnect asks for confirmation first, then removes only that account (and resets a filter set to it); Add works
 * Run: node tests/multi-account-ui-e2e.js
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
  const srv = await serve(8794); const browser = await chromium.launch();
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
      tomb: {}, tokenCalls: [], fail: {}, gmailAuth: [], graphAuth: [], disconnects: [], confirms: [], pending: {}, gemini: [], starts: []
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
        if (u.pathname === '/api/gemini/analyse') { ws.gemini.push(body.prompt || ''); return json(route, 200, { ok: true, text: '{"sentences":[]}' }); }
        if (u.pathname === '/api/connections/start') { ws.starts.push(body); return json(route, 200, { url: 'http://127.0.0.1:8794/index.html#consent-' + body.provider }); }
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
    const open = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.clock.setFixedTime(new Date(NOW)); await p.goto('http://127.0.0.1:8794/index.html', { waitUntil: 'domcontentloaded' }); await settle(p); return p; };
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


    const tab = await open();
    const ids = (p, scope) => p.evaluate((scope) => { const root = scope ? document.querySelector(scope) : document.querySelector('.v-screen:not([hidden])'); const st = window.DaylightV2UI.state; const out = [...(root ? root.querySelectorAll('[data-open]') : [])].map((b) => b.dataset.open).filter((id) => st.byId.get(id)); return { ids: [...new Set(out)], accts: [...new Set(out.map((id) => st.byId.get(id).accountId))].sort() }; }, scope);
    const KEYS = ['42', 'S-77', 'ms-aaa', 'ms-bbb'];
    // ---- A: Settings → Your accounts ----
    await tab.evaluate(() => window.DaylightV2UI.openSettings()); await tab.waitForTimeout(400);
    const A = await tab.evaluate(() => { const rows = [...document.querySelectorAll('.v-sheet [data-acct-row]')]; return { keys: rows.map((r) => r.dataset.acctRow), states: rows.map((r) => r.querySelector('[data-acct-state]').textContent), text: rows.map((r) => r.textContent), discLogin: !!rows[0].querySelector('[data-acct-disc]'), disc: rows.slice(1).map((r) => r.querySelector('[data-acct-disc]') && r.querySelector('[data-acct-disc]').dataset.acctDisc), addG: document.querySelector('.v-sheet [data-acct-add="google"]').disabled, addM: document.querySelector('.v-sheet [data-acct-add="microsoft"]').disabled, syncAll: !!document.querySelector('.v-sheet [data-sync-all]'), ai: [...document.querySelectorAll('.v-sheet [data-acct-ai]')].map((b) => b.dataset.acctAi + ':' + b.getAttribute('aria-checked')) }; });
    check('A: one row per connected account, the signed-in one first', JSON.stringify(A.keys) === JSON.stringify(KEYS), A.keys);
    check('A: each row shows provider type, email and status with the last sync', A.text[1].includes('two@gmail.com') && A.text[1].includes('Google') && A.text[2].includes('Microsoft') && A.text[3].includes('b@work.example') && A.states.every((s) => /^Synced /.test(s)), A.states);
    check('A: added accounts can be disconnected one by one; the signed-in account cannot be removed there', !A.discLogin && JSON.stringify(A.disc) === JSON.stringify(['c2', 'c3', 'c4']), A);
    check('A: at 2 Google + 2 Microsoft, Add Google / Add Microsoft are disabled; Sync all is offered', A.addG && A.addM && A.syncAll, A);
    check('A: per-account Ask AI switches for added accounts, off by default', JSON.stringify(A.ai) === JSON.stringify(['S-77:false', 'ms-aaa:false', 'ms-bbb:false']), A.ai);
    if (process.env.SHOT) await tab.screenshot({ path: process.env.SHOT + '/settings.png', fullPage: false });
    await tab.keyboard.press('Escape'); await tab.waitForTimeout(300);
    if (process.env.SHOT) { await tab.evaluate(() => window.DaylightV2UI.setTab('inbox')); await tab.waitForTimeout(400); await tab.screenshot({ path: process.env.SHOT + '/inbox.png' }); await tab.evaluate(() => window.DaylightV2UI.setTab('wallet')); await tab.waitForTimeout(400); await tab.screenshot({ path: process.env.SHOT + '/wallet.png' }); }
    // ---- B + C: filters and attribution on the five tabs ----
    const B = {};
    for (const t of ['today', 'inbox', 'plan', 'money', 'wallet']) {
      await tab.evaluate((t) => window.DaylightV2UI.setTab(t), t); await tab.waitForTimeout(250);
      const chips = await tab.evaluate(() => [...document.querySelectorAll('.v-screen:not([hidden]) [data-acctbar] [data-acctf]')].map((b) => b.dataset.acctf));
      const all = await ids(tab);
      const per = {};
      for (const k of [...KEYS, 'local']) {
        await tab.click(`.v-screen:not([hidden]) [data-acctf="${k}"]`); await tab.waitForTimeout(150);
        const r = await ids(tab); const st = await tab.evaluate(() => { const s = window.DaylightV2UI.state; return { f: s.filter, n: s.items.length, wrong: s.items.filter((x) => x.accountId !== s.filter).length, all: s.allItems.length }; });
        per[k] = { n: r.ids.length, accts: r.accts, st };
      }
      await tab.click('.v-screen:not([hidden]) [data-acctf="all"]'); await tab.waitForTimeout(150);
      const back = await ids(tab);
      B[t] = { chips, all: all.ids.length, allAccts: all.accts, per, back: back.ids.length };
      const okPer = Object.entries(per).every(([k, v]) => v.accts.every((a) => a === k) && v.st.f === k && v.st.wrong === 0);
      check(`B ${t}: chips All · 4 accounts · This device; each filter shows only that account's items; All restores`, JSON.stringify(chips) === JSON.stringify(['all', ...KEYS, 'local']) && okPer && back.ids.length === all.ids.length, B[t]);
    }
    check('B: the filters change what is shown (at least one tab shows items of 3+ accounts under All and fewer under a filter)', Object.values(B).some((v) => v.allAccts.length >= 3 && Object.values(v.per).every((p) => p.n < v.all)), Object.fromEntries(Object.entries(B).map(([k, v]) => [k, v.allAccts])));
    // search + sorting within a filter (Inbox model on the filtered items)
    const srch = await tab.evaluate(() => { const UI = window.DaylightV2UI, M = window.DaylightV2Model, s = UI.state; s.filter = 'ms-aaa'; s.items = s.allItems.filter((x) => x.accountId === 'ms-aaa'); const v = M.search(s.items, 'MARK').map((x) => (x.it || x).accountId); s.filter = 'all'; s.items = s.allItems; UI.render(); return v; });
    check('B: Inbox and Money show items of each of the four accounts under its own filter (the checks above are not vacuous)', ['inbox', 'money'].every((t) => KEYS.every((k) => B[t].per[k].n > 0)) && B.wallet.per.local.n > 0, { inbox: B.inbox.per, money: B.money.per });
    check('B: search inside a filter finds only that account\'s items', srch.length > 0 && srch.every((a) => a === 'ms-aaa'), srch);
    // Files
    await tab.evaluate(() => window.DaylightV2UI.openFiles()); await tab.waitForTimeout(400);
    const F0 = await ids(tab, '.v-sheet'); const fchips = await tab.evaluate(() => [...document.querySelectorAll('.v-sheet [data-acctf]')].map((b) => b.dataset.acctf));
    await tab.click('.v-sheet [data-acctf="ms-aaa"]'); await tab.waitForTimeout(250); const F1 = await ids(tab, '.v-sheet');
    await tab.click('.v-sheet [data-acctf="ms-bbb"]'); await tab.waitForTimeout(250); const F2 = await ids(tab, '.v-sheet');
    const ftags = await tab.evaluate(() => [...document.querySelectorAll('.v-sheet [data-acct-of]')].map((e) => e.dataset.acctOf));
    check('B Files: both Microsoft accounts under All; each filter shows only its own files; tags match', JSON.stringify(fchips) === JSON.stringify(['all', 'ms-aaa', 'ms-bbb']) && JSON.stringify(F0.accts) === JSON.stringify(['ms-aaa', 'ms-bbb']) && JSON.stringify(F1.accts) === JSON.stringify(['ms-aaa']) && JSON.stringify(F2.accts) === JSON.stringify(['ms-bbb']) && ftags.length > 0 && ftags.every((k) => k === 'ms-bbb'), { fchips, F0: F0.accts, F1: F1.accts, F2: F2.accts, ftags });
    await tab.keyboard.press('Escape'); await tab.waitForTimeout(300);
    // C: attribution
    const C = {};
    for (const t of ['today', 'inbox', 'plan', 'money', 'wallet']) {
      await tab.evaluate((t) => window.DaylightV2UI.setTab(t), t); await tab.waitForTimeout(250);
      C[t] = await tab.evaluate(() => { const s = window.DaylightV2UI.state; const tags = [...document.querySelectorAll('.v-screen:not([hidden]) [data-acct-of]')]; const bad = []; const seen = new Set(); tags.forEach((g) => { const o = g.closest('[data-open]'); const it = o && s.byId.get(o.dataset.open); seen.add(g.dataset.acctOf); if (it && it.accountId !== g.dataset.acctOf) bad.push([o.dataset.open, it.accountId, g.dataset.acctOf]); }); return { n: tags.length, accts: [...seen].sort(), bad }; });
    }
    check('C: account tags on every tab name the item\'s own account (never another)', Object.values(C).every((v) => v.bad.length === 0) && Object.values(C).reduce((a, v) => a + v.n, 0) > 10, C);
    check('C: emails, bills and bookings from all four accounts are attributed', new Set(Object.values(C).flatMap((v) => v.accts)).size === 4, C);
    await tab.evaluate(() => window.DaylightV2UI.setTab('wallet')); await tab.waitForTimeout(250);
    const trips = await tab.evaluate(() => { const s = window.DaylightV2UI.state, M = window.DaylightV2Model; const w = M.wallet(s.items, Date.now()); return [...document.querySelectorAll('.v-screen:not([hidden]) [data-trip]')].map((b) => ({ tags: [...b.querySelectorAll('[data-acct-of]')].map((e) => e.dataset.acctOf).sort(), want: [...new Set(w.trips[Number(b.dataset.trip)].items.map((x) => x.accountId))].filter((a) => a !== 'local').sort() })); });
    check('C: a trip card tags every account it holds bookings from (a trip groups by date, it never merges accounts)', trips.length > 0 && trips.every((t) => JSON.stringify(t.tags) === JSON.stringify(t.want)) && trips.some((t) => t.want.length > 1), trips);
    const tagLocal = await tab.evaluate(() => [...document.querySelectorAll('[data-acct-of="local"]')].length);
    check('C: this device\'s own items carry no account tag', tagLocal === 0);
    const itemAcct = await tab.evaluate(async () => { const s = window.DaylightV2UI.state; const it = s.allItems.find((x) => x.accountId === 'S-77' && /G2MARK/.test(x.title + x.description)); window.DaylightV2UI.openItem(it.id); await new Promise((r) => setTimeout(r, 400)); const e = document.querySelector('.v-sheet [data-item-acct]'); const r = { key: e && e.dataset.itemAcct, text: e && e.textContent }; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return r; });
    check('C: an item sheet names the account it came from', itemAcct.key === 'S-77' && /two@gmail\.com/.test(itemAcct.text || ''), itemAcct);
    await tab.keyboard.press('Escape'); await tab.waitForTimeout(300);
    // ---- D: failure isolation + needs reconnect ----
    ws.fail.c3 = 'down'; ws.fail.graphA = 503;
    await tab.evaluate(async () => { await window.DaylightV2Host.syncAccounts(); await window.DaylightV2UI.load(); window.DaylightV2UI.render(); });
    await tab.waitForTimeout(1500);
    const D1 = await tab.evaluate(() => { const r = document.querySelector('[data-ring]'); return { cls: r.className, title: r.title, warn: r.dataset.warn, n: window.DaylightV2UI.state.items.length }; });
    check('D: one account failing → ring amber (not "Not connected"), names that account; the app keeps all data', !/\boff\b/.test(D1.cls) && /\bwarn\b/.test(D1.cls) && D1.warn === 'ms-aaa' && /a had a problem/.test(D1.title) && !/Not connected/.test(D1.title), D1);
    await tab.evaluate(() => window.DaylightV2UI.openSettings()); await tab.waitForTimeout(400);
    const D2 = await tab.evaluate(() => Object.fromEntries([...document.querySelectorAll('.v-sheet [data-acct-row]')].map((r) => [r.dataset.acctRow, r.querySelector('[data-acct-state]').className + '|' + r.querySelector('[data-acct-state]').textContent])));
    check('D: the failing account\'s row shows a temporary problem with its retry time; the others stay "Synced"', /warn\|Temporary problem · retry \d\d:\d\d/.test(D2['ms-aaa']) && ['42', 'S-77', 'ms-bbb'].every((k) => /ok\|Synced/.test(D2[k])), D2);
    await tab.keyboard.press('Escape'); await tab.waitForTimeout(300);
    ws.fail = {};
    ws.conns.find((c) => c.id === 'c4').status = 'needs_reconnect';
    await tab.evaluate(async () => { await window.DaylightV2Host.syncAccounts(); await window.DaylightV2UI.load(); window.DaylightV2UI.setTab('today'); });
    await tab.waitForTimeout(600);
    if (process.env.SHOT) await tab.screenshot({ path: process.env.SHOT + '/reconnect.png' });
    const D3 = await tab.evaluate(() => { const b = document.querySelector('[data-reconnect-banner]'); return { banner: b && b.textContent, btn: b && b.querySelector('[data-acct-reconnect]') && b.querySelector('[data-acct-reconnect]').dataset.acctReconnect, bbb: window.DaylightV2UI.state.allItems.filter((x) => x.accountId === 'ms-bbb').length }; });
    check('D: needs reconnect → a banner names that account with a Reconnect button; its data stays', D3.btn === 'c4' && /b@work\.example|b\b/.test(D3.banner || '') && D3.bbb > 0, D3);
    await tab.evaluate(() => window.DaylightV2UI.openSettings()); await tab.waitForTimeout(400);
    const D4 = await tab.evaluate(() => { const r = document.querySelector('.v-sheet [data-acct-row="ms-bbb"]'); return { st: r.querySelector('[data-acct-state]').textContent, btn: !!r.querySelector('[data-acct-reconnect="c4"]') }; });
    await tab.click('.v-sheet [data-acct-reconnect="c4"]'); await tab.waitForTimeout(600);
    check('D: Settings row says "Needs reconnect"; Reconnect starts consent for exactly that connection', D4.st === 'Needs reconnect' && D4.btn && ws.starts.length === 1 && ws.starts[0].provider === 'microsoft' && ws.starts[0].reconnect === 'c4', { D4, starts: ws.starts });
    ws.conns.find((c) => c.id === 'c4').status = 'active';
    await tab.evaluate(async () => { location.hash = ''; await window.DaylightV2Host.syncAccounts(); await window.DaylightV2UI.load(); });
    await tab.keyboard.press('Escape'); await tab.waitForTimeout(300);
    // ---- E: Ask AI per-account opt-in ----
    await tab.evaluate(() => window.DaylightV2Host.ai.setEnabled(true));
    const aiOn = await tab.evaluate(() => window.DaylightV2Host.ai.enabled());
    const ask = async () => { await tab.evaluate(() => window.DaylightV2UI.openAsk()); await tab.waitForTimeout(300); const n0 = ws.gemini.length; await tab.evaluate(() => { const b = document.querySelector('[data-answer]'); b.insertAdjacentHTML('beforeend', '<button type="button" data-askai="What bills are due?" id="t-askai">x</button>'); document.getElementById('t-askai').click(); }); await tab.waitForFunction((n) => true, n0); for (let i = 0; i < 40 && ws.gemini.length === n0; i++) await tab.waitForTimeout(100); await tab.waitForTimeout(300); const scope = await tab.evaluate(() => { const e = document.querySelectorAll('[data-ai-scope]'); return e.length ? e[e.length - 1].textContent : ''; }); const p = ws.gemini[ws.gemini.length - 1] || ''; const ids = [...p.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]); const accts = await tab.evaluate((ids) => [...new Set(ids.map((id) => (window.DaylightV2UI.state.byId.get(id) || {}).accountId))].sort(), ids); await tab.keyboard.press('Escape'); await tab.waitForTimeout(200); return { sent: ws.gemini.length > n0, scope, accts, marks: ['G2MARK', 'AAAMARK', 'BBBMARK'].filter((m) => p.includes(m)) }; };
    const E1 = await ask();
    check('E: AI on: the request holds only the signed-in account and this device (no added account\'s items)', aiOn && E1.sent && E1.marks.length === 0 && E1.accts.every((a) => a === '42' || a === 'local'), E1);
    check('E: the answer shows which accounts Ask AI used and how many were left out', /Ask AI uses: test@example\.com, this device · 3 accounts left out/.test(E1.scope), E1.scope);
    await tab.evaluate(() => window.DaylightV2UI.openSettings()); await tab.waitForTimeout(400);
    await tab.click('.v-sheet [data-acct-ai="ms-aaa"]'); await tab.waitForTimeout(200);
    const sw = await tab.evaluate(() => ({ aria: document.querySelector('.v-sheet [data-acct-ai="ms-aaa"]').getAttribute('aria-checked'), ls: localStorage.getItem('daylight-ai-include:ms-aaa'), set: window.DaylightV2Host.aiAccounts() }));
    await tab.keyboard.press('Escape'); await tab.waitForTimeout(300);
    const E2 = await ask();
    check('E: switching one account on includes it — and only it', sw.aria === 'true' && sw.set.includes('ms-aaa') && !sw.set.includes('S-77') && E2.marks.every((m) => m === 'AAAMARK') && E2.accts.every((a) => ['42', 'local', 'ms-aaa'].includes(a)) && E2.accts.includes('ms-aaa') && /a@outlook\.com/.test(E2.scope) && /2 accounts left out/.test(E2.scope), { sw, E2 });
    await tab.evaluate(() => window.DaylightV2Host.setAiAccount('ms-aaa', false));
    // ---- F: disconnect with confirmation ----
    await tab.evaluate(() => { window.DaylightV2UI.setTab('inbox'); }); await tab.waitForTimeout(200);
    await tab.click('.v-screen:not([hidden]) [data-acctf="S-77"]'); await tab.waitForTimeout(200);
    await tab.evaluate(() => window.DaylightV2UI.openSettings()); await tab.waitForTimeout(400);
    await tab.click('.v-sheet [data-acct-disc="c2"]'); await tab.waitForTimeout(300);
    const F1c = { asked: await tab.evaluate(() => { const b = document.querySelector('.v-sheet [data-confirm] .v-banner'); return b ? b.textContent : ''; }), calls: ws.disconnects.length, still: await tab.evaluate(() => window.DaylightV2UI.state.allItems.filter((x) => x.accountId === 'S-77').length) };
    check('F: Disconnect asks first (names the account), nothing happens before the confirmation', /two@gmail\.com/.test(F1c.asked) && F1c.calls === 0 && F1c.still > 0, F1c);
    await tab.click('.v-sheet [data-confirm] [data-ok]');
    for (let i = 0; i < 50 && !ws.disconnects.length; i++) await tab.waitForTimeout(100);
    await tab.waitForTimeout(1500);
    const F2c = await tab.evaluate(() => { const s = window.DaylightV2UI.state; const by = {}; s.allItems.forEach((x) => { by[x.accountId] = (by[x.accountId] || 0) + 1; }); return { by, filter: s.filter, rows: [...document.querySelectorAll('.v-sheet [data-acct-row]')].map((r) => r.dataset.acctRow), addG: (document.querySelector('.v-sheet [data-acct-add="google"]') || {}).disabled }; });
    check('F: after confirming, only that account is removed (server told about c2 only); its items are gone, the others stay', ws.disconnects.join() === 'c2' && !F2c.by['S-77'] && F2c.by['42'] > 0 && F2c.by['ms-aaa'] > 0 && F2c.by['ms-bbb'] > 0 && F2c.by.local > 0, { d: ws.disconnects, F2c });
    check('F: a filter set to the removed account falls back to All; its row is gone; Add Google is available again', F2c.filter === 'all' && !F2c.rows.includes('S-77') && F2c.addG === false, F2c);
    const nStarts = ws.starts.length;
    await tab.click('.v-sheet [data-acct-add="google"]'); await tab.waitForTimeout(500);
    check('F: Add Google starts a new Google consent (no reconnect id)', ws.starts.length === nStarts + 1 && ws.starts[nStarts].provider === 'google' && !ws.starts[nStarts].reconnect, ws.starts);
    if (process.env.DEBUG) console.log(JSON.stringify({ B: Object.fromEntries(Object.entries(B).map(([k, v]) => [k, { all: v.all, accts: v.allAccts, per: Object.fromEntries(Object.entries(v.per).map(([a, p]) => [a, p.n])) }])), C, E1, E2 }));
    check('no page errors', errs.length === 0, errs);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 900))); if (!ok) fail++; });
  console.log(`Multi-account UI E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
