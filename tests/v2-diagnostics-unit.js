/** Intelligence Diagnostics: counts are real, problems are detected, the redacted report leaks no content. Node only. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const IG = require(path.join(ROOT, 'graph/item-graph.js')); global.DaylightItemGraph = IG;
const D = require(path.join(ROOT, 'ui/v2-diagnostics.js'));
const S = require(path.join(ROOT, 'ui/v2-sample.js'));
const M = require(path.join(ROOT, 'ui/v2-model.js'));
let pass = 0, fail = 0; const ok = (n, c, i) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (i !== undefined ? '  ← ' + JSON.stringify(i).slice(0, 300) : '')); } };
const NOW = new Date(2026, 10, 5, 10).getTime();
(async () => {
  const g = IG.createGraph({ backend: 'memory', now: () => NOW });
  const { items: parts, links } = S.build(NOW); await g.upsertMany(parts); await g.linkMany(links, 'sample');
  let items = await g.query();
  const a = D.analyse({ items, links: await g.links(), actions: [], rules: [], now: NOW });
  const emails = items.filter((x) => x.type === 'email');
  ok('counts every email and type exactly once', a.classification.emails === emails.length && Object.values(a.classification.types).reduce((s, v) => s + v, 0) === emails.length);
  ok('bill extraction coverage is measured from facts', a.extraction.bill.amount.of === items.filter((x) => x.type === 'bill').length && a.extraction.bill.amount.pct === 100);
  ok('clean sample: no provenance problems', !a.provenance.noSource.length && !a.provenance.orphanFacts.length && a.provenance.brokenLinks === 0 && !a.provenance.derivedNoEvidence.length, a.provenance);
  // inject problems
  await g.upsertMany([
    { key: 'money:x:1', accountId: 'sample', type: 'bill', title: 'Dup A', dueAt: NOW, sources: [{ app: 'gmail', accountId: 'sample', itemId: 'zz1' }], extractedFacts: [{ key: 'amount', value: 100, sourceItemId: 'it_gone' }, { key: 'merchant', value: 'Acme' }, { key: 'dueDate', value: { date: '2026-11-01' } }] },
    { key: 'money:x:2', accountId: 'sample', type: 'bill', title: 'Dup B', dueAt: NOW + 3600000, sources: [{ app: 'gmail', accountId: 'sample', itemId: 'zz2' }], extractedFacts: [{ key: 'amount', value: 100 }, { key: 'merchant', value: 'Acme' }] },
    { key: 'gmail:sample:t9', accountId: 'sample', type: 'email', title: 'Your receipt', sources: [{ app: 'gmail', accountId: 'sample', itemId: 't9' }], classification: { type: 'receipt', band: 'low' }, extractedEntities: { senderDomain: 'shop.test' } }
  ]);
  items = await g.query();
  const b = D.analyse({ items, links: [...(await g.links()), { from: 'it_x', to: 'it_y' }], actions: [{ kind: 'done', undone: false, writeBack: [{ status: 'local-only' }] }, { kind: 'snooze', undone: true, writeBack: [] }], rules: [], now: NOW });
  ok('detects a likely duplicate bill (same merchant + amount)', b.duplicates.some((d) => d.kind === 'money'));
  ok('detects malformed facts ({…} values)', b.extraction.badFacts.length === 1);
  ok('detects facts citing a missing email and derived items without their email', b.provenance.orphanFacts.length === 1 && b.provenance.derivedNoEvidence.length >= 2);
  ok('detects broken links', b.provenance.brokenLinks === 1);
  ok('detects a money email that produced no money Item', b.extraction.moneyNoItem.length === 1);
  ok('actions: totals, undone, no pending writes', b.actions.total === 2 && b.actions.undone === 1 && b.actions.pendingWrites === 0);
  // labels
  const needs = M.needsYou(items, NOW).map((x) => x.item.id);
  const petra = emails.find((e) => /Slides/.test(e.title)), promo = emails.find((e) => /Black Friday/.test(e.title)), lab = emails.find((e) => /Lab booking/.test(e.title));
  const sc = D.scoreLabels(items, { [petra.id]: { ok: true, important: true }, [promo.id]: { ok: false, expected: 'receipt', important: false }, [lab.id]: { ok: true, important: true }, it_gone: { ok: true } }, needs);
  ok('labels: accuracy over existing Items only', sc.labelled === 3 && sc.correct === 2 && sc.accuracy === 66.7, sc);
  ok('labels: importance recall uses what Today really shows', sc.importance.markedImportant === 2 && sc.importance.recall === 100 && sc.importance.falseAlarms.length === 0, sc.importance);
  ok('labels: confusions listed', sc.confusions['marketing → receipt'] === 1);
  // redaction
  const rep = D.redactedReport({ analysis: b, score: sc, items, missed: [{ kind: 'bill', senderDomain: 'cez.cz', note: 'SECRET NOTE electricity', at: NOW }], now: NOW });
  const txt = JSON.stringify(rep);
  const leaks = items.filter((x) => x.type === 'email').map((x) => x.title).filter((t) => t && t.length > 6 && txt.includes(t));
  ok('redacted report contains no subjects', leaks.length === 0, leaks);
  ok('redacted report contains no names, amounts, references or notes', !/Petra|Nováková|1840|2026110|ABX42K|SECRET NOTE/.test(txt));
  ok('redacted report keeps sender domains and counts', /shop\.test/.test(txt) && rep.classification.emails === b.classification.emails && rep.missedReports[0].senderDomain === 'cez.cz');
  console.log(`V2 diagnostics unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
