/**
 * Labelled SYNTHETIC mailbox for V2 discovery: important mail in EVERY Gmail category, plus realistic noise volume.
 * All senders, people, amounts and references are invented.
 * Fields: id, threadId, cat (primary|updates|promotions|social|forums), important (truth), kind (truth type), from, subject, body, ageDays.
 * Hard cases: receipts and bookings filed under Promotions, an interview invite in Social, exam deadlines in Forums,
 * bills whose subject looks harmless, non-English mail, and important mail without money words.
 */
'use strict';
let n = 0;
const CAT = { primary: ['CATEGORY_PERSONAL'], updates: ['CATEGORY_UPDATES'], promotions: ['CATEGORY_PROMOTIONS'], social: ['CATEGORY_SOCIAL'], forums: ['CATEGORY_FORUMS'] };
function mk(cat, important, kind, from, subject, body, age, x) {
  n++;
  const id = 'v' + String(n).padStart(4, '0');
  const o = x || {};
  return { id, threadId: 't' + id, cat, important, kind, from, subject, body, snippet: body.replace(/\s+/g, ' ').slice(0, 140), labelIds: ['INBOX', ...CAT[cat], 'UNREAD'], ageDays: age, listUnsubscribe: !!o.lu, attachments: o.att || [], html: o.html || null, hard: o.hard || null };
}
const pdf = (name) => [{ name, mimeType: 'application/pdf', size: 64000 }];
const ld = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body>`;
const M = [];

// ---------- PRIMARY: people and direct requests (always fetched) ----------
M.push(
  mk('primary', true, 'request', 'Prof. Jan Novák <novak@fzu.cz>', 'Slides for Thursday', 'Hi Kratveer, could you send me the slides by Wednesday evening so I can review them? Thanks, Jan', 1),
  mk('primary', true, 'bill', 'Petr Novák <petr.novak@seznam.cz>', 'Nájem prosinec', 'Ahoj, nájem 18 500 Kč za prosinec prosím zaplať do 5. 12. Díky, Petr', 2),
  mk('primary', true, 'personal', 'Anita Sharma <anita.sharma@gmail.com>', 'Weekend plan', 'Are you free on Saturday? Let me know by Friday so I can book the table.', 3),
  mk('primary', true, 'deadline', 'Organic Letters <ol-editorial@acs.org>', 'Revision due: manuscript OL-2026-0123', 'Your revised manuscript is due on 20 November 2026. Please upload through the portal.', 4),
  mk('primary', true, 'personal', 'Mom <mom.singh@gmail.com>', 'Call me', 'Call me when you get a chance, nothing urgent.', 5),
  mk('primary', true, 'request', 'Li Wei <li.wei@ucl.ac.uk>', 'Data for the paper', 'Can you share the Wigner function data from last week? We need it for figure 3.', 6)
);

// ---------- UPDATES: transactional, accounts, study ----------
M.push(
  mk('updates', true, 'bill', 'ČEZ Prodej <faktury@cez.cz>', 'Vyúčtování elektřiny', 'Částka k úhradě 1 250 Kč, datum splatnosti 20. 11. 2026, variabilní symbol 4401928811.', 2),
  mk('updates', true, 'bill', 'Vodafone CZ <ebill@vodafone.cz>', 'Dokument k dispozici', 'Ve vašem účtu je nový dokument. Faktura 649 Kč, splatnost 18.11.2026.', 4, { hard: 'harmless subject' }),
  mk('updates', true, 'receipt', 'Wise <noreply@wise.com>', 'Your transfer is complete', 'You sent 6,100 CZK to Petr Novák. Transfer #TW-77812. Total paid 6,100 CZK.', 3),
  mk('updates', true, 'security', 'Google <no-reply@accounts.google.com>', 'Security alert', 'New sign-in on Windows. If this was not you, secure your account now.', 1),
  mk('updates', true, 'delivery', 'DPD <info@dpd.cz>', 'Your parcel is on its way', 'Delivery expected tomorrow between 10:00 and 13:00. Tracking number 1550922.', 1),
  mk('updates', true, 'deadline', 'Univerzita Karlova <studijni@cuni.cz>', 'Zápis předmětů', 'Termín zápisu předmětů končí 15. 11. 2026. Přihláška přes SIS.', 5),
  mk('updates', true, 'appointment', 'Zubní klinika Malá <recepce@zubnimala.cz>', 'Připomínka termínu', 'Připomínáme termín návštěvy 12. 11. 2026 v 10:30.', 2),
  mk('updates', true, 'travel', 'RegioJet <jizdenky@regiojet.cz>', 'Jízdenka Praha – Ostrava', 'Odjezd 8. 11. 2026 07:05, vůz 7 místo 42. Rezervace RJ-55120.', 6),
  mk('updates', true, 'subscription', 'Spotify <no-reply@spotify.com>', 'A change to your Premium plan', 'From December your Premium plan will cost 199 Kč per month. Renewal on 1 December.', 8),
  mk('updates', true, 'document', 'Kooperativa <info@koop.cz>', 'Pojistná smlouva', 'V příloze zasíláme pojistnou smlouvu. Pojistné 2 340 Kč, splatnost 7. 11. 2026.', 9, { att: pdf('smlouva.pdf') })
);

// ---------- PROMOTIONS: important mail Gmail filed as marketing (the classic blind spot) ----------
M.push(
  mk('promotions', true, 'receipt', 'Alza.cz <objednavky@alza.cz>', 'Děkujeme za nákup!', 'Objednávka č. 448812 byla přijata. Celkem 1 299 Kč. Doručení zítra.', 2, { lu: true, hard: 'receipt in promotions' }),
  mk('promotions', true, 'receipt', 'Zara <noreply@zara.com>', 'Thanks for shopping with us', 'Order ZR-90012 confirmed. Total 1 590 CZK. We will email you when it ships.', 4, { lu: true, hard: 'receipt in promotions' }),
  mk('promotions', true, 'booking', 'Booking.com <noreply@booking.com>', 'You are all set for Lisbon!', 'Booking confirmed: Hotel Lisboa, 20–23 Nov 2026, confirmation 4123987. Price €246.', 7, { lu: true, hard: 'booking in promotions', html: ld({ '@context': 'http://schema.org', '@type': 'LodgingReservation', reservationNumber: '4123987', checkinTime: '2026-11-20T15:00:00+00:00' }) }),
  mk('promotions', true, 'ticket', 'Ticketportal <info@ticketportal.cz>', 'Vaše e-vstupenky', 'Česká filharmonie, Rudolfinum, 28. 11. 2026 v 19:30, objednávka TP-55091, 2 vstupenky.', 5, { lu: true, hard: 'ticket in promotions' }),
  mk('promotions', true, 'subscription', 'Adobe <mail@mail.adobe.com>', 'Your plan renews soon', 'Your Creative Cloud plan renews on 15 November 2026 for €26.43. Manage your plan any time.', 10, { lu: true, hard: 'renewal in promotions' }),
  mk('promotions', true, 'receipt', 'Uber <uber.cz@uber.com>', 'Your Thursday trip', 'Thanks for riding. Total 289 Kč, paid with Visa. Trip receipt inside.', 3, { lu: true, hard: 'receipt in promotions' })
);

// ---------- SOCIAL: mostly noise, one interview invite, one event ----------
M.push(
  mk('social', true, 'appointment', 'LinkedIn <messages-noreply@linkedin.com>', 'Interview invitation from Quantum Labs', 'Hana from Quantum Labs: we would like to invite you for an interview on 13 November at 14:00. Please reply to confirm.', 3, { hard: 'interview in social' }),
  mk('social', true, 'ticket', 'Meetup <info@meetup.com>', 'RSVP confirmed: Prague Physics Night', 'You are going! 18 November 2026 at 18:00, Impact Hub. Your ticket is attached.', 4, { hard: 'event in social' })
);

// ---------- FORUMS: mailing lists with a real deadline ----------
M.push(
  mk('forums', true, 'deadline', 'Physics PhD list <phd-list@fzu.cz>', '[phd-list] Exam registration', 'Reminder: registration for the doctoral exam closes on 16 November 2026. Register in SIS.', 4, { hard: 'deadline in forums' }),
  mk('forums', true, 'request', 'Ion group <iontrap@lists.fzu.cz>', '[iontrap] Lab meeting moved', 'The lab meeting is moved to Friday 10:00. Please confirm attendance by Thursday.', 2, { hard: 'request in forums' })
);

// ---------- NOISE (not important) ----------
const noiseFrom = {
  promotions: ['Zalando <news@zalando.cz>', 'H&M <info@hm.com>', 'Lidl <news@lidl.cz>', 'Rohlik <novinky@rohlik.cz>', 'Wizz Air <newsletter@wizzair.com>', 'Ryanair <deals@ryanair.com>', 'Notino <news@notino.cz>'],
  social: ['LinkedIn <notifications-noreply@linkedin.com>', 'Facebook <notification@facebookmail.com>', 'Instagram <no-reply@mail.instagram.com>', 'X <info@x.com>'],
  forums: ['Python list <python-list@python.org>', 'Quantum digest <digest@quantum-forum.org>'],
  updates: ['Medium Daily Digest <noreply@medium.com>', 'GitHub <noreply@github.com>', 'Strava <no-reply@strava.com>', 'Duolingo <hello@duolingo.com>']
};
const noiseText = {
  promotions: ['Black Friday starts now — up to 70 % off everything', 'New collection just landed', 'Weekend flash sale: free shipping', 'Your weekly offers are here', 'Fares from 19 € — book now'],
  social: ['You appeared in 12 searches this week', 'Anna liked your photo', 'New followers this week', 'See what you missed', 'Trending in your network'],
  forums: ['Daily digest: 14 new topics', 'Re: numpy broadcasting question', 'Weekly roundup of discussions'],
  updates: ['Your daily read: 5 stories', 'Your weekly activity summary', 'You have new notifications', 'Keep your streak going']
};
let k = 0;
for (const cat of ['promotions', 'promotions', 'promotions', 'social', 'social', 'updates', 'forums']) {
  for (let i = 0; i < 40; i++) {
    const f = noiseFrom[cat][(i + k) % noiseFrom[cat].length], t = noiseText[cat][(i * 3 + k) % noiseText[cat].length];
    M.push(mk(cat, false, 'noise', f, t, t + '. Unsubscribe at any time. View in browser.', (i * 7 + k) % 29, { lu: cat !== 'forums' }));
  }
  k++;
}
module.exports = { MAIL: M };
