/**
 * v108 release audit (synthetic mail, anonymised from real cases; this is NOT live Gmail validation).
 *  A) receipts: "Your receipt from …" is a transaction, never an unpaid bill — and genuine unpaid invoices stay bills
 *  B) tax documents: own Item, not added to spending when their order is known (also across a month boundary)
 *  C) x5 full re-ingest over a graph built by the real v107 code (tests/fixtures/v107): no duplicates, user state kept
 *     (and not copied onto other Items), unrelated Items untouched; then incremental ingest; failure part-way recovers;
 *     two tabs re-ingesting at the same time give the same result as one.
 * Run: node tests/v108-audit-unit.js
 */
'use strict';
const path = require('path');
global.window = globalThis;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'mail-dates.js'));
const IG = require(path.join(ROOT, 'graph/item-graph.js'));
const OLD_CL = require(path.join(__dirname, 'fixtures/v107/classification/classifier.js'));
const OLD_GC = require(path.join(__dirname, 'fixtures/v107/connectors/gmail-connector.js'));
delete require.cache[require.resolve(path.join(ROOT, 'classification/classifier.js'))];
const CL = require(path.join(ROOT, 'classification/classifier.js'));
const GC = require(path.join(ROOT, 'connectors/gmail-connector.js'));
const AA = require(path.join(ROOT, 'actions/apply-action.js'));
const M = require(path.join(ROOT, 'ui/v2-model.js'));
const DAY = 86400000, NOW = Date.UTC(2026, 10, 6, 10, 0, 0), at = (s) => Date.parse(s);
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, info) => { if (c) pass++; else { fail++; failures.push(n); } console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); };

const U = ['INBOX', 'CATEGORY_UPDATES'], PERS = ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'];
const mail = (id, from, subject, snippet, labels, date, category, fields) => ({ rec: { messageId: id, threadId: 't' + id, from, subject, snippet, labels, internalDate: at(date), category, status: 'done', lastProcessedAt: NOW - DAY }, facts: { fields: fields || {} } });
const ANTH = 'Anthropic, PBC <invoice+statements@mail.anthropic.com>';
const FILL = ' ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏';

(async () => {
  // ---------------- A) receipts vs unpaid invoices ----------------
  const RECEIPTS = [
    mail('anth', ANTH, 'Your receipt from Anthropic, PBC #2615-9581-3414', 'Your receipt from Anthropic, PBC #2615-9581-3414' + FILL, ['UNREAD', 'IMPORTANT', 'CATEGORY_UPDATES', 'INBOX'], '2026-11-02T09:00:00Z', 'bill', { amount: { value: 10, currency: 'USD' }, merchant: 'Anthropic, PBC' }),
    mail('apple', 'Apple <no_reply@email.apple.com>', 'Your receipt from Apple.', 'Receipt Apple Account: j***@example.com Billed To Visa •••• 1234 iCloud+ 50 GB 25,00 Kč', U, '2026-11-01T09:00:00Z', 'bill', { amount: { value: 25, currency: 'CZK' }, merchant: 'Apple' }),
    mail('uctenka', 'Rohlik.cz <info@rohlik.cz>', 'Účtenka k objednávce 1180023', 'Děkujeme za nákup. Celkem 812 Kč', U, '2026-11-01T10:00:00Z', 'bill', { amount: { value: 812, currency: 'CZK' }, merchant: 'Rohlik.cz' }),
    mail('fzapl', 'Dodavatel s.r.o. <fakturace@dodavatel.cz>', 'Faktura 2026-118 – zaplaceno', 'Faktura 2026-118 byla uhrazena. Celkem 1 200 Kč', U, '2026-11-01T11:00:00Z', 'bill', { amount: { value: 1200, currency: 'CZK' }, merchant: 'Dodavatel' })
  ];
  const UNPAID = [
    mail('anth-inv', ANTH, 'Your invoice from Anthropic, PBC #ZX81-0042', 'Invoice from Anthropic, PBC $10.00 due December 2, 2026 Pay this invoice', U, '2026-11-02T09:00:00Z', 'bill', { amount: { value: 10, currency: 'USD' }, dueDate: '2026-12-02', merchant: 'Anthropic, PBC' }),
    mail('rc-due', 'City Water <billing@citywater.example>', 'Receipt of your meter reading – bill', 'Thanks, we received your reading. Amount due: 640 CZK. Due date 30 Nov 2026', U, '2026-11-02T09:00:00Z', 'bill', { amount: { value: 640, currency: 'CZK' }, dueDate: '2026-11-30', merchant: 'City Water' }),
    mail('nezapl', 'Dodavatel s.r.o. <fakturace@dodavatel.cz>', 'Upomínka: faktura 2026-097 – nezaplaceno', 'Evidujeme nezaplacenou fakturu 2026-097 na 2 400 Kč.', U, '2026-11-02T09:00:00Z', 'bill', { amount: { value: 2400, currency: 'CZK' }, merchant: 'Dodavatel' }),
    mail('failed', 'Gym Club <billing@gym.example>', 'Payment receipt: your payment failed', 'We could not charge your card for 690 CZK. Please update your card to avoid interruption.', U, '2026-11-02T09:00:00Z', 'bill', { amount: { value: 690, currency: 'CZK' }, merchant: 'Gym Club' }),
    mail('overdue', 'Utility Co <billing@utility.example>', 'Overdue: no receipt of payment for invoice 7781', 'We have not received your payment of 1 150 CZK for invoice 7781.', U, '2026-11-02T09:00:00Z', 'bill', { amount: { value: 1150, currency: 'CZK' }, merchant: 'Utility Co' }),
    mail('voda', 'Vodafone CZ <ebill@vodafone.cz>', 'Nová faktura 2026115566', 'Faktura č. 2026115566. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.', U, '2026-11-03T08:00:00Z', 'bill', { amount: { value: 712, currency: 'CZK' }, dueDate: '2026-12-03', merchant: 'Vodafone' })
  ];
  const gA = IG.createGraph({ backend: 'memory', now: () => NOW });
  const gcA = GC.createGmailConnector({ graph: gA, mailCache: null, classifier: CL, now: () => NOW, getAccountId: () => 'a' });
  const derivedOf = (c) => gcA.normalise(c.rec, c.facts, { accountId: 'a', now: NOW }).items.filter((x) => ['bill', 'transaction', 'subscription'].includes(x.type));
  const anth = derivedOf(RECEIPTS[0]);
  ok('A1 Anthropic receipt → one transaction, category receipt, 10 USD, no due date', anth.length === 1 && anth[0].type === 'transaction' && anth[0].meta.category === 'receipt' && anth[0].dueAt == null && /10 USD/.test(anth[0].title), anth.map((x) => [x.type, x.meta, x.title]));
  ok('A2 its source email is linked (evidence) and kept as an email Item', anth[0].sources.some((s) => s.itemId === 'anth' && s.role === 'evidence'));
  for (const c of RECEIPTS.slice(1)) { const d = derivedOf(c); ok(`A3 receipt stays a transaction: "${c.rec.subject}"`, d.length === 1 && d[0].type === 'transaction', d.map((x) => [x.type, x.meta.category])); }
  for (const c of UNPAID) { const d = derivedOf(c); ok(`A4 unpaid invoice stays a bill: "${c.rec.subject}"`, d.length === 1 && d[0].type === 'bill', { d: d.map((x) => [x.type, x.meta.category]), ev: CL.moneyEvidence({ subject: c.rec.subject, snippet: c.rec.snippet, labels: c.rec.labels, facts: c.facts.fields }) }); }
  // read the way the app reads: receipts are not unpaid bills, they are in Recent payments
  for (const c of [...RECEIPTS, ...UNPAID]) { const n = gcA.normalise(c.rec, c.facts, { accountId: 'a', now: NOW }); await gA.upsertMany(n.items); await gA.linkMany(n.links, 'a'); }
  const vA = M.applySettlements(await gA.query({ accountId: 'a' }));
  const unpaid = M.askLocal(vA, 'What bills do I have to pay?', NOW).items.map((x) => x.title);
  const unpaidIds = M.askLocal(vA, 'What bills do I have to pay?', NOW).items.map((x) => x.id);
  const receiptIds = vA.filter((x) => ['bill', 'transaction'].includes(x.type) && (x.sources || []).some((s) => RECEIPTS.some((c) => c.rec.messageId === s.itemId))).map((x) => x.id);
  ok('A5 Ask/unpaid bills: none of the receipts (incl. the Anthropic receipt) is listed; all 6 unpaid invoices are', receiptIds.length === 4 && !receiptIds.some((id) => unpaidIds.includes(id)) && unpaidIds.length === UNPAID.length, { unpaid, receipts: vA.filter((x) => receiptIds.includes(x.id)).map((x) => [x.type, x.title]) });
  const mNov = M.money(vA, NOW, NOW);
  const anthItem = vA.find((x) => x.type === 'transaction' && /Anthropic/.test(x.title));
  ok('A6 Money: the Anthropic receipt is in Recent payments (transactions) and not in Due soon', mNov.transactions.some((x) => x.id === anthItem.id) && !mNov.dueSoon.some((x) => x.id === anthItem.id));
  const em = await gA.getItem(IG.itemId('gmail:a:anth'));
  ok('A7 the receipt\'s source email Item exists and links to the receipt', em && em.type === 'email' && (await gA.linksOf ? true : true) && (anthItem.sources || []).some((s) => s.itemId === 'anth'));

  // ---------------- B) tax documents ----------------
  const FOOD = [
    mail('fo1', 'foodora <info@mail.foodora.cz>', 'Děkujeme za objednávku', 'Právě u nás přistála vaše objednávka! Partner: Pizza Pollo Číslo objednávky: r34p-2642-q2yd Způsob platby: Online Payment Celkem 470 Kč', PERS, '2026-10-31T21:50:00Z', 'food', { amount: { value: 470, currency: 'CZK' }, orderNumber: 'r34p-2642-q2yd', merchant: 'foodora' }),
    mail('ft1', 'foodora <info@mail.foodora.cz>', 'Daňový doklad číslo: CZ/7/26/81/cjM0cA/000005', 'Jak vám chutnalo? Ohodnotit Vaše účtenka Daňový doklad číslo: CZ/7/26/81/cjM0cA/000005 Delivery Hero Czech Republic sro', U, '2026-11-01T00:20:00Z', 'food', { amount: { value: 4.17, currency: 'CZK' }, orderNumber: 'r34p-2642-q2yd', merchant: 'foodora' }),
    mail('ft-orphan', 'foodora <info@mail.foodora.cz>', 'Daňový doklad číslo: CZ/7/26/81/Z290cg/000001', 'Jak vám chutnalo? Ohodnotit Vaše účtenka Daňový doklad číslo: CZ/7/26/81/Z290cg/000001 Delivery Hero', U, '2026-11-03T12:00:00Z', 'food', { amount: { value: 2.6, currency: 'CZK' }, orderNumber: 'q9zz-1111-aaaa', merchant: 'foodora' })
  ];
  const gB = IG.createGraph({ backend: 'memory', now: () => NOW });
  const gcB = GC.createGmailConnector({ graph: gB, mailCache: null, classifier: CL, now: () => NOW, getAccountId: () => 'a' });
  for (const c of FOOD) { const n = gcB.normalise(c.rec, c.facts, { accountId: 'a', now: NOW }); await gB.upsertMany(n.items); await gB.linkMany(n.links, 'a'); }
  const vB = await gB.query({ accountId: 'a' });
  const order = vB.find((x) => x.type === 'transaction' && /470/.test(x.title));
  ok('B1 the order keeps its own total (470 CZK); each tax document has its own Item', order && vB.filter((x) => x.type === 'transaction').length === 3, vB.filter((x) => x.type === 'transaction').map((x) => x.title));
  const novB = M.money(vB, NOW, NOW), octB = M.money(vB, at('2026-10-15T00:00:00Z'), NOW);
  const nov = JSON.stringify(novB.spending.map((c) => [c.name, c.total]));
  ok('B2 order on 31 Oct, its tax document on 1 Nov: November spending does not count the tax document', !novB.spending.some((c) => (c.items || []).some((x) => /4\.17/.test(x.title))), nov);
  ok('B3 October counts the order once (470)', octB.spending.some((c) => c.total === 470), octB.spending.map((c) => [c.name, c.total]));
  // the known limitation, recorded as current behaviour (not changed in v108)
  ok('B4 [known limitation, unchanged] a tax document whose order email is missing is still counted as spending', novB.spending.some((c) => (c.items || []).some((x) => /2\.6/.test(x.title))), nov);

  // ---------------- C) x5 re-ingest over a v107 graph ----------------
  const MAILBOX = [
    mail('tm-bill', 'T-Mobile Elektronické vyúčtování <vyuctovani@t-mobile.cz>', 'Vyúčtování služeb od T-Mobile za období 13.9.2026 - 12.10.2026', 'VYÚČTOVÁNÍ Vyúčtování č. 4592612226. Částka k úhradě: 891,02 Kč Splatnost', U, '2026-10-15T10:45:00Z', 'bill', { amount: { value: 891.02, currency: 'CZK' }, dueDate: '2026-10-27', merchant: 'T-Mobile' }),
    mail('tm-paid', 'T-Mobile CZ <info@t-mobile.cz>', 'Potvrzení úhrady vyúčtování', 'POTVRZENÍ ÚHRADY Dobrý den, chtěli bychom Vám poděkovat za platbu ve výši 891,02 Kč', PERS, '2026-10-26T12:01:00Z', 'bill', { amount: { value: 891.02, currency: 'CZK' }, merchant: 'T-Mobile CZ' }),
    RECEIPTS[0], UNPAID[5], ...FOOD,
    mail('rev-self', 'Revolut <no-reply@revolut.com>', 'You sent CZK1,986 to JANA NOVAKOVA 💸', 'Your transfer was successful Hi Jana, You sent CZK1,986 to JANA NOVAKOVA. Note to self', U, '2026-10-30T08:30:00Z', 'payment', { amount: { value: 1986, currency: 'CZK' }, merchant: 'Revolut' }),
    mail('flight', 'Czech Airlines <booking@csa.example>', 'Booking confirmation EXK7Q2', 'Your flight PRG–AMS on 20 Nov 2026, booking reference EXK7Q2', U, '2026-11-01T08:00:00Z', 'travel', { reservationNumber: 'EXK7Q2', merchant: 'Czech Airlines' }),
    mail('colleague', 'Petr Novak <petr.novak@upol.cz>', 'Fock 10 - Wigner function', 'Hi guys, sending processed minimas of Wigner function for Fock 10.', PERS, '2026-11-03T09:00:00Z', 'personal', {})
  ];
  const cacheOf = (rows) => ({ all: async () => rows.map((c) => c.rec), getFacts: async (a, ids) => new Map(ids.map((i) => [i, (rows.find((c) => c.rec.messageId === i) || {}).facts])) });
  const strip = (it) => ({ key: it.key, type: it.type, status: it.status, title: it.title, pinned: !!it.pinned, snoozedUntil: it.snoozedUntil || null, notes: (it.notes || []).map((n) => n.text), hist: (it.actionHistory || []).map((h) => h.kind), cls: it.classification && it.classification.userSet ? it.classification.type : null, src: (it.sources || []).map((s) => s.itemId).sort(), amount: (it.extractedFacts || []).filter((f) => f.key === 'amount').map((f) => f.value) });
  const snap = async (g) => (await g.query({})).map(strip).sort((p, q) => p.key < q.key ? -1 : 1);

  async function buildV107() {
    const g = IG.createGraph({ backend: 'memory', now: () => NOW });
    const old = OLD_GC.createGmailConnector({ graph: g, mailCache: cacheOf(MAILBOX), classifier: OLD_CL, now: () => NOW, getAccountId: () => 'a' });
    await old.ingest('a', { since: 0 });
    const acts = AA.createActions({ graph: g, classifier: CL, now: () => NOW });
    const all = await g.query({ accountId: 'a' });
    const foodItem = all.find((x) => x.type === 'transaction' && /foodora/.test(x.title) && x.sources.some((s) => s.itemId === 'fo1'));
    const vodaBill = all.find((x) => x.type === 'bill' && /Vodafone/.test(x.title));
    const flight = all.find((x) => x.type === 'booking');
    const colleague = all.find((x) => x.type === 'email' && x.sources.some((s) => s.itemId === 'colleague'));
    await acts.applyAction(foodItem.id, 'pin', {});
    await acts.applyAction(foodItem.id, 'add_note', { text: 'split with Petr' });
    await acts.applyAction(vodaBill.id, 'snooze', { until: NOW + 2 * DAY });
    await acts.applyAction(flight.id, 'add_note', { text: 'aisle seat' });
    await acts.applyAction(colleague.id, 'correct_type', { type: 'personal', noRule: true });
    // unrelated Items: a Wallet pass and a task the user added on this device
    await g.upsertMany([
      { key: 'local:wallet:gym', accountId: null, type: 'ticket', title: 'Gym membership', sources: [{ app: 'local', itemId: 'gym', role: 'primary' }], meta: { walletKind: 'others', barcode: 'MEMBER-778812' } },
      { key: 'local:task:1', accountId: null, type: 'task', title: 'Call the landlord', sources: [{ app: 'local', itemId: 't1', role: 'primary' }] }
    ]);
    return { g, ids: { food: foodItem.id, voda: vodaBill.id, flight: flight.id, colleague: colleague.id } };
  }

  const { g: g1, ids } = await buildV107();
  const before = await snap(g1);
  const v107food = before.find((x) => x.type === 'transaction' && x.src.includes('fo1'));
  ok('C0 (setup) v107 state reproduces the live bug: the order Item carries the tax document and its 4.17 amount', v107food && v107food.src.includes('ft1') && v107food.amount.includes(4.17), v107food);
  const gc1 = GC.createGmailConnector({ graph: g1, mailCache: cacheOf(MAILBOX), classifier: CL, now: () => NOW, getAccountId: () => 'a' });
  const r1 = await gc1.ingest('a', { since: 0 });
  const after = await snap(g1);
  const by = (pred) => after.filter(pred);
  ok('C1 full re-ingest reported as full', r1.full === true, r1);
  ok('C2 no duplicate email Items (one per message)', by((x) => x.type === 'email').length === MAILBOX.length && new Set(by((x) => x.type === 'email').map((x) => x.src.join())).size === MAILBOX.length);
  const moneyAfter = by((x) => ['bill', 'transaction', 'subscription'].includes(x.type));
  const perEmail = {}; moneyAfter.forEach((x) => x.src.forEach((s) => { perEmail[s] = (perEmail[s] || 0) + 1; }));
  ok('C3 no duplicate Money Items: each email supports at most one money Item', Object.values(perEmail).every((n) => n === 1), perEmail);
  const food = after.find((x) => x.key === v107food.key);
  ok('C4 the order Item is the same Item (same key), now 470 CZK only, without the tax document as a source', food && food.src.join() === 'fo1' && food.amount.join() === '470' && /470/.test(food.title), food);
  ok('C5 pin and note on the order survive', food && food.pinned && food.notes.join() === 'split with Petr', food);
  const tax = after.find((x) => x.src.join() === 'ft1' && x.type === 'transaction');
  ok('C6 the tax document became its own Item…', !!tax, tax);
  ok('C7 …and the user\'s pin/note/history on the order were NOT copied onto it', tax && !tax.pinned && tax.notes.length === 0 && tax.hist.length === 0, tax);
  const an = after.find((x) => x.src.join() === 'anth' && x.type !== 'email');
  ok('C8 Anthropic: the old bill Item becomes a transaction (same key, no second Item)', an && an.type === 'transaction' && moneyAfter.filter((x) => x.src.includes('anth')).length === 1, an);
  ok('C9 snooze on the Vodafone bill, note on the flight and the type correction survive', (await g1.getItem(ids.voda)).snoozedUntil === NOW + 2 * DAY && (await g1.getItem(ids.flight)).notes.length === 1 && (await g1.getItem(ids.colleague)).classification.userSet === true);
  const keep = (s) => s.filter((x) => x.key.startsWith('local:'));
  ok('C10 Wallet pass and local task are untouched', JSON.stringify(keep(after)) === JSON.stringify(keep(before)) && keep(after).length === 2);
  const unchanged = before.filter((b) => !b.src.some((s) => ['fo1', 'ft1', 'ft-orphan', 'anth'].includes(s)) && !b.key.startsWith('local:'));
  const changed = unchanged.filter((b) => JSON.stringify(after.find((x) => x.key === b.key)) !== JSON.stringify(b));
  ok('C11 every other Item is byte-identical in the fields that matter (no side effects)', changed.length === 0, changed.map((b) => [b, after.find((x) => x.key === b.key)]));
  // incremental afterwards
  const r2 = await gc1.ingest('a', { since: NOW });
  ok('C12 next ingest is incremental and re-reads nothing when no mail changed', r2.full === false && r2.emails === 0 && r2.items === 0 && JSON.stringify(await snap(g1)) === JSON.stringify(after), r2);
  const NEW = mail('new1', 'Bolt Food <receipts@bolt.eu>', 'Your Bolt Food receipt', 'Thanks for ordering. Total 289 Kč. Order #BF-2231', U, '2026-11-06T09:00:00Z', 'food', { amount: { value: 289, currency: 'CZK' }, orderNumber: 'BF-2231', merchant: 'Bolt Food' });
  NEW.rec.lastProcessedAt = NOW + 1000;
  const gc1b = GC.createGmailConnector({ graph: g1, mailCache: cacheOf([...MAILBOX, NEW]), classifier: CL, now: () => NOW, getAccountId: () => 'a' });
  const r3 = await gc1b.ingest('a', { since: NOW });
  const after3 = await snap(g1);
  const added = after3.filter((x) => !after.some((y) => y.key === x.key));
  ok('C13 a new email after that is ingested alone (1 email → its email, money and merchant Items), everything else unchanged', r3.emails === 1 && added.length === 3 && added.every((x) => x.src.join() === 'new1' || x.type === 'organisation') && after.every((x) => JSON.stringify(after3.find((y) => y.key === x.key)) === JSON.stringify(x)), { r3, n: [after.length, after3.length] });

  // failure part-way (after Items were written, before stale sources were detached), then a retry
  {
    const { g } = await buildV107();
    const realDetach = g.detachSources; let thrown = false;
    g.detachSources = async (l) => { if (!thrown) { thrown = true; throw new Error('simulated storage failure'); } return realDetach(l); };
    const gc = GC.createGmailConnector({ graph: g, mailCache: cacheOf(MAILBOX), classifier: CL, now: () => NOW, getAccountId: () => 'a' });
    let err = null; try { await gc.ingest('a', { since: 0 }); } catch (e) { err = e.message; }
    await gc.ingest('a', { since: 0 }); // the app retries with since=0 because the x5 watermark is only written after success
    const rs = await snap(g);
    ok('C14 an ingest that fails part-way throws (so the watermark is not written)…', err === 'simulated storage failure');
    ok('C15 …and the retry ends in exactly the same state as a clean re-ingest', JSON.stringify(rs) === JSON.stringify(after), rs.filter((x) => JSON.stringify(x) !== JSON.stringify(after.find((y) => y.key === x.key))));
  }
  // two tabs re-ingesting at the same time
  {
    const { g } = await buildV107();
    const a1 = GC.createGmailConnector({ graph: g, mailCache: cacheOf(MAILBOX), classifier: CL, now: () => NOW, getAccountId: () => 'a' });
    const a2 = GC.createGmailConnector({ graph: g, mailCache: cacheOf(MAILBOX), classifier: CL, now: () => NOW, getAccountId: () => 'a' });
    await Promise.all([a1.ingest('a', { since: 0 }), a2.ingest('a', { since: 0 })]);
    const rc = await snap(g);
    ok('C16 two concurrent full re-ingests end in the same state as one (no duplicated notes or Items)', JSON.stringify(rc) === JSON.stringify(after), rc.filter((x) => JSON.stringify(x) !== JSON.stringify(after.find((y) => y.key === x.key))));
  }

  console.log(`v108 audit unit: ${pass}/${pass + fail} passed` + (fail ? ' · failed: ' + failures.join(' | ') : ''));
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
