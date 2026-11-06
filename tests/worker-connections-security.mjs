// v112.2 independent review of connections_v1 (Node, no network; Google + Microsoft mocked):
// identity by Google subject id only · email / Microsoft can never establish or take over an identity · connect-CSRF
// (pending + confirm by the same identity) · AAD · concurrent refresh · migration from the real v112.1 session format
// (Google, Microsoft, both, provider down, no sub, interrupted, repeated, simultaneous) · lifecycle · retention ·
// identity deletion · tombstones · rollback to the v112.1 Worker and forward again. Run: node tests/worker-connections-security.mjs
import worker from '../server/src/worker.js';
import oldWorker from './fixtures/worker-v112.1.mjs';
import { webcrypto, createHash } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let pass = 0, fail = 0; const ok = (n, c, i) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (i !== undefined ? '  ← ' + JSON.stringify(i).slice(0, 500) : '')); } };
const kv = new Map(), ttl = new Map(); let putFail = null;
const env = { TOKEN_KEY: Buffer.from(new Uint8Array(32).fill(5)).toString('base64'), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', MS_CLIENT_ID: 'ms-cid', MS_CLIENT_SECRET: 'ms-sec', ALLOWED_ORIGINS: 'https://kratveer.github.io', ALLOWED_EMAILS: '', ALLOWED_MS_EMAILS: '',
  SESSIONS: { async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v, o) { if (putFail && putFail(k)) { putFail = null; throw new Error('KV write interrupted'); } kv.set(k, v); ttl.set(k, o && o.expirationTtl); }, async delete(k) { kv.delete(k); ttl.delete(k); } } };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SUB = { anna: 'S-1001', bert: 'S-1002', eve: 'S-6666', rita: 'S-2001', sam: 'S-3001', tina: 'S-4001' };
const subOf = (who) => SUB[who] || 'S-' + who;
let googleDown = false, noSub = new Set(); const revokes = []; let rtSeq = 0; const challenges = new Map();
globalThis.fetch = async (url, init) => {
  const u = String(url); const body = new URLSearchParams(init?.body || '');
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    if (body.get('grant_type') === 'authorization_code') {
      const [who, mail] = body.get('code').split('~'); // code "eve~anna" = Eve's account that uses the address anna@gmail.com (recycled)
      return new Response(JSON.stringify({ access_token: 'g-at-' + who, refresh_token: 'g-rt-' + who, id_token: 'x.' + b64u(noSub.has(who) ? { email: (mail || who) + '@gmail.com' } : { sub: subOf(who), email: (mail || who) + '@gmail.com', name: who }) + '.y', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' }));
    }
    if (googleDown) return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 });
    const who = body.get('refresh_token').replace('g-rt-', '');
    return new Response(JSON.stringify({ access_token: 'g-fresh-' + who, expires_in: 3600, ...(noSub.has(who) ? {} : { id_token: 'x.' + b64u({ sub: subOf(who), email: who + '@gmail.com' }) + '.y' }), scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' }));
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) { revokes.push(body.get('token')); return new Response('{}'); }
  if (u.startsWith('https://openidconnect.googleapis.com/')) return new Response('{}', { status: 404 });
  if (u === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    if (body.get('grant_type') === 'authorization_code') {
      const who = body.get('code'); const ch = challenges.get(who);
      if (!ch || createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== ch) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'm-at', refresh_token: 'm-rt-' + who + '-' + (++rtSeq), id_token: 'x.' + b64u({ preferred_username: who + '@outlook.com', name: who, oid: 'oid-' + who, tid: '9188040d', sub: 'anna-ms-sub' }) + '.y', scope: 'openid profile email offline_access User.Read Mail.Read Files.Read', expires_in: 3600 }));
    }
    const rt = body.get('refresh_token'); const who = rt.replace(/^m-rt-/, '').replace(/-\d+$/, '');
    await new Promise((r) => setTimeout(r, 5)); // let two refreshes overlap
    return new Response(JSON.stringify({ access_token: 'm-fresh-' + who, refresh_token: 'm-rt-' + who + '-' + (++rtSeq), scope: 'openid profile email offline_access User.Read Mail.Read Files.Read', expires_in: 3599 }));
  }
  return new Response('{}', { status: 404 });
};
const RET = 'https://kratveer.github.io/Deshboard/';
const mk = (w) => ({ req: (path, opts = {}) => w.fetch(new Request('https://w.test' + path, opts), env) });
const W = mk(worker), OLD = mk(oldWorker);
const hashOf = (loc) => Object.fromEntries(new URLSearchParams(new URL(loc).hash.slice(1)));
const post = (path, s, body, w = W) => w.req(path, { method: 'POST', headers: { Authorization: 'Bearer ' + s, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
async function signIn(code, w = W) { const g = new URL((await w.req('/auth/google/start?return=' + encodeURIComponent(RET))).headers.get('Location')); return hashOf((await w.req(`/auth/google/callback?state=${g.searchParams.get('state')}&code=${code}`)).headers.get('Location')); }
const conns = async (s) => (await W.req('/api/connections', { headers: { Authorization: 'Bearer ' + s } })).json();
async function startGoogle(s, code) { const r = await post('/api/connections/start', s, { provider: 'google', return: RET }); const g = new URL((await r.json()).url); return hashOf((await W.req(`/auth/google/callback?state=${encodeURIComponent(g.searchParams.get('state'))}&code=${code}`)).headers.get('Location')); }
async function startMs(s, who) { const r = await post('/api/connections/start', s, { provider: 'microsoft', return: RET }); const m = new URL((await r.json()).url); challenges.set(who, m.searchParams.get('code_challenge')); return hashOf((await W.req(`/auth/microsoft/callback?state=${encodeURIComponent(m.searchParams.get('state'))}&code=${who}`)).headers.get('Location')); }
const confirm = async (s, pending) => { const r = await post('/api/connections/confirm', s, { pending }); return { status: r.status, body: await r.json() }; };
const keysLike = (re) => [...kv.keys()].filter((k) => re.test(k));

// ================= 1. identity =================
const A = (await signIn('anna')).daylight_session;
const ca = await conns(A);
ok('1 identity is keyed by the Google subject id (device key = sub), uid derived from it', ca.connections[0].accountKey === 'S-1001' && ca.user.startsWith('u-'));
const addB = await startGoogle(A, 'bert'); const cfB = await confirm(A, addB.daylight_conn_pending);
const B = (await signIn('bert')).daylight_session;
ok('1 both Google accounts resolve to exactly the same identity', cfB.status === 200 && (await conns(B)).user === ca.user);
const eve = await signIn('eve~anna'); // a DIFFERENT Google account (other sub) that uses anna's (recycled) address
const ce = await conns(eve.daylight_session);
ok('1 an account with the same email but another subject id gets ITS OWN identity (emails never establish identity)', ce.user !== ca.user && ce.connections.length === 1 && ce.connections[0].accountKey === 'S-6666');
ok('1 no email-based login mappings exist at all', keysLike(/^login:e:/).length === 0 && keysLike(/^login:g:/).length === 3);
noSub.add('nosub');
ok('1 a Google sign-in without a subject id gets no identity (identity_unavailable, no session)', (await signIn('nosub')).daylight_error === 'identity_unavailable');
const steal = await startGoogle(eve.daylight_session, 'bert'); // Eve tries to add Bert's account (which signs in to Anna's identity)
ok('1 a Google account that signs in to another identity cannot be moved into this one (account_in_another_daylight)', steal.daylight_conn_error === 'account_in_another_daylight' && (await conns(B)).user === ca.user);
const msAdd = await startMs(A, 'anna'); await confirm(A, msAdd.daylight_conn_pending);
ok('1 Microsoft connections never create a login mapping (they cannot establish or change the identity)', keysLike(/^login:/).length === 3 && (await conns(A)).connections.filter((x) => x.provider === 'microsoft').length === 1);
// connect-CSRF: Eve starts a connect, Anna's browser completes it (Anna signed in to Google as Rita)
{
  const r = await post('/api/connections/start', eve.daylight_session, { provider: 'google', return: RET }); const g = new URL((await r.json()).url);
  const victimBack = hashOf((await W.req(`/auth/google/callback?state=${encodeURIComponent(g.searchParams.get('state'))}&code=rita`)).headers.get('Location'));
  ok('1 a consent completed in someone else\'s browser is only PENDING (nothing attached yet)', !!victimBack.daylight_conn_pending && (await conns(eve.daylight_session)).connections.length === 1);
  const vc = await confirm(A, victimBack.daylight_conn_pending); // the victim's own app confirms with its own session
  ok('1 confirming with a session of ANOTHER identity is refused (403) and the pending result is discarded', vc.status === 403 && vc.body.error === 'not_your_connection' && (await confirm(eve.daylight_session, victimBack.daylight_conn_pending)).status === 410 && (await conns(eve.daylight_session)).connections.length === 1);
  ok('1 the pending refresh token is sealed and expires in 15 minutes', keysLike(/^pending:/).every((k) => ttl.get(k) === 900) && ![...kv.values()].some((v) => /g-rt-|m-rt-/.test(v)));
}
// ================= 2. tokens =================
{
  const c = await conns(A); const msId = c.connections.find((x) => x.provider === 'microsoft').id;
  const [t1, t2] = await Promise.all([post('/api/connections/token', A, { connId: msId }), post('/api/connections/token', A, { connId: msId })]);
  const t3 = await post('/api/connections/token', A, { connId: msId });
  ok('2 two simultaneous Microsoft refreshes both succeed; the stored (rotated) token still works afterwards', t1.status === 200 && t2.status === 200 && t3.status === 200);
  const all = JSON.stringify(await conns(A));
  ok('2 the connection list never contains tokens or the session', !/g-rt-|m-rt-|g-fresh|m-fresh|access_token/.test(all) && !all.includes(A));
  googleDown = true; const down = await post('/api/connections/token', A, { connId: c.connections.find((x) => x.accountKey === 'S-1002').id }); googleDown = false;
  ok('2 provider unavailable → 502 (connection stays active); revoked → 401 reconnect_required; unknown → 404', down.status === 502 && (await conns(A)).connections.every((x) => x.status === 'active') && (await post('/api/connections/token', A, { connId: 'c-nope' })).status === 404);
}
// ================= 3. migration from the real v112.1 format =================
async function legacySession(code, withMs) {
  const s = (await signIn(code, OLD)).daylight_session; // created by the v112.1 Worker itself
  if (withMs) { const r = await post('/api/microsoft/start', s, { return: RET }, OLD); const m = new URL((await r.json()).url); challenges.set(withMs, m.searchParams.get('code_challenge')); await OLD.req(`/auth/microsoft/callback?state=${m.searchParams.get('state')}&code=${withMs}`); }
  return s;
}
const recOf = (s) => JSON.parse(kv.get('sess:' + createHash('sha256').update(s).digest('base64url')) || 'null');
{
  const L1 = await legacySession('rita', 'rita');
  const before = recOf(L1);
  ok('3 setup: a genuine v112.1 session record (email, sealed rt, ms{account, rt})', before.email === 'rita@gmail.com' && before.rt && before.ms && /^ms-/.test(before.ms.account) && !before.uid);
  googleDown = true; const d = await post('/api/google/token', L1); googleDown = false;
  ok('3 Google unavailable during migration → 502, the old record is untouched (retried later)', d.status === 502 && JSON.stringify(recOf(L1)) === JSON.stringify(before));
  // interrupted: the final session rewrite fails once
  putFail = (k) => k.startsWith('sess:') && kv.get(k) && !JSON.parse(kv.get(k)).uid && JSON.parse(kv.get(k)).email === 'rita@gmail.com';
  const interrupted = (await post('/api/google/token', L1)).status; const stillOld = !recOf(L1).uid && !!recOf(L1).rt;
  const after1 = [...kv.keys()].filter((k) => k.startsWith('user:'));
  const g = await (await post('/api/google/token', L1)).json(); const c = await conns(L1);
  ok('3 an interrupted migration (session rewrite failed → 500) simply runs again: one identity, no duplicate connections', interrupted === 500 && stillOld && g.email === 'rita@gmail.com' && c.connections.length === 2 && [...kv.keys()].filter((k) => k.startsWith('user:')).length === after1.length && recOf(L1).uid === c.user, { interrupted });
  ok('3 keys are kept: Google = sub, Microsoft = the same ms-… key', c.connections.find((x) => x.provider === 'google').accountKey === 'S-2001' && c.connections.find((x) => x.provider === 'microsoft').accountKey === before.ms.account);
  ok('3 the Microsoft connection works after migration (rotated per connection)', (await (await post('/api/microsoft/token', L1)).json()).email === 'rita@outlook.com' && (await (await post('/api/microsoft/token', L1)).json()).access_token === 'm-fresh-rita');
  // repeated: a second device's v112.1 session of the same account
  const L2 = await legacySession('rita', 'rita');
  await post('/api/google/token', L2); const c2 = await conns(L2);
  ok('3 repeated migration (another device, same accounts) joins the same identity; still 1 Google + 1 Microsoft', c2.user === c.user && c2.connections.length === 2);
  // simultaneous: two requests on a fresh v112.1 session (first use)
  const L3 = await legacySession('sam', 'sam');
  const rs = await Promise.all([post('/api/google/token', L3), post('/api/microsoft/token', L3), W.req('/api/connections', { headers: { Authorization: 'Bearer ' + L3 } })]);
  const c3 = await conns(L3);
  ok('3 two simultaneous first requests migrate once: one identity (derived uid), 1 Google + 1 Microsoft', rs.every((r) => r.status === 200) && c3.connections.length === 2 && [...kv.keys()].filter((k) => k.startsWith('user:') && JSON.parse(kv.get(k)).connections.some((x) => x.accountKey === 'S-3001')).length === 1);
  // Google-only and Microsoft-less
  const L4 = await legacySession('tina'); await post('/api/google/token', L4);
  ok('3 a Google-only v112.1 session migrates to one Google connection', (await conns(L4)).connections.length === 1);
  noSub.add('ursula'); const L5 = await legacySession('ursula'); const nsr = await post('/api/google/token', L5);
  ok('3 when Google gives no subject id, nothing is migrated (502, record kept) — no identity from an email', nsr.status === 502 && !recOf(L5).uid && recOf(L5).rt);
  ok('3 after migration no session record holds a token', [...kv.entries()].filter(([k]) => k.startsWith('sess:')).every(([, v]) => !JSON.parse(v).uid || (!JSON.parse(v).rt && !JSON.parse(v).ms)));
}
// ================= 4. lifecycle =================
{
  const c = await conns(A); const bId = c.connections.find((x) => x.accountKey === 'S-1002').id;
  revokes.length = 0;
  await post('/api/connections/disconnect', A, { connId: bId });
  ok('4 disconnecting Bert (Google 2) revokes only Bert, removes his login, writes a tombstone', revokes.join() === 'g-rt-bert' && (await conns(A)).tombstones['S-1002'] && keysLike(/^login:g:/).length >= 1);
  const bt = await post('/api/google/token', B);
  ok('4 a session that signed in as Bert (another device) ends — it never continues as another Google account', bt.status === 401 && (await bt.json()).stage === 'account_disconnected');
  const reB = await signIn('bert');
  ok('4 Bert signing in again later starts his OWN identity (he left this one); Anna\'s is unchanged', (await conns(reB.daylight_session)).user !== ca.user && (await conns(A)).connections.length === 2);
  const last = await post('/api/connections/disconnect', A, { connId: (await conns(A)).connections.find((x) => x.provider === 'google').id });
  ok('4 the final Google account cannot be disconnected individually (409, use sign out)', last.status === 409);
}
// ================= 5/6. retention, deletion, tombstones =================
{
  const T = (await signIn('tess')).daylight_session; const add = await startMs(T, 'tom'); await confirm(T, add.daylight_conn_pending);
  const ct = await conns(T); const uid = ct.user;
  ok('6 identity, tokens and login are kept 400 days; a session 180 days', ttl.get('user:' + uid) === 400 * 86400 && ct.connections.every((c) => ttl.get('tok:' + uid + ':' + c.id) === 400 * 86400) && keysLike(/^sess:/).every((k) => ttl.get(k) === 180 * 86400));
  const real = Date.now; Date.now = () => real() + 31 * 86400000; ttl.clear(); await conns(T); Date.now = real;
  ok('6 using the app refreshes the identity, every token and the login (monthly), so an active identity never expires', ttl.get('user:' + uid) === 400 * 86400 && ct.connections.every((c) => ttl.get('tok:' + uid + ':' + c.id) === 400 * 86400) && keysLike(/^login:g:/).some((k) => ttl.get(k) === 400 * 86400));
  ok('6 identity deletion needs an explicit confirmation', (await post('/api/identity/delete', T, {})).status === 400);
  revokes.length = 0; const del = await post('/api/identity/delete', T, { confirm: 'delete-identity' });
  ok('6 deleting the identity removes every token (Google revoked), the login and the record; its sessions end', del.status === 200 && revokes.includes('g-rt-tess') && !kv.has('user:' + uid) && !keysLike(new RegExp('^tok:' + uid)).length && (await conns(T)).error === 'reauth');
  const real2 = Date.now; const X = (await signIn('xavi')).daylight_session; const xa = await startMs(X, 'xm'); await confirm(X, xa.daylight_conn_pending);
  await post('/api/connections/disconnect', X, { connId: (await conns(X)).connections.find((x) => x.provider === 'microsoft').id });
  ok('6 tombstones are listed for every device of the identity', Object.keys((await conns(X)).tombstones).length === 1);
  Date.now = () => real2() + 401 * 86400000;
  const xs = (await signIn('xavi')).daylight_session; const x2 = await startMs(xs, 'xm2'); await confirm(xs, x2.daylight_conn_pending); const tomb = (await conns(xs)).tombstones; Date.now = real2;
  ok('6 tombstones older than 400 days are pruned on the next write', Object.keys(tomb).length === 0, tomb);
}
// ================= 7. rollback and roll-forward =================
{
  const N = (await signIn('nina')).daylight_session; const add = await startMs(N, 'nm'); await confirm(N, add.daylight_conn_pending);
  const before = await conns(N);
  const old = await post('/api/google/token', N, null, OLD);
  ok('7 ROLLBACK: the v112.1 Worker cannot read a connections_v1 session → 401 (the app asks to sign in again)', old.status === 401);
  const L = (await signIn('nina', OLD)).daylight_session;
  ok('7 …signing in again on the v112.1 Worker works (a v112.1 session)', (await (await post('/api/google/token', L, null, OLD)).json()).email === 'nina@gmail.com');
  const fwd = await post('/api/google/token', L);
  const after = await conns(L);
  ok('7 ROLL FORWARD: that v112.1 session migrates into the SAME identity; its Microsoft connection is still there', fwd.status === 200 && after.user === before.user && after.connections.length === 2);
  env.LEGACY_MS_CONNECT = 'off';
  ok('7 LEGACY_MS_CONNECT=off closes the older apps\' direct Microsoft connect (after every client is updated)', (await post('/api/microsoft/start', L, { return: RET })).status === 409);
  delete env.LEGACY_MS_CONNECT;
}
console.log(`Worker connections security: ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
