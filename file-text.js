// Daylight file text: turns a downloaded file (bytes in memory) into plain text, on the device. Nothing is uploaded.
//   PDF                       → pdf.js (Apache-2.0), self-hosted in ui/vendor/pdfjs, loaded only when a PDF is read;
//                               eval is turned off and no fonts, CMaps or WebAssembly are fetched (text only)
//   Word / Excel / PowerPoint → the .docx / .xlsx / .pptx zip read with the browser's DecompressionStream
//   text, CSV, HTML, Markdown → decoded directly
// The text is used in memory to find amounts, dates and references, then discarded.
(function (root) {
  'use strict';
  const MAX_PAGES = 6, MAX_CHARS = 60000;
  const ext = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';
  function kindOf(name, mimeType) {
    const e = ext(name), m = String(mimeType || '').toLowerCase();
    if (e === 'pdf' || m === 'application/pdf') return 'pdf';
    if (e === 'docx' || /wordprocessingml/.test(m)) return 'docx';
    if (e === 'xlsx' || /spreadsheetml/.test(m)) return 'xlsx';
    if (e === 'pptx' || /presentationml/.test(m)) return 'pptx';
    if (['txt', 'csv', 'md', 'html', 'htm', 'eml', 'json', 'xml'].includes(e) || /^text\//.test(m)) return 'text';
    return null;
  }
  const xmlText = (xml) => String(xml).replace(/<w:tab\/>|<\/w:p>|<\/a:p>|<\/row>|<br\/>/g, '\n').replace(/<\/si>|<\/c>/g, ' ').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

  /** Minimal zip reader (central directory; stored or deflated entries). */
  async function unzip(bytes, want) {
    const u8 = new Uint8Array(bytes), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const out = new Map(), dec = new TextDecoder();
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!want(name)) continue;
      const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
      const data = u8.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
      if (method === 0) out.set(name, dec.decode(data));
      else if (method === 8) { const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')); out.set(name, await new Response(s).text()); }
    }
    return out;
  }
  async function office(bytes, kind) {
    const pick = kind === 'docx' ? (n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)
      : kind === 'xlsx' ? (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
        : (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n);
    const files = await unzip(bytes, pick);
    const names = [...files.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (kind === 'xlsx') {
      const ss = files.get('xl/sharedStrings.xml'); const strings = ss ? [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1])) : [];
      return names.filter((n) => n !== 'xl/sharedStrings.xml').map((n) => [...files.get(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => [...row[1].matchAll(/<c([^>]*)>(?:<f>[\s\S]*?<\/f>)?(?:<v>([\s\S]*?)<\/v>|<is>([\s\S]*?)<\/is>)?<\/c>/g)].map((c) => /t="s"/.test(c[1]) ? strings[Number(c[2])] || '' : c[3] ? xmlText(c[3]) : (c[2] || '')).join(' ')).join('\n')).join('\n');
    }
    return names.map((n) => xmlText(files.get(n))).join('\n');
  }
  let pdfjs = null;
  async function pdf(bytes, o) {
    const base = (o && o.vendorBase) || 'ui/vendor/pdfjs/';
    if (!pdfjs) { pdfjs = (o && o.pdfjs) || await import(new URL(base + 'pdf.min.mjs', root.location ? root.location.href : 'file:///').href); if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc && root.location) pdfjs.GlobalWorkerOptions.workerSrc = new URL(base + 'pdf.worker.min.mjs', root.location.href).href; }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWasm: false, stopAtErrors: false, enableXfa: false, verbosity: 0 }).promise;
    const pages = Math.min(doc.numPages, MAX_PAGES); const parts = [];
    for (let i = 1; i <= pages; i++) { const pg = await doc.getPage(i); const tc = await pg.getTextContent(); let line = ''; tc.items.forEach((it) => { line += it.str + (it.hasEOL ? '\n' : ' '); }); parts.push(line); }
    try { await doc.destroy(); } catch {}
    return { text: parts.join('\n'), pages: doc.numPages };
  }
  /** extract({ bytes, name, mimeType }) → { kind, text, pages? } or { kind: null } for files Daylight does not read. */
  async function extract(f, o) {
    const kind = kindOf(f.name, f.mimeType);
    if (!kind) return { kind: null, text: '' };
    let text = '', pages = null;
    if (kind === 'pdf') { const r = await pdf(f.bytes, o); text = r.text; pages = r.pages; }
    else if (kind === 'text') { text = new TextDecoder().decode(f.bytes); if (/^\s*</.test(text)) text = xmlText(text); }
    else text = await office(f.bytes, kind);
    return { kind, text: text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, MAX_CHARS), pages };
  }
  const api = { extract, kindOf, unzip };
  root.DaylightFileText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
