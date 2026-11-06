/** Mock Microsoft Graph (mail delta per folder, $batch bodies, OneDrive delta + content). Synthetic data only.
 *  Behaves like Graph where Daylight depends on it: immutable IDs, @removed entries, nextLink → deltaLink paging,
 *  410 for an expired delta link, Retry-After on 429, $batch of at most 20, Prefer header checks. */
'use strict';
function createMockGraph(o) {
  const opt = o || {};
  const folders = { inbox: new Map(), sentitems: new Map(), archive: opt.noArchive ? null : new Map() };
  const bodies = new Map();
  const log = []; let version = 1; const changes = []; // {v, folder, id, removed}
  const expired = new Set(); const throttleNext = { batch: 0, delta: 0 };
  const drive = new Map(); const driveChanges = []; let driveVersion = 1; const contents = new Map();
  const stats = { requests: 0, batches: 0, batchSizes: [], bodies: 0, deltas: 0, contentDownloads: 0, immutableHeader: 0, tokens: new Set() };
  function add(folder, m, body) { const msg = Object.assign({ isRead: false, isDraft: false, inferenceClassification: 'focused', categories: [], hasAttachments: false }, m); msg.webLink = msg.webLink || `https://outlook.live.com/owa/?ItemID=${encodeURIComponent(msg.id)}&exvsurl=1&viewmodel=ReadMessageItem`; folders[folder].set(msg.id, msg); if (body) bodies.set(msg.id, body); changes.push({ v: ++version, folder, id: msg.id }); return msg; }
  function remove(folder, id) { folders[folder].delete(id); changes.push({ v: ++version, folder, id, removed: true }); }
  function update(folder, id, patch) { Object.assign(folders[folder].get(id), patch); changes.push({ v: ++version, folder, id }); }
  function move(from, to, id) { const m = folders[from].get(id); folders[from].delete(id); folders[to].set(id, m); changes.push({ v: ++version, folder: from, id, removed: true }); changes.push({ v: ++version, folder: to, id }); }
  function addFile(item, content) { const it = Object.assign({ file: { mimeType: item.mimeType || 'application/pdf' }, parentReference: { path: '/drive/root:/Documents' }, webUrl: 'https://onedrive.live.com/?id=' + item.id, createdBy: { user: { displayName: 'Me' } } }, item); delete it.mimeType; drive.set(it.id, it); if (content != null) contents.set(it.id, content); driveChanges.push({ v: ++driveVersion, id: it.id }); return it; }
  function removeFile(id) { drive.delete(id); driveChanges.push({ v: ++driveVersion, id, deleted: true }); }
  const json = (status, body, headers) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (headers || {})[k] || (headers || {})[k.toLowerCase()] || null }, json: async () => body, arrayBuffer: async () => body });
  const pick = (m, sel) => { const out = { id: m.id }; sel.split(',').forEach((k) => { if (m[k] !== undefined) out[k] = m[k]; }); return out; };
  function deltaPage(folder, url) {
    const u = new URL(url);
    if (!folders[folder]) return json(404, { error: { code: 'ErrorFolderNotFound' } });
    const dt = u.searchParams.get('$deltatoken'), sk = u.searchParams.get('$skiptoken');
    if (dt && expired.has(dt)) return json(410, { error: { code: 'SyncStateNotFound', message: 'resyncRequired' } });
    const sel = u.searchParams.get('$select') || (dt || sk ? JSON.parse(Buffer.from((dt || sk).split('.')[1], 'base64url').toString()).sel : '');
    const filter = u.searchParams.get('$filter') || (dt || sk ? JSON.parse(Buffer.from((dt || sk).split('.')[1], 'base64url').toString()).filter : '');
    const since = dt ? parseInt(dt.split('.')[0].slice(1), 10) : null;
    let list;
    if (since != null) {
      const seen = new Map(); changes.filter((c) => c.folder === folder && c.v > since).forEach((c) => seen.set(c.id, c));
      list = [...seen.values()].map((c) => c.removed ? { id: c.id, '@removed': { reason: 'deleted' } } : pick(folders[folder].get(c.id) || { id: c.id }, sel));
    } else {
      const ge = /receivedDateTime ge (\S+)/.exec(filter || ''); const min = ge ? Date.parse(ge[1]) : 0;
      list = [...folders[folder].values()].filter((m) => Date.parse(m.receivedDateTime) >= min).map((m) => pick(m, sel));
    }
    const off = sk ? Number(sk.split('.')[0].slice(1)) : 0; const size = opt.pageSize || 3;
    const page = list.slice(off, off + size);
    const st = Buffer.from(JSON.stringify({ sel, filter })).toString('base64url');
    const base = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta`;
    const out = { value: page };
    if (off + size < list.length) out['@odata.nextLink'] = `${base}?$skiptoken=s${off + size}.${st}${since != null ? '&$deltatoken=' + dt : ''}`;
    else out['@odata.deltaLink'] = `${base}?$deltatoken=d${version}-${folder}.${st}`;
    if (since != null && off + size < list.length) out['@odata.nextLink'] = `${base}?$deltatoken=${dt}&$skiptoken=s${off + size}.${st}`;
    return json(200, out);
  }
  function driveDelta(url) {
    const u = new URL(url); const tok = u.searchParams.get('token');
    if (tok && expired.has(tok)) return json(410, { error: { code: 'resyncRequired' } });
    const since = tok ? Number(tok.slice(1)) : null;
    const ids = since != null ? [...new Set(driveChanges.filter((c) => c.v > since).map((c) => c.id))] : [...drive.keys()];
    const value = ids.map((id) => drive.get(id) || { id, deleted: { state: 'deleted' } });
    return json(200, { value, '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/drive/root/delta?token=t${driveVersion}` });
  }
  async function fetch(url, init) {
    const u = String(url); const h = (init && init.headers) || {}; stats.requests++;
    log.push({ url: u, method: (init && init.method) || 'GET', prefer: h.Prefer || '' });
    if (u.startsWith('https://mockdl.files.1drv.com/')) { // pre-authenticated download URL: must be fetched WITHOUT a token
      stats.contentDownloads++; if (h.Authorization) stats.tokenSentToDownload = true;
      const id = decodeURIComponent(u.split('/').pop().split('?')[0]); if (!contents.has(id)) return json(404, {});
      const c = contents.get(id); const buf = typeof c === 'string' ? new TextEncoder().encode(c) : c;
      return json(200, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    const auth = String(h.Authorization || ''); stats.tokens.add(auth);
    if (!/^Bearer \S+/.test(auth)) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    if (opt.rejectToken && opt.rejectToken(auth)) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    if (/IdType="ImmutableId"/.test(h.Prefer || '')) stats.immutableHeader++;
    let m;
    if ((m = /\/me\/mailFolders\/(\w+)\/messages\/delta/.exec(u))) {
      stats.deltas++;
      if (throttleNext.delta > 0) { throttleNext.delta--; return json(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '1' }); }
      return deltaPage(m[1], u);
    }
    if (u === 'https://graph.microsoft.com/v1.0/$batch') {
      stats.batches++;
      if (throttleNext.batch > 0) { throttleNext.batch--; return json(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '2' }); }
      const req = JSON.parse(init.body).requests; stats.batchSizes.push(req.length);
      if (req.length > 20) return json(400, { error: { code: 'BadRequest', message: 'max 20' } });
      const responses = req.map((r) => {
        const mm = /\/me\/messages\/([^?]+)\?\$select=body,internetMessageHeaders/.exec(r.url);
        if (!mm) return { id: r.id, status: 400, body: {} };
        const id = decodeURIComponent(mm[1]); const b = bodies.get(id);
        const exists = Object.values(folders).some((f) => f && f.has(id));
        if (!exists) return { id: r.id, status: 404, body: { error: { code: 'ErrorItemNotFound' } } };
        stats.bodies++;
        return { id: r.id, status: 200, body: { id, body: { contentType: b && b.html ? 'html' : 'text', content: b ? (b.html || b.text) : '' }, internetMessageHeaders: (b && b.headers) || [] } };
      });
      return json(200, { responses });
    }
    if (/\/me\/drive\/root\/delta/.test(u)) return driveDelta(u);
    if ((m = /\/me\/drive\/items\/([^/?]+)\?\$select=id,@microsoft\.graph\.downloadUrl/.exec(u))) { const id = decodeURIComponent(m[1]); if (!drive.has(id)) return json(404, {}); return json(200, { id, '@microsoft.graph.downloadUrl': 'https://mockdl.files.1drv.com/' + encodeURIComponent(id) + '?tempauth=x' }); }
    if ((m = /\/me\/drive\/items\/([^/]+)\/content/.exec(u))) {
      const id = decodeURIComponent(m[1]); if (!contents.has(id)) return json(404, {});
      stats.contentDownloads++;
      const c = contents.get(id); const buf = typeof c === 'string' ? new TextEncoder().encode(c) : c;
      return json(200, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    return json(404, { error: { code: 'NotFound', url: u } });
  }
  return { fetch, add, remove, update, move, addFile, removeFile, folders, drive, log, stats, expire: (t) => expired.add(t), throttle: (k, n) => { throttleNext[k] = n; }, version: () => version };
}
module.exports = { createMockGraph };
