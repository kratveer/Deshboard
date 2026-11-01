// Daylight personal mode. Access tokens live in memory only; no Google data is sent to Daylight servers.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let token = null, tokenClient = null;
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
  $('#connections').setAttribute('aria-label','Connect your Google apps');
  const weatherCard=document.createElement('article');
  weatherCard.className='card weather'; weatherCard.dataset.widget='weather';
  weatherCard.innerHTML='<div class="card-head"><div class="card-title"><span class="glyph g-blue">☀</span>Local weather</div><button class="connect" id="weather-connect">Use my location</button></div><div id="weather-content" class="empty">Allow location access to see your forecast. Your coordinates are sent to Open-Meteo to retrieve it.</div>';
  $('#layout').append(weatherCard);

  function connectDialog() {
    const connected=Boolean(token);
    $('#overlay').innerHTML=`<div class="modal connections-modal"><div class="modal-top"><div><div class="eyebrow">Your connections</div><h3>Bring your apps together</h3></div><button class="modal-x" id="close-modal" aria-label="Close">×</button></div>
      <p>Choose a service. Each provider asks you to approve access before Daylight reads anything. You can disconnect at any time.</p>
      <div class="provider-card"><div class="provider-icon google-icon">G</div><div class="provider-copy"><b>Google</b><span>Calendar · Gmail · Tasks</span></div><span class="provider-status ${connected?'is-connected':''}">${connected?'Connected':'Not connected'}</span><button class="connect provider-action" id="google-connect">${connected?'Refresh':'Connect'}</button></div>
      <div class="scope-note"><b>Google will ask to allow</b><br>• View calendar events<br>• View inbox message headers (no message bodies or email changes)<br>• View Google Tasks<br><span class="privacy-line">Permission is granted on Google’s screen. Access tokens stay in this tab.</span></div>
      <details class="setup-details" ${localStorage.getItem('daylight-client-id')?'':'open'}><summary>Set up Google access for this dashboard</summary>
        <label class="client-label" for="client-id">Google OAuth Client ID</label><input class="client-input" id="client-id" type="text" placeholder="1234567890-abc.apps.googleusercontent.com" value="${esc(localStorage.getItem('daylight-client-id')||'')}">
        <div class="setup-note">Use a Google OAuth client ID for a Web application. Enable Calendar API, Gmail API, and Tasks API in Google Cloud. Add <b>https://kratveer.github.io</b> as an authorized JavaScript origin and your Google account as a test user. Keep the app in Testing for personal use.</div>
      </details>
      <div class="provider-card provider-later"><div class="provider-icon ms-icon">M</div><div class="provider-copy"><b>Microsoft 365</b><span>Outlook Calendar · Mail · Tasks</span></div><span class="provider-status">Coming soon</span></div>
      <div class="provider-card provider-later"><div class="provider-icon samsung-icon">S</div><div class="provider-copy"><b>Samsung Calendar</b><span>Calendar and reminders</span></div><span class="provider-status">Coming soon</span></div>
      <div class="provider-card provider-later"><div class="provider-icon social-icon">◎</div><div class="provider-copy"><b>Social notifications</b><span>Only where providers support it</span></div><span class="provider-status">Coming soon</span></div>
      <div id="connect-error" class="error" role="alert"></div><div class="modalfoot"><button class="close secondary" id="disconnect">Disconnect Google</button></div></div>`;
    $('#overlay').classList.add('show');
    $('#google-connect').onclick=authorize;
    $('#close-modal').onclick=()=>$('#overlay').classList.remove('show');
    $('#disconnect').onclick=()=>{token=null;$('#overlay').classList.remove('show');$('#sync-status').textContent='Google disconnected · reconnect to refresh';$('#connections').classList.remove('active');toast('Google access cleared from this page')};
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
  async function api(url) {
    const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok){let detail='';try{detail=(await r.json()).error?.message||''}catch{}throw new Error(detail||`Google API error (${r.status})`)}
    return r.json();
  }
  const header=(headers,name)=>headers?.find(x=>x.name?.toLowerCase()===name.toLowerCase())?.value||'';
  async function loadCalendar(){
    const u=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');u.searchParams.set('timeMin',iso(localMidnight));u.searchParams.set('timeMax',iso(tomorrow));u.searchParams.set('singleEvents','true');u.searchParams.set('orderBy','startTime');u.searchParams.set('maxResults','12');
    const data=await api(u);const events=data.items||[];$('#caldate').textContent=date.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    $('#events').innerHTML=events.length?events.map(e=>{const start=e.start?.dateTime?new Date(e.start.dateTime):null;const t=start?start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'All day';return `<div class="event"><span class="time">${esc(t)}</span><span class="event-bar"></span><div><div class="event-name">${esc(e.summary||'(No title)')}</div><div class="event-sub">${esc(e.location||e.organizer?.displayName||'Google Calendar')}</div></div><span class="badge">${e.end?.dateTime&&start?Math.max(1,Math.round((new Date(e.end.dateTime)-start)/60000))+' min':'Event'}</span></div>`}).join(''):'<div class="empty">Nothing scheduled today. Enjoy the breathing room.</div>';
    return events.length;
  }
  async function loadMail(){
    const list=await api('https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=6');const items=list.messages||[];
    const msgs=await Promise.all(items.map(m=>api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    $('#mail-list').innerHTML=msgs.length?msgs.map(m=>{const h=m.payload?.headers||[];const from=header(h,'From');const subject=header(h,'Subject')||'(No subject)';const sender=from.replace(/<.*?>/,'').replace(/"/g,'').trim()||from;const when=header(h,'Date');const time=when?new Date(when).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';const initials=sender.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'G';return `<div class="mail-item"><div class="avatar">${esc(initials)}</div><div><div class="sender">${esc(sender)}</div><div class="subject">${esc(subject)}</div><div class="snippet">${m.labelIds?.includes('UNREAD')?'Unread · ':'Inbox · '}${esc(time)}</div></div><span class="mail-time">${m.labelIds?.includes('UNREAD')?'NEW':''}</span></div>`}).join(''):'<div class="empty">Your inbox is clear.</div>';
    return items.length;
  }
  async function loadTasks(){
    const lists=await api('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=5');const groups=await Promise.all((lists.items||[]).slice(0,3).map(l=>api(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=20`)));
    const tasks=groups.flatMap((g,i)=>(g.items||[]).filter(t=>t.status!=='completed').map(t=>({...t,listName:lists.items[i].title}))).slice(0,8);
    $('#task-count').textContent=tasks.length;$('#done-count').textContent='0';
    $('.task-list').innerHTML=tasks.length?tasks.map(t=>`<div class="task"><span class="check" aria-hidden="true"></span><div class="task-text">${esc(t.title||'(Untitled task)')}<div class="task-meta">${esc(t.due?new Date(t.due).toLocaleDateString(undefined,{month:'short',day:'numeric'}):t.listName)}</div></div></div>`).join(''):'<div class="empty">No open tasks. You’re all caught up.</div>';
    return tasks.length;
  }
  async function refreshAll(){
    if(!token)return;$('#sync-status').textContent='Connected to Google · refreshing…';
    const results=await Promise.allSettled([loadCalendar(),loadMail(),loadTasks()]);const failed=results.filter(r=>r.status==='rejected');
    const counts=results.map(r=>r.status==='fulfilled'?r.value:null);if(counts[0]!==null)$('#event-count').textContent=counts[0];if(counts[1]!==null)$('#mail-count').textContent=counts[1];$('#headline-note').innerHTML=`Today: <b>${counts[0]??'—'} events</b> · <b>${counts[1]??'—'} inbox messages</b> · <b>${counts[2]??'—'} open tasks</b>`;
    $('#sync-status').textContent=failed.length?`Some Google data could not load · ${failed.map(x=>x.reason.message).join('; ')}`:`Connected to Google · updated ${new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
    if(failed.length)toast('Some services need permission or API setup; check the status line.');
  }
  $('#refresh').onclick=()=>token?refreshAll():toast('Connect Google first to refresh live data.');
  $('#weather-connect').onclick=()=>{
    if(!navigator.geolocation){$('#weather-content').textContent='Location is unavailable in this browser.';return}
    $('#weather-content').textContent='Waiting for location permission…';navigator.geolocation.getCurrentPosition(async pos=>{try{const {latitude,longitude}=pos.coords;const u=`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;const w=await(await fetch(u)).json();const names={0:'Clear sky',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Drizzle',61:'Rain',63:'Rain',65:'Heavy rain',71:'Snow',80:'Showers',95:'Thunderstorm'};$('#weather-content').innerHTML=`<div class="weather-temp">${Math.round(w.current.temperature_2m)}°</div><div class="weather-label">${esc(names[w.current.weather_code]||'Current conditions')}</div><div class="weather-range">Feels like ${Math.round(w.current.apparent_temperature)}° · H ${Math.round(w.daily.temperature_2m_max[0])}° / L ${Math.round(w.daily.temperature_2m_min[0])}°</div>`;$('#weather-connect').textContent='Refresh';}catch(e){$('#weather-content').textContent='Weather could not be loaded. Try again.'}},()=>{$('#weather-content').textContent='Location permission was not granted. You can allow it in browser settings.'},{enableHighAccuracy:false,timeout:10000});
  };
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&token)refreshAll()});
  const clientId=localStorage.getItem('daylight-client-id');if(clientId){$('#sync-status').textContent='Google setup saved · connect to grant access';}
})();

