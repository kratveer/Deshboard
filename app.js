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
    'https://www.googleapis.com/auth/gmail.metadata',
    'https://www.googleapis.com/auth/tasks.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/contacts.readonly'
  ].join(' ');
  const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const toast = (s) => { const e=$('#toast'); e.textContent=s; e.classList.add('show'); setTimeout(()=>e.classList.remove('show'),2800); };
  const date = new Date();
  const localMidnight = new Date(date.getFullYear(),date.getMonth(),date.getDate());
  const tomorrow = new Date(date.getFullYear(),date.getMonth(),date.getDate()+1);
  const iso = d => d.toISOString();
  $('#sync-status').textContent='Not connected · connect Google to load your personal data';
  $('#task-count').textContent='—';
  $('#done-count').textContent='—';
  $('#events').innerHTML='<div class="empty">Connect Google Calendar to see today’s events.</div>';
  $('.task-list').innerHTML='<div class="empty">Connect Google Tasks to see your tasks.</div>';
  $('.mail-list').innerHTML='<div class="empty">Connect Gmail to see recent inbox messages.</div>';
  $('#headline-note').innerHTML='Connect your apps to see your day';
  $('#connections').setAttribute('aria-label','Connect your apps');
  const weatherCard=document.createElement('article');
  weatherCard.className='card weather'; weatherCard.dataset.widget='weather';
  weatherCard.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue">☀</span>Local weather</div><button class="connect" id="weather-connect">Use my location</button></div><div id="weather-content" class="empty">Share your location to see today’s weather.</div>';
  $('#layout').append(weatherCard);

  function connectDialog() {
    const g=Boolean(token), ms=Boolean(microsoftAccount), staying=Boolean(serverSession), prof=readProfile();
    const msReady=Boolean(localStorage.getItem('daylight-ms-client-id'));
    const row=(id,icon,iconCls,name,sub,connected,btn)=>`<div class="conn-row${connected?' is-on':''}"><div class="provider-icon ${iconCls}">${icon}</div><div class="provider-copy"><b>${name}</b><span>${sub}</span></div>${btn}</div>`;
    $('#overlay').innerHTML=`<div class="modal connections-modal" role="dialog" aria-label="Connections"><div class="modal-top"><h3>Connections</h3><button class="modal-x" id="close-modal" aria-label="Close">×</button></div>
      ${row('google','G','google-icon','Google',g?`<span class="dot"></span>${staying?'Connected · stays signed in':'Connected for about an hour'}${prof.email?' · '+esc(prof.email):''}`:'Calendar · Gmail · Tasks · Drive · Contacts',g,g?'<button class="connect ghost" id="google-disconnect" type="button">Disconnect</button>':'<button class="connect primary" id="google-connect" type="button">Connect</button>')}
      ${row('microsoft','M','ms-icon','Microsoft 365',ms?'<span class="dot"></span>Connected':'Outlook · Calendar · To Do',ms,ms?'<button class="connect ghost" id="microsoft-disconnect" type="button">Disconnect</button>':`<button class="connect ${msReady?'primary':''}" id="microsoft-connect" type="button">${msReady?'Connect':'Set up'}</button>`)}
      <div id="connect-error" class="error" role="alert"></div>
      <details class="conn-more"><summary>What Daylight can see</summary><ul class="conn-list"><li>Today’s calendar events</li><li>Sender and subject of recent emails, never the message text</li><li>Open tasks, recently opened Drive file names, and contact birthdays</li><li>Everything is read only. Data goes straight from Google or Microsoft to this page.</li></ul><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></details>
      <details class="conn-more" id="conn-advanced"><summary>Advanced setup</summary>
        <label class="client-label" for="server-url">Daylight server <small>keeps you signed in</small></label><input class="client-input" id="server-url" type="url" placeholder="https://daylight-api.your-name.workers.dev" value="${esc(serverUrl)}">
        <label class="client-label" for="client-id">Google OAuth client ID <small>used when no server is set</small></label><input class="client-input" id="client-id" type="text" placeholder="1234567890-abc.apps.googleusercontent.com" value="${esc(localStorage.getItem('daylight-client-id')||'')}">
        <label class="client-label" for="ms-client-id">Microsoft application ID</label><input class="client-input" id="ms-client-id" type="text" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(localStorage.getItem('daylight-ms-client-id')||'')}">
        <div class="server-actions"><button class="connect" type="button" id="advanced-save">Save</button><a href="https://github.com/kratveer/Deshboard#readme" target="_blank" rel="noopener">Setup guide</a></div>
      </details></div>`;
    $('#overlay').classList.add('show');
    const err=m=>{$('#connect-error').textContent=m};
    const saveAdvanced=()=>{const u=$('#server-url').value.trim().replace(/\/+$/,'');if(u&&!/^https:\/\/[^/]+$|^http:\/\/localhost(:\d+)?$/.test(u)){err('The server address should look like https://daylight-api.your-name.workers.dev');return false}
      setLS('daylight-api',u);serverUrl=u;const c=$('#client-id').value.trim();setLS('daylight-client-id',c);setLS('daylight-ms-client-id',$('#ms-client-id').value.trim());err('');return true};
    $('#close-modal').onclick=()=>$('#overlay').classList.remove('show');
    $('#advanced-save').onclick=()=>{if(saveAdvanced()){toast('Settings saved on this device');connectDialog()}};
    if($('#google-connect'))$('#google-connect').onclick=()=>{if(!saveAdvanced())return;
      if(serverUrl){location.href=serverUrl+'/auth/google/start?return='+encodeURIComponent(location.origin+location.pathname);return}
      if(!$('#client-id').value.trim()){$('#conn-advanced').open=true;err('Add your Daylight server or a Google client ID under Advanced setup.');return}
      authorize()};
    if($('#google-disconnect'))$('#google-disconnect').onclick=disconnectGoogle;
    if($('#microsoft-connect'))$('#microsoft-connect').onclick=()=>{saveAdvanced();if(!$('#ms-client-id').value.trim()){$('#conn-advanced').open=true;err('Add your Microsoft application ID under Advanced setup first.');return}authorizeMicrosoft()};
    if($('#microsoft-disconnect'))$('#microsoft-disconnect').onclick=async()=>{try{await microsoftApp?.clearCache({account:microsoftAccount})}catch{}microsoftAccount=null;microsoftApp=null;providerData.microsoft={events:null,mails:null,tasks:null};renderAll();$('#connections').classList.toggle('active',Boolean(token));connectDialog();toast('Microsoft disconnected')};
  }
  async function disconnectGoogle(){
    if(serverSession){try{await fetch(serverUrl+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+serverSession}})}catch{}serverSession='';setLS('daylight-session','');clearTimeout(serverRenew)}
    token=null;providerData.google={events:null,mails:null,tasks:null};loopsData=null;renderAll();clearProfile();
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
      if(token){const u=await api('https://www.googleapis.com/oauth2/v3/userinfo');if(u.name||u.picture){setLS('daylight-profile',JSON.stringify({name:u.name||'',picture:u.picture||'',email:u.email||''}));renderProfile();return}}
      if(microsoftAccount){const me=await graph('/me?$select=displayName,mail,userPrincipalName');let picture='';
        try{const t=await microsoftToken();const r=await fetch('https://graph.microsoft.com/v1.0/me/photos/96x96/$value',{headers:{Authorization:'Bearer '+t}});if(r.ok){const b=await r.blob();picture=await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(b)})}}catch{}
        setLS('daylight-profile',JSON.stringify({name:me.displayName||'',picture,email:me.mail||me.userPrincipalName||''}));renderProfile()}
    }catch{/* older sign-ins may lack profile access; keep the letter */}
  }
  $('#connections').onclick=connectDialog;
  $('#close')?.addEventListener('click',()=>$('#overlay').classList.remove('show'));
  $('#overlay').onclick=e=>{if(e.target.id==='overlay')$('#overlay').classList.remove('show')};

  function authorize() {
    const clientId=$('#client-id').value.trim();
    if(!clientId.endsWith('.apps.googleusercontent.com')) { $('#connect-error').textContent='Enter your Google OAuth Client ID first.'; return; }
    localStorage.setItem('daylight-client-id',clientId);
    if(!window.google?.accounts?.oauth2) { $('#connect-error').textContent='Google sign-in is still loading. Try again in a moment.'; return; }
    tokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:scopes,include_granted_scopes:true,callback:async response=>{
      if(response.error){$('#connect-error').textContent='Google authorization failed: '+response.error;return;}
      token=response.access_token;$('#overlay').classList.remove('show');$('#connections').classList.add('active');$('#sync-status').textContent='Google connected · refreshing…';setTimeout(()=>{token=null;$('#connections').classList.remove('active');$('#sync-status').textContent='Google access expired · reconnect to refresh';},Math.max(0,(Number(response.expires_in||3600)-60)*1000));await refreshAll();
    }});
    tokenClient.requestAccessToken({prompt:'consent'});
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
  async function api(url, retried) {
    if(serverSession&&Date.now()>tokenExpiry-60000)await serverToken();
    const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    if(r.status===401&&serverSession&&!retried&&await serverToken())return api(url,true);
    if(!r.ok){let detail='';try{detail=(await r.json()).error?.message||''}catch{}throw new Error(detail||`Google API error (${r.status})`)}
    return r.json();
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
    const lists=await api('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=5');const groups=await Promise.all((lists.items||[]).slice(0,3).map(l=>api(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=20`)));
    providerData.google.tasks=groups.flatMap((g,i)=>(g.items||[]).filter(t=>t.status!=='completed').map(t=>({title:t.title,due:t.due?new Date(t.due).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'',dueDate:t.due||'',listName:lists.items[i].title,source:'Google Tasks'}))).slice(0,8);renderTasks();
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
    if(!token&&!microsoftAccount)return;$('#sync-status').textContent=`Connected to ${[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean).join(' and ')} · refreshing…`;
    const jobs=[];if(token)jobs.push(loadCalendar(),loadMail(),loadTasks(),loadDrive(),loadBirthdays(),loadLoops(refreshAll.force));refreshAll.force=false;loadProfile();if(microsoftAccount)jobs.push(loadMicrosoftCalendar(),loadMicrosoftMail(),loadMicrosoftTasks());
    const results=await Promise.allSettled(jobs);const failed=results.filter(r=>r.status==='rejected');renderAll();
    const eventCount=(providerData.google.events||[]).length+(providerData.microsoft.events||[]).length,mailCount=(providerData.google.mails||[]).length+(providerData.microsoft.mails||[]).length,taskCount=(providerData.google.tasks||[]).length+(providerData.microsoft.tasks||[]).length;
    $('#headline-note').innerHTML=`Today: <b>${eventCount} events</b> · <b>${mailCount} inbox messages</b> · <b>${taskCount} open tasks</b>`;
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
  const RENEWAL=/\b(renew(al|s|ing)?|subscription|trial (ends|ending|expires)|expir(es|ing|ation)|payment (due|failed|reminder)|invoice|bill(ing)? (due|reminder)|auto-?renew)/i;
  const TRAVEL=/\b(booking|reservation|itinerary|e-?ticket|boarding pass|flight|train|check-?in|hotel|airbnb)\b/i;
  const DEADLINE=/\b(deadline|due|submit|submission)\b/i;
  var loopsData=null,loopsFetched=0,loopsShowAll=false;
  const loopState=()=>readJSON('daylight-loops',{});
  const saveLoopState=s=>{const now=Date.now();Object.keys(s).forEach(k=>{if(s[k].t&&now-s[k].t>30*86400000)delete s[k]});writeJSON('daylight-loops',s)};
  const parseFrom=v=>{const m=/^\s*"?([^"<]*)"?\s*<([^>]+)>/.exec(v||'');return m?{name:m[1].trim()||m[2],email:m[2].toLowerCase()}:{name:(v||'').trim(),email:(v||'').trim().toLowerCase()}};
  const gmailLink=id=>`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
  async function loadLoops(force){
    if(!token)return 0;
    if(!force&&loopsData&&Date.now()-loopsFetched<3*60000){renderLoops();return 0}
    const G='https://gmail.googleapis.com/gmail/v1/users/me';
    const meta=id=>api(`${G}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`);
    const inbox=await api(`${G}/messages?labelIds=INBOX&maxResults=25`).then(r=>Promise.all((r.messages||[]).map(m=>meta(m.id)))).catch(()=>[]);
    const sent=await api(`${G}/messages?labelIds=SENT&maxResults=15`).catch(()=>({messages:[]}));
    const threadIds=[...new Set((sent.messages||[]).map(m=>m.threadId))].slice(0,12);
    const threads=await Promise.all(threadIds.map(t=>api(`${G}/threads/${encodeURIComponent(t)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`).catch(()=>null)));
    const calU=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    calU.searchParams.set('timeMin',new Date().toISOString());calU.searchParams.set('timeMax',new Date(localMidnight.getTime()+8*86400000).toISOString());calU.searchParams.set('singleEvents','true');calU.searchParams.set('orderBy','startTime');calU.searchParams.set('maxResults','40');
    const upcoming=await api(calU).then(r=>r.items||[]).catch(()=>[]);
    loopsData={inbox,threads:threads.filter(Boolean),upcoming,files:{}};
    // look for a related Drive file for the next few meetings
    const meetings=upcoming.filter(e=>(e.attendees||[]).length>1&&e.start?.dateTime&&new Date(e.start.dateTime)<new Date(localMidnight.getTime()+2*86400000)).slice(0,3);
    await Promise.all(meetings.map(async e=>{const word=(e.summary||'').split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=5).sort((a,b)=>b.length-a.length)[0];if(!word)return;
      try{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',`name contains '${word.replace(/'/g,"\\'")}' and trashed=false`);u.searchParams.set('pageSize','1');u.searchParams.set('orderBy','modifiedTime desc');u.searchParams.set('fields','files(name,webViewLink)');
        const f=(await api(u)).files?.[0];if(f)loopsData.files[e.id]=f}catch{}}));
    loopsFetched=Date.now();renderLoops();return computeLoops().length;
  }
  function computeLoops(){
    const out=[],now=Date.now(),day=86400000;
    const add=(type,id,title,detail,meta,href,extra={})=>out.push({type,id:type+':'+id,title,detail,meta,href,...extra});
    if(loopsData){
      loopsData.inbox.forEach(m=>{const h=m.payload?.headers||[],from=parseFrom(header(h,'From')),subject=header(h,'Subject')||'(No subject)',when=new Date(header(h,'Date')||m.internalDate*1),age=now-when,labels=m.labelIds||[];
        const primary=labels.includes('CATEGORY_PERSONAL')||!labels.some(l=>/^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l));
        if(RENEWAL.test(subject)&&age<30*day){add('renewal',m.threadId,`Review: ${subject}`,`From ${from.name}`,ago(when),gmailLink(m.threadId));return}
        if(TRAVEL.test(subject)&&age<21*day){add('travel',m.threadId,subject,`From ${from.name} · check dates, tickets and where you’re staying`,ago(when),gmailLink(m.threadId));return}
        if(primary&&!AUTOMATED.test(from.email)&&(labels.includes('UNREAD')||labels.includes('IMPORTANT')||labels.includes('STARRED'))&&age>2*3600000&&age<14*day)
          add('reply',m.threadId,`Reply to ${from.name}`,subject,`waiting ${ago(when).replace(' ago','')}`,gmailLink(m.threadId),{weight:labels.includes('IMPORTANT')||labels.includes('STARRED')?2:1});
      });
      loopsData.threads.forEach(t=>{const msgs=t.messages||[],last=msgs.at(-1);if(!last||!(last.labelIds||[]).includes('SENT'))return;
        const h=last.payload?.headers||[],when=new Date(header(h,'Date')||last.internalDate*1),age=now-when;if(age<3*day||age>14*day)return;
        const to=parseFrom((header(h,'To')||'').split(',')[0]);if(!to.email||AUTOMATED.test(to.email))return;
        add('followup',t.id,`Follow up with ${to.name}`,header(h,'Subject')||'(No subject)',`no reply for ${Math.floor(age/day)} days`,gmailLink(t.id))});
      loopsData.upcoming.forEach(e=>{const st=new Date(e.start?.dateTime||e.start?.date),title=e.summary||'(No title)',days=Math.floor((st-localMidnight)/day);
        const when=days===0?'Today':days===1?'Tomorrow':st.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});
        const time=e.start?.dateTime?' · '+hm(st):'';
        if((e.attendees||[]).length>1&&e.start?.dateTime&&days<=1&&st>now){const f=loopsData.files[e.id];
          add('prepare',e.id,`Prepare for ${title}`,`${when}${time} · ${(e.attendees||[]).length} people`,'',e.htmlLink,f?{related:f}:{})}
        if(DEADLINE.test(title)&&days<=3)add('deadline',e.id,title,`${when}${time}`,'',e.htmlLink);
        if(TRAVEL.test(title+' '+(e.location||''))&&days<=7)add('travel',e.id,title,`${when}${time}${e.location?' · '+e.location:''} · tickets and accommodation sorted?`,'',e.htmlLink);
      });
    }
    const dueDay=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[]),...personalTasks.filter(t=>t.dueDate).map(t=>({...t,source:'Daylight'}))].forEach((t,i)=>{if(!t.dueDate)return;const d=dueDay(t.dueDate),href=t.source==='Daylight'?'':t.source==='Microsoft To Do'?'https://to-do.office.com/':'https://tasks.google.com/';
      if(d<localMidnight)add('overdue',t.title+i,`Reschedule: ${t.title}`,`Was due ${d.toLocaleDateString(undefined,{day:'numeric',month:'short'})}`,'',href);
      else if(d<new Date(localMidnight.getTime()+2*day))add('deadline',t.title+i,t.title,d<tomorrow?'Due today':'Due tomorrow','',href)});
    const st=loopState(),order={overdue:0,deadline:1,reply:2,prepare:3,followup:4,renewal:5,travel:6};
    const seen=new Set();
    return out.filter(l=>{if(seen.has(l.id))return false;seen.add(l.id);const s=st[l.id];return !(s&&(s.done||(s.snooze&&s.snooze>now)))})
      .sort((a,b)=>(order[a.type]-order[b.type])||((b.weight||0)-(a.weight||0)));
  }
  const loopsTile=document.createElement('article');loopsTile.className='card loops wide';loopsTile.dataset.widget='loops';
  loopsTile.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 12a5 5 0 1 1 5 5"/><path d="M12 17H5m0 0 3-3m-3 3 3 3"/></svg></span>Open loops <span class="loop-count" id="loop-total"></span></div><span class="tiny loops-hint">Things you started but haven’t finished</span></div><div class="loop-grid" id="loop-grid"></div><div class="loops-foot" id="loops-foot"></div>';
  { const ord=readJSON('daylight-order',[]);const hero=$('.hero');
    if(ord.includes('loops'))ord.forEach(id=>{const c=$('#layout').querySelector(`[data-widget="${id}"]`)||(id==='loops'?loopsTile:null);if(c)$('#layout').append(c)});else if(hero)hero.after(loopsTile);else $('#layout').prepend(loopsTile) }
  TILE_NAMES.loops='Open loops';
  function renderLoops(){
    const grid=$('#loop-grid');if(!grid)return;const WORK=['reply','followup','prepare','overdue','deadline'],loops=computeLoops().filter(l=>wset('loops').include!=='Work only'||WORK.includes(l.type));
    $('#loop-total').textContent=loops.length?loops.length:'';if($('#loop-count'))$('#loop-count').textContent=token?loops.length:'—';
    if(!token&&!microsoftAccount&&!loops.length){grid.innerHTML='<div class="empty">Connect Google to find emails waiting for a reply, meetings to prepare for and overdue tasks.</div>';$('#loops-foot').innerHTML='';renderSummary(null);return}
    if(!loopsData&&token){grid.innerHTML='<div class="empty">Looking through your inbox, calendar and tasks…</div>';return}
    const lmax=+(wset('loops').max||6),shown=loopsShowAll?loops:loops.slice(0,lmax);
    grid.classList.toggle('as-list',(wset('loops').view||'List')==='List');grid.innerHTML=loops.length?shown.map(loopHTML).join('')
      :'<div class="empty all-clear">No open loops right now. You’re all caught up.</div>';
    $('#loops-foot').innerHTML=loops.length>lmax?`<button class="connect" type="button" id="loops-more">${loopsShowAll?'Show fewer':`Show all ${loops.length}`}</button>`:'';
    if($('#loops-more'))$('#loops-more').onclick=()=>{loopsShowAll=!loopsShowAll;renderLoops()};
    renderSummary(loops.length);
  }
  $('#loop-grid').addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!b)return;const id=b.closest('[data-loop]').dataset.loop,s=loopState();
    s[id]=b.dataset.act==='done'?{done:true,t:Date.now()}:{snooze:Date.now()+86400000,t:Date.now()};saveLoopState(s);renderLoops();
    toast(b.dataset.act==='done'?'Marked as done':'Snoozed until tomorrow')});
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
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){openMenu(false);$('#overlay').classList.remove('show')}});
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
    'Default':[P('summary',0,0,12,3),P('overview',0,3,12,4),P('loops',0,7,12,5),P('calendar',0,12,4,5),P('tasks',4,12,4,5),P('mail',8,12,4,5),P('focus',0,17,4,4),P('notes',4,17,4,4),P('weather',8,17,4,4),P('drive',0,21,4,4),P('birthdays',4,21,4,4),P('markets',8,21,4,4)],
    'Work focus':[P('overview',0,0,8,4),P('focus',8,0,4,4),P('loops',0,4,12,5),P('calendar',0,9,6,5),P('tasks',6,9,6,5),P('drive',0,14,6,4),P('notes',6,14,6,4)],
    'Inbox zero':[P('summary',0,0,12,3),P('loops',0,3,12,6),P('mail',0,9,8,6),P('tasks',8,9,4,6)],
    'Minimal':[P('summary',0,0,12,3),P('calendar',0,3,6,5),P('tasks',6,3,6,5),P('weather',0,8,6,4),P('markets',6,8,6,4)]};

  // Smart summary (rules for now; an AI-written version can replace renderSmart later)
  const sumCard=document.createElement('article');sumCard.className='card summary-w';sumCard.dataset.widget='summary';
  sumCard.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue">✦</span>Daily briefing</div></div><div class="smart" id="smart-summary"></div><div class="smart-chips" id="smart-chips"></div>';
  $('#layout').prepend(sumCard);
  function renderSmart(){
    const el=$('#smart-summary');if(!el)return;const chips=$('#smart-chips');
    if(!token&&!microsoftAccount){el.innerHTML='Connect Google and Daylight will sum up your day here: meetings, people waiting on you and your best time to focus.';chips.innerHTML='';return}
    const now=new Date(),{timed,connected}=todayEvents(),detailed=wset('summary').detail==='Detailed';
    const loops=computeLoops(),n=t=>loops.filter(l=>l.type===t).length,pl=(k,one,many)=>k===1?one:many;
    const s=[];
    if(connected){const left=timed.filter(e=>e.end>now),next=left[0];
      if(!left.length)s.push('No more meetings today.');
      else{const mins=Math.round((next.start-now)/60000);s.push(`${left.length} ${pl(left.length,'meeting','meetings')} left today${next.start<=now?`; <em>${esc(next.title)}</em> is on now`:`; next is <em>${esc(next.title)}</em> ${mins<60?`in ${mins} min`:'at '+hm(next.start)}`}.`)}}
    const bits=[];if(n('reply'))bits.push(`<em>${n('reply')} ${pl(n('reply'),'person is','people are')}</em> waiting for your reply`);if(n('overdue'))bits.push(`<em>${n('overdue')} ${pl(n('overdue'),'task is','tasks are')} overdue</em>`);if(n('deadline'))bits.push(`${n('deadline')} due soon`);
    if(bits.length)s.push(bits.join(', ').replace(/, ([^,]*)$/,' and $1')+'.');
    const dayEnd=new Date(localMidnight.getTime()+DAY_END*3600000),dayStart=new Date(localMidnight.getTime()+DAY_START*3600000);
    const slot=connected&&freeGaps(timed,new Date(Math.max(now,dayStart)),dayEnd).find(g=>g.min>=45);
    if(slot)s.push(`Best time to focus: <em>${hm(slot.start)}–${hm(slot.end)}</em>.`);
    if(detailed){const extra=[];if(n('followup'))extra.push(`${n('followup')} ${pl(n('followup'),'conversation needs','conversations need')} a follow-up`);if(n('prepare'))extra.push(`${n('prepare')} ${pl(n('prepare'),'meeting','meetings')} to prepare`);if(n('renewal'))extra.push(`${n('renewal')} ${pl(n('renewal'),'renewal','renewals')} to review`);
      const bday=(providerData.google.birthdays||[]).filter(b=>b.days===0).map(b=>b.name);if(bday.length)extra.push(`it’s ${esc(bday.join(' and '))}’s birthday`);if(extra.length)s.push(extra.join(', ').replace(/^./,c=>c.toUpperCase())+'.')}
    el.innerHTML=s.length?s.join(' '):'Nothing pressing right now. A good moment to plan ahead.';
    chips.innerHTML=loops.slice(0,3).map(l=>l.href?`<a class="tl-chip" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.title)}</a>`:`<span class="tl-chip">${esc(l.title)}</span>`).join('');
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
  function saveLayout(){if(!grid||grid.getColumn()!==12)return;writeJSON('daylight-layout-v3',grid.save(false).map(n=>({id:n.id,x:n.x,y:n.y,w:n.w,h:n.h})))}
  function loadItems(items){
    if(!grid)return;$$('#layout .card').forEach(c=>STORE.append(c));grid.removeAll();
    items.forEach(it=>{if(typeOf(it.id)==='markets'&&!cardOf(it.id))marketsCard(it.id);placeItem(it)});saveLayout();
  }
  function initGrid(){
    if(!window.GridStack){$('#layout').classList.add('no-grid');return false}
    let items=readJSON('daylight-layout-v3',null);if(!Array.isArray(items)){const v2=readJSON('daylight-layout-v2',null);if(Array.isArray(v2))items=v2.map(i=>({...i,y:i.y*U,h:i.h*U}))}
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
  const rerender={summary:renderSmart,loops:renderLoops,mail:renderMail,drive:renderDrive,birthdays:renderBirthdays,focus:renderInsights};
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
  function savePersonal(){try{localStorage.setItem('daylight-personal-tasks',JSON.stringify(personalTasks))}catch{}}
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
    if(/\b(bills?|renewals?|subscriptions?|payments?|invoices?)\b/.test(lq))return {sections:[{title:'Bills and renewals',items:computeLoops().filter(l=>l.type==='renewal').map(loopItem),empty:needG?'Connect Google to check your inbox.':'Nothing coming up in your recent email.'}]};
    if(/\b(trips?|travel|flights?|trains?|hotels?|bookings?)\b/.test(lq))return {sections:[{title:'Trips',items:computeLoops().filter(l=>l.type==='travel').map(loopItem),empty:'No trips found in recent email or your calendar.'}]};
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
  function loopHTML(l){const t=LOOP_TYPES[l.type],list=(wset('loops').view||'List')==='List';
    if(!list)return `<div class="loop ${t.cls}" data-loop="${esc(l.id)}"><div class="loop-top"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span><span class="loop-type">${t.label}</span>${l.meta?`<span class="loop-meta">${esc(l.meta)}</span>`:''}</div><div class="loop-title">${esc(l.title)}</div><div class="loop-detail">${esc(l.detail)}</div>${l.related?`<a class="loop-related" href="${esc(l.related.webViewLink)}" target="_blank" rel="noopener">Related: ${esc(l.related.name)}</a>`:''}<div class="loop-actions">${l.href?`<a class="connect primary" href="${esc(l.href)}" target="_blank" rel="noopener">Open</a>`:''}<button class="connect ghost" type="button" data-act="snooze">Snooze</button><button class="connect ghost" type="button" data-act="done">Done</button></div></div>`;
    const tags=[];if(l.weight>=2||l.type==='overdue')tags.push(['High priority','hot']);const tg=TAGS[l.type];if(tg&&!(l.type==='overdue'))tags.push(tg);if(l.type==='overdue')tags.push(['Reschedule','']);
    return `<div class="arow ${t.cls}" data-loop="${esc(l.id)}"><span class="loop-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <div class="arow-main"><div class="arow-top"><b>${esc(l.title)}</b><span class="arow-src">${esc([srcOf(l),l.meta].filter(Boolean).join(' · '))}</span></div>
      <div class="arow-detail">${esc(l.detail)}${l.related?` · <a href="${esc(l.related.webViewLink)}" target="_blank" rel="noopener">${esc(l.related.name)}</a>`:''}</div>
      <div class="arow-foot"><span class="arow-tags">${tags.map(([x,c])=>`<span class="atag ${c}">${x}</span>`).join('')}</span><span class="arow-actions">${l.href?`<a class="connect primary" href="${esc(l.href)}" target="_blank" rel="noopener">Open</a>`:''}<button class="connect ghost" type="button" data-act="snooze">Snooze</button><button class="connect ghost" type="button" data-act="done" aria-label="Mark done">Done</button></span></div></div></div>`}
  // ======== Mobile app (≤680px): Home · Calendar · + · Assistant · Statistics ========
  function logDone(t){if(!t)return;try{const l=JSON.parse(localStorage.getItem('daylight-done-log')||'[]');l.push({id:t.id,title:t.title,project:t.project||'',at:new Date().toISOString()});localStorage.setItem('daylight-done-log',JSON.stringify(l.slice(-500)))}catch{}}
  function logFocus(min){try{const l=JSON.parse(localStorage.getItem('daylight-focus-log')||'[]');l.push({min,at:new Date().toISOString()});localStorage.setItem('daylight-focus-log',JSON.stringify(l.slice(-500)))}catch{}}
  const mq=matchMedia('(max-width:680px)');
  const ICON={home:'<path d="M4 11.5 12 5l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z"/>',calendar:'<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="15.5" cy="15" r="1.2" fill="currentColor"/>',assistant:'<path d="M12 3.5 14.4 6l3.4-.3.3 3.4L20.5 12l-2.4 2.9-.3 3.4-3.4-.3L12 20.5 9.6 18l-3.4.3-.3-3.4L3.5 12l2.4-2.9.3-3.4 3.4.3Z"/><path d="m9.5 12 1.6 1.6 3.4-3.4"/>',stats:'<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M9 15v-3M12 15V9M15 15v-5"/>',search:'<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',bell:'<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'};
  const svg=(d,w=22)=>`<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const mapp=document.createElement('div');mapp.id='mapp';mapp.className='mapp';
  mapp.innerHTML=`<header class="m-top"><span class="m-title" id="m-title"></span><span class="m-top-actions"><button class="m-circle" id="m-search" type="button" aria-label="Search or ask">${svg(ICON.search,20)}</button><button class="m-circle" id="m-bell" type="button" aria-label="Notifications">${svg(ICON.bell,20)}<i class="m-dot" hidden></i></button><button class="m-avatar" id="m-avatar" type="button" aria-label="Menu"></button></span></header>
   <section class="m-screen" data-screen="home"><div class="m-date" id="m-date"></div><h2 class="m-hello" id="m-hello"></h2>
     <div class="m-seg" role="tablist" id="m-seg"><button type="button" data-f="all" class="on">All tasks</button><button type="button" data-f="personal">Personal</button><button type="button" data-f="work">Work</button></div>
     <h3 class="m-count" id="m-count"></h3><div class="m-stat" id="m-stat"></div><div class="m-list" id="m-list"></div><div class="m-more" id="m-more"></div></section>
   <section class="m-screen" data-screen="calendar"><div class="m-cal-head"><button class="m-arrow" type="button" data-wk="-1" aria-label="Previous week">‹</button><b id="m-month"></b><button class="m-arrow" type="button" data-wk="1" aria-label="Next week">›</button><span class="m-pill">Week</span></div><div class="m-week" id="m-week"></div><div class="m-day" id="m-day"></div></section>
   <section class="m-screen" data-screen="assistant"><div class="m-chat" id="m-chat"></div><form class="m-msg" id="m-msg"><input id="m-msg-input" placeholder="Message…" autocomplete="off" aria-label="Message Daylight"><button type="submit" aria-label="Send"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m21 3-9.5 18-2-7.5L2 11.5Z"/><path d="m9.5 13.5 5-5"/></svg></button></form></section>
   <section class="m-screen" data-screen="stats"><div id="m-stats"></div></section>
   <nav class="m-tabs" aria-label="Sections"><button data-tab="home" type="button">${svg(ICON.home)}<span>Home</span></button><button data-tab="calendar" type="button">${svg(ICON.calendar)}<span>Calendar</span></button><button class="m-fab" id="m-fab" type="button" aria-label="Quick capture"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button><button data-tab="assistant" type="button">${svg(ICON.assistant)}<span>Assistant</span></button><button data-tab="stats" type="button">${svg(ICON.stats)}<span>Statistics</span></button></nav>`;
  document.body.append(mapp);
  // move overlays out of the desktop shell so they work on the phone too
  ['#drawer-scrim','#drawer','#overlay'].forEach(s=>{const el=$(s);if(el)document.body.append(el)});
  let mTab=getLS('daylight-mtab')||'home',mFilter='all',mSel=new Date(localMidnight),mWeekCache={},mChat=[];
  const TITLES={home:'',calendar:'Calendar',assistant:'Assistant',stats:'Statistics'};
  function setTab(t){mTab=t;setLS('daylight-mtab',t);$$('#mapp .m-screen').forEach(s=>s.hidden=s.dataset.screen!==t);$$('.m-tabs [data-tab]').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
    mapp.dataset.screen=t;$('#m-title').textContent=TITLES[t];renderMobile();if(t==='assistant'&&!mChat.length)chatHello()}
  function applyMode(){document.body.classList.toggle('m',mq.matches);if(mq.matches)setTab(mTab);else dispatchEvent(new Event('resize'))}
  mq.addEventListener?.('change',applyMode);
  $$('.m-tabs [data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  // Home
  function todayItems(){
    const now=new Date(),items=[],evs=[...(providerData.google.events||[]),...(providerData.microsoft.events||[])];
    evs.forEach(e=>{if(!e.start?.dateTime)return;const utc=e.start.timeZone==='UTC'&&!/[zZ]|[+-]\d\d:?\d\d$/.test(e.start.dateTime);const s=new Date(e.start.dateTime+(utc?'Z':'')),en=new Date((e.end?.dateTime||e.start.dateTime)+(utc?'Z':''));if(en<=localMidnight||s>=tomorrow)return;
      items.push({kind:'event',title:e.summary||e.subject||'(No title)',sort:s,time:`${hm(s)}–${hm(en)}`,state:en<=now?'done':s<=now?'now':'todo',work:(e.attendees||[]).length>1,href:e.htmlLink||e.webLink})});
    const day=v=>{const d=new Date(v);return /T00:00:00(\.000)?Z$/.test(v)?new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()):new Date(d.getFullYear(),d.getMonth(),d.getDate())};
    [...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[])].forEach(t=>{if(!t.dueDate||day(t.dueDate)>=tomorrow)return;const late=day(t.dueDate)<localMidnight;items.push({kind:'task',title:t.title,sort:new Date(localMidnight.getTime()+23*3600000),time:late?'Overdue · was due '+day(t.dueDate).toLocaleDateString(undefined,{day:'numeric',month:'short'}):'Due today',state:late?'late':'todo',work:true,href:t.source==='Microsoft To Do'?'https://to-do.office.com/':'https://tasks.google.com/'})});
    personalTasks.forEach(t=>{if(!t.dueDate)return;const d=new Date(t.dueDate);if(day(t.dueDate)>=tomorrow)return;const late=day(t.dueDate)<localMidnight;
      items.push({kind:'personal',id:t.id,title:t.title,sort:t.hasTime?d:new Date(localMidnight.getTime()+22*3600000),time:(late?'Overdue · ':'')+(t.hasTime&&!late?hm(d):late?fmtDue(t):'Today')+(t.project?' · '+t.project:''),state:late?'late':(t.hasTime&&d<=now?'now':'todo'),work:!!t.project&&/work|lab|office|client|research|thesis|project/i.test(t.project)})});
    readJSON('daylight-done-log',[]).filter(d=>new Date(d.at)>=localMidnight).forEach(d=>items.push({kind:'personal',title:d.title,sort:new Date(d.at),time:'Done '+hm(new Date(d.at))+(d.project?' · '+d.project:''),state:'done',work:/work|lab|office|client|research|thesis|project/i.test(d.project||'')}));
    return items.sort((a,b)=>a.sort-b.sort);
  }
  function donut(done,now,left){const tot=Math.max(1,done+now+left),C=2*Math.PI*26,seg=(v,off,col)=>v?`<circle r="26" cx="32" cy="32" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${Math.max(0,C*v/tot-4)} ${C}" stroke-dashoffset="${-C*off/tot}"/>`:'';
    return `<svg viewBox="0 0 64 64" width="72" height="72" class="m-donut"><circle r="26" cx="32" cy="32" fill="none" stroke="var(--m-ring)" stroke-width="8"/><g transform="rotate(-90 32 32)">${seg(done,0,'var(--m-green)')}${seg(now,done,'var(--accent)')}</g></svg>`}
  function renderHome(){
    const p=readProfile(),first=(p.name||'').split(' ')[0],h=new Date().getHours(),part=h<12?'Morning':h<18?'Afternoon':'Evening';
    $('#m-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});$('#m-hello').innerHTML=`${part}${first?', '+esc(first):''} <span aria-hidden="true">👋</span>`;
    let items=todayItems();if(mFilter!=='all')items=items.filter(i=>mFilter==='work'?i.work:!i.work);
    const done=items.filter(i=>i.state==='done').length,now=items.filter(i=>i.state==='now').length,left=items.length-done-now;
    $('#m-count').textContent=`${items.length} ${items.length===1?'thing':'things'} for today`;
    $('#m-stat').innerHTML=`${donut(done,now,left)}<div class="m-legend"><div><i style="background:var(--m-green)"></i><b>${done} done</b><span>completed</span></div><div><i style="background:var(--accent)"></i><b>${now} now</b><span>in progress</span></div><div><i style="background:var(--m-ring)"></i><b>${left} left</b><span>to do</span></div></div>`;
    $('#m-list').innerHTML=items.length?items.map(i=>`<${i.href?`a href="${esc(i.href)}" target="_blank" rel="noopener"`:'div'} class="m-item s-${i.state}"><span class="m-bar"></span><span class="m-item-main"><b>${esc(i.title)}</b><small>${esc(i.time)}</small></span>${i.kind==='personal'&&i.state!=='done'?`<button class="m-check" type="button" data-done="${esc(i.id)}" aria-label="Mark ${esc(i.title)} done"></button>`:`<span class="m-check${i.state==='done'?' on':''}" aria-hidden="true"></span>`}</${i.href?'a':'div'}>`).join('')
      :`<div class="m-empty">${token||microsoftAccount?'Nothing scheduled for today. Tap + to add something.':'Connect Google from the menu (tap your photo) to see your day here. Tap + to add a reminder.'}</div>`;
    const loops=(token||microsoftAccount)?computeLoops().filter(l=>!['overdue','deadline'].includes(l.type)).slice(0,3):[];
    $('#m-more').innerHTML=loops.length?`<h3 class="m-sub">Needs attention</h3>${loops.map(l=>`<${l.href?`a href="${esc(l.href)}" target="_blank" rel="noopener"`:'div'} class="m-item s-attn ${LOOP_TYPES[l.type].cls}"><span class="m-bar"></span><span class="m-item-main"><b>${esc(l.title)}</b><small>${esc([srcOf(l),l.detail].filter(Boolean).join(' · '))}</small></span></${l.href?'a':'div'}>`).join('')}`:'';
  }
  $('#m-seg').onclick=e=>{const b=e.target.closest('[data-f]');if(!b)return;mFilter=b.dataset.f;$$('#m-seg button').forEach(x=>x.classList.toggle('on',x===b));renderHome()};
  $('#m-list').addEventListener('click',e=>{const b=e.target.closest('[data-done]');if(!b)return;e.preventDefault();const t=personalTasks.find(x=>x.id===b.dataset.done);logDone(t);personalTasks=personalTasks.filter(x=>x.id!==b.dataset.done);savePersonal();renderTasks();renderLoops();toast('Done · nice work')});
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
  // Assistant (same engine as the command bar)
  function chatHello(){const p=readProfile();mChat=[{who:'ai',html:`Hi${p.name?' '+esc(p.name.split(' ')[0]):''}! Ask me about your day, or tell me something to remember.`,chips:['What do I have tomorrow?','Who is waiting for a reply?','Remember to call the lab on Friday at 10']}];renderChat()}
  function renderChat(){const el=$('#m-chat');el.innerHTML=`<div class="m-stamp">Today, ${hm(new Date())}</div>`+mChat.map(m=>m.who==='me'?`<div class="m-b me">${esc(m.text)}</div>`:m.who==='wait'?`<div class="m-wait"><i></i><i></i><i></i> Analyzing…</div>`:`<div class="m-b ai">${m.html}${m.chips?`<div class="m-chips">${m.chips.map(c=>`<button type="button" data-ask="${esc(c)}">${esc(c)}</button>`).join('')}</div>`:''}</div>`).join('');el.scrollTop=el.scrollHeight;scrollTo({top:document.body.scrollHeight,behavior:'smooth'})}
  async function ask(q){q=q.trim();if(!q)return;mChat.push({who:'me',text:q},{who:'wait'});renderChat();let html;
    try{if(looksLikeCapture(q)){const it=capture(q);html=`Saved <b>${esc(it.title)}</b>${it.dueDate?' for '+esc(fmtDue(it)):''}${it.project?' in '+esc(it.project):''}. <button type="button" class="m-link" data-undo-chat="${esc(it.id)}">Undo</button>`}
      else{const r=await answer(q);html=(r.sections||[]).map(s=>`${s.title?`<div class="m-ah">${esc(s.title)}</div>`:''}${s.items.length?`<ul>${s.items.slice(0,6).map(i=>`<li>${i.href?`<a href="${esc(i.href)}" target="_blank" rel="noopener">${esc(i.title)}</a>`:esc(i.title)}<small>${esc(i.meta||'')}</small></li>`).join('')}</ul>`:`<p>${esc(s.empty||'Nothing found.')}</p>`}${s.more?`<a class="m-link" href="${esc(s.more.href)}" target="_blank" rel="noopener">${esc(s.more.label)} ↗</a>`:''}`).join('')+(r.note?`<p>${esc(r.note)}</p>`:'')}}
    catch(e){html='Sorry, something went wrong: '+esc(e.message)}
    mChat.pop();mChat.push({who:'ai',html});renderChat()}
  $('#m-msg').addEventListener('submit',e=>{e.preventDefault();const v=$('#m-msg-input').value;$('#m-msg-input').value='';ask(v)});
  $('#m-chat').addEventListener('click',e=>{const c=e.target.closest('[data-ask]');if(c)ask(c.dataset.ask);const u=e.target.closest('[data-undo-chat]');if(u){personalTasks=personalTasks.filter(t=>t.id!==u.dataset.undoChat);savePersonal();renderTasks();renderLoops();u.replaceWith(document.createTextNode('(removed)'))}});
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
  // Header buttons, FAB, search
  function renderMTop(){const p=readProfile(),av=$('#m-avatar');av.innerHTML=p.picture?`<img src="${esc(p.picture)}" alt="" referrerpolicy="no-referrer">`:esc(((p.name||'K')[0]).toUpperCase());
    const n=$('#bell-badge');$('#mapp .m-dot').hidden=!n||n.hidden}
  $('#m-avatar').onclick=()=>$('#menu-btn').click();
  $('#m-bell').onclick=e=>{e.stopPropagation();$('#bell').click()};
  const openCmd=capture=>{document.body.classList.add('cmd-open');if(capture)$('#cmd-capture').click();else{$('#cmd-input').focus()}};
  $('#m-fab').onclick=e=>{e.stopPropagation();openCmd(true)};$('#m-search').onclick=e=>{e.stopPropagation();openCmd(false)};
  document.addEventListener('click',e=>{if(document.body.classList.contains('cmd-open')&&!e.composedPath().includes($('#cmd')))document.body.classList.remove('cmd-open')});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')document.body.classList.remove('cmd-open')});
  function renderMobile(){if(!mq.matches)return;renderMTop();if(mTab==='home')renderHome();else if(mTab==='calendar')renderCalendar2();else if(mTab==='stats')renderStats()}
  { const o=renderLoops;renderLoops=function(){o();renderMobile()} }
  { const o=renderTasks;renderTasks=function(){o();if(mq.matches&&mTab==='home')renderHome()} }
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

