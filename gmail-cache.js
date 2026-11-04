// Daylight persistent mail cache (v2) — account-scoped, separate IndexedDB database "daylight-mail".
// It never touches daylight-db (entities, facts, accounts) or the Phase 2 finance ledger.
// Stores message metadata (from / subject / snippet, approved), classification, rule reasons and
// extracted facts. Raw bodies are never stored — only a bodyHash.
(function (root) {
  'use strict';

  const DB_VERSION = 1;
  // keyPath + indexes. All composite keys start with accountId so one account can never read another's rows.
  const SCHEMA = Object.freeze({
    mailIndex: { keyPath: ['accountId', 'messageId'], indexes: { byAccount: 'accountId', byAccountThread: ['accountId', 'threadId'], byAccountStatus: ['accountId', 'status'] } },
    mailFacts: { keyPath: ['accountId', 'messageId'], indexes: { byAccount: 'accountId' } },
    domainCategory: { keyPath: ['accountId', 'domain'], indexes: { byAccount: 'accountId' } },
    aiQueue: { keyPath: ['accountId', 'messageId'], indexes: { byAccount: 'accountId' } },
    attachmentMeta: { keyPath: ['accountId', 'messageId', 'attachmentId'], indexes: { byAccount: 'accountId', byHash: ['accountId', 'sha256'] } },
    threads: { keyPath: ['accountId', 'threadId'], indexes: { byAccount: 'accountId' } },
    syncMetrics: { keyPath: ['accountId', 'day'], indexes: { byAccount: 'accountId' } },
    checkpoint: { keyPath: 'accountId', indexes: {} }
  });
  const STORES = Object.keys(SCHEMA);

  const keyOf = (store, v) => { const kp = SCHEMA[store].keyPath; return Array.isArray(kp) ? kp.map((k) => v[k]) : v[kp]; };
  const kstr = (k) => JSON.stringify(k);

  // ---------- backends ----------
  function memoryBackend() {
    const data = {}; STORES.forEach((s) => { data[s] = new Map(); });
    const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
    return {
      kind: 'memory',
      async get(store, key) { return clone(data[store].get(kstr(key))); },
      async getMany(store, keys) { return keys.map((k) => clone(data[store].get(kstr(k)))); },
      async put(store, value) { data[store].set(kstr(keyOf(store, value)), clone(value)); },
      async putMany(store, values) { values.forEach((v) => data[store].set(kstr(keyOf(store, v)), clone(v))); },
      async del(store, key) { data[store].delete(kstr(key)); },
      async allFor(store, accountId) { const out = []; data[store].forEach((v) => { if (v.accountId === accountId) out.push(clone(v)); }); return out; },
      async clearFor(store, accountId) { [...data[store].entries()].forEach(([k, v]) => { if (v.accountId === accountId) data[store].delete(k); }); },
      _data: data
    };
  }

  function idbBackend(idb, name) {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const req = idb.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // v1: create stores. Future versions add `if (oldVersion < 2) {...}` blocks; nothing is ever dropped.
        STORES.forEach((s) => {
          if (db.objectStoreNames.contains(s)) return;
          const os = db.createObjectStore(s, { keyPath: SCHEMA[s].keyPath });
          Object.entries(SCHEMA[s].indexes).forEach(([n, kp]) => os.createIndex(n, kp, { unique: false }));
        });
      };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { try { db.close(); } catch {} dbp = null; }; res(db); };
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('daylight-mail open blocked'));
    }));
    const p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = async (store, mode) => (await open()).transaction(store, mode);
    const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    return {
      kind: 'indexeddb',
      async get(store, key) { return p((await tx(store, 'readonly')).objectStore(store).get(key)); },
      async getMany(store, keys) { const os = (await tx(store, 'readonly')).objectStore(store); return Promise.all(keys.map((k) => p(os.get(k)))); },
      async put(store, value) { const t = await tx(store, 'readwrite'); t.objectStore(store).put(value); return done(t); },
      async putMany(store, values) { if (!values.length) return; const t = await tx(store, 'readwrite'); const os = t.objectStore(store); values.forEach((v) => os.put(v)); return done(t); },
      async del(store, key) { const t = await tx(store, 'readwrite'); t.objectStore(store).delete(key); return done(t); },
      async allFor(store, accountId) {
        const os = (await tx(store, 'readonly')).objectStore(store);
        if (store === 'checkpoint') { const v = await p(os.get(accountId)); return v ? [v] : []; }
        return p(os.index('byAccount').getAll(accountId));
      },
      async clearFor(store, accountId) {
        const t = await tx(store, 'readwrite'); const os = t.objectStore(store);
        if (store === 'checkpoint') os.delete(accountId);
        else { const keys = await p(os.index('byAccount').getAllKeys(accountId)); keys.forEach((k) => os.delete(k)); }
        return done(t);
      }
    };
  }

  // ---------- cache API ----------
  function createMailCache(o) {
    const opt = o || {};
    const b = opt.backend || (opt.indexedDB ? idbBackend(opt.indexedDB, opt.dbName || 'daylight-mail') : memoryBackend());
    const now = opt.now || (() => Date.now());
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);

    const api = {
      backend: b.kind,
      // checkpoint
      getCheckpoint: (acct) => b.get('checkpoint', acct).then((v) => v || null),
      async setCheckpoint(acct, patch) { const cur = (await b.get('checkpoint', acct)) || { accountId: acct }; const v = Object.assign(cur, patch, { accountId: acct }); await b.put('checkpoint', v); return v; },
      // messages
      async getMany(acct, ids) { const vals = await b.getMany('mailIndex', ids.map((id) => [acct, id])); const m = new Map(); vals.forEach((v) => { if (v) m.set(v.messageId, v); }); return m; },
      putMany: (acct, recs) => b.putMany('mailIndex', recs.map((r) => Object.assign({}, r, { accountId: acct }))),
      all: (acct) => b.allFor('mailIndex', acct),
      async updateLabels(acct, changes) { // changes: [{id, labels}] → no body fetch, no AI
        if (!changes.length) return 0;
        const cur = await api.getMany(acct, changes.map((c) => c.id));
        const out = []; changes.forEach((c) => { const r = cur.get(c.id); if (r && r.status !== 'deleted') { r.labels = c.labels; r.lastProcessedAt = now(); out.push(r); } });
        await b.putMany('mailIndex', out); return out.length;
      },
      async markDeleted(acct, ids) { // tombstone; facts and finance records are kept and only flagged by the app
        if (!ids.length) return [];
        const cur = await api.getMany(acct, ids);
        const out = []; cur.forEach((r) => { if (r.status !== 'deleted') { r.status = 'deleted'; r.deletedAt = now(); out.push(r); } });
        await b.putMany('mailIndex', out); return out.map((r) => r.messageId);
      },
      // facts (separate from metadata; never raw body)
      putFacts: (acct, list) => b.putMany('mailFacts', list.map((f) => Object.assign({}, f, { accountId: acct }))),
      async getFacts(acct, ids) { const vals = await b.getMany('mailFacts', ids.map((id) => [acct, id])); const m = new Map(); vals.forEach((v) => { if (v) m.set(v.messageId, v); }); return m; },
      allFacts: (acct) => b.allFor('mailFacts', acct),
      // sender-domain cache — only domain → category (no content). Interface kept small so it can move server-side.
      async getDomainCategory(acct, domain) {
        if (!domain) return null;
        const v = await b.get('domainCategory', [acct, domain]);
        if (!v) return null;
        if (v.userCategory) return { category: v.userCategory, confidence: 0.95, source: 'user' };
        if (v.active) return { category: v.category, confidence: 0.88, source: v.source, hits: v.hits };
        return null;
      },
      async recordDomainCategory(acct, domain, category, source, opts2) {
        if (!domain || !category) return null;
        const threshold = opts2?.threshold ?? 3;
        const v = (await b.get('domainCategory', [acct, domain])) || { accountId: acct, domain, votes: {}, hits: 0 };
        if (source === 'user') { v.userCategory = category; v.active = true; v.category = category; v.source = 'user'; }
        else {
          v.votes[category] = (v.votes[category] || 0) + 1;
          v.hits = (v.hits || 0) + 1;
          const [top, n] = Object.entries(v.votes).sort((a, c) => c[1] - a[1])[0];
          const others = v.hits - n;
          // learn only on a clear, repeated majority; a conflicting vote stops the rule until it is clear again
          v.category = top; v.source = v.userCategory ? 'user' : source; v.active = !!v.userCategory || (n >= threshold && others === 0);
        }
        v.at = now();
        await b.put('domainCategory', v);
        return v;
      },
      allDomains: (acct) => b.allFor('domainCategory', acct),
      // AI queue (deferred work survives reloads; never dropped)
      enqueueAi: (acct, items) => b.putMany('aiQueue', items.map((i) => Object.assign({ state: 'queued', attempts: 0, at: now() }, i, { accountId: acct }))),
      aiQueue: (acct) => b.allFor('aiQueue', acct),
      dequeueAi: (acct, id) => b.del('aiQueue', [acct, id]),
      // attachments (metadata only unless auto-download is on)
      putAttachments: (acct, list) => b.putMany('attachmentMeta', list.map((a) => Object.assign({}, a, { accountId: acct }))),
      allAttachments: (acct) => b.allFor('attachmentMeta', acct),
      // sent threads (summaries only: headers of the thread messages)
      async getThreads(acct, ids) { const vals = await b.getMany('threads', ids.map((id) => [acct, id])); const m = new Map(); vals.forEach((v) => { if (v) m.set(v.threadId, v); }); return m; },
      putThreads: (acct, list) => b.putMany('threads', list.map((t) => Object.assign({}, t, { accountId: acct }))),
      allThreads: (acct) => b.allFor('threads', acct),
      // metrics
      async addMetrics(acct, deltas, at) {
        const d = day(at || now());
        const v = (await b.get('syncMetrics', [acct, d])) || { accountId: acct, day: d, counters: {}, runs: [] };
        Object.entries(deltas.counters || {}).forEach(([k, n]) => { v.counters[k] = (v.counters[k] || 0) + (Number(n) || 0); });
        if (deltas.run) { v.runs.push(deltas.run); if (v.runs.length > 40) v.runs.shift(); }
        await b.put('syncMetrics', v); return v;
      },
      metrics: (acct) => b.allFor('syncMetrics', acct),
      // user-initiated reset of this cache only (finance ledger, tasks and daylight-db are untouched)
      async clearAccount(acct) { for (const s of STORES) await b.clearFor(s, acct); }
    };
    return api;
  }

  const api = { createMailCache, memoryBackend, idbBackend, SCHEMA, DB_VERSION };
  root.DaylightMailCache = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
