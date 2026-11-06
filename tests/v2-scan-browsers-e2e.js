/** Wallet scanner across browser capabilities, with uploaded pictures of real codes (made locally for the test):
 *  A) no BarcodeDetector — what Chrome on Windows and Firefox have → Daylight's local reader (ui/code-reader.js);
 *  B) a native BarcodeDetector that finds the code → its result is used;
 *  C) a native BarcodeDetector that finds nothing → the local reader still reads the picture.
 *  Every case: the value is stored and drawn locally, no request leaves the page, no CSP violation. Run: node tests/v2-scan-browsers-e2e.js
 *  Note: this runs in Chromium only. Firefox and real Windows Chrome are not available in this test environment; profile A
 *  reproduces their relevant difference (no BarcodeDetector). */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const appDir = path.resolve(__dirname, '..');
const T = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const serve = (port) => new Promise((r) => { const s = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let f = path.join(appDir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(appDir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }); s.listen(port, '127.0.0.1', () => r(s)); });
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);

(async () => {
  const srv = await serve(8797);
  const browser = await chromium.launch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-scan-'));
  try {
    // ---- make test pictures in a blank page: a screenshot-like QR, a tilted "photo" of a QR, and a Code 128 barcode ----
    const maker = await browser.newPage();
    await maker.goto('http://127.0.0.1:8797/manifest.json');
    await maker.addScriptTag({ path: path.join(appDir, 'ui', 'codes.js') });
    const QR = 'M1NOVAK/JANA EXK7Q2P PRGAMSKL 1352 309Y014C0042 147>5180';
    const BAR = 'MEMBER-778812';
    const pics = await maker.evaluate(async ({ QR, BAR }) => {
      const load = (svg) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const out = {};
      const draw = async (svg, w, h, fn, type, q) => { const img = await load(svg); const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#f4f1ea'; x.fillRect(0, 0, w, h); fn(x, img); return c.toDataURL(type || 'image/png', q); };
      out.qr = await draw(DaylightCodes.qrSvg(QR), 700, 900, (x, img) => { x.fillStyle = '#123'; x.font = '28px sans-serif'; x.fillText('Boarding pass', 40, 60); x.drawImage(img, 150, 200, 400, 400); });
      out.qrPhoto = await draw(DaylightCodes.qrSvg(QR), 900, 900, (x, img) => { const g = x.createLinearGradient(0, 0, 900, 0); g.addColorStop(0, '#9a9488'); g.addColorStop(1, '#efeae0'); x.fillStyle = g; x.fillRect(0, 0, 900, 900); x.translate(450, 450); x.rotate(0.21); x.transform(1, 0.06, -0.04, 1, 0, 0); x.filter = 'blur(0.8px)'; x.drawImage(img, -230, -230, 460, 460); }, 'image/jpeg', 0.6);
      out.bar = await draw(DaylightCodes.code128Svg(BAR), 800, 360, (x, img) => { x.drawImage(img, 120, 100, 560, 140); x.fillStyle = '#222'; x.font = '24px sans-serif'; x.fillText('Gym membership', 120, 60); });
      return out;
    }, { QR, BAR });
    const files = {};
    for (const [k, v] of Object.entries(pics)) { const ext = v.startsWith('data:image/jpeg') ? 'jpg' : 'png'; const f = path.join(tmp, k + '.' + ext); fs.writeFileSync(f, Buffer.from(v.split(',')[1], 'base64')); files[k] = f; }
    await maker.close();

    const PROFILES = [
      ['A (no BarcodeDetector: Chrome on Windows, Firefox)', 'none'],
      ['B (native BarcodeDetector finds the code)', 'native'],
      ['C (native BarcodeDetector finds nothing)', 'native-empty']
    ];
    for (const [label, mode] of PROFILES) {
      const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
      await ctx.addInitScript(({ mode, QR, BAR }) => {
        try { localStorage.setItem('daylight-v2-welcome-skipped', 'true'); } catch {}
        if (mode === 'none') { try { delete window.BarcodeDetector; } catch {} window.BarcodeDetector = undefined; }
        else window.BarcodeDetector = class { async detect() { if (mode === 'native-empty') return []; return [window.__expect === 'bar' ? { format: 'code_128', rawValue: BAR } : { format: 'qr_code', rawValue: QR }]; } static async getSupportedFormats() { return ['qr_code', 'code_128']; } };
      }, { mode, QR, BAR });
      const page = await ctx.newPage(); const errs = [], csp = [], external = [];
      page.on('pageerror', (e) => errs.push(e.message));
      page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
      page.on('request', (q) => { if (!q.url().startsWith('http://127.0.0.1') && !q.url().startsWith('data:')) external.push(q.url()); });
      await page.route(/^https:\/\//, (r) => r.abort());
      await page.goto('http://127.0.0.1:8797/index.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#v2 .v-tabs', { timeout: 20000 });
      const native = await page.evaluate(() => typeof window.BarcodeDetector === 'function');
      // since v106 even the page load contacts no other host (fonts are served by the site)
      const scan = async (file, title, expect) => {
        await page.evaluate((e) => { window.__expect = e; window.DaylightV2Host.openScanner(); }, expect);
        await page.setInputFiles('.v-scan input[type=file]', file);
        await page.waitForSelector('.v-scan [data-step="review"]:not([hidden])', { timeout: 20000 });
        const badge = await page.textContent('.v-scan [data-scan-engine]');
        await page.fill('.v-scan [name=title]', title);
        await page.click('.v-scan button[type=submit]');
        await page.waitForFunction((t) => window.DaylightV2UI.state.items.some((x) => x.title === t), title, { timeout: 8000 }).catch(() => {});
        return page.evaluate(async ({ t, badge }) => {
          const p = JSON.parse(localStorage.getItem('daylight-wallet') || '[]').find((x) => x.title === t) || {};
          const it = window.DaylightV2UI.state.items.find((x) => x.title === t);
          let drawn = null; if (it) { window.DaylightV2UI.openItem(it.id); await new Promise((r) => setTimeout(r, 400)); const sh = [...document.querySelectorAll('.v-sheet')].pop(); drawn = sh && sh.querySelector('[data-code]') ? sh.querySelector('[data-code]').dataset.code : null; }
          return { value: p.qrPayload || '', format: p.barcodeFormat || '', images: [p.qrImage, p.barcodeImage].filter(Boolean), drawn, badge };
        }, { t: title, badge });
      };
      const q = await scan(files.qr, 'QR ' + mode, 'qr'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      const qp = await scan(files.qrPhoto, 'QR photo ' + mode, 'qr'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      const b = await scan(files.bar, 'Bar ' + mode, 'bar'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      check(`${label}: BarcodeDetector ${mode === 'none' ? 'absent' : 'present'} as intended`, native === (mode !== 'none'));
      check(`${label}: uploaded screenshot of a QR → exact value stored, drawn locally`, q.value === QR && q.format === 'qr_code' && q.drawn === 'qr' && q.images.length === 0, q);
      check(`${label}: uploaded tilted, blurred JPEG photo of a QR → exact value`, qp.value === QR && qp.drawn === 'qr', qp);
      check(`${label}: uploaded picture of a Code 128 barcode → exact value, drawn as a barcode`, b.value === BAR && b.format === 'code_128' && b.drawn === 'code128', b);
      check(`${label}: the review screen says a code was found`, /Found 1 code/.test(q.badge) && /Found 1 code/.test(b.badge), { q: q.badge, b: b.badge });
      check(`${label}: from page load through scanning nothing left the page (no external request) and no CSP violation`, external.length === 0 && csp.length === 0, { external, csp });
      check(`${label}: no page errors`, errs.length === 0, errs);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); if (!ok) fail++; });
  console.log(`Scanner browsers E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
