/** Floating pill navigation (phone, tablet, desktop sidebar), red-dot tab indicators, no horizontal overflow, and the Wallet scanner
 *  (photo → confirm → saved pass → Wallet Item). Sample data and an offline page: no Google, nothing real. Run: node tests/v2-nav-scan-e2e.js */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const appDir = path.resolve(__dirname, '..');
const T = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
function serve(dir, port) {
  return new Promise((r) => {
    const srv = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(dir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res); });
    srv.listen(port, '127.0.0.1', () => r(srv));
  });
}
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);

(async () => {
  const srv = await serve(appDir, 8792);
  const browser = await chromium.launch();
  const shots = process.env.SHOTS || null;
  try {
    // ---- navigation on three screen sizes (sample data) ----
    for (const [name, w, h, dark] of [['phone', 390, 844, false], ['phone-dark', 390, 844, true], ['tablet', 820, 1100, false], ['desktop', 1280, 800, false]]) {
      const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: w, height: h } });
      await ctx.addInitScript((d) => { try { localStorage.setItem('daylight-v2-welcome-skipped', 'true'); if (d) localStorage.setItem('daylight-theme', 'dark'); } catch {} }, dark);
      const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errs.push('CSP: ' + m.text().slice(0, 200)); });
      await page.route(/^https:\/\//, (r) => r.abort());
      await page.goto('http://127.0.0.1:8792/index.html?v2sample=1', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#v2 .v-tab.on', { timeout: 20000 }); await page.waitForTimeout(700);
      await page.click('.v-tab[data-tab="money"]'); await page.waitForTimeout(700);
      const m = await page.evaluate(() => {
        const nav = document.querySelector('.v-tabs'), r = nav.getBoundingClientRect(), cs = getComputedStyle(nav);
        const on = document.querySelector('.v-tab.on').getBoundingClientRect(), th = document.querySelector('.v-tab-thumb').getBoundingClientRect();
        const dots = [...document.querySelectorAll('.v-badge')].filter((b) => !b.hidden).map((b) => ({ text: b.textContent, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, label: b.closest('.v-tab').getAttribute('aria-label') }));
        return { left: r.left, right: innerWidth - r.right, bottom: innerHeight - r.bottom, top: r.top, width: r.width, height: r.height, radius: parseFloat(cs.borderTopLeftRadius), position: cs.position,
          thumb: { dx: Math.abs(th.left - on.left), dw: Math.abs(th.width - on.width), w: th.width }, active: document.querySelector('.v-tab.on').dataset.tab, current: document.querySelector('.v-tab.on').getAttribute('aria-current'),
          dots, overflow: document.documentElement.scrollWidth > innerWidth + 1, vw: innerWidth, vh: innerHeight };
      });
      if (name === 'desktop') {
        check(`${name}: tabs become a full-height sidebar on wide screens`, m.left === 0 && m.top === 0 && Math.round(m.height) === m.vh && m.width <= 240 && m.radius === 0, m);
      } else {
        check(`${name}: bottom navigation floats as a pill (gap below and at the sides, fully rounded)`, m.position === 'fixed' && m.bottom >= 10 && m.left >= 12 && m.right >= 12 && m.radius >= m.height / 2 - 1, m);
        check(`${name}: the highlight sits behind the active tab after switching`, m.active === 'money' && m.current === 'page' && m.thumb.w > 20 && m.thumb.dx <= 1 && m.thumb.dw <= 1, m.thumb);
        if (name === 'tablet') check('tablet: the pill is centred and compact', m.width <= 520 && Math.abs(m.left - m.right) <= 1, m);
      }
      check(`${name}: tabs with something new show a small red dot, no numbers (count stays in the accessible name)`, m.dots.length >= 1 && m.dots.every((d) => d.text === '' && d.w <= 14 && d.h <= 14 && / · \d+ new$/.test(d.label)), m.dots);
      check(`${name}: no horizontal scrolling`, !m.overflow, { vw: m.vw });
      check(`${name}: no page errors`, errs.length === 0, errs);
      if (shots) await page.screenshot({ path: path.join(shots, `nav-${name}.png`) });
      await ctx.close();
    }

    // ---- Wallet scanner: photo → confirm → saved pass → Wallet Item (signed out, device data only) ----
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => {
      try { localStorage.setItem('daylight-v2-welcome-skipped', 'true'); } catch {}
      // stand-in for the browser's own BarcodeDetector (headless Chromium has none): returns whatever the test sets
      window.BarcodeDetector = class { async detect() { return window.__codes || []; } static async getSupportedFormats() { return ['qr_code', 'code_128', 'pdf417']; } };
    });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errs.push('CSP: ' + m.text().slice(0, 200)); });
    const csp = []; page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
    const external = []; page.on('request', (q) => { if (!q.url().startsWith('http://127.0.0.1')) external.push(q.url()); });
    await page.route(/^https:\/\//, (r) => r.abort());
    await page.goto('http://127.0.0.1:8792/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#v2 .v-tabs', { timeout: 20000 }); await page.waitForTimeout(500);
    // the Wallet → Add sheet offers the scanner
    await page.click('.v-tab[data-tab="wallet"]'); await page.waitForTimeout(400);
    const addOffered = await page.evaluate(() => { const b = document.querySelector('.v-screen[data-screen="wallet"] [data-addpass]'); if (b) b.click(); return !!b; });
    await page.waitForTimeout(500);
    const scanBtn = await page.$('[data-scan]');
    check('Wallet → Add offers "Scan a ticket or card"', addOffered && !!scanBtn);
    if (scanBtn) await scanBtn.click(); else await page.evaluate(() => window.DaylightV2Host.openScanner());
    await page.waitForSelector('.v-scan.on [data-step="landing"]:not([hidden])', { timeout: 5000 });
    check('the scanner opens on its own screen inside the app', await page.evaluate(() => !!document.querySelector('#v2 > .v-scan.on')));
    // a photo whose file name looks like a booking reference: the reference must not become a scannable code
    const tmp = path.join(os.tmpdir(), 'Flight OK123 PNR ABC123.png'); fs.copyFileSync(path.join(appDir, 'icon-192.png'), tmp);
    await page.setInputFiles('.v-scan input[type=file]', tmp);
    await page.waitForSelector('.v-scan [data-step="review"]:not([hidden])', { timeout: 10000 });
    const review = await page.evaluate(() => ({ title: document.querySelector('.v-scan [name=title]').value, preview: (document.querySelector('[data-scan-preview]').src || '').slice(0, 22) }));
    check('the photo is read and the review form is filled in', review.preview.startsWith('data:image/') && review.title.length > 0, review);
    await page.fill('.v-scan [name=title]', 'Gym membership card');
    await page.selectOption('.v-scan [name=kind]', 'others');
    await page.click('.v-scan button[type=submit]');
    await page.waitForFunction(() => window.DaylightV2UI.state.items.some((x) => x.title === 'Gym membership card'), null, { timeout: 8000 }).catch(() => {});
    const after = await page.evaluate(() => {
      const w = JSON.parse(localStorage.getItem('daylight-wallet') || '[]'); const p = w.find((x) => x.title === 'Gym membership card') || null;
      const it = window.DaylightV2UI.state.items.find((x) => x.title === 'Gym membership card') || null;
      return { saved: !!p, kind: p && p.kind, scanSource: p && p.scanSource, code: p ? (p.qrPayload || p.barcode || '') : null, qrImage: p ? p.qrImage : null, item: it ? { type: it.type, accountId: it.accountId } : null,
        open: document.querySelector('.v-scan').classList.contains('on'), tab: window.DaylightV2UI.state.tab };
    });
    check('Add to Wallet saves the pass on this device and it appears as a Wallet Item', after.saved && after.kind === 'others' && after.scanSource && after.item && after.item.accountId === 'local', after);
    check('no code is invented from a booking reference in the text (no QR, no barcode)', after.code === '' && !after.qrImage, after);
    check('the scanner closes and the app shows Wallet', !after.open && after.tab === 'wallet', after);
    // Escape closes it too
    await page.evaluate(() => window.DaylightV2Host.openScanner()); await page.waitForTimeout(200); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    check('Escape closes the scanner', await page.evaluate(() => !document.querySelector('.v-scan').classList.contains('on')));

    // codes really detected in the picture are stored as values and drawn locally (QR, Code 128); others are shown as text
    const scanWith = async (codes, title) => {
      await page.evaluate((c) => { window.__codes = c; window.DaylightV2Host.openScanner(); }, codes);
      await page.setInputFiles('.v-scan input[type=file]', tmp);
      await page.waitForSelector('.v-scan [data-step="review"]:not([hidden])', { timeout: 10000 });
      await page.fill('.v-scan [name=title]', title); await page.selectOption('.v-scan [name=kind]', 'tickets');
      await page.click('.v-scan button[type=submit]');
      await page.waitForFunction((t) => window.DaylightV2UI.state.items.some((x) => x.title === t), title, { timeout: 8000 }).catch(() => {});
      return page.evaluate(async (t) => {
        const p = JSON.parse(localStorage.getItem('daylight-wallet') || '[]').find((x) => x.title === t) || {};
        const it = window.DaylightV2UI.state.items.find((x) => x.title === t);
        if (it) { window.DaylightV2UI.openItem(it.id); await new Promise((r) => setTimeout(r, 500)); }
        const sh = [...document.querySelectorAll('.v-sheet')].pop();
        const out = { stored: { qrPayload: p.qrPayload, format: p.barcodeFormat, qrImage: p.qrImage, barcodeImage: p.barcodeImage }, meta: it && it.meta ? { codeText: it.meta.codeText, codeFormat: it.meta.codeFormat } : null,
          drawn: sh ? (sh.querySelector('[data-code]') || {}).dataset?.code || null : null, svg: !!(sh && sh.querySelector('[data-code] svg')),
          remoteImgs: sh ? [...sh.querySelectorAll('img')].map((i) => i.getAttribute('src')).filter((u) => /^https?:/.test(u || '')) : [], text: sh ? sh.innerText : '' };
        // the caller closes the sheet with Escape
        return out;
      }, title);
    };
    const qrValue = 'M1TEST/PASSENGER EABC123 PRGLHROK 0850 123Y012A0001 100';
    const q = await scanWith([{ format: 'qr_code', rawValue: qrValue }], 'Boarding pass QR');
    check('a detected QR code is stored as its value only (no image URL) and drawn locally as an inline SVG', q.stored.qrPayload === qrValue && q.stored.format === 'qr_code' && !q.stored.qrImage && !q.stored.barcodeImage && q.drawn === 'qr' && q.svg && q.remoteImgs.length === 0, q);
    const svgOk = await page.evaluate((v) => { const s = window.DaylightCodes.qrSvg(v); const m = window.DaylightCodes.qrMatrix(v, 'M'); return !!s && m.length >= 21 && !/https?:\/\/(?!www\.w3\.org)/.test(s); }, qrValue);
    check('the QR SVG is generated in the page and references no external resource', svgOk);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    const b = await scanWith([{ format: 'code_128', rawValue: 'MEMBER-778812' }], 'Gym barcode');
    check('a detected Code 128 barcode is drawn locally as a barcode', b.stored.format === 'code_128' && b.drawn === 'code128' && b.svg && b.remoteImgs.length === 0, b);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    const pdf = await scanWith([{ format: 'pdf417', rawValue: 'PDF417-PAYLOAD-1' }], 'Rail PDF417');
    check('a symbology that cannot be redrawn (PDF417) is not faked as a QR: the value is shown as text with a note', !pdf.drawn && /can’t be redrawn/.test(pdf.text) && /PDF417-PAYLOAD-1/.test(pdf.text), { drawn: pdf.drawn, text: pdf.text.slice(0, 200) });
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    // a pass saved by an older release with an external image URL: the URL is never loaded; the code is drawn locally
    await page.evaluate(async () => {
      const w = JSON.parse(localStorage.getItem('daylight-wallet') || '[]');
      w.push({ id: 'legacy-1', title: 'Old saved ticket', kind: 'tickets', at: new Date().toISOString(), qrPayload: 'LEGACY-777', barcode: 'LEGACY-777', qrImage: 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=LEGACY-777', barcodeImage: 'https://bwipjs-api.metafloor.com/?bcid=code128&text=LEGACY-777', qrAuthentic: true, scanSource: true });
      localStorage.setItem('daylight-wallet', JSON.stringify(w)); await window.DaylightV2.local.importLocal();
    });
    await page.waitForTimeout(400);
    const legacy = await page.evaluate(async () => {
      const it = window.DaylightV2UI.state.items.find((x) => x.title === 'Old saved ticket'); if (!it) return { missing: true };
      window.DaylightV2UI.openItem(it.id); await new Promise((r) => setTimeout(r, 500));
      const sh = [...document.querySelectorAll('.v-sheet')].pop();
      return { meta: { qrImage: it.meta.qrImage, barcodeImage: it.meta.barcodeImage, codeText: it.meta.codeText }, drawn: (sh.querySelector('[data-code]') || {}).dataset?.code || null, html: sh.innerHTML.includes('qrserver') || sh.innerHTML.includes('metafloor') };
    });
    check('migration: an older pass keeps working — its stored external image URLs are ignored and the code is drawn locally', legacy.meta && !legacy.meta.qrImage && !legacy.meta.barcodeImage && legacy.meta.codeText === 'LEGACY-777' && legacy.drawn === 'qr' && !legacy.html, legacy);
    check('no request ever reached api.qrserver.com or bwipjs-api.metafloor.com', !external.some((u) => /qrserver|metafloor/.test(u)), external);
    check('no Content-Security-Policy violations while scanning and showing passes', csp.length === 0, csp);
    check('scanner: nothing was sent anywhere (no external requests besides fonts)', external.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u)).length === 0, external);
    check('scanner: no page errors', errs.length === 0, errs);
    if (shots) await page.screenshot({ path: path.join(shots, 'scan-after.png') });
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); if (!ok) fail++; });
  console.log(`Navigation + scanner E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
