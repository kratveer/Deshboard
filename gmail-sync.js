// Daylight Gmail request layer. One shared instance per page; the Gmail pipeline (gmail-pipeline.js) sends every
// Gmail request through it so that:
//  - a per-minute quota budget is never exceeded and no more than N requests run at once;
//  - quota (429 / 403 rate-limit), 5xx and network errors are retried with jittered exponential backoff;
//  - every request is counted (units per operation, retries, quota errors) for the diagnostics.
// The Phase 1 six-search sync engine that used to live here was removed in v103/v104; the pipeline is the only engine.
// No DOM access and no storage.
(function (root) {
  'use strict';

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
    maxFailuresReported: 60,
    cacheKeepSyncs: 5
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
    let epoch = 0;               // bumps on reset (account change)

    const newCtx = (label) => ({ label, requests: {}, units: 0, retries: 0, attempts: 0, quotaErrors: 0, fatal: null, startedAt: now() });

    /** One Gmail GET with budget, concurrency limit and retry. Never throws. */
    function call(ctx, kind, url, cost, callOpt) {
      const optional = !!(callOpt && callOpt.optional);
      return pool(async () => {
        let last = null, downgraded = false;
        // Optional body: if quota is getting tight, fetch metadata instead so the record still arrives.
        const dg = callOpt && callOpt.downgrade;
        if (dg && budget.used() + cost > cfg.limitPerMinute * cfg.bodyShare) { kind = dg.kind; url = dg.url; cost = dg.cost; downgraded = true; }
        const maxAttempts = (callOpt && callOpt.maxAttempts) || cfg.maxAttempts;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (ctx.fatal) return { ok: false, skipped: true, kind: ctx.fatal.kind, status: ctx.fatal.status, reason: ctx.fatal.reason, message: 'skipped after ' + ctx.fatal.kind + ' error' };
          if (!(await budget.take(cost, optional ? 0 : null))) return { ok: false, deferred: true, kind: 'budget', status: 0, reason: 'quota_budget', message: 'Waiting for Gmail quota' };
          ctx.requests[kind] = (ctx.requests[kind] || 0) + 1;
          ctx.units += cost; ctx.attempts++;
          ctx.unitsByKind = ctx.unitsByKind || {}; ctx.unitsByKind[kind] = (ctx.unitsByKind[kind] || 0) + cost; // quota per operation
          let res = null, netErr = '';
          try { res = await (callOpt && typeof callOpt.send === 'function' ? callOpt.send() : request(url)); } catch (e) { netErr = String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)); if (e?.name !== 'AbortError') { budget.refund(cost); ctx.units -= cost; } }
          if (res && res.ok) return { ok: true, data: res.data, status: res.status, downgraded };
          const f = classifyFailure(res);
          last = { kind: f.kind, status: res?.status || 0, reason: res?.reason || '', message: res?.message || netErr || '' };
          if (f.kind === 'quota') ctx.quotaErrors++;
          if (f.kind === 'auth' || f.kind === 'daily') { ctx.fatal = last; return { ok: false, ...last, attempts: attempt + 1 }; }
          if (!f.retry || attempt === maxAttempts - 1) { if (callOpt && callOpt.refundOnFailure && f.kind !== 'quota') { budget.refund(cost); ctx.units -= cost; } return { ok: false, ...last, attempts: attempt + 1 }; }
          if (f.kind === 'quota') budget.penalize(res?.retryAfterMs ?? cfg.quotaCooldownMs);
          ctx.retries++;
          await sleep(backoffDelay(attempt, { baseMs: cfg.baseDelayMs, maxMs: cfg.maxDelayMs, random, retryAfterMs: f.kind === 'quota' ? null : res?.retryAfterMs }));
        }
        return { ok: false, ...(last || { kind: 'unknown' }) };
      });
    }

    function reset() { epoch++; }

    return {
      reset,
      // the Gmail pipeline (gmail-pipeline.js) sends every request through this budget, pool, retry and accounting:
      newCtx,
      call,
      epoch: () => epoch,
      budgetUsed: () => budget.used(),
      cooldownRemaining: () => budget.cooldownRemaining(),
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
