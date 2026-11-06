/**
 * Phase 12 OAuth repair — pure scope helpers (mirrors server/src/worker.js contract).
 * Run: node tests/oauth-scope-check.js
 */
const scopeBlob = (s) => String(s || '');
const hasGmailReadonly = (s) => /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly(?:\s|$)/.test(scopeBlob(s));
const hasGmailSend = (s) => /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/gmail\.send(?:\s|$)/.test(scopeBlob(s));
const hasGmailMetadataOnly = (s) => /gmail\.metadata/.test(scopeBlob(s)) && !hasGmailReadonly(s);

const CASES = [
  {
    id: 'legacy-metadata-only',
    scope: 'openid email https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/calendar.events.readonly',
    expect: { readonly: false, send: false, metadataOnly: true, needsUpgrade: true }
  },
  {
    id: 'readonly-no-send',
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/tasks.readonly',
    expect: { readonly: true, send: false, metadataOnly: false, needsUpgrade: false }
  },
  {
    id: 'readonly-and-send',
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    expect: { readonly: true, send: true, metadataOnly: false, needsUpgrade: false }
  },
  {
    id: 'empty',
    scope: '',
    expect: { readonly: false, send: false, metadataOnly: false, needsUpgrade: true }
  },
  {
    id: 'false-positive-substring',
    scope: 'https://www.googleapis.com/auth/gmail.readonly.extra',
    expect: { readonly: false, send: false, metadataOnly: false, needsUpgrade: true }
  }
];

let failed = 0;
for (const c of CASES) {
  const actual = {
    readonly: hasGmailReadonly(c.scope),
    send: hasGmailSend(c.scope),
    metadataOnly: hasGmailMetadataOnly(c.scope),
    needsUpgrade: !hasGmailReadonly(c.scope)
  };
  const ok = Object.keys(c.expect).every((k) => actual[k] === c.expect[k]);
  if (!ok) {
    failed++;
    console.log('FAIL', c.id, { expected: c.expect, actual });
  } else console.log('OK', c.id);
}

// Worker source must request gmail.readonly (V2: read-only, no send)
const fs = require('fs');
const path = require('path');
const worker = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'worker.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const checks = [
  [/gmail\.readonly/, worker, 'worker requests gmail.readonly'],
  [/const mergePrior=false;/, app, 'browser-only sign-in never merges older grants'],
  [/include_granted_scopes: add && !upgrade \? 'true' : 'false'/, worker, 'worker: upgrade and normal sign-in never merge older grants; only adding a connector does'],
  [/gmail_readonly_required/, worker, 'worker rejects missing readonly'],
  [/needs_gmail_upgrade/, worker, 'token payload exposes needs_gmail_upgrade'],
  [/hasGmailReadonly/, app, 'app has hasGmailReadonly'],
  [/google-upgrade-readonly/, app, 'app reconnect button id'],
  [/q\.set\('upgrade','1'\)|upgrade:'1'/, app, 'app passes upgrade=1'],
  [/gmail\.metadata/, worker, 'worker must NOT request gmail.metadata as a scope']
];
// Last check inverted: worker GOOGLE_SCOPES must not include gmail.metadata
const scopesBlock = worker.match(/const GOOGLE_SCOPES = \[[\s\S]*?\]\.join/);
if (!scopesBlock) { failed++; console.log('FAIL worker GOOGLE_SCOPES block missing'); }
else if (/gmail\.metadata/.test(scopesBlock[0])) { failed++; console.log('FAIL worker GOOGLE_SCOPES still lists gmail.metadata'); }
else console.log('OK worker GOOGLE_SCOPES has no gmail.metadata');

for (const [re, src, label] of checks.slice(0, -1)) {
  if (!re.test(src)) { failed++; console.log('FAIL', label); }
  else console.log('OK', label);
}

console.log(failed ? `FAILED ${failed}` : 'All oauth-scope-check passed');
if (failed) process.exitCode = 1;

// ---- V2 minimum permission (Gmail read-only onboarding, incremental optional connectors) ----
{
  const fs2 = require('fs'), path2 = require('path');
  const w = fs2.readFileSync(path2.join(__dirname, '..', 'server', 'src', 'worker.js'), 'utf8');
  const a = fs2.readFileSync(path2.join(__dirname, '..', 'app.js'), 'utf8');
  const base = /const GOOGLE_SCOPES = \[([\s\S]*?)\]\.join/.exec(w)[1];
  const appBase = /const scopes = \[([^\]]*)\]\.join/.exec(a)[1];
  const v2 = [
    [!/gmail\.(send|compose|modify)|drive|fitness|calendar|tasks|contacts/.test(base) && /gmail\.readonly/.test(base), 'worker onboarding = openid/email/profile + gmail.readonly only'],
    [!/gmail\.(send|compose|modify)|drive|fitness|calendar|tasks|contacts/.test(appBase) && /gmail\.readonly/.test(appBase), 'app onboarding = gmail.readonly only'],
    [/OPTIONAL_SCOPES = \{[\s\S]*calendar[\s\S]*tasks[\s\S]*contacts/.test(w) && /scopesFor\(add\)/.test(w), 'worker supports incremental optional connectors'],
    [!/['"]https:\/\/www\.googleapis\.com\/auth\/gmail\.send['"]/.test(w.replace(/const hasGmailSend[^\n]*/, '')), 'worker never asks for gmail.send'],
    [/V2 read-only release/.test(a), 'app reply opens Gmail instead of sending'],
    [/DaylightDataReset\?\.deleteGmailData/.test(a), 'disconnect deletes local Gmail data']
  ];
  let f2 = 0;
  v2.forEach(([ok, name]) => { console.log((ok ? 'OK ' : 'FAIL ') + name); if (!ok) f2++; });
  if (f2) { console.log('V2 FAILED ' + f2); process.exitCode = 1; } else console.log('V2 permission checks passed');
}
