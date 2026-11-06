/** Privacy audit of the running app against privacy.html (synthetic mailbox, Google and the Worker mocked).
 *  Records every network request, every storage location and the exact Ask AI payload, then checks the policy's claims:
 *  - the browser talks only to the documented hosts; Gmail is only read; Calendar/Tasks/Contacts/Drive are never called;
 *  - the Worker sees only sign-in/token, logout and (when the user asks) the AI relay — never mail;
 *  - email bodies are never stored (IndexedDB, localStorage) and never sent to AI;
 *  - Ask AI sends nothing until the user switches it on and asks; then only the question and ≤60 items with
 *    title / sender name / date / status / amount (no people, organisations, identity documents, addresses or bodies);
 *  - the session token never appears in a URL; the CSP blocks an external image.
 *  Run: node tests/privacy-audit-e2e.js */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const S = require('./home-audit-scenario.js');
const appDir = path.resolve(__dirname, '..');
const WORKER = 'https://daylight-api.kratveer050.workers.dev'; // mocked; same host as production so the CSP applies unchanged
const SESSION = 'S'.repeat(43);
const T = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const ALLOWED_HOSTS = new Set(['127.0.0.1', new URL(WORKER).hostname, 'gmail.googleapis.com', 'www.googleapis.com']); // fonts are served by the site itself since v106

(async () => {
  const srv = await new Promise((r) => { const s = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(appDir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(appDir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }); s.listen(8799, '127.0.0.1', () => r(s)); });
  const browser = await chromium.launch();
  const g = createMockGmail({ now: S.NOW, extraHeaders: 2 });
  [...S.GMAIL, ...S.SENT].forEach((x) => g.add(Object.assign({}, x, { labelIds: x.labelIds.slice() })));
  // two long messages whose bodies continue well past Google's 140-character preview
  const longMail = [
    { id: 'pa1', threadId: 'tpa1', from: 'Vodafone CZ <ebill@vodafone.cz>', subject: 'Faktura 2026119900 — k úhradě 899 Kč', labelIds: ['INBOX', 'CATEGORY_UPDATES'], internalDate: S.NOW - 5 * 3600000,
      body: 'Dobrý den, posíláme fakturu č. 2026119900 za období říjen 2026. Celkem k úhradě 899 Kč, splatnost 25. 11. 2026, variabilní symbol 2026119900. Thank you. The lighthouse keeper whistles a quiet tune for the blue heron at noon every day.' },
    { id: 'pa2', threadId: 'tpa2', from: 'Dr. Eva Malá <eva.mala@uni.example>', subject: 'Seminar slides — could you send them?', labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'], internalDate: S.NOW - 2 * 3600000,
      body: 'Hi, could you please send me the slides for Thursday seminar by Wednesday evening? I would like to print them for the group. Many thanks. P.S. My spare bicycle with the copper bell is parked behind the old library courtyard.' }
  ];
  longMail.forEach((m) => g.add(Object.assign({ snippet: m.body.slice(0, 140) }, m)));
  // text that exists only in message bodies (beyond Google's 140-character preview)
  const bodyOnly = [...S.GMAIL, ...longMail].filter((m) => (m.body || '').replace(/\s+/g, ' ').length > 200).map((m) => m.body.replace(/\s+/g, ' ').slice(150, 185).trim()).filter((x) => x.length > 20);
  const reqs = [], ai = [], routed = [];
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB' });
    await ctx.addInitScript(({ w, s }) => { if (!localStorage.getItem('dl-pa')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', s); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('dl-pa', '1'); } }, { w: WORKER, s: SESSION });
    const page = await ctx.newPage(); await page.clock.setFixedTime(new Date(S.NOW));
    const errs = [], csp = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
    page.on('request', (q) => reqs.push({ url: q.url(), method: q.method(), auth: (q.headers().authorization || '').slice(0, 12), body: q.postData() || '' }));
    await page.route('**/*', async (route) => {
      const req = route.request(), u = new URL(req.url());
      routed.push(req.url());
      if (u.hostname === '127.0.0.1') return route.continue();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (u.origin === WORKER && u.pathname === '/api/gemini/analyse') {
        const b = JSON.parse(req.postData() || '{}'); ai.push(b);
        const items = JSON.parse((/Items \(JSON\):\n([\s\S]*)$/.exec(b.prompt || '') || [])[1] || '[]');
        return json(route, 200, { text: JSON.stringify({ sentences: [{ text: 'Your dinner is at Field.', ids: items.slice(0, 1).map((x) => x.id) }] }) });
      }
      if (u.origin === WORKER && u.pathname === '/auth/logout') return json(route, 200, { ok: true });
      if (u.origin === WORKER) return json(route, 200, { access_token: 'tok', expires_in: 3600, email: 'test@example.com', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' });
      if (u.hostname === 'gmail.googleapis.com') {
        if (u.pathname.startsWith('/batch/')) {
          const ct = req.headers()['content-type'] || ''; const boundary = /boundary=([^;]+)/.exec(ct)[1];
          const r = await g.batchSend({ boundary, body: req.postData() || '' }); const B = 'resp_b';
          const parts = [...r.data].map(([id, p]) => `--${B}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.ok ? p.data : { error: { code: p.status } })}\r\n`);
          return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': `multipart/mixed; boundary=${B}` }, body: parts.join('') + `--${B}--\r\n` });
        }
        const r = await g.request(req.url()); return json(route, r.status, r.ok ? r.data : { error: { code: r.status, message: r.message } });
      }
      if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '42', email: 'test@example.com', name: 'Test User' });
      return route.abort('blockedbyclient');
    });
    await page.goto('http://127.0.0.1:8799/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); return !s.busy && s.runs > 0; }, null, { timeout: 180000 });
    await page.waitForFunction(() => window.DaylightV2UI && window.DaylightV2UI.state.items.length > 20, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    // an ordinary Ask (no AI)
    await page.evaluate(() => window.DaylightV2UI.openAsk('Field restaurant')); await page.waitForTimeout(800);
    const aiBefore = ai.length;
    const offButton = await page.$('[data-askai]');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);

    // ---- storage ----
    const storage = await page.evaluate(async () => {
      const dump = (name) => new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = async () => { const db = r.result; const out = {}; for (const s of db.objectStoreNames) out[s] = await new Promise((ok) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => ok([]); }); db.close(); res(out); }; r.onerror = () => res({}); });
      const dbs = (await indexedDB.databases()).map((d) => d.name);
      const all = {}; for (const n of dbs) all[n] = await dump(n);
      const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
      return { dbs, idb: JSON.stringify(all), ls, ss: Object.keys(sessionStorage) };
    });
    // the check means something only if Daylight really downloaded those bodies
    const fullRead = reqs.some((r) => /messages\/pa[12]\?format=full/.test(r.url + r.body));
    const stored = (storage.idb + JSON.stringify(storage.ls)).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
    check('storage: only the documented IndexedDB databases (daylight-mail, daylight-graph)', storage.dbs.every((n) => ['daylight-mail', 'daylight-graph'].includes(n)) && storage.dbs.length === 2, storage.dbs);
    check('storage: every localStorage key belongs to Daylight', Object.keys(storage.ls).every((k) => k.startsWith('daylight-') || k === 'dl-pa'), Object.keys(storage.ls).filter((k) => !k.startsWith('daylight-')));
    check(`storage: no email body text is stored anywhere (${bodyOnly.length} body-only passages checked; their full messages were downloaded)`, bodyOnly.length >= 2 && fullRead && bodyOnly.every((t) => !stored.includes(t)), bodyOnly.filter((t) => stored.includes(t)));
    check('storage: the Google access token is not stored (memory only)', !stored.includes('"tok"') && !Object.values(storage.ls).some((v) => v === 'tok'));

    // ---- Ask AI ----
    check('Ask AI is off by default: an ordinary Ask sends nothing and offers no AI button', aiBefore === 0 && !offButton);
    await page.evaluate(() => window.DaylightV2UI.openSettings()); await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-privacy]').click()); await page.waitForTimeout(600);
    await page.click('[data-aitoggle]'); await page.waitForTimeout(300);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    check('switching AI on sends nothing by itself', ai.length === 0);
    await page.evaluate(() => window.DaylightV2UI.openAsk('Field restaurant')); await page.waitForTimeout(800);
    await page.click('[data-askai]'); await page.waitForTimeout(1200);
    check('Ask AI instead → exactly one request, to the Daylight Worker relay (never directly to Gemini)', ai.length === 1 && !reqs.some((r) => /generativelanguage/.test(r.url)), { ai: ai.length });
    const body = ai[0] || {}; const items = JSON.parse((/Items \(JSON\):\n([\s\S]*)$/.exec(body.prompt || '') || [])[1] || '[]');
    const allowedKeys = new Set(['id', 'kind', 'type', 'title', 'from', 'when', 'status', 'amount']);
    const graph = await page.evaluate(async () => (await window.DaylightV2.graph.query()).map((x) => ({ id: x.id, type: x.type, privacyClass: x.privacyClass, aiExclude: x.aiExclude })));
    const byId = new Map(graph.map((x) => [x.id, x]));
    check('payload: the question plus at most 60 items', /Question: Field restaurant/.test(body.prompt || '') && items.length > 0 && items.length <= 60, { n: items.length });
    check('payload: each item has only id, kind, type, title, sender, date, status, amount', items.every((it) => Object.keys(it).every((k) => allowedKeys.has(k))), [...new Set(items.flatMap(Object.keys))]);
    check('payload: no people, organisations, identity documents or AI-excluded items', items.every((it) => { const g0 = byId.get(it.id); return g0 && !['person', 'organisation'].includes(g0.type) && g0.privacyClass !== 'identity' && !g0.aiExclude; }));
    check('payload: no email addresses and no email body text', !/[\w.+-]+@[\w-]+\.[\w.]+/.test(body.prompt) && bodyOnly.every((t) => !body.prompt.replace(/\s+/g, ' ').includes(t)), (body.prompt || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/g));
    check('payload: fields are bounded (title ≤120, sender ≤60 characters)', items.every((it) => String(it.title || '').length <= 120 && String(it.from || '').length <= 60));
    const logged = await page.evaluate(async () => (await window.DaylightV2.log.list()).some((l) => l.kind === 'ai'));
    check('the AI request is listed in Privacy Centre → What left your device', logged);

    // ---- network ----
    const ext = reqs.filter((r) => !r.url.startsWith('http://127.0.0.1'));
    const hosts = [...new Set(ext.map((r) => new URL(r.url).hostname))];
    check('network: only documented hosts are contacted', hosts.every((h) => ALLOWED_HOSTS.has(h)), hosts);
    check('network: www.googleapis.com is used only for the userinfo profile (no Calendar, Tasks, Contacts or Drive)', ext.filter((r) => /www\.googleapis\.com/.test(r.url)).every((r) => /\/oauth2\/v3\/userinfo/.test(r.url)) && !ext.some((r) => /calendar|tasks\.googleapis|people\.googleapis|\/drive\//.test(r.url)));
    const gm = ext.filter((r) => /gmail\.googleapis\.com/.test(r.url));
    const inner = gm.flatMap((r) => (r.body.match(/^(GET|POST|PUT|PATCH|DELETE) [^\s]+/gm) || []));
    check('network: Gmail is only read (GET requests, and GETs inside HTTP batches; no send, modify, trash or draft)', gm.length > 0 && gm.every((r) => r.method === 'GET' || (r.method === 'POST' && /\/batch\/gmail\/v1$/.test(new URL(r.url).pathname))) && inner.every((l) => l.startsWith('GET ')) && !gm.some((r) => /\/send|\/modify|\/trash|\/drafts|\/import|\/insert/.test(r.url + r.body)), { methods: [...new Set(gm.map((r) => r.method))], inner: [...new Set(inner.map((l) => l.split(' ')[0]))] });
    const wk = ext.filter((r) => r.url.startsWith(WORKER)).map((r) => new URL(r.url).pathname);
    // (v113: the connection list /api/connections and per-connection tokens are allowed; their bodies carry only ids)
    const idOnly = (b) => { try { return Object.keys(JSON.parse(b)).every((k) => ['connId', 'pending', 'provider', 'return', 'reconnect'].includes(k)); } catch { return false; } };
    check('network: the Worker sees only token, connections, health/logout and the AI relay — no mail', wk.every((p) => ['/api/google/token', '/health', '/auth/logout', '/api/gemini/analyse', '/api/connections', '/api/connections/token'].includes(p)) && ext.filter((r) => r.url.startsWith(WORKER) && !r.url.endsWith('/api/gemini/analyse')).every((r) => !r.body || (/\/api\/connections/.test(r.url) && idOnly(r.body))), [...new Set(wk)]);
    check('network: the session token never appears in a URL (sent only in the Authorization header)', !reqs.some((r) => r.url.includes(SESSION)) && ext.filter((r) => r.url.startsWith(WORKER)).every((r) => r.auth.startsWith('Bearer ')));

    // ---- CSP ----
    const cspMeta = await page.evaluate(() => (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '');
    const before = routed.length;
    const blocked = await page.evaluate(() => new Promise((res) => { let v = null; document.addEventListener('securitypolicyviolation', (e) => { v = e.violatedDirective; }, { once: true }); const i = new Image(); i.onerror = () => setTimeout(() => res(v), 50); i.onload = () => res('loaded'); i.src = 'https://api.qrserver.com/v1/create-qr-code/?data=SECRET-123'; }));
    check('CSP is present and restricts images and connections', /img-src 'self' data: blob: https:\/\/\*\.googleusercontent\.com/.test(cspMeta) && /connect-src 'self' data: https:\/\/daylight-api\.kratveer050\.workers\.dev/.test(cspMeta) && /object-src 'none'/.test(cspMeta));
    check('CSP blocks an image from an external code service before any request is made', /img-src/.test(String(blocked)) && !routed.slice(before).some((u) => /qrserver/.test(u)), { blocked, routed: routed.slice(before) });
    check('no page errors and no CSP violations during normal use', errs.length === 0 && csp.filter((c) => !/qrserver/.test(c)).length === 0, { errs, csp });
    fs.writeFileSync(path.join(__dirname, 'privacy-audit-report.json'), JSON.stringify({ hosts, worker: [...new Set(wk)], gmailRequests: gm.length, aiPayload: { keys: [...new Set(items.flatMap(Object.keys))], items: items.length, promptChars: (body.prompt || '').length }, storage: { dbs: storage.dbs, localStorageKeys: Object.keys(storage.ls).sort() } }, null, 2));
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); if (!ok) fail++; });
  console.log(`Privacy audit E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
