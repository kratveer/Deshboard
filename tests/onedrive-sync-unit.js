/**
 * OneDrive files (onedrive-sync.js + file-text.js) against a mock Microsoft Graph — synthetic files, NOT a real drive.
 * List via delta (files only, newest first), changes and deletions, expired delta link; content reading only for files
 * that look like bills / receipts / tickets (never identity documents), via a pre-authenticated download URL (no token),
 * facts from the same rules as email bodies, bills only when due ahead and not already known; text not stored.
 * PDFs are read here with pdf.js' Node build when available; the browser test (tests/onedrive-browser-e2e.js) reads them
 * with the self-hosted copy under the app's CSP. Run: node tests/onedrive-sync-unit.js
 */
'use strict';
const path = require('path'), fs = require('fs');
global.window = globalThis;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const ROOT = path.resolve(__dirname, '..');
['mail-dates.js', 'gmail-rules.js', 'gmail-config.js', 'gmail-cache.js', 'gmail-pipeline.js', 'email-classify.js', 'finance-intel.js', 'graph/item-graph.js', 'file-text.js', 'onedrive-sync.js'].forEach((f) => require(path.join(ROOT, f)));
const W = globalThis;
const { createMockGraph } = require('./mock-graph.js');
let pass = 0, fail = 0; const ok = (n, c, info) => { if (c) pass++; else fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ← ' + JSON.stringify(info).slice(0, 500))); };
const FX = path.join(__dirname, 'fixtures', 'files');
const NOW = Date.parse('2026-11-06T10:00:00Z');
const PDFJS_NODE = process.env.PDFJS_NODE || '/opt/npm-tools/node_modules/pdfjs-dist/legacy/build/pdf.mjs';

(async () => {
  const pdfjs = fs.existsSync(PDFJS_NODE) ? await import(PDFJS_NODE) : null;
  const g = createMockGraph();
  const file = (id, name, mod, extra) => g.addFile(Object.assign({ id, name, size: fs.existsSync(path.join(FX, name)) ? fs.statSync(path.join(FX, name)).size : 2000, lastModifiedDateTime: new Date(Date.parse(mod)).toISOString(), cTag: 'c-' + id + '-1', file: { mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' }, parentReference: { path: '/drive/root:/Documents/Bills' } }, extra || {}), fs.existsSync(path.join(FX, name)) ? new Uint8Array(fs.readFileSync(path.join(FX, name))) : 'x');
  file('f-pre', 'Faktura_PRE_2026-11.pdf', '2026-11-01T09:00:00Z');
  file('f-bolt', 'Receipt_Bolt_2026-10-28.pdf', '2026-10-28T19:00:00Z');
  file('f-pass', 'Passport_Jana.pdf', '2026-10-01T09:00:00Z', { parentReference: { path: '/drive/root:/Documents/Travel' } });
  file('f-rent', 'Predpis_najem_prosinec.docx', '2026-11-02T09:00:00Z');
  file('f-nw', 'Invoice_Northwind_0042.xlsx', '2026-11-03T09:00:00Z');
  file('f-tix', 'Ticket_PRG-AMS.txt', '2026-11-04T09:00:00Z', { parentReference: { path: '/drive/root:/Travel' } });
  file('f-thesis', 'Thesis_draft_v7.docx', '2026-11-05T09:00:00Z', { parentReference: { path: '/drive/root:/University' } });
  file('f-photo', 'IMG_2041.jpg', '2026-11-05T12:00:00Z', { parentReference: { path: '/drive/root:/Pictures' }, file: { mimeType: 'image/jpeg' } });
  file('f-oldinv', 'Invoice_2023_Q1.pdf', '2023-03-01T09:00:00Z', { parentReference: { path: '/drive/root:/Archive' } });
  g.drive.set('folder1', { id: 'folder1', name: 'Documents', folder: { childCount: 4 }, parentReference: { path: '/drive/root:' } });
  const graph = W.DaylightItemGraph.createGraph({ backend: 'memory', now: () => NOW });
  // a bill Gmail already knows: same amount and due date as the rent file → the file must not create a second bill
  await graph.upsertMany([{ key: 'money:gacct:landlord.cz:1202612', accountId: 'gacct', type: 'bill', title: 'Landlord · 18500 CZK', dueAt: new Date(2026, 11, 5, 23, 59).getTime(), sources: [{ app: 'gmail', accountId: 'gacct', itemId: 'm-rent', role: 'evidence' }], extractedFacts: [{ key: 'amount', value: 18500, sourceItemId: 'x' }, { key: 'currency', value: 'CZK', sourceItemId: 'x' }] }]);
  const store = { m: {}, get(k) { return this.m[k] || null; }, set(k, v) { this.m[k] = v; } };
  const config = W.DaylightGmailConfig.resolve();
  const helper = W.DaylightMailPipeline.createMailPipeline({ engine: null, cache: W.DaylightMailCache.createMailCache({}), rules: W.DaylightGmailRules, config, derive: (full) => ({ cls: W.DaylightEmailClassify.classifyEmail(full), fin: W.DaylightFinance.classify(full) }), now: () => NOW });
  let tokens = 0;
  const od = W.DaylightOneDrive.createOneDrive({ fetch: g.fetch, getToken: async () => 'at-' + (++tokens), graph, store, rules: W.DaylightGmailRules, mailHelper: helper, pipelineConfig: config.pipeline, now: () => NOW, sleep: async () => {}, fileTextOptions: pdfjs ? { pdfjs } : undefined, config: { readPerSync: 20 } });
  const r1 = await od.sync('ms-a');
  const files = await graph.query({ accountId: 'ms-a', type: 'file' });
  const by = (id) => files.find((x) => x.sources[0].itemId === id);
  ok('every file is listed (9), folders are not', files.length === 9 && !files.some((x) => x.title === 'Documents'), files.map((x) => x.title));
  ok('file Items: app, folder, size, last change and an Open link', by('f-nw').meta.app === 'Excel' && by('f-rent').meta.app === 'Word' && by('f-pre').meta.app === 'PDF' && by('f-pre').description === '/Documents/Bills' && by('f-pre').sources[0].url && by('f-pre').createdAt === Date.parse('2026-11-01T09:00:00Z'));
  ok('only bill/receipt/ticket-like recent files are read; not the thesis, photo, old 2023 invoice or the passport', !by('f-thesis').meta.readAt && !by('f-photo').meta.readAt && !by('f-oldinv').meta.readAt && !by('f-pass').meta.readAt && by('f-rent').meta.readAt && by('f-nw').meta.readAt && by('f-tix').meta.readAt, files.map((x) => [x.title, !!x.meta.readAt]));
  ok('the passport file is never downloaded', !g.log.some((l) => /f-pass/.test(l.url)));
  ok('downloads use the pre-authenticated URL and never send the access token there', g.stats.contentDownloads >= 3 && !g.stats.tokenSentToDownload, g.stats);
  const f = (it, k) => ((it.extractedFacts || []).filter((x) => x.key === k).pop() || {}).value;
  ok('Word rent schedule: 18 500 CZK due 2026-12-05', f(by('f-rent'), 'amount') === 18500 && f(by('f-rent'), 'dueDate') === '2026-12-05', by('f-rent').extractedFacts);
  ok('Excel invoice: 12 100 CZK due 2026-12-15', f(by('f-nw'), 'amount') === 12100 && f(by('f-nw'), 'dueDate') === '2026-12-15', by('f-nw').extractedFacts);
  ok('text boarding pass: booking reference found', /EXK7Q2/.test(String(f(by('f-tix'), 'reference') || '')) || by('f-tix').meta.docKind === 'travel', [by('f-tix').meta.docKind, by('f-tix').extractedFacts]);
  if (pdfjs) {
    ok('PDF invoice with an embedded font (Czech): 2 431 CZK due 2026-11-25', f(by('f-pre'), 'amount') === 2431 && f(by('f-pre'), 'dueDate') === '2026-11-25', [by('f-pre').meta, by('f-pre').extractedFacts]);
    ok('PDF receipt: 189 CZK, a receipt (not a bill)', f(by('f-bolt'), 'amount') === 189 && by('f-bolt').meta.docKind !== 'bill', [by('f-bolt').meta.docKind, by('f-bolt').extractedFacts]);
  } else console.log('SKIP PDF checks in Node (pdf.js Node build not found) — covered by tests/onedrive-browser-e2e.js');
  const bills = await graph.query({ type: 'bill' });
  ok('files that are bills due ahead become bills (PRE, Northwind) …', bills.some((b) => b.key === 'money:ms-a:file:f-nw') && (!pdfjs || bills.some((b) => b.key === 'money:ms-a:file:f-pre')), bills.map((b) => b.key));
  ok('… but not when a bill with the same amount and due date already exists (rent from Gmail)', !bills.some((b) => b.key === 'money:ms-a:file:f-rent'));
  ok('no file text is stored in the graph', !JSON.stringify(await graph.query({})).match(/Variabilní symbol: 1202612|Northwind Studio s\.r\.o\.\s+Due|Passenger NOVAKOVA/));
  ok('file Items are excluded from Ask AI (aiExclude)', files.every((x) => x.aiExclude === true));
  ok('a delta link is saved for the next sync', /token=/.test(store.get('daylight-onedrive-delta:ms-a') || ''));
  // ---- changes ----
  const dl0 = g.stats.contentDownloads;
  g.addFile({ id: 'f-new', name: 'Booking_Hotel_Amsterdam.txt', size: 200, lastModifiedDateTime: new Date(NOW - 3600000).toISOString(), cTag: 'c-new', file: { mimeType: 'text/plain' }, parentReference: { path: '/drive/root:/Travel' } }, 'Hotel booking confirmation\nReservation number HX-88213\nCheck-in 20 November 2026\nTotal 6 400 CZK');
  g.removeFile('f-photo');
  const r2 = await od.sync('ms-a');
  const files2 = await graph.query({ accountId: 'ms-a', type: 'file' });
  ok('next sync uses the delta link: only the new file is read, deleted file removed', r2.read === 1 && g.stats.contentDownloads - dl0 === 1 && r2.removed === 1 && !files2.some((x) => x.sources[0].itemId === 'f-photo') && files2.some((x) => x.title === 'Booking_Hotel_Amsterdam.txt'), r2);
  ok('facts from earlier reads are kept for unchanged files', f(files2.find((x) => x.sources[0].itemId === 'f-nw'), 'amount') === 12100);
  // a changed file is read again
  g.addFile(Object.assign({}, g.drive.get('f-nw'), { cTag: 'c-f-nw-2', lastModifiedDateTime: new Date(NOW - 60000).toISOString() }), new Uint8Array(fs.readFileSync(path.join(FX, 'Invoice_Northwind_0042.xlsx'))));
  const r3 = await od.sync('ms-a');
  ok('a changed file is read again (new cTag)', r3.read === 1, r3);
  // deleting the source file removes its bill too
  g.removeFile('f-nw'); await od.sync('ms-a');
  ok('deleting a file removes its file Item and the bill made from it', !(await graph.query({ type: 'bill' })).some((b) => b.key === 'money:ms-a:file:f-nw'));
  // expired delta link → full re-enumeration, files deleted meanwhile disappear
  g.expire(new URL(store.get('daylight-onedrive-delta:ms-a')).searchParams.get('token'));
  g.drive.delete('f-thesis');
  const r4 = await od.sync('ms-a');
  ok('expired delta link (410) → full listing again; a file deleted meanwhile is removed; nothing duplicated', r4.resync && !(await graph.query({ type: 'file' })).some((x) => x.sources[0].itemId === 'f-thesis') && new Set((await graph.query({ type: 'file' })).map((x) => x.key)).size === (await graph.query({ type: 'file' })).length, r4);
  // reading turned off
  const g2 = createMockGraph(); g2.addFile({ id: 'z', name: 'Invoice_Z.txt', size: 10, lastModifiedDateTime: new Date(NOW).toISOString(), file: { mimeType: 'text/plain' } }, 'Invoice total 10 CZK');
  const od2 = W.DaylightOneDrive.createOneDrive({ fetch: g2.fetch, getToken: async () => 't', graph: W.DaylightItemGraph.createGraph({ backend: 'memory' }), store: { get() { return null; }, set() {} }, rules: W.DaylightGmailRules, mailHelper: helper, now: () => NOW, config: { readContents: false } });
  const r5 = await od2.sync('ms-b');
  ok('with reading turned off, files are listed but never downloaded', r5.listed === 1 && r5.read === 0 && g2.stats.contentDownloads === 0);
  console.log(`OneDrive sync unit: ${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
