/**
 * Daylight local connector (V2): things that live only on this device become Items too, so every screen reads the graph.
 *   - Wallet passes (localStorage daylight-wallet: scanned tickets, documents, coupons, passes Daylight saved from email)
 *   - Personal tasks from Version 1 (localStorage daylight-personal-tasks)
 *   - New tasks created in V2 (quick add, "Add to Plan", "Follow up") — these exist only in the graph
 * Import is idempotent and reconciles: a pass or V1 task that disappeared (deleted, or removed by Disconnect) loses its Item.
 * Never invents codes: a QR/barcode image is kept only when the pass marks it authentic (scan or real attachment).
 * Ownership (v112): a pass Daylight saved from an email (older releases did this; mailId / id 'mail:…' / source 'gmail')
 * belongs to the Gmail account that email came from, not to the device. Its Item gets that account's accountId, so it is
 * hidden and left out of exports with the rest of that account's data. The owner is resolved only on evidence (that
 * account's email Item for the message is in the graph) and kept on the pass as ownerAccount. A mail-derived pass whose
 * owner is not proven is held back ('unassigned-mail': hidden, not exported, removed by Delete all) until the evidence
 * appears or the user assigns it in Privacy Centre. Passes you scanned or typed stay device data ('local').
 */
(function (root) {
  'use strict';
  const read = (ls, k) => { try { const v = JSON.parse(ls.getItem(k) || 'null'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const ms = (v) => { if (v == null || v === '') return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
  const hasClock = (v) => typeof v === 'string' && /T\d{2}:\d{2}|\d{1,2}:\d{2}/.test(v);
  const UNASSIGNED = 'unassigned-mail';
  const fromMail = (p) => !!(p && (p.mailId || /^mail:/.test(String(p.id || '')) || p.source === 'gmail'));
  const mailIdOf = (p) => String((p && (p.mailId || (/^mail:/.test(String(p.id || '')) ? String(p.id).slice(5) : ''))) || '');

  function createLocalConnector(o) {
    const graph = o.graph, now = o.now || (() => Date.now());
    const ls = o.localStorage || (() => { try { return root.localStorage; } catch { return null; } })();
    const G = root.DaylightItemGraph || o.itemGraphApi;
    const iid = (k) => G.itemId(k);
    const mailKey = o.mailKey || null; // (mailId) → natural key of the Gmail email Item, to link a pass to its email

    const ownerOf = (p) => (fromMail(p) ? (p.ownerAccount || UNASSIGNED) : 'local');
    function passItem(p) {
      const kind = p.kind || 'others';
      const type = kind === 'documents' ? 'document' : 'ticket';
      const authentic = !!(p.qrAuthentic || p.barcodeAuthentic || p.exactQr || p.scanSource);
      const at = ms(p.travelAt) || ms(p.eventAt) || ms(p.flight && p.flight.depart) || null;
      const f = p.flight || {};
      const factsArr = [['from', f.from], ['to', f.to], ['reference', f.pnr || p.reference], ['seat', f.seat], ['gate', f.gate], ['start', p.travelAt || p.eventAt || f.depart]]
        .filter(([, v]) => v != null && v !== '').map(([key, value]) => ({ key, value: String(value), sourceItemId: null, method: p.scanSource ? 'scan' : 'local' }));
      return {
        key: `wallet:${p.id}`, accountId: ownerOf(p), type, title: p.title || (f.from && f.to ? `${f.from} → ${f.to}` : 'Pass'), description: p.note || '',
        dueAt: at, createdAt: ms(p.at) || now(),
        sources: [{ app: 'wallet', accountId: 'local', itemId: String(p.id), url: null, role: 'primary' }],
        privacyClass: kind === 'documents' ? 'identity' : 'normal', aiExclude: kind === 'documents',
        extractedFacts: kind === 'documents' ? [] : factsArr,
        meta: { origin: 'wallet', walletKind: kind, timed: hasClock(p.travelAt || p.eventAt || f.depart || ''), expiresAt: ms(p.expires || p.expiresAt) || null,
          /* codes are drawn locally from the value (ui/codes.js); stored image URLs from older releases pointed at external
             image services and are never passed on, so nothing re-sends a code's value */
          qrImage: null, barcodeImage: null, codeText: authentic ? (p.qrPayload || p.barcode || null) : null,
          codeFormat: authentic && (p.qrPayload || p.barcode) ? String(p.barcodeFormat || 'qr_code').toLowerCase() : null,
          mailId: p.mailId || null, fromMail: fromMail(p) || undefined }
      };
    }
    function taskItem(t) {
      const due = ms(t.dueDate || t.due);
      return {
        key: `task:local:${t.id}`, accountId: 'local', type: 'task', title: t.title || 'Task', description: t.project || t.note || '',
        dueAt: due, createdAt: ms(t.created) || now(), status: t.done || t.completed ? 'done' : 'open',
        sources: [{ app: 'daylight', accountId: 'local', itemId: String(t.id), url: null, role: 'primary' }],
        meta: { origin: 'tasks', timed: !!t.hasTime, project: t.project || null }
      };
    }

    /** Mirror wallet passes and V1 tasks into the graph; remove Items whose local record is gone.
     *  v112: imports run one at a time (Web Locks across tabs when available, a queue within the tab), and every write
     *  decision uses the CURRENT localStorage record, re-read after each wait — another tab may add, stamp or delete
     *  passes meanwhile. A pass deleted elsewhere is never written back; a pass added elsewhere is never reconciled away. */
    let queue = Promise.resolve();
    function importLocal() {
      const L = (() => { try { return root.navigator && root.navigator.locks; } catch { return null; } })();
      const run = () => (L && L.request ? L.request('daylight-local-import', () => importLocalNow()) : importLocalNow());
      const p = queue.then(run, run); queue = p.catch(() => {}); return p;
    }
    const livePasses = () => read(ls, 'daylight-wallet').filter((p) => p && p.id);
    async function importLocalNow() {
      if (!ls) return { passes: 0, tasks: 0, removed: 0 };
      await resolveOwners(livePasses());
      const passes = livePasses(); // re-read: includes owners stamped just now or by another tab
      const tasks = read(ls, 'daylight-personal-tasks').filter((t) => t && t.id && !t.suggested && !t.aiGenerated);
      const parts = [...passes.map(passItem), ...tasks.map(taskItem)];
      // a pass Daylight saved from an email that already produced a booking Item is the SAME thing: merge into that booking
      if (mailKey) {
        const mailItems = await graph.getMany(passes.filter((p) => p.mailId && p.ownerAccount).map((p) => iid(mailKey(p.mailId, p.ownerAccount))));
        const byMail = new Map(mailItems.map((m) => [m.sourceItemId, m]));
        const rel = await graph.getMany([...new Set(mailItems.flatMap((m) => m.relatedItemIds || []))]);
        const bookings = new Map(rel.filter((x) => x.type === 'booking').map((x) => [x.id, x]));
        parts.forEach((p, i) => {
          const pass = passes[i]; if (!pass || !pass.mailId || !pass.ownerAccount) return;
          const m = byMail.get(String(pass.mailId)); if (!m) return;
          const b = (m.relatedItemIds || []).map((id) => bookings.get(id)).filter(Boolean);
          if (b.length !== 1 || b[0].accountId !== pass.ownerAccount) return;
          p.key = b[0].key; p.type = 'booking'; p.title = b[0].title; p.dueAt = b[0].dueAt || p.dueAt; p.accountId = b[0].accountId; p.meta.mergedInto = b[0].id;
          p.sources = p.sources.map((s) => Object.assign({}, s, { role: 'evidence' }));
        });
      }
      // a V1 task's done flag is the user's: only apply it on first import, later the graph status wins
      const prev = new Map((await graph.getMany(parts.map((p) => iid(p.key)))).map((x) => [x.id, x]));
      await markFeedbackPasses(passes, parts, prev);
      parts.forEach((p) => { if (prev.has(iid(p.key))) delete p.status; });
      // just before writing: drop passes deleted meanwhile (e.g. an account disconnected in another tab) and take an owner
      // another tab recorded meanwhile (owners are only ever added, never changed)
      const nowPass = new Map(livePasses().map((p) => [String(p.id), p]));
      const write = parts.map((p, i) => {
        if (i >= passes.length) return p;
        const cur = nowPass.get(String(passes[i].id)); if (!cur) return null;
        return cur.ownerAccount && !passes[i].ownerAccount ? passItem(cur) : p;
      }).filter(Boolean);
      if (write.length) await graph.upsertMany(write);
      // …and right after: if another tab recorded an owner while we were writing, write that pass again with its owner
      const afterPass = new Map(livePasses().map((p) => [String(p.id), p]));
      const fix = write.filter((p) => p.meta && p.meta.origin === 'wallet' && !p.meta.mergedInto)
        .map((p) => ({ p, cur: afterPass.get(String(p.key).slice('wallet:'.length)) }))
        .filter(({ p, cur }) => cur && ownerOf(cur) !== p.accountId).map(({ cur }) => cur);
      if (fix.length) await graph.upsertMany(fix.map(passItem));
      // a pass merged into its booking may still have its own older standalone Item (made before the booking existed)
      const merged = new Set(); parts.forEach((p, i) => { if (i < passes.length && p.meta && p.meta.mergedInto) merged.add(String(passes[i].id)); });
      if (merged.size) await settleMergedDuplicates(passes.filter((p) => merged.has(String(p.id)) && nowPass.has(String(p.id))), parts);
      const links = [];
      passes.forEach((p) => { if (p.mailId && p.ownerAccount && mailKey && nowPass.has(String(p.id)) && !merged.has(String(p.id))) links.push([iid(`wallet:${p.id}`), iid(mailKey(p.mailId, p.ownerAccount)), 'evidence']); });
      if (links.length && graph.linkMany) await graph.linkMany(links, 'local');
      // reconcile: any wallet/task source whose local record is gone is dropped (Items left with no source are deleted).
      // Uses a fresh read, so a pass another tab added during this import is kept.
      const livePass = new Set(livePasses().map((p) => String(p.id))), liveTask = new Set(tasks.map((t) => String(t.id)));
      const gone = [];
      (await graph.query()).forEach((x) => (x.sources || []).forEach((s) => {
        if (s.accountId !== 'local') return;
        if (s.app === 'wallet' && !livePass.has(String(s.itemId))) gone.push(s);
        if (s.app === 'daylight' && x.meta?.origin === 'tasks' && !liveTask.has(String(s.itemId))) gone.push(s);
      }));
      let removed = 0;
      for (const s of gone) removed += await graph.removeSourceItem(s.app, 'local', s.itemId);
      return { passes: passes.length, tasks: tasks.length, removed };
    }

    /** Which Gmail account a mail-derived pass came from — only on evidence: exactly one known Gmail account holds that
     *  message's email Item in the graph. There is no fallback to "the only account on this device" (the pass may come
     *  from an account deleted earlier). Resolved owners are kept on the pass (ownerAccount, an added field — nothing else
     *  in the record changes, and an owner already recorded is never replaced); unresolved passes stay unassigned
     *  (hidden, not exported) and are tried again next time, or the user assigns them (assignUnassigned). */
    async function resolveOwners(passes) {
      const todo = passes.filter((p) => fromMail(p) && !p.ownerAccount && mailIdOf(p));
      if (!todo.length || !mailKey) return 0;
      const known = new Set((o.gmailAccounts ? (o.gmailAccounts() || []) : []).filter((a) => a && !/^(local|sample|ms-)/.test(a)));
      try { (await graph.query()).forEach((x) => { if (x.sourceApp === 'gmail' && x.accountId && !/^(local|sample|ms-)/.test(x.accountId)) known.add(x.accountId); }); } catch {}
      const cands = [...known]; if (!cands.length) return 0;
      let n = 0;
      for (const p of todo) {
        const mid = mailIdOf(p);
        const hits = (await graph.getMany(cands.map((a) => iid(mailKey(mid, a))))).map((m) => m.accountId);
        const owner = hits.length === 1 ? hits[0] : null;
        if (owner) { p.ownerAccount = owner; n++; }
      }
      if (n) { try { const raw = read(ls, 'daylight-wallet'); const by = new Map(todo.filter((p) => p.ownerAccount).map((p) => [String(p.id), p.ownerAccount])); ls.setItem('daylight-wallet', JSON.stringify(raw.map((p) => (p && by.has(String(p.id)) && !p.ownerAccount ? Object.assign({}, p, { ownerAccount: by.get(String(p.id)) }) : p)))); } catch {} }
      return n;
    }

    /** v112 (seen in real data): older releases saved some review / feedback requests ("Write a review for …") as Wallet
     *  passes. When the email such a pass came from is now read as a feedback request, the pass is kept (its record and
     *  Item are not deleted) but marked meta.notAPass = 'feedback', so Wallet does not show it. A pass you acted on (pin,
     *  note, status, plan …) stays in Wallet. Recomputed on every import, so correcting the email's type undoes it. */
    async function markFeedbackPasses(passes, parts, prev) {
      if (!mailKey) return 0;
      const idx = []; passes.forEach((p, i) => { if (fromMail(p) && p.ownerAccount && mailIdOf(p) && !(parts[i].meta && parts[i].meta.mergedInto)) idx.push(i); });
      if (!idx.length) return 0;
      const mails = new Map((await graph.getMany(idx.map((i) => iid(mailKey(mailIdOf(passes[i]), passes[i].ownerAccount))))).map((m) => [m.id, m]));
      let actions = null, allLinks = null, n = 0;
      for (const i of idx) {
        const m = mails.get(iid(mailKey(mailIdOf(passes[i]), passes[i].ownerAccount)));
        const fb = !!(m && m.accountId === passes[i].ownerAccount && m.classification && m.classification.type === 'feedback');
        let flag = fb ? 'feedback' : null;
        if (fb) {
          const before = prev.get(iid(parts[i].key));
          if (before) { if (!actions) { actions = graph.actions ? await graph.actions.all().catch(() => []) : []; allLinks = graph.links ? await graph.links().catch(() => []) : []; } if (hasUserState(before, actions, allLinks)) flag = null; }
        }
        parts[i].meta.notAPass = flag; if (flag) n++;
      }
      return n;
    }

    /** Older standalone Items of passes that are now merged into a booking (v112, found in real data: they stayed
     *  'local', so they were duplicates and visible to other logins). For each — only when the pass came from an email,
     *  its owner is proven, the booking it merges into exists and belongs to that same account:
     *    no user state on the standalone Item → remove that Item (only its own wallet source; the booking is untouched)
     *    user state (status, snooze, pin, notes, plan, corrections, history, actions, links you made) → keep it whole, owned
     *    by the pass's account (hidden from other logins, exported only with that account)
     *  Passes you scanned or typed are never merged, so never touched here. Returns { removed, rescoped }. */
    async function settleMergedDuplicates(mergedPasses, parts) {
      const out = { removed: 0, rescoped: 0 };
      if (!mergedPasses.length) return out;
      const stand = new Map((await graph.getMany(mergedPasses.map((p) => iid(`wallet:${p.id}`)))).map((x) => [x.id, x]));
      if (!stand.size) return out;
      const actions = graph.actions ? await graph.actions.all().catch(() => []) : [];
      const allLinks = graph.links ? await graph.links().catch(() => []) : [];
      const drop = [], keep = [];
      for (const p of mergedPasses) {
        if (!fromMail(p) || !p.ownerAccount) continue;
        const it = stand.get(iid(`wallet:${p.id}`)); if (!it) continue;
        const part = parts.find((x) => x.meta && x.meta.mergedInto && (x.sources || []).some((s) => s.app === 'wallet' && String(s.itemId) === String(p.id)));
        const booking = part ? (await graph.getMany([part.meta.mergedInto]))[0] : null;
        if (!booking || booking.accountId !== p.ownerAccount || booking.id === it.id) continue; // ownership or target not proven: leave it
        if (hasUserState(it, actions, allLinks)) { if (it.accountId !== p.ownerAccount) keep.push(Object.assign(passItem(p), { key: `wallet:${p.id}` })); }
        else drop.push({ itemId: it.id, app: 'wallet', accountId: 'local', sourceItemId: String(p.id) });
      }
      if (keep.length) { await graph.upsertMany(keep); out.rescoped = keep.length; }
      if (drop.length && graph.detachSources) out.removed = await graph.detachSources(drop);
      return out;
    }
    const OPEN = (v) => v == null || v === 'open' || v === false || (Array.isArray(v) && !v.length);
    function hasUserState(it, actions, allLinks) {
      if (['status', 'snoozedUntil', 'pinned', 'userPriority', 'plannedAt', 'plannedMinutes', 'notes', 'userCorrections', 'actionHistory'].some((k) => !OPEN(it[k]))) return true;
      if (it.classification && it.classification.userSet) return true;
      if (actions.some((a) => a.itemId === it.id)) return true;
      return allLinks.some((l) => (l.from === it.id || l.to === it.id) && l.kind !== 'evidence'); // e.g. a task you planned "about" it
    }

    /** The user's explicit choice: show the unassigned mail-derived passes in this account (acct). Only passes with no
     *  recorded owner are changed; the choice is recorded (ownerAssignedBy: 'user'). Returns how many were assigned. */
    async function assignUnassigned(acct) {
      if (!ls || !acct || /^(local|sample|unassigned)/.test(acct)) return 0;
      let n = 0;
      const raw = read(ls, 'daylight-wallet');
      const next = raw.map((p) => { if (p && p.id && fromMail(p) && !p.ownerAccount) { n++; return Object.assign({}, p, { ownerAccount: acct, ownerAssignedBy: 'user' }); } return p; });
      if (n) ls.setItem('daylight-wallet', JSON.stringify(next));
      await importLocal();
      return n;
    }

    /** A task created in V2. relatedTo links it to the Item it came from (an email, a bill, a person). */
    async function createTask(t) {
      const id = 'v2_' + now().toString(36) + Math.random().toString(36).slice(2, 7);
      const it = await graph.upsertItem({
        key: `task:v2:${id}`, accountId: 'local', type: 'task', title: String(t.title || '').trim() || 'Task', description: t.note || '',
        dueAt: ms(t.dueAt) || null, plannedAt: ms(t.plannedAt) || null, plannedMinutes: t.minutes || null,
        sources: [{ app: 'daylight', accountId: 'local', itemId: id, url: null, role: 'primary' }],
        meta: { origin: 'v2', timed: !!t.timed }
      });
      if (Number.isFinite(ms(t.plannedAt))) { it.plannedAt = ms(t.plannedAt); it.plannedMinutes = t.minutes || 30; await graph.putItem(it); }
      if (t.relatedTo) await graph.link(it.id, t.relatedTo, 'about', 'local');
      return graph.getItem(it.id);
    }

    return {
      id: 'daylight', name: 'On this device', status: 'live', group: 'local',
      reads: 'Your own tasks and the passes in your Wallet — stored only on this device',
      getCapabilities: () => ({ read: ['task', 'ticket', 'document'], write: [] }), // the graph IS the store: nothing to write back
      getPermissions: () => [],
      async getConnectionStatus() { return { connected: true, local: true }; },
      async validateConnection() { return { ok: true }; },
      async connect() { return { ok: true }; },
      async disconnect() { return { ok: false, reason: 'local data is removed with Delete everything' }; },
      async fetchItems(q) { return graph.query(Object.assign({ accountId: 'local' }, q || {})); },
      normalise: (rec) => (rec && rec.kind ? passItem(rec) : taskItem(rec || {})),
      async sync() { return importLocal(); },
      importLocal, assignUnassigned, createTask, passItem, taskItem
    };
  }

  const api = { createLocalConnector };
  root.DaylightLocalConnector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
