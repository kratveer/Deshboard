/** Decodes a batch of grey images with Daylight's own reader (ui/code-reader.js). Usage: node reader-batch.js manifest.json out.json */
'use strict';
const fs = require('fs'), path = require('path');
const R = require(path.join(__dirname, '..', '..', 'ui', 'code-reader.js'));
const items = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = items.map((it) => {
  const data = new Uint8Array(fs.readFileSync(it.file));
  const t0 = Date.now(); let res = [];
  try { res = R.decode({ data, width: it.w, height: it.h }); } catch (e) { res = [{ error: String(e) }]; }
  return { id: it.id, res, ms: Date.now() - t0 };
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));
