'use strict';
(()=>{
const pristineHTML='<!doctype html>\n'+document.documentElement.outerHTML;
const $=id=>document.getElementById(id), MAX_CLIP=4*1024*1024, MAX_CACHE=192*1024*1024, MAX_QUEUE=10*1024*1024, SLICE=16*1024;
const base=Date.now()-performance.now(), now=()=>base+performance.now();
const state={config:null,commonStart:null,key:null,pub:null,stream:null,recorder:null,active:false,role:null,offset:0,clockReady:false,clockSamples:[],peers:new Map(),cache:[],cacheBytes:0,seq:0,seen:new Set(),source:null,sb:null,player:null,append:[],appending:false,pending:null,pendingOffer:null,out:null,demoCleanup:null,url:null,captureTimer:null,received:0,sent:0,drift:null,lastAppendSeq:-1,stopped:false,sourceChain:Promise.resolve(),recovery:{state:"idle",attempts:0,recoveries:0},stalls:0,playbackStarted:false,waiting:false,sourceReachable:false,sourceEnded:false,invitationConfigId:null,supplier:null,lastReceivedAt:null};
let magnetTransport=null,magnetBusy=false,magnetCleanup=Promise.resolve(),lastJoinLink=null,magnetJoinGeneration=0;
let sourceAudioMonitor=null,sourceAudioState=null,sourceAudioKind=null;
let lastNetworkCheck=null,captureStats=null,captureNormalizer=null,startingCapture=false,hlsCapture=null;
// Delivery receipts confirm verified pieces, not maximum internet speed or playback.
let lastMaintenance=0,relayLimitOverride=null,stallOutgoing=null,stallIncoming=null;
function downstream(){return [...state.peers.values()].filter(p=>p.direction==='down'&&!p.closed);}
function relayLimit(){
 if(relayLimitOverride!==null)return relayLimitOverride;
 const children=downstream();
 const constrained=children.some(p=>p.queued>2*1024*1024||(p.deliveryVersion===1&&p.meter?.snapshot().health==='congested'));
 return constrained?Math.min(2,children.length):2;
}
// Programme clocks stay nominal; only HLS playback may build extra local reserve.
function commonDelaySeconds(){return state.commonStart?.decision?.delaySeconds??state.config?.delay;}
function soloCommonPlayback(){const c=state.commonStart;return state.role==='source'&&c?.version===2&&!c.decision&&!c.transitionPreparing;}
function scheduledCommonStart(){const c=state.commonStart,d=c?.decision;return c?.version===2&&d&&state.clockReady&&now()+state.offset<d.startsAt;}

function nominalProgramTime(){return state.config&&state.clockReady?(now()+state.offset-state.config.epoch)/1000-commonDelaySeconds():null;}
function viewerProgramTime(){
 // Every viewer follows the shared baseline. A prepared later position is
 // ordinary local adaptive lag, bounded to 60 seconds against this clock.
 return nominalProgramTime();
}
function maxPlaybackLag(){return isHlsConfig(state.config)?Math.min(60,Math.max(0,Number.isFinite(window.SameEndHLS?.MAX_EXTRA_DELAY_SECONDS)?SameEndHLS.MAX_EXTRA_DELAY_SECONDS:60)):0;}
function boundedPlaybackLag(value){return typeof value==='number'&&Number.isFinite(value)?Math.min(maxPlaybackLag(),Math.max(0,value)):0;}
function effectiveProgramTime(nominal=viewerProgramTime()){
 if(nominal===null)return null;
 if(state.commonStart&&!state.commonStart.decision&&!soloCommonPlayback())return state.commonStart.preparationTarget??0;
 if(state.initialDelayPolicy?.state==='preparing')return state.initialDelayPolicy.targetProgramTime;
 if(nominal<0||!isHlsConfig(state.config))return nominal;
 const effective=state.player?.getPlaybackTarget?.(nominal);
 return Number.isFinite(effective)?Math.min(nominal,Math.max(nominal-maxPlaybackLag(),effective)):nominal;
}
function playbackTargetMs(){const target=effectiveProgramTime();return target===null?null:state.config.epoch+target*1000;}
function retentionCutoff(){return now()+state.offset-(state.config.delay+30+maxPlaybackLag())*1000;}
function playbackStatus(){const facts=state.player?.facts?.()||{};return {playbackExtraDelaySeconds:typeof facts.extraDelaySeconds==='number'&&Number.isFinite(facts.extraDelaySeconds)?Math.max(0,Math.min(86400,facts.extraDelaySeconds)):null,playbackAdaptivePhase:['warmup','starting','playing','rebuffering','suspended','recovering'].includes(facts.adaptivePhase)?facts.adaptivePhase:null};}
function verifiedReserve(){
 if(!state.config||!state.clockReady)return 0;
 return SameEndDelivery.reserveSeconds(state.cache.map(s=>({start:s.meta.start,end:s.meta.start+s.meta.duration})),playbackTargetMs());
}
function mediaDiagnostics(){
 const cfg=state.config,target=playbackTargetMs();
 const required=target===null?null:state.cache.find(s=>target>=s.meta.start&&target<s.meta.start+s.meta.duration);
 // A small recorder timing gap is neither a missing signed piece nor bandwidth evidence.
 const near=target===null?false:state.cache.some(s=>s.meta.start>target&&s.meta.start-target<=100);
 return{capture:state.role==='source'&&captureStats?{...captureStats,pixelNormalization:captureNormalizer?.stats?.status||'unsupported',normalizedFrames:captureNormalizer?.stats?.frames??null,normalizationMeanMs:captureNormalizer?.stats?.meanMs??null,normalizationMaxMs:captureNormalizer?.stats?.maxMs??null,normalizationTargetFrameRate:captureNormalizer?.stats?.targetFrameRate??null,sourceAudio:sourceAudioState?.status||null,lastPieceAgeSeconds:Math.max(0,(now()-captureStats.lastPieceAt)/1000)}:null,
 delivery:{requiredPiecePresent:target===null||!cfg||target<cfg.epoch?null:!!required||near,requiredPieceLeadMs:required?required.meta.start+cfg.delay*1000+(nominalProgramTime()-effectiveProgramTime())*1000-required.verifiedAt:null,verifiedReserveSeconds:verifiedReserve()},playback:state.player?.facts?.()||null};
}
// This client observes only verified incoming media. Estimates never change playback.
function resetClientDelivery(){
 resetCommonStart();
 state.clientDelivery=(state.role==='viewer'||state.commonStart)&&typeof window.SameEndClientDelivery?.Estimator==='function'?new window.SameEndClientDelivery.Estimator(now):null;
 state.clientDeliveryRoute=null;state.clientDeliverySourceEndMs=null;
 state.initialDelayPolicy=typeof window.SameEndInitialDelay?.Policy==='function'?new window.SameEndInitialDelay.Policy({enabled:window.SameEndConfig?.automaticInitialDelay===true&&state.role==='viewer'&&isHlsConfig(state.config)&&state.config.delay>=60,roomDelaySeconds:commonDelaySeconds()}):null;
}
function sampleClientDelivery(){
 const meter=state.clientDelivery;
 if(!meter||!state.config||(state.role!=='viewer'&&!state.commonStart)||state.stopped)return null;
 const route=JSON.stringify([state.supplier?.id||null,state.trail||[],!!state.sourceReachable]);
 if(state.clientDeliveryRoute!==null&&state.clientDeliveryRoute!==route)meter.resetRoute();
 state.clientDeliveryRoute=route;
 const t=now(),facts=state.player?.facts?.()||{},video=typeof $==='function'?$('player'):null,target=effectiveProgramTime();
 let decoderAhead=Number.isFinite(facts.playableAheadSeconds)?Math.max(0,facts.playableAheadSeconds):0;
 if(!Number.isFinite(facts.playableAheadSeconds)&&video?.buffered)for(let i=0;i<video.buffered.length;i++)if(video.currentTime>=video.buffered.start(i)&&video.currentTime<video.buffered.end(i))decoderAhead=video.buffered.end(i)-video.currentTime;
 return meter.sample({nowMs:t,baselineDelaySeconds:commonDelaySeconds(),reserveSeconds:state.clockReady&&target!==null&&target>=0?verifiedReserve():null,decoderAheadSeconds:decoderAhead,extraDelaySeconds:Number.isFinite(facts.extraDelaySeconds)?Math.max(0,facts.extraDelaySeconds):0,visible:typeof document==='undefined'||document.visibilityState!=='hidden',online:typeof navigator==='undefined'||navigator.onLine!==false,clockReady:state.clockReady,sourceReachable:state.sourceReachable,playing:!!state.playbackStarted&&!state.waiting&&!video?.paused,sourceAgeSeconds:state.clockReady&&Number.isFinite(state.clientDeliverySourceEndMs)?Math.max(0,(t+state.offset-state.clientDeliverySourceEndMs)/1000):null});
}
function clientDeliverySnapshot(){return state.config&&!state.stopped&&(state.role==='viewer'||state.commonStart)?state.clientDelivery?.snapshot(now())||null:null;}
function initialDelaySnapshot(){return state.config&&!state.stopped?state.initialDelayPolicy?.snapshot(state.clockReady?now()+state.offset:null,state.config.epoch,state.player?.programTime?.()??null)||null:null;}
function resetCommonStart(){
 const c=state.config;
 state.commonStart=[1,2].includes(c?.commonStartVersion)&&c.delay===300&&isHlsConfig(c)&&window.SameEndCommonStart?{
  version:c.commonStartVersion,decision:null,decisionId:null,policy:state.role==='source'?new window.SameEndCommonStart.Policy({epoch:c.epoch,version:c.commonStartVersion}):null,
  signing:false,lastHelloAt:0,verifyChain:Promise.resolve(),conflict:false
 }:null;
}
function commonStartSnapshot(){const c=state.commonStart;if(!c||!state.config||state.stopped)return null;const d=c.decision;return{enabled:true,state:d?(d.delaySeconds<state.config.delay?'selected':'fallback'):'pending',delaySeconds:d?.delaySeconds??null,reserveSeconds:d?.reserveSeconds??null,decisionId:c.decisionId,reason:d?.reason||(c.version===2&&state.role==='source'&&c.policy?.observationStartedAt===null?'waiting-for-first-viewer':c.policy?.reason||'waiting-for-source-decision'),conflict:c.conflict,fallbackDelaySeconds:state.config.delay,...(c.version===2?{version:2,programmeTime:d?.programmeTime??null,startsAt:d?.startsAt??null,observationStartedAt:c.policy?.observationStartedAt??d?.observationStartedAt??null,startRemainingSeconds:d&&state.clockReady?Math.max(0,(d.startsAt-now()-state.offset)/1000):null}:{} )};}
function commonFeedback(){
 const module=window.SameEndCommonStart,rows=new Map(),own=state.nodeId||'source-'+state.config.id,t=now()+state.offset;
 rows.set(own,module.reportFromMeasurement(clientDeliverySnapshot(),t));
 for(const peer of downstream())if(peer.ready&&peer.commonStartVersion===state.commonStart.version){
  const pack=peer.commonReports||[];
  if(!pack.length)rows.set(peer.commonNodeId||peer.id,null);
  for(const row of pack)if(row.id!==own)rows.set(row.id,row.report);
 }
 state.commonStart.feedbackOverflow=rows.size>8;
 return [...rows].slice(0,8).map(([id,report])=>({id,report}));
}
function commonHelloFields(){
 const cs=state.commonStart;if(!cs)return{};
 return{commonStartVersion:cs.version,commonStartNodeId:state.nodeId||'source-'+state.config.id,
  commonStartFeedback:commonFeedback(),commonStartUnsupported:cs.feedbackOverflow||downstream().some(p=>p.ready&&(p.commonStartVersion!==cs.version||p.commonOverflow||p.commonUnsupported)),
  ...(cs.decision?{commonStartDecision:cs.decision}:{})};
}
function broadcastCommonHello(){for(const p of state.peers.values())if(p.ready&&!p.closed)send(p,{type:'hello',label:label(),cast:state.config.id,deliveryVersion:1,playbackLagSeconds:p.direction==='up'?boundedPlaybackLag((nominalProgramTime()??0)-(effectiveProgramTime()??0)):undefined});}
function adoptCommonDecision(cs,decision,decisionId){
 if(state.commonStart!==cs||cs.decision)return false;
 cs.decision=decision;cs.decisionId=decisionId;
 // Pending v2 viewers receive fresh measurement media, not five minutes of backlog.
 // Once the clock is signed, replay its actual retained starting range.
 if(cs.version===2)for(const peer of downstream())if(peer.ready&&peer.commonStartVersion===2){peer.lastSentSeq=-1;peer.replayPending=false;}
 if(state.player?.startupPreparation){
  if(state.role==='source'&&decision.delaySeconds<state.config.delay){
   if(!state.player.commitStartup(cs.preparationTarget,decision.reserveSeconds))discardPreparedPlayer();
  }else discardPreparedPlayer();
 }
 const enable=state.role==='viewer'&&window.SameEndConfig?.automaticInitialDelay===true;
 state.initialDelayPolicy=new window.SameEndInitialDelay.Policy({enabled:enable,roomDelaySeconds:decision.delaySeconds});
 state.player.startupHold=enable;
 cs.joinCheckPending=enable;
 prepareLateCommonJoin(cs);
 broadcastCommonHello();lifecycle();return true;
}
function prepareLateCommonJoin(cs){
 if(!cs.joinCheckPending||!state.clockReady||state.commonStart!==cs||scheduledCommonStart())return;
 const sourceNow=now()+state.offset,target=(sourceNow-state.config.epoch)/1000-cs.decision.delaySeconds;
 if(target<0){if(sourceNow-cs.decision.issuedAt<=20000)cs.joinCheckPending=false;return;}
 if(!state.cache.length||target<(state.cache[0].meta.start-state.config.epoch)/1000)return;
 cs.joinCheckPending=false;
 // Catch-up is not a bandwidth measurement. The source has already selected
 // this timeline; only verified cache and aligned decoder headroom release it.
 discardPreparedPlayer();state.player.startupHold=true;
 state.initialDelayPolicy.prepareCommonJoin({sourceNowMs:sourceNow,nowMs:now(),epoch:state.config.epoch,reserveSeconds:cs.decision.reserveSeconds,targetProgramTime:target});
 if(state.initialDelayPolicy.state==='preparing')state.player.prepareStartup(target,cs.decision.reserveSeconds);
}
async function handleCommonHello(p,m){
 const cs=state.commonStart,config=state.config,module=window.SameEndCommonStart;if(!cs)return;
 p.commonStartVersion=m.commonStartVersion===cs.version?cs.version:0;
 p.commonNodeId=typeof m.commonStartNodeId==='string'&&/^[A-Za-z0-9:_-]{1,100}$/.test(m.commonStartNodeId)?m.commonStartNodeId:null;
 if(p.direction==='down'){
  p.commonUnsupported=m.commonStartUnsupported===true;
  const pack=m.commonStartFeedback;
  p.commonOverflow=Array.isArray(pack)&&pack.length>8;
  p.commonReports=Array.isArray(pack)&&pack.length<=8?pack.filter(row=>row&&typeof row.id==='string'&&/^[A-Za-z0-9:_-]{1,100}$/.test(row.id)).map(row=>({id:row.id,report:module.validReport(row.report,now()+state.offset)?row.report:null})):[];
 }
 const decision=m.commonStartDecision;
 if(p.direction!=='up'||!decision||!module.validateDecision(decision,config))return;
 const canonical=module.canonicalDecision(decision);
 if(cs.decision&&module.canonicalDecision(cs.decision)===canonical)return;
 if(p.commonVerifyAt&&now()-p.commonVerifyAt<500)return;p.commonVerifyAt=now();
 cs.verifyChain=cs.verifyChain.catch(()=>{}).then(async()=>{
  if(state.commonStart!==cs||state.config!==config||p.closed||state.peers.get(p.id)!==p)return;
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},state.pub,un64(decision.sig),enc.encode(canonical)))throw Error('Unverified shared starting time.');
  if(state.commonStart!==cs||state.config!==config||p.closed||state.peers.get(p.id)!==p)return;
  if(cs.decision){if(module.canonicalDecision(cs.decision)!==canonical){cs.conflict=true;throw Error('Conflicting shared starting time.');}return;}
  if(state.playbackStarted||state.player?.adaptive?.everPlayed){cs.conflict=true;return;}
  const id=await hash(enc.encode(canonical));
  if(state.commonStart===cs&&state.config===config&&!p.closed&&state.peers.get(p.id)===p)adoptCommonDecision(cs,Object.freeze({...decision}),id);
 });
 await cs.verifyChain;
}
function advanceCommonStart(){
 const cs=state.commonStart;if(!cs)return;
 const t=now(),module=window.SameEndCommonStart;
 if(t-cs.lastHelloAt>=2000){cs.lastHelloAt=t;broadcastCommonHello();}
 if(cs.decision){prepareLateCommonJoin(cs);return;}
 if(state.role!=='source'||cs.signing)return;
 if(cs.version===2){advanceLateCommonStart(cs,t,module);return;}
 const own=module.reportFromMeasurement(sampleClientDelivery(),t),children=downstream().filter(p=>p.ready),rows=commonFeedback().filter(r=>r.id!==(state.nodeId||'source-'+state.config.id));
 let reserve=own?.eligible?own.reserveSeconds:6;for(const row of rows)if(row.report?.eligible)reserve=Math.max(reserve,row.report.reserveSeconds);
 let hostReady=false,minimum=4;
 if(cs.preparationTarget==null&&state.cache.length)cs.preparationTarget=Math.max(0,(state.cache[0].meta.start-state.config.epoch)/1000);
 if(reserve<=12&&state.player?.prepareStartup&&Number.isFinite(cs.preparationTarget)){
  state.player.prepareStartup(cs.preparationTarget,reserve);stageWindow();const facts=state.player.prepareStartup(cs.preparationTarget,reserve);
  minimum=facts.minimumReserveSeconds;const goal=Math.max(reserve,minimum);
  hostReady=Number.isFinite(minimum)&&goal<=12&&facts.ready&&facts.aligned&&facts.cacheAheadSeconds>=goal&&facts.decoderAheadSeconds+.08>=goal;
 }
 const proposal=cs.policy.update({sourceNowMs:t,hostReport:own,reports:rows.map(r=>r.report),hasViewers:children.length>0,unsupportedPeer:cs.feedbackOverflow||children.some(p=>p.commonStartVersion!==cs.version||p.commonOverflow||p.commonUnsupported),hostReady,hostMinimumReserveSeconds:minimum});
 if(!proposal)return;
 signCommonDecision(cs,proposal,module);
}
function advanceLateCommonStart(cs,t,module){
 const own=module.reportFromMeasurement(sampleClientDelivery(),t),children=downstream().filter(p=>p.ready),rows=commonFeedback().filter(r=>r.id!==(state.nodeId||'source-'+state.config.id));
 const input={sourceNowMs:t,hostReport:own,reports:rows.map(r=>r.report),hasViewers:children.length>0,unsupportedPeer:cs.feedbackOverflow||children.some(p=>p.commonStartVersion!==cs.version||p.commonOverflow||p.commonUnsupported),hostReady:false,minimumProgrammeTime:Math.max(0,state.cache.length?(state.cache[0].meta.start-state.config.epoch)/1000:0,(t-state.config.epoch)/1000-20)};
 let proposal=cs.policy.update(input);
 const candidate=cs.policy.preview();
 if(!proposal&&candidate){
  if(cs.preparationTarget!==candidate.programmeTime||cs.preparationReserve!==candidate.reserveSeconds){
   cs.transitionPreparing=true;discardPreparedPlayer();state.player.startupHold=true;
   cs.preparationTarget=candidate.programmeTime;cs.preparationReserve=candidate.reserveSeconds;
  }
  state.player.prepareStartup(cs.preparationTarget,candidate.reserveSeconds);stageWindow();
  const facts=state.player.prepareStartup(cs.preparationTarget,candidate.reserveSeconds),minimum=facts.minimumReserveSeconds,goal=Math.max(candidate.reserveSeconds,minimum);
  proposal=cs.policy.update({...input,preparedProgrammeTime:cs.preparationTarget,hostMinimumReserveSeconds:minimum,hostReady:Number.isFinite(minimum)&&goal<=12&&facts.ready&&facts.aligned&&facts.cacheAheadSeconds>=goal&&facts.decoderAheadSeconds+.08>=goal});
 }
 if(proposal)signCommonDecision(cs,proposal,module);
}
function signCommonDecision(cs,proposal,module){
 cs.signing=true;const config=state.config,key=state.key;
 void(async()=>{
  let decision={...proposal,cast:config.id,sourceId:config.sourceId,sourceEpoch:config.sourceEpoch,programId:config.programId};
  decision.sig=b64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,enc.encode(module.canonicalDecision(decision)))));
  if(decision.delaySeconds<config.delay&&now()>decision.startsAt-2000){
   const issuedAt=now(),startsAt=cs.version===2?Math.max(config.epoch+config.delay*1000,issuedAt+4000):config.epoch+config.delay*1000;
   decision={...decision,delaySeconds:config.delay,reserveSeconds:6,issuedAt,startsAt,reason:'observation-timeout',...(cs.version===2?{programmeTime:(startsAt-config.epoch)/1000-config.delay}:{})};
   decision.sig=b64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,enc.encode(module.canonicalDecision(decision)))));
  }
  const id=await hash(enc.encode(module.canonicalDecision(decision)));
  if(state.commonStart===cs&&state.config===config&&!state.stopped)adoptCommonDecision(cs,Object.freeze(decision),id);
 })().catch(()=>{if(state.commonStart===cs)status('Could not agree a shared starting time. Start sharing again.');}).finally(()=>{cs.signing=false;});
}

function discardPreparedPlayer(){
 const soundRequested=state.player?.soundRequested,muted=$('player').muted;
 state.player?.close();state.player=createRoomPlayer($('player'),state.config,roomPlayerCallbacks(state.role));
 state.player.soundRequested=soundRequested;$('player').muted=muted;state.appendedSeq=new Set();state.lastAppendSeq=-1;
}
function advanceInitialDelay(){
 if(state.commonStart&&(!state.commonStart.decision||state.commonStart.joinCheckPending))return;
 const policy=state.initialDelayPolicy;if(!policy||['disabled','committed'].includes(policy.state))return;
 if(policy.state==='fallback'){if(state.player?.startupPreparation)discardPreparedPlayer();if(state.player)state.player.startupHold=false;return;}
 const preparing=policy.state==='preparing',t=now(),measurement=sampleClientDelivery();
 policy.update({nowMs:t,sourceNowMs:state.clockReady?t+state.offset:null,epoch:state.config.epoch,measurement,verifiedProgressAgeSeconds:state.lastReceivedAt==null?null:Math.max(0,(t-state.lastReceivedAt)/1000),everPlayed:state.player?.adaptive?.everPlayed||state.playbackStarted,healthy:state.clockReady&&state.sourceReachable&&(state.role==='source'||!!state.supplier)&&document.visibilityState!=='hidden'&&navigator.onLine!==false});
 if(policy.state==='preparing'){
  if(!state.player?.prepareStartup||!state.player?.commitStartup)policy.fallback('player-preparation-unavailable');
  else{
   state.player.prepareStartup(policy.targetProgramTime,policy.reserveGoalSeconds);stageWindow();
   const facts=state.player.prepareStartup(policy.targetProgramTime,policy.reserveGoalSeconds);
   if(policy.canCommit(facts)&&state.player.commitStartup(policy.targetProgramTime,policy.reserveGoalSeconds))policy.commit(facts,now()+state.offset,now());
  }
 }
 if(policy.state==='fallback'&&(preparing||state.player?.startupPreparation)){
  // A speculative native playlist cannot be rewound to an older room snapshot.
  // Discard only this unplayed decoder; signed relay media and peers survive.
  discardPreparedPlayer();
 }
 if(policy.state==='fallback'&&state.player)state.player.startupHold=false;
}
function deliverySnapshot(){
 const peers=downstream().map(p=>({id:p.nodeId||p.id,receipts:p.deliveryVersion===1,...p.meter?.snapshot(),queuedBytes:p.queued}));
 const measured=peers.filter(p=>p.measured);
 return {relayLimit:relayLimit(),safetyLimit:2,measured:measured.length>0,deliveredMbps:measured.reduce((n,p)=>n+(p.deliveredMbps||0),0),peers};
}
function renderDelivery(){
 const snapshot=deliverySnapshot(),reserve=verifiedReserve(),panel=$('delivery-state');
 if($('stat-delivery'))$('stat-delivery').textContent=snapshot.measured?snapshot.deliveredMbps.toFixed(2)+' Mbps':'Measuring';
 if($('stat-reserve'))$('stat-reserve').textContent=reserve.toFixed(1)+' s';
 if(!panel)return;panel.hidden=!state.config;
 let message='';
 if(state.config&&state.role==='viewer'){
  if(!state.supplier)message='Reconnecting automatically. Your saved picture and the group’s match time are kept.';
  else if(state.supplierHealth&&state.supplierHealth!=='healthy')message='Your supplying connection is being checked. The group’s match time stays the same.';
 }
 if(!message&&snapshot.peers.some(p=>p.health==='congested'||p.queuedBytes>2*1024*1024))message='A receiving connection is slow. New viewers will use another available supplier.';
 if(panel.textContent!==message)panel.textContent=message;
 panel.hidden=!message;
}
function initDeliveryPeer(p){
 p.meter=new SameEndDelivery.Meter(now);p.deliveryVersion=0;p.connectedAt=now();p.lastControlAt=now();p.lastProgressAt=now();p.lastVerifiedAt=now();p.highestSeq=-1;
}
function receipt(p,meta){if(p&&!p.closed&&p.deliveryVersion===1)send(p,{type:'delivery-receipt',cast:state.config.id,seq:meta.seq,hash:meta.hash,size:meta.size});}
function resumeAfter(){
 if(!state.cache.length)return -1;
 const nominal=viewerProgramTime()??(now()+state.offset-state.config.epoch)/1000-state.config.delay;
 const target=state.config.epoch+effectiveProgramTime(nominal)*1000-4000;
 const useful=state.cache.filter(s=>s.meta.start+s.meta.duration>=target);
 if(!useful.length||useful[0].meta.start>target+100)return -1;
 let seq=useful[0].meta.seq;
 for(const s of useful){if(s.meta.seq>seq+1)break;seq=s.meta.seq;}
 return seq;
}
function maintainDelivery(){
 if(!state.config||state.stopped)return;
 const t=now(),gap=lastMaintenance?t-lastMaintenance:0;lastMaintenance=t;
 sampleClientDelivery();
 const parent=[...state.peers.values()].find(p=>p.direction==='up'&&!p.closed&&p.ready);
 if(parent){
  // Browser suspension is not a failed network. Give the resumed page fresh grace.
  if(gap>5000){parent.connectedAt=t;parent.lastProgressAt=t;parent.lastControlAt=t;ping(parent);}
  let reason=SameEndDelivery.assessSupplier({nowMs:t,connectedAt:parent.connectedAt,lastControlAt:parent.lastControlAt,lastProgressAt:parent.lastProgressAt,lastVerifiedAt:parent.lastVerifiedAt,rooted:state.sourceReachable,sourceNowMs:t+state.offset,sampleGapMs:gap}),deferred=false;
  if(state.sourceReachable)parent.pathLostAt=null;
  else if(parent.pathLostAt==null)parent.pathLostAt=t;
  // A shared upstream interruption reaches every hop together. Do not race a
  // responsive parent for its only replacement slot while our cache can cover it.
  if(reason&&reason!=='supplier-unresponsive'&&t-parent.lastControlAt<6000&&verifiedReserve()>20){
   const depth=Math.max(1,state.trail?.length||1);
   const progressGrace=12000+Math.min(12000,(depth-1)*4000);
   const repairing=!state.sourceReachable&&t-parent.pathLostAt<15000;
   if(t-parent.lastProgressAt<progressGrace||repairing){reason=null;deferred=true;}
  }
  state.supplierHealth=deferred?'upstream-recovering':reason||'healthy';
  if(reason&&magnetTransport?.recoverSupplier(reason)){log('Supplying path stopped delivering; finding another route without changing match time.');}
 }
 // Forwarding and repairs must continue even when this device's player is paused.
 stageWindow();renderDelivery();
}
const enc=new TextEncoder(), dec=new TextDecoder();
const log=s=>{$('log').textContent=(new Date().toLocaleTimeString()+' '+s+'\n'+$('log').textContent).slice(0,6000);};
const status=s=>{$('status').textContent=s;log(s);};
function renderSourceAudio(){
 const panel=$('source-audio');if(!panel)return;
 panel.hidden=!(state.config&&state.role==='source'&&!state.stopped);if(panel.hidden)return;
 const health=sourceAudioState||{status:'checking',reason:'none'},kind=health.status;
 const suppressed=state.stream?.getAudioTracks().some(t=>t.getSettings?.().suppressLocalAudioPlayback===true);
 const d=commonDelaySeconds(),minutes=d%60===0,delay=(minutes?d/60:d)+' '+(minutes?'minutes':'seconds');
 let title='Checking source sound',message='Listening for sound in the shared tab.',action=false;
 if(kind==='sound'){title='Source sound detected';message='The shared source is sending sound.';}
 if(kind==='quiet'){title='No sound detected from the source';message='No sound has been detected for 15 seconds. The programme may be quiet. If you expect sound, unmute the original player and turn its volume up. Changes reach the room after the group delay: '+delay+'.';}
 if(kind==='no-track'){title='No tab audio was shared';message='Start a fresh share of a browser tab and include tab audio. Turning on room sound cannot add missing source audio.';}
 if(kind==='unavailable'){
  action=health.reason==='context-suspended';title=action?'Source sound check is paused':'Source sound check unavailable';
  message=action?'Enable the sound check to receive silence warnings. This does not change the shared sound.':health.reason==='track-ended'?'The shared audio track ended. Start a fresh tab share and include audio.':'This browser cannot check the source level. Keep the original player unmuted and check sound with a viewer.';
 }
 panel.dataset.state=kind;
 for(const[id,value]of [['source-audio-title',title],['source-audio-message',message],['source-audio-help',sourceAudioKind==='demo'?'This warm-up sends a test tone. The room sound button changes only this device.':'Keep sound ON in the original player. Use “Mute my sound” here to mute only yourself.'+(suppressed?' The original tab is kept quiet here automatically.':'')]])if($(id).textContent!==value)$(id).textContent=value;
 $('source-audio-check').hidden=!action;
 $('audio-state').textContent=kind==='sound'?'Source sound detected':kind==='quiet'?'Source audio is silent':kind==='no-track'?'No audio track supplied':kind==='unavailable'?'Source sound check unavailable':'Checking captured source sound';
}
function monitorSourceAudio(stream,kind){
 sourceAudioMonitor?.close();sourceAudioState={status:'checking',reason:'none'};sourceAudioKind=kind;
 try{sourceAudioMonitor=new SameEndSourceAudio.Monitor(stream,{onChange:health=>{sourceAudioState=health;renderSourceAudio();}});sourceAudioState=sourceAudioMonitor.start();sourceAudioMonitor.resume();}
 catch{sourceAudioMonitor=null;sourceAudioState={status:'unavailable',reason:'unsupported'};}
 renderSourceAudio();
}

const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');};
const un64=s=>{if(typeof s!=='string'||s.length>100000)throw Error('Connection code is too large.');return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));};
const code=x=>'PRIVATECAST1.'+b64(enc.encode(JSON.stringify(x)));
function parse(text){if(text.length>100000)throw Error('Connection file is too large.');return JSON.parse(text.startsWith('PRIVATECAST1.')?dec.decode(un64(text.trim().slice(13))):text);}
// v1 remains byte-for-byte compatible with existing invitations. v2 binds source
// identity and media programme position; these fields do not prove alignment.
const canonical=m=>JSON.stringify(m.v===2?[2,m.cast,m.sourceId,m.sourceEpoch,m.programId,m.programStartTime,m.alignmentVersion,m.seq,m.start,m.duration,m.size,m.mime,m.hash]:[m.cast,m.seq,m.start,m.duration,m.size,m.mime,m.hash]);
const segmentKey=m=>JSON.stringify([m.cast,m.sourceId||'legacy:'+m.cast,m.sourceEpoch??state.config?.epoch,m.seq]);
const endCanonical=m=>JSON.stringify(['source-end',1,m.cast,m.sourceId,m.sourceEpoch,m.endedAt]);
const lifecycle=()=>{sampleClientDelivery();window.dispatchEvent(new CustomEvent('sameend:castchange',{detail:{active:!!state.config,role:state.role,recovery:state.recovery.state,sourceReachable:state.sourceReachable,sourceEnded:state.sourceEnded}}));};
const hash=async data=>b64(new Uint8Array(await crypto.subtle.digest('SHA-256',data)));
const safe=fn=>async(...args)=>{const btn=args[0]?.currentTarget;if(btn?.tagName==='BUTTON')btn.disabled=true;try{await fn(...args);}catch(e){status(e.message||String(e));log('Action could not complete.');}finally{if(btn?.tagName==='BUTTON')btn.disabled=false;update();}};
function label(){return $('name').value.trim().slice(0,40)||'A friend';}
function update(){if($('alternate-player'))$('alternate-player').hidden=!(state.config&&!state.stopped&&state.role==='viewer'&&state.player?.mode==='mse'&&state.player.nativeMime);const soundPrompt=$('sound-unlock');soundPrompt.hidden=!(state.config?.audio&&state.player&&$('player').readyState>=2&&((!state.player.soundRequested&&$('player').muted)||state.player.soundBlocked));soundPrompt.textContent=state.player?.soundBlocked?'Tap to enable sound':'Tap for sound';$('sound').textContent=state.player?.soundBlocked||state.player?.blocked?'Play my sound':$('player').muted?'Turn my sound on':'Mute my sound';if(!window.SameEndSocial?.prepareRoomInvitation)$('make-magnet').disabled=magnetBusy||state.role!=='source'||!state.active||!!$('magnet-link').value;$('join-magnet-button').disabled=magnetBusy||!!state.config;const live=[...state.peers.values()].filter(p=>p.channel?.readyState==='open');$('invite').disabled=!state.config||!state.clockReady||state.stopped||[...state.peers.values()].filter(p=>p.direction==='down').length>=relayLimit();$('stop').disabled=!state.config&&!magnetBusy;$('demo').disabled=!!state.config||!!window.SameEndShareHelp?.phone;$('capture').disabled=!!state.config||!!window.SameEndShareHelp?.phone;$('delay').disabled=!!state.config;$('quality').disabled=!!state.config;$('stat-delay').textContent=state.config?commonDelaySeconds()+' s':'—';$('stat-cache').textContent=(state.cacheBytes/1e6).toFixed(1)+' MB';$('stat-relay').textContent=live.filter(p=>p.direction==='down').length;$('stat-drift').textContent=state.drift===null?'—':Math.abs(state.drift).toFixed(2)+' s';$('peers').replaceChildren();for(const p of state.peers.values()){const row=document.createElement('div');row.className='peer';const text=document.createElement('span');text.textContent=(p.direction==='up'?'Receiving from ':'Sending to ')+(p.label||'friend')+' · '+(p.channel?.readyState||p.pc.connectionState);const btn=document.createElement('button');btn.className='secondary';btn.textContent='Disconnect';btn.onclick=()=>dropPeer(p,'Connection closed by you.');row.append(text,btn);$('peers').append(row);}}
function ice(){const s=$('stun').value.trim();if(s&&!/^stuns?:[^\s/@]+(?::\d+)?$/.test(s))throw Error('Enter a STUN address such as stun:server.example:3478, or leave it blank.');return {iceServers:s?[{urls:s}]:[]};}
function checkPlatform(capture=false){if(capture&&window.SameEndShareHelp?.phone)throw Error(window.SameEndShareHelp.phoneMessage);if(!window.isSecureContext||!crypto.subtle||!window.RTCPeerConnection||!window.SameEndMedia)throw Error('Open Same End in Safari, Chrome or Edge using its HTTPS address. This browser is missing the secure connection features needed to watch.');if(capture&&!window.MediaRecorder)throw Error('This browser can watch, but cannot share a picture. Start the room from a computer using updated Chrome, Edge or Safari.');}
function isHlsConfig(config){return config?.mime==='application/vnd.apple.mpegurl'&&config.mediaProfile==='hls-cmaf-v1';}
function canPlayConfig(config){if(config?.mime==='application/vnd.apple.mpegurl')return isHlsConfig(config)&&!!window.SameEndHLS&&(SameEndHLS.canPlay()||SameEndHLS.canPlayNative());return !config?.mediaProfile&&SameEndMedia.canPlay(config?.mime);}
function createRoomPlayer(video,config,callbacks){if(isHlsConfig(config)){const C=SameEndHLS.canPlay()?SameEndHLS.HlsPlayer:SameEndHLS.NativePlayer;return new C(video,config,callbacks);}return new SameEndMedia.Player(video,config.mime,callbacks);}
function roomPlayerCallbacks(role){return{onError:message=>{status(message);if(state.initialDelayPolicy?.state==='preparing')state.initialDelayPolicy.fallback('decoder-preparation-error');else if(role==='viewer')window.SameEndInviteCheck?.fail('video-decode');},onMode:(mode,message)=>{if(message)log(message);}};}
async function init(config,role){checkPlatform();if(!canPlayConfig(config))throw Error('This browser cannot play this room. Update Safari, Chrome or Edge and reopen the invitation.');if(config.segmentVersion!==undefined&&config.segmentVersion!==2)throw Error('Unsupported cast media version.');if(config.segmentVersion===2&&(typeof config.sourceId!=='string'||!config.sourceId||config.sourceId.length>100||!Number.isSafeInteger(config.sourceEpoch)||config.sourceEpoch<0||typeof config.programId!=='string'||!config.programId||config.programId.length>100||config.alignmentVersion!==1))throw Error('Invalid source-bound cast identity.');if(state.config&&state.config.id!==config.id)throw Error('Leave the current cast before joining another.');state.invitationConfigId=null;state.config=config;state.role=role;resetClientDelivery();state.stopped=false;state.sourceEnded=false;state.stalls=0;state.playbackStarted=false;state.waiting=false;state.supplierHealth='healthy';state.appendedSeq=new Set();lastMaintenance=0;state.recovery={state:"idle",attempts:0,recoveries:0};state.pub=await crypto.subtle.importKey('jwk',config.publicKey,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);const fingerprint=(await hash(enc.encode(JSON.stringify(config.publicKey)))).slice(0,16);$('identity').textContent='Cast fingerprint: '+fingerprint+' · compare this privately if needed.';$('audio-state').textContent=config.audio?'Audio track included · player starts muted':'No audio track supplied';state.player=createRoomPlayer($('player'),config,roomPlayerCallbacks(role));state.player.startupHold=!!state.commonStart&&!soloCommonPlayback()||state.initialDelayPolicy?.enabled===true;lifecycle();update();}
function cleanCache(){const cutoff=retentionCutoff();while(state.cache.length&&(state.cacheBytes>MAX_CACHE||state.cache[0].meta.start+state.cache[0].meta.duration<cutoff)){state.cacheBytes-=state.cache.shift().buf.byteLength;}while(state.seen.size>400)state.seen.delete(state.seen.values().next().value);}
async function acceptSegment(meta,buf,from,receiveStartedAtMs){if(!state.config||state.stopped)return;if(!meta||meta.cast!==state.config.id||!Number.isSafeInteger(meta.seq)||meta.seq<0||!Number.isFinite(meta.start)||meta.start>(now()+state.offset)+45000||!Number.isFinite(meta.duration)||meta.duration<(isHlsConfig(state.config)?1:100)||meta.duration>10000||meta.mime!==state.config.mime||meta.size!==buf.byteLength||buf.byteLength>MAX_CLIP)throw Error('Invalid or out-of-window video piece.');if(meta.start+meta.duration<retentionCutoff())return;if(meta.v!==undefined&&meta.v!==1&&meta.v!==2)throw Error('Unsupported signed media version.');
if(state.config.segmentVersion===2&&meta.v!==2)throw Error('This cast requires source-bound media signatures.');
if(meta.v===2&&(state.config.segmentVersion!==2||typeof meta.sourceId!=='string'||!meta.sourceId||!Number.isSafeInteger(meta.sourceEpoch)||meta.sourceEpoch<0||typeof meta.programId!=='string'||!meta.programId||meta.sourceId!==state.config.sourceId||meta.sourceEpoch!==state.config.sourceEpoch||meta.programId!==state.config.programId||meta.alignmentVersion!==1||!Number.isFinite(meta.programStartTime)||Math.abs(meta.programStartTime-(meta.start-state.config.epoch))>1))throw Error('Video piece has an unauthorised source or programme timeline.');
const identity=segmentKey(meta);if(state.seen.has(identity))return;if(await hash(buf)!==meta.hash||!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},state.pub,un64(meta.sig),enc.encode(canonical(meta))))throw Error('Video piece failed its source signature.');if(!state.config||state.stopped||state.config.id!==meta.cast||state.seen.has(identity))return;if(isHlsConfig(state.config)){const bundle=SameEndHLS.decodeBundle(buf);if(Math.abs(bundle.start*1000-meta.programStartTime)>1||Math.abs(bundle.duration*1000-meta.duration)>1)throw Error('HLS files do not match the signed programme interval.');}state.seen.add(identity);
 const verifiedAtMs=now();
 if(state.role==='source'&&state.commonStart){sampleClientDelivery();state.clientDelivery?.observe({seq:meta.seq,size:buf.byteLength,durationMs:meta.duration,programStartMs:meta.start,receiveStartedAtMs:verifiedAtMs-1,verifiedAtMs,sourceNowMs:verifiedAtMs});state.clientDeliverySourceEndMs=Math.max(state.clientDeliverySourceEndMs??-Infinity,meta.start+meta.duration);}
 if(state.role==='viewer'&&from?.direction==='up'&&!from.closed&&state.peers.get(from.id)===from&&state.supplier?.id===(from.nodeId||from.id)&&Number.isFinite(receiveStartedAtMs)&&receiveStartedAtMs<=verifiedAtMs){
  sampleClientDelivery();
  state.clientDelivery?.observe({seq:meta.seq,size:buf.byteLength,durationMs:meta.duration,programStartMs:meta.start,receiveStartedAtMs,verifiedAtMs,sourceNowMs:state.clockReady?verifiedAtMs+state.offset:null});
  state.clientDeliverySourceEndMs=Math.max(state.clientDeliverySourceEndMs??-Infinity,meta.start+meta.duration);
 }
 state.received++;if(from)window.SameEndInviteCheck?.mark?.('first-media');state.lastReceivedAt=now();const segment={meta,buf,verifiedAt:now()+state.offset};state.cache.push(segment);state.cache.sort((a,b)=>a.meta.seq-b.meta.seq);if(from){from.lastVerifiedAt=now();if(meta.seq>from.highestSeq){from.highestSeq=meta.seq;from.lastProgressAt=now();}receipt(from,meta);}state.cacheBytes+=buf.byteLength;cleanCache();stageWindow();update();}
async function waitBuffer(p){const until=performance.now()+7000;while(p.channel?.readyState==='open'&&p.channel.bufferedAmount>256*1024){if(performance.now()>until)throw Error('This connection is too slow for the selected picture quality.');await new Promise(r=>setTimeout(r,15));}if(p.channel?.readyState!=='open')throw Error('Connection closed.');}
function enqueue(p,segment){if(p.closed||!p.ready)return;if(p.queued+segment.buf.byteLength>MAX_QUEUE){dropPeer(p,'A slow outgoing connection was closed to keep memory bounded.');return;}p.queued+=segment.buf.byteLength;p.chain=p.chain.then(async()=>{if(p.closed)return;await waitBuffer(p);if(p.deliveryVersion===1)p.meter.sent(segment.meta);p.channel.send(JSON.stringify({type:'segment',meta:segment.meta}));for(let i=0;i<segment.buf.byteLength;i+=SLICE){await waitBuffer(p);p.channel.send(segment.buf.slice(i,i+SLICE));}state.sent+=segment.buf.byteLength;}).catch(e=>{if(!p.closed)dropPeer(p,e.message);}).finally(()=>{p.queued-=segment.buf.byteLength;});}
function send(p,m){if(m.type==='hello'&&state.commonStart)m={...m,...commonHelloFields()};if(p.channel?.readyState==='open')p.channel.send(JSON.stringify(m));}
function makePeer(id,direction){if(state.peers.size>=4)throw Error('This laptop already has enough active or pending connections.');const pc=new RTCPeerConnection(ice());const p={id,direction,pc,channel:null,label:'friend',ready:false,queued:0,chain:Promise.resolve(),incoming:null,verifyChain:Promise.resolve(),closed:false,timers:[],trail:[],ping:null,lastSentSeq:-1};state.peers.set(id,p);pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState)&&!p.closed)dropPeer(p,'Peer connection ended.');update();};pc.ondatachannel=e=>attach(p,e.channel);update();return p;}
function attach(p,dc){if(p.channel){dc.close();return;}p.channel=dc;initDeliveryPeer(p);dc.binaryType='arraybuffer';dc.onopen=()=>{status('Connected to '+p.label+'. Video follows the shared group clock.');if(p.direction==='up'){const w=$('outgoing-wrap');if(w.classList.contains('visible-reply')){w.classList.add('hidden');w.classList.remove('visible-reply');if(state.out?.kind==='castreply')state.out=null;$('outgoing-help').textContent='Connected. Waiting for the shared group clock and delayed video.';}}send(p,{type:'hello',label:label(),cast:state.config.id,deliveryVersion:1,resumeAfter:p.direction==='up'?resumeAfter():undefined,playbackLagSeconds:p.direction==='up'&&isHlsConfig(state.config)?boundedPlaybackLag((nominalProgramTime()??0)-(effectiveProgramTime()??0)):undefined});if(p.direction==='up'){window.SameEndInviteCheck?.mark?.('supplier-open');state.supplier={id:p.nodeId||p.id,label:p.label};if(!magnetTransport)state.sourceReachable=true;state.clockSamples=[];lifecycle();ping(p);p.timers.push(setInterval(()=>ping(p),3000));}log('Encrypted peer connection opened.');update();};dc.onclose=()=>{if(!p.closed)dropPeer(p,'Peer disconnected.');};dc.onerror=()=>log('A peer reported a data connection error.');dc.onmessage=e=>{if(p.direction==='up'&&stallIncoming===p.id)return;try{if(typeof e.data==='string'){if(e.data.length>16000)throw Error('Oversized control message.');const m=JSON.parse(e.data);Promise.resolve(handleControl(p,m)).catch(e=>dropPeer(p,e.message));}else{const a=p.incoming;if(!a||!(e.data instanceof ArrayBuffer)||e.data.byteLength>SLICE||a.got+e.data.byteLength>a.meta.size)throw Error('Unexpected media packet.');a.parts.push(e.data);a.got+=e.data.byteLength;if(a.got===a.meta.size){p.incoming=null;p.verifyBytes=(p.verifyBytes||0)+a.got;if(p.verifyBytes>MAX_QUEUE)throw Error('Incoming verification queue is too large.');const joined=new Uint8Array(a.got);let pos=0;for(const part of a.parts){joined.set(new Uint8Array(part),pos);pos+=part.byteLength;}p.verifyChain=p.verifyChain.then(()=>{if(!p.closed)return acceptSegment(a.meta,joined.buffer,p,a.receiveStartedAtMs);}).catch(e=>dropPeer(p,e.message)).finally(()=>{p.verifyBytes-=joined.byteLength;});}}}catch(e){dropPeer(p,e.message);}};}
function ping(p){p.ping=now();send(p,{type:'ping',t:p.ping});}
async function handleControl(p,m){if(!m||typeof m.type!=='string')throw Error('Invalid control message.');p.lastControlAt=now();if(m.type==='hello'){const firstHello=!p.ready;if(m.cast!==state.config.id)throw Error('Wrong cast.');p.label=typeof m.label==='string'?m.label.slice(0,40):'friend';p.deliveryVersion=m.deliveryVersion===1?1:0;await handleCommonHello(p,m);if(p.closed||state.stopped)return;if(p.direction==='down'){const previousLag=p.playbackLagSeconds||0,lag=boundedPlaybackLag(m.playbackLagSeconds),earlier=lag>previousLag+.5;if(firstHello||earlier){p.playbackLagSeconds=lag;const resume=p.deliveryVersion===1&&Number.isSafeInteger(m.resumeAfter)&&m.resumeAfter>=-1?m.resumeAfter:-1;if(firstHello)p.lastSentSeq=resume;else{p.replayAfterSeq=resume;p.replayBeforeMs=Math.max(p.replayPending?p.replayBeforeMs:0,state.config.epoch+((nominalProgramTime()??0)-previousLag)*1000-4000);p.replayPending=true;}}}p.ready=true;if(p.direction==='down')stageWindow();if(firstHello)lifecycle();update();}else if(m.type==='ping'){if(!Number.isFinite(m.t))throw Error('Invalid clock request.');send(p,{type:'pong',t:m.t,origin:now()+state.offset});}else if(m.type==='pong'){if(p.direction!=='up'||m.t!==p.ping||!Number.isFinite(m.origin))return;const rtt=now()-m.t;if(rtt<0||rtt>7000)return;const sample={rtt,offset:m.origin-(m.t+now())/2};state.clockSamples.push(sample);state.clockSamples=state.clockSamples.slice(-10);const best=state.clockSamples.reduce((a,b)=>a.rtt<b.rtt?a:b);state.offset=best.offset;state.clockReady=true;window.SameEndInviteCheck?.mark?.('clock-ready');update();}else if(m.type==='delivery-receipt'){if(p.direction!=='down'||p.deliveryVersion!==1||m.cast!==state.config.id)throw Error('Invalid delivery receipt.');p.meter.acknowledge(m);
}else if(m.type==='segment'){if(p.direction!=='up'||p.incoming||!m.meta||!Number.isInteger(m.meta.size)||m.meta.size<=0||m.meta.size>MAX_CLIP)throw Error('Invalid media header.');p.incoming={meta:m.meta,parts:[],got:0,receiveStartedAtMs:now()};}else if(m.type==='source-end'){
  if(p.direction!=='up')throw Error('Only the supplying path may forward a source end.');
  const c=state.config;
  if(m.version!==1||m.cast!==c.id||m.sourceId!==(c.sourceId||c.id)||m.sourceEpoch!==(c.sourceEpoch??c.epoch)||!Number.isFinite(m.endedAt)||m.endedAt<c.epoch||m.endedAt>now()+state.offset+45000||!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},state.pub,un64(m.sig),enc.encode(endCanonical(m))))throw Error('Unverified source end.');
  await end('The source ended this cast.',m);
}else if(m.type==='relay-leave'||m.type==='end'){if(p.direction==='up')dropPeer(p,'Your supplying friend left. Looking for another supplier.');}else throw Error('Unknown control message.');}
function dropPeer(p,reason){if(p.closed)return;p.closed=true;for(const t of p.timers)clearInterval(t);p.incoming=null;p.ready=false;p.channel?.close();p.pc.close();state.peers.delete(p.id);if(state.pendingOffer?.id===p.id)state.pendingOffer=null;log(reason);if(p.direction==='up'&&!state.stopped){state.supplier=null;state.sourceReachable=false;state.recovery={...state.recovery,state:magnetTransport?'searching':'manual-rejoin',startedAt:now()};status(magnetTransport?'Your supplying friend disconnected. Keeping the group clock and saved video while another supplier is found.':'Your supplying friend disconnected. Saved video can continue until its window ends. A new connection is needed for more.');}lifecycle();update();}
async function gather(pc){if(pc.iceGatheringState==='complete')return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',on);reject(Error('Connection discovery timed out. Check the STUN address or leave it blank.'));},12000);function on(){if(pc.iceGatheringState==='complete'){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',on);resolve();}}pc.addEventListener('icegatheringstatechange',on);});}
function setOut(obj,kind){state.out={obj,kind};$('outgoing').value=code(obj);$('outgoing-label').textContent=kind==='castinvite'?'Invitation file to send to your friend':'Reply file to return to your inviting friend';$('save-code').textContent=kind==='castinvite'?'Save invitation file':'Save reply file';$('outgoing-help').textContent=kind==='castinvite'?'Save the invitation file and send it privately. Your friend opens it, accepts, then sends you a reply file.':'This reply was created automatically after you accepted the invitation. Save the reply file and send it back; your friend will open it here and accept it.';$('outgoing-wrap').classList.remove('hidden');$('outgoing-wrap').classList.toggle('visible-reply',kind==='castreply');$('outgoing-wrap').scrollIntoView({behavior:'smooth',block:'nearest'});$('cancel-offer').classList.toggle('hidden',kind!=='castinvite');}
async function makeInvite(){if(!state.config||!state.clockReady||state.stopped)throw Error('Start or join a cast first.');if(state.pendingOffer)throw Error('Finish or cancel your existing invitation first.');if([...state.peers.values()].filter(p=>p.direction==='down').length>=relayLimit())throw Error('Ask a connected viewer to invite the next friend.');$('outgoing').value='';$('outgoing-wrap').classList.add('hidden');state.out=null;const id=crypto.randomUUID();const p=makePeer(id,'down');try{attach(p,p.pc.createDataChannel('private-cast-v1',{ordered:true}));await p.pc.setLocalDescription(await p.pc.createOffer());await gather(p.pc);const expires=now()+15*60000;p.timers.push(setTimeout(()=>{if(!p.ready)dropPeer(p,'Unused invitation expired.');},15*60000));const obj={format:'private-cast',version:1,type:'offer',id,from:label(),created:now(),expires,trail:[...(state.trail||[]),state.nodeId],config:state.config,sdp:p.pc.localDescription.toJSON()};state.pendingOffer={id,expires};setOut(obj,'castinvite');status('Invitation ready. Send it privately; keep this page open for the reply.');}catch(e){dropPeer(p,'Invitation could not be created.');throw e;}}
function validateOffer(o){if(!o||o.format!=='private-cast'||o.version!==1||!['offer','answer'].includes(o.type)||typeof o.id!=='string'||o.id.length>80||typeof o.sdp?.sdp!=='string'||o.sdp.sdp.length>40000||o.sdp.type!==o.type)throw Error('This is not a valid Same End invitation or reply.');if(o.type==='offer'){const c=o.config;if(!Number.isFinite(o.expires)||now()>o.expires+60000||o.expires-now()>20*60000)throw Error('This invitation has expired or its clock is too far from yours. Ask for a fresh invitation and check both clocks.');if(!c||typeof c.id!=='string'||!Number.isFinite(c.epoch)||![10,60,300].includes(c.delay)||!(isHlsConfig(c)||SameEndMedia.allowedMime(c.mime))||!c.publicKey||!Array.isArray(o.trail)||o.trail.length>12)throw Error('Unsupported cast settings.');if(o.trail.includes(state.nodeId))throw Error('This invitation would make a relay loop.');if(state.config)throw Error('Leave your current cast before accepting another invitation.');}else if(!state.pendingOffer||state.pendingOffer.id!==o.id||!state.peers.has(o.id)||now()>state.pendingOffer.expires)throw Error('No matching unused invitation is waiting on this laptop.');}
async function readIncoming(){const text=$('incoming').value.trim();if(!text)throw Error('Open a connection file or paste its code first.');const o=parse(text);validateOffer(o);state.pending=o;$('approve').textContent=o.type==='offer'?'Join cast and create reply':'Connect to this viewer';$('confirm-text').textContent=o.type==='offer'?'Join the cast supplied by '+String(o.from||'a friend').slice(0,40)+'? Accepting creates a reply file for you to save and send back. Your computer may relay video to friends you invite.':'Connect to this viewer: accepting sends them your live video. The connection starts when the direct link opens.';$('confirm').classList.remove('hidden');}
async function approve(){if(startingCapture)throw Error('Your shared screen is still being prepared. Wait a moment before joining a room.');const o=state.pending;if(!o)throw Error('Read an invitation or reply first.');validateOffer(o);state.pending=null;$('confirm').classList.add('hidden');if(o.type==='offer'){await init(o.config,'viewer');state.offset=0;state.clockReady=false;state.trail=o.trail;const p=makePeer(o.id,'up');p.label=String(o.from||'friend').slice(0,40);try{await p.pc.setRemoteDescription(o.sdp);await p.pc.setLocalDescription(await p.pc.createAnswer());await gather(p.pc);setOut({format:'private-cast',version:1,type:'answer',id:o.id,from:label(),sdp:p.pc.localDescription.toJSON()},'castreply');status('Reply ready. Return it privately to your supplying friend, who must accept it.');p.timers.push(setTimeout(()=>{if(!p.ready)dropPeer(p,'The invitation was not completed. Try a fresh connection.');},Math.max(1,Math.min(15*60000,o.expires-now()))));}catch(e){dropPeer(p,'Could not join.');throw e;}}else{const p=state.peers.get(o.id);p.label=String(o.from||'friend').slice(0,40);await p.pc.setRemoteDescription(o.sdp);state.pendingOffer=null;$('outgoing-wrap').classList.add('hidden');state.out=null;status('Reply accepted. Waiting for the direct connection to open.');}update();}
async function start(stream,cleanup,sourceKind='screen'){
 checkPlatform(true);
 if(state.config||startingCapture||magnetBusy){stream.getTracks().forEach(t=>t.stop());cleanup?.();throw Error('Leave your current cast first.');}
 startingCapture=true;
 const inputStream=stream,originalCleanup=cleanup;let normalizer=null;
 try{
  lastNetworkCheck=null;lastJoinLink=null;
  const audio=stream.getAudioTracks().length>0,mime=SameEndMedia.recordingMime(audio);
  if(!mime||!SameEndMedia.canPlay(mime))throw Error('This browser cannot record a shareable picture. Use updated Chrome, Edge or Safari on a computer.');
  // Convert real source pixels before recording. GPU tab frames can switch
  // colour range even at a constant resolution; Apple decoders can reject it.
  // Audio and the signed programme clock keep their existing paths.
  if(mime.startsWith('video/mp4')&&window.SameEndCapture){
   normalizer=window.SameEndCapture.normalize(stream,{onError:()=>{if(state.active&&captureNormalizer===normalizer)end('Screen capture stopped. Start a fresh share in updated Chrome or Edge.');}});
   await normalizer.ready;stream=normalizer.stream;
  }
  captureNormalizer=normalizer;
  cleanup=()=>{normalizer?.close();originalCleanup?.();};
  state.key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicKey=await crypto.subtle.exportKey('jwk',state.key.publicKey);
  state.stream=stream;state.demoCleanup=cleanup;state.seq=0;state.active=true;state.offset=0;state.clockReady=true;state.trail=[];captureStats=null;
  const epoch=now();await init({id:crypto.randomUUID(),epoch,delay:Number($('delay').value),mime,publicKey,audio,segmentVersion:2,sourceId:crypto.randomUUID(),sourceEpoch:0,programId:crypto.randomUUID(),alignmentVersion:1},'source');
  state.sourceReachable=true;monitorSourceAudio(stream,sourceKind);lifecycle();
  for(const t of stream.getVideoTracks())t.addEventListener('ended',()=>{if(state.active)end('Screen sharing ended.');},{once:true});
  record();status(mime.startsWith('video/mp4')?'Cast running. Your delayed picture will begin shortly. You can invite a friend now.':'Cast running in WebM. Older iPhones and iPads need the host to use updated Chrome, Edge or Safari for MP4.');
 }catch(e){normalizer?.close();inputStream.getTracks().forEach(t=>t.stop());originalCleanup?.();if(state.active&&state.stream===stream)await end('Screen sharing could not start.');throw e;}
 finally{startingCapture=false;}
}
function loadStandardCapture(){
 if(window.SameEndHLSCapture)return window.SameEndHLSCapture;
 if(typeof window.VideoEncoder!=='function'||typeof window.BigInt!=='function')throw Error('This browser can watch. To share a tab, use updated Chrome or Edge on a computer.');
 const asset=$('same-end-hls-capture');if(!asset)throw Error('The standard capture engine is missing. Reload Same End.');
 const script=document.createElement('script');script.textContent=asset.textContent;document.head.append(script);script.remove();
 if(!window.SameEndHLSCapture)throw Error('The standard capture engine could not load. Update Chrome or Edge.');
 return window.SameEndHLSCapture;
}
async function startStandard(inputStream,originalCleanup,sourceKind='screen'){
 if(state.config||startingCapture||magnetBusy){inputStream.getTracks().forEach(t=>t.stop());originalCleanup?.();throw Error('Leave your current cast first.');}
 startingCapture=true;let normalizer=null,stream=inputStream,producer=null;
 try{
  checkPlatform();if(window.SameEndShareHelp?.phone)throw Error(window.SameEndShareHelp.phoneMessage);
  if(!window.SameEndHLS||!(SameEndHLS.canPlay()||SameEndHLS.canPlayNative()))throw Error('Update Chrome or Edge to start a standard HLS room.');
  const capture=loadStandardCapture();
  normalizer=window.SameEndCapture?.normalize(inputStream,{onError:()=>{if(state.active&&captureNormalizer===normalizer)end('Screen capture stopped. Start a fresh share.');}})||null;
  if(normalizer){await normalizer.ready;stream=normalizer.stream;}
  if(!await capture.canCapture(stream))throw Error('This browser can watch. To share a tab, use updated Chrome or Edge on a computer.');
  state.key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicKey=await crypto.subtle.exportKey('jwk',state.key.publicKey),epoch=now();
  const config={id:crypto.randomUUID(),epoch,delay:Number($('delay').value),mime:SameEndHLS.HLS_MIME,mediaProfile:SameEndHLS.HLS_PROFILE,publicKey,audio:stream.getAudioTracks().length>0,segmentVersion:2,sourceId:crypto.randomUUID(),sourceEpoch:0,programId:crypto.randomUUID(),alignmentVersion:1,...(window.SameEndConfig?.automaticCommonStart===true&&Number($('delay').value)===300?{commonStartVersion:2}:{})};
  state.stream=stream;state.seq=0;state.active=true;state.offset=0;state.clockReady=true;state.trail=[];captureStats=null;captureNormalizer=normalizer;state.sourceChain=Promise.resolve();
  state.demoCleanup=()=>{void producer?.close().catch(()=>{});normalizer?.close();originalCleanup?.();};
  lastNetworkCheck=null;lastJoinLink=null;
  await init(config,'source');state.sourceReachable=true;monitorSourceAudio(stream,sourceKind);lifecycle();
  producer=await capture.createCapture(stream,{epoch,bitrate:Number($('quality').value),now,onError:()=>{if(state.active&&state.config?.id===config.id)void end('Your shared picture stopped. Start a fresh share.');},onBatch:batch=>{
   const job=async()=>{
    if(!state.active||state.stopped||state.config?.id!==config.id)return;
    const buf=SameEndHLS.encodeBundle(batch),start=epoch+batch.start*1000,duration=batch.duration*1000;
    const meta={v:2,cast:config.id,sourceId:config.sourceId,sourceEpoch:config.sourceEpoch,programId:config.programId,programStartTime:batch.start*1000,alignmentVersion:1,seq:state.seq++,start,duration,size:buf.byteLength,mime:config.mime,hash:await hash(buf)};
    meta.sig=b64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},state.key.privateKey,enc.encode(canonical(meta)))));
    const settings=stream.getVideoTracks()[0]?.getSettings()||{};
    captureStats={width:settings.width??null,height:settings.height??null,frameRate:settings.frameRate??null,targetVideoMbps:Number($('quality').value)/1e6,actualMediaMbps:buf.byteLength*8/1e6/batch.duration,lastPieceSeconds:batch.duration,lastPieceAt:now(),recordingLatencyMs:Math.max(0,now()-start-duration),mediaProfile:config.mediaProfile,encoderVideoPackets:producer?.stats.videoPackets??null,encoderAudioPackets:producer?.stats.audioPackets??null,encoderStartupOffsetSeconds:producer?.stats.startupOffsetSeconds??null};
    await acceptSegment(meta,buf,null);
   };
   state.sourceChain=state.sourceChain.then(job);return state.sourceChain;
  }});
  hlsCapture=producer;await producer.ready;
  for(const track of inputStream.getVideoTracks())track.addEventListener('ended',()=>{if(state.active&&state.config?.id===config.id)void end('Screen sharing ended.');},{once:true});
  status('Room open. Invite your mates while the picture warms up.');
 }catch(error){void producer?.close().catch(()=>{});normalizer?.close();inputStream.getTracks().forEach(t=>t.stop());originalCleanup?.();if(state.active&&state.stream===stream)await end('Screen sharing could not start.');throw error;}
 finally{startingCapture=false;}
}
function record(){if(!state.active)return;const started=now();let recorder;try{recorder=new MediaRecorder(state.stream,{mimeType:state.config.mime,videoBitsPerSecond:Number($('quality').value),audioBitsPerSecond:96000});}catch(e){end('Recording failed: '+e.message);return;}state.recorder=recorder;const parts=[];let ended=started;recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};recorder.onerror=e=>end('Screen recording failed: '+(e.error?.message||'unknown error'));recorder.onstop=()=>{const still=state.active,cast=state.config?.id,seq=state.seq++;if(still)record();if(!still)return;state.sourceChain=state.sourceChain.then(async()=>{if(!state.active||state.config?.id!==cast)return;try{const blob=new Blob(parts,{type:state.config.mime});if(!blob.size)return;if(blob.size>MAX_CLIP)throw Error('A video piece was too large. End and use a lower picture quality.');const buf=await blob.arrayBuffer();const meta={v:2,cast:state.config.id,sourceId:state.config.sourceId,sourceEpoch:state.config.sourceEpoch,programId:state.config.programId,programStartTime:started-state.config.epoch,alignmentVersion:1,seq,start:started,duration:ended-started,size:buf.byteLength,mime:state.config.mime,hash:await hash(buf)};meta.sig=b64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},state.key.privateKey,enc.encode(canonical(meta)))));captureStats={width:state.stream.getVideoTracks()[0]?.getSettings().width??null,height:state.stream.getVideoTracks()[0]?.getSettings().height??null,frameRate:state.stream.getVideoTracks()[0]?.getSettings().frameRate??null,targetVideoMbps:Number($('quality').value)/1e6,actualMediaMbps:buf.byteLength*8/1e6/(meta.duration/1000),lastPieceSeconds:meta.duration/1000,lastPieceAt:ended,recordingLatencyMs:Math.max(0,now()-ended)};await acceptSegment(meta,buf,null);}catch(e){if(state.active)end(e.message);}});};recorder.start();state.captureTimer=setTimeout(()=>{ended=now();if(recorder.state==='recording')recorder.stop();},2000);}
async function demo({standard=false}={}){checkPlatform(true);const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;const ctx=canvas.getContext('2d');let frame=0;const timer=setInterval(()=>{const t=now();ctx.fillStyle='#142b3c';ctx.fillRect(0,0,960,540);ctx.fillStyle='#d7e9ef';ctx.font='bold 58px system-ui';ctx.fillText('SAME END',44,100);ctx.font='32px system-ui';ctx.fillText(new Date(t).toISOString().slice(11,23)+' source clock',44,170);ctx.fillStyle='#b04a71';ctx.fillRect((frame++*7)%800,260,150,80);ctx.fillStyle='white';ctx.font='24px system-ui';ctx.fillText('A moving picture generated on this computer',44,445);},40);const stream=canvas.captureStream(25);let ac;try{ac=new AudioContext();await ac.resume();const dest=ac.createMediaStreamDestination(),osc=ac.createOscillator(),gain=ac.createGain();osc.frequency.value=220;gain.gain.value=.025;osc.connect(gain).connect(dest);osc.start();stream.addTrack(dest.stream.getAudioTracks()[0]);}catch(e){log('Demo audio unavailable: '+e.message);}await (standard?startStandard:start)(stream,()=>{clearInterval(timer);ac?.close();},'demo');}
function stageWindow(){
 if(!state.config||!state.clockReady||state.stopped)return;
 cleanCache();const nominal=nominalProgramTime();state.player?.setPlaybackWindow?.(state.commonStart&&!state.commonStart.decision?(soloCommonPlayback()?nominal:state.role==='source'?(state.commonStart.preparationTarget??0):Math.min(-1,nominal??-1)):scheduledCommonStart()?(state.role==='source'?(state.commonStart.preparationTarget??nominal):-1):viewerProgramTime(),document.visibilityState==='hidden');
 const target=playbackTargetMs(),useful=state.cache.filter(s=>s.meta.start+s.meta.duration>=target-4000&&s.meta.start<=target+(state.player?.lookAheadSeconds?.()||4)*1000);
 for(const s of useful)if(!state.appendedSeq.has(s.meta.seq)){state.player?.enqueue(s,state.config.epoch);state.appendedSeq.add(s.meta.seq);state.lastAppendSeq=Math.max(state.lastAppendSeq,s.meta.seq);}
 while(state.appendedSeq.size>400)state.appendedSeq.delete(state.appendedSeq.values().next().value);
 for(const p of state.peers.values()){
  if(p.direction==='up'&&p.ready&&!p.closed&&isHlsConfig(state.config)){
   const lag=boundedPlaybackLag(nominal-effectiveProgramTime());
   // Announce each meaningful expansion once. A fresh supplier also gets this in hello.
   if(lag>(p.announcedPlaybackLag||0)+1&&now()-(p.lastLagHintAt||0)>3000){send(p,{type:'hello',label:label(),cast:state.config.id,deliveryVersion:1,resumeAfter:resumeAfter(),playbackLagSeconds:lag});p.announcedPlaybackLag=lag;p.lastLagHintAt=now();}
  }
  if(p.direction!=='down'||!p.ready||p.closed||stallOutgoing&&(stallOutgoing===true||stallOutgoing===p.nodeId||stallOutgoing===p.id))continue;
  const childNominal=state.commonStart?.version===2&&!state.commonStart.decision&&p.commonStartVersion===2?(now()+state.offset-state.config.epoch)/1000:p.commonStartVersion===state.commonStart?.version?nominal:(now()+state.offset-state.config.epoch)/1000-state.config.delay;
  const cutoff=state.config.epoch+(childNominal-boundedPlaybackLag(p.playbackLagSeconds))*1000-4000;
  let count=0;for(const s of state.cache){const replay=p.replayPending&&s.meta.start<p.replayBeforeMs&&s.meta.seq>(p.replayAfterSeq??-1);if(s.meta.start+s.meta.duration>=cutoff&&(s.meta.seq>p.lastSentSeq||replay)&&p.queued<4*1024*1024&&count<2){enqueue(p,s);p.lastSentSeq=Math.max(p.lastSentSeq,s.meta.seq);if(replay)p.replayAfterSeq=s.meta.seq;count++;}}
  if(p.replayPending&&!state.cache.some(s=>s.meta.start+s.meta.duration>=cutoff&&s.meta.start<p.replayBeforeMs&&s.meta.seq>(p.replayAfterSeq??-1)))p.replayPending=false;
 }
}
function syncPlayback(){if(!state.config||!state.clockReady||!state.player||document.visibilityState==='hidden')return;advanceCommonStart();if(state.commonStart&&!state.commonStart.decision&&!soloCommonPlayback()){stageWindow();$('play-state').textContent=state.playbackStarted?'':'Checking the room’s connection for a smoother, earlier start…';return;}if(scheduledCommonStart()&&!(state.role==='source'&&state.commonStart.decision.delaySeconds===state.config.delay&&state.playbackStarted)){stageWindow();$('player').pause();$('play-state').textContent='The room starts together in '+Math.ceil((state.commonStart.decision.startsAt-now()-state.offset)/1000)+' seconds.';return;}advanceInitialDelay();stageWindow();const target=viewerProgramTime();const result=state.initialDelayPolicy?.state==='observing'?{waiting:true,drift:null}:state.player.sync(target);if(target<0){const remaining=Math.ceil(-target);$('play-state').textContent=state.playbackStarted?'':state.initialDelayPolicy?.enabled&&['observing','preparing'].includes(state.initialDelayPolicy.state)?'Getting your picture ready. Checking the connection and first buffer.':'The group starts in '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0')+' · everyone waits for the same source-clock moment.';return;}if(result.waiting){if(!state.waiting&&state.playbackStarted)state.stalls++;state.waiting=true;state.drift=null;$('play-state').textContent=state.sourceReachable?(state.playbackStarted?'':isHlsConfig(state.config)?'Building a buffer for smoother playback.':'Waiting for the piece at the shared play time. Your view rejoins the group’s current moment when it arrives.'):'The source path is unavailable. Saved video is limited; future picture needs an online source.';update();return;}state.waiting=false;state.playbackStarted=true;state.drift=result.drift;$('play-state').textContent=$('player').paused?'Tap Turn my sound on to start playback.':(isHlsConfig(state.config)?'Playing with a buffer · ':'Following the group clock · ')+(state.initialDelayPolicy?.state==='committed'?state.initialDelayPolicy.selectedDelaySeconds:commonDelaySeconds())+' seconds behind capture'+(state.player.mode==='clips'?' · compatibility playback may pause briefly between pieces.':'.');update();}
async function end(message='You ended this connection.',sourceEnd=null){
 magnetJoinGeneration++;
 if(state.stopped)return;
 const config=state.config,key=state.key,role=state.role,oldMagnet=magnetTransport,peers=[...state.peers.values()];
 state.stopped=true;state.active=false;state.invitationConfigId=null;state.sourceEnded=!!sourceEnd||role==='source';state.sourceReachable=false;
 sourceAudioMonitor?.close();sourceAudioMonitor=null;sourceAudioState=null;sourceAudioKind=null;renderSourceAudio();
 const oldHlsCapture=hlsCapture;hlsCapture=null;void oldHlsCapture?.close().catch(()=>{});clearTimeout(state.captureTimer);if(state.recorder?.state==='recording')state.recorder.stop();state.stream?.getTracks().forEach(t=>t.stop());state.demoCleanup?.();state.demoCleanup=null;
 // Relays cannot turn departure into a source shutdown. Only a verified signature
 // made by the cast's capture key is forwarded as a whole-cast end.
 let ending=sourceEnd;
 if(role==='source'&&config&&key){try{ending={type:'source-end',version:1,cast:config.id,sourceId:config.sourceId||config.id,sourceEpoch:config.sourceEpoch??config.epoch,endedAt:now()};ending.sig=b64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,enc.encode(endCanonical(ending)))));}catch(e){log('Source end could not be signed; peers will recover as a lost source path.');}}
 for(const p of peers){if(p.direction==='down')send(p,ending||{type:'relay-leave'});p.closed=true;for(const t of p.timers)clearInterval(t);p.incoming=null;p.ready=false;}
 magnetTransport=null;magnetCleanup=new Promise(resolve=>setTimeout(async()=>{for(const p of peers){p.channel?.close();p.pc.close();}await oldMagnet?.close();resolve();},250));
 $('magnet-link').value='';$('copy-magnet').disabled=true;state.peers.clear();stallOutgoing=null;stallIncoming=null;relayLimitOverride=null;lastMaintenance=0;state.player?.close();$('player').pause();$('player').removeAttribute('src');$('player').load();if(state.url)URL.revokeObjectURL(state.url);
 state.appendedSeq=new Set();Object.assign(state,{config:null,commonStart:null,key:null,pub:null,stream:null,recorder:null,source:null,sb:null,player:null,url:null,cache:[],cacheBytes:0,appendedSeq:new Set(),append:[],appending:false,seen:new Set(),clockReady:false,clockSamples:[],pending:null,pendingOffer:null,out:null,drift:null,lastAppendSeq:-1,trail:[],offset:0,supplier:null,recovery:{...state.recovery,state:'stopped'}});
 $('outgoing-wrap').classList.add('hidden');$('confirm').classList.add('hidden');$('identity').textContent='';$('audio-state').textContent='No source · media cache cleared';$('play-state').textContent='Cast stopped. Start a new cast or accept a fresh invitation.';status(message);lifecycle();update();
}
function createMagnetTransport(){
 if(location.protocol==='file:')throw Error('For magnet joining, open the desktop app or use the included localhost launcher. Offline manual connection files remain available here.');
 if(!window.CastMagnetTransport){for(const id of ['magnet-vendor','magnet-module']){const asset=document.getElementById(id);if(!asset)throw Error('Magnet engine is missing. Open the complete app.');const script=document.createElement('script');script.textContent=asset.textContent;document.head.append(script);script.remove();}}
 if(!window.CastMagnetTransport)throw Error('The magnet connection module is missing from this copy. Open the complete version 0.4 app.');
 let transport;return transport=new window.CastMagnetTransport({
  getStatus:()=>({nodeId:state.nodeId,label:label(),role:state.role,clockReady:state.clockReady,trail:state.trail||[],downCount:[...state.peers.values()].filter(p=>p.direction==='down').length,hasParent:[...state.peers.values()].some(p=>p.direction==='up'),relayLimit:relayLimit()}),
  onProgress:name=>window.SameEndInviteCheck?.mark?.(name),
  onSession:async config=>{if(magnetTransport!==transport)throw Error('This invitation was cancelled.');window.SameEndInviteCheck?.mark?.('descriptor-ready');if(state.config)throw Error('A cast is already open. End it before joining another.');state.offset=0;state.clockReady=false;state.trail=[];await init(config,'viewer');if(magnetTransport!==transport&&state.config?.id===config.id)await end();},
  onPeer:peer=>{if(magnetTransport!==transport||!state.config||state.stopped||state.peers.size>=4){peer.channel.close();return;}const id='magnet:'+peer.id;if(state.peers.has(id)){peer.channel.close();return;}if(peer.direction==='up')state.trail=peer.trail||[];const p={id,nodeId:peer.id,direction:peer.direction,pc:{connectionState:'connected',close:()=>peer.channel.close()},channel:null,label:peer.label,ready:false,queued:0,chain:Promise.resolve(),incoming:null,verifyChain:Promise.resolve(),closed:false,timers:[],trail:peer.trail||[],ping:null,lastSentSeq:-1};state.peers.set(id,p);attach(p,peer.channel);$('magnet-progress').textContent='Peer connected. Following the shared group clock; no reply file was exchanged.';update();},
  onTopology:topology=>{if(magnetTransport!==transport||state.stopped||!state.config)return;state.trail=topology.trail;state.sourceReachable=topology.sourceReachable;state.supplier=topology.supplier;lifecycle();},
  onRecovery:recovery=>{if(magnetTransport!==transport||state.stopped||!state.config)return;state.recovery=recovery;if(recovery.state==='connected'){status('A supplying friend is connected. Your saved video and group clock are preserved.');}else if(recovery.state==='retrying'){status('The direct picture route is unavailable. Retrying automatically; keep this invitation open.');}else if(recovery.state==='exhausted'){status('No available supplier yet. Keeping saved video and retrying automatically while the room remains open.');}lifecycle();},
  onError:error=>{$('magnet-progress').textContent=error.message||String(error);log('Magnet connection: '+(error.message||'failed'));}
 });
}
async function makeMagnet(){
 if(!state.active||state.role!=='source')throw Error('Start a cast first.');
 if(magnetBusy)throw Error('An invitation is already being prepared.');
 const config=state.config;let transport;magnetBusy=true;update();
 $('magnet-progress').textContent='Preparing the encrypted cast descriptor and connecting to the introduction tracker…';
 try{
  await magnetCleanup;
  if(state.config!==config||!state.active||state.role!=='source')throw Error('Sharing stopped before the invitation was ready.');
  if(!magnetTransport)magnetTransport=createMagnetTransport();transport=magnetTransport;
  const link=await transport.publish(config);
  if(state.config!==config||!state.active||magnetTransport!==transport)throw Error('Sharing changed before the invitation was ready.');
  state.invitationConfigId=config.id;$('magnet-link').value=link;$('copy-magnet').disabled=false;lifecycle();
  $('magnet-progress').textContent='Ready. Copy this private magnet and send it to your viewer. Keep this cast open.';
 }catch(e){if(transport){await transport.close();if(magnetTransport===transport)magnetTransport=null;}throw e;}finally{magnetBusy=false;update();}
}
async function joinMagnet(link){if(startingCapture)throw Error('Your shared screen is still being prepared. Wait a moment before joining a room.');if(state.config)throw Error('A cast is already open. End it before joining another.');if(magnetBusy)throw Error('A connection is already being prepared.');const generation=++magnetJoinGeneration;let transport=null;const current=()=>generation===magnetJoinGeneration;lastJoinLink=typeof link==='string'&&link.length<=8192&&/^magnet:\?/.test(link)?link.trim():null;lastNetworkCheck=null;window.SameEndInviteCheck?.start('screen',{fresh:true});window.SameEndInviteCheck?.phase('finding-room');magnetBusy=true;update();$('magnet-progress').textContent='Looking for a direct connection to the host or another invited mate. This can take up to 90 seconds…';try{await magnetCleanup;if(!current())throw Error('This invitation was cancelled.');state.trail=[];transport=createMagnetTransport();magnetTransport=transport;await transport.join(link.trim());if(!current()||magnetTransport!==transport)throw Error('This invitation was cancelled.');$('magnet-progress').textContent='Cast descriptor verified. Waiting for an available supplying peer…';}catch(e){const stillCurrent=current();if(stillCurrent)lastNetworkCheck=transport?.snapshot()?.network||null;await transport?.close();if(magnetTransport===transport)magnetTransport=null;if(current()){if(state.config)await end('Could not join this magnet: '+e.message);window.SameEndInviteCheck?.fail('room-unavailable');}throw e;}finally{magnetBusy=false;update();}}
async function leaveRoom(){magnetJoinGeneration++;lastJoinLink=null;if(!state.config&&magnetTransport){const old=magnetTransport;magnetTransport=null;await old.close();return;}await end();}
async function cancelPendingJoin(link){if(!magnetBusy||lastJoinLink!==link)return false;await leaveRoom();return true;}
function canRetryJoin(){return !magnetBusy&&(state.config?state.role==='viewer'&&!!magnetTransport:!!lastJoinLink);}
async function retryJoin(){if(!canRetryJoin())return false;if(state.config){window.SameEndInviteCheck?.start('screen',{fresh:true});return magnetTransport.recoverSupplier('manual')||magnetTransport.retryRecovery();}await joinMagnet(lastJoinLink);return true;}
// Escape a device-specific continuous-player fault without leaving the peer
// room or changing the shared source clock. Keep the existing sound preference.
function useAlternativePlayer(){
 if(state.role!=='viewer'||!state.config||state.stopped||state.player?.mode!=='mse'||!state.player.nativeMime)throw Error('Another player is not available for this room.');
 state.player.fallback('Trying another player.','manual-compatibility');
 stageWindow();syncPlayback();status('Alternative player selected. You are still in the same room, following the same match time.');update();
}
function download(file){const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function appFile(){return new File([pristineHTML], 'private-cast.html',{type:'text/html'});}
if($('alternate-player'))$('alternate-player').onclick=safe(useAlternativePlayer);$('demo').onclick=safe(()=>demo({standard:true}));$('capture').onclick=safe(async()=>{if(window.SameEndShareHelp?.beforeShare())return;checkPlatform(true);if(!navigator.mediaDevices?.getDisplayMedia)throw Error('This device can join a room and chat. To share a tab, start the room on a computer using Chrome, Edge or Safari.');let stream;try{stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:25,max:30}},audio:{suppressLocalAudioPlayback:true,echoCancellation:false,noiseSuppression:false,autoGainControl:false},selfBrowserSurface:'exclude',systemAudio:'exclude'});}catch(e){if(e.name==='NotAllowedError')window.SameEndShareHelp?.denied();throw Error(e.name==='NotAllowedError'?'Screen sharing was not allowed or the picker was cancelled. Nothing was captured. On Mac, check the screen-recording permission and reopen the browser if asked.':e.message);}try{await startStandard(stream);}catch(e){stream.getTracks().forEach(t=>t.stop());throw e;}});
$('make-magnet').onclick=safe(makeMagnet);$('copy-magnet').onclick=safe(async()=>{await navigator.clipboard.writeText($('magnet-link').value);$('magnet-progress').textContent='Private magnet copied. Send the complete link, including its #pc key.';});$('join-magnet-button').onclick=safe(()=>joinMagnet($('join-magnet').value));$('enable-protocol').onclick=safe(async()=>{const ok=await window.PrivateCastDesktop?.enableMagnetLinks();$('magnet-progress').textContent=ok?'Same End is registered for magnet links on this computer.':'Registration was not confirmed. Paste a link to join instead.';});
$('stop').onclick=()=>{lastJoinLink=null;window.SameEndInviteCheck?.stop();leaveRoom();};$('invite').onclick=safe(makeInvite);$('read-invite').onclick=safe(readIncoming);$('approve').onclick=safe(approve);$('decline').onclick=()=>{state.pending=null;$('confirm').classList.add('hidden');};$('import-file').onchange=safe(async e=>{const f=e.target.files[0];if(!f)return;if(f.size>100000)throw Error('Connection file is too large.');$('incoming').value=await f.text();await readIncoming();e.target.value='';});$('save-code').onclick=safe(async()=>{if(!state.out)throw Error('No connection file is ready.');download(new File([JSON.stringify(state.out.obj,null,2)],'private-cast.'+state.out.kind,{type:'application/json'}));});$('copy-code').onclick=safe(async()=>{await navigator.clipboard.writeText($('outgoing').value);status('Connection code copied. Send it privately.');});$('cancel-offer').onclick=()=>{if(state.pendingOffer){const p=state.peers.get(state.pendingOffer.id);if(p)dropPeer(p,'Pending invitation cancelled.');}$('outgoing-wrap').classList.add('hidden');state.out=null;update();};$('fullscreen').onclick=()=>{const v=$('player');if(v.requestFullscreen)v.requestFullscreen().catch(()=>{});else if(v.webkitEnterFullscreen)v.webkitEnterFullscreen();};$('source-audio-check').onclick=()=>sourceAudioMonitor?.resume();function requestRoomSound(){sourceAudioMonitor?.resume();if(!state.player)return;state.player.requestSound().then(update,update);update();}
$('sound').onclick=()=>{if(state.player?.soundBlocked||state.player?.blocked||$('player').muted)requestRoomSound();else{state.player?.muteSound();update();}};
$('sound-unlock').onclick=requestRoomSound;$('save-app').onclick=()=>{download(appFile());$('file-status').textContent='App HTML saved. Attach that file privately; connection codes are not included in the saved app.';};$('share-app').onclick=safe(async()=>{const file=appFile();if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:'Same End'});$('file-status').textContent='File handed to your device sharing controls.';}catch(e){if(e.name!=='AbortError')throw e;}}else{download(file);$('file-status').textContent='File sharing is unavailable here. The app HTML was downloaded; attach it privately to a message.';}});
state.nodeId=crypto.randomUUID();window.PrivateCast={joinMagnet,publishInvitation:async()=>{await makeMagnet();return $('magnet-link').value;},leaveRoom,cancelPendingJoin,canRetryJoin,retryJoin,recoverSupplier:()=>magnetTransport?.retryRecovery()||false,testing:{
  publishInvitation:async()=>{await makeMagnet();return $('magnet-link').value;},
  endRoom:()=>end(),
  startDemo:async({delay=10,profile='legacy'}={})=>{if(![10,60,300].includes(delay))throw Error('Unsupported demo delay.');if(state.config)throw Error('Leave the current cast before starting a demo.');$('delay').value=String(delay);await demo({standard:profile==='hls'});return {id:state.config.id,delay:state.config.delay};},
  setRelayLimit:limit=>{if(!Number.isInteger(limit)||limit<0||limit>2)throw Error('Relay limit must be 0, 1 or 2.');relayLimitOverride=limit;return relayLimit();},
  stallOutgoing:({enabled,peerId}={})=>{stallOutgoing=enabled?(peerId||true):null;return !!stallOutgoing;},
  stallIncoming:({enabled}={})=>{const p=[...state.peers.values()].find(p=>p.direction==='up'&&!p.closed);stallIncoming=enabled?p?.id||null:null;return !!stallIncoming;},
  refreshNetwork:reason=>magnetTransport?.refreshNetwork(reason)||false,
  disconnectUpstream:()=>{if(!state.config||state.role!=='viewer')return false;const p=[...state.peers.values()].find(p=>p.direction==='up');if(!p)return false;dropPeer(p,'Rehearsal: this viewer disconnected its own supplying connection.');return true;}
},snapshot:()=>({mediaDiagnostics:mediaDiagnostics(),joiningBusy:magnetBusy,network:magnetTransport?.snapshot()?.network||lastNetworkCheck,playbackBlocked:state.player?.blocked===true,programTime:state.player?.programTime()??null,targetProgramTime:nominalProgramTime(),signedTargetProgramTime:state.config&&state.clockReady?(now()+state.offset-state.config.epoch)/1000-state.config.delay:null,sharedTargetProgramTime:nominalProgramTime(),commonStart:commonStartSnapshot(),viewerTargetProgramTime:viewerProgramTime(),initialDelay:initialDelaySnapshot(),effectiveTargetProgramTime:effectiveProgramTime(),...playbackStatus(),reserveSeconds:verifiedReserve(),delivery:deliverySnapshot(),clientDelivery:clientDeliverySnapshot(),supplierHealth:state.supplierHealth||null,sourceAudio:sourceAudioState?{...sourceAudioState}:null,nodeId:state.nodeId,trail:[...(state.trail||[])],supplier:state.supplier,recovery:{...state.recovery},stalls:state.stalls,sourceReachable:state.sourceReachable,sourceEnded:state.sourceEnded,invitationConfigId:state.invitationConfigId,lastReceivedAt:state.lastReceivedAt,transport:magnetTransport?.snapshot()||null,role:state.role,active:state.active,playbackMode:state.player?.mode||null,playbackFallbackReason:state.player?.fallbackReason||null,mediaErrorCode:state.player?.mediaErrorCode??null,mime:state.config?.mime||null,config:state.config?{id:state.config.id,delay:state.config.delay,epoch:state.config.epoch,audio:state.config.audio,sourceId:state.config.sourceId,sourceEpoch:state.config.sourceEpoch,programId:state.config.programId,segmentVersion:state.config.segmentVersion,mediaProfile:state.config.mediaProfile||null,commonStartVersion:state.config.commonStartVersion||null}:null,received:state.received,sentBytes:state.sent,cacheBytes:state.cacheBytes,cacheSegments:state.cache.length,cacheOldest:state.cache[0]?.meta.start??null,paused:$('player').paused,bufferedSeconds:Array.from({length:$('player').buffered.length},(_,i)=>$('player').buffered.end(i)-$('player').buffered.start(i)).reduce((a,b)=>a+b,0),offset:state.offset,clockReady:state.clockReady,drift:state.drift,playTime:$('player').currentTime,ready:$('player').readyState,tracks:state.stream?.getTracks().map(t=>({kind:t.kind,state:t.readyState,...(t.kind==='audio'?{localPlaybackSuppressed:t.getSettings().suppressLocalAudioPlayback===true}:{})}))||[],peers:[...state.peers.values()].map(p=>({id:p.nodeId||p.id,label:p.label,direction:p.direction,state:p.pc.connectionState,ready:p.ready,queued:p.queued}))})};
if(window.PrivateCastDesktop){$('native-setup').classList.remove('hidden');window.PrivateCastDesktop.onMagnet(link=>{joinMagnet(link).catch(e=>status(e.message));});}
let screenLock=null,screenLockPending=false;
async function keepAwake(){if(screenLockPending||(screenLock&&!screenLock.released)||!state.config||document.visibilityState!=='visible'||!navigator.wakeLock?.request)return;screenLockPending=true;try{const lock=await navigator.wakeLock.request('screen');if(!state.config||document.visibilityState!=='visible')await lock.release();else screenLock=lock;}catch(e){log('Keep this screen awake while watching.');}finally{screenLockPending=false;}}
window.addEventListener('sameend:castchange',()=>{if(state.config){if(!screenLock||screenLock.released)keepAwake();}else{screenLock?.release().catch(()=>{});screenLock=null;}});
document.addEventListener('visibilitychange',()=>{if(state.clientDelivery)sampleClientDelivery();if(document.visibilityState==='visible')magnetTransport?.refreshNetwork('visible');if(!state.config)return;if(document.visibilityState!=='visible'){$('player').pause();return;}keepAwake();if(state.role==='viewer'){const parent=[...state.peers.values()].find(p=>p.direction==='up'&&p.channel?.readyState==='open');if(parent){state.clockSamples=[];state.clockReady=false;ping(parent);}else magnetTransport?.retryRecovery();}syncPlayback();});
setInterval(syncPlayback,200);setInterval(maintainDelivery,1000);window.addEventListener('offline',()=>{state.clientDelivery?.resetRoute();sampleClientDelivery();});window.addEventListener('online',()=>{state.clientDelivery?.resetRoute();sampleClientDelivery();magnetTransport?.refreshNetwork('online');if(state.config&&state.role==='viewer'&&!state.supplier)magnetTransport?.retryRecovery();});navigator.connection?.addEventListener?.('change',()=>{state.clientDelivery?.resetRoute();sampleClientDelivery();magnetTransport?.refreshNetwork('network-change');});window.addEventListener('beforeunload',()=>{captureNormalizer?.close();magnetTransport?.close();state.stream?.getTracks().forEach(t=>t.stop());for(const p of state.peers.values())p.pc.close();sourceAudioMonitor?.close();});update();
})();
