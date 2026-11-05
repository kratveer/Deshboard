// Daylight server — keeps you signed in to Google.
// The browser never sees Google's long-lived refresh token. It is stored encrypted
// (AES-GCM) in Workers KV and swapped for short-lived access tokens on request.
//
// Routes
//   GET  /auth/google/start?return=<dashboard url>  → Google consent screen
//   GET  /auth/google/callback                       → stores refresh token, returns to dashboard
//   POST /api/google/token   (Authorization: Bearer <session>) → { access_token, expires_in, email }
//   POST /auth/logout        (Authorization: Bearer <session>) → revokes and deletes
//   POST /auth/logout?keep_grant=1                 → deletes this session record only (used when a browser signs in again)
//   GET  /health

// V2: onboarding asks for Gmail READ-ONLY and nothing else (minimum permission).
// Other Google products are optional connectors: each is added later with its own consent screen
// (incremental authorisation, include_granted_scopes=true) when the user turns it on.
// No send / compose / modify / delete scopes are ever requested in this release.
const GOOGLE_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');
const OPTIONAL_SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.events.readonly',
  tasks: 'https://www.googleapis.com/auth/tasks.readonly',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
};
/** Scopes for one sign-in: base + the optional connectors named in ?add=calendar,tasks (unknown names ignored). */
function scopesFor(addParam) {
  const extra = String(addParam || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => OPTIONAL_SCOPES[x]).map((x) => OPTIONAL_SCOPES[x]);
  return [GOOGLE_SCOPES, ...new Set(extra)].join(' ');
}
const SESSION_TTL = 60 * 60 * 24 * 180; // sessions idle for 180 days are forgotten
const enc = new TextEncoder(), dec = new TextDecoder();
const scopeBlob = (s) => String(s || '');
const hasGmailReadonly = (s) => /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly(?:\s|$)/.test(scopeBlob(s));
const hasGmailSend = (s) => /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/gmail\.send(?:\s|$)/.test(scopeBlob(s));
// Older Daylight grants used gmail.metadata only — that cannot call format=full.
const hasGmailMetadataOnly = (s) => /gmail\.metadata/.test(scopeBlob(s)) && !hasGmailReadonly(s);

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomId = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

async function aesKey(env) {
  const raw = fromB64(env.TOKEN_KEY || '');
  if (raw.length !== 32) throw new Error('TOKEN_KEY must be 32 random bytes, base64 encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64url(out);
}
async function open(env, sealed) {
  const all = fromB64(sealed);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await aesKey(env), all.slice(12)));
}

function allowedReturn(env, value) {
  try {
    const u = new URL(value);
    if (!list(env.ALLOWED_ORIGINS).includes(u.origin)) return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}
function cors(env, req) {
  const origin = req.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  if (origin && list(env.ALLOWED_ORIGINS).includes(origin)) {
    Object.assign(h, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
  }
  return h;
}
const json = (env, req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(env, req) } });
const back = (url, params) => Response.redirect(url + '#' + new URLSearchParams(params).toString(), 302);

async function googleToken(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error_description || data.error || 'Google token request failed'); e.code = data.error; throw e; }
  return data;
}
function emailFromIdToken(idToken) {
  // The ID token comes straight from Google's token endpoint over TLS, so reading its claims is safe here.
  try { return JSON.parse(dec.decode(fromB64(idToken.split('.')[1]))).email?.toLowerCase() || ''; } catch { return ''; }
}
async function sessionFrom(env, req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const key = 'sess:' + await sha256(m[1]);
  const rec = await env.SESSIONS.get(key, 'json');
  return rec ? { key, rec } : null;
}

async function handle(req, env) {
  const url = new URL(req.url);
  const redirectUri = url.origin + '/auth/google/callback';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });

  if (url.pathname === '/health') return json(env, req, { ok: true, features: ['logout_keep_grant'] });

  if (url.pathname === '/auth/google/start' && req.method === 'GET') {
    const ret = allowedReturn(env, url.searchParams.get('return'));
    if (!ret) return new Response('This return address is not allowed.', { status: 400 });
    const state = randomId(24);
    // upgrade=1 (or legacy metadata reconnect): do not merge prior grants so Google shows gmail.readonly clearly.
    const upgrade = url.searchParams.get('upgrade') === '1' || url.searchParams.get('upgrade') === 'gmail';
    const add = url.searchParams.get('add') || '';
    await env.SESSIONS.put('state:' + state, JSON.stringify({ ret, upgrade, add }), { expirationTtl: 600 });
    const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    Object.entries({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopesFor(add),
      access_type: 'offline',
      prompt: url.searchParams.get('switch') === '1' ? 'select_account consent' : 'consent', // switch=1: let the user pick a different Google account
      // false on upgrade so an old gmail.metadata grant cannot mask a missing readonly approval
      // incremental: adding a connector keeps the scopes already granted
      include_granted_scopes: upgrade ? 'false' : 'true',
      state
    }).forEach(([k, v]) => g.searchParams.set(k, v));
    return Response.redirect(g.toString(), 302);
  }

  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    const raw = state && await env.SESSIONS.get('state:' + state);
    if (!raw) return new Response('Sign-in link expired. Go back to Daylight and try again.', { status: 400 });
    await env.SESSIONS.delete('state:' + state);
    let ret = raw, upgrade = false;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.ret) { ret = parsed.ret; upgrade = !!parsed.upgrade; }
    } catch { /* legacy state stored plain return URL */ }
    if (url.searchParams.get('error')) return back(ret, { daylight_error: url.searchParams.get('error') });
    let tok;
    try { tok = await googleToken({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }); }
    catch (e) { return back(ret, { daylight_error: 'token_exchange_failed' }); }
    const email = emailFromIdToken(tok.id_token || '');
    const allowed = list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());
    if (!email || (allowed.length && !allowed.includes(email))) return back(ret, { daylight_error: 'account_not_allowed' });
    if (!tok.refresh_token) return back(ret, { daylight_error: 'no_refresh_token' });
    let granted = scopeBlob(tok.scope);
    // Some Google responses omit scope on the code exchange — confirm via tokeninfo (never forwarded to the client).
    if (!hasGmailReadonly(granted) && tok.access_token) {
      try {
        const info = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(tok.access_token)).then((r) => r.json()).catch(() => ({}));
        if (info?.scope) granted = scopeBlob(info.scope);
      } catch {}
    }
    // Refuse sessions that cannot read message bodies (blocks silent gmail.metadata-only grants).
    if (!hasGmailReadonly(granted)) {
      return back(ret, { daylight_error: 'gmail_readonly_required' });
    }
    const session = randomId(32);
    await env.SESSIONS.put('sess:' + await sha256(session), JSON.stringify({
      email,
      rt: await seal(env, tok.refresh_token),
      scopes: granted,
      created: Date.now(),
      upgradedAt: upgrade ? Date.now() : undefined
    }), { expirationTtl: SESSION_TTL });
    return back(ret, { daylight_session: session, daylight_gmail_readonly: '1' });
  }

  if (url.pathname === '/api/google/token' && req.method === 'POST') {
    const s = await sessionFrom(env, req);
    if (!s) return json(env, req, { error: 'reauth' }, 401);
    if (!s.rec?.rt) {
      await env.SESSIONS.delete(s.key);
      return json(env, req, { error: 'reauth', stage: 'missing_refresh' }, 401);
    }
    let refreshToken;
    try {
      refreshToken = await open(env, s.rec.rt);
    } catch {
      await env.SESSIONS.delete(s.key);
      return json(env, req, { error: 'reauth', stage: 'unseal' }, 401);
    }
    try {
      const tok = await googleToken({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' });
      const scope = scopeBlob(tok.scope || s.rec.scopes || '');
      await env.SESSIONS.put(s.key, JSON.stringify({ ...s.rec, scopes: scope || s.rec.scopes, used: Date.now() }), { expirationTtl: SESSION_TTL }); // keep active sessions alive
      return json(env, req, {
        access_token: tok.access_token,
        expires_in: tok.expires_in || 3600,
        scope,
        email: s.rec.email,
        gmail_readonly: hasGmailReadonly(scope),
        gmail_send: hasGmailSend(scope),
        needs_gmail_upgrade: !hasGmailReadonly(scope)
      });
    } catch (e) {
      // Revoked / superseded refresh tokens (common after reconnect) → clear session so the client can upgrade cleanly
      if (e.code === 'invalid_grant' || e.code === 'unauthorized_client' || e.code === 'invalid_client') {
        await env.SESSIONS.delete(s.key);
        return json(env, req, { error: 'reauth', stage: 'refresh', google_error: e.code }, 401);
      }
      return json(env, req, { error: 'google_unavailable', stage: 'refresh', google_error: e.code || 'unknown' }, 502);
    }
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const s = await sessionFrom(env, req);
    // keep_grant=1: the browser replaced this session with a new sign-in — forget the session and its stored refresh
    // token here, but do not revoke Google's grant (that could also cut off the new session of the same Google account).
    const keepGrant = url.searchParams.get('keep_grant') === '1';
    if (s && keepGrant) { await env.SESSIONS.delete(s.key); return json(env, req, { ok: true, forgotten: true }); }
    if (s) {
      try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: await open(env, s.rec.rt) }) }); } catch {}
      await env.SESSIONS.delete(s.key);
    }
    return json(env, req, { ok: true });
  }

  // Gemini intelligence proxy — API key never leaves the Worker.
  // Auth: same Bearer session as /api/google/token. Rate-limited per session.
  if (url.pathname === '/api/gemini/analyse' && req.method === 'POST') {
    const s = await sessionFrom(env, req);
    if (!s) return json(env, req, { error: 'reauth' }, 401);
    if (!env.GEMINI_API_KEY) return json(env, req, { error: 'gemini_not_configured' }, 503);

    const model = String(env.GEMINI_MODEL || 'gemini-3.5-flash-lite').replace(/[^a-zA-Z0-9._-]/g, '');
    const limitKey = 'gemini-rl:' + (await sha256(s.key));
    const hourBucket = Math.floor(Date.now() / 3600000);
    const rl = (await env.SESSIONS.get(limitKey, 'json')) || { hour: hourBucket, count: 0 };
    if (rl.hour !== hourBucket) { rl.hour = hourBucket; rl.count = 0; }
    const maxPerHour = Math.min(120, Math.max(10, Number(env.GEMINI_MAX_PER_HOUR) || 40));
    if (rl.count >= maxPerHour) return json(env, req, { error: 'rate_limited', retry_after_sec: 3600 - Math.floor((Date.now() % 3600000) / 1000) }, 429);

    let body;
    try { body = await req.json(); } catch { return json(env, req, { error: 'invalid_json' }, 400); }
    const prompt = String(body?.prompt || '').slice(0, 24000);
    if (!prompt.trim()) return json(env, req, { error: 'empty_prompt' }, 400);

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: body?.temperature == null ? 0.1 : Math.min(1, Math.max(0, Number(body.temperature) || 0)),
        maxOutputTokens: Math.min(4096, Math.max(256, Number(body.maxOutputTokens) || 2048)),
        responseMimeType: 'application/json',
      },
    };
    if (body?.system) {
      payload.systemInstruction = { parts: [{ text: String(body.system).slice(0, 12000) }] };
    }

    let geminiRes, geminiText = '', usage = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Math.min(55000, Math.max(8000, Number(body?.timeoutMs) || 25000)));
      geminiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await geminiRes.json().catch(() => ({}));
      if (!geminiRes.ok) {
        const code = data?.error?.status || data?.error?.code || geminiRes.status;
        if (geminiRes.status === 429) return json(env, req, { error: 'upstream_rate_limited', detail: String(code) }, 429);
        return json(env, req, { error: 'gemini_upstream', detail: String(data?.error?.message || code) }, 502);
      }
      geminiText = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      usage = data?.usageMetadata || null;
    } catch (e) {
      return json(env, req, { error: 'gemini_unreachable', detail: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch_failed') }, 502);
    }

    rl.count += 1;
    await env.SESSIONS.put(limitKey, JSON.stringify(rl), { expirationTtl: 7200 });
    await env.SESSIONS.put(s.key, JSON.stringify({ ...s.rec, used: Date.now() }), { expirationTtl: SESSION_TTL });

    return json(env, req, {
      ok: true,
      model,
      text: geminiText,
      usage,
      remaining: Math.max(0, maxPerHour - rl.count),
    });
  }

  if (url.pathname === '/api/gemini/status' && req.method === 'GET') {
    const s = await sessionFrom(env, req);
    if (!s) return json(env, req, { error: 'reauth' }, 401);
    return json(env, req, {
      ok: true,
      configured: !!env.GEMINI_API_KEY,
      model: String(env.GEMINI_MODEL || 'gemini-3.5-flash-lite'),
      max_per_hour: Math.min(120, Math.max(10, Number(env.GEMINI_MAX_PER_HOUR) || 40)),
    });
  }

  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return new Response('Server error: ' + (e.message || 'unknown'), { status: 500 }); }
  },
};
