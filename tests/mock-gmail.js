/**
 * In-process mock of the Gmail REST API for benchmarks (synthetic data only — never touches a real account).
 * Supports: profile, messages.list (q / labelIds / pageToken / maxResults), messages.get (metadata with metadataHeaders, full),
 * history.list (messageAdded / Deleted / labelAdded / labelRemoved, expiry → 404), threads.list (SENT), threads.get (metadata),
 * HTTP batch (multipart/mixed, ≤ 100 parts), quota accounting with Google's 2026 unit table, optional failure injection.
 */
'use strict';
const COST = { profile: 1, list: 5, getMeta: 20, getFull: 60, history: 2, threadsList: 10, threadsGet: 40, attachment: 20 };
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const DAY = 86400000;

function createMockGmail(opts) {
  const o = opts || {};
  let now = o.now || Date.now();
  let historyId = 1000;
  let historyFloor = historyId; // history before this is "expired"
  const msgs = new Map();
  const log = [];               // { hid, type, id, threadId, labelIds }
  const stats = { calls: 0, units: 0, byKind: {}, batchPosts: 0, batchParts: 0, bodiesServed: 0, failuresInjected: 0 };
  const fail = { rate: 0, kinds: null, seed: 7 };
  let rnd = fail.seed;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };

  function charge(kind) { stats.calls++; stats.units += COST[kind] || 0; stats.byKind[kind] = (stats.byKind[kind] || 0) + 1; }
  function add(m) {
    historyId++;
    const msg = Object.assign({ labelIds: ['INBOX'], attachments: [] }, m, { historyId: String(historyId) });
    if (!msg.internalDate) msg.internalDate = now;
    msgs.set(msg.id, msg);
    log.push({ hid: historyId, type: 'added', id: msg.id, threadId: msg.threadId });
    return msg;
  }
  function remove(id) { const m = msgs.get(id); if (!m) return; msgs.delete(id); historyId++; log.push({ hid: historyId, type: 'deleted', id, threadId: m.threadId }); }
  function relabel(id, addL, remL) {
    const m = msgs.get(id); if (!m) return;
    const s = new Set(m.labelIds); (addL || []).forEach((l) => s.add(l)); (remL || []).forEach((l) => s.delete(l));
    m.labelIds = [...s]; historyId++; m.historyId = String(historyId);
    log.push({ hid: historyId, type: addL && addL.length ? 'labelAdded' : 'labelRemoved', id, threadId: m.threadId });
  }
  function expireHistory() { historyFloor = historyId + 1; }

  // ---------- search ----------
  const textOf = (m) => `${m.subject}\n${m.snippet}\n${m.body || ''}\n${m.html || ''}\n${m.from}`.toLowerCase();
  function matchQ(m, q) {
    if (!q) return true;
    let s = ' ' + q + ' ';
    const t = textOf(m);
    const take = (re) => { const out = []; s = s.replace(re, (_, x) => { out.push(x); return ' '; }); return out; };
    for (const d of take(/\snewer_than:(\d+)d/g)) if (m.internalDate < now - Number(d) * DAY) return false;
    for (const d of take(/\solder_than:(\d+)d/g)) if (m.internalDate >= now - Number(d) * DAY) return false;
    if (take(/\s(has:attachment)/g).length && !(m.attachments || []).length) return false;
    take(/\s(-in:chats)/g);
    // Gmail: "primary" = CATEGORY_PERSONAL or no category label at all
    const inCat = (c) => c.toLowerCase() === 'primary' ? (m.labelIds.includes('CATEGORY_PERSONAL') || !m.labelIds.some((l) => /^CATEGORY_/.test(l))) : m.labelIds.includes('CATEGORY_' + c.toUpperCase());
    for (const c of take(/\s-category:(\w+)/g)) if (inCat(c)) return false;
    for (const c of take(/\scategory:(\w+)/g)) if (!inCat(c)) return false;
    // from:(a OR b) → OR group of sender terms
    for (const g of take(/\sfrom:\(([^()]*)\)/g)) { const ds = g.split(/\s+OR\s+/i).map((x) => x.trim().toLowerCase()).filter(Boolean); if (!ds.some((d) => m.from.toLowerCase().includes(d))) return false; }
    // OR groups
    const groups = take(/\(([^()]*)\)/g);
    for (const g of groups) {
      const terms = g.split(/\s+OR\s+/i).map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
      const ok = terms.some((term) => term.startsWith('from:') ? m.from.toLowerCase().includes(term.slice(5)) : t.includes(term));
      if (!ok) return false;
    }
    for (const w of s.trim().split(/\s+/).filter(Boolean)) {
      const term = w.replace(/^"|"$/g, '').toLowerCase();
      if (term.startsWith('from:')) { if (!m.from.toLowerCase().includes(term.slice(5))) return false; }
      else if (!t.includes(term)) return false;
    }
    return true;
  }

  // ---------- representations ----------
  const headersOf = (m) => {
    const h = [{ name: 'From', value: m.from }, { name: 'To', value: m.to || 'me@example.com' }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date(m.internalDate).toUTCString() }, { name: 'Message-ID', value: `<${m.id}@mock>` }, { name: 'Content-Type', value: (m.attachments || []).length ? 'multipart/mixed' : m.html ? 'multipart/alternative' : 'text/plain' }];
    if (m.listUnsubscribe) h.push({ name: 'List-Unsubscribe', value: '<mailto:unsub@x>' });
    for (let i = 0; i < (o.extraHeaders ?? 12); i++) h.push({ name: 'X-Mock-' + i, value: 'v'.repeat(40) }); // realistic header bloat
    return h;
  };
  function repr(m, format, metaHeaders) {
    const base = { id: m.id, threadId: m.threadId, labelIds: m.labelIds.slice(), snippet: m.snippet, internalDate: String(m.internalDate), historyId: m.historyId, sizeEstimate: (m.body || '').length + (m.html || '').length + 500 };
    let headers = headersOf(m);
    if (format === 'metadata') {
      if (metaHeaders && metaHeaders.length) headers = headers.filter((h) => metaHeaders.some((x) => x.toLowerCase() === h.name.toLowerCase()));
      return Object.assign(base, { payload: { mimeType: m.html ? 'multipart/alternative' : 'text/plain', headers } });
    }
    const parts = [];
    if (m.body) parts.push({ mimeType: 'text/plain', body: { data: b64(m.body), size: m.body.length } });
    if (m.html) parts.push({ mimeType: 'text/html', body: { data: b64(m.html), size: m.html.length } });
    (m.attachments || []).forEach((a, i) => parts.push({ mimeType: a.mimeType, filename: a.name, body: { attachmentId: `att-${m.id}-${i}`, size: a.size } }));
    stats.bodiesServed++;
    return Object.assign(base, { payload: { mimeType: 'multipart/mixed', headers, parts } });
  }

  function maybeFail(kind) {
    if (!fail.rate || (fail.kinds && !fail.kinds.includes(kind))) return null;
    if (rand() < fail.rate) { stats.failuresInjected++; return { ok: false, status: 429, reason: 'rateLimitExceeded', message: 'Rate limit (mock)', retryAfterMs: 50 }; }
    return null;
  }

  // ---------- REST ----------
  function handle(urlStr) {
    const u = new URL(urlStr, 'https://gmail.googleapis.com');
    const p = u.pathname.replace(/^\/gmail\/v1\/users\/me/, '');
    const qs = u.searchParams;
    if (p === '/profile') { charge('profile'); return { ok: true, status: 200, data: { emailAddress: o.email || 'test@example.com', historyId: String(historyId), messagesTotal: msgs.size } }; }
    if (p === '/messages') {
      charge('list'); const f = maybeFail('list'); if (f) return f;
      const labels = qs.getAll('labelIds'); const q = qs.get('q') || '';
      const all = [...msgs.values()].filter((m) => !m.labelIds.includes('SPAM') && !m.labelIds.includes('TRASH') && labels.every((l) => m.labelIds.includes(l)) && matchQ(m, q)).sort((a, b) => b.internalDate - a.internalDate);
      const max = Math.min(500, Number(qs.get('maxResults') || 100)), start = Number(qs.get('pageToken') || 0);
      const page = all.slice(start, start + max);
      return { ok: true, status: 200, data: { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: start + max < all.length ? String(start + max) : undefined, resultSizeEstimate: all.length } };
    }
    let mm = /^\/messages\/([^/]+)$/.exec(p);
    if (mm) {
      const fmt = qs.get('format') || 'full';
      charge(fmt === 'metadata' ? 'getMeta' : 'getFull'); const f = maybeFail(fmt === 'metadata' ? 'getMeta' : 'getFull'); if (f) return f;
      const m = msgs.get(decodeURIComponent(mm[1]));
      if (!m) return { ok: false, status: 404, reason: 'notFound', message: 'Not Found' };
      return { ok: true, status: 200, data: repr(m, fmt, qs.getAll('metadataHeaders')) };
    }
    if (p === '/history') {
      charge('history');
      const start = Number(qs.get('startHistoryId'));
      if (start < historyFloor) return { ok: false, status: 404, reason: 'notFound', message: 'Requested entity was not found.' };
      const ev = log.filter((e) => e.hid > start);
      const max = Number(qs.get('maxResults') || 100), from = Number(qs.get('pageToken') || 0);
      const page = ev.slice(from, from + max);
      const history = page.map((e) => {
        const m = msgs.get(e.id); const msg = { id: e.id, threadId: e.threadId, labelIds: m ? m.labelIds.slice() : undefined };
        if (e.type === 'added') return { id: String(e.hid), messagesAdded: [{ message: msg }] };
        if (e.type === 'deleted') return { id: String(e.hid), messagesDeleted: [{ message: { id: e.id, threadId: e.threadId } }] };
        return { id: String(e.hid), [e.type === 'labelAdded' ? 'labelsAdded' : 'labelsRemoved']: [{ message: msg, labelIds: [] }] };
      });
      return { ok: true, status: 200, data: { history, historyId: String(historyId), nextPageToken: from + max < ev.length ? String(from + max) : undefined } };
    }
    if (p === '/threads') {
      charge('threadsList');
      const byT = new Map(); [...msgs.values()].filter((m) => m.labelIds.includes('SENT')).forEach((m) => { const t = byT.get(m.threadId); if (!t || Number(m.historyId) > Number(t.historyId)) byT.set(m.threadId, { id: m.threadId, historyId: m.historyId }); });
      const max = Number(qs.get('maxResults') || 10);
      return { ok: true, status: 200, data: { threads: [...byT.values()].slice(0, max) } };
    }
    mm = /^\/threads\/([^/]+)$/.exec(p);
    if (mm) {
      charge('threadsGet');
      const id = decodeURIComponent(mm[1]); const list = [...msgs.values()].filter((m) => m.threadId === id).sort((a, b) => a.internalDate - b.internalDate);
      if (!list.length) return { ok: false, status: 404, reason: 'notFound' };
      return { ok: true, status: 200, data: { id, historyId: list[list.length - 1].historyId, messages: list.map((m) => repr(m, 'metadata', ['From', 'To', 'Subject', 'Date'])) } };
    }
    return { ok: false, status: 400, message: 'unsupported ' + p };
  }

  async function request(url) { return handle(url); }

  /** HTTP batch endpoint (multipart/mixed). */
  async function batchSend(batch) {
    stats.batchPosts++;
    const parts = batch.body.split('--' + batch.boundary).slice(1).filter((x) => !x.startsWith('--'));
    if (parts.length > 100) return { ok: false, status: 400, message: 'too many parts' };
    const res = new Map();
    for (const part of parts) {
      const id = /Content-ID:\s*<item-([^>]+)>/i.exec(part)[1];
      const path = /GET\s+(\S+)/.exec(part)[1];
      stats.batchParts++;
      const r = handle('https://gmail.googleapis.com' + path);
      res.set(id, { status: r.status, ok: r.ok, data: r.ok ? r.data : null, reason: r.reason || '', message: r.message || '', retryAfterMs: r.retryAfterMs || null });
    }
    if (o.batchTransportFails) return { ok: false, status: 0, message: 'CORS / network (mock)' };
    return { ok: true, status: 200, data: res };
  }

  return {
    add, remove, relabel, expireHistory, request, batchSend, stats, msgs,
    setNow: (t) => { now = t; }, now: () => now, historyId: () => historyId,
    setFailure: (rate, kinds) => { fail.rate = rate; fail.kinds = kinds || null; },
    resetStats: () => { Object.assign(stats, { calls: 0, units: 0, byKind: {}, batchPosts: 0, batchParts: 0, bodiesServed: 0, failuresInjected: 0 }); }
  };
}

module.exports = { createMockGmail, COST };
