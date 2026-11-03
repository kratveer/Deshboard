/**
 * Daylight Phase 1 — Gmail sync reliability simulation.
 *
 * A fake Gmail API (virtual clock, 6,000 units/min/user quota, pagination, history, threads,
 * fault injection) drives BOTH the legacy pipeline (copied from app.js v101) and the new
 * gmail-sync.js engine with the same refresh plan, so request counts, quota units, failures,
 * duplicates and duration can be compared before/after.
 *
 * Run: node tests/gmail-sync-sim.js        (writes tests/gmail-sync-sim-report.json)
 * Synthetic data only. No network, no credentials.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const GS = require('../gmail-sync.js');

// ---------------------------------------------------------------- virtual time
function makeClock() {
  let t = Date.UTC(2026, 10, 3, 18, 0, 0);
  let seq = 0;
  const timers = [];
  const now = () => t;
  const sleep = (ms) => new Promise((resolve) => { timers.push({ at: t + Math.max(0, ms), seq: seq++, resolve }); });
  async function run(promise) {
    let done = false, value, error;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
    for (let guard = 0; guard < 2e6; guard++) {
      await new Promise((r) => setImmediate(r));
      if (done) break;
      if (!timers.length) continue;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers.shift();
      t = Math.max(t, next.at);
      next.resolve();
    }
    if (error) throw error;
    return value;
  }
  const advance = (ms) => { t += ms; };
  return { now, sleep, run, advance };
}

// deterministic PRNG
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------- fake Gmail
const COST = { profile: 1, list: 5, getMeta: 20, getFull: 60, history: 2, threadsList: 10, threadGet: 40 };
function makeMailbox(n, seed) {
  const r = rng(seed);
  const msgs = [];
  const kinds = ['personal', 'promo', 'promo', 'finance', 'travel', 'docs', 'promo', 'personal', 'updates', 'finance'];
  for (let i = 0; i < n; i++) {
    const kind = kinds[Math.floor(r() * kinds.length)];
    const id = 'm' + (100000 + i).toString(16);
    const ageMin = i * 37 + Math.floor(r() * 20);
    const labels = [];
    const inInbox = r() < 0.7;
    if (inInbox) labels.push('INBOX');
    if (r() < 0.5) labels.push('UNREAD');
    labels.push({ personal: 'CATEGORY_PERSONAL', promo: 'CATEGORY_PROMOTIONS', finance: 'CATEGORY_UPDATES', travel: 'CATEGORY_UPDATES', docs: 'CATEGORY_PERSONAL', updates: 'CATEGORY_UPDATES' }[kind]);
    const from = { personal: 'Ana <ana@uni.cz>', promo: 'Deals <news@shop.example>', finance: r() < 0.5 ? 'PayPal <service@paypal.com>' : 'ČEZ <noreply@cez.cz>', travel: 'RegioJet <jizdenky@regiojet.cz>', docs: 'HR <docs@company.com>', updates: 'GitHub <noreply@github.com>' }[kind];
    const subject = {
      personal: 'Quick question #' + i,
      promo: r() < 0.5 ? 'Flash sale: flights from 499 Kč' : 'Premium membership 50% off',
      finance: 'Your invoice ' + i + ' · 499 Kč payment due',
      travel: 'Your train booking confirmation ' + i,
      docs: 'Please sign the contract ' + i,
      updates: 'Build passed #' + i
    }[kind];
    msgs.push({ id, threadId: 't' + id.slice(1), kind, labels, from, subject, internalDate: 0, ageMin, attachment: kind === 'docs' || (kind === 'travel' && r() < 0.5) });
  }
  return msgs;
}

function makeGmail(opts) {
  const o = Object.assign({ size: 400, seed: 7, latencyMs: 80, quotaPerMinute: 6000, chargeRejected: false }, opts || {});
  const clock = o.clock;
  const r = rng(o.seed + 99);
  let msgs = makeMailbox(o.size, o.seed);
  msgs.forEach((m) => { m.internalDate = clock.now() - m.ageMin * 60000; });
  let historyId = 5000;
  const historyLog = []; // { id, type, msgId, labels }
  let historyFloor = historyId; // older cursors → 404
  const sentThreads = msgs.filter((m) => m.kind === 'personal').slice(0, 14).map((m, i) => ({ id: m.threadId, historyId: String(4000 + i), last: m }));
  const ledger = [];
  const stats = { calls: 0, accepted: 0, rejectedQuota: 0, injected: 0, units: 0, byKind: {}, concurrent: 0, peakConcurrent: 0, starts: [], getsById: {} };
  const faults = { rules: [], tokenValid: true };

  const used = () => { const t = clock.now(); while (ledger.length && ledger[0].t <= t - 60000) ledger.shift(); return ledger.reduce((a, x) => a + x.u, 0); };
  const quotaErr = { status: 403, body: { error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'", errors: [{ reason: 'rateLimitExceeded' }], status: 'PERMISSION_DENIED' } } };

  const byQuery = (params) => {
    if (params.get('labelIds') === 'INBOX') return msgs.filter((m) => m.labels.includes('INBOX'));
    if (params.get('labelIds') === 'SENT') return sentThreads.map((t) => t.last); // legacy path lists SENT messages
    const q = params.get('q') || '';
    if (/newer_than:120d/.test(q)) return msgs.filter((m) => m.kind === 'finance' || (m.kind === 'promo' && /Premium/.test(m.subject)));
    if (/category:updates/.test(q)) return msgs.filter((m) => m.kind === 'finance');
    if (/from:paypal/.test(q)) return msgs.filter((m) => m.kind === 'finance' && /paypal/.test(m.from));
    if (/flight OR train/.test(q)) return msgs.filter((m) => m.kind === 'travel' || (m.kind === 'promo' && /flights/.test(m.subject)));
    if (/has:attachment/.test(q)) return msgs.filter((m) => m.attachment);
    return [];
  };
  const shape = (m, format) => {
    const headers = [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date(m.internalDate).toUTCString() }, { name: 'To', value: 'me@example.com' }];
    const base = { id: m.id, threadId: m.threadId, labelIds: [...m.labels], snippet: m.subject + ' — snippet', internalDate: String(m.internalDate), historyId: String(historyId), sizeEstimate: 2048 };
    if (format === 'full') {
      const body = Buffer.from(m.subject + '. Amount 499 Kč. Departure 10 Nov 07:30.').toString('base64url');
      return { ...base, payload: { mimeType: 'multipart/mixed', headers, parts: [{ mimeType: 'text/plain', body: { data: body } }, ...(m.attachment ? [{ mimeType: 'application/pdf', filename: 'doc-' + m.id + '.pdf', body: {} }] : [])] } };
    }
    return { ...base, payload: { mimeType: 'multipart/mixed', headers } };
  };

  async function handle(url) {
    const u = new URL(url);
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    let kind, cost;
    if (p === '/profile') { kind = 'profile'; cost = COST.profile; }
    else if (p === '/messages') { kind = 'list'; cost = COST.list; }
    else if (p.startsWith('/messages/')) { const f = u.searchParams.get('format'); kind = f === 'full' ? 'getFull' : 'getMeta'; cost = f === 'full' ? COST.getFull : COST.getMeta; }
    else if (p === '/history') { kind = 'history'; cost = COST.history; }
    else if (p === '/threads') { kind = 'threadsList'; cost = COST.threadsList; }
    else if (p.startsWith('/threads/')) { kind = 'threadGet'; cost = COST.threadGet; }
    else return { status: 404, body: { error: { message: 'unknown ' + p } } };
    stats.calls++; stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    stats.starts.push(clock.now());
    if (kind === 'getMeta' || kind === 'getFull') { const id = p.split('/')[2] + '|' + kind; stats.getsById[id] = (stats.getsById[id] || 0) + 1; }

    if (!faults.tokenValid) return { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } };
    for (const rule of faults.rules) {
      if (rule.until && clock.now() > rule.until) continue;
      if (rule.kinds && !rule.kinds.includes(kind)) continue;
      if (rule.match && !rule.match(u, kind)) continue;
      if (r() < rule.rate) {
        stats.injected++;
        if (rule.type === 'network') throw new TypeError('Failed to fetch');
        if (rule.type === '429') return { status: 429, body: { error: { code: 429, message: 'Too many requests', errors: [{ reason: 'rateLimitExceeded' }] } }, retryAfter: rule.retryAfter };
        if (rule.type === '403rate') return quotaErr;
        if (rule.type === '500') return { status: 500, body: { error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } };
        if (rule.type === '503') return { status: 503, body: { error: { code: 503, message: 'Service unavailable' } } };
      }
    }
    if (used() + cost > o.quotaPerMinute) { stats.rejectedQuota++; if (o.chargeRejected) ledger.push({ t: clock.now(), u: cost }); return quotaErr; }
    ledger.push({ t: clock.now(), u: cost }); stats.accepted++; stats.units += cost;

    if (kind === 'profile') return { status: 200, body: { emailAddress: 'me@example.com', messagesTotal: msgs.length, historyId: String(historyId) } };
    if (kind === 'list') {
      const all = byQuery(u.searchParams).sort((a, b) => b.internalDate - a.internalDate);
      const off = Number(u.searchParams.get('pageToken') || 0), n = Number(u.searchParams.get('maxResults') || 100);
      const page = all.slice(off, off + n);
      const body = { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: all.length };
      if (off + n < all.length) body.nextPageToken = String(off + n);
      return { status: 200, body };
    }
    if (kind === 'getMeta' || kind === 'getFull') {
      const id = decodeURIComponent(p.split('/')[2]);
      const m = msgs.find((x) => x.id === id);
      if (!m) return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.' } } };
      return { status: 200, body: shape(m, kind === 'getFull' ? 'full' : 'metadata') };
    }
    if (kind === 'history') {
      const start = Number(u.searchParams.get('startHistoryId'));
      if (start < historyFloor) return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.' } } };
      const entries = historyLog.filter((h) => h.id > start);
      const off = Number(u.searchParams.get('pageToken') || 0), n = 100;
      const page = entries.slice(off, off + n).map((h) => {
        if (h.type === 'added') return { id: String(h.id), messagesAdded: [{ message: { id: h.msgId, threadId: 't' + h.msgId.slice(1), labelIds: h.labels } }] };
        if (h.type === 'deleted') return { id: String(h.id), messagesDeleted: [{ message: { id: h.msgId } }] };
        if (h.type === 'labelAdded') return { id: String(h.id), labelsAdded: [{ message: { id: h.msgId }, labelIds: h.labels }] };
        return { id: String(h.id), labelsRemoved: [{ message: { id: h.msgId }, labelIds: h.labels }] };
      });
      const body = { history: page, historyId: String(historyId) };
      if (off + n < entries.length) body.nextPageToken = String(off + n);
      return { status: 200, body };
    }
    if (kind === 'threadsList') {
      const max = Number(u.searchParams.get('maxResults') || 10);
      return { status: 200, body: { threads: sentThreads.slice(0, max).map((t) => ({ id: t.id, historyId: t.historyId, snippet: '' })) } };
    }
    if (kind === 'threadGet') {
      const id = decodeURIComponent(p.split('/')[2]);
      const t = sentThreads.find((x) => x.id === id);
      if (!t) return { status: 404, body: { error: { code: 404, message: 'not found' } } };
      return { status: 200, body: { id: t.id, historyId: t.historyId, messages: [{ ...shape(t.last, 'metadata'), labelIds: ['SENT'] }] } };
    }
  }

  // HTTP-ish transport with latency + concurrency accounting
  async function transport(url) {
    stats.concurrent++; stats.peakConcurrent = Math.max(stats.peakConcurrent, stats.concurrent);
    try {
      await clock.sleep(o.latencyMs);
      const res = await handle(url);
      return res;
    } finally { stats.concurrent--; }
  }

  const mutate = {
    addMessage(kind) {
      const m = makeMailbox(1, Math.floor(r() * 1e6))[0];
      m.id = 'n' + (historyId + 1).toString(16); m.threadId = 't' + m.id.slice(1); m.kind = kind || m.kind; m.labels = ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL']; m.subject = 'Brand new mail ' + m.id; m.from = 'Bob <bob@uni.cz>'; m.internalDate = clock.now();
      msgs.unshift(m); historyId++; historyLog.push({ id: historyId, type: 'added', msgId: m.id, labels: m.labels }); return m;
    },
    deleteMessage(id) { msgs = msgs.filter((m) => m.id !== id); historyId++; historyLog.push({ id: historyId, type: 'deleted', msgId: id }); },
    markRead(id) { const m = msgs.find((x) => x.id === id); m.labels = m.labels.filter((l) => l !== 'UNREAD'); historyId++; historyLog.push({ id: historyId, type: 'labelRemoved', msgId: id, labels: ['UNREAD'] }); },
    archive(id) { const m = msgs.find((x) => x.id === id); m.labels = m.labels.filter((l) => l !== 'INBOX'); historyId++; historyLog.push({ id: historyId, type: 'labelRemoved', msgId: id, labels: ['INBOX'] }); },
    expireHistory() { historyFloor = historyId + 1; },
    replyInThread(i) { const t = sentThreads[i]; t.historyId = String(Number(t.historyId) + 1000); }
  };
  const resetStats = () => { Object.assign(stats, { calls: 0, accepted: 0, rejectedQuota: 0, injected: 0, units: 0, byKind: {}, peakConcurrent: 0, starts: [], getsById: {} }); };
  const preload = (units) => { ledger.push({ t: clock.now(), u: units }); };
  return { transport, stats, faults, mutate, resetStats, preload, msgs: () => msgs, used, historyId: () => historyId };
}

// ---------------------------------------------------------------- clients
// New engine request(): mirrors app.js gmailRequest() (token refresh on 401 once).
function engineRequest(gmail, auth) {
  return async (url) => {
    let res = await gmail.transport(url);
    if (res.status === 401 && auth && auth.refresh()) { gmail.faults.tokenValid = true; res = await gmail.transport(url); }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, data: res.body };
    return { ok: false, status: res.status, data: res.body, reason: res.body?.error?.errors?.[0]?.reason || res.body?.error?.status || '', message: res.body?.error?.message || '', retryAfterMs: res.retryAfter != null ? res.retryAfter * 1000 : null };
  };
}

// Legacy pipeline (app.js v101 lines 414-419 + 896-977), with api() semantics.
function legacyClient(gmail, clock, auth) {
  const api = async (url, retried) => {
    let res;
    res = await gmail.transport(url); // network errors propagate like fetch
    if (res.status === 401 && auth && !retried && auth.refresh()) { gmail.faults.tokenValid = true; return api(url, true); }
    if (res.status < 200 || res.status >= 300) { const e = new Error(res.body?.error?.message || `Google API error (${res.status})`); e.status = res.status; e.code = res.body?.error?.status || res.body?.error?.errors?.[0]?.reason || ''; throw e; }
    return res.body;
  };
  async function apiRetry(url, maxAttempts = 3) {
    let lastErr = null, retries = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try { return { data: await api(url), retries }; }
      catch (e) {
        lastErr = e; retries = attempt;
        const st = e.status || 0;
        const retryable = st === 429 || st === 500 || st === 502 || st === 503 || st === 504 || !st;
        if (!retryable || attempt === maxAttempts - 1) break;
        await clock.sleep(Math.min(4000, 350 * Math.pow(2, attempt)) + Math.random() * 120);
      }
    }
    throw lastErr || new Error('Request failed');
  }
  const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
  async function loadMail() {
    const list = await api(`${G}/messages?labelIds=INBOX&maxResults=10`);
    const msgs = await Promise.all((list.messages || []).map((m) => api(`${G}/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    return msgs;
  }
  async function loadLoops(cursor) {
    let syncFailed = 0;
    const meta = (id) => apiRetry(`${G}/messages/${encodeURIComponent(id)}?format=full&fields=id`).then((r) => r.data);
    const listMeta = async (qs, n = 12, pages = 2) => {
      try {
        const out = []; let pageToken = '';
        for (let p = 0; p < pages && out.length < n; p++) {
          const u = `${G}/messages?${qs}&maxResults=${Math.min(50, n - out.length)}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
          const { data: r } = await apiRetry(u);
          const ids = r.messages || []; if (!ids.length) break;
          const batch = await Promise.all(ids.map((m) => meta(m.id).catch(() => null)));
          batch.filter(Boolean).forEach((m) => out.push(m));
          pageToken = r.nextPageToken || ''; if (!pageToken) break;
        }
        return out;
      } catch (e) { syncFailed++; return []; }
    };
    let historyId = cursor;
    try {
      const { data: prof } = await apiRetry(`${G}/profile`);
      if (prof?.historyId) {
        if (historyId && historyId !== prof.historyId) {
          try {
            const { data: hist } = await apiRetry(`${G}/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&maxResults=50`);
            const added = (hist.history || []).flatMap((h) => (h.messagesAdded || []).map((x) => x.message)).filter((m) => m?.id).slice(0, 20);
            if (added.length) { const extras = await Promise.all(added.map((m) => meta(m.id).catch(() => null))); listMeta._historyExtras = extras.filter(Boolean); }
            if (hist.historyId) historyId = hist.historyId;
          } catch (e) { historyId = prof.historyId; }
        } else historyId = prof.historyId;
      }
    } catch {}
    const enc = encodeURIComponent;
    const [inbox, a, b, c, travel, docs, sent] = await Promise.all([
      listMeta('labelIds=INBOX', 50, 2),
      listMeta('q=' + enc('newer_than:120d (subscription OR renew)'), 30, 2),
      listMeta('q=' + enc('newer_than:90d category:updates (bill)'), 20, 1),
      listMeta('q=' + enc('newer_than:180d (from:paypal.com)'), 25, 1),
      listMeta('q=' + enc('(flight OR train OR booking) newer_than:45d'), 15, 1),
      listMeta('q=' + enc('(document) newer_than:45d has:attachment'), 12, 1),
      apiRetry(`${G}/messages?labelIds=SENT&maxResults=15`).then((r) => r.data).catch(() => ({ messages: [] }))
    ]);
    const byId = new Map(); [...(listMeta._historyExtras || []), ...inbox, ...a, ...b, ...c, ...travel, ...docs].forEach((m) => { if (m?.id) byId.set(m.id, m); });
    // legacy SENT: messages.list SENT then threads.get for unique threads (fake: reuse thread list)
    const threadIds = [...new Set((sent.messages || []).map((m) => m.threadId))].slice(0, 12);
    const threads = await Promise.all(threadIds.map((t) => apiRetry(`${G}/threads/${enc(t)}?format=metadata`).then((r) => r.data).catch(() => null)));
    return { byId, threads: threads.filter(Boolean), cursor: historyId, reportedSuccess: true, syncFailed };
  }
  return { loadMail, loadLoops };
}

const ENGINE_QUERIES = () => {
  const enc = encodeURIComponent;
  return [
    { key: 'inbox', params: 'labelIds=INBOX', max: 50, pages: 2, body: 'auto' },
    { key: 'moneyA', params: 'q=' + enc('newer_than:120d (subscription OR renew)'), max: 30, pages: 2, body: 'full' },
    { key: 'moneyB', params: 'q=' + enc('newer_than:90d category:updates (bill)'), max: 20, pages: 1, body: 'full' },
    { key: 'moneyC', params: 'q=' + enc('newer_than:180d (from:paypal.com)'), max: 25, pages: 1, body: 'full' },
    { key: 'travel', params: 'q=' + enc('(flight OR train OR booking) newer_than:45d'), max: 15, pages: 1, body: 'full' },
    { key: 'docs', params: 'q=' + enc('(document) newer_than:45d has:attachment'), max: 12, pages: 1, body: 'full' }
  ];
};
const wantsBody = (m) => {
  const l = m.labelIds || [];
  if (l.some((x) => /^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/.test(x))) return false;
  const h = m.payload?.headers || [];
  const t = h.map((x) => x.value).join(' ') + ' ' + (m.snippet || '');
  return /invoice|payment|booking|contract|flight|train/i.test(t);
};

// Expected universe = what the plan's queries return in the fake mailbox right now
function expectedIds(gmail) {
  const msgs = gmail.msgs();
  const take = (arr, n) => arr.sort((a, b) => b.internalDate - a.internalDate).slice(0, n).map((m) => m.id);
  const s = new Set([
    ...take(msgs.filter((m) => m.labels.includes('INBOX')), 50),
    ...take(msgs.filter((m) => m.kind === 'finance' || (m.kind === 'promo' && /Premium/.test(m.subject))), 30),
    ...take(msgs.filter((m) => m.kind === 'finance'), 20),
    ...take(msgs.filter((m) => m.kind === 'finance' && /paypal/.test(m.from)), 25),
    ...take(msgs.filter((m) => m.kind === 'travel' || (m.kind === 'promo' && /flights/.test(m.subject))), 15),
    ...take(msgs.filter((m) => m.attachment), 12)
  ]);
  return s;
}

function peakPerSecond(starts) {
  let peak = 0, j = 0; const s = [...starts].sort((a, b) => a - b);
  for (let i = 0; i < s.length; i++) { while (s[i] - s[j] >= 1000) j++; peak = Math.max(peak, i - j + 1); }
  return peak;
}
function metrics(gmail, t0, t1, expected, gotIds) {
  const gets = Object.values(gmail.stats.getsById).reduce((a, b) => a + b, 0);
  const uniqueGets = Object.keys(gmail.stats.getsById).length;
  const lost = [...expected].filter((id) => !gotIds.has(id));
  return {
    requests: gmail.stats.calls,
    acceptedRequests: gmail.stats.accepted,
    quotaUnits: gmail.stats.units,
    quota403: gmail.stats.rejectedQuota,
    injectedFaults: gmail.stats.injected,
    peakRequestsPerSecond: peakPerSecond(gmail.stats.starts),
    peakConcurrent: gmail.stats.peakConcurrent,
    messageGets: gets,
    duplicateGets: gets - uniqueGets, // same message fetched twice in the same format
    bodyUpgrades: Object.keys(gmail.stats.getsById).filter((k) => k.endsWith('|getFull') && gmail.stats.getsById[k.replace('|getFull', '|getMeta')]).length,
    nonBodyUnits: gmail.stats.units - (gmail.stats.byKind.getFull || 0) * 0, 
    expectedRecords: expected.size,
    recordsReturned: gotIds.size,
    recordsLost: lost.length,
    durationMs: t1 - t0,
    byKind: { ...gmail.stats.byKind }
  };
}

async function runLegacy(gmail, clock, cursor, auth) {
  const L = legacyClient(gmail, clock, auth);
  gmail.resetStats();
  const t0 = clock.now();
  const [mail, loops] = await clock.run(Promise.all([L.loadMail().catch((e) => ({ error: e.message })), L.loadLoops(cursor)]));
  const t1 = clock.now();
  const ids = new Set(loops.byId.keys());
  return { m: metrics(gmail, t0, t1, expectedIds(gmail), ids), loops, mail, reported: 'success (always)' };
}
async function runEngine(engine, gmail, clock, cursor) {
  gmail.resetStats();
  const t0 = clock.now();
  const [mail, sync] = await clock.run(Promise.all([engine.fetchList('labelIds=INBOX', 10, 'metadata'), engine.sync({ cursor, queries: ENGINE_QUERIES(), wantsBody, sentThreads: 12 })]));
  const t1 = clock.now();
  const ids = new Set(); Object.values(sync.pools).forEach((arr) => arr.forEach((m) => ids.add(m.id))); (sync.historyExtras || []).forEach((m) => ids.add(m.id));
  return { m: metrics(gmail, t0, t1, expectedIds(gmail), ids), sync, mail, ids };
}

// ---------------------------------------------------------------- scenarios
const results = []; let pass = 0, fail = 0;
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail }); if (cond) pass++; else { fail++; console.log('  FAIL', name, detail ? JSON.stringify(detail).slice(0, 400) : ''); } }
const newEngine = (gmail, clock, auth, cfg) => GS.createGmailSync({ request: engineRequest(gmail, auth), now: clock.now, sleep: clock.sleep, random: rng(3), config: cfg });

async function main() {
  const out = { generatedAt: new Date().toISOString(), scenarios: {} };

  // S1 realistic refresh: before/after, cold + warm
  {
    const clock = makeClock(); const gmail = makeGmail({ clock, size: 600, seed: 11 });
    const before = await runLegacy(gmail, clock, null);
    clock.advance(120000);
    const engine = newEngine(gmail, clock);
    const cold = await runEngine(engine, gmail, clock, null);
    clock.advance(30000);
    const warm = await runEngine(engine, gmail, clock, cold.sync.cursor);
    clock.advance(180000);
    const warm2 = await runEngine(engine, gmail, clock, warm.sync.cursor);
    clock.advance(180000);
    const warm3 = await runEngine(engine, gmail, clock, warm2.sync.cursor);
    out.scenarios.S1_realistic = { legacy: before.m, engineCold: cold.m, engineCold_report: pick(cold.sync.report), engineWarm30s: warm.m, engineWarm_report: pick(warm.sync.report), engineWarm3min: warm2.m, engineWarm6min: warm3.m };
    check('S1 cold: quota units under 6,000/min', cold.m.quotaUnits < 6000, cold.m.quotaUnits);
    check('S1 cold: zero quota 403s', cold.m.quota403 === 0, cold.m.quota403);
    check('S1 cold: no duplicate message GETs', cold.m.duplicateGets === 0, cold.m.duplicateGets);
    check('S1 cold: no records lost', cold.m.recordsLost === 0, cold.m);
    check('S1 cold: ≤ 6 in flight', cold.m.peakConcurrent <= 6, cold.m.peakConcurrent);
    check('S1 cold: report ok (not partial)', cold.sync.report.ok === true, cold.sync.report.summary);
    check('S1 warm: no metadata re-fetch of unchanged mail', (warm.m.byKind.getMeta || 0) === 0, warm.m.byKind);
    check('S1 warm: only queued bodies fetched', (warm.m.byKind.getFull || 0) <= cold.sync.report.records.bodyDeferred, [warm.m.byKind.getFull, cold.sync.report.records.bodyDeferred]);
    check('S1 warm: report ok', warm.sync.report.ok, warm.sync.report.summary);
    check('S1 bodies converge: refresh 4 costs ≤ 10% of cold', warm3.m.quotaUnits <= cold.m.quotaUnits * 0.10, [cold.m.quotaUnits, warm.m.quotaUnits, warm2.m.quotaUnits, warm3.m.quotaUnits]);
    check('S1 warm: no records lost', warm.m.recordsLost === 0, warm.m.recordsLost);
    check('S1 legacy reproduces baseline problem (duplicates or quota)', before.m.duplicateGets > 0 && before.m.quotaUnits > cold.m.quotaUnits, before.m);
  }

  // S2 large inbox (5,000 messages) with a bigger plan
  {
    const clock = makeClock(); const gmail = makeGmail({ clock, size: 5000, seed: 21 });
    const legacy = await runLegacy(gmail, clock, null);
    clock.advance(120000);
    const engine = newEngine(gmail, clock);
    const cold = await runEngine(engine, gmail, clock, null);
    out.scenarios.S2_large_inbox = { legacy: legacy.m, engine: cold.m, report: pick(cold.sync.report) };
    check('S2 large: units < 6,000', cold.m.quotaUnits < 6000, cold.m.quotaUnits);
    check('S2 large: no lost records', cold.m.recordsLost === 0, cold.m.recordsLost);
    check('S2 large: duplicatesAvoided reported', cold.sync.report.duplicatesAvoided > 0, cold.sync.report.duplicatesAvoided);
  }

  // S3 quota already mostly used by another tab (5,500 of 6,000 units in the last minute)
  {
    const clock = makeClock(); const g1 = makeGmail({ clock, size: 600, seed: 31 });
    g1.preload(5500);
    const legacy = await runLegacy(g1, clock, null);
    const clock2 = makeClock(); const g2 = makeGmail({ clock: clock2, size: 600, seed: 31 });
    g2.preload(5500);
    const engine = newEngine(g2, clock2, null, { limitPerMinute: 6000 });
    const eng = await runEngine(engine, g2, clock2, null);
    out.scenarios.S3_quota_exhaustion = { legacy: { ...legacy.m, reported: legacy.reported }, engine: eng.m, report: pick(eng.sync.report) };
    check('S3 legacy loses records silently', legacy.m.recordsLost > 0, legacy.m.recordsLost);
    check('S3 engine: no silent loss (lost == failed + deferred)', eng.m.recordsLost === (eng.sync.report.records.failed + eng.sync.report.records.deferred), [eng.m.recordsLost, eng.sync.report.records]);
    check('S3 engine: never reports success when incomplete', eng.m.recordsLost === 0 ? true : eng.sync.report.partial === true, eng.sync.report.summary);
    // recovery a few minutes later
    clock2.advance(180000);
    const rec = await runEngine(engine, g2, clock2, eng.sync.cursor);
    out.scenarios.S3_recovery = { engine: rec.m, report: pick(rec.sync.report) };
    check('S3 recovery: all records present after next sync', rec.m.recordsLost === 0, rec.m.recordsLost);
    check('S3 recovery: report ok', rec.sync.report.ok, rec.sync.report.summary);
  }

  // S4 429 storm (35% of requests for 20 s) with Retry-After: 2
  // S5 403 rateLimitExceeded (25%) / S6 5xx (20%) / S7 network drops (15%)
  const faultCases = [
    ['S4_429_storm', { type: '429', rate: 0.35, retryAfter: 2, untilMs: 20000 }],
    ['S5_403_rate', { type: '403rate', rate: 0.25, untilMs: 20000 }],
    ['S6_5xx', { type: '500', rate: 0.2, untilMs: 20000 }],
    ['S7_network', { type: 'network', rate: 0.15, untilMs: 20000 }]
  ];
  for (const [name, f] of faultCases) {
    const clockL = makeClock(); const gL = makeGmail({ clock: clockL, size: 600, seed: 41 });
    gL.faults.rules.push({ type: f.type, rate: f.rate, retryAfter: f.retryAfter, until: clockL.now() + f.untilMs });
    const legacy = await runLegacy(gL, clockL, null);
    const clockE = makeClock(); const gE = makeGmail({ clock: clockE, size: 600, seed: 41 });
    gE.faults.rules.push({ type: f.type, rate: f.rate, retryAfter: f.retryAfter, until: clockE.now() + f.untilMs });
    const engine = newEngine(gE, clockE);
    const eng = await runEngine(engine, gE, clockE, null);
    out.scenarios[name] = { legacy: { ...legacy.m, reported: legacy.reported }, engine: eng.m, report: pick(eng.sync.report) };
    const rr = eng.sync.report.records;
    check(`${name}: engine accounts for every missing record`, eng.m.recordsLost === rr.failed + rr.deferred, [eng.m.recordsLost, rr]);
    check(`${name}: engine status truthful`, (eng.m.recordsLost > 0 || eng.sync.report.queryErrors.length) ? eng.sync.report.partial : true, eng.sync.report.summary);
    check(`${name}: engine retried`, eng.sync.report.retries > 0, eng.sync.report.retries);
    check(`${name}: engine loses fewer records than legacy`, eng.m.recordsLost <= legacy.m.recordsLost, [legacy.m.recordsLost, eng.m.recordsLost]);
  }

  // S8 expired token: (a) refresh works → transparent; (b) refresh fails → stops fast, reported
  {
    const clock = makeClock(); const g = makeGmail({ clock, size: 300, seed: 51 });
    g.faults.tokenValid = false;
    const engine = newEngine(g, clock, { refresh: () => true });
    const a = await runEngine(engine, g, clock, null);
    check('S8a expired token + refresh: complete', a.m.recordsLost === 0 && a.sync.report.ok, a.sync.report.summary);
    const clock2 = makeClock(); const g2 = makeGmail({ clock: clock2, size: 300, seed: 51 });
    g2.faults.tokenValid = false;
    const engine2 = newEngine(g2, clock2, { refresh: () => false });
    const b = await runEngine(engine2, g2, clock2, null);
    out.scenarios.S8_expired_token = { refreshOk: a.m, refreshFails: b.m, refreshFailsReport: pick(b.sync.report) };
    check('S8b refresh fails: reported as stopped/partial', b.sync.report.partial && b.sync.report.fatal?.kind === 'auth', b.sync.report.summary);
    check('S8b refresh fails: few wasted requests (≤ 12)', b.m.requests <= 12, b.m.requests);
    check('S8b refresh fails: cursor not advanced', b.sync.cursor == null, b.sync.cursor);
  }

  // S9 partial responses: page 2 of the inbox list always 500; one message permanently 500
  {
    const clock = makeClock(); const g = makeGmail({ clock, size: 600, seed: 61 });
    const engine = newEngine(g, clock, null, { maxAttempts: 3 });
    // make inbox need 2 pages
    const plan = ENGINE_QUERIES(); plan[0] = { ...plan[0], max: 150, pages: 2 };
    g.faults.rules.push({ type: '500', rate: 1, match: (u, kind) => kind === 'list' && u.searchParams.get('labelIds') === 'INBOX' && u.searchParams.get('pageToken') });
    const victim = g.msgs().filter((m) => m.labels.includes('INBOX'))[3].id;
    g.faults.rules.push({ type: '503', rate: 1, match: (u, kind) => kind.startsWith('get') && u.pathname.endsWith('/' + victim) });
    g.resetStats();
    const s = await clock.run(engine.sync({ queries: plan, wantsBody, sentThreads: 12 }));
    const inboxErr = s.report.queries.find((q) => q.key === 'inbox');
    out.scenarios.S9_partial_responses = { report: pick(s.report) };
    check('S9 page-2 failure keeps page-1 results', inboxErr.count === 100 && inboxErr.error, inboxErr);
    check('S9 failed message listed in failures', s.report.failures.some((f) => f.id === victim && f.status === 'failed'), s.report.failures.slice(0, 3));
    check('S9 reported partial', s.report.partial && /failed/.test(s.report.summary), s.report.summary);
  }

  // S10 repeated refreshes: no duplicates, cached records, stable totals
  {
    const clock = makeClock(); const g = makeGmail({ clock, size: 600, seed: 71 });
    const engine = newEngine(g, clock);
    let cursor = null; const units = []; const dupWithinPool = [];
    for (let i = 0; i < 4; i++) {
      const r = await runEngine(engine, g, clock, cursor); cursor = r.sync.cursor; units.push(r.m.quotaUnits);
      Object.values(r.sync.pools).forEach((arr) => { const ids = arr.map((m) => m.id); dupWithinPool.push(ids.length - new Set(ids).size); });
      clock.advance(150000);
    }
    out.scenarios.S10_repeated = { unitsPerRefresh: units };
    check('S10 no duplicates inside any pool', dupWithinPool.every((d) => d === 0), dupWithinPool);
    check('S10 refreshes 2-3 only fill queued bodies (≤ 60%), 4 ≤ 10%', units[1] <= units[0] * 0.6 && units[2] <= units[0] * 0.6 && units[3] <= units[0] * 0.10, units);
  }

  // S11 incremental: new, modified (read/archived), deleted mail; then expired cursor recovery
  {
    const clock = makeClock(); const g = makeGmail({ clock, size: 600, seed: 81 });
    const engine = newEngine(g, clock);
    const s1 = await runEngine(engine, g, clock, null);
    const inboxIds = s1.sync.pools.inbox.map((m) => m.id);
    const unreadTarget = s1.sync.pools.inbox.find((m) => m.labelIds.includes('UNREAD')).id;
    const delTarget = inboxIds[5], archTarget = inboxIds[7];
    const added = g.mutate.addMessage('personal');
    g.mutate.markRead(unreadTarget); g.mutate.deleteMessage(delTarget); g.mutate.archive(archTarget);
    clock.advance(60000);
    const s2 = await runEngine(engine, g, clock, s1.sync.cursor);
    const all2 = new Map(); Object.values(s2.sync.pools).forEach((a) => a.forEach((m) => all2.set(m.id, m)));
    check('S11 new message appears', all2.has(added.id) && s2.sync.pools.inbox[0].id === added.id, s2.sync.pools.inbox[0]?.id);
    check('S11 deleted message gone', !all2.has(delTarget), delTarget);
    check('S11 read label applied from history', all2.get(unreadTarget) ? !all2.get(unreadTarget).labelIds.includes('UNREAD') : true, all2.get(unreadTarget)?.labelIds);
    check('S11 archived message leaves inbox pool', !s2.sync.pools.inbox.some((m) => m.id === archTarget), archTarget);
    check('S11 history mode incremental', s2.sync.report.history.mode === 'incremental', s2.sync.report.history);
    // new mail + one older message that slides into the 50-message inbox window after a delete/archive
    check('S11 incremental: metadata fetched only for mail entering the window', (s2.m.byKind.getMeta || 0) <= 2, s2.m.byKind);
    // expired cursor → recovery
    g.mutate.markRead(s2.sync.pools.inbox.find((m) => m.labelIds.includes('UNREAD'))?.id || inboxIds[9]);
    g.mutate.expireHistory();
    clock.advance(60000);
    const s3 = await runEngine(engine, g, clock, s2.sync.cursor);
    out.scenarios.S11_incremental = { second: s2.m, secondReport: pick(s2.sync.report), recovery: s3.m, recoveryReport: pick(s3.sync.report) };
    check('S11 expired cursor → recovery mode', /recovery/.test(s3.sync.report.history.mode), s3.sync.report.history);
    check('S11 recovery: labels correct for every inbox message', s3.sync.pools.inbox.every((m) => { const src = g.msgs().find((x) => x.id === m.id); return src && JSON.stringify([...src.labels].sort()) === JSON.stringify([...m.labelIds].sort()); }));
    check('S11 recovery report ok', s3.sync.report.ok, s3.sync.report.summary);
  }

  // S12 recovery after a failed sync + stale preservation
  {
    const clock = makeClock(); const g = makeGmail({ clock, size: 600, seed: 91 });
    const engine = newEngine(g, clock, null, { maxAttempts: 2 });
    const ok1 = await runEngine(engine, g, clock, null);
    g.mutate.markRead(ok1.sync.pools.inbox[0].id); g.mutate.expireHistory(); // cursor now invalid → cached labels must be re-checked
    g.faults.rules.push({ type: '500', rate: 1, kinds: ['getMeta', 'getFull'] });
    clock.advance(60000);
    const bad = await runEngine(engine, g, clock, ok1.sync.cursor);
    check('S12 failed refresh keeps previous copies (stale, not lost)', bad.m.recordsLost === 0 && bad.sync.report.records.stale > 0, bad.sync.report.records);
    check('S12 failed refresh reported partial', bad.sync.report.partial, bad.sync.report.summary);
    g.faults.rules.length = 0;
    clock.advance(60000);
    const good = await runEngine(engine, g, clock, bad.sync.cursor);
    out.scenarios.S12_recovery = { failedRun: pick(bad.sync.report), nextRun: pick(good.sync.report) };
    check('S12 next sync recovers fully', good.sync.report.ok && good.m.recordsLost === 0, good.sync.report.summary);
  }

  // S13 sent threads re-fetched only when changed
  {
    const clock = makeClock(); const g = makeGmail({ clock, size: 300, seed: 101 });
    const engine = newEngine(g, clock);
    const a = await runEngine(engine, g, clock, null);
    g.mutate.replyInThread(2);
    clock.advance(150000);
    const b = await runEngine(engine, g, clock, a.sync.cursor);
    check('S13 only the changed thread re-fetched', b.sync.report.sent.fetched === 1 && b.sync.report.sent.cached === a.sync.report.sent.fetched - 1, b.sync.report.sent);
  }

  // Unit checks: failure classification + backoff
  {
    const c = GS.classifyFailure;
    check('U classify 429 → quota retry', c({ status: 429 }).retry && c({ status: 429 }).kind === 'quota');
    check('U classify 403 rateLimitExceeded → retry', c({ status: 403, reason: 'rateLimitExceeded' }).retry);
    check('U classify 403 per-minute message → retry', c({ status: 403, message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'" }).retry);
    check('U classify 403 insufficientPermissions → no retry', !c({ status: 403, reason: 'insufficientPermissions', message: 'Request had insufficient authentication scopes.' }).retry);
    check('U classify 403 dailyLimitExceeded → no retry', !c({ status: 403, reason: 'dailyLimitExceeded' }).retry);
    check('U classify network → retry', c(null).retry);
    check('U classify 401 → auth', c({ status: 401 }).kind === 'auth');
    const d = [0, 1, 2, 3, 4, 5].map((a) => GS.backoffDelay(a, { random: () => 1 }));
    check('U backoff grows and caps at 16 s', d[0] === 500 && d[4] === 8000 && d[5] === 16000, d);
    check('U backoff honours Retry-After', GS.backoffDelay(0, { retryAfterMs: 3000 }) === 3000);
  }

  out.passed = pass; out.total = pass + fail; out.failed = results.filter((r) => !r.ok);
  out.checks = results.map((r) => ({ name: r.name, ok: r.ok }));
  fs.writeFileSync(path.join(__dirname, 'gmail-sync-sim-report.json'), JSON.stringify(out, null, 2));
  console.log(`\nGmail sync simulation: ${pass}/${pass + fail} checks passed`);
  const s1 = out.scenarios.S1_realistic;
  console.log('Realistic refresh   legacy → engine cold → engine warm');
  for (const k of ['requests', 'quotaUnits', 'quota403', 'peakRequestsPerSecond', 'peakConcurrent', 'messageGets', 'duplicateGets', 'recordsLost', 'durationMs']) console.log(`  ${k.padEnd(22)} ${String(s1.legacy[k]).padStart(6)} ${String(s1.engineCold[k]).padStart(8)} ${String(s1.engineWarm30s[k]).padStart(8)}`);
  if (fail) process.exitCode = 1;
}
function pick(r) { return { ok: r.ok, partial: r.partial, summary: r.summary, requestCount: r.requestCount, units: r.units, retries: r.retries, quotaErrors: r.quotaErrors, records: r.records, uniqueIds: r.uniqueIds, duplicatesAvoided: r.duplicatesAvoided, queryErrors: r.queryErrors, history: r.history, sent: r.sent, durationMs: r.durationMs, failures: (r.failures || []).slice(0, 5) }; }

module.exports = { makeGmail, makeClock, makeMailbox, rng };
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
