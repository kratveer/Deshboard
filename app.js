// Daylight personal mode. Access tokens live in memory only; no Google data is sent to Daylight servers.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let tokenExpiry = 0;
  let token = null, tokenClient = null, microsoftApp = null, microsoftAccount = null;
  const providerData = { google:{events:null,mails:null,tasks:null}, microsoft:{events:null,mails:null,tasks:null} };
  let mWeekCache={}, mCalIds=null, mWeekInflight={};
  let personalTasks = [];
  try { personalTasks = JSON.parse(localStorage.getItem('daylight-personal-tasks') || '[]'); if (!Array.isArray(personalTasks)) personalTasks=[]; } catch { personalTasks=[]; }
  // V2: Gmail read-only is the only permission asked at sign-in. Calendar, Tasks and Contacts are optional
  // connectors added later with their own consent (incremental authorisation). No send/modify scopes.
  const scopes = ['openid','email','profile','https://www.googleapis.com/auth/gmail.readonly'].join(' ');
  const OPTIONAL_GOOGLE_SCOPES={
    calendar:'https://www.googleapis.com/auth/calendar.events.readonly',
    tasks:'https://www.googleapis.com/auth/tasks.readonly',
    contacts:'https://www.googleapis.com/auth/contacts.readonly'
  };
  let googleGrantedScope='';
  const rememberGoogleScopes=s=>{
    googleGrantedScope=String(s||'');
    try{googleGrantedScope?localStorage.setItem('daylight-google-scopes',googleGrantedScope):localStorage.removeItem('daylight-google-scopes')}catch{}
  };
  const hasGmailSend=()=>{
    let stored='';try{stored=localStorage.getItem('daylight-google-scopes')||''}catch{}
    return /gmail\.send|gmail\.compose|gmail\.modify|mail\.google\.com/.test(googleGrantedScope||stored);
  };
  const hasGmailReadonly=()=>{
    let stored='';try{stored=localStorage.getItem('daylight-google-scopes')||''}catch{}
    return /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly(?:\s|$)|(?:^|\s)gmail\.readonly(?:\s|$)/.test(googleGrantedScope||stored);
  };
  const needsGmailUpgrade=()=>Boolean((token||serverSession)&&!hasGmailReadonly());
  /** True only when Google actually granted the optional connector's scope (never assumed). */
  /* V2: an optional Google product is used only when the user turned that connector on in THIS release — an older, broader grant (e.g. calendar or gmail.send from Version 1) is never used silently. */
  const connectorOn=name=>{try{return localStorage.getItem('daylight-connector-'+name)==='1'}catch{return false}};
  const hasGoogleScope=name=>{if(!connectorOn(name))return false;let stored='';try{stored=localStorage.getItem('daylight-google-scopes')||''}catch{};const blob=googleGrantedScope||stored;const sc=OPTIONAL_GOOGLE_SCOPES[name];return !!(sc&&blob.split(/\s+/).includes(sc))};
  const FITNESS_SCOPES=(window.DaylightHealth?.FITNESS_SCOPES||[
    'https://www.googleapis.com/auth/fitness.activity.read',
    'https://www.googleapis.com/auth/fitness.heart_rate.read',
    'https://www.googleapis.com/auth/fitness.sleep.read',
    'https://www.googleapis.com/auth/fitness.body.read'
  ]).join(' ');
  const googleScopeBlob=()=>{let stored='';try{stored=localStorage.getItem('daylight-google-scopes')||''}catch{};return googleGrantedScope||stored||''};
  const hasFitnessRead=()=>window.DaylightHealth?.hasGoogleFitnessScope?.(googleScopeBlob())||/fitness\.(activity|heart_rate|sleep|body)\.read/i.test(googleScopeBlob());
  const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  /* Light native-feel feedback (Capacitor Haptics → vibrate → no-op) */
  const feel={
    _t:0,
    reduced(){return matchMedia('(prefers-reduced-motion: reduce)').matches},
    async haptic(kind='light'){
      const now=Date.now();if(now-this._t<48)return;this._t=now;
      try{
        const H=window.Capacitor?.Plugins?.Haptics;
        if(H){
          if(kind==='success'){await H.notification({type:'SUCCESS'});return}
          if(kind==='warning'){await H.notification({type:'WARNING'});return}
          if(kind==='error'){await H.notification({type:'ERROR'});return}
          if(kind==='medium'||kind==='press'){await H.impact({style:'MEDIUM'});return}
          if(kind==='selection'){await H.selectionStart?.();await H.selectionChanged?.();await H.selectionEnd?.();return}
          await H.impact({style:'LIGHT'});return;
        }
      }catch{}
      try{
        if(!navigator.vibrate)return;
        const map={light:8,selection:6,medium:12,press:12,success:[7,36,10],warning:[9,28,9],error:[12,36,12]};
        navigator.vibrate(map[kind]||8);
      }catch{}
    },
    tap(){return this.haptic('light')},
    select(){return this.haptic('selection')},
    success(){return this.haptic('success')},
    error(){return this.haptic('error')},
    press(){return this.haptic('press')}
  };
  window.DaylightFeel=feel;
  let toastTimer=0;
  const toast=(s,opts={})=>{
    const e=$('#toast');if(!e)return;
    e.textContent=s;
    e.className='toast show'+(opts.type==='ok'?' toast-ok':opts.type==='err'?' toast-err':opts.type==='warn'?' toast-warn':'');
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>{e.classList.remove('show','toast-ok','toast-err','toast-warn')},opts.ms||2600);
    if(opts.haptic)feel.haptic(opts.haptic);
  };
  const date = new Date();
  const localMidnight = new Date(date.getFullYear(),date.getMonth(),date.getDate());
  const tomorrow = new Date(date.getFullYear(),date.getMonth(),date.getDate()+1);
  const iso = d => d.toISOString();
  $('#sync-status').innerHTML='Not connected · <button type="button" class="js-open-connect" style="all:unset;cursor:pointer;color:var(--accent-text);font-weight:700;text-decoration:underline">connect Google</button>';
  $('#task-count').textContent='—';
  $('#done-count').textContent='—';
  const connectHint=(msg)=>`<div class="empty">${msg}<div class="cta-connect"><button type="button" class="connect primary js-open-connect">Connect Google</button></div></div>`;
  $('#events').innerHTML=connectHint('Connect Google Calendar to see today’s events.');
  $('.task-list').innerHTML=connectHint('Connect Google Tasks to see your tasks.');
  $('.mail-list').innerHTML=connectHint('Connect Gmail to see recent inbox messages.');
  $('#headline-note').innerHTML='Connect your apps to see your day';
  $('#connections').setAttribute('aria-label','Connect your apps');
  document.addEventListener('click',e=>{if(e.target.closest('.js-open-connect')){e.preventDefault();connectDialog({setup:true,focusId:true})}});
  document.addEventListener('load',e=>{
    const img=e.target;if(!img||img.tagName!=='IMG'||!img.classList.contains('m-brand-img'))return;
    // Google's favicon service answers unknown domains with a 16px globe: treat that as "no logo" (initials stay)
    if(img.naturalWidth&&img.naturalWidth<=16&&/s2\/favicons/.test(img.src)){const next=img.dataset.fallback;img.dataset.fallback='';if(next){img.src=next;return}img.remove();return}
    img.classList.toggle('is-small',img.naturalWidth>0&&img.naturalWidth<64);
  },true);
  document.addEventListener('error',e=>{
    const img=e.target;if(!img||img.tagName!=='IMG'||!img.classList.contains('m-brand-img'))return;
    const next=img.dataset.fallback;img.dataset.fallback='';
    if(next){img.src=next;return}
    img.remove();
  },true);
  const weatherCard=document.createElement('article');
  weatherCard.className='card weather'; weatherCard.dataset.widget='weather';
  weatherCard.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue">☀</span>Local weather</div><button class="connect" id="weather-connect">Use my location</button></div><div id="weather-content" class="empty">Share your location to see today’s weather.</div>';
  $('#layout').append(weatherCard);

  function connectDialog(opts={}) {
    const g=Boolean(token), ms=Boolean(microsoftAccount), staying=Boolean(serverSession), prof=readProfile();
    const savedId=localStorage.getItem('daylight-client-id')||'';
    const msReady=Boolean(localStorage.getItem('daylight-ms-client-id'));
    const needsSetup=!g&&!serverUrl&&!savedId;
    const origin=location.origin;
    const row=(id,icon,iconCls,name,sub,connected,btn)=>`<div class="conn-row${connected?' is-on':''}"><div class="provider-icon ${iconCls}">${icon}</div><div class="provider-copy"><b>${name}</b><span>${sub}</span></div>${btn}</div>`;
    const setupPanel=`<div class="google-setup" id="google-setup">
        <h4>Connect Gmail in 2 steps</h4>
        <ol class="steps">
          <li>In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud → Credentials</a>, create an OAuth client of type <b>Web application</b>.</li>
          <li>Under <b>Authorized JavaScript origins</b>, add exactly this site, then paste the Client ID below.</li>
        </ol>
        <div class="origin-row"><code id="site-origin" title="${esc(origin)}">${esc(origin)}</code><button type="button" class="connect ghost" id="copy-origin">Copy</button></div>
        <label class="client-label" for="client-id">Google Client ID <small>public · not a secret</small></label>
        <input class="client-input" id="client-id" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="123….apps.googleusercontent.com" value="${esc(savedId)}">
        <p class="hint">Daylight never asks for your Google password or Client <b>Secret</b>. Secrets stay only on your optional Daylight server.</p>
        <button class="connect primary" id="google-connect" type="button">Connect with Google</button>
      </div>`;
    $('#overlay').innerHTML=`<div class="modal connections-modal" role="dialog" aria-label="Connections"><div class="modal-top"><h3>Connections</h3><button class="modal-x" id="close-modal" aria-label="Close">×</button></div>
      ${row('google','G','google-icon','Google',g?`<span class="dot"></span>${staying?'Connected · stays signed in':'Connected for about an hour'}${prof.email?' · '+esc(prof.email):''}`:'Gmail · read-only',g,g?'<button class="connect ghost" id="google-disconnect" type="button">Disconnect</button>':(needsSetup?'':'<button class="connect primary" id="google-connect" type="button">Connect</button>'))}
      ${needsSetup||opts.setup?setupPanel:(!g?`<div class="google-setup" id="google-setup" hidden>
        <label class="client-label" for="client-id">Google Client ID <small>public · not a secret</small></label>
        <input class="client-input" id="client-id" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="123….apps.googleusercontent.com" value="${esc(savedId)}">
      </div>`:`<input id="client-id" type="hidden" value="${esc(savedId)}">`)}
      ${row('microsoft','M','ms-icon','Microsoft 365',ms?'<span class="dot"></span>Connected':'Outlook · Calendar · To Do',ms,ms?'<button class="connect ghost" id="microsoft-disconnect" type="button">Disconnect</button>':`<button class="connect ${msReady?'primary':''}" id="microsoft-connect" type="button">${msReady?'Connect':'Set up'}</button>`)}
      <div id="connect-error" class="error" role="alert" hidden></div>
      <details class="conn-more"><summary>What Daylight can see</summary><ul class="conn-list"><li>Today’s calendar events</li><li>Recent Gmail senders, subjects, and (when you open a thread) message text used for replies</li><li>Send replies you write in Daylight through your Gmail account</li><li>Open tasks, recently opened Drive file names, and contact birthdays</li><li>Access tokens stay in this browser’s memory (or your optional Daylight server).</li><li><b>Optional Email Intelligence:</b> only after you consent below, selected email text may be sent to Google Gemini through your Daylight server for classification and extraction. Disabled by default.</li></ul><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></details>
      <details class="conn-more" id="ai-intel-panel" open><summary>Email Intelligence (Gemini)</summary>
        <p class="hint" style="margin:8px 0 0">Daylight can understand shopping deliveries and travel bookings from email. Analysis runs through your Daylight server — the Gemini API key never sits in this browser. <b>Off until you consent.</b></p>
        <label class="client-label" style="display:flex;gap:8px;align-items:flex-start;margin-top:10px"><input type="checkbox" id="ai-consent" ${window.DaylightAI?.getConsent?.()?'checked':''}><span>I understand selected email content may be sent to Google Gemini via my Daylight server for personal organisation. Free-tier Gemini may use prompts to improve Google’s products.</span></label>
        <label class="client-label" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="ai-enabled" ${window.DaylightAI?.isEnabled?.()?'checked':''} ${window.DaylightAI?.getConsent?.()?'':'disabled'}><span>Enable Email Intelligence</span></label>
        <label class="client-label" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="ai-allow-financial" ${localStorage.getItem('daylight-ai-allow-financial')==='1'?'checked':''}><span>Allow AI on bills / payments / subscriptions</span></label>
        <div class="hint" id="ai-status-line" style="margin-top:8px">${esc((window.DaylightAI?.getStatus?.()?.message)||'Idle')}</div>
        <div class="server-actions" style="margin-top:8px"><button class="connect" type="button" id="ai-save">Save AI settings</button></div>
      </details>
      ${g&&needsGmailUpgrade()?`<div class="error" role="status" style="margin-top:10px">Full Gmail reading needs a one-time reconnect so Google can grant <b>gmail.readonly</b> (your current grant is metadata-only). Daylight data on this device is kept.</div><div class="server-actions" style="margin-top:8px"><button class="connect primary" type="button" id="google-upgrade-readonly">Reconnect for full Gmail access</button></div>`:''}
      
      <details class="conn-more" id="conn-advanced"><summary>Optional: stay signed in / Microsoft</summary>
        <p class="hint" style="margin:8px 0 0">Only if you deployed the Daylight server. Never paste a Google <b>Client Secret</b> here — that belongs in Cloudflare secrets only.</p>
        <label class="client-label" for="server-url">Daylight server URL</label><input class="client-input" id="server-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://daylight-api.your-name.workers.dev" value="${esc(serverUrl)}">
        ${needsSetup||opts.setup?'':`<label class="client-label" for="client-id-adv">Google Client ID <small>public</small></label><input class="client-input" id="client-id-adv" type="text" autocomplete="off" spellcheck="false" placeholder="….apps.googleusercontent.com" value="${esc(savedId)}">`}
        <label class="client-label" for="ms-client-id">Microsoft application ID <small>public</small></label><input class="client-input" id="ms-client-id" type="text" autocomplete="off" spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(localStorage.getItem('daylight-ms-client-id')||'')}">
        <div class="server-actions"><button class="connect" type="button" id="advanced-save">Save</button><a href="https://github.com/kratveer/Deshboard#google-setup" target="_blank" rel="noopener">Setup guide</a></div>
      </details>
      <details class="conn-more" id="sync-diagnostics"><summary>Sync Diagnostics</summary>
        <div id="sync-diag-body" class="hint" style="margin-top:8px">Loading…</div>
        <div class="server-actions" style="margin-top:10px">
          <button class="connect" type="button" id="sync-diag-refresh">Refresh sync</button>
          <button class="connect ghost" type="button" id="sync-diag-reload">Reload panel</button>
        </div>
      </details></div>`;
    const ov=$('#overlay');
    const overlayWasOpen=ov.classList.contains('show');
    if(!overlayWasOpen)requestAnimationFrame(()=>ov.classList.add('show'));
    else ov.classList.add('show');
    const err=m=>{const el=$('#connect-error');if(!el)return;if(!m){el.hidden=true;el.textContent='';return}el.hidden=false;el.textContent=m};
    const fmtWhen=ms=>!ms?'—':new Date(ms).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const renderSyncDiag=async()=>{
      const body=$('#sync-diag-body');if(!body)return;
      const Store=window.DaylightStore;
      if(!Store?.getSyncState){body.textContent='Local store unavailable in this browser.';return}
      try{
        await Store.open();
        const acctId=await Store.getActiveAccountId();
        const acct=await Store.getAccount(acctId);
        const sync=await Store.getSyncState(acctId);
        const st=await Store.stats(acctId);
        const row=(name,p)=>`<div style="margin:8px 0;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--card2)">
          <b>${esc(name)}</b> · ${esc(p.mode||'—')} · ${p.lastError?`<span style="color:#c0392b">${p.lastPartialAt&&(!p.lastFailureAt||p.lastPartialAt>=p.lastFailureAt)?'partial':'error'}</span>`:'ok'}
          <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.45">
            last ok ${esc(fmtWhen(p.lastSuccessAt))} · partial ${esc(fmtWhen(p.lastPartialAt))} · fail ${esc(fmtWhen(p.lastFailureAt))}<br>
            ${p.details?.records?`records · fetched ${p.details.records.fetched||0} · cached ${p.details.records.cached||0} · stale ${p.details.records.stale||0} · failed ${p.details.records.failed||0} · waiting ${p.details.records.deferred||0} · deleted ${p.details.records.deleted||0} · body later ${p.details.records.bodyDeferred||0}<br>requests ${p.details.requests||0} · quota units ${p.details.units||0} · quota errors ${p.details.quotaErrors||0} · duplicates avoided ${p.details.duplicatesAvoided||0}<br>`:''}
            fetched ${p.fetched||0} · in ${p.inserted||0} · up ${p.updated||0} · del ${p.deleted||0} · retries ${p.retries||0} · ${p.lastDurationMs||0}ms · runs ${p.runs||0}<br>
            cursor ${esc(p.cursor?String(p.cursor).slice(0,28)+(String(p.cursor).length>28?'…':''):'—')}
            ${p.lastError?`<br>err ${esc(p.lastError)}`:''}
          </div></div>`;
        body.innerHTML=`<div style="font-size:12px;line-height:1.5;margin-bottom:6px">
          <b>Account</b> ${esc(acct?.displayName||acctId)} · ${esc(acct?.email||acct?.kind||'')}<br>
          <span style="color:var(--muted)">${esc(acct?.providerAccountKey||'')} · schema v${st.schema}</span><br>
          store · entities ${st.entities||0} · rel ${st.relationships||0} · facts ${st.facts||0} · actions ${st.actions||0}
        </div>
        ${row('Gmail',sync.gmail||{})}${row('Calendar',sync.calendar||{})}${row('Tasks',sync.tasks||{})}${row('Hydrate',sync.hydrate||{})}
        ${await v2EfficiencyHTML().catch(e=>'<p>Sync efficiency unavailable: '+esc(e.message||e)+'</p>')}`;
        body.querySelector('[data-v2-older]')?.addEventListener('click',async()=>{body.querySelector('[data-v2-older]').disabled=true;refreshAll.force=true;refreshAll.olderScan=true;await refreshAll();renderSyncDiag()});
        body.querySelector('[data-v2-clear]')?.addEventListener('click',async()=>{if(!confirmInline(body.querySelector('[data-v2-clear]'),'Tap again to clear the saved mail index (your finance records and tasks are kept)'))return;await getMailV2().cache.clearAccount(v2AccountKey());try{localStorage.removeItem(v2LastKey())}catch{}toast('Mail cache cleared · the next sync rebuilds it');renderSyncDiag()});
      }catch(e){body.textContent='Could not read sync state: '+(e.message||e)}
    };
    renderSyncDiag();
    $('#sync-diag-reload')?.addEventListener('click',()=>renderSyncDiag());
    $('#sync-diag-refresh')?.addEventListener('click',async()=>{
      $('#sync-diag-body').textContent='Syncing…';
      try{if(typeof refreshAll==='function'){refreshAll.force=true;await refreshAll()}else await loadLoops(true)}catch(e){console.warn(e)}
      await renderSyncDiag();
    });
    const readClientId=()=>(($('#client-id')||$('#client-id-adv'))?.value||'').trim().replace(/\s+/g,'');
    const saveAdvanced=()=>{const u=$('#server-url').value.trim().replace(/\/+$/,'');if(u&&!/^https:\/\/[^/]+$|^http:\/\/localhost(:\d+)?$/.test(u)){err('Server URL should look like https://daylight-api.your-name.workers.dev');return false}
      setLS('daylight-api',u);serverUrl=u;const c=readClientId();if(c)setLS('daylight-client-id',c);setLS('daylight-ms-client-id',$('#ms-client-id').value.trim());err('');return true};
    $('#close-modal').onclick=()=>$('#overlay').classList.remove('show');
    $('#copy-origin')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(origin);toast('Origin copied');}catch{toast('Copy this: '+origin)}});
    $('#advanced-save').onclick=()=>{if(saveAdvanced()){toast('Settings saved on this device');connectDialog()}};
    $('#ai-consent')?.addEventListener('change',e=>{
      const on=e.target.checked;const en=$('#ai-enabled');
      if(en)en.disabled=!on;if(!on&&en)en.checked=false;
    });
    $('#ai-save')?.addEventListener('click',()=>{
      const AI=window.DaylightAI;if(!AI){toast('AI module not loaded',{type:'err'});return}
      const consent=!!$('#ai-consent')?.checked;
      AI.setConsent(consent);
      AI.setEnabled(consent&&!!$('#ai-enabled')?.checked);
      localStorage.setItem('daylight-ai-allow-financial',$('#ai-allow-financial')?.checked?'1':'0');
      toast(consent&&AI.isEnabled()?'Email Intelligence enabled':'Email Intelligence off');
      connectDialog();
    });
    const startGoogle=(opts={})=>{if(!saveAdvanced())return;
      localStorage.removeItem('daylight-demo');
      // Server path: upgrade=1 forces a clean consent that includes gmail.readonly (does not wipe IndexedDB / wallet).
      if(serverUrl){
        const q=new URLSearchParams({return:location.origin+location.pathname});
        if(opts.upgrade||needsGmailUpgrade())q.set('upgrade','1');
        location.href=serverUrl+'/auth/google/start?'+q.toString();
        return;
      }
      const id=readClientId();
      if(!id){err('Paste your Google Client ID first (ends with .apps.googleusercontent.com).');($('#client-id')||$('#client-id-adv'))?.focus();return}
      if(!id.endsWith('.apps.googleusercontent.com')){err('That doesn’t look like a Client ID. It should end with .apps.googleusercontent.com');return}
      authorize(id,{upgrade:!!(opts.upgrade||needsGmailUpgrade())})};
    $$('#google-connect').forEach(b=>b.onclick=()=>startGoogle({}));
    $('#google-upgrade-readonly')?.addEventListener('click',()=>startGoogle({upgrade:true}));
    $('#client-id')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();startGoogle()}});
    if($('#google-disconnect'))$('#google-disconnect').onclick=disconnectGoogle;
    if($('#microsoft-connect'))$('#microsoft-connect').onclick=()=>{saveAdvanced();if(!$('#ms-client-id').value.trim()){$('#conn-advanced').open=true;err('Add your Microsoft application ID under Optional setup first.');return}authorizeMicrosoft()};
    if($('#microsoft-disconnect'))$('#microsoft-disconnect').onclick=async()=>{try{await microsoftApp?.clearCache({account:microsoftAccount})}catch{}microsoftAccount=null;microsoftApp=null;providerData.microsoft={events:null,mails:null,tasks:null};renderAll();$('#connections').classList.toggle('active',Boolean(token));connectDialog();toast('Microsoft disconnected')};
    if(opts.focusId)requestAnimationFrame(()=>$('#client-id')?.focus());
  }
  async function disconnectGoogle(){
    if(serverSession){try{await fetch(serverUrl+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+serverSession}})}catch{}serverSession='';setLS('daylight-session','');clearTimeout(serverRenew)}
    disconnectGoogle.lastToken=token;
    token=null;rememberGoogleScopes('');resetGmailEngine();providerData.google={events:null,mails:null,tasks:null};loopsData=null;renderAll();const discAcct=disconnectGoogle.acct||v2AccountKey();clearProfile();setLS('daylight-session-owner','');invalidateIdentity('disconnected',false);
    if(!serverSession&&window.google?.accounts?.oauth2?.revoke&&disconnectGoogle.lastToken){try{google.accounts.oauth2.revoke(disconnectGoogle.lastToken,()=>{})}catch{}}
    let wiped=null;
    try{let mc=null;try{mc=v2Enabled()?getMailV2().cache:null}catch{};wiped=await window.DaylightDataReset?.deleteGmailData?.({accountId:discAcct&&discAcct!=='local'?discAcct:null,active:true,mailCache:mc})}catch(e){console.warn('delete gmail data',e)}
    disconnectGoogle.lastReport=wiped;
    // memory copies of Gmail data (bodies opened in the detail sheet, suggested tasks)
    try{Object.keys(mailDetailCache).forEach(k=>delete mailDetailCache[k])}catch{}
    try{personalTasks=JSON.parse(localStorage.getItem('daylight-personal-tasks')||'[]');if(!Array.isArray(personalTasks))personalTasks=[]}catch{personalTasks=[]}
    try{renderAll();if(typeof renderMobile==='function')renderMobile();if(typeof renderHome==='function')renderHome();if(typeof renderInbox==='function')renderInbox({animate:false});if(typeof renderWallet==='function')renderWallet()}catch(e){console.warn('re-render after disconnect',e)}
    if(!wiped){try{
      const Store=window.DaylightStore;
      if(Store?.clearAccountData){
        const acctId=await Store.getActiveAccountId?.();
        if(acctId)await Store.clearAccountData(acctId);
      }else await Store?.clearProviderData?.();
    }catch{}}
    $('#sync-status').textContent=microsoftAccount?'Google disconnected · Microsoft still connected':'Not connected';
    $('#connections').classList.toggle('active',Boolean(microsoftAccount));
    if($('#overlay').classList.contains('show'))connectDialog();toast(wiped?`Google disconnected · Gmail data deleted from this device`:'Google disconnected');
  }
  // ---- Profile photo + greeting ----
  function readProfile(){try{return JSON.parse(localStorage.getItem('daylight-profile')||'{}')||{}}catch{return{}}}
  function renderProfile(){
    const p=readProfile(),el=$('#profile');const first=(p.name||'').trim().split(/\s+/)[0]||'';
    const h=new Date().getHours(),part=h<5?'Good evening':h<12?'Good morning':h<18?'Good afternoon':'Good evening';
    $('#greeting').innerHTML=esc(part)+(first?`, <span>${esc(first)}.</span>`:'.');
    if(!el)return;el.title=p.name?`${p.name}${p.email?' · '+p.email:''}`:'Connections';
    el.innerHTML=p.picture?`<img src="${esc(p.picture)}" alt="" referrerpolicy="no-referrer">`:esc((first[0]||'K').toUpperCase());
    const img=el.querySelector('img');if(img)img.onerror=()=>{el.textContent=(first[0]||'K').toUpperCase()};
  }
  function clearProfile(){setLS('daylight-profile','');renderProfile()}
  async function loadProfile(){
    try{
      if(token){const u=await api('https://www.googleapis.com/oauth2/v3/userinfo');if(u.name||u.picture||u.email||u.sub){const prevP=readProfile();if(prevP.sub&&u.sub&&prevP.sub!==u.sub)invalidateIdentity('switched',false);setLS('daylight-profile',JSON.stringify({name:u.name||'',picture:u.picture||'',email:u.email||'',sub:u.sub||''}));markIdentity(u);renderProfile();try{await ensureDaylightAccountFromProfile('google',u)}catch(e){console.warn('account upsert',e)}return}}
      if(microsoftAccount){const me=await graph('/me?$select=displayName,mail,userPrincipalName,id');let picture='';
        try{const t=await microsoftToken();const r=await fetch('https://graph.microsoft.com/v1.0/me/photos/96x96/$value',{headers:{Authorization:'Bearer '+t}});if(r.ok){const b=await r.blob();picture=await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(b)})}}catch{}
        const prof={name:me.displayName||'',picture,email:me.mail||me.userPrincipalName||'',sub:me.id||''};
        setLS('daylight-profile',JSON.stringify(prof));renderProfile();try{await ensureDaylightAccountFromProfile('microsoft',prof)}catch(e){console.warn('account upsert',e)}}
    }catch{/* older sign-ins may lack profile access; keep the letter */}
  }
  async function ensureDaylightAccountFromProfile(kind,u){
    const Store=window.DaylightStore;if(!Store?.upsertAccount)return null;
    const email=(u.email||'').toLowerCase()||null;
    const subject=u.sub||u.id||null;
    const acct=await Store.upsertAccount({
      kind:kind==='microsoft'?'microsoft':'google',
      subject,email,
      displayName:u.name||u.displayName||email||'Account',
      providerAccountKey:kind==='microsoft'
        ?(subject?'microsoft:oid:'+subject:(email?'microsoft:email:'+email:'microsoft:unknown'))
        :(subject?'google:sub:'+subject:(email?'google:email:'+email:'google:unknown')),
      status:'active'
    });
    await Store.setActiveAccount(acct.id);
    return acct;
  }
  $('#connections').onclick=connectDialog;
  $('#close')?.addEventListener('click',()=>$('#overlay').classList.remove('show'));
  $('#overlay').onclick=e=>{if(e.target.id==='overlay')$('#overlay').classList.remove('show')};

  function googleAuthError(code){
    const map={
      popup_closed_by_user:'Sign-in was closed before finishing. Tap Connect again.',
      access_denied:'Access was denied. Allow Daylight on Google’s screen, or add your Gmail as a test user in the OAuth consent screen.',
      immediate_failed:'Google could not complete sign-in automatically. Try Connect again.',
      invalid_request:'Google rejected the request. Check that this site origin is listed under Authorized JavaScript origins.',
      idpiframe_initialization_failed:'Google sign-in could not start. Allow third-party cookies for accounts.google.com, or try another browser.',
      origin_mismatch:`This site (${location.origin}) is not allowed for your Client ID. Add it under Authorized JavaScript origins in Google Cloud.`
    };
    return map[code]||('Google authorization failed: '+(code||'unknown error'));
  }
  function authorize(clientId,opts={}) {
    clientId=(clientId||$('#client-id')?.value||localStorage.getItem('daylight-client-id')||'').trim().replace(/\s+/g,'');
    const errBox=m=>{const el=$('#connect-error');if(el){el.hidden=!m;el.textContent=m||''}else if(m)toast(m)};
    if(!clientId.endsWith('.apps.googleusercontent.com')) { errBox('Enter your Google Client ID first (ends with .apps.googleusercontent.com).'); return; }
    localStorage.setItem('daylight-client-id',clientId);
    if(!window.google?.accounts?.oauth2) { errBox('Google sign-in is still loading. Try again in a moment.'); return; }
    errBox('');
    const mergePrior=false; // V2: a sign-in asks for exactly the base scopes; older grants (calendar, drive, gmail.send…) are never merged in
    tokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:scopes,include_granted_scopes:mergePrior,callback:async response=>{
      if(response.error){errBox(googleAuthError(response.error));return;}
      if(!response.access_token){errBox('Google did not return access. Try Connect again.');return;}
      if(token&&token!==response.access_token)resetGmailEngine(); // new grant (possibly another account): drop the in-memory mail cache
      if(token!==response.access_token)invalidateIdentity('new-google-token',false);
      token=response.access_token;
      rememberGoogleScopes(response.scope||scopes);
      if(!hasGmailReadonly()){errBox('Google did not grant gmail.readonly. On the consent screen, allow Daylight to read your mail (not metadata only), then try again.');return;}
      $('#overlay').classList.remove('show');$('#connections').classList.add('active');$('#sync-status').textContent='Google connected · refreshing…';
      setTimeout(()=>{token=null;$('#connections').classList.remove('active');$('#sync-status').textContent='Google access expired · reconnect to refresh';},Math.max(0,(Number(response.expires_in||3600)-60)*1000));
      try{await refreshAll();toast('Google connected · Gmail read-only');}catch(e){toast('Connected, but some data failed to load');}
    },error_callback:e=>{errBox(googleAuthError(e?.type||e?.message||'popup_closed_by_user'))}});
    try{tokenClient.requestAccessToken({prompt:'consent'})}
    catch(e){errBox(googleAuthError(e?.message||'invalid_request'))}
  }
  /** Optional Google connector (calendar | tasks | contacts): asks Google for that one extra read-only scope. */
  function connectGoogleProduct(name){
    const sc=OPTIONAL_GOOGLE_SCOPES[name];if(!sc)return;
    try{localStorage.setItem('daylight-connector-'+name,'1')}catch{}
    if(serverUrl&&serverSession){
      const q=new URLSearchParams({return:location.origin+location.pathname,add:name});
      location.href=serverUrl+'/auth/google/start?'+q.toString();return;
    }
    const clientId=(localStorage.getItem('daylight-client-id')||'').trim();
    if(!window.google?.accounts?.oauth2||!clientId){toast('Connect Gmail first',{type:'warn'});return}
    const c=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:scopes+' '+sc,include_granted_scopes:true,callback:async r=>{
      if(r.error||!r.access_token){toast('Google did not grant access',{type:'warn'});return}
      token=r.access_token;rememberGoogleScopes(r.scope||'');
      toast(hasGoogleScope(name)?`${name[0].toUpperCase()+name.slice(1)} connected · read-only`:'Google did not grant that permission',{type:hasGoogleScope(name)?'ok':'warn'});
      try{await refreshAll()}catch{}
    }});
    c.requestAccessToken({prompt:'consent'});
  }
  window.DaylightConnectGoogleProduct=connectGoogleProduct;
  function requestGmailSendAccess(){
    const clientId=(localStorage.getItem('daylight-client-id')||'').trim();
    if(serverUrl){
      toast('Reconnect Google to refresh mail permissions',{type:'warn'});
      const q=new URLSearchParams({return:location.origin+location.pathname,upgrade:'1'});
      location.href=serverUrl+'/auth/google/start?'+q.toString();
      return;
    }
    if(!clientId){toast('Connect Google first',{type:'warn'});connectDialog({setup:true,focusId:true});return}
    authorize(clientId,{upgrade:true});
  }
  function requestFitnessAccess(){
    const clientId=(localStorage.getItem('daylight-client-id')||'').trim();
    if(!clientId){toast('Connect Google first',{type:'warn'});connectDialog({setup:true,focusId:true});return}
    if(!window.google?.accounts?.oauth2){toast('Google sign-in is still loading',{type:'warn'});return}
    const fitnessClient=google.accounts.oauth2.initTokenClient({
      client_id:clientId,
      scope:FITNESS_SCOPES,
      include_granted_scopes:true,
      callback:async response=>{
        if(response.error){toast(googleAuthError(response.error),{type:'err'});return}
        if(response.access_token)token=response.access_token;
        rememberGoogleScopes([googleScopeBlob(),response.scope||FITNESS_SCOPES].filter(Boolean).join(' '));
        toast('Google Fit connected',{type:'ok',haptic:'success'});
        if(typeof renderStats==='function')renderStats({force:true});
      },
      error_callback:e=>toast(googleAuthError(e?.type||e?.message||'popup_closed_by_user'),{type:'err'})
    });
    try{fitnessClient.requestAccessToken({prompt:''})}
    catch{try{fitnessClient.requestAccessToken({prompt:'consent'})}catch(e){toast('Could not open Google Fit consent',{type:'err'})}}
  }
  const microsoftScopes=['User.Read','Mail.ReadBasic','Calendars.ReadBasic','Tasks.Read'];
  async function authorizeMicrosoft() {
    const clientId=$('#ms-client-id')?.value.trim()||'';
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(clientId)){ $('#connect-error').textContent='Enter your Microsoft application (client) ID first.'; return; }
    localStorage.setItem('daylight-ms-client-id',clientId);
    if(!window.msal?.PublicClientApplication){$('#connect-error').textContent='Microsoft sign-in is still loading. Try again in a moment.';return;}
    try{
      microsoftApp=new msal.PublicClientApplication({auth:{clientId,authority:'https://login.microsoftonline.com/common',redirectUri:location.origin+location.pathname},cache:{cacheLocation:'sessionStorage',storeAuthStateInCookie:false}});
      if(microsoftApp.initialize) await microsoftApp.initialize();
      const accounts=microsoftApp.getAllAccounts();
      const response=accounts.length?await microsoftApp.acquireTokenSilent({scopes:microsoftScopes,account:accounts[0]}):await microsoftApp.loginPopup({scopes:microsoftScopes});
      microsoftAccount=response.account||accounts[0];
      $('#overlay').classList.remove('show');$('#connections').classList.add('active');$('#sync-status').textContent='Microsoft connected · refreshing…';
      await refreshAll();
    }catch(error){
      if(error instanceof msal.InteractionRequiredAuthError){try{const response=await microsoftApp.acquireTokenPopup({scopes:microsoftScopes,account:microsoftAccount||undefined});microsoftAccount=response.account||microsoftAccount;$('#overlay').classList.remove('show');$('#connections').classList.add('active');await refreshAll();return}catch(popupError){error=popupError}}
      $('#connect-error').textContent='Microsoft authorization failed: '+(error.message||'Please check the app registration and try again.');
    }
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
  // rules, selective bodies, HTTP batch, AI budget, sync slots). Falls back to the Phase 1 engine when disabled. ----
  let mailV2=null,lastGmailDecision=null,v2Channel=null,v2SlotTimer=null;
  const V2_AI_CAT={travel:'travel',bills:'bill',finance:'payment',subscriptions:'subscription',shopping:'receipt',delivery:'receipt',documents:'document',government:'document',security:'security',promotions:'promotion',newsletters:'newsletter',social:'social',personal:'personal',work:'personal'};
  function v2Enabled(){
    const W=window;
    if(DEMO||!(W.DaylightMailPipeline&&W.DaylightGmailConfig&&W.DaylightMailCache&&W.DaylightGmailRules&&W.DaylightGmailBatch&&W.DaylightAiBudget&&W.DaylightSyncScheduler))return false;
    try{return W.DaylightGmailConfig.load().engine.mode!=='legacy'}catch{return false}
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
    const actions=W.DaylightActions.createActions({graph,registry,ruleStore,classifier:W.DaylightClassifier});
    const log=W.DaylightProcessingLog.createLog({graph});
    const local=W.DaylightLocalConnector?W.DaylightLocalConnector.createLocalConnector({graph,mailKey:mid=>'gmail:'+v2AccountKey()+':'+mid}):null;
    v2Core.o={graph,registry,gmail,ruleStore,actions,log,local};
    W.DaylightV2=v2Core.o; W.DaylightGraph=graph; W.DaylightPrivacyLog=log;
    return v2Core.o;
  }
  /** After each Gmail sync: mail cache → Item Graph (idempotent; keeps user actions and corrections). Watermark = ingest start: sync always finishes before ingest, so anything processed later has a later lastProcessedAt. */
  async function v2IngestGmail(){
    const c=v2Core();if(!c||!v2Enabled())return null;
    if(!identityVerified){v2IngestGmail.last={skipped:'account not confirmed yet',at:Date.now()};return null}
    const key='daylight-graph-ingest:x3:'+v2AccountKey(); /* x3: extraction fixes + per-account people/organisations (Phase E) → one full re-ingest */let since=0;try{since=Number(localStorage.getItem(key))||0}catch{}
    const t0=Date.now();
    try{const r=await c.gmail.ingest(v2AccountKey(),{since});try{localStorage.setItem(key,String(t0))}catch{};try{await c.local?.importLocal()}catch(e){console.warn('local import',e)};v2IngestGmail.last=c.lastIngest={...r,at:Date.now(),ms:Date.now()-t0,incremental:!!since};try{const lk='daylight-v2-ingest-log:'+v2AccountKey();const l=JSON.parse(localStorage.getItem(lk)||'[]');l.push(c.lastIngest);localStorage.setItem(lk,JSON.stringify(l.slice(-20)))}catch{};return r}catch(e){console.warn('graph ingest',e);try{localStorage.setItem('daylight-v2-engine-error:'+v2AccountKey(),JSON.stringify({at:Date.now(),stage:'graph ingest',message:String(e&&e.message||e).slice(0,300)}))}catch{};v2IngestGmail.last={error:String(e?.message||e),at:Date.now()};return null}
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
  // two-tap confirmation without a browser dialog
  function confirmInline(btn,msg){if(btn.dataset.armed==='1'){btn.dataset.armed='';return true}btn.dataset.armed='1';const old=btn.textContent;btn.textContent=msg;setTimeout(()=>{if(btn.dataset.armed==='1'){btn.dataset.armed='';btn.textContent=old}},5000);return false}
  function v2Accounts(){try{return JSON.parse(localStorage.getItem('daylight-gmail-accounts')||'[]')}catch{return []}}
  function v2RememberAccount(k){try{const a=v2Accounts();if(!a.includes(k)){a.push(k);localStorage.setItem('daylight-gmail-accounts',JSON.stringify(a.slice(-10)))}}catch{}}
  /** Sync Efficiency panel (inside Sync Diagnostics). Gmail quota units and AI money are shown separately. */
  async function v2EfficiencyHTML(){
    if(!v2Enabled())return '<div style="margin:8px 0;font-size:12px">Gmail engine: Phase 1 (cost optimisation off)</div>';
    const v=getMailV2(),M=window.DaylightSyncMetrics,acct=v2AccountKey();
    const accts=[...new Set([acct,...v2Accounts()])];
    const per=await Promise.all(accts.map(async a=>({a,rows:await v.cache.metrics(a)})));
    const mine=per.find(x=>x.a===acct)?.rows||[],all=per.flatMap(x=>x.rows);
    const d1=M.summarise(mine,{days:1}),d7=M.summarise(mine,{days:7}),agg=M.summarise(all,{days:1});
    const idx=await v.cache.all(acct),cp=await v.cache.getCheckpoint(acct)||{};
    const n=k=>idx.filter(r=>r.status===k).length;
    const tr=(label,a,b,c)=>`<tr><td>${esc(label)}</td><td>${esc(String(a??'—'))}</td><td>${esc(String(b??'—'))}</td>${accts.length>1?`<td>${esc(String(c??'—'))}</td>`:''}</tr>`;
    const pct=x=>x==null?'—':Math.round(x*100)+' %';
    const ms=x=>x==null?'—':(x/1000).toFixed(1)+' s';
    const rules=x=>Object.entries(x.rules).map(([k,v])=>v?`${k} ${v}`:'').filter(Boolean).join(', ')||'—';
    return `<div style="margin:10px 0;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--card2);font-size:12px;line-height:1.45">
      <b>Sync efficiency</b> · ${idx.length} emails indexed · window ${cp.windowDays||v.config.window.backfillDays} days · last mode ${esc(cp.lastMode||'—')}<br>
      <span style="color:var(--muted)">Gmail quota units are Google's free per-user allowance (6,000 per minute), not money. AI cost is money and is estimated from the price table.</span>
      <table style="width:100%;border-collapse:collapse;margin-top:6px"><thead><tr><th style="text-align:left">Metric</th><th>Today</th><th>7 days</th>${accts.length>1?'<th>All accounts today</th>':''}</tr></thead><tbody>
      ${tr('Syncs (scheduled / manual / open / catch-up)',`${d1.syncs.scheduled}/${d1.syncs.manual}/${d1.syncs.open}/${d1.syncs.catchUp}`,`${d7.syncs.scheduled}/${d7.syncs.manual}/${d7.syncs.open}/${d7.syncs.catchUp}`,agg.syncs.total)}
      ${tr('Gmail quota units',d1.quota.units,d7.quota.units,agg.quota.units)}
      ${(()=>{const ds=lastGmailReport?.discovery;if(!ds)return '';const u=Object.entries(ds.unitsByKind||{}).map(([k,v])=>`${k} ${v}`).join(', ')||'—';return tr('Last sync: discovered / metadata / bodies / skipped',`${ds.discovered} / ${ds.metadataFetched} / ${ds.bodiesFetched} / ${ds.skipped}${ds.recoveryNet?' · recovery net ran':''}`,'','')+tr('Last sync: quota units by operation',u,'','')})()}
      ${(()=>{const cats={};idx.forEach(r=>{const l=r.labels||[];const c=l.includes('SENT')&&!l.some(x=>/^CATEGORY_/.test(x))?'sent':((l.find(x=>/^CATEGORY_/.test(x))||'CATEGORY_PERSONAL').replace('CATEGORY_','').toLowerCase().replace('personal','primary'));cats[c]=cats[c]||{read:0,skipped:0};r.status==='skipped'?cats[c].skipped++:cats[c].read++});return tr('Categories covered (read · skipped, no content kept)',Object.entries(cats).map(([c,v])=>`${c} ${v.read}·${v.skipped}`).join(', ')||'—','','')})()}
      ${tr('history.list / messages.list',`${d1.quota.historyList} / ${d1.quota.messagesList}`,`${d7.quota.historyList} / ${d7.quota.messagesList}`,`${agg.quota.historyList} / ${agg.quota.messagesList}`)}
      ${tr('Metadata GETs / full-body GETs',`${d1.quota.metadataGets} / ${d1.quota.fullGets}`,`${d7.quota.metadataGets} / ${d7.quota.fullGets}`,`${agg.quota.metadataGets} / ${agg.quota.fullGets}`)}
      ${tr('Batch requests (parts)',`${d1.quota.batchRequests} (${d1.quota.batchedParts})`,`${d7.quota.batchRequests} (${d7.quota.batchedParts})`,agg.quota.batchRequests)}
      ${tr('Decided without a body',d1.skippedWithoutBody,d7.skippedWithoutBody,agg.skippedWithoutBody)}
      ${tr('By rule stage',rules(d1),rules(d7),'')}
      ${tr('Domain-cache hit rate',pct(d1.domainCache.hitRate),pct(d7.domainCache.hitRate),pct(agg.domainCache.hitRate))}
      ${tr('Duplicate requests avoided',d1.duplicatesAvoided,d7.duplicatesAvoided,agg.duplicatesAvoided)}
      ${tr('Label-only updates / deletions',`${d1.labelOnlyUpdates} / ${d1.deletionsMarked}`,`${d7.labelOnlyUpdates} / ${d7.deletionsMarked}`,'')}
      ${tr('AI requests',d1.ai.requests,d7.ai.requests,agg.ai.requests)}
      ${tr('AI tokens in / out',`${d1.ai.inputTokens} / ${d1.ai.outputTokens}`,`${d7.ai.inputTokens} / ${d7.ai.outputTokens}`,`${agg.ai.inputTokens} / ${agg.ai.outputTokens}`)}
      ${tr('AI estimated cost (money, USD)','$'+d1.ai.estimatedCostUsd,'$'+d7.ai.estimatedCostUsd,'$'+agg.ai.estimatedCostUsd)}
      ${tr('AI deferred (cap / 5 % share)',d1.ai.deferred,d7.ai.deferred,agg.ai.deferred)}
      ${tr('Review queue',n('review'),'','')}
      ${tr('Bodies queued / metadata waiting',`${n('body-queued')} / ${n('meta-pending')}`,'','')}
      ${tr('Cold / warm sync duration',`${ms(d1.duration.coldMs)} / ${ms(d1.duration.warmMs)}`,`${ms(d7.duration.coldMs)} / ${ms(d7.duration.warmMs)}`,'')}
      ${tr('Failed / deferred operations',`${d1.failed} / ${d1.deferred}`,`${d7.failed} / ${d7.deferred}`,`${agg.failed} / ${agg.deferred}`)}
      </tbody></table>
      <div style="margin-top:6px;color:var(--muted)">Last decision: ${esc(lastGmailDecision?`${lastGmailDecision.trigger} → ${lastGmailDecision.run?lastGmailDecision.label:'skipped'} (${lastGmailDecision.reason})`:'—')} · next slot ${esc((()=>{const t=window.DaylightSyncScheduler.nextSlot(Date.now(),v.config.schedule.slots);return t?new Date(t).toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit'}):'—'})())}</div>
      <div class="server-actions" style="margin-top:8px"><button class="connect ghost" type="button" data-v2-older>Scan older bills (${v.config.window.olderScanDays} days)</button><button class="connect ghost" type="button" data-v2-clear>Clear mail cache</button></div>
    </div>`;
  }
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
  const header=(headers,name)=>headers?.find(x=>x.name?.toLowerCase()===name.toLowerCase())?.value||'';
  function renderAll(){renderCalendar();renderMail();renderTasks();renderInsights();renderDrive();renderBirthdays();if(typeof renderLoops==='function'){renderLoops();renderUpNext()}}
  function renderCalendar(){queueInsights();
    const events=[...(providerData.google.events||[]),...(providerData.microsoft.events||[])].sort((a,b)=>new Date(a.start?.dateTime||a.start?.date||0)-new Date(b.start?.dateTime||b.start?.date||0));
    $('#caldate').textContent=date.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    $('#events').innerHTML=events.length?events.slice(0,12).map(e=>{const raw=e.start?.dateTime||e.start?.date;const start=raw?new Date(raw):null;const t=start&&e.start?.dateTime?start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'All day';const end=e.end?.dateTime?new Date(e.end.dateTime):null;return `<div class="event"><span class="time">${esc(t)}</span><span class="event-bar"></span><div><div class="event-name">${esc(e.summary||e.subject||'(No title)')}</div><div class="event-sub">${esc(e.location?.displayName||e.location||e.organizer?.displayName||e.source||'Calendar')}</div></div><span class="badge">${end&&start?Math.max(1,Math.round((end-start)/60000))+' min':'Event'}</span></div>`}).join(''):`<div class="empty">${providerData.google.events||providerData.microsoft.events?'Nothing scheduled today. Enjoy the breathing room.':'Connect a calendar to see today’s events.'}</div>`;
    $('#event-count').textContent=(providerData.google.events||[]).length+(providerData.microsoft.events||[]).length;
  }
  function renderMail(){
    const msgs=[...(providerData.google.mails||[]),...(providerData.microsoft.mails||[])].sort((a,b)=>(b.sortDate||0)-(a.sortDate||0)).filter(m=>wset('mail').only!=='Unread only'||m.unread).slice(0,+(wset('mail').count||8));
    $('#mail-list').innerHTML=msgs.length?msgs.map(m=>`<div class="mail-item"><div class="avatar">${esc(m.initials||'M')}</div><div><div class="sender">${esc(m.sender||'')}</div><div class="subject">${esc(m.subject||'(No subject)')}</div><div class="snippet">${m.unread?'Unread · ':''}${esc(m.time||m.source||'Inbox')}</div></div><span class="mail-time">${m.unread?'NEW':''}</span></div>`).join(''):`<div class="empty">${providerData.google.mails||providerData.microsoft.mails?'Your inbox is clear.':'Connect Gmail or Outlook to view inbox messages.'}</div>`;
    $('#mail-count').textContent=(providerData.google.mails||[]).length+(providerData.microsoft.mails||[]).length;
  }
  function renderTasks(){queueInsights();
    const tasks=[...personalTasks.map(t=>({...t,personal:true,source:[fmtDue(t),t.project].filter(Boolean).join(' · ')||'Personal'})),...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[])].slice(0,10);
    $('#task-count').textContent=tasks.length;$('#done-count').textContent=tasks.length;
    $('.task-list').innerHTML=tasks.length?tasks.map(t=>`<div class="task"><${t.personal?'button type="button" data-local-task="'+esc(t.id)+'" class="check local-check" aria-label="Complete '+esc(t.title)+'"':'span class="check" aria-hidden="true"'}></${t.personal?'button':'span'}><div class="task-text">${esc(t.title||'(Untitled task)')}<div class="task-meta">${esc(t.due||t.listName||t.source||'Task')}</div></div></div>`).join(''):`<div class="empty">${providerData.google.tasks||providerData.microsoft.tasks?'No open tasks. Add a personal task above.':'Add a personal task above or connect Google Tasks.'}</div>`;
  }
  const personalTaskForm=$('#personal-task-form');
  if(personalTaskForm) personalTaskForm.addEventListener('submit',e=>{e.preventDefault();const input=$('#personal-task-input'),title=input.value.trim();if(!title)return;personalTasks.unshift({id:crypto.randomUUID?.()||String(Date.now()),title});localStorage.setItem('daylight-personal-tasks',JSON.stringify(personalTasks));input.value='';renderTasks();toast('Task added on this device');});
  $('.task-list').addEventListener('click',e=>{const button=e.target.closest('[data-local-task]');if(!button)return;logDone(personalTasks.find(t=>t.id===button.dataset.localTask));personalTasks=personalTasks.filter(t=>t.id!==button.dataset.localTask);localStorage.setItem('daylight-personal-tasks',JSON.stringify(personalTasks));renderTasks();toast('Personal task completed');});
  async function loadCalendar(){
    // Today from every selected calendar, all pages (was: primary only, first 12 events); declined events are left out
    const items=await googleEventsBetween(localMidnight,tomorrow);
    items.sort((a,b)=>new Date(a.start?.dateTime||a.start?.date+'T00:00')-new Date(b.start?.dateTime||b.start?.date+'T00:00'));
    providerData.google.events=items.map(e=>({...e,source:e.source||'Google Calendar'}));renderCalendar();
    return providerData.google.events.length;
  }
  async function loadMail(){
    // v2: the Mail widget reads the inbox from the same Gmail pass as everything else (0 extra Gmail requests)
    let res=null;
    if(v2Enabled()&&v2InboxWait){const pools=await v2InboxWait.promise;if(pools)res={msgs:(pools.inbox||[]).slice(0,10),failed:[],partial:false,error:null}}
    // Shares cache, quota budget and retries with the Gmail sync engine (no duplicate fetches of the same inbox mail)
    if(!res)res=await gmailEngine().fetchList('labelIds=INBOX&q='+encodeURIComponent(gmailExcludeQ()),10,'metadata');
    if(res.error&&!res.msgs.length){const e=new Error('Mail: '+(res.error.message||res.error.kind||'Gmail unavailable'));e.status=res.error.status;throw e}
    const msgs=res.msgs;
    providerData.google.mailsNote=res.partial?`Mail: ${res.failed.length||'some'} of ${res.msgs.length+res.failed.filter(f=>!f.stale).length} inbox messages could not refresh`:'';
    providerData.google.mails=msgs.map(m=>{const h=m.payload?.headers||[];const from=header(h,'From');const sender=from.replace(/<.*?>/,'').replace(/"/g,'').trim()||from;const when=header(h,'Date');const d=when?new Date(when):null;return {sender,subject:header(h,'Subject')||'(No subject)',time:d?d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'',sortDate:d?.getTime()||0,unread:m.labelIds?.includes('UNREAD'),initials:sender.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'G',source:'Gmail'}});renderMail();
    if(providerData.google.mailsNote){const e=new Error(providerData.google.mailsNote);e.partial=true;throw e}
    return providerData.google.mails.length;
  }
  async function loadTasks(){
    const t0=Date.now();let retries=0;
    let lists;
    try{
      const r=await apiRetry('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20');lists=r.data;retries+=r.retries;
    }catch(e){
      try{const Store=window.DaylightStore;const acct=await Store?.getActiveAccountId?.();if(Store&&acct)await Store.recordSyncFailure('tasks',e,{retries,mode:'full'},acct)}catch{}
      throw e;
    }
    await accountReady();
    // every list (up to 10) and every open task (paged, up to 300 per list) — was: 3 lists, first 8 tasks
    const groups=await Promise.all((lists.items||[]).slice(0,10).map(async l=>{
      const items=[];let pageToken='';
      do{
        const r=await apiRetry(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=100${pageToken?'&pageToken='+encodeURIComponent(pageToken):''}`);
        retries+=r.retries;(r.data?.items||[]).forEach(t=>items.push(t));pageToken=r.data?.nextPageToken||'';
      }while(pageToken&&items.length<300);
      return {items};
    }));
    const dueKey=t=>t.dueDate?Date.parse(t.dueDate):Infinity;
    providerData.google.tasks=groups.flatMap((g,i)=>(g.items||[]).filter(t=>t.status!=='completed'&&t.title).map(t=>({id:t.id,title:t.title,due:t.due?new Date(t.due).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'',dueDate:t.due||'',listName:lists.items[i].title,source:'Google Tasks',href:t.webViewLink||'https://tasks.google.com/'}))).sort((a,b)=>dueKey(a)-dueKey(b));renderTasks();
    try{
      const Store=window.DaylightStore;const acct=await Store?.getActiveAccountId?.();
      if(Store&&acct)await Store.recordSyncSuccess('tasks',{durationMs:Date.now()-t0,retries,fetched:providerData.google.tasks.length,mode:'reconcile'},acct);
    }catch{}
    return providerData.google.tasks.length;
  }
  async function microsoftToken(){
    if(!microsoftApp||!microsoftAccount)return null;
    try{return (await microsoftApp.acquireTokenSilent({scopes:microsoftScopes,account:microsoftAccount})).accessToken}
    catch(error){if(error instanceof msal.InteractionRequiredAuthError)return (await microsoftApp.acquireTokenPopup({scopes:microsoftScopes,account:microsoftAccount})).accessToken;throw error}
  }
  async function graph(path){
    const accessToken=await microsoftToken();const response=await fetch(`https://graph.microsoft.com/v1.0${path}`,{headers:{Authorization:`Bearer ${accessToken}`}});
    if(!response.ok){let detail='';try{detail=(await response.json()).error?.message||''}catch{}throw new Error(detail||`Microsoft Graph error (${response.status})`)}return response.json();
  }
  async function loadMicrosoftCalendar(){
    const u=new URL('https://graph.microsoft.com/v1.0/me/calendarView');u.searchParams.set('startDateTime',iso(localMidnight));u.searchParams.set('endDateTime',iso(tomorrow));u.searchParams.set('$select','subject,start,end,location');u.searchParams.set('$orderby','start/dateTime');u.searchParams.set('$top','12');
    const data=await graph('/me/calendarView'+u.search);providerData.microsoft.events=(data.value||[]).map(e=>({...e,source:'Outlook Calendar'}));renderCalendar();return providerData.microsoft.events.length;
  }
  async function loadMicrosoftMail(){
    const data=await graph('/me/mailFolders/inbox/messages?$top=8&$select=from,subject,receivedDateTime,isRead&$orderby=receivedDateTime%20desc');
    providerData.microsoft.mails=(data.value||[]).map(m=>{const sender=m.from?.emailAddress?.name||m.from?.emailAddress?.address||'Outlook';const d=m.receivedDateTime?new Date(m.receivedDateTime):null;return {sender,subject:m.subject||'(No subject)',time:d?d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'',sortDate:d?.getTime()||0,unread:!m.isRead,initials:sender.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'O',source:'Outlook'}});renderMail();return providerData.microsoft.mails.length;
  }
  async function loadMicrosoftTasks(){
    const lists=await graph('/me/todo/lists?$top=5');const groups=await Promise.all((lists.value||[]).slice(0,3).map(l=>graph(`/me/todo/lists/${encodeURIComponent(l.id)}/tasks?$top=20&$select=title,status,dueDateTime`)));
    providerData.microsoft.tasks=groups.flatMap((g,i)=>(g.value||[]).filter(t=>t.status!=='completed').map(t=>({title:t.title,due:t.dueDateTime?.dateTime?new Date(t.dueDateTime.dateTime).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'',dueDate:t.dueDateTime?.dateTime||'',listName:lists.value[i].displayName,source:'Microsoft To Do'}))).slice(0,8);renderTasks();return providerData.microsoft.tasks.length;
  }
  let lastSyncOk=0,lastSyncErr='',syncBusy=false,lastSyncPartial=false,lastRefreshStart=0,profileReady=null,v2InboxWait=null;
  const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
  const accountReady=()=>Promise.race([profileReady||Promise.resolve(),new Promise(r=>setTimeout(r,8000))]).catch(()=>{});
  async function refreshAll(){
    if(!token&&!microsoftAccount){if(DEMO){syncBusy=true;lastSyncErr='';if(typeof renderDrawerSync==='function')renderDrawerSync();await loadLoops(true);renderCategories();renderSmart();syncBusy=false;lastSyncOk=Date.now();if(typeof renderDrawerSync==='function')renderDrawerSync()}return}
    syncBusy=true;lastSyncErr='';lastRefreshStart=Date.now();if(typeof renderDrawerSync==='function')renderDrawerSync();
    $('#sync-status').textContent=`Connected to ${[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean).join(' and ')} · refreshing…`;
    // Profile first: it selects the active Daylight account, so sync state is never written to the wrong account.
    profileReady=loadProfile();
    const gmailTrigger=refreshAll.force?'manual':(refreshAll.trigger||'open'),gmailExtra={slotAt:refreshAll.slotAt||null,olderScan:!!refreshAll.olderScan};
    refreshAll.trigger=null;refreshAll.slotAt=null;refreshAll.olderScan=false;
    v2InboxWait=deferred();
    const jobs=[];if(token){jobs.push(loadMail(),loadLoops(refreshAll.force,gmailTrigger,gmailExtra));if(hasGoogleScope('calendar'))jobs.push(loadCalendar());if(hasGoogleScope('tasks'))jobs.push(loadTasks());if(hasGoogleScope('contacts'))jobs.push(loadBirthdays())}refreshAll.force=false;if(microsoftAccount)jobs.push(loadMicrosoftCalendar(),loadMicrosoftMail(),loadMicrosoftTasks());
    const results=await Promise.allSettled(jobs);const failed=results.filter(r=>r.status==='rejected');renderAll();renderCategories();
    const eventCount=(providerData.google.events||[]).length+(providerData.microsoft.events||[]).length,mailCount=(providerData.google.mails||[]).length+(providerData.microsoft.mails||[]).length,taskCount=(providerData.google.tasks||[]).length+(providerData.microsoft.tasks||[]).length;
    const cats=computeCategories();
    const money=cats.money||computeMoney();
    $('#headline-note').innerHTML=`Today: <b>${eventCount} events</b> · <b>${cats.pending.length} pending</b> · <b>${money.counts.total} money</b> · <b>${loopsData?computeLoops().length:0} loops</b>`;
    // Truthful status: a partial Gmail sync or any failed job is never reported as "updated".
    const problems=failed.map(x=>x.reason?.message||String(x.reason||'Unknown error'));
    const gr=token?lastGmailReport:null;
    if(gr&&gr.partial&&!problems.some(p=>p===gr.summary))problems.unshift(gr.summary);
    const hm2=t=>new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
    const lastFull=lastGmailFullSyncAt||lastSyncOk;
    const hardFail=failed.length===results.length&&results.length>0;
    $('#sync-status').textContent=problems.length
      ?`${hardFail?'Sync failed':'Partial sync'} · ${problems.join('; ')} · ${lastFull?'last full sync '+hm2(lastFull):'no full sync yet'}`
      :`Connected to ${[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean).join(' and ')} · updated ${hm2(Date.now())}`;
    syncBusy=false;
    if(problems.length){lastSyncErr=problems.join('; ');lastSyncPartial=!hardFail;toast(hardFail?'Sync failed · check the status line':'Sync incomplete · some items will retry on the next refresh',{type:'warn'})}
    else {lastSyncOk=Date.now();lastSyncPartial=false}
    mWeekCache={};mCalIds=null;
    v2InboxWait?.resolve(null);
    v2ArmSlots();
    if(typeof renderDrawerSync==='function')renderDrawerSync();
    if(typeof renderAssistant==='function'&&mq.matches&&mTab==='assistant'&&!mAssistAsk)renderAssistant();
  }
  $('#refresh').onclick=()=>{if(token||microsoftAccount||DEMO){refreshAll.force=true;refreshAll()}else toast('Connect an app first to refresh live data.')};
  $('#weather-connect').onclick=()=>{
    if(!navigator.geolocation){$('#weather-content').textContent='Location is unavailable in this browser.';return}
    $('#weather-content').textContent='Waiting for location permission…';navigator.geolocation.getCurrentPosition(async pos=>{try{const {latitude,longitude}=pos.coords;const u=`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;const w=await(await fetch(u)).json();const names={0:'Clear sky',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',61:'Rain',63:'Rain',65:'Heavy rain',71:'Snow',80:'Showers',95:'Thunderstorm'};$('#weather-content').innerHTML=`<div class="weather-temp">${Math.round(w.current.temperature_2m)}°</div><div class="weather-label">${esc(names[w.current.weather_code]||'Current conditions')}</div><div class="weather-range">Feels like ${Math.round(w.current.apparent_temperature)}° · H ${Math.round(w.daily.temperature_2m_max[0])}° / L ${Math.round(w.daily.temperature_2m_min[0])}°</div>`;$('#weather-connect').textContent='Refresh';}catch(e){$('#weather-content').textContent='Weather could not be loaded. Try again.'}},()=>{$('#weather-content').textContent='Location permission was not granted. You can allow it in browser settings.'},{enableHighAccuracy:false,timeout:10000});
  };
  // Focus refresh is throttled (≥2 min apart, never while a sync runs) so switching tabs cannot burn Gmail quota.
  // v2: Gmail itself is gated by the sync slots and the 15-minute open-refresh rule (see v2GmailSync).
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&(token||microsoftAccount)&&!syncBusy&&Date.now()-lastRefreshStart>120000){refreshAll.trigger='visible';refreshAll()}});
  const clientId=localStorage.getItem('daylight-client-id');if(clientId){$('#sync-status').textContent='Google setup saved · connect to grant access';}
  // ---- Today timeline + free-time finder (runs on data already loaded; nothing leaves the browser) ----
  let DAY_START=8, DAY_END=20;const MIN_GAP=25;
  try{const h=JSON.parse(localStorage.getItem('daylight-hours')||'null');if(h&&h.end>h.start&&h.start>=0&&h.end<=23){DAY_START=h.start;DAY_END=h.end}}catch{}
  var insightsQueued=false;
  function queueInsights(){if(insightsQueued)return;insightsQueued=true;setTimeout(()=>{insightsQueued=false;renderInsights()},0)}
  const hm=d=>d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  function todayEvents(){
    todayEvents.allDayItems=[];
    const all=[...(providerData.google.events||[]),...(providerData.microsoft.events||[])];
    const timed=[],allDay=[];
    all.forEach(e=>{
      if(e.start?.dateTime){
        const tz=e.start.timeZone==='UTC'&&!/[zZ]|[+-]\d\d:?\d\d$/.test(e.start.dateTime);// Graph returns UTC without suffix
        const st=new Date(e.start.dateTime+(tz?'Z':'')),en=new Date((e.end?.dateTime||e.start.dateTime)+(tz?'Z':''));
        if(e.responseStatus?.response==='declined'||(e.attendees||[]).find(a=>a.self)?.responseStatus==='declined')return;
        if(en>localMidnight&&st<tomorrow)timed.push({id:e.id,title:e.summary||e.subject||'(No title)',start:st,end:en>st?en:new Date(st.getTime()+30*60000),href:e.htmlLink||e.webLink||'',location:typeof e.location==='string'?e.location:(e.location?.displayName||''),guests:(e.attendees||[]).length,online:!!(e.hangoutLink||e.conferenceData||e.onlineMeeting)});
      } else if(e.start?.date||e.isAllDay){allDay.push(e.summary||e.subject||'(No title)');(todayEvents.allDayItems=todayEvents.allDayItems||[]).push(e)}
    });
    return {timed:timed.sort((a,b)=>a.start-b.start),allDay,connected:!!(providerData.google.events||providerData.microsoft.events)};
  }
  function freeGaps(timed,from,to){
    const gaps=[];let cur=from;
    timed.forEach(ev=>{if(ev.end<=cur||ev.start>=to)return;if(ev.start>cur)gaps.push({start:cur,end:new Date(Math.min(ev.start,to))});if(ev.end>cur)cur=ev.end});
    if(cur<to)gaps.push({start:cur,end:to});
    return gaps.map(g=>({...g,min:Math.round((g.end-g.start)/60000)})).filter(g=>g.min>=MIN_GAP);
  }
  function overlaps(timed){const out=[];for(let i=1;i<timed.length;i++)for(let j=0;j<i;j++)if(timed[i].start<timed[j].end)out.push([timed[j],timed[i]]);return out}
  function dueToday(){
    const isToday=v=>{if(!v)return false;const d=new Date(v);// Google Tasks due dates are midnight UTC dates
      const ds=/T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):d;return ds<tomorrow};
    return [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[])].filter(t=>isToday(t.dueDate));
  }
  function ensureTimeline(){
    let tl=$('#timeline');if(tl)return tl;
    const hero=$('.hero');if(!hero)return null;
    tl=document.createElement('div');tl.id='timeline';tl.className='timeline';tl.setAttribute('aria-label','Today timeline');
    hero.append(tl);return tl;
  }
  function renderInsights(){
    const now=new Date(),{timed,allDay,connected}=todayEvents();
    const dayStart=new Date(localMidnight.getTime()+DAY_START*3600000),dayEnd=new Date(localMidnight.getTime()+DAY_END*3600000);
    const span=dayEnd-dayStart,pct=d=>Math.max(0,Math.min(100,(d-dayStart)/span*100));
    const gaps=connected?freeGaps(timed,new Date(Math.max(now,dayStart)),dayEnd):[];
    const clashes=overlaps(timed),due=dueToday();
    const tl=ensureTimeline();
    if(tl){
      const hours=[];const stepH=DAY_END-DAY_START>12?3:DAY_END-DAY_START>6?2:1;for(let h=DAY_START;h<=DAY_END;h+=stepH)hours.push(`<span style="left:${(h-DAY_START)/(DAY_END-DAY_START)*100}%">${String(h).padStart(2,'0')}</span>`);
      const laneEnd=[];timed.forEach(e=>{let l=laneEnd.findIndex(t=>t<=e.start);if(l<0){l=laneEnd.length;laneEnd.push(e.end)}else laneEnd[l]=e.end;e.lane=l});
      const blocks=timed.filter(e=>e.end>dayStart&&e.start<dayEnd).map(e=>`<div class="tl-event${clashes.some(c=>c.includes(e))?' clash lane'+Math.min(e.lane,1):''}" style="left:${pct(e.start)}%;width:${Math.max(.8,pct(e.end)-pct(e.start))}%" title="${esc(hm(e.start)+'–'+hm(e.end)+' · '+e.title)}"><span>${esc(e.title)}</span></div>`).join('');
      const free=gaps.map(g=>`<div class="tl-free" style="left:${pct(g.start)}%;width:${pct(g.end)-pct(g.start)}%" title="Free ${esc(hm(g.start)+'–'+hm(g.end))}"></div>`).join('');
      const nowLine=now>=dayStart&&now<=dayEnd?`<div class="tl-now" style="left:${pct(now)}%"></div>`:'';
      const chips=[...allDay.map(t=>`<span class="tl-chip">All day · ${esc(t)}</span>`),...due.map(t=>{const d=new Date(t.dueDate),day=/T00:00:00(\.000)?Z$/.test(t.dueDate)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):d,late=day<localMidnight;return `<span class="tl-chip ${late?'warn':'due'}">${late?'Overdue':'Due today'} · ${esc(t.title)}</span>`}),...clashes.slice(0,2).map(([a,b])=>`<span class="tl-chip warn">Overlap · ${esc(a.title)} & ${esc(b.title)}</span>`)];
      const summary=!connected?'Connect a calendar to see your day mapped out.':timed.length?`${gaps.reduce((n,g)=>n+g.min,0)} min free before ${DAY_END}:00`+(gaps[0]?` · next gap ${hm(gaps[0].start)}`:''):'No timed events today — the whole day is open.';
      tl.innerHTML=`<div class="tl-head"><span class="eyebrow">Today’s timeline</span><span class="tl-sum">${esc(summary)}</span></div><div class="tl-track">${free}${blocks}${nowLine}</div><div class="tl-hours">${hours.join('')}</div>${chips.length?`<div class="tl-chips">${chips.join('')}</div>`:''}`;
    }
    // Focus tile: suggest the next real free slot
    const focus=$('.focus');if(!focus)return;
    const mins=focus.querySelector('.minutes'),p=focus.querySelector('p'),eb=focus.querySelector('.eyebrow'),btn=$('#focus-start');
    let suggest=+(wset('focus').len||25),text='Protect a little quiet time for your most important task.',label='Suggested session';
    if(connected){
      const g=gaps[0];
      if(!g){suggest=0;label='No free slot';text=now>=dayEnd?'Your planned day is over. Rest up for tomorrow.':`Your calendar is full until ${DAY_END}:00. Try a short break between meetings.`}
      else{suggest=g.min>=90?50:g.min>=50?45:25;const startsNow=g.start-now<5*60000;label=startsNow?'Free right now':`Next free slot · ${hm(g.start)}`;
        text=`${startsNow?'You have':'You will have'} ${g.min} min free until ${hm(g.end)}${g.end>=dayEnd?' (end of day)':''}.`+(due[0]?` Good time for “${due[0].title}”.`:'')}
    }
    if(btn&&btn.dataset.running!=='1'&&!focusOverride){
      mins.innerHTML=suggest?`${suggest}<span style="font-size:17px;letter-spacing:0"> min</span>`:'—';p.textContent=text;eb.textContent=label;
      btn.disabled=!suggest;btn.dataset.minutes=suggest||25;btn.textContent=suggest?`Start ${suggest}-min focus`:'No free slot';
    }
  }
  const focusBtn=$('#focus-start');
  if(focusBtn)focusBtn.onclick=()=>{
    let n=(+focusBtn.dataset.minutes||25)*60;const total=n/60;focusBtn.dataset.running='1';focusBtn.disabled=true;toast(`Focus session started · ${n/60} minutes`);
    const timer=setInterval(()=>{n--;focusBtn.textContent=`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')} remaining`;if(n<=0){clearInterval(timer);logFocus(total);focusBtn.dataset.running='';toast('Focus session complete. Nice work.');renderInsights()}},1000);
  };
  renderInsights();
  setInterval(renderInsights,60000);
  // ---- Step 2 tiles: Google Drive, birthdays, markets ----
  const ago=d=>{const m=Math.round((Date.now()-d)/60000);if(m<1)return'just now';if(m<60)return m+' min ago';const h=Math.round(m/60);if(h<24)return h+' h ago';const dd=Math.round(h/24);return dd<7?dd+' d ago':d.toLocaleDateString(undefined,{month:'short',day:'numeric'})};
  const initials=n=>String(n||'?').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';
  function makeTile(id,cls,glyph,title,right,body){
    const a=document.createElement('article');a.className='card '+cls;a.dataset.widget=id;
    a.innerHTML=`<div class="card-head"><div class="card-title"><span class="glyph ${glyph[0]}">${glyph[1]}</span>${title}</div>${right}</div>${body}`;
    $('#layout').append(a);return a;
  }
  makeTile('drive','drive',['g-blue','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3h8l6 10-4 7H6l-4-7 6-10Z"/><path d="m8 3 6 10H2M16 3l-6 10M10 13h12"/></svg>'],'Recent files','','<div class="file-list" id="drive-list"><div class="empty">Connect Google to see files you opened recently.</div></div>');
  makeTile('birthdays','birthdays',['g-rose','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21h16v-8H4v8Z"/><path d="M4 16c2 1.5 4 1.5 6 0s4-1.5 6 0 3 1 4 0M12 13V9M12 6.5c-.8-.8-.8-2 0-3 .8 1 .8 2.2 0 3Z"/></svg>'],'Upcoming birthdays','','<div class="bday-list" id="bday-list"><div class="empty">Connect Google to see birthdays from your contacts.</div></div>');
  // re-apply any saved tile order now that the new tiles exist
  try{JSON.parse(localStorage.getItem('daylight-order')||'[]').forEach(id=>{const c=$('#layout').querySelector(`[data-widget="${id}"]`);if(c)$('#layout').append(c)})}catch{}

  // Google Drive (file names and dates only)
  const kind=m=>({'application/vnd.google-apps.document':['Doc','k-doc'],'application/vnd.google-apps.spreadsheet':['Sheet','k-sheet'],'application/vnd.google-apps.presentation':['Slides','k-slides'],'application/pdf':['PDF','k-pdf'],'application/vnd.google-apps.folder':['Folder','k-folder']}[m]||[(m||'').startsWith('image/')?'Image':'File','k-file']);
  async function loadDrive(){
    const u=new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q','trashed=false and mimeType!=\'application/vnd.google-apps.folder\'');u.searchParams.set('orderBy','viewedByMeTime desc');u.searchParams.set('pageSize','10');u.searchParams.set('fields','files(id,name,mimeType,modifiedTime,viewedByMeTime,webViewLink)');
    try{const data=await api(u);providerData.google.files=data.files||[];providerData.google.filesError='';}
    catch(e){providerData.google.files=null;providerData.google.filesError=/not been used|disabled/i.test(e.message)?'Turn on the Google Drive API in Google Cloud Console, then refresh.':/insufficient|scope/i.test(e.message)?'Reconnect Google and allow Drive file access.':'Could not load Drive files.';renderDrive();throw new Error('Drive: '+e.message)}
    renderDrive();return providerData.google.files.length;
  }
  function renderDrive(){
    const files=providerData.google.files,el=$('#drive-list');if(!el)return;
    if(providerData.google.filesError){el.innerHTML=`<div class="empty">${esc(providerData.google.filesError)}</div>`;return}
    if(!files){el.innerHTML='<div class="empty">Connect Google to see files you opened recently.</div>';return}
    el.innerHTML=files.length?files.slice(0,+(wset('drive').count||6)).map(f=>{const [label,cls]=kind(f.mimeType);const when=f.viewedByMeTime||f.modifiedTime;return `<a class="file-item" href="${esc(f.webViewLink||'#')}" target="_blank" rel="noopener noreferrer"><span class="file-kind ${cls}">${label}</span><span class="file-name">${esc(f.name)}</span><span class="file-time">${when?esc(ago(new Date(when))):''}</span></a>`}).join(''):'<div class="empty">No recent files in Drive.</div>';
  }

  // Birthdays from Google Contacts
  async function loadBirthdays(){
    try{
      let people=[],pageToken='';
      for(let i=0;i<5;i++){const u=new URL('https://people.googleapis.com/v1/people/me/connections');u.searchParams.set('personFields','names,birthdays');u.searchParams.set('pageSize','1000');if(pageToken)u.searchParams.set('pageToken',pageToken);
        const d=await api(u);people=people.concat(d.connections||[]);pageToken=d.nextPageToken;if(!pageToken)break}
      const today=localMidnight,list=[];
      people.forEach(p=>{const name=p.names?.[0]?.displayName;const b=(p.birthdays||[]).find(x=>x.date?.month&&x.date?.day);if(!name||!b)return;
        let next=new Date(today.getFullYear(),b.date.month-1,b.date.day);if(next<today)next=new Date(today.getFullYear()+1,b.date.month-1,b.date.day);
        const days=Math.round((next-today)/86400000);if(days<=366)list.push({name,next,days,turns:b.date.year?next.getFullYear()-b.date.year:null})});
      providerData.google.birthdays=list.sort((a,b)=>a.days-b.days);providerData.google.bdayError='';
    }catch(e){providerData.google.birthdays=null;providerData.google.bdayError=/not been used|disabled/i.test(e.message)?'Turn on the People API in Google Cloud Console, then refresh.':/insufficient|scope/i.test(e.message)?'Reconnect Google and allow contacts access.':'Could not load birthdays.';renderBirthdays();throw new Error('Birthdays: '+e.message)}
    renderBirthdays();return providerData.google.birthdays.length;
  }
  function renderBirthdays(){
    let list=providerData.google.birthdays,el=$('#bday-list');if(!el)return;
    if(providerData.google.bdayError){el.innerHTML=`<div class="empty">${esc(providerData.google.bdayError)}</div>`;return}
    if(!list){el.innerHTML='<div class="empty">Connect Google to see birthdays from your contacts.</div>';return}
    const lim=+(wset('birthdays').days||60);list=list.filter(b=>b.days<=lim);el.innerHTML=list.length?list.slice(0,8).map(b=>`<div class="bday${b.days===0?' is-today':''}"><div class="avatar">${esc(initials(b.name))}</div><div><div class="sender">${esc(b.name)}</div><div class="snippet">${esc(b.next.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}))}${b.turns?` · turns ${b.turns}`:''}</div></div><span class="badge">${b.days===0?'Today':b.days===1?'Tomorrow':'in '+b.days+' d'}</span></div>`).join(''):'<div class="empty">No birthdays in the next '+lim+' days.</div>';
  }

  // Markets: currency pairs (ECB rates via Frankfurter) and crypto (CoinGecko). No account needed. One card per watchlist.
  const CRYPTO={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',XRP:'ripple',ADA:'cardano',DOGE:'dogecoin',BNB:'binancecoin',LTC:'litecoin',DOT:'polkadot',AVAX:'avalanche-2'};
  const DEFAULT_WATCH='EUR/CZK, CZK/INR, USD/CZK, BTC, ETH';
  const readWatch=id=>{const s=wset(id).watch;if(s)return s;if(id==='markets'){try{return localStorage.getItem('daylight-watchlist')||DEFAULT_WATCH}catch{}}return DEFAULT_WATCH};
  const parseWatch=s=>s.toUpperCase().split(/[,;\s]+/).filter(Boolean).slice(0,8).map(x=>x.includes('/')?{type:'fx',base:x.split('/')[0],quote:x.split('/')[1]}:{type:'crypto',sym:x}).filter(x=>x.type==='crypto'?CRYPTO[x.sym]:/^[A-Z]{3}$/.test(x.base)&&/^[A-Z]{3}$/.test(x.quote)&&x.base!==x.quote);
  async function fxSeries(base,quotes){
    const start=new Date(Date.now()-10*86400000).toISOString().slice(0,10),sym=quotes.join(',');
    const tries=[`https://api.frankfurter.dev/v1/${start}..?base=${base}&symbols=${sym}`,`https://api.frankfurter.app/${start}..?from=${base}&to=${sym}`];
    let last;for(const u of tries){try{const r=await fetch(u);if(r.ok)return r.json();last=new Error('HTTP '+r.status)}catch(e){last=e}}throw last;
  }
  function marketsCard(id){
    const c=document.createElement('article');c.className='card markets';c.dataset.widget=id;
    c.innerHTML=`<div class="card-head"><div class="card-title"><span class="glyph g-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg></span><span class="m-title">${esc(wset(id).title||'Markets')}</span></div><button class="connect m-edit" type="button">Edit</button></div><form class="quick-add markets-form m-form" hidden><label class="sr-only">Watchlist</label><input class="m-input" maxlength="160" autocomplete="off" aria-label="Watchlist"><button type="submit" aria-label="Save watchlist">✓</button></form><div class="market-list"><div class="empty">Loading rates…</div></div><div class="market-foot"></div>`;
    $('#layout').append(c);
    c.querySelector('.m-edit').onclick=()=>{const f=c.querySelector('.m-form');f.hidden=!f.hidden;if(!f.hidden){c.querySelector('.m-input').value=readWatch(id);c.querySelector('.m-input').focus()}};
    c.querySelector('.m-form').addEventListener('submit',e=>{e.preventDefault();const ok=parseWatch(c.querySelector('.m-input').value.trim()||DEFAULT_WATCH);if(!ok.length){toast('Use pairs like EUR/CZK or coins like BTC, ETH');return}
      wsave(id,{watch:ok.map(i=>i.type==='fx'?i.base+'/'+i.quote:i.sym).join(', ')});c.querySelector('.m-form').hidden=true;c.querySelector('.market-list').innerHTML='<div class="empty">Loading rates…</div>';loadMarkets(c);toast('Watchlist saved on this device')});
    loadMarkets(c);return c;
  }
  async function loadMarkets(card){
    const el=card.querySelector('.market-list'),id=card.dataset.widget;
    const items=parseWatch(readWatch(id));const rows=[];const errors=[];
    const byBase={};items.filter(i=>i.type==='fx').forEach(i=>(byBase[i.base]=byBase[i.base]||[]).push(i.quote));
    await Promise.all(Object.entries(byBase).map(async([base,quotes])=>{try{const d=await fxSeries(base,[...new Set(quotes)]);const dates=Object.keys(d.rates||{}).sort();const cur=d.rates[dates.at(-1)]||{},prev=d.rates[dates.at(-2)]||{};
      quotes.forEach(q=>{if(cur[q]!=null)rows.push({key:base+'/'+q,label:`${base} → ${q}`,value:cur[q],change:prev[q]?(cur[q]-prev[q])/prev[q]*100:null})})}catch{errors.push(base)}}));
    const cs=items.filter(i=>i.type==='crypto');
    if(cs.length){try{const ids=cs.map(c=>CRYPTO[c.sym]).join(',');const d=await(await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`)).json();
      cs.forEach(c=>{const v=d[CRYPTO[c.sym]];if(v?.usd!=null)rows.push({key:c.sym,label:`${c.sym} → USD`,value:v.usd,change:v.usd_24h_change??null})})}catch{errors.push('crypto')}}
    const order=items.map(i=>i.type==='fx'?i.base+'/'+i.quote:i.sym);rows.sort((a,b)=>order.indexOf(a.key)-order.indexOf(b.key));
    const fmt=v=>v>=1000?v.toLocaleString(undefined,{maximumFractionDigits:0}):v>=1?v.toLocaleString(undefined,{maximumFractionDigits:3}):v.toLocaleString(undefined,{maximumSignificantDigits:4});
    el.innerHTML=rows.length?rows.map(r=>`<div class="market"><span class="market-pair">${esc(r.label)}</span><span class="market-val">${esc(fmt(r.value))}</span><span class="market-chg ${r.change==null?'':r.change>=0?'up':'down'}">${r.change==null?'—':(r.change>=0?'▲ ':'▼ ')+Math.abs(r.change).toFixed(2)+'%'}</span></div>`).join(''):`<div class="empty">${items.length?'Rates are unavailable right now. Try refresh in a moment.':'Choose Edit to add currency pairs like EUR/CZK or coins like BTC.'}</div>`;
    card.querySelector('.market-foot').textContent=(rows.length?`Updated ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`:'')+(errors.length&&rows.length?' · some symbols could not load':'');
  }
  const loadAllMarkets=()=>$$('.card.markets').forEach(c=>loadMarkets(c));
  marketsCard('markets');
  $('#refresh').addEventListener('click',loadAllMarkets);
  setInterval(()=>{if(document.visibilityState==='visible')loadAllMarkets()},10*60000);
  // Per-widget settings, stored apart from the layout
  function wsetAll(){try{return JSON.parse(localStorage.getItem('daylight-widget-settings')||'{}')||{}}catch{return{}}}
  function wset(id){return wsetAll()[id]||{}}
  function wsave(id,patch){const all=wsetAll();all[id]={...(all[id]||{}),...patch};try{localStorage.setItem('daylight-widget-settings',JSON.stringify(all))}catch{}}
  // ---- Helpers shared by the widget framework ----
  const TILE_NAMES={};
  const readJSON=(k,d)=>{try{const v=JSON.parse(localStorage.getItem(k)||'null');return v??d}catch{return d}};
  const writeJSON=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}};
  function applyVisibility(){}
  const hourOpts=(sel,from,to)=>{let o='';for(let h=from;h<=to;h++)o+=`<option value="${h}"${h===sel?' selected':''}>${String(h).padStart(2,'0')}:00</option>`;return o};
  // Install as an app (PWA)
  if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('sw.js').catch(()=>{});
  let installEvt=null;
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvt=e;let b=$('#install-app');if(!b){b=document.createElement('button');b.id='install-app';b.className='menu-item';b.type='button';b.innerHTML='<span class="mi-icon">⤓</span>Install as app';($('#drawer-install')||$('.actions')).append(b);b.onclick=async()=>{if(!installEvt)return;installEvt.prompt();const r=await installEvt.userChoice;installEvt=null;b.remove();if(r.outcome==='accepted')toast('Daylight installed')}}});
  window.addEventListener('appinstalled',()=>{$('#install-app')?.remove()});
  // ---- Daylight server: stay signed in to Google ----
  const SERVER_ERRORS={account_not_allowed:'That Google account is not allowed on your Daylight server. Add it to ALLOWED_EMAILS.',access_denied:'Google sign-in was cancelled.',no_refresh_token:'Google did not grant offline access. Try “Stay signed in” again.',token_exchange_failed:'Google sign-in could not be completed. Check the server’s client ID, secret and redirect URI.',gmail_readonly_required:'Google did not grant gmail.readonly. Open Connections → Reconnect for full Gmail access, and allow mail reading (not metadata only).'};
  const getLS=k=>{try{return localStorage.getItem(k)||''}catch{return''}},setLS=(k,v)=>{try{v?localStorage.setItem(k,v):localStorage.removeItem(k)}catch{}};
  let serverUrl=(getLS('daylight-api')||(location.hostname==='kratveer.github.io'?'https://daylight-api.kratveer050.workers.dev':'')).replace(/\/+$/,''),serverSession=getLS('daylight-session'),serverEmail='',serverRenew=null,serverTokenPromise=null;
  // Pick up the session (or an error) the server hands back after Google sign-in.
  (()=>{if(!location.hash.includes('daylight_'))return;const h=new URLSearchParams(location.hash.slice(1));
    if(h.get('daylight_session')){
      const prevSession=serverSession;
      serverSession=h.get('daylight_session');setLS('daylight-session',serverSession);
      // a new sign-in may be another Google account: hide the previous profile and its Items until this one is confirmed
      setLS('daylight-profile','');
      // the previous server session is no longer reachable from this browser: delete its record (and its stored refresh token) on the server
      // only on a server that understands keep_grant (an older Worker would revoke the Google grant instead)
      if(prevSession&&prevSession!==serverSession&&serverUrl)fetch(serverUrl+'/health').then(r=>r.json()).then(hh=>{if((hh.features||[]).includes('logout_keep_grant'))return fetch(serverUrl+'/auth/logout?keep_grant=1',{method:'POST',headers:{Authorization:'Bearer '+prevSession}})}).catch(()=>{});
      if(h.get('daylight_gmail_readonly')==='1')toast('Signed in · full Gmail reading granted');
      else toast('Signed in · Daylight will keep you connected');
    }
    if(h.get('daylight_error'))setTimeout(()=>{const msg=SERVER_ERRORS[h.get('daylight_error')]||'Server sign-in failed: '+h.get('daylight_error');$('#sync-status').textContent=msg;toast(msg,{type:'warn'});if(h.get('daylight_error')==='gmail_readonly_required')connectDialog({setup:false})},0);
    history.replaceState(null,'',location.pathname+location.search)})();
  /* ---- Account identity gate (V2): account data is shown only once THIS credential's owner is confirmed. ----
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
  function clearServerSession(statusMsg){
    serverSession='';setLS('daylight-session','');token=null;rememberGoogleScopes('');resetGmailEngine();try{invalidateIdentity('signed-out',false)}catch{};
    $('#connections').classList.toggle('active',Boolean(microsoftAccount));
    if(statusMsg)$('#sync-status').innerHTML=statusMsg;
  }
  function reconnectGoogleUpgrade(){
    if(!serverUrl){connectDialog({setup:true});return}
    const q=new URLSearchParams({return:location.origin+location.pathname,upgrade:'1'});
    location.href=serverUrl+'/auth/google/start?'+q.toString();
  }
  async function serverToken(){
    if(!serverUrl||!serverSession)return false;
    if(serverTokenPromise)return serverTokenPromise;
    serverTokenPromise=(async()=>{try{
      const r=await fetch(serverUrl+'/api/google/token',{method:'POST',headers:{Authorization:'Bearer '+serverSession}});
      let d={};try{d=await r.json()}catch{}
      if(r.status===401){
        clearServerSession('Google sign-in expired · <button type="button" class="js-google-upgrade" style="all:unset;cursor:pointer;color:var(--accent-text);font-weight:700;text-decoration:underline">reconnect for full Gmail access</button>');
        return false;
      }
      if(!r.ok){
        // Dead/revoked stay-signed-in session after scope upgrade — clear and prompt reconnect (keep local Daylight data)
        if(r.status===502||d.error==='google_unavailable'){
          clearServerSession('Google session needs refresh · <button type="button" class="js-google-upgrade" style="all:unset;cursor:pointer;color:var(--accent-text);font-weight:700;text-decoration:underline">reconnect for full Gmail access</button>');
          if(!serverToken._upgradeHinted){serverToken._upgradeHinted=true;toast('Reconnect Google to finish gmail.readonly upgrade',{type:'warn'})}
          return false;
        }
        throw new Error('server '+r.status);
      }
      token=d.access_token;serverEmail=d.email||'';tokenExpiry=Date.now()+(Number(d.expires_in)||3600)*1000;
      {const pe=String(readProfile().email||'').toLowerCase();if(serverEmail&&pe&&pe!==serverEmail.toLowerCase())invalidateIdentity('token-belongs-to-another-account',true)}
      if(d.scope)rememberGoogleScopes(d.scope);
      $('#connections').classList.add('active');
      if(d.needs_gmail_upgrade||d.gmail_readonly===false||(d.scope&&!hasGmailReadonly())){
        $('#sync-status').innerHTML='Google connected · <button type="button" class="js-google-upgrade" style="all:unset;cursor:pointer;color:var(--accent-text);font-weight:700;text-decoration:underline">reconnect for full Gmail access</button>';
        if(!serverToken._upgradeHinted){serverToken._upgradeHinted=true;toast('Reconnect Google once for full mail access (gmail.readonly)',{type:'warn'})}
      }
      clearTimeout(serverRenew);serverRenew=setTimeout(serverToken,Math.max(60,(Number(d.expires_in)||3600)-180)*1000);return true;
    }catch(e){$('#sync-status').textContent='Could not reach your Daylight server · retrying soon';clearTimeout(serverRenew);serverRenew=setTimeout(serverToken,120000);return false}
    finally{serverTokenPromise=null}})();
    return serverTokenPromise;
  }
  document.addEventListener('click',e=>{
    const b=e.target?.closest?.('.js-google-upgrade');
    if(!b)return;
    e.preventDefault();
    reconnectGoogleUpgrade();
  });
  renderProfile();$('#profile')?.addEventListener('click',connectDialog);
  // Show the real "last full sync" time after a reload instead of "waiting for the first sync"
  (async()=>{try{const S=window.DaylightStore;if(!S?.getSyncState)return;const id=await S.getActiveAccountId();const st=await S.getSyncState(id);const t=st?.gmail?.lastSuccessAt||0;if(t&&!lastSyncOk){lastSyncOk=t;lastGmailFullSyncAt=lastGmailFullSyncAt||t;if(typeof renderDrawerSync==='function')renderDrawerSync()}}catch{}})();
  setInterval(renderProfile,10*60000);
  if(serverUrl&&serverSession)serverToken().then(ok=>{if(ok)refreshAll()});
  // ---- Open Loops: things you started but haven't finished (Google data, worked out in this browser) ----
  const LOOP_TYPES={
    reply:{label:'Reply',cls:'t-reply',icon:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>'},
    followup:{label:'Follow up',cls:'t-follow',icon:'<path d="M15 10l5 5-5 5"/><path d="M20 15H10a6 6 0 0 1-6-6V6"/>'},
    prepare:{label:'Prepare',cls:'t-prepare',icon:'<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M8 2v4M16 2v4M8 12h8M8 16h5"/>'},
    overdue:{label:'Reschedule',cls:'t-overdue',icon:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'},
    deadline:{label:'Due soon',cls:'t-deadline',icon:'<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'},
    renewal:{label:'Renewal',cls:'t-renewal',icon:'<path d="M20 12a8 8 0 1 1-2.3-5.6L20 9"/><path d="M20 4v5h-5"/>'},
    travel:{label:'Trip',cls:'t-travel',icon:'<path d="M3 13h18M6 13l2-6h8l2 6M6 17h.01M18 17h.01"/><rect x="3" y="13" width="18" height="5" rx="2"/>'}};
  const AUTOMATED=/(no-?reply|do-?not-?reply|notification|newsletter|mailer|bounce|^updates?@|^news@|^info@|marketing|^hello@|^team@|^support@|^billing@|^receipts?@|^account@|^alerts?@|^offers?@|^deals?@|promo|campaign|digest|jobalerts?|^careers?@|^welcome@|^contact@|^community@)/i;
  // Bulk / marketing mail is never a priority: Gmail Promotions/Social/Forums, any List-Unsubscribe or bulk header,
  // the v2 rules' promotion/newsletter/social/security categories, or an automated sender.
  const PAY_TASK=/(^\s*(pay|zaplat|uhra[dď]|bezahl)|\b(invoice|bill|rent|fee|fees|tuition|installment|instal?ment|emi|loan|faktur\p{L}*|nájem|nájm\p{L}*|poplat\p{L}*|školn\p{L}*|splátk\p{L}*|záloh\p{L}*|miete|rechnung)\b)/iu;
  const BULK_LABELS=/^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/;
  /** Marketing / list mail (no automated-sender rule): used for dated items, where no-reply senders such as airlines matter. */
  function isMarketingMail(m){
    if(!m)return true;
    if((m.labelIds||[]).some(l=>BULK_LABELS.test(l)))return true;
    const h=m.payload?.headers||[];
    if(header(h,'List-Unsubscribe')||header(h,'List-Id')||/^(bulk|list|junk)$/i.test(header(h,'Precedence')))return true;
    const cc=m._cache?.category;return !!(cc&&['promotion','newsletter','social','security'].includes(cc));
  }
  function isBulkMail(m){
    if(!m)return true;
    if((m.labelIds||[]).some(l=>BULK_LABELS.test(l)))return true;
    const h=m.payload?.headers||[];
    if(header(h,'List-Unsubscribe')||header(h,'List-Id')||/^(bulk|list|junk)$/i.test(header(h,'Precedence')))return true;
    const cc=m._cache?.category;if(cc&&['promotion','newsletter','social','security'].includes(cc))return true;
    return AUTOMATED.test(parseFrom(header(h,'From')).email||'');
  }
  /** Gmail search fragment for the categories Daylight never downloads (from gmail-config.js). */
  function gmailExcludeQ(){try{const W=window.DaylightGmailConfig,P=window.DaylightMailPipeline;const l=W?.load?.().pipeline?.excludeLabels||[];return P?.excludeQuery?P.excludeQuery(l):l.map(x=>'-category:'+x.replace(/^CATEGORY_/,'').toLowerCase()).join(' ')}catch{return '-category:promotions -category:social -category:forums'}}
  const RENEWAL=/\b(renew(al|s|ing)?|subscription|subscribed|membership|trial (ends|ending|expires)|expir(es|ing|ation)|auto-?renew)\b/i;
  const PENDING_PAY=/\b(payment (due|failed|reminder|declined)|past due|overdue (bill|payment)|action required.*(pay|bill)|unpaid|failed payment|pay now|outstanding balance|dlužn|nezaplacen|platba (po|je) splatnosti)\b/i;
  const BILL=/\b(invoice|bill(ing)?|statement|utilities?|electric|gas bill|water bill|internet bill|phone bill|faktura|vyúčtování|inkaso|složenka|předpis)\b/i;
  const STORE_PAY=/\b(order|purchase|bought|shipped|delivered|pickup|in[- ]store|receipt from|your (order|purchase)|objednávka|zalando|amazon|ikea|lidl|tesco|albert|rossmann|dm drogerie|alza|mediamarkt|notino|aboutyou|temu|shein|wish\.com|ebay|allegro)\b/i;
  const SHOPPING_DOMAIN=/(temu\.|alza\.|zalando\.|aboutyou\.|shein\.|aliexpress\.|ebay\.|allegro\.|ikea\.|notino\.|mediamarkt\.|lidl\.|tesco\.|amazon\.|shopify\.|etsy\.)/i;
  const ONLINE_PAY=/\b(paypal|stripe|apple pay|google pay|card ending|charged|payment received|payment confirm|sepa|iban|wise|revolut|sumup|platba (proběhla|přijata)|úhrada)\b/i;
  const MONEY=/\b(renew(al|s|ing)?|subscription|subscribed|membership|trial|expir|payment|invoice|receipt|bill(ing)?|auto-?renew|charged|statement|paypal|stripe|sepa|faktura|platba|předplatné|vyúčtování|účet|premium|plan)\b/i;
  const MONEY_DOMAIN=/(netflix|spotify|adobe|paypal|stripe|apple\.com|google\.com|microsoft|openai|dropbox|icloud|youtube|disney|hbo|skyshowtime|vodafone|o2|t-mobile|cez\.|innogy|pre\.cz|upc|airbank|revolut|wise|csob|kb\.cz|moneta|fio\.|namecheap|godaddy)/i;
  const TRAVEL=/\b(booking|reservation|itinerary|e-?ticket|boarding[\s-]?pass|flights?|train|bahn|rail|eurostar|(?:flight|hotel|airport)\s*check-?in|hotel|airbnb|boarding pass|departure|arrival|gate\s?[A-Z]?\d+|PNR|confirmation code|trip to)\b/i;
  const HOTEL=/\b(hotel|airbnb|booking\.com|accommodation|hostel|marriott|hilton|ibis|check-?in (?:at|on)|lodging|resort)\b/i;
  const FLIGHTISH=/\b(flight|boarding|airline|lufthansa|ryanair|easyjet|wizz|emirates|klm|airport|gate\s?[A-Z]?\d+)\b/i;
  const TRAINISH=/\b(train|bahn|rail|eurostar|coach|wagon|deutsche bahn|\bcd\b)\b/i;
  const DOCUMENT=/\b(document|contract|agreement|signed|signature|attachment|pdf|passport|visa|insurance|policy|tax|steuer|certificate|invoice attached|your copy)\b/i;
  const DEADLINE=/\b(deadline|due|submit|submission)\b/i;
  const DEMO=/\b(?:demo|preview)=1\b/i.test(location.search)||localStorage.getItem('daylight-demo')==='1';
  const MONEY_COLORS=['#6d7cff','#e08a4c','#4aa88a','#d0627a','#7b6ad6','#3f9ab8'];
  function brandColor(name){let h=0;for(const c of String(name||''))h=(h*31+c.charCodeAt(0))>>>0;return MONEY_COLORS[h%MONEY_COLORS.length]}
  /* Company logos from Gmail sender domains (Google favicons + Clearbit fallback) */
  const BRAND_DOMAIN_MAP={
    netflix:'netflix.com',spotify:'spotify.com',adobe:'adobe.com',paypal:'paypal.com',stripe:'stripe.com',
    apple:'apple.com',google:'google.com',amazon:'amazon.com',zalando:'zalando.com',microsoft:'microsoft.com',
    openai:'openai.com',cursor:'cursor.com',github:'github.com',notion:'notion.so',figma:'figma.com',
    dropbox:'dropbox.com',icloud:'icloud.com',youtube:'youtube.com',disney:'disneyplus.com',hbo:'hbomax.com',
    skyshowtime:'skyshowtime.com',vodafone:'vodafone.com',o2:'o2.com','t-mobile':'t-mobile.com',cez:'cez.cz',
    innogy:'innogy.com',upc:'upc.cz',airbank:'airbank.cz',revolut:'revolut.com',wise:'wise.com',csob:'csob.cz',
    moneta:'moneta.cz',fio:'fio.cz',twilio:'twilio.com',vercel:'vercel.com',railway:'railway.app',
    digitalocean:'digitalocean.com',hetzner:'hetzner.com',namecheap:'namecheap.com',godaddy:'godaddy.com',
    shopify:'shopify.com',bahn:'bahn.de',lufthansa:'lufthansa.com',booking:'booking.com',airbnb:'airbnb.com',
    ikea:'ikea.com',alza:'alza.cz',lidl:'lidl.com',tesco:'tesco.com',notino:'notino.com',mediamarkt:'mediamarkt.de',
    kb:'kb.cz',pre:'pre.cz',skoda:'skoda-auto.com',ceskedrahy:'cd.cz','čez':'cez.cz','české':'cd.cz'
  };
  function brandDomainFromEmail(email){
    let host=String(email||'').toLowerCase().split('@').pop()||'';
    if(!host||!host.includes('.'))return '';
    host=host.replace(/^e?mail\./,'').replace(/^no-?reply\./,'').replace(/^noreply\./,'').replace(/^billing\./,'').replace(/^receipts?\./,'').replace(/^auto-?confirm\./,'').replace(/^service\./,'').replace(/^news(letter)?\./,'');
    // email.apple.com → apple.com; accounts.google.com → google.com
    const parts=host.split('.');
    if(parts.length>2){
      const last2=parts.slice(-2).join('.');
      const last3=parts.slice(-3).join('.');
      if(/\.(co|com|org|net|cz|de|uk|io|app|so)\.[a-z]{2}$/i.test(host))return last3;
      return last2;
    }
    return host;
  }
  function brandDomain(email,name){
    const fromMail=brandDomainFromEmail(email);
    if(fromMail){
      for(const [key,dom] of Object.entries(BRAND_DOMAIN_MAP)){
        if(fromMail.includes(key)||fromMail===dom)return dom;
      }
      return fromMail;
    }
    const n=String(name||'').toLowerCase().replace(/[^a-z0-9čšžáéíóúýňťď.+-]+/gi,' ').trim();
    for(const [key,dom] of Object.entries(BRAND_DOMAIN_MAP)){
      if(n.includes(key))return dom;
    }
    return '';
  }
  function brandLogoUrls(domain){
    if(!domain)return [];
    const d=encodeURIComponent(domain);
    return [
      `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
      `https://logo.clearbit.com/${d}?size=128`
    ];
  }
  function brandLogoHTML(item,initial){
    const domain=item.domain||brandDomain(item.fromEmail,item.title||item.from||item.fromName);
    const urls=brandLogoUrls(domain);
    const ini=esc((initial||(item.title||'?').trim().slice(0,2)).toUpperCase());
    if(!urls.length)return `<span class="m-brand-ini">${ini}</span>`;
    return `<img class="m-brand-img" src="${esc(urls[0])}" alt="" width="44" height="44" loading="lazy" decoding="async" data-fallback="${esc(urls[1]||'')}" referrerpolicy="no-referrer"><span class="m-brand-ini">${ini}</span>`;
  }
  function loopSourceBrand(l){
    let domain=l.domain||brandDomain(l.fromEmail,l.fromName||l.title||l.from);
    const href=String(l.href||'');
    if(!domain){
      if(l.fromEmail)domain=brandDomainFromEmail(l.fromEmail);
      else if(l.relatedMail?.from?.email)domain=brandDomain(l.relatedMail.from.email,l.relatedMail.from.name);
      else if(/mail\.google|gmail\.com/i.test(href)||l.mailId)domain='gmail.com';
      else if(/calendar\.google/i.test(href)||l.type==='prepare'||l.category==='Calendar')domain='google.com';
      else if(/tasks\.google/i.test(href)||l.category==='Task')domain='google.com';
      else if(/to-do\.office|outlook\.office|microsoft/i.test(href))domain='microsoft.com';
    }
    const title=l.fromName||l.relatedMail?.from?.name||l.title||srcOf(l);
    return {domain,fromEmail:l.fromEmail||l.relatedMail?.from?.email||'',title,color:l.color||brandColor(title)};
  }
  function parseMoneyWhen(subject,fallbackDate){
    const s=String(subject||'');
    let m;
    if(/\brenews?\s+soon\b/i.test(s)||/\bexpir(?:es|ing)\s+soon\b/i.test(s))return {label:'Soon',urgent:true,sort:Date.now()+3*86400000};
    if(/\b(today|tonight)\b/i.test(s))return {label:'Today',urgent:true,sort:localMidnight.getTime()};
    if(/\btomorrow\b/i.test(s))return {label:'Tomorrow',urgent:true,sort:localMidnight.getTime()+86400000};
    if((m=s.match(/\b(?:renews?|due|expires?|on|by)\s+(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/i))){
      const day=+m[1],mo=+m[2]-1,yr=m[3]?(m[3].length===2?2000+(+m[3]):+m[3]):localMidnight.getFullYear();
      let d=new Date(yr,mo,day);if(d<localMidnight&&!m[3])d=new Date(yr+1,mo,day);
      const days=Math.round((d-localMidnight)/86400000);
      return {label:days===0?'Today':days===1?'Tomorrow':d.toLocaleDateString(undefined,{day:'numeric',month:'short'}),urgent:days<=3,sort:d.getTime()};
    }
    if((m=s.match(/\b(?:renews?|due|expires?|on|by)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i))){
      const mon=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase());
      let d=new Date(localMidnight.getFullYear(),mon,+m[2]);if(d<localMidnight)d.setFullYear(d.getFullYear()+1);
      const days=Math.round((d-localMidnight)/86400000);
      return {label:days===0?'Today':days===1?'Tomorrow':d.toLocaleDateString(undefined,{day:'numeric',month:'short'}),urgent:days<=3,sort:d.getTime()};
    }
    const age=fallbackDate?Date.now()-fallbackDate.getTime():0;
    return {label:fallbackDate?ago(fallbackDate):'',urgent:false,sort:fallbackDate?fallbackDate.getTime():0,received:true};
  }
  function moneyKind(subject,from){
    const text=subject+' '+from;
    // Skip shopping / promotions (Temu, Alza, Amazon orders, etc.)
    if(SHOPPING_DOMAIN.test(from)||STORE_PAY.test(text))return null;
    if(PENDING_PAY.test(text)||/\bpayment due\b/i.test(text)||/\b(pay|zapla[tť]).{0,20}(tuition|school|fees?|poplat|školn)/i.test(text))return 'pending';
    if(RENEWAL.test(text)||/\bpředplatn/i.test(text)||/\b(premium|pro plan|your plan)\b/i.test(text))return 'subscription';
    if(BILL.test(text))return 'bill';
    // Real payment confirmations → Payments tab
    if(ONLINE_PAY.test(text)||/\b(payment (received|confirm|successful)|charged)\b/i.test(text)||/\bpotvrzení platby\b/i.test(text))return 'pending';
    if(MONEY_DOMAIN.test(from)&&RENEWAL.test(text))return 'subscription';
    if(MONEY_DOMAIN.test(from)&&BILL.test(text))return 'bill';
    if(MONEY_DOMAIN.test(from)&&MONEY.test(text))return 'pending';
    return null;
  }
  var loopsData=null,loopsFetched=0,loopsShowAll=false;
  const loopState=()=>readJSON('daylight-loops',{});
  const saveLoopState=s=>{const now=Date.now();Object.keys(s).forEach(k=>{if(s[k].t&&now-s[k].t>30*86400000)delete s[k]});writeJSON('daylight-loops',s)};
  const parseFrom=v=>{const m=/^\s*"?([^"<]*)"?\s*<([^>]+)>/.exec(v||'');return m?{name:m[1].trim()||m[2],email:m[2].toLowerCase()}:{name:(v||'').trim(),email:(v||'').trim().toLowerCase()}};
  const gmailLink=id=>`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
  function gmailThreadId(loop){
    return loop?.threadId||loop?.relatedMail?.threadId||loop?.mailId||loop?.relatedMail?.mailId||'';
  }
  function gmailHttpsUrl(loop){
    const id=gmailThreadId(loop);
    return loop?.relatedMail?.href||loop?.href||(id?gmailLink(id):'');
  }
  /** Open the message in the Gmail mobile app when possible; fall back to https. */
  function openGmailApp(loop){
    const id=gmailThreadId(loop);
    const https=gmailHttpsUrl(loop);
    if(!https&&!id){toast('No Gmail link available',{type:'warn'});return false}
    const url=https||gmailLink(id);
    const ua=navigator.userAgent||'';
    feel.select();
    if(/Android/i.test(ua)){
      const path=`mail.google.com/mail/u/0/#all/${encodeURIComponent(id||'')}`;
      location.href=`intent://${path}#Intent;scheme=https;package=com.google.android.gm;S.browser_fallback_url=${encodeURIComponent(url)};end`;
      return true;
    }
    if(/iPhone|iPad|iPod/i.test(ua)){
      // Universal Links hand off to Gmail when installed; googlegmail as a soft try.
      const deep=`googlegmail://co?msg=${encodeURIComponent(id||'')}`;
      const start=Date.now();
      try{location.href=deep}catch{}
      setTimeout(()=>{if(Date.now()-start<1600)location.href=url},700);
      return true;
    }
    window.open(url,'_blank','noopener');
    return true;
  }
  // Retry policy shared with the Gmail engine: 429, 403 rate-limit, 5xx and network errors back off
  // exponentially with jitter (Retry-After honoured); permission/auth/not-found errors fail fast.
  async function apiRetry(url,opts,maxAttempts=4){
    const GS=window.DaylightGmailSync;
    let lastErr=null,retries=0;
    for(let attempt=0;attempt<maxAttempts;attempt++){
      try{return {data:await api(url,opts),retries}}
      catch(e){
        lastErr=e;retries=attempt;
        const f=GS?.classifyFailure?GS.classifyFailure({status:e.status||0,reason:e.reason||e.code||'',message:e.message||''}):{retry:!e.status||e.status===429||e.status>=500};
        if(!f.retry||attempt===maxAttempts-1)break;
        const wait=GS?.backoffDelay?GS.backoffDelay(attempt,{retryAfterMs:e.retryAfterMs}):Math.min(4000,350*Math.pow(2,attempt))+Math.random()*120;
        await new Promise(r=>setTimeout(r,wait));
      }
    }
    throw lastErr||new Error('Request failed');
  }
  let v2LastPools=null;
  async function loadLoops(force,gmailTrigger,gmailExtra){
    if(!token){if(DEMO){loopsData=demoLoopsData();try{applyEmailClassification(loopsData)}catch(e){console.warn('classify',e)};try{await enrichWithDaylightAI(loopsData)}catch(e){console.warn('daylight-ai',e)};loopsFetched=Date.now();try{runCrossAppIntelligence()}catch(e){console.warn('intel',e)};try{syncClassifiedTicketsToWallet()}catch(e){console.warn('ticket wallet',e)};try{distributeAiExtractions(loopsData)}catch(e){console.warn('ai-distribute',e)};queueDaylightHydrate();renderLoops();renderCategories();if(typeof renderInbox==='function')renderInbox();if(typeof renderWallet==='function'&&mq?.matches&&mTab==='wallet')renderWallet();return computeLoops().length}return 0}
    if(!force&&loopsData&&Date.now()-loopsFetched<3*60000){v2InboxWait?.resolve(v2LastPools);renderLoops();renderCategories();if(typeof renderInbox==='function')renderInbox();return 0}
    const Store=window.DaylightStore;
    await accountReady();
    const accountId=Store?await Store.getActiveAccountId().catch(()=>null):null;
    const syncPrev=Store&&accountId?await Store.getSyncState(accountId).catch(()=>null):null;
    const t0=Date.now();
    let calRetries=0,calMode='full';
    const moneyQ=[
      'newer_than:120d (subscription OR renew OR renewal OR invoice OR billing OR bill OR payment OR paid OR charged OR trial OR membership OR premium OR paypal OR stripe OR faktura OR platba OR předplatné OR vyúčtování)',
      'newer_than:90d category:updates (bill OR invoice OR payment OR receipt OR renew OR subscription OR faktura OR platba OR billing)',
      'newer_than:180d (from:paypal.com OR from:stripe.com OR from:apple.com OR from:netflix.com OR from:spotify.com OR from:adobe.com OR from:google.com OR from:microsoft.com OR from:revolut.com OR from:wise.com)'
    ];
    // Gmail: list every search first, de-duplicate IDs, then fetch each message once.
    // Finance/travel/document searches need bodies (amounts, dates, attachments) → format=full (capped per sync);
    // inbox-only mail uses format=metadata unless it looks like money/travel/documents.
    const qp=q=>'q='+encodeURIComponent((q+' '+gmailExcludeQ()).trim()); // Promotions / Social / Forums are never listed
    const gmailPlan={
      cursor:syncPrev?.gmail?.cursor||null,
      sentThreads:12,
      queries:[
        {key:'inbox',params:'labelIds=INBOX&'+qp(''),max:50,pages:2,body:'auto'},
        {key:'moneyA',params:qp(moneyQ[0]),max:30,pages:2,body:'full'},
        {key:'moneyB',params:qp(moneyQ[1]),max:20,pages:1,body:'full'},
        {key:'moneyC',params:qp(moneyQ[2]),max:25,pages:1,body:'full'},
        {key:'travel',params:qp('(flight OR train OR booking OR itinerary OR "boarding pass" OR hotel OR reservation OR e-ticket) newer_than:45d'),max:15,pages:1,body:'full'},
        {key:'docs',params:qp('(document OR contract OR agreement OR signed OR insurance OR passport OR visa OR pdf OR tax) newer_than:45d has:attachment'),max:12,pages:1,body:'full'}
      ],
      wantsBody:m=>{
        const labels=m.labelIds||[];
        if(labels.some(l=>/^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/.test(l)))return false;
        const h=m.payload?.headers||[],text=header(h,'Subject')+' '+header(h,'From')+' '+(m.snippet||'');
        return MONEY.test(text)||PENDING_PAY.test(text)||BILL.test(text)||TRAVEL.test(text)||DOCUMENT.test(text);
      }
    };
    const useV2=v2Enabled();
    let v2Out=null;
    if(useV2&&token&&!identityVerified){try{await loadProfile()}catch{}}
    if(useV2){try{v2Out=await v2GmailSync(gmailTrigger||(force?'manual':'open'),gmailExtra);try{localStorage.removeItem('daylight-v2-engine-error:'+v2AccountKey())}catch{};await v2IngestGmail()}catch(e){console.warn('gmail v2 — falling back to the Phase 1 engine',e);v2Out=null;try{localStorage.setItem('daylight-v2-engine-error:'+v2AccountKey(),JSON.stringify({at:Date.now(),stage:'gmail sync',message:String(e&&e.message||e).slice(0,300)}))}catch{}}}
    v2InboxWait?.resolve(v2Out?v2Out.pools:null);
    if(v2Out)v2LastPools=v2Out.pools;
    const {report:gmailReport,pools,historyExtras,threads:sentThreads,cursor:gmailCursor}=v2Out||await gmailEngine().sync(gmailPlan);
    gmailReport.at=Date.now();lastGmailReport=gmailReport;
    if(gmailReport.fromCache)lastGmailFullSyncAt=lastGmailSyncAt()||lastGmailFullSyncAt;
    else if(!gmailReport.partial)lastGmailFullSyncAt=gmailReport.at;
    const inbox=pools.inbox||[],travelMail=pools.travel||[],docsMail=pools.docs||[];
    const financeMail=[...(pools.moneyA||[]),...(pools.moneyB||[]),...(pools.moneyC||[])];
    const byId=new Map();[...(historyExtras||[]),...inbox,...financeMail,...travelMail,...docsMail].forEach(m=>{if(m?.id)byId.set(m.id,m)});
    // Calendar: prefer syncToken when present; recover on 410
    let upcoming=[],calCursor=syncPrev?.calendar?.cursor||null;
    if(hasGoogleScope('calendar'))try{
      if(calCursor){
        calMode='incremental';
        const u=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        u.searchParams.set('syncToken',calCursor);u.searchParams.set('singleEvents','true');u.searchParams.set('maxResults','100');
        try{
          let pageToken='',items=[];
          do{
            if(pageToken)u.searchParams.set('pageToken',pageToken);else u.searchParams.delete('pageToken');
            const {data,retries}=await apiRetry(u);calRetries+=retries;
            items=items.concat(data.items||[]);pageToken=data.nextPageToken||'';
            if(data.nextSyncToken)calCursor=data.nextSyncToken;
          }while(pageToken);
          // Incremental returns changed items only — merge with prior upcoming window
          const prior=new Map((loopsData?.upcoming||[]).map(e=>[e.id,e]));
          items.forEach(e=>{if(e.status==='cancelled')prior.delete(e.id);else if(e.id)prior.set(e.id,e)});
          const horizon=localMidnight.getTime()+14*86400000;
          upcoming=[...prior.values()].filter(e=>{
            const st=new Date(e.start?.dateTime||e.start?.date||0).getTime();
            return st>=Date.now()-86400000&&st<=horizon;
          }).sort((a,b)=>new Date(a.start?.dateTime||a.start?.date||0)-new Date(b.start?.dateTime||b.start?.date||0));
        }catch(e){
          if(e.status===410){calCursor=null;calMode='full-recovery'}
          else throw e;
        }
      }
      if(!calCursor||calMode==='full-recovery'||!upcoming.length&&calMode!=='incremental'){
        if(calMode!=='incremental')calMode=calMode==='full-recovery'?calMode:'full';
        const calU=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        calU.searchParams.set('timeMin',new Date().toISOString());
        calU.searchParams.set('timeMax',new Date(localMidnight.getTime()+14*86400000).toISOString());
        calU.searchParams.set('singleEvents','true');calU.searchParams.set('orderBy','startTime');calU.searchParams.set('maxResults','50');
        let pageToken='',items=[];
        do{
          if(pageToken)calU.searchParams.set('pageToken',pageToken);else calU.searchParams.delete('pageToken');
          const {data,retries}=await apiRetry(calU);calRetries+=retries;
          items=items.concat(data.items||[]);pageToken=data.nextPageToken||'';
          if(data.nextSyncToken)calCursor=data.nextSyncToken;
        }while(pageToken&&items.length<100);
        upcoming=items;
      }
    }catch(e){
      console.warn('calendar sync',e);
      try{if(Store&&accountId)await Store.recordSyncFailure('calendar',e,{retries:calRetries,mode:calMode},accountId)}catch{}
      upcoming=[];
    }
    loopsData={inbox:[...byId.values()],financeMail,travelMail,docsMail,threads:(sentThreads||[]).filter(Boolean),upcoming,gmailSync:gmailReport,files:{},scanned:byId.size,financeHits:financeMail.length};
    if(v2Out)loopsData.gmailV2={aiCandidates:v2Out.aiCandidates||[],newCount:v2Out.report.pipeline?.newMessages||0,review:v2Out.review||[],deletedIds:v2Out.deletedIds||[],fromCache:!!v2Out.report.fromCache};
    // Classify-first: every fetched mail gets a primary category before UI use
    try{applyEmailClassification(loopsData)}catch(e){console.warn('classify',e)}
    try{await enrichWithDaylightAI(loopsData)}catch(e){console.warn('daylight-ai',e)}
    const meetings=upcoming.filter(e=>(e.attendees||[]).length>1&&e.start?.dateTime&&new Date(e.start.dateTime)<new Date(localMidnight.getTime()+2*86400000)).slice(0,3);
    if(false)await Promise.all(meetings.map(async e=>{const word=(e.summary||'').split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=5).sort((a,b)=>b.length-a.length)[0];if(!word)return;
      try{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',`name contains '${word.replace(/'/g,"\\'")}' and trashed=false`);u.searchParams.set('pageSize','1');u.searchParams.set('orderBy','modifiedTime desc');u.searchParams.set('fields','files(name,webViewLink)');
        const f=(await apiRetry(u).then(r=>r.data)).files?.[0];if(f)loopsData.files[e.id]=f}catch{}}));
    loopsFetched=Date.now();
    try{runCrossAppIntelligence()}catch(e){console.warn('intel',e)}
    try{syncClassifiedTicketsToWallet()}catch(e){console.warn('ticket wallet',e)}
    try{distributeAiExtractions(loopsData)}catch(e){console.warn('ai-distribute',e)}
    if(Store&&accountId){
      try{
        const r=gmailReport,gMode=r.history?.mode==='none'?'full':(r.history?.mode||'full');
        const gDetails={records:r.records,requests:r.requestCount,units:r.units,retries:r.retries,quotaErrors:r.quotaErrors,uniqueIds:r.uniqueIds,duplicatesAvoided:r.duplicatesAvoided,queryErrors:r.queryErrors.length,sent:r.sent,failures:(r.failures||[]).slice(0,10)};
        if(r.fromCache){/* no Gmail call happened: keep the last real sync state */}
        else if(r.partial)await Store.recordSyncPartial('gmail',{summary:r.summary,durationMs:r.durationMs,retries:r.retries,fetched:r.records.fetched,cursor:gmailCursor,mode:gMode,details:gDetails},accountId);
        else await Store.recordSyncSuccess('gmail',{durationMs:r.durationMs,retries:r.retries,fetched:r.records.fetched,deleted:r.records.deleted,cursor:gmailCursor,mode:gMode,details:gDetails},accountId);
        await Store.recordSyncSuccess('calendar',{durationMs:Date.now()-t0,retries:calRetries,fetched:upcoming.length,cursor:calCursor,mode:calMode},accountId);
      }catch(e){console.warn('sync meta',e)}
    }
    queueDaylightHydrate();
    renderLoops();renderCategories();if(typeof renderInbox==='function')renderInbox();if(typeof renderWallet==='function'&&mq?.matches&&mTab==='wallet')renderWallet();
    return computeLoops().length;
  }
  function applyEmailClassification(data){
    const Cls=window.DaylightEmailClassify;
    if(!Cls?.classifyAll||!data)return null;
    const pool=new Map();
    [...(data.inbox||[]),...(data.financeMail||[]),...(data.travelMail||[]),...(data.docsMail||[])].forEach(m=>{if(m?.id)pool.set(m.id,m)});
    const result=Cls.classifyAll([...pool.values()]);
    // Ensure every mail has a classification (never silently drop)
    pool.forEach((m,id)=>{
      if(result.byMailId[id])return;
      const fallback=Cls.classifyEmail(m)||{
        mailId:id,threadId:m.threadId||id,category:'other',confidence:0.3,needsReview:true,method:'fallback',
        title:'Email',subject:'(No subject)',snippet:'',href:gmailLink(m.threadId||id),whenMs:Date.now(),
        kind:'other',tag:'Needs review',recordKey:'other:'+id,status:null,amount:'',domain:'',fromEmail:'',fromName:''
      };
      result.byMailId[id]=fallback;result.all.push(fallback);result.byCategory.other.push(fallback);
    });
    data.classified=result;
    try{buildFinance(data)}catch(e){console.warn('finance',e)}
    return result;
  }
  // ---- Phase 2: financial ledger (finance-intel.js). Conservative: only explicit evidence becomes an obligation. ----
  const FIN_LS={ledger:'daylight-finance-ledger',corr:'daylight-finance-corrections',confirmed:'daylight-finance-confirmed'};
  function finCorrections(){return readJSON(FIN_LS.corr,{})||{}}
  function finConfirmed(){return readJSON(FIN_LS.confirmed,{})||{}}
  function buildFinance(data){
    const F=window.DaylightFinance;if(!F||!data)return null;
    const pool=new Map();[...(data.inbox||[]),...(data.financeMail||[]),...(data.travelMail||[]),...(data.docsMail||[])].forEach(m=>{if(m?.id)pool.set(m.id,m)});
    const cls=[];pool.forEach(m=>{try{const c=F.classify(m);if(c)cls.push(c)}catch(e){console.warn('finance classify',e)}});
    const ledgerKey=FIN_LS.ledger+':'+((()=>{const p=readProfile();return p.sub||p.email||'local'})());// one ledger per Google account
    const prior=DEMO?[]:(readJSON(ledgerKey,[])||[]);
    const L=F.buildLedger(cls,{prior:Array.isArray(prior)?prior:[],corrections:finCorrections(),now:Date.now()});
    L.byMailClass={};cls.forEach(c=>{L.byMailClass[c.mailId]=c});
    L.recordByKey={};L.records.forEach(r=>{L.recordByKey[r.key]=r});
    // v2: an email deleted in Gmail never deletes or changes a financial record — it is only flagged for your review.
    if(!DEMO){
      const delKey='daylight-finance-source-deleted',del=readJSON(delKey,{})||{};let ch=false;
      (data.gmailV2?.deletedIds||[]).forEach(id=>{if(!del[id]){del[id]=Date.now();ch=true}});
      if(ch)writeJSON(delKey,del);
      L.records.forEach(r=>{if(r.mailIds?.length&&r.mailIds.every(id=>del[id]))r.sourceDeleted=true});
    }
    data.finance=L;
    // Demo/preview data is never persisted into the real ledger.
    if(!DEMO)writeJSON(ledgerKey,L.records.filter(r=>r.category!=='promotional_offer').slice(0,300).map(F.compact));
    return L;
  }
  function ensureFinance(){
    if(!loopsData)return null;
    if(!loopsData.finance)try{buildFinance(loopsData)}catch(e){console.warn('finance',e)}
    return loopsData.finance||null;
  }
  const finRecordForMail=(L,mailId)=>{const k=L?.byMail?.[mailId];return k?L.recordByKey[k]:null};
  const FIN_TAG_DAY=ms=>new Date(ms).toLocaleDateString(undefined,{day:'numeric',month:'short'});
  function applyFinanceView(item,rec,c){
    const F=window.DaylightFinance;
    const noon=d=>{if(!d)return null;const [y,m,dd]=d.split('-').map(Number);return new Date(y,m-1,dd,12).getTime()};
    const dueMs=noon(rec.dueDate),renewMs=noon(rec.renewalDate),recvMs=c?.whenMs||Date.parse(rec.receivedAt||'')||Date.now();
    let group='payment',kind='payment',category='payment',fb='payments';
    if(rec.category==='unpaid_bill'||rec.category==='paid_invoice'){group='bill';kind='bill';category='bill';fb='bills'}
    else if(rec.category==='subscription_renewal'){group='subscription';kind='subscription';category='subscription';fb='subscriptions'}
    else if(rec.category==='purchase_receipt'){group='shopping';kind='shopping';category='shopping';fb='receipts'}
    else if(rec.category==='promotional_offer'){group='other';kind='other';category='promotions';fb='promotions'}
    const actionable=rec.obligation==='outstanding'||(rec.obligation==='upcoming'&&rec.status!=='scheduled_debit');
    if(actionable){group='pending';kind='pending'}
    const tag={
      outstanding:rec.overdue?'Overdue':(dueMs?'Due '+FIN_TAG_DAY(dueMs):'Due'),
      upcoming:rec.status==='scheduled_debit'?('Auto-pay'+(dueMs?' '+FIN_TAG_DAY(dueMs):'')):rec.category==='subscription_renewal'?('Renews'+(renewMs?' '+FIN_TAG_DAY(renewMs):'')):rec.category==='payment_pending'?'Processing':('Due '+(dueMs?FIN_TAG_DAY(dueMs):'')),
      review:'Needs review',
      paid:rec.category==='subscription_renewal'?'Renewed':'Paid',
      refunded:rec.category==='refund_pending'?'Refund pending':'Refunded',
      incoming:'Received',promotion:'Promotion',dismissed:'Dismissed',info:rec.label
    }[rec.bucket]||rec.label;
    item.fin={key:rec.key,category:rec.category,label:rec.label,bucket:rec.bucket,status:rec.status,direction:rec.direction,obligation:rec.obligation,obligationReason:rec.obligationReason,confidence:rec.confidence,dueDate:rec.dueDate,dueDateRaw:rec.dueDateRaw,renewalDate:rec.renewalDate,amount:rec.amount,invoiceNumber:rec.invoiceNumber,evidence:rec.evidence||[],conflicts:rec.conflicts||[],suggestion:rec.suggestion||null,possiblyPaid:!!rec.possiblyPaid,linkedPaid:rec.linkedPaid||null,links:rec.links||[],judgedFrom:rec.judgedFrom,corrected:!!rec.corrected};
    item.amount=rec.amount?F.fmtAmount(rec.amount):'';
    item.needsReview=rec.bucket==='review';
    item.kind=kind;item.category=category;item.financeBucket=fb;item.tag=tag;item.group=group;item.finRecordKey=rec.key;
    item.when=dueMs||renewMs||recvMs;item.received=!dueMs&&!renewMs;item.urgent=rec.obligation==='outstanding';
    item.meta=dueMs?FIN_TAG_DAY(dueMs):renewMs?'Renews '+FIN_TAG_DAY(renewMs):ago(new Date(recvMs));
    item.detail=[rec.label,item.amount].filter(Boolean).join(' · ');
    item.status=rec.status||item.status;
    return item;
  }
  // Payment tasks created automatically by Daylight before Phase 2 are unconfirmed suggestions, not obligations.
  const isLegacyPayTask=t=>!!t&&t.suggested&&t.project==='Payments'&&!t.financeConfirmed;
  function readAiOrders(){try{return JSON.parse(localStorage.getItem('daylight-orders')||'[]')}catch{return[]}}
  function saveAiOrders(list){try{localStorage.setItem('daylight-orders',JSON.stringify((list||[]).slice(0,120)))}catch{}}
  function readAiExtractions(){try{return JSON.parse(localStorage.getItem('daylight-ai-extractions')||'{}')}catch{return{}}}
  function saveAiExtractions(map){try{localStorage.setItem('daylight-ai-extractions',JSON.stringify(map||{}))}catch{}}
  function normalizeMailForAi(m){
    const Cls=window.DaylightEmailClassify;
    const n=Cls?.normalizeMail?.(m)||null;
    if(n)return n;
    const h=m?.payload?.headers||[];
    return{id:m.id,mailId:m.id,threadId:m.threadId||m.id,subject:header(h,'Subject')||'',fromEmail:parseFrom(header(h,'From')).email,fromName:parseFrom(header(h,'From')).name,body:mailSearchText(m),snippet:m.snippet||'',whenMs:Number(m.internalDate)||Date.now(),attachments:[]};
  }
  async function enrichWithDaylightAI(data){
    const AI=window.DaylightAI;
    if(!AI||!data?.classified)return null;
    const pool=new Map();
    [...(data.inbox||[]),...(data.financeMail||[]),...(data.travelMail||[]),...(data.docsMail||[])].forEach(m=>{if(m?.id)pool.set(m.id,m)});
    const byMail=data.classified.byMailId||{};
    const prev=readAiExtractions();
    const next={...prev};
    const enrichIds=[];
    // Prioritise shopping + travel + needsReview (cost control: cap per sync)
    const ranked=Object.values(byMail).sort((a,b)=>{
      const score=x=>(x.needsReview?3:0)+(x.category==='shopping'||x.category==='ticket'?2:0)+(x.confidence<0.62?1:0);
      return score(b)-score(a);
    });
    for(const c of ranked){
      if(enrichIds.length>=12)break;
      if(!c?.mailId||!pool.has(c.mailId))continue;
      if(prev[c.mailId]?.method==='gemini'&&Date.now()-(prev[c.mailId]._at||0)<6*3600000&&!c.needsReview)continue;
      enrichIds.push(c.mailId);
    }
    const ctxBase={
      serverUrl,session:serverSession||'',
      nowIso:new Date().toISOString(),
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'
    };
    const accountEmail=(readProfile()?.email||serverEmail||'').toLowerCase();
    if(accountEmail&&!AI.accountAllowed(accountEmail)){AI.setStatus('AI skipped for this account');data.aiEnrichment={skipped:true,reason:'account'};return data.aiEnrichment}
    const applyExtraction=async(id,m,rule,mail,extraction)=>{
        extraction._at=Date.now();
        extraction.mailId=id;
        extraction.threadId=mail.threadId||m.threadId||id;
        extraction.entityKey=AI.entityKey(extraction,mail);
        // Diff against previous extraction for lifecycle updates
        if(prev[id]){
          const diff=await AI.analyseEmailChanges(prev[id],extraction);
          extraction.changes=diff.changes||[];
        }
        next[id]=extraction;
        // Merge AI category into classify record when rules were uncertain or shopping/travel
        if(rule&&(rule.needsReview||rule.category==='shopping'||rule.category==='ticket'||(rule.confidence||0)<0.62)){
          if(extraction.inboxCategory&&extraction.confidence>=0.7){
            const oldCat=rule.category;
            rule.aiCategory=extraction.category;
            rule.aiIntent=extraction.intent;
            rule.aiSummary=extraction.summary;
            rule.aiConfidence=extraction.confidence;
            rule.requiresConfirmation=!!extraction.requires_confirmation;
            rule.method=(rule.method||'rule')+'+'+(extraction.method||'ai');
            if(extraction.inboxCategory!==oldCat&&extraction.confidence>=0.78&&!extraction.requires_confirmation){
              // Move bucket
              const list=data.classified.byCategory[oldCat];
              if(list){const i=list.findIndex(x=>x.mailId===id);if(i>=0)list.splice(i,1)}
              rule.category=extraction.inboxCategory;
              rule.kind=extraction.inboxCategory==='subscription'?'subscription':extraction.inboxCategory==='payment'?'pending':extraction.inboxCategory==='bill'?'bill':extraction.inboxCategory==='shopping'?'shopping':extraction.inboxCategory==='ticket'?'ticket':'other';
              rule.tag=({subscription:'Subscription',payment:'Payment',bill:'Bill',ticket:'Ticket',shopping:'Shopping',other:'Other'})[rule.category]||'Other';
              data.classified.byCategory[rule.category]=data.classified.byCategory[rule.category]||[];
              data.classified.byCategory[rule.category].push(rule);
            }else{
              rule.aiCategory=extraction.category;
            }
          }
        }else if(rule){
          rule.aiCategory=extraction.category;
          rule.aiIntent=extraction.intent;
          rule.aiSummary=extraction.summary;
          rule.aiConfidence=extraction.confidence;
          rule.requiresConfirmation=!!extraction.requires_confirmation;
        }
    };
    if(data.gmailV2&&v2Enabled()){
      // v2: only emails the pipeline marked as uncertain / missing fields, within the 5 % credit bucket and the daily cap.
      const v=getMailV2(),acct=v2AccountKey(),Bud=window.DaylightAiBudget;
      const aiOn=AI.isEnabled?.()&&AI.getConsent?.();
      const allowFin=localStorage.getItem('daylight-ai-allow-financial')==='1';
      let processed=0;
      const res=await v.pipe.runAi({accountId:acct,candidates:data.gmailV2.aiCandidates||[],budget:v.budget,newCount:data.gmailV2.newCount||0,aiEnabled:!!aiOn,allowFinancial:allowFin,
        analyse:async c=>{
          const m=pool.get(c.messageId)||{id:c.messageId,threadId:c.threadId,payload:{headers:[]}},rule=byMail[c.messageId];
          const mail=normalizeMailForAi(m);
          mail.body=Bud.cleanForAi(c.text||mail.body||mail.snippet||'',v.config.ai.maxChars).text;
          try{
            const extraction=await AI.analyseEmail(mail,{...ctxBase,ruleResult:rule,maxChars:v.config.ai.maxChars});
            const called=extraction?.source==='gemini';
            if(extraction&&extraction.valid){await applyExtraction(c.messageId,m,rule,mail,extraction);processed++}
            const cat=V2_AI_CAT[extraction?.category]||null;
            return {ok:!!(extraction?.valid&&called&&cat),noCall:!called,value:cat?{category:cat,confidence:extraction.confidence||0}:null,usage:{inputTokens:Number(extraction?.usage?.promptTokenCount||0),outputTokens:Number(extraction?.usage?.candidatesTokenCount||0),model:extraction?.model},retried:!!extraction?.retried};
          }catch(e){console.warn('ai enrich',c.messageId,e);return {ok:false,noCall:true}}
        }});
      saveAiExtractions(next);
      data.aiExtractions=next;
      data.aiEnrichment={processed,sent:res.sent,deferred:res.deferred,skipped:res.skipped,total:Object.keys(byMail).length,engine:'v2'};
      return data.aiEnrichment;
    }
    for(const id of enrichIds){
      const m=pool.get(id),rule=byMail[id];
      const mail=normalizeMailForAi(m);
      try{
        const extraction=await AI.analyseEmail(mail,{...ctxBase,ruleResult:rule});
        if(!extraction||!extraction.valid)continue;
        await applyExtraction(id,m,rule,mail,extraction);
      }catch(e){console.warn('ai enrich',id,e)}
    }
    saveAiExtractions(next);
    data.aiExtractions=next;
    data.aiEnrichment={processed:enrichIds.length,total:Object.keys(byMail).length};
    return data.aiEnrichment;
  }
  function upsertAiOrder(extraction,mailMeta){
    if(!extraction?.order)return null;
    const AI=window.DaylightAI;
    const key=extraction.entityKey||AI?.entityKey?.(extraction,mailMeta)||('mail:'+mailMeta.mailId);
    let list=readAiOrders();
    let row=list.find(o=>o.entityKey===key||(extraction.order.order_id&&o.orderId===extraction.order.order_id)||(extraction.order.tracking_number&&o.tracking===extraction.order.tracking_number)||o.threadId===mailMeta.threadId);
    const histEntry={at:new Date().toISOString(),mailId:mailMeta.mailId,intent:extraction.intent,status:extraction.order.status,summary:extraction.summary};
    if(row){
      row.status=extraction.order.status||row.status;
      row.deliveryDate=extraction.order.delivery_date||row.deliveryDate;
      row.tracking=extraction.order.tracking_number||row.tracking;
      row.merchant=extraction.order.merchant||row.merchant;
      row.orderId=extraction.order.order_id||row.orderId;
      row.summary=extraction.summary||row.summary;
      row.lastMailId=mailMeta.mailId;
      row.updatedAt=new Date().toISOString();
      row.history=(row.history||[]).concat(histEntry).slice(-20);
      row.requiresConfirmation=!!extraction.requires_confirmation;
      row.sourceMailIds=Array.from(new Set([...(row.sourceMailIds||[]),mailMeta.mailId]));
    }else{
      row={
        id:key,entityKey:key,merchant:extraction.order.merchant||'Store',orderId:extraction.order.order_id||null,
        tracking:extraction.order.tracking_number||null,deliveryDate:extraction.order.delivery_date||null,
        status:extraction.order.status||'ordered',summary:extraction.summary||'',threadId:mailMeta.threadId,
        lastMailId:mailMeta.mailId,sourceMailIds:[mailMeta.mailId],history:[histEntry],
        requiresConfirmation:!!extraction.requires_confirmation,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
      };
      list.unshift(row);
    }
    saveAiOrders(list);
    return row;
  }
  function upsertAiTravelIntoWallet(extraction,mailMeta){
    if(!extraction?.travel)return null;
    const t=extraction.travel;
    const isHotel=t.type==='hotel'||!!(t.hotel_name&&t.check_in);
    const isTrain=t.type==='train';
    // Only mint a pass when booking details are verified (never fabricate)
    const verified=isHotel
      ?!!(t.hotel_name&&t.check_in)
      :!!(t.pnr||(t.flight_number&&t.depart_datetime)||(t.from&&t.to&&t.depart_datetime)||(isTrain&&t.depart_datetime));
    if(!verified)return null;
    let list=readWallet();
    const travelMs=t.depart_datetime?new Date(t.depart_datetime).getTime():(t.check_in?new Date(t.check_in).getTime():null);
    if(travelMs==null||isNaN(travelMs))return null; // no fabricated travel date
    // Multi-pass: stable child when AI/extraction exposes multiple segments
    const segments=Array.isArray(t.segments)&&t.segments.length>1?t.segments:null;
    const upsertOne=(seg,childKey)=>{
      const flight=seg?{from:seg.from||t.from,to:seg.to||t.to,flight:seg.flight_number||t.flight_number,depart:seg.depart_datetime||t.depart_datetime,arrive:seg.arrive_datetime||t.arrive_datetime,seat:seg.seat||t.seat,gate:seg.gate||t.gate,pnr:seg.pnr||t.pnr}
        :{from:t.from,to:t.to,flight:t.flight_number,depart:t.depart_datetime,arrive:t.arrive_datetime,seat:t.seat,gate:t.gate,pnr:t.pnr};
      const whenMs=flight.depart?new Date(flight.depart).getTime():travelMs;
      const booking={
        mailId:mailMeta.mailId,threadId:mailMeta.threadId,kind:isHotel?'hotel':isTrain?'train':'flight',
        subject:extraction.summary||mailMeta.subject||'Travel',
        from:{name:extraction.organisation||t.hotel_name||'Travel'},
        dest:flight.to||t.hotel_name||'',flight,whenMs,receivedMs:mailMeta.whenMs||Date.now(),
        travelReliable:true,childKey:childKey||null,
        tripId:null,href:mailMeta.href||gmailLink(mailMeta.threadId||mailMeta.mailId),
        recordKey:mailMeta.recordKey||null,entityKey:extraction.entityKey||null,
        cancelled:/cancel/i.test(t.status||'')||extraction.intent==='booking_cancelled'||extraction.intent==='cancellation'
      };
      booking.tripId=tripIdFor(booking.dest||booking.flight?.from||'travel',booking.whenMs);
      return upsertWalletFromBooking(booking,list);
    };
    let r;
    if(segments){
      r={added:false,updated:false,change:null};
      segments.forEach((seg,idx)=>{
        const ck=seg.pnr||seg.flight_number||('seg-'+(idx+1));
        const one=upsertOne(seg,ck);
        if(one.added)r.added=true;if(one.updated)r.updated=true;r.walletId=one.walletId;r.change=one.change||r.change;
      });
    }else r=upsertOne(null,null);
    if(r.added||r.updated)saveWallet(list);
    return r;
  }
  function createAiReminders(extraction,mailMeta){
    const stamped=readJSON('daylight-ai-reminders',{});
    const entityKey=extraction.entityKey||mailMeta.mailId;
    // Never auto-create reminders from promotional / newsletter mail
    if(extraction.intent==='promotional'||extraction.category==='promotions'||extraction.category==='newsletters')return 0;
    // Financial reminders need the user's confirmation in Money (Phase 2); AI may only inform the ledger, not create tasks.
    if(extraction.financial||['payment','bill','subscription','payments','bills','finance'].includes(extraction.category)||/^(payment_|refund|invoice|subscription_)/.test(extraction.intent||''))return 0;
    const cancelled=extraction.intent==='booking_cancelled'||extraction.intent==='cancellation'||extraction.intent==='subscription_cancelled'||/cancel/i.test(extraction.travel?.status||'')||/cancel/i.test(extraction.event?.status||'');
    // Cancellations: disable AI reminders for this entity instead of creating new ones
    if(cancelled){
      let disabled=0;
      personalTasks.forEach(t=>{
        if(!t.aiGenerated)return;
        if((t.entityKey&&t.entityKey===entityKey)||(t.mailId===mailMeta.mailId)){
          if(!t.disabled){t.disabled=true;t.disabledReason='cancelled';disabled++}
        }
      });
      if(disabled)savePersonal();
      return -disabled;
    }
    if(!extraction?.reminders?.length)return 0;
    let n=0;
    extraction.reminders.forEach(rem=>{
      if(!rem?.title)return;
      if(extraction.requires_confirmation||rem.requires_confirmation)return; // never auto-create uncertain
      if(!rem.datetime)return;
      const key=entityKey+'::'+rem.title;
      if(stamped[key])return;
      if(personalTasks.some(t=>!t.disabled&&(t.mailId===mailMeta.mailId||t.entityKey===entityKey)&&t.title===rem.title)){stamped[key]=Date.now();return}
      const due=new Date(rem.datetime);
      if(isNaN(due.getTime()))return;
      personalTasks.unshift({
        id:crypto.randomUUID?.()||('ai-rem-'+Date.now()),
        title:rem.title,
        dueDate:due.toISOString(),hasTime:!/T00:00/.test(rem.datetime),
        project:extraction.order?'Shopping':extraction.travel?'Travel':'Reminders',
        mailId:mailMeta.mailId,href:mailMeta.href||gmailLink(mailMeta.threadId||mailMeta.mailId),
        suggested:true,aiGenerated:true,reason:rem.reason||'',entityKey,
        created:new Date().toISOString()
      });
      stamped[key]=Date.now();n++;
    });
    if(n){savePersonal();writeJSON('daylight-ai-reminders',stamped)}
    return n;
  }
  function distributeAiExtractions(data){
    const map=data?.aiExtractions||readAiExtractions();
    if(!map||!Object.keys(map).length)return {orders:0,wallet:0,reminders:0};
    let orders=0,wallet=0,reminders=0;
    const upcomingAi=[];
    Object.values(map).forEach(ex=>{
      if(!ex||!ex.valid)return;
      const promo=ex.intent==='promotional'||ex.category==='promotions'||ex.category==='newsletters';
      const mailMeta={mailId:ex.mailId,threadId:ex.threadId,subject:ex.summary,href:gmailLink(ex.threadId||ex.mailId)};
      // Promotional mail must not seed shopping orders / delivery events / reminders
      if(ex.order&&!promo){if(upsertAiOrder(ex,mailMeta))orders++}
      if(ex.travel&&!promo){const r=upsertAiTravelIntoWallet(ex,mailMeta);if(r&&(r.added||r.updated))wallet++}
      reminders+=createAiReminders(ex,mailMeta);
      if(!promo&&ex.event?.exists&&ex.event.start_datetime&&!ex.requires_confirmation){
        const cancelled=ex.intent==='booking_cancelled'||/cancel/i.test(ex.event.status||'');
        upcomingAi.push({
          id:'ai-event:'+(ex.entityKey||ex.mailId),
          summary:ex.event.title||ex.summary,
          start:{dateTime:ex.event.all_day?undefined:ex.event.start_datetime,date:ex.event.all_day?ex.event.start_datetime.slice(0,10):undefined},
          end:ex.event.end_datetime?{dateTime:ex.event.end_datetime}:undefined,
          location:ex.event.location||'',
          source:'daylight-ai',mailId:ex.mailId,entityKey:ex.entityKey,
          status:cancelled?'cancelled':(ex.event.status||'confirmed')
        });
      }
    });
    if(data){
      data.orders=readAiOrders();
      data.aiUpcoming=upcomingAi;
      // Merge AI upcoming: upsert by id; cancelled statuses replace active ones
      if(upcomingAi.length){
        const byId=new Map((data.upcoming||[]).map(e=>[e.id,e]));
        upcomingAi.forEach(e=>{
          const prev=byId.get(e.id);
          if(prev&&e.entityKey&&prev.entityKey===e.entityKey){byId.set(e.id,{...prev,...e})}
          else byId.set(e.id,e);
        });
        data.upcoming=[...byId.values()].filter(e=>e.status!=='cancelled');
      }
    }
    return {orders,wallet,reminders,upcoming:upcomingAi.length};
  }
  function syncClassifiedTicketsToWallet(){
    // Single write path: classified tickets upsert into mail:{mailId} (no ticket: legacy ids)
    const tickets=loopsData?.classified?.byCategory?.ticket||[];
    if(!tickets.length||typeof readWallet!=='function'||typeof saveWallet!=='function')return;
    let list=readWallet(),changed=false;
    const Data=window.DaylightData;
    tickets.forEach(t=>{
      if(!t.mailId)return;
      const ex=Data?.extractionForMail?.(t.mailId)||readAiExtractions()?.[t.mailId];
      const depart=ex?.travel?.depart_datetime||ex?.travel?.check_in||null;
      const travelMs=depart&&!isNaN(new Date(depart))?new Date(depart).getTime():null;
      const flight=ex?.travel?{from:ex.travel.from,to:ex.travel.to,flight:ex.travel.flight_number,depart:ex.travel.depart_datetime,pnr:ex.travel.pnr,seat:ex.travel.seat}:null;
      const r=upsertWalletFromBooking({
        mailId:t.mailId,threadId:t.threadId||t.mailId,kind:'train',
        subject:t.subject||t.title||'Ticket',from:{name:t.fromName||t.title||''},
        dest:flight?.to||'',flight,whenMs:travelMs,receivedMs:t.whenMs||Date.now(),
        travelReliable:!!travelMs,href:t.href||'',tripId:null,
        recordKey:t.recordKey||null,entityKey:ex?.entityKey||null,
        cancelled:/cancel/i.test(t.status||t.subject||'')
      },list);
      if(r.added||r.updated)changed=true;
    });
    if(changed)saveWallet(list.slice(0,80));
  }
  function demoLoopsData(){
    const days=n=>new Date(Date.now()-n*86400000).toISOString();
    const mail=(id,from,subject,agoDays,labels=['INBOX','UNREAD'],extra={})=>{
      const body=extra.body||subject;
      const parts=extra.filename?[{mimeType:'application/pdf',filename:extra.filename,body:{}}]:[];
      return {
        id,threadId:extra.threadId||id,labelIds:labels,snippet:String(body).slice(0,180),
        internalDate:String(Date.now()-agoDays*86400000),
        payload:{
          mimeType:parts.length?'multipart/mixed':'text/plain',
          headers:[{name:'From',value:from},{name:'Subject',value:subject},{name:'Date',value:days(agoDays)}],
          body:parts.length?{}:{data:btoa(unescape(encodeURIComponent(body))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')},
          parts:parts.length?[{mimeType:'text/plain',body:{data:btoa(unescape(encodeURIComponent(body))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}},...parts]:undefined
        }
      };
    };
    const ev=(id,summary,inDays,loc='')=>({id,summary,htmlLink:'#',location:loc,start:{dateTime:new Date(localMidnight.getTime()+inDays*86400000+10*3600000).toISOString()},end:{dateTime:new Date(localMidnight.getTime()+inDays*86400000+11*3600000).toISOString()},attendees:[{email:'a@x.com'},{email:'b@x.com'}]});
    const money=[
      mail('d1','Netflix <noreply@netflix.com>','Your Netflix subscription renews on Mar 15 · $19.99',32,['INBOX','CATEGORY_UPDATES'],{body:'Your Netflix membership auto-renews monthly for $19.99. Manage your subscription in account settings.'}),
      mail('d1b','Netflix <noreply@netflix.com>','Netflix renewal confirmation · $19.99',2,['INBOX','CATEGORY_UPDATES'],{body:'Thanks — your Netflix subscription renewed successfully for $19.99. Recurring membership continues.'}),
      mail('d2','Spotify <no-reply@spotify.com>','Spotify Premium renews soon · $4.99',5,['INBOX','CATEGORY_UPDATES'],{body:'Your Spotify Premium subscription renews soon. Recurring billing $4.99/month.'}),
      mail('d7','Adobe <noreply@adobe.com>','Adobe Creative Cloud membership — payment due $59.99',1,['INBOX','IMPORTANT','UNREAD'],{body:'Your Adobe Creative Cloud subscription payment is due. Membership renews automatically.'}),
      mail('d14','Cursor <noreply@cursor.com>','Cursor Pro free trial renews on Mar 9 · $15.99',0.5,['INBOX','CATEGORY_UPDATES'],{body:'Your Cursor Pro subscription free trial converts to a paid recurring plan for $15.99.'}),
      mail('d15','OpenAI <noreply@openai.com>','ChatGPT Plus subscription renewed · $20.00',3,['INBOX','CATEGORY_UPDATES'],{body:'Your ChatGPT Plus membership auto-renewed. Subscription continues monthly.'}),
      mail('d16','xAI <noreply@x.ai>','Grok SuperGrok membership confirmation',8,['INBOX','CATEGORY_UPDATES'],{body:'Welcome to SuperGrok. Your recurring subscription is active.'}),
      mail('d8','Vodafone <billing@vodafone.cz>','Your Vodafone bill for February is ready · 499 Kč',3,['INBOX','CATEGORY_UPDATES'],{body:'Your mobile invoice is ready. Amount due 499 Kč. Please pay by the due date.',filename:'vodafone-invoice.pdf'}),
      mail('d9','ČEZ <noreply@cez.cz>','Electricity invoice — payment due by Mar 12 · 1 240 Kč',4,['INBOX'],{body:'Electricity bill / faktura. Payment due by Mar 12. Amount 1 240 Kč unpaid.',filename:'cez-faktura.pdf'}),
      mail('d9p','ČEZ <noreply@cez.cz>','Thank you for your payment — electricity invoice paid · 1 240 Kč',1,['INBOX'],{body:'Invoice paid. Thank you for your payment on your electricity bill.'}),
      mail('d12','PayPal <service@paypal.com>','You paid €24.90 via PayPal',2,['INBOX','CATEGORY_UPDATES'],{body:'You paid €24.90. Payment successful. Receipt for your purchase.'}),
      mail('d13','Apple <no_reply@email.apple.com>','Receipt from Apple — App Store · $15.99',7,['INBOX','CATEGORY_UPDATES'],{body:'Receipt from Apple. You bought an app in the App Store for $15.99. One-time purchase.'}),
      mail('d17','Stripe <receipts@stripe.com>','Payment failed — card declined · $12.00',0.8,['INBOX','IMPORTANT'],{body:'Your payment failed. Card declined. Insufficient funds. Please update your card.'}),
      mail('d18','PayPal <service@paypal.com>','Refund issued · €18.40',9,['INBOX','CATEGORY_UPDATES'],{body:'A refund of €18.40 was issued to your PayPal balance.'})
    ];
    const shopping=[
      mail('d10','Amazon <auto-confirm@amazon.com>','Your Amazon order has shipped · $42.10',1,['INBOX','CATEGORY_PURCHASES'],{body:'Your order has shipped. Tracking available. Package out for delivery soon.'}),
      mail('d11','Zalando <no-reply@zalando.com>','Your Zalando order is confirmed · €68.00',6,['INBOX','CATEGORY_PURCHASES'],{body:'Order confirmed. We will email when your package is shipped.'}),
      mail('d19','Temu <noreply@temu.com>','Return received — refund processing',4,['INBOX','CATEGORY_PURCHASES'],{body:'Your return was received. Refund for your order is processing.'})
    ];
    const tickets=[
      mail('d3','Deutsche Bahn <noreply@bahn.de>','Your train ticket: Berlin → Prague',1,['INBOX','IMPORTANT'],{body:'Booking confirmation. Your e-ticket for Berlin to Prague is attached.',filename:'bahn-ticket.pdf'}),
      mail('d4','Lufthansa <noreply@lufthansa.com>','Boarding pass · LH 1234 Munich–Lisbon',3,['INBOX'],{body:'Boarding pass attached. Flight LH 1234. Check-in complete. Gate A12.',filename:'boarding-pass.pdf'}),
      mail('d20','Booking.com <noreply@booking.com>','Reservation confirmed — Hotel Lisboa Chiado',5,['INBOX'],{body:'Hotel booking confirmation. Reservation confirmed for 2 nights.'})
    ];
    const other=[
      mail('d5','Ana <ana@uni.cz>','Quick question about Friday’s lab',0.3,['INBOX','UNREAD','CATEGORY_PERSONAL'],{body:'Hey — can we meet before Friday’s lab to review the notes?'}),
      mail('d6','HR Portal <docs@company.com>','Please sign: internship agreement PDF',4,['INBOX','UNREAD'],{body:'Please review and sign the internship agreement PDF before Monday.',filename:'internship-agreement.pdf'}),
      mail('d21','Newsletter <hello@mixedmail.example>','Update for you',1.2,['INBOX','CATEGORY_UPDATES'],{body:'Here is a short update from our team this week.'})
    ];
    return {
      inbox:[...money,...shopping,...tickets,...other],
      financeMail:money,travelMail:tickets,docsMail:[other[1]],threads:[],
      upcoming:[ev('e1','Flight LH 1234',2,'Munich Airport'),ev('e2','Project check-in',0),ev('e3','Submit thesis abstract',1)],
      files:{}
    };
  }
  function computeLoops(){
    const out=[],now=Date.now(),day=86400000;
    const add=(type,id,title,detail,meta,href,extra={})=>out.push({type,id:type+':'+id,title,detail,meta,href,...extra});
    if(loopsData){
      loopsData.inbox.forEach(m=>{const h=m.payload?.headers||[],from=parseFrom(header(h,'From')),subject=header(h,'Subject')||'(No subject)',when=new Date(header(h,'Date')||m.internalDate*1),age=now-when,labels=m.labelIds||[];
        const primary=labels.includes('CATEGORY_PERSONAL')||!labels.some(l=>/^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l));
        const mailExtra={mailId:m.id,threadId:m.threadId,fromName:from.name,fromEmail:from.email,whenMs:when.getTime(),snippet:m.snippet||'',subject};
        const finC=loopsData.finance?.byMailClass?.[m.id];
        if(RENEWAL.test(subject)&&age<30*day&&(!finC||finC.category==='subscription_renewal')){add('renewal',m.threadId,`Review: ${subject}`,`From ${from.name}`,ago(when),gmailLink(m.threadId),{...mailExtra,category:'Renewal / Billing'});return}
        if(isBulkMail(m))return; // offers, newsletters, social and automated mail never become loops
        if(TRAVEL.test(subject)&&age<21*day){
          const booking=(loopsData.bookings||[]).find(b=>b.mailId===m.id||b.threadId===m.threadId);
          const tripBits=booking?[booking.kind==='hotel'?'Hotel':booking.kind==='train'?'Train':'Flight',booking.dest,booking.tripId&&'linked trip'].filter(Boolean).join(' · '):'check dates, tickets and where you’re staying';
          add('travel',m.threadId,subject,`From ${from.name} · ${tripBits}`,ago(when),gmailLink(m.threadId),{
            ...mailExtra,category:'Travel',tripId:booking?.tripId||'',travelKind:booking?.kind||'',travelWhenMs:booking?.whenMs||when.getTime(),
            whenMs:booking?.whenMs||when.getTime()
          });return
        }
        if(primary&&!AUTOMATED.test(from.email)&&(labels.includes('UNREAD')||labels.includes('IMPORTANT')||labels.includes('STARRED'))&&age>2*3600000&&age<14*day)
          add('reply',m.threadId,`Reply to ${from.name}`,subject,`waiting ${ago(when).replace(' ago','')}`,gmailLink(m.threadId),{...mailExtra,weight:labels.includes('IMPORTANT')||labels.includes('STARRED')?2:1,category:'Reply / Email'});
      });
      loopsData.threads.forEach(t=>{const msgs=t.messages||[],last=msgs.at(-1);if(!last||!(last.labelIds||[]).includes('SENT'))return;
        const h=last.payload?.headers||[],when=new Date(header(h,'Date')||last.internalDate*1),age=now-when;if(age<3*day||age>14*day)return;
        const to=parseFrom((header(h,'To')||'').split(',')[0]);if(!to.email||AUTOMATED.test(to.email))return;
        add('followup',t.id,`Follow up with ${to.name}`,header(h,'Subject')||'(No subject)',`no reply for ${Math.floor(age/day)} days`,gmailLink(t.id),{mailId:last.id,threadId:t.id,fromName:to.name,fromEmail:to.email,whenMs:when.getTime(),snippet:last.snippet||'',subject:header(h,'Subject')||'(No subject)',category:'Follow up / Email'});
      });
      loopsData.upcoming.forEach(e=>{const st=new Date(e.start?.dateTime||e.start?.date),title=e.summary||'(No title)',days=Math.floor((st-localMidnight)/day);
        const when=days===0?'Today':days===1?'Tomorrow':st.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});
        const time=e.start?.dateTime?' · '+hm(st):'';
        const calExtra={whenMs:st.getTime(),category:'Calendar',dueLabel:when};
        if((e.attendees||[]).length>1&&e.start?.dateTime&&days<=1&&st>now){
          const f=loopsData.files[e.id];
          const mail=loopsData.meetingMail?.[e.id];
          add('prepare',e.id,`Prepare for ${title}`,`${when}${time} · ${(e.attendees||[]).length} people`+(mail?' · related mail':''),'',e.htmlLink,{
            ...calExtra,related:f||undefined,relatedMail:mail||undefined,
            mailId:mail?.mailId||undefined,threadId:mail?.threadId||undefined
          });
        }
        if(DEADLINE.test(title)&&days<=3)add('deadline',e.id,title,`${when}${time}`,'',e.htmlLink,calExtra);
        if(TRAVEL.test(title+' '+(e.location||''))&&days<=7){
          const booking=(loopsData.bookings||[]).find(b=>Math.abs((b.whenMs||0)-st.getTime())<4*day&&(TRAVEL.test(b.subject||'')||b.dest));
          add('travel',e.id,title,`${when}${time}${e.location?' · '+e.location:''}${booking?.tripId?' · trip linked':''}`,'',e.htmlLink,{
            ...calExtra,category:'Travel',tripId:booking?.tripId||'',travelWhenMs:st.getTime()
          });
        }
      });
    }
    const dueDay=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[]),...personalTasks.filter(t=>t.dueDate).map(t=>({...t,source:'Daylight'}))].forEach((t,i)=>{if(!t.dueDate||isLegacyPayTask(t))return; // old automatic Pay tasks are unconfirmed suggestions, not loops
      const d=dueDay(t.dueDate),href=t.source==='Daylight'?'':t.source==='Microsoft To Do'?'https://to-do.office.com/':'https://tasks.google.com/';
      const taskExtra={whenMs:d.getTime(),dueLabel:d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}),category:'Task'};
      if(d<localMidnight)add('overdue',t.title+i,`Reschedule: ${t.title}`,`Was due ${d.toLocaleDateString(undefined,{day:'numeric',month:'short'})}`,'',href,taskExtra);
      else if(d<new Date(localMidnight.getTime()+2*day))add('deadline',t.title+i,t.title,d<tomorrow?'Due today':'Due tomorrow','',href,taskExtra)});
    const st=loopState(),order={overdue:0,deadline:1,reply:2,prepare:3,followup:4,renewal:5,travel:6};
    const seen=new Set();
    return out.filter(l=>{if(seen.has(l.id))return false;seen.add(l.id);const s=st[l.id];return !(s&&(s.done||(s.snooze&&s.snooze>now)))})
      .sort((a,b)=>(order[a.type]-order[b.type])||((b.weight||0)-(a.weight||0)));
  }
  function mailItem(m){
    const h=m.payload?.headers||[],from=parseFrom(header(h,'From')),subject=header(h,'Subject')||'(No subject)',when=new Date(header(h,'Date')||m.internalDate*1);
    return {id:m.threadId||m.id,title:subject,detail:from.name,meta:ago(when),href:gmailLink(m.threadId||m.id),when:when.getTime(),unread:(m.labelIds||[]).includes('UNREAD')};
  }
  const MONEY_LABEL={subscription:'Subscription',bill:'Bill',pending:'Payment',payment:'Payment',ticket:'Ticket',shopping:'Shopping',other:'Other'};
  function enrichClassifiedItem(c){
    const Cls=window.DaylightEmailClassify;
    if(!c||!Cls?.toInboxItem)return null;
    const item=Cls.toInboxItem(c);
    if(!item)return null;
    item.color=brandColor(item.title||item.domain||'mail');
    const logos=brandLogoUrls(item.domain);
    if(logos[0])item.logo=logos[0];
    if(!item.href&&item.id)item.href=gmailLink(item.id);
    if(!item.meta){
      if(c.status==='unpaid'||c.status==='pending')item.meta=c.status==='unpaid'?'Unpaid':'Pending';
      else if(c.status==='renewal'||c.category==='subscription')item.meta='Subscription';
      else item.meta=ago(new Date(item.whenMs||Date.now()));
    }
    return item;
  }
  function uniqueClassified(list,{byRecordKey=false}={}){
    const map=new Map();
    (list||[]).forEach(c=>{
      const key=byRecordKey?(c.recordKey||c.mailId):(c.mailId||c.id);
      const prev=map.get(key);
      if(!prev||(c.whenMs||0)>(prev.whenMs||0))map.set(key,c);
    });
    return [...map.values()].sort((a,b)=>(b.whenMs||0)-(a.whenMs||0));
  }
  function ensureClassified(){
    if(!loopsData)return null;
    if(!loopsData.classified)try{applyEmailClassification(loopsData)}catch(e){console.warn('classify',e)}
    return loopsData.classified||null;
  }
  function moneyFromMail(m){
    const classified=ensureClassified()?.byMailId?.[m.id];
    if(classified&&['subscription','payment','bill'].includes(classified.category)){
      const item=enrichClassifiedItem(classified);
      if(item)return item;
    }
    const h=m.payload?.headers||[],from=parseFrom(header(h,'From')),subject=header(h,'Subject')||'(No subject)',when=new Date(header(h,'Date')||m.internalDate*1);
    const kind=moneyKind(subject,from.name+' '+from.email);if(!kind)return null;
    const renew=parseMoneyWhen(subject,when);
    const amt=(subject.match(/(?:€|EUR|USD|\$|Kč|CZK)\s?[\d\s.,]+|\d[\d\s.,]*\s?(?:€|EUR|USD|\$|Kč|CZK)/i)||[])[0]?.replace(/\s+/g,' ').trim();
    const brand=from.name.replace(/\s*(billing|noreply|no-?reply|receipts?|support|service)\s*/ig,' ').replace(/\s+/g,' ').trim()||from.email.split('@')[0];
    const subline=kind==='subscription'
      ?(renew.received?`From ${brand}`:`Renews ${renew.label||'soon'}`)+(amt?` · ${amt}`:'')
      :kind==='pending'?`Payment${amt?' · '+amt:''}`
      :`Bill from ${brand}${amt?' · '+amt:''}`;
    const domain=brandDomain(from.email,brand);
    return {id:m.threadId||m.id,mailId:m.id,title:brand,subject,detail:subline,from:brand,fromName:from.name,fromEmail:from.email,domain,logo:brandLogoUrls(domain)[0]||'',meta:renew.label||ago(when),href:gmailLink(m.threadId||m.id),when:renew.sort||when.getTime(),whenMs:when.getTime(),kind,category:kind==='pending'?'payment':kind,tag:MONEY_LABEL[kind]||'Money',urgent:!!renew.urgent||kind==='pending',amount:amt||'',color:brandColor(brand),received:!!renew.received,snippet:m.snippet||''};
  }
  function computeClassifiedInbox(){
    const cls=ensureClassified();
    if(!cls)return null;
    const fin=ensureFinance();
    const now=Date.now(),day=86400000;
    const groups={subscription:[],bill:[],pending:[],payment:[],ticket:[],shopping:[],other:[]};
    const finSeen=new Set();
    uniqueClassified((cls.all||[]).filter(c=>(now-(c.whenMs||0))<=180*day)).forEach(c=>{
      const item=enrichClassifiedItem(c);if(!item)return;
      const rec=fin&&finRecordForMail(fin,c.mailId);
      if(rec){
        if(finSeen.has(rec.key))return;finSeen.add(rec.key); // one card per financial record (invoice + payment, renewal notices …)
        applyFinanceView(item,rec,c);(groups[item.group]||groups.other).push(item);return;
      }
      if(fin&&['subscription','payment','bill'].includes(c.category)){
        // The old classifier saw money words, the financial check found no transaction: show it as ordinary mail.
        item.category='other';item.kind='other';item.tag='Mail';item.financeBucket='important';item.urgent=false;item.amount='';
        groups.other.push(item);return;
      }
      (groups[c.category]||groups.other).push(item);
    });
    // Money tasks: tasks you created stay obligations; payment tasks Daylight auto-created before Phase 2 are only suggestions.
    const seen=new Set(Object.values(groups).flat().map(i=>i.id));
    const legacy=[];
    const dueDay=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[]),...personalTasks].forEach((t,i)=>{
      const title=t.title||'';if(!PAY_TASK.test(title))return; // only tasks that are clearly about paying (not "Renew passport photos")
      const id='task-money:'+(t.id||title)+i;if(seen.has(id))return;seen.add(id);
      const d=t.dueDate?dueDay(t.dueDate):null;
      const base={id,taskId:t.id,mailId:t.mailId||null,title:title.replace(/^(pay|reschedule:)\s*/i,'').trim()||title,subject:title,detail:t.listName||t.source||'Task',from:t.listName||'Task',href:t.source==='Microsoft To Do'?'https://to-do.office.com/':t.source==='Google Tasks'?'https://tasks.google.com/':(t.href||''),color:brandColor(title),received:false,amount:t.amount||''};
      if(isLegacyPayTask(t)){legacy.push({...base,kind:'other',category:'payment',tag:'Unconfirmed',meta:'Old automatic suggestion',when:d?d.getTime():now,whenMs:d?d.getTime():now,urgent:false,legacySuggestion:true});return}
      const urgent=!!d&&d<=new Date(localMidnight.getTime()+7*day);
      groups.pending.push({...base,meta:d?d.toLocaleDateString(undefined,{day:'numeric',month:'short'}):(t.due||'Open'),when:d?d.getTime():now,whenMs:d?d.getTime():now,kind:'pending',category:'payment',tag:t.financeConfirmed?'Reminder':'Task',urgent,userTask:true,obligationTask:true});
    });
    const byUrg=(a,b)=>(!!b.urgent-!!a.urgent)||(a.when||0)-(b.when||0)||String(a.title||'').localeCompare(String(b.title||''));
    Object.values(groups).forEach(g=>g.sort(byUrg));
    const all=[...groups.pending,...groups.subscription,...groups.bill,...groups.payment,...groups.ticket,...groups.shopping,...groups.other];
    // Ledger views (include records from earlier syncs that are no longer in the fetch window)
    const recs=(fin?.records||[]).filter(r=>r.bucket!=='promotion');
    const byBucket=b=>recs.filter(r=>r.bucket===b);
    const obligations=all.filter(i=>(i.fin&&(i.fin.obligation==='outstanding'||(i.fin.obligation==='upcoming'&&i.fin.status!=='scheduled_debit')))||i.obligationTask);
    return {
      subscription:groups.subscription,bill:groups.bill,pending:groups.pending,payment:groups.payment,ticket:groups.ticket,shopping:groups.shopping,other:groups.other,
      store:[],online:[],all,legacy,obligations,
      ledger:{outstanding:byBucket('outstanding'),upcoming:byBucket('upcoming'),paid:byBucket('paid'),refunded:byBucket('refunded'),incoming:byBucket('incoming'),review:byBucket('review'),info:byBucket('info'),dismissed:byBucket('dismissed'),suggestions:recs.filter(r=>r.suggestion&&!finConfirmed()[r.suggestion.key])},
      counts:{subscription:groups.subscription.length,bill:groups.bill.length,pending:groups.pending.length,payment:groups.payment.length,ticket:groups.ticket.length,shopping:groups.shopping.length,other:groups.other.length,store:0,online:0,total:all.length,obligations:obligations.length,review:byBucket('review').length+legacy.length},
      scanned:loopsData?.scanned||cls.all.length,
      _fromClassification:true
    };
  }
  function computeMoney(){
    const classified=computeClassifiedInbox();
    if(classified)return classified;
    const groups={subscription:[],bill:[],pending:[],ticket:[],shopping:[],other:[]},seen=new Set(),now=Date.now(),day=86400000;
    const mails=loopsData?[...(loopsData.inbox||[]),...(loopsData.financeMail||[]),...(loopsData.travelMail||[]),...(loopsData.docsMail||[])]:[];
    const uniq=new Map();mails.forEach(m=>{if(m?.id)uniq.set(m.id,m)});
    uniq.forEach(m=>{
      const age=now-new Date((m.payload?.headers&&header(m.payload.headers,'Date'))||m.internalDate*1);
      if(age>180*day)return;
      const item=moneyFromMail(m);if(!item||seen.has(item.id))return;seen.add(item.id);
      (groups[item.kind]||groups.pending).push(item);
    });
    const dueDay=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[]),...personalTasks].forEach((t,i)=>{
      const title=t.title||'';if(!PAY_TASK.test(title))return; // only tasks that are clearly about paying (not "Renew passport photos")
      const id='task-money:'+(t.id||title)+i;if(seen.has(id))return;seen.add(id);
      const d=t.dueDate?dueDay(t.dueDate):null,urgent=!d||d<=new Date(localMidnight.getTime()+7*day);
      const item={id,title:title.replace(/^(pay|reschedule:)\s*/i,'').trim()||title,subject:title,detail:t.listName||t.source||'Task',from:t.listName||'Task',meta:d?d.toLocaleDateString(undefined,{day:'numeric',month:'short'}):(t.due||'Open'),href:t.source==='Microsoft To Do'?'https://to-do.office.com/':t.source==='Google Tasks'?'https://tasks.google.com/':'',when:d?d.getTime():now,kind:'pending',category:'payment',tag:'Payment',urgent,amount:'',color:brandColor(title),received:false};
      groups.pending.push(item);
    });
    const byUrg=(a,b)=>(b.urgent-a.urgent)||(a.when||0)-(b.when||0)||a.title.localeCompare(b.title);
    Object.keys(groups).forEach(k=>groups[k].sort(byUrg));
    const all=[...groups.pending,...groups.subscription,...groups.bill,...groups.ticket,...groups.shopping,...groups.other];
    return {...groups,store:[],online:[],payment:groups.pending,all,counts:{subscription:groups.subscription.length,bill:groups.bill.length,store:0,online:0,pending:groups.pending.length,ticket:groups.ticket.length,shopping:groups.shopping.length,other:groups.other.length,total:all.length},scanned:loopsData?.scanned||uniq.size};
  }
  function computeCategories(){
    const money=computeMoney(),finance=money.all.map(i=>({...i,title:i.subject||i.title,detail:i.from,meta:i.meta,kind:'finance'})),travel=[],pending=[],documents=[],now=Date.now(),day=86400000;
    const push=(arr,item)=>{const k=String(item.id||item.title);if(arr._seen.has(k))return;arr._seen.add(k);arr.push(item)};
    travel._seen=new Set();pending._seen=new Set();documents._seen=new Set();
    const mails=loopsData?[...(loopsData.inbox||[]),...(loopsData.financeMail||[]),...(loopsData.travelMail||[]),...(loopsData.docsMail||[])]:[];
    const uniq=new Map();mails.forEach(m=>{if(m?.id)uniq.set(m.id,m)});
    uniq.forEach(m=>{const h=m.payload?.headers||[],subject=header(h,'Subject')||'',age=now-new Date(header(h,'Date')||m.internalDate*1),item=mailItem(m);
      if(TRAVEL.test(subject)&&age<45*day)push(travel,{...item,kind:'travel',tag:/\b(flight|boarding|lufthansa|ryanair|easyjet)\b/i.test(subject)?'Flight':/\b(train|bahn|rail|eurostar)\b/i.test(subject)?'Train':'Trip'});
      if(DOCUMENT.test(subject)&&age<45*day)push(documents,{...item,kind:'docs',tag:'Mail'});
    });
    (loopsData?.upcoming||[]).forEach(e=>{const st=new Date(e.start?.dateTime||e.start?.date),title=e.summary||'(No title)',days=Math.floor((st-localMidnight)/day);
      const when=days===0?'Today':days===1?'Tomorrow':st.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});
      const time=e.start?.dateTime?' · '+hm(st):'';
      if(TRAVEL.test(title+' '+(e.location||''))&&days<=14)push(travel,{id:'cal:'+e.id,title,detail:`${when}${time}${e.location?' · '+e.location:''}`,meta:'Calendar',href:e.htmlLink||'',when:st.getTime(),kind:'travel',tag:'Calendar'});
      if(DEADLINE.test(title)&&days<=3)push(pending,{id:'caldead:'+e.id,title,detail:`${when}${time}`,meta:'Calendar',href:e.htmlLink||'',when:st.getTime(),kind:'pending',tag:days<0?'Overdue':'Due soon'});
    });
    const dueDay=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    const allTasks=[...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[]),...personalTasks.map(t=>({...t,source:'Daylight',listName:t.project||'Personal'}))];
    if(DEMO&&!token)allTasks.push({title:'Pay Spotify before renewal',dueDate:new Date(localMidnight.getTime()+86400000).toISOString(),due:'Tomorrow',listName:'Personal',source:'Daylight'},{title:'Pack for Lisbon trip',dueDate:new Date(localMidnight.getTime()+2*86400000).toISOString(),due:'In 2 days',listName:'Travel',source:'Daylight'},{title:'Reply to Ana about lab',dueDate:localMidnight.toISOString(),due:'Today',listName:'Uni',source:'Daylight'});
    allTasks.forEach((t,i)=>{
      if(isLegacyPayTask(t))return; // listed under Money › Old automatic payment tasks instead
      const href=t.source==='Daylight'?'':t.source==='Microsoft To Do'?'https://to-do.office.com/':'https://tasks.google.com/';
      if(!t.dueDate){if(t.hasTime)return;push(pending,{id:'taskopen:'+ (t.id||t.title)+i,title:t.title,detail:t.listName||t.source||'Task',meta:'Open',href,when:0,kind:'pending',tag:'Task'});return}
      const d=dueDay(t.dueDate);if(d>new Date(localMidnight.getTime()+7*day))return;
      const tag=d<localMidnight?'Overdue':d<tomorrow?'Today':d<new Date(localMidnight.getTime()+2*day)?'Tomorrow':'This week';
      push(pending,{id:'task:'+(t.id||t.title)+i,title:t.title,detail:[t.listName,t.source].filter(Boolean).join(' · '),meta:tag,href,when:d.getTime(),kind:'pending',tag});
    });
    personalTasks.filter(t=>t.hasTime&&t.dueDate).forEach(t=>{
      const d=new Date(t.dueDate);if(d<now-6*3600000||d>now+2*day)return;
      const dueLabel=d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
      push(pending,{id:'rem:'+t.id,title:t.title,detail:dueLabel+(t.project?' · '+t.project:''),meta:d<=now?'Reminder now':'Reminder',href:'',when:d.getTime(),kind:'pending',tag:'Reminder'});
    });
    (providerData.google.files||[]).forEach(f=>{
      const name=f.name||'File',[label]=kind(f.mimeType),when=f.viewedByMeTime||f.modifiedTime;
      if(DOCUMENT.test(name)||/pdf|doc|contract|invoice|ticket|boarding/i.test(name)||label==='PDF'||label==='Doc')
        push(documents,{id:'file:'+f.id,title:name,detail:label+(when?' · '+ago(new Date(when)):''),meta:'Drive',href:f.webViewLink||'',when:when?new Date(when).getTime():0,kind:'docs',tag:label});
    });
    if(DEMO&&!token){
      if(!travel.length){travel.push(
        {id:'t1',title:'Your train ticket: Berlin → Prague',detail:'Deutsche Bahn',meta:'1 d ago',href:'#',when:Date.now()-day,kind:'travel',tag:'Train'},
        {id:'t2',title:'Boarding pass · LH 1234 Munich–Lisbon',detail:'Lufthansa',meta:'3 d ago',href:'#',when:Date.now()-3*day,kind:'travel',tag:'Flight'},
        {id:'t3',title:'Flight LH 1234',detail:'In 2 days · Munich Airport',meta:'Calendar',href:'#',when:Date.now()+2*day,kind:'travel',tag:'Calendar'});}
      if(!documents.length)documents.push({id:'docdemo',title:'Internship agreement.pdf',detail:'PDF · 4 d ago',meta:'Drive',href:'#',when:Date.now(),kind:'docs',tag:'PDF'});
    }
    const byWhen=(a,b)=>(b.when||0)-(a.when||0)||(a.title||'').localeCompare(b.title||'');
    return {finance,money,travel:travel.sort(byWhen),pending:pending.sort((a,b)=>{const rank={Overdue:0,'Reminder now':1,Today:2,Reminder:3,Tomorrow:4,'Due soon':5,'This week':6,Open:7,Task:8};return (rank[a.tag]??9)-(rank[b.tag]??9)||byWhen(a,b)}),documents:documents.sort(byWhen)};
  }
  const loopsTile=document.createElement('article');loopsTile.className='card loops wide';loopsTile.dataset.widget='loops';
  loopsTile.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 12a5 5 0 1 1 5 5"/><path d="M12 17H5m0 0 3-3m-3 3 3 3"/></svg></span>Open loops <span class="loop-count" id="loop-total"></span></div><span class="tiny loops-hint">Things you started but haven’t finished</span></div><div class="loop-grid" id="loop-grid"></div><div class="loops-foot" id="loops-foot"></div>';
  { const ord=readJSON('daylight-order',[]);const hero=$('.hero');
    if(ord.includes('loops'))ord.forEach(id=>{const c=$('#layout').querySelector(`[data-widget="${id}"]`)||(id==='loops'?loopsTile:null);if(c)$('#layout').append(c)});else if(hero)hero.after(loopsTile);else $('#layout').prepend(loopsTile) }
  TILE_NAMES.loops='Open loops';
  makeTile('finance','finance money-tile',['g-amber','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h2"/></svg>'],'Money','<span class="loop-count" id="finance-count"></span>','<div class="money-tabs" id="money-tabs" role="tablist"><button type="button" data-money="due" aria-pressed="true">To pay</button><button type="button" data-money="review" aria-pressed="false">Needs review</button><button type="button" data-money="paid" aria-pressed="false">Paid</button><button type="button" data-money="refunded" aria-pressed="false">Refunded</button><button type="button" data-money="incoming" aria-pressed="false">Incoming</button><button type="button" data-money="subscription" aria-pressed="false">Subscriptions</button><button type="button" data-money="open" aria-pressed="false">Open Money ›</button></div><div class="money-sec" id="finance-list"><div class="cat-empty">Connect Google to pull subscriptions, bills and payments from Gmail.</div></div><div class="cat-foot" id="finance-foot"></div>');
  makeTile('travel','travel',['g-blue','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 13h18M6 13l2-6h8l2 6M6 17h.01M18 17h.01"/><rect x="3" y="13" width="18" height="5" rx="2"/></svg>'],'Travel','<span class="loop-count" id="travel-count"></span>','<div class="cat-list" id="travel-list"><div class="cat-empty">Flights, trains and bookings from mail and calendar will show up here.</div></div><div class="cat-foot" id="travel-foot"></div>');
  makeTile('pending','pending',['g-rose','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="9"/></svg>'],'Pending tasks','<span class="loop-count" id="pending-count"></span>','<div class="cat-list" id="pending-list"><div class="cat-empty">Due tasks and reminders from Google Tasks and Daylight appear here.</div></div><div class="cat-foot" id="pending-foot"></div>');
  makeTile('documents','documents',['g-blue','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>'],'Documents','<span class="loop-count" id="documents-count"></span>','<div class="cat-list" id="documents-list"><div class="cat-empty">Contracts, PDFs and signed docs from mail and Drive.</div></div><div class="cat-foot" id="documents-foot"></div>');
  let moneyFilter=getLS('daylight-money-filter')||'due';if(!['due','review','paid','refunded','incoming','subscription'].includes(moneyFilter))moneyFilter='due';
  function catHTML(item,tone){
    const body=`<i class="cat-mark" aria-hidden="true"></i><span><b>${esc(item.title)}</b><small>${esc([item.tag,item.detail].filter(Boolean).join(' · '))}</small></span><span class="cat-time">${esc(item.meta||'')}</span>`;
    return item.href?`<a class="cat-item ${tone}" href="${esc(item.href)}" target="_blank" rel="noopener">${body}</a>`:`<div class="cat-item ${tone}">${body}</div>`;
  }
  function moneyHTML(item){
    const initial=(item.title||'?').trim().slice(0,2).toUpperCase();
    const body=`<span class="money-av m-brand" style="--a1:${esc(item.color)};--a2:${esc(item.color)}" aria-hidden="true">${brandLogoHTML(item,initial)}</span><span class="money-copy"><b>${esc(item.title)}</b><small>${esc(item.detail)}</small></span><span class="money-side"><span class="when">${esc(item.meta||'')}</span><span class="tag">${esc(item.tag)}</span></span>`;
    return item.href?`<a class="money-row${item.urgent?' is-urgent':''}" href="${esc(item.href)}" target="_blank" rel="noopener">${body}</a>`:`<div class="money-row${item.urgent?' is-urgent':''}">${body}</div>`;
  }
  // ---- Money: ledger views with evidence, corrections and confirm-before-reminder ----
  const FIN_BUCKET_LABEL={outstanding:'To pay now',upcoming:'Upcoming',review:'Needs review',paid:'Paid',refunded:'Refunded',incoming:'Incoming',info:'Other financial mail',dismissed:'Dismissed'};
  function finWhenLine(r){
    const d=x=>{const [y,m,dd]=x.split('-').map(Number);return new Date(y,m-1,dd).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})};
    if(r.dueDate)return (r.overdue?'Was due ':'Due ')+d(r.dueDate)+(r.dueYearInferred?' (year assumed)':'');
    if(r.renewalDate)return 'Renews '+d(r.renewalDate);
    if(r.paymentDate)return 'Paid '+d(r.paymentDate);
    if(r.category==='unpaid_bill'&&r.status==='unpaid')return 'No due date in the email';
    return r.receivedAt?'Email '+ago(new Date(r.receivedAt)):'';
  }
  function finRowHTML(r){
    const F=window.DaylightFinance;
    const amt=r.amount?F.fmtAmount(r.amount):'—';
    const flags=[r.suggestion&&!finConfirmed()[r.suggestion.key]?'<span class="fin-flag sug">Reminder suggested</span>':'',r.possiblyPaid?'<span class="fin-flag">Possibly paid</span>':'',r.corrected?'<span class="fin-flag">Corrected</span>':'',r.fromHistory?'<span class="fin-flag">Earlier email</span>':'',r.sourceDeleted?'<span class="fin-flag">Email deleted in Gmail · record kept</span>':''].join('');
    return `<button type="button" class="fin-row b-${esc(r.bucket)}" data-fin-open="${esc(r.key)}"><span class="fin-main"><b>${esc(r.merchant||'Unknown')}</b><small>${esc(r.label)} · ${esc(finWhenLine(r))}</small>${flags?`<span class="fin-flags">${flags}</span>`:''}</span><span class="fin-side"><b class="${r.direction==='incoming'?'in':''}">${r.direction==='incoming'&&r.amount?'+':''}${esc(amt)}</b><small>${Math.round((r.confidence||0)*100)}% sure</small></span></button>`;
  }
  function finRecordsFor(filter,money){
    const L=money.ledger||{};
    if(filter==='due')return [...(L.outstanding||[]),...(L.upcoming||[]).filter(r=>r.category!=='subscription_renewal')];
    if(filter==='subscription')return (loopsData?.finance?.records||[]).filter(r=>r.category==='subscription_renewal'&&r.bucket!=='dismissed');
    return L[filter]||[];
  }
  function renderMoney(){
    const list=$('#finance-list'),count=$('#finance-count'),foot=$('#finance-foot'),tabs=$('#money-tabs');
    if(!list)return;
    if(tabs)$$('#money-tabs [data-money]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.money===moneyFilter?'true':'false'));
    if(!token&&!microsoftAccount&&!DEMO){list.innerHTML='<div class="cat-empty">Connect Google to find bills, payments and refunds in Gmail.</div>';if(count)count.textContent='';if(foot)foot.textContent='';return}
    if(!loopsData&&token){list.innerHTML='<div class="cat-empty">Checking your email for bills and payments…</div>';return}
    const money=computeMoney();
    if(!money.ledger){list.innerHTML='<div class="cat-empty">Financial check unavailable in this browser.</div>';return}
    const max=+(wset('finance').max||8);
    const recs=finRecordsFor(moneyFilter,money);
    if(count)count.textContent=(money.ledger.outstanding||[]).length||'';
    const empty={due:'Nothing to pay: no unpaid bill with a due date was found.',review:'Nothing needs your review.',paid:'No payments or receipts found.',refunded:'No refunds found.',incoming:'No incoming money found.',subscription:'No subscriptions found.'}[moneyFilter];
    list.innerHTML=recs.length?recs.slice(0,max).map(finRowHTML).join(''):`<div class="cat-empty">${esc(empty)}</div>`;
    if(foot)foot.textContent=(recs.length>max?`+${recs.length-max} more · `:'')+(DEMO&&!token?'Preview sample':'Only emails with an unpaid amount and a written due date count as “to pay”.');
  }
  $('#money-tabs')?.addEventListener('click',e=>{const b=e.target.closest('[data-money]');if(!b)return;if(b.dataset.money==='open'){openMoneySheet();return}moneyFilter=b.dataset.money;setLS('daylight-money-filter',moneyFilter);renderMoney();fitAll?.()});
  $('#finance-list')?.addEventListener('click',e=>{const b=e.target.closest('[data-fin-open]');if(b)openMoneySheet(b.dataset.finOpen)});
  // ---- v2 review queue: emails the rules could not decide confidently. Your choice also teaches the sender's domain. ----
  const REVIEW_CATS=[['bill','Bill to pay'],['payment','Payment'],['refund','Refund'],['travel','Travel'],['food','Food / restaurant'],['subscription','Subscription'],['receipt','Receipt'],['document','Document'],['promotion','Promotion'],['newsletter','Newsletter'],['personal','Personal / other']];
  async function openReviewSheet(){
    ensureMoneySheet();
    let el=$('#rv-sheet');
    if(!el){
      el=document.createElement('div');el.id='rv-sheet';el.className='fin-sheet';el.hidden=true;el.setAttribute('role','dialog');el.setAttribute('aria-label','Quick check');
      el.innerHTML='<div class="fin-panel"><div class="fin-top"><h3>Quick check</h3><button type="button" class="fin-x" data-rv-close aria-label="Close">×</button></div><div id="rv-body"></div></div>';
      document.body.append(el);
      el.addEventListener('click',async e=>{
        if(e.target.id==='rv-sheet'||e.target.closest('[data-rv-close]')){el.hidden=true;return}
        const b=e.target.closest('[data-rv-pick]');if(!b)return;
        const rec=await getMailV2().pipe.resolveReview(v2AccountKey(),b.dataset.rvId,b.dataset.rvPick);
        toast(rec?`Saved · emails from ${rec.fromDomain||'this sender'} will be sorted this way`:'Could not save');
        paintReviewSheet();
      });
    }
    el.hidden=false;paintReviewSheet();
  }
  async function paintReviewSheet(){
    const body=$('#rv-body');if(!body)return;
    if(!v2Enabled()){body.innerHTML='<p class="fin-note">Nothing to check.</p>';return}
    const rows=(await getMailV2().cache.all(v2AccountKey())).filter(r=>r.status==='review').sort((a,b)=>b.internalDate-a.internalDate).slice(0,30);
    const label=c=>(REVIEW_CATS.find(x=>x[0]===c)||[c,c])[1];
    body.innerHTML=`<p class="fin-note">Daylight was not sure about these emails. Pick what each one is — Daylight remembers the sender's domain (only the domain and your choice, never the email). Nothing is paid, deleted or created from here.</p>
      ${rows.length?rows.map(r=>`<div class="fin-detail"><b>${esc(r.subject||'(No subject)')}</b><br><small>${esc((r.from||'').replace(/<.*>/,'').trim())} · ${esc(new Date(r.internalDate).toLocaleDateString())}</small>
        <div class="fin-ev">Best guess: ${esc(label(r.category))} (${Math.round((r.confidence||0)*100)}% sure) — ${esc(r.ruleReason||'')}</div>
        <div class="fin-actions">${REVIEW_CATS.map(([k,l])=>`<button type="button" class="${k===r.category?'primary':''}" data-rv-id="${esc(r.messageId)}" data-rv-pick="${esc(k)}">${esc(l)}</button>`).join('')}</div></div>`).join(''):'<p class="fin-note">All clear — nothing needs a check.</p>'}`;
  }
  window.DaylightReviewUI={open:openReviewSheet};
  function ensureMoneySheet(){
    let el=$('#fin-sheet');if(el)return el;
    const st=document.createElement('style');st.textContent=`
      .fin-sheet{position:fixed;inset:0;z-index:80;display:flex;justify-content:center;align-items:flex-end;background:rgba(10,14,22,.45)}
      .fin-sheet[hidden]{display:none}
      .fin-panel{background:var(--bg,#fff);color:var(--ink,#172033);width:min(720px,100%);max-height:92vh;overflow:auto;border-radius:20px 20px 0 0;padding:14px 16px 28px;box-shadow:0 -10px 40px rgba(0,0,0,.25)}
      @media(min-width:760px){.fin-sheet{align-items:center}.fin-panel{border-radius:20px}}
      .fin-top{display:flex;align-items:center;justify-content:space-between;gap:10px;position:sticky;top:-14px;background:inherit;padding:6px 0 10px;z-index:1}
      .fin-top h3{margin:0;font:700 18px var(--font,system-ui)}
      .fin-x{border:0;background:var(--card2,#eef2f7);border-radius:999px;width:34px;height:34px;font-size:18px;cursor:pointer;color:inherit}
      .fin-note{font-size:12.5px;color:var(--muted,#5f6b80);margin:0 0 10px;line-height:1.45}
      .fin-sec h4{margin:14px 0 6px;font:650 13px var(--font,system-ui);color:var(--muted,#5f6b80);display:flex;justify-content:space-between}
      .fin-row{display:flex;width:100%;text-align:left;gap:10px;justify-content:space-between;align-items:center;border:1px solid var(--line,#e1e7f0);background:var(--card,#fff);color:inherit;border-radius:14px;padding:10px 12px;margin:6px 0;cursor:pointer;font:inherit}
      .fin-row.b-outstanding{border-color:#e0627a}.fin-row.b-review{border-style:dashed}
      .fin-main{display:grid;gap:2px;min-width:0}.fin-main b{font-weight:650}.fin-main small,.fin-side small{color:var(--muted,#5f6b80);font-size:12px}
      .fin-side{display:grid;text-align:right;gap:2px;white-space:nowrap}.fin-side b.in{color:#2f9e6e}
      .fin-flags{display:flex;gap:4px;flex-wrap:wrap}.fin-flag{font-size:11px;border-radius:999px;padding:1px 7px;background:var(--card2,#eef2f7)}.fin-flag.sug{background:#fff3d6;color:#8a5a00}
      .fin-detail{border:1px solid var(--line,#e1e7f0);border-radius:16px;padding:12px;margin:8px 0 12px;background:var(--card,#fff)}
      .fin-detail dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:8px 0;font-size:13px}.fin-detail dt{color:var(--muted,#5f6b80)}.fin-detail dd{margin:0}
      .fin-ev{font-size:12.5px;margin:4px 0;padding:6px 8px;border-radius:10px;background:var(--card2,#eef2f7)}
      .fin-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
      .fin-actions button,.fin-actions a,.fin-actions select{border:1px solid var(--line,#e1e7f0);background:var(--card2,#eef2f7);color:inherit;border-radius:999px;padding:7px 12px;font:600 12.5px var(--font,system-ui);cursor:pointer;text-decoration:none}
      .fin-actions .primary{background:var(--accent,#4c6fdb);color:#fff;border-color:transparent}
      .fin-warn{font-size:12.5px;padding:8px 10px;border-radius:10px;background:#fff3d6;color:#6b4a00;margin:6px 0}`;
    document.head.append(st);
    el=document.createElement('div');el.id='fin-sheet';el.className='fin-sheet';el.hidden=true;el.setAttribute('role','dialog');el.setAttribute('aria-label','Money');
    el.innerHTML='<div class="fin-panel"><div class="fin-top"><h3>Money</h3><button type="button" class="fin-x" data-fin-close aria-label="Close">×</button></div><div id="fin-body"></div></div>';
    document.body.append(el);
    el.addEventListener('click',onMoneySheetClick);el.addEventListener('change',onMoneySheetChange);
    return el;
  }
  let finOpenKey=null;
  function openMoneySheet(key){ensureMoneySheet().hidden=false;finOpenKey=key||null;paintMoneySheet();if(key)requestAnimationFrame(()=>document.querySelector(`#fin-sheet [data-fin-detail="${CSS.escape(key)}"]`)?.scrollIntoView({block:'center'}))}
  function closeMoneySheet(){const el=$('#fin-sheet');if(el)el.hidden=true;finOpenKey=null}
  function finDetailHTML(r){
    const F=window.DaylightFinance;
    const conf=finConfirmed();
    const rows=[['What it is',r.label],['Status',r.status||'—'],['Direction',r.direction||'unknown'],['Amount',r.amount?F.fmtAmount(r.amount):'not found in the email'],['Due date',r.dueDate?r.dueDate+(r.dueDateRaw?` (“${r.dueDateRaw}”)`:'')+(r.dueYearInferred?' · year assumed':''):'not written in the email'],
      ['Invoice no.',r.invoiceNumber||'—'],['Reference',r.reference||r.orderId||'—'],['Paid on',r.paymentDate||'—'],['Renews on',r.renewalDate||'—'],['Confidence',Math.round((r.confidence||0)*100)+'% · judged from '+(r.judgedFrom||'email')],['Emails',String((r.mailIds||[]).length)]];
    const ev=(r.evidence||[]).map(e=>`<div class="fin-ev">${e.signal==='user'?'<b>You:</b> ':''}“${esc(e.text)}”</div>`).join('')||'<div class="fin-ev">No specific wording found.</div>';
    const warn=[r.obligationReason?`Not counted as “to pay”: ${r.obligationReason}.`:'',...(r.conflicts||[]).map(c=>'Uncertain: '+c+'.'),r.possiblyPaid?'This invoice may already be paid (same sender and amount, later payment email). Please confirm.':'',r.linkedPaid?.strength==='confirmed'?`Linked to its payment (${r.linkedPaid.by}).`:''].filter(Boolean).map(w=>`<div class="fin-warn">${esc(w)}</div>`).join('');
    const opts=F.CATEGORIES.map(c=>`<option value="${c}"${c===r.category?' selected':''}>${esc(F.LABELS[c])}</option>`).join('');
    const sug=r.suggestion&&!conf[r.suggestion.key]&&!r.dismissed?`<div class="fin-warn"><b>Suggested reminder:</b> ${esc(r.suggestion.title)} on ${esc(r.suggestion.dueDate)}. ${esc(r.suggestion.why)}. Nothing is created until you confirm.</div>`:'';
    const mail=r.mailIds?.[r.mailIds.length-1];
    return `<div class="fin-detail" data-fin-detail="${esc(r.key)}"><b>${esc(r.merchant||'Unknown')}</b> · <small>${esc(r.subject||'')}</small>${warn}${sug}<dl>${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div><small>Why Daylight thinks so:</small>${ev}</div>
      <div class="fin-actions">${mail?`<a href="${esc(gmailLink(mail))}" target="_blank" rel="noopener">Open email</a>`:''}${sug?`<button type="button" class="primary" data-fin-confirm="${esc(r.key)}">Create reminder</button>`:''}
      <label><select data-fin-correct="${esc(r.mailIds?.[0]||'')}" aria-label="Correct the category">${opts}</select></label>
      <button type="button" data-fin-notfin="${esc(r.mailIds?.[0]||'')}">Not financial</button>
      ${r.dismissed?`<button type="button" data-fin-restore="${esc(r.mailIds?.[0]||'')}">Restore</button>`:`<button type="button" data-fin-dismiss="${esc(r.mailIds?.[0]||'')}">Dismiss</button>`}</div></div>`;
  }
  function paintMoneySheet(){
    const body=$('#fin-body');if(!body)return;
    const money=computeMoney(),L=money.ledger;
    if(!L){body.innerHTML='<p class="fin-note">Connect Google to check your email for bills and payments.</p>';return}
    const sec=(k,recs)=>recs&&recs.length?`<div class="fin-sec"><h4><span>${esc(FIN_BUCKET_LABEL[k])}</span><span>${recs.length}</span></h4>${recs.map(r=>finOpenKey===r.key?finDetailHTML(r):finRowHTML(r)).join('')}</div>`:'';
    const legacy=money.legacy||[];
    const any=['outstanding','upcoming','review','paid','refunded','incoming','info','dismissed'].some(k=>(L[k]||[]).length);
    body.innerHTML=`<p class="fin-note">Daylight only treats something as <b>to pay</b> when the email states an unpaid amount and a due date. Everything else is information. Tap a line to see the evidence, correct it or dismiss it. Reminders are created only when you confirm them.</p>
      ${sec('outstanding',L.outstanding)}${sec('upcoming',L.upcoming)}${sec('review',L.review)}${sec('paid',L.paid)}${sec('refunded',L.refunded)}${sec('incoming',L.incoming)}${sec('info',L.info)}${sec('dismissed',L.dismissed)}
      ${legacy.length?`<div class="fin-sec"><h4><span>Old automatic payment tasks (unconfirmed)</span><span>${legacy.length}</span></h4><p class="fin-note">An earlier version of Daylight created these tasks automatically from emails, including receipts, refunds and promotions. They are no longer counted as payments. They stay in your task list until you decide what to do with them.</p>${legacy.map(i=>`<div class="fin-row"><span class="fin-main"><b>${esc(i.subject||i.title)}</b><small>${esc(i.meta)}</small></span><span class="fin-side"><small>Unconfirmed</small></span></div>`).join('')}</div>`:''}
      ${!any&&!legacy.length?'<p class="fin-note">No financial emails found in the recent mail Daylight checked.</p>':''}`;
  }
  function onMoneySheetClick(e){
    if(e.target.id==='fin-sheet'||e.target.closest('[data-fin-close]')){closeMoneySheet();return}
    const o=e.target.closest('[data-fin-open]');if(o){finOpenKey=finOpenKey===o.dataset.finOpen?null:o.dataset.finOpen;paintMoneySheet();return}
    const c=e.target.closest('[data-fin-confirm]');if(c){const t=confirmFinanceReminder(c.dataset.finConfirm);if(t){toast('Reminder created · '+t.title,{type:'ok'});renderTasks();renderLoops()}syncPaymentTaskSuggestions();paintMoneySheet();renderMoney();return}
    const nf=e.target.closest('[data-fin-notfin]');if(nf&&nf.dataset.finNotfin){setFinanceCorrection(nf.dataset.finNotfin,{category:'not_financial'});toast('Marked as not financial');paintMoneySheet();return}
    const d=e.target.closest('[data-fin-dismiss]');if(d&&d.dataset.finDismiss){setFinanceCorrection(d.dataset.finDismiss,{dismissed:true});toast('Dismissed · it will not be suggested again');paintMoneySheet();return}
    const r=e.target.closest('[data-fin-restore]');if(r&&r.dataset.finRestore){setFinanceCorrection(r.dataset.finRestore,{dismissed:false});paintMoneySheet();return}
  }
  function onMoneySheetChange(e){
    const sel=e.target.closest('[data-fin-correct]');if(!sel||!sel.dataset.finCorrect)return;
    setFinanceCorrection(sel.dataset.finCorrect,{category:sel.value});toast('Corrected to '+(window.DaylightFinance.LABELS[sel.value]||sel.value));
    paintMoneySheet();
  }
  window.DaylightMoneyUI={open:openMoneySheet,close:closeMoneySheet}; // used by tests and the drawer
  document.addEventListener('click',e=>{const b=e.target.closest?.('[data-fin-open-sheet]');if(b){e.preventDefault();openMoneySheet(b.dataset.finOpenSheet)}});
  function renderCategory(key,tone,emptyConnected,emptyOffline){
    const cats=computeCategories(),items=cats[key]||[],list=$(`#${key}-list`),count=$(`#${key}-count`),foot=$(`#${key}-foot`);
    if(!list)return;
    if(count)count.textContent=items.length||'';
    if(!token&&!microsoftAccount&&!DEMO){list.innerHTML=`<div class="cat-empty">${emptyOffline}</div>`;if(foot)foot.textContent='';return}
    if(!loopsData&&token){list.innerHTML='<div class="cat-empty">Sorting your inbox…</div>';return}
    const max=+(wset(key).max||5);
    list.innerHTML=items.length?items.slice(0,max).map(i=>catHTML(i,tone)).join(''):`<div class="cat-empty">${emptyConnected}</div>`;
    if(foot)foot.textContent=items.length>max?`+${items.length-max} more in this category`:(DEMO&&!token?'Preview sample · connect Google for live mail':'');
  }
  function renderCategories(){
    renderMoney();
    renderCategory('travel','t-travel','No trips found in recent mail or the next two weeks of calendar.','Flights, trains and bookings from mail and calendar will show up here.');
    renderCategory('pending','t-pending','Nothing due in the next week.','Due tasks and reminders from Google Tasks and Daylight appear here.');
    renderCategory('documents','t-docs','No matching documents right now.','Contracts, PDFs and signed docs from mail and Drive.');
  }
  function renderLoops(){
    const grid=$('#loop-grid');if(!grid)return;const WORK=['reply','followup','prepare','overdue','deadline'],loops=computeLoops().filter(l=>wset('loops').include!=='Work only'||WORK.includes(l.type));
    $('#loop-total').textContent=loops.length?loops.length:'';if($('#loop-count'))$('#loop-count').textContent=(token||DEMO)?loops.length:'—';
    if(!token&&!microsoftAccount&&!DEMO&&!loops.length){grid.innerHTML='<div class="empty">Connect Google to find emails waiting for a reply, meetings to prepare for and overdue tasks.</div>';$('#loops-foot').innerHTML='';renderSummary(null);renderCategories();return}
    if(!loopsData&&token){grid.innerHTML='<div class="empty">Looking through your inbox, calendar and tasks…</div>';return}
    const lmax=+(wset('loops').max||6),shown=loopsShowAll?loops:loops.slice(0,lmax);
    grid.classList.toggle('as-list',(wset('loops').view||'List')==='List');
    const paint=typeof loopHTML==='function'?loopHTML:(l=>{const t=LOOP_TYPES[l.type]||LOOP_TYPES.reply;return `<div class="arow ${t.cls}" data-loop="${esc(l.id)}"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span><div class="arow-main"><div class="arow-top"><b>${esc(l.title)}</b><span class="arow-src">${esc(l.meta||'')}</span></div><div class="arow-detail">${esc(l.detail||'')}</div></div></div>`});
    try{grid.innerHTML=loops.length?shown.map(paint).join(''):'<div class="empty all-clear">No open loops right now. You’re all caught up.</div>'}
    catch(e){console.warn('loops render',e);grid.innerHTML=loops.length?shown.map(l=>`<div class="arow ${LOOP_TYPES[l.type]?.cls||''}"><div class="arow-main"><b>${esc(l.title)}</b><div class="arow-detail">${esc(l.detail||'')}</div></div></div>`).join(''):'<div class="empty all-clear">No open loops right now. You’re all caught up.</div>'}
    $('#loops-foot').innerHTML=loops.length>lmax?`<button class="connect" type="button" id="loops-more">${loopsShowAll?'Show fewer':`Show all ${loops.length}`}</button>`:'';
    if($('#loops-more'))$('#loops-more').onclick=()=>{loopsShowAll=!loopsShowAll;renderLoops()};
    renderSummary(loops.length);renderCategories();
  }
  function onLoopListClick(e){
    const act=e.target.closest('[data-act]');
    if(act){const row=act.closest('[data-loop]');if(!row)return;e.preventDefault();e.stopPropagation();const id=row.dataset.loop,s=loopState();
      s[id]=act.dataset.act==='done'?{done:true,t:Date.now()}:{snooze:Date.now()+86400000,t:Date.now()};saveLoopState(s);renderLoops();
      toast(act.dataset.act==='done'?'Marked as done':'Snoozed until tomorrow');return}
    if(e.target.closest('a[href]'))return;
    const openBtn=e.target.closest('[data-open-loop]');
    const row=e.target.closest('[data-loop]');
    const id=openBtn?.dataset.openLoop||row?.dataset.loop;if(!id)return;
    e.preventDefault();openLoopSheet(id);
  }
  function onLoopListKey(e){if(e.key!=='Enter'&&e.key!==' ')return;const row=e.target.closest('[data-loop]');if(!row||e.target.closest('button,a'))return;e.preventDefault();openLoopSheet(row.dataset.loop)}
  $('#loop-grid').addEventListener('click',onLoopListClick);
  $('#loop-grid').addEventListener('keydown',onLoopListKey);
  // ---- Greeting summary + Up next ----
  function renderSummary(loopCount){
    const el=$('#day-summary');if(!el)return;const {timed}=todayEvents(),now=new Date();
    const left=timed.filter(e=>e.end>now).length;
    const parts=[];if(providerData.google.events||providerData.microsoft.events)parts.push(left?`${left} event${left>1?'s':''} left today`:'No more events today');
    if(loopCount!=null&&token)parts.push(loopCount?`${loopCount} open loop${loopCount>1?'s':''}`:'nothing waiting on you');
    el.textContent=parts.join(' · ');
  }
  function renderUpNext(){
    const box=$('#up-next');if(!box)return;const {timed,connected}=todayEvents(),now=new Date();
    const next=timed.find(e=>e.end>now);
    if(!connected){box.hidden=true;return}box.hidden=false;
    if(!next){box.innerHTML='<div class="eyebrow">Up next</div><div class="un-title">Nothing else today</div>';return}
    const mins=Math.round((next.start-now)/60000);
    box.innerHTML=`<div class="eyebrow">${mins<=0?'Happening now':'Up next'}</div><div class="un-title">${esc(next.title)}</div><div class="un-time">${hm(next.start)}–${hm(next.end)}${mins>0?` · in ${mins<60?mins+' min':Math.floor(mins/60)+' h '+(mins%60?mins%60+' min':'')}`:''}</div>`;
  }
  // ---- Focus timer: adjust minutes ----
  var focusOverride=0;
  { const f=$('.focus .minutes');if(f){const wrap=document.createElement('div');wrap.className='focus-adjust';wrap.innerHTML='<button type="button" class="adj" id="focus-minus" aria-label="Five minutes less">−</button><button type="button" class="adj" id="focus-plus" aria-label="Five minutes more">+</button>';f.after(wrap);
    const step=d=>{const btn=$('#focus-start');if(btn.dataset.running==='1')return;const cur=focusOverride||+btn.dataset.minutes||25;focusOverride=Math.min(120,Math.max(5,cur+d));btn.dataset.minutes=focusOverride;f.innerHTML=`${focusOverride}<span style="font-size:17px;letter-spacing:0"> min</span>`;btn.textContent=`Start ${focusOverride}-min focus`;btn.disabled=false};
    $('#focus-minus').onclick=()=>step(-5);$('#focus-plus').onclick=()=>step(5)} }
  // ---- Menu (hamburger) ----
  const drawer=$('#drawer'),scrim=$('#drawer-scrim');
  let menuTimer=0;
  const openMenu=o=>{
    if(!drawer)return;
    clearTimeout(menuTimer);
    const want=!!o;
    $('#menu-btn').setAttribute('aria-expanded',String(want));
    if(want){
      drawer.hidden=false;if(scrim)scrim.hidden=false;
      setAccountMenu(false);
      const tc=$('#theme-choices');if(tc){tc.hidden=true;tc.classList.remove('show')}$('#theme')?.setAttribute('aria-expanded','false');
      renderDrawerAccount();
      requestAnimationFrame(()=>{
        document.body.classList.add('menu-open');
        (drawer.querySelector('.menu-item.active')||drawer.querySelector('.menu-item'))?.focus();
      });
    }else{
      document.body.classList.remove('menu-open');
      const hide=()=>{drawer.hidden=true;if(scrim)scrim.hidden=true};
      if(window.DaylightNav?.reduced?.())hide();
      else menuTimer=setTimeout(hide,300);
    }
  };
  $('#menu-btn')?.addEventListener('click',()=>openMenu(!document.body.classList.contains('menu-open')));
  $('#drawer-close')?.addEventListener('click',()=>openMenu(false));scrim?.addEventListener('click',()=>openMenu(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(document.querySelector('.wstack.has-sel')){try{walletStack().exit()}catch{}return}if(window.DaylightNav?.anyOpen()){window.DaylightNav.back();return}openMenu(false);$('#overlay').classList.remove('show')}});
  ['#connections','#customize'].forEach(s=>$(s)?.addEventListener('click',()=>openMenu(false)));
  function currentPlan(){
    const stored=(getLS('daylight-plan')||'').toLowerCase();
    if(stored==='premium'||stored==='free')return stored;
    return 'free';
  }
  function connectedCount(){return [token,microsoftAccount].filter(Boolean).length}
  function liveAccount(){return Boolean(token||microsoftAccount)}
  function isDemoSession(){return DEMO&&!liveAccount()}
  function setAccountMenu(open){
    const btn=$('#drawer-account'),menu=$('#da-menu');if(!btn||!menu)return;
    btn.setAttribute('aria-expanded',String(!!open));
    menu.hidden=!open;menu.classList.toggle('show',!!open);
  }
  function renderDrawerAccount(){
    const el=$('#drawer-account');if(!el)return;
    const demo=isDemoSession(),p=(demo||!liveAccount())?{}:readProfile(),plan=currentPlan();
    const name=demo?'Demo preview':(p.name||p.email||'Not connected');
    const mail=demo?'Sample data · not a live account':(p.email||(liveAccount()?'Connected':'Open Connections to sign in'));
    const ini=esc(((p.name||p.email||'?')[0]||'?').toUpperCase());
    el.innerHTML=`<div class="da-avatar">${!demo&&p.picture?`<img src="${esc(p.picture)}" alt="" referrerpolicy="no-referrer">`:ini}</div><div class="da-copy"><b>${esc(name)}</b><span class="da-mail">${esc(mail)}</span><div class="da-meta">${demo?`<span class="da-badge is-demo">Demo</span>`:`<span class="da-plan">${plan==='premium'?'Premium':'Free plan'}</span>`}</div></div><span class="da-chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m7 10 5 5 5-5"/></svg></span>`;
    const n=connectedCount(),note=$('#conn-state');
    if(note)note.textContent=demo?'Demo':n?`${n} active`:'';
    $('#connections')?.setAttribute('aria-label','Connections');
    const badge=$('#drawer-inbox-count');
    if(badge){
      let count=0;
      try{count=(providerData.google.mails||[]).length+(providerData.microsoft.mails||[]).length}catch{}
      badge.hidden=!count;badge.textContent=count>99?'99+':String(count);
    }
    renderDrawerSync();markDrawerNav();
  }
  function renderDrawerSync(){
    const box=$('#drawer-sync'),title=$('#drawer-sync-title'),meta=$('#drawer-sync-meta'),retry=$('#refresh');
    if(!box||!title||!meta)return;
    const providers=[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean);
    const demo=isDemoSession();
    box.classList.toggle('is-err',Boolean(lastSyncErr)&&!syncBusy);
    if(retry)retry.hidden=!(liveAccount()||demo||lastSyncErr);
    if(syncBusy){title.textContent=providers.length?`${providers.join(' + ')} · syncing`:(demo?'Demo · updating':'Syncing');meta.textContent='Refreshing connected data…';return}
    const lastOkTxt=lastSyncOk?`Last full sync ${new Date(lastSyncOk).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`:'No full sync yet';
    if(lastSyncErr){title.textContent=lastSyncPartial?'Partial sync':'Sync needs attention';meta.textContent=`${lastSyncErr} · ${lastOkTxt}`;return}
    if(demo){title.textContent='Demo sample';meta.textContent=lastSyncOk?`Last updated ${new Date(lastSyncOk).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:'Preview data on this device · not a live account.';return}
    if(!providers.length){title.textContent='Not connected';meta.textContent='Connect Google to sync mail, calendar and tasks.';return}
    title.textContent=providers.join(' + ');
    meta.textContent=lastSyncOk?`Last successful sync ${new Date(lastSyncOk).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:'Connected · waiting for the first successful sync.';
  }
  function markDrawerNav(){
    const mobile=typeof mq==='undefined'?matchMedia('(max-width:680px)').matches:mq.matches;
    const tab=typeof mTab==='undefined'?'home':mTab;
    let dest='overview';
    if(mobile){
      if(tab==='inbox')dest=mInboxFilter==='subscriptions'?'subscriptions':(mInboxFilter==='tickets'?'travel':'inbox');
      else if(tab==='wallet')dest='wallet';
      else if(tab==='assistant')dest='calendar';
      else dest=document.body.classList.contains('m-widgets')?'overview':'overview';
    }
    $$('#drawer-workspace [data-ws]').forEach(b=>b.classList.toggle('active',b.dataset.ws===dest));
  }
  function goWidget(id){
    const el=typeof cardOf==='function'?cardOf(id):document.querySelector(`.card[data-widget="${id}"]`);
    if(el){el.scrollIntoView({behavior:'smooth',block:'center'});return true}
    toast('Add this widget from Widgets & layout');return false;
  }
  function goWorkspace(dest){
    const mobile=typeof mq==='undefined'?matchMedia('(max-width:680px)').matches:mq.matches;
    document.body.classList.remove('m-widgets');
    if(dest==='overview'){if(mobile)setTab('home');else goWidget('summary')||goWidget('overview')}
    else if(dest==='inbox'){if(mobile){mInboxFilter='all';setLS('daylight-inbox-filter','all');setTab('inbox');if(typeof renderInbox==='function')renderInbox({animate:false})}else goWidget('mail')}
    else if(dest==='calendar'){if(mobile)setTab('assistant');else goWidget('calendar')}
    else if(dest==='tasks'){if(mobile){document.body.classList.add('m-widgets');setTimeout(()=>dispatchEvent(new Event('resize')),60);goWidget('tasks')}else goWidget('tasks')}
    else if(dest==='loops'){if(mobile&&typeof openLoopsPop==='function')openLoopsPop();else goWidget('loops')}
    else if(dest==='travel'){if(mobile){mInboxFilter='tickets';setLS('daylight-inbox-filter','tickets');setTab('inbox');if(typeof renderInbox==='function')renderInbox({animate:false})}else goWidget('travel')}
    else if(dest==='wallet'){if(mobile)setTab('wallet');else goWidget('travel')}
    else if(dest==='money'){openMenu(false);openMoneySheet();return}
    else if(dest==='review'){openMenu(false);openReviewSheet();return}
    else if(dest==='subscriptions'){if(mobile){mInboxFilter='subscriptions';setLS('daylight-inbox-filter','subscriptions');setTab('inbox');if(typeof renderInbox==='function')renderInbox({animate:false})}else goWidget('finance')}
    markDrawerNav();openMenu(false);
  }
  function openPlanInfo(){
    const plan=currentPlan(),demo=isDemoSession();
    $('#overlay').innerHTML=`<div class="modal connections-modal" role="dialog" aria-label="Daylight plan"><div class="modal-top"><h3>Daylight plan</h3><button class="modal-x" id="close-modal" aria-label="Close">×</button></div>
      <p>${demo?'You are in demo preview.':plan==='premium'?'This device is marked Premium.':'You are on the Free plan.'}</p>
      <p>Premium will unlock more integrations and advanced personal intelligence. Checkout and prices are not available yet.</p>
      <p class="hint">Gmail is the primary connection on Free. Other providers in Connections show their real availability.</p>
      <div class="modalfoot"><button class="close" id="close-plan" type="button">Got it</button></div></div>`;
    requestAnimationFrame(()=>$('#overlay').classList.add('show'));
    const close=()=>$('#overlay').classList.remove('show');
    $('#close-modal')?.addEventListener('click',close);$('#close-plan')?.addEventListener('click',close);
  }
  $('#drawer-account')?.addEventListener('click',()=>setAccountMenu($('#drawer-account')?.getAttribute('aria-expanded')!=='true'));
  $('#da-menu')?.addEventListener('click',e=>{
    const act=e.target.closest('[data-da]')?.dataset.da;if(!act)return;
    setAccountMenu(false);
    if(act==='details'){
      const demo=isDemoSession(),p=demo?{}:readProfile();
      toast(demo?'Demo preview · not a live account':(p.name||p.email)?`${p.name||''}${p.email?' · '+p.email:''}`:'Not connected');
    }
    else if(act==='accounts'){openMenu(false);connectDialog()}
    else if(act==='plan'){openMenu(false);openPlanInfo()}
    else if(act==='signout'){
      openMenu(false);
      if(!liveAccount()){toast(isDemoSession()?'Demo has no account to sign out of':'Connect an app first');return}
      if(token)disconnectGoogle();
      if(microsoftAccount){(async()=>{try{await microsoftApp?.clearCache({account:microsoftAccount})}catch{}microsoftAccount=null;microsoftApp=null;providerData.microsoft={events:null,mails:null,tasks:null};renderAll();renderDrawerAccount();toast('Signed out')})()}
    }
  });
  $('#drawer-workspace')?.addEventListener('click',e=>{const b=e.target.closest('[data-ws]');if(b)goWorkspace(b.dataset.ws)});
  $('#explore-premium')?.addEventListener('click',()=>{openMenu(false);openPlanInfo()});
  $('#drawer-settings')?.addEventListener('click',()=>{
    const p=$('#drawer-settings-panel');if(!p)return;const on=p.hidden;p.hidden=!on;p.classList.toggle('show',on);
  });
  $('#drawer-settings-conn')?.addEventListener('click',()=>{openMenu(false);connectDialog()});
  // ---- Theme: follow the system unless you choose ----
  const darkMq=matchMedia('(prefers-color-scheme: dark)');
  const themePref=()=>getLS('daylight-theme')||'system';
  const applyThemePref=pref=>{
    const mode=pref||themePref();
    if(mode==='light'||mode==='dark')setLS('daylight-theme',mode);
    else setLS('daylight-theme','');
    const dark=mode==='dark'||(mode!=='light'&&darkMq.matches);
    document.body.classList.toggle('dark',dark);
    syncTheme();
  };
  const syncTheme=()=>{
    const dark=document.body.classList.contains('dark');
    const tog=$('#theme-toggle');
    if(tog){tog.setAttribute('aria-checked',dark?'true':'false');tog.setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode')}
    document.querySelector('meta[name=theme-color]')?.setAttribute('content',dark?'#0d0e12':'#F3F5F9');
  };
  if(!getLS('daylight-theme'))document.body.classList.toggle('dark',darkMq.matches);
  darkMq.addEventListener?.('change',e=>{if(!getLS('daylight-theme')){document.body.classList.toggle('dark',e.matches);syncTheme()}});
  $('#theme-toggle')?.addEventListener('click',e=>{
    e.stopPropagation();
    applyThemePref(document.body.classList.contains('dark')?'light':'dark');
  });
  syncTheme();
  // ---- Notification bell (slide-in from right + source logos) ----
  const bellIcon={meeting:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10h18"/>'};
  let notifClosing=false;
  function bellBrandFor(item){
    if(item.brand)return item.brand;
    if(item.loop)return loopSourceBrand(item.loop);
    if(item.kind==='meeting')return {domain:'google.com',title:'Calendar',color:brandColor('Calendar')};
    if(item.kind==='reminder')return {domain:'',title:'Daylight',color:brandColor('Daylight')};
    return {domain:'',title:item.title||'Daylight',color:brandColor(item.title||'Daylight')};
  }
  function bellItems(){
    const items=[],now=new Date();
    personalTasks.filter(t=>t.hasTime&&t.dueDate&&new Date(t.dueDate)-now<=30*60000&&now-new Date(t.dueDate)<6*3600000).forEach(t=>items.push({id:'rem:'+t.id,cls:'t-deadline',icon:LOOP_TYPES.deadline.icon,label:new Date(t.dueDate)<=now?'Reminder now':'Reminder soon',title:t.title,meta:fmtDue(t)+(t.project?' · '+t.project:''),href:'',kind:'reminder'}));
    todayEvents().timed.filter(e=>e.start>now&&e.start-now<=30*60000).forEach(e=>items.push({id:'meet:'+e.title+e.start.getTime(),cls:'t-prepare',icon:bellIcon.meeting,label:'Starting soon',title:e.title,meta:`${hm(e.start)} · in ${Math.max(1,Math.round((e.start-now)/60000))} min`,href:'',kind:'meeting'}));
    if(token||microsoftAccount||DEMO)computeLoops().forEach(l=>{const t=LOOP_TYPES[l.type];items.push({id:l.id,cls:t.cls,icon:t.icon,label:t.label,title:l.title,meta:l.meta||l.detail,href:l.href,kind:'loop',loop:l,loopId:l.id})});
    return items;
  }
  function notifLogoHTML(item){
    const brand=bellBrandFor(item);
    const ini=initialsOf(brand.title||item.title||'?');
    if(brand.domain||item.loop){
      return `<span class="notif-logo m-brand" style="--a1:${esc(brand.color)};--a2:${esc(brand.color)}" aria-hidden="true">${brandLogoHTML(brand,ini)}</span>`;
    }
    return `<span class="notif-logo" aria-hidden="true"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${item.icon||''}</svg></span></span>`;
  }
  function isNotifOpen(){
    const panel=$('#notif-panel');
    return !!(panel&&!panel.hidden&&panel.classList.contains('show')&&!panel.classList.contains('closing'));
  }
  function renderBell(){
    const items=bellItems(),seen=readJSON('daylight-seen',[]),unseen=items.filter(i=>!seen.includes(i.id)).length,badge=$('#bell-badge');if(!badge)return;
    badge.hidden=!unseen||isNotifOpen();badge.textContent=unseen>9?'9+':unseen;$('#bell').setAttribute('aria-label',unseen?`Notifications, ${unseen} new`:'Notifications');
    const panel=$('#notif-panel');if(!panel||panel.hidden||!panel.classList.contains('show'))return;
    const list=$('#notif-list');if(!list)return;
    list.innerHTML=items.length?items.slice(0,12).map(i=>{
      const openAttr=i.loopId?` data-notif-loop="${esc(i.loopId)}"`:(i.href?` href="${esc(i.href)}" target="_blank" rel="noopener"`:'');
      const tag=i.loopId||i.href?'button':'div';
      const hrefTag=i.href&&!i.loopId?'a':tag;
      return `<${hrefTag} class="notif ${i.cls}${seen.includes(i.id)?'':' is-new'}"${openAttr} type="${hrefTag==='button'?'button':undefined}"><span class="notif-logo-wrap">${notifLogoHTML(i)}</span><span class="notif-body"><span class="loop-type">${esc(i.label)}</span><b>${esc(i.title)}</b><small>${esc(i.meta||'')}</small></span></${hrefTag}>`;
    }).join('').replace(/\stype="undefined"/g,''):`<div class="empty">${token||microsoftAccount||DEMO?'You’re all caught up.':'Connect Google to get notified about replies, meetings and deadlines.'}</div>`;
  }
  function openNotifPanel(){
    const panel=$('#notif-panel');if(!panel||notifClosing)return;
    if(isNotifOpen()){renderBell();return}
    panel.hidden=false;panel.setAttribute('aria-hidden','false');
    panel.classList.remove('closing');
    void panel.offsetWidth;
    requestAnimationFrame(()=>panel.classList.add('show'));
    $('#bell')?.setAttribute('aria-expanded','true');
    $('#m-bell')?.setAttribute('aria-expanded','true');
    document.body.classList.add('notif-open');
    renderBell();
    writeJSON('daylight-seen',bellItems().map(i=>i.id).concat(readJSON('daylight-seen',[])).slice(0,300));
    $('#bell-badge').hidden=true;
    const N=window.DaylightNav;
    if(N&&N.topView()!=='notif')N.push('notif');
    feel.select?.();
  }
  function closeNotifPanel(instant){
    const panel=$('#notif-panel');
    const N=window.DaylightNav;
    if(!panel||(panel.hidden&&!panel.classList.contains('show'))){N?.drop?.('notif');document.body.classList.remove('notif-open');return}
    $('#bell')?.setAttribute('aria-expanded','false');
    $('#m-bell')?.setAttribute('aria-expanded','false');
    const finish=()=>{
      panel.classList.remove('show','closing');
      panel.hidden=true;panel.setAttribute('aria-hidden','true');
      panel.style.transform='';panel.style.opacity='';
      const sheet=panel.querySelector('.notif-sheet');
      if(sheet){sheet.style.transform='';sheet.style.opacity='';sheet.style.transition=''}
      document.body.classList.remove('notif-open');
      notifClosing=false;N?.drop?.('notif');renderBell();
    };
    if(instant||matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return}
    if(notifClosing)return;
    notifClosing=true;
    panel.classList.add('closing');
    panel.classList.remove('show');
    setTimeout(finish,260);
  }
  function toggleBell(open){
    if(open==null)open=!isNotifOpen();
    if(open)openNotifPanel();else{
      const N=window.DaylightNav;
      if(N&&(N.topView()==='notif'||N.stack?.some(x=>x.view==='notif'))){N.back();return}
      closeNotifPanel();
    }
  }
  $('#bell')?.addEventListener('click',e=>{e.stopPropagation();toggleBell()});
  $('#notif-close')?.addEventListener('click',()=>toggleBell(false));
  $('#notif-scrim')?.addEventListener('click',()=>toggleBell(false));
  $('#notif-list')?.addEventListener('click',e=>{
    const row=e.target.closest('[data-notif-loop]');if(!row)return;
    e.preventDefault();
    const id=row.dataset.notifLoop;
    closeNotifPanel(true);
    if(id&&typeof openLoopSheet==='function')openLoopSheet(id);
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&isNotifOpen()){e.preventDefault();toggleBell(false)}});
  { const orig=renderLoops;renderLoops=function(){orig();renderBell()} }
  renderBell();setInterval(renderBell,60000);
  renderLoops();renderUpNext();applyVisibility();setInterval(()=>{renderUpNext();renderSummary(token?computeLoops().length:null)},60000);
  // ======== Daylight 2.0: every tile is a widget on one GridStack layout ========
  // Layout (which widgets, where, how big) is stored in 'daylight-layout-v2'; settings in 'daylight-widget-settings'.
  const WIDGETS={
    summary:{name:'Daily briefing',desc:'What matters today, in a few lines',size:{w:12,h:3},min:{w:3,h:2},settings:{detail:{label:'Detail',options:['Short','Detailed']}}},
    overview:{name:'Day at a glance',desc:'Counts, up next and today’s timeline',size:{w:12,h:4},min:{w:4,h:3}},
    loops:{name:'Open loops',desc:'Things you started but haven’t finished',size:{w:12,h:5},min:{w:3,h:3},settings:{view:{label:'View',options:['List','Cards']},max:{label:'Items shown',options:['3','6','9','12']},include:{label:'Include',options:['Everything','Work only']}}},
    finance:{name:'Subscriptions',desc:'Who, renew when, pending bills and payments',size:{w:6,h:6},min:{w:3,h:4},settings:{max:{label:'Items shown',options:['4','6','8','12']}}},
    travel:{name:'Travel',desc:'Flights, trains and bookings',size:{w:4,h:5},min:{w:3,h:3},settings:{max:{label:'Items shown',options:['3','5','8']}}},
    pending:{name:'Pending tasks',desc:'Due tasks and reminders',size:{w:4,h:5},min:{w:3,h:3},settings:{max:{label:'Items shown',options:['3','5','8']}}},
    documents:{name:'Documents',desc:'Contracts and files from mail and Drive',size:{w:4,h:5},min:{w:3,h:3},settings:{max:{label:'Items shown',options:['3','5','8']}}},
    calendar:{name:'Calendar',desc:'Today’s events',size:{w:4,h:5},min:{w:3,h:3}},
    tasks:{name:'Tasks',desc:'Google Tasks and personal tasks',size:{w:4,h:5},min:{w:3,h:3}},
    mail:{name:'Mail',desc:'Recent inbox messages',size:{w:4,h:5},min:{w:3,h:3},settings:{count:{label:'Emails shown',options:['3','5','8']},only:{label:'Show',options:['All','Unread only']}}},
    focus:{name:'Focus time',desc:'Timer that uses your free slots',size:{w:4,h:4},min:{w:3,h:3},settings:{len:{label:'Default length (min)',options:['25','45','50','60']}}},
    notes:{name:'Daily notes',desc:'A private note for today',size:{w:4,h:4},min:{w:3,h:3}},
    weather:{name:'Weather',desc:'Today’s forecast',size:{w:4,h:4},min:{w:2,h:3}},
    drive:{name:'Recent files',desc:'Google Drive files you opened',size:{w:4,h:4},min:{w:3,h:3},settings:{count:{label:'Files shown',options:['3','6','10']}}},
    birthdays:{name:'Birthdays',desc:'From your Google contacts',size:{w:4,h:4},min:{w:3,h:3},settings:{days:{label:'Look ahead (days)',options:['30','60','90','365']}}},
    markets:{name:'Markets',desc:'Currencies and crypto · add as many lists as you like',size:{w:4,h:4},min:{w:3,h:3},multi:true,settings:{title:{label:'Name',type:'text'}}}};
  const typeOf=id=>String(id).split('~')[0];
  const cardOf=id=>document.querySelector(`.card[data-widget="${CSS.escape(id)}"]`);
  const U=8,P=(id,x,y,w,h)=>({id,x,y:y*U,w,h:h*U});
  const PRESETS={
    'Default':[P('summary',0,0,12,3),P('loops',0,3,12,6)],
    'Work focus':[P('overview',0,0,8,4),P('focus',8,0,4,4),P('loops',0,4,12,5),P('pending',0,9,4,5),P('calendar',4,9,4,5),P('tasks',8,9,4,5),P('drive',0,14,6,4),P('notes',6,14,6,4)],
    'Inbox zero':[P('summary',0,0,12,3),P('loops',0,3,12,6),P('finance',0,9,4,5),P('mail',4,9,4,5),P('pending',8,9,4,5)],
    'Life admin':[P('summary',0,0,12,3),P('finance',0,3,4,5),P('travel',4,3,4,5),P('documents',8,3,4,5),P('pending',0,8,6,5),P('calendar',6,8,6,5)],
    'Minimal':[P('summary',0,0,12,3),P('calendar',0,3,6,5),P('tasks',6,3,6,5),P('weather',0,8,6,4),P('markets',6,8,6,4)]};

  // Smart summary (rules for now; an AI-written version can replace renderSmart later)
  const sumCard=document.createElement('article');sumCard.className='card summary-w';sumCard.dataset.widget='summary';
  sumCard.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue">✦</span>Daily briefing</div></div><div class="smart" id="smart-summary"></div><div class="smart-chips" id="smart-chips"></div><div class="smart-actions" id="smart-actions"></div>';
  $('#layout').prepend(sumCard);
  function renderSmart(){
    const el=$('#smart-summary');if(!el)return;const chips=$('#smart-chips'),actions=$('#smart-actions');
    const greet=()=>{const h=new Date().getHours(),p=readProfile(),first=(p.name||'').split(' ')[0];return `${h<12?'Good morning':h<18?'Good afternoon':'Good evening'}${first?', '+esc(first):''}.`};
    if(!token&&!microsoftAccount&&!DEMO){el.innerHTML=`${greet()} Connect Google and I’ll turn your mail, calendar and tasks into a short briefing.`;chips.innerHTML='';if(actions)actions.innerHTML='<button class="connect primary" type="button" id="smart-connect">Connect Google</button>';$('#smart-connect')?.addEventListener('click',()=>connectDialog({setup:true,focusId:true}));return}
    const now=new Date(),{timed,connected}=todayEvents(),detailed=wset('summary').detail==='Detailed';
    const loops=computeLoops(),cats=computeCategories(),money=cats.money||computeMoney(),n=t=>loops.filter(l=>l.type===t).length,pl=(k,one,many)=>k===1?one:many;
    const s=[greet()],line=[];
    if(connected||DEMO){const left=timed.filter(e=>e.end>now),next=left[0];
      if(!left.length&&connected)line.push('Your calendar is clear for the rest of the day');
      else if(next){const mins=Math.round((next.start-now)/60000);line.push(next.start<=now?`<em>${esc(next.title)}</em> is happening now`:mins<60?`Next up: <em>${esc(next.title)}</em> in ${mins} min`:`Next up: <em>${esc(next.title)}</em> at ${hm(next.start)}`);
        if(left.length>1)line.push(`${left.length-1} more after that`)}}
    if(line.length)s.push(line.join(' · ')+'.');
    const dueToday=cats.pending.filter(p=>['Overdue','Today','Reminder now','Reminder'].includes(p.tag));
    if(dueToday.length)s.push(`You’ve got <em>${dueToday.length} ${pl(dueToday.length,'thing','things')}</em> asking for you today${dueToday[0]?` — starting with ${esc(dueToday[0].title)}`:''}.`);
    if(n('reply'))s.push(`<em>${n('reply')} ${pl(n('reply'),'person is','people are')}</em> waiting on a reply.`);
    if(n('overdue'))s.push(`And <em>${n('overdue')} overdue ${pl(n('overdue'),'task','tasks')}</em> could use a reschedule.`);
    // Only obligations with an unpaid amount and a written due date (or a task you created) count as payments to make.
    const pendingPay=(money.obligations||[]).filter(i=>i.urgent),laterPay=(money.obligations||[]).filter(i=>!i.urgent),soonSub=(money.subscription||[]).filter(x=>x.urgent),toReview=money.counts?.review||0;
    if(pendingPay.length)s.push(`<em>${pendingPay.length} ${pl(pendingPay.length,'payment','payments')} to make</em> this week${pendingPay[0]?` — next: ${esc(pendingPay[0].title)}`:''}${laterPay.length?`, ${laterPay.length} later`:''}.`);
    else if(laterPay.length)s.push(`${laterPay.length} ${pl(laterPay.length,'bill','bills')} due later — nothing to pay this week.`);
    else if(soonSub.length)s.push(`${soonSub[0].title} renews ${esc(soonSub[0].meta||'soon')}.`);
    else if(money.counts?.total)s.push(`${money.counts.total} money ${pl(money.counts.total,'item','items')} sorted under Money.`);
    if(toReview)s.push(`${toReview} money ${pl(toReview,'email needs','emails need')} a quick check.`);
    if(cats.travel.length)s.push(`${cats.travel.length} ${pl(cats.travel.length,'trip','trips')} on the radar.`);
    const dayEnd=new Date(localMidnight.getTime()+DAY_END*3600000),dayStart=new Date(localMidnight.getTime()+DAY_START*3600000);
    const slot=connected&&freeGaps(timed,new Date(Math.max(now,dayStart)),dayEnd).find(g=>g.min>=45);
    if(slot)s.push(`Quiet window for focus: <em>${hm(slot.start)}–${hm(slot.end)}</em>.`);
    if(detailed){const extra=[];if(n('followup'))extra.push(`${n('followup')} ${pl(n('followup'),'conversation needs','conversations need')} a follow-up`);if(n('prepare'))extra.push(`${n('prepare')} ${pl(n('prepare'),'meeting','meetings')} to prepare`);
      const bday=(providerData.google.birthdays||[]).filter(b=>b.days===0).map(b=>b.name);if(bday.length)extra.push(`it’s ${esc(bday.join(' and '))}’s birthday`);if(extra.length)s.push(extra.join(', ').replace(/^./,c=>c.toUpperCase())+'.')}
    el.innerHTML=s.length>1?s.join(' '):`${greet()} Nothing pressing — a good moment to plan ahead.`;
    const chipItems=[...pendingPay.slice(0,1),...dueToday.slice(0,1),...loops.slice(0,2),...(soonSub[0]?[soonSub[0]]:[])];
    const seen=new Set();
    chips.innerHTML=chipItems.filter(l=>{const k=l.id||l.title;if(seen.has(k))return false;seen.add(k);return true}).slice(0,4).map(l=>{
      const cls=l.tag==='Overdue'||l.type==='overdue'||l.kind==='pending'?'tl-chip warn':(l.tag==='Today'||l.tag==='Reminder now'||l.urgent?'tl-chip due':'tl-chip');
      const label=l.from||l.title;
      return l.href?`<a class="${cls}" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(label)}</a>`:`<span class="${cls}">${esc(label)}</span>`;
    }).join('');
    if(actions){const btns=[];
      if(loops[0]?.href)btns.push(`<a class="connect primary" href="${esc(loops[0].href)}" target="_blank" rel="noopener">Open first loop</a>`);
      else if(loops[0])btns.push(`<button class="connect primary" type="button" data-scroll-loops>Review open loops</button>`);
      if(pendingPay[0]?.href)btns.push(`<a class="connect" href="${esc(pendingPay[0].href)}" target="_blank" rel="noopener">Open the bill</a>`);
      else if(money.counts?.total)btns.push(`<button class="connect" type="button" data-open-inbox>Open Inbox</button>`);
      actions.innerHTML=btns.join('');
      actions.querySelector('[data-scroll-loops]')?.addEventListener('click',()=>cardOf('loops')?.scrollIntoView({behavior:'smooth',block:'center'}));
      actions.querySelector('[data-open-inbox]')?.addEventListener('click',()=>{if(mq.matches)setTab('inbox');else{const f=cardOf('finance');if(f)f.scrollIntoView({behavior:'smooth',block:'center'});else toast('Add the Subscriptions widget from Customize')}});
    }
  }
  { const o=renderLoops;renderLoops=function(){o();renderSmart()} }
  setInterval(renderSmart,60000);

  // Grid
  const STORE=document.createElement('div');STORE.id='widget-store';STORE.hidden=true;document.body.append(STORE);
  let grid=null,editing2=false;
  const presetItems=name=>PRESETS[name].map(i=>({...i}));
  const toolsHTML=id=>`<div class="wtools"><button class="wt-btn" type="button" data-wset="${esc(id)}" aria-label="Widget settings" title="Settings">⚙</button><button class="wt-btn" type="button" data-wdel="${esc(id)}" aria-label="Remove widget" title="Remove">×</button></div>`;
  function placeItem(it){
    const card=cardOf(it.id);if(!card||!grid)return;const def=WIDGETS[typeOf(it.id)]||{size:{w:4,h:4}};it={...it,h:it.h||def.size.h*U};
    const el=document.createElement('div');el.className='grid-stack-item';el.setAttribute('gs-id',it.id);
    const pos={w:it.w||def.size.w,h:it.h||def.size.h,x:it.x,y:it.y};Object.entries(pos).forEach(([k,v])=>{if(v!=null)el.setAttribute('gs-'+k,v)});
    if(it.x==null||it.y==null)el.setAttribute('gs-auto-position','true');
    if(def.min)el.setAttribute('gs-min-w',def.min.w);
    const content=document.createElement('div');content.className='grid-stack-item-content';content.append(card);content.insertAdjacentHTML('beforeend',toolsHTML(it.id));el.append(content);
    $('#layout').append(el);grid.makeWidget(el);return el;
  }
  function saveLayout(){if(!grid||grid.getColumn()!==12)return;writeJSON('daylight-layout-v6',grid.save(false).map(n=>({id:n.id,x:n.x,y:n.y,w:n.w,h:n.h})))}
  function loadItems(items){
    if(!grid)return;$$('#layout .card').forEach(c=>STORE.append(c));grid.removeAll();
    items.forEach(it=>{if(typeOf(it.id)==='markets'&&!cardOf(it.id))marketsCard(it.id);placeItem(it)});saveLayout();
  }
  function initGrid(){
    if(!window.GridStack){$('#layout').classList.add('no-grid');return false}
    let items=readJSON('daylight-layout-v6',null);
    if(!Array.isArray(items)||!items.length){const hidden=readJSON('daylight-hidden',[]);items=presetItems('Default').filter(i=>!hidden.includes(i.id))}
    items.forEach(it=>{if(typeOf(it.id)==='markets'&&!cardOf(it.id))marketsCard(it.id)});
    $$('#layout > .card').forEach(c=>STORE.append(c));
    $('#layout').classList.add('grid-stack');
    grid=GridStack.init({column:12,cellHeight:U,margin:8,float:false,animate:true,staticGrid:true,resizable:{handles:'e,w'},
      columnOpts:{breakpoints:[{w:680,c:1},{w:1100,c:6}],layout:'moveScale'}},'#layout');
    items.forEach(placeItem);
    grid.on('change',saveLayout);grid.on('added',saveLayout);grid.on('removed',saveLayout);
    return true;
  }
  const gridOK=initGrid();
  if(DEMO&&!token){
    try{loadLoops(true)}catch(e){console.warn(e)}
    setTimeout(()=>{renderCategories();renderSmart();fitAll?.()},0);
    toast('Preview mode · sample Gmail categories. Connect Google for your real inbox.');
  }

  // No scrolling inside widgets: each widget's height follows its content
  const CELL=U;
  function fitItem(item){
    const card=item.querySelector('.grid-stack-item-content>.card');if(!card||!grid)return;
    card.style.height='auto';const need=card.offsetHeight;card.style.height='';
    const rows=Math.max(4,Math.ceil((need+16)/CELL)),cur=item.gridstackNode?.h??+item.getAttribute('gs-h');
    if(rows!==cur)grid.update(item,{h:rows});
  }
  let fitTimer=null;
  function fitAll(){clearTimeout(fitTimer);fitTimer=setTimeout(()=>{if(grid)$$('#layout .grid-stack-item').forEach(fitItem)},50)}
  if(grid){new MutationObserver(fitAll).observe($('#layout'),{subtree:true,childList:true,characterData:true});
    addEventListener('resize',fitAll);grid.on('resizestop',fitAll);grid.on('added',fitAll);document.fonts?.ready?.then(fitAll);fitAll()}

  // Edit bar, gallery and per-widget settings
  const bar=document.createElement('div');bar.id='edit-bar';bar.className='edit-bar';bar.hidden=true;
  bar.innerHTML=`<div class="eb-text"><b>Customize</b><span>Drag a widget to move it, drag its sides to change the width; height fits the content. ⚙ settings, × remove.</span></div>
    <div class="eb-actions"><button class="connect primary" type="button" id="eb-add">+ Add widget</button>
    <label class="eb-field">Layout <select id="eb-preset"><option value="">Choose…</option>${Object.keys(PRESETS).map(p=>`<option>${p}</option>`).join('')}</select></label>
    <label class="eb-field">Day <select id="hours-start">${hourOpts(DAY_START,0,22)}</select>–<select id="hours-end">${hourOpts(DAY_END,1,23)}</select></label>
    <button class="connect ghost" type="button" id="eb-reset">Reset</button><button class="connect" type="button" id="eb-done">Done</button></div>`;
  $('#layout').before(bar);
  const wpanel=document.createElement('aside');wpanel.id='wpanel';wpanel.className='wpanel';wpanel.hidden=true;wpanel.setAttribute('role','dialog');document.body.append(wpanel);
  const closePanel=()=>{wpanel.hidden=true};
  function toggleEdit(on){
    if(!gridOK){toast('Moving and resizing widgets needs an internet connection to load the layout tools.');return}
    editing2=on??!editing2;grid.setStatic(!editing2);document.body.classList.toggle('editing',editing2);bar.hidden=!editing2;$('#customize')?.classList.toggle('active',editing2);
    if(editing2){$('#hours-start').value=DAY_START;$('#hours-end').value=DAY_END;bar.scrollIntoView({behavior:'smooth',block:'nearest'})}else closePanel();
  }
  $('#customize')?.addEventListener('click',()=>toggleEdit());
  $('#eb-done').onclick=()=>toggleEdit(false);
  $('#eb-preset').onchange=e=>{if(!e.target.value)return;loadItems(presetItems(e.target.value));toast(`Layout: ${e.target.value}`);e.target.value=''};
  $('#eb-reset').onclick=()=>{loadItems(presetItems('Default'));toast('Layout reset')};
  bar.addEventListener('change',e=>{if(e.target.id==='hours-start'||e.target.id==='hours-end'){let s=+$('#hours-start').value,en=+$('#hours-end').value;if(en<=s){en=Math.min(23,s+1);$('#hours-end').value=en}DAY_START=s;DAY_END=en;writeJSON('daylight-hours',{start:s,end:en});renderInsights();renderSmart()}});
  function openGallery(){
    const placed=new Set(grid?grid.save(false).map(n=>n.id):[]);
    wpanel.innerHTML=`<div class="wp-head"><b>Add widget</b><button class="modal-x" type="button" data-close aria-label="Close">×</button></div><div class="wp-list">${Object.entries(WIDGETS).map(([k,w])=>{const on=!w.multi&&placed.has(k);
      return `<button class="wp-item" type="button" data-addw="${k}"${on?' disabled':''}><b>${esc(w.name)}</b><span>${esc(w.desc)}</span><i>${on?'On your dashboard':w.multi&&placed.has(k)?'Add another':'Add'}</i></button>`}).join('')}</div>`;
    wpanel.hidden=false;
  }
  function openSettings(id){
    const def=WIDGETS[typeOf(id)]||{},cur=wset(id),keys=Object.keys(def.settings||{});
    wpanel.innerHTML=`<div class="wp-head"><b>${esc(cur.title||def.name||'Widget')}</b><button class="modal-x" type="button" data-close aria-label="Close">×</button></div>
      ${keys.length?`<div class="wp-settings">${keys.map(k=>{const f=def.settings[k];return `<label>${esc(f.label)}${f.type==='text'?`<input data-wk="${k}" value="${esc(cur[k]||'')}" placeholder="${esc(def.name)}" maxlength="40">`:`<select data-wk="${k}">${f.options.map(o=>`<option${String(cur[k]||f.options[0])===o?' selected':''}>${esc(o)}</option>`).join('')}</select>`}</label>`}).join('')}</div>`:'<p class="muted-note">This widget has no settings yet.</p>'}
      ${typeOf(id)==='markets'?'<p class="muted-note">Change the coins and currency pairs with Edit on the widget itself.</p>':''}`;
    wpanel.hidden=false;wpanel.dataset.for=id;
  }
  const rerender={summary:renderSmart,loops:renderLoops,mail:renderMail,drive:()=>{renderDrive();renderCategories()},birthdays:renderBirthdays,focus:renderInsights,finance:renderCategories,travel:renderCategories,pending:renderCategories,documents:renderCategories};
  wpanel.addEventListener('click',e=>{
    if(e.target.closest('[data-close]'))return closePanel();
    const add=e.target.closest('[data-addw]');if(!add||add.disabled)return;const type=add.dataset.addw;let id=type;
    if(WIDGETS[type].multi&&cardOf(type)&&grid.save(false).some(n=>n.id===type)){let i=2;while(cardOf(`${type}~${i}`)||grid.save(false).some(n=>n.id===`${type}~${i}`))i++;id=`${type}~${i}`;marketsCard(id)}
    const el=placeItem({id});closePanel();el?.scrollIntoView({behavior:'smooth',block:'center'});toast(`${WIDGETS[type].name} added`);saveLayout()});
  wpanel.addEventListener('input',e=>{const k=e.target.dataset.wk;if(!k)return;const id=wpanel.dataset.for;wsave(id,{[k]:e.target.value});
    (rerender[typeOf(id)]||(()=>{}))();if(typeOf(id)==='markets'){const c=cardOf(id);if(c)c.querySelector('.m-title').textContent=e.target.value||'Markets'}});
  $('#layout').addEventListener('click',e=>{
    const s=e.target.closest('[data-wset]'),d=e.target.closest('[data-wdel]');
    if(s)openSettings(s.dataset.wset);
    if(d&&grid){const id=d.dataset.wdel,item=d.closest('.grid-stack-item'),card=cardOf(id);
      if(card){if(id.includes('~')){card.remove();const all=wsetAll();delete all[id];writeJSON('daylight-widget-settings',all)}else STORE.append(card)}
      grid.removeWidget(item);saveLayout();toast(`${(WIDGETS[typeOf(id)]||{}).name||'Widget'} removed · add it back from + Add widget`)}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!wpanel.hidden)closePanel()});
  $('#eb-add').onclick=openGallery;
  renderSmart();
  // ======== Command bar: ask, search and quick capture ========
  const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  function parseWhen(text){
    let rest=' '+text+' ',date=null,hasTime=false,h=null,mi=0;const now=new Date(),base=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    const take=re=>{const m=re.exec(rest);if(m)rest=rest.slice(0,m.index)+' '+rest.slice(m.index+m[0].length);return m};
    let m;
    if((m=take(/\s(?:by\s+|for\s+|on\s+)?(today|tonight)\b/i))){date=new Date(base);if(/tonight/i.test(m[1]))h=20}
    else if(take(/\s(?:by\s+|for\s+|on\s+)?tomorrow\b/i))date=new Date(base.getTime()+86400000);
    else if(take(/\s(?:by\s+|for\s+|on\s+)?next\s+week\b/i)){date=new Date(base);date.setDate(date.getDate()+((8-date.getDay())%7||7))}
    else if((m=take(/\s(?:by\s+|for\s+|on\s+)?(?:this\s+|next\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\b/i))){const want=DAYS.findIndex(d=>d.startsWith(m[1].toLowerCase().slice(0,3)));date=new Date(base);date.setDate(date.getDate()+(((want-date.getDay())+7)%7||7))}
    else if((m=take(/\sin\s+(\d+)\s+(minutes?|mins?|hours?|days?|weeks?)\b/i))){const n=+m[1],u=m[2][0].toLowerCase();if(u==='m'||u==='h'){const t=new Date(now.getTime()+n*(u==='m'?60000:3600000));date=new Date(t.getFullYear(),t.getMonth(),t.getDate());h=t.getHours();mi=t.getMinutes()}else date=new Date(base.getTime()+n*(u==='w'?7:1)*86400000)}
    else if((m=take(/\s(?:by\s+|for\s+|on\s+)?(\d{1,2})\.\s?(\d{1,2})\.?(?:\s?(\d{4}))?(?=\s)/))){date=new Date(m[3]?+m[3]:base.getFullYear(),+m[2]-1,+m[1]);if(!m[3]&&date<base)date.setFullYear(date.getFullYear()+1)}
    else if((m=take(/\s(?:by\s+|for\s+|on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i))||(m=take(/\s(?:by\s+|for\s+|on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i))){
      const mon=MONTHS.indexOf((isNaN(m[1])?m[1]:m[2]).toLowerCase().slice(0,3)),day=+(isNaN(m[1])?m[2]:m[1]);date=new Date(base.getFullYear(),mon,day);if(date<base)date.setFullYear(date.getFullYear()+1)}
    if((m=take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))){h=+m[1]%12+(m[3].toLowerCase()==='pm'?12:0);mi=+(m[2]||0)}
    else if((m=take(/\s(?:at\s+)?(\d{1,2}):(\d{2})\b/))){h=+m[1];mi=+m[2]}
    else if((m=take(/\sat\s+(\d{1,2})\b/i))){h=+m[1]}
    else if((m=take(/\s(?:in\s+the\s+|this\s+)?(morning|noon|afternoon|evening)\b/i))){h={morning:9,noon:12,afternoon:14,evening:18}[m[1].toLowerCase()]}
    if(h!=null){hasTime=true;if(!date){date=new Date(base);if(h*60+mi<=now.getHours()*60+now.getMinutes())date.setDate(date.getDate()+1)}date.setHours(h,mi,0,0)}
    else if(date)date.setHours(9,0,0,0);
    return {date,hasTime,rest:rest.replace(/\s+/g,' ').trim()};
  }
  function fmtDue(t){if(!t.dueDate)return'';const d=new Date(t.dueDate),days=Math.round((new Date(d.getFullYear(),d.getMonth(),d.getDate())-localMidnight)/86400000);
    const day=days===0?'Today':days===1?'Tomorrow':days===-1?'Yesterday':d.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});return day+(t.hasTime?', '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'')}
  function parseCapture(text){
    const w=parseWhen(text);let t=w.rest,project='';let m;
    if((m=/\s*\b(?:with|for|to|in|under|into)\s+(?:my|the|our)\s+([\p{L}\d][\p{L}\d-]*(?:\s[\p{L}\d][\p{L}\d-]*)?)\s+project\b/iu.exec(t))){project=m[1];t=t.replace(m[0],'')}
    else if((m=/\s*#([\p{L}\d-]+)/u.exec(t))){project=m[1];t=t.replace(m[0],'')}
    t=t.replace(/^(please\s+)?(remember\s+to|remind\s+me\s+to|remind\s+me\s+(?:about|of)|remind\s+me|remember|add\s+a\s+reminder(\s+to)?|add\s+reminder(\s+to)?|set\s+a\s+reminder(\s+to)?|reminder(\s+to)?:?|add\s+a\s+task(\s+to)?|add\s+task:?|todo:?|to-?do:?|note:?)\s*/i,'').replace(/\s+(for|on|by|at)$/i,'').replace(/[.\s]+$/,'').trim();
    if(!t)t='Reminder';t=t[0].toUpperCase()+t.slice(1);if(project)project=project[0].toUpperCase()+project.slice(1);
    return {title:t,dueDate:w.date?w.date.toISOString():'',hasTime:w.hasTime,project};
  }
  const looksLikeCapture=q=>/^\s*(please\s+)?(remember|remind|add|todo|to-?do|note|keep|save|buy|call|email|text|send|book|pay|check|finish|submit|renew|cancel|pick up|bring)\b/i.test(q);
  function savePersonal(){try{localStorage.setItem('daylight-personal-tasks',JSON.stringify(personalTasks))}catch{};try{queueDaylightHydrate?.()}catch{}}
  function capture(text){const item={id:crypto.randomUUID?.()||String(Date.now()),...parseCapture(text),created:new Date().toISOString()};personalTasks.unshift(item);savePersonal();renderTasks();renderLoops();return item}

  // Search across what Daylight can see
  const STOP=new Set('find search show me the a an my for about of in on to with where is are was what which email emails mail mails message file files document documents doc docs meeting meetings please any that from'.split(' '));
  const keywordsOf=q=>q.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,' ').split(/\s+/).filter(w=>w&&!STOP.has(w));
  const has=(s,kws)=>kws.every(k=>String(s||'').toLowerCase().includes(k));
  async function googleCalendarIds(){
    if(!token)return [];
    if(mCalIds)return mCalIds;
    try{
      const data=await api('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50&minAccessRole=reader');
      const ids=(data.items||[]).filter(c=>c&&c.selected!==false&&!c.hidden).slice(0,8).map(c=>c.id).filter(Boolean);
      mCalIds=ids.length?ids:['primary'];
    }catch{mCalIds=['primary']}
    return mCalIds;
  }
  async function googleEventsBetween(from,to,q){
    if(!token)return [];
    const ids=await googleCalendarIds();
    const chunks=await Promise.all(ids.map(async id=>{
      const items=[];let pageToken='';
      try{
        do{
          const u=new URL('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(id)+'/events');
          u.searchParams.set('timeMin',from.toISOString());
          u.searchParams.set('timeMax',to.toISOString());
          u.searchParams.set('singleEvents','true');
          u.searchParams.set('orderBy','startTime');
          u.searchParams.set('maxResults','250');
          if(q)u.searchParams.set('q',q);
          if(pageToken)u.searchParams.set('pageToken',pageToken);
          const data=await api(u);
          (data.items||[]).forEach(e=>{if(!e||e.status==='cancelled')return;const self=(e.attendees||[]).find(a=>a.self);if(self&&self.responseStatus==='declined')return;items.push({...e,source:e.source||'Google Calendar',calendarId:id})});
          pageToken=data.nextPageToken||'';
        }while(pageToken&&items.length<500);
      }catch(err){console.warn('calendar',id,err)}
      return items;
    }));
    const seen=new Set(),out=[];
    chunks.flat().forEach(e=>{const k=e.id||(e.iCalUID||'')+String(e.start?.dateTime||e.start?.date||'');if(!k||seen.has(k))return;seen.add(k);out.push(e)});
    return out;
  }
  async function eventsBetween(from,to,q){
    if(!token)return [];
    try{return await googleEventsBetween(from,to,q)}catch{return []}
  }
  async function msEventsBetween(from,to){
    if(!microsoftAccount)return [];
    try{
      const u=new URL('https://graph.microsoft.com/v1.0/me/calendarView');
      u.searchParams.set('startDateTime',from.toISOString());u.searchParams.set('endDateTime',to.toISOString());
      u.searchParams.set('$select','id,subject,start,end,location,isAllDay,webLink,attendees');
      u.searchParams.set('$orderby','start/dateTime');u.searchParams.set('$top','50');
      const data=await graph('/me/calendarView'+u.search);
      return (data.value||[]).map(e=>{
        const allDay=!!e.isAllDay;
        const sRaw=(e.start?.dateTime||'').slice(0,10),eRaw=(e.end?.dateTime||'').slice(0,10);
        return {
          id:e.id,summary:e.subject,location:e.location?.displayName||'',htmlLink:e.webLink||'',
          start:allDay?{date:sRaw}:{dateTime:e.start?.dateTime,timeZone:e.start?.timeZone||'UTC'},
          end:allDay?{date:eRaw||sRaw}:{dateTime:e.end?.dateTime,timeZone:e.end?.timeZone||'UTC'},
          attendees:e.attendees,isAllDay:allDay,source:'Outlook Calendar'
        };
      });
    }catch{return []}
  }
  function parseCalTimes(e){
    if(e.start?.dateTime){
      const raw=e.start.dateTime,tz=e.start.timeZone==='UTC'&&!/[zZ]|[+-]\d\d:?\d\d$/.test(raw);
      const st=new Date(raw+(tz?'Z':''));
      const rawE=e.end?.dateTime||raw,tzE=e.end?.timeZone==='UTC'&&!/[zZ]|[+-]\d\d:?\d\d$/.test(rawE);
      const en=new Date(rawE+(tzE?'Z':''));
      return {start:st,end:en>st?en:new Date(st.getTime()+30*60000),allDay:false};
    }
    const dateStr=e.start?.date||(e.isAllDay?(e.start?.dateTime||'').slice(0,10):'');
    if(!dateStr)return null;
    const [y,m,d]=dateStr.split('-').map(Number);if(!y||!m||!d)return null;
    const st=new Date(y,m-1,d);
    let en;
    if(e.end?.date){const [ey,em,ed]=e.end.date.split('-').map(Number);en=new Date(ey,em-1,ed)}
    else en=new Date(st.getTime()+86400000);
    return {start:st,end:en>st?en:new Date(st.getTime()+86400000),allDay:true};
  }
  const evItem=e=>{const s=new Date(e.start?.dateTime||e.start?.date);return {title:e.summary||'(No title)',meta:(e.start?.dateTime?s.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'})+' · '+hm(s):s.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'})+' · all day')+(e.location?' · '+e.location:''),href:e.htmlLink,src:'Calendar'}};
  const loopItem=l=>({title:l.title,meta:[srcOf(l),l.meta||l.detail].filter(Boolean).join(' · '),href:l.href,src:srcOf(l)});
  async function answer(q){
    const lq=q.toLowerCase(),w=parseWhen(q),needG=!token&&!microsoftAccount;
    if(/\b(bills?|renewals?|subscriptions?|payments?|invoices?)\b/.test(lq)){
      const money=computeMoney();
      const row=i=>({title:i.subject||i.title,meta:[i.tag,i.amount,i.fin?Math.round((i.fin.confidence||0)*100)+'% sure':''].filter(Boolean).join(' · '),href:i.href,src:'Money'});
      return {sections:[
        {title:'To pay (with a due date in the email)',items:(money.obligations||[]).map(row),empty:needG?'Connect Google to check your inbox.':'No unpaid bills with a due date found.'},
        {title:'Upcoming renewals',items:(money.subscription||[]).filter(i=>i.fin?.bucket==='upcoming').map(row),empty:'No upcoming renewals found.'},
        {title:'Needs your review',items:[...(money.ledger?.review||[]).map(r=>({title:r.subject||r.merchant,meta:[r.label,r.obligationReason||'uncertain'].filter(Boolean).join(' · '),href:gmailLink(r.mailIds?.[0]),src:'Money'})),...(money.legacy||[]).map(row)].slice(0,8),empty:'Nothing uncertain.'}
      ],note:'Daylight only lists a payment as due when the email states an unpaid amount and a due date. Open Money to correct anything.'};
    }
    if(/\b(trips?|travel|flights?|trains?|hotels?|bookings?|ticket)\b/.test(lq)){
      const walletTravel=readWallet().filter(w=>w.kind==='tickets'||w.tripId||w.flight).map(w=>({title:w.title,meta:[w.typeLabel||'Wallet',w.date||'',w.tripId?'Linked trip':''].filter(Boolean).join(' · '),href:w.href||'',src:'Wallet'}));
      const trips=(loopsData?.trips||[]).map(t=>({title:t.dest?`Trip to ${t.dest}`:t.id,meta:`${t.count||0} items · ${(t.kinds||[]).join(', ')}`,href:'',src:'Trip'}));
      return {sections:[
        {title:'Wallet tickets',items:walletTravel,empty:'No travel passes in Wallet yet.'},
        {title:'Trips',items:trips.length?trips:computeLoops().filter(l=>l.type==='travel').map(loopItem),empty:'No trips found in recent email or your calendar.'}
      ]};
    }
    if(/\b(repl(y|ies)|waiting|follow[- ]?ups?|owe)\b/.test(lq))return {sections:[{title:'Waiting on you',items:computeLoops().filter(l=>l.type==='reply').map(loopItem),empty:'Nobody is waiting for a reply.'},{title:'Waiting on others',items:computeLoops().filter(l=>l.type==='followup').map(loopItem),empty:'No unanswered emails you sent.'}]};
    if(/\b(tasks?|to-?dos?|unfinished|overdue|reminders?)\b/.test(lq)){
      const all=[...personalTasks.map(t=>({...t,src:'Daylight'})),...(providerData.google.tasks||[]).map(t=>({...t,src:'Google Tasks'})),...(providerData.microsoft.tasks||[]).map(t=>({...t,src:'To Do'}))];
      const day=t=>{if(!t.dueDate)return null;const d=new Date(t.dueDate);return /T00:00:00(\.000)?Z$/.test(t.dueDate)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
      let list=all,title='Open tasks and reminders';
      if(/last week/.test(lq)){const from=new Date(localMidnight.getTime()-7*86400000);list=all.filter(t=>{const d=day(t);return d&&d>=from&&d<localMidnight});title='Due last week and still open'}
      else if(/overdue|unfinished|late/.test(lq)){list=all.filter(t=>{const d=day(t);return d&&d<localMidnight});title='Overdue'}
      return {sections:[{title,items:list.map(t=>({title:t.title,meta:[t.src,t.dueDate?(t.personal||t.src==='Daylight'?fmtDue(t):day(t).toLocaleDateString(undefined,{day:'numeric',month:'short'})):'',t.project].filter(Boolean).join(' · '),href:t.src==='Google Tasks'?'https://tasks.google.com/':''})),empty:'Nothing here.'}]};
    }
    if(/\b(latest|recent)\b.*\b(project|activity|files?|documents?|work)\b/.test(lq)){
      const files=(providerData.google.files||[]).map(f=>({title:f.name,meta:'Drive'+((f.viewedByMeTime||f.modifiedTime)?' · '+ago(new Date(f.viewedByMeTime||f.modifiedTime)):''),href:f.webViewLink,src:'Drive'}));
      const proj=personalTasks.filter(t=>t.project).slice(0,5).map(t=>({title:t.title,meta:t.project+(t.dueDate?' · '+fmtDue(t):''),src:'Daylight'}));
      return {sections:[{title:'Recently opened files',items:files,empty:needG?'Connect Google to see your Drive activity.':'No recent files.'},...(proj.length?[{title:'Saved to your projects',items:proj}]:[])],note:'A written AI summary of project activity comes with the AI step.'};
    }
    if(/\b(schedule|agenda|plans?|busy|free|calendar)\b/.test(lq)||/\bwhat(?:'s| is| do i have| have i got| am i doing| happens?|'s happening)\b/.test(lq)||(/\b(meetings?|events?|day|week)\b/.test(lq)&&(w.date||/\b(today|week)\b/.test(lq)))){
      if(needG)return {note:'Connect Google to see your calendar.'};
      let from,to,title;if(/\bthis week\b|\bweek\b/.test(lq)&&!w.date){from=new Date();to=new Date(localMidnight.getTime()+8*86400000);title='Coming up this week'}
      else{const d=w.date||new Date();from=new Date(d.getFullYear(),d.getMonth(),d.getDate());to=new Date(from.getTime()+86400000);title=fmtDue({dueDate:from.toISOString()})}
      const ev=await eventsBetween(from,to);const mine=personalTasks.filter(t=>t.dueDate&&new Date(t.dueDate)>=from&&new Date(t.dueDate)<to).map(t=>({title:t.title,meta:'Reminder · '+fmtDue(t),src:'Daylight'}));
      return {sections:[{title,items:(ev||[]).map(evItem),empty:'Nothing in your calendar.'},...(mine.length?[{title:'Your reminders',items:mine}]:[])]};
    }
    // Keyword search across sources
    const kws=keywordsOf(q);if(!kws.length)return {note:'Try a few keywords, like “conference” or “invoice”.'};
    const sections=[];const mails=[...(loopsData?.inbox||[]).map(m=>{const h=m.payload?.headers||[];return {title:header(h,'Subject')||'(No subject)',from:header(h,'From').replace(/<.*?>/,'').replace(/"/g,'').trim(),date:new Date(header(h,'Date')),href:gmailLink(m.threadId)}})];
    const seen=new Set();const mailHits=mails.filter(m=>(has(m.title+' '+m.from,kws))&&!seen.has(m.href)&&seen.add(m.href)).map(m=>({title:m.title,meta:'Gmail · '+m.from+' · '+ago(m.date),href:m.href,src:'Gmail'}));
    sections.push({title:'Email',items:mailHits,empty:'No match in your recent inbox.',more:{label:`Search all of Gmail for “${kws.join(' ')}”`,href:'https://mail.google.com/mail/u/0/#search/'+encodeURIComponent(kws.join(' '))}});
    if(token){const longest=[...kws].sort((a,b)=>b.length-a.length)[0];
      const [ev,files]=await Promise.all([eventsBetween(new Date(Date.now()-120*86400000),new Date(Date.now()+120*86400000),kws.join(' ')),
        (async()=>{try{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',`name contains '${longest.replace(/'/g,"\\'")}' and trashed=false`);u.searchParams.set('pageSize','6');u.searchParams.set('orderBy','modifiedTime desc');u.searchParams.set('fields','files(name,mimeType,modifiedTime,webViewLink)');return (await api(u)).files||[]}catch{return[]}})()]);
      sections.push({title:'Calendar',items:(ev||[]).slice(0,6).map(evItem),empty:'No events match.'});
      sections.push({title:'Drive',items:files.filter(f=>has(f.name,kws)||kws.length===1).map(f=>({title:f.name,meta:'Drive'+(f.modifiedTime?' · edited '+ago(new Date(f.modifiedTime)):''),href:f.webViewLink,src:'Drive'})),empty:'No file names match.'});}
    const taskHits=[...personalTasks,...(providerData.google.tasks||[])].filter(t=>has(t.title+' '+(t.project||''),kws)).map(t=>({title:t.title,meta:(t.project?t.project+' · ':'')+(t.personal===undefined&&t.created?'Daylight':t.source||'Daylight')+(t.dueDate&&t.created?' · '+fmtDue(t):''),src:'Tasks'}));
    if(taskHits.length)sections.push({title:'Tasks and reminders',items:taskHits});
    const notes=[];try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(/^daylight-note-\d{4}-\d{2}-\d{2}$/.test(k)){const v=localStorage.getItem(k)||'';if(has(v,kws))notes.push({title:v.split('\n').find(l=>has(l,kws))?.slice(0,90)||v.slice(0,90),meta:'Note · '+new Date(k.slice(14)+'T12:00').toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}),src:'Notes'})}}}catch{}
    if(notes.length)sections.push({title:'Daily notes',items:notes});
    if(needG)sections.push({title:'',items:[],empty:'Connect Google to also search your calendar and Drive.'});
    return {sections};
  }

  // UI
  const cmd=document.createElement('div');cmd.className='cmd';cmd.id='cmd';
  cmd.innerHTML=`<div class="cmd-sheet" id="cmd-sheet" role="region" aria-live="polite" hidden></div>
    <form class="cmd-bar" id="cmd-form" autocomplete="off"><button type="button" class="cmd-plus" id="cmd-capture" aria-label="Quick capture" title="Quick capture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
    <input id="cmd-input" type="text" enterkeyhint="go" placeholder="Ask Daylight or capture a thought…" aria-label="Ask Daylight or capture a thought">
    <kbd class="cmd-kbd">Ctrl K</kbd><button type="submit" class="cmd-go" aria-label="Go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></form>`;
  document.body.append(cmd);document.body.classList.add('has-cmd');
  const sheet=$('#cmd-sheet'),input=$('#cmd-input');let captureMode=false;
  const SUGGEST=['What do I have tomorrow?','Remember to check the simulation results on Friday','Find the email about the conference','Show unfinished tasks from last week','What bills or renewals are coming up?','Add a reminder for Friday at 10'];
  function showSheet(html){sheet.innerHTML=html;sheet.hidden=false}
  function hideSheet(){sheet.hidden=true;captureMode=false;cmd.classList.remove('capturing');input.placeholder=innerWidth<=680?'Ask or capture…':'Ask Daylight or capture a thought…'}
  function suggestions(){showSheet(`<div class="cs-head">Try</div>${SUGGEST.map(s=>`<button type="button" class="cs-suggest" data-q="${esc(s)}">${esc(s)}</button>`).join('')}<div class="cs-hint">Start with “Remember”, “Remind me” or “Add” to save something. Press <kbd>+</kbd> to save anything as a reminder.</div>`)}
  function renderAnswer(q,res,altCapture){
    const secs=(res.sections||[]).map(s=>`${s.title?`<div class="cs-head">${esc(s.title)}${s.items.length?` <span>${s.items.length}</span>`:''}</div>`:''}${s.items.length?s.items.slice(0,8).map(i=>`<${i.href?`a href="${esc(i.href)}" target="_blank" rel="noopener"`:'div'} class="cs-item"><b>${esc(i.title)}</b><small>${esc(i.meta||'')}</small></${i.href?'a':'div'}>`).join(''):`<div class="cs-empty">${esc(s.empty||'Nothing found.')}</div>`}${s.more?`<a class="cs-more" href="${esc(s.more.href)}" target="_blank" rel="noopener">${esc(s.more.label)} ↗</a>`:''}`).join('');
    showSheet(`<div class="cs-q">“${esc(q)}”</div>${secs}${res.note?`<div class="cs-hint">${esc(res.note)}</div>`:''}<div class="cs-actions"><button type="button" class="connect ghost" data-capture="${esc(q)}">Save as reminder instead</button></div>`);
  }
  function renderSaved(item){
    showSheet(`<div class="cs-saved"><span class="cs-check">✓</span><div><b>Saved: ${esc(item.title)}</b><small>${esc([item.dueDate?fmtDue(item):'No date',item.project?'Project: '+item.project:'In your tasks'].join(' · '))}</small></div></div>
      <div class="cs-actions"><button type="button" class="connect ghost" data-undo="${esc(item.id)}">Undo</button>${item.hasTime&&'Notification' in window&&Notification.permission==='default'?'<button type="button" class="connect" data-notify>Alert me on this device</button>':''}<button type="button" class="connect ghost" data-close-sheet>Close</button></div>`);
  }
  async function run(q,forceCapture){
    q=q.trim();if(!q)return;
    if(forceCapture||looksLikeCapture(q)){const item=capture(q);input.value='';renderSaved(item);toast('Saved');return}
    showSheet(`<div class="cs-q">“${esc(q)}”</div><div class="cs-empty">Looking…</div>`);
    try{renderAnswer(q,await answer(q))}catch(e){showSheet(`<div class="cs-empty">Something went wrong: ${esc(e.message)}</div>`)}
  }
  $('#cmd-form').addEventListener('submit',e=>{e.preventDefault();run(input.value,captureMode)});
  $('#cmd-capture').onclick=()=>{if(input.value.trim())return run(input.value,true);captureMode=true;cmd.classList.add('capturing');input.placeholder='Remember to… (add a day or time if you like)';input.focus();showSheet('<div class="cs-hint">Type anything and press Enter to save it. Dates like “Friday”, “tomorrow 15:00” or “12.11.” and “for my research project” are picked up automatically.</div>')};
  input.addEventListener('focus',()=>{if(sheet.hidden&&!input.value)suggestions()});
  input.addEventListener('input',()=>{if(!input.value&&!captureMode)suggestions()});
  sheet.addEventListener('click',async e=>{
    const s=e.target.closest('[data-q]');if(s){input.value=s.dataset.q;run(s.dataset.q);return}
    const c=e.target.closest('[data-capture]');if(c){run(c.dataset.capture,true);return}
    const u=e.target.closest('[data-undo]');if(u){personalTasks=personalTasks.filter(t=>t.id!==u.dataset.undo);savePersonal();renderTasks();renderLoops();hideSheet();toast('Removed');return}
    if(e.target.closest('[data-notify]')){const p=await Notification.requestPermission();toast(p==='granted'?'You’ll get an alert at the reminder time while Daylight is open':'Alerts not allowed');hideSheet();return}
    if(e.target.closest('[data-close-sheet]'))hideSheet()});
  document.addEventListener('click',e=>{if(!sheet.hidden&&!e.composedPath().includes(cmd))hideSheet()});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.focus();input.select()}
    else if(e.key==='/'&&!/input|textarea|select/i.test(document.activeElement?.tagName||'')){e.preventDefault();input.focus()}
    else if(e.key==='Escape'&&(!sheet.hidden||document.activeElement===input)){hideSheet();input.blur()}});
  hideSheet();addEventListener('resize',()=>{if(!captureMode)input.placeholder=innerWidth<=680?'Ask or capture…':'Ask Daylight or capture a thought…'});
  // Reminder alerts at the chosen time (while Daylight is open)
  setInterval(()=>{const now=Date.now(),done=readJSON('daylight-alerted',[]);
    personalTasks.filter(t=>t.hasTime&&t.dueDate&&!done.includes(t.id)&&new Date(t.dueDate)<=now&&now-new Date(t.dueDate)<10*60000).forEach(t=>{
      done.push(t.id);toast('Reminder: '+t.title);if('Notification' in window&&Notification.permission==='granted'){try{new Notification('Daylight reminder',{body:t.title,icon:'icon-192.png'})}catch{}}});
    writeJSON('daylight-alerted',done.slice(-200));renderBell()},30000);

  // ======== Open loops: attention-inbox list view ========
  function srcOf(l){const h=l.href||'';return h.includes('mail.google')?'Gmail':h.includes('calendar.google')?'Calendar':h.includes('tasks.google')?'Google Tasks':h.includes('to-do.office')?'To Do':'Daylight'}
  const TAGS={overdue:['Overdue','hot'],deadline:['Due soon','warm'],reply:['Suggested action',''],followup:['Suggested action',''],prepare:['Upcoming',''],renewal:['Review',''],travel:['Reminder','']};
  function findLoop(id){
    if(!id)return null;
    const fromLoops=computeLoops().find(l=>l.id===id);
    if(fromLoops)return fromLoops;
    try{
      const prio=findPriorityItem(id);
      if(prio)return prio;
    }catch{}
    return null;
  }
  function loopSubject(l){return l.subject||l.detail||l.title||''}
  function loopNote(l){
    if(l.type==='reply')return 'Read the email and send a clear reply.';
    if(l.type==='followup')return 'Send a short nudge — you haven’t heard back yet.';
    if(l.type==='prepare')return 'Review attendees, notes and linked files before it starts.';
    if(l.type==='overdue')return 'Past due. Reschedule to a realistic time or mark it done.';
    if(l.type==='deadline')return 'Deadline is close. Finish the work or move the due date.';
    if(l.type==='renewal')return 'Confirm you still need this before it renews.';
    if(l.type==='travel')return 'Confirm tickets, stay, documents and timing.';
    return 'Review this item and take the next step.';
  }
  function loopCategory(l){return l.category||({reply:'Reply / Email',followup:'Follow up / Email',prepare:'Meeting',overdue:'Task',deadline:'Task',renewal:'Renewal / Billing',travel:'Travel'}[l.type]||'Open loop')}
  function loopDueLabel(l){
    if(l.dueLabel)return l.dueLabel;
    if(l.whenMs){const d=new Date(l.whenMs);if(l.type==='prepare'||l.type==='deadline'||l.type==='overdue')return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}
    return 'Today';
  }
  function loopSuggestion(l){
    const subject=loopSubject(l);
    if(l._inbox&&l.category==='Subscription')return{kind:'task',label:'AI Suggestion',text:`Decide whether to keep “${l.title}”${l.amount?' ('+l.amount+')':''} before the next renewal.`,cta:'Add reminder',primary:'Review'};
    if(l._inbox&&l.category==='Pending')return{kind:'task',label:'AI Suggestion',text:`Pay or reschedule “${l.title}”${l.amount?' · '+l.amount:''} and confirm once done.`,cta:'Add reminder',primary:'Review'};
    if(l._inbox&&l.category==='Bill')return{kind:'task',label:'AI Suggestion',text:`Review the bill for “${l.title}”${l.amount?' · '+l.amount:''} and schedule payment if needed.`,cta:'Add reminder',primary:'Review'};
    if(l._inbox)return{kind:'task',label:'AI Suggestion',text:`Review “${subject}” from ${l.fromName||l.title} and take the next money action.`,cta:'Add reminder',primary:'Review'};
    if(l.type==='reply')return{kind:'reply',label:'AI Suggestion',text:`Hi — thanks for your note about “${subject}”. I’ll follow up with details shortly.`,cta:'Reply in Daylight',primary:'Reply'};
    if(l.type==='followup')return{kind:'reply',label:'AI Suggestion',text:`Hi — just checking in on “${subject}”. Any update when you have a moment?`,cta:'Reply in Daylight',primary:'Reply'};
    if(l.type==='prepare')return{kind:'task',label:'AI Suggestion',text:`Prepare notes and an agenda for “${l.title.replace(/^Prepare for\s+/i,'')}”.`,cta:'Add task',primary:'Open calendar'};
    if(l.type==='overdue')return{kind:'task',label:'AI Suggestion',text:`Reschedule “${l.title.replace(/^Reschedule:\s*/i,'')}” to a realistic day this week.`,cta:'Add reminder',primary:'Open task'};
    if(l.type==='deadline')return{kind:'task',label:'AI Suggestion',text:`Block time today to finish “${l.title}”.`,cta:'Add task',primary:'Open task'};
    if(l.type==='renewal')return{kind:'task',label:'AI Suggestion',text:`Review whether you still need this subscription before it renews.`,cta:'Add reminder',primary:'Open mail'};
    if(l.type==='travel')return{kind:'task',label:'AI Suggestion',text:`Confirm tickets, accommodation and documents for this trip.`,cta:'Add task',primary:'Open'};
    return{kind:'task',label:'AI Suggestion',text:l.title,cta:'Add task',primary:'Open'};
  }
  const mailDetailCache={};
  function decodeMailText(payload,{limit}={}){
    const max=limit==null?12000:limit;
    const decode=d=>{try{const bin=atob(String(d).replace(/-/g,'+').replace(/_/g,'/'));try{return decodeURIComponent(escape(bin))}catch{return bin}}catch{return''}};
    const walk=p=>{
      if(!p)return'';
      if(p.mimeType==='text/plain'&&p.body?.data)return decode(p.body.data);
      if(p.parts){for(const x of p.parts){const t=walk(x);if(t)return t}}
      if(p.mimeType==='text/html'&&p.body?.data)return decode(p.body.data).replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      return'';
    };
    return(walk(payload)||'').trim().slice(0,max);
  }
  function listMailAttachments(payload){
    const out=[];
    const walk=(p,depth)=>{
      if(!p||depth>8)return;
      const filename=p.filename||'';
      const attId=p.body?.attachmentId;
      if(filename&&attId){
        out.push({
          filename,mimeType:p.mimeType||'application/octet-stream',
          size:p.body?.size||0,attachmentId:attId
        });
      }
      (p.parts||[]).forEach(x=>walk(x,depth+1));
    };
    walk(payload,0);
    return out;
  }
  function utf8ToBase64Url(str){
    const bytes=new TextEncoder().encode(str);
    let bin='';const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk)bin+=String.fromCharCode(...bytes.subarray(i,i+chunk));
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function bytesToBase64(str){
    const bytes=new TextEncoder().encode(str);
    let bin='';const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk)bin+=String.fromCharCode(...bytes.subarray(i,i+chunk));
    return btoa(bin);
  }
  function encodeRfc2047(s){
    if(!/[^\x20-\x7E]/.test(s))return s;
    return '=?UTF-8?B?'+bytesToBase64(s)+'?=';
  }
  function buildGmailReplyRaw({to,subject,body,inReplyTo,references}){
    const headers=[
      `To: ${String(to||'').trim()}`,
      `Subject: ${encodeRfc2047(String(subject||'').trim()||'(No subject)')}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64'
    ];
    if(inReplyTo)headers.push(`In-Reply-To: ${inReplyTo}`);
    if(references)headers.push(`References: ${references}`);
    const bodyB64=bytesToBase64(String(body||'').replace(/\r?\n/g,'\r\n')).replace(/.{1,76}/g,m=>m+'\r\n').trim();
    return utf8ToBase64Url(headers.join('\r\n')+'\r\n\r\n'+bodyB64+'\r\n');
  }
  function parseReplyAddress(v){
    const s=String(v||'').trim();
    const m=s.match(/<([^>]+)>/);
    return (m?m[1]:s).trim();
  }
  function isValidEmailAddr(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parseReplyAddress(v))}
  async function fetchMailDetail(mailId,{force}={}){
    if(!mailId||!token)return null;
    if(!force&&mailDetailCache[mailId])return mailDetailCache[mailId];
    try{
      const m=await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mailId)}?format=full`);
      const h=m.payload?.headers||[],from=parseFrom(header(h,'From'));
      const replyToRaw=header(h,'Reply-To')||header(h,'From');
      const replyTo=parseFrom((replyToRaw||'').split(',')[0]);
      const messageId=header(h,'Message-ID')||header(h,'Message-Id')||'';
      const prevRefs=header(h,'References')||'';
      const references=[prevRefs,messageId].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
      const attachments=listMailAttachments(m.payload);
      const detail={
        id:m.id,threadId:m.threadId,snippet:m.snippet||'',subject:header(h,'Subject')||'(No subject)',
        from,replyTo,replyEmail:replyTo.email||from.email||'',messageId,inReplyTo:messageId,references,
        date:new Date(header(h,'Date')||m.internalDate*1),
        body:decodeMailText(m.payload)||m.snippet||'',
        attachments,labelIds:m.labelIds||[]
      };
      mailDetailCache[mailId]=detail;return detail;
    }catch(e){
      console.warn('mail detail',e);
      const msg=String(e?.message||e||'');
      if(/403|insufficient|METADATA_SCOPE/i.test(msg))toast('Reconnect Google to read full email content');
      return null;
    }
  }
  async function fetchMailAttachment(mailId,attachmentId,filename){
    if(!mailId||!attachmentId||!token)return null;
    // Read-only: never modify Gmail. Fetch attachment bytes on demand only.
    try{
      const r=await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mailId)}/attachments/${encodeURIComponent(attachmentId)}`);
      const data=r?.data;if(!data)return null;
      const bin=atob(String(data).replace(/-/g,'+').replace(/_/g,'/'));
      const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
      const blob=new Blob([bytes],{type:'application/octet-stream'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download=filename||'attachment';a.rel='noopener';
      document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);
      return {ok:true,size:bytes.length,filename:filename||'attachment'};
    }catch(e){
      console.warn('attachment',e);
      toast('Could not download attachment',{type:'err'});
      return null;
    }
  }
  let replyState=null,replySending=false;
  function replyDraftKey(x){return String(x?.loopId||x?.id||x?.mailId||'')}
  function defaultReplySubject(subject){
    const s=String(subject||'').trim()||'(No subject)';
    return /^re\s*:/i.test(s)?s:`Re: ${s}`;
  }
  function suggestedReplyBody(loop,mail){
    const sug=loopSuggestion(loop);
    if(sug.kind==='reply')return sug.text;
    const name=(mail?.from?.name||loop.fromName||'').split(/\s+/)[0]||'there';
    return `Hi ${name},\n\nThanks for your email — I’ll follow up shortly.\n\nBest`;
  }
  function canReplyInApp(loop){
    if(!loop||!token)return false;
    if(!(loop.mailId||loop.threadId))return false;
    const email=loop.fromEmail||'';
    if(email&&AUTOMATED.test(email))return false;
    return loop.type==='reply'||loop.type==='followup'||!!loop.mailId;
  }
  function syncReplyFieldsFromDom(){
    if(!replyState||replyState.status==='sending'||replyState.status==='success')return;
    const to=$('#td-reply-to'),sub=$('#td-reply-subject'),body=$('#td-reply-body');
    if(to)replyState.to=to.value;
    if(sub)replyState.subject=sub.value;
    if(body)replyState.body=body.value;
  }
  async function openReplyComposer(loop){
    // V2 read-only release: Daylight never sends mail. Reply opens the original thread in Gmail.
    {const href=loop?.href||(loop?.threadId||loop?.mailId?gmailLink(loop.threadId||loop.mailId):'');
     if(href){feel.select();window.open(href,'_blank','noopener');toast('Opened in Gmail',{type:'ok'})}else toast('This item has no Gmail message to open',{type:'warn'});return}
    if(!canReplyInApp(loop)){toast('This item has no Gmail thread to reply to',{type:'warn'});return}
    if(!token){toast('Connect Google to reply',{type:'warn'});connectDialog({setup:true});return}
    feel.select();
    const mail=loop.mailId?await fetchMailDetail(loop.mailId):null;
    if(!mail&&loop.mailId){toast('Could not load this email for reply',{type:'err',haptic:'error'});return}
    const to=mail?.replyEmail||loop.fromEmail||mail?.from?.email||'';
    if(!to||!isValidEmailAddr(to)){toast('No recipient address on this email',{type:'warn'});return}
    const subject=defaultReplySubject(mail?.subject||loopSubject(loop));
    const prev=(replyState&&replyDraftKey(loop)===replyDraftKey(replyState)&&replyState.body!=null)?replyState:null;
    replyState={
      open:true,loopId:loop.id,loop,mailId:mail?.id||loop.mailId,threadId:mail?.threadId||loop.threadId||'',
      to:prev?.to||to,subject:prev?.subject||subject,body:prev?.body??suggestedReplyBody(loop,mail),
      messageId:mail?.messageId||'',inReplyTo:mail?.inReplyTo||mail?.messageId||'',references:mail?.references||mail?.messageId||'',
      status:'idle',error:'',sentId:''
    };
    tdTab='email';
    paintLoopDetail(loop,mail);
    requestAnimationFrame(()=>$('#td-reply-body')?.focus());
  }
  async function refreshThreadAfterSend(loop,mailId,threadId){
    if(mailId)delete mailDetailCache[mailId];
    try{
      if(threadId){
        const th=await api(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`);
        const last=(th.messages||[])[(th.messages||[]).length-1];
        if(last?.id)await fetchMailDetail(last.id,{force:true});
      }else if(mailId)await fetchMailDetail(mailId,{force:true});
    }catch(e){console.warn('thread refresh',e)}
    try{if(typeof loadLoops==='function')await loadLoops();else if(typeof refreshAll==='function')await refreshAll()}catch{}
    renderLoops();
    if(typeof renderInbox==='function')renderInbox({animate:false});
    if(typeof renderMobile==='function')renderMobile();
  }
  async function sendReplyFromComposer(){
    if(!replyState?.open||replySending)return;
    syncReplyFieldsFromDom();
    const loop=currentDetail()||replyState.loop;if(!loop)return;
    const to=String(replyState.to||'').trim();
    const subject=String(replyState.subject||'').trim();
    const body=String(replyState.body||'');
    if(!isValidEmailAddr(to)){
      replyState.status='error';replyState.error='Enter a valid recipient email.';paintLoopDetail(loop,mailDetailCache[replyState.mailId]||null);return
    }
    if(!body.trim()){replyState.status='error';replyState.error='Write a reply before sending.';paintLoopDetail(loop,mailDetailCache[replyState.mailId]||null);return}
    if(true){ // V2: sending is disabled in the read-only release (no gmail.send scope)
      replyState.status='error';replyState.error='Daylight is read-only. Open the email in Gmail to reply.';
      paintLoopDetail(loop,mailDetailCache[replyState.mailId]||null);
      toast('Reconnect Google to grant send access',{type:'warn'});
      return;
    }
    replySending=true;replyState.status='sending';replyState.error='';
    paintLoopDetail(loop,mailDetailCache[replyState.mailId]||null);
    try{
      const raw=buildGmailReplyRaw({
        to:parseReplyAddress(to),subject,body,
        inReplyTo:replyState.inReplyTo||replyState.messageId,
        references:replyState.references||replyState.messageId
      });
      const payload={raw};if(replyState.threadId)payload.threadId=replyState.threadId;
      const sent=await api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',body:payload});
      if(!sent?.id)throw new Error('Gmail did not confirm the send');
      replyState.status='success';replyState.sentId=sent.id;replyState.error='';replyState.open=true;
      const s=loopState();s[loop.id]={done:true,t:Date.now()};saveLoopState(s);
      toast('Reply sent',{type:'ok',haptic:'success'});
      await refreshThreadAfterSend(loop,replyState.mailId,replyState.threadId||sent.threadId);
      if(openLoopId===loop.id){
        const mail=replyState.mailId?await fetchMailDetail(replyState.mailId,{force:true}):null;
        paintLoopDetail(currentDetail()||loop,mail);
      }
    }catch(e){
      const msg=String(e?.message||e||'Send failed');
      const needsScope=/insufficient|ACCESS_TOKEN_SCOPE|403|scope/i.test(msg)||e?.status===403;
      replyState.status='error';
      replyState.error=needsScope?'Send permission missing. Reconnect Google and allow gmail.send, then retry.':(msg||'Could not send. Your draft is still here — tap Retry.');
      feel.error();
      toast(needsScope?'Reconnect Google to send':'Could not send reply',{type:'err',haptic:'error'});
      paintLoopDetail(currentDetail()||loop,mailDetailCache[replyState.mailId]||null);
    }finally{replySending=false}
  }
  let openLoopId=null,openDetail=null,loopSheetTimer=0;
  function dismissLoopSheet(instant){
    const sheet=$('#loop-sheet');if(!sheet||(!sheet.classList.contains('show')&&!sheet.classList.contains('closing')&&!instant))return;
    clearTimeout(loopSheetTimer);syncReplyFieldsFromDom();if(replyState)replyState.open=false;openLoopId=null;openDetail=null;sheet.setAttribute('aria-hidden','true');
    const card=sheet.querySelector('.loop-sheet-card');
    if(card){card.style.transition='';card.style.transform='';card.style.opacity=''}
    sheet.style.transition='';sheet.style.opacity='';
    const finish=()=>{sheet.classList.remove('closing','show');document.body.classList.remove('loop-open');sheet.removeEventListener('transitionend',onEnd)};
    const onEnd=e=>{if(e.target!==sheet&&!e.target?.classList?.contains('loop-sheet-card'))return;finish()};
    if(instant||window.DaylightNav?.reduced()){finish();return}
    sheet.classList.add('closing');sheet.classList.remove('show');
    sheet.addEventListener('transitionend',onEnd);loopSheetTimer=setTimeout(finish,260);
  }
  function closeLoopSheet(){
    const N=window.DaylightNav;
    if(N&&(N.topView()==='loop'||N.stack.some(x=>x.view==='loop'))){N.back();return}
    dismissLoopSheet();
  }
  function initialsOf(name){return String(name||'?').trim().split(/\s+/).slice(0,2).map(p=>p[0]||'').join('').toUpperCase()||'?'}
  function finNeedText(f){
    if(!f)return '';
    const pct=Math.round((f.confidence||0)*100)+'%';
    if(f.bucket==='outstanding'||f.bucket==='upcoming'&&f.obligation==='upcoming'&&f.status!=='scheduled_debit')return `Unpaid ${f.invoiceNumber?'invoice '+f.invoiceNumber:'bill'} with a due date in the email (${f.dueDate}). Daylight is ${pct} sure. Open Money to create a reminder.`;
    if(f.status==='scheduled_debit')return 'This bill will be paid automatically (direct debit / card on file). Nothing to do unless that fails.';
    if(f.bucket==='review')return `Daylight is not sure about this one (${pct}): ${f.obligationReason||((f.conflicts||[])[0])||'please check'}. It is not counted as something to pay.`;
    return `Daylight reads this as: ${f.label}${f.amount?' · '+window.DaylightFinance.fmtAmount(f.amount):''} (${pct} sure). Nothing to pay.`;
  }
  function inboxToDetail(item){
    const type=item.kind==='subscription'?'renewal':item.kind==='pending'?'overdue':item.kind==='bill'?'deadline':item.kind==='ticket'?'travel':'reply';
    const need=item.kind==='subscription'?'Review this subscription and cancel or confirm before renewal.'
      :item.kind==='pending'?'Settle this payment or check the receipt.'
      :item.kind==='bill'?'Review the bill and pay if needed.'
      :item.kind==='ticket'?'Keep this booking handy — saved to Wallet when available.'
      :item.kind==='shopping'?'Track this order, delivery or return.'
      :item.needsReview?'Needs review — confirm the right category for this email.'
      :'Review this email.';
    return {
      id:'inbox:'+item.id,type,title:item.title,detail:item.detail||item.subject||'',subject:item.subject||item.title,
      meta:item.meta,href:item.href,mailId:item.mailId||null,threadId:item.id||null,fromName:item.fromName||item.from||item.title,
      fromEmail:item.fromEmail||'',domain:item.domain||brandDomain(item.fromEmail,item.title),logo:item.logo||'',whenMs:item.whenMs||item.when||0,dueLabel:item.meta||'',category:item.tag||MONEY_LABEL[item.kind]||'Mail',
      amount:item.amount||'',urgent:!!item.urgent,weight:item.urgent||item.needsReview?2:1,snippet:item.snippet||'',
      status:item.status||'',recordKey:item.recordKey||'',needsReview:!!item.needsReview,_inbox:true,_need:item.fin?finNeedText(item.fin):need,_classified:!!item._classified,fin:item.fin||null
    };
  }
  function currentDetail(){return openDetail||findLoop(openLoopId)||null}
  function readFavs(){return readJSON('daylight-favs',{})}
  function isFav(id){return!!readFavs()[id]}
  function toggleFav(id){const f=readFavs();f[id]=!f[id];if(!f[id])delete f[id];writeJSON('daylight-favs',f);feel.select();return!!f[id]}
  let tdTab='details';
  function suggestedPrimaryAction(l){
    const mailish=!!(l.mailId||l.threadId||l.relatedMail||l._inbox||l.type==='reply'||l.type==='followup'||l.type==='renewal'||/mail\.google/i.test(l.href||''));
    if(mailish||l.type==='reply'||l.type==='followup')return{label:'Reply',act:'open-gmail'};
    if(l.type==='renewal'||l._inbox)return{label:'Open in Gmail',act:'open-gmail'};
    if(l.type==='prepare')return{label:'Open Calendar',act:'open-original'};
    if(l.type==='travel')return{label:'Open booking',act:'open-original'};
    if(l.type==='overdue'||l.type==='deadline')return{label:'Open Tasks',act:'open-original'};
    const sug=loopSuggestion(l);
    return{label:sug.primary&&!/open task/i.test(sug.primary)?sug.primary:'Take action',act:l.href?'open-original':'done'};
  }
  function paintLoopDetail(l,mail){
    const sug=loopSuggestion(l),prio=l.weight>=2||l.type==='overdue'||l.urgent;
    const whenTxt=l.meta||(l.whenMs?ago(new Date(l.whenMs)):'');
    const need=l._need||loopNote(l);
    const fromName=mail?.from?.name||l.fromName||srcOf(l);
    const subject=mail?.subject||loopSubject(l);
    const body=mail?.body||l.snippet||l.detail||'';
    const timeStr=mail?.date?mail.date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):(l.whenMs?new Date(l.whenMs).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'');
    const relatedMail=l.relatedMail||null;
    const isMail=!!(l.mailId||relatedMail||l._inbox||l.type==='reply'||l.type==='followup'||l.type==='renewal'||(l.href&&String(l.href).includes('mail.google')));
    const composing=!!(replyState?.open&&replyState.loopId===l.id);
    const navTitle=composing?'Reply':(isMail?'Email':'Task');
    const fav=isFav(l.id);
    const tab=composing?'email':(tdTab==='notes'?'notes':tdTab==='activity'?'activity':'details');
    const nav=$('.td-nav b');if(nav)nav.textContent=navTitle;
    const star=$('.td-nav [data-ls-fav]');if(star){star.classList.toggle('on',fav);star.setAttribute('aria-pressed',fav?'true':'false')}
    const tripPass=l.tripId?readWallet().filter(w=>w.tripId===l.tripId):[];
    const brand=loopSourceBrand(l);
    const mailFrom=mail?.from?.name||relatedMail?.from?.name||fromName;
    const mailEmail=mail?.from?.email||l.fromEmail||relatedMail?.from?.email||'';
    const mailSub=mail?.subject||relatedMail?.subject||subject;
    const logoBrand={...brand,fromEmail:mailEmail||brand.fromEmail,title:mailFrom||brand.title,domain:l.domain||brand.domain};
    const mid=mail?.id||l.mailId||relatedMail?.mailId||null;
    const linked=mid&&window.DaylightData?.linkedRecordsForMail?window.DaylightData.linkedRecordsForMail(mid):{orders:[],wallet:[],extraction:null};
    $('#ls-head').innerHTML=`<span class="td-ico m-brand" style="--a1:${esc(logoBrand.color)};--a2:${esc(logoBrand.color)}" aria-hidden="true">${brandLogoHTML(logoBrand,initialsOf(mailFrom||l.title))}</span>
      <div class="td-head-copy">${prio?`<span class="td-prio">Priority</span>`:''}<h2 id="ls-title">${esc(composing?'Write a reply':l.title)}</h2>
      <div class="td-meta-row"><span class="td-chip">${esc(srcOf(l)||'Daylight')}</span>${whenTxt?`<span class="td-chip">${esc(whenTxt)}</span>`:''}${l.amount?`<span class="td-chip accent">${esc(l.amount)}</span>`:''}${l.tripId?`<span class="td-chip">Trip</span>`:''}</div></div>`;
    const tripCard=tripPass.length?`<div class="td-card td-need"><span class="td-need-l">Linked trip</span>${tripPass.map(w=>`<p style="margin:6px 0 0"><button type="button" class="td-link" data-open-wallet="${esc(w.id)}">${esc(w.title)}</button> <small>${esc(w.typeLabel||WALLET_LABEL[w.kind]||'')}</small></p>`).join('')}</div>`:'';
    const linkedBits=[];
    (linked.orders||[]).forEach(o=>linkedBits.push(`<p style="margin:6px 0 0"><b>Order</b> ${esc(o.merchant||o.orderId||'Order')} <small>${esc(o.status||'')}</small></p>`));
    (linked.wallet||[]).forEach(w=>linkedBits.push(`<p style="margin:6px 0 0"><button type="button" class="td-link" data-open-wallet="${esc(w.id)}">${esc(w.title)}</button> <small>${esc(w.typeLabel||'Wallet')}</small></p>`));
    if(linked.extraction?.intent)linkedBits.push(`<p style="margin:6px 0 0"><small>AI · ${esc(linked.extraction.intent)}${linked.extraction.category?' · '+esc(linked.extraction.category):''}</small></p>`);
    const linkedCard=linkedBits.length?`<div class="td-card td-need"><span class="td-need-l">Linked records</span>${linkedBits.join('')}</div>`:'';
    const loadingMail=isMail&&!mail&&!!(l.mailId||relatedMail?.mailId)&&!!token;
    const mailBodyTxt=mail?body:(loadingMail?'Loading email from Gmail…':(body||l.detail||'No email body yet.'));
    const atts=(mail?.attachments||[]).filter(a=>a.attachmentId&&a.filename);
    const attHtml=atts.length?`<div class="td-mail-atts">${atts.map(a=>`<button type="button" class="td-att" data-mail-att="${esc(mail.id)}" data-att-id="${esc(a.attachmentId)}" data-att-name="${esc(a.filename)}">${esc(a.filename)}${a.size?` <small>${Math.max(1,Math.round(a.size/1024))} KB</small>`:''}</button>`).join('')}</div>`:'';
    const emailCard=`<div class="td-card td-mail" id="ls-mail">
        <div class="td-mail-h"><span class="td-av m-brand" style="--a1:${esc(logoBrand.color)};--a2:${esc(logoBrand.color)}">${brandLogoHTML(logoBrand,initialsOf(mailFrom))}</span><div><b>${esc(mailFrom||'Unknown sender')}</b><small>${esc(mailSub||'(No subject)')}</small></div><span class="td-mail-t">${esc(timeStr)}</span></div>
        <p class="td-mail-b">${esc(mailBodyTxt)}</p>
        ${attHtml}
      </div>`;
    const st=replyState&&replyState.loopId===l.id?replyState:null;
    const statusHtml=st?.status==='sending'?`<div class="td-compose-status is-sending" role="status">Sending…</div>`
      :st?.status==='success'?`<div class="td-compose-status is-ok" role="status">Sent via Gmail${st.sentId?` · ${esc(st.sentId.slice(0,10))}…`:''}</div>`
      :st?.status==='error'?`<div class="td-compose-status is-err" role="alert">${esc(st.error||'Send failed. Your draft is saved here.')}</div>`
      :(!hasGmailSend()?`<div class="td-compose-status is-warn" role="status">Reconnect Google once to allow sending from Daylight.</div>`:'');
    const compose=st?.open?`<div class="td-card td-compose" id="td-compose">
        <label class="td-compose-field"><span>To</span><input id="td-reply-to" type="email" autocomplete="email" value="${esc(st.to)}" ${st.status==='sending'||st.status==='success'?'readonly':''}></label>
        <label class="td-compose-field"><span>Subject</span><input id="td-reply-subject" type="text" value="${esc(st.subject)}" ${st.status==='sending'||st.status==='success'?'readonly':''}></label>
        <label class="td-compose-field"><span>Message</span><textarea id="td-reply-body" rows="8" ${st.status==='sending'||st.status==='success'?'readonly':''}>${esc(st.body)}</textarea></label>
        ${statusHtml}
      </div>`:'';
    const details=`
      ${isMail?emailCard:`<div class="td-card td-need"><span class="td-need-l">What needs to be done</span><p>${esc(need)}</p></div>`}
      ${isMail?`<div class="td-card td-need"><span class="td-need-l">Suggested</span><p>${esc(need)}</p></div>`:''}
      ${linkedCard}${l.fin?`<div class="td-card td-need"><span class="td-need-l">Money · ${esc(l.fin.label)}</span><p style="margin:6px 0 0">${esc(finNeedText(l.fin))}</p>${(l.fin.evidence||[]).slice(0,3).map(e=>`<p style="margin:4px 0 0;font-size:12.5px;opacity:.85">“${esc(e.text)}”</p>`).join('')}<p style="margin:8px 0 0"><button type="button" class="td-link" data-fin-open-sheet="${esc(l.fin.key)}">See evidence or correct it</button></p></div>`:''}${tripCard}
      ${!isMail?`<div class="td-card td-ai"><div class="td-ai-top"><span class="td-ai-ico" aria-hidden="true">✦</span><b>${esc(sug.label)}</b></div><p>${esc(sug.text)}</p></div>`:''}`;
    const email=`${isMail?emailCard:`<div class="td-card"><p class="td-mail-b">No email linked to this item.</p></div>`}${linkedCard}${tripCard}${compose}`;
    const notes=`<div class="td-card td-need"><span class="td-need-l">Notes</span><p>${esc(l.detail||l.snippet||'No notes yet.')}</p></div>${linkedCard}${tripCard}`;
    const activity=`<div class="td-card td-attrs">
        <div class="td-attr"><span class="td-attr-l">Source</span><span class="td-attr-v">${esc(srcOf(l))}</span></div>
        <div class="td-attr"><span class="td-attr-l">Updated</span><span class="td-attr-v">${esc(whenTxt||'—')}</span></div>
        <div class="td-attr"><span class="td-attr-l">Favourite</span><span class="td-attr-v">${fav?'Yes':'No'}</span></div>
        ${mid?`<div class="td-attr"><span class="td-attr-l">Mail id</span><span class="td-attr-v">${esc(mid.slice(0,12))}…</span></div>`:''}
        ${(mail?.attachments||[]).length?`<div class="td-attr"><span class="td-attr-l">Attachments</span><span class="td-attr-v">${mail.attachments.length}</span></div>`:''}
      </div>`;
    $('#ls-body').innerHTML=`
      <div class="td-tabs" role="tablist">
        <button type="button" class="td-tab${tab==='details'&&!composing?' on':''}" data-td-tab="details" ${composing?'disabled':''}>Details</button>
        <button type="button" class="td-tab${tab==='notes'&&!composing?' on':''}" data-td-tab="notes" ${composing?'disabled':''}>Notes</button>
        <button type="button" class="td-tab${tab==='activity'&&!composing?' on':''}" data-td-tab="activity" ${composing?'disabled':''}>Activity</button>
      </div>
      ${composing?email:tab==='notes'?notes:tab==='activity'?activity:details}`;
    if(composing){
      const sending=st.status==='sending',ok=st.status==='success',needReconnect=!hasGmailSend();
      $('#ls-foot').innerHTML=`${ok
        ?`<button class="td-primary" type="button" data-ls-act="close-compose">Done</button>`
        :`<button class="td-primary" type="button" data-ls-act="${needReconnect?'reconnect-send':(st.status==='error'?'retry-send':'send')}" ${sending?'disabled':''}>${sending?'Sending…':needReconnect?'Reconnect to send':st.status==='error'?'Retry send':'Send reply'}</button>`}
        <div class="td-sec td-sec-2"><button class="td-sec-btn" type="button" data-ls-act="cancel-compose" ${sending?'disabled':''}>${ok?'Close':'Cancel'}</button>
        <button class="td-sec-btn" type="button" data-ls-act="open-gmail" ${sending?'disabled':''}>Open in Gmail</button></div>`;
      return;
    }
    const primary=suggestedPrimaryAction(l);
    $('#ls-foot').innerHTML=`<button class="td-primary" type="button" data-ls-act="${primary.act}">${esc(primary.label)}</button>
      <div class="td-sec td-sec-3"><button class="td-sec-btn" type="button" data-ls-act="snooze">Snooze</button><button class="td-sec-btn" type="button" data-ls-act="remind">Reminder</button><button class="td-sec-btn" type="button" data-ls-act="done">Mark Done</button></div>`;
  }
  async function openLoopSheet(idOrObj){
    const l=typeof idOrObj==='object'&&idOrObj?idOrObj:findLoop(idOrObj);if(!l)return;
    openDetail=l;openLoopId=l.id;clearTimeout(loopSheetTimer);
    let sheet=$('#loop-sheet');
    if(!sheet){
      sheet=document.createElement('div');sheet.id='loop-sheet';sheet.className='loop-sheet';sheet.setAttribute('aria-hidden','true');
      sheet.innerHTML=`<div class="loop-sheet-card td-sheet" role="dialog" aria-modal="true" aria-labelledby="ls-title">
        <div class="td-nav"><button class="td-nav-btn" type="button" data-ls-close aria-label="Back">‹</button><b>Task Detail</b><span class="td-nav-right"><button class="td-nav-btn td-fav" type="button" data-ls-fav aria-label="Favourite" aria-pressed="false">☆</button><button class="td-nav-btn" type="button" data-ls-more aria-label="More">⋯</button></span></div>
        <div class="td-head" id="ls-head"></div>
        <div class="loop-sheet-body td-body" id="ls-body"></div>
        <div class="loop-sheet-foot td-foot" id="ls-foot"></div>
      </div>`;
      document.body.append(sheet);
      sheet.addEventListener('input',e=>{
        if(!replyState?.open||replyState.status==='sending')return;
        if(e.target.id==='td-reply-to')replyState.to=e.target.value;
        if(e.target.id==='td-reply-subject')replyState.subject=e.target.value;
        if(e.target.id==='td-reply-body')replyState.body=e.target.value;
      });
      sheet.addEventListener('click',e=>{
        if(e.target.closest('[data-ls-close]')){
          if(replyState?.open&&replyState.status!=='success'){syncReplyFieldsFromDom();replyState.open=false;feel.select();paintLoopDetail(currentDetail(),mailDetailCache[currentDetail()?.mailId]||null);return}
          closeLoopSheet();return
        }
        if(e.target.closest('[data-ls-fav]')){const loop=currentDetail();if(!loop)return;const on=toggleFav(loop.id);e.target.closest('[data-ls-fav]').classList.toggle('on',on);e.target.closest('[data-ls-fav]').textContent=on?'★':'☆';toast(on?'Added to favourites':'Removed from favourites',{type:'ok',ms:1600});return}
        if(e.target.closest('[data-ls-more]')){
          const loop=currentDetail();
          if(loop?.href){feel.select();window.open(loop.href,'_blank','noopener')}
          else toast('No original link for this item',{type:'warn'});
          return;
        }
        const tab=e.target.closest('[data-td-tab]');if(tab&&!tab.disabled){
          if(replyState?.open){syncReplyFieldsFromDom();replyState.open=false}
          tdTab=tab.dataset.tdTab;feel.select();paintLoopDetail(currentDetail(),null);if(currentDetail()?.mailId&&token&&tdTab==='email'){fetchMailDetail(currentDetail().mailId).then(m=>{if(m&&openLoopId===currentDetail()?.id)paintLoopDetail(currentDetail(),m)})}return
        }
        const attBtn=e.target.closest('[data-mail-att]');
        if(attBtn){
          feel.select();
          fetchMailAttachment(attBtn.dataset.mailAtt,attBtn.dataset.attId,attBtn.dataset.attName);
          return;
        }
        const act=e.target.closest('[data-ls-act]');if(!act||!openLoopId)return;
        const loop=currentDetail();if(!loop)return;
        const a=act.dataset.lsAct;
        if(a==='snooze'){const s=loopState();s[loop.id]={snooze:Date.now()+86400000,t:Date.now()};saveLoopState(s);closeLoopSheet();renderLoops();if(typeof renderInbox==='function')renderInbox({animate:false});toast('Snoozed until tomorrow',{type:'ok',haptic:'success'});return}
        if(a==='remind'){capture('Remind me: '+loop.title+(loop.dueLabel?' by '+loop.dueLabel:''));toast('Reminder added',{type:'ok',haptic:'success'});return}
        if(a==='done'){const s=loopState();s[loop.id]={done:true,t:Date.now()};saveLoopState(s);closeLoopSheet();renderLoops();if(typeof renderInbox==='function')renderInbox({animate:false});toast('Marked as done',{type:'ok',haptic:'success'});return}
        if(a==='open-gmail'||a==='reply'){openGmailApp(loop);return}
        if(a==='open-original'){
          const href=gmailHttpsUrl(loop)||loop.href;
          if(!href){toast('No link available',{type:'warn'});return}
          if(/mail\.google/i.test(href)){openGmailApp(loop);return}
          feel.select();window.open(href,'_blank','noopener');return
        }
        if(a==='open-related-mail'){openGmailApp({...loop,...(loop.relatedMail||{}),href:loop.relatedMail?.href||loop.href,mailId:loop.relatedMail?.mailId||loop.mailId,threadId:loop.relatedMail?.threadId||loop.threadId});return}
        const wOpen=e.target.closest('[data-open-wallet]');
        if(wOpen){
          feel.select();closeLoopSheet();
          const wid=wOpen.dataset.openWallet;
          const pass=readWallet().find(w=>w.id===wid);
          openTravelRecord({walletId:wid,mailId:pass?.mailId,threadId:pass?.threadId,childKey:pass?.childKey,recordKey:pass?.recordKey,entityKey:pass?.entityKey});
          return;
        }
        if(a==='cancel-compose'||a==='close-compose'){
          syncReplyFieldsFromDom();
          if(replyState)replyState.open=false;
          if(a==='close-compose'&&replyState?.status==='success'){closeLoopSheet();return}
          feel.select();paintLoopDetail(loop,mailDetailCache[loop.mailId]||null);return
        }
        if(a==='reconnect-send'){requestGmailSendAccess();return}
        if(a==='send'||a==='retry-send'){sendReplyFromComposer();return}
        if(a==='suggest'){
          if(canReplyInApp(loop)){openReplyComposer(loop);return}
          const sug=loopSuggestion(loop);
          capture(sug.text);toast(sug.cta==='Add reminder'?'Reminder added':'Task added',{type:'ok',haptic:'success'});
        }
      });
    }
    tdTab='details';
    const favBtn=sheet.querySelector('[data-ls-fav]');if(favBtn){const on=isFav(l.id);favBtn.classList.toggle('on',on);favBtn.textContent=on?'★':'☆';favBtn.setAttribute('aria-pressed',on?'true':'false')}
    paintLoopDetail(l,null);
    const wasOpen=sheet.classList.contains('show');
    clearTimeout(loopSheetTimer);sheet.classList.remove('closing');
    if(!wasOpen){
      sheet.classList.remove('show');void sheet.offsetWidth;
      sheet.classList.add('show');feel.tap();
    }else sheet.classList.add('show');
    sheet.setAttribute('aria-hidden','false');document.body.classList.add('loop-open');
    const N=window.DaylightNav;
    if(N){
      if(wasOpen&&N.topView()==='loop')N.replace('loop',l.id);
      else if(N.topView()!=='loop')N.push('loop',l.id);
    }
    const mailId=l.mailId||l.relatedMail?.mailId;
    if(mailId&&token){
      const mail=await fetchMailDetail(mailId);
      if(openLoopId===l.id&&mail)paintLoopDetail(openDetail||l,mail);
    }
  }
  function loopHTML(l){const t=LOOP_TYPES[l.type]||LOOP_TYPES.reply;const list=(wset('loops').view||'List')==='List';
    if(!list)return `<div class="loop ${t.cls}" data-loop="${esc(l.id)}" role="button" tabindex="0"><div class="loop-top"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span><span class="loop-type">${t.label}</span>${l.meta?`<span class="loop-meta">${esc(l.meta)}</span>`:''}</div><div class="loop-title">${esc(l.title)}</div><div class="loop-detail">${esc(l.detail)}</div>${l.related?`<a class="loop-related" href="${esc(l.related.webViewLink)}" target="_blank" rel="noopener">Related: ${esc(l.related.name)}</a>`:''}<div class="loop-actions"><button class="connect primary" type="button" data-open-loop="${esc(l.id)}">Expand</button><button class="connect ghost" type="button" data-act="snooze">Snooze</button><button class="connect ghost" type="button" data-act="done">Done</button></div></div>`;
    const tags=[];if(l.weight>=2||l.type==='overdue')tags.push(['Priority','hot']);const tg=TAGS[l.type];if(tg&&!(l.type==='overdue'))tags.push(tg);if(l.type==='overdue')tags.push(['Reschedule','']);
    return `<div class="arow ${t.cls}" data-loop="${esc(l.id)}" role="button" tabindex="0"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <div class="arow-main"><div class="arow-top"><b>${esc(l.title)}</b><span class="arow-src">${esc([srcOf(l),l.meta].filter(Boolean).join(' · '))}</span></div>
      <div class="arow-detail">${esc(l.detail)}${l.related?` · <a href="${esc(l.related.webViewLink)}" target="_blank" rel="noopener">${esc(l.related.name)}</a>`:''}</div>
      <div class="arow-foot"><span class="arow-tags">${tags.map(([x,c])=>`<span class="atag ${c}">${x}</span>`).join('')}</span><span class="arow-actions"><button class="connect primary" type="button" data-open-loop="${esc(l.id)}">Expand</button><button class="connect ghost" type="button" data-act="snooze">Snooze</button><button class="connect ghost" type="button" data-act="done" aria-label="Mark done">Done</button></span></div></div></div>`}
  // ======== Mobile app (≤680px): Home · Inbox · Wallet · Assistant · Statistics ========
  function logDone(t){if(!t)return;try{const l=JSON.parse(localStorage.getItem('daylight-done-log')||'[]');l.push({id:t.id,title:t.title,project:t.project||'',at:new Date().toISOString()});localStorage.setItem('daylight-done-log',JSON.stringify(l.slice(-500)))}catch{}}
  function logFocus(min){try{const l=JSON.parse(localStorage.getItem('daylight-focus-log')||'[]');l.push({min,at:new Date().toISOString()});localStorage.setItem('daylight-focus-log',JSON.stringify(l.slice(-500)))}catch{}}
  const mq=matchMedia('all'); // the app layout is used on every screen size (widget dashboard retired)
  const deskMq=matchMedia('(min-width:1100px)'); // laptop: tabs live in a left sidebar
  const ICON={
    home:'<path d="M12 3.1 2.8 10.6c-.35.28-.2.8.22.8H5.2V19a2 2 0 0 0 2 2h3.1v-5.4h3.4V21H16.8a2 2 0 0 0 2-2v-7.6h2.18c.42 0 .57-.52.22-.8L12 3.1Z"/>',
    inbox:'<path d="M4.2 7.1A2.6 2.6 0 0 1 6.8 4.5h10.4a2.6 2.6 0 0 1 2.6 2.6v2.2l-3.35.15a2.7 2.7 0 0 0-2.45 1.55l-.25.5a1.3 1.3 0 0 1-1.15.7h-1.7a1.3 1.3 0 0 1-1.15-.7l-.25-.5A2.7 2.7 0 0 0 7.55 9.45L4.2 9.3V7.1Zm0 3.7 3.2.14a4.2 4.2 0 0 1 3.8 2.4l.12.24h1.36l.12-.24a4.2 4.2 0 0 1 3.8-2.4l3.2-.14V17a2.6 2.6 0 0 1-2.6 2.6H6.8A2.6 2.6 0 0 1 4.2 17V10.8Z"/>',
    wallet:'<path d="M4.2 7A2.3 2.3 0 0 1 6.5 4.7h11A2.3 2.3 0 0 1 19.8 7V8.2H4.2V7Zm0 2.7h15.6V16.8A2.3 2.3 0 0 1 17.5 19.1h-11A2.3 2.3 0 0 1 4.2 16.8V9.7Zm11.2 3.6a1.2 1.2 0 1 0 0 2.4h2.4v-2.4h-2.4Z"/>',
    calendar:'<path d="M8.2 3.2a1 1 0 0 1 1 1V5h5.6v-.8a1 1 0 1 1 2 0V5h.5A2.5 2.5 0 0 1 19.8 7.5V9H4.2V7.5A2.5 2.5 0 0 1 6.7 5h.5v-.8a1 1 0 0 1 1-1ZM4.2 10.5h15.6v8A2.5 2.5 0 0 1 17.3 21H6.7a2.5 2.5 0 0 1-2.5-2.5v-8Zm10.4 3.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/>',
    assistant:'<path d="M12 2.8 14.2 7.4l4.9.4-3.7 3.3 1.1 4.8L12 13.6 7.5 15.9l1.1-4.8-3.7-3.3 4.9-.4L12 2.8Z"/>',
    stats:'<path d="M5 19.4h2.6V10.2H5v9.2Zm5.7 0h2.6V6.6h-2.6v12.8Zm5.7 0H19V13h-2.6v6.4Z"/>',
    heart:'<path d="M12 20.7S4.4 16 4.4 10.6A4.2 4.2 0 0 1 12 7.1a4.2 4.2 0 0 1 7.6 3.5C19.6 16 12 20.7 12 20.7Z"/>',
    flame:'<path d="M12.2 3.4s2.6 2.8 2.6 6.1c0 0 1.4-1.1 1.8-2.8 2.1 1.9 3.2 3.8 3.2 6.4 0 4-3 6.7-7.6 6.7S4.6 17.1 4.6 13.1c0-2.8 1.6-4.8 3.4-6.4C8.3 8.4 9.2 9.4 9.2 11c0-2.6 2-5.4 3-7.6Z"/>',
    shoe:'<path d="M4.2 15.2h9.4c1.5 0 2.5.5 3.6 1.5l1.6 1.4H4.2v-2.9Zm.8-1.2c.5-2.6 1.8-5.8 4.8-7.1 1.7-.8 3.7-.3 4.8 1.2l1.4 1.8-2.2 1.1H9.4l-.6 3Z"/>',
    bed:'<path d="M4.2 18.8V12A2.4 2.4 0 0 1 6.6 9.6h4.1A2.8 2.8 0 0 1 13.5 12.4V18.8H4.2Zm9.3-6.2h5.9A2.4 2.4 0 0 1 21.8 15v3.8h-8.3v-6.2ZM4.2 18.8h17.6V20.2H4.2V18.8ZM7.1 9.6V7.4A1.6 1.6 0 0 1 8.7 5.8h2.1A1.6 1.6 0 0 1 12.4 7.4v2.2H7.1Z"/>',
    run:'<path d="M14.6 7.2a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM7.4 20.2l2.4-4.6 2.6-1.7 1.8 1.8 3.4 1-1-2.4-2.6-1.4 1.6-2-2.1-1.4-3.2 3.4-2.3 1.6 1.4 5.7Z"/>',
    bulb:'<path d="M12 3.2a5.2 5.2 0 0 1 3.6 8.9c-.6.6-1 1.4-1.1 2.4h-5c-.1-1-.5-1.8-1.1-2.4A5.2 5.2 0 0 1 12 3.2ZM9.6 16.8h4.8v1.5H9.6V16.8Zm.6 2.4h3.6V21H10.2v-1.8Z"/>',
    search:'<path fill-rule="evenodd" d="M10.5 3.6a6.9 6.9 0 1 0 4.33 12.27l3.9 3.9a1.15 1.15 0 0 0 1.63-1.63l-3.9-3.9A6.9 6.9 0 0 0 10.5 3.6Zm0 2.3a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Z"/>',
    bell:'<path d="M12 3.3a6.2 6.2 0 0 0-6.2 6.2v3.3l-1.4 2.5A1.15 1.15 0 0 0 5.4 17.3h13.2a1.15 1.15 0 0 0 1-1.99l-1.4-2.5V9.5A6.2 6.2 0 0 0 12 3.3Zm-2.2 15.4a2.2 2.2 0 0 0 4.4 0h-4.4Z"/>',
    filter:'<path d="M4.2 6.2A1.1 1.1 0 0 1 5.3 5.4h13.4a1.1 1.1 0 0 1 0 2.2H5.3A1.1 1.1 0 0 1 4.2 6.2Zm2.6 5.3A1.1 1.1 0 0 1 7.9 10.6h8.2a1.1 1.1 0 0 1 0 2.2H7.9a1.1 1.1 0 0 1-1.1-1.3Zm2.8 5.3a1.1 1.1 0 0 1 1.1-.9h3.6a1.1 1.1 0 0 1 0 2.2h-3.6a1.1 1.1 0 0 1-1.1-1.3Z"/>',
    back:'<path d="M14.7 5.2a1.15 1.15 0 0 1 0 1.63L10.54 12l4.16 5.17a1.15 1.15 0 1 1-1.8 1.44L8 12.72a1.15 1.15 0 0 1 0-1.44l4.9-5.89a1.15 1.15 0 0 1 1.8 0Z"/>',
    clock:'<path fill-rule="evenodd" d="M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Zm.95 4.4a.95.95 0 1 0-1.9 0v4.2c0 .3.15.58.4.76l2.85 1.95a.95.95 0 0 0 1.06-1.58L12.95 11.3V7.6Z"/>',
    phone:'<path d="M8.2 2.8h7.6A2.2 2.2 0 0 1 18 5v14a2.2 2.2 0 0 1-2.2 2.2H8.2A2.2 2.2 0 0 1 6 19V5A2.2 2.2 0 0 1 8.2 2.8Zm2.6 15.4h2.4a.8.8 0 0 1 0 1.6h-2.4a.8.8 0 0 1 0-1.6Z"/>',
    chevron:'<path d="M9.15 5.25a1.1 1.1 0 0 1 1.56 0l5.5 5.5a1.1 1.1 0 0 1 0 1.56l-5.5 5.5a1.1 1.1 0 1 1-1.56-1.56L13.9 12 9.15 7.25a1.1 1.1 0 0 1 0-2Z"/>',
    sunFill:'<circle cx="12" cy="12" r="4.9"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(0 12 12)"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(45 12 12)"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(90 12 12)"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(135 12 12)"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(180 12 12)"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(225 12 12)"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(270 12 12)"/><rect x="11" y="1.6" width="2" height="4.2" rx="1" transform="rotate(315 12 12)"/>',
    spark:'<path d="M12 2.6 13.4 8.4l5.8.5-4.45 3.9 1.25 5.7L12 15.4 7.99 18.5l1.26-5.7-4.45-3.9 5.8-.5L12 2.6Z"/>',
    scan:'<path d="M6.4 3.6h2.2a1 1 0 0 1 0 2H6.4A1.4 1.4 0 0 0 5 7v2.2a1 1 0 0 1-2 0V7A3.4 3.4 0 0 1 6.4 3.6Zm9 0h2.2A3.4 3.4 0 0 1 21 7v2.2a1 1 0 0 1-2 0V7a1.4 1.4 0 0 0-1.4-1.4h-2.2a1 1 0 0 1 0-2ZM4 14.8a1 1 0 0 1 1 1V17a1.4 1.4 0 0 0 1.4 1.4h2.2a1 1 0 0 1 0 2H6.4A3.4 3.4 0 0 1 3 17v-1.2a1 1 0 0 1 1-1Zm16 0a1 1 0 0 1 1 1V17a3.4 3.4 0 0 1-3.4 3.4h-2.2a1 1 0 0 1 0-2h2.2A1.4 1.4 0 0 0 19 17v-1.2a1 1 0 0 1 1-1ZM7.2 11a1 1 0 0 1 1-1h7.6a1 1 0 0 1 0 2H8.2a1 1 0 0 1-1-1Z"/>',
    chat:'<path d="M6.6 4.4h10.8A2.6 2.6 0 0 1 20 7v6.2a2.6 2.6 0 0 1-2.6 2.6h-5.3L7.2 19.6v-3.8H6.6A2.6 2.6 0 0 1 4 13.2V7a2.6 2.6 0 0 1 2.6-2.6Z"/>',
    suitcase:'<path d="M9.2 5.4A1.6 1.6 0 0 1 10.8 3.8h2.4A1.6 1.6 0 0 1 14.8 5.4V7h-5.6V5.4ZM4.6 8.2h14.8A2.2 2.2 0 0 1 21.6 10.4V18a2.2 2.2 0 0 1-2.2 2.2H6.8A2.2 2.2 0 0 1 4.6 18V10.4A2.2 2.2 0 0 1 6.8 8.2h-2.2Zm0 4.4h14.8v1.8H4.6v-1.8Z"/>',
    chevDown:'<path d="M6.25 9.15a1.1 1.1 0 0 1 1.56 0L12 13.34l4.19-4.19a1.1 1.1 0 1 1 1.56 1.56l-4.97 4.97a1.1 1.1 0 0 1-1.56 0L6.25 10.71a1.1 1.1 0 0 1 0-1.56Z"/>',
    target:'<path fill-rule="evenodd" d="M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Zm0 3.1a5.7 5.7 0 1 1 0 11.4 5.7 5.7 0 0 1 0-11.4Zm0 2.6a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Zm0 2.05a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1Z"/>',
    laptop:'<path d="M4.4 5.2h15.2A1.8 1.8 0 0 1 21.4 7v8.4H2.6V7A1.8 1.8 0 0 1 4.4 5.2ZM2.2 17h19.6a1.1 1.1 0 0 1 0 2.2H2.2a1.1 1.1 0 0 1 0-2.2Z"/>',
    layers:'<path d="M12 3.4 3.6 8.1 12 12.8l8.4-4.7L12 3.4Zm-8.4 8.1L12 16.2l8.4-4.7v2.4L12 18.6 3.6 13.9v-2.4Z"/>',
    receipt:'<path d="M6.4 3.4h11.2v17.4l-1.8-1-1.8 1-1.8-1-1.8 1-1.8-1-1.8 1V3.4Zm2.4 3.2v1.6h6.4V6.6H8.8Zm0 3.2v1.6h6.4V9.8H8.8Zm0 3.2v1.6h4.4v-1.6H8.8Z"/>',
    ticket:'<path d="M3.6 8.2A2.2 2.2 0 0 1 5.8 6h12.4a2.2 2.2 0 0 1 2.2 2.2v2.1a1.6 1.6 0 1 0 0 3.2v2.3A2.2 2.2 0 0 1 18.2 18H5.8A2.2 2.2 0 0 1 3.6 15.8v-2.3a1.6 1.6 0 1 0 0-3.2V8.2Zm6.2.8v6.2h1.6V9h-1.6Z"/>',
    star:'<path d="M12 3.2 14.4 9l6.2.5-4.7 3.9 1.5 6L12 16.4 6.6 19.4l1.5-6-4.7-3.9L9.6 9 12 3.2Z"/>',
    check:'<path fill-rule="evenodd" d="M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Zm4.05 6.05a.95.95 0 1 0-1.34-1.35L10.6 12l-1.7-1.7a.95.95 0 1 0-1.35 1.34l2.38 2.38c.37.37.97.37 1.34 0l4.78-4.77Z"/>'
  };
  const svg=(d,w=22)=>`<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="currentColor" aria-hidden="true">${d}</svg>`;
  const tabIco=(d)=>`<span class="m-tab-ico" aria-hidden="true">${svg(d,24)}</span>`;
  const pillIco=(d,cls='')=>`<span class="m-pill-ico${cls?' '+cls:''}" aria-hidden="true">${svg(d,14)}</span>`;
  const mapp=document.createElement('div');mapp.id='mapp';mapp.className='mapp';
  mapp.innerHTML=`<header class="m-top"><span class="m-title" id="m-title"></span><span class="m-top-actions"><button class="m-circle" id="m-search" type="button" aria-label="Search or ask">${svg(ICON.search,18)}</button><button class="m-circle" id="m-bell" type="button" aria-label="Notifications">${svg(ICON.bell,18)}<i class="m-dot" hidden></i></button><button class="m-avatar" id="m-avatar" type="button" aria-label="Menu"></button></span></header>
   <div class="m-stage" id="m-stage">
   <section class="m-screen is-active" data-screen="home"><div class="m-date" id="m-date"></div><h2 class="m-hello" id="m-hello"></h2>
     <section class="m-brief" id="m-brief" aria-label="Daily brief"></section>
     <div class="m-stat-grid" id="m-home-stats" hidden></div>
     <section class="m-schedule" id="m-schedule" aria-label="Today’s schedule">
       <div class="m-schedule-head"><h3>Today’s Schedule</h3><button type="button" class="m-schedule-link" id="m-schedule-cal">View Calendar ${svg(ICON.chevron,14)}</button></div>
       <p class="m-schedule-prose" id="m-schedule-prose"></p>
       <div class="m-schedule-rail" id="m-schedule-rail"></div>
     </section>
     <div class="m-home-block" id="m-loops-block">
       <div class="m-sec-head"><h3 class="m-sec-title">Priority Actions <span class="m-count-pill" id="m-loop-total" hidden></span></h3><button class="m-see-all" type="button" id="m-loops-see">See All ${svg(ICON.chevron,14)}</button></div>
       <div class="m-prio-tabs m-pills" id="m-prio-tabs" role="tablist" aria-label="Priority filters">
         <button type="button" role="tab" data-prio="week" class="on" aria-selected="true">${pillIco(ICON.calendar,'ico-blue')}Next 7 Days</button>
         <button type="button" role="tab" data-prio="payments" aria-selected="false">${pillIco(ICON.wallet,'ico-purple')}Payments</button>
         <button type="button" role="tab" data-prio="deadlines" aria-selected="false">${pillIco(ICON.check,'ico-green')}Deadlines</button>
         <button type="button" role="tab" data-prio="travel" aria-selected="false">${pillIco(ICON.calendar,'ico-blue')}Travel</button>
       </div>
       <div class="m-loop-list" id="m-loop-grid"></div>
       <div class="loops-foot" id="m-loops-foot" hidden></div>
     </div>
     <section class="m-home-health" id="m-home-health" aria-label="Today’s health">
       <div class="m-sec-head"><h3 class="m-sec-title">Today’s Health</h3><button type="button" class="m-see-all" id="m-health-see">Open ${svg(ICON.chevron,14)}</button></div>
       <div class="m-health-strip" id="m-health-strip"></div>
     </section>
   </section>
   <section class="m-screen" data-screen="inbox" hidden>
     <div class="m-inbox-head"><div class="m-inbox-tabs m-pills" role="tablist" id="m-inbox-tabs" aria-label="Inbox categories"><i class="m-inbox-thumb" id="m-inbox-thumb" aria-hidden="true" hidden></i><button type="button" role="tab" data-inbox="all" class="on" aria-selected="true">All</button><button type="button" role="tab" data-inbox="subscriptions" aria-selected="false">${pillIco(ICON.layers,'ico-purple')}Subscriptions</button><button type="button" role="tab" data-inbox="payments" aria-selected="false">${pillIco(ICON.wallet,'ico-green')}Payments</button><button type="button" role="tab" data-inbox="receipts" aria-selected="false">${pillIco(ICON.receipt,'ico-orange')}Receipts</button><button type="button" role="tab" data-inbox="bills" aria-selected="false">${pillIco(ICON.receipt,'ico-red')}Bills</button><button type="button" role="tab" data-inbox="tickets" aria-selected="false">${pillIco(ICON.ticket,'ico-blue')}Tickets</button><button type="button" role="tab" data-inbox="important" aria-selected="false">${pillIco(ICON.star,'ico-orange')}Important</button><button type="button" role="tab" data-inbox="promotions" aria-selected="false">${pillIco(ICON.spark,'ico-purple')}Promotions</button></div><button class="m-inbox-filter" id="m-inbox-filter" type="button" aria-label="Filter">${svg(ICON.filter,16)}</button></div>
     <div id="m-inbox"></div>
   </section>
   <section class="m-screen" data-screen="wallet" hidden>
     <div class="m-wallet-head"><div class="m-wallet-tabs m-pills" role="tablist" id="m-wallet-tabs" aria-label="Wallet categories"><i class="m-wallet-thumb" id="m-wallet-thumb" aria-hidden="true" hidden></i><button type="button" role="tab" data-wallet="all" class="on" aria-selected="true">All</button><button type="button" role="tab" data-wallet="tickets" aria-selected="false">${pillIco(ICON.ticket,'ico-blue')}Tickets</button><button type="button" role="tab" data-wallet="documents" aria-selected="false">${pillIco(ICON.receipt,'ico-purple')}Documents</button><button type="button" role="tab" data-wallet="payments" aria-selected="false">${pillIco(ICON.wallet,'ico-green')}Payments</button><button type="button" role="tab" data-wallet="cards" aria-selected="false">${pillIco(ICON.wallet,'ico-orange')}Cards</button></div></div>
     <div id="m-wallet"></div>
   </section>
   <section class="m-screen" data-screen="calendar" hidden><div class="m-cal-head"><button class="m-arrow" type="button" data-wk="-1" aria-label="Previous week">‹</button><b id="m-month"></b><button class="m-arrow" type="button" data-wk="1" aria-label="Next week">›</button><span class="m-pill">Week</span></div><div class="m-week" id="m-week"></div><div class="m-day" id="m-day"></div></section>
   <section class="m-screen" data-screen="assistant" hidden>
     <div class="tl-cal" id="tl-cal">
       <div class="tl-cal-nav"><button type="button" data-tl-wk="-1" aria-label="Previous week">‹</button><b id="tl-cal-month"></b><button type="button" data-tl-wk="1" aria-label="Next week">›</button></div>
       <div class="tl-week" id="tl-week" role="tablist" aria-label="Choose day"></div>
     </div>
     <div class="tl-view" id="tl-view">
       <div class="tl-head">
         <h2 id="tl-heading"></h2>
         <div class="tl-head-meta"><span class="tl-count" id="tl-count" hidden><span aria-hidden="true">${svg(ICON.calendar,14)}</span><b id="tl-count-n">0</b></span></div>
       </div>
       <div class="tl-list" id="tl-list"></div>
     </div>
     <div class="tl-chat" id="tl-chat-wrap" hidden>
       <div class="m-chat" id="m-chat"></div>
       <form class="m-msg" id="m-msg"><input id="m-msg-input" placeholder="Ask about your day…" autocomplete="off" aria-label="Message Daylight"><button type="submit" aria-label="Send"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m21 3-9.5 18-2-7.5L2 11.5Z"/><path d="m9.5 13.5 5-5"/></svg></button></form>
     </div>
   </section>
   <section class="m-screen" data-screen="stats" hidden><div id="m-stats"></div></section>
   </div>
   <nav class="m-tabs" aria-label="Sections"><i class="m-tab-thumb" id="m-tab-thumb" aria-hidden="true"></i><span class="m-side-brand" aria-hidden="true"><i></i>Daylight</span><button data-tab="home" type="button">${tabIco(ICON.home)}<span>Home</span></button><button data-tab="inbox" type="button">${tabIco(ICON.inbox)}<span>Inbox</span></button><button data-tab="wallet" type="button">${tabIco(ICON.wallet)}<span>Wallet</span></button><button data-tab="assistant" type="button">${tabIco(ICON.calendar)}<span>Timeline</span></button><button data-tab="stats" type="button">${tabIco(ICON.heart)}<span>Health</span></button></nav>
   <button type="button" class="m-wallet-fab" id="m-wallet-fab" aria-label="Scan document" hidden>${svg(ICON.scan,22)}</button>`;
  document.body.append(mapp);
  const scanUI=document.createElement('div');scanUI.id='m-scan';scanUI.className='m-scan';scanUI.hidden=true;scanUI.setAttribute('aria-hidden','true');
  scanUI.innerHTML=`<div class="m-scan-landing" id="m-scan-landing">
      <div class="m-scan-top"><button class="m-scan-round" type="button" data-scan-close aria-label="Back">${svg(ICON.back,20)}</button><button class="m-scan-round" type="button" data-scan-history aria-label="History">${svg(ICON.clock,20)}</button></div>
      <div class="m-scan-body"><div class="phone">${svg(ICON.phone,40)}</div><h2>Use your camera to scan document</h2><p>Choose a place with good lighting.</p></div>
      <div class="m-scan-foot"><button class="m-scan-cta" type="button" id="m-scan-start">Start scanning</button></div>
    </div>
    <div class="m-scan-camera" id="m-scan-camera" hidden>
      <div class="m-scan-top"><button class="m-scan-round" type="button" data-scan-close aria-label="Back">${svg(ICON.back,20)}</button><button class="m-scan-round" type="button" data-scan-history aria-label="History">${svg(ICON.clock,20)}</button></div>
      <div class="m-scan-view"><video id="m-scan-video" playsinline autoplay muted></video><div class="m-scan-frame"></div><div class="m-scan-beam"></div><canvas id="m-scan-canvas" hidden></canvas></div>
      <div class="m-scan-foot"><button class="m-scan-shot" type="button" id="m-scan-capture" aria-label="Capture"></button><input id="m-scan-file" type="file" accept="image/*" capture="environment" hidden></div>
    </div>
    <div class="m-scan-process" id="m-scan-process" hidden>
      <div class="spin" aria-hidden="true"></div>
      <h2 id="m-scan-process-title">Reading document…</h2>
      <p id="m-scan-process-copy">Detecting edges, extracting text, and structuring fields.</p>
    </div>
    <div class="m-scan-review" id="m-scan-review" hidden>
      <div class="m-scan-top"><button class="m-scan-round" type="button" data-scan-close aria-label="Back">${svg(ICON.back,20)}</button><span style="font:650 16px var(--font)">Confirm details</span><span style="width:44px"></span></div>
      <div class="m-scan-save">
        <img id="m-scan-preview" alt="Scan preview">
        <span class="m-scan-badge" id="m-scan-engine">Ready to confirm</span>
        <label>Title<input id="m-scan-title" maxlength="60" placeholder="Document name"></label>
        <div class="m-scan-grid">
          <label>Category<select id="m-scan-cat"><option value="documents">Documents</option><option value="tickets">Tickets</option><option value="coupons">Coupons</option><option value="others">Others</option></select></label>
          <label>Date<input id="m-scan-date" maxlength="40" placeholder="Optional"></label>
        </div>
        <div class="m-scan-grid">
          <label>Amount<input id="m-scan-amount" maxlength="24" placeholder="Optional"></label>
          <label>Note<input id="m-scan-note" maxlength="80" placeholder="Short summary"></label>
        </div>
        <label>Extracted text<textarea id="m-scan-ocr" placeholder="OCR text appears here — edit if needed"></textarea></label>
        <div class="m-scan-actions"><button class="m-scan-cta ghost" type="button" id="m-scan-retake">Retake</button><button class="m-scan-cta" type="button" id="m-scan-save">Confirm & add</button></div>
      </div>
    </div>`;
  document.body.append(scanUI);
  // move overlays out of the desktop shell so they work on the phone too
  ['#drawer-scrim','#drawer','#overlay'].forEach(s=>{const el=$(s);if(el)document.body.append(el)});
  let mTab=getLS('daylight-mtab')||'home',mInboxFilter=getLS('daylight-inbox-filter')||'all',mWalletFilter=getLS('daylight-wallet-filter')||'all',mWalletOpen='',mSel=new Date(localMidnight),mAssistDay=new Date(localMidnight),mAssistAsk=false,mChat=[],scanStream=null,scanDraft=null,scanExtract=null;
  if(!['all','subscriptions','payments','receipts','bills','tickets','important','promotions','subscription','bill','ticket','shopping','other'].includes(mInboxFilter))mInboxFilter='all';
  // Migrate legacy inbox filter ids
  if(mInboxFilter==='subscription')mInboxFilter='subscriptions';
  if(mInboxFilter==='bill')mInboxFilter='bills';
  if(mInboxFilter==='ticket')mInboxFilter='tickets';
  if(mInboxFilter==='shopping')mInboxFilter='receipts';
  if(mInboxFilter==='other')mInboxFilter='important';
  if(!['all','tickets','documents','payments','cards','coupons','others'].includes(mWalletFilter))mWalletFilter='all';
  if(mWalletFilter==='coupons'||mWalletFilter==='others')mWalletFilter='cards';
  if(mTab==='calendar')mTab='inbox';
  const TITLES={home:'Daylight',inbox:'Inbox',wallet:'Wallet',calendar:'Calendar',assistant:'Timeline',stats:'Health'};
  const WALLET_COLORS={tickets:['#1f6feb','#0b3d91'],coupons:['#d9480f','#a33b0a'],documents:['#2f9e44','#1b6b2e'],others:['#7048e8','#4c2db3']};
  const WALLET_LABEL={tickets:'Ticket',coupons:'Coupon',documents:'Document',others:'Pass'};
  function qrUrl(payload,size){return(window.DaylightScan?.qrImageUrl?.(payload,size))||('https://api.qrserver.com/v1/create-qr-code/?size='+(size||200)+'x'+(size||200)+'&margin=8&data='+encodeURIComponent(payload))}
  function barcodeUrl(payload){return(window.DaylightScan?.barcodeImageUrl?.(payload))||('https://bwipjs-api.metafloor.com/?bcid=code128&text='+encodeURIComponent(payload)+'&scale=3&includetext&guardwhitespace')}
  function readWallet(){
    const raw=readJSON('daylight-wallet',null);
    // Never seed fabricated tickets/QR. Empty wallet stays empty until real mail/scan data arrives.
    if(!Array.isArray(raw))return [];
    const Data=window.DaylightData;
    let list=raw;
    let changed=false;
    // Phase 14: idempotent canonical id normalize (ticket: → mail:, merge duplicates, keep richest QR)
    if(Data?.normalizeWalletIds){
      const norm=Data.normalizeWalletIds(list);
      if(norm.changed){list=norm.list;changed=true}
      else list=norm.list;
    }
    list.forEach(i=>{
      // Only render QR/barcode images when marked authentic (scan/attachment) — never invent codes from PNR/mailId
      if(i.qrAuthentic||i.barcodeAuthentic||i.exactQr||i.scanSource){
        if(i.qrPayload&&!i.qrImage){i.qrImage=qrUrl(i.qrPayload,220);changed=true}
        if((i.barcode||i.qrPayload)&&!i.barcodeImage){i.barcodeImage=barcodeUrl(i.barcode||i.qrPayload);changed=true}
      }else{
        if(i.qrImage&&!i.qrAuthentic&&!i.scanSource){delete i.qrImage;changed=true}
        if(i.barcodeImage&&!i.barcodeAuthentic&&!i.scanSource){delete i.barcodeImage;changed=true}
      }
      // travelAt only from reliable depart — never from email received `at`
      if(!i.travelAt&&i.flight?.depart&&/\d{4}-\d{2}-\d{2}/.test(String(i.flight.depart))){
        const d=new Date(i.flight.depart);if(!isNaN(d)){i.travelAt=d.toISOString();i.eventAt=i.eventAt||d.toISOString();changed=true}
      }
      if(i.kind==='tickets'&&!i.flight&&/\b(→|->|seat|flight|gate|coach)\b/i.test(i.note||i.title||'')){
        i.flight=window.DaylightScan?.extractFlight?.([i.title,i.note,i.ocr].filter(Boolean).join('\n'))||null;if(i.flight)changed=true;
      }
    });
    if(changed)writeJSON('daylight-wallet',list.slice(0,80));
    return list;
  }
  function saveWallet(list){writeJSON('daylight-wallet',list.slice(0,80));try{queueDaylightHydrate?.()}catch{}}
  /* ---- Cross-app intelligence: travel Wallet, trips, meeting↔mail, payment tasks ---- */
  function mailSearchText(m){
    const h=m?.payload?.headers||[];
    return [header(h,'Subject'),header(h,'From'),header(h,'To'),m?.snippet||''].join(' ');
  }
  function parseFlexibleDate(text,fallback){
    const found=parseFlexibleDateOrNull(text);
    if(found)return found;
    return fallback instanceof Date&&!isNaN(fallback)?fallback:new Date();
  }
  /** Travel-safe parser: returns null when no reliable date (never invent for Timeline). */
  function parseFlexibleDateOrNull(text){
    const s=String(text||'');let m;
    if((m=s.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/))){
      const d=m[4]!=null?new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5]||0):new Date(+m[1],+m[2]-1,+m[3],12,0,0);
      return isNaN(d)?null:d;
    }
    if((m=s.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/))){
      const a=+m[1],b=+m[2],yr=m[3]?(String(m[3]).length===2?2000+ +m[3]:+m[3]):localMidnight.getFullYear();
      const dayFirst=a>12||/^\d{1,2}\.\d{1,2}/.test(m[0]);
      let d=dayFirst?new Date(yr,b-1,a):new Date(yr,a-1,b);
      if(d<localMidnight&&!m[3])d=new Date(d.getFullYear()+1,d.getMonth(),d.getDate());
      if(!isNaN(d))return d;
    }
    if((m=s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i))){
      const mon=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase());
      let d=new Date(m[3]?+m[3]:localMidnight.getFullYear(),mon,+m[2]);
      if(d<localMidnight&&!m[3])d.setFullYear(d.getFullYear()+1);
      if(!isNaN(d))return d;
    }
    if(/\btomorrow\b/i.test(s))return new Date(localMidnight.getTime()+86400000);
    if(/\btoday\b/i.test(s))return new Date(localMidnight);
    return null;
  }
  function classifyTravelKind(text){
    if(HOTEL.test(text))return 'hotel';
    if(FLIGHTISH.test(text)||/\b[A-Z]{2}\s?\d{2,4}\b/.test(text))return 'flight';
    if(TRAINISH.test(text))return 'train';
    if(TRAVEL.test(text))return 'trip';
    return '';
  }
  function tripIdFor(dest,whenMs){
    const d=new Date(whenMs||Date.now());
    const week=new Date(d.getFullYear(),d.getMonth(),d.getDate());
    week.setDate(week.getDate()-((week.getDay()+6)%7));
    const slug=String(dest||'travel').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,28)||'travel';
    return `trip:${slug}:${week.toISOString().slice(0,10)}`;
  }
  function parseTravelBooking(m){
    if(!m?.id)return null;
    const h=m.payload?.headers||[];
    const subject=header(h,'Subject')||'(No subject)';
    const text=mailSearchText(m);
    const kind=classifyTravelKind(text);if(!kind)return null;
    const from=parseFrom(header(h,'From'));
    const received=new Date(header(h,'Date')||m.internalDate*1);
    const flight=window.DaylightScan?.extractFlight?.(text)||null;
    const dest=(flight?.to||(text.match(/\b(?:to|→|->|–)\s*([A-Za-zÀ-ž][A-Za-zÀ-ž .'-]{2,28})/i)||[])[1]||'').trim();
    // Prefer structured depart; otherwise parse text — never treat received as travel date
    let travelWhen=null;
    if(flight?.depart&&/\d{4}-\d{2}-\d{2}/.test(String(flight.depart))){
      const d=new Date(flight.depart);if(!isNaN(d))travelWhen=d;
    }
    if(!travelWhen)travelWhen=parseFlexibleDateOrNull(text);
    const travelReliable=!!travelWhen;
    const whenMs=travelReliable?travelWhen.getTime():null;
    const tripAnchor=whenMs||received.getTime();
    const tripId=tripIdFor(dest||flight?.from||from.name||subject.slice(0,16),tripAnchor);
    return {
      mailId:m.id,threadId:m.threadId||m.id,kind,subject,from,dest,flight,
      whenMs,receivedMs:received.getTime(),travelReliable,tripId,href:gmailLink(m.threadId||m.id),
      title:subject
    };
  }
  function mergeTripIds(bookings){
    const out=bookings.map(b=>({...b}));
    for(let i=0;i<out.length;i++){
      for(let j=i+1;j<out.length;j++){
        const a=out[i],b=out[j];
        // Never merge solely because same thread — require dest proximity + reliable travel times
        if(a.mailId&&b.mailId&&a.mailId===b.mailId)continue;
        const aw=a.whenMs??a.receivedMs,bw=b.whenMs??b.receivedMs;
        if(aw==null||bw==null)continue;
        const sameDest=a.dest&&b.dest&&a.dest.toLowerCase().slice(0,8)===b.dest.toLowerCase().slice(0,8);
        const close=Math.abs(aw-bw)<6*86400000;
        if((sameDest||(!a.dest&&!b.dest&&close))&&close){
          const keep=aw<=bw?a.tripId:b.tripId;
          out[i].tripId=keep;out[j].tripId=keep;
        }
      }
    }
    return out;
  }
  function findRelatedMeetingMail(event){
    if(!loopsData)return null;
    const title=String(event.summary||'');
    const words=title.split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=4).map(w=>w.toLowerCase());
    const att=(event.attendees||[]).map(a=>(a.email||'').toLowerCase()).filter(Boolean);
    const start=new Date(event.start?.dateTime||event.start?.date||0).getTime();
    const pool=[...(loopsData.inbox||[]),...(loopsData.threads||[]).flatMap(t=>t.messages||[])];
    let best=null,score=0;
    pool.forEach(m=>{
      if(!m?.id)return;
      const h=m.payload?.headers||[];
      const subject=(header(h,'Subject')||'').toLowerCase();
      const from=parseFrom(header(h,'From'));
      const to=parseFrom((header(h,'To')||'').split(',')[0]||'');
      const when=new Date(header(h,'Date')||m.internalDate*1).getTime();
      let s=0;
      if(att.includes(from.email)||att.includes(to.email))s+=5;
      words.forEach(w=>{if(subject.includes(w))s+=2});
      if(start&&Math.abs(when-start)<5*86400000)s+=2;
      if(AUTOMATED.test(from.email))s-=3;
      if(s>score){score=s;best=m}
    });
    if(!best||score<4)return null;
    const h=best.payload?.headers||[];
    return {
      mailId:best.id,threadId:best.threadId||best.id,
      subject:header(h,'Subject')||'(No subject)',
      from:parseFrom(header(h,'From')),
      href:gmailLink(best.threadId||best.id),
      score
    };
  }
  function syncMeetingMailLinks(){
    if(!loopsData)return;
    const map={};
    (loopsData.upcoming||[]).forEach(e=>{
      if((e.attendees||[]).length<2||!e.start?.dateTime)return;
      const mail=findRelatedMeetingMail(e);if(mail)map[e.id]=mail;
    });
    loopsData.meetingMail=map;
  }
  const CANCELLED_TRAVEL=/\b(cancel+ed|cancellation|flight\s+cancel|booking\s+cancel|no longer (valid|available)|was cancelled)\b/i;
  const SCHEDULE_CHANGE=/\b(reschedul|schedule\s+chang|time\s+chang|new\s+departure|delayed|gate\s+chang|depart(?:ure)?\s+now|updated\s+itinerary|flight\s+update)\b/i;
  const PRICE_CHANGE=/\b(price\s+increas|new\s+price|updated\s+price|rate\s+chang|now\s+(costs?|only)|was\s+[€$£]|increased\s+to)\b/i;
  const FOLLOWUP_NEED=/\b(following\s+up|just\s+checking|any\s+update|did\s+you\s+(get|see)|circling\s+back|friendly\s+reminder|waiting\s+on\s+your)\b/i;
  function bookingFingerprint(b){
    return [b.childKey||'',b.whenMs||'',b.flight?.depart||'',b.flight?.arrive||'',b.flight?.flight||'',b.flight?.gate||'',b.flight?.pnr||'',b.cancelled?'1':'0',b.dest||''].join('|');
  }
  function upsertWalletFromBooking(booking,list){
    if(!booking?.mailId)return {added:false,updated:false,change:null};
    const Data=window.DaylightData;
    const childKey=booking.childKey||null;
    const canonId=Data?.canonicalWalletId
      ?Data.canonicalWalletId(booking.mailId,childKey)
      :(childKey?('mail:'+booking.mailId+'#pass:'+childKey):('mail:'+booking.mailId));
    const existing=list.find(i=>{
      if(i.id===canonId)return true;
      if(childKey)return i.mailId===booking.mailId&&i.childKey===childKey;
      if(i.childKey)return false;
      return i.mailId===booking.mailId||i.sourceId===booking.mailId||i.id==='mail:'+booking.mailId||i.id==='ticket:'+booking.mailId;
    });
    const isStay=booking.kind==='hotel';
    const route=booking.flight?.from&&booking.flight?.to?`${booking.flight.from} → ${booking.flight.to}`:'';
    const subj=String(booking.subject||'');
    const title=booking.cancelled
      ?('Cancelled · '+(route||subj.replace(/^re:\s*/i,'').slice(0,48)))
      :(isStay?(subj.replace(/^re:\s*/i,'').slice(0,60)):(route||subj.slice(0,60)));
    const note=[booking.cancelled?'CANCELLED':'',booking.flight?.flight,booking.flight?.depart?`Dep ${booking.flight.depart}`:'',booking.flight?.seat?`Seat ${booking.flight.seat}`:'',booking.from?.name,booking.dest&&`→ ${booking.dest}`].filter(Boolean).join(' · ');
    const reliableTravelAt=(()=>{
      if(booking.flight?.depart&&/\d{4}-\d{2}-\d{2}/.test(String(booking.flight.depart))){
        const d=new Date(booking.flight.depart);if(!isNaN(d))return d.toISOString();
      }
      if(booking.travelReliable&&booking.whenMs!=null&&!isNaN(booking.whenMs))return new Date(booking.whenMs).toISOString();
      return null;
    })();
    const bookingRef=booking.flight?.pnr||booking.bookingRef||null;
    const nextFp=bookingFingerprint(booking);
    if(existing){
      const prevFp=existing._bookingFp||'';
      let change=null;
      if(booking.cancelled&&existing.status!=='cancelled')change={kind:'cancelled',field:'status',from:existing.status||'active',to:'cancelled'};
      else if(prevFp&&prevFp!==nextFp){
        if(reliableTravelAt&&String(existing.travelAt||'')!==reliableTravelAt)change={kind:'rescheduled',field:'travelAt',from:existing.travelAt,to:reliableTravelAt};
        else if((existing.flight?.depart||'')!==(booking.flight?.depart||''))change={kind:'schedule_change',field:'depart',from:existing.flight?.depart||'',to:booking.flight?.depart||''};
        else change={kind:'updated',field:'booking',from:prevFp,to:nextFp};
      }
      const patch={
        title,note,tripId:booking.tripId||existing.tripId,
        href:booking.href||existing.href,
        flight:booking.flight?Object.assign({},existing.flight||{},booking.flight):existing.flight,
        status:booking.cancelled?'cancelled':(existing.status==='cancelled'?'cancelled':'active'),
        cancelled:!!booking.cancelled||existing.status==='cancelled',
        recordKey:booking.recordKey||existing.recordKey||null,
        entityKey:booking.entityKey||existing.entityKey||null,
        threadId:booking.threadId||existing.threadId,
        childKey:childKey||existing.childKey||null,
        bookingRef:bookingRef||existing.bookingRef||null,
        number:bookingRef?('#'+bookingRef):(existing.number||''),
        _bookingFp:nextFp,id:canonId,mailId:booking.mailId,sourceId:booking.mailId
      };
      if(reliableTravelAt){
        patch.travelAt=reliableTravelAt;patch.eventAt=reliableTravelAt;
        patch.date=new Date(reliableTravelAt).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
      }
      if(booking.linkedMailId)patch.linkedMailId=booking.linkedMailId;
      if(change){patch.lastChange=change;patch.updatedAt=new Date().toISOString();if(change.kind==='rescheduled')patch.rescheduled=true}
      const merged=Data?.mergeWalletRichness?Data.mergeWalletRichness(existing,patch):Object.assign({},existing,patch);
      Object.keys(merged).forEach(k=>{existing[k]=merged[k]});
      const prevId=existing.id;
      existing.id=canonId;
      if(prevId&&prevId!==canonId)existing.legacyIds=Array.from(new Set([...(existing.legacyIds||[]),prevId,'ticket:'+booking.mailId].filter(Boolean)));
      return {added:false,updated:true,change,walletId:canonId};
    }
    const item={
      id:canonId,childKey:childKey||null,
      mailId:booking.mailId,sourceId:booking.mailId,threadId:booking.threadId,tripId:booking.tripId,
      title,kind:isStay?'documents':'tickets',note,
      org:booking.from?.name||(isStay?'Hotel':'Travel'),
      typeLabel:booking.kind==='hotel'?'Hotel booking':booking.kind==='train'?'Train ticket':'Flight ticket',
      number:bookingRef?('#'+bookingRef):'',
      date:reliableTravelAt?new Date(reliableTravelAt).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'',
      travelAt:reliableTravelAt,eventAt:reliableTravelAt,
      at:new Date().toISOString(),
      color:isStay?WALLET_COLORS.documents:WALLET_COLORS.tickets,
      href:booking.href,flight:booking.flight||null,
      bookingRef,recordKey:booking.recordKey||null,entityKey:booking.entityKey||null,
      qrAuthentic:false,barcodeAuthentic:false,
      status:booking.cancelled?'cancelled':'active',cancelled:!!booking.cancelled,
      legacyIds:[],sourceRefs:{mailId:booking.mailId,threadId:booking.threadId},
      _bookingFp:nextFp
    };
    list.unshift(item);return {added:true,updated:false,change:null,walletId:canonId};
  }
  function syncTravelWalletAndTrips(){
    if(!loopsData)return {added:0,updated:0,trips:[]};
    const raw=[];
    const seen=new Set();
    [...(loopsData.travelMail||[]),...(loopsData.inbox||[])].forEach(m=>{
      if(!m?.id||seen.has(m.id))return;
      const b=parseTravelBooking(m);if(!b)return;
      const text=mailSearchText(m);
      b.cancelled=CANCELLED_TRAVEL.test(text)||CANCELLED_TRAVEL.test(b.subject||'');
      b.scheduleChanged=SCHEDULE_CHANGE.test(text)||SCHEDULE_CHANGE.test(b.subject||'');
      seen.add(m.id);raw.push(b);
    });
    const bookings=mergeTripIds(raw);
    const trips={};
    bookings.forEach(b=>{
      const anchor=b.whenMs??b.receivedMs??Date.now();
      if(!trips[b.tripId])trips[b.tripId]={id:b.tripId,dest:b.dest||'',whenMs:anchor,kinds:new Set(),mailIds:[],items:[]};
      const t=trips[b.tripId];
      t.kinds.add(b.kind);t.mailIds.push(b.mailId);t.items.push(b);
      if(b.whenMs!=null&&b.whenMs<t.whenMs)t.whenMs=b.whenMs;
      if(!t.dest&&b.dest)t.dest=b.dest;
    });
    bookings.filter(b=>b.kind==='hotel').forEach(h=>{
      const hw=h.whenMs??h.receivedMs;
      if(hw==null)return;
      const mate=bookings.find(x=>{
        if(x.kind==='hotel'||x.mailId===h.mailId)return false;
        const xw=x.whenMs??x.receivedMs;return xw!=null&&Math.abs(xw-hw)<6*86400000;
      });
      if(mate){h.tripId=mate.tripId;h.linkedMailId=mate.mailId}
    });
    let list=readWallet();
    let added=0,updated=0;
    const changes=[];
    bookings.forEach(b=>{
      const r=upsertWalletFromBooking(b,list);
      if(r.added)added++;
      if(r.updated){updated++;if(r.change)changes.push({mailId:b.mailId,tripId:b.tripId,...r.change})}
    });
    list.forEach(i=>{
      if(!i.tripId)return;
      const mates=list.filter(x=>x.tripId===i.tripId&&x.id!==i.id);
      if(mates.length)i.tripMates=mates.map(x=>({id:x.id,title:x.title,kind:x.kind}));
    });
    if(added||updated||bookings.length)saveWallet(list);
    loopsData.bookings=bookings;
    loopsData.trips=Object.values(trips).map(t=>({id:t.id,dest:t.dest,whenMs:t.whenMs,kinds:[...t.kinds],mailIds:t.mailIds,count:t.items.length}));
    loopsData.travelChanges=(loopsData.travelChanges||[]).concat(changes).slice(-40);
    return {added,updated,trips:loopsData.trips,changes};
  }
  // Phase 2: Daylight never creates payment tasks by itself. It only SUGGESTS a reminder for an unpaid bill with a written
  // due date and convincing evidence; the user confirms it in Money (see confirmFinanceReminder).
  function syncPaymentTaskSuggestions(){
    if(!loopsData)return 0;
    const L=ensureFinance();
    const confirmed=finConfirmed();
    const amountMem=readJSON('daylight-pay-amounts',{});
    const moneyChanges=[];
    (L?.records||[]).forEach(r=>{
      if(!r.amount||!r.mailIds?.length||r.category==='promotional_offer')return;
      const key=r.key,amt=window.DaylightFinance.fmtAmount(r.amount);
      const prev=amountMem[key];
      if(prev&&prev!==amt&&['unpaid_bill','subscription_renewal'].includes(r.category))moneyChanges.push({mailId:r.mailIds[r.mailIds.length-1],kind:'amount_change',field:'amount',from:prev,to:amt,title:r.merchant});
      amountMem[key]=amt;
    });
    writeJSON('daylight-pay-amounts',amountMem);
    loopsData.financeSuggestions=(L?.records||[]).filter(r=>r.suggestion&&!confirmed[r.suggestion.key]&&!r.dismissed).map(r=>r.suggestion);
    loopsData.paymentSuggestions=loopsData.financeSuggestions;
    loopsData.moneyChanges=(loopsData.moneyChanges||[]).concat(moneyChanges).slice(-40);
    return 0; // tasks created automatically: always zero
  }
  /** User confirmed a suggested reminder → create a real task (the only path that turns a financial suggestion into a task). */
  function confirmFinanceReminder(recordKey){
    const r=loopsData?.finance?.recordByKey?.[recordKey];if(!r?.suggestion)return null;
    const s=r.suggestion,conf=finConfirmed();
    if(conf[s.key])return null;
    const [y,m,d]=s.dueDate.split('-').map(Number);
    const task={id:crypto.randomUUID?.()||('finrem-'+Date.now()),title:s.title,dueDate:new Date(y,m-1,d,9).toISOString(),hasTime:false,project:'Payments',
      mailId:s.mailId,href:gmailLink(s.mailId),financeConfirmed:true,financeRecordKey:recordKey,amount:r.amount?window.DaylightFinance.fmtAmount(r.amount):'',created:new Date().toISOString(),why:s.why};
    personalTasks.unshift(task);savePersonal();
    conf[s.key]={at:Date.now(),taskId:task.id};writeJSON(FIN_LS.confirmed,conf);
    return task;
  }
  function setFinanceCorrection(mailId,patch){
    const c=finCorrections();c[mailId]={...(c[mailId]||{}),...patch,at:Date.now()};
    if(patch.category===null)delete c[mailId].category;
    writeJSON(FIN_LS.corr,c);
    if(loopsData){try{buildFinance(loopsData)}catch(e){console.warn('finance',e)}}
    renderCategories();if(typeof renderInbox==='function')renderInbox({animate:false});if(typeof renderMobile==='function')renderMobile();
  }
  function syncFollowUpSuggestions(){
    if(!loopsData)return 0;
    const stamped=readJSON('daylight-followup-suggested',{});
    let n=0;
    const followups=[];
    (loopsData.inbox||[]).forEach(m=>{
      if(!m?.id||stamped[m.id])return;
      const h=m.payload?.headers||[];
      const from=parseFrom(header(h,'From'));
      const subject=header(h,'Subject')||'';
      const text=mailSearchText(m);
      if(AUTOMATED.test(from.email))return;
      if(!(FOLLOWUP_NEED.test(subject)||FOLLOWUP_NEED.test(text)||FOLLOWUP_NEED.test(m.snippet||'')))return;
      if((m.labelIds||[]).some(l=>/^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l)))return;
      followups.push({mailId:m.id,threadId:m.threadId||m.id,subject,from,href:gmailLink(m.threadId||m.id)});
      if(personalTasks.some(t=>t.mailId===m.id&&t.project==='Follow-up')){stamped[m.id]=Date.now();return}
      personalTasks.unshift({
        id:crypto.randomUUID?.()||('fu-'+Date.now()),
        title:`Follow up: ${subject.slice(0,72)}`,
        dueDate:'',hasTime:false,project:'Follow-up',
        mailId:m.id,href:gmailLink(m.threadId||m.id),suggested:true,
        created:new Date().toISOString()
      });
      stamped[m.id]=Date.now();n++;
    });
    if(n)savePersonal();
    writeJSON('daylight-followup-suggested',stamped);
    loopsData.followups=followups.slice(0,12);
    return n;
  }
  function syncMeetingChanges(){
    if(!loopsData)return 0;
    const prev=readJSON('daylight-meeting-times',{});
    const changes=[];
    (loopsData.upcoming||[]).forEach(e=>{
      if(!e?.id)return;
      const start=e.start?.dateTime||e.start?.date||'';
      const end=e.end?.dateTime||e.end?.date||'';
      const key=e.id;
      const was=prev[key];
      if(was&&was.start&&was.start!==start){
        changes.push({eventId:e.id,kind:'rescheduled',field:'start',from:was.start,to:start,title:e.summary||'(No title)'});
      }
      if(e.status==='cancelled'&&was&&was.status!=='cancelled'){
        changes.push({eventId:e.id,kind:'cancelled',field:'status',from:was.status||'confirmed',to:'cancelled',title:e.summary||'(No title)'});
      }
      prev[key]={start,end,status:e.status||'confirmed',summary:e.summary||''};
    });
    writeJSON('daylight-meeting-times',prev);
    loopsData.meetingChanges=(loopsData.meetingChanges||[]).concat(changes).slice(-40);
    return changes.length;
  }
  function runCrossAppIntelligence(){
    if(!loopsData)return;
    syncTravelWalletAndTrips();
    syncMeetingMailLinks();
    syncMeetingChanges();
    syncPaymentTaskSuggestions();
    syncFollowUpSuggestions();
  }
  /* ---- Phase 0: dual-write into IndexedDB (UI still reads existing paths) ---- */
  let hydrateQueued=null,hydrateBusy=false,hydrateTimer=0;
  function queueDaylightHydrate(){
    clearTimeout(hydrateTimer);
    hydrateTimer=setTimeout(()=>{
      if(hydrateQueued)return;
      hydrateQueued=Promise.resolve().then(async()=>{
        if(hydrateBusy)return;
        hydrateBusy=true;
        try{await hydrateDaylightStore()}catch(e){console.warn('DaylightStore hydrate',e)}
        finally{hydrateBusy=false;hydrateQueued=null}
      });
    },80);
    return hydrateQueued;
  }
  async function hydrateDaylightStore(){
    const Store=window.DaylightStore;
    if(!Store?.putEntities)return;
    const t0=Date.now();
    await Store.open();
    let acct=null;
    try{
      const prof=readProfile();
      if(token&&(prof.email||prof.sub))acct=await ensureDaylightAccountFromProfile('google',{...prof,name:prof.name});
      else if(microsoftAccount&&(prof.email||prof.sub))acct=await ensureDaylightAccountFromProfile('microsoft',{...prof,displayName:prof.name});
      else acct=await Store.ensureActiveAccount({kind:'local',providerAccountKey:'local:device',displayName:'This device'});
    }catch{acct=await Store.ensureActiveAccount({kind:'local',providerAccountKey:'local:device',displayName:'This device'})}
    const accountId=acct.id;
    const sourceIdentity={
      provider:acct.kind==='microsoft'?'microsoft':(acct.kind==='google'?'google':'local'),
      subject:acct.subject||null,
      email:acct.email||null,
      providerAccountKey:acct.providerAccountKey
    };
    const base={accountId,ownerId:accountId,sourceIdentity};
    const entities=[],relationships=[],facts=[];
    const mailPool=new Map();
    const isFinance=m=>{
      const h=m.payload?.headers||[];const subject=header(h,'Subject')||'';
      return MONEY.test(subject)||RENEWAL.test(subject)||(m.labelIds||[]).includes('CATEGORY_PURCHASES');
    };
    const isDocs=m=>{
      const h=m.payload?.headers||[];return /\b(passport|visa|contract|insurance|tax|agreement)\b/i.test(header(h,'Subject')||'');
    };
    if(loopsData){
      try{ensureClassified()}catch{}
      const classifiedById=loopsData.classified?.byMailId||{};
      [...(loopsData.inbox||[]),...(loopsData.financeMail||[]),...(loopsData.travelMail||[]),...(loopsData.docsMail||[])].forEach(m=>{
        if(!m?.id||mailPool.has(m.id))return;
        mailPool.set(m.id,m);
        const h=m.payload?.headers||[];
        const from=parseFrom(header(h,'From'));
        const subject=header(h,'Subject')||'(No subject)';
        const when=new Date(header(h,'Date')||m.internalDate*1);
        const c=classifiedById[m.id];
        const tags=(m.labelIds||[]).slice(0,8);
        if(c?.category)tags.push('cat:'+c.category);
        if(c?.needsReview)tags.push('needs_review');
        if(c?.status)tags.push('status:'+c.status);
        if(c?.recordKey)tags.push(c.recordKey);
        if(isFinance(m)||['subscription','payment','bill'].includes(c?.category))tags.push('money');
        if(isDocs(m))tags.push('documents');
        if(c?.category==='ticket')tags.push('travel');
        const privacy=c?.privacyClass==='financial'?Store.PRIVACY.FINANCIAL
          :c?.privacyClass==='identity'?Store.PRIVACY.IDENTITY
          :isFinance(m)?Store.PRIVACY.FINANCIAL
          :isDocs(m)?Store.PRIVACY.IDENTITY
          :Store.PRIVACY.NORMAL;
        entities.push({
          ...base,type:'mail',source:'gmail',
          sourceIds:{messageId:m.id,threadId:m.threadId||m.id},
          title:subject,subtitle:from.name||from.email||'',
          whenMs:isNaN(when)?null:when.getTime(),
          href:gmailLink(m.threadId||m.id),
          tags:tags.slice(0,12),
          privacyClass:privacy,
          payload:{
            fromEmail:from.email,snippet:String(m.snippet||c?.snippet||'').slice(0,240),
            category:c?.category||'other',status:c?.status||null,recordKey:c?.recordKey||null,
            confidence:c?.confidence||null,needsReview:!!c?.needsReview,amount:c?.amount||'',
            originalHref:gmailLink(m.threadId||m.id)
          }
        });
      });
      const finL=loopsData.finance||null;
      // Phase 2: money records come from the financial ledger (one record per invoice / subscription / transaction).
      // Older bill/payment rows written by previous versions are left untouched (see the cleanup plan).
      (finL?.records||[]).forEach(r=>{
        if(!r?.key||r.category==='promotional_offer'||r.bucket==='dismissed')return;
        entities.push({
          ...base,type:'finance',source:'gmail',id:accountId+'|fin:'+r.key,sourceKey:'fin:'+r.key,
          sourceIds:{messageId:r.mailIds?.[r.mailIds.length-1]||null,threadId:r.threadId||null,recordKey:r.key},
          title:r.merchant||r.label,subtitle:r.label,whenMs:Date.parse(r.dueDate||r.receivedAt||'')||null,
          href:r.mailIds?.length?gmailLink(r.mailIds[r.mailIds.length-1]):'',
          tags:['fin:'+r.category,'bucket:'+r.bucket,r.needsReview?'needs_review':null,r.obligation?'obligation:'+r.obligation:null].filter(Boolean),
          privacyClass:Store.PRIVACY.FINANCIAL,
          payload:{category:r.category,status:r.status,direction:r.direction,amount:r.amount,dueDate:r.dueDate,invoiceNumber:r.invoiceNumber,reference:r.reference,confidence:r.confidence,bucket:r.bucket,obligation:r.obligation,mailIds:r.mailIds,links:r.links,corrected:!!r.corrected}
        });
      });
      Object.values(loopsData.classified?.byRecordKey||{}).forEach(c=>{
        if(!c?.recordKey||!['subscription','bill','payment','ticket','shopping'].includes(c.category))return;
        if(finL&&['subscription','bill','payment'].includes(c.category))return;
        const type=c.category==='shopping'?'order':c.category;
        entities.push({
          ...base,type,source:'gmail',
          id:accountId+'|'+c.recordKey,
          sourceIds:{messageId:c.mailId,threadId:c.threadId,recordKey:c.recordKey},
          title:c.title||c.subject||c.category,
          subtitle:c.subject||'',
          whenMs:c.whenMs||null,
          href:c.href||'',
          tags:['cat:'+c.category,c.status?'status:'+c.status:null,c.needsReview?'needs_review':null].filter(Boolean),
          privacyClass:c.privacyClass==='financial'?Store.PRIVACY.FINANCIAL:c.privacyClass==='identity'?Store.PRIVACY.IDENTITY:Store.PRIVACY.NORMAL,
          payload:{recordKey:c.recordKey,status:c.status,amount:c.amount||'',mailId:c.mailId,linkedFrom:c.linkedFrom||[],confidence:c.confidence}
        });
        if(c.mailId){
          relationships.push({
            ...base,fromId:accountId+'|'+c.recordKey,toId:Store.id.mail(accountId,c.mailId),type:'from_mail',
            confidence:c.confidence||0.8,confirmed:'auto',method:'classify',
            evidence:[{kind:'classification',category:c.category}],
            sourceIds:{recordKey:c.recordKey,messageId:c.mailId}
          });
        }
      });
      (loopsData.upcoming||[]).forEach(e=>{
        if(!e?.id)return;
        const st=new Date(e.start?.dateTime||e.start?.date||NaN);
        const en=new Date(e.end?.dateTime||e.end?.date||NaN);
        entities.push({
          ...base,type:'event',source:'google',
          sourceIds:{eventId:e.id},
          title:e.summary||'(No title)',
          subtitle:e.location||'',
          whenMs:isNaN(st)?null:st.getTime(),
          endMs:isNaN(en)?null:en.getTime(),
          href:e.htmlLink||'',
          privacyClass:Store.PRIVACY.NORMAL,
          payload:{attendeeCount:(e.attendees||[]).length,allDay:!!e.start?.date}
        });
      });
      (loopsData.trips||[]).forEach(t=>{
        if(!t?.id)return;
        entities.push({
          ...base,type:'trip',source:'daylight',
          sourceIds:{tripId:t.id},
          id:Store.id.trip(accountId,t.id),
          title:t.dest?`Trip to ${t.dest}`:t.id,
          subtitle:(t.kinds||[]).join(' · '),
          whenMs:t.whenMs||null,
          tripId:t.id,
          privacyClass:Store.PRIVACY.NORMAL,
          payload:{mailIds:t.mailIds||[],count:t.count||0,dest:t.dest||''}
        });
      });
      (loopsData.bookings||[]).forEach(b=>{
        if(!b?.mailId)return;
        const mailEntityId=Store.id.mail(accountId,b.mailId);
        const tripEntityId=Store.id.trip(accountId,b.tripId);
        if(b.tripId){
          relationships.push({
            ...base,fromId:mailEntityId,toId:tripEntityId,type:'part_of_trip',
            confidence:0.85,confirmed:'auto',method:'rule',
            evidence:[{kind:'booking',dest:b.dest||'',whenMs:b.whenMs}],
            sourceIds:{messageId:b.mailId,tripId:b.tripId}
          });
        }
        if(b.linkedMailId){
          relationships.push({
            ...base,fromId:mailEntityId,toId:Store.id.mail(accountId,b.linkedMailId),type:'hotel_for_trip',
            confidence:0.7,confirmed:'auto',method:'rule',
            evidence:[{kind:'window'}],
            sourceIds:{messageId:b.mailId,linkedMailId:b.linkedMailId}
          });
        }
        if(b.dest){
          facts.push({
            ...base,entityId:mailEntityId,field:'destination',value:b.dest,rawValue:b.dest,
            sourceIds:{messageId:b.mailId},method:'rule',confidence:0.75,verified:'unverified',
            privacyClass:Store.PRIVACY.NORMAL
          });
        }
        if(b.kind){
          facts.push({
            ...base,entityId:mailEntityId,field:'travelKind',value:b.kind,rawValue:b.kind,
            sourceIds:{messageId:b.mailId},method:'rule',confidence:0.8,verified:'unverified'
          });
        }
        if(b.flight?.pnr){
          facts.push({
            ...base,entityId:mailEntityId,field:'pnr',value:b.flight.pnr,rawValue:b.flight.pnr,
            sourceIds:{messageId:b.mailId},method:'rule',confidence:0.7,verified:'unverified',
            privacyClass:Store.PRIVACY.IDENTITY
          });
        }
      });
      Object.entries(loopsData.meetingMail||{}).forEach(([eventId,mail])=>{
        if(!mail?.mailId)return;
        relationships.push({
          ...base,fromId:Store.id.event(accountId,eventId,'google'),toId:Store.id.mail(accountId,mail.mailId),type:'related_mail',
          confidence:Math.min(1,0.4+((mail.score||0)*0.08)),confirmed:'auto',method:'rule',
          evidence:[{kind:'meeting_mail',score:mail.score||0,subject:mail.subject||''}],
          sourceIds:{eventId,messageId:mail.mailId}
        });
      });
      Object.entries(loopsData.files||{}).forEach(([eventId,file])=>{
        if(!file?.webViewLink)return;
        facts.push({
          ...base,entityId:Store.id.event(accountId,eventId,'google'),field:'driveFile',
          value:{name:file.name||'',href:file.webViewLink},rawValue:file.name||'',
          sourceIds:{eventId},method:'rule',confidence:0.65,verified:'unverified'
        });
      });
    }
    // Recover AI shopping orders from daylight-orders into Store (non-destructive dual-write)
    try{
      const Data=window.DaylightData;
      const orderList=Data?.orders?Data.orders():readAiOrders();
      orderList.forEach(o=>{
        if(!o)return;
        const orderKey=o.entityKey||o.orderId||o.id;
        if(!orderKey)return;
        const due=Data?.eventAt?.(o)||(o.deliveryDate?new Date(o.deliveryDate):null);
        const whenMs=due&&!isNaN(due)?due.getTime():(o.sortAt||null);
        const entityId=accountId+'|order:'+String(orderKey).slice(0,80);
        entities.push({
          ...base,type:'order',source:'ai',
          id:entityId,
          sourceIds:{orderId:String(orderKey),messageId:o.mailId||null,recordKey:o.entityKey||null},
          title:o.merchant||o.title||('Order '+(o.orderId||'')).trim(),
          subtitle:o.status||o.summary||'',
          whenMs:whenMs&&!isNaN(whenMs)?whenMs:null,
          href:o.href||(o.mailId?gmailLink(o.mailId):''),
          tags:['order',o.cancelled?'cancelled':null,o.status?'status:'+String(o.status).slice(0,24):null].filter(Boolean),
          privacyClass:Store.PRIVACY.NORMAL,
          payload:{
            orderId:o.orderId||null,status:o.status||'',merchant:o.merchant||'',
            deliveryDate:o.deliveryDate||o.delivery_date||null,eventAt:o.eventAt||null,
            mailId:o.mailId||null,sourceMailIds:o.sourceMailIds||[],source:'daylight-orders'
          }
        });
        (o.sourceMailIds||[]).concat(o.mailId?[o.mailId]:[]).filter(Boolean).forEach(mid=>{
          relationships.push({
            ...base,fromId:entityId,toId:Store.id.mail(accountId,mid),type:'from_mail',
            confidence:0.9,confirmed:'auto',method:'ai-order',
            evidence:[{kind:'daylight-orders'}],sourceIds:{orderId:String(orderKey),messageId:mid}
          });
        });
      });
    }catch(e){console.warn('hydrate orders',e)}
    readWallet().forEach(w=>{
      if(!w?.id)return;
      const tags=w.kind?[w.kind]:[];
      const travelMs=w.travelAt?Date.parse(w.travelAt):(w.eventAt?Date.parse(w.eventAt):NaN);
      entities.push({
        ...base,type:'wallet',source:'local',
        sourceIds:{walletId:w.id,messageId:w.mailId||null,recordKey:w.recordKey||null,entityKey:w.entityKey||null,childKey:w.childKey||null},
        title:w.title||'Pass',
        subtitle:w.typeLabel||w.org||w.kind||'',
        whenMs:!isNaN(travelMs)?travelMs:null,
        href:w.href||'',
        tripId:w.tripId||null,
        tags,
        privacyClass:w.kind==='documents'?Store.PRIVACY.IDENTITY:Store.PRIVACY.NORMAL,
        payload:{
          mailId:w.mailId||'',number:w.number||'',org:w.org||'',
          travelAt:w.travelAt||null,eventAt:w.eventAt||null,
          qrAuthentic:!!(w.qrAuthentic||w.scanSource),
          recordKey:w.recordKey||null,entityKey:w.entityKey||null,childKey:w.childKey||null,
          legacyIds:w.legacyIds||[],status:w.status||null
        }
      });
      if(w.mailId){
        relationships.push({
          ...base,fromId:Store.id.wallet(accountId,w.id),toId:Store.id.mail(accountId,w.mailId),type:'from_mail',
          confidence:0.95,confirmed:'auto',method:'rule',
          evidence:[{kind:'wallet_mailId'}],sourceIds:{walletId:w.id,messageId:w.mailId,recordKey:w.recordKey||null}
        });
      }
      if(w.tripId){
        relationships.push({
          ...base,fromId:Store.id.wallet(accountId,w.id),toId:Store.id.trip(accountId,w.tripId),type:'part_of_trip',
          confidence:0.9,confirmed:'auto',method:'rule',
          evidence:[{kind:'wallet_tripId'}],sourceIds:{walletId:w.id,tripId:w.tripId}
        });
      }
    });
    const allTasks=[
      ...personalTasks.map(t=>({...t,_src:'daylight'})),
      ...(providerData.google.tasks||[]).map(t=>({...t,_src:'google'})),
      ...(providerData.microsoft.tasks||[]).map(t=>({...t,_src:'microsoft'}))
    ];
    allTasks.forEach(t=>{
      if(!t?.id&&!t?.title)return;
      const taskId=t.id||('title:'+String(t.title).slice(0,40));
      const due=t.dueDate?Date.parse(t.dueDate):null;
      const pay=t.project==='Payments'||t.suggested||t.amount;
      entities.push({
        ...base,type:'task',source:t._src,
        sourceIds:{taskId},
        title:t.title||'Task',
        subtitle:t.project||t.listName||t.source||'',
        whenMs:due&&!isNaN(due)?due:null,
        href:t.href||'',
        amount:t.amount||'',
        status:t.suggested?'suggested':'active',
        tags:pay?['money']:[],
        privacyClass:pay?Store.PRIVACY.FINANCIAL:Store.PRIVACY.NORMAL,
        payload:{mailId:t.mailId||'',suggested:!!t.suggested}
      });
      if(t.mailId){
        relationships.push({
          ...base,fromId:Store.id.task(accountId,taskId,t._src),toId:Store.id.mail(accountId,t.mailId),type:'payment_for',
          confidence:t.suggested?0.7:0.85,confirmed:t.suggested?'suggested':'auto',method:'rule',
          evidence:[{kind:'task_mailId'}],sourceIds:{taskId,messageId:t.mailId},
          privacyClass:Store.PRIVACY.FINANCIAL,aiExclude:true
        });
        if(t.amount){
          facts.push({
            ...base,entityId:Store.id.mail(accountId,t.mailId),field:'amount',value:t.amount,rawValue:String(t.amount),
            sourceIds:{messageId:t.mailId,taskId},method:'rule',confidence:0.7,verified:'unverified',
            privacyClass:Store.PRIVACY.FINANCIAL
          });
        }
      }
    });
    let inserted=0,updated=0;
    // Phase 2: persist detected changes as superseding facts (in place, no duplicates)
    const changeFacts=[];
    (loopsData?.travelChanges||[]).forEach(c=>{
      if(!c.mailId)return;
      changeFacts.push({
        ...base,entityId:Store.id.mail(accountId,c.mailId),field:c.field||'travelStatus',
        value:c.to,rawValue:String(c.to??''),
        evidenceQuote:`${c.kind||'change'}: ${c.from||'—'} → ${c.to||'—'}`,
        sourceIds:{messageId:c.mailId,tripId:c.tripId||''},method:'rule',confidence:0.85,verified:'unverified',
        privacyClass:Store.PRIVACY.NORMAL
      });
    });
    (loopsData?.moneyChanges||[]).forEach(c=>{
      if(!c.mailId)return;
      changeFacts.push({
        ...base,entityId:Store.id.mail(accountId,c.mailId),field:c.field||'amount',
        value:c.to,rawValue:String(c.to??''),
        evidenceQuote:`${c.kind||'change'}: ${c.from||'—'} → ${c.to||'—'}`,
        sourceIds:{messageId:c.mailId},method:'rule',confidence:0.8,verified:'unverified',
        privacyClass:Store.PRIVACY.FINANCIAL
      });
    });
    (loopsData?.meetingChanges||[]).forEach(c=>{
      if(!c.eventId)return;
      changeFacts.push({
        ...base,entityId:Store.id.event(accountId,c.eventId,'google'),field:c.field||'start',
        value:c.to,rawValue:String(c.to??''),
        evidenceQuote:`${c.kind||'change'}: ${c.from||'—'} → ${c.to||'—'}`,
        sourceIds:{eventId:c.eventId},method:'rule',confidence:0.9,verified:'unverified',
        privacyClass:Store.PRIVACY.NORMAL
      });
    });
    if(entities.length){
      const res=await Store.putEntities(entities,{accountId});
      inserted=res.inserted||0;updated=res.updated||0;
    }
    if(relationships.length)await Store.putRelationships(relationships,{accountId});
    let factChanges=0;
    const allFacts=[...facts,...changeFacts];
    if(allFacts.length&&Store.upsertFactsDetectChange){
      const results=await Store.upsertFactsDetectChange(allFacts,{accountId});
      factChanges=results.filter(r=>r.changed).length;
    }else if(allFacts.length){
      await Store.putFacts(allFacts,{accountId});
    }
    // Clear consumed change buffers so we don't re-write every hydrate
    if(loopsData){loopsData.travelChanges=[];loopsData.moneyChanges=[];loopsData.meetingChanges=[]}
    await Store.recordSyncSuccess('hydrate',{
      durationMs:Date.now()-t0,fetched:entities.length,inserted,updated,deleted:factChanges,mode:'dual-write+change'
    },accountId);
    await Store.setMeta('lastHydrateAt:'+accountId,Date.now());
  }
  /* Native-style navigation: History API + slide transitions + edge swipe */
  const Nav={
    stack:[],
    tabY:Object.create(null),
    passTimer:0,scanTimer:0,
    backing:false,
    silentPop:false,
    reduced(){return matchMedia('(prefers-reduced-motion: reduce)').matches},
    _bind(){window.DaylightNav=this;return this},
    scrollEl(){
      if(mq.matches){
        const s=document.querySelector(`#mapp .m-screen.is-active`)||document.querySelector(`#mapp .m-screen[data-screen="${mTab}"]`);
        if(s)return s;
      }
      return document.scrollingElement||document.documentElement;
    },
    saveTab(){if(!mq.matches)return;const el=this.scrollEl();this.tabY[mTab]=el?.scrollTop||0},
    restoreTab(){if(!mq.matches)return;const y=this.tabY[mTab]||0;const el=this.scrollEl();if(!el)return;const apply=()=>{el.scrollTop=y};requestAnimationFrame(()=>requestAnimationFrame(apply))},
    topView(){return this.stack.length?this.stack[this.stack.length-1].view:null},
    isOpen(view){
      if(view==='loop')return!!$('#loop-sheet')?.classList.contains('show');
      if(view==='pass')return!!$('#pass-sheet')?.classList.contains('show');
      if(view==='scan')return!!(scanUI&&!scanUI.hidden&&scanUI.classList.contains('show'));
      if(view==='health')return!!$('#hx-detail')?.classList.contains('show');
      if(view==='notif')return!!$('#notif-panel')?.classList.contains('show');
      if(view==='brief')return!!$('#brief-pop')?.classList.contains('show');
      if(view==='loops')return!!$('#loops-pop')?.classList.contains('show');
      if(view==='overlay')return!!$('#overlay')?.classList.contains('show');
      if(view==='menu')return document.body.classList.contains('menu-open');
      return false;
    },
    anyOpen(){return ['scan','pass','loop','health','notif','brief','loops','overlay','menu'].some(v=>this.isOpen(v))},
    push(view,id){
      this.saveTab();
      this.stack.push({view,id:id||null});
      try{history.pushState({dl:1,view,id:id||null,n:this.stack.length},'')}catch{}
    },
    replace(view,id){
      if(this.stack.length)this.stack[this.stack.length-1]={view,id:id||null};
      else this.stack.push({view,id:id||null});
      try{history.replaceState({dl:1,view,id:id||null,n:this.stack.length},'')}catch{}
    },
    back(){
      if(this.backing)return true;
      if(document.querySelector('.wstack.has-sel')&&!this.stack.length&&!this.anyOpen()){try{walletStack().exit()}catch{}return true}
      if(this.stack.length){this.backing=true;history.back();return true}
      if(this.anyOpen()){this.dismissTop();this.restoreTab();return true}
      return false;
    },
    /** Finish an interactive edge-swipe without double-animating */
    commitGesture(view,el){
      if(this.backing||!view)return;
      this.backing=true;this.silentPop=true;
      if(this.stack.length&&this.stack[this.stack.length-1].view===view)this.stack.pop();
      const root=view==='health'?$('#hx-detail'):view==='notif'?$('#notif-panel'):view==='loop'?$('#loop-sheet'):view==='pass'?$('#pass-sheet'):view==='brief'?$('#brief-pop'):view==='loops'?$('#loops-pop'):scanUI;
      const finish=()=>{
        if(el){el.style.transition='';el.style.transform='';el.style.opacity=''}
        if(root&&root!==el){root.style.transition='';root.style.opacity='';root.style.transform=''}
        this.dismissInstant(view);
        try{history.back()}catch{this.backing=false;this.silentPop=false;this.restoreTab()}
      };
      if(this.reduced()||!el){finish();return}
      const ms=220;
      el.style.transition=`transform ${ms}ms cubic-bezier(.22,.9,.28,1), opacity 180ms ease`;
      el.style.transform='translate3d(100%,0,0)';
      el.style.opacity='0';
      if(root&&root!==el){root.style.transition=`opacity 180ms ease`;root.style.opacity='0'}
      setTimeout(finish,ms+16);
    },
    onPop(){
      if(this.silentPop){this.silentPop=false;this.backing=false;this.restoreTab();return}
      this.backing=false;
      const top=this.stack.pop();
      if(top)this.dismissView(top.view);
      else if(this.anyOpen())this.dismissTop();
      this.restoreTab();
    },
    dismissTop(){
      if(this.isOpen('scan'))this.dismissView('scan');
      else if(this.isOpen('pass'))this.dismissView('pass');
      else if(this.isOpen('loop'))this.dismissView('loop');
      else if(this.isOpen('health'))this.dismissView('health');
      else if(this.isOpen('notif'))this.dismissView('notif');
      else if(this.isOpen('brief'))this.dismissView('brief');
      else if(this.isOpen('loops'))this.dismissView('loops');
      else if(this.isOpen('overlay'))this.dismissView('overlay');
      else if(this.isOpen('menu'))this.dismissView('menu');
    },
    dismissView(view){
      if(view==='loop')dismissLoopSheet();
      else if(view==='pass')dismissPassSheet();
      else if(view==='scan')dismissScan();
      else if(view==='health')dismissHealthDetail();
      else if(view==='notif')closeNotifPanel();
      else if(view==='brief')closeBriefPop();
      else if(view==='loops')closeLoopsPop();
      else if(view==='overlay')$('#overlay')?.classList.remove('show');
      else if(view==='menu')openMenu(false);
    },
    dismissInstant(view){
      if(view==='loop')dismissLoopSheet(true);
      else if(view==='pass')dismissPassSheet(true);
      else if(view==='scan')dismissScan(true);
      else if(view==='health')dismissHealthDetail(true);
      else if(view==='notif')closeNotifPanel(true);
      else if(view==='brief')closeBriefPop(true);
      else if(view==='loops')closeLoopsPop(true);
      else if(view==='overlay')$('#overlay')?.classList.remove('show');
      else if(view==='menu')openMenu(false);
    },
    drop(view){
      while(this.stack.length&&this.stack[this.stack.length-1].view===view)this.stack.pop();
    },
    sheetEl(view){
      if(view==='loop')return $('#loop-sheet')?.querySelector('.loop-sheet-card')||$('#loop-sheet');
      if(view==='pass')return $('#pass-sheet');
      if(view==='scan')return scanUI;
      if(view==='health')return $('#hx-detail');
      if(view==='notif')return $('#notif-panel')?.querySelector('.notif-sheet')||$('#notif-panel');
      if(view==='brief')return $('#brief-pop')?.querySelector('.brief-pop-card')||$('#brief-pop');
      if(view==='loops')return $('#loops-pop')?.querySelector('.brief-pop-card')||$('#loops-pop');
      return null;
    }
  };
  Nav._bind();
  if(history.state?.dl&&history.state.view){try{history.replaceState({dl:0,root:1},'')}catch{}}
  else if(!history.state?.dl){try{history.replaceState({dl:0,root:1},'')}catch{}}
  function setTabsHidden(hide){
    if(!mq.matches||deskMq.matches){document.body.classList.remove('tabs-hide');return}
    document.body.classList.toggle('tabs-hide',!!hide);
  }
  const TAB_ORDER=['home','inbox','wallet','assistant','stats'];
  let tabAnimating=false,tabAnimTimer=0,pendingTab=null;
  const screenMs=()=>{const n=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--screen-ms'));return Number.isFinite(n)?n:320};
  function screenEl(name){return $(`#mapp .m-screen[data-screen="${name}"]`)}
  function clearTabAnimClasses(el){
    if(!el)return;
    el.classList.remove('is-entering','is-leaving','from-right','from-left','to-left','to-right','go-left','go-right','go-center','slide-run','is-active');
    el.style.transform='';el.style.opacity='';el.style.transition='';el.style.zIndex='';
  }
  function finishTabSwitch(from,to){
    $$('#mapp .m-screen').forEach(s=>{
      const on=s.dataset.screen===to;
      clearTabAnimClasses(s);
      s.hidden=!on;
      s.classList.toggle('is-active',on);
    });
    const stage=$('#m-stage');
    if(stage){stage.style.minHeight='';stage.classList.remove('is-sliding')}
    tabAnimating=false;
    const fab=$('#m-wallet-fab');if(fab)fab.hidden=to!=='wallet';
    Nav.restoreTab();
    syncTabThumb(true);
    dispatchEvent(new Event('daylight:tab'));
    if(pendingTab&&pendingTab!==to){const next=pendingTab;pendingTab=null;setTab(next);return}
    pendingTab=null;
  }
  function syncTabThumb(animate=true){
    const bar=$('.m-tabs'),thumb=$('#m-tab-thumb'),on=bar?.querySelector('[data-tab].on');
    if(!bar||!thumb||!on)return;
    const br=bar.getBoundingClientRect(),r=on.getBoundingClientRect();
    if(!animate)thumb.style.transition='none';
    thumb.style.width=Math.round(r.width)+'px';
    thumb.style.height=Math.round(r.height)+'px';
    thumb.style.transform=`translate3d(${Math.round(r.left-br.left)}px,${Math.round(r.top-br.top)}px,0)`;
    if(!animate)requestAnimationFrame(()=>{thumb.style.transition=''});
  }
  function pulseTitle(forward){
    const title=$('#m-title');if(!title||Nav.reduced())return;
    title.style.transition='none';
    title.style.opacity='.55';
    title.style.transform=`translate3d(${forward?8:-8}px,0,0)`;
    void title.offsetWidth;
    title.style.transition='';
    title.style.opacity='1';
    title.style.transform='none';
  }
  function applyTabChrome(t,opts){
    mTab=t;setLS('daylight-mtab',t);
    $$('.m-tabs [data-tab]').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
    if(typeof markDrawerNav==='function')markDrawerNav();
    mapp.dataset.screen=t;$('#m-title').textContent=TITLES[t];
    const fab=$('#m-wallet-fab');if(fab)fab.hidden=t!=='wallet'||tabAnimating;
    const top=$('#mapp .m-top');if(top)top.hidden=false;
    if(t!=='assistant'&&mAssistAsk)setAssistAsk(false);
    setTabsHidden(false);
    requestAnimationFrame(()=>syncTabThumb(!(opts&&opts.instantThumb)));
  }
  function setTab(t,opts){
    const soft=opts&&opts.soft;
    if(!TAB_ORDER.includes(t))t='home';
    if(t===mTab&&!opts?.force){
      applyTabChrome(t);
      $$('#mapp .m-screen').forEach(s=>{const on=s.dataset.screen===t;s.hidden=!on;s.classList.toggle('is-active',on);clearTabAnimClasses(s);if(on)s.classList.add('is-active')});
      renderMobile();
      Nav.restoreTab();
      return;
    }
    if(tabAnimating&&!soft){pendingTab=t;return}
    const from=mTab;
    const fromIdx=TAB_ORDER.indexOf(from),toIdx=TAB_ORDER.indexOf(t);
    const forward=toIdx>fromIdx;
    const canSlide=mq.matches&&!soft&&fromIdx>=0&&toIdx>=0&&fromIdx!==toIdx&&!Nav.reduced();

    if(!soft){Nav.saveTab();feel.select()}
    applyTabChrome(t);
    if(!soft)pulseTitle(forward);

    if(!canSlide){
      clearTimeout(tabAnimTimer);tabAnimating=false;
      $$('#mapp .m-screen').forEach(s=>{
        clearTabAnimClasses(s);
        const on=s.dataset.screen===t;
        s.hidden=!on;s.classList.toggle('is-active',on);
      });
      renderMobile();
      if(!soft)Nav.restoreTab();
      dispatchEvent(new Event('daylight:tab'));
      return;
    }

    const out=screenEl(from),inn=screenEl(t);
    if(!out||!inn){
      $$('#mapp .m-screen').forEach(s=>{s.hidden=s.dataset.screen!==t;s.classList.toggle('is-active',s.dataset.screen===t)});
      renderMobile();Nav.restoreTab();return;
    }

    tabAnimating=true;clearTimeout(tabAnimTimer);
    const stage=$('#m-stage');
    const fab=$('#m-wallet-fab');if(fab)fab.hidden=true;

    out.hidden=false;inn.hidden=false;
    clearTabAnimClasses(out);clearTabAnimClasses(inn);
    if(stage)stage.classList.add('is-sliding');
    out.classList.add('is-leaving');
    inn.classList.add('is-entering');
    const shift=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-shift'))||28;
    const dxIn=forward?shift:-shift;
    const dxOut=forward?-shift:shift;
    out.style.transition='none';inn.style.transition='none';
    out.style.transform='translate3d(0,0,0)';out.style.opacity='1';
    inn.style.transform=`translate3d(${dxIn}px,0,0)`;inn.style.opacity='.75';
    renderMobile();
    Nav.restoreTab();
    void inn.offsetWidth;
    const ms=screenMs();
    const ease=getComputedStyle(document.documentElement).getPropertyValue('--ease-screen').trim()||'cubic-bezier(.22, 1, .36, 1)';
    const trans=`transform ${ms}ms ${ease}, opacity ${ms}ms ${ease}`;
    requestAnimationFrame(()=>{
      if(!tabAnimating)return;
      out.style.transition=trans;inn.style.transition=trans;
      void inn.offsetWidth;
      out.style.transform=`translate3d(${dxOut}px,0,0)`;out.style.opacity='0';
      inn.style.transform='translate3d(0,0,0)';inn.style.opacity='1';
    });
    tabAnimTimer=setTimeout(()=>finishTabSwitch(from,t),ms+40);
  }
  function applyMode(){
    const on=mq.matches;
    document.body.classList.toggle('m',on);
    document.documentElement.classList.toggle('m-app',on);
    if(on){setTab(mTab,{soft:true});requestAnimationFrame(()=>syncTabThumb(false))}
    else dispatchEvent(new Event('resize'));
  }
  mq.addEventListener?.('change',applyMode);
  $$('.m-tabs [data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  window.addEventListener('popstate',()=>Nav.onPop());
  document.addEventListener('backbutton',e=>{if(Nav.back()){feel.tap();e.preventDefault?.();e.stopPropagation?.()}},true);
  try{
    const Cap=window.Capacitor,App=Cap?.Plugins?.App||Cap?.App;
    App?.addListener?.('backButton',()=>{if(Nav.back()){feel.tap();return}App.minimizeApp?.()});
  }catch{}
  (function bindEdgeSwipe(){
    let s=null;
    const edge=24,thresh=()=>Math.min(96,innerWidth*.24);
    const clearDrag=(el,animate)=>{
      if(!el)return;
      if(animate&&!Nav.reduced()){
        el.style.transition='transform .2s cubic-bezier(.22,.9,.28,1), opacity .16s ease';
        el.style.transform='';el.style.opacity='';
        setTimeout(()=>{el.style.transition=''},220);
      }else{el.style.transition='';el.style.transform='';el.style.opacity=''}
    };
    document.addEventListener('touchstart',e=>{
      if(Nav.backing||(!Nav.stack.length&&!Nav.anyOpen()))return;
      const t=e.touches[0];if(!t)return;
      const fromLeft=t.clientX<=edge,fromRight=t.clientX>=innerWidth-edge;
      if(!fromLeft&&!fromRight)return;
      const view=Nav.topView()||(Nav.isOpen('health')?'health':Nav.isOpen('notif')?'notif':Nav.isOpen('scan')?'scan':Nav.isOpen('pass')?'pass':Nav.isOpen('loop')?'loop':null);
      if(!view)return;
      s={x0:t.clientX,y0:t.clientY,fromLeft,active:false,view,el:Nav.sheetEl(view)};
    },{passive:true});
    document.addEventListener('touchmove',e=>{
      if(!s||Nav.backing)return;
      const t=e.touches[0];if(!t)return;
      const dx=t.clientX-s.x0,dy=Math.abs(t.clientY-s.y0);
      if(!s.active){
        if(dy>12&&dy>Math.abs(dx)){s=null;return}
        const ok=s.fromLeft?dx>10:dx<-10;if(!ok)return;
        s.active=true;
      }
      if(e.cancelable)e.preventDefault();
      if(Nav.reduced()||!s.el)return;
      const p=Math.min(innerWidth,s.fromLeft?Math.max(0,dx):Math.max(0,-dx));
      const o=Math.max(.35,1-p/(innerWidth*.7));
      s.el.style.transition='none';
      s.el.style.transform=`translate3d(${s.fromLeft?p:-p}px,0,0)`;
      s.el.style.opacity=String(o);
      s.p=p;
    },{passive:false});
    const end=()=>{
      if(!s)return;
      const {el,active,view,fromLeft,p}=s;const dist=p||0;s=null;
      if(active&&dist>thresh()){feel.tap();Nav.commitGesture(view,el);return}
      clearDrag(el,active);
    };
    document.addEventListener('touchend',end,{passive:true});
    document.addEventListener('touchcancel',end,{passive:true});
  })();
  /* Action sheet · pull-to-refresh · long-press · keyboard inset */
  function closeActionSheet(){
    const sh=$('#m-action-sheet');if(!sh)return;
    sh.classList.remove('show');sh.setAttribute('aria-hidden','true');
    setTimeout(()=>sh.remove(),feel.reduced()?0:220);
  }
  function openActionSheet(title,actions){
    closeActionSheet();feel.press();
    const sh=document.createElement('div');sh.id='m-action-sheet';sh.className='m-action-sheet';sh.setAttribute('role','dialog');sh.setAttribute('aria-modal','true');
    sh.innerHTML=`<button type="button" class="m-action-scrim" data-as-close aria-label="Dismiss"></button>
      <div class="m-action-panel">
        ${title?`<div class="m-action-title">${esc(title)}</div>`:''}
        <div class="m-action-list">${actions.map((a,i)=>`<button type="button" class="m-action-btn${a.danger?' is-danger':''}" data-as="${i}">${esc(a.label)}</button>`).join('')}</div>
        <button type="button" class="m-action-cancel" data-as-close>Cancel</button>
      </div>`;
    document.body.append(sh);
    requestAnimationFrame(()=>sh.classList.add('show'));
    sh.addEventListener('click',e=>{
      if(e.target.closest('[data-as-close]')){feel.tap();closeActionSheet();return}
      const b=e.target.closest('[data-as]');if(!b)return;
      const act=actions[+b.dataset.as];feel.tap();closeActionSheet();
      try{act?.run?.()}catch{}
    });
  }
  function skelRows(n=4){
    return `<div class="m-skel-list" aria-hidden="true" aria-busy="true">${Array.from({length:n},()=>`<div class="m-skel-row"><i class="m-skel"></i><span><b class="m-skel"></b><s class="m-skel"></s></span></div>`).join('')}</div>`;
  }
  (function bindTabBarScrollHide(){
    let lastY=0,acc=0,ticking=false;
    const THRESH=10,TOP=36;
    const y=()=>Nav.scrollEl().scrollTop||window.scrollY||0;
    const isHidden=()=>document.body.classList.contains('tabs-hide');
    const canHide=()=>mq.matches&&!deskMq.matches&&!Nav.anyOpen()&&!document.body.classList.contains('kb-open')&&!document.body.classList.contains('brief-open')&&!document.body.classList.contains('loops-open');
    const onScroll=()=>{
      if(ticking)return;ticking=true;
      requestAnimationFrame(()=>{
        ticking=false;
        if(!canHide()){acc=0;lastY=y();setTabsHidden(false);return}
        const cur=y();
        if(cur<=TOP){acc=0;lastY=cur;setTabsHidden(false);return}
        const dy=cur-lastY;lastY=cur;
        if(Math.abs(dy)<1)return;
        const hid=isHidden();
        // Finger swipe up → page scrolls down → fade bar away; swipe down → bring it back
        if((dy>0&&hid)||(dy<0&&!hid)){acc=0;return}
        acc+=dy;
        if(acc>THRESH){acc=0;setTabsHidden(true)}
        else if(acc<-THRESH){acc=0;setTabsHidden(false)}
      });
    };
    // tab screens scroll inside .m-screen, so listen in the capture phase (scroll events do not bubble)
    document.addEventListener('scroll',e=>{const t=e.target;if(t===document||t===Nav.scrollEl())onScroll()},{passive:true,capture:true});
    document.addEventListener('touchstart',()=>{if(canHide()){lastY=y();acc=0}},{passive:true});
    window.addEventListener('daylight:tab',()=>{lastY=y();acc=0;setTabsHidden(false);try{if(mTab!=='wallet')walletStack().exit(true)}catch{}const g=$('#m-loop-grid');if(g&&mTab!=='home')g.style.minHeight=''});
    deskMq.addEventListener?.('change',()=>{setTabsHidden(false);requestAnimationFrame(()=>syncTabThumb(false))});
    addEventListener('resize',()=>requestAnimationFrame(()=>syncTabThumb(false)),{passive:true});
  })();
  (function bindPullRefresh(){
    let startY=0,pulling=false,armed=false,busy=false;
    let ind=$('#m-ptr');
    if(!ind){ind=document.createElement('div');ind.id='m-ptr';ind.className='m-ptr';ind.innerHTML='<i></i><span>Pull to refresh</span>';ind.hidden=true;mapp.prepend(ind)}
    const atTop=()=>(Nav.scrollEl().scrollTop||window.scrollY||0)<=2;
    const reset=()=>{pulling=false;armed=false;ind.classList.remove('armed','loading');ind.hidden=true;ind.style.transform='';mapp.classList.remove('is-pulling')}
    document.addEventListener('touchstart',e=>{
      if(!mq.matches||Nav.anyOpen()||busy||!atTop())return;
      if(mTab!=='home'&&mTab!=='inbox'&&mTab!=='wallet')return;
      if(e.target.closest?.('.wstack'))return;
      startY=e.touches[0].clientY;pulling=true;armed=false;
    },{passive:true});
    document.addEventListener('touchmove',e=>{
      if(!pulling||busy)return;
      const dy=e.touches[0].clientY-startY;
      if(dy<8||!atTop()){if(!armed)return;reset();return}
      if(e.cancelable&&dy>12)e.preventDefault();
      mapp.classList.add('is-pulling');ind.hidden=false;
      const p=Math.min(88,dy*0.42);
      ind.style.transform=`translate3d(-50%,${p-36}px,0)`;
      armed=p>52;ind.classList.toggle('armed',armed);
      ind.querySelector('span').textContent=armed?'Release to refresh':'Pull to refresh';
    },{passive:false});
    document.addEventListener('touchend',async()=>{
      if(!pulling)return;
      const go=armed;reset();
      if(!go||busy)return;
      busy=true;ind.hidden=false;ind.classList.add('loading');ind.querySelector('span').textContent='Refreshing…';
      ind.style.transform='translate3d(-50%,12px,0)';feel.tap();
      try{
        if(token||microsoftAccount){refreshAll.force=true;await refreshAll();if(lastSyncErr)toast(lastSyncPartial?'Partly updated · see the status':'Couldn’t refresh · see the status',{type:'warn',ms:2600});else toast('Updated',{type:'ok',haptic:'success',ms:1800})}
        else{renderMobile();toast('Connect Google to sync live data',{type:'warn',ms:2200})}
      }catch{toast('Couldn’t refresh',{type:'err',haptic:'error'})}
      finally{busy=false;setTimeout(reset,feel.reduced()?0:280)}
    },{passive:true});
  })();
  (function bindLongPress(){
    let timer=0,start=null,moved=false,suppressClick=false;
    const clear=()=>{clearTimeout(timer);timer=0;start=null;moved=false};
    document.addEventListener('click',e=>{
      if(!suppressClick)return;
      if(e.target.closest('[data-open-loop],[data-inbox-open],[data-wid]')){e.preventDefault();e.stopPropagation();suppressClick=false}
    },true);
    document.addEventListener('touchstart',e=>{
      if(!mq.matches||Nav.anyOpen())return;
      const card=e.target.closest('[data-open-loop],[data-inbox-open],[data-wid]');
      if(!card||e.target.closest('a,input,textarea,select'))return;
      const t=e.touches[0];start={x:t.clientX,y:t.clientY,card};
      moved=false;clearTimeout(timer);
      timer=setTimeout(()=>{
        if(!start||moved)return;
        const el=start.card;suppressClick=true;clear();
        if(el.dataset.openLoop){
          const id=el.dataset.openLoop,loop=findLoop(id);if(!loop)return;
          openActionSheet(loop.title,[
            {label:'Open',run:()=>{feel.tap();openLoopSheet(id)}},
            {label:'Snooze until tomorrow',run:()=>{const s=loopState();s[id]={snooze:Date.now()+86400000,t:Date.now()};saveLoopState(s);renderLoops();renderMobile();toast('Snoozed until tomorrow',{type:'ok',haptic:'success'})}},
            {label:'Mark as done',run:()=>{const s=loopState();s[id]={done:true,t:Date.now()};saveLoopState(s);renderLoops();renderMobile();toast('Marked as done',{type:'ok',haptic:'success'})}}
          ]);
        }else if(el.dataset.inboxOpen){
          const id=el.dataset.inboxOpen,item=inboxItems(mInboxFilter).find(i=>i.id===id)||computeMoney().all.find(i=>i.id===id);
          if(!item)return;
          openActionSheet(item.title,[
            {label:'Open details',run:()=>openLoopSheet(inboxToDetail(item))},
            {label:'Snooze until tomorrow',run:()=>{const s=loopState();s['inbox:'+id]={snooze:Date.now()+86400000,t:Date.now()};saveLoopState(s);renderInbox({animate:false});toast('Snoozed until tomorrow',{type:'ok',haptic:'success'})}},
            {label:'Mark as done',run:()=>{const s=loopState();s['inbox:'+id]={done:true,t:Date.now()};saveLoopState(s);renderInbox({animate:false});toast('Marked as done',{type:'ok',haptic:'success'})}}
          ]);
        }else if(el.dataset.wid){
          const id=el.dataset.wid,item=readWallet().find(i=>i.id===id);if(!item)return;
          openActionSheet(item.title,[
            {label:'Open pass',run:()=>openPassSheet(id)},
            {label:'Move category',run:()=>{
              const list=readWallet(),it=list.find(i=>i.id===id);if(!it)return;
              const order=['tickets','coupons','documents','others'];
              it.kind=order[(order.indexOf(it.kind)+1)%order.length];it.color=WALLET_COLORS[it.kind];saveWallet(list);renderWallet();toast('Moved to '+WALLET_LABEL[it.kind],{type:'ok',haptic:'selection'});
            }},
            {label:'Remove from Wallet',danger:true,run:()=>{saveWallet(readWallet().filter(i=>i.id!==id));renderWallet();toast('Removed from Wallet',{type:'warn',haptic:'warning'})}}
          ]);
        }
      },420);
    },{passive:true});
    document.addEventListener('touchmove',e=>{
      if(!start)return;
      const t=e.touches[0];
      if(Math.abs(t.clientX-start.x)>10||Math.abs(t.clientY-start.y)>10){moved=true;clear()}
    },{passive:true});
    document.addEventListener('touchend',clear,{passive:true});
    document.addEventListener('touchcancel',clear,{passive:true});
  })();
  (function bindKeyboardInset(){
    const vv=window.visualViewport;if(!vv)return;
    const sync=()=>{
      if(!mq.matches){document.documentElement.style.removeProperty('--kb');return}
      const kb=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
      document.documentElement.style.setProperty('--kb',kb+'px');
      document.body.classList.toggle('kb-open',kb>80);
    };
    vv.addEventListener('resize',sync);vv.addEventListener('scroll',sync);sync();
  })();
  // Home — compact Daily Brief + Open Loops cards (reference layout)
  function loopTags(l){
    const tags=[];
    if(l.weight>=2||l.type==='overdue')tags.push(['Priority','hot']);
    const short={reply:'Reply',followup:'Waiting',prepare:'Prepare',renewal:'Renewal',travel:'Trip',deadline:'Due'};
    if(short[l.type]&&l.type!=='overdue')tags.push([short[l.type],l.type==='deadline'?'warm':'']);
    if(l.type==='overdue')tags.push(['Reschedule','']);
    if(isFav(l.id))tags.push(['★','']);
    return tags;
  }
  function mobileLoopCard(l){
    const t=LOOP_TYPES[l.type]||LOOP_TYPES.reply,tags=loopTags(l);
    const meta=[srcOf(l),l.meta].filter(Boolean).join(' · ');
    const brand=loopSourceBrand(l);
    const logo=brandLogoHTML(brand,initialsOf(brand.title||l.title));
    return `<button type="button" class="m-row-card ${t.cls}" data-loop="${esc(l.id)}" data-open-loop="${esc(l.id)}">
      <span class="m-row-ico m-brand" style="--a1:${esc(brand.color)};--a2:${esc(brand.color)}" aria-hidden="true">${logo}</span>
      <span class="m-row-main"><b>${esc(l.title)}</b><small>${esc(meta)}</small>${tags.length?`<span class="m-row-tags">${tags.map(([x,c])=>`<span class="atag ${c}">${esc(x)}</span>`).join('')}</span>`:''}</span>
      <span class="m-row-chev" aria-hidden="true">${svg(ICON.chevron,16)}</span>
    </button>`;
  }
  function isHomeToday(ms){
    if(ms==null||ms===''||Number.isNaN(+ms))return false;
    const Data=window.DaylightData;
    if(Data?.sameLocalDay)return Data.sameLocalDay(ms,localMidnight);
    const t=+ms;return t>=localMidnight.getTime()&&t<localMidnight.getTime()+86400000;
  }
  function dueDayLocal(v){
    if(!v)return null;
    const d=new Date(v);
    if(Number.isNaN(d.getTime()))return null;
    return /T00:00:00(\.000)?Z$/.test(String(v))?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate());
  }
  /** Today-only Daily Brief buckets — no multi-day noise. */
  function collectHomeDayBuckets(){
    const Data=window.DaylightData;
    const loops=(token||microsoftAccount||DEMO)?computeLoops():[];
    const money=(token||microsoftAccount||DEMO)?computeMoney():{pending:[],bill:[],all:[]};
    const {timed,allDay,connected}=todayEvents();
    const todo=loops.filter(l=>{
      if(l.type==='overdue')return true; // still owed today
      if(l.type==='deadline')return isHomeToday(l.whenMs);
      if(l.type==='reply')return isHomeToday(l.whenMs);
      return false;
    }).map(l=>({kind:'action',bucket:'todo',id:l.id,title:l.title,meta:l.meta||l.detail||'',type:l.type,href:l.href||'',mailId:l.mailId||null,whenMs:l.whenMs||0,overdue:l.type==='overdue',dueToday:l.type!=='overdue'&&isHomeToday(l.whenMs)}));
    // Tasks due today (Daylight / Google / To Do)
    [
      ...personalTasks.map(t=>({...t,src:'Daylight'})),
      ...(providerData.google.tasks||[]).map(t=>({...t,src:'Google Tasks'})),
      ...(providerData.microsoft.tasks||[]).map(t=>({...t,src:'To Do'}))
    ].forEach(t=>{
      if(!t?.title||!t.dueDate)return;
      const due=dueDayLocal(t.dueDate);if(!due)return;
      if(!isHomeToday(due)&&!(due<localMidnight))return;
      const overdue=due<localMidnight,tag=overdue?'Overdue':'Due today';
      todo.push({kind:'task',bucket:'todo',id:'task:'+(t.id||t.title),title:t.title,meta:[tag,t.listName||t.project||t.src].filter(Boolean).join(' · '),href:t.href||'',mailId:t.mailId||null,whenMs:due.getTime(),overdue,dueToday:!overdue});
    });
    const waiting=loops.filter(l=>l.type==='followup').map(l=>({kind:'action',bucket:'waiting',id:l.id,title:l.title,meta:l.meta||l.detail||'',type:l.type,href:l.href||'',mailId:l.mailId||null,whenMs:l.whenMs||0}));
    // Only confirmed or well-evidenced obligations with a real due date count as payments (never receipts, refunds or promos).
    const payments=(money.obligations||[])
      .filter((x,i,a)=>a.findIndex(y=>y.id===x.id||(y.mailId&&y.mailId===x.mailId))===i)
      .filter(p=>{
        const ms=+(p.when||0);
        if(!ms)return !p.fin; // a task you created without a date still shows
        return ms<localMidnight.getTime()+86400000;
      })
      .map(p=>{
        const whenMs=p.when||p.whenMs||0;
        const overdue=whenMs&&whenMs<localMidnight.getTime();
        return {kind:'pay',bucket:'payments',id:p.id||p.mailId,title:p.title||p.subject||'Payment',meta:[p.amount,p.meta||p.tag,overdue?'Overdue':isHomeToday(whenMs)?'Due today':''].filter(Boolean).join(' · '),amount:p.amount||'',href:p.href||'',mailId:p.mailId||null,whenMs,overdue,dueToday:!!isHomeToday(whenMs)};
      });
    try{
      (Data?.orders?Data.orders({excludeCancelled:true}):[]).forEach(o=>{
        const ev=Data.eventAt(o);if(!ev||!isHomeToday(ev))return;
        payments.push({kind:'pay',bucket:'payments',id:'ord:'+o.id,title:(o.merchant||'Order')+' delivery',meta:o.status||'delivery',href:o.href||'',mailId:o.mailId||null,whenMs:ev.getTime()});
      });
    }catch{}
    const events=timed.filter(e=>isHomeToday(e.start)).map(e=>({
      kind:'cal',bucket:'events',id:'ev:'+e.start.getTime()+e.title,title:e.title,
      meta:`${hm(e.start)} – ${hm(e.end)}`,whenMs:e.start.getTime(),href:e.href||''
    }));
    allDay.forEach(t=>events.push({kind:'cal',bucket:'events',id:'allday:'+t,title:t,meta:'All day',whenMs:localMidnight.getTime()}));
    try{
      (Data?.walletItems?Data.walletItems({filter:'tickets'}):[]).forEach(w=>{
        const ev=Data.eventAt(w);if(!ev||!isHomeToday(ev))return;
        if(w.status==='cancelled'||w.walletStatus==='cancelled')return;
        events.push({kind:'cal',bucket:'events',id:'travel:'+w.id,title:w.title,meta:w.typeLabel||'Travel',whenMs:ev.getTime(),href:w.href||'',mailId:w.mailId||null,walletId:w.id});
      });
    }catch{}
    const sortMs=(a,b)=>(a.whenMs||0)-(b.whenMs||0);
    todo.sort(sortMs);waiting.sort(sortMs);payments.sort(sortMs);events.sort(sortMs);
    const counts={todo:todo.length,waiting:waiting.length,payments:payments.length,events:events.length};
    const connectedNow=!!(token||microsoftAccount||DEMO);
    const prose=composeDailyBriefProse({todo,payments,events,connected:connectedNow,calConnected:!!connected});
    const attention=todo.filter(t=>t.overdue).length+payments.filter(p=>p.overdue).length;
    const bits=[];
    if(counts.todo)bits.push(`${counts.todo} to do`);
    if(counts.waiting)bits.push(`${counts.waiting} waiting`);
    if(counts.payments)bits.push(`${counts.payments} payment${counts.payments===1?'':'s'}`);
    if(counts.events)bits.push(`${counts.events} event${counts.events===1?'':'s'}`);
    const summary=!connectedNow
      ?'Connect Google to brief today’s mail, calendar and tasks.'
      :(bits.length?`Today · ${bits.join(' · ')}`:prose);
    return {todo,waiting,payments,events,counts,summary,prose,attention,connected:connectedNow,calConnected:!!connected};
  }
  function spokenCount(n){
    const w=['','one','two','three','four','five','six','seven','eight','nine','ten'];
    return n>0&&n<=10?w[n]:String(n);
  }
  function joinAnd(parts){
    if(!parts.length)return '';
    if(parts.length===1)return parts[0];
    if(parts.length===2)return parts[0]+' and '+parts[1];
    return parts.slice(0,-1).join(', ')+', and '+parts[parts.length-1];
  }
  function capFirst(s){return s?s.charAt(0).toUpperCase()+s.slice(1):s}
  function composeDailyBriefProse(day){
    if(!day.connected)return 'Connect Google to brief today’s mail, calendar and tasks.';
    const tasks=day.todo||[],pays=day.payments||[],evs=day.events||[];
    const overdueTasks=tasks.filter(t=>t.overdue);
    const overduePays=pays.filter(p=>p.overdue);
    const dueTodayTasks=tasks.filter(t=>t.dueToday&&!t.overdue);
    const dueTodayPays=pays.filter(p=>p.dueToday&&!p.overdue);
    const resched=overdueTasks.filter(t=>t.type==='overdue');
    const sentences=[];
    const inv=[];
    if(tasks.length)inv.push(`${tasks.length} ${tasks.length===1?'task':'tasks'}`);
    if(pays.length)inv.push(`${pays.length} ${pays.length===1?'payment':'payments'}`);
    if(inv.length)sentences.push(`You have ${joinAnd(inv)} to manage today.`);
    else if(!evs.length)sentences.push('You’re in good shape today — nothing needs attention.');
    const urg=[];
    if(overduePays.length&&overdueTasks.length&&!(resched.length&&resched.length===overdueTasks.length))
      urg.push(`${spokenCount(overduePays.length)} ${overduePays.length===1?'payment':'payments'} and ${spokenCount(overdueTasks.length)} ${overdueTasks.length===1?'task':'tasks'} are overdue`);
    else{
      if(overduePays.length)urg.push(`${spokenCount(overduePays.length)} ${overduePays.length===1?'payment is':'payments are'} overdue`);
      if(resched.length&&resched.length===overdueTasks.length)urg.push(`${spokenCount(resched.length)} ${resched.length===1?'task needs':'tasks need'} rescheduling`);
      else if(overdueTasks.length)urg.push(`${spokenCount(overdueTasks.length)} ${overdueTasks.length===1?'task is':'tasks are'} overdue`);
    }
    if(dueTodayPays.length&&overduePays.length)urg.push(`${spokenCount(dueTodayPays.length)} more ${dueTodayPays.length===1?'is':'are'} due today`);
    if(dueTodayTasks.length&&overdueTasks.length)urg.push(`${spokenCount(dueTodayTasks.length)} ${dueTodayTasks.length===1?'task is':'tasks are'} due today`);
    if(urg.length)sentences.push(capFirst(urg.length===2?urg[0]+', and '+urg[1]:joinAnd(urg))+'.');
    if(!evs.length){
      if(inv.length||urg.length)sentences.push('Your calendar is clear today.');
    }else{
      const next=evs[0];
      const t=next.whenMs?hm(new Date(next.whenMs)):'';
      if(evs.length===1)sentences.push(t?`Next up: ${next.title} at ${t}.`:`Today’s event is ${next.title}.`);
      else sentences.push(`You have ${evs.length} events today${t?`, starting at ${t}`:''}.`);
    }
    return sentences.filter(Boolean).slice(0,3).join(' ');
  }
  // ======== Home v3: Daily Brief (today, linked coloured chips) · Today's Schedule (day timeline) · Priority Actions (mail, 7 days) ========
  const HOME_KIND={task:'Task',reply:'Reply',pay:'Payment',travel:'Travel',deadline:'Deadline',reminder:'Reminder',event:'Event',renewal:'Renewal'};
  setTimeout(()=>{try{ensureHomeV3Styles()}catch{}},0); // shared tile styles are needed even if the app opens on Inbox
  function ensureHomeV3Styles(){
    if($('#home-v3-css'))return;
    const st=document.createElement('style');st.id='home-v3-css';st.textContent=`
      :root{--k-task:#1d4ed8;--k-task-bg:rgba(37,99,235,.11);--k-pay:#a14b05;--k-pay-bg:rgba(245,158,11,.16);--k-travel:#0b6b63;--k-travel-bg:rgba(20,184,166,.15);
        --k-deadline:#b42318;--k-deadline-bg:rgba(239,68,68,.12);--k-reminder:#6d28d9;--k-reminder-bg:rgba(139,92,246,.13);--k-event:#3730a3;--k-event-bg:rgba(99,102,241,.13);
        --k-renewal:#475569;--k-renewal-bg:rgba(100,116,139,.15);--k-reply:#9d174d;--k-reply-bg:rgba(236,72,153,.12)}
      body.dark{--k-task:#a9c7ff;--k-task-bg:rgba(96,140,255,.2);--k-pay:#ffd48a;--k-pay-bg:rgba(245,158,11,.22);--k-travel:#7fe3d6;--k-travel-bg:rgba(20,184,166,.22);
        --k-deadline:#ffb4ab;--k-deadline-bg:rgba(239,68,68,.22);--k-reminder:#d4bcff;--k-reminder-bg:rgba(139,92,246,.24);--k-event:#c7c9ff;--k-event-bg:rgba(99,102,241,.24);
        --k-renewal:#cbd5e1;--k-renewal-bg:rgba(148,163,184,.22);--k-reply:#ffb0d4;--k-reply-bg:rgba(236,72,153,.22)}
      .bchip{display:inline;border:0;margin:0;padding:0;background:none!important;border-radius:3px;
        font:inherit;font-weight:600;cursor:pointer;text-align:left;white-space:normal;text-decoration:none}
      @media(hover:hover){.bchip:hover{opacity:.8}}.bchip{padding:6px 0;margin:-6px 0;-webkit-box-decoration-break:clone;box-decoration-break:clone}
      .bchip:focus-visible{outline:2px solid currentColor;outline-offset:1px}
      .bchip small{font-weight:500;opacity:.85;font-size:inherit}
      .bchip.k-task{color:var(--k-task);background:var(--k-task-bg)}.bchip.k-reply{color:var(--k-reply);background:var(--k-reply-bg)}
      .bchip.k-pay{color:var(--k-pay);background:var(--k-pay-bg)}.bchip.k-travel{color:var(--k-travel);background:var(--k-travel-bg)}
      .bchip.k-deadline{color:var(--k-deadline);background:var(--k-deadline-bg)}.bchip.k-event{color:var(--k-event)}.bchip.past{opacity:.55}.bchip.k-more{color:var(--muted);background:var(--card2)}
      .bchip .bdot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
      body.m .m-schedule-prose.v3{font:450 14.5px/1.7 var(--font);color:var(--ink)}body.m .m-schedule-prose.v3 b.lbl{font-weight:650}
      body.m .m-brief-prose.v3{color:color-mix(in srgb,var(--ink) 62%,var(--card));font:450 14.5px/1.7 var(--font);word-spacing:normal;letter-spacing:0}
      body.m .m-brief-prose.v3 .bs{display:inline}body.m .m-brief-prose.v3 .bnote{color:var(--muted)}
      body.m .m-brief-prose.v3 b.lbl{font-weight:650;color:color-mix(in srgb,var(--ink) 72%,var(--card))}
      .m-brief-legend{display:flex;flex-wrap:wrap;gap:6px 12px;font:600 11.5px/1 var(--font);color:var(--muted)}
      .m-brief-legend i{display:inline-block;width:8px;height:8px;border-radius:3px;margin-right:5px;vertical-align:-1px}
      /* day timeline */
      .dl{position:relative;margin-top:6px}
      .dl-allday{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px 44px}
      .dl-allday a,.dl-allday span{font:650 12px/1.2 var(--font);padding:5px 9px;border-radius:8px;background:var(--k-event-bg);color:var(--k-event);text-decoration:none}
      .dl-scroll{position:relative;max-height:396px;overflow-y:auto;border-radius:14px;background:var(--card2);overscroll-behavior:contain}
      .dl-grid{position:relative}
      .dl-hour{position:absolute;left:0;right:0;height:0;border-top:1px solid var(--line)}
      .dl-hour span{position:absolute;left:6px;top:-8px;font:600 10.5px/1 var(--font);color:var(--muted);background:var(--card2);padding:0 3px}
      .dl-ev{position:absolute;display:block;overflow:hidden;border-radius:9px;padding:4px 7px;text-decoration:none;box-sizing:border-box;
        border-left:3px solid currentColor;background:var(--k-event-bg);color:var(--k-event)}
      .dl-ev b{display:block;font:700 12.5px/1.25 var(--font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dl-ev small{display:block;font:600 11px/1.25 var(--font);opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dl-ev.t-travel{background:var(--k-travel-bg);color:var(--k-travel)}.dl-ev.t-focus{background:var(--k-task-bg);color:var(--k-task)}
      .dl-ev.t-meet{background:var(--k-reminder-bg);color:var(--k-reminder)}.dl-ev.past{opacity:.55}
      .dl-now{position:absolute;left:38px;right:0;height:0;border-top:2px solid #ef4444;z-index:3}
      .dl-now::before{content:'';position:absolute;left:-5px;top:-5px;width:8px;height:8px;border-radius:50%;background:#ef4444}
      /* priority list */
      /* Priority Actions tiles = Inbox tiles (same padding, radius and logo size) */
      body.m .m-inbox-card.pa-row{width:100%;margin:0}
      body.m .m-loop-list:has(.pa-row){gap:6px}
      body.m .m-swipe>.m-inbox-card{width:100%;position:relative;z-index:1}body.m .m-swipe{border-radius:18px}body.m .m-swipe:not(.open):not(.dragging) .m-swipe-actions{visibility:hidden}
      body.m .m-inbox-card .m-inbox-side{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:4px;margin:0;padding:0}body.m .m-inbox-card.pa-row .m-inbox-top time{white-space:nowrap}
      .pa-day{font:750 12px/1 var(--font);letter-spacing:.02em;text-transform:uppercase;color:var(--muted);margin:14px 2px 6px}
      .pa-day.is-overdue{color:var(--k-deadline)}
      .pa-card{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1px solid var(--line);background:var(--card);color:inherit;border-radius:16px;padding:10px 12px;margin:0 0 8px;cursor:pointer;font:inherit}
      .pa-time{flex:none;width:52px;text-align:center;font:750 13px/1.15 var(--font);color:var(--ink)}
      .pa-time small{display:block;font:600 10.5px/1.2 var(--font);color:var(--muted)}
      .pa-main{flex:1;min-width:0;display:grid;gap:3px}
      .pa-main b{font:700 14px/1.3 var(--font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pa-main small{font:500 12px/1.3 var(--font);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pa-pill{flex:none;font:700 11px/1 var(--font);padding:6px 8px;border-radius:999px}
      .pa-pill.k-pay{color:var(--k-pay);background:var(--k-pay-bg)}.pa-pill.k-deadline{color:var(--k-deadline);background:var(--k-deadline-bg)}
      .pa-pill.k-reminder{color:var(--k-reminder);background:var(--k-reminder-bg)}.pa-pill.k-travel{color:var(--k-travel);background:var(--k-travel-bg)}
      .pa-pill.k-event{color:var(--k-event);background:var(--k-event-bg)}.pa-pill.k-renewal{color:var(--k-renewal);background:var(--k-renewal-bg)}
      .pa-amt{display:block;font:700 12px/1.2 var(--font);color:var(--k-pay);margin-top:2px}`;
    document.head.append(st);
  }
  const dayStartMs=()=>localMidnight.getTime();
  function fmtDayLabel(ms){
    const d0=dayStartMs(),days=Math.floor((ms-d0)/86400000);
    if(ms<d0)return 'Overdue';
    if(days===0)return 'Today';if(days===1)return 'Tomorrow';
    return new Date(ms).toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'short'});
  }
  // ---- mail-sourced dated items (deadlines, reminders, travel, events) — never from bulk / marketing mail ----
  const CANCEL_RX=/\b(cancel(?:l?ed|lation)|zrušen\p{L}*|storniert|annul\p{L}*)\b/iu;
  const REF_RX=/\b(?=[A-Z0-9-]{5,14}\b)(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,13}\b/g;
  function mailPool(){
    const seen=new Map();
    [...(loopsData?.inbox||[]),...(loopsData?.financeMail||[]),...(loopsData?.travelMail||[]),...(loopsData?.docsMail||[])].forEach(m=>{if(m?.id&&!seen.has(m.id))seen.set(m.id,m)});
    return [...seen.values()];
  }
  function mailTextOf(m){
    const R=window.DaylightGmailRules;let body='';
    try{if(R&&(m.payload?.parts||m.payload?.body?.data)){const b=R.bodyOf(m);body=b.text||R.htmlToText(b.html||'')}}catch{}
    return body||m.snippet||'';
  }
  function mailKeyItems(fromMs,toMs){
    const D=window.DaylightMailDates;if(!D)return [];
    const out=[],pool=mailPool();
    // references named in cancellation emails cancel the matching travel/reservation items
    const cancelledRefs=new Set(),cancelledThreads=new Set();
    pool.forEach(m=>{const h=m.payload?.headers||[],s=header(h,'Subject')+' '+(m.snippet||'');if(isMarketingMail(m)||!CANCEL_RX.test(s))return;cancelledThreads.add(m.threadId);(s.match(REF_RX)||[]).forEach(r=>cancelledRefs.add(r))});
    const byThread=new Map();
    pool.forEach(m=>{
      if(isMarketingMail(m))return;
      const h=m.payload?.headers||[],subject=header(h,'Subject')||'(No subject)',received=Number(m.internalDate)||Date.parse(header(h,'Date'))||Date.now();
      const cat=m._cache?.category;
      let kds=m._keyDates;
      if(!kds){try{kds=D.extract(mailTextOf(m),{subject,receivedMs:received})}catch{kds=[]}}
      (kds||[]).forEach(kd=>{
        if((cat==='receipt'||cat==='payment'||cat==='refund')&&kd.kind==='deadline')return; // "due date" inside a receipt is not a to-do
        const ms=D.toMs(kd);if(!(ms>=fromMs&&ms<toMs))return;
        const from=parseFrom(header(h,'From'));
        const refs=(subject+' '+(kd.quote||'')).match(REF_RX)||[];
        if(kd.kind==='travel'||kd.kind==='reminder'){if(refs.some(r=>cancelledRefs.has(r))&&!CANCEL_RX.test(subject))return}
        if(CANCEL_RX.test(subject))return; // the cancellation email itself is not an upcoming item
        const it={kind:kd.kind,id:'mail-date:'+m.id+':'+kd.date+(kd.time||''),title:subject,whenMs:ms,hasTime:!!kd.time,quote:kd.quote,from:from.name||from.email,
          href:gmailLink(m.threadId||m.id),mailId:m.id,threadId:m.threadId,received,source:'Gmail',refs};
        // one item per thread and kind: the newest email wins (e.g. a schedule change replaces the original time)
        const k=(m.threadId||m.id)+'|'+kd.kind,prev=byThread.get(k);
        if(!prev||received>prev.received)byThread.set(k,it);
      });
    });
    byThread.forEach(v=>out.push(v));
    // the same trip often arrives as several emails (booking, boarding pass, check-in): one item, newest email wins
    const merged=[];
    out.sort((a,b)=>b.received-a.received).forEach(x=>{
      if(x.kind==='travel'||x.kind==='reminder'){
        const dup=merged.find(y=>y.kind===x.kind&&(Math.abs(y.whenMs-x.whenMs)<=15*60000||(x.refs.length&&x.refs.some(r=>y.refs.includes(r))&&Math.abs(y.whenMs-x.whenMs)<2*86400000)));
        if(dup){dup.also=(dup.also||[]).concat(x.mailId);return}
      }
      merged.push(x);
    });
    return merged;
  }
  /** Bills due (Phase 2 ledger) and scheduled renewals, from mail. */
  function mailMoneyItems(fromMs,toMs){
    const out=[];
    try{(computeMoney().obligations||[]).forEach(p=>{
      if(!p.mailId&&!p.fin)return;
      const when=+(p.when||p.whenMs||0);if(!when||when>=toMs)return;
      if(when<fromMs-30*86400000)return;
      out.push({kind:'pay',id:'pay:'+(p.id||p.mailId),title:p.fin?.merchant||p.title||p.subject||'Payment due',subject:p.subject||'',whenMs:when,hasTime:false,amount:p.amount||'',
        from:p.from||p.detail||'',href:p.href||(p.mailId?gmailLink(p.mailId):''),mailId:p.mailId||null,threadId:p.threadId||null,finKey:p.fin?.key||null,source:'Gmail',overdue:when<dayStartMs()});
    })}catch{}
    try{(loopsData?.finance?.records||[]).forEach(r=>{
      if(r.dismissed)return;
      const date=r.category==='subscription_renewal'?r.renewalDate:(r.status==='scheduled_debit'?r.dueDate:null);if(!date)return;
      const [y,mo,d]=date.split('-').map(Number),ms=new Date(y,mo-1,d,9).getTime();if(!(ms>=fromMs&&ms<toMs))return;
      out.push({kind:'renewal',id:'renew:'+r.key,title:r.merchant||r.subject||'Renewal',subject:r.subject||'',whenMs:ms,hasTime:false,amount:r.amount?window.DaylightFinance?.fmtAmount?.(r.amount)||'':'',
        from:r.fromName||'',href:r.mailIds?.[0]?gmailLink(r.mailIds[0]):'',mailId:r.mailIds?.[0]||null,finKey:r.key,source:'Gmail',auto:true});
    })}catch{}
    return out;
  }
  // ---- Daily Brief: today only ----
  function collectBriefToday(){
    const d0=dayStartMs(),d1=d0+86400000,now=Date.now();
    const tasks=[],pays=[],travel=[],replies=[];
    const seenTask=new Set();
    [...personalTasks.map(t=>({...t,src:'Daylight'})),...(providerData.google.tasks||[]).map(t=>({...t,src:'Google Tasks'})),...(providerData.microsoft.tasks||[]).map(t=>({...t,src:'To Do'}))].forEach(t=>{
      if(!t?.title||!t.dueDate||isLegacyPayTask(t))return;
      const due=dueDayLocal(t.dueDate);if(!due||due.getTime()>=d1)return;
      const k=t.title.trim().toLowerCase();if(seenTask.has(k))return;seenTask.add(k);
      const overdue=due.getTime()<d0,ms=t.hasTime?new Date(t.dueDate).getTime():due.getTime();
      const href=t.href||(t.src==='Google Tasks'?'https://tasks.google.com/':t.src==='To Do'?'https://to-do.office.com/':'');
      const it={kind:PAY_TASK.test(t.title)?'pay':'task',id:'task:'+(t.id||t.title),title:t.title,whenMs:ms,hasTime:!!t.hasTime,overdue,href,source:t.src};
      (it.kind==='pay'?pays:tasks).push(it);
    });
    mailMoneyItems(d0,d1).forEach(x=>{if(x.kind==='pay')pays.push(x)});
    // a payment task and the bill email for the same thing are one payment (e.g. "Pay rent" + the landlord's "Nájem" email)
    const SYN=[['rent','nájem','nájm','miete','landlord'],['electric','elektřin','elektrin','strom','energie','čez','cez'],['insurance','pojist','versicher'],['phone','mobile','telefon','mobil','vodafone','o2','t-mobile'],['internet','wifi'],['water','vod'],['gas','plyn'],['school','škol','tuition'],['tax','daň','steuer']];
    const topics=t=>{const x=String(t||'').toLowerCase();return SYN.filter(g=>g.some(w=>x.includes(w))).map(g=>g[0])};
    for(const tk of pays.filter(p=>p.id.startsWith('task:'))){
      const tt=topics(tk.title);if(!tt.length)continue;
      const bill=pays.find(p=>p!==tk&&!p.id.startsWith('task:')&&topics(p.title+' '+(p.subject||'')+' '+(p.from||'')).some(x=>tt.includes(x)));
      if(bill){bill.linkedTask=tk.title;pays.splice(pays.indexOf(tk),1)}
    }
    const payMail=new Set(pays.map(p=>p.mailId).filter(Boolean));
    mailKeyItems(d0,d1).forEach(x=>{if(x.mailId&&payMail.has(x.mailId))return;if(x.kind==='deadline')tasks.push({...x,kind:'deadline'});else if(x.kind==='travel')travel.push(x);else if(x.kind==='reminder'||x.kind==='event')tasks.push({...x})});
    // travel on the calendar today (one entry per trip: a calendar flight and its booking email are merged by time)
    const {timed}=todayEvents();
    timed.filter(e=>TRAVEL.test(e.title+' '+(e.location||''))&&e.start>=new Date(d0)).forEach(e=>{
      const near=travel.find(t=>Math.abs(t.whenMs-e.start.getTime())<=3*3600000);
      if(near){near.calHref=e.href;return}
      travel.push({kind:'travel',id:'cal:'+(e.id||e.start.getTime()),title:e.title,whenMs:e.start.getTime(),hasTime:true,href:e.href,source:'Calendar'});
    });
    const replyThreads=new Set();
    (computeLoops()||[]).filter(l=>l.type==='reply'&&(!l.whenMs||now-l.whenMs<=2*86400000)&&!payMail.has(l.mailId)).forEach(l=>{replyThreads.add(l.threadId);replies.push({kind:'reply',id:l.id,title:l.fromName||l.title.replace(/^Reply to\s*/,''),whenMs:l.whenMs,href:l.href,mailId:l.mailId,threadId:l.threadId,loopId:l.id,source:'Gmail'})});
    // unread mail from people that arrived in the last 2 hours (not yet a reply loop)
    (loopsData?.inbox||[]).forEach(m=>{
      if(!m?.id||isBulkMail(m)||payMail.has(m.id)||replyThreads.has(m.threadId))return;
      const labels=m.labelIds||[];if(!labels.includes('UNREAD'))return;
      const cc=m._cache?.category;if(cc&&!['personal','other'].includes(cc))return;
      const h=m.payload?.headers||[],when=new Date(header(h,'Date')||m.internalDate*1).getTime();if(!isHomeToday(when))return;
      const from=parseFrom(header(h,'From'));replyThreads.add(m.threadId);
      replies.push({kind:'reply',id:'reply:'+(m.threadId||m.id),title:from.name||from.email,whenMs:when,href:gmailLink(m.threadId||m.id),mailId:m.id,threadId:m.threadId,source:'Gmail'});
    });
    const byTime=(a,b)=>(b.overdue?1:0)-(a.overdue?1:0)||(a.whenMs||0)-(b.whenMs||0);
    [tasks,pays,travel,replies].forEach(a=>a.sort(byTime));
    const ev=timed.filter(e=>isHomeToday(e.start));
    return {tasks,pays,travel,replies,events:ev,allDay:todayEvents().allDay,connected:!!(token||microsoftAccount||DEMO)};
  }
  function chipTime(it){if(!it.whenMs)return '';if(it.overdue)return 'overdue';if(it.hasTime)return hm(new Date(it.whenMs));return ''}
  function briefChip(it){
    const kind=it.kind==='reminder'||it.kind==='event'?'task':it.kind;
    const t=chipTime(it),tt=t&&t!=='overdue'?`${it.kind==='deadline'?'by':'at'} ${t}`:'';
    const extra=[it.amount,it.kind==='pay'&&t==='overdue'?'overdue':''].filter(Boolean).join(', ');
    return `<span role="button" tabindex="0" class="bchip k-${esc(kind)}" data-brief-kind="${esc(it.kind)}" data-brief-id="${esc(it.id||'')}" ${it.href?`data-brief-href="${esc(it.href)}"`:''} ${it.mailId?`data-brief-mail="${esc(it.mailId)}"`:''} ${it.finKey?`data-brief-fin="${esc(it.finKey)}"`:''} ${it.loopId?`data-brief-loop="${esc(it.loopId)}"`:''} title="${esc((HOME_KIND[it.kind]||'')+' · '+(it.source||''))}">${esc(it.title)}${extra?` <small>(${esc(extra)})</small>`:''}${tt?` <small>${esc(tt)}</small>`:''}</span>`;
  }
  function chipList(list,max){
    const shown=list.slice(0,max||4).map(briefChip),more=list.length-(max||4);
    if(more>0)shown.push(`<span role="button" tabindex="0" class="bchip k-more" data-brief-kind="more">${more} more</span>`);
    return shown.length>1?shown.slice(0,-1).join(', ')+' and '+shown.at(-1):(shown[0]||'');
  }
  function composeBriefV3(b){
    if(!b.connected)return esc('Connect Google to brief today’s mail, calendar and tasks.');
    const s=[];
    const todo=b.tasks.filter(t=>!t.overdue),late=b.tasks.filter(t=>t.overdue);
    const line=(lbl,html)=>`<span class="bs"><b class="lbl">${esc(lbl)}</b> ${html}.</span>`;
    if(todo.length)s.push(line('To do today:',chipList(todo)));
    if(late.length)s.push(line('Overdue:',chipList(late)));
    const payToday=b.pays.filter(p=>!p.overdue),payLate=b.pays.filter(p=>p.overdue);
    if(payToday.length||payLate.length)s.push(line('Pay',chipList([...payLate,...payToday])));
    if(b.travel.length)s.push(line('Travel:',chipList(b.travel)));
    if(b.replies.length)s.push(line('Reply to',chipList(b.replies,3)));
    const now=new Date(),next=b.events.find(e=>e.end>now);
    // calendar summary lives in Today's Schedule, not in the brief
    if(!s.length)return esc('Nothing due today — a clear day.');
    return s.join(' ');
  }
  function renderBriefV3(){
    const brief=$('#m-brief');if(!brief)return;
    ensureHomeV3Styles();
    const b=collectBriefToday();
    const attention=b.tasks.filter(t=>t.overdue).length+b.pays.filter(p=>p.overdue).length;
    const dateLabel=new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
    const actions=b.tasks.length+b.pays.length+b.travel.length+b.replies.length;
    const status=b.connected?(actions?`<span class="m-brief-status${attention?' is-hot':''}" title="${attention?esc(attention+' overdue'):''}">${actions} ${actions===1?'Action':'Actions'}</span>`:'<span class="m-brief-status">On track</span>'):'';
    const n=b.tasks.length+b.replies.length;
    brief.innerHTML=`<div class="m-brief-head">
        <span class="m-brief-ico" aria-hidden="true">${svg(ICON.sunFill,28)}</span>
        <div class="m-brief-copy"><b>Daily brief</b><small>${esc(dateLabel)}</small></div>${status}
      </div>
      <p class="m-brief-prose v3">${composeBriefV3(b)}</p>
      <div class="m-brief-legend" aria-hidden="true"><span><i style="background:var(--k-task)"></i>Tasks ${n}</span><span><i style="background:var(--k-pay)"></i>Payments ${b.pays.length}</span><span><i style="background:var(--k-travel)"></i>Travel ${b.travel.length}</span><span><i style="background:var(--k-deadline)"></i>Deadlines ${b.tasks.filter(t=>t.kind==='deadline').length}</span></div>`;
  }
  // ---- Today's Schedule: day timeline (all calendars, declined left out) ----
  function scheduleKind(e){
    if(TRAVEL.test(e.title+' '+(e.location||'')))return 't-travel';
    if(/\b(focus|deep work|heads.?down|writing|coding)\b/i.test(e.title))return 't-focus';
    if((e.guests||0)>1||e.online)return 't-meet';
    return '';
  }
  function renderHomeSchedule(){
    const rail=$('#m-schedule-rail');if(!rail)return;
    ensureHomeV3Styles();
    const proseEl=$('#m-schedule-prose');
    let {timed,allDay,connected}=todayEvents();
    const allDayItems=todayEvents.allDayItems||[];
    const d0=localMidnight.getTime(),d1=d0+86400000;
    const items=timed.filter(e=>e.end.getTime()>d0&&e.start.getTime()<d1);
    if(proseEl){proseEl.classList.add('v3');proseEl.innerHTML=composeScheduleSentence(items.filter(e=>isHomeToday(e.start)),allDayItems,connected)}
    // the day timeline is no longer shown on Home — the sentence above lists every event (Timeline tab has the full calendar)
    rail.innerHTML='';rail.hidden=true;return;
    if(!items.length&&!allDay.length){rail.innerHTML='';rail.hidden=true;return}
    rail.hidden=false;
    const PX=46,hOf=t=>(Math.max(d0,Math.min(d1,t))-d0)/3600000;
    let h0=8,h1=20;
    items.forEach(e=>{if(e.start.getTime()>=d0)h0=Math.min(h0,Math.floor(hOf(e.start.getTime())));h1=Math.max(h1,Math.ceil(hOf(e.end.getTime())))});
    h0=Math.max(0,h0);h1=Math.min(24,Math.max(h1,h0+4));
    // lanes for overlapping events
    const sorted=items.slice().sort((a,b)=>a.start-b.start||b.end-a.end),clusters=[];let cur=null;
    sorted.forEach(e=>{if(!cur||e.start>=cur.end){cur={end:e.end,list:[]};clusters.push(cur)}cur.list.push(e);if(e.end>cur.end)cur.end=e.end});
    clusters.forEach(c=>{const lanes=[];c.list.forEach(e=>{let l=lanes.findIndex(t=>t<=e.start);if(l<0){l=lanes.length;lanes.push(e.end)}else lanes[l]=e.end;e._lane=l});c.list.forEach(e=>{e._lanes=lanes.length})});
    const now=Date.now();
    const hours=[];for(let h=h0;h<=h1;h++)hours.push(`<div class="dl-hour" style="top:${(h-h0)*PX}px"><span>${String(h%24).padStart(2,'0')}:00</span></div>`);
    const blocks=sorted.map(e=>{
      const sH=Math.max(h0,hOf(e.start.getTime())),eH=Math.max(sH+0.4,hOf(e.end.getTime()));
      const top=(sH-h0)*PX,ht=Math.max(24,(eH-sH)*PX-3);
      const w=`calc((100% - 46px) / ${e._lanes})`,left=`calc(44px + (100% - 46px) / ${e._lanes} * ${e._lane})`;
      const sub=`${hm(e.start)}–${hm(e.end)}${e.location?' · '+e.location:''}`;
      const tag=e.href?'a':'div',attrs=e.href?`href="${esc(e.href)}" target="_blank" rel="noopener"`:'';
      return `<${tag} class="dl-ev ${scheduleKind(e)}${e.end.getTime()<now?' past':''}" ${attrs} style="top:${top}px;height:${ht}px;left:${left};width:${w}" title="${esc(sub+' · '+e.title)}"><b>${esc(e.title)}</b>${ht>34?`<small>${esc(sub)}</small>`:''}</${tag}>`;
    }).join('');
    const nowTop=(now>=d0&&now<d1)?(hOf(now)-h0)*PX:null;
    const allDayHtml=allDayItems.length?`<div class="dl-allday">${allDayItems.map(e=>e.htmlLink?`<a href="${esc(e.htmlLink)}" target="_blank" rel="noopener">All day · ${esc(e.summary||e.subject||'(No title)')}</a>`:`<span>All day · ${esc(e.summary||e.subject||'(No title)')}</span>`).join('')}</div>`:'';
    rail.innerHTML=`<div class="dl">${allDayHtml}${items.length?`<div class="dl-scroll" id="dl-scroll"><div class="dl-grid" style="height:${(h1-h0)*PX+8}px">${hours.join('')}${blocks}${nowTop!=null&&nowTop>=0&&nowTop<=(h1-h0)*PX?`<div class="dl-now" style="top:${nowTop}px" aria-label="Now"></div>`:''}</div></div>`:''}</div>`;
    const sc=$('#dl-scroll');if(sc&&nowTop!=null)sc.scrollTop=Math.max(0,nowTop-PX*1.5);
  }
  // ---- Priority Actions: every dated reference from mail, today + next 7 days, earliest first ----
  let mPrioRange=(()=>{try{const v=localStorage.getItem('daylight-prio-range');return ['week','payments','deadlines','travel'].includes(v)?v:'week'}catch{return 'week'}})();
  function collectPriorityActions(range){
    const r=range||mPrioRange||'week';
    const d0=dayStartMs(),to=d0+8*86400000;
    const all=[...mailMoneyItems(d0,to),...mailKeyItems(d0-2*86400000,to)];
    // a bill's due date found by both the ledger and the date reader is one item
    const payMail=new Set(all.filter(x=>x.kind==='pay'&&x.mailId).map(x=>x.mailId));
    let items=all.filter(x=>!(x.kind==='deadline'&&x.mailId&&payMail.has(x.mailId)));
    items=items.map(x=>({...x,overdue:x.overdue||x.whenMs<(x.hasTime?Date.now():d0)}));
    if(r==='payments')items=items.filter(x=>x.kind==='pay'||x.kind==='renewal');
    else if(r==='deadlines')items=items.filter(x=>x.kind==='deadline'||x.kind==='reminder'||x.kind==='event');
    else if(r==='travel')items=items.filter(x=>x.kind==='travel');
    // loop-sheet compatible shape (type + subject + sender) so a tap opens the email with "Open in Gmail"
    return items.map(x=>({...x,type:x.kind==='travel'?'travel':x.kind==='renewal'?'renewal':'deadline',subject:x.subject||x.title,detail:x.quote||x.subject||'',meta:x.from||'',fromName:x.from||'',category:HOME_KIND[x.kind]||''}))
      .sort((a,b)=>a.whenMs-b.whenMs||String(a.title).localeCompare(String(b.title)));
  }
  function collectPriorityActionsToday(){return collectPriorityActions(mPrioRange)}
  function findPriorityItem(id){for(const r of ['week']){const hit=collectPriorityActions(r).find(l=>l.id===id);if(hit)return hit}return null}
  function prioritySender(it){
    if(it.fromEmail)return {name:it.from||'',email:it.fromEmail};
    const m=it.mailId&&mailPool().find(x=>x.id===it.mailId);
    if(m){const f=parseFrom(header(m.payload?.headers||[],'From'));return {name:it.from||f.name||'',email:f.email||''}}
    return {name:it.from||'',email:''};
  }
  // Priority Actions use the same row as the Inbox: sender logo · title + detail · when / amount + tag
  function priorityCard(it){
    const dt=new Date(it.whenMs),day=`${dt.toLocaleDateString('en-GB',{weekday:'short'})}, ${dt.getDate()} ${dt.toLocaleDateString('en-GB',{month:'short'})}`;
    const when=it.overdue&&it.kind!=='travel'?'Overdue':it.hasTime?`${day}, ${hm(dt)}`:day;
    const snd=prioritySender(it);
    const name=(it.kind==='pay'||it.kind==='renewal')?it.title:(snd.name||it.title);
    const line2=(it.kind==='pay'||it.kind==='renewal')?(it.subject&&it.subject!==it.title?it.subject:snd.name):it.title;
    const line3=(it.kind==='pay'||it.kind==='renewal')?'':(it.quote&&it.quote!==it.title?it.quote:'');
    const logoItem={title:name,fromEmail:snd.email,from:snd.name,fromName:snd.name};
    const tagCls={pay:' is-urgent',deadline:' is-review',travel:' is-ticket',renewal:' is-sub',reminder:' is-bill',event:' is-bill'}[it.kind]||'';
    return `<button type="button" class="m-inbox-card pa-row${it.overdue?' is-urgent':''}" data-loop="${esc(it.id)}" data-open-loop="${esc(it.id)}">
        <span class="m-inbox-logo m-brand" style="--a1:${esc(brandColor(name))};--a2:${esc(brandColor(name))}" aria-hidden="true">${brandLogoHTML(logoItem,name.trim().slice(0,2).toUpperCase())}</span>
        <span class="m-inbox-copy"><span class="m-inbox-top"><b>${esc(name)}</b><time>${esc(when)}</time></span>
        <small>${esc(decodeEntities([line2,line3].filter(Boolean).join(' — '))||'Gmail')}</small></span>
        <span class="m-inbox-side">${it.amount?`<span class="m-inbox-amt">${esc(it.amount)}</span>`:''}<span class="m-pill-tag${tagCls}">${esc(HOME_KIND[it.kind]||'')}</span></span>
      </button>`;
  }
  function priorityGroupsHTML(items,limit){
    let out='',last='',n=0;
    for(const it of items){
      if(limit&&n>=limit)break;
      out+=priorityCard(it);n++;
    }
    return out;
  }
  document.addEventListener('click',e=>{
    const b=e.target.closest?.('#m-prio-tabs [data-prio]');if(!b)return;
    mPrioRange=b.dataset.prio||'week';try{localStorage.setItem('daylight-prio-range',mPrioRange)}catch{}
    try{feel.select()}catch{}
    // keep the Priority section where it is: hold the list's height so a shorter list cannot pull the page up
    const grid=$('#m-loop-grid'),sc=Nav.scrollEl(),y=sc?.scrollTop||0;
    if(grid){const h=grid.offsetHeight;grid.style.minHeight=Math.max(h,parseFloat(grid.style.minHeight)||0)+'px'}
    renderHome();
    if(sc)sc.scrollTop=y;
  });
  function orderedHomeLoops(loops){
    // Prefer today Gmail priority list when available
    const today=collectPriorityActionsToday();
    if(today.length)return today;
    const priority=loops.filter(l=>l.weight>=2||['reply','overdue','deadline'].includes(l.type));
    const rest=loops.filter(l=>!priority.includes(l));
    return [...priority,...rest];
  }
  function scheduleTone(title){
    const t=String(title||'').toLowerCase();
    if(/\b(focus|deep work|heads.?down|writing|coding)\b/.test(t))return {tone:'green',icon:ICON.target};
    if(/\b(project|build|design|laptop|studio|work block)\b/.test(t))return {tone:'purple',icon:ICON.laptop};
    if(/\b(meet|call|sync|standup|1:?1|interview|research)\b/.test(t))return {tone:'blue',icon:ICON.calendar};
    return {tone:'blue',icon:ICON.calendar};
  }
  // Today's Schedule as one paragraph, same format as the Daily brief: label + coloured, linked event names
  function composeScheduleSentence(items,allDayItems,connected){
    if(!connected&&!DEMO)return esc('Connect Google Calendar to see today’s events here.');
    const now=new Date();
    if(!items.length&&!allDayItems.length)return esc('Nothing on the calendar for today — enjoy the open block.');
    const chip=(e,timeTxt)=>{
      const k=scheduleKind(e)==='t-travel'?'travel':'event',past=e.end&&e.end<=now,cur=e.start<=now&&e.end>now;
      return `<span role="button" tabindex="0" class="bchip k-${k}${past?' past':''}" data-sched-href="${esc(e.href||'')}" title="${esc([e.title,e.location].filter(Boolean).join(' · '))}">${esc(e.title)}${timeTxt?` <small>${esc(timeTxt)}</small>`:''}${cur?' <small>(now)</small>':''}</span>`;
    };
    const list=a=>a.length>1?a.slice(0,-1).join(', ')+' and '+a.at(-1):(a[0]||'');
    const s=[];
    const parts=[['Morning',0,12],['Afternoon',12,17],['Evening',17,24]];
    parts.forEach(([lbl,h0,h1])=>{
      const g=items.filter(e=>{const h=e.start.getHours();return h>=h0&&h<h1});
      if(g.length)s.push(`<span class="bs"><b class="lbl">${lbl}:</b> ${list(g.map(e=>chip(e,'at '+hm(e.start))))}.</span>`);
    });
    if(allDayItems.length){
      const ad=allDayItems.map(e=>({title:e.summary||e.title||'Event',href:e.htmlLink||e.href||'',start:new Date(0),end:new Date(8.64e15)}));
      s.push(`<span class="bs"><b class="lbl">All day:</b> ${list(ad.map(e=>chip(e,'').replace(' <small>(now)</small>','')))}.</span>`);
    }
    return s.join(' ');
  }
  function composeScheduleProse({timed,allDay,connected}){
    if(!connected&&!DEMO)return 'Connect Google Calendar to see today’s timeline here.';
    const now=new Date();
    const items=(timed||[]).filter(e=>e&&e.start&&isHomeToday(e.start));
    const days=(allDay||[]).filter(Boolean);
    if(!items.length&&!days.length)return 'Nothing on the calendar for today — enjoy the open block.';
    const sentences=[];
    const n=items.length,first=items[0],last=items[n-1];
    if(n===1)sentences.push(`One event today: ${first.title} at ${hm(first.start)}.`);
    else if(n)sentences.push(`You have ${n} events today, starting with ${first.title} at ${hm(first.start)}.`);
    const current=items.find(e=>e.start<=now&&e.end>now);
    const next=items.find(e=>e.start>now);
    if(current&&next)sentences.push(`You’re in ${current.title} until ${hm(current.end)}. Next is ${next.title} at ${hm(next.start)}.`);
    else if(current&&!next)sentences.push(`You’re in ${current.title} until ${hm(current.end)} — that’s the last event today.`);
    else if(next&&first&&next!==first)sentences.push(`Next up is ${next.title} at ${hm(next.start)}.`);
    else if(n>1&&last&&last!==first&&(!next||last.end<=now))sentences.push(`The day wraps up with ${last.title} at ${hm(last.start)}.`);
    const clashes=n>1?overlaps(items):[];
    if(clashes.length===1)sentences.push(`Watch the overlap between ${clashes[0][0].title} and ${clashes[0][1].title}.`);
    else if(clashes.length>1)sentences.push(`${spokenCount(clashes.length)} events overlap today.`);
    if(days.length===1)sentences.push(`All day: ${days[0]}.`);
    else if(days.length>1)sentences.push(`${days.length} all-day items, including ${days[0]}.`);
    return sentences.filter(Boolean).slice(0,3).join(' ');
  }
  let briefTab='todo';
  function briefMiniRow(item){
    const time=item.whenMs?hm(new Date(item.whenMs)):(item.meta||'');
    const kind=item.kind||'action';
    return `<button type="button" class="m-brief-row" data-brief-kind="${esc(kind)}" data-brief-id="${esc(item.id||'')}" ${item.href?`data-brief-href="${esc(item.href)}"`:''} ${item.mailId?`data-brief-mail="${esc(item.mailId)}"`:''} ${item.walletId?`data-brief-wallet="${esc(item.walletId)}"`:''}>
      <span class="m-brief-row-copy"><b>${esc(item.title)}</b><small>${esc(item.meta||time||'')}</small></span>
      <span class="m-brief-row-time">${esc(item.amount||time)}</span>
    </button>`;
  }
  function renderHome(){
    const p=readProfile(),first=(p.name||'').split(' ')[0],h=new Date().getHours(),part=h<12?'Good morning':h<18?'Good afternoon':'Good evening';
    $('#m-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
    $('#m-hello').innerHTML=first
      ?`${esc(part)}, <span class="m-hello-name">${esc(first)}</span>`
      :esc(part);
    renderBriefV3();
    const stats=$('#m-home-stats');
    if(stats)stats.hidden=true;
    renderHomeSchedule();
    const grid=$('#m-loop-grid'),total=$('#m-loop-total'),see=$('#m-loops-see');
    if(!grid)return;
    const ordered=collectPriorityActionsToday();
    if(total){total.textContent=ordered.length||'';total.hidden=!ordered.length}
    if(!token&&!microsoftAccount&&!DEMO&&!ordered.length){grid.innerHTML='<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Your day is quiet</b><p>Connect Google to surface today’s important mail.</p></div>';if(see)see.hidden=true;renderHomeHealth();return}
    if(!loopsData&&token){grid.innerHTML=skelRows(4);if(see)see.hidden=true;renderHomeHealth();return}
    $$('#m-prio-tabs [data-prio]').forEach(x=>{const on=x.dataset.prio===mPrioRange;x.classList.toggle('on',on);x.setAttribute('aria-selected',on?'true':'false')});
    const emptyMsg={week:'Nothing from your mail is due in the next 7 days.',payments:'No bills or renewals due in the next 7 days.',deadlines:'No deadlines or reminders in your mail for the next 7 days.',travel:'No trips in your mail for the next 7 days.'}[mPrioRange]||'Nothing needs you right now.';
    ensureHomeV3Styles();
    grid.innerHTML=ordered.length?priorityGroupsHTML(ordered,8):`<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>You’re clear</b><p>${esc(emptyMsg)}</p></div>`;
    if(see){
      see.hidden=ordered.length<=8;
      see.innerHTML=`See All ${svg(ICON.chevron,14)}`;
    }
    renderHomeHealth();
  }
  async function renderHomeHealth(){
    const strip=$('#m-health-strip');if(!strip)return;
    try{
      const h=await loadHealthSummary(false);
      const series=h?.series||[];
      const todayKey=window.DaylightData?.localDayKey?.(localMidnight)||localMidnight.toISOString().slice(0,10);
      const today=series.find(d=>d.date===todayKey)||series[series.length-1]||null;
      if(!today&&!h?.connected){
        strip.innerHTML=`<div class="m-health-empty">Connect Health or Google Fit to see today’s steps, calories and sleep.</div>`;
        return;
      }
      const steps=today?.steps??h?.stepsAvg??0;
      const cal=today?.calories??h?.caloriesAvg??0;
      const sleep=today?.sleepMin??h?.sleepAvgMin??0;
      const score=Math.max(0,Math.min(100,+(h?.score||0)));
      const delta=h?.scoreDelta||0;
      strip.innerHTML=`<button type="button" class="m-health-card" aria-label="Open today’s health">
        <div class="m-health-top">
          <div class="hx-ring" style="--p:${esc(String(score))}"><span>${svg(ICON.heart,22)}</span></div>
          <div class="m-health-copy">
            <small>Health score</small>
            <b>${esc(String(h?.score??'—'))}/100</b>
            <span class="hx-delta${delta<0?' is-down':''}">${delta>=0?'+':''}${esc(String(delta))} vs last week</span>
          </div>
        </div>
        <div class="m-health-metrics">
          <span class="m-health-m is-steps"><span class="m-health-m-ico">${svg(ICON.shoe,14)}</span><b>${esc(fmtSteps(steps))}</b><span>Steps</span></span>
          <span class="m-health-m is-cal"><span class="m-health-m-ico">${svg(ICON.flame,14)}</span><b>${esc(fmtSteps(cal))}</b><span>kcal</span></span>
          <span class="m-health-m is-sleep"><span class="m-health-m-ico">${svg(ICON.bed,14)}</span><b>${esc(fmtSleep(sleep))}</b><span>Sleep</span></span>
        </div>
      </button>`;
    }catch{
      strip.innerHTML=`<div class="m-health-empty">Health data unavailable right now.</div>`;
    }
  }
  function ensureLoopsPop(){
    let el=$('#loops-pop');
    if(el)return el;
    el=document.createElement('div');
    el.id='loops-pop';el.className='brief-pop loops-pop';el.setAttribute('aria-hidden','true');
    el.innerHTML=`<button type="button" class="brief-pop-scrim" data-loops-close aria-label="Close priority actions"></button>
      <div class="brief-pop-card" role="dialog" aria-modal="true" aria-labelledby="loops-pop-title">
        <div class="brief-pop-head">
          <div><b id="loops-pop-title">Priority Actions</b><small id="loops-pop-sub">All open loops</small></div>
          <button type="button" class="brief-pop-x" data-loops-close aria-label="Close">×</button>
        </div>
        <div class="brief-pop-body" id="loops-pop-body"></div>
      </div>`;
    document.body.append(el);
    el.addEventListener('click',e=>{
      if(e.target.closest('[data-loops-close]')){closeLoopsPop();return}
      const row=e.target.closest('[data-open-loop],[data-loop]');if(!row)return;
      const id=row.dataset.openLoop||row.dataset.loop;if(!id)return;
      feel.select();closeLoopsPop();openLoopSheet(id);
    });
    return el;
  }
  function openLoopsPop(){
    feel.select();
    const ordered=collectPriorityActionsToday();
    const el=ensureLoopsPop();
    const body=$('#loops-pop-body'),sub=$('#loops-pop-sub');
    if(sub)sub.textContent=ordered.length?`${ordered.length} from your mail · today and the next 7 days`:'Nothing due in the next 7 days';
    ensureHomeV3Styles();
    if(body)body.innerHTML=ordered.length
      ?`<div class="m-loop-list loops-pop-list">${priorityGroupsHTML(ordered)}</div>`
      :`<div class="brief-empty">Nothing needs you right now.</div>`;
    el.classList.add('show');el.setAttribute('aria-hidden','false');
    document.body.classList.add('loops-open');
    if(Nav.topView()!=='loops')Nav.push('loops');
  }
  function closeLoopsPop(instant){
    const el=$('#loops-pop');if(!el||!el.classList.contains('show')){if(instant)Nav.drop('loops');return}
    el.classList.remove('show');el.setAttribute('aria-hidden','true');
    document.body.classList.remove('loops-open');
    if(instant){Nav.drop('loops');return}
    if(Nav.topView()==='loops'||Nav.stack.some(x=>x.view==='loops')){Nav.back();return}
    Nav.drop('loops');
  }
  {
    const _d=Nav.dismissView.bind(Nav);
    Nav.dismissView=function(view){if(view==='loops'){closeLoopsPop(true);return}_d(view)};
    const _i=Nav.dismissInstant.bind(Nav);
    Nav.dismissInstant=function(view){if(view==='loops'){closeLoopsPop(true);return}_i(view)};
    const _o=Nav.isOpen.bind(Nav);
    Nav.isOpen=function(view){return view==='loops'?!!$('#loops-pop')?.classList.contains('show'):_o(view)};
    const _a=Nav.anyOpen.bind(Nav);
    Nav.anyOpen=function(){return Nav.isOpen('loops')||_a()};
    const _t=Nav.dismissTop.bind(Nav);
    Nav.dismissTop=function(){if(Nav.isOpen('loops')){Nav.dismissView('loops');return}_t()};
  }
  $('#m-home-stats')?.addEventListener('click',e=>{
    const b=e.target.closest('[data-home-jump]');if(!b)return;feel.select();
    const j=b.dataset.homeJump;
    if(j==='payments'){setTab('inbox');mInboxFilter='payments';setLS('daylight-inbox-filter','payments');renderInbox({animate:false});return}
    if(j==='events'){setTab('assistant');return}
    if(j==='todo'||j==='waiting'){openLoopsPop();return}
  });
  document.addEventListener('click',e=>{const c=e.target.closest?.('#m-schedule-prose [data-sched-href]');if(!c)return;const h=c.dataset.schedHref;feel.select();if(h)window.open(h,'_blank','noopener');else setTab('assistant')});
  document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest?.('#m-schedule-prose .bchip')){e.preventDefault();e.target.click()}});
  $('#m-brief')?.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest?.('.bchip')){e.preventDefault();e.target.click()}});
  $('#m-brief')?.addEventListener('click',e=>{
    const row=e.target.closest('[data-brief-kind]');if(!row)return;
    const kind=row.dataset.briefKind,id=row.dataset.briefId,href=row.dataset.briefHref,mail=row.dataset.briefMail;
    feel.select();
    if(kind==='more'){openBriefPop();return}
    if(row.dataset.briefLoop){openLoopSheet(row.dataset.briefLoop);return}
    if(kind==='pay'&&row.dataset.briefFin&&window.DaylightMoneyUI){window.DaylightMoneyUI.open(row.dataset.briefFin);return}
    if(id&&/^(mail-date|pay|renew):/.test(id)){const it=findPriorityItem(id);if(it){openLoopSheet(it);return}}
    if(mail){const loops=computeLoops();const hit=loops.find(l=>l.mailId===mail);if(hit){openLoopSheet(hit.id);return}}
    if(kind==='action'&&id){openLoopSheet(id);return}
    if(href){window.open(href,'_blank','noopener');return}
    if(kind==='task'||kind==='travel'){setTab('assistant');return}
  });
  $('#m-loop-grid')?.addEventListener('click',onLoopListClick);
  $('#m-loop-grid')?.addEventListener('keydown',onLoopListKey);
  $('#m-loops-see')?.addEventListener('click',()=>openLoopsPop());
  $('#m-health-see')?.addEventListener('click',()=>{feel.select();setTab('stats')});
  $('#m-health-strip')?.addEventListener('click',()=>{feel.select();setTab('stats')});
  function collectDailyBrief(){
    const b=collectBriefToday();
    const todo=[...b.tasks,...b.replies].map(x=>({...x,kind:x.kind==='pay'?'pay':x.kind==='travel'?'cal':'task',meta:[HOME_KIND[x.kind],x.source,chipTime(x)].filter(Boolean).join(' · ')}));
    const payments=b.pays.map(x=>({...x,kind:'pay',meta:[x.amount,x.overdue?'Overdue':'Due today',x.source].filter(Boolean).join(' · ')}));
    const events=[...b.travel.map(x=>({...x,kind:'cal',meta:['Travel',chipTime(x)].filter(Boolean).join(' · ')})),...b.events.map(e=>({kind:'cal',id:'ev:'+(e.id||e.start.getTime()),title:e.title,whenMs:e.start.getTime(),meta:`${hm(e.start)} – ${hm(e.end)}`,href:e.href||''}))];
    const counts={todo:todo.length,waiting:0,payments:payments.length,events:events.length};
    return {todo,waiting:[],payments,events,actions:todo,reminders:todo,summary:`Today · ${todo.length} to do · ${payments.length} to pay · ${events.length} on the calendar`,connected:b.connected,calConnected:true,counts};
  }

  function briefRowHtml(item){
    const ico=item.kind==='pay'?ICON.wallet:item.kind==='cal'?ICON.calendar:item.kind==='task'?ICON.clock:ICON.spark;
    const cls=item.kind==='pay'?' is-pay':item.kind==='cal'?' is-cal':item.kind==='task'?' is-task':'';
    return `<button type="button" class="brief-row${cls}" data-brief-kind="${esc(item.kind)}" data-brief-id="${esc(item.id||'')}" ${item.href?`data-brief-href="${esc(item.href)}"`:''} ${item.mailId?`data-brief-mail="${esc(item.mailId)}"`:''}>
      <span class="brief-row-ico" aria-hidden="true">${svg(ico,18)}</span>
      <span class="brief-row-copy"><b>${esc(item.title)}</b><small>${esc(item.meta||'')}</small></span>
      <span class="brief-row-meta">${esc(item.amount||item.type||'')}</span>
    </button>`;
  }
  function briefSec(title,items,empty){
    if(!items.length)return `<section class="brief-sec"><div class="brief-sec-h">${esc(title)}</div><div class="brief-empty">${esc(empty)}</div></section>`;
    return `<section class="brief-sec"><div class="brief-sec-h">${esc(title)} <em>${items.length}</em></div><div class="brief-list">${items.map(briefRowHtml).join('')}</div></section>`;
  }
  function ensureBriefPop(){
    let el=$('#brief-pop');
    if(el)return el;
    el=document.createElement('div');
    el.id='brief-pop';el.className='brief-pop';el.setAttribute('aria-hidden','true');
    el.innerHTML=`<button type="button" class="brief-pop-scrim" data-brief-close aria-label="Close daily brief"></button>
      <div class="brief-pop-card" role="dialog" aria-modal="true" aria-labelledby="brief-pop-title">
        <div class="brief-pop-head">
          <div><b id="brief-pop-title">Daily Brief</b><small id="brief-pop-sub">From Calendar, Gmail and Tasks</small></div>
          <button type="button" class="brief-pop-x" data-brief-close aria-label="Close">×</button>
        </div>
        <div class="brief-pop-body" id="brief-pop-body"><div class="brief-loading">Gathering your day…</div></div>
      </div>`;
    document.body.append(el);
    el.addEventListener('click',e=>{
      if(e.target.closest('[data-brief-close]')){closeBriefPop();return}
      const tabBtn=e.target.closest('[data-brief-tab]');
      if(tabBtn){briefTab=tabBtn.dataset.briefTab||'todo';feel.select();paintBriefPop(collectDailyBrief());return}
      const row=e.target.closest('[data-brief-kind]');if(!row)return;
      const kind=row.dataset.briefKind,id=row.dataset.briefId,href=row.dataset.briefHref;
      feel.select();
      if(kind==='action'&&id){closeBriefPop();openLoopSheet(id);return}
      if(kind==='pay'){
        closeBriefPop();
        if(row.dataset.briefMail){const loops=computeLoops();const hit=loops.find(l=>l.mailId===row.dataset.briefMail);if(hit){openLoopSheet(hit.id);return}}
        setTab('inbox');mInboxFilter='payments';setLS('daylight-inbox-filter','payments');renderInbox({animate:false});return;
      }
      if(kind==='cal'){
        closeBriefPop();
        if(row.dataset.briefId?.startsWith('travel:')){
          const wid=row.dataset.briefId.slice(7);
          openTravelRecord({walletId:wid});return;
        }
        setTab('assistant');return;
      }
      if(kind==='task'&&row.dataset.briefMail){closeBriefPop();const loops=computeLoops();const hit=loops.find(l=>l.mailId===row.dataset.briefMail);if(hit)openLoopSheet(hit.id);else setTab('inbox');return}
      if(href){window.open(href,'_blank','noopener');return}
    });
    return el;
  }
  function paintBriefPop(data){
    const body=$('#brief-pop-body'),sub=$('#brief-pop-sub');
    if(sub)sub.textContent=new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
    if(!body)return;
    const tab=briefTab||'todo';
    const counts=data.counts||{todo:data.todo?.length||0,waiting:data.waiting?.length||0,payments:data.payments?.length||0,events:data.events?.length||0};
    const list=tab==='waiting'?data.waiting:tab==='payments'?data.payments:tab==='events'?data.events:data.todo;
    const empty=tab==='waiting'?'Nothing you’re waiting on from mail today.'
      :tab==='payments'?'No payments due for today.'
      :tab==='events'?(data.calConnected?'No calendar or travel events today.':'Connect Calendar to see today’s events.')
      :'No tasks or replies for today.';
    const title=tab==='waiting'?'Waiting':tab==='payments'?'Payments':tab==='events'?'Events':'To Do';
    body.innerHTML=`
      <p class="brief-summary">${esc(data.summary)}</p>
      <div class="brief-tabs" role="tablist" aria-label="Today’s brief">
        <button type="button" class="brief-tab${tab==='todo'?' on':''}" data-brief-tab="todo" role="tab" aria-selected="${tab==='todo'}">To Do<em>${counts.todo||0}</em></button>
        <button type="button" class="brief-tab${tab==='waiting'?' on':''}" data-brief-tab="waiting" role="tab" aria-selected="${tab==='waiting'}">Waiting<em>${counts.waiting||0}</em></button>
        <button type="button" class="brief-tab${tab==='payments'?' on':''}" data-brief-tab="payments" role="tab" aria-selected="${tab==='payments'}">Payments<em>${counts.payments||0}</em></button>
        <button type="button" class="brief-tab${tab==='events'?' on':''}" data-brief-tab="events" role="tab" aria-selected="${tab==='events'}">Events<em>${counts.events||0}</em></button>
      </div>
      ${briefSec(title,list||[],empty)}`;
  }
  async function openBriefPop(){
    feel.select();
    const el=ensureBriefPop();
    el.classList.add('show');el.setAttribute('aria-hidden','false');
    document.body.classList.add('brief-open');
    if(Nav.topView()!=='brief')Nav.push('brief');
    const body=$('#brief-pop-body');
    if(body)body.innerHTML='<div class="brief-loading">Gathering Calendar, Gmail and Tasks…</div>';
    try{
      if(token){
        const jobs=[];
        if(!loopsData||Date.now()-loopsFetched>60000)jobs.push(loadLoops(true).catch(e=>console.warn('brief loops',e)));
        if(!providerData.google.events)jobs.push(loadCalendar().catch(e=>console.warn('brief cal',e)));
        if(!providerData.google.tasks)jobs.push(loadTasks().catch(e=>console.warn('brief tasks',e)));
        if(jobs.length)await Promise.allSettled(jobs);
      }
    }catch(e){console.warn('brief refresh',e)}
    if(!el.classList.contains('show'))return;
    paintBriefPop(collectDailyBrief());
  }
  function closeBriefPop(instant){
    const el=$('#brief-pop');if(!el||!el.classList.contains('show')){if(instant)Nav.drop('brief');return}
    el.classList.remove('show');el.setAttribute('aria-hidden','true');
    document.body.classList.remove('brief-open');
    if(instant){Nav.drop('brief');return}
    if(Nav.topView()==='brief'||Nav.stack.some(x=>x.view==='brief')){Nav.back();return}
    Nav.drop('brief');
  }
  const _navDismiss=Nav.dismissView.bind(Nav);
  Nav.dismissView=function(view){
    if(view==='health'){dismissHealthDetail(false);return}
    if(view==='notif'){closeNotifPanel();return}
    if(view==='brief'){closeBriefPop(true);return}
    _navDismiss(view);
  };
  const _navInstant=Nav.dismissInstant.bind(Nav);
  Nav.dismissInstant=function(view){
    if(view==='health'){dismissHealthDetail(true);return}
    if(view==='notif'){closeNotifPanel(true);return}
    if(view==='brief'){closeBriefPop(true);return}
    _navInstant(view);
  };
  const _navIsOpen=Nav.isOpen.bind(Nav);
  Nav.isOpen=function(view){
    if(view==='health')return !!$('#hx-detail')?.classList.contains('show');
    if(view==='notif')return isNotifOpen();
    if(view==='brief')return !!$('#brief-pop')?.classList.contains('show');
    return _navIsOpen(view);
  };
  const _navAny=Nav.anyOpen.bind(Nav);
  Nav.anyOpen=function(){return Nav.isOpen('health')||Nav.isOpen('notif')||Nav.isOpen('brief')||_navAny()};
  const _navDismissTop=Nav.dismissTop.bind(Nav);
  Nav.dismissTop=function(){
    if(Nav.isOpen('health')){Nav.dismissView('health');return}
    if(Nav.isOpen('notif')){Nav.dismissView('notif');return}
    if(Nav.isOpen('brief')){Nav.dismissView('brief');return}
    _navDismissTop();
  };
  const _navSheet=Nav.sheetEl.bind(Nav);
  Nav.sheetEl=function(view){
    if(view==='health')return $('#hx-detail');
    if(view==='notif')return $('#notif-panel')?.querySelector('.notif-sheet')||$('#notif-panel');
    if(view==='brief')return $('#brief-pop')?.querySelector('.brief-pop-card')||$('#brief-pop');
    return _navSheet(view);
  };
  $('#m-schedule-cal')?.addEventListener('click',()=>{feel.select();setTab('assistant')});
  // Drag the notification sheet right to dismiss (slide over)
  (function bindNotifSlide(){
    let s=null;
    const panel=()=>$('#notif-panel');
    const sheet=()=>panel()?.querySelector('.notif-sheet');
    const thresh=()=>Math.min(88,innerWidth*.22);
    const clear=(el,animate)=>{
      if(!el)return;
      if(animate&&!Nav.reduced()){
        el.style.transition='transform .2s cubic-bezier(.22,.9,.28,1), opacity .16s ease';
        el.style.transform='';el.style.opacity='';
        const root=panel();if(root){root.style.transition='opacity .16s ease';root.style.opacity=''}
        setTimeout(()=>{el.style.transition='';if(root)root.style.transition=''},220);
      }else{
        el.style.transition='';el.style.transform='';el.style.opacity='';
        const root=panel();if(root){root.style.transition='';root.style.opacity=''}
      }
    };
    document.addEventListener('touchstart',e=>{
      if(!isNotifOpen()||notifClosing||Nav.backing)return;
      const t=e.touches[0];if(!t)return;
      const el=sheet();if(!el||!el.contains(e.target))return;
      if(e.target.closest('#notif-close,.notif-scrim'))return;
      s={x0:t.clientX,y0:t.clientY,active:false,el,list:$('#notif-list')};
    },{passive:true});
    document.addEventListener('touchmove',e=>{
      if(!s||Nav.backing)return;
      const t=e.touches[0];if(!t)return;
      const dx=t.clientX-s.x0,dy=Math.abs(t.clientY-s.y0);
      if(!s.active){
        if(dy>12&&dy>=Math.abs(dx)){s=null;return}
        if(dx<10)return;
        s.active=true;
        if(s.list)s.list.style.overflow='hidden';
      }
      if(e.cancelable)e.preventDefault();
      if(Nav.reduced())return;
      const p=Math.min(innerWidth,Math.max(0,dx));
      const o=Math.max(.35,1-p/(innerWidth*.7));
      s.el.style.transition='none';
      s.el.style.transform=`translate3d(${p}px,0,0)`;
      s.el.style.opacity=String(o);
      const root=panel();
      if(root){root.style.transition='none';root.style.opacity=String(Math.max(.2,1-p/(innerWidth*.85)))}
      s.p=p;
    },{passive:false});
    const end=()=>{
      if(!s)return;
      const {el,active,p,list}=s;s=null;
      if(list)list.style.overflow='';
      if(active&&(p||0)>thresh()){feel.tap();Nav.commitGesture('notif',el);return}
      clear(el,active);
    };
    document.addEventListener('touchend',end,{passive:true});
    document.addEventListener('touchcancel',end,{passive:true});
  })();
  // Inbox — driven by stored classification + DaylightData bucket mapping (no second engine)
  function inboxUniverse(){
    const money=computeMoney();
    const Data=window.DaylightData;
    const raw=[...(money.all||[])];
    // Recover AI shopping orders into receipts/payments surface without duplicating mail ids
    try{
      const seen=new Set(raw.map(i=>i.mailId||i.id));
      (Data?.orders?.()||[]).forEach(o=>{
        const mid=o.mailId||o.id;
        if(!mid||seen.has(mid))return;seen.add(mid);
        raw.push({
          id:o.id,mailId:o.mailId,title:o.merchant||'Order',subject:o.summary||o.orderId||'Order update',
          detail:o.status||'',kind:'shopping',category:'shopping',tag:'Order',amount:'',
          when:o.sortAt||Date.now(),whenMs:o.sortAt||Date.now(),href:o.href||(o.mailId?gmailLink(o.mailId):''),
          snippet:o.status||'',color:'#3d8b6e',intent:o.status,sourceMailIds:o.sourceMailIds
        });
      });
    }catch{}
    return raw.map(i=>{
      const ex=Data?.extractionForMail?.(i.mailId||i.id);
      const labels=i.labelIds||[];
      const enriched={...i,intent:ex?.intent||i.intent,category:ex?.inboxCategory||ex?.category||i.category||i.kind,labelIds:labels};
      const bucket=Data?.inboxBucket?.(enriched)||'important';
      return {...enriched,inboxBucket:bucket};
    });
  }
  function inboxItems(filter){
    const f=filter||mInboxFilter||'all';
    let list=inboxUniverse();
    // Default "All" / Important exclude promotions; Promotions tab is opt-in
    if(f==='all'||f==='important')list=list.filter(i=>i.inboxBucket!=='promotions');
    if(f==='subscriptions')list=list.filter(i=>i.inboxBucket==='subscriptions');
    else if(f==='payments')list=list.filter(i=>i.inboxBucket==='payments');
    else if(f==='receipts')list=list.filter(i=>i.inboxBucket==='receipts');
    else if(f==='bills')list=list.filter(i=>i.inboxBucket==='bills');
    else if(f==='tickets')list=list.filter(i=>i.inboxBucket==='tickets');
    else if(f==='important')list=list.filter(i=>i.inboxBucket==='important');
    else if(f==='promotions')list=list.filter(i=>i.inboxBucket==='promotions');
    // legacy aliases
    else if(f==='subscription')list=list.filter(i=>i.inboxBucket==='subscriptions');
    else if(f==='bill')list=list.filter(i=>i.inboxBucket==='bills');
    else if(f==='ticket')list=list.filter(i=>i.inboxBucket==='tickets');
    else if(f==='shopping')list=list.filter(i=>i.inboxBucket==='receipts');
    else if(f==='other')list=list.filter(i=>i.inboxBucket==='important');
    const st=loopState(),now=Date.now();
    return list.filter(i=>{const s=st['inbox:'+i.id];return !(s&&(s.done||(s.snooze&&s.snooze>now)))});
  }
  function inboxDateLabel(item){
    if(item.meta&&/^(Soon|Today|Tomorrow)$/i.test(item.meta))return item.meta;
    if(!item.received&&item.when){
      const d=new Date(item.when);
      if(!Number.isNaN(d.getTime())&&Math.abs(d-localMidnight)<400*86400000)
        return d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:d.getFullYear()!==localMidnight.getFullYear()?'numeric':undefined});
    }
    return item.meta||'';
  }
  function inboxDaysLabel(item){
    if(item.kind==='pending')return item.urgent?'Due soon':'Pending';
    if(item.received||!item.when)return item.kind==='store'?'Store':item.kind==='online'?'Paid':item.tag||'';
    const days=Math.round((item.when-localMidnight.getTime())/86400000);
    if(days<0)return 'Overdue';
    if(days===0)return 'Today';
    if(days===1)return '1 day';
    return `${days} days`;
  }
  function inboxAgo(item){
    if(item.whenMs||item.when){try{return ago(new Date(item.whenMs||item.when))}catch{}}
    return inboxDateLabel(item)||'';
  }
  function decodeEntities(t){t=String(t||'');if(!/&(#\d+|#x[\da-f]+|[a-z]+);/i.test(t))return t;const ta=decodeEntities.el||(decodeEntities.el=document.createElement('textarea'));ta.innerHTML=t;return ta.value}
  function inboxCard(item){
    const initial=(item.title||'?').trim().slice(0,2).toUpperCase();
    const tag=item.fin?item.tag:item.needsReview?'Needs review':item.kind==='pending'||item.urgent?inboxDaysLabel(item):(item.tag||MONEY_LABEL[item.kind]||inboxDaysLabel(item)||'');
    const tagCls=item.fin?({outstanding:' is-urgent',review:' is-review',upcoming:' is-bill'}[item.fin.bucket]||(item.kind==='subscription'?' is-sub':'')):item.needsReview?' is-review':item.urgent?' is-urgent':item.kind==='pending'?' is-review':item.kind==='subscription'?' is-sub':item.kind==='bill'?' is-bill':item.kind==='ticket'?' is-ticket':item.kind==='shopping'?' is-shop':'';
    const snip=decodeEntities(item.snippet||item.subject||item.detail||'').replace(/\s+/g,' ').trim().slice(0,72);
    const amt=item.amount?`<span class="m-inbox-amt">${esc(item.amount)}</span>`:'';
    return `<div class="m-swipe" data-swipe-id="${esc(item.id)}">
      <div class="m-swipe-actions" aria-hidden="true">
        <button type="button" class="m-sw m-sw-snooze" data-sw="snooze" data-id="${esc(item.id)}">Snooze</button>
        <button type="button" class="m-sw m-sw-task" data-sw="task" data-id="${esc(item.id)}">Task</button>
        <button type="button" class="m-sw m-sw-arch" data-sw="archive" data-id="${esc(item.id)}">Done</button>
      </div>
      <button type="button" class="m-inbox-card${item.urgent||item.kind==='pending'?' is-urgent':''}${item.needsReview?' is-review':''}" data-inbox-open="${esc(item.id)}">
        <span class="m-inbox-logo m-brand" style="--a1:${esc(item.color)};--a2:${esc(item.color)}" aria-hidden="true">${brandLogoHTML(item,initial)}</span>
        <span class="m-inbox-copy"><span class="m-inbox-top"><b>${esc(item.title)}</b><time>${esc(inboxAgo(item))}</time></span>
        <small>${esc(snip||inboxDateLabel(item)||'Open for details')}</small></span>
        <span class="m-inbox-side">${amt}${tag?`<span class="m-pill-tag${tagCls}">${esc(tag)}</span>`:''}</span>
      </button>
    </div>`;
  }
  const INBOX_ORDER=['all','subscriptions','payments','receipts','bills','tickets','important','promotions'];
  let inboxAnim=null;
  function syncInboxThumb(animate=true){
    const tabs=$('#m-inbox-tabs'),thumb=$('#m-inbox-thumb'),on=tabs?.querySelector('[data-inbox].on');
    if(!tabs||!thumb||thumb.hidden||!on)return;
    if(!animate){thumb.style.transition='none'}
    thumb.style.width=on.offsetWidth+'px';
    thumb.style.transform=`translateX(${on.offsetLeft}px)`;
    if(!animate){void thumb.offsetWidth;thumb.style.transition=''}
  }
  function paintInbox(el){
    if(!token&&!microsoftAccount&&!DEMO){el.innerHTML='<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Connect to fill Inbox</b><p>Classified mail appears in Subscriptions, Payments, Receipts, Bills, Tickets and Important. Promotions stay in a separate tab.</p></div>';return}
    if(!loopsData&&token){el.innerHTML=skelRows(5);return}
    const items=inboxItems(mInboxFilter);
    if(!items.length){el.innerHTML=`<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Inbox is clear</b><p>${mInboxFilter==='all'?'Nothing needs attention right now.':mInboxFilter==='promotions'?'No promotions here. Daylight checks Promotions for receipts, bookings and tickets and only keeps the ones that matter.':'Nothing in this category.'}</p></div>`;return}
    const needs=items.filter(i=>i.needsReview||i.kind==='pending'||i.urgent||(i.kind==='bill'&&!i.received)||i.status==='failed'||i.status==='unpaid');
    const needsIds=new Set(needs.map(i=>i.id));
    const week=items.filter(i=>!needsIds.has(i.id)&&!i.received&&i.when&&(i.when-localMidnight.getTime())<=14*86400000);
    const weekIds=new Set(week.map(i=>i.id));
    const recent=items.filter(i=>!needsIds.has(i.id)&&!weekIds.has(i.id));
    const recentLabel=mInboxFilter==='payments'?'Recent payments':mInboxFilter==='shopping'?'Recent orders':mInboxFilter==='ticket'?'Recent tickets':'Recent';
    const block=(title,list)=>list.length?`<div class="m-inbox-sec"><h3 class="m-inbox-sec-h">${title}</h3><div class="m-inbox-list">${list.map(inboxCard).join('')}</div></div>`:'';
    el.innerHTML=block('Needs Attention',needs)+block('This Week',week)+block(recentLabel,recent);
  }
  function renderInbox(opts={}){
    const el=$('#m-inbox');if(!el)return;
    const animate=opts.animate!==false,dir=opts.dir||0;
    $$('#m-inbox-tabs [data-inbox]').forEach(b=>{const on=b.dataset.inbox===mInboxFilter;b.classList.toggle('on',on);b.setAttribute('aria-selected',on?'true':'false')});
    requestAnimationFrame(()=>syncInboxThumb(animate&&!opts.instantThumb));
    if(!animate||!dir){el.className='';paintInbox(el);return}
    if(inboxAnim){clearTimeout(inboxAnim);inboxAnim=null}
    const leave=dir>0?'is-leave-left':'is-leave-right',enter=dir>0?'is-enter-left':'is-enter-right';
    el.classList.remove('is-leave','is-leave-left','is-leave-right','is-enter','is-enter-left','is-enter-right');
    el.classList.add('is-leave',leave);
    inboxAnim=setTimeout(()=>{
      paintInbox(el);
      el.classList.remove('is-leave',leave);
      el.classList.add('is-enter',enter);
      void el.offsetWidth;
      requestAnimationFrame(()=>{el.classList.remove('is-enter',enter);inboxAnim=null});
    },160);
  }
  $('#m-inbox-tabs')?.addEventListener('click',e=>{
    const b=e.target.closest('[data-inbox]');if(!b||b.dataset.inbox===mInboxFilter)return;
    const prev=INBOX_ORDER.indexOf(mInboxFilter),next=INBOX_ORDER.indexOf(b.dataset.inbox);
    mInboxFilter=b.dataset.inbox;setLS('daylight-inbox-filter',mInboxFilter);
    renderInbox({animate:true,dir:next>=prev?1:-1});
  });
  $('#m-inbox-filter')?.addEventListener('click',()=>toast('Sorted by soonest first',{type:'ok',ms:1600}));
  $('#m-inbox')?.addEventListener('click',e=>{
    const sw=e.target.closest('[data-sw]');
    if(sw){
      const id=sw.dataset.id,item=computeMoney().all.find(i=>i.id===id);if(!item)return;
      const key='inbox:'+id;
      if(sw.dataset.sw==='snooze'){const s=loopState();s[key]={snooze:Date.now()+86400000,t:Date.now()};saveLoopState(s);renderInbox({animate:false});toast('Snoozed until tomorrow',{type:'ok',haptic:'success'});return}
      if(sw.dataset.sw==='task'){capture(item.title+(item.amount?' · '+item.amount:''));toast('Saved as task',{type:'ok',haptic:'success'});return}
      if(sw.dataset.sw==='archive'){const s=loopState();s[key]={done:true,t:Date.now()};saveLoopState(s);renderInbox({animate:false});toast('Marked as done',{type:'ok',haptic:'success'});return}
    }
    const b=e.target.closest('[data-inbox-open]');if(!b)return;
    if(b.closest('.m-swipe.open')){b.closest('.m-swipe').classList.remove('open');return}
    const item=(typeof inboxUniverse==='function'?inboxUniverse():computeMoney().all).find(i=>i.id===b.dataset.inboxOpen)||computeMoney().all.find(i=>i.id===b.dataset.inboxOpen);
    if(!item)return;
    // Tickets: open email detail but ensure canonical wallet exists for linked navigation
    if(item.kind==='ticket'||item.inboxBucket==='tickets'||item.category==='ticket'){
      const Data=window.DaylightData;
      const travel=Data?.travelRecordForMail?.(item.mailId,{threadId:item.threadId,recordKey:item.recordKey});
      if(item.mailId&&!travel?.wallet){
        openTravelRecord({mailId:item.mailId,threadId:item.threadId,recordKey:item.recordKey,title:item.title,href:item.href,ensurePass:true,preferEmail:true,surface:'email'});
        return;
      }
      openLoopSheet({...inboxToDetail(item),walletId:travel?.walletId||null,recordKey:item.recordKey||travel?.recordKey||''});
      return;
    }
    openLoopSheet(inboxToDetail(item));
  });
  (function bindInboxSwipe(){
    let s=null;
    const host=$('#m-inbox');if(!host)return;
    host.addEventListener('touchstart',e=>{
      const row=e.target.closest('.m-swipe');if(!row)return;
      const t=e.touches[0];s={row,x0:t.clientX,y0:t.clientY,active:false,start:row.classList.contains('open')?-108:0};
    },{passive:true});
    host.addEventListener('touchmove',e=>{
      if(!s)return;
      const t=e.touches[0],dx=t.clientX-s.x0,dy=Math.abs(t.clientY-s.y0);
      if(!s.active){if(dy>12&&dy>Math.abs(dx)){s=null;return}if(Math.abs(dx)<8)return;s.active=true;s.row.classList.add('dragging');$$('#m-inbox .m-swipe.open').forEach(r=>{if(r!==s.row)r.classList.remove('open')})}
      if(e.cancelable)e.preventDefault();
      const x=Math.min(0,Math.max(-108,s.start+dx));
      s.row.style.transition='none';
      const card=s.row.querySelector('.m-inbox-card');if(card){card.style.transition='none';card.style.transform=`translate3d(${x}px,0,0)`}
      s.x=x;
    },{passive:false});
    const end=()=>{
      if(!s)return;
      const row=s.row,x=s.x||0,card=row.querySelector('.m-inbox-card');
      row.style.transition='';if(card){card.style.transition='transform .22s var(--ease-out,cubic-bezier(.22,.9,.28,1))';card.style.transform=''}
      row.classList.remove('dragging');
      if(x<-54){row.classList.add('open');feel.select()}else row.classList.remove('open');
      s=null;
    };
    host.addEventListener('touchend',end,{passive:true});
    host.addEventListener('touchcancel',end,{passive:true});
  })();
  addEventListener('resize',()=>{if(mq.matches&&mTab==='inbox')syncInboxThumb(false);if(mq.matches&&mTab==='wallet')syncWalletThumb(false)});
  // Wallet — Apple-style stacked passes + document scan
  const WALLET_ORDER=['all','tickets','coupons','documents','others'];
  function syncWalletThumb(animate=true){
    const tabs=$('#m-wallet-tabs'),thumb=$('#m-wallet-thumb'),on=tabs?.querySelector('[data-wallet].on');
    if(!tabs||!thumb||thumb.hidden||!on)return;
    if(!animate)thumb.style.transition='none';
    thumb.style.width=on.offsetWidth+'px';
    thumb.style.transform=`translateX(${on.offsetLeft}px)`;
    if(!animate){void thumb.offsetWidth;thumb.style.transition=''}
  }
  function walletItems(filter){
    const Data=window.DaylightData;
    if(Data?.walletItems){
      const map={all:'all',tickets:'tickets',coupons:'cards',documents:'documents',others:'cards',payments:'payments',cards:'cards'};
      return Data.walletItems({filter:map[filter]||filter||'all'}).map(w=>{
        // Prefer event date label on cards when known
        if(w.eventAt&&!w._labelWhen){try{w._labelWhen=new Date(w.eventAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}catch{}}
        return w;
      });
    }
    const all=readWallet().slice().sort((a,b)=>{
      const ae=a.travelAt||a.eventAt,be=b.travelAt||b.eventAt;
      if(ae&&be)return new Date(ae)-new Date(be);
      if(ae&&!be)return -1;if(!ae&&be)return 1;
      return new Date(b.at)-new Date(a.at);
    });
    return filter==='all'?all:all.filter(i=>i.kind===filter);
  }
  const WALLET_ICO={tickets:ICON.calendar,coupons:'<path d="M4 9a2.5 2.5 0 0 0 0 5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3a2.5 2.5 0 0 0 0-5V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Z"/><path d="M9 12h.01M15 12h.01"/>',documents:'<path d="M8 4h6l4 4v12H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M13 4v5h5M10 13h5M10 17h3"/>',others:ICON.wallet,payments:ICON.wallet,cards:ICON.wallet};
  function walletExpiryLabel(item){
    const raw=item.expiry||item.pass?.expiry||item.date||'';
    if(!raw)return '';
    const d=new Date(raw);if(Number.isNaN(d.getTime()))return String(raw);
    const days=Math.ceil((d-localMidnight)/86400000);
    if(days<0)return 'Expired';
    if(days===0)return 'Expires today';
    if(days<=14)return `Expires in ${days}d`;
    return d.toLocaleDateString(undefined,{day:'numeric',month:'short'});
  }
  function walletPassHTML(item,mode){
    const color=item.color||WALLET_COLORS[item.kind]||WALLET_COLORS.others;
    const Data=window.DaylightData;
    const ev=Data?.eventAt?.(item);
    const when=ev?ev.toLocaleDateString(undefined,{month:'short',day:'numeric'}):(item.at?new Date(item.at).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'');
    const ico=WALLET_ICO[item.kind]||WALLET_ICO.others;
    const exp=walletExpiryLabel(item);
    const st=item.walletStatus||Data?.walletStatus?.(item)||'';
    const stLabel=st==='upcoming'?'Upcoming':st==='expired'?'Expired':st==='cancelled'?'Cancelled':'';
    if(mode==='row'){
      return `<button type="button" class="m-wallet-row kind-${esc(item.kind||'others')}" data-wid="${esc(item.id)}">
        <span class="m-wallet-row-ico" style="--a1:${esc(color[0])};--a2:${esc(color[1])}" aria-hidden="true">${svg(ico,18)}</span>
        <span class="m-wallet-row-copy"><b>${esc(item.title)}</b><small>${esc([WALLET_LABEL[item.kind],stLabel||exp||item.note||when].filter(Boolean).join(' · '))}</small></span>
        <span class="m-row-chev" aria-hidden="true">${svg(ICON.chevron,16)}</span>
      </button>`;
    }
    const authentic=!!(item.qrAuthentic||item.barcodeAuthentic||item.exactQr||item.scanSource);
    const img=item.image?`<img class="wp-thumb" src="${esc(item.image)}" alt="">`:(authentic&&item.qrImage?`<img class="wp-thumb" src="${esc(item.qrImage)}" alt="">`:'');
    const route=item.flight&&(item.flight.from||item.flight.to)?`<div class="wp-route"><b>${esc(item.flight.from||'—')}</b><span>→</span><b>${esc(item.flight.to||'—')}</b></div>`:'';
    return `<article class="m-wallet-pass kind-${esc(item.kind||'others')}" data-wid="${esc(item.id)}" style="background:linear-gradient(145deg,${color[0]},${color[1]})">
      <div class="wp-top"><span class="wp-kind">${svg(ico,14)} ${esc(WALLET_LABEL[item.kind]||'Pass')}</span><span class="wp-when">${esc(stLabel||exp||when)}</span></div>
      ${route||`<h3 class="wp-title">${esc(item.title)}</h3>`}
      ${route?`<p class="wp-note">${esc(item.title)}${item.flight?.flight?' · '+item.flight.flight:''}</p>`:(item.note?`<p class="wp-note">${esc(item.note)}</p>`:'')}
      ${img}
    </article>`;
  }
  function ensurePassCodes(item){
    if(!item)return item;
    // Only materialise QR/barcode images when the code is authentic (scan/attachment)
    const authentic=!!(item.qrAuthentic||item.barcodeAuthentic||item.exactQr||item.scanSource);
    if(!authentic){
      delete item.qrImage;delete item.barcodeImage;
      return item;
    }
    const payload=item.qrPayload||item.barcode;
    if(payload&&!item.qrImage)item.qrImage=qrUrl(String(payload).replace(/^#/,''),220);
    if(payload&&!item.barcodeImage)item.barcodeImage=barcodeUrl(String(payload).replace(/^#/,''));
    return item;
  }
  function dismissPassSheet(instant){
    const sheet=$('#pass-sheet');if(!sheet||(!sheet.classList.contains('show')&&!sheet.classList.contains('closing')&&!instant))return;
    clearTimeout(Nav.passTimer);mWalletOpen='';sheet.setAttribute('aria-hidden','true');
    sheet.style.transition='';sheet.style.transform='';sheet.style.opacity='';
    const finish=()=>{sheet.classList.remove('closing','show');document.body.classList.remove('pass-open');sheet.removeEventListener('transitionend',onEnd)};
    const onEnd=e=>{if(e.target!==sheet)return;finish()};
    if(instant||Nav.reduced()){finish();return}
    sheet.classList.add('closing');sheet.classList.remove('show');
    sheet.addEventListener('transitionend',onEnd);Nav.passTimer=setTimeout(finish,260);
  }
  function closePassSheet(){
    if(Nav.topView()==='pass'||Nav.stack.some(x=>x.view==='pass')){Nav.back();return}
    dismissPassSheet();
  }
  /**
   * Phase 14 — single navigator: Inbox / Wallet / Timeline resolve the same travel record.
   * Prefer Wallet pass when present; always can jump to source email via mailId.
   */
  function openTravelRecord(opts){
    const o=opts||{};
    const Data=window.DaylightData;
    feel.select();
    let walletId=o.walletId||null;
    let mailId=o.mailId||null;
    let childKey=o.childKey||null;
    if(!mailId&&walletId){
      const parts=Data?.parseWalletIdParts?.(walletId);
      mailId=parts?.mailId||readWallet().find(w=>w.id===walletId)?.mailId||null;
      childKey=childKey||parts?.childKey||null;
    }
    // Ensure canonical pass exists before any surface open so Inbox↔Wallet↔Timeline share one id
    if(mailId&&o.ensurePass&&!readWallet().some(w=>w.mailId===mailId&&(!childKey||w.childKey===childKey))){
      let list=readWallet();
      const r=upsertWalletFromBooking({
        mailId,threadId:o.threadId||mailId,kind:'train',subject:o.title||'Ticket',
        from:{name:''},dest:'',flight:null,whenMs:null,receivedMs:Date.now(),travelReliable:false,
        childKey,href:o.href||gmailLink(o.threadId||mailId),
        recordKey:o.recordKey||null,entityKey:o.entityKey||null,cancelled:false
      },list);
      if(r.added||r.updated)saveWallet(list);
      walletId=r.walletId||walletId;
    }
    const travel=mailId&&Data?.travelRecordForMail
      ?Data.travelRecordForMail(mailId,{walletId,childKey,threadId:o.threadId,recordKey:o.recordKey,entityKey:o.entityKey,ensureStub:!!o.ensureStub})
      :null;
    if(travel?.walletId)walletId=travel.walletId;
    if(travel?.mailId)mailId=travel.mailId;
    if(o.surface==='email'||o.preferEmail){
      const inboxItem=(typeof inboxUniverse==='function'?inboxUniverse():[]).find(i=>i.mailId===mailId||i.id===mailId||i.threadId===o.threadId);
      if(inboxItem){openLoopSheet(inboxToDetail(inboxItem));return travel}
      if(mailId){
        openLoopSheet(inboxToDetail({
          id:o.threadId||mailId,mailId,threadId:o.threadId||mailId,
          title:travel?.wallet?.title||'Travel email',subject:travel?.wallet?.title||'',
          kind:'ticket',tag:'Ticket',href:travel?.wallet?.href||gmailLink(o.threadId||mailId),
          whenMs:Date.now(),color:'#2f8fb0',snippet:''
        }));
        return travel;
      }
    }
    if(walletId&&readWallet().some(w=>w.id===walletId)){
      if(mTab!=='wallet')setTab('wallet',{soft:true});
      openPassSheet(walletId,{history:o.history});
      return travel;
    }
    // Ensure thin pass so navigation still lands on one canonical id
    if(mailId&&o.ensurePass!==false){
      let list=readWallet();
      const r=upsertWalletFromBooking({
        mailId,threadId:o.threadId||mailId,kind:'train',subject:o.title||'Ticket',
        from:{name:''},dest:'',flight:null,whenMs:null,receivedMs:Date.now(),travelReliable:false,
        childKey,href:o.href||gmailLink(o.threadId||mailId),
        recordKey:o.recordKey||null,entityKey:o.entityKey||null,cancelled:false
      },list);
      if(r.added||r.updated)saveWallet(list);
      walletId=r.walletId||walletId;
      if(walletId){if(mTab!=='wallet')setTab('wallet',{soft:true});openPassSheet(walletId,{history:o.history});return travel||Data?.travelRecordForMail?.(mailId,{walletId})}
    }
    if(o.href)window.open(o.href,'_blank','noopener');
    return travel;
  }
  function openPassSheet(id,opts){
    const item=ensurePassCodes(readWallet().find(i=>i.id===id));if(!item)return;
    mWalletOpen=id;
    const hist=opts&&opts.history;
    let sheet=$('#pass-sheet');
    if(!sheet){
      sheet=document.createElement('div');sheet.id='pass-sheet';sheet.className='pass-sheet';sheet.setAttribute('aria-hidden','true');
      sheet.innerHTML=`<div class="pass-sheet-inner">
        <div class="pass-nav"><button type="button" class="pass-done" data-pass-close>Done</button><button type="button" class="pass-more" data-pass-more aria-label="More">⋯</button></div>
        <div class="pass-scroll" id="pass-scroll"></div>
      </div>`;
      document.body.append(sheet);
      sheet.addEventListener('click',e=>{
        if(e.target.closest('[data-pass-close]')){closePassSheet();return}
        if(e.target.closest('[data-pass-more]')){
          const list=readWallet();const it=list.find(i=>i.id===mWalletOpen);if(!it)return;
          const order=['tickets','coupons','documents','others'];
          it.kind=order[(order.indexOf(it.kind)+1)%order.length];it.color=WALLET_COLORS[it.kind];saveWallet(list);
          openPassSheet(it.id);toast('Moved to '+WALLET_LABEL[it.kind],{type:'ok',haptic:'selection'});return;
        }
        if(e.target.closest('[data-pass-cal]')){
          const it=readWallet().find(i=>i.id===mWalletOpen);if(!it)return;
          const title=it.flight?`${it.flight.from||''} → ${it.flight.to||''}`.trim():it.title;
          capture('Calendar: '+title+(it.flight?.depart?' at '+it.flight.depart:''));
          toast('Added to reminders',{type:'ok',haptic:'success'});return;
        }
        if(e.target.closest('[data-pass-del]')){
          saveWallet(readWallet().filter(i=>i.id!==mWalletOpen));closePassSheet();renderWallet();toast('Removed from Wallet',{type:'warn',haptic:'warning'});return;
        }
        if(e.target.closest('[data-pass-email]')){
          const it=readWallet().find(i=>i.id===mWalletOpen);if(!it?.mailId){toast('No source email for this pass',{type:'warn'});return}
          closePassSheet();
          openTravelRecord({mailId:it.mailId,threadId:it.threadId,walletId:it.id,childKey:it.childKey,recordKey:it.recordKey,entityKey:it.entityKey,preferEmail:true,surface:'email'});
          return;
        }
      });
    }
    const color=item.color||WALLET_COLORS[item.kind]||WALLET_COLORS.others;
    const f=item.flight||null;
    const org=item.org||item.pass?.org||'Daylight Pass';
    const typeLabel=item.typeLabel||item.pass?.typeLabel||WALLET_LABEL[item.kind]||'Pass';
    const number=item.number||item.pass?.number||'';
    const since=item.memberSince||item.pass?.memberSince||'';
    const expiry=item.expiry||item.pass?.expiry||item.date||'';
    const authentic=!!(item.qrAuthentic||item.barcodeAuthentic||item.exactQr||item.scanSource);
    const bookingRef=item.bookingRef||item.flight?.pnr||number||'';
    const fields=[];
    if(f){
      if(f.from||f.to)fields.push(['From',f.from||'—'],['To',f.to||'—']);
      if(f.flight)fields.push(['Flight',f.flight]);
      if(f.seat)fields.push(['Seat',f.seat]);
      if(f.coach)fields.push(['Coach',f.coach]);
      if(f.gate)fields.push(['Gate',f.gate]);
      if(f.depart)fields.push(['Depart',f.depart]);
      if(f.arrive)fields.push(['Arrive',f.arrive]);
      if(f.pnr)fields.push(['Booking ref',f.pnr]);
    }else{
      fields.push(['Type',typeLabel]);
      if(number)fields.push(['Number',number]);
      if(since)fields.push(['Member since',since]);
      if(expiry)fields.push(['Expiry',expiry]);
      if(item.amount)fields.push(['Amount',item.amount]);
    }
    const fieldHTML=fields.map(([k,v])=>`<div class="pass-field"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    const Data=window.DaylightData;
    const wStatus=Data?.walletStatus?.(item)||(walletExpiryLabel(item)==='Expired'?'expired':'active');
    const status=item.status==='cancelled'||wStatus==='cancelled'?'Cancelled':wStatus==='expired'?'Expired':wStatus==='upcoming'?'Upcoming':(f?'Confirmed':'Active');
    const statusCls=status==='Confirmed'||status==='Active'||status==='Upcoming'?'is-ok':status==='Expired'||status==='Cancelled'?'is-bad':'';
    const codeBlock=authentic&&(item.qrImage||item.barcodeImage)
      ?`<div class="pass-code">
          ${item.qrImage?`<div class="pass-qr-wrap"><img class="pass-qr" src="${esc(item.qrImage)}" alt="Ticket QR code"></div>`:''}
          ${item.barcodeImage?`<img class="pass-bar" src="${esc(item.barcodeImage)}" alt="Ticket barcode">`:''}
          <span class="pass-code-id">${esc(bookingRef||'')}</span>
        </div>`
      :`<div class="pass-code pass-code-ref"><span class="pass-code-id">${esc(bookingRef?('Ref · '+bookingRef):'No QR on this pass')}</span></div>`;
    $('#pass-scroll').innerHTML=`
      <article class="pass-card kind-${esc(item.kind||'others')}" style="--p1:${esc(color[0])};--p2:${esc(color[1])}">
        <div class="pass-brand"><span class="pass-logo" aria-hidden="true">${esc((org||'D')[0])}</span><span>${esc(org)}</span><span class="pass-status ${statusCls}">${esc(status)}</span></div>
        ${f?`<div class="pass-route"><div><small>From</small><b>${esc(f.from||'—')}</b></div><span aria-hidden="true">→</span><div><small>To</small><b>${esc(f.to||'—')}</b></div></div>
        <p class="pass-flight-line">${esc([f.flight,item.title].filter(Boolean).join(' · '))}</p>`:
        `<div class="pass-hero"><div><h2>${esc(item.title)}</h2><p>${esc(item.note||typeLabel)}</p></div>${item.image?`<img class="pass-photo" src="${esc(item.image)}" alt="">`:''}</div>`}
        <div class="pass-fields">${fieldHTML}</div>
        ${codeBlock}
        ${item.image&&f?`<img class="pass-scan-preview" src="${esc(item.image)}" alt="Original scan">`:''}
      </article>
      <div class="pass-meta-foot">
        <div><span>Type</span><b>${esc(typeLabel)}</b></div>
        <div><span>Expiry</span><b>${esc(expiry||walletExpiryLabel(item)||'—')}</b></div>
      </div>
      <div class="pass-actions">
        ${item.mailId?`<button type="button" class="connect primary" data-pass-email>View email</button>`:`<button type="button" class="connect primary" data-pass-cal>Add to Calendar</button>`}
        ${item.mailId?`<button type="button" class="connect ghost" data-pass-cal>Add to Calendar</button>`:''}
        <button type="button" class="connect ghost" data-pass-del>Remove</button>
      </div>`;
    const wasOpen=sheet.classList.contains('show');
    clearTimeout(Nav.passTimer);sheet.classList.remove('closing');
    if(!wasOpen){sheet.classList.remove('show');void sheet.offsetWidth;feel.tap()}
    sheet.classList.add('show');sheet.setAttribute('aria-hidden','false');document.body.classList.add('pass-open');
    if(hist==='replace')Nav.replace('pass',id);
    else if(hist==='none'){/* caller owns history */}
    else if(wasOpen&&Nav.topView()==='pass')Nav.replace('pass',id);
    else if(Nav.topView()!=='pass')Nav.push('pass',id);
  }
  function renderWallet(){
    const el=$('#m-wallet');if(!el)return;
    $$('#m-wallet-tabs [data-wallet]').forEach(b=>{const on=b.dataset.wallet===mWalletFilter;b.classList.toggle('on',on);b.setAttribute('aria-selected',on?'true':'false')});
    requestAnimationFrame(()=>syncWalletThumb(true));
    const items=walletItems(mWalletFilter);
    if(!items.length){el.innerHTML=`<div class="m-wallet-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>No passes yet</b><p>Scan a ticket, coupon or document and it will appear here.</p><button class="m-wallet-scan-btn" type="button" id="m-wallet-empty-scan">Scan document</button></div>`;$('#m-wallet-empty-scan')?.addEventListener('click',openScan);return}
    const Data=window.DaylightData;
    const statusOf=i=>i.walletStatus||Data?.walletStatus?.(i)||'active';
    const upcoming=items.filter(i=>statusOf(i)==='upcoming');
    const active=items.filter(i=>{const s=statusOf(i);return s==='active'||(!upcoming.includes(i)&&s!=='expired'&&s!=='cancelled')});
    const expired=items.filter(i=>statusOf(i)==='expired'||statusOf(i)==='cancelled');
    // Prefer status sections when tickets/travel; otherwise keep compact list
    const useStatus=mWalletFilter==='all'||mWalletFilter==='tickets';
    if(useStatus&&(upcoming.length||expired.length)){
      const sec=(title,list,mode)=>!list.length?'':`<div class="m-wallet-sec"><h3 class="m-inbox-sec-h m-wallet-sec-h">${esc(title)} <span class="m-count-pill">${list.length}</span></h3><div class="${mode==='card'?'m-wallet-list':'m-wallet-rows'}">${list.map(i=>walletPassHTML(i,mode)).join('')}</div></div>`;
      el.innerHTML=`${sec('Upcoming',upcoming,'card')}${sec('Active',active.filter(i=>!upcoming.includes(i)),'card')}${sec('Expired',expired,'row')}`;
      walletStack().mount(el);
      return;
    }
    const pinned=items.filter(i=>i.kind==='tickets'||i.flight).slice(0,3);
    const pinnedIds=new Set(pinned.map(i=>i.id));
    const recent=items.filter(i=>!pinnedIds.has(i.id));
    el.innerHTML=`
      ${pinned.length?`<div class="m-wallet-sec"><h3 class="m-inbox-sec-h">Upcoming</h3><div class="m-wallet-list">${pinned.map(i=>walletPassHTML(i,'card')).join('')}</div></div>`:''}
      <div class="m-wallet-sec"><h3 class="m-inbox-sec-h">${pinned.length?'All':'Passes'}</h3><div class="${pinned.length?'m-wallet-rows':'m-wallet-list'}">${(pinned.length?recent:items).map(i=>walletPassHTML(i,pinned.length?'row':'card')).join('')||'<div class="m-empty">No other items.</div>'}</div></div>`;
    walletStack().mount(el);
  }
  /* ---- Wallet card stack (Apple Wallet style) ----
     Collapsed: cards overlap, each showing its header strip. Tap a card → it rises to the top and the others
     drop into a pile below. Tap the raised card → details. Swipe it down, or tap the pile → back to the stack.
     Pulling down on the stack fans the cards out a little (rubber band). */
  function walletStack(){return walletStack.o||(walletStack.o={
    /* Apple Wallet behaviour.
       Stack: cards overlap, each showing its top strip; pulling down at the top fans them out.
       Tap a card → focus: it glides to the top, a details panel fades in under it, the other cards drop to the
       bottom of the screen as a thin pile of edges, and the rest of the Wallet page fades out.
       Back: tap the pile, press Done, or swipe the raised card down. Tap the raised card → full pass sheet. */
    PEEK:70,EDGE:10,PILE_MAX:6,EASE:'cubic-bezier(.32,.72,0,1)',
    cardsOf(list){return [...list.querySelectorAll(':scope > .m-wallet-pass')]},
    mount(root){
      this.exit(true);
      [...root.querySelectorAll('.m-wallet-list')].forEach(list=>{
        const cards=this.cardsOf(list);
        if(!cards.length){list.classList.remove('wstack');return}
        list.classList.add('wstack');list.dataset.sel='';
        cards.forEach((c,i)=>{c.dataset.si=String(i)});
        this.layout(list,{live:true});
        if(!list._ws){list._ws=1;this.bind(list)}
      });
      if(!this._g){this._g=1;addEventListener('resize',()=>{$$('.wstack').forEach(l=>this.layout(l,{live:true}))},{passive:true})}
    },
    H(list){const c=list.querySelector('.m-wallet-pass');return c?.offsetHeight||200},
    set(c,y,s,z,live,i){
      c.style.transition=live?'none':`transform .55s ${this.EASE} ${Math.min(i,7)*16}ms, box-shadow .3s ease, filter .3s ease`;
      c.style.transform=`translate3d(0,${y.toFixed(1)}px,0) scale(${s})`;c.style.zIndex=String(z);
    },
    layout(list,o={}){
      const cards=this.cardsOf(list),n=cards.length,H=this.H(list),sel=list.dataset.sel===''?-1:+list.dataset.sel;
      if(sel<0){
        const sp=o.spread||0;
        cards.forEach((c,i)=>this.set(c,i*this.PEEK+sp*i*i*0.04,1,i+1,o.live,i));
        list.style.height=((n-1)*this.PEEK+H+sp*(n-1)*(n-1)*0.04)+'px';
        return;
      }
      // focus: pile at the bottom of the screen (above the tab bar)
      const top=list.getBoundingClientRect().top;
      const bar=$('.m-tabs')?.getBoundingClientRect();const floor=(bar&&bar.top>innerHeight*0.6?bar.top:innerHeight)-14;
      const others=cards.filter((_,i)=>i!==sel),m=others.length,shown=Math.min(m,this.PILE_MAX);
      const pileTop=floor-top-shown*this.EDGE-34;
      this.set(cards[sel],Math.max(0,o.drag||0),1,100,o.live,0);
      others.forEach((c,k)=>{const d=Math.max(0,k-(m-shown));this.set(c,pileTop+d*this.EDGE+(o.drag||0)*0.2,1-(shown-d)*0.012,10+k,o.live,k+1)});
      const panel=list.querySelector('.ws-details');if(panel)panel.style.top=(H+14)+'px';
    },
    detailsHTML(id){
      const it=readWallet().find(x=>x.id===id);if(!it)return '';
      const Data=window.DaylightData,ev=Data?.eventAt?.(it);
      const when=ev?ev.toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'';
      const st=it.walletStatus||Data?.walletStatus?.(it)||'';
      const rows=[['Type',WALLET_LABEL[it.kind]||'Pass'],['When',when],['Status',st?st[0].toUpperCase()+st.slice(1):''],['From',it.org||it.pass?.org||it.from||''],['Details',it.note||'']].filter((r,i,a)=>r[1]&&!(r[0]==='Details'&&r[1]===a[3]?.[1]));
      return `<dl>${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <div class="ws-actions">${it.mailId?`<button type="button" class="ws-open" data-ws-mail="${esc(id)}">View email</button>`:''}<button type="button" class="ws-done" data-ws-done>Done</button></div>`;
    },
    enter(list,i){
      const cards=this.cardsOf(list),c=cards[i];if(!c)return;
      const sc=Nav.scrollEl(),scr=list.closest('.m-screen')||sc;
      list.dataset.sel=String(i);list.classList.add('has-sel');cards.forEach((x,k)=>x.classList.toggle('is-front',k===i));
      scr?.classList.add('ws-focus');list.closest('.m-wallet-sec')?.classList.add('has-focus');
      let panel=list.querySelector('.ws-details');if(!panel){panel=document.createElement('div');panel.className='ws-details';list.append(panel)}
      panel.innerHTML=this.detailsHTML(c.dataset.wid);panel.classList.remove('show');
      try{feel.select()}catch{}
      // bring the stack up under the header first, then lift the card
      const want=(($('#mapp .m-top')?.getBoundingClientRect().bottom)||70)+8,top=list.getBoundingClientRect().top,delta=top-want;
      const go=()=>{if(sc)sc.style.overflowY='hidden';this.layout(list);requestAnimationFrame(()=>panel.classList.add('show'))};
      if(sc&&Math.abs(delta)>4){sc.scrollTo({top:sc.scrollTop+delta,behavior:Nav.reduced()?'auto':'smooth'});setTimeout(go,Nav.reduced()?0:300)}else go();
    },
    exit(instant){
      $$('.wstack.has-sel').forEach(list=>{
        list.dataset.sel='';list.classList.remove('has-sel');this.cardsOf(list).forEach(x=>x.classList.remove('is-front'));
        list.querySelector('.ws-details')?.classList.remove('show');
        this.layout(list,{live:!!instant});
      });
      $$('.ws-focus').forEach(x=>x.classList.remove('ws-focus'));$$('.m-wallet-sec.has-focus').forEach(x=>x.classList.remove('has-focus'));
      const sc=Nav.scrollEl();if(sc)sc.style.overflowY='';
    },
    bind(list){
      list.addEventListener('click',e=>{
        if(list._moved){list._moved=false;e.stopPropagation();e.preventDefault();return}
        if(e.target.closest('[data-ws-done]')){e.stopPropagation();try{feel.select()}catch{}this.exit();return}
        const vm=e.target.closest('[data-ws-mail]');if(vm){e.stopPropagation();const it=readWallet().find(x=>x.id===vm.dataset.wsMail);if(it?.mailId)openTravelRecord({mailId:it.mailId,threadId:it.threadId,walletId:it.id,childKey:it.childKey,recordKey:it.recordKey,entityKey:it.entityKey,preferEmail:true,surface:'email'});return}
        if(e.target.closest('.ws-details')){e.stopPropagation();return}
        const c=e.target.closest('.m-wallet-pass');if(!c)return;
        const sel=list.dataset.sel;
        if(sel===c.dataset.si){e.stopPropagation();e.preventDefault();return} // raised card: no extra sheet
        e.stopPropagation();e.preventDefault();
        if(sel!==''){try{feel.select()}catch{}this.exit();return} // tapped the pile
        this.enter(list,+c.dataset.si);
      },true);
      let st=null;
      const begin=(y,t)=>{st={y0:y,dy:0,front:!!t.closest('.m-wallet-pass.is-front')}};
      const move=(y,ev)=>{
        if(!st)return;st.dy=y-st.y0;if(st.dy<=0)return;
        if(list.dataset.sel!==''){if(!st.front)return;ev?.cancelable&&ev.preventDefault();list._moved=st.dy>6;this.layout(list,{live:true,drag:st.dy*0.9});return}
        if((Nav.scrollEl()?.scrollTop||0)>2)return;
        ev?.cancelable&&ev.preventDefault();list._moved=st.dy>6;this.layout(list,{live:true,spread:Math.min(180,st.dy*0.7)});
      };
      const end=()=>{
        if(!st)return;const dy=st.dy,front=st.front;st=null;
        if(list.dataset.sel!==''&&front&&dy>80){try{feel.select()}catch{}this.exit();return}
        this.layout(list);setTimeout(()=>{list._moved=false},60);
      };
      list.addEventListener('touchstart',e=>begin(e.touches[0].clientY,e.target),{passive:true});
      list.addEventListener('touchmove',e=>move(e.touches[0].clientY,e),{passive:false});
      list.addEventListener('touchend',end,{passive:true});list.addEventListener('touchcancel',end,{passive:true});
      list.addEventListener('mousedown',e=>{if(e.button||e.target.closest('.ws-details'))return;begin(e.clientY,e.target);const mm=ev=>move(ev.clientY,ev),mu=()=>{removeEventListener('mousemove',mm);removeEventListener('mouseup',mu);end()};addEventListener('mousemove',mm);addEventListener('mouseup',mu)});
    }
  })}
  $('#m-wallet-tabs')?.addEventListener('click',e=>{
    const b=e.target.closest('[data-wallet]');if(!b||b.dataset.wallet===mWalletFilter)return;
    mWalletFilter=b.dataset.wallet;mWalletOpen='';setLS('daylight-wallet-filter',mWalletFilter);renderWallet();
  });
  $('#m-wallet')?.addEventListener('click',e=>{
    const pass=e.target.closest('[data-wid]');
    if(pass){openPassSheet(pass.dataset.wid);return}
  });
  function stopScanCamera(){if(scanStream){scanStream.getTracks().forEach(t=>t.stop());scanStream=null}const v=$('#m-scan-video');if(v)v.srcObject=null}
  function showScanStep(step){
    $('#m-scan-landing').hidden=step!=='landing';
    $('#m-scan-camera').hidden=step!=='camera';
    $('#m-scan-process').hidden=step!=='process';
    $('#m-scan-review').hidden=step!=='review';
  }
  function openScan(){
    clearTimeout(Nav.scanTimer);scanUI.hidden=false;scanUI.classList.remove('closing');
    if(!scanUI.classList.contains('show')){void scanUI.offsetWidth;feel.tap()}
    scanUI.classList.add('show');scanUI.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';
    showScanStep('landing');
    if(Nav.topView()!=='scan')Nav.push('scan');
  }
  function dismissScan(instant){
    if(scanUI.hidden&&!scanUI.classList.contains('show')&&!instant)return;
    clearTimeout(Nav.scanTimer);stopScanCamera();scanDraft=null;scanExtract=null;
    scanUI.setAttribute('aria-hidden','true');
    scanUI.style.transition='';scanUI.style.transform='';scanUI.style.opacity='';
    const finish=()=>{scanUI.classList.remove('closing','show');scanUI.hidden=true;document.body.style.overflow='';scanUI.removeEventListener('transitionend',onEnd)};
    const onEnd=e=>{if(e.target!==scanUI)return;finish()};
    if(instant||Nav.reduced()){finish();return}
    scanUI.classList.add('closing');scanUI.classList.remove('show');
    scanUI.addEventListener('transitionend',onEnd);Nav.scanTimer=setTimeout(finish,260);
  }
  function closeScan(){
    if(Nav.topView()==='scan'||Nav.stack.some(x=>x.view==='scan')){Nav.back();return}
    dismissScan();
  }
  async function startScanCamera(){
    const perm=window.DaylightScan?await window.DaylightScan.ensureCameraPermission():{granted:true};
    if(!perm.granted&&perm.reason==='denied'){toast('Camera permission denied · enable it in system settings');$('#m-scan-file')?.click();return}
    showScanStep('camera');
    try{
      scanStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
      const v=$('#m-scan-video');v.srcObject=scanStream;await v.play().catch(()=>{});
    }catch(e){
      toast('Camera unavailable · pick a photo instead');
      $('#m-scan-file')?.click();
    }
  }
  function fillScanReview(extracted){
    scanExtract=extracted;scanDraft=extracted.image;
    $('#m-scan-preview').src=extracted.image;
    $('#m-scan-title').value=extracted.title||'Scanned document';
    $('#m-scan-cat').value=extracted.kind||'documents';
    $('#m-scan-date').value=extracted.date||'';
    $('#m-scan-amount').value=extracted.amount||'';
    $('#m-scan-note').value=extracted.note||'';
    $('#m-scan-ocr').value=extracted.ocrText||'';
    const eng=$('#m-scan-engine');
    if(eng){
      const n=(extracted.barcodes||[]).length;
      eng.textContent=n?`Found ${n} code${n>1?'s':''} · confirm fields`
        :extracted.engine==='web-heuristic'?'Web preview · confirm fields'
        :`Extracted · ${Math.round((extracted.confidence||0.8)*100)}% confidence`;
    }
    showScanStep('review');
  }
  async function processScanImage(dataUrl,hintText){
    showScanStep('process');
    $('#m-scan-process-title').textContent='Reading document…';
    $('#m-scan-process-copy').textContent=window.DaylightScanNative
      ?'ML Kit OCR and AI are structuring the fields.'
      :'Detecting what this is. On a native build this uses ML Kit + AI.';
    await new Promise(r=>setTimeout(r,650));
    try{
      const extracted=window.DaylightScan
        ?await window.DaylightScan.run(dataUrl,{hintText})
        :{engine:'web-heuristic',image:dataUrl,ocrText:hintText||'',kind:'documents',title:(hintText||'Scanned document').slice(0,60),amount:'',date:'',note:'Confirm details before saving',confidence:0.2};
      extracted.image=extracted.image||dataUrl;
      fillScanReview(extracted);
    }catch(e){
      toast('Could not extract text · enter details manually');
      fillScanReview({engine:'web-heuristic',image:dataUrl,ocrText:'',kind:'documents',title:'Scanned document',amount:'',date:'',note:'',confidence:0});
    }
  }
  function captureScanFrame(){
    const v=$('#m-scan-video'),c=$('#m-scan-canvas');if(!v||!c)return;
    const w=v.videoWidth||1280,h=v.videoHeight||720;c.width=w;c.height=h;
    // Crop roughly to the yellow frame region (perspective correction lands in native ML Kit path)
    const ctx=c.getContext('2d'),sx=Math.round(w*0.1),sy=Math.round(h*0.14),sw=Math.round(w*0.8),sh=Math.round(h*0.72);
    c.width=sw;c.height=sh;ctx.drawImage(v,sx,sy,sw,sh,0,0,sw,sh);
    let data='';
    try{data=c.toDataURL('image/jpeg',0.78)}catch{toast('Could not capture frame',{type:'err',haptic:'error'});return}
    feel.haptic('medium');stopScanCamera();processScanImage(data,'');
  }
  function saveScanToWallet(){
    if(!scanDraft){toast('Nothing to save');return}
    const title=($('#m-scan-title').value||'Scanned document').trim().slice(0,60);
    const kind=$('#m-scan-cat').value||'documents';
    const amount=($('#m-scan-amount').value||'').trim();
    const date=($('#m-scan-date').value||'').trim();
    const note=($('#m-scan-note').value||'').trim()||[date,amount].filter(Boolean).join(' · ')||'Added from scan';
    const ocr=($('#m-scan-ocr').value||'').trim();
    const ex=scanExtract||{};
    const ocrFlight=window.DaylightScan?.extractFlight?.(ocr)||ex.flight||null;
    const ocrPass=window.DaylightScan?.extractPassMeta?.(ocr,kind)||ex.pass||{};
    // Only treat scan-detected barcodes as authentic; never invent from OCR PNR alone
    const scannedCodes=(ex.barcodes||[]).filter(b=>b&&(b.rawValue||b.data||b.text));
    const authenticCode=ex.qrPayload||ex.barcode||(scannedCodes[0]&&(scannedCodes[0].rawValue||scannedCodes[0].data||scannedCodes[0].text))||'';
    const authentic=!!(authenticCode&&(ex.qrImage||ex.barcodeImage||scannedCodes.length||ex.engine));
    const item={
      id:'w'+Date.now(),title,kind,note,amount,date,ocr,at:new Date().toISOString(),image:scanDraft,
      color:WALLET_COLORS[kind]||WALLET_COLORS.documents,
      org:ocrPass.org||ex.pass?.org||'',typeLabel:ocrPass.typeLabel||ex.pass?.typeLabel||WALLET_LABEL[kind],
      number:ocrPass.number||ex.pass?.number||'',memberSince:ocrPass.memberSince||'',expiry:ocrPass.expiry||date||'',
      travelAt:ocrFlight?.depart&&/\d{4}-\d{2}-\d{2}/.test(String(ocrFlight.depart))?new Date(ocrFlight.depart).toISOString():null,
      eventAt:date&&window.DaylightData?.parseMaybeDate?.(date)?.toISOString?.()||null,
      barcode:authentic?authenticCode:'',qrPayload:authentic?authenticCode:'',barcodeFormat:ex.barcodeFormat||'',barcodes:ex.barcodes||[],
      qrImage:authentic?(ex.qrImage||''):'',barcodeImage:authentic?(ex.barcodeImage||''):'',
      qrAuthentic:authentic,barcodeAuthentic:authentic,exactQr:authentic,scanSource:true,
      bookingRef:ocrFlight?.pnr||ocrPass.number||'',flight:ocrFlight
    };
    if(authentic)ensurePassCodes(item);
    const list=readWallet();list.unshift(item);saveWallet(list);
    mWalletFilter='all';mWalletOpen=item.id;setLS('daylight-wallet-filter','all');
    Nav.drop('scan');dismissScan();setTab('wallet',{soft:true});
    openPassSheet(item.id,{history:'replace'});
    toast('Saved to Wallet',{type:'ok',haptic:'success'});
  }
  $('#m-wallet-fab')?.addEventListener('click',()=>{feel.tap();openScan()});
  // Undoable feedback for archive/snooze
  let undoTimer=0,undoFn=null;
  function toastUndo(msg,runUndo){
    undoFn=runUndo;clearTimeout(undoTimer);
    const e=$('#toast');if(!e){toast(msg,{type:'ok'});return}
    e.innerHTML=`${esc(msg)} <button type="button" class="toast-undo" data-undo>Undo</button>`;
    e.className='toast show toast-ok';
    undoTimer=setTimeout(()=>{e.classList.remove('show','toast-ok');undoFn=null;e.textContent=''},4200);
    feel.haptic('success');
  }
  document.addEventListener('click',e=>{
    if(!e.target.closest('[data-undo]')||!undoFn)return;
    clearTimeout(undoTimer);const fn=undoFn;undoFn=null;
    $('#toast')?.classList.remove('show','toast-ok');
    try{fn()}catch{}feel.select();toast('Undone',{ms:1400});
  });
  addEventListener('offline',()=>toast('You’re offline · Wallet passes still open',{type:'warn',ms:2800}));
  addEventListener('online',()=>toast('Back online',{type:'ok',ms:1600,haptic:'selection'}));
  scanUI.addEventListener('click',e=>{
    if(e.target.closest('[data-scan-close]')){if(!$('#m-scan-landing').hidden)closeScan();else if(!$('#m-scan-camera').hidden){stopScanCamera();showScanStep('landing')}else if(!$('#m-scan-process').hidden){/* ignore while processing */}else showScanStep('landing');return}
    if(e.target.closest('[data-scan-history]')){closeScan();mWalletFilter='all';setTab('wallet')}
  });
  $('#m-scan-start')?.addEventListener('click',startScanCamera);
  $('#m-scan-capture')?.addEventListener('click',captureScanFrame);
  $('#m-scan-save')?.addEventListener('click',saveScanToWallet);
  $('#m-scan-retake')?.addEventListener('click',()=>{scanDraft=null;scanExtract=null;startScanCamera()});
  $('#m-scan-file')?.addEventListener('change',e=>{
    const f=e.target.files?.[0];if(!f)return;
    const reader=new FileReader();
    reader.onload=()=>processScanImage(String(reader.result||''),(f.name||'').replace(/\.[^.]+$/,''));
    reader.readAsDataURL(f);e.target.value='';
  });
  // Calendar
  const weekStart=d=>{const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()-((x.getDay()+6)%7));return x};
  function weekCacheKey(ws){
    const Data=window.DaylightData;
    return Data?Data.localDayKey(ws):(ws.getFullYear()+'-'+String(ws.getMonth()+1).padStart(2,'0')+'-'+String(ws.getDate()).padStart(2,'0'));
  }
  async function weekEvents(ws){
    const start=new Date(ws.getFullYear(),ws.getMonth(),ws.getDate());
    const k=weekCacheKey(start);
    if(mWeekCache[k])return mWeekCache[k];
    if(mWeekInflight[k])return mWeekInflight[k];
    if(!token&&!microsoftAccount)return [];
    const to=new Date(start.getTime()+7*86400000);
    mWeekInflight[k]=(async()=>{
      const [g,m]=await Promise.all([
        token?googleEventsBetween(start,to):Promise.resolve([]),
        microsoftAccount?msEventsBetween(start,to):Promise.resolve([])
      ]);
      const ev=[...(g||[]),...(m||[])];
      mWeekCache[k]=ev;
      setTimeout(()=>{if(mWeekCache[k]===ev)delete mWeekCache[k]},5*60000);
      return ev;
    })();
    try{return await mWeekInflight[k]}finally{delete mWeekInflight[k]}
  }
  async function renderCalendar2(){
    const ws=weekStart(mSel),days=[...Array(7)].map((_,i)=>new Date(ws.getTime()+i*86400000));
    $('#m-month').textContent=mSel.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    const ev=await weekEvents(ws),dayKey=d=>d.toDateString(),busy=new Set();
    ev.forEach(e=>busy.add(dayKey(new Date(e.start?.dateTime||e.start?.date+'T12:00'))));personalTasks.forEach(t=>t.dueDate&&busy.add(dayKey(new Date(t.dueDate))));
    $('#m-week').innerHTML=days.map(d=>`<button type="button" class="m-wd${dayKey(d)===dayKey(mSel)?' on':''}${d<localMidnight?' past':''}" data-day="${d.toISOString()}"><span>${d.toLocaleDateString(undefined,{weekday:'short'})}</span><b>${d.getDate()}${busy.has(dayKey(d))?'<i></i>':''}</b></button>`).join('');
    const sel=ev.filter(e=>dayKey(new Date(e.start?.dateTime||e.start?.date+'T12:00'))===dayKey(mSel)).map(e=>{const s=new Date(e.start?.dateTime||e.start?.date+'T00:00'),en=new Date(e.end?.dateTime||s);return {title:e.summary||'(No title)',s,en,allDay:!e.start?.dateTime,href:e.htmlLink}})
      .concat(personalTasks.filter(t=>t.dueDate&&dayKey(new Date(t.dueDate))===dayKey(mSel)).map(t=>({title:t.title,s:new Date(t.dueDate),en:new Date(t.dueDate),allDay:!t.hasTime,reminder:true}))).sort((a,b)=>(a.allDay-b.allDay)||(a.s-b.s));
    const now=new Date(),isToday=dayKey(mSel)===dayKey(now);let nowShown=false;
    const row=x=>{let line='';if(isToday&&!nowShown&&!x.allDay&&x.s>now){nowShown=true;line=`<div class="m-now"><span>${hm(now)}</span><i></i></div>`}
      return line+`<div class="m-slot"><span class="m-hour">${x.allDay?(x.reminder?'Today':'All day'):hm(x.s).replace(':00','')}</span><${x.href?`a href="${esc(x.href)}" target="_blank" rel="noopener"`:'div'} class="m-ev${x.en<now&&!x.allDay?' past':''}${x.reminder?' rem':''}"><b>${esc(x.title)}</b><small>${x.allDay?(x.reminder?'Reminder':'All day'):x.reminder?'Reminder · '+hm(x.s):hm(x.s)+'–'+hm(x.en)}</small><span class="m-check${x.en<now&&!x.allDay?' on':''}"></span></${x.href?'a':'div'}></div>`};
    $('#m-day').innerHTML=!token&&!sel.length?'<div class="m-empty">Connect Google to see your calendar here.</div>':sel.length?sel.map(row).join('')+(isToday&&!nowShown?`<div class="m-now"><span>${hm(now)}</span><i></i></div>`:''):'<div class="m-empty">Nothing planned. A free day.</div>';
  }
  $('#m-week').onclick=e=>{const b=e.target.closest('[data-day]');if(b){mSel=new Date(b.dataset.day);renderCalendar2()}};
  $$('.m-cal-head [data-wk]').forEach(b=>b.onclick=()=>{mSel=new Date(mSel.getTime()+(+b.dataset.wk)*7*86400000);renderCalendar2()});
  // Assistant — day timeline + calendar + Ask chat
  function dayKey(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate()).toDateString()}
  function assistWeekStart(d){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()-((x.getDay()+6)%7));return x}
  function setAssistAsk(on){
    mAssistAsk=!!on;
    const wrap=$('#tl-chat-wrap'),view=$('#tl-view');
    if(wrap)wrap.hidden=!mAssistAsk;
    if(view)view.hidden=!!mAssistAsk;
    if(mAssistAsk){if(!mChat.length)chatHello();else renderChat();$('#m-msg-input')?.focus()}
  }
  async function paintAssistCal(){
    const ws=assistWeekStart(mAssistDay),days=[...Array(7)].map((_,i)=>new Date(ws.getFullYear(),ws.getMonth(),ws.getDate()+i));
    const monthEl=$('#tl-cal-month');if(monthEl)monthEl.textContent=mAssistDay.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    const week=$('#tl-week');if(!week)return;
    const busy=new Set();
    try{
      const ev=await weekEvents(ws);
      (ev||[]).forEach(e=>{
        const t=parseCalTimes(e);if(!t)return;
        days.forEach(d=>{
          const ds=new Date(d.getFullYear(),d.getMonth(),d.getDate()),de=new Date(ds.getTime()+86400000);
          if(t.allDay){if(ds>=t.start&&ds<t.end)busy.add(dayKey(ds))}
          else if(t.end>ds&&t.start<de)busy.add(dayKey(ds));
        });
      });
    }catch{}
    personalTasks.forEach(t=>{if(t.dueDate)busy.add(dayKey(new Date(t.dueDate)))});
    (providerData.google.tasks||[]).forEach(t=>{if(t.dueDate){
      const d=new Date(t.dueDate);const day=/T00:00:00(\.000)?Z$/.test(String(t.dueDate))?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):d;
      busy.add(dayKey(day));
    }});
    const Data=window.DaylightData;
    week.innerHTML=days.map(d=>{
      const on=dayKey(d)===dayKey(mAssistDay),today=dayKey(d)===dayKey(localMidnight),has=busy.has(dayKey(d));
      const localIso=Data?Data.localDayKey(d):(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'));
      return `<button type="button" class="tl-day${on?' on':''}${today?' is-today':''}${has?' has-ev':''}" data-tl-day="${localIso}" role="tab" aria-selected="${on?'true':'false'}"><span>${d.toLocaleDateString(undefined,{weekday:'short'})}</span><b>${d.getDate()}</b></button>`;
    }).join('');
  }
  async function dayTimelineItems(day){
    const Data=window.DaylightData;
    const start=new Date(day.getFullYear(),day.getMonth(),day.getDate());
    const end=new Date(start.getTime()+86400000);
    const items=[];
    const seen=new Set();
    const push=it=>{if(!it||seen.has(it.id))return;seen.add(it.id);items.push(it)};
    const addEvent=e=>{
      const t=parseCalTimes(e);if(!t)return;
      // Real calendar overlap for this local day (all-day uses exclusive end, same as Google)
      if(t.allDay){if(!(start>=t.start&&start<t.end))return}
      else if(!(t.end>start&&t.start<end))return;
      const title=e.summary||e.subject||'(No title)';
      const loc=typeof e.location==='string'?e.location:(e.location?.displayName||'');
      const mail=loopsData?.meetingMail?.[e.id];
      push({
        id:'ev:'+(e.id||t.start.getTime()+title),
        kind:TRAVEL.test(title+' '+loc)?'travel':(e.attendees||[]).length>1?'meet':'event',
        title,start:t.start,end:t.end,allDay:t.allDay,
        meta:[loc,e.source||'',mail?`Mail: ${mail.subject}`:''].filter(Boolean).join(' · '),
        href:e.htmlLink||e.webLink||'',relatedMail:mail||null
      });
    };
    try{
      const ev=await weekEvents(assistWeekStart(start));
      (ev||[]).forEach(addEvent);
    }catch(err){console.warn('timeline cal',err)}
    const dueDay=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(String(v))?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    [
      ...personalTasks.map(t=>({...t,src:t.project||'Reminder'})),
      ...(providerData.google.tasks||[]).map(t=>({...t,src:t.listName||'Google Tasks'})),
      ...(providerData.microsoft.tasks||[]).map(t=>({...t,src:t.listName||'To Do'}))
    ].filter(t=>t?.title&&t.dueDate&&dayKey(dueDay(t.dueDate))===dayKey(start)).forEach(t=>{
      const s=t.hasTime?new Date(t.dueDate):dueDay(t.dueDate); // a reminder at 14:00 stays at 14:00
      push({id:'task:'+(t.id||t.title),kind:/pay|bill|invoice/i.test(t.src||'')||t.project==='Payments'?'bill':'task',title:t.title,start:s,end:s,allDay:!t.hasTime,meta:isLegacyPayTask(t)?'Unconfirmed old suggestion':(t.src||'Task'),href:t.href||''});
    });
    try{
      // Wallet/travel: strict eventAt only — missing travel dates never invent Timeline rows
      (Data?.walletItems?Data.walletItems({filter:'tickets'}):readWallet()).forEach(w=>{
        const ev=Data?.eventAt?.(w);
        if(!ev||isNaN(ev)||dayKey(ev)!==dayKey(start))return;
        if(w.walletStatus==='cancelled'||w.status==='cancelled'||/cancel/i.test(w.status||''))return;
        push({
          id:'wallet:'+w.id,kind:'travel',title:w.title,start:ev,end:ev,allDay:!w.flight?.depart,
          meta:[w.typeLabel||WALLET_LABEL[w.kind]||'Ticket',w.tripId?'Trip linked':''].filter(Boolean).join(' · '),
          href:w.href||'',walletId:w.id,mailId:w.mailId||null,threadId:w.threadId||null,
          recordKey:w.recordKey||null,entityKey:w.entityKey||null,childKey:w.childKey||null,
          relatedMail:w.mailId?{mailId:w.mailId,threadId:w.threadId}:null
        });
      });
      // AI orders with delivery on this local day
      (Data?.orders?Data.orders({excludeCancelled:true}):[]).forEach(o=>{
        const ev=Data?.eventAt?.(o);if(!ev||isNaN(ev)||dayKey(ev)!==dayKey(start))return;
        push({
          id:'order:'+o.id,kind:'bill',title:(o.merchant||'Order')+' delivery',start:ev,end:ev,allDay:true,
          meta:o.status||'Delivery',href:o.href||'',relatedMail:o.mailId?{mailId:o.mailId}:null
        });
      });
    }catch{}
    // All-day first (stable), then timed chronological
    return items.sort((a,b)=>(!!b.allDay-!!a.allDay)||(a.start-b.start)||String(a.title).localeCompare(String(b.title)));
  }
  function tlIcon(kind){
    if(kind==='travel')return ICON.suitcase;
    if(kind==='meet')return ICON.chat;
    if(kind==='task')return ICON.spark;
    if(kind==='bill')return ICON.wallet;
    if(kind==='event')return ICON.calendar;
    return ICON.phone;
  }
  function tlCard(item){
    const time=item.allDay?'All day':`${hm(item.start)}${item.flight?.depart?'' :(item.end&&item.end-item.start>60*1000?' – '+hm(item.end):'')}`;
    const thumb=`<span class="tl-thumb kind-${esc(item.kind)}" aria-hidden="true">${svg(tlIcon(item.kind),18)}</span>`;
    const open=item.loopId?`data-open-loop="${esc(item.loopId)}"`
      :(item.walletId||item.mailId
        ?`data-open-travel="1" data-wallet-id="${esc(item.walletId||'')}" data-mail-id="${esc(item.mailId||'')}" data-thread-id="${esc(item.threadId||'')}" data-child-key="${esc(item.childKey||'')}" data-record-key="${esc(item.recordKey||'')}"`
        :(item.href?`data-tl-href="${esc(item.href)}"`:''));
    void open; // tiles are display-only: tapping a Timeline tile does nothing
    return `<article class="tl-card${item.allDay?' is-allday':''}">
      <span class="tl-node" aria-hidden="true">${svg(tlIcon(item.kind),16)}</span>
      <div class="tl-card-body">
        <time>${esc(time)}</time>
        <b>${esc(item.title)}</b>
        ${item.meta?`<small>${esc(item.meta)}</small>`:''}
      </div>
      ${thumb}
    </article>`;
  }
  async function renderAssistant(){
    const heading=$('#tl-heading'),list=$('#tl-list'),count=$('#tl-count'),countN=$('#tl-count-n');
    if(!list)return;
    const same=dayKey(mAssistDay)===dayKey(localMidnight);
    const dateTxt=mAssistDay.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
    if(heading)heading.textContent=same?'Today':mAssistDay.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
    list.innerHTML=skelRows(4);
    await paintAssistCal();
    const items=await dayTimelineItems(mAssistDay);
    if(count&&countN){countN.textContent=String(items.length);count.hidden=!items.length}
    if(!items.length){
      list.innerHTML=`<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Nothing on this day</b><p>${token||microsoftAccount?'No Google Calendar events or tasks for this day.':'Connect Google Calendar to fill your timeline.'}</p></div>`;
      return;
    }
    list.innerHTML=`<div class="tl-rail">${items.map(tlCard).join('')}</div>`;
  }
  function chatHello(){const p=readProfile();mChat=[{who:'ai',html:`Hi${p.name?' '+esc(p.name.split(' ')[0]):''}! Ask me about your day, or tell me something to remember.`,chips:['What do I have tomorrow?','Who is waiting for a reply?','Remember to call the lab on Friday at 10']}];renderChat()}
  function renderChat(){const el=$('#m-chat');if(!el)return;el.innerHTML=`<div class="m-stamp">${esc(mAssistDay.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}))}, ${hm(new Date())}</div>`+mChat.map(m=>m.who==='me'?`<div class="m-b me">${esc(m.text)}</div>`:m.who==='wait'?`<div class="m-wait"><i></i><i></i><i></i> Analyzing…</div>`:`<div class="m-b ai">${m.html}${m.chips?`<div class="m-chips">${m.chips.map(c=>`<button type="button" data-ask="${esc(c)}">${esc(c)}</button>`).join('')}</div>`:''}</div>`).join('');el.scrollTop=el.scrollHeight}
  async function ask(q){q=q.trim();if(!q)return;if(!mAssistAsk)setAssistAsk(true);mChat.push({who:'me',text:q},{who:'wait'});renderChat();let html;
    try{if(looksLikeCapture(q)){const it=capture(q);html=`Saved <b>${esc(it.title)}</b>${it.dueDate?' for '+esc(fmtDue(it)):''}${it.project?' in '+esc(it.project):''}. <button type="button" class="m-link" data-undo-chat="${esc(it.id)}">Undo</button>`}
      else{const r=await answer(q);html=(r.sections||[]).map(s=>`${s.title?`<div class="m-ah">${esc(s.title)}</div>`:''}${s.items.length?`<ul>${s.items.slice(0,6).map(i=>`<li>${i.href?`<a href="${esc(i.href)}" target="_blank" rel="noopener">${esc(i.title)}</a>`:esc(i.title)}<small>${esc(i.meta||'')}</small></li>`).join('')}</ul>`:`<p>${esc(s.empty||'Nothing found.')}</p>`}${s.more?`<a class="m-link" href="${esc(s.more.href)}" target="_blank" rel="noopener">${esc(s.more.label)} ↗</a>`:''}`).join('')+(r.note?`<p>${esc(r.note)}</p>`:'')}}
    catch(e){html='Sorry, something went wrong: '+esc(e.message)}
    mChat.pop();mChat.push({who:'ai',html});renderChat()}
  $('#m-msg')?.addEventListener('submit',e=>{e.preventDefault();const v=$('#m-msg-input').value;$('#m-msg-input').value='';ask(v)});
  $('#m-chat')?.addEventListener('click',e=>{const c=e.target.closest('[data-ask]');if(c)ask(c.dataset.ask);const u=e.target.closest('[data-undo-chat]');if(u){personalTasks=personalTasks.filter(t=>t.id!==u.dataset.undoChat);savePersonal();renderTasks();renderLoops();u.replaceWith(document.createTextNode('(removed)'))}});
  $('#tl-cal')?.addEventListener('click',e=>{
    const wk=e.target.closest('[data-tl-wk]');
    if(wk){mAssistDay=new Date(mAssistDay.getTime()+(+wk.dataset.tlWk)*7*86400000);paintAssistCal();feel.select();renderAssistant();return}
    const day=e.target.closest('[data-tl-day]');if(!day)return;
    // data-tl-day is local Y-M-D (not UTC ISO) to avoid timezone day shifts
    const raw=day.dataset.tlDay||'';
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw)){const[y,m,dd]=raw.split('-').map(Number);mAssistDay=new Date(y,m-1,dd)}
    else mAssistDay=new Date(raw);
    if(isNaN(mAssistDay))mAssistDay=new Date(localMidnight);
    feel.select();
    if(mAssistAsk)setAssistAsk(false);
    renderAssistant();
  });
  $('#tl-list')?.addEventListener('click',e=>{
    const loop=e.target.closest('[data-open-loop]');if(loop){openLoopSheet(loop.dataset.openLoop);return}
    const tr=e.target.closest('[data-open-travel]');
    if(tr){
      openTravelRecord({
        walletId:tr.dataset.walletId||null,mailId:tr.dataset.mailId||null,
        threadId:tr.dataset.threadId||null,childKey:tr.dataset.childKey||null,
        recordKey:tr.dataset.recordKey||null
      });
      return;
    }
    const w=e.target.closest('[data-open-wallet]');if(w){openTravelRecord({walletId:w.dataset.openWallet});return}
    const a=e.target.closest('[data-tl-href]');if(a)window.open(a.dataset.tlHref,'_blank','noopener');
  });
  // Health (Statistics tab) — Apple Health–style overview
  let healthCache=null,healthLoading=false;
  function fmtSleep(min){
    const m=Math.max(0,Math.round(min||0)),h=Math.floor(m/60),r=m%60;
    return h?`${h}h ${String(r).padStart(2,'0')}m`:`${r}m`;
  }
  function fmtSteps(n){return Math.round(n||0).toLocaleString()}
  function sparkHTML(values){
    const vals=(values||[]).slice(-7),max=Math.max(1,...vals);
    return `<span class="hx-spark" aria-hidden="true">${vals.map((v,i)=>`<i class="${i===vals.length-1?'is-now':''}" style="height:${Math.max(8,Math.round((v/max)*100))}%"></i>`).join('')}</span>`;
  }
  function healthSourceLabel(h){
    if(h?.source==='apple-health')return 'From Apple Health';
    if(h?.source==='google-fit')return 'From Google Fit';
    if(h?.source==='demo')return 'Sample health data · connect Fit or Apple Health for yours';
    if(h?.fromCache)return 'Showing last synced health data';
    return 'Connect a health source to fill this tab';
  }
  function healthRangeLabel(days){
    return days===30?'Last 30 Days':days===14?'Last 14 Days':'Last 7 Days';
  }
  async function loadHealthSummary(force){
    const H=window.DaylightHealth;
    if(!H?.loadHealth)return null;
    if(!force&&healthCache&&Date.now()-(healthCache.fetchedAt||0)<60000)return healthCache;
    const days=H.getRangeDays();
    healthCache=await H.loadHealth({
      days,
      token,
      googleScopes:googleScopeBlob(),
      demo:DEMO||(!token&&!H.capacitorAvailable?.()),
      fetchImpl:async(url,opts)=>{
        // Prefer Daylight api() for auth refresh when URL is string GET; Fitness uses POST
        if(typeof url==='string'&&opts?.method&&opts.method!=='GET'){
          const r=await fetch(url,{...opts,headers:{...(opts.headers||{}),Authorization:opts.headers?.Authorization||('Bearer '+token)}});
          return r;
        }
        return fetch(url,opts);
      }
    });
    return healthCache;
  }
  function paintHealth(el,h,prod){
    const days=h?.rangeDays||7;
    const series=h?.series||[];
    const stepMax=Math.max(12000,...series.map(d=>d.steps||0));
    const yTicks=[0,Math.round(stepMax/3),Math.round(stepMax*2/3),Math.round(stepMax)].reverse();
    const yLabel=n=>n>=1000?`${Math.round(n/1000)}K`:String(n);
    const deltaCls=(h?.scoreDelta||0)<0?' is-down':'';
    const deltaTxt=`${(h?.scoreDelta||0)>=0?'+':''}${h?.scoreDelta||0} from last week`;
    const stepsDeltaTxt=`${(h?.stepsDelta||0)>=0?'+':''}${h?.stepsDelta||0}% vs. last week`;
    const sleepDeltaTxt=`${(h?.sleepDeltaMin||0)>=0?'+':''}${Math.abs(h?.sleepDeltaMin||0)}m vs. last week`;
    const note=(h?.scoreDelta||0)>=0?'Good progress! Keep your activity and sleep consistent.':'Steady sleep and daily movement will lift your score.';
      const live=h?.source==='apple-health'||(h?.source==='google-fit'&&h?.connected&&!h?.needsScope);
      const native=window.DaylightHealth?.capacitorAvailable?.();
      const showConnect=!live;
      el.innerHTML=`
      <div class="hx-head">
        <p>Your wellbeing, at a glance.</p>
        <button type="button" class="hx-range" id="hx-range" aria-label="Change health range">${esc(healthRangeLabel(days))} ${svg(ICON.chevDown,14)}</button>
      </div>
      ${showConnect?`<div class="hx-connect"><b>${h?.needsScope?'Allow Google Fit access':'Connect your health app'}</b>
        <p>${native?'Daylight can read Apple Health or Health Connect on this device.':'Connect Google Fit to pull steps, sleep, heart rate and activity. Sample data is shown until you connect.'}</p>
        <div class="hx-connect-actions">
          ${token||h?.needsScope?`<button type="button" class="primary" data-hx="fit">Connect Google Fit</button>`:`<button type="button" class="primary" data-hx="google">Connect Google</button>`}
          ${h?.source==='demo'?'':`<button type="button" class="ghost" data-hx="demo">Preview sample data</button>`}
        </div></div>`:''}
      <button type="button" class="hx-score" aria-label="Health score" data-hx-detail="score">
        <div class="hx-ring" style="--p:${esc(String(h?.score||0))}"><span>${svg(ICON.heart,26)}</span></div>
        <div class="hx-score-copy"><small>Health Score</small><b>${esc(String(h?.score||0))}/100</b><span class="hx-delta${deltaCls}">${esc(deltaTxt)}</span></div>
        <p class="hx-score-note">${esc(note)}</p>
      </button>
      <div class="hx-metrics" role="list">
        <button type="button" class="hx-metric is-cal" role="listitem" data-hx-detail="calories"><span class="hx-metric-ico">${svg(ICON.flame,16)}</span><b>${esc(fmtSteps(h?.caloriesAvg))} kcal</b><small>avg / day</small>${sparkHTML(series.map(d=>d.calories))}</button>
        <button type="button" class="hx-metric is-steps" role="listitem" data-hx-detail="steps"><span class="hx-metric-ico">${svg(ICON.shoe,16)}</span><b>${esc(fmtSteps(h?.stepsAvg))}</b><small>steps / day</small>${sparkHTML(series.map(d=>d.steps))}</button>
        <button type="button" class="hx-metric is-sleep" role="listitem" data-hx-detail="sleep"><span class="hx-metric-ico">${svg(ICON.bed,16)}</span><b>${esc(fmtSleep(h?.sleepAvgMin))}</b><small>sleep / night</small>${sparkHTML(series.map(d=>d.sleepMin))}</button>
        <button type="button" class="hx-metric is-hr" role="listitem" data-hx-detail="hr"><span class="hx-metric-ico">${svg(ICON.heart,16)}</span><b>${esc(String(h?.restingHr||'—'))} bpm</b><small>resting HR</small>${sparkHTML(series.map(d=>d.heartRate||60))}</button>
      </div>
      <button type="button" class="hx-chart" data-hx-detail="steps">
        <div class="hx-chart-h"><div><b>Steps</b><small>${esc(fmtSteps(h?.stepsAvg))} avg/day</small></div><span class="hx-delta">${esc(stepsDeltaTxt)}</span></div>
        <div class="hx-bars">
          <div class="hx-yaxis" aria-hidden="true">${yTicks.map(t=>`<span>${yLabel(t)}</span>`).join('')}</div>
          <div class="hx-bargrid">${series.slice(-7).map((d,i,arr)=>{
            const ht=Math.max(8,Math.round(((d.steps||0)/stepMax)*100));
            const label=new Date(d.date+'T12:00:00').toLocaleDateString(undefined,{weekday:'short'}).slice(0,2);
            const now=i===arr.length-1?' is-now':'';
            return `<div class="hx-barcol${now}"><span class="hx-bar-track"><i style="--h:${ht}%"></i></span><span>${esc(label)}</span></div>`;
          }).join('')}</div>
        </div>
      </button>
      <div class="hx-split">
        <button type="button" class="hx-tile is-sleep" data-hx-detail="sleep">
          <div class="hx-tile-h"><span>${svg(ICON.bed,15)}</span><b>Sleep</b></div>
          <strong>${esc(fmtSleep(h?.sleepAvgMin))} / night</strong>
          <small>${esc(sleepDeltaTxt)}</small>
          ${sparkHTML(series.map(d=>d.sleepMin))}
        </button>
        <button type="button" class="hx-tile is-act" data-hx-detail="activity">
          <div class="hx-tile-h"><span>${svg(ICON.run,15)}</span><b>Activity</b></div>
          <div class="hx-act-row">
            <div><strong>${esc(String(h?.activeMinWeek||0))} min</strong><small>/ week moderate</small></div>
            <div class="hx-mini-ring" style="--p:${esc(String(h?.activityPct||0))}"><b>${esc(String(h?.activityPct||0))}%</b></div>
          </div>
        </button>
      </div>
      <section class="hx-insights">
        <h3>Health Insights</h3>
        <button type="button" class="hx-insight" data-hx="insight">
          <span class="hx-insight-ico" aria-hidden="true">${svg(ICON.bulb,18)}</span>
          <p>${esc(h?.insight||'Connect a health source to unlock insights.')}</p>
          <span class="chev" aria-hidden="true">${svg(ICON.chevron,16)}</span>
        </button>
      </section>
      <p class="hx-source">${esc(healthSourceLabel(h))}</p>
      <div class="hx-prod">
        <div class="m-dt">Also this week in Daylight</div>
        <div class="m-kpis">
          <div class="m-kpi"><b>${prod.done}</b><span>tasks completed</span></div>
          <div class="m-kpi"><b>${esc(prod.focus)}</b><span>focus time</span></div>
          <div class="m-kpi"><b>${prod.meetings}</b><span>meetings</span></div>
          <div class="m-kpi"><b>${esc(prod.meetHours)}</b><span>in meetings</span></div>
        </div>
      </div>`;
  }
  async function renderStats(opts={}){
    const el=$('#m-stats');if(!el)return;
    if(healthLoading&&!opts.force)return;
    healthLoading=true;
    if(!el.dataset.ready)el.innerHTML='<div class="m-empty">Loading health…</div>';
    try{
      const now=new Date(),ws=new Date(localMidnight.getTime()-6*86400000);
      const doneLog=readJSON('daylight-done-log',[]).filter(d=>new Date(d.at)>=ws);
      const focus=readJSON('daylight-focus-log',[]).filter(d=>new Date(d.at)>=ws);
      const fmin=focus.reduce((a,b)=>a+(+b.min||0),0);
      let meetN=0,meetH=0;
      if(token){
        try{
          const ev=await eventsBetween(ws,now)||[];
          const m=ev.filter(e=>e.start?.dateTime&&(e.attendees||[]).length>1);
          meetN=m.length;
          meetH=m.reduce((a,e)=>a+(new Date(e.end?.dateTime||e.start.dateTime)-new Date(e.start.dateTime))/3600000,0);
        }catch{}
      }
      const prod={
        done:doneLog.length,
        focus:fmin>=60?`${Math.floor(fmin/60)}h ${fmin%60}m`:`${fmin}m`,
        meetings:token?meetN:'—',
        meetHours:token?`${meetH.toFixed(1)}h`:'—'
      };
      const h=await loadHealthSummary(!!opts.force);
      paintHealth(el,h,prod);
      el.dataset.ready='1';
    }catch(e){
      console.warn('health render',e);
      el.innerHTML=`<div class="m-empty"><b>Couldn’t load health</b><p>${esc(e.message||'Try again in a moment.')}</p></div>`;
    }finally{healthLoading=false}
  }
  let healthDetailTimer=0;
  function healthDetailCopy(kind,h){
    const map={
      score:{title:'Health Score',stat:`${h?.score||0}/100`,body:h?.insight||'Your score blends steps, sleep and weekly activity.'},
      steps:{title:'Steps',stat:fmtSteps(h?.stepsAvg),body:`Average ${fmtSteps(h?.stepsAvg)} steps/day over the selected range. ${(h?.stepsDelta||0)>=0?'Up':'Down'} ${Math.abs(h?.stepsDelta||0)}% versus the prior period.`},
      calories:{title:'Calories',stat:`${fmtSteps(h?.caloriesAvg)} kcal`,body:`Average active energy around ${fmtSteps(h?.caloriesAvg)} kcal per day.`},
      sleep:{title:'Sleep',stat:fmtSleep(h?.sleepAvgMin),body:`You averaged ${fmtSleep(h?.sleepAvgMin)} of sleep per night. Aim for a steady 7–9 hour window.`},
      hr:{title:'Resting Heart Rate',stat:`${h?.restingHr||'—'} bpm`,body:h?.restingHr?`Resting heart rate averaged ${h.restingHr} bpm.`:'Heart rate samples will appear once a health source is connected.'},
      activity:{title:'Activity',stat:`${h?.activeMinWeek||0} min`,body:`${h?.activeMinWeek||0} minutes of moderate activity this week toward a ${h?.activityGoal||150}-minute goal (${h?.activityPct||0}%).`},
      insight:{title:'Health Insight',stat:'',body:h?.insight||'Keep logging movement and sleep to unlock personalised tips.'}
    };
    return map[kind]||map.insight;
  }
  function openHealthDetail(kind){
    const h=healthCache||{};
    const copy=healthDetailCopy(kind,h);
    let el=$('#hx-detail');
    if(!el){
      el=document.createElement('div');el.id='hx-detail';el.className='hx-detail';el.setAttribute('aria-hidden','true');
      el.innerHTML=`<div class="hx-detail-inner">
        <div class="hx-detail-nav"><button type="button" class="td-nav-btn" data-hx-close aria-label="Back">‹</button><b id="hx-detail-title">Health</b><span style="width:36px"></span></div>
        <div class="hx-detail-body" id="hx-detail-body"></div>
      </div>`;
      document.body.append(el);
      el.addEventListener('click',e=>{if(e.target.closest('[data-hx-close]'))closeHealthDetail()});
    }
    $('#hx-detail-title').textContent=copy.title;
    $('#hx-detail-body').innerHTML=`<article class="hx-detail-card">${copy.stat?`<div class="hx-detail-stat">${esc(copy.stat)}</div>`:''}<h3>${esc(copy.title)}</h3><p>${esc(copy.body)}</p></article>
      <article class="hx-detail-card"><h3>Source</h3><p>${esc(healthSourceLabel(h))}</p></article>`;
    const wasOpen=el.classList.contains('show');
    clearTimeout(healthDetailTimer);el.classList.remove('closing');
    if(!wasOpen){el.classList.remove('show');void el.offsetWidth;feel.tap()}
    el.classList.add('show');el.setAttribute('aria-hidden','false');document.body.classList.add('hx-detail-open');
    if(wasOpen&&Nav.topView()==='health')Nav.replace('health',kind);
    else if(Nav.topView()!=='health')Nav.push('health',kind);
  }
  function dismissHealthDetail(instant){
    const el=$('#hx-detail');
    if(!el||(!el.classList.contains('show')&&!el.classList.contains('closing'))){Nav.drop('health');document.body.classList.remove('hx-detail-open');return}
    const finish=()=>{
      el.classList.remove('show','closing');el.setAttribute('aria-hidden','true');
      el.style.transform='';el.style.opacity='';
      document.body.classList.remove('hx-detail-open');Nav.drop('health');
    };
    if(instant||Nav.reduced()){finish();return}
    el.classList.add('closing');el.classList.remove('show');
    clearTimeout(healthDetailTimer);healthDetailTimer=setTimeout(finish,260);
  }
  function closeHealthDetail(){
    if(Nav.topView()==='health'||Nav.stack.some(x=>x.view==='health')){Nav.back();return}
    dismissHealthDetail(false);
  }
  $('#m-stats')?.addEventListener('click',e=>{
    const range=e.target.closest('#hx-range');
    if(range){
      const H=window.DaylightHealth;if(!H)return;
      const cur=H.getRangeDays(),order=[7,14,30],next=order[(order.indexOf(cur)+1)%order.length];
      H.setRangeDays(next);feel.select();renderStats({force:true});return;
    }
    const detail=e.target.closest('[data-hx-detail]');
    if(detail){openHealthDetail(detail.dataset.hxDetail);return}
    const act=e.target.closest('[data-hx]');if(!act)return;
    const kind=act.dataset.hx;
    if(kind==='fit'){requestFitnessAccess();return}
    if(kind==='google'){connectDialog({setup:true,focusId:true});return}
    if(kind==='demo'){
      try{localStorage.setItem('daylight-demo','1')}catch{}
      const H=window.DaylightHealth;
      if(H){healthCache=H.summarize(H.demoSeries(H.getRangeDays()),'demo',true);paintHealth($('#m-stats'),healthCache,{done:0,focus:'0m',meetings:'—',meetHours:'—'})}
      toast('Showing sample health data',{type:'ok'});return;
    }
    if(kind==='insight'){openHealthDetail('insight')}
  });
  // Header buttons, search (FAB removed — Wallet is the center action for scans)
  function renderMTop(){const p=readProfile(),av=$('#m-avatar');av.innerHTML=p.picture?`<img src="${esc(p.picture)}" alt="" referrerpolicy="no-referrer">`:esc(((p.name||'K')[0]).toUpperCase());
    const n=$('#bell-badge');$('#mapp .m-dot').hidden=!n||n.hidden}
  $('#m-avatar').onclick=()=>$('#menu-btn').click();
  $('#m-bell').onclick=e=>{e.stopPropagation();$('#bell').click()};
  const openCmd=capture=>{document.body.classList.add('cmd-open');if(capture)$('#cmd-capture')?.click();else{$('#cmd-input')?.focus()}};
  $('#m-search').onclick=e=>{e.stopPropagation();openCmd(false)};
  document.addEventListener('click',e=>{if(document.body.classList.contains('cmd-open')&&!e.composedPath().includes($('#cmd')))document.body.classList.remove('cmd-open')});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')document.body.classList.remove('cmd-open')});
  function renderMobile(){if(!mq.matches)return;renderMTop();if(mTab==='home')renderHome();else if(mTab==='inbox')renderInbox();else if(mTab==='wallet')renderWallet();else if(mTab==='calendar')renderCalendar2();else if(mTab==='assistant'){if(mAssistAsk){if(!mChat.length)chatHello();else renderChat()}else renderAssistant()}else if(mTab==='stats')renderStats()}
  { const o=renderLoops;renderLoops=function(){o();renderMobile()} }
  { const o=renderTasks;renderTasks=function(){o();if(mq.matches&&(mTab==='home'||mTab==='inbox'||mTab==='assistant')){if(mTab==='home')renderHome();else if(mTab==='inbox')renderInbox();else if(!mAssistAsk)renderAssistant()}} }
  { const o=renderCategories;renderCategories=function(){o();if(mq.matches&&mTab==='inbox')renderInbox()} }
  // notification panel and a 'Widgets' view on the phone
  const notif=$('#notif-panel'),notifHome=notif?.parentElement;
  const placeNotif=()=>{if(!notif)return;if(mq.matches)document.body.append(notif);else notifHome?.append(notif)};
  mq.addEventListener?.('change',placeNotif);placeNotif();
  $('#customize')?.addEventListener('click',()=>{
    if(!mq.matches)return;
    document.body.classList.add('m-widgets');
    $$('.m-tabs [data-tab]').forEach(x=>x.classList.remove('on'));
    scrollTo(0,0);setTimeout(()=>dispatchEvent(new Event('resize')),60);
  });
  $$('.m-tabs [data-tab]').forEach(x=>x.addEventListener('click',()=>document.body.classList.remove('m-widgets')));
  setInterval(renderMobile,60000);
  applyMode();
  /* ---- V2 app (Today · Inbox · Plan · Money · Wallet) on top of the Item Graph. Classic view: ?ui=v1 or Settings → classic. ---- */
  (function mountV2UI(){
    const W=window;
    let classic=false;try{classic=/[?&]ui=v1\b/.test(location.search)||localStorage.getItem('daylight-ui')==='v1'}catch{}
    if(/[?&]ui=v2\b/.test(location.search)){try{localStorage.removeItem('daylight-ui')}catch{};classic=false}
    const off=()=>document.documentElement.classList.remove('v2boot');
    if(classic||DEMO||!W.DaylightV2UI||!W.DaylightV2Model)return off();
    let sample=false;try{sample=/[?&]v2sample=1\b/.test(location.search)||sessionStorage.getItem('daylight-v2-sample')==='1'}catch{}
    const core=v2Core();if(!core&&!sample)return off();
    const aiReady=()=>!!(W.DaylightAI?.getConsent?.()&&W.DaylightAI?.isEnabled?.()&&serverUrl&&serverSession);
    const host={
      connected:()=>Boolean(token||serverSession),
      profile:()=>identityVerified?readProfile():{},
      accountId:()=>{if(!identityVerified)return null;const p=readProfile();return (p.sub||p.email)?v2AccountKey():null},
      accountPending:()=>Boolean((token||serverSession)&&!identityVerified),
      connect:()=>connectDialog(),
      switchAccount(){if(serverUrl){const q=new URLSearchParams({return:location.origin+location.pathname,switch:'1'});location.href=serverUrl+'/auth/google/start?'+q.toString()}else connectDialog()},
      async disconnect(){await disconnectGoogle();return disconnectGoogle.lastReport||null},
      async syncNow(){refreshAll.force=true;await refreshAll()},
      syncState:()=>({busy:syncBusy,lastAt:lastSyncOk||0,error:lastSyncErr||''}),
      theme:{get:themePref,set:m=>applyThemePref(m)},
      openScanner:()=>{try{openScan()}catch(e){console.warn('scan',e)}},
      /* developer diagnostics: real counters from the mail cache (no estimates) */
      engineError:()=>{try{return identityVerified?JSON.parse(localStorage.getItem('daylight-v2-engine-error:'+v2AccountKey())||'null'):null}catch{return null}},
      grantedScopes:()=>{let b='';try{b=localStorage.getItem('daylight-google-scopes')||''}catch{};const all=b.split(/\s+/).filter(Boolean);const wanted=['openid','email','profile','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/gmail.readonly'];return {all,extra:all.filter(x=>!wanted.includes(x))}},
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
        if(!v2Enabled())return {engine:'legacy'};
        const v=getMailV2(),M=W.DaylightSyncMetrics,acct=v2AccountKey();
        const rows=await v.cache.metrics(acct).catch(()=>[]);const idx=await v.cache.all(acct).catch(()=>[]);const cp=await v.cache.getCheckpoint(acct).catch(()=>null)||{};
        const status={},cats={};idx.forEach(r=>{status[r.status]=(status[r.status]||0)+1;const l=r.labels||[];const c=l.includes('SENT')&&!l.some(x=>/^CATEGORY_/.test(x))?'sent':((l.find(x=>/^CATEGORY_/.test(x))||'CATEGORY_PERSONAL').replace('CATEGORY_','').toLowerCase().replace('personal','primary'));cats[c]=cats[c]||{indexed:0,skipped:0,bodies:0};cats[c].indexed++;if(r.status==='skipped')cats[c].skipped++;if(r.bodyFetched)cats[c].bodies++});
        const runs=rows.flatMap(r=>r.runs||[]).sort((a,b)=>b.at-a.at).slice(0,15);const skipped=idx.filter(r=>r.status==='skipped').map(r=>({id:r.messageId,labels:r.labels||[]})).sort((a,b)=>String(b.id).localeCompare(String(a.id)));const unresolved=idx.filter(r=>r.status==='meta-pending'||r.status==='body-queued').map(r=>({id:r.messageId,status:r.status,error:r.lastError||null,subject:r.subject||null}));let aiQ=0;try{aiQ=(await v.cache.aiQueue(acct)).length}catch{};let ingestLog=[];try{ingestLog=JSON.parse(localStorage.getItem('daylight-v2-ingest-log:'+acct)||'[]')}catch{};
        let engineError=null;try{engineError=JSON.parse(localStorage.getItem('daylight-v2-engine-error:'+acct)||'null')}catch{};
        return {engine:'v2',account:acct,engineError,runs,skipped,unresolved,aiQueue:aiQ,ingestLog,today:M?M.summarise(rows,{days:1}):null,week:M?M.summarise(rows,{days:7}):null,last:lastGmailReport?{at:lastGmailReport.at,discovery:lastGmailReport.discovery||null,units:lastGmailReport.units??null}:null,index:{total:idx.length,status,categories:cats},checkpoint:{windowDays:cp.windowDays||null,lastMode:cp.lastMode||null,lastFullAt:cp.lastFullAt||null},ingest:core&&core.lastIngest||null};
      },
      async deleteAll(){
        if(serverSession){try{await fetch(serverUrl+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+serverSession}})}catch{}}
        try{if(token&&W.google?.accounts?.oauth2?.revoke)W.google.accounts.oauth2.revoke(token,()=>{})}catch{}
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
})();
