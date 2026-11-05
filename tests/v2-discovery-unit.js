/**
 * V2 Phase B unit checks for Gmail discovery: category coverage, duplicate prevention, incremental sync,
 * expired-history recovery, pagination, retries and the "nothing silently skipped" rule.
 * SYNTHETIC data, mock Gmail with Google's unit table. Run: node tests/v2-discovery-unit.js
 */
'use strict';
const path = require('path');
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
const DAY = 86400000, H = 3600000, NOW = Date.UTC(2026, 10, 5, 7, 0, 0);

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || info === undefined ? '' : '  ← ' + JSON.stringify(info))); };
const asMock = (m, at) => ({ id: m.id, threadId: m.threadId, from: m.from, subject: m.subject, snippet: m.snippet, body: m.body, html: m.html, labelIds: m.labelIds.slice(), listUnsubscribe: m.listUnsubscribe, attachments: m.attachments, internalDate: at });

function setup(opts) {
  const o = opts || {};
  const mock = createMockGmail({ now: NOW, extraHeaders: 2 });
  const config = CFG.resolve(o.config || {});
  const cache = MC.createMailCache({ now: () => mock.now() });
  const engine = GS.createGmailSync({ request: mock.request, sleep: async (ms) => mock.setNow(mock.now() + ms), now: () => mock.now(), random: () => 0.5 });
  const pipe = PL.createMailPipeline({ engine, cache, rules: R, config, batch: BT, batchSend: mock.batchSend, now: () => mock.now(), fullFields: GS.FULL_FIELDS });
  const run = async (label) => { const k0 = JSON.parse(JSON.stringify(mock.stats.byKind)), u0 = mock.stats.units; const r = await pipe.run({ accountId: 'a', label: label || 'slot', aiEnabled: false }); const d = {}; Object.keys(mock.stats.byKind).forEach((k) => { d[k] = mock.stats.byKind[k] - (k0[k] || 0); }); return { r, d, units: mock.stats.units - u0 }; };
  return { mock, cache, pipe, run, config };
}

(async () => {
  // ---------- 1. configuration: no category is excluded ----------
  const cfg = CFG.resolve({});
  ok('no Gmail category is excluded by default', (cfg.pipeline.excludeLabels || []).length === 0);
  ok('discovery covers Updates, Promotions, Social and Forums', ['CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].every((l) => cfg.pipeline.discovery.nonPrimaryLabels.includes(l)) && cfg.pipeline.discovery.mode === 'candidates');

  // ---------- 2. category coverage on connect ----------
  {
    const { mock, cache, run } = setup();
    MAIL.forEach((m) => mock.add(asMock(m, NOW - (m.ageDays + 1) * DAY)));
    const { r } = await run('connect');
    const rows = new Map((await cache.all('a')).map((x) => [x.messageId, x]));
    const imp = MAIL.filter((m) => m.important);
    const reached = (m) => { const x = rows.get(m.id); return x && x.status !== 'skipped'; };
    for (const cat of ['primary', 'updates', 'promotions', 'social', 'forums']) {
      const list = imp.filter((m) => m.cat === cat);
      ok(`connect: every important ${cat} email reaches Daylight (${list.length})`, list.every(reached), list.filter((m) => !reached(m)).map((m) => m.subject));
    }
    const disc = r.report.discovery;
    ok('report shows discovered / metadata / bodies / skipped and per-category counts', disc && disc.discovered === MAIL.length && disc.metadataFetched > 0 && disc.skipped > 0 && ['primary', 'updates', 'promotions', 'social', 'forums'].every((c) => disc.byCategory[c] && disc.byCategory[c].discovered > 0), disc && disc.byCategory);
    ok('report counts quota units per operation', disc && disc.unitsByKind && Object.values(disc.unitsByKind).reduce((a, b) => a + b, 0) === r.report.units, disc && disc.unitsByKind);
    ok('every discovered message is accounted for (fetched or remembered as skipped)', MAIL.every((m) => rows.has(m.id)));
    const skipped = [...rows.values()].filter((x) => x.status === 'skipped');
    ok('skipped messages keep no content (no subject, sender or snippet)', skipped.every((x) => !x.subject && !x.from && !x.snippet));
    ok('skipped messages never appear in the app pools', !Object.values(r.pools).flat().some((m) => skipped.some((x) => x.messageId === m.id)));

    // ---------- 3. duplicate prevention ----------
    const metaIds = mock.stats.byKind.getMeta || 0;
    ok('each message gets at most one metadata call even when several searches match it', metaIds === [...rows.values()].filter((x) => x.status !== 'skipped').length, { metaIds });
    const again = await run('slot');
    ok('a repeat sync with no new mail fetches nothing (profile only)', !again.d.getMeta && !again.d.getFull && !again.d.list && again.units <= 5, again.d);

    // ---------- 4. incremental sync via History API ----------
    mock.setNow(mock.now() + 3 * H);
    const fresh = [
      { id: 'n1', threadId: 'tn1', from: 'Alza.cz <objednavky@alza.cz>', subject: 'Objednávka odeslána', snippet: 'Vaše objednávka 448900 byla odeslána', body: 'Vaše objednávka 448900 byla odeslána. Doručení zítra. Celkem 499 Kč.', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS', 'UNREAD'], listUnsubscribe: true, attachments: [], internalDate: mock.now() - H },
      { id: 'n2', threadId: 'tn2', from: 'Zalando <news@zalando.cz>', subject: 'Flash sale tonight', snippet: 'Up to 60 % off', body: 'Up to 60 % off. Unsubscribe.', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS', 'UNREAD'], listUnsubscribe: true, attachments: [], internalDate: mock.now() - H },
      { id: 'n3', threadId: 'tn3', from: 'Anita Sharma <anita.sharma@gmail.com>', subject: 'Dinner?', snippet: 'Are you free tonight?', body: 'Are you free tonight?', labelIds: ['INBOX', 'CATEGORY_PERSONAL', 'UNREAD'], attachments: [], internalDate: mock.now() - H }
    ];
    fresh.forEach((m) => mock.add(m));
    const inc = await run('slot');
    ok('incremental sync reads the History API (no 30-day re-scan)', inc.r.report.pipeline.mode === 'incremental' && inc.d.history >= 1 && inc.r.report.discovery.discovered === 3, { mode: inc.r.report.pipeline.mode, d: inc.d });
    const rows2 = new Map((await cache.all('a')).map((x) => [x.messageId, x]));
    ok('incremental: Promotions order email found, Promotions sale skipped, Primary mail fetched', rows2.get('n1').status !== 'skipped' && rows2.get('n2').status === 'skipped' && rows2.get('n3').status !== 'skipped', { n1: rows2.get('n1').status, n2: rows2.get('n2').status, n3: rows2.get('n3').status });
    ok('incremental: metadata only for the 2 candidates', (inc.d.getMeta || 0) === 2, inc.d);
    const cp = await cache.getCheckpoint('a');
    ok('checkpoint historyId advances after a successful sync', String(cp.historyId) === String(mock.historyId()));

    // ---------- 5. expired history → bounded recovery ----------
    mock.add({ id: 'n4', threadId: 'tn4', from: 'ČEZ Prodej <faktury@cez.cz>', subject: 'Vyúčtování', snippet: 'Částka k úhradě 980 Kč', body: 'Částka k úhradě 980 Kč, splatnost 30. 11. 2026.', labelIds: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'], attachments: [], internalDate: mock.now() });
    mock.expireHistory();
    mock.setNow(mock.now() + H);
    const rec = await run('slot');
    const cachedBefore = rows2.size;
    ok('expired historyId → recovery mode, not a full re-download', /recovery$/.test(rec.r.report.pipeline.mode) && (rec.d.getMeta || 0) <= 2 && (rec.d.getMeta || 0) < cachedBefore / 10, { mode: rec.r.report.pipeline.mode, d: rec.d });
    const rows3 = new Map((await cache.all('a')).map((x) => [x.messageId, x]));
    ok('recovery still finds the new bill in Updates', rows3.get('n4') && rows3.get('n4').status !== 'skipped', rows3.get('n4') && rows3.get('n4').status);
  }

  // ---------- 6. pagination and retries ----------
  {
    const { mock, cache, run } = setup();
    for (let i = 0; i < 1200; i++) mock.add({ id: 'bulk' + i, threadId: 'tb' + i, from: 'Shop <news@shop.test>', subject: 'Offer ' + i, snippet: 'Offer', body: 'Offer of the day. Unsubscribe.', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], listUnsubscribe: true, attachments: [], internalDate: NOW - (i % 25) * DAY - H });
    MAIL.filter((m) => m.important).forEach((m) => mock.add(asMock(m, NOW - (m.ageDays + 1) * DAY)));
    mock.setFailure(0.15, ['getMeta']);
    const first = await run('connect');
    mock.setFailure(0);
    for (let i = 0; i < 4; i++) { const rows = await cache.all('a'); if (!rows.some((x) => x.status === 'meta-pending' || x.status === 'body-queued')) break; mock.setNow(mock.now() + 10 * 60000); await run('drain'); }
    const rows = new Map((await cache.all('a')).map((x) => [x.messageId, x]));
    ok('pagination: all 1,200+ listed IDs are accounted for (more than one list page)', first.r.report.discovery.discovered >= 1200 && (first.d.list || 0) >= 3, { discovered: first.r.report.discovery.discovered, lists: first.d.list });
    ok('bulk Promotions noise is skipped, not metadata-fetched', [...rows.values()].filter((x) => /^bulk/.test(x.messageId) && x.status !== 'skipped').length === 0);
    ok('rate-limit failures are retried; no important email is lost', MAIL.filter((m) => m.important).every((m) => rows.get(m.id) && !['skipped', 'meta-pending'].includes(rows.get(m.id).status)), MAIL.filter((m) => m.important && (!rows.get(m.id) || ['skipped', 'meta-pending'].includes(rows.get(m.id).status))).map((m) => m.subject));
  }

  console.log(`V2 discovery unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})();
