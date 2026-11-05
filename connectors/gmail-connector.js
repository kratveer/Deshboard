/**
 * Gmail connector (V2, live, READ-ONLY).
 * Turns what the Gmail pipeline cached (daylight-mail: message index + extracted facts) into Item Graph Items.
 *
 * One email → one email Item (key gmail:<account>:<messageId>), plus derived Items keyed by their OWN natural key,
 * so the same bill / booking / person arriving in several emails is ONE Item with several sources:
 *   bill / transaction / subscription  — money facts (amount, currency, due date, reference)
 *   booking                            — reservation / order reference, start date
 *   deadline / appointment / delivery  — dated obligations from key dates
 *   organisation / person              — the sender
 * Every extracted fact names its source Item. Identity documents are marked aiExclude and get no extracted facts.
 */
(function (root) {
  'use strict';
  const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|seznam|email|centrum|post|gmx|web|proton|protonmail|aol|rediffmail)\./i;
  const MONEY_CATS = new Set(['bill', 'payment', 'refund', 'receipt', 'subscription', 'food']);
  const gmailUrl = (threadId) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
  const nameOf = (from) => String(from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim() || String(from || '');
  const emailOf = (from) => { const m = /<([^>]+)>/.exec(from || '') || /([^\s<>"]+@[^\s<>"]+)/.exec(from || ''); return (m ? m[1] : '').trim().toLowerCase(); };

  function createGmailConnector(o) {
    const graph = o.graph, Cls = o.classifier || root.DaylightClassifier, Rules = o.ruleStore;
    const D = o.mailDates || root.DaylightMailDates;
    const now = o.now || (() => Date.now());
    const G = root.DaylightItemGraph || o.itemGraphApi;
    const iid = (k) => G.itemId(k);

    function factList(pairs, srcId, method) { return pairs.filter(([, v]) => v != null && v !== '').map(([key, value]) => ({ key, value, sourceItemId: srcId, method: method || 'rule' })); }

    /** normalise(record, facts, ctx) → { items, links } (pure). */
    function normalise(rec, factsRow, ctx) {
      const c = ctx || {};
      const acct = c.accountId || rec.accountId || 'default';
      const src = (role) => ({ app: 'gmail', accountId: acct, itemId: rec.messageId, url: gmailUrl(rec.threadId || rec.messageId), role: role || 'primary' });
      const f0 = (factsRow && factsRow.fields) || {};
      // rules store dueDate as { date, raw, confidence }; schema.org / AI may give a plain string
      const dueStr = f0.dueDate && typeof f0.dueDate === 'object' ? (f0.dueDate.date || null) : (f0.dueDate || null);
      const f = Object.assign({}, f0, { dueDate: dueStr });
      const email = emailOf(rec.from), domain = (rec.fromDomain || email.split('@')[1] || '').toLowerCase();
      const cls = Cls.classify({
        sourceApp: 'gmail', from: rec.from, fromEmail: email, fromDomain: domain, subject: rec.subject, snippet: rec.snippet, labels: rec.labels,
        listUnsubscribe: rec.listUnsubscribe, pipelineCategory: rec.userCategory || rec.category, keyDates: rec.keyDates, isSent: (rec.labels || []).includes('SENT') && !(rec.labels || []).includes('INBOX'),
        facts: { amount: f.amount || (f.totalPaymentDue != null ? { value: f.totalPaymentDue, currency: f.priceCurrency } : null), dueDate: f.dueDate, reference: f.reference, reservationNumber: f.reservationNumber, orderNumber: f.orderNumber, schemaType: f.schemaType }
      }, { rules: c.rules || [], vipSenders: c.vipSenders || [], now: c.now || now() });
      const identity = cls.identity;
      const emailKey = `gmail:${acct}:${rec.messageId}`;
      const emailId = iid(emailKey);
      const items = [], links = [];
      const amount = f.amount || (f.totalPaymentDue != null ? { value: Number(f.totalPaymentDue), currency: f.priceCurrency || null } : null);
      const ref = f.reservationNumber || f.orderNumber || f.reference || null;

      items.push({
        key: emailKey, accountId: acct, type: 'email', title: rec.subject || '(no subject)', description: rec.snippet || '',
        priority: cls.importance, dueAt: cls.dueAt, createdAt: rec.internalDate || now(), sources: [src()],
        confidence: rec.confidence ?? null, privacyClass: identity ? 'identity' : (MONEY_CATS.has(rec.category) ? 'financial' : 'normal'), aiExclude: identity,
        classification: { type: cls.type, importance: cls.importance, band: cls.band, reasons: cls.reasons, ruleIds: cls.ruleId ? [cls.ruleId] : [], action: cls.action, pipelineCategory: rec.category, pipelineReason: rec.ruleReason || '' },
        extractedEntities: { senderName: nameOf(rec.from), senderEmail: email, senderDomain: domain, references: ref && !identity ? [String(ref)] : [] },
        extractedFacts: identity ? [] : factList([['amount', amount && amount.value], ['currency', amount && amount.currency], ['dueDate', f.dueDate], ['reference', ref], ['merchant', f.merchant]], emailId, factsRow?.source === 'rules' ? 'rule' : (factsRow?.source || 'rule'))
          .concat((rec.keyDates || []).map((kd) => ({ key: 'date:' + kd.kind, value: kd.date + (kd.time ? ' ' + kd.time : ''), quote: kd.quote, sourceItemId: emailId, method: kd.source === 'schema.org' ? 'schema' : 'rule' }))),
        meta: { threadId: rec.threadId, labels: rec.labels, from: rec.from, unread: (rec.labels || []).includes('UNREAD'), gmailCategory: (rec.labels || []).find((l) => /^CATEGORY_/.test(l)) || 'CATEGORY_PERSONAL' }
      });
      if (identity) return { items, links, classification: cls }; // identity documents: no derived items, nothing for AI

      // sender → organisation or person
      if (domain && !FREEMAIL.test(domain + '.') && !(rec.labels || []).includes('SENT')) {
        const k = `org:${acct}:${domain}`; /* per account: a sender seen by two accounts is two Items */ items.push({ key: k, accountId: acct, type: 'organisation', title: f.merchant || nameOf(rec.from).replace(/\s*\(.*\)$/, ''), description: domain, sources: [src('mention')], extractedEntities: { domains: [domain] } });
        links.push([emailId, iid(k), 'from']);
      } else if (email && !cls.automated) {
        const k = `person:${acct}:${email}`; items.push({ key: k, accountId: acct, type: 'person', title: nameOf(rec.from), description: email, sources: [src('mention')], extractedEntities: { emails: [email] } });
        links.push([emailId, iid(k), 'from']);
      }

      // money
      const money = MONEY_CATS.has(rec.userCategory || rec.category) && amount && amount.value != null && cls.type !== 'personal'; // a person writing about money is a message, not a transaction
      if (money) {
        const cat = rec.userCategory || rec.category;
        const type = cat === 'bill' ? 'bill' : cat === 'subscription' ? 'subscription' : 'transaction';
        const k = type === 'subscription' ? `sub:${acct}:${domain}` : `money:${acct}:${domain}:${ref || f.dueDate || (amount.value + ':' + (rec.internalDate ? new Date(rec.internalDate).toISOString().slice(0, 10) : ''))}`;
        const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f.dueDate || ''));
        const dueMs = dm ? new Date(+dm[1], +dm[2] - 1, +dm[3], 23, 59).getTime() : (f.dueDate && !isNaN(Date.parse(f.dueDate)) ? Date.parse(f.dueDate) : null); // a due date means the end of that day, local time
        items.push({ key: k, accountId: acct, type, title: `${f.merchant || nameOf(rec.from)} · ${amount.value}${amount.currency ? ' ' + amount.currency : ''}`, description: rec.subject || '', dueAt: dueMs, priority: cls.importance, sources: [src('evidence')],
          extractedFacts: factList([['amount', amount.value], ['currency', amount.currency], ['dueDate', f.dueDate], ['reference', ref], ['merchant', f.merchant || nameOf(rec.from)], ['kind', cat]], emailId), meta: { category: cat } });
        links.push([emailId, iid(k), 'evidence']);
        if (domain && !FREEMAIL.test(domain + '.')) links.push([iid(k), iid(`org:${acct}:${domain}`), 'merchant']);
      }
      // booking (one per reference across confirmation / change emails)
      const travelDate = (rec.keyDates || []).find((x) => x.kind === 'travel');
      if (['booking', 'travel'].includes(cls.type) && (ref || f.schemaType || travelDate)) {
        const k = `booking:${acct}:${String(ref || rec.threadId).toUpperCase()}`;
        const start = travelDate;
        const startMs = start && D ? D.toMs(start) : null;
        items.push({ key: k, accountId: acct, type: 'booking', title: rec.subject || 'Booking', description: start?.quote || '', dueAt: startMs, priority: cls.importance, sources: [src('evidence')],
          extractedFacts: factList([['reference', ref], ['start', start ? start.date + (start.time ? ' ' + start.time : '') : null], ['schemaType', f.schemaType]], emailId, f.schemaType ? 'schema' : 'rule') });
        links.push([emailId, iid(k), 'evidence']);
      }
      // dated obligations: one per thread and kind (the newest email in the thread wins on re-ingest)
      (rec.keyDates || []).filter((kd) => kd.kind !== 'travel').forEach((kd) => {
        if (money && kd.kind === 'deadline') return; // a bill's due date lives on the bill Item
        const type = kd.kind === 'reminder' || kd.kind === 'event' ? 'appointment' : 'deadline';
        const k = `date:${acct}:${rec.threadId || rec.messageId}:${type}`;
        const ms = D ? D.toMs(kd) : Date.parse(kd.date);
        items.push({ key: k, accountId: acct, type, title: rec.subject || (type === 'deadline' ? 'Deadline' : 'Appointment'), description: kd.quote || '', dueAt: ms, priority: cls.importance, sources: [src('evidence')],
          extractedFacts: factList([['date', kd.date + (kd.time ? ' ' + kd.time : '')], ['quote', kd.quote]], emailId, kd.source === 'schema.org' ? 'schema' : 'rule') });
        links.push([emailId, iid(k), 'evidence']);
      });
      if (cls.type === 'delivery') {
        const k = `delivery:${acct}:${ref || rec.threadId}`;
        items.push({ key: k, accountId: acct, type: 'delivery', title: rec.subject || 'Delivery', description: rec.snippet || '', priority: cls.importance, sources: [src('evidence')], extractedFacts: factList([['reference', ref]], emailId) });
        links.push([emailId, iid(k), 'evidence']);
      }
      return { items, links, classification: cls };
    }

    /**
     * ingest(accountId): mail cache → graph. Idempotent: re-running creates no duplicates (stable keys), keeps user state,
     * and removes Items for messages Gmail deleted. Skipped (no content) and pending messages are not turned into Items.
     */
    async function ingest(accountId, opts) {
      const acct = accountId || 'default';
      const rows = await o.mailCache.all(acct);
      const since = (opts && opts.since) || 0; // incremental: only messages processed since the last ingest
      const live = rows.filter((r) => !['skipped', 'meta-pending', 'deleted'].includes(r.status) && (!since || (r.lastProcessedAt || 0) >= since));
      const facts = await o.mailCache.getFacts(acct, live.map((r) => r.messageId));
      const rules = Rules ? (await Rules.all()).filter((r) => !r.accountId || r.accountId === acct) : []; // another account's rules never apply here
      const out = [], linkList = [];
      live.forEach((r) => { const n = normalise(r, facts.get(r.messageId), { accountId: acct, rules, now: (opts && opts.now) || now(), vipSenders: (opts && opts.vipSenders) || [] }); out.push(...n.items); linkList.push(...n.links); });
      // a re-read email that no longer produces a derived Item (fixed extraction, reclassified, user rule) stops supporting it
      const stale = [];
      if (graph.detachSources && live.length) {
        const produced = new Map(); out.forEach((p) => (p.sources || []).forEach((s) => { if (s.app === 'gmail') { const k = String(s.itemId); if (!produced.has(k)) produced.set(k, new Set()); produced.get(k).add(G.itemId(p.key)); } }));
        const liveIds = new Set(live.map((r) => String(r.messageId)));
        (await graph.query({ accountId: acct })).forEach((it) => {
          if (it.type === 'email') return;
          (it.sources || []).forEach((s) => { if (s.app === 'gmail' && (s.role === 'evidence' || s.role === 'mention') && liveIds.has(String(s.itemId)) && !(produced.get(String(s.itemId)) || new Set()).has(it.id)) stale.push({ itemId: it.id, app: 'gmail', accountId: acct, sourceItemId: s.itemId, emailItemId: iid(`gmail:${acct}:${s.itemId}`) }); });
        });
      }
      const stored = await graph.upsertMany(out);
      let carried = 0;
      if (stale.length) {
        // keep what the user did: a stale Item's status/snooze/notes move to the Item of the same kind the email now produces
        const olds = await graph.getMany([...new Set(stale.map((x) => x.itemId))]);
        for (const o2 of olds) {
          const mids = stale.filter((x) => x.itemId === o2.id).map((x) => String(x.sourceItemId));
          const cand = stored.filter((n) => n.type === o2.type && n.id !== o2.id && (n.sources || []).some((s2) => s2.app === 'gmail' && mids.includes(String(s2.itemId))));
          if (cand.length !== 1) continue;
          const n = cand[0]; let changed = false;
          ['status', 'snoozedUntil', 'pinned', 'userPriority', 'plannedAt', 'plannedMinutes'].forEach((k) => { if (o2[k] != null && o2[k] !== false && o2[k] !== 'open' && (n[k] == null || n[k] === 'open' || n[k] === false)) { n[k] = o2[k]; changed = true; } });
          ['notes', 'actionHistory', 'userCorrections'].forEach((k) => { if ((o2[k] || []).length) { n[k] = [...(o2[k] || []), ...(n[k] || [])]; changed = true; } });
          if (changed) { await graph.putItem(n); carried++; }
        }
        await graph.detachSources(stale);
      }
      if (graph.linkMany) await graph.linkMany(linkList, acct); else for (const [a, b, kind] of linkList) await graph.link(a, b, kind, acct);
      // Gmail deleted / trashed → drop the email Item (derived Items survive while another email still supports them)
      let removed = 0;
      for (const r of rows.filter((x) => x.status === 'deleted' && (!since || (x.deletedAt || x.lastProcessedAt || 0) >= since))) removed += await graph.removeSourceItem('gmail', acct, r.messageId);
      return { items: stored.length, emails: live.length, links: linkList.length, removed, staleDetached: stale.length, userStateCarried: carried, full: !since };
    }

    const status = { lastSync: null, lastError: null, lastReport: null };
    return {
      id: 'gmail', name: 'Gmail', status: 'live', group: 'google',
      reads: 'Bills, receipts, bookings, deadlines and messages that need you — every Gmail category, read-only',
      getCapabilities: () => ({ read: ['email', 'bill', 'transaction', 'subscription', 'booking', 'deadline', 'appointment', 'delivery', 'person', 'organisation'], write: [] }),
      getPermissions: () => [{ scope: 'https://www.googleapis.com/auth/gmail.readonly', why: 'Read your email to find what needs you. Daylight cannot send, delete or change mail.' }],
      async getConnectionStatus() { const s = o.getStatus ? await o.getStatus() : {}; return Object.assign({ connected: false }, s, { lastSync: status.lastSync, lastError: status.lastError }); },
      async validateConnection() { return o.validate ? o.validate() : { ok: true }; },
      connect: () => (o.connect ? o.connect() : Promise.reject(new Error('connect handled by the app'))),
      async disconnect(opts2) { const r = o.disconnect ? await o.disconnect(opts2) : null; const deleted = await graph.deleteBySource('gmail'); return { ok: true, deleted, provider: r }; },
      async fetchItems(q) { return graph.query(Object.assign({ sourceApp: 'gmail' }, q || {})); },
      normalise,
      async sync(opts2) {
        try { const rep = o.runPipeline ? await o.runPipeline(opts2) : null; const ing = await ingest(o.getAccountId ? await o.getAccountId() : 'default', opts2); status.lastSync = now(); status.lastError = null; status.lastReport = { pipeline: rep && rep.report, ingest: ing }; return status.lastReport; }
        catch (e) { status.lastError = String(e && e.message || e); throw e; }
      },
      ingest
    };
  }

  const api = { createGmailConnector, gmailUrl };
  root.DaylightGmailConnector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
