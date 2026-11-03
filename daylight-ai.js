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

  const PRIMARY_CATEGORIES = Object.freeze([
    'shopping', 'travel', 'finance', 'bills', 'subscriptions', 'work', 'meetings',
    'personal', 'social', 'education', 'health', 'documents', 'government',
    'delivery', 'security', 'promotions', 'newsletters', 'other'
  ]);

  const INTENTS = Object.freeze([
    'order_confirmation', 'order_shipped', 'delivery_update', 'delivery_delayed', 'delivered',
    'flight_booking', 'hotel_booking', 'train_booking', 'payment_due', 'payment_completed',
    'invoice_received', 'subscription_renewal', 'subscription_cancelled', 'appointment',
    'meeting_invitation', 'event_invitation', 'refund', 'cancellation', 'rescheduling',
    'deadline', 'action_required', 'informational', 'marketing'
  ]);

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

  const SYSTEM = `You are Daylight's email intelligence engine.
Return ONLY valid JSON matching the schema. Never invent facts.
Use null for unknown fields. Distinguish email received date from event/delivery/booking dates.
Never use the email received date as a substitute for an unknown event date.
If a date is ambiguous, set requires_confirmation true and explain in evidence.
Pass current_datetime and timezone from the user message as the reference "now".`;

  const SCHEMA_HINT = `{
  "category": one of ${JSON.stringify(PRIMARY_CATEGORIES)},
  "secondary_categories": [],
  "intent": one of ${JSON.stringify(INTENTS)} or null,
  "organisation": string|null,
  "summary": short string,
  "entities": [{"type":"string","value":"string","quoted_text":"string|null"}],
  "event": {"exists":boolean,"type":string|null,"title":string|null,"start_datetime":string|null,"end_datetime":string|null,"timezone":string|null,"all_day":boolean,"location":string|null,"status":string|null}|null,
  "order": {"merchant":string|null,"order_id":string|null,"tracking_number":string|null,"delivery_date":string|null,"status":string|null,"items":[]}|null,
  "travel": {"type":"flight|hotel|train|other"|null,"pnr":string|null,"flight_number":string|null,"from":string|null,"to":string|null,"depart_datetime":string|null,"arrive_datetime":string|null,"seat":string|null,"gate":string|null,"hotel_name":string|null,"check_in":string|null,"check_out":string|null,"status":string|null}|null,
  "financial": {"amount":string|null,"currency":string|null,"due_date":string|null,"status":string|null}|null,
  "reminders": [{"title":string,"datetime":string|null,"reason":string|null,"requires_confirmation":boolean}],
  "suggested_actions": [{"action":string,"label":string|null}],
  "confidence": 0-1 number,
  "evidence": [{"field":string,"quoted_text":string}],
  "requires_confirmation": boolean,
  "facts_vs_inferred": {"facts":[string],"inferred":[string],"unknown":[string]}
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

  function validateExtraction(raw) {
    if (!raw || typeof raw !== 'object') return emptyResult({ valid: false, error: 'not_object' });
    let category = String(raw.category || 'other').toLowerCase().replace(/\s+/g, '_');
    if (category === 'government_and_administration') category = 'government';
    if (category === 'delivery_and_logistics') category = 'delivery';
    if (category === 'security_and_account_alerts') category = 'security';
    if (!PRIMARY_CATEGORIES.includes(category)) category = 'other';

    let intent = raw.intent == null ? null : String(raw.intent).toLowerCase();
    if (intent && !INTENTS.includes(intent)) intent = 'informational';

    const event = raw.event && typeof raw.event === 'object' ? {
      exists: !!raw.event.exists,
      type: asStr(raw.event.type),
      title: asStr(raw.event.title),
      start_datetime: asStr(raw.event.start_datetime),
      end_datetime: asStr(raw.event.end_datetime),
      timezone: asStr(raw.event.timezone),
      all_day: !!raw.event.all_day,
      location: asStr(raw.event.location),
      status: asStr(raw.event.status)
    } : null;

    // Never accept event that only mirrors "received" without a real start
    if (event && event.exists && !event.start_datetime) {
      event.exists = false;
      raw.requires_confirmation = true;
    }

    const order = raw.order && typeof raw.order === 'object' ? {
      merchant: asStr(raw.order.merchant),
      order_id: asStr(raw.order.order_id),
      tracking_number: asStr(raw.order.tracking_number),
      delivery_date: asStr(raw.order.delivery_date),
      status: asStr(raw.order.status),
      items: asArray(raw.order.items)
    } : null;

    const travel = raw.travel && typeof raw.travel === 'object' ? {
      type: asStr(raw.travel.type),
      pnr: asStr(raw.travel.pnr),
      flight_number: asStr(raw.travel.flight_number),
      from: asStr(raw.travel.from),
      to: asStr(raw.travel.to),
      depart_datetime: asStr(raw.travel.depart_datetime),
      arrive_datetime: asStr(raw.travel.arrive_datetime),
      seat: asStr(raw.travel.seat),
      gate: asStr(raw.travel.gate),
      hotel_name: asStr(raw.travel.hotel_name),
      check_in: asStr(raw.travel.check_in),
      check_out: asStr(raw.travel.check_out),
      status: asStr(raw.travel.status)
    } : null;

    const financial = raw.financial && typeof raw.financial === 'object' ? {
      amount: asStr(raw.financial.amount),
      currency: asStr(raw.financial.currency),
      due_date: asStr(raw.financial.due_date),
      status: asStr(raw.financial.status)
    } : null;

    const reminders = asArray(raw.reminders).map(r => ({
      title: String(r?.title || '').slice(0, 160),
      datetime: asStr(r?.datetime),
      reason: asStr(r?.reason),
      requires_confirmation: r?.requires_confirmation !== false && (!r?.datetime || !!raw.requires_confirmation)
    })).filter(r => r.title);

    const confidence = asNum01(raw.confidence);
    const requires_confirmation = !!raw.requires_confirmation || confidence < 0.72 ||
      (event?.exists && !event.start_datetime) ||
      reminders.some(r => !r.datetime);

    const out = {
      category,
      secondary_categories: asArray(raw.secondary_categories).map(String).filter(c => PRIMARY_CATEGORIES.includes(c)),
      intent,
      organisation: asStr(raw.organisation),
      summary: String(raw.summary || '').slice(0, 280),
      entities: asArray(raw.entities).slice(0, 40).map(e => ({
        type: String(e?.type || 'unknown'),
        value: String(e?.value || ''),
        quoted_text: asStr(e?.quoted_text)
      })).filter(e => e.value),
      event: event && event.exists ? event : (event ? { ...event, exists: false } : null),
      order: order && (order.merchant || order.order_id || order.tracking_number || order.delivery_date) ? order : null,
      travel: travel && (travel.pnr || travel.flight_number || travel.from || travel.to || travel.hotel_name || travel.check_in) ? travel : null,
      financial: financial && (financial.amount || financial.due_date) ? financial : null,
      reminders,
      suggested_actions: asArray(raw.suggested_actions).slice(0, 8).map(a => ({
        action: String(a?.action || ''),
        label: asStr(a?.label)
      })).filter(a => a.action),
      confidence,
      evidence: asArray(raw.evidence).slice(0, 30).map(e => ({
        field: String(e?.field || ''),
        quoted_text: String(e?.quoted_text || '')
      })).filter(e => e.field && e.quoted_text),
      requires_confirmation,
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

  /** Level-1 style local enrichment for high-signal templates (no network). */
  function localHeuristicExtract(mail, nowIso, tz) {
    const subject = String(mail.subject || '');
    const body = String(mail.body || mail.snippet || '');
    const text = `${subject}\n${body}`;
    const from = String(mail.fromEmail || mail.from || '').toLowerCase();
    const org = (mail.fromName || from.split('@')[0] || '').replace(/[^a-zA-Z0-9 ._-]/g, '').trim() || null;

    // Shopping / delivery (Amazon, eBay, and generic order templates)
    const shopHit = /amazon\.|ship-confirm@amazon|auto-confirm@amazon|@ebay\.|ebay@/i.test(from)
      || /\b(amazon|ebay|aliexpress|order (confirmed|shipped)|your (package|order)|bestellung|objednávka)\b/i.test(subject + ' ' + body);
    if (shopHit) {
      let intent = 'order_confirmation';
      let status = 'ordered';
      if (/\b(out for delivery|arriving (today|tomorrow)|expected delivery|lieferung|doruč)\b/i.test(text)) { intent = 'delivery_update'; status = 'out_for_delivery'; }
      if (/\b(delayed|running late|delivery (date )?changed)\b/i.test(text)) { intent = 'delivery_delayed'; status = 'delayed'; }
      if (/\b(delivered|was delivered|left at|zugestellt|doručeno)\b/i.test(text)) { intent = 'delivered'; status = 'delivered'; }
      if (/\brefund\b/i.test(text)) { intent = 'refund'; status = 'refunded'; }
      if (/\b(shipped|dispatched|on its way|tracking|versandt|odeslán)\b/i.test(text) && intent === 'order_confirmation') { intent = 'order_shipped'; status = 'shipped'; }
      const orderId = (text.match(/\b(?:order|bestellung|#)\s*([A-Z0-9-]{6,})\b/i) || [])[1] || null;
      const tracking = (text.match(/\b(?:tracking(?:\s*(?:number|no\.?#?))?)[:\s#]*([A-Z0-9]{8,})\b/i) || [])[1] || null;
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
      const pnr = (text.match(/\b(?:PNR|booking\s*(?:ref|reference|code)|confirmation(?:\s*(?:code|number))?)\s*[:#]?\s*([A-Z0-9]{5,8})\b/i) || [])[1]
        || (/\b(?:PNR|booking ref)\b/i.test(text) ? (text.match(/\b([A-Z0-9]{6})\b/) || [])[1] : null)
        || null;
      const route = text.match(/\b([A-Z]{3})\s*(?:→|->|to)\s*([A-Z]{3})\b/)
        || text.match(/\b([A-ZÁ-ž][A-ZÁ-ža-z .'-]{2,20})\s*(?:→|->|to)\s*([A-ZÁ-ž][A-ZÁ-ža-z .'-]{2,20})\b/);
      const departIso = (text.match(/\b(20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)\b/) || [])[1] || null;
      const checkIn = (text.match(/\bcheck-?in\s*(?:on\s*)?(20\d{2}-\d{2}-\d{2})/i) || [])[1] || null;
      const checkOut = (text.match(/\bcheck-?out\s*(?:on\s*)?(20\d{2}-\d{2}-\d{2})/i) || [])[1] || null;
      const seat = (text.match(/\bseat\s*([A-Z]?\d{1,2}[A-Z]?)\b/i) || [])[1] || null;
      const hotelName = isHotel ? ((text.match(/\bHotel\s+([A-ZÁ-ž][\w .'-]{2,40})/i) || [])[1] || org) : null;
      let intent = isHotel ? 'hotel_booking' : isTrain ? 'train_booking' : 'flight_booking';
      if (cancelled) intent = 'cancellation';
      else if (resched) intent = 'rescheduling';
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
${String(mail.body || mail.snippet || '').slice(0, 6000)}

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

    // Prefer local high-confidence for known templates to save cost
    if (local && local.confidence >= 0.84 && !shouldForceGemini(ctx)) {
      setStatus(local.intent === 'flight_booking' ? 'Booking detected' : 'Delivery date extracted', local.summary);
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
    const hash = await sha256Hex(prompt);
    const cached = cacheGet(hash);
    if (cached) {
      setStatus('Analysed (cached)', cached.summary);
      return { ...cached, source: 'cache' };
    }

    try {
      const data = await callWorker(serverUrl, session, prompt, ctx);
      trackUsage(data.usage);
      const parsed = parseJsonLoose(data.text);
      const validated = validateExtraction({ ...(parsed || {}), method: 'gemini' });
      if (!validated.valid) throw new Error('invalid_schema');
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
    if (mail?.threadId) return 'thread:' + mail.threadId;
    return 'mail:' + (mail?.id || mail?.mailId || 'unknown');
  }

  root.DaylightAI = {
    PRIMARY_CATEGORIES,
    INTENTS,
    INBOX_MAP,
    LS,
    getConsent, setConsent, isEnabled, setEnabled,
    allowedAccounts, setAllowedAccounts, accountAllowed,
    getStatus, setStatus, getUsage,
    shouldCallGemini,
    localHeuristicExtract,
    validateExtraction,
    classifyEmail,
    extractEmailInformation,
    detectEvents,
    detectReminders,
    detectBookingInformation,
    detectOrderInformation,
    analyseEmailChanges,
    analyseEmail,
    entityKey,
    mapInboxToPrimary
  };
})(typeof window !== 'undefined' ? window : globalThis);
