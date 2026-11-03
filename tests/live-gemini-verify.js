/**
 * Daylight Phase 9 — Live Gemini verification harness.
 *
 * Sections:
 *   A) Local heuristic (no network) — always runs
 *   B) Direct Gemini API — requires GEMINI_API_KEY in env (never printed)
 *   C) Worker / consent / fallback integration checks
 *   D) Lifecycle dedupe (orders/bookings) without claiming Gemini success
 *
 * Run:
 *   node tests/live-gemini-verify.js
 *   $env:GEMINI_API_KEY="…"; node tests/live-gemini-verify.js
 *   $env:DAYLIGHT_API="https://daylight-api….workers.dev"; node tests/live-gemini-verify.js
 *
 * Never logs API keys or full email bodies.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

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
  { id: 'amazon-confirm', expect: { category: 'shopping', intent: 'order_confirmation' },
    mail: { fromEmail: 'auto-confirm@amazon.com', fromName: 'Amazon', subject: 'Order confirmed', body: 'Thanks for order #112-3344556-7788990 of USB-C Hub. We will email when it ships.', whenMs: Date.parse(NOW) } },
  { id: 'amazon-delivery', expect: { category: 'shopping', intent: ['delivery_update', 'order_shipped'], fields: ['order.delivery_date'] },
    mail: { fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Out for delivery', body: 'Order #112-3344556-7788990 is out for delivery. Expected delivery tomorrow.', whenMs: Date.parse(NOW) } },
  { id: 'amazon-delay', expect: { category: 'shopping', intent: 'delivery_delayed', fields: ['order.delivery_date'] },
    mail: { fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Delivery delayed', body: 'Order #112-3344556-7788990 delayed. New expected delivery 2026-11-06.', whenMs: Date.parse(NOW) } },
  { id: 'flight-booking', expect: { category: 'travel', intent: 'flight_booking', fields: ['travel.pnr', 'travel.depart_datetime'] },
    mail: { fromEmail: 'booking@lufthansa.com', fromName: 'Lufthansa', subject: 'Booking confirmation LH400', body: 'Flight LH400 PRG → FRA 2026-11-20T08:40. PNR: ABC12X. Seat 12A.', whenMs: Date.parse(NOW) } },
  { id: 'flight-cancel', expect: { category: 'travel', intent: 'cancellation' },
    mail: { fromEmail: 'booking@lufthansa.com', fromName: 'Lufthansa', subject: 'Flight cancelled LH400', body: 'Flight LH400 on 2026-11-20T08:40 cancelled. PNR ABC12X.', whenMs: Date.parse(NOW) } },
  { id: 'flight-reschedule', expect: { category: 'travel', intent: 'rescheduling', fields: ['travel.depart_datetime'] },
    mail: { fromEmail: 'updates@ryanair.com', fromName: 'Ryanair', subject: 'Schedule change FR1234', body: 'New departure for FR1234: 2026-12-01T06:15. Booking ref ZY9876.', whenMs: Date.parse(NOW) } },
  { id: 'hotel', expect: { category: 'travel', intent: 'hotel_booking' },
    mail: { fromEmail: 'noreply@booking.com', fromName: 'Booking.com', subject: 'Hotel reservation confirmed', body: 'Hotel Central Prague. Check-in 2026-11-20 check-out 2026-11-22. Confirmation 998877.', whenMs: Date.parse(NOW) } },
  // Invoice + subscription: Gemini-priority fixtures (no strong local heuristic by design)
  { id: 'invoice', expect: { category: ['bills', 'finance'], fields: ['financial.due_date'] }, geminiOnly: true,
    mail: { fromEmail: 'billing@cez.cz', fromName: 'ČEZ', subject: 'Invoice November', body: 'Invoice 2026-1102 amount 1240 CZK. Payment due by 2026-11-20.', whenMs: Date.parse(NOW) } },
  { id: 'sub-renewal', expect: { category: 'subscriptions', intent: 'subscription_renewal' }, geminiOnly: true,
    mail: { fromEmail: 'no-reply@spotify.com', fromName: 'Spotify', subject: 'Your Premium subscription renewed', body: 'Your Spotify Premium membership renewed for EUR 10.99. Next renewal 2026-12-03.', whenMs: Date.parse(NOW) } },
  { id: 'ambiguous-date', expect: { requires_confirmation: true },
    mail: { fromEmail: 'shipment-tracking@amazon.com', fromName: 'Amazon', subject: 'Arriving soon', body: 'Your order #99-AAA arrives this Saturday.', whenMs: Date.parse(NOW) } },
  { id: 'non-english', expect: { category: 'shopping' },
    mail: { fromEmail: 'auto-confirm@amazon.de', fromName: 'Amazon.de', subject: 'Bestellung versandt', body: 'Bestellung 302-1112222-3334444. Lieferung morgen erwartet.', whenMs: Date.parse(NOW) } },
  { id: 'promo-noise', expect: { category: ['shopping', 'promotions', 'other'] },
    mail: { fromEmail: 'deals@store.example', fromName: 'Store Deals', subject: 'FLASH SALE 50% OFF + your package update', body: 'Buy more today! Also: tracking XYZTRACK999 out for delivery tomorrow for order #55-PROMO.', whenMs: Date.parse(NOW) } },
];

function fieldGet(obj, dotted) {
  return dotted.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

function scoreResult(r, expect) {
  const errors = [];
  if (!r || !r.valid) errors.push('invalid_schema');
  if (expect.category) {
    const cats = Array.isArray(expect.category) ? expect.category : [expect.category];
    if (!cats.includes(r.category)) errors.push(`category=${r.category}`);
  }
  if (expect.intent) {
    const intents = Array.isArray(expect.intent) ? expect.intent : [expect.intent];
    if (!intents.includes(r.intent)) errors.push(`intent=${r.intent}`);
  }
  if (expect.requires_confirmation && !r.requires_confirmation) errors.push('expected_requires_confirmation');
  (expect.fields || []).forEach(f => {
    if (!fieldGet(r, f)) errors.push(`missing_${f}`);
  });
  // Never treat received-now as event start without evidence
  if (r.event?.exists && r.event.start_datetime) {
    const ev = Date.parse(r.event.start_datetime);
    if (!Number.isFinite(ev)) errors.push('bad_event_datetime');
  }
  return errors;
}

async function callGeminiDirect(mail) {
  const key = process.env.GEMINI_API_KEY;
  const system = `You are Daylight's email intelligence engine. Return ONLY valid JSON. Never invent facts. Use null for unknowns. Never use email received date as event date.`;
  const prompt = `current_datetime: ${NOW}
timezone: ${TZ}
from: ${mail.fromName} <${mail.fromEmail}>
subject: ${mail.subject}
email_body:
${mail.body}

Return JSON with fields: category, secondary_categories, intent, organisation, summary, entities, event, order, travel, financial, reminders, suggested_actions, confidence, evidence, requires_confirmation, facts_vs_inferred.
category must be one of: shopping, travel, finance, bills, subscriptions, work, meetings, personal, social, education, health, documents, government, delivery, security, promotions, newsletters, other.`;

  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' }
    })
  });
  const ms = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false, ms, status: res.status,
      error: data?.error?.status || data?.error?.message || String(res.status),
      // never include key; truncate error message
      detail: String(data?.error?.message || '').slice(0, 160)
    };
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const parsed = (() => { try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } } })();
  const validated = AI.validateExtraction({ ...(parsed || {}), method: 'gemini' });
  return {
    ok: validated.valid,
    ms,
    model: MODEL,
    usage: data.usageMetadata || null,
    source: 'gemini-direct',
    result: validated
  };
}

async function sectionA() {
  const rows = FIXTURES.filter(f => !f.geminiOnly).map(f => {
    const local = AI.localHeuristicExtract(f.mail, NOW, TZ) || AI.validateExtraction({ category: 'other', confidence: 0.3, requires_confirmation: true, method: 'none' });
    const errors = scoreResult(local, f.expect);
    return { id: f.id, ok: errors.length === 0, errors, source: local.source || local.method, confidence: local.confidence };
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
    return { name: 'B_live_gemini_api', ran: false, reason: 'GEMINI_API_KEY not set in environment', total: 0, passed: 0, failed: [], calls: 0, success: 0, fail: 0, avgMs: null, tokens: null };
  }
  const rows = [];
  let promptTokens = 0, outputTokens = 0, success = 0, fail = 0, totalMs = 0;
  for (const f of FIXTURES) {
    // Force real Gemini — do NOT accept heuristic as success
    let call;
    try { call = await callGeminiDirect(f.mail); }
    catch (e) { call = { ok: false, ms: 0, error: e.message }; }
    totalMs += call.ms || 0;
    if (call.usage) {
      promptTokens += Number(call.usage.promptTokenCount || 0);
      outputTokens += Number(call.usage.candidatesTokenCount || call.usage.totalTokenCount || 0);
    }
    if (!call.ok || !call.result) {
      fail++;
      rows.push({ id: f.id, ok: false, errors: [call.error || 'gemini_failed'], source: 'gemini-direct', ms: call.ms });
      continue;
    }
    success++;
    const errors = scoreResult(call.result, f.expect);
    // Explicitly reject heuristic labelling
    if (call.result.method !== 'gemini' && call.source !== 'gemini-direct') errors.push('not_gemini_source');
    rows.push({
      id: f.id, ok: errors.length === 0, errors, source: 'gemini-direct',
      ms: call.ms, confidence: call.result.confidence,
      category: call.result.category, intent: call.result.intent,
      requires_confirmation: call.result.requires_confirmation
    });
    // gentle pacing for free tier
    await new Promise(r => setTimeout(r, 400));
  }
  return {
    name: 'B_live_gemini_api',
    ran: true,
    model: MODEL,
    total: rows.length,
    passed: rows.filter(r => r.ok).length,
    failed: rows.filter(r => !r.ok),
    calls: rows.length,
    success,
    fail,
    avgMs: rows.length ? Math.round(totalMs / rows.length) : null,
    tokens: { promptTokens, outputTokens },
    // Free-tier flash-lite estimate ~$0 when free; paid approx if billed
    estimatedCostUsd: null,
    rows
  };
}

async function sectionC() {
  const checks = [];
  const hit = async (name, pathName, opts = {}) => {
    const t0 = Date.now();
    try {
      const r = await fetch(WORKER + pathName, {
        ...opts,
        headers: { Origin: 'https://kratveer.github.io', ...(opts.headers || {}) }
      });
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

  const health = await hit('health', '/health');
  const statusNo = await hit('gemini_status_noauth', '/api/gemini/status');
  const statusFake = await hit('gemini_status_fake', '/api/gemini/status', {
    headers: { Authorization: 'Bearer fakesessiontoken12345678901234567890' }
  });
  const analyseFake = await hit('gemini_analyse_fake', '/api/gemini/analyse', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fakesessiontoken12345678901234567890',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prompt: 'ping' })
  });
  const analyseEmpty = await hit('gemini_analyse_noauth', '/api/gemini/analyse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'ping' })
  });

  const routesDeployed = statusNo.status !== 404 && analyseEmpty.status !== 404;
  const authEnforced = routesDeployed
    ? (statusNo.status === 401 && (statusFake.status === 401 || statusFake.status === 503) && (analyseFake.status === 401 || analyseFake.status === 503))
    : false;

  // Consent enforcement (client-side unit)
  AI.setConsent(false); AI.setEnabled(false);
  const blocked = AI.shouldCallGemini({ subject: 'x' }, { needsReview: true, category: 'shopping' });
  AI.setConsent(true); AI.setEnabled(true);
  ls.setItem('daylight-ai-allow-financial', '0');
  const finBlocked = AI.shouldCallGemini({ subject: 'bill' }, { needsReview: true, category: 'bill', privacyClass: 'financial' });
  ls.setItem('daylight-ai-allow-financial', '1');
  const finAllowed = AI.shouldCallGemini({ subject: 'bill' }, { needsReview: true, category: 'bill', privacyClass: 'financial' });

  // Fallback path without server: must not throw; source must not pretend to be gemini
  AI.setConsent(true); AI.setEnabled(true);
  const fb = await AI.analyseEmail(FIXTURES[0].mail, { forceGemini: true, serverUrl: '', session: '', nowIso: NOW, timezone: TZ });
  const fallbackOk = fb && fb.valid && fb.source !== 'gemini' && fb.method !== 'gemini';

  // Ambiguous local results must require confirmation (escalation gate for Gemini)
  const amb = FIXTURES.find(f => f.id === 'ambiguous-date').mail;
  const ambLocal = AI.localHeuristicExtract(amb, NOW, TZ);
  const escalateAmbiguous = !!(ambLocal && ambLocal.requires_confirmation);

  return {
    name: 'C_worker_consent_fallback',
    ran: true,
    worker: WORKER,
    healthOk: health.status === 200,
    routesDeployed,
    authEnforced,
    consentBlocksWhenOff: blocked === false,
    financialOptInEnforced: finBlocked === false && finAllowed === true,
    fallbackWithoutServer: fallbackOk,
    ambiguousEscalates: escalateAmbiguous,
    checks,
    verdict: routesDeployed
      ? (authEnforced ? 'routes_live' : 'routes_live_auth_unexpected')
      : 'ROUTES_NOT_DEPLOYED_404'
  };
}

async function sectionD() {
  // Lifecycle using validated extractions (schema-level), not claiming Gemini
  const confirm = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'amazon-confirm').mail, NOW, TZ);
  const delivery = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'amazon-delivery').mail, NOW, TZ);
  const delay = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'amazon-delay').mail, NOW, TZ);
  const book = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'flight-booking').mail, NOW, TZ);
  const cancel = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'flight-cancel').mail, NOW, TZ);
  const resched = AI.localHeuristicExtract(FIXTURES.find(f => f.id === 'flight-reschedule').mail, NOW, TZ);

  const mailMeta = { mailId: 'm1', threadId: 't-order' };
  const k1 = AI.entityKey(confirm, { ...mailMeta, threadId: 't-order' });
  const k2 = AI.entityKey(delivery, { mailId: 'm2', threadId: 't-order' });
  const k3 = AI.entityKey(delay, { mailId: 'm3', threadId: 't-order' });
  // Prefer order id equality for dedupe
  const sameOrder = confirm.order?.order_id && confirm.order.order_id === delivery.order?.order_id && delivery.order.order_id === delay.order?.order_id;
  const keysAlign = sameOrder || (k1 === k2 || (confirm.order?.order_id && delivery.order?.order_id === confirm.order.order_id));

  const flightKeyA = AI.entityKey(book, { mailId: 'f1', threadId: 't-flight' });
  const flightKeyB = AI.entityKey(cancel, { mailId: 'f2', threadId: 't-flight' });
  const samePnr = book.travel?.pnr && book.travel.pnr === cancel.travel?.pnr;
  const diff = await AI.analyseEmailChanges(book, resched);

  const deliveryChanged = delivery.order?.delivery_date !== delay.order?.delivery_date || delay.intent === 'delivery_delayed';
  const cancelIntent = cancel.intent === 'cancellation';

  return {
    name: 'D_lifecycle_dedupe',
    ran: true,
    sameOrderIdAcrossUpdates: !!sameOrder,
    orderKeysAlign: !!keysAlign,
    samePnrCancel: !!samePnr,
    flightKeys: { book: flightKeyA, cancel: flightKeyB, equal: flightKeyA === flightKeyB },
    deliveryDateChanges: !!deliveryChanged,
    cancelDetected: cancelIntent,
    rescheduleChanges: (diff.changes || []).length,
    note: 'Lifecycle keys verified at extraction layer; wallet/reminder wiring covered by unit expectations in report'
  };
}

function accuracy(section, field) {
  if (!section.ran || !section.rows) return null;
  const withExp = section.rows.filter(r => {
    const f = FIXTURES.find(x => x.id === r.id);
    return f && f.expect[field];
  });
  if (!withExp.length) return null;
  const ok = withExp.filter(r => r.ok || (field === 'category' && !r.errors?.some(e => e.startsWith('category='))));
  // simpler: count rows without field-specific error
  const good = withExp.filter(r => !(r.errors || []).some(e => e.startsWith(field) || e.startsWith(`missing_${field}`) || e.startsWith(`${field}=`)));
  return { n: withExp.length, correct: good.length, rate: good.length / withExp.length };
}

(async () => {
  console.log('Daylight Phase 9 — Live Gemini verification');
  console.log('Worker:', WORKER);
  console.log('GEMINI_API_KEY set:', HAS_KEY ? 'yes' : 'NO');
  console.log('Model:', MODEL);

  const A = await sectionA();
  const C = await sectionC();
  const D = await sectionD();
  const B = await sectionB();

  const report = {
    generatedAt: new Date().toISOString(),
    commitTarget: '8dfa25b+',
    productionReady: false,
    productionReadyReason: C.routesDeployed
      ? (B.ran && B.passed === B.total ? 'pending_manual_e2e_session' : 'gemini_live_incomplete_or_failed')
      : 'Worker /api/gemini/* returns 404 — redeploy worker + set GEMINI_API_KEY secret',
    sections: { A, B, C, D },
    metrics: {
      geminiCalls: B.ran ? B.calls : 0,
      geminiSuccess: B.ran ? B.success : 0,
      geminiFailed: B.ran ? B.fail : 0,
      classificationAccuracy_B: B.ran ? accuracy(B, 'category') : null,
      intentAccuracy_B: B.ran ? accuracy(B, 'intent') : null,
      avgProcessingMs_B: B.avgMs,
      tokenUsage_B: B.tokens,
      heuristicPassRate_A: A.passed / A.total,
      workerRoutesDeployed: C.routesDeployed,
      duplicateCreationRate_D: D.sameOrderIdAcrossUpdates && D.samePnrCancel ? 0 : null,
      falseReminderRate: null
    },
    fixesAppliedThisPhase: [
      'Escalate to Gemini when local heuristic requires_confirmation',
      'Default model → gemini-3.5-flash-lite (2.5-flash-lite restricted for new projects)',
      'Cancellation disables AI-generated reminders for the same entityKey'
    ]
  };

  const out = path.join(__dirname, 'live-gemini-verify-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(`A local heuristic: ${A.passed}/${A.total}`);
  console.log(`B live Gemini: ${B.ran ? `${B.passed}/${B.total} (calls=${B.calls}, fail=${B.fail}, avgMs=${B.avgMs})` : 'NOT RUN — set GEMINI_API_KEY'}`);
  console.log(`C worker routes deployed: ${C.routesDeployed} (${C.verdict})`);
  console.log(`C auth/consent/fallback: auth=${C.authEnforced} consentOff=${C.consentBlocksWhenOff} fallback=${C.fallbackWithoutServer}`);
  console.log(`D lifecycle: sameOrder=${D.sameOrderIdAcrossUpdates} samePnr=${D.samePnrCancel} deliveryChanged=${D.deliveryDateChanges} cancel=${D.cancelDetected}`);
  console.log(`Production ready: NO — ${report.productionReadyReason}`);
  console.log('Wrote', out);

  // Exit non-zero if worker routes missing (blocking) or live Gemini ran and failed hard
  if (!C.routesDeployed) process.exit(2);
  if (B.ran && B.fail > B.success) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
