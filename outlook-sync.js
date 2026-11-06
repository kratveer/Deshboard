// Daylight Outlook mail engine (Microsoft Graph, read-only).
// Discovery: one delta query per folder (Inbox, Sent Items, Archive) from a saved delta link; the first run covers the
// window (receivedDateTime ≥ now − backfillDays). Immutable IDs, so a message keeps its ID when moved between folders.
// Each message is turned into the same shape the Gmail pipeline uses (headers, labels, snippet), so the same rules
// (Stage B), body reading and classifiers (Stage C) and the same Item Graph connector work unchanged.
// Bodies are read only when Stage B asks for them, 20 per Graph $batch, and are never stored (only facts and a hash).
// No DOM: runs in a page or a test. Network goes through o.fetch with a token from o.getToken().
(function (root) {
  'use strict';
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const DAY = 86400000;
  const FOLDERS = [['inbox', 'INBOX'], ['sentitems', 'SENT'], ['archive', 'ARCHIVE']];
  const SELECT = 'id,conversationId,subject,from,sender,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,isDraft,inferenceClassification,categories,hasAttachments,webLink';
  const IMMUTABLE = 'IdType="ImmutableId"';
  const addr = (a) => { const e = a && a.emailAddress; if (!e || !e.address) return ''; return e.name && e.name !== e.address ? `"${String(e.name).replace(/"/g, '')}" <${e.address}>` : e.address; };
  const b64url = (s) => { const bytes = new TextEncoder().encode(String(s || '')); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

  /** Graph message → Gmail-shaped metadata (what gmail-rules and the pipeline read). */
  function toMeta(m, folderLabel) {
    const labels = [folderLabel];
    if (folderLabel !== 'SENT') { if (m.isRead === false) labels.push('UNREAD'); labels.push(m.inferenceClassification === 'other' ? 'CATEGORY_UPDATES' : 'CATEGORY_PERSONAL'); }
    (m.categories || []).forEach((c) => labels.push('OUTLOOK_CATEGORY:' + c));
    const when = Date.parse(m.receivedDateTime || m.sentDateTime || '') || 0;
    const headers = [['From', addr(m.from || m.sender)], ['To', (m.toRecipients || []).map(addr).filter(Boolean).join(', ')], ['Subject', m.subject || ''], ['Date', when ? new Date(when).toUTCString() : '']].filter((x) => x[1]).map(([name, value]) => ({ name, value }));
    return { id: m.id, threadId: m.conversationId || m.id, labelIds: labels, snippet: String(m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 200), internalDate: String(when), historyId: null, payload: { mimeType: 'text/html', headers }, _webLink: m.webLink || null };
  }
  /** Add a fetched body (and List-Unsubscribe) to the metadata → Gmail-shaped full message (memory only). */
  function toFull(meta, b) {
    const headers = meta.payload.headers.slice();
    const lu = (b.internetMessageHeaders || []).find((h) => String(h.name).toLowerCase() === 'list-unsubscribe');
    if (lu) headers.push({ name: 'List-Unsubscribe', value: lu.value });
    const html = b.body && String(b.body.contentType).toLowerCase() === 'html';
    return Object.assign({}, meta, { payload: { mimeType: html ? 'text/html' : 'text/plain', headers, body: { data: b64url(b.body ? b.body.content : '') } } });
  }

  function createOutlookPipeline(o) {
    const cache = o.cache, R = o.rules, cfgAll = o.config, cfg = cfgAll.pipeline, win = cfgAll.window;
    const now = o.now || (() => Date.now());
    const doFetch = o.fetch || ((u, i) => root.fetch(u, i));
    const helper = (root.DaylightMailPipeline || o.mailPipelineApi).createMailPipeline({ engine: null, cache, rules: R, config: cfgAll, derive: o.derive, dates: o.dates, now });
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const maxPages = o.maxPages || 40;

    async function call(ctx, url, init) {
      for (let attempt = 0; ; attempt++) {
        let token; try { token = await o.getToken(attempt > 0 && ctx.lastAuthFail); } catch (e) { ctx.fatal = { kind: 'auth', message: String(e && e.message || e) }; return { ok: false, status: 401, kind: 'auth' }; }
        const headers = Object.assign({ Authorization: 'Bearer ' + token, Prefer: IMMUTABLE + ', odata.maxpagesize=50' }, (init && init.headers) || {});
        let r;
        try { r = await doFetch(url, Object.assign({}, init || {}, { headers })); } catch (e) { if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; } return { ok: false, status: 0, kind: 'network' }; }
        ctx.requests++;
        if (r.status === 401 && attempt === 0) { ctx.lastAuthFail = true; continue; }
        if ((r.status === 429 || r.status === 503 || r.status === 504) && attempt < 3) { ctx.throttled++; const ra = Number(r.headers.get('Retry-After')) || (2 ** attempt); await sleep(Math.min(30, ra) * 1000); continue; }
        const data = await r.json().catch(() => null);
        if (!r.ok) { if (r.status === 401) ctx.fatal = { kind: 'auth' }; return { ok: false, status: r.status, kind: r.status === 404 ? 'notFound' : r.status === 403 ? 'forbidden' : 'error', data }; }
        return { ok: true, status: r.status, data };
      }
    }

    /** Follow one folder's delta from its saved link (or from the window start). */
    async function delta(ctx, folder, link, windowDays) {
      let url = link || `${GRAPH}/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(now() - windowDays * DAY).toISOString().replace(/\.\d+Z$/, 'Z')}`)}`;
      const added = [], removed = [];
      for (let page = 0; page < maxPages; page++) {
        const r = await call(ctx, url);
        if (!r.ok) return { ok: false, added, removed, error: r, expired: r.status === 410 || (r.data && /syncStateNotFound|resyncRequired/i.test(JSON.stringify(r.data))) };
        (r.data.value || []).forEach((m) => { if (m['@removed']) removed.push(m.id); else if (!m.isDraft) added.push(m); });
        if (r.data['@odata.deltaLink']) return { ok: true, added, removed, link: r.data['@odata.deltaLink'] };
        if (!r.data['@odata.nextLink']) return { ok: true, added, removed, link: null };
        url = r.data['@odata.nextLink'];
      }
      return { ok: false, added, removed, error: { kind: 'overflow' }, overflow: true };
    }

    /** Bodies for up to 20 messages in one $batch; per-message results. */
    async function bodies(ctx, ids) {
      const out = new Map();
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const r = await call(ctx, `${GRAPH}/$batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: chunk.map((id, n) => ({ id: String(n), method: 'GET', url: `/me/messages/${encodeURIComponent(id)}?$select=body,internetMessageHeaders`, headers: { Prefer: IMMUTABLE } })) }) });
        ctx.batches++;
        if (!r.ok) { chunk.forEach((id) => out.set(id, { ok: false, kind: r.kind })); continue; }
        (r.data.responses || []).forEach((x) => { const id = chunk[Number(x.id)]; if (id == null) return; out.set(id, x.status === 200 ? { ok: true, data: x.body } : { ok: false, status: x.status, deleted: x.status === 404, kind: x.status === 429 ? 'throttled' : 'error' }); });
      }
      return out;
    }

    async function run(opts) {
      const acct = opts.accountId;
      const t0 = now();
      const ctx = { requests: 0, batches: 0, throttled: 0, fatal: null, lastAuthFail: false };
      const cp = (await cache.getCheckpoint(acct)) || {};
      const links = Object.assign({}, cp.msDelta || {});
      const cold = !cp.backfilledAt;
      const windowDays = opts.windowDays || win.backfillDays;
      const C = { syncs: 1 };
      const adds = new Map(), removes = new Set(), folderInfo = {};
      for (const [folder, label] of FOLDERS) {
        if (ctx.fatal) break;
        if (links[folder] === 'none') continue; // the account has no such folder (e.g. no Archive)
        let d = await delta(ctx, folder, links[folder], windowDays);
        if (!d.ok && d.expired && links[folder]) { C.resync = (C.resync || 0) + 1; d = await delta(ctx, folder, null, windowDays); } // delta link expired → start this folder again (cache makes it cheap)
        if (!d.ok && d.error && d.error.status === 404 && folder !== 'inbox') { links[folder] = 'none'; folderInfo[folder] = 'absent'; continue; }
        folderInfo[folder] = d.ok ? { added: d.added.length, removed: d.removed.length } : { error: d.error && (d.error.kind || d.error.status) };
        d.removed.forEach((id) => removes.add(id));
        d.added.forEach((m) => adds.set(m.id, toMeta(m, label)));
        if (d.ok && d.link) links[folder] = d.link;
      }
      adds.forEach((m, id) => removes.delete(id)); // moved between folders: removed from one, added to another (same immutable ID)
      const existing = await cache.getMany(acct, [...adds.keys()]);
      const newRecs = [];
      let fresh = 0, relabelled = 0;
      for (const [id, meta] of adds) {
        const prev = existing.get(id);
        if (prev && prev.status !== 'deleted' && prev.status !== 'meta-pending') {
          // a known message changed (read/unread, folder, category): labels only, no body, no reclassification
          if (prev.labels.slice().sort().join() !== meta.labelIds.slice().sort().join()) { relabelled++; newRecs.push(Object.assign({}, prev, { labels: meta.labelIds, lastLabelAt: now(), lastProcessedAt: now() })); }
          continue;
        }
        fresh++;
        const from = R.header(meta, 'From'), dom = R.baseDomain(R.senderDomain(from));
        const dc = await cache.getDomainCategory(acct, dom);
        const b = R.stageB(meta, { domainCategory: dc, searchHits: undefined, cfg });
        C['stage_' + b.stage] = (C['stage_' + b.stage] || 0) + 1;
        const rec = helper.recordFromMeta(meta, b, prev);
        rec.provider = 'outlook'; rec.webLink = meta._webLink;
        newRecs.push(rec);
      }
      await cache.putMany(acct, newRecs);
      const deletedNow = await cache.markDeleted(acct, [...removes]);

      // bodies, from the persistent queue (this sync's and earlier backlog)
      const all = await cache.all(acct);
      const prio = (r) => (r.escalated ? 1 : 0) + ({ bill: 3, travel: 3, refund: 3, payment: 2, food: 2, subscription: 2, document: 2, receipt: 1 }[r.category] || 0);
      const take = all.filter((r) => r.status === 'body-queued').sort((a, b) => prio(b) - prio(a) || b.internalDate - a.internalDate).slice(0, cfg.maxFullPerSync);
      const got = ctx.fatal ? new Map() : await bodies(ctx, take.map((r) => r.messageId));
      const doneRecs = [], factsOut = [];
      let bodyFetched = 0, bodyDeferred = 0;
      for (const rec of take) {
        const r = got.get(rec.messageId);
        if (!r || !r.ok) { if (r && r.deleted) { rec.status = 'deleted'; rec.deletedAt = now(); doneRecs.push(rec); } else bodyDeferred++; continue; }
        bodyFetched++;
        const meta = { id: rec.messageId, threadId: rec.threadId, labelIds: rec.labels, snippet: rec.snippet, internalDate: String(rec.internalDate), payload: { mimeType: 'text/html', headers: [['From', rec.from], ['To', rec.to], ['Subject', rec.subject], ['Date', rec.date]].filter((x) => x[1]).map(([name, value]) => ({ name, value })) } };
        const full = toFull(meta, r.data);
        if (full.payload.headers.some((h) => h.name === 'List-Unsubscribe')) rec.listUnsubscribe = true;
        const d0 = helper.bodyDecide(rec, full);
        let category = d0.category, confidence = d0.confidence;
        const [lo, hi] = cfg.reviewBand;
        if (rec.userCategory) { category = rec.userCategory; confidence = 0.99; rec.category = category; rec.confidence = 0.99; rec.ruleReason = 'your choice'; }
        rec.status = rec.userCategory ? 'done' : (confidence >= lo && confidence < hi && R.HIGH_VALUE.has(category) ? 'review' : 'done');
        factsOut.push({ messageId: rec.messageId, kind: category, fields: d0.c.facts, structured: d0.c.structured.map((s) => ({ type: s.type, source: s.source })), source: d0.c.source, missing: d0.c.missing, bodyHash: d0.c.bodyHash, derived: d0.derived, at: now() });
        doneRecs.push(rec);
      }
      await cache.putMany(acct, doneRecs);
      await cache.putFacts(acct, factsOut);
      const discoveryOk = !ctx.fatal && Object.values(folderInfo).every((f) => f === 'absent' || !f.error);
      await cache.setCheckpoint(acct, { msDelta: links, backfilledAt: cp.backfilledAt || (discoveryOk ? now() : null), windowDays, lastSyncAt: discoveryOk ? now() : (cp.lastSyncAt || 0), lastMode: cold ? 'backfill' : 'delta' });
      const backlog = (await cache.all(acct)).filter((r) => r.status === 'body-queued').length;
      const partial = !discoveryOk || bodyDeferred > 0;
      const report = { provider: 'outlook', ok: !partial, partial, fatal: ctx.fatal, cold, durationMs: now() - t0, requests: ctx.requests, batches: ctx.batches, throttled: ctx.throttled, folders: folderInfo,
        records: { fresh, relabelled, deleted: deletedNow.length, bodyFetched, bodyDeferred, bodyBacklog: backlog }, counters: C,
        summary: ctx.fatal ? `Outlook sync stopped: ${ctx.fatal.kind === 'auth' ? 'Microsoft sign-in expired' : ctx.fatal.kind}` : partial ? 'Outlook partly synced' : `Outlook synced · ${fresh ? fresh + ' new' : 'no new mail'}${backlog ? `, ${backlog} full texts queued` : ''}` };
      return { report };
    }
    return { run, toMeta, toFull };
  }

  const outlookUrl = (rec) => rec.webLink || 'https://outlook.live.com/mail/0/';
  const api = { createOutlookPipeline, toMeta, toFull, outlookUrl, FOLDERS };
  root.DaylightOutlookPipeline = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
