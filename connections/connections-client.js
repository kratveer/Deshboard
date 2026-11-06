/**
 * Daylight connections client (Phase B of the multi-account plan; server: connections_v1).
 * One Daylight identity holds up to 2 Google + 2 Microsoft connections. This module keeps, on this device:
 *  - a mirror of the identity's connection list (no tokens): localStorage 'daylight-connections', bound to the session
 *    that fetched it (another sign-in on this device never sees it)
 *  - short-lived access tokens per connection, in memory only, bound to { connId, accountKey, generation }: a token is
 *    never returned for another account, and a disconnected / replaced / tombstoned account's in-flight work stops
 *  - per-account sync status with backoff ('daylight-conn-status:<accountKey>'): one account failing never blocks others
 * Nothing here deletes data; the app does (privacy/data-reset.js) for tombstoned or disconnected accounts.
 */
(function (root) {
  'use strict';
  const MIRROR = 'daylight-connections';
  const GEN = (k) => 'daylight-conn-gen:' + k;
  const STATUS = (k) => 'daylight-conn-status:' + k;
  const BACKOFF = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3]; // after 1, 2, 3, 4+ consecutive failures

  function createConnections(o) {
    const ls = o.ls || root.localStorage;
    const now = o.now || (() => Date.now());
    const fetchFn = o.fetch || ((u, i) => root.fetch(u, i));
    const server = () => (typeof o.serverUrl === 'function' ? o.serverUrl() : o.serverUrl) || '';
    const session = () => (typeof o.session === 'function' ? o.session() : o.session) || '';
    const tag = () => (o.sessionTag ? o.sessionTag() : session().slice(-12));
    const getJ = (k, d) => { try { const v = JSON.parse(ls.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
    const setJ = (k, v) => { try { if (v == null) ls.removeItem(k); else ls.setItem(k, JSON.stringify(v)); } catch {} };
    const tokens = new Map(); // connId → { token, exp, account, gen }
    try { root.addEventListener && root.addEventListener('storage', (e) => { if (!e.key || e.key === MIRROR || e.key.startsWith('daylight-conn-gen:')) tokens.clear(); }); } catch {}

    /** The mirror, only if it was fetched with this session. */
    function mirror() { const m = getJ(MIRROR, null); return m && m.tag === tag() ? m : null; }
    const list = () => ((mirror() || {}).connections || []);
    const active = () => list().filter((c) => c.status === 'active');
    const byId = (id) => list().find((c) => c.id === id) || null;
    const gen = (acct) => { try { return ls.getItem(GEN(acct)) || ''; } catch { return ''; } };
    function bumpGen(acct) { const g = now().toString(36) + Math.random().toString(36).slice(2, 8); try { ls.setItem(GEN(acct), g); } catch {} for (const [id, t] of tokens) if (t.account === acct) tokens.delete(id); return g; }
    const ensureGen = (acct) => gen(acct) || bumpGen(acct);
    async function call(path, init) {
      if (!server() || !session()) { const e = new Error('not signed in'); e.status = 401; throw e; }
      const r = await fetchFn(server() + path, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + session() }, (init && init.body) ? { 'Content-Type': 'application/json' } : {}) }));
      const d = await r.json().catch(() => ({}));
      return { status: r.status, ok: r.ok, data: d };
    }
    /** Fetch the connection list. Accounts that disappeared, or whose status changed, get a new generation (their
     *  cached tokens and in-flight syncs stop). Returns the mirror. */
    async function refresh() {
      const r = await call('/api/connections', { method: 'GET' });
      if (!r.ok) { const e = new Error(r.data.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
      const prev = mirror();
      const next = { tag: tag(), user: r.data.user, login: r.data.login, caps: r.data.caps || {}, connections: r.data.connections || [], tombstones: r.data.tombstones || {}, at: now() };
      const sig = (c) => c.id + '|' + c.accountKey + '|' + c.status;
      const nowSig = new Set(next.connections.map(sig));
      ((prev && prev.connections) || []).forEach((c) => { if (!nowSig.has(sig(c))) bumpGen(c.accountKey); });
      next.connections.forEach((c) => ensureGen(c.accountKey));
      setJ(MIRROR, next);
      return next;
    }
    function clear() { setJ(MIRROR, null); tokens.clear(); }
    /** True while this connection is still the same active account at the same generation (used before every write). */
    function stillMine(connId, acct, g) { const c = byId(connId); return !!(c && c.accountKey === acct && c.status === 'active' && gen(acct) === g); }
    /** An access token for exactly this connection, account and generation — or an error (never another account's). */
    async function token(conn, g, force) {
      const changed = () => !stillMine(conn.id, conn.accountKey, g);
      if (changed()) throw stop('account changed · sync stopped');
      const t = tokens.get(conn.id);
      if (!force && t && t.account === conn.accountKey && t.gen === g && now() < t.exp - 60000) return t.token;
      const r = await call('/api/connections/token', { method: 'POST', body: JSON.stringify({ connId: conn.id }) });
      if (r.status === 404) { markGone(conn); throw stop('account disconnected'); }
      if (r.status === 401 && r.data.error === 'reconnect_required') { markReconnect(conn); const e = new Error('reconnect needed'); e.reconnect = true; throw e; }
      if (!r.ok) { const e = new Error(r.data.error || ('HTTP ' + r.status)); e.status = r.status; e.transient = r.status >= 500 || r.status === 429; throw e; }
      if (!r.data.access_token || r.data.account !== conn.accountKey) throw stop('the token is for another account'); // fail closed
      if (changed()) throw stop('account changed · sync stopped');
      tokens.set(conn.id, { token: r.data.access_token, exp: now() + (Number(r.data.expires_in) || 3600) * 1000, account: conn.accountKey, gen: g, scopes: r.data.scope || '' });
      return r.data.access_token;
    }
    function stop(msg) { const e = new Error(msg); e.aborted = true; return e; }
    function patchConn(id, p) { const m = mirror(); if (!m) return; const c = m.connections.find((x) => x.id === id); if (!c) return; Object.assign(c, p); setJ(MIRROR, m); }
    function markReconnect(conn) { tokens.delete(conn.id); patchConn(conn.id, { status: 'needs_reconnect' }); bumpGen(conn.accountKey); }
    function markGone(conn) { tokens.delete(conn.id); const m = mirror(); if (m) { m.connections = m.connections.filter((x) => x.id !== conn.id); setJ(MIRROR, m); } bumpGen(conn.accountKey); }

    // ---- per-account status + backoff ----
    const status = (acct) => getJ(STATUS(acct), {}) || {};
    function setStatus(acct, p) { const s = Object.assign({}, status(acct), p); setJ(STATUS(acct), s); return s; }
    function record(acct, ok, err) {
      if (ok) return setStatus(acct, { lastOk: now(), lastError: '', failures: 0, nextTryAt: 0, running: false });
      const f = (status(acct).failures || 0) + 1;
      return setStatus(acct, { lastError: String(err && err.message || err || 'error').slice(0, 200), errorAt: now(), failures: f, nextTryAt: now() + BACKOFF[Math.min(f, BACKOFF.length) - 1], running: false });
    }
    /** Is this account due (min interval since its last success, and not in backoff)? force skips the interval, not the backoff
     *  unless force === 'now' (the user asked). */
    function due(acct, minMs, force) { const s = status(acct); if (force !== 'now' && s.nextTryAt && now() < s.nextTryAt) return false; if (force) return true; return !s.lastOk || now() - s.lastOk >= minMs; }

    // ---- add / reconnect / disconnect ----
    async function start(provider, ret, reconnect) {
      const r = await call('/api/connections/start', { method: 'POST', body: JSON.stringify({ provider, return: ret, reconnect: reconnect || undefined }) });
      if (!r.ok) { const e = new Error(r.data.error || ('HTTP ' + r.status)); e.code = r.data.error; e.status = r.status; throw e; }
      return r.data.url;
    }
    async function confirm(pending) {
      const r = await call('/api/connections/confirm', { method: 'POST', body: JSON.stringify({ pending }) });
      if (!r.ok) { const e = new Error(r.data.error || ('HTTP ' + r.status)); e.code = r.data.error; e.status = r.status; throw e; }
      await refresh();
      return r.data; // { result, connection }
    }
    async function disconnect(connId) {
      const c = byId(connId);
      const r = await call('/api/connections/disconnect', { method: 'POST', body: JSON.stringify({ connId }) });
      if (!r.ok && r.status !== 404) { const e = new Error(r.data.error || ('HTTP ' + r.status)); e.code = r.data.error; e.status = r.status; throw e; }
      if (c) markGone(c);
      try { await refresh(); } catch {}
      return { ok: true, accountKey: c && c.accountKey, provider: c && c.provider };
    }
    return { refresh, clear, mirror, list, active, byId, gen, bumpGen, ensureGen, stillMine, token, status, setStatus, record, due, start, confirm, disconnect, MIRROR };
  }
  const api = { createConnections };
  root.DaylightConnections = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
