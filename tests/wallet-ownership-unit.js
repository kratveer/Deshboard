/** v112 pre-release fixes (synthetic data only):
 *  W   Wallet ownership — a pass Daylight saved from an email belongs to that email's Gmail account, not to the device:
 *      hidden and not exported for other logins, removed when that account is deleted or disconnected (even if its mail
 *      cache no longer holds the message), visible again when that account signs back in. Passes the user scanned or
 *      typed stay device data. Unresolvable mail-derived passes are held back (not shown, not exported).
 *  P   Privacy Centre counts — only what the signed-in login can see, plus two hidden totals (no details)
 *      Ownership needs evidence: no fallback to "the only Gmail account on this device"; only the user can assign an
 *      unproven pass (release gate: A deleted, its email gone, B the only account → never B's automatically).
 *  I   Action / processing-log ids — no collisions across reloads or tabs with the same clock; existing ids kept
 * Run: node tests/wallet-ownership-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const mkLS = () => ({ d: {}, get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i]; }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } });
global.localStorage = mkLS();
const ROOT = path.resolve(__dirname, '..');
['graph/item-graph.js', 'gmail-config.js', 'gmail-cache.js', 'connectors/local-connector.js', 'privacy/data-reset.js', 'privacy/account-inventory.js', 'privacy/processing-log.js', 'actions/apply-action.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis, IG = W.DaylightItemGraph, INV = W.DaylightAccountInventory, DR = W.DaylightDataReset, MC = W.DaylightMailCache;
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 600))); };
const NOW = Date.UTC(2026, 10, 6, 10);
const email = (acct, mid, title) => ({ key: `gmail:${acct}:${mid}`, accountId: acct, type: 'email', title, sources: [{ app: 'gmail', accountId: acct, itemId: mid, role: 'primary' }] });
const view = (all, login, linked) => all.filter((x) => x.accountId === 'local' || (login && x.accountId === login) || (login && (linked || []).includes(x.accountId)));
const wl = (ls) => JSON.parse(ls.getItem('daylight-wallet') || '[]');
const byTitle = (items, t) => items.find((x) => x.title === t);

(async () => {
  // ---------------- Wallet ownership ----------------
  const ls = mkLS(); global.localStorage = ls; W.localStorage = ls;
  const graph = IG.createGraph({ backend: 'memory', now: () => NOW });
  W.DaylightGraph = graph;
  await graph.upsertMany([email('gA', 'm1', 'Your train ticket A'), email('gB', 'm2', 'Your concert ticket B'), email('gB', 'm3', 'Hotel booking B')]);
  ls.setItem('daylight-gmail-accounts', JSON.stringify(['gA', 'gB']));
  ls.setItem('daylight-v2-account-names', JSON.stringify({ gA: 'a@example.test', gB: 'b@example.test' }));
  const passes = [
    { id: 'mail:m1', kind: 'tickets', title: 'TRAIN-A-MARK', travelAt: '2026-11-20T08:00:00Z' },                       // older-release style id
    { id: 'p2', kind: 'tickets', title: 'CONCERT-B-MARK', mailId: 'm2', source: 'gmail', reference: 'REF-B' },          // mailId + source
    { id: 'p3', kind: 'tickets', title: 'HOTEL-B-MARK', mailId: 'm3' },
    { id: 'mail:m9', kind: 'tickets', title: 'UNKNOWN-MARK' },                                                          // its email is in no account's data
    { id: 'w1730000000000', kind: 'tickets', title: 'SCANNED-MARK', scanSource: true, qrPayload: 'X', qrAuthentic: true }, // scanned by the user
    { id: 'v2_abc', kind: 'documents', title: 'TYPED-MARK', expires: '2030-01-01T00:00:00Z' }                           // typed by the user
  ];
  ls.setItem('daylight-wallet', JSON.stringify(passes));
  const before = JSON.parse(JSON.stringify(passes));
  let login = 'gA';
  const local = W.DaylightLocalConnector.createLocalConnector({ graph, localStorage: ls, now: () => NOW, mailKey: (mid, acct) => 'gmail:' + (acct || login) + ':' + mid, gmailAccounts: () => JSON.parse(ls.getItem('daylight-gmail-accounts') || '[]') });
  W.DaylightV2 = { local };
  await local.importLocal();
  let all = await graph.query();
  ok('W: mail-derived passes get the Gmail account their email came from', byTitle(all, 'TRAIN-A-MARK').accountId === 'gA' && byTitle(all, 'CONCERT-B-MARK').accountId === 'gB' && byTitle(all, 'HOTEL-B-MARK').accountId === 'gB', all.filter((x) => /MARK/.test(x.title)).map((x) => [x.title, x.accountId]));
  ok('W: passes you scanned or typed stay device data (local)', byTitle(all, 'SCANNED-MARK').accountId === 'local' && byTitle(all, 'TYPED-MARK').accountId === 'local');
  ok('W: a mail-derived pass whose account cannot be resolved is held back (unassigned, not local)', byTitle(all, 'UNKNOWN-MARK').accountId === 'unassigned-mail');
  const after = wl(ls);
  ok('W: stored passes only gain ownerAccount; nothing else changes, user passes untouched', after.length === before.length && after.every((p, i) => { const c = Object.assign({}, p); delete c.ownerAccount; return JSON.stringify(c) === JSON.stringify(before[i]); }) && after[0].ownerAccount === 'gA' && after[1].ownerAccount === 'gB' && !after[3].ownerAccount && !after[4].ownerAccount && !after[5].ownerAccount, after);
  let v = view(all, 'gA');
  ok('W: signed in as A → A\'s pass + own passes; never B\'s or unassigned', !!byTitle(v, 'TRAIN-A-MARK') && !!byTitle(v, 'SCANNED-MARK') && !!byTitle(v, 'TYPED-MARK') && !byTitle(v, 'CONCERT-B-MARK') && !byTitle(v, 'HOTEL-B-MARK') && !byTitle(v, 'UNKNOWN-MARK'));
  // export (Privacy Centre → Export) as A
  const raw = { items: all, links: await graph.links(), rules: [], actions: [], log: [] };
  const exA = JSON.stringify(INV.filterExport(raw, ['gA']));
  ok('W/export: A\'s export has A\'s pass and own passes, nothing from B or unassigned', /TRAIN-A-MARK/.test(exA) && /SCANNED-MARK/.test(exA) && /TYPED-MARK/.test(exA) && !/CONCERT-B-MARK|HOTEL-B-MARK|REF-B|UNKNOWN-MARK|"gB"|unassigned-mail/.test(exA), exA.match(/CONCERT-B-MARK|HOTEL-B-MARK|REF-B|UNKNOWN-MARK|"gB"|unassigned-mail/g));
  // a later import (e.g. after A's next sync) with B signed out keeps B's pass with B — no re-guess from the current login
  await local.importLocal(); all = await graph.query();
  ok('W: re-import keeps owners (idempotent)', byTitle(all, 'CONCERT-B-MARK').accountId === 'gB' && byTitle(all, 'TRAIN-A-MARK').accountId === 'gA' && all.filter((x) => /MARK/.test(x.title)).length === 6);
  // reconnect: B signs in again → its pass is visible again (and still hidden from A)
  login = 'gB'; await local.importLocal(); all = await graph.query(); v = view(all, 'gB');
  ok('W/reconnect: B signing in again sees its passes again; A\'s pass is hidden from B', !!byTitle(v, 'CONCERT-B-MARK') && !!byTitle(v, 'HOTEL-B-MARK') && !byTitle(v, 'TRAIN-A-MARK') && !!byTitle(v, 'SCANNED-MARK'));
  // inventory: unassigned is not an "account"
  const inv = INV.createInventory({ ls, graph, now: () => NOW });
  const rows = await inv.scan('gA');
  ok('W: the hold-back bucket is not listed as an account in the inventory', !rows.some((r) => r.key === 'unassigned-mail') && rows.some((r) => r.key === 'gB' && r.status === 'other-login'));
  // deletion of B while A is signed in, with B's mail cache NOT holding m2/m3 any more (evicted): ownership still decides
  login = 'gA';
  const mc = MC.createMailCache({});
  const rep = await DR.deleteGmailData({ accountId: 'gB', active: false, mailCache: mc });
  all = await graph.query();
  ok('W/delete: deleting B removes B\'s passes even though its mail cache no longer has those messages', rep.walletPasses === 2 && !wl(ls).some((p) => /B-MARK/.test(p.title)) && !byTitle(all, 'CONCERT-B-MARK') && !byTitle(all, 'HOTEL-B-MARK'), { rep: rep.walletPasses, left: wl(ls).map((p) => p.title) });
  ok('W/delete: A\'s pass, your own passes and the unassigned one are kept', ['TRAIN-A-MARK', 'SCANNED-MARK', 'TYPED-MARK', 'UNKNOWN-MARK'].every((t) => wl(ls).some((p) => p.title === t) && byTitle(all, t)));
  // disconnect A (the last account) → A's pass and the unassigned mail-derived pass go; user passes stay
  const rep2 = await DR.deleteGmailData({ accountId: 'gA', active: true, mailCache: mc });
  all = await graph.query();
  ok('W/disconnect: disconnecting the last account removes every mail-derived pass, keeps scanned/typed passes', rep2.walletPasses === 2 && wl(ls).map((p) => p.title).sort().join() === 'SCANNED-MARK,TYPED-MARK' && !byTitle(all, 'TRAIN-A-MARK') && !byTitle(all, 'UNKNOWN-MARK') && !!byTitle(all, 'SCANNED-MARK'), { rep2: rep2.walletPasses, left: wl(ls).map((p) => p.title) });

  // the v112 release-gate scenario: the pass came from Gmail A; A was deleted while B existed and A's email was not in the
  // cache (so the pass survived unstamped); now B is the ONLY known Gmail account → the pass must NOT become B's
  {
    const ls2 = mkLS(); const g2 = IG.createGraph({ backend: 'memory', now: () => NOW }); W.DaylightGraph = g2;
    ls2.setItem('daylight-gmail-accounts', JSON.stringify(['gA', 'gB']));
    ls2.setItem('daylight-v2-account-names', JSON.stringify({ gA: 'a@example.test', gB: 'b@example.test' }));
    ls2.setItem('daylight-wallet', JSON.stringify([{ id: 'mail:oldA', kind: 'tickets', title: 'OLD-A-MARK', reference: 'REF-OLDA' }, { id: 'w9', kind: 'tickets', title: 'MINE-MARK', scanSource: true }]));
    await g2.upsertItem(email('gB', 'b1', 'B mail'));
    const accts = () => JSON.parse(ls2.getItem('daylight-gmail-accounts') || '[]');
    const l2 = W.DaylightLocalConnector.createLocalConnector({ graph: g2, localStorage: ls2, now: () => NOW, mailKey: (m, a) => 'gmail:' + a + ':' + m, gmailAccounts: accts });
    W.DaylightV2 = { local: l2 }; global.localStorage = ls2; W.localStorage = ls2;
    await l2.importLocal();
    await DR.deleteGmailData({ accountId: 'gA', active: false, mailCache: MC.createMailCache({}) });
    ok('W/gate: after A is deleted (its email not cached) the old pass survives, unassigned', accts().join() === 'gB' && JSON.parse(ls2.getItem('daylight-wallet')).some((p) => p.title === 'OLD-A-MARK' && !p.ownerAccount));
    await l2.importLocal(); await l2.importLocal();
    let it = (await g2.query()).find((x) => x.title === 'OLD-A-MARK');
    ok('W/gate: with B the only known Gmail account the old pass is NOT attributed to B (no evidence) — it stays unassigned', it.accountId === 'unassigned-mail' && !JSON.parse(ls2.getItem('daylight-wallet')).find((p) => p.title === 'OLD-A-MARK').ownerAccount, it.accountId);
    const vB = view(await g2.query(), 'gB'); const exB = JSON.stringify(INV.filterExport({ items: await g2.query(), links: await g2.links() }, ['gB']));
    ok('W/gate: B neither sees nor exports it; B\'s own scanned pass is unaffected', !byTitle(vB, 'OLD-A-MARK') && !/OLD-A-MARK|REF-OLDA/.test(exB) && !!byTitle(vB, 'MINE-MARK'));
    // the user explicitly assigns it (Privacy Centre) → B's from then on, recorded as the user's choice
    const n = await l2.assignUnassigned('gB');
    it = (await g2.query()).find((x) => x.title === 'OLD-A-MARK'); const rec = JSON.parse(ls2.getItem('daylight-wallet')).find((p) => p.title === 'OLD-A-MARK');
    ok('W/gate: only an explicit user assignment makes it B\'s (recorded as the user\'s choice)', n === 1 && it.accountId === 'gB' && rec.ownerAccount === 'gB' && rec.ownerAssignedBy === 'user');
    ok('W/gate: assignment never touches user-made passes or passes that already have an owner', await (async () => { const l = JSON.parse(ls2.getItem('daylight-wallet')); l.push({ id: 'mail:x', title: 'X', ownerAccount: 'gZ' }); ls2.setItem('daylight-wallet', JSON.stringify(l)); await l2.assignUnassigned('gB'); const r = JSON.parse(ls2.getItem('daylight-wallet')); return r.find((p) => p.id === 'mail:x').ownerAccount === 'gZ' && !r.find((p) => p.id === 'w9').ownerAccount; })());
    W.DaylightGraph = graph; W.DaylightV2 = { local }; global.localStorage = ls; W.localStorage = ls;
  }
  {
    const ls2 = mkLS(); const g2 = IG.createGraph({ backend: 'memory', now: () => NOW });
    // two accounts known, email in neither → held back, retried later; once the email is ingested it resolves
    ls2.setItem('daylight-gmail-accounts', JSON.stringify(['gOnly', 'gTwo']));
    ls2.setItem('daylight-wallet', JSON.stringify([{ id: 'mail:old2', kind: 'tickets', title: 'OLD2' }]));
    const l3 = W.DaylightLocalConnector.createLocalConnector({ graph: g2, localStorage: ls2, now: () => NOW, mailKey: (m, a) => 'gmail:' + a + ':' + m, gmailAccounts: () => ['gOnly', 'gTwo'] });
    await l3.importLocal();
    const o2 = (await g2.query()).find((x) => x.title === 'OLD2');
    await g2.upsertItem(email('gTwo', 'old2', 'late mail')); await l3.importLocal();
    const o2b = (await g2.query()).find((x) => x.title === 'OLD2');
    ok('W: unresolved with several accounts → held back; resolved once its email is ingested', o2.accountId === 'unassigned-mail' && o2b.accountId === 'gTwo', [o2.accountId, o2b.accountId]);
  }

  // ---------------- Privacy Centre counts ----------------
  {
    const items = [{ id: 'a', accountId: 'gA', type: 'email' }, { id: 'b', accountId: 'gA', type: 'bill' }, { id: 'l', accountId: 'local', type: 'ticket' }, { id: 'm', accountId: 'ms-1', type: 'file' },
      { id: 'x', accountId: 'gB', type: 'email' }, { id: 'y', accountId: 'gB', type: 'email' }, { id: 'o', accountId: 'ms-orph', type: 'email' }, { id: 'u', accountId: 'unassigned-mail', type: 'ticket' }];
    const links = [{ from: 'a', to: 'b' }, { from: 'a', to: 'x' }, { from: 'x', to: 'y' }];
    const st = { gB: 'other-login', 'ms-orph': 'orphan' };
    const c = INV.scopeCounts(items, links, ['gA', 'ms-1'], (a) => st[a]);
    ok('P: counts cover only this login\'s data (+ local, linked Microsoft)', JSON.stringify(c.byType) === JSON.stringify({ email: 1, bill: 1, ticket: 1, file: 1 }) && c.items === 4 && c.links === 1, c);
    ok('P: hidden data shown as two totals: other logins vs disconnected/unassigned', c.hidden.otherLogins === 2 && c.hidden.disconnected === 2, c.hidden);
    ok('P: the result holds numbers only (no account keys, emails or titles)', !/gB|ms-orph|unassigned|@/.test(JSON.stringify(c)));
  }

  // ---------------- IDs ----------------
  {
    const g = IG.createGraph({ backend: 'memory', now: () => NOW });
    const it = await g.upsertItem({ key: 'gmail:gA:z', accountId: 'gA', type: 'email', title: 'z', sources: [{ app: 'gmail', accountId: 'gA', itemId: 'z' }] });
    const legacy = { id: 'act_' + NOW.toString(36) + '_1', accountId: 'gA', itemId: it.id, kind: 'pin', payload: {}, prev: {}, at: NOW - 5, by: 'user', writeBack: [], undone: false };
    await g.actions.put(legacy);
    const load = () => { delete require.cache[require.resolve(path.join(ROOT, 'actions/apply-action.js'))]; require(path.join(ROOT, 'actions/apply-action.js')); return W.DaylightActions.createActions({ graph: g, now: () => NOW }); };
    // two "page loads" (counter reset) and two tabs, all with the same frozen clock
    const t1 = load(), t2 = load();
    const r = [await t1.applyAction(it.id, 'pin'), await t2.applyAction(it.id, 'unpin'), await load().applyAction(it.id, 'pin'), await t1.applyAction(it.id, 'unpin')];
    const acts = await g.actions.all();
    ok('I: actions — same clock across reloads/tabs never reuses an id; every entry kept', r.every((x) => x.ok) && acts.length === 5 && new Set(acts.map((a) => a.id)).size === 5, acts.map((a) => a.id));
    ok('I: an existing (older-format) action id and its entry are unchanged', JSON.stringify(acts.find((a) => a.id === legacy.id)) === JSON.stringify(legacy));
    const L = W.DaylightProcessingLog;
    await g.log.put({ id: 'log_' + NOW.toString(36) + '_1', at: NOW - 9, kind: 'ai', what: 'old' });
    const la = L.createLog({ graph: g, now: () => NOW }), lb = L.createLog({ graph: g, now: () => NOW });
    for (let i = 0; i < 3; i++) { await la.add({ kind: 'ai', what: 'a' + i }); await lb.add({ kind: 'ai', what: 'b' + i }); }
    const lg = await g.log.all();
    ok('I: processing log — two instances with the same clock: 6 new entries, no overwrite, old entry kept', lg.length === 7 && new Set(lg.map((e) => e.id)).size === 7 && lg.some((e) => e.what === 'old'), lg.map((e) => e.id));
  }

  console.log(`Wallet ownership / counts / ids unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
