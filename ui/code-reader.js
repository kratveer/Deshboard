/**
 * Daylight — local QR code and Code 128 reader (fallback when the browser has no BarcodeDetector,
 * e.g. Chrome on Windows and Firefox). Runs entirely in the page on pixels from a <canvas>; nothing is uploaded.
 *
 * QR: hybrid binarisation → finder patterns (1:1:3:1:1) → alignment pattern → perspective sampling →
 *     format/version information → unmasking → Reed–Solomon error correction → numeric / alphanumeric / byte / kanji / ECI.
 * Code 128: several scan lines (both directions, also rotated 90°) → bar widths → pattern match → checksum.
 * Algorithms follow ISO/IEC 18004 and ISO/IEC 15417 and the approach used by ZXing; written for Daylight because
 * package registries were not reachable to vendor a library. Verified against ZXing, ZBar and libqrencode (tests/).
 */
(function (root) {
  'use strict';
  const Codes = root.DaylightCodes || (typeof require === 'function' ? require('./codes.js') : null);

  // ---------- image helpers ----------
  function toLuma(img) {
    const { data, width, height } = img;
    if (data.length === width * height) return { lum: data instanceof Uint8Array ? data : Uint8Array.from(data), width, height };
    const lum = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) lum[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    return { lum, width, height };
  }
  /** Local-average binarisation (8×8 blocks, 5×5 neighbourhood), robust to shadows and gradients. true = dark. */
  function binarize(lum, w, h, invert) {
    const B = 8, bw = Math.ceil(w / B), bh = Math.ceil(h / B), avg = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let sum = 0, mn = 255, mx = 0, n = 0;
      for (let y = by * B; y < Math.min(h, by * B + B); y++) for (let x = bx * B; x < Math.min(w, bx * B + B); x++) { const v = lum[y * w + x]; sum += v; n++; if (v < mn) mn = v; if (v > mx) mx = v; }
      let a = sum / n;
      if (mx - mn <= 24) { a = mn / 2; if (by > 0 && bx > 0) { const nb = (avg[(by - 1) * bw + bx] + 2 * avg[by * bw + bx - 1] + avg[(by - 1) * bw + bx - 1]) / 4; if (mn < nb) a = nb; } }
      avg[by * bw + bx] = a;
    }
    const out = new Uint8Array(w * h);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = by + dy, xx = bx + dx; if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) { s += avg[yy * bw + xx]; n++; } }
      const t = s / n;
      for (let y = by * B; y < Math.min(h, by * B + B); y++) for (let x = bx * B; x < Math.min(w, bx * B + B); x++) { const d = lum[y * w + x] <= t ? 1 : 0; out[y * w + x] = invert ? 1 - d : d; }
    }
    return out;
  }

  function upscale(lum, w, h, f) {
    const W = w * f, H = h * f, out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / f - 0.5)), y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < W; x++) { const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / f - 0.5)), x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
        out[y * W + x] = (lum[y0 * w + x0] * (1 - fx) + lum[y0 * w + x1] * fx) * (1 - fy) + (lum[y1 * w + x0] * (1 - fx) + lum[y1 * w + x1] * fx) * fy; } }
    return { lum: out, width: W, height: H };
  }

  // ---------- QR: Reed–Solomon over GF(256), polynomial 0x11D, generator base 0 ----------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const ginv = (a) => { if (!a) throw new Error('rs'); return EXP[255 - LOG[a]]; };
  class Poly {
    constructor(c) { let i = 0; while (i < c.length - 1 && c[i] === 0) i++; this.c = c.slice(i); }
    get degree() { return this.c.length - 1; }
    get zero() { return this.c[0] === 0; }
    coef(d) { return this.c[this.c.length - 1 - d]; }
    at(a) { if (a === 0) return this.coef(0); let r = this.c[0]; for (let i = 1; i < this.c.length; i++) r = gmul(a, r) ^ this.c[i]; return r; }
    add(o) { if (this.zero) return o; if (o.zero) return this; let [s, l] = this.c.length > o.c.length ? [o.c, this.c] : [this.c, o.c]; const r = l.slice(); const d = l.length - s.length; for (let i = 0; i < s.length; i++) r[d + i] ^= s[i]; return new Poly(r); }
    mul(o) { if (this.zero || o.zero) return new Poly([0]); const r = new Array(this.c.length + o.c.length - 1).fill(0); for (let i = 0; i < this.c.length; i++) for (let j = 0; j < o.c.length; j++) r[i + j] ^= gmul(this.c[i], o.c[j]); return new Poly(r); }
    scale(s) { return new Poly(this.c.map((v) => gmul(v, s))); }
    shiftScale(deg, s) { if (s === 0) return new Poly([0]); const r = this.c.map((v) => gmul(v, s)); for (let i = 0; i < deg; i++) r.push(0); return new Poly(r); }
  }
  const mono = (deg, s) => { const r = new Array(deg + 1).fill(0); r[0] = s; return new Poly(r); };
  /** Corrects `cw` in place (data + ec codewords). Returns false when it cannot be corrected. */
  function rsCorrect(cw, ecLen) {
    const p = new Poly(cw.slice()), syn = new Array(ecLen).fill(0); let ok = true;
    for (let i = 0; i < ecLen; i++) { const v = p.at(EXP[i]); syn[ecLen - 1 - i] = v; if (v) ok = false; }
    if (ok) return true;
    try {
      let rLast = mono(ecLen, 1), r = new Poly(syn), tLast = new Poly([0]), t = new Poly([1]);
      if (rLast.degree < r.degree) [rLast, r] = [r, rLast];
      while (r.degree >= ecLen / 2) {
        const rLL = rLast, tLL = tLast; rLast = r; tLast = t;
        if (rLast.zero) return false;
        r = rLL; let q = new Poly([0]); const dInv = ginv(rLast.coef(rLast.degree));
        while (r.degree >= rLast.degree && !r.zero) { const dd = r.degree - rLast.degree, sc = gmul(r.coef(r.degree), dInv); q = q.add(mono(dd, sc)); r = r.add(rLast.shiftScale(dd, sc)); }
        t = q.mul(tLast).add(tLL);
        if (r.degree >= rLast.degree) return false;
      }
      const s0 = t.coef(0); if (!s0) return false;
      const inv = ginv(s0), sigma = t.scale(inv), omega = r.scale(inv);
      const n = sigma.degree, locs = [];
      if (n === 1) locs.push(sigma.coef(1)); else for (let i = 1; i < 256 && locs.length < n; i++) if (sigma.at(i) === 0) locs.push(ginv(i));
      if (locs.length !== n) return false;
      for (let i = 0; i < n; i++) {
        const xiInv = ginv(locs[i]); let den = 1;
        for (let j = 0; j < n; j++) if (i !== j) { const term = gmul(locs[j], xiInv); den = gmul(den, (term & 1) === 0 ? term | 1 : term & ~1); }
        const mag = gmul(omega.at(xiInv), ginv(den));
        const pos = cw.length - 1 - LOG[locs[i]]; if (pos < 0) return false;
        cw[pos] ^= mag;
      }
      return true;
    } catch { return false; }
  }

  // ---------- QR: structure ----------
  const FN_CACHE = {};
  function functionMask(ver) {
    if (FN_CACHE[ver]) return FN_CACHE[ver];
    return (FN_CACHE[ver] = buildFunctionMask(ver));
  }
  function buildFunctionMask(ver) {
    const size = ver * 4 + 17, fn = Array.from({ length: size }, () => new Uint8Array(size));
    const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = 1; };
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
    for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
    for (const [ax, ay] of alignCenters(ver)) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ax + dx, ay + dy);
    for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
    for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
    if (ver >= 7) for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); mark(a, b); mark(b, a); }
    return fn;
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    const size = ver * 4 + 17, n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    return pos;
  }
  function alignCenters(ver) {
    const pos = alignPositions(ver), n = pos.length, out = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue; out.push([pos[i], pos[j]]); }
    return out;
  }
  const FORMATS = [];
  for (let e = 0; e < 4; e++) for (let m = 0; m < 8; m++) { const d = (e << 3) | m; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); FORMATS.push({ bits: ((d << 10) | r) ^ 0x5412, ecBits: e, mask: m }); }
  const VERSIONS = [];
  for (let v = 7; v <= 40; v++) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); VERSIONS.push({ v, bits: (v << 12) | r }); }
  const FMT1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const popcnt = (x) => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };
  const ECL_ORD = { 1: 0, 0: 1, 3: 2, 2: 3 }; // format bits → L, M, Q, H
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];

  /** Decode a sampled module matrix (true = dark). Returns the text or null. */
  function decodeMatrix(M) {
    const size = M.length, ver = (size - 17) / 4;
    if (!Number.isInteger(ver) || ver < 1 || ver > 40) return null;
    const g = (x, y) => (M[y][x] ? 1 : 0);
    let f1 = 0, f2 = 0;
    FMT1.forEach(([x, y], i) => { f1 |= g(x, y) << i; });
    for (let i = 0; i < 8; i++) f2 |= g(size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) f2 |= g(8, size - 15 + i) << i;
    let best = null, bd = 99;
    for (const f of FORMATS) for (const v of [f1, f2]) { const d = popcnt(f.bits ^ v); if (d < bd) { bd = d; best = f; } }
    if (!best || bd > 3) return null;
    if (ver >= 7) {
      let v1 = 0, v2 = 0;
      for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); v1 |= g(a, b) << i; v2 |= g(b, a) << i; }
      let bv = null, bdv = 99;
      for (const v of VERSIONS) for (const x of [v1, v2]) { const d = popcnt(v.bits ^ x); if (d < bdv) { bdv = d; bv = v; } }
      if (!bv || bdv > 3 || bv.v !== ver) return null;
    }
    const fn = functionMask(ver), mask = MASKS[best.mask], bits = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
        if (!fn[y][x]) bits.push(g(x, y) ^ (mask(x, y) ? 1 : 0));
      }
    }
    const e = ECL_ORD[best.ecBits], raw = Math.floor(Codes.rawDataModules(ver) / 8);
    const cw = []; for (let i = 0; i < raw; i++) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]; cw.push(b); }
    const nb = Codes.NUM_BLOCKS[e][ver], ecLen = Codes.ECC_PER_BLOCK[e][ver], nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
    const dl = []; for (let j = 0; j < nb; j++) dl.push(shortLen - ecLen + (j < nShort ? 0 : 1));
    const blocks = dl.map((n) => new Array(n + ecLen));
    let k = 0;
    for (let i = 0; i < Math.max(...dl); i++) for (let j = 0; j < nb; j++) if (i < dl[j]) blocks[j][i] = cw[k++];
    for (let i = 0; i < ecLen; i++) for (let j = 0; j < nb; j++) blocks[j][dl[j] + i] = cw[k++];
    const data = [];
    for (let j = 0; j < nb; j++) { if (!rsCorrect(blocks[j], ecLen)) return null; for (let i = 0; i < dl[j]; i++) data.push(blocks[j][i]); }
    return parseSegments(data, ver);
  }
  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  function parseSegments(data, ver) {
    let pos = 0; const total = data.length * 8;
    const read = (n) => { let v = 0; for (let i = 0; i < n; i++) { const p = pos + i; v = (v << 1) | ((data[p >> 3] >> (7 - (p & 7))) & 1); } pos += n; return v; };
    const grp = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
    let out = '', bytes = [], charset = null;
    const flush = () => { if (!bytes.length) return; out += decodeBytes(bytes, charset); bytes = []; };
    while (pos + 4 <= total) {
      const mode = read(4);
      if (mode === 0) break;
      if (mode === 1) { flush(); let n = read([10, 12, 14][grp]); while (n >= 3) { out += String(read(10)).padStart(3, '0'); n -= 3; } if (n === 2) out += String(read(7)).padStart(2, '0'); else if (n === 1) out += String(read(4)); }
      else if (mode === 2) { flush(); let n = read([9, 11, 13][grp]); while (n >= 2) { const v = read(11); out += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; n -= 2; } if (n === 1) out += ALNUM[read(6)]; }
      else if (mode === 4) { const n = read([8, 16, 16][grp]); if (pos + n * 8 > total) return null; for (let i = 0; i < n; i++) bytes.push(read(8)); }
      else if (mode === 8) { flush(); let n = read([8, 10, 12][grp]); const sj = []; while (n-- > 0) { let v = read(13); v = (Math.floor(v / 0xc0) << 8) | (v % 0xc0); v += v < 0x1f00 ? 0x8140 : 0xc140; sj.push(v >> 8, v & 0xff); } out += decodeBytes(sj, 'shift_jis'); }
      else if (mode === 7) { flush(); let v = read(8); if ((v & 0x80) === 0) {} else if ((v & 0xc0) === 0x80) v = ((v & 0x3f) << 8) | read(8); else v = ((v & 0x1f) << 16) | read(16); charset = v === 26 ? 'utf-8' : v === 3 || v === 1 ? 'iso-8859-1' : v === 20 ? 'shift_jis' : v === 4 ? 'iso-8859-2' : null; }
      else if (mode === 3) { read(16); }
      else if (mode === 5 || mode === 9) { if (mode === 9) read(8); }
      else return null;
    }
    flush();
    return out;
  }
  function decodeBytes(b, charset) {
    const u8 = Uint8Array.from(b);
    const tryDec = (cs, fatal) => { try { return new TextDecoder(cs, { fatal }).decode(u8); } catch { return null; } };
    if (charset) { const t = tryDec(charset, false); if (t != null) return t; }
    return tryDec('utf-8', true) ?? tryDec('iso-8859-1', false) ?? String.fromCharCode(...b);
  }

  // ---------- QR: locating ----------
  function findFinders(bin, w, h) {
    const cand = [];
    const ratio = (s) => { const t = s[0] + s[1] + s[2] + s[3] + s[4]; if (t < 7) return 0; const m = t / 7, v = m / 1.6; return Math.abs(m - s[0]) < v && Math.abs(m - s[1]) < v && Math.abs(3 * m - s[2]) < 3 * v && Math.abs(m - s[3]) < v && Math.abs(m - s[4]) < v ? t : 0; };
    const cross = (cx, cy, dx, dy, maxC) => {
      // counts along a line through (cx,cy): returns [center offset, total] or null
      const at = (k) => { const x = Math.round(cx + dx * k), y = Math.round(cy + dy * k); return x < 0 || y < 0 || x >= w || y >= h ? -1 : bin[y * w + x]; };
      const s = [0, 0, 0, 0, 0]; let k = 0;
      while (at(k) === 1) { s[2]++; k--; } if (at(k) < 0) return null;
      while (at(k) === 0 && s[1] <= maxC) { s[1]++; k--; } if (at(k) < 0 || s[1] > maxC) return null;
      while (at(k) === 1 && s[0] <= maxC) { s[0]++; k--; } if (s[0] > maxC) return null;
      k = 1; while (at(k) === 1) { s[2]++; k++; } if (at(k) < 0) return null;
      while (at(k) === 0 && s[3] <= maxC) { s[3]++; k++; } if (at(k) < 0 || s[3] > maxC) return null;
      while (at(k) === 1 && s[4] <= maxC) { s[4]++; k++; } if (s[4] > maxC) return null;
      if (!ratio(s)) return null;
      return { off: k - s[4] - s[3] - s[2] / 2, total: s.reduce((a, b) => a + b, 0) };
    };
    const step = Math.max(1, Math.floor(h / 400));
    for (let y = 0; y < h; y += step) {
      const s = [0, 0, 0, 0, 0]; let st = 0;
      for (let x = 0; x <= w; x++) {
        const d = x < w ? bin[y * w + x] : 0;
        if (d === 1) { if (st & 1) st++; s[st]++; }
        else {
          if (!(st & 1)) { if (st === 4) {
            const t = ratio(s);
            if (t) {
              let cx = x - s[4] - s[3] - s[2] / 2;
              const vy = cross(cx, y, 0, 1, s[2] * 2); if (vy) {
                const cy = y + vy.off; const hx = cross(cx, cy, 1, 0, s[2] * 2);
                if (hx) { cx = cx + hx.off;
                  const d1 = cross(cx, cy, 1, 1, s[2] * 2), d2 = cross(cx, cy, 1, -1, s[2] * 2);
                  // a rotated pattern looks wider along the axes: the smallest of the four directions is closest to the true module size
                  if (d1) addCand(cand, cx, cy, Math.min(vy.total, hx.total, d1.total * Math.SQRT2, d2 ? d2.total * Math.SQRT2 : Infinity) / 7);
                }
              }
              s[0] = s[2]; s[1] = s[3]; s[2] = s[4]; s[3] = 1; s[4] = 0; st = 3; continue;
            }
            s[0] = s[2]; s[1] = s[3]; s[2] = s[4]; s[3] = 1; s[4] = 0; st = 3;
          } else { st++; s[st]++; } } else s[st]++;
        }
      }
    }
    return cand;
  }
  function addCand(cand, x, y, ms) {
    for (const c of cand) if (Math.abs(c.x - x) <= ms * 2 && Math.abs(c.y - y) <= ms * 2 && Math.abs(c.ms - ms) <= Math.max(1, c.ms * 0.5)) { c.x = (c.x * c.n + x) / (c.n + 1); c.y = (c.y * c.n + y) / (c.n + 1); c.ms = (c.ms * c.n + ms) / (c.n + 1); c.n++; return; }
    cand.push({ x, y, ms, n: 1 });
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function triples(cand) {
    const c = cand.filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10);
    const list = c.length >= 3 ? c : cand.sort((a, b) => b.n - a.n).slice(0, 10);
    const out = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) for (let k = j + 1; k < list.length; k++) {
      const p = [list[i], list[j], list[k]], ms = p.map((q) => q.ms), mmax = Math.max(...ms), mmin = Math.min(...ms);
      if (mmax > mmin * 1.6) continue;
      const d = [[dist(p[1], p[2]), 0], [dist(p[0], p[2]), 1], [dist(p[0], p[1]), 2]].sort((a, b) => b[0] - a[0]);
      const tl = p[d[0][1]], o = p.filter((q) => q !== tl);
      const a = dist(tl, o[0]), b = dist(tl, o[1]), hyp = d[0][0];
      const score = Math.abs(a - b) / Math.max(a, b) + Math.abs(hyp - Math.hypot(a, b)) / hyp;
      if (score > 0.5) continue;
      let [bl, tr] = o; // order: cross product decides which is top-right
      if ((tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x) < 0) [bl, tr] = [tr, bl];
      out.push({ tl, tr, bl, score });
    }
    return out.sort((a, b) => a.score - b.score).slice(0, 4);
  }
  /** Homography mapping 4 source points to 4 destination points (8-unknown linear solve). */
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) { const [x, y] = src[i], [u, v] = dst[i]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
    for (let c = 0; c < 8; c++) { let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]]; const pv = A[c][c]; if (Math.abs(pv) < 1e-12) return null; for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / pv; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; } }
    const h = b.map((v, i) => v / A[i][i]);
    return (x, y) => { const d = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d]; };
  }
  function findAlignment(bin, w, h, ex, ey, ms, modules) {
    let best = null, bs = -1; const R = Math.round(ms * (modules || 5));
    const px = (x, y) => { x = Math.round(x); y = Math.round(y); return x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]; };
    for (let y = Math.round(ey - R); y <= ey + R; y++) for (let x = Math.round(ex - R); x <= ex + R; x++) {
      if (!px(x, y)) continue;
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const want = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0; if (px(x + dx * ms, y + dy * ms) === want) s++; }
      const sc = s - Math.hypot(x - ex, y - ey) / (ms * 10);
      if (s >= 22 && sc > bs) { bs = sc; best = { x, y }; }
    }
    return best;
  }
  /** Reads only the 30 format-information modules; true when either copy is within 3 bits of a valid format. */
  function formatReadable(bin, w, h, map, size) {
    const g = (x, y) => { const [px, py] = map(x + 0.5, y + 0.5); const ix = Math.round(px), iy = Math.round(py); return ix >= 0 && iy >= 0 && ix < w && iy < h ? bin[iy * w + ix] : 0; };
    let f1 = 0, f2 = 0;
    FMT1.forEach(([x, y], i) => { f1 |= g(x, y) << i; });
    for (let i = 0; i < 8; i++) f2 |= g(size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) f2 |= g(8, size - 15 + i) << i;
    // both copies must point to the same format (random pixels match one copy about half the time, both rarely)
    for (const f of FORMATS) { const a = popcnt(f.bits ^ f1), b = popcnt(f.bits ^ f2); if (a <= 3 && b <= 4 || b <= 3 && a <= 4) return true; }
    return false;
  }
  function sampleGrid(bin, w, h, map, size) {
    const M = [];
    for (let y = 0; y < size; y++) { const row = []; for (let x = 0; x < size; x++) { const [px, py] = map(x + 0.5, y + 0.5); const ix = Math.round(px), iy = Math.round(py); row.push(ix >= 0 && iy >= 0 && ix < w && iy < h ? bin[iy * w + ix] === 1 : false); } M.push(row); }
    return M;
  }
  function decodeQR(bin, w, h, deadline) {
    const cand = findFinders(bin, w, h);
    if (cand.length < 3) return null;
    for (const { tl, tr, bl } of triples(cand)) {
      const ms = (tl.ms + tr.ms + bl.ms) / 3;
      const est = (dist(tl, tr) / ms + dist(tl, bl) / ms) / 2 + 7;
      const dims = [];
      for (let d = 21; d <= 177; d += 4) if (d >= est * 0.86 - 4 && d <= est * 1.1 + 4) dims.push(d);
      dims.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
      for (const size of dims) {
        if (deadline && Date.now() > deadline) return null; // keep the page responsive on busy photos without a code
        const ver = (size - 17) / 4, mods = size - 7;
        const brx = tr.x - tl.x + bl.x, bry = tr.y - tl.y + bl.y;
        const tries = [];
        const attempt = (p4, dst) => {
          const map = homography(p4, dst.map((p) => [p.x, p.y]));
          if (!map) return null;
          if (!formatReadable(bin, w, h, map, size)) return null; // cheap check before sampling the whole grid
          const M = sampleGrid(bin, w, h, map, size);
          let text = decodeMatrix(M);
          if (text == null) text = decodeMatrix(M.map((r, y) => r.map((_, x) => M[x][y]))); // mirrored code
          return text;
        };
        if (ver >= 2) {
          const corr = 1 - 3 / mods, ex = tl.x + corr * (brx - tl.x), ey = tl.y + corr * (bry - tl.y);
          for (const R of [5, 12]) {
            const al = findAlignment(bin, w, h, ex, ey, ms, R);
            if (al) { const t = attempt([[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5], [size - 6.5, size - 6.5]], [tl, tr, bl, al]); if (t != null) return t; break; }
          }
        }
        // no usable alignment pattern (version 1, blur, strong perspective): search the 4th corner around its estimate;
        // a wrong guess cannot produce a wrong value because format information and Reed–Solomon must both check out
        const t0 = attempt([[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5], [size - 3.5, size - 3.5]], [tl, tr, bl, { x: brx, y: bry }]);
        if (t0 != null) return t0;
        const ux = { x: (tr.x - tl.x) / mods, y: (tr.y - tl.y) / mods }, uy = { x: (bl.x - tl.x) / mods, y: (bl.y - tl.y) / mods };
        for (let r = 1; r <= 4; r++) for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
          if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
          const q = { x: brx + (a * ux.x + b * uy.x) * 0.75, y: bry + (a * ux.y + b * uy.y) * 0.75 };
          const t = attempt([[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5], [size - 3.5, size - 3.5]], [tl, tr, bl, q]);
          if (t != null) return t;
        }
      }
    }
    return null;
  }

  // ---------- Code 128 ----------
  const PAT = (Codes ? Codes.C128 : []).map((p) => [...p].map(Number));
  function patVariance(runs, pat) {
    const total = runs.reduce((a, b) => a + b, 0), plen = pat.reduce((a, b) => a + b, 0), unit = total / plen, maxInd = 0.7 * unit;
    let tv = 0; for (let i = 0; i < pat.length; i++) { const v = Math.abs(runs[i] - pat[i] * unit); if (v > maxInd) return Infinity; tv += v; }
    return tv / total;
  }
  /** runs: [light, dark, light, dark, …] widths along one scan line (runs[0] = space before the first bar). */
  function decode128Runs(runs) {
    for (let s = 1; s + 6 <= runs.length; s += 2) {
      const start = runs.slice(s, s + 6);
      const sv = [103, 104, 105].map((c) => [c, patVariance(start, PAT[c])]).sort((a, b) => a[1] - b[1])[0];
      if (sv[1] > 0.25) continue;
      const unit = start.reduce((a, b) => a + b, 0) / 11;
      if (!(s === 1 && runs[0] === 0) && runs[s - 1] < unit * 2) continue; // needs a quiet zone before the start
      const codes = [sv[0]]; let i = s + 6, ok = false;
      while (i + 6 <= runs.length) {
        if (i + 7 <= runs.length && patVariance(runs.slice(i, i + 7), PAT[106]) < 0.25) { ok = true; break; }
        let bc = -1, bvv = 0.25;
        for (let c = 0; c < 106; c++) { const v = patVariance(runs.slice(i, i + 6), PAT[c]); if (v < bvv) { bvv = v; bc = c; } }
        if (bc < 0) break;
        codes.push(bc); i += 6;
      }
      if (!ok || codes.length < 3) continue;
      const check = codes.pop(); let sum = codes[0];
      for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
      if (sum % 103 !== check) continue;
      const text = codesToText(codes);
      if (text != null && text.length) return text;
    }
    return null;
  }
  function codesToText(codes) {
    let set = codes[0] === 103 ? 'A' : codes[0] === 104 ? 'B' : 'C', out = '', shift = false;
    for (let k = 1; k < codes.length; k++) {
      const c = codes[k], cur = shift ? (set === 'A' ? 'B' : 'A') : set; shift = false;
      if (cur === 'C') { if (c < 100) out += String(c).padStart(2, '0'); else if (c === 100) set = 'B'; else if (c === 101) set = 'A'; else if (c !== 102) return null; continue; }
      if (c < 96) { out += cur === 'A' ? String.fromCharCode(c < 64 ? c + 32 : c - 64) : String.fromCharCode(c + 32); continue; }
      if (c === 98) shift = true; else if (c === 99) set = 'C'; else if (c === 100) { if (cur === 'A') set = 'B'; } else if (c === 101) { if (cur === 'B') set = 'A'; } // 96, 97, 102: FNC codes, not text
    }
    return out;
  }
  /** Light/dark run widths of one line, thresholded globally or against a moving average. */
  function lineRuns(vals, local) {
    let mn = 255, mx = 0; for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx - mn < 32) return null;
    let thr;
    if (local) {
      const W = Math.max(8, Math.floor(vals.length / 10)), pre = [0]; for (const v of vals) pre.push(pre[pre.length - 1] + v);
      thr = vals.map((_, i) => { const a = Math.max(0, i - W), b = Math.min(vals.length, i + W); const m = (pre[b] - pre[a]) / (b - a); return Math.min(m, (mn + mx) / 2 + (mx - mn) / 4); });
    }
    const g = (mn + mx) / 2, dark = vals.map((v, i) => v <= (local ? thr[i] : g));
    const runs = []; let cur = dark[0], n = 0;
    for (const d of dark) { if (d === cur) n++; else { runs.push(n); cur = d; n = 1; } }
    runs.push(n);
    return dark[0] ? [0].concat(runs) : runs;
  }
  function decode128(lum, w, h) {
    const lines = [];
    for (const f of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9]) {
      const y = Math.min(h - 1, Math.floor(h * f)); lines.push(Array.from(lum.subarray(y * w, y * w + w)));
      const x = Math.min(w - 1, Math.floor(w * f)); const col = new Array(h); for (let yy = 0; yy < h; yy++) col[yy] = lum[yy * w + x]; lines.push(col);
    }
    // slanted lines for tilted barcodes (photos): through the centre region, ±4…16°, both orientations
    const slant = (cx, cy, ang) => { const dx = Math.cos(ang), dy = Math.sin(ang), L = Math.hypot(w, h), v = [];
      for (let k = -L / 2; k <= L / 2; k++) { const x = Math.round(cx + dx * k), y = Math.round(cy + dy * k); if (x >= 0 && y >= 0 && x < w && y < h) v.push(lum[y * w + x]); }
      return v; };
    for (const deg of [4, -4, 8, -8, 12, -12, 16, -16]) for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.4], [0.5, 0.6]]) {
      const a = (deg * Math.PI) / 180; lines.push(slant(w * fx, h * fy, a)); lines.push(slant(w * fx, h * fy, Math.PI / 2 + a));
    }
    for (const local of [false, true]) for (const line of lines) for (const vals of [line, line.slice().reverse()]) {
      const r = lineRuns(vals, local); if (!r || r.length < 32) continue;
      const res = decode128Runs(r);
      if (res != null) return res;
    }
    return null;
  }

  // ---------- public ----------
  /**
   * decode({ data, width, height }) → [{ format: 'qr_code' | 'code_128', rawValue }]
   * data: RGBA (from canvas getImageData) or 8-bit grey.
   */
  function decode(img, opts) {
    const o = opts || {};
    const { lum, width: w, height: h } = toLuma(img);
    const out = [];
    if (!o.formats || o.formats.includes('qr_code')) {
      const deadline = Date.now() + (o.budgetMs || 2500);
      const tryQR = (L, W, H) => { for (const inv of [false, true]) { const t = decodeQR(binarize(L, W, H, inv), W, H, deadline); if (t != null) return t; } return null; };
      let t = tryQR(lum, w, h);
      if (t == null && Math.max(w, h) <= 900) { const u = upscale(lum, w, h, 2); t = tryQR(u.lum, u.width, u.height); } // very small codes: about 2 px per module
      if (t != null) out.push({ format: 'qr_code', rawValue: t });
    }
    if (!out.length && (!o.formats || o.formats.includes('code_128'))) {
      const t = decode128(lum, w, h); if (t != null) out.push({ format: 'code_128', rawValue: t });
    }
    return out;
  }

  const api = { decode, decodeMatrix, rsCorrect, functionMask, binarize, decode128Runs, codesToText };
  root.DaylightCodeReader = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
