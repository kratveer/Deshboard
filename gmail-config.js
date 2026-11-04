// Daylight Gmail cost & resource configuration (v2).
// Every tunable number used by the scheduler, cache, rules, batch, AI budget and metrics lives here.
// Gmail quota units (not money) and AI cost (money) are configured and tracked separately.
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    // ---- 1. scheduling (local time of the user's device) ----
    schedule: Object.freeze({
      slots: Object.freeze(['07:00', '10:30', '13:30', '17:30', '21:30']),
      openSkipMinutes: 15,          // skip the open/visible refresh if a sync finished this recently
      timersWhileOpen: true,        // fire slot syncs while a tab stays open
      lockName: 'daylight-gmail-sync',
      lockLeaseMs: 120000,          // fallback lease (no Web Locks): a crashed tab frees the lock after this
      manualBypassesSkip: true
    }),
    // ---- quota (Gmail units, not money) ----
    quota: Object.freeze({ limitPerMinute: 4800 }), // client-side ceiling, 80 % of Google's 6,000 units/min/user
    // ---- 2. window ----
    window: Object.freeze({
      backfillDays: 30,             // initial backfill and checkpoint recovery: newer_than:30d only
      backfillMax: 1000,            // safety cap on IDs listed in one backfill
      listPageSize: 500,            // messages.list maxResults (Gmail allows up to 500; 5 units per page)
      olderScanDays: 180,           // manual "Scan older bills" only (never automatic)
      olderScanMax: 150,
      inboxPoolMax: 100,            // how many cached INBOX messages the UI receives
      categoryPoolMax: 200
    }),
    // ---- 3. pipeline ----
    pipeline: Object.freeze({
      metadataHeaders: Object.freeze(['From', 'To', 'Subject', 'Date', 'List-Unsubscribe', 'Content-Type']),
      historyMaxPages: 20,
      highConfidence: 0.85,         // stop the rule pipeline at or above this
      lowConfidence: 0.55,          // below this → escalate to body (if signals) or "other"
      reviewBand: Object.freeze([0.55, 0.85]), // ambiguous after Stage C → review queue
      maxFullPerSync: 40,           // body fetches per sync; the rest are queued persistently
      sentThreads: 12,
      useBatch: true,
      batchSize: 50,
      batchFallbackAfterFailures: 2, // after N batch transport failures in a session, use single GETs
      // Cheap recall net: Gmail full-text searches return only IDs (5 units/page) but match words in the BODY,
      // so a bill whose subject and snippet look harmless still gets its body read. Run only when there is new mail.
      searches: Object.freeze({
        money: '(invoice OR receipt OR refund OR payment OR paid OR charged OR "amount due" OR "due date" OR bill OR billing OR subscription OR renewal OR renew OR transaction OR faktura OR vyúčtování OR platba OR splatnost OR "k úhradě" OR předplatné OR vrácení OR rechnung OR zahlung OR erstattung OR रसीद OR भुगतान OR बिल)',
        travel: '(flight OR "boarding pass" OR itinerary OR e-ticket OR ticket OR booking OR reservation OR hotel OR check-in OR PNR OR train OR "your order from" OR restaurant OR letenka OR jízdenka OR rezervace OR ubytování OR buchung OR टिकट OR यात्रा)',
        document: '(contract OR agreement OR signed OR insurance OR certificate OR statement OR tax OR visa OR passport OR smlouva OR pojistka OR výpis OR vertrag) has:attachment'
      }),
      searchHintCategory: Object.freeze({ money: 'payment', travel: 'travel', document: 'document' })
    }),
    // ---- 4. cache ----
    cache: Object.freeze({
      dbName: 'daylight-mail',
      keepDeletedDays: 60,          // deleted-message tombstones (financial records are never removed)
      keepBodies: false             // raw bodies are never stored; only bodyHash + facts
    }),
    // ---- 5. AI ----
    ai: Object.freeze({
      maxShareOfNewMail: 0.05,      // target: < 5 % of new mail reaches AI
      maxCredits: 25,               // AI credit bucket ceiling (credits = 5 % of each new email; 1 credit = 1 call)
      maxChars: 2000,
      dailyRequestCap: 40,          // per account; over the cap → deferred to the next sync
      dailyCostCapUsd: 0.25,
      domainLearnThreshold: 3,      // AI-confident classifications of one domain before it becomes a rule
      domainLearnMinConfidence: 0.85,
      mode: 'live',                 // 'live' | 'batch' (batch submission is disabled until the Worker supports it)
      batchEnabled: false,
      model: 'gemini-3.5-flash-lite',
      // USD per 1M tokens. Free tier = 0. Edit here, not in code. Batch is typically 50 % of live.
      prices: Object.freeze({
        'gemini-3.5-flash-lite': Object.freeze({ input: 0.10, output: 0.40, batchFactor: 0.5, freeTier: true }),
        'gemini-3.5-flash': Object.freeze({ input: 0.30, output: 2.50, batchFactor: 0.5, freeTier: false })
      })
    }),
    // ---- 6. attachments ----
    attachments: Object.freeze({
      autoDownload: false,          // OFF by default (you approved metadata-only)
      maxBytes: 5 * 1024 * 1024,
      mimeTypes: Object.freeze(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/vnd.apple.pkpass']),
      extensions: Object.freeze(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.pkpass']),
      categories: Object.freeze(['bill', 'travel', 'document', 'receipt'])
    }),
    // ---- engine selection (reversible) ----
    engine: Object.freeze({ mode: 'optimised' }) // 'optimised' | 'legacy' (Phase 1 six-search plan)
  });

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function merge(base, over) {
    if (!isObj(over)) return base;
    const out = {};
    Object.keys(base).forEach((k) => { out[k] = isObj(base[k]) ? merge(base[k], over[k]) : (over[k] !== undefined ? over[k] : base[k]); });
    Object.keys(over).forEach((k) => { if (!(k in base)) out[k] = over[k]; });
    return out;
  }
  /** Effective config: defaults ← global overrides ← per-account overrides. */
  function resolve(overrides, accountOverrides) { return merge(merge(DEFAULTS, overrides || {}), accountOverrides || {}); }

  const LS_KEY = 'daylight-gmail-config';
  function load(accountId) {
    let saved = {};
    try { saved = JSON.parse(root.localStorage?.getItem(LS_KEY) || '{}') || {}; } catch { saved = {}; }
    return resolve(saved.global, accountId ? (saved.accounts || {})[accountId] : null);
  }

  const api = { DEFAULTS, resolve, merge, load, LS_KEY };
  root.DaylightGmailConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
