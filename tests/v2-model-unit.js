/** V2 Phase D view models: every screen's data comes from graph Items, nothing is invented. Node only. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const IG = require(path.join(ROOT, 'graph/item-graph.js'));
global.DaylightItemGraph = IG;
const M = require(path.join(ROOT, 'ui/v2-model.js'));
const S = require(path.join(ROOT, 'ui/v2-sample.js'));
const UR = require(path.join(ROOT, 'classification/user-rules.js'));
global.DaylightUserRules = UR;
const CL = require(path.join(ROOT, 'classification/classifier.js'));
const AC = require(path.join(ROOT, 'actions/apply-action.js'));
const LC = require(path.join(ROOT, 'connectors/local-connector.js'));

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (info !== undefined ? '  ← ' + JSON.stringify(info).slice(0, 300) : '')); } };
const NOW = new Date(2026, 10, 5, 10, 0, 0).getTime(); // Thu 5 Nov 2026 10:00 local
const clock = { t: NOW }; const now = () => clock.t;

(async () => {
  const g = IG.createGraph({ backend: 'memory', now });
  const { items: parts, links } = S.build(NOW);
  await g.upsertMany(parts); await g.linkMany(links, 'sample');
  let items = await g.query();
  const ids = new Set(items.map((x) => x.id));
  const cites = (list) => list.every((id) => ids.has(id));

  // ---- Today ----
  const t = M.todayView(items, NOW, { actions: [] });
  ok('today: needs-you is ranked and every card is a real Item', t.needs.length >= 5 && t.needs.every((x) => ids.has(x.item.id)) && t.needs.every((x, i, a) => !i || a[i - 1].score >= x.score));
  const types = new Set(t.needs.map((x) => x.item.type));
  ok('today: bills, deadlines, tasks and reply-needed emails all reach Needs you', ['bill', 'deadline', 'task', 'email'].every((k) => types.has(k)), [...types]);
  ok('today: an email that produced a bill is folded under it, not shown twice', !t.needs.some((x) => x.item.type === 'email' && /electricity bill/i.test(x.item.title)) && t.needs.find((x) => x.item.type === 'bill' && /ČEZ/.test(x.item.title)).related.length === 1);
  ok('today: newsletters and promotions never reach Needs you', !t.needs.some((x) => ['newsletter', 'marketing', 'social_notification'].includes(M.ctype(x.item))));
  ok('today: Now card = the appointment in the next 2 hours', t.now && t.now.item.type === 'appointment' && /^In /.test(t.now.label), t.now && t.now.label);
  ok('today: brief sentences each cite their Items', t.brief.parts.length >= 2 && t.brief.parts.every((p) => p.ids.length && cites(p.ids)), t.brief.parts);
  ok('today: brief totals bills by currency from facts', t.brief.parts.some((p) => /bills? to pay \(1\s?840 CZK\)|bill to pay/.test(p.text)), t.brief.parts.map((p) => p.text));
  ok('today: coming up = next 7 days, sorted', t.coming.length >= 3 && t.coming.every((x, i, a) => !i || M.whenOf(a[i - 1]) <= M.whenOf(x)));
  ok('today: no evening wrap before 18:00', t.evening === null);
  const eve = M.todayView(items, new Date(2026, 10, 5, 19, 0).getTime(), { actions: [] });
  ok('today: evening wrap after 18:00 lists open items and tomorrow', eve.evening && eve.evening.open.length > 0);
  const empty = M.todayView([], NOW);
  ok('today: empty graph → clear state, no fabricated cards', empty.needs.length === 0 && empty.brief.clear && !empty.now);

  // ---- Inbox ----
  const ib = M.inboxView(items, NOW);
  ok('inbox: groups needs/waiting/money/travel/updates filled by type', ib.groups.needs.length >= 3 && ib.groups.waiting.length === 1 && ib.groups.money.length >= 5 && ib.groups.travel.length === 2, Object.fromEntries(Object.entries(ib.groups).map(([k, v]) => [k, v.length])));
  ok('inbox: updates grouped by sender (Zalando ×2 → one group)', ib.updates.find((u) => /zalando/.test(u.key)).items.length === 2);
  ok('inbox: search finds by fact value (variable symbol)', M.inboxView(items, NOW, { query: '2026110' }).groups.money.length === 1);
  ok('inbox: only connected sources appear as chips', ib.sources.join() === 'gmail');

  // ---- People ----
  const pv = M.peopleView(items, NOW);
  ok('people: waiting on you = people with open asks, oldest first', pv.waitingYou.length === 2 && pv.waitingYou[0].item.title === 'Martin Dvořák');
  ok('people: you are waiting on = sent mail with no later reply', pv.waitingThem.length === 1 && /chapter 3/.test(pv.waitingThem[0].item.title));
  const pp = M.personPage(items, pv.waitingYou[1].item.id, NOW);
  ok('people: person page lists their messages and open items', pp && pp.messages.length === 1 && pp.open.length >= 1);

  // ---- Plan ----
  const plan = M.planView(items, NOW, NOW, { days: 3 });
  ok('plan: 3-day view has timed and all-day items per day', plan.cols.length === 3 && plan.cols[0].timed.some((x) => x.type === 'appointment'));
  ok('plan: unplaced tray = open tasks + deadlines without a planned time', plan.tray.length >= 3 && plan.tray.every((x) => ['task', 'deadline'].includes(x.type)));
  const sug = M.suggestPlan(items, NOW, NOW, { dayStart: 8, dayEnd: 18, focusStart: 9, focusEnd: 12 });
  ok('plan: suggested blocks fit free gaps and avoid the appointment', sug.blocks.length >= 1 && sug.blocks.every((b) => b.at >= NOW) && sug.blocks.every((b) => { const ap = t.now.item; const a = M.whenOf(ap); return b.at + b.minutes * 60000 <= a - 10 * 60000 || b.at >= a + 70 * 60000; }), sug.blocks.map((b) => [new Date(b.at).toTimeString().slice(0, 5), b.minutes]));
  const full = M.suggestPlan(items, NOW, new Date(2026, 10, 5, 17, 40).getTime(), { dayStart: 8, dayEnd: 18 });
  ok('plan: an over-full day says so instead of squeezing', full.overfull === true && full.left.length > 0);
  ok('plan: overlapping timed items are reported as conflicts', M.conflicts([{ id: 'a', type: 'appointment', plannedAt: NOW }, { id: 'b', type: 'appointment', plannedAt: NOW + 30 * 60000 }]).length === 1);

  // ---- Money ----
  const mo = M.money(items, NOW, NOW);
  ok('money: month header sums November bills (due 2 439 CZK, paid 0)', mo.currency === 'CZK' && mo.due === 2439 && mo.paid === 0, { due: mo.due, paid: mo.paid });
  ok('money: due soon = unpaid bills by due date', mo.dueSoon.length === 2 && /ČEZ/.test(mo.dueSoon[0].title));
  ok('money: subscription price rise is flagged from its two receipts', mo.subscriptions.length === 1 && mo.subscriptions[0].flags.includes('Price went up'), mo.subscriptions[0]);
  ok('money: spending categories from this month\'s receipts', mo.spending.length >= 2 && mo.spending.every((c) => c.items.length));
  ok('money: bill history comes from the same merchant', M.billHistory(items, mo.dueSoon[1].id).some((x) => /549/.test(x.title)));

  // ---- Wallet ----
  const w = M.wallet(items, NOW);
  ok('wallet: train + hotel on the same day form one trip', w.trips.length === 1 && w.trips[0].items.length === 2 && w.trips[0].place === 'Wien');
  ok('wallet: up next = nearest booking', w.upNext && /Train/.test(w.upNext.title));
  ok('wallet: documents warn 90 days before expiry', w.documents.length === 1 && w.documents[0].warn && w.documents[0].expiresInDays === 62);
  ok('wallet: event tickets listed', w.events.length === 1);

  // ---- Ask ----
  const a1 = M.askLocal(items, 'What bills do I have to pay?', NOW);
  ok('ask: bills question answered from Items with sources', a1.intent === 'bills' && a1.ids.length === 2 && cites(a1.ids) && /2\s?439 CZK/.test(a1.text), a1.text);
  const a2 = M.askLocal(items, 'what did Martin say about the lab', NOW);
  ok('ask: free-text search finds the message', a2.items.some((x) => /Lab booking/.test(x.title)));
  ok('ask: unknown → honest "nothing matches"', M.askLocal(items, 'zebra quantum pizza', NOW).ids.length === 0);
  const ctx = M.aiContext(items, NOW);
  ok('ask: AI context never includes identity documents or people', !ctx.some((x) => /Residence/.test(x.title)) && !ctx.some((x) => x.kind === 'person'));
  const ver = M.verifyCited({ sentences: [{ text: 'Your electricity bill is due Sunday.', ids: [mo.dueSoon[0].id] }, { text: 'You won the lottery.', ids: ['it_fake'] }, { text: 'No source here.' }] }, ctx.map((x) => x.id));
  ok('ask: AI sentences without a real cited Item are dropped', ver.length === 1 && /electricity/.test(ver[0].text));

  // ---- actions used by the UI: schedule + undo, snooze hides, done moves out ----
  const actions = AC.createActions({ graph: g, classifier: CL });
  const task = items.find((x) => x.type === 'task' && /methods/.test(x.title));
  const r = await actions.applyAction(task.id, 'schedule', { at: NOW + 3600000, minutes: 90 });
  items = await g.query();
  ok('schedule: a task gets a planned time and leaves the tray', r.ok && !M.planView(items, NOW, NOW).tray.some((x) => x.id === task.id) && M.planView(items, NOW, NOW).cols[0].timed.some((x) => x.id === task.id));
  await actions.undo(r.actionId); items = await g.query();
  ok('schedule: undo puts it back in the tray', M.planView(items, NOW, NOW).tray.some((x) => x.id === task.id));
  ok('schedule: invalid length rejected', !(await actions.applyAction(task.id, 'schedule', { at: NOW, minutes: 1 })).ok);
  const bill = mo.dueSoon[0];
  await actions.applyAction(bill.id, 'snooze', { until: NOW + 2 * 86400000 }); items = await g.query();
  ok('snooze: a snoozed bill leaves Needs you and Due soon until it wakes', !M.todayView(items, NOW).needs.some((x) => x.item.id === bill.id) && !M.money(items, NOW, NOW).dueSoon.some((x) => x.id === bill.id));
  ok('snooze: it comes back after the time', M.todayView(items, NOW + 2 * 86400000 + 1000).needs.some((x) => x.item.id === bill.id));
  await actions.applyAction(bill.id, 'done', {}); items = await g.query();
  ok('done: a paid bill counts as Paid in the month header', M.money(items, NOW, NOW).paid === 1840);

  // ---- badges ----
  const bd = M.badges(items, NOW);
  ok('badges: counts come from the same selectors', bd.today === M.todayView(items, NOW).needs.length && bd.inbox === M.inboxView(items, NOW).groups.needs.length && bd.money === 0, bd); // ČEZ paid, Vodafone due in 9 days

  // ---- local connector ----
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  ls.setItem('daylight-wallet', JSON.stringify([
    { id: 'p1', kind: 'tickets', title: 'PRG → BER', travelAt: '2026-11-07T08:30:00+01:00', flight: { from: 'PRG', to: 'BER', pnr: 'ABC123' }, qrPayload: 'ABC123', qrImage: 'https://x.invalid/qr.png' },
    { id: 'p2', kind: 'documents', title: 'Passport', expires: '2027-01-01' },
    { id: 'p3', kind: 'tickets', title: 'Scanned', scanSource: 'camera', qrPayload: 'REAL', qrImage: 'data:image/png;base64,AAA' }]));
  ls.setItem('daylight-personal-tasks', JSON.stringify([{ id: 'u1', title: 'Call the lab', dueDate: '2026-11-06T10:00:00', hasTime: true }, { id: 'u2', title: 'AI suggestion', suggested: true }]));
  const g2 = IG.createGraph({ backend: 'memory', now });
  const lc = LC.createLocalConnector({ graph: g2, now, localStorage: ls });
  const r1 = await lc.importLocal(); const r2 = await lc.importLocal();
  let li = await g2.query();
  ok('local: passes and own tasks become Items; AI suggestions do not', r1.passes === 3 && r1.tasks === 1 && li.length === 4);
  ok('local: import twice → no duplicates', r2.passes === 3 && (await g2.query()).length === 4);
  ok('local: a code is kept only when authentic (scan), never invented from a PNR; only its value is carried (drawn locally), never a stored image URL', !li.find((x) => x.title === 'PRG → BER').meta.codeText && li.find((x) => x.title === 'Scanned').meta.codeText === 'REAL' && !li.find((x) => x.title === 'Scanned').meta.qrImage);
  ok('local: documents are identity-class and excluded from AI', li.find((x) => x.type === 'document').aiExclude === true);
  const tk = li.find((x) => x.type === 'task');
  ok('local: a task with a time keeps it', M.timed(tk) && M.hm(tk.dueAt) === '10:00');
  await AC.createActions({ graph: g2, classifier: CL }).applyAction(tk.id, 'done', {});
  await lc.importLocal();
  ok('local: done in Daylight survives the next import', (await g2.getItem(tk.id)).status === 'done');
  ls.setItem('daylight-wallet', JSON.stringify([{ id: 'p3', kind: 'tickets', title: 'Scanned', scanSource: 'camera' }]));
  const r3 = await lc.importLocal();
  ok('local: a pass removed from the Wallet loses its Item', r3.removed === 2 && (await g2.query({ type: ['ticket', 'document'] })).length === 1);
  const nt = await lc.createTask({ title: 'Reply to Petra', relatedTo: tk.id, plannedAt: NOW + 3600000, minutes: 25 });
  ok('local: V2 tasks are graph-only, planned and linked', nt.type === 'task' && nt.plannedAt === NOW + 3600000 && nt.relatedItemIds.includes(tk.id));
  await lc.importLocal();
  ok('local: reconcile never touches V2-created tasks', !!(await g2.getItem(nt.id)));

  // a pass saved from an email that also produced a booking Item is merged into that booking (no duplicate in Wallet)
  const g3 = IG.createGraph({ backend: 'memory', now });
  await g3.upsertMany([{ key: 'gmail:a:m1', accountId: 'a', type: 'email', title: 'Your ticket', sources: [{ app: 'gmail', accountId: 'a', itemId: 'm1' }] }, { key: 'booking:a:ABX', accountId: 'a', type: 'booking', title: 'Train Praha → Wien', dueAt: NOW + 86400000, sources: [{ app: 'gmail', accountId: 'a', itemId: 'm1', role: 'evidence' }] }]);
  await g3.link(IG.itemId('gmail:a:m1'), IG.itemId('booking:a:ABX'), 'evidence', 'a');
  const st3 = new Map(); const ls3 = { getItem: (k) => (st3.has(k) ? st3.get(k) : null), setItem: (k, v) => st3.set(k, String(v)) };
  ls3.setItem('daylight-wallet', JSON.stringify([{ id: 'w9', kind: 'tickets', title: 'ČD ticket', mailId: 'm1', travelAt: new Date(NOW + 86400000).toISOString(), scanSource: 'attachment', qrPayload: 'Q', qrImage: 'data:image/png;base64,QQ' }]));
  const lc3 = LC.createLocalConnector({ graph: g3, now, localStorage: ls3, mailKey: (mid) => 'gmail:a:' + mid });
  await lc3.importLocal(); await lc3.importLocal();
  const b3 = await g3.getItem(IG.itemId('booking:a:ABX'));
  ok('local: a pass from a booking email merges into that booking (one Item, both sources, real code value kept)', (await g3.query({ type: 'ticket' })).length === 0 && b3.sources.some((x) => x.app === 'wallet') && b3.sources.some((x) => x.app === 'gmail') && b3.meta.codeText === 'Q' && !b3.meta.qrImage);
  ls3.setItem('daylight-wallet', '[]'); await lc3.importLocal();
  const b4 = await g3.getItem(IG.itemId('booking:a:ABX'));
  ok('local: removing that pass keeps the booking (Gmail still supports it)', b4 && !b4.sources.some((x) => x.app === 'wallet'));

  console.log(`V2 model unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
