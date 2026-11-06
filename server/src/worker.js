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
// Microsoft (an extra connection next to Google; the Daylight session stays Google's):
//   POST /api/microsoft/start  (Bearer <session>, {return}) → { url } of Microsoft's consent screen (state + PKCE kept here)
//   GET  /auth/microsoft/callback                       → stores Microsoft's refresh token (encrypted) in that session
//   POST /api/microsoft/token  (Bearer <session>)       → { access_token, expires_in, scope, email, name, account }
//   POST /api/microsoft/disconnect (Bearer <session>)   → forgets the Microsoft token for this session
//
// Connections (v113, "connections_v1"): one Daylight identity (user:<uid>) holds up to 2 Google + 2 Microsoft
// connections. Each connection keeps its own refresh token (tok:<uid>:<connId>, AES-GCM with AAD "uid|connId": a token
// copied to another user or connection does not decrypt). A session (one per device sign-in) only points at the
// identity. Signing in with any connected Google account opens the same identity on any device.
//   GET  /api/connections                        → { user, login, caps, connections[ no tokens ], tombstones }
//   POST /api/connections/start {provider, return, reconnect?} → { url } consent screen (sealed single-use state)
//   GET  /auth/google/callback, /auth/microsoft/callback → a PENDING connection (#daylight_conn_pending=…)
//   POST /api/connections/confirm {pending}      → a session of the same identity attaches it (never replaces another)
//   POST /api/connections/token {connId}         → short-lived access token for that connection only
//   POST /api/connections/disconnect {connId}    → deletes that connection's token (Google: revoked) + tombstone
//   POST /api/identity/delete {confirm:'delete-identity'} → every token (Google revoked), login and the identity
// Identity is established only by a Google subject id (login:g:<sha(sub)>), never by an email or a Microsoft account.
// The routes above (google/token, microsoft/*, logout) keep working for older apps: google/token = this session's
// sign-in account, microsoft/* = the first Microsoft connection.

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
// Microsoft Graph, read-only: mail and the user's own OneDrive files. No send, no write, no files shared by others.
const MS_SCOPES = 'openid profile email offline_access User.Read Mail.Read Files.Read';
const MS_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'; // personal and work/school accounts
const hasMsMailRead = (s) => /(?:^|\s)(?:https:\/\/graph\.microsoft\.com\/)?Mail\.Read(?:\s|$)/i.test(scopeBlob(s));
const hasMsFilesRead = (s) => /(?:^|\s)(?:https:\/\/graph\.microsoft\.com\/)?Files\.Read(?:\s|$)/i.test(scopeBlob(s));
const SESSION_TTL = 60 * 60 * 24 * 180; // sessions idle for 180 days are forgotten
const USER_TTL = 60 * 60 * 24 * 400;    // an identity nobody used for 400 days is forgotten (with its tokens)
const CAPS = { google: 2, microsoft: 2 }; // initial capacity per Daylight identity
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
const gcm = (iv, aad) => (aad ? { name: 'AES-GCM', iv, additionalData: enc.encode(aad) } : { name: 'AES-GCM', iv });
async function seal(env, text, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(gcm(iv, aad), await aesKey(env), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64url(out);
}
async function open(env, sealed, aad) {
  const all = fromB64(sealed);
  return dec.decode(await crypto.subtle.decrypt(gcm(all.slice(0, 12), aad), await aesKey(env), all.slice(12)));
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
function googleClaims(idToken) {
  try { const c = JSON.parse(dec.decode(fromB64(idToken.split('.')[1]))); return { sub: String(c.sub || ''), email: String(c.email || '').toLowerCase(), name: String(c.name || '') }; } catch { return { sub: '', email: '', name: '' }; }
}
/** The device key of a Google account = its Google "sub" (what the app reads from userinfo), else its email. */
const googleKey = (c) => c.sub || c.email;
async function msToken(params) {
  const r = await fetch(MS_AUTHORITY + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error_description || data.error || 'Microsoft token request failed'); e.code = data.error; throw e; }
  return data;
}
function msClaims(idToken) {
  try { const c = JSON.parse(dec.decode(fromB64(idToken.split('.')[1]))); return { email: String(c.email || c.preferred_username || '').toLowerCase(), name: String(c.name || ''), oid: String(c.oid || c.sub || ''), tid: String(c.tid || '') }; } catch { return { email: '', name: '', oid: '', tid: '' }; }
}
// ---------- identity + connections store ----------
// v112.2 review: identity is established ONLY by a Google account's immutable subject id ("sub"), never by an email
// address and never by a Microsoft account. login:g:<sha(sub)> → uid. The uid is derived from the first Google sub
// (u-<sha("uid:"+sub)>), so repeated or simultaneous migrations of the same account converge on one identity.
const userKey = (uid) => 'user:' + uid;
const tokKey = (uid, id) => 'tok:' + uid + ':' + id;
const loginKey = async (sub) => 'login:g:' + await sha256(sub);
const getUser = (env, uid) => env.SESSIONS.get(userKey(uid), 'json');
const DAYS = 86400000;
/** Write the identity record. KV has no compare-and-swap: write, read back, and re-apply the change if another write
 *  won (bounded retries). mutate(u) must be idempotent; it returns false to abort. */
async function mutateUser(env, uid, mutate) {
  for (let i = 0; i < 4; i++) {
    const u = await getUser(env, uid); if (!u) return null;
    const out = await mutate(u); if (out === false) return { aborted: true, user: u };
    u.rev = randomId(6); u.touchedAt = Date.now();
    u.tombstones = Object.fromEntries(Object.entries(u.tombstones || {}).filter(([, t]) => Date.now() - (t.deletedAt || 0) < 400 * DAYS));
    await env.SESSIONS.put(userKey(uid), JSON.stringify(u), { expirationTtl: USER_TTL });
    const check = await getUser(env, uid);
    if (check && check.rev === u.rev) return { user: u, out };
  }
  return { conflict: true };
}
async function findUid(env, claims) { return claims.sub ? env.SESSIONS.get(await loginKey(claims.sub)) : null; }
async function setLogin(env, sub, uid) { if (sub) await env.SESSIONS.put(await loginKey(sub), uid, { expirationTtl: USER_TTL }); }
async function dropLogin(env, conn, uid) { if (conn.provider === 'google' && conn.sub) { const k = await loginKey(conn.sub); if ((await env.SESSIONS.get(k)) === uid) await env.SESSIONS.delete(k); } }
const putTok = async (env, uid, id, rt) => env.SESSIONS.put(tokKey(uid, id), await seal(env, rt, uid + '|' + id), { expirationTtl: USER_TTL });
const getTok = async (env, uid, id) => { const v = await env.SESSIONS.get(tokKey(uid, id)); return v ? open(env, v, uid + '|' + id) : null; };
const publicConn = (c) => ({ id: c.id, provider: c.provider, accountKey: c.accountKey, email: c.email, name: c.name, role: c.role, status: c.status, createdAt: c.createdAt, connectedAt: c.connectedAt || null,
  mail_read: c.provider === 'microsoft' ? hasMsMailRead(c.scopes) : hasGmailReadonly(c.scopes), files_read: c.provider === 'microsoft' ? hasMsFilesRead(c.scopes) : false });
/** Identity record for a Google sub: an existing one (login mapping), else a new one at the derived uid. */
async function identityFor(env, sub) {
  const known = await env.SESSIONS.get(await loginKey(sub));
  if (known) { const u = await getUser(env, known); if (u) return u; }
  let uid = 'u-' + (await sha256('uid:' + sub)).slice(0, 22);
  const at = await getUser(env, uid);
  if (at && !at.connections.some((c) => c.provider === 'google' && c.sub === sub)) uid = 'u-' + randomId(16); // that uid belongs to an identity this account left
  if (!at || uid !== at.uid) { const u = { uid, v: 2, connections: [], tombstones: {}, created: Date.now() }; await env.SESSIONS.put(userKey(uid), JSON.stringify(u), { expirationTtl: USER_TTL }); return u; }
  return at;
}
/**
 * Add or refresh one connection of an identity. Never replaces another connection: the same account (provider +
 * accountKey) is updated in place; a different account is added as a new connection, within the caps.
 * The refresh token is written first (its key is per connection, so no other connection is touched).
 * → { conn, result: 'added' | 'updated' | 'reconnected' } or { error }
 */
async function upsertConnection(env, uid, p) {
  let result = null, conn = null;
  const r = await mutateUser(env, uid, (u) => {
    let c = u.connections.find((x) => x.provider === p.provider && x.accountKey === p.accountKey);
    if (!c) {
      if (p.onlyExisting) { result = { error: p.onlyExisting }; return false; }
      if (u.connections.filter((x) => x.provider === p.provider).length >= CAPS[p.provider]) { result = { error: 'limit_reached' }; return false; }
      c = { id: p.id || 'c-' + randomId(9), provider: p.provider, accountKey: p.accountKey, createdAt: Date.now(), role: p.provider === 'google' && !u.connections.some((x) => x.provider === 'google') ? 'primary' : 'secondary' };
      u.connections.push(c); result = 'added';
    } else result = c.status === 'needs_reconnect' ? 'reconnected' : 'updated';
    Object.assign(c, { email: p.email || c.email || '', name: p.name || c.name || '', sub: p.sub || c.sub || '', scopes: scopeBlob(p.scopes || c.scopes), status: 'active', connectedAt: Date.now() });
    delete c.error;
    if (u.tombstones && u.tombstones[c.accountKey]) delete u.tombstones[c.accountKey]; // reconnecting deliberately ends a deletion
    conn = c;
  });
  if (!r) return { error: 'identity_gone' };
  if (r.conflict) return { error: 'busy_try_again' };
  if (r.aborted) return result;
  await putTok(env, uid, conn.id, p.rt);
  return { conn, result };
}
/** Google refresh-token → { tok, claims } (claims from the refreshed id_token, else the userinfo endpoint). */
async function googleRefresh(env, rt) {
  const tok = await googleToken({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' });
  let claims = tok.id_token ? googleClaims(tok.id_token) : { sub: '', email: '', name: '' };
  if (!claims.sub && tok.access_token) { try { const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } }); if (r.ok) { const j = await r.json(); claims = { sub: String(j.sub || ''), email: String(j.email || '').toLowerCase(), name: String(j.name || '') }; } } catch {} }
  return { tok, claims };
}
/**
 * The session behind a request → { key, rec, uid, user }. Sessions of v112.1 and older ({ email, rt, scopes, ms }) are
 * moved into an identity on first use: their Google and Microsoft tokens become connections (re-sealed with AAD),
 * nothing is re-keyed (Google: the account's sub = the app's key; Microsoft: the same ms-… key). The old record is
 * rewritten last, so an interrupted migration simply runs again (idempotent; same derived uid).
 */
async function sessionFrom(env, req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const key = 'sess:' + await sha256(m[1]);
  const rec = await env.SESSIONS.get(key, 'json');
  if (!rec) return null;
  if (rec.uid) { const user = await getUser(env, rec.uid); if (!user) { await env.SESSIONS.delete(key); return null; } return { key, rec, uid: rec.uid, user }; }
  if (!rec.rt) return null;
  // ---- lazy migration of an older session ----
  let rt; try { rt = await open(env, rec.rt); } catch { await env.SESSIONS.delete(key); return null; }
  let claims;
  try { claims = (await googleRefresh(env, rt)).claims; }
  catch (e) { if (['invalid_grant', 'unauthorized_client', 'invalid_client'].includes(e.code)) { await env.SESSIONS.delete(key); return null; } return { key, rec, uid: null, user: null, unavailable: true }; }
  if (!claims.sub) return { key, rec, uid: null, user: null, unavailable: true }; // never establish an identity without Google's subject id
  const user = await identityFor(env, claims.sub);
  const g = await upsertConnection(env, user.uid, { provider: 'google', accountKey: claims.sub, email: claims.email || rec.email, name: claims.name, sub: claims.sub, scopes: rec.scopes, rt });
  if (g.error) return g.error === 'limit_reached' ? null : { key, rec, uid: null, user: null, unavailable: true };
  await setLogin(env, claims.sub, user.uid);
  if (rec.ms && rec.ms.rt) { try { await upsertConnection(env, user.uid, { provider: 'microsoft', accountKey: rec.ms.account, email: rec.ms.email, name: rec.ms.name, scopes: rec.ms.scopes, rt: await open(env, rec.ms.rt) }); } catch {} }
  const next = { uid: user.uid, login: g.conn.id, email: claims.email || rec.email, created: rec.created || Date.now(), used: Date.now(), migratedAt: Date.now() };
  await env.SESSIONS.put(key, JSON.stringify(next), { expirationTtl: SESSION_TTL });
  return { key, rec: next, uid: user.uid, user: await getUser(env, user.uid) };
}
/** Using a session keeps it (180 days) and, at most once a month, the identity, its tokens and logins (400 days). */
async function touchSession(env, s) {
  await env.SESSIONS.put(s.key, JSON.stringify({ ...s.rec, used: Date.now() }), { expirationTtl: SESSION_TTL });
  if (s.user && Date.now() - (s.user.touchedAt || 0) > 30 * DAYS) {
    await mutateUser(env, s.uid, () => {});
    for (const c of s.user.connections) {
      const v = await env.SESSIONS.get(tokKey(s.uid, c.id)); if (v) await env.SESSIONS.put(tokKey(s.uid, c.id), v, { expirationTtl: USER_TTL });
      if (c.provider === 'google') await setLogin(env, c.sub, s.uid);
    }
  }
}
/** Access token for one connection. Google refresh tokens do not rotate; Microsoft's do (newest kept). Two refreshes at
 *  the same moment may both rotate: Microsoft keeps earlier refresh tokens valid, so whichever is stored still works. */
async function connToken(env, s, c) {
  let rt; try { rt = await getTok(env, s.uid, c.id); } catch { rt = null; }
  if (!rt) return { status: 401, body: { error: 'reconnect_required', connId: c.id, stage: 'missing' } };
  const markReconnect = async (code) => { await mutateUser(env, s.uid, (u) => { const cc = u.connections.find((x) => x.id === c.id); if (!cc) return false; cc.status = 'needs_reconnect'; cc.error = code || 'revoked'; }); await env.SESSIONS.delete(tokKey(s.uid, c.id)); };
  try {
    if (c.provider === 'google') {
      const tok = await googleToken({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' });
      const scope = scopeBlob(tok.scope || c.scopes || '');
      return { status: 200, body: { access_token: tok.access_token, expires_in: tok.expires_in || 3600, scope, email: c.email, account: c.accountKey, connId: c.id, gmail_readonly: hasGmailReadonly(scope), gmail_send: hasGmailSend(scope), needs_gmail_upgrade: !hasGmailReadonly(scope) } };
    }
    const tok = await msToken({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token', scope: MS_SCOPES });
    if (tok.refresh_token) await putTok(env, s.uid, c.id, tok.refresh_token); // rotation: keep only the newest
    const scopes = scopeBlob(tok.scope || c.scopes);
    return { status: 200, body: { access_token: tok.access_token, expires_in: tok.expires_in || 3600, scope: scopes, email: c.email, name: c.name, account: c.accountKey, connId: c.id, mail_read: hasMsMailRead(scopes), files_read: hasMsFilesRead(scopes) } };
  } catch (e) {
    const dead = c.provider === 'google' ? ['invalid_grant', 'unauthorized_client', 'invalid_client'] : ['invalid_grant', 'interaction_required', 'consent_required', 'unauthorized_client', 'invalid_client'];
    if (dead.includes(e.code)) { await markReconnect(e.code); return { status: 401, body: { error: 'reconnect_required', connId: c.id, stage: 'refresh', provider_error: e.code } }; }
    return { status: 502, body: { error: c.provider + '_unavailable', connId: c.id, stage: 'refresh', provider_error: e.code || 'unknown' } };
  }
}
/** Remove one connection: token deleted (Google: revoked), tombstone written so other devices delete its data too.
 *  Removing the identity's last Google account ends the identity (all its tokens). */
async function removeConnection(env, uid, connId) {
  let c = null, ended = false;
  const r = await mutateUser(env, uid, (u) => {
    c = u.connections.find((x) => x.id === connId); if (!c) return false;
    u.connections = u.connections.filter((x) => x.id !== c.id);
    u.tombstones = Object.assign({}, u.tombstones, { [c.accountKey]: { provider: c.provider, deletedAt: Date.now() } });
    if (c.role === 'primary') { const next = u.connections.find((x) => x.provider === 'google'); if (next) next.role = 'primary'; }
    ended = !u.connections.some((x) => x.provider === 'google');
  });
  if (!r || r.aborted || !c) return { error: 'not_found' };
  if (r.conflict) return { error: 'busy_try_again' };
  if (c.provider === 'google') { try { const rt = await getTok(env, uid, c.id); if (rt) await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }) }); } catch {} await dropLogin(env, c, uid); }
  await env.SESSIONS.delete(tokKey(uid, c.id));
  if (ended) { await deleteIdentity(env, uid, r.user); return { ok: true, removed: c.id, identityEnded: true }; }
  return { ok: true, removed: c.id, tombstone: c.accountKey };
}
/** Delete an identity: every token (Google ones revoked), every login mapping, the record. Its sessions then fail. */
async function deleteIdentity(env, uid, u0) {
  const u = u0 || await getUser(env, uid); if (!u) return;
  for (const c of u.connections) {
    if (c.provider === 'google') { try { const rt = await getTok(env, uid, c.id); if (rt) await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }) }); } catch {} await dropLogin(env, c, uid); }
    await env.SESSIONS.delete(tokKey(uid, c.id));
  }
  await env.SESSIONS.delete(userKey(uid));
}
/** The Google connection a session signed in with. If that account was disconnected, the session has ended (it never
 *  silently continues as another Google account). */
const loginConn = (s) => s.rec.login ? s.user.connections.find((x) => x.id === s.rec.login && x.provider === 'google') : s.user.connections.find((x) => x.provider === 'google' && x.role === 'primary');
const msConns = (s) => s.user.connections.filter((x) => x.provider === 'microsoft');
/** Pending connection (v112.2): a consent result is kept for 15 minutes and only joins the identity when a session OF
 *  THAT IDENTITY confirms it (POST /api/connections/confirm). A link started by someone else and completed in your
 *  browser can never attach your mailbox to their identity. */
async function putPending(env, uid, p) {
  const nonce = randomId(24);
  const { rt, ...meta } = p;
  await env.SESSIONS.put('pending:' + await sha256(nonce), JSON.stringify({ uid, meta, rt: await seal(env, rt, 'pending|' + uid), exp: Date.now() + 15 * 60 * 1000 }), { expirationTtl: 900 });
  return nonce;
}

async function handle(req, env) {
  const url = new URL(req.url);
  const redirectUri = url.origin + '/auth/google/callback';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });

  if (url.pathname === '/health') return json(env, req, { ok: true, features: ['logout_keep_grant', 'microsoft', 'connections_v1'], caps: CAPS });

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
      // V2: a normal sign-in asks for exactly the base scopes and does NOT merge older grants (Version 1 asked for
      // calendar, tasks, contacts, drive and gmail.send). Only adding a connector (?add=…) merges what is already granted.
      include_granted_scopes: add && !upgrade ? 'true' : 'false',
      state
    }).forEach(([k, v]) => g.searchParams.set(k, v));
    return Response.redirect(g.toString(), 302);
  }

  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    // ---- adding a Google account to an identity (sealed, self-contained, single-use state) ----
    if (state.startsWith('c.')) {
      let st = null; try { st = JSON.parse(await open(env, state.slice(2), 'connect')); } catch { st = null; }
      if (!st || !st.ret || st.k !== 'add' || st.provider !== 'google') return new Response('This sign-in link is not valid. Go back to Daylight and try again.', { status: 400 });
      const err = (code) => back(st.ret, { daylight_conn_error: code, daylight_conn_provider: 'google' });
      if (!(st.exp > Date.now())) return err('sign_in_too_slow');
      const used = 'cused:' + await sha256(state);
      if (await env.SESSIONS.get(used)) return err('already_used');
      await env.SESSIONS.put(used, '1', { expirationTtl: 1200 });
      if (url.searchParams.get('error')) return err(url.searchParams.get('error'));
      if (!(await getUser(env, st.uid))) return err('daylight_session_ended');
      let tok; try { tok = await googleToken({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }); } catch { return err('token_exchange_failed'); }
      const claims = googleClaims(tok.id_token || '');
      const allowed = list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());
      if (!claims.sub || !claims.email || (allowed.length && !allowed.includes(claims.email))) return err('account_not_allowed');
      if (!tok.refresh_token) return err('no_refresh_token');
      let granted = scopeBlob(tok.scope);
      if (!hasGmailReadonly(granted) && tok.access_token) { try { const info = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(tok.access_token)).then((r) => r.json()).catch(() => ({})); if (info?.scope) granted = scopeBlob(info.scope); } catch {} }
      if (!hasGmailReadonly(granted)) return err('gmail_readonly_required');
      // a Google account that signs in to ANOTHER Daylight identity is never moved silently
      const other = await findUid(env, claims);
      if (other && other !== st.uid) return err('account_in_another_daylight');
      const nonce = await putPending(env, st.uid, { provider: 'google', accountKey: claims.sub, email: claims.email, name: claims.name, sub: claims.sub, scopes: granted, rt: tok.refresh_token, reconnect: st.reconnect || null });
      return back(st.ret, { daylight_conn_pending: nonce, daylight_conn_provider: 'google' });
    }
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
    // identity = the Google subject id (never the email). Any Google account of an identity signs in to it.
    const claims = Object.assign(googleClaims(tok.id_token || ''), { email });
    if (!claims.sub) return back(ret, { daylight_error: 'identity_unavailable' });
    let user = await identityFor(env, claims.sub);
    let r = await upsertConnection(env, user.uid, { provider: 'google', accountKey: claims.sub, email, name: claims.name, sub: claims.sub, scopes: granted, rt: tok.refresh_token });
    if (r.error) return back(ret, { daylight_error: r.error === 'limit_reached' ? 'identity_full' : 'busy_try_again' });
    await setLogin(env, claims.sub, user.uid);
    const session = randomId(32);
    await env.SESSIONS.put('sess:' + await sha256(session), JSON.stringify({
      uid: user.uid, login: r.conn.id, email,
      created: Date.now(),
      upgradedAt: upgrade ? Date.now() : undefined
    }), { expirationTtl: SESSION_TTL });
    return back(ret, { daylight_session: session, daylight_gmail_readonly: '1' });
  }

  if (url.pathname === '/api/google/token' && req.method === 'POST') {
    // older apps: the access token of the Google account this session signed in with
    const s = await sessionFrom(env, req);
    if (!s) return json(env, req, { error: 'reauth' }, 401);
    if (s.unavailable) return json(env, req, { error: 'google_unavailable', stage: 'migrate' }, 502);
    const c = loginConn(s);
    if (!c) { await env.SESSIONS.delete(s.key); return json(env, req, { error: 'reauth', stage: 'account_disconnected' }, 401); }
    const t = await connToken(env, s, c);
    // the sign-in account's grant is gone → this session cannot continue (sign in again)
    if (t.status === 401) { await env.SESSIONS.delete(s.key); return json(env, req, { error: 'reauth', stage: t.body.stage, google_error: t.body.provider_error }, 401); }
    if (t.status === 200) await touchSession(env, s);
    return json(env, req, t.body, t.status);
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const s = await sessionFrom(env, req);
    // keep_grant=1: the browser replaced this session with a new sign-in — forget the session only.
    const keepGrant = url.searchParams.get('keep_grant') === '1';
    if (s && keepGrant) { await env.SESSIONS.delete(s.key); return json(env, req, { ok: true, forgotten: true }); }
    if (s && s.user) {
      // disconnect the Google account this session signed in with (revoked + tombstone); the other connections stay,
      // unless it was the identity's last Google account (then the identity and all its tokens are deleted)
      const c = loginConn(s); const r = c ? await removeConnection(env, s.uid, c.id) : null;
      await env.SESSIONS.delete(s.key);
      return json(env, req, { ok: true, identityEnded: !!(r && r.identityEnded) });
    }
    if (s) await env.SESSIONS.delete(s.key);
    return json(env, req, { ok: true });
  }

  // ---------- connections ----------
  const authed = async () => { const s = await sessionFrom(env, req); if (!s) return { res: json(env, req, { error: 'reauth' }, 401) }; if (!s.user) return { res: json(env, req, { error: 'google_unavailable', stage: 'migrate' }, 502) }; return { s }; };
  const bodyOf = async () => { try { return await req.json(); } catch { return {}; } };
  if (url.pathname === '/api/connections' && req.method === 'GET') {
    const { s, res } = await authed(); if (res) return res;
    await touchSession(env, s);
    return json(env, req, { user: s.uid, login: (loginConn(s) || {}).id || null, caps: CAPS, connections: s.user.connections.map(publicConn), tombstones: s.user.tombstones || {} });
  }
  // older apps call /api/microsoft/start (direct connect, see the callback); newer ones /api/connections/start (confirmed)
  if ((url.pathname === '/api/connections/start' || url.pathname === '/api/microsoft/start') && req.method === 'POST') {
    const { s, res } = await authed(); if (res) return res;
    const body = await bodyOf();
    const legacy = url.pathname === '/api/microsoft/start';
    const provider = legacy ? 'microsoft' : body.provider;
    if (!CAPS[provider]) return json(env, req, { error: 'bad_provider' }, 400);
    if (provider === 'microsoft' && (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET)) return json(env, req, { error: 'microsoft_not_configured' }, 503);
    const ret = allowedReturn(env, body.return);
    if (!ret) return json(env, req, { error: 'bad_return' }, 400);
    if (legacy && env.LEGACY_MS_CONNECT === 'off') return json(env, req, { error: 'update_app' }, 409);
    const reconnect = typeof body.reconnect === 'string' && s.user.connections.some((x) => x.id === body.reconnect) ? body.reconnect : null;
    const hint = reconnect ? (s.user.connections.find((x) => x.id === reconnect) || {}).email : '';
    if (!legacy && !reconnect && s.user.connections.filter((x) => x.provider === provider).length >= CAPS[provider]) return json(env, req, { error: 'limit_reached', cap: CAPS[provider] }, 409);
    if (provider === 'google') {
      const state = 'c.' + await seal(env, JSON.stringify({ k: 'add', provider, uid: s.uid, ret, reconnect, exp: Date.now() + 15 * 60 * 1000, n: randomId(8) }), 'connect');
      const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      Object.entries({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'false', state, ...(hint ? { login_hint: hint } : {}) }).forEach(([k, v]) => g.searchParams.set(k, v));
      return json(env, req, { url: g.toString() });
    }
    // The state is self-contained (encrypted with TOKEN_KEY): no KV read is needed on the way back, so the round trip
    // cannot fail on KV's eventual consistency between Cloudflare locations. Valid for 15 minutes.
    const verifier = randomId(48);
    const state = await seal(env, JSON.stringify({ ret, uid: s.uid, legacy, reconnect, verifier, exp: Date.now() + 15 * 60 * 1000, n: randomId(8) }));
    const m = new URL(MS_AUTHORITY + '/authorize');
    Object.entries({ client_id: env.MS_CLIENT_ID, redirect_uri: url.origin + '/auth/microsoft/callback', response_type: 'code', response_mode: 'query', scope: MS_SCOPES, prompt: 'select_account', state, code_challenge: await sha256(verifier), code_challenge_method: 'S256', ...(hint ? { login_hint: hint } : {}) }).forEach(([k, v]) => m.searchParams.set(k, v));
    return json(env, req, { url: m.toString() });
  }

  if (url.pathname === '/auth/microsoft/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    let st = null; try { st = state ? JSON.parse(await open(env, state)) : null; } catch { st = null; }
    if (!st || !st.ret) return new Response('This Microsoft sign-in link is not valid. Go back to Daylight and try again.', { status: 400 });
    if (!(st.exp > Date.now())) return back(st.ret, { daylight_ms_error: 'sign_in_too_slow' });
    // a state is used once: remember it until it would expire anyway
    const used = 'msused:' + await sha256(state);
    if (await env.SESSIONS.get(used)) return back(st.ret, { daylight_ms_error: 'already_used' });
    await env.SESSIONS.put(used, '1', { expirationTtl: 1200 });
    if (url.searchParams.get('error')) return back(st.ret, { daylight_ms_error: url.searchParams.get('error') });
    // states from v111 / v112.1 name a session; newer ones the identity
    let uid = st.uid || null, legacy = !!st.legacy || !st.uid;
    if (!uid && st.sess) { const rec = await env.SESSIONS.get(st.sess, 'json'); uid = rec && rec.uid; }
    const u = uid && await getUser(env, uid);
    if (!u) return back(st.ret, { daylight_ms_error: 'daylight_session_ended' });
    let tok;
    try { tok = await msToken({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, code: url.searchParams.get('code') || '', redirect_uri: url.origin + '/auth/microsoft/callback', grant_type: 'authorization_code', code_verifier: st.verifier, scope: MS_SCOPES }); }
    catch (e) { return back(st.ret, { daylight_ms_error: 'token_exchange_failed' }); }
    const who = msClaims(tok.id_token || '');
    const allowed = list(env.ALLOWED_MS_EMAILS).map((e) => e.toLowerCase());
    if (!who.oid || (allowed.length && !allowed.includes(who.email))) return back(st.ret, { daylight_ms_error: 'account_not_allowed' });
    if (!tok.refresh_token) return back(st.ret, { daylight_ms_error: 'no_refresh_token' });
    if (!hasMsMailRead(tok.scope)) return back(st.ret, { daylight_ms_error: 'mail_read_required' });
    const account = 'ms-' + (await sha256(who.tid + ':' + who.oid)).slice(0, 22); // stable, not the raw Microsoft ids
    const p = { provider: 'microsoft', accountKey: account, email: who.email, name: who.name, scopes: tok.scope, rt: tok.refresh_token, reconnect: st.reconnect || null };
    if (!legacy) return back(st.ret, { daylight_conn_pending: await putPending(env, uid, p), daylight_conn_provider: 'microsoft' });
    // An older app (one Microsoft account): connect directly as v112.1 did — but only the same account again, or a first
    // one. A different second account would be invisible to that app (and could be mistaken for a replacement).
    const ms = u.connections.filter((x) => x.provider === 'microsoft');
    if (ms.length && !ms.some((x) => x.accountKey === account)) return back(st.ret, { daylight_ms_error: 'update_app' });
    const r = await upsertConnection(env, uid, p);
    if (r.error) return back(st.ret, { daylight_ms_error: r.error });
    return back(st.ret, { daylight_ms: 'connected' });
  }

  if (url.pathname === '/api/connections/confirm' && req.method === 'POST') {
    const { s, res } = await authed(); if (res) return res;
    const body = await bodyOf();
    const pk = 'pending:' + await sha256(String(body.pending || ''));
    const pend = await env.SESSIONS.get(pk, 'json');
    if (!pend || !(pend.exp > Date.now())) return json(env, req, { error: 'expired' }, 410);
    await env.SESSIONS.delete(pk); // single use, whatever happens next
    if (pend.uid !== s.uid) return json(env, req, { error: 'not_your_connection' }, 403); // started by another identity: discarded
    let rt; try { rt = await open(env, pend.rt, 'pending|' + pend.uid); } catch { return json(env, req, { error: 'expired' }, 410); }
    const r = await upsertConnection(env, s.uid, { ...pend.meta, rt });
    if (r.error) return json(env, req, { error: r.error }, r.error === 'limit_reached' ? 409 : 503);
    if (pend.meta.provider === 'google') await setLogin(env, pend.meta.sub, s.uid);
    const differs = pend.meta.reconnect && pend.meta.reconnect !== r.conn.id;
    return json(env, req, { ok: true, result: differs ? 'added_different_account' : r.result, connection: publicConn(r.conn) });
  }

  if (url.pathname === '/api/connections/token' && req.method === 'POST') {
    const { s, res } = await authed(); if (res) return res;
    const body = await bodyOf();
    const c = s.user.connections.find((x) => x.id === body.connId);
    if (!c) return json(env, req, { error: 'not_connected', connId: body.connId || null }, 404);
    if (c.status === 'needs_reconnect') return json(env, req, { error: 'reconnect_required', connId: c.id, stage: 'status' }, 401);
    const t = await connToken(env, s, c);
    if (t.status === 200) await touchSession(env, s);
    return json(env, req, t.body, t.status);
  }

  if (url.pathname === '/api/connections/disconnect' && req.method === 'POST') {
    const { s, res } = await authed(); if (res) return res;
    const body = await bodyOf();
    const c = s.user.connections.find((x) => x.id === body.connId);
    if (!c) return json(env, req, { error: 'not_connected' }, 404);
    // the last Google account is the identity itself: use "Sign out and delete" (POST /auth/logout) for that
    if (c.provider === 'google' && s.user.connections.filter((x) => x.provider === 'google').length === 1) return json(env, req, { error: 'last_google_account' }, 409);
    const r = await removeConnection(env, s.uid, c.id);
    return json(env, req, r, r.error ? (r.error === 'not_found' ? 404 : 503) : 200);
  }

  if (url.pathname === '/api/identity/delete' && req.method === 'POST') {
    // "Delete my Daylight": every connection's token (Google revoked), every login, the identity. Explicit confirmation.
    const { s, res } = await authed(); if (res) return res;
    const body = await bodyOf();
    if (body.confirm !== 'delete-identity') return json(env, req, { error: 'confirm_required' }, 400);
    await deleteIdentity(env, s.uid, s.user);
    await env.SESSIONS.delete(s.key);
    return json(env, req, { ok: true, deleted: s.uid });
  }

  // ---------- older apps (one Microsoft account) ----------
  // They know one Microsoft account. With two connected (a newer app added one), these routes refuse instead of
  // guessing which one: a token for the wrong account, or disconnecting the wrong account, must never happen.
  if (url.pathname === '/api/microsoft/token' && req.method === 'POST') {
    const { s, res } = await authed(); if (res) return res;
    const all = msConns(s);
    if (all.length > 1) return json(env, req, { error: 'microsoft_unavailable', stage: 'update_app', microsoft_error: 'multiple_accounts' }, 502);
    const c = all[0];
    if (!c || c.status === 'needs_reconnect') return json(env, req, { error: 'ms_not_connected' }, 404);
    const t = await connToken(env, s, c);
    if (t.status === 401) return json(env, req, { error: 'ms_reauth', stage: t.body.stage, microsoft_error: t.body.provider_error }, 401);
    if (t.status !== 200) return json(env, req, { error: 'microsoft_unavailable', stage: 'refresh', microsoft_error: t.body.provider_error || 'unknown' }, 502);
    await touchSession(env, s);
    return json(env, req, t.body);
  }

  if (url.pathname === '/api/microsoft/disconnect' && req.method === 'POST') {
    const { s, res } = await authed(); if (res) return res;
    // Microsoft has no endpoint to revoke one app's consent for personal accounts; the stored token is deleted here and
    // the user can remove Daylight at account.live.com/consent/Manage (personal) or myapps.microsoft.com (work/school).
    const all = msConns(s);
    if (all.length > 1) return json(env, req, { error: 'update_app', reason: 'multiple_accounts' }, 409);
    if (all[0]) await removeConnection(env, s.uid, all[0].id);
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
