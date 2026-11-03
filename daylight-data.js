/**
 * DaylightData — minimal canonical read adapter (Phase 13).
 *
 * Bridges IndexedDB (DaylightStore) + legacy localStorage sidecars without
 * destructive migration. UI modules should prefer these helpers over ad-hoc LS reads.
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

  function linkedRecordsForMail(mailId) {
    if (!mailId) return { orders: [], wallet: [], extractions: null };
    const ex = extractionForMail(mailId);
    return {
      orders: orders().filter((o) => o.mailId === mailId || (o.sourceMailIds || []).includes(mailId)),
      wallet: walletItems({ filter: 'all' }).filter((w) => w.mailId === mailId),
      extraction: ex
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
    const ev = eventAt(record) || parseMaybeDate(record?.start) || parseMaybeDate(record?.whenMs);
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
    storeSnapshot,
    relationshipsFor
  };
})(typeof window !== 'undefined' ? window : globalThis);
