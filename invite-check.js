/* Invitation diagnostics are local, allowlisted facts. Never retain input links,
 * exceptions, snapshots, chat, identifiers or connection candidates in reports. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const MESSAGES={
    'browser-feature':'This browser is missing a feature needed for the picture. Open the invitation in Safari, Chrome or Edge.',
    'room-unavailable':'You are not watching yet. Check that your host is still sharing, then try again. If it still fails, send your host the report below.',
    'picture-unavailable':'You are not watching yet. We are still trying other connections in the background. Check your host is sharing, try another network, or send your host a report.',
    'playback-blocked':'The room is connected, but this browser needs you to tap Play before the picture and sound can start.',
    'chat-unavailable':'Chat could not connect. You can still try the picture. Your host can use the report below to help.',
    'video-decode':'The picture could not play in this browser. Try Safari, Chrome or Edge, or ask your host to start a fresh room.',
    'connection-slow':'You are not watching yet. We are still finding a direct connection. Searches can take up to 90 seconds; keep this page open while we retry automatically.',
    'picture-stalled':'The picture is no longer moving. Same End is reconnecting automatically. If it does not return, try again or send your host a report.',
    'app-error':'Something interrupted joining. Send your host this check so they can help.',
    'invitation-incomplete':'This invitation is incomplete. Ask your host to send a fresh, complete link.'
  };
  const STARTUP={'chat-started':'chatStartedMs','chat-ready':'chatReadyMs','chat-failed':'chatFailedMs','picture-search':'pictureSearchMs','tracker-reply':'trackerReplyMs','ice-connected':'iceConnectedMs','peer-authenticated':'peerAuthenticatedMs','descriptor-ready':'descriptorReadyMs','supplier-open':'supplierOpenMs','clock-ready':'clockReadyMs','first-media':'firstMediaMs','first-picture':'firstPictureMs','group-wait-start':'groupWaitStartedMs','group-wait-end':'groupWaitEndedMs','play-gesture':'playGestureNeededMs'};
  const ADAPTIVE_PHASES=['warmup','starting','playing','rebuffering','suspended','recovering'];
  const boundedAdaptive=(v,max)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(0,v)):null;
  const ROOM_STATES=['waiting-for-source','source-stopped','source-unreachable','suppliers-full','offline','finding-route','no-direct-route','playing','buffering','warming-up','idle'];
  const monotonic=()=>window.performance?.now?.()??Date.now();
  function cleanStartup(x){if(!x||typeof x!=='object')return null;const out={};for(const k of Object.values(STARTUP))out[k]=typeof x[k]==='number'&&Number.isFinite(x[k])&&x[k]>=0?Math.min(3600000,Math.round(x[k])):null;return out;}
  function mark(name){const key=Object.hasOwn(STARTUP,name)?STARTUP[name]:null;if(!S.active||!key||!S.startup||S.startup[key]!==undefined)return;S.startup[key]=Math.min(3600000,Math.max(0,Math.round(monotonic()-S.timingOrigin)));}
  const S={active:false,kind:'screen',attempt:0,started:0,phase:'not-started',checks:null,sample:'not-run',failure:null,failures:[],connectedAt:null,lastAdvance:0,lastTime:null,picture:false,hasPicture:false,sharing:false,startup:null,timingOrigin:0};
  let probePromise=null,probeCancel=null,timer=null,panel=null,completed=false,backdrop=null,dismissed=false,returnFocus=null,helpOpen=false;
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
  function cleanNetwork(n){
    if(!n||typeof n!=='object')return null;
    const out={phase:['idle','publishing','finding-peers','retrying','descriptor-ready','connected','failed','closed'].includes(n.phase)?n.phase:null,problem:['no-direct-peer','descriptor-invalid','transport-error','cancelled'].includes(n.problem)?n.problem:null,relayConfigured:typeof n.relayConfigured==='boolean'?n.relayConfigured:null};
    out.selectedRoute=['unknown','direct','relay'].includes(n.selectedRoute)?n.selectedRoute:'unknown';
    for(const k of ['localCandidateType','remoteCandidateType'])out[k]=['host','srflx','prflx','relay'].includes(n[k])?n[k]:null;
    out.fallbackState=['direct','requesting','active','unavailable','cooldown','connected'].includes(n.fallbackState)?n.fallbackState:null;
    for(const k of ['elapsedSeconds','trackerCount','stunServerCount','reannounces','trackerReplies','warnings','peerAttempts','peerErrors','monitoredPeers','iceConnected','iceFailed','hostCandidates','reflexiveCandidates','discoveryResets','bootstrapRetries'])out[k]=Number.isFinite(n[k])?Math.max(0,Math.min(86400,Math.floor(n[k]))):null;
    out.resetState=['idle','scheduled','renewing','renewed','unsupported','failed'].includes(n.resetState)?n.resetState:null;
    out.resetProblem=['discovery-adapter-unavailable','discovery-renewal-failed','discovery-session-ended'].includes(n.resetProblem)?n.resetProblem:null;
    const retry=Number.isFinite(n.retryInSeconds)?n.retryInSeconds:Number.isFinite(n.retryAt)?(n.retryAt-Date.now())/1000:null;
    out.retryInSeconds=retry===null?null:Math.max(0,Math.min(60,Math.ceil(retry)));
    return out;
  }
  function roomContext(snap){let room=null;try{room=window.SameEndSocial?.snapshot?.()||null;}catch{}return room;}
  function explainRoom(snap,room=roomContext(snap)){
    const explain=window.SameEndRoomStatus?.explain;if(typeof explain!=='function')return null;
    const pictureMoving=!!(S.picture&&S.lastAdvance&&Date.now()-S.lastAdvance<=2500);
    try{return explain({snapshot:snap||null,room,online:navigator.onLine!==false,elapsedSeconds:S.started?Math.max(0,Math.floor((Date.now()-S.started)/1000)):0,failure:S.failure,pictureMoving});}catch{return null;}
  }
  function cleanAvailability(a){
    if(!a||typeof a!=='object')return null;
    const count=k=>Number.isSafeInteger(a[k])?Math.max(0,Math.min(12,a[k])):null;
    return {authenticatedPeers:count('authenticatedPeers'),rootedSuppliers:count('rootedSuppliers'),fullSuppliers:count('fullSuppliers'),eligibleSuppliers:count('eligibleSuppliers'),unrootedPeers:count('unrootedPeers'),lastReject:['capacity-full','source-unavailable','not-ready','loop','invalid-status'].includes(a.lastReject)?a.lastReject:null};
  }
  function cleanServing(s){
    if(!s||typeof s!=='object')return null;
    const n=(v,max)=>typeof v==='number'&&Number.isFinite(v)?Math.max(0,Math.min(max,v)):null;
    const count=(v,max)=>Number.isSafeInteger(v)?n(v,max):null;
    const bool=v=>typeof v==='boolean'?v:null;
    return {relayLimit:count(s.relayLimit,2),downCount:count(s.downCount,12),availableSlots:count(s.availableSlots,2),leafOnly:bool(s.leafOnly),rooted:bool(s.rooted),clockReady:bool(s.clockReady),sourceAgeSeconds:n(s.sourceAgeSeconds,86400),queueBytes:n(s.queueBytes,1e8),outgoingMbps:n(s.outgoingMbps,10000),cacheRenditions:Array.isArray(s.cacheRenditions)?[...new Set(s.cacheRenditions.filter(r=>['audio','v360','v480'].includes(r)))]:[]};
  }
  function cleanSending(s){
    if(!s||typeof s!=='object')return null;
    const measured=typeof s.measured==='boolean'?s.measured:null;
    const count=v=>Number.isSafeInteger(v)?Math.max(0,Math.min(12,v)):null;
    return {measured,deliveredMbps:measured===true&&typeof s.deliveredMbps==='number'&&Number.isFinite(s.deliveredMbps)?Math.max(0,Math.min(10000,s.deliveredMbps)):null,childCount:count(s.childCount),congestedChildren:count(s.congestedChildren)};
  }
  function facts(){
    let snap=null;try{snap=window.PrivateCast?.snapshot();}catch{}
    const room=roomContext(snap),roomStatus=explainRoom(snap,room),sourceState=room?.roomSource?.state;
    const v=$('player');const allowed=(x,choices)=>choices.includes(x)?x:null;
    const availability=cleanAvailability(snap?.transport?.availability||snap?.availability);
    const serving=cleanServing(snap?.transport?.serving),d=snap?.delivery;
    const sending=cleanSending(d?{measured:d.measured,deliveredMbps:d.deliveredMbps,childCount:Array.isArray(d.peers)?d.peers.length:null,congestedChildren:Array.isArray(d.peers)?d.peers.filter(p=>p.health==='congested').length:null}:null);
    const adaptive=snap?.mediaDiagnostics?.playback||{};
    // An active offer configuration cannot establish whether the server is deployed or available.
    return {serving,sending,commonStart:window.SameEndDiagnosticsCore?.safeCommonStart?.(snap?.commonStart)||null,initialDelay:window.SameEndDiagnosticsCore?.safeInitialDelay?.(snap?.initialDelay)||null,clientDelivery:window.SameEndDiagnosticsCore?.safeClientDelivery?.(snap?.clientDelivery)||null,extraDelaySeconds:boundedAdaptive(snap?.playbackExtraDelaySeconds,86400),adaptivePhase:allowed(snap?.playbackAdaptivePhase,ADAPTIVE_PHASES),bufferGoalSeconds:boundedAdaptive(adaptive.bufferGoalSeconds,30),rebufferCount:boundedAdaptive(adaptive.rebufferCount,1e6),adaptiveSeekCount:boundedAdaptive(adaptive.adaptiveSeekCount,1e6),network:cleanNetwork(snap?.network||snap?.transport?.network),connectionMode:allowed((snap?.network||snap?.transport?.network)?.selectedRoute,['unknown','direct','relay'])||'unknown',relayFallbackConfigured:null,relayOfferConfigured:typeof (snap?.network||snap?.transport?.network)?.relayConfigured==='boolean'?(snap?.network||snap?.transport?.network).relayConfigured:null,authenticatedPeerCount:Number.isSafeInteger(snap?.transport?.authenticatedPeers)?Math.max(0,Math.min(12,snap.transport.authenticatedPeers)):null,availability,roomState:allowed(roomStatus?.code,ROOM_STATES),roomJoined:roomStatus?.roomJoined===true,sourceState:allowed(sourceState,['not-started','sharing','stopped','unreachable','unknown']),descriptorLoaded:!!snap?.config,phase:S.phase,role:allowed(snap?.role,['source','viewer']),mediaFormat:typeof snap?.mime==='string'?(snap.mime==='application/vnd.apple.mpegurl'?'hls':snap.mime.startsWith('video/mp4')?'mp4':snap.mime.startsWith('video/webm')?'webm':null):null,playbackMode:allowed(snap?.playbackMode,['mse','clips','hls','hls-native']),groupDelaySeconds:snap?.commonStart?.enabled===true&&snap.commonStart.state==='pending'?null:(window.SameEndRoomStatus?.groupDelay?.(snap||{})?.seconds??allowed(snap?.config?.delay,[10,60,300])),peerConnected:!!snap?.peers?.some(p=>p.ready&&p.state==='connected'),clockReady:snap?.clockReady===true,videoPiecesReceived:Number(snap?.received)>0,pictureAdvanced:S.picture,audioTrackIncluded:snap?.config?.audio===true,muted:v?.muted===true,pageVisible:document.visibilityState==='visible',online:navigator.onLine!==false,verifiedReserveSeconds:Number.isFinite(snap?.reserveSeconds)?Math.max(0,Math.min(600,Math.round(snap.reserveSeconds))):null,supplierHealth:allowed(snap?.supplierHealth,['healthy','supplier-unresponsive','source-path-stalled','source-progress-stalled','upstream-recovering']),recoveries:Number.isSafeInteger(snap?.recovery?.recoveries)?Math.max(0,Math.min(10000,snap.recovery.recoveries)):0};
  }
  // Validate again on receipt: reports originate from other club members.
  function cleanReport(input={}){
    const one=(v,list)=>list.includes(v)?v:null,version=v=>typeof v==='string'&&/^[0-9]+(?:[._][0-9]+){0,4}$/.test(v)&&v.length<=24?v:null;
    const checks={},joining={},d=input.device||{},j=input.joining||{},c=input.checks||{};
    joining.serving=cleanServing(j.serving);joining.sending=cleanSending(j.sending);
    joining.clientDelivery=window.SameEndDiagnosticsCore?.safeClientDelivery?.(j.clientDelivery)||null;
    joining.commonStart=window.SameEndDiagnosticsCore?.safeCommonStart?.(j.commonStart)||null;
    joining.initialDelay=window.SameEndDiagnosticsCore?.safeInitialDelay?.(j.initialDelay)||null;
    for(const k of ['secureContext','webCrypto','webRTC','mp4Reported','mediaSource','managedMediaSource'])checks[k]=c[k]===true;
    for(const [key,max] of [["extraDelaySeconds",86400],["bufferGoalSeconds",30],["rebufferCount",1e6],["adaptiveSeekCount",1e6]])joining[key]=boundedAdaptive(j[key],max);
    for(const key of ["rebufferCount","adaptiveSeekCount"])if(joining[key]!==null)joining[key]=Math.floor(joining[key]);
    joining.adaptivePhase=one(j.adaptivePhase,ADAPTIVE_PHASES);
    joining.network=cleanNetwork(j.network);joining.connectionMode=one(j.connectionMode,['unknown','direct','relay']);joining.relayFallbackConfigured=typeof j.relayFallbackConfigured==='boolean'?j.relayFallbackConfigured:null;joining.relayOfferConfigured=typeof j.relayOfferConfigured==='boolean'?j.relayOfferConfigured:null;joining.authenticatedPeerCount=Number.isSafeInteger(j.authenticatedPeerCount)?Math.max(0,Math.min(12,j.authenticatedPeerCount)):null;joining.descriptorLoaded=typeof j.descriptorLoaded==='boolean'?j.descriptorLoaded:null;
    joining.roomState=one(j.roomState,ROOM_STATES);joining.roomJoined=typeof j.roomJoined==='boolean'?j.roomJoined:null;joining.sourceState=one(j.sourceState,['not-started','sharing','stopped','unreachable','unknown']);joining.availability=cleanAvailability(j.availability);
    joining.phase=one(j.phase,['not-started','checking','finding-room','joining-chat','club-ready','waiting-for-host','waiting-for-group','playing']);joining.role=one(j.role,['source','viewer']);joining.mediaFormat=one(j.mediaFormat,['mp4','webm','hls']);joining.playbackMode=one(j.playbackMode,['mse','clips','hls','hls-native']);joining.groupDelaySeconds=([10,60,300].includes(j.groupDelaySeconds)||Number.isInteger(j.groupDelaySeconds)&&j.groupDelaySeconds>=30&&j.groupDelaySeconds<=300)?j.groupDelaySeconds:null;
    for(const k of ['peerConnected','clockReady','videoPiecesReceived','pictureAdvanced','audioTrackIncluded','muted','pageVisible','online'])joining[k]=j[k]===true;
    joining.verifiedReserveSeconds=Number.isFinite(j.verifiedReserveSeconds)?Math.max(0,Math.min(600,Math.round(j.verifiedReserveSeconds))):null;joining.supplierHealth=one(j.supplierHealth,['healthy','supplier-unresponsive','source-path-stalled','source-progress-stalled','upstream-recovering']);joining.recoveries=Number.isSafeInteger(j.recoveries)?Math.max(0,Math.min(10000,j.recoveries)):0;
    const stamp=typeof input.checkedAt==='string'?Date.parse(input.checkedAt):NaN;
    return {schema:1,app:'Same End',testSession:window.SameEndDiagnosticsCore?.cleanSummary(input.testSession)||null,build:typeof input.build==='string'&&/^(?:local|[a-f0-9]{7,40})$/.test(input.build)?input.build:'unknown',checkedAt:Number.isFinite(stamp)?new Date(stamp).toISOString():null,device:{os:one(d.os,['iOS','iPadOS','Android','ChromeOS','Windows','macOS','Linux','BSD','Other'])||'Other',version:version(d.version),browser:one(d.browser,['Edge','Firefox','Chrome','Safari','Other'])||'Other',browserVersion:version(d.browserVersion),reportedByBrowser:true},invitationKind:one(input.invitationKind,['screen','club']),checks,startup:cleanStartup(input.startup),silentSample:one(input.silentSample,['not-run','unavailable','cancelled','decoded','not-confirmed-without-tap','decode-not-confirmed']),joining,problem:Object.hasOwn(MESSAGES,input.problem)?input.problem:null,observedProblems:Array.isArray(input.observedProblems)?input.observedProblems.filter(k=>Object.hasOwn(MESSAGES,k)).slice(0,8):[],privacy:'Created on this device. Private links, keys, chat, names, IP addresses and raw errors are excluded. Sent only when you choose; host inbox access is restricted to the organiser.'};
  }
  function report(){
    const build=String(window.SameEndConfig?.buildId||'local');
    return cleanReport({schema:1,app:'Same End',build:/^(?:local|[a-f0-9]{7,40})$/.test(build)?build:'unknown',checkedAt:new Date().toISOString(),device:device(),invitationKind:S.kind,testSession:window.SameEndDiagnostics?.summary?.()||null,checks:S.checks?{...S.checks}:capabilities(),silentSample:S.sample,startup:S.startup,joining:facts(),problem:S.failure,observedProblems:S.failures.slice(),privacy:'Created on this device. No private link, club name, key, chat, IP address or raw error is included. Nothing is uploaded automatically.'});
  }
  function mount(){
    if(panel)return panel;const main=document.querySelector('main');if(!main)return null;
    panel=document.createElement('section');panel.id='invite-check';panel.className='invite-check';panel.setAttribute('aria-label','Joining check');panel.setAttribute('tabindex','-1');
    panel.innerHTML='<div class="invite-check-top"><div><span id="invite-check-icon" aria-hidden="true">…</span><h2 id="invite-check-title">Connecting your picture…</h2><p id="invite-check-message" role="status" aria-live="polite">Checking your browser while we connect.</p></div><button id="invite-check-help" class="secondary" type="button">Having trouble?</button></div><div id="invite-check-next"><button id="invite-check-retry" type="button" hidden>Try connecting again</button><button id="invite-check-play" type="button" hidden>Play picture and sound</button><button id="invite-check-dismiss" class="secondary" type="button" hidden>Close</button></div><div id="invite-check-actions" hidden><p class="invite-check-privacy">Send this check to the person who invited you. It leaves out your private link and chat.</p><div class="invite-check-buttons"><button id="invite-check-share" type="button">Send report to your host</button><button id="invite-check-other" class="secondary" type="button">Share another way</button><button id="invite-check-copy" class="secondary" type="button">Copy report</button><button id="invite-check-save" class="secondary" type="button">Save report</button></div><p id="invite-check-report-status" role="status" aria-live="polite"></p><details><summary>What the report contains</summary><textarea id="invite-check-report" readonly aria-label="Private device report" rows="9"></textarea></details></div>';
    const top=main.querySelector('.topbar');if(top)top.after(panel);else main.prepend(panel);
    backdrop=document.createElement('div');backdrop.className='invite-check-backdrop';backdrop.hidden=true;document.body.append(backdrop);backdrop.onclick=dismiss;
    $('invite-check-help').onclick=()=>{dismissed=false;showHelp(true);render();};$('invite-check-dismiss').onclick=dismiss;$('invite-check-retry').onclick=retry;$('invite-check-play').onclick=()=>{$('sound')?.click();};
    panel.addEventListener('keydown',event=>{if(!panel.classList.contains('is-failure-dialog'))return;if(event.key==='Escape'){event.preventDefault();dismiss();}if(event.key==='Tab'){const controls=[...panel.querySelectorAll('button,summary,a,textarea')].filter(el=>!el.disabled&&el.getClientRects().length),first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel)){event.preventDefault();first?.focus();}}});
    $('invite-check-share').onclick=sendToHost;$('invite-check-other').onclick=shareReport;$('invite-check-copy').onclick=copyReport;$('invite-check-save').onclick=saveReport;
    return panel;
  }
  function reportText(){const text='Same End connection check\n'+JSON.stringify(report(),null,2);if($('invite-check-report'))$('invite-check-report').value=text;return text;}
  function showHelp(manual=false){mount();if(!panel)return;if(manual)helpOpen=true;panel.hidden=false;$('invite-check-actions').hidden=false;reportText();}
  function fatal(){return ['room-unavailable','picture-unavailable','browser-feature','video-decode','invitation-incomplete','app-error','picture-stalled'].includes(S.failure);}
  function closeDialog(){if(!panel)return;const restore=panel.classList.contains('is-failure-dialog')&&panel.contains(document.activeElement);panel.classList.remove('is-failure-dialog');panel.removeAttribute('aria-modal');panel.setAttribute('role','region');backdrop.hidden=true;document.body.classList.remove('has-join-failure');if(restore&&returnFocus?.isConnected)returnFocus.focus();}
  function dismiss(){dismissed=true;helpOpen=false;closeDialog();if(!fatal()&&panel)panel.hidden=true;if($('room-check-help')&&!fatal())$('room-check-help').focus();else if($('invite-check-help'))$('invite-check-help').focus();}
  function openDialog(){if(dismissed||panel.classList.contains('is-failure-dialog'))return;try{if(document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});else if($('player')?.webkitDisplayingFullscreen)$('player').webkitExitFullscreen?.();}catch{}returnFocus=document.activeElement;panel.classList.add('is-failure-dialog');panel.setAttribute('role','alertdialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','invite-check-title');panel.setAttribute('aria-describedby','invite-check-message');backdrop.hidden=false;document.body.classList.add('has-join-failure');try{panel.focus({preventScroll:true});}catch{panel.focus();}}
  async function retry(){const button=$('invite-check-retry');if(button.disabled)return;button.disabled=true;closeDialog();try{const started=await window.PrivateCast?.retryJoin?.();if(started===false)fail('room-unavailable');}catch{fail('room-unavailable');}finally{render();}}
  function render(){
    mount();if(!panel)return;const error=fatal(),blocked=S.failure==='playback-blocked';
    panel.classList.toggle('invite-check-problem',!!S.failure);panel.classList.toggle('invite-check-error',error);panel.classList.toggle('invite-check-action',blocked);panel.dataset.severity=error?'error':S.failure?'warning':'progress';
    $('invite-check-retry').hidden=!error||!window.PrivateCast?.canRetryJoin?.();$('invite-check-retry').disabled=!!window.PrivateCast?.snapshot?.()?.joiningBusy;$('invite-check-play').hidden=!blocked;$('invite-check-dismiss').hidden=!error&&!helpOpen;
    $('invite-check-dismiss').textContent=!error&&helpOpen?'Close report':window.SameEndSocial?.snapshot?.().connected?'Keep chat open':'Close';
    const titles={'room-unavailable':'The picture didn’t connect','picture-unavailable':'The picture hasn’t connected','browser-feature':'This browser can’t show the picture','video-decode':'The picture couldn’t play','invitation-incomplete':'This invitation is incomplete','app-error':'Something interrupted joining','picture-stalled':'Your picture has stopped','connection-slow':'Picture not connected — still trying','playback-blocked':'Tap Play to start watching','chat-unavailable':'Live chat couldn’t connect'};
    $('invite-check-icon').textContent=error?'!':blocked?'▶':S.failure?'…':'○';
    const statusSnapshot=(()=>{try{return window.PrivateCast?.snapshot?.()||null;}catch{return null;}})(),roomStatus=explainRoom(statusSnapshot);
    const preserveFailure=S.failure&&(error||blocked||S.failure==='chat-unavailable');
    if(preserveFailure){panel.hidden=false;$('invite-check-title').textContent=titles[S.failure];$('invite-check-message').textContent=MESSAGES[S.failure];if(error){if($('invite-check-actions').hidden)showHelp();openDialog();}else closeDialog();}
    else if(roomStatus&&ROOM_STATES.includes(roomStatus.code)&&roomStatus.code!=='idle'){
      closeDialog();const playing=roomStatus.code==='playing';panel.hidden=(playing||roomStatus.waiting===true&&roomStatus.roomJoined===true)&&!helpOpen;panel.dataset.severity=['success','warning','error'].includes(roomStatus.tone)?roomStatus.tone:'progress';$('invite-check-icon').textContent=playing?'✓':roomStatus.tone==='error'?'!':'…';$('invite-check-title').textContent=typeof roomStatus.title==='string'?roomStatus.title:'Connecting your picture…';$('invite-check-message').textContent=typeof roomStatus.detail==='string'?roomStatus.detail:'';
    }
    else if(S.failure){panel.hidden=false;$('invite-check-title').textContent=titles[S.failure];$('invite-check-message').textContent=MESSAGES[S.failure];closeDialog();}
    else{closeDialog();$('invite-check-title').textContent=S.phase==='waiting-for-host'?'Your seat is saved':S.phase==='playing'?'You’re watching':S.phase==='club-ready'?'Your club is open':S.phase==='waiting-for-group'?'Connected — waiting for the group':'Connecting your picture…';$('invite-check-message').textContent=S.phase==='waiting-for-host'?'Your host will start sharing here. Keep this room open; the same invitation will reconnect you.':S.phase==='waiting-for-group'?'The picture starts after the group’s chosen delay. This wait is expected.':S.phase==='playing'?'Your picture is playing with the group.':S.phase==='club-ready'?'Your club is open.':'Finding a direct route to your host or another mate. This can take up to 90 seconds.';}
  }
  function fail(code){if(!S.active||!Object.hasOwn(MESSAGES,code))return;if(S.failure==='browser-feature'&&code!=='browser-feature')return;if(code==='chat-unavailable'&&fatal()){if(!S.failures.includes(code)&&S.failures.length<8)S.failures.push(code);return;}if(code!==S.failure&&$('invite-check-share')){$('invite-check-share').disabled=false;$('invite-check-share').textContent='Send report to your host';}if(code==='playback-blocked')mark('play-gesture');if(S.failure!==code)dismissed=false;S.failure=code;if(!S.failures.includes(code)&&S.failures.length<8)S.failures.push(code);render();}
  function clearProblem(){if(!S.failure)return;S.failure=null;dismissed=false;closeDialog();if(panel){panel.classList.remove('invite-check-problem');$('invite-check-actions').hidden=!helpOpen;}}
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
  function start(kind='screen',options={}){
    if(options.fresh&&S.active){clearInterval(timer);timer=null;S.active=false;clearProblem();}

    if(S.active){if(kind==='screen'&&S.kind!=='screen'){S.kind='screen';S.started=Date.now();S.phase='checking';S.connectedAt=null;S.lastAdvance=0;S.lastTime=null;S.picture=false;S.hasPicture=false;completed=false;clearProblem();mount();if(panel)panel.hidden=false;render();probe();if(!S.checks.webRTC)fail('browser-feature');}return;}
    S.active=true;S.startup={};S.timingOrigin=monotonic();S.attempt++;S.failure=null;S.failures=[];S.connectedAt=null;S.lastAdvance=0;S.lastTime=null;S.picture=false;S.hasPicture=false;dismissed=false;helpOpen=false;if($('invite-check-actions'))$('invite-check-actions').hidden=true;if($('invite-check-share')){$('invite-check-share').disabled=false;$('invite-check-share').textContent='Send report to your host';}S.kind=kind==='club'?'club':'screen';S.started=Date.now();S.phase='checking';S.checks=capabilities();completed=false;mount();if(panel)panel.hidden=false;render();
    if(!S.checks.secureContext||!S.checks.webCrypto||(S.kind==='screen'&&!S.checks.webRTC))fail('browser-feature');
    if(S.kind==='screen')probe();timer=setInterval(observe,700);observe();
  }
  function phase(value){if(!S.active)return;if(value==='finding-room')mark('picture-search');if(['finding-room','joining-chat','club-ready','waiting-for-host'].includes(value)){S.phase=value;if(value==='waiting-for-host'){if(!['chat-unavailable','browser-feature','video-decode','invitation-incomplete','app-error'].includes(S.failure))clearProblem();completed=true;render();if(panel&&!S.failure&&!helpOpen)panel.hidden=true;}if(value==='club-ready'&&S.kind==='club'){clearProblem();completed=true;if(panel&&!helpOpen)panel.hidden=true;}}}
  function observe(){
    if(!S.active)return;let snap;try{snap=window.PrivateCast?.snapshot();}catch{return;}
    if(S.kind==='club'){if(window.SameEndSocial?.snapshot().connected){phase('club-ready');}return;}
    const room=roomContext(snap),roomStatus=explainRoom(snap,room),joinedSourceWait=roomStatus?.roomJoined===true&&['waiting-for-source','source-stopped','source-unreachable'].includes(roomStatus.code),knownSourceWait=roomStatus?.roomJoined===true&&['waiting-for-source','source-stopped','source-unreachable','suppliers-full','offline','finding-route','no-direct-route','buffering','warming-up'].includes(roomStatus.code);
    if(joinedSourceWait&&['room-unavailable','picture-unavailable','picture-stalled'].includes(S.failure)){clearProblem();render();}
    if(!snap?.config){if(!completed){const elapsed=Date.now()-S.started;if(snap?.network?.phase==='failed'&&!knownSourceWait)fail('room-unavailable');else if(elapsed>90000&&!knownSourceWait&&S.failure!=='browser-feature')fail('picture-unavailable');else if(elapsed>15000&&!knownSourceWait&&!S.failure)fail('connection-slow');else if(S.failure||knownSourceWait)render();}return;}
    if(snap.role!=='viewer')return;
    const connected=snap.peers?.some(p=>p.ready&&p.state==='connected');if(connected&&!S.connectedAt)S.connectedAt=Date.now();
    const intentionalAdaptiveWait=connected&&snap.clockReady===true&&snap.sourceReachable===true&&['starting','rebuffering','recovering'].includes(snap.playbackAdaptivePhase);
    if(intentionalAdaptiveWait&&['picture-stalled','picture-unavailable','connection-slow'].includes(S.failure)){clearProblem();render();}
    if(!snap.clockReady&&!completed&&!knownSourceWait){if(Date.now()-S.started>90000)fail('picture-unavailable');else if(Date.now()-S.started>15000&&!S.failure)fail('connection-slow');}
    if(S.failure==='chat-unavailable'&&window.SameEndSocial?.snapshot().connected)clearProblem();
    if(connected&&snap.sourceReachable===true&&snap.clockReady===true&&snap.commonStart?.enabled===true&&(snap.commonStart.state==='pending'||snap.commonStart.startRemainingSeconds>0)){S.phase='waiting-for-group';mark('group-wait-start');if(!['chat-unavailable','browser-feature','video-decode','invitation-incomplete','app-error'].includes(S.failure))clearProblem();render();return;}
    const commonDelay=window.SameEndRoomStatus?.groupDelay?.(snap)?.seconds??snap.config.delay;
    const viewerDelay=Number.isFinite(snap.initialDelay?.selectedDelaySeconds)?snap.initialDelay.selectedDelaySeconds:commonDelay;
    const target=snap.clockReady?(Number.isFinite(snap.effectiveTargetProgramTime)?snap.effectiveTargetProgramTime:(Date.now()+snap.offset-snap.config.epoch)/1000-viewerDelay):null;
    const v=$('player');if(target!==null&&target<0&&connected){S.phase='waiting-for-group';mark('group-wait-start');if(!['chat-unavailable','browser-feature','video-decode','invitation-incomplete','app-error'].includes(S.failure))clearProblem();render();return;}
    if(target!==null&&target>=0&&S.startup?.groupWaitStartedMs!==undefined)mark('group-wait-end');
    if(target!==null&&target>=0&&snap.playbackBlocked&&document.visibilityState==='visible'){if(S.failure!=='playback-blocked')fail('playback-blocked');return;}
    if(v&&v.readyState>=2&&!v.paused){const t=v.currentTime;if(S.lastTime!==null&&Math.abs(t-S.lastTime)>.02){mark('first-picture');S.picture=true;S.hasPicture=true;S.lastAdvance=Date.now();S.phase='playing';completed=true;if(S.failure!=='chat-unavailable')clearProblem();render();if(panel&&!S.failure&&!helpOpen)panel.hidden=true;}S.lastTime=t;}
    if(target!==null&&target>=0&&Date.now()-Math.max(S.connectedAt||S.started,S.lastAdvance,Number.isFinite(snap.config.epoch)?snap.config.epoch+viewerDelay*1000-(snap.offset||0):0)>25000&&!joinedSourceWait&&!intentionalAdaptiveWait&&!S.failure&&document.visibilityState==='visible')fail(S.hasPicture?'picture-stalled':'picture-unavailable');
    if(S.failure)render();
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
  function stop(){clearInterval(timer);timer=null;probeCancel?.();S.active=false;helpOpen=false;closeDialog();if(panel)panel.hidden=true;}
  window.SameEndInviteCheck={start,phase,mark,fail,report,cleanReport,stop};
  if($('room-check-help'))$('room-check-help').onclick=()=>{if(!S.active)start('screen');showHelp(true);render();panel?.scrollIntoView({block:'center',behavior:'smooth'});};
  window.addEventListener('error',()=>{if(S.active)fail('app-error');});
  window.addEventListener('unhandledrejection',()=>{if(S.active)fail('app-error');});
  window.addEventListener('beforeunload',()=>{clearInterval(timer);probeCancel?.();});
  // Record only launch intent; the actual values are consumed by existing joins.
  function launchIntent(){const q=new URLSearchParams(location.hash.slice(1));if(q.has('join'))start('screen');else if(q.has('club')||q.has('openclub'))start('club');}
  window.addEventListener('hashchange',launchIntent);launchIntent();
})();
