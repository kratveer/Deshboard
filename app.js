// Daylight personal mode. Access tokens live in memory only; no Google data is sent to Daylight servers.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let tokenExpiry = 0;
  let token = null, tokenClient = null, microsoftApp = null, microsoftAccount = null;
  const providerData = { google:{events:null,mails:null,tasks:null}, microsoft:{events:null,mails:null,tasks:null} };
  let personalTasks = [];
  try { personalTasks = JSON.parse(localStorage.getItem('daylight-personal-tasks') || '[]'); if (!Array.isArray(personalTasks)) personalTasks=[]; } catch { personalTasks=[]; }
  const scopes = [
    'openid','email','profile',
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/tasks.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/contacts.readonly'
  ].join(' ');
  let googleGrantedScope='';
  const rememberGoogleScopes=s=>{
    googleGrantedScope=String(s||'');
    try{googleGrantedScope?localStorage.setItem('daylight-google-scopes',googleGrantedScope):localStorage.removeItem('daylight-google-scopes')}catch{}
  };
  const hasGmailSend=()=>{
    let stored='';try{stored=localStorage.getItem('daylight-google-scopes')||''}catch{}
    return /gmail\.send|gmail\.compose|gmail\.modify|mail\.google\.com/.test(googleGrantedScope||stored);
  };
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
      ${row('google','G','google-icon','Google',g?`<span class="dot"></span>${staying?'Connected · stays signed in':'Connected for about an hour'}${prof.email?' · '+esc(prof.email):''}`:'Calendar · Gmail · Tasks · Drive · Contacts',g,g?'<button class="connect ghost" id="google-disconnect" type="button">Disconnect</button>':(needsSetup?'':'<button class="connect primary" id="google-connect" type="button">Connect</button>'))}
      ${needsSetup||opts.setup?setupPanel:(!g?`<div class="google-setup" id="google-setup" hidden>
        <label class="client-label" for="client-id">Google Client ID <small>public · not a secret</small></label>
        <input class="client-input" id="client-id" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="123….apps.googleusercontent.com" value="${esc(savedId)}">
      </div>`:`<input id="client-id" type="hidden" value="${esc(savedId)}">`)}
      ${row('microsoft','M','ms-icon','Microsoft 365',ms?'<span class="dot"></span>Connected':'Outlook · Calendar · To Do',ms,ms?'<button class="connect ghost" id="microsoft-disconnect" type="button">Disconnect</button>':`<button class="connect ${msReady?'primary':''}" id="microsoft-connect" type="button">${msReady?'Connect':'Set up'}</button>`)}
      <div id="connect-error" class="error" role="alert" hidden></div>
      <details class="conn-more"><summary>What Daylight can see</summary><ul class="conn-list"><li>Today’s calendar events</li><li>Recent Gmail senders, subjects, and (when you open a thread) message text used for replies</li><li>Send replies you write in Daylight through your Gmail account</li><li>Open tasks, recently opened Drive file names, and contact birthdays</li><li>Access tokens stay in this browser’s memory (or your optional Daylight server). Nothing is uploaded to Daylight’s product servers for analysis.</li></ul><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></details>
      ${g&&!hasGmailSend()?`<div class="error" role="status" style="margin-top:10px">Reply needs a one-time reconnect so Google can grant <b>gmail.send</b>. Disconnect and Connect again, then approve sending.</div>`:''}
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
    $('#overlay').classList.add('show');
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
          <b>${esc(name)}</b> · ${esc(p.mode||'—')} · ${p.lastError?'<span style="color:#c0392b">error</span>':'ok'}
          <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.45">
            last ok ${esc(fmtWhen(p.lastSuccessAt))} · fail ${esc(fmtWhen(p.lastFailureAt))}<br>
            fetched ${p.fetched||0} · in ${p.inserted||0} · up ${p.updated||0} · del ${p.deleted||0} · retries ${p.retries||0} · ${p.lastDurationMs||0}ms · runs ${p.runs||0}<br>
            cursor ${esc(p.cursor?String(p.cursor).slice(0,28)+(String(p.cursor).length>28?'…':''):'—')}
            ${p.lastError?`<br>err ${esc(p.lastError)}`:''}
          </div></div>`;
        body.innerHTML=`<div style="font-size:12px;line-height:1.5;margin-bottom:6px">
          <b>Account</b> ${esc(acct?.displayName||acctId)} · ${esc(acct?.email||acct?.kind||'')}<br>
          <span style="color:var(--muted)">${esc(acct?.providerAccountKey||'')} · schema v${st.schema}</span><br>
          store · entities ${st.entities||0} · rel ${st.relationships||0} · facts ${st.facts||0} · actions ${st.actions||0}
        </div>
        ${row('Gmail',sync.gmail||{})}${row('Calendar',sync.calendar||{})}${row('Tasks',sync.tasks||{})}${row('Hydrate',sync.hydrate||{})}`;
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
    const startGoogle=()=>{if(!saveAdvanced())return;
      localStorage.removeItem('daylight-demo');
      if(serverUrl){location.href=serverUrl+'/auth/google/start?return='+encodeURIComponent(location.origin+location.pathname);return}
      const id=readClientId();
      if(!id){err('Paste your Google Client ID first (ends with .apps.googleusercontent.com).');($('#client-id')||$('#client-id-adv'))?.focus();return}
      if(!id.endsWith('.apps.googleusercontent.com')){err('That doesn’t look like a Client ID. It should end with .apps.googleusercontent.com');return}
      authorize(id)};
    $$('#google-connect').forEach(b=>b.onclick=startGoogle);
    $('#client-id')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();startGoogle()}});
    if($('#google-disconnect'))$('#google-disconnect').onclick=disconnectGoogle;
    if($('#microsoft-connect'))$('#microsoft-connect').onclick=()=>{saveAdvanced();if(!$('#ms-client-id').value.trim()){$('#conn-advanced').open=true;err('Add your Microsoft application ID under Optional setup first.');return}authorizeMicrosoft()};
    if($('#microsoft-disconnect'))$('#microsoft-disconnect').onclick=async()=>{try{await microsoftApp?.clearCache({account:microsoftAccount})}catch{}microsoftAccount=null;microsoftApp=null;providerData.microsoft={events:null,mails:null,tasks:null};renderAll();$('#connections').classList.toggle('active',Boolean(token));connectDialog();toast('Microsoft disconnected')};
    if(opts.focusId)requestAnimationFrame(()=>$('#client-id')?.focus());
  }
  async function disconnectGoogle(){
    if(serverSession){try{await fetch(serverUrl+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+serverSession}})}catch{}serverSession='';setLS('daylight-session','');clearTimeout(serverRenew)}
    token=null;rememberGoogleScopes('');providerData.google={events:null,mails:null,tasks:null};loopsData=null;renderAll();clearProfile();
    try{
      const Store=window.DaylightStore;
      if(Store?.clearAccountData){
        const acctId=await Store.getActiveAccountId?.();
        if(acctId)await Store.clearAccountData(acctId);
      }else await Store?.clearProviderData?.();
    }catch{}
    $('#sync-status').textContent=microsoftAccount?'Google disconnected · Microsoft still connected':'Not connected';
    $('#connections').classList.toggle('active',Boolean(microsoftAccount));
    if($('#overlay').classList.contains('show'))connectDialog();toast('Google disconnected');
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
      if(token){const u=await api('https://www.googleapis.com/oauth2/v3/userinfo');if(u.name||u.picture||u.email||u.sub){setLS('daylight-profile',JSON.stringify({name:u.name||'',picture:u.picture||'',email:u.email||'',sub:u.sub||''}));renderProfile();try{await ensureDaylightAccountFromProfile('google',u)}catch(e){console.warn('account upsert',e)}return}}
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
  function authorize(clientId) {
    clientId=(clientId||$('#client-id')?.value||localStorage.getItem('daylight-client-id')||'').trim().replace(/\s+/g,'');
    const errBox=m=>{const el=$('#connect-error');if(el){el.hidden=!m;el.textContent=m||''}else if(m)toast(m)};
    if(!clientId.endsWith('.apps.googleusercontent.com')) { errBox('Enter your Google Client ID first (ends with .apps.googleusercontent.com).'); return; }
    localStorage.setItem('daylight-client-id',clientId);
    if(!window.google?.accounts?.oauth2) { errBox('Google sign-in is still loading. Try again in a moment.'); return; }
    errBox('');
    tokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:scopes,include_granted_scopes:true,callback:async response=>{
      if(response.error){errBox(googleAuthError(response.error));return;}
      if(!response.access_token){errBox('Google did not return access. Try Connect again.');return;}
      token=response.access_token;
      rememberGoogleScopes(response.scope||scopes);
      $('#overlay').classList.remove('show');$('#connections').classList.add('active');$('#sync-status').textContent='Google connected · refreshing…';
      setTimeout(()=>{token=null;$('#connections').classList.remove('active');$('#sync-status').textContent='Google access expired · reconnect to refresh';},Math.max(0,(Number(response.expires_in||3600)-60)*1000));
      try{await refreshAll();toast(hasGmailSend()?'Google connected · replies enabled':'Google connected · reconnect later to enable sending');}catch(e){toast('Connected, but some data failed to load');}
    },error_callback:e=>{errBox(googleAuthError(e?.type||e?.message||'popup_closed_by_user'))}});
    try{tokenClient.requestAccessToken({prompt:'consent'})}
    catch(e){errBox(googleAuthError(e?.message||'invalid_request'))}
  }
  function requestGmailSendAccess(){
    const clientId=(localStorage.getItem('daylight-client-id')||'').trim();
    if(serverUrl&&serverSession){toast('Reconnect Google from Connections to grant send access',{type:'warn'});connectDialog({setup:false});return}
    if(!clientId){toast('Connect Google first',{type:'warn'});connectDialog({setup:true,focusId:true});return}
    authorize(clientId);
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
    opts=opts||{};
    if(serverSession&&Date.now()>tokenExpiry-60000)await serverToken();
    if(!token)throw new Error('Google is not connected');
    const init={method:opts.method||'GET',headers:{Authorization:`Bearer ${token}`}};
    if(opts.body!=null){init.headers['Content-Type']='application/json';init.body=typeof opts.body==='string'?opts.body:JSON.stringify(opts.body)}
    const r=await fetch(url,init);
    if(r.status===401&&serverSession&&!retried&&await serverToken())return api(url,opts,true);
    if(!r.ok){let detail='',code='';try{const j=await r.json();detail=j.error?.message||'';code=j.error?.status||j.error?.errors?.[0]?.reason||''}catch{}const err=new Error(detail||`Google API error (${r.status})`);err.status=r.status;err.code=code;throw err}
    if(r.status===204)return null;
    const text=await r.text();if(!text)return null;
    try{return JSON.parse(text)}catch{return text}
  }
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
    const u=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');u.searchParams.set('timeMin',iso(localMidnight));u.searchParams.set('timeMax',iso(tomorrow));u.searchParams.set('singleEvents','true');u.searchParams.set('orderBy','startTime');u.searchParams.set('maxResults','12');
    const data=await api(u);providerData.google.events=(data.items||[]).map(e=>({...e,source:'Google Calendar'}));renderCalendar();
    return providerData.google.events.length;
  }
  async function loadMail(){
    const list=await api('https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10');const items=list.messages||[];
    const msgs=await Promise.all(items.map(m=>api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    providerData.google.mails=msgs.map(m=>{const h=m.payload?.headers||[];const from=header(h,'From');const sender=from.replace(/<.*?>/,'').replace(/"/g,'').trim()||from;const when=header(h,'Date');const d=when?new Date(when):null;return {sender,subject:header(h,'Subject')||'(No subject)',time:d?d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'',sortDate:d?.getTime()||0,unread:m.labelIds?.includes('UNREAD'),initials:sender.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'G',source:'Gmail'}});renderMail();
    return providerData.google.mails.length;
  }
  async function loadTasks(){
    const t0=Date.now();let retries=0;
    let lists;
    try{
      const r=await apiRetry('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=5');lists=r.data;retries+=r.retries;
    }catch(e){
      try{const Store=window.DaylightStore;const acct=await Store?.getActiveAccountId?.();if(Store&&acct)await Store.recordSyncFailure('tasks',e,{retries,mode:'full'},acct)}catch{}
      throw e;
    }
    const groups=await Promise.all((lists.items||[]).slice(0,3).map(async l=>{
      const r=await apiRetry(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=20`);
      retries+=r.retries;return r.data;
    }));
    providerData.google.tasks=groups.flatMap((g,i)=>(g.items||[]).filter(t=>t.status!=='completed').map(t=>({id:t.id,title:t.title,due:t.due?new Date(t.due).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'',dueDate:t.due||'',listName:lists.items[i].title,source:'Google Tasks'}))).slice(0,8);renderTasks();
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
  async function refreshAll(){
    if(!token&&!microsoftAccount){if(DEMO){await loadLoops(true);renderCategories();renderSmart()}return}
    $('#sync-status').textContent=`Connected to ${[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean).join(' and ')} · refreshing…`;
    const jobs=[];if(token)jobs.push(loadCalendar(),loadMail(),loadTasks(),loadDrive(),loadBirthdays(),loadLoops(refreshAll.force));refreshAll.force=false;loadProfile();if(microsoftAccount)jobs.push(loadMicrosoftCalendar(),loadMicrosoftMail(),loadMicrosoftTasks());
    const results=await Promise.allSettled(jobs);const failed=results.filter(r=>r.status==='rejected');renderAll();renderCategories();
    const eventCount=(providerData.google.events||[]).length+(providerData.microsoft.events||[]).length,mailCount=(providerData.google.mails||[]).length+(providerData.microsoft.mails||[]).length,taskCount=(providerData.google.tasks||[]).length+(providerData.microsoft.tasks||[]).length;
    const cats=computeCategories();
    const money=cats.money||computeMoney();
    $('#headline-note').innerHTML=`Today: <b>${eventCount} events</b> · <b>${cats.pending.length} pending</b> · <b>${money.counts.total} money</b> · <b>${loopsData?computeLoops().length:0} loops</b>`;
    $('#sync-status').textContent=failed.length?`Some connected data could not load · ${failed.map(x=>x.reason.message).join('; ')}`:`Connected to ${[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean).join(' and ')} · updated ${new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
    if(failed.length)toast('Some services need permission or API setup; check the status line.');
  }
  $('#refresh').onclick=()=>{if(token||microsoftAccount){refreshAll.force=true;refreshAll()}else toast('Connect an app first to refresh live data.')};
  $('#weather-connect').onclick=()=>{
    if(!navigator.geolocation){$('#weather-content').textContent='Location is unavailable in this browser.';return}
    $('#weather-content').textContent='Waiting for location permission…';navigator.geolocation.getCurrentPosition(async pos=>{try{const {latitude,longitude}=pos.coords;const u=`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;const w=await(await fetch(u)).json();const names={0:'Clear sky',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',61:'Rain',63:'Rain',65:'Heavy rain',71:'Snow',80:'Showers',95:'Thunderstorm'};$('#weather-content').innerHTML=`<div class="weather-temp">${Math.round(w.current.temperature_2m)}°</div><div class="weather-label">${esc(names[w.current.weather_code]||'Current conditions')}</div><div class="weather-range">Feels like ${Math.round(w.current.apparent_temperature)}° · H ${Math.round(w.daily.temperature_2m_max[0])}° / L ${Math.round(w.daily.temperature_2m_min[0])}°</div>`;$('#weather-connect').textContent='Refresh';}catch(e){$('#weather-content').textContent='Weather could not be loaded. Try again.'}},()=>{$('#weather-content').textContent='Location permission was not granted. You can allow it in browser settings.'},{enableHighAccuracy:false,timeout:10000});
  };
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&(token||microsoftAccount))refreshAll()});
  const clientId=localStorage.getItem('daylight-client-id');if(clientId){$('#sync-status').textContent='Google setup saved · connect to grant access';}
  // ---- Today timeline + free-time finder (runs on data already loaded; nothing leaves the browser) ----
  let DAY_START=8, DAY_END=20;const MIN_GAP=25;
  try{const h=JSON.parse(localStorage.getItem('daylight-hours')||'null');if(h&&h.end>h.start&&h.start>=0&&h.end<=23){DAY_START=h.start;DAY_END=h.end}}catch{}
  var insightsQueued=false;
  function queueInsights(){if(insightsQueued)return;insightsQueued=true;setTimeout(()=>{insightsQueued=false;renderInsights()},0)}
  const hm=d=>d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  function todayEvents(){
    const all=[...(providerData.google.events||[]),...(providerData.microsoft.events||[])];
    const timed=[],allDay=[];
    all.forEach(e=>{
      if(e.start?.dateTime){
        const tz=e.start.timeZone==='UTC'&&!/[zZ]|[+-]\d\d:?\d\d$/.test(e.start.dateTime);// Graph returns UTC without suffix
        const st=new Date(e.start.dateTime+(tz?'Z':'')),en=new Date((e.end?.dateTime||e.start.dateTime)+(tz?'Z':''));
        if(en>localMidnight&&st<tomorrow)timed.push({title:e.summary||e.subject||'(No title)',start:st,end:en>st?en:new Date(st.getTime()+30*60000)});
      } else if(e.start?.date||e.isAllDay) allDay.push(e.summary||e.subject||'(No title)');
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
  const SERVER_ERRORS={account_not_allowed:'That Google account is not allowed on your Daylight server. Add it to ALLOWED_EMAILS.',access_denied:'Google sign-in was cancelled.',no_refresh_token:'Google did not grant offline access. Try “Stay signed in” again.',token_exchange_failed:'Google sign-in could not be completed. Check the server’s client ID, secret and redirect URI.'};
  const getLS=k=>{try{return localStorage.getItem(k)||''}catch{return''}},setLS=(k,v)=>{try{v?localStorage.setItem(k,v):localStorage.removeItem(k)}catch{}};
  let serverUrl=(getLS('daylight-api')||(location.hostname==='kratveer.github.io'?'https://daylight-api.kratveer050.workers.dev':'')).replace(/\/+$/,''),serverSession=getLS('daylight-session'),serverEmail='',serverRenew=null,serverTokenPromise=null;
  // Pick up the session (or an error) the server hands back after Google sign-in.
  (()=>{if(!location.hash.includes('daylight_'))return;const h=new URLSearchParams(location.hash.slice(1));
    if(h.get('daylight_session')){serverSession=h.get('daylight_session');setLS('daylight-session',serverSession);toast('Signed in · Daylight will keep you connected')}
    if(h.get('daylight_error'))setTimeout(()=>{$('#sync-status').textContent=SERVER_ERRORS[h.get('daylight_error')]||'Server sign-in failed: '+h.get('daylight_error');toast('Google sign-in did not finish')},0);
    history.replaceState(null,'',location.pathname+location.search)})();
  async function serverToken(){
    if(!serverUrl||!serverSession)return false;
    if(serverTokenPromise)return serverTokenPromise;
    serverTokenPromise=(async()=>{try{
      const r=await fetch(serverUrl+'/api/google/token',{method:'POST',headers:{Authorization:'Bearer '+serverSession}});
      if(r.status===401){serverSession='';setLS('daylight-session','');token=null;$('#connections').classList.toggle('active',Boolean(microsoftAccount));$('#sync-status').textContent='Google sign-in expired · open connections and choose Stay signed in';return false}
      if(!r.ok)throw new Error('server '+r.status);
      const d=await r.json();token=d.access_token;serverEmail=d.email||'';tokenExpiry=Date.now()+(Number(d.expires_in)||3600)*1000;
      if(d.scope)rememberGoogleScopes(d.scope);
      $('#connections').classList.add('active');clearTimeout(serverRenew);serverRenew=setTimeout(serverToken,Math.max(60,(Number(d.expires_in)||3600)-180)*1000);return true;
    }catch(e){$('#sync-status').textContent='Could not reach your Daylight server · retrying soon';clearTimeout(serverRenew);serverRenew=setTimeout(serverToken,120000);return false}
    finally{serverTokenPromise=null}})();
    return serverTokenPromise;
  }
  renderProfile();$('#profile')?.addEventListener('click',connectDialog);
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
  const AUTOMATED=/(no-?reply|do-?not-?reply|notification|newsletter|mailer|bounce|^updates?@|^news@|^info@|marketing|^hello@|^team@|^support@|^billing@|^receipts?@|^account@|^alerts?@)/i;
  const RENEWAL=/\b(renew(al|s|ing)?|subscription|subscribed|membership|trial (ends|ending|expires)|expir(es|ing|ation)|auto-?renew)\b/i;
  const PENDING_PAY=/\b(payment (due|failed|reminder|declined)|past due|overdue (bill|payment)|action required.*(pay|bill)|unpaid|failed payment|pay now|outstanding balance|dlužn|nezaplacen|platba (po|je) splatnosti)\b/i;
  const BILL=/\b(invoice|bill(ing)?|statement|utilities?|electric|gas bill|water bill|internet bill|phone bill|faktura|vyúčtování|inkaso|složenka|předpis)\b/i;
  const STORE_PAY=/\b(order|purchase|bought|shipped|delivered|pickup|in[- ]store|receipt from|your (order|purchase)|objednávka|zalando|amazon|ikea|lidl|tesco|albert|rossmann|dm drogerie|alza|mediamarkt|notino|aboutyou)\b/i;
  const ONLINE_PAY=/\b(paypal|stripe|apple pay|google pay|card ending|charged|payment received|payment confirm|sepa|iban|wise|revolut|sumup|platba (proběhla|přijata)|úhrada)\b/i;
  const MONEY=/\b(renew(al|s|ing)?|subscription|subscribed|membership|trial|expir|payment|invoice|receipt|bill(ing)?|auto-?renew|charged|statement|paypal|stripe|sepa|order|purchase|faktura|platba|předplatné|vyúčtování|účet|premium|plan)\b/i;
  const MONEY_DOMAIN=/(netflix|spotify|adobe|paypal|stripe|apple\.com|google\.com|amazon|zalando|microsoft|openai|cursor\.|github|notion|figma|dropbox|icloud|youtube|disney|hbo|skyshowtime|vodafone|o2|t-mobile|cez\.|innogy|pre\.cz|upc|vodafone|airbank|revolut|wise|csob|kb\.cz|moneta|fio\.|twilio|vercel|railway|digitalocean|hetzner|namecheap|godaddy|shopify)/i;
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
    if(PENDING_PAY.test(text)||/\bpayment due\b/i.test(text)||/\b(pay|zapla[tť]).{0,20}(tuition|school|fees?|poplat|školn)/i.test(text))return 'pending';
    if(RENEWAL.test(text)||/\bpředplatn/i.test(text)||/\b(premium|pro plan|your plan)\b/i.test(text))return 'subscription';
    if(BILL.test(text))return 'bill';
    if(STORE_PAY.test(text))return 'store';
    if(ONLINE_PAY.test(text)||/\breceipt\b/i.test(text)||/\bpotvrzení (platby|objednávky)\b/i.test(text))return 'online';
    if(MONEY_DOMAIN.test(from)&&MONEY.test(text))return RENEWAL.test(text)?'subscription':'online';
    if(MONEY_DOMAIN.test(from))return 'online';
    if(MONEY.test(text))return 'online';
    return null;
  }
  var loopsData=null,loopsFetched=0,loopsShowAll=false;
  const loopState=()=>readJSON('daylight-loops',{});
  const saveLoopState=s=>{const now=Date.now();Object.keys(s).forEach(k=>{if(s[k].t&&now-s[k].t>30*86400000)delete s[k]});writeJSON('daylight-loops',s)};
  const parseFrom=v=>{const m=/^\s*"?([^"<]*)"?\s*<([^>]+)>/.exec(v||'');return m?{name:m[1].trim()||m[2],email:m[2].toLowerCase()}:{name:(v||'').trim(),email:(v||'').trim().toLowerCase()}};
  const gmailLink=id=>`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
  async function apiRetry(url,opts,maxAttempts=3){
    let lastErr=null,retries=0;
    for(let attempt=0;attempt<maxAttempts;attempt++){
      try{return {data:await api(url,opts),retries}}
      catch(e){
        lastErr=e;retries=attempt;
        const st=e.status||0;
        const retryable=st===429||st===500||st===502||st===503||st===504||!st;
        if(!retryable||attempt===maxAttempts-1)break;
        await new Promise(r=>setTimeout(r,Math.min(4000,350*Math.pow(2,attempt))+Math.random()*120));
      }
    }
    throw lastErr||new Error('Request failed');
  }
  async function loadLoops(force){
    if(!token){if(DEMO){loopsData=demoLoopsData();loopsFetched=Date.now();try{runCrossAppIntelligence()}catch(e){console.warn('intel',e)};queueDaylightHydrate();renderLoops();renderCategories();if(typeof renderInbox==='function')renderInbox();return computeLoops().length}return 0}
    if(!force&&loopsData&&Date.now()-loopsFetched<3*60000){renderLoops();renderCategories();if(typeof renderInbox==='function')renderInbox();return 0}
    const Store=window.DaylightStore;
    const accountId=Store?await Store.getActiveAccountId().catch(()=>null):null;
    const syncPrev=Store&&accountId?await Store.getSyncState(accountId).catch(()=>null):null;
    const t0=Date.now();
    let gmailRetries=0,calRetries=0,gmailMode='full',calMode='full';
    const G='https://gmail.googleapis.com/gmail/v1/users/me';
    const meta=id=>apiRetry(`${G}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`).then(r=>r.data);
    const listMeta=async (qs,n=12,pages=2)=>{
      try{
        const out=[];let pageToken='';
        for(let p=0;p<pages&&out.length<n;p++){
          const u=`${G}/messages?${qs}&maxResults=${Math.min(50,n-out.length)}${pageToken?'&pageToken='+encodeURIComponent(pageToken):''}`;
          const {data:r,retries}=await apiRetry(u);gmailRetries+=retries;
          const ids=r.messages||[];if(!ids.length)break;
          const batch=await Promise.all(ids.map(m=>meta(m.id).catch(()=>null)));
          batch.filter(Boolean).forEach(m=>out.push(m));
          pageToken=r.nextPageToken||'';if(!pageToken)break;
        }
        return out;
      }catch(e){console.warn('gmail list',qs,e);try{if(Store&&accountId)await Store.recordSyncFailure('gmail',e,{retries:gmailRetries,mode:gmailMode},accountId)}catch{}return[]}
    };
    const moneyQ=[
      'newer_than:120d (subscription OR renew OR renewal OR invoice OR billing OR receipt OR payment OR paid OR charged OR trial OR membership OR premium OR paypal OR stripe OR order OR purchase OR faktura OR platba OR předplatné)',
      'newer_than:120d category:purchases',
      'newer_than:90d category:updates (bill OR invoice OR payment OR receipt OR renew OR subscription OR faktura OR platba)',
      'newer_than:180d (from:paypal.com OR from:stripe.com OR from:apple.com OR from:amazon.com OR from:netflix.com OR from:spotify.com OR from:adobe.com OR from:google.com OR from:microsoft.com OR from:cursor.com OR from:openai.com)'
    ];
    // Optional Gmail history probe: if historyId valid, still refresh search windows (queries catch old mail); cursor advances for diagnostics/recovery
    let historyId=syncPrev?.gmail?.cursor||null;
    try{
      const {data:prof,retries}=await apiRetry(`${G}/profile`);gmailRetries+=retries;
      if(prof?.historyId){
        if(historyId&&historyId!==prof.historyId){
          try{
            const {data:hist,retries:hr}=await apiRetry(`${G}/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&maxResults=50`);
            gmailRetries+=hr;gmailMode='incremental+full';
            // Touch newly added ids so they enter the pool even if outside search windows
            const added=(hist.history||[]).flatMap(h=>(h.messagesAdded||[]).map(x=>x.message)).filter(m=>m?.id).slice(0,20);
            if(added.length){
              const extras=await Promise.all(added.map(m=>meta(m.id).catch(()=>null)));
              extras.filter(Boolean).forEach(m=>{m._fromHistory=true});
              listMeta._historyExtras=extras.filter(Boolean);
            }
            if(hist.historyId)historyId=hist.historyId;
          }catch(e){
            // 404 = cursor expired → full recovery
            if(e.status===404||e.status===410){historyId=prof.historyId;gmailMode='full-recovery'}
            else historyId=prof.historyId;
          }
        }else historyId=prof.historyId;
      }
    }catch{}
    const [inbox,moneyA,moneyB,moneyC,moneyD,travelMail,docsMail,sent]=await Promise.all([
      listMeta('labelIds=INBOX',50,2),
      listMeta('q='+encodeURIComponent(moneyQ[0]),30,2),
      listMeta('q='+encodeURIComponent(moneyQ[1]),20,1),
      listMeta('q='+encodeURIComponent(moneyQ[2]),20,1),
      listMeta('q='+encodeURIComponent(moneyQ[3]),25,1),
      listMeta('q='+encodeURIComponent('(flight OR train OR booking OR itinerary OR "boarding pass" OR hotel OR reservation OR e-ticket) newer_than:45d'),15,1),
      listMeta('q='+encodeURIComponent('(document OR contract OR agreement OR signed OR insurance OR passport OR visa OR pdf OR tax) newer_than:45d has:attachment'),12,1),
      apiRetry(`${G}/messages?labelIds=SENT&maxResults=15`).then(r=>r.data).catch(()=>({messages:[]}))
    ]);
    const financeMail=[...moneyA,...moneyB,...moneyC,...moneyD];
    const byId=new Map();[...(listMeta._historyExtras||[]),...inbox,...financeMail,...travelMail,...docsMail].forEach(m=>{if(m?.id)byId.set(m.id,m)});
    const threadIds=[...new Set((sent.messages||[]).map(m=>m.threadId))].slice(0,12);
    const threads=await Promise.all(threadIds.map(t=>apiRetry(`${G}/threads/${encodeURIComponent(t)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`).then(r=>r.data).catch(()=>null)));
    // Calendar: prefer syncToken when present; recover on 410
    let upcoming=[],calCursor=syncPrev?.calendar?.cursor||null;
    try{
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
    loopsData={inbox:[...byId.values()],financeMail,travelMail,docsMail,threads:threads.filter(Boolean),upcoming,files:{},scanned:byId.size,financeHits:financeMail.length};
    const meetings=upcoming.filter(e=>(e.attendees||[]).length>1&&e.start?.dateTime&&new Date(e.start.dateTime)<new Date(localMidnight.getTime()+2*86400000)).slice(0,3);
    await Promise.all(meetings.map(async e=>{const word=(e.summary||'').split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=5).sort((a,b)=>b.length-a.length)[0];if(!word)return;
      try{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',`name contains '${word.replace(/'/g,"\\'")}' and trashed=false`);u.searchParams.set('pageSize','1');u.searchParams.set('orderBy','modifiedTime desc');u.searchParams.set('fields','files(name,webViewLink)');
        const f=(await apiRetry(u).then(r=>r.data)).files?.[0];if(f)loopsData.files[e.id]=f}catch{}}));
    loopsFetched=Date.now();
    try{runCrossAppIntelligence()}catch(e){console.warn('intel',e)}
    if(Store&&accountId){
      try{
        await Store.recordSyncSuccess('gmail',{durationMs:Date.now()-t0,retries:gmailRetries,fetched:byId.size,cursor:historyId,mode:gmailMode},accountId);
        await Store.recordSyncSuccess('calendar',{durationMs:Date.now()-t0,retries:calRetries,fetched:upcoming.length,cursor:calCursor,mode:calMode},accountId);
      }catch(e){console.warn('sync meta',e)}
    }
    queueDaylightHydrate();
    renderLoops();renderCategories();if(typeof renderInbox==='function')renderInbox();if(typeof renderWallet==='function'&&mq?.matches&&mTab==='wallet')renderWallet();
    return computeLoops().length;
  }
  function demoLoopsData(){
    const days=n=>new Date(Date.now()-n*86400000).toISOString();
    const mail=(id,from,subject,agoDays,labels=['INBOX','UNREAD'])=>({id,threadId:id,labelIds:labels,internalDate:String(Date.now()-agoDays*86400000),payload:{headers:[{name:'From',value:from},{name:'Subject',value:subject},{name:'Date',value:days(agoDays)}]}});
    const ev=(id,summary,inDays,loc='')=>({id,summary,htmlLink:'#',location:loc,start:{dateTime:new Date(localMidnight.getTime()+inDays*86400000+10*3600000).toISOString()},end:{dateTime:new Date(localMidnight.getTime()+inDays*86400000+11*3600000).toISOString()},attendees:[{email:'a@x.com'},{email:'b@x.com'}]});
    const money=[
        mail('d1','Netflix <noreply@netflix.com>','Your Netflix subscription renews on Mar 15 · $19.99',2,['INBOX','CATEGORY_UPDATES']),
      mail('d2','Spotify <no-reply@spotify.com>','Spotify Premium renews soon · $4.99',5,['INBOX','CATEGORY_UPDATES']),
      mail('d7','Adobe <noreply@adobe.com>','Adobe Creative Cloud membership — payment due $59.99',1,['INBOX','IMPORTANT','UNREAD']),
      mail('d8','Vodafone <billing@vodafone.cz>','Your Vodafone bill for February is ready · 499 Kč',3,['INBOX','CATEGORY_UPDATES']),
      mail('d9','ČEZ <noreply@cez.cz>','Electricity invoice — payment due by Mar 12 · 1 240 Kč',4,['INBOX']),
      mail('d10','Amazon <auto-confirm@amazon.com>','Your Amazon order has shipped · $42.10',1,['INBOX','CATEGORY_UPDATES']),
      mail('d11','Zalando <no-reply@zalando.com>','Receipt for your Zalando purchase · €68.00',6,['INBOX','CATEGORY_UPDATES']),
      mail('d12','PayPal <service@paypal.com>','You paid €24.90 via PayPal',2,['INBOX','CATEGORY_UPDATES']),
      mail('d13','Apple <no_reply@email.apple.com>','Receipt from Apple — App Store · $15.99',7,['INBOX','CATEGORY_UPDATES']),
      mail('d14','Cursor <noreply@cursor.com>','Cursor Pro free trial renews on Mar 9 · $15.99',0.5,['INBOX','CATEGORY_UPDATES'])
    ];
    return {
      inbox:[
        ...money,
        mail('d3','Deutsche Bahn <noreply@bahn.de>','Your train ticket: Berlin → Prague',1,['INBOX','IMPORTANT']),
        mail('d4','Lufthansa <noreply@lufthansa.com>','Boarding pass · LH 1234 Munich–Lisbon',3,['INBOX']),
        mail('d5','Ana <ana@uni.cz>','Quick question about Friday’s lab',0.3,['INBOX','UNREAD','CATEGORY_PERSONAL']),
        mail('d6','HR Portal <docs@company.com>','Please sign: internship agreement PDF',4,['INBOX','UNREAD'])
      ],
      financeMail:money,travelMail:[],docsMail:[],threads:[],
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
        if(RENEWAL.test(subject)&&age<30*day){add('renewal',m.threadId,`Review: ${subject}`,`From ${from.name}`,ago(when),gmailLink(m.threadId),{...mailExtra,category:'Renewal / Billing'});return}
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
    [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[]),...personalTasks.filter(t=>t.dueDate).map(t=>({...t,source:'Daylight'}))].forEach((t,i)=>{if(!t.dueDate)return;const d=dueDay(t.dueDate),href=t.source==='Daylight'?'':t.source==='Microsoft To Do'?'https://to-do.office.com/':'https://tasks.google.com/';
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
  const MONEY_LABEL={subscription:'Subscription',bill:'Bill',store:'Store',online:'Online',pending:'Pending'};
  function moneyFromMail(m){
    const h=m.payload?.headers||[],from=parseFrom(header(h,'From')),subject=header(h,'Subject')||'(No subject)',when=new Date(header(h,'Date')||m.internalDate*1);
    const kind=moneyKind(subject,from.name+' '+from.email);if(!kind)return null;
    const renew=parseMoneyWhen(subject,when);
    const amt=(subject.match(/(?:€|EUR|USD|\$|Kč|CZK)\s?[\d\s.,]+|\d[\d\s.,]*\s?(?:€|EUR|USD|\$|Kč|CZK)/i)||[])[0]?.replace(/\s+/g,' ').trim();
    const brand=from.name.replace(/\s*(billing|noreply|no-?reply|receipts?|support|service)\s*/ig,' ').replace(/\s+/g,' ').trim()||from.email.split('@')[0];
    const subline=kind==='subscription'
      ?(renew.received?`From ${brand}`:`Renews ${renew.label||'soon'}`)+(amt?` · ${amt}`:'')
      :kind==='pending'?`Payment pending${amt?' · '+amt:''}`
      :kind==='bill'?`Bill from ${brand}${amt?' · '+amt:''}`
      :kind==='store'?`Store purchase${amt?' · '+amt:''}`
      :`Online payment${amt?' · '+amt:''}`;
    const domain=brandDomain(from.email,brand);
    return {id:m.threadId||m.id,mailId:m.id,title:brand,subject,detail:subline,from:brand,fromName:from.name,fromEmail:from.email,domain,logo:brandLogoUrls(domain)[0]||'',meta:renew.label||ago(when),href:gmailLink(m.threadId||m.id),when:renew.sort||when.getTime(),whenMs:when.getTime(),kind,tag:MONEY_LABEL[kind]||'Money',urgent:!!renew.urgent||kind==='pending',amount:amt||'',color:brandColor(brand),received:!!renew.received,snippet:m.snippet||''};
  }
  function computeMoney(){
    const groups={subscription:[],bill:[],store:[],online:[],pending:[]},seen=new Set(),now=Date.now(),day=86400000;
    const mails=loopsData?[...(loopsData.inbox||[]),...(loopsData.financeMail||[])]:[];
    const uniq=new Map();mails.forEach(m=>{if(m?.id)uniq.set(m.id,m)});
    uniq.forEach(m=>{
      const age=now-new Date((m.payload?.headers&&header(m.payload.headers,'Date'))||m.internalDate*1);
      if(age>180*day)return;
      const item=moneyFromMail(m);if(!item||seen.has(item.id))return;seen.add(item.id);
      (groups[item.kind]||groups.online).push(item);
    });
    // Payment-like tasks (tuition, bills) also belong in Inbox
    const dueDay=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[]),...personalTasks].forEach((t,i)=>{
      const title=t.title||'';if(!MONEY.test(title)&&!PENDING_PAY.test(title)&&!/\b(fee|tuition|rent|školn|nájem|poplat)/i.test(title))return;
      const id='task-money:'+(t.id||title)+i;if(seen.has(id))return;seen.add(id);
      const d=t.dueDate?dueDay(t.dueDate):null,urgent=!d||d<=new Date(localMidnight.getTime()+7*day);
      const item={id,title:title.replace(/^(pay|reschedule:)\s*/i,'').trim()||title,subject:title,detail:t.listName||t.source||'Task',from:t.listName||'Task',meta:d?d.toLocaleDateString(undefined,{day:'numeric',month:'short'}):(t.due||'Open'),href:t.source==='Microsoft To Do'?'https://to-do.office.com/':t.source==='Google Tasks'?'https://tasks.google.com/':'',when:d?d.getTime():now,kind:'pending',tag:'Pending',urgent,amount:'',color:brandColor(title),received:false};
      groups.pending.push(item);
    });
    const byUrg=(a,b)=>(b.urgent-a.urgent)||(a.when||0)-(b.when||0)||a.title.localeCompare(b.title);
    Object.keys(groups).forEach(k=>groups[k].sort(byUrg));
    const all=[...groups.pending,...groups.subscription,...groups.bill,...groups.store,...groups.online];
    return {...groups,all,counts:{subscription:groups.subscription.length,bill:groups.bill.length,store:groups.store.length,online:groups.online.length,pending:groups.pending.length,total:all.length},scanned:loopsData?.scanned||uniq.size};
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
  makeTile('finance','finance money-tile',['g-amber','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h2"/></svg>'],'Subscriptions','<span class="loop-count" id="finance-count"></span>','<div class="money-tabs" id="money-tabs" role="tablist"><button type="button" data-money="all" aria-pressed="true">All</button><button type="button" data-money="subscription" aria-pressed="false">Subscriptions</button><button type="button" data-money="pending" aria-pressed="false">Pending</button><button type="button" data-money="bill" aria-pressed="false">Bills</button><button type="button" data-money="store" aria-pressed="false">Store</button><button type="button" data-money="online" aria-pressed="false">Online</button></div><div class="money-sec" id="finance-list"><div class="cat-empty">Connect Google to pull subscriptions, bills and payments from Gmail.</div></div><div class="cat-foot" id="finance-foot"></div>');
  makeTile('travel','travel',['g-blue','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 13h18M6 13l2-6h8l2 6M6 17h.01M18 17h.01"/><rect x="3" y="13" width="18" height="5" rx="2"/></svg>'],'Travel','<span class="loop-count" id="travel-count"></span>','<div class="cat-list" id="travel-list"><div class="cat-empty">Flights, trains and bookings from mail and calendar will show up here.</div></div><div class="cat-foot" id="travel-foot"></div>');
  makeTile('pending','pending',['g-rose','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="9"/></svg>'],'Pending tasks','<span class="loop-count" id="pending-count"></span>','<div class="cat-list" id="pending-list"><div class="cat-empty">Due tasks and reminders from Google Tasks and Daylight appear here.</div></div><div class="cat-foot" id="pending-foot"></div>');
  makeTile('documents','documents',['g-blue','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>'],'Documents','<span class="loop-count" id="documents-count"></span>','<div class="cat-list" id="documents-list"><div class="cat-empty">Contracts, PDFs and signed docs from mail and Drive.</div></div><div class="cat-foot" id="documents-foot"></div>');
  let moneyFilter=getLS('daylight-money-filter')||'all';
  function catHTML(item,tone){
    const body=`<i class="cat-mark" aria-hidden="true"></i><span><b>${esc(item.title)}</b><small>${esc([item.tag,item.detail].filter(Boolean).join(' · '))}</small></span><span class="cat-time">${esc(item.meta||'')}</span>`;
    return item.href?`<a class="cat-item ${tone}" href="${esc(item.href)}" target="_blank" rel="noopener">${body}</a>`:`<div class="cat-item ${tone}">${body}</div>`;
  }
  function moneyHTML(item){
    const initial=(item.title||'?').trim().slice(0,2).toUpperCase();
    let when=item.meta||'';
    if(item.kind==='subscription'&&!item.received)when=item.meta?`Renews ${item.meta}`:'Renews soon';
    else if(item.kind==='pending')when=item.meta&&!item.received?`Due ${item.meta}`:(item.meta||'Pending');
    const body=`<span class="money-av m-brand" style="--a1:${esc(item.color)};--a2:${esc(item.color)}" aria-hidden="true">${brandLogoHTML(item,initial)}</span><span class="money-copy"><b>${esc(item.title)}</b><small>${esc(item.detail)}</small></span><span class="money-side"><span class="when">${esc(when)}</span><span class="tag">${esc(item.tag)}</span></span>`;
    return item.href?`<a class="money-row${item.urgent?' is-urgent':''}" href="${esc(item.href)}" target="_blank" rel="noopener">${body}</a>`:`<div class="money-row${item.urgent?' is-urgent':''}">${body}</div>`;
  }
  function renderMoney(){
    const list=$('#finance-list'),count=$('#finance-count'),foot=$('#finance-foot'),tabs=$('#money-tabs');
    if(!list)return;
    if(tabs)$$('#money-tabs [data-money]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.money===moneyFilter?'true':'false'));
    if(!token&&!microsoftAccount&&!DEMO){list.innerHTML='<div class="cat-empty">Connect Google to pull subscriptions, bills and payments from Gmail.</div>';if(count)count.textContent='';if(foot)foot.textContent='';return}
    if(!loopsData&&token){list.innerHTML='<div class="cat-empty">Sorting payments from your inbox…</div>';return}
    const money=computeMoney(),order=['pending','subscription','bill','store','online'],labels={pending:'Pending payments',subscription:'Subscriptions',bill:'Bills',store:'Store payments',online:'Online payments'};
    const max=+(wset('finance').max||8);
    let items=moneyFilter==='all'?money.all:money[moneyFilter]||[];
    if(count)count.textContent=money.counts.total||'';
    if(!items.length){list.innerHTML=`<div class="cat-empty">${moneyFilter==='all'?'No subscriptions, bills or payments in recent mail.':'Nothing in this category right now.'}</div>`;if(foot)foot.textContent=DEMO&&!token?'Preview sample · live mail after connect':'';return}
    if(moneyFilter==='all'){
      const chunks=[];let left=max;
      for(const k of order){const group=money[k];if(!group.length||left<=0)continue;const slice=group.slice(0,left);left-=slice.length;
        chunks.push(`<div class="money-sec-h"><span>${labels[k]}</span><span>${group.length}</span></div>${slice.map(moneyHTML).join('')}`);}
      list.innerHTML=chunks.join('')||'<div class="cat-empty">No subscriptions, bills or payments in recent mail.</div>';
    }else list.innerHTML=items.slice(0,max).map(moneyHTML).join('');
    if(foot)foot.textContent=items.length>max?`+${items.length-max} more`:(DEMO&&!token?'Preview sample · connect Google for live mail':'');
  }
  $('#money-tabs')?.addEventListener('click',e=>{const b=e.target.closest('[data-money]');if(!b)return;moneyFilter=b.dataset.money;setLS('daylight-money-filter',moneyFilter);renderMoney();fitAll?.()});
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
  const openMenu=o=>{if(!drawer)return;drawer.hidden=!o;scrim.hidden=!o;document.body.classList.toggle('menu-open',o);$('#menu-btn').setAttribute('aria-expanded',String(o));if(o){renderDrawerAccount();drawer.querySelector('.menu-item')?.focus()}};
  $('#menu-btn')?.addEventListener('click',()=>openMenu(drawer.hidden));
  $('#drawer-close')?.addEventListener('click',()=>openMenu(false));scrim?.addEventListener('click',()=>openMenu(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(window.DaylightNav?.anyOpen()){window.DaylightNav.back();return}openMenu(false);$('#overlay').classList.remove('show')}});
  ['#connections','#refresh','#customize'].forEach(s=>$(s)?.addEventListener('click',()=>openMenu(false)));
  function renderDrawerAccount(){const p=readProfile(),el=$('#drawer-account');if(!el)return;
    el.innerHTML=p.name||p.email?`<div class="da-avatar">${p.picture?`<img src="${esc(p.picture)}" alt="" referrerpolicy="no-referrer">`:esc((p.name||'?')[0])}</div><div><b>${esc(p.name||'')}</b><span>${esc(p.email||'')}</span></div>`:'<div><b>Not connected</b><span>Open Connections to sign in</span></div>';
    $('#conn-state').textContent=token||microsoftAccount?'Connected':'';}
  // ---- Theme: follow the system unless you choose ----
  const darkMq=matchMedia('(prefers-color-scheme: dark)');
  const syncTheme=()=>{const dark=document.body.classList.contains('dark');$('#theme-label')&&($('#theme-label').textContent=dark?'Light mode':'Dark mode');document.querySelector('meta[name=theme-color]')?.setAttribute('content',dark?'#151a25':'#eef2f7')};
  if(!getLS('daylight-theme'))document.body.classList.toggle('dark',darkMq.matches);
  darkMq.addEventListener?.('change',e=>{if(!getLS('daylight-theme')){document.body.classList.toggle('dark',e.matches);syncTheme()}});
  $('#theme')?.addEventListener('click',syncTheme);syncTheme();
  // ---- Notification bell ----
  const bellIcon={meeting:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10h18"/>'};
  function bellItems(){
    const items=[],now=new Date();
    personalTasks.filter(t=>t.hasTime&&t.dueDate&&new Date(t.dueDate)-now<=30*60000&&now-new Date(t.dueDate)<6*3600000).forEach(t=>items.push({id:'rem:'+t.id,cls:'t-deadline',icon:LOOP_TYPES.deadline.icon,label:new Date(t.dueDate)<=now?'Reminder now':'Reminder soon',title:t.title,meta:fmtDue(t)+(t.project?' · '+t.project:''),href:''}));
    todayEvents().timed.filter(e=>e.start>now&&e.start-now<=30*60000).forEach(e=>items.push({id:'meet:'+e.title+e.start.getTime(),cls:'t-prepare',icon:bellIcon.meeting,label:'Starting soon',title:e.title,meta:`${hm(e.start)} · in ${Math.max(1,Math.round((e.start-now)/60000))} min`,href:''}));
    if(token||microsoftAccount)computeLoops().forEach(l=>{const t=LOOP_TYPES[l.type];items.push({id:l.id,cls:t.cls,icon:t.icon,label:t.label,title:l.title,meta:l.meta||l.detail,href:l.href})});
    return items;
  }
  function renderBell(){
    const items=bellItems(),seen=readJSON('daylight-seen',[]),unseen=items.filter(i=>!seen.includes(i.id)).length,badge=$('#bell-badge');if(!badge)return;
    badge.hidden=!unseen;badge.textContent=unseen>9?'9+':unseen;$('#bell').setAttribute('aria-label',unseen?`Notifications, ${unseen} new`:'Notifications');
    const panel=$('#notif-panel');if(panel.hidden)return;
    $('#notif-list').innerHTML=items.length?items.slice(0,12).map(i=>`<${i.href?`a href="${esc(i.href)}" target="_blank" rel="noopener"`:'div'} class="notif ${i.cls}${seen.includes(i.id)?'':' is-new'}"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${i.icon}</svg></span><span class="notif-body"><span class="loop-type">${esc(i.label)}</span><b>${esc(i.title)}</b><small>${esc(i.meta||'')}</small></span></${i.href?'a':'div'}>`).join(''):`<div class="empty">${token||microsoftAccount?'You’re all caught up.':'Connect Google to get notified about replies, meetings and deadlines.'}</div>`;
  }
  function toggleBell(open){const panel=$('#notif-panel');panel.hidden=!open;$('#bell').setAttribute('aria-expanded',String(open));
    if(open){renderBell();writeJSON('daylight-seen',bellItems().map(i=>i.id).concat(readJSON('daylight-seen',[])).slice(0,300));$('#bell-badge').hidden=true}}
  $('#bell')?.addEventListener('click',e=>{e.stopPropagation();toggleBell($('#notif-panel').hidden)});
  $('#notif-close')?.addEventListener('click',()=>toggleBell(false));
  document.addEventListener('click',e=>{const p=$('#notif-panel');if(p&&!p.hidden&&!p.contains(e.target)&&e.target.closest('#bell')==null)toggleBell(false)});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#notif-panel').hidden)toggleBell(false)});
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
    const pendingPay=money.pending||[],soonSub=(money.subscription||[]).filter(x=>x.urgent);
    if(pendingPay.length)s.push(`<em>${pendingPay.length} pending ${pl(pendingPay.length,'payment','payments')}</em>${pendingPay[0]?` from ${esc(pendingPay[0].title)}`:''}.`);
    else if(soonSub.length)s.push(`${soonSub[0].title} renews ${esc(soonSub[0].meta||'soon')}.`);
    else if(money.counts?.total)s.push(`${money.counts.total} money ${pl(money.counts.total,'item','items')} sorted under Subscriptions.`);
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
      if(pendingPay[0]?.href)btns.push(`<a class="connect" href="${esc(pendingPay[0].href)}" target="_blank" rel="noopener">Check pending payment</a>`);
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
  $('#customize').onclick=()=>toggleEdit();
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
  async function eventsBetween(from,to,q){if(!token)return null;const u=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');u.searchParams.set('timeMin',from.toISOString());u.searchParams.set('timeMax',to.toISOString());u.searchParams.set('singleEvents','true');u.searchParams.set('orderBy','startTime');u.searchParams.set('maxResults','25');if(q)u.searchParams.set('q',q);
    try{return (await api(u)).items||[]}catch{return []}}
  const evItem=e=>{const s=new Date(e.start?.dateTime||e.start?.date);return {title:e.summary||'(No title)',meta:(e.start?.dateTime?s.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'})+' · '+hm(s):s.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'})+' · all day')+(e.location?' · '+e.location:''),href:e.htmlLink,src:'Calendar'}};
  const loopItem=l=>({title:l.title,meta:[srcOf(l),l.meta||l.detail].filter(Boolean).join(' · '),href:l.href,src:srcOf(l)});
  async function answer(q){
    const lq=q.toLowerCase(),w=parseWhen(q),needG=!token&&!microsoftAccount;
    if(/\b(bills?|renewals?|subscriptions?|payments?|invoices?)\b/.test(lq)){
      const payTasks=personalTasks.filter(t=>t.project==='Payments'||t.suggested).map(t=>({title:t.title,meta:[t.dueDate?fmtDue(t):'No due date',t.amount||''].filter(Boolean).join(' · '),href:t.href||'',src:'Payments'}));
      const money=computeMoney();
      return {sections:[
        {title:'Payment tasks',items:payTasks,empty:'No payment tasks suggested yet.'},
        {title:'Bills and renewals',items:[...money.bill,...money.pending,...computeLoops().filter(l=>l.type==='renewal')].slice(0,10).map(i=>i.type?loopItem(i):{title:i.subject||i.title,meta:[i.meta,i.amount].filter(Boolean).join(' · '),href:i.href,src:'Money'}),empty:needG?'Connect Google to check your inbox.':'Nothing coming up in your recent email.'}
      ]};
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
  function findLoop(id){return computeLoops().find(l=>l.id===id)||null}
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
  function decodeMailText(payload){
    const decode=d=>{try{const bin=atob(String(d).replace(/-/g,'+').replace(/_/g,'/'));try{return decodeURIComponent(escape(bin))}catch{return bin}}catch{return''}};
    const walk=p=>{
      if(!p)return'';
      if(p.mimeType==='text/plain'&&p.body?.data)return decode(p.body.data);
      if(p.parts){for(const x of p.parts){const t=walk(x);if(t)return t}}
      if(p.mimeType==='text/html'&&p.body?.data)return decode(p.body.data).replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      return'';
    };
    return(walk(payload)||'').trim().slice(0,1400);
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
      const detail={
        id:m.id,threadId:m.threadId,snippet:m.snippet||'',subject:header(h,'Subject')||'(No subject)',
        from,replyTo,replyEmail:replyTo.email||from.email||'',messageId,inReplyTo:messageId,references,
        date:new Date(header(h,'Date')||m.internalDate*1),body:decodeMailText(m.payload)||m.snippet||'',labelIds:m.labelIds||[]
      };
      mailDetailCache[mailId]=detail;return detail;
    }catch(e){
      console.warn('mail detail',e);
      const msg=String(e?.message||e||'');
      if(/403|insufficient|METADATA_SCOPE/i.test(msg))toast('Reconnect Google to read full email content');
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
    if(!hasGmailSend()){
      replyState.status='error';replyState.error='Google send permission is missing. Reconnect and allow Daylight to send email.';
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
  function inboxToDetail(item){
    const type=item.kind==='subscription'?'renewal':item.kind==='pending'?'overdue':item.kind==='bill'?'deadline':'reply';
    const need=item.kind==='subscription'?'Review this subscription and cancel or confirm before renewal.':item.kind==='pending'?'Settle this payment or reschedule it.':item.kind==='bill'?'Review the bill and pay if needed.':item.kind==='store'?'Confirm this store purchase and keep the receipt.':'Review this online payment.';
    return {
      id:'inbox:'+item.id,type,title:item.title,detail:item.detail||item.subject||'',subject:item.subject||item.title,
      meta:item.meta,href:item.href,mailId:item.mailId||null,fromName:item.fromName||item.from||item.title,
      fromEmail:item.fromEmail||'',domain:item.domain||brandDomain(item.fromEmail,item.title),logo:item.logo||'',whenMs:item.whenMs||item.when||0,dueLabel:item.meta||'',category:item.tag||MONEY_LABEL[item.kind]||'Money',
      amount:item.amount||'',urgent:!!item.urgent,weight:item.urgent?2:1,snippet:item.snippet||'',_inbox:true,_need:need
    };
  }
  function currentDetail(){return openDetail||findLoop(openLoopId)||null}
  function readFavs(){return readJSON('daylight-favs',{})}
  function isFav(id){return!!readFavs()[id]}
  function toggleFav(id){const f=readFavs();f[id]=!f[id];if(!f[id])delete f[id];writeJSON('daylight-favs',f);feel.select();return!!f[id]}
  let tdTab='details';
  function paintLoopDetail(l,mail){
    const t=LOOP_TYPES[l.type]||LOOP_TYPES.reply,sug=loopSuggestion(l),prio=l.weight>=2||l.type==='overdue'||l.urgent;
    const whenTxt=l.meta||(l.whenMs?ago(new Date(l.whenMs)):'');
    const due=loopDueLabel(l),cat=loopCategory(l),need=l._need||loopNote(l);
    const fromName=mail?.from?.name||l.fromName||srcOf(l);
    const subject=mail?.subject||loopSubject(l);
    const body=mail?.body||l.snippet||l.detail||'Open the source to read the full message.';
    const timeStr=mail?.date?mail.date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):(l.whenMs?new Date(l.whenMs).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):'');
    const relatedMail=l.relatedMail||null;
    const isMail=!!(l.mailId||relatedMail||l._inbox||l.type==='reply'||l.type==='followup'||l.type==='renewal'||(l.href&&String(l.href).includes('mail.google')));
    const composing=!!(replyState?.open&&replyState.loopId===l.id);
    const navTitle=composing?'Reply':(l._inbox?'Inbox Detail':'Task Detail');
    const fav=isFav(l.id);
    const tab=composing?'email':(tdTab==='email'&&isMail?'email':tdTab==='notes'?'notes':tdTab==='activity'?'activity':'details');
    const nav=$('.td-nav b');if(nav)nav.textContent=navTitle;
    const star=$('.td-nav [data-ls-fav]');if(star){star.classList.toggle('on',fav);star.setAttribute('aria-pressed',fav?'true':'false')}
    const tripPass=l.tripId?readWallet().filter(w=>w.tripId===l.tripId):[];
    $('#ls-head').innerHTML=`<span class="td-ico ${t.cls}" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <div class="td-head-copy">${prio?`<span class="td-prio">High Priority</span>`:''}<h2 id="ls-title">${esc(composing?'Write a reply':l.title)}</h2>
      <div class="td-meta-row"><span class="td-chip">${esc(srcOf(l)||'Daylight')}</span><span class="td-chip accent">${esc(due||whenTxt||'—')}</span>${prio?`<span class="td-chip hot">Priority · High</span>`:''}${l.tripId?`<span class="td-chip">Trip</span>`:''}</div></div>`;
    const tripCard=tripPass.length?`<div class="td-card td-need"><span class="td-need-l">Linked trip</span>${tripPass.map(w=>`<p style="margin:6px 0 0"><button type="button" class="td-link" data-open-wallet="${esc(w.id)}">${esc(w.title)}</button> <small>${esc(w.typeLabel||WALLET_LABEL[w.kind]||'')}</small></p>`).join('')}</div>`:'';
    const relatedMailCard=relatedMail?`<div class="td-card td-mail"><div class="td-mail-h"><div><b>Related email</b><small>${esc(relatedMail.subject)}</small></div></div><p class="td-mail-b">From ${esc(relatedMail.from?.name||relatedMail.from?.email||'Gmail')}</p><button type="button" class="td-link" data-ls-act="open-related-mail">Open related mail</button></div>`:'';
    const details=`
      <div class="td-card td-attrs">
        <div class="td-attr"><span class="td-attr-l">${l._inbox?'Date':'Due'}</span><span class="td-attr-v accent">${esc(due)}</span></div>
        ${l.amount?`<div class="td-attr"><span class="td-attr-l">Amount</span><span class="td-attr-v accent">${esc(l.amount)}</span></div>`:''}
        <div class="td-attr"><span class="td-attr-l">Status</span><span class="td-status">${l.urgent||l.type==='overdue'||l.type==='deadline'?'Needs Action':'Review'}</span></div>
        <div class="td-attr"><span class="td-attr-l">Category</span><span class="td-attr-v accent">${esc(cat)}</span></div>
      </div>
      <div class="td-card td-need"><span class="td-need-l">What needs to be done</span><p>${esc(need)}</p></div>
      ${tripCard}${relatedMailCard}
      <div class="td-card td-ai"><div class="td-ai-top"><span class="td-ai-ico" aria-hidden="true">✦</span><b>${esc(sug.label)}</b></div><p>${esc(sug.text)}</p><button class="td-draft" type="button" data-ls-act="${canReplyInApp(l)?'reply':'suggest'}">${esc(canReplyInApp(l)?'Reply in Daylight':sug.cta)}</button></div>`;
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
        ${l.href?`<button type="button" class="td-link td-open-original" data-ls-act="open-original">Open original</button>`:''}
      </div>`:'';
    const mailFrom=mail?.from?.name||relatedMail?.from?.name||fromName;
    const mailSub=mail?.subject||relatedMail?.subject||subject;
    const email=`      ${isMail?`<div class="td-card td-mail" id="ls-mail">
        <div class="td-mail-h"><span class="td-av m-brand" style="--a1:${esc(l.color||brandColor(mailFrom))};--a2:${esc(l.color||brandColor(mailFrom))}">${brandLogoHTML({fromEmail:l.fromEmail||relatedMail?.from?.email,title:mailFrom,domain:l.domain,logo:l.logo},initialsOf(mailFrom))}</span><div><b>${esc(mailFrom)}</b><small>${esc(mailSub)}</small></div><span class="td-mail-t">${esc(timeStr)}</span></div>
        <p class="td-mail-b">${mail?esc(body):(l.mailId||relatedMail?.mailId?'Loading email from Gmail…':esc(body))}</p>
        ${relatedMailCard}
        ${tripCard}
        ${(l.href||relatedMail?.href)?`<button type="button" class="td-link td-open-original" data-ls-act="open-original">Open original</button>`:''}
      </div>${compose}`:`<div class="td-card"><p class="td-mail-b">No email linked to this item.</p></div>${tripCard}${compose}`}`;
    const notes=`<div class="td-card td-need"><span class="td-need-l">Notes</span><p>${esc(l.detail||l.snippet||'No notes yet. Capture a reminder from Assistant.')}</p></div>
      ${tripCard}
      ${l.related?`<div class="td-card"><a class="td-link" href="${esc(l.related.webViewLink)}" target="_blank" rel="noopener">Related: ${esc(l.related.name)}</a></div>`:''}`;
    const activity=`<div class="td-card td-attrs">
        <div class="td-attr"><span class="td-attr-l">Source</span><span class="td-attr-v">${esc(srcOf(l))}</span></div>
        <div class="td-attr"><span class="td-attr-l">Updated</span><span class="td-attr-v">${esc(whenTxt||'—')}</span></div>
        <div class="td-attr"><span class="td-attr-l">Favourite</span><span class="td-attr-v">${fav?'Yes':'No'}</span></div>
      </div>`;
    $('#ls-body').innerHTML=`
      <div class="td-tabs" role="tablist">
        <button type="button" class="td-tab${tab==='details'&&!composing?' on':''}" data-td-tab="details" ${composing?'disabled':''}>Details</button>
        <button type="button" class="td-tab${tab==='email'||composing?' on':''}" data-td-tab="email" ${isMail||composing?'':'disabled'}>Email</button>
        <button type="button" class="td-tab${tab==='notes'&&!composing?' on':''}" data-td-tab="notes" ${composing?'disabled':''}>Notes</button>
        <button type="button" class="td-tab${tab==='activity'&&!composing?' on':''}" data-td-tab="activity" ${composing?'disabled':''}>Activity</button>
      </div>
      ${composing||tab==='email'?email:tab==='notes'?notes:tab==='activity'?activity:details}`;
    if(composing){
      const sending=st.status==='sending',ok=st.status==='success',needReconnect=!hasGmailSend();
      $('#ls-foot').innerHTML=`${ok
        ?`<button class="td-primary" type="button" data-ls-act="close-compose">Done</button>`
        :`<button class="td-primary" type="button" data-ls-act="${needReconnect?'reconnect-send':(st.status==='error'?'retry-send':'send')}" ${sending?'disabled':''}>${sending?'Sending…':needReconnect?'Reconnect to send':st.status==='error'?'Retry send':'Send reply'}</button>`}
        <div class="td-sec td-sec-2"><button class="td-sec-btn" type="button" data-ls-act="cancel-compose" ${sending?'disabled':''}>${ok?'Close':'Cancel'}</button>
        ${l.href?`<button class="td-sec-btn" type="button" data-ls-act="open-original">Open original</button>`:`<button class="td-sec-btn" type="button" data-ls-act="remind" ${sending?'disabled':''}>Reminder</button>`}</div>`;
      return;
    }
    const replyable=canReplyInApp(l);
    const primary=replyable?'Reply':(l._inbox?'Review':(sug.primary&&sug.primary!=='Reply Now'&&sug.primary!=='Send follow-up'&&sug.primary!=='Open in Gmail'?sug.primary:'Open'));
    const primaryAct=replyable?'reply':(l.href?'open-original':'done');
    $('#ls-foot').innerHTML=`<button class="td-primary" type="button" data-ls-act="${primaryAct}">${esc(primary)}</button>
      <div class="td-sec td-sec-3"><button class="td-sec-btn" type="button" data-ls-act="snooze">Snooze</button><button class="td-sec-btn" type="button" data-ls-act="remind">Reminder</button><button class="td-sec-btn" type="button" data-ls-act="done">Mark Done</button></div>
      ${l.href?`<button type="button" class="td-foot-link" data-ls-act="open-original">Open original in Gmail</button>`:''}`;
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
        const act=e.target.closest('[data-ls-act]');if(!act||!openLoopId)return;
        const loop=currentDetail();if(!loop)return;
        const a=act.dataset.lsAct;
        if(a==='snooze'){const s=loopState();s[loop.id]={snooze:Date.now()+86400000,t:Date.now()};saveLoopState(s);closeLoopSheet();renderLoops();if(typeof renderInbox==='function')renderInbox({animate:false});toast('Snoozed until tomorrow',{type:'ok',haptic:'success'});return}
        if(a==='remind'){capture('Remind me: '+loop.title+(loop.dueLabel?' by '+loop.dueLabel:''));toast('Reminder added',{type:'ok',haptic:'success'});return}
        if(a==='done'){const s=loopState();s[loop.id]={done:true,t:Date.now()};saveLoopState(s);closeLoopSheet();renderLoops();if(typeof renderInbox==='function')renderInbox({animate:false});toast('Marked as done',{type:'ok',haptic:'success'});return}
        if(a==='open-original'){
          const href=loop.relatedMail?.href||loop.href;
          if(!href){toast('No Gmail link available',{type:'warn'});return}
          feel.select();window.open(href,'_blank','noopener');return
        }
        if(a==='open-related-mail'){
          const rm=loop.relatedMail;if(!rm?.href){toast('No related mail found',{type:'warn'});return}
          feel.select();window.open(rm.href,'_blank','noopener');return
        }
        if(a==='reply'){openReplyComposer(loop);return}
        const wOpen=e.target.closest('[data-open-wallet]');
        if(wOpen){feel.select();closeLoopSheet();setTab('wallet');openPassSheet(wOpen.dataset.openWallet);return}
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
    sheet.classList.remove('closing','show');void sheet.offsetWidth;
    sheet.classList.add('show');sheet.setAttribute('aria-hidden','false');document.body.classList.add('loop-open');
    if(!wasOpen)feel.tap();
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
    const tags=[];if(l.weight>=2||l.type==='overdue')tags.push(['High priority','hot']);const tg=TAGS[l.type];if(tg&&!(l.type==='overdue'))tags.push(tg);if(l.type==='overdue')tags.push(['Reschedule','']);
    return `<div class="arow ${t.cls}" data-loop="${esc(l.id)}" role="button" tabindex="0"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <div class="arow-main"><div class="arow-top"><b>${esc(l.title)}</b><span class="arow-src">${esc([srcOf(l),l.meta].filter(Boolean).join(' · '))}</span></div>
      <div class="arow-detail">${esc(l.detail)}${l.related?` · <a href="${esc(l.related.webViewLink)}" target="_blank" rel="noopener">${esc(l.related.name)}</a>`:''}</div>
      <div class="arow-foot"><span class="arow-tags">${tags.map(([x,c])=>`<span class="atag ${c}">${x}</span>`).join('')}</span><span class="arow-actions"><button class="connect primary" type="button" data-open-loop="${esc(l.id)}">Expand</button><button class="connect ghost" type="button" data-act="snooze">Snooze</button><button class="connect ghost" type="button" data-act="done" aria-label="Mark done">Done</button></span></div></div></div>`}
  // ======== Mobile app (≤680px): Home · Inbox · Wallet · Assistant · Statistics ========
  function logDone(t){if(!t)return;try{const l=JSON.parse(localStorage.getItem('daylight-done-log')||'[]');l.push({id:t.id,title:t.title,project:t.project||'',at:new Date().toISOString()});localStorage.setItem('daylight-done-log',JSON.stringify(l.slice(-500)))}catch{}}
  function logFocus(min){try{const l=JSON.parse(localStorage.getItem('daylight-focus-log')||'[]');l.push({min,at:new Date().toISOString()});localStorage.setItem('daylight-focus-log',JSON.stringify(l.slice(-500)))}catch{}}
  const mq=matchMedia('(max-width:680px)');
  const ICON={home:'<path d="M4 11.5 12 5l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z"/>',inbox:'<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.5Z"/><path d="M4 13h4.2a2 2 0 0 1 1.8 1.1l.4.8a2 2 0 0 0 1.8 1.1h1.6a2 2 0 0 0 1.8-1.1l.4-.8A2 2 0 0 1 15.8 13H20"/>',wallet:'<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><path d="M16 14.5h2"/>',calendar:'<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="15.5" cy="15" r="1.2" fill="currentColor"/>',assistant:'<path d="M12 3.5 14.4 6l3.4-.3.3 3.4L20.5 12l-2.4 2.9-.3 3.4-3.4-.3L12 20.5 9.6 18l-3.4.3-.3-3.4L3.5 12l2.4-2.9.3-3.4 3.4.3Z"/><path d="m9.5 12 1.6 1.6 3.4-3.4"/>',stats:'<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M9 15v-3M12 15V9M15 15v-5"/>',search:'<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',bell:'<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',filter:'<path d="M4 7h16M7 12h10M10 17h4"/>',back:'<path d="M15 6 9 12l6 6"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/>',phone:'<rect x="8" y="3" width="8" height="18" rx="2"/><path d="M11 18.5h2"/>',chevron:'<path d="m9 6 6 6-6 6"/>',spark:'<path d="M12 3.5 13.2 8l4.3.4-3.3 2.9.9 4.2L12 13.4 8.9 15.5l.9-4.2-3.3-2.9L10.8 8 12 3.5Z"/>',scan:'<path d="M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M8 20H6a2 2 0 0 1-2-2v-2M16 20h2a2 2 0 0 0 2-2v-2"/><path d="M8 12h8"/>',chat:'<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5V13a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.2V15.5H7.5A2.5 2.5 0 0 1 5 13Z"/>',suitcase:'<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M9 8V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V8M5 13h14"/>',chevDown:'<path d="m7 10 5 5 5-5"/>'};
  const svg=(d,w=22)=>`<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const mapp=document.createElement('div');mapp.id='mapp';mapp.className='mapp';
  mapp.innerHTML=`<header class="m-top"><span class="m-title" id="m-title"></span><span class="m-top-actions"><button class="m-circle" id="m-search" type="button" aria-label="Search or ask">${svg(ICON.search,18)}</button><button class="m-circle" id="m-bell" type="button" aria-label="Notifications">${svg(ICON.bell,18)}<i class="m-dot" hidden></i></button><button class="m-avatar" id="m-avatar" type="button" aria-label="Menu"></button></span></header>
   <section class="m-screen" data-screen="home"><div class="m-date" id="m-date"></div><h2 class="m-hello" id="m-hello"></h2>
     <button class="m-brief" id="m-brief" type="button"></button>
     <div class="m-stat-grid" id="m-home-stats" hidden></div>
     <div class="m-home-block" id="m-loops-block">
       <div class="m-sec-head"><h3 class="m-sec-title">Priority Actions <span class="m-count-pill" id="m-loop-total" hidden></span></h3><button class="m-see-all" type="button" id="m-loops-see">See All ${svg(ICON.chevron,14)}</button></div>
       <div class="m-loop-list" id="m-loop-grid"></div>
       <div class="loops-foot" id="m-loops-foot" hidden></div>
     </div>
     <div class="m-more" id="m-more" hidden></div><div class="m-stat" id="m-stat" hidden></div><h3 class="m-count" id="m-count" hidden></h3></section>
   <section class="m-screen" data-screen="inbox">
     <div class="m-inbox-head"><div class="m-inbox-tabs m-pills" role="tablist" id="m-inbox-tabs" aria-label="Inbox categories"><i class="m-inbox-thumb" id="m-inbox-thumb" aria-hidden="true" hidden></i><button type="button" role="tab" data-inbox="all" class="on" aria-selected="true">All</button><button type="button" role="tab" data-inbox="subscription" aria-selected="false">Subs</button><button type="button" role="tab" data-inbox="bill" aria-selected="false">Bills</button><button type="button" role="tab" data-inbox="payments" aria-selected="false">Payments</button></div><button class="m-inbox-filter" id="m-inbox-filter" type="button" aria-label="Filter">${svg(ICON.filter,16)}</button></div>
     <div id="m-inbox"></div>
   </section>
   <section class="m-screen" data-screen="wallet">
     <div class="m-wallet-head"><div class="m-wallet-tabs m-pills" role="tablist" id="m-wallet-tabs" aria-label="Wallet categories"><i class="m-wallet-thumb" id="m-wallet-thumb" aria-hidden="true" hidden></i><button type="button" role="tab" data-wallet="all" class="on" aria-selected="true">All</button><button type="button" role="tab" data-wallet="tickets" aria-selected="false">Tickets</button><button type="button" role="tab" data-wallet="coupons" aria-selected="false">Coupons</button><button type="button" role="tab" data-wallet="documents" aria-selected="false">Documents</button><button type="button" role="tab" data-wallet="others" aria-selected="false">Others</button></div></div>
     <div id="m-wallet"></div>
   </section>
   <section class="m-screen" data-screen="calendar" hidden><div class="m-cal-head"><button class="m-arrow" type="button" data-wk="-1" aria-label="Previous week">‹</button><b id="m-month"></b><button class="m-arrow" type="button" data-wk="1" aria-label="Next week">›</button><span class="m-pill">Week</span></div><div class="m-week" id="m-week"></div><div class="m-day" id="m-day"></div></section>
   <section class="m-screen" data-screen="assistant">
     <div class="tl-top">
       <button type="button" class="tl-date-pill" id="tl-date-btn" aria-expanded="false" aria-controls="tl-cal">
         <span class="tl-date-ico" aria-hidden="true">${svg(ICON.calendar,16)}</span>
         <span id="tl-date-label">Today</span>
         <span class="tl-date-chev" aria-hidden="true">${svg(ICON.chevDown,14)}</span>
       </button>
       <button type="button" class="tl-ask-btn" id="tl-ask-btn" aria-expanded="false" aria-controls="tl-chat-wrap">
         <span aria-hidden="true">${svg(ICON.chat,16)}</span> Ask
         <span aria-hidden="true">${svg(ICON.chevDown,14)}</span>
       </button>
     </div>
     <div class="tl-cal" id="tl-cal" hidden>
       <div class="tl-cal-nav"><button type="button" data-tl-wk="-1" aria-label="Previous week">‹</button><b id="tl-cal-month"></b><button type="button" data-tl-wk="1" aria-label="Next week">›</button></div>
       <div class="tl-week" id="tl-week" role="tablist" aria-label="Choose day"></div>
     </div>
     <div class="tl-view" id="tl-view">
       <div class="tl-head">
         <h2 id="tl-heading"></h2>
         <div class="tl-head-meta"><span class="tl-count" id="tl-count" hidden><span aria-hidden="true">${svg(ICON.suitcase,14)}</span><b id="tl-count-n">0</b></span><button type="button" class="tl-ask-mini" id="tl-ask-mini">Ask</button></div>
       </div>
       <div class="tl-list" id="tl-list"></div>
     </div>
     <div class="tl-chat" id="tl-chat-wrap" hidden>
       <div class="m-chat" id="m-chat"></div>
       <form class="m-msg" id="m-msg"><input id="m-msg-input" placeholder="Ask about your day…" autocomplete="off" aria-label="Message Daylight"><button type="submit" aria-label="Send"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m21 3-9.5 18-2-7.5L2 11.5Z"/><path d="m9.5 13.5 5-5"/></svg></button></form>
     </div>
   </section>
   <section class="m-screen" data-screen="stats"><div id="m-stats"></div></section>
   <nav class="m-tabs" aria-label="Sections"><button data-tab="home" type="button">${svg(ICON.home)}<span>Home</span></button><button data-tab="inbox" type="button">${svg(ICON.inbox)}<span>Inbox</span></button><button data-tab="wallet" type="button">${svg(ICON.wallet)}<span>Wallet</span></button><button data-tab="assistant" type="button">${svg(ICON.assistant)}<span>Assistant</span></button><button data-tab="stats" type="button">${svg(ICON.stats)}<span>Statistics</span></button></nav>
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
  let mTab=getLS('daylight-mtab')||'home',mInboxFilter=getLS('daylight-inbox-filter')||'all',mWalletFilter=getLS('daylight-wallet-filter')||'all',mWalletOpen='',mSel=new Date(localMidnight),mAssistDay=new Date(localMidnight),mAssistAsk=false,mWeekCache={},mChat=[],scanStream=null,scanDraft=null,scanExtract=null;
  if(mTab==='calendar')mTab='inbox';
  const TITLES={home:'Daylight',inbox:'Inbox',wallet:'Wallet',calendar:'Calendar',assistant:'',stats:'Statistics'};
  const WALLET_COLORS={tickets:['#1f6feb','#0b3d91'],coupons:['#d9480f','#a33b0a'],documents:['#2f9e44','#1b6b2e'],others:['#7048e8','#4c2db3']};
  const WALLET_LABEL={tickets:'Ticket',coupons:'Coupon',documents:'Document',others:'Pass'};
  function qrUrl(payload,size){return(window.DaylightScan?.qrImageUrl?.(payload,size))||('https://api.qrserver.com/v1/create-qr-code/?size='+(size||200)+'x'+(size||200)+'&margin=8&data='+encodeURIComponent(payload))}
  function barcodeUrl(payload){return(window.DaylightScan?.barcodeImageUrl?.(payload))||('https://bwipjs-api.metafloor.com/?bcid=code128&text='+encodeURIComponent(payload)+'&scale=3&includetext&guardwhitespace')}
  function readWallet(){
    const list=readJSON('daylight-wallet',null);
    if(Array.isArray(list)){
      let changed=false;
      list.forEach(i=>{
        if(!i.qrPayload){i.qrPayload=String(i.barcode||i.number||i.id||'').replace(/^#/,'');changed=true}
        if(i.qrPayload&&!i.qrImage){i.qrImage=qrUrl(i.qrPayload,220);changed=true}
        if(i.qrPayload&&!i.barcodeImage){i.barcodeImage=barcodeUrl(i.barcode||i.qrPayload);changed=true}
        if(i.kind==='tickets'&&!i.flight&&/\b(→|->|seat|flight|gate|coach)\b/i.test(i.note||i.title||'')){
          i.flight=window.DaylightScan?.extractFlight?.([i.title,i.note,i.ocr].filter(Boolean).join('\n'))||null;if(i.flight)changed=true;
        }
      });
      if(changed)writeJSON('daylight-wallet',list);
      return list;
    }
    const seed=[
      {id:'w1',title:'Prague → Berlin',kind:'tickets',note:'Seat 14A · Coach 3',org:'Deutsche Bahn',typeLabel:'Train ticket',number:'#DB88421',date:'2 Nov 2024',expiry:'',at:new Date().toISOString(),color:WALLET_COLORS.tickets,barcode:'DB88421PRGBER14A',qrPayload:'DB88421PRGBER14A',flight:{from:'PRG',to:'BER',flight:'RJ 782',seat:'14A',coach:'3',gate:'',pnr:'DB88421',depart:'09:40',arrive:'14:15'}},
      {id:'w2',title:'Coffee free refill',kind:'coupons',note:'Valid until month end',org:'Local Roasters',typeLabel:'Coupon',number:'#CF440',expiry:'30 Nov 2024',at:new Date(Date.now()-86400000).toISOString(),color:WALLET_COLORS.coupons,barcode:'COFFEE-FREE-440',qrPayload:'COFFEE-FREE-440'},
      {id:'w3',title:'Legal forms scan',kind:'documents',note:'III. Legal forms',org:'Daylight Docs',typeLabel:'Document',number:'#DOC12',at:new Date(Date.now()-2*86400000).toISOString(),color:WALLET_COLORS.documents,barcode:'DOC-LEGAL-12',qrPayload:'DOC-LEGAL-12'},
      {id:'w4',title:'Library card',kind:'others',note:'Member since 2024',org:'City Library',typeLabel:'Membership',number:'#2301',memberSince:'13 May 2024',expiry:'20 May 2025',at:new Date(Date.now()-5*86400000).toISOString(),color:WALLET_COLORS.others,barcode:'LIB-2301',qrPayload:'LIB-2301'}
    ];
    seed.forEach(i=>{if(i.qrPayload){i.qrImage=qrUrl(i.qrPayload,220);i.barcodeImage=barcodeUrl(i.barcode||i.qrPayload)}});
    writeJSON('daylight-wallet',seed);return seed;
  }
  function saveWallet(list){writeJSON('daylight-wallet',list.slice(0,80));try{queueDaylightHydrate?.()}catch{}}
  /* ---- Cross-app intelligence: travel Wallet, trips, meeting↔mail, payment tasks ---- */
  function mailSearchText(m){
    const h=m?.payload?.headers||[];
    return [header(h,'Subject'),header(h,'From'),header(h,'To'),m?.snippet||''].join(' ');
  }
  function parseFlexibleDate(text,fallback){
    const s=String(text||'');let m;
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
    return fallback instanceof Date&&!isNaN(fallback)?fallback:new Date();
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
    const when=parseFlexibleDate(text,received);
    const tripId=tripIdFor(dest||flight?.from||from.name||subject.slice(0,16),when.getTime());
    return {
      mailId:m.id,threadId:m.threadId||m.id,kind,subject,from,dest,flight,
      whenMs:when.getTime(),receivedMs:received.getTime(),tripId,href:gmailLink(m.threadId||m.id),
      title:subject
    };
  }
  function mergeTripIds(bookings){
    const out=bookings.map(b=>({...b}));
    for(let i=0;i<out.length;i++){
      for(let j=i+1;j<out.length;j++){
        const a=out[i],b=out[j];
        const sameDest=a.dest&&b.dest&&a.dest.toLowerCase().slice(0,8)===b.dest.toLowerCase().slice(0,8);
        const close=Math.abs(a.whenMs-b.whenMs)<6*86400000;
        if((sameDest||(!a.dest&&!b.dest&&close))&&close){
          const keep=a.whenMs<=b.whenMs?a.tripId:b.tripId;
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
    return [b.whenMs||'',b.flight?.depart||'',b.flight?.arrive||'',b.flight?.flight||'',b.flight?.gate||'',b.cancelled?'1':'0',b.dest||''].join('|');
  }
  function upsertWalletFromBooking(booking,list){
    if(!booking)return {added:false,updated:false,change:null};
    const existing=list.find(i=>i.mailId===booking.mailId||i.sourceId===booking.mailId||i.id==='mail:'+booking.mailId);
    const isStay=booking.kind==='hotel';
    const route=booking.flight?.from&&booking.flight?.to?`${booking.flight.from} → ${booking.flight.to}`:'';
    const title=booking.cancelled
      ?('Cancelled · '+(route||booking.subject.replace(/^re:\s*/i,'').slice(0,48)))
      :(isStay?(booking.subject.replace(/^re:\s*/i,'').slice(0,60)):(route||booking.subject.slice(0,60)));
    const note=[booking.cancelled?'CANCELLED':'',booking.flight?.flight,booking.flight?.depart?`Dep ${booking.flight.depart}`:'',booking.flight?.seat?`Seat ${booking.flight.seat}`:'',booking.from?.name,booking.dest&&`→ ${booking.dest}`].filter(Boolean).join(' · ');
    if(existing){
      const prevFp=existing._bookingFp||'';
      const nextFp=bookingFingerprint(booking);
      let change=null;
      if(booking.cancelled&&existing.status!=='cancelled')change={kind:'cancelled',field:'status',from:existing.status||'active',to:'cancelled'};
      else if(prevFp&&prevFp!==nextFp){
        if(String(existing.travelAt||'')!==new Date(booking.whenMs).toISOString())change={kind:'rescheduled',field:'travelAt',from:existing.travelAt,to:new Date(booking.whenMs).toISOString()};
        else if((existing.flight?.depart||'')!==(booking.flight?.depart||''))change={kind:'schedule_change',field:'depart',from:existing.flight?.depart||'',to:booking.flight?.depart||''};
        else change={kind:'updated',field:'booking',from:prevFp,to:nextFp};
      }
      existing.title=title;existing.note=note;existing.tripId=booking.tripId||existing.tripId;
      existing.travelAt=new Date(booking.whenMs).toISOString();
      existing.date=new Date(booking.whenMs).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
      existing.flight=booking.flight||existing.flight||null;
      existing.href=booking.href||existing.href;
      existing.status=booking.cancelled?'cancelled':'active';
      existing._bookingFp=nextFp;
      if(booking.linkedMailId)existing.linkedMailId=booking.linkedMailId;
      if(change){existing.lastChange=change;existing.updatedAt=new Date().toISOString()}
      return {added:false,updated:!!change,change};
    }
    const item=ensurePassCodes({
      id:'mail:'+booking.mailId,
      mailId:booking.mailId,sourceId:booking.mailId,threadId:booking.threadId,tripId:booking.tripId,
      title,kind:isStay?'documents':'tickets',note,
      org:booking.from?.name||(isStay?'Hotel':'Travel'),
      typeLabel:booking.kind==='hotel'?'Hotel booking':booking.kind==='train'?'Train ticket':'Flight ticket',
      number:booking.flight?.pnr?('#'+booking.flight.pnr):'',
      date:new Date(booking.whenMs).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}),
      travelAt:new Date(booking.whenMs).toISOString(),
      at:new Date().toISOString(),
      color:isStay?WALLET_COLORS.documents:WALLET_COLORS.tickets,
      href:booking.href,flight:booking.flight||null,
      barcode:booking.flight?.pnr||booking.mailId.slice(0,14),
      qrPayload:booking.flight?.pnr||booking.mailId,
      status:booking.cancelled?'cancelled':'active',
      _bookingFp:bookingFingerprint(booking)
    });
    list.unshift(item);return {added:true,updated:false,change:null};
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
      if(!trips[b.tripId])trips[b.tripId]={id:b.tripId,dest:b.dest||'',whenMs:b.whenMs,kinds:new Set(),mailIds:[],items:[]};
      const t=trips[b.tripId];
      t.kinds.add(b.kind);t.mailIds.push(b.mailId);t.items.push(b);
      if(b.whenMs<t.whenMs)t.whenMs=b.whenMs;
      if(!t.dest&&b.dest)t.dest=b.dest;
    });
    bookings.filter(b=>b.kind==='hotel').forEach(h=>{
      const mate=bookings.find(x=>x.kind!=='hotel'&&Math.abs(x.whenMs-h.whenMs)<6*86400000);
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
  function syncPaymentTaskSuggestions(){
    if(!loopsData)return 0;
    const money=computeMoney();
    const stamped=readJSON('daylight-pay-suggested',{});
    const amountMem=readJSON('daylight-pay-amounts',{});
    let n=0;
    const moneyChanges=[];
    [...money.subscription,...money.bill,...money.pending].forEach(item=>{
      if(!item.mailId)return;
      if(item.amount){
        const prev=amountMem[item.mailId];
        if(prev&&prev!==item.amount){
          moneyChanges.push({mailId:item.mailId,kind:'amount_change',field:'amount',from:prev,to:item.amount,title:item.title});
        }
        amountMem[item.mailId]=item.amount;
      }
      if(PRICE_CHANGE.test(item.subject||item.title||'')&&item.amount){
        moneyChanges.push({mailId:item.mailId,kind:'price_signal',field:'amount',from:null,to:item.amount,title:item.title});
      }
    });
    [...money.bill,...money.pending].forEach(item=>{
      if(!item.mailId)return;
      if(!item.amount&&!item.urgent&&item.kind!=='bill')return;
      if(stamped[item.mailId])return;
      if(personalTasks.some(t=>t.mailId===item.mailId||(t.project==='Payments'&&t.title.includes(item.title)))){stamped[item.mailId]=Date.now();return}
      const due=item.when&&!item.received?new Date(item.when).toISOString():'';
      personalTasks.unshift({
        id:crypto.randomUUID?.()||('pay-'+Date.now()),
        title:`Pay ${item.title}${item.amount?' · '+item.amount:''}`,
        dueDate:due,hasTime:false,project:'Payments',
        mailId:item.mailId,href:item.href,suggested:true,amount:item.amount||'',
        created:new Date().toISOString()
      });
      stamped[item.mailId]=Date.now();n++;
    });
    personalTasks.forEach(t=>{
      if(!t.mailId||t.project!=='Payments')return;
      const item=[...money.bill,...money.pending,...money.subscription].find(x=>x.mailId===t.mailId);
      if(!item)return;
      if(item.amount&&t.amount&&item.amount!==t.amount){
        moneyChanges.push({mailId:t.mailId,kind:'task_amount_update',field:'amount',from:t.amount,to:item.amount,title:t.title});
        t.amount=item.amount;t.title=`Pay ${item.title} · ${item.amount}`;
      }
    });
    if(n||moneyChanges.length)savePersonal();
    writeJSON('daylight-pay-suggested',stamped);
    writeJSON('daylight-pay-amounts',amountMem);
    loopsData.paymentSuggestions=personalTasks.filter(t=>t.suggested&&t.project==='Payments').slice(0,12);
    loopsData.moneyChanges=(loopsData.moneyChanges||[]).concat(moneyChanges).slice(-40);
    return n;
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
      [...(loopsData.inbox||[]),...(loopsData.financeMail||[]),...(loopsData.travelMail||[]),...(loopsData.docsMail||[])].forEach(m=>{
        if(!m?.id||mailPool.has(m.id))return;
        mailPool.set(m.id,m);
        const h=m.payload?.headers||[];
        const from=parseFrom(header(h,'From'));
        const subject=header(h,'Subject')||'(No subject)';
        const when=new Date(header(h,'Date')||m.internalDate*1);
        const tags=(m.labelIds||[]).slice(0,8);
        if(isFinance(m))tags.push('money');
        if(isDocs(m))tags.push('documents');
        entities.push({
          ...base,type:'mail',source:'gmail',
          sourceIds:{messageId:m.id,threadId:m.threadId||m.id},
          title:subject,subtitle:from.name||from.email||'',
          whenMs:isNaN(when)?null:when.getTime(),
          href:gmailLink(m.threadId||m.id),
          tags,
          privacyClass:isFinance(m)?Store.PRIVACY.FINANCIAL:(isDocs(m)?Store.PRIVACY.IDENTITY:Store.PRIVACY.NORMAL),
          payload:{fromEmail:from.email,snippet:String(m.snippet||'').slice(0,240)}
        });
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
    readWallet().forEach(w=>{
      if(!w?.id)return;
      const tags=w.kind?[w.kind]:[];
      entities.push({
        ...base,type:'wallet',source:'local',
        sourceIds:{walletId:w.id},
        title:w.title||'Pass',
        subtitle:w.typeLabel||w.org||w.kind||'',
        whenMs:w.travelAt?Date.parse(w.travelAt):(w.at?Date.parse(w.at):null),
        href:w.href||'',
        tripId:w.tripId||null,
        tags,
        privacyClass:w.kind==='documents'?Store.PRIVACY.IDENTITY:Store.PRIVACY.NORMAL,
        payload:{mailId:w.mailId||'',number:w.number||'',org:w.org||''}
      });
      if(w.mailId){
        relationships.push({
          ...base,fromId:Store.id.wallet(accountId,w.id),toId:Store.id.mail(accountId,w.mailId),type:'from_mail',
          confidence:0.95,confirmed:'auto',method:'rule',
          evidence:[{kind:'wallet_mailId'}],sourceIds:{walletId:w.id,messageId:w.mailId}
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
    scrollEl(){return document.scrollingElement||document.documentElement},
    saveTab(){if(!mq.matches)return;this.tabY[mTab]=this.scrollEl().scrollTop||window.scrollY||0},
    restoreTab(){if(!mq.matches)return;const y=this.tabY[mTab]||0;requestAnimationFrame(()=>{requestAnimationFrame(()=>{this.scrollEl().scrollTop=y;window.scrollTo(0,y)})})},
    topView(){return this.stack.length?this.stack[this.stack.length-1].view:null},
    isOpen(view){
      if(view==='loop')return!!$('#loop-sheet')?.classList.contains('show');
      if(view==='pass')return!!$('#pass-sheet')?.classList.contains('show');
      if(view==='scan')return!!(scanUI&&!scanUI.hidden&&scanUI.classList.contains('show'));
      return false;
    },
    anyOpen(){return this.isOpen('scan')||this.isOpen('pass')||this.isOpen('loop')},
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
      if(this.stack.length){this.backing=true;history.back();return true}
      if(this.anyOpen()){this.dismissTop();this.restoreTab();return true}
      return false;
    },
    /** Finish an interactive edge-swipe without double-animating */
    commitGesture(view,el){
      if(this.backing||!view)return;
      this.backing=true;this.silentPop=true;
      if(this.stack.length&&this.stack[this.stack.length-1].view===view)this.stack.pop();
      const root=view==='loop'?$('#loop-sheet'):view==='pass'?$('#pass-sheet'):scanUI;
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
    },
    dismissView(view){
      if(view==='loop')dismissLoopSheet();
      else if(view==='pass')dismissPassSheet();
      else if(view==='scan')dismissScan();
    },
    dismissInstant(view){
      if(view==='loop')dismissLoopSheet(true);
      else if(view==='pass')dismissPassSheet(true);
      else if(view==='scan')dismissScan(true);
    },
    drop(view){
      while(this.stack.length&&this.stack[this.stack.length-1].view===view)this.stack.pop();
    },
    sheetEl(view){
      if(view==='loop')return $('#loop-sheet')?.querySelector('.loop-sheet-card')||$('#loop-sheet');
      if(view==='pass')return $('#pass-sheet');
      if(view==='scan')return scanUI;
      return null;
    }
  };
  Nav._bind();
  if(history.state?.dl&&history.state.view){try{history.replaceState({dl:0,root:1},'')}catch{}}
  else if(!history.state?.dl){try{history.replaceState({dl:0,root:1},'')}catch{}}
  function setTab(t,opts){
    const soft=opts&&opts.soft;
    if(!soft&&t!==mTab){Nav.saveTab();feel.select()}
    mTab=t;setLS('daylight-mtab',t);$$('#mapp .m-screen').forEach(s=>s.hidden=s.dataset.screen!==t);$$('.m-tabs [data-tab]').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
    mapp.dataset.screen=t;$('#m-title').textContent=TITLES[t];
    const fab=$('#m-wallet-fab');if(fab)fab.hidden=t!=='wallet';
    const top=$('#mapp .m-top');if(top)top.hidden=t==='assistant';
    if(t!=='assistant'&&mAssistAsk)setAssistAsk(false);
    renderMobile();
    if(!soft)Nav.restoreTab();
  }
  function applyMode(){document.body.classList.toggle('m',mq.matches);if(mq.matches)setTab(mTab,{soft:true});else dispatchEvent(new Event('resize'))}
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
      const view=Nav.topView()||(Nav.isOpen('scan')?'scan':Nav.isOpen('pass')?'pass':Nav.isOpen('loop')?'loop':null);
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
  (function bindPullRefresh(){
    let startY=0,pulling=false,armed=false,busy=false;
    let ind=$('#m-ptr');
    if(!ind){ind=document.createElement('div');ind.id='m-ptr';ind.className='m-ptr';ind.innerHTML='<i></i><span>Pull to refresh</span>';ind.hidden=true;mapp.prepend(ind)}
    const atTop=()=>(Nav.scrollEl().scrollTop||window.scrollY||0)<=2;
    const reset=()=>{pulling=false;armed=false;ind.classList.remove('armed','loading');ind.hidden=true;ind.style.transform='';mapp.classList.remove('is-pulling')}
    document.addEventListener('touchstart',e=>{
      if(!mq.matches||Nav.anyOpen()||busy||!atTop())return;
      if(mTab!=='home'&&mTab!=='inbox'&&mTab!=='wallet')return;
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
        if(token||microsoftAccount){refreshAll.force=true;await refreshAll();toast('Updated',{type:'ok',haptic:'success',ms:1800})}
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
    if(l.weight>=2||l.type==='overdue')tags.push(['High','hot']);
    const short={reply:'Reply',followup:'Waiting',prepare:'Prepare',renewal:'Renewal',travel:'Trip',deadline:'Due'};
    if(short[l.type]&&l.type!=='overdue')tags.push([short[l.type],l.type==='deadline'?'warm':'']);
    if(l.type==='overdue')tags.push(['Reschedule','']);
    if(isFav(l.id))tags.push(['★','']);
    return tags;
  }
  function mobileLoopCard(l){
    const t=LOOP_TYPES[l.type]||LOOP_TYPES.reply,tags=loopTags(l);
    const meta=[srcOf(l),l.meta].filter(Boolean).join(' · ');
    return `<button type="button" class="m-row-card ${t.cls}" data-loop="${esc(l.id)}" data-open-loop="${esc(l.id)}">
      <span class="m-row-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <span class="m-row-main"><b>${esc(l.title)}</b><small>${esc(meta)}</small>${tags.length?`<span class="m-row-tags">${tags.map(([x,c])=>`<span class="atag ${c}">${esc(x)}</span>`).join('')}</span>`:''}</span>
      <span class="m-row-chev" aria-hidden="true">${svg(ICON.chevron,16)}</span>
    </button>`;
  }
  function renderHome(){
    const p=readProfile(),first=(p.name||'').split(' ')[0],h=new Date().getHours(),part=h<12?'Good morning':h<18?'Good afternoon':'Good evening';
    $('#m-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
    $('#m-hello').textContent=`${part}${first?', '+first:''}`;
    const WORK=['reply','followup','prepare','overdue','deadline'];
    const loops=(token||microsoftAccount||DEMO)?computeLoops().filter(l=>wset('loops').include!=='Work only'||WORK.includes(l.type)):[],money=computeMoney(),pendingPay=money.pending||[];
    const todo=loops.filter(l=>['reply','overdue','deadline'].includes(l.type)).length;
    const waiting=loops.filter(l=>l.type==='followup').length;
    const payments=pendingPay.length||(money.bill||[]).length;
    const upcoming=loops.filter(l=>l.type==='travel'||l.type==='prepare'||l.type==='renewal').length;
    const bits=[];
    if(!token&&!microsoftAccount&&!DEMO)bits.push('Connect Google to brief your day');
    else{
      if(todo)bits.push(`${todo} action${todo===1?'':'s'}`);
      if(payments)bits.push(`${payments} payment${payments===1?'':'s'}`);
      if(upcoming)bits.push(`${upcoming} upcoming`);
      if(!bits.length)bits.push('Nothing pressing today');
    }
    $('#m-brief').innerHTML=`<span class="m-brief-ico" aria-hidden="true">${svg(ICON.spark,18)}</span><span class="m-brief-copy"><b>Daily Brief</b><small>${esc(bits.join(' · '))}</small></span><span class="m-row-chev" aria-hidden="true">${svg(ICON.chevron,16)}</span>`;
    const stats=$('#m-home-stats');
    if(stats){
      stats.hidden=false;
      stats.innerHTML=`
        <button type="button" class="m-stat-pill" data-home-jump="todo"><b>${todo}</b><span>To Do</span></button>
        <button type="button" class="m-stat-pill" data-home-jump="waiting"><b>${waiting}</b><span>Waiting</span></button>
        <button type="button" class="m-stat-pill" data-home-jump="payments"><b>${payments}</b><span>Payments</span></button>
        <button type="button" class="m-stat-pill" data-home-jump="upcoming"><b>${upcoming}</b><span>Upcoming</span></button>`;
    }
    const grid=$('#m-loop-grid'),total=$('#m-loop-total'),see=$('#m-loops-see');
    if(!grid)return;
    if(total){total.textContent=loops.length||'';total.hidden=!loops.length}
    if(see)see.hidden=!loops.length;
    if(!token&&!microsoftAccount&&!DEMO&&!loops.length){grid.innerHTML='<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Your day is quiet</b><p>Connect Google to surface replies, renewals and trips.</p></div>';return}
    if(!loopsData&&token){grid.innerHTML=skelRows(4);return}
    const priority=loops.filter(l=>l.weight>=2||['reply','overdue','deadline'].includes(l.type));
    const rest=loops.filter(l=>!priority.includes(l));
    const ordered=[...priority,...rest];
    const lmax=loopsShowAll?ordered.length:4,shown=ordered.slice(0,lmax);
    grid.innerHTML=ordered.length?shown.map(mobileLoopCard).join(''):'<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>You’re caught up</b><p>No open loops right now.</p></div>';
    if(see){see.textContent='';see.innerHTML=loopsShowAll?`Show less ${svg(ICON.chevron,14)}`:`See All ${svg(ICON.chevron,14)}`}
  }
  $('#m-home-stats')?.addEventListener('click',e=>{
    const b=e.target.closest('[data-home-jump]');if(!b)return;feel.select();
    const j=b.dataset.homeJump;
    if(j==='payments'){setTab('inbox');mInboxFilter='payments';setLS('daylight-inbox-filter','payments');renderInbox({animate:false});return}
    if(j==='todo'||j==='waiting'||j==='upcoming'){const loops=(token||microsoftAccount||DEMO)?computeLoops():[];const hit=loops.find(l=>j==='todo'?['reply','overdue','deadline'].includes(l.type):j==='waiting'?l.type==='followup':['travel','prepare','renewal'].includes(l.type));if(hit)openLoopSheet(hit.id)}
  });
  $('#m-loop-grid')?.addEventListener('click',onLoopListClick);
  $('#m-loop-grid')?.addEventListener('keydown',onLoopListKey);
  $('#m-loops-see')?.addEventListener('click',()=>{loopsShowAll=!loopsShowAll;renderHome()});
  $('#m-brief')?.addEventListener('click',()=>{
    const money=computeMoney(),loops=(token||microsoftAccount||DEMO)?computeLoops():[];
    if((money.pending||[]).length){setTab('inbox');return}
    if(loops[0]){openLoopSheet(loops[0].id);return}
    setTab('assistant');ask('What needs my attention today?');
  });
  // Inbox — subscriptions, bills, payments
  function inboxItems(filter){
    const money=computeMoney();
    let list=filter==='subscription'?money.subscription:filter==='bill'?money.bill:filter==='payments'?[...money.pending,...money.store,...money.online]:money.all;
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
  function inboxCard(item){
    const initial=(item.title||'?').trim().slice(0,2).toUpperCase();
    const tag=item.kind==='pending'||item.urgent?inboxDaysLabel(item):(item.tag||MONEY_LABEL[item.kind]||inboxDaysLabel(item)||'');
    const tagCls=item.kind==='pending'||item.urgent?' is-urgent':item.kind==='subscription'?' is-sub':item.kind==='bill'?' is-bill':'';
    const snip=(item.snippet||item.subject||item.detail||'').replace(/\s+/g,' ').trim().slice(0,72);
    const amt=item.amount?`<span class="m-inbox-amt">${esc(item.amount)}</span>`:'';
    return `<div class="m-swipe" data-swipe-id="${esc(item.id)}">
      <div class="m-swipe-actions" aria-hidden="true">
        <button type="button" class="m-sw m-sw-snooze" data-sw="snooze" data-id="${esc(item.id)}">Snooze</button>
        <button type="button" class="m-sw m-sw-task" data-sw="task" data-id="${esc(item.id)}">Task</button>
        <button type="button" class="m-sw m-sw-arch" data-sw="archive" data-id="${esc(item.id)}">Done</button>
      </div>
      <button type="button" class="m-inbox-card${item.urgent||item.kind==='pending'?' is-urgent':''}" data-inbox-open="${esc(item.id)}">
        <span class="m-inbox-logo m-brand" style="--a1:${esc(item.color)};--a2:${esc(item.color)}" aria-hidden="true">${brandLogoHTML(item,initial)}</span>
        <span class="m-inbox-copy"><span class="m-inbox-top"><b>${esc(item.title)}</b><time>${esc(inboxAgo(item))}</time></span>
        <small>${esc(snip||inboxDateLabel(item)||'Open for details')}</small></span>
        <span class="m-inbox-side">${amt}${tag?`<span class="m-pill-tag${tagCls}">${esc(tag)}</span>`:''}</span>
      </button>
    </div>`;
  }
  const INBOX_ORDER=['all','subscription','bill','payments'];
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
    if(!token&&!microsoftAccount&&!DEMO){el.innerHTML='<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Connect to fill Inbox</b><p>Subscriptions, bills and payments from Gmail appear here.</p></div>';return}
    if(!loopsData&&token){el.innerHTML=skelRows(5);return}
    const items=inboxItems(mInboxFilter);
    if(!items.length){el.innerHTML=`<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Inbox is clear</b><p>${mInboxFilter==='all'?'Nothing needs attention right now.':'Nothing in this category.'}</p></div>`;return}
    const needs=items.filter(i=>i.kind==='pending'||i.urgent||(i.kind==='bill'&&!i.received));
    const needsIds=new Set(needs.map(i=>i.id));
    const week=items.filter(i=>!needsIds.has(i.id)&&!i.received&&i.when&&(i.when-localMidnight.getTime())<=14*86400000);
    const weekIds=new Set(week.map(i=>i.id));
    const recent=items.filter(i=>!needsIds.has(i.id)&&!weekIds.has(i.id));
    const block=(title,list)=>list.length?`<div class="m-inbox-sec"><h3 class="m-inbox-sec-h">${title}</h3><div class="m-inbox-list">${list.map(inboxCard).join('')}</div></div>`:'';
    el.innerHTML=block('Needs Attention',needs)+block('This Week',week)+block(mInboxFilter==='payments'?'Recent payments':'Recent',recent);
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
    const item=computeMoney().all.find(i=>i.id===b.dataset.inboxOpen);if(!item)return;
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
      if(!s.active){if(dy>12&&dy>Math.abs(dx)){s=null;return}if(Math.abs(dx)<8)return;s.active=true;$$('#m-inbox .m-swipe.open').forEach(r=>{if(r!==s.row)r.classList.remove('open')})}
      if(e.cancelable)e.preventDefault();
      const x=Math.min(0,Math.max(-108,s.start+dx));
      s.row.style.transition='none';
      const card=s.row.querySelector('.m-inbox-card');if(card)card.style.transform=`translate3d(${x}px,0,0)`;
      s.x=x;
    },{passive:false});
    const end=()=>{
      if(!s)return;
      const row=s.row,x=s.x||0,card=row.querySelector('.m-inbox-card');
      row.style.transition='';if(card){card.style.transition='transform .22s var(--ease-out,cubic-bezier(.22,.9,.28,1))';card.style.transform=''}
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
    const all=readWallet().slice().sort((a,b)=>new Date(b.at)-new Date(a.at));
    return filter==='all'?all:all.filter(i=>i.kind===filter);
  }
  const WALLET_ICO={tickets:ICON.calendar,coupons:'<path d="M4 9a2.5 2.5 0 0 0 0 5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3a2.5 2.5 0 0 0 0-5V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Z"/><path d="M9 12h.01M15 12h.01"/>',documents:'<path d="M8 4h6l4 4v12H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M13 4v5h5M10 13h5M10 17h3"/>',others:ICON.wallet};
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
    const when=item.at?new Date(item.at).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'';
    const ico=WALLET_ICO[item.kind]||WALLET_ICO.others;
    const exp=walletExpiryLabel(item);
    if(mode==='row'){
      return `<button type="button" class="m-wallet-row kind-${esc(item.kind||'others')}" data-wid="${esc(item.id)}">
        <span class="m-wallet-row-ico" style="--a1:${esc(color[0])};--a2:${esc(color[1])}" aria-hidden="true">${svg(ico,18)}</span>
        <span class="m-wallet-row-copy"><b>${esc(item.title)}</b><small>${esc([WALLET_LABEL[item.kind],exp||item.note||when].filter(Boolean).join(' · '))}</small></span>
        <span class="m-row-chev" aria-hidden="true">${svg(ICON.chevron,16)}</span>
      </button>`;
    }
    const img=item.image?`<img class="wp-thumb" src="${esc(item.image)}" alt="">`:(item.qrImage?`<img class="wp-thumb" src="${esc(item.qrImage)}" alt="">`:'');
    const route=item.flight&&(item.flight.from||item.flight.to)?`<div class="wp-route"><b>${esc(item.flight.from||'—')}</b><span>→</span><b>${esc(item.flight.to||'—')}</b></div>`:'';
    return `<article class="m-wallet-pass kind-${esc(item.kind||'others')}" data-wid="${esc(item.id)}" style="background:linear-gradient(145deg,${color[0]},${color[1]})">
      <div class="wp-top"><span class="wp-kind">${svg(ico,14)} ${esc(WALLET_LABEL[item.kind]||'Pass')}</span><span class="wp-when">${esc(exp||when)}</span></div>
      ${route||`<h3 class="wp-title">${esc(item.title)}</h3>`}
      ${route?`<p class="wp-note">${esc(item.title)}${item.flight?.flight?' · '+item.flight.flight:''}</p>`:(item.note?`<p class="wp-note">${esc(item.note)}</p>`:'')}
      ${img}
    </article>`;
  }
  function ensurePassCodes(item){
    if(!item)return item;
    const payload=item.qrPayload||item.barcode||item.number||item.id;
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
      });
    }
    const color=item.color||WALLET_COLORS[item.kind]||WALLET_COLORS.others;
    const f=item.flight||null;
    const org=item.org||item.pass?.org||'Daylight Pass';
    const typeLabel=item.typeLabel||item.pass?.typeLabel||WALLET_LABEL[item.kind]||'Pass';
    const number=item.number||item.pass?.number||'';
    const since=item.memberSince||item.pass?.memberSince||'';
    const expiry=item.expiry||item.pass?.expiry||item.date||'';
    const code=item.qrPayload||item.barcode||String(number||item.id).replace(/^#/,'');
    const fields=[];
    if(f){
      if(f.from||f.to)fields.push(['From',f.from||'—'],['To',f.to||'—']);
      if(f.flight)fields.push(['Flight',f.flight]);
      if(f.seat)fields.push(['Seat',f.seat]);
      if(f.coach)fields.push(['Coach',f.coach]);
      if(f.gate)fields.push(['Gate',f.gate]);
      if(f.depart)fields.push(['Depart',f.depart]);
      if(f.arrive)fields.push(['Arrive',f.arrive]);
      if(f.pnr)fields.push(['PNR',f.pnr]);
    }else{
      fields.push(['Type',typeLabel]);
      if(number)fields.push(['Number',number]);
      if(since)fields.push(['Member since',since]);
      if(expiry)fields.push(['Expiry',expiry]);
      if(item.amount)fields.push(['Amount',item.amount]);
    }
    const fieldHTML=fields.map(([k,v])=>`<div class="pass-field"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    const status=f?'Confirmed':(walletExpiryLabel(item)==='Expired'?'Expired':'Active');
    const statusCls=status==='Confirmed'||status==='Active'?'is-ok':status==='Expired'?'is-bad':'';
    $('#pass-scroll').innerHTML=`
      <article class="pass-card kind-${esc(item.kind||'others')}" style="--p1:${esc(color[0])};--p2:${esc(color[1])}">
        <div class="pass-brand"><span class="pass-logo" aria-hidden="true">${esc((org||'D')[0])}</span><span>${esc(org)}</span><span class="pass-status ${statusCls}">${esc(status)}</span></div>
        ${f?`<div class="pass-route"><div><small>From</small><b>${esc(f.from||'—')}</b></div><span aria-hidden="true">→</span><div><small>To</small><b>${esc(f.to||'—')}</b></div></div>
        <p class="pass-flight-line">${esc([f.flight,item.title].filter(Boolean).join(' · '))}</p>`:
        `<div class="pass-hero"><div><h2>${esc(item.title)}</h2><p>${esc(item.note||typeLabel)}</p></div>${item.image?`<img class="pass-photo" src="${esc(item.image)}" alt="">`:''}</div>`}
        <div class="pass-fields">${fieldHTML}</div>
        <div class="pass-code">
          ${item.qrImage||code?`<div class="pass-qr-wrap"><img class="pass-qr" src="${esc(item.qrImage||qrUrl(code,240))}" alt="QR code"></div>`:''}
          ${item.barcodeImage||code?`<img class="pass-bar" src="${esc(item.barcodeImage||barcodeUrl(code))}" alt="Barcode">`:''}
          <span class="pass-code-id">${esc(number||code||'')}</span>
        </div>
        ${item.image&&f?`<img class="pass-scan-preview" src="${esc(item.image)}" alt="Original scan">`:''}
      </article>
      <div class="pass-meta-foot">
        <div><span>Type</span><b>${esc(typeLabel)}</b></div>
        <div><span>Expiry</span><b>${esc(expiry||walletExpiryLabel(item)||'—')}</b></div>
      </div>
      <div class="pass-actions">
        <button type="button" class="connect primary" data-pass-cal>Add to Calendar</button>
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
    const pinned=items.filter(i=>i.kind==='tickets'||i.flight).slice(0,3);
    const pinnedIds=new Set(pinned.map(i=>i.id));
    const recent=items.filter(i=>!pinnedIds.has(i.id));
    el.innerHTML=`
      ${pinned.length?`<div class="m-wallet-sec"><h3 class="m-inbox-sec-h">Pinned</h3><div class="m-wallet-list">${pinned.map(i=>walletPassHTML(i,'card')).join('')}</div></div>`:''}
      <div class="m-wallet-sec"><h3 class="m-inbox-sec-h">${pinned.length?'Recent':'Passes'}</h3><div class="m-wallet-rows">${(pinned.length?recent:items).map(i=>walletPassHTML(i,pinned.length?'row':'card')).join('')||'<div class="m-empty">No other items.</div>'}</div></div>`;
  }
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
    const code=ex.qrPayload||ex.barcode||(ocrFlight&&ocrFlight.pnr)||'';
    const item=ensurePassCodes({
      id:'w'+Date.now(),title,kind,note,amount,date,ocr,at:new Date().toISOString(),image:scanDraft,
      color:WALLET_COLORS[kind]||WALLET_COLORS.documents,
      org:ocrPass.org||ex.pass?.org||'',typeLabel:ocrPass.typeLabel||ex.pass?.typeLabel||WALLET_LABEL[kind],
      number:ocrPass.number||ex.pass?.number||'',memberSince:ocrPass.memberSince||'',expiry:ocrPass.expiry||date||'',
      barcode:code,qrPayload:code,barcodeFormat:ex.barcodeFormat||'',barcodes:ex.barcodes||[],
      qrImage:ex.qrImage||'',barcodeImage:ex.barcodeImage||'',flight:ocrFlight
    });
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
  async function weekEvents(ws){const k=ws.toISOString();if(mWeekCache[k])return mWeekCache[k];if(!token)return [];const ev=await eventsBetween(ws,new Date(ws.getTime()+7*86400000))||[];mWeekCache[k]=ev;setTimeout(()=>delete mWeekCache[k],5*60000);return ev}
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
    const wrap=$('#tl-chat-wrap'),view=$('#tl-view'),btn=$('#tl-ask-btn'),mini=$('#tl-ask-mini');
    if(wrap)wrap.hidden=!mAssistAsk;
    if(view)view.hidden=!!mAssistAsk;
    btn?.setAttribute('aria-expanded',mAssistAsk?'true':'false');
    btn?.classList.toggle('on',mAssistAsk);
    mini?.classList.toggle('on',mAssistAsk);
    if(mAssistAsk){if(!mChat.length)chatHello();else renderChat();$('#m-msg-input')?.focus()}
  }
  function paintAssistCal(){
    const ws=assistWeekStart(mAssistDay),days=[...Array(7)].map((_,i)=>new Date(ws.getTime()+i*86400000));
    const monthEl=$('#tl-cal-month');if(monthEl)monthEl.textContent=mAssistDay.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    const week=$('#tl-week');if(!week)return;
    week.innerHTML=days.map(d=>{
      const on=dayKey(d)===dayKey(mAssistDay),today=dayKey(d)===dayKey(localMidnight);
      return `<button type="button" class="tl-day${on?' on':''}${today?' is-today':''}" data-tl-day="${d.toISOString()}" role="tab" aria-selected="${on?'true':'false'}"><span>${d.toLocaleDateString(undefined,{weekday:'short'})}</span><b>${d.getDate()}</b></button>`;
    }).join('');
  }
  async function dayTimelineItems(day){
    const start=new Date(day.getFullYear(),day.getMonth(),day.getDate());
    const end=new Date(start.getTime()+86400000);
    const items=[];
    const seen=new Set();
    const push=it=>{if(seen.has(it.id))return;seen.add(it.id);items.push(it)};
    if(token){
      try{
        const ev=await eventsBetween(start,end)||[];
        ev.forEach(e=>{
          const s=new Date(e.start?.dateTime||e.start?.date+'T09:00:00');
          const en=new Date(e.end?.dateTime||e.end?.date||s);
          const allDay=!e.start?.dateTime;
          const mail=loopsData?.meetingMail?.[e.id];
          push({
            id:'ev:'+(e.id||s.getTime()),kind:TRAVEL.test((e.summary||'')+' '+(e.location||''))?'travel':(e.attendees||[]).length>1?'meet':'event',
            title:e.summary||'(No title)',start:s,end:en,allDay,
            meta:[e.location||'',mail?`Mail: ${mail.subject}`:''].filter(Boolean).join(' · '),
            href:e.htmlLink||'',loopId:mail?undefined:undefined,relatedMail:mail||null
          });
        });
      }catch{}
    }
    personalTasks.filter(t=>t.dueDate&&dayKey(new Date(t.dueDate))===dayKey(start)).forEach(t=>{
      const s=new Date(t.dueDate);
      push({id:'task:'+t.id,kind:t.project==='Payments'?'bill':'task',title:t.title,start:s,end:s,allDay:!t.hasTime,meta:t.project||'Reminder',href:t.href||''});
    });
    try{
      readWallet().forEach(w=>{
        const when=w.travelAt||w.date;if(!when)return;
        const s=new Date(w.travelAt||w.at);if(isNaN(s)||dayKey(s)!==dayKey(start))return;
        push({
          id:'wallet:'+w.id,kind:'travel',title:w.title,start:s,end:s,allDay:!w.flight?.depart,
          meta:[w.typeLabel||WALLET_LABEL[w.kind],w.tripId?'Trip linked':''].filter(Boolean).join(' · '),
          href:w.href||'',walletId:w.id
        });
      });
    }catch{}
    if(token||microsoftAccount||DEMO){
      computeLoops().forEach(l=>{
        const ms=l.travelWhenMs||l.whenMs;if(!ms||dayKey(new Date(ms))!==dayKey(start))return;
        const s=new Date(ms);
        push({id:'loop:'+l.id,kind:l.type==='travel'?'travel':l.type==='renewal'?'bill':'loop',title:l.title,start:s,end:s,allDay:false,meta:l.meta||srcOf(l),href:l.href||'',loopId:l.id});
      });
    }
    return items.sort((a,b)=>(a.allDay-b.allDay)||(a.start-b.start));
  }
  function tlIcon(kind){
    if(kind==='travel')return ICON.suitcase;
    if(kind==='meet')return ICON.chat;
    if(kind==='task')return ICON.spark;
    if(kind==='bill')return ICON.wallet;
    return ICON.phone;
  }
  function tlCard(item){
    const time=item.allDay?'All day':`${hm(item.start)}${item.flight?.depart?'' :(item.end&&item.end-item.start>60*1000?' – '+hm(item.end):'')}`;
    const thumb=`<span class="tl-thumb kind-${esc(item.kind)}" aria-hidden="true">${svg(tlIcon(item.kind),18)}</span>`;
    const open=item.loopId?`data-open-loop="${esc(item.loopId)}"`:(item.walletId?`data-open-wallet="${esc(item.walletId)}"`:(item.href?`data-tl-href="${esc(item.href)}"`:''));
    return `<article class="tl-card" ${open}>
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
    const label=$('#tl-date-label'),heading=$('#tl-heading'),list=$('#tl-list'),count=$('#tl-count'),countN=$('#tl-count-n');
    if(!list)return;
    const same=dayKey(mAssistDay)===dayKey(localMidnight);
    const dateTxt=mAssistDay.toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'});
    if(label)label.textContent=same?'Today':dateTxt;
    if(heading)heading.textContent=`${dateTxt} · ${mAssistDay.toLocaleDateString(undefined,{weekday:'short'})}`;
    paintAssistCal();
    list.innerHTML=skelRows(4);
    const items=await dayTimelineItems(mAssistDay);
    if(count&&countN){countN.textContent=String(items.length);count.hidden=!items.length}
    if(!items.length){
      list.innerHTML=`<div class="m-empty m-empty-illus"><div class="m-empty-art" aria-hidden="true"></div><b>Nothing on this day</b><p>${token?'No calendar events or tasks.':'Connect Google to fill your timeline.'}</p></div>`;
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
  $('#tl-date-btn')?.addEventListener('click',()=>{
    const cal=$('#tl-cal'),btn=$('#tl-date-btn');if(!cal||!btn)return;
    const open=cal.hidden;cal.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');btn.classList.toggle('on',open);feel.select();
    if(open)paintAssistCal();
  });
  $('#tl-cal')?.addEventListener('click',e=>{
    const wk=e.target.closest('[data-tl-wk]');
    if(wk){mAssistDay=new Date(mAssistDay.getTime()+(+wk.dataset.tlWk)*7*86400000);paintAssistCal();feel.select();return}
    const day=e.target.closest('[data-tl-day]');if(!day)return;
    mAssistDay=new Date(day.dataset.tlDay);feel.select();
    const cal=$('#tl-cal'),btn=$('#tl-date-btn');
    if(cal)cal.hidden=true;btn?.setAttribute('aria-expanded','false');btn?.classList.remove('on');
    if(mAssistAsk)setAssistAsk(false);
    renderAssistant();
  });
  const toggleAsk=()=>{feel.select();setAssistAsk(!mAssistAsk)};
  $('#tl-ask-btn')?.addEventListener('click',toggleAsk);
  $('#tl-ask-mini')?.addEventListener('click',toggleAsk);
  $('#tl-list')?.addEventListener('click',e=>{
    const loop=e.target.closest('[data-open-loop]');if(loop){openLoopSheet(loop.dataset.openLoop);return}
    const w=e.target.closest('[data-open-wallet]');if(w){feel.select();setTab('wallet');openPassSheet(w.dataset.openWallet);return}
    const a=e.target.closest('[data-tl-href]');if(a)window.open(a.dataset.tlHref,'_blank','noopener');
  });
  // Statistics
  async function renderStats(){
    const el=$('#m-stats'),now=new Date(),ws=new Date(localMidnight.getTime()-6*86400000);
    const doneLog=readJSON('daylight-done-log',[]).filter(d=>new Date(d.at)>=ws),focus=readJSON('daylight-focus-log',[]).filter(d=>new Date(d.at)>=ws);
    const perDay=[...Array(7)].map((_,i)=>{const d=new Date(ws.getTime()+i*86400000),e=new Date(d.getTime()+86400000);return {d,n:doneLog.filter(x=>{const t=new Date(x.at);return t>=d&&t<e}).length}});
    const maxN=Math.max(1,...perDay.map(x=>x.n)),fmin=focus.reduce((a,b)=>a+(+b.min||0),0);
    let meet=null;if(token){const ev=await eventsBetween(ws,now)||[];const m=ev.filter(e=>e.start?.dateTime&&(e.attendees||[]).length>1);meet={n:m.length,h:m.reduce((a,e)=>a+(new Date(e.end?.dateTime||e.start.dateTime)-new Date(e.start.dateTime))/3600000,0)}}
    const loops=(token||microsoftAccount)?computeLoops():[],by=t=>loops.filter(l=>l.type===t).length;
    el.innerHTML=`<div class="m-dt">Last 7 days</div>
      <div class="m-kpis"><div class="m-kpi"><b>${doneLog.length}</b><span>tasks completed</span></div><div class="m-kpi"><b>${fmin>=60?Math.floor(fmin/60)+'h '+(fmin%60)+'m':fmin+'m'}</b><span>focus time</span></div><div class="m-kpi"><b>${meet?meet.n:'—'}</b><span>meetings</span></div><div class="m-kpi"><b>${meet?meet.h.toFixed(1)+'h':'—'}</b><span>in meetings</span></div></div>
      <div class="m-card"><div class="m-card-h">Completed per day</div><div class="m-bars">${perDay.map(x=>`<div class="m-barcol"><i style="height:${Math.round(x.n/maxN*100)}%"></i><span>${x.d.toLocaleDateString(undefined,{weekday:'narrow'})}</span></div>`).join('')}</div><div class="m-note">Counts tasks you tick off in Daylight, from today on.</div></div>
      <div class="m-card"><div class="m-card-h">Open loops right now</div>${[['reply','Waiting for your reply'],['followup','Waiting on others'],['overdue','Overdue'],['deadline','Due soon'],['prepare','Meetings to prepare'],['renewal','Renewals'],['travel','Trips']].map(([t,l])=>`<div class="m-row"><span>${l}</span><b>${by(t)}</b></div>`).join('')}</div>`;
  }
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
  { const b=document.createElement('button');b.className='menu-item m-only';b.type='button';b.id='m-widgets';b.innerHTML='<span class="mi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg></span>All widgets';
    $('.menu-list')?.prepend(b);b.onclick=()=>{document.body.classList.add('m-widgets');$$('.m-tabs [data-tab]').forEach(x=>x.classList.remove('on'));$('#menu-btn').click();scrollTo(0,0);setTimeout(()=>dispatchEvent(new Event('resize')),60)};
    $$('.m-tabs [data-tab]').forEach(x=>x.addEventListener('click',()=>document.body.classList.remove('m-widgets'))) }
  setInterval(renderMobile,60000);
  applyMode();
})();

