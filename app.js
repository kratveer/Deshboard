// Daylight V2 core. Signs in through the Daylight server, runs the Gmail V2 engine, keeps the Item Graph up to date
// and hands a small host bridge to the V2 interface (ui/v2-app.js). Access tokens live in memory only.
(() => {
  'use strict';
  const W = window;
  // Version 1 (the classic dashboard) has been retired: a stored choice for it, or for the old demo mode, is removed.
  try { localStorage.removeItem('daylight-ui'); localStorage.removeItem('daylight-demo'); } catch {}
  const getLS=k=>{try{return localStorage.getItem(k)||''}catch{return''}},setLS=(k,v)=>{try{v?localStorage.setItem(k,v):localStorage.removeItem(k)}catch{}};
  let token=null,tokenExpiry=0;
  /* Gmail read-only is the only permission asked at sign-in. Calendar, Tasks and Contacts are optional connectors with their own consent. */
  const OPTIONAL_GOOGLE_SCOPES={
    calendar:'https://www.googleapis.com/auth/calendar.events.readonly',
    tasks:'https://www.googleapis.com/auth/tasks.readonly',
    contacts:'https://www.googleapis.com/auth/contacts.readonly'
  };
  let googleGrantedScope='';
  const rememberGoogleScopes=s=>{googleGrantedScope=String(s||'');setLS('daylight-google-scopes',googleGrantedScope)};
  const googleScopeBlob=()=>googleGrantedScope||getLS('daylight-google-scopes');
  const hasGmailReadonly=()=>/(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly(?:\s|$)|(?:^|\s)gmail\.readonly(?:\s|$)/.test(googleScopeBlob());
  /* An optional Google product is used only when the user turned that connector on in this release, never because of an older, broader grant. */
  const connectorOn=name=>getLS('daylight-connector-'+name)==='1';
  const hasGoogleScope=name=>{if(!connectorOn(name))return false;const sc=OPTIONAL_GOOGLE_SCOPES[name];return !!(sc&&googleScopeBlob().split(/\s+/).includes(sc))};
  /** Short notice through the V2 interface's own toast. */
  const toast=msg=>{try{if(W.DaylightV2UI?.toast){W.DaylightV2UI.toast(msg);return}}catch{}console.info('[Daylight]',msg)};

  // ---- Daylight server session (the only sign-in path) ----
  const SERVER_ERRORS={account_not_allowed:'That Google account is not allowed on your Daylight server.',access_denied:'Google sign-in was cancelled.',no_refresh_token:'Google did not grant offline access. Try signing in again.',token_exchange_failed:'Google sign-in could not be completed. Try again in a moment.',gmail_readonly_required:'Google did not grant permission to read Gmail. Sign in again and allow mail reading.'};
  const CONN_ERRORS={access_denied:'Adding the account was cancelled.',limit_reached:'Daylight connects at most 2 Google and 2 Microsoft accounts. Disconnect one first.',account_in_another_daylight:'That Google account signs in to another Daylight. Sign out there, or use that Daylight.',already_used:'That sign-in link was already used · try again.',sign_in_too_slow:'Adding the account took too long · try again.',gmail_readonly_required:'Daylight needs permission to read Gmail (read-only) for that account.',not_your_connection:'That account was added from another Daylight sign-in and was not attached.',expired:'Adding the account took too long · try again.',account_not_allowed:'That account is not allowed on your Daylight server.',consent_required:'The organisation must approve Daylight before this account can be connected.'};
  const MS_ERRORS={access_denied:'Microsoft sign-in was cancelled.',consent_required:'Your organisation must approve Daylight before you can connect this account.',account_not_allowed:'That Microsoft account is not allowed on your Daylight server.',mail_read_required:'Daylight needs permission to read your mail. Try connecting again and allow it.',no_refresh_token:'Microsoft did not allow Daylight to stay connected. Try again.',token_exchange_failed:'Microsoft sign-in could not be completed. Try again.',daylight_session_ended:'Your Daylight session ended. Sign in again, then connect Microsoft.',microsoft_not_configured:'Microsoft is not set up on your Daylight server yet.',sign_in_too_slow:'Microsoft sign-in took longer than 15 minutes. Try again.',already_used:'That Microsoft sign-in was already used. If Microsoft is not connected, try again.'};
  let serverUrl=(getLS('daylight-api')||(location.hostname==='kratveer.github.io'?'https://daylight-api.kratveer050.workers.dev':'')).replace(/\/+$/,''),serverSession=getLS('daylight-session'),serverEmail='',serverRenew=null,serverTokenPromise=null;
  let lastSyncOk=0,lastSyncErr='',syncBusy=false,lastRefreshStart=0;
  function readProfile(){try{return JSON.parse(localStorage.getItem('daylight-profile')||'{}')||{}}catch{return{}}}
  function renderProfile(){/* the V2 interface renders the profile itself (host.profile) */}
  // Pick up the session (or an error) the server hands back after Google sign-in.
  (()=>{if(!location.hash.includes('daylight_'))return;const h=new URLSearchParams(location.hash.slice(1));
    if(h.get('daylight_session')){
      const prevSession=serverSession;
      serverSession=h.get('daylight_session');setLS('daylight-session',serverSession);
      // a new sign-in may be another Google account: hide the previous profile and its Items until this one is confirmed
      setLS('daylight-profile','');
      // the previous server session is no longer reachable from this browser: delete its record on the server
      // (only on a server that understands keep_grant; an older Worker would revoke the Google grant instead)
      if(prevSession&&prevSession!==serverSession&&serverUrl)fetch(serverUrl+'/health').then(r=>r.json()).then(hh=>{if((hh.features||[]).includes('logout_keep_grant'))return fetch(serverUrl+'/auth/logout?keep_grant=1',{method:'POST',headers:{Authorization:'Bearer '+prevSession}})}).catch(()=>{});
      setTimeout(()=>toast('Signed in · Daylight will keep you connected'),600);
    }
    if(h.get('daylight_ms')==='connected'){setLS('daylight-ms-pending','1');setTimeout(()=>toast('Microsoft connected · reading Outlook and OneDrive'),600)}
    // connections_v1: a consent result waits on the server until THIS app (same identity) confirms it
    if(h.get('daylight_conn_pending'))setLS('daylight-conn-pending',h.get('daylight_conn_pending'));
    if(h.get('daylight_conn_error')){const e=h.get('daylight_conn_error');setTimeout(()=>toast(CONN_ERRORS[e]||('Could not add the account: '+e)),600)}
    if(h.get('daylight_ms_error')){setLS('daylight-ms-pending','');const e=h.get('daylight_ms_error');const msg=MS_ERRORS[e]||'Microsoft sign-in failed: '+e;setTimeout(()=>toast(msg),600)}
    if(h.get('daylight_error')){const msg=SERVER_ERRORS[h.get('daylight_error')]||'Sign-in failed: '+h.get('daylight_error');lastSyncErr=msg;setTimeout(()=>toast(msg),600)}
    history.replaceState(null,'',location.pathname+location.search)})();
  /* ---- Account identity gate: account data is shown only once THIS credential's owner is confirmed. ----
     A new sign-in, a token for a different email, or a missing owner record hides every account-specific Item
     until Google's userinfo confirms who it is. Device-local tasks and passes are not account data. */
  function sessionTag(){if(serverSession){let h=2166136261;for(const c of serverSession)h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return 's:'+h.toString(36)}return 'gis'}
  function readOwner(){try{return JSON.parse(localStorage.getItem('daylight-session-owner')||'null')}catch{return null}}
  let identityVerified=(()=>{const o=readOwner(),p=readProfile();return !!(o&&(p.sub||p.email)&&o.s===sessionTag()&&((p.sub&&o.sub===p.sub)||(!p.sub&&o.email===String(p.email||'').toLowerCase())))})();
  function markIdentity(p){
    const prev=readOwner();
    setLS('daylight-session-owner',JSON.stringify({s:sessionTag(),sub:p.sub||'',email:String(p.email||'').toLowerCase(),at:Date.now()}));
    try{const k=p.sub||p.email;if(k){const n=JSON.parse(localStorage.getItem('daylight-v2-account-names')||'{}');n[k]=String(p.email||'');localStorage.setItem('daylight-v2-account-names',JSON.stringify(n))}}catch{}
    identityVerified=true;
    dispatchEvent(new CustomEvent('daylight:account',{detail:{reason:'verified',changed:!prev||prev.sub!==(p.sub||'')}}));
  }
  function invalidateIdentity(reason,clearProfileToo){
    identityVerified=false;
    if(clearProfileToo){setLS('daylight-profile','');try{renderProfile()}catch{}}
    dispatchEvent(new CustomEvent('daylight:account',{detail:{reason}}));
  }
  async function api(url, opts, retried) {
    if(typeof opts==='boolean'){retried=opts;opts={}}
    // V2 guard: Calendar / Tasks / Contacts / Drive are only called for connectors the user turned on in this release
    {const u=String(url);const gate=/googleapis\.com\/calendar\//.test(u)?'calendar':/tasks\.googleapis\.com/.test(u)?'tasks':/people\.googleapis\.com/.test(u)?'contacts':/googleapis\.com\/drive\//.test(u)?'drive':null;
     if(gate&&!hasGoogleScope(gate)){const e=new Error('connector_off:'+gate);e.status=403;e.connectorOff=true;throw e}}
    opts=opts||{};
    if(serverSession&&Date.now()>tokenExpiry-60000)await serverToken();
    if(!token)throw new Error('Google is not connected');
    const init={method:opts.method||'GET',headers:{Authorization:`Bearer ${token}`}};
    if(opts.body!=null){init.headers['Content-Type']='application/json';init.body=typeof opts.body==='string'?opts.body:JSON.stringify(opts.body)}
    const r=await fetch(url,init);
    if(r.status===401&&serverSession&&!retried&&await serverToken())return api(url,opts,true);
    if(!r.ok){let detail='',code='',reason='';try{const j=await r.json();detail=j.error?.message||'';reason=j.error?.errors?.[0]?.reason||'';code=j.error?.status||reason||''}catch{}const err=new Error(detail||`Google API error (${r.status})`);err.status=r.status;err.code=code;err.reason=reason;err.retryAfterMs=retryAfterMsFrom(r);throw err}
    if(r.status===204)return null;
    const text=await r.text();if(!text)return null;
    try{return JSON.parse(text)}catch{return text}
  }
  function retryAfterMsFrom(r){const ra=r?.headers?.get?.('Retry-After');if(!ra)return null;const s=Number(ra);if(isFinite(s))return s*1000;const t=new Date(ra).getTime();return isFinite(t)?Math.max(0,t-Date.now()):null}
  // ---- Gmail: one shared sync engine (quota budget, concurrency limit, backoff, de-duplication) ----
  let gmailEng=null,lastGmailReport=null,lastGmailFullSyncAt=0;
  async function gmailRequest(url){
    if(serverSession&&Date.now()>tokenExpiry-60000)await serverToken();
    if(!token)return {ok:false,status:401,reason:'no_token',message:'Google is not connected'};
    const send=async()=>{const ctrl=typeof AbortController!=='undefined'?new AbortController():null;const tm=ctrl?setTimeout(()=>ctrl.abort(),20000):null;try{return await fetch(url,{headers:{Authorization:'Bearer '+token},signal:ctrl?.signal})}finally{if(tm)clearTimeout(tm)}};
    let r=await send();
    if(r.status===401&&serverSession&&await serverToken())r=await send();
    let data=null;try{const text=await r.text();data=text?JSON.parse(text):null}catch{}
    if(r.ok)return {ok:true,status:r.status,data};
    return {ok:false,status:r.status,data,reason:data?.error?.errors?.[0]?.reason||data?.error?.status||'',message:data?.error?.message||`Gmail API error (${r.status})`,retryAfterMs:retryAfterMsFrom(r)};
  }
  function gmailEngine(){
    if(gmailEng)return gmailEng;
    const GS=window.DaylightGmailSync;
    if(!GS?.createGmailSync)throw new Error('Gmail sync module did not load · reload Daylight');
    let qcfg={};try{qcfg={limitPerMinute:window.DaylightGmailConfig?.load?.().quota?.limitPerMinute||undefined}}catch{}
    gmailEng=GS.createGmailSync({request:gmailRequest,config:qcfg.limitPerMinute?qcfg:undefined});
    return gmailEng;
  }
  function resetGmailEngine(){try{gmailEng?.reset()}catch{}lastGmailReport=null;mailV2=null}
  // ---- Gmail v2: cost-optimised pipeline (persistent per-account cache, history-driven discovery, metadata + local
  // rules, selective bodies, HTTP batch, AI budget, sync slots). It is the only engine: a failure is recorded and shown, never replaced. ----
  let mailV2=null,lastGmailDecision=null,v2Channel=null,v2SlotTimer=null;
  const V2_AI_CAT={travel:'travel',bills:'bill',finance:'payment',subscriptions:'subscription',shopping:'receipt',delivery:'receipt',documents:'document',government:'document',security:'security',promotions:'promotion',newsletters:'newsletter',social:'social',personal:'personal',work:'personal'};
  function v2Enabled(){
    const W=window;
    if(!(W.DaylightMailPipeline&&W.DaylightGmailConfig&&W.DaylightMailCache&&W.DaylightGmailRules&&W.DaylightGmailBatch&&W.DaylightAiBudget&&W.DaylightSyncScheduler))return false;
    return true; /* V2 is the only engine */
  }
  function v2AccountKey(){const p=readProfile();return String(p.sub||p.email||serverEmail||'local')}
  async function gmailBatchPost(url,init){
    if(serverSession&&Date.now()>tokenExpiry-60000)await serverToken();
    if(!token)return {ok:false,status:401,text:async()=>'',headers:{get:()=>''}};
    const send=async()=>{const ctrl=new AbortController();const tm=setTimeout(()=>ctrl.abort(),30000);try{return await fetch(url,{...init,headers:{...(init.headers||{}),Authorization:'Bearer '+token},signal:ctrl.signal})}finally{clearTimeout(tm)}};
    let r=await send();
    if(r.status===401&&serverSession&&await serverToken())r=await send();
    return r;
  }
  function v2Derive(full){
    const Cls=window.DaylightEmailClassify,F=window.DaylightFinance;let cls=null,fin=null;
    try{cls=Cls?.classifyEmail?.(full)||null}catch{}
    try{fin=F?.classify?.(full)||null}catch{}
    return {cls,clsV:Cls?.VERSION,fin,finV:F?.VERSION};
  }
  /* ---- V2 Item Graph: one shared model (graph + connectors + rules + actions + privacy log) ---- */
  function v2Core(){
    if(v2Core.o)return v2Core.o;
    const W=window;if(!W.DaylightItemGraph||!W.DaylightConnectors)return null;
    let idb=null;try{idb=W.indexedDB||null}catch{}
    const graph=W.DaylightItemGraph.createGraph({indexedDB:idb});
    const ruleStore=W.DaylightUserRules.createRuleStore(graph);
    const registry=W.DaylightConnectors.createRegistry();
    const gmail=W.DaylightGmailConnector.createGmailConnector({graph,ruleStore,classifier:W.DaylightClassifier,get mailCache(){return getMailV2().cache},getAccountId:()=>v2AccountKey(),
      getStatus:async()=>({connected:Boolean(token||serverSession),account:readProfile().email||null,scopes:googleScopeBlob().split(/\s+/).filter(Boolean)})});
    registry.register(gmail);
    // Outlook: the same connector over the same mail cache, keyed by the linked Microsoft account
    const outlook=W.DaylightOutlookPipeline?W.DaylightGmailConnector.createGmailConnector({app:'outlook',name:'Outlook',group:'microsoft',urlOf:W.DaylightOutlookPipeline.outlookUrl,graph,ruleStore,classifier:W.DaylightClassifier,get mailCache(){return getMailV2().cache},getAccountId:()=>(msLink()||{}).account||null,
      reads:'Outlook mail (read-only) and your OneDrive file list; bills, receipts and tickets among your files are read on this device',
      permissions:[{scope:'Mail.Read',why:'Read your Outlook mail. Daylight cannot send, delete or change mail.'},{scope:'Files.Read',why:'List your OneDrive files and read the ones that look like bills or tickets, on this device.'}],
      getStatus:async()=>({connected:!!msLink(),account:(msLink()||{}).email||null})}):null;
    if(outlook)registry.register(outlook);
    const actions=W.DaylightActions.createActions({graph,registry,ruleStore,classifier:W.DaylightClassifier});
    const log=W.DaylightProcessingLog.createLog({graph});
    const local=W.DaylightLocalConnector?W.DaylightLocalConnector.createLocalConnector({graph,mailKey:(mid,acct)=>'gmail:'+(acct||v2AccountKey())+':'+mid,gmailAccounts:()=>{let a=[];try{a=a.concat(JSON.parse(localStorage.getItem('daylight-gmail-accounts')||'[]')||[]);a=a.concat(Object.keys(JSON.parse(localStorage.getItem('daylight-v2-account-names')||'{}')||{}))}catch{}return[...new Set(a.filter(x=>typeof x==='string'&&x))]}}):null;
    v2Core.o={graph,registry,gmail,outlook,ruleStore,actions,log,local};
    W.DaylightV2=v2Core.o; W.DaylightGraph=graph; W.DaylightPrivacyLog=log;
    return v2Core.o;
  }
  /** After each Gmail sync: mail cache → Item Graph (idempotent; keeps user actions and corrections). Watermark = ingest start: sync always finishes before ingest, so anything processed later has a later lastProcessedAt. */
  async function v2IngestGmail(){
    const c=v2Core();if(!c||!v2Enabled())return null;
    if(!identityVerified){v2IngestGmail.last={skipped:'account not confirmed yet',at:Date.now()};return null}
    const key='daylight-graph-ingest:x5:'+v2AccountKey(); /* x5 (v108): receipts are never bills; tax documents no longer merge into their order → one full re-ingest */let since=0;try{since=Number(localStorage.getItem(key))||0}catch{}const fbKey='daylight-graph-ingest-fb1:'+v2AccountKey();/* v112: review / feedback requests are no bookings → one full re-ingest (the x5 watermark is kept) */try{if(!localStorage.getItem(fbKey))since=0}catch{}
    const t0=Date.now();
    try{const r=await c.gmail.ingest(v2AccountKey(),{since});try{localStorage.setItem(key,String(t0));localStorage.setItem(fbKey,String(t0))}catch{};try{await c.local?.importLocal()}catch(e){console.warn('local import',e)};v2IngestGmail.last=c.lastIngest={...r,at:Date.now(),ms:Date.now()-t0,incremental:!!since};try{const lk='daylight-v2-ingest-log:'+v2AccountKey();const l=JSON.parse(localStorage.getItem(lk)||'[]');l.push(c.lastIngest);localStorage.setItem(lk,JSON.stringify(l.slice(-20)))}catch{};return r}catch(e){console.warn('graph ingest',e);try{localStorage.setItem('daylight-v2-engine-error:'+v2AccountKey(),JSON.stringify({at:Date.now(),stage:'graph ingest',message:String(e&&e.message||e).slice(0,300)}))}catch{};v2IngestGmail.last={error:String(e?.message||e),at:Date.now()};return null}
  }
  function getMailV2(){
    if(mailV2)return mailV2;
    const W=window,config=W.DaylightGmailConfig.load();
    let idb=null;try{idb=window.indexedDB||null}catch{}
    const cache=W.DaylightMailCache.createMailCache({indexedDB:idb,dbName:config.cache.dbName});
    const pipe=W.DaylightMailPipeline.createMailPipeline({engine:gmailEngine(),cache,rules:W.DaylightGmailRules,config,batch:W.DaylightGmailBatch,batchSend:W.DaylightGmailBatch.createSender(gmailBatchPost),derive:v2Derive,fullFields:W.DaylightGmailSync.FULL_FIELDS});
    const budget=W.DaylightAiBudget.createAiBudget({cache,config});
    const lock=W.DaylightSyncScheduler.createLock({name:config.schedule.lockName+':'+v2AccountKey(),leaseMs:config.schedule.lockLeaseMs});
    mailV2={config,cache,pipe,budget,lock};
    return mailV2;
  }
  const v2LastKey=()=>'daylight-gmail-last-sync:'+v2AccountKey();
  function v2Accounts(){try{return JSON.parse(localStorage.getItem('daylight-gmail-accounts')||'[]')}catch{return []}}
  function v2RememberAccount(k){try{const a=v2Accounts();if(!a.includes(k)){a.push(k);localStorage.setItem('daylight-gmail-accounts',JSON.stringify(a.slice(-10)))}}catch{}}
  function lastGmailSyncAt(){try{return Number(localStorage.getItem(v2LastKey()))||0}catch{return 0}}
  /** One Gmail pass for this refresh: decides (slots / 15-min skip / manual), takes the cross-tab lock, runs or reads the cache. */
  async function v2GmailSync(trigger,extra){
    const v=getMailV2(),acct=v2AccountKey(),S=window.DaylightSyncScheduler;
    const d=S.decide({trigger,now:Date.now(),lastSyncAt:lastGmailSyncAt(),schedule:v.config.schedule,slotAt:extra?.slotAt});
    lastGmailDecision={...d,at:Date.now(),trigger};
    if(!d.run)return v.pipe.fromCache(acct,d.reason);
    const aiOn=!!(window.DaylightAI?.isEnabled?.()&&window.DaylightAI?.getConsent?.());
    const lk=await v.lock.withLock(()=>v.pipe.run({accountId:acct,label:d.label,aiEnabled:aiOn,olderScan:!!extra?.olderScan}));
    if(!lk.ran){lastGmailDecision.reason='another tab is syncing';return v.pipe.fromCache(acct,'another tab is syncing')}
    const out=lk.result;
    v2RememberAccount(acct);
    if(!out.report.fatal&&out.report.pipeline?.mode!=='profile-failed'){
      try{localStorage.setItem(v2LastKey(),String(Date.now()))}catch{}
      try{v2Channel?.postMessage({type:'synced',account:acct,at:Date.now()})}catch{}
    }
    return out;
  }
  function v2ArmSlots(){
    if(!v2Enabled())return;
    const S=window.DaylightSyncScheduler,cfg=window.DaylightGmailConfig.load().schedule;
    clearTimeout(v2SlotTimer);
    if(!cfg.timersWhileOpen)return;
    const n=S.nextSlot(Date.now(),cfg.slots);if(!n)return;
    v2SlotTimer=setTimeout(()=>{if((token||serverSession)&&!syncBusy){refreshAll.trigger='slot';refreshAll.slotAt=n;refreshAll()}v2ArmSlots()},Math.min(2**31-1,Math.max(1000,n-Date.now()+2000)));
  }
  try{
    v2Channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('daylight-sync'):null;
    if(v2Channel)v2Channel.onmessage=e=>{if(e.data?.type==='synced'&&e.data.account===v2AccountKey()&&document.visibilityState==='visible'&&token&&!syncBusy){refreshAll.trigger='peer';refreshAll()}};
  }catch{}
  /** Start Google sign-in on the Daylight server. switch=1 shows Google's account chooser; upgrade=1 asks for a clean consent. */
  function signIn(opts={}){
    if(!serverUrl){toast('Sign-in needs the Daylight server, which is not configured for this address');return}
    const q=new URLSearchParams({return:location.origin+location.pathname});
    if(opts.switch)q.set('switch','1');
    if(opts.upgrade)q.set('upgrade','1');
    location.href=serverUrl+'/auth/google/start?'+q.toString();
  }
  function clearServerSession(msg){
    serverSession='';setLS('daylight-session','');token=null;rememberGoogleScopes('');resetGmailEngine();clearTimeout(serverRenew);
    try{connsApi()?.clear()}catch{}
    try{invalidateIdentity('signed-out',false)}catch{}
    if(msg)lastSyncErr=msg;
  }
  async function serverToken(){
    if(!serverUrl||!serverSession)return false;
    if(serverTokenPromise)return serverTokenPromise;
    serverTokenPromise=(async()=>{try{
      const r=await fetch(serverUrl+'/api/google/token',{method:'POST',headers:{Authorization:'Bearer '+serverSession}});
      let d={};try{d=await r.json()}catch{}
      if(r.status===401){clearServerSession('Google sign-in expired · sign in again');return false}
      if(!r.ok){
        // a dead or revoked session: clear it and ask for a new sign-in (local Daylight data is kept)
        if(r.status===502||d.error==='google_unavailable'){clearServerSession('Google session needs a new sign-in');return false}
        throw new Error('server '+r.status);
      }
      token=d.access_token;serverEmail=d.email||'';tokenExpiry=Date.now()+(Number(d.expires_in)||3600)*1000;
      {const pe=String(readProfile().email||'').toLowerCase();if(serverEmail&&pe&&pe!==serverEmail.toLowerCase())invalidateIdentity('token-belongs-to-another-account',true)}
      if(d.scope)rememberGoogleScopes(d.scope);
      if(d.needs_gmail_upgrade||d.gmail_readonly===false||(d.scope&&!hasGmailReadonly())){lastSyncErr='Google did not grant permission to read Gmail · sign in again';if(!serverToken._hinted){serverToken._hinted=true;toast('Sign in again and allow Daylight to read Gmail')}}
      clearTimeout(serverRenew);serverRenew=setTimeout(serverToken,Math.max(60,(Number(d.expires_in)||3600)-180)*1000);return true;
    }catch(e){lastSyncErr='Could not reach the Daylight server · retrying soon';clearTimeout(serverRenew);serverRenew=setTimeout(serverToken,120000);return false}
    finally{serverTokenPromise=null}})();
    return serverTokenPromise;
  }
  // ---- Profile (Google userinfo) confirms who is signed in ----
  async function loadProfile(){
    try{
      if(!token)return;
      const u=await api('https://www.googleapis.com/oauth2/v3/userinfo');
      if(u&&(u.email||u.sub)){
        const prevP=readProfile();if(prevP.sub&&u.sub&&prevP.sub!==u.sub)invalidateIdentity('switched',false);
        setLS('daylight-profile',JSON.stringify({name:u.name||'',picture:u.picture||'',email:u.email||'',sub:u.sub||''}));
        markIdentity(u);
      }
    }catch(e){console.warn('profile',e)}
  }
  // ---- Microsoft: an extra connection of this Daylight session (Outlook mail + OneDrive files), read-only ----
  const msKey=()=>'daylight-ms-link:'+v2AccountKey();
  function msLink(){
    if(connsOn()){const c=identityVerified?connMs()[0]:null;return c?{account:c.accountKey,email:c.email,name:c.name,mailRead:!!c.mail_read,filesRead:c.files_read!==false,needsReconnect:c.status==='needs_reconnect',connId:c.id}:null}
    try{return identityVerified?JSON.parse(localStorage.getItem(msKey())||'null'):null}catch{return null}}
  // F1 (v112): a cached Microsoft access token is bound to the account it was issued for and to the account generation.
  // The generation (daylight-ms-gen:<google login>) changes whenever the linked Microsoft account changes, is lost or is
  // disconnected — in any tab. A sync captures (account, generation) at the start and re-checks both before every write.
  let msTok=null,msBusy=false,msLast=null,msErr='',msV2=null; // msTok = { token, exp, account, gen }
  const msGenKey=(owner)=>'daylight-ms-gen:'+(owner||v2AccountKey());
  const msGen=()=>getLS(msGenKey());
  function bumpMsGen(owner){const g=Date.now().toString(36)+Math.random().toString(36).slice(2,8);setLS(msGenKey(owner),g);msTok=null;return g}
  // another tab changed the linked account or its generation → this tab's cached token is no longer trusted
  addEventListener('storage',e=>{if(!e.key||e.key.startsWith('daylight-ms-link:')||e.key.startsWith('daylight-ms-gen:'))msTok=null});
  // ---- Account inventory (Phase 0): data of accounts no longer linked is hidden at once, listed in Settings, kept 30 days with a warning ----
  let invObj=null;
  function inventory(){if(invObj)return invObj;if(!W.DaylightAccountInventory)return null;let mc=null;try{mc=v2Enabled()?getMailV2().cache:null}catch{};invObj=W.DaylightAccountInventory.createInventory({graph:v2Core()?.graph,mailCache:mc,connected:()=>connsOn()&&identityVerified?connsApi().list().map(c=>c.accountKey):[]});return invObj}
  const replacedKey=()=>'daylight-ms-replaced:'+v2AccountKey();
  /** Delete one account's data from this device safely: never the signed-in account; the Microsoft link goes first (no new
   *  syncs), deletion runs under that account's sync lock (a sync in another tab finishes first), then a local tombstone. */
  async function deleteDeviceAccount(key){
    const inv=inventory();if(!inv||!key)throw new Error('nothing to delete');
    const rows=await inv.scan(identityVerified?v2AccountKey():null);const row=rows.find(r=>r.key===key);
    if(!row)return {graphItems:0,deleted:false};
    if(row.status==='active')throw new Error('This account is connected · use Disconnect');
    let mc=null;try{mc=v2Enabled()?getMailV2().cache:null}catch{}
    let report=null;
    if(row.provider==='microsoft'){
      Object.keys(inv.links()).forEach(owner=>{const v=inv.links()[owner];if(v&&v.account===key){setLS('daylight-ms-link:'+owner,'');bumpMsGen(owner)}});
      const lock=W.DaylightSyncScheduler.createLock({name:'daylight-ms-sync:'+key,leaseMs:120000});
      for(let i=0;i<40;i++){const r=await lock.withLock(()=>W.DaylightDataReset.deleteMicrosoftData({accountId:key,mailCache:mc}));if(r.ran){report=r.result;break}await new Promise(res=>setTimeout(res,750))}
      if(!report)throw new Error('Another tab is syncing this account · try again in a minute');
    }else report=await W.DaylightDataReset.deleteGmailData({accountId:key,active:false,mailCache:mc});
    inv.markDeleted(key);
    try{const p=JSON.parse(getLS(replacedKey())||'null');if(p&&p.old){p.old=p.old.filter(x=>x.key!==key);setLS(replacedKey(),p.old.length?JSON.stringify(p):'')}}catch{}
    return Object.assign({deleted:true,provider:row.provider},report||{});
  }
  /** Delete orphans whose retention ended (only after a warning was shown for at least 7 days). */
  async function accountHousekeeping(){
    const inv=inventory();if(!inv||!identityVerified)return [];
    const rows=await inv.scan(v2AccountKey());const done=[];
    for(const r of rows.filter(x=>x.status==='orphan'&&x.deletable)){try{await deleteDeviceAccount(r.key);done.push(r.key)}catch(e){console.warn('retention delete',e)}}
    return done;
  }
  /** A short-lived Microsoft access token from the Daylight server (memory only). Also records which Microsoft account is linked. */
  async function msToken(force){
    const cur=msLink();
    if(!force&&msTok&&cur&&msTok.account===cur.account&&msTok.gen===msGen()&&Date.now()<msTok.exp-60000)return msTok.token;
    if(!serverUrl||!serverSession)throw new Error('not signed in');
    const r=await fetch(serverUrl+'/api/microsoft/token',{method:'POST',headers:{Authorization:'Bearer '+serverSession}});
    const d=await r.json().catch(()=>({}));
    if(r.status===404){msTok=null;const was=msLink();setLS(msKey(),'');if(was)bumpMsGen();if(was&&was.account)inventory()?.markOrphan(was.account,'connection lost',{owner:v2AccountKey(),email:was.email||'',provider:'microsoft'});throw new Error('Microsoft is not connected')}
    if(r.status===401){msTok=null;if(d.error==='ms_reauth'){const l=msLink();if(l){l.needsReconnect=true;setLS(msKey(),JSON.stringify(l))}}throw new Error(d.error==='ms_reauth'?'Microsoft sign-in expired · connect again':'Daylight sign-in expired')}
    if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
    if(!d.access_token||!d.account){msTok=null;throw new Error('Microsoft did not say which account this token is for')} // fail closed
    const prev=msLink()||{};
    if(prev.account!==d.account||!msGen())bumpMsGen(); // a different account (or the first one): new generation
    const inv=inventory();
    if(inv){
      if(prev.account&&prev.account!==d.account)inv.markOrphan(prev.account,'replaced',{owner:v2AccountKey(),email:prev.email||'',provider:'microsoft'});
      inv.connected(d.account,{provider:'microsoft',email:d.email||'',owner:v2AccountKey()});
      const olds=inv.orphansOf(v2AccountKey(),d.account);
      if(olds.length)setLS(replacedKey(),JSON.stringify({old:olds,now:{key:d.account,email:d.email||''},at:Date.now()}));
    }
    setLS(msKey(),JSON.stringify({...(prev.account===d.account?prev:{}),account:d.account,email:d.email,name:d.name,mailRead:!!d.mail_read,filesRead:!!d.files_read,needsReconnect:false,connectedAt:(prev.account===d.account&&prev.connectedAt)||Date.now()}));
    msTok={token:d.access_token,exp:Date.now()+(Number(d.expires_in)||3600)*1000,account:d.account,gen:msGen()};
    return msTok.token;
  }
  /** A token for exactly this account and generation, or an error (never a token of another account). */
  async function msTokenFor(acct,gen,force){
    const changed=()=>{const l=msLink();return !l||l.account!==acct||msGen()!==gen};
    if(changed())throw new Error('Microsoft account changed · sync stopped');
    if(!force&&msTok&&msTok.account===acct&&msTok.gen===gen&&Date.now()<msTok.exp-60000)return msTok.token;
    await msToken(true);
    if(changed()||!msTok||msTok.account!==acct||msTok.gen!==gen)throw new Error('Microsoft account changed · sync stopped');
    return msTok.token;
  }
  function getMsV2(){
    if(msV2)return msV2;
    const v=getMailV2(),R=W.DaylightGmailRules;
    const helper=W.DaylightMailPipeline.createMailPipeline({engine:null,cache:v.cache,rules:R,config:v.config,derive:v2Derive});
    msV2={helper,cache:v.cache,config:v.config};
    return msV2;
  }
  const msReadFiles=()=>getLS('daylight-ms-read-files')!=='0';
  /** Outlook (same 15-minute rhythm as Gmail, every refresh when asked), then the Item Graph, then OneDrive (hourly). */
  async function v2MicrosoftSync(force){
    if(!serverSession||!identityVerified||!W.DaylightOutlookPipeline||!v2Enabled())return null;
    let link=msLink();const pending=getLS('daylight-ms-pending')==='1';
    if(!link&&!pending)return null;
    if(link&&link.needsReconnect&&!pending)return null;
    try{await msToken(pending)}catch(e){msErr=String(e.message||e);setLS('daylight-ms-pending','');return null}
    setLS('daylight-ms-pending','');link=msLink();const acct=link&&link.account,gen=msGen();if(!acct||!gen)return null; // fail closed
    try{await msTokenFor(acct,gen,false)}catch(e){msErr=String(e.message||e);return null} // the token must belong to this account
    const last=Number(getLS('daylight-ms-last-sync:'+acct))||0;
    if(!force&&!pending&&Date.now()-last<15*60000)return null;
    const c=v2Core(),v=getMsV2();
    const lock=W.DaylightSyncScheduler.createLock({name:'daylight-ms-sync:'+acct,leaseMs:v.config.schedule.lockLeaseMs});
    msBusy=true;
    try{
      const mine=()=>{const l=msLink();return !!(l&&l.account===acct)&&msGen()===gen&&!(inventory()&&inventory().isDeleted(acct))};
      const getToken=f=>msTokenFor(acct,gen,!!f);
      const pipe=W.DaylightOutlookPipeline.createOutlookPipeline({getToken,guard:mine,cache:v.cache,rules:W.DaylightGmailRules,config:v.config,derive:v2Derive});
      const lk=await lock.withLock(async()=>{
        if(!mine())return {aborted:true};
        const mail=(await pipe.run({accountId:acct})).report;
        if(!mine())return {aborted:true}; // replaced, disconnected or deleted while syncing: stop (a deletion clears its data under this lock)
        const key='daylight-graph-ingest:ms1:'+acct,fbKey='daylight-graph-ingest-fb1:'+acct,since=getLS(fbKey)?(Number(getLS(key))||0):0,t0=Date.now(); /* v112: one full re-ingest for feedback requests */
        if(!mine())return {aborted:true};
        const ingest=await c.outlook.ingest(acct,{since,guard:mine});if(!mine())return {aborted:true};setLS(key,String(t0));setLS(fbKey,String(t0));
        let files=null;const fl=Number(getLS('daylight-onedrive-last:'+acct))||0;
        if(!mine())return {aborted:true};
        if(link.filesRead!==false&&W.DaylightOneDrive&&(force||pending||Date.now()-fl>60*60000)){
          const od=W.DaylightOneDrive.createOneDrive({getToken,guard:mine,graph:c.graph,store:{get:getLS,set:setLS},rules:W.DaylightGmailRules,mailHelper:v.helper,pipelineConfig:v.config.pipeline,config:{readContents:msReadFiles()}});
          files=await od.sync(acct);if(files.ok)setLS('daylight-onedrive-last:'+acct,String(Date.now()));
        }
        return {mail,ingest,files};
      });
      if(lk.ran&&lk.result&&lk.result.aborted)return null;
      if(lk.ran){msLast={...lk.result,at:Date.now()};msErr=lk.result.mail.fatal?lk.result.mail.summary:(lk.result.files&&!lk.result.files.ok?'OneDrive could not be read':'');if(!lk.result.mail.fatal)setLS('daylight-ms-last-sync:'+acct,String(Date.now()))}
      return lk.ran?lk.result:null;
    }catch(e){if(e&&e.aborted){msErr='';return null}console.warn('microsoft sync',e);msErr=String(e&&e.message||e);return null}
    finally{msBusy=false}
  }
  /** Disconnect Microsoft: the server forgets its token; this device deletes the Microsoft account's data. */
  async function disconnectMicrosoft(){
    const link=msLink();
    if(serverSession){try{await fetch(serverUrl+'/api/microsoft/disconnect',{method:'POST',headers:{Authorization:'Bearer '+serverSession}})}catch{}}
    msTok=null;msLast=null;msErr='';setLS('daylight-ms-pending','');
    let report=null;
    setLS(msKey(),'');bumpMsGen(); // no new syncs for it from here on; running ones stop before their next write
    if(link&&link.account){inventory()?.markOrphan(link.account,'disconnected',{owner:v2AccountKey(),email:link.email||'',provider:'microsoft'});try{report=await deleteDeviceAccount(link.account)}catch(e){console.warn('delete microsoft data',e)}}
    return report;
  }

  // ---- Connections (connections_v1, Phase B): up to 2 Google + 2 Microsoft accounts of one Daylight identity ----
  // The Google account this device signed in with keeps today's engine (token from /api/google/token). Every OTHER
  // connection gets its own engine here: its own token (per connection, bound to account + generation), its own sync
  // lock, watermarks, checkpoint, status and backoff. Accounts sync one after another; one failing never stops the rest.
  var connsObj=null,connsFeature=null,connsBusy=false; // var: functions above may run before this line
  function connsApi(){if(connsObj)return connsObj;if(!W.DaylightConnections)return null;connsObj=W.DaylightConnections.createConnections({serverUrl:()=>serverUrl,session:()=>serverSession,sessionTag});return connsObj}
  /** Does the Daylight server support connections_v1? (checked once per page; remembered for the next start) */
  function connsOn(){if(connsFeature===null)connsFeature=getLS('daylight-server-connections')==='1';return !!(connsFeature&&serverSession&&connsApi())}
  async function connsProbe(){
    if(!serverUrl||!serverSession||!connsApi())return false;
    if(connsProbe.done)return connsOn();
    // the connection list itself is the probe (authenticated; an older Worker answers 404)
    try{connsFeature=true;await connsApi().refresh();setLS('daylight-server-connections','1');connsProbe.done=true}
    catch(e){if(e.status===404){connsFeature=false;setLS('daylight-server-connections','');connsProbe.done=true}else connsFeature=getLS('daylight-server-connections')==='1'}
    return connsOn();
  }
  const loginConnId=()=>(connsApi()?.mirror()||{}).login||null;
  const otherConns=()=>connsOn()?connsApi().list().filter(c=>c.id!==loginConnId()):[];
  function connMs(){return connsOn()?connsApi().list().filter(c=>c.provider==='microsoft'):[]}
  /** A cache whose every write first checks that the account is still connected (same generation, not deleted). */
  function guardedCache(cache,guard){
    const g=Object.create(cache);
    ['putMany','putFacts','setCheckpoint','markDeleted','updateLabels','addMetrics','putThreads','recordDomainCategory'].forEach(m=>{if(typeof cache[m]==='function')g[m]=async(...a)=>{if(!guard()){const e=new Error('account changed during sync · results discarded');e.aborted=true;throw e}return cache[m](...a)}});
    return g;
  }
  /** One Gmail engine per secondary Google connection (quota, concurrency and backoff are per mailbox). */
  function gmailFetcherFor(state){
    const tok=f=>connsApi().token(state.conn,state.gen,!!f);
    const send=async(url,init,tk,ms)=>{const ctrl=new AbortController();const tm=setTimeout(()=>ctrl.abort(),ms);try{return await fetch(url,{...(init||{}),headers:{...((init&&init.headers)||{}),Authorization:'Bearer '+tk},signal:ctrl.signal})}finally{clearTimeout(tm)}};
    async function request(url){
      let t;try{t=await tok(false)}catch(e){return {ok:false,status:401,reason:e.aborted?'aborted':'no_token',message:String(e.message||e)}}
      let r=await send(url,null,t,20000);
      if(r.status===401){try{r=await send(url,null,await tok(true),20000)}catch(e){return {ok:false,status:401,reason:'no_token',message:String(e.message||e)}}}
      let data=null;try{const text=await r.text();data=text?JSON.parse(text):null}catch{}
      if(r.ok)return {ok:true,status:r.status,data};
      return {ok:false,status:r.status,data,reason:data?.error?.errors?.[0]?.reason||data?.error?.status||'',message:data?.error?.message||`Gmail API error (${r.status})`,retryAfterMs:retryAfterMsFrom(r)};
    }
    async function batchPost(url,init){let t;try{t=await tok(false)}catch{return {ok:false,status:401,text:async()=>'',headers:{get:()=>''}}}let r=await send(url,init,t,30000);if(r.status===401){try{r=await send(url,init,await tok(true),30000)}catch{}}return r}
    return {request,batchPost};
  }
  var gStacks=new Map();
  function gmailStackFor(conn,gen){
    const key=conn.accountKey;let st=gStacks.get(key);
    if(!st){
      const v=getMailV2(),state={conn,gen},f=gmailFetcherFor(state);
      let qcfg={};try{qcfg={limitPerMinute:window.DaylightGmailConfig?.load?.().quota?.limitPerMinute||undefined}}catch{}
      const engine=W.DaylightGmailSync.createGmailSync({request:f.request,config:qcfg.limitPerMinute?qcfg:undefined});
      st={state,engine,f,lock:W.DaylightSyncScheduler.createLock({name:v.config.schedule.lockName+':'+key,leaseMs:v.config.schedule.lockLeaseMs})};
      gStacks.set(key,st);
    }
    st.state.conn=conn;st.state.gen=gen;return st;
  }
  /** One secondary Gmail account: discovery + metadata + selective bodies (its own checkpoint), then its Items. */
  async function syncGmailConn(conn,force){
    const C=connsApi(),acct=conn.accountKey,gen=C.ensureGen(acct),v=getMailV2(),S=W.DaylightSyncScheduler,c=v2Core();
    const mine=()=>C.stillMine(conn.id,acct,gen)&&!(inventory()&&inventory().isDeleted(acct));
    const lastKey='daylight-gmail-last-sync:'+acct,last=Number(getLS(lastKey))||0;
    const d=S.decide({trigger:force?'manual':'open',now:Date.now(),lastSyncAt:last,schedule:v.config.schedule});
    if(!d.run&&!force)return {skipped:d.reason};
    const st=gmailStackFor(conn,gen),cache=guardedCache(v.cache,mine);
    const pipe=W.DaylightMailPipeline.createMailPipeline({engine:st.engine,cache,rules:W.DaylightGmailRules,config:v.config,batch:W.DaylightGmailBatch,batchSend:W.DaylightGmailBatch.createSender(st.f.batchPost),derive:v2Derive,fullFields:W.DaylightGmailSync.FULL_FIELDS});
    const lk=await st.lock.withLock(async()=>{
      if(!mine())return {aborted:true};
      const out=await pipe.run({accountId:acct,label:d.label||'manual',aiEnabled:false}); // Ask AI / AI extraction stays off for added accounts (per-account AI consent comes with the account settings)
      if(!mine())return {aborted:true};
      if(out.report.fatal)throw new Error(out.report.summary||'Gmail sync failed');
      const key='daylight-graph-ingest:x5:'+acct,fbKey='daylight-graph-ingest-fb1:'+acct,since=getLS(fbKey)?(Number(getLS(key))||0):0,t0=Date.now();
      const ing=await c.gmail.ingest(acct,{since,guard:mine});if(!mine())return {aborted:true};
      setLS(key,String(t0));setLS(fbKey,String(t0));setLS(lastKey,String(Date.now()));
      return {mail:out.report,ingest:ing};
    });
    if(!lk.ran)return {skipped:'another tab is syncing'};
    return lk.result;
  }
  /** One Microsoft connection: Outlook, its Items, then OneDrive (F1 guards per account and generation). */
  async function syncMsConn(conn,force){
    const C=connsApi(),acct=conn.accountKey,gen=C.ensureGen(acct),v=getMsV2(),c=v2Core();
    const mine=()=>C.stillMine(conn.id,acct,gen)&&!(inventory()&&inventory().isDeleted(acct));
    const last=Number(getLS('daylight-ms-last-sync:'+acct))||0;
    if(!force&&Date.now()-last<15*60000)return {skipped:'recent'};
    await C.token(conn,gen,false); // fails closed before any work (wrong account, disconnected, reconnect needed)
    const getToken=f=>C.token(conn,gen,!!f);
    const lock=W.DaylightSyncScheduler.createLock({name:'daylight-ms-sync:'+acct,leaseMs:v.config.schedule.lockLeaseMs});
    const lk=await lock.withLock(async()=>{
      if(!mine())return {aborted:true};
      const pipe=W.DaylightOutlookPipeline.createOutlookPipeline({getToken,guard:mine,cache:v.cache,rules:W.DaylightGmailRules,config:v.config,derive:v2Derive});
      const mail=(await pipe.run({accountId:acct})).report;
      if(!mine())return {aborted:true};
      if(mail.fatal)throw new Error(mail.summary||'Outlook sync failed');
      const key='daylight-graph-ingest:ms1:'+acct,fbKey='daylight-graph-ingest-fb1:'+acct,since=getLS(fbKey)?(Number(getLS(key))||0):0,t0=Date.now();
      const ingest=await c.outlook.ingest(acct,{since,guard:mine});if(!mine())return {aborted:true};setLS(key,String(t0));setLS(fbKey,String(t0));
      let files=null;const fl=Number(getLS('daylight-onedrive-last:'+acct))||0;
      if(conn.files_read!==false&&W.DaylightOneDrive&&(force||Date.now()-fl>60*60000)){
        if(!mine())return {aborted:true};
        const od=W.DaylightOneDrive.createOneDrive({getToken,guard:mine,graph:c.graph,store:{get:getLS,set:setLS},rules:W.DaylightGmailRules,mailHelper:v.helper,pipelineConfig:v.config.pipeline,config:{readContents:msReadFiles()}});
        files=await od.sync(acct);if(files.ok)setLS('daylight-onedrive-last:'+acct,String(Date.now()));
      }
      setLS('daylight-ms-last-sync:'+acct,String(Date.now()));
      return {mail,ingest,files};
    });
    if(!lk.ran)return {skipped:'another tab is syncing'};
    return lk.result;
  }
  /** The v112.1 single Microsoft link of this login, if it names this account (it would keep the account "linked"). */
  function clearLegacyLink(acct){try{const l=JSON.parse(getLS(msKey())||'null');if(l&&l.account===acct){setLS(msKey(),'');bumpMsGen()}}catch{}}
  /** Deleted on another device (server tombstone) → delete here too, unless the account is connected again. */
  async function applyTombstones(){
    const C=connsApi(),m=C&&C.mirror();if(!m)return [];
    const live=new Set(m.connections.map(c=>c.accountKey)),done=[];
    const inv=inventory();if(!inv)return [];
    const rows=await inv.scan(v2AccountKey());
    for(const [key,t] of Object.entries(m.tombstones||{})){
      if(live.has(key)||key===v2AccountKey())continue;
      const row=rows.find(r=>r.key===key);if(!row)continue;
      const L=inv.read()[key];if(L&&L.deletedAt&&L.deletedAt>=t.deletedAt)continue; // already done here
      try{C.bumpGen(key);clearLegacyLink(key);await deleteDeviceAccount(key);done.push(key)}catch(e){console.warn('tombstone delete',e)}
    }
    return done;
  }
  async function confirmPendingConnection(){
    const p=getLS('daylight-conn-pending');if(!p)return null;setLS('daylight-conn-pending','');
    try{const r=await connsApi().confirm(p);const c=r.connection||{};
      // connected again on purpose: a local deletion record for it ends (its data may sync back in)
      if(c.accountKey){try{inventory()?.connected(c.accountKey,{provider:c.provider,email:c.email||'',owner:v2AccountKey()})}catch{}connsApi().bumpGen(c.accountKey)}toast((r.result==='reconnected'?'Reconnected ':r.result==='updated'?'Already connected · ':r.result==='added_different_account'?'Added (a different account than the one you reconnected) · ':'Connected ')+(c.email||''));return r}
    catch(e){toast(CONN_ERRORS[e.code]||('Could not add the account: '+(e.code||e.message)));return null}
  }
  /** Sync every connection of this identity except the one this device signed in with (that ran just before). */
  async function syncConnections(force){
    const C=connsApi();if(!C||connsBusy)return [];
    connsBusy=true;const out=[];
    try{
      try{await C.refresh()}catch(e){if(e.status===401){clearServerSession('Daylight sign-in expired · sign in again');return out}console.warn('connections',e)}
      await confirmPendingConnection();
      try{await applyTombstones()}catch(e){console.warn('tombstones',e)}
      const login=v2AccountKey();try{C.record(login,!lastSyncErr,lastSyncErr)}catch{}
      for(const conn of otherConns()){
        if(conn.status!=='active'){out.push({account:conn.accountKey,skipped:conn.status});continue}
        {const inv=inventory(),L=inv&&inv.read()[conn.accountKey];if(L&&L.deletedAt&&conn.connectedAt&&conn.connectedAt>L.deletedAt)inv.connected(conn.accountKey,{provider:conn.provider,email:conn.email||'',owner:v2AccountKey()})} // reconnected on another device after it was deleted here
        if(!C.due(conn.accountKey,0,force?'now':true)){out.push({account:conn.accountKey,skipped:'backoff'});continue}
        C.setStatus(conn.accountKey,{running:true,startedAt:Date.now()});
        try{const r=conn.provider==='google'?await syncGmailConn(conn,force):await syncMsConn(conn,force);
          if(r&&r.aborted){C.setStatus(conn.accountKey,{running:false});out.push({account:conn.accountKey,aborted:true});continue}
          if(r&&r.skipped){C.setStatus(conn.accountKey,{running:false});out.push({account:conn.accountKey,skipped:r.skipped});continue}
          C.record(conn.accountKey,true);out.push({account:conn.accountKey,ok:true,result:r})}
        catch(e){if(e&&e.aborted){C.setStatus(conn.accountKey,{running:false});out.push({account:conn.accountKey,aborted:true});continue}
          console.warn('connection sync',conn.provider,e);C.record(conn.accountKey,false,e);out.push({account:conn.accountKey,error:String(e&&e.message||e)})}
      }
      syncConnections.last={at:Date.now(),out};
      return out;
    }finally{connsBusy=false}
  }
  /** Disconnect one added account: the server deletes its token (Google: revoked) and records a tombstone; this device
   *  deletes its data (under its sync lock). The account this device signed in with uses Disconnect (sign out) instead. */
  async function disconnectConnection(connId){
    const C=connsApi(),conn=C&&C.byId(connId);if(!conn)throw new Error('not connected');
    if(conn.id===loginConnId())throw new Error('This is the account you signed in with · use Disconnect in Gmail settings');
    const r=await C.disconnect(connId); // its generation changes first: running syncs stop before their next write
    clearLegacyLink(conn.accountKey);
    inventory()?.markOrphan(conn.accountKey,'disconnected',{owner:v2AccountKey(),email:conn.email||'',provider:conn.provider});
    let report=null;try{report=await deleteDeviceAccount(conn.accountKey)}catch(e){console.warn('delete account data',e)}
    return Object.assign({ok:true,account:conn.accountKey,provider:conn.provider},report||{});
  }
  async function startConnection(provider,reconnect){
    const C=connsApi();if(!C||!connsOn())throw new Error('Adding accounts needs the updated Daylight server');
    const url=await C.start(provider,location.origin+location.pathname,reconnect).catch(e=>{throw new Error(CONN_ERRORS[e.code]||e.message)});
    location.assign(url);
  }

  // ---- One refresh: confirm the account, run the Gmail V2 engine, then bring the Item Graph up to date ----

  async function refreshAll(){
    if(!token&&!serverSession)return;
    if(syncBusy)return;
    syncBusy=true;lastSyncErr='';lastRefreshStart=Date.now();
    const trigger=refreshAll.force?'manual':(refreshAll.trigger||'open'),extra={slotAt:refreshAll.slotAt||null,olderScan:!!refreshAll.olderScan};
    refreshAll.force=false;refreshAll.trigger=null;refreshAll.slotAt=null;refreshAll.olderScan=false;
    try{
      if(!token&&!(await serverToken()))return;
      await loadProfile();
      if(!v2Enabled())throw new Error('Daylight did not load completely · reload the page');
      if(!identityVerified){lastSyncErr='Google could not confirm which account is signed in · try again';return}
      try{
        const out=await v2GmailSync(trigger,extra);
        out.report.at=Date.now();lastGmailReport=out.report;
        try{localStorage.removeItem('daylight-v2-engine-error:'+v2AccountKey())}catch{}
        await v2IngestGmail();
        if(await connsProbe())await syncConnections(trigger==='manual');
        else await v2MicrosoftSync(trigger==='manual');
        try{await accountHousekeeping()}catch(e){console.warn('account housekeeping',e)}
        if(out.report.partial&&out.report.summary)lastSyncErr=out.report.summary;
      }catch(e){
        console.warn('gmail v2',e);
        lastSyncErr=String(e&&e.message||e);
        try{localStorage.setItem('daylight-v2-engine-error:'+v2AccountKey(),JSON.stringify({at:Date.now(),stage:'gmail sync',message:String(e&&e.message||e).slice(0,300)}))}catch{}
      }
    }finally{
      syncBusy=false;refreshAll.runs=(refreshAll.runs||0)+1;
      if(!lastSyncErr)lastSyncOk=Date.now();
      v2ArmSlots();
    }
  }
  // Focus refresh is throttled (≥2 min apart, never while a sync runs); Gmail itself is gated by the sync slots (see v2GmailSync).
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&(token||serverSession)&&!syncBusy&&Date.now()-lastRefreshStart>120000){refreshAll.trigger='visible';refreshAll()}});

  /** Disconnect: end the server session (revoking Daylight's Google access) and delete this account's Gmail data from this device. */
  async function disconnectGoogle(){
    try{if(msLink())await disconnectMicrosoft()}catch(e){console.warn('microsoft disconnect',e)}
    if(serverSession){try{await fetch(serverUrl+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+serverSession}})}catch{}serverSession='';setLS('daylight-session','');clearTimeout(serverRenew)}
    const discAcct=v2AccountKey();
    token=null;rememberGoogleScopes('');resetGmailEngine();lastGmailReport=null;
    setLS('daylight-profile','');setLS('daylight-session-owner','');invalidateIdentity('disconnected',false);
    let wiped=null;
    try{let mc=null;try{mc=v2Enabled()?getMailV2().cache:null}catch{};wiped=await W.DaylightDataReset?.deleteGmailData?.({accountId:discAcct&&discAcct!=='local'?discAcct:null,active:true,mailCache:mc})}catch(e){console.warn('delete gmail data',e)}
    disconnectGoogle.lastReport=wiped;
    lastSyncOk=0;lastSyncErr='';
    return wiped;
  }

  // ---- Theme: follow the system unless the user chooses ----
  const darkMq=matchMedia('(prefers-color-scheme: dark)');
  const themePref=()=>getLS('daylight-theme')||'system';
  function applyThemePref(pref){
    const mode=pref||themePref();
    setLS('daylight-theme',mode==='light'||mode==='dark'?mode:'');
    const dark=mode==='dark'||(mode!=='light'&&darkMq.matches);
    document.body.classList.toggle('dark',dark);
    document.querySelector('meta[name=theme-color]')?.setAttribute('content',dark?'#0C0E12':'#F3F4F7');
  }
  applyThemePref();
  darkMq.addEventListener?.('change',()=>{if(themePref()==='system')applyThemePref('system')});

  // Install as an app (PWA) and work offline
  if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('sw.js').catch(()=>{});
  addEventListener('offline',()=>toast('You’re offline · Wallet passes still open'));
  addEventListener('online',()=>toast('Back online'));

  /* ---- The app: Today · Inbox · Plan · Money · Wallet on top of the Item Graph ---- */
  (function mountV2UI(){
    if(!W.DaylightV2UI||!W.DaylightV2Model){document.documentElement.classList.remove('v2boot');console.error('Daylight interface did not load');return}
    let sample=false;try{sample=/[?&]v2sample=1\b/.test(location.search)||sessionStorage.getItem('daylight-v2-sample')==='1'}catch{}
    const core=v2Core();
    if(!core&&!sample){document.documentElement.classList.remove('v2boot');console.error('Daylight data model did not load');return}
    const aiReady=()=>!!(W.DaylightAI?.getConsent?.()&&W.DaylightAI?.isEnabled?.()&&serverUrl&&serverSession);
    const host={
      connected:()=>Boolean(token||serverSession),
      profile:()=>identityVerified?readProfile():{},
      accountId:()=>{if(!identityVerified)return null;const p=readProfile();return (p.sub||p.email)?v2AccountKey():null},
      accountPending:()=>Boolean((token||serverSession)&&!identityVerified),
      connect:()=>signIn({upgrade:Boolean(serverSession&&!hasGmailReadonly())}),
      switchAccount:()=>signIn({switch:true}),
      async disconnect(){await disconnectGoogle();return disconnectGoogle.lastReport||null},
      async syncNow(){refreshAll.force=true;await refreshAll()},
      syncState:()=>({busy:syncBusy,lastAt:lastSyncOk||0,error:lastSyncErr||'',runs:refreshAll.runs||0}),
      linkedAccounts:()=>{
        if(connsOn()&&identityVerified)return otherConns().map(c=>c.accountKey).filter(k=>!(inventory()&&inventory().isDeleted(k)));
        const l=msLink();return l&&l.account&&!(inventory()&&inventory().isDeleted(l.account))?[l.account]:[]},
      /** connections_v1: every account of this Daylight identity with its own sync status (no tokens). */
      connectionsEnabled:()=>connsOn(),
      connections:()=>{if(!connsOn()||!identityVerified)return [];const C=connsApi(),login=loginConnId();return C.list().map(c=>Object.assign({},c,{isLogin:c.id===login,sync:c.id===login?{lastOk:lastSyncOk||0,lastError:lastSyncErr||'',running:syncBusy}:C.status(c.accountKey)}))},
      connectionCaps:()=>((connsApi()&&connsApi().mirror())||{}).caps||{google:2,microsoft:2},
      async addAccount(provider){return startConnection(provider)},
      async reconnectAccount(connId){const c=connsApi()?.byId(connId);if(!c)throw new Error('not connected');return startConnection(c.provider,connId)},
      async disconnectAccount(connId){return disconnectConnection(connId)},
      async syncAccounts(){return syncConnections(true)},
      /** Accounts whose Items may go into an Ask AI request: the signed-in account, this device's own items, and added
       *  accounts only after the user turned AI on for them (per-account opt-in, off by default). */
      aiAccounts:()=>{const a=[v2AccountKey(),'local'];if(connsOn())otherConns().forEach(c=>{if(getLS('daylight-ai-include:'+c.accountKey)==='1')a.push(c.accountKey)});else{const l=msLink();if(l&&l.account&&getLS('daylight-ai-include:'+l.account)==='1')a.push(l.account)}return a},
      setAiAccount(acct,on){setLS('daylight-ai-include:'+acct,on?'1':'')},
      /** Accounts with data on this device. shown=true: the user is looking at warnings now (starts the 7-day notice). */
      async accountInventory(opts){const inv=inventory();if(!inv)return [];const rows=await inv.scan(identityVerified?v2AccountKey():null);if(opts&&opts.shown){const w=rows.filter(r=>r.status==='orphan'&&r.warn&&!r.warnedAt).map(r=>r.key);if(w.length&&inv.markWarned(w))return inv.scan(identityVerified?v2AccountKey():null)}return rows},
      replacedPrompt:()=>{try{return identityVerified?JSON.parse(getLS(replacedKey())||'null'):null}catch{return null}},
      dismissReplaced(){setLS(replacedKey(),'')},
      async deleteDeviceAccount(key){return deleteDeviceAccount(key)},
      keepAccountData(key){inventory()?.keep(key)},
      microsoft:()=>{const l=msLink();return {available:Boolean(serverUrl&&serverSession&&identityVerified),link:l,busy:msBusy,error:msErr,last:msLast,lastAt:l&&l.account?Number(getLS('daylight-ms-last-sync:'+l.account))||0:0,readFiles:msReadFiles()}},
      async connectMicrosoft(){
        if(!serverUrl||!serverSession)throw new Error('Sign in with Google first');
        if(await connsProbe()){const m=connMs()[0];return startConnection('microsoft',m&&m.status==='needs_reconnect'?m.id:undefined)}
        const r=await fetch(serverUrl+'/api/microsoft/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+serverSession},body:JSON.stringify({return:location.origin+location.pathname})});
        const d=await r.json().catch(()=>({}));if(!r.ok||!d.url)throw new Error(MS_ERRORS[d.error]||d.error||('HTTP '+r.status));
        setLS('daylight-ms-pending','1');location.assign(d.url);
      },
      async disconnectMicrosoft(){if(connsOn()){const m=connMs()[0];return m?disconnectConnection(m.id):null}return disconnectMicrosoft()},
      setReadFiles(on){setLS('daylight-ms-read-files',on?'':'0')},
      async syncMicrosoft(){if(await connsProbe())return syncConnections(true);return v2MicrosoftSync(true)},
      theme:{get:themePref,set:m=>applyThemePref(m)},
      openScanner:()=>{
        if(!W.DaylightV2Scan){toast('The scanner did not load · reload Daylight');return}
        W.DaylightV2Scan.open({
          host:document.getElementById('v2')||document.body,
          async onSaved(pass){try{await core?.local?.importLocal()}catch(e){console.warn('local import',e)}try{W.DaylightV2UI.setTab('wallet')}catch{}toast('Saved to Wallet · '+pass.title)}
        });
      },
      /* developer diagnostics: real counters from the mail cache (no estimates) */
      engineError:()=>{try{return identityVerified?JSON.parse(localStorage.getItem('daylight-v2-engine-error:'+v2AccountKey())||'null'):null}catch{return null}},
      grantedScopes:()=>{const all=googleScopeBlob().split(/\s+/).filter(Boolean);const wanted=['openid','email','profile','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/gmail.readonly'];return {all,extra:all.filter(x=>!wanted.includes(x))}},
      accountNames:()=>{try{return JSON.parse(localStorage.getItem('daylight-v2-account-names')||'{}')}catch{return {}}},
      async deleteAccountData(acct){if(!acct||acct===v2AccountKey())throw new Error('use Disconnect for the signed-in account');let mc=null;try{mc=v2Enabled()?getMailV2().cache:null}catch{};return W.DaylightDataReset.deleteGmailData({accountId:acct,active:false,mailCache:mc})},
      /** Diagnostics only: read Subject/From/Date of a few messages Daylight skipped (gmail.readonly, 20 quota units each). Nothing is stored. */
      async peekMessages(ids){
        if(!token||!identityVerified)throw new Error('not signed in');
        const list=[...new Set(ids)].slice(0,20),out=[];
        for(const id of list){try{const m=await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);const h=m.payload?.headers||[];const g=n=>(h.find(x=>x.name.toLowerCase()===n)||{}).value||'';out.push({id,subject:g('subject'),from:g('from'),date:g('date'),labels:m.labelIds||[],snippet:m.snippet||''})}catch(e){out.push({id,error:String(e&&e.message||e)})}}
        try{await getMailV2().cache.addMetrics(v2AccountKey(),{counters:{units:list.length*20,req_getMeta:list.length,diagPeek:list.length}})}catch{}
        return out;
      },
      /** Diagnostics only: run a Gmail search (messages.list, 5 units per page, max 2 pages) and compare its ids with what Daylight processed. */
      async gmailCompare(q){
        if(!token||!identityVerified)throw new Error('not signed in');
        const acct=v2AccountKey(),ids=[];let page='',pages=0;
        do{const u=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');u.searchParams.set('q',q);u.searchParams.set('maxResults','100');if(page)u.searchParams.set('pageToken',page);const r=await api(u.toString());(r.messages||[]).forEach(m=>ids.push(m.id));page=r.nextPageToken||'';pages++}while(page&&pages<2);
        try{await getMailV2().cache.addMetrics(acct,{counters:{units:pages*5,req_list:pages,diagCompare:1}})}catch{}
        const idx=new Map((await getMailV2().cache.all(acct)).map(r=>[String(r.messageId),r]));
        const graphIds=new Set((await core.graph.query({accountId:acct,type:'email'})).map(x=>String(x.sourceItemId)));
        const rows=ids.map(id=>{const r=idx.get(String(id));return {id,state:!r?'not-discovered':r.status==='skipped'?'skipped':r.status==='meta-pending'?'pending':r.status==='deleted'?'deleted':graphIds.has(String(id))?'in-daylight':'processed-not-in-graph'}});
        const counts={};rows.forEach(x=>{counts[x.state]=(counts[x.state]||0)+1});
        return {query:q,total:ids.length,truncated:!!page,units:pages*5,counts,rows};
      },
      async syncDiagnostics(){
        if(!v2Enabled())return {engine:'not-loaded'};
        const v=getMailV2(),M=W.DaylightSyncMetrics,acct=v2AccountKey();
        const rows=await v.cache.metrics(acct).catch(()=>[]);const idx=await v.cache.all(acct).catch(()=>[]);const cp=await v.cache.getCheckpoint(acct).catch(()=>null)||{};
        const status={},cats={};idx.forEach(r=>{status[r.status]=(status[r.status]||0)+1;const l=r.labels||[];const c=l.includes('SENT')&&!l.some(x=>/^CATEGORY_/.test(x))?'sent':((l.find(x=>/^CATEGORY_/.test(x))||'CATEGORY_PERSONAL').replace('CATEGORY_','').toLowerCase().replace('personal','primary'));cats[c]=cats[c]||{indexed:0,skipped:0,bodies:0};cats[c].indexed++;if(r.status==='skipped')cats[c].skipped++;if(r.bodyFetched)cats[c].bodies++});
        const runs=rows.flatMap(r=>r.runs||[]).sort((a,b)=>b.at-a.at).slice(0,15);const skipped=idx.filter(r=>r.status==='skipped').map(r=>({id:r.messageId,labels:r.labels||[]})).sort((a,b)=>String(b.id).localeCompare(String(a.id)));const unresolved=idx.filter(r=>r.status==='meta-pending'||r.status==='body-queued').map(r=>({id:r.messageId,status:r.status,error:r.lastError||null,subject:r.subject||null}));let aiQ=0;try{aiQ=(await v.cache.aiQueue(acct)).length}catch{};let ingestLog=[];try{ingestLog=JSON.parse(localStorage.getItem('daylight-v2-ingest-log:'+acct)||'[]')}catch{};
        let engineError=null;try{engineError=JSON.parse(localStorage.getItem('daylight-v2-engine-error:'+acct)||'null')}catch{};
        return {engine:'v2',account:acct,engineError,runs,skipped,unresolved,aiQueue:aiQ,ingestLog,today:M?M.summarise(rows,{days:1}):null,week:M?M.summarise(rows,{days:7}):null,last:lastGmailReport?{at:lastGmailReport.at,discovery:lastGmailReport.discovery||null,units:lastGmailReport.units??null}:null,index:{total:idx.length,status,categories:cats},checkpoint:{windowDays:cp.windowDays||null,lastMode:cp.lastMode||null,lastFullAt:cp.lastFullAt||null},ingest:core&&core.lastIngest||null};
      },
      async deleteAll(){
        if(serverSession){try{await fetch(serverUrl+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+serverSession}})}catch{}}
        try{await W.DaylightDataReset?.deleteAll?.()}catch(e){console.warn('delete all',e)}
        location.replace(location.pathname);
      },
      ai:{
        enabled:aiReady,
        setEnabled(on){try{if(on){W.DaylightAI?.setConsent?.(true);W.DaylightAI?.setEnabled?.(true)}else W.DaylightAI?.setEnabled?.(false)}catch{}},
        async ask(prompt,system){
          if(!aiReady())throw new Error('AI is off');
          const r=await fetch(serverUrl+'/api/gemini/analyse',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+serverSession},body:JSON.stringify({prompt,system,temperature:0.1,maxOutputTokens:1024,timeoutMs:20000})});
          const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d.text||'';
        }
      }
    };
    W.DaylightV2Host=host;
    W.DaylightV2UI.mount({core,host,sample});
  })();
  // Signed in on this device already: get a fresh Google token and sync
  if(serverUrl&&serverSession)serverToken().then(ok=>{if(ok)refreshAll()});
})();
