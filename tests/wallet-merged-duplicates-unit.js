/** v112 (found in real data): passes saved from email that are merged into their booking may still have an older
 *  standalone `wallet:<id>` Item, left as device data ('local'): a duplicate in Wallet, and visible / exported for other
 *  logins. Synthetic data only.
 *  Checks: duplicate without user state removed (only its own wallet source; the booking untouched) · duplicate with user
 *  state kept whole and moved to the pass's account · owner not proven → nothing changes, pass stays unassigned ·
 *  booking of another account / missing booking → nothing changes · scanned / typed passes never touched · idempotent ·
 *  other logins never see or export the duplicate.
 * Run: node tests/wallet-merged-duplicates-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const mkLS = () => ({ d: {}, get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i]; }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } });
global.localStorage = mkLS();
const ROOT = path.resolve(__dirname, '..');
['graph/item-graph.js', 'connectors/local-connector.js', 'privacy/account-inventory.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis, IG = W.DaylightItemGraph, INV = W.DaylightAccountInventory;
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 600))); };
const NOW = Date.UTC(2026, 10, 6, 10);
const iid = (k) => IG.itemId(k);
const email = (acct, mid, extra) => Object.assign({ key: `gmail:${acct}:${mid}`, accountId: acct, type: 'email', title: 'mail ' + mid, sources: [{ app: 'gmail', accountId: acct, itemId: mid, role: 'primary' }] }, extra || {});
const booking = (acct, ref, mid) => ({ key: `booking:${acct}:${ref}`, accountId: acct, type: 'booking', title: 'BOOKING-' + ref, dueAt: NOW + 5 * 86400000, sources: [{ app: 'gmail', accountId: acct, itemId: mid, role: 'evidence' }] });

async function scenario() {
  const ls = mkLS(); const graph = IG.createGraph({ backend: 'memory', now: () => NOW });
  ls.setItem('daylight-gmail-accounts', JSON.stringify(['gA', 'gB']));
  // A's emails and bookings (the email → booking link is what the Gmail connector makes)
  await graph.upsertMany([email('gA', 'm1'), email('gA', 'm2'), email('gA', 'm3'), email('gB', 'b1'), booking('gA', 'R1', 'm1'), booking('gA', 'R2', 'm2'), booking('gB', 'RB', 'b1')]);
  await graph.linkMany([[iid('gmail:gA:m1'), iid('booking:gA:R1'), 'evidence'], [iid('gmail:gA:m2'), iid('booking:gA:R2'), 'evidence'], [iid('gmail:gB:b1'), iid('booking:gB:RB'), 'evidence']], 'gA');
  const passes = [
    { id: 'mail:m1', mailId: 'm1', kind: 'tickets', title: 'DUP-PLAIN', ownerAccount: 'gA' },          // merged; standalone has no user state
    { id: 'mail:m2', mailId: 'm2', kind: 'tickets', title: 'DUP-TOUCHED', ownerAccount: 'gA' },        // merged; standalone has user state
    { id: 'mail:m3', mailId: 'm3', kind: 'tickets', title: 'NO-BOOKING', ownerAccount: 'gA' },         // no booking → stays standalone (owned)
    { id: 'mail:zz', mailId: 'zz', kind: 'tickets', title: 'UNPROVEN' },                              // owner not proven
    { id: 'w1', kind: 'tickets', title: 'SCANNED', scanSource: true }, { id: 'v2_t', kind: 'documents', title: 'TYPED' }
  ];
  ls.setItem('daylight-wallet', JSON.stringify(passes));
  // the older standalone Items, as an earlier release left them: 'local'
  const old = (p) => ({ key: `wallet:${p.id}`, accountId: 'local', type: 'ticket', title: p.title, sources: [{ app: 'wallet', accountId: 'local', itemId: p.id, role: 'primary' }], meta: { origin: 'wallet', mailId: p.mailId || null } });
  await graph.upsertMany(passes.slice(0, 4).map(old));
  // the user acted on DUP-TOUCHED's standalone Item: pinned, a note, done, an action entry and a task planned about it
  const t = await graph.getItem(iid('wallet:mail:m2'));
  Object.assign(t, { pinned: true, status: 'done', notes: [{ text: 'gate 4', at: NOW }], actionHistory: [{ id: 'act_x', kind: 'done', at: NOW }] }); await graph.putItem(t);
  await graph.actions.put({ id: 'act_x', itemId: t.id, accountId: 'local', kind: 'done', at: NOW });
  const task = await graph.upsertItem({ key: 'task:v2:p1', accountId: 'local', type: 'task', title: 'Pack', sources: [{ app: 'daylight', accountId: 'local', itemId: 'p1' }], meta: { origin: 'v2' } });
  await graph.link(task.id, t.id, 'about', 'local');
  const local = W.DaylightLocalConnector.createLocalConnector({ graph, localStorage: ls, now: () => NOW, mailKey: (m, a) => 'gmail:' + a + ':' + m, gmailAccounts: () => ['gA', 'gB'] });
  return { ls, graph, local, passes };
}

(async () => {
  const { ls, graph, local, passes } = await scenario();
  const before = JSON.stringify(JSON.parse(ls.getItem('daylight-wallet')));
  const bookingsBefore = JSON.stringify((await graph.query({ type: 'booking' })).map((b) => [b.key, b.accountId, b.title, b.status, b.pinned || false]));
  await local.importLocal();
  const all = await graph.query(); const get = (k) => all.find((x) => x.key === k);
  ok('the merged pass now lives in its booking (same account)', (get('booking:gA:R1').sources || []).some((s) => s.app === 'wallet' && s.itemId === 'mail:m1') && get('booking:gA:R1').accountId === 'gA');
  ok('duplicate WITHOUT user state: its standalone Item is removed', !get('wallet:mail:m1'));
  ok('…the booking it merged into is untouched (still there, same account, its other sources kept)', !!get('booking:gA:R1') && get('booking:gA:R1').sources.some((s) => s.app === 'gmail' && s.itemId === 'm1'));
  const touched = get('wallet:mail:m2');
  ok('duplicate WITH user state: kept whole (pin, status, note, history) and moved to the pass\'s account', !!touched && touched.accountId === 'gA' && touched.pinned === true && touched.status === 'done' && touched.notes.length === 1 && touched.actionHistory.length === 1, touched && { acc: touched.accountId });
  ok('…its action entry and the task planned about it are kept', (await graph.actions.all()).some((a) => a.id === 'act_x') && (await graph.links()).some((l) => l.kind === 'about' && (l.to === touched.id || l.from === touched.id)));
  ok('a pass with no booking stays a standalone Item, owned by its account', get('wallet:mail:m3') && get('wallet:mail:m3').accountId === 'gA');
  ok('owner not proven → the pass stays unassigned (hidden), nothing removed', get('wallet:mail:zz') && get('wallet:mail:zz').accountId === 'unassigned-mail');
  ok('scanned and typed passes are never touched', get('wallet:w1').accountId === 'local' && get('wallet:v2_t').accountId === 'local' && !get('wallet:w1').meta.mergedInto);
  ok('no booking was modified or deleted (titles, accounts, status, pins)', JSON.stringify((await graph.query({ type: 'booking' })).map((b) => [b.key, b.accountId, b.title, b.status, b.pinned || false])) === bookingsBefore);
  ok('stored pass records are unchanged', JSON.stringify(JSON.parse(ls.getItem('daylight-wallet'))) === before);
  ok('no dangling links to a removed standalone Item', !(await graph.links()).some((l) => l.from === iid('wallet:mail:m1') || l.to === iid('wallet:mail:m1')));
  // other login B: sees and exports none of A's passes
  const vB = all.filter((x) => x.accountId === 'local' || x.accountId === 'gB');
  const exB = JSON.stringify(INV.filterExport({ items: all, links: await graph.links() }, ['gB']));
  ok('another login (B) sees none of A\'s Wallet entries and its export holds none', !vB.some((x) => /DUP-|NO-BOOKING|UNPROVEN/.test(x.title)) && !/DUP-PLAIN|DUP-TOUCHED|NO-BOOKING|UNPROVEN|BOOKING-R[12]/.test(exB), { vis: vB.map((x) => x.title), ex: exB.match(/DUP-PLAIN|DUP-TOUCHED|NO-BOOKING|UNPROVEN|BOOKING-R[12]/g) });
  // idempotent: a second and third import change nothing
  const snap = JSON.stringify((await graph.query()).map((x) => [x.key, x.accountId, x.status || null, x.pinned || false]).sort());
  await local.importLocal(); await local.importLocal();
  ok('idempotent: further imports change nothing', JSON.stringify((await graph.query()).map((x) => [x.key, x.accountId, x.status || null, x.pinned || false]).sort()) === snap);

  // a booking that belongs to ANOTHER account, or is missing → no merge, no removal
  {
    const ls2 = mkLS(); const g2 = IG.createGraph({ backend: 'memory', now: () => NOW });
    await g2.upsertMany([email('gA', 'x1'), booking('gB', 'RX', 'x1'), { key: 'wallet:mail:x1', accountId: 'local', type: 'ticket', title: 'CROSS', sources: [{ app: 'wallet', accountId: 'local', itemId: 'mail:x1', role: 'primary' }], meta: { origin: 'wallet' } }]);
    await g2.linkMany([[iid('gmail:gA:x1'), iid('booking:gB:RX'), 'evidence']], 'gA');
    ls2.setItem('daylight-wallet', JSON.stringify([{ id: 'mail:x1', mailId: 'x1', kind: 'tickets', title: 'CROSS', ownerAccount: 'gA' }]));
    const l2 = W.DaylightLocalConnector.createLocalConnector({ graph: g2, localStorage: ls2, now: () => NOW, mailKey: (m, a) => 'gmail:' + a + ':' + m, gmailAccounts: () => ['gA', 'gB'] });
    await l2.importLocal();
    const it = (await g2.query()).find((x) => x.key === 'wallet:mail:x1'), b = (await g2.query()).find((x) => x.key === 'booking:gB:RX');
    ok('booking of another account: no merge, the pass keeps its own Item (owned by its account), the booking is untouched', !!it && it.accountId === 'gA' && !it.meta.mergedInto && !(b.sources || []).some((s) => s.app === 'wallet'));
  }
  console.log(`Wallet merged duplicates unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
