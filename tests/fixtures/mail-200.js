/**
 * ~200 labelled SYNTHETIC emails for the Gmail cost benchmark. All senders, people, amounts and references are invented.
 * Labels (ground truth) use the pipeline taxonomy: bill, payment, refund, travel, food, subscription, receipt, document,
 * security, promotion, newsletter, social, personal.
 * Includes tricky cases: unfamiliar senders, CZ / HI / EN / DE mixes, forwarded receipts, receipts filed under Promotions,
 * travel promotions with prices, bills whose subject and snippet look harmless, personal mail that mentions money,
 * schema.org JSON-LD reservations and invoices.
 * Snippets are derived like Gmail does: the first ~140 characters of the body text.
 */
'use strict';
let seq = 0;
const P = ['CATEGORY_PERSONAL'], U = ['CATEGORY_UPDATES'], PR = ['CATEGORY_PROMOTIONS'], S = ['CATEGORY_SOCIAL'], F = ['CATEGORY_FORUMS'];
function mk(label, from, subject, body, x) {
  const o = x || {};
  seq++;
  const id = 'm' + String(seq).padStart(4, '0');
  const text = body.replace(/\s+/g, ' ').trim();
  return {
    id, threadId: o.threadId || 't' + id.slice(1), label, from, subject, body, html: o.html || null,
    snippet: o.snippet || text.slice(0, 140), labelIds: ['INBOX', ...(o.cat || U), ...(o.unread === false ? [] : ['UNREAD'])].concat(o.extraLabels || []),
    listUnsubscribe: !!o.lu, attachments: o.att || [], ageDays: o.age ?? (seq % 27), tricky: o.tricky || null, lang: o.lang || 'en'
  };
}
const ld = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body>`;
const pdf = (name) => [{ name, mimeType: 'application/pdf', size: 84000 }];
const L = [];

// ---------------- bill (22) ----------------
L.push(
  mk('bill', 'ČEZ Prodej <faktury@cez.cz>', 'Vyúčtování elektřiny za říjen', 'Dobrý den, zasíláme vyúčtování. Částka k úhradě: 1 250 Kč. Datum splatnosti: 20. 11. 2026. Variabilní symbol 4401928811.', { lang: 'cs', att: pdf('vyuctovani.pdf') }),
  mk('bill', 'Vodafone CZ <ebill@vodafone.cz>', 'Vaše faktura je připravena', 'Faktura č. 2026104455 za služby. Celkem k úhradě 649 Kč, splatnost 18.11.2026. Platba inkasem není nastavena.', { lang: 'cs' }),
  mk('bill', 'Studio Pixel <billing@studiopixel.io>', 'Invoice INV-2041 from Studio Pixel', 'Hi, please find invoice INV-2041 attached. Amount due: €480.00. Due date: 1 December 2026. Bank transfer details inside.', { att: pdf('INV-2041.pdf') }),
  mk('bill', 'Pražská plynárenská <zakaznik@ppas.cz>', 'Dokument k dispozici', 'Ve vašem zákaznickém účtu je nový dokument. Přihlaste se pro zobrazení. Detail: záloha na plyn 1 980 Kč, splatnost 25. 11. 2026, k úhradě převodem.', { lang: 'cs', tricky: 'harmless subject, amount later in body' }),
  mk('bill', 'Landlord Petr <petr.novak@seznam.cz>', 'Nájem prosinec', 'Ahoj, posílám připomínku: nájem 18 500 Kč za prosinec prosím zaplať do 5. 12. 2026 na obvyklý účet. Díky, Petr', { cat: P, lang: 'cs', tricky: 'personal sender, real bill' }),
  mk('bill', 'City of Prague <pokuty@praha.eu>', 'Výzva k zaplacení pokuty', 'Byla vám uložena pokuta za parkování. Částka 500 Kč. Uhraďte do 30. 11. 2026, číslo jednací PRK-77812.', { lang: 'cs' }),
  mk('bill', 'Acme Hosting <accounts@acmehost.net>', 'Your account statement', 'Hello, your account statement for October is available. There is an outstanding balance of $36.00 payable by Nov 28, 2026. Please pay to avoid suspension.', { tricky: 'statement wording, unpaid inside' }),
  mk('bill', 'Airtel <ebill@airtel.in>', 'Airtel postpaid bill', 'Your Airtel bill of Rs. 799 is generated. Due date 22-11-2026. बिल भुगतान देय तिथि से पहले करें।', { lang: 'hi' }),
  mk('bill', 'BSES Rajdhani <bills@bsesdelhi.com>', 'बिजली बिल', 'आपका बिजली बिल ₹2,340 है। देय तिथि: 2026-11-26. Pay online to avoid late fee.', { lang: 'hi' }),
  mk('bill', 'Univerzita Karlova <studijni@cuni.cz>', 'Poplatek za studium', 'Byl vám vyměřen poplatek 2 000 Kč. Splatnost 15. 12. 2026. Platbu proveďte převodem s variabilním symbolem 990122.', { lang: 'cs' }),
  mk('bill', 'O2 Czech Republic <vyuctovani@o2.cz>', 'Elektronické vyúčtování služeb', 'Vyúčtování za období 10/2026. Částka k úhradě 512 Kč. Datum splatnosti 19. 11. 2026.', { lang: 'cs', html: ld({ '@context': 'http://schema.org', '@type': 'Invoice', totalPaymentDue: { '@type': 'PriceSpecification', price: '512', priceCurrency: 'CZK' }, paymentDueDate: '2026-11-19', provider: { name: 'O2' } }) + 'Vyúčtování</body></html>' }),
  mk('bill', 'Kooperativa <platby@koop.cz>', 'Předpis pojistného 2027', 'Pojistné na rok 2027 činí 6 120 Kč. Prosíme o úhradu do 31. 12. 2026. Číslo smlouvy 8800123.', { lang: 'cs', att: pdf('predpis.pdf') }),
  mk('bill', 'Finanční úřad <podatelna@fs.mfcr.cz>', 'Platební výměr', 'Dobrý den, v příloze zasíláme platební výměr. Daň k úhradě 3 400 Kč, splatnost 10. 12. 2026.', { lang: 'cs', att: pdf('vymer.pdf') }),
  mk('bill', 'Freelance client Jana <jana@designlab.cz>', 'Re: faktura za listopad', 'Dobrý den, posílám fakturu FV-2026-118 na 12 000 Kč se splatností 14 dní (do 18. 11. 2026). Díky Jana', { cat: P, lang: 'cs', tricky: 'reply thread' }),
  mk('bill', 'Dentist Dr. Malá <recepce@zubarmala.cz>', 'Účet za ošetření', 'Účet za ošetření 1 800 Kč. Prosíme uhradit do 21. 11. 2026 převodem. Děkujeme.', { cat: P, lang: 'cs' }),
  mk('bill', 'Hetzner Online <billing@hetzner.com>', 'Rechnung R0012345678', 'Sehr geehrter Kunde, Ihre Rechnung über 14,28 € ist fällig am 24.11.2026. Bitte überweisen Sie den Betrag.', { lang: 'de' }),
  mk('bill', 'Dopravní podnik <eshop@dpp.cz>', 'Upozornění: nezaplacená objednávka', 'Vaše objednávka kupónu není zaplacena. Částka 3 650 Kč, zaplaťte do 12. 11. 2026, jinak bude zrušena.', { lang: 'cs' }),
  mk('bill', 'SVJ Vinohradská <vybor@svj-vino.cz>', 'Zálohy na služby 2027', 'Vážení vlastníci, zálohy na služby od ledna 2027 činí 2 450 Kč měsíčně. První platba splatná 15. 1. 2027.', { cat: P, lang: 'cs', tricky: 'unfamiliar sender' }),
  mk('bill', 'Tata Power <noreply@tatapower.com>', 'Electricity bill for Nov', 'Dear customer, your bill amount ₹1,120 is due on 2026-11-29. Pay via UPI or net banking.', { lang: 'en' }),
  mk('bill', 'Mobile Pay Ltd <collections@mobilepay-collect.com>', 'Final notice', 'This is a final notice: amount €59.90 overdue. Pay by 9 November 2026 to avoid collection fees. Ref COLL-55120.', { tricky: 'unfamiliar sender' }),
  mk('bill', 'Škola Kampa <skola@zskampa.cz>', 'Platba za lyžařský kurz', 'Dobrý den, prosíme o úhradu lyžařského kurzu 6 500 Kč do 30. 11. 2026. VS 22011.', { cat: P, lang: 'cs' }),
  mk('bill', 'Google Workspace <payments-noreply@google.com>', 'Your invoice is available', 'Your Google Workspace invoice for October is available. Amount due $12.00 will be charged automatically on Nov 30, 2026.', { tricky: 'auto-charge (still a bill notice)' })
);
// ---------------- payment (20) ----------------
L.push(
  mk('payment', 'Revolut <no-reply@revolut.com>', 'You paid Albert', 'You paid 289.50 CZK at Albert Vinohrady with your card ending 1144.', {}),
  mk('payment', 'PayPal <service@paypal.com>', 'You sent a payment', 'You sent €25.00 EUR to Marek Svoboda. Transaction ID 7HY55301KL.', {}),
  mk('payment', 'Fio banka <automat@fio.cz>', 'Fio banka - příchozí platba', 'Příchozí platba 12 000 Kč na účet ****1234 od DesignLab s.r.o., VS 2026118.', { lang: 'cs' }),
  mk('payment', 'Wise <noreply@wise.com>', 'Your money is on its way', 'Your transfer of 500 EUR to Anita Sharma is on its way. It should arrive by Thursday.', {}),
  mk('payment', 'HDFC Bank <alerts@hdfcbank.net>', 'Transaction alert', 'Rs. 1,499.00 debited from a/c **3321 on 02-11-2026 via UPI to SWIGGY. UPI ref 630912345.', { lang: 'en' }),
  mk('payment', 'ICICI Bank <credit_cards@icicibank.com>', 'लेनदेन अलर्ट', 'आपके कार्ड से ₹649 का भुगतान Netflix को हुआ है। Transaction on 01-11-2026.', { lang: 'hi' }),
  mk('payment', 'Komerční banka <info@kb.cz>', 'Odchozí platba provedena', 'Odchozí platba 18 500 Kč na účet 123456789/0800 byla provedena. Zpráva: nájem prosinec.', { lang: 'cs' }),
  mk('payment', 'Stripe <receipts@stripe.com>', 'Payment received for invoice INV-2041', 'Studio Pixel received your payment of €480.00 for invoice INV-2041. Thank you.', {}),
  mk('payment', 'Air Bank <info@airbank.cz>', 'Platba kartou', 'Zaplatili jste kartou 1 120 Kč u ALZA.CZ dne 1. 11. 2026.', { lang: 'cs' }),
  mk('payment', 'Trading 212 <noreply@trading212.com>', 'Your withdrawal request has been received', 'We are processing your CZK 250.00 withdrawal. It usually arrives within 1-2 business days.', { tricky: 'pending payout' }),
  mk('payment', 'Google Pay <googlepay-noreply@google.com>', 'You paid Uber', 'You paid €14.20 to Uber on 31 Oct 2026 with Visa •••• 1144.', {}),
  mk('payment', 'Paytm <no-reply@paytm.com>', 'Payment successful', '₹350 paid to Chai Point. UPI transaction ID 9921345. Thank you for using Paytm!', { lang: 'en' }),
  mk('payment', 'Česká spořitelna <noreply@csas.cz>', 'Platba se nezdařila', 'Platba 990 Kč příjemci T-Mobile se nezdařila z důvodu nedostatku prostředků.', { lang: 'cs', tricky: 'failed payment' }),
  mk('payment', 'Splitwise <hello@splitwise.com>', 'Ondra recorded a payment', 'Ondra paid you 420 Kč for "Dinner at Lokál". Your balance is settled.', { tricky: 'social-ish money app' }),
  mk('payment', 'SBI <alerts@sbi.co.in>', 'Account credited', 'Your a/c XX4410 is credited with INR 25,000.00 on 01-11-2026 by NEFT from ANITA S.', { lang: 'en' }),
  mk('payment', 'Moje banka Online <info@mojebanka-online.cz>', 'Potvrzení platby', 'Platba 2 000 Kč na účet univerzity byla úspěšně odeslána. VS 990122.', { lang: 'cs', tricky: 'unfamiliar sender' }),
  mk('payment', 'Apple <no_reply@email.apple.com>', 'Your receipt from Apple', 'Apple ID: you were charged €2.99 for iCloud+ 50 GB. Order ID ML7KX99Z.', { tricky: 'receipt or payment' }),
  mk('payment', 'Bolt <receipts@bolt.eu>', 'Your Bolt ride receipt', 'Thanks for riding with Bolt. Total charged 186 Kč, card •••• 1144. Trip on 2 Nov 2026.', {}),
  mk('payment', 'N26 <noreply@n26.com>', 'Überweisung ausgeführt', 'Ihre Überweisung über 75,00 € an Lukas Weber wurde ausgeführt.', { lang: 'de' }),
  mk('payment', 'Fwd from Tomas <tomas.k@gmail.com>', 'Fwd: Payment confirmation', '---------- Forwarded message ---------- From: PayU. Your payment of 3 650 Kč to DPP e-shop was successful. Order 554120.', { cat: P, tricky: 'forwarded payment confirmation' })
);
// ---------------- refund (14) ----------------
L.push(
  mk('refund', 'Amazon.de <rueckerstattung@amazon.de>', 'Ihre Rückerstattung', 'Wir haben eine Rückerstattung von 39,99 € für Bestellung 302-1188776 veranlasst. Gutschrift in 3-5 Tagen.', { lang: 'de' }),
  mk('refund', 'Alza.cz <info@alza.cz>', 'Vrácení peněz za objednávku', 'Peníze 1 120 Kč za objednávku 554433 vám vrátíme na kartu do 5 pracovních dní.', { lang: 'cs' }),
  mk('refund', 'Booking.com <noreply@booking.com>', 'Your refund has been processed', 'The refund of €82.00 for reservation 4123987 has been processed to your card.', {}),
  mk('refund', 'Uber <uber.cz@uber.com>', 'Refund for your trip', 'We refunded 120 Kč to your payment method for the trip on 29 Oct.', {}),
  mk('refund', 'Flipkart <noreply@flipkart.com>', 'रिफंड प्रोसेस हुआ', 'आपका ₹1,299 का रिफंड ऑर्डर OD43219876 के लिए प्रोसेस कर दिया गया है।', { lang: 'hi' }),
  mk('refund', 'Finanční správa <info@fs.mfcr.cz>', 'Vrácení přeplatku daně', 'Přeplatek na dani 6 540 Kč vám bude vrácen na účet do 30 dnů.', { lang: 'cs', tricky: 'tax refund' }),
  mk('refund', 'Zalando <service@zalando.cz>', 'Vratka přijata', 'Vaši vratku jsme přijali. Částka 1 590 Kč bude připsána do 7 dní. Objednávka 10203040.', { lang: 'cs' }),
  mk('refund', 'Ryanair <noreply@ryanair.com>', 'Refund request received', 'Your refund request for booking ABC12D has been received. Amount €45.98 will be processed within 7 days.', {}),
  mk('refund', 'Swiggy <noreply@swiggy.in>', 'Refund initiated', '₹220 refund initiated for order 1188290 due to missing item. Credited to source in 5-7 days.', {}),
  mk('refund', 'Company Finance <finance@acme-corp.eu>', 'Expense reimbursement approved', 'Your expense report ER-2219 was approved. €140.00 will be reimbursed with the next payroll.', { cat: P, tricky: 'reimbursement' }),
  mk('refund', 'Decathlon <eshop@decathlon.cz>', 'Refundace objednávky', 'Refundace 799 Kč za objednávku 7781120 byla dokončena.', { lang: 'cs' }),
  mk('refund', 'Wolt <info@wolt.com>', 'Your refund', 'We have refunded 159 Kč for the missing drink in your order from Pizza Napoli.', {}),
  mk('refund', 'Klára S. <klara.s@email.cz>', 'Fwd: Refund confirmation', '---------- Forwarded message ---------- From: eshop. The refund of 2 300 Kč for your returned shoes was sent today.', { cat: P, tricky: 'forwarded refund' }),
  mk('refund', 'Lufthansa <noreply@lufthansa.com>', 'Erstattung Ihrer Buchung', 'Die Erstattung über 212,00 € für Buchung LH7Q2K wurde veranlasst.', { lang: 'de' })
);
// ---------------- travel (22) ----------------
const flightLd = (ref, from, to, dep) => ld({ '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: ref, reservationStatus: 'http://schema.org/Confirmed', underName: { '@type': 'Person', name: 'Test User' }, reservationFor: { '@type': 'Flight', flightNumber: 'FR1234', airline: { name: 'Ryanair' }, departureAirport: { '@type': 'Airport', iataCode: from }, arrivalAirport: { '@type': 'Airport', iataCode: to }, departureTime: dep } }) + 'Your flight</body></html>';
L.push(
  mk('travel', 'Ryanair <itinerary@ryanair.com>', 'Your booking confirmation ABC12D', 'Booking reference ABC12D. Prague (PRG) to Dublin (DUB) on 14 Nov 2026 06:25. Check-in opens 24 hours before.', { html: flightLd('ABC12D', 'PRG', 'DUB', '2026-11-14T06:25:00+01:00') }),
  mk('travel', 'Booking.com <noreply@booking.com>', 'Your booking is confirmed at Hotel Lisboa', 'Confirmation number 4123987. Check-in 20 Nov 2026, check-out 23 Nov 2026. Total price €246.', { html: ld({ '@context': 'http://schema.org', '@type': 'LodgingReservation', reservationNumber: '4123987', checkinDate: '2026-11-20', checkoutDate: '2026-11-23', reservationFor: { '@type': 'LodgingBusiness', name: 'Hotel Lisboa' } }) + 'Booking</body></html>' }),
  mk('travel', 'RegioJet <jizdenky@regiojet.cz>', 'Jízdenka Praha – Brno', 'Vaše jízdenka č. 2211334455. Odjezd 16. 11. 2026 v 7:05 z Praha hl.n., vůz 4, místo 52.', { lang: 'cs' }),
  mk('travel', 'České dráhy <eshop@cd.cz>', 'Potvrzení nákupu jízdenky', 'Kód jízdenky KX8822. Praha – Plzeň, 18. 11. 2026, odjezd 10:12. Cena 189 Kč.', { lang: 'cs' }),
  mk('travel', 'IRCTC <ticketadmin@irctc.co.in>', 'टिकट बुकिंग पुष्टि PNR 4521367890', 'PNR 4521367890. Train 12951 Mumbai Rajdhani, journey date 14-12-2026, coach B2 berth 33. Fare Rs. 3,250.', { lang: 'hi' }),
  mk('travel', 'IndiGo <reservations@goindigo.in>', 'Your IndiGo itinerary', 'PNR Q7XK2P. DEL to BOM 6E 2025 on 15 Dec 2026 at 09:40. Web check-in is open.', {}),
  mk('travel', 'Airbnb <automated@airbnb.com>', 'Reservation confirmed for Lisbon', 'Your reservation HMX9QK2A is confirmed. Check-in Fri 20 Nov after 15:00.', {}),
  mk('travel', 'Lufthansa <online@booking-lufthansa.com>', 'Ihre Buchungsbestätigung', 'Buchungsnummer LH7Q2K. Flug LH 1395 Prag – Frankfurt am 2. 12. 2026, Abflug 06:10.', { lang: 'de' }),
  mk('travel', 'FlixBus <noreply@flixbus.com>', 'Your FlixBus booking 3021987745', 'Booking number 3021987745. Prague – Vienna, 22 Nov 2026 at 08:00. Show the QR code to the driver.', {}),
  mk('travel', 'Smartwings <noreply@smartwings.com>', 'Boarding pass QS 1022', 'Your boarding pass for QS1022 Prague – Larnaca on 5 Dec 2026. Seat 14C. Booking ref T7K9QW.', { att: [{ name: 'boarding.pkpass', mimeType: 'application/vnd.apple.pkpass', size: 32000 }] }),
  mk('travel', 'Trainline <auto-confirm@info.thetrainline.com>', 'Your tickets are ready', 'Booking reference TL88Q1Z. London to Oxford, 10 Dec 2026 09:30. Mobile ticket attached.', {}),
  mk('travel', 'MakeMyTrip <noreply@makemytrip.com>', 'Hotel booking confirmed', 'Booking ID NH71123399. Hotel Taj, Jaipur. Check-in 26 Dec 2026. Amount paid ₹8,450.', {}),
  mk('travel', 'Travel agency Sunny <rezervace@sunnytravel.cz>', 'Potvrzení zájezdu', 'Potvrzujeme rezervaci zájezdu Kréta, číslo rezervace SNY-20271, odlet 12. 6. 2027 z Prahy.', { lang: 'cs', tricky: 'unfamiliar sender' }),
  mk('travel', 'Expedia <travel@expedia.com>', 'Expedia itinerary 7311229988', 'Itinerary # 7311229988. Rental car pickup at Lisbon Airport 20 Nov 2026 10:00.', {}),
  mk('travel', 'Wizz Air <noreply@wizzair.com>', 'Online check-in is open', 'Check in now for W6 2345 Prague – Rome, 30 Nov 2026. Confirmation code KL3PQ7.', {}),
  mk('travel', 'ÖBB <tickets@oebb.at>', 'Ihr Ticket', 'Ticketcode 1122-334455. Wien Hbf – Salzburg Hbf, 23.11.2026, 09:30. Reservierung Wagen 27 Platz 45.', { lang: 'de' }),
  mk('travel', 'Lenka <lenka.d@gmail.com>', 'Fwd: Your flight to Barcelona', '---------- Forwarded message ---------- From: Vueling. Booking code VY3RT2. Prague – Barcelona 9 Jan 2027 at 13:15.', { cat: P, tricky: 'forwarded booking' }),
  mk('travel', 'Prague Airport Parking <parking@prg.aero>', 'Rezervace parkování', 'Rezervace parkování P1 č. PK-88123 od 14. 11. 2026 5:00 do 17. 11. 2026. Cena 990 Kč.', { lang: 'cs' }),
  mk('travel', 'Hostel Mondo <info@hostelmondo.it>', 'Prenotazione / Reservation', 'Reservation code MND-4411 confirmed for 30 Nov – 2 Dec 2026, 2 guests.', { tricky: 'unfamiliar sender, Italian' }),
  mk('travel', 'Eurowings <service@eurowings.com>', 'Flight schedule change', 'Your flight EW 8121 on 3 Dec 2026 now departs at 11:40 instead of 10:55. Booking code EWQ7Z1.', {}),
  mk('travel', 'Hertz <reservations@hertz.com>', 'Your Hertz reservation K7712345', 'Confirmation number K7712345. Pick-up Prague Airport 14 Nov 2026 08:00.', {}),
  mk('travel', 'Uber <uber.cz@uber.com>', 'Upcoming reservation', 'Your Uber Reserve ride to Prague Airport on 14 Nov 2026 at 04:30 is confirmed. Booking ref UR-11902.', { tricky: 'ride reservation' })
);
// ---------------- food (12) ----------------
L.push(
  mk('food', 'Wolt <info@wolt.com>', 'Your order from Pizza Napoli', 'Thanks for your order! Total 389 Kč. Estimated delivery 19:40. Order #WT-881920.', {}),
  mk('food', 'foodora <info@foodora.cz>', 'Objednávka přijata', 'Vaše objednávka z restaurace Pho Vietnam byla přijata. Celkem 312 Kč, doručení do 30 minut.', { lang: 'cs' }),
  mk('food', 'Swiggy <noreply@swiggy.in>', 'Order delivered', 'Your order from Biryani Blues has been delivered. Total paid ₹540. Order 1188290.', {}),
  mk('food', 'Zomato <noreply@zomato.com>', 'Your Zomato order summary', 'Order ID 6612394. Paneer Tikka x2, Naan x4. Total ₹890.', {}),
  mk('food', 'OpenTable <member_services@opentable.com>', 'Reservation confirmed at Field', 'Your table for 2 at Field on Sat 21 Nov 2026 at 19:30 is confirmed. Confirmation 99812.', { html: ld({ '@context': 'http://schema.org', '@type': 'FoodEstablishmentReservation', startTime: '2026-11-21T19:30:00+01:00', partySize: 2, reservationFor: { '@type': 'FoodEstablishment', name: 'Field' }, reservationNumber: '99812' }) + 'table</body></html>' }),
  mk('food', 'Restaurace U Modré kachničky <rezervace@umodrekachnicky.cz>', 'Potvrzení rezervace stolu', 'Potvrzujeme rezervaci stolu pro 4 osoby na 28. 11. 2026 v 19:00.', { lang: 'cs', tricky: 'unfamiliar sender' }),
  mk('food', 'Uber Eats <uber.eats@uber.com>', 'Your Uber Eats order', 'Thanks for ordering from Burger Bar. Total €18.40. Delivered 20:12.', {}),
  mk('food', 'Dáme jídlo <info@damejidlo.cz>', 'Objednávka jídla doručena', 'Objednávka č. 774411 z Lokál Dlouhá byla doručena. Zaplaceno 455 Kč.', { lang: 'cs' }),
  mk('food', 'TheFork <noreply@thefork.com>', 'Booking confirmed: La Finestra', 'Your reservation at La Finestra for 2 people on 4 Dec 2026, 20:00. Booking ref TF-55290.', {}),
  mk('food', 'Rohlik.cz <info@rohlik.cz>', 'Objednávka jídla na cestě', 'Vaše objednávka 9918822 je na cestě. Celkem 1 245 Kč. Doručení 18:00–19:00.', { lang: 'cs', tricky: 'grocery delivery' }),
  mk('food', 'Bistro Tomas <tomas@bistrotomas.cz>', 'Re: rezervace pátek', 'Dobrý den, rezervaci stolu na pátek 13. 11. v 18:30 pro 6 osob potvrzuji. Tomáš', { cat: P, lang: 'cs', tricky: 'personal-looking restaurant reply' }),
  mk('food', 'Domino\'s <noreply@dominos.co.in>', 'Order confirmed', 'Your Domino\'s order 55120 is confirmed. ₹649. Estimated delivery 30 mins.', {})
);
// ---------------- subscription (14) ----------------
L.push(
  mk('subscription', 'Netflix <info@account.netflix.com>', 'Your membership will renew soon', 'Your Netflix Standard plan renews on 15 Nov 2026 for 259 Kč.', {}),
  mk('subscription', 'Spotify <no-reply@spotify.com>', 'Your Spotify Premium receipt', 'Spotify Premium Individual 169 Kč charged on 1 Nov 2026. Next renewal 1 Dec 2026.', {}),
  mk('subscription', 'Adobe <mail@mail.adobe.com>', 'Your annual plan renews in 30 days', 'Your Creative Cloud annual plan renews on 3 Dec 2026 for €290.40.', { lu: true, tricky: 'List-Unsubscribe on a renewal' }),
  mk('subscription', 'Cursor <billing@cursor.so>', 'Your subscription has been renewed', 'Pro plan renewed: $20.00 charged on Nov 2, 2026. Invoice in your dashboard.', {}),
  mk('subscription', 'Apple <no_reply@email.apple.com>', 'Subscription renewal confirmation', 'Apple One Individual renewed for 285 Kč. Renews monthly until cancelled.', {}),
  mk('subscription', 'YouTube <noreply@youtube.com>', 'YouTube Premium membership', 'Your YouTube Premium membership renews on 20 Nov 2026 for 239 Kč.', {}),
  mk('subscription', 'Microsoft <microsoft-noreply@microsoft.com>', 'Your Microsoft 365 subscription will renew', 'Microsoft 365 Personal renews on 1 Dec 2026, CZK 1 899 per year.', {}),
  mk('subscription', 'Disney+ <disneyplus@mail.disneyplus.com>', 'Trial ends soon', 'Your free trial ends on 10 Nov 2026. You will be charged €8.99/month unless you cancel.', { lu: true }),
  mk('subscription', 'Jio <care@jio.com>', 'सदस्यता नवीनीकरण', 'आपका JioFiber प्लान ₹999 के साथ 25-11-2026 को रिन्यू होगा।', { lang: 'hi' }),
  mk('subscription', 'Medium <noreply@medium.com>', 'Your membership renewal', 'Your Medium membership will renew on Nov 18, 2026 for $5.00.', { lu: true }),
  mk('subscription', 'Seznam Email Profi <podpora@seznam.cz>', 'Obnovení předplatného', 'Předplatné Email Profi bude obnoveno 30. 11. 2026 za 99 Kč.', { lang: 'cs' }),
  mk('subscription', 'Gym Fit <clenstvi@gymfit.cz>', 'Členství bude prodlouženo', 'Vaše členství bude automaticky prodlouženo 1. 12. 2026, poplatek 990 Kč měsíčně.', { lang: 'cs', tricky: 'unfamiliar sender' }),
  mk('subscription', 'Dropbox <no-reply@dropbox.com>', 'Your Dropbox Plus plan renewed', 'Dropbox Plus renewed for €11.99 on 2 Nov 2026.', {}),
  mk('subscription', 'Notion <team@makenotion.com>', 'Plan changed', 'Your Notion plan changed to Plus, billed $10/month starting Nov 15, 2026.', {})
);
// ---------------- receipt (18) ----------------
L.push(
  mk('receipt', 'Alza.cz <objednavky@alza.cz>', 'Potvrzení objednávky 554433', 'Děkujeme za objednávku 554433. Celkem 1 120 Kč, zaplaceno kartou. Doručení zítra.', { lang: 'cs' }),
  mk('receipt', 'Amazon.de <bestellbestaetigung@amazon.de>', 'Ihre Bestellung bei Amazon.de', 'Bestellung 302-1188776. Gesamtsumme 39,99 €. Voraussichtliche Lieferung: Mittwoch.', { lang: 'de' }),
  mk('receipt', 'IKEA <noreply@ikea.cz>', 'Vaše účtenka', 'Elektronická účtenka z IKEA Zličín. Celkem 2 349 Kč. Číslo dokladu 88112233.', { lang: 'cs' }),
  mk('receipt', 'Flipkart <noreply@flipkart.com>', 'Order placed', 'Your order OD43219876 for boAt headphones is placed. Total ₹1,299.', {}),
  mk('receipt', 'Mall.cz <info@mall.cz>', 'Objednávka odeslána', 'Objednávka 7781120 byla odeslána. Celkem 799 Kč. Sledovat zásilku.', { lang: 'cs', cat: PR, tricky: 'receipt in Promotions tab' }),
  mk('receipt', 'Decathlon <eshop@decathlon.cz>', 'Thanks for your order', 'Order 7781121: running shoes, total 1 999 Kč. Paid by card.', { cat: PR, tricky: 'receipt in Promotions tab' }),
  mk('receipt', 'Steam <noreply@steampowered.com>', 'Thank you for your Steam purchase', 'Purchase of Hades II, €29.99. Transaction 4419928112.', {}),
  mk('receipt', 'Rohlik.cz <info@rohlik.cz>', 'Účtenka k objednávce', 'Účtenka k objednávce 9918821. Celkem 845 Kč.', { lang: 'cs' }),
  mk('receipt', 'eBay <ebay@ebay.com>', 'Order confirmed: vintage camera', 'Order number 21-11223-44556. Total $84.50 including shipping.', {}),
  mk('receipt', 'Zalando <service@zalando.cz>', 'Potvrzení objednávky', 'Objednávka 10203040: bunda, 1 590 Kč. Doručíme do 3 dnů.', { lang: 'cs' }),
  mk('receipt', 'Nykaa <noreply@nykaa.com>', 'ऑर्डर की पुष्टि', 'आपका ऑर्डर NYK7712 कन्फर्म हो गया है। कुल ₹1,050।', { lang: 'hi' }),
  mk('receipt', 'Shop Unknown <orders@small-ceramics-studio.com>', 'Order #1043 confirmed', 'Hi! Thanks for ordering two mugs. Order #1043, total €38.00, ships Monday.', { tricky: 'unfamiliar sender' }),
  mk('receipt', 'Michal <michal.b@gmail.com>', 'Fwd: Your receipt from Datart', '---------- Forwarded message ---------- From: Datart. Účtenka: televize 12 990 Kč, objednávka 66123, zaplaceno.', { cat: P, lang: 'cs', tricky: 'forwarded receipt' }),
  mk('receipt', 'Lidl <eshop@lidl.cz>', 'Potvrzení objednávky', 'Objednávka 3311990, celkem 649 Kč, platba kartou proběhla.', { lang: 'cs', cat: PR, lu: true, tricky: 'receipt with List-Unsubscribe in Promotions' }),
  mk('receipt', 'Apple <no_reply@email.apple.com>', 'Your receipt from Apple', 'Receipt: AirPods case, €49.00. Order W1188221.', {}),
  mk('receipt', 'Bookshop Luxor <eshop@luxor.cz>', 'Objednávka zaplacena', 'Objednávka 552190 zaplacena, celkem 498 Kč. Knihy odešleme zítra.', { lang: 'cs' }),
  mk('receipt', 'GOG.com <noreply@gog.com>', 'Thank you for your order', 'Order 8812-3301: Disco Elysium, €9.99.', { cat: PR, lu: true }),
  mk('receipt', 'Amazon.in <auto-confirm@amazon.in>', 'Your Amazon.in order', 'Order #405-7712345. Kindle Paperwhite, ₹13,999. Arriving Friday.', {})
);
// ---------------- document (10) ----------------
L.push(
  mk('document', 'Kooperativa <smlouvy@koop.cz>', 'Pojistná smlouva', 'V příloze zasíláme vaši pojistnou smlouvu č. 8800123 a pojistné podmínky.', { lang: 'cs', att: pdf('smlouva.pdf') }),
  mk('document', 'DocuSign <dse@docusign.net>', 'Completed: Rental agreement', 'All parties have signed "Rental agreement Vinohradská 12". The completed document is attached.', { att: pdf('agreement.pdf') }),
  mk('document', 'Czech Embassy <consular@mzv.cz>', 'Visa appointment confirmation', 'Your visa appointment is confirmed. Bring your passport and the attached checklist.', { att: pdf('checklist.pdf') }),
  mk('document', 'Fio banka <vypisy@fio.cz>', 'Výpis z účtu 10/2026', 'V příloze zasíláme výpis z účtu za říjen 2026.', { lang: 'cs', att: pdf('vypis.pdf'), tricky: 'bank statement, not a bill' }),
  mk('document', 'Univerzita Karlova <studijni@cuni.cz>', 'Potvrzení o studiu', 'V příloze potvrzení o studiu pro účely daňového přiznání.', { lang: 'cs', att: pdf('potvrzeni.pdf') }),
  mk('document', 'HR Acme <hr@acme-corp.eu>', 'Your employment certificate', 'Please find attached your employment certificate as requested.', { cat: P, att: pdf('certificate.pdf') }),
  mk('document', 'Income Tax Dept <noreply@incometax.gov.in>', 'ITR-V acknowledgement', 'Your income tax return for AY 2026-27 has been filed. Acknowledgement attached.', { att: pdf('itrv.pdf') }),
  mk('document', 'Notář Dvořák <kancelar@notar-dvorak.cz>', 'Návrh kupní smlouvy', 'Dobrý den, posílám návrh kupní smlouvy k připomínkám.', { cat: P, lang: 'cs', att: pdf('kupni-smlouva.pdf'), tricky: 'unfamiliar sender' }),
  mk('document', 'Allianz <service@allianz.de>', 'Ihre Versicherungsbestätigung', 'Anbei Ihre Versicherungsbestätigung für 2027.', { lang: 'de', att: pdf('bestaetigung.pdf') }),
  mk('document', 'VZP <info@vzp.cz>', 'Potvrzení o pojištění', 'Zasíláme potvrzení o zdravotním pojištění.', { lang: 'cs', att: pdf('vzp.pdf') })
);
// ---------------- security (8) ----------------
L.push(
  mk('security', 'Google <no-reply@accounts.google.com>', 'Security alert', 'New sign-in to your Google Account on a Windows device. If this was you, no action needed.', {}),
  mk('security', 'Revolut <no-reply@revolut.com>', 'Your verification code', 'Your Revolut verification code is 482113. Do not share it with anyone.', {}),
  mk('security', 'GitHub <noreply@github.com>', '[GitHub] Please verify your device', 'Verification code: 993112. This code expires in 15 minutes.', {}),
  mk('security', 'Microsoft account team <account-security-noreply@accountprotection.microsoft.com>', 'Microsoft account password reset', 'Use this code to reset your password: 771234.', {}),
  mk('security', 'Fio banka <bezpecnost@fio.cz>', 'Nové přihlášení do internetbankingu', 'Zaznamenali jsme nové přihlášení z neznámého zařízení 2. 11. 2026.', { lang: 'cs' }),
  mk('security', 'HDFC Bank <alerts@hdfcbank.net>', 'OTP for transaction', 'OTP 448812 for transaction of Rs. 4,999 at AMAZON. Valid for 5 minutes. Do not share.', { tricky: 'OTP with amount' }),
  mk('security', 'Apple <appleid@id.apple.com>', 'Your Apple ID was used to sign in', 'Your Apple ID was used to sign in to iCloud on a new device.', {}),
  mk('security', 'Seznam.cz <bezpecnost@seznam.cz>', 'Ověřovací kód', 'Váš ověřovací kód je 120944.', { lang: 'cs' })
);
// ---------------- promotion (24) ----------------
L.push(
  mk('promotion', 'Ryanair <ryanair@email.ryanair.com>', 'Flights from €19.99 — this weekend only', 'Grab a seat sale: flights to Rome, Milan and Malta from €19.99. Book by Sunday.', { cat: PR, lu: true, tricky: 'travel promo with price' }),
  mk('promotion', 'Booking.com <email.campaign@sg.booking.com>', 'Save 15% on your next stay', 'Members get 15% off selected hotels in Lisbon. Limited time deal.', { cat: PR, lu: true, tricky: 'travel promo' }),
  mk('promotion', 'Alza.cz <newsletter@alza.cz>', 'Black Friday: slevy až 50 %', 'Výprodej elektroniky: slevy až 50 %. Akce platí do neděle.', { cat: PR, lu: true, lang: 'cs' }),
  mk('promotion', 'Zalando <news@zalando.cz>', 'Sleva 20 % na zimní bundy', 'Jen tento týden sleva 20 % na bundy. Kód ZIMA20.', { cat: PR, lu: true, lang: 'cs' }),
  mk('promotion', 'Wolt <info@wolt.com>', 'Free delivery all weekend 🍕', 'Free delivery on orders over 300 Kč this weekend. Use code WEEKEND.', { cat: PR, lu: true, tricky: 'food promo from food domain' }),
  mk('promotion', 'Swiggy <promotions@swiggy.in>', '60% OFF on your next order', 'Flat 60% off up to ₹120 on your next order. Use code TRYNEW.', { cat: PR, lu: true }),
  mk('promotion', 'Revolut <no-reply@revolut.com>', 'Earn 4% on your savings', 'Open a Savings Vault and earn up to 4% AER. Terms apply. Capital at risk.', { cat: PR, lu: true, tricky: 'bank promo' }),
  mk('promotion', 'Netflix <info@mailer.netflix.com>', 'New on Netflix this week', 'Watch the new season now. Plus: our top picks for you.', { cat: PR, lu: true }),
  mk('promotion', 'IKEA <news@ikea.cz>', 'Novinky a akce v IKEA', 'Podzimní akce: vybrané pohovky o 3 000 Kč levněji.', { cat: PR, lu: true, lang: 'cs', tricky: 'amount in promo' }),
  mk('promotion', 'Myntra <offers@myntra.com>', 'End of season sale — min 50% off', 'EORS is live! Minimum 50% off on top brands.', { cat: PR, lu: true }),
  mk('promotion', 'Uber <uber@uber.com>', '50% off your next 3 rides', 'Ride for less: 50% off your next 3 rides in Prague, up to 100 Kč each.', { cat: PR, lu: true }),
  mk('promotion', 'Lufthansa <newsletter@mailing.lufthansa.com>', 'Ihr Angebot: Flüge ab 99 €', 'Entdecken Sie Europa: Flüge ab 99 € mit Lufthansa. Jetzt buchen.', { cat: PR, lu: true, lang: 'de', tricky: 'travel promo DE' }),
  mk('promotion', 'Rohlik.cz <info@rohlik.cz>', 'Akce týdne', 'Tento týden: ovoce a zelenina se slevou až 30 %.', { cat: PR, lu: true, lang: 'cs' }),
  mk('promotion', 'Coursera <no-reply@coursera.org>', 'Coursera Plus: 40% off', 'Limited-time offer: get Coursera Plus for 40% off. Ends Nov 10.', { cat: PR, lu: true }),
  mk('promotion', 'Airbnb <discover@airbnb.com>', 'Winter getaways under $100', 'Cosy cabins under $100 a night. Explore winter stays.', { cat: PR, lu: true, tricky: 'travel promo with price' }),
  mk('promotion', 'Apple <news@insideapple.apple.com>', 'Shop early for the holidays', 'Find the perfect gift. Free engraving and delivery.', { cat: PR, lu: true }),
  mk('promotion', 'Kiwi.com <newsletter@kiwi.com>', 'Prague → Barcelona from 1 290 Kč', 'Cheap flights this week: Prague to Barcelona from 1 290 Kč. Book now.', { cat: PR, lu: true, tricky: 'travel promo CZK' }),
  mk('promotion', 'Unknown Deals <hello@superdeal-mail.biz>', 'Exclusive coupon inside', 'Your exclusive coupon: save €10 on orders over €50. Limited time.', { cat: PR, lu: true, tricky: 'unfamiliar promo sender' }),
  mk('promotion', 'Dáme jídlo <akce@damejidlo.cz>', 'Sleva 100 Kč na první objednávku', 'Objednejte si jídlo se slevou 100 Kč. Kód JIDLO100.', { cat: PR, lu: true, lang: 'cs' }),
  mk('promotion', 'Amazon.in <store-news@amazon.in>', 'Great Indian Festival deals', 'Deals up to 70% off on electronics. Bank offers 10% instant discount.', { cat: PR, lu: true }),
  mk('promotion', 'Spotify <no-reply@spotify.com>', 'Try Premium Family', 'Get Premium Family for up to 6 accounts. 1 month free. Cancel anytime.', { cat: PR, lu: true, tricky: 'subscription promo' }),
  mk('promotion', 'Decathlon <news@decathlon.cz>', 'Zimní výprodej', 'Výprodej lyžařského vybavení se slevami až 40 %.', { cat: PR, lu: true, lang: 'cs' }),
  mk('promotion', 'Booking.com <deals@booking.com>', 'Last-minute deals for this weekend', 'Getaway deals: up to 25% off stays this weekend.', { lu: true, tricky: 'promo NOT in Promotions tab' }),
  mk('promotion', 'Hostel Mondo <news@hostelmondo.it>', 'Autumn offer: 3 nights for 2', 'Stay 3 nights, pay 2. Offer valid until 30 November.', { lu: true, tricky: 'unfamiliar promo, not in Promotions tab' })
);
// ---------------- newsletter (14) ----------------
L.push(
  mk('newsletter', 'Substack AI Weekly <aiweekly@substack.com>', 'This week in AI: agents everywhere', 'The biggest stories of the week in AI research and products.', { lu: true }),
  mk('newsletter', 'Seznam Zprávy <newsletter@seznamzpravy.cz>', 'Ranní přehled', 'Hlavní zprávy dne: počasí, doprava, politika.', { lu: true, lang: 'cs' }),
  mk('newsletter', 'The Economist <newsletters@economist.com>', 'The World in Brief', 'Catch up on the day’s global news.', { lu: true }),
  mk('newsletter', 'GitHub <noreply@github.com>', 'GitHub Changelog digest', 'Weekly digest: new features in Actions and Copilot.', { lu: true }),
  mk('newsletter', 'Fio banka <newsletter@fio.cz>', 'Fio zpravodaj listopad', 'Novinky ve službách banky a tipy na finanční plánování.', { lu: true, lang: 'cs', tricky: 'bank newsletter' }),
  mk('newsletter', 'Physics Dept <news@fzu.cz>', 'Seminar series: quantum optics', 'Upcoming seminars in November. Coffee from 15:30.', { cat: F, lu: true }),
  mk('newsletter', 'Hacker Newsletter <kale@hackernewsletter.com>', 'Hacker Newsletter #712', 'The best articles from Hacker News this week.', { lu: true }),
  mk('newsletter', 'Medium Daily Digest <noreply@medium.com>', 'Stories for you', 'Today’s highlights from writers you follow.', { lu: true }),
  mk('newsletter', 'Google Scholar Alerts <scholaralerts-noreply@google.com>', 'New results for "trapped ion Fock states"', 'New articles matching your alert.', { lu: true }),
  mk('newsletter', 'Rotary Club Praha <zpravodaj@rotary-praha.cz>', 'Zpravodaj klubu', 'Program setkání a novinky z klubu.', { cat: F, lu: true, lang: 'cs' }),
  mk('newsletter', 'Times of India <newsletter@timesofindia.com>', 'आज की बड़ी खबरें', 'देश और दुनिया की बड़ी खबरें एक जगह।', { lu: true, lang: 'hi' }),
  mk('newsletter', 'Python Weekly <rahul@pythonweekly.com>', 'Python Weekly - Issue 712', 'Articles, tutorials and projects for Python developers.', { lu: true }),
  mk('newsletter', 'Revolut <newsletter@revolut.com>', 'Your monthly money insights', 'See how you spent in October and tips for November.', { lu: true, tricky: 'money words, still newsletter' }),
  mk('newsletter', 'Community Forum <noreply@discourse.example.org>', '[Forum] Weekly summary', 'Top topics this week in the community forum.', { cat: F, lu: true })
);
// ---------------- social (10) ----------------
L.push(
  mk('social', 'LinkedIn <invitations@linkedin.com>', 'Anita wants to connect', 'Anita Sharma, Research Engineer, would like to join your network.', { cat: S, lu: true }),
  mk('social', 'LinkedIn <messages-noreply@linkedin.com>', 'You have a new message', 'Marek sent you a message: congrats on the new role!', { cat: S, lu: true }),
  mk('social', 'Facebook <notification@facebookmail.com>', 'Ondra commented on your photo', 'Ondra commented: great trip!', { cat: S, lu: true }),
  mk('social', 'Instagram <no-reply@mail.instagram.com>', 'New followers', 'lenka.d and 3 others started following you.', { cat: S, lu: true }),
  mk('social', 'X <notify@x.com>', 'Popular in your network', 'See what people are talking about.', { cat: S, lu: true }),
  mk('social', 'Strava <no-reply@strava.com>', 'Tomas gave you kudos', 'Tomas gave you kudos on Morning Run.', { cat: S, lu: true }),
  mk('social', 'Meetup <info@meetup.com>', 'New event: Prague Python Meetup', 'A new event was scheduled in your group for 19 Nov.', { cat: S, lu: true }),
  mk('social', 'Pinterest <recommendations@inspire.pinterest.com>', 'Ideas for your board', 'Pins you might like for "Home office".', { cat: S, lu: true }),
  mk('social', 'WhatsApp <noreply@whatsapp.com>', 'New login', 'Your WhatsApp account was registered on a new device.', { cat: S, tricky: 'social category but security-ish' , label: 'social' }),
  mk('social', 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', '15 new jobs for "physicist"', 'New jobs matching your preferences in Prague.', { cat: S, lu: true })
);
// ---------------- personal (12) ----------------
L.push(
  mk('personal', 'Mom <mom.family@gmail.com>', 'Sunday lunch', 'Hi dear, are you coming on Sunday? Dad is making dal.', { cat: P }),
  mk('personal', 'Marek Svoboda <marek.svoboda@email.cz>', 'Re: dinner money', 'Hey, you owe me 500 Kč for dinner, no rush, whenever you can :)', { cat: P, tricky: 'personal mail mentioning money' }),
  mk('personal', 'Prof. Novak <novak@fzu.cz>', 'Meeting on Thursday', 'Can we move our meeting to Thursday at 10? I want to discuss the Wigner function data.', { cat: P }),
  mk('personal', 'Anita Sharma <anita.s@gmail.com>', 'Photos from the trip', 'Uploaded the photos from Lisbon to the shared album!', { cat: P, tricky: 'travel words, personal' }),
  mk('personal', 'Brother <bro.kumar@gmail.com>', 'Call this weekend?', 'Bhai, call karna this weekend. Ghar pe sab theek hai.', { cat: P, lang: 'hi' }),
  mk('personal', 'Lab group <ionlab@fzu.cz>', 'Lab cleanup Friday', 'Reminder: lab cleanup on Friday at 14:00.', { cat: P }),
  mk('personal', 'Klára S. <klara.s@email.cz>', 'Kniha', 'Ahoj, vrátím ti tu knihu příští týden. Díky!', { cat: P, lang: 'cs' }),
  mk('personal', 'Tomas K. <tomas.k@gmail.com>', 'Ski trip planning', 'Shall we book the cabin for February? Roughly 4 000 Kč per person.', { cat: P, tricky: 'personal with amount + travel words' }),
  mk('personal', 'Recruiter Eva <eva@talentfirm.cz>', 'Position at QuantumTech', 'Dear Mr. Kumar, I came across your profile and would like to discuss a role.', { cat: P }),
  mk('personal', 'Neighbour Pavel <pavel.h@seznam.cz>', 'Balík', 'Mám u sebe tvůj balík, vyzvedni si ho večer.', { cat: P, lang: 'cs' }),
  mk('personal', 'Co-author Li <li.wei@uni.edu>', 'Re: manuscript revisions', 'I have addressed reviewer 2 comments, please check the SI.', { cat: P }),
  mk('personal', 'Sister <sis.kumar@gmail.com>', 'Diwali plans', 'Diwali pe aa rahe ho? Tickets book kar lo jaldi.', { cat: P, lang: 'hi', tricky: 'personal mentioning tickets' })
);

module.exports = { MAIL: L, CATEGORIES: ['bill', 'payment', 'refund', 'travel', 'food', 'subscription', 'receipt', 'document', 'security', 'promotion', 'newsletter', 'social', 'personal'], CRITICAL: ['bill', 'travel', 'payment', 'refund'] };
