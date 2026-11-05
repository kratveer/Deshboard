/**
 * Daylight V2 SAMPLE DATA — for "Try with sample data" only.
 * Loaded into an in-memory graph that is never saved; the app shows a "Sample data" banner the whole time.
 * Every name, amount and booking below is invented. Nothing here is ever mixed with a real account.
 */
(function (root) {
  'use strict';
  function build(now) {
    const H = 3600000, D = 86400000;
    const day0 = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const at = (dayOff, h, m) => day0 + dayOff * D + (h || 0) * H + (m || 0) * 60000;
    const items = [], links = [];
    const G = root.DaylightItemGraph;
    const id = (k) => G.itemId(k);
    let n = 0;
    const mail = (o) => {
      const mid = 'sample' + (++n);
      const k = `gmail:sample:${mid}`;
      items.push({ key: k, accountId: 'sample', type: 'email', title: o.subject, description: o.snippet || '', createdAt: o.at, priority: o.importance,
        sources: [{ app: 'gmail', accountId: 'sample', itemId: mid, url: null, role: 'primary' }],
        classification: { type: o.type, importance: o.importance, band: o.importance >= 60 ? 'high' : o.importance >= 30 ? 'normal' : 'low', reasons: o.reasons || ['sample data'], action: o.action || null },
        extractedEntities: { senderName: o.name, senderEmail: o.email, senderDomain: o.email.split('@')[1], references: o.ref ? [o.ref] : [] },
        extractedFacts: (o.facts || []).map(([key, value]) => ({ key, value, sourceItemId: id(k), method: 'rule' })),
        meta: { threadId: o.thread || mid, from: `${o.name} <${o.email}>`, to: o.to || '', labels: o.sent ? ['SENT'] : ['INBOX'], unread: !!o.unread } });
      const org = o.org !== false && !/gmail|seznam|outlook/.test(o.email);
      const pk = org ? `org:${o.email.split('@')[1]}` : `person:${o.email}`;
      if (!o.sent) { items.push({ key: pk, accountId: 'sample', type: org ? 'organisation' : 'person', title: o.name, description: org ? o.email.split('@')[1] : o.email, sources: [{ app: 'gmail', accountId: 'sample', itemId: mid, role: 'mention' }], extractedEntities: org ? { domains: [o.email.split('@')[1]] } : { emails: [o.email] } }); links.push([id(k), id(pk), 'from']); }
      return { key: k, id: id(k), mid, pk };
    };
    const derived = (from, o) => { items.push(Object.assign({ accountId: 'sample', sources: [{ app: 'gmail', accountId: 'sample', itemId: from.mid, role: 'evidence' }] }, o, { extractedFacts: (o.facts || []).map(([key, value]) => ({ key, value, sourceItemId: from.id, method: 'rule' })) })); delete items[items.length - 1].facts; links.push([from.id, id(o.key), 'evidence']); if (o.merchant) links.push([id(o.key), id(from.pk), 'merchant']); };

    // people waiting
    const m1 = mail({ subject: 'Slides for Thursday?', snippet: 'Could you send me the slides by Wednesday evening? I want to check the figures before the group meeting.', name: 'Petra Nováková', email: 'petra.novakova@seznam.cz', at: now - 5 * H, type: 'personal', importance: 76, action: 'reply', reasons: ['+15 asks you to do something', '+10 from a person'] });
    const m2 = mail({ subject: 'Re: Lab booking next week', snippet: 'Is Tuesday 10:00 still fine for you? Let me know and I will confirm the room.', name: 'Martin Dvořák', email: 'martin.dvorak@gmail.com', at: now - 26 * H, type: 'university_work', importance: 64, action: 'reply' });
    mail({ subject: 'Draft chapter 3 — comments', snippet: 'Sending the draft now, would be great to hear back by Friday.', name: 'You', email: 'me@gmail.com', to: 'Jan Novák', at: now - 3 * D, type: 'follow_up', importance: 42, sent: true, thread: 'th-ch3' });
    // bills
    const b1 = mail({ subject: 'Your electricity bill for October', snippet: 'Amount due 1 840 CZK, due 8 Nov. Variable symbol 2026110.', name: 'ČEZ Prodej', email: 'faktury@cez.cz', at: now - 2 * D, type: 'invoice', importance: 71, action: 'pay', facts: [['amount', 1840], ['currency', 'CZK'], ['dueDate', new Date(at(3)).toISOString().slice(0, 10)], ['reference', '2026110']] });
    derived(b1, { key: 'money:sample:cez:2026110', type: 'bill', title: 'ČEZ Prodej · 1840 CZK', description: 'Electricity, October', dueAt: at(3, 23, 59), priority: 71, facts: [['amount', 1840], ['currency', 'CZK'], ['reference', '2026110'], ['merchant', 'ČEZ Prodej']], merchant: true, meta: { category: 'bill' } });
    const b2 = mail({ subject: 'Invoice 4471 — internet November', snippet: 'Total 599 CZK due 14 Nov.', name: 'Vodafone', email: 'invoice@vodafone.cz', at: now - 4 * D, type: 'invoice', importance: 58, action: 'pay', facts: [['amount', 599], ['currency', 'CZK']] });
    derived(b2, { key: 'money:sample:vodafone:4471', type: 'bill', title: 'Vodafone · 599 CZK', description: 'Internet, November', dueAt: at(9, 23, 59), priority: 58, facts: [['amount', 599], ['currency', 'CZK'], ['reference', '4471'], ['merchant', 'Vodafone']], merchant: true, meta: { category: 'bill' } });
    const b0 = mail({ subject: 'Invoice 4398 — internet October', snippet: 'Total 549 CZK.', name: 'Vodafone', email: 'invoice@vodafone.cz', at: now - 34 * D, type: 'invoice', importance: 30, facts: [['amount', 549], ['currency', 'CZK']] });
    derived(b0, { key: 'money:sample:vodafone:4398', type: 'bill', title: 'Vodafone · 549 CZK', description: 'Internet, October', dueAt: at(-20, 23, 59), status: 'done', priority: 30, facts: [['amount', 549], ['currency', 'CZK'], ['reference', '4398'], ['merchant', 'Vodafone']], merchant: true, meta: { category: 'bill' } });
    // subscription with a price rise
    const s1 = mail({ subject: 'Your Spotify Premium receipt', snippet: '199 CZK charged. Renews 1 Dec.', name: 'Spotify', email: 'no-reply@spotify.com', at: now - 3 * D, type: 'subscription', importance: 32, facts: [['amount', 199], ['currency', 'CZK']] });
    const s0 = mail({ subject: 'Your Spotify Premium receipt', snippet: '179 CZK charged.', name: 'Spotify', email: 'no-reply@spotify.com', at: now - 33 * D, type: 'subscription', importance: 20, facts: [['amount', 179], ['currency', 'CZK']] });
    derived(s0, { key: 'sub:sample:spotify.com', type: 'subscription', title: 'Spotify · 179 CZK', description: 'Spotify Premium', priority: 30, facts: [['amount', 179], ['currency', 'CZK'], ['merchant', 'Spotify']], merchant: true, meta: { category: 'subscription' } });
    derived(s1, { key: 'sub:sample:spotify.com', type: 'subscription', title: 'Spotify · 199 CZK', description: 'Spotify Premium', dueAt: at(26), priority: 32, facts: [['amount', 199], ['currency', 'CZK'], ['merchant', 'Spotify']], merchant: true, meta: { category: 'subscription' } });
    // receipts / spending
    [['Wolt', 'info@wolt.com', 312, 'food', 1], ['Rohlík.cz', 'objednavky@rohlik.cz', 1268, 'food', 4], ['Alza.cz', 'info@alza.cz', 2490, 'receipt', 6], ['Zara', 'noreply@zara.com', 1590, 'receipt', 9], ['Bolt', 'receipts@bolt.eu', 186, 'payment', 2]].forEach(([nm, em, amt, cat, ago2]) => {
      const r = mail({ subject: `Your ${nm} receipt`, snippet: `Total ${amt} CZK`, name: nm, email: em, at: Math.max(day0 - (new Date(now).getDate() - 1) * D, now - ago2 * D), type: 'receipt', importance: 22, facts: [['amount', amt], ['currency', 'CZK']] });
      derived(r, { key: `money:sample:${em}:${amt}`, type: 'transaction', title: `${nm} · ${amt} CZK`, description: `Your ${nm} receipt`, createdAt: Math.max(day0 - (new Date(now).getDate() - 1) * D, now - ago2 * D), facts: [['amount', amt], ['currency', 'CZK'], ['merchant', nm]], merchant: true, meta: { category: cat } });
    });
    // deadline + appointment
    const d1 = mail({ subject: 'Thesis registration closes Friday', snippet: 'Register your thesis topic in SIS by Friday 14 Nov, 23:59.', name: 'Studijní oddělení MFF', email: 'studijni@mff.cuni.cz', at: now - 1 * D, type: 'university_work', importance: 68, action: 'complete' });
    derived(d1, { key: 'date:sample:th-reg:deadline', type: 'deadline', title: 'Register thesis topic in SIS', description: 'Register your thesis topic in SIS by Friday', dueAt: at(2, 23, 59), priority: 68, facts: [['date', new Date(at(2)).toISOString().slice(0, 10)]] });
    const a1 = mail({ subject: 'Dentist appointment confirmed', snippet: 'Your appointment is on Thursday at 15:30, Vinohradská 12.', name: 'Dental Clinic Vinohrady', email: 'recepce@dentalvinohrady.cz', at: now - 6 * D, type: 'appointment', importance: 52, action: 'attend' });
    derived(a1, { key: 'date:sample:dent:appointment', type: 'appointment', title: 'Dentist — Dental Clinic Vinohrady', description: 'Vinohradská 12', dueAt: at(0, new Date(now).getHours() + 1, 30), priority: 60, facts: [['date', new Date(at(0)).toISOString().slice(0, 10) + ' ' + String(new Date(now).getHours() + 1).padStart(2, '0') + ':30']] });
    // travel: train + hotel (one trip)
    const t1 = mail({ subject: 'Your ticket: Praha hl.n. → Wien Hbf', snippet: 'Departure Sat 07:12, coach 5 seat 46. Booking ABX42K.', name: 'ČD', email: 'eshop@cd.cz', at: now - 8 * D, type: 'booking', importance: 55, action: 'prepare', ref: 'ABX42K' });
    derived(t1, { key: 'booking:sample:ABX42K', type: 'booking', title: 'Train Praha → Wien', description: 'Coach 5, seat 46', dueAt: at(4, 7, 12), priority: 55, facts: [['reference', 'ABX42K'], ['start', new Date(at(4)).toISOString().slice(0, 10) + ' 07:12'], ['to', 'Wien']] });
    const t2 = mail({ subject: 'Booking confirmed — Hotel Am Stephansplatz', snippet: 'Check-in Sat from 15:00, 2 nights. Confirmation 88213.', name: 'Booking.com', email: 'noreply@booking.com', at: now - 8 * D, type: 'booking', importance: 50, ref: '88213' });
    derived(t2, { key: 'booking:sample:88213', type: 'booking', title: 'Hotel Am Stephansplatz', description: '2 nights', dueAt: at(4, 15, 0), priority: 50, facts: [['reference', '88213'], ['start', new Date(at(4)).toISOString().slice(0, 10) + ' 15:00'], ['to', 'Wien']] });
    // delivery
    const v1 = mail({ subject: 'Your parcel is on its way', snippet: 'Expected delivery tomorrow between 12:00 and 16:00.', name: 'Zásilkovna', email: 'info@zasilkovna.cz', at: now - 10 * H, type: 'delivery', importance: 34 });
    derived(v1, { key: 'delivery:sample:Z4471', type: 'delivery', title: 'Parcel from Alza.cz', description: 'Expected tomorrow 12:00–16:00', priority: 34, facts: [['reference', 'Z4471']] });
    // updates
    [['GitHub', 'notifications@github.com', 'social_notification', '[kratveer/Deshboard] New issue opened'], ['Medium Daily Digest', 'noreply@medium.com', 'newsletter', 'Top stories for you'], ['Zalando', 'news@zalando.cz', 'marketing', 'Black Friday early access — up to 70 % off'], ['LinkedIn', 'messages-noreply@linkedin.com', 'social_notification', 'You appeared in 12 searches this week'], ['Zalando', 'news@zalando.cz', 'marketing', 'New arrivals for you']].forEach(([nm, em, ty, subj], i) => mail({ subject: subj, snippet: '', name: nm, email: em, at: now - (i + 1) * 7 * H, type: ty, importance: 6 }));
    // a security alert
    mail({ subject: 'Security alert: new sign-in on Windows', snippet: 'We noticed a new sign-in to your Google Account on a Windows device.', name: 'Google', email: 'no-reply@accounts.google.com', at: now - 2 * H, type: 'urgent_action', importance: 70, action: 'review' });
    // local: tasks + wallet
    items.push({ key: 'task:sample:1', accountId: 'sample', type: 'task', title: 'Buy a birthday present for Anna', dueAt: at(0, 23, 59), sources: [{ app: 'daylight', accountId: 'sample', itemId: 't1' }], meta: { origin: 'v2' } });
    items.push({ key: 'task:sample:2', accountId: 'sample', type: 'task', title: 'Renew library books', dueAt: at(5, 23, 59), sources: [{ app: 'daylight', accountId: 'sample', itemId: 't2' }], meta: { origin: 'v2' } });
    items.push({ key: 'task:sample:3', accountId: 'sample', type: 'task', title: 'Write the methods section', sources: [{ app: 'daylight', accountId: 'sample', itemId: 't3' }], meta: { origin: 'v2' }, plannedMinutes: 90 });
    items.push({ key: 'wallet:sample:id', accountId: 'sample', type: 'document', title: 'Residence permit', description: 'Sample document', privacyClass: 'identity', aiExclude: true, sources: [{ app: 'wallet', accountId: 'sample', itemId: 'w1' }], meta: { origin: 'wallet', walletKind: 'documents', expiresAt: at(62) } });
    items.push({ key: 'wallet:sample:concert', accountId: 'sample', type: 'ticket', title: 'Concert — Rudolfinum', description: 'Row 7, seat 12', dueAt: at(11, 19, 30), sources: [{ app: 'wallet', accountId: 'sample', itemId: 'w2' }], meta: { origin: 'wallet', walletKind: 'others', timed: true } });
    return { items, links };
  }
  const api = { build };
  root.DaylightV2Sample = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
