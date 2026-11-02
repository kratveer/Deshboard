/**
 * Daylight document scan pipeline
 * Web: camera → crop → OCR/heuristic + BarcodeDetector → structure → confirm
 * Native later: Capacitor + ML Kit OCR/barcode + AI extraction
 */
(function (root) {
  const KIND_RULES = [
    { kind: 'tickets', re: /\b(boarding|flight|train|ticket|gate|seat|pnr|reservation|bahn|lufthansa|departure|arrival)\b/i },
    { kind: 'coupons', re: /\b(coupon|voucher|promo|% off|discount|gift card)\b/i },
    { kind: 'documents', re: /\b(invoice|contract|agreement|passport|visa|form|certificate|id card|legal)\b/i }
  ];

  function guessKind(text) {
    for (const rule of KIND_RULES) if (rule.re.test(text)) return rule.kind;
    return 'documents';
  }

  function guessTitle(text, fallback) {
    const line = String(text || '')
      .split(/\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 3 && s.length < 60);
    return (line || fallback || 'Scanned document').slice(0, 60);
  }

  function guessAmount(text) {
    const m = String(text || '').match(/(?:€|EUR|USD|\$|Kč|CZK)\s?[\d\s.,]+|\d[\d\s.,]*\s?(?:€|EUR|USD|\$|Kč|CZK)/i);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }

  function guessDate(text) {
    const m = String(text || '').match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s*\d{0,4})\b/i);
    return m ? m[0] : '';
  }

  function extractFlight(text) {
    const t = String(text || '');
    const flight = (t.match(/\b([A-Z]{2})\s?(\d{2,4})\b/) || [])[0] || '';
    const route =
      (t.match(/\b([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})\b/i) || []).slice(1, 3) ||
      [];
    const fromCity = (t.match(/\bfrom\s+([A-Za-zÀ-ž ]{3,24})/i) || [])[1] || '';
    const toCity = (t.match(/\bto\s+([A-Za-zÀ-ž ]{3,24})/i) || [])[1] || '';
    const seat = (t.match(/\bseat\s*([A-Z]?\d{1,2}[A-Z]?)\b/i) || [])[1] || '';
    const gate = (t.match(/\bgate\s*([A-Z]?\d{1,3}[A-Z]?)\b/i) || [])[1] || '';
    const coach = (t.match(/\b(?:coach|wagon|car)\s*([A-Z0-9]{1,4})\b/i) || [])[1] || '';
    const pnr = (t.match(/\b(?:PNR|booking(?:\s*ref(?:erence)?)?|confirmation)\s*[:#]?\s*([A-Z0-9]{5,8})\b/i) || [])[1] || '';
    const depart = (t.match(/\b(?:depart(?:ure)?|dep\.?)\s*[:.]?\s*([0-2]?\d[:.][0-5]\d)/i) || [])[1] || '';
    const arrive = (t.match(/\b(?:arriv(?:al|e)?|arr\.?)\s*[:.]?\s*([0-2]?\d[:.][0-5]\d)/i) || [])[1] || '';
    const from = (route[0] || fromCity || '').toUpperCase();
    const to = (route[1] || toCity || '').toUpperCase();
    if (!flight && !from && !to && !seat && !pnr) return null;
    return {
      flight: flight.replace(/\s+/g, ''),
      from,
      to,
      seat: seat.toUpperCase(),
      gate: gate.toUpperCase(),
      coach: coach.toUpperCase(),
      pnr: pnr.toUpperCase(),
      depart,
      arrive
    };
  }

  function extractBarcodeHint(text) {
    const t = String(text || '');
    const candidates = [
      (t.match(/\b(?:PNR|booking(?:\s*ref)?|confirmation|ticket\s*(?:no|number|#)?|member\s*#?)\s*[:#]?\s*([A-Z0-9-]{5,20})\b/i) || [])[1],
      (t.match(/\b([0-9]{8,18})\b/) || [])[1],
      (t.match(/\b([A-Z0-9]{10,22})\b/) || [])[1]
    ].filter(Boolean);
    return candidates[0] || '';
  }

  function extractPassMeta(text, kind) {
    const t = String(text || '');
    const number =
      (t.match(/\b(?:member|card|ticket|pass)\s*(?:no|number|#)?\s*[:#]?\s*([A-Z0-9-]{3,16})\b/i) || [])[1] ||
      extractBarcodeHint(t);
    const expiry =
      (t.match(/\b(?:expir(?:y|es|ation)|valid\s+until|until)\s*[:.]?\s*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s*\d{0,4})\b/i) || [])[1] ||
      guessDate(t);
    const since =
      (t.match(/\b(?:member\s+since|issued|since)\s*[:.]?\s*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s*\d{0,4})\b/i) || [])[1] ||
      '';
    const orgLine = t
      .split(/\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 2 && s.length < 40 && !/seat|gate|flight|total|amount/i.test(s));
    return {
      org: kind === 'tickets' ? orgLine || 'Travel pass' : orgLine || 'Daylight Pass',
      number: number ? (String(number).startsWith('#') ? String(number) : '#' + String(number)) : '',
      memberSince: since,
      expiry,
      typeLabel: kind === 'tickets' ? 'Boarding pass' : kind === 'coupons' ? 'Coupon' : kind === 'others' ? 'Membership' : 'Document'
    };
  }

  async function detectBarcodes(imageDataUrl) {
    if (!imageDataUrl || typeof createImageBitmap === 'undefined') return [];
    if (typeof BarcodeDetector === 'undefined') return [];
    try {
      const detector = new BarcodeDetector({
        formats: ['qr_code', 'pdf417', 'aztec', 'data_matrix', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e']
      });
      const res = await fetch(imageDataUrl);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const codes = await detector.detect(bitmap);
      try { bitmap.close?.(); } catch {}
      return (codes || []).map((c) => ({
        format: c.format || 'qr_code',
        rawValue: String(c.rawValue || '').trim()
      })).filter((c) => c.rawValue);
    } catch (e) {
      console.warn('BarcodeDetector', e);
      return [];
    }
  }

  function qrImageUrl(payload, size) {
    const s = size || 200;
    return 'https://api.qrserver.com/v1/create-qr-code/?size=' + s + 'x' + s + '&margin=8&data=' + encodeURIComponent(payload);
  }

  function barcodeImageUrl(payload) {
    return 'https://bwipjs-api.metafloor.com/?bcid=code128&text=' + encodeURIComponent(payload) + '&scale=3&includetext&guardwhitespace';
  }

  async function webExtract(imageDataUrl, hintText) {
    const barcodes = await detectBarcodes(imageDataUrl);
    const primary = barcodes[0];
    const text = String(hintText || primary?.rawValue || '').trim();
    const kind = guessKind(text + ' ' + (primary?.rawValue || ''));
    const flight = extractFlight(text);
    const meta = extractPassMeta(text, kind);
    const codeValue = primary?.rawValue || extractBarcodeHint(text) || (flight && flight.pnr) || '';
    const codeFormat = primary?.format || (codeValue ? 'qr_code' : '');
    let title = guessTitle(text, kind === 'tickets' ? 'Travel ticket' : kind === 'coupons' ? 'Coupon' : 'Scanned document');
    if (flight && (flight.from || flight.to)) title = [flight.from, flight.to].filter(Boolean).join(' → ') || title;
    if (flight && flight.flight && !/→/.test(title)) title = flight.flight + (title ? ' · ' + title : '');

    return {
      engine: barcodes.length ? 'web+barcode-detector' : 'web-heuristic',
      image: imageDataUrl,
      ocrText: text,
      kind,
      title: title.slice(0, 60),
      amount: guessAmount(text),
      date: guessDate(text) || meta.expiry || '',
      note: text ? text.split(/\n/).filter(Boolean).slice(0, 2).join(' · ').slice(0, 80) : 'Confirm details before saving',
      confidence: barcodes.length ? 0.85 : text ? 0.55 : 0.2,
      barcodes,
      barcode: codeValue,
      barcodeFormat: codeFormat,
      qrPayload: codeValue,
      qrImage: codeValue ? qrImageUrl(codeValue, 220) : '',
      barcodeImage: codeValue && /code|ean|upc/i.test(codeFormat || '') ? barcodeImageUrl(codeValue) : (codeValue ? barcodeImageUrl(codeValue) : ''),
      flight,
      pass: meta
    };
  }

  async function run(imageDataUrl, opts = {}) {
    if (root.DaylightScanNative && typeof root.DaylightScanNative.extract === 'function') {
      return root.DaylightScanNative.extract({
        image: imageDataUrl,
        preferEdgeDetect: true,
        ocr: 'mlkit',
        barcode: true,
        structure: 'ai'
      });
    }
    return webExtract(imageDataUrl, opts.hintText || '');
  }

  async function ensureCameraPermission() {
    if (root.DaylightScanNative && typeof root.DaylightScanNative.requestCamera === 'function') {
      return root.DaylightScanNative.requestCamera();
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return { granted: false, reason: 'unsupported' };
    }
    try {
      if (navigator.permissions?.query) {
        const st = await navigator.permissions.query({ name: 'camera' }).catch(() => null);
        if (st?.state === 'denied') return { granted: false, reason: 'denied' };
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } }
      });
      stream.getTracks().forEach((t) => t.stop());
      return { granted: true };
    } catch (e) {
      return { granted: false, reason: e?.name || 'error' };
    }
  }

  root.DaylightScan = {
    run,
    ensureCameraPermission,
    guessKind,
    webExtract,
    detectBarcodes,
    qrImageUrl,
    barcodeImageUrl,
    extractFlight,
    extractPassMeta
  };
})(typeof window !== 'undefined' ? window : globalThis);
