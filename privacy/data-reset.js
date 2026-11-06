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

  /**
   * OWNERSHIP POLICY (V2)
   *  - Account data: everything Daylight derived from one Gmail account (graph Items with that account's Gmail source,
   *    its rules and action history, its mail cache rows, its finance ledger, its ingest/validation keys, and the Wallet
   *    passes / suggested tasks Daylight made from THAT account's email). Deleted when that account is disconnected.
   *  - Device data: tasks you typed and passes you scanned or typed yourself, settings, rhythm, limits. They belong to
   *    this device, not to a Gmail account, and are deleted only by "Delete all Daylight data on this device".
   *  - Classic-view caches (V1 keys such as daylight-loops) were never account-scoped; they mirror the ACTIVE account
   *    and are cleared when the active account is disconnected (another account rebuilds them on its next sync).
   */
  const ACCOUNT_SUFFIX_PREFIXES = ['daylight-v2-engine-error', 'daylight-graph-ingest', 'daylight-v2-ingest-log', 'daylight-v2-validation', 'daylight-v2-missed', 'daylight-gmail-last-sync', 'daylight-finance-ledger', 'daylight-conn-status', 'daylight-ai-include'];
  const ACTIVE_ONLY_KEYS = GMAIL_KEYS.filter((k) => k !== 'daylight-gmail-accounts').concat(['daylight-session-owner']);
  const mailIdOf = (x) => String((x && (x.mailId || (/^mail:/.test(String(x.id || '')) ? String(x.id).slice(5) : ''))) || '');
  const readJ = (ls, k, d) => { try { const v = JSON.parse(ls.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };

  // ownerAccount (v112): the Gmail account a mail-derived pass came from, recorded by the local connector
  function pruneWallet(ls, owns, ownerIs) {
    ownerIs = ownerIs || (() => false);
    let removed = 0;
    try {
      const raw = readJ(ls, 'daylight-wallet', []);
      if (!Array.isArray(raw)) return 0;
      const keep = raw.filter((p) => { const fromMail = !!(p && (p.mailId || /^mail:/.test(String(p.id || '')) || p.source === 'gmail')); const mine = fromMail && (p.ownerAccount ? ownerIs(p.ownerAccount) : owns(mailIdOf(p))); if (mine) removed++; return !mine; });
      ls.setItem('daylight-wallet', JSON.stringify(keep));
    } catch {}
    return removed;
  }
  function prunePersonalTasks(ls, owns) {
    let removed = 0;
    try {
      const raw = readJ(ls, 'daylight-personal-tasks', []);
      if (!Array.isArray(raw)) return 0;
      const keep = raw.filter((t) => { const auto = !!(t && (t.suggested || t.aiGenerated || t.fromMail || t.aiKey)); const mine = auto && owns(String(t.mailId || '')); if (mine) removed++; return !mine; })
        .map((t) => { if (t && t.mailId && owns(String(t.mailId))) { const c = Object.assign({}, t); delete c.mailId; delete c.financeRecordKey; if (/mail\.google\.com/.test(c.href || '')) delete c.href; return c; } return t; });
      ls.setItem('daylight-personal-tasks', JSON.stringify(keep));
    } catch {}
    return removed;
  }

  /**
   * Delete ONE Gmail account's data from this device (opts.accountId). Other accounts are untouched.
   * opts.active: this is the signed-in account (also clears credentials and the classic-view caches). Default true.
   * opts.mailCache: the Gmail mail cache, used to know which messages belong to this account.
   * Without accountId (legacy callers) every Gmail account on the device is removed.
   */
  async function deleteGmailData(opts) {
    const o = opts || {};
    const acct = o.accountId || null, active = o.active !== false;
    const ls = LS();
    const report = { account: acct, active, databases: [], keys: 0, walletPasses: 0, tasks: 0, graphItems: 0, mailCache: null, rules: 0, keptOtherAccounts: [] };
    const known = ls ? readJ(ls, 'daylight-gmail-accounts', []) : [];
    let graphAccounts = [];
    try { if (root.DaylightGraph?.query) graphAccounts = [...new Set((await root.DaylightGraph.query()).map((x) => x.accountId))].filter((a) => a && a !== 'local' && a !== 'sample' && a !== 'unassigned-mail'); /* held-back passes are not an account */ } catch {}
    const others = [...new Set([...(Array.isArray(known) ? known : []), ...graphAccounts])].filter((a) => a && a !== acct);
    report.keptOtherAccounts = acct ? others : [];
    const single = !acct || !others.length;
    // which messages belong to this account (decides ownership of mail-derived passes and suggested tasks)
    let ids = null;
    if (acct && o.mailCache) { try { ids = new Set((await o.mailCache.all(acct)).map((r) => String(r.messageId))); } catch {} }
    const owns = (mid) => single || (!!mid && !!ids && ids.has(String(mid)));
    if (ls) {
      const keys = []; for (let i = 0; i < ls.length; i++) keys.push(ls.key(i));
      keys.forEach((k) => {
        if (!k) return;
        const suffixed = ACCOUNT_SUFFIX_PREFIXES.some((p) => k.startsWith(p));
        const hit = suffixed ? (single || (acct && k.endsWith(':' + acct))) : (active && (ACTIVE_ONLY_KEYS.includes(k) || k.startsWith('daylight-connector-')));
        if (hit) { ls.removeItem(k); report.keys++; }
      });
      if (single) { if (ls.getItem('daylight-gmail-accounts') != null) { ls.removeItem('daylight-gmail-accounts'); report.keys++; } }
      else { try { ls.setItem('daylight-gmail-accounts', JSON.stringify(known.filter((a) => a !== acct))); } catch {} }
      try { const names = readJ(ls, 'daylight-v2-account-names', {}); if (single) ls.removeItem('daylight-v2-account-names'); else { delete names[acct]; ls.setItem('daylight-v2-account-names', JSON.stringify(names)); } } catch {}
      report.walletPasses = pruneWallet(ls, owns, (a) => (acct ? a === acct : true));
      report.tasks = prunePersonalTasks(ls, owns);
    }
    // Gmail mail cache (message index, facts, checkpoint, metrics): this account's rows only, or the whole db if it was the only one
    if (single) { report.databases.push(await deleteDb((root.DaylightGmailConfig?.get?.().cache?.dbName) || 'daylight-mail')); report.mailCache = 'database deleted'; }
    else if (o.mailCache?.clearAccount) { try { await o.mailCache.clearAccount(acct); report.mailCache = 'account rows deleted'; } catch (e) { report.mailCache = 'failed: ' + e; } }
    // Item graph: this account's Gmail Items (+ its links, rules and actions)
    try {
      if (root.DaylightGraph?.deleteBySource) {
        const before = root.DaylightGraph.rules ? (await root.DaylightGraph.rules.all()).length : 0;
        report.graphItems = await root.DaylightGraph.deleteBySource('gmail', acct);
        if (root.DaylightGraph.rules) report.rules = before - (await root.DaylightGraph.rules.all()).length;
        // processing-log entries about this account's messages
        try { const lg = await root.DaylightGraph.log.all(); const drop = lg.filter((e) => (acct ? e.accountId === acct : !!e.accountId) || (e.messageId && owns(e.messageId))).map((e) => e.id); if (drop.length) await root.DaylightGraph.log.delMany(drop); } catch {}
      } else report.databases.push(await deleteDb('daylight-graph'));
    } catch { if (single) report.databases.push(await deleteDb('daylight-graph')); }
    // passes and tasks pruned above lose their Items (a booking they were merged into keeps its other sources)
    try { const r = await root.DaylightV2?.local?.importLocal?.(); if (r) report.graphItems += r.removed || 0; } catch {}
    // account-scoped store rows (entities, facts, actions, reminders, sync state)
    try {
      const Store = root.DaylightStore;
      if (Store?.clearAccountData) { const id = (active ? await Store.getActiveAccountId?.() : null); if (id) await Store.clearAccountData(id); }
      else if (single) await Store?.clearProviderData?.();
    } catch {}
    try { root.DaylightPrivacyLog?.add?.({ kind: 'delete', what: acct ? 'gmail-data for one account' : 'gmail-data (all accounts)', detail: { items: report.graphItems, passes: report.walletPasses, tasks: report.tasks, others: report.keptOtherAccounts.length } }); } catch {}
    return report;
  }

  /** Delete one Microsoft account's data from this device (Outlook mail index + facts, Outlook and OneDrive Items, links,
   *  rules and actions, sync state). Gmail data, other accounts, your own tasks and passes and your settings stay. */
  async function deleteMicrosoftData(opts) {
    const o = opts || {}, acct = o.accountId;
    if (!acct) throw new Error('accountId required');
    const ls = LS();
    const report = { account: acct, keys: 0, graphItems: 0, mailCache: null };
    if (ls) {
      const keys = []; for (let i = 0; i < ls.length; i++) keys.push(ls.key(i));
      keys.forEach((k) => { if (k && k.startsWith('daylight') && k.endsWith(':' + acct)) { ls.removeItem(k); report.keys++; } });
    }
    if (o.mailCache?.clearAccount) { try { await o.mailCache.clearAccount(acct); report.mailCache = 'account rows deleted'; } catch (e) { report.mailCache = 'failed: ' + e; } }
    try {
      if (root.DaylightGraph?.deleteBySource) {
        report.graphItems = (await root.DaylightGraph.deleteBySource('outlook', acct)) + (await root.DaylightGraph.deleteBySource('onedrive', acct));
        const rest = (await root.DaylightGraph.query({ accountId: acct })); // e.g. people / organisations made only from Outlook mail
        for (const it of rest) for (const s of (it.sources || [])) report.graphItems += await root.DaylightGraph.removeSourceItem(s.app, acct, s.itemId);
        try { const lg = await root.DaylightGraph.log.all(); const drop = lg.filter((e) => e.accountId === acct).map((e) => e.id); if (drop.length) await root.DaylightGraph.log.delMany(drop); } catch {}
      }
    } catch (e) { report.error = String(e && e.message || e); }
    try { root.DaylightPrivacyLog?.add?.({ kind: 'delete', what: 'microsoft-data for one account', detail: { items: report.graphItems } }); } catch {}
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

  const api = { deleteGmailData, deleteMicrosoftData, deleteAll, GMAIL_KEYS, ACCOUNT_SUFFIX_PREFIXES };
  root.DaylightDataReset = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
