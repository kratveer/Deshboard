/**
 * Daylight document scan pipeline
 * --------------------------------
 * Web today: camera → crop frame → heuristic structure → confirm → Wallet card
 * Native later (Capacitor + React/TS + ML Kit):
 *   1) @capacitor/camera or Camera Preview for capture + OS permission prompts
 *   2) Document scanner / OpenCV-style edge detect + perspective warp
 *   3) @capacitor-mlkit/barcode-scanning or Google ML Kit Text Recognition for OCR
 *   4) Structured extraction via AI (AI Gateway / on-device) → confirm sheet
 *   5) Persist to Wallet via the same card shape below
 *
 * Bridge: window.DaylightScan.run(imageDataUrl) should return ExtractedDoc.
 * If a Capacitor plugin registers DaylightScanNative, it is preferred.
 */
(function (root) {
  const KIND_RULES = [
    { kind: 'tickets', re: /\b(boarding|flight|train|ticket|gate|seat|pnr|reservation|bahn|lufthansa)\b/i },
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

  /** Lightweight web stand-in until ML Kit OCR is wired through Capacitor. */
  async function webExtract(imageDataUrl, hintText) {
    const text = String(hintText || '').trim();
    const kind = guessKind(text);
    return {
      engine: 'web-heuristic',
      image: imageDataUrl,
      ocrText: text,
      kind,
      title: guessTitle(text, kind === 'tickets' ? 'Travel ticket' : kind === 'coupons' ? 'Coupon' : 'Scanned document'),
      amount: guessAmount(text),
      date: guessDate(text),
      note: text ? text.split(/\n/).slice(0, 2).join(' · ').slice(0, 80) : 'Confirm details before saving',
      confidence: text ? 0.55 : 0.2
    };
  }

  async function run(imageDataUrl, opts = {}) {
    if (root.DaylightScanNative && typeof root.DaylightScanNative.extract === 'function') {
      // Capacitor / ML Kit + AI path
      return root.DaylightScanNative.extract({
        image: imageDataUrl,
        preferEdgeDetect: true,
        ocr: 'mlkit',
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

  root.DaylightScan = { run, ensureCameraPermission, guessKind, webExtract };
})(typeof window !== 'undefined' ? window : globalThis);
