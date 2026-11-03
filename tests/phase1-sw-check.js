/** Phase 1: service worker caches the new module and the app shell still boots offline. Run: node tests/phase1-sw-check.js */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const dir = path.resolve(__dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const srv = http.createServer((q, r) => { const u = new URL(q.url, 'http://x'); let f = path.join(dir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
srv.listen(8790, async () => {
  const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.goto('http://localhost:8790/', { waitUntil: 'load' });
  await page.waitForFunction(() => navigator.serviceWorker.controller || new Promise((r) => setTimeout(r, 100)), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const s1 = await page.evaluate(async () => { const keys = await caches.keys(); const c = keys.includes('daylight-v89') ? await caches.open('daylight-v89') : null; const urls = c ? (await c.keys()).map((k) => new URL(k.url).pathname) : []; return { keys, hasModule: urls.some((u) => u.endsWith('/gmail-sync.js')), shellCount: urls.length, sw: !!(await navigator.serviceWorker.getRegistration())?.active }; });
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(1500);
  const s2 = await page.evaluate(() => ({ module: !!window.DaylightGmailSync, store: !!window.DaylightStore, status: document.querySelector('#sync-status')?.textContent || '' }));
  const ok = s1.sw && s1.keys.includes('daylight-v89') && s1.hasModule && s2.module && s2.store && !errs.length;
  fs.writeFileSync(path.join(__dirname, 'phase1-sw-check-report.json'), JSON.stringify({ online: s1, offlineReload: s2, pageErrors: errs, ok }, null, 2));
  console.log(JSON.stringify({ online: s1, offlineReload: s2, pageErrors: errs, ok }));
  await b.close(); srv.close(); process.exitCode = ok ? 0 : 1;
});
