/* Optional installation guidance. Never navigates, copies or stores room invitations. */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id),ua=navigator.userAgent||'';
 const apple=/iPhone|iPad|iPod/.test(ua)||(/Macintosh|Mac OS X/.test(ua)&&navigator.maxTouchPoints>1);
 const android=/Android/i.test(ua),mobile=apple||android||navigator.userAgentData?.mobile===true;
 const embedded=/FBAN|FBAV|Instagram|\bLine\/|Twitter|Snapchat|WhatsApp|Telegram|;\s*wv\)/i.test(ua);
 const mode=window.matchMedia?window.matchMedia('(display-mode: standalone)'):null;
 const overlay=$('install-help'),shortcut=$('mobile-install'),legacy=$('install-app'),now=$('install-now');
 let promptEvent=null,busy=false,installed=false,returnFocus=null;
 const isInstalled=()=>installed||navigator.standalone===true||mode?.matches===true;
 function render(){
  const done=isInstalled();shortcut.hidden=!mobile||done;legacy.hidden=!promptEvent||done;now.hidden=!promptEvent||done;
  $('install-apple').hidden=done||!apple;$('install-android').hidden=done||!android;$('install-desktop').hidden=done||apple||android;
  now.disabled=busy;legacy.disabled=busy;shortcut.disabled=busy;
  $('pwa-help').textContent=done?'Same End is open as an app. Keep your invitation to rejoin your room.':location.protocol==='file:'?'Open sameend.com in Safari or Chrome to install it.':'Install it for a Home Screen shortcut. You can also keep watching in your browser.';
 }
 function close(){overlay.hidden=true;shortcut.setAttribute('aria-expanded','false');$('install-instructions').setAttribute('aria-expanded','false');if(returnFocus&&!returnFocus.hidden)returnFocus.focus();}
 function open(message,trigger){
  if(overlay.hidden)returnFocus=trigger||document.activeElement;overlay.hidden=false;shortcut.setAttribute('aria-expanded','true');$('install-instructions').setAttribute('aria-expanded','true');
  $('install-context').textContent=message||(isInstalled()?'You’re already using Same End as an app.':location.protocol==='file:'?'Open sameend.com in your browser first.':embedded?'Open this page in '+(apple?'Safari':'Chrome')+' from this app’s menu, then follow these steps.':'');
  render();$('install-close').focus();
 }
 async function install(tap){
  const trigger=tap?.currentTarget||shortcut;
  if(busy)return;if(isInstalled()){open(null,trigger);return;}if(!promptEvent){open(null,trigger);return;}
  const event=promptEvent;promptEvent=null;busy=true;render();
  try{
   // prompt() must run synchronously inside this tap, before any await.
   await event.prompt();const choice=await event.userChoice;
   if(choice?.outcome==='accepted'){if(!overlay.hidden)$('install-context').textContent='Finish the installation in your browser. Keep your invitation to rejoin.';}
   else open('Not installed. You can keep watching here, or add Same End later from your browser menu.',trigger);
  }catch{open('The install prompt is unavailable. Use your browser menu below.',trigger);}
  finally{busy=false;render();}
 }
 window.addEventListener('beforeinstallprompt',event=>{if(isInstalled())return;event.preventDefault();promptEvent=event;render();});
 window.addEventListener('appinstalled',()=>{installed=true;promptEvent=null;render();if(!overlay.hidden)$('install-context').textContent='Same End was added. Keep your invitation to rejoin your room.';});
 if(mode?.addEventListener)mode.addEventListener('change',render);else if(mode?.addListener)mode.addListener(render);
 shortcut.onclick=install;legacy.onclick=install;now.onclick=install;$('install-instructions').onclick=event=>open(null,event.currentTarget);$('install-close').onclick=close;$('install-done').onclick=close;
 overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
 overlay.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();close();}
  if(event.key==='Tab'){const controls=Array.from(overlay.querySelectorAll('a,button')).filter(el=>!el.disabled&&el.getClientRects().length),first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 });
 render();
})();
