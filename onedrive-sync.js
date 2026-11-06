// Daylight OneDrive files (Microsoft Graph, read-only: Files.Read = your own OneDrive).
//  1. List: one delta query over the drive (first run enumerates, later runs read changes from the saved link).
//     Each file becomes a 'file' Item: name, app (Word, Excel, PowerPoint, PDF…), folder, size, last change, Open link.
//     Folders are not Items. The newest maxFiles files are kept.
//  2. Read: only files that look like a bill, receipt, ticket or booking by name or folder (never identity documents),
//     recent and small, are downloaded into memory, turned into text on the device (file-text.js), and run through the
//     same rules as email bodies. The facts (amount, due date, reference) are kept; the text and the file are discarded.
//     A file that is a bill with a due date still ahead becomes a bill, unless a bill with the same amount is already due.
(function (root) {
  'use strict';
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const DAY = 86400000;
  const SELECT = 'id,name,file,folder,package,size,lastModifiedDateTime,createdDateTime,webUrl,parentReference,deleted,cTag,eTag';
  const READ_NAME = /(invoice|faktur|receipt|účtenk|uctenk|\bbill\b|vyúčtován|vyuctovan|statement|výpis|vypis|ticket|jízdenk|jizdenk|letenk|boarding|booking|rezervac|reservation|\border\b|objednávk|objednavk|pojist|insurance|daňov|danov|tax invoice|nájem|najem|rent|předpis|predpis|záloh|zaloh|platb|payment|zaplacen)/i;
  const NEVER_READ = /(passport|cestovní pas|\bpas\b|id card|identity|občansk|obcansk|driving licen|řidičsk|ridicsk|birth cert|rodný list|rodny list|\bvisa\b|víz|residence permit|povolení k pobytu|povoleni k pobytu|payslip|výplatn|vyplatn|medical|lékař|lekar|zdravot|diagnos)/i;
  const APP = [[/\.(docx?|odt|rtf)$/i, 'Word'], [/\.(xlsx?|ods|csv)$/i, 'Excel'], [/\.(pptx?|odp)$/i, 'PowerPoint'], [/\.pdf$/i, 'PDF'], [/\.one$/i, 'OneNote'], [/\.(jpe?g|png|heic|gif|webp)$/i, 'Photo'], [/\.(mp4|mov|avi)$/i, 'Video'], [/\.(txt|md)$/i, 'Text']];
  const appOf = (name) => (APP.find(([rx]) => rx.test(name || '')) || [null, 'File'])[1];
  const folderOf = (it) => String((it.parentReference && it.parentReference.path) || '').replace(/^\/drive(s\/[^/]+)?\/root:?/, '') || '/';

  function createOneDrive(o) {
    const now = o.now || (() => Date.now());
    const doFetch = o.fetch || ((u, i) => root.fetch(u, i));
    const graph = o.graph, store = o.store, R = o.rules;
    const cfg = Object.assign({ maxFiles: 3000, readPerSync: 8, readMaxBytes: 10 * 1024 * 1024, readMaxAgeDays: 365, readContents: true }, o.config || {});
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const G = root.DaylightItemGraph || o.itemGraphApi;
    const helper = o.mailHelper || null; // createMailPipeline(...) helpers: recordFromMeta + bodyDecide

    async function call(url, init, raw) {
      for (let attempt = 0; ; attempt++) {
        const auth = raw ? {} : { Authorization: 'Bearer ' + await o.getToken(attempt > 0) };
        let r; try { r = await doFetch(url, Object.assign({}, init || {}, { headers: Object.assign(auth, (init && init.headers) || {}) })); } catch { if (attempt < 2) { await sleep(500); continue; } return { ok: false, status: 0 }; }
        if (r.status === 401 && attempt === 0 && !raw) continue;
        if ((r.status === 429 || r.status === 503) && attempt < 3) { await sleep(Math.min(30, Number(r.headers.get('Retry-After')) || 2 ** attempt) * 1000); continue; }
        if (!r.ok) return { ok: false, status: r.status };
        return { ok: true, status: r.status, r };
      }
    }

    function fileItem(acct, f) {
      const key = `onedrive:${acct}:${f.id}`;
      return { key, accountId: acct, type: 'file', title: f.name, description: folderOf(f), createdAt: Date.parse(f.lastModifiedDateTime || f.createdDateTime || '') || now(),
        sources: [{ app: 'onedrive', accountId: acct, itemId: f.id, url: f.webUrl || null, role: 'primary' }], aiExclude: true, privacyClass: 'normal',
        meta: { app: appOf(f.name), mimeType: (f.file && f.file.mimeType) || null, size: f.size || 0, folder: folderOf(f), modifiedAt: Date.parse(f.lastModifiedDateTime || '') || null, tag: f.cTag || f.eTag || null } };
    }
    const wantsRead = (f) => cfg.readContents && !NEVER_READ.test(f.name + ' ' + folderOf(f)) && READ_NAME.test(f.name + ' ' + folderOf(f)) && (f.size || 0) <= cfg.readMaxBytes && (now() - (Date.parse(f.lastModifiedDateTime || '') || 0)) <= cfg.readMaxAgeDays * DAY && root.DaylightFileText && root.DaylightFileText.kindOf(f.name, f.file && f.file.mimeType);

    /** Text → facts with the same rules as an email body (file name as subject). */
    function factsFromText(f, text) {
      if (!helper || !R) return null;
      const subject = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ');
      const headers = [{ name: 'From', value: 'OneDrive <files@onedrive.invalid>' }, { name: 'Subject', value: subject }];
      const meta = { id: f.id, threadId: f.id, labelIds: ['ONEDRIVE'], snippet: text.slice(0, 200), internalDate: String(Date.parse(f.lastModifiedDateTime || '') || now()), payload: { mimeType: 'text/plain', headers } };
      const b = R.stageB(meta, { cfg: o.pipelineConfig || {} });
      const rec = helper.recordFromMeta(meta, b, null);
      const full = Object.assign({}, meta, { payload: { mimeType: 'text/plain', headers, body: { data: b64url(text) } } });
      const d = helper.bodyDecide(rec, full);
      return { category: d.category, confidence: d.confidence, facts: d.c.facts || {}, keyDates: rec.keyDates || [] };
    }
    function b64url(s) { const bytes = new TextEncoder().encode(String(s || '')); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

    async function sync(acct) {
      const t0 = now();
      const linkKey = 'daylight-onedrive-delta:' + acct;
      let link = store.get(linkKey);
      const report = { provider: 'onedrive', ok: true, listed: 0, added: 0, removed: 0, read: 0, readFailed: 0, bills: 0, skippedOld: 0, requests: 0, resync: false };
      let url = link || `${GRAPH}/me/drive/root/delta?$select=${SELECT}&$top=200`;
      const seen = [], gone = [];
      for (let page = 0; page < 200; page++) {
        const r = await call(url); report.requests++;
        if (!r.ok) {
          if (r.status === 410 && link) { report.resync = true; link = null; url = `${GRAPH}/me/drive/root/delta?$select=${SELECT}&$top=200`; continue; }
          report.ok = false; report.error = r.status; break;
        }
        const data = await r.r.json();
        (data.value || []).forEach((f) => { if (f.deleted) gone.push(f.id); else if (f.file && !f.folder && !f.package) seen.push(f); });
        if (data['@odata.deltaLink']) { link = data['@odata.deltaLink']; break; }
        if (!data['@odata.nextLink']) break;
        url = data['@odata.nextLink'];
      }
      report.listed = seen.length;
      if (report.ok && report.resync) {
        // a full re-enumeration: files that are no longer listed were deleted while the link was stale
        const listed = new Set(seen.map((f) => f.id));
        (await graph.query({ accountId: acct, type: 'file' })).forEach((it) => { const id = it.sources[0].itemId; if (!listed.has(id)) gone.push(id); });
      }
      // newest first, capped
      seen.sort((a, b) => (Date.parse(b.lastModifiedDateTime) || 0) - (Date.parse(a.lastModifiedDateTime) || 0));
      const keep = seen.slice(0, cfg.maxFiles); report.skippedOld = seen.length - keep.length;
      const prev = new Map((await graph.query({ accountId: acct, type: 'file' })).map((it) => [it.key, it]));
      const items = keep.map((f) => fileItem(acct, f));
      // contents: changed or never-read files that look like a bill / receipt / ticket
      const toRead = keep.filter((f) => wantsRead(f) && (prev.get(`onedrive:${acct}:${f.id}`)?.meta?.readTag !== (f.cTag || f.eTag || f.lastModifiedDateTime))).slice(0, cfg.readPerSync);
      const derived = [];
      const existingBills = (await graph.query({ type: 'bill' })).filter((b) => b.status !== 'dismissed');
      for (const f of toRead) {
        const it = items.find((x) => x.key === `onedrive:${acct}:${f.id}`);
        try {
          const meta = await call(`${GRAPH}/me/drive/items/${encodeURIComponent(f.id)}?$select=id,@microsoft.graph.downloadUrl`); report.requests++;
          if (!meta.ok) throw new Error('item ' + meta.status);
          const dl = (await meta.r.json())['@microsoft.graph.downloadUrl'];
          if (!dl) throw new Error('no download url');
          const got = await call(dl, {}, true); report.requests++; // pre-authenticated, short-lived URL: no token sent, never stored
          if (!got.ok) throw new Error('download ' + got.status);
          const bytes = await got.r.arrayBuffer();
          const t = await root.DaylightFileText.extract({ bytes, name: f.name, mimeType: f.file && f.file.mimeType }, o.fileTextOptions);
          const res = t.text ? factsFromText(f, t.text) : null;
          report.read++;
          it.meta.readTag = f.cTag || f.eTag || f.lastModifiedDateTime; it.meta.readAt = now(); it.meta.textKind = t.kind; it.meta.pages = t.pages || null;
          if (res) {
            const ff = res.facts; const due = ff.dueDate && typeof ff.dueDate === 'object' ? ff.dueDate.date : ff.dueDate;
            const amount = ff.amount || (ff.totalPaymentDue != null ? { value: Number(ff.totalPaymentDue), currency: ff.priceCurrency || null } : null);
            const ref = ff.reservationNumber || ff.orderNumber || ff.reference || null;
            const srcId = G.itemId(it.key);
            it.meta.docKind = res.category; it.privacyClass = ['bill', 'payment', 'receipt', 'refund', 'subscription'].includes(res.category) ? 'financial' : 'normal';
            it.extractedFacts = [['amount', amount && amount.value], ['currency', amount && amount.currency], ['dueDate', due], ['reference', ref], ['merchant', ff.merchant], ['kind', res.category]].filter(([, v]) => v != null && v !== '').map(([key, value]) => ({ key, value, sourceItemId: srcId, method: 'file-text' }));
            const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due || ''));
            const dueMs = dm ? new Date(+dm[1], +dm[2] - 1, +dm[3], 23, 59).getTime() : null;
            if (res.category === 'bill' && amount && amount.value != null && dueMs && dueMs >= new Date(now()).setHours(0, 0, 0, 0)) {
              const same = existingBills.some((b) => { const a = (b.extractedFacts || []).filter((x) => x.key === 'amount').pop(); const c = (b.extractedFacts || []).filter((x) => x.key === 'currency').pop(); return a && Math.abs(Number(a.value) - amount.value) < 0.01 && (!c || !amount.currency || c.value === amount.currency) && b.dueAt && Math.abs(b.dueAt - dueMs) <= 7 * DAY; });
              if (!same) {
                derived.push({ key: `money:${acct}:file:${f.id}`, accountId: acct, type: 'bill', title: `${ff.merchant || f.name.replace(/\.[a-z0-9]+$/i, '')} · ${amount.value}${amount.currency ? ' ' + amount.currency : ''}`, description: f.name, dueAt: dueMs, createdAt: Date.parse(f.lastModifiedDateTime || '') || now(), datedBySource: true,
                  sources: [{ app: 'onedrive', accountId: acct, itemId: f.id, url: f.webUrl || null, role: 'evidence' }], privacyClass: 'financial', aiExclude: true,
                  extractedFacts: it.extractedFacts.slice(), meta: { category: 'bill', fromFile: true } });
                report.bills++;
              }
            }
          }
        } catch (e) { report.readFailed++; it.meta.readError = String(e && e.message || e).slice(0, 80); }
      }
      // keep facts from earlier reads of unchanged files
      items.forEach((it) => { const p = prev.get(it.key); if (p && p.meta && p.meta.readTag && !it.meta.readTag && p.meta.tag === it.meta.tag) { it.meta.readTag = p.meta.readTag; it.meta.docKind = p.meta.docKind; it.meta.readAt = p.meta.readAt; it.extractedFacts = p.extractedFacts; it.privacyClass = p.privacyClass; } });
      await graph.upsertMany([...items, ...derived]);
      for (const id of [...new Set(gone)]) report.removed += await graph.removeSourceItem('onedrive', acct, id);
      report.added = items.filter((x) => !prev.has(x.key)).length;
      if (report.ok && link) store.set(linkKey, link);
      report.ms = now() - t0;
      return report;
    }
    return { sync, appOf, wantsRead, fileItem };
  }
  const api = { createOneDrive, appOf, READ_NAME, NEVER_READ };
  root.DaylightOneDrive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
