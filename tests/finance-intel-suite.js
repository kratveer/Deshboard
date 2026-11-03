/**
 * Daylight Phase 2 — financial intelligence accuracy suite.
 * 52 single-email cases (EN / CZ / DE, clean + messy + negative) and 8 multi-email ledger sequences.
 * Reports per-category precision / recall / F1, a confusion matrix and the Phase 2 acceptance checks.
 * Synthetic, hand-written fixtures only (no real mail). Run: node tests/finance-intel-suite.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('../finance-intel.js');

const NOW = Date.parse('2026-11-03T18:00:00Z');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
let seq = 0;
function mail({ from, subject, body, labels, daysAgo, html, attachment }) {
  const id = 'f' + (++seq).toString().padStart(3, '0');
  const when = NOW - (daysAgo ?? 1) * 86400000;
  const parts = [{ mimeType: html ? 'text/html' : 'text/plain', body: { data: b64(body) } }];
  if (attachment) parts.push({ mimeType: 'application/pdf', filename: attachment, body: {} });
  return { id, threadId: 't' + id, labelIds: labels || ['INBOX', 'CATEGORY_UPDATES'], snippet: body.replace(/<[^>]+>/g, ' ').slice(0, 150), internalDate: String(when),
    payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date(when).toUTCString() }], parts } };
}
// expected: cat, amount [value,currency] | null, due 'YYYY-MM-DD' | null, sugg (reminder suggestion allowed), review (must be flagged), neg (negative set: must never become an obligation)
const C = [];
const add = (name, m, exp) => C.push({ name, m: mail(m), exp });

// ---- promotions with money words / amounts (negatives)
add('promo: referral offer with large amount', { from: 'Revolut <no-reply@revolut.com>', subject: 'Want to earn CZK1,250?', body: 'Hi Kratveer, earn yourself some extra cash when you invite friends to Revolut. Invite 3 friends and get up to €100,000 in rewards pool. Terms apply. Unsubscribe', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', neg: true });
add('promo: flight sale with price', { from: 'Smart Wings <news@smartwings.com>', subject: 'Flash sale: flights from 499 Kč', body: 'Limited time! Book now and save up to 40%. Flights to Lisbon from 499 Kč. Sale ends Sunday.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', neg: true });
add('promo: premium membership discount', { from: 'LinkedIn <offers@linkedin.com>', subject: 'Premium membership 50% off — upgrade today', body: 'Get Premium for 50% off your first 2 months. Your membership would renew at €29.99/month. Offer ends 30 November.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', neg: true });
add('promo: credit card offer', { from: 'Moneta <marketing@moneta.cz>', subject: 'Kreditní karta s limitem 150 000 Kč – získejte ji ještě dnes', body: 'Exkluzivní nabídka: kreditní karta bez poplatku, cashback 2 %. Získejte bonus 1 000 Kč. Akce platí do konce měsíce.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', neg: true });
add('promo: invoice templates newsletter', { from: 'Invoicely <newsletter@invoicely.com>', subject: '10 free invoice templates for freelancers', body: 'Our newsletter this week: download free invoice templates, plus 20% off Pro plans. Unsubscribe anytime.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', neg: true });
add('promo: price drop subscription ad (no label)', { from: 'Adobe <mail@mail.adobe.com>', subject: 'Now ₹999/mo. Ends 13 November.', body: 'Save 63% on Creative Cloud Pro. Special price for a limited time. Buy now.', labels: ['INBOX'] }, { cat: 'promotional_offer', neg: true });
add('promo: refund policy marketing', { from: 'Shop <hello@shop.example>', subject: 'Shop risk-free — 30-day refund policy + 20% off', body: 'Try our new collection with a 30-day refund policy. Use code SAVE20 for 20% off. Shop now.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', neg: true });

// ---- unpaid bills
add('cz: unpaid electricity invoice with due date', { from: 'ČEZ Prodej <info@cez.cz>', subject: 'Vyúčtování elektřiny – faktura č. 2026104455', body: 'Dobrý den, zasíláme vyúčtování elektřiny za období 10/2025–10/2026. Faktura č. 2026104455. Částka k úhradě: 1 240 Kč. Datum splatnosti: 25. 11. 2026. Variabilní symbol: 2026104455.', attachment: 'faktura-2026104455.pdf' }, { cat: 'unpaid_bill', amount: [1240, 'CZK'], due: '2026-11-25', sugg: true, inv: '2026104455' });
add('en: unpaid gas bill with explicit due date', { from: 'British Gas <billing@britishgas.co.uk>', subject: 'Your British Gas bill is ready', body: 'Your latest bill is ready. Amount due: £84.20. Please pay by 28 November 2026 to avoid late fees.' }, { cat: 'unpaid_bill', amount: [84.2, 'GBP'], due: '2026-11-28', sugg: true });
add('de: Rechnung fällig', { from: 'Telekom <rechnung@telekom.de>', subject: 'Ihre Rechnung Nr. 2026-1188', body: 'Guten Tag, Ihre Rechnung Nr. 2026-1188 über 59,90 € ist fällig am 30.11.2026. Bitte überweisen Sie den Betrag.' }, { cat: 'unpaid_bill', amount: [59.9, 'EUR'], due: '2026-11-30', sugg: true, inv: '2026-1188' });
add('en: overdue reminder with "if already paid" disclaimer', { from: 'Studio Pixel <accounts@studiopixel.io>', subject: 'Payment reminder: Invoice INV-2041', body: 'This is a friendly reminder that invoice INV-2041 for €350.00 was due on 1 November 2026. If you have already paid, please disregard this email.' }, { cat: 'unpaid_bill', amount: [350, 'EUR'], due: '2026-11-01', sugg: true, inv: 'INV-2041' });
add('cz: insurance premium k úhradě do', { from: 'Kooperativa <info@koop.cz>', subject: 'Pojistné na rok 2027 – předpis plateb', body: 'Vážený kliente, pojistné na rok 2027 činí 4 820 Kč, k úhradě do 31. 12. 2026. Variabilní symbol 7700123.' }, { cat: 'unpaid_bill', amount: [4820, 'CZK'], due: '2026-12-31', sugg: true });
add('en: tuition installment please pay by', { from: 'Charles University <fees@cuni.cz>', subject: 'Payment of tuition fees 1/3', body: 'Dear student, please pay the first installment of tuition fees, 32 000 Kč, by 15 January 2027.' }, { cat: 'unpaid_bill', amount: [32000, 'CZK'], due: '2027-01-15', sugg: true });
add('en: credit card statement with payment due', { from: 'Revolut <no-reply@revolut.com>', subject: 'Your credit card statement is ready', body: 'Your October statement is ready. Minimum payment €35.00. Payment due date: 15 December 2026.' }, { cat: 'unpaid_bill', amount: [35, 'EUR'], due: '2026-12-15', sugg: true });

// ---- bills that must NOT become reminders (missing / ambiguous / relative due date, direct debit)
add('bill without any due date', { from: 'Vodafone <billing@vodafone.cz>', subject: 'Your Vodafone bill for October is ready · 499 Kč', body: 'Your invoice for October is available in My Vodafone. Total 499 Kč.' }, { cat: 'unpaid_bill', amount: [499, 'CZK'], due: null, sugg: false, review: true, neg: true });
add('invoice with relative payment terms only', { from: 'Studio Pixel <accounts@studiopixel.io>', subject: 'Invoice #A-778 from Studio Pixel', body: 'Please find attached invoice #A-778. Total €1,200.00. Payment terms: 14 days.' }, { cat: 'unpaid_bill', amount: [1200, 'EUR'], due: null, sugg: false, review: true, neg: true });
add('invoice with ambiguous numeric due date', { from: 'Acme Hosting <billing@acmehost.com>', subject: 'Invoice 5521', body: 'Invoice 5521. Amount due $80.00, due 03/04/2026.' }, { cat: 'unpaid_bill', amount: [80, 'USD'], due: null, sugg: false, review: true, neg: true });
add('bill paid automatically by direct debit', { from: 'O2 <faktura@o2.cz>', subject: 'Vyúčtování služeb za říjen', body: 'Vyúčtování za říjen: 649 Kč. Částka bude stržena inkasem z vašeho účtu dne 20. 11. 2026.' }, { cat: 'unpaid_bill', amount: [649, 'CZK'], sugg: false, neg: true });

// ---- paid invoices / payment confirmations / receipts (must never be outstanding)
add('cz: invoice paid confirmation', { from: 'ČEZ Prodej <info@cez.cz>', subject: 'Potvrzení platby – faktura č. 2026104455 byla uhrazena', body: 'Děkujeme za vaši platbu. Faktura č. 2026104455 ve výši 1 240 Kč byla uhrazena dne 2. 11. 2026.' }, { cat: 'paid_invoice', amount: [1240, 'CZK'], due: null, sugg: false, neg: true, inv: '2026104455' });
add('en: electricity bill paid', { from: 'EDF Energy <noreply@edfenergy.com>', subject: 'Your electricity bill has been paid', body: 'Thank you. Your electricity bill of £61.30 has been paid in full. Balance: £0.00.' }, { cat: 'paid_invoice', amount: [61.3, 'GBP'], sugg: false, neg: true });
add('en: invoice paid with payment date', { from: 'Figma <billing@figma.com>', subject: 'Invoice INV-3301 — Paid', body: 'Invoice INV-3301. Status: Paid. Amount paid €29.00, paid on 2 Nov 2026.' }, { cat: 'paid_invoice', amount: [29, 'EUR'], sugg: false, neg: true, inv: 'INV-3301' });
add('usd invoice has been paid', { from: 'Upwork <billing@upwork.com>', subject: 'Invoice INV-99 has been paid', body: 'Invoice INV-99 has been paid. Amount: USD 1,250.00.' }, { cat: 'paid_invoice', amount: [1250, 'USD'], sugg: false, neg: true });
add('stripe receipt for SaaS', { from: 'Cursor <invoice+statements@mail.cursor.com>', subject: 'Your receipt from Cursor #2035-8591', body: 'Receipt #2035-8591. Amount paid $20.00. Date paid November 1, 2026. Payment method Visa •••• 4242.' }, { cat: 'purchase_receipt', amount: [20, 'USD'], sugg: false, neg: true });
add('apple app store receipt', { from: 'Apple <no_reply@email.apple.com>', subject: 'Your receipt from Apple', body: 'Receipt from Apple. You bought an app in the App Store for $15.99. Order ID: MKX92K1LP.' }, { cat: 'purchase_receipt', amount: [15.99, 'USD'], sugg: false, neg: true });
add('order confirmation', { from: 'Zalando <info@service-mail.zalando.cz>', subject: 'Your Zalando order is confirmed', body: 'Thank you for your order. Order number 10203040. Total 68,00 €. We will email you when it ships.', labels: ['INBOX', 'CATEGORY_PURCHASES'] }, { cat: 'purchase_receipt', amount: [68, 'EUR'], sugg: false, neg: true });
add('receipt that Gmail put in Promotions', { from: 'Uber Receipts <noreply@uber.com>', subject: 'Your Tuesday evening trip with Uber', body: 'Thanks for riding. Total 245 Kč. Receipt for your trip. Payment method •••• 1234. Unsubscribe from marketing.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'purchase_receipt', amount: [245, 'CZK'], sugg: false, review: true, neg: true });
add('de: payment received', { from: 'Telekom <rechnung@telekom.de>', subject: 'Zahlung erhalten', body: 'Vielen Dank für Ihre Zahlung von 59,90 €. Ihre Zahlung ist eingegangen.' }, { cat: 'payment_successful', amount: [59.9, 'EUR'], sugg: false, neg: true });
add('multi-currency: you paid for hotel', { from: 'Booking.com <noreply@booking.com>', subject: 'You paid ₹12,450.00 for your stay', body: 'Payment successful. You paid ₹12,450.00 for your stay at Hotel Lisboa Chiado.' }, { cat: 'payment_successful', amount: [12450, 'INR'], sugg: false, neg: true });
add('cz: platba proběhla úspěšně', { from: 'Rohlik.cz <info@rohlik.cz>', subject: 'Platba proběhla úspěšně', body: 'Děkujeme, platba 1 132,50 Kč proběhla úspěšně.' }, { cat: 'payment_successful', amount: [1132.5, 'CZK'], sugg: false, neg: true });

// ---- failed / pending
add('failed card payment', { from: 'Stripe <receipts@stripe.com>', subject: 'Payment failed — card declined · $12.00', body: 'Your payment failed. Card declined. Insufficient funds. Please update your card.' }, { cat: 'payment_failed', amount: [12, 'USD'], sugg: false, review: true, neg: true });
add('broker: funds not enough', { from: 'Trading 212 <noreply@trading212.com>', subject: 'Your card payment was not successful', body: 'The funds on your card are not enough or you might have a payment limit.' }, { cat: 'payment_failed', sugg: false, review: true, neg: true });
add('failed direct debit for invoice', { from: 'Netlify <billing@netlify.com>', subject: 'We couldn\'t collect payment for invoice 7781', body: 'Your direct debit for invoice 7781 could not be collected. Please pay €49.00 by 5 December 2026.' }, { cat: 'payment_failed', amount: [49, 'EUR'], sugg: false, review: true, neg: true });
add('pending bank transfer', { from: 'Wise <noreply@wise.com>', subject: 'Your transfer is being processed', body: 'Your transfer of €250.00 to John Smith is being processed. It should arrive by 5 November.' }, { cat: 'payment_pending', amount: [250, 'EUR'], sugg: false, neg: true });

// ---- incoming money
add('cz salary credited', { from: 'Air Bank <info@airbank.cz>', subject: 'Příchozí platba na váš účet', body: 'Na váš účet byla připsána příchozí platba 42 500 Kč. Zpráva pro příjemce: mzda 10/2026.' }, { cat: 'incoming_money', amount: [42500, 'CZK'], sugg: false, neg: true });
add('en salary received', { from: 'Monzo <help@monzo.com>', subject: 'You\'ve received £2,450.00', body: 'You\'ve received a payment of £2,450.00 from ACME LTD PAYROLL.' }, { cat: 'incoming_money', amount: [2450, 'GBP'], sugg: false, neg: true });
add('paypal money sent to you', { from: 'PayPal <service@paypal.cz>', subject: 'Jan Novák sent you €25.00', body: 'Jan Novák sent you €25.00. The money is in your PayPal balance.' }, { cat: 'incoming_money', amount: [25, 'EUR'], sugg: false, neg: true });
add('cz fio příchozí platba', { from: 'Fio banka <automat@fio.cz>', subject: 'Fio banka - příjem na kontě', body: 'Příchozí platba: 3 500,00 CZK. Protiúčet: 123456789/0800.' }, { cat: 'incoming_money', amount: [3500, 'CZK'], sugg: false, neg: true });

// ---- refunds
add('refund issued', { from: 'PayPal <service@paypal.com>', subject: 'Refund issued · €18.40', body: 'A refund of €18.40 was issued to your PayPal balance by Zalando.' }, { cat: 'refund_received', amount: [18.4, 'EUR'], sugg: false, neg: true });
add('refund pending within days', { from: 'Amazon <return@amazon.de>', subject: 'Your refund is being processed', body: 'Your refund of $42.10 is being processed. It should appear on your card within 3-5 business days. Order #112-3344556-7788990.' }, { cat: 'refund_pending', amount: [42.1, 'USD'], sugg: false, neg: true });
add('return received, refund processing', { from: 'Temu <noreply@temu.com>', subject: 'Return received — refund processing', body: 'We received your return. Your refund is in progress and will be credited to your original payment method.' }, { cat: 'refund_pending', sugg: false, neg: true });
add('cz: peníze vráceny', { from: 'Alza.cz <info@alza.cz>', subject: 'Vrácení peněz za objednávku 445566778', body: 'Částka 1 999 Kč byla vrácena na váš účet. Objednávka č. 445566778.' }, { cat: 'refund_received', amount: [1999, 'CZK'], sugg: false, neg: true });

// ---- subscriptions
add('renewal notice with date', { from: 'Netflix <info@account.netflix.com>', subject: 'Your membership renews soon', body: 'Your Netflix membership will renew on December 3, 2026 for €12.99.' }, { cat: 'subscription_renewal', amount: [12.99, 'EUR'], sugg: false, neg: true });
add('subscription renewed receipt', { from: 'Spotify <no-reply@spotify.com>', subject: 'Your Spotify Premium subscription has been renewed', body: 'Thanks for staying with Premium. Your subscription has been renewed. Receipt: €10.99 charged to your card.' }, { cat: 'subscription_renewal', amount: [10.99, 'EUR'], sugg: false, neg: true });
add('trial ends and will be charged', { from: 'Cursor <hi@cursor.com>', subject: 'Your free trial ends on 15 Nov 2026', body: 'Your Cursor Pro free trial ends on 15 Nov 2026. Your subscription will be charged $15.99 per month.' }, { cat: 'subscription_renewal', amount: [15.99, 'USD'], sugg: false, neg: true });
add('cz předplatné se obnoví', { from: 'Seznam <predplatne@seznam.cz>', subject: 'Vaše předplatné se brzy obnoví', body: 'Vaše předplatné Seznam Premium se automaticky obnoví 12. 11. 2026 za 99 Kč.' }, { cat: 'subscription_renewal', amount: [99, 'CZK'], sugg: false, neg: true });

// ---- statements and bank transactions
add('activity statement available', { from: 'Trading 212 <noreply@trading212.com>', subject: 'Account activity statement for 02.11.2026', body: 'Your latest activity statement is available in the app.' }, { cat: 'financial_statement', sugg: false, neg: true });
add('card transaction alert', { from: 'Air Bank <info@airbank.cz>', subject: 'Platba kartou', body: 'Transakce kartou končící 1234: 249,00 CZK, ALBERT PRAHA.' }, { cat: 'bank_transaction', amount: [249, 'CZK'], sugg: false, neg: true });
add('atm withdrawal', { from: 'ČSOB <info@csob.cz>', subject: 'Výběr z bankomatu', body: 'Výběr z bankomatu 2 000 Kč, karta **** 5678.' }, { cat: 'bank_transaction', amount: [2000, 'CZK'], sugg: false, neg: true });
add('transfer you sent', { from: 'Revolut <no-reply@revolut.com>', subject: 'You sent €50.00 to Petra', body: 'You sent €50.00 to Petra Nováková. Transfer completed.' }, { cat: 'outgoing_payment', amount: [50, 'EUR'], sugg: false, neg: true });

// ---- not financial / ambiguous
add('friend asks for money (personal)', { from: 'Tomáš <tomas@gmail.com>', subject: 'pizza', body: 'Hey, can you send me the 500 Kč for the pizza on Friday?', labels: ['INBOX', 'CATEGORY_PERSONAL'] }, { cat: 'not_financial', sugg: false, neg: true });
add('vague "regarding your payment"', { from: 'Support <support@unknownshop.example>', subject: 'Regarding your account', body: 'Please contact us regarding your account at your earliest convenience.' }, { cat: 'not_financial', sugg: false, neg: true });
add('github build notification', { from: 'GitHub <noreply@github.com>', subject: '[kratveer/Deshboard] Run passed', body: 'All checks have passed for commit 3038c14.' }, { cat: 'not_financial', sugg: false, neg: true });
add('scam-like urgent "pay now"', { from: 'Account Team <alerts@secure-verify.example>', subject: 'URGENT: account will be suspended', body: 'Your account will be suspended. Pay €2.99 now to keep access. Click here.' }, { cat: 'not_financial', sugg: false, neg: true });
add('subscription cancelled', { from: 'Netflix <info@account.netflix.com>', subject: 'Your membership has been cancelled', body: 'We\'re sorry to see you go. Your membership has been cancelled and will end on 30 November 2026.' }, { cat: 'not_financial', sugg: false, neg: true });

// ---- regressions from the real-mailbox review (synthetic look-alikes; no real content copied)
add('real-mail regression: work thread with "Order Settlement" subject', { from: 'Vera Novak <vera.novak@uni.cz>', subject: 'Re: Travel Order Settlement', body: 'Hi, please adjust the financial resources in the travel order and submit it again. The rest is up to the department.', labels: ['INBOX', 'CATEGORY_PERSONAL'] }, { cat: 'not_financial', sugg: false, neg: true });
add('real-mail regression: social invitation "You have 1 new invitation"', { from: 'LinkedIn <invitations@linkedin.com>', subject: 'You have 1 new invitation', body: 'See who reached out. You have received 1 new invitation to connect.' }, { cat: 'not_financial', sugg: false, neg: true });
add('real-mail regression: broker withdrawal being processed', { from: 'Trading 212 <noreply@trading212.com>', subject: 'Your withdrawal request has been received', body: 'We\'re processing your CZK 250.00 withdrawal. It usually arrives within 1-2 business days.' }, { cat: 'payment_pending', amount: [250, 'CZK'], sugg: false, neg: true });
add('real-mail regression: image-board marketing in Promotions (no offer)', { from: 'Pinterest <recommendations@inspire.pinterest.com>', subject: 'Premium HD wallpapers for you', body: 'Minimal phone wallpapers with deep colors. See more ideas. Unsubscribe.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'not_financial', sugg: false, neg: true });

// ============================================================ HOLD-OUT SET
// Hold-out #1: written after the rules were tuned on the set above. Its FIRST run (before any tuning on it) is saved in
// tests/finance-holdout1-blind-result.json (21/30, accuracy 0.733). Rules were then improved on its failures, so it is no longer blind.
const H = [];
const hadd = (name, m, exp) => H.push({ name, m: mail(m), exp });
hadd('h: utility e-invoice EN with due', { from: 'Innogy <e-faktura@innogy.cz>', subject: 'Your e-invoice for gas', body: 'Dear customer, your e-invoice for gas is attached. Invoice number 88120034. Total amount to pay CZK 2,310.00. Due date 2026-11-20.' }, { cat: 'unpaid_bill', amount: [2310, 'CZK'], due: '2026-11-20', sugg: true });
hadd('h: rent reminder from landlord', { from: 'Jana Svobodová <jana.svob@gmail.com>', subject: 'Nájem prosinec', body: 'Ahoj, připomínám nájem za prosinec 15 000 Kč, prosím uhradit do 5. 12. 2026. Díky!', labels: ['INBOX', 'CATEGORY_PERSONAL'] }, { cat: 'unpaid_bill', amount: [15000, 'CZK'], due: '2026-12-05', sugg: true });
hadd('h: amazon order shipped', { from: 'Amazon.de <versandbestaetigung@amazon.de>', subject: 'Your Amazon.de order has shipped', body: 'Your package with 2 items has shipped. Order #302-1234567-1234567. Order total: €42.10.' , labels: ['INBOX', 'CATEGORY_UPDATES'] }, { cat: 'purchase_receipt', sugg: false, neg: true });
hadd('h: google play receipt', { from: 'Google Play <googleplay-noreply@google.com>', subject: 'Your Google Play Order Receipt from Nov 2, 2026', body: 'Thank you. You\'ve made a purchase from Google Play. Order number: GPA.3371-1234-5678-90123. Total: CZK 129.00/month. Payment method: Visa-1234.' }, { cat: 'purchase_receipt', amount: [129, 'CZK'], sugg: false, neg: true });
hadd('h: paypal payment you sent to merchant', { from: 'PayPal <service@paypal.com>', subject: 'Receipt for your payment to AliExpress', body: 'You sent a payment of €23.47 EUR to AliExpress. Transaction ID: 9AB12345CD678901E.' }, { cat: 'outgoing_payment', amount: [23.47, 'EUR'], sugg: false, neg: true });
hadd('h: kb incoming transfer', { from: 'Komerční banka <info@kb.cz>', subject: 'Avízo: příchozí platba', body: 'Na Váš účet 123-456/0100 byla připsána částka 8 000,00 CZK od PETR NOVAK.' }, { cat: 'incoming_money', amount: [8000, 'CZK'], sugg: false, neg: true });
hadd('h: salary payslip available (no amount)', { from: 'HR Portal <payroll@company.com>', subject: 'Your payslip for October is available', body: 'Your payslip for October 2026 is now available in the HR portal.' }, { cat: 'incoming_money', sugg: false, neg: true });
hadd('h: microsoft 365 renews', { from: 'Microsoft <microsoft-noreply@microsoft.com>', subject: 'Your Microsoft 365 subscription will renew soon', body: 'Your Microsoft 365 Personal subscription will automatically renew on 21 November 2026. You will be charged €69.00.' }, { cat: 'subscription_renewal', amount: [69, 'EUR'], sugg: false, neg: true });
hadd('h: icloud storage payment failed', { from: 'Apple <no_reply@email.apple.com>', subject: 'Your iCloud+ payment could not be processed', body: 'We were unable to charge your payment method for iCloud+ 50 GB (€0.99). Update your payment information to keep your storage.' }, { cat: 'payment_failed', amount: [0.99, 'EUR'], sugg: false, neg: true });
hadd('h: black friday mega sale with prices', { from: 'Alza.cz <newsletter@alza.cz>', subject: 'Black Friday: iPhone za 19 990 Kč!', body: 'Black Friday je tady. Slevy až 50 %. iPhone za 19 990 Kč. Nakupujte nyní. Odhlásit odběr.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', sugg: false, neg: true });
hadd('h: loan offer pre-approved', { from: 'Home Credit <nabidky@homecredit.cz>', subject: 'Předschválená půjčka 200 000 Kč jen pro vás', body: 'Máme pro vás předschválenou půjčku až 200 000 Kč. Získejte peníze ještě dnes. Akce platí do 30. 11. 2026.', labels: ['INBOX'] }, { cat: 'promotional_offer', sugg: false, neg: true });
hadd('h: crypto exchange reward promo', { from: 'Binance <do-not-reply@post.binance.com>', subject: 'Claim your $100 trading bonus', body: 'Complete simple tasks and earn up to $100 in trading bonus. Limited time offer.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', sugg: false, neg: true });
hadd('h: insurance claim refund approved', { from: 'Allianz <claims@allianz.cz>', subject: 'Pojistné plnění schváleno', body: 'Vaše pojistné plnění bylo schváleno. Částku 3 200 Kč vám vrátíme na účet do 5 pracovních dnů.' }, { cat: 'refund_pending', amount: [3200, 'CZK'], sugg: false, neg: true });
hadd('h: tax refund received', { from: 'Finanční správa <podatelna@fs.mfcr.cz>', subject: 'Vrácení přeplatku na dani', body: 'Přeplatek na dani z příjmů ve výši 6 540 Kč byl vrácen na váš účet.' }, { cat: 'refund_received', amount: [6540, 'CZK'], sugg: false, neg: true });
hadd('h: invoice issued, already paid by card', { from: 'Notion <billing@mail.notion.so>', subject: 'Invoice #E4F2-0007', body: 'Invoice #E4F2-0007. Amount due $0.00. Amount paid $10.00 on November 1, 2026 with Visa ending 4242.' }, { cat: 'paid_invoice', sugg: false, neg: true });
hadd('h: phone bill with direct debit EN', { from: 'T-Mobile <vyuctovani@t-mobile.cz>', subject: 'Your monthly bill', body: 'Your bill for October is 742 Kč. The amount will be automatically debited from your account on 18 November 2026.' }, { cat: 'unpaid_bill', amount: [742, 'CZK'], sugg: false, neg: true });
hadd('h: parking fine with due date', { from: 'Městská policie <pokuty@mpp.cz>', subject: 'Výzva k zaplacení pokuty', body: 'Vyzýváme vás k zaplacení určené částky 500 Kč za parkování. Splatnost 20. 11. 2026, variabilní symbol 556677.' }, { cat: 'unpaid_bill', amount: [500, 'CZK'], due: '2026-11-20', sugg: true });
hadd('h: hotel booking confirmation pay at property', { from: 'Booking.com <noreply@booking.com>', subject: 'Your booking is confirmed', body: 'Booking confirmation 4455667788. Total price €210.00. You will pay the property during your stay.' }, { cat: 'not_financial', sugg: false, neg: true });
hadd('h: subscription price increase notice', { from: 'Netflix <info@account.netflix.com>', subject: 'An update to your Netflix membership price', body: 'Starting with your next billing date on 10 December 2026, your price will change to €15.99/month.' }, { cat: 'subscription_renewal', sugg: false, neg: true });
hadd('h: newsletter about personal finance', { from: 'Finance Weekly <newsletter@financeweekly.com>', subject: '5 ways to pay off your credit card faster', body: 'In this issue: how to pay your bills on time, avoid overdue fees and save €500 a year. Unsubscribe.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', sugg: false, neg: true });
hadd('h: colleague expense reimbursement', { from: 'Martin <martin@company.com>', subject: 'Re: conference expenses', body: 'I approved your reimbursement of €140, finance will transfer it next week.', labels: ['INBOX', 'CATEGORY_PERSONAL'] }, { cat: 'refund_pending', amount: [140, 'EUR'], sugg: false, neg: true });
hadd('h: monthly bank statement', { from: 'mBank <mbank@mbank.cz>', subject: 'Výpis z účtu za říjen 2026', body: 'Váš měsíční výpis z účtu je k dispozici v internetovém bankovnictví.' }, { cat: 'financial_statement', sugg: false, neg: true });
hadd('h: unpaid with only day and month', { from: 'PRE <faktury@pre.cz>', subject: 'Záloha na elektřinu', body: 'Záloha na elektřinu 1 500 Kč, splatnost 15. 12.' }, { cat: 'unpaid_bill', amount: [1500, 'CZK'], due: '2026-12-15', sugg: true });
hadd('h: order cancelled, refund will follow', { from: 'Mall.cz <info@mall.cz>', subject: 'Objednávka 99887766 byla stornována', body: 'Vaše objednávka č. 99887766 byla stornována. Peníze 2 499 Kč vám vrátíme do 5 dnů.' }, { cat: 'refund_pending', amount: [2499, 'CZK'], sugg: false, neg: true });
hadd('h: utility overpayment refund to you', { from: 'ČEZ Prodej <info@cez.cz>', subject: 'Vyúčtování – přeplatek', body: 'Vyúčtování za rok 2026: přeplatek 1 820 Kč vám vrátíme na účet do 30 dnů. Faktura č. 2026999111.' }, { cat: 'refund_pending', amount: [1820, 'CZK'], sugg: false, neg: true });
hadd('h: upwork payment received for your work', { from: 'Upwork <donotreply@upwork.com>', subject: 'You\'ve been paid', body: 'You got paid $480.00 for milestone 2 of "Website redesign". Funds will be available in 5 days.' }, { cat: 'incoming_money', amount: [480, 'USD'], sugg: false, neg: true });
hadd('h: "your invoice is ready" Stripe (unclear status)', { from: 'Hetzner <billing@hetzner.com>', subject: 'Your invoice R0012345678 is ready', body: 'Your invoice R0012345678 for €4.51 is ready. It will be charged to your credit card on file.' }, { cat: 'unpaid_bill', amount: [4.51, 'EUR'], sugg: false, neg: true });
hadd('h: event ticket purchase', { from: 'GoOut <noreply@goout.net>', subject: 'Vaše vstupenky – objednávka 7766', body: 'Děkujeme za nákup vstupenek. Objednávka č. 7766. Zaplaceno 790 Kč.' }, { cat: 'purchase_receipt', amount: [790, 'CZK'], sugg: false, neg: true });
hadd('h: survey mentions payment', { from: 'Revolut <no-reply@revolut.com>', subject: 'How was your payment experience?', body: 'Tell us how your recent payment went and get a chance to win €50.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', sugg: false, neg: true });
hadd('h: crowdfunding pledge charged', { from: 'Kickstarter <no-reply@kickstarter.com>', subject: 'Your pledge was successfully charged', body: 'Your pledge of $35.00 to "Pocket Synth" was successfully charged.' }, { cat: 'payment_successful', amount: [35, 'USD'], sugg: false, neg: true });

// ============================================================ run
const results = [];
for (const c of C) {
  const r = F.classify(c.m, { now: NOW });
  const ledger = F.buildLedger([r], { now: NOW });
  const rec = ledger.records[0] || null;
  const errors = [];
  if (r.category !== c.exp.cat) errors.push(`category ${r.category} ≠ ${c.exp.cat}`);
  if (c.exp.amount !== undefined) {
    const want = c.exp.amount;
    const got = r.amount ? [r.amount.value, r.amount.currency] : null;
    if (JSON.stringify(want) !== JSON.stringify(got)) errors.push(`amount ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  }
  if ('due' in c.exp && (r.dueDate || null) !== c.exp.due) errors.push(`due ${r.dueDate} ≠ ${c.exp.due}`);
  if (c.exp.inv && String(r.invoiceNumber || '') !== c.exp.inv) errors.push(`invoice# ${r.invoiceNumber} ≠ ${c.exp.inv}`);
  const sugg = !!rec?.suggestion;
  if (c.exp.sugg !== undefined && sugg !== c.exp.sugg) errors.push(`suggestion ${sugg} ≠ ${c.exp.sugg}`);
  if (c.exp.review && !(r.needsReview || rec?.bucket === 'review')) errors.push('should be flagged for review');
  results.push({ name: c.name, mailId: c.m.id, expected: c.exp.cat, got: r.category, ok: !errors.length, errors, confidence: r.confidence, needsReview: r.needsReview, bucket: rec?.bucket || null, obligation: rec?.obligation || null, suggestion: sugg, dueDate: r.dueDate, amount: r.amount, neg: !!c.exp.neg, conflicts: r.conflicts });
}

// ============================================================ HOLD-OUT #2 (blind: written after all tuning, run once, never tuned on)
const H2 = [];
const h2 = (name, m, exp) => H2.push({ name, m: mail(m), exp });
const footer = '\n\nYou are receiving this email because you have an account with us. To stop receiving these emails, unsubscribe here. © 2026 Company s.r.o., Praha. Privacy policy.';
h2('b: html invoice with table and due date', { from: 'Fakturoid <noreply@fakturoid.cz>', subject: 'Faktura 2026-0451 od Grafika Novák', html: true, body: '<table><tr><td>Faktura</td><td>2026-0451</td></tr><tr><td>Celkem k úhradě</td><td>12 100,00 Kč</td></tr><tr><td>Datum splatnosti</td><td>18. 11. 2026</td></tr></table>' + footer }, { cat: 'unpaid_bill', amount: [12100, 'CZK'], due: '2026-11-18', sugg: true });
h2('b: forwarded paid receipt', { from: 'Kratveer <kratveer050@gmail.com>', subject: 'Fwd: Your receipt from Grok xAI', body: '---------- Forwarded message ---------\nFrom: xAI <invoice@x.ai>\nReceipt from Grok xAI. Amount paid ₹1,700.00. Date paid October 26, 2026.' }, { cat: 'purchase_receipt', amount: [1700, 'INR'], sugg: false, neg: true });
h2('b: gym membership renewed', { from: 'Form Factory <info@formfactory.cz>', subject: 'Vaše členství bylo prodlouženo', body: 'Vaše členství bylo úspěšně obnoveno. Strženo 1 290 Kč z vaší karty.' + footer }, { cat: 'subscription_renewal', amount: [1290, 'CZK'], sugg: false, neg: true });
h2('b: deal email with fake invoice look', { from: 'Lékárna.cz <newsletter@lekarna.cz>', subject: '-25 % na kosmetiku | doprava zdarma', body: 'Akce týdne: -25 % na DUCRAY. Nakupte nad 499 Kč a máte dopravu zdarma. Platnost do 10. 11. 2026.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', sugg: false, neg: true });
h2('b: bank: payment sent from account', { from: 'Raiffeisenbank <info@rb.cz>', subject: 'Odchozí platba z účtu', body: 'Z vašeho účtu byla odeslána odchozí platba 3 250,00 CZK na účet 2400123456/2010.' }, { cat: 'outgoing_payment', amount: [3250, 'CZK'], sugg: false, neg: true });
h2('b: wise money arrived', { from: 'Wise <noreply@wise.com>', subject: 'Your money has arrived', body: 'Good news — €1,000.00 from Kratveer Singh has arrived in your EUR balance.' }, { cat: 'incoming_money', amount: [1000, 'EUR'], sugg: false, neg: true });
h2('b: unpaid invoice EN overdue no explicit date', { from: 'DigitalOcean <billing@digitalocean.com>', subject: 'Your invoice is overdue', body: 'Your account has an outstanding balance of $14.52. Please make a payment to avoid service interruption.' }, { cat: 'unpaid_bill', amount: [14.52, 'USD'], due: null, sugg: false, neg: true });
h2('b: refund to card completed', { from: 'Zalando <info@service-mail.zalando.cz>', subject: 'Vrácení peněz bylo dokončeno', body: 'Peníze ve výši 1 299 Kč jsme vám vrátili na kartu. Objednávka č. 10203040.' }, { cat: 'refund_received', amount: [1299, 'CZK'], sugg: false, neg: true });
h2('b: annual subscription renewal warning DE', { from: 'Spiegel <abo@spiegel.de>', subject: 'Ihr Abo verlängert sich bald', body: 'Ihr Digital-Abonnement verlängert sich am 01.12.2026 automatisch um ein Jahr zum Preis von 119,99 €.' }, { cat: 'subscription_renewal', amount: [119.99, 'EUR'], sugg: false, neg: true });
h2('b: student loan statement with due', { from: 'Student Finance <noreply@slc.co.uk>', subject: 'Your annual statement', body: 'Your annual statement is available. Your next repayment of £120.00 is due on 1 December 2026.' }, { cat: 'unpaid_bill', amount: [120, 'GBP'], due: '2026-12-01', sugg: true });
h2('b: marketplace payout pending', { from: 'Vinted <no-reply@vinted.cz>', subject: 'Platba za prodej se zpracovává', body: 'Kupující potvrdil převzetí. Platba 450 Kč se zpracovává a brzy ji uvidíte ve své Vinted peněžence.' }, { cat: 'payment_pending', amount: [450, 'CZK'], sugg: false, neg: true });
h2('b: airline booking paid', { from: 'Ryanair <noreply@ryanair.com>', subject: 'Your booking confirmation ABC123', body: 'Thank you for booking with Ryanair. Reservation ABC123. Total paid: €87.98. Payment method: Mastercard.' }, { cat: 'purchase_receipt', amount: [87.98, 'EUR'], sugg: false, neg: true });
h2('b: card declined at merchant', { from: 'Bolt <receipts@bolt.eu>', subject: 'Payment declined for your ride', body: 'We could not charge your card for your ride on 2 Nov. Amount 189 Kč. Please add a new payment method.' }, { cat: 'payment_failed', amount: [189, 'CZK'], sugg: false, neg: true });
h2('b: water bill with variable symbol and due', { from: 'PVK <zakaznik@pvk.cz>', subject: 'Faktura za vodné a stočné', body: 'Fakturovaná částka 2 145 Kč. Variabilní symbol 5512340. Splatnost faktury: 22.11.2026.' }, { cat: 'unpaid_bill', amount: [2145, 'CZK'], due: '2026-11-22', sugg: true });
h2('b: price alert newsletter (amount but not yours)', { from: 'Kiwi.com <news@kiwi.com>', subject: 'Prices to Delhi dropped to ₹28,400', body: 'Fares to Delhi just dropped. Book from ₹28,400 return. Deal ends soon.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, { cat: 'promotional_offer', sugg: false, neg: true });
h2('b: expense report approved (work)', { from: 'Expensify <concierge@expensify.com>', subject: 'Report approved', body: 'Your expense report "Prague trip" for €212.40 was approved and will be reimbursed in the next payroll.' }, { cat: 'refund_pending', amount: [212.4, 'EUR'], sugg: false, neg: true });
h2('b: securities trade confirmation', { from: 'Interactive Brokers <donotreply@interactivebrokers.com>', subject: 'Trade confirmation', body: 'Bought 10 VWCE @ €118.20. Total €1,182.00 debited.' }, { cat: 'bank_transaction', sugg: false, neg: true });
h2('b: zero-amount invoice for free plan', { from: 'Vercel <billing@vercel.com>', subject: 'Your invoice for November', body: 'Invoice #VC-2211. Hobby plan. Total: $0.00. Nothing to pay.' }, { cat: 'paid_invoice', sugg: false, neg: true });
h2('b: final notice debt collection', { from: 'Inkasní agentura <vymahani@inkaso-agentura.cz>', subject: 'Poslední upomínka před vymáháním', body: 'Dlužná částka 3 980 Kč dosud nebyla uhrazena. Uhraďte prosím do 12. 11. 2026, jinak předáme věc k vymáhání.' }, { cat: 'unpaid_bill', amount: [3980, 'CZK'], due: '2026-11-12', sugg: true });
h2('b: hello from landlord, no money', { from: 'Jana Svobodová <jana.svob@gmail.com>', subject: 'Klíče', body: 'Ahoj, klíče nechám u sousedky. Díky za včasnou platbu minulý měsíc!', labels: ['INBOX', 'CATEGORY_PERSONAL'] }, { cat: 'not_financial', sugg: false, neg: true });

// ---- hold-out evaluation (no tuning)
const holdout = H.map((c) => {
  const r = F.classify(c.m, { now: NOW }); const rec = F.buildLedger([r], { now: NOW }).records[0] || null; const errors = [];
  if (r.category !== c.exp.cat) errors.push(`category ${r.category} ≠ ${c.exp.cat}`);
  if (c.exp.amount !== undefined) { const got = r.amount ? [r.amount.value, r.amount.currency] : null; if (JSON.stringify(c.exp.amount) !== JSON.stringify(got)) errors.push(`amount ${JSON.stringify(got)} ≠ ${JSON.stringify(c.exp.amount)}`); }
  if ('due' in c.exp && (r.dueDate || null) !== c.exp.due) errors.push(`due ${r.dueDate} ≠ ${c.exp.due}`);
  const sugg = !!rec?.suggestion; if (sugg !== !!c.exp.sugg) errors.push(`suggestion ${sugg} ≠ ${!!c.exp.sugg}`);
  return { name: c.name, expected: c.exp.cat, got: r.category, ok: !errors.length, errors, neg: !!c.exp.neg, suggestion: sugg, obligation: rec?.obligation || null, bucket: rec?.bucket, dueDate: r.dueDate, confidence: r.confidence };
});
function metricsOf(rows) {
  const m = {}; F.CATEGORIES.forEach((a) => { m[a] = {}; F.CATEGORIES.forEach((b) => { m[a][b] = 0; }); });
  rows.forEach((r) => { m[r.expected][r.got]++; });
  const per = {};
  F.CATEGORIES.forEach((k) => { const tp = m[k][k], fp = F.CATEGORIES.reduce((a, e) => a + (e !== k ? m[e][k] : 0), 0), fn = F.CATEGORIES.reduce((a, g) => a + (g !== k ? m[k][g] : 0), 0); if (!(tp + fn) && !fp) return; const p = tp + fp ? tp / (tp + fp) : null, rc = tp + fn ? tp / (tp + fn) : null; per[k] = { support: tp + fn, tp, fp, fn, precision: p == null ? null : +p.toFixed(3), recall: rc == null ? null : +rc.toFixed(3), f1: p && rc ? +(2 * p * rc / (p + rc)).toFixed(3) : 0 }; });
  return { per, matrix: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([, n]) => n))]).filter(([, v]) => Object.keys(v).length)), accuracy: +(rows.filter((r) => r.expected === r.got).length / rows.length).toFixed(3) };
}
const holdoutMetrics = metricsOf(holdout);
const evalSet = (set) => set.map((c) => {
  const r = F.classify(c.m, { now: NOW }); const rec = F.buildLedger([r], { now: NOW }).records[0] || null; const errors = [];
  if (r.category !== c.exp.cat) errors.push(`category ${r.category} ≠ ${c.exp.cat}`);
  if (c.exp.amount !== undefined) { const got = r.amount ? [r.amount.value, r.amount.currency] : null; if (JSON.stringify(c.exp.amount) !== JSON.stringify(got)) errors.push(`amount ${JSON.stringify(got)} ≠ ${JSON.stringify(c.exp.amount)}`); }
  if ('due' in c.exp && (r.dueDate || null) !== c.exp.due) errors.push(`due ${r.dueDate} ≠ ${c.exp.due}`);
  const sugg = !!rec?.suggestion; if (sugg !== !!c.exp.sugg) errors.push(`suggestion ${sugg} ≠ ${!!c.exp.sugg}`);
  return { name: c.name, expected: c.exp.cat, got: r.category, ok: !errors.length, errors, neg: !!c.exp.neg, suggestion: sugg, obligation: rec?.obligation || null, bucket: rec?.bucket, dueDate: r.dueDate, confidence: r.confidence };
});
const holdout2 = evalSet(H2), holdout2Metrics = metricsOf(holdout2);
const holdout2Safety = { fabricatedSuggestionsInNegatives: holdout2.filter((r) => r.neg && (r.suggestion || r.obligation === 'outstanding')).map((r) => r.name), missedRealObligations: holdout2.filter((r) => !r.neg && !r.suggestion).map((r) => r.name) };
const holdoutSafety = { fabricatedSuggestionsInNegatives: holdout.filter((r) => r.neg && (r.suggestion || r.obligation === 'outstanding')).map((r) => r.name), missedRealObligations: holdout.filter((r) => !r.neg && !r.suggestion).map((r) => r.name) };

// ---- metrics
const cats = F.CATEGORIES;
const matrix = {}; cats.forEach((a) => { matrix[a] = {}; cats.forEach((b) => { matrix[a][b] = 0; }); });
results.forEach((r) => { matrix[r.expected][r.got]++; });
const perCat = {};
cats.forEach((k) => {
  const tp = matrix[k][k];
  const fp = cats.reduce((a, e) => a + (e !== k ? matrix[e][k] : 0), 0);
  const fn = cats.reduce((a, g) => a + (g !== k ? matrix[k][g] : 0), 0);
  const support = tp + fn;
  if (!support && !fp) return;
  const precision = tp + fp ? tp / (tp + fp) : null, recall = support ? tp / support : null;
  perCat[k] = { support, tp, fp, fn, precision: precision == null ? null : +precision.toFixed(3), recall: recall == null ? null : +recall.toFixed(3), f1: precision && recall ? +(2 * precision * recall / (precision + recall)).toFixed(3) : 0 };
});

// ---- sequences (ledger linking / dedupe / corrections)
const seqChecks = [];
const sc = (name, ok, detail) => seqChecks.push({ name, ok: !!ok, detail });
const cls = (m) => F.classify(m, { now: NOW });
const byName = (n) => C.find((c) => c.name === n).m;
{ // A: invoice then payment with same invoice number → one record, paid, confirmed link
  const L = F.buildLedger([cls(byName('cz: unpaid electricity invoice with due date')), cls(byName('cz: invoice paid confirmation'))], { now: NOW });
  const inv = L.records.filter((r) => r.merchantKey === 'cez');
  sc('A invoice + paid confirmation (same number) → one record', inv.length === 1, inv.map((r) => r.key));
  sc('A record is paid, not outstanding, no reminder', inv[0]?.status === 'paid' && inv[0]?.bucket === 'paid' && !inv[0]?.suggestion, inv[0] && { status: inv[0].status, bucket: inv[0].bucket });
}
{ // B: invoice without number then "thank you for your payment" same amount → probable link → review, not silently paid
  const a = mail({ from: 'PRE <faktury@pre.cz>', subject: 'Faktura za elektřinu', body: 'Faktura za elektřinu. Částka k úhradě 1 875 Kč, datum splatnosti 10. 11. 2026.', daysAgo: 12 });
  const b = mail({ from: 'PRE <faktury@pre.cz>', subject: 'Děkujeme za platbu', body: 'Děkujeme za vaši platbu 1 875 Kč.', daysAgo: 2 });
  const L = F.buildLedger([cls(a), cls(b)], { now: NOW });
  const inv = L.records.find((r) => r.mailIds.includes(a.id));
  sc('B amount+merchant match only → "possibly paid", needs review (not merged, not confirmed)', inv && inv.possiblyPaid && inv.bucket === 'review' && inv.status === 'unpaid' && L.records.length === 2, inv && { bucket: inv.bucket, status: inv.status, link: inv.linkedPaid });
}
{ // C: two monthly invoices with the same amount + one payment without number → ambiguous → no link
  const a = mail({ from: 'Vodafone <billing@vodafone.cz>', subject: 'Faktura č. 9001', body: 'Faktura č. 9001. Částka k úhradě 499 Kč, splatnost 5. 10. 2026.', daysAgo: 40 });
  const b = mail({ from: 'Vodafone <billing@vodafone.cz>', subject: 'Faktura č. 9002', body: 'Faktura č. 9002. Částka k úhradě 499 Kč, splatnost 5. 11. 2026.', daysAgo: 10 });
  const p = mail({ from: 'Vodafone <billing@vodafone.cz>', subject: 'Platba přijata', body: 'Děkujeme, vaše platba 499 Kč byla přijata.', daysAgo: 1 });
  const L = F.buildLedger([cls(a), cls(b), cls(p)], { now: NOW });
  const links = L.records.filter((r) => r.linkedPaid);
  sc('C same amount, two candidate invoices → no automatic link', links.length <= 1 && L.records.filter((r) => r.category === 'paid_invoice').length === 0, L.records.map((r) => [r.key, r.status, r.linkedPaid?.strength]));
}
{ // D: invoice + reminder for the same invoice → one record (duplicate notice), still one reminder suggestion
  const L = F.buildLedger([cls(byName('cz: unpaid electricity invoice with due date')), cls(mail({ from: 'ČEZ Prodej <info@cez.cz>', subject: 'Upomínka: faktura č. 2026104455', body: 'Upomínka: faktura č. 2026104455 na částku 1 240 Kč je po splatnosti. Datum splatnosti bylo 25. 11. 2026.', daysAgo: 0 }))], { now: NOW });
  const recs = L.records.filter((r) => r.merchantKey === 'cez');
  sc('D duplicate invoice notices → one record', recs.length === 1 && recs[0].mailIds.length === 2, recs.map((r) => r.key));
  sc('D at most one reminder suggestion', L.records.filter((r) => r.suggestion).length === 1);
}
{ // E: repeated syncs with persisted prior → no duplicates
  const all = C.map((c) => cls(c.m));
  const L1 = F.buildLedger(all, { now: NOW });
  const prior = L1.records.map(F.compact);
  const L2 = F.buildLedger(all, { now: NOW, prior });
  const L3 = F.buildLedger(all.slice(0, 20), { now: NOW, prior: L2.records.map(F.compact) }); // older mails left the fetch window
  const keys = (L) => L.records.map((r) => r.key);
  sc('E repeated sync → identical record set', JSON.stringify(keys(L1).sort()) === JSON.stringify(keys(L2).sort()));
  sc('E records outside the window are kept from history, not duplicated', new Set(keys(L3)).size === keys(L3).length && keys(L3).length === keys(L1).length, [keys(L1).length, keys(L3).length]);
}
{ // F: refund ↔ original purchase by order id
  const buy = mail({ from: 'Alza.cz <info@alza.cz>', subject: 'Potvrzení objednávky 445566778', body: 'Děkujeme za nákup. Objednávka č. 445566778. Celkem 1 999 Kč. Platba proběhla úspěšně.', daysAgo: 20 });
  const L = F.buildLedger([cls(buy), cls(byName('cz: peníze vráceny'))], { now: NOW });
  const rf = L.records.find((r) => r.category === 'refund_received');
  sc('F refund linked to original purchase (order number)', rf && rf.links.some((l) => l.kind === 'refund_of' && l.strength === 'confirmed'), rf && rf.links);
  sc('F refund is incoming, never owed', rf && rf.direction === 'incoming' && rf.bucket === 'refunded' && !rf.obligation);
}
{ // G: subscription renewal notice + renewed receipt → one subscription record
  const a = mail({ from: 'Spotify <no-reply@spotify.com>', subject: 'Your Premium renews soon', body: 'Your Spotify Premium subscription will renew on 1 December 2026 for €10.99.', daysAgo: 30 });
  const L = F.buildLedger([cls(a), cls(byName('subscription renewed receipt'))], { now: NOW });
  const subs = L.records.filter((r) => r.category === 'subscription_renewal');
  sc('G subscription notices grouped into one record', subs.length === 1 && subs[0].mailIds.length === 2, subs.map((s) => s.key));
}
{ // H: user corrections and dismissals win
  const r = cls(byName('bill without any due date'));
  const L = F.buildLedger([r], { now: NOW, corrections: { [r.mailId]: { category: 'paid_invoice' } } });
  sc('H correction to "paid invoice" applied', L.records[0].category === 'paid_invoice' && L.records[0].bucket === 'paid' && L.records[0].corrected);
  const r2 = cls(byName('cz: unpaid electricity invoice with due date'));
  const L2 = F.buildLedger([r2], { now: NOW, corrections: { [r2.mailId]: { dismissed: true } } });
  sc('H dismissed record shows no suggestion', L2.records[0].bucket === 'dismissed' && !L2.records[0].suggestion);
}

// ---- acceptance
const negatives = results.filter((r) => r.neg);
const acc = {
  zeroFabricatedTasksInNegativeSet: negatives.filter((r) => r.suggestion || r.obligation === 'outstanding').map((r) => r.name),
  receiptsOrPaidAsOutstanding: results.filter((r) => ['purchase_receipt', 'paid_invoice', 'payment_successful'].includes(r.expected) && ['outstanding', 'upcoming'].includes(r.obligation)).map((r) => r.name),
  refundsAsOwed: results.filter((r) => /refund/.test(r.expected) && (r.obligation || r.suggestion)).map((r) => r.name),
  inventedDueDates: results.filter((r) => { const c = C.find((x) => x.name === r.name); return 'due' in c.exp ? (c.exp.due === null && r.dueDate) : (r.dueDate && !/due|splatn|fällig|úhrad|pay/i.test(JSON.stringify(c.m))); }).map((r) => r.name),
  ambiguousFlagged: results.filter((r) => C.find((x) => x.name === r.name).exp.review && !r.needsReview && r.bucket !== 'review').map((r) => r.name)
};
const singlePass = results.filter((r) => r.ok).length;
const accOk = Object.values(acc).every((v) => !v.length);
const seqOk = seqChecks.every((s) => s.ok);
const macro = Object.values(perCat).filter((p) => p.support);
const report = {
  generatedAt: new Date().toISOString(), cases: results.length, negativeCases: negatives.length, sequences: seqChecks.length,
  singleCasePass: singlePass, categoryAccuracy: +(results.filter((r) => r.expected === r.got).length / results.length).toFixed(3),
  macroF1: +(macro.reduce((a, p) => a + p.f1, 0) / macro.length).toFixed(3),
  perCategory: perCat, confusionMatrix: Object.fromEntries(Object.entries(matrix).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([, n]) => n))]).filter(([, v]) => Object.keys(v).length)),
  acceptance: acc, acceptanceOk: accOk,
  holdout2_blind: { cases: holdout2.length, fullyCorrect: holdout2.filter((r) => r.ok).length, accuracy: holdout2Metrics.accuracy, perCategory: holdout2Metrics.per, confusionMatrix: holdout2Metrics.matrix, safety: holdout2Safety, failures: holdout2.filter((r) => !r.ok) },
  holdout: { cases: holdout.length, fullyCorrect: holdout.filter((r) => r.ok).length, accuracy: holdoutMetrics.accuracy, perCategory: holdoutMetrics.per, confusionMatrix: holdoutMetrics.matrix, safety: holdoutSafety, failures: holdout.filter((r) => !r.ok) }, sequenceChecks: seqChecks, failures: results.filter((r) => !r.ok), results,
  note: 'Hand-written synthetic fixtures written by the developer of the rules; real-mail accuracy is measured separately and will be lower.'
};
fs.writeFileSync(path.join(__dirname, 'finance-intel-report.json'), JSON.stringify(report, null, 2));
console.log(`Finance suite: ${singlePass}/${results.length} cases fully correct · category accuracy ${report.categoryAccuracy} · macro-F1 ${report.macroF1}`);
console.log(`Sequences: ${seqChecks.filter((s) => s.ok).length}/${seqChecks.length} · acceptance ${accOk ? 'PASS' : 'FAIL'}`);
results.filter((r) => !r.ok).forEach((r) => console.log('  ✗', r.name, '—', r.errors.join('; ')));
console.log(`Hold-out #1 (seen; blind first run 21/30, accuracy 0.733): ${holdout.filter((r) => r.ok).length}/${holdout.length} fully correct · category accuracy ${holdoutMetrics.accuracy} · fabricated suggestions in negatives: ${holdoutSafety.fabricatedSuggestionsInNegatives.length} · missed real obligations: ${holdoutSafety.missedRealObligations.length}`);
holdout.filter((r) => !r.ok).forEach((r) => console.log('  ◦ holdout', r.name, '—', r.errors.join('; ')));
console.log(`Hold-out #2 (seen; blind first run 11/20, accuracy 0.55 — see finance-holdout2-blind-result.json): ${holdout2.filter((r) => r.ok).length}/${holdout2.length} fully correct · category accuracy ${holdout2Metrics.accuracy} · fabricated suggestions in negatives: ${holdout2Safety.fabricatedSuggestionsInNegatives.length} · missed real obligations: ${holdout2Safety.missedRealObligations.length}`);
holdout2.filter((r) => !r.ok).forEach((r) => console.log('  ◦ blind', r.name, '—', r.errors.join('; ')));
seqChecks.filter((s) => !s.ok).forEach((s) => console.log('  ✗ seq', s.name, JSON.stringify(s.detail || '').slice(0, 300)));
Object.entries(acc).forEach(([k, v]) => { if (v.length) console.log('  ✗ acceptance', k, v); });
if (!(accOk && seqOk)) process.exitCode = 1;
module.exports = { C, H, H2, NOW };
