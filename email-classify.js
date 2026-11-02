/**
 * Daylight email categorisation — classify-first pipeline.
 * Every fetched message gets one primary category before UI display.
 * Categories: subscription | payment | bill | ticket | shopping | other
 */
(function (root) {
  const CATEGORIES = Object.freeze(['subscription', 'payment', 'bill', 'ticket', 'shopping', 'other']);

  const SUB_BRANDS = {
    netflix: 'netflix.com', spotify: 'spotify.com', adobe: 'adobe.com', disney: 'disneyplus.com',
    hbo: 'hbomax.com', skyshowtime: 'skyshowtime.com', youtube: 'youtube.com',
    openai: 'openai.com', chatgpt: 'openai.com', anthropic: 'anthropic.com', claude: 'anthropic.com',
    'x.ai': 'x.ai', grok: 'x.ai', cursor: 'cursor.com', github: 'github.com',
    notion: 'notion.so', figma: 'figma.com', dropbox: 'dropbox.com', icloud: 'icloud.com',
    microsoft: 'microsoft.com', apple: 'apple.com', google: 'google.com'
  };

  const BILL_BRANDS = {
    cez: 'cez.cz', innogy: 'innogy.com', pre: 'pre.cz', vodafone: 'vodafone.com',
    o2: 'o2.com', 't-mobile': 't-mobile.com', upc: 'upc.cz', airbank: 'airbank.cz',
    csob: 'csob.cz', moneta: 'moneta.cz', fio: 'fio.cz', kb: 'kb.cz'
  };

  const SHOP_BRANDS = {
    temu: 'temu.com', alza: 'alza.cz', zalando: 'zalando.com', aboutyou: 'aboutyou.com',
    shein: 'shein.com', amazon: 'amazon.com', ikea: 'ikea.com', notino: 'notino.com',
    mediamarkt: 'mediamarkt.de', lidl: 'lidl.com', tesco: 'tesco.com', ebay: 'ebay.com',
    allegro: 'allegro.pl', etsy: 'etsy.com', aliexpress: 'aliexpress.com'
  };

  const TICKET_BRANDS = {
    bahn: 'bahn.de', lufthansa: 'lufthansa.com', ryanair: 'ryanair.com', easyjet: 'easyjet.com',
    booking: 'booking.com', airbnb: 'airbnb.com', 'ceskedrahy': 'cd.cz', cd: 'cd.cz',
    eurostar: 'eurostar.com', emirates: 'emirates.com', klm: 'klm.com', wizz: 'wizzair.com'
  };

  const RX = {
    subscription: /\b(subscription|subscribed|membership|auto-?renew|renew(al|s|ing)?|recurring|premium plan|pro plan|free trial|předplatn[éeé]|členstv[íi])\b/i,
    subCancel: /\b(cancel+ed|cancellation|unsubscribed|membership ended|subscription (ended|cancelled))\b/i,
    subPrice: /\b(price (increase|change|update)|new price|billing rate)\b/i,
    payment: /\b(you paid|payment (received|confirm|successful|completed)|charged|receipt for|paid via|paypal|stripe|apple pay|google pay|úhrada|platba (proběhla|přijata))\b/i,
    payFail: /\b(payment (failed|declined|unsuccessful)|card declined|insufficient funds)\b/i,
    refund: /\b(refund(ed)?|reimbursement|credit issued|vrácen[íi] peněz)\b/i,
    bill: /\b(invoice|bill(ing)?|statement|utilities?|electric|electricity|gas bill|water bill|internet bill|phone bill|rent|tuition|insurance|policy premium|faktura|vyúčtování|inkaso|složenka|předpis|nájem|školn[éeé])\b/i,
    billDue: /\b(payment due|amount due|pay by|due by|past due|unpaid|outstanding|splatnost|zapla[tť]te)\b/i,
    billPaid: /\b(invoice paid|bill paid|payment for invoice|thank you for (your )?payment)\b/i,
    ticket: /\b(boarding[\s-]?pass|e-?ticket|itinerary|reservation confirmed|booking confirmation|flight|train ticket|bahn|rail|eurostar|hotel (booking|reservation)|check-?in|pnr|confirmation code|gate\s?[A-Z]?\d+)\b/i,
    shopping: /\b(order (confirm|confirmed|shipped|delivered)|your (order|purchase)|shipped|out for delivery|tracking|return(ed)?|package|objednávka|doručeno|odesláno)\b/i,
    oneTimeBuy: /\b(order|purchase|bought|receipt from|app store|play store)\b/i
  };

  function parseFrom(v) {
    const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>/.exec(v || '');
    return m
      ? { name: (m[1].trim() || m[2]), email: m[2].toLowerCase() }
      : { name: String(v || '').trim(), email: String(v || '').trim().toLowerCase() };
  }

  function header(headers, name) {
    const h = (headers || []).find(x => (x.name || '').toLowerCase() === name.toLowerCase());
    return h?.value || '';
  }

  function brandDomainFromEmail(email) {
    let host = String(email || '').toLowerCase().split('@').pop() || '';
    if (!host.includes('.')) return '';
    host = host
      .replace(/^e?mail\./, '')
      .replace(/^no-?reply\./, '')
      .replace(/^noreply\./, '')
      .replace(/^billing\./, '')
      .replace(/^receipts?\./, '')
      .replace(/^service\./, '')
      .replace(/^news(letter)?\./, '');
    const parts = host.split('.');
    if (parts.length > 2) {
      const last2 = parts.slice(-2).join('.');
      const last3 = parts.slice(-3).join('.');
      if (/\.(co|com|org|net|cz|de|uk|io|app|so)\.[a-z]{2}$/i.test(host)) return last3;
      return last2;
    }
    return host;
  }

  function matchBrandMap(map, email, text) {
    const host = brandDomainFromEmail(email);
    const blob = `${host} ${text}`.toLowerCase();
    for (const [key, dom] of Object.entries(map)) {
      if (host.includes(key) || host === dom || blob.includes(key) || blob.includes(dom)) {
        return { key, domain: dom };
      }
    }
    return null;
  }

  function extractAmount(text) {
    const m = String(text || '').match(/(?:€|EUR|USD|\$|Kč|CZK|GBP|£)\s?[\d\s.,]+|\d[\d\s.,]*\s?(?:€|EUR|USD|\$|Kč|CZK|GBP|£)/i);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }

  function collectAttachments(payload, out = []) {
    if (!payload) return out;
    if (payload.filename) out.push({ filename: payload.filename, mimeType: payload.mimeType || '' });
    (payload.parts || []).forEach(p => collectAttachments(p, out));
    return out;
  }

  function decodeBodySnippet(payload) {
    const decode = (d) => {
      try {
        const bin = atob(String(d).replace(/-/g, '+').replace(/_/g, '/'));
        try { return decodeURIComponent(escape(bin)); } catch { return bin; }
      } catch { return ''; }
    };
    const walk = (p) => {
      if (!p) return '';
      if (p.mimeType === 'text/plain' && p.body?.data) return decode(p.body.data);
      if (p.parts) {
        for (const x of p.parts) {
          const t = walk(x);
          if (t) return t;
        }
      }
      if (p.mimeType === 'text/html' && p.body?.data) {
        return decode(p.body.data)
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      return '';
    };
    return (walk(payload) || '').trim().slice(0, 2000);
  }

  function scoreHit(rx, text, weight) {
    return rx.test(text) ? weight : 0;
  }

  /**
   * Normalize Gmail or Outlook-like message into a classify input.
   */
  function normalizeMail(raw) {
    if (!raw) return null;
    // Already normalized Daylight shape
    if (raw._normalized) return raw;
    const h = raw.payload?.headers || raw.headers || [];
    const from = parseFrom(header(h, 'From') || raw.from || '');
    const subject = header(h, 'Subject') || raw.subject || '(No subject)';
    const dateRaw = header(h, 'Date') || raw.receivedDateTime || raw.internalDate;
    const when = dateRaw
      ? new Date(typeof dateRaw === 'number' || /^\d+$/.test(String(dateRaw)) ? Number(dateRaw) : dateRaw)
      : new Date();
    const attachments = collectAttachments(raw.payload);
    const body = decodeBodySnippet(raw.payload) || raw.bodyPreview || raw.body || '';
    const snippet = String(raw.snippet || body || '').slice(0, 400);
    const labels = raw.labelIds || raw.categories || [];
    return {
      _normalized: true,
      id: raw.id || raw.mailId,
      threadId: raw.threadId || raw.conversationId || raw.id,
      fromName: from.name,
      fromEmail: from.email,
      subject,
      snippet,
      body,
      labels,
      attachments,
      whenMs: isNaN(when.getTime()) ? Date.now() : when.getTime(),
      href: raw.htmlLink || raw.webLink || '',
      raw
    };
  }

  function classifyScores(mail) {
    const m = normalizeMail(mail);
    if (!m) return null;
    const text = `${m.subject}\n${m.snippet}\n${m.body}\n${m.fromName}\n${m.fromEmail}\n${m.attachments.map(a => a.filename).join(' ')}`;
    const labels = (m.labels || []).map(String);
    const scores = { subscription: 0, payment: 0, bill: 0, ticket: 0, shopping: 0, other: 0 };
    const reasons = [];

    const subBrand = matchBrandMap(SUB_BRANDS, m.fromEmail, text);
    const billBrand = matchBrandMap(BILL_BRANDS, m.fromEmail, text);
    const shopBrand = matchBrandMap(SHOP_BRANDS, m.fromEmail, text);
    const ticketBrand = matchBrandMap(TICKET_BRANDS, m.fromEmail, text);

    // Gmail system categories
    if (labels.includes('CATEGORY_PURCHASES')) {
      scores.shopping += 2.2;
      scores.payment += 0.8;
      reasons.push('gmail:purchases');
    }
    if (labels.includes('CATEGORY_UPDATES')) {
      scores.subscription += 0.4;
      scores.bill += 0.3;
    }

    // Brand priors
    if (subBrand) {
      scores.subscription += RX.subscription.test(text) || RX.subCancel.test(text) || RX.subPrice.test(text) ? 3.5 : 1.2;
      reasons.push('brand:subscription:' + subBrand.key);
      // App Store / one-time on Apple/Google often payment not subscription
      if (RX.oneTimeBuy.test(text) && !RX.subscription.test(text)) {
        scores.subscription -= 2;
        scores.payment += 2.5;
        reasons.push('onetime-override');
      }
    }
    if (billBrand) {
      scores.bill += 3.2;
      reasons.push('brand:bill:' + billBrand.key);
    }
    if (shopBrand) {
      scores.shopping += 3.0;
      reasons.push('brand:shop:' + shopBrand.key);
      if (RX.payment.test(text) || RX.refund.test(text)) scores.payment += 1.2;
    }
    if (ticketBrand) {
      scores.ticket += 3.4;
      reasons.push('brand:ticket:' + ticketBrand.key);
    }

    // Pattern scores
    scores.subscription += scoreHit(RX.subscription, text, 2.8) + scoreHit(RX.subCancel, text, 2.5) + scoreHit(RX.subPrice, text, 2.2);
    scores.payment += scoreHit(RX.payment, text, 2.6) + scoreHit(RX.payFail, text, 2.4) + scoreHit(RX.refund, text, 2.0);
    scores.bill += scoreHit(RX.bill, text, 2.8) + scoreHit(RX.billDue, text, 1.6) + scoreHit(RX.billPaid, text, 1.8);
    scores.ticket += scoreHit(RX.ticket, text, 3.0);
    scores.shopping += scoreHit(RX.shopping, text, 2.8);

    // Attachment cues
    const att = m.attachments.map(a => `${a.filename} ${a.mimeType}`).join(' ').toLowerCase();
    if (/\b(boarding|ticket|eticket|e-ticket|itinerary|buchung)\b/.test(att)) {
      scores.ticket += 2.5;
      reasons.push('attachment:ticket');
    }
    if (/\b(invoice|faktura|bill|statement)\b/.test(att)) {
      scores.bill += 2.0;
      reasons.push('attachment:invoice');
    }
    if (/\b(receipt|order)\b/.test(att)) {
      scores.payment += 1.2;
      scores.shopping += 1.0;
      reasons.push('attachment:receipt');
    }

    // Disambiguation: utility invoice vs payment receipt
    if (scores.bill >= 2 && RX.billPaid.test(text)) {
      scores.bill += 0.8;
      reasons.push('bill-status:paid');
    }
    // Recurring vs one-time
    if (RX.subscription.test(text) && RX.oneTimeBuy.test(text) && !subBrand) {
      scores.subscription += 0.5;
      scores.payment += 0.5;
    }
    if (shopBrand && RX.shopping.test(text)) {
      scores.shopping += 1.0;
      scores.subscription = Math.max(0, scores.subscription - 1.5);
    }

    // Personal / HR / generic → other baseline
    if (labels.includes('CATEGORY_PERSONAL') || labels.includes('CATEGORY_SOCIAL')) {
      scores.other += 1.5;
    }
    if (/\b(lab|meeting|interview|internship|sign|contract|agreement)\b/i.test(text) && scores.ticket < 2 && scores.bill < 2) {
      scores.other += 2.0;
      reasons.push('general-correspondence');
    }

    return { mail: m, scores, reasons, subBrand, billBrand, shopBrand, ticketBrand };
  }

  function pickCategory(scored) {
    const entries = CATEGORIES.filter(c => c !== 'other').map(c => [c, scored.scores[c] || 0]);
    entries.sort((a, b) => b[1] - a[1]);
    const [top, topScore] = entries[0];
    const second = entries[1]?.[1] || 0;
    if (topScore < 1.6) {
      return { category: 'other', confidence: Math.min(0.55, 0.25 + topScore * 0.1), needsReview: true };
    }
    const confidence = Math.min(0.98, 0.45 + topScore * 0.12 + Math.max(0, topScore - second) * 0.08);
    const needsReview = confidence < 0.62 || (topScore - second) < 0.7;
    return {
      category: needsReview && topScore < 2.2 ? 'other' : top,
      confidence,
      needsReview: needsReview || (needsReview && topScore < 2.2)
    };
  }

  function deriveStatus(category, text) {
    if (category === 'subscription') {
      if (RX.subCancel.test(text)) return 'cancelled';
      if (RX.subPrice.test(text)) return 'price_change';
      if (RX.subscription.test(text)) return 'renewal';
      return 'active';
    }
    if (category === 'payment') {
      if (RX.payFail.test(text)) return 'failed';
      if (RX.refund.test(text)) return 'refunded';
      return 'paid';
    }
    if (category === 'bill') {
      if (RX.billPaid.test(text)) return 'paid';
      if (RX.billDue.test(text) || RX.payFail.test(text)) return 'unpaid';
      return 'pending';
    }
    if (category === 'shopping') {
      if (/\bdelivered|doručeno\b/i.test(text)) return 'delivered';
      if (/\bshipped|odesláno|out for delivery|tracking\b/i.test(text)) return 'shipped';
      if (RX.refund.test(text) || /\breturn/i.test(text)) return 'returned';
      return 'ordered';
    }
    if (category === 'ticket') return 'confirmed';
    return null;
  }

  function recordKeyFor(category, mail, brandKey, domain) {
    const host = domain || brandDomainFromEmail(mail.fromEmail) || 'unknown';
    if (category === 'subscription') return `sub:${brandKey || host}`;
    if (category === 'bill') {
      const month = new Date(mail.whenMs).toISOString().slice(0, 7);
      return `bill:${brandKey || host}:${month}`;
    }
    if (category === 'ticket') return `ticket:${mail.threadId || mail.id}`;
    if (category === 'shopping') return `shop:${mail.threadId || mail.id}`;
    if (category === 'payment') return `pay:${mail.threadId || mail.id}`;
    return `other:${mail.id}`;
  }

  function classifyEmail(raw) {
    const scored = classifyScores(raw);
    if (!scored) return null;
    const { mail, scores, reasons, subBrand, billBrand, shopBrand, ticketBrand } = scored;
    const pick = pickCategory(scored);
    const text = `${mail.subject}\n${mail.snippet}\n${mail.body}`;
    // If forced to other due to low confidence but had a weak top, keep needsReview
    let category = pick.category;
    let confidence = pick.confidence;
    let needsReview = pick.needsReview;
    if (category === 'other' && pick.needsReview && scores.other < 1 && Math.max(...CATEGORIES.filter(c => c !== 'other').map(c => scores[c])) >= 1.6) {
      // keep original top category but flag review
      const top = CATEGORIES.filter(c => c !== 'other').sort((a, b) => scores[b] - scores[a])[0];
      category = top;
      needsReview = true;
      confidence = Math.min(confidence, 0.58);
      reasons.push('uncertain-keep-top');
    }

    const brand = subBrand || billBrand || shopBrand || ticketBrand;
    const domain = brand?.domain || brandDomainFromEmail(mail.fromEmail);
    const amount = extractAmount(text);
    const status = deriveStatus(category, text);
    const recordKey = recordKeyFor(category, mail, brand?.key, domain);
    const title = (mail.fromName || '').replace(/\s*(billing|noreply|no-?reply|receipts?|support|service)\s*/ig, ' ').replace(/\s+/g, ' ').trim()
      || domain?.split('.')[0]
      || 'Email';

    const privacyClass =
      category === 'bill' || category === 'payment' || category === 'subscription'
        ? 'financial'
        : (category === 'ticket' ? 'identity' : 'normal');

    return {
      id: mail.id,
      mailId: mail.id,
      threadId: mail.threadId,
      category,
      status,
      confidence,
      needsReview: !!needsReview,
      method: 'rule+content',
      reasons,
      scores,
      title,
      fromName: mail.fromName,
      fromEmail: mail.fromEmail,
      domain: domain || '',
      subject: mail.subject,
      snippet: mail.snippet,
      amount,
      statusLabel: status,
      recordKey,
      href: mail.href || (mail.threadId ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.threadId)}` : ''),
      whenMs: mail.whenMs,
      attachments: mail.attachments,
      labels: mail.labels,
      tag: ({
        subscription: 'Subscription',
        payment: 'Payment',
        bill: 'Bill',
        ticket: 'Ticket',
        shopping: 'Shopping',
        other: needsReview ? 'Needs review' : 'Other'
      })[category],
      kind: category === 'subscription' ? 'subscription'
        : category === 'payment' ? 'pending'
        : category === 'bill' ? 'bill'
        : category === 'shopping' ? 'shopping'
        : category === 'ticket' ? 'ticket'
        : 'other',
      privacyClass,
      urgent: status === 'unpaid' || status === 'failed' || /due|past due|payment due/i.test(text),
      received: status === 'paid' || status === 'delivered' || status === 'shipped',
      linkedRecordKey: recordKey
    };
  }

  /**
   * Classify a list and link renewals / bill payments to existing recordKeys.
   * Returns { all, byCategory, byMailId, byRecordKey }
   */
  function classifyAll(mails) {
    const all = [];
    const byMailId = Object.create(null);
    const byRecordKey = Object.create(null);
    const byCategory = {
      subscription: [], payment: [], bill: [], ticket: [], shopping: [], other: []
    };

    (mails || []).forEach(raw => {
      const item = classifyEmail(raw);
      if (!item || !item.mailId) return;
      if (byMailId[item.mailId]) return;
      byMailId[item.mailId] = item;
      all.push(item);
      const prev = byRecordKey[item.recordKey];
      if (prev) {
        item.linkedTo = prev.mailId;
        // Prefer newest for display ordering later; keep status progression
        if (item.category === 'subscription' && item.status === 'renewal') {
          prev.status = 'renewal';
          prev.linkedFrom = prev.linkedFrom || [];
          prev.linkedFrom.push(item.mailId);
        }
        if (item.category === 'bill' && item.status === 'paid' && prev.category === 'bill') {
          prev.status = 'paid';
          prev.received = true;
          item.updatesRecord = prev.mailId;
        }
      } else {
        byRecordKey[item.recordKey] = item;
      }
      byCategory[item.category]?.push(item);
    });

    // Prefer newest mail as the canonical record for each recordKey (renewals / bill updates)
    all.forEach(item => {
      const prev = byRecordKey[item.recordKey];
      if (!prev || (item.whenMs || 0) >= (prev.whenMs || 0)) {
        const linkedFrom = prev?.linkedFrom || item.linkedFrom || [];
        if (prev && prev.mailId !== item.mailId && !linkedFrom.includes(prev.mailId)) linkedFrom.push(prev.mailId);
        byRecordKey[item.recordKey] = item;
        if (linkedFrom.length) item.linkedFrom = linkedFrom;
      }
    });

    // Payment confirmations from a utility sender can mark the matching bill paid
    all.filter(i => i.category === 'payment' || (i.category === 'bill' && i.status === 'paid')).forEach(pay => {
      const host = (pay.domain || '').toLowerCase();
      const month = new Date(pay.whenMs || Date.now()).toISOString().slice(0, 7);
      Object.keys(byRecordKey).forEach(key => {
        if (!key.startsWith('bill:')) return;
        const bill = byRecordKey[key];
        if (!bill || bill.mailId === pay.mailId) return;
        const billMonth = key.split(':')[2] || '';
        const sameBrand = (bill.domain && host && bill.domain === host) ||
          (pay.fromEmail && bill.fromEmail && pay.fromEmail.split('@')[1] === bill.fromEmail.split('@')[1]);
        if (sameBrand && (!billMonth || billMonth === month || Math.abs((pay.whenMs || 0) - (bill.whenMs || 0)) < 45 * 86400000)) {
          bill.status = 'paid';
          bill.received = true;
          bill.urgent = false;
          pay.updatesRecord = bill.mailId;
          pay.linkedRecordKey = bill.recordKey;
        }
      });
    });

    const byWhen = (a, b) => (b.whenMs || 0) - (a.whenMs || 0);
    CATEGORIES.forEach(c => byCategory[c].sort(byWhen));
    all.sort(byWhen);

    return { all, byCategory, byMailId, byRecordKey };
  }

  function toInboxItem(c) {
    if (!c) return null;
    return {
      id: c.threadId || c.mailId,
      mailId: c.mailId,
      title: c.title,
      subject: c.subject,
      detail: c.snippet || c.subject,
      from: c.title,
      fromName: c.fromName,
      fromEmail: c.fromEmail,
      domain: c.domain,
      logo: c.domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=128` : '',
      meta: c.status && c.status !== 'active' ? String(c.status).replace(/_/g, ' ') : '',
      href: c.href,
      when: c.whenMs,
      whenMs: c.whenMs,
      kind: c.kind,
      category: c.category,
      tag: c.tag,
      urgent: !!c.urgent,
      amount: c.amount || '',
      color: '#6d7cff',
      received: !!c.received,
      snippet: c.snippet || '',
      needsReview: !!c.needsReview,
      confidence: c.confidence,
      recordKey: c.recordKey,
      status: c.status,
      _classified: true
    };
  }

  root.DaylightEmailClassify = {
    CATEGORIES,
    normalizeMail,
    classifyEmail,
    classifyAll,
    toInboxItem,
    brandDomainFromEmail
  };
})(typeof window !== 'undefined' ? window : globalThis);
