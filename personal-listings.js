/* Personal listings stay in extension storage and page memory, outside the club diary. */
(()=>{
  'use strict';
  const origin=location.origin,waiting=new Map();let matches=[],settings={},available=false,connected=false;
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node};
  const send=(action,payload={})=>new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{waiting.delete(id);reject(Error('The local helper did not reply. Install or reload it, then reopen Same End.'))},8000);waiting.set(id,{resolve,reject,timer});window.postMessage({type:'SAMEEND_LOCAL_REQUEST',id,action,...payload},origin)});
  const time=ms=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(ms);
  let panel,list,status,connect,refresh,calendar,disconnect,remind,offset;
  function render(){
    if(!panel)return;
    connect.hidden=connected;connect.textContent=available?'Connect my local matches':'Connect the helper';
    refresh.hidden=calendar.hidden=disconnect.hidden=!connected;list.replaceChildren();
    remind.checked=settings.remindersEnabled===true;offset.value=String(settings.reminderMinutes??15);
    panel.querySelector('.pl-settings').hidden=!connected;
    if(!connected){list.append(el('p','Your personal imports stay on this computer. Connect the helper once to see them here.'));return}
    const upcoming=matches.filter(f=>f.startsAt>Date.now()-2*3600000).sort((a,b)=>a.startsAt-b.startsAt);
    calendar.disabled=!upcoming.length;
    if(!upcoming.length)list.append(el('p','No personal matches yet. Use the helper’s Import fixtures button, or open a listing page and choose Import this page.'));
    for(const f of upcoming){const card=el('article');card.className='pl-match';card.append(el('strong',f.title),el('span',time(f.startsAt)+(f.status!=='scheduled'?' · '+f.status:'')));
      const channels=(f.tv||[]).filter(t=>!settings.country||t.country===settings.country||({GB:['United Kingdom','Great Britain'],US:['USA','United States'],IE:['Ireland Republic','Republic of Ireland','Ireland'],FR:['France']}[settings.country]||[]).includes(t.country)).map(t=>t.channel);
      if(channels.length)card.append(el('span',channels.join(' · ')));
      const source=el('a',f.sourceName+' ↗');source.href=f.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';card.append(source);
      const row=el('div');row.className='pl-match-actions';const add=el('button','Add to calendar');add.type='button';add.onclick=()=>download([f]);
      const remove=el('button','Remove');remove.type='button';remove.dataset.sameendLocalAction='REMOVE';remove.onclick=()=>act('REMOVE',{ids:[f.id]});row.append(add,remove);card.append(row);list.append(card);
    }
  }
  function update(result){matches=window.SameEndReaderCore.normalize(result.matches||[]);settings=result.settings||{};connected=true;render()}
  async function act(action,payload={}){try{status.textContent='';const result=await send(action,payload);if(!result.ok)throw Error(result.error||'Try the local helper again.');if(action==='DISCONNECT'){connected=false;matches=[];render();status.textContent='Disconnected. Matches remain in the helper on this computer.'}else update(result)}catch(e){status.textContent=e.message}}
  function download(items){try{const content=window.SameEndReaderCore.calendar(items,{reminderMinutes:settings.reminderMinutes??15});const url=URL.createObjectURL(new Blob([content],{type:'text/calendar;charset=utf-8'})),a=el('a');a.href=url;a.download='same-end-matches.ics';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent='Calendar file downloaded with reminders. Open it in your calendar and accept the import. Re-download after a kick-off change.'}catch(e){status.textContent=e.message}}
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==origin)return;
    const data=event.data;
    if(data?.type==='SAMEEND_LOCAL_READY'){available=true;connected=data.connected===true;render();if(connected)act('GET');return}
    if(data?.type!=='SAMEEND_LOCAL_RESPONSE')return;const pending=waiting.get(data.id);if(!pending)return;clearTimeout(pending.timer);waiting.delete(data.id);pending.resolve(data);
  });
  function init(){const anchor=document.getElementById('match-finder')||document.getElementById('quick-room');if(!anchor)return;
    panel=el('details');panel.id='personal-listings';panel.className='personal-listings';const heading=el('summary','My matches · on this computer');panel.append(heading);
    const inner=el('div');inner.className='pl-inner';inner.append(el('p','Private imports and reminders. Nothing here is added to your club diary or sent to Same End’s servers.'));
    const actions=el('div');actions.className='pl-actions';
    function button(label,action){const b=el('button',label);b.type='button';if(action)b.dataset.sameendLocalAction=action;actions.append(b);return b}
    connect=button('Connect my local matches','CONNECT');connect.onclick=()=>{if(!available){status.textContent='Install the small helper first, then reopen this page.';return}act('CONNECT')};
    refresh=button('Refresh my matches','GET');refresh.onclick=()=>act('GET');calendar=button('Add all to calendar');calendar.onclick=()=>download(matches);
    const setup=el('a','Get the Mac / Windows helper ↗');setup.href='./reader-setup.html';setup.target='_blank';setup.rel='noopener';actions.append(setup);disconnect=button('Disconnect','DISCONNECT');disconnect.onclick=()=>act('DISCONNECT');inner.append(actions);
    const controls=el('div');controls.className='pl-settings';const label=el('label');remind=el('input');remind.type='checkbox';remind.dataset.sameendLocalAction='SETTINGS';label.append(remind,document.createTextNode('Remind me on this computer'));controls.append(label);
    offset=el('select');offset.setAttribute('aria-label','Reminder before kick-off');offset.dataset.sameendLocalAction='SETTINGS';for(const minutes of [0,5,15,30,60]){const option=el('option',minutes?minutes+' minutes before':'At kick-off');option.value=String(minutes);offset.append(option)}controls.append(offset);
    const saveSettings=()=>act('SETTINGS',{settings:{...settings,remindersEnabled:remind.checked,reminderMinutes:Number(offset.value)}});remind.onchange=offset.onchange=saveSettings;inner.append(controls);
    list=el('div');list.className='pl-list';inner.append(list);status=el('p');status.className='pl-status';status.setAttribute('role','status');inner.append(status,el('small','Desktop reminders need the browser running. Calendar reminders use your calendar’s settings; a synced calendar may keep a private cloud copy.'));
    panel.append(inner);anchor.before(panel);if(new URLSearchParams(location.search).get('local')==='1')panel.open=true;render();window.postMessage({type:'SAMEEND_LOCAL_REQUEST',id:crypto.randomUUID(),action:'HELLO'},origin);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
