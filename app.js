// Daylight personal mode. Access tokens live in memory only; no Google data is sent to Daylight servers.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let token = null, tokenClient = null, microsoftApp = null, microsoftAccount = null;
  const providerData = { google:{events:null,mails:null,tasks:null}, microsoft:{events:null,mails:null,tasks:null} };
  let personalTasks = [];
  try { personalTasks = JSON.parse(localStorage.getItem('daylight-personal-tasks') || '[]'); if (!Array.isArray(personalTasks)) personalTasks=[]; } catch { personalTasks=[]; }
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/gmail.metadata',
    'https://www.googleapis.com/auth/tasks.readonly'
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
  weatherCard.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue">☀</span>Local weather</div><button class="connect" id="weather-connect">Use my location</button></div><div id="weather-content" class="empty">Allow location access to see your forecast. Your coordinates are sent to Open-Meteo to retrieve it.</div>';
  $('#layout').append(weatherCard);

  function connectDialog() {
    const connected=Boolean(token), microsoftConnected=Boolean(microsoftAccount);
    $('#overlay').innerHTML=`<div class="modal connections-modal"><div class="modal-top"><div><div class="eyebrow">Your connections</div><h3>Bring your apps together</h3></div><button class="modal-x" id="close-modal" aria-label="Close">×</button></div>
      <p>Choose a service. Each provider asks you to approve access before Daylight reads anything. You can disconnect at any time.</p>
      <div class="provider-card"><div class="provider-icon google-icon">G</div><div class="provider-copy"><b>Google</b><span>Calendar · Gmail · Tasks</span></div><span class="provider-status ${connected?'is-connected':''}">${connected?'Connected':'Not connected'}</span><button class="connect provider-action" id="google-connect">${connected?'Refresh':'Connect'}</button></div>
      <div class="scope-note"><b>Google will ask to allow</b><br>• View calendar events<br>• View inbox message headers (no message bodies or email changes)<br>• View Google Tasks<br><span class="privacy-line">Permission is granted on Google’s screen. Access tokens stay in this tab.</span></div>
      <details class="setup-details" ${localStorage.getItem('daylight-client-id')?'':'open'}><summary>Set up Google access for this dashboard</summary>
        <label class="client-label" for="client-id">Google OAuth Client ID</label><input class="client-input" id="client-id" type="text" placeholder="1234567890-abc.apps.googleusercontent.com" value="${esc(localStorage.getItem('daylight-client-id')||'')}">
        <div class="setup-note">Use a Google OAuth client ID for a Web application. Enable Calendar API, Gmail API, and Tasks API in Google Cloud. Add <b>https://kratveer.github.io</b> as an authorized JavaScript origin and your Google account as a test user. Keep the app in Testing for personal use.</div>
      </details>
      <div class="provider-card"><div class="provider-icon ms-icon">M</div><div class="provider-copy"><b>Microsoft 365</b><span>Outlook Mail · Calendar · To Do</span></div><span class="provider-status ${microsoftConnected?'is-connected':''}">${microsoftConnected?'Connected':'Not connected'}</span><button class="connect provider-action" id="microsoft-connect">${microsoftConnected?'Refresh':'Connect'}</button></div>
      <div class="scope-note"><b>Microsoft will ask to allow</b><br>• Read basic Outlook mail details (no body or sending)<br>• Read calendar events<br>• Read To Do tasks<br><span class="privacy-line">Microsoft sign-in uses OAuth. Tokens stay in this browser session.</span></div>
      <details class="setup-details" ${localStorage.getItem('daylight-ms-client-id')?'':'open'}><summary>Set up Microsoft access for this dashboard</summary>
        <label class="client-label" for="ms-client-id">Microsoft Application (client) ID</label><input class="client-input" id="ms-client-id" type="text" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(localStorage.getItem('daylight-ms-client-id')||'')}">
        <div class="setup-note">In Microsoft Entra, register Daylight as a single-page application for work, school, and personal Microsoft accounts. Add the redirect URI <b>https://kratveer.github.io/Deshboard/</b>. Add delegated Microsoft Graph permissions <b>User.Read</b>, <b>Mail.ReadBasic</b>, <b>Calendars.ReadBasic</b>, and <b>Tasks.Read</b>. Do not create a client secret.</div>
      </details>
      <div class="provider-card provider-later"><div class="provider-icon apple-icon">A</div><div class="provider-copy"><b>Apple iCloud</b><span>Mail · Calendar · Reminders</span></div><span class="provider-status">Needs a secure Apple connection</span></div>
      <div class="provider-card provider-later"><div class="provider-icon samsung-icon">S</div><div class="provider-copy"><b>Samsung Calendar</b><span>Calendar and reminders</span></div><span class="provider-status">Google sync may include events</span></div>
      <div class="provider-card provider-later"><div class="provider-icon social-icon">◎</div><div class="provider-copy"><b>Social notifications</b><span>Provider by provider, when supported</span></div><span class="provider-status">Limited by platform APIs</span></div>
      <div id="connect-error" class="error" role="alert"></div><div class="modalfoot"><button class="close secondary" id="disconnect">Disconnect Google</button></div></div>`;
    $('#overlay').classList.add('show');
    $('#google-connect').onclick=connected?refreshAll:authorize;
    $('#microsoft-connect').onclick=authorizeMicrosoft;
    $('#close-modal').onclick=()=>$('#overlay').classList.remove('show');
    $('#disconnect').onclick=()=>{token=null;providerData.google={events:null,mails:null,tasks:null};renderAll();$('#overlay').classList.remove('show');$('#sync-status').textContent=microsoftAccount?'Google disconnected · Microsoft remains connected':'Google disconnected · reconnect to refresh';$('#connections').classList.toggle('active',Boolean(microsoftAccount));toast('Google access cleared from this page')};
    if(microsoftConnected) $('#microsoft-connect').onclick=async()=>{try{await refreshAll()}catch{} };
    if(microsoftConnected) $('#microsoft-connect').textContent='Refresh';
    if(microsoftConnected){const msDisconnect=document.createElement('button');msDisconnect.className='close secondary';msDisconnect.id='disconnect-microsoft';msDisconnect.textContent='Disconnect Microsoft';msDisconnect.onclick=async()=>{try{await microsoftApp?.clearCache({account:microsoftAccount})}catch{}microsoftAccount=null;microsoftApp=null;providerData.microsoft={events:null,mails:null,tasks:null};renderAll();connectDialog();toast('Microsoft access cleared from this browser session')};$('#disconnect').parentElement.insertBefore(msDisconnect,$('#disconnect'))}
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
  async function api(url) {
    const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok){let detail='';try{detail=(await r.json()).error?.message||''}catch{}throw new Error(detail||`Google API error (${r.status})`)}
    return r.json();
  }
  const header=(headers,name)=>headers?.find(x=>x.name?.toLowerCase()===name.toLowerCase())?.value||'';
  function renderAll(){renderCalendar();renderMail();renderTasks()}
  function renderCalendar(){
    const events=[...(providerData.google.events||[]),...(providerData.microsoft.events||[])].sort((a,b)=>new Date(a.start?.dateTime||a.start?.date||0)-new Date(b.start?.dateTime||b.start?.date||0));
    $('#caldate').textContent=date.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    $('#events').innerHTML=events.length?events.slice(0,12).map(e=>{const raw=e.start?.dateTime||e.start?.date;const start=raw?new Date(raw):null;const t=start&&e.start?.dateTime?start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'All day';const end=e.end?.dateTime?new Date(e.end.dateTime):null;return `<div class="event"><span class="time">${esc(t)}</span><span class="event-bar"></span><div><div class="event-name">${esc(e.summary||e.subject||'(No title)')}</div><div class="event-sub">${esc(e.location?.displayName||e.location||e.organizer?.displayName||e.source||'Calendar')}</div></div><span class="badge">${end&&start?Math.max(1,Math.round((end-start)/60000))+' min':'Event'}</span></div>`}).join(''):`<div class="empty">${providerData.google.events||providerData.microsoft.events?'Nothing scheduled today. Enjoy the breathing room.':'Connect a calendar to see today’s events.'}</div>`;
    $('#event-count').textContent=(providerData.google.events||[]).length+(providerData.microsoft.events||[]).length;
  }
  function renderMail(){
    const msgs=[...(providerData.google.mails||[]),...(providerData.microsoft.mails||[])].sort((a,b)=>(b.sortDate||0)-(a.sortDate||0)).slice(0,8);
    $('#mail-list').innerHTML=msgs.length?msgs.map(m=>`<div class="mail-item"><div class="avatar">${esc(m.initials||'M')}</div><div><div class="sender">${esc(m.sender||'')}</div><div class="subject">${esc(m.subject||'(No subject)')}</div><div class="snippet">${m.unread?'Unread · ':''}${esc(m.time||m.source||'Inbox')}</div></div><span class="mail-time">${m.unread?'NEW':''}</span></div>`).join(''):`<div class="empty">${providerData.google.mails||providerData.microsoft.mails?'Your inbox is clear.':'Connect Gmail or Outlook to view inbox messages.'}</div>`;
    $('#mail-count').textContent=(providerData.google.mails||[]).length+(providerData.microsoft.mails||[]).length;
  }
  function renderTasks(){
    const tasks=[...personalTasks.map(t=>({...t,personal:true,source:'Personal · this device'})),...(providerData.google.tasks||[]),...(providerData.microsoft.tasks||[])].slice(0,10);
    $('#task-count').textContent=tasks.length;$('#done-count').textContent=tasks.length;
    $('.task-list').innerHTML=tasks.length?tasks.map(t=>`<div class="task"><${t.personal?'button type="button" data-local-task="'+esc(t.id)+'" class="check local-check" aria-label="Complete '+esc(t.title)+'"':'span class="check" aria-hidden="true"'}></${t.personal?'button':'span'}><div class="task-text">${esc(t.title||'(Untitled task)')}<div class="task-meta">${esc(t.due||t.listName||t.source||'Task')}</div></div></div>`).join(''):`<div class="empty">${providerData.google.tasks||providerData.microsoft.tasks?'No open tasks. Add a personal task above.':'Add a personal task above or connect Google Tasks.'}</div>`;
  }
  const personalTaskForm=$('#personal-task-form');
  if(personalTaskForm) personalTaskForm.addEventListener('submit',e=>{e.preventDefault();const input=$('#personal-task-input'),title=input.value.trim();if(!title)return;personalTasks.unshift({id:crypto.randomUUID?.()||String(Date.now()),title});localStorage.setItem('daylight-personal-tasks',JSON.stringify(personalTasks));input.value='';renderTasks();toast('Task added on this device');});
  $('.task-list').addEventListener('click',e=>{const button=e.target.closest('[data-local-task]');if(!button)return;personalTasks=personalTasks.filter(t=>t.id!==button.dataset.localTask);localStorage.setItem('daylight-personal-tasks',JSON.stringify(personalTasks));renderTasks();toast('Personal task completed');});
  async function loadCalendar(){
    const u=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');u.searchParams.set('timeMin',iso(localMidnight));u.searchParams.set('timeMax',iso(tomorrow));u.searchParams.set('singleEvents','true');u.searchParams.set('orderBy','startTime');u.searchParams.set('maxResults','12');
    const data=await api(u);providerData.google.events=(data.items||[]).map(e=>({...e,source:'Google Calendar'}));renderCalendar();
    return providerData.google.events.length;
  }
  async function loadMail(){
    const list=await api('https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=6');const items=list.messages||[];
    const msgs=await Promise.all(items.map(m=>api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    providerData.google.mails=msgs.map(m=>{const h=m.payload?.headers||[];const from=header(h,'From');const sender=from.replace(/<.*?>/,'').replace(/"/g,'').trim()||from;const when=header(h,'Date');const d=when?new Date(when):null;return {sender,subject:header(h,'Subject')||'(No subject)',time:d?d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'',sortDate:d?.getTime()||0,unread:m.labelIds?.includes('UNREAD'),initials:sender.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'G',source:'Gmail'}});renderMail();
    return providerData.google.mails.length;
  }
  async function loadTasks(){
    const lists=await api('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=5');const groups=await Promise.all((lists.items||[]).slice(0,3).map(l=>api(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=20`)));
    providerData.google.tasks=groups.flatMap((g,i)=>(g.items||[]).filter(t=>t.status!=='completed').map(t=>({title:t.title,due:t.due?new Date(t.due).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'',listName:lists.items[i].title,source:'Google Tasks'}))).slice(0,8);renderTasks();
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
    providerData.microsoft.tasks=groups.flatMap((g,i)=>(g.value||[]).filter(t=>t.status!=='completed').map(t=>({title:t.title,due:t.dueDateTime?.dateTime?new Date(t.dueDateTime.dateTime).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'',listName:lists.value[i].displayName,source:'Microsoft To Do'}))).slice(0,8);renderTasks();return providerData.microsoft.tasks.length;
  }
  async function refreshAll(){
    if(!token&&!microsoftAccount)return;$('#sync-status').textContent=`Connected to ${[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean).join(' and ')} · refreshing…`;
    const jobs=[];if(token)jobs.push(loadCalendar(),loadMail(),loadTasks());if(microsoftAccount)jobs.push(loadMicrosoftCalendar(),loadMicrosoftMail(),loadMicrosoftTasks());
    const results=await Promise.allSettled(jobs);const failed=results.filter(r=>r.status==='rejected');renderAll();
    const eventCount=(providerData.google.events||[]).length+(providerData.microsoft.events||[]).length,mailCount=(providerData.google.mails||[]).length+(providerData.microsoft.mails||[]).length,taskCount=(providerData.google.tasks||[]).length+(providerData.microsoft.tasks||[]).length;
    $('#headline-note').innerHTML=`Today: <b>${eventCount} events</b> · <b>${mailCount} inbox messages</b> · <b>${taskCount} open tasks</b>`;
    $('#sync-status').textContent=failed.length?`Some connected data could not load · ${failed.map(x=>x.reason.message).join('; ')}`:`Connected to ${[token?'Google':'',microsoftAccount?'Microsoft':''].filter(Boolean).join(' and ')} · updated ${new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
    if(failed.length)toast('Some services need permission or API setup; check the status line.');
  }
  $('#refresh').onclick=()=>token||microsoftAccount?refreshAll():toast('Connect an app first to refresh live data.');
  $('#weather-connect').onclick=()=>{
    if(!navigator.geolocation){$('#weather-content').textContent='Location is unavailable in this browser.';return}
    $('#weather-content').textContent='Waiting for location permission…';navigator.geolocation.getCurrentPosition(async pos=>{try{const {latitude,longitude}=pos.coords;const u=`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;const w=await(await fetch(u)).json();const names={0:'Clear sky',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',61:'Rain',63:'Rain',65:'Heavy rain',71:'Snow',80:'Showers',95:'Thunderstorm'};$('#weather-content').innerHTML=`<div class="weather-temp">${Math.round(w.current.temperature_2m)}°</div><div class="weather-label">${esc(names[w.current.weather_code]||'Current conditions')}</div><div class="weather-range">Feels like ${Math.round(w.current.apparent_temperature)}° · H ${Math.round(w.daily.temperature_2m_max[0])}° / L ${Math.round(w.daily.temperature_2m_min[0])}°</div>`;$('#weather-connect').textContent='Refresh';}catch(e){$('#weather-content').textContent='Weather could not be loaded. Try again.'}},()=>{$('#weather-content').textContent='Location permission was not granted. You can allow it in browser settings.'},{enableHighAccuracy:false,timeout:10000});
  };
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&(token||microsoftAccount))refreshAll()});
  const clientId=localStorage.getItem('daylight-client-id');if(clientId){$('#sync-status').textContent='Google setup saved · connect to grant access';}
})();

