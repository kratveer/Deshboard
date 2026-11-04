// Unit checks for mail-dates.js (key-date extraction). Run: node tests/mail-dates-unit.js
const D = require('../mail-dates.js');
const rec = new Date(2026, 10, 3, 10, 0).getTime(); // email received Tue 3 Nov 2026
const cases = [
  ['journal deadline', 'Please submit the revised manuscript by 4 November 2026.', { kind: 'deadline', date: '2026-11-04' }],
  ['czech rent', 'Ahoj, připomínám nájem za listopad, zaplať do 4. 11. 2026 prosím.', { kind: 'deadline', date: '2026-11-04' }],
  ['dentist reminder', 'Reminder: your appointment is on 6 November at 10:30.', { kind: 'reminder', date: '2026-11-06', time: '10:30' }],
  ['boarding pass', 'Boarding pass FR1234 PRG-DUB. Departure today 21:40, gate B4.', { kind: 'travel', date: '2026-11-03', time: '21:40' }],
  ['train', 'Your train ticket: departure 8 Nov 2026 07:05 Praha hl.n.', { kind: 'travel', date: '2026-11-08', time: '07:05' }],
  ['webinar pm', 'The webinar starts on November 12 at 4 pm.', { kind: 'event', date: '2026-11-12', time: '16:00' }],
  ['due date label', 'Invoice 2211. Due date: 2026-11-07. Amount €120.', { kind: 'deadline', date: '2026-11-07' }],
];
const negatives = [
  ['promo price', 'Black Friday sale! Everything 19.99 — save 50% this week only.'],
  ['order date', 'Thanks for your order. Order date: 2 November 2026. Total €480.00.'],
  ['paid on', 'Receipt: paid on 1 November 2026, €12.50.'],
  ['issued', 'Invoice issued 30 October 2026.'],
];
let pass = 0, total = 0;
for (const [name, text, want] of cases) {
  total++;
  const got = D.extract(text, { receivedMs: rec });
  const hit = got.find((g) => g.date === want.date);
  const ok = hit && hit.kind === want.kind && (want.time == null || hit.time === want.time);
  if (ok) pass++; else console.log('FAIL', name, JSON.stringify(got));
}
for (const [name, text] of negatives) {
  total++;
  const got = D.extract(text, { receivedMs: rec });
  if (!got.length) pass++; else console.log('FAIL (should be empty)', name, JSON.stringify(got));
}
// price must never become a time
total++; { const g = D.extract('Payment due 7 Nov 2026, amount €480.00.', { receivedMs: rec }); if (g[0] && g[0].time == null) pass++; else console.log('FAIL price-as-time', JSON.stringify(g)); }
console.log(`mail-dates unit: ${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
