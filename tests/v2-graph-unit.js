/**
 * V2 Phase C unit checks: Item Graph, connector contract, Gmail connector, classifier, user rules, applyAction, processing log.
 * SYNTHETIC data only. Run: node tests/v2-graph-unit.js
 */
'use strict';
const path = require('path');
global.window = globalThis;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'email-classify.js'));
require(path.join(ROOT, 'mail-dates.js'));
const IG = require(path.join(ROOT, 'graph/item-graph.js'));
const UR = require(path.join(ROOT, 'classification/user-rules.js'));
const CL = require(path.join(ROOT, 'classification/classifier.js'));
const CR = require(path.join(ROOT, 'connectors/connector-registry.js'));
const GC = require(path.join(ROOT, 'connectors/gmail-connector.js'));
const AC = require(path.join(ROOT, 'actions/apply-action.js'));
const PLOG = require(path.join(ROOT, 'privacy/processing-log.js'));
const GS = require(path.join(ROOT, 'gmail-sync.js'));
const CFG = require(path.join(ROOT, 'gmail-config.js'));
const R = require(path.join(ROOT, 'gmail-rules.js'));
const MC = require(path.join(ROOT, 'gmail-cache.js'));
const BT = require(path.join(ROOT, 'gmail-batch.js'));
const PL = require(path.join(ROOT, 'gmail-pipeline.js'));
const { createMockGmail } = require('./mock-gmail.js');
const { MAIL } = require('./fixtures/mail-v2-categories.js');
const DAY = 86400000, NOW = Date.UTC(2026, 10, 5, 7, 0, 0);

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); };
const clock = { t: NOW }; const now = () => clock.t;

(async () => {
  // ================= Item Graph =================
  {
    const g = IG.createGraph({ backend: 'memory', now });
    const a = await g.upsertItem({ key: 'booking:a:4123987', type: 'booking', title: 'Hotel Lisboa', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm1' }], extractedFacts: [{ key: 'reference', value: '4123987', sourceItemId: 'e1' }] });
    const b = await g.upsertItem({ key: 'booking:a:4123987', type: 'booking', title: 'Hotel Lisboa (changed)', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm2', role: 'evidence' }], extractedFacts: [{ key: 'start', value: '2026-11-20', sourceItemId: 'e2' }] });
    ok('graph: same natural key twice → one Item', a.id === b.id && (await g.counts()).total === 1);
    ok('graph: one logical Item keeps both sources and all facts', b.sources.length === 2 && b.extractedFacts.length === 2);
    await g.upsertItem({ key: 'booking:a:4123987', type: 'booking', title: 'x', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm1' }] });
    ok('graph: re-ingesting the same source adds no duplicate source', (await g.getItem(a.id)).sources.length === 2);
    const it = await g.getItem(a.id); it.status = 'done'; it.userCorrections = [{ to: 'x' }]; await g.putItem(it);
    await g.upsertItem({ key: 'booking:a:4123987', type: 'booking', title: 'sync again', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm1' }], status: 'open' });
    const it2 = await g.getItem(a.id);
    ok('graph: sync never overwrites what the user did (status, corrections)', it2.status === 'done' && it2.userCorrections.length === 1 && it2.title === 'sync again');
    const p = await g.upsertItem({ key: 'person:x@y.cz', type: 'person', title: 'X', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm1', role: 'mention' }] });
    await g.link(a.id, p.id, 'with'); await g.link(a.id, p.id, 'with');
    ok('graph: links are idempotent and both Items list each other', (await g.links(a.id)).length === 1 && (await g.getItem(p.id)).relatedItemIds.includes(a.id));
    // multi-provider Item survives disconnecting one provider
    const t = await g.upsertItem({ key: 'task:draft-si', type: 'task', title: 'Draft SI', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm9' }, { app: 'todoist', accountId: 't', itemId: '77', role: 'primary' }] });
    const n = await g.deleteBySource('gmail', 'a');
    const t2 = await g.getItem(t.id);
    ok('graph: disconnect deletes provider-only Items and keeps multi-source Items with their other source', n === 2 && !(await g.getItem(a.id)) && !(await g.getItem(p.id)) && t2 && t2.sources.length === 1 && t2.sourceApp === 'todoist', { n, t2 });
    ok('graph: links of deleted Items are removed', (await g.links()).length === 0);
    const q = await g.upsertItem({ key: 'x:1', type: 'deadline', title: 'Q', sources: [{ app: 'gmail', accountId: 'a', itemId: 'mX' }] });
    await g.removeSourceItem('gmail', 'a', 'mX');
    ok('graph: a deleted source message removes the Item it alone supported', !(await g.getItem(q.id)));
  }

  // ================= Classifier =================
  {
    const base = { from: 'ČEZ Prodej <faktury@cez.cz>', subject: 'Vyúčtování elektřiny', snippet: 'Částka k úhradě 1 250 Kč', labels: ['INBOX', 'CATEGORY_UPDATES'], pipelineCategory: 'bill', facts: { amount: { value: 1250, currency: 'CZK' }, dueDate: '2026-11-06' } };
    const c1 = CL.classify(base, { now: NOW });
    ok('classifier: unpaid bill → invoice with a pay action, due soon raises importance', c1.type === 'invoice' && c1.action === 'pay' && c1.importance >= 60 && c1.reasons.some((r) => /due within 2 days/.test(r)), c1);
    const c2 = CL.classify(Object.assign({}, base, { labels: [...base.labels, 'UNREAD', 'IMPORTANT'] }), { now: NOW });
    ok('classifier: UNREAD and Gmail IMPORTANT do not change importance', c2.importance === c1.importance);
    const promoReceipt = CL.classify({ from: 'Zara <noreply@zara.com>', subject: 'Thanks for shopping with us', snippet: 'Order ZR-90012 confirmed. Total 1 590 CZK', labels: ['INBOX', 'CATEGORY_PROMOTIONS'], listUnsubscribe: true, pipelineCategory: 'receipt', facts: { amount: { value: 1590, currency: 'CZK' } } }, { now: NOW });
    ok('classifier: a receipt filed in Promotions is a receipt, not marketing', promoReceipt.type === 'receipt', promoReceipt);
    const person = CL.classify({ from: 'Prof. Jan Novák <novak@fzu.cz>', subject: 'Slides for Thursday', snippet: 'Could you send me the slides by Wednesday evening?', labels: ['INBOX', 'CATEGORY_PERSONAL'], pipelineCategory: 'personal', keyDates: [] }, { now: NOW });
    ok('classifier: a person asking for something → university/work, high importance with reasons', ['university_work', 'personal'].includes(person.type) && person.importance >= 60 && person.reasons.some((r) => /asks you/.test(r)), person);
    const promo = CL.classify({ from: 'Zalando <news@zalando.cz>', subject: 'Black Friday — 70 % off', snippet: 'Sale', labels: ['INBOX', 'CATEGORY_PROMOTIONS'], listUnsubscribe: true, pipelineCategory: 'promotion' }, { now: NOW });
    ok('classifier: real marketing stays low', promo.type === 'marketing' && promo.band === 'low');
    const ident = CL.classify({ from: 'Ministerstvo vnitra <info@mvcr.cz>', subject: 'Your passport is ready for collection', snippet: '', labels: ['INBOX'], pipelineCategory: 'document' }, { now: NOW });
    ok('classifier: identity documents are flagged (never sent to AI)', ident.identity === true);
    ok('classifier: every type is from the V2 list of 18', [c1, promoReceipt, person, promo, ident].every((x) => CL.TYPES.includes(x.type)));
  }

  // ================= Connector registry =================
  {
    const reg = CR.createRegistry();
    let threw = false; try { reg.register({ id: 'bad', status: 'live', connect() {} }); } catch { threw = true; }
    ok('connectors: a provider missing contract methods is rejected', threw);
    ok('connectors: Calendar, Tasks, Contacts, Outlook, Notion, Todoist, GitHub, Slack, Spotify are registered as planned', ['google-calendar', 'google-tasks', 'google-contacts', 'outlook', 'notion', 'todoist', 'github', 'slack', 'spotify'].every((id) => reg.get(id)?.status === 'planned'));
    let refused = false; try { await reg.get('notion').connect(); } catch (e) { refused = e.code === 'not_available'; }
    ok('connectors: planned providers refuse to connect (never faked)', refused && (await reg.get('notion').getConnectionStatus()).connected === false);
  }

  // ================= Gmail connector over a real pipeline run =================
  const mock = createMockGmail({ now: NOW, extraHeaders: 2 });
  MAIL.forEach((m) => mock.add({ id: m.id, threadId: m.threadId, from: m.from, subject: m.subject, snippet: m.snippet, body: m.body, html: m.html, labelIds: m.labelIds.slice(), listUnsubscribe: m.listUnsubscribe, attachments: m.attachments, internalDate: NOW - (m.ageDays + 1) * DAY }));
  const cache = MC.createMailCache({ now: () => mock.now() });
  const engine = GS.createGmailSync({ request: mock.request, sleep: async (ms) => mock.setNow(mock.now() + ms), now: () => mock.now(), random: () => 0.5 });
  const pipe = PL.createMailPipeline({ engine, cache, rules: R, config: CFG.resolve({}), batch: BT, batchSend: mock.batchSend, now: () => mock.now(), fullFields: GS.FULL_FIELDS });
  await pipe.run({ accountId: 'a', label: 'connect' });
  for (let i = 0; i < 5; i++) { const rows = await cache.all('a'); if (!rows.some((r) => r.status === 'body-queued')) break; mock.setNow(mock.now() + 300000); await pipe.run({ accountId: 'a', label: 'drain' }); }
  const g = IG.createGraph({ backend: 'memory', now });
  const rules = UR.createRuleStore(g, { now });
  const reg = CR.createRegistry();
  const gmail = GC.createGmailConnector({ graph: g, mailCache: cache, classifier: CL, ruleStore: rules, now, getAccountId: () => 'a' });
  reg.register(gmail);
  ok('gmail connector satisfies the contract and is the only live provider', reg.live().map((c) => c.id).join() === 'gmail');
  ok('gmail connector is read-only (no write capabilities, gmail.readonly only)', gmail.getCapabilities().write.length === 0 && gmail.getPermissions().every((p) => /gmail\.readonly$/.test(p.scope)));
  const r1 = await gmail.ingest('a', { now: NOW });
  const c1 = await g.counts();
  const r2 = await gmail.ingest('a', { now: NOW });
  const c2 = await g.counts();
  ok('ingest twice → identical graph (no duplicate Items or links)', c1.total === c2.total && c1.links === c2.links && c1.total > 0, { c1, c2 });
  const emails = await g.query({ type: 'email' });
  ok('every fetched email is one email Item; skipped mail never becomes an Item', emails.length === r1.emails && emails.every((e) => e.sources[0].app === 'gmail'));
  const byTitle = (t) => emails.find((e) => e.title === t);
  const cez = byTitle('Vyúčtování elektřiny');
  const cezRel = cez ? await g.related(cez.id) : [];
  ok('bill email → email + bill Item + organisation, linked', cez && cezRel.some((x) => x.type === 'bill') && cezRel.some((x) => x.type === 'organisation'), cezRel.map((x) => x.type));
  const bill = cezRel.find((x) => x.type === 'bill');
  ok('every extracted fact names its source Item', bill && bill.extractedFacts.length > 0 && bill.extractedFacts.every((f) => f.sourceItemId === cez.id));
  ok('bill facts are real values from the email (amount 1250 CZK)', bill && bill.extractedFacts.some((f) => f.key === 'amount' && Number(f.value) === 1250) && bill.extractedFacts.some((f) => f.key === 'currency' && /CZK|Kč/.test(f.value)), bill && bill.extractedFacts);
  const lis = byTitle('You are all set for Lisbon!');
  const lisRel = lis ? await g.related(lis.id) : [];
  ok('booking filed in Promotions → booking Item with its reference', lisRel.some((x) => x.type === 'booking' && x.extractedFacts.some((f) => f.key === 'reference' && String(f.value) === '4123987')), lisRel.map((x) => [x.type, x.extractedFacts]));
  const promosAsMoney = (await g.query({ type: ['transaction', 'bill', 'subscription'] })).filter((x) => x.sources.some((s) => ['v0017', 'v0018', 'v0021', 'v0022'].includes(s.itemId)));
  ok('receipts / renewals filed in Promotions become money Items', promosAsMoney.length >= 3, promosAsMoney.map((x) => x.title));
  const marketing = emails.filter((e) => e.classification.type === 'marketing');
  { const dist = {}; emails.forEach((e) => { dist[e.classification.type] = (dist[e.classification.type] || 0) + 1; }); console.log('  graph:', JSON.stringify(c1.byType), '| email types:', JSON.stringify(dist)); }
  ok('there is marketing in the test mailbox to check against', marketing.length >= 5, marketing.length);
  ok('marketing emails are typed marketing with low importance', marketing.every((e) => e.priority < 30));
  const prof = byTitle('Slides for Thursday');
  ok('a request from a person is high importance with an explanation', prof && prof.priority >= 60 && prof.classification.reasons.length > 0, prof && prof.classification);

  // ================= Corrections → visible rule =================
  const acts = AC.createActions({ graph: g, registry: reg, ruleStore: rules, now });
  const news = emails.find((e) => /medium\.com/.test(e.extractedEntities.senderDomain || '')) || marketing[0];
  console.log('  correcting:', news.title, news.extractedEntities.senderDomain, news.classification.type);
  const res = await acts.applyAction(news.id, 'correct_type', { type: 'personal' });
  const allRules = await rules.all();
  ok('correction updates the Item, records it, and creates ONE visible rule', res.ok && res.item.classification.type === 'personal' && res.item.classification.userSet && res.item.userCorrections.length === 1 && allRules.length === 1 && /→ Important personal/.test(allRules[0].label), { res: res.error, rules: allRules.map((r) => r.label) });
  const sameSender = (await g.query({ type: 'email' })).filter((e) => e.extractedEntities.senderDomain === news.extractedEntities.senderDomain);
  ok('the rule re-types the other emails from that sender at once', sameSender.length > 0 && sameSender.every((e) => e.classification.type === 'personal'), sameSender.map((e) => e.classification.type));
  ok('Daylight stops asking about this sender', UR.shouldAsk(allRules, { fromEmail: news.extractedEntities.senderEmail, fromDomain: news.extractedEntities.senderDomain }, 0.4) === false);
  await gmail.ingest('a', { now: NOW });
  ok('the rule survives re-sync and is applied by the classifier to that sender', (await g.getItem(news.id)).classification.type === 'personal');
  await rules.edit(allRules[0].id, { enabled: false });
  const disabledMatch = UR.match(await rules.all(), { fromDomain: news.extractedEntities.senderDomain });
  ok('a rule can be disabled and then no longer applies', disabledMatch === null);

  // ================= applyAction =================
  const target = cez;
  const bad = await acts.applyAction(target.id, 'snooze', { until: NOW - 1000 });
  ok('validation: snooze in the past is refused, nothing changes', !bad.ok && (await g.getItem(target.id)).status === 'open');
  const done = await acts.applyAction(target.id, 'done', {});
  ok('done: local state updates at once; Gmail write-back is local-only (read-only release)', done.ok && (await g.getItem(target.id)).status === 'done' && done.writeBack.every((w) => w.status === 'local-only'));
  ok('done: recorded in the Item history and the actions store', (await g.getItem(target.id)).actionHistory.some((h) => h.kind === 'done') && (await g.actions.all()).some((a) => a.id === done.actionId));
  const und = await acts.undo(done.actionId);
  ok('undo restores the previous state', und.ok && (await g.getItem(target.id)).status === 'open');
  const again = await acts.undo(done.actionId);
  ok('undo cannot be applied twice', !again.ok);
  const sn = await acts.applyAction(target.id, 'snooze', { until: NOW + DAY });
  clock.t = NOW + DAY + 1;
  const woke = await acts.wakeSnoozed();
  ok('snoozed Items come back when their time arrives', sn.ok && woke === 1 && (await g.getItem(target.id)).status === 'open');
  clock.t = NOW;
  ok('no pending write-back jobs exist in the read-only release', (await acts.pendingWrites()).length === 0);
  const fresh = await g.upsertItem({ key: 'gmail:a:' + target.sources[0].itemId, type: 'email', title: 'resync', sources: target.sources });
  ok('echo protection: re-sync after an action keeps the action history', fresh.actionHistory.length >= 3);

  // ================= processing log =================
  const log = PLOG.createLog({ graph: g, now });
  await log.add({ kind: 'ai', dest: 'Daylight server → Gemini', what: 'x'.repeat(1000), bytes: 1800, messageId: 'm1' });
  const L = await log.list();
  ok('processing log records what left the device without storing content', L.length === 1 && L[0].what.length <= 160 && L[0].bytes === 1800);

  // ================= disconnect through the connector =================
  const before = (await g.counts()).total;
  const dis = await gmail.disconnect();
  const after = await g.counts();
  ok('Gmail disconnect deletes every Gmail Item, link and Gmail-created rule from the graph', before > 0 && dis.deleted === before && after.total === 0 && after.links === 0 && after.rules === 0, { before, dis, after });

  // ---- Phase E fixes (found by the two-account E2E) ----
  {
    const n1 = gmail.normalise({ messageId: 'x1', threadId: 'tx1', from: 'PRE <faktury@pre.cz>', subject: 'Faktura 88812', snippet: '', labels: ['INBOX'], category: 'bill', internalDate: NOW }, { fields: { amount: { value: 2310, currency: 'CZK' }, dueDate: { date: '2026-11-12', raw: '12. 11. 2026', confidence: 0.88 }, reference: '88812' } }, { accountId: 'a', now: NOW });
    const bill = n1.items.find((x) => x.type === 'bill');
    ok('fix: a rules due date ({date,…}) becomes the bill due date (was "[object Object]")', bill && bill.dueAt === new Date(2026, 10, 12, 23, 59).getTime() && !JSON.stringify(n1.items).includes('[object Object]'), bill && bill.dueAt);
    const n2 = gmail.normalise({ messageId: 'x2', threadId: 'tx2', from: 'RegioJet <info@regiojet.cz>', subject: 'Your ticket Brno → Praha, booking RJ55120', snippet: 'Departure 14 Nov 2026 08:15', labels: ['INBOX'], category: 'travel', internalDate: NOW, keyDates: [{ kind: 'travel', date: '2026-11-14', time: '08:15', quote: 'Departure 14 Nov 2026 08:15' }] }, { fields: { reference: 'RJ55120' } }, { accountId: 'a', now: NOW });
    ok('fix: a travel email with a date becomes a booking Item', n2.items.some((x) => x.type === 'booking' && /RJ55120/.test(x.key)));
    const n3 = gmail.normalise({ messageId: 'x3', threadId: 'tx3', from: 'Landlord Jana <jana.landlord@gmail.com>', subject: 'Rent for November — please confirm', snippet: 'Hi, could you confirm you sent the rent of 14 000 CZK by Friday?', labels: ['INBOX'], category: 'payment', internalDate: NOW }, { fields: { amount: { value: 14000, currency: 'CZK' } } }, { accountId: 'a', now: NOW });
    ok('fix: a person asking about a payment is a message to answer, not a transaction', n3.classification.type === 'personal' && !n3.items.some((x) => x.type === 'transaction'));
    // re-ingest cleans up an Item the email no longer produces (e.g. the old "[object Object]" bill key)
    const g5 = IG.createGraph({ backend: 'memory', now });
    const rec = { messageId: 'm5', threadId: 't5', from: 'PRE <faktury@pre.cz>', subject: 'Faktura', snippet: '', labels: ['INBOX'], category: 'bill', internalDate: NOW, status: 'classified', lastProcessedAt: NOW };
    const fc = { all: async () => [rec], getFacts: async () => new Map([['m5', { fields: { amount: { value: 99, currency: 'CZK' }, dueDate: { date: '2026-11-20' } } }]]) };
    await g5.upsertMany([{ key: 'gmail:a:m5', accountId: 'a', type: 'email', title: 'Faktura', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm5' }] }, { key: 'money:a:pre.cz:[object Object]', accountId: 'a', type: 'bill', title: 'PRE · 99 CZK', status: 'done', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm5', role: 'evidence' }] }]);
    await g5.link(IG.itemId('gmail:a:m5'), IG.itemId('money:a:pre.cz:[object Object]'), 'evidence', 'a');
    const gc5 = GC.createGmailConnector({ graph: g5, mailCache: fc, classifier: CL, now, getAccountId: () => 'a' });
    await gc5.ingest('a', {});
    const bills5 = await g5.query({ type: 'bill' });
    ok('fix: re-ingest removes the stale bill, keeps one correct bill and carries over your Done', bills5.length === 1 && bills5[0].key === 'money:a:pre.cz:2026-11-20' && bills5[0].status === 'done' && !(await g5.links()).some((l) => l.to === IG.itemId('money:a:pre.cz:[object Object]')), bills5.map((x) => x.key));
    ok('fix: "booking RJ55120" is read as a reference', R.extractRef('Your ticket Brno → Praha, booking RJ55120') === 'RJ55120' && R.extractRef('Thanks for booking with us today') === null);
  }
  console.log(`V2 graph unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})();
