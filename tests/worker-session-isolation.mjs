// Worker session isolation (Node, no network): each session mints tokens only for its own Google account,
// logout?keep_grant=1 forgets a session without revoking Google's grant, a plain logout revokes, OAuth scopes stay minimal.
import worker from '../server/src/worker.js';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let pass = 0, fail = 0; const ok = (n, c, i) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (i !== undefined ? '  ← ' + JSON.stringify(i) : '')); } };
const kv = new Map();
const env = { TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_ORIGINS: 'https://kratveer.github.io', ALLOWED_EMAILS: '',
  SESSIONS: { async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } };
const calls = [];
const idTok = (email) => 'x.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.y';
globalThis.fetch = async (url, init) => {
  const u = String(url); calls.push(u);
  const body = new URLSearchParams(init?.body || '');
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    if (body.get('grant_type') === 'authorization_code') { const who = body.get('code'); return new Response(JSON.stringify({ access_token: 'at-' + who, refresh_token: 'rt-' + who, id_token: idTok(who + '@example.com'), scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' })); }
    return new Response(JSON.stringify({ access_token: 'fresh-' + body.get('refresh_token'), expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' }));
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('{}');
  return new Response('{}', { status: 404 });
};
const req = (path, opts = {}) => worker.fetch(new Request('https://w.test' + path, opts), env);
async function signIn(who) {
  const start = await req('/auth/google/start?return=' + encodeURIComponent('https://kratveer.github.io/Deshboard/'));
  const g = new URL(start.headers.get('Location'));
  const scope = g.searchParams.get('scope');
  const cb = await req(`/auth/google/callback?state=${g.searchParams.get('state')}&code=${who}`);
  const h = new URLSearchParams(new URL(cb.headers.get('Location')).hash.slice(1));
  return { session: h.get('daylight_session'), scope };
}
const token = async (s) => { const r = await req('/api/google/token', { method: 'POST', headers: { Authorization: 'Bearer ' + s } }); return { status: r.status, body: await r.json() }; };
const A = await signIn('alice'), B = await signIn('bob');
ok('sign-in asks only for openid, email, profile and gmail.readonly', A.scope === 'openid email profile https://www.googleapis.com/auth/gmail.readonly', A.scope);
ok('each sign-in gets its own random session', A.session && B.session && A.session !== B.session && A.session.length >= 40);
const ta = await token(A.session), tb = await token(B.session);
ok("session A mints A's token and names A; session B names B", ta.body.email === 'alice@example.com' && ta.body.access_token === 'fresh-rt-alice' && tb.body.email === 'bob@example.com' && tb.body.access_token === 'fresh-rt-bob', { ta: ta.body.email, tb: tb.body.email });
ok('KV never stores a session id or a refresh token in the clear', [...kv.keys()].every((k) => !k.includes(A.session) && !k.includes(B.session)) && ![...kv.values()].some((v) => /rt-alice|rt-bob/.test(v)));
ok('an unknown or malformed session gets 401', (await token('Z'.repeat(43))).status === 401 && (await token('short')).status === 401);
const h = await (await req('/health')).json();
ok('health advertises logout_keep_grant', (h.features || []).includes('logout_keep_grant'));
calls.length = 0;
await req('/auth/logout?keep_grant=1', { method: 'POST', headers: { Authorization: 'Bearer ' + A.session } });
ok('logout?keep_grant=1 forgets session A without revoking at Google', !calls.some((u) => u.includes('/revoke')) && (await token(A.session)).status === 401);
ok('…and session B still works', (await token(B.session)).body.email === 'bob@example.com');
calls.length = 0;
await req('/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + B.session } });
ok('plain logout revokes at Google and deletes session B', calls.some((u) => u.includes('/revoke')) && (await token(B.session)).status === 401);
const sw = new URL((await req('/auth/google/start?switch=1&return=' + encodeURIComponent('https://kratveer.github.io/Deshboard/'))).headers.get('Location'));
ok('switch=1 shows Google\'s account chooser, same minimal scopes', sw.searchParams.get('prompt') === 'select_account consent' && sw.searchParams.get('scope') === A.scope);
console.log(`Worker session isolation: ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
