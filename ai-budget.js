// Daylight AI cost control (v2).
// Decides which emails may reach Gemini, cleans and truncates their text, enforces a daily per-account cap
// (over the cap → deferred, never dropped), keeps a token + money ledger from a configurable price table,
// and learns sender-domain → category mappings (domain and category only, never content).
// Money (USD) is tracked here; Gmail quota units are tracked by the sync pipeline — they are never mixed.
(function (root) {
  'use strict';

  // ---------- text cleaning ----------
  const QUOTE_HEADERS = [
    /^On .{4,120}wrote:\s*$/im, /^-{2,}\s*Original Message\s*-{2,}/im, /^-{2,}\s*Forwarded message\s*-{2,}/im,
    /^Dne .{4,120}napsal\(a\):\s*$/im, /^Am .{4,120}schrieb .{1,80}:\s*$/im, /^From: .{3,120}\r?\nSent: /im, /^Od: .{3,120}\r?\nOdesláno: /im
  ];
  const FOOTER = /(unsubscribe|odhlásit|abmelden|manage (?:your )?preferences|privacy policy|zásady ochrany|datenschutz|this (?:e-?mail|message) (?:was sent|is intended)|confidential(?:ity)? notice|all rights reserved|©|view (?:this email )?in (?:your )?browser|you are receiving this|if you no longer wish)/i;
  const SIG = /^(?:--\s*$|—\s*$|Sent from my |Odesláno z |Von meinem .* gesendet|Get Outlook for )/m;

  function stripHtml(h) {
    return String(h || '').replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  }
  /**
   * Clean an email for AI: HTML → text, drop quoted replies, signatures, legal/marketing footers and tracking links,
   * collapse whitespace, truncate to maxChars. Returns { text, removed: {...}, originalLength }.
   */
  function cleanForAi(input, maxChars) {
    const max = maxChars || 2000;
    let t = String(input || '');
    const originalLength = t.length;
    const removed = { html: false, quoted: 0, signature: false, footerLines: 0, links: 0, truncated: false };
    if (/<[a-z][\s\S]*>/i.test(t)) { t = stripHtml(t); removed.html = true; }
    // quoted replies: cut at the first quote header; drop "> " lines
    for (const re of QUOTE_HEADERS) { const m = re.exec(t); if (m && m.index > 40) { t = t.slice(0, m.index); removed.quoted++; } }
    const lines = t.split(/\r?\n/);
    const kept = [];
    for (const ln of lines) {
      if (/^\s*>/.test(ln)) { removed.quoted++; continue; }
      if (FOOTER.test(ln) && ln.length < 400) { removed.footerLines++; continue; }
      kept.push(ln);
    }
    t = kept.join('\n');
    const sm = SIG.exec(t); if (sm && sm.index > 40) { t = t.slice(0, sm.index); removed.signature = true; }
    // links: tracking links removed, others reduced to their host (keeps "booking.com" as a hint)
    t = t.replace(/https?:\/\/[^\s<>"')]+/gi, (u) => {
      removed.links++;
      if (/[?&](utm_|mc_|trk|track|click|redirect|u=|e=|token=)|\/(?:track|click|wf\/click|ls\/click)\//i.test(u) || u.length > 120) return '';
      try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
    });
    t = t.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (t.length > max) { t = t.slice(0, max); removed.truncated = true; }
    return { text: t, removed, originalLength };
  }

  const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);

  // ---------- strict output schema ----------
  // One schema for every call; each extracted field carries its own confidence 0..1.
  const OUTPUT_SCHEMA = Object.freeze({
    category: 'string', intent: 'string', confidence: 'number', summary: 'string',
    fields: 'object',            // { name: { value, confidence } }
    requires_confirmation: 'boolean'
  });
  /** Parse model output strictly. Returns { ok, value, error }. Callers retry at most once on !ok. */
  function parseStrict(text) {
    let s = String(text || '').trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s); if (fence) s = fence[1].trim();
    let v;
    try { v = JSON.parse(s); } catch (e) { return { ok: false, error: 'invalid JSON' }; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'not an object' };
    for (const [k, t] of Object.entries(OUTPUT_SCHEMA)) {
      if (!(k in v)) { if (k === 'fields') v.fields = {}; else if (k === 'requires_confirmation') v.requires_confirmation = false; else return { ok: false, error: 'missing ' + k }; }
      if (typeof v[k] !== t) return { ok: false, error: `${k} should be ${t}` };
    }
    if (!(v.confidence >= 0 && v.confidence <= 1)) return { ok: false, error: 'confidence out of range' };
    for (const [f, x] of Object.entries(v.fields)) {
      if (!x || typeof x !== 'object' || !('value' in x)) return { ok: false, error: `field ${f} needs {value, confidence}` };
      if (typeof x.confidence !== 'number' || x.confidence < 0 || x.confidence > 1) return { ok: false, error: `field ${f} confidence` };
    }
    return { ok: true, value: v };
  }

  // ---------- budget ----------
  /**
   * o.cache: DaylightMailCache instance (metrics + domain cache). o.config: resolved config (uses .ai).
   */
  function createAiBudget(o) {
    const cfg = o.config.ai;
    const cache = o.cache;
    const now = o.now || (() => Date.now());
    const day = () => new Date(now()).toISOString().slice(0, 10);
    const price = (model) => cfg.prices[model || cfg.model] || { input: 0, output: 0, batchFactor: 1 };

    function costUsd(model, inTok, outTok, mode) {
      const p = price(model);
      const f = mode === 'batch' ? (p.batchFactor ?? 1) : 1;
      return ((inTok * p.input + outTok * p.output) / 1e6) * f;
    }
    async function today(acct) {
      const all = await cache.metrics(acct);
      return (all.find((m) => m.day === day()) || { counters: {} }).counters;
    }
    /**
     * Should this email go to AI at all? (independent of the daily cap)
     * c: { aiEnabled, allowFinancial, financial, category, confidence, missing[], highValue, escalated, bodyHash, prevAiHash }
     */
    function wants(c) {
      if (!c.aiEnabled) return { send: false, reason: 'AI is off' };
      if (c.financial && !c.allowFinancial) return { send: false, reason: 'financial mail is not sent to AI (privacy setting)' };
      if (c.bodyHash && c.prevAiHash && c.bodyHash === c.prevAiHash) return { send: false, reason: 'already analysed this exact text' };
      if (!c.highValue && !c.escalated) return { send: false, reason: 'low-value mail is handled by rules' };
      if (c.complete && c.confidence >= (c.high ?? 0.85)) return { send: false, reason: 'rules / structured data were enough' };
      if (c.missing && c.missing.length) return { send: true, reason: 'missing ' + c.missing.join(', ') };
      if (c.confidence < (c.high ?? 0.85)) return { send: true, reason: 'low confidence ' + c.confidence.toFixed(2) };
      return { send: false, reason: 'confident' };
    }
    /** Per-sync cap from the share target (at least 1 when there is new mail). */
    const perSyncCap = (newCount) => (newCount > 0 ? Math.max(1, Math.ceil(newCount * cfg.maxShareOfNewMail)) : 0);
    /** Daily cap check. Returns { ok, reason }. */
    async function canSpend(acct, plannedTokens) {
      const c = await today(acct);
      if ((c.aiRequests || 0) >= cfg.dailyRequestCap) return { ok: false, reason: `daily AI cap reached (${cfg.dailyRequestCap} requests)` };
      const spent = (c.aiCostMicroUsd || 0) / 1e6;
      const next = costUsd(cfg.model, plannedTokens || 0, 300, cfg.mode);
      if (spent + next > cfg.dailyCostCapUsd) return { ok: false, reason: `daily AI budget reached ($${cfg.dailyCostCapUsd})` };
      return { ok: true };
    }
    /** Record one call in the money ledger (separate from Gmail quota units). */
    async function record(acct, u) {
      const inTok = u.inputTokens || 0, outTok = u.outputTokens || 0;
      const usd = costUsd(u.model, inTok, outTok, u.mode || 'live');
      await cache.addMetrics(acct, { counters: { aiRequests: 1, aiInputTokens: inTok, aiOutputTokens: outTok, aiCostMicroUsd: Math.round(usd * 1e6), ['aiMode_' + (u.mode || 'live')]: 1, aiInvalidJson: u.invalidJson ? 1 : 0, aiRetries: u.retried ? 1 : 0 } });
      return usd;
    }
    /** Sender-domain learning: only domain → category. */
    async function learn(acct, domain, category, confidence) {
      if (!domain || !category || confidence < cfg.domainLearnMinConfidence) return null;
      return cache.recordDomainCategory(acct, domain, category, 'ai', { threshold: cfg.domainLearnThreshold });
    }
    /** Gemini batch submission is behind this interface and disabled until the Worker supports it. */
    async function submitBatch(items, submitter) {
      if (!cfg.batchEnabled || typeof submitter !== 'function') return { submitted: false, reason: 'batch mode disabled — items stay queued for live calls', count: items.length };
      return submitter(items);
    }
    return { wants, perSyncCap, canSpend, record, learn, costUsd, submitBatch, today };
  }

  const api = { cleanForAi, estimateTokens, parseStrict, OUTPUT_SCHEMA, createAiBudget };
  root.DaylightAiBudget = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
