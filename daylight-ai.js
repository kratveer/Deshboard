/**
 * Daylight AI — central Gemini intelligence client.
 * All Gemini calls go through the Cloudflare Worker (/api/gemini/analyse).
 * The browser never sees GEMINI_API_KEY.
 *
 * Hybrid levels:
 *   L1 rules (email-classify.js) — always run first
 *   L2 Gemini — only when consent + enabled + value-add
 *   L3 validateExtraction — before any module write
 */
(function (root) {
  const LS = {
    consent: 'daylight-ai-consent',
    enabled: 'daylight-ai-enabled',
    accounts: 'daylight-ai-accounts',
    cache: 'daylight-ai-cache',
    usage: 'daylight-ai-usage',
    status: 'daylight-ai-status',
  };

  // Daylight canonical categories (compatible with inbox via INBOX_MAP)
  const PRIMARY_CATEGORIES = Object.freeze([
    'shopping', 'travel', 'finance', 'bills', 'subscriptions', 'work', 'meetings',
    'personal', 'social', 'education', 'health', 'documents', 'government',
    'delivery', 'security', 'promotions', 'newsletters', 'other'
  ]);

  // Canonical intents — category ≠ intent
  const INTENTS = Object.freeze([
    'order_placed', 'order_confirmed', 'order_shipped', 'delivery_scheduled', 'delivery_delayed', 'delivery_delivered',
    'booking_confirmed', 'booking_cancelled', 'booking_rescheduled', 'check_in_required',
    'payment_due', 'payment_completed', 'refund_issued',
    'subscription_started', 'subscription_renewal', 'subscription_cancelled',
    'ticket_issued', 'reminder', 'informational', 'promotional',
    // retained aliases accepted by normalizeIntent (also listed for prompt clarity)
    'order_confirmation', 'delivery_update', 'delivered', 'flight_booking', 'hotel_booking', 'train_booking',
    'cancellation', 'rescheduling', 'refund', 'invoice_received', 'marketing', 'appointment',
    'meeting_invitation', 'event_invitation', 'deadline', 'action_required'
  ]);

  const INTENT_ALIASES = Object.freeze({
    order_confirmation: 'order_confirmed',
    order_confirm: 'order_confirmed',
    confirmation: 'order_confirmed',
    delivery_update: 'delivery_scheduled',
    out_for_delivery: 'delivery_scheduled',
    delivered: 'delivery_delivered',
    delivery_completed: 'delivery_delivered',
    flight_booking: 'booking_confirmed',
    hotel_booking: 'booking_confirmed',
    train_booking: 'booking_confirmed',
    booking_confirmation: 'booking_confirmed',
    cancellation: 'booking_cancelled',
    canceled: 'booking_cancelled',
    cancelled: 'booking_cancelled',
    rescheduling: 'booking_rescheduled',
    schedule_change: 'booking_rescheduled',
    refund: 'refund_issued',
    invoice_received: 'payment_due',
    marketing: 'promotional',
    promo: 'promotional',
    subscription_renewed: 'subscription_renewal',
    membership_renewed: 'subscription_renewal'
  });

  const CATEGORY_ALIASES = Object.freeze({
    accommodation: 'travel',
    hotel: 'travel',
    payment: 'finance',
    bill: 'bills',
    invoice: 'bills',
    subscription: 'subscriptions',
    ticket: 'travel',
    tickets: 'travel',
    promotion: 'promotions',
    newsletter: 'newsletters',
    logistics: 'delivery',
    package: 'delivery',
    shipping: 'delivery'
  });

  const INBOX_MAP = Object.freeze({
    shopping: 'shopping', delivery: 'shopping',
    travel: 'ticket',
    finance: 'payment', bills: 'bill',
    subscriptions: 'subscription',
    security: 'other', promotions: 'other', newsletters: 'other',
    work: 'other', meetings: 'other', personal: 'other', social: 'other',
    education: 'other', health: 'other', documents: 'other', government: 'other',
    other: 'other'
  });

  const SYSTEM = `You are Daylight's email intelligence engine for personal organisation.
Return ONLY a single JSON object. No markdown fences. No prose outside JSON.

Rules:
1. Never invent facts. Missing values must be null (or [] for arrays).
2. category and intent are DIFFERENT. Always set both when possible.
3. Intent must be the most specific lifecycle action (never default to informational if a clearer intent fits).
4. Resolve relative dates (tomorrow, morgen, this Saturday) using current_datetime + timezone. Put ISO date in the field and keep original wording in evidence.quoted_text.
5. Never copy email_received_at into delivery/departure/due dates.
6. Ambiguous weekday-only dates (e.g. "this Saturday") → requires_confirmation=true.
7. For shopping/delivery fill order{merchant,order_id,tracking_number,delivery_date,status,product}.
8. For flights fill travel{type:"flight",pnr,flight_number,from,to,depart_datetime,arrive_datetime,seat,status}.
9. For hotels fill travel{type:"hotel",hotel_name,check_in,check_out,pnr,status}.
10. For invoices fill financial{amount,currency,due_date,status,invoice_number}.
11. For subscriptions fill financial amount/currency when present and set intent subscription_*.
12. Quote supporting snippets in evidence for every important extracted ID/date.
13. Marketing-first emails (FLASH SALE, % off, "buy now", newsletter digests) → category "promotions" and intent "promotional", even if a tracking line is buried in the footer. Do not treat promo noise as a delivery lifecycle email. Set requires_confirmation=true if an order id appears only as secondary noise.

Canonical categories (pick one primary):
shopping, delivery, travel, finance, bills, subscriptions, work, meetings, personal, social, education, health, documents, government, security, promotions, newsletters, other
Note: package/shipping updates may use category "delivery" OR "shopping"; prefer "shopping" when an order_id is present and the email is primarily a shipping update (not a sale blast).

Canonical intents (pick the best one):
order_placed, order_confirmed, order_shipped, delivery_scheduled, delivery_delayed, delivery_delivered,
booking_confirmed, booking_cancelled, booking_rescheduled, check_in_required,
payment_due, payment_completed, refund_issued,
subscription_started, subscription_renewal, subscription_cancelled,
ticket_issued, reminder, informational, promotional

Intent examples:
- "Order confirmed" / "Thanks for your order" → order_confirmed
- "Out for delivery" / "Expected delivery tomorrow" → delivery_scheduled
- "Delivery delayed" → delivery_delayed
- "Delivered" / "was delivered" → delivery_delivered
- "Flight booking confirmation" / hotel reservation confirmed → booking_confirmed
- "Flight cancelled" → booking_cancelled
- "Schedule change" / "New departure" → booking_rescheduled
- "Payment due" / invoice with due date → payment_due
- "Subscription renewed" → subscription_renewal
- Pure marketing with no order lifecycle → promotional`;

  const SCHEMA_HINT = `{
  "category": "shopping|delivery|travel|finance|bills|subscriptions|work|meetings|personal|social|education|health|documents|government|security|promotions|newsletters|other",
  "secondary_categories": [],
  "intent": "order_confirmed|order_shipped|delivery_scheduled|delivery_delayed|delivery_delivered|booking_confirmed|booking_cancelled|booking_rescheduled|payment_due|payment_completed|refund_issued|subscription_renewal|subscription_cancelled|promotional|informational|...",
  "organisation": "string|null",
  "summary": "short string",
  "entities": [{"type":"string","value":"string","quoted_text":"string|null"}],
  "event": {"exists":true,"type":"delivery|flight|hotel|payment|null","title":"string|null","start_datetime":"ISO-8601|null","end_datetime":"ISO-8601|null","timezone":"string|null","all_day":false,"location":"string|null","status":"string|null"} | null,
  "order": {"merchant":"string|null","order_id":"string|null","product":"string|null","tracking_number":"string|null","tracking_url":"string|null","delivery_date":"YYYY-MM-DD|null","actual_delivery_date":"YYYY-MM-DD|null","status":"ordered|shipped|out_for_delivery|delayed|delivered|refunded|null","items":[]} | null,
  "travel": {"type":"flight|hotel|train|other|null","airline":"string|null","pnr":"string|null","flight_number":"string|null","from":"string|null","to":"string|null","depart_datetime":"ISO-8601|null","arrive_datetime":"ISO-8601|null","seat":"string|null","terminal":"string|null","gate":"string|null","check_in_deadline":"ISO-8601|null","hotel_name":"string|null","address":"string|null","check_in":"YYYY-MM-DD|null","check_out":"YYYY-MM-DD|null","status":"confirmed|cancelled|rescheduled|null"} | null,
  "financial": {"amount":"string|null","currency":"string|null","due_date":"YYYY-MM-DD|null","status":"due|paid|failed|null","invoice_number":"string|null","billing_frequency":"string|null","next_renewal_date":"YYYY-MM-DD|null"} | null,
  "reminders": [{"title":"string","datetime":"ISO-8601|null","reason":"string|null","requires_confirmation":true}],
  "suggested_actions": [{"action":"string","label":"string|null"}],
  "confidence": 0.0,
  "field_confidence": {"<field name, e.g. pnr|depart_datetime|order_id|delivery_date|amount|due_date>": 0.0},
  "evidence": [{"field":"order_id|delivery_date|pnr|depart_datetime|due_date|...","quoted_text":"exact snippet"}],
  "requires_confirmation": false,
  "original_date_expressions": [{"field":"string","text":"string"}],
  "facts_vs_inferred": {"facts":[],"inferred":[],"unknown":[]}
}`;

  function readJSON(k, fallback) {
    try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fallback; } catch { return fallback; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }
  function getConsent() { return localStorage.getItem(LS.consent) === '1'; }
  function setConsent(v) { localStorage.setItem(LS.consent, v ? '1' : '0'); if (!v) localStorage.setItem(LS.enabled, '0'); }
  function isEnabled() { return getConsent() && localStorage.getItem(LS.enabled) !== '0'; }
  function setEnabled(v) { localStorage.setItem(LS.enabled, v ? '1' : '0'); }
  function allowedAccounts() { return readJSON(LS.accounts, { all: true, emails: [] }); }
  function setAllowedAccounts(cfg) { writeJSON(LS.accounts, cfg || { all: true, emails: [] }); }
  function accountAllowed(email) {
    const cfg = allowedAccounts();
    if (cfg.all !== false) return true;
    const e = String(email || '').toLowerCase();
    return (cfg.emails || []).map(x => String(x).toLowerCase()).includes(e);
  }

  function setStatus(msg, detail) {
    const row = { at: Date.now(), message: String(msg || ''), detail: detail || null };
    writeJSON(LS.status, row);
    try { root.dispatchEvent(new CustomEvent('daylight-ai-status', { detail: row })); } catch {}
    return row;
  }
  function getStatus() { return readJSON(LS.status, null); }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function cacheGet(hash) {
    const c = readJSON(LS.cache, {});
    const hit = c[hash];
    if (!hit) return null;
    if (Date.now() - (hit.at || 0) > 7 * 86400000) return null;
    return hit.result || null;
  }
  function cacheSet(hash, result) {
    const c = readJSON(LS.cache, {});
    c[hash] = { at: Date.now(), result };
    const keys = Object.keys(c);
    if (keys.length > 80) {
      keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
      keys.slice(0, keys.length - 60).forEach(k => delete c[k]);
    }
    writeJSON(LS.cache, c);
  }

  function trackUsage(meta) {
    const u = readJSON(LS.usage, { calls: 0, promptTokens: 0, outputTokens: 0, byDay: {} });
    const day = new Date().toISOString().slice(0, 10);
    u.calls = (u.calls || 0) + 1;
    u.promptTokens += Number(meta?.promptTokenCount || 0);
    u.outputTokens += Number(meta?.candidatesTokenCount || meta?.outputTokenCount || 0);
    u.byDay[day] = (u.byDay[day] || 0) + 1;
    u.lastAt = Date.now();
    writeJSON(LS.usage, u);
    return u;
  }
  function getUsage() { return readJSON(LS.usage, { calls: 0, promptTokens: 0, outputTokens: 0, byDay: {} }); }

  function emptyResult(partial) {
    return Object.assign({
      category: 'other',
      secondary_categories: [],
      intent: null,
      organisation: null,
      summary: '',
      entities: [],
      event: null,
      order: null,
      travel: null,
      financial: null,
      reminders: [],
      suggested_actions: [],
      confidence: 0,
      evidence: [],
      requires_confirmation: true,
      facts_vs_inferred: { facts: [], inferred: [], unknown: [] },
      method: 'none',
      inboxCategory: 'other',
      valid: false
    }, partial || {});
  }

  function asArray(v) { return Array.isArray(v) ? v : []; }
  function asStr(v) { return v == null || v === '' ? null : String(v); }
  function asNum01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }
  function parseJsonLoose(text) {
    if (!text) return null;
    const raw = String(text).trim();
    try { return JSON.parse(raw); } catch {}
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  function normalizeCategory(rawCat, order, travel) {
    let category = String(rawCat || 'other').toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    if (category === 'government_and_administration') category = 'government';
    if (category === 'delivery_and_logistics') category = 'delivery';
    if (category === 'security_and_account_alerts') category = 'security';
    if (CATEGORY_ALIASES[category]) category = CATEGORY_ALIASES[category];
    if (!PRIMARY_CATEGORIES.includes(category)) category = 'other';
    // Daylight shopping taxonomy: package updates with an order id count as shopping
    if (category === 'delivery' && (order?.order_id || order?.merchant)) {
      category = 'shopping';
    }
    // Hotel/flight structured travel → travel
    if (category === 'other' && travel && (travel.pnr || travel.flight_number || travel.hotel_name || travel.check_in)) {
      category = 'travel';
    }
    return category;
  }

  function normalizeIntent(rawIntent) {
    if (rawIntent == null || rawIntent === '') return null;
    let intent = String(rawIntent).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
    if (INTENT_ALIASES[intent]) intent = INTENT_ALIASES[intent];
    // Soft synonym repair
    if (intent === 'order_confirmation') intent = 'order_confirmed';
    if (intent === 'delivery_update') intent = 'delivery_scheduled';
    if (intent === 'delivered') intent = 'delivery_delivered';
    if (intent === 'cancellation' || intent === 'cancelled' || intent === 'canceled') intent = 'booking_cancelled';
    if (intent === 'rescheduling') intent = 'booking_rescheduled';
    if (intent === 'flight_booking' || intent === 'hotel_booking' || intent === 'train_booking') intent = 'booking_confirmed';
    if (intent === 'refund') intent = 'refund_issued';
    if (intent === 'marketing') intent = 'promotional';
    const canonical = [
      'order_placed', 'order_confirmed', 'order_shipped', 'delivery_scheduled', 'delivery_delayed', 'delivery_delivered',
      'booking_confirmed', 'booking_cancelled', 'booking_rescheduled', 'check_in_required',
      'payment_due', 'payment_completed', 'refund_issued',
      'subscription_started', 'subscription_renewal', 'subscription_cancelled',
      'ticket_issued', 'reminder', 'informational', 'promotional'
    ];
    if (canonical.includes(intent)) return intent;
    if (INTENTS.includes(intent)) return INTENT_ALIASES[intent] || intent;
    return null; // do NOT silently coerce unknown → informational
  }

  function inferIntentFromStructure(intent, order, travel, financial, category) {
    if (intent) return intent;
    const st = String(order?.status || '').toLowerCase();
    if (st === 'delayed') return 'delivery_delayed';
    if (st === 'delivered') return 'delivery_delivered';
    if (st === 'out_for_delivery' || st === 'shipped') return st === 'shipped' ? 'order_shipped' : 'delivery_scheduled';
    if (st === 'ordered' || st === 'confirmed') return 'order_confirmed';
    const ts = String(travel?.status || '').toLowerCase();
    if (ts === 'cancelled' || ts === 'canceled') return 'booking_cancelled';
    if (ts === 'rescheduled') return 'booking_rescheduled';
    if (travel?.pnr || travel?.flight_number || travel?.hotel_name) return 'booking_confirmed';
    if (financial?.due_date && String(financial.status || '').toLowerCase() !== 'paid') return 'payment_due';
    if (category === 'promotions') return 'promotional';
    if (category === 'subscriptions') return 'subscription_renewal';
    return 'informational';
  }

  function normalizeDateField(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    // Keep YYYY-MM-DD or ISO-like; strip trailing Z quirks later
    const day = s.match(/^(20\d{2}-\d{2}-\d{2})/);
    if (day) {
      const time = s.match(/T\d{2}:\d{2}/);
      return time ? s.replace(' ', 'T') : day[1];
    }
    const m = s.match(/\b(20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?)/);
    return m ? m[1].replace(' ', 'T') : s.slice(0, 40);
  }

  function validateExtraction(raw) {
    if (!raw || typeof raw !== 'object') return emptyResult({ valid: false, error: 'not_object' });

    const order = raw.order && typeof raw.order === 'object' ? {
      merchant: asStr(raw.order.merchant),
      order_id: asStr(raw.order.order_id),
      product: asStr(raw.order.product || raw.order.item || null),
      tracking_number: asStr(raw.order.tracking_number),
      tracking_url: asStr(raw.order.tracking_url),
      delivery_date: normalizeDateField(raw.order.delivery_date || raw.order.expected_delivery_date),
      actual_delivery_date: normalizeDateField(raw.order.actual_delivery_date),
      status: asStr(raw.order.status),
      items: asArray(raw.order.items)
    } : null;

    const travel = raw.travel && typeof raw.travel === 'object' ? {
      type: asStr(raw.travel.type),
      airline: asStr(raw.travel.airline),
      pnr: asStr(raw.travel.pnr || raw.travel.booking_ref || raw.travel.confirmation_code),
      flight_number: asStr(raw.travel.flight_number || raw.travel.flight),
      from: asStr(raw.travel.from || raw.travel.departure_airport),
      to: asStr(raw.travel.to || raw.travel.arrival_airport),
      depart_datetime: normalizeDateField(raw.travel.depart_datetime || raw.travel.departure_datetime || raw.travel.departure),
      arrive_datetime: normalizeDateField(raw.travel.arrive_datetime || raw.travel.arrival_datetime),
      seat: asStr(raw.travel.seat),
      terminal: asStr(raw.travel.terminal),
      gate: asStr(raw.travel.gate),
      check_in_deadline: normalizeDateField(raw.travel.check_in_deadline),
      hotel_name: asStr(raw.travel.hotel_name || raw.travel.hotel),
      address: asStr(raw.travel.address),
      check_in: normalizeDateField(raw.travel.check_in || raw.travel.checkin),
      check_out: normalizeDateField(raw.travel.check_out || raw.travel.checkout),
      status: asStr(raw.travel.status)
    } : null;

    const financial = raw.financial && typeof raw.financial === 'object' ? {
      amount: asStr(raw.financial.amount),
      currency: asStr(raw.financial.currency),
      due_date: normalizeDateField(raw.financial.due_date || raw.financial.payment_due),
      status: asStr(raw.financial.status),
      invoice_number: asStr(raw.financial.invoice_number || raw.financial.invoice_id),
      billing_frequency: asStr(raw.financial.billing_frequency),
      next_renewal_date: normalizeDateField(raw.financial.next_renewal_date)
    } : null;

    let category = normalizeCategory(raw.category, order, travel);
    let intent = normalizeIntent(raw.intent);
    intent = inferIntentFromStructure(intent, order, travel, financial, category);

    const secondary = asArray(raw.secondary_categories).map(c => {
      let x = String(c).toLowerCase().replace(/\s+/g, '_');
      if (CATEGORY_ALIASES[x]) x = CATEGORY_ALIASES[x];
      return x;
    }).filter(c => PRIMARY_CATEGORIES.includes(c) && c !== category);
    if (String(raw.category || '').toLowerCase() === 'delivery' && category === 'shopping' && !secondary.includes('delivery')) {
      secondary.unshift('delivery');
    }

    const event = raw.event && typeof raw.event === 'object' ? {
      exists: !!raw.event.exists,
      type: asStr(raw.event.type),
      title: asStr(raw.event.title),
      start_datetime: normalizeDateField(raw.event.start_datetime),
      end_datetime: normalizeDateField(raw.event.end_datetime),
      timezone: asStr(raw.event.timezone),
      all_day: !!raw.event.all_day,
      location: asStr(raw.event.location),
      status: asStr(raw.event.status)
    } : null;

    if (event && event.exists && !event.start_datetime) {
      event.exists = false;
      raw.requires_confirmation = true;
    }

    // Prefer order.delivery_date / travel.depart as event start when event missing
    let eventOut = event && event.exists ? event : (event ? { ...event, exists: false } : null);
    if ((!eventOut || !eventOut.exists) && order?.delivery_date) {
      eventOut = {
        exists: true, type: 'delivery', title: (order.merchant || 'Order') + ' delivery',
        start_datetime: order.delivery_date.length === 10 ? order.delivery_date + 'T00:00:00' : order.delivery_date,
        end_datetime: null, timezone: null, all_day: order.delivery_date.length === 10,
        location: null, status: 'scheduled'
      };
    }
    if ((!eventOut || !eventOut.exists) && travel?.depart_datetime) {
      eventOut = {
        exists: true, type: travel.type || 'flight', title: travel.flight_number ? ('Flight ' + travel.flight_number) : (travel.hotel_name || 'Travel'),
        start_datetime: travel.depart_datetime, end_datetime: travel.arrive_datetime || null,
        timezone: null, all_day: false, location: travel.from && travel.to ? (travel.from + ' → ' + travel.to) : null,
        status: travel.status || 'scheduled'
      };
    }

    const reminders = asArray(raw.reminders).map(r => ({
      title: String(r?.title || '').slice(0, 160),
      datetime: normalizeDateField(r?.datetime),
      reason: asStr(r?.reason),
      requires_confirmation: r?.requires_confirmation !== false && (!r?.datetime || !!raw.requires_confirmation)
    })).filter(r => r.title);

    const originalDates = asArray(raw.original_date_expressions);
    const ambiguousExpr = originalDates.some(d => /saturday|sunday|monday|tuesday|wednesday|thursday|friday|this week|next week|soon/i.test(String(d?.text || '')));
    const confidence = asNum01(raw.confidence == null ? 0.8 : raw.confidence);
    let requires_confirmation = !!raw.requires_confirmation || ambiguousExpr || confidence < 0.72 ||
      (eventOut?.exists && !eventOut.start_datetime) ||
      reminders.some(r => !r.datetime);

    // Ambiguous relative weekday without resolved ISO confirmation already flagged by model — force if delivery date missing on shopping delay/schedule
    if ((intent === 'delivery_scheduled' || intent === 'delivery_delayed') && !order?.delivery_date) requires_confirmation = true;

    const out = {
      category,
      secondary_categories: secondary,
      intent,
      organisation: asStr(raw.organisation),
      summary: String(raw.summary || '').slice(0, 280),
      entities: asArray(raw.entities).slice(0, 40).map(e => ({
        type: String(e?.type || 'unknown'),
        value: String(e?.value || ''),
        quoted_text: asStr(e?.quoted_text)
      })).filter(e => e.value),
      event: eventOut,
      order: order && (order.merchant || order.order_id || order.tracking_number || order.delivery_date || order.product) ? order : null,
      travel: travel && (travel.pnr || travel.flight_number || travel.from || travel.to || travel.hotel_name || travel.check_in || travel.depart_datetime) ? travel : null,
      financial: financial && (financial.amount || financial.due_date || financial.invoice_number || financial.next_renewal_date) ? financial : null,
      reminders,
      suggested_actions: asArray(raw.suggested_actions).slice(0, 8).map(a => ({
        action: String(a?.action || ''),
        label: asStr(a?.label)
      })).filter(a => a.action),
      confidence,
      field_confidence: (() => { const fc = raw.field_confidence && typeof raw.field_confidence === 'object' && !Array.isArray(raw.field_confidence) ? raw.field_confidence : {}; const o = {}; Object.keys(fc).slice(0, 30).forEach((k) => { const v = Number(fc[k]); if (isFinite(v)) o[String(k).slice(0, 40)] = Math.max(0, Math.min(1, v)); }); return o; })(),
      evidence: asArray(raw.evidence).slice(0, 30).map(e => ({
        field: String(e?.field || ''),
        quoted_text: String(e?.quoted_text || '')
      })).filter(e => e.field && e.quoted_text),
      requires_confirmation,
      original_date_expressions: originalDates,
      facts_vs_inferred: {
        facts: asArray(raw.facts_vs_inferred?.facts).map(String),
        inferred: asArray(raw.facts_vs_inferred?.inferred).map(String),
        unknown: asArray(raw.facts_vs_inferred?.unknown).map(String)
      },
      method: raw.method || 'gemini',
      inboxCategory: INBOX_MAP[category] || 'other',
      valid: true
    };
    return out;
  }

  function isPromotionalPrimary(subject, body) {
    const s = `${subject}\n${body}`;
    const promoHits = [
      /\bflash\s*sale\b/i, /\b\d{1,2}%\s*off\b/i, /\bbuy\s+now\b/i, /\bshop\s+now\b/i,
      /\blimited\s+time\b/i, /\bnewsletter\b/i, /\bweekly\s+digest\b/i, /\bunsubscribe\b/i,
      /\bpromo(tion|tional)?\b/i, /\bdeal\s+of\s+the\s+day\b/i
    ].filter(rx => rx.test(s)).length;
    const lifecycleHits = [
      /\bout\s+for\s+delivery\b/i, /\bdelivery\s+delayed\b/i, /\bwas\s+delivered\b/i,
      /\bbording\s*pass\b/i, /\bflight\b/i, /\bPNR\b/, /\binvoice\b/i, /\bpayment\s+due\b/i
    ].filter(rx => rx.test(s)).length;
    // Subject-led promo wins when sale language dominates
    if (/\b(flash\s*sale|%\s*off|newsletter|digest)\b/i.test(subject) && promoHits >= 1) return true;
    return promoHits >= 2 && promoHits > lifecycleHits;
  }

  /** Level-1 style local enrichment for high-signal templates (no network). */
  function localHeuristicExtract(mail, nowIso, tz) {
    const subject = String(mail.subject || '');
    const body = String(mail.body || mail.snippet || '');
    const text = `${subject}\n${body}`;
    const from = String(mail.fromEmail || mail.from || '').toLowerCase();
    const org = (mail.fromName || from.split('@')[0] || '').replace(/[^a-zA-Z0-9 ._-]/g, '').trim() || null;

    // Promotional / newsletter primary — do not emit delivery reminders
    if (isPromotionalPrimary(subject, body)) {
      return validateExtraction({
        category: 'promotions',
        intent: 'promotional',
        organisation: org,
        summary: subject.slice(0, 120) || 'Promotional email',
        order: null,
        travel: null,
        financial: null,
        event: null,
        reminders: [],
        confidence: 0.82,
        requires_confirmation: false,
        evidence: [{ field: 'category', quoted_text: subject.slice(0, 80) }],
        facts_vs_inferred: { facts: ['promotional_language'], inferred: [], unknown: [] },
        method: 'local-heuristic'
      });
    }

    // Shopping / delivery (Amazon, eBay, and generic order templates)
    const shopHit = /amazon\.|ship-confirm@amazon|auto-confirm@amazon|@ebay\.|ebay@/i.test(from)
      || /\b(amazon|ebay|aliexpress|order (confirmed|shipped)|your (package|order)|bestellung|objednávka)\b/i.test(subject + ' ' + body);
    if (shopHit) {
      let intent = 'order_confirmed';
      let status = 'ordered';
      if (/\b(out for delivery|arriving (today|tomorrow)|expected delivery|lieferung|doruč)\b/i.test(text)) { intent = 'delivery_scheduled'; status = 'out_for_delivery'; }
      if (/\b(delayed|running late|delivery (date )?changed)\b/i.test(text)) { intent = 'delivery_delayed'; status = 'delayed'; }
      if (/\b(delivered|was delivered|left at|zugestellt|doručeno)\b/i.test(text)) { intent = 'delivery_delivered'; status = 'delivered'; }
      if (/\brefund\b/i.test(text)) { intent = 'refund_issued'; status = 'refunded'; }
      if (/\b(shipped|dispatched|on its way|tracking|versandt|odeslán)\b/i.test(text) && intent === 'order_confirmed') { intent = 'order_shipped'; status = 'shipped'; }
      // Require a real order token (digits); never capture words like "confirmed"
      const orderId = (text.match(/\b(?:order|bestellung)\s*(?:number|no\.?|id|#)?\s*[:#]?\s*#?\s*([0-9][A-Z0-9-]{5,})\b/i) || [])[1]
        || (text.match(/#\s*([0-9][A-Z0-9-]{5,})\b/) || [])[1]
        || null;
      const tracking = (text.match(/\b(?:tracking(?:\s*(?:number|no\.?))?)[:\s#]*([A-Z0-9]{8,})\b/i) || [])[1] || null;
      let deliveryDate = null;
      const tom = /\b(tomorrow|morgen|zítra)\b/i.test(text);
      const today = /\b(today|heute|dnes)\b/i.test(text);
      const isoDay = (text.match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1];
      if (isoDay) deliveryDate = isoDay;
      else if (tom || today) {
        const d = new Date(nowIso || Date.now());
        if (tom) d.setDate(d.getDate() + 1);
        deliveryDate = d.toISOString().slice(0, 10);
      }
      const merchant = /ebay/i.test(from + subject) ? 'eBay' : /amazon/i.test(from + subject + body) ? 'Amazon' : (org || 'Store');
      const rem = deliveryDate ? [{
        title: `${merchant} order arriving`,
        datetime: deliveryDate + 'T00:00:00',
        reason: 'Expected delivery',
        requires_confirmation: !isoDay
      }] : [];
      return validateExtraction({
        category: 'shopping',
        intent,
        organisation: merchant,
        summary: subject.slice(0, 120) || (merchant + ' order update'),
        order: { merchant, order_id: orderId, tracking_number: tracking, delivery_date: deliveryDate, status, items: [] },
        event: deliveryDate ? {
          exists: true, type: 'delivery', title: merchant + ' order delivery',
          start_datetime: deliveryDate + 'T00:00:00', end_datetime: null, timezone: tz || null,
          all_day: true, location: null, status: 'scheduled'
        } : null,
        reminders: rem,
        confidence: orderId || tracking || deliveryDate ? 0.86 : 0.7,
        evidence: [
          deliveryDate ? { field: 'delivery_date', quoted_text: (text.match(/[^\n.]{0,40}(?:tomorrow|morgen|zítra|today|expected delivery|20\d{2}-\d{2}-\d{2})[^\n.]{0,40}/i) || [''])[0].trim() } : null,
          orderId ? { field: 'order_id', quoted_text: orderId } : null
        ].filter(Boolean),
        requires_confirmation: /\bthis saturday|next tuesday|soon\b/i.test(text) || !deliveryDate || (!isoDay && !!deliveryDate),
        facts_vs_inferred: {
          facts: [orderId && 'order_id', tracking && 'tracking', isoDay && 'delivery_date'].filter(Boolean),
          inferred: [!isoDay && deliveryDate && 'delivery_date_from_relative'].filter(Boolean),
          unknown: [!deliveryDate && 'delivery_date', !orderId && 'order_id'].filter(Boolean)
        },
        method: 'local-heuristic'
      });
    }

    // Travel: flight / train / hotel
    const travelHit = /\b(flight|boarding\s*pass|e-?ticket|itinerary|pnr|train ticket|hotel (booking|reservation)|check-?in)\b/i.test(text)
      || /lufthansa|ryanair|easyjet|klm|wizz|emirates|delta|united|american airlines|booking\.com|airbnb|@cd\.cz/i.test(from + text);
    if (travelHit) {
      const isHotel = /\bhotel\b|booking\.com|airbnb|check-?in|check-?out/i.test(from + text);
      const isTrain = /\btrain\b|bahn|@cd\.cz|rail|eurostar/i.test(from + text) && !/\bflight\b/i.test(text);
      const cancelled = /\bcancel+ed|cancellation\b/i.test(text);
      const resched = /\breschedul|schedule\s+chang|new\s+departure\b/i.test(text);
      const flight = (text.match(/\b([A-Z]{2}\s?\d{2,4})\b/) || [])[1] || null;
      // Prefer explicit PNR / booking ref — never treat "confirmation LH400" as a PNR
      const pnr = (text.match(/\bPNR\s*[:#]?\s*([A-Z0-9]{5,8})\b/i) || [])[1]
        || (text.match(/\bbooking\s*(?:ref|reference|code)\s*[:#]?\s*([A-Z0-9]{5,8})\b/i) || [])[1]
        || (text.match(/\bconfirmation\s*(?:code|number)\s*[:#]?\s*([A-Z0-9]{5,8})\b/i) || [])[1]
        || null;
      const route = text.match(/\b([A-Z]{3})\s*(?:→|->|to)\s*([A-Z]{3})\b/)
        || text.match(/\b([A-ZÁ-ž][A-ZÁ-ža-z .'-]{2,20})\s*(?:→|->|to)\s*([A-ZÁ-ž][A-ZÁ-ža-z .'-]{2,20})\b/);
      const departIso = (text.match(/\b(20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)\b/) || [])[1] || null;
      const checkIn = (text.match(/\bcheck-?in\s*(?:on\s*)?(20\d{2}-\d{2}-\d{2})/i) || [])[1] || null;
      const checkOut = (text.match(/\bcheck-?out\s*(?:on\s*)?(20\d{2}-\d{2}-\d{2})/i) || [])[1] || null;
      const seat = (text.match(/\bseat\s*([A-Z]?\d{1,2}[A-Z]?)\b/i) || [])[1] || null;
      const hotelName = isHotel ? ((text.match(/\bHotel\s+([A-ZÁ-ž][\w .'-]{2,40})/i) || [])[1] || org) : null;
      let intent = 'booking_confirmed';
      if (cancelled) intent = 'booking_cancelled';
      else if (resched) intent = 'booking_rescheduled';
      const type = isHotel ? 'hotel' : isTrain ? 'train' : 'flight';
      const when = departIso || (checkIn ? checkIn + 'T15:00:00' : null);
      return validateExtraction({
        category: 'travel',
        intent,
        organisation: org,
        summary: subject.slice(0, 120) || 'Travel booking',
        travel: {
          type, pnr, flight_number: isHotel ? null : flight,
          from: route?.[1] || null, to: route?.[2] || null,
          depart_datetime: departIso, arrive_datetime: null,
          seat, gate: null, hotel_name: hotelName, check_in: checkIn, check_out: checkOut,
          status: cancelled ? 'cancelled' : (resched ? 'rescheduled' : 'confirmed')
        },
        event: when ? {
          exists: true, type, title: flight ? `Flight ${flight}` : (hotelName || (isTrain ? 'Train' : 'Travel')),
          start_datetime: String(when).replace(' ', 'T'), end_datetime: checkOut ? checkOut + 'T11:00:00' : null,
          timezone: tz || null, all_day: !!checkIn && !departIso,
          location: route ? `${route[1]} → ${route[2]}` : hotelName,
          status: cancelled ? 'cancelled' : 'scheduled'
        } : null,
        reminders: when && !cancelled ? [{
          title: isHotel ? 'Hotel check-in' : (flight ? `Check-in · ${flight}` : 'Travel reminder'),
          datetime: (() => { const d = new Date(when); if (isHotel) return checkIn ? checkIn + 'T09:00:00' : null; d.setHours(d.getHours() - 24); return isNaN(d) ? null : d.toISOString(); })(),
          reason: isHotel ? 'Check-in day' : 'Check-in window',
          requires_confirmation: false
        }] : [],
        confidence: (pnr || flight || departIso || checkIn) ? 0.88 : 0.65,
        evidence: [
          pnr ? { field: 'pnr', quoted_text: pnr } : null,
          flight ? { field: 'flight_number', quoted_text: flight } : null,
          departIso ? { field: 'depart_datetime', quoted_text: departIso } : null,
          checkIn ? { field: 'check_in', quoted_text: checkIn } : null
        ].filter(Boolean),
        requires_confirmation: !(departIso || checkIn),
        facts_vs_inferred: {
          facts: [pnr && 'pnr', flight && 'flight_number', departIso && 'depart_datetime', checkIn && 'check_in'].filter(Boolean),
          inferred: [],
          unknown: [!departIso && !checkIn && 'depart_datetime', !pnr && 'pnr'].filter(Boolean)
        },
        method: 'local-heuristic'
      });
    }

    // Bills / invoices
    if (/\binvoice\b|\bpayment\s+due\b|\bamount\s+due\b|\bdue\s+by\b|\bfaktura\b/i.test(text)) {
      const due = (text.match(/\b(?:due(?:\s+(?:by|date))?|splatnost)\s*[:#]?\s*(20\d{2}-\d{2}-\d{2})\b/i) || [])[1]
        || (text.match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1]
        || null;
      const amountMatch = text.match(/\b(\d[\d\s]*[.,]?\d*)\s*(CZK|Kč|EUR|€|USD|\$|GBP|£)\b/i)
        || text.match(/\b(CZK|EUR|USD|GBP)\s*(\d[\d\s]*[.,]?\d*)\b/i);
      let amount = null, currency = null;
      if (amountMatch) {
        if (/^[A-Z€$£]/.test(amountMatch[1]) || /EUR|CZK|USD|GBP|€|\$|£/i.test(amountMatch[1])) {
          currency = amountMatch[1].replace('€', 'EUR').replace('$', 'USD').replace('£', 'GBP').replace('Kč', 'CZK');
          amount = parseFloat(String(amountMatch[2]).replace(/\s/g, '').replace(',', '.'));
        } else {
          amount = parseFloat(String(amountMatch[1]).replace(/\s/g, '').replace(',', '.'));
          currency = (amountMatch[2] || '').replace('€', 'EUR').replace('$', 'USD').replace('£', 'GBP').replace('Kč', 'CZK');
        }
      }
      const inv = (text.match(/\b(?:invoice|faktura)\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Z0-9-]{4,})\b/i) || [])[1] || null;
      return validateExtraction({
        category: 'bills',
        intent: 'payment_due',
        organisation: org,
        summary: subject.slice(0, 120) || 'Invoice',
        financial: { amount: Number.isFinite(amount) ? amount : null, currency: currency || null, due_date: due, status: 'due', invoice_number: inv },
        event: due ? { exists: true, type: 'payment', title: 'Payment due', start_datetime: due + 'T09:00:00', end_datetime: null, timezone: tz || null, all_day: true, location: null, status: 'scheduled' } : null,
        reminders: due ? [{ title: 'Pay invoice', datetime: due + 'T09:00:00', reason: 'Payment due', requires_confirmation: false }] : [],
        confidence: due || amount ? 0.8 : 0.55,
        evidence: [due ? { field: 'due_date', quoted_text: due } : null, inv ? { field: 'invoice_number', quoted_text: inv } : null].filter(Boolean),
        requires_confirmation: !due,
        facts_vs_inferred: { facts: [due && 'due_date', amount && 'amount'].filter(Boolean), inferred: [], unknown: [!due && 'due_date'].filter(Boolean) },
        method: 'local-heuristic'
      });
    }

    // Subscriptions
    if (/\bsubscription\b|\bmembership\b|\brenew(ed|al|s)?\b|\bpremium\b/i.test(text)
      && /spotify|netflix|disney|youtube|apple|microsoft|adobe|notion|subscription|membership/i.test(from + subject + body)) {
      const cancelled = /\bcancel+ed|cancellation|will end\b/i.test(text);
      const renew = /\brenew/i.test(text);
      const next = (text.match(/\b(?:next\s+renewal|renews?(?:\s+on)?|ends?(?:\s+on)?)\s*(20\d{2}-\d{2}-\d{2})\b/i) || [])[1]
        || (text.match(/\b(20\d{2}-\d{2}-\d{2})\b/) || [])[1]
        || null;
      return validateExtraction({
        category: 'subscriptions',
        intent: cancelled ? 'subscription_cancelled' : (renew ? 'subscription_renewal' : 'subscription_started'),
        organisation: org,
        summary: subject.slice(0, 120) || 'Subscription update',
        financial: { amount: null, currency: null, due_date: next, status: cancelled ? 'cancelled' : 'active', invoice_number: null },
        event: next && !cancelled ? { exists: true, type: 'subscription', title: (org || 'Subscription') + ' renewal', start_datetime: next + 'T09:00:00', end_datetime: null, timezone: tz || null, all_day: true, location: null, status: 'scheduled' } : null,
        reminders: next && !cancelled ? [{ title: (org || 'Subscription') + ' renewal', datetime: next + 'T09:00:00', reason: 'Renewal date', requires_confirmation: false }] : [],
        confidence: 0.78,
        evidence: [next ? { field: 'due_date', quoted_text: next } : null].filter(Boolean),
        requires_confirmation: false,
        facts_vs_inferred: { facts: [cancelled ? 'cancelled' : 'renewal'].filter(Boolean), inferred: [], unknown: [] },
        method: 'local-heuristic'
      });
    }

    return null;
  }

  function shouldCallGemini(mail, ruleResult) {
    if (!isEnabled() || !getConsent()) return false;
    if (mail?.aiExclude || ruleResult?.privacyClass === 'financial' && localStorage.getItem('daylight-ai-allow-financial') !== '1') {
      // Still allow shopping/travel; block pure finance by default unless opted in
      if (ruleResult?.category === 'bill' || ruleResult?.category === 'payment' || ruleResult?.category === 'subscription') {
        if (localStorage.getItem('daylight-ai-allow-financial') !== '1') return false;
      }
    }
    if (ruleResult?.needsReview) return true;
    if ((ruleResult?.confidence || 0) < 0.62) return true;
    const cat = ruleResult?.category;
    if (cat === 'shopping' || cat === 'ticket') return true; // structured extraction adds value
    const text = `${mail?.subject || ''} ${mail?.body || mail?.snippet || ''}`;
    if (/\b(flight|hotel|booking|pnr|order|delivered|tracking|invoice|reschedul|cancel)\b/i.test(text)) return true;
    return false;
  }

  function buildPrompt(mail, ctx) {
    const now = ctx?.nowIso || new Date().toISOString();
    const tz = ctx?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return `current_datetime: ${now}
timezone: ${tz}
email_received_at: ${mail.receivedAt || mail.date || 'unknown'}
from: ${mail.fromName || ''} <${mail.fromEmail || mail.from || ''}>
subject: ${mail.subject || ''}
thread_id: ${mail.threadId || ''}
message_id: ${mail.id || mail.mailId || ''}
attachment_names: ${(mail.attachments || []).map(a => a.filename || a).join(', ') || 'none'}

email_body:
${String(mail.body || mail.snippet || '').slice(0, ctx?.maxChars || 6000)}

Return JSON with this shape:
${SCHEMA_HINT}`;
  }

  async function callWorker(serverUrl, session, prompt, opts) {
    const url = String(serverUrl || '').replace(/\/+$/, '') + '/api/gemini/analyse';
    const attempt = async (n) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + session
        },
        body: JSON.stringify({
          prompt,
          system: SYSTEM,
          temperature: 0.1,
          maxOutputTokens: 2048,
          timeoutMs: opts?.timeoutMs || 25000
        })
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 429 && n < 3) {
        const wait = Math.min(8000, 500 * Math.pow(2, n)) + Math.random() * 200;
        await new Promise(res => setTimeout(res, wait));
        return attempt(n + 1);
      }
      if (!r.ok) {
        const err = new Error(data.error || 'gemini_failed');
        err.code = data.error || r.status;
        err.detail = data.detail;
        throw err;
      }
      return data;
    };
    return attempt(0);
  }

  async function analyseEmail(mail, ctx) {
    const normalized = {
      id: mail.id || mail.mailId,
      mailId: mail.id || mail.mailId,
      threadId: mail.threadId,
      fromName: mail.fromName,
      fromEmail: mail.fromEmail || mail.from,
      subject: mail.subject,
      body: mail.body || mail.snippet || '',
      snippet: mail.snippet || '',
      attachments: mail.attachments || [],
      receivedAt: mail.receivedAt || (mail.whenMs ? new Date(mail.whenMs).toISOString() : null),
      aiExclude: !!mail.aiExclude
    };

    setStatus('Analysing email', normalized.subject);
    const local = localHeuristicExtract(normalized, ctx?.nowIso, ctx?.timezone);
    const rule = ctx?.ruleResult || null;

    // Prefer local high-confidence for known templates to save cost.
    // Still escalate to Gemini when the local result needs confirmation (ambiguous dates, missing fields).
    if (local && local.confidence >= 0.84 && !local.requires_confirmation && !shouldForceGemini(ctx)) {
      setStatus(/booking_|flight|hotel|train/i.test(local.intent || '') ? 'Booking detected' : 'Delivery date extracted', local.summary);
      return { ...local, source: 'local-heuristic' };
    }

    if (!shouldCallGemini(normalized, rule) && !ctx?.forceGemini) {
      if (local) {
        setStatus('Analysed with rules', local.summary);
        return { ...local, source: 'local-heuristic' };
      }
      setStatus('Skipped AI (rules sufficient)');
      return emptyResult({ method: 'rules-only', valid: true, confidence: rule?.confidence || 0, category: mapInboxToPrimary(rule?.category), inboxCategory: rule?.category || 'other' });
    }

    if (!isEnabled() || !getConsent()) {
      if (local) return { ...local, source: 'local-heuristic' };
      return emptyResult({ method: 'disabled', valid: true, inboxCategory: rule?.category || 'other' });
    }

    const serverUrl = ctx?.serverUrl || '';
    const session = ctx?.session || '';
    if (!serverUrl || !session) {
      setStatus('AI server unavailable — using rules');
      return local || emptyResult({ method: 'fallback-no-server', valid: true, inboxCategory: rule?.category || 'other' });
    }

    const prompt = buildPrompt(normalized, ctx);
    // cache key without the changing current_datetime line, so an unchanged email is never re-sent (v2 cost fix)
    const hash = await sha256Hex(prompt.replace(/^current_datetime:[^\n]*\n/, ''));
    const cached = cacheGet(hash);
    if (cached) {
      setStatus('Analysed (cached)', cached.summary);
      return { ...cached, source: 'cache' };
    }

    try {
      let data = await callWorker(serverUrl, session, prompt, ctx);
      trackUsage(data.usage);
      let parsed = parseJsonLoose(data.text);
      let validated = validateExtraction({ ...(parsed || {}), method: 'gemini' });
      let retried = false, usage = data.usage;
      if (!parsed || !validated.valid) {
        // invalid JSON / schema: retry exactly once with the same (identical) system prompt, then give up
        retried = true;
        data = await callWorker(serverUrl, session, prompt + '\n\nReturn ONLY one valid JSON object matching the shape above.', ctx);
        trackUsage(data.usage);
        usage = { promptTokenCount: Number(usage?.promptTokenCount || 0) + Number(data.usage?.promptTokenCount || 0), candidatesTokenCount: Number(usage?.candidatesTokenCount || 0) + Number(data.usage?.candidatesTokenCount || 0) };
        parsed = parseJsonLoose(data.text);
        validated = validateExtraction({ ...(parsed || {}), method: 'gemini' });
        if (!parsed || !validated.valid) { const err = new Error('invalid_schema'); err.usage = usage; err.retried = true; throw err; }
      }
      data.usage = usage; validated.retried = retried;
      cacheSet(hash, validated);
      if (validated.requires_confirmation) setStatus('Needs confirmation', validated.summary);
      else if (validated.travel) setStatus('Booking detected', validated.summary);
      else if (validated.order) setStatus('Delivery date extracted', validated.summary);
      else if (validated.reminders?.length) setStatus('Reminder created', validated.reminders[0].title);
      else setStatus('Email analysed', validated.summary);
      return { ...validated, source: 'gemini', model: data.model, usage: data.usage };
    } catch (e) {
      setStatus('Could not confidently analyse — using rules', e.code || e.message);
      return local || emptyResult({
        method: 'fallback-error',
        valid: true,
        error: e.code || e.message,
        inboxCategory: rule?.category || 'other',
        confidence: rule?.confidence || 0,
        category: mapInboxToPrimary(rule?.category)
      });
    }
  }

  function shouldForceGemini(ctx) { return !!ctx?.forceGemini; }

  function mapInboxToPrimary(cat) {
    const m = {
      shopping: 'shopping', ticket: 'travel', bill: 'bills', payment: 'finance',
      subscription: 'subscriptions', other: 'other'
    };
    return m[cat] || 'other';
  }

  async function classifyEmail(mail, ctx) {
    const r = await analyseEmail(mail, ctx);
    return {
      category: r.category,
      inboxCategory: r.inboxCategory,
      secondary_categories: r.secondary_categories,
      intent: r.intent,
      confidence: r.confidence,
      explanation: r.summary,
      requires_confirmation: r.requires_confirmation,
      method: r.method,
      source: r.source,
      raw: r
    };
  }

  async function extractEmailInformation(mail, ctx) { return analyseEmail(mail, ctx); }
  async function detectEvents(mail, ctx) {
    const r = await analyseEmail(mail, ctx);
    return r.event;
  }
  async function detectReminders(mail, ctx) {
    const r = await analyseEmail(mail, ctx);
    return r.reminders || [];
  }
  async function detectBookingInformation(mail, ctx) {
    const r = await analyseEmail(mail, ctx);
    return r.travel;
  }
  async function detectOrderInformation(mail, ctx) {
    const r = await analyseEmail(mail, ctx);
    return r.order;
  }
  async function analyseEmailChanges(previous, next, ctx) {
    const a = previous || {};
    const b = next || {};
    const changes = [];
    const fields = [
      ['order.status', a.order?.status, b.order?.status],
      ['order.delivery_date', a.order?.delivery_date, b.order?.delivery_date],
      ['order.tracking_number', a.order?.tracking_number, b.order?.tracking_number],
      ['travel.status', a.travel?.status, b.travel?.status],
      ['travel.depart_datetime', a.travel?.depart_datetime, b.travel?.depart_datetime],
      ['travel.gate', a.travel?.gate, b.travel?.gate],
      ['event.start_datetime', a.event?.start_datetime, b.event?.start_datetime],
      ['intent', a.intent, b.intent]
    ];
    fields.forEach(([field, from, to]) => {
      if ((from || null) !== (to || null)) changes.push({ field, from: from || null, to: to || null });
    });
    return { changes, requires_confirmation: changes.some(c => /datetime|status|gate/.test(c.field)) };
  }

  /** Dedup key for orders / bookings across thread updates. */
  function entityKey(extraction, mail) {
    if (extraction?.order?.order_id) return 'order:' + extraction.order.order_id.toLowerCase();
    if (extraction?.order?.tracking_number) return 'track:' + extraction.order.tracking_number.toLowerCase();
    if (extraction?.travel?.pnr) return 'pnr:' + extraction.travel.pnr.toLowerCase();
    if (extraction?.travel?.flight_number && extraction?.travel?.depart_datetime) {
      return 'flight:' + extraction.travel.flight_number.replace(/\s+/g, '') + ':' + extraction.travel.depart_datetime.slice(0, 10);
    }
    if (extraction?.travel?.hotel_name && extraction?.travel?.check_in) {
      return 'hotel:' + String(extraction.travel.hotel_name).toLowerCase().replace(/\s+/g, '-') + ':' + extraction.travel.check_in;
    }
    if (extraction?.financial?.invoice_number) return 'invoice:' + String(extraction.financial.invoice_number).toLowerCase();
    if (mail?.threadId) return 'thread:' + mail.threadId;
    return 'mail:' + (mail?.id || mail?.mailId || 'unknown');
  }

  root.DaylightAI = {
    PRIMARY_CATEGORIES,
    INTENTS,
    INTENT_ALIASES,
    CATEGORY_ALIASES,
    INBOX_MAP,
    SYSTEM,
    SCHEMA_HINT,
    LS,
    getConsent, setConsent, isEnabled, setEnabled,
    allowedAccounts, setAllowedAccounts, accountAllowed,
    getStatus, setStatus, getUsage,
    shouldCallGemini,
    localHeuristicExtract,
    validateExtraction,
    normalizeIntent,
    normalizeCategory,
    buildPrompt,
    classifyEmail,
    extractEmailInformation,
    detectEvents,
    detectReminders,
    detectBookingInformation,
    detectOrderInformation,
    analyseEmailChanges,
    analyseEmail,
    entityKey,
    mapInboxToPrimary,
    parseJsonLoose
  };
})(typeof window !== 'undefined' ? window : globalThis);
