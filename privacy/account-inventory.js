/**
 * Daylight account inventory (Phase 0 of the multi-account plan): which accounts have data on this device, and is each
 * one still reachable? Nothing here deletes data by itself — it decides; the app deletes (privacy/data-reset.js).
 *
 *   active       the signed-in Google login, or the Microsoft account it links         → shown
 *   other-login  another Google login on this device, or a Microsoft account it links  → hidden, deletable, kept
 *   orphan       a Microsoft account no login on this device links any more            → hidden immediately,
 *                (replaced, disconnected elsewhere, server session lost)                   30-day retention with warning
 *
 * Retention: warning from day 23; deletion only after the warning was shown, at the later of day 30 or 7 days after
 * the first warning. "Keep" restarts the 30 days. Reconnecting the same account ends the orphan state (all data,
 * corrections, history and checkpoints are kept — nothing is re-keyed).
 * Ledger: localStorage 'daylight-device-accounts' { [accountKey]: { provider, email, owner, firstSeen, lastConnected,
 * orphanedAt, reason, warnedAt, deletedAt } }. A deletedAt is a local tombstone: syncs already in flight for that
 * account discard their results.
 */
(function (root) {
  'use strict';
  const KEY = 'daylight-device-accounts';
  const DAY = 86400000, RETAIN = 30 * DAY, WARN_BEFORE = 7 * DAY, MIN_NOTICE = 7 * DAY;
  const NOT_ACCOUNTS = new Set(['local', 'sample', 'default', '', null, undefined]);
  const providerOf = (key, led) => (led && led.provider) || (String(key).startsWith('ms-') ? 'microsoft' : 'google');

  function createInventory(o) {
    const ls = o.ls || (typeof localStorage !== 'undefined' ? localStorage : null);
    const now = o.now || (() => Date.now());
    const read = () => { try { return JSON.parse(ls.getItem(KEY) || '{}') || {}; } catch { return {}; } };
    const write = (l) => { try { ls.setItem(KEY, JSON.stringify(l)); } catch {} };
    const patch = (key, p) => { if (NOT_ACCOUNTS.has(key)) return; const l = read(); l[key] = Object.assign({ firstSeen: now() }, l[key] || {}, p); write(l); return l[key]; };
    const lsKeys = () => { const out = []; try { for (let i = 0; i < ls.length; i++) out.push(ls.key(i)); } catch {} return out; };
    const readJ = (k, d) => { try { const v = JSON.parse(ls.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };

    /** Microsoft links on this device: owner Google login → linked Microsoft account. */
    function links() {
      const m = {};
      lsKeys().filter((k) => k && k.startsWith('daylight-ms-link:')).forEach((k) => { const v = readJ(k, null); if (v && v.account) m[k.slice('daylight-ms-link:'.length)] = v; });
      return m;
    }

    /** Scan the device. login = the signed-in Google account key (or null). */
    async function scan(login) {
      const items = o.graph ? await o.graph.query({}).catch(() => []) : [];
      const counts = {};
      items.forEach((it) => { const a = it.accountId; if (NOT_ACCOUNTS.has(a)) return; const c = counts[a] || (counts[a] = { items: 0, emails: 0, files: 0, apps: new Set() }); c.items++; if (it.type === 'email') c.emails++; if (it.type === 'file') c.files++; (it.sources || []).forEach((s) => c.apps.add(s.app)); });
      let cacheIds = []; try { cacheIds = o.mailCache && o.mailCache.accountIds ? await o.mailCache.accountIds() : []; } catch {}
      const lk = links(); const linkedBy = {}; Object.entries(lk).forEach(([owner, v]) => { linkedBy[v.account] = { owner, email: v.email, name: v.name }; });
      const names = readJ('daylight-v2-account-names', {});
      const known = [].concat(readJ('daylight-gmail-accounts', []) || [], Object.keys(names || {}));
      const led = read();
      const keys = new Set([...Object.keys(counts), ...cacheIds, ...Object.keys(linkedBy), ...known, ...Object.keys(led)].filter((k) => !NOT_ACCOUNTS.has(k)));
      const out = []; let changed = false;
      keys.forEach((key) => {
        const L = Object.assign({}, led[key] || {});
        const provider = providerOf(key, L) === 'microsoft' || (counts[key] && (counts[key].apps.has('outlook') || counts[key].apps.has('onedrive'))) ? 'microsoft' : 'google';
        const hasData = !!counts[key] || cacheIds.includes(key);
        let status;
        if (provider === 'google') status = key === login ? 'active' : 'other-login';
        else { const by = linkedBy[key]; status = by ? (by.owner === login ? 'active' : 'other-login') : 'orphan'; }
        const email = (linkedBy[key] && linkedBy[key].email) || (provider === 'google' ? names[key] : null) || L.email || '';
        // bookkeeping
        const next = Object.assign({}, L, { provider, email: email || L.email || '' });
        if (linkedBy[key]) next.owner = linkedBy[key].owner;
        if (status === 'active') { next.lastConnected = now(); delete next.orphanedAt; delete next.warnedAt; delete next.reason; delete next.deletedAt; }
        if (status === 'orphan' && hasData && !next.orphanedAt) { next.orphanedAt = now(); next.reason = next.reason || 'no longer linked'; }
        if (status === 'orphan' && !hasData) { delete next.orphanedAt; delete next.warnedAt; } // nothing left to protect
        if (JSON.stringify(next) !== JSON.stringify(L)) { led[key] = Object.assign({ firstSeen: now() }, next); changed = true; }
        if (!hasData && status !== 'active') return; // nothing on the device for it: not listed
        const row = { key, provider, email: next.email || '', owner: next.owner || (provider === 'google' ? key : null), status, items: counts[key] ? counts[key].items : 0, emails: counts[key] ? counts[key].emails : 0, files: counts[key] ? counts[key].files : 0, mailCache: cacheIds.includes(key), reason: next.reason || null, deletedAt: next.deletedAt || null };
        if (status === 'orphan') Object.assign(row, timeline(next));
        out.push(row);
      });
      if (changed) write(led);
      out.sort((a, b) => ({ active: 0, orphan: 1, 'other-login': 2 }[a.status] - { active: 0, orphan: 1, 'other-login': 2 }[b.status]));
      return out;
    }
    /** When to warn and when deletion is allowed (never before a warning has been shown for MIN_NOTICE). */
    function timeline(L) {
      const base = L.orphanedAt || now();
      const due = base + RETAIN, warnFrom = due - WARN_BEFORE;
      const deleteAt = L.warnedAt ? Math.max(due, L.warnedAt + MIN_NOTICE) : null;
      return { orphanedAt: base, warnFrom, warn: now() >= warnFrom, warnedAt: L.warnedAt || null, deleteAt: deleteAt || Math.max(due, now() + MIN_NOTICE), deletable: !!(L.warnedAt && now() >= deleteAt) };
    }
    return {
      scan, links, timeline, read,
      /** A Microsoft account is linked (again): it is active; any orphan state or tombstone for it ends. */
      connected(key, info) { const L = read()[key] || {}; const p = Object.assign({ provider: info.provider || 'microsoft', email: info.email || '', owner: info.owner || null, lastConnected: now() }); const n = patch(key, p); const l = read(); ['orphanedAt', 'warnedAt', 'reason', 'deletedAt'].forEach((f) => delete l[key][f]); write(l); return { wasDeleted: !!L.deletedAt, wasOrphan: !!L.orphanedAt, entry: n }; },
      markOrphan(key, reason, extra) { const L = read()[key] || {}; return patch(key, Object.assign({ orphanedAt: L.orphanedAt || now(), reason }, extra || {})); },
      keep(key) { const l = read(); if (!l[key]) return; l[key].orphanedAt = now(); delete l[key].warnedAt; write(l); },
      markWarned(keys) { const l = read(); let ch = false; (keys || []).forEach((k) => { if (l[k] && l[k].orphanedAt && !l[k].warnedAt) { l[k].warnedAt = now(); ch = true; } }); if (ch) write(l); return ch; },
      markDeleted(key) { const l = read(); l[key] = Object.assign({}, l[key] || {}, { deletedAt: now() }); ['orphanedAt', 'warnedAt'].forEach((f) => delete l[key][f]); write(l); },
      isDeleted(key) { const L = read()[key]; return !!(L && L.deletedAt && !(L.lastConnected > L.deletedAt)); },
      /** Other Microsoft accounts of this login that are orphans now (to offer deleting them after a replace). */
      orphansOf(owner, except) { const l = read(); return Object.entries(l).filter(([k, v]) => k !== except && v.provider === 'microsoft' && v.owner === owner && v.orphanedAt && !v.deletedAt).map(([k, v]) => ({ key: k, email: v.email || '' })); },
      RETAIN, WARN_BEFORE, MIN_NOTICE, KEY
    };
  }
  const api = { createInventory, KEY };
  root.DaylightAccountInventory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
