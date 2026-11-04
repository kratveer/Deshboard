// Daylight sync-efficiency metrics (v2): turns the per-day counters kept in the mail cache into the
// Sync Efficiency panel. Gmail quota units and AI money are reported separately and labelled as such.
(function (root) {
  'use strict';
  const STAGES = ['gmail-category', 'list-unsubscribe', 'domain-cache', 'keywords', 'best-effort', 'fallback'];

  function sum(rows) {
    const c = {}; const runs = [];
    rows.forEach((r) => { Object.entries(r.counters || {}).forEach(([k, v]) => { c[k] = (c[k] || 0) + v; }); (r.runs || []).forEach((x) => runs.push(x)); });
    return { c, runs };
  }
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  /** rows: syncMetrics rows (any accounts, any days). opts.days limits to the last N days. */
  function summarise(rows, opts) {
    const days = opts?.days || 1;
    const cut = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const sel = (rows || []).filter((r) => r.day >= cut);
    const { c, runs } = sum(sel);
    const n = (k) => c[k] || 0;
    const lookups = n('domainLookups');
    return {
      days, rowCount: sel.length,
      syncs: { scheduled: n('sync_scheduled'), manual: n('sync_manual'), open: n('sync_open-refresh') + n('sync_visible'), catchUp: n('sync_catch-up'), connect: n('sync_connect'), skipped: n('sync_skipped'), total: n('syncs') },
      quota: {
        units: n('units'),
        historyList: n('req_history'), messagesList: n('req_list'), metadataGets: n('req_getMeta'), fullGets: n('req_getFull'),
        threadsList: n('req_threadsList'), threadsGets: n('req_threadsGet'), profile: n('req_profile'),
        batchRequests: n('req_batch'), batchedParts: n('batchedParts'), batchFallbacks: n('batchFallback')
      },
      rules: Object.fromEntries(STAGES.map((s) => [s, n('stage_' + s)])),
      skippedWithoutBody: n('noBodyNeeded'), escalated: n('escalated'), bodiesQueued: n('bodyQueued'),
      domainCache: { lookups, hits: n('domainHits'), hitRate: lookups ? +(n('domainHits') / lookups).toFixed(3) : null },
      duplicatesAvoided: n('cachedUnchanged') + n('dupAvoided'),
      labelOnlyUpdates: n('labelOnly'), deletionsMarked: n('deleted'),
      ai: {
        requests: n('aiRequests'), inputTokens: n('aiInputTokens'), outputTokens: n('aiOutputTokens'),
        estimatedCostUsd: +(n('aiCostMicroUsd') / 1e6).toFixed(4), deferred: n('aiDeferred'), skippedByRules: n('aiSkipped'), invalidJson: n('aiInvalidJson'), retries: n('aiRetries'),
        label: 'money (USD, estimated from the price table) — not Gmail quota'
      },
      failed: n('failed'), deferred: n('deferred'),
      duration: { coldMs: avg(runs.filter((r) => r.cold).map((r) => r.ms)), warmMs: avg(runs.filter((r) => !r.cold).map((r) => r.ms)), runs: runs.length },
      lastRuns: runs.slice(-8)
    };
  }

  const api = { summarise, STAGES };
  root.DaylightSyncMetrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
