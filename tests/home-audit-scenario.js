/**
 * Home / Daily Brief / Today's Schedule / Priority Actions audit — one realistic SYNTHETIC day with ground truth.
 * "Now" = Wed 4 Nov 2026 09:15 Europe/Prague (08:15Z). All people, senders, amounts and references are invented.
 */
'use strict';
const NOW = Date.parse('2026-11-04T09:15:00+01:00');
const at = (s) => Date.parse(s);
const ev = (id, summary, start, end, x) => Object.assign({ id, status: 'confirmed', summary, htmlLink: `https://www.google.com/calendar/event?eid=${id}`, start: { dateTime: start, timeZone: 'Europe/Prague' }, end: { dateTime: end, timeZone: 'Europe/Prague' }, organizer: { email: 'me@example.com', self: true } }, x || {});
const allDay = (id, summary, start, end) => ({ id, status: 'confirmed', summary, htmlLink: `https://www.google.com/calendar/event?eid=${id}`, start: { date: start }, end: { date: end } });
const me = { email: 'me@example.com', self: true, responseStatus: 'accepted' };

const CALENDAR = [
  ev('e00', 'Night observation run', '2026-11-03T22:00:00+01:00', '2026-11-04T01:00:00+01:00'),
  ev('e01', 'Gym', '2026-11-04T07:30:00+01:00', '2026-11-04T08:15:00+01:00'),
  ev('e02', 'Daily standup', '2026-11-04T09:00:00+01:00', '2026-11-04T09:30:00+01:00', { attendees: [me, { email: 'a@x.cz' }, { email: 'b@x.cz' }], hangoutLink: 'https://meet.google.com/abc' }),
  ev('e03', 'Lab meeting – Fock state data', '2026-11-04T10:00:00+01:00', '2026-11-04T11:00:00+01:00', { attendees: [me, { email: 'novak@fzu.cz' }, { email: 'li.wei@uni.edu' }, { email: 'c@fzu.cz' }], location: 'FZU room 214' }),
  ev('e04', 'Call with Anita', '2026-11-04T10:30:00+01:00', '2026-11-04T11:15:00+01:00', { attendees: [me, { email: 'anita.s@gmail.com' }] }),
  ev('e05', 'Call with Bangalore team', '2026-11-04T15:30:00+05:30', '2026-11-04T16:00:00+05:30', { start: { dateTime: '2026-11-04T15:30:00+05:30', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2026-11-04T16:00:00+05:30', timeZone: 'Asia/Kolkata' }, attendees: [me, { email: 'ravi@corp.in' }] }),
  ev('e06', 'Lunch with Marek', '2026-11-04T12:00:00+01:00', '2026-11-04T13:00:00+01:00'),
  ev('e07', 'Write SI section (focus)', '2026-11-04T13:00:00+01:00', '2026-11-04T14:00:00+01:00'),
  ev('e08', 'Vendor demo', '2026-11-04T14:00:00+01:00', '2026-11-04T15:00:00+01:00', { attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }, { email: 'sales@vendor.com', organizer: true }], organizer: { email: 'sales@vendor.com' } }),
  ev('e09', 'Dentist', '2026-11-04T15:00:00+01:00', '2026-11-04T15:45:00+01:00', { location: 'Zubař Malá, Vinohradská 12' }),
  ev('e10', 'Seminar: quantum optics', '2026-11-04T16:30:00+01:00', '2026-11-04T17:30:00+01:00', { attendees: [me, { email: 'news@fzu.cz' }] }),
  ev('e11', 'Yoga', '2026-11-04T17:45:00+01:00', '2026-11-04T18:30:00+01:00'),
  ev('e12', 'Taxi to airport', '2026-11-04T19:15:00+01:00', '2026-11-04T19:45:00+01:00'),
  ev('e13', 'Flight to Dublin (FR 1234)', '2026-11-04T21:40:00+01:00', '2026-11-05T00:05:00+01:00', { location: 'Prague PRG', description: 'Booking reference ABC12D' }),
  ev('e14', 'Team retro', '2026-11-04T11:30:00+01:00', '2026-11-04T12:00:00+01:00', { status: 'cancelled' }),
  allDay('a01', 'Diwali preparations', '2026-11-03', '2026-11-07'),
  allDay('a02', "Klára's birthday", '2026-11-04', '2026-11-05'),
  allDay('a03', 'Conference travel day', '2026-11-05', '2026-11-06'),
  ev('e20', 'Lab safety training', '2026-11-05T10:00:00+01:00', '2026-11-05T11:00:00+01:00', { attendees: [me, { email: 'safety@fzu.cz' }] })
];

// Google Tasks (due = midnight UTC dates). Six undated tasks come first in list order, like a real list.
const TASKS = [
  { id: 'gt01', title: 'Read new arXiv papers', status: 'needsAction' },
  { id: 'gt02', title: 'Sort photos from Lisbon', status: 'needsAction' },
  { id: 'gt03', title: 'Call insurance', status: 'needsAction' },
  { id: 'gt04', title: 'Fix bike light', status: 'needsAction' },
  { id: 'gt05', title: 'Back up laptop', status: 'needsAction' },
  { id: 'gt06', title: 'Clean fridge', status: 'needsAction' },
  { id: 'gt07', title: 'Renew passport photos', status: 'needsAction', due: '2026-11-03T00:00:00.000Z' },
  { id: 'gt08', title: 'Book Diwali train tickets', status: 'needsAction', due: '2026-11-05T00:00:00.000Z' },
  { id: 'gt09', title: 'Submit TBZ SI revisions', status: 'needsAction', due: '2026-11-04T00:00:00.000Z' },
  { id: 'gt10', title: 'Pay rent', status: 'needsAction', due: '2026-11-04T00:00:00.000Z' },
  { id: 'gt11', title: 'Order lab gloves', status: 'completed', due: '2026-11-04T00:00:00.000Z' }
];
const PERSONAL = [
  { id: 'p1', title: 'Prepare seminar slides', dueDate: '2026-11-04T14:00:00+01:00', hasTime: true, created: '2026-11-01T10:00:00Z' },
  { id: 'p2', title: 'Water plants', dueDate: '2026-11-02T00:00:00.000Z', created: '2026-10-30T10:00:00Z' }
];

const m = (id, from, subject, body, when, labels, x) => Object.assign({ id, threadId: (x && x.threadId) || 't-' + id, from, subject, body, snippet: body.replace(/\s+/g, ' ').slice(0, 140), internalDate: at(when), labelIds: labels }, x || {});
const IN = ['INBOX'], U = ['INBOX', 'UNREAD'];
const flightLd = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'ABC12D', reservationFor: { '@type': 'Flight', flightNumber: 'FR1234', departureAirport: { iataCode: 'PRG' }, arrivalAirport: { iataCode: 'DUB' }, departureTime: '2026-11-04T21:40:00+01:00', arrivalTime: '2026-11-04T23:05:00+00:00' } })}</script></head><body>Booking reference ABC12D</body></html>`;
const GMAIL = [
  m('g01', 'ČEZ Prodej <faktury@cez.cz>', 'Vyúčtování elektřiny za říjen', 'Dobrý den, zasíláme vyúčtování. Částka k úhradě: 1 250 Kč. Datum splatnosti: 4. 11. 2026. Variabilní symbol 4401928811.', '2026-10-25T09:00:00+02:00', [...IN, 'CATEGORY_UPDATES']),
  m('g02', 'Vodafone CZ <ebill@vodafone.cz>', 'Vaše faktura je připravena', 'Faktura č. 2026104455. Celkem k úhradě 649 Kč, splatnost 14.11.2026.', '2026-11-02T08:00:00+01:00', [...IN, 'CATEGORY_UPDATES']),
  m('g03', 'Studio Pixel <billing@studiopixel.io>', 'Invoice INV-2041 from Studio Pixel', 'Hi, please find invoice INV-2041 attached. Amount due: €480.00. Due date: 1 November 2026.', '2026-10-20T10:00:00+02:00', [...IN, 'CATEGORY_UPDATES']),
  m('g04', 'Alza.cz <objednavky@alza.cz>', 'Potvrzení objednávky 554433', 'Děkujeme za objednávku 554433. Celkem 1 120 Kč, zaplaceno kartou. Doručení zítra.', '2026-11-04T08:02:00+01:00', [...U, 'CATEGORY_UPDATES']),
  m('g05', 'Booking.com <noreply@booking.com>', 'Your refund has been processed', 'The refund of €82.00 for reservation 4123987 has been processed to your card.', '2026-11-04T07:40:00+01:00', [...U, 'CATEGORY_UPDATES']),
  m('g06', 'Alza.cz <newsletter@alza.cz>', 'Black Friday: slevy až 50 %', 'Výprodej elektroniky: slevy až 50 %. Akce platí do neděle.', '2026-11-04T06:00:00+01:00', [...U, 'CATEGORY_PROMOTIONS'], { listUnsubscribe: true }),
  m('g07', 'Prof. Jan Novák <novak@fzu.cz>', 'Meeting on Thursday?', 'Can we move our meeting to Thursday at 10? I want to discuss the Wigner function data before the lab meeting.', '2026-11-04T08:10:00+01:00', [...U, 'IMPORTANT', 'CATEGORY_PERSONAL'], { threadId: 't-novak' }),
  m('g07b', 'Prof. Jan Novák <novak@fzu.cz>', 'Re: Meeting on Thursday?', 'Also, please bring the latest data plots.', '2026-11-04T08:40:00+01:00', [...U, 'IMPORTANT', 'CATEGORY_PERSONAL'], { threadId: 't-novak' }),
  m('g08', 'Li Wei <li.wei@uni.edu>', 'Re: manuscript revisions', 'I have addressed reviewer 2 comments, can you check the SI and confirm today?', '2026-11-03T16:00:00+01:00', [...U, 'IMPORTANT', 'CATEGORY_PERSONAL']),
  m('g09', 'Organic Letters <ol-editorial@acs-journal.example>', 'Revision due: manuscript OL-2026-0123', 'Dear author, your revised manuscript OL-2026-0123 is due on 4 November 2026 at 23:59 EST. Please submit via the portal.', '2026-10-28T15:00:00+01:00', [...IN, 'IMPORTANT', 'CATEGORY_UPDATES']),
  m('g10', 'Ryanair <itinerary@ryanair.com>', 'Your booking confirmation ABC12D', 'Booking reference ABC12D. Prague (PRG) to Dublin (DUB) on 4 Nov 2026 21:40. Check-in opens 24 hours before.', '2026-10-21T12:00:00+02:00', [...IN, 'CATEGORY_UPDATES'], { html: flightLd }),
  m('g11', 'Netflix <info@account.netflix.com>', 'Your membership renews today', 'Your Netflix Standard plan renews today, 4 Nov 2026, for 259 Kč. No action needed.', '2026-11-01T09:00:00+01:00', [...IN, 'CATEGORY_UPDATES']),
  m('g12', 'Substack AI Weekly <aiweekly@substack.com>', 'This week in AI', 'The biggest stories of the week in AI research and products.', '2026-11-04T07:00:00+01:00', [...U], { listUnsubscribe: true }),
  m('g13', 'Google <no-reply@accounts.google.com>', 'Security alert', 'New sign-in to your Google Account on a Windows device.', '2026-11-04T08:30:00+01:00', [...U, 'CATEGORY_UPDATES']),
  m('g14', 'LinkedIn <invitations@linkedin.com>', 'Anita wants to connect', 'Anita Sharma would like to join your network.', '2026-11-04T07:20:00+01:00', [...U, 'CATEGORY_SOCIAL'], { listUnsubscribe: true }),
  m('g15', 'GitHub <noreply@github.com>', '[repo] New issue opened', 'A new issue was opened in kratveer/Deshboard.', '2026-11-04T08:50:00+01:00', [...U, 'CATEGORY_UPDATES']),
  m('g16', 'Amazon.de <versandbestaetigung@amazon.de>', 'Arriving today: your package', 'Your package with order 302-1188776 is out for delivery and arrives today.', '2026-11-04T06:30:00+01:00', [...U, 'CATEGORY_UPDATES']),
  m('g17', 'Revolut <no-reply@revolut.com>', 'You paid Albert', 'You paid 289.50 CZK at Albert Vinohrady with your card ending 1144.', '2026-11-04T08:20:00+01:00', [...U, 'CATEGORY_UPDATES']),
  m('g18', 'Eva Horáková <eva@talentfirm.cz>', 'Position at QuantumTech', 'Dear Mr. Kumar, I came across your profile and would like to discuss a role. Are you free this week?', '2026-11-04T08:55:00+01:00', [...U, 'CATEGORY_PERSONAL']),
  m('g19', 'Petr Novák <petr.novak@seznam.cz>', 'Nájem listopad', 'Ahoj, připomínám nájem 18 500 Kč za listopad, prosím zaplať do 4. 11. 2026 na obvyklý účet. Díky, Petr', '2026-11-03T19:00:00+01:00', [...U, 'CATEGORY_PERSONAL'])
];
const lodgingLd = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'LodgingReservation', reservationNumber: '4123987', checkinDate: '2026-11-20', checkoutDate: '2026-11-23', reservationFor: { '@type': 'LodgingBusiness', name: 'Hotel Lisboa', address: 'Rua Augusta 10, Lisbon' } })}</script></head><body>Hotel Lisboa</body></html>`;
const foodLd = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'FoodEstablishmentReservation', reservationNumber: '99812', startTime: '2026-11-21T19:30:00+01:00', partySize: 2, reservationFor: { '@type': 'FoodEstablishment', name: 'Field', address: 'U Milosrdných 12, Praha' } })}</script></head><body>Field</body></html>`;
// Wallet / travel mail
GMAIL.push(
  m('w01', 'Ryanair <boardingpass@ryanair.com>', 'Your boarding pass FR1234 PRG–DUB', 'Boarding pass for Test User. Flight FR1234 Prague (PRG) to Dublin (DUB) on 4 Nov 2026, departs 21:40, gate closes 21:10, seat 14C. Booking reference ABC12D.', '2026-11-04T06:00:00+01:00', [...U, 'CATEGORY_UPDATES'], { attachments: [{ name: 'boardingpass.pkpass', mimeType: 'application/vnd.apple.pkpass', size: 32000 }] }),
  m('w02', 'Booking.com <noreply@booking.com>', 'Your booking is confirmed at Hotel Lisboa', 'Confirmation number 4123987. Hotel Lisboa, Rua Augusta 10, Lisbon. Check-in 20 Nov 2026, check-out 23 Nov 2026. Total price €246.', '2026-10-15T11:00:00+02:00', [...IN, 'CATEGORY_UPDATES'], { html: lodgingLd, threadId: 't-lisboa' }),
  m('w02c', 'Booking.com <noreply@booking.com>', 'Your booking 4123987 has been cancelled', 'Your reservation 4123987 at Hotel Lisboa (20–23 Nov 2026) has been cancelled. A refund of €82.00 will follow.', '2026-11-02T09:30:00+01:00', [...IN, 'CATEGORY_UPDATES']),
  m('w03', 'OpenTable <member_services@opentable.com>', 'Reservation confirmed at Field', 'Your table for 2 at Field, U Milosrdných 12, Praha on Sat 21 Nov 2026 at 19:30 is confirmed. Confirmation 99812.', '2026-11-01T18:00:00+01:00', [...IN, 'CATEGORY_UPDATES'], { html: foodLd }),
  m('w04', 'RegioJet <jizdenky@regiojet.cz>', 'Jízdenka Praha – Brno', 'Vaše jízdenka č. 2211334455. Odjezd 16. 11. 2026 v 7:05 z Praha hl.n., příjezd Brno hl.n. 9:35, vůz 4, místo 52.', '2026-11-02T20:00:00+01:00', [...IN, 'CATEGORY_UPDATES']),
  m('w05', 'Eurowings <service@eurowings.com>', 'Your booking confirmation EWQ7Z1', 'Booking code EWQ7Z1. Flight EW 8121 Prague – Cologne on 3 Dec 2026, departs 10:55.', '2026-10-10T10:00:00+02:00', [...IN, 'CATEGORY_UPDATES'], { threadId: 't-ew' }),
  m('w05c', 'Eurowings <service@eurowings.com>', 'Flight schedule change EWQ7Z1', 'Your flight EW 8121 on 3 Dec 2026 now departs at 11:40 instead of 10:55. Booking code EWQ7Z1.', '2026-11-01T08:00:00+01:00', [...IN, 'CATEGORY_UPDATES'], { threadId: 't-ew' }),
  m('w06', 'Ryanair <ryanair@email.ryanair.com>', 'Flights from €19.99 — this weekend only', 'Grab a seat sale: flights to Rome, Milan and Malta from €19.99. Book by Sunday.', '2026-11-03T10:00:00+01:00', [...IN, 'CATEGORY_PROMOTIONS'], { listUnsubscribe: true }),
  m('w07', 'Booking.com <deals@booking.com>', 'Last-minute deals for this weekend', 'Getaway deals: up to 25% off stays this weekend.', '2026-11-03T12:00:00+01:00', [...IN], { listUnsubscribe: true }),
  m('w08', 'Ticketportal <eticket@ticketportal.cz>', 'Vaše e-vstupenky: Česká filharmonie', 'E-vstupenky: Česká filharmonie, Rudolfinum, 28. 11. 2026 v 19:30, objednávka 77812, řada 7, místa 11–12.', '2026-10-29T14:00:00+01:00', [...IN, 'CATEGORY_UPDATES'], { attachments: [{ name: 'vstupenky.pdf', mimeType: 'application/pdf', size: 90000 }] })
);
const SENT = [
  { id: 's01', threadId: 't-landlord-q', from: 'Me <me@example.com>', to: 'Lisbon Host <host@lisbonflats.pt>', subject: 'Question about the apartment', body: 'Hi, is late check-in possible?', snippet: 'Hi, is late check-in possible?', internalDate: at('2026-10-30T10:00:00+01:00'), labelIds: ['SENT'] }
];

// ---------------- ground truth ----------------
const TRUTH = {
  schedule: {
    timed: ['Gym', 'Daily standup', 'Lab meeting – Fock state data', 'Call with Anita', 'Call with Bangalore team', 'Lunch with Marek', 'Write SI section (focus)', 'Dentist', 'Seminar: quantum optics', 'Yoga', 'Taxi to airport', 'Flight to Dublin (FR 1234)'],
    continuing: ['Night observation run'], // started yesterday, ended 01:00 today — acceptable either way, reported separately
    allDay: ['Diwali preparations', "Klára's birthday"],
    mustNot: ['Vendor demo', 'Team retro', 'Conference travel day', 'Lab safety training'],
    times: { 'Call with Bangalore team': '11:00', 'Flight to Dublin (FR 1234)': '21:40', Gym: '07:30' },
    overlaps: [['Lab meeting – Fock state data', 'Call with Anita'], ['Lab meeting – Fock state data', 'Call with Bangalore team'], ['Call with Anita', 'Call with Bangalore team']]
  },
  todo: {
    must: ['Submit TBZ SI revisions', 'Renew passport photos', 'Prepare seminar slides', 'Water plants', 'Revision due: manuscript OL-2026-0123'],
    should: ['Meeting on Thursday?', 'Re: manuscript revisions'], // replies the user owes
    mustNot: ['Book Diwali train tickets', 'Order lab gloves', 'Call insurance', 'Read new arXiv papers']
  },
  payments: {
    must: ['ČEZ', 'Studio Pixel'], // due today / overdue with written due dates
    rent: ['Pay rent', 'Nájem listopad'], // same obligation from a task and an email — one item, or two clearly linked
    mustNot: ['Vodafone', 'Alza', 'Booking', 'Netflix', 'Amazon', 'Albert', 'Revolut']
  },
  priority: {
    must: ['g07', 'g09', 'g10', 'g01', 'g03'],
    should: ['g08', 'g19', 'g18'],
    mustNot: ['g04', 'g05', 'g06', 'g11', 'g12', 'g13', 'g14', 'g15', 'g16', 'g17', 'g02'],
    oneOf: [['g07', 'g07b']]
  }
};

const SECONDARY = [ev('f01', "Parents' evening (school)", '2026-11-04T17:00:00+01:00', '2026-11-04T18:00:00+01:00', { organizer: { email: 'family@group.calendar.google.com' } })];
TRUTH.schedule.timed.push("Parents' evening (school)");
TRUTH.wallet = {
  must: [
    { key: 'ABC12D', kind: 'flight', date: '2026-11-04', time: '21:40', where: 'PRG', mail: ['g10', 'w01'] },
    { key: '99812', kind: 'restaurant', date: '2026-11-21', time: '19:30', where: 'Field', mail: ['w03'] },
    { key: '2211334455', kind: 'train', date: '2026-11-16', time: '07:05', where: 'Praha', mail: ['w04'] },
    { key: 'EWQ7Z1', kind: 'flight', date: '2026-12-03', time: '11:40', where: 'Prague', mail: ['w05', 'w05c'] },
    { key: '77812', kind: 'event', date: '2026-11-28', time: '19:30', where: 'Rudolfinum', mail: ['w08'] }
  ],
  cancelled: [{ key: '4123987', mail: ['w02', 'w02c'] }], // must not be shown as an active/upcoming booking
  mustNot: ['w06', 'w07', 'g06', 'g12', 'g04', 'g16']
};
TRUTH.inbox = {
  // every received message must appear exactly once (threads may be grouped); promotions only in the Promotions tab
  promotions: ['g06', 'w06', 'w07'],
  categories: { g01: 'bills', g02: 'bills', g03: 'bills', g04: 'receipts', g05: 'payments', g10: 'tickets', w01: 'tickets', w04: 'tickets', w03: 'tickets', w08: 'tickets', g11: 'subscriptions', g17: 'payments', g07: 'important', g08: 'important', g18: 'important', g19: 'bills' },
  unread: GMAIL.filter((x) => x.labelIds.includes('UNREAD')).map((x) => x.id)
};
TRUTH.timeline = {
  today: ['Gym', 'Daily standup', 'Lab meeting – Fock state data', 'Call with Anita', 'Call with Bangalore team', 'Lunch with Marek', 'Write SI section (focus)', 'Dentist', 'Seminar: quantum optics', "Parents' evening (school)", 'Yoga', 'Taxi to airport', 'Flight to Dublin (FR 1234)', 'Submit TBZ SI revisions', 'Pay rent', 'Prepare seminar slides', 'Diwali preparations', "Klára's birthday"],
  mustNot: ['Vendor demo', 'Team retro', 'Renew passport photos', 'Book Diwali train tickets'],
  flightOnce: true,
  importantMail: ['Revision due: manuscript OL-2026-0123', 'ČEZ'] // deadlines / bills due today that live only in Gmail
};
module.exports = { NOW, CALENDAR, SECONDARY, TASKS, PERSONAL, GMAIL, SENT, TRUTH };
