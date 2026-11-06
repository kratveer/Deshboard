/** v112 fixes F2 + F3 + write guards (synthetic data):
 *  F3  provider from the account key and the ledger only — never from Item sources (Gmail-keyed Item with Outlook /
 *      OneDrive sources stays Google; it is never a Microsoft orphan)
 *  F2  export filter: only the signed-in login's accounts + local, consistently across items, links, facts, rules,
 *      actions and log; nothing stored is changed
 *  F1  write guards: the Outlook pipeline, OneDrive sync and the mail connector stop before the next write once the
 *      account changed (a delayed response is discarded)
 * Run: node tests/account-scope-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const mkLS = () => ({ d: {}, get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i]; }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } });
global.localStorage = mkLS();
const ROOT = path.resolve(__dirname, '..');
['mail-dates.js', 'gmail-rules.js', 'gmail-config.js', 'gmail-cache.js', 'gmail-pipeline.js', 'email-classify.js', 'finance-intel.js', 'graph/item-graph.js', 'classification/user-rules.js', 'classification/classifier.js', 'connectors/gmail-connector.js', 'outlook-sync.js', 'file-text.js', 'onedrive-sync.js', 'privacy/account-inventory.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis, IG = W.DaylightItemGraph, MC = W.DaylightMailCache, INV = W.DaylightAccountInventory;
const { createMockGraph } = require('./mock-graph.js');
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); };
const NOW = Date.UTC(2026, 10, 6, 10);
(async () => {
  // ---------------- F3 ----------------
  {
    const ls = mkLS(); const graph = IG.createGraph({ backend: 'memory', now: () => NOW });
    await graph.upsertMany([
      { key: 'gmail:gA:1', accountId: 'gA', type: 'email', title: 'a', sources: [{ app: 'gmail', accountId: 'gA', itemId: '1' }] },
      // anomaly: a Gmail-keyed Item with Outlook and OneDrive sources (must not change the account's provider)
      { key: 'odd:gB:1', accountId: 'gB', type: 'email', title: 'b', sources: [{ app: 'outlook', accountId: 'gB', itemId: 'x' }, { app: 'onedrive', accountId: 'gB', itemId: 'y' }] },
      { key: 'odd:gB:2', accountId: 'gB', type: 'file', title: 'f', sources: [{ app: 'onedrive', accountId: 'gB', itemId: 'z' }] },
      { key: 'outlook:ms-1:1', accountId: 'ms-1', type: 'email', title: 'm', sources: [{ app: 'outlook', accountId: 'ms-1', itemId: 'm' }] }
    ]);
    ls.setItem('daylight-v2-account-names', JSON.stringify({ gA: 'a@gmail.com', gB: 'b@gmail.com' }));
    let clock = NOW; const inv = INV.createInventory({ ls, graph, now: () => clock });
    let rows = await inv.scan('gA'); const by = (k) => rows.find((r) => r.key === k);
    ok('F3: Gmail-keyed account with Outlook/OneDrive sources stays Google and is "other-login", not a Microsoft orphan', by('gB').provider === 'google' && by('gB').status === 'other-login', by('gB'));
    ok('F3: ms- key → Microsoft (unlinked → orphan)', by('ms-1').provider === 'microsoft' && by('ms-1').status === 'orphan');
    clock = NOW + 400 * 86400000; inv.markWarned(['gB']); clock += 30 * 86400000; rows = await inv.scan('gA');
    ok('F3: …and is never deletable (other logins are never auto-deleted)', !by('gB').deletable && by('gB').status === 'other-login');
    ok('F3: the ledger is authoritative when present', INV.providerOf('weird-key', { provider: 'microsoft' }) === 'microsoft' && INV.providerOf('ms-x', { provider: 'google' }) === 'google' && INV.providerOf('123', null) === 'google' && INV.providerOf('ms-9', {}) === 'microsoft');
    ok('F3: scanning never wrote a provider guessed from sources into the ledger', (inv.read().gB || {}).provider === 'google');
  }
  // ---------------- F2 ----------------
  {
    const it = (id, acct, extra) => Object.assign({ id, key: id, accountId: acct, type: 'email', title: id.toUpperCase() + 'MARK', sources: [{ app: acct.startsWith('ms-') ? 'outlook' : acct === 'local' ? 'daylight' : 'gmail', accountId: acct, itemId: 'msg-' + id }] }, extra || {});
    const data = {
      items: [it('g1', 'gA', { relatedItemIds: ['m1', 'o1'], extractedFacts: [{ key: 'amount', value: 1, sourceItemId: 'g1' }, { key: 'x', value: 2, sourceItemId: 'o1' }] }), it('m1', 'ms-1'), it('l1', 'local'), it('o1', 'gB'), it('p1', 'ms-orphan'), it('c1', 'ms-other')],
      links: [{ id: 'k1', from: 'g1', to: 'm1', accountId: 'gA' }, { id: 'k2', from: 'g1', to: 'o1', accountId: 'gA' }, { id: 'k3', from: 'p1', to: 'c1', accountId: 'ms-orphan' }, { id: 'k4', from: 'l1', to: 'g1', accountId: null }],
      rules: [{ id: 'r1', accountId: 'gA' }, { id: 'r2', accountId: 'gB' }, { id: 'r3', accountId: null }, { id: 'r4', accountId: 'ms-orphan' }],
      actions: [{ id: 'a1', itemId: 'g1', accountId: 'gA' }, { id: 'a2', itemId: 'o1', accountId: 'gB' }, { id: 'a3', itemId: 'm1', accountId: 'ms-1' }, { id: 'a4', itemId: 'p1', accountId: 'ms-orphan' }],
      log: [{ id: 'e1', accountId: 'gA', what: 'ai' }, { id: 'e2', accountId: 'gB', what: 'ai' }, { id: 'e3', itemId: 'o1' }, { id: 'e4', itemId: 'm1' }, { id: 'e5', messageId: 'msg-g1' }, { id: 'e6', messageId: 'msg-o1' }, { id: 'e7', kind: 'delete', what: 'gmail-data for one account', detail: { others: ['gB', 'ms-orphan'] } }]
    };
    const before = JSON.stringify(data);
    const out = INV.filterExport(data, ['gA', 'ms-1']);
    const ids = (a) => a.map((x) => x.id).sort().join();
    ok('F2: items = signed-in Gmail + linked Microsoft + local only', ids(out.items) === 'g1,l1,m1', ids(out.items));
    ok('F2: links only between exported Items (and of visible accounts)', ids(out.links) === 'k1,k4', ids(out.links));
    ok('F2: related ids and facts pointing at hidden Items are dropped from the copy', JSON.stringify(out.items.find((x) => x.id === 'g1').relatedItemIds) === '["m1"]' && out.items.find((x) => x.id === 'g1').extractedFacts.length === 1);
    ok('F2: rules of visible accounts + global rules only', ids(out.rules) === 'r1,r3', ids(out.rules));
    ok('F2: actions of exported Items only', ids(out.actions) === 'a1,a3', ids(out.actions));
    ok('F2: log: visible accounts, exported Items, their messages; device-level entries without details', ids(out.log) === 'e1,e4,e5,e7' && out.log.find((x) => x.id === 'e7').detail === null, out.log);
    ok('F2: no hidden-account marker anywhere in the export', !/O1MARK|P1MARK|C1MARK|"gB"|ms-orphan|ms-other/.test(JSON.stringify(out)), JSON.stringify(out).match(/O1MARK|P1MARK|C1MARK|"gB"|ms-orphan|ms-other/g));
    ok('F2: account metadata lists only the visible accounts', JSON.stringify(out.accounts) === JSON.stringify([{ accountId: 'gA', provider: 'google' }, { accountId: 'ms-1', provider: 'microsoft' }]), out.accounts);
    ok('F2: filtering does not modify the stored data', JSON.stringify(data) === before);
    ok('F2: signed out → only local Items', ids(INV.filterExport(data, []).items) === 'l1');
  }
  // ---------------- F1 write guards ----------------
  const person = (name, address) => ({ emailAddress: { name, address } });
  const iso = (s) => new Date(Date.parse(s)).toISOString();
  const config = W.DaylightGmailConfig.resolve();
  {
    const g = createMockGraph(); g.add('inbox', { id: 'X1', conversationId: 'x', subject: 'Invoice 7781 – amount due 1 150 Kč', from: person('U', 'billing@utility.example'), receivedDateTime: iso('2026-11-05T09:00:00Z'), bodyPreview: 'Invoice 7781. Amount due 1 150 Kč by 30 Nov 2026.' }, { html: '<p>Amount due: 1 150 Kč</p><p>Due date: 30 November 2026</p>' });
    const cache = MC.createMailCache({}); let still = true; let writes = 0;
    const realPut = cache.putMany; cache.putMany = async (...a) => { writes++; return realPut(...a); };
    // the account changes while the (delayed) delta response is on its way
    const slowFetch = async (u, i) => { const r = await g.fetch(u, i); still = false; return r; };
    const p = W.DaylightOutlookPipeline.createOutlookPipeline({ fetch: slowFetch, getToken: async () => 't', guard: () => still, cache, rules: W.DaylightGmailRules, config, now: () => NOW, sleep: async () => {} });
    let err = null; try { await p.run({ accountId: 'ms-a' }); } catch (e) { err = e; }
    ok('F1: Outlook pipeline: a response arriving after the account changed is discarded (aborted, nothing written)', err && err.aborted && writes === 0 && (await cache.all('ms-a')).length === 0 && !(await cache.getCheckpoint('ms-a')), { err: err && err.message, writes });
    const p2 = W.DaylightOutlookPipeline.createOutlookPipeline({ fetch: g.fetch, getToken: async () => 't', guard: () => true, cache, rules: W.DaylightGmailRules, config, now: () => NOW, sleep: async () => {} });
    const r2 = await p2.run({ accountId: 'ms-a' });
    ok('F1: with the account unchanged the same sync stores normally', r2.report.ok && (await cache.all('ms-a')).length === 1);
    // connector ingest
    const graph = IG.createGraph({ backend: 'memory', now: () => NOW });
    const conn = W.DaylightGmailConnector.createGmailConnector({ app: 'outlook', graph, mailCache: cache, classifier: W.DaylightClassifier, now: () => NOW });
    let e2 = null; try { await conn.ingest('ms-a', { since: 0, guard: () => false }); } catch (e) { e2 = e; }
    ok('F1: connector ingest stops before writing when the account changed', e2 && e2.aborted && (await graph.query({})).length === 0);
    // OneDrive
    const store = { m: {}, get(k) { return this.m[k] || null; }, set(k, v) { this.m[k] = v; } };
    g.addFile({ id: 'f1', name: 'Notes.docx', size: 10, lastModifiedDateTime: iso('2026-11-01T09:00:00Z'), file: { mimeType: 'application/octet-stream' } }, 'x');
    let ok3 = true; const od = W.DaylightOneDrive.createOneDrive({ fetch: async (u, i) => { const r = await g.fetch(u, i); ok3 = false; return r; }, getToken: async () => 't', guard: () => ok3, graph, store, now: () => NOW, sleep: async () => {} });
    let e3 = null; try { await od.sync('ms-a'); } catch (e) { e3 = e; }
    ok('F1: OneDrive: a file list arriving after the account changed is discarded (no Items, no delta link)', e3 && e3.aborted && (await graph.query({ type: 'file' })).length === 0 && !store.get('daylight-onedrive-delta:ms-a'));
  }
  console.log(`Account scope unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
