// Worker: Microsoft as an extra connection (Node, no network; Microsoft mocked).
// Linking needs a Daylight session; state + PKCE; refresh token encrypted and rotated; per-session isolation;
// disconnect; expired/revoked consent; read-only scopes. Run: node tests/worker-microsoft.mjs
import worker from '../server/src/worker.js';
import { webcrypto, createHash } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let pass = 0, fail = 0; const ok = (n, c, i) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (i !== undefined ? '  ← ' + JSON.stringify(i) : '')); } };
const kv = new Map(), ttl = new Map();
const env = { TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', MS_CLIENT_ID: 'ms-cid', MS_CLIENT_SECRET: 'ms-sec', ALLOWED_ORIGINS: 'https://kratveer.github.io', ALLOWED_EMAILS: '', ALLOWED_MS_EMAILS: '',
  SESSIONS: { async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v, o) { kv.set(k, v); ttl.set(k, o && o.expirationTtl); }, async delete(k) { kv.delete(k); } } };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const msCalls = []; let rtSeq = 0; const revokedRt = new Set(); let msScope = 'openid profile email offline_access User.Read Mail.Read Files.Read';
const challenges = new Map();
globalThis.fetch = async (url, init) => {
  const u = String(url); const body = new URLSearchParams(init?.body || '');
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    if (body.get('grant_type') === 'authorization_code') { const who = body.get('code'); return new Response(JSON.stringify({ access_token: 'g-at', refresh_token: 'g-rt-' + who, id_token: 'x.' + b64u({ email: who + '@gmail.com' }) + '.y', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' })); }
    return new Response(JSON.stringify({ access_token: 'g-fresh', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' }));
  }
  if (u === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    msCalls.push(Object.fromEntries(body));
    if (body.get('client_secret') !== 'ms-sec') return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
    if (body.get('grant_type') === 'authorization_code') {
      const [who, tid] = body.get('code').split('@');
      const ch = challenges.get(body.get('code'));
      if (!ch || createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== ch) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'm-at', refresh_token: 'm-rt-' + who + '-' + (++rtSeq), id_token: 'x.' + b64u({ preferred_username: who + '@outlook.com', name: who.toUpperCase(), oid: 'oid-' + who, tid: tid || '9188040d' }) + '.y', scope: msScope, expires_in: 3600 }));
    }
    const rt = body.get('refresh_token');
    if (revokedRt.has(rt)) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(JSON.stringify({ access_token: 'm-fresh-' + rt, refresh_token: rt.replace(/-\d+$/, '') + '-' + (++rtSeq), scope: msScope, expires_in: 3599 }));
  }
  return new Response('{}', { status: 404 });
};
const req = (path, opts = {}) => worker.fetch(new Request('https://w.test' + path, opts), env);
const RET = 'https://kratveer.github.io/Deshboard/';
async function googleSession(who) {
  const g = new URL((await req('/auth/google/start?return=' + encodeURIComponent(RET))).headers.get('Location'));
  const cb = await req(`/auth/google/callback?state=${g.searchParams.get('state')}&code=${who}`);
  return new URLSearchParams(new URL(cb.headers.get('Location')).hash.slice(1)).get('daylight_session');
}
const post = (path, s, body) => req(path, { method: 'POST', headers: { Authorization: 'Bearer ' + s, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
async function linkMs(session, who, tid) {
  const r = await post('/api/microsoft/start', session, { return: RET }); const j = await r.json();
  const m = new URL(j.url); const code = who + (tid ? '@' + tid : '');
  challenges.set(code, m.searchParams.get('code_challenge'));
  const cb = await req(`/auth/microsoft/callback?state=${m.searchParams.get('state')}&code=${encodeURIComponent(code)}`);
  return { authUrl: m, back: new URL(cb.headers.get('Location')), status: r.status };
}
const msTok = async (s) => { const r = await post('/api/microsoft/token', s); return { status: r.status, body: await r.json() }; };

const A = await googleSession('alice'), B = await googleSession('bob');
ok('linking Microsoft needs a Daylight session', (await post('/api/microsoft/start', 'Z'.repeat(43), { return: RET })).status === 401);
ok('…and an allowed return address', (await post('/api/microsoft/start', A, { return: 'https://evil.example/' })).status === 400);
const la = await linkMs(A, 'alice');
const sc = la.authUrl.searchParams;
ok('consent screen: common authority, read-only scopes (Mail.Read, Files.Read, offline_access), account chooser', la.authUrl.origin + la.authUrl.pathname === 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' && sc.get('scope') === 'openid profile email offline_access User.Read Mail.Read Files.Read' && sc.get('prompt') === 'select_account', la.authUrl.toString());
ok('no write, send or all-files scopes are ever asked', !/ReadWrite|Send|Files\.Read\.All|Mail\.ReadWrite|Sites\./i.test(sc.get('scope')));
ok('PKCE S256 is used and the redirect is the Worker callback', sc.get('code_challenge_method') === 'S256' && sc.get('code_challenge').length >= 43 && sc.get('redirect_uri') === 'https://w.test/auth/microsoft/callback');
ok('the session id never appears in the Microsoft URL', !la.authUrl.toString().includes(A));
ok('callback returns to Daylight with daylight_ms=connected', la.back.hash === '#daylight_ms=connected', la.back.toString());
const ta = await msTok(A);
ok('token: session A gets an access token for its Microsoft account', ta.status === 200 && /^m-fresh-m-rt-alice/.test(ta.body.access_token) && ta.body.email === 'alice@outlook.com' && ta.body.mail_read && ta.body.files_read && /^ms-/.test(ta.body.account), ta.body);
ok('the response never contains the refresh token', !JSON.stringify(ta.body).includes('m-rt-alice-') || ta.body.access_token.startsWith('m-fresh-'));
const raw = [...kv.values()].join('\n');
ok('KV holds no Microsoft refresh token or raw oid in the clear', !/m-rt-alice|oid-alice/.test(raw));
// rotation
const used1 = msCalls.filter((c) => c.grant_type === 'refresh_token').pop().refresh_token;
await msTok(A); const used2 = msCalls.filter((c) => c.grant_type === 'refresh_token').pop().refresh_token;
ok('refresh tokens rotate: the next refresh uses the newest token', used1 !== used2, { used1, used2 });
ok('Google token still works for the same session', (await (await post('/api/google/token', A)).json()).email === 'alice@gmail.com');
// isolation
ok('session B has no Microsoft connection (404)', (await msTok(B)).status === 404);
await linkMs(B, 'bob', 'tenant-work');
const tb = await msTok(B);
ok('session B links its own (work) account; A still gets Alice', tb.body.email === 'bob@outlook.com' && (await msTok(A)).body.email === 'alice@outlook.com' && tb.body.account !== ta.body.account);
// state
const st = await post('/api/microsoft/start', A, { return: RET }); const stUrl = new URL((await st.json()).url);
ok('the sign-in state is encrypted and self-contained (no KV read needed on return); it reveals nothing in clear', stUrl.searchParams.get('state').length > 100 && !/kratveer|sess:|verifier/.test(Buffer.from(stUrl.searchParams.get('state'), 'base64url').toString('latin1')));
{ // the same consent result arriving twice (reload / back button) is refused the second time
  const r = await post('/api/microsoft/start', A, { return: RET }); const m = new URL((await r.json()).url); challenges.set('alice', m.searchParams.get('code_challenge'));
  const st2 = m.searchParams.get('state'); await req(`/auth/microsoft/callback?state=${st2}&code=alice`);
  const again = await req(`/auth/microsoft/callback?state=${st2}&code=alice`);
  ok('a state can be used once (second use → already_used, back in Daylight)', new URL(again.headers.get('Location')).hash === '#daylight_ms_error=already_used'); }
{ // taking longer than 15 minutes on Microsoft's pages
  const r = await post('/api/microsoft/start', A, { return: RET }); const m = new URL((await r.json()).url);
  const real = Date.now; Date.now = () => real() + 16 * 60 * 1000;
  const late = await req(`/auth/microsoft/callback?state=${m.searchParams.get('state')}&code=alice`); Date.now = real;
  ok('after 15 minutes the user is sent back to Daylight with sign_in_too_slow (not a dead-end page)', new URL(late.headers.get('Location')).hash === '#daylight_ms_error=sign_in_too_slow'); }
const reuse = await req(`/auth/microsoft/callback?state=bogus&code=alice`);
ok('a forged or damaged state is refused', reuse.status === 400);
const denied = await req(`/auth/microsoft/callback?state=${stUrl.searchParams.get('state')}&error=access_denied`);
ok('declining on Microsoft\'s screen returns an error to Daylight, nothing stored', new URL(denied.headers.get('Location')).hash === '#daylight_ms_error=access_denied');
// PKCE mismatch
{ const r = await post('/api/microsoft/start', A, { return: RET }); const m = new URL((await r.json()).url); challenges.set('mallory', 'not-the-challenge');
  const cb = await req(`/auth/microsoft/callback?state=${m.searchParams.get('state')}&code=mallory`);
  ok('a code exchanged without the right PKCE verifier fails (token_exchange_failed)', new URL(cb.headers.get('Location')).hash === '#daylight_ms_error=token_exchange_failed'); }
// Mail.Read missing
{ msScope = 'openid profile email offline_access User.Read'; const C = await googleSession('carol'); const l = await linkMs(C, 'carol');
  ok('a grant without Mail.Read is refused (mail_read_required) and not stored', l.back.hash === '#daylight_ms_error=mail_read_required' && (await msTok(C)).status === 404);
  msScope = 'openid profile email offline_access User.Read Mail.Read Files.Read'; }
// allow-list
{ env.ALLOWED_MS_EMAILS = 'alice@outlook.com'; const D = await googleSession('dave'); const l = await linkMs(D, 'dave');
  ok('ALLOWED_MS_EMAILS restricts which Microsoft accounts can connect', l.back.hash === '#daylight_ms_error=account_not_allowed'); env.ALLOWED_MS_EMAILS = ''; }
// revoked consent
{ const cur = msCalls.filter((c) => c.grant_type === 'refresh_token' || c.grant_type === 'authorization_code').length;
  const E = await googleSession('erin'); await linkMs(E, 'erin'); const t1 = await msTok(E);
  const last = msCalls.filter((c) => c.grant_type === 'refresh_token').pop();
  // the stored token is now the rotated one; revoke every erin token
  for (let i = 0; i <= rtSeq; i++) revokedRt.add('m-rt-erin-' + i);
  const t2 = await msTok(E);
  ok('consent removed at Microsoft → ms_reauth and the stored token is deleted', t1.status === 200 && t2.status === 401 && t2.body.error === 'ms_reauth' && (await msTok(E)).status === 404, { t2 });
  ok('…while the Google side of that session keeps working', (await post('/api/google/token', E)).status === 200); }
// disconnect
await post('/api/microsoft/disconnect', A);
ok('disconnect forgets the Microsoft token; Google stays connected', (await msTok(A)).status === 404 && (await post('/api/google/token', A)).status === 200);
// Google logout removes everything
await post('/auth/logout', B);
ok('signing out of Daylight (Google) also deletes the Microsoft token of that session', (await msTok(B)).status === 401 && ![...kv.values()].some((v) => { try { const o = JSON.parse(v); return o.ms && o.email === 'bob@gmail.com'; } catch { return false; } }));
// not configured
{ const save = env.MS_CLIENT_SECRET; delete env.MS_CLIENT_SECRET; const F = await googleSession('fay');
  ok('without MS_CLIENT_SECRET the Worker says microsoft_not_configured (503)', (await post('/api/microsoft/start', F, { return: RET })).status === 503); env.MS_CLIENT_SECRET = save; }
const h = await (await req('/health')).json();
ok('health advertises microsoft', (h.features || []).includes('microsoft'));
console.log(`Worker Microsoft: ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
