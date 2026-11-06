/**
 * Daylight local connector (V2): things that live only on this device become Items too, so every screen reads the graph.
 *   - Wallet passes (localStorage daylight-wallet: scanned tickets, documents, coupons, passes Daylight saved from email)
 *   - Personal tasks from Version 1 (localStorage daylight-personal-tasks)
 *   - New tasks created in V2 (quick add, "Add to Plan", "Follow up") — these exist only in the graph
 * Import is idempotent and reconciles: a pass or V1 task that disappeared (deleted, or removed by Disconnect) loses its Item.
 * Never invents codes: a QR/barcode image is kept only when the pass marks it authentic (scan or real attachment).
 */
(function (root) {
  'use strict';
  const read = (ls, k) => { try { const v = JSON.parse(ls.getItem(k) || 'null'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const ms = (v) => { if (v == null || v === '') return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
  const hasClock = (v) => typeof v === 'string' && /T\d{2}:\d{2}|\d{1,2}:\d{2}/.test(v);

  function createLocalConnector(o) {
    const graph = o.graph, now = o.now || (() => Date.now());
    const ls = o.localStorage || (() => { try { return root.localStorage; } catch { return null; } })();
    const G = root.DaylightItemGraph || o.itemGraphApi;
    const iid = (k) => G.itemId(k);
    const mailKey = o.mailKey || null; // (mailId) → natural key of the Gmail email Item, to link a pass to its email

    function passItem(p) {
      const kind = p.kind || 'others';
      const type = kind === 'documents' ? 'document' : 'ticket';
      const authentic = !!(p.qrAuthentic || p.barcodeAuthentic || p.exactQr || p.scanSource);
      const at = ms(p.travelAt) || ms(p.eventAt) || ms(p.flight && p.flight.depart) || null;
      const f = p.flight || {};
      const factsArr = [['from', f.from], ['to', f.to], ['reference', f.pnr || p.reference], ['seat', f.seat], ['gate', f.gate], ['start', p.travelAt || p.eventAt || f.depart]]
        .filter(([, v]) => v != null && v !== '').map(([key, value]) => ({ key, value: String(value), sourceItemId: null, method: p.scanSource ? 'scan' : 'local' }));
      return {
        key: `wallet:${p.id}`, accountId: 'local', type, title: p.title || (f.from && f.to ? `${f.from} → ${f.to}` : 'Pass'), description: p.note || '',
        dueAt: at, createdAt: ms(p.at) || now(),
        sources: [{ app: 'wallet', accountId: 'local', itemId: String(p.id), url: null, role: 'primary' }],
        privacyClass: kind === 'documents' ? 'identity' : 'normal', aiExclude: kind === 'documents',
        extractedFacts: kind === 'documents' ? [] : factsArr,
        meta: { origin: 'wallet', walletKind: kind, timed: hasClock(p.travelAt || p.eventAt || f.depart || ''), expiresAt: ms(p.expires || p.expiresAt) || null,
          /* codes are drawn locally from the value (ui/codes.js); stored image URLs from older releases pointed at external
             image services and are never passed on, so nothing re-sends a code's value */
          qrImage: null, barcodeImage: null, codeText: authentic ? (p.qrPayload || p.barcode || null) : null,
          codeFormat: authentic && (p.qrPayload || p.barcode) ? String(p.barcodeFormat || 'qr_code').toLowerCase() : null,
          mailId: p.mailId || null }
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

    /** Mirror wallet passes and V1 tasks into the graph; remove Items whose local record is gone. */
    async function importLocal() {
      if (!ls) return { passes: 0, tasks: 0, removed: 0 };
      const passes = read(ls, 'daylight-wallet').filter((p) => p && p.id);
      const tasks = read(ls, 'daylight-personal-tasks').filter((t) => t && t.id && !t.suggested && !t.aiGenerated);
      const parts = [...passes.map(passItem), ...tasks.map(taskItem)];
      // a pass Daylight saved from an email that already produced a booking Item is the SAME thing: merge into that booking
      if (mailKey) {
        const mailItems = await graph.getMany(passes.filter((p) => p.mailId).map((p) => iid(mailKey(p.mailId))));
        const byMail = new Map(mailItems.map((m) => [m.sourceItemId, m]));
        const rel = await graph.getMany([...new Set(mailItems.flatMap((m) => m.relatedItemIds || []))]);
        const bookings = new Map(rel.filter((x) => x.type === 'booking').map((x) => [x.id, x]));
        parts.forEach((p, i) => {
          const pass = passes[i]; if (!pass || !pass.mailId) return;
          const m = byMail.get(String(pass.mailId)); if (!m) return;
          const b = (m.relatedItemIds || []).map((id) => bookings.get(id)).filter(Boolean);
          if (b.length !== 1) return;
          p.key = b[0].key; p.type = 'booking'; p.title = b[0].title; p.dueAt = b[0].dueAt || p.dueAt; p.accountId = b[0].accountId; p.meta.mergedInto = b[0].id;
          p.sources = p.sources.map((s) => Object.assign({}, s, { role: 'evidence' }));
        });
      }
      // a V1 task's done flag is the user's: only apply it on first import, later the graph status wins
      const prev = new Map((await graph.getMany(parts.map((p) => iid(p.key)))).map((x) => [x.id, x]));
      parts.forEach((p) => { if (prev.has(iid(p.key))) delete p.status; });
      if (parts.length) await graph.upsertMany(parts);
      const links = [];
      passes.forEach((p) => { if (p.mailId && mailKey) links.push([iid(`wallet:${p.id}`), iid(mailKey(p.mailId)), 'evidence']); });
      if (links.length && graph.linkMany) await graph.linkMany(links, 'local');
      // reconcile
      // reconcile: any wallet/task source whose local record is gone is dropped (Items left with no source are deleted)
      const livePass = new Set(passes.map((p) => String(p.id))), liveTask = new Set(tasks.map((t) => String(t.id)));
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
      importLocal, createTask, passItem, taskItem
    };
  }

  const api = { createLocalConnector };
  root.DaylightLocalConnector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
