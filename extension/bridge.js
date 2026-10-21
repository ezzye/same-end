/* Same End receives local matches only after the person connects this browser. */
(()=>{
  'use strict';
  const allowed=new Set(['https://www.sameend.com','https://sameend.com']);
  if(window!==window.top||!allowed.has(location.origin)||!/^\/(?:watch\.html|index\.html)?$/.test(location.pathname))return;
  const gestures=new Map();
  for(const kind of ['click','change'])document.addEventListener(kind,event=>{
    if(!event.isTrusted)return;
    const target=event.target.closest?.('[data-sameend-local-action]');
    if(target)gestures.set(target.dataset.sameendLocalAction,performance.now());
  },true);
  const post=data=>window.postMessage(data,location.origin);
  const ready=async()=>{const saved=await chrome.storage.local.get('sameEndConnected');post({type:'SAMEEND_LOCAL_READY',version:chrome.runtime.getManifest().version,connected:saved.sameEndConnected===true})};
  window.addEventListener('message',async event=>{
    const q=event.data;
    if(event.source!==window||event.origin!==location.origin||q?.type!=='SAMEEND_LOCAL_REQUEST'||!/^[-\w]{1,80}$/.test(q.id||''))return;
    const respond=result=>post({type:'SAMEEND_LOCAL_RESPONSE',id:q.id,...result});
    try{
      if(q.action==='HELLO'){await ready();return}
      if(!['CONNECT','DISCONNECT','GET','REMOVE','CLEAR','SETTINGS','OPEN','TEST_NOTIFICATION'].includes(q.action))throw Error('That local action is unavailable.');
      if(q.action!=='GET'){
        const when=gestures.get(q.action);gestures.delete(q.action);
        if(when===undefined||performance.now()-when>1200)throw Error('Choose this action using its button.');
      }
      if(q.action==='CONNECT')await chrome.storage.local.set({sameEndConnected:true});
      if(q.action==='DISCONNECT'){await chrome.storage.local.set({sameEndConnected:false});respond({ok:true,matches:[]});return}
      const consent=await chrome.storage.local.get('sameEndConnected');
      if(consent.sameEndConnected!==true)throw Error('Connect local matches on this browser first.');
      const message={type:'SE_LOCAL',action:q.action==='CONNECT'?'GET':q.action};
      if(q.action==='REMOVE')message.ids=Array.isArray(q.ids)?q.ids.filter(id=>typeof id==='string'&&id.length<=160).slice(0,200):[];
      if(q.action==='SETTINGS')message.settings={reminderMinutes:q.settings?.reminderMinutes,remindersEnabled:q.settings?.remindersEnabled,country:q.settings?.country};
      const result=await chrome.runtime.sendMessage(message);
      respond(result||{ok:false,error:'The local helper did not reply. Reopen this page.'});
    }catch(e){respond({ok:false,error:String(e.message||e).slice(0,220)})}
  });
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&('sameEndLocalV1'in changes||'sameEndConnected'in changes))ready().catch(()=>{})});
  ready().catch(()=>{});
})();
