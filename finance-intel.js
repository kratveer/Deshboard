// Daylight financial intelligence (Phase 2).
// Turns emails into financial records conservatively:
//  - classifies each email into one financial category (or not_financial) from explicit evidence only;
//  - extracts amount, currency, direction, status, invoice/reference numbers and dates that are actually written;
//  - links invoices ↔ payments, purchases ↔ refunds, subscriptions ↔ renewals by stable identifiers;
//  - decides whether a record is a real obligation (Outstanding / Upcoming) or only information;
//  - never invents amounts, dates or statuses: unknown stays null and lowers confidence.
// Pure module: no DOM, no network, no storage (the app persists corrections and the compact ledger).
(function (root) {
  'use strict';

  const VERSION = 1;
  const CATEGORIES = Object.freeze([
    'unpaid_bill', 'paid_invoice', 'payment_pending', 'payment_successful', 'payment_failed',
    'refund_received', 'refund_pending', 'incoming_money', 'outgoing_payment', 'subscription_renewal',
    'purchase_receipt', 'promotional_offer', 'bank_transaction', 'financial_statement', 'not_financial'
  ]);
  const LABELS = Object.freeze({
    unpaid_bill: 'Unpaid bill', paid_invoice: 'Paid invoice', payment_pending: 'Payment pending',
    payment_successful: 'Payment successful', payment_failed: 'Payment failed', refund_received: 'Refund received',
    refund_pending: 'Refund pending', incoming_money: 'Money received', outgoing_payment: 'Payment sent',
    subscription_renewal: 'Subscription renewal', purchase_receipt: 'Purchase receipt', promotional_offer: 'Promotion',
    bank_transaction: 'Bank transaction', financial_statement: 'Statement', not_financial: 'Not financial'
  });
  const DIRECTION = Object.freeze({
    unpaid_bill: 'outgoing', paid_invoice: 'outgoing', payment_pending: 'outgoing', payment_successful: 'outgoing',
    payment_failed: 'outgoing', refund_received: 'incoming', refund_pending: 'incoming', incoming_money: 'incoming',
    outgoing_payment: 'outgoing', subscription_renewal: 'outgoing', purchase_receipt: 'outgoing',
    promotional_offer: null, bank_transaction: null, financial_statement: null, not_financial: null
  });
  const DAY = 86400000;

  // ---------- Unicode-aware regex helper: \b in the source becomes a letter/number boundary (works for č, ř, ü …)
  const UB = '(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))';
  const rx = (src, flags) => new RegExp(src.replace(/\\b/g, UB).replace(/\\w/g, '[\\p{L}\\p{N}_]'), (flags || 'i') + 'u');

  const R = {
    promoPhrase: rx('\\b(\\d{1,3}\\s?% off|sale|discount|deal|deals|offer|offers|coupon|promo ?code|voucher code|save up to|up to \\d{1,3}\\s?%|earn (up to |yourself )?(some )?(extra )?(cash|[€$£₹]|czk|\\d)|invite (your )?friends|refer a friend|referral|cashback|bonus|giveaway|win |chance to win|limited[- ]time|(offer|sale|deal|discount|promotion|promo|price) ends|ends (today|tonight)|last chance|shop now|buy now|order now|exclusive|newsletter|webinar|free trial(?! (ends|ending|expires|converts))|special price|black friday|cyber monday|sleva|slevy|slevu|akce|akční|výprodej|nabídka|nabídky|ušetř\\w*|získej\\w*|vyhraj\\w*|dárek|zdarma|Rabatt|Angebot|Gutschein|Sonderangebot|now ₹|now €|now \\$)\\b'),
    promoSender: rx('(^|[^a-z])(news|newsletter|marketing|offers?|deals|promo|promotions|hello|info|team|updates)@'),
    unsubscribe: rx('unsubscribe|odhlásit|odhlášení|abbestellen|manage (your )?(email )?preferences'),
    disclaimerPaid: rx('(if|in case) you( have)? already (paid|made (the|this) payment)[^.]*|pokud jste (již|už) (zaplatil\\w*|uhradil\\w*)[^.]*|falls sie bereits (bezahlt|überwiesen)[^.]*|please disregard (this|if)[^.]*'),
    refundPolicy: rx('refund policy|non-?refundable|no refunds|money-back guarantee|30-day refund|vrácení zboží do'),
    refund: rx('\\b(refund|refunds|refunded|refunding|reimburse|reimbursed|reimbursement|přeplat\\w*|vrácen\\w*|money back|vrácení (peněz|platby|částky)|vrátíme|vrátili|vratk\\w+|refundac\\w+|dobropis|Rückerstattung|erstattet|Erstattung|Gutschrift für (Ihre )?Rücksendung)\\b'),
    refundDone: rx('(refund(ed)? (of .{0,25} )?(has been |was |is )?(issued|completed|processed|sent|credited|approved)|we( have|\'ve) (issued|processed|sent) (a |your )?refund|(has|have) been refunded|was refunded|refunded to (your|the)|vrátili jsme|(jsme )?(vám )?vrátili|vrácení (peněz )?(bylo )?dokončeno|refund (is |was )?complete|byl[ao]? vrácen\\w*|byla připsána|erstattet wurde|wurde erstattet|wurde zurückerstattet)'),
    refundPending: rx('((refund|reimbursement) (is |will be )?(being )?(processed|processing|initiated|requested|pending|on its way|underway|in progress)|(refund|reimbursement)s? (was |has been )?approved|approved (your |the )?(refund|reimbursement)|(will|to) (transfer|pay) it|will (be )?(refund|refunded|reimbursed|credited|receive (a|your) refund)|refund (should|will) (appear|arrive|be)|within \\d+(-\\d+)? (business |working )?days|zpracováváme|bude vrácen\\w*|vrátíme|wird erstattet|in bearbeitung)'),
    failed: rx('(payment (has )?(failed|declined|was declined|unsuccessful|was unsuccessful|was not successful|could not be (processed|completed))|card (was |has been )?declined|insufficient funds|(funds|balance) (on your (card|account) )?(are|is) (not enough|insufficient)|(could not|couldn\'t|were unable to|unable to) (process|charge|collect) (your )?(payment|card)|failed payment|payment problem|update your (payment|card|billing) (method|details|information)|platba (se )?nezdařila|platba byla zamítnuta|neúspěšná platba|nedostatek prostředků|Zahlung (fehlgeschlagen|abgelehnt))'),
    pending: rx('(payment (is |was )?(pending|processing|being processed|on hold|scheduled|initiated|awaiting)|(we(\'re| are) )?processing your .{0,30}(withdrawal|payout|transfer|payment)|withdrawal request (has been )?received|(transfer|payment) (is )?(in progress|pending|initiated|scheduled|being processed)|awaiting (payment|clearance|confirmation)|will be (processed|debited|collected|charged) on|čeká na (zpracování|připsání)|platba se zpracovává|platba[^.]{0,25}se zpracovává|zpracovává se|probíhá zpracování|zahlung (ist )?ausstehend|wird bearbeitet)'),
    success: rx('(payment (received|successful|succeeded|confirmed|complete|completed|processed)|we( have|\'ve) received your payment|thank(s| you) for your payment|your payment (of .{0,25})?(was|has been) (received|processed|successful|completed|confirmed)|successfully (paid|charged|processed)|you paid|you\'ve paid|total paid|you have paid|amount paid|paid with|(?<!will be )charged (to|on) your|was charged|has been charged|platba (proběhla|byla přijata|přijata|byla úspěšná|úspěšně)|děkujeme za (vaši |Vaši )?(platbu|úhradu)|přijali jsme (vaši |Vaši )?platbu|uhrazeno|Zahlung (erhalten|eingegangen|erfolgreich)|vielen dank für ihre zahlung)'),
    invoiceCtx: rx('\\b(invoice|invoices|bill|bills|fee|fees|tuition|tuition fees|rent|školné|školného|poplatek|poplatky|nájem|nájemné|pojistné|pokut\\w*|dluh\\w*|dlužn\\w*|pohledávk\\w*|\\bdebt\\b|\\bfine\\b|penalty|záloh\\w*|billing statement|utility bill|electricity bill|phone bill|faktura|faktury|fakturu|vyúčtování|předpis plateb|složenk\\w+|Rechnung|Rechnungen|Abrechnung)\\b'),
    paidInvoice: rx('(invoice|bill|faktura|vyúčtování|rechnung)[^.]{0,60}(\\bpaid\\b|has been paid|was paid|is paid|settled|zaplacen\\w*|uhrazen\\w*|bezahlt|beglichen)|(\\bpaid\\b|zaplaceno|uhrazeno|bezahlt)[^.]{0,30}(invoice|bill|faktur\\w*|rechnung)|paid in full|balance(:| is)? (0|0\\.00|zero|€0|\\$0)|amount due:? ?(\\$|€|£)?0([.,]00)?(?!\\d)(?![.,]\\d)|nothing (to pay|is due)|no payment (is )?(required|needed|due)|status: ?paid|stav: ?(zaplaceno|uhrazeno)'),
    directDebit: rx('(will be (automatically )?(debited|collected|charged|taken) (from|on|by|to)|direct debit|sepa (direct debit|lastschrift)|inkaso|bude stržen\\w*|strhneme|wird (per lastschrift )?abgebucht|auto-?pay (is )?(on|enabled))'),
    unpaidCtx: rx('(amount due|balance due|total due|payment due|due date|due by|due on|is due|pay by|payable (by|until|before)|please pay|please make (the |your )?payment|awaiting your payment|k úhradě|k zaplacení|částka k úhradě|datum splatnosti|splatnost|splatné do|splatná do|uhraďte|zaplaťte|zaplať|uhradit|zaplatit|k zaplacení|výzva k (zaplacení|úhradě)|připomín\\w* (platb\\w*|úhrad\\w*|nájem|fakturu)|prosíme o (úhradu|zaplacení)|fällig|zahlbar bis|zahlungsfrist|bitte überweisen|outstanding (balance|amount|invoice)|unpaid|overdue|past due|reminder|payment reminder|upomínka|mahnung|zahlungserinnerung)'),
    receipt: rx('\\b(receipt|your receipt|order confirmation|order confirmed|order #|order number|thank(s| you) for (your )?(order|purchase|shopping|booking)|you bought|purchase confirmation|purchase of|tax invoice for (your )?order|účtenka|účtenku|daňový doklad|doklad o (koupi|zaplacení)|potvrzení objednávky|vaše objednávka|děkujeme za (váš |Váš )?nákup|Quittung|Kaufbeleg|Bestellbestätigung|Ihre Bestellung)\\b'),
    subscription: rx('\\b(subscription|subscriptions|membership|your plan|premium plan|pro plan|plus plan|předplatné|předplatného|členství|tarif\\w*|Abonnement|Abo|Mitgliedschaft)\\b'),
    renewFuture: rx('(will (auto(matically)?[- ])?renew|renews (on|automatically|soon)|renewal (date|notice|reminder)|is (due )?for renewal|next (billing|payment|charge) (date|on|is)|will be (charged|billed|renewed)|auto-?renew(al)? (is )?(on|enabled)|auto-?renews?|upcoming (renewal|charge|payment)|trial (ends|ending|expires|will end|converts)|se (automaticky )?obnoví|bude obnoven\\w*|příští platba|wird (automatisch )?verlängert|verlängert sich|nächste (zahlung|abbuchung))'),
    renewDone: rx('(has been renewed|was renewed|renewed successfully|successfully renewed|renewal (was )?(successful|complete|confirmed)|thanks for (renewing|staying|starting)|your (subscription|membership|plan) (is |has been )?(active|renewed|confirmed|started)|you\'re in|welcome to|bylo obnoveno|úspěšně obnoven\\w*|wurde verlängert)'),
    subCancel: rx('(subscription|membership|plan|předplatné)[^.]{0,30}(cancel+ed|ended|expired|terminated|zrušen\\w*|ukončen\\w*|gekündigt)'),
    incoming: rx('(\\bsalary\\b|\\bpayroll\\b|\\bwages?\\b|\\bpayslip\\b|mzda|mzdy|výplat\\w*|Gehalt|Lohn|you( have|\'ve)? received (a payment|money|[€$£₹]\\s?\\d|(czk|kč|eur|usd|gbp|inr)\\s?\\d|\\d[\\d\\s.,]*\\s?(czk|kč|eur|usd|gbp|€|\\$|£))|money (has been )?(received|arrived)|incoming (payment|transfer|wire)|(has been |was )?credited to (your|the) (account|card|balance|wallet)|sent you (a payment|money|[€$£₹]\\s?\\d|\\d[\\d\\s.,]*\\s?(czk|kč|eur|usd|€|\\$))|you got paid|(has )?arrived in your (\\w+ )?(balance|account)|money has arrived|payout (is on its way|has been sent|sent|completed|processed)|příchozí platb\\w*|přišla (vám )?platba|připsán\\w* na (váš |Váš )?účet|na váš účet (byla|bylo) připsán\\w*|Zahlungseingang|Geldeingang|gutgeschrieben|deposit (received|completed|has been made))'),
    outgoing: rx('(you sent|money sent|transfer (sent|completed|executed|was sent)|payment sent to|your transfer (to|of)|odchozí platb\\w*|odeslaná platba|převod (byl )?(odeslán|proveden)|(has been|was) debited from (your|the) account|Überweisung (ausgeführt|gesendet|wurde ausgeführt)|Lastschrift eingelöst)'),
    cardTxn: rx('(card transaction|trade confirmation|order (was )?executed|(bought|sold) \\d+ |withdrawal (of|from|completed)|výběr z bankomatu|výběr hotovosti|ATM withdrawal|cash withdrawal|transaction alert|transaction notification|you spent .{0,30} at|purchase at|spent at|card (ending|ending in|\\*+)\\s?\\d{4} (was|has been) used|transakce kartou|platba kartou|transakce na (vaší|Vaší) kart\\w*|kartou (končící|\\*+)|Kartenzahlung|Kartenumsatz)'),
    statement: rx('\\b(statement (is )?(now )?(ready|available)|monthly statement|account statement|activity statement|annual statement|e-?statement|your statement|card statement|výpis z účtu|měsíční výpis|výpis je k dispozici|Kontoauszug|Abrechnung ist verfügbar)\\b'),
    bankSender: rx('(bank|banka|banking|revolut|wise|n26|fio|airbank|air bank|csob|čsob|moneta|raiffeisen|kb\\.cz|komercni|komerční|unicredit|equa|mbank|paypal|trading ?212|interactive brokers|sbi|hdfc|icici|chase|barclays|hsbc|monzo|starling|sparkasse|commerzbank|deutsche bank)'),
    orderRef: rx('(order|objednávk\\w+|Bestellung)\\s*(?:no\\.?|number|num|id|#|č\\.?|číslo|nr\\.?)?\\s*[:#]?\\s*((?=[A-Z0-9\\-]*\\d)[A-Z0-9][A-Z0-9\\-]{4,})'),
    invoiceNo: rx('(invoice|faktur\\w*|rechnung|bill|vyúčtování|dobropis|credit note)\\s*(?:no\\.?|number|num|id|#|č\\.?|číslo|nr\\.?)?\\s*[:#]?\\s*((?=[A-Z0-9\\-\\/]*\\d)[A-Z0-9][A-Z0-9\\-\\/]{2,})'),
    txnRef: rx('(transaction|reference|ref\\.?|payment id|receipt|variabilní symbol|VS|Verwendungszweck|Referenz)\\s*(?:id|no\\.?|number|#|č\\.?)?\\s*[:#]\\s*((?=[A-Z0-9\\-]*\\d)[A-Z0-9][A-Z0-9\\-]{4,})')
  };

  // ---------- text helpers
  function b64urlDecode(data) {
    try {
      const s = String(data).replace(/-/g, '+').replace(/_/g, '/');
      if (typeof atob === 'function') {
        const bin = atob(s);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8').decode(bytes) : bin;
      }
      return Buffer.from(s, 'base64').toString('utf8'); // Node tests
    } catch { return ''; }
  }
  function htmlToText(h) {
    return String(h || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }
  function bodyText(payload) {
    if (!payload) return '';
    let plain = '', html = '';
    const walk = (p) => {
      if (!p) return;
      if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = b64urlDecode(p.body.data);
      else if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64urlDecode(p.body.data);
      (p.parts || []).forEach(walk);
    };
    walk(payload);
    if (!plain && !html && payload.body?.data) plain = b64urlDecode(payload.body.data);
    return (plain || htmlToText(html)).slice(0, 6000);
  }
  const header = (h, n) => (h || []).find((x) => String(x.name).toLowerCase() === n.toLowerCase())?.value || '';
  function parseFrom(v) {
    const s = String(v || '');
    const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
    if (m) return { name: m[1].trim() || m[2].split('@')[0], email: m[2].trim().toLowerCase() };
    const e = s.match(/[^\s<>]+@[^\s<>]+/);
    return { name: e ? e[0].split('@')[0] : s.trim(), email: e ? e[0].toLowerCase() : '' };
  }
  const decodeEntities = (s) => String(s || '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

  function normalizeMail(raw) {
    if (!raw) return null;
    if (raw._finNormalized) return raw;
    const h = raw.payload?.headers || raw.headers || [];
    const from = parseFrom(header(h, 'From') || raw.from || '');
    const subject = decodeEntities(header(h, 'Subject') || raw.subject || '');
    const dateRaw = header(h, 'Date');
    let whenMs = raw.internalDate != null && /^\d+$/.test(String(raw.internalDate)) ? Number(raw.internalDate) : NaN;
    if (!isFinite(whenMs) && dateRaw) whenMs = new Date(dateRaw).getTime();
    if (!isFinite(whenMs) && raw.whenMs) whenMs = raw.whenMs;
    const body = raw.payload ? bodyText(raw.payload) : String(raw.body || '');
    const attachments = [];
    const walk = (p) => { if (!p) return; if (p.filename) attachments.push(p.filename); (p.parts || []).forEach(walk); };
    walk(raw.payload);
    return {
      _finNormalized: true,
      id: raw.id || raw.mailId, threadId: raw.threadId || raw.id,
      labels: raw.labelIds || raw.labels || [],
      fromName: decodeEntities(from.name), fromEmail: from.email,
      subject, snippet: decodeEntities(raw.snippet || ''), body: decodeEntities(body),
      attachments, whenMs: isFinite(whenMs) ? whenMs : null,
      bodyAvailable: !!(raw.payload && (raw.payload.parts || raw.payload.body?.data)) || !!raw.body,
      bodyDeferred: !!raw._bodyDeferred
    };
  }

  // ---------- amounts
  const CUR = [
    ['EUR', /€|\bEUR\b|\beur\b|euro/], ['CZK', /Kč|\bCZK\b|\bczk\b|korun/], ['USD', /US\$|\$|\bUSD\b/], ['GBP', /£|\bGBP\b/],
    ['INR', /₹|\bINR\b|\bRs\.?/], ['PLN', /zł|\bPLN\b/], ['CHF', /\bCHF\b/], ['HUF', /\bHUF\b|\bFt\b/]
  ];
  const SYM = '(?:€|EUR|eur|Kč|CZK|czk|US\\$|\\$|USD|£|GBP|₹|INR|Rs\\.?|zł|PLN|CHF|HUF|Ft)';
  const NUM = '(\\d{1,3}(?:[ \\u00a0.,\']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  const AMT_RE = new RegExp(`(${SYM})\\s?${NUM}(?![\\d])|${NUM}\\s?(${SYM})(?![A-Za-z])|${NUM}\\s?,-\\s?(Kč)?`, 'g');
  function parseNumber(s) {
    let t = String(s).replace(/[\s\u00a0']/g, '');
    const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, '');
    } else if (lastComma > -1) {
      const dec = t.length - lastComma - 1;
      t = dec === 3 && (t.match(/,/g) || []).length >= 1 ? t.replace(/,/g, '') : t.replace(',', '.');
    } else if (lastDot > -1) {
      const dec = t.length - lastDot - 1;
      if (dec === 3 && (t.match(/\./g) || []).length >= 1) t = t.replace(/\./g, '');
    }
    const v = Number(t);
    return isFinite(v) ? v : null;
  }
  function currencyOf(tok) {
    for (const [code, re] of CUR) if (re.test(tok)) return code;
    return null;
  }
  function findAmounts(text) {
    const out = [];
    let m; AMT_RE.lastIndex = 0;
    while ((m = AMT_RE.exec(text))) {
      const sym = m[1] || m[4] || (m[5] != null ? (m[6] || 'Kč') : null);
      const num = m[2] || m[3] || m[5];
      const value = parseNumber(num);
      const currency = currencyOf(sym || '');
      if (value == null || !currency || value <= 0 || value > 1e9) continue;
      out.push({ value, currency, raw: m[0].trim(), index: m.index });
    }
    return out;
  }
  const ROLE_RE = {
    due: rx('(amount due|balance due|total due|to pay|k úhradě|k zaplacení|částka|zu zahlen|offener betrag|minimum payment|outstanding|total|celkem|summe|betrag)'),
    refund: rx('(refund(ed)?|reimburse\\w*|vrácen\\w*|vrátíme|erstatt\\w*|dobropis)'),
    paid: rx('(paid|charged|payment of|amount paid|total paid|zaplaceno|uhrazeno|zaplatil\\w*|bezahlt|platba)'),
    incoming: rx('(received|credited|sent you|salary|mzda|výplata|připsán\\w*|gutgeschrieben|payout|deposit)')
  };
  function pickAmount(text, role) {
    const all = findAmounts(text);
    if (!all.length) return { amount: null, candidates: 0 };
    const re = ROLE_RE[role] || ROLE_RE.due;
    let best = null, bestDist = 1e9;
    for (const a of all) {
      const before = text.slice(Math.max(0, a.index - 120), a.index);
      const mm = [...before.matchAll(new RegExp(re.source, 'giu'))].pop();
      if (mm) { const d = before.length - (mm.index + mm[0].length); if (d <= 70 && d < bestDist) { bestDist = d; best = a; } }
    }
    if (best) return { amount: best, candidates: all.length, roleMatched: true };
    const distinct = [...new Set(all.map((a) => a.currency + ':' + a.value))];
    if (distinct.length === 1) return { amount: all[0], candidates: all.length, roleMatched: false };
    return { amount: null, candidates: all.length, ambiguous: true };
  }

  // ---------- dates (explicit only; ambiguous numeric dates stay unknown)
  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
    ledna: 1, leden: 1, února: 2, unor: 2, únor: 2, března: 3, brezna: 3, březen: 3, dubna: 4, duben: 4, května: 5, kvetna: 5, květen: 5,
    června: 6, cervna: 6, červen: 6, července: 7, cervence: 7, červenec: 7, srpna: 8, srpen: 8, září: 9, zari: 9, října: 10, rijna: 10, říjen: 10,
    listopadu: 11, listopad: 11, prosince: 12, prosinec: 12,
    januar: 1, jänner: 1, februar: 2, märz: 3, maerz: 3, mai: 5, juni: 6, juli: 7, oktober: 10, dezember: 12
  };
  const MON_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const DATE_PATTERNS = [
    { re: /(\d{4})-(\d{1,2})-(\d{1,2})/g, f: (m) => ({ y: +m[1], mo: +m[2], d: +m[3] }) },
    { re: /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?!\d)/g, f: (m) => ({ y: m[3].length === 2 ? 2000 + +m[3] : +m[3], mo: +m[2], d: +m[1] }) },
    { re: /(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/g, f: (m) => { const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; if (a > 12 && b <= 12) return { y, mo: b, d: a }; if (b > 12 && a <= 12) return { y, mo: a, d: b }; if (a === b) return { y, mo: a, d: a }; return { ambiguous: true }; } },
    { re: new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(${MON_ALT})\\.?,?\\s+(\\d{4})`, 'giu'), f: (m) => ({ y: +m[3], mo: MONTHS[m[2].toLowerCase()], d: +m[1] }) },
    { re: new RegExp(`(?<![\\p{L}])(${MON_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'giu'), f: (m) => ({ y: +m[3], mo: MONTHS[m[1].toLowerCase()], d: +m[2] }) },
    { re: new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(${MON_ALT})(?![\\p{L}])(?!\\.?,?\\s+\\d{4})`, 'giu'), f: (m) => ({ mo: MONTHS[m[2].toLowerCase()], d: +m[1], noYear: true }) },
    { re: new RegExp(`(?<![\\p{L}])(${MON_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?!,?\\s+\\d{4})`, 'giu'), f: (m) => ({ mo: MONTHS[m[1].toLowerCase()], d: +m[2], noYear: true }) },
    { re: /(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.(?!\s?\d)/g, f: (m) => ({ mo: +m[2], d: +m[1], noYear: true }) }
  ];
  function validDate(y, mo, d) { if (!y || !mo || !d || mo > 12 || d > 31) return null; const dt = new Date(Date.UTC(y, mo - 1, d, 12)); return dt.getUTCMonth() === mo - 1 ? dt : null; }
  function findDates(text, refMs) {
    const out = [];
    const taken = [];
    for (const p of DATE_PATTERNS) {
      p.re.lastIndex = 0; let m;
      while ((m = p.re.exec(text))) {
        const s = m.index, e = s + m[0].length;
        if (taken.some(([a, b]) => s < b && e > a)) continue;
        const r = p.f(m);
        if (!r) continue;
        taken.push([s, e]);
        if (r.ambiguous) { out.push({ index: s, raw: m[0], ambiguous: true }); continue; }
        let y = r.y, inferred = false;
        if (r.noYear) {
          if (!refMs) continue;
          const ref = new Date(refMs); y = ref.getUTCFullYear(); inferred = true;
          const cand = validDate(y, r.mo, r.d);
          if (cand && cand.getTime() < refMs - 45 * DAY) y += 1; // a date written without a year is the next occurrence after the email
        }
        const dt = validDate(y, r.mo, r.d);
        if (dt) out.push({ index: s, raw: m[0], iso: dt.toISOString().slice(0, 10), yearInferred: inferred });
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }
  const DATE_ROLE = {
    due: rx('(due date|due by|due on|is due|due:|úhradě[^.\\n]{0,40}do|uhra\\w+[^.\\n]{0,20}\\bdo\\b|zapla[tť]\\w*[^.\\n]{0,20}\\bdo\\b|\\bpay\\b[^.\\n]{0,60}\\bby|payable (by|until|before)|pay by|please pay (by|before)|deadline|splatnost\\w*|datum splatnosti|splatn[éá] do|uhraďte do|zaplaťte do|fällig( am)?|zahlbar bis|zahlungsfrist|zahlungsziel)'),
    issue: rx('(invoice date|date of issue|issued (on)?|issue date|datum vystavení|vystaveno|rechnungsdatum|ausgestellt am)'),
    payment: rx('(paid on|payment date|date paid|charged on|transaction date|datum (platby|úhrady|zaplacení)|zaplaceno dne|uhrazeno dne|bezahlt am|on (?=\\d))'),
    renewal: rx('(renews? on|renewal date|will renew on|next (billing|payment|charge) (date|on)|will be (charged|billed|renewed) on|trial (ends|ending|expires) on|se obnoví|bude obnoven\\w* dne|příští platba|verlängert sich am|nächste (zahlung|abbuchung))'),
    refund: rx('(refund(ed)? on|refund date|vrácen\\w* dne)')
  };
  function dateFor(text, dates, role, maxGap) {
    const re = DATE_ROLE[role];
    let best = null, bestGap = 1e9;
    for (const d of dates) {
      const before = text.slice(Math.max(0, d.index - 160), d.index);
      const mm = [...before.matchAll(new RegExp(re.source, 'giu'))].pop();
      if (!mm) continue;
      const gap = before.length - (mm.index + mm[0].length);
      if (gap > (maxGap || 45)) continue; // the role word must sit right before the date
      if (gap < bestGap) { bestGap = gap; best = d; }
    }
    return best;
  }

  // ---------- merchant
  const NOISE = /\b(billing|no-?reply|noreply|do-?not-?reply|receipts?|support|service|services|notifications?|alerts?|info|team|mailer|account|accounts|payments?|invoices?|newsletter|news|hello)\b/gi;
  function merchantOf(n) {
    const raw = (n.fromName || '').replace(NOISE, ' ').replace(/[|·•]+/g, ' ').replace(/\s+/g, ' ').trim();
    const dom = (n.fromEmail.split('@')[1] || '').toLowerCase();
    const root = dom.replace(/^(mail|email|e|info|news|notify|notifications|billing|accounts?)\./, '').split('.').slice(-2, -1)[0] || dom;
    return { name: raw || (root ? root.charAt(0).toUpperCase() + root.slice(1) : 'Unknown'), domain: dom, key: (root || raw || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '') };
  }

  // ---------- classification
  function evidenceSnip(text, re) {
    const m = text.match(re); if (!m) return null;
    const i = m.index || 0;
    return text.slice(Math.max(0, i - 25), Math.min(text.length, i + m[0].length + 25)).replace(/\s+/g, ' ').trim().slice(0, 110);
  }

  function classify(rawMail, opts) {
    // v2 mail cache: a message whose body was processed earlier carries the stored result instead of the body
    if (rawMail && rawMail._bodyFromCache && rawMail._derived && rawMail._derived.fin && rawMail._derived.finV === VERSION) return JSON.parse(JSON.stringify(rawMail._derived.fin));
    const n = normalizeMail(rawMail);
    if (!n) return null;
    const o = opts || {};
    const subj = n.subject || '';
    const main = `${subj}\n${n.snippet}\n${n.body}`;
    const textNoDisc = main.replace(new RegExp(R.disclaimerPaid.source, 'giu'), ' ');
    const labels = n.labels.map(String);
    const ev = [];
    const sig = {};
    const hit = (key, re, src) => { const t = src || textNoDisc; if (re.test(t)) { sig[key] = true; const e = evidenceSnip(t, re); if (e) ev.push({ signal: key, text: e }); return true; } return false; };

    const promoLabel = labels.includes('CATEGORY_PROMOTIONS');
    const promoHits = (main.match(new RegExp(R.promoPhrase.source, 'giu')) || []).length;
    const promoSubject = R.promoPhrase.test(subj);
    hit('failed', R.failed); hit('refund', R.refund);
    const refundPolicy = R.refundPolicy.test(main);
    hit('refundDone', R.refundDone); hit('refundPending', R.refundPending);
    hit('incoming', R.incoming); hit('outgoing', R.outgoing); hit('cardTxn', R.cardTxn);
    hit('pending', R.pending); hit('success', R.success);
    hit('invoiceCtx', R.invoiceCtx); hit('paidInvoice', R.paidInvoice); hit('directDebit', R.directDebit); hit('unpaid', R.unpaidCtx);
    hit('receipt', R.receipt); hit('subscription', R.subscription); hit('renewFuture', R.renewFuture); hit('renewDone', R.renewDone);
    hit('subCancel', R.subCancel); hit('statement', R.statement);
    const bankish = R.bankSender.test(n.fromName + ' ' + n.fromEmail);
    const invoiceNo = (textNoDisc.match(R.invoiceNo) || [])[2] || null;
    const orderRef = (textNoDisc.match(R.orderRef) || [])[2] || null;
    const txnRef = (textNoDisc.match(R.txnRef) || [])[2] || null;
    const strongTxn = !!(invoiceNo || orderRef || txnRef) && (sig.success || sig.unpaid || sig.receipt || sig.paidInvoice || sig.refundDone || sig.failed);

    // Promotion: Gmail's Promotions label, or several marketing phrases — unless the mail carries hard transactional evidence.
    const promoScore = (promoLabel ? 2 : 0) + Math.min(3, promoHits) + (promoSubject ? 1 : 0) + (R.promoSender.test(n.fromEmail) ? 1 : 0) + (R.unsubscribe.test(main) ? 0.5 : 0);
    let category = 'not_financial', confidence = 0.5, needsReview = false;
    const conflicts = [];
    const decide = (c, conf) => { category = c; confidence = conf; };

    const transactional = sig.failed || sig.refundDone || sig.success || sig.paidInvoice || (sig.unpaid && sig.invoiceCtx) || sig.receipt || sig.incoming || sig.cardTxn || sig.outgoing || sig.statement || sig.renewFuture || sig.renewDone;
    if (promoScore >= 3 && !strongTxn && !promoHits && !transactional && !sig.invoiceCtx) {
      decide('not_financial', 0.75); // marketing with no price, deal or payment wording
    } else if (promoScore >= 3 && !strongTxn) {
      decide('promotional_offer', Math.min(0.97, 0.7 + promoScore * 0.05));
      if (transactional) { conflicts.push('marketing mail that also uses payment words'); }
    } else if (sig.failed) {
      decide('payment_failed', 0.9);
    } else if (sig.refund && !refundPolicy && (sig.refundDone || sig.refundPending || /refund|vrácen|erstatt/i.test(subj))) {
      if (sig.refundDone && !sig.refundPending) decide('refund_received', 0.9);
      else if (sig.refundPending && !sig.refundDone) decide('refund_pending', 0.85);
      else if (sig.refundDone && sig.refundPending) { decide('refund_pending', 0.6); conflicts.push('refund described as both issued and still processing'); }
      else { decide('refund_pending', 0.55); conflicts.push('refund mentioned without a clear status'); }
    } else if (sig.incoming && !sig.unpaid && !sig.receipt) {
      decide('incoming_money', bankish ? 0.88 : 0.78);
    } else if (sig.subscription && (sig.renewFuture || sig.renewDone) && !sig.subCancel) {
      decide('subscription_renewal', sig.renewFuture ? 0.85 : 0.8);
      if (sig.unpaid && sig.invoiceCtx && !sig.renewFuture) conflicts.push('renewal that also mentions an amount due');
    } else if (sig.invoiceCtx && sig.paidInvoice) {
      decide('paid_invoice', 0.88);
      if (sig.unpaid && !sig.paidInvoice) conflicts.push('paid and unpaid wording');
    } else if (sig.failed === undefined && sig.success && (sig.receipt || orderRef)) {
      decide('purchase_receipt', 0.86);
    } else if (sig.success && sig.invoiceCtx && !sig.unpaid) {
      decide('paid_invoice', 0.82);
    } else if (sig.success) {
      decide(sig.outgoing ? 'outgoing_payment' : (sig.cardTxn ? 'bank_transaction' : 'payment_successful'), 0.82);
    } else if (sig.receipt && !sig.unpaid) {
      decide('purchase_receipt', 0.8);
    } else if (sig.pending && !sig.unpaid) {
      decide('payment_pending', 0.78);
    } else if (sig.statement && !sig.unpaid) {
      decide('financial_statement', 0.85);
    } else if (sig.invoiceCtx && sig.directDebit && !sig.failed) {
      decide('unpaid_bill', 0.8); // bill that will be collected automatically: real, but no action for the user
    } else if (sig.invoiceCtx && sig.unpaid) {
      decide('unpaid_bill', 0.8);
      if (sig.directDebit) { /* paid automatically: still a bill, but no action for the user */ }
    } else if (sig.statement && sig.unpaid) {
      decide('unpaid_bill', 0.8); // e.g. credit-card statement with a minimum payment and due date
    } else if (sig.outgoing) {
      decide('outgoing_payment', bankish ? 0.85 : 0.75);
    } else if (sig.cardTxn) {
      decide('bank_transaction', bankish ? 0.85 : 0.75);
    } else if (sig.invoiceCtx && (findAmounts(main).length || invoiceNo) && !promoScore) {
      decide('unpaid_bill', 0.5); conflicts.push('invoice without due or paid wording');
    } else if (sig.subscription && sig.subCancel) {
      decide('not_financial', 0.7);
    } else if (promoScore >= 2 && promoHits > 0) {
      decide('promotional_offer', 0.65); // marketing that actually promotes a price, deal or financial product
    }
    if (promoLabel && !['promotional_offer', 'not_financial'].includes(category)) { confidence -= 0.12; conflicts.push('Gmail filed this under Promotions'); }
    if (sig.unpaid && sig.paidInvoice && category === 'paid_invoice') { confidence -= 0.1; conflicts.push('mentions both paid and due'); }

    // ---------- fields
    const role = { refund_received: 'refund', refund_pending: 'refund', incoming_money: 'incoming', unpaid_bill: 'due', payment_failed: 'due' }[category] || 'paid';
    const am = category === 'not_financial' || category === 'promotional_offer' ? { amount: null } : pickAmount(`${subj}\n${n.snippet}\n${n.body}`, role);
    const amount = am.amount ? { value: am.amount.value, currency: am.amount.currency, raw: am.amount.raw } : null;
    if (am.ambiguous && category !== 'not_financial' && category !== 'promotional_offer') conflicts.push('several different amounts; none labelled');
    const dates = findDates(textNoDisc, n.whenMs);
    const pickD = (r) => { const d = dateFor(textNoDisc, dates, r); return d && !d.ambiguous ? { date: d.iso, raw: d.raw, yearInferred: d.yearInferred } : null; };
    const ambiguousDue = dates.some((d) => d.ambiguous) && DATE_ROLE.due.test(textNoDisc);
    const due = ['unpaid_bill', 'payment_failed', 'financial_statement'].includes(category) ? pickD('due') : null;
    const issue = ['unpaid_bill', 'paid_invoice'].includes(category) ? pickD('issue') : null;
    const paidOn = ['paid_invoice', 'payment_successful', 'purchase_receipt', 'bank_transaction', 'outgoing_payment'].includes(category) ? pickD('payment') : null;
    const renewal = category === 'subscription_renewal' ? pickD('renewal') : null;
    const refundOn = category === 'refund_received' ? pickD('refund') : null;
    if (ambiguousDue && !due) conflicts.push('due date written in an ambiguous format (e.g. 03/04/2026)');

    const status = {
      unpaid_bill: sig.directDebit ? 'scheduled_debit' : (category === 'unpaid_bill' && confidence < 0.6 ? 'unknown' : 'unpaid'),
      paid_invoice: 'paid', payment_pending: 'pending', payment_successful: 'paid', payment_failed: 'failed',
      refund_received: 'refunded', refund_pending: 'refund_pending', incoming_money: 'received', outgoing_payment: 'sent',
      subscription_renewal: sig.renewFuture ? 'scheduled' : 'renewed', purchase_receipt: 'paid', promotional_offer: null,
      bank_transaction: 'posted', financial_statement: 'info', not_financial: null
    }[category];
    let direction = DIRECTION[category];
    if (category === 'bank_transaction') direction = sig.incoming ? 'incoming' : (sig.cardTxn || sig.outgoing ? 'outgoing' : null);

    if (['unpaid_bill', 'payment_successful', 'paid_invoice', 'refund_received', 'refund_pending', 'incoming_money', 'purchase_receipt', 'payment_failed'].includes(category) && !amount) { confidence -= 0.08; }
    if (due && due.yearInferred) confidence -= 0.05;
    if (n.bodyDeferred || !n.bodyAvailable) confidence -= 0.05; // judged from subject + preview only
    if (conflicts.length) confidence -= 0.1 * Math.min(2, conflicts.length);
    confidence = Math.max(0.05, Math.min(0.99, +confidence.toFixed(2)));
    needsReview = confidence < 0.7 || conflicts.length > 0 || (category === 'unpaid_bill' && !due && status === 'unpaid');

    const merchant = merchantOf(n);
    return {
      v: VERSION,
      mailId: n.id, threadId: n.threadId, receivedAt: n.whenMs ? new Date(n.whenMs).toISOString() : null,
      category, label: LABELS[category], status, direction,
      merchant: merchant.name, merchantKey: merchant.key, merchantDomain: merchant.domain,
      amount, invoiceNumber: invoiceNo, reference: txnRef || null, orderId: orderRef,
      issueDate: issue?.date || null, dueDate: due?.date || null, dueDateRaw: due?.raw || null, dueYearInferred: !!due?.yearInferred,
      paymentDate: paidOn?.date || null, renewalDate: renewal?.date || null, refundDate: refundOn?.date || null,
      refund: /refund/.test(category) ? { amount, status } : null,
      confidence, needsReview, conflicts, evidence: ev.slice(0, 6),
      subject: subj.slice(0, 160), fromName: n.fromName, fromEmail: n.fromEmail,
      judgedFrom: n.bodyAvailable && !n.bodyDeferred ? 'full email' : 'subject and preview only'
    };
  }

  // ---------- obligation policy
  /** Is this record something the user must pay? Only with convincing evidence AND a written due date. */
  function obligationOf(rec, nowMs) {
    if (!rec || rec.dismissed) return { kind: null };
    if (rec.category !== 'unpaid_bill') return { kind: null };
    if (rec.status === 'scheduled_debit') return { kind: 'upcoming', reason: 'paid automatically by direct debit', action: false };
    if (rec.status !== 'unpaid' || rec.linkedPaid) return { kind: null };
    if (!rec.dueDate) return { kind: 'review', reason: 'no due date written in the email' };
    if (rec.confidence < 0.75 || rec.needsReview) return { kind: 'review', reason: 'not sure this is unpaid' };
    const due = Date.parse(rec.dueDate + 'T12:00:00Z');
    const days = Math.floor((due - (nowMs || Date.now())) / DAY);
    return { kind: days <= 7 ? 'outstanding' : 'upcoming', overdue: days < 0, days, action: true };
  }
  /** A reminder may be SUGGESTED (never created) only for an outstanding/upcoming unpaid bill with an explicit due date. */
  function reminderSuggestion(rec, nowMs) {
    const ob = obligationOf(rec, nowMs);
    if (!ob.action || !rec.dueDate || rec.dueYearInferred && rec.confidence < 0.85) return null;
    return {
      key: 'finrem:' + rec.key, recordKey: rec.key, mailId: rec.mailIds[0],
      title: `Pay ${rec.merchant}${rec.amount ? ' · ' + fmtAmount(rec.amount) : ''}`,
      dueDate: rec.dueDate, confidence: rec.confidence, requiresConfirmation: true,
      why: `Unpaid ${rec.invoiceNumber ? 'invoice ' + rec.invoiceNumber : 'bill'} with due date ${rec.dueDate}${rec.dueDateRaw ? ' (“' + rec.dueDateRaw + '”)' : ''}`
    };
  }
  function fmtAmount(a) {
    if (!a) return '';
    const sym = { EUR: '€', USD: '$', GBP: '£', INR: '₹' }[a.currency];
    const v = a.value.toLocaleString('en-US', { minimumFractionDigits: a.value % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return sym ? sym + v : v + ' ' + (a.currency === 'CZK' ? 'Kč' : a.currency);
  }

  // ---------- ledger: dedupe + linking
  const PAYMENT_CATS = new Set(['payment_successful', 'paid_invoice', 'bank_transaction', 'outgoing_payment']);
  const sameAmount = (a, b) => a && b && a.currency === b.currency && Math.abs(a.value - b.value) < 0.005;
  const normRef = (s) => (s ? String(s).toUpperCase().replace(/[^A-Z0-9]/g, '') : null);

  /**
   * Build financial records from classified emails.
   * classifications: output of classify() per mail; prior: previously persisted ledger records (optional);
   * corrections: { [mailId]: { category?, dismissed?, confirmed? } } set by the user.
   */
  function buildLedger(classifications, options) {
    const o = options || {};
    const now = o.now || Date.now();
    const corr = o.corrections || {};
    const items = (classifications || []).filter(Boolean).map((c) => {
      const fix = corr[c.mailId];
      if (fix && fix.category && CATEGORIES.includes(fix.category) && fix.category !== c.category) {
        return { ...c, category: fix.category, label: LABELS[fix.category], direction: DIRECTION[fix.category], status: defaultStatus(fix.category), confidence: 0.99, needsReview: false, corrected: true, evidence: [{ signal: 'user', text: 'Corrected by you' }, ...(c.evidence || [])] };
      }
      if (fix && fix.confirmed && c.category === 'unpaid_bill') return { ...c, confidence: Math.max(c.confidence, 0.95), needsReview: !c.dueDate, confirmed: true };
      return c;
    });
    const fin = items.filter((c) => c.category !== 'not_financial');
    const records = new Map();
    const keyOf = (c) => {
      const mk = c.merchantKey || 'unknown';
      if (c.category === 'promotional_offer') return 'promo:' + c.mailId;
      if (c.category === 'subscription_renewal') return 'sub:' + mk;
      if (c.invoiceNumber && /bill|invoice/.test(c.category)) return 'inv:' + mk + ':' + normRef(c.invoiceNumber);
      if (c.orderId && /receipt|refund/.test(c.category)) return 'ord:' + mk + ':' + normRef(c.orderId) + (/refund/.test(c.category) ? ':refund' : '');
      if (c.reference && c.category !== 'unpaid_bill') return 'ref:' + mk + ':' + normRef(c.reference);
      return 'mail:' + c.mailId;
    };
    const rank = { unpaid: 1, unknown: 0, scheduled_debit: 2, pending: 3, failed: 2, paid: 5, refunded: 5, refund_pending: 3 };
    // oldest first so later mails update earlier records
    fin.sort((a, b) => (Date.parse(a.receivedAt || 0) || 0) - (Date.parse(b.receivedAt || 0) || 0));
    for (const c of fin) {
      const key = keyOf(c);
      const prev = records.get(key);
      if (!prev) { records.set(key, { ...c, key, mailIds: [c.mailId], history: [{ mailId: c.mailId, category: c.category, status: c.status, at: c.receivedAt }], links: [] }); continue; }
      if (prev.mailIds.includes(c.mailId)) continue; // repeated sync: idempotent
      prev.mailIds.push(c.mailId);
      prev.history.push({ mailId: c.mailId, category: c.category, status: c.status, at: c.receivedAt });
      // a later email for the same invoice/subscription updates the record instead of creating another one
      const later = (Date.parse(c.receivedAt || 0) || 0) >= (Date.parse(prev.receivedAt || 0) || 0);
      if (key.startsWith('inv:')) {
        if (c.category === 'paid_invoice' || c.status === 'paid') Object.assign(prev, { category: 'paid_invoice', label: LABELS.paid_invoice, status: 'paid', paymentDate: c.paymentDate || prev.paymentDate, linkedPaid: { mailId: c.mailId, by: 'invoice number', strength: 'confirmed' } });
        else if (later && (rank[c.status] || 0) >= (rank[prev.status] || 0)) Object.assign(prev, { dueDate: c.dueDate || prev.dueDate, dueDateRaw: c.dueDateRaw || prev.dueDateRaw, amount: c.amount || prev.amount });
        prev.duplicateNotices = (prev.duplicateNotices || 0) + 1;
      } else if (key.startsWith('sub:')) {
        if (later) Object.assign(prev, { status: c.status, renewalDate: c.renewalDate || prev.renewalDate, amount: c.amount || prev.amount, receivedAt: c.receivedAt, subject: c.subject, confidence: Math.max(prev.confidence, c.confidence), needsReview: c.needsReview && prev.needsReview });
      } else if (later) {
        Object.assign(prev, { status: c.status, category: c.category, label: c.label, receivedAt: c.receivedAt });
      }
      prev.evidence = [...(prev.evidence || []), ...(c.evidence || [])].slice(0, 8);
    }
    // merge prior persisted records that are no longer in the fetch window (keeps history, never duplicates)
    for (const p of o.prior || []) {
      if (!p || !p.key || records.has(p.key)) continue;
      if (p.mailIds?.some((id) => fin.some((c) => c.mailId === id))) continue;
      records.set(p.key, { ...p, fromHistory: true });
    }
    const list = [...records.values()];
    // ---- link invoices ↔ payment confirmations (strong: same invoice/reference number; probable: merchant + amount + order in time, unique)
    const invoices = list.filter((r) => r.category === 'unpaid_bill' && r.status === 'unpaid');
    const payments = list.filter((r) => PAYMENT_CATS.has(r.category) && !r.key.startsWith('inv:'));
    const probableCands = (inv) => { const t0 = Date.parse(inv.receivedAt || 0) || 0; return payments.filter((p) => p.merchantKey === inv.merchantKey && sameAmount(p.amount, inv.amount) && (Date.parse(p.receivedAt || 0) || 0) >= t0 && (Date.parse(p.receivedAt || 0) || 0) - t0 <= 60 * DAY && !(p.invoiceNumber && inv.invoiceNumber && normRef(p.invoiceNumber) !== normRef(inv.invoiceNumber))); };
    const weak = [];
    for (const inv of invoices) {
      const strong = payments.find((p) => (inv.invoiceNumber && normRef(p.invoiceNumber) === normRef(inv.invoiceNumber)) || (inv.reference && normRef(p.reference) === normRef(inv.reference)));
      if (strong) { linkPaid(inv, strong, 'same ' + (inv.invoiceNumber ? 'invoice number' : 'reference'), 'confirmed'); continue; }
      const cands = probableCands(inv);
      if (cands.length === 1) weak.push([inv, cands[0]]);
    }
    // amount + sender alone is weak evidence: only suggest it when the payment fits exactly one open invoice, too
    for (const [inv, pay] of weak) if (weak.filter(([, p]) => p === pay).length === 1 && invoices.filter((i) => i.status === 'unpaid' && probableCands(i).includes(pay)).length === 1) linkPaid(inv, pay, 'same sender and amount, paid after the invoice', 'probable');
    // ---- refunds ↔ original purchase
    const purchases = list.filter((r) => r.category === 'purchase_receipt' || r.category === 'payment_successful');
    for (const rf of list.filter((r) => /refund/.test(r.category))) {
      const byOrder = rf.orderId && purchases.find((p) => normRef(p.orderId) === normRef(rf.orderId));
      const cand = byOrder || (() => { const cs = purchases.filter((p) => p.merchantKey === rf.merchantKey && p.amount && rf.amount && p.amount.currency === rf.amount.currency && rf.amount.value <= p.amount.value + 0.005 && (Date.parse(p.receivedAt || 0) || 0) <= (Date.parse(rf.receivedAt || 0) || 0)); return cs.length === 1 ? cs[0] : null; })();
      if (cand) { rf.links.push({ to: cand.key, kind: 'refund_of', strength: byOrder ? 'confirmed' : 'probable' }); cand.links.push({ to: rf.key, kind: 'refunded_by', strength: byOrder ? 'confirmed' : 'probable' }); cand.refundedBy = rf.key; }
    }
    // ---- purchase ↔ receipt (same order id) already merged by key; subscriptions grouped by merchant key.
    for (const r of list) {
      const ob = obligationOf(r, now);
      r.obligation = ob.kind; r.obligationReason = ob.reason || null; r.overdue = !!ob.overdue;
      r.bucket = bucketOf(r);
      r.suggestion = reminderSuggestion(r, now);
      if (corr[r.mailIds[0]]?.dismissed) { r.dismissed = true; r.bucket = 'dismissed'; r.suggestion = null; r.obligation = null; }
    }
    return { version: VERSION, builtAt: new Date(now).toISOString(), records: list, byMail: indexByMail(list), counts: countBuckets(list) };
  }
  function linkPaid(inv, pay, by, strength) {
    inv.links.push({ to: pay.key, kind: 'paid_by', strength, by });
    pay.links.push({ to: inv.key, kind: 'pays', strength, by });
    if (strength === 'confirmed') { inv.status = 'paid'; inv.category = 'paid_invoice'; inv.label = LABELS.paid_invoice; inv.linkedPaid = { key: pay.key, by, strength }; inv.paymentDate = pay.paymentDate || pay.receivedAt?.slice(0, 10) || null; }
    else { inv.linkedPaid = { key: pay.key, by, strength }; inv.possiblyPaid = true; inv.needsReview = true; }
  }
  function defaultStatus(c) { return { unpaid_bill: 'unpaid', paid_invoice: 'paid', payment_pending: 'pending', payment_successful: 'paid', payment_failed: 'failed', refund_received: 'refunded', refund_pending: 'refund_pending', incoming_money: 'received', outgoing_payment: 'sent', subscription_renewal: 'scheduled', purchase_receipt: 'paid', bank_transaction: 'posted', financial_statement: 'info' }[c] || null; }
  /** UI bucket: outstanding · upcoming · paid · refunded · incoming · review · info · promotion */
  function bucketOf(r) {
    if (r.dismissed) return 'dismissed';
    if (r.category === 'promotional_offer') return 'promotion';
    if (r.obligation === 'outstanding') return 'outstanding';
    if (r.obligation === 'upcoming') return 'upcoming';
    if (r.obligation === 'review' || r.possiblyPaid) return 'review';
    if (r.category === 'subscription_renewal') return r.status === 'scheduled' && r.renewalDate ? 'upcoming' : (r.needsReview ? 'review' : 'paid');
    if (r.category === 'payment_failed') return 'review';
    if (r.category === 'refund_received') return 'refunded';
    if (r.category === 'refund_pending') return 'refunded';
    if (r.category === 'incoming_money' || (r.category === 'bank_transaction' && r.direction === 'incoming')) return 'incoming';
    if (r.needsReview) return 'review';
    if (['paid_invoice', 'payment_successful', 'purchase_receipt', 'outgoing_payment', 'bank_transaction'].includes(r.category)) return 'paid';
    if (r.category === 'payment_pending') return 'upcoming';
    if (r.category === 'unpaid_bill') return 'review';
    return 'info';
  }
  function indexByMail(list) { const m = {}; list.forEach((r) => r.mailIds.forEach((id) => { m[id] = r.key; })); return m; }
  function countBuckets(list) { const c = { outstanding: 0, upcoming: 0, paid: 0, refunded: 0, incoming: 0, review: 0, info: 0, promotion: 0, dismissed: 0, suggestions: 0 }; list.forEach((r) => { c[r.bucket] = (c[r.bucket] || 0) + 1; if (r.suggestion) c.suggestions++; }); return c; }

  /** Compact copy for persistence: no bodies, short evidence only. */
  function compact(rec) {
    const { subject, evidence, ...rest } = rec;
    return { ...rest, subject: String(subject || '').slice(0, 120), evidence: (evidence || []).slice(0, 4).map((e) => ({ signal: e.signal, text: String(e.text || '').slice(0, 90) })) };
  }

  const api = { VERSION, CATEGORIES, LABELS, classify, buildLedger, obligationOf, reminderSuggestion, bucketOf, compact, fmtAmount, normalizeMail, _findAmounts: findAmounts, _findDates: findDates, _pickAmount: pickAmount };
  root.DaylightFinance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
