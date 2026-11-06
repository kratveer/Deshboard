/** Today home refinements (sample data, nothing real): the Brief is one sentence whose phrases link to their section,
 *  the Needs you count is a pill, and a money card shows the merchant left and the amount right on one row, its email
 *  subject on its own line without breaking a reference, with status and action visible. Light + dark, phone + desktop.
 *  Run: node tests/today-brief-e2e.js */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const dir = path.resolve(__dirname, '..');
const T = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff' };
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const ANTH = () => { const U = window.DaylightV2UI, S = U.state, now = Date.now(); const it = { id: 'anth-x', key: 'money:x:anthropic.com:10', type: 'bill', status: 'open', title: 'Anthropic, PBC · 10 USD', description: 'Your receipt from Anthropic, PBC #2615-9581-3414', createdAt: now - 3 * 86400000, dueAt: null, priority: 80, sources: [{ app: 'gmail', itemId: 'm1', url: 'https://mail.google.com/mail/u/0/#all/t1', role: 'evidence' }], extractedFacts: [{ key: 'amount', value: 10 }, { key: 'currency', value: 'USD' }, { key: 'merchant', value: 'Anthropic, PBC' }], meta: { category: 'bill' }, relatedItemIds: [] }; S.items = S.items.filter((x) => x.type !== 'bill'); S.items.push(it); S.byId.set(it.id, it); U.render(); };
const srv = http.createServer((q, r) => { const u = new URL(q.url, 'http://x'); let f = path.join(dir, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) f += 'index.html'; if (!f.startsWith(dir) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
srv.listen(8796, async () => {
  const b = await chromium.launch();
  try {
    for (const [w, scheme] of [[390, 'light'], [390, 'dark'], [340, 'dark'], [1280, 'light']]) {
      const ctx = await b.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, serviceWorkers: 'block' }); const p = await ctx.newPage(); const errs = [];
      p.on('pageerror', (e) => errs.push(e.message)); await p.route(/^https:\/\//, (r) => r.abort());
      await p.goto('http://127.0.0.1:8796/index.html?v2sample=1'); await p.waitForSelector('#v2 .v-tabs'); await p.waitForTimeout(1000);
      await p.evaluate(ANTH); await p.waitForTimeout(400);
      const L = `${w}px ${scheme}`;
      const r = await p.evaluate(() => {
        const brief = document.querySelector('.v-brief'), links = [...brief.querySelectorAll('[data-brief]')];
        const pill = document.querySelector('.v-h2[data-sec="needs"] .n.pill'), ps = pill && getComputedStyle(pill);
        const card = document.querySelector('.v-mcard'), box = (s) => { const e = card.querySelector(s); return e ? e.getBoundingClientRect() : null; };
        const t = box('.v-title'), a = box('.v-amount'), c = card.getBoundingClientRect(), btn = box('.v-pbtn'), why = card.querySelector('.v-why');
        const ref = card.querySelector('.v-desc .nw'), rr = ref && ref.getClientRects();
        return { text: brief.textContent.trim(), links: links.map((x) => x.textContent), linkLines: links.map((x) => x.getClientRects().length), pill: pill && pill.textContent, pillBg: ps && ps.backgroundColor, pillFg: ps && ps.color, needs: document.querySelectorAll('[data-list="needs"] .v-card').length,
          sameRow: t && a && Math.abs(t.top - a.top) < 6, amountRight: a && c.right - a.right < 24, noOverlap: t && a && t.right <= a.left, why: why && why.textContent, btn: btn && btn.width > 0 && btn.bottom <= c.bottom, btnText: card.querySelector('.v-pbtn') && card.querySelector('.v-pbtn').textContent, refOneLine: rr && rr.length === 1 };
      });
      check(`${L}: Brief is one natural sentence with the counts`, /^You have .*1 bill of 10 USD to pay.*\.$/.test(r.text) && !/,\s*\d+ messages wait for you, \d+ more things/.test(r.text), r.text);
      check(`${L}: every phrase is a link containing its number`, r.links.length >= 2 && r.links.every((x) => /\d/.test(x)), r.links);
      check(`${L}: Needs you count in a coloured pill`, /^\d+$/.test(r.pill || '') && r.pillBg && r.pillBg !== 'rgba(0, 0, 0, 0)', { pill: r.pill, bg: r.pillBg, fg: r.pillFg });
      check(`${L}: bill card — merchant left and amount far right on the same row, not overlapping`, r.sameRow && r.amountRight && r.noOverlap, r);
      check(`${L}: bill card — the reference #2615-9581-3414 is not broken across lines`, r.refOneLine, r);
      check(`${L}: bill card — Unpaid status and Mark paid visible`, r.why === 'Unpaid' && r.btn && r.btnText === 'Mark paid', r);
      check(`${L}: no page errors`, errs.length === 0, errs);
      if (w === 390 && scheme === 'light') {
        const kinds = await p.evaluate(() => window.DaylightV2UI.state.briefParts.map((x) => x.kind));
        const go = async (kind) => { await p.evaluate(() => { window.DaylightV2UI.setTab('today'); document.querySelector('.v-screen[data-screen="today"]').scrollTop = 0; }); await p.waitForTimeout(300); await p.click(`.v-brief [data-brief="${kinds.indexOf(kind)}"]`); await p.waitForTimeout(800); const o = await p.evaluate(() => ({ tab: window.DaylightV2UI.state.tab, sheet: (document.querySelector('.v-sheet:last-of-type .v-h1, .v-sheet h2, .v-sheet') || {}).textContent || '', scroll: document.querySelector('.v-screen[data-screen="today"]').scrollTop, hash: location.hash })); await p.keyboard.press('Escape'); await p.waitForTimeout(300); return o; };
        const bills = await go('bills'), replies = await go('replies'), rest = await go('rest'), sched = kinds.includes('schedule') ? await go('schedule') : null;
        check('link: "1 bill …" opens that bill', /Anthropic/.test(bills.sheet) && bills.hash === '', bills.sheet.slice(0, 80));
        check('link: "… messages waiting for you" opens Inbox', replies.tab === 'inbox');
        check('link: "… other things that need you" scrolls to Needs you', rest.tab === 'today' && rest.scroll > 0, rest);
        if (sched) check('link: "… on your schedule" scrolls to Your day', sched.tab === 'today' && sched.scroll > rest.scroll, sched);
      }
      await ctx.close();
    }
  } finally { await b.close(); srv.close(); }
  let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); if (!ok) fail++; });
  console.log(`Today brief E2E: ${checks.length - fail}/${checks.length} checks passed`);
  process.exitCode = fail ? 1 : 0;
});
