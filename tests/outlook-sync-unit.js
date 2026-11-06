/**
 * Outlook mail engine (outlook-sync.js) against a mock Microsoft Graph — synthetic mail, NOT a real mailbox.
 * Cold sync per folder, immutable IDs, bodies by $batch ≤ 20, delta links, moved / deleted / read-state changes,
 * expired delta link, throttling (429 + Retry-After), token refresh on 401, then the same Item Graph connector
 * (app 'outlook') producing bills / receipts / emails with Outlook links; isolation from Gmail data.
 * Run: node tests/outlook-sync-unit.js
 */
'use strict';
const path = require('path');
global.window = globalThis;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const ROOT = path.resolve(__dirname, '..');
['mail-dates.js', 'gmail-rules.js', 'gmail-config.js', 'gmail-cache.js', 'gmail-pipeline.js', 'email-classify.js', 'finance-intel.js', 'graph/item-graph.js', 'classification/user-rules.js', 'classification/classifier.js', 'connectors/gmail-connector.js', 'outlook-sync.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis;
const { createMockGraph } = require('./mock-graph.js');
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); };
const NOW = Date.parse('2026-11-06T10:00:00Z'); let clock = NOW;
const iso = (s) => new Date(Date.parse(s)).toISOString();
const person = (name, address) => ({ emailAddress: { name, address } });
const ACCT = 'ms-test1', GACCT = '101989296381161071011';

function mailbox(g) {
  g.add('inbox', { id: 'AAkALg-vf1', conversationId: 'c1', subject: 'Nová faktura 2026115566', from: person('Vodafone CZ', 'ebill@vodafone.cz'), toRecipients: [person('Jana', 'jana@outlook.com')], receivedDateTime: iso('2026-11-03T08:00:00Z'), bodyPreview: 'Faktura č. 2026115566. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.' },
    { html: '<p>Dobrý den,</p><p>Faktura č. 2026115566.</p><p>Celkem k úhradě: <b>712,00 Kč</b></p><p>Datum splatnosti: 3. 12. 2026</p><p>Variabilní symbol: 2026115566</p>' });
  g.add('inbox', { id: 'AAkALg-an1', conversationId: 'c2', subject: 'Your receipt from Anthropic, PBC #2615-9581-3414', from: person('Anthropic, PBC', 'invoice+statements@mail.anthropic.com'), receivedDateTime: iso('2026-11-02T09:00:00Z'), bodyPreview: 'Your receipt from Anthropic, PBC #2615-9581-3414', isRead: true },
    { html: '<h1>Receipt from Anthropic, PBC</h1><p>Amount paid $10.00</p><p>Date paid November 2, 2026</p><p>Receipt number 2615-9581-3414</p>' });
  g.add('inbox', { id: 'AAkALg-pe1', conversationId: 'c3', subject: 'Fock 10 - Wigner function', from: person('Petr Novak', 'petr.novak@upol.cz'), receivedDateTime: iso('2026-11-05T09:00:00Z'), bodyPreview: 'Hi, sending processed minima of the Wigner function. Could you check them before Friday?' },
    { text: 'Hi, sending processed minima of the Wigner function. Could you check them before Friday? Petr' });
  g.add('inbox', { id: 'AAkALg-nl1', conversationId: 'c4', subject: 'Your weekly digest: 12 new articles', from: person('Medium Daily Digest', 'noreply@medium.com'), receivedDateTime: iso('2026-11-04T06:00:00Z'), bodyPreview: 'Stories for you', inferenceClassification: 'other' },
    { html: '<p>Stories for you</p>', headers: [{ name: 'List-Unsubscribe', value: '<https://medium.com/unsub>' }] });
  g.add('inbox', { id: 'AAkALg-old', conversationId: 'c5', subject: 'Old', from: person('X', 'x@example.com'), receivedDateTime: iso('2026-06-01T09:00:00Z'), bodyPreview: 'outside the window' });
  g.add('sentitems', { id: 'AAkALg-se1', conversationId: 'c3', subject: 'Re: Fock 10 - Wigner function', from: person('Jana', 'jana@outlook.com'), toRecipients: [person('Petr Novak', 'petr.novak@upol.cz')], receivedDateTime: iso('2026-11-05T10:00:00Z'), bodyPreview: 'Thanks, will do.', isRead: true });
  for (let i = 0; i < 24; i++) g.add('inbox', { id: 'AAkALg-bulk' + i, conversationId: 'cb' + i, subject: `Order ${8800 + i} confirmed – total ${100 + i} Kč`, from: person('Shop', 'orders@shop' + (i % 3) + '.example'), receivedDateTime: iso('2026-11-01T10:00:00Z'), bodyPreview: `Thank you for your order ${8800 + i}. Total ${100 + i} Kč. Paid with card.` }, { html: `<p>Order number ${8800 + i}</p><p>Total paid: ${100 + i} Kč</p>` });
}

(async () => {
  const g = createMockGraph({ pageSize: 4 });
  mailbox(g);
  const MC = W.DaylightMailCache, cache = MC.createMailCache({});
  const config = W.DaylightGmailConfig.resolve();
  let tokenCalls = 0, forceRefresh = 0;
  const getToken = async (refresh) => { tokenCalls++; if (refresh) forceRefresh++; return 'at-' + tokenCalls; };
  const derive = (full) => ({ cls: W.DaylightEmailClassify.classifyEmail(full), fin: W.DaylightFinance.classify(full) });
  const slept = []; const sleep = async (ms) => { slept.push(ms); };
  const pipe = W.DaylightOutlookPipeline.createOutlookPipeline({ fetch: g.fetch, getToken, cache, rules: W.DaylightGmailRules, config, derive, now: () => clock, sleep });

  // ---- cold sync ----
  const r1 = (await pipe.run({ accountId: ACCT })).report;
  const rows = await cache.all(ACCT);
  const deltaCalls = g.log.filter((l) => /messages\/delta/.test(l.url));
  ok('cold sync: one delta per folder with $select and a receivedDateTime window', ['inbox', 'sentitems', 'archive'].every((f) => deltaCalls.some((l) => l.url.includes(`/mailFolders/${f}/messages/delta?$select=`) && /receivedDateTime%20ge%20/.test(l.url))), deltaCalls.map((l) => l.url.slice(0, 120)));
  ok('every Graph request asks for immutable IDs', g.stats.immutableHeader === g.stats.requests, g.stats);
  ok('messages outside the window are not read', !rows.some((r) => r.messageId === 'AAkALg-old'));
  ok('all 29 in-window messages are in the mail index (inbox 28, sent 1)', rows.length === 29, rows.length);
  ok('bodies come in $batch requests of at most 20', g.stats.batchSizes.length >= 1 && g.stats.batchSizes.every((n) => n <= 20), g.stats.batchSizes);
  ok('only messages that need it get a body (not every message)', g.stats.bodies > 0 && g.stats.bodies < rows.length, { bodies: g.stats.bodies, rows: rows.length });
  ok('no message body is stored in the mail index', !JSON.stringify(rows).includes('Variabilní symbol') && !JSON.stringify(rows).includes('Amount paid $10.00'));
  const vf = rows.find((r) => r.messageId === 'AAkALg-vf1');
  ok('Vodafone invoice → category bill, body read', vf && vf.category === 'bill' && vf.bodyFetched, vf && { cat: vf.category, st: vf.status, reason: vf.ruleReason });
  const nl = rows.find((r) => r.messageId === 'AAkALg-nl1');
  ok('Focused/Other map to Gmail-like categories; unread/read kept', nl.labels.includes('CATEGORY_UPDATES') && vf.labels.includes('CATEGORY_PERSONAL') && vf.labels.includes('UNREAD') && !rows.find((r) => r.messageId === 'AAkALg-an1').labels.includes('UNREAD'));
  ok('sent mail is labelled SENT', rows.find((r) => r.messageId === 'AAkALg-se1').labels.join() === 'SENT');
  ok('report: ok, cold, archive folder read', r1.ok && r1.cold && r1.folders.archive && !r1.folders.archive.error, r1);
  ok('Outlook web links are kept for "Open in Outlook"', /outlook\.live\.com/.test(vf.webLink));

  // ---- Item Graph ----
  const graph = W.DaylightItemGraph.createGraph({ backend: 'memory', now: () => clock });
  const conn = W.DaylightGmailConnector.createGmailConnector({ app: 'outlook', name: 'Outlook', group: 'microsoft', urlOf: W.DaylightOutlookPipeline.outlookUrl, graph, mailCache: cache, classifier: W.DaylightClassifier, now: () => clock, getAccountId: () => ACCT });
  const ing = await conn.ingest(ACCT, { since: 0 });
  const items = await graph.query({ accountId: ACCT });
  const bill = items.find((x) => x.type === 'bill' && /Vodafone/.test(x.title));
  const anth = items.find((x) => /Anthropic/.test(x.title) && x.type !== 'email' && x.type !== 'organisation' && x.type !== 'person');
  const email = items.find((x) => x.key === `outlook:${ACCT}:AAkALg-pe1`);
  ok('ingest: email Items keyed outlook:<account>:<id>', ing.emails === 29 && items.filter((x) => x.type === 'email').length === 29 && email);
  ok('Vodafone → a bill of 712 CZK with its due date', bill && /712/.test(bill.title) && bill.dueAt, bill && { t: bill.title, due: bill.dueAt });
  ok('Anthropic receipt → transaction (receipt), not a bill', anth && anth.type === 'transaction', anth && [anth.type, anth.meta]);
  ok('sources say Outlook and link to Outlook on the web', bill.sources.every((s) => s.app === 'outlook' && /outlook\.live\.com/.test(s.url)));
  ok("a colleague's question is an email that needs you, not a money Item", email && !items.some((x) => ['bill', 'transaction'].includes(x.type) && x.sources.some((s) => s.itemId === 'AAkALg-pe1')));

  // ---- incremental ----
  const before = g.stats.bodies;
  clock += 3600000;
  g.add('inbox', { id: 'AAkALg-new1', conversationId: 'c9', subject: 'Booking confirmation EXK7Q2', from: person('Czech Airlines', 'booking@csa.example'), receivedDateTime: iso('2026-11-06T10:30:00Z'), bodyPreview: 'Your flight PRG–AMS on 20 Nov 2026, booking reference EXK7Q2' }, { html: '<p>Booking reference EXK7Q2</p><p>Prague (PRG) → Amsterdam (AMS), 20 November 2026, 13:52</p>' });
  g.update('inbox', 'AAkALg-vf1', { isRead: true });
  g.remove('inbox', 'AAkALg-nl1');
  g.move('inbox', 'archive', 'AAkALg-pe1');
  const deltaBefore = g.log.length;
  const r2 = (await pipe.run({ accountId: ACCT })).report;
  const newCalls = g.log.slice(deltaBefore);
  const rows2 = await cache.all(ACCT);
  ok('incremental: follows saved delta links (no window filter again)', newCalls.filter((l) => /messages\/delta/.test(l.url)).every((l) => /\$deltatoken=/.test(l.url)), newCalls.map((l) => l.url.slice(0, 110)));
  ok('incremental: one new message, one body read at most', r2.records.fresh === 1 && g.stats.bodies - before <= 1, r2.records);
  ok('read-state change updates labels only (no body, no reclassification)', !rows2.find((r) => r.messageId === 'AAkALg-vf1').labels.includes('UNREAD') && rows2.find((r) => r.messageId === 'AAkALg-vf1').category === 'bill');
  ok('a deleted message is tombstoned', rows2.find((r) => r.messageId === 'AAkALg-nl1').status === 'deleted');
  ok('a moved message keeps its ID (not deleted), now labelled ARCHIVE', rows2.find((r) => r.messageId === 'AAkALg-pe1').status !== 'deleted' && rows2.find((r) => r.messageId === 'AAkALg-pe1').labels.includes('ARCHIVE'), rows2.find((r) => r.messageId === 'AAkALg-pe1'));
  const ing2 = await conn.ingest(ACCT, { since: clock - 1 });
  const items2 = await graph.query({ accountId: ACCT });
  ok('incremental ingest: deleted mail leaves the graph, new booking appears, no duplicate emails', ing2.removed >= 1 && !items2.some((x) => x.key === `outlook:${ACCT}:AAkALg-nl1`) && items2.some((x) => x.type === 'booking') && new Set(items2.filter((x) => x.type === 'email').map((x) => x.key)).size === items2.filter((x) => x.type === 'email').length, ing2);

  // ---- expired delta link ----
  const cp = await cache.getCheckpoint(ACCT);
  g.expire(new URL(cp.msDelta.inbox).searchParams.get('$deltatoken'));
  const r3 = (await pipe.run({ accountId: ACCT })).report;
  const rows3 = await cache.all(ACCT);
  ok('expired delta link (410) → that folder restarts from the window, no duplicates, nothing re-read', r3.counters.resync === 1 && rows3.length === rows2.length && r3.records.fresh === 0 && r3.ok, { c: r3.counters, n: [rows2.length, rows3.length], rec: r3.records });

  // ---- throttling + token refresh ----
  g.add('inbox', { id: 'AAkALg-new2', conversationId: 'c10', subject: 'Invoice 7781 – amount due 1 150 Kč', from: person('Utility Co', 'billing@utility.example'), receivedDateTime: iso('2026-11-06T11:00:00Z'), bodyPreview: 'Invoice 7781. Amount due 1 150 Kč by 30 Nov 2026.' }, { html: '<p>Invoice 7781</p><p>Amount due: 1 150 Kč</p><p>Due date: 30 November 2026</p>' });
  g.throttle('batch', 1); g.throttle('delta', 1);
  slept.length = 0;
  const r4 = (await pipe.run({ accountId: ACCT })).report;
  ok('429 with Retry-After: waits as told and retries (delta and $batch)', r4.throttled === 2 && slept.includes(1000) && slept.includes(2000) && r4.ok, { throttled: r4.throttled, slept });
  ok('…and the new invoice is a bill', (await cache.getMany(ACCT, ['AAkALg-new2'])).get('AAkALg-new2').category === 'bill');
  {
    const g2 = createMockGraph({ rejectToken: (a) => a === 'Bearer stale' }); g2.add('inbox', { id: 'X1', conversationId: 'x', subject: 'Hello', from: person('A', 'a@example.com'), receivedDateTime: iso('2026-11-05T09:00:00Z'), bodyPreview: 'hi' });
    let n = 0; const p2 = W.DaylightOutlookPipeline.createOutlookPipeline({ fetch: g2.fetch, getToken: async (refresh) => (n++ === 0 && !refresh ? 'stale' : 'fresh'), cache: MC.createMailCache({}), rules: W.DaylightGmailRules, config, now: () => clock, sleep });
    const r = (await p2.run({ accountId: 'ms-x' })).report;
    ok('an expired access token (401) → one refresh, then the sync completes', r.ok && n >= 2, r);
    const g3 = createMockGraph({ rejectToken: () => true }); g3.add('inbox', { id: 'X1', conversationId: 'x', subject: 'Hello', from: person('A', 'a@example.com'), receivedDateTime: iso('2026-11-05T09:00:00Z'), bodyPreview: 'hi' });
    const p3 = W.DaylightOutlookPipeline.createOutlookPipeline({ fetch: g3.fetch, getToken: async () => 'nope', cache: MC.createMailCache({}), rules: W.DaylightGmailRules, config, now: () => clock, sleep });
    const r5 = (await p3.run({ accountId: 'ms-y' })).report;
    ok('consent removed (401 again) → sync stops with "Microsoft sign-in expired", nothing saved as done', r5.fatal && r5.fatal.kind === 'auth' && /Microsoft sign-in expired/.test(r5.summary), r5);
  }
  {
    const g4 = createMockGraph({ noArchive: true }); g4.add('inbox', { id: 'Y1', conversationId: 'y', subject: 'Hello', from: person('A', 'a@example.com'), receivedDateTime: iso('2026-11-05T09:00:00Z'), bodyPreview: 'hi' });
    const c4 = MC.createMailCache({});
    const p4 = W.DaylightOutlookPipeline.createOutlookPipeline({ fetch: g4.fetch, getToken: async () => 't', cache: c4, rules: W.DaylightGmailRules, config, now: () => clock, sleep });
    const a = (await p4.run({ accountId: 'ms-z' })).report; const n0 = g4.stats.deltas; await p4.run({ accountId: 'ms-z' });
    ok('an account without an Archive folder: sync ok, and Archive is not asked for again', a.ok && a.folders.archive === 'absent' && g4.stats.deltas - n0 === 2, { a: a.folders, again: g4.stats.deltas - n0 });
  }
  // ---- isolation ----
  await cache.putMany(GACCT, [{ messageId: 'gm1', threadId: 'gt1', labels: ['INBOX'], subject: 'Gmail one', status: 'classified', internalDate: NOW }]);
  ok('Outlook rows live under the Microsoft account; Gmail rows untouched', (await cache.all(GACCT)).length === 1 && !(await cache.all(ACCT)).some((r) => r.messageId === 'gm1'));
  ok('Outlook Items carry the Microsoft account id only', items2.every((x) => x.accountId === ACCT));
  console.log(`Outlook sync unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
