/**
 * DaylightData — canonical read adapter (Phase 13–14).
 *
 * Bridges IndexedDB (DaylightStore) + legacy localStorage sidecars without
 * destructive migration. Phase 14 adds travel identity: mailId join key,
 * mail:{mailId} wallet ids (+ optional #pass: child keys), idempotent normalize.
 *
 * Never invents dates, QR codes, or attachments. Does not log bodies/tokens.
 */
(function (root) {
  const LS = {
    orders: 'daylight-orders',
    wallet: 'daylight-wallet',
    extractions: 'daylight-ai-extractions',
    remindersStamp: 'daylight-ai-reminders',
    personalTasks: 'daylight-personal-tasks'
  };

  function readJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function localDayKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    if (isNaN(x)) return '';
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  function startOfLocalDay(d) {
    const x = d instanceof Date ? new Date(d) : new Date(d);
    if (isNaN(x)) return null;
    return new Date(x.getFullYear(), x.getMonth(), x.getDate());
  }

  function parseMaybeDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number' && Number.isFinite(v)) {
      const d = new Date(v);
      return isNaN(d) ? null : d;
    }
    const s = String(v).trim();
    if (!s) return null;
    // Date-only → local calendar day (avoid UTC midnight shifting the day west of UTC)
    const dayOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dayOnly) {
      const d = new Date(+dayOnly[1], +dayOnly[2] - 1, +dayOnly[3], 12, 0, 0, 0);
      return isNaN(d) ? null : d;
    }
    // Prefer ISO / explicit date-time
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || /T\d{2}:\d{2}/.test(s)) {
      const d = new Date(s);
      return isNaN(d) ? null : d;
    }
    // Avoid locale-ambiguous free text inventing dates — return null
    const d = new Date(s);
    if (!isNaN(d) && /^\d{1,2}\s+[A-Za-z]{3,}/.test(s)) return d;
    return null;
  }

  /**
   * Canonical event/sort timestamp for a record.
   * Never falls back to email-received when a reliable event field exists.
   * Returns null when no reliable event date is known (caller must not invent).
   */
  function eventAt(record) {
    if (!record || typeof record !== 'object') return null;
    const candidates = [
      record.eventAt,
      record.travelAt,
      record.depart_datetime,
      record.flight?.depart,
      record.flight?.departIso,
      record.check_in,
      record.dueDate,
      record.due_date,
      record.deliveryDate,
      record.delivery_date,
      record.expiry,
      record.pass?.expiry,
      record.start?.dateTime,
      record.start?.date,
      record.payload?.eventAt,
      record.payload?.travelAt,
      record.payload?.dueDate
    ];
    for (const c of candidates) {
      const d = parseMaybeDate(c);
      if (d) return d;
    }
    return null;
  }

  /** Sort key: prefer eventAt; only then insert/received `at` / whenMs (explicitly weaker). */
  function sortAt(record) {
    return eventAt(record) || parseMaybeDate(record?.whenMs) || parseMaybeDate(record?.at) || parseMaybeDate(record?.date) || null;
  }

  function isPromotionalExtraction(ex) {
    if (!ex) return false;
    return ex.intent === 'promotional' || ex.category === 'promotions' || ex.category === 'newsletters';
  }

  function isPromotionalMail(item) {
    if (!item) return false;
    if (item.promotional || item.isPromo) return true;
    const labels = item.labelIds || item.labels || [];
    if (labels.some((l) => /CATEGORY_PROMOTIONS|CATEGORY_SOCIAL|CATEGORY_FORUMS/i.test(l))) return true;
    const cat = item.category || item.kind || item.payload?.category;
    if (cat === 'promotions' || cat === 'newsletters') return true;
    return false;
  }

  /** Map classify / AI categories onto Phase 13 Inbox filters (no second engine). */
  function inboxBucket(item) {
    if (!item) return 'important';
    // Phase 2: the financial ledger decides the bucket for money mail (receipts are never "payments to make").
    if (item.financeBucket) return item.financeBucket;
    if (isPromotionalMail(item)) return 'promotions';
    const cat = String(item.category || item.kind || item.payload?.category || '').toLowerCase();
    const intent = String(item.intent || item.payload?.intent || '').toLowerCase();
    if (cat === 'subscription' || cat === 'subscriptions' || /subscription/.test(intent)) return 'subscriptions';
    if (cat === 'bill' || cat === 'bills' || intent === 'payment_due') return 'bills';
    if (cat === 'payment' || cat === 'payments' || intent === 'payment_completed' || intent === 'refund_issued') {
      return /receipt|paid|charged|successful/i.test(item.subject || item.title || '') ? 'receipts' : 'payments';
    }
    if (cat === 'ticket' || cat === 'travel' || cat === 'tickets') return 'tickets';
    if (cat === 'shopping' || cat === 'delivery' || /order_|delivery_/.test(intent)) return 'receipts';
    if (cat === 'other' || cat === 'personal' || cat === 'work' || cat === 'meetings' || cat === 'documents') return 'important';
    return 'important';
  }

  function readAiOrders() {
    const list = readJSON(LS.orders, []);
    return Array.isArray(list) ? list : [];
  }

  function readWalletRaw() {
    const list = readJSON(LS.wallet, []);
    return Array.isArray(list) ? list : [];
  }

  function readExtractions() {
    const map = readJSON(LS.extractions, {});
    return map && typeof map === 'object' ? map : {};
  }

  function normalizeOrder(o) {
    if (!o) return null;
    const due = parseMaybeDate(o.deliveryDate || o.delivery_date || o.dueDate);
    const status = String(o.status || '').toLowerCase();
    return {
      ...o,
      id: o.id || o.entityKey || ('order:' + (o.orderId || o.mailId || Math.random())),
      entityKey: o.entityKey || null,
      orderId: o.orderId || o.order_id || null,
      eventAt: due ? due.toISOString() : null,
      sortAt: (due || parseMaybeDate(o.updatedAt) || parseMaybeDate(o.createdAt) || parseMaybeDate(o.at))?.getTime?.() || null,
      status,
      cancelled: /cancel|refund/.test(status),
      source: 'daylight-orders',
      mailId: o.lastMailId || o.mailId || (o.sourceMailIds || [])[0] || null,
      sourceMailIds: o.sourceMailIds || []
    };
  }

  function walletStatus(item, nowMs) {
    const now = nowMs || Date.now();
    const st = String(item.status || item.flight?.status || '').toLowerCase();
    if (item.cancelled || /cancel/.test(st)) return 'cancelled';
    const exp = parseMaybeDate(item.expiry || item.pass?.expiry);
    const ev = eventAt(item);
    if (exp && exp.getTime() < now) return 'expired';
    if (ev && ev.getTime() + 6 * 3600000 < now && (item.kind === 'tickets' || item.kind === 'ticket')) return 'expired';
    if (ev && ev.getTime() >= now - 3600000) return 'upcoming';
    return 'active';
  }

  function normalizeWalletItem(w) {
    if (!w) return null;
    const ev = eventAt(w);
    const authenticQr = !!(w.qrAuthentic || w.barcodeAuthentic || w.exactQr || (w.barcodes && w.barcodes.some((b) => b?.authentic)));
    // Do not treat auto-filled PNR/mailId QR as authentic
    const fabricatedHint = !authenticQr && !!(w.qrPayload || w.barcode) && !w.qrImageFromAttachment && !w.scanSource;
    return {
      ...w,
      eventAt: ev ? ev.toISOString() : null,
      sortAt: (ev || parseMaybeDate(w.at))?.getTime?.() || 0,
      walletStatus: walletStatus(w),
      qrAuthentic: authenticQr,
      // UI must not display generated codes as if they were ticket QR when not authentic
      displayCode: authenticQr ? (w.qrPayload || w.barcode) : (w.flight?.pnr || w.number || w.bookingRef || null),
      showGeneratedQr: false,
      fabricatedQrSuppressed: fabricatedHint && !authenticQr
    };
  }

  function orders(opts) {
    const o = opts || {};
    let list = readAiOrders().map(normalizeOrder).filter(Boolean);
    if (o.excludeCancelled) list = list.filter((x) => !x.cancelled);
    list.sort((a, b) => (b.sortAt || 0) - (a.sortAt || 0));
    return list;
  }

  function walletItems(opts) {
    const o = opts || {};
    let list = readWalletRaw().map(normalizeWalletItem).filter(Boolean);
    const filter = o.filter || o.kind || 'all';
    if (filter && filter !== 'all') {
      if (filter === 'tickets') list = list.filter((i) => i.kind === 'tickets' || i.kind === 'ticket' || i.category === 'ticket');
      else if (filter === 'documents') list = list.filter((i) => i.kind === 'documents' || i.kind === 'document');
      else if (filter === 'payments') {
        list = list.filter((i) =>
          i.kind === 'payments' || i.kind === 'payment' || i.category === 'payment' || i.project === 'Payments' ||
          (!!i.amount && i.kind !== 'tickets' && i.kind !== 'documents')
        );
      } else if (filter === 'cards') {
        list = list.filter((i) => i.kind === 'others' || i.kind === 'cards' || i.kind === 'coupons' || i.typeLabel === 'Membership');
      } else list = list.filter((i) => i.kind === filter);
    }
    if (o.status) list = list.filter((i) => i.walletStatus === o.status);
    if (o.upcomingOnly) list = list.filter((i) => i.walletStatus === 'upcoming' || i.walletStatus === 'active');
    // Nearest event first when eventAt known; items without eventAt sink after (by insert time)
    list.sort((a, b) => {
      const ae = eventAt(a), be = eventAt(b);
      if (ae && be) return ae - be;
      if (ae && !be) return -1;
      if (!ae && be) return 1;
      return (parseMaybeDate(b.at)?.getTime() || 0) - (parseMaybeDate(a.at)?.getTime() || 0);
    });
    return list;
  }

  function extractionForMail(mailId) {
    if (!mailId) return null;
    const map = readExtractions();
    return map[mailId] || null;
  }

  /** Ordinary single-booking id; multi-pass emails use mail:{mailId}#pass:{childKey}. */
  function canonicalWalletId(mailId, childKey) {
    if (!mailId) return null;
    const base = 'mail:' + mailId;
    const child = childKey != null && String(childKey).trim() !== '' ? String(childKey).trim() : '';
    if (!child) return base;
    return base + '#pass:' + child.replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 64);
  }

  function parseWalletIdParts(id) {
    const s = String(id || '');
    const childM = s.match(/^mail:(.+?)#pass:(.+)$/);
    if (childM) return { mailId: childM[1], childKey: childM[2], legacy: false };
    const mailM = s.match(/^mail:(.+)$/);
    if (mailM) return { mailId: mailM[1], childKey: null, legacy: false };
    const ticketM = s.match(/^ticket:(.+)$/);
    if (ticketM) return { mailId: ticketM[1], childKey: null, legacy: true };
    return { mailId: null, childKey: null, legacy: false };
  }

  function journeyFingerprint(w) {
    if (!w) return '';
    const f = w.flight || {};
    return [
      w.childKey || '',
      f.pnr || w.bookingRef || w.number || '',
      f.flight || '',
      f.from || '',
      f.to || '',
      f.depart || w.travelAt || w.eventAt || ''
    ].join('|').toLowerCase();
  }

  function richnessScore(w) {
    if (!w) return 0;
    let s = 0;
    if (w.qrAuthentic || w.exactQr || w.scanSource) s += 40;
    if (w.qrImage) s += 20;
    if (w.barcodeImage) s += 15;
    if (w.barcodeAuthentic) s += 10;
    if (w.flight && (w.flight.from || w.flight.pnr || w.flight.depart)) s += 12;
    if (w.travelAt || w.eventAt) s += 8;
    if (w.bookingRef || w.number) s += 4;
    if (w.attachmentId || w.attachmentIds?.length || w.attachments?.length) s += 6;
    if (w.recordKey) s += 2;
    if (w.entityKey) s += 2;
    if (w.tripId) s += 1;
    if (w.status === 'cancelled' || w.cancelled) s += 3;
    if (w.lastChange || w.rescheduled) s += 2;
    if (w.image) s += 3;
    if (w.ocr) s += 1;
    return s;
  }

  /** Merge two wallet rows for the same booking; never drop authentic QR / richer travel facts. */
  function mergeWalletRichness(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return { ...a };
    const primary = richnessScore(a) >= richnessScore(b) ? a : b;
    const secondary = primary === a ? b : a;
    const out = { ...secondary, ...primary };
    const aAuth = !!(a.qrAuthentic || a.barcodeAuthentic || a.exactQr || a.scanSource);
    const bAuth = !!(b.qrAuthentic || b.barcodeAuthentic || b.exactQr || b.scanSource);
    if (aAuth && !bAuth) {
      out.qrAuthentic = !!(a.qrAuthentic || a.exactQr || a.scanSource);
      out.barcodeAuthentic = !!(a.barcodeAuthentic || a.scanSource);
      out.exactQr = !!(a.exactQr || a.qrAuthentic);
      out.scanSource = !!a.scanSource;
      out.qrImage = a.qrImage || out.qrImage;
      out.barcodeImage = a.barcodeImage || out.barcodeImage;
      out.qrPayload = a.qrPayload || out.qrPayload;
      out.barcode = a.barcode || out.barcode;
      out.barcodes = a.barcodes?.length ? a.barcodes : out.barcodes;
    } else if (bAuth && !aAuth) {
      out.qrAuthentic = !!(b.qrAuthentic || b.exactQr || b.scanSource);
      out.barcodeAuthentic = !!(b.barcodeAuthentic || b.scanSource);
      out.exactQr = !!(b.exactQr || b.qrAuthentic);
      out.scanSource = !!b.scanSource;
      out.qrImage = b.qrImage || out.qrImage;
      out.barcodeImage = b.barcodeImage || out.barcodeImage;
      out.qrPayload = b.qrPayload || out.qrPayload;
      out.barcode = b.barcode || out.barcode;
      out.barcodes = b.barcodes?.length ? b.barcodes : out.barcodes;
    } else {
      out.qrImage = primary.qrImage || secondary.qrImage;
      out.barcodeImage = primary.barcodeImage || secondary.barcodeImage;
      out.qrPayload = primary.qrPayload || secondary.qrPayload;
      out.barcode = primary.barcode || secondary.barcode;
      out.barcodes = (primary.barcodes?.length ? primary.barcodes : null) || secondary.barcodes;
      out.qrAuthentic = aAuth || bAuth;
      out.barcodeAuthentic = !!(a.barcodeAuthentic || b.barcodeAuthentic || out.qrAuthentic);
      out.exactQr = !!(a.exactQr || b.exactQr || out.qrAuthentic);
      out.scanSource = !!(a.scanSource || b.scanSource);
    }
    out.flight = { ...(secondary.flight || {}), ...(primary.flight || {}) };
    if (!Object.keys(out.flight).length) out.flight = primary.flight || secondary.flight || null;
    const pe = eventAt(primary), se = eventAt(secondary);
    if (pe) {
      out.travelAt = primary.travelAt || pe.toISOString();
      out.eventAt = primary.eventAt || pe.toISOString();
    } else if (se) {
      out.travelAt = secondary.travelAt || se.toISOString();
      out.eventAt = secondary.eventAt || se.toISOString();
    }
    out.bookingRef = primary.bookingRef || secondary.bookingRef || primary.flight?.pnr || secondary.flight?.pnr || null;
    out.number = primary.number || secondary.number || '';
    out.recordKey = primary.recordKey || secondary.recordKey || null;
    out.entityKey = primary.entityKey || secondary.entityKey || null;
    out.tripId = primary.tripId || secondary.tripId || null;
    out.threadId = primary.threadId || secondary.threadId || null;
    out.mailId = primary.mailId || secondary.mailId || null;
    out.childKey = primary.childKey || secondary.childKey || null;
    out.href = primary.href || secondary.href || '';
    out.title = (primary.title && primary.title !== 'Ticket' ? primary.title : null) || secondary.title || primary.title;
    out.note = primary.note || secondary.note || '';
    out.attachmentId = primary.attachmentId || secondary.attachmentId || null;
    out.attachmentIds = Array.from(new Set([...(primary.attachmentIds || []), ...(secondary.attachmentIds || [])].filter(Boolean)));
    out.attachments = (primary.attachments?.length ? primary.attachments : null) || secondary.attachments || [];
    out.image = primary.image || secondary.image || '';
    out.ocr = primary.ocr || secondary.ocr || '';
    if (primary.status === 'cancelled' || secondary.status === 'cancelled' || primary.cancelled || secondary.cancelled) {
      out.status = 'cancelled';
      out.cancelled = true;
    } else {
      out.status = primary.status || secondary.status || 'active';
    }
    out.lastChange = primary.lastChange || secondary.lastChange || null;
    out.rescheduled = !!(primary.rescheduled || secondary.rescheduled || (out.lastChange && out.lastChange.kind === 'rescheduled'));
    const legacyIds = Array.from(new Set([
      ...(primary.legacyIds || []),
      ...(secondary.legacyIds || []),
      primary.id && primary.id !== out.id ? primary.id : null,
      secondary.id && secondary.id !== out.id ? secondary.id : null
    ].filter(Boolean)));
    out.legacyIds = legacyIds;
    out.sourceRefs = Object.assign({}, secondary.sourceRefs || {}, primary.sourceRefs || {}, {
      mailId: out.mailId,
      threadId: out.threadId,
      recordKey: out.recordKey,
      entityKey: out.entityKey
    });
    return out;
  }

  /**
   * Idempotent wallet id normalization.
   * Maps ticket:{mailId} → mail:{mailId}; merges duplicate same-booking rows (richest wins).
   * Does NOT merge distinct child passes or distinct journeys that share only a thread.
   */
  function normalizeWalletIds(list) {
    const input = Array.isArray(list) ? list.filter(Boolean).map((w) => ({ ...w })) : [];
    if (!input.length) return { list: [], changed: false, merges: [], beforeIds: [], afterIds: [] };
    const beforeIds = input.map((w) => w.id);
    const buckets = new Map();
    const merges = [];

    input.forEach((raw) => {
      const w = { ...raw };
      const parts = parseWalletIdParts(w.id);
      if (!w.mailId && parts.mailId) w.mailId = parts.mailId;
      if (!w.childKey && parts.childKey) w.childKey = parts.childKey;
      let canonId;
      if (w.childKey || parts.childKey) {
        const ck = w.childKey || parts.childKey;
        w.childKey = ck;
        canonId = canonicalWalletId(w.mailId || parts.mailId, ck);
      } else if (w.mailId || parts.mailId) {
        canonId = canonicalWalletId(w.mailId || parts.mailId, null);
      } else {
        canonId = w.id;
      }
      w.id = canonId;
      if (raw.id && raw.id !== canonId) {
        w.legacyIds = Array.from(new Set([...(w.legacyIds || []), raw.id]));
        w.sourceRefs = Object.assign({}, w.sourceRefs || {}, { legacyId: raw.id });
      }

      if (!buckets.has(canonId)) {
        buckets.set(canonId, w);
        return;
      }
      const existing = buckets.get(canonId);
      const fpA = journeyFingerprint(existing), fpB = journeyFingerprint(w);
      const richDiff =
        fpA && fpB && fpA !== fpB &&
        fpA.split('|').filter(Boolean).length >= 3 &&
        fpB.split('|').filter(Boolean).length >= 3;
      // Same canonical id but clearly different journeys (multi-ticket without child yet)
      if (richDiff && !existing.childKey && !w.childKey && (w.mailId || parts.mailId)) {
        const mid = w.mailId || parts.mailId;
        const c1 = existing.flight?.pnr || existing.bookingRef || 'leg-a';
        const c2 = w.flight?.pnr || w.bookingRef || 'leg-b';
        existing.childKey = c1;
        existing.id = canonicalWalletId(mid, c1);
        w.childKey = c2;
        w.id = canonicalWalletId(mid, c2);
        buckets.delete(canonId);
        buckets.set(existing.id, existing);
        buckets.set(w.id, w);
        merges.push({ from: [raw.id, existing.legacyIds?.[0] || canonId], to: [existing.id, w.id], reason: 'split-distinct-journeys' });
        return;
      }
      const merged = mergeWalletRichness(existing, w);
      merged.id = canonId;
      merges.push({ from: [existing.id, raw.id], to: canonId });
      buckets.set(canonId, merged);
    });

    const finals = [...buckets.values()];
    const afterIds = finals.map((w) => w.id);
    const changed =
      beforeIds.length !== afterIds.length ||
      beforeIds.slice().sort().join('\0') !== afterIds.slice().sort().join('\0') ||
      merges.length > 0;
    return { list: finals, changed: !!changed, merges, beforeIds, afterIds };
  }

  function walletMatchesMail(w, mailId, hints) {
    if (!w || !mailId) return false;
    if (w.mailId === mailId || w.sourceId === mailId) return true;
    const parts = parseWalletIdParts(w.id);
    if (parts.mailId === mailId) return true;
    if ((w.legacyIds || []).some((id) => {
      const p = parseWalletIdParts(id);
      return p.mailId === mailId || id === 'ticket:' + mailId || id === 'mail:' + mailId;
    })) return true;
    const h = hints || {};
    if (h.recordKey && w.recordKey && w.recordKey === h.recordKey) return true;
    if (h.entityKey && w.entityKey && w.entityKey === h.entityKey) return true;
    return false;
  }

  function travelRecordsForMail(mailId, hints) {
    if (!mailId) return [];
    const h = hints || {};
    const ex = h.extraction || extractionForMail(mailId);
    const entityKey = h.entityKey || ex?.entityKey || null;
    const recordKey = h.recordKey || null;
    const norm = normalizeWalletIds(readWalletRaw());
    return norm.list.filter((w) => walletMatchesMail(w, mailId, { recordKey, entityKey })).map((w) => {
      const nw = normalizeWalletItem(w);
      const ev = eventAt(nw);
      return {
        mailId,
        threadId: nw.threadId || h.threadId || null,
        recordKey: nw.recordKey || recordKey,
        entityKey: nw.entityKey || entityKey,
        walletId: nw.id,
        childKey: nw.childKey || null,
        tripId: nw.tripId || null,
        eventAt: ev ? ev.toISOString() : null,
        status: nw.walletStatus || walletStatus(nw),
        cancelled: nw.status === 'cancelled' || !!nw.cancelled,
        wallet: nw,
        extraction: ex || null,
        legacyIds: nw.legacyIds || []
      };
    });
  }

  function travelRecordForMail(mailId, hints) {
    const all = travelRecordsForMail(mailId, hints);
    if (!all.length) {
      const ex = (hints && hints.extraction) || extractionForMail(mailId);
      if (!ex && !(hints && (hints.recordKey || hints.ensureStub))) return null;
      return {
        mailId,
        threadId: hints?.threadId || null,
        recordKey: hints?.recordKey || null,
        entityKey: hints?.entityKey || ex?.entityKey || null,
        walletId: canonicalWalletId(mailId, hints?.childKey || null),
        childKey: hints?.childKey || null,
        tripId: null,
        eventAt: null,
        status: 'active',
        cancelled: false,
        wallet: null,
        extraction: ex || null,
        legacyIds: []
      };
    }
    all.sort((a, b) => {
      const ae = a.eventAt ? Date.parse(a.eventAt) : Infinity;
      const be = b.eventAt ? Date.parse(b.eventAt) : Infinity;
      return ae - be;
    });
    if (hints?.childKey) {
      const hit = all.find((t) => t.childKey === hints.childKey || t.walletId === canonicalWalletId(mailId, hints.childKey));
      if (hit) return hit;
    }
    if (hints?.walletId) {
      const hit = all.find((t) => t.walletId === hints.walletId);
      if (hit) return hit;
    }
    return all[0];
  }

  function linkedRecordsForMail(mailId, hints) {
    if (!mailId) return { orders: [], wallet: [], extraction: null, travel: [] };
    const ex = extractionForMail(mailId);
    const travel = travelRecordsForMail(mailId, { ...(hints || {}), extraction: ex });
    return {
      orders: orders().filter((o) => o.mailId === mailId || (o.sourceMailIds || []).includes(mailId)),
      wallet: travel.map((t) => t.wallet).filter(Boolean),
      extraction: ex,
      travel
    };
  }

  async function storeSnapshot(types) {
    const Store = root.DaylightStore;
    if (!Store?.queryByType) return { available: false, byType: {} };
    try {
      await Store.open();
      const accountId = await Store.getActiveAccountId();
      const want = types || ['mail', 'order', 'ticket', 'subscription', 'bill', 'payment', 'booking', 'trip'];
      const byType = {};
      for (const t of want) {
        byType[t] = await Store.queryByType(t, accountId);
      }
      return { available: true, accountId, byType };
    } catch (e) {
      return { available: false, error: String(e && e.message || e), byType: {} };
    }
  }

  async function relationshipsFor(entityId) {
    const Store = root.DaylightStore;
    if (!Store?.getRelationships || !entityId) return [];
    try {
      await Store.open();
      return await Store.getRelationships(entityId);
    } catch {
      return [];
    }
  }

  /** Same local calendar day (timezone-safe). */
  function sameLocalDay(a, b) {
    const ka = localDayKey(a), kb = localDayKey(b);
    return !!ka && ka === kb;
  }

  function belongsToLocalDay(record, day) {
    // Prefer real event dates only — never fall back to email-received whenMs for membership
    const ev = eventAt(record) || parseMaybeDate(record?.start);
    if (!ev) return false;
    return sameLocalDay(ev, day);
  }

  /** Timeline/Brief: true only when a reliable travel/event date falls on the local day. */
  function belongsToLocalDayStrict(record, day) {
    const ev = eventAt(record);
    if (!ev) return false;
    return sameLocalDay(ev, day);
  }

  root.DaylightData = {
    LS,
    readJSON,
    localDayKey,
    startOfLocalDay,
    parseMaybeDate,
    eventAt,
    sortAt,
    sameLocalDay,
    belongsToLocalDay,
    belongsToLocalDayStrict,
    isPromotionalExtraction,
    isPromotionalMail,
    inboxBucket,
    readAiOrders,
    readWalletRaw,
    readExtractions,
    orders,
    walletItems,
    normalizeOrder,
    normalizeWalletItem,
    walletStatus,
    extractionForMail,
    linkedRecordsForMail,
    canonicalWalletId,
    parseWalletIdParts,
    journeyFingerprint,
    richnessScore,
    mergeWalletRichness,
    normalizeWalletIds,
    walletMatchesMail,
    travelRecordsForMail,
    travelRecordForMail,
    storeSnapshot,
    relationshipsFor
  };
})(typeof window !== 'undefined' ? window : globalThis);
