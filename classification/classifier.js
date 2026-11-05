/**
 * Daylight V2 classifier: message type + explainable importance.
 *
 * Input is what the Gmail pipeline already knows (category from rules/schema/finance, key dates, facts, labels,
 * sender) — deterministic, no AI. Output:
 *   { type, importance 0–100, band, reasons[], ruleId, action, dueAt }
 * Rules the user created from corrections are applied first.
 * Deliberately ignored: UNREAD and Gmail's IMPORTANT marker (not evidence of importance), and the Gmail category
 * alone (Promotions is not proof of unimportance).
 */
(function (root) {
  'use strict';
  const UR = () => root.DaylightUserRules || (typeof require === 'function' ? require('./user-rules.js') : null);
  const DAY = 86400000;
  const TYPES = Object.freeze(['urgent_action', 'personal', 'university_work', 'financial', 'receipt', 'invoice', 'subscription', 'travel', 'booking',
    'delivery', 'documents', 'appointment', 'deadline', 'follow_up', 'newsletter', 'social_notification', 'marketing', 'automated']);
  const LOW = new Set(['newsletter', 'social_notification', 'marketing', 'automated']);
  const BASE = { urgent_action: 70, personal: 50, university_work: 55, financial: 40, receipt: 22, invoice: 55, subscription: 32, travel: 45, booking: 48,
    delivery: 30, documents: 38, appointment: 52, deadline: 55, follow_up: 42, newsletter: 6, social_notification: 6, marketing: 4, automated: 12 };

  const RX = {
    request: /(please (reply|confirm|register|respond|send|let (me|us) know|review|sign)|could you|can you|would you|let me know|confirm (your )?attendance|reply to confirm|action required|prosím (pošli|potvrď|odpověz|dej vědět)|bitte (bestätigen|antworten))/i,
    question: /\?\s*$|\?\s/,
    delivery: /(shipped|out for delivery|on its way|delivery expected|tracking (number|no)|parcel|package|zásilk|doručení|odeslán|balík|sendungsverfolgung|paket)/i,
    appointment: /(appointment|interview|consultation|your visit|termín (návštěvy|vyšetření)|objednán|schůzk|meeting (on|at)|invite you)/i,
    study: /(universit|univerzit|faculty|fakult|course|exam|zkouš|semest|enrol|zápis|thesis|dissertation|phd|doctoral|lecture|seminar|grant|journal|manuscript|editorial|reviewer)/i,
    workDomain: /(\.edu$|\.ac\.[a-z]{2}$|^cuni\.cz$|^fzu\.cz$|^cas\.cz$|^acs\.org$|^mff\.cuni\.cz$)/i,
    security: /(security alert|new sign-in|password|verify|suspicious|two-step|2fa|bezpečnost)/i,
    identity: /(passport|cestovní pas|občansk[ýé] průkaz|identity card|id card|residence permit|povolení k pobytu|visa\b|vízum|driving licen[cs]e|řidičsk)/i
  };
  const AUTO_SENDER = /(^|[._-])(no-?reply|noreply|do-?not-?reply|notifications?|mailer|bounce|alerts?|info|news|newsletter|updates?)([._-]|@)/i;

  function nearestDue(input, now) {
    const D = root.DaylightMailDates || (typeof require === 'function' ? (() => { try { return require('../mail-dates.js'); } catch { return null; } })() : null);
    const times = [];
    (input.keyDates || []).forEach((kd) => { try { const ms = D ? D.toMs(kd) : Date.parse(kd.date); if (Number.isFinite(ms)) times.push({ ms, kind: kd.kind }); } catch {} });
    const due = input.facts?.dueDate;
    if (due && !isNaN(Date.parse(due))) times.push({ ms: Date.parse(due) + (/\d\d:\d\d/.test(due) ? 0 : 23.98 * 3600000), kind: 'deadline' });
    const future = times.filter((t) => t.ms >= now - 3 * DAY).sort((a, b) => a.ms - b.ms);
    return future[0] || null;
  }

  /**
   * classify(input, ctx)
   * input: { sourceApp, from, fromEmail, fromDomain, subject, snippet, text?, labels[], pipelineCategory, keyDates[], facts{amount,dueDate,reference,…},
   *          isSent, threadReplied, unansweredByMe }
   * ctx:   { rules[], vipSenders[], now }
   */
  function classify(input, ctx) {
    const c = ctx || {}, now = c.now || Date.now();
    const U = UR();
    const reasons = [];
    const email = (input.fromEmail || (U ? U.emailOf(input.from) : '') || '').toLowerCase();
    const domain = (input.fromDomain || (U ? U.domainOf(email) : '') || '').toLowerCase();
    const txt = `${input.subject || ''}\n${input.snippet || ''}\n${input.text || ''}`;
    const labels = input.labels || [];
    const bulk = !!input.listUnsubscribe || labels.some((l) => l === 'CATEGORY_PROMOTIONS' || l === 'CATEGORY_SOCIAL' || l === 'CATEGORY_FORUMS');
    const automated = AUTO_SENDER.test(email) || bulk;
    const cat = input.pipelineCategory || 'other';
    const amount = input.facts?.amount;
    const ref = input.facts?.reference || input.facts?.reservationNumber || input.facts?.orderNumber;
    const due = nearestDue(input, now);

    // 1. the user's own rules come first
    const rule = U ? U.match(c.rules || [], { from: input.from, fromEmail: email, fromDomain: domain, subject: input.subject }) : null;
    let type = null;
    if (rule && rule.set?.type) { type = rule.set.type; reasons.push(`your rule: ${rule.label}`); }

    // 2. deterministic type from what the pipeline found
    if (!type) {
      if (input.isSent) type = 'follow_up';
      else if (cat === 'security' || RX.security.test(input.subject || '')) type = 'urgent_action';
      else if (cat === 'bill') type = 'invoice';
      else if ((cat === 'payment' || cat === 'refund') && !automated && RX.request.test(txt)) { type = 'personal'; reasons.push('a person asking about a payment, not a payment record'); }
      else if (cat === 'payment' || cat === 'refund') type = 'financial';
      else if (cat === 'receipt' || cat === 'food') type = RX.delivery.test(txt) ? 'delivery' : 'receipt';
      else if (cat === 'subscription') type = 'subscription';
      else if (cat === 'travel') type = ref || input.facts?.schemaType ? 'booking' : 'travel';
      else if (cat === 'document') type = 'documents';
      else if (cat === 'promotion') type = 'marketing';
      else if (cat === 'newsletter') type = 'newsletter';
      else if (cat === 'social') type = 'social_notification';
      else if (cat === 'personal') type = 'personal';
      else type = automated ? 'automated' : 'personal';
      // signals refine the type (a delivery receipt, an appointment, a study deadline …)
      if (!LOW.has(type) || cat === 'other') {
        if (RX.delivery.test(txt) && ['receipt', 'automated', 'personal'].includes(type) && !amount) type = 'delivery';
        if (RX.appointment.test(txt) && (due || /\d{1,2}:\d{2}/.test(txt)) && ['personal', 'automated', 'documents'].includes(type)) type = 'appointment';
        if (due && due.kind === 'deadline' && ['personal', 'automated', 'documents'].includes(type)) type = (RX.study.test(txt) || RX.workDomain.test(domain)) ? 'university_work' : 'deadline';
        else if ((RX.study.test(input.subject || '') || RX.workDomain.test(domain)) && type === 'personal') type = 'university_work';
      }
      reasons.push(`type from ${cat === 'other' ? 'sender and wording' : 'rules: ' + cat}`);
    }

    // 3. importance (explainable)
    let score = BASE[type] ?? 20;
    const add = (n, why) => { score += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };
    if (due) {
      const days = (due.ms - now) / DAY;
      if (days < 0) add(20, 'overdue');
      else if (days <= 2) add(25, 'due within 2 days');
      else if (days <= 7) add(12, 'due this week');
    }
    if (amount && ['invoice', 'financial', 'subscription'].includes(type)) add(8, 'money at stake');
    if (RX.request.test(txt) && !automated) add(15, 'asks you to do something');
    else if (RX.request.test(txt)) add(6, 'asks for a response');
    if (!automated && !input.isSent) add(10, 'from a person');
    if (!automated && RX.question.test(input.snippet || '') && !input.threadReplied) add(8, 'unanswered question');
    if (input.threadReplied) add(5, 'you are in this conversation');
    if ((c.vipSenders || []).map((x) => x.toLowerCase()).includes(email)) add(15, 'pinned person');
    if (rule && Number.isFinite(rule.set?.importance)) { score = rule.set.importance; reasons.push(`importance set by your rule (${rule.set.importance})`); }
    if (RX.identity.test(input.subject || '')) reasons.push('identity document: never sent to AI');
    score = Math.max(0, Math.min(100, Math.round(score)));
    const band = score >= 60 ? 'high' : score >= 30 ? 'normal' : 'low';
    const action = type === 'invoice' ? 'pay' : type === 'personal' || type === 'university_work' ? (RX.request.test(txt) ? 'reply' : null) : type === 'follow_up' ? 'follow_up'
      : type === 'appointment' ? 'attend' : type === 'deadline' ? 'complete' : type === 'booking' || type === 'travel' ? 'prepare' : type === 'urgent_action' ? 'review' : null;
    return { type, importance: score, band, reasons, ruleId: rule ? rule.id : null, action, dueAt: due ? due.ms : null, identity: RX.identity.test(input.subject || ''), automated };
  }

  const api = { classify, TYPES, LOW, RX };
  root.DaylightClassifier = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
