/**
 * v107 money fixes, from cases seen on a real mailbox (anonymised; amounts, wording and labels kept):
 * promotions with a price are not purchases; bank notices quoting a figure are not payments; a colleague's email is not a bill;
 * a payment confirmation is a payment that settles the bill (never a second bill); transfers between your own accounts are
 * not spending; Items are dated by their email, not by when Daylight read it. Genuine bills, receipts and subscriptions still work.
 * Run: node tests/money-evidence-unit.js
 */
'use strict';
const path = require('path');
global.window = globalThis;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'mail-dates.js'));
const IG = require(path.join(ROOT, 'graph/item-graph.js'));
const CL = require(path.join(ROOT, 'classification/classifier.js'));
const GC = require(path.join(ROOT, 'connectors/gmail-connector.js'));
const M = require(path.join(ROOT, 'ui/v2-model.js'));
const DAY = 86400000, NOW = Date.UTC(2026, 10, 6, 10, 0, 0), at = (s) => Date.parse(s);
let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); };

const U = ['INBOX', 'CATEGORY_UPDATES'], P = ['INBOX', 'CATEGORY_PROMOTIONS'], PERS = ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'];
const mail = (id, from, subject, snippet, labels, date, category, fields) => ({ rec: { messageId: id, threadId: 't' + id, from, subject, snippet, labels, internalDate: at(date), category, status: 'done' }, facts: { fields: fields || {} } });
const CASES = [
  mail('temu1', 'Temu <temu@eu.temuemail.com>', 'The UNDER 46 Kč zone is baaack...', 'BUT NOT FOR LONG!!', P, '2026-11-04T20:16:00Z', 'receipt', { amount: { value: 46, currency: 'CZK' }, merchant: 'Temu' }),
  mail('temu2', 'Temu <temu@eu.temuemail.com>', 'Pick items under 46 Kč, look at these things', 'Enjoy your low price purchase!', P, '2026-11-05T22:16:00Z', 'receipt', { amount: { value: 46, currency: 'CZK' }, merchant: 'Temu' }),
  mail('temu3', 'Temu <temu@eu.temuemail.com>', '4 gifts with your purchase', 'Thank you for your support!', P, '2026-11-04T17:16:00Z', 'receipt', { amount: { value: 165, currency: 'CZK' }, merchant: 'Temu' }),
  mail('lek1', 'Lékárna.cz <info@lekarna.cz>', '🎁 Využijte své benefity na maximum', 'Vyberte si, co vám udělá radost, a zaplaťte svými zaměstnaneckými benefity', P, '2026-10-23T16:07:00Z', 'bill', { amount: { value: 1099, currency: 'CZK' }, merchant: 'Lékárna.cz' }),
  mail('rev-org', 'Revolut <no-reply@revolut.com>', 'Planned corporate reorganisation of Revolut Bank UAB', 'The upcoming corporate reorganisation Hi Jana, We are writing to inform you, as a depositor of Revolut Bank UAB, about an ongoing corporate reorganisation', U, '2026-10-30T15:44:00Z', 'payment', { amount: { value: 100000, currency: 'EUR' }, merchant: 'Revolut' }),
  mail('rev-fee', 'Revolut <no-reply@revolut.com>', 'Trade with flat CZK25 commission', "We've simplified trading fees Hi Jana, Investing shouldn't be confusing, so we've made it easier to understand our trading fees.", U, '2026-11-04T12:07:00Z', 'receipt', { amount: { value: 25, currency: 'CZK' }, merchant: 'Revolut' }),
  mail('rev-gst', 'Revolut <no-reply@revolut.com>', 'Important update on GST', "We're delisting GST Hi Jana, We're writing to let you know that we'll be delisting GST from our crypto offering. You can no longer buy GST", U, '2026-10-21T14:04:00Z', 'payment', { amount: { value: 0.01, currency: 'CZK' }, merchant: 'Revolut' }),
  mail('rev-self1', 'Revolut <no-reply@revolut.com>', 'You sent CZK1,986 to JANA NOVAKOVA 💸', 'Your transfer was successful Hi Jana, You sent CZK1,986 to JANA NOVAKOVA. You can find the details below: To JANA NOVAKOVA Sent CZK1,986 Note to self', U, '2026-10-30T08:30:00Z', 'payment', { amount: { value: 1986, currency: 'CZK' }, merchant: 'Revolut' }),
  mail('rev-other', 'Revolut <no-reply@revolut.com>', 'You sent CZK500 to Petr Dvorak 💸', 'Your transfer was successful Hi Jana, You sent CZK500 to Petr Dvorak. You can find the details below', U, '2026-11-02T08:30:00Z', 'payment', { amount: { value: 500, currency: 'CZK' }, merchant: 'Revolut' }),
  mail('tm-bill', 'T-Mobile Elektronické vyúčtování <vyuctovani@t-mobile.cz>', 'Vyúčtování služeb od T-Mobile za období 13.9.2026 - 12.10.2026', 'VYÚČTOVÁNÍ V příloze posíláme Vyúčtování č. 4592612226 za období 13. 9. – 12. 10. 2026. Částka k úhradě: 891,02 Kč Splatnost', U, '2026-10-15T10:45:00Z', 'bill', { amount: { value: 891.02, currency: 'CZK' }, dueDate: '2026-10-27', merchant: 'T-Mobile' }),
  mail('tm-paid', 'T-Mobile CZ <info@t-mobile.cz>', 'Potvrzení úhrady vyúčtování', 'Pokud se Vám e-mail nezobrazuje správně, klikněte zde. POTVRZENÍ ÚHRADY Dobrý den, chtěli bychom Vám poděkovat za platbu ve výši 891,02 Kč', PERS, '2026-10-26T12:01:00Z', 'bill', { amount: { value: 891.02, currency: 'CZK' }, merchant: 'T-Mobile CZ' }),
  mail('fock', 'Petr Novak <petr.novak@upol.cz>', 'Fock 10 - Wigner function', 'Hi guys, sending processed minimas of Wigner function for Fock 10 measured as a parity of population after displacement.', PERS, '2026-11-03T09:00:00Z', 'bill', {}),
  mail('wise-add', 'Wise <noreply@wise.com>', 'Money added to your account', "Wise. Your account for the world's money", U, '2026-10-08T09:00:00Z', 'payment', { amount: { value: 6100, currency: 'CZK' }, merchant: 'Wise' }),
  mail('t212', 'Trading 212 <noreply@trading212.com>', '🕘 Your withdrawal request has been received', "We're processing your CZK 4958.72 withdrawal", U, '2026-10-20T09:00:00Z', 'payment', { amount: { value: 4958.72, currency: 'CZK' }, merchant: 'Trading 212' }),
  mail('wise-sent', 'Wise <noreply@wise.com>', 'Transfer sent (#2419666090)', "Wise. Your account for the world's money", U, '2026-10-08T10:00:00Z', 'receipt', { amount: { value: 6122.4, currency: 'CZK' }, merchant: 'Wise' }),
  mail('points', 'SBI Rewardz <noreply@alerts.sbi.example>', 'E-statement: You have 1374 Points worth Rs.344 as on 30, September 2026', 'To ensure that you receive our updates & offers in your inbox', U, '2026-10-31T09:00:00Z', 'subscription', { amount: { value: 344, currency: 'INR' }, merchant: 'SBI Rewardz' }),
  // genuine money mail must still produce Items
  mail('voda', 'Vodafone CZ <ebill@vodafone.cz>', 'Nová faktura 2026115566', 'Faktura č. 2026115566. Celkem k úhradě 712 Kč, splatnost 3. 12. 2026.', U, '2026-11-03T08:00:00Z', 'bill', { amount: { value: 712, currency: 'CZK' }, dueDate: '2026-12-03', merchant: 'Vodafone' }),
  mail('wolt', 'Wolt <info@wolt.com>', 'Your order from Burger Bar', 'Thanks for your order! Total 299 Kč. Order #A77', P, '2026-11-02T19:00:00Z', 'food', { amount: { value: 299, currency: 'CZK' }, orderNumber: 'A77', merchant: 'Wolt' }),
  mail('spot', 'Spotify <no-reply@spotify.com>', 'Your Spotify Premium receipt', 'Thanks for your payment of 199 Kč for Spotify Premium. Your subscription renews on 2 Dec.', U, '2026-11-02T06:00:00Z', 'subscription', { amount: { value: 199, currency: 'CZK' }, merchant: 'Spotify' }),
  // v108: a receipt is never a bill; tax documents for a food order do not replace the order total
  mail('anth', 'Anthropic, PBC <invoice+statements@mail.anthropic.com>', 'Your receipt from Anthropic, PBC #2615-9581-3414', 'Your receipt from Anthropic, PBC #2615-9581-3414', U, '2026-11-02T09:00:00Z', 'bill', { amount: { value: 10, currency: 'USD' }, merchant: 'Anthropic, PBC' }),
  mail('food-order', 'foodora <info@mail.foodora.cz>', 'Děkujeme za objednávku', 'Právě u nás přistála vaše objednávka! Podrobnosti k objednávce Partner: Pizza Pollo Číslo objednávky: R34P-2642-Q2YD Způsob platby: Online Payment Celkem 470 Kč', PERS, '2026-10-12T14:13:00Z', 'food', { amount: { value: 470, currency: 'CZK' }, orderNumber: 'R34P-2642-Q2YD', merchant: 'foodora' }),
  mail('food-tax', 'foodora <info@mail.foodora.cz>', 'Daňový doklad číslo: CZ/7/26/81/cjM0cA/000005', 'Jak vám chutnalo? Ohodnotit Vaše účtenka Daňový doklad číslo: CZ/7/26/81/cjM0cA/000005 Delivery Hero Czech Republic sro', U, '2026-10-12T15:00:00Z', 'food', { amount: { value: 4.17, currency: 'CZK' }, orderNumber: 'r34p-2642-q2yd', merchant: 'foodora' }),
  mail('pp', 'PayPal <service@paypal.cz>', 'Receipt for your payment to Alza.cz', 'You paid 1 490,00 Kč to Alza.cz. Transaction ID 9XK2', U, '2026-11-01T10:00:00Z', 'payment', { amount: { value: 1490, currency: 'CZK' }, merchant: 'Alza.cz' })
];
(async () => {
  const g = IG.createGraph({ backend: 'memory', now: () => NOW });
  const gc = GC.createGmailConnector({ graph: g, mailCache: null, classifier: CL, now: () => NOW, getAccountId: () => 'a' });
  const derived = {}, emails = {};
  const all = [];
  for (const c of CASES) {
    const n = gc.normalise(c.rec, c.facts, { accountId: 'a', now: NOW });
    derived[c.rec.messageId] = n.items.filter((x) => ['bill', 'transaction', 'subscription'].includes(x.type));
    emails[c.rec.messageId] = n.items.find((x) => x.type === 'email');
    all.push(n);
  }
  const money = (id) => derived[id].map((x) => x.type + ':' + ((x.meta && x.meta.category) || ''));
  ok('promotions quoting a price are not purchases (Temu ×3)', ['temu1', 'temu2', 'temu3'].every((id) => derived[id].length === 0), ['temu1', 'temu2', 'temu3'].map(money));
  ok('a promotion is not a bill (Lékárna.cz benefits offer)', derived.lek1.length === 0, money('lek1'));
  ok('bank notices quoting a figure are not payments (reorganisation, fee change, delisting)', ['rev-org', 'rev-fee', 'rev-gst'].every((id) => derived[id].length === 0), ['rev-org', 'rev-fee', 'rev-gst'].map(money));
  ok('a transfer to yourself is a transfer, not spending', derived['rev-self1'].length === 1 && derived['rev-self1'][0].meta.category === 'transfer' && derived['rev-self1'][0].meta.ownTransfer === true, derived['rev-self1'].map((x) => x.meta));
  ok('money added to your account / a broker withdrawal are moves between your own accounts (recorded, not spending)', ['wise-add', 't212'].every((id) => derived[id].length === 1 && derived[id][0].meta.ownTransfer === true), ['wise-add', 't212'].map(money));
  ok('a bank transfer is recorded as a transfer, not as shopping', derived['wise-sent'].length === 1 && derived['wise-sent'][0].meta.category === 'transfer' && !derived['wise-sent'][0].meta.ownTransfer, money('wise-sent'));
  ok('loyalty points are not money', derived.points.length === 0, money('points'));
  ok('a transfer to another person stays a payment', derived['rev-other'].length === 1 && derived['rev-other'][0].meta.category === 'payment' && !derived['rev-other'][0].meta.ownTransfer);
  ok('the bill email is a bill with its due date', derived['tm-bill'].length === 1 && derived['tm-bill'][0].type === 'bill' && derived['tm-bill'][0].dueAt);
  ok('the payment confirmation is a payment (not a second bill to pay)', derived['tm-paid'].length === 1 && derived['tm-paid'][0].type === 'transaction' && derived['tm-paid'][0].meta.confirmsPayment === true, money('tm-paid'));
  ok('…and its email is not typed as an invoice to pay', emails['tm-paid'].classification.type !== 'invoice' && emails['tm-paid'].classification.action !== 'pay', emails['tm-paid'].classification);
  ok("a colleague's research email is not typed as a bill", !['invoice', 'receipt', 'financial'].includes(emails.fock.classification.type), emails.fock.classification);
  ok('promotion emails are typed as marketing, not receipts', ['temu1', 'temu3', 'lek1'].every((id) => emails[id].classification.type === 'marketing'), ['temu1', 'temu3', 'lek1'].map((id) => emails[id].classification.type));
  ok('genuine money mail still produces Items: bill, food order (even in Promotions with an order number), subscription, PayPal payment',
    derived.voda[0]?.type === 'bill' && derived.wolt[0]?.type === 'transaction' && derived.spot[0]?.type === 'subscription' && derived.pp[0]?.type === 'transaction', { voda: money('voda'), wolt: money('wolt'), spot: money('spot'), pp: money('pp') });
  ok('v108: "Your receipt from …" is a receipt (transaction), never an unpaid bill', derived.anth.length === 1 && derived.anth[0].type === 'transaction' && derived.anth[0].meta.category === 'receipt', money('anth'));
  ok('v108: a tax document gets its own Item and never shares its order\'s key', derived['food-tax'].length === 1 && derived['food-order'].length === 1 && derived['food-tax'][0].key !== derived['food-order'][0].key && derived['food-tax'][0].meta.taxDocFor, { o: derived['food-order'][0]?.key, t: derived['food-tax'][0]?.key });
  ok('derived Items are dated by their email, not by ingest time', derived['tm-bill'][0].createdAt === at('2026-10-15T10:45:00Z') && derived['rev-self1'][0].createdAt === at('2026-10-30T08:30:00Z'));

  // store in the graph, link like the connector does, then read the way the app does
  for (const n of all) { await g.upsertMany(n.items); await g.linkMany(n.links, 'a'); }
  const items = await g.query({ accountId: 'a' });
  const view = M.applySettlements(items);
  const bill = view.find((x) => x.type === 'bill' && /T-Mobile/.test(x.title));
  ok('the T-Mobile bill shows as paid, settled by the confirmation email', bill && bill.status === 'done' && bill.meta.settledBy && view.find((x) => x.id === bill.meta.settledBy).meta.confirmsPayment, bill && { status: bill.status, meta: bill.meta });
  ok('nothing is written: the stored bill is unchanged (status open)', (await g.getItem(bill.id)).status === 'open');
  const ask = M.askLocal(view, 'What bills do I have to pay?', NOW);
  ok('Ask: only the Vodafone bill is unpaid; T-Mobile is not counted, not doubled', ask.items.length === 1 && /Vodafone/.test(ask.items[0].title), ask.text);
  const m = M.money(view, at('2026-11-01T00:00:00Z'), NOW);
  const spentNames = m.spending.flatMap((c) => c.items ? c.items.map((x) => x.title) : []);
  ok('November spending excludes own-account transfers and promotions', !m.spending.some((c) => /Temu|Revolut · 1986/.test(JSON.stringify(c))) && m.spending.length > 0, m.spending.map((c) => [c.name, c.total]));
  const oct = M.money(view, at('2026-10-01T00:00:00Z'), at('2026-10-31T23:00:00Z'));
  const octJson = JSON.stringify(oct.spending);
  ok('v108: October food counts the 470 CZK order once; the tax document is not added on top', /470/.test(octJson) && !/4\.17/.test(octJson), oct.spending.map((c) => [c.name, c.total]));
  ok('v108: the Anthropic receipt is not an unpaid bill in Ask', !M.askLocal(view, 'What bills do I have to pay?', NOW).items.some((x) => /Anthropic/.test(x.title)));
  // a bill the user reopened is not auto-settled
  const reopened = items.map((x) => x.id === bill.id ? Object.assign({}, x, { actionHistory: [{ kind: 'reopen', at: NOW }] }) : x);
  ok('a bill you reopened yourself is never auto-settled', M.applySettlements(reopened).find((x) => x.id === bill.id).status === 'open');
  // re-ingest with an older Item (dated by first ingest) moves its date back to the email date
  const g2 = IG.createGraph({ backend: 'memory', now: () => NOW });
  await g2.upsertMany([{ key: derived.voda[0].key, accountId: 'a', type: 'bill', title: 'old', createdAt: NOW, sources: derived.voda[0].sources }]);
  await g2.upsertMany([derived.voda[0]]);
  ok('re-ingest corrects an older Item dated by the first ingest to its email date', (await g2.query())[0].createdAt === at('2026-11-03T08:00:00Z'));

  // re-ingest on a device that already holds v106 Items: wrong ones disappear, the confirmation stops being a bill,
  // dates move to the email date, and what the user did is kept
  {
    const g3 = IG.createGraph({ backend: 'memory', now: () => NOW });
    const pick = ['temu1', 'tm-bill', 'tm-paid', 'rev-self1'].map((id) => CASES.find((c) => c.rec.messageId === id));
    const oldItems = [
      { key: 'money:a:eu.temuemail.com:46:2026-11-04', accountId: 'a', type: 'transaction', title: 'Temu · 46 CZK', createdAt: NOW, sources: [{ app: 'gmail', accountId: 'a', itemId: 'temu1', role: 'evidence' }], meta: { category: 'receipt' } },
      { key: 'money:a:t-mobile.cz:891.02:2026-10-26', accountId: 'a', type: 'bill', title: 'T-Mobile CZ · 891.02 CZK', createdAt: NOW, status: 'open', sources: [{ app: 'gmail', accountId: 'a', itemId: 'tm-paid', role: 'evidence' }], meta: { category: 'bill' } },
      { key: 'money:a:t-mobile.cz:2026-10-27', accountId: 'a', type: 'bill', title: 'T-Mobile · 891.02 CZK', createdAt: NOW, status: 'open', snoozedUntil: NOW + DAY, sources: [{ app: 'gmail', accountId: 'a', itemId: 'tm-bill', role: 'evidence' }], meta: { category: 'bill' } }
    ];
    await g3.upsertMany(oldItems);
    { const it = (await g3.query({ accountId: 'a' })).find((x) => x.key === 'money:a:t-mobile.cz:2026-10-27'); await g3.putItem(Object.assign({}, it, { snoozedUntil: NOW + DAY })); } // the user snoozed it (actions write the stored Item)
    const facts = new Map(pick.map((c) => [c.rec.messageId, c.facts]));
    const cache = { all: async () => pick.map((c) => Object.assign({ lastProcessedAt: NOW }, c.rec)), getFacts: async (a, ids) => new Map(ids.map((i) => [i, facts.get(i)])) };
    const gc3 = GC.createGmailConnector({ graph: g3, mailCache: cache, classifier: CL, now: () => NOW, getAccountId: () => 'a' });
    const r = await gc3.ingest('a', { since: 0 });
    const after = await g3.query({ accountId: 'a' });
    const byKey = (k) => after.find((x) => x.key === k);
    ok('re-ingest: the Temu promotion "purchase" is removed', !byKey('money:a:eu.temuemail.com:46:2026-11-04'), r);
    ok('re-ingest: the confirmation is now a payment, not a bill', byKey('money:a:t-mobile.cz:891.02:2026-10-26') && byKey('money:a:t-mobile.cz:891.02:2026-10-26').type === 'transaction');
    const tb = byKey('money:a:t-mobile.cz:2026-10-27');
    ok('re-ingest: the real bill keeps your snooze and is dated by its email', tb && tb.snoozedUntil === NOW + DAY && tb.createdAt === at('2026-10-15T10:45:00Z'), tb && { snoozedUntil: tb.snoozedUntil, createdAt: tb.createdAt });
    ok('re-ingest: after reading, only real bills are unpaid (T-Mobile settled)', M.askLocal(M.applySettlements(after), 'What bills do I have to pay?', NOW).items.length === 0);
  }
  console.log(`Money evidence unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
