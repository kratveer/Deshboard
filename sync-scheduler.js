// Daylight sync scheduler (v2).
// Pure slot logic (no DOM) + a cross-tab lock + a thin browser adapter.
// The pure part (decide / missedSlots / nextSlot) can run unchanged in a Cloudflare Workers cron later:
// the cron would call the same runSync() with trigger 'slot'.
(function (root) {
  'use strict';
  const MIN = 60000, DAY = 86400000;

  function parseSlot(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); if (!m) return null; const h = +m[1], mi = +m[2]; return h < 24 && mi < 60 ? h * 60 + mi : null; }

  /** Offset (ms) of a time zone at instant `ms`; undefined tz = the device's local zone. */
  function zoneOffsetMs(ms, tz) {
    if (!tz) return -new Date(ms).getTimezoneOffset() * MIN;
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {}; f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }
  /** Instant of local wall-clock minute `mins` on the local day containing `ms` shifted by `dayShift`. */
  function localSlotMs(ms, mins, dayShift, tz) {
    const off = zoneOffsetMs(ms, tz);
    const localMidnight = Math.floor((ms + off) / DAY) * DAY + (dayShift || 0) * DAY;
    let t = localMidnight + mins * MIN - off;
    const off2 = zoneOffsetMs(t, tz); // DST: correct with the offset valid at the slot itself
    if (off2 !== off) t = localMidnight + mins * MIN - off2;
    return t;
  }
  function slotInstants(fromMs, toMs, slots, tz) {
    const mins = (slots || []).map(parseSlot).filter((x) => x != null).sort((a, b) => a - b);
    const out = [];
    if (!mins.length || toMs < fromMs) return out;
    const days = Math.min(8, Math.ceil((toMs - fromMs) / DAY) + 1);
    for (let d = -1; d <= days; d++) mins.forEach((m) => { const t = localSlotMs(fromMs, m, d, tz); if (t > fromMs && t <= toMs) out.push(t); });
    return [...new Set(out)].sort((a, b) => a - b);
  }
  /** Slots strictly after lastSyncAt and at or before now (capped scan of 8 days). */
  function missedSlots(lastSyncAt, nowMs, slots, tz) {
    const from = Math.max(lastSyncAt || 0, nowMs - 7 * DAY);
    return slotInstants(from, nowMs, slots, tz);
  }
  function nextSlot(nowMs, slots, tz) { return slotInstants(nowMs, nowMs + 2 * DAY, slots, tz)[0] || null; }
  function lastSlot(nowMs, slots, tz) { const s = slotInstants(nowMs - 2 * DAY, nowMs, slots, tz); return s[s.length - 1] || null; }

  /**
   * Decide whether a trigger should run a Gmail sync.
   * trigger: 'manual' | 'open' | 'visible' | 'slot' | 'connect'
   * Returns { run, label, reason, missed }. 'open'/'visible' with missed slots → ONE catch-up sync.
   */
  function decide(o) {
    const sc = o.schedule || {};
    const now = o.now, last = o.lastSyncAt || 0;
    const missed = missedSlots(last, now, sc.slots, o.tz);
    const sinceMin = last ? (now - last) / MIN : Infinity;
    if (o.trigger === 'manual' || o.trigger === 'connect') return { run: true, label: o.trigger, reason: o.trigger === 'manual' ? 'you asked' : 'account connected', missed: missed.length };
    if (o.trigger === 'slot') {
      const slot = o.slotAt || lastSlot(now, sc.slots, o.tz);
      if (last && slot && last >= slot) return { run: false, label: 'slot', reason: 'already synced since this slot', missed: 0 };
      return { run: true, label: 'scheduled', reason: 'scheduled slot', missed: missed.length };
    }
    // open / visible
    if (sinceMin < (sc.openSkipMinutes ?? 15)) return { run: false, label: 'open', reason: `synced ${Math.round(sinceMin)} min ago`, missed: missed.length };
    if (missed.length) return { run: true, label: 'catch-up', reason: `${missed.length} missed slot${missed.length > 1 ? 's' : ''} → one sync`, missed: missed.length };
    return { run: true, label: 'open-refresh', reason: 'app opened', missed: 0 };
  }

  // ---------------- cross-tab lock ----------------
  /**
   * withLock(fn): runs fn only if no other tab/worker holds the lock. Never waits; returns { ran, result, by }.
   * Web Locks when available; otherwise a localStorage lease (renewed while running) announced on a BroadcastChannel.
   */
  function createLock(o) {
    const name = o.name || 'daylight-gmail-sync';
    const leaseMs = o.leaseMs || 120000;
    const now = o.now || (() => Date.now());
    const locks = o.locks === undefined ? (root.navigator && root.navigator.locks) : o.locks;
    const storage = o.storage === undefined ? safeStorage() : o.storage;
    const me = o.id || ('tab-' + Math.random().toString(36).slice(2, 10));
    let localBusy = false;
    const key = 'daylight-lock:' + name;

    async function viaLease(fn) {
      if (!storage) return { ran: true, result: await fn(), by: 'none' };
      const read = () => { try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; } };
      const cur = read();
      if (cur && cur.owner !== me && cur.until > now()) return { ran: false, by: 'lease', holder: cur.owner };
      storage.setItem(key, JSON.stringify({ owner: me, until: now() + leaseMs }));
      await new Promise((r) => setTimeout(r, o.settleMs ?? 30)); // let a racing tab's write land, then re-check
      if (read()?.owner !== me) return { ran: false, by: 'lease', holder: read()?.owner };
      const renew = setInterval(() => { try { storage.setItem(key, JSON.stringify({ owner: me, until: now() + leaseMs })); } catch {} }, Math.max(1000, leaseMs / 3));
      try { return { ran: true, result: await fn(), by: 'lease' }; }
      finally { clearInterval(renew); if (read()?.owner === me) storage.removeItem(key); }
    }

    async function withLock(fn) {
      if (localBusy) return { ran: false, by: 'tab' };
      localBusy = true;
      try {
        if (locks && typeof locks.request === 'function') {
          let out = { ran: false, by: 'web-locks' };
          await locks.request(name, { ifAvailable: true }, async (lock) => { if (!lock) return; out = { ran: true, result: await fn(), by: 'web-locks' }; });
          return out;
        }
        return await viaLease(fn);
      } finally { localBusy = false; }
    }
    return { withLock, id: me, busy: () => localBusy };
  }
  function safeStorage() { try { const s = root.localStorage; s.getItem('x'); return s; } catch { return null; } }

  // ---------------- browser adapter ----------------
  /**
   * opts.run(label, decision) → Promise (the actual sync); opts.getLastSyncAt() → ms|0; opts.config.schedule.
   * Fires: open (once), visible, slot timers while open, manual. Never overlaps (lock), and announces completion
   * to other tabs so they re-read the cache instead of syncing again.
   */
  function createBrowserScheduler(opts) {
    const cfg = opts.config.schedule;
    const now = opts.now || (() => Date.now());
    const lock = opts.lock || createLock({ name: cfg.lockName, leaseMs: cfg.lockLeaseMs, now });
    let timer = null, channel = null;
    try { channel = root.BroadcastChannel ? new root.BroadcastChannel('daylight-sync') : null; } catch { channel = null; }
    if (channel) channel.onmessage = (e) => { if (e.data?.type === 'synced' && typeof opts.onPeerSync === 'function') opts.onPeerSync(e.data); };
    const log = [];

    async function trigger(kind, extra) {
      const d = decide({ trigger: kind, now: now(), lastSyncAt: opts.getLastSyncAt() || 0, schedule: cfg, tz: opts.tz, slotAt: extra?.slotAt });
      log.push({ at: now(), kind, ...d });
      if (log.length > 50) log.shift();
      if (!d.run) return { ran: false, decision: d };
      const r = await lock.withLock(() => opts.run(d.label, d));
      if (!r.ran) { d.reason = 'another tab is syncing'; return { ran: false, decision: d, lock: r }; }
      try { channel && channel.postMessage({ type: 'synced', at: now(), label: d.label }); } catch {}
      return { ran: true, decision: d, result: r.result };
    }
    function arm() {
      if (!cfg.timersWhileOpen) return;
      clearTimeout(timer);
      const n = nextSlot(now(), cfg.slots, opts.tz);
      if (!n) return;
      const wait = Math.min(Math.max(1000, n - now() + 2000), 2 ** 31 - 1);
      timer = setTimeout(async () => { try { await trigger('slot', { slotAt: n }); } finally { arm(); } }, wait);
    }
    return {
      start() { arm(); return trigger('open'); },
      visible() { arm(); return trigger('visible'); },
      manual() { return trigger('manual'); },
      connect() { return trigger('connect'); },
      stop() { clearTimeout(timer); try { channel && channel.close(); } catch {} },
      nextSlot: () => nextSlot(now(), cfg.slots, opts.tz),
      log: () => log.slice(),
      lock
    };
  }

  const api = { parseSlot, zoneOffsetMs, slotInstants, missedSlots, nextSlot, lastSlot, decide, createLock, createBrowserScheduler };
  root.DaylightSyncScheduler = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
