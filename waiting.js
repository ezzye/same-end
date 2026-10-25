/* Text-only waiting content. It never changes match capture, playback or sound. */
(function(){
  'use strict';
  var core=window.SameEndWaitingCore,player=document.getElementById('player'),stage=player&&player.closest('.stage');
  if(!core||!stage)return;
  var fallback={id:'evergreen-press',type:'story',title:'Why does a team press high?',body:'To win the ball closer to the opposition goal. The trade-off is the space left behind the defenders.'};
  var root=document.createElement('section');root.className='sameend-wait';root.id='sameend-wait';root.hidden=true;root.setAttribute('aria-label','While you wait');
  root.innerHTML='<div><div class="wait-tag">While you wait · Text only</div><h3 id="wait-title"></h3><p class="wait-detail" id="wait-detail" role="status" aria-live="polite"></p></div><article class="wait-story" id="wait-story"></article><p class="wait-quiet" id="wait-quiet" hidden>Waiting content is hidden. Your room and chat stay open.</p><div class="wait-actions"><button type="button" id="wait-next">Another read</button><button type="button" id="wait-hide">Hide content</button><button type="button" id="wait-feedback">Give feedback</button><button type="button" id="wait-forum">Fans’ corner</button></div><p class="wait-foot" id="wait-foot">No extra audio or video. This screen gives way when the picture is ready.</p>';
  stage.appendChild(root);
  function $(id){return document.getElementById(id);}
  var pack=null,index=0,hidden=false,hadPicture=false,sponsorShown=false,lastState=null,activeFetch=null,fetchTimer=null,requestGeneration=0,lastFetchAt=0,lastFingerprint='',requests=0,bytes=0,hasFetched=false;
  var base=window.SameEndConfig&&window.SameEndConfig.apiBase||(['localhost','127.0.0.1'].indexOf(location.hostname)>=0?'/api':'');
  function cache(){try{var saved=JSON.parse(localStorage.getItem('sameend.waiting-pack.v1')||'null');if(saved&&Date.now()-saved.savedAt<60000)pack=core.cleanPack(saved.pack);}catch(_){}}
  cache();
  function cancel(){requestGeneration++;clearTimeout(fetchTimer);fetchTimer=null;if(activeFetch)activeFetch.abort();activeFetch=null;}
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
    var article=$('wait-story');article.hidden=hidden;$('wait-quiet').hidden=!hidden;$('wait-hide').textContent=hidden?'Show content':'Hide content';$('wait-next').hidden=hidden;
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
    $('wait-foot').textContent=(pack&&items.length?'Published waiting content. ':'Offline football tip. ')+'No extra audio or video. The picture takes priority.';
  }
  function update(){
    var snapshot=window.PrivateCast&&window.PrivateCast.snapshot?window.PrivateCast.snapshot():{},room=window.SameEndSocial&&window.SameEndSocial.snapshot?window.SameEndSocial.snapshot():{},classification=window.SameEndRoomStatus&&window.SameEndRoomStatus.explain?window.SameEndRoomStatus.explain({snapshot:snapshot,room:room,online:navigator.onLine}):null;
    var state=core.explain(snapshot,room,classification);lastState=state;
    if(state.ready)hadPicture=true;
    root.hidden=!state.visible;stage.classList.toggle('has-wait-content',state.visible);
    if(!state.visible||document.hidden){cancel();return;}
    if($('wait-title').textContent!==state.title)$('wait-title').textContent=state.title;
    if($('wait-detail').textContent!==state.detail)$('wait-detail').textContent=state.detail;
    renderStory(state);if(state.canFetch&&!hidden)void load();
  }
  $('wait-next').onclick=function(){index++;lastFingerprint='';renderStory(lastState,true);};
  $('wait-hide').onclick=function(){hidden=!hidden;if(hidden)cancel();lastFingerprint='';renderStory(lastState,true);};
  $('wait-feedback').onclick=function(){if(window.SameEndCommunity)window.SameEndCommunity.feedback();};
  $('wait-forum').onclick=function(){if(window.SameEndCommunity)window.SameEndCommunity.open();};
  window.addEventListener('sameend:castchange',update);document.addEventListener('visibilitychange',update);
  ['loadeddata','canplay','playing','waiting','emptied','pause'].forEach(function(event){player.addEventListener(event,update);});
  setInterval(update,1000);update();
  window.SameEndWaiting={refresh:update,snapshot:function(){return {visible:!root.hidden,state:lastState&&lastState.state||'idle',networkRequests:requests,receivedBytes:bytes,sponsorShown:sponsorShown};}};
})();
