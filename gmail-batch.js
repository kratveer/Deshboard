// Daylight Gmail HTTP batch helper (v2).
// Packs up to 50 GETs into one multipart/mixed POST to https://gmail.googleapis.com/batch/gmail/v1.
// IMPORTANT: Google still charges every inner request its normal quota units — batching saves HTTP round trips,
// latency and connection overhead, not quota. Per-part failures are returned so the caller can retry them with
// the normal single-request backoff path.
(function (root) {
  'use strict';
  const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';

  /** requests: [{ id, path }] where path is e.g. '/gmail/v1/users/me/messages/ID?format=metadata' */
  function buildBatch(requests, boundary) {
    const b = boundary || ('batch_daylight_' + Math.random().toString(36).slice(2, 12));
    const parts = requests.map((r) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <item-${r.id}>\r\n\r\nGET ${r.path}\r\nAccept: application/json\r\n\r\n`);
    return { boundary: b, contentType: `multipart/mixed; boundary=${b}`, body: parts.join('') + `--${b}--\r\n` };
  }

  /** Parse a multipart/mixed batch response into Map(id → { status, data, reason, message, retryAfterMs }). */
  function parseBatch(text, contentType) {
    const out = new Map();
    const bm = /boundary="?([^";]+)"?/i.exec(contentType || '') || /^--([^\r\n]+)/.exec(text || '');
    if (!bm) return out;
    const boundary = bm[1];
    const chunks = String(text || '').split('--' + boundary).slice(1);
    for (const raw of chunks) {
      if (raw.startsWith('--')) break;
      const idm = /Content-ID:\s*<?(?:response-)?item-([^>\r\n]+)>?/i.exec(raw);
      const sm = /HTTP\/[\d.]+\s+(\d{3})/.exec(raw);
      if (!idm || !sm) continue;
      const status = +sm[1];
      const after = raw.slice(sm.index);
      const bodyStart = after.search(/\r?\n\r?\n/);
      const head = bodyStart >= 0 ? after.slice(0, bodyStart) : after;
      let body = bodyStart >= 0 ? after.slice(bodyStart).trim() : '';
      let data = null;
      try { data = body ? JSON.parse(body) : null; } catch { data = null; }
      const ra = /Retry-After:\s*(\d+)/i.exec(head);
      const err = data && data.error;
      out.set(idm[1], {
        status, ok: status >= 200 && status < 300, data: status < 300 ? data : null,
        reason: err?.errors?.[0]?.reason || err?.status || '', message: err?.message || '',
        retryAfterMs: ra ? +ra[1] * 1000 : null
      });
    }
    return out;
  }

  /**
   * Browser/Worker sender factory. post(url, {headers, body}) must return a fetch-like Response.
   * Returns send(batch) → { ok, status, data: Map | null, message }.
   */
  function createSender(post) {
    return async function send(batch) {
      const res = await post(BATCH_URL, { method: 'POST', headers: { 'Content-Type': batch.contentType }, body: batch.body });
      const status = res.status || 0;
      if (!res.ok) { let message = ''; try { message = (await res.text()).slice(0, 200); } catch {} return { ok: false, status, message, reason: status === 429 ? 'rateLimitExceeded' : '' }; }
      const text = await res.text();
      const ct = (res.headers && (res.headers.get ? res.headers.get('Content-Type') : res.headers['content-type'])) || '';
      return { ok: true, status, data: parseBatch(text, ct) };
    };
  }

  const api = { BATCH_URL, buildBatch, parseBatch, createSender };
  root.DaylightGmailBatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
