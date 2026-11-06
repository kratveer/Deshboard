/** Service-worker upgrade and data migration: a browser that ran an older release (v102 with the classic view, or v103)
 *  opens this release. The new cache replaces the old one, the new app runs, and data saved by the older release keeps
 *  working (own tasks, Wallet passes — whose stored external code-image URLs are never loaded), while the retired
 *  classic-view choice is removed. Usage: node tests/sw-upgrade-e2e.js   (old releases are taken from git: 3ae2a24 = v102, 157fc99 = v103) */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process');
const { chromium } = require('playwright');
const appDir = path.resolve(__dirname, '..');
const T = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const NEW_CACHE = /const CACHE='([^']+)'/.exec(fs.readFileSync(path.join(appDir, 'sw.js'), 'utf8'))[1];

function exportRelease(rev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-' + rev + '-'));
  execSync(`git -C "${appDir}" archive ${rev} | tar -x -C "${dir}"`);
  // icons are binary files that may not be in this checkout's history: copy them so the old service worker can install
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) if (!fs.existsSync(path.join(dir, f)) && fs.existsSync(path.join(appDir, f))) fs.copyFileSync(path.join(appDir, f), path.join(dir, f));
  return dir;
}
(async () => {
  let root = null;
  const srv = http.createServer((q, r) => { const u = new URL(q.url, 'http://x'); let f = path.join(root, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(r); });
  await new Promise((ok) => srv.listen(8794, ok));
  const browser = await chromium.launch();
  try {
    for (const [rev, label] of [['3ae2a24', 'v102 (classic view era)'], ['157fc99', 'v103']]) {
      root = exportRelease(rev);
      const oldCache = /const CACHE='([^']+)'/.exec(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'))[1];
      const ctx = await browser.newContext();
      const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
      const external = []; page.on('request', (q) => { if (!q.url().startsWith('http://localhost')) external.push(q.url()); });
      await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
      // 1) the old release, with data a user of that release would have
      await page.goto('http://localhost:8794/', { waitUntil: 'load' });
      await page.evaluate(() => {
        localStorage.setItem('daylight-ui', 'v1'); localStorage.setItem('daylight-theme', 'dark');
        localStorage.setItem('daylight-personal-tasks', JSON.stringify([{ id: 't-old-1', title: 'Renew passport', created: Date.now() }]));
        localStorage.setItem('daylight-wallet', JSON.stringify([{ id: 'w-old-1', title: 'Gym card (old release)', kind: 'others', at: new Date().toISOString(), qrPayload: 'GYM-4411', barcode: 'GYM-4411', qrImage: 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=GYM-4411', barcodeImage: 'https://bwipjs-api.metafloor.com/?bcid=code128&text=GYM-4411', qrAuthentic: true, scanSource: true }]));
        localStorage.setItem('daylight-v2-welcome-skipped', 'true');
      });
      await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 15000 }).catch(() => {});
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
      const before = await page.evaluate(async () => { const rs = await navigator.serviceWorker.getRegistrations(); return { caches: await caches.keys(), active: rs.some((r) => r.active), regs: rs.map((r) => [r.scope, r.active && r.active.state, r.installing && r.installing.state, r.waiting && r.waiting.state]) }; });
      check(`${label}: the old release is installed and cached (${before.caches.join(',')})`, before.active && before.caches.length === 1 && before.caches[0] === oldCache, before);
      // 2) this release is published; the browser comes back
      root = appDir; external.length = 0;
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(2500);
      const after = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 500));
        const it = window.DaylightV2UI ? window.DaylightV2UI.state.items : [];
        const pass = it.find((x) => x.title === 'Gym card (old release)');
        let drawn = null;
        if (pass) { window.DaylightV2UI.openItem(pass.id); await new Promise((r) => setTimeout(r, 500)); const sh = [...document.querySelectorAll('.v-sheet')].pop(); drawn = sh && sh.querySelector('[data-code]') ? sh.querySelector('[data-code]').dataset.code : null; }
        return { caches: await caches.keys(), app: !!document.querySelector('#v2 .v-tabs'), codes: !!window.DaylightCodes, classicMarkup: !!document.querySelector('#mapp, .shell, #layout, .m-tabs'),
          ui: localStorage.getItem('daylight-ui'), theme: localStorage.getItem('daylight-theme'), dark: document.body.classList.contains('dark'),
          task: it.some((x) => x.type === 'task' && x.title === 'Renew passport'), pass: !!pass, passMeta: pass ? { qrImage: pass.meta.qrImage, codeText: pass.meta.codeText } : null, drawn };
      });
      check(`${label} → ${NEW_CACHE}: only the new cache remains, the old one (${oldCache}) is deleted`, after.caches.length === 1 && after.caches[0] === NEW_CACHE, after.caches);
      check(`${label} → new release: the app runs (five tabs, local code drawing loaded, no classic markup)`, after.app && after.codes && !after.classicMarkup, after);
      check(`${label} → new release: the retired classic-view choice is removed; theme kept`, after.ui === null && after.theme === 'dark' && after.dark, { ui: after.ui, theme: after.theme });
      check(`${label} → new release: own task and Wallet pass from the old release still appear`, after.task && after.pass, { task: after.task, pass: after.pass });
      check(`${label} → new release: the old pass's stored external image URLs are ignored; its code is drawn locally`, after.passMeta && !after.passMeta.qrImage && after.passMeta.codeText === 'GYM-4411' && after.drawn === 'qr', after.passMeta);
      check(`${label} → new release: no request to qrserver / metafloor`, !external.some((u) => /qrserver|metafloor/.test(u)), external.filter((u) => /qrserver|metafloor/.test(u)));
      check(`${label} → new release: no page errors`, errs.filter((e) => !/Failed to fetch/.test(e)).length === 0, errs);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); if (!ok) fail++; });
  console.log(`Service-worker upgrade E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
