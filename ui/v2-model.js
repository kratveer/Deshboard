/**
 * Daylight V2 view models — pure functions from Item Graph Items to what each screen shows.
 * No DOM, no network, no storage: every screen in ui/v2-app.js is drawn from these, and the unit tests run them in Node.
 * Rule: nothing is invented. Every line, number and sentence points at the Item ids it came from.
 */
(function (root) {
  'use strict';
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const NEEDS = new Set(['urgent_action', 'personal', 'university_work', 'deadline', 'appointment']);
  const MONEY = new Set(['financial', 'receipt', 'invoice', 'subscription', 'delivery']);
  const TRAVEL = new Set(['travel', 'booking']);
  const UPDATES = new Set(['newsletter', 'social_notification', 'marketing', 'automated']);
  const DATED = new Set(['deadline', 'appointment', 'booking', 'event', 'ticket', 'task', 'bill', 'subscription', 'delivery']);
  const TYPE_LABEL = {
    urgent_action: 'Urgent', personal: 'Personal', university_work: 'Study & work', financial: 'Payment', receipt: 'Receipt', invoice: 'Bill',
    subscription: 'Subscription', travel: 'Travel', booking: 'Booking', delivery: 'Delivery', documents: 'Document', appointment: 'Appointment',
    deadline: 'Deadline', follow_up: 'Sent', newsletter: 'Newsletter', social_notification: 'Social', marketing: 'Promotion', automated: 'Notification'
  };
  const KIND_LABEL = { bill: 'Bill', transaction: 'Payment', subscription: 'Subscription', booking: 'Booking', trip: 'Trip', ticket: 'Ticket', delivery: 'Delivery',
    deadline: 'Deadline', appointment: 'Appointment', task: 'Task', event: 'Event', document: 'Document', warranty: 'Warranty', email: 'Email', person: 'Person', organisation: 'Organisation', project: 'Project' };

  // ---------- small helpers ----------
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
  const fact = (it, key) => { const f = (it.extractedFacts || []).find((x) => x.key === key && x.value != null && x.value !== ''); return f ? f.value : null; };
  const facts = (it, key) => (it.extractedFacts || []).filter((x) => x.key === key && x.value != null && x.value !== '');
  const ctype = (it) => (it.classification && it.classification.type) || null;
  const importance = (it) => Number.isFinite(it.userPriority) ? it.userPriority : (it.classification && Number.isFinite(it.classification.importance) ? it.classification.importance : (it.priority || 0));
  const isSent = (it) => it.type === 'email' && ctype(it) === 'follow_up';
  /** open = not done/dismissed, and not snoozed into the future */
  const isOpen = (it, now) => it.status === 'open' || (it.status === 'snoozed' && (!it.snoozedUntil || it.snoozedUntil <= now));
  const isSnoozed = (it, now) => it.status === 'snoozed' && it.snoozedUntil && it.snoozedUntil > now;
  /** When the Item happens: a time the user planned beats the source date. */
  const whenOf = (it) => (Number.isFinite(it.plannedAt) ? it.plannedAt : (it.dueAt || null));
  /** Does the Item have a real clock time (not a date-only deadline)? */
  function timed(it) {
    if (Number.isFinite(it.plannedAt)) return true;
    if (it.meta && it.meta.timed != null) return !!it.meta.timed;
    const v = fact(it, 'start') || fact(it, 'date');
    return !!(v && /\d{1,2}:\d{2}/.test(String(v)));
  }
  const lastFact = (it, key) => { const fs = (it.extractedFacts || []).filter((x) => x.key === key && x.value != null && x.value !== ''); return fs.length ? fs[fs.length - 1].value : null; };
  const amountOf = (it) => { const raw = lastFact(it, 'amount'); if (raw == null) return null; const v = Number(raw); return Number.isFinite(v) ? { value: v, currency: lastFact(it, 'currency') || '' } : null; };
  const sender = (it) => (it.extractedEntities && (it.extractedEntities.senderName || it.extractedEntities.senderEmail)) || (it.meta && it.meta.from) || '';
  const senderKey = (it) => { const e = it.extractedEntities || {}; return (e.senderEmail || e.senderDomain || sender(it) || '').toLowerCase(); };
  function index(items) { const m = new Map(); items.forEach((x) => m.set(x.id, x)); return m; }
  const relatedOf = (it, byId, type) => (it.relatedItemIds || []).map((id) => byId.get(id)).filter((x) => x && (!type || [].concat(type).includes(x.type)));

  function fmtMoney(v, cur) {
    if (!Number.isFinite(v)) return '';
    const n = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-GB').replace(/,/g, ' ') : (Math.round(v * 100) / 100).toString();
    return cur ? `${n} ${cur}` : n;
  }
  function dayLabel(t, now) {
    const d0 = startOfDay(now), d = startOfDay(t), diff = Math.round((d - d0) / DAY);
    if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow'; if (diff === -1) return 'Yesterday';
    if (diff > 1 && diff < 7) return new Date(t).toLocaleDateString('en-GB', { weekday: 'long' });
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  const hm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  function whenText(it, now) {
    const w = whenOf(it); if (!w) return '';
    const label = dayLabel(w, now);
    return timed(it) ? `${label} ${hm(w)}` : label;
  }
  function ago(t, now) {
    const s = Math.max(0, now - t);
    if (s < HOUR) return Math.max(1, Math.round(s / MIN)) + ' min';
    if (s < DAY) return Math.round(s / HOUR) + ' h';
    if (s < 7 * DAY) return Math.round(s / DAY) + ' d';
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // ---------- inbox grouping ----------
  /** Which Inbox group an email belongs to. */
  function emailGroup(it) {
    const t = ctype(it);
    if (isSent(it)) return 'waiting';
    if (UPDATES.has(t)) return 'updates';
    if (NEEDS.has(t)) return 'needs';
    if (MONEY.has(t)) return 'money';
    if (TRAVEL.has(t)) return 'travel';
    if (t === 'documents') return 'documents';
    return 'needs';
  }
  /** A sent email is "waiting" until a later email arrives in the same thread (14 days max). */
  function waitingOn(items, now) {
    const latestIn = new Map();
    items.forEach((it) => { if (it.type !== 'email' || isSent(it)) return; const th = it.meta && it.meta.threadId; if (th) latestIn.set(th, Math.max(latestIn.get(th) || 0, it.createdAt || 0)); });
    return items.filter((it) => isSent(it) && isOpen(it, now) && now - (it.createdAt || 0) <= 14 * DAY && !((latestIn.get(it.meta && it.meta.threadId) || 0) > (it.createdAt || 0)))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  // ---------- primary action per Item ----------
  function primaryAction(it) {
    const t = it.type, c = ctype(it), act = it.classification && it.classification.action;
    if (t === 'bill') return { kind: 'done', label: 'Mark paid' };
    if (t === 'task' || t === 'deadline') return { kind: 'done', label: 'Done' };
    if (t === 'appointment' || t === 'event') return { kind: 'done', label: 'Done' };
    if (t === 'booking' || t === 'ticket') return { kind: 'open', label: 'Open' };
    if (t === 'delivery') return { kind: 'done', label: 'Got it' };
    if (t === 'email' && (act === 'reply' || c === 'personal' || c === 'university_work')) return { kind: 'reply', label: 'Reply' };
    if (t === 'email' && c === 'invoice') return { kind: 'done', label: 'Mark paid' };
    return { kind: 'done', label: 'Done' };
  }

  // ---------- Today ----------
  /**
   * What needs the user now. Derived Items (bill, deadline, appointment, booking, delivery, task) are preferred to the
   * emails they came from; those emails fold underneath as "related".
   */
  function needsYou(items, now, opts) {
    const o = opts || {};
    const byId = o.byId || index(items);
    const out = [], folded = new Set();
    const consider = (it, reason, score) => out.push({ item: it, reason, score });
    items.forEach((it) => {
      if (!isOpen(it, now) || it.type === 'email' || it.type === 'person' || it.type === 'organisation') return;
      const w = whenOf(it), base = importance(it);
      const dd = w ? (w - now) / DAY : null;
      if (it.type === 'bill') {
        if (w ? dd <= 7 : now - (it.createdAt || 0) <= 10 * DAY) consider(it, w ? (dd < 0 ? 'Overdue' : 'Due ' + whenText(it, now)) : 'Unpaid', base + 25 + (w ? Math.max(0, 7 - dd) * 4 : 0));
      } else if (it.type === 'deadline' || it.type === 'appointment') {
        if (w && dd >= -2 && dd <= 3) consider(it, dd < 0 ? 'Overdue' : whenText(it, now), base + 20 + Math.max(0, 3 - dd) * 6);
      } else if (it.type === 'task') {
        if (!w || startOfDay(w) <= startOfDay(now)) consider(it, w ? (w < now && !timed(it) && startOfDay(w) < startOfDay(now) ? 'Overdue' : whenText(it, now)) : 'Your task', base + 30 + (w && w < now ? 15 : 0));
      } else if (it.type === 'booking' || it.type === 'ticket') {
        if (w && dd >= -0.25 && dd <= 2) consider(it, whenText(it, now), base + 20);
      } else if (it.type === 'delivery') {
        if (now - (it.updatedAt || it.createdAt || 0) <= 5 * DAY) consider(it, 'On its way', base);
      }
    });
    out.forEach((x) => relatedOf(x.item, byId, 'email').forEach((e) => folded.add(e.id)));
    items.forEach((it) => {
      if (it.type !== 'email' || !isOpen(it, now) || folded.has(it.id) || isSent(it)) return;
      const g = emailGroup(it); const band = it.classification && it.classification.band;
      if (g !== 'needs' || now - (it.createdAt || 0) > 14 * DAY) return;
      if (band !== 'high' && !(band === 'normal' && it.classification && it.classification.action)) return;
      consider(it, (it.classification && it.classification.action === 'reply') ? 'Waiting for your reply' : TYPE_LABEL[ctype(it)] || 'Email', importance(it) + (it.pinned ? 30 : 0));
    });
    out.forEach((x) => { if (x.item.pinned) x.score += 30; x.related = relatedOf(x.item, byId, 'email').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); });
    return out.sort((a, b) => b.score - a.score);
  }

  function nowCard(items, now) {
    const cands = items.filter((it) => isOpen(it, now) && timed(it) && whenOf(it) && ['appointment', 'booking', 'ticket', 'event', 'task', 'deadline'].includes(it.type))
      .map((it) => ({ it, w: whenOf(it) })).filter((x) => x.w >= now - 30 * MIN && x.w <= now + 2 * HOUR).sort((a, b) => a.w - b.w);
    if (!cands.length) return null;
    const { it, w } = cands[0];
    const mins = Math.round((w - now) / MIN);
    return { item: it, at: w, label: mins > 0 ? `In ${mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min'}` : mins > -5 ? 'Now' : `Started ${-mins} min ago` };
  }

  function dayItems(items, day, now) {
    const a = startOfDay(day), b = addDays(a, 1);
    return items.filter((it) => it.type !== 'email' && it.type !== 'person' && it.type !== 'organisation' && !isSnoozed(it, now) && it.status !== 'dismissed')
      .filter((it) => { const w = whenOf(it); return w && w >= a && w < b; })
      .sort((x, y) => whenOf(x) - whenOf(y));
  }

  function comingUp(items, now, days) {
    const a = addDays(startOfDay(now), 1), b = addDays(a, days || 7);
    return items.filter((it) => isOpen(it, now) && DATED.has(it.type)).filter((it) => { const w = whenOf(it); return w && w >= a && w < b; })
      .sort((x, y) => whenOf(x) - whenOf(y));
  }

  function eveningWrap(items, actions, now, dayEndHour) {
    const end = new Date(now); if (end.getHours() < (dayEndHour || 18)) return null;
    const d0 = startOfDay(now);
    const doneIds = new Set((actions || []).filter((a) => !a.undone && a.kind === 'done' && a.at >= d0).map((a) => a.itemId));
    const doneToday = items.filter((it) => doneIds.has(it.id));
    const stillOpen = needsYou(items, now).map((x) => x.item);
    const tomorrow = dayItems(items, addDays(d0, 1), now).filter((it) => isOpen(it, now));
    return { done: doneToday, open: stillOpen, firstTomorrow: tomorrow[0] || null };
  }

  /** The Brief: short sentences, each one pointing at the Items it counts. Nothing without a source. */
  function brief(items, now, opts) {
    const o = opts || {};
    const nd = o.needs || needsYou(items, now);
    const parts = [];
    const bills = nd.filter((x) => x.item.type === 'bill');
    const replies = nd.filter((x) => x.item.type === 'email');
    const today = dayItems(items, now, now).filter((it) => isOpen(it, now));
    const timedToday = today.filter(timed);
    if (!nd.length && !today.length) return { parts: [{ text: 'Nothing needs you today.', ids: [] }], clear: true };
    if (timedToday.length) parts.push({ text: `${timedToday.length} ${timedToday.length === 1 ? 'thing' : 'things'} on your schedule, first at ${hm(whenOf(timedToday[0]))}`, ids: timedToday.map((x) => x.id) });
    if (bills.length) {
      const byCur = {}; bills.forEach((x) => { const a = amountOf(x.item); if (a) byCur[a.currency] = (byCur[a.currency] || 0) + a.value; });
      const tot = Object.entries(byCur).map(([c, v]) => fmtMoney(v, c)).join(' + ');
      parts.push({ text: `${bills.length} ${bills.length === 1 ? 'bill' : 'bills'} to pay${tot ? ' (' + tot + ')' : ''}`, ids: bills.map((x) => x.item.id) });
    }
    if (replies.length) parts.push({ text: `${replies.length} ${replies.length === 1 ? 'message waits' : 'messages wait'} for you`, ids: replies.map((x) => x.item.id) });
    const rest = nd.filter((x) => x.item.type !== 'bill' && x.item.type !== 'email' && !today.includes(x.item));
    if (rest.length) parts.push({ text: `${rest.length} more ${rest.length === 1 ? 'thing needs' : 'things need'} you`, ids: rest.map((x) => x.item.id) });
    return { parts, clear: false };
  }

  function todayView(items, now, opts) {
    const o = opts || {};
    const byId = index(items);
    const nd = needsYou(items, now, { byId });
    return {
      now: nowCard(items, now),
      brief: brief(items, now, { needs: nd }),
      needs: nd,
      strip: dayItems(items, now, now),
      coming: comingUp(items, now, 7),
      evening: eveningWrap(items, o.actions || [], now, o.dayEndHour)
    };
  }

  // ---------- Inbox ----------
  function inboxView(items, now, opts) {
    const o = opts || {};
    let emails = items.filter((it) => it.type === 'email' && !isSnoozed(it, now));
    if (o.source && o.source !== 'all') emails = emails.filter((it) => (it.sources || []).some((s) => s.app === o.source));
    if (o.query) { const q = o.query.toLowerCase(); emails = emails.filter((it) => `${it.title} ${it.description} ${sender(it)} ${(it.extractedFacts || []).map((f) => f.value).join(' ')}`.toLowerCase().includes(q)); }
    const showDone = !!o.showDone;
    const groups = { needs: [], waiting: [], money: [], travel: [], documents: [], updates: [] };
    emails.forEach((it) => { if (!showDone && !isOpen(it, now)) return; const g = emailGroup(it); if (g !== 'waiting') groups[g].push(it); });
    groups.waiting = waitingOn(emails, now);
    const sort = o.sort || 'importance';
    const cmp = sort === 'newest' ? (a, b) => (b.createdAt || 0) - (a.createdAt || 0) : (a, b) => (importance(b) - importance(a)) || ((b.createdAt || 0) - (a.createdAt || 0));
    Object.keys(groups).forEach((k) => { if (k !== 'waiting') groups[k].sort(cmp); });
    // Updates: grouped by sender, newest first, collapsed
    const bySender = new Map();
    groups.updates.forEach((it) => { const k = senderKey(it) || it.id; if (!bySender.has(k)) bySender.set(k, { key: k, name: sender(it) || k, items: [] }); bySender.get(k).items.push(it); });
    const updates = [...bySender.values()].map((g) => ({ ...g, items: g.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), latest: Math.max(...g.items.map((x) => x.createdAt || 0)) })).sort((a, b) => b.latest - a.latest);
    const sources = [...new Set(items.filter((it) => it.type === 'email').flatMap((it) => (it.sources || []).map((s) => s.app)))];
    return { groups, updates, sources, counts: { needs: groups.needs.length, updates: groups.updates.length } };
  }

  // ---------- People ----------
  function peopleView(items, now) {
    const byId = index(items);
    const ppl = items.filter((it) => it.type === 'person' || it.type === 'organisation');
    const rows = ppl.map((p) => {
      const mails = relatedOf(p, byId, 'email').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const open = mails.filter((m) => isOpen(m, now) && emailGroup(m) === 'needs' && !isSent(m) && (m.classification?.band !== 'low'));
      const derived = mails.flatMap((m) => relatedOf(m, byId)).filter((x) => x.type !== 'person' && x.type !== 'organisation' && x.type !== 'email' && isOpen(x, now));
      const oldest = open.length ? Math.min(...open.map((m) => m.createdAt || now)) : null;
      return { item: p, mails, open, derived: [...new Map(derived.map((d) => [d.id, d])).values()], oldestOpen: oldest, last: mails[0] ? mails[0].createdAt : 0 };
    });
    const waitingYou = rows.filter((r) => r.item.type === 'person' && r.open.length).sort((a, b) => a.oldestOpen - b.oldestOpen);
    const waitingThem = waitingOn(items, now).map((m) => ({ item: m, to: (m.meta && m.meta.to) || '', since: m.createdAt }));
    return {
      waitingYou, waitingThem,
      pinned: rows.filter((r) => r.item.pinned).sort((a, b) => b.last - a.last),
      people: rows.filter((r) => r.item.type === 'person').sort((a, b) => b.last - a.last),
      organisations: rows.filter((r) => r.item.type === 'organisation').sort((a, b) => b.last - a.last)
    };
  }
  function personPage(items, personId, now) {
    const byId = index(items); const p = byId.get(personId); if (!p) return null;
    const mails = relatedOf(p, byId, 'email').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const derived = new Map(); mails.forEach((m) => relatedOf(m, byId).forEach((x) => { if (!['email', 'person', 'organisation'].includes(x.type)) derived.set(x.id, x); }));
    return { item: p, open: [...derived.values()].filter((x) => isOpen(x, now)).concat(mails.filter((m) => isOpen(m, now) && emailGroup(m) === 'needs')), messages: mails.slice(0, 20), notes: p.notes || [], email: (p.extractedEntities?.emails || [])[0] || (p.description && p.description.includes('@') ? p.description : '') };
  }

  // ---------- Plan ----------
  function planView(items, day, now, opts) {
    const o = opts || {};
    const days = o.days || 1;
    const cols = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(startOfDay(day), i);
      const its = dayItems(items, d, now);
      cols.push({ day: d, timed: its.filter(timed), allDay: its.filter((x) => !timed(x)) });
    }
    // unplaced tray: open tasks and deadlines without a planned time, by due date then importance
    const tray = items.filter((it) => isOpen(it, now) && (it.type === 'task' || it.type === 'deadline') && !Number.isFinite(it.plannedAt))
      .sort((a, b) => ((a.dueAt || Infinity) - (b.dueAt || Infinity)) || (importance(b) - importance(a)));
    return { cols, tray, conflicts: cols.flatMap((c) => conflicts(c.timed)) };
  }
  const durationOf = (it) => (Number.isFinite(it.plannedMinutes) ? it.plannedMinutes : it.type === 'deadline' ? 0 : it.type === 'task' ? 30 : it.type === 'booking' || it.type === 'ticket' ? 90 : 60) * MIN;
  function conflicts(timedItems) {
    const out = [], xs = timedItems.filter((x) => durationOf(x) > 0).map((x) => ({ it: x, a: whenOf(x), b: whenOf(x) + durationOf(x) })).sort((p, q) => p.a - q.a);
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length && xs[j].a < xs[i].b; j++) out.push({ a: xs[i].it, b: xs[j].it, at: xs[j].a });
    return out;
  }
  /** Free gaps in a day between the user's day start and end (minutes ≥ min). */
  function freeGaps(items, day, now, rhythm, minMinutes) {
    const r = rhythm || {};
    const d = startOfDay(day);
    const startH = r.dayStart ?? 8, endH = r.dayEnd ?? 18;
    let a = d + startH * HOUR, b = d + endH * HOUR;
    if (startOfDay(now) === d) a = Math.max(a, Math.ceil(now / (15 * MIN)) * 15 * MIN);
    const busy = dayItems(items, d, now).filter(timed).filter((x) => x.status !== 'done').map((x) => [whenOf(x) - 10 * MIN, whenOf(x) + durationOf(x) + 10 * MIN]).sort((p, q) => p[0] - q[0]);
    const gaps = []; let t = a;
    busy.forEach(([s, e]) => { if (s > t) gaps.push([t, Math.min(s, b)]); t = Math.max(t, e); });
    if (t < b) gaps.push([t, b]);
    return gaps.filter(([s, e]) => e - s >= (minMinutes || 15) * MIN).map(([s, e]) => ({ start: s, end: e, minutes: Math.round((e - s) / MIN) }));
  }
  /**
   * Suggest a plan (rule-based, no AI): put unplaced tasks/deadlines due soonest into today's free gaps,
   * focus-hour gaps first; says honestly when the day is too full.
   */
  function suggestPlan(items, day, now, rhythm) {
    const r = rhythm || {};
    const { tray } = planView(items, day, now);
    const gaps = freeGaps(items, day, now, r, 25).map((g) => ({ ...g, focus: r.focusStart != null && startOfDay(g.start) + r.focusStart * HOUR <= g.start && g.start < startOfDay(g.start) + (r.focusEnd ?? r.focusStart + 3) * HOUR }));
    gaps.sort((a, b) => (b.focus - a.focus) || (a.start - b.start));
    const blocks = [], left = [];
    tray.filter((it) => it.type === 'task' || (it.dueAt && it.dueAt - now < 3 * DAY)).forEach((it) => {
      const need = Number.isFinite(it.plannedMinutes) ? it.plannedMinutes : 30;
      const g = gaps.find((x) => x.minutes >= need);
      if (!g) { left.push(it); return; }
      blocks.push({ item: it, at: g.start, minutes: need });
      g.start += (need + 10) * MIN; g.minutes -= need + 10;
    });
    const needMin = blocks.reduce((s, b) => s + b.minutes, 0) + left.reduce((s, it) => s + (it.plannedMinutes || 30), 0);
    const freeMin = freeGaps(items, day, now, r, 25).reduce((s, g) => s + g.minutes, 0);
    return { blocks: blocks.sort((a, b) => a.at - b.at), left, overfull: left.length > 0, needMinutes: needMin, freeMinutes: freeMin };
  }

  // ---------- Money ----------
  /**
   * Read-time settlement (v107): a bill counts as paid when a payment confirmation from the same sender (same organisation
   * or the same e-mail domain) for the same amount arrived after it (within 120 days). Nothing is written: the bill shows
   * as paid with the confirming email as its source, and a bill the user reopened is left alone.
   */
  function applySettlements(items) {
    const byId = index(items);
    const domainOf = (it) => { for (const id of it.relatedItemIds || []) { const e = byId.get(id); if (e && e.type === 'email' && e.extractedEntities && e.extractedEntities.senderDomain) return String(e.extractedEntities.senderDomain).toLowerCase().split('.').slice(-2).join('.'); } return null; };
    const orgsOf = (it) => (it.relatedItemIds || []).filter((id) => (byId.get(id) || {}).type === 'organisation');
    const confirms = items.filter((it) => it.type === 'transaction' && it.meta && it.meta.confirmsPayment && amountOf(it));
    if (!confirms.length) return items;
    const settled = new Map();
    items.forEach((b) => {
      if (b.type !== 'bill' || b.status === 'done' || b.status === 'dismissed') return;
      if ((b.actionHistory || []).some((h) => h.kind === 'reopen')) return;
      const a = amountOf(b); if (!a) return;
      const bo = orgsOf(b), bd = domainOf(b);
      const tx = confirms.find((t) => { const ta = amountOf(t); if (!ta || Math.abs(ta.value - a.value) > 0.01 || (ta.currency || '') !== (a.currency || '')) return false;
        const same = orgsOf(t).some((o) => bo.includes(o)) || (bd && domainOf(t) === bd); if (!same) return false;
        const dt = (t.createdAt || 0) - (b.createdAt || 0); return dt >= -DAY && dt <= 120 * DAY; });
      if (tx) settled.set(b.id, tx);
    });
    if (!settled.size) return items;
    return items.map((it) => settled.has(it.id) ? Object.assign({}, it, { status: 'done', meta: Object.assign({}, it.meta, { settledBy: settled.get(it.id).id, settledAt: settled.get(it.id).createdAt }) }) : it);
  }

  function money(items, monthStart, now) {
    const m0 = new Date(monthStart); m0.setDate(1); m0.setHours(0, 0, 0, 0);
    const a = m0.getTime(), b = new Date(m0.getFullYear(), m0.getMonth() + 1, 1).getTime();
    const inMonth = (t) => t && t >= a && t < b;
    const bills = items.filter((it) => it.type === 'bill' && it.status !== 'dismissed');
    const monthBills = bills.filter((it) => inMonth(it.dueAt || it.createdAt));
    const sumBy = (list) => { const o = {}; list.forEach((it) => { const am = amountOf(it); if (am) o[am.currency || ''] = (o[am.currency || ''] || 0) + am.value; }); return o; };
    const due = sumBy(monthBills), paid = sumBy(monthBills.filter((x) => x.status === 'done'));
    const curs = Object.keys(due).sort((x, y) => due[y] - due[x]);
    const txCur = {}; items.forEach((it) => { if (it.type === 'transaction' && inMonth(it.createdAt)) { const am = amountOf(it); if (am && am.currency) txCur[am.currency] = (txCur[am.currency] || 0) + 1; } });
    const main = curs[0] || Object.keys(txCur).sort((x, y) => txCur[y] - txCur[x])[0] || ''; // a month without bills still shows its spending
    const dueSoon = bills.filter((it) => isOpen(it, now)).sort((x, y) => (x.dueAt || Infinity) - (y.dueAt || Infinity));
    // subscriptions with price history from their source emails' amount facts
    const subs = items.filter((it) => it.type === 'subscription' && it.status !== 'dismissed').map((it) => {
      const hist = facts(it, 'amount').map((f) => ({ value: Number(f.value), src: f.sourceItemId })).filter((x) => Number.isFinite(x.value));
      const byId = index(items);
      hist.forEach((h) => { const e = byId.get(h.src); h.at = e ? e.createdAt : 0; });
      hist.sort((p, q) => p.at - q.at);
      const rose = hist.length >= 2 && hist[hist.length - 1].value > hist[hist.length - 2].value;
      const latest = hist.length ? { value: hist[hist.length - 1].value, currency: amountOf(it)?.currency || '' } : amountOf(it);
      return { item: it, amount: latest, history: hist, flags: rose ? ['Price went up'] : [] };
    });
    // spending by category from payments/receipts this month
    const CAT = { food: 'Food & delivery', receipt: 'Shopping', payment: 'Payments', refund: 'Refunds', subscription: 'Subscriptions', bill: 'Bills' };
    const tx = items.filter((it) => it.type === 'transaction' && inMonth(it.createdAt) && it.status !== 'dismissed');
    const refs = new Set(); tx.forEach((it) => { if (!(it.meta && it.meta.taxDocFor)) facts(it, 'reference').forEach((f) => refs.add(String(f.value).toLowerCase())); });
    const spendTx = tx.filter((it) => !(it.meta && (it.meta.ownTransfer || it.meta.category === 'transfer')) // moving money between your own accounts is not spending
      && !(it.meta && it.meta.taxDocFor && refs.has(String(it.meta.taxDocFor).toLowerCase()))); // a tax document for an order already counted
    const cats = {};
    spendTx.forEach((it) => { const am = amountOf(it); if (!am || (am.currency || '') !== main) return; const k = CAT[(it.meta && it.meta.category) || 'receipt'] || 'Other'; if (!cats[k]) cats[k] = { name: k, total: 0, items: [] }; cats[k].total += (it.meta && it.meta.category === 'refund' ? -1 : 1) * am.value; cats[k].items.push(it); });
    const spending = Object.values(cats).sort((p, q) => q.total - p.total);
    const other = curs.slice(1).map((c) => ({ currency: c, due: due[c], paid: paid[c] || 0 }));
    return { month: a, currency: main, due: due[main] || 0, paid: paid[main] || 0, otherCurrencies: other, dueSoon, monthBills, subscriptions: subs, spending, transactions: tx.sort((p, q) => (q.createdAt || 0) - (p.createdAt || 0)) };
  }
  /** Bills from the same merchant (via the merchant link), newest first — the "history" in a bill sheet. */
  function billHistory(items, billId) {
    const byId = index(items); const b = byId.get(billId); if (!b) return [];
    const orgs = relatedOf(b, byId, 'organisation').map((o) => o.id);
    return items.filter((x) => (x.type === 'bill' || x.type === 'transaction') && x.id !== billId && (x.relatedItemIds || []).some((id) => orgs.includes(id)))
      .sort((p, q) => ((q.dueAt || q.createdAt) - (p.dueAt || p.createdAt))).slice(0, 6);
  }

  // ---------- Wallet ----------
  function wallet(items, now) {
    const passes = items.filter((it) => ['booking', 'ticket', 'document', 'warranty'].includes(it.type) && it.status !== 'dismissed');
    const future = (it) => { const w = whenOf(it); return w && w >= now - 6 * HOUR; };
    const travel = passes.filter((it) => (it.type === 'booking' || (it.type === 'ticket' && (it.meta?.walletKind || 'tickets') === 'tickets')) && future(it)).sort((a, b) => whenOf(a) - whenOf(b));
    // trips: bookings/tickets within 3 days of each other form one trip
    const trips = [];
    travel.forEach((it) => { const w = whenOf(it); const t = trips[trips.length - 1]; if (t && w - t.end <= 3 * DAY) { t.items.push(it); t.end = Math.max(t.end, w); } else trips.push({ start: w, end: w, items: [it] }); });
    trips.forEach((t) => { t.title = t.items.length > 1 ? `${t.items.length} bookings` : t.items[0].title; t.place = t.items.map((x) => fact(x, 'to') || x.meta?.to).filter(Boolean).pop() || ''; });
    const upNext = travel[0] || passes.filter((it) => it.type === 'ticket' && future(it)).sort((a, b) => whenOf(a) - whenOf(b))[0] || null;
    const events = passes.filter((it) => it.type === 'ticket' && (it.meta?.walletKind === 'others' || /concert|cinema|match|festival|conference|theatre|theater|museum/i.test(it.title))).sort((a, b) => (whenOf(a) || Infinity) - (whenOf(b) || Infinity));
    const documents = passes.filter((it) => it.type === 'document').map((it) => { const exp = Number(it.meta?.expiresAt) || null; const days = exp ? Math.ceil((exp - now) / DAY) : null; return { item: it, expiresAt: exp, expiresInDays: days, warn: days != null && days <= 90 }; });
    const coupons = passes.filter((it) => it.meta?.walletKind === 'coupons');
    const warranties = passes.filter((it) => it.type === 'warranty');
    const past = passes.filter((it) => (it.type === 'booking' || it.type === 'ticket') && whenOf(it) && whenOf(it) < now - 6 * HOUR).sort((a, b) => whenOf(b) - whenOf(a));
    return { upNext, trips, events, documents, coupons, warranties, past, count: passes.length };
  }

  // ---------- badges ----------
  function badges(items, now) {
    const t = todayView(items, now);
    const inbox = inboxView(items, now);
    const m = money(items, now, now);
    const w = wallet(items, now);
    return {
      today: t.needs.length,
      inbox: inbox.groups.needs.length,
      plan: planView(items, now, now).tray.filter((x) => x.dueAt && startOfDay(x.dueAt) <= startOfDay(now)).length,
      money: m.dueSoon.filter((b) => b.dueAt && b.dueAt - now <= 7 * DAY).length,
      wallet: w.trips.filter((x) => x.start - now <= 3 * DAY).length + w.documents.filter((d) => d.warn).length
    };
  }

  // ---------- search + Ask ----------
  function search(items, q, opts) {
    const words = String(q || '').toLowerCase().split(/[^\p{L}\p{N}@.]+/u).filter((w) => w.length > 1 && !STOP.has(w));
    if (!words.length) return [];
    const scored = items.filter((it) => !(opts && opts.excludeTypes || []).includes(it.type)).map((it) => {
      const hay = `${it.title} ${it.description} ${sender(it)} ${(it.extractedFacts || []).map((f) => f.value).join(' ')} ${KIND_LABEL[it.type] || ''} ${TYPE_LABEL[ctype(it)] || ''}`.toLowerCase();
      let s = 0; words.forEach((w) => { if (hay.includes(w)) s += String(it.title).toLowerCase().includes(w) ? 3 : 1; });
      return { it, s };
    }).filter((x) => x.s > 0);
    return scored.sort((a, b) => (b.s - a.s) || ((b.it.createdAt || 0) - (a.it.createdAt || 0))).slice(0, (opts && opts.limit) || 20).map((x) => x.it);
  }
  const STOP = new Set(['the', 'a', 'an', 'my', 'me', 'i', 'is', 'are', 'what', 'when', 'did', 'do', 'does', 'about', 'say', 'said', 'of', 'to', 'for', 'from', 'in', 'on', 'and', 'or', 'have', 'has', 'any', 'show', 'find', 'with', 'was', 'were', 'which', 'who', 'how', 'much']);

  /**
   * Answer common questions from the graph alone (no AI). Returns { text, ids, items, intent } or null.
   * Every answer lists the Items it is built from.
   */
  function askLocal(items, q, now) {
    const s = String(q || '').toLowerCase().trim();
    if (!s) return null;
    const list = (its, text, intent) => ({ text, ids: its.map((x) => x.id), items: its, intent });
    if (/\b(my day|today|what('?s| is) (on|up)|agenda|schedule)\b/.test(s) && !/tomorrow/.test(s)) {
      const t = todayView(items, now); const its = [...t.strip.filter((x) => isOpen(x, now)), ...t.needs.map((x) => x.item).filter((x) => !t.strip.includes(x))];
      return list(its.slice(0, 10), its.length ? t.brief.parts.map((p) => p.text).join('. ') + '.' : 'Nothing is scheduled and nothing needs you today.', 'day');
    }
    if (/\btomorrow\b/.test(s)) { const its = dayItems(items, addDays(now, 1), now).filter((x) => isOpen(x, now)); return list(its, its.length ? `Tomorrow: ${its.length} ${its.length === 1 ? 'item' : 'items'}${its.filter(timed).length ? ', first at ' + hm(whenOf(its.filter(timed)[0])) : ''}.` : 'Nothing is planned for tomorrow.', 'tomorrow'); }
    if (/\b(bills?|pay|owe|due|invoice)\b/.test(s)) { const m = money(items, now, now); const its = m.dueSoon; const sum = {}; its.forEach((b) => { const a = amountOf(b); if (a) sum[a.currency] = (sum[a.currency] || 0) + a.value; }); return list(its, its.length ? `${its.length} unpaid ${its.length === 1 ? 'bill' : 'bills'}: ${Object.entries(sum).map(([c, v]) => fmtMoney(v, c)).join(' + ') || 'amounts unknown'}.` : 'No unpaid bills found in your email.', 'bills'); }
    if (/\b(subscriptions?|renew)/.test(s)) { const its = items.filter((x) => x.type === 'subscription' && x.status !== 'dismissed'); return list(its, its.length ? `${its.length} ${its.length === 1 ? 'subscription' : 'subscriptions'} found in your email.` : 'No subscriptions found in your email.', 'subscriptions'); }
    if (/\b(waiting|reply|replied|respond|answer)\b/.test(s)) { const p = peopleView(items, now); const its = p.waitingYou.flatMap((r) => r.open).slice(0, 10); const them = p.waitingThem.map((x) => x.item); return list([...its, ...them], `${its.length} ${its.length === 1 ? 'message waits' : 'messages wait'} for your reply${them.length ? `; you are waiting on ${them.length} ${them.length === 1 ? 'reply' : 'replies'}` : ''}.`, 'waiting'); }
    if (/\b(trip|flight|train|travel|booking|ticket|hotel)s?\b/.test(s)) { const w = wallet(items, now); const its = w.trips.flatMap((t) => t.items); return list(its, its.length ? `${w.trips.length} upcoming ${w.trips.length === 1 ? 'trip' : 'trips'} with ${its.length} ${its.length === 1 ? 'booking' : 'bookings'}${w.upNext ? '; next: ' + w.upNext.title + ' ' + whenText(w.upNext, now) : ''}.` : 'No upcoming trips or bookings found.', 'travel'); }
    if (/\b(deadline|due|exam|submit)\b/.test(s)) { const its = items.filter((x) => x.type === 'deadline' && isOpen(x, now) && x.dueAt && x.dueAt >= now - DAY).sort((a, b) => a.dueAt - b.dueAt); return list(its, its.length ? `${its.length} open ${its.length === 1 ? 'deadline' : 'deadlines'}; next: ${its[0].title} (${whenText(its[0], now)}).` : 'No open deadlines found.', 'deadlines'); }
    if (/\b(deliver|parcel|package|order)/.test(s)) { const its = items.filter((x) => x.type === 'delivery' && isOpen(x, now)); return list(its, its.length ? `${its.length} ${its.length === 1 ? 'delivery' : 'deliveries'} on the way.` : 'No deliveries on the way.', 'deliveries'); }
    const hits = search(items, s, { excludeTypes: ['person', 'organisation'] });
    return hits.length ? list(hits.slice(0, 8), `Found ${hits.length} ${hits.length === 1 ? 'item' : 'items'} matching “${q}”.`, 'search') : { text: `Nothing in your Daylight matches “${q}”.`, ids: [], items: [], intent: 'search' };
  }

  /** What may be sent to an AI for Ask: metadata only, never identity documents, never bodies. */
  function aiContext(items, now, limit) {
    return items.filter((it) => !it.aiExclude && it.privacyClass !== 'identity' && it.type !== 'person' && it.type !== 'organisation')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit || 60)
      .map((it) => ({ id: it.id, kind: it.type, type: ctype(it) || undefined, title: String(it.title || '').slice(0, 120), from: sender(it) ? String(sender(it)).slice(0, 60) : undefined,
        when: whenOf(it) ? new Date(whenOf(it)).toISOString().slice(0, 16) : undefined, status: it.status, amount: amountOf(it) ? fmtMoney(amountOf(it).value, amountOf(it).currency) : undefined }));
  }
  /** Keep only AI sentences that cite Item ids that exist in the context we sent. */
  function verifyCited(answer, allowedIds) {
    const ok = new Set(allowedIds);
    const sentences = Array.isArray(answer && answer.sentences) ? answer.sentences : [];
    return sentences.map((x) => ({ text: String(x && x.text || '').trim(), ids: (Array.isArray(x && x.ids) ? x.ids : []).filter((id) => ok.has(id)) }))
      .filter((x) => x.text && x.ids.length);
  }

  const api = {
    MIN, HOUR, DAY, TYPE_LABEL, KIND_LABEL, NEEDS, UPDATES,
    startOfDay, addDays, fact, ctype, importance, isOpen, isSnoozed, whenOf, timed, amountOf, sender, fmtMoney, dayLabel, hm, whenText, ago, index,
    emailGroup, waitingOn, primaryAction, needsYou, nowCard, dayItems, comingUp, eveningWrap, brief, todayView,
    inboxView, peopleView, personPage, planView, conflicts, freeGaps, suggestPlan, durationOf, money, billHistory, wallet, badges,
    search, askLocal, aiContext, verifyCited, applySettlements
  };
  root.DaylightV2Model = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
