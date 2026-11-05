/**
 * V2 Gmail discovery benchmark: important-email recall vs Gmail quota units, across ALL Gmail categories.
 * SYNTHETIC mailbox (tests/fixtures/mail-v2-categories.js). Never touches a real account.
 *
 * Strategies compared (same pipeline code, different config):
 *   excluded   — yesterday's build: Promotions/Social/Forums never fetched; metadata for every other new message
 *   all        — no exclusion; metadata for EVERY new message (maximum ingestion)
 *   candidates — V2: Primary + SENT always; other categories only via ID-only searches / transactional senders + daily net
 *
 * Scenario: connect (30-day backfill with 2/3 of the mailbox) → 8 incremental syncs over 4 days as the rest arrives
 * → one expired-history recovery. Quota units are charged by the mock with Google's unit table
 * (list 5 · get metadata 20 · get full 60 · history 2 · threads.list 10 · threads.get 40 · profile 1).
 *
 * Recall = share of important messages that reached Daylight (metadata fetched and classified).
 * Run: node tests/gmail-discovery-bench.js   → writes tests/gmail-discovery-report.json
 */
'use strict';
const fs = require('fs'), path = require('path');
global.window = globalThis;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'email-classify.js'));
const GS = require(path.join(ROOT, 'gmail-sync.js'));
const CFG = require(path.join(ROOT, 'gmail-config.js'));
const R = require(path.join(ROOT, 'gmail-rules.js'));
const MC = require(path.join(ROOT, 'gmail-cache.js'));
const BT = require(path.join(ROOT, 'gmail-batch.js'));
const PL = require(path.join(ROOT, 'gmail-pipeline.js'));
const { createMockGmail } = require('./mock-gmail.js');
const { MAIL } = require('./fixtures/mail-v2-categories.js');
const DAY = 86400000, H = 3600000;
const NOW = Date.UTC(2026, 10, 5, 7, 0, 0);

const STRATS = {
  excluded: { pipeline: { excludeLabels: ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'], discovery: { mode: 'all' } } },
  all: { pipeline: { excludeLabels: [], discovery: { mode: 'all' } } },
  candidates: { pipeline: { excludeLabels: [] } }
};

function deepMerge(a, b) { const o = Array.isArray(a) ? a.slice() : Object.assign({}, a); Object.entries(b || {}).forEach(([k, v]) => { o[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' ? deepMerge(a[k], v) : v; }); return o; }

async function runStrategy(name) {
  const mock = createMockGmail({ now: NOW - 4 * DAY, extraHeaders: 4 });
  const later = [], truth = new Map();
  MAIL.forEach((m, i) => {
    truth.set(m.id, m);
    const rec = { id: m.id, threadId: m.threadId, from: m.from, subject: m.subject, snippet: m.snippet, body: m.body, html: m.html, labelIds: m.labelIds.slice(), listUnsubscribe: m.listUnsubscribe, attachments: m.attachments };
    if (i % 3 === 2) later.push(rec); // a third arrives after connecting
    else mock.add(Object.assign(rec, { internalDate: mock.now() - (m.ageDays + 1) * DAY }));
  });
  for (let i = 0; i < 6; i++) mock.add({ id: 'sent-' + i, threadId: 'tv000' + (i + 1), from: 'Me <me@example.com>', to: 'x@example.com', subject: 'Re: ' + i, snippet: 'ok', body: 'ok', labelIds: ['SENT'], internalDate: mock.now() - i * DAY });

  const base = CFG.resolve({});
  const config = deepMerge(base, STRATS[name]);
  const cache = MC.createMailCache({ now: () => mock.now() });
  const engine = GS.createGmailSync({ request: mock.request, sleep: async (ms) => mock.setNow(mock.now() + ms), now: () => mock.now(), random: () => 0.5 });
  const pipe = PL.createMailPipeline({ engine, cache, rules: R, config, batch: BT, batchSend: mock.batchSend, now: () => mock.now(), fullFields: GS.FULL_FIELDS });
  const runs = [];
  const sync = async (label) => { const u0 = mock.stats.units, k0 = JSON.parse(JSON.stringify(mock.stats.byKind)); const r = await pipe.run({ accountId: 'a', label, aiEnabled: false }); const by = {}; Object.keys(mock.stats.byKind).forEach((k) => { by[k] = mock.stats.byKind[k] - (k0[k] || 0); }); runs.push({ label, units: mock.stats.units - u0, byKind: by, discovery: r.report.discovery }); return r; };

  await sync('connect');
  for (let i = 0; i < 6; i++) { mock.setNow(mock.now() + 5 * 60000); const rows = await cache.all('a'); if (!rows.some((r) => r.status === 'body-queued' || r.status === 'meta-pending')) break; await sync('drain'); }
  for (let s = 0; s < 8; s++) { // 8 slot syncs over 4 days, new mail arriving between them
    mock.setNow(mock.now() + 12 * H);
    later.splice(0, Math.ceil(later.length / (8 - s))).forEach((m) => mock.add(Object.assign(m, { internalDate: mock.now() - 2 * H })));
    await sync('slot');
  }
  mock.add({ id: 'late-1', threadId: 'tlate1', from: 'Lidl <news@lidl.cz>', subject: 'New offers', snippet: 'Offers', body: 'Offers this week. Unsubscribe.', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], listUnsubscribe: true, attachments: [], internalDate: mock.now() });
  mock.expireHistory && mock.expireHistory();
  mock.setNow(mock.now() + 6 * H);
  await sync('recovery');
  for (let i = 0; i < 4; i++) { const rows = await cache.all('a'); if (!rows.some((r) => r.status === 'body-queued')) break; mock.setNow(mock.now() + 5 * 60000); await sync('drain'); }

  const rows = new Map((await cache.all('a')).map((r) => [r.messageId, r]));
  const imp = MAIL.filter((m) => m.important);
  const reached = imp.filter((m) => { const r = rows.get(m.id); return r && r.status !== 'skipped' && r.status !== 'meta-pending' && r.status !== 'deleted'; });
  const byCat = {};
  imp.forEach((m) => { byCat[m.cat] = byCat[m.cat] || { important: 0, reached: 0 }; byCat[m.cat].important++; if (reached.includes(m)) byCat[m.cat].reached++; });
  const missed = imp.filter((m) => !reached.includes(m)).map((m) => `${m.cat}: ${m.subject}`);
  const noise = MAIL.filter((m) => !m.important);
  const noiseFetched = noise.filter((m) => { const r = rows.get(m.id); return r && r.status !== 'skipped'; }).length;
  const NOISE = new Set(['promotion', 'newsletter', 'social']);
  const impTyped = reached.filter((m) => !NOISE.has(rows.get(m.id).category)).length;           // important AND not labelled as marketing
  const noiseRows = noise.map((m) => rows.get(m.id)).filter((r) => r && r.status !== 'skipped');
  const noiseAsNoise = noiseRows.filter((r) => NOISE.has(r.category) || r.category === 'other').length; // fetched noise correctly kept out
  const units = runs.reduce((a, r) => a + r.units, 0);
  const kinds = {}; runs.forEach((r) => Object.entries(r.byKind).forEach(([k, v]) => { kinds[k] = (kinds[k] || 0) + v; }));
  return {
    strategy: name, units, kinds, recall: +(reached.length / imp.length).toFixed(3), important: imp.length, reached: reached.length,
    classification: { misTyped: reached.filter((m) => NOISE.has(rows.get(m.id).category)).map((m) => `${m.cat}: ${m.subject} → ${rows.get(m.id).category} (${rows.get(m.id).ruleReason}; body ${!!rows.get(m.id).bodyFetched})`), noiseAsImportant: noise.filter((m) => { const r = rows.get(m.id); return r && r.status !== 'skipped' && !(NOISE.has(r.category) || r.category === 'other'); }).map((m) => `${m.cat}: ${m.subject} → ${rows.get(m.id).category}/${rows.get(m.id).status}/${(rows.get(m.id).labels||[]).join(',')}`).slice(0, 4), importantReachedNotMarketing: impTyped, importantReached: reached.length, noiseFetchedKeptOut: noiseAsNoise, noiseFetched: noiseRows.length },
    byCategory: byCat, missed, noiseMetadataFetched: noiseFetched, noiseTotal: noise.length,
    importantPer1000Units: +((reached.length / units) * 1000).toFixed(2),
    runs: runs.map((r) => ({ label: r.label, units: r.units, metadata: r.byKind.getMeta || 0, bodies: r.byKind.getFull || 0, lists: r.byKind.list || 0, discovery: r.discovery && { discovered: r.discovery.discovered, metadataFetched: r.discovery.metadataFetched, skipped: r.discovery.skipped, byCategory: r.discovery.byCategory, recoveryNet: r.discovery.recoveryNet } }))
  };
}

(async () => {
  const out = {};
  for (const s of Object.keys(STRATS)) out[s] = await runStrategy(s);
  const line = (r) => `${r.strategy.padEnd(11)} recall ${String(Math.round(r.recall * 100)).padStart(3)}% (${r.reached}/${r.important})  units ${String(r.units).padStart(6)}  metadata ${String(r.kinds.getMeta || 0).padStart(4)}  bodies ${String(r.kinds.getFull || 0).padStart(3)}  lists ${String(r.kinds.list || 0).padStart(3)}  noise fetched ${r.noiseMetadataFetched}/${r.noiseTotal}  important/1k units ${r.importantPer1000Units}`;
  Object.values(out).forEach((r) => console.log(line(r)));
  Object.values(out).forEach((r) => { if (r.missed.length) console.log(`  ${r.strategy} missed: ${r.missed.join(' | ')}`); });
  const c = out.candidates, a = out.all, e = out.excluded;
  const checks = [
    ['candidates finds every important email in Promotions', c.byCategory.promotions.reached === c.byCategory.promotions.important],
    ['candidates recall ≥ 95 %', c.recall >= 0.95],
    ['candidates recall ≥ excluded recall', c.recall >= e.recall],
    ['candidates uses fewer units than fetching everything', c.units < a.units],
    ['candidates fetches far less noise than "all"', c.noiseMetadataFetched < a.noiseMetadataFetched / 2],
    ['excluded build misses Promotions receipts (the old blind spot)', e.byCategory.promotions.reached === 0],
    ['candidates: every important email reached is typed as important (not promotion/newsletter/social)', c.classification.importantReachedNotMarketing === c.reached],
    ['candidates: no noise email is typed as important', c.classification.noiseAsImportant.length === 0]
  ];
  let fail = 0; checks.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fail++; });
  out.summary = { savingVsAll: +(1 - c.units / a.units).toFixed(3), recallGainVsExcluded: +(c.recall - e.recall).toFixed(3), checks: checks.map(([n, ok]) => ({ n, ok })) };
  fs.writeFileSync(path.join(__dirname, 'gmail-discovery-report.json'), JSON.stringify(out, null, 2));
  console.log(`Discovery bench: ${checks.length - fail}/${checks.length} checks passed · candidates uses ${Math.round(out.summary.savingVsAll * 100)} % fewer units than fetching everything`);
  process.exitCode = fail ? 1 : 0;
})();
