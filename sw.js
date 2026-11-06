// Daylight service worker: lets the app be installed and open offline.
// Network first for the app's own files (so updates appear at once), cached copy as fallback.
// Requests to Google and other services are never cached.
const CACHE='daylight-v112';
const SHELL=['./','index.html','app.js','gmail-sync.js','finance-intel.js','gmail-config.js','sync-scheduler.js','gmail-cache.js','gmail-rules.js','gmail-batch.js','ai-budget.js','sync-metrics.js','mail-dates.js','privacy/data-reset.js','privacy/account-inventory.js','graph/item-graph.js','classification/user-rules.js','classification/classifier.js','connectors/connector-registry.js','connectors/gmail-connector.js','actions/apply-action.js','privacy/processing-log.js','connectors/local-connector.js','ui/v2-model.js','ui/v2-sample.js','ui/v2-diagnostics.js','ui/codes.js','ui/code-reader.js','ui/v2-scan.js','ui/v2-app.js','ui/v2.css','ui/fonts/inter-400.woff','ui/fonts/inter-500.woff','ui/fonts/inter-600.woff','ui/fonts/inter-700.woff','ui/fonts/inter-800.woff','gmail-pipeline.js','email-classify.js','daylight-ai.js','scan-pipeline.js','file-text.js','outlook-sync.js','onedrive-sync.js','manifest.json','privacy.html','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const req=e.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin)return;
  e.respondWith(fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy))}return res}).catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))));
});
