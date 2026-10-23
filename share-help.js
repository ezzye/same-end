/* Phone hosting policy and Mac capture guidance. No OS settings are changed. */
(()=>{
 'use strict';
 const key='sameend.mac-share-guidance',ua=navigator.userAgent||'';
 // Desktop-mode iPhones and iPads can identify as Macintosh. Keep touch Apple devices join-only.
 const phone=/iPhone|iPad|iPod|Android.*Mobile|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini/i.test(ua)||navigator.userAgentData?.mobile===true||(/Macintosh|Mac OS X/.test(ua)&&navigator.maxTouchPoints>1);
 const phoneMessage='Start a cast on a computer.';
 if(phone){const capture=document.getElementById('capture'),demo=document.getElementById('demo');if(capture){capture.disabled=true;capture.hidden=true;}if(demo){demo.disabled=true;demo.title=phoneMessage;}}
 const mac=/Macintosh|Mac OS X/.test(ua)&&!(/iPhone|iPad|iPod/.test(ua)||navigator.maxTouchPoints>1);
 const applicable=mac&&/Chrome\/|Edg\//.test(ua);
 let seen=false,panel;
 try{seen=localStorage.getItem(key)==='seen';}catch{}
 function close(){panel.hidden=true;document.getElementById('capture')?.focus();}
 function show(denied=false){
  if(!panel){
   panel=document.createElement('section');panel.id='mac-share-help';panel.className='mac-share-help';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','mac-share-heading');
   panel.innerHTML='<div class="mac-share-window"><h2 id="mac-share-heading">Before you share on this Mac</h2><p id="mac-share-context"></p><ol><li>If macOS asks, allow screen recording for your browser in <strong>System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording</strong>.</li><li>On Big Sur and other older Macs: <strong>System Preferences → Security &amp; Privacy → Privacy → Screen Recording</strong>. Unlock the padlock if shown. Your Mac may ask for an administrator password or Touch ID; enter it only in the macOS prompt.</li><li>If asked, <strong>Quit &amp; Reopen</strong> the browser. A page refresh is not a browser restart. Return to Same End and choose <strong>Share a tab</strong> again.</li></ol><p>You normally set this up once per browser, although macOS or browser updates can ask again. You still choose the tab for each share. Watching an invitation does not need screen-recording permission.</p><p><a href="https://support.apple.com/en-gb/guide/mac-help/mchld6aa7d23/mac" target="_blank" rel="noopener noreferrer">Apple’s permission guide ↗</a></p><div class="row"><button id="mac-share-continue" type="button">Choose a tab</button><button id="mac-share-cancel" type="button" class="secondary">Not now</button></div></div>';
   document.body.append(panel);
   document.getElementById('mac-share-cancel').onclick=close;
   document.getElementById('mac-share-continue').onclick=()=>{seen=true;try{localStorage.setItem(key,'seen');}catch{}close();document.getElementById('capture').click();};
   panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();}if(e.key==='Tab'){const controls=[...panel.querySelectorAll('a,button')],first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
  }
  document.getElementById('mac-share-context').textContent=denied?'Nothing was captured. If you cancelled the tab picker, try again. If macOS blocked sharing, check the permission below; Same End cannot tell these two cases apart.':'The first share can need a Mac permission change and a browser restart. Save any work in other browser tabs first. Same End never asks for your administrator password.';
  panel.hidden=false;document.getElementById('mac-share-continue').focus();
 }
 window.SameEndShareHelp={phone,phoneMessage,beforeShare(){if(phone)return true;if(!applicable||seen)return false;show();return true;},denied(){if(applicable)show(true);}};
})();
