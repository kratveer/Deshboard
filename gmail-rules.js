// Daylight local rule pipeline (v2).
// Stage B: metadata-only rules (labels → List-Unsubscribe → sender-domain cache → keywords on subject+snippet).
// Stage C: body extraction (schema.org JSON-LD / microdata → regex) before any AI.
// Every rule returns { category, confidence, reason }. No network, no DOM, no storage.
(function (root) {
  'use strict';

  // Daylight pipeline categories
  const CATEGORIES = Object.freeze(['bill', 'payment', 'refund', 'travel', 'food', 'subscription', 'receipt', 'document',
    'security', 'promotion', 'newsletter', 'social', 'personal', 'other']);
  // High-value categories: always worth a body (Stage C) so amounts, dates and references can be extracted.
  const HIGH_VALUE = new Set(['bill', 'payment', 'refund', 'travel', 'food', 'subscription', 'receipt', 'document']);
  const LOW_VALUE = new Set(['promotion', 'newsletter', 'social']);

  const U = (s, f) => new RegExp(s, (f || 'i') + 'u');
  const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
  const W = (alts) => U(B + '(?:' + alts + ')' + E);

  // ---------- signal patterns (subject + snippet; multilingual EN / CS / DE / HI-Latin / Devanagari) ----------
  const P = {
    amount: U('(?:[₹€$£]\\s?\\d[\\d.,\\s]*\\d|\\d[\\d.,\\s]*\\s?(?:Kč|kč|CZK|EUR|USD|INR|GBP|€|₹)|' + B + '(?:Rs\\.?|INR|CZK|EUR|USD)\\s?\\d[\\d.,]*)'),
    date: U('(?:\\b\\d{1,2}[./-]\\s?\\d{1,2}[./-]\\s?\\d{2,4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|' + B + '\\d{1,2}\\.?\\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|led|úno|bře|dub|kvě|čer|srp|zář|říj|lis|pro)[\\p{L}]*' + ')'),
    pnr: U(B + '(?:pnr|booking (?:ref(?:erence)?|code|number)|confirmation (?:code|number|no\\.?)|reservation (?:code|number)|číslo rezervace|kód rezervace|buchungsnummer|e-?ticket)' + E),
    pnrCode: /\b(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6}\b/,
    invoiceNo: U(B + '(?:invoice|faktura|rechnung|bill|účet|vyúčtování|order|objednávk[ay]|bestellung)\\s*(?:no\\.?|number|č\\.|#|nr\\.?)?\\s*[:#]?\\s*[A-Z]{0,4}[-/]?\\d{3,}'),
    bill: W('invoice|úhrad[uy]|uhradit|uhraďte|prosíme o úhradu|splatn[áéýo]|payable|zahlbar|bill (?:is )?(?:due|ready)|amount due|payment due|due date|please pay|pay by|overdue|faktura|vyúčtování|splatnost|k úhradě|zaplaťte|rechnung|fällig|बिल|भुगतान देय|bill due'),
    payment: W('payment (?:received|successful|confirmed|sent|processed|failed|declined)|you paid|you sent|paid to|transaction|card (?:payment|transaction)|debited|credited|platba|zaplaceno|odchozí platba|příchozí platba|zahlung|überweisung|upi|imps|neft|भुगतान|लेनदेन|payout|withdrawal|transfer'),
    refund: W('refund(?:ed)?|money back|reimburse(?:d|ment)?|vrácení|vratka|refundace|erstattung|rückerstattung|रिफंड|wird erstattet|credited back'),
    travel: W('flight|boarding pass|itinerary|e-?ticket|check-?in|booking (?:confirmed|confirmation)|reservation|hotel|airbnb|train|jízdenka|letenka|rezervace|ubytování|zug|flug|buchung|उड़ान|यात्रा|टिकट|ticket'),
    food: W('food order|your order from|ordering from|estimated delivery \\d+ ?min|delivery in \\d+ ?min|doručení do \\d+ ?minut|restaurant|table (?:booking|reservation)|table for \\d|reservation at|rezervac[ie] stolu|stůl pro|tischreservierung|delivery from|rozvoz|objednávka jídla|stůl|tisch'),
    subscription: W('subscription|členství|prodlouž\\p{L}*|renew(?:al|s|ed)?|membership|trial (?:ends|ending)|plan (?:renews|changed)|předplatné|obnovení|abonnement|verlängerung|सदस्यता'),
    receipt: W('receipt|order (?:confirmed|confirmation|placed|shipped|delivered)|your order|thanks for your order|purchase|účtenka|potvrzení objednávky|objednávka|bestellbestätigung|quittung|रसीद|ऑर्डर'),
    document: W('smlouv[aeuy]|kupní|versicherung\\p{L}*|acknowledg(?:e)?ment|tax return|itr-?v|contract|agreement|signed|signature|policy document|insurance|certificate|statement|tax|visa|passport|smlouva|pojistka|potvrzení|výpis|daň|vertrag|dokument|bescheinigung|दस्तावेज़'),
    security: W('used to sign in|sign-?in (?:attempt|from)|nové přihlášení|verification code|security alert|new sign-?in|password reset|2-step|one-time (?:code|password)|otp|přihlášení|ověřovací kód|sicherheitswarnung|सुरक्षा'),
    promo: W('% off|\\d+ ?% off|free delivery|doprava zdarma|up to \\d+ ?%|sale|discount|deal|offer|coupon|promo(?:tion|code)?|save up to|limited time|black friday|cyber monday|free shipping|sleva|akce|výprodej|angebot|rabatt|ऑफ़र|छूट'),
    newsletter: W('newsletter|digest|weekly|this week in|roundup|webinar|zpravodaj|novinky')
  };

  // Seed domain → category (overridden by learned or user choices in the domain cache).
  const SEED_DOMAINS = Object.freeze({
    'booking.com': 'travel', 'airbnb.com': 'travel', 'ryanair.com': 'travel', 'wizzair.com': 'travel', 'lufthansa.com': 'travel', 'czechairlines.com': 'travel', 'smartwings.com': 'travel',
    'regiojet.cz': 'travel', 'cd.cz': 'travel', 'flixbus.com': 'travel', 'trainline.com': 'travel', 'skyscanner.net': 'travel', 'makemytrip.com': 'travel', 'irctc.co.in': 'travel', 'indigo.in': 'travel', 'goindigo.in': 'travel', 'expedia.com': 'travel',
    'wolt.com': 'food', 'foodora.cz': 'food', 'ubereats.com': 'food', 'swiggy.in': 'food', 'zomato.com': 'food', 'damejidlo.cz': 'food', 'opentable.com': 'food', 'thefork.com': 'food',
    'netflix.com': 'subscription', 'spotify.com': 'subscription', 'adobe.com': 'subscription', 'icloud.com': 'subscription',
    'paypal.com': 'payment', 'revolut.com': 'payment', 'wise.com': 'payment', 'stripe.com': 'payment', 'kb.cz': 'payment', 'csas.cz': 'payment', 'fio.cz': 'payment', 'airbank.cz': 'payment', 'hdfcbank.net': 'payment', 'icicibank.com': 'payment', 'sbi.co.in': 'payment',
    'linkedin.com': 'social', 'facebookmail.com': 'social', 'instagram.com': 'social', 'x.com': 'social', 'pinterest.com': 'social',
    'accounts.google.com': 'security'
  });

  const header = (msg, n) => (msg?.payload?.headers || []).find((h) => String(h.name).toLowerCase() === n.toLowerCase())?.value || '';
  function senderDomain(from) {
    const m = /<([^>]+)>/.exec(from || '') || /([^\s<>"]+@[^\s<>"]+)/.exec(from || '');
    const email = (m ? m[1] : from || '').trim().toLowerCase();
    const host = email.split('@')[1] || '';
    return host.replace(/^(?:mail|email|e|info|news|noreply|no-reply|notifications?|updates?|em|m|mg|send|bounce)\d*\./, '');
  }
  /** Registrable-ish base (a.b.example.co.uk → example.co.uk; mail.booking.com → booking.com). */
  function baseDomain(host) {
    const parts = String(host || '').split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const sl = parts.slice(-2).join('.');
    return /^(?:co|com|org|net|gov|ac)\.[a-z]{2}$/.test(sl) ? parts.slice(-3).join('.') : sl;
  }

  /** Cheap signals from subject + snippet. */
  function signals(subject, snippet, contentType) {
    const t = `${subject || ''}\n${snippet || ''}`;
    const s = { attachment: /multipart\/mixed/i.test(contentType || '') };
    Object.keys(P).forEach((k) => { s[k] = P[k].test(t); });
    s.money = s.amount || s.bill || s.payment || s.refund || s.invoiceNo;
    s.booking = s.pnr || s.travel || s.food || (s.pnrCode && /book|reserv|rezerv|ticket|pnr|flight|let/i.test(t));
    s.transactional = s.money || s.booking || s.receipt || s.subscription;
    // in bulk mail (Promotions tab / List-Unsubscribe) travel words and prices are normal marketing; only real
    // transaction evidence counts there
    s.strongTx = !!(s.invoiceNo || s.pnr || s.bill || s.payment || s.refund || s.receipt || (s.subscription && !s.promo));
    return s;
  }

  function keywordRule(s) {
    // Ordered by specificity; each returns a category with a confidence that reflects how much evidence we have.
    const conf = (base) => Math.min(0.95, base + (s.amount ? 0.07 : 0) + (s.date ? 0.03 : 0) + (s.invoiceNo || s.pnr ? 0.05 : 0));
    if (s.security) return { category: 'security', confidence: 0.88, reason: 'keyword: security / one-time code' };
    if (s.refund) return { category: 'refund', confidence: conf(0.74), reason: 'keyword: refund' };
    if (s.food) return { category: 'food', confidence: conf(0.72), reason: 'keyword: food order / reservation' };
    if (s.travel && (s.pnr || s.pnrCode || s.date)) return { category: 'travel', confidence: conf(0.75), reason: 'keyword: travel + reference/date' };
    if (s.bill) return { category: 'bill', confidence: conf(0.68), reason: 'keyword: bill / due' };
    if (s.subscription && !s.promo) return { category: 'subscription', confidence: conf(0.66), reason: 'keyword: subscription / renewal' };
    if (s.receipt && s.invoiceNo) return { category: 'receipt', confidence: conf(0.66), reason: 'keyword: order / receipt + number' };
    if (s.payment) return { category: 'payment', confidence: conf(0.66), reason: 'keyword: payment / transaction' };
    if (s.receipt) return { category: 'receipt', confidence: conf(0.64), reason: 'keyword: receipt / order' };
    if (s.travel) return { category: 'travel', confidence: 0.6, reason: 'keyword: travel' };
    if (s.document) return { category: 'document', confidence: s.attachment ? 0.8 : 0.62, reason: 'keyword: document' + (s.attachment ? ' + attachment' : '') };
    if (s.promo) return { category: 'promotion', confidence: s.amount ? 0.6 : 0.7, reason: 'keyword: offer / discount' };
    if (s.newsletter) return { category: 'newsletter', confidence: 0.68, reason: 'keyword: newsletter' };
    return null;
  }

  /**
   * Stage B. meta = Gmail metadata message. ctx: { domainCategory (sync lookup result or null), searchHits:Set(category), cfg }
   * Returns { category, confidence, reason, stage, trace[], needBody, escalated, signals }.
   */
  function stageB(meta, ctx) {
    const c = ctx || {}, cfg = c.cfg || {};
    const high = cfg.highConfidence ?? 0.85, low = cfg.lowConfidence ?? 0.55;
    const labels = meta.labelIds || [];
    const subject = header(meta, 'Subject'), from = header(meta, 'From'), lu = header(meta, 'List-Unsubscribe');
    const s = signals(subject, meta.snippet, header(meta, 'Content-Type') || meta.payload?.mimeType);
    const trace = [];
    const finish = (r, stage) => {
      const out = Object.assign({ stage, trace, signals: s }, r);
      // content searches (words in the message) count as evidence; sender-only / safety-net matches do not
      const search = c.searchHits && c.searchHits.size ? [...c.searchHits].filter((x) => x !== 'sender' && x !== 'net') : [];
      // Unfamiliar or low-value classification but money/date/booking evidence → escalate, never discard.
      const bulk = labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL') || labels.includes('CATEGORY_FORUMS') || !!lu;
      // V2: a Gmail category is never proof of unimportance — a targeted search hit also escalates bulk-category mail
      out.escalated = !HIGH_VALUE.has(out.category) && out.category !== 'security' && (bulk ? (s.strongTx || search.length > 0) : (s.transactional || search.length > 0));
      if (out.escalated) { trace.push({ rule: 'escalate', reason: search.length ? 'mailbox search matched ' + search.join('/') : 'money/date/booking pattern in snippet' }); }
      out.needBody = HIGH_VALUE.has(out.category) || out.escalated || (out.confidence < low && s.date && s.amount);
      return out;
    };
    // 1. Gmail system categories (a prior, not a verdict: when a targeted search matched, they cannot decide alone)
    const searched = !!(c.searchHits && [...c.searchHits].some((x) => x !== 'sender' && x !== 'net'));
    const capIfSearched = (r) => { if (searched) r.confidence = Math.min(r.confidence, 0.6); return r; };
    if (labels.includes('CATEGORY_SOCIAL')) { const r = capIfSearched({ category: 'social', confidence: s.transactional ? 0.6 : 0.9, reason: 'Gmail category: Social' }); trace.push(r); if (r.confidence >= high) return finish(r, 'gmail-category'); }
    if (labels.includes('CATEGORY_FORUMS')) { const r = capIfSearched({ category: 'newsletter', confidence: s.transactional ? 0.6 : 0.88, reason: 'Gmail category: Forums' }); trace.push(r); if (r.confidence >= high) return finish(r, 'gmail-category'); }
    if (labels.includes('CATEGORY_PROMOTIONS')) { const r = capIfSearched({ category: 'promotion', confidence: s.strongTx ? 0.55 : (s.promo ? 0.92 : 0.86), reason: 'Gmail category: Promotions' }); trace.push(r); if (r.confidence >= high) return finish(r, 'gmail-category'); }
    // 2. List-Unsubscribe → bulk mail (newsletter / promotion)
    if (lu) {
      const r = s.strongTx ? { category: 'newsletter', confidence: 0.5, reason: 'List-Unsubscribe, but transactional words' }
        : { category: s.promo ? 'promotion' : 'newsletter', confidence: s.promo ? 0.88 : 0.86, reason: 'List-Unsubscribe header' };
      trace.push(r); if (r.confidence >= high) return finish(r, 'list-unsubscribe');
    }
    // 3. Sender-domain cache (user choice > learned > seed)
    const dom = baseDomain(senderDomain(from));
    const dc = c.domainCategory || (SEED_DOMAINS[dom] ? { category: SEED_DOMAINS[dom], confidence: 0.8, source: 'seed' } : null);
    if (dc) {
      let conf = dc.confidence;
      if (LOW_VALUE.has(dc.category) && s.transactional) conf = Math.min(conf, 0.6);
      const bulk = labels.includes('CATEGORY_PROMOTIONS') || !!lu;
      if (HIGH_VALUE.has(dc.category) && bulk && !s.strongTx) conf = Math.min(conf, 0.6); // marketing from a travel/food brand
      const r = { category: dc.category, confidence: conf, reason: `sender domain ${dom} → ${dc.category} (${dc.source})` };
      trace.push(r); if (r.confidence >= high) return finish(r, 'domain-cache');
    }
    // 4. Keywords + regex on subject and snippet
    const k = keywordRule(s);
    const searchCat = c.searchHits && c.searchHits.size ? ([...c.searchHits].find((x) => CATEGORIES.includes(x)) || null) : null;
    if (k && dc && k.category !== dc.category) {
      // the sender's domain says what kind of company it is; refund / promotion / security words say what THIS email is
      const bulk = labels.includes('CATEGORY_PROMOTIONS') || !!lu;
      if (k.category === 'refund' || k.category === 'security' || (k.category === 'promotion' && bulk && !s.pnr && !s.invoiceNo)) k.confidence = Math.max(k.confidence, Math.min(0.95, (dc.confidence || 0.8) + 0.05));
    }
    if (k) {
      // agreement with an earlier weak rule or the mailbox search raises confidence
      if (trace.some((t) => t.category === k.category) || searchCat === k.category) k.confidence = Math.min(0.95, k.confidence + 0.1);
      trace.push(k);
      if (k.confidence >= high) return finish(k, 'keywords');
    }
    // nothing reached the threshold: take the strongest candidate (keywords outrank weak labels for high-value mail)
    const cands = trace.slice().sort((a, b2) => b2.confidence - a.confidence);
    let best = cands[0];
    if (k && HIGH_VALUE.has(k.category) && best !== k && !HIGH_VALUE.has(best?.category) && k.confidence >= (best?.confidence || 0) - 0.1) best = k;
    if (!best && searchCat) best = { category: searchCat, confidence: 0.6, reason: 'mailbox search match only' };
    if (!best) best = { category: labels.includes('CATEGORY_UPDATES') ? 'other' : 'personal', confidence: 0.5, reason: 'no rule matched' };
    return finish(best, best === k ? 'keywords' : (cands[0] ? cands[0] === best ? 'best-effort' : 'keywords' : 'fallback'));
  }

  // ---------- body helpers ----------
  function b64d(s) {
    if (!s) return '';
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    try {
      if (typeof Buffer !== 'undefined') return Buffer.from(t, 'base64').toString('utf8');
      const bin = atob(t); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch { return ''; }
  }
  function walk(part, out) {
    if (!part) return out;
    const mt = String(part.mimeType || '').toLowerCase();
    if (part.filename && part.body?.attachmentId) out.attachments.push({ name: part.filename, mimeType: mt, size: part.body.size || 0, attachmentId: part.body.attachmentId });
    else if (mt === 'text/plain' && part.body?.data) out.text.push(b64d(part.body.data));
    else if (mt === 'text/html' && part.body?.data) out.html.push(b64d(part.body.data));
    (part.parts || []).forEach((p) => walk(p, out));
    return out;
  }
  function bodyOf(msg) {
    const out = walk(msg?.payload, { text: [], html: [], attachments: [] });
    if (!out.text.length && !out.html.length && msg?.payload?.body?.data) out.text.push(b64d(msg.payload.body.data));
    return { text: out.text.join('\n'), html: out.html.join('\n'), attachments: out.attachments };
  }
  const htmlToText = (h) => String(h || '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

  /** FNV-1a 64-bit (as two 32-bit halves) — change detection only, not security. */
  function hash(str) {
    let h1 = 0x811c9dc5, h2 = 0x050c5d1f;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ (c + i), 16777619) >>> 0; }
    return 'f' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  // ---------- Stage C: structured data ----------
  const LD_TYPES = { FlightReservation: 'travel', TrainReservation: 'travel', BusReservation: 'travel', LodgingReservation: 'travel', RentalCarReservation: 'travel', EventReservation: 'travel', FoodEstablishmentReservation: 'food', Order: 'receipt', Invoice: 'bill', ParcelDelivery: 'receipt' };
  const REQUIRED = {
    FlightReservation: ['reservationNumber', 'departureTime'], TrainReservation: ['reservationNumber', 'departureTime'], BusReservation: ['reservationNumber', 'departureTime'],
    LodgingReservation: ['reservationNumber', 'checkinTime'], RentalCarReservation: ['reservationNumber', 'pickupTime'], EventReservation: ['reservationNumber', 'startDate'],
    FoodEstablishmentReservation: ['startTime'], Order: ['orderNumber'], Invoice: ['totalPaymentDue'], ParcelDelivery: ['trackingNumber']
  };
  function flattenLd(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, out)); return out; }
    if (node['@graph']) flattenLd(node['@graph'], out);
    const t = [].concat(node['@type'] || []).map(String).find((x) => LD_TYPES[x]);
    if (t) out.push({ type: t, node });
    return out;
  }
  function ldFields(type, n) {
    const g = (...ks) => { for (const k of ks) { const v = k.split('.').reduce((o, kk) => (o == null ? o : o[kk]), n); if (v != null && v !== '') return typeof v === 'object' ? (v.name || v['@id'] || v.value || JSON.stringify(v)) : String(v); } return null; };
    const f = { reservationNumber: g('reservationNumber', 'confirmationNumber'), orderNumber: g('orderNumber'), merchant: g('provider.name', 'seller.name', 'broker.name', 'reservationFor.provider.name', 'reservationFor.name'), status: g('reservationStatus', 'orderStatus', 'paymentStatus') };
    if (/Flight|Train|Bus/.test(type)) Object.assign(f, { departureTime: g('reservationFor.departureTime'), arrivalTime: g('reservationFor.arrivalTime'), from: g('reservationFor.departureAirport.iataCode', 'reservationFor.departureStation.name', 'reservationFor.departureBusStop.name', 'reservationFor.departureAirport.name'), to: g('reservationFor.arrivalAirport.iataCode', 'reservationFor.arrivalStation.name', 'reservationFor.arrivalBusStop.name', 'reservationFor.arrivalAirport.name'), number: g('reservationFor.flightNumber', 'reservationFor.trainNumber', 'reservationFor.busNumber') });
    if (type === 'LodgingReservation') Object.assign(f, { checkinTime: g('checkinTime', 'checkinDate'), checkoutTime: g('checkoutTime', 'checkoutDate'), place: g('reservationFor.name') });
    if (type === 'RentalCarReservation') Object.assign(f, { pickupTime: g('pickupTime') });
    if (type === 'EventReservation') Object.assign(f, { startDate: g('reservationFor.startDate') });
    if (type === 'FoodEstablishmentReservation') Object.assign(f, { startTime: g('startTime'), place: g('reservationFor.name'), partySize: g('partySize') });
    if (type === 'Invoice') Object.assign(f, { totalPaymentDue: g('totalPaymentDue.price', 'totalPaymentDue.value', 'totalPaymentDue'), currency: g('totalPaymentDue.priceCurrency', 'totalPaymentDue.currency'), paymentDueDate: g('paymentDueDate', 'paymentDue'), accountId: g('accountId') });
    if (type === 'Order') Object.assign(f, { price: g('price', 'acceptedOffer.price', 'priceSpecification.price'), currency: g('priceCurrency', 'acceptedOffer.priceCurrency', 'priceSpecification.priceCurrency') });
    if (type === 'ParcelDelivery') Object.assign(f, { trackingNumber: g('trackingNumber'), expectedArrival: g('expectedArrivalUntil', 'expectedArrivalFrom') });
    Object.keys(f).forEach((k) => { if (f[k] == null) delete f[k]; });
    return f;
  }
  function parseStructured(html) {
    const out = [];
    if (!html) return out;
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) { try { flattenLd(JSON.parse(m[1].trim()), []).forEach((x) => out.push({ type: x.type, fields: ldFields(x.type, x.node), source: 'jsonld' })); } catch { /* invalid JSON-LD is ignored, never fatal */ } }
    // microdata: itemtype + itemprop (flat; nested scopes are approximated by document order)
    const it = /itemtype=["']https?:\/\/schema\.org\/(\w+)["']/gi;
    let t;
    while ((t = it.exec(html))) {
      const type = t[1]; if (!LD_TYPES[type]) continue;
      const seg = html.slice(t.index, t.index + 6000);
      const node = {};
      const pr = /itemprop=["']([\w]+)["'][^>]*?(?:content|datetime|href)=["']([^"']+)["']|itemprop=["']([\w]+)["'][^>]*>([^<]{1,120})</gi;
      let q; while ((q = pr.exec(seg))) { const k = q[1] || q[3], v = (q[2] || q[4] || '').trim(); if (k && v && node[k] == null) node[k] = v; }
      // map common flat props to the nested names ldFields expects
      const nested = { reservationNumber: node.reservationNumber || node.confirmationNumber, orderNumber: node.orderNumber, reservationFor: { departureTime: node.departureTime, arrivalTime: node.arrivalTime, flightNumber: node.flightNumber, trainNumber: node.trainNumber, name: node.name, startDate: node.startDate, departureAirport: { iataCode: node.departureAirport }, arrivalAirport: { iataCode: node.arrivalAirport } }, checkinTime: node.checkinTime || node.checkinDate, checkoutTime: node.checkoutTime || node.checkoutDate, startTime: node.startTime, totalPaymentDue: node.totalPaymentDue || node.price, paymentDueDate: node.paymentDueDate || node.paymentDue, price: node.price, priceCurrency: node.priceCurrency, trackingNumber: node.trackingNumber, provider: { name: node.provider } };
      out.push({ type, fields: ldFields(type, nested), source: 'microdata' });
    }
    return out;
  }
  function structuredComplete(s) { const req = REQUIRED[s.type] || []; return req.every((k) => s.fields[k]); }

  // ---------- Stage C: regex extraction ----------
  const CUR = { '€': 'EUR', '$': 'USD', '£': 'GBP', '₹': 'INR', 'Kč': 'CZK', 'kč': 'CZK', 'CZK': 'CZK', 'EUR': 'EUR', 'USD': 'USD', 'INR': 'INR', 'GBP': 'GBP', 'Rs': 'INR', 'Rs.': 'INR' };
  function num(s) {
    let t = String(s).replace(/\s/g, '');
    if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,(?=\d{3}(\D|$))/g, '').replace(/,/g, '');
    const v = parseFloat(t); return isFinite(v) ? v : null;
  }
  function extractAmount(text) {
    const res = [];
    const re1 = /(₹|€|\$|£|Rs\.?|INR|CZK|EUR|USD|GBP)\s?(\d{1,3}(?:[ ,.]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;
    const re2 = /(\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(Kč|kč|CZK|EUR|USD|INR|GBP|€|₹)/g;
    let m;
    while ((m = re1.exec(text))) res.push({ value: num(m[2]), currency: CUR[m[1]] || m[1], at: m.index });
    while ((m = re2.exec(text))) res.push({ value: num(m[1]), currency: CUR[m[2]] || m[2], at: m.index });
    const good = res.filter((r) => r.value != null && r.value > 0);
    if (!good.length) return null;
    // prefer an amount near total / due / amount words
    const near = good.map((r) => ({ r, s: /total|amount|due|celkem|k úhradě|částka|summe|betrag|कुल|refund|paid|zaplaceno/i.test(text.slice(Math.max(0, r.at - 40), r.at)) ? 1 : 0 }));
    near.sort((a, b2) => b2.s - a.s || a.r.at - b2.r.at);
    const best = near[0].r;
    return { value: best.value, currency: best.currency, confidence: near[0].s ? 0.85 : 0.65 };
  }
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, led: 1, úno: 2, bře: 3, dub: 4, kvě: 5, čvn: 6, čvc: 7, srp: 8, zář: 9, říj: 10, lis: 11, pro: 12 };
  function extractDueDate(text) {
    const m = /(?:due(?: date| by| on)?|pay by|payable by|splatnost|datum splatnosti|splatné do|zahlbar bis|fällig(?: am| bis)?|देय तिथि)\s*[:\-]?\s*([^\n]{3,40})/i.exec(text);
    if (!m) return null;
    const s = m[1];
    let d = /(\d{4})-(\d{2})-(\d{2})/.exec(s); if (d) return { date: `${d[1]}-${d[2]}-${d[3]}`, raw: d[0], confidence: 0.9 };
    d = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/.exec(s); if (d) return { date: `${d[3]}-${String(d[2]).padStart(2, '0')}-${String(d[1]).padStart(2, '0')}`, raw: d[0], confidence: 0.88 };
    d = /(\d{1,2})\s+([a-zá-ž]{3,})\.?\s+(\d{4})/i.exec(s); if (d && MON[d[2].slice(0, 3).toLowerCase()]) return { date: `${d[3]}-${String(MON[d[2].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${String(d[1]).padStart(2, '0')}`, raw: d[0], confidence: 0.86 };
    d = /([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s); if (d && MON[d[1].slice(0, 3).toLowerCase()]) return { date: `${d[3]}-${String(MON[d[1].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`, raw: d[0], confidence: 0.86 };
    d = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (d) return { date: null, raw: d[0], confidence: 0.3, ambiguous: true }; // dd/mm vs mm/dd — never guessed
    return null;
  }
  function extractRef(text) {
    const m = /(?:booking (?:reference|ref|code|number)|confirmation (?:number|code|no\.?)|reservation (?:number|code)|pnr|číslo rezervace|kód rezervace|buchungsnummer|order (?:number|no\.?|#)|invoice (?:number|no\.?|#)|číslo (?:objednávky|faktury)|variabilní symbol)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,19})/i.exec(text);
    return m ? m[1].toUpperCase() : null;
  }
  function merchantOf(from) { const name = String(from || '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim(); return name || baseDomain(senderDomain(from)) || null; }

  /**
   * Stage C. full = Gmail full message; stageBResult from stageB.
   * Returns { category, confidence, reason, structured[], facts{}, bodyHash, attachments[], complete, missing[] }.
   */
  function stageC(full, b, cfg) {
    const body = bodyOf(full);
    const text = (body.text || htmlToText(body.html)).slice(0, 20000);
    const structured = parseStructured(body.html);
    const facts = { merchant: merchantOf(header(full, 'From')) };
    let category = b.category, confidence = b.confidence, reason = b.reason, source = 'rules';
    const st = structured.find(structuredComplete) || structured[0];
    if (st) {
      category = LD_TYPES[st.type]; confidence = structuredComplete(st) ? 0.97 : Math.max(confidence, 0.8); reason = `schema.org ${st.type} (${st.source})`; source = st.source;
      Object.assign(facts, st.fields, { schemaType: st.type });
    }
    const amount = extractAmount(`${header(full, 'Subject')}\n${text}`);
    const due = extractDueDate(text);
    const ref = extractRef(`${header(full, 'Subject')}\n${text}`);
    if (amount && facts.totalPaymentDue == null && facts.price == null) facts.amount = amount;
    if (due) facts.dueDate = due;
    if (ref && !facts.reservationNumber && !facts.orderNumber) facts.reference = ref;
    // Re-check category with the full text when no structured data decided it
    if (!st) {
      const s = signals(header(full, 'Subject'), text.slice(0, 1500), header(full, 'Content-Type') || full?.payload?.mimeType);
      const k = keywordRule(s);
      const bulk = (full.labelIds || []).includes('CATEGORY_PROMOTIONS') || !!header(full, 'List-Unsubscribe');
      const typeWord = k && (k.category === 'refund' || k.category === 'security' || (k.category === 'promotion' && bulk && !s.pnr && !s.invoiceNo));
      if (k && (k.confidence > confidence || typeWord || (b.escalated && HIGH_VALUE.has(k.category)))) { category = k.category; confidence = Math.max(k.confidence, confidence); reason = k.reason + ' (body)'; }
      if (HIGH_VALUE.has(category) && (facts.amount || facts.reference || facts.dueDate)) confidence = Math.min(0.95, confidence + 0.08);
      // V2: an order confirmation that Gmail filed as marketing — amount + order/reference number + confirmation words → receipt
      const orderNo = /(order|objedn\p{L}*|bestellung|receipt|účtenka)\s*(?:no\.?|number|nr\.?|č\.|#)?\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{3,}/iu.test(text.slice(0, 1500));
      if ((category === 'promotion' || category === 'newsletter') && facts.amount && (facts.reference || orderNo) && /(order|objedn|bestell|receipt|účtenk|confirm|potvrz|bestätig|total|celkem|gesamt)/i.test(text.slice(0, 1500))) {
        category = 'receipt'; confidence = 0.78; reason = 'order number + amount in a marketing-category email (body)';
      }
    }
    const need = { bill: ['amount'], payment: ['amount'], refund: ['amount'], travel: ['reference', 'date'], food: ['merchant'], subscription: ['amount'], receipt: ['amount'] }[category] || [];
    const missing = need.filter((k) => {
      if (k === 'amount') return !(facts.amount || facts.totalPaymentDue || facts.price);
      if (k === 'reference') return !(facts.reference || facts.reservationNumber || facts.orderNumber);
      if (k === 'date') return !(facts.departureTime || facts.checkinTime || facts.startTime || facts.startDate || facts.pickupTime || P.date.test(text));
      return !facts[k];
    });
    return { category, confidence, reason, source, structured, facts, missing, complete: !missing.length, bodyHash: hash(text), textLength: text.length, attachments: body.attachments, cleanText: text };
  }

  const api = { CATEGORIES, HIGH_VALUE, LOW_VALUE, SEED_DOMAINS, P, signals, stageB, stageC, parseStructured, structuredComplete, extractAmount, extractDueDate, extractRef, bodyOf, htmlToText, hash, header, senderDomain, baseDomain };
  root.DaylightGmailRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
