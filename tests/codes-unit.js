/** Local QR / Code 128 drawing (ui/codes.js): capacities match the QR standard, structure is valid, nothing external. Run: node tests/codes-unit.js
 *  Decoding by an independent reader is checked separately with OpenCV: python3 tests/codes-decode-check.py */
'use strict';
const C = require('../ui/codes.js');
const checks = []; const check = (n, ok, info) => checks.push([n, !!ok, info]);
const ver = (m) => (m.length - 17) / 4;
const maxBytes = (level, v) => { let n = 1; while (C.qrMatrix('a'.repeat(n + 1), level) && ver(C.qrMatrix('a'.repeat(n + 1), level)) <= v) n++; return n; };
// byte-mode capacities from ISO/IEC 18004 table 7
const CAP = { L: { 1: 17, 2: 32, 10: 271, 40: 2953 }, M: { 1: 14, 2: 26, 10: 213, 40: 2331 }, Q: { 1: 11, 2: 20, 10: 151, 40: 1663 }, H: { 1: 7, 2: 14, 10: 119, 40: 1273 } };
for (const [lv, caps] of Object.entries(CAP)) for (const [v, n] of Object.entries(caps)) {
  const atCap = C.qrMatrix('a'.repeat(n), lv), over = C.qrMatrix('a'.repeat(n + 1), lv);
  check(`capacity ${lv} v${v}: ${n} bytes fit, ${n + 1} do not`, atCap && ver(atCap) === Number(v) && (over === null || ver(over) === Number(v) + 1), { at: atCap && ver(atCap), over: over && ver(over) });
}
const m = C.qrMatrix('HELLO WORLD', 'M'), n = m.length;
const finderOk = (x0, y0) => { for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { const d = Math.max(Math.abs(x - 3), Math.abs(y - 3)); if (m[y0 + y][x0 + x] !== (d !== 2)) return false; } return true; };
check('three finder patterns', finderOk(0, 0) && finderOk(n - 7, 0) && finderOk(0, n - 7));
check('timing patterns alternate', [...Array(n - 16)].every((_, i) => m[6][8 + i] === ((8 + i) % 2 === 0) && m[8 + i][6] === ((8 + i) % 2 === 0)));
check('dark module present', m[n - 8][8] === true);
// both copies of the 15-bit format information agree and decode to level M
const f1 = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => m[y][8]).concat([7, 5, 4, 3, 2, 1, 0].map((x) => m[8][x]));
const f2 = [...Array(8)].map((_, i) => m[8][n - 1 - i]).concat([...Array(7)].map((_, i) => m[n - 7 + i][8]));
const bits = (a) => a.reduce((acc, b, i) => acc | ((b ? 1 : 0) << i), 0);
const fmt = bits(f1) ^ 0x5412;
check('format information: both copies equal, level M', bits(f1) === bits(f2) && ((fmt >>> 13) & 3) === 0, { f1: bits(f1), f2: bits(f2) });
check('UTF-8 text is encoded (Czech diacritics)', !!C.qrMatrix('jízdenka Praha → Brno', 'M'));
check('too long for any QR → null, not a broken code', C.qrMatrix('x'.repeat(4000), 'L') === null);
const svg = C.qrSvg('ticket 123');
check('QR SVG is self-contained (no external URL)', /^<svg/.test(svg) && !/https?:\/\/(?!www\.w3\.org)/.test(svg) && !/<image|href=/.test(svg));
check('deterministic', C.qrSvg('same') === C.qrSvg('same'));
// Code 128
const widths = C.C128.map((w) => [...w].reduce((a, b) => a + Number(b), 0));
check('Code 128 table: 107 patterns, each 11 modules (stop 13)', C.C128.length === 107 && widths.every((w, i) => w === (i === 106 ? 13 : 11)));
const patterns = C.C128.map((w) => { let s = '', b = 1; for (const c of w) { s += (b ? '1' : '0').repeat(Number(c)); b ^= 1; } return s; });
check('Code 128 table: all patterns distinct, even bar parity', new Set(patterns).size === 107 && C.C128.slice(0, 106).every((w) => (Number(w[0]) + Number(w[2]) + Number(w[4])) % 2 === 0));
check('Code 128 known patterns (start B, start C, stop, "A", "0")', C.C128[104] === '211214' && C.C128[105] === '211232' && C.C128[106] === '2331112' && C.C128[33] === '111323' && C.C128[16] === '123122');
check('Code 128: text uses set B, even digit runs use set C', C.code128Values('AB1')[0] === 104 && C.code128Values('12345678')[0] === 105 && C.code128Values('12345678').length === 5);
check('Code 128: characters outside set B are refused (no wrong barcode)', C.code128Values('Příliš') === null);
check('render(): QR and Code 128 drawn; PDF417 / Aztec refused', C.render('X', 'qr_code').kind === 'qr' && C.render('AB-1', 'code_128').kind === 'code128' && C.render('X', 'pdf417') === null && C.render('X', 'aztec') === null);
let fail = 0; checks.forEach(([nm, ok, info]) => { console.log((ok ? 'PASS ' : 'FAIL ') + nm + (ok || info === undefined ? '' : '  ← ' + JSON.stringify(info))); if (!ok) fail++; });
console.log(`Codes unit: ${checks.length - fail}/${checks.length} passed`);
process.exitCode = fail ? 1 : 0;
