/* Optional introduction while waiting. Its audio is separate from match playback. */
(function(){
  'use strict';
  var core=window.SameEndWaitingCore,player=document.getElementById('player'),stage=player&&player.closest('.stage');
  if(!core||!stage)return;
  var fallback={id:'evergreen-press',type:'story',title:'Why does a team press high?',body:'To win the ball closer to the opposition goal. The trade-off is the space left behind the defenders.'};
  var root=document.createElement('section');root.className='sameend-wait';root.id='sameend-wait';root.hidden=true;root.setAttribute('aria-label','While you wait');
  root.innerHTML='<div class="wait-heading"><div class="wait-tag">While you wait</div><h3 id="wait-title"></h3><p class="wait-detail" id="wait-detail" role="status" aria-live="polite"></p></div>'+
    '<article class="wait-guide" id="wait-guide"><svg class="wait-graphic" viewBox="0 0 440 104" role="img" aria-label="Share a tab, invite your mates, watch together"><g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="30" y="12" width="66" height="44" rx="6"/><path d="M30 23h66M53 65h21M63 56v9M121 36h40m-9-7 9 7-9 7"/><circle cx="212" cy="25" r="11"/><path d="M190 61v-9c0-16 44-16 44 0v9M238 25h20m-10-10v20M276 36h40m-9-7 9 7-9 7"/><rect x="342" y="12" width="66" height="44" rx="6"/><path d="m368 24 17 10-17 10zM353 65h44"/></g><g fill="currentColor" font-family="system-ui,sans-serif" font-size="13" font-weight="650" text-anchor="middle"><text x="63" y="91">Share a tab</text><text x="219" y="91">Invite mates</text><text x="375" y="91">Watch together</text></g></svg>'+
    '<div class="wait-guide-copy"><div class="wait-tag">A quick hello from Same End</div><h4>Your mates. The same moment.</h4><p>How to share, join and settle in while your picture gets ready.</p></div><div class="wait-audio-row"><button type="button" id="wait-listen" aria-pressed="false">Play quick guide</button><span id="wait-audio-status" role="status">About 25 seconds · plays only when you choose.</span></div><audio id="wait-intro-audio" preload="none" aria-label="Same End audio introduction"></audio><progress id="wait-audio-progress" value="0" max="1" aria-label="Audio introduction progress" hidden></progress><details class="wait-transcript"><summary>Read the introduction</summary><p>Welcome to Same End. Share the moment with your mates. The host shares a browser tab with its sound, then sends a private room invitation. Your mates open the link and join. Same End uses a playback buffer to help the picture run smoothly. Chat in your private room, or use the fan forum below. Keep this page open. This introduction stops as soon as your picture is ready.</p></details></article>'+
    '<p class="wait-quiet" id="wait-quiet" hidden>The guide is hidden. Your room and chat stay open.</p><details class="wait-reading" id="wait-reading"><summary>Something to read while you wait</summary><article class="wait-story" id="wait-story"></article><button type="button" id="wait-next">Another read</button></details><div class="wait-actions"><button type="button" id="wait-hide">Hide guide</button><button type="button" id="wait-feedback">Give feedback</button><button type="button" id="wait-forum">Fan forum ↓</button></div><p class="wait-foot" id="wait-foot">The picture takes priority. This guide stops when it is ready.</p>';
  stage.appendChild(root);
  function $(id){return document.getElementById(id);}
  var intro=$('wait-intro-audio'),introGeneration=0,introPending=false,introEnded=false;
  var pack=null,index=0,hidden=false,hadPicture=false,sponsorShown=false,lastState=null,activeFetch=null,fetchTimer=null,requestGeneration=0,lastFetchAt=0,lastFingerprint='',requests=0,bytes=0,hasFetched=false;
  var base=window.SameEndConfig&&window.SameEndConfig.apiBase||(['localhost','127.0.0.1'].indexOf(location.hostname)>=0?'/api':'');
  function cache(){try{var saved=JSON.parse(localStorage.getItem('sameend.waiting-pack.v1')||'null');if(saved&&Date.now()-saved.savedAt<60000)pack=core.cleanPack(saved.pack);}catch(_){}}
  cache();
  function cancel(){requestGeneration++;clearTimeout(fetchTimer);fetchTimer=null;if(activeFetch)activeFetch.abort();activeFetch=null;}
  function stopIntro(release){
    introGeneration++;introPending=false;intro.pause();
    if(release&&intro.hasAttribute('src')){intro.removeAttribute('src');intro.load();}
    $('wait-listen').textContent=introEnded?'Replay quick guide':'Play quick guide';$('wait-listen').setAttribute('aria-pressed','false');
    $('wait-audio-status').textContent='About 25 seconds · plays only when you choose.';
    if(release){$('wait-audio-progress').value=0;$('wait-audio-progress').hidden=true;introEnded=false;}
  }
  $('wait-listen').onclick=async function(){
    if(!lastState||!lastState.visible||document.hidden||hidden)return;
    if(introPending||!intro.paused){stopIntro(false);return;}
    var generation=++introGeneration;introPending=true;introEnded=false;
    $('wait-listen').textContent='Cancel audio';$('wait-listen').setAttribute('aria-pressed','true');$('wait-audio-status').textContent='Loading the short audio guide…';
    if(!intro.hasAttribute('src'))intro.src=new URL('./same-end-intro.m4a',document.baseURI).href;
    try{await intro.play();if(generation!==introGeneration||!lastState.visible||document.hidden||hidden)return;
      introPending=false;$('wait-listen').textContent='Pause quick guide';$('wait-audio-status').textContent='Playing the Same End introduction.';$('wait-audio-progress').hidden=false;
    }catch(_){if(generation!==introGeneration)return;stopIntro(true);$('wait-audio-status').textContent='Audio is unavailable. You can read the introduction below.';}
  };
  intro.addEventListener('timeupdate',function(){if(Number.isFinite(intro.duration)&&intro.duration>0)$('wait-audio-progress').value=intro.currentTime/intro.duration;});
  intro.addEventListener('ended',function(){introEnded=true;stopIntro(false);$('wait-audio-status').textContent='You’re all set. Your picture will appear here when it is ready.';});
  window.addEventListener('pagehide',function(){stopIntro(true);cancel();});
  async function load(){
    if(!base||activeFetch||document.hidden||hasFetched||Date.now()-lastFetchAt<60000)return;
    hasFetched=true;lastFetchAt=Date.now();var generation=++requestGeneration,controller=new AbortController();activeFetch=controller;requests++;
    fetchTimer=setTimeout(function(){controller.abort();},6000);
    try{
      var response=await fetch(base+'/v1/community/content',{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
      if(!response.ok)throw Error('Content unavailable');
      var size=Number(response.headers.get('content-length'));if(Number.isFinite(size)&&size>core.maxBytes)throw Error('Content too large');
      var raw;
      if(response.body&&response.body.getReader){
        var reader=response.body.getReader(),chunks=[],length=0;
        while(true){var part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>core.maxBytes){controller.abort();throw Error('Content too large');}chunks.push(part.value);}
        var all=new Uint8Array(length),at=0;chunks.forEach(function(c){all.set(c,at);at+=c.length;});raw=new TextDecoder().decode(all);bytes+=length;
      }else{raw=await response.text();var actual=new TextEncoder().encode(raw).byteLength;if(actual>core.maxBytes)throw Error('Content too large');bytes+=actual;}
      var clean=core.cleanPack(JSON.parse(raw));if(!clean)throw Error('Invalid content');
      if(generation!==requestGeneration||!lastState||!lastState.visible)return;
      pack=clean;try{localStorage.setItem('sameend.waiting-pack.v1',JSON.stringify({savedAt:Date.now(),pack:clean}));}catch(_){}
      lastFingerprint='';renderStory(lastState);
    }catch(_){/* The local evergreen pack remains useful with no server. */}
    finally{clearTimeout(fetchTimer);fetchTimer=null;if(activeFetch===controller)activeFetch=null;}
  }
  function eligible(state){var now=Date.now(),items=pack&&pack.items||[];return items.filter(function(item){return (!item.endsAt||item.endsAt>now)&&(item.type!=='ad'||state.allowSponsor&&!hadPicture&&!sponsorShown);});}
  function line(tag,value,parent){var e=document.createElement(tag);e.textContent=value;parent.appendChild(e);return e;}
  function renderStory(state,force){
    var article=$('wait-story');article.hidden=hidden;$('wait-guide').hidden=hidden;$('wait-reading').hidden=hidden;$('wait-quiet').hidden=!hidden;$('wait-hide').textContent=hidden?'Show guide':'Hide guide';$('wait-next').hidden=hidden;
    if(hidden)return;
    var items=eligible(state),chosen=items.length?items[index%items.length]:fallback;
    // Never repeat an advertisement after a fault/reconnect or spend an extra
    // wait on it. A single displayed sponsor may stay until dismissed/readiness.
    if(!force&&article.dataset.type==='ad'&&state.allowSponsor&&!hadPicture&&article.dataset.endsAt&&Number(article.dataset.endsAt)>Date.now())return;
    var fingerprint=chosen.id+'|'+(pack&&pack.revision||'local')+'|'+state.state;
    if(fingerprint===lastFingerprint&&!force)return;lastFingerprint=fingerprint;article.replaceChildren();article.dataset.type=chosen.type;article.dataset.endsAt=String(chosen.endsAt||Date.now()+60000);
    var label=line('div',chosen.type==='ad'?'Ad · '+chosen.sponsor:chosen.type==='quiz'?'Football quiz':'Football in a minute',article);label.className='wait-tag';
    line('h4',chosen.title,article);line('p',chosen.body,article);
    if(chosen.type==='quiz'){
      if(chosen.question&&chosen.question!==chosen.title)line('p',chosen.question,article);
      var answers=document.createElement('div');answers.className='wait-quiz';article.appendChild(answers);var result=line('small','Choose an answer.',article);result.setAttribute('role','status');
      chosen.choices.forEach(function(choice,n){var button=line('button',choice,answers);button.type='button';button.setAttribute('aria-pressed','false');button.onclick=function(){Array.from(answers.children).forEach(function(b){b.setAttribute('aria-pressed','false');});button.setAttribute('aria-pressed','true');result.textContent=(n===chosen.answerIndex?'That’s right. ':'The answer is '+chosen.choices[chosen.answerIndex]+'. ')+(chosen.explanation||'');};});
    }
    if(chosen.type==='ad'){sponsorShown=true;if(chosen.url){var a=line('a','Visit sponsor',article);a.href=chosen.url;a.target='_blank';a.rel='noopener noreferrer';}}
    $('wait-foot').textContent='The picture takes priority. This guide stops when it is ready.';
  }
  function update(){
    var snapshot=window.PrivateCast&&window.PrivateCast.snapshot?window.PrivateCast.snapshot():{},room=window.SameEndSocial&&window.SameEndSocial.snapshot?window.SameEndSocial.snapshot():{},classification=window.SameEndRoomStatus&&window.SameEndRoomStatus.explain?window.SameEndRoomStatus.explain({snapshot:snapshot,room:room,online:navigator.onLine}):null;
    if(!snapshot.config&&!snapshot.joiningBusy&&!room.connected&&!room.watching)hadPicture=false;
    var state=core.explain(snapshot,room,classification,{hasPlayed:hadPicture});lastState=state;
    if(state.ready)hadPicture=true;
    root.hidden=!state.visible;stage.classList.toggle('has-wait-content',state.visible);
    if(!state.visible||document.hidden){cancel();if(intro.hasAttribute('src')||introPending)stopIntro(true);return;}
    if($('wait-title').textContent!==state.title)$('wait-title').textContent=state.title;
    if($('wait-detail').textContent!==state.detail)$('wait-detail').textContent=state.detail;
    renderStory(state);if(state.canFetch&&!hidden&&$('wait-reading').open)void load();
  }
  $('wait-next').onclick=function(){index++;lastFingerprint='';renderStory(lastState,true);};
  $('wait-hide').onclick=function(){hidden=!hidden;if(hidden){cancel();stopIntro(true);}lastFingerprint='';renderStory(lastState,true);};
  $('wait-reading').addEventListener('toggle',function(){if(this.open&&lastState&&lastState.visible&&!hidden)void load();});
  $('wait-feedback').onclick=function(){if(window.SameEndCommunity)window.SameEndCommunity.feedback();};
  $('wait-forum').onclick=function(){if(window.SameEndCommunity)window.SameEndCommunity.open();};
  window.addEventListener('sameend:castchange',update);document.addEventListener('visibilitychange',update);
  ['loadeddata','canplay','playing','waiting','emptied','pause'].forEach(function(event){player.addEventListener(event,update);});
  setInterval(update,1000);update();
  window.SameEndWaiting={refresh:update,snapshot:function(){return {visible:!root.hidden,state:lastState&&lastState.state||'idle',networkRequests:requests,receivedBytes:bytes,sponsorShown:sponsorShown,introPlaying:!intro.paused,introRequested:intro.hasAttribute('src')};}};
})();
