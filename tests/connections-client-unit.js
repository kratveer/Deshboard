/** connections/connections-client.js (Phase B): mirror bound to the session · tokens bound to connection + account +
 *  generation · fail closed on a token for another account · disconnect / reconnect / tombstone states · per-account
 *  backoff · confirm / start / disconnect calls. Synthetic data, server mocked. Run: node tests/connections-client-unit.js */
'use strict';
const path = require('path');
global.window = globalThis;
const mkLS = () => ({ d: {}, get length() { return Object.keys(this.d).length; }, key(i) { return Object.keys(this.d)[i]; }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); }, removeItem(k) { delete this.d[k]; } });
require(path.resolve(__dirname, '../connections/connections-client.js'));
const CC = globalThis.DaylightConnections;
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 400))); };
let clock = 1_800_000_000_000;
(async () => {
  const srv = { conns: [{ id: 'c1', provider: 'google', accountKey: 'S-A', email: 'a@gmail.com', status: 'active' }, { id: 'c2', provider: 'google', accountKey: 'S-B', email: 'b@gmail.com', status: 'active' }, { id: 'c3', provider: 'microsoft', accountKey: 'ms-1', email: 'm@outlook.com', status: 'active' }], tomb: {}, tokenFor: {}, calls: [] };
  const fetch = async (url, init) => {
    const u = new URL(url); const body = init && init.body ? JSON.parse(init.body) : {}; srv.calls.push(u.pathname + (body.connId ? ':' + body.connId : ''));
    const res = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
    if ((init.headers || {}).Authorization !== 'Bearer SESSION-1') return res(401, { error: 'reauth' });
    if (u.pathname === '/api/connections') return res(200, { user: 'u-1', login: 'c1', caps: { google: 2, microsoft: 2 }, connections: srv.conns, tombstones: srv.tomb });
    if (u.pathname === '/api/connections/token') { const f = srv.tokenFor[body.connId]; if (f) return f(); const c = srv.conns.find((x) => x.id === body.connId); return c ? res(200, { access_token: 'AT-' + c.accountKey + '-' + clock, expires_in: 3600, account: c.accountKey }) : res(404, { error: 'not_connected' }); }
    if (u.pathname === '/api/connections/disconnect') { srv.conns = srv.conns.filter((x) => x.id !== body.connId); return res(200, { ok: true }); }
    if (u.pathname === '/api/connections/confirm') return body.pending === 'P-OK' ? res(200, { ok: true, result: 'added', connection: { id: 'c4', email: 'n@outlook.com' } }) : res(403, { error: 'not_your_connection' });
    if (u.pathname === '/api/connections/start') return srv.conns.filter((x) => x.provider === body.provider).length >= 2 && !body.reconnect ? res(409, { error: 'limit_reached' }) : res(200, { url: 'https://consent.example/' + body.provider });
    return res(404, {});
  };
  const ls = mkLS(); let session = 'SESSION-1';
  const C = CC.createConnections({ ls, fetch, serverUrl: 'https://w.test', session: () => session, sessionTag: () => 'tag:' + session, now: () => clock });
  const m = await C.refresh();
  ok('mirror: list without tokens, login and caps, every account gets a generation', m.connections.length === 3 && m.login === 'c1' && !JSON.stringify(m).includes('AT-') && ['S-A', 'S-B', 'ms-1'].every((k) => C.gen(k)));
  session = 'SESSION-2';
  ok('the mirror belongs to the session that fetched it (another sign-in on this device sees nothing)', C.list().length === 0 && C.mirror() === null);
  session = 'SESSION-1';
  const B = C.byId('c2'), gB = C.gen('S-B');
  const t1 = await C.token(B, gB); const t2 = await C.token(B, gB);
  ok('token: per connection, cached while valid', t1 === t2 && t1.startsWith('AT-S-B') && srv.calls.filter((x) => x === '/api/connections/token:c2').length === 1);
  srv.tokenFor.c3 = () => ({ status: 200, ok: true, json: async () => ({ access_token: 'AT-WRONG', expires_in: 3600, account: 'ms-OTHER' }) });
  let e1 = null; try { await C.token(C.byId('c3'), C.gen('ms-1')); } catch (e) { e1 = e; }
  ok('fail closed: a token that names another account is refused (never used)', e1 && e1.aborted);
  delete srv.tokenFor.c3;
  let e2 = null; try { await C.token(B, 'stale-gen'); } catch (e) { e2 = e; }
  ok('a token is never handed out for an old generation (account changed meanwhile)', e2 && e2.aborted);
  srv.tokenFor.c3 = () => ({ status: 401, ok: false, json: async () => ({ error: 'reconnect_required' }) });
  let e3 = null; const g3 = C.gen('ms-1'); try { await C.token(C.byId('c3'), g3); } catch (e) { e3 = e; }
  ok('revoked consent → reconnect needed: status needs_reconnect, new generation', e3 && e3.reconnect && C.byId('c3').status === 'needs_reconnect' && C.gen('ms-1') !== g3);
  delete srv.tokenFor.c3;
  srv.tokenFor.c2 = () => ({ status: 502, ok: false, json: async () => ({ error: 'google_unavailable' }) });
  let e4 = null; try { await C.token(B, gB, true); } catch (e) { e4 = e; }
  ok('provider down → transient error, connection stays active, same generation', e4 && e4.transient && C.byId('c2').status === 'active' && C.gen('S-B') === gB);
  delete srv.tokenFor.c2;
  // backoff
  C.record('S-B', false, new Error('boom'));
  ok('one failure → backoff 1 minute (only for that account)', !C.due('S-B', 0, true) && C.due('ms-1', 0, true) && C.due('S-B', 0, 'now'));
  clock += 61e3; ok('…after the backoff it is due again', C.due('S-B', 0, true));
  C.record('S-B', false, 'x'); C.record('S-B', false, 'x'); clock += 6 * 60e3;
  ok('repeated failures back off longer (3rd: 15 minutes)', !C.due('S-B', 0, true));
  C.record('S-B', true); ok('a success clears the backoff', C.due('S-B', 0, true) && C.status('S-B').failures === 0);
  // disconnect + refresh bumps generation of the removed account
  const gBefore = C.gen('S-B');
  await C.disconnect('c2');
  ok('disconnect: gone from the mirror, its generation changed (running syncs stop), its token forgotten', !C.byId('c2') && C.gen('S-B') !== gBefore && C.list().length === 2);
  srv.conns.push({ id: 'c9', provider: 'microsoft', accountKey: 'ms-9', email: 'x@outlook.com', status: 'active' });
  const g1 = C.gen('ms-1'); srv.conns = srv.conns.filter((x) => x.id !== 'c3'); await C.refresh();
  ok('refresh: an account removed elsewhere gets a new generation; a new one gets its first', C.gen('ms-1') !== g1 && !!C.gen('ms-9'));
  // start / confirm
  const okUrl = await C.start('microsoft', 'https://app/', null);
  srv.conns.push({ id: 'c8', provider: 'google', accountKey: 'S-C', email: 'c@gmail.com', status: 'active' });
  const capErr = await C.start('google', 'https://app/').then(() => null, (e) => e.code);
  ok('start: consent URL; at the cap the server refuses (limit_reached)', okUrl.startsWith('https://consent.example/microsoft') && capErr === 'limit_reached', { okUrl, capErr });
  const cf = await C.confirm('P-OK').catch((e) => e);
  const bad = await C.confirm('P-BAD').catch((e) => e);
  ok('confirm: ok → refresh; another identity\'s pending → error code', cf.result === 'added' && bad.code === 'not_your_connection');
  C.clear(); ok('clear (sign-out): mirror and tokens gone', C.list().length === 0);
  console.log(`Connections client unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
