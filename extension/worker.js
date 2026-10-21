importScripts('reader-core.js','bbc-follow.js');
const FOLLOW_KEY='sameEndBBCFollowV1',AUTO_ALARM='sameend-bbc-daily',TEST_ALARM='sameend-test-reminder',VERSION='0.2.0';
const CORE=self.SameEndReaderCore,PREFIX='sameend-local:',KEY='sameEndLocalV1';
const DEFAULTS={country:'GB',reminderMinutes:15,remindersEnabled:true};
let serial=Promise.resolve();
const cleanSettings=s=>({country:['GB','US','IE','FR'].includes(s?.country)?s.country:'GB',reminderMinutes:[0,5,10,15,30,60].includes(Number(s?.reminderMinutes))?Number(s.reminderMinutes):15,remindersEnabled:s?.remindersEnabled!==false});
async function state(){const x=await chrome.storage.local.get([KEY,'sameEndConnected',FOLLOW_KEY]);return {data:x[KEY]||{matches:[],settings:DEFAULTS},connected:x.sameEndConnected===true,follow:x[FOLLOW_KEY]||{enabled:false,team:'aston-villa'}};}
const allAlarms=async()=>(await chrome.alarms.getAll()).filter(a=>a.name.startsWith(PREFIX));
async function schedule(matches,settings){const alarms=await allAlarms(),byName=new Map(alarms.map(a=>[a.name,a])),byId=new Map(matches.map(m=>[m.id,m])),now=Date.now();for(const a of alarms){const id=decodeURIComponent(a.name.slice(PREFIX.length)),m=byId.get(id);if(!settings.remindersEnabled||!m||m.status!=='scheduled'||m.startsAt<now-600000)await chrome.alarms.clear(a.name);}
 if(!settings.remindersEnabled)return;for(const m of matches)if(m.status==='scheduled'&&m.startsAt>=now-600000){const name=PREFIX+encodeURIComponent(m.id),old=byName.get(name),fired=await chrome.storage.local.get('fired:'+m.id),target=m.startsAt-settings.reminderMinutes*60000;if(fired['fired:'+m.id])continue;if(old&&!(target>now&&Math.abs(old.scheduledTime-target)>1500))continue;if(old)await chrome.alarms.clear(name);chrome.alarms.create(name,{when:Math.max(now+1000,target)});}}
async function mergeAndPersist(d,items){const map=new Map(d.matches.map(x=>[x.id,x]));for(const x of CORE.normalize(items)){const old=map.get(x.id);if(old&&(old.startsAt!==x.startsAt||old.status!==x.status))await chrome.storage.local.remove('fired:'+x.id);map.set(x.id,x);}d.matches=[...map.values()];return persist(d);}
async function persist(s){s.matches=CORE.normalize(s.matches);s.settings=cleanSettings(s.settings);await chrome.storage.local.set({[KEY]:s});await schedule(s.matches,s.settings);return {matches:s.matches,settings:s.settings,version:VERSION};}
function allowedSource(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)return false;const h=u.hostname.toLowerCase(),p=u.pathname;if(['www.bbc.co.uk','www.bbc.com'].includes(h))return /^\/sport\/football\/(?:teams\/[^/]+\/(?:scores-fixtures|results)|scores-fixtures|fixtures)(?:\/|$)/.test(p);if(h==='www.livesoccertv.com')return /^\/(?:match|schedules)(?:\/|$)/.test(p);if(h==='www.live-footballontv.com')return p==='/'||/^\/(?:football-on-tv|football|fixtures|schedule)(?:\/|$)/.test(p);return false;}catch{return false;}}
function authorized(m,s,st){if(m?.type!=='SE_LOCAL'||s.id!==chrome.runtime.id)return false;try{const u=new URL(s.url||'');if(u.protocol==='chrome-extension:'&&u.host===chrome.runtime.id)return u.pathname==='/popup.html';if(!['https://sameend.com','https://www.sameend.com'].includes(u.origin)||!['/','/index.html','/watch.html'].includes(u.pathname)||!st.connected)return false;return ['GET','REMOVE','CLEAR','SETTINGS','OPEN','TEST_NOTIFICATION'].includes(m.action);}catch{return false;}}
async function perform(m,s,st){const d=st.data;d.settings=cleanSettings(d.settings);switch(m.action){case'GET':return {...d,follow:st.follow,version:VERSION};
case'SAVE':return mergeAndPersist(d,m.matches);
case'SETTINGS':d.settings=cleanSettings(m.settings);return persist(d);
case'REMOVE':{const ids=new Set(Array.isArray(m.ids)?m.ids:[]);d.matches=d.matches.filter(x=>!ids.has(x.id));for(const id of ids)await chrome.storage.local.remove('fired:'+id);return persist(d);}
case'CLEAR':d.matches=[];for(const k of Object.keys(await chrome.storage.local.get(null)))if(k.startsWith('fired:'))await chrome.storage.local.remove(k);return persist(d);
case'OPEN':{await chrome.storage.local.set({sameEndConnected:true});const tabs=await chrome.tabs.query({url:['https://www.sameend.com/watch.html*','https://sameend.com/watch.html*']});if(tabs[0]?.id)await chrome.tabs.update(tabs[0].id,{active:true});else await chrome.tabs.create({url:'https://www.sameend.com/watch.html?local=1'});return {...d,version:VERSION};}
case'IMPORT_TAB':{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!allowedSource(tab.url))throw Error('Open a supported football fixture page first.');await chrome.scripting.executeScript({target:{tabId:tab.id},files:['reader-core.js','capture-page.js']});const [cap]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>globalThis.__SE_LOCAL_CAPTURE_RESULT});if(!cap?.result||!Array.isArray(cap.result.matches))throw Error('This page did not provide supported fixture listings.');const incoming=CORE.normalize(cap.result.matches);return {...await mergeAndPersist(d,incoming),importedCount:incoming.length,warnings:cap.result.warnings||[]};}
case'FETCH_BBC':return self.SameEndBBCFollow.page(m.team,m.month);
case'FOLLOW_BBC':{
 const follow={enabled:m.enabled===true,team:m.team||st.follow.team||'aston-villa',lastSuccess:st.follow.lastSuccess||0};
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(follow.team)||follow.team.length>70)throw Error('Invalid BBC team.');
 if(follow.enabled&&!await chrome.permissions.contains({origins:['https://www.bbc.co.uk/*']}))throw Error('Allow BBC access first.');
 await chrome.storage.local.set({[FOLLOW_KEY]:follow});
 if(!follow.enabled){await chrome.alarms.clear(AUTO_ALARM);return {...d,follow,version:VERSION};}
 chrome.alarms.create(AUTO_ALARM,{periodInMinutes:1440,delayInMinutes:1440});
 await refreshFollowedBBC();const updated=await state();return {...updated.data,follow:updated.follow,version:VERSION};
}
case'TEST_NOTIFICATION':{
 if(chrome.notifications.getPermissionLevel&&await chrome.notifications.getPermissionLevel()!=='granted')throw Error('Allow notifications for this browser first.');
 const previous=(await chrome.storage.local.get('sameEndNotificationTest')).sameEndNotificationTest; if(previous?.scheduledAt>Date.now()-30000)throw Error('Your test reminder is already on its way.'); const scheduledAt=Date.now()+30000;await chrome.storage.local.set({sameEndNotificationTest:{scheduledAt}});chrome.alarms.create(TEST_ALARM,{when:scheduledAt});
 return {...d,version:VERSION,testNotification:{scheduledAt}};
}
default:throw Error('Unknown action');}}
async function refreshFollowedBBC(){
 const {data,follow}=await state();if(!follow.enabled)return;
 try{const matches=await self.SameEndBBCFollow.refresh(follow.team);await mergeAndPersist(data,matches);await chrome.storage.local.set({[FOLLOW_KEY]:{...follow,lastSuccess:Date.now(),error:''}});}
 catch(error){await chrome.storage.local.set({[FOLLOW_KEY]:{...follow,lastAttempt:Date.now(),error:String(error.message||error).slice(0,180)}});throw error;}
}
async function sendTestNotification(){
 const previous=(await chrome.storage.local.get('sameEndNotificationTest')).sameEndNotificationTest||{};
 try{await chrome.notifications.create('sameend-test',{type:'basic',iconUrl:'icons/icon-128.png',title:'Same End test reminder',message:'Your local fixture reminder reached this browser. You can close this test.'});await chrome.storage.local.set({sameEndNotificationTest:{...previous,acceptedAt:Date.now()}});}
 catch(e){await chrome.storage.local.set({sameEndNotificationTest:{...previous,error:String(e.message||e)}});}
}
chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m?.type!=='SE_LOCAL')return false;serial=serial.catch(()=>{}).then(async()=>{const st=await state();if(!authorized(m,s,st))throw Error('Request not allowed');return perform(m,s,st);});serial.then(x=>reply({ok:true,...x}),e=>reply({ok:false,error:e?.message||'Request failed'}));return true;});
chrome.alarms.onAlarm.addListener(a=>{if(a.name===AUTO_ALARM){serial=serial.catch(()=>{}).then(refreshFollowedBBC).catch(()=>{});return;}if(a.name===TEST_ALARM){serial=serial.catch(()=>{}).then(sendTestNotification);return;}if(!a.name.startsWith(PREFIX))return;serial=serial.catch(()=>{}).then(async()=>{const {data}=await state(),id=decodeURIComponent(a.name.slice(PREFIX.length)),m=data.matches.find(x=>x.id===id),fired=await chrome.storage.local.get('fired:'+id);if(fired['fired:'+id]||!m||m.status!=='scheduled'||m.startsAt<Date.now()-600000||!cleanSettings(data.settings).remindersEnabled)return;await chrome.alarms.clear(a.name);await chrome.storage.local.set({['fired:'+m.id]:true});await chrome.notifications.create(a.name,{type:'basic',iconUrl:'icons/icon-128.png',title:'Same End fixture reminder',message:`${m.home} v ${m.away} · ${new Date(m.startsAt).toLocaleString('en-GB',{timeZone:'Europe/London',dateStyle:'medium',timeStyle:'short'})} UK time`});});});
async function checkAlarms(){serial=serial.catch(()=>{}).then(async()=>{const {data,follow}=await state();await schedule(data.matches,cleanSettings(data.settings));if(follow.enabled){if(!(await chrome.alarms.getAll()).some(a=>a.name===AUTO_ALARM))chrome.alarms.create(AUTO_ALARM,{periodInMinutes:1440,delayInMinutes:1440});if(!follow.lastSuccess||Date.now()-Math.max(follow.lastSuccess||0,follow.lastAttempt||0)>=6*3600000)await refreshFollowedBBC();}}).catch(()=>{});}
chrome.runtime.onStartup.addListener(checkAlarms);checkAlarms();
