/**
 * Daylight user rules (V2): every correction becomes a visible, editable rule.
 * A rule matches by sender email, sender domain or subject words, and sets a type and/or importance.
 * Rules live in the Item Graph ("rules" store) so disconnecting a provider removes the rules it created.
 * No network, no DOM.
 */
(function (root) {
  'use strict';
  const hashOf = (s) => (root.DaylightItemGraph?.hash || ((x) => String(x).length.toString(36)))(s);
  const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|seznam|email|centrum|post|gmx|web|proton|protonmail|aol|rediffmail)\./i;
  const emailOf = (from) => { const m = /<([^>]+)>/.exec(from || '') || /([^\s<>"]+@[^\s<>"]+)/.exec(from || ''); return (m ? m[1] : '').trim().toLowerCase(); };
  const domainOf = (email) => (String(email).split('@')[1] || '').toLowerCase();

  const TYPE_LABEL = {
    urgent_action: 'Urgent action', personal: 'Important personal', university_work: 'University and work', financial: 'Financial', receipt: 'Receipt',
    invoice: 'Invoice', subscription: 'Subscription', travel: 'Travel', booking: 'Booking', delivery: 'Delivery', documents: 'Documents',
    appointment: 'Appointment', deadline: 'Deadline', follow_up: 'Follow-up', newsletter: 'Newsletter', social_notification: 'Social notification',
    marketing: 'Marketing', automated: 'Automated notification'
  };

  /**
   * Build the rule a correction implies. Personal / freemail senders → match that exact address;
   * companies → match the whole domain (all of a company's mail is usually the same kind).
   */
  function ruleFromCorrection(input, newType, opts) {
    const o = opts || {};
    const email = (input.fromEmail || emailOf(input.from) || '').toLowerCase();
    const domain = (input.fromDomain || domainOf(email)).toLowerCase();
    const byEmail = o.scope === 'email' || (!o.scope && (FREEMAIL.test(domain + '.') || !domain));
    const match = byEmail ? { senderEmail: email } : { senderDomain: domain };
    const id = 'rule_' + hashOf(JSON.stringify(match) + '|' + (o.accountId || ''));
    const who = match.senderEmail || match.senderDomain;
    return {
      id, accountId: o.accountId || null, sourceApp: input.sourceApp || 'gmail', enabled: true, match,
      set: { type: newType, importance: o.importance ?? null },
      label: `Email from ${who} → ${TYPE_LABEL[newType] || newType}`,
      createdFrom: { itemId: input.itemId || null, fromType: input.type || null, at: o.now || Date.now() },
      createdAt: o.now || Date.now(), updatedAt: o.now || Date.now(), hits: 0
    };
  }

  /** First enabled rule that matches this message (exact address beats domain beats subject words). */
  function match(rules, input) {
    const email = (input.fromEmail || emailOf(input.from) || '').toLowerCase();
    const domain = (input.fromDomain || domainOf(email)).toLowerCase();
    const subj = String(input.subject || '').toLowerCase();
    const on = (rules || []).filter((r) => r && r.enabled !== false);
    return on.find((r) => r.match?.senderEmail && r.match.senderEmail === email)
      || on.find((r) => r.match?.senderDomain && (domain === r.match.senderDomain || domain.endsWith('.' + r.match.senderDomain)))
      || on.find((r) => r.match?.subjectContains && subj.includes(String(r.match.subjectContains).toLowerCase()))
      || null;
  }

  /** Should Daylight ask the user to confirm this classification? Never when a rule already covers the sender. */
  function shouldAsk(rules, input, confidence) { return !match(rules, input) && (confidence ?? 1) < 0.7; }

  /** Rule store helpers over the graph. */
  function createRuleStore(graph, opts) {
    const now = (opts && opts.now) || (() => Date.now());
    return {
      all: () => graph.rules.all(),
      async upsertFromCorrection(input, newType, o2) {
        const r = ruleFromCorrection(input, newType, Object.assign({ now: now() }, o2 || {}));
        const prev = await graph.rules.get(r.id);
        const rule = prev ? Object.assign({}, prev, { set: r.set, label: r.label, enabled: true, updatedAt: now() }) : r;
        await graph.rules.put(rule);
        return rule;
      },
      async edit(id, patch) {
        const r = await graph.rules.get(id); if (!r) throw new Error('rule not found');
        const allowed = {}; ['enabled', 'set', 'match', 'label'].forEach((k) => { if (patch[k] !== undefined) allowed[k] = patch[k]; });
        const out = Object.assign({}, r, allowed, { updatedAt: now() });
        await graph.rules.put(out); return out;
      },
      remove: (id) => graph.rules.del(id),
      async hit(id) { const r = await graph.rules.get(id); if (r) { r.hits = (r.hits || 0) + 1; r.lastHitAt = now(); await graph.rules.put(r); } }
    };
  }

  const api = { ruleFromCorrection, match, shouldAsk, createRuleStore, emailOf, domainOf, TYPE_LABEL, FREEMAIL };
  root.DaylightUserRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
