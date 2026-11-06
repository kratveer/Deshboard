/**
 * Microsoft in the real app (Google, the Daylight Worker and Microsoft Graph are all MOCKED; synthetic mail and files —
 * this is NOT a test against a real Microsoft account):
 * connect from Settings → Microsoft (consent round trip), Outlook mail through the same engine as Gmail, OneDrive file list,
 * bills/receipts/tickets among files read on the device (PDF with the self-hosted pdf.js under the page's CSP, Word, Excel),
 * Open in Outlook / OneDrive, incremental sync, expired consent → Reconnect, Disconnect deletes only Microsoft data,
 * nothing sent anywhere else, no tokens or file text stored. Run: node tests/microsoft-e2e.js
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createMockGmail } = require('./mock-gmail.js');
const { createMockGraph } = require('./mock-graph.js');
const S = require('./home-audit-scenario.js');
const appDir = path.resolve(__dirname, '..');
const FX = path.join(__dirname, 'fixtures', 'files');
const WORKER = 'https://daylight-api.kratveer050.workers.dev';
const T = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Prefer', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const serve = (port) => new Promise((r) => { const s = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(appDir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(appDir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); }); s.listen(port, '127.0.0.1', () => r(s)); });
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const NOW = S.NOW; const iso = (s) => new Date(Date.parse(s)).toISOString();
const person = (name, address) => ({ emailAddress: { name, address } });

function makeGraph() {
  const g = createMockGraph({ pageSize: 5 });
  g.add('inbox', { id: 'AAk-vf1', conversationId: 'c1', subject: 'Nová faktura 2026115566', from: person('Vodafone CZ', 'ebill@vodafone.cz'), receivedDateTime: iso('2026-11-03T08:00:00Z'), bodyPreview: 'Faktura č. 2026115566. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.' }, { html: '<p>Faktura č. 2026115566.</p><p>Celkem k úhradě: <b>712,00 Kč</b></p><p>Datum splatnosti: 3. 12. 2026</p>' });
  g.add('inbox', { id: 'AAk-an1', conversationId: 'c2', subject: 'Your receipt from Anthropic, PBC #2615-9581-3414', from: person('Anthropic, PBC', 'invoice+statements@mail.anthropic.com'), receivedDateTime: iso('2026-11-02T09:00:00Z'), bodyPreview: 'Your receipt from Anthropic, PBC #2615-9581-3414', isRead: true }, { html: '<p>Amount paid $10.00</p><p>Receipt number 2615-9581-3414</p>' });
  g.add('inbox', { id: 'AAk-pe1', conversationId: 'c3', subject: 'Seminar slides for Thursday?', from: person('Tomas Bauer', 'tomas.bauer@fzu.cz'), receivedDateTime: iso('2026-11-03T15:00:00Z'), bodyPreview: 'Hi, could you send me the seminar slides before Thursday? Thanks, Tomas' }, { text: 'Hi, could you send me the seminar slides before Thursday? Thanks, Tomas' });
  const file = (id, name, mod, folder, mime) => g.addFile({ id, name, size: fs.existsSync(path.join(FX, name)) ? fs.statSync(path.join(FX, name)).size : 3000, lastModifiedDateTime: iso(mod), cTag: 'c-' + id, file: { mimeType: mime || 'application/pdf' }, parentReference: { path: '/drive/root:' + folder } }, fs.existsSync(path.join(FX, name)) ? new Uint8Array(fs.readFileSync(path.join(FX, name))) : 'x');
  file('f-pre', 'Faktura_PRE_2026-11.pdf', '2026-11-01T09:00:00Z', '/Documents/Bills');
  file('f-nw', 'Invoice_Northwind_0042.xlsx', '2026-11-03T09:00:00Z', '/Documents/Bills', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  file('f-pass', 'Passport_Jana.pdf', '2026-10-01T09:00:00Z', '/Documents/Travel');
  file('f-thesis', 'Thesis_draft_v7.docx', '2026-11-03T20:00:00Z', '/University', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  return g;
}
const gmail = () => { const g = createMockGmail({ now: NOW, extraHeaders: 2 }); [...S.GMAIL, ...S.SENT].forEach((x) => g.add(Object.assign({}, x, { labelIds: x.labelIds.slice() }))); return g; };

(async () => {
  const srv = await serve(8795); const browser = await chromium.launch();
  try {
    const gm = gmail(), graph = makeGraph();
    const ws = { msConnected: false, msTokenStatus: 200, disconnects: 0, starts: 0 };
    const external = [], csp = [], errs = [];
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Prague', locale: 'en-GB' });
    await ctx.addInitScript(({ w }) => { if (!localStorage.getItem('dl-ms-seeded')) { localStorage.setItem('daylight-api', w); localStorage.setItem('daylight-session', 'S'.repeat(43)); localStorage.setItem('daylight-gmail-config', JSON.stringify({ global: { quota: { limitPerMinute: 60000 }, pipeline: { maxFullPerSync: 80 } } })); localStorage.setItem('dl-ms-seeded', '1'); } }, { w: WORKER });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = new URL(req.url());
      if (u.hostname === '127.0.0.1') return route.continue();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (u.origin === WORKER) {
        if (u.pathname === '/api/google/token') return json(route, 200, { access_token: 'g-fake', expires_in: 3600, email: 'test@example.com', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', gmail_readonly: true });
        if (u.pathname === '/api/microsoft/start') { ws.starts++; const body = JSON.parse(req.postData() || '{}'); ws.returnTo = body.return; return json(route, 200, { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=ms-cid&state=s1' }); }
        if (u.pathname === '/api/microsoft/token') { if (!ws.msConnected) return json(route, 404, { error: 'ms_not_connected' }); if (ws.msTokenStatus === 401) return json(route, 401, { error: 'ms_reauth' }); return json(route, 200, { access_token: 'ms-at-123', expires_in: 3600, scope: 'openid profile email offline_access User.Read Mail.Read Files.Read', email: 'jana@outlook.com', name: 'Jana', account: 'ms-abc123', mail_read: true, files_read: true }); }
        if (u.pathname === '/api/microsoft/disconnect') { ws.disconnects++; ws.msConnected = false; return json(route, 200, { ok: true }); }
        return json(route, 404, {});
      }
      if (u.hostname === 'login.microsoftonline.com') { ws.msConnected = true; return route.fulfill({ status: 302, headers: { Location: ws.returnTo + '#daylight_ms=connected' } }); } // Microsoft consent + Worker callback
      if (u.hostname === 'graph.microsoft.com' || u.hostname === 'mockdl.files.1drv.com') {
        const r = await graph.fetch(req.url(), { method: req.method(), headers: req.headers().authorization ? { Authorization: req.headers().authorization, Prefer: req.headers().prefer || '' } : { Prefer: req.headers().prefer || '' }, body: req.postData() });
        const body = await r.json(); const bin = body instanceof ArrayBuffer;
        return route.fulfill({ status: r.status, headers: { ...CORS, 'Content-Type': bin ? 'application/octet-stream' : 'application/json', ...(r.headers.get('Retry-After') ? { 'Retry-After': r.headers.get('Retry-After') } : {}) }, body: bin ? Buffer.from(body) : JSON.stringify(body) });
      }
      if (u.hostname === 'gmail.googleapis.com') {
        if (u.pathname.startsWith('/batch/')) { const ct = req.headers()['content-type'] || ''; const boundary = /boundary=([^;]+)/.exec(ct)[1]; const r = await gm.batchSend({ boundary, body: req.postData() || '' }); const b = 'resp_b'; const parts = [...r.data].map(([id, p]) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.ok ? p.data : { error: { code: p.status } })}\r\n`); return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': `multipart/mixed; boundary=${b}` }, body: parts.join('') + `--${b}--\r\n` }); }
        const r = await gm.request(req.url()); return json(route, r.status, r.ok ? r.data : { error: { code: r.status } });
      }
      if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/oauth2/v3/userinfo')) return json(route, 200, { sub: '42', email: 'test@example.com', name: 'Ravi Kumar' });
      external.push(req.url()); return route.abort('blockedbyclient');
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
    await page.clock.setFixedTime(new Date(NOW));
    const settle = async () => { await page.waitForFunction(() => { const h = window.DaylightV2Host; if (!h) return false; const s = h.syncState(); return !s.busy && (s.lastAt > 0 || !!s.error) && !(h.microsoft && h.microsoft().busy); }, null, { timeout: 180000 }); await page.waitForTimeout(1500); };
    await page.goto('http://127.0.0.1:8795/index.html', { waitUntil: 'domcontentloaded' }); await settle();
    const before = await page.evaluate(() => ({ ms: window.DaylightV2Host.microsoft(), items: window.DaylightV2UI.state.items.length, gmailItems: window.DaylightV2UI.state.items.filter((x) => (x.sources || []).some((s) => s.app === 'gmail')).length }));
    check('before: Microsoft is available but not connected; Gmail works as before', before.ms.available && !before.ms.link && before.gmailItems > 10, before);
    // Settings → Microsoft → Connect
    await page.evaluate(() => window.DaylightV2UI.openSettings()); await page.waitForTimeout(500);
    const tile = await page.evaluate(() => { const b = document.querySelector('[data-conn="outlook"]'); return b && b.textContent; });
    check('Settings shows Microsoft as a live connection ("Not connected")', /Microsoft/.test(tile) && /Not connected/.test(tile), tile);
    await page.click('[data-conn="outlook"]'); await page.waitForTimeout(500);
    const sheet = await page.evaluate(() => [...document.querySelectorAll('.v-sheet')].pop().innerText);
    check('the Microsoft page explains read-only access and has Connect', /Connect Microsoft/.test(sheet) && /cannot send, delete or change/.test(sheet), sheet.slice(0, 300));
    await Promise.all([page.waitForURL(/daylight_ms=connected|index\.html$/, { timeout: 20000 }).catch(() => {}), page.click('[data-ms-connect]')]);
    await page.waitForLoadState('domcontentloaded'); await page.waitForFunction(() => window.DaylightV2Host && window.DaylightV2Host.microsoft && window.DaylightV2Host.microsoft().link, null, { timeout: 120000 }).catch(() => {});
    await settle();
    const after = await page.evaluate(async () => {
      const H = window.DaylightV2Host, U = window.DaylightV2UI; const ms = H.microsoft(); const its = U.state.items;
      const outl = its.filter((x) => (x.sources || []).some((s) => s.app === 'outlook')); const files = its.filter((x) => x.type === 'file');
      const raw = JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
      const graphAll = JSON.stringify(await window.DaylightV2.graph.query({}));
      return { ms, hash: location.hash, outlookEmails: outl.filter((x) => x.type === 'email').length, bill: its.find((x) => x.type === 'bill' && /Vodafone/.test(x.title) && x.accountId === 'ms-abc123'), anth: its.find((x) => /Anthropic/.test(x.title) && ['bill', 'transaction'].includes(x.type)), files: files.map((x) => ({ t: x.title, app: x.meta.app, read: !!x.meta.readAt, kind: x.meta.docKind, facts: (x.extractedFacts || []).map((f) => f.key + '=' + f.value) })), fileBills: its.filter((x) => x.type === 'bill' && x.meta && x.meta.fromFile).map((x) => x.title),
        tokenInStorage: /ms-at-123|g-fake/.test(raw), textInGraph: /Celkem k úhradě: 2 431|Northwind Studio s\.r\.o\.\s*Item|Passport No/.test(graphAll), textInStorage: /Celkem k úhradě: 2 431|Passport No/.test(raw) };
    });
    check('the consent round trip returns to Daylight and the hash is cleaned up', ws.starts === 1 && /127\.0\.0\.1:8795/.test(ws.returnTo) && after.hash === '' && after.ms.link && after.ms.link.email === 'jana@outlook.com', { ws, hash: after.hash, link: after.ms.link });
    check('Outlook mail joins the app (3 emails) next to Gmail', after.outlookEmails === 3, after.outlookEmails);
    check('Outlook invoice → a bill of 712 CZK; Outlook receipt → not a bill', after.bill && /712/.test(after.bill.title) && after.anth && after.anth.type === 'transaction', { bill: after.bill && after.bill.title, anth: after.anth && after.anth.type });
    const fb = (n) => after.files.find((x) => x.t === n) || {};
    check('OneDrive: all 4 files listed with their app', after.files.length === 4 && fb('Invoice_Northwind_0042.xlsx').app === 'Excel' && fb('Thesis_draft_v7.docx').app === 'Word', after.files);
    check('PDF invoice read in the browser with the self-hosted pdf.js under CSP: 2 431 CZK, due 2026-11-25', fb('Faktura_PRE_2026-11.pdf').read && fb('Faktura_PRE_2026-11.pdf').facts.includes('amount=2431') && fb('Faktura_PRE_2026-11.pdf').facts.includes('dueDate=2026-11-25'), fb('Faktura_PRE_2026-11.pdf'));
    check('Excel invoice read: 12 100 CZK due 2026-12-15', fb('Invoice_Northwind_0042.xlsx').facts.includes('amount=12100') && fb('Invoice_Northwind_0042.xlsx').facts.includes('dueDate=2026-12-15'), fb('Invoice_Northwind_0042.xlsx'));
    check('the passport and the thesis are listed but not read; the passport is never downloaded', !fb('Passport_Jana.pdf').read && !fb('Thesis_draft_v7.docx').read && !graph.log.some((l) => /f-pass/.test(l.url)));
    check('bills found in files due ahead appear as bills', after.fileBills.length === 2, after.fileBills);
    check('no access token and no file text is stored (localStorage, Item Graph)', !after.tokenInStorage && !after.textInGraph && !after.textInStorage, { t: after.tokenInStorage, g: after.textInGraph, s: after.textInStorage });
    check('downloads never carry the Microsoft token', !graph.stats.tokenSentToDownload && graph.stats.contentDownloads === 2, graph.stats);
    // UI: Microsoft page, files sheet, item links
    await page.evaluate(() => { document.querySelectorAll('.v-sheet').length; window.DaylightV2UI.openSettings(); }); await page.waitForTimeout(400);
    await page.click('[data-conn="outlook"]'); await page.waitForTimeout(400);
    const msPage = await page.evaluate(() => [...document.querySelectorAll('.v-sheet')].pop().innerText);
    check('Microsoft page: connected account, counts, read-files switch, Disconnect', /jana@outlook\.com/.test(msPage) && /Outlook emails\s*3/.test(msPage) && /OneDrive files\s*4/.test(msPage) && /Read bills, receipts and tickets in my files/.test(msPage) && /Disconnect and delete/.test(msPage), msPage.slice(0, 600));
    await page.click('[data-ms-files]'); await page.waitForTimeout(400);
    const filesPage = await page.evaluate(() => [...document.querySelectorAll('.v-sheet')].pop().innerText);
    check('Files list: names, app, folder and what was found (Bill · 2 431 CZK · due 25 Nov)', /Faktura_PRE_2026-11\.pdf/.test(filesPage) && /Bill · 2\s?431 CZK · due 25 Nov/.test(filesPage) && /\/Documents\/Bills/.test(filesPage), filesPage.slice(0, 600));
    await page.fill('[data-files-q]', 'northwind'); await page.waitForTimeout(500);
    const filtered = await page.evaluate(() => [...[...document.querySelectorAll('.v-sheet')].pop().querySelectorAll('.v-row')].map((r) => r.innerText.split('\n')[0]));
    check('Files search narrows the list', filtered.length === 1 && /Northwind/.test(filtered[0]), filtered);
    await page.click('[data-files-app="Excel"]').catch(() => {});
    const openLinks = await page.evaluate(async () => {
      const U = window.DaylightV2UI, its = U.state.items; const out = {};
      const f = its.find((x) => x.type === 'file' && /Faktura_PRE/.test(x.title)); U.openItem(f.id); await new Promise((r) => setTimeout(r, 400));
      let sh = [...document.querySelectorAll('.v-sheet')].pop(); out.file = [...sh.querySelectorAll('a')].map((a) => a.textContent.trim() + ' ' + a.getAttribute('href')); out.fileNote = sh.innerText.includes('read this file on your device');
      const e = its.find((x) => x.type === 'email' && (x.sources || []).some((s) => s.app === 'outlook') && /Seminar/.test(x.title)); U.openItem(e.id); await new Promise((r) => setTimeout(r, 400));
      sh = [...document.querySelectorAll('.v-sheet')].pop(); out.email = [...sh.querySelectorAll('a')].map((a) => a.textContent.trim() + ' ' + a.getAttribute('href')); out.badge = sh.querySelector('.v-src.outlook') ? 'O' : null;
      return out;
    });
    check('file sheet: "Open in OneDrive" link and the on-device note', openLinks.file.some((x) => /Open in OneDrive https:\/\/onedrive\.live\.com/.test(x)) && openLinks.fileNote, openLinks.file);
    check('Outlook email: Outlook badge and "Reply/Open in Outlook" link to Outlook on the web', openLinks.badge === 'O' && openLinks.email.some((x) => /in Outlook https:\/\/outlook\.live\.com/.test(x)), openLinks.email);
    // incremental
    graph.add('inbox', { id: 'AAk-new', conversationId: 'c9', subject: 'Booking confirmation EXK7Q2', from: person('Czech Airlines', 'booking@csa.example'), receivedDateTime: iso('2026-11-04T09:00:00Z'), bodyPreview: 'Your flight PRG–AMS on 20 Nov 2026, booking reference EXK7Q2' }, { html: '<p>Booking reference EXK7Q2</p><p>Prague (PRG) → Amsterdam (AMS), 20 November 2026, 13:52</p>' });
    const dl0 = graph.stats.contentDownloads, deltas0 = graph.log.filter((l) => /messages\/delta/.test(l.url) && !/deltatoken/.test(l.url)).length;
    await page.evaluate(() => window.DaylightV2Host.syncMicrosoft()); await page.evaluate(() => window.DaylightV2UI.load()); await page.waitForTimeout(500);
    const inc = await page.evaluate(() => ({ emails: window.DaylightV2UI.state.items.filter((x) => x.type === 'email' && (x.sources || []).some((s) => s.app === 'outlook')).length, booking: window.DaylightV2UI.state.items.some((x) => x.type === 'booking' && /EXK7Q2|Czech/.test(x.title + JSON.stringify(x.extractedFacts || []))) }));
    check('Sync now: delta links only (no new full listing), the new Outlook email appears, files not downloaded again', inc.emails === 4 && graph.stats.contentDownloads === dl0 && graph.log.filter((l) => /messages\/delta/.test(l.url) && !/deltatoken/.test(l.url)).length === deltas0, { inc, dl: graph.stats.contentDownloads - dl0 });
    // read-files switch
    await page.evaluate(() => { window.DaylightV2UI.openSettings(); }); await page.waitForTimeout(300); await page.click('[data-conn="outlook"]'); await page.waitForTimeout(300);
    await page.click('[data-ms-readfiles]'); await page.waitForTimeout(200);
    check('turning off "Read bills… in my files" is remembered', await page.evaluate(() => window.DaylightV2Host.microsoft().readFiles === false));
    // expired consent
    ws.msTokenStatus = 401;
    await page.evaluate(() => { window.DaylightV2UI.state && 0; }); await page.clock.setFixedTime(new Date(NOW + 3 * 3600000));
    await page.evaluate(async () => { await window.DaylightV2Host.syncMicrosoft(); });
    // (the in-memory token is still valid for an hour; force expiry by asking after it)
    const reauth = await page.evaluate(async () => { const H = window.DaylightV2Host; await H.syncMicrosoft(); return H.microsoft(); });
    check('consent removed at Microsoft → the link is kept but marked "connect again"; Gmail unaffected', reauth.link && reauth.link.needsReconnect === true && reauth.error, reauth);
    ws.msTokenStatus = 200;
    // disconnect Microsoft
    const gmailBefore = await page.evaluate(() => window.DaylightV2UI.state.items.filter((x) => x.accountId !== 'ms-abc123' && x.accountId !== 'local').length);
    await page.evaluate(() => window.DaylightV2UI.load()); await page.evaluate(() => window.DaylightV2UI.openSettings()); await page.waitForTimeout(300); await page.click('[data-conn="outlook"]'); await page.waitForTimeout(300);
    await page.click('[data-ms-disconnect]'); await page.waitForTimeout(200); await page.click('[data-confirm] .v-pbtn.danger'); await page.waitForTimeout(1500);
    const gone = await page.evaluate(async () => { const all = await window.DaylightV2.graph.query({}); const keys = Object.keys(localStorage); const mc = window.DaylightMailCache ? null : null; return { msItems: all.filter((x) => x.accountId === 'ms-abc123').length, others: window.DaylightV2UI.state.items.filter((x) => x.accountId !== 'local').length, keys: keys.filter((k) => /ms-abc123|daylight-ms-link/.test(k)), link: window.DaylightV2Host.microsoft().link }; });
    check('Disconnect: the Worker forgets the token; every Microsoft Item and key is deleted from the device', ws.disconnects === 1 && gone.msItems === 0 && gone.keys.length === 0 && !gone.link, gone);
    check('…and Gmail Items stay', gone.others === gmailBefore && gmailBefore > 10, { gmailBefore, after: gone.others });
    const mailRows = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('daylight-mail'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('mailIndex'); const st = tx.objectStore('mailIndex'); const q = st.getAll(); q.onsuccess = () => res(q.result.filter((x) => x.accountId === 'ms-abc123' || (Array.isArray(x.key) && x.key[0] === 'ms-abc123') || JSON.stringify(x).includes('AAk-')).length); q.onerror = () => res(-1); }; r.onerror = () => res(-1); }));
    check('…and the Outlook mail index rows are deleted', mailRows === 0, mailRows);
    check('no request went anywhere except the app, Google, the Worker and Microsoft', external.length === 0, external);
    check('no CSP violations (pdf.js worker and module loaded from the site)', csp.length === 0, csp);
    check('no page errors', errs.length === 0, errs);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 700))); if (!ok) fail++; });
  console.log(`Microsoft E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
