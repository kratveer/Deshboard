/**
 * Daylight — local QR code and Code 128 barcode drawing (no network).
 * Wallet passes show their code as an inline SVG generated here, in the browser, from the stored value.
 * Nothing is sent to an image service. Byte-mode QR (ISO/IEC 18004, versions 1–40, automatic mask) and
 * Code 128 (code sets B and C). Other symbologies (PDF417, Aztec, EAN…) are not redrawn; the caller shows the value as text.
 */
(function (root) {
  'use strict';

  // ---------- QR code ----------
  const ECL = { L: { ord: 0, bits: 1 }, M: { ord: 1, bits: 0 }, Q: { ord: 2, bits: 3 }, H: { ord: 3, bits: 2 } };
  const ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  const NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  const bit = (x, i) => ((x >>> i) & 1) !== 0;

  function rawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
  }
  const dataCodewords = (ver, e) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e.ord][ver] * NUM_BLOCKS[e.ord][ver];

  function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; }
  function rsDivisor(deg) {
    const r = new Array(deg).fill(0); r[deg - 1] = 1; let rootv = 1;
    for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], rootv); if (j + 1 < deg) r[j] ^= r[j + 1]; } rootv = gfMul(rootv, 0x02); }
    return r;
  }
  function rsRemainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
    return r;
  }
  function utf8(s) { const out = []; const e = unescape(encodeURIComponent(String(s))); for (let i = 0; i < e.length; i++) out.push(e.charCodeAt(i)); return out; }

  /** Returns a square boolean matrix (true = dark), or null when the value is too long for a QR code. */
  function qrMatrix(text, level) {
    const e = ECL[level] || ECL.M;
    const bytes = utf8(text);
    let ver = 1;
    for (; ver <= 40; ver++) { const cc = ver <= 9 ? 8 : 16; if (4 + cc + bytes.length * 8 <= dataCodewords(ver, e) * 8) break; }
    if (ver > 40) return null;
    // data bits
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach((b) => put(b, 8));
    const cap = dataCodewords(ver, e) * 8;
    put(0, Math.min(4, cap - bits.length)); put(0, (8 - (bits.length % 8)) % 8);
    for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) put(p, 8);
    const data = []; for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; data.push(v); }
    // error correction + interleaving
    const nb = NUM_BLOCKS[e.ord][ver], eccLen = ECC_PER_BLOCK[e.ord][ver], raw = Math.floor(rawDataModules(ver) / 8);
    const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
      const ecc = rsRemainder(dat, div); if (i < nShort) dat.push(0); blocks.push(dat.concat(ecc));
    }
    const all = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]); });
    // matrix
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy; if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4); } };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, pos = [6];
      for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    const format = (mask) => {
      const d = (e.bits << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = ((d << 10) | r) ^ 0x5412;
      for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
      set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
      set(8, size - 8, true);
    };
    format(0);
    if (ver >= 7) {
      let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const b = (ver << 12) | r;
      for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, bit(b, i)); set(c, a, bit(b, i)); }
    }
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
        if (!fn[y][x] && i < all.length * 8) { mod[y][x] = bit(all[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) { applyMask(m); format(m); const s = penalty(mod); if (s < bestScore) { bestScore = s; best = m; } applyMask(m); }
    applyMask(best); format(best);
    return mod;
  }
  function penalty(m) {
    const n = m.length; let s = 0, dark = 0;
    const lineScore = (get) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) run++;
          else { if (run >= 5) s += 3 + (run - 5); run = 1; }
        }
        for (let b = 0; b + 11 <= n; b++) {
          const seq = []; for (let k = 0; k < 11; k++) seq.push(get(a, b + k) ? 1 : 0); const t = seq.join('');
          if (t === '10111010000' || t === '00001011101') s += 40;
        }
      }
    };
    lineScore((r, c) => m[r][c]); lineScore((c, r) => m[r][c]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3; }
    m.forEach((row) => row.forEach((c) => { if (c) dark++; }));
    const total = n * n; s += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return s;
  }
  function qrSvg(text, opts) {
    const o = opts || {}; const m = qrMatrix(text, o.level || 'M'); if (!m) return null;
    const q = 4, n = m.length + q * 2; let d = '';
    m.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + q} ${y + q}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${esc(o.label || 'QR code')}"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  // ---------- Code 128 ----------
  const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
  /** Code values for the text, or null when it holds characters Code 128 set B cannot carry. */
  function code128Values(text) {
    const s = String(text);
    if (!s.length || s.length > 80) return null;
    if (/^\d+$/.test(s) && s.length % 2 === 0 && s.length >= 4) { const v = [105]; for (let i = 0; i < s.length; i += 2) v.push(Number(s.slice(i, i + 2))); return v; }
    const v = [104];
    for (const ch of s) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) return null; v.push(c - 32); }
    return v;
  }
  function code128Svg(text, opts) {
    const o = opts || {}; const v = code128Values(text); if (!v) return null;
    let sum = v[0]; for (let i = 1; i < v.length; i++) sum += v[i] * i;
    const all = v.concat([sum % 103, 106]);
    const q = 10, h = 60; let x = q, d = '';
    all.forEach((code) => { const w = C128[code]; for (let i = 0; i < w.length; i++) { const n = Number(w[i]); if (i % 2 === 0) d += `M${x} 0h${n}v${h}h-${n}z`; x += n; } });
    const width = x + q;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${esc(o.label || 'Barcode')}"><rect width="${width}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  /**
   * Draw a stored code locally. format: the detected symbology ('qr_code', 'code_128', …); unknown/legacy → QR.
   * Returns { kind: 'qr'|'code128', svg } or null when this symbology cannot be redrawn faithfully.
   */
  function render(text, format) {
    const f = String(format || 'qr_code').toLowerCase();
    if (!text) return null;
    if (f === 'qr_code' || f === 'qr' || f === '') { const svg = qrSvg(text); return svg ? { kind: 'qr', svg } : null; }
    if (f === 'code_128' || f === 'code128') { const svg = code128Svg(text); return svg ? { kind: 'code128', svg } : null; }
    return null;
  }
  const svgDataUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  const api = { qrMatrix, qrSvg, code128Values, code128Svg, render, svgDataUrl, C128, ECC_PER_BLOCK, NUM_BLOCKS, rawDataModules, gfMul };
  root.DaylightCodes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
