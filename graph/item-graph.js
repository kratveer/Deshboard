/**
 * Daylight Item Graph (V2) — one shared model every screen reads.
 *
 * Item = one logical thing (an email, a bill, a booking, a deadline, a person…) that may have SEVERAL sources.
 * Links connect Items (email → bill, bill → merchant, booking → trip, email → person …).
 * Sync never overwrites what the user did: status, snooze, corrections and action history survive re-ingestion.
 *
 * Storage: IndexedDB "daylight-graph" (separate from daylight-db / daylight-mail so an upgrade cannot damage them),
 * or an in-memory backend for Node tests. Stores: items, links, rules, actions, log. Every row carries accountId.
 * No network, no DOM.
 */
(function (root) {
  'use strict';
  const DB_NAME = 'daylight-graph';
  const DB_VERSION = 1;
  const STORES = { items: 'id', links: 'id', rules: 'id', actions: 'id', log: 'id' };
  const IDX = { items: { byAccount: 'accountId', byType: 'type', bySourceApp: 'sourceApp' }, links: { byAccount: 'accountId' }, rules: { byAccount: 'accountId' }, actions: { byAccount: 'accountId' }, log: { byAccount: 'accountId' } };
  const TYPES = Object.freeze(['email', 'person', 'organisation', 'bill', 'transaction', 'subscription', 'booking', 'trip', 'ticket',
    'delivery', 'deadline', 'appointment', 'task', 'event', 'project', 'document', 'warranty']);
  const USER_OWNED = ['status', 'snoozedUntil', 'pinned', 'userCorrections', 'actionHistory', 'userPriority', 'notes', 'plannedAt', 'plannedMinutes'];

  /** Small stable hash for ids (FNV-1a, base36). */
  function hash(s) { let h = 2166136261; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); }
  const itemId = (naturalKey) => 'it_' + hash(naturalKey) + '_' + String(naturalKey).replace(/[^a-z0-9]+/gi, '').slice(-10).toLowerCase();
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

  function normalizeItem(p, now) {
    const t = now();
    const src = p.sources && p.sources.length ? p.sources : (p.sourceApp ? [{ app: p.sourceApp, accountId: p.sourceAccountId || null, itemId: p.sourceItemId || null, url: p.sourceUrl || null, role: 'primary' }] : []);
    const first = src[0] || {};
    return {
      id: p.id || itemId(p.key || `${p.type}:${first.app}:${first.itemId}`),
      key: p.key || null,
      accountId: p.accountId || first.accountId || 'local',
      type: TYPES.includes(p.type) ? p.type : 'email',
      title: p.title || '', description: p.description || '',
      status: p.status || 'open', priority: Number.isFinite(p.priority) ? p.priority : 0,
      createdAt: p.createdAt || t, updatedAt: t, dueAt: p.dueAt || null,
      sourceApp: first.app || null, sourceAccountId: first.accountId || null, sourceItemId: first.itemId || null, sourceUrl: first.url || null,
      sources: src.map((s) => ({ app: s.app, accountId: s.accountId || null, itemId: s.itemId || null, url: s.url || null, role: s.role || 'primary' })),
      relatedItemIds: [...new Set(p.relatedItemIds || [])],
      extractedEntities: p.extractedEntities || {},
      extractedFacts: (p.extractedFacts || []).filter((f) => f && f.key != null),
      confidence: p.confidence ?? null,
      classification: p.classification || null,
      privacyClass: p.privacyClass || 'normal', aiExclude: !!p.aiExclude,
      userCorrections: p.userCorrections || [], actionHistory: p.actionHistory || [],
      meta: p.datedBySource ? Object.assign({}, p.meta || {}, { datedBySource: true }) : (p.meta || {})
    };
  }

  /** Merge a freshly normalised item into the stored one. User-owned fields always survive. */
  function mergeItem(prev, next) {
    if (!prev) return next;
    const out = Object.assign({}, prev, next);
    USER_OWNED.forEach((k) => { if (prev[k] !== undefined) out[k] = prev[k]; });
    // an Item derived from emails is dated by its earliest email (v107: older Items were dated by the first ingest)
    out.createdAt = next.meta && next.meta.datedBySource && next.createdAt ? Math.min(prev.createdAt || next.createdAt, next.createdAt) : prev.createdAt;
    const sk = (s) => `${s.app}|${s.accountId}|${s.itemId}`;
    const srcs = new Map(); [...(prev.sources || []), ...(next.sources || [])].forEach((s) => srcs.set(sk(s), Object.assign({}, srcs.get(sk(s)) || {}, s)));
    out.sources = [...srcs.values()];
    const p0 = out.sources.find((s) => s.role === 'primary') || out.sources[0] || {};
    out.sourceApp = p0.app || null; out.sourceAccountId = p0.accountId || null; out.sourceItemId = p0.itemId || null; out.sourceUrl = p0.url || null;
    out.relatedItemIds = [...new Set([...(prev.relatedItemIds || []), ...(next.relatedItemIds || [])])];
    const fk = (f) => `${f.key}|${f.sourceItemId || ''}`;
    const facts = new Map(); [...(prev.extractedFacts || []), ...(next.extractedFacts || [])].forEach((f) => facts.set(fk(f), f));
    out.extractedFacts = [...facts.values()];
    const ents = Object.assign({}, prev.extractedEntities || {});
    Object.entries(next.extractedEntities || {}).forEach(([k, v]) => { ents[k] = Array.isArray(v) ? [...new Set([...(Array.isArray(ents[k]) ? ents[k] : []), ...v])] : (v ?? ents[k]); });
    out.extractedEntities = ents;
    // a user correction pins the type; sync cannot change it back
    if (prev.classification?.userSet) out.classification = prev.classification;
    if (prev.classification?.userSet) out.type = prev.type;
    out.meta = Object.assign({}, prev.meta || {}, next.meta || {});
    return out;
  }

  // ---------- backends ----------
  function memoryBackend() {
    const data = {}; Object.keys(STORES).forEach((s) => { data[s] = new Map(); });
    return {
      kind: 'memory',
      async get(s, k) { return clone(data[s].get(k)); },
      async getMany(s, ks) { return ks.map((k) => clone(data[s].get(k))); },
      async put(s, v) { data[s].set(v[STORES[s]], clone(v)); },
      async putMany(s, vs) { vs.forEach((v) => data[s].set(v[STORES[s]], clone(v))); },
      async del(s, k) { data[s].delete(k); },
      async delMany(s, ks) { ks.forEach((k) => data[s].delete(k)); },
      async all(s) { return [...data[s].values()].map(clone); },
      async clear() { Object.values(data).forEach((m) => m.clear()); }
    };
  }
  function idbBackend(idb, name) {
    let dbp = null;
    // Self-healing open (same as the mail cache): missing stores in an existing database are created in a version bump.
    const openAt = (version) => new Promise((res, rej) => {
      const req = version ? idb.open(name, version) : idb.open(name);
      req.onupgradeneeded = () => {
        const db = req.result;
        Object.entries(STORES).forEach(([s, kp]) => {
          // create what is missing — stores and indexes — and never delete or rewrite anything that exists
          const os = db.objectStoreNames.contains(s) ? req.transaction.objectStore(s) : db.createObjectStore(s, { keyPath: kp });
          Object.entries(IDX[s]).forEach(([n, f]) => { if (!os.indexNames.contains(n)) os.createIndex(n, f); });
        });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('daylight-graph open blocked'));
    });
    const open = () => dbp || (dbp = (async () => {
      let db = await openAt(null);
      const names = Object.keys(STORES);
      const incomplete = () => { if (names.some((s) => !db.objectStoreNames.contains(s))) return true; try { const t = db.transaction(names, 'readonly'); return names.some((s) => Object.keys(IDX[s]).some((n) => !t.objectStore(s).indexNames.contains(n))); } catch { return true; } };
      if (incomplete()) { const v = db.version + 1; db.close(); db = await openAt(Math.max(v, DB_VERSION)); }
      db.onversionchange = () => { try { db.close(); } catch {} dbp = null; };
      return db;
    })().catch((e) => { dbp = null; throw e; }));
    const p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    const tx = async (s, mode) => (await open()).transaction(s, mode);
    return {
      kind: 'indexeddb',
      async get(s, k) { return p((await tx(s, 'readonly')).objectStore(s).get(k)); },
      async getMany(s, ks) { const os = (await tx(s, 'readonly')).objectStore(s); return Promise.all(ks.map((k) => p(os.get(k)))); },
      async put(s, v) { const t = await tx(s, 'readwrite'); t.objectStore(s).put(v); return done(t); },
      async putMany(s, vs) { if (!vs.length) return; const t = await tx(s, 'readwrite'); const os = t.objectStore(s); vs.forEach((v) => os.put(v)); return done(t); },
      async del(s, k) { const t = await tx(s, 'readwrite'); t.objectStore(s).delete(k); return done(t); },
      async delMany(s, ks) { if (!ks.length) return; const t = await tx(s, 'readwrite'); const os = t.objectStore(s); ks.forEach((k) => os.delete(k)); return done(t); },
      async all(s) { return p((await tx(s, 'readonly')).objectStore(s).getAll()); },
      async clear() { const db = await open(); const t = db.transaction(Object.keys(STORES), 'readwrite'); Object.keys(STORES).forEach((s) => t.objectStore(s).clear()); return done(t); }
    };
  }

  function createGraph(opts) {
    const o = opts || {};
    const now = o.now || (() => Date.now());
    const idb = o.indexedDB || (o.backend !== 'memory' && root.indexedDB) || null;
    const b = idb ? idbBackend(idb, o.dbName || DB_NAME) : memoryBackend();
    const listeners = new Set();
    const emit = (ev) => listeners.forEach((fn) => { try { fn(ev); } catch {} });

    const g = {
      backend: b.kind, TYPES, itemId, hash,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async getItem(id) { return b.get('items', id); },
      async getMany(ids) { return (await b.getMany('items', ids)).filter(Boolean); },
      /** Insert or merge items; returns the stored items. Same id twice → one item with both sources. */
      async upsertMany(parts) {
        if (!parts.length) return [];
        const norm = parts.map((x) => normalizeItem(x, now));
        const byId = new Map(); norm.forEach((n) => byId.set(n.id, mergeItem(byId.get(n.id), n)));
        const prevs = await b.getMany('items', [...byId.keys()]);
        const out = [...byId.values()].map((n, i) => mergeItem(prevs[i], n));
        await b.putMany('items', out);
        emit({ kind: 'items', count: out.length });
        return out;
      },
      async upsertItem(p) { return (await g.upsertMany([p]))[0]; },
      /** Replace an item exactly (used by actions and corrections; caller passes a full item). */
      async putItem(it) { it.updatedAt = now(); await b.put('items', it); emit({ kind: 'item', id: it.id }); return it; },
      async query(q) {
        const f = q || {};
        let all = await b.all('items');
        if (f.accountId) all = all.filter((x) => x.accountId === f.accountId);
        if (f.type) { const ts = [].concat(f.type); all = all.filter((x) => ts.includes(x.type)); }
        if (f.status) { const ss = [].concat(f.status); all = all.filter((x) => ss.includes(x.status)); }
        if (f.sourceApp) all = all.filter((x) => (x.sources || []).some((s) => s.app === f.sourceApp));
        if (f.dueBefore) all = all.filter((x) => x.dueAt && x.dueAt < f.dueBefore);
        if (f.dueAfter) all = all.filter((x) => x.dueAt && x.dueAt >= f.dueAfter);
        if (f.text) { const t = String(f.text).toLowerCase(); all = all.filter((x) => `${x.title} ${x.description}`.toLowerCase().includes(t)); }
        return all;
      },
      /** Link two items (idempotent). Both items list each other in relatedItemIds. */
      async link(from, to, kind, accountId) {
        if (!from || !to || from === to) return null;
        const id = `${from}|${kind}|${to}`;
        await b.put('links', { id, from, to, kind, accountId: accountId || null, at: now() });
        const [a, c] = await b.getMany('items', [from, to]);
        const upd = [];
        if (a && !(a.relatedItemIds || []).includes(to)) { a.relatedItemIds = [...(a.relatedItemIds || []), to]; upd.push(a); }
        if (c && !(c.relatedItemIds || []).includes(from)) { c.relatedItemIds = [...(c.relatedItemIds || []), from]; upd.push(c); }
        if (upd.length) await b.putMany('items', upd);
        return id;
      },
      /** Many links in two transactions (ingest path). pairs: [[from, to, kind], …] */
      async linkMany(pairs, accountId) {
        const ok2 = pairs.filter(([f, t]) => f && t && f !== t);
        if (!ok2.length) return 0;
        const ls = new Map(); ok2.forEach(([f, t, k]) => ls.set(`${f}|${k}|${t}`, { id: `${f}|${k}|${t}`, from: f, to: t, kind: k, accountId: accountId || null, at: now() }));
        await b.putMany('links', [...ls.values()]);
        const ids = [...new Set(ok2.flatMap(([f, t]) => [f, t]))];
        const its = await b.getMany('items', ids); const byId = new Map(); its.forEach((x) => { if (x) byId.set(x.id, x); });
        const changed = new Set();
        ok2.forEach(([f, t]) => { const a = byId.get(f), c = byId.get(t); if (a && !(a.relatedItemIds || []).includes(t)) { a.relatedItemIds = [...(a.relatedItemIds || []), t]; changed.add(f); } if (c && !(c.relatedItemIds || []).includes(f)) { c.relatedItemIds = [...(c.relatedItemIds || []), f]; changed.add(t); } });
        if (changed.size) await b.putMany('items', [...changed].map((id) => byId.get(id)));
        return ls.size;
      },
      async links(itemId2) { return (await b.all('links')).filter((l) => !itemId2 || l.from === itemId2 || l.to === itemId2); },
      async related(id) { const it = await b.get('items', id); return it ? g.getMany(it.relatedItemIds || []) : []; },
      /**
       * Remove one provider's data. Items whose only source is that provider are deleted (with their links);
       * items that also have other sources keep those and drop this one. Rules created from that provider go too.
       */
      async deleteBySource(app, accountId) {
        const all = await b.all('items');
        const del = [], keep = [];
        const hit = (s) => s.app === app && (!accountId || s.accountId === accountId);
        all.forEach((it) => {
          const srcs = it.sources || [];
          if (!srcs.some(hit)) return;
          const rest = srcs.filter((s) => !hit(s));
          if (!rest.length) del.push(it.id);
          else { const p0 = rest.find((s) => s.role === 'primary') || rest[0]; keep.push(Object.assign({}, it, { sources: rest, sourceApp: p0.app, sourceAccountId: p0.accountId, sourceItemId: p0.itemId, sourceUrl: p0.url })); }
        });
        const delSet = new Set(del);
        keep.forEach((it) => { it.relatedItemIds = (it.relatedItemIds || []).filter((x) => !delSet.has(x)); it.extractedFacts = (it.extractedFacts || []).filter((f) => !delSet.has(f.sourceItemId)); });
        await b.delMany('items', del);
        if (keep.length) await b.putMany('items', keep);
        const links = await b.all('links');
        await b.delMany('links', links.filter((l) => delSet.has(l.from) || delSet.has(l.to)).map((l) => l.id));
        const rules = await b.all('rules');
        await b.delMany('rules', rules.filter((r) => r.sourceApp === app && (!accountId || r.accountId === accountId)).map((r) => r.id));
        const acts = await b.all('actions');
        await b.delMany('actions', acts.filter((a) => delSet.has(a.itemId)).map((a) => a.id));
        emit({ kind: 'delete', app, count: del.length });
        return del.length;
      },
      /** One source record disappeared (e.g. Gmail deleted a message): drop that reference everywhere; items left with no source go. */
      async removeSourceItem(app, accountId, sourceItemId) {
        const all = await b.all('items');
        const hit = (x) => x.app === app && x.itemId === sourceItemId && (!accountId || x.accountId === accountId);
        const del = [], keep = [];
        all.forEach((it) => { if (!(it.sources || []).some(hit)) return; const rest = it.sources.filter((x) => !hit(x)); if (!rest.length) del.push(it.id); else { const p0 = rest.find((x) => x.role === 'primary') || rest[0]; keep.push(Object.assign({}, it, { sources: rest, sourceApp: p0.app, sourceAccountId: p0.accountId, sourceItemId: p0.itemId, sourceUrl: p0.url })); } });
        const delSet = new Set(del);
        keep.forEach((it) => { it.relatedItemIds = (it.relatedItemIds || []).filter((x) => !delSet.has(x)); it.extractedFacts = (it.extractedFacts || []).filter((f) => !delSet.has(f.sourceItemId)); });
        await b.delMany('items', del); if (keep.length) await b.putMany('items', keep);
        const links = await b.all('links'); await b.delMany('links', links.filter((l) => delSet.has(l.from) || delSet.has(l.to)).map((l) => l.id));
        if (del.length || keep.length) emit({ kind: 'delete', app, count: del.length });
        return del.length;
      },
      /** Drop specific source references from specific Items (an email no longer supports a derived Item). Items left with no source are deleted. */
      async detachSources(list) {
        if (!list.length) return 0;
        const ids = [...new Set(list.map((x) => x.itemId))];
        const its = (await b.getMany('items', ids)).filter(Boolean);
        const del = [], keep = [];
        its.forEach((it) => {
          const drop = list.filter((x) => x.itemId === it.id);
          const rest = (it.sources || []).filter((s) => !drop.some((d) => d.app === s.app && String(d.sourceItemId) === String(s.itemId) && (!d.accountId || d.accountId === s.accountId)));
          if (rest.length === (it.sources || []).length) return;
          if (!rest.length) { del.push(it.id); return; }
          const p0 = rest.find((x) => x.role === 'primary') || rest[0];
          const dropIds = new Set(drop.map((d) => d.emailItemId).filter(Boolean));
          keep.push(Object.assign({}, it, { sources: rest, sourceApp: p0.app, sourceAccountId: p0.accountId, sourceItemId: p0.itemId, sourceUrl: p0.url, extractedFacts: (it.extractedFacts || []).filter((f) => !dropIds.has(f.sourceItemId)), relatedItemIds: (it.relatedItemIds || []).filter((x) => !dropIds.has(x)) }));
        });
        const delSet = new Set(del);
        await b.delMany('items', del); if (keep.length) await b.putMany('items', keep);
        const links = await b.all('links');
        const dropLinks = links.filter((l) => delSet.has(l.from) || delSet.has(l.to) || list.some((x) => x.emailItemId && ((l.from === x.emailItemId && l.to === x.itemId) || (l.to === x.emailItemId && l.from === x.itemId))));
        await b.delMany('links', dropLinks.map((l) => l.id));
        if (del.length) { const all = await b.all('items'); const fix = all.filter((x) => (x.relatedItemIds || []).some((r) => delSet.has(r))).map((x) => Object.assign(x, { relatedItemIds: x.relatedItemIds.filter((r) => !delSet.has(r)) })); if (fix.length) await b.putMany('items', fix); }
        if (del.length || keep.length) emit({ kind: 'detach', count: del.length + keep.length });
        return del.length;
      },
      // ---- rules, actions, log (used by user-rules, apply-action, processing-log) ----
      rules: { all: () => b.all('rules'), put: (r) => b.put('rules', r), del: (id) => b.del('rules', id), get: (id) => b.get('rules', id) },
      actions: { all: () => b.all('actions'), put: (a) => b.put('actions', a), get: (id) => b.get('actions', id) },
      log: { all: () => b.all('log'), put: (e) => b.put('log', e), delMany: (ids) => b.delMany('log', ids) },
      async counts() { const all = await b.all('items'); const c = {}; all.forEach((x) => { c[x.type] = (c[x.type] || 0) + 1; }); return { total: all.length, byType: c, links: (await b.all('links')).length, rules: (await b.all('rules')).length }; },
      async clear() { await b.clear(); emit({ kind: 'clear' }); }
    };
    return g;
  }

  const api = { createGraph, normalizeItem, mergeItem, itemId, hash, TYPES, DB_NAME };
  root.DaylightItemGraph = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
