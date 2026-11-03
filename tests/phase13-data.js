/**
 * Phase 13 — DaylightData adapter + date/inbox/wallet/QR invariants (synthetic).
 * Run: node tests/phase13-data.js
 * Does not touch real Gmail or mutate production stores.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ' — ' + detail : ''}`);
}

function makeSandbox() {
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      _dump: () => Object.fromEntries(store)
    },
    crypto: crypto.webcrypto,
    Intl, Date, JSON, Math, Number, String, Array, Object, console,
    setTimeout, clearTimeout, Map, Set
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'daylight-data.js'), 'utf8'), sandbox);
  return { sandbox, store };
}

const { sandbox: S } = makeSandbox();
const D = S.DaylightData;
ok('DaylightData exported', !!D && typeof D.eventAt === 'function');

// --- Dates: never invent ---
ok('parseMaybeDate rejects ambiguous', D.parseMaybeDate('next Friday') == null);
ok('parseMaybeDate accepts ISO', !!D.parseMaybeDate('2026-11-03T14:00:00+01:00'));
ok('localDayKey local not UTC', (() => {
  const d = new Date(2026, 10, 3, 23, 30); // Nov 3 local
  return D.localDayKey(d) === '2026-11-03';
})());

const ticket = {
  id: 'w1', kind: 'tickets', title: 'PRG → BER',
  at: '2026-10-01T12:00:00.000Z',
  travelAt: '2026-11-03T08:30:00+01:00',
  flight: { from: 'PRG', to: 'BER', depart: '2026-11-03T08:30:00+01:00', pnr: 'ABC123' },
  qrPayload: 'ABC123', qrImage: 'https://example.invalid/qr.png' // fabricated without authentic flag
};
ok('eventAt prefers travelAt over received at', (() => {
  const ev = D.eventAt(ticket);
  return ev && D.localDayKey(ev) === '2026-11-03';
})());
ok('belongsToLocalDay true for travel day', D.belongsToLocalDay(ticket, new Date(2026, 10, 3)));
ok('belongsToLocalDay false for other day', !D.belongsToLocalDay(ticket, new Date(2026, 10, 4)));

const nw = D.normalizeWalletItem(ticket);
ok('fabricated QR suppressed without authentic flag', nw.fabricatedQrSuppressed === true && nw.qrAuthentic === false);
ok('displayCode falls back to PNR not fake QR payload', nw.displayCode === 'ABC123' || nw.displayCode === ticket.flight.pnr);

const authentic = D.normalizeWalletItem({
  ...ticket, qrAuthentic: true, scanSource: true, qrPayload: 'RAWQRDATA'
});
ok('authentic QR retained', authentic.qrAuthentic === true && authentic.displayCode === 'RAWQRDATA');

// --- Orders recovery ---
S.localStorage.setItem('daylight-orders', JSON.stringify([
  { id: 'o1', merchant: 'Amazon', orderId: 'A-1', deliveryDate: '2026-11-03', status: 'shipped', lastMailId: 'm1', sourceMailIds: ['m1'] },
  { id: 'o2', merchant: 'Zalando', orderId: 'Z-9', deliveryDate: '2026-11-10', status: 'cancelled', lastMailId: 'm2' }
]));
const orders = D.orders();
ok('orders recovered from daylight-orders', orders.length === 2);
const amazon = orders.find((o) => o.id === 'o1' || o.merchant === 'Amazon');
ok('order eventAt from deliveryDate', amazon && D.localDayKey(D.eventAt(amazon)) === '2026-11-03', amazon && D.localDayKey(D.eventAt(amazon)));
const activeOrders = D.orders({ excludeCancelled: true });
ok('excludeCancelled filters refunds/cancels', activeOrders.every((o) => !o.cancelled) && activeOrders.length === 1);

const linked = D.linkedRecordsForMail('m1');
ok('linkedRecordsForMail finds order', linked.orders.length === 1 && linked.orders[0].merchant === 'Amazon');

// --- Inbox buckets / promo exclusion ---
ok('promo label → promotions bucket', D.inboxBucket({ labelIds: ['CATEGORY_PROMOTIONS'], subject: 'Sale' }) === 'promotions');
ok('subscription category maps', D.inboxBucket({ category: 'subscription' }) === 'subscriptions');
ok('bill category maps', D.inboxBucket({ category: 'bill' }) === 'bills');
ok('ticket category maps', D.inboxBucket({ category: 'ticket' }) === 'tickets');
ok('payment receipt heuristic', D.inboxBucket({ category: 'payment', subject: 'Receipt from Apple' }) === 'receipts');
ok('isPromotionalExtraction', D.isPromotionalExtraction({ intent: 'promotional' }));

// --- Wallet status ---
const upcoming = D.walletStatus({ kind: 'tickets', travelAt: '2026-11-03T18:00:00+01:00' }, Date.parse('2026-11-03T10:00:00+01:00'));
ok('walletStatus upcoming for future travel', upcoming === 'upcoming');
const expired = D.walletStatus({ kind: 'tickets', travelAt: '2026-11-01T08:00:00+01:00' }, Date.parse('2026-11-03T10:00:00+01:00'));
ok('walletStatus expired after travel', expired === 'expired');
const cancelled = D.walletStatus({ status: 'cancelled', travelAt: '2026-11-05T08:00:00+01:00' });
ok('walletStatus cancelled', cancelled === 'cancelled');

S.localStorage.setItem('daylight-wallet', JSON.stringify([
  { id: 'w1', kind: 'tickets', title: 'Flight', travelAt: '2026-11-03T08:30:00+01:00', at: '2026-10-01T00:00:00.000Z' },
  { id: 'w2', kind: 'documents', title: 'Passport scan', at: '2026-11-02T00:00:00.000Z', amount: '' },
  { id: 'w3', kind: 'others', title: 'Loyalty', typeLabel: 'Membership', at: '2026-09-01T00:00:00.000Z' }
]));
const sorted = D.walletItems({ filter: 'all' });
ok('wallet sort prefers eventAt first', sorted[0].id === 'w1');
ok('cards filter includes membership', D.walletItems({ filter: 'cards' }).some((i) => i.id === 'w3'));

// --- Same-day brief/timeline invariant helper ---
const day = new Date(2026, 10, 3);
const offDayTicket = { travelAt: '2026-11-04T08:00:00+01:00', at: '2026-11-03T12:00:00+01:00' };
ok('timeline must not use received `at` as day key', !D.belongsToLocalDay(offDayTicket, day) && D.localDayKey(D.parseMaybeDate(offDayTicket.at)) === '2026-11-03');

const failed = results.filter((r) => !r.pass);
console.log('\n--- Phase 13 synthetic summary ---');
console.log(`Passed ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  failed.forEach((f) => console.log('FAIL detail:', f.name, f.detail));
  process.exitCode = 1;
} else {
  console.log('All Phase 13 data-adapter invariants passed.');
}
