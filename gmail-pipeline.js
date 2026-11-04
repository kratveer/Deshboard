// Daylight Gmail cost-optimised pipeline (v2).
// Stage A  discover changes: history.list from a persistent per-account checkpoint (recovery: newer_than:Nd list + reconcile)
// Stage B  metadata only (trimmed headers + fields, HTTP batch ≤ 50) + local rules; unfamiliar senders with money/date/booking
//          patterns are escalated, never discarded
// Stage C  selective full bodies (persistent queue) → schema.org → regex → Daylight's existing classifiers (derive) → AI only if needed
// Pure orchestration: every network call goes through the Phase 1 engine (budget, concurrency, backoff, accounting),
// storage through DaylightMailCache, rules through DaylightGmailRules. No DOM — the same code can run in a Worker.
(function (root) {
  'use strict';
  const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const GP = '/gmail/v1/users/me';
  const DAY = 86400000;

  const FIN_MAP = { unpaid_bill: 'bill', financial_statement: 'document', paid_invoice: 'payment', payment_successful: 'payment', payment_pending: 'payment', payment_failed: 'payment', outgoing_payment: 'payment', incoming_money: 'payment', bank_transaction: 'payment', refund_received: 'refund', refund_pending: 'refund', subscription_renewal: 'subscription', purchase_receipt: 'receipt', promotional_offer: 'promotion' };
  const CLS_MAP = { ticket: 'travel', bill: 'bill', payment: 'payment', subscription: 'subscription', shopping: 'receipt' };
  /** Map Daylight's existing classifiers (finance-intel / email-classify) onto pipeline categories. */
  function mapDerived(d) {
    if (!d) return null;
    if (d.fin && FIN_MAP[d.fin.category] && (d.fin.confidence ?? 0) >= 0.6) return { source: 'fin', category: FIN_MAP[d.fin.category], confidence: Math.min(0.95, d.fin.confidence), reason: 'finance-intel: ' + d.fin.category };
    if (d.cls && CLS_MAP[d.cls.category] && (d.cls.confidence ?? 0) >= 0.62 && !d.cls.needsReview) return { source: 'cls', category: CLS_MAP[d.cls.category], confidence: Math.min(0.92, d.cls.confidence), reason: 'email-classify: ' + d.cls.category };
    return null;
  }

  const PL_CLS = CLS_MAP;
  /** Gmail search fragment that leaves out the excluded categories (e.g. "-category:promotions -category:social"). */
  function excludeQuery(labels) { return (labels || []).map((l) => '-category:' + String(l).replace(/^CATEGORY_/, '').toLowerCase()).join(' '); }
  function createMailPipeline(o) {
    const engine = o.engine, cache = o.cache, R = o.rules, cfgAll = o.config, cfg = cfgAll.pipeline, win = cfgAll.window;
    const now = o.now || (() => Date.now());
    const B = o.batch; // DaylightGmailBatch
    let batchSend = o.batchSend || null;
    let batchFailures = 0;
    const derive = typeof o.derive === 'function' ? o.derive : null;
    const session = new Map(); // messageId → full message fetched in THIS session (memory only; never persisted)
    const EXCL = new Set(cfg.excludeLabels || []);
    const EXQ = excludeQuery(cfg.excludeLabels);
    const isExcluded = (labels) => (labels || []).some((l) => EXCL.has(l));

    const metaPath = (id) => `${GP}/messages/${encodeURIComponent(id)}?format=metadata&${cfg.metadataHeaders.map((h) => 'metadataHeaders=' + encodeURIComponent(h)).join('&')}&fields=${encodeURIComponent('id,threadId,labelIds,snippet,internalDate,historyId,payload/mimeType,payload/headers')}`;
    const fullPath = (id) => `${GP}/messages/${encodeURIComponent(id)}?format=full&fields=${encodeURIComponent(o.fullFields || (root.DaylightGmailSync && root.DaylightGmailSync.FULL_FIELDS) || 'id,threadId,labelIds,snippet,internalDate,historyId,payload')}`;
    const threadPath = (id) => `${GP}/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
    const abs = (path) => 'https://gmail.googleapis.com' + path;

    /** Fetch many GETs: HTTP batch (≤ batchSize) with single-request fallback. Returns Map(id → {ok, data, deleted, kind, ...}). */
    async function fetchMany(ctx, items, unit, kindName, C) {
      const out = new Map();
      if (!items.length) return out;
      const singles = [];
      const useBatch = cfg.useBatch && batchSend && B && batchFailures < cfg.batchFallbackAfterFailures && !ctx.fatal;
      if (useBatch) {
        // keep one batch well inside the per-minute quota so it never has to wait for the whole window
        const lim = (engine.config && engine.config.limitPerMinute) || 4800;
        const size = Math.max(1, Math.min(cfg.batchSize, Math.floor((lim * 0.25) / unit)));
        for (let i = 0; i < items.length; i += size) {
          const chunk = items.slice(i, i + size);
          const batch = B.buildBatch(chunk.map((x) => ({ id: x.id, path: x.path })));
          // one attempt: a transport failure (e.g. CORS) falls back to single GETs instead of burning quota on retries
          const r = await engine.call(ctx, 'batch', B.BATCH_URL, unit * chunk.length, { send: () => batchSend(batch), maxAttempts: 1, refundOnFailure: true });
          C.req_batch = (C.req_batch || 0) + 1;
          if (!r.ok || !(r.data instanceof Map)) {
            if (r.kind === 'auth' || r.kind === 'daily') { chunk.forEach((x) => out.set(x.id, { ok: false, kind: r.kind, status: r.status })); continue; }
            if (r.deferred || r.kind === 'budget' || r.skipped) { chunk.forEach((x) => out.set(x.id, { ok: false, deferred: true, kind: 'budget' })); continue; } // quota: try next sync, not a transport failure
            batchFailures++; C.batchFallback = (C.batchFallback || 0) + 1; singles.push(...chunk); continue;
          }
          C.batchedParts = (C.batchedParts || 0) + chunk.length;
          C['req_' + kindName] = (C['req_' + kindName] || 0) + chunk.length;
          for (const x of chunk) {
            const p = r.data.get(String(x.id));
            if (p && p.ok && p.data) out.set(x.id, { ok: true, data: p.data });
            else if (p && (p.status === 404 || p.status === 410)) out.set(x.id, { ok: false, deleted: true, status: p.status });
            else { // per-part quota / server error / missing part: refund and retry with the single-request backoff path
              singles.push(x);
              if (p && (p.status === 429 || p.status === 403)) { ctx.quotaErrors = (ctx.quotaErrors || 0) + 1; }
            }
          }
          // The engine charged the whole chunk; parts that will be retried singly are charged again there (Google
          // charges failed parts too, so this is the honest upper bound).
        }
      } else singles.push(...items);
      await Promise.all(singles.map(async (x) => {
        const r = await engine.call(ctx, kindName === 'getFull' ? 'messages.get(full)' : kindName === 'threadsGet' ? 'threads.get' : 'messages.get(metadata)', abs(x.path), unit);
        C['req_' + kindName] = (C['req_' + kindName] || 0) + 1;
        if (r.ok && r.data) out.set(x.id, { ok: true, data: r.data });
        else if (r.kind === 'notFound') out.set(x.id, { ok: false, deleted: true, status: r.status });
        else out.set(x.id, { ok: false, kind: r.kind, status: r.status, deferred: !!r.deferred, message: r.message });
      }));
      return out;
    }

    async function listAll(ctx, params, max, C) {
      const ids = []; let pageToken = '', pages = 0, error = null;
      do {
        const n = Math.min(win.listPageSize, max - ids.length);
        const r = await engine.call(ctx, 'messages.list', `${G}/messages?${params}&maxResults=${n}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, 5);
        C.req_list = (C.req_list || 0) + 1;
        if (!r.ok) { error = { kind: r.kind, status: r.status, message: r.message }; break; }
        (r.data?.messages || []).forEach((m) => ids.push(m));
        pageToken = r.data?.nextPageToken || ''; pages++;
      } while (pageToken && ids.length < max && pages < 20);
      return { ids, error, complete: !pageToken };
    }

    async function readHistory(ctx, startId, C) {
      const added = new Map(), deleted = new Set(), labels = new Map();
      let pageToken = '', pages = 0;
      do {
        const r = await engine.call(ctx, 'history.list', `${G}/history?startHistoryId=${encodeURIComponent(startId)}&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved&maxResults=500${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, 2);
        C.req_history = (C.req_history || 0) + 1;
        if (!r.ok) return { ok: false, expired: r.kind === 'notFound' || r.status === 404, error: { kind: r.kind, status: r.status } };
        for (const h of r.data?.history || []) {
          (h.messagesAdded || []).forEach((x) => { const m = x.message; if (m?.id) { added.set(m.id, m); deleted.delete(m.id); } });
          (h.messagesDeleted || []).forEach((x) => { const id = x.message?.id; if (id) { deleted.add(id); added.delete(id); labels.delete(id); } });
          [...(h.labelsAdded || []), ...(h.labelsRemoved || [])].forEach((x) => { const m = x.message; if (m?.id && m.labelIds) labels.set(m.id, m.labelIds); });
        }
        pageToken = r.data?.nextPageToken || ''; pages++;
      } while (pageToken && pages < cfg.historyMaxPages);
      if (pageToken) return { ok: false, overflow: true, error: { kind: 'overflow' } };
      return { ok: true, added, deleted, labels, pages };
    }

    const hdr = (m, n) => R.header(m, n);
    let C_last = {};
    const MD = () => o.dates || root.DaylightMailDates || null;
    const BULK_CATS = new Set(['promotion', 'newsletter', 'social', 'security']);
    /** Deadlines, reminders, travel and event dates written in the mail (never for bulk / marketing mail). */
    function keyDatesFor(text, subject, receivedMs, category, listUnsub) {
      const D = MD();
      if (!D || BULK_CATS.has(category) || listUnsub) return [];
      try { return D.extract(text, { subject, receivedMs }); } catch { return []; }
    }
    function recordFromMeta(meta, b, prev) {
      const from = hdr(meta, 'From');
      const lu = !!hdr(meta, 'List-Unsubscribe');
      const kd = keyDatesFor(meta.snippet || '', hdr(meta, 'Subject'), Number(meta.internalDate) || now(), b.category, lu);
      // a person's or service's mail that names a deadline / appointment / trip is read in full so the date is confirmed
      if (kd.length && !b.needBody) { b = Object.assign({}, b, { needBody: true }); C_last.keyDateEscalations = (C_last.keyDateEscalations || 0) + 1; }
      return {
        keyDates: kd,
        messageId: meta.id, threadId: meta.threadId, historyId: meta.historyId || null, labels: meta.labelIds || [], internalDate: Number(meta.internalDate) || 0,
        from, to: hdr(meta, 'To'), subject: hdr(meta, 'Subject'), date: hdr(meta, 'Date'), snippet: meta.snippet || '', listUnsubscribe: !!hdr(meta, 'List-Unsubscribe'),
        fromDomain: R.baseDomain(R.senderDomain(from)),
        category: b.category, confidence: +b.confidence.toFixed(3), ruleStage: b.stage, ruleReason: b.reason, escalated: !!b.escalated,
        trace: (b.trace || []).slice(-4).map((t) => t.reason || t.rule),
        status: b.needBody ? 'body-queued' : 'classified', bodyFetched: false, bodyHash: prev?.bodyHash || null, aiHash: prev?.aiHash || null,
        firstSeenAt: prev?.firstSeenAt || now(), lastProcessedAt: now()
      };
    }
    function toMsg(rec, facts) {
      const full = session.get(rec.messageId);
      const headers = [['From', rec.from], ['To', rec.to], ['Subject', rec.subject], ['Date', rec.date]].filter((x) => x[1]).map(([name, value]) => ({ name, value }));
      if (rec.listUnsubscribe) headers.push({ name: 'List-Unsubscribe', value: '<cached>' });
      const base = full ? Object.assign({}, full, { labelIds: rec.labels }) : { id: rec.messageId, threadId: rec.threadId, labelIds: rec.labels, snippet: rec.snippet, internalDate: String(rec.internalDate), historyId: rec.historyId, payload: { mimeType: 'text/plain', headers } };
      base._cache = { category: rec.category, confidence: rec.confidence, stage: rec.ruleStage, reason: rec.ruleReason, status: rec.status, bodyFetched: rec.bodyFetched };
      if (facts?.derived) base._derived = facts.derived;
      if (rec.keyDates && rec.keyDates.length) base._keyDates = rec.keyDates;
      if (!full && rec.bodyFetched) base._bodyFromCache = true; // body processed earlier; derived results stand in for it
      return base;
    }

    async function buildPools(acct) {
      const live = (await cache.all(acct)).filter((r) => r.status !== 'deleted' && r.status !== 'meta-pending' && !isExcluded(r.labels)).sort((a, b) => b.internalDate - a.internalDate);
      const facts = await cache.getFacts(acct, live.map((r) => r.messageId));
      const msgOf = (r) => toMsg(r, facts.get(r.messageId));
      const inbox = live.filter((r) => (r.labels || []).includes('INBOX')).slice(0, win.inboxPoolMax).map(msgOf);
      const pick = (cats) => live.filter((r) => cats.includes(r.category)).slice(0, win.categoryPoolMax).map(msgOf);
      const pools = { inbox, moneyA: pick(['bill', 'payment', 'refund', 'subscription', 'receipt']), travel: pick(['travel', 'food']), docs: pick(['document']) };
      return { pools, review: live.filter((r) => r.status === 'review'), live };
    }
    /** No network: what the app shows when a sync is skipped (recent sync, another tab syncing, offline). */
    async function fromCache(acct, why) {
      const { pools, review, live } = await buildPools(acct);
      const cp = (await cache.getCheckpoint(acct)) || {};
      const threads = (await cache.allThreads(acct)).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, cfg.sentThreads).map((t) => t.thread);
      const report = { engine: 'optimised', ok: true, partial: false, fromCache: true, skipReason: why || '', durationMs: 0, cold: false, requests: {}, requestCount: 0, units: 0, retries: 0, quotaErrors: 0, listedTotal: 0, uniqueIds: live.length, duplicatesAvoided: 0,
        records: { fetched: 0, cached: live.length, stale: 0, failed: 0, deferred: 0, deleted: 0, bodyDeferred: live.filter((r) => r.status === 'body-queued').length, bodyFetched: 0 },
        sent: { checked: threads.length, fetched: 0, cached: threads.length, failed: 0, error: null }, queries: [], queryErrors: [], history: { mode: 'cache-only' }, cursor: cp.historyId || null, failures: [],
        pipeline: { mode: 'cache-only', newMessages: 0, review: review.length, counters: {} }, summary: `Gmail · showing saved mail (${why || 'synced recently'})` };
      return { report, pools, historyExtras: [], threads, cursor: cp.historyId || null, review, aiCandidates: [], deletedIds: [] };
    }

    /**
     * run({ accountId, label, aiEnabled, allowFinancial, olderScan })
     * Returns { report, pools, historyExtras, threads, cursor, review, aiCandidates }.
     */
    async function run(opts) {
      const acct = opts.accountId || 'default';
      const t0 = now();
      const ctx = engine.newCtx('pipeline');
      const C = { syncs: 1, ['sync_' + (opts.label || 'manual')]: 1 };
      C_last = C;
      const cp = (await cache.getCheckpoint(acct)) || null;
      const cold = !cp || !cp.backfilledAt;
      const failures = [];
      const fail = (id, r, why) => { if (failures.length < 60) failures.push({ id, why, kind: r?.kind || '', status: r?.status || 0 }); };

      // ---- Stage A: discover ----
      const prof = await engine.call(ctx, 'profile', `${G}/profile`, 1); C.req_profile = 1;
      const startHid = prof.ok ? String(prof.data?.historyId || '') : '';
      let mode = cold ? 'backfill' : (!startHid ? 'profile-failed' : (cp.historyId === startHid ? 'unchanged' : 'incremental'));
      const discovered = new Map(); // id → {id, threadId, labelIds?}
      let deletedIds = new Set(), labelUpdates = new Map(), listError = null, historyInfo = { mode };
      if (mode === 'incremental') {
        const h = await readHistory(ctx, cp.historyId, C);
        if (h.ok) { h.added.forEach((m, id) => { if (isExcluded(m.labelIds)) { C.excludedByCategory = (C.excludedByCategory || 0) + 1; return; } discovered.set(id, m); }); deletedIds = h.deleted; labelUpdates = h.labels; historyInfo = { mode, ok: true, added: h.added.size, deleted: h.deleted.size, labelChanges: h.labels.size, pages: h.pages }; }
        else { mode = h.expired ? 'expired-recovery' : (h.overflow ? 'overflow-recovery' : 'error-recovery'); historyInfo = { mode, ok: false, error: h.error }; }
      }
      const windowDays = (opts.windowDays || win.backfillDays);
      const recovering = mode === 'backfill' || /recovery$/.test(mode);
      let cachedMap = null;
      if (recovering && !ctx.fatal) {
        const q = 'q=' + encodeURIComponent(`newer_than:${windowDays}d -in:chats ${EXQ}`.trim());
        const l = await listAll(ctx, q, win.backfillMax, C);
        listError = l.error;
        const all = await cache.all(acct);
        cachedMap = new Map(all.map((r) => [r.messageId, r]));
        l.ids.forEach((m) => { const c = cachedMap.get(m.id); if (!c || c.status === 'deleted') discovered.set(m.id, m); });
        if (!l.error && mode !== 'backfill') {
          // reconcile cached rows: INBOX / UNREAD membership from two cheap ID lists, deletions from absence
          const listed = new Set(l.ids.map((m) => m.id));
          const inbox = await listAll(ctx, 'labelIds=INBOX&' + q, win.backfillMax, C);
          const unread = await listAll(ctx, 'labelIds=UNREAD&' + q, win.backfillMax, C);
          const inSet = new Set(inbox.ids.map((m) => m.id)), unSet = new Set(unread.ids.map((m) => m.id));
          const cutoff = now() - windowDays * DAY;
          all.forEach((r) => {
            if (r.status === 'deleted' || isExcluded(r.labels)) return; // excluded categories are not listed, so absence ≠ deletion
            if (listed.has(r.messageId)) {
              if (inbox.error || unread.error) return;
              let labels = (r.labels || []).filter((x) => x !== 'INBOX' && x !== 'UNREAD');
              if (inSet.has(r.messageId)) labels.push('INBOX');
              if (unSet.has(r.messageId)) labels.push('UNREAD');
              if (labels.slice().sort().join() !== (r.labels || []).slice().sort().join()) labelUpdates.set(r.messageId, labels);
            } else if (r.internalDate >= cutoff + DAY) deletedIds.add(r.messageId); // inside the window but gone → trashed/deleted
          });
        }
        historyInfo = Object.assign({}, historyInfo, { mode, listed: l.ids.length, complete: l.complete });
      }
      if (opts.olderScan && !ctx.fatal) {
        const q = 'q=' + encodeURIComponent(`newer_than:${win.olderScanDays}d older_than:${windowDays}d ${cfg.searches.money} ${EXQ}`.trim());
        const l = await listAll(ctx, q, win.olderScanMax, C);
        const cur = await cache.getMany(acct, l.ids.map((m) => m.id));
        l.ids.forEach((m) => { if (!cur.has(m.id)) discovered.set(m.id, m); });
        historyInfo.olderScan = l.ids.length;
      }

      // drop drafts / chats; split discovered into new vs already-cached (label updates only)
      // messages whose metadata could not be fetched last time (quota / network) are retried first — never lost
      const pendingRows = (await cache.all(acct)).filter((r) => r.status === 'meta-pending');
      pendingRows.forEach((r) => { if (!discovered.has(r.messageId) && !deletedIds.has(r.messageId)) discovered.set(r.messageId, { id: r.messageId, threadId: r.threadId, labelIds: r.labels && r.labels.length ? r.labels : undefined, _pending: true }); });
      const existing = await cache.getMany(acct, [...discovered.keys()]);
      const newIds = [];
      discovered.forEach((m, id) => {
        if ((m.labelIds || []).some((l) => l === 'DRAFT' || l === 'CHAT')) return;
        if (isExcluded(m.labelIds) && !(existing.get(id) && existing.get(id).status !== 'meta-pending')) { C.excludedByCategory = (C.excludedByCategory || 0) + 1; return; }
        const c = existing.get(id);
        if (c && c.status !== 'deleted' && c.status !== 'meta-pending') { if (m.labelIds) labelUpdates.set(id, m.labelIds); C.cachedUnchanged = (C.cachedUnchanged || 0) + 1; }
        else newIds.push(id);
      });
      deletedIds.forEach((id) => labelUpdates.delete(id));
      const labelOnly = await cache.updateLabels(acct, [...labelUpdates].map(([id, labels]) => ({ id, labels })));
      C.labelOnly = labelOnly;
      const deletedNow = await cache.markDeleted(acct, [...deletedIds]);
      C.deleted = deletedNow.length;

      // mailbox searches (IDs only, body-matching) — the recall net for bills / travel / documents
      const hints = new Map();
      if (newIds.length && !ctx.fatal) {
        const since = cold || recovering ? windowDays : Math.min(windowDays, Math.max(1, Math.ceil((now() - (cp.lastSyncAt || 0)) / DAY) + 1));
        const want = new Set(newIds);
        for (const [k, query] of Object.entries(cfg.searches)) {
          const l = await listAll(ctx, 'q=' + encodeURIComponent(`newer_than:${since}d ${query} ${EXQ}`.trim()), win.backfillMax, C);
          l.ids.forEach((m) => { if (!want.has(m.id)) return; const s = hints.get(m.id) || new Set(); s.add(cfg.searchHintCategory[k] || k); hints.set(m.id, s); });
        }
      }

      // ---- Stage B: metadata + rules ----
      const metas = await fetchMany(ctx, newIds.map((id) => ({ id, path: metaPath(id) })), 20, 'getMeta', C);
      const newRecs = [];
      let fetched = 0, failed = 0, deferred = 0;
      for (const id of newIds) {
        const r = metas.get(id);
        if (!r || !r.ok) {
          if (r?.deleted) { C.deleted = (C.deleted || 0) + 1; if (existing.get(id)) newRecs.push(Object.assign(existing.get(id), { status: 'deleted', deletedAt: now() })); continue; }
          if (r?.deferred || r?.kind === 'budget') { deferred++; fail(id, r, 'deferred'); } else { failed++; fail(id, r, 'failed'); }
          // keep a stub so the next sync retries it, even though the history checkpoint moves on
          const d0 = discovered.get(id) || {};
          newRecs.push(Object.assign({}, existing.get(id) || {}, { messageId: id, threadId: d0.threadId || existing.get(id)?.threadId || null, labels: d0.labelIds || existing.get(id)?.labels || [], status: 'meta-pending', internalDate: existing.get(id)?.internalDate || now(), lastError: r?.kind || 'unknown', lastProcessedAt: now() }));
          continue;
        }
        fetched++;
        const meta = r.data;
        const from = hdr(meta, 'From');
        const dom = R.baseDomain(R.senderDomain(from));
        C.domainLookups = (C.domainLookups || 0) + 1;
        const dc = await cache.getDomainCategory(acct, dom);
        if (dc || R.SEED_DOMAINS[dom]) C.domainHits = (C.domainHits || 0) + 1;
        const b = R.stageB(meta, { domainCategory: dc, searchHits: hints.get(id), cfg });
        C['stage_' + b.stage] = (C['stage_' + b.stage] || 0) + 1;
        if (b.escalated) C.escalated = (C.escalated || 0) + 1;
        if (!b.needBody) C.noBodyNeeded = (C.noBodyNeeded || 0) + 1; else C.bodyQueued = (C.bodyQueued || 0) + 1;
        newRecs.push(recordFromMeta(meta, b, existing.get(id)));
      }
      await cache.putMany(acct, newRecs);

      // ---- Stage C: bodies from the persistent queue (this sync's + earlier backlog) ----
      const all = await cache.all(acct);
      const prio = (r) => (r.escalated ? 1 : 0) + ({ bill: 3, travel: 3, refund: 3, payment: 2, food: 2, subscription: 2, document: 2, receipt: 1 }[r.category] || 0);
      // AI-deferred items need their body again; only re-read as many as AI may actually process this sync
      // AI credit bucket: every new email adds `maxShareOfNewMail` (5 %) of a call; a call spends 1. This keeps AI
      // below 5 % of new mail over time, including the backfill and anything deferred earlier.
      const share = cfgAll.ai?.maxShareOfNewMail ?? 0.05;
      const aiCredits = Math.min(cfgAll.ai?.maxCredits ?? 25, (cp?.aiCredits || 0) + newIds.length * share);
      const aiSlots = opts.aiEnabled ? Math.max(0, Math.floor(aiCredits) - 0) : 0;
      const aiQueued = all.filter((r) => r.aiPending && r.status !== 'deleted' && r.status !== 'body-queued').sort((a, b) => b.internalDate - a.internalDate).slice(0, aiSlots);
      const queue = [...all.filter((r) => r.status === 'body-queued' && !isExcluded(r.labels)).sort((a, b) => prio(b) - prio(a) || b.internalDate - a.internalDate), ...aiQueued];
      const take = queue.slice(0, cfg.maxFullPerSync);
      const takenBodies = take.filter((r) => r.status === 'body-queued').length;
      const bodies = await fetchMany(ctx, take.map((r) => ({ id: r.messageId, path: fullPath(r.messageId) })), 60, 'getFull', C);
      const doneRecs = [], factsOut = [], attsOut = [], aiCandidates = [], review = [];
      let bodyFetched = 0;
      for (const rec of take) {
        const r = bodies.get(rec.messageId);
        if (!r || !r.ok) { if (r?.deleted) { rec.status = 'deleted'; rec.deletedAt = now(); doneRecs.push(rec); } else fail(rec.messageId, r, 'body-deferred'); continue; }
        bodyFetched++;
        const full = r.data;
        session.set(rec.messageId, full);
        const c = R.stageC(full, { category: rec.category, confidence: rec.confidence, reason: rec.ruleReason, escalated: rec.escalated }, cfg);
        let derived = null;
        if (derive) { try { derived = derive(full); } catch { derived = null; } }
        const d = mapDerived(derived);
        let category = c.category, confidence = c.confidence, reason = c.reason;
        const structuredWins = c.source !== 'rules' && c.complete;
        // Combine with Daylight's existing classifiers. finance-intel (Phase 2) decides between the money categories;
        // neither classifier knows food / refund-vs-receipt / travel as well as the rules, so a confident rule result stands.
        const MONEY = ['bill', 'payment', 'subscription', 'receipt', 'refund'];
        const ruleSpecific = ['refund', 'food', 'travel', 'document'].includes(category) && confidence >= 0.75;
        const clsAgrees = derived?.cls && PL_CLS[derived.cls.category] === category;
        const finDecides = d && d.source === 'fin' && (MONEY.includes(d.category) || (d.category === 'document' && ['bill', 'payment'].includes(category))) && MONEY.includes(category) && !clsAgrees && !(category === 'refund' && confidence >= 0.75 && d.category !== 'refund');
        const promoByFin = derived?.fin?.category === 'promotional_offer' && (derived.fin.confidence || 0) >= 0.85 && !structuredWins && !c.facts.reference && ['travel', 'food', 'receipt', 'subscription', 'payment'].includes(category);
        if (promoByFin) { category = 'promotion'; confidence = Math.min(0.92, derived.fin.confidence); reason = 'finance-intel: promotional offer'; }
        else if (d && !structuredWins && (finDecides || (!ruleSpecific && (confidence < 0.75 || !R.HIGH_VALUE.has(category))))) { category = d.category; confidence = Math.max(d.confidence, Math.min(confidence, 0.9)); reason = d.reason; }
        else if (derived?.fin?.category === 'not_financial' && ['bill', 'payment'].includes(category) && !structuredWins && confidence < 0.75 && !(derived?.cls && PL_CLS[derived.cls.category] === category)) {
          // finance-intel (Phase 2) found no money evidence in the body → do not call it financial
          category = c.facts.reference ? 'receipt' : 'other'; confidence = 0.6; reason = 'body checked: no financial evidence';
        }
        rec.category = category; rec.confidence = +confidence.toFixed(3); rec.ruleReason = reason; rec.ruleStage = rec.ruleStage + '+body';
        rec.bodyFetched = true; rec.bodyHash = c.bodyHash; rec.lastProcessedAt = now();
        // key dates from the full text + structured booking data (schema.org)
        {
          const kd = keyDatesFor(c.cleanText || '', rec.subject, rec.internalDate, category, rec.listUnsubscribe);
          const f = c.facts || {}, st = f.departureTime || f.checkinTime || f.startTime || f.startDate || f.pickupTime;
          if (st && !isNaN(Date.parse(st))) {
            const d = new Date(st), pad = (n) => String(n).padStart(2, '0');
            const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, tm = /T\d\d:\d\d/.test(st) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null;
            const k = f.schemaType === 'FoodEstablishmentReservation' ? 'reminder' : 'travel';
            const rest = kd.filter((x) => x.date !== iso);
            kd.length = 0; kd.push({ kind: k, date: iso, time: tm, quote: [f.schemaType, f.reservationNumber || f.orderNumber, f.from && f.to ? f.from + ' → ' + f.to : f.place].filter(Boolean).join(' · '), source: 'schema.org', yearWritten: true }, ...rest);
          }
          rec.keyDates = kd.length ? kd : (rec.keyDates || []);
        }
        const [lo, hi] = cfg.reviewBand;
        if (rec.userCategory) { category = rec.userCategory; confidence = 0.99; rec.category = category; rec.confidence = 0.99; rec.ruleReason = 'your choice'; }
        rec.status = rec.userCategory ? 'done' : (confidence >= lo && confidence < hi && R.HIGH_VALUE.has(category) ? 'review' : 'done');
        if (rec.status === 'review') review.push(rec);
        factsOut.push({ messageId: rec.messageId, kind: category, fields: c.facts, structured: c.structured.map((s) => ({ type: s.type, source: s.source })), source: c.source, missing: c.missing, bodyHash: c.bodyHash, derived, at: now() });
        c.attachments.forEach((a) => attsOut.push({ messageId: rec.messageId, attachmentId: a.attachmentId, name: a.name, mimeType: a.mimeType, size: a.size, sha256: null, downloaded: false, category }));
        aiCandidates.push({ aiRetry: !!rec.aiPending, messageId: rec.messageId, threadId: rec.threadId, category, confidence, missing: c.missing, complete: c.complete, escalated: rec.escalated, highValue: R.HIGH_VALUE.has(category), bodyHash: c.bodyHash, prevAiHash: rec.aiHash, financial: ['bill', 'payment', 'refund', 'subscription'].includes(category), fromDomain: rec.fromDomain, text: c.cleanText });
        doneRecs.push(rec);
      }
      await cache.putMany(acct, doneRecs);
      await cache.putFacts(acct, factsOut);
      await cache.putAttachments(acct, attsOut);
      const bodyBacklog = Math.max(0, all.filter((r) => r.status === 'body-queued').length - takenBodies);
      const aiBacklog = (await cache.all(acct)).filter((r) => r.aiPending).length;

      // ---- sent threads (reply loops): only when the mailbox changed or nothing is cached ----
      let threads = [], sent = { checked: 0, fetched: 0, cached: 0, failed: 0, error: null };
      const cachedThreads = await cache.allThreads(acct);
      if (cfg.sentThreads && !ctx.fatal && (mode !== 'unchanged' || !cachedThreads.length)) {
        const r = await engine.call(ctx, 'threads.list', `${G}/threads?labelIds=SENT&maxResults=${cfg.sentThreads}`, 10); C.req_threadsList = 1;
        if (r.ok) {
          const list = r.data?.threads || [];
          const have = await cache.getThreads(acct, list.map((t) => t.id));
          const need = list.filter((t) => { const c = have.get(t.id); return !(c && c.historyId === t.historyId); });
          const got = await fetchMany(ctx, need.map((t) => ({ id: t.id, path: threadPath(t.id) })), 40, 'threadsGet', C);
          const put = [];
          list.forEach((t) => {
            const g = got.get(t.id), c = have.get(t.id);
            if (g?.ok) { put.push({ threadId: t.id, historyId: t.historyId || g.data.historyId, thread: g.data, at: now() }); threads.push(g.data); sent.fetched++; }
            else if (c) { threads.push(c.thread); sent.cached++; if (g) sent.failed++; }
          });
          await cache.putThreads(acct, put);
          sent.checked = list.length;
        } else { sent.error = { kind: r.kind, status: r.status }; threads = cachedThreads.map((t) => t.thread); }
      } else { threads = cachedThreads.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, cfg.sentThreads).map((t) => t.thread); sent.cached = threads.length; sent.checked = threads.length; }

      // ---- checkpoint ----
      const discoveryOk = !ctx.fatal && !!startHid && !listError && (mode !== 'profile-failed');
      const cursor = discoveryOk ? startHid : (cp?.historyId || null);
      await cache.setCheckpoint(acct, { aiCredits, historyId: cursor, backfilledAt: cp?.backfilledAt || (discoveryOk ? now() : null), windowDays, lastSyncAt: discoveryOk ? now() : (cp?.lastSyncAt || 0), lastLabel: opts.label || 'manual', lastMode: mode });

      // ---- pools for the app (from the cache, so every open is warm) ----
      const { pools, review: reviewAll, live } = await buildPools(acct);

      const records = { fetched, cached: (C.cachedUnchanged || 0), stale: 0, failed, deferred, deleted: C.deleted || 0, bodyDeferred: bodyBacklog, bodyFetched };
      const partial = Boolean(ctx.fatal || failed || deferred || listError || !prof.ok || sent.error);
      const report = {
        engine: 'optimised', ok: !partial, partial, fatal: ctx.fatal, durationMs: now() - t0, cold,
        requests: ctx.requests, requestCount: Object.values(ctx.requests).reduce((a, b) => a + b, 0), units: ctx.units, retries: ctx.retries, quotaErrors: ctx.quotaErrors,
        listedTotal: discovered.size, uniqueIds: live.length, duplicatesAvoided: C.cachedUnchanged || 0,
        records, sent, queries: [], queryErrors: listError ? [{ key: 'window', ...listError }] : [], history: historyInfo, cursor, failures,
        pipeline: { mode, newMessages: newIds.length, labelOnly, deleted: deletedNow.length, review: reviewAll.length, bodyBacklog, aiBacklog, metaPending: newRecs.filter((r) => r.status === 'meta-pending').length, counters: C },
        summary: ''
      };
      report.summary = ctx.fatal ? `Gmail sync stopped: ${ctx.fatal.kind === 'auth' ? 'Google sign-in expired' : ctx.fatal.kind}`
        : partial ? `Gmail partly synced · ${[failed && failed + ' failed', deferred && deferred + ' waiting for quota', listError && 'mail list failed', sent.error && 'sent mail check incomplete'].filter(Boolean).join(', ') || 'incomplete'}`
        : `Gmail synced · ${newIds.length ? newIds.length + ' new' : 'no new mail'}${labelOnly ? `, ${labelOnly} label update${labelOnly > 1 ? 's' : ''}` : ''}${bodyBacklog ? `, ${bodyBacklog} full texts queued` : ''}`;
      C.units = ctx.units; C.failed = failed; C.deferred = deferred;
      await cache.addMetrics(acct, { counters: C, run: { at: t0, label: opts.label || 'manual', cold, ms: report.durationMs, units: ctx.units, newCount: newIds.length, mode } });
      return { report, pools, historyExtras: [], threads, cursor, review: reviewAll, aiCandidates, deletedIds: deletedNow };
    }

    /**
     * Run AI for this sync's candidates within the share target and the daily cap; the rest is queued (never dropped).
     * analyse(candidate) → { ok, value:{category, confidence, fields}, usage:{inputTokens, outputTokens, model}, invalidJson, retried }
     */
    async function runAi(o2) {
      const { accountId: acct, candidates, budget, analyse, newCount } = o2;
      const out = { sent: 0, skipped: 0, deferred: 0, usd: 0, results: [] };
      const want = [], clearIds = [];
      for (const c of candidates || []) {
        const w = budget.wants(Object.assign({ aiEnabled: o2.aiEnabled, allowFinancial: o2.allowFinancial, high: cfg.highConfidence }, c));
        if (w.send) want.push(Object.assign({ why: w.reason }, c)); else { out.skipped++; if (c.aiRetry) clearIds.push(c.messageId); }
      }
      if (clearIds.length) { const rs = await cache.getMany(acct, clearIds); const u = []; rs.forEach((r) => { r.aiPending = false; u.push(r); }); await cache.putMany(acct, u); }
      // spend from the persistent credit bucket (≤ 5 % of new mail over time); oldest deferred items go first
      const cp2 = (await cache.getCheckpoint(acct)) || {};
      let credits = cp2.aiCredits || 0;
      const cap = Math.floor(credits);
      want.sort((a, b) => (b.aiRetry ? 1 : 0) - (a.aiRetry ? 1 : 0));
      const recs = await cache.getMany(acct, want.map((c) => c.messageId));
      const upd = [];
      for (let i = 0; i < want.length; i++) {
        const c = want[i], rec = recs.get(c.messageId);
        const spend = i < cap ? await budget.canSpend(acct, Math.ceil(String(c.text || '').length / 4) + 150) : { ok: false, reason: 'AI share (5 % of new mail) used up — deferred to a later sync' };
        if (!spend.ok || typeof analyse !== 'function') { out.deferred++; if (rec) { rec.aiPending = true; rec.aiDeferredReason = spend.reason || 'no analyser'; upd.push(rec); } continue; }
        const res = await analyse(c);
        out.sent++; credits -= 1;
        out.usd += await budget.record(acct, { inputTokens: res?.usage?.inputTokens || 0, outputTokens: res?.usage?.outputTokens || 0, model: res?.usage?.model, mode: 'live', invalidJson: !!res?.invalidJson, retried: !!res?.retried });
        if (rec) {
          rec.aiHash = c.bodyHash; rec.aiAt = now();
          if (res?.ok && res.value) {
            rec.aiCategory = res.value.category; rec.aiConfidence = res.value.confidence;
            if (res.value.confidence >= cfg.highConfidence && rec.status !== 'review') { rec.category = res.value.category; rec.confidence = res.value.confidence; rec.ruleReason = 'AI'; }
            await budget.learn(acct, c.fromDomain, res.value.category, res.value.confidence);
          }
          rec.aiPending = false; rec.aiDeferredReason = null;
          upd.push(rec);
        }
        out.results.push({ messageId: c.messageId, ok: !!res?.ok, value: res?.value || null });
      }
      await cache.putMany(acct, upd);
      await cache.setCheckpoint(acct, { aiCredits: Math.max(0, credits) });
      await cache.addMetrics(acct, { counters: { aiDeferred: out.deferred, aiSkipped: out.skipped } });
      return out;
    }

    /** User resolves a review item: updates the message and teaches the domain cache (domain → category only). */
    async function resolveReview(acct, messageId, category) {
      const rec = (await cache.getMany(acct, [messageId])).get(messageId);
      if (!rec) return null;
      rec.category = category; rec.confidence = 0.99; rec.ruleReason = 'your choice'; rec.status = 'done'; rec.userCategory = category;
      await cache.putMany(acct, [rec]);
      if (rec.fromDomain) await cache.recordDomainCategory(acct, rec.fromDomain, category, 'user');
      return rec;
    }

    return { run, runAi, resolveReview, fromCache, buildPools, setBatchSender: (fn) => { batchSend = fn; }, batchDisabled: () => batchFailures >= cfg.batchFallbackAfterFailures, session };
  }

  const api = { createMailPipeline, mapDerived, excludeQuery, FIN_MAP, CLS_MAP };
  root.DaylightMailPipeline = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
