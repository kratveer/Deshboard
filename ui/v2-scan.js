/**
 * Daylight — Wallet scanner (Wallet → Add → Scan a ticket or card).
 * Camera or photo → scan-pipeline.js (DaylightScan) reads text and codes → the user confirms the fields → the pass is
 * saved on this device (localStorage daylight-wallet) and the local connector turns it into a Wallet Item.
 * Everything stays on this device: the picture, the text and any code. Codes are read by the browser's own BarcodeDetector
 * (or the native app's scanner) and later drawn locally by ui/codes.js; no value is sent to an image or decoding service.
 * A QR or barcode is kept only when it was really detected in the picture; codes are never invented from text.
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const COLORS = { tickets: ['#1f6feb', '#0b3d91'], coupons: ['#d9480f', '#a33b0a'], documents: ['#2f9e44', '#1b6b2e'], others: ['#7048e8', '#4c2db3'] };
  const LABEL = { tickets: 'Ticket', coupons: 'Coupon', documents: 'Document', others: 'Pass' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const X = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const BACK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';

  let el = null, stream = null, draft = null, extract = null, opts = {};

  function readWallet() { try { const v = JSON.parse(root.localStorage.getItem('daylight-wallet') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  function saveWallet(list) { root.localStorage.setItem('daylight-wallet', JSON.stringify(list.slice(0, 80))); }

  function build(host) {
    el = doc.createElement('div');
    el.className = 'v-scan';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Scan to Wallet');
    el.innerHTML = `
      <section data-step="landing">
        <div class="v-scan-top"><button class="v-scan-round" type="button" data-scan-close aria-label="Close">${X}</button></div>
        <div class="v-scan-body"><div class="v-scan-hero" aria-hidden="true"></div><h2>Scan a ticket, card or document</h2><p>Choose a place with good light. Daylight keeps the picture on this device.</p></div>
        <div class="v-scan-foot"><button class="v-scan-cta" type="button" data-scan-start>Use the camera</button><button class="v-scan-cta ghost" type="button" data-scan-pick>Choose a photo</button></div>
      </section>
      <section data-step="camera" hidden>
        <div class="v-scan-top"><button class="v-scan-round" type="button" data-scan-back aria-label="Back">${BACK}</button></div>
        <div class="v-scan-view"><video playsinline autoplay muted></video><div class="v-scan-frame"></div></div>
        <div class="v-scan-foot"><button class="v-scan-shot" type="button" data-scan-capture aria-label="Take picture"></button></div>
      </section>
      <section data-step="process" hidden>
        <div class="v-scan-body"><div class="v-scan-spin" aria-hidden="true"></div><h2>Reading…</h2><p>Finding text and codes in the picture.</p></div>
      </section>
      <section data-step="review" hidden>
        <div class="v-scan-top"><button class="v-scan-round" type="button" data-scan-back aria-label="Back">${BACK}</button><b>Confirm details</b><span style="width:40px"></span></div>
        <form class="v-scan-form" data-scan-form>
          <img data-scan-preview alt="Scanned picture">
          <span class="v-scan-badge" data-scan-engine></span>
          <label>Title<input name="title" maxlength="60" required></label>
          <div class="v-scan-grid">
            <label>Type<select name="kind"><option value="documents">Document</option><option value="tickets">Ticket</option><option value="coupons">Coupon</option><option value="others">Other pass</option></select></label>
            <label>Date<input name="date" maxlength="40" placeholder="Optional"></label>
          </div>
          <div class="v-scan-grid">
            <label>Amount<input name="amount" maxlength="24" placeholder="Optional"></label>
            <label>Note<input name="note" maxlength="80" placeholder="Optional"></label>
          </div>
          <label>Text found<textarea name="ocr" rows="3" placeholder="Edit if needed"></textarea></label>
          <div class="v-scan-actions"><button class="v-scan-cta ghost" type="button" data-scan-retake>Retake</button><button class="v-scan-cta" type="submit">Add to Wallet</button></div>
        </form>
      </section>
      <canvas hidden></canvas><input type="file" accept="image/*" capture="environment" hidden>`;
    host.appendChild(el);
    el.addEventListener('click', onClick);
    el.querySelector('[data-scan-form]').addEventListener('submit', (e) => { e.preventDefault(); save(); });
    el.querySelector('input[type=file]').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => process(String(r.result || ''), (f.name || '').replace(/\.[^.]+$/, ''));
      r.readAsDataURL(f); e.target.value = '';
    });
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el && el.classList.contains('on')) close(); });
  }
  const $ = (s) => el.querySelector(s);
  function step(name) { el.querySelectorAll('[data-step]').forEach((s) => { s.hidden = s.dataset.step !== name; }); el.dataset.at = name; }
  function notify(msg) { try { root.DaylightV2UI && root.DaylightV2UI.toast ? root.DaylightV2UI.toast(msg) : console.info(msg); } catch {} }

  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-scan-close')) return close();
    if (t.hasAttribute('data-scan-back')) { stopCamera(); return step('landing'); }
    if (t.hasAttribute('data-scan-start')) return startCamera();
    if (t.hasAttribute('data-scan-pick')) return $('input[type=file]').click();
    if (t.hasAttribute('data-scan-capture')) return capture();
    if (t.hasAttribute('data-scan-retake')) { draft = null; extract = null; return step('landing'); }
  }

  function open(o) {
    opts = o || {};
    if (!el || !el.isConnected) build(opts.host || doc.getElementById('v2') || doc.body);
    draft = null; extract = null;
    step('landing');
    el.classList.add('on');
    const b = $('[data-scan-start]'); if (b) b.focus();
  }
  function close() { if (!el) return; stopCamera(); draft = null; extract = null; el.classList.remove('on'); }
  function stopCamera() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } const v = el && $('video'); if (v) v.srcObject = null; }

  async function startCamera() {
    const S = root.DaylightScan;
    const perm = S ? await S.ensureCameraPermission() : { granted: true };
    if (!perm.granted && perm.reason !== 'unsupported') { notify('Camera not allowed · choose a photo instead'); $('input[type=file]').click(); return; }
    step('camera');
    try {
      stream = await root.navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      const v = $('video'); v.srcObject = stream; await v.play().catch(() => {});
    } catch {
      step('landing'); notify('Camera unavailable · choose a photo instead'); $('input[type=file]').click();
    }
  }
  function capture() {
    const v = $('video'), c = $('canvas'); if (!v) return;
    const w = v.videoWidth || 1280, h = v.videoHeight || 720;
    const sx = Math.round(w * 0.1), sy = Math.round(h * 0.14), sw = Math.round(w * 0.8), sh = Math.round(h * 0.72);
    c.width = sw; c.height = sh; c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    let data = ''; try { data = c.toDataURL('image/jpeg', 0.78); } catch { notify('Could not take the picture'); return; }
    stopCamera(); process(data, '');
  }
  async function process(dataUrl, hint) {
    step('process');
    let x;
    try {
      x = root.DaylightScan ? await root.DaylightScan.run(dataUrl, { hintText: hint })
        : { engine: 'web-heuristic', ocrText: hint || '', kind: 'documents', title: (hint || 'Scanned document').slice(0, 60), confidence: 0.2 };
    } catch { notify('Could not read the text · enter the details yourself'); x = { engine: 'web-heuristic', ocrText: '', kind: 'documents', title: 'Scanned document', confidence: 0 }; }
    x.image = x.image || dataUrl;
    review(x);
  }
  function review(x) {
    extract = x; draft = x.image;
    const f = $('[data-scan-form]');
    $('[data-scan-preview]').src = x.image;
    f.title.value = x.title || 'Scanned document';
    f.kind.value = COLORS[x.kind] ? x.kind : 'documents';
    f.date.value = x.date || ''; f.amount.value = x.amount || ''; f.note.value = x.note || ''; f.ocr.value = x.ocrText || '';
    const n = (x.barcodes || []).length;
    $('[data-scan-engine]').textContent = n ? `Found ${n} code${n > 1 ? 's' : ''} · check the details` : 'Check the details before saving';
    step('review');
  }
  /** Same pass shape as before, so passes scanned earlier and new ones are read the same way by the local connector. */
  function buildPass(f, ex) {
    const S = root.DaylightScan || {};
    const kind = f.kind.value || 'documents';
    const title = (f.title.value || 'Scanned document').trim().slice(0, 60);
    const amount = (f.amount.value || '').trim(), date = (f.date.value || '').trim(), ocr = (f.ocr.value || '').trim();
    const note = (f.note.value || '').trim() || [date, amount].filter(Boolean).join(' · ') || 'Added from scan';
    const flight = (S.extractFlight && S.extractFlight(ocr)) || ex.flight || null;
    const meta = (S.extractPassMeta && S.extractPassMeta(ocr, kind)) || ex.pass || {};
    const codes = (ex.barcodes || []).filter((b) => b && (b.rawValue || b.data || b.text));
    // a code counts only when a barcode/QR was really detected in the picture;
    // a booking reference read from the text is kept as text, never turned into a scannable code
    const code = String((codes[0] && (codes[0].rawValue || codes[0].data || codes[0].text)) || '');
    const format = code ? String(codes[0].format || 'qr_code').toLowerCase() : '';
    const authentic = !!code;
    const dateT = date ? Date.parse(date) : NaN;
    const item = {
      id: 'w' + Date.now() + Math.random().toString(36).slice(2, 7), title, kind, note, amount, date, ocr, at: new Date().toISOString(), image: draft,
      color: COLORS[kind], org: meta.org || '', typeLabel: meta.typeLabel || LABEL[kind],
      number: meta.number || '', memberSince: meta.memberSince || '', expiry: meta.expiry || date || '',
      travelAt: flight && flight.depart && /\d{4}-\d{2}-\d{2}/.test(String(flight.depart)) ? new Date(flight.depart).toISOString() : null,
      eventAt: isFinite(dateT) ? new Date(dateT).toISOString() : null,
      barcode: code, qrPayload: code, barcodeFormat: format, barcodes: codes.map((b) => ({ format: b.format || '', rawValue: String(b.rawValue || b.data || b.text || '') })),
      qrImage: '', barcodeImage: '', /* never stored: drawn locally from the value when shown */
      qrAuthentic: authentic, barcodeAuthentic: authentic, exactQr: authentic, scanSource: true,
      bookingRef: (flight && flight.pnr) || ex.reference || meta.number || '', flight
    };
    return item;
  }
  async function save() {
    if (!draft) { notify('Nothing to save'); return; }
    const item = buildPass($('[data-scan-form]'), extract || {});
    try { const list = readWallet(); list.unshift(item); saveWallet(list); }
    catch { notify('Not enough space on this device to save the picture'); return; }
    close();
    try { if (opts.onSaved) await opts.onSaved(item); } catch (e) { console.warn('scan saved', e); }
  }

  const api = { open, close, buildPass, isOpen: () => !!(el && el.classList.contains('on')) };
  root.DaylightV2Scan = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
