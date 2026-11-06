// Worker connections_v1 (Node, no network; Google + Microsoft mocked): one Daylight identity with 2 Google + 2 Microsoft
// connections, each with its own sealed refresh token (AAD uid|connId) and its own token endpoint; add never replaces;
// caps; independent refresh / failure / reconnect; per-connection disconnect + tombstones; cross-device identity;
// migration of older sessions; older-app routes. Run: node tests/worker-connections.mjs
import worker from '../server/src/worker.js';
import { webcrypto, createHash } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let pass = 0, fail = 0; const ok = (n, c, i) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (i !== undefined ? '  ← ' + JSON.stringify(i).slice(0, 500) : '')); } };
const kv = new Map();
const env = { TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', MS_CLIENT_ID: 'ms-cid', MS_CLIENT_SECRET: 'ms-sec', ALLOWED_ORIGINS: 'https://kratveer.github.io', ALLOWED_EMAILS: '', ALLOWED_MS_EMAILS: '',
  SESSIONS: { async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const gRevoked = new Set(), msRevoked = new Set(), revokeCalls = []; let down = new Set(); let rtSeq = 0;
const challenges = new Map(); const msCalls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url); const body = new URLSearchParams(init?.body || '');
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    if (body.get('grant_type') === 'authorization_code') { const who = body.get('code'); return new Response(JSON.stringify({ access_token: 'g-at-' + who, refresh_token: 'g-rt-' + who, id_token: 'x.' + b64u({ sub: 'sub-' + who, email: who + '@gmail.com', name: who }) + '.y', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' })); }
    const rt = body.get('refresh_token'); const who = rt.replace('g-rt-', '');
    if (down.has(who)) return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 });
    if (gRevoked.has(rt)) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(JSON.stringify({ access_token: 'g-fresh-' + who, expires_in: 3600, id_token: 'x.' + b64u({ sub: 'sub-' + who, email: who + '@gmail.com' }) + '.y', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' }));
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) { revokeCalls.push(body.get('token')); return new Response('{}'); }
  if (u === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    msCalls.push(Object.fromEntries(body));
    if (body.get('grant_type') === 'authorization_code') {
      const who = body.get('code'); const ch = challenges.get(who);
      if (!ch || createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== ch) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'm-at', refresh_token: 'm-rt-' + who + '-' + (++rtSeq), id_token: 'x.' + b64u({ preferred_username: who + '@outlook.com', name: who, oid: 'oid-' + who, tid: who.startsWith('work') ? 'tenant-x' : '9188040d' }) + '.y', scope: 'openid profile email offline_access User.Read Mail.Read Files.Read', expires_in: 3600 }));
    }
    const rt = body.get('refresh_token'); const who = rt.replace(/^m-rt-/, '').replace(/-\d+$/, '');
    if (down.has(who)) return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 });
    if (msRevoked.has(who)) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(JSON.stringify({ access_token: 'm-fresh-' + who, refresh_token: 'm-rt-' + who + '-' + (++rtSeq), scope: 'openid profile email offline_access User.Read Mail.Read Files.Read', expires_in: 3599 }));
  }
  return new Response('{}', { status: 404 });
};
const req = (path, opts = {}) => worker.fetch(new Request('https://w.test' + path, opts), env);
const RET = 'https://kratveer.github.io/Deshboard/';
const post = (path, s, body) => req(path, { method: 'POST', headers: { Authorization: 'Bearer ' + s, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const hashOf = (loc) => Object.fromEntries(new URLSearchParams(new URL(loc).hash.slice(1)));
async function signIn(who) {
  const g = new URL((await req('/auth/google/start?return=' + encodeURIComponent(RET))).headers.get('Location'));
  return hashOf((await req(`/auth/google/callback?state=${g.searchParams.get('state')}&code=${who}`)).headers.get('Location')).daylight_session;
}
const conns = async (s) => (await (await req('/api/connections', { headers: { Authorization: 'Bearer ' + s } })).json());
async function addGoogle(s, who, reconnect, opts) {
  const r = await post('/api/connections/start', s, { provider: 'google', return: RET, reconnect }); if (r.status !== 200) return { status: r.status, body: await r.json() };
  const g = new URL((await r.json()).url);
  const back = hashOf((await req(`/auth/google/callback?state=${encodeURIComponent(g.searchParams.get('state'))}&code=${who}`)).headers.get('Location'));
  if (!back.daylight_conn_pending || (opts && opts.noConfirm)) return { status: 200, url: g, back };
  const cf = await post('/api/connections/confirm', (opts && opts.confirmWith) || s, { pending: back.daylight_conn_pending });
  const cj = await cf.json();
  return { status: 200, url: g, back: Object.assign({}, back, { daylight_conn: cj.result, daylight_conn_id: cj.connection && cj.connection.id, confirm: cf.status, confirmError: cj.error }) };
}
async function addMs(s, who, reconnect, legacy, opts) {
  const r = legacy ? await post('/api/microsoft/start', s, { return: RET }) : await post('/api/connections/start', s, { provider: 'microsoft', return: RET, reconnect });
  if (r.status !== 200) return { status: r.status, body: await r.json() };
  const m = new URL((await r.json()).url); challenges.set(who, m.searchParams.get('code_challenge'));
  const back = hashOf((await req(`/auth/microsoft/callback?state=${encodeURIComponent(m.searchParams.get('state'))}&code=${who}`)).headers.get('Location'));
  if (!back.daylight_conn_pending || (opts && opts.noConfirm)) return { status: 200, url: m, back };
  const cf = await post('/api/connections/confirm', (opts && opts.confirmWith) || s, { pending: back.daylight_conn_pending });
  const cj = await cf.json();
  return { status: 200, url: m, back: Object.assign({}, back, { daylight_ms: cf.status === 200 ? 'connected' : undefined, daylight_ms_error: cj.error, daylight_conn: cj.result, daylight_conn_id: cj.connection && cj.connection.id, confirm: cf.status }) };
}
const tok = async (s, connId) => { const r = await post('/api/connections/token', s, { connId }); return { status: r.status, body: await r.json() }; };
const byEmail = (c, e) => c.connections.find((x) => x.email === e);

// ---- 1/2 two Google + two Microsoft on one identity ----
const S1 = await signIn('anna');
let c = await conns(S1);
ok('sign-in creates an identity with one Google connection (primary)', c.connections.length === 1 && c.connections[0].provider === 'google' && c.connections[0].role === 'primary' && c.connections[0].accountKey === 'sub-anna' && c.caps.google === 2 && c.caps.microsoft === 2);
const gb = await addGoogle(S1, 'bert');
ok('adding a 2nd Google account: Google\'s chooser, read-only scopes, offline, no merged grants', gb.url.searchParams.get('prompt') === 'select_account consent' && gb.url.searchParams.get('scope') === 'openid email profile https://www.googleapis.com/auth/gmail.readonly' && gb.url.searchParams.get('access_type') === 'offline' && gb.url.searchParams.get('include_granted_scopes') === 'false');
ok('…the callback hands back only a pending id (no session, no connection yet); confirming adds it', !!gb.back.daylight_conn_pending && gb.back.daylight_conn === 'added' && gb.back.daylight_conn_provider === 'google' && !gb.back.daylight_session, gb.back);
c = await conns(S1);
ok('both Google accounts stay connected (first not replaced)', c.connections.filter((x) => x.provider === 'google').map((x) => x.email).sort().join() === 'anna@gmail.com,bert@gmail.com' && byEmail(c, 'bert@gmail.com').role === 'secondary');
const m1 = await addMs(S1, 'mia'), m2 = await addMs(S1, 'work-max');
c = await conns(S1);
ok('two Microsoft accounts (personal + work) stay connected', m1.back.daylight_ms === 'connected' && m2.back.daylight_conn === 'added' && c.connections.filter((x) => x.provider === 'microsoft').length === 2 && byEmail(c, 'mia@outlook.com').accountKey !== byEmail(c, 'work-max@outlook.com').accountKey);
ok('3: all four connections listed, no tokens in the list', c.connections.length === 4 && !/rt-|g-at|m-at|fresh/.test(JSON.stringify(c)));
ok('caps: a 3rd Google or Microsoft account is refused (409 limit_reached), nothing replaced', (await addGoogle(S1, 'cara')).status === 409 && (await addMs(S1, 'mo')).status === 409 && (await conns(S1)).connections.length === 4);
ok('re-adding an already connected account updates it (no duplicate)', (await addGoogle(S1, 'bert', byEmail(c, 'bert@gmail.com').id)).back.daylight_conn === 'updated' && (await conns(S1)).connections.length === 4);
// ---- 4 independent tokens ----
const IDS = Object.fromEntries(c.connections.map((x) => [x.email, x.id])); const id = (e) => IDS[e];
const t = { a: await tok(S1, id('anna@gmail.com')), b: await tok(S1, id('bert@gmail.com')), m: await tok(S1, id('mia@outlook.com')), w: await tok(S1, id('work-max@outlook.com')) };
ok('4 each connection mints a token for its own account only', t.a.body.access_token === 'g-fresh-anna' && t.b.body.access_token === 'g-fresh-bert' && t.m.body.access_token === 'm-fresh-mia' && t.w.body.access_token === 'm-fresh-work-max' && t.b.body.account === 'sub-bert' && t.m.body.account === byEmail(c, 'mia@outlook.com').accountKey);
const lastRt = (who) => msCalls.filter((x) => x.grant_type === 'refresh_token' && x.refresh_token.startsWith('m-rt-' + who + '-')).map((x) => x.refresh_token);
await tok(S1, id('mia@outlook.com'));
ok('Microsoft rotation is per connection (Mia\'s next refresh uses Mia\'s newest token)', new Set(lastRt('mia')).size === 2 && lastRt('work-max').length === 1);
ok('KV holds no refresh token in the clear', ![...kv.values()].some((v) => /g-rt-|m-rt-/.test(v)));
// ---- 5 one fails, others continue ----
msRevoked.add('mia'); down.add('bert');
const f = { m: await tok(S1, id('mia@outlook.com')), b: await tok(S1, id('bert@gmail.com')), a: await tok(S1, id('anna@gmail.com')), w: await tok(S1, id('work-max@outlook.com')) };
ok('5 revoked consent → reconnect_required for that connection only', f.m.status === 401 && f.m.body.error === 'reconnect_required' && (await conns(S1)).connections.find((x) => x.email === 'mia@outlook.com').status === 'needs_reconnect');
ok('5 provider outage → 502 for that connection, it stays active', f.b.status === 502 && (await conns(S1)).connections.find((x) => x.email === 'bert@gmail.com').status === 'active');
ok('5 …the other two keep working', f.a.status === 200 && f.w.status === 200);
down = new Set();
// ---- 11 reconnect ----
msRevoked.delete('mia');
const rc = await addMs(S1, 'mia', id('mia@outlook.com'));
ok('11 reconnect restores the same connection (same id and device key), status active', rc.back.daylight_conn === 'reconnected' && rc.back.daylight_conn_id === id('mia@outlook.com') && (await tok(S1, id('mia@outlook.com'))).status === 200);
const wrong = await addMs(S1, 'molly', id('work-max@outlook.com'));
ok('reconnect where a DIFFERENT account is chosen: never replaces (full → limit_reached)', wrong.back.daylight_ms_error === 'limit_reached' && wrong.back.confirm === 409 && (await conns(S1)).connections.filter((x) => x.provider === 'microsoft').map((x) => x.email).sort().join() === 'mia@outlook.com,work-max@outlook.com');
// ---- 10 disconnect one ----
revokeCalls.length = 0;
const dB = await (await post('/api/connections/disconnect', S1, { connId: id('bert@gmail.com') })).json();
c = await conns(S1);
ok('10 disconnecting one Google account: removed + tombstone; only its token revoked', dB.ok && !byEmail(c, 'bert@gmail.com') && c.tombstones['sub-bert'] && revokeCalls.join() === 'g-rt-bert');
ok('10 …the other three keep working', (await tok(S1, id('anna@gmail.com'))).status === 200 && (await tok(S1, id('mia@outlook.com'))).status === 200 && (await tok(S1, id('work-max@outlook.com'))).status === 200);
ok('10 a disconnected connection has no token any more', (await tok(S1, id('bert@gmail.com'))).status === 404 && ![...kv.keys()].some((k) => k.endsWith(':' + id('bert@gmail.com'))));
const dM = await (await post('/api/connections/disconnect', S1, { connId: id('work-max@outlook.com') })).json();
c = await conns(S1);
ok('10 disconnecting one Microsoft account: removed + tombstone, Mia untouched', dM.ok && c.connections.length === 2 && c.tombstones[dM.tombstone] && (await tok(S1, id('mia@outlook.com'))).status === 200);
ok('10 the last Google account cannot be removed this way (409: use sign out)', (await post('/api/connections/disconnect', S1, { connId: id('anna@gmail.com') })).status === 409);
const back2 = await addMs(S1, 'molly', id('mia@outlook.com'));
ok('reconnect intent where a different account is chosen (room free) → added as a NEW connection, flagged; the original is kept', back2.back.daylight_conn === 'added_different_account' && (await conns(S1)).connections.length === 3 && (await conns(S1)).connections.some((x) => x.email === 'mia@outlook.com') && (await tok(S1, id('mia@outlook.com'))).status === 200);
const reB = await addGoogle(S1, 'bert');
ok('re-adding a disconnected account clears its tombstone', reB.back.daylight_conn === 'added' && !(await conns(S1)).tombstones['sub-bert']);
// ---- cross-device identity ----
const S2 = await signIn('bert'), S3 = await signIn('anna');
const c2 = await conns(S2), c3 = await conns(S3);
ok('another device signing in with EITHER connected Google account opens the same identity with all connections', c2.user === c.user && c3.user === c.user && c2.connections.length === 4 && c2.login !== c3.login);
ok('…and gets tokens for the connections (one identity, not per device)', (await tok(S2, id('mia@outlook.com'))).body.access_token === 'm-fresh-mia');
// ---- isolation between identities + AAD ----
const SX = await signIn('xena');
ok('12 another identity cannot use these connection ids (404)', (await tok(SX, id('mia@outlook.com'))).status === 404 && (await conns(SX)).connections.length === 1);
{
  const uidA = c.user, cx = await conns(SX); const uidX = cx.user;
  const mia = id('mia@outlook.com'), molly = (await conns(S1)).connections.find((x) => x.email === 'molly@outlook.com').id;
  const save = kv.get('tok:' + uidA + ':' + molly);
  kv.set('tok:' + uidA + ':' + molly, kv.get('tok:' + uidA + ':' + mia));
  const swapped = await tok(S1, molly);
  ok('12 a token copied onto another connection does not decrypt (AAD uid|connId) → reconnect_required, never Mia\'s token', swapped.status === 401 && swapped.body.access_token === undefined);
  kv.set('tok:' + uidX + ':' + cx.connections[0].id, kv.get('tok:' + uidA + ':' + id('anna@gmail.com')));
  ok('12 …nor onto another identity\'s connection', (await post('/api/google/token', SX)).status === 401);
  void save;
}
// ---- older apps ----
{
  const S = await signIn('olga');
  ok('older app: /api/google/token = the account this session signed in with', (await (await post('/api/google/token', S)).json()).email === 'olga@gmail.com');
  const l1 = await addMs(S, 'pia', null, true);
  ok('older app: /api/microsoft/start adds a connection; /api/microsoft/token = the first one', l1.back.daylight_ms === 'connected' && (await (await post('/api/microsoft/token', S)).json()).email === 'pia@outlook.com');
  const l2 = await addMs(S, 'quinn', null, true);
  ok('older app connecting a DIFFERENT second Microsoft account: refused (update_app) — never replaces, never adds an account it cannot see', l2.back.daylight_ms_error === 'update_app' && (await conns(S)).connections.filter((x) => x.provider === 'microsoft').length === 1 && (await (await post('/api/microsoft/token', S)).json()).email === 'pia@outlook.com');
  const l3 = await addMs(S, 'pia', null, true);
  ok('older app reconnecting the SAME Microsoft account works directly (as in v112.1)', l3.back.daylight_ms === 'connected' && (await conns(S)).connections.filter((x) => x.provider === 'microsoft').length === 1);
  await addMs(S, 'quinn'); // a newer app adds a 2nd Microsoft account
  const lt = await post('/api/microsoft/token', S), ld = await post('/api/microsoft/disconnect', S);
  ok('with 2 Microsoft accounts, the older-app token and disconnect routes refuse (never the wrong account)', lt.status === 502 && (await lt.json()).stage === 'update_app' && ld.status === 409 && (await conns(S)).connections.filter((x) => x.provider === 'microsoft').length === 2);
}
// ---- migration of an older session ----
{
  const sess = 'L'.repeat(43); const key = 'sess:' + createHash('sha256').update(sess).digest('base64url');
  const sealOld = async (txt) => { const k = await crypto.subtle.importKey('raw', Buffer.from(env.TOKEN_KEY, 'base64'), 'AES-GCM', false, ['encrypt']); const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(txt))); const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12); return Buffer.from(o).toString('base64url'); };
  kv.set(key, JSON.stringify({ email: 'rita@gmail.com', rt: await sealOld('g-rt-rita'), scopes: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', created: 1, ms: { account: 'ms-legacyKey000000000000', email: 'rita@outlook.com', name: 'Rita', rt: await sealOld('m-rt-rita-1'), scopes: 'openid profile email offline_access User.Read Mail.Read Files.Read' } }));
  const g = await (await post('/api/google/token', sess)).json();
  const cm = await conns(sess);
  ok('migration: an older session keeps working (Google token) and becomes an identity', g.email === 'rita@gmail.com' && g.access_token === 'g-fresh-rita' && cm.connections.length === 2);
  ok('migration: device keys are kept (Google sub, the old ms-… key) — nothing re-keyed', cm.connections.find((x) => x.provider === 'google').accountKey === 'sub-rita' && cm.connections.find((x) => x.provider === 'microsoft').accountKey === 'ms-legacyKey000000000000');
  ok('migration: the old session record holds no tokens any more', !JSON.parse(kv.get(key)).rt && !JSON.parse(kv.get(key)).ms && JSON.parse(kv.get(key)).uid === cm.user);
  ok('migration: the Microsoft token moved too', (await (await post('/api/microsoft/token', sess)).json()).email === 'rita@outlook.com');
}
// ---- 14 cancellation / expiry / single use ----
{
  const S = await signIn('sam');
  const r = await post('/api/connections/start', S, { provider: 'google', return: RET }); const st = new URL((await r.json()).url).searchParams.get('state');
  const cancel = hashOf((await req(`/auth/google/callback?state=${encodeURIComponent(st)}&error=access_denied`)).headers.get('Location'));
  ok('14 cancelling Google\'s screen returns daylight_conn_error=access_denied, nothing added', cancel.daylight_conn_error === 'access_denied' && (await conns(S)).connections.length === 1);
  const again = hashOf((await req(`/auth/google/callback?state=${encodeURIComponent(st)}&code=tom`)).headers.get('Location'));
  ok('14 a connect state is single-use', again.daylight_conn_error === 'already_used' && (await conns(S)).connections.length === 1);
  const r2 = await post('/api/connections/start', S, { provider: 'google', return: RET }); const st2 = new URL((await r2.json()).url).searchParams.get('state');
  const real = Date.now; Date.now = () => real() + 16 * 60 * 1000; const late = hashOf((await req(`/auth/google/callback?state=${encodeURIComponent(st2)}&code=tom`)).headers.get('Location')); Date.now = real;
  ok('14 after 15 minutes → sign_in_too_slow, nothing added', late.daylight_conn_error === 'sign_in_too_slow' && (await conns(S)).connections.length === 1);
  ok('14 a forged connect state is refused', (await req('/auth/google/callback?state=c.bogus&code=tom')).status === 400);
  ok('a connect start needs a session and an allowed return address', (await post('/api/connections/start', 'Z'.repeat(43), { provider: 'google', return: RET })).status === 401 && (await post('/api/connections/start', S, { provider: 'google', return: 'https://evil.example/' })).status === 400);
  gRevoked.add('g-rt-sam');
  const rv = await post('/api/google/token', S);
  ok('14 the sign-in account\'s Google grant revoked → older route 401 reauth (sign in again)', rv.status === 401);
}
// ---- sign out (older Disconnect) with other connections ----
{
  const S = await signIn('uma'); await addGoogle(S, 'vic'); await addMs(S, 'wes');
  const before = await conns(S);
  await post('/auth/logout', S);
  const SV = await signIn('vic'); const after = await conns(SV);
  ok('signing out the sign-in Google account removes only it; the identity keeps its other accounts (2nd Google becomes primary)', after.user === before.user && after.connections.length === 2 && after.connections.find((x) => x.provider === 'google').role === 'primary' && after.tombstones['sub-uma']);
  await post('/auth/logout', SV);
  const SV2 = await signIn('vic'); const fresh = await conns(SV2);
  ok('signing out the LAST Google account ends the identity (its Microsoft token deleted too)', fresh.user !== before.user && fresh.connections.length === 1 && ![...kv.keys()].some((k) => k.startsWith('tok:' + before.user)));
}
const h = await (await req('/health')).json();
ok('health advertises connections_v1 and the caps', (h.features || []).includes('connections_v1') && h.caps.google === 2 && h.caps.microsoft === 2);
console.log(`Worker connections: ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
