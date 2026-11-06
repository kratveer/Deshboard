// Daylight key-date extraction from email text (deadlines, reminders, travel, events).
// Conservative by design: a date counts only when it is written explicitly (month name, ISO, or d.m.yyyy with a year,
// or "today/tomorrow" relative to when the email arrived) AND a deadline / reminder / travel / event word is near it.
// Prices ("19.99"), order dates, "paid on …" and "issued …" are never read as dates. No network, no DOM.
(function (root) {
  'use strict';
  const DAY = 86400000;
  const MON = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
    sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
    // Czech (nominative + genitive) and German
    leden: 0, ledna: 0, únor: 1, února: 1, březen: 2, března: 2, duben: 3, dubna: 3, květen: 4, května: 4, červen: 5, června: 5,
    červenec: 6, července: 6, srpen: 7, srpna: 7, září: 8, říjen: 9, října: 9, listopad: 10, listopadu: 10, prosinec: 11, prosince: 11,
    januar: 0, januar_: 0, februar: 1, märz: 2, mai: 4, juni: 5, juli: 6, oktober: 9, dezember: 11
  };
  const MON_RX = Object.keys(MON).filter((k) => !k.endsWith('_')).sort((a, b) => b.length - a.length).join('|');
  const KIND = [
    ['travel', /(flight|departs?|departure|boarding|check-?in|gate|train|bus|ferry|odjezd|odlet|let\b|hotel|stay|reservation|rezervac|booking|pick-?up|abfahrt|abflug|ticket|jízdenk|letenk)/i],
    ['reminder', /(reminder|appointment|scheduled for|your visit|consultation|interview|připomín|termín návštěvy|objednán|schůzk|erinnerung|\btermin\b)/i],
    ['deadline', /(due|deadline|submit|submission|send (?:it|us|the)|by\b|before\b|until|no later than|last day|expires?|expiry|valid (?:until|till)|apply by|rsvp|register by|renew by|splatnost|uhra[dď]|zaplať|do\b|nejpozději|termín|uzávěrk|lhůt|bis\b|fällig|frist|spätestens)/i],
    ['event', /(event|webinar|meeting|conference|concert|seminar|starts|begins|ceremony|exam|zkouš|koncert|vstupenk|veranstaltung)/i]
  ];
  const PAST = /(paid on|received on|ordered on|order date|sent on|shipped on|delivered on|issued|invoice date|datum vystavení|vystaveno|zaplaceno|objednáno|(?<!due |payment |pay )date:|(?<!splatnosti )datum:|\bon behalf|was due|bezahlt am|bestellt am)/i;

  function pad(n) { return String(n).padStart(2, '0'); }
  function localIso(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }

  /** All explicit dates in the text with their index. */
  function findDates(text, receivedMs) {
    const out = [];
    const rec = new Date(receivedMs || Date.now());
    const yearFor = (m, d) => { // no year written: the next occurrence on/after the email date
      let y = rec.getFullYear();
      if (new Date(y, m, d).getTime() < new Date(rec.getFullYear(), rec.getMonth(), rec.getDate()).getTime() - 2 * DAY) y++;
      return y;
    };
    let m;
    const reISO = /\b(20\d\d)-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/g;
    while ((m = reISO.exec(text))) out.push({ at: m.index, len: m[0].length, y: +m[1], mo: +m[2] - 1, d: +m[3], time: m[4] ? `${m[4]}:${m[5]}` : null, yearWritten: true });
    const reDMY = new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})\\.?\\s*(${MON_RX})\\.?(?:,?\\s*(20\\d\\d))?(?![\\p{L}])`, 'giu');
    while ((m = reDMY.exec(text))) { const mo = MON[m[2].toLowerCase()]; if (mo == null) continue; const d = +m[1]; if (d < 1 || d > 31) continue; out.push({ at: m.index, len: m[0].length, y: m[3] ? +m[3] : yearFor(mo, d), mo, d, yearWritten: !!m[3] }); }
    const reMDY = new RegExp(`(?<![\\p{L}])(${MON_RX})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d\\d))?(?![\\p{N}])`, 'giu');
    while ((m = reMDY.exec(text))) { const mo = MON[m[1].toLowerCase()]; if (mo == null) continue; const d = +m[2]; if (d < 1 || d > 31) continue; if (out.some((o) => Math.abs(o.at - m.index) < 4)) continue; out.push({ at: m.index, len: m[0].length, y: m[3] ? +m[3] : yearFor(mo, d), mo, d, yearWritten: !!m[3] }); }
    // d.m.yyyy / d. m. yyyy (year required, so prices like 19.99 never match)
    const reNum = /(?<![\d.,])(\d{1,2})\.\s?(\d{1,2})\.\s?(20\d\d)(?![\d])/g;
    while ((m = reNum.exec(text))) { const d = +m[1], mo = +m[2] - 1; if (d < 1 || d > 31 || mo < 0 || mo > 11) continue; out.push({ at: m.index, len: m[0].length, y: +m[3], mo, d, yearWritten: true }); }
    // dd/mm/yyyy only when unambiguous (day > 12)
    const reSl = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(20\d\d)(?![\d])/g;
    while ((m = reSl.exec(text))) { const a = +m[1], b = +m[2]; if (a > 12 && b <= 12) out.push({ at: m.index, len: m[0].length, y: +m[3], mo: b - 1, d: a, yearWritten: true }); }
    // today / tomorrow relative to the email
    const reRel = /\b(today|tonight|tomorrow|dnes|dneska|zítra|heute|morgen)\b/gi;
    while ((m = reRel.exec(text))) { const add = /tomorrow|zítra|morgen/i.test(m[1]) ? 1 : 0; const t = new Date(rec.getFullYear(), rec.getMonth(), rec.getDate() + add); out.push({ at: m.index, len: m[0].length, y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), relative: true, yearWritten: true }); }
    return out.filter((o) => { const dt = new Date(o.y, o.mo, o.d); return dt.getDate() === o.d && dt.getMonth() === o.mo; });
  }
  function timeNear(text, at, len) {
    const after = text.slice(at + len, at + len + 28), before = text.slice(Math.max(0, at - 22), at);
    // HH:MM, or HH.MM only with h/hod/am/pm, never inside a number or after a currency sign (prices are not times)
    const core = '(?<![\\d€$£₹.,])([01]?\\d|2[0-3])(?::([0-5]\\d)\\s*(am|pm|h|hod\\.?)?|\\.([0-5]\\d)\\s*(am|pm|h|hod\\.?))(?!\\d)|(?:at|um)\\s+([1-9]|1[0-2])\\s*(am|pm)';
    const rAfter = new RegExp(core, 'i'), rBefore = new RegExp('(?:at|um|v|ve|od|from)\\s+(?:' + core + ')', 'i');
    const m = rAfter.exec(after) || rBefore.exec(before);
    if (!m) return null;
    let h, mi;
    if (m[6]) { h = +m[6]; mi = 0; if (/pm/i.test(m[7]) && h < 12) h += 12; if (/am/i.test(m[7]) && h === 12) h = 0; }
    else { h = +m[1]; mi = +(m[2] != null ? m[2] : m[4]); const suf = m[3] || m[5] || ''; if (/pm/i.test(suf) && h < 12) h += 12; if (/am/i.test(suf) && h === 12) h = 0; }
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
    return `${pad(h)}:${pad(mi)}`;
  }
  function kindNear(text, at, len) {
    if (PAST.test(text.slice(Math.max(0, at - 30), at))) return null;
    // the keyword closest before the date decides (e.g. "připomínám … zaplať do 4. 11." is a deadline)
    const pre = text.slice(Math.max(0, at - 70), at), post = text.slice(at + len, at + len + 25);
    let best = null, bestPos = -1;
    for (const [k, rx] of KIND) {
      const g = new RegExp(rx.source, 'gi'); let mm, last = -1;
      while ((mm = g.exec(pre))) last = mm.index + mm[0].length;
      if (last > bestPos) { bestPos = last; best = k; }
    }
    if (best) return best;
    for (const [k, rx] of KIND) if (rx.test(post)) return k;
    return null;
  }
  function phraseAround(text, at, len) {
    // the sentence that contains the date (cut at sentence or line breaks, never mid-word)
    let s = at; while (s > 0 && at - s < 110 && !/[.!?\n]/.test(text[s - 1])) s--;
    while (s < at && /\S/.test(text[s - 1] || ' ') && s > 0 && at - s >= 110) s++;
    let e = at + len; while (e < text.length && e - at < 120 && !/[.!?\n]/.test(text[e])) e++;
    return text.slice(s, e + 1).replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  /**
   * extract(text, { receivedMs, subject }) → [{ kind, date:'YYYY-MM-DD', time:'HH:MM'|null, quote, relative, yearWritten }]
   * kind: deadline | reminder | travel | event
   */
  function extract(text, opt) {
    const o = opt || {};
    const full = `${o.subject || ''}\n${String(text || '')}`.slice(0, 6000);
    const found = findDates(full, o.receivedMs);
    const out = [], seen = new Set();
    for (const f of found) {
      const kind = kindNear(full, f.at, f.len);
      if (!kind) continue;
      const date = localIso(f.y, f.mo, f.d);
      const time = f.time || timeNear(full, f.at, f.len);
      const key = kind + date + (time || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, date, time, quote: phraseAround(full, f.at, f.len), relative: !!f.relative, yearWritten: !!f.yearWritten });
    }
    // keep the most specific item per date (travel/reminder with a time beats a bare deadline on the same day)
    const byDate = new Map();
    out.forEach((x) => { const p = byDate.get(x.date); const score = (x.time ? 2 : 0) + ({ travel: 3, reminder: 2, deadline: 2, event: 1 }[x.kind] || 0); if (!p || score > p._s) byDate.set(x.date, Object.assign({ _s: score }, x)); });
    return [...byDate.values()].map(({ _s, ...x }) => x).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 6);
  }
  /** Epoch ms for an extracted date (local time; date-only = 23:59 for deadlines, 09:00 otherwise, so ordering is sensible). */
  function toMs(kd) {
    const [y, m, d] = kd.date.split('-').map(Number);
    if (kd.time) { const [h, mi] = kd.time.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); }
    return new Date(y, m - 1, d, kd.kind === 'deadline' ? 23 : 9, kd.kind === 'deadline' ? 59 : 0).getTime();
  }

  const api = { extract, toMs, findDates };
  root.DaylightMailDates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
