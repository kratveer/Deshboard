/**
 * Daylight privacy — disconnect-and-delete.
 * Removes everything Daylight derived from a provider on THIS device: caches, graph Items, Wallet passes,
 * finance ledger, AI extractions, reminders it created and sync state. Settings and the user's own
 * personal tasks are kept unless deleteAll() is used.
 * No network calls here; token revocation is done by the caller (Worker /auth/logout or Google revoke).
 */
(function (root) {
  'use strict';
  const LS = () => { try { return root.localStorage; } catch { return null; } };
  const GMAIL_KEYS = [
    'daylight-ai-extractions', 'daylight-ai-reminders', 'daylight-seen', 'daylight-loops', 'daylight-pay-amounts',
    'daylight-meeting-times', 'daylight-followup-suggested', 'daylight-alerted', 'daylight-orders',
    'daylight-finance-corrections', 'daylight-finance-confirmed', 'daylight-google-scopes', 'daylight-gmail-accounts', 'daylight-profile'
  ];
  const GMAIL_PREFIXES = ['daylight-finance-ledger', 'daylight-gmail-', 'daylight-graph-ingest', 'daylight-v2-validation', 'daylight-v2-missed'];
  // everything Daylight ever writes starts with one of these
  const ALL_PREFIXES = ['daylight-', 'dl-'];

  function deleteDb(name) {
    return new Promise((resolve) => {
      try {
        if (!root.indexedDB) return resolve({ name, ok: false, reason: 'no-indexeddb' });
        const req = root.indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve({ name, ok: true });
        req.onerror = () => resolve({ name, ok: false, reason: String(req.error) });
        req.onblocked = () => resolve({ name, ok: true, blocked: true }); // finishes once other tabs close
      } catch (e) { resolve({ name, ok: false, reason: String(e) }); }
    });
  }

  /** Wallet passes that came from Gmail carry a mailId (or a mail: id). Manually scanned passes stay. */
  function pruneWallet(ls) {
    let removed = 0;
    try {
      const raw = JSON.parse(ls.getItem('daylight-wallet') || '[]');
      if (!Array.isArray(raw)) return 0;
      const keep = raw.filter((p) => { const fromMail = !!(p && (p.mailId || /^mail:/.test(String(p.id || '')) || p.source === 'gmail')); if (fromMail) removed++; return !fromMail; });
      ls.setItem('daylight-wallet', JSON.stringify(keep));
    } catch {}
    return removed;
  }
  /** Personal tasks Daylight suggested from email are removed; the user's own (and ones they confirmed) stay without the mail link. */
  function prunePersonalTasks(ls) {
    let removed = 0;
    try {
      const raw = JSON.parse(ls.getItem('daylight-personal-tasks') || '[]');
      if (!Array.isArray(raw)) return 0;
      // suggestions Daylight made from email are removed; tasks the user created or confirmed stay, minus the mail link
      const keep = raw.filter((t) => { const auto = !!(t && (t.suggested || t.aiGenerated || t.fromMail || t.aiKey)); if (auto) removed++; return !auto; })
        .map((t) => { if (t && t.mailId) { const c = Object.assign({}, t); delete c.mailId; delete c.financeRecordKey; if (/mail\.google\.com/.test(c.href || '')) delete c.href; return c; } return t; });
      ls.setItem('daylight-personal-tasks', JSON.stringify(keep));
    } catch {}
    return removed;
  }

  /**
   * Remove all Gmail-derived data on this device.
   * Returns a report so the UI can say exactly what was deleted.
   */
  async function deleteGmailData(opts) {
    const o = opts || {};
    const ls = LS();
    const report = { databases: [], keys: 0, walletPasses: 0, tasks: 0, graphItems: 0 };
    if (ls) {
      const keys = [];
      for (let i = 0; i < ls.length; i++) keys.push(ls.key(i));
      keys.forEach((k) => {
        if (!k) return;
        if (GMAIL_KEYS.includes(k) || GMAIL_PREFIXES.some((p) => k.startsWith(p))) { ls.removeItem(k); report.keys++; }
      });
      report.walletPasses = pruneWallet(ls);
      report.tasks = prunePersonalTasks(ls);
    }
    // Gmail cache (message index, facts, checkpoint)
    report.databases.push(await deleteDb((root.DaylightGmailConfig?.get?.().cache?.dbName) || 'daylight-mail'));
    // Item graph: only Gmail Items when the graph is loaded, otherwise the whole graph db (it holds nothing else yet)
    try {
      if (root.DaylightGraph?.deleteBySource) report.graphItems = await root.DaylightGraph.deleteBySource('gmail', o.accountId || null);
      else report.databases.push(await deleteDb('daylight-graph'));
    } catch { report.databases.push(await deleteDb('daylight-graph')); }
    // Wallet passes and tasks pruned above: drop their Items too (and any booking they were merged into loses that source)
    try { const r = await root.DaylightV2?.local?.importLocal?.(); if (r) report.graphItems += r.removed || 0; } catch {}
    // account-scoped store rows (entities, facts, actions, reminders, sync state)
    try {
      const Store = root.DaylightStore;
      if (Store?.clearAccountData) { const id = o.accountId || await Store.getActiveAccountId?.(); if (id) await Store.clearAccountData(id); }
      else await Store?.clearProviderData?.();
    } catch {}
    try { root.DaylightPrivacyLog?.add?.({ kind: 'delete', what: 'gmail-data', detail: report }); } catch {}
    return report;
  }

  /** Delete everything Daylight stored on this device (Privacy Centre → Delete all). */
  async function deleteAll() {
    const ls = LS();
    let keys = 0;
    if (ls) {
      const all = [];
      for (let i = 0; i < ls.length; i++) all.push(ls.key(i));
      all.forEach((k) => { if (k && ALL_PREFIXES.some((p) => k.startsWith(p))) { ls.removeItem(k); keys++; } });
    }
    const databases = [];
    for (const n of ['daylight-mail', 'daylight-graph', 'daylight-db']) databases.push(await deleteDb(n));
    try { if (root.caches) { const names = await root.caches.keys(); await Promise.all(names.filter((n) => n.startsWith('daylight')).map((n) => root.caches.delete(n))); } } catch {}
    return { keys, databases };
  }

  const api = { deleteGmailData, deleteAll, GMAIL_KEYS };
  root.DaylightDataReset = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
