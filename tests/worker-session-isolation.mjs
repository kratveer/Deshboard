// Worker session isolation (Node, no network): each session mints tokens only for its own Google account,
// logout?keep_grant=1 forgets a session without revoking Google's grant, a plain logout revokes, OAuth scopes stay minimal.
import worker from '../server/src/worker.js';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let pass = 0, fail = 0; const ok = (n, c, i) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (i !== undefined ? '  ← ' + JSON.stringify(i) : '')); } };
const kv = new Map(), ttl = new Map();
const env = { TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_ORIGINS: 'https://kratveer.github.io', ALLOWED_EMAILS: '',
  SESSIONS: { async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v, o) { kv.set(k, v); ttl.set(k, o && o.expirationTtl); }, async delete(k) { kv.delete(k); } } };
const calls = [], gemini = [];
const idTok = (email) => 'x.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.y';
globalThis.fetch = async (url, init) => {
  const u = String(url); calls.push(u);
  const body = new URLSearchParams(init?.body || '');
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    if (body.get('grant_type') === 'authorization_code') { const who = body.get('code'); return new Response(JSON.stringify({ access_token: 'at-' + who, refresh_token: 'rt-' + who, id_token: idTok(who + '@example.com'), scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' })); }
    return new Response(JSON.stringify({ access_token: 'fresh-' + body.get('refresh_token'), expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' }));
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('{}');
  if (u.startsWith('https://generativelanguage.googleapis.com/')) { gemini.push({ url: u, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"sentences":[]}' }] } }] })); }
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
const base = new URL((await req('/auth/google/start?return=' + encodeURIComponent('https://kratveer.github.io/Deshboard/'))).headers.get('Location'));
const addC = new URL((await req('/auth/google/start?add=calendar&return=' + encodeURIComponent('https://kratveer.github.io/Deshboard/'))).headers.get('Location'));
ok('a normal sign-in does not merge older grants (include_granted_scopes=false); adding a connector does', base.searchParams.get('include_granted_scopes') === 'false' && sw.searchParams.get('include_granted_scopes') === 'false' && addC.searchParams.get('include_granted_scopes') === 'true' && /calendar\.events\.readonly/.test(addC.searchParams.get('scope')));

// ---- session lifetime, revocation, allow-list and the AI relay ----
{
  const C = await signIn('carol');
  const k = [...kv.keys()].find((x) => x.startsWith('sess:') && JSON.parse(kv.get(x)).email === 'carol@example.com');
  ok('a session is stored with a 180-day expiry; sign-in state with 10 minutes', ttl.get(k) === 60 * 60 * 24 * 180 && [...ttl.entries()].filter(([x]) => x.startsWith('state:')).every(([, t]) => t === 600));
  await token(C.session);
  ok('using a session renews its 180-day expiry (idle sessions expire)', ttl.get(k) === 60 * 60 * 24 * 180 && JSON.parse(kv.get(k)).used > 0);
  // Google says the refresh token is no longer valid (revoked at myaccount.google.com/permissions)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).startsWith('https://oauth2.googleapis.com/token') ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : realFetch(url, init);
  const rv = await token(C.session);
  globalThis.fetch = realFetch;
  ok('a revoked Google grant → 401 and the session record is deleted', rv.status === 401 && !kv.has(k));
  // allow-list
  env.ALLOWED_EMAILS = 'alice@example.com';
  const start = await req('/auth/google/start?return=' + encodeURIComponent('https://kratveer.github.io/Deshboard/'));
  const g = new URL(start.headers.get('Location'));
  const cb = await req(`/auth/google/callback?state=${g.searchParams.get('state')}&code=mallory`);
  const hh = new URLSearchParams(new URL(cb.headers.get('Location')).hash.slice(1));
  ok('an account not on the allow-list gets no session', !hh.get('daylight_session') && hh.get('daylight_error') === 'account_not_allowed');
  env.ALLOWED_EMAILS = '';
  // AI relay
  env.GEMINI_API_KEY = 'test-key';
  const D = await signIn('dave');
  const ask = (s, body) => req('/api/gemini/analyse', { method: 'POST', headers: { Authorization: 'Bearer ' + s, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  ok('the AI relay refuses requests without a valid session', (await ask('Z'.repeat(43), { prompt: 'x' })).status === 401 && gemini.length === 0);
  const r = await ask(D.session, { prompt: 'Question: q\nItems (JSON):\n[]', system: 'sys', temperature: 0.1, maxOutputTokens: 1024, extra: 'not forwarded', email: 'x@y.z' });
  const sent = gemini[0] || {};
  ok('the relay forwards only the prompt, the system instruction and generation settings to Gemini', r.status === 200 && gemini.length === 1 && JSON.stringify(Object.keys(sent.body).sort()) === JSON.stringify(['contents', 'generationConfig', 'systemInstruction']) && sent.body.contents[0].parts[0].text === 'Question: q\nItems (JSON):\n[]' && !JSON.stringify(sent.body).includes('not forwarded') && !JSON.stringify(sent.body).includes('x@y.z'), sent.body);
  ok('the Gemini API key stays on the Worker (never in a response to the browser)', !JSON.stringify(await r.clone().json()).includes('test-key'));
  await ask(D.session, { prompt: 'p'.repeat(30000) });
  ok('prompts are capped at 24,000 characters', (gemini[1] || {}).body?.contents?.[0]?.parts?.[0]?.text?.length === 24000);
}
console.log(`Worker session isolation: ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
