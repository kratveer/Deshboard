/** IndexedDB self-healing (real Chromium IndexedDB): missing stores are created, existing rows are never lost,
 *  healthy and newer databases are left alone, and two openers racing on a broken database both succeed. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const appDir = path.resolve(__dirname, '..');
const srv = http.createServer((q, r) => { const p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p === '/t.html') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<!doctype html><script src="/gmail-cache.js"></script><script src="/graph/item-graph.js"></script>'); } fs.readFile(path.join(appDir, p), (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': 'text/javascript' }); r.end(d); }); });
(async () => {
  await new Promise((r) => srv.listen(8788, '127.0.0.1', r));
  const browser = await chromium.launch();
  const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
  try {
    const page = await browser.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errs.push('CSP: ' + m.text().slice(0, 200)); });
    await page.goto('http://127.0.0.1:8788/t.html');
    const res = await page.evaluate(async () => {
      const raw = (name, version, upgrade) => new Promise((res, rej) => { const r = version ? indexedDB.open(name, version) : indexedDB.open(name); r.onupgradeneeded = () => upgrade && upgrade(r.result, r.transaction); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const info = async (name) => { const db = await raw(name); const o = { version: db.version, stores: [...db.objectStoreNames].sort() }; db.close(); return o; };
      const del = (name) => new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
      const out = {};
      const MC = window.DaylightMailCache, G = window.DaylightItemGraph;
      // 1. partial mail cache: only mailIndex (with a real row) at v1 → heal keeps the row, adds the rest
      await del('t-mail-1');
      let db = await raw('t-mail-1', 1, (d) => d.createObjectStore('mailIndex', { keyPath: ['accountId', 'messageId'] }));
      await new Promise((res) => { const t = db.transaction('mailIndex', 'readwrite'); t.objectStore('mailIndex').put({ accountId: 'a', messageId: 'm1', subject: 'keep me', status: 'classified' }); t.oncomplete = res; }); db.close();
      let c = MC.createMailCache({ indexedDB, dbName: 't-mail-1' });
      const rows1 = await c.all('a'); await c.putMany('a', [{ messageId: 'm2', status: 'classified' }]); await c.setCheckpoint('a', { windowDays: 30 });
      out.partial = { rows: rows1.map((r) => r.subject), after: await info('t-mail-1'), checkpoint: await c.getCheckpoint('a') };
      // 2. empty v1 (the state seen on the real device)
      await del('t-mail-2'); db = await raw('t-mail-2', 1); db.close();
      c = MC.createMailCache({ indexedDB, dbName: 't-mail-2' }); await c.putMany('a', [{ messageId: 'x', status: 'classified' }]);
      out.empty = { info: await info('t-mail-2'), n: (await c.all('a')).length };
      // 3. healthy DB keeps its version and rows (no needless upgrade)
      c = MC.createMailCache({ indexedDB, dbName: 't-mail-2' });
      out.healthy = { before: (await info('t-mail-2')).version, n: (await c.all('a')).length, after: (await info('t-mail-2')).version };
      // 4. brand-new DB is created at version 1 with every store
      await del('t-mail-3'); c = MC.createMailCache({ indexedDB, dbName: 't-mail-3' }); await c.all('a');
      out.fresh = await info('t-mail-3');
      // 5. a database already at a higher version opens without VersionError
      await del('t-mail-4'); db = await raw('t-mail-4', 1); db.close();
      c = MC.createMailCache({ indexedDB, dbName: 't-mail-4' }); await c.all('a');            // heals to v2
      db = await raw('t-mail-4', 5); db.close();                                                // someone moved it to v5
      c = MC.createMailCache({ indexedDB, dbName: 't-mail-4' }); out.higher = { n: (await c.all('a')).length, info: await info('t-mail-4') };
      // 6. two openers race on an empty DB; both succeed and each one's write survives
      await del('t-mail-5'); db = await raw('t-mail-5', 1); db.close();
      const c1 = MC.createMailCache({ indexedDB, dbName: 't-mail-5' }), c2 = MC.createMailCache({ indexedDB, dbName: 't-mail-5' });
      const r6 = await Promise.allSettled([c1.putMany('a', [{ messageId: 'p1', status: 'x' }]), c2.putMany('a', [{ messageId: 'p2', status: 'x' }])]);
      const r6b = r6.some((x) => x.status === 'rejected') ? await Promise.allSettled([c1.putMany('a', [{ messageId: 'p1', status: 'x' }]), c2.putMany('a', [{ messageId: 'p2', status: 'x' }])]) : r6;
      out.race = { first: r6.map((x) => x.status + (x.reason ? ':' + x.reason.message : '')), retry: r6b.map((x) => x.status), ids: (await MC.createMailCache({ indexedDB, dbName: 't-mail-5' }).all('a')).map((r) => r.messageId).sort() };
      // 7. an older page still holding a v1 connection (old code closes on versionchange) does not block the heal
      await del('t-mail-6'); db = await raw('t-mail-6', 1); db.onversionchange = () => db.close();
      c = MC.createMailCache({ indexedDB, dbName: 't-mail-6' }); await c.putMany('a', [{ messageId: 'o', status: 'x' }]);
      out.oldTab = { n: (await c.all('a')).length };
      // 8. graph: items present with data, links/rules/actions/log missing → heal keeps items
      await del('t-graph'); db = await raw('t-graph', 1, (d) => d.createObjectStore('items', { keyPath: 'id' }));
      await new Promise((res) => { const t = db.transaction('items', 'readwrite'); t.objectStore('items').put({ id: 'it_1', accountId: 'a', type: 'bill', title: 'keep me', status: 'done', sources: [] }); t.oncomplete = res; }); db.close();
      const g = G.createGraph({ indexedDB, dbName: 't-graph' });
      const kept = await g.getItem('it_1'); await g.rules.put({ id: 'r1', accountId: 'a' });
      out.graph = { kept: kept && kept.title + '/' + kept.status, info: await info('t-graph'), rules: (await g.rules.all()).length };
      return out;
    });
    const MAILSTORES = ['aiQueue', 'attachmentMeta', 'checkpoint', 'domainCategory', 'mailFacts', 'mailIndex', 'syncMetrics', 'threads'];
    check('partial mail cache: existing row kept, missing stores created, version bumped', res.partial.rows.join() === 'keep me' && JSON.stringify(res.partial.after.stores) === JSON.stringify(MAILSTORES) && res.partial.after.version === 2 && res.partial.checkpoint && res.partial.checkpoint.windowDays === 30, res.partial);
    check('empty v1 mail cache (device state) heals and accepts writes', res.empty.n === 1 && res.empty.info.stores.length === 8 && res.empty.info.version === 2, res.empty);
    check('healthy database: no version bump, rows intact', res.healthy.before === res.healthy.after && res.healthy.n === 1, res.healthy);
    check('fresh database: created at version 1 with all stores', res.fresh.version === 1 && res.fresh.stores.length === 8, res.fresh);
    check('database at a higher version opens without VersionError', res.higher.info.version === 5 && res.higher.n === 0, res.higher);
    check('two openers racing on an empty database: both writes land (after at most one retry)', res.race.retry.every((x) => x === 'fulfilled') && res.race.ids.join() === 'p1,p2', res.race);
    check('an older open connection that closes on versionchange does not block the heal', res.oldTab.n === 1, res.oldTab);
    check('graph: existing Item (with your Done) kept; links/rules/actions/log created', res.graph.kept === 'keep me/done' && JSON.stringify(res.graph.info.stores) === JSON.stringify(['actions', 'items', 'links', 'log', 'rules']) && res.graph.rules === 1, res.graph);
    check('no page errors', errs.length === 0, errs);
    console.log('race first attempt:', JSON.stringify(res.race.first));
  } finally { await browser.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); if (!ok) fail++; });
  console.log(`IndexedDB migration: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; srv.close(); });
