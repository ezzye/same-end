/* Invitation diagnostics are local, allowlisted facts. Never retain input links,
 * exceptions, snapshots, chat, identifiers or connection candidates in reports. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const MESSAGES={
    'browser-feature':'This browser is missing a feature needed for the picture. Open the invitation in Safari, Chrome or Edge.',
    'room-unavailable':'The picture could not connect. Check that your host still has the room open, and ask for a fresh invitation.',
    'chat-unavailable':'Chat could not connect. You can still try the picture. Your host can use the report below to help.',
    'video-decode':'The picture could not play in this browser. Try Safari, Chrome or Edge, or ask your host to start a fresh room.',
    'connection-slow':'The room is taking longer to connect. Keep this page open and check that your host is still sharing.',
    'picture-stalled':'Your picture has stopped advancing. Keep the page open while the room reconnects.',
    'app-error':'Something interrupted joining. Send your host this check so they can help.',
    'invitation-incomplete':'This invitation is incomplete. Ask your host to send a fresh, complete link.'
  };
  const S={active:false,kind:'screen',attempt:0,started:0,phase:'not-started',checks:null,sample:'not-run',failure:null,failures:[],connectedAt:null,lastAdvance:0,lastTime:null,picture:false,hasPicture:false,sharing:false};
  let probePromise=null,probeCancel=null,timer=null,panel=null,completed=false;
  function device(){
    const ua=navigator.userAgent||'';const pick=re=>{const m=ua.match(re);return m?m[1].replace(/_/g,'.').slice(0,24):null;};
    let os='Other',version=null,browser='Other',browserVersion=null;
    if(/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1)){os=/iPad/.test(ua)||navigator.maxTouchPoints>1&&!/iPhone/.test(ua)?'iPadOS':'iOS';version=pick(/OS ([\d_]+)/);}
    else if(/Android/.test(ua)){os='Android';version=pick(/Android ([\d.]+)/);}
    else if(/CrOS/.test(ua)){os='ChromeOS';version=pick(/CrOS [^ ]+ ([\d.]+)/);}
    else if(/Windows/.test(ua)){os='Windows';version=pick(/Windows NT ([\d.]+)/);}
    else if(/Macintosh/.test(ua)){os='macOS';version=pick(/Mac OS X ([\d_]+)/);}
    else if(/Linux/.test(ua))os='Linux';
    for(const [name,re] of [['Edge',/(?:Edg|EdgiOS|EdgA)\/([\d.]+)/],['Firefox',/(?:Firefox|FxiOS)\/([\d.]+)/],['Chrome',/(?:Chrome|CriOS)\/([\d.]+)/],['Safari',/Version\/([\d.]+).*Safari/]]){const v=pick(re);if(v){browser=name;browserVersion=v;break;}}
    return {os,version,browser,browserVersion,reportedByBrowser:true};
  }
  function capabilities(){
    const v=document.createElement('video'),mime='video/mp4;codecs=avc1.42001f,mp4a.40.2';
    return {secureContext:window.isSecureContext===true,webCrypto:!!window.crypto?.subtle,webRTC:typeof window.RTCPeerConnection==='function',mp4Reported:!!v.canPlayType(mime),mediaSource:typeof window.MediaSource==='function',managedMediaSource:typeof window.ManagedMediaSource==='function'};
  }
  function facts(){
    let snap=null;try{snap=window.PrivateCast?.snapshot();}catch{}
    const v=$('player');const allowed=(x,choices)=>choices.includes(x)?x:null;
    return {phase:S.phase,role:allowed(snap?.role,['source','viewer']),mediaFormat:typeof snap?.mime==='string'?(snap.mime.startsWith('video/mp4')?'mp4':snap.mime.startsWith('video/webm')?'webm':null):null,playbackMode:allowed(snap?.playbackMode,['mse','clips']),groupDelaySeconds:allowed(snap?.config?.delay,[10,60,300]),peerConnected:!!snap?.peers?.some(p=>p.ready&&p.state==='connected'),clockReady:snap?.clockReady===true,videoPiecesReceived:Number(snap?.received)>0,pictureAdvanced:S.picture,audioTrackIncluded:snap?.config?.audio===true,muted:v?.muted===true,pageVisible:document.visibilityState==='visible',online:navigator.onLine!==false};
  }
  // Validate again on receipt: reports originate from other club members.
  function cleanReport(input={}){
    const one=(v,list)=>list.includes(v)?v:null,version=v=>typeof v==='string'&&/^[0-9]+(?:[._][0-9]+){0,4}$/.test(v)&&v.length<=24?v:null;
    const checks={},joining={},d=input.device||{},j=input.joining||{},c=input.checks||{};
    for(const k of ['secureContext','webCrypto','webRTC','mp4Reported','mediaSource','managedMediaSource'])checks[k]=c[k]===true;
    joining.phase=one(j.phase,['not-started','checking','finding-room','joining-chat','club-ready','waiting-for-group','playing']);joining.role=one(j.role,['source','viewer']);joining.mediaFormat=one(j.mediaFormat,['mp4','webm']);joining.playbackMode=one(j.playbackMode,['mse','clips']);joining.groupDelaySeconds=one(j.groupDelaySeconds,[10,60,300]);
    for(const k of ['peerConnected','clockReady','videoPiecesReceived','pictureAdvanced','audioTrackIncluded','muted','pageVisible','online'])joining[k]=j[k]===true;
    const stamp=typeof input.checkedAt==='string'?Date.parse(input.checkedAt):NaN;
    return {schema:1,app:'Same End',build:typeof input.build==='string'&&/^(?:local|[a-f0-9]{7,40})$/.test(input.build)?input.build:'unknown',checkedAt:Number.isFinite(stamp)?new Date(stamp).toISOString():null,device:{os:one(d.os,['iOS','iPadOS','Android','ChromeOS','Windows','macOS','Linux','BSD','Other'])||'Other',version:version(d.version),browser:one(d.browser,['Edge','Firefox','Chrome','Safari','Other'])||'Other',browserVersion:version(d.browserVersion),reportedByBrowser:true},invitationKind:one(input.invitationKind,['screen','club']),checks,silentSample:one(input.silentSample,['not-run','unavailable','cancelled','decoded','not-confirmed-without-tap','decode-not-confirmed']),joining,problem:Object.hasOwn(MESSAGES,input.problem)?input.problem:null,observedProblems:Array.isArray(input.observedProblems)?input.observedProblems.filter(k=>Object.hasOwn(MESSAGES,k)).slice(0,8):[],privacy:'Created on this device. Private links, keys, chat, names, IP addresses and raw errors are excluded. Sent only when you choose; host inbox access is restricted to the organiser.'};
  }
  function report(){
    const build=String(window.SameEndConfig?.buildId||'local');
    return cleanReport({schema:1,app:'Same End',build:/^(?:local|[a-f0-9]{7,40})$/.test(build)?build:'unknown',checkedAt:new Date().toISOString(),device:device(),invitationKind:S.kind,checks:S.checks?{...S.checks}:capabilities(),silentSample:S.sample,joining:facts(),problem:S.failure,observedProblems:S.failures.slice(),privacy:'Created on this device. No private link, club name, key, chat, IP address or raw error is included. Nothing is uploaded automatically.'});
  }
  function mount(){
    if(panel)return panel;const main=document.querySelector('main');if(!main)return null;
    panel=document.createElement('section');panel.id='invite-check';panel.className='invite-check';panel.setAttribute('aria-label','Joining check');
    panel.innerHTML='<div class="invite-check-top"><div><strong id="invite-check-title">Getting your seat ready…</strong><p id="invite-check-message" role="status" aria-live="polite">Checking your browser while we connect.</p></div><button id="invite-check-help" class="secondary" type="button">Having trouble?</button></div><div id="invite-check-actions" hidden><p class="invite-check-privacy">Send this check to the person who invited you. It leaves out your private link and chat.</p><div class="invite-check-buttons"><button id="invite-check-share" type="button">Send report to your host</button><button id="invite-check-other" class="secondary" type="button">Share another way</button><button id="invite-check-copy" class="secondary" type="button">Copy report</button><button id="invite-check-save" class="secondary" type="button">Save report</button></div><p id="invite-check-report-status" role="status" aria-live="polite"></p><details><summary>What the report contains</summary><textarea id="invite-check-report" readonly aria-label="Private device report" rows="9"></textarea></details></div>';
    const top=main.querySelector('.topbar');if(top)top.after(panel);else main.prepend(panel);
    $('invite-check-help').onclick=()=>{showHelp();};
    $('invite-check-share').onclick=sendToHost;$('invite-check-other').onclick=shareReport;$('invite-check-copy').onclick=copyReport;$('invite-check-save').onclick=saveReport;
    return panel;
  }
  function reportText(){const text='Same End connection check\n'+JSON.stringify(report(),null,2);if($('invite-check-report'))$('invite-check-report').value=text;return text;}
  function showHelp(){mount();if(!panel)return;panel.hidden=false;$('invite-check-actions').hidden=false;reportText();}
  function render(){
    mount();if(!panel)return;
    if(S.failure){panel.hidden=false;panel.classList.add('invite-check-problem');$('invite-check-title').textContent='Let’s get you connected';$('invite-check-message').textContent=MESSAGES[S.failure];showHelp();}
    else{panel.classList.remove('invite-check-problem');$('invite-check-title').textContent=S.phase==='playing'||S.phase==='club-ready'?'You’re in':S.phase==='waiting-for-group'?'Your seat is ready':'Getting your seat ready…';$('invite-check-message').textContent=S.phase==='waiting-for-group'?'Connected. Everyone waits for the same delayed picture.':S.phase==='playing'?'Your picture is playing with the group.':S.phase==='club-ready'?'Your club is open.':'Checking your browser while we connect.';}
  }
  function fail(code){if(!S.active||!Object.hasOwn(MESSAGES,code))return;if(S.failure==='browser-feature'&&code!=='browser-feature')return;if(code!==S.failure&&$('invite-check-share')){$('invite-check-share').disabled=false;$('invite-check-share').textContent='Send report to your host';}S.failure=code;if(!S.failures.includes(code)&&S.failures.length<8)S.failures.push(code);render();}
  function clearProblem(){if(!S.failure)return;S.failure=null;if(panel){panel.classList.remove('invite-check-problem');$('invite-check-actions').hidden=true;}}
  function probe(){
    if(probePromise)return probePromise;
    probePromise=new Promise(resolve=>{
      if(!window.SameEndInviteSample){S.sample='unavailable';resolve();return;}
      let url=null,v=null,done=false;
      const finish=result=>{if(done)return;done=true;clearTimeout(timeout);S.sample=result;probeCancel=null;if(v){v.pause();v.removeAttribute('src');v.load();v.remove();}if(url)URL.revokeObjectURL(url);resolve();};
      const timeout=setTimeout(()=>finish('not-confirmed-without-tap'),3500);probeCancel=()=>finish('cancelled');
      try{const raw=atob(window.SameEndInviteSample),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);url=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));v=document.createElement('video');v.muted=true;v.playsInline=true;v.preload='auto';v.setAttribute('playsinline','');v.setAttribute('aria-hidden','true');v.className='invite-check-probe';v.onloadeddata=()=>{if(v.readyState>=2)finish('decoded');};v.onerror=()=>finish('decode-not-confirmed');mount()?.append(v);v.src=url;v.load();v.play().catch(()=>{});}catch{finish('decode-not-confirmed');}
    });return probePromise;
  }
  function start(kind='screen'){
    if(S.active){if(kind==='screen'&&S.kind!=='screen'){S.kind='screen';S.started=Date.now();S.phase='checking';S.connectedAt=null;S.lastAdvance=0;S.lastTime=null;S.picture=false;S.hasPicture=false;completed=false;clearProblem();probe();if(!S.checks.webRTC)fail('browser-feature');}return;}
    S.active=true;if($('invite-check-share')){$('invite-check-share').disabled=false;$('invite-check-share').textContent='Send report to your host';}S.kind=kind==='club'?'club':'screen';S.started=Date.now();S.phase='checking';S.checks=capabilities();completed=false;mount();render();
    if(!S.checks.secureContext||!S.checks.webCrypto||(S.kind==='screen'&&!S.checks.webRTC))fail('browser-feature');
    if(S.kind==='screen')probe();timer=setInterval(observe,700);observe();
  }
  function phase(value){if(!S.active)return;if(['finding-room','joining-chat','club-ready'].includes(value)){S.phase=value;if(value==='club-ready'&&S.kind==='club'){clearProblem();completed=true;if(panel)panel.hidden=true;}}}
  function observe(){
    if(!S.active)return;let snap;try{snap=window.PrivateCast?.snapshot();}catch{return;}
    if(S.kind==='club'){if(window.SameEndSocial?.snapshot().connected){phase('club-ready');}return;}
    if(!snap?.config){if(!completed&&Date.now()-S.started>45000&&!S.failure)fail('connection-slow');return;}
    if(snap.role!=='viewer')return;
    const connected=snap.peers?.some(p=>p.ready&&p.state==='connected');if(connected&&!S.connectedAt)S.connectedAt=Date.now();
    if(!snap.clockReady&&!completed&&Date.now()-S.started>45000&&!S.failure)fail('connection-slow');
    if(S.failure==='chat-unavailable'&&window.SameEndSocial?.snapshot().connected)clearProblem();
    const target=snap.clockReady?(Date.now()+snap.offset-snap.config.epoch)/1000-snap.config.delay:null;
    const v=$('player');if(target!==null&&target<0&&connected){S.phase='waiting-for-group';if(!['chat-unavailable','video-decode','browser-feature'].includes(S.failure))clearProblem();render();return;}
    if(v&&v.readyState>=2&&!v.paused){const t=v.currentTime;if(S.lastTime!==null&&Math.abs(t-S.lastTime)>.02){S.picture=true;S.hasPicture=true;S.lastAdvance=Date.now();S.phase='playing';completed=true;if(S.failure!=='chat-unavailable')clearProblem();if(panel&&!S.failure)panel.hidden=true;}S.lastTime=t;}
    if(target!==null&&target>=0&&Date.now()-Math.max(S.connectedAt||S.started,S.lastAdvance)>25000&&!S.failure&&document.visibilityState==='visible')fail(S.hasPicture?'picture-stalled':'connection-slow');
  }
  async function sendToHost(){
    if(S.sharing)return;
    if(!window.SameEndSocial?.canSendDeviceReport?.()){ $('invite-check-report-status').textContent='This invitation has no connected host inbox. Use sharing, Copy or Save below.';return shareReport(); }
    const button=$('invite-check-share');S.sharing=true;button.disabled=true;button.textContent='Sending…';
    try{await window.SameEndSocial.sendDeviceReport(report());button.textContent='Report sent ✓';$('invite-check-report-status').textContent='Sent to your host’s inbox in Same End. They can read it there for the next 24 hours.';}
    catch{button.disabled=false;button.textContent='Try sending again';$('invite-check-report-status').textContent='The host inbox could not be reached. Try again, or use Share another way, Copy or Save.';}
    finally{S.sharing=false;}
  }
  async function shareReport(){const text=reportText();if(typeof navigator.share==='function'){try{await navigator.share({title:'Same End connection check',text});$('invite-check-report-status').textContent='Report handed to your sharing app. Choose your host to send it.';return;}catch(e){if(e.name==='AbortError')return;}}await copyReport();}
  async function copyReport(){const text=reportText();try{if(!navigator.clipboard?.writeText)throw Error();await navigator.clipboard.writeText(text);$('invite-check-report-status').textContent='Report copied. Paste it into your chat with your host.';}catch{const box=$('invite-check-report');box.closest('details').open=true;box.focus();box.select();$('invite-check-report-status').textContent='Report selected. Choose Copy, then paste it into your chat with your host.';}}
  function saveReport(){const file=new Blob([JSON.stringify(report(),null,2)],{type:'application/json'}),url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download='same-end-connection-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),4000);$('invite-check-report-status').textContent='Report saved. Attach it to your chat with your host.';}
  function stop(){clearInterval(timer);timer=null;probeCancel?.();S.active=false;if(panel)panel.hidden=true;}
  window.SameEndInviteCheck={start,phase,fail,report,cleanReport,stop};
  if($('room-check-help'))$('room-check-help').onclick=()=>{if(!S.active)start('screen');showHelp();panel?.scrollIntoView({block:'center',behavior:'smooth'});};
  window.addEventListener('error',()=>{if(S.active)fail('app-error');});
  window.addEventListener('unhandledrejection',()=>{if(S.active)fail('app-error');});
  window.addEventListener('beforeunload',()=>{clearInterval(timer);probeCancel?.();});
  // Record only launch intent; the actual values are consumed by existing joins.
  function launchIntent(){const q=new URLSearchParams(location.hash.slice(1));if(q.has('join'))start('screen');else if(q.has('club')||q.has('openclub'))start('club');}
  window.addEventListener('hashchange',launchIntent);launchIntent();
})();
