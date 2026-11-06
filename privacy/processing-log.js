/**
 * Daylight processing log (V2 Privacy Centre): what left the device, when and why.
 * Entries never contain message text — only kind, destination, size and the source Item / message id.
 * Stored in the Item Graph "log" store when available, otherwise in memory for the session. Capped at 500 entries.
 */
(function (root) {
  'use strict';
  const MAX = 500;
  // v112: random part in new ids (see actions/apply-action.js); existing ids are kept
  const rnd = () => { try { const a = new Uint32Array(2); root.crypto.getRandomValues(a); return a[0].toString(36) + a[1].toString(36); } catch { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10); } };
  function createLog(opts) {
    const o = opts || {};
    const now = o.now || (() => Date.now());
    const mem = [];
    let seq = 0;
    const store = () => (o.graph ? o.graph.log : null);
    async function add(e) {
      const entry = { id: `log_${now().toString(36)}_${(++seq).toString(36)}_${rnd()}`, at: now(), kind: e.kind || 'other', dest: e.dest || null, what: e.what || '', bytes: Number.isFinite(e.bytes) ? e.bytes : null, itemId: e.itemId || null, messageId: e.messageId || null, accountId: e.accountId || null, detail: e.detail || null };
      // guard: never store content
      if (entry.what && entry.what.length > 160) entry.what = entry.what.slice(0, 160);
      mem.push(entry); if (mem.length > MAX) mem.shift();
      try { const s = store(); if (s) { await s.put(entry); const all = await s.all(); if (all.length > MAX) await s.delMany(all.sort((a, b) => a.at - b.at).slice(0, all.length - MAX).map((x) => x.id)); } } catch {}
      return entry;
    }
    async function list(f) { let all; try { const s = store(); all = s ? await s.all() : mem.slice(); } catch { all = mem.slice(); } all.sort((a, b) => b.at - a.at); return f && f.kind ? all.filter((x) => x.kind === f.kind) : all; }
    return { add, list };
  }
  const api = { createLog };
  root.DaylightProcessingLog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
