/**
 * DaylightStore — multi-account-ready local foundation (schema v2)
 *
 * Tenancy rules (enforce now, even with one user):
 * - Every content row is owned by accountId (hard isolation boundary).
 * - sourceIdentity records which connected provider account produced the data
 *   (personal vs work Gmail must never collide).
 * - privacyClass / aiExclude mark privacy boundaries for future AI + export.
 * - Queries and clears are always account-scoped; never global by default.
 *
 * localStorage remains preferences-only.
 */
(function (root) {
  const DB_NAME = 'daylight-db';
  const SCHEMA_VERSION = 2;
  const STORES = {
    accounts: 'accounts',
    entities: 'entities',
    relationships: 'relationships',
    facts: 'facts',
    actions: 'actions',
    reminders: 'reminders',
    meta: 'meta'
  };

  const PRIVACY = {
    PUBLIC_META: 'public_meta',
    NORMAL: 'normal',
    FINANCIAL: 'financial',
    IDENTITY: 'identity',
    HEALTH: 'health',
    RESTRICTED: 'restricted'
  };

  const AI_EXCLUDE_DEFAULT = new Set([
    PRIVACY.FINANCIAL,
    PRIVACY.IDENTITY,
    PRIVACY.HEALTH,
    PRIVACY.RESTRICTED
  ]);

  let db = null;
  let opening = null;
  let activeAccountId = null;
  const now = () => Date.now();

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function open() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    if (!root.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
      req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion || 0, req.transaction);
      req.onsuccess = () => {
        db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch {}
          db = null;
        };
        opening = null;
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error || new Error('Failed to open DaylightStore'));
      };
    });
    return opening;
  }

  function ensureIndex(store, name, keyPath, opts) {
    if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, opts || {});
  }

  function migrate(database, from, upgradeTx) {
    // --- v1 base stores (fresh installs) ---
    if (from < 1) {
      if (!database.objectStoreNames.contains(STORES.entities)) {
        database.createObjectStore(STORES.entities, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.relationships)) {
        database.createObjectStore(STORES.relationships, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.facts)) {
        database.createObjectStore(STORES.facts, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.actions)) {
        database.createObjectStore(STORES.actions, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.reminders)) {
        database.createObjectStore(STORES.reminders, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORES.meta)) {
        database.createObjectStore(STORES.meta, { keyPath: 'key' });
      }
    }

    // --- v2: accounts + account-scoped indexes ---
    if (from < 2) {
      if (!database.objectStoreNames.contains(STORES.accounts)) {
        const accts = database.createObjectStore(STORES.accounts, { keyPath: 'id' });
        ensureIndex(accts, 'byProviderKey', 'providerAccountKey', { unique: true });
        ensureIndex(accts, 'byEmail', 'email', { unique: false });
        ensureIndex(accts, 'byStatus', 'status', { unique: false });
      }

      const ent = upgradeTx.objectStore(STORES.entities);
      if (ent.indexNames.contains('bySourceKey')) {
        try { ent.deleteIndex('bySourceKey'); } catch {}
      }
      ensureIndex(ent, 'byAccount', 'accountId', { unique: false });
      ensureIndex(ent, 'byAccountType', ['accountId', 'type'], { unique: false });
      ensureIndex(ent, 'byAccountSourceKey', ['accountId', 'sourceKey'], { unique: true });
      ensureIndex(ent, 'bySourceIdentity', 'sourceIdentity.providerAccountKey', { unique: false });
      ensureIndex(ent, 'byPrivacy', ['accountId', 'privacyClass'], { unique: false });
      ensureIndex(ent, 'byType', 'type', { unique: false });
      ensureIndex(ent, 'bySource', 'source', { unique: false });
      ensureIndex(ent, 'byWhen', 'whenMs', { unique: false });
      ensureIndex(ent, 'byTrip', 'tripId', { unique: false });
      ensureIndex(ent, 'byUpdated', 'updatedAt', { unique: false });

      const rel = upgradeTx.objectStore(STORES.relationships);
      ensureIndex(rel, 'byAccount', 'accountId', { unique: false });
      ensureIndex(rel, 'byAccountFrom', ['accountId', 'fromId'], { unique: false });
      ensureIndex(rel, 'byAccountTo', ['accountId', 'toId'], { unique: false });
      ensureIndex(rel, 'byFrom', 'fromId', { unique: false });
      ensureIndex(rel, 'byTo', 'toId', { unique: false });
      ensureIndex(rel, 'byType', 'type', { unique: false });
      ensureIndex(rel, 'byFromType', ['fromId', 'type'], { unique: false });
      ensureIndex(rel, 'byConfirmed', 'confirmed', { unique: false });

      const facts = upgradeTx.objectStore(STORES.facts);
      ensureIndex(facts, 'byAccount', 'accountId', { unique: false });
      ensureIndex(facts, 'byAccountEntity', ['accountId', 'entityId'], { unique: false });
      ensureIndex(facts, 'byEntity', 'entityId', { unique: false });
      ensureIndex(facts, 'byField', 'field', { unique: false });
      ensureIndex(facts, 'byEntityField', ['entityId', 'field'], { unique: false });
      ensureIndex(facts, 'byVerified', 'verified', { unique: false });
      ensureIndex(facts, 'byPrivacy', ['accountId', 'privacyClass'], { unique: false });

      const actions = upgradeTx.objectStore(STORES.actions);
      if (actions.indexNames.contains('byIdempotency')) {
        try { actions.deleteIndex('byIdempotency'); } catch {}
      }
      ensureIndex(actions, 'byAccount', 'accountId', { unique: false });
      ensureIndex(actions, 'byAccountIdempotency', ['accountId', 'idempotencyKey'], { unique: true });
      ensureIndex(actions, 'byStatus', 'status', { unique: false });
      ensureIndex(actions, 'byKind', 'kind', { unique: false });
      ensureIndex(actions, 'byUpdated', 'updatedAt', { unique: false });

      const rem = upgradeTx.objectStore(STORES.reminders);
      ensureIndex(rem, 'byAccount', 'accountId', { unique: false });
      ensureIndex(rem, 'byAccountWhen', ['accountId', 'whenMs'], { unique: false });
      ensureIndex(rem, 'byWhen', 'whenMs', { unique: false });
      ensureIndex(rem, 'byStatus', 'status', { unique: false });
      ensureIndex(rem, 'byEntity', 'entityId', { unique: false });

      // Backfill orphan v1 rows under a device-local account (same browser, no provider yet)
      const deviceAcct = {
        id: 'acct:local:device',
        kind: 'local',
        subject: null,
        email: null,
        displayName: 'This device',
        providerAccountKey: 'local:device',
        status: 'active',
        privacyDefaults: defaultPrivacyDefaults(),
        createdAt: now(),
        updatedAt: now(),
        lastSeenAt: now()
      };
      upgradeTx.objectStore(STORES.accounts).put(deviceAcct);

      const stamp = (row) => {
        if (!row.accountId) row.accountId = deviceAcct.id;
        if (!row.ownerId) row.ownerId = row.accountId;
        if (!row.sourceIdentity) {
          row.sourceIdentity = {
            provider: row.source || 'local',
            subject: null,
            email: null,
            providerAccountKey: row.source === 'gmail' || row.source === 'google'
              ? 'google:unknown'
              : row.source === 'microsoft'
                ? 'microsoft:unknown'
                : 'local:device'
          };
        }
        if (!row.privacyClass) row.privacyClass = PRIVACY.NORMAL;
        if (row.aiExclude == null) row.aiExclude = AI_EXCLUDE_DEFAULT.has(row.privacyClass);
        return row;
      };

      [STORES.entities, STORES.relationships, STORES.facts, STORES.actions, STORES.reminders].forEach((name) => {
        const store = upgradeTx.objectStore(name);
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          cursor.update(stamp(cursor.value));
          cursor.continue();
        };
      });

      upgradeTx.objectStore(STORES.meta).put({
        key: 'activeAccountId',
        value: deviceAcct.id,
        updatedAt: now()
      });
    }
  }

  function defaultPrivacyDefaults() {
    return {
      aiExcludeClasses: [PRIVACY.FINANCIAL, PRIVACY.IDENTITY, PRIVACY.HEALTH, PRIVACY.RESTRICTED],
      shareClasses: [PRIVACY.PUBLIC_META, PRIVACY.NORMAL],
      exportRequiresConfirm: [PRIVACY.FINANCIAL, PRIVACY.IDENTITY, PRIVACY.RESTRICTED]
    };
  }

  function privacyClassFor(type, tags, explicit) {
    if (explicit) return explicit;
    const t = new Set((tags || []).map((x) => String(x).toLowerCase()));
    if (type === 'payment' || t.has('money') || t.has('invoice') || t.has('subscription') || t.has('bill')) {
      return PRIVACY.FINANCIAL;
    }
    if (type === 'wallet' && (t.has('documents') || t.has('passport') || t.has('id'))) return PRIVACY.IDENTITY;
    if (type === 'note' && (t.has('health') || t.has('medical'))) return PRIVACY.HEALTH;
    if (type === 'mail' && (t.has('category_personal') || t.has('docs'))) return PRIVACY.NORMAL;
    return PRIVACY.NORMAL;
  }

  function normalizeSourceIdentity(partial, account) {
    const raw = partial.sourceIdentity || {};
    const provider = raw.provider || partial.source || account?.kind || 'local';
    const subject = raw.subject || account?.subject || null;
    const email = (raw.email || account?.email || null);
    const providerAccountKey = raw.providerAccountKey || account?.providerAccountKey || (
      provider === 'google' || provider === 'gmail'
        ? (subject ? 'google:sub:' + subject : (email ? 'google:email:' + String(email).toLowerCase() : 'google:unknown'))
        : provider === 'microsoft'
          ? (subject ? 'microsoft:oid:' + subject : (email ? 'microsoft:email:' + String(email).toLowerCase() : 'microsoft:unknown'))
          : 'local:device'
    );
    return { provider, subject, email, providerAccountKey };
  }

  const id = {
    account: (kind, key) => 'acct:' + kind + ':' + String(key || ''),
    mail: (accountId, messageId) => accountId + '|mail:gmail:' + String(messageId || ''),
    thread: (accountId, threadId) => accountId + '|thread:gmail:' + String(threadId || ''),
    event: (accountId, eventId, provider) => accountId + '|event:' + (provider || 'google') + ':' + String(eventId || ''),
    task: (accountId, taskId, provider) => accountId + '|task:' + (provider || 'daylight') + ':' + String(taskId || ''),
    wallet: (accountId, walletId) => accountId + '|wallet:local:' + String(walletId || ''),
    trip: (accountId, tripKey) => {
      const t = String(tripKey || '');
      const bare = t.startsWith('trip:') ? t : 'trip:' + t;
      return accountId + '|' + bare;
    },
    note: (accountId, dayKey) => accountId + '|note:local:' + String(dayKey || ''),
    payment: (accountId, key) => accountId + '|payment:sug:' + String(key || ''),
    loop: (accountId, loopId) => accountId + '|loop:derived:' + String(loopId || ''),
    fact: (accountId, entityId, field, salt) => accountId + '|fact:' + entityId + ':' + field + ':' + String(salt || 'v1'),
    relationship: (accountId, fromId, type, toId) => accountId + '|' + fromId + '|' + type + '|' + toId,
    action: (accountId) => accountId + '|act:' + (root.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2, 9))),
    reminder: (accountId) => accountId + '|rem:' + (root.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2, 9)))
  };

  function sourceKeyFor(type, sourceIds, source) {
    if (type === 'mail' && sourceIds?.messageId) return 'gmail:msg:' + sourceIds.messageId;
    if (type === 'event' && sourceIds?.eventId) return (source || 'google') + ':event:' + sourceIds.eventId;
    if (type === 'task' && sourceIds?.taskId) return (source || 'daylight') + ':task:' + sourceIds.taskId;
    if (type === 'wallet' && sourceIds?.walletId) return 'wallet:' + sourceIds.walletId;
    if (type === 'trip' && sourceIds?.tripId) return 'trip:' + sourceIds.tripId;
    if (type === 'note' && sourceIds?.noteKey) return 'note:' + sourceIds.noteKey;
    if (type === 'payment' && (sourceIds?.messageId || sourceIds?.taskId)) {
      return 'payment:' + (sourceIds.messageId || sourceIds.taskId);
    }
    if (type === 'loop' && sourceIds?.loopId) return 'loop:' + sourceIds.loopId;
    return type + ':' + (source || 'local') + ':' + (sourceIds?.id || Math.random().toString(36).slice(2));
  }

  function requireAccountId(partial) {
    const accountId = partial.accountId || activeAccountId;
    if (!accountId) throw new Error('accountId required (multi-account isolation)');
    return accountId;
  }

  function normalizeEntity(partial, account) {
    const accountId = requireAccountId(partial);
    const type = partial.type;
    const source = partial.source || 'daylight';
    const sourceIds = partial.sourceIds || {};
    const sourceKey = partial.sourceKey || sourceKeyFor(type, sourceIds, source);
    const sourceIdentity = normalizeSourceIdentity(partial, account);
    const entityId = partial.id || (
      type === 'mail' ? id.mail(accountId, sourceIds.messageId) :
      type === 'event' ? id.event(accountId, sourceIds.eventId, source) :
      type === 'task' ? id.task(accountId, sourceIds.taskId, source) :
      type === 'wallet' ? id.wallet(accountId, sourceIds.walletId) :
      type === 'trip' ? id.trip(accountId, sourceIds.tripId) :
      type === 'note' ? id.note(accountId, sourceIds.noteKey) :
      type === 'payment' ? id.payment(accountId, sourceIds.messageId || sourceIds.taskId) :
      type === 'loop' ? id.loop(accountId, sourceIds.loopId) :
      accountId + '|' + sourceKey
    );
    const privacyClass = privacyClassFor(type, partial.tags, partial.privacyClass);
    const ts = now();
    return {
      id: entityId,
      accountId,
      ownerId: partial.ownerId || accountId,
      type,
      source,
      sourceKey,
      sourceIds,
      sourceIdentity,
      title: String(partial.title || '').slice(0, 240),
      subtitle: String(partial.subtitle || '').slice(0, 240),
      whenMs: partial.whenMs == null || isNaN(+partial.whenMs) ? null : +partial.whenMs,
      endMs: partial.endMs == null || isNaN(+partial.endMs) ? null : +partial.endMs,
      amount: partial.amount ? String(partial.amount).slice(0, 64) : '',
      href: partial.href || '',
      tripId: partial.tripId || null,
      status: partial.status || 'active',
      tags: Array.isArray(partial.tags) ? partial.tags.slice(0, 12) : [],
      privacyClass,
      aiExclude: partial.aiExclude != null ? !!partial.aiExclude : AI_EXCLUDE_DEFAULT.has(privacyClass),
      payload: partial.payload && typeof partial.payload === 'object' ? partial.payload : {},
      createdAt: partial.createdAt || ts,
      updatedAt: ts
    };
  }

  function normalizeRelationship(partial) {
    const accountId = requireAccountId(partial);
    const fromId = partial.fromId;
    const toId = partial.toId;
    const type = String(partial.type || 'related');
    const ts = now();
    return {
      id: partial.id || id.relationship(accountId, fromId, type, toId),
      accountId,
      ownerId: partial.ownerId || accountId,
      fromId,
      toId,
      type,
      confidence: Math.max(0, Math.min(1, Number(partial.confidence ?? 0.5))),
      evidence: Array.isArray(partial.evidence) ? partial.evidence.slice(0, 12) : [],
      confirmed: partial.confirmed || 'auto',
      method: partial.method || 'rule',
      sourceIds: partial.sourceIds || {},
      sourceIdentity: normalizeSourceIdentity(partial, null),
      privacyClass: partial.privacyClass || PRIVACY.NORMAL,
      aiExclude: partial.aiExclude != null ? !!partial.aiExclude : false,
      updatedAt: ts,
      createdAt: partial.createdAt || ts
    };
  }

  function normalizeFact(partial) {
    const accountId = requireAccountId(partial);
    const entityId = partial.entityId;
    const field = String(partial.field || 'value');
    const privacyClass = partial.privacyClass || (
      /amount|iban|card|passport|ssn|tax/i.test(field) ? PRIVACY.FINANCIAL :
      /passport|national.?id|dob|birth/i.test(field) ? PRIVACY.IDENTITY :
      PRIVACY.NORMAL
    );
    const ts = now();
    return {
      id: partial.id || id.fact(accountId, entityId, field, partial.salt || 'v1'),
      accountId,
      ownerId: partial.ownerId || accountId,
      entityId,
      field,
      value: partial.value,
      rawValue: partial.rawValue != null ? String(partial.rawValue).slice(0, 400) : '',
      sourceIds: partial.sourceIds || {},
      sourceIdentity: normalizeSourceIdentity(partial, null),
      evidenceQuote: partial.evidenceQuote ? String(partial.evidenceQuote).slice(0, 400) : '',
      method: partial.method || 'rule',
      confidence: Math.max(0, Math.min(1, Number(partial.confidence ?? 0.5))),
      verified: partial.verified || 'unverified',
      privacyClass,
      aiExclude: partial.aiExclude != null ? !!partial.aiExclude : AI_EXCLUDE_DEFAULT.has(privacyClass),
      supersededBy: partial.supersededBy || null,
      updatedAt: ts,
      createdAt: partial.createdAt || ts
    };
  }

  async function withStore(storeName, mode, fn) {
    const database = await open();
    const tx = database.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = await fn(store, tx);
    await txDone(tx);
    return result;
  }

  async function upsertAccount(partial) {
    const kind = partial.kind || 'local';
    const subject = partial.subject || null;
    const email = partial.email ? String(partial.email).toLowerCase() : null;
    const providerAccountKey = partial.providerAccountKey || (
      kind === 'google' ? (subject ? 'google:sub:' + subject : 'google:email:' + (email || 'unknown')) :
      kind === 'microsoft' ? (subject ? 'microsoft:oid:' + subject : 'microsoft:email:' + (email || 'unknown')) :
      'local:device'
    );
    const database = await open();
    const tx = database.transaction(STORES.accounts, 'readwrite');
    const store = tx.objectStore(STORES.accounts);
    let existing = null;
    try {
      existing = await reqToPromise(store.index('byProviderKey').get(providerAccountKey));
    } catch {}
    const ts = now();
    const row = {
      id: existing?.id || partial.id || id.account(kind, subject || email || 'device'),
      kind,
      subject,
      email,
      displayName: partial.displayName || existing?.displayName || email || 'Account',
      providerAccountKey,
      status: partial.status || 'active',
      privacyDefaults: partial.privacyDefaults || existing?.privacyDefaults || defaultPrivacyDefaults(),
      createdAt: existing?.createdAt || ts,
      updatedAt: ts,
      lastSeenAt: ts
    };
    await reqToPromise(store.put(row));
    await txDone(tx);
    return row;
  }

  async function listAccounts() {
    return withStore(STORES.accounts, 'readonly', (store) => reqToPromise(store.getAll()));
  }

  async function getAccount(accountId) {
    return withStore(STORES.accounts, 'readonly', (store) => reqToPromise(store.get(accountId)));
  }

  async function setActiveAccount(accountId) {
    activeAccountId = accountId;
    await setMeta('activeAccountId', accountId);
    return accountId;
  }

  async function getActiveAccountId() {
    if (activeAccountId) return activeAccountId;
    activeAccountId = await getMeta('activeAccountId', 'acct:local:device');
    return activeAccountId;
  }

  async function ensureActiveAccount(partial) {
    const acct = await upsertAccount(partial || { kind: 'local', providerAccountKey: 'local:device', displayName: 'This device' });
    await setActiveAccount(acct.id);
    return acct;
  }

  async function resolveAccount(partial) {
    const accountId = partial?.accountId || await getActiveAccountId();
    return getAccount(accountId);
  }

  async function putEntity(partial) {
    const account = await resolveAccount(partial);
    const entity = normalizeEntity({ ...partial, accountId: partial.accountId || account?.id }, account);
    await withStore(STORES.entities, 'readwrite', (store) => new Promise((resolve, reject) => {
      const q = store.index('byAccountSourceKey').get([entity.accountId, entity.sourceKey]);
      q.onsuccess = () => {
        const existing = q.result;
        if (existing && existing.id !== entity.id) {
          entity.id = existing.id;
          entity.createdAt = existing.createdAt || entity.createdAt;
        }
        const put = store.put(entity);
        put.onsuccess = () => resolve(entity);
        put.onerror = () => reject(put.error);
      };
      q.onerror = () => reject(q.error);
    }));
    return entity;
  }

  async function putEntities(list, opts) {
    if (!list?.length) return { entities: [], inserted: 0, updated: 0, unchanged: 0 };
    const accountId = opts?.accountId || list[0].accountId || await getActiveAccountId();
    const account = await getAccount(accountId);
    const database = await open();
    const tx = database.transaction(STORES.entities, 'readwrite');
    const store = tx.objectStore(STORES.entities);
    const idx = store.index('byAccountSourceKey');
    const out = [];
    let inserted = 0, updated = 0, unchanged = 0;
    for (const partial of list) {
      const entity = normalizeEntity({ ...partial, accountId }, account);
      // eslint-disable-next-line no-await-in-loop
      const existing = await reqToPromise(idx.get([entity.accountId, entity.sourceKey]));
      if (existing && existing.id !== entity.id) {
        entity.id = existing.id;
        entity.createdAt = existing.createdAt || entity.createdAt;
      } else if (existing) {
        entity.createdAt = existing.createdAt || entity.createdAt;
      }
      if (!existing) inserted++;
      else {
        const same =
          existing.title === entity.title &&
          existing.whenMs === entity.whenMs &&
          existing.endMs === entity.endMs &&
          existing.status === entity.status &&
          existing.tripId === entity.tripId &&
          existing.subtitle === entity.subtitle &&
          existing.amount === entity.amount &&
          existing.privacyClass === entity.privacyClass;
        if (same) {
          unchanged++;
          entity.updatedAt = existing.updatedAt || entity.updatedAt;
        } else updated++;
      }
      // eslint-disable-next-line no-await-in-loop
      await reqToPromise(store.put(entity));
      out.push(entity);
    }
    await txDone(tx);
    return { entities: out, inserted, updated, unchanged };
  }

  async function getEntity(entityId, accountId) {
    const row = await withStore(STORES.entities, 'readonly', (store) => reqToPromise(store.get(entityId)));
    if (!row) return null;
    const acct = accountId || await getActiveAccountId();
    if (row.accountId !== acct) return null; // hard isolation
    return row;
  }

  async function queryByType(type, accountId) {
    const acct = accountId || await getActiveAccountId();
    return withStore(STORES.entities, 'readonly', (store) =>
      reqToPromise(store.index('byAccountType').getAll([acct, type]))
    );
  }

  async function queryByTrip(tripId, accountId) {
    if (!tripId) return [];
    const acct = accountId || await getActiveAccountId();
    const rows = await withStore(STORES.entities, 'readonly', (store) =>
      reqToPromise(store.index('byTrip').getAll(tripId))
    );
    return rows.filter((r) => r.accountId === acct);
  }

  async function putRelationship(partial) {
    const row = normalizeRelationship({ ...partial, accountId: partial.accountId || await getActiveAccountId() });
    if (!row.fromId || !row.toId || row.fromId === row.toId) return null;
    if (!row.fromId.startsWith(row.accountId + '|') || !row.toId.startsWith(row.accountId + '|')) {
      // Soft guard: relationships must stay inside one account boundary
      console.warn('DaylightStore: cross-account relationship blocked', row.id);
      return null;
    }
    await withStore(STORES.relationships, 'readwrite', (store) => reqToPromise(store.put(row)));
    return row;
  }

  async function putRelationships(list, opts) {
    if (!list?.length) return [];
    const accountId = opts?.accountId || list[0].accountId || await getActiveAccountId();
    const database = await open();
    const tx = database.transaction(STORES.relationships, 'readwrite');
    const store = tx.objectStore(STORES.relationships);
    const out = [];
    for (const partial of list) {
      const row = normalizeRelationship({ ...partial, accountId });
      if (!row.fromId || !row.toId || row.fromId === row.toId) continue;
      if (!row.fromId.startsWith(accountId + '|') || !row.toId.startsWith(accountId + '|')) continue;
      // eslint-disable-next-line no-await-in-loop
      await reqToPromise(store.put(row));
      out.push(row);
    }
    await txDone(tx);
    return out;
  }

  async function getRelationships(entityId, accountId) {
    const acct = accountId || await getActiveAccountId();
    const database = await open();
    const tx = database.transaction(STORES.relationships, 'readonly');
    const store = tx.objectStore(STORES.relationships);
    const [from, to] = await Promise.all([
      reqToPromise(store.index('byAccountFrom').getAll([acct, entityId])),
      reqToPromise(store.index('byAccountTo').getAll([acct, entityId]))
    ]);
    await txDone(tx);
    const map = new Map();
    [...from, ...to].forEach((r) => map.set(r.id, r));
    return [...map.values()];
  }

  async function putFact(partial) {
    const row = normalizeFact({ ...partial, accountId: partial.accountId || await getActiveAccountId() });
    await withStore(STORES.facts, 'readwrite', (store) => reqToPromise(store.put(row)));
    return row;
  }

  async function putFacts(list, opts) {
    if (!list?.length) return [];
    const accountId = opts?.accountId || list[0].accountId || await getActiveAccountId();
    const database = await open();
    const tx = database.transaction(STORES.facts, 'readwrite');
    const store = tx.objectStore(STORES.facts);
    const out = [];
    for (const partial of list) {
      const row = normalizeFact({ ...partial, accountId });
      // eslint-disable-next-line no-await-in-loop
      await reqToPromise(store.put(row));
      out.push(row);
    }
    await txDone(tx);
    return out;
  }

  function factValueKey(value) {
    if (value == null) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
  }

  /** Active (non-superseded) facts for an entity field within one account. */
  async function getActiveFacts(entityId, field, accountId) {
    const acct = accountId || await getActiveAccountId();
    const rows = await withStore(STORES.facts, 'readonly', (store) =>
      reqToPromise(store.index('byAccountEntity').getAll([acct, entityId]))
    );
    return rows.filter((f) => f.field === field && !f.supersededBy && f.verified !== 'rejected');
  }

  /**
   * Change detection: write a new fact only when value changed.
   * Prior active facts for the same field are marked supersededBy the new id.
   * Returns { fact, changed, previous }
   */
  async function upsertFactDetectChange(partial, opts) {
    const accountId = opts?.accountId || partial.accountId || await getActiveAccountId();
    const entityId = partial.entityId;
    const field = String(partial.field || 'value');
    const active = await getActiveFacts(entityId, field, accountId);
    const nextKey = factValueKey(partial.value);
    const same = active.find((f) => factValueKey(f.value) === nextKey);
    if (same) {
      return { fact: same, changed: false, previous: null };
    }
    const previous = active[0] || null;
    const salt = previous ? ('v' + (Date.now().toString(36))) : (partial.salt || 'v1');
    const fact = normalizeFact({ ...partial, accountId, salt });
    const database = await open();
    const tx = database.transaction(STORES.facts, 'readwrite');
    const store = tx.objectStore(STORES.facts);
    for (const old of active) {
      old.supersededBy = fact.id;
      old.updatedAt = now();
      // eslint-disable-next-line no-await-in-loop
      await reqToPromise(store.put(old));
    }
    await reqToPromise(store.put(fact));
    await txDone(tx);
    return { fact, changed: true, previous };
  }

  async function upsertFactsDetectChange(list, opts) {
    const out = [];
    for (const partial of list || []) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await upsertFactDetectChange(partial, opts));
    }
    return out;
  }

  async function enqueueAction(partial) {
    const accountId = partial.accountId || await getActiveAccountId();
    const idempotencyKey = String(partial.idempotencyKey || '');
    if (!idempotencyKey) throw new Error('idempotencyKey required');
    const database = await open();
    const tx = database.transaction(STORES.actions, 'readwrite');
    const store = tx.objectStore(STORES.actions);
    const existing = await reqToPromise(store.index('byAccountIdempotency').get([accountId, idempotencyKey]));
    if (existing && (existing.status === 'queued' || existing.status === 'running' || existing.status === 'succeeded')) {
      await txDone(tx);
      return existing;
    }
    const row = {
      id: existing?.id || partial.id || id.action(accountId),
      accountId,
      ownerId: partial.ownerId || accountId,
      idempotencyKey,
      kind: String(partial.kind || ''),
      payload: partial.payload || {},
      status: partial.status || 'queued',
      attempts: existing?.attempts || 0,
      lastError: null,
      resultSourceId: existing?.resultSourceId || null,
      sourceIdentity: normalizeSourceIdentity(partial, null),
      privacyClass: partial.privacyClass || PRIVACY.NORMAL,
      aiExclude: true,
      createdAt: existing?.createdAt || now(),
      updatedAt: now()
    };
    await reqToPromise(store.put(row));
    await txDone(tx);
    return row;
  }

  async function putReminder(partial) {
    const accountId = partial.accountId || await getActiveAccountId();
    const row = {
      id: partial.id || id.reminder(accountId),
      accountId,
      ownerId: partial.ownerId || accountId,
      title: String(partial.title || '').slice(0, 200),
      whenMs: +partial.whenMs || null,
      entityId: partial.entityId || null,
      status: partial.status || 'scheduled',
      source: partial.source || 'daylight',
      sourceIdentity: normalizeSourceIdentity(partial, null),
      privacyClass: partial.privacyClass || PRIVACY.NORMAL,
      aiExclude: partial.aiExclude != null ? !!partial.aiExclude : false,
      payload: partial.payload || {},
      createdAt: partial.createdAt || now(),
      updatedAt: now()
    };
    await withStore(STORES.reminders, 'readwrite', (store) => reqToPromise(store.put(row)));
    return row;
  }

  function emptySyncProvider() {
    return {
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastDurationMs: 0,
      retries: 0,
      fetched: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      cursor: null,
      mode: 'full',
      runs: 0
    };
  }

  function emptySyncBundle() {
    return {
      gmail: emptySyncProvider(),
      calendar: emptySyncProvider(),
      tasks: emptySyncProvider(),
      hydrate: emptySyncProvider(),
      updatedAt: null
    };
  }

  function syncMetaKey(accountId) {
    return 'sync:' + accountId;
  }

  async function getSyncState(accountId) {
    const acct = accountId || await getActiveAccountId();
    const state = await getMeta(syncMetaKey(acct), null);
    if (state && typeof state === 'object') return state;
    return emptySyncBundle();
  }

  async function patchSyncState(provider, patch, accountId) {
    const acct = accountId || await getActiveAccountId();
    const state = await getSyncState(acct);
    const prev = state[provider] || emptySyncProvider();
    state[provider] = { ...prev, ...patch };
    state.updatedAt = now();
    await setMeta(syncMetaKey(acct), state);
    return state[provider];
  }

  async function recordSyncSuccess(provider, stats, accountId) {
    const acct = accountId || await getActiveAccountId();
    const prev = await getSyncState(acct);
    return patchSyncState(provider, {
      lastSuccessAt: now(),
      lastFailureAt: null,
      lastError: null,
      lastDurationMs: stats.durationMs || 0,
      retries: stats.retries || 0,
      fetched: stats.fetched || 0,
      inserted: stats.inserted || 0,
      updated: stats.updated || 0,
      deleted: stats.deleted || 0,
      cursor: stats.cursor !== undefined ? stats.cursor : (prev[provider]?.cursor || null),
      mode: stats.mode || 'full',
      lastPartialAt: null,
      details: stats.details || null,
      runs: (prev[provider]?.runs || 0) + 1
    }, acct);
  }

  /**
   * A sync that finished but not completely (some records failed, waited for quota or kept a stale copy).
   * Keeps lastSuccessAt untouched so the UI can show the last *complete* sync honestly.
   */
  async function recordSyncPartial(provider, stats, accountId) {
    const acct = accountId || await getActiveAccountId();
    const prev = await getSyncState(acct);
    const s = stats || {};
    return patchSyncState(provider, {
      lastPartialAt: now(),
      lastError: String(s.summary || 'Partial sync').slice(0, 300),
      lastDurationMs: s.durationMs || 0,
      retries: s.retries || 0,
      fetched: s.fetched || 0,
      cursor: s.cursor !== undefined ? s.cursor : (prev[provider]?.cursor || null),
      mode: s.mode || 'partial',
      details: s.details || null,
      runs: (prev[provider]?.runs || 0) + 1
    }, acct);
  }

  async function recordSyncFailure(provider, err, stats, accountId) {
    const acct = accountId || await getActiveAccountId();
    return patchSyncState(provider, {
      lastFailureAt: now(),
      lastError: String(err?.message || err || 'Unknown error').slice(0, 300),
      lastDurationMs: stats?.durationMs || 0,
      retries: stats?.retries || 0,
      mode: stats?.mode || 'full'
    }, acct);
  }

  async function setMeta(key, value) {
    await withStore(STORES.meta, 'readwrite', (store) => reqToPromise(store.put({ key, value, updatedAt: now() })));
  }

  async function getMeta(key, fallback) {
    const row = await withStore(STORES.meta, 'readonly', (store) => reqToPromise(store.get(key)));
    return row ? row.value : fallback;
  }

  async function stats(accountId) {
    const acct = accountId || await getActiveAccountId();
    const database = await open();
    const names = [STORES.entities, STORES.relationships, STORES.facts, STORES.actions, STORES.reminders, STORES.accounts];
    const tx = database.transaction(names, 'readonly');
    const counts = { accounts: await reqToPromise(tx.objectStore(STORES.accounts).count()) };
    for (const name of [STORES.entities, STORES.relationships, STORES.facts, STORES.actions, STORES.reminders]) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await reqToPromise(tx.objectStore(name).index('byAccount').getAll(acct));
      counts[name] = rows.length;
    }
    await txDone(tx);
    return { ...counts, schema: SCHEMA_VERSION, accountId: acct };
  }

  async function clearAccountData(accountId) {
    const acct = accountId || await getActiveAccountId();
    const database = await open();
    const names = [STORES.entities, STORES.relationships, STORES.facts, STORES.actions, STORES.reminders];
    const tx = database.transaction([...names, STORES.accounts], 'readwrite');

    async function clearByAccount(storeName) {
      const store = tx.objectStore(storeName);
      const idx = store.index('byAccount');
      const rows = await reqToPromise(idx.getAllKeys(acct));
      for (const key of rows) {
        // eslint-disable-next-line no-await-in-loop
        await reqToPromise(store.delete(key));
      }
    }

    await Promise.all(names.map(clearByAccount));
    const acctRow = await reqToPromise(tx.objectStore(STORES.accounts).get(acct));
    if (acctRow && acctRow.kind !== 'local') {
      acctRow.status = 'disconnected';
      acctRow.updatedAt = now();
      await reqToPromise(tx.objectStore(STORES.accounts).put(acctRow));
    }
    await txDone(tx);
    await setMeta(syncMetaKey(acct), emptySyncBundle());
    await setMeta('lastClearedAt:' + acct, now());
  }

  /** @deprecated prefer clearAccountData(accountId) */
  async function clearProviderData() {
    return clearAccountData(await getActiveAccountId());
  }

  root.DaylightStore = {
    SCHEMA_VERSION,
    DB_NAME,
    STORES,
    PRIVACY,
    id,
    sourceKeyFor,
    privacyClassFor,
    normalizeEntity,
    normalizeRelationship,
    normalizeFact,
    open,
    upsertAccount,
    listAccounts,
    getAccount,
    setActiveAccount,
    getActiveAccountId,
    ensureActiveAccount,
    putEntity,
    putEntities,
    getEntity,
    queryByType,
    queryByTrip,
    putRelationship,
    putRelationships,
    getRelationships,
    putFact,
    putFacts,
    getActiveFacts,
    upsertFactDetectChange,
    upsertFactsDetectChange,
    enqueueAction,
    putReminder,
    setMeta,
    getMeta,
    getSyncState,
    patchSyncState,
    recordSyncSuccess,
    recordSyncPartial,
    recordSyncFailure,
    emptySyncProvider,
    stats,
    clearAccountData,
    clearProviderData
  };
})(typeof window !== 'undefined' ? window : globalThis);
