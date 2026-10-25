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
    var adaptive=typeof s.playbackAdaptivePhase==='string';
    var ready=!!(cfg&&s.clockReady&&hasTarget&&target>=0&&s.ready>=2&&positionGood&&(!adaptive||s.playbackAdaptivePhase==='playing')&&((delivery&&delivery.requiredPiecePresent===true)||(adaptive&&s.paused===false)));
    var engaged=!!(cfg||s.joiningBusy||r.connected||r.watching);
    if(!engaged||ready)return {visible:false,ready:ready,state:ready?'ready':'idle'};
    var code=classification&&classification.code||'finding-route';
    // The initial waiting content is not a recovery overlay. After a picture
    // has appeared, leave it visible during local buffer/clock rebuilding.
    // Source/network failure explanations still use their existing path.
    if(session&&session.hasPlayed===true&&(s.sourceReachable===true||code==='warming-up'||code==='buffering'))return {visible:false,ready:false,state:'resuming'};
    var title=classification&&classification.title||'Finding your shared picture';
    var detail=classification&&classification.detail||'Your room stays open while we find the picture.';
    var seconds=null;
    if(cfg&&s.commonStart&&s.commonStart.enabled===true&&s.commonStart.state==='pending'){
      code='warming-up';title='Checking group delay';detail='You can chat while we prepare the picture.';
    }else if(cfg&&s.clockReady&&hasTarget&&target<0&&code!=='source-stopped'&&code!=='source-unreachable'){
      code='warming-up';title='Building your match buffer';seconds=Math.ceil(-target);
      detail='Group start in '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+'. We’ll show the picture as soon as it’s ready.';
    }else if(cfg&&s.sourceReachable&&hasTarget&&target>=0&&code==='finding-route'){
      title='Preparing the picture';detail='Waiting for verified picture at the group’s current moment. Your chat stays open.';
    }
    return {visible:true,ready:false,state:code,title:title,detail:detail,seconds:seconds,allowSponsor:code==='warming-up'&&seconds>0,canFetch:!!cfg&&s.sourceReachable===true};
  }
  root.SameEndWaitingCore={cleanPack:cleanPack,explain:explain,maxBytes:MAX_BYTES};
})(typeof window==='undefined'?globalThis:window);
