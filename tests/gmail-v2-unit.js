/**
 * Unit checks for the v2 cost modules: scheduler (slots, catch-up = one sync, 15-min skip, cross-tab lock),
 * cache (account isolation, label-only, tombstones, domain learning), batch build/parse, AI budget (cleaning,
 * strict JSON, daily cap, deferral), rules (JSON-LD, microdata, escalation). Synthetic data only.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'sync-scheduler.js'));
const MC = require(path.join(ROOT, 'gmail-cache.js'));
const BT = require(path.join(ROOT, 'gmail-batch.js'));
const AB = require(path.join(ROOT, 'ai-budget.js'));
const R = require(path.join(ROOT, 'gmail-rules.js'));
const CFG = require(path.join(ROOT, 'gmail-config.js'));
const checks = [];
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok }); if (!ok) console.log('  FAIL', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''); };

(async () => {
  const cfg = CFG.resolve();
  const TZ = 'Europe/Prague';
  const at = (iso) => Date.parse(iso);
  // ---- scheduler ----
  const sc = cfg.schedule;
  const slotsToday = S.slotInstants(at('2026-11-04T00:00:00+01:00'), at('2026-11-04T23:59:00+01:00'), sc.slots, TZ).map((t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }));
  ck('Five default slots in local time', JSON.stringify(slotsToday) === JSON.stringify(['07:00', '10:30', '13:30', '17:30', '21:30']), slotsToday);
  const dst = S.slotInstants(at('2026-03-29T00:00:00+01:00'), at('2026-03-29T23:59:00+02:00'), ['07:00'], TZ).map((t) => new Date(t).toISOString());
  ck('DST day: 07:00 local stays 07:00 (05:00Z in summer time)', dst[0] === '2026-03-29T05:00:00.000Z', dst);
  let d = S.decide({ trigger: 'open', now: at('2026-11-04T14:00:00+01:00'), lastSyncAt: at('2026-11-03T22:00:00+01:00'), schedule: sc, tz: TZ });
  ck('App opened after missing 07:00, 10:30, 13:30 → exactly one catch-up sync', d.run && d.label === 'catch-up' && d.missed === 3, d);
  d = S.decide({ trigger: 'open', now: at('2026-11-04T14:00:00+01:00'), lastSyncAt: at('2026-11-04T13:50:00+01:00'), schedule: sc, tz: TZ });
  ck('Open within 15 min of a sync → skipped', !d.run, d);
  d = S.decide({ trigger: 'manual', now: at('2026-11-04T14:00:00+01:00'), lastSyncAt: at('2026-11-04T13:59:00+01:00'), schedule: sc, tz: TZ });
  ck('Manual refresh always runs', d.run && d.label === 'manual', d);
  d = S.decide({ trigger: 'slot', now: at('2026-11-04T13:31:00+01:00'), lastSyncAt: at('2026-11-04T13:30:30+01:00'), schedule: sc, tz: TZ, slotAt: at('2026-11-04T13:30:00+01:00') });
  ck('Slot already handled by another tab → skipped', !d.run, d);
  d = S.decide({ trigger: 'open', now: at('2026-11-04T08:00:00+01:00'), lastSyncAt: at('2026-11-04T07:10:00+01:00'), schedule: sc, tz: TZ });
  ck('Open with no missed slot and last sync > 15 min → open-refresh', d.run && d.label === 'open-refresh', d);
  const nx = S.nextSlot(at('2026-11-04T21:45:00+01:00'), sc.slots, TZ);
  ck('Next slot after 21:45 is tomorrow 07:00', new Date(nx).toISOString() === '2026-11-05T06:00:00.000Z', new Date(nx).toISOString());

  // ---- lock: two "tabs" sharing storage (lease fallback) and Web Locks semantics ----
  const store = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } };
  const A = S.createLock({ name: 'x', locks: null, storage: store, id: 'A', settleMs: 5 }), Bk = S.createLock({ name: 'x', locks: null, storage: store, id: 'B', settleMs: 5 });
  let running = 0, maxRun = 0;
  const job = async () => { running++; maxRun = Math.max(maxRun, running); await new Promise((r) => setTimeout(r, 40)); running--; return 1; };
  const [ra, rb] = await Promise.all([A.withLock(job), new Promise((r) => setTimeout(() => r(Bk.withLock(job)), 10))]);
  ck('Lease lock: second tab does not start a parallel sync', maxRun === 1 && ra.ran && !rb.ran, { maxRun, ra, rb });
  const rc = await Bk.withLock(job);
  ck('Lease lock released after the first sync', rc.ran, rc);
  const fakeLocks = { held: new Set(), async request(name, o, fn) { if (this.held.has(name)) return fn(null); this.held.add(name); try { return await fn({ name }); } finally { this.held.delete(name); } } };
  const W1 = S.createLock({ name: 'y', locks: fakeLocks }), W2 = S.createLock({ name: 'y', locks: fakeLocks });
  running = 0; maxRun = 0;
  const [w1, w2] = await Promise.all([W1.withLock(job), new Promise((r) => setTimeout(() => r(W2.withLock(job)), 5))]);
  ck('Web Locks: ifAvailable — no overlap across tabs', maxRun === 1 && w1.ran && !w2.ran, { w1, w2 });
  const same = S.createLock({ name: 'z', locks: null, storage: null });
  const [s1, s2] = await Promise.all([same.withLock(job), same.withLock(job)]);
  ck('Same tab: re-entrant trigger is refused while syncing', s1.ran && !s2.ran);

  // ---- cache ----
  const c = MC.createMailCache({});
  await c.putMany('a1', [{ messageId: 'm1', threadId: 't1', labels: ['INBOX'], status: 'classified', category: 'bill' }]);
  await c.putMany('a2', [{ messageId: 'm1', threadId: 't9', labels: ['INBOX'], status: 'classified', category: 'promotion' }]);
  ck('Account isolation: same message id in two accounts stays separate', (await c.all('a1'))[0].category === 'bill' && (await c.all('a2'))[0].category === 'promotion');
  await c.updateLabels('a1', [{ id: 'm1', labels: ['STARRED'] }]);
  ck('Label-only update changes labels and nothing else', JSON.stringify((await c.all('a1'))[0].labels) === '["STARRED"]' && (await c.all('a1'))[0].category === 'bill');
  await c.putFacts('a1', [{ messageId: 'm1', kind: 'bill', fields: { amount: { value: 10, currency: 'EUR' } } }]);
  await c.markDeleted('a1', ['m1']);
  ck('Deleted message → tombstone; extracted facts kept', (await c.all('a1'))[0].status === 'deleted' && (await c.allFacts('a1')).length === 1);
  for (let i = 0; i < 2; i++) await c.recordDomainCategory('a1', 'booking.com', 'travel', 'ai', { threshold: 3 });
  ck('Domain learning: not active before N=3', !(await c.getDomainCategory('a1', 'booking.com')));
  await c.recordDomainCategory('a1', 'booking.com', 'travel', 'ai', { threshold: 3 });
  ck('Domain learning: active after 3 consistent AI results', (await c.getDomainCategory('a1', 'booking.com'))?.category === 'travel');
  await c.recordDomainCategory('a1', 'mixed.com', 'travel', 'ai', { threshold: 3 }); await c.recordDomainCategory('a1', 'mixed.com', 'travel', 'ai', { threshold: 3 }); await c.recordDomainCategory('a1', 'mixed.com', 'receipt', 'ai', { threshold: 3 }); await c.recordDomainCategory('a1', 'mixed.com', 'travel', 'ai', { threshold: 3 });
  ck('Domain learning: conflicting votes keep the rule off', !(await c.getDomainCategory('a1', 'mixed.com')));
  await c.recordDomainCategory('a1', 'mixed.com', 'receipt', 'user');
  ck('User choice activates the domain immediately', (await c.getDomainCategory('a1', 'mixed.com'))?.source === 'user');
  const doms = await c.allDomains('a1');
  ck('Domain cache stores only domain → category (no content)', doms.every((x) => Object.keys(x).every((k) => ['accountId', 'domain', 'votes', 'hits', 'category', 'source', 'active', 'userCategory', 'at'].includes(k))), doms);
  await c.clearAccount('a2');
  ck('Clear mail cache affects only that account', (await c.all('a2')).length === 0 && (await c.all('a1')).length === 1);

  // ---- batch ----
  const b = BT.buildBatch([{ id: 'a', path: '/gmail/v1/users/me/messages/a?format=metadata' }, { id: 'b', path: '/gmail/v1/users/me/messages/b?format=metadata' }], 'bnd');
  ck('Batch body has one application/http part per request', (b.body.match(/application\/http/g) || []).length === 2 && b.contentType === 'multipart/mixed; boundary=bnd');
  const resp = '--resp\r\nContent-Type: application/http\r\nContent-ID: <response-item-a>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"a"}\r\n--resp\r\nContent-Type: application/http\r\nContent-ID: <response-item-b>\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\n\r\n{"error":{"code":429,"message":"rate","errors":[{"reason":"rateLimitExceeded"}]}}\r\n--resp--';
  const pm = BT.parseBatch(resp, 'multipart/mixed; boundary=resp');
  ck('Batch parse: per-part status, JSON, Retry-After and reason', pm.get('a').ok && pm.get('a').data.id === 'a' && pm.get('b').status === 429 && pm.get('b').retryAfterMs === 2000 && pm.get('b').reason === 'rateLimitExceeded', [...pm]);

  // ---- AI budget ----
  const raw = '<html><body><p>Your booking ABC123 is confirmed for 14 Nov.</p><p>Total €82.</p><a href="https://track.example.com/click?u=abc&utm_source=x">View</a><p>Unsubscribe | Privacy policy</p></body></html>\n\nOn Mon, 2 Nov 2026 at 10:00 Someone <x@y.z> wrote:\n> old text\n> more';
  const cl = AB.cleanForAi(raw, 2000);
  ck('Cleaning strips HTML, tracking links, footers and quoted replies', !/<|utm_|Unsubscribe|old text/.test(cl.text) && /ABC123/.test(cl.text) && /€82/.test(cl.text), cl);
  ck('Truncation to maxChars', AB.cleanForAi('x'.repeat(5000), 2000).text.length === 2000);
  ck('Strict JSON: valid schema accepted', AB.parseStrict('{"category":"travel","intent":"booking_confirmed","confidence":0.9,"summary":"Flight","fields":{"pnr":{"value":"ABC123","confidence":0.95}},"requires_confirmation":false}').ok);
  ck('Strict JSON: invalid JSON rejected', !AB.parseStrict('{category: travel}').ok);
  ck('Strict JSON: field without confidence rejected', !AB.parseStrict('{"category":"travel","intent":"x","confidence":0.9,"summary":"s","fields":{"pnr":{"value":"A"}}}').ok);
  const cache2 = MC.createMailCache({});
  const bud = AB.createAiBudget({ cache: cache2, config: CFG.resolve({ ai: { dailyRequestCap: 2 } }) });
  ck('Never re-run AI on an unchanged bodyHash', !bud.wants({ aiEnabled: true, highValue: true, missing: ['amount'], confidence: 0.5, bodyHash: 'h1', prevAiHash: 'h1' }).send);
  ck('Financial mail not sent unless opted in', !bud.wants({ aiEnabled: true, highValue: true, financial: true, allowFinancial: false, missing: ['amount'], confidence: 0.5 }).send);
  ck('Complete + confident → no AI', !bud.wants({ aiEnabled: true, highValue: true, complete: true, confidence: 0.95, missing: [] }).send);
  await bud.record('a', { inputTokens: 800, outputTokens: 250 }); await bud.record('a', { inputTokens: 800, outputTokens: 250 });
  ck('Daily cap: third request deferred', !(await bud.canSpend('a', 500)).ok);
  const usd = bud.costUsd('gemini-3.5-flash-lite', 1e6, 0, 'live');
  ck('Cost from the price table (not hard-coded)', Math.abs(usd - cfg.ai.prices['gemini-3.5-flash-lite'].input) < 1e-9 && Math.abs(bud.costUsd('gemini-3.5-flash-lite', 1e6, 0, 'batch') - usd * 0.5) < 1e-9);
  ck('Gemini batch submission disabled by default', (await bud.submitBatch([{ id: 1 }], async () => ({ submitted: true }))).submitted === false);

  // ---- rules ----
  const b64 = (s) => Buffer.from(s).toString('base64');
  const html = '<script type="application/ld+json">{"@context":"http://schema.org","@type":"FlightReservation","reservationNumber":"QX1","reservationFor":{"@type":"Flight","departureTime":"2026-12-01T10:00:00Z","departureAirport":{"iataCode":"PRG"},"arrivalAirport":{"iataCode":"LIS"}}}</script>';
  const full = { id: 'x', labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'Air <a@air.example>' }, { name: 'Subject', value: 'Trip' }], parts: [{ mimeType: 'text/html', body: { data: b64(html) } }] } };
  const sc1 = R.stageC(full, { category: 'personal', confidence: 0.5 }, {});
  ck('JSON-LD FlightReservation → travel, complete, no AI needed', sc1.category === 'travel' && sc1.complete && sc1.facts.reservationNumber === 'QX1', sc1);
  const micro = '<div itemscope itemtype="http://schema.org/LodgingReservation"><meta itemprop="reservationNumber" content="H77"><meta itemprop="checkinDate" content="2026-12-03"></div>';
  const sc2 = R.stageC({ id: 'y', labelIds: [], payload: { headers: [], parts: [{ mimeType: 'text/html', body: { data: b64(micro) } }] } }, { category: 'other', confidence: 0.5 }, {});
  ck('Microdata LodgingReservation parsed', sc2.category === 'travel' && sc2.facts.reservationNumber === 'H77', sc2.facts);
  const unf = R.stageB({ labelIds: ['INBOX'], snippet: 'Please transfer 4 500 Kč by 30. 11. 2026', payload: { headers: [{ name: 'From', value: 'Neznámý <x@neznamy-spolek.cz>' }, { name: 'Subject', value: 'Členský příspěvek' }] } }, {});
  ck('Unfamiliar sender with money + date is not discarded (body fetched)', unf.needBody, unf);
  const promo = R.stageB({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], snippet: 'Flights to Rome from €19', payload: { headers: [{ name: 'From', value: 'Ryanair <x@email.ryanair.com>' }, { name: 'Subject', value: 'Seat sale' }, { name: 'List-Unsubscribe', value: '<mailto:u>' }] } }, {});
  ck('Bulk travel marketing stays a promotion without a body fetch', promo.category === 'promotion' && !promo.needBody, promo);
  const ambDate = R.extractDueDate('Due date: 03/04/2027');
  ck('Ambiguous dd/mm vs mm/dd due date is never guessed', ambDate && ambDate.date === null && ambDate.ambiguous, ambDate);

  const passed = checks.filter((x) => x.ok).length;
  console.log(`Gmail v2 unit checks: ${passed}/${checks.length} passed`);
  if (passed !== checks.length) process.exitCode = 1;
})();
