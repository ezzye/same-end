/* Pure waiting-screen decisions. No room secrets, media requests or playback writes. */
(function(root){
  'use strict';
  var MAX_BYTES=50000, TYPES=['story','quiz','ad'];
  function text(value,max){return typeof value==='string'&&value.trim().length<=max?value.trim():'';}
  function safeURL(value){if(!value)return '';try{var u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&u.href.length<=500?u.href:'';}catch(_){return '';}}
  function cleanPack(input,at){
    at=Number.isFinite(at)?at:Date.now();
    if(!input||!Array.isArray(input.items)||input.items.length>30)return null;
    try{if(new TextEncoder().encode(JSON.stringify(input)).byteLength>MAX_BYTES)return null;}catch(_){return null;}
    var items=[];
    input.items.forEach(function(item){
      if(!item||TYPES.indexOf(item.type)<0)return;
      var title=text(item.title,120),body=text(item.body,4000),id=text(item.id,80);
      if(!id||!title||!body||/[#&](?:club|owner|join)=|magnet:\?/i.test(title+' '+body))return;
      if(Number.isFinite(item.startsAt)&&item.startsAt>at||Number.isFinite(item.endsAt)&&item.endsAt<=at)return;
      var clean={id:id,type:item.type,title:title,body:body};
      if(Number.isFinite(item.endsAt))clean.endsAt=item.endsAt;
      if(item.type==='quiz'){
        if(!Array.isArray(item.choices)||item.choices.length<2||item.choices.length>6)return;
        var choices=item.choices.map(function(c){return text(c,160);});
        if(choices.some(function(c){return !c;})||!Number.isInteger(item.answerIndex)||item.answerIndex<0||item.answerIndex>=choices.length)return;
        clean.choices=choices;clean.answerIndex=item.answerIndex;clean.question=text(item.question,240)||title;clean.explanation=text(item.explanation,1000);
      }
      if(item.type==='ad'){clean.sponsor=text(item.sponsor,80);if(!clean.sponsor)return;clean.url=safeURL(item.url);}
      items.push(clean);
    });
    return {revision:text(String(input.revision||'published'),100),items:items};
  }
  function explain(snapshot,room,classification,session){
    var s=snapshot||{},r=room||{},cfg=s.config,target=Number.isFinite(s.effectiveTargetProgramTime)?s.effectiveTargetProgramTime:s.targetProgramTime,hasTarget=Number.isFinite(target),delivery=s.mediaDiagnostics&&s.mediaDiagnostics.delivery;
    var positionGood=Number.isFinite(s.programTime)&&hasTarget&&Math.abs(s.programTime-target)<=4;
    // HAVE_CURRENT_DATA and the correct verified programme interval are the
    // readiness boundary, including a paused picture waiting for a sound tap.
    var adaptive=typeof s.playbackAdaptivePhase==='string', facts=s.mediaDiagnostics&&s.mediaDiagnostics.playback;
    var pictureMissing=!!(facts&&facts.awaitingPicture===true||s.mediaMode==='audio');
    var ready=!!(!pictureMissing&&cfg&&s.clockReady&&hasTarget&&target>=0&&s.ready>=2&&positionGood&&(!adaptive||s.playbackAdaptivePhase==='playing')&&((delivery&&delivery.requiredPiecePresent===true)||(adaptive&&s.paused===false)));
    var engaged=!!(cfg||s.joiningBusy||r.connected||r.watching);
    if(!engaged)return {visible:false,ready:false,state:'idle'};
    var code=classification&&classification.code||'finding-route';
    var title=classification&&classification.title||'Finding your shared picture';
    var detail=classification&&classification.detail||'Your room stays open while we find the picture.';
    var seconds=null,common=s.commonStart;
    var commonPending=!!(cfg&&common&&common.enabled===true&&common.state==='pending');
    var initialPending=!!(s.initialDelay&&s.initialDelay.enabled===true&&['observing','preparing'].indexOf(s.initialDelay.state)>=0);
    var scheduled=cfg&&s.clockReady&&common&&Number.isFinite(common.startRemainingSeconds)&&common.startRemainingSeconds>0?common.startRemainingSeconds:null;
    // Effective playback may already be preparing a positive programme target.
    // A selected common start has its own actual deadline; never replace it with
    // a negative-target estimate or predict an unresolved delay decision.
    var groupTarget=Number.isFinite(s.viewerTargetProgramTime)?s.viewerTargetProgramTime:s.targetProgramTime;
    if(!commonPending&&Number.isFinite(scheduled)&&code!=='source-stopped'&&code!=='source-unreachable'){
      code='warming-up';title='Starting together';seconds=Math.ceil(scheduled);
      detail='Group start in '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+'. Your chat stays open.';
    }else if(commonPending&&code!=='source-stopped'&&code!=='source-unreachable'){
      code='warming-up';title=common.reason==='waiting-for-first-viewer'?'Ready for your mates':'Checking group delay';detail=common.reason==='waiting-for-first-viewer'?'Send your invitation whenever you’re ready. We’ll check the group delay when someone joins.':'You can chat while we prepare the picture.';
    }else if(cfg&&s.clockReady&&!initialPending&&Number.isFinite(groupTarget)&&groupTarget<0&&code!=='source-stopped'&&code!=='source-unreachable'){
      code='warming-up';title='Building your match buffer';seconds=Math.ceil(-groupTarget);
      detail='Group start in '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+'. We’ll show the picture as soon as it’s ready.';
    }else if(ready&&code!=='source-stopped'&&code!=='source-unreachable'){return {visible:false,ready:true,state:'ready'};
    }else if(pictureMissing&&s.sourceReachable&&code!=='source-stopped'&&code!=='source-unreachable'){
      code='buffering';title='Waiting for the picture';detail=cfg&&cfg.sourceAudioAvailable===false?'The room is rebuilding the picture.':'Sound can continue while the room rebuilds the picture.';
    }else if(['starting','rebuffering','recovering'].indexOf(s.playbackAdaptivePhase)>=0&&s.sourceReachable&&code==='playing'){
      code='buffering';title='Building a smoother picture';detail='The room is saving more media before the picture resumes.';
    }else if(cfg&&s.sourceReachable&&hasTarget&&target>=0&&code==='finding-route'){
      title='Preparing the picture';detail='Waiting for verified picture at the group’s current moment. Your chat stays open.';
    }
    // Audio-only playback has no picture to establish the usual compact-mode
    // boundary. Keep the player unobstructed while the video probe recovers.
    var compact=!!(s.mediaMode==='audio'||session&&(session.hasPicture===true||session.hasPlayed===true));
    // A verified media reserve is a measurement, not a download time estimate.
    // Do not show it before the target exists or after the source has stopped.
    var reserve=delivery&&delivery.verifiedReserveSeconds,playback=s.mediaDiagnostics&&s.mediaDiagnostics.playback,goal=playback&&playback.bufferGoalSeconds;
    if(seconds===null&&code!=='source-stopped'&&code!=='source-unreachable'&&cfg&&s.clockReady&&hasTarget&&target>=0&&Number.isFinite(reserve)&&reserve>=0){
      // The reserve follows the policy's selected rendition, which can be
      // video while the renderer is still switching out of audio-only mode.
      var audioReserve=s.renditionPolicy?s.renditionPolicy.mode==='audio':s.mediaMode==='audio';
      detail+=audioReserve?(cfg.sourceAudioAvailable===false?' Playback-clock buffer: ':' Verified audio buffer: '):' Verified media buffer: ';
      detail+=reserve.toFixed(1)+' seconds';
      if(Number.isFinite(goal)&&goal>0)detail+=' (target '+goal.toFixed(1)+' seconds)';
      detail+='.';
    }
    return {visible:true,ready:false,compact:compact,state:code,title:title,detail:detail,seconds:seconds,allowSponsor:!compact&&code==='warming-up'&&seconds>0,canFetch:!compact&&!!cfg&&s.sourceReachable===true};
  }
  root.SameEndWaitingCore={cleanPack:cleanPack,explain:explain,maxBytes:MAX_BYTES};
})(typeof window==='undefined'?globalThis:window);
