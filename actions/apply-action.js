/**
 * Daylight applyAction() (V2) — the one path every tap goes through.
 *   1. validate the action against the Item and its type
 *   2. update the Item locally (the user never waits for a server)
 *   3. queue write-back ONLY to providers that grant that write (V2 release: none — Gmail is read-only)
 *   4. record the action in the Item's history and the actions store
 *   5. on a storage failure, roll back and report; undo() restores the previous state
 * No network here: write-back jobs are executed by the connector when (and if) a write permission exists.
 */
(function (root) {
  'use strict';
  const KINDS = {
    done: { status: 'done' }, reopen: { status: 'open' }, dismiss: { status: 'dismissed' }, snooze: { status: 'snoozed' },
    pin: {}, unpin: {}, set_priority: {}, add_note: {}, correct_type: {}, schedule: {}, unschedule: {}
  };
  const SNAPSHOT = ['status', 'snoozedUntil', 'pinned', 'userPriority', 'priority', 'notes', 'type', 'classification', 'userCorrections', 'plannedAt', 'plannedMinutes'];
  const pick = (it) => { const o = {}; SNAPSHOT.forEach((k) => { o[k] = it[k] === undefined ? null : JSON.parse(JSON.stringify(it[k])); }); return o; };
  let seq = 0;
  // v112: ids also carry a random part — the clock + per-page counter alone could repeat across tabs, reloads or a clock
  // set back, and a repeated id would overwrite an older history entry. Existing ids are never rewritten.
  const rnd = () => { try { const a = new Uint32Array(2); root.crypto.getRandomValues(a); return a[0].toString(36) + a[1].toString(36); } catch { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10); } };

  function createActions(opts) {
    const o = opts || {};
    const graph = o.graph, registry = o.registry || null, rules = o.ruleStore || null, now = o.now || (() => Date.now());
    const Cls = o.classifier || root.DaylightClassifier;

    function validate(item, kind, payload) {
      if (!item) return 'Item not found';
      if (!KINDS[kind]) return `Unknown action: ${kind}`;
      if (kind === 'snooze') { const u = Number(payload && payload.until); if (!Number.isFinite(u) || u <= now()) return 'Snooze needs a time in the future'; }
      if (kind === 'set_priority') { const p = Number(payload && payload.priority); if (!Number.isFinite(p) || p < 0 || p > 100) return 'Priority must be 0–100'; }
      if (kind === 'add_note' && !String(payload && payload.text || '').trim()) return 'Note is empty';
      if (kind === 'correct_type' && !(Cls && Cls.TYPES.includes(payload && payload.type))) return 'Unknown type';
      if (kind === 'schedule') { const at = Number(payload && payload.at); const mins = payload && payload.minutes != null ? Number(payload.minutes) : 30; if (!Number.isFinite(at)) return 'Pick a time'; if (!Number.isFinite(mins) || mins < 5 || mins > 600) return 'Length must be 5–600 minutes'; }
      if (kind === 'done' && item.status === 'done') return 'Already done';
      return null;
    }

    async function applyAction(itemId, kind, payload, ctx) {
      const item = await graph.getItem(itemId);
      const err = validate(item, kind, payload || {});
      if (err) return { ok: false, error: err };
      const prev = pick(item);
      const at = now();
      const next = Object.assign({}, item);
      if (KINDS[kind].status) next.status = KINDS[kind].status;
      if (kind === 'snooze') next.snoozedUntil = Number(payload.until); else if (kind === 'reopen' || kind === 'done') next.snoozedUntil = null;
      if (kind === 'pin') next.pinned = true; if (kind === 'unpin') next.pinned = false;
      if (kind === 'set_priority') { next.userPriority = Number(payload.priority); next.priority = Number(payload.priority); }
      if (kind === 'schedule') { next.plannedAt = Number(payload.at); next.plannedMinutes = payload.minutes != null ? Number(payload.minutes) : 30; }
      if (kind === 'unschedule') { next.plannedAt = null; next.plannedMinutes = null; }
      if (kind === 'add_note') next.notes = [...(item.notes || []), { text: String(payload.text).trim(), at }];
      let rule = null;
      if (kind === 'correct_type') {
        next.type = item.type; // the Item kind (email/bill…) never changes; the message TYPE does
        next.classification = Object.assign({}, item.classification || {}, { type: payload.type, userSet: true, reasons: [`you set this to ${payload.type}`] });
        next.userCorrections = [...(item.userCorrections || []), { field: 'type', from: item.classification?.type || null, to: payload.type, at }];
      }
      // write-back plan: only providers that granted this write get a job; otherwise the change stays in Daylight
      const writeBack = (item.sources || []).map((s) => ({ app: s.app, itemId: s.itemId, status: registry && registry.canWrite(s.app, kind) ? 'queued' : 'local-only' }));
      const action = { id: `act_${at.toString(36)}_${(++seq).toString(36)}_${rnd()}`, accountId: item.accountId, itemId, kind, payload: payload || {}, prev, at, by: (ctx && ctx.by) || 'user', writeBack, undone: false };
      next.actionHistory = [...(item.actionHistory || []), { id: action.id, kind, at, payload: payload || {} }];
      try {
        await graph.putItem(next);
        await graph.actions.put(action);
        if (kind === 'correct_type' && rules && !(payload && payload.noRule)) {
          const src = { sourceApp: item.sourceApp, from: item.meta?.from, fromEmail: item.extractedEntities?.senderEmail, fromDomain: item.extractedEntities?.senderDomain, itemId, type: item.classification?.type };
          rule = await rules.upsertFromCorrection(src, payload.type, { accountId: item.accountId, scope: payload.scope });
          action.ruleId = rule.id; await graph.actions.put(action);
          await applyRuleToExisting(rule, itemId);
        }
      } catch (e) {
        try { await graph.putItem(item); } catch {}
        return { ok: false, error: 'Could not save: ' + (e && e.message || e), rolledBack: true };
      }
      return { ok: true, actionId: action.id, item: next, writeBack, rule };
    }

    /** A new rule re-types the user's other matching Items at once, so the same question is never asked twice. */
    async function applyRuleToExisting(rule, exceptId) {
      const UR = root.DaylightUserRules;
      const all = await graph.query({ accountId: rule.accountId || undefined, type: 'email' });
      let n = 0;
      for (const it of all) {
        if (it.id === exceptId || it.classification?.userSet) continue;
        const m = UR && UR.match([rule], { fromEmail: it.extractedEntities?.senderEmail, fromDomain: it.extractedEntities?.senderDomain, subject: it.title });
        if (!m || it.classification?.type === rule.set.type) continue;
        it.classification = Object.assign({}, it.classification || {}, { type: rule.set.type, ruleIds: [...new Set([...(it.classification?.ruleIds || []), rule.id])], reasons: [`your rule: ${rule.label}`, ...((it.classification?.reasons) || []).slice(0, 3)] });
        await graph.putItem(it); n++;
      }
      return n;
    }

    async function undo(actionId) {
      const a = await graph.actions.get(actionId);
      if (!a) return { ok: false, error: 'Action not found' };
      if (a.undone) return { ok: false, error: 'Already undone' };
      const item = await graph.getItem(a.itemId);
      if (!item) return { ok: false, error: 'Item no longer exists' };
      const restored = Object.assign({}, item, a.prev);
      restored.actionHistory = [...(item.actionHistory || []), { id: actionId + ':undo', kind: 'undo', of: a.kind, at: now() }];
      await graph.putItem(restored);
      a.undone = true; a.undoneAt = now(); await graph.actions.put(a);
      if (a.ruleId && rules) await rules.remove(a.ruleId);
      return { ok: true, item: restored };
    }

    /** Pending write-back jobs (empty in the read-only release). */
    async function pendingWrites() { return (await graph.actions.all()).filter((a) => !a.undone && (a.writeBack || []).some((w) => w.status === 'queued')); }

    /** Snoozed Items whose time has come back become open again. */
    async function wakeSnoozed() {
      const s = await graph.query({ status: 'snoozed' }); let n = 0;
      for (const it of s) if (it.snoozedUntil && it.snoozedUntil <= now()) { it.status = 'open'; it.snoozedUntil = null; await graph.putItem(it); n++; }
      return n;
    }

    return { applyAction, undo, validate, pendingWrites, wakeSnoozed, applyRuleToExisting, KINDS: Object.keys(KINDS) };
  }

  const api = { createActions };
  root.DaylightActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
