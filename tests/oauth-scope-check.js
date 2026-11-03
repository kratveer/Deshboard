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

// Worker source must still request readonly + send (send required for replies)
const fs = require('fs');
const path = require('path');
const worker = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'worker.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const checks = [
  [/gmail\.readonly/, worker, 'worker requests gmail.readonly'],
  [/gmail\.send/, worker, 'worker requests gmail.send'],
  [/include_granted_scopes: upgrade \? 'false' : 'true'/, worker, 'worker upgrade disables include_granted_scopes'],
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
process.exit(failed ? 1 : 0);
