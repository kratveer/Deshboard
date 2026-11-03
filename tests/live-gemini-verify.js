/**
 * Daylight Phase 10 — Live Gemini semantic verification.
 *
 * A) Local heuristics  B) Live Gemini (same prompt as production)  C) Worker/consent  D) Lifecycle
 * Never logs API keys, tokens, or full email bodies.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function loadEnvFilesSilent() {
  const files = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.dev.vars'),
    path.join(__dirname, '..', 'server', '.env'),
    path.join(__dirname, '..', 'server', '.dev.vars')
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if (i < 1) return;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] == null) process.env[k] = v;
    });
  }
}
loadEnvFilesSilent();

const WORKER = (process.env.DAYLIGHT_API || 'https://daylight-api.kratveer050.workers.dev').replace(/\/+$/, '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 8);
const NOW = '2026-11-03T10:00:00+01:00';
const TZ = 'Europe/Prague';

function loadAI() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'daylight-ai.js'), 'utf8');
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    crypto: crypto.webcrypto,
    Intl, Date, JSON, Math, Number, String, Array, Object, console,
    setTimeout, clearTimeout, fetch
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.dispatchEvent = () => {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { AI: sandbox.DaylightAI, ls: sandbox.localStorage };
}

const { AI, ls } = loadAI();

const FIXTURES = [
  { id: 'amazon-confirm', expect: { category: 'shopping', intent: 'order_confirmed', fields: ['order.order_id'] },
    mail: { fromEmail: 'auto-confirm@amazon.com', fromName: 'Amazon', subject: 'Order confirmed', body: 'Thanks for order #112-3344556-7788990 of USB-C Hub. We will email when it ships.', whenMs: Date.parse(NOW) } },
  { id: 'amazon-delivery', expect: { category: ['shopping', 'delivery'], intent: ['delivery_scheduled', 'order_shipped'], fields: ['order.delivery_date'] },
    mail: { fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Out for delivery', body: 'Order #112-3344556-7788990 is out for delivery. Expected delivery tomorrow.', whenMs: Date.parse(NOW) } },
  { id: 'amazon-delay', expect: { category: ['shopping', 'delivery'], intent: 'delivery_delayed', fields: ['order.delivery_date'] },
    mail: { fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Delivery delayed', body: 'Order #112-3344556-7788990 delayed. New expected delivery 2026-11-06.', whenMs: Date.parse(NOW) } },
  { id: 'amazon-delivered', expect: { category: ['shopping', 'delivery'], intent: 'delivery_delivered' },
    mail: { fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Delivered', body: 'Your package for order #112-3344556-7788990 was delivered today.', whenMs: Date.parse(NOW) } },
  { id: 'flight-booking', expect: { category: 'travel', intent: 'booking_confirmed', fields: ['travel.pnr', 'travel.depart_datetime'] },
    mail: { fromEmail: 'booking@lufthansa.com', fromName: 'Lufthansa', subject: 'Booking confirmation LH400', body: 'Flight LH400 PRG → FRA 2026-11-20T08:40. PNR: ABC12X. Seat 12A.', whenMs: Date.parse(NOW) } },
  { id: 'flight-cancel', expect: { category: 'travel', intent: 'booking_cancelled' },
    mail: { fromEmail: 'booking@lufthansa.com', fromName: 'Lufthansa', subject: 'Flight cancelled LH400', body: 'Flight LH400 on 2026-11-20T08:40 cancelled. PNR ABC12X.', whenMs: Date.parse(NOW) } },
  { id: 'flight-reschedule', expect: { category: 'travel', intent: 'booking_rescheduled', fields: ['travel.depart_datetime'] },
    mail: { fromEmail: 'updates@ryanair.com', fromName: 'Ryanair', subject: 'Schedule change FR1234', body: 'New departure for FR1234: 2026-12-01T06:15. Booking ref ZY9876.', whenMs: Date.parse(NOW) } },
  { id: 'hotel', expect: { category: 'travel', intent: 'booking_confirmed', fields: ['travel.check_in'] },
    mail: { fromEmail: 'noreply@booking.com', fromName: 'Booking.com', subject: 'Hotel reservation confirmed', body: 'Hotel Central Prague. Check-in 2026-11-20 check-out 2026-11-22. Confirmation 998877.', whenMs: Date.parse(NOW) } },
  { id: 'invoice', expect: { category: ['bills', 'finance'], intent: 'payment_due', fields: ['financial.due_date'] }, geminiOnly: true,
    mail: { fromEmail: 'billing@cez.cz', fromName: 'ČEZ', subject: 'Invoice November', body: 'Invoice 2026-1102 amount 1240 CZK. Payment due by 2026-11-20.', whenMs: Date.parse(NOW) } },
  { id: 'sub-renewal', expect: { category: 'subscriptions', intent: 'subscription_renewal' }, geminiOnly: true,
    mail: { fromEmail: 'no-reply@spotify.com', fromName: 'Spotify', subject: 'Your Premium subscription renewed', body: 'Your Spotify Premium membership renewed for EUR 10.99. Next renewal 2026-12-03.', whenMs: Date.parse(NOW) } },
  { id: 'ambiguous-date', expect: { requires_confirmation: true },
    mail: { fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Arriving soon', body: 'Your order #99-AAA arrives this Saturday.', whenMs: Date.parse(NOW) } },
  { id: 'non-english', expect: { category: ['shopping', 'delivery'], intent: ['order_shipped', 'delivery_scheduled'] },
    mail: { fromEmail: 'auto-confirm@amazon.de', fromName: 'Amazon.de', subject: 'Bestellung versandt', body: 'Bestellung 302-1112222-3334444. Lieferung morgen erwartet.', whenMs: Date.parse(NOW) } },
  // Marketing-first: must NOT classify as shopping delivery (false-positive guard)
  { id: 'promo-noise', expect: { category: 'promotions', intent: 'promotional' },
    mail: { fromEmail: 'deals@store.example', fromName: 'Store Deals', subject: 'FLASH SALE 50% OFF + your package update', body: 'Buy more today! Shop the weekend deal. Also: tracking XYZTRACK999 out for delivery tomorrow for order #55-PROMO. Unsubscribe anytime.', whenMs: Date.parse(NOW) } },
];

function fieldGet(obj, dotted) {
  return dotted.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

function safeDiag(result) {
  if (!result) return null;
  return {
    category: result.category,
    intent: result.intent,
    requires_confirmation: !!result.requires_confirmation,
    confidence: result.confidence,
    organisation: result.organisation || null,
    order: result.order ? {
      order_id: result.order.order_id || null,
      delivery_date: result.order.delivery_date || null,
      status: result.order.status || null,
      tracking_number: result.order.tracking_number || null
    } : null,
    travel: result.travel ? {
      type: result.travel.type || null,
      pnr: result.travel.pnr || null,
      flight_number: result.travel.flight_number || null,
      depart_datetime: result.travel.depart_datetime || null,
      check_in: result.travel.check_in || null,
      status: result.travel.status || null
    } : null,
    financial: result.financial ? {
      amount: result.financial.amount || null,
      currency: result.financial.currency || null,
      due_date: result.financial.due_date || null
    } : null
  };
}

function scoreResult(r, expect) {
  const errors = [];
  const missing = [];
  const incorrect = [];
  if (!r || !r.valid) errors.push('invalid_schema');
  if (expect.category) {
    const cats = Array.isArray(expect.category) ? expect.category : [expect.category];
    if (!cats.includes(r.category)) {
      errors.push(`category=${r.category}`);
      incorrect.push({ field: 'category', expected: cats, actual: r.category });
    }
  }
  if (expect.intent) {
    const intents = Array.isArray(expect.intent) ? expect.intent : [expect.intent];
    // Accept legacy aliases via normalizeIntent
    const actual = AI.normalizeIntent(r.intent) || r.intent;
    if (!intents.includes(actual) && !intents.includes(r.intent)) {
      errors.push(`intent=${r.intent}`);
      incorrect.push({ field: 'intent', expected: intents, actual: r.intent });
    }
  }
  if (expect.requires_confirmation && !r.requires_confirmation) {
    errors.push('expected_requires_confirmation');
    incorrect.push({ field: 'requires_confirmation', expected: true, actual: false });
  }
  (expect.fields || []).forEach(f => {
    if (!fieldGet(r, f)) {
      errors.push(`missing_${f}`);
      missing.push(f);
    }
  });
  return { errors, missing, incorrect };
}

async function callGeminiDirect(mail) {
  const key = process.env.GEMINI_API_KEY;
  const normalized = {
    id: mail.id || 'synth',
    mailId: mail.id || 'synth',
    threadId: mail.threadId || 'synth-thread',
    fromName: mail.fromName,
    fromEmail: mail.fromEmail,
    subject: mail.subject,
    body: mail.body,
    snippet: mail.body,
    attachments: mail.attachments || [],
    receivedAt: mail.whenMs ? new Date(mail.whenMs).toISOString() : NOW
  };
  // CRITICAL: use the same production prompt + system instruction
  const prompt = AI.buildPrompt(normalized, { nowIso: NOW, timezone: TZ });
  const system = AI.SYSTEM;

  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { temperature: 0.05, maxOutputTokens: 3072, responseMimeType: 'application/json' }
    })
  });
  const ms = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false, ms, status: res.status,
      error: data?.error?.status || String(res.status),
      detail: String(data?.error?.message || '').slice(0, 160)
    };
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const parsed = AI.parseJsonLoose(text);
  const validated = AI.validateExtraction({ ...(parsed || {}), method: 'gemini' });
  return {
    ok: validated.valid,
    ms,
    model: MODEL,
    usage: data.usageMetadata || null,
    source: 'gemini-direct',
    rawKeys: parsed ? Object.keys(parsed) : [],
    result: validated
  };
}

async function sectionA() {
  const rows = FIXTURES.filter(f => !f.geminiOnly).map(f => {
    const local = AI.localHeuristicExtract(f.mail, NOW, TZ) || AI.validateExtraction({ category: 'other', confidence: 0.3, requires_confirmation: true, method: 'none' });
    const scored = scoreResult(local, f.expect);
    return {
      id: f.id, ok: scored.errors.length === 0, errors: scored.errors,
      expected: { category: f.expect.category, intent: f.expect.intent },
      actual: safeDiag(local),
      missing: scored.missing, incorrect: scored.incorrect,
      source: local.source || local.method, confidence: local.confidence
    };
  });
  return {
    name: 'A_local_heuristic',
    ran: true,
    skippedGeminiOnly: FIXTURES.filter(f => f.geminiOnly).map(f => f.id),
    total: rows.length,
    passed: rows.filter(r => r.ok).length,
    failed: rows.filter(r => !r.ok),
    rows
  };
}

async function sectionB() {
  if (!HAS_KEY) {
    return { name: 'B_live_gemini_api', ran: false, reason: 'GEMINI_API_KEY not set', total: 0, passed: 0, failed: [], calls: 0, success: 0, fail: 0, avgMs: null, tokens: null };
  }
  const rows = [];
  let promptTokens = 0, outputTokens = 0, success = 0, fail = 0, totalMs = 0;
  for (const f of FIXTURES) {
    let call;
    try { call = await callGeminiDirect(f.mail); }
    catch (e) { call = { ok: false, ms: 0, error: e.message }; }
    totalMs += call.ms || 0;
    if (call.usage) {
      promptTokens += Number(call.usage.promptTokenCount || 0);
      outputTokens += Number(call.usage.candidatesTokenCount || 0);
    }
    if (!call.ok || !call.result) {
      fail++;
      rows.push({
        id: f.id, ok: false, errors: [call.error || 'gemini_failed'], source: 'gemini-direct', ms: call.ms,
        expected: { category: f.expect.category, intent: f.expect.intent, fields: f.expect.fields || [] },
        actual: null, missing: f.expect.fields || [], incorrect: [], model: MODEL
      });
      continue;
    }
    success++;
    const scored = scoreResult(call.result, f.expect);
    if (call.result.method !== 'gemini') scored.errors.push('not_gemini_source');
    rows.push({
      id: f.id,
      ok: scored.errors.length === 0,
      errors: scored.errors,
      expected: { category: f.expect.category, intent: f.expect.intent, fields: f.expect.fields || [], requires_confirmation: f.expect.requires_confirmation || false },
      actual: safeDiag(call.result),
      missing: scored.missing,
      incorrect: scored.incorrect,
      source: 'gemini-direct',
      ms: call.ms,
      model: MODEL,
      confidence: call.result.confidence,
      category: call.result.category,
      intent: call.result.intent,
      requires_confirmation: call.result.requires_confirmation
    });
    await new Promise(r => setTimeout(r, 500));
  }

  const withCat = rows.filter(r => {
    const f = FIXTURES.find(x => x.id === r.id);
    return f && f.expect.category;
  });
  const catOk = withCat.filter(r => !(r.errors || []).some(e => e.startsWith('category=')));
  const withIntent = rows.filter(r => {
    const f = FIXTURES.find(x => x.id === r.id);
    return f && f.expect.intent;
  });
  const intentOk = withIntent.filter(r => !(r.errors || []).some(e => e.startsWith('intent=')));

  return {
    name: 'B_live_gemini_api',
    ran: true,
    model: MODEL,
    promptSource: 'DaylightAI.SYSTEM + DaylightAI.buildPrompt',
    total: rows.length,
    passed: rows.filter(r => r.ok).length,
    failed: rows.filter(r => !r.ok),
    calls: rows.length,
    success,
    fail,
    avgMs: rows.length ? Math.round(totalMs / rows.length) : null,
    tokens: { promptTokens, outputTokens },
    estimatedCostUsd: null,
    classificationAccuracy: withCat.length ? catOk.length / withCat.length : null,
    intentAccuracy: withIntent.length ? intentOk.length / withIntent.length : null,
    rows
  };
}

async function sectionC() {
  const checks = [];
  const hit = async (name, pathName, opts = {}) => {
    const t0 = Date.now();
    try {
      const r = await fetch(WORKER + pathName, { ...opts, headers: { Origin: 'https://kratveer.github.io', ...(opts.headers || {}) } });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 120); }
      const row = { name, status: r.status, ms: Date.now() - t0, body };
      checks.push(row);
      return row;
    } catch (e) {
      const row = { name, error: e.message };
      checks.push(row);
      return row;
    }
  };
  await hit('health', '/health');
  const statusNo = await hit('gemini_status_noauth', '/api/gemini/status');
  await hit('gemini_status_fake', '/api/gemini/status', { headers: { Authorization: 'Bearer fakesessiontoken12345678901234567890' } });
  await hit('gemini_analyse_fake', '/api/gemini/analyse', {
    method: 'POST',
    headers: { Authorization: 'Bearer fakesessiontoken12345678901234567890', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'ping' })
  });
  await hit('gemini_analyse_noauth', '/api/gemini/analyse', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'ping' })
  });

  const routesDeployed = statusNo.status !== 404;
  AI.setConsent(false); AI.setEnabled(false);
  const blocked = AI.shouldCallGemini({ subject: 'x' }, { needsReview: true, category: 'shopping' });
  AI.setConsent(true); AI.setEnabled(true);
  ls.setItem('daylight-ai-allow-financial', '0');
  const finBlocked = AI.shouldCallGemini({ subject: 'bill' }, { needsReview: true, category: 'bill', privacyClass: 'financial' });
  ls.setItem('daylight-ai-allow-financial', '1');
  const finAllowed = AI.shouldCallGemini({ subject: 'bill' }, { needsReview: true, category: 'bill', privacyClass: 'financial' });
  const fb = await AI.analyseEmail(FIXTURES[0].mail, { forceGemini: true, serverUrl: '', session: '', nowIso: NOW, timezone: TZ });
  const fallbackOk = fb && fb.valid && fb.source !== 'gemini' && fb.method !== 'gemini';
  const ambLocal = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'ambiguous-date').mail, NOW, TZ);

  return {
    name: 'C_worker_consent_fallback',
    ran: true,
    worker: WORKER,
    healthOk: checks[0]?.status === 200,
    routesDeployed,
    authEnforced: routesDeployed && statusNo.status === 401,
    consentBlocksWhenOff: blocked === false,
    financialOptInEnforced: finBlocked === false && finAllowed === true,
    fallbackWithoutServer: fallbackOk,
    ambiguousEscalates: !!(ambLocal && ambLocal.requires_confirmation),
    checks,
    verdict: routesDeployed ? (statusNo.status === 401 ? 'routes_live' : 'routes_live_auth_unexpected') : 'ROUTES_NOT_DEPLOYED_404'
  };
}

async function sectionD() {
  const confirm = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'amazon-confirm').mail, NOW, TZ);
  const delivery = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'amazon-delivery').mail, NOW, TZ);
  const delay = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'amazon-delay').mail, NOW, TZ);
  const book = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'flight-booking').mail, NOW, TZ);
  const cancel = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'flight-cancel').mail, NOW, TZ);
  const resched = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'flight-reschedule').mail, NOW, TZ);
  const sameOrder = confirm.order?.order_id && confirm.order.order_id === delivery.order?.order_id && delivery.order.order_id === delay.order?.order_id;
  const samePnr = book.travel?.pnr && book.travel.pnr === cancel.travel?.pnr;
  const diff = await AI.analyseEmailChanges(book, resched);
  return {
    name: 'D_lifecycle_dedupe',
    ran: true,
    sameOrderIdAcrossUpdates: !!sameOrder,
    orderKeysAlign: !!sameOrder,
    samePnrCancel: !!samePnr,
    flightKeys: {
      book: AI.entityKey(book, { threadId: 't-flight' }),
      cancel: AI.entityKey(cancel, { threadId: 't-flight' }),
      equal: AI.entityKey(book, { threadId: 't-flight' }) === AI.entityKey(cancel, { threadId: 't-flight' })
    },
    deliveryDateChanges: delivery.order?.delivery_date !== delay.order?.delivery_date || delay.intent === 'delivery_delayed',
    cancelDetected: cancel.intent === 'booking_cancelled',
    rescheduleChanges: (diff.changes || []).length
  };
}

(async () => {
  console.log('Daylight Phase 10 — Live Gemini verification');
  console.log('Worker:', WORKER);
  console.log('GEMINI_API_KEY set:', HAS_KEY ? 'yes' : 'NO');
  console.log('Model:', MODEL);
  console.log('Prompt: DaylightAI.SYSTEM + buildPrompt');

  const A = await sectionA();
  const C = await sectionC();
  const D = await sectionD();
  const B = await sectionB();

  const allSemanticPass = B.ran && B.passed === B.total && B.intentAccuracy === 1;
  const report = {
    generatedAt: new Date().toISOString(),
    phase: 10,
    productionReady: !!(allSemanticPass && C.routesDeployed && C.authEnforced && A.passed === A.total && D.sameOrderIdAcrossUpdates && D.samePnrCancel),
    productionReadyReason: !B.ran ? 'GEMINI_API_KEY missing'
      : (!allSemanticPass ? `semantic ${B.passed}/${B.total}; intentAcc=${B.intentAccuracy}`
        : (!C.routesDeployed ? 'worker routes missing' : 'acceptance met')),
    rootCauseFixed: [
      'Live harness now uses production SYSTEM + buildPrompt (previously omitted intent enum → informational)',
      'normalizeIntent aliases; no silent coerce of unknown intents to informational before structure inference',
      'delivery category with order_id normalized to shopping',
      'Stronger extraction schema for order/travel/financial dates'
    ],
    sections: { A, B, C, D },
    metrics: {
      geminiCalls: B.ran ? B.calls : 0,
      geminiSuccess: B.ran ? B.success : 0,
      geminiFailed: B.ran ? B.fail : 0,
      classificationAccuracy_B: B.classificationAccuracy,
      intentAccuracy_B: B.intentAccuracy,
      avgProcessingMs_B: B.avgMs,
      tokenUsage_B: B.tokens,
      heuristicPassRate_A: A.total ? A.passed / A.total : null,
      workerRoutesDeployed: C.routesDeployed,
      duplicateCreationRate_D: D.sameOrderIdAcrossUpdates && D.samePnrCancel ? 0 : null
    }
  };

  const out = path.join(__dirname, 'live-gemini-verify-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(`A local heuristic: ${A.passed}/${A.total}`);
  console.log(`B live Gemini: ${B.ran ? `${B.passed}/${B.total} (intentAcc=${B.intentAccuracy}, classAcc=${B.classificationAccuracy}, avgMs=${B.avgMs})` : 'NOT RUN'}`);
  if (B.ran && B.failed?.length) {
    B.failed.forEach(f => console.log(' FAIL', f.id, (f.errors || []).join('; '), 'actual=', JSON.stringify(f.actual)));
  }
  console.log(`C worker: deployed=${C.routesDeployed} auth=${C.authEnforced}`);
  console.log(`D lifecycle: sameOrder=${D.sameOrderIdAcrossUpdates} samePnr=${D.samePnrCancel}`);
  console.log('Production ready:', report.productionReady, '—', report.productionReadyReason);
  console.log('Wrote', out);
  if (!B.ran) process.exit(2);
  if (B.passed < B.total) process.exit(1);
})().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
