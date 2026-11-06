/** Account inventory (privacy/account-inventory.js): classification, 30-day retention with warning, keep, reconnect,
 *  tombstones. Synthetic data. Run: node tests/account-inventory-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const mkLS = () => ({ d: {}, get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i]; }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } });
const ROOT = path.resolve(__dirname, '..');
const IG = require(path.join(ROOT, 'graph/item-graph.js'));
const MC = require(path.join(ROOT, 'gmail-cache.js'));
const INV = require(path.join(ROOT, 'privacy/account-inventory.js'));
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); };
const DAY = 86400000, T0 = Date.UTC(2026, 10, 6, 10);
(async () => {
  let clock = T0; const ls = mkLS();
  const graph = IG.createGraph({ backend: 'memory', now: () => clock }), cache = MC.createMailCache({});
  const item = (acct, app, id, type) => ({ key: `${app}:${acct}:${id}`, accountId: acct, type: type || 'email', title: id, sources: [{ app, accountId: acct, itemId: id, role: 'primary' }] });
  await graph.upsertMany([item('gA', 'gmail', 'a1'), item('gA', 'gmail', 'a2'), item('gB', 'gmail', 'b1'), item('ms-1', 'outlook', 'm1'), item('ms-2', 'outlook', 'm2'), item('ms-3', 'outlook', 'm3'), item('ms-3', 'onedrive', 'f3', 'file'), { key: 'task:1', accountId: 'local', type: 'task', title: 't', sources: [{ app: 'daylight', accountId: 'local', itemId: 't' }] }]);
  await cache.putMany('ms-3', [{ messageId: 'm3' }]); await cache.putMany('ms-4', [{ messageId: 'x' }]); // ms-4: mail cache rows only (no Items)
  ls.setItem('daylight-ms-link:gA', JSON.stringify({ account: 'ms-1', email: 'a@outlook.com' }));
  ls.setItem('daylight-ms-link:gB', JSON.stringify({ account: 'ms-2', email: 'b@outlook.com' }));
  ls.setItem('daylight-v2-account-names', JSON.stringify({ gA: 'a@gmail.com', gB: 'b@gmail.com' }));
  ls.setItem('daylight-device-accounts', JSON.stringify({ 'ms-gone': { provider: 'microsoft', deletedAt: T0 - DAY } }));
  const inv = INV.createInventory({ ls, graph, mailCache: cache, now: () => clock });
  let rows = await inv.scan('gA'); const by = (k) => rows.find((r) => r.key === k);
  ok('signed-in Gmail and its Microsoft account are active', by('gA').status === 'active' && by('ms-1').status === 'active' && by('ms-1').email === 'a@outlook.com');
  ok('another Google login and the Microsoft account it links are "other-login" (hidden, kept)', by('gB').status === 'other-login' && by('ms-2').status === 'other-login');
  ok('a Microsoft account no login links is an orphan (Items + mail cache)', by('ms-3').status === 'orphan' && by('ms-3').items === 2 && by('ms-3').files === 1 && by('ms-3').mailCache);
  ok('mail-cache-only data is found too (ms-4, no Items)', by('ms-4') && by('ms-4').status === 'orphan' && by('ms-4').items === 0 && by('ms-4').mailCache);
  ok('a deleted account with no data left is not listed; "local" is never an account', !by('ms-gone') && !by('local'));
  ok('the scan changes no data (Items and cache rows untouched)', (await graph.query({})).length === 8 && (await cache.all('ms-3')).length === 1);
  // retention timeline for ms-3
  const at = async (d) => { clock = T0 + d * DAY; rows = await inv.scan('gA'); return rows.find((r) => r.key === 'ms-3'); };
  let r = await at(0);
  ok('day 0: orphaned now, no warning, not deletable', r.orphanedAt === T0 && !r.warn && !r.deletable);
  r = await at(22.9); ok('day 22.9: still no warning', !r.warn);
  r = await at(23.1); ok('day 23: warning due, not deletable before it is shown', r.warn && !r.deletable);
  r = await at(35); ok('day 35 without the warning ever shown: still not deletable', !r.deletable, r);
  clock = T0 + 35 * DAY; inv.markWarned(['ms-3']); r = await at(35);
  ok('warning shown on day 35 → deletion on day 42 (7 days notice), not before', !r.deletable && r.deleteAt === T0 + 42 * DAY, r);
  r = await at(41.9); ok('day 41.9: not yet', !r.deletable);
  r = await at(42.1); ok('day 42.1: deletable', r.deletable);
  // normal path: warned at day 23 → delete at day 30
  inv.keep('ms-3'); const k0 = clock; r = (await inv.scan('gA')).find((x) => x.key === 'ms-3');
  ok('"Keep 30 more days" restarts the period and the warning', r.orphanedAt === k0 && !r.warn && !r.warnedAt);
  clock = k0 + 23 * DAY; inv.markWarned(['ms-3']); r = await at((k0 - T0) / DAY + 29.9); ok('warned on day 23 (the first day it is due) → day 29.9 not deletable', !r.deletable);
  r = await at((k0 - T0) / DAY + 30.1); ok('… day 30.1 deletable', r.deletable);
  // reconnect restores
  ls.setItem('daylight-ms-link:gA', JSON.stringify({ account: 'ms-3', email: 'c@outlook.com' }));
  const c = inv.connected('ms-3', { provider: 'microsoft', email: 'c@outlook.com', owner: 'gA' });
  rows = await inv.scan('gA');
  ok('reconnecting the same account ends the orphan state; its data is all still there', by('ms-3').status === 'active' && c.wasOrphan && by('ms-3').items === 2 && !inv.read()['ms-3'].orphanedAt);
  ok('…and the replaced account (ms-1) is now the orphan', by('ms-1').status === 'orphan');
  // replace bookkeeping
  inv.markOrphan('ms-1', 'replaced', { owner: 'gA', email: 'a@outlook.com' });
  ok('orphansOf(owner) lists the replaced account for the delete prompt', JSON.stringify(inv.orphansOf('gA', 'ms-3')) === JSON.stringify([{ key: 'ms-1', email: 'a@outlook.com' }]), inv.orphansOf('gA', 'ms-3'));
  // tombstones
  inv.markDeleted('ms-4'); ok('a deleted account is tombstoned (syncs in flight must discard)', inv.isDeleted('ms-4'));
  clock += 1000; inv.connected('ms-4', { provider: 'microsoft', email: 'd@outlook.com', owner: 'gA' });
  ok('deliberately reconnecting clears the tombstone', !inv.isDeleted('ms-4'));
  // other logins are never orphans / never auto-deletable
  clock = T0 + 400 * DAY; rows = await inv.scan('gA');
  ok('other-login accounts are never auto-deletable, even after 400 days', by('gB').status === 'other-login' && !by('gB').deletable && by('ms-2').status === 'other-login' && !by('ms-2').deletable);
  rows = await inv.scan('gB');
  ok('the same device seen by login gB: gB + ms-2 active, gA + ms-3 other-login', by('gB').status === 'active' && by('ms-2').status === 'active' && by('gA').status === 'other-login' && by('ms-3').status === 'other-login');
  ok('no scan ever touched Items, cache rows or local tasks', (await graph.query({})).length === 8 && (await cache.all('ms-4')).length === 1);
  console.log(`Account inventory unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
