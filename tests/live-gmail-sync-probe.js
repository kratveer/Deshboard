/* Daylight Phase 1 live probe: paste into the browser console on https://kratveer.github.io/Deshboard/privacy.html
   (same origin as Daylight, but the dashboard itself does not run there). Then: await __p1probe("cold"); wait 30 s; await __p1probe("warm").
   Read-only Gmail GETs; returns counts only. */
// Daylight Gmail sync engine (Phase 1 reliability).
// One shared instance per page. Plans every Gmail read so that a refresh:
//  - lists first, de-duplicates message IDs, then fetches each unique message once;
//  - uses format=metadata unless a full body is needed (finance/travel/document mail);
//  - never exceeds a per-minute quota budget and never runs more than N requests at once;
//  - retries quota (429 / 403 rate-limit), 5xx and network errors with jittered exponential backoff;
//  - accounts for every record (fetched / cached / stale / failed / deferred / deleted) and reports
//    partial syncs truthfully instead of dropping failures.
// No DOM access and no storage: the cache lives in memory only, so no new email content is kept at rest.
(function (root) {
  'use strict';

  const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
  // Quota units per call (Gmail API quota table, 2026).
  const COST = Object.freeze({ list: 5, getMetadata: 20, getFull: 60, threadsList: 10, threadGet: 40, history: 2, profile: 1 });
  const META_FIELDS = 'id,threadId,labelIds,snippet,internalDate,sizeEstimate,historyId,payload/headers,payload/mimeType';
  const FULL_FIELDS = 'id,threadId,labelIds,snippet,internalDate,sizeEstimate,historyId,payload/headers,payload/mimeType,payload/filename,payload/body/data,payload/parts(mimeType,filename,body/data,parts(mimeType,filename,body/data,parts(mimeType,filename)))';
  const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED']);

  const DEFAULTS = Object.freeze({
    limitPerMinute: 4800,   // 80% of Gmail's 6,000 units/min/user; leaves room for the detail view and other widgets
    maxBudgetWaitMs: 20000, // wait at most this long for quota before deferring a record
    concurrency: 6,
    maxAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 16000,
    quotaCooldownMs: 15000,
    maxFullPerSync: 30,
    bodyShare: 0.7,         // full bodies may use at most 70% of the per-minute budget; the rest stays for lists, metadata and threads
    historyMaxPages: 10,
    historyExtrasMax: 25,
    maxFailuresReported: 60
  });

  /** Decide whether a failed response is worth retrying, and why it failed. */
  function classifyFailure(res) {
    if (!res) return { kind: 'network', retry: true };
    const s = Number(res.status) || 0;
    const reason = String(res.reason || '');
    const msg = String(res.message || '');
    if (s === 429) return { kind: 'quota', retry: true };
    if (s === 403) {
      if (/dailyLimitExceeded/i.test(reason) || /per day/i.test(msg)) return { kind: 'daily', retry: false };
      if (RATE_REASONS.has(reason) || /rate ?limit|quota exceeded|too many requests|per minute/i.test(msg)) return { kind: 'quota', retry: true };
      return { kind: 'permission', retry: false };
    }
    if (s === 401) return { kind: 'auth', retry: false };
    if (s === 404 || s === 410) return { kind: 'notFound', retry: false };
    if (s === 408 || s >= 500) return { kind: 'server', retry: true };
    if (s === 0) return { kind: 'network', retry: true };
    return { kind: 'client', retry: false };
  }

  /** Jittered exponential backoff; honours Retry-After when the server sends one. */
  function backoffDelay(attempt, opt) {
    const o = opt || {};
    const base = o.baseMs ?? DEFAULTS.baseDelayMs, max = o.maxMs ?? DEFAULTS.maxDelayMs;
    const rnd = (o.random || Math.random)();
    const exp = Math.min(max, base * Math.pow(2, attempt));
    const jittered = exp / 2 + rnd * exp / 2;
    if (o.retryAfterMs != null && isFinite(o.retryAfterMs)) return Math.max(250, Math.min(60000, Number(o.retryAfterMs)));
    return Math.round(jittered);
  }

  /** Sliding 60-second quota ledger shared by every Gmail call on the page. */
  function createBudget(o) {
    const now = o.now, sleep = o.sleep;
    const limit = o.limitPerMinute, maxWait = o.maxWaitMs;
    const ledger = [];
    let cooldownUntil = 0;
    const prune = (t) => { while (ledger.length && ledger[0].t <= t - 60000) ledger.shift(); };
    const used = () => { const t = now(); prune(t); return ledger.reduce((a, x) => a + x.u, 0); };
    async function take(units, maxWaitOverride) {
      const limitWait = maxWaitOverride == null ? maxWait : maxWaitOverride;
      for (;;) {
        const t = now();
        let wait;
        if (cooldownUntil > t) wait = cooldownUntil - t;
        else {
          prune(t);
          let u = ledger.reduce((a, x) => a + x.u, 0);
          if (u + units <= limit) { ledger.push({ t, u: units }); return true; }
          let i = 0;
          while (i < ledger.length && u + units > limit) { u -= ledger[i].u; i++; }
          wait = (ledger[i - 1] ? ledger[i - 1].t : t) + 60000 - t + 5;
        }
        if (wait > limitWait) return false;
        await sleep(wait);
      }
    }
    return {
      take,
      used,
      penalize(ms) { cooldownUntil = Math.max(cooldownUntil, now() + ms); },
      // A request that never reached Google (network drop / timeout) did not spend quota.
      refund(units) { for (let i = ledger.length - 1; i >= 0; i--) { if (ledger[i].u === units) { ledger.splice(i, 1); return true; } } return false; },
      cooldownRemaining() { return Math.max(0, cooldownUntil - now()); }
    };
  }

  function createPool(limit) {
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < limit && queue.length) {
        const job = queue.shift();
        active++;
        Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
      }
    };
    const run = (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
    run.active = () => active;
    return run;
  }

  const hdr = (msg, name) => (msg?.payload?.headers || []).find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || '';

  function createGmailSync(options) {
    const opt = options || {};
    if (typeof opt.request !== 'function') throw new Error('DaylightGmailSync needs a request(url) function');
    const request = opt.request;
    const now = opt.now || (() => Date.now());
    const sleep = opt.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const random = opt.random || Math.random;
    const cfg = Object.assign({}, DEFAULTS, opt.config || {});
    let budget = createBudget({ limitPerMinute: cfg.limitPerMinute, maxWaitMs: cfg.maxBudgetWaitMs, now, sleep });
    let pool = createPool(cfg.concurrency);
    let cache = new Map();       // messageId -> { msg, format, stale, at }
    let threadCache = new Map(); // threadId -> { historyId, thread }
    const inflight = new Map();  // `${id}|${format}` -> Promise
    let epoch = 0;               // bumps on reset so late responses from an old account are ignored

    const newCtx = (label) => ({ label, requests: {}, units: 0, retries: 0, attempts: 0, quotaErrors: 0, fatal: null, startedAt: now() });

    /** One Gmail GET with budget, concurrency limit and retry. Never throws. */
    function call(ctx, kind, url, cost, callOpt) {
      const optional = !!(callOpt && callOpt.optional);
      return pool(async () => {
        let last = null, downgraded = false;
        // Optional body: if quota is getting tight, fetch metadata instead so the record still arrives.
        const dg = callOpt && callOpt.downgrade;
        if (dg && budget.used() + cost > cfg.limitPerMinute * cfg.bodyShare) { kind = dg.kind; url = dg.url; cost = dg.cost; downgraded = true; }
        for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
          if (ctx.fatal) return { ok: false, skipped: true, kind: ctx.fatal.kind, status: ctx.fatal.status, reason: ctx.fatal.reason, message: 'skipped after ' + ctx.fatal.kind + ' error' };
          if (!(await budget.take(cost, optional ? 0 : null))) return { ok: false, deferred: true, kind: 'budget', status: 0, reason: 'quota_budget', message: 'Waiting for Gmail quota' };
          ctx.requests[kind] = (ctx.requests[kind] || 0) + 1;
          ctx.units += cost; ctx.attempts++;
          let res = null, netErr = '';
          try { res = await request(url); } catch (e) { netErr = String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)); if (e?.name !== 'AbortError') { budget.refund(cost); ctx.units -= cost; } }
          if (res && res.ok) return { ok: true, data: res.data, status: res.status, downgraded };
          const f = classifyFailure(res);
          last = { kind: f.kind, status: res?.status || 0, reason: res?.reason || '', message: res?.message || netErr || '' };
          if (f.kind === 'quota') ctx.quotaErrors++;
          if (f.kind === 'auth' || f.kind === 'daily') { ctx.fatal = last; return { ok: false, ...last, attempts: attempt + 1 }; }
          if (!f.retry || attempt === cfg.maxAttempts - 1) return { ok: false, ...last, attempts: attempt + 1 };
          if (f.kind === 'quota') budget.penalize(res?.retryAfterMs ?? cfg.quotaCooldownMs);
          ctx.retries++;
          await sleep(backoffDelay(attempt, { baseMs: cfg.baseDelayMs, maxMs: cfg.maxDelayMs, random, retryAfterMs: f.kind === 'quota' ? null : res?.retryAfterMs }));
        }
        return { ok: false, ...(last || { kind: 'unknown' }) };
      });
    }

    /** Fetch one message once per format; reuses cache and any request already in flight. */
    function getMessage(ctx, id, format) {
      // A body upgrade for a message we already hold fresh metadata for is optional: never wait for quota.
      const c = cache.get(id);
      if (c && !c.stale && (format === 'metadata' || c.format === 'full')) return Promise.resolve({ ok: true, msg: c.msg, cached: true });
      const key = id + '|' + format;
      if (inflight.has(key)) return inflight.get(key);
      const myEpoch = epoch;
      const p = (async () => {
        const urlFor = (f) => `${G}/messages/${encodeURIComponent(id)}?format=${f}&fields=${encodeURIComponent(f === 'full' ? FULL_FIELDS : META_FIELDS)}`;
        const url = urlFor(format);
        const optional = format === 'full' && !!(c && !c.stale);
        const downgrade = format === 'full' && !c ? { kind: 'messages.get(metadata)', url: urlFor('metadata'), cost: COST.getMetadata } : null;
        const r = await call(ctx, format === 'full' ? 'messages.get(full)' : 'messages.get(metadata)', url, format === 'full' ? COST.getFull : COST.getMetadata, { optional, downgrade });
        if (myEpoch !== epoch) return { ok: false, kind: 'reset' };
        if (r.ok && r.data && r.data.id) {
          let msg = r.data;
          // A metadata refresh of a cached full message only updates labels/snippet; keep the body.
          if (format === 'metadata' && c && c.format === 'full') {
            msg = Object.assign({}, c.msg, { labelIds: r.data.labelIds || c.msg.labelIds, snippet: r.data.snippet ?? c.msg.snippet, historyId: r.data.historyId || c.msg.historyId });
            cache.set(id, { msg, format: 'full', stale: false, at: now() });
          } else cache.set(id, { msg, format: r.downgraded ? 'metadata' : format, stale: false, at: now() });
          return { ok: true, msg, fetched: true, downgraded: !!r.downgraded };
        }
        if (r.kind === 'notFound') { cache.delete(id); return { ok: false, deleted: true, kind: 'notFound', status: r.status }; }
        return { ok: false, kind: r.kind, status: r.status, reason: r.reason, message: r.message, deferred: !!r.deferred, skipped: !!r.skipped, prev: c ? c.msg : null, prevFresh: !!(c && !c.stale) };
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }

    async function listIds(ctx, q) {
      const ids = [];
      let pageToken = '', pages = 0, estimate = null, error = null;
      const maxPages = q.pages || 5;
      while (ids.length < q.max && pages < maxPages) {
        const u = `${G}/messages?${q.params}&maxResults=${Math.min(100, q.max - ids.length)}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
        const r = await call(ctx, 'messages.list', u, COST.list);
        if (!r.ok) { error = { kind: r.kind, status: r.status, reason: r.reason, message: r.message, deferred: !!r.deferred }; break; }
        pages++;
        if (r.data && r.data.resultSizeEstimate != null) estimate = r.data.resultSizeEstimate;
        (r.data?.messages || []).forEach((m) => { if (m && m.id && ids.length < q.max) ids.push({ id: m.id, threadId: m.threadId }); });
        pageToken = r.data?.nextPageToken || '';
        if (!pageToken) break;
      }
      return { key: q.key, ids, estimate, pages, error, complete: !error, more: !!pageToken };
    }

    async function applyHistory(ctx, startId) {
      const added = new Set(), deleted = new Set();
      let labelChanges = 0, pageToken = '', pages = 0, latest = null;
      do {
        const u = `${G}/history?startHistoryId=${encodeURIComponent(startId)}&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved&maxResults=500${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
        const r = await call(ctx, 'history.list', u, COST.history);
        if (!r.ok) return { ok: false, expired: r.kind === 'notFound', error: { kind: r.kind, status: r.status, message: r.message } };
        for (const h of r.data?.history || []) {
          (h.messagesAdded || []).forEach((x) => { if (x.message?.id) { added.add(x.message.id); deleted.delete(x.message.id); } });
          (h.messagesDeleted || []).forEach((x) => { const id = x.message?.id; if (id) { deleted.add(id); added.delete(id); cache.delete(id); } });
          (h.labelsAdded || []).forEach((x) => {
            const c = x.message?.id && cache.get(x.message.id);
            if (c) { const set = new Set(c.msg.labelIds || []); (x.labelIds || []).forEach((l) => set.add(l)); c.msg.labelIds = [...set]; labelChanges++; }
          });
          (h.labelsRemoved || []).forEach((x) => {
            const c = x.message?.id && cache.get(x.message.id);
            if (c) { const rm = new Set(x.labelIds || []); c.msg.labelIds = (c.msg.labelIds || []).filter((l) => !rm.has(l)); labelChanges++; }
          });
        }
        latest = r.data?.historyId || latest;
        pageToken = r.data?.nextPageToken || '';
        pages++;
      } while (pageToken && pages < cfg.historyMaxPages);
      if (pageToken) return { ok: false, overflow: true, error: { kind: 'overflow', message: 'history longer than ' + pages + ' pages' } };
      return { ok: true, added, deleted, labelChanges, pages, historyId: latest };
    }

    const markAllStale = () => { cache.forEach((c) => { c.stale = true; }); threadCache.clear(); };

    async function sentThreads(ctx, max) {
      const out = { threads: [], failed: [], fetched: 0, cached: 0, error: null };
      const r = await call(ctx, 'threads.list', `${G}/threads?labelIds=SENT&maxResults=${max}`, COST.threadsList);
      if (!r.ok) { out.error = { kind: r.kind, status: r.status, message: r.message, deferred: !!r.deferred }; threadCache.forEach((t) => out.threads.push(t.thread)); return out; }
      const list = r.data?.threads || [];
      const live = new Set(list.map((t) => t.id));
      [...threadCache.keys()].forEach((k) => { if (!live.has(k)) threadCache.delete(k); });
      const myEpoch = epoch;
      await Promise.all(list.map(async (t) => {
        const c = threadCache.get(t.id);
        if (c && t.historyId && c.historyId === t.historyId) { out.threads.push(c.thread); out.cached++; return; }
        const u = `${G}/threads/${encodeURIComponent(t.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
        const g = await call(ctx, 'threads.get', u, COST.threadGet);
        if (myEpoch !== epoch) return;
        if (g.ok && g.data) { threadCache.set(t.id, { historyId: t.historyId || g.data.historyId, thread: g.data }); out.threads.push(g.data); out.fetched++; return; }
        out.failed.push({ id: t.id, kind: g.kind, status: g.status, reason: g.reason, deferred: !!g.deferred });
        if (c) out.threads.push(c.thread);
      }));
      return out;
    }

    /**
     * Full planned sync.
     * plan.queries: [{ key, params: 'labelIds=INBOX' | 'q=…', max, pages, body: 'full' | 'auto' }]
     * plan.cursor: last stored Gmail historyId (or null)
     * plan.wantsBody(msg): for 'auto' queries, whether a metadata message deserves its full body
     * plan.sentThreads: number of SENT threads to check (0 = skip)
     */
    async function sync(plan) {
      const p = plan || {};
      const ctx = newCtx('sync');
      const t0 = now();
      const queries = p.queries || [];
      const records = { fetched: 0, cached: 0, stale: 0, failed: 0, deferred: 0, deleted: 0, bodyDeferred: 0, bodyFetched: 0 };
      const failures = [];
      const noteFail = (id, r, status) => { if (failures.length < cfg.maxFailuresReported) failures.push({ id, status, kind: r.kind || '', http: r.status || 0, reason: r.reason || '', message: String(r.message || '').slice(0, 140) }); };

      // 1. Where is the mailbox now? (read before listing so changes during the sync are seen next time)
      const prof = await call(ctx, 'profile', `${G}/profile`, COST.profile);
      const startHistoryId = prof.ok ? String(prof.data?.historyId || '') : '';

      // 2. Apply history to cached messages (labels, deletions) and pick up additions.
      let history = { mode: p.cursor ? 'pending' : 'none' };
      let historyAdded = new Set(), historyDeleted = new Set();
      if (p.cursor && startHistoryId) {
        if (String(p.cursor) === startHistoryId) history = { mode: 'unchanged', ok: true };
        else {
          const h = await applyHistory(ctx, p.cursor);
          if (h.ok) { history = { mode: 'incremental', ok: true, added: h.added.size, deleted: h.deleted.size, labelChanges: h.labelChanges, pages: h.pages }; historyAdded = h.added; historyDeleted = h.deleted; }
          else { history = { mode: h.expired ? 'expired-cursor-recovery' : (h.overflow ? 'overflow-recovery' : 'error-recovery'), ok: false, error: h.error }; markAllStale(); }
        }
      } else if (p.cursor && !startHistoryId) { history = { mode: 'profile-failed', ok: false, error: { kind: prof.kind, status: prof.status } }; markAllStale(); }

      // 3. List every query (IDs only).
      const lists = await Promise.all(queries.map((q) => listIds(ctx, q)));

      // 4. Union + dedupe before fetching anything.
      const union = new Map();
      let listedTotal = 0;
      lists.forEach((l) => l.ids.forEach((m) => {
        listedTotal++;
        let e = union.get(m.id);
        if (!e) { e = { id: m.id, threadId: m.threadId, sources: new Set() }; union.set(m.id, e); }
        e.sources.add(l.key);
      }));
      const fullKeys = new Set(queries.filter((q) => q.body === 'full').map((q) => q.key));
      const extras = [...historyAdded].filter((id) => !union.has(id) && !historyDeleted.has(id)).slice(0, cfg.historyExtrasMax);
      extras.forEach((id) => union.set(id, { id, threadId: null, sources: new Set(['history']) }));

      // 5. Decide format per message and fetch.
      let fullLeft = cfg.maxFullPerSync;
      const result = new Map(); // id -> { msg, status }
      const entries = [...union.values()];
      const firstPass = entries.map((e) => {
        if (historyDeleted.has(e.id)) { result.set(e.id, { msg: null, status: 'deleted' }); return null; }
        const wantFull = [...e.sources].some((k) => fullKeys.has(k));
        const c = cache.get(e.id);
        let format = 'metadata';
        if (wantFull) {
          if (c && c.format === 'full' && !c.stale) format = 'full';
          else if (c && c.format === 'full' && c.stale) format = 'metadata'; // body unchanged; refresh labels only
          else if (fullLeft > 0) { format = 'full'; fullLeft--; }
          else e.bodyDeferred = true;
        }
        return getMessage(ctx, e.id, format).then((r) => ({ e, r, format }));
      }).filter(Boolean);
      const sentP = p.sentThreads ? sentThreads(ctx, p.sentThreads) : Promise.resolve({ threads: [], failed: [], fetched: 0, cached: 0, error: null });
      const firstResults = await Promise.all(firstPass);

      // Inbox-only messages: upgrade to a full body only when it is likely to matter.
      const upgrades = [];
      for (const { e, r, format } of firstResults) {
        if (r.ok && format === 'metadata' && !e.bodyDeferred && r.msg && r.msg._format !== 'full' && !(cache.get(e.id)?.format === 'full')) {
          const wants = typeof p.wantsBody === 'function' && (() => { try { return !!p.wantsBody(r.msg); } catch { return false; } })();
          if (wants) { if (fullLeft > 0) { fullLeft--; upgrades.push(e); } else e.bodyDeferred = true; }
        }
      }
      const upgradeResults = new Map();
      await Promise.all(upgrades.map((e) => getMessage(ctx, e.id, 'full').then((r) => upgradeResults.set(e.id, r))));

      // 6. Account for every record.
      for (const { e, r, format } of firstResults) {
        let status, msg = null;
        if (r.ok) { msg = r.msg; status = r.cached ? 'cached' : 'fetched'; if (r.downgraded) e.bodyDeferred = true; else if (!r.cached && format === 'full') records.bodyFetched++; }
        else if (r.deleted) status = 'deleted';
        else if (r.prev && r.prevFresh && format === 'full') { msg = r.prev; status = 'cached'; e.bodyDeferred = true; noteFail(e.id, r, 'body-deferred'); }
        else if (r.prev) { msg = r.prev; status = 'stale'; noteFail(e.id, r, 'stale'); }
        else if (r.deferred || r.skipped) { status = 'deferred'; noteFail(e.id, r, 'deferred'); }
        else { status = 'failed'; noteFail(e.id, r, 'failed'); }
        const up = upgradeResults.get(e.id);
        if (up) {
          if (up.ok) { msg = up.msg; records.bodyFetched++; }
          else { e.bodyDeferred = true; if (!up.deleted) noteFail(e.id, up, 'body-deferred'); }
        }
        if (e.bodyDeferred && msg && cache.get(e.id)?.format !== 'full') { records.bodyDeferred++; msg._bodyDeferred = true; }
        else if (msg) delete msg._bodyDeferred;
        result.set(e.id, { msg, status });
      }
      result.forEach((v) => { records[v.status] = (records[v.status] || 0) + 1; });

      // 7. Sent threads (re-fetched only when their historyId changed).
      const sent = await sentP;
      sent.failed.forEach((f) => noteFail(f.id, f, f.deferred ? 'deferred' : 'failed'));

      // 8. Pools in each query's own order; stale copies are kept so nothing disappears on a bad refresh.
      const pools = {};
      lists.forEach((l) => { pools[l.key] = l.ids.map((m) => result.get(m.id)?.msg).filter(Boolean); });
      const historyExtras = extras.map((id) => result.get(id)?.msg).filter(Boolean).map((m) => { m._fromHistory = true; return m; });

      const queryErrors = lists.filter((l) => l.error).map((l) => ({ key: l.key, ...l.error }));
      const partial = Boolean(ctx.fatal || records.failed || records.deferred || records.stale || queryErrors.length || sent.error || sent.failed.length || !prof.ok);
      const cursor = ctx.fatal ? (p.cursor || null) : (startHistoryId || p.cursor || null);
      const report = {
        ok: !partial,
        partial,
        fatal: ctx.fatal,
        durationMs: now() - t0,
        requests: ctx.requests,
        requestCount: Object.values(ctx.requests).reduce((a, b) => a + b, 0),
        units: ctx.units,
        retries: ctx.retries,
        quotaErrors: ctx.quotaErrors,
        listedTotal,
        uniqueIds: union.size,
        duplicatesAvoided: listedTotal - (union.size - extras.length),
        records,
        sent: { checked: (sent.threads || []).length, fetched: sent.fetched, cached: sent.cached, failed: sent.failed.length, error: sent.error },
        queries: lists.map((l) => ({ key: l.key, count: l.ids.length, estimate: l.estimate, pages: l.pages, complete: l.complete, more: l.more, error: l.error })),
        queryErrors,
        history,
        cursor,
        failures,
        summary: ''
      };
      report.summary = summarize(report);
      return { report, pools, historyExtras, threads: sent.threads, cursor };
    }

    /** Small fetch for the Mail widget; shares the cache, budget and retry policy with sync(). */
    async function fetchList(params, max, format) {
      const ctx = newCtx('list');
      const l = await listIds(ctx, { key: 'list', params, max, pages: 1 });
      const rs = await Promise.all(l.ids.map((m) => getMessage(ctx, m.id, format || 'metadata').then((r) => ({ id: m.id, r }))));
      const msgs = [], failed = [];
      rs.forEach(({ id, r }) => { if (r.ok) msgs.push(r.msg); else if (r.prev) { msgs.push(r.prev); failed.push({ id, kind: r.kind, stale: true }); } else if (!r.deleted) failed.push({ id, kind: r.kind, status: r.status, deferred: !!r.deferred }); });
      return { msgs, failed, error: l.error, partial: Boolean(l.error || failed.length || ctx.fatal), requests: ctx.requests, units: ctx.units };
    }

    function reset() { epoch++; cache = new Map(); threadCache = new Map(); inflight.clear(); }

    return {
      sync,
      fetchList,
      reset,
      cacheSize: () => cache.size,
      budgetUsed: () => budget.used(),
      cooldownRemaining: () => budget.cooldownRemaining(),
      _cache: () => cache,
      config: cfg
    };
  }

  function summarize(r) {
    const rec = r.records || {};
    if (r.fatal) return `Gmail sync stopped: ${r.fatal.kind === 'auth' ? 'Google sign-in expired' : r.fatal.kind === 'daily' ? 'daily Gmail quota reached' : r.fatal.kind}`;
    if (!r.partial) return `Gmail synced · ${r.uniqueIds} messages (${rec.fetched || 0} fetched, ${rec.cached || 0} unchanged${rec.bodyDeferred ? `, ${rec.bodyDeferred} full texts queued` : ''})`;
    const bits = [];
    if (rec.failed) bits.push(`${rec.failed} failed`);
    if (rec.deferred) bits.push(`${rec.deferred} waiting for quota`);
    if (rec.stale) bits.push(`${rec.stale} not refreshed`);
    if (r.queryErrors?.length) bits.push(`${r.queryErrors.length} search${r.queryErrors.length > 1 ? 'es' : ''} failed`);
    if (r.sent?.error || r.sent?.failed) bits.push('sent mail check incomplete');
    if (r.history && r.history.ok === false && !bits.length) bits.push('history recovered');
    return `Gmail partly synced · ${bits.join(', ') || 'incomplete'}`;
  }

  const api = { createGmailSync, classifyFailure, backoffDelay, createBudget, createPool, COST, DEFAULTS, META_FIELDS, FULL_FIELDS, summarize, header: hdr };
  root.DaylightGmailSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

// ---- live probe runner (read-only GETs; prints counts only, never message content) ----
window.__p1probe = async function (mode) {
  const W = localStorage.getItem('daylight-api'), S = localStorage.getItem('daylight-session');
  if (!W || !S) return { error: 'not signed in on this browser' };
  const tk = await (await fetch(W + '/api/google/token', { method: 'POST', headers: { Authorization: 'Bearer ' + S } })).json().catch(() => ({}));
  if (!tk.access_token) return { error: 'token', detail: tk.error || null };
  const T = tk.access_token;
  const http = {}, kinds = {}; let starts = [];
  const request = async (url) => {
    const k = /\/profile/.test(url) ? 'profile' : /\/history/.test(url) ? 'history' : /\/threads\?/.test(url) ? 'threads.list' : /\/threads\//.test(url) ? 'threads.get' : /\/messages\?/.test(url) ? 'messages.list' : /format=full/.test(url) ? 'get(full)' : 'get(metadata)';
    kinds[k] = (kinds[k] || 0) + 1; starts.push(performance.now());
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + T } });
    http[r.status] = (http[r.status] || 0) + 1;
    let data = null; try { data = await r.json(); } catch {}
    if (r.ok) return { ok: true, status: r.status, data };
    return { ok: false, status: r.status, data, reason: data?.error?.errors?.[0]?.reason || data?.error?.status || '', message: (data?.error?.message || '').slice(0, 160) };
  };
  if (!window.__p1eng || mode === 'cold') window.__p1eng = window.DaylightGmailSync.createGmailSync({ request: (u) => window.__p1req(u) });
  window.__p1req = request;
  const PENDING_PAY=/\b(payment (due|failed|reminder|declined)|past due|overdue (bill|payment)|action required.*(pay|bill)|unpaid|failed payment|pay now|outstanding balance|dlužn|nezaplacen|platba (po|je) splatnosti)\b/i;
  const BILL=/\b(invoice|bill(ing)?|statement|utilities?|electric|gas bill|water bill|internet bill|phone bill|faktura|vyúčtování|inkaso|složenka|předpis)\b/i;
  const MONEY=/\b(renew(al|s|ing)?|subscription|subscribed|membership|trial|expir|payment|invoice|receipt|bill(ing)?|auto-?renew|charged|statement|paypal|stripe|sepa|faktura|platba|předplatné|vyúčtování|účet|premium|plan)\b/i;
  const TRAVEL=/\b(booking|reservation|itinerary|e-?ticket|boarding[\s-]?pass|flights?|train|bahn|rail|eurostar|(?:flight|hotel|airport)\s*check-?in|hotel|airbnb|boarding pass|departure|arrival|gate\s?[A-Z]?\d+|PNR|confirmation code|trip to)\b/i;
  const DOCUMENT=/\b(document|contract|agreement|signed|signature|attachment|pdf|passport|visa|insurance|policy|tax|steuer|certificate|invoice attached|your copy)\b/i;
  const moneyQ = [
    'newer_than:120d (subscription OR renew OR renewal OR invoice OR billing OR bill OR payment OR paid OR charged OR trial OR membership OR premium OR paypal OR stripe OR faktura OR platba OR předplatné OR vyúčtování)',
    'newer_than:90d category:updates (bill OR invoice OR payment OR receipt OR renew OR subscription OR faktura OR platba OR billing)',
    'newer_than:180d (from:paypal.com OR from:stripe.com OR from:apple.com OR from:netflix.com OR from:spotify.com OR from:adobe.com OR from:google.com OR from:microsoft.com OR from:revolut.com OR from:wise.com)'
  ];
  const qp = (q) => 'q=' + encodeURIComponent(q);
  const H = (m, n) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
  const plan = {
    cursor: window.__p1cursor || null, sentThreads: 12,
    queries: [
      { key: 'inbox', params: 'labelIds=INBOX', max: 50, pages: 2, body: 'auto' },
      { key: 'moneyA', params: qp(moneyQ[0]), max: 30, pages: 2, body: 'full' },
      { key: 'moneyB', params: qp(moneyQ[1]), max: 20, pages: 1, body: 'full' },
      { key: 'moneyC', params: qp(moneyQ[2]), max: 25, pages: 1, body: 'full' },
      { key: 'travel', params: qp('(flight OR train OR booking OR itinerary OR "boarding pass" OR hotel OR reservation OR e-ticket) newer_than:45d'), max: 15, pages: 1, body: 'full' },
      { key: 'docs', params: qp('(document OR contract OR agreement OR signed OR insurance OR passport OR visa OR pdf OR tax) newer_than:45d has:attachment'), max: 12, pages: 1, body: 'full' }
    ],
    wantsBody: (m) => { const l = m.labelIds || []; if (l.some((x) => /^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/.test(x))) return false; const t = H(m, 'Subject') + ' ' + H(m, 'From') + ' ' + (m.snippet || ''); return MONEY.test(t) || PENDING_PAY.test(t) || BILL.test(t) || TRAVEL.test(t) || DOCUMENT.test(t); }
  };
  const t0 = performance.now();
  const [mail, res] = await Promise.all([window.__p1eng.fetchList('labelIds=INBOX', 10, 'metadata'), window.__p1eng.sync(plan)]);
  window.__p1cursor = res.cursor;
  const s = [...starts].sort((a, b) => a - b); let peak = 0, j = 0; for (let i = 0; i < s.length; i++) { while (s[i] - s[j] >= 1000) j++; peak = Math.max(peak, i - j + 1); }
  const r = res.report;
  return { mode, seconds: +((performance.now() - t0) / 1000).toFixed(1), httpStatus: http, requestsByKind: kinds, totalRequests: s.length, peakRequestsPerSecond: peak,
    engineUnits: r.units + mail.units, ok: r.ok, partial: r.partial, summary: r.summary, records: r.records, uniqueIds: r.uniqueIds, listedTotal: r.listedTotal, duplicatesAvoided: r.duplicatesAvoided,
    retries: r.retries, quotaErrors: r.quotaErrors, history: r.history, sent: r.sent, queries: r.queries.map((q) => ({ key: q.key, count: q.count, estimate: q.estimate, complete: q.complete })),
    failures: r.failures.map((f) => ({ status: f.status, kind: f.kind, http: f.http, reason: f.reason })).slice(0, 10), mailWidget: { msgs: mail.msgs.length, failed: mail.failed.length } };
};
