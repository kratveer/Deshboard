/**
 * HOLD-OUT set: 60 synthetic emails written AFTER the rules were tuned on mail-200.js and BEFORE they were ever run.
 * Used once, blind, to estimate accuracy on unseen phrasing. Not used for tuning (see the report for the first-run result).
 */
'use strict';
let seq = 0;
const U = ['CATEGORY_UPDATES'], PR = ['CATEGORY_PROMOTIONS'], S = ['CATEGORY_SOCIAL'], P = ['CATEGORY_PERSONAL'], F = ['CATEGORY_FORUMS'];
function mk(label, from, subject, body, x) {
  const o = x || {}; seq++;
  const id = 'h' + String(seq).padStart(4, '0');
  return { id, threadId: 'th' + seq, label, from, subject, body, html: o.html || null, snippet: o.snippet || body.replace(/\s+/g, ' ').trim().slice(0, 140), labelIds: ['INBOX', ...(o.cat || U), 'UNREAD'], listUnsubscribe: !!o.lu, attachments: o.att || [], ageDays: o.age ?? (seq % 25), lang: o.lang || 'en', tricky: o.tricky || null };
}
const pdf = (n) => [{ name: n, mimeType: 'application/pdf', size: 51000 }];
const L = [
  // bill 8
  mk('bill', 'PRE Distribuce <zakaznici@pre.cz>', 'Upozornění na blížící se splatnost', 'Dobrý den, připomínáme platbu zálohy 1 430 Kč se splatností 24. 11. 2026.', { lang: 'cs' }),
  mk('bill', 'T-Mobile <vyuctovani@t-mobile.cz>', 'Vyúčtování T-Mobile listopad', 'Částka k zaplacení 749 Kč. Splatné do 21.11.2026.', { lang: 'cs' }),
  mk('bill', 'Accountant Petra <petra@ucetni-petra.cz>', 'Faktura za vedení účetnictví', 'Dobrý den, v příloze faktura 2026-077 na 3 500 Kč, splatnost 30. 11. 2026.', { cat: P, lang: 'cs', att: pdf('faktura.pdf') }),
  mk('bill', 'Water Utility <billing@citywater.example>', 'Water bill ready', 'Your water bill is ready. Amount due $41.20 by December 2, 2026.', {}),
  mk('bill', 'Reliance Jio <bills@jio.com>', 'Jio Postpaid bill generated', 'Bill amount Rs. 599 due on 2026-11-27. Pay now to avoid late fee.', {}),
  mk('bill', 'Kindergarten Sluníčko <ms@slunicko.cz>', 'Školné prosinec', 'Prosíme o úhradu školného 1 200 Kč do 5. 12. 2026.', { cat: P, lang: 'cs' }),
  mk('bill', 'Stadtwerke <rechnung@stadtwerke.example>', 'Ihre Rechnung', 'Rechnungsbetrag 88,40 €, fällig am 28.11.2026.', { lang: 'de' }),
  mk('bill', 'Garage Novák <servis@autonovak.cz>', 'Oprava vozu – účet', 'Za opravu vozu účtujeme 7 900 Kč, uhraďte prosím do 20. 11. 2026.', { cat: P, lang: 'cs' }),
  // payment 7
  mk('payment', 'Raiffeisenbank <info@rb.cz>', 'Pohyb na účtu', 'Na váš účet přišla platba 3 200 Kč od Jan Dvořák.', { lang: 'cs' }),
  mk('payment', 'Revolut <no-reply@revolut.com>', 'Money added', 'You added 2,000 CZK to your Revolut account from Visa •••• 9012.', {}),
  mk('payment', 'Kotak Bank <alerts@kotak.com>', 'Debit alert', 'INR 2,100 debited from A/c XX9911 on 03-11-2026 towards UPI/ZOMATO.', {}),
  mk('payment', 'PayPal <service@paypal.com>', 'You received money', 'Anita Sharma sent you €40.00 EUR.', {}),
  mk('payment', 'mBank <info@mbank.cz>', 'Platba kartou zamítnuta', 'Platba kartou 459 Kč u ROHLIK byla zamítnuta.', { lang: 'cs' }),
  mk('payment', 'Wise <noreply@wise.com>', 'Your transfer has arrived', '₹45,000 has arrived in Ravi Kumar\'s account.', {}),
  mk('payment', 'Fwd Jan <jan.k@gmail.com>', 'Fwd: Potvrzení platby', '---------- Forwarded message ---------- Platba 1 500 Kč za kurz byla přijata. Děkujeme.', { cat: P, lang: 'cs' }),
  // refund 5
  mk('refund', 'Notino <info@notino.cz>', 'Peníze jsou na cestě zpět', 'Vrátili jsme vám 649 Kč za vrácené zboží, objednávka 41122.', { lang: 'cs' }),
  mk('refund', 'Myntra <support@myntra.com>', 'Refund credited', '₹1,799 has been credited back to your card for order 77881.', {}),
  mk('refund', 'Easyjet <noreply@easyjet.com>', 'Your refund', 'We have issued a refund of £52.10 for booking EZY4KP2.', {}),
  mk('refund', 'Airbnb <automated@airbnb.com>', 'Refund for your cancelled reservation', 'A refund of €120 for reservation HMQ12345 will reach you in 5–7 days.', {}),
  mk('refund', 'eshop Sport <info@sportobchod.cz>', 'Dobropis k objednávce', 'Vystavili jsme dobropis 1 090 Kč a peníze vrátíme na účet.', { lang: 'cs', tricky: 'dobropis = credit note' }),
  // travel 7
  mk('travel', 'Leo Express <info@le.cz>', 'Vaše jízdenka', 'Číslo rezervace LE7712. Praha – Ostrava 27. 11. 2026 v 8:15, sedadlo 34.', { lang: 'cs' }),
  mk('travel', 'Air India <noreply@airindia.com>', 'Booking confirmed - PNR K9TQ2L', 'PNR K9TQ2L, AI 142 Paris to Delhi, 18 Dec 2026 22:05.', {}),
  mk('travel', 'Hotel Adria <recepce@hoteladria.cz>', 'Potvrzení ubytování', 'Potvrzujeme ubytování od 4. 12. do 6. 12. 2026, rezervace č. 55017.', { lang: 'cs' }),
  mk('travel', 'Deutsche Bahn <buchungsbestaetigung@bahn.de>', 'Ihre Fahrkarte', 'Auftragsnummer Q7K2LX. Prag – Berlin, 01.12.2026, Abfahrt 08:28.', { lang: 'de' }),
  mk('travel', 'Bolt <scheduled@bolt.eu>', 'Scheduled ride confirmed', 'Your scheduled ride to Václav Havel Airport on 27 Nov at 05:00 is confirmed. Ref BLT-2290.', {}),
  mk('travel', 'Goibibo <noreply@goibibo.com>', 'Bus ticket booked', 'Booking ID GB88122. Volvo AC sleeper Delhi to Manali, 20 Dec 2026 19:30. Seat 14.', {}),
  mk('travel', 'Cousin Rahul <rahul.v@gmail.com>', 'Fwd: Flight ticket', '---------- Forwarded message ---------- E-ticket: PNR 8XK2QM, IndiGo 6E 553 BLR–DEL 2 Jan 2027 07:10.', { cat: P }),
  // food 4
  mk('food', 'Bolt Food <food@bolt.eu>', 'Your Bolt Food order is on its way', 'Order from Sushi Bar Kyoto, total 540 Kč, arriving in 25 min.', {}),
  mk('food', 'Restaurant Mlýnec <rezervace@mlynec.cz>', 'Rezervace stolu potvrzena', 'Těšíme se na vás 22. 11. 2026 v 19:30, stůl pro 2.', { lang: 'cs' }),
  mk('food', 'EatSure <noreply@eatsure.com>', 'Order delivered', 'Your order 77120 from Behrouz Biryani was delivered. Paid ₹612.', {}),
  mk('food', 'Quandoo <noreply@quandoo.com>', 'Your reservation at Café Savoy', 'Table for 3 on 29 Nov 2026 at 12:00. Reservation code QD-1129.', {}),
  // subscription 4
  mk('subscription', 'HBO Max <hbomax@mail.hbomax.com>', 'Your plan renews soon', 'Your HBO Max subscription renews on 22 Nov 2026 for 199 Kč.', {}),
  mk('subscription', 'ChatApp Pro <billing@chatapp.example>', 'Subscription renewed', 'Thanks! Your Pro subscription renewed for $8.00 on Nov 3, 2026.', {}),
  mk('subscription', 'Amazon Prime <prime@amazon.in>', 'Prime membership renewal', 'Your Prime membership will renew on 30-11-2026 for ₹1,499.', {}),
  mk('subscription', 'Tidal <noreply@tidal.com>', 'Free trial ending', 'Your free trial ends in 3 days. After that you will be billed €10.99/month.', { lu: true }),
  // receipt 5
  mk('receipt', 'Datart <eshop@datart.cz>', 'Potvrzení objednávky č. 66124', 'Děkujeme za nákup. Objednávka 66124, celkem 2 199 Kč, zaplaceno.', { lang: 'cs' }),
  mk('receipt', 'Etsy <transaction@etsy.com>', 'Your Etsy purchase', 'Order #3011223. Handmade scarf, $34.00. The seller will ship soon.', {}),
  mk('receipt', 'Croma <orders@croma.com>', 'Order confirmation', 'Order CR772109 for a kettle, ₹2,295, will be delivered by Friday.', {}),
  mk('receipt', 'Kaufland <eshop@kaufland.cz>', 'Vaše objednávka byla odeslána', 'Objednávka 8812201 byla odeslána. Celkem 1 349 Kč.', { cat: PR, lang: 'cs', tricky: 'receipt in Promotions' }),
  mk('receipt', 'Apple <no_reply@email.apple.com>', 'Your receipt from Apple', 'Receipt for MagSafe charger, €45.00. Order W2299881.', {}),
  // document 3
  mk('document', 'ČSOB Pojišťovna <smlouvy@csobpoj.cz>', 'Dodatek ke smlouvě', 'V příloze zasíláme dodatek k pojistné smlouvě.', { lang: 'cs', att: pdf('dodatek.pdf') }),
  mk('document', 'Adobe Sign <adobesign@adobesign.com>', 'Signed and filed: NDA', 'NDA between you and QuantumTech has been signed by all parties.', { att: pdf('nda.pdf') }),
  mk('document', 'Passport Seva <noreply@passportindia.gov.in>', 'Appointment confirmation', 'Your passport appointment is confirmed. Carry the original documents listed in the attachment.', { att: pdf('docs.pdf') }),
  // security 3
  mk('security', 'Dropbox <no-reply@dropbox.com>', 'New sign-in to your account', 'We noticed a new sign-in from Chrome on Windows.', {}),
  mk('security', 'Air Bank <bezpecnost@airbank.cz>', 'Ověřovací kód pro platbu', 'Kód pro potvrzení platby 1 290 Kč: 553201.', { lang: 'cs', tricky: 'code with amount' }),
  mk('security', 'Amazon <account-update@amazon.com>', 'Password reset requested', 'Someone requested a password reset for your account.', {}),
  // promotion 6
  mk('promotion', 'Kiwi.com <deals@kiwi.com>', 'Flash sale: Prague → London from 990 Kč', 'Limited seats at this price. Book until Friday.', { cat: PR, lu: true }),
  mk('promotion', 'foodora <akce@foodora.cz>', 'Doprava zdarma o víkendu', 'Tento víkend doprava zdarma na všechny objednávky.', { cat: PR, lu: true, lang: 'cs' }),
  mk('promotion', 'Hotels.com <deals@hotels.com>', 'Save 20% on winter stays', 'Members save 20% on thousands of hotels.', { cat: PR, lu: true }),
  mk('promotion', 'Revolut <no-reply@revolut.com>', 'Get 3 months of Premium free', 'Upgrade to Premium and get 3 months free. T&Cs apply.', { cat: PR, lu: true }),
  mk('promotion', 'BigBasket <offers@bigbasket.com>', 'Flat ₹150 off', 'Use code SAVE150 on orders above ₹999.', { cat: PR, lu: true }),
  mk('promotion', 'Unknown Store <news@shiny-gadgets.example>', 'Your exclusive price inside', 'Hi! Our new headphones are now €49 just for subscribers.', { lu: true, tricky: 'promo outside Promotions tab' }),
  // newsletter 3
  mk('newsletter', 'Nature Briefing <briefing@nature.com>', 'Nature Briefing: Tuesday', 'The latest science news, selected by Nature editors.', { lu: true }),
  mk('newsletter', 'CzechCrunch <newsletter@czechcrunch.cz>', 'Ranní CzechCrunch', 'Startupy, technologie a byznys v kostce.', { lu: true, lang: 'cs' }),
  mk('newsletter', 'Physics Forum <digest@physicsforums.example>', 'Weekly digest', 'Popular threads this week.', { cat: F, lu: true }),
  // social 2
  mk('social', 'LinkedIn <notifications-noreply@linkedin.com>', 'Marek reacted to your post', 'Marek and 12 others reacted to your post.', { cat: S, lu: true }),
  mk('social', 'Facebook <groups@facebookmail.com>', 'New post in Prague Expats', 'Someone posted: anyone selling a bike?', { cat: S, lu: true }),
  // personal 3
  mk('personal', 'Prof. Li <li.wei@uni.edu>', 'Draft figures', 'Attached the draft figures for the Fock state paper, comments welcome.', { cat: P }),
  mk('personal', 'Friend Ondra <ondra.p@gmail.com>', 'Pivo v pátek?', 'Ahoj, dáme v pátek pivo? Platím já :)', { cat: P, lang: 'cs', tricky: 'money word in personal' }),
  mk('personal', 'Mom <mom.family@gmail.com>', 'Ticket prices', 'Beta, the train ticket prices for Diwali are high, maybe fly?', { cat: P, tricky: 'travel words in personal' })
];
module.exports = { MAIL: L };
