/** Release check on a CLEAN checkout: site-files.txt lists every asset the app needs (index.html scripts and styles,
 *  service-worker shell, manifest icons), every listed file is tracked by Git, the published site is built exactly as the
 *  GitHub Pages workflow does, and the built site serves without a single missing file: the service worker installs
 *  (its cache.addAll fails on any 404) and the app starts. Usage: node tests/site-build-check.js [repo dir] */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), { execSync } = require('child_process');
const { chromium } = require('playwright');
const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const T = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff', '.txt': 'text/plain' };
(async () => {
  const listed = fs.readFileSync(path.join(repo, 'site-files.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const idx = fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(repo, 'sw.js'), 'utf8');
  const needed = new Set([...idx.matchAll(/(?:src|href)="([^"?#:]+)(?:\?[^"]*)?"/g)].map((m) => m[1]));
  JSON.parse(/const SHELL=(\[[^\]]*\])/.exec(sw)[1].replace(/'/g, '"')).forEach((f) => needed.add(f));
  JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8')).icons.forEach((i) => needed.add(i.src));
  needed.delete('./'); ['sw.js', 'index.html'].forEach((f) => needed.add(f));
  const missingFromList = [...needed].filter((f) => !listed.includes(f));
  check('site-files.txt lists every asset referenced by index.html, the service worker and the manifest', missingFromList.length === 0, missingFromList);
  let tracked = [];
  try { tracked = execSync('git ls-files', { cwd: repo, encoding: 'utf8' }).split('\n'); } catch {}
  const untracked = listed.filter((f) => !tracked.includes(f));
  check('every published file is tracked by Git (a clean checkout has it)', tracked.length > 0 && untracked.length === 0, untracked);
  // build _site exactly like .github/workflows/pages.yml
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-site-'));
  const notFound = [];
  for (const f of listed) { const src = path.join(repo, f); if (!fs.existsSync(src)) { notFound.push(f); continue; } fs.mkdirSync(path.join(site, path.dirname(f)), { recursive: true }); fs.copyFileSync(src, path.join(site, f)); }
  check('the site builds: every listed file exists', notFound.length === 0, notFound);
  const wf = fs.readFileSync(path.join(repo, '.github', 'workflows', 'pages.yml'), 'utf8');
  check('the Pages workflow publishes the built _site (not the whole repository)', /path:\s*_site/.test(wf) && /site-files\.txt/.test(wf));
  for (const f of ['tests', 'docs', 'server', '.env', 'tools']) check(`nothing from ${f} is published`, !listed.some((l) => l === f || l.startsWith(f + '/')));
  // serve the built site and load it
  const status = [];
  const srv = http.createServer((q, r) => { const u = new URL(q.url, 'http://x'); let f = path.join(site, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f = path.join(f, 'index.html'); const ok = f.startsWith(site) && fs.existsSync(f); status.push([u.pathname, ok ? 200 : 404]); if (!ok) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise((ok) => srv.listen(8798, ok));
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errs.push(m.text()); });
    await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await page.goto('http://localhost:8798/?v2sample=1', { waitUntil: 'load' });
    await page.waitForSelector('#v2 .v-tab.on', { timeout: 20000 });
    for (let i = 0; i < 40; i++) { if (await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active)) break; await page.waitForTimeout(500); }
    const st = await page.evaluate(async () => { const keys = await caches.keys(); const c = keys[0] ? await caches.open(keys[0]) : null; return { keys, cached: c ? (await c.keys()).length : 0, active: !!(await navigator.serviceWorker.getRegistration())?.active, tabs: document.querySelectorAll('#v2 .v-tab').length, privacy: (await fetch('privacy.html')).status, font: (await document.fonts.ready, [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Inter' && f.status === 'loaded').length) }; });
    const shell = JSON.parse(/const SHELL=(\[[^\]]*\])/.exec(sw)[1].replace(/'/g, '"'));
    check('the built site serves every request without a 404', status.every(([, s]) => s === 200), status.filter(([, s]) => s !== 200));
    check('the service worker installs and caches the whole shell from the built site', st.active && st.cached === shell.length, { ...st, shell: shell.length });
    check('the app starts from the built site (five tabs) and privacy.html is published', st.tabs === 5 && st.privacy === 200, st);
    check('the Inter typeface loads from the site itself (no font service)', st.font >= 1 && status.some(([p, s]) => /\/ui\/fonts\/inter-\d+\.woff$/.test(p) && s === 200), st.font);
    check('no page errors or CSP violations', errs.length === 0, errs);
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); if (!ok) fail++; });
  console.log(`Site build check (${repo}): ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
