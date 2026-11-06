/** v112 final release gate — Wallet intelligence (synthetic data only).
 *  1 cross-account safety · 2 user-state preservation (each condition alone) · 3 feedback false-positive protection
 *  (adversarial emails) · 4 fb1 re-ingest interrupted (before, halfway, after graph changes, two tabs) → idempotent recovery.
 * Run: node tests/wallet-release-gate-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const mkLS = () => ({ d: {}, get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i]; }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } });
global.localStorage = mkLS();
const ROOT = path.resolve(__dirname, '..');
['mail-dates.js', 'gmail-config.js', 'gmail-cache.js', 'graph/item-graph.js', 'classification/user-rules.js', 'classification/classifier.js', 'connectors/gmail-connector.js', 'connectors/local-connector.js', 'privacy/account-inventory.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis, IG = W.DaylightItemGraph, C = W.DaylightClassifier, MC = W.DaylightMailCache, INV = W.DaylightAccountInventory;
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 600))); };
const NOW = Date.UTC(2026, 10, 6, 10), DAY = 86400000;
const iid = (k) => IG.itemId(k);
const clone = (x) => JSON.parse(JSON.stringify(x));
const email = (acct, mid, extra) => Object.assign({ key: `${acct.startsWith('ms-') ? 'outlook' : 'gmail'}:${acct}:${mid}`, accountId: acct, type: 'email', title: 'mail ' + mid, sources: [{ app: acct.startsWith('ms-') ? 'outlook' : 'gmail', accountId: acct, itemId: mid, role: 'primary' }] }, extra || {});
const booking = (acct, ref, mid) => ({ key: `booking:${acct}:${ref}`, accountId: acct, type: 'booking', title: 'BOOKING ' + acct + ' ' + ref, dueAt: NOW + 5 * DAY, sources: [{ app: acct.startsWith('ms-') ? 'outlook' : 'gmail', accountId: acct, itemId: mid, role: 'evidence' }] });
const local = (graph, ls, accts) => W.DaylightLocalConnector.createLocalConnector({ graph, localStorage: ls, now: () => NOW, mailKey: (m, a) => 'gmail:' + a + ':' + m, gmailAccounts: () => accts || ['gA', 'gB'] });
const wl = (ls) => JSON.parse(ls.getItem('daylight-wallet') || '[]');

(async () => {
  // ================= 1. cross-account safety =================
  {
    const ls = mkLS(); const g = IG.createGraph({ backend: 'memory', now: () => NOW });
    // the SAME booking reference in A and B; A's email is (adversarially) linked to both bookings
    await g.upsertMany([email('gA', 'a1'), email('gB', 'b1'), booking('gA', 'SAME', 'a1'), booking('gB', 'SAME', 'b1'), email('gA', 'a2'), booking('gB', 'ONLYB', 'b1')]);
    await g.linkMany([[iid('gmail:gA:a1'), iid('booking:gA:SAME'), 'evidence'], [iid('gmail:gB:b1'), iid('booking:gB:SAME'), 'evidence']], 'gA');
    await g.linkMany([[iid('gmail:gA:a2'), iid('booking:gB:ONLYB'), 'evidence']], 'gA'); // A's email pointing at B's booking (must never merge)
    ls.setItem('daylight-wallet', JSON.stringify([{ id: 'mail:a1', mailId: 'a1', kind: 'tickets', title: 'PASS-A1' }, { id: 'mail:a2', mailId: 'a2', kind: 'tickets', title: 'PASS-A2' }, { id: 'mail:b1', mailId: 'b1', kind: 'tickets', title: 'PASS-B1' }]));
    await local(g, ls).importLocal();
    const all = await g.query(); const k = (key) => all.find((x) => x.key === key);
    ok('1 A\'s pass merges only into A\'s booking (same reference exists in B)', (k('booking:gA:SAME').sources || []).some((s) => s.app === 'wallet' && s.itemId === 'mail:a1') && !(k('booking:gB:SAME').sources || []).some((s) => s.app === 'wallet' && s.itemId === 'mail:a1'));
    ok('1 B\'s pass merges only into B\'s booking', (k('booking:gB:SAME').sources || []).some((s) => s.app === 'wallet' && s.itemId === 'mail:b1') && !(k('booking:gA:SAME').sources || []).some((s) => s.app === 'wallet' && s.itemId === 'mail:b1'));
    ok('1 a pass whose email points at ANOTHER account\'s booking never merges into it (stays its own Item, owned by A)', !(k('booking:gB:ONLYB').sources || []).some((s) => s.app === 'wallet') && k('wallet:mail:a2') && k('wallet:mail:a2').accountId === 'gA');
    ok('1 owners recorded from evidence only', JSON.stringify(wl(ls).map((p) => p.ownerAccount)) === '["gA","gA","gB"]');
    const exA = JSON.stringify(INV.filterExport({ items: all, links: await g.links() }, ['gA']));
    ok('1 A\'s export holds no B booking or pass', !/PASS-B1|BOOKING gB/.test(exA));
    // unproven, and Microsoft vs Gmail
    const ls2 = mkLS(); const g2 = IG.createGraph({ backend: 'memory', now: () => NOW });
    await g2.upsertMany([email('ms-1', 'm9'), email('gA', 'x1')]); // an Outlook message with the same id as the pass's mail id
    ls2.setItem('daylight-wallet', JSON.stringify([{ id: 'mail:m9', mailId: 'm9', kind: 'tickets', title: 'MS-ID' }, { id: 'mail:zz', mailId: 'zz', kind: 'tickets', title: 'NONE' }]));
    await local(g2, ls2, ['gA', 'ms-1']).importLocal(); // even if an ms- key were listed as a Gmail account
    const a2 = await g2.query();
    ok('1 unproven ownership stays unassigned-mail', a2.find((x) => x.title === 'NONE').accountId === 'unassigned-mail' && !wl(ls2)[1].ownerAccount);
    ok('1 an Outlook message with the same id never makes a Gmail pass Microsoft\'s (or anyone\'s)', a2.find((x) => x.title === 'MS-ID').accountId === 'unassigned-mail' && !wl(ls2)[0].ownerAccount);
    ok('1 provider comes from the key / ledger, never from sources', INV.providerOf('ms-1', null) === 'microsoft' && INV.providerOf('gA', null) === 'google');
  }

  // ================= 2. user-state preservation =================
  const CONDS = [
    ['status', (it) => { it.status = 'done'; }], ['snooze', (it) => { it.status = 'snoozed'; it.snoozedUntil = NOW + DAY; }], ['pin', (it) => { it.pinned = true; }],
    ['notes', (it) => { it.notes = [{ text: 'n', at: NOW }]; }], ['plan', (it) => { it.plannedAt = NOW + DAY; it.plannedMinutes = 30; }], ['priority', (it) => { it.userPriority = 90; }],
    ['corrections', (it) => { it.userCorrections = [{ field: 'type', from: 'a', to: 'b', at: NOW }]; }], ['type set by you', (it) => { it.classification = { type: 'personal', userSet: true }; }],
    ['action history', (it) => { it.actionHistory = [{ id: 'h1', kind: 'pin', at: NOW }]; }], ['action entry', null, 'action'], ['non-evidence link', null, 'link']
  ];
  for (const [name, mutate, extra] of CONDS) {
    const ls = mkLS(); const g = IG.createGraph({ backend: 'memory', now: () => NOW });
    await g.upsertMany([email('gA', 'a1'), booking('gA', 'R1', 'a1'), { key: 'wallet:mail:a1', accountId: 'local', type: 'ticket', title: 'DUP', sources: [{ app: 'wallet', accountId: 'local', itemId: 'mail:a1', role: 'primary' }], meta: { origin: 'wallet' } }]);
    await g.linkMany([[iid('gmail:gA:a1'), iid('booking:gA:R1'), 'evidence']], 'gA');
    ls.setItem('daylight-wallet', JSON.stringify([{ id: 'mail:a1', mailId: 'a1', kind: 'tickets', title: 'DUP', ownerAccount: 'gA' }]));
    const st = await g.getItem(iid('wallet:mail:a1'));
    if (mutate) { mutate(st); await g.putItem(st); }
    if (extra === 'action') await g.actions.put({ id: 'act_z', itemId: st.id, accountId: 'local', kind: 'pin', at: NOW });
    if (extra === 'link') { const t = await g.upsertItem({ key: 'task:v2:z', accountId: 'local', type: 'task', title: 'T', sources: [{ app: 'daylight', accountId: 'local', itemId: 'z' }] }); await g.link(t.id, st.id, 'about', 'local'); }
    const before = clone(await g.getItem(iid('wallet:mail:a1')));
    await local(g, ls, ['gA']).importLocal();
    const after = await g.getItem(iid('wallet:mail:a1'));
    const keep = ['status', 'snoozedUntil', 'pinned', 'notes', 'plannedAt', 'plannedMinutes', 'userPriority', 'userCorrections', 'classification', 'actionHistory'];
    ok(`2 ${name}: the duplicate is kept whole and moved to its account`, !!after && after.accountId === 'gA' && keep.every((f) => JSON.stringify(after[f]) === JSON.stringify(before[f])) && (extra !== 'action' || (await g.actions.all()).some((a) => a.id === 'act_z')) && (extra !== 'link' || (await g.links()).some((l) => l.kind === 'about' && l.to === after.id)), after && { acc: after.accountId });
  }
  {
    // removal touches only the duplicate's own wallet source: the booking is byte-identical before and after the removal
    const ls = mkLS(); const g = IG.createGraph({ backend: 'memory', now: () => NOW });
    await g.upsertMany([email('gA', 'a1'), booking('gA', 'R1', 'a1'), { key: 'wallet:mail:a1', accountId: 'local', type: 'ticket', title: 'DUP', sources: [{ app: 'wallet', accountId: 'local', itemId: 'mail:a1', role: 'primary' }], meta: { origin: 'wallet' } }]);
    await g.linkMany([[iid('gmail:gA:a1'), iid('booking:gA:R1'), 'evidence']], 'gA');
    ls.setItem('daylight-wallet', JSON.stringify([{ id: 'mail:a1', mailId: 'a1', kind: 'tickets', title: 'DUP', ownerAccount: 'gA' }, { id: 'w1', kind: 'tickets', title: 'SCANNED', scanSource: true }, { id: 'v2_t', kind: 'documents', title: 'TYPED' }]));
    const recs = ls.getItem('daylight-wallet');
    // first import with user state (kept) → the booking now holds the merged pass; then the user clears it → removal
    const st = await g.getItem(iid('wallet:mail:a1')); st.pinned = true; await g.putItem(st);
    const L = local(g, ls, ['gA']); await L.importLocal();
    const bk1 = clone(await g.getItem(iid('booking:gA:R1')));
    const st2 = await g.getItem(iid('wallet:mail:a1')); st2.pinned = false; await g.putItem(st2);
    await L.importLocal();
    const bk2 = await g.getItem(iid('booking:gA:R1'));
    ok('2 removing a duplicate deletes only that standalone Item', !(await g.getItem(iid('wallet:mail:a1'))));
    ok('2 …the booking is unchanged (every field, sources, related items)', JSON.stringify(bk2) === JSON.stringify(bk1), { before: bk1.sources, after: bk2.sources });
    ok('2 …manual and scanned pass records and Items are untouched', ls.getItem('daylight-wallet') === recs && (await g.getItem(iid('wallet:w1'))).accountId === 'local' && (await g.getItem(iid('wallet:v2_t'))).accountId === 'local');
  }

  // ================= 3. feedback false-positive protection =================
  {
    const HOTEL = 'Hotel Praha <reservations@hotelpraha.example>';
    const cls = (o) => C.classify(Object.assign({ from: HOTEL, labels: ['INBOX'], pipelineCategory: 'travel', facts: { reference: '777000' }, keyDates: [] }, o), { now: NOW });
    const upcoming = [{ kind: 'travel', date: '2026-11-20', quote: 'check-in 20 Nov' }], pastD = [{ kind: 'travel', date: '2026-10-01', quote: 'stay 1 Oct' }];
    const A = [
      ['an upcoming hotel confirmation quoting review language', { subject: 'Your reservation at Hotel Praha', snippet: 'Guests say: "How was your stay? Wonderful!" — see what others wrote. Check-in 20 Nov, 2 nights.', keyDates: upcoming }, 'booking'],
      ['a genuine confirmation with a feedback invitation in the same email', { subject: 'Booking confirmed – Hotel Praha', snippet: 'Confirmation number 777000. After your stay, leave us a review!', keyDates: upcoming }, 'booking'],
      ['a forwarded booking confirmation (from a person)', { from: 'Petr <petr@example.test>', subject: 'Fwd: Your booking is confirmed', snippet: '---------- Forwarded message ---------- Confirmation number 777000. Check-in 20 Nov. How was your stay last time?', pipelineCategory: 'travel', keyDates: upcoming }, 'booking'],
      ['a forwarded confirmation from an automated relay', { from: 'Trips <no-reply@trips.example>', subject: 'FW: Reservation confirmed', snippet: 'Your reservation is confirmed. We would love your feedback.', keyDates: upcoming }, 'booking'],
      ['a genuine e-ticket with a survey link at the bottom', { from: 'Rail <no-reply@rail.example>', subject: 'Your e-ticket for 20 Nov', snippet: 'Seat 42. Take our short survey after your journey.', keyDates: upcoming }, 'booking'],
      ['a genuine receipt with "review" in unrelated text', { from: 'Shop <orders@shop.example>', pipelineCategory: 'receipt', subject: 'Thanks for your order', snippet: 'Order 445566 · total 499 CZK, paid with Visa. Review your order details below. Read our review policy.', facts: { orderNumber: '445566', amount: { value: 499, currency: 'CZK' } } }, 'receipt'],
      ['a receipt asking to "review your order details" (no amount parsed)', { from: 'Shop <orders@shop.example>', pipelineCategory: 'receipt', subject: 'Order 445566 shipped', snippet: 'Paid with Visa. Review your order details in your account.', facts: { orderNumber: '445566' } }, null]
    ];
    A.forEach(([name, o, want]) => { const r = cls(o); ok(`3 ${name} → ${want || 'not feedback'}`, want ? r.type === want : r.type !== 'feedback', { type: r.type, reasons: r.reasons.slice(0, 3) }); });
    const fb1 = cls({ subject: 'How was your stay?', snippet: 'Your booking confirmation 777000 — check-in 1 Oct, 3 nights. Tell us how we did.', keyDates: pastD });
    ok('3 a review request quoting an old booking confirmation → feedback', fb1.type === 'feedback', fb1.reasons);
    // a feedback email whose reference matches an UNRELATED booking (other sender): feedback, no booking, no context link
    const g = IG.createGraph({ backend: 'memory', now: () => NOW }), mc = MC.createMailCache({});
    const conn = W.DaylightGmailConnector.createGmailConnector({ graph: g, mailCache: mc, classifier: C, now: () => NOW });
    const rec = (id, from, dom, subject, snippet, extra) => Object.assign({ messageId: id, threadId: 't' + id, from, fromDomain: dom, subject, snippet, labels: ['INBOX'], status: 'classified', category: 'travel', internalDate: NOW - DAY, lastProcessedAt: NOW, keyDates: [] }, extra || {});
    await mc.putMany('gA', [rec('air', 'Air <no-reply@air.example>', 'air.example', 'Your booking is confirmed', 'Confirmation number 777000', { keyDates: upcoming }),
      rec('fbx', 'Shop <no-reply@shop.example>', 'shop.example', 'Rate your recent purchase', 'Order 777000', { category: 'receipt' }),
      rec('fbh', 'Air <no-reply@air.example>', 'air.example', 'How was your flight?', 'Booking 777000', { keyDates: pastD })]);
    await mc.putFacts('gA', [{ messageId: 'air', fields: { reservationNumber: '777000' } }, { messageId: 'fbx', fields: { orderNumber: '777000' } }, { messageId: 'fbh', fields: { reservationNumber: '777000' } }]);
    await conn.ingest('gA', {});
    const links = await g.links(); const bk = iid('booking:gA:777000');
    ok('3 a feedback email with an unrelated booking reference is not linked to that booking', !links.some((l) => l.from === iid('gmail:gA:fbx') && l.to === bk));
    ok('3 …while a feedback email from the booking\'s own sender is linked for context', links.some((l) => l.from === iid('gmail:gA:fbh') && l.to === bk && l.kind === 'about'));
    ok('3 …and the booking keeps only its confirmation as evidence (no booking from either feedback email)', JSON.stringify((await g.getItem(bk)).sources.map((s) => s.itemId)) === '["air"]' && (await g.query({ type: 'booking' })).length === 1);
  }

  // ================= 4. fb1 re-ingest interrupted =================
  {
    const PAST = [{ kind: 'travel', date: '2026-10-01', quote: 'stay' }], FUT = [{ kind: 'travel', date: '2026-11-20', quote: 'check-in' }];
    const rec = (id, subject, snippet, extra) => Object.assign({ messageId: id, threadId: 't' + id, from: 'Hotel <no-reply@hotel.example>', fromDomain: 'hotel.example', subject, snippet, labels: ['INBOX'], status: 'classified', category: 'travel', internalDate: NOW - DAY, lastProcessedAt: NOW - 30 * DAY, keyDates: [] }, extra || {});
    const ROWS = [rec('c1', 'Your booking is confirmed', 'Confirmation number 1001', { keyDates: FUT }), rec('f1', 'How was your stay?', 'Booking 2002', { keyDates: PAST }),
      rec('f2', 'Rate your recent hotel experience', 'Booking 3003', { keyDates: PAST }), rec('f3', 'Rate your recent purchase', 'Order 4004', { category: 'receipt', from: 'Shop <no-reply@shop.example>', fromDomain: 'shop.example' }),
      rec('c5', 'Reservation confirmed', 'Confirmation number 5005', { keyDates: FUT }), rec('f5', 'How was your stay?', 'Booking 5005', { keyDates: PAST })];
    for (let i = 0; i < 40; i++) ROWS.push(rec('n' + i, 'Newsletter ' + i, 'Hello', { category: 'newsletter' }));
    const FACTS = [{ messageId: 'c1', fields: { reservationNumber: '1001' } }, { messageId: 'f1', fields: { reservationNumber: '2002' } }, { messageId: 'f2', fields: { reservationNumber: '3003' } }, { messageId: 'f3', fields: { orderNumber: '4004', amount: { value: 99, currency: 'EUR' } } }, { messageId: 'c5', fields: { reservationNumber: '5005' } }, { messageId: 'f5', fields: { reservationNumber: '5005' } }];
    const src = (mid) => [{ app: 'gmail', accountId: 'gA', itemId: mid, role: 'evidence' }];
    async function seed() {
      const g = IG.createGraph({ backend: 'memory', now: () => NOW }), mc = MC.createMailCache({}), ls = mkLS();
      await mc.putMany('gA', clone(ROWS)); await mc.putFacts('gA', clone(FACTS));
      // what the previous release stored: bookings from feedback emails (one acted on), a money record from one, a real booking with a feedback email
      await g.upsertMany([{ key: 'booking:gA:2002', accountId: 'gA', type: 'booking', title: 'OLD-FB', sources: src('f1') }, { key: 'booking:gA:3003', accountId: 'gA', type: 'booking', title: 'OLD-FB-PINNED', sources: src('f2') },
        { key: 'money:gA:shop.example:4004', accountId: 'gA', type: 'transaction', title: 'MONEY', sources: src('f3') }, { key: 'booking:gA:5005', accountId: 'gA', type: 'booking', title: 'REAL', sources: src('c5').concat(src('f5')) }]);
      const p = await g.getItem(iid('booking:gA:3003')); Object.assign(p, { pinned: true, notes: [{ text: 'keep', at: NOW }], actionHistory: [{ id: 'h', kind: 'pin', at: NOW }] }); await g.putItem(p);
      const r = await g.getItem(iid('booking:gA:5005')); Object.assign(r, { status: 'done', notes: [{ text: 'real', at: NOW }] }); await g.putItem(r);
      ls.setItem('daylight-graph-ingest:x5:gA', String(NOW - 10 * DAY)); // x5 done long ago; fb1 not yet
      return { g, mc, ls };
    }
    // the app's watermark logic (app.js v2IngestGmail): full when fb1 is missing; both watermarks written only after success
    async function sync(ctx, conn) {
      const key = 'daylight-graph-ingest:x5:gA', fbKey = 'daylight-graph-ingest-fb1:gA';
      let since = Number(ctx.ls.getItem(key)) || 0; if (!ctx.ls.getItem(fbKey)) since = 0;
      const r = await conn.ingest('gA', { since }); ctx.ls.setItem(key, String(NOW)); ctx.ls.setItem(fbKey, String(NOW)); return r;
    }
    const mkConn = (ctx, graph) => W.DaylightGmailConnector.createGmailConnector({ graph: graph || ctx.g, mailCache: ctx.mc, classifier: C, now: () => NOW });
    const snap = async (g) => JSON.stringify((await g.query()).map((x) => [x.key, x.accountId, x.type, x.status || null, !!x.pinned, (x.notes || []).length, (x.actionHistory || []).length, (x.sources || []).map((s) => s.app + s.itemId + s.role).sort(), (x.relatedItemIds || []).slice().sort()]).sort())
      + JSON.stringify((await g.links()).map((l) => l.id).sort());
    const ref = await seed(); await sync(ref, mkConn(ref)); const REF = await snap(ref.g);
    const refAll = await ref.g.query(); const t = (x) => refAll.find((i) => i.title === x || i.key === x);
    ok('4 reference run: feedback-only booking removed, the one you acted on kept whole, money kept, real booking keeps its confirmation and state', !t('OLD-FB') && t('OLD-FB-PINNED').pinned && t('OLD-FB-PINNED').notes.length === 1 && !!t('MONEY') && t('booking:gA:5005').status === 'done' && t('booking:gA:5005').notes.length === 1 && JSON.stringify(t('booking:gA:5005').sources.map((s) => s.itemId)) === '["c5"]', refAll.filter((x) => x.type !== 'email' && x.type !== 'organisation').map((x) => [x.key, x.title, x.status, x.pinned, (x.notes||[]).length, x.sources.map((s) => s.itemId)]));
    // (a) before processing starts
    { const c = await seed(); const conn = mkConn(c); const real = c.mc.all; c.mc.all = async () => { c.mc.all = real; throw new Error('closed before start'); };
      let e = null; try { await sync(c, conn); } catch (x) { e = x; } const mid = await snap(c.g);
      ok('4a interrupted before processing: nothing changed, fb1 not written', e && !c.ls.getItem('daylight-graph-ingest-fb1:gA'));
      await sync(c, conn); ok('4a …the next sync completes it: identical to an uninterrupted run', (await snap(c.g)) === REF && mid !== REF); }
    // (b) halfway: the Item write stores half its Items, then the tab dies
    { const c = await seed(); const g = Object.create(c.g); let once = true;
      g.upsertMany = async (parts) => { if (once && parts.length > 10) { once = false; await c.g.upsertMany(parts.slice(0, Math.floor(parts.length / 2))); throw new Error('tab closed halfway'); } return c.g.upsertMany(parts); };
      let e = null; try { await sync(c, mkConn(c, g)); } catch (x) { e = x; }
      ok('4b interrupted halfway: fb1 not written', e && !c.ls.getItem('daylight-graph-ingest-fb1:gA'));
      await sync(c, mkConn(c)); ok('4b …recovery is identical to an uninterrupted run (no duplicates, user state kept)', (await snap(c.g)) === REF); }
    // (c) graph changed (stale detached) but the watermark was never written
    { const c = await seed(); const g = Object.create(c.g); let once = true;
      g.linkMany = async (l, a) => { if (once) { once = false; throw new Error('closed after detaching'); } return c.g.linkMany(l, a); };
      let e = null; try { await sync(c, mkConn(c, g)); } catch (x) { e = x; }
      ok('4c interrupted after graph changes, before the watermark: fb1 not written', e && !c.ls.getItem('daylight-graph-ingest-fb1:gA'));
      await sync(c, mkConn(c)); ok('4c …recovery is identical to an uninterrupted run', (await snap(c.g)) === REF); }
    // (c2) everything finished but the app died before writing the watermark → the next open repeats the full re-ingest
    { const c = await seed(); await mkConn(c).ingest('gA', { since: 0 });
      await sync(c, mkConn(c)); ok('4c2 a repeated full re-ingest after a lost watermark changes nothing', (await snap(c.g)) === REF); }
    // (d) a reload or second tab: two full re-ingests at the same time (no lock), then a normal sync
    { const c = await seed(); await Promise.all([sync(c, mkConn(c)), sync(c, mkConn(c))]);
      const after = await snap(c.g); await sync(c, mkConn(c));
      ok('4d two tabs re-ingesting at once end identical to one run (no duplicate Items, links, notes or history)', after === REF && (await snap(c.g)) === REF);
      const all = await c.g.query(); ok('4d …every key once, notes not doubled', new Set(all.map((x) => x.key)).size === all.length && all.find((x) => x.title === 'OLD-FB-PINNED').notes.length === 1); }
  }
  console.log(`Wallet release gate unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
