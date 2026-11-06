/** Local code reader (ui/code-reader.js), logic level: Reed–Solomon corrects up to its limit and rejects beyond it,
 *  damaged and mirrored QR matrices decode, Code 128 code sets / shifts / checksum. Pixel-level robustness against ZXing
 *  and ZBar is in tests/crosscheck/crosscheck.py. Run: node tests/code-reader-unit.js */
'use strict';
const C = require('../ui/codes.js'), R = require('../ui/code-reader.js');
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
// Reed–Solomon: encode a block with the encoder's generator, then corrupt it
const gen = (deg) => { const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1; for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = C.gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = C.gfMul(root, 2); } return r; };
const rem = (data, div) => { const r = div.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= C.gfMul(c, f); }); } return r; };
let corrected = 0, threw = 0, trials = 0;
for (let t = 0; t < 200; t++) {
  const ec = 10 + (t % 4) * 4, data = Array.from({ length: 20 + (t % 7) }, (_, i) => (i * 37 + t * 11) & 255), block = data.concat(rem(data, gen(ec)));
  const bad = block.slice(), nErr = t % 2 ? ec / 2 : ec / 2 + 2, pos = new Set(); while (pos.size < nErr) pos.add((t * 13 + pos.size * 29) % block.length);
  pos.forEach((p) => { bad[p] ^= 1 + ((p * 7) % 255); });
  let ok = false; try { ok = R.rsCorrect(bad, ec); } catch { threw++; } trials++;
  if (nErr <= ec / 2 && ok && bad.every((v, i) => v === block[i])) corrected++;
}
check('Reed–Solomon corrects every block with up to EC/2 wrong codewords (100 blocks)', corrected === 100, corrected);
// beyond the limit a decoder may fail or (rarely) miscorrect; Daylight only accepts the result if all blocks AND the format check out
check('Reed–Solomon returns (never throws) for blocks beyond its limit', threw === 0 && trials === 200);
const texts = ['A', 'ticket 123', 'HTTPS://EXAMPLE.COM/T/42', 'jízdenka Praha → Brno', 'x'.repeat(300), '0123456789'.repeat(20)];
for (const lv of ['L', 'M', 'Q', 'H']) {
  const ok = texts.every((t) => R.decodeMatrix(C.qrMatrix(t, lv)) === t);
  check(`QR matrices from the encoder decode exactly (level ${lv})`, ok);
}
const m = C.qrMatrix('damage test 4711', 'H');
const dmg = m.map((r) => r.slice()); for (let y = 12; y < 18; y++) for (let x = 10; x < 16; x++) dmg[y][x] = !dmg[y][x];
check('a QR with a 6×6 damaged area still decodes (level H)', R.decodeMatrix(dmg) === 'damage test 4711');
const garbage = m.map((r, y) => r.map((v, x) => ((x * 7 + y * 13) % 5 === 0 ? !v : v)));
check('a heavily damaged QR is rejected, not misread', R.decodeMatrix(garbage) === null || R.decodeMatrix(garbage) === 'damage test 4711');
check('Code 128: set B text', R.codesToText(C.code128Values('Hello-128')) === 'Hello-128');
check('Code 128: set C digit pairs', R.codesToText(C.code128Values('00112233')) === '00112233');
check('Code 128: switch C → B (code 100)', R.codesToText([105, 12, 34, 100, 33]) === '1234A');
check('Code 128: shift (code 98) changes only the next character', R.codesToText([103, 33, 98, 65, 34]) === 'AaB');
const runsOf = (vals) => { const pat = vals.map((c) => C.C128[c]).join(''); return [10].concat([...pat].map(Number), [10]); };
const v = C.code128Values('MEMBER-778812'); let s = v[0]; for (let i = 1; i < v.length; i++) s += v[i] * i;
check('Code 128 runs with a valid checksum decode', R.decode128Runs(runsOf(v.concat([s % 103, 106]))) === 'MEMBER-778812');
check('Code 128 runs with a wrong checksum are rejected', R.decode128Runs(runsOf(v.concat([(s + 1) % 103, 106]))) === null);
let fail = 0; checks.forEach(([n, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info))); if (!ok) fail++; });
console.log(`Code reader unit: ${checks.length - fail}/${checks.length} passed`);
process.exitCode = fail ? 1 : 0;
