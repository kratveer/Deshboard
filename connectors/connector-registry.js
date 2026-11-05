/**
 * Daylight connector framework (V2).
 * Every provider implements one contract so the Item Graph, sync scheduler, Connections page and privacy tools
 * treat them the same. Only Gmail is live; the others are registered as PLANNED: listed with what they would read,
 * never presented as working (connect() rejects with "not available yet").
 */
(function (root) {
  'use strict';
  const CONTRACT = ['connect', 'disconnect', 'getConnectionStatus', 'fetchItems', 'normalise', 'getCapabilities', 'getPermissions', 'sync', 'validateConnection'];

  function validate(c) {
    const missing = CONTRACT.filter((m) => typeof c[m] !== 'function');
    const errs = [];
    if (!c || !c.id) errs.push('id required');
    if (!['live', 'planned'].includes(c?.status)) errs.push('status must be live | planned');
    if (missing.length) errs.push('missing methods: ' + missing.join(', '));
    return errs;
  }

  /** A placeholder for a provider that is designed but not built. Honest by construction. */
  function planned(def) {
    const notYet = async () => { throw Object.assign(new Error(`${def.name} is not available yet`), { code: 'not_available' }); };
    return {
      id: def.id, name: def.name, status: 'planned', group: def.group || 'other', reads: def.reads, writes: def.writes || [],
      itemTypes: def.itemTypes || [], scopes: def.scopes || [], incrementalOf: def.incrementalOf || null,
      connect: notYet, disconnect: async () => ({ ok: true, deleted: 0 }), sync: notYet, fetchItems: notYet,
      normalise: () => ({ items: [], links: [] }), validateConnection: async () => ({ ok: false, reason: 'not available yet' }),
      getConnectionStatus: async () => ({ connected: false, available: false, label: 'Planned' }),
      getCapabilities: () => ({ read: def.itemTypes || [], write: [] }),
      getPermissions: () => (def.scopes || []).map((s) => ({ scope: s.scope || s, why: s.why || def.reads }))
    };
  }

  const CATALOGUE = [
    { id: 'google-calendar', name: 'Google Calendar', group: 'google', reads: 'Events and free time (read-only)', itemTypes: ['event'], incrementalOf: 'gmail', scopes: [{ scope: 'https://www.googleapis.com/auth/calendar.events.readonly', why: 'Show your events next to deadlines' }] },
    { id: 'google-tasks', name: 'Google Tasks', group: 'google', reads: 'Tasks and due dates (read-only)', itemTypes: ['task'], incrementalOf: 'gmail', scopes: [{ scope: 'https://www.googleapis.com/auth/tasks.readonly', why: 'Put your tasks into Plan' }] },
    { id: 'google-contacts', name: 'Google Contacts', group: 'google', reads: 'Names, photos and birthdays (read-only)', itemTypes: ['person'], incrementalOf: 'gmail', scopes: [{ scope: 'https://www.googleapis.com/auth/contacts.readonly', why: 'Recognise people and birthdays' }] },
    { id: 'outlook', name: 'Outlook mail + calendar', group: 'microsoft', reads: 'Mail and calendar, same as Gmail', itemTypes: ['email', 'event'] },
    { id: 'notion', name: 'Notion', group: 'work', reads: 'Tasks in databases, pages with dates, mentions', itemTypes: ['task', 'project'] },
    { id: 'todoist', name: 'Todoist', group: 'work', reads: 'Tasks, projects and priorities', itemTypes: ['task', 'project'] },
    { id: 'github', name: 'GitHub', group: 'work', reads: 'Review requests, assigned issues, failed checks, mentions', itemTypes: ['task'] },
    { id: 'slack', name: 'Slack', group: 'work', reads: 'Mentions, DMs, saved items', itemTypes: ['email'] },
    { id: 'spotify', name: 'Spotify', group: 'life', reads: 'Now playing, playlists, podcasts', itemTypes: [] }
  ];

  function createRegistry() {
    const map = new Map();
    const reg = {
      CONTRACT,
      register(c) { const errs = validate(c); if (errs.length) throw new Error(`connector ${c && c.id}: ${errs.join('; ')}`); map.set(c.id, c); return c; },
      get: (id) => map.get(id) || null,
      list: () => [...map.values()],
      live: () => [...map.values()].filter((c) => c.status === 'live'),
      planned: () => [...map.values()].filter((c) => c.status === 'planned'),
      /** Can Daylight write this action back to the provider? (V2 release: nothing is writable.) */
      canWrite(id, action) { const c = map.get(id); return !!(c && c.status === 'live' && (c.getCapabilities().write || []).includes(action)); }
    };
    CATALOGUE.forEach((d) => reg.register(planned(d)));
    return reg;
  }

  const api = { createRegistry, validate, planned, CATALOGUE, CONTRACT };
  root.DaylightConnectors = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
