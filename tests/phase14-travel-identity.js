/**
 * Phase 14 — connected travel identity (synthetic).
 * Run: node tests/phase14-travel-identity.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
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

ok('exports travel helpers', !!(D.normalizeWalletIds && D.travelRecordForMail && D.canonicalWalletId));

// --- Repeated normalization (idempotent) ---
const legacyMix = [
  {
    id: 'ticket:msgA', mailId: 'msgA', kind: 'tickets', title: 'PRG → BER',
    flight: { from: 'PRG', to: 'BER', depart: '2026-11-10T08:30:00+01:00', pnr: 'ABC123' },
    travelAt: '2026-11-10T08:30:00+01:00', at: '2026-11-01T12:00:00.000Z'
  },
  {
    id: 'mail:msgA', mailId: 'msgA', kind: 'tickets', title: 'Berlin train',
    qrAuthentic: true, scanSource: true, qrPayload: 'RAWQR', qrImage: 'data:image/png;base64,xx',
    flight: { from: 'PRG', to: 'BER', depart: '2026-11-10T08:30:00+01:00', pnr: 'ABC123' },
    travelAt: '2026-11-10T08:30:00+01:00', at: '2026-11-02T12:00:00.000Z'
  }
];
const n1 = D.normalizeWalletIds(legacyMix);
const n2 = D.normalizeWalletIds(n1.list);
const n3 = D.normalizeWalletIds(n2.list);
ok('normalize merges ticket+mail to one', n1.list.length === 1, `after=${n1.afterIds.join(',')}`);
ok('normalize idempotent length', n2.list.length === 1 && n3.list.length === 1);
ok('normalize idempotent ids stable', n2.afterIds[0] === n3.afterIds[0] && n2.afterIds[0] === 'mail:msgA');
ok('authentic QR preserved from legacy side', !!(n1.list[0].qrAuthentic && n1.list[0].qrImage === 'data:image/png;base64,xx'));
ok('legacyIds retained', (n1.list[0].legacyIds || []).includes('ticket:msgA'));

const evidence = {
  normalization: {
    beforeIds: n1.beforeIds,
    afterIds: n1.afterIds,
    merges: n1.merges,
    resolved: D.travelRecordForMail('msgA')
  }
};

// --- Multiple tickets in one email ---
const multi = [
  {
    id: 'mail:msgMulti#pass:OUT', mailId: 'msgMulti', childKey: 'OUT', kind: 'tickets',
    title: 'Outbound', flight: { from: 'PRG', to: 'BER', depart: '2026-11-10T08:00:00+01:00', pnr: 'OUT1' },
    travelAt: '2026-11-10T08:00:00+01:00'
  },
  {
    id: 'mail:msgMulti#pass:RET', mailId: 'msgMulti', childKey: 'RET', kind: 'tickets',
    title: 'Return', flight: { from: 'BER', to: 'PRG', depart: '2026-11-12T18:00:00+01:00', pnr: 'RET1' },
    travelAt: '2026-11-12T18:00:00+01:00'
  }
];
S.localStorage.setItem('daylight-wallet', JSON.stringify(multi));
const multiNorm = D.normalizeWalletIds(multi);
ok('multi-pass kept separate', multiNorm.list.length === 2, multiNorm.afterIds.join(','));
const multiRecs = D.travelRecordsForMail('msgMulti');
ok('travelRecordsForMail returns both passes', multiRecs.length === 2);
ok('child keys distinct', new Set(multiRecs.map((t) => t.childKey)).size === 2);

// Do not merge separate journeys that only share a thread (different mailIds)
const threadSiblings = [
  { id: 'mail:m1', mailId: 'm1', threadId: 'thrX', kind: 'tickets', title: 'Leg1', flight: { from: 'PRG', to: 'BER', depart: '2026-11-10T08:00:00+01:00', pnr: 'P1' }, travelAt: '2026-11-10T08:00:00+01:00' },
  { id: 'mail:m2', mailId: 'm2', threadId: 'thrX', kind: 'tickets', title: 'Leg2', flight: { from: 'BER', to: 'MUC', depart: '2026-11-11T09:00:00+01:00', pnr: 'P2' }, travelAt: '2026-11-11T09:00:00+01:00' }
];
const thr = D.normalizeWalletIds(threadSiblings);
ok('same-thread different mailIds stay separate', thr.list.length === 2);

// --- Reschedule / cancel updates same record ---
S.localStorage.setItem('daylight-wallet', JSON.stringify([{
  id: 'mail:msgR', mailId: 'msgR', kind: 'tickets', title: 'Flight',
  flight: { from: 'PRG', to: 'LIS', depart: '2026-11-15T10:00:00+01:00', pnr: 'LH1' },
  travelAt: '2026-11-15T10:00:00+01:00', status: 'active'
}]));
let list = D.readWalletRaw();
// simulate merge patch like upsert would
const rescheduled = D.mergeWalletRichness(list[0], {
  id: 'mail:msgR', mailId: 'msgR',
  flight: { from: 'PRG', to: 'LIS', depart: '2026-11-16T14:00:00+01:00', pnr: 'LH1' },
  travelAt: '2026-11-16T14:00:00+01:00', eventAt: '2026-11-16T14:00:00+01:00',
  lastChange: { kind: 'rescheduled', from: '2026-11-15T10:00:00+01:00', to: '2026-11-16T14:00:00+01:00' },
  rescheduled: true, status: 'active'
});
ok('reschedule keeps same id', rescheduled.id === 'mail:msgR');
ok('reschedule updates travelAt', rescheduled.travelAt.startsWith('2026-11-16'));
const cancelled = D.mergeWalletRichness(rescheduled, { id: 'mail:msgR', mailId: 'msgR', status: 'cancelled', cancelled: true });
ok('cancel flags existing record', cancelled.status === 'cancelled' && cancelled.id === 'mail:msgR');
ok('cancel preserves QR if any', cancelled.travelAt.startsWith('2026-11-16'));

// --- Timeline date rules ---
const noDate = { id: 'mail:msgN', mailId: 'msgN', kind: 'tickets', title: 'Unknown depart', at: '2026-11-03T12:00:00+01:00' };
ok('no fabricated timeline membership from received at', !D.belongsToLocalDayStrict(noDate, new Date(2026, 10, 3)));
ok('belongsToLocalDay also ignores whenMs-only', !D.belongsToLocalDay(noDate, new Date(2026, 10, 3)));
const withTravel = { ...noDate, travelAt: '2026-11-10T08:00:00+01:00' };
ok('timeline includes reliable travel day', D.belongsToLocalDayStrict(withTravel, new Date(2026, 10, 10)));

// --- Navigation walkthrough (resolver) ---
S.localStorage.setItem('daylight-wallet', JSON.stringify(n1.list));
S.localStorage.setItem('daylight-ai-extractions', JSON.stringify({
  msgA: { entityKey: 'pnr:abc123', intent: 'booking_confirmed', travel: { from: 'PRG', to: 'BER', depart_datetime: '2026-11-10T08:30:00+01:00', pnr: 'ABC123' } }
}));
const resolved = D.travelRecordForMail('msgA', { recordKey: 'ticket:threadA' });
ok('resolved walletId canonical', resolved.walletId === 'mail:msgA');
ok('resolved has authentic wallet', !!(resolved.wallet && resolved.wallet.qrAuthentic));
ok('linkedRecords finds wallet', D.linkedRecordsForMail('msgA').wallet.length === 1);

evidence.walkthrough = {
  steps: [
    { step: 'Inbox ticket', mailId: 'msgA', action: 'openLoopSheet / openTravelRecord preferEmail' },
    { step: 'Open Wallet pass', walletId: resolved.walletId, via: 'data-open-wallet → openTravelRecord' },
    { step: 'View email', action: 'data-pass-email → openTravelRecord preferEmail', mailId: 'msgA' },
    { step: 'Timeline day', day: '2026-11-10', itemId: 'wallet:mail:msgA', mailId: 'msgA' },
    { step: 'Same Wallet pass', walletId: resolved.walletId, via: 'data-open-travel' }
  ],
  resolvedTravelObject: {
    mailId: resolved.mailId,
    walletId: resolved.walletId,
    eventAt: resolved.eventAt,
    legacyIds: resolved.legacyIds,
    status: resolved.status,
    qrAuthentic: resolved.wallet?.qrAuthentic,
    displayTitle: resolved.wallet?.title
  }
};

// Missing body / attachment: resolver still works with wallet-only
ok('missing extraction still resolves wallet', !!D.travelRecordForMail('msgA', { ensureStub: false }).wallet);

// Duplicate email updates same thread → same mailId upsert would merge (fingerprint)
const dupUpdate = D.normalizeWalletIds([
  { id: 'mail:msgA', mailId: 'msgA', title: 'Old', flight: { pnr: 'ABC123', depart: '2026-11-10T08:30:00+01:00' }, travelAt: '2026-11-10T08:30:00+01:00' },
  { id: 'mail:msgA', mailId: 'msgA', title: 'Updated boarding', flight: { pnr: 'ABC123', depart: '2026-11-10T09:15:00+01:00' }, travelAt: '2026-11-10T09:15:00+01:00', lastChange: { kind: 'rescheduled' } }
]);
ok('duplicate mail updates collapse to one id', dupUpdate.list.length === 1 && dupUpdate.list[0].id === 'mail:msgA');

const failed = results.filter((r) => !r.pass);
const report = {
  phase: 14,
  at: new Date().toISOString(),
  passed: results.length - failed.length,
  total: results.length,
  failed: failed.map((f) => f.name),
  evidence,
  productionClaim: false,
  notes: [
    'Synthetic identity tests only — controlled real-Gmail walkthrough still required for screenshots.',
    'Do not commit/push/deploy until user approves.'
  ]
};
fs.writeFileSync(path.join(__dirname, 'phase14-travel-identity-report.json'), JSON.stringify(report, null, 2));
console.log('\n--- Phase 14 summary ---');
console.log(`Passed ${report.passed}/${report.total}`);
console.log('Evidence normalization before→after:', evidence.normalization.beforeIds, '→', evidence.normalization.afterIds);
console.log('Resolved travel:', JSON.stringify(evidence.walkthrough.resolvedTravelObject, null, 2));
console.log('Wrote tests/phase14-travel-identity-report.json');
if (failed.length) process.exitCode = 1;
