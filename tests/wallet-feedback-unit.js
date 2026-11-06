/** v112 (found in real mail): review / feedback requests after a stay, trip, visit or purchase ("How was your stay?",
 *  "Rate your recent purchase") are engagement mail — never a booking, ticket, Wallet pass, money record or deadline.
 *  Genuine confirmations, reservations, check-in instructions, cancellations, receipts, tickets and boarding passes stay
 *  what they are, even when they also ask for feedback. Synthetic data only.
 * Run: node tests/wallet-feedback-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const ROOT = path.resolve(__dirname, '..');
['mail-dates.js', 'gmail-config.js', 'gmail-cache.js', 'graph/item-graph.js', 'classification/user-rules.js', 'classification/classifier.js', 'connectors/gmail-connector.js', 'connectors/local-connector.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis, IG = W.DaylightItemGraph, C = W.DaylightClassifier, MC = W.DaylightMailCache, M = require(path.join(ROOT, 'ui/v2-model.js'));
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 600))); };
const NOW = Date.UTC(2026, 10, 6, 10);
const past = [{ kind: 'travel', date: '2026-11-01', quote: 'check-in 1 Nov' }, { kind: 'travel', date: '2026-11-03', quote: 'check-out 3 Nov' }];
const future = [{ kind: 'travel', date: '2026-11-20', quote: 'check-in 20 Nov' }];
const HOTEL = 'Booking.com <noreply@booking.com>', SHOP = 'Shop <orders@shop.example>', AIR = 'Airline <no-reply@air.example>';
const cls = (o) => C.classify(Object.assign({ from: HOTEL, labels: ['INBOX'], pipelineCategory: 'travel', facts: { reference: '4567890123' }, keyDates: [] }, o), { now: NOW });

(async () => {
  // ---------- classification table ----------
  const FEEDBACK = [
    ['How was your stay?', 'Tell us about your stay at Hotel Praha (booking 4567890123).', past],
    ['Rate your recent hotel experience', 'Your stay 1–3 Nov. Booking number 4567890123', past],
    ['Leave us a review', 'It only takes a minute', []],
    ['Tell us about your visit', '', past],
    ['How did you enjoy your trip?', '', []],
    ['Review your recent booking', 'Booking number 4567890123', past],
    ['Share your experience', '', []],
    ['Rate your recent purchase', 'Order 778899 – how would you rate it?', [], { from: SHOP, pipelineCategory: 'receipt', facts: { orderNumber: '778899', amount: { value: 499, currency: 'CZK' } } }],
    ["We'd love your feedback", 'Your recent stay', past],
    ['Jak se vám líbil pobyt v Hotelu Praha?', 'Ohodnoťte svůj pobyt', past],
    ['Wie war Ihr Aufenthalt?', 'Bewerten Sie Ihre Unterkunft', past],
    ['Hotel Praha', 'How was your stay? Leave a review and help other travellers.', past], // only the text asks; stay over
    ['Customer satisfaction survey', 'Take our 2-minute survey about your recent flight', [], { from: AIR }]
  ];
  FEEDBACK.forEach(([subject, snippet, keyDates, extra]) => { const r = cls(Object.assign({ subject, snippet, keyDates }, extra || {})); ok(`feedback: "${subject}" → feedback (${r.reasons[0]})`, r.type === 'feedback' && r.band === 'low', r.type); });
  const KEEP = [
    ['Your booking is confirmed', 'Confirmation number: 4567890123. Check-in 20 Nov from 14:00.', future, 'booking'],
    ['Hotel Praha – reservation 4567890123', 'Check-in 20 Nov 2026 14:00 · check-out 22 Nov · confirmation number 4567890123', future, 'booking'],
    ['Check-in instructions for your stay', 'Your room code and how to find us', future, 'booking'],
    ['Your booking has been cancelled', 'Booking 4567890123 is cancelled. Refund in 5 days.', future, 'booking'],
    ['Your e-ticket', 'Seat 12A. After your trip, leave us a review!', future, 'booking', { from: AIR }],
    ['Your boarding pass', 'Gate B12, boarding 06:40. Tell us how we did after your flight.', future, 'booking', { from: AIR }],
    ['Thanks for booking! Tell us how we did', 'Booking confirmed. Confirmation number 4567890123. Check-in 20 Nov.', future, 'booking'],
    ['Booking confirmation', 'How was your last stay? Your new reservation: 20–22 Nov', future, 'booking', { facts: { reference: '4567890123', schemaType: 'LodgingReservation' } }],
  ];
  KEEP.forEach(([subject, snippet, keyDates, want, extra]) => { const r = cls(Object.assign({ subject, snippet, keyDates }, extra || {})); ok(`not feedback: "${subject}" stays ${want}`, r.type === want, r.type); });
  {
    const r = cls({ from: SHOP, pipelineCategory: 'receipt', subject: 'Your receipt from Shop', snippet: 'Total 499 CZK. Rate your purchase!', facts: { orderNumber: '778899', amount: { value: 499, currency: 'CZK' } } });
    ok('not feedback: a receipt that also asks for a rating stays a receipt', r.type === 'receipt', r.type);
    const p = C.classify({ from: 'Jana Nováková <jana@fzu.cz>', subject: 'Could you review my manuscript?', snippet: 'Please leave a review of the draft by Friday', labels: ['INBOX'], pipelineCategory: 'personal', keyDates: [] }, { now: NOW });
    ok('not feedback: a person asking you to review something is still personal / work', p.type !== 'feedback', p.type);
    const n = C.classify({ from: 'Newsletter <news@shop.example>', subject: 'Our autumn collection', snippet: 'New arrivals', labels: ['CATEGORY_PROMOTIONS'], pipelineCategory: 'promotion', keyDates: [] }, { now: NOW });
    ok('not feedback: ordinary marketing stays marketing (no single-word trigger)', n.type === 'marketing', n.type);
    ok('the UI knows the type (label, Updates group, correction list)', M.TYPE_LABEL.feedback === 'Feedback request' && C.TYPES.includes('feedback') && C.LOW.has('feedback'));
  }

  // ---------- connector: what a feedback email produces ----------
  const graph = IG.createGraph({ backend: 'memory', now: () => NOW });
  const cache = MC.createMailCache({});
  const conn = W.DaylightGmailConnector.createGmailConnector({ graph, mailCache: cache, classifier: C, now: () => NOW });
  const rec = (id, subject, snippet, extra) => Object.assign({ messageId: id, threadId: 't' + id, from: HOTEL, fromDomain: 'booking.com', subject, snippet, labels: ['INBOX'], status: 'classified', category: 'travel', internalDate: NOW - 86400000, lastProcessedAt: NOW, keyDates: [] }, extra || {});
  await cache.putMany('gA', [
    rec('conf', 'Your booking is confirmed', 'Confirmation number 4567890123. Check-in 20 Nov.', { keyDates: future }),
    rec('fb', 'How was your stay?', 'Booking 4567890123 · 1–3 Nov. Leave a review.', { keyDates: past.concat([{ kind: 'deadline', date: '2026-11-30', quote: 'review by 30 Nov' }]) }),
    rec('fb2', 'Rate your recent purchase', 'Order 778899', { from: SHOP, fromDomain: 'shop.example', category: 'receipt' })
  ]);
  await cache.putFacts('gA', [{ messageId: 'conf', fields: { reservationNumber: '4567890123' } }, { messageId: 'fb', fields: { reservationNumber: '4567890123' } }, { messageId: 'fb2', fields: { orderNumber: '778899', amount: { value: 499, currency: 'CZK' } } }]);
  await conn.ingest('gA', {});
  let all = await graph.query();
  const fromMsg = (mid) => all.filter((x) => x.type !== 'email' && (x.sources || []).some((s) => s.itemId === mid) && !['organisation', 'person'].includes(x.type));
  ok('the genuine confirmation makes the booking', all.some((x) => x.type === 'booking' && x.key === 'booking:gA:4567890123'));
  ok('the feedback email makes no booking, ticket, money record or deadline', fromMsg('fb').length === 0 && fromMsg('fb2').length === 0, fromMsg('fb').concat(fromMsg('fb2')).map((x) => x.type));
  ok('…its email Item is typed "feedback" and is linked to the existing booking for context only', all.find((x) => x.key === 'gmail:gA:fb').classification.type === 'feedback' && (await graph.links()).some((l) => l.kind === 'about' && l.from === IG.itemId('gmail:gA:fb') && l.to === IG.itemId('booking:gA:4567890123')));
  ok('…and the booking keeps only the confirmation as its evidence', JSON.stringify(all.find((x) => x.key === 'booking:gA:4567890123').sources.map((s) => s.itemId)) === '["conf"]');
  const w = M.wallet(all, NOW);
  ok('Wallet shows exactly one entry for the stay (the confirmed booking)', w.count === 1);
  ok('no context link is made to a booking that does not exist (purchase feedback)', !(await graph.links()).some((l) => l.from === IG.itemId('gmail:gA:fb2') && l.kind === 'about'));

  // ---------- re-ingest of older data: Items earlier releases made from feedback emails ----------
  {
    const g2 = IG.createGraph({ backend: 'memory', now: () => NOW });
    const c2 = MC.createMailCache({});
    const conn2 = W.DaylightGmailConnector.createGmailConnector({ graph: g2, mailCache: c2, classifier: C, now: () => NOW });
    await c2.putMany('gA', [
      rec('f1', 'How was your stay?', 'Booking 1111111111', { keyDates: past }), rec('f2', 'Rate your recent hotel experience', 'Booking 2222222222', { keyDates: past }),
      rec('f3', 'Review your recent booking', 'Booking 3333333333', { keyDates: past }), rec('f4', 'Rate your recent purchase', 'Order 4444', { from: SHOP, fromDomain: 'shop.example', category: 'receipt' }),
      rec('c5', 'Your booking is confirmed', 'Confirmation number 5555555555', { keyDates: future }), rec('f5', 'How was your stay?', 'Booking 5555555555', { keyDates: past })
    ]);
    const src = (mid) => [{ app: 'gmail', accountId: 'gA', itemId: mid, role: 'evidence' }];
    // what an earlier release stored: bookings made from feedback emails, a money record, a booking with both a confirmation and a feedback email
    await g2.upsertMany([
      { key: 'booking:gA:1111111111', accountId: 'gA', type: 'booking', title: 'FB-PLAIN', sources: src('f1') },
      { key: 'booking:gA:2222222222', accountId: 'gA', type: 'booking', title: 'FB-TOUCHED', sources: src('f2') },
      { key: 'booking:gA:3333333333', accountId: 'gA', type: 'booking', title: 'FB-PLAIN-2', sources: src('f3') },
      { key: 'money:gA:shop.example:4444', accountId: 'gA', type: 'transaction', title: 'MONEY-FROM-FEEDBACK', sources: src('f4') },
      { key: 'booking:gA:5555555555', accountId: 'gA', type: 'booking', title: 'REAL', sources: src('c5').concat(src('f5')) }
    ]);
    const t = (await g2.query()).find((x) => x.title === 'FB-TOUCHED'); Object.assign(t, { pinned: true, notes: [{ text: 'mine', at: NOW }] }); await g2.putItem(t);
    await c2.putFacts('gA', [{ messageId: 'c5', fields: { reservationNumber: '5555555555' } }, { messageId: 'f4', fields: { orderNumber: '4444', amount: { value: 499, currency: 'CZK' } } }]);
    const r = await conn2.ingest('gA', {});
    const a2 = await g2.query(); const by = (t2) => a2.find((x) => x.title === t2 || (t2 === 'REAL' && x.key === 'booking:gA:5555555555'));
    ok('re-ingest: bookings made only from feedback emails are removed', !by('FB-PLAIN') && !by('FB-PLAIN-2'), r);
    ok('re-ingest: a booking you acted on (pin, note) is kept whole', by('FB-TOUCHED') && by('FB-TOUCHED').pinned === true && by('FB-TOUCHED').notes.length === 1);
    ok('re-ingest: a money record is never removed by this reclassification', !!by('MONEY-FROM-FEEDBACK'));
    ok('re-ingest: a real booking keeps its confirmation and loses only the feedback email as evidence', by('REAL') && JSON.stringify(by('REAL').sources.filter((s) => s.app === 'gmail').map((s) => s.itemId).sort()) === '["c5"]', by('REAL') && by('REAL').sources);
    const snap = JSON.stringify((await g2.query()).map((x) => [x.key, x.status || null]).sort());
    await conn2.ingest('gA', {});
    ok('re-ingest is idempotent', JSON.stringify((await g2.query()).map((x) => [x.key, x.status || null]).sort()) === snap);
  }
  // ---------- Outlook uses the same rules ----------
  {
    const g3 = IG.createGraph({ backend: 'memory', now: () => NOW }), c3 = MC.createMailCache({});
    const o = W.DaylightGmailConnector.createGmailConnector({ app: 'outlook', graph: g3, mailCache: c3, classifier: C, now: () => NOW });
    await c3.putMany('ms-1', [rec('o1', 'How was your stay?', 'Booking 9999999999', { keyDates: past })]);
    await c3.putFacts('ms-1', [{ messageId: 'o1', fields: { reservationNumber: '9999999999' } }]);
    await o.ingest('ms-1', {});
    ok('Outlook: a feedback email makes no booking either', !(await g3.query({ type: 'booking' })).length);
  }
  // ---------- older Wallet passes that an earlier release made from feedback emails (seen in real data) ----------
  {
    const g4 = IG.createGraph({ backend: 'memory', now: () => NOW });
    const mkMail = (mid, type) => ({ key: `gmail:gA:${mid}`, accountId: 'gA', type: 'email', title: 'm', sources: [{ app: 'gmail', accountId: 'gA', itemId: mid, role: 'primary' }], classification: { type } });
    await g4.upsertMany([mkMail('r1', 'feedback'), mkMail('r2', 'feedback'), mkMail('k1', 'booking')]);
    const store = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } };
    const recs = [{ id: 'mail:r1', kind: 'documents', title: 'Write a review for your host', ownerAccount: 'gA' }, { id: 'mail:r2', kind: 'documents', title: 'Final reminder: Write a review for your host', ownerAccount: 'gA' },
      { id: 'mail:k1', kind: 'tickets', title: 'Concert ticket', ownerAccount: 'gA', eventAt: '2026-11-20T19:00:00Z' }, { id: 'w5', kind: 'documents', title: 'My scanned card', scanSource: true }];
    store.setItem('daylight-wallet', JSON.stringify(recs)); const before = store.getItem('daylight-wallet');
    const L = W.DaylightLocalConnector.createLocalConnector({ graph: g4, localStorage: store, now: () => NOW, mailKey: (m, a) => 'gmail:' + a + ':' + m, gmailAccounts: () => ['gA'] });
    await L.importLocal();
    let a4 = await g4.query(); let shown = M.wallet(a4, NOW);
    const titles = (w2) => [w2.upNext, ...w2.trips.flatMap((t) => t.items), ...w2.events, ...w2.documents.map((d) => d.item), ...w2.coupons, ...w2.past].filter(Boolean).map((x) => x.title);
    ok('older passes made from review requests are no longer shown in Wallet', !titles(shown).some((t) => /review/i.test(t)) && titles(shown).includes('Concert ticket') && titles(shown).includes('My scanned card'), titles(shown));
    ok('…their records and Items are kept (nothing deleted), and only flagged', store.getItem('daylight-wallet') === before && a4.filter((x) => /review/i.test(x.title)).every((x) => x.meta.notAPass === 'feedback') && a4.filter((x) => /review/i.test(x.title)).length === 2);
    // a pass you acted on stays in Wallet
    const r2 = a4.find((x) => x.title.startsWith('Final reminder')); r2.pinned = true; await g4.putItem(r2);
    await L.importLocal(); a4 = await g4.query(); shown = M.wallet(a4, NOW);
    ok('a review-request pass you pinned stays in Wallet', titles(shown).includes('Final reminder: Write a review for your host') && !titles(shown).includes('Write a review for your host'));
    // correcting the email's type undoes it
    const m1 = a4.find((x) => x.key === 'gmail:gA:r1'); m1.classification = { type: 'documents', userSet: true }; await g4.putItem(m1);
    await L.importLocal(); a4 = await g4.query();
    ok('if you correct the email\'s type, the pass comes back on the next import', !a4.find((x) => x.title === 'Write a review for your host').meta.notAPass && titles(M.wallet(a4, NOW)).includes('Write a review for your host'));
  }
  console.log(`Wallet feedback unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
