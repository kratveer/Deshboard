/**
 * Daylight Intelligence Diagnostics (developer view) — pure analysis of the Item Graph, plus real-mail validation labels.
 * analyse() never invents numbers: every figure is counted from stored Items, links, actions, rules and sync metrics.
 * redactedReport() is what an external tester sends back: counts, rates and sender domains only — no subjects, snippets or amounts.
 */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const fact = (it, k) => (it.extractedFacts || []).find((f) => f.key === k && f.value != null && f.value !== '');
  const isPrim = (v) => v == null || ['string', 'number', 'boolean'].includes(typeof v);
  const ctype = (it) => (it.classification && it.classification.type) || null;

  function analyse(input) {
    const items = input.items || [], links = input.links || [], actions = input.actions || [], rules = input.rules || [];
    const now = input.now || Date.now();
    const byId = new Map(items.map((x) => [x.id, x]));
    const by = (t) => items.filter((x) => x.type === t);
    const emails = by('email');
    // ---- classification ----
    const types = {}, bands = {}, matrix = {}, lowConf = [];
    emails.forEach((e) => {
      const t = ctype(e) || 'none'; types[t] = (types[t] || 0) + 1;
      const b = e.classification?.band || 'none'; bands[b] = (bands[b] || 0) + 1;
      const pc = e.classification?.pipelineCategory || 'none'; matrix[pc] = matrix[pc] || {}; matrix[pc][t] = (matrix[pc][t] || 0) + 1;
      if (e.confidence != null && e.confidence < 0.7) lowConf.push(e.id);
    });
    const userSet = emails.filter((e) => e.classification?.userSet).length;
    const viaRule = emails.filter((e) => (e.classification?.ruleIds || []).length && !e.classification?.userSet).length;
    // ---- extraction coverage ----
    const cov = (list, keys) => Object.fromEntries(keys.map((k) => [k, { n: list.filter((x) => (k === 'dueAt' ? !!x.dueAt : !!fact(x, k))).length, of: list.length, pct: pct(list.filter((x) => (k === 'dueAt' ? !!x.dueAt : !!fact(x, k))).length, list.length) }]));
    const extraction = {
      bill: cov(by('bill'), ['amount', 'currency', 'dueAt', 'reference', 'merchant']),
      transaction: cov(by('transaction'), ['amount', 'currency', 'merchant']),
      subscription: cov(by('subscription'), ['amount', 'merchant', 'dueAt']),
      booking: cov(by('booking'), ['reference', 'start', 'dueAt']),
      deadline: cov(by('deadline'), ['date', 'dueAt']),
      appointment: cov(by('appointment'), ['date', 'dueAt'])
    };
    const badFacts = items.filter((x) => (x.extractedFacts || []).some((f) => !isPrim(f.value) || /\[object Object\]/.test(String(f.value)))).map((x) => x.id);
    // emails the pipeline called money/travel but that produced no derived Item
    const moneyNoItem = emails.filter((e) => ['invoice', 'financial', 'receipt', 'subscription'].includes(ctype(e)) && !(e.relatedItemIds || []).some((id) => ['bill', 'transaction', 'subscription'].includes(byId.get(id)?.type))).map((e) => e.id);
    const travelNoItem = emails.filter((e) => ['booking', 'travel'].includes(ctype(e)) && !(e.relatedItemIds || []).some((id) => byId.get(id)?.type === 'booking')).map((e) => e.id);
    // ---- duplicates ----
    const dup = [];
    const amountOf = (x) => Number(fact(x, 'amount')?.value);
    const money = items.filter((x) => x.type === 'bill' || x.type === 'transaction');
    for (let i = 0; i < money.length; i++) for (let j = i + 1; j < money.length; j++) {
      const a = money[i], b = money[j];
      const ma = (fact(a, 'merchant')?.value || '').toLowerCase(), mb = (fact(b, 'merchant')?.value || '').toLowerCase();
      if (ma && ma === mb && amountOf(a) === amountOf(b) && Math.abs((a.dueAt || a.createdAt) - (b.dueAt || b.createdAt)) < 5 * DAY && a.accountId === b.accountId) dup.push({ kind: 'money', a: a.id, b: b.id, why: 'same merchant and amount within 5 days' });
    }
    const travel = items.filter((x) => (x.type === 'booking' || x.type === 'ticket') && x.dueAt);
    for (let i = 0; i < travel.length; i++) for (let j = i + 1; j < travel.length; j++) {
      const a = travel[i], b = travel[j];
      const ra = fact(a, 'reference')?.value, rb = fact(b, 'reference')?.value;
      if ((ra && ra === rb) || (Math.abs(a.dueAt - b.dueAt) < 10 * 60000 && a.accountId === b.accountId)) dup.push({ kind: 'travel', a: a.id, b: b.id, why: ra && ra === rb ? 'same reference' : 'same start time' });
    }
    const pe = new Map(); items.filter((x) => x.type === 'person').forEach((p) => (p.extractedEntities?.emails || []).forEach((e) => { if (pe.has(e)) dup.push({ kind: 'person', a: pe.get(e), b: p.id, why: 'same address' }); else pe.set(e, p.id); }));
    // ---- provenance ----
    const noSource = items.filter((x) => !(x.sources || []).length).map((x) => x.id);
    const orphanFacts = items.filter((x) => x.type !== 'email' && (x.extractedFacts || []).some((f) => f.sourceItemId && !byId.has(f.sourceItemId))).map((x) => x.id);
    const brokenLinks = links.filter((l) => !byId.has(l.from) || !byId.has(l.to)).length;
    const derivedNoEvidence = items.filter((x) => ['bill', 'transaction', 'subscription', 'booking', 'deadline', 'appointment', 'delivery'].includes(x.type) && (x.sources || []).every((s) => s.app === 'gmail') && !(x.relatedItemIds || []).some((id) => byId.get(id)?.type === 'email')).map((x) => x.id);
    // ---- actions ----
    const actKinds = {}; actions.forEach((a) => { actKinds[a.kind] = (actKinds[a.kind] || 0) + 1; });
    const undone = actions.filter((a) => a.undone).length;
    const pending = actions.filter((a) => !a.undone && (a.writeBack || []).some((w) => w.status === 'queued')).length;
    const typeCounts = {}; items.forEach((x) => { typeCounts[x.type] = (typeCounts[x.type] || 0) + 1; });
    const accounts = {}; items.forEach((x) => { accounts[x.accountId] = (accounts[x.accountId] || 0) + 1; });
    return {
      at: now, items: items.length, typeCounts, accounts, links: links.length,
      classification: { emails: emails.length, types, bands, matrix, lowConfidence: lowConf, userSet, viaRule, rules: rules.length, rulesOn: rules.filter((r) => r.enabled !== false).length },
      extraction: Object.assign(extraction, { badFacts, moneyNoItem, travelNoItem }),
      duplicates: dup,
      provenance: { noSource, orphanFacts, brokenLinks, derivedNoEvidence },
      actions: { total: actions.length, byKind: actKinds, undone, pendingWrites: pending }
    };
  }

  /** Validation labels (stored per account on this device): { [itemId]: { ok, expected, important, at } } */
  function scoreLabels(items, labels, needsIds) {
    const byId = new Map(items.map((x) => [x.id, x]));
    const rows = Object.entries(labels || {}).map(([id, l]) => ({ id, l, it: byId.get(id) })).filter((r) => r.it);
    const perType = {};
    rows.forEach(({ l, it }) => { const t = ctype(it) || 'none'; perType[t] = perType[t] || { labelled: 0, correct: 0 }; perType[t].labelled++; if (l.ok) perType[t].correct++; });
    Object.values(perType).forEach((v) => { v.agreementPct = pct(v.correct, v.labelled); });
    const needs = new Set(needsIds || []);
    const imp = rows.filter((r) => r.l.important === true);
    const notImp = rows.filter((r) => r.l.important === false);
    const surfaced = (r) => needs.has(r.id) || (r.it.relatedItemIds || []).some((x) => needs.has(x));
    const missedImportant = imp.filter((r) => !surfaced(r)).map((r) => r.id);
    const falseAlarms = notImp.filter((r) => surfaced(r)).map((r) => r.id);
    const confusions = {}; rows.filter((r) => !r.l.ok && r.l.expected).forEach(({ l, it }) => { const k = `${ctype(it)} → ${l.expected}`; confusions[k] = (confusions[k] || 0) + 1; });
    return {
      labelled: rows.length, correct: rows.filter((r) => r.l.ok).length, agreementPct: pct(rows.filter((r) => r.l.ok).length, rows.length), perType, confusions,
      note: 'Agreement with the labels you gave on a sample you chose — not a measured accuracy of the whole mailbox.',
      importance: { markedImportant: imp.length, surfaced: imp.length - missedImportant.length, shownPct: pct(imp.length - missedImportant.length, imp.length), missedImportant, markedNotImportant: notImp.length, falseAlarms }
    };
  }

  /** What an external tester sends back: numbers and sender domains only. */
  function redactedReport(o) {
    const a = o.analysis, s = o.score, items = o.items || [];
    const byId = new Map(items.map((x) => [x.id, x]));
    const dom = (id) => { const it = byId.get(id); return it ? (it.extractedEntities?.senderDomain || '(unknown)') : '(gone)'; };
    const typeOf = (id) => ctype(byId.get(id) || {}) || byId.get(id)?.type || null;
    return {
      kind: 'daylight-validation-report', version: 1, createdAt: new Date(o.now || Date.now()).toISOString(), app: o.app || 'Daylight V2',
      note: 'Redacted: no subjects, previews, names, amounts or references. Sender domains only.',
      graph: { items: a.items, byType: a.typeCounts, links: a.links },
      classification: { emails: a.classification.emails, types: a.classification.types, bands: a.classification.bands, pipelineToType: a.classification.matrix, lowConfidence: a.classification.lowConfidence.length, userCorrections: a.classification.userSet, rules: a.classification.rules },
      extraction: Object.fromEntries(Object.entries(a.extraction).filter(([k]) => !['badFacts', 'moneyNoItem', 'travelNoItem'].includes(k))),
      extractionProblems: { malformedFacts: a.extraction.badFacts.length, moneyEmailsWithoutMoneyItem: a.extraction.moneyNoItem.map((id) => ({ domain: dom(id), type: typeOf(id) })), travelEmailsWithoutBooking: a.extraction.travelNoItem.map((id) => ({ domain: dom(id), type: typeOf(id) })) },
      duplicates: a.duplicates.map((d) => ({ kind: d.kind, why: d.why, a: typeOf(d.a), b: typeOf(d.b) })),
      provenance: { noSource: a.provenance.noSource.length, orphanFacts: a.provenance.orphanFacts.length, brokenLinks: a.provenance.brokenLinks, derivedWithoutEmail: a.provenance.derivedNoEvidence.length },
      actions: a.actions,
      validation: s ? { note: s.note, labelled: s.labelled, labelAgreementPct: s.agreementPct, perType: s.perType, confusions: s.confusions, importance: { markedImportant: s.importance.markedImportant, markedImportantShownInNeedsYouPct: s.importance.shownPct, missedImportant: s.importance.missedImportant.map((id) => ({ domain: dom(id), type: typeOf(id) })), falseAlarms: s.importance.falseAlarms.map((id) => ({ domain: dom(id), type: typeOf(id) })) } } : null,
      missedReports: (o.missed || []).map((m) => ({ kind: m.kind, senderDomain: m.senderDomain || null, at: m.at })),
      sync: o.sync || null
    };
  }

  const api = { analyse, scoreLabels, redactedReport };
  root.DaylightV2Diagnostics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
