/** v112 release gate: Wallet imports running at the same time in two tabs (synthetic data).
 *  Two local connectors (= two tabs) share one localStorage and one Item graph. Tab 1's import is frozen at its riskiest
 *  points (after reading the passes, and right before writing Items) while tab 2 adds a pass, deletes an account or
 *  assigns a pass; then tab 1 finishes. Web Locks are NOT available here, so this checks the worst case: the fresh
 *  re-reads alone must keep the result right.
 *  Checks: a pass added in the other tab is never lost · passes of a deleted account are never restored · a recorded owner
 *  is never overwritten or moved to another account · stored pass records are never lost or rewritten · random interleaving.
 * Run: node tests/wallet-concurrency-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const mkLS = () => ({ d: {}, get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i]; }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } });
const ROOT = path.resolve(__dirname, '..');
global.localStorage = mkLS();
['graph/item-graph.js', 'gmail-config.js', 'gmail-cache.js', 'connectors/local-connector.js', 'privacy/data-reset.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis, IG = W.DaylightItemGraph, DR = W.DaylightDataReset, MC = W.DaylightMailCache;
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 600))); };
const NOW = Date.UTC(2026, 10, 6, 10);
const email = (acct, mid) => ({ key: `gmail:${acct}:${mid}`, accountId: acct, type: 'email', title: 'mail ' + mid, sources: [{ app: 'gmail', accountId: acct, itemId: mid, role: 'primary' }] });
const wl = (ls) => JSON.parse(ls.getItem('daylight-wallet') || '[]');
const tick = () => new Promise((r) => setTimeout(r, 0));

/** a "tab": its own connector over the shared graph, with a gate that can freeze it inside getMany / upsertMany */
function tab(graph, ls) {
  const gate = { on: null, hit: null, release: null };
  const pause = async (name) => { if (gate.on === name) { gate.on = null; await new Promise((r) => { gate.release = r; if (gate.hit) gate.hit(); }); } };
  const g = Object.create(graph);
  g.getMany = async (ids) => { if (ids.some((x) => String(x).length)) await pause('getMany'); return graph.getMany(ids); };
  g.upsertMany = async (items) => { await pause('upsertMany'); return graph.upsertMany(items); };
  const conn = W.DaylightLocalConnector.createLocalConnector({ graph: g, localStorage: ls, now: () => NOW, mailKey: (m, a) => 'gmail:' + a + ':' + m, gmailAccounts: () => JSON.parse(ls.getItem('daylight-gmail-accounts') || '[]') });
  return { conn, freezeAt(name) { gate.on = name; return new Promise((r) => { gate.hit = r; }); }, release() { gate.release && gate.release(); } };
}
async function setup() {
  const ls = mkLS(); const graph = IG.createGraph({ backend: 'memory', now: () => NOW });
  global.localStorage = ls; W.localStorage = ls; W.DaylightGraph = graph;
  ls.setItem('daylight-gmail-accounts', JSON.stringify(['gA', 'gB']));
  await graph.upsertMany([email('gA', 'a1'), email('gB', 'b1')]);
  ls.setItem('daylight-wallet', JSON.stringify([
    { id: 'mail:a1', kind: 'tickets', title: 'A-PASS' }, { id: 'mail:b1', kind: 'tickets', title: 'B-PASS' },
    { id: 'mail:zz', kind: 'tickets', title: 'UNPROVEN' }, { id: 'w1', kind: 'tickets', title: 'MINE', scanSource: true }
  ]));
  const t1 = tab(graph, ls), t2 = tab(graph, ls);
  W.DaylightV2 = { local: t2.conn };
  return { ls, graph, t1, t2 };
}
const items = async (graph, title) => (await graph.query()).filter((x) => x.title === title);

(async () => {
  for (const at of ['getMany', 'upsertMany']) {
    // 1 — a pass added in tab 2 while tab 1 imports is not lost
    {
      const { ls, graph, t1, t2 } = await setup(); await t2.conn.importLocal();
      const frozen = t1.freezeAt(at); const p1 = t1.conn.importLocal(); await frozen;
      const l = wl(ls); l.unshift({ id: 'v2_new', kind: 'tickets', title: 'NEW' }); ls.setItem('daylight-wallet', JSON.stringify(l));
      await t2.conn.importLocal();
      t1.release(); await p1; await tick();
      ok(`[${at}] a pass added in the other tab during an import is kept (record and Item)`, wl(ls).some((p) => p.id === 'v2_new') && (await items(graph, 'NEW')).length === 1);
    }
    // 2 — an account deleted in tab 2 while tab 1 imports: its passes are not restored
    {
      const { ls, graph, t1, t2 } = await setup(); await t2.conn.importLocal();
      const frozen = t1.freezeAt(at); const p1 = t1.conn.importLocal(); await frozen;
      await DR.deleteGmailData({ accountId: 'gB', active: false, mailCache: MC.createMailCache({}) });
      t1.release(); await p1; await tick();
      ok(`[${at}] passes of an account deleted in the other tab are not restored (no record, no Item)`, !wl(ls).some((p) => p.title === 'B-PASS') && (await items(graph, 'B-PASS')).length === 0, { rec: wl(ls).map((p) => p.title), items: (await items(graph, 'B-PASS')).length });
      ok(`[${at}] …and the other passes are untouched`, ['A-PASS', 'UNPROVEN', 'MINE'].every((t) => wl(ls).some((p) => p.title === t)) && (await items(graph, 'A-PASS'))[0].accountId === 'gA' && (await items(graph, 'MINE'))[0].accountId === 'local');
    }
    // 3 — the user assigns the unproven pass in tab 2 while tab 1 imports: tab 1 does not undo it or move it
    {
      const { ls, graph, t1, t2 } = await setup(); await t2.conn.importLocal();
      const frozen = t1.freezeAt(at); const p1 = t1.conn.importLocal(); await frozen;
      await t2.conn.assignUnassigned('gA');
      t1.release(); await p1; await tick();
      const it = (await items(graph, 'UNPROVEN'))[0]; const rec = wl(ls).find((p) => p.title === 'UNPROVEN');
      ok(`[${at}] an owner recorded in the other tab is kept (record and Item), not reverted to unassigned`, rec.ownerAccount === 'gA' && rec.ownerAssignedBy === 'user' && it.accountId === 'gA', { rec, acc: it && it.accountId });
      ok(`[${at}] owners are never moved: A's pass stays A's, B's stays B's`, (await items(graph, 'A-PASS'))[0].accountId === 'gA' && (await items(graph, 'B-PASS'))[0].accountId === 'gB' && wl(ls).find((p) => p.title === 'B-PASS').ownerAccount === 'gB');
    }
  }
  // 4 — both tabs stamp owners at the same moment (first import after the update)
  {
    const { ls, graph, t1, t2 } = await setup();
    const before = wl(ls);
    await Promise.all([t1.conn.importLocal(), t2.conn.importLocal()]);
    const after = wl(ls);
    ok('two tabs importing at once: same records, only ownerAccount added, owners from evidence only', after.length === before.length && after.every((p, i) => { const c = Object.assign({}, p); delete c.ownerAccount; return JSON.stringify(c) === JSON.stringify(before[i]); }) && after[0].ownerAccount === 'gA' && after[1].ownerAccount === 'gB' && !after[2].ownerAccount && !after[3].ownerAccount, after);
    ok('…one Item per pass, in the right bucket', (await graph.query()).filter((x) => x.meta && x.meta.origin === 'wallet').map((x) => x.title + ':' + x.accountId).sort().join() === 'A-PASS:gA,B-PASS:gB,MINE:local,UNPROVEN:unassigned-mail');
  }
  // 5 — random interleaving: 40 rounds of two imports + one change each (add / delete record / assign)
  {
    const { ls, graph, t1, t2 } = await setup();
    let seed = 7; const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    let bad = null;
    for (let r = 0; r < 40 && !bad; r++) {
      const op = Math.floor(rnd() * 3);
      const jobs = [t1.conn.importLocal(), (async () => { for (let i = 0; i < Math.floor(rnd() * 4); i++) await tick();
        const l = wl(ls);
        if (op === 0) { l.push({ id: 'v2_r' + r, kind: 'tickets', title: 'R' + r }); ls.setItem('daylight-wallet', JSON.stringify(l)); }
        else if (op === 1) { const i = l.findIndex((p) => /^R\d+$/.test(p.title)); if (i >= 0) { l.splice(i, 1); ls.setItem('daylight-wallet', JSON.stringify(l)); } }
        else await t2.conn.assignUnassigned('gA');
        return t2.conn.importLocal(); })()];
      await Promise.all(jobs); await t1.conn.importLocal();
      const recs = wl(ls); const wal = (await graph.query()).filter((x) => x.meta && x.meta.origin === 'wallet');
      const ids = new Set(recs.map((p) => 'wallet:' + p.id)); const keys = new Set(wal.map((x) => x.key));
      const mism = [...ids].filter((k) => !keys.has(k)).concat([...keys].filter((k) => !ids.has(k)));
      const wrong = wal.filter((x) => { const p = recs.find((q) => 'wallet:' + q.id === x.key); return p && x.accountId !== (p.ownerAccount || (/^mail:/.test(p.id) ? 'unassigned-mail' : 'local')); });
      if (mism.length || wrong.length || recs.find((p) => p.title === 'B-PASS').ownerAccount !== 'gB') bad = { r, mism, wrong: wrong.map((x) => x.title + ':' + x.accountId) };
    }
    ok('random interleaving (40 rounds): records and Items always match, every Item in its owner\'s bucket, owners never change', !bad, bad);
  }
  console.log(`Wallet concurrency unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
