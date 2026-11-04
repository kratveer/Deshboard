/**
 * Daylight Gmail cost benchmark — CURRENT (Phase 1 engine + six-search plan, memory-only cache) vs OPTIMISED (v2 pipeline).
 * SYNTHETIC data only (tests/fixtures/mail-200.js + generated volume). Never touches a real account.
 * Quota units are what the mock Gmail charges with Google's 2026 unit table (independent of the client's own accounting).
 * AI: both sides assume Email Intelligence is ON with the financial opt-in OFF (the app default when AI is consented).
 * Classification metrics are RULES-ONLY on both sides (the AI stub never changes a category), so AI cannot inflate them.
 * Run: node tests/gmail-cost-bench.js [--quick]
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
global.window = globalThis;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'email-classify.js'));
require(path.join(ROOT, 'daylight-ai.js'));
const Cls = window.DaylightEmailClassify, AI = window.DaylightAI;
localStorage.setItem('daylight-ai-consent', '1'); localStorage.setItem('daylight-ai-enabled', '1'); // AI on, financial opt-in off (default)
const F = require(path.join(ROOT, 'finance-intel.js'));
const GS = require(path.join(ROOT, 'gmail-sync.js'));
const CFG = require(path.join(ROOT, 'gmail-config.js'));
const R = require(path.join(ROOT, 'gmail-rules.js'));
const MC = require(path.join(ROOT, 'gmail-cache.js'));
const BT = require(path.join(ROOT, 'gmail-batch.js'));
const PL = require(path.join(ROOT, 'gmail-pipeline.js'));
const AB = require(path.join(ROOT, 'ai-budget.js'));
const SM = require(path.join(ROOT, 'sync-metrics.js'));
const { createMockGmail } = require('./mock-gmail.js');
const { MAIL, CATEGORIES, CRITICAL } = require('./fixtures/mail-200.js');
const QUICK = process.argv.includes('--quick');
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

// ---- the app's own wantsBody regexes, taken verbatim from app.js ----
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const RX = {};
for (const name of ['PENDING_PAY', 'BILL', 'MONEY', 'TRAVEL', 'DOCUMENT']) {
  const m = new RegExp('const ' + name + '=(/.*/[a-z]*);').exec(appSrc);
  if (!m) throw new Error('regex not found in app.js: ' + name);
  RX[name] = vm.runInNewContext(m[1]);
}
const hdr = GS.header;
// ---- CURRENT plan, copied from app.js loadLoops (Phase 1) ----
const moneyQ = [
  'newer_than:120d (subscription OR renew OR renewal OR invoice OR billing OR bill OR payment OR paid OR charged OR trial OR membership OR premium OR paypal OR stripe OR faktura OR platba OR předplatné OR vyúčtování)',
  'newer_than:90d category:updates (bill OR invoice OR payment OR receipt OR renew OR subscription OR faktura OR platba OR billing)',
  'newer_than:180d (from:paypal.com OR from:stripe.com OR from:apple.com OR from:netflix.com OR from:spotify.com OR from:adobe.com OR from:google.com OR from:microsoft.com OR from:revolut.com OR from:wise.com)'
];
const qp = (q) => 'q=' + encodeURIComponent(q);
const currentPlan = (cursor) => ({
  cursor, sentThreads: 12,
  queries: [
    { key: 'inbox', params: 'labelIds=INBOX', max: 50, pages: 2, body: 'auto' },
    { key: 'moneyA', params: qp(moneyQ[0]), max: 30, pages: 2, body: 'full' },
    { key: 'moneyB', params: qp(moneyQ[1]), max: 20, pages: 1, body: 'full' },
    { key: 'moneyC', params: qp(moneyQ[2]), max: 25, pages: 1, body: 'full' },
    { key: 'travel', params: qp('(flight OR train OR booking OR itinerary OR "boarding pass" OR hotel OR reservation OR e-ticket) newer_than:45d'), max: 15, pages: 1, body: 'full' },
    { key: 'docs', params: qp('(document OR contract OR agreement OR signed OR insurance OR passport OR visa OR pdf OR tax) newer_than:45d has:attachment'), max: 12, pages: 1, body: 'full' }
  ],
  wantsBody: (m) => {
    const labels = m.labelIds || [];
    if (labels.some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/.test(l))) return false;
    const h = m.payload?.headers || [], text = hdr({ payload: { headers: h } }, 'Subject') + ' ' + hdr({ payload: { headers: h } }, 'From') + ' ' + (m.snippet || '');
    return RX.MONEY.test(text) || RX.PENDING_PAY.test(text) || RX.BILL.test(text) || RX.TRAVEL.test(text) || RX.DOCUMENT.test(text);
  }
});

// ---- mailbox generation ----
function seedMailbox(mock, opts) {
  const o = opts || {};
  const truth = new Map();
  let n = 0;
  const addFrom = (f, i, ageDays, tag) => {
    const id = `${f.id}-${tag}-${i}`;
    const m = { id, threadId: `${f.threadId}-${tag}-${i}`, from: f.from, subject: f.subject, snippet: f.snippet, body: f.body, html: f.html, labelIds: f.labelIds.slice(), listUnsubscribe: f.listUnsubscribe, attachments: f.attachments, internalDate: NOW - ageDays * DAY - (n++ % 600) * 60000 };
    mock.add(m); truth.set(id, f.label); return id;
  };
  const count = o.recent ?? 200;
  const SET = o.set || MAIL;
  for (let i = 0; i < count; i++) { const f = SET[i % SET.length]; addFrom(f, Math.floor(i / SET.length), o.spreadDays ? (i * 7919) % o.spreadDays : f.ageDays, o.tag || 'r'); }
  for (let i = 0; i < (o.historical || 0); i++) { const f = MAIL[i % MAIL.length]; addFrom(f, Math.floor(i / MAIL.length), 31 + ((i * 7919) % 330), 'h'); }
  // sent mail (reply loops)
  for (let i = 0; i < 14; i++) mock.add({ id: `sent-${o.tag || 'r'}-${i}`, threadId: `t000${(i % 9) + 1}-r-0`, from: 'Me <me@example.com>', to: 'someone@example.com', subject: 'Re: thread ' + i, snippet: 'Thanks, will do.', body: 'Thanks, will do.', labelIds: ['SENT'], internalDate: NOW - (i % 10) * DAY });
  return truth;
}
function newMail(mock, truth, count, tag, ageMax) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const f = MAIL[(i * 37 + tag.length * 11) % MAIL.length];
    const id = `${f.id}-${tag}-${i}`;
    mock.add({ id, threadId: `${f.threadId}-${tag}-${i}`, from: f.from, subject: f.subject, snippet: f.snippet, body: f.body, html: f.html, labelIds: f.labelIds.slice(), listUnsubscribe: f.listUnsubscribe, attachments: f.attachments, internalDate: mock.now() - ((i * 13) % ((ageMax || 1) * 60)) * 60000 });
    truth.set(id, f.label); ids.push(id);
  }
  return ids;
}

// ---- classification (shared, Daylight's existing classifiers) ----
const derive = (m) => { let cls = null, fin = null; try { cls = Cls.classifyEmail(m); } catch {} try { fin = F.classify(m); } catch {} return { cls, fin }; };
function predictCurrent(m) {
  const d = derive(m);
  const mapped = PL.mapDerived(d);
  if (mapped) return mapped.category;
  if (d.fin && d.fin.category === 'promotional_offer') return 'promotion';
  return d.cls ? (PL.CLS_MAP[d.cls.category] || 'other') : 'other';
}

// ---- AI accounting ----
const PRICES = CFG.DEFAULTS.ai.prices['gemini-3.5-flash-lite'];
const usd = (inT, outT, factor) => ((inT * PRICES.input + outT * PRICES.output) / 1e6) * (factor || 1);
const SYS_TOK = AB.estimateTokens(AI.SYSTEM), SCHEMA_TOK = AB.estimateTokens(AI.SCHEMA_HINT);
const CUR_OUT_TOK = 350, NEW_OUT_TOK = 250; // assumption: compact schema → shorter answers (labelled in report)
/** Current app: enrichWithDaylightAI — ≤ 12 per sync, ranked, re-sent after 6 h, cache key includes current_datetime (never hits). */
function currentAi(pool, aiState, nowMs) {
  const res = Cls.classifyAll(pool);
  const byMail = res.byMailId;
  const ranked = Object.values(byMail).sort((a, b) => { const s = (x) => (x.needsReview ? 3 : 0) + (x.category === 'shopping' || x.category === 'ticket' ? 2 : 0) + (x.confidence < 0.62 ? 1 : 0); return s(b) - s(a); });
  const ids = [];
  const pmap = new Map(pool.map((m) => [m.id, m]));
  for (const c of ranked) {
    if (ids.length >= 12) break;
    if (!c?.mailId || !pmap.has(c.mailId)) continue;
    const prev = aiState.get(c.mailId);
    if (prev && nowMs - prev < 6 * 3600000 && !c.needsReview) continue;
    ids.push(c.mailId);
  }
  let calls = 0, inTok = 0, outTok = 0;
  for (const id of ids) {
    const m = pmap.get(id), rule = byMail[id];
    const mail = Cls.normalizeMail(m);
    if (!AI.shouldCallGemini(mail, rule)) continue;
    const prompt = AI.buildPrompt(mail, { nowIso: new Date(nowMs).toISOString(), timezone: 'Europe/Prague' });
    calls++; inTok += SYS_TOK + AB.estimateTokens(prompt); outTok += CUR_OUT_TOK;
    aiState.set(id, nowMs);
  }
  return { calls, inTok, outTok, usd: usd(inTok, outTok) };
}

// ---- runners ----
function makeCurrent(mock) {
  let engine = null; let cursor = null; const aiState = new Map();
  return {
    async sync({ reload }) {
      if (reload || !engine) engine = GS.createGmailSync({ request: mock.request, sleep: async (ms) => { mock.setNow(mock.now() + ms); mock.waitedMs = (mock.waitedMs || 0) + ms; }, now: () => mock.now(), random: () => 0.5 });
      const t0 = process.hrtime.bigint();
      const r = await engine.sync(currentPlan(cursor));
      cursor = r.cursor;
      const pool = new Map(); [...r.historyExtras, ...Object.values(r.pools).flat()].forEach((m) => { if (m?.id) pool.set(m.id, m); });
      const list = [...pool.values()];
      const ai = currentAi(list, aiState, mock.now());
      const cpuMs = Number(process.hrtime.bigint() - t0) / 1e6;
      return { report: r.report, pool: list, ai, cpuMs };
    },
    predictions(pool) { const p = new Map(); pool.forEach((m) => p.set(m.id, predictCurrent(m))); return p; }
  };
}
function makeOptimised(mock, accountId, cache, cfgOver) {
  const config = CFG.resolve(cfgOver || {});
  const engine = GS.createGmailSync({ request: mock.request, sleep: async (ms) => { mock.setNow(mock.now() + ms); mock.waitedMs = (mock.waitedMs || 0) + ms; }, now: () => mock.now(), random: () => 0.5 });
  const pipe = PL.createMailPipeline({ engine, cache, rules: R, config, batch: BT, batchSend: mock.batchSend, derive, now: () => mock.now(), fullFields: GS.FULL_FIELDS });
  const budget = AB.createAiBudget({ cache, config, now: () => mock.now() });
  return {
    pipe, config,
    async sync({ label, aiEnabled = true }) {
      const t0 = process.hrtime.bigint();
      const r = await pipe.run({ accountId, label: label || 'manual', aiEnabled, allowFinancial: false });
      let inTok = 0, outTok = 0;
      const ai = await pipe.runAi({
        accountId, candidates: r.aiCandidates, budget, newCount: r.report.pipeline.newMessages, aiEnabled, allowFinancial: false,
        analyse: async (c) => { const cl = AB.cleanForAi(c.text, config.ai.maxChars); const it = SYS_TOK + 120 + AB.estimateTokens(cl.text); inTok += it; outTok += NEW_OUT_TOK; return { ok: true, value: null, usage: { inputTokens: it, outputTokens: NEW_OUT_TOK, model: config.ai.model } }; }
      });
      const cpuMs = Number(process.hrtime.bigint() - t0) / 1e6;
      return { report: r.report, r, ai: { calls: ai.sent, deferred: ai.deferred, inTok, outTok, usd: usd(inTok, outTok) }, cpuMs };
    },
    /** Keep syncing (no new mail) until the one-time body/AI backlog from the backfill is empty. Returns the runs. */
    async drain(max) {
      const runs = [];
      for (let i = 0; i < (max || 20); i++) {
        const rows = await cache.all(accountId);
        if (!rows.some((r) => r.status === 'body-queued' || r.status === 'meta-pending')) break; // AI backlog drains only as new mail adds credits
        mock.setNow(mock.now() + 5 * 60000);
        const s0 = snap(mock); const run = await this.sync({ label: 'manual' }); runs.push({ d: delta(s0, snap(mock)), ai: run.ai, cpuMs: run.cpuMs });
      }
      return runs;
    },
    async predictions() { const rows = await cache.all(accountId); const p = new Map(); rows.filter((x) => x.status !== 'deleted').forEach((x) => p.set(x.messageId, x.category)); return p; }
  };
}

// ---- measurement helpers ----
const http = (s) => s.calls - s.batchParts + s.batchPosts; // a batch POST is one HTTP request carrying N charged parts
function snap(mock) { return JSON.parse(JSON.stringify(mock.stats)); }
function delta(a, b) { const d = { calls: b.calls - a.calls, units: b.units - a.units, batchPosts: b.batchPosts - a.batchPosts, batchParts: b.batchParts - a.batchParts, bodies: b.bodiesServed - a.bodiesServed, byKind: {} }; Object.keys(b.byKind).forEach((k) => { d.byKind[k] = (b.byKind[k] || 0) - (a.byKind[k] || 0); }); d.http = d.calls - d.batchParts + d.batchPosts; return d; }
const LAT = 90, CONC = 6; // modelled network: 90 ms per HTTP round trip, 6 in parallel (same as the engine's pool)
const modelledMs = (d) => Math.ceil(d.http / CONC) * LAT;
function addUp(list) { const o = { http: 0, units: 0, bodies: 0, getMeta: 0, getFull: 0, list: 0, history: 0, threadsGet: 0, batchPosts: 0, aiCalls: 0, aiInTok: 0, aiOutTok: 0, usd: 0, cpuMs: 0, netMs: 0 }; list.forEach((x) => { o.http += x.d.http; o.units += x.d.units; o.bodies += x.d.bodies; o.getMeta += x.d.byKind.getMeta || 0; o.getFull += x.d.byKind.getFull || 0; o.list += x.d.byKind.list || 0; o.history += x.d.byKind.history || 0; o.threadsGet += x.d.byKind.threadsGet || 0; o.batchPosts += x.d.batchPosts; o.aiCalls += x.ai.calls; o.aiInTok += x.ai.inTok; o.aiOutTok += x.ai.outTok; o.usd += x.ai.usd; o.cpuMs += x.cpuMs; o.netMs += modelledMs(x.d); }); o.usd = +o.usd.toFixed(5); o.cpuMs = Math.round(o.cpuMs); return o; }

function prf(truth, pred, ids) {
  const per = {}; CATEGORIES.forEach((c) => { per[c] = { tp: 0, fp: 0, fn: 0, support: 0 }; });
  const confusion = {};
  ids.forEach((id) => {
    const t = truth.get(id); if (!t) return;
    const p = pred.get(id) || 'unseen';
    per[t].support++;
    confusion[t] = confusion[t] || {}; confusion[t][p] = (confusion[t][p] || 0) + 1;
    if (p === t) per[t].tp++; else { per[t].fn++; if (per[p]) per[p].fp++; }
  });
  Object.values(per).forEach((v) => { v.precision = v.tp + v.fp ? +(v.tp / (v.tp + v.fp)).toFixed(3) : null; v.recall = v.support ? +(v.tp / v.support).toFixed(3) : null; });
  const correct = ids.filter((id) => truth.get(id) && pred.get(id) === truth.get(id)).length;
  return { per, confusion, accuracy: +(correct / ids.filter((id) => truth.get(id)).length).toFixed(3), seen: ids.filter((id) => pred.has(id)).length, total: ids.length };
}

// ---------------- scenarios ----------------
async function scenarioVolume(n, historical, set) {
  const out = {};
  for (const side of ['current', 'optimised']) {
    const mock = createMockGmail({ now: NOW });
    const truth = seedMailbox(mock, set ? { recent: n, set } : { recent: n, spreadDays: 29, historical: historical || 0 });
    const s0 = snap(mock);
    let run, preds;
    if (side === 'current') { const c = makeCurrent(mock); run = await c.sync({ reload: true }); preds = c.predictions(run.pool); }
    let drainRuns = [];
    const dFirst = () => delta(s0, snap(mock));
    let d;
    if (side === 'optimised') { const cache = MC.createMailCache({ now: () => mock.now() }); const o = makeOptimised(mock, 'acct-1', cache); run = await o.sync({ label: 'connect' }); d = dFirst(); drainRuns = await o.drain(); preds = await o.predictions(); }
    else d = dFirst();
    const recentIds = [...truth.keys()].filter((id) => !id.includes('-h-'));
    out[side] = { cost: addUp([{ d, ai: run.ai, cpuMs: run.cpuMs }]), backfillTotal: addUp([{ d, ai: run.ai, cpuMs: run.cpuMs }, ...drainRuns]), drainSyncs: drainRuns.length, quality: prf(truth, preds, recentIds), seenOfRecent: recentIds.filter((id) => preds.has(id)).length, recent: recentIds.length, oldFetched: [...preds.keys()].filter((id) => id.includes('-h-')).length, summary: run.report.summary };
  }
  return out;
}
async function scenarioDay(reloadEachTime) {
  const out = {};
  for (const side of ['current', 'optimised']) {
    const mock = createMockGmail({ now: NOW - 14 * 3600000 });
    const truth = seedMailbox(mock, { recent: 200 });
    let c, o, cache;
    if (side === 'current') { c = makeCurrent(mock); await c.sync({ reload: true }); }
    else { cache = MC.createMailCache({ now: () => mock.now() }); o = makeOptimised(mock, 'acct-1', cache); await o.sync({ label: 'connect' }); await o.drain(); }
    const runs = [];
    const slots = [7, 10.5, 13.5, 17.5, 21.5];
    for (let i = 0; i < 5; i++) {
      mock.setNow(Date.UTC(2026, 10, 4, 0, 0) + slots[i] * 3600000);
      newMail(mock, truth, 8, 'd' + i, 3);
      const s0 = snap(mock);
      const run = side === 'current' ? await c.sync({ reload: reloadEachTime }) : await o.sync({ label: 'scheduled' });
      runs.push({ d: delta(s0, snap(mock)), ai: run.ai, cpuMs: run.cpuMs });
    }
    out[side] = { cost: addUp(runs), perSync: runs.map((r) => ({ http: r.d.http, units: r.d.units, bodies: r.d.bodies, ai: r.ai.calls })) };
  }
  return out;
}
async function scenarioRepeat(reloadEachTime) {
  const out = {};
  for (const side of ['current', 'optimised']) {
    const mock = createMockGmail({ now: NOW });
    seedMailbox(mock, { recent: 200 });
    let c, o;
    if (side === 'current') { c = makeCurrent(mock); await c.sync({ reload: true }); } else { o = makeOptimised(mock, 'a', MC.createMailCache({ now: () => mock.now() })); await o.sync({ label: 'connect' }); await o.drain(); }
    const runs = [];
    for (let i = 0; i < 5; i++) { mock.setNow(NOW + (i + 1) * 60000); const s0 = snap(mock); const run = side === 'current' ? await c.sync({ reload: reloadEachTime }) : await o.sync({ label: 'manual' }); runs.push({ d: delta(s0, snap(mock)), ai: run.ai, cpuMs: run.cpuMs }); }
    out[side] = { cost: addUp(runs), perSync: runs.map((r) => ({ http: r.d.http, units: r.d.units, bodies: r.d.bodies, ai: r.ai.calls })) };
  }
  return out;
}
async function scenarioMutation(kind) {
  const out = {};
  for (const side of ['current', 'optimised']) {
    const mock = createMockGmail({ now: NOW });
    const truth = seedMailbox(mock, { recent: 200 });
    let c, o, cache;
    if (side === 'current') { c = makeCurrent(mock); await c.sync({ reload: true }); } else { cache = MC.createMailCache({ now: () => mock.now() }); o = makeOptimised(mock, 'a', cache); await o.sync({ label: 'connect' }); await o.drain(); }
    const ids = [...truth.keys()];
    const finIds = ids.filter((id) => ['bill', 'payment'].includes(truth.get(id))).slice(0, 2);
    if (kind === 'labels') ids.slice(0, 30).forEach((id, i) => mock.relabel(id, i % 2 ? ['STARRED'] : [], i % 2 ? [] : ['UNREAD', 'INBOX']));
    if (kind === 'deletions') [...finIds, ...ids.filter((id) => !finIds.includes(id)).slice(5, 13)].forEach((id) => mock.remove(id));
    if (kind === 'expired') { mock.expireHistory(); newMail(mock, truth, 10, 'x', 2); ids.slice(40, 46).forEach((id) => mock.remove(id)); }
    mock.setNow(NOW + 3600000);
    const s0 = snap(mock);
    const run = side === 'current' ? await c.sync({ reload: true }) : await o.sync({ label: 'open-refresh' });
    const d = delta(s0, snap(mock));
    const res = { cost: addUp([{ d, ai: run.ai, cpuMs: run.cpuMs }]), summary: run.report.summary, mode: run.report.history?.mode || run.report.pipeline?.mode };
    if (side === 'optimised') {
      const rows = await cache.all('a');
      res.markedDeleted = rows.filter((r) => r.status === 'deleted').length;
      const facts = await cache.allFacts('a');
      res.financialFactsKept = finIds.filter((id) => facts.some((f) => f.messageId === id)).length;
      res.labelOnlyUpdates = run.report.pipeline.labelOnly;
      if (kind === 'labels') { const byId = new Map(rows.map((r) => [r.messageId, r])); res.labelsCorrect = ids.slice(0, 30).filter((id) => JSON.stringify((byId.get(id)?.labels || []).slice().sort()) === JSON.stringify(mock.msgs.get(id).labelIds.slice().sort())).length; }
      if (kind === 'expired') res.newFound = [...truth.keys()].filter((id) => id.includes('-x-')).filter((id) => rows.some((r) => r.messageId === id)).length;
    }
    out[side] = res;
  }
  return out;
}
async function scenarioAccounts() {
  const out = {};
  for (const side of ['current', 'optimised']) {
    const runs = []; let isolation = null;
    const cache = MC.createMailCache({ now: () => NOW });
    const mocks = [0, 1, 2].map((i) => { const m = createMockGmail({ now: NOW, email: `user${i}@example.com` }); seedMailbox(m, { recent: 200, tag: 'a' + i }); return m; });
    const sides = mocks.map((m, i) => (side === 'current' ? makeCurrent(m) : makeOptimised(m, 'acct-' + i, cache)));
    const drains = [];
    for (let round = 0; round < 2; round++) for (let i = 0; i < 3; i++) {
      const m = mocks[i]; m.setNow(NOW + round * 3 * 3600000); if (round) newMail(m, new Map(), 6, 'q' + i, 2);
      const s0 = snap(m); const run = side === 'current' ? await sides[i].sync({ reload: true }) : await sides[i].sync({ label: round ? 'scheduled' : 'connect' });
      runs.push({ d: delta(s0, snap(m)), ai: run.ai, cpuMs: run.cpuMs });
      if (side === 'optimised' && !round) (await sides[i].drain()).forEach((x) => drains.push(x));
    }
    if (side === 'optimised') {
      const rows = await Promise.all([0, 1, 2].map((i) => cache.all('acct-' + i)));
      isolation = { rowsPerAccount: rows.map((r) => r.length), crossAccountRows: rows.reduce((n, r, i) => n + r.filter((x) => !x.messageId.includes('-a' + i + '-') && !x.messageId.includes('-q' + i + '-')).length, 0) };
    }
    out[side] = { cost: addUp(runs), backlogDrain: drains.length ? addUp(drains) : null, isolation };
  }
  return out;
}
async function scenarioFailures() {
  // quota/server failures inside batches: nothing lost, retried on the single-request path; transport failure → fallback
  const mock = createMockGmail({ now: NOW });
  const truth = seedMailbox(mock, { recent: 200 });
  mock.setFailure(0.15, ['getMeta', 'getFull']);
  const cache = MC.createMailCache({ now: () => mock.now() });
  const o = makeOptimised(mock, 'a', cache);
  const run = await o.sync({ label: 'connect' });
  mock.setFailure(0);
  const rows = await cache.all('a');
  const mock2 = createMockGmail({ now: NOW, batchTransportFails: true });
  seedMailbox(mock2, { recent: 200 });
  const cache2 = MC.createMailCache({ now: () => mock2.now() });
  const o2 = makeOptimised(mock2, 'b', cache2);
  const run2 = await o2.sync({ label: 'connect' });
  const rows2 = await cache2.all('b');
  return {
    injected429: mock.stats.failuresInjected, recordsKept: rows.length, expected: truth.size, failed: run.report.records.failed, deferred: run.report.records.deferred, summary: run.report.summary,
    transportFallback: { batchFallbacks: run2.report.pipeline.counters.batchFallback || 0, recordsKept: rows2.length, summary: run2.report.summary }
  };
}

(async () => {
  const t0 = Date.now();
  const report = { generatedAt: new Date().toISOString(), note: 'SYNTHETIC/MOCKED Gmail only. Quota units = what the mock charges with Google\'s 2026 unit table. AI cost uses the config price table (gemini-3.5-flash-lite $0.10/$0.40 per 1M tokens; free tier = $0 actual). Network time is modelled (90 ms per HTTP request, 6 in parallel).', assumptions: { aiOn: true, allowFinancialToAi: false, currentEachSyncIsAPageLoad: 'yes unless noted (the Phase 1 cache is memory-only)', aiOutputTokens: { current: CUR_OUT_TOK, optimised: NEW_OUT_TOK }, classificationIsRulesOnly: true } };
  const vols = QUICK ? [100] : [100, 500, 1000];
  report.volume = {};
  for (const n of vols) { report.volume[n] = await scenarioVolume(n); console.log('volume', n, 'done'); }
  report.historical5000 = await scenarioVolume(100, QUICK ? 1000 : 5000); console.log('historical done');
  report.quality200 = report.volume[100] ? null : null;
  report.day5_reload = await scenarioDay(true);
  report.day5_sameTab = await scenarioDay(false);
  report.repeat_reload = await scenarioRepeat(true);
  report.repeat_sameTab = await scenarioRepeat(false);
  report.labels = await scenarioMutation('labels');
  report.deletions = await scenarioMutation('deletions');
  report.expired = await scenarioMutation('expired');
  report.accounts = await scenarioAccounts();
  report.failures = await scenarioFailures();
  // the labelled 200-email set itself (one copy of each fixture)
  report.quality = await scenarioVolume(200);
  const HOLD = require('./fixtures/mail-holdout.js').MAIL;
  report.holdout = await scenarioVolume(HOLD.length, 0, HOLD);
  const blindFile = path.join(__dirname, 'gmail-holdout-blind-result.json');
  if (!fs.existsSync(blindFile)) fs.writeFileSync(blindFile, JSON.stringify({ note: 'FIRST (blind) run of the hold-out set — written once, never overwritten', at: new Date().toISOString(), current: report.holdout.current.quality, optimised: report.holdout.optimised.quality }, null, 2));
  report.holdoutBlind = JSON.parse(fs.readFileSync(blindFile, 'utf8'));
  report.durationMs = Date.now() - t0;
  // critical recall check
  const q = report.quality;
  report.criticalRecall = Object.fromEntries(CRITICAL.map((c) => [c, { current: q.current.quality.per[c].recall, optimised: q.optimised.quality.per[c].recall, ok: q.optimised.quality.per[c].recall >= q.current.quality.per[c].recall }]));
  const big = report.volume[vols[vols.length - 1]];
  report.criticalRecallAtVolume = Object.fromEntries(CRITICAL.map((c) => [c, { current: big.current.quality.per[c].recall, optimised: big.optimised.quality.per[c].recall, ok: big.optimised.quality.per[c].recall >= big.current.quality.per[c].recall }]));
  fs.writeFileSync(path.join(__dirname, 'gmail-cost-bench-report.json'), JSON.stringify(report, null, 2));
  const line = (name, a, b) => console.log(`${name.padEnd(28)} units ${String(a.units).padStart(7)} → ${String(b.units).padStart(6)} | http ${String(a.http).padStart(5)} → ${String(b.http).padStart(4)} | bodies ${String(a.bodies).padStart(5)} → ${String(b.bodies).padStart(4)} | AI ${String(a.aiCalls).padStart(3)} → ${String(b.aiCalls).padStart(3)}`);
  vols.forEach((n) => line(`${n} new (cold)`, report.volume[n].current.cost, report.volume[n].optimised.cost));
  vols.forEach((n) => line(`${n} new (backfill total)`, report.volume[n].current.cost, report.volume[n].optimised.backfillTotal));
  line('5000 historical + 100', report.historical5000.current.cost, report.historical5000.optimised.cost);
  line('5 syncs/day (reloads)', report.day5_reload.current.cost, report.day5_reload.optimised.cost);
  line('5 syncs/day (same tab)', report.day5_sameTab.current.cost, report.day5_sameTab.optimised.cost);
  line('5 refreshes, no mail (rel.)', report.repeat_reload.current.cost, report.repeat_reload.optimised.cost);
  line('5 refreshes, no mail (tab)', report.repeat_sameTab.current.cost, report.repeat_sameTab.optimised.cost);
  line('label changes', report.labels.current.cost, report.labels.optimised.cost);
  line('deletions', report.deletions.current.cost, report.deletions.optimised.cost);
  line('expired checkpoint', report.expired.current.cost, report.expired.optimised.cost);
  line('3 accounts × 2 syncs', report.accounts.current.cost, report.accounts.optimised.cost);
  console.log('quality (200 labelled): accuracy', q.current.quality.accuracy, '→', q.optimised.quality.accuracy, '| seen', q.current.seenOfRecent, '→', q.optimised.seenOfRecent, 'of', q.optimised.recent);
  console.log('hold-out (60, blind first run): accuracy', report.holdoutBlind.current.accuracy, '→', report.holdoutBlind.optimised.accuracy);
  console.log('critical recall (200):', JSON.stringify(report.criticalRecall));
  console.log('critical recall (volume):', JSON.stringify(report.criticalRecallAtVolume));
  console.log('failures:', JSON.stringify(report.failures));
  const hq = report.holdout;
  report.criticalRecallHoldout = Object.fromEntries(CRITICAL.map((c) => [c, { current: hq.current.quality.per[c].recall, optimised: hq.optimised.quality.per[c].recall, ok: hq.optimised.quality.per[c].recall >= hq.current.quality.per[c].recall }]));
  console.log('critical recall (hold-out):', JSON.stringify(report.criticalRecallHoldout));
  const okAll = [report.criticalRecall, report.criticalRecallAtVolume, report.criticalRecallHoldout].every((g) => Object.values(g).every((x) => x.ok));
  console.log(okAll ? 'CRITICAL RECALL: no drop' : 'CRITICAL RECALL: DROP — adjust thresholds');
  if (!okAll) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
