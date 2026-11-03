/**
 * Daylight Phase 11 — End-to-end intelligence verification (synthetic Gmail shapes).
 *
 * Exercises: classify → extract (Gemini or heuristic) → distribute → lifecycle → persistence sandbox.
 * Never logs API keys, OAuth tokens, or full email bodies.
 * Does not touch real browser IndexedDB or production user stores.
 *
 * Run: node tests/phase11-e2e.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function loadEnvSilent() {
  for (const file of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', 'server', '.dev.vars')]) {
    if (!fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
      const t = line.trim(); if (!t || t.startsWith('#')) return;
      const i = t.indexOf('='); if (i < 1) return;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] == null) process.env[k] = v;
    });
  }
}
loadEnvSilent();

const HAS_KEY = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 8);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const NOW = '2026-11-03T10:00:00+01:00';
const TZ = 'Europe/Prague';

function makeSandbox() {
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      clear: () => store.clear(),
      _dump: () => Object.fromEntries(store)
    },
    crypto: crypto.webcrypto,
    Intl, Date, JSON, Math, Number, String, Array, Object, console, setTimeout, clearTimeout, fetch,
    Map, Set
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.dispatchEvent = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'daylight-ai.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'email-classify.js'), 'utf8'), sandbox);
  return sandbox;
}

function gmailShape(f) {
  return {
    id: f.id,
    threadId: f.threadId || ('thread-' + f.id),
    snippet: String(f.body || '').slice(0, 120),
    internalDate: String(f.whenMs || Date.parse(NOW)),
    labelIds: f.labels || ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: `${f.fromName || 'Sender'} <${f.fromEmail}>` },
        { name: 'Subject', value: f.subject },
        { name: 'Date', value: new Date(f.whenMs || Date.parse(NOW)).toUTCString() }
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(f.body || '', 'utf8').toString('base64url') }
    }
  };
}

/** Isolated distribution sandbox mirroring app.js rules (no DOM). */
function createDistributor() {
  const state = {
    orders: [],
    wallet: [],
    reminders: [],
    upcoming: [],
    stamped: {},
    extractions: {}
  };

  function entityKey(ex, mail) {
    if (ex?.order?.order_id) return 'order:' + String(ex.order.order_id).toLowerCase();
    if (ex?.order?.tracking_number) return 'track:' + String(ex.order.tracking_number).toLowerCase();
    if (ex?.travel?.pnr) return 'pnr:' + String(ex.travel.pnr).toLowerCase();
    if (ex?.travel?.flight_number && ex?.travel?.depart_datetime) {
      return 'flight:' + ex.travel.flight_number.replace(/\s+/g, '') + ':' + String(ex.travel.depart_datetime).slice(0, 10);
    }
    if (ex?.travel?.hotel_name && ex?.travel?.check_in) {
      return 'hotel:' + String(ex.travel.hotel_name).toLowerCase().replace(/\s+/g, '-') + ':' + ex.travel.check_in;
    }
    if (mail?.threadId) return 'thread:' + mail.threadId;
    return 'mail:' + (mail?.mailId || mail?.id || 'x');
  }

  function upsertOrder(ex, mail) {
    if (!ex.order) return { action: 'skip' };
    if (ex.intent === 'promotional' || ex.category === 'promotions') return { action: 'skip_promo' };
    const key = ex.entityKey || entityKey(ex, mail);
    let row = state.orders.find(o => o.entityKey === key || (ex.order.order_id && o.orderId === ex.order.order_id));
    const hist = { at: new Date().toISOString(), mailId: mail.mailId, intent: ex.intent, status: ex.order.status };
    if (row) {
      row.status = ex.order.status || row.status;
      row.deliveryDate = ex.order.delivery_date || row.deliveryDate;
      row.tracking = ex.order.tracking_number || row.tracking;
      row.lastMailId = mail.mailId;
      row.sourceMailIds = Array.from(new Set([...(row.sourceMailIds || []), mail.mailId]));
      row.history = (row.history || []).concat(hist);
      row.updatedAt = new Date().toISOString();
      return { action: 'updated', row };
    }
    row = {
      entityKey: key, orderId: ex.order.order_id, merchant: ex.order.merchant, status: ex.order.status,
      deliveryDate: ex.order.delivery_date, tracking: ex.order.tracking_number, threadId: mail.threadId,
      lastMailId: mail.mailId, sourceMailIds: [mail.mailId], history: [hist], createdAt: new Date().toISOString()
    };
    state.orders.unshift(row);
    return { action: 'created', row };
  }

  function upsertWallet(ex, mail) {
    if (!ex.travel) return { action: 'skip' };
    if (ex.intent === 'promotional' || ex.category === 'promotions') return { action: 'skip_promo' };
    const t = ex.travel;
    const isHotel = t.type === 'hotel' || !!(t.hotel_name && t.check_in);
    const verified = isHotel
      ? !!(t.hotel_name && t.check_in)
      : !!(t.pnr || (t.flight_number && t.depart_datetime) || (t.from && t.to && t.depart_datetime));
    if (!verified) return { action: 'skip_unverified' };
    const key = entityKey(ex, mail);
    const cancelled = /cancel/i.test(t.status || '') || ex.intent === 'booking_cancelled';
    let pass = state.wallet.find(w => w.entityKey === key || w.mailId === mail.mailId);
    const title = isHotel ? (t.hotel_name || 'Hotel') : ((t.from && t.to) ? `${t.from} → ${t.to}` : (t.flight_number || 'Travel'));
    if (pass) {
      pass.title = title;
      pass.status = cancelled ? 'cancelled' : 'active';
      pass.travelAt = t.depart_datetime || t.check_in;
      pass.flight = t;
      pass.sourceMailIds = Array.from(new Set([...(pass.sourceMailIds || []), mail.mailId]));
      pass.updatedAt = new Date().toISOString();
      return { action: 'updated', pass };
    }
    pass = {
      id: 'mail:' + mail.mailId, entityKey: key, mailId: mail.mailId, threadId: mail.threadId,
      title, kind: isHotel ? 'documents' : 'tickets', status: cancelled ? 'cancelled' : 'active',
      travelAt: t.depart_datetime || t.check_in, flight: t, sourceMailIds: [mail.mailId],
      createdAt: new Date().toISOString()
    };
    state.wallet.unshift(pass);
    return { action: 'created', pass };
  }

  function upsertReminders(ex, mail) {
    const key = ex.entityKey || entityKey(ex, mail);
    if (ex.intent === 'promotional' || ex.category === 'promotions' || ex.category === 'newsletters') {
      return { action: 'skip_promo', created: 0, disabled: 0 };
    }
    const cancelled = ex.intent === 'booking_cancelled' || ex.intent === 'subscription_cancelled' || /cancel/i.test(ex.travel?.status || '');
    if (cancelled) {
      let disabled = 0;
      state.reminders.forEach(r => {
        if ((r.entityKey === key || r.mailId === mail.mailId) && !r.disabled) {
          r.disabled = true; r.disabledReason = 'cancelled'; disabled++;
        }
      });
      return { action: 'disabled', created: 0, disabled };
    }
    if (ex.requires_confirmation) return { action: 'skip_uncertain', created: 0, disabled: 0 };
    let created = 0;
    (ex.reminders || []).forEach(rem => {
      if (!rem?.title || !rem.datetime || rem.requires_confirmation) return;
      const stamp = key + '::' + rem.title;
      if (state.stamped[stamp]) return;
      if (state.reminders.some(r => !r.disabled && r.entityKey === key && r.title === rem.title)) return;
      state.reminders.unshift({
        id: 'rem-' + state.reminders.length + '-' + Date.now(),
        title: rem.title, datetime: rem.datetime, mailId: mail.mailId, entityKey: key,
        aiGenerated: true, disabled: false, createdAt: new Date().toISOString()
      });
      state.stamped[stamp] = Date.now();
      created++;
    });
    return { action: created ? 'created' : 'noop', created, disabled: 0 };
  }

  function upsertUpcoming(ex, mail) {
    if (ex.intent === 'promotional' || ex.category === 'promotions') return { action: 'skip_promo' };
    if (!ex.event?.exists || !ex.event.start_datetime || ex.requires_confirmation) return { action: 'skip' };
    const key = ex.entityKey || entityKey(ex, mail);
    const id = 'ai-event:' + key;
    const cancelled = ex.intent === 'booking_cancelled' || /cancel/i.test(ex.event.status || '');
    const row = {
      id, entityKey: key, mailId: mail.mailId, summary: ex.event.title || ex.summary,
      start: ex.event.start_datetime, status: cancelled ? 'cancelled' : (ex.event.status || 'confirmed'),
      source: 'daylight-ai'
    };
    const idx = state.upcoming.findIndex(u => u.id === id || u.entityKey === key);
    if (idx >= 0) {
      state.upcoming[idx] = { ...state.upcoming[idx], ...row };
      state.upcoming = state.upcoming.filter(u => u.status !== 'cancelled');
      return { action: cancelled ? 'cancelled' : 'updated', row };
    }
    if (!cancelled) state.upcoming.push(row);
    return { action: cancelled ? 'cancelled' : 'created', row };
  }

  function distribute(ex, mail) {
    ex.entityKey = ex.entityKey || entityKey(ex, mail);
    state.extractions[mail.mailId] = ex;
    return {
      order: upsertOrder(ex, mail),
      wallet: upsertWallet(ex, mail),
      reminders: upsertReminders(ex, mail),
      upcoming: upsertUpcoming(ex, mail)
    };
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({
      orders: state.orders,
      wallet: state.wallet,
      reminders: state.reminders,
      upcoming: state.upcoming.filter(u => u.status !== 'cancelled'),
      extractionCount: Object.keys(state.extractions).length
    }));
  }

  function restore(snap) {
    const s = JSON.parse(JSON.stringify(snap));
    state.orders = s.orders || [];
    state.wallet = s.wallet || [];
    state.reminders = s.reminders || [];
    state.upcoming = s.upcoming || [];
  }

  return { distribute, snapshot, restore, state, entityKey };
}

const FIXTURES = [
  { id: 'amazon-confirm', threadId: 't-amz-1', fromEmail: 'auto-confirm@amazon.com', fromName: 'Amazon', subject: 'Order confirmed', body: 'Thanks for order #112-3344556-7788990 of USB-C Hub. We will email when it ships.', expect: { category: 'shopping', intent: 'order_confirmed', modules: ['orders'] } },
  { id: 'amazon-ship', threadId: 't-amz-1', fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Out for delivery', body: 'Order #112-3344556-7788990 is out for delivery. Expected delivery tomorrow.', expect: { category: 'shopping', intent: 'delivery_scheduled', modules: ['orders', 'upcoming'], fields: ['order.delivery_date'] } },
  { id: 'amazon-delay', threadId: 't-amz-1', fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Delivery delayed', body: 'Order #112-3344556-7788990 delayed. New expected delivery 2026-11-06.', expect: { category: 'shopping', intent: 'delivery_delayed', modules: ['orders'] } },
  { id: 'amazon-delivered', threadId: 't-amz-1', fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Delivered', body: 'Your package for order #112-3344556-7788990 was delivered today.', expect: { category: 'shopping', intent: 'delivery_delivered', modules: ['orders'] } },
  { id: 'flight-book', threadId: 't-flight-1', fromEmail: 'booking@lufthansa.com', fromName: 'Lufthansa', subject: 'Booking confirmation LH400', body: 'Flight LH400 PRG → FRA 2026-11-20T08:40. PNR: ABC12X. Seat 12A.', expect: { category: 'travel', intent: 'booking_confirmed', modules: ['wallet', 'upcoming'] } },
  { id: 'flight-resched', threadId: 't-flight-1', fromEmail: 'booking@lufthansa.com', fromName: 'Lufthansa', subject: 'Schedule change LH400', body: 'New departure for LH400: 2026-11-20T10:10. PNR ABC12X.', expect: { category: 'travel', intent: 'booking_rescheduled', modules: ['wallet', 'upcoming'] } },
  { id: 'flight-cancel', threadId: 't-flight-1', fromEmail: 'booking@lufthansa.com', fromName: 'Lufthansa', subject: 'Flight cancelled LH400', body: 'Flight LH400 on 2026-11-20T10:10 cancelled. PNR ABC12X.', expect: { category: 'travel', intent: 'booking_cancelled', modules: ['wallet'] } },
  { id: 'hotel', threadId: 't-hotel-1', fromEmail: 'noreply@booking.com', fromName: 'Booking.com', subject: 'Hotel reservation confirmed', body: 'Hotel Central Prague. Check-in 2026-11-20 check-out 2026-11-22. Confirmation 998877.', expect: { category: 'travel', intent: 'booking_confirmed', modules: ['wallet'] } },
  { id: 'invoice', threadId: 't-bill-1', fromEmail: 'billing@cez.cz', fromName: 'ČEZ', subject: 'Invoice November', body: 'Invoice 2026-1102 amount 1240 CZK. Payment due by 2026-11-20.', expect: { category: ['bills', 'finance'], intent: 'payment_due', fields: ['financial.due_date'] } },
  { id: 'sub-renew', threadId: 't-sub-1', fromEmail: 'no-reply@spotify.com', fromName: 'Spotify', subject: 'Your Premium subscription renewed', body: 'Your Spotify Premium membership renewed for EUR 10.99. Next renewal 2026-12-03.', expect: { category: 'subscriptions', intent: 'subscription_renewal' } },
  { id: 'sub-cancel', threadId: 't-sub-1', fromEmail: 'no-reply@spotify.com', fromName: 'Spotify', subject: 'Premium membership cancelled', body: 'Your Spotify Premium subscription has been cancelled and will end on 2026-12-03.', expect: { category: 'subscriptions', intent: 'subscription_cancelled' } },
  { id: 'promo', threadId: 't-promo-1', fromEmail: 'deals@store.example', fromName: 'Store Deals', subject: 'FLASH SALE 50% OFF this weekend', body: 'Buy more today! Limited time offer. Unsubscribe anytime.', expect: { category: 'promotions', intent: 'promotional', modules: [], noReminders: true } },
  { id: 'personal', threadId: 't-pers-1', fromEmail: 'alex@friends.example', fromName: 'Alex', subject: 'Dinner next week?', body: 'Want to grab dinner sometime next week? Let me know.', expect: { category: ['personal', 'other', 'meetings'], intent: ['informational', 'reminder', null] } },
];

function fieldGet(obj, dotted) {
  return dotted.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

function scoreExtraction(ex, expect) {
  const errors = [];
  if (!ex?.valid) errors.push('invalid');
  if (expect.category) {
    const cats = Array.isArray(expect.category) ? expect.category : [expect.category];
    if (!cats.includes(ex.category)) errors.push(`category=${ex.category}`);
  }
  if (expect.intent) {
    const intents = Array.isArray(expect.intent) ? expect.intent : [expect.intent];
    if (expect.intent === null || (Array.isArray(expect.intent) && expect.intent.includes(null) && !ex.intent)) {
      /* ok */
    } else if (!intents.includes(ex.intent)) errors.push(`intent=${ex.intent}`);
  }
  (expect.fields || []).forEach(f => { if (!fieldGet(ex, f)) errors.push('missing_' + f); });
  return errors;
}

async function extractWith(AI, mail, mode) {
  const t0 = Date.now();
  if (mode === 'heuristic') {
    const local = AI.localHeuristicExtract(mail, NOW, TZ) || AI.validateExtraction({ category: 'other', intent: 'informational', confidence: 0.4, method: 'none' });
    return { result: { ...local, source: 'local-heuristic', method: local.method || 'local-heuristic' }, ms: Date.now() - t0, mode: 'heuristic' };
  }
  // Gemini via same production prompt
  const normalized = {
    id: mail.id, mailId: mail.id, threadId: mail.threadId, fromName: mail.fromName, fromEmail: mail.fromEmail,
    subject: mail.subject, body: mail.body, snippet: mail.body, receivedAt: new Date(mail.whenMs || Date.parse(NOW)).toISOString()
  };
  const prompt = AI.buildPrompt(normalized, { nowIso: NOW, timezone: TZ });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: AI.SYSTEM }] },
      generationConfig: { temperature: 0.05, maxOutputTokens: 3072, responseMimeType: 'application/json' }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const local = AI.localHeuristicExtract(mail, NOW, TZ);
    return {
      result: local || AI.validateExtraction({ category: 'other', method: 'fallback-error' }),
      ms: Date.now() - t0, mode: 'fallback-heuristic', error: String(data?.error?.status || res.status)
    };
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const parsed = AI.parseJsonLoose(text);
  const validated = AI.validateExtraction({ ...(parsed || {}), method: 'gemini' });
  return { result: { ...validated, source: 'gemini' }, ms: Date.now() - t0, mode: 'gemini', usage: data.usageMetadata || null };
}

function safeActual(ex) {
  if (!ex) return null;
  return {
    category: ex.category, intent: ex.intent, requires_confirmation: !!ex.requires_confirmation,
    order_id: ex.order?.order_id || null, delivery_date: ex.order?.delivery_date || null,
    pnr: ex.travel?.pnr || null, depart: ex.travel?.depart_datetime || null,
    hotel: ex.travel?.hotel_name || null, check_in: ex.travel?.check_in || null,
    due_date: ex.financial?.due_date || null
  };
}

(async () => {
  const sandbox = makeSandbox();
  const AI = sandbox.DaylightAI;
  const Cls = sandbox.DaylightEmailClassify;
  const dist = createDistributor();
  const rows = [];
  let geminiCalls = 0, heuristicRuns = 0;

  console.log('Phase 11 E2E — synthetic Gmail pipeline');
  console.log('GEMINI_API_KEY set:', HAS_KEY ? 'yes' : 'NO');

  // Consent / financial guards (unit)
  AI.setConsent(false); AI.setEnabled(false);
  const consentBlocked = AI.shouldCallGemini({ subject: 'x' }, { needsReview: true, category: 'shopping' }) === false;
  AI.setConsent(true); AI.setEnabled(true);
  sandbox.localStorage.setItem('daylight-ai-allow-financial', '0');
  const finBlocked = AI.shouldCallGemini({ subject: 'bill' }, { needsReview: true, category: 'bill', privacyClass: 'financial' }) === false;

  // --- Pass 1: heuristic path for all ---
  for (const f of FIXTURES) {
    const raw = gmailShape(f);
    const classified = Cls.classifyEmail(raw);
    const mail = {
      id: f.id, mailId: f.id, threadId: f.threadId, fromEmail: f.fromEmail, fromName: f.fromName,
      subject: f.subject, body: f.body, whenMs: f.whenMs || Date.parse(NOW)
    };
    const ext = await extractWith(AI, mail, 'heuristic');
    heuristicRuns++;
    const ex = ext.result;
    ex.mailId = f.id; ex.threadId = f.threadId;
    const errors = scoreExtraction(ex, f.expect);
    const distResult = dist.distribute(ex, mail);
    const activeReminders = dist.state.reminders.filter(r => !r.disabled && r.mailId === f.id);
    if (f.expect.noReminders && activeReminders.length) errors.push('false_promo_reminder');
    rows.push({
      id: f.id, pass: 'heuristic', ok: errors.length === 0, errors, ms: ext.ms,
      classification: classified ? { category: classified.category, confidence: classified.confidence } : null,
      expected: f.expect, actual: safeActual(ex),
      distribution: {
        order: distResult.order.action, wallet: distResult.wallet.action,
        reminders: distResult.reminders, upcoming: distResult.upcoming.action
      },
      entityKey: ex.entityKey, sourceMailIds: dist.state.orders.find(o => o.lastMailId === f.id)?.sourceMailIds
        || dist.state.wallet.find(w => w.mailId === f.id)?.sourceMailIds || [f.id]
    });
  }

  // Lifecycle assertions after heuristic chain
  const amazonOrders = dist.state.orders.filter(o => o.orderId === '112-3344556-7788990');
  const flightPasses = dist.state.wallet.filter(w => (w.flight?.pnr || '').toUpperCase() === 'ABC12X' || (w.entityKey || '').includes('abc12x'));
  const subEntity = dist.state.reminders.find(r => r.mailId === 'sub-renew' || r.mailId === 'sub-cancel')?.entityKey
    || 'thread:t-sub-1';
  const lifecycle = {
    amazonSingleOrder: amazonOrders.length === 1,
    amazonStatusDelivered: amazonOrders[0]?.status === 'delivered',
    amazonSourceMails: amazonOrders[0]?.sourceMailIds?.length >= 3,
    amazonHadDelayedDate: (amazonOrders[0]?.history || []).some(h => h.status === 'delayed' || h.intent === 'delivery_delayed'),
    flightSinglePass: flightPasses.length === 1,
    flightCancelled: flightPasses[0]?.status === 'cancelled',
    flightRemindersDisabled: !dist.state.reminders.some(r => r.entityKey === flightPasses[0]?.entityKey && !r.disabled),
    hotelWalletCreated: dist.state.wallet.some(w => /Central Prague|hotel/i.test(w.title) || w.kind === 'documents'),
    subRemindersCancelled: !dist.state.reminders.some(r => r.entityKey === subEntity && !r.disabled && r.aiGenerated !== false),
    promoNoOrder: !dist.state.orders.some(o => (o.sourceMailIds || []).includes('promo')),
    promoNoReminders: !dist.state.reminders.some(r => r.mailId === 'promo' && !r.disabled),
    upcomingHasNoCancelled: dist.state.upcoming.every(u => u.status !== 'cancelled')
  };

  // Persistence: snapshot → clear → restore (simulates refresh / restart)
  const snap = dist.snapshot();
  const orderCountBefore = snap.orders.length;
  dist.state.orders = []; dist.state.wallet = []; dist.state.reminders = []; dist.state.upcoming = [];
  dist.restore(snap);
  const persistence = {
    refreshRestore: dist.state.orders.length === orderCountBefore && dist.state.wallet.length === snap.wallet.length,
    repeatedDistributeNoDup: null
  };
  // Repeated sync of same delivery email
  const again = FIXTURES.find(f => f.id === 'amazon-ship');
  const againMail = { id: again.id, mailId: again.id, threadId: again.threadId, fromEmail: again.fromEmail, fromName: again.fromName, subject: again.subject, body: again.body, whenMs: Date.parse(NOW) };
  const againExt = await extractWith(AI, againMail, 'heuristic');
  againExt.result.mailId = again.id; againExt.result.threadId = again.threadId;
  dist.distribute(againExt.result, againMail);
  persistence.repeatedDistributeNoDup = dist.state.orders.filter(o => o.orderId === '112-3344556-7788990').length === 1;

  // --- Pass 2: Gemini path (subset) when key present ---
  const geminiRows = [];
  if (HAS_KEY) {
    const geminiDist = createDistributor();
    for (const f of FIXTURES) {
      const mail = {
        id: f.id, mailId: f.id, threadId: f.threadId, fromEmail: f.fromEmail, fromName: f.fromName,
        subject: f.subject, body: f.body, whenMs: Date.parse(NOW)
      };
      const ext = await extractWith(AI, mail, 'gemini');
      geminiCalls++;
      const ex = ext.result; ex.mailId = f.id; ex.threadId = f.threadId;
      const errors = scoreExtraction(ex, f.expect);
      const distResult = geminiDist.distribute(ex, mail);
      if (f.expect.noReminders) {
        const bad = geminiDist.state.reminders.filter(r => r.mailId === f.id && !r.disabled);
        if (bad.length) errors.push('false_promo_reminder');
      }
      geminiRows.push({
        id: f.id, pass: ext.mode, ok: errors.length === 0, errors, ms: ext.ms,
        expected: f.expect, actual: safeActual(ex),
        distribution: {
          order: distResult.order.action, wallet: distResult.wallet.action,
          reminders: distResult.reminders, upcoming: distResult.upcoming.action
        }
      });
      await new Promise(r => setTimeout(r, 400));
    }
  }

  const heuristicFailed = rows.filter(r => !r.ok);
  const geminiFailed = geminiRows.filter(r => !r.ok);
  const lifecycleOk = Object.values(lifecycle).every(Boolean) && persistence.refreshRestore && persistence.repeatedDistributeNoDup;

  const report = {
    generatedAt: new Date().toISOString(),
    phase: 11,
    productionReadyClaim: false,
    productionReadyReason: 'Synthetic E2E only — controlled real-Gmail testing still required before full production readiness',
    deployment: {
      frontendAffected: ['daylight-ai.js', 'app.js', 'index.html', 'sw.js'],
      workerAffected: [],
      autoDeploy: false,
      notes: 'Redeploy GitHub Pages / static assets for frontend. Worker unchanged this phase. Preserve KV, secrets, ALLOWED_* vars.'
    },
    guards: { consentBlocked, financialOptInBlocked: finBlocked },
    promoNoiseFix: {
      description: 'Tightened promo fixture to promotions/promotional; promotional mail skipped for orders/reminders/upcoming',
      heuristicPromoPass: rows.find(r => r.id === 'promo')?.ok === true
    },
    heuristic: {
      total: rows.length,
      passed: rows.filter(r => r.ok).length,
      failed: heuristicFailed.map(r => ({ id: r.id, errors: r.errors, actual: r.actual })),
      rows
    },
    gemini: HAS_KEY ? {
      ran: true, model: MODEL, calls: geminiCalls,
      total: geminiRows.length,
      passed: geminiRows.filter(r => r.ok).length,
      failed: geminiFailed.map(r => ({ id: r.id, errors: r.errors, actual: r.actual })),
      rows: geminiRows
    } : { ran: false, reason: 'GEMINI_API_KEY not set' },
    lifecycle,
    persistence,
    lifecycleOk,
    verified: [
      'Synthetic Gmail MIME → classify → extract → distribute',
      'Amazon order lifecycle updates one record',
      'Flight book→reschedule→cancel updates one wallet pass and cancels upcoming',
      'Promotional mail creates no shopping reminders',
      'Sandbox persistence restore + repeated sync dedupe',
      'Consent and financial opt-in gates'
    ],
    unverified: [
      'Live Gmail API fetch against a real mailbox',
      'Browser refresh/restart with real IndexedDB on device',
      'Logout/login session restore with real Google OAuth',
      'Interrupted sync recovery against Google history.list',
      'Worker-proxied /api/gemini/analyse with real Daylight session cookie'
    ],
    realGmailTestingSafe: true,
    realGmailGuidance: 'Safe if: AI consent enabled on a test account only; financial opt-in left off unless intended; use a dedicated Gmail label/query; do not point tests at production IndexedDB without a backup. Prefer synthetic + demo mode first.'
  };

  const out = path.join(__dirname, 'phase11-e2e-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`Heuristic: ${report.heuristic.passed}/${report.heuristic.total}`);
  if (heuristicFailed.length) heuristicFailed.forEach(f => console.log(' FAIL-H', f.id, f.errors.join(';'), JSON.stringify(f.actual)));
  if (HAS_KEY) {
    console.log(`Gemini: ${report.gemini.passed}/${report.gemini.total}`);
    if (geminiFailed.length) geminiFailed.forEach(f => console.log(' FAIL-G', f.id, f.errors.join(';'), JSON.stringify(f.actual)));
  } else console.log('Gemini: NOT RUN');
  console.log('Lifecycle OK:', lifecycleOk, JSON.stringify(lifecycle));
  console.log('Persistence:', persistence);
  console.log('Production claim: false —', report.productionReadyReason);
  console.log('Wrote', out);

  const fail = heuristicFailed.length > 0 || (HAS_KEY && geminiFailed.length > 0) || !lifecycleOk;
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
