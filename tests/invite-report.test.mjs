import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{createContext,runInContext}from'node:vm';
const code=await readFile(new URL('../invite-check.js',import.meta.url),'utf8');
test('connection reports include safe current forwarding and measured sending without requiring a recorded test',()=>{
 const ctx=createContext({URLSearchParams,Blob,Uint8Array,Date,console,setInterval:()=>0,clearInterval(){},setTimeout:()=>0,clearTimeout(){},navigator:{userAgent:'',onLine:true},location:{hash:''},document:{visibilityState:'visible',getElementById:()=>null,createElement:()=>({canPlayType:()=>''})},addEventListener(){}});ctx.window=ctx;
 const serving={relayLimit:1,downCount:0,availableSlots:1,leafOnly:false,rooted:true,clockReady:true,sourceAgeSeconds:1.2,queueBytes:20,outgoingMbps:null,cacheRenditions:['audio','v480','PRIVATE-RENDITION'],nodeId:'PRIVATE-ID',cache:[{start:500}]};
 ctx.PrivateCast={snapshot:()=>({role:'viewer',transport:{serving},delivery:{measured:true,deliveredMbps:.73,peers:[{id:'PRIVATE-CHILD',health:'healthy'},{label:'PRIVATE-NAME',health:'congested'}]}})};
 runInContext(code,ctx);const r=ctx.SameEndInviteCheck.report(),j=r.joining;assert.equal(r.testSession,null);assert.equal(j.serving.relayLimit,1);assert.equal(j.serving.availableSlots,1);assert.equal(j.serving.outgoingMbps,null);assert.deepEqual(Array.from(j.serving.cacheRenditions),['audio','v480']);assert.equal(j.sending.deliveredMbps,.73);assert.equal(j.sending.childCount,2);assert.equal(j.sending.congestedChildren,1);assert(!JSON.stringify(r).includes('PRIVATE'));
 const again=ctx.SameEndInviteCheck.cleanReport(r);assert.deepEqual(JSON.parse(JSON.stringify(again.joining.serving)),JSON.parse(JSON.stringify(j.serving)));assert.equal(again.joining.sending.deliveredMbps,.73);
});
test('missing and forged sending facts preserve unknown capacity and reject private data',()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;runInContext(code,ctx);
 const clean=joining=>ctx.SameEndInviteCheck.cleanReport({joining}).joining;
 let j=clean({});assert.equal(j.serving,null);assert.equal(j.sending,null);
 j=clean({serving:{relayLimit:9,downCount:Infinity,availableSlots:-2,rooted:'PRIVATE',sourceAgeSeconds:NaN,cacheRenditions:['v360','v360','PRIVATE'],outgoingMbps:Infinity},sending:{measured:false,deliveredMbps:99,childCount:2.5,congestedChildren:Infinity,peer:'PRIVATE'}});
 assert.equal(j.serving.relayLimit,2);assert.equal(j.serving.downCount,null);assert.equal(j.serving.availableSlots,0);assert.equal(j.serving.rooted,null);assert.equal(j.serving.outgoingMbps,null);assert.deepEqual(Array.from(j.serving.cacheRenditions),['v360']);assert.equal(j.sending.deliveredMbps,null);assert.equal(j.sending.childCount,null);assert(!JSON.stringify(j).includes('PRIVATE'));
 j=clean({sending:{measured:true,deliveredMbps:0,childCount:0,congestedChildren:0}});assert.equal(j.sending.deliveredMbps,0);
});
test('diagnostics report allowlists facts even when every underlying object contains secrets',()=>{
 const secret='PRIVATE_INVITE_KEY_DONT_EXPORT';const ctx=createContext({URLSearchParams,Blob,Uint8Array,Date,console,setInterval:()=>0,clearInterval(){},setTimeout:()=>0,clearTimeout(){},navigator:{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) Version/27.0 Mobile PRIVATE_INVITE_KEY_DONT_EXPORT Safari/604.1',onLine:true},location:{hash:''},document:{visibilityState:'visible',getElementById:()=>({muted:true}),createElement:()=>({canPlayType:()=> 'probably'})}});ctx.window=ctx;ctx.crypto={subtle:{}};ctx.isSecureContext=true;ctx.RTCPeerConnection=function(){};ctx.addEventListener=()=>{};ctx.SameEndConfig={buildId:secret};ctx.PrivateCast={snapshot:()=>({secret,url:'https://example.invalid/#owner='+secret,chat:secret,nodeId:secret,config:{id:secret,delay:300,epoch:1,audio:true},reserveSeconds:13.6,supplierHealth:'source-progress-stalled',recovery:{recoveries:2,private:secret},delivery:{private:secret},transport:{authenticatedPeers:2,availability:{authenticatedPeers:2,rootedSuppliers:1,fullSuppliers:1,eligibleSuppliers:0,unrootedPeers:1,lastReject:'capacity-full',peer:secret}},network:{phase:'finding-peers',problem:null,relayConfigured:false,trackerCount:2,stunServerCount:2,peerAttempts:4,ip:'192.0.2.123',candidate:'PRIVATE_INVITE_KEY_DONT_EXPORT'},role:'viewer',mime:'video/mp4;secret='+secret,playbackMode:'mse',clockReady:true,received:2,peers:[{id:secret,ip:'192.0.2.123',ready:true,state:'connected',label:secret}]})};
 runInContext(code,ctx);const report=ctx.SameEndInviteCheck.report(),text=JSON.stringify(report);assert(!text.includes(secret));for(const x of['192.0.2.123','example.invalid','#owner=','nodeId','sdp'])assert(!text.includes(x));assert.equal(report.build,'unknown');assert.equal(report.device.version,'27.0.1');assert.equal(report.joining.peerConnected,true);assert.equal(report.joining.groupDelaySeconds,300);assert.equal(report.joining.mediaFormat,'mp4');assert.equal(report.joining.verifiedReserveSeconds,14);assert.equal(report.joining.supplierHealth,'source-progress-stalled');assert.equal(report.joining.recoveries,2);assert.equal(report.joining.connectionMode,'unknown');assert.equal(report.joining.relayFallbackConfigured,null);assert.equal(report.joining.relayOfferConfigured,false);assert.equal(report.joining.authenticatedPeerCount,2);assert.deepEqual({...report.joining.availability},{authenticatedPeers:2,rootedSuppliers:1,fullSuppliers:1,eligibleSuppliers:0,unrootedPeers:1,lastReject:'capacity-full'});assert.equal(report.joining.roomState,null);assert.equal(report.joining.sourceState,null);assert.equal(report.joining.network.phase,'finding-peers');assert.equal(report.joining.network.peerAttempts,4);assert.equal(report.joining.network.relayConfigured,false);
});
test('built invitations include automatic check before secret-consuming social code',async()=>{const html=await readFile(new URL('../dist/watch.html',import.meta.url),'utf8');assert(html.indexOf('id="invite-check-module"')<html.indexOf('id="same-end-social"'));assert.match(html,/Send report to your host/);assert.match(html,/Connection help &amp; report/);assert.match(html,/SameEndInviteCheck/);assert.match(html,/start\(["']screen["']\)/);assert.match(html,/id="invite-check-sample"/);});


test('local test summaries are scrubbed before opt-in host reports',async()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;
 runInContext(await readFile(new URL('../diagnostics-core.js',import.meta.url),'utf8'),ctx);runInContext(code,ctx);
 const report=ctx.SameEndInviteCheck.cleanReport({testSession:{reportId:'0123456789abcdef',castTag:'0123456789ab',durationSeconds:5400,lastStatus:{drift:.03,key:'PRIVATE-KEY'},events:[{type:'mark',value:'chat-ok'},{type:'mark',value:'PRIVATE-NAME'}],samples:[{url:'PRIVATE-URL'}],privateLink:'PRIVATE-INVITE'}});
 const text=JSON.stringify(report);assert(!text.includes('PRIVATE-'));assert.equal(report.testSession.lastStatus.drift,.03);assert.equal(report.testSession.events.length,1);assert(!('samples' in report.testSession));assert(Buffer.byteLength(text)<6000);
});

// Added timings are untrusted on receipt, including when peers forge extra fields.
test('startup timing report keeps bounded numbers and excludes arbitrary fields',()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;runInContext(code,ctx);
 const report=ctx.SameEndInviteCheck.cleanReport({startup:{pictureSearchMs:0,chatReadyMs:17.9,firstMediaMs:Infinity,clockReadyMs:-1,descriptorReadyMs:'PRIVATE-KEY',firstPictureMs:99999999,rawSdp:'PRIVATE-SDP',url:'PRIVATE-INVITE'}});
 assert.equal(report.startup.pictureSearchMs,0);assert.equal(report.startup.chatReadyMs,18);assert.equal(report.startup.firstMediaMs,null);assert.equal(report.startup.clockReadyMs,null);assert.equal(report.startup.descriptorReadyMs,null);assert.equal(report.startup.firstPictureMs,3600000);assert(!JSON.stringify(report).includes('PRIVATE-'));
});


test('network renewal reports bounded counters and states without private transport data',()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;runInContext(code,ctx);
 const clean=n=>ctx.SameEndInviteCheck.cleanReport({joining:{network:n}}).joining.network;
 const valid=clean({phase:'retrying',discoveryResets:4.8,bootstrapRetries:3,resetState:'renewed',resetProblem:null,retryAt:Date.now()+17000,privateKey:'PRIVATE-KEY',trackerUrl:'wss://PRIVATE-URL',socket:{ip:'192.0.2.123'}});
 assert.equal(valid.phase,'retrying');assert.equal(valid.discoveryResets,4);assert.equal(valid.bootstrapRetries,3);assert.equal(valid.resetState,'renewed');assert(valid.retryInSeconds>=16&&valid.retryInSeconds<=17);assert(!('retryAt' in valid));assert(!JSON.stringify(valid).includes('PRIVATE'));
 const hostile=clean({discoveryResets:Infinity,bootstrapRetries:-99,resetState:'PRIVATE-STATE',resetProblem:'PRIVATE-ERROR',retryAt:Infinity,retryInSeconds:9999});
 assert.equal(hostile.discoveryResets,null);assert.equal(hostile.bootstrapRetries,0);assert.equal(hostile.resetState,null);assert.equal(hostile.resetProblem,null);assert.equal(hostile.retryInSeconds,60);
 const twice=clean(valid);assert.equal(twice.retryInSeconds,valid.retryInSeconds);assert.equal(twice.discoveryResets,4);
});

test('room and source report states use strict enums and aggregate availability bounds',()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;runInContext(code,ctx);
 const report=ctx.SameEndInviteCheck.cleanReport({joining:{roomState:'suppliers-full',roomJoined:true,sourceState:'sharing',availability:{authenticatedPeers:99,rootedSuppliers:-1,fullSuppliers:2.8,eligibleSuppliers:0,unrootedPeers:4,lastReject:'capacity-full',peerId:'PRIVATE-ID'}}});
 assert.equal(report.joining.roomState,'suppliers-full');assert.equal(report.joining.roomJoined,true);assert.equal(report.joining.sourceState,'sharing');assert.deepEqual({...report.joining.availability},{authenticatedPeers:12,rootedSuppliers:0,fullSuppliers:null,eligibleSuppliers:0,unrootedPeers:4,lastReject:'capacity-full'});assert(!JSON.stringify(report).includes('PRIVATE-ID'));
 const hostile=ctx.SameEndInviteCheck.cleanReport({joining:{roomState:'PRIVATE-STATE',roomJoined:'yes',sourceState:'PRIVATE-SOURCE',availability:{authenticatedPeers:Infinity,lastReject:'PRIVATE-REASON'}}});
 assert.equal(hostile.joining.roomState,null);assert.equal(hostile.joining.roomJoined,null);assert.equal(hostile.joining.sourceState,null);assert.deepEqual({...hostile.joining.availability},{authenticatedPeers:null,rootedSuppliers:null,fullSuppliers:null,eligibleSuppliers:null,unrootedPeers:null,lastReject:null});assert(!JSON.stringify(hostile).includes('PRIVATE'));
});

test('live report state comes from shared room explanation and social source state',()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:'',onLine:true},location:{hash:''},document:{visibilityState:'visible',getElementById(){return null},createElement(){return {canPlayType:()=>''}}},addEventListener(){}});ctx.window=ctx;ctx.PrivateCast={snapshot:()=>({role:'viewer',config:{delay:60},transport:{availability:{authenticatedPeers:1,rootedSuppliers:1,fullSuppliers:1,eligibleSuppliers:0,unrootedPeers:0,lastReject:'capacity-full'}}})};ctx.SameEndSocial={snapshot:()=>({connected:true,roomSource:{state:'sharing',fresh:true},member:'PRIVATE-ID'})};let got;ctx.SameEndRoomStatus={explain:input=>{got=input;return {code:'suppliers-full',roomJoined:true,title:'Suppliers are full',detail:'Waiting for a local route.',tone:'warning',waiting:false};}};runInContext(code,ctx);
 const report=ctx.SameEndInviteCheck.report(),text=JSON.stringify(report);assert.equal(report.joining.roomState,'suppliers-full');assert.equal(report.joining.roomJoined,true);assert.equal(report.joining.sourceState,'sharing');assert.equal(report.joining.availability.fullSuppliers,1);assert.equal(got.room.connected,true);assert.equal(got.pictureMoving,false);assert(!text.includes('PRIVATE-ID'));
});

test('adaptive invitation report round-trip bounds actual lag and exposes only safe phase and counts',()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;runInContext(code,ctx);
 const joining={extraDelaySeconds:125,adaptivePhase:'suspended',bufferGoalSeconds:8,rebufferCount:3,adaptiveSeekCount:1,privateKey:'PRIVATE-ADAPTIVE'};
 const report=ctx.SameEndInviteCheck.cleanReport({joining}),twice=ctx.SameEndInviteCheck.cleanReport(report);
 assert.equal(twice.joining.extraDelaySeconds,125);assert.equal(twice.joining.adaptivePhase,'suspended');assert.equal(twice.joining.bufferGoalSeconds,8);assert.equal(twice.joining.rebufferCount,3);assert(!JSON.stringify(twice).includes('PRIVATE-ADAPTIVE'));
 const hostile=ctx.SameEndInviteCheck.cleanReport({joining:{extraDelaySeconds:1e9,adaptivePhase:'PRIVATE-PHASE',bufferGoalSeconds:1e9,rebufferCount:Infinity,adaptiveSeekCount:-5}}).joining;
 assert.equal(hostile.extraDelaySeconds,86400);assert.equal(hostile.adaptivePhase,null);assert.equal(hostile.bufferGoalSeconds,30);assert.equal(hostile.rebufferCount,null);assert.equal(hostile.adaptiveSeekCount,0);
 const legacy=ctx.SameEndInviteCheck.cleanReport({}).joining;assert.equal(legacy.extraDelaySeconds,null);assert.equal(legacy.adaptivePhase,null);
});

test('intentional adaptive buffer waits avoid generic stall failures while source loss and decode errors remain visible',()=>{
 const failures=[],wall=Date.now(),S={active:true,kind:'screen',started:wall-90000,connectedAt:wall-90000,lastAdvance:wall-60000,lastTime:0,hasPicture:true,picture:true,failure:null};
 const snap={config:{epoch:wall-180000,delay:10},clockReady:true,offset:0,role:'viewer',sourceReachable:true,playbackAdaptivePhase:'rebuffering',peers:[{ready:true,state:'connected'}]};
 const ctx=createContext({S,Date,Math,Number,document:{visibilityState:'visible'},completed:true,$:()=>({readyState:0,paused:true}),roomContext:()=>({}),explainRoom:()=>({code:'buffering',roomJoined:true}),fail:value=>failures.push(value),clearProblem(){throw Error('critical failure must not be cleared');},render(){},mark(){}});ctx.window={PrivateCast:{snapshot:()=>snap}};
 const from=code.indexOf('  function observe(){'),to=code.indexOf('  async function sendToHost()',from);runInContext(code.slice(from,to),ctx);
 for(const phase of ['starting','rebuffering','recovering']){snap.playbackAdaptivePhase=phase;ctx.observe();}assert.deepEqual(failures,[]);
 snap.playbackAdaptivePhase='playing';ctx.observe();assert.deepEqual(failures,['picture-stalled']);failures.length=0;
 snap.playbackAdaptivePhase='rebuffering';snap.sourceReachable=false;ctx.observe();assert.deepEqual(failures,['picture-stalled']);failures.length=0;
 snap.sourceReachable=true;S.failure='video-decode';ctx.observe();assert.equal(S.failure,'video-decode');assert.deepEqual(failures,[]);
});

test('a descriptor without a connected source clock does not claim a scheduled group wait',()=>{
 const wall=Date.now(),S={active:true,kind:'screen',started:wall-1000,connectedAt:null,lastAdvance:0,lastTime:null,hasPicture:false,picture:false,failure:null,phase:'finding-room'};
 const snap={config:{epoch:wall-300000,delay:300},role:'viewer',clockReady:false,sourceReachable:false,commonStart:{enabled:true,state:'pending'},peers:[]};const marks=[];
 const ctx=createContext({S,Date,Math,Number,document:{visibilityState:'visible'},completed:false,$:()=>({readyState:0,paused:true}),roomContext:()=>({}),explainRoom:()=>({code:'suppliers-full',roomJoined:true}),fail(){throw Error('capacity wait is not a generic failure');},clearProblem(){},render(){},mark:name=>marks.push(name)});ctx.window={PrivateCast:{snapshot:()=>snap}};
 const from=code.indexOf('  function observe(){'),to=code.indexOf('  async function sendToHost()',from);runInContext(code.slice(from,to),ctx);
 ctx.observe();assert.equal(S.phase,'finding-room');assert(!marks.includes('group-wait-start'));
 snap.clockReady=true;snap.sourceReachable=true;snap.peers=[{ready:true,state:'connected'}];ctx.observe();assert.equal(S.phase,'waiting-for-group');assert(marks.includes('group-wait-start'));
});

test('authenticated adaptive recovery clears stale picture overlays but preserves real failures and history',()=>{
 const wall=Date.now(),S={active:true,kind:'screen',started:wall-90000,connectedAt:wall-90000,lastAdvance:wall-60000,lastTime:0,hasPicture:true,picture:true,failure:null,failures:['picture-stalled']};
 const snap={config:{epoch:wall-180000,delay:10},clockReady:true,offset:0,role:'viewer',sourceReachable:true,playbackAdaptivePhase:'recovering',peers:[{ready:true,state:'connected'}]};let cleared=0,rendered=0;
 const ctx=createContext({S,Date,Math,Number,document:{visibilityState:'visible'},completed:true,$:()=>({readyState:0,paused:true}),roomContext:()=>({}),explainRoom:()=>({code:'buffering',roomJoined:true}),fail:value=>{S.failure=value;},clearProblem(){cleared++;S.failure=null;},render(){rendered++;},mark(){}});ctx.window={PrivateCast:{snapshot:()=>snap},SameEndSocial:{snapshot:()=>({connected:false})}};
 const from=code.indexOf('  function observe(){'),to=code.indexOf('  async function sendToHost()',from);runInContext(code.slice(from,to),ctx);
 for(const failure of ['picture-stalled','picture-unavailable','connection-slow']){S.failure=failure;ctx.observe();assert.equal(S.failure,null);}assert.equal(cleared,3);assert.equal(rendered,3);assert.deepEqual(S.failures,['picture-stalled'],'historical evidence is preserved');
 for(const failure of ['video-decode','playback-blocked','chat-unavailable','browser-feature','invitation-incomplete','app-error']){S.failure=failure;ctx.observe();assert.equal(S.failure,failure);}assert.equal(cleared,3);
 S.failure='picture-stalled';snap.sourceReachable=false;ctx.observe();assert.equal(S.failure,'picture-stalled');
 snap.sourceReachable=true;snap.peers[0].ready=false;ctx.observe();assert.equal(S.failure,'picture-stalled','an unauthenticated route is insufficient');
 snap.peers[0].ready=true;snap.clockReady=false;ctx.observe();assert.equal(S.failure,'picture-stalled','unconfirmed source time is insufficient');
});

test('client delivery is safely retained through the opt-in host report round trip',async()=>{
 const core=await readFile(new URL('../diagnostics-core.js',import.meta.url),'utf8');
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;runInContext(core,ctx);runInContext(code,ctx);
 const cd={state:'observing',confidence:'medium',classification:'live',capacityKnown:false,sourceBitrateBps:1000000,deliveredGoodputBps:1200000,reserveSeconds:290,baselineDelaySeconds:300,baselineReserveFraction:290/300,recommendation:{status:'unvalidated-candidate',reason:'observed-live-age-plus-gap-reserve',candidateInitialDelaySeconds:10,candidateReserveSeconds:6,applied:false,validated:false,extraDelayFixesSustainedDeficit:false},url:'PRIVATE-CLIENT',peer:'PRIVATE-CLIENT',sdp:'PRIVATE-CLIENT'};
 const once=ctx.SameEndInviteCheck.cleanReport({joining:{clientDelivery:cd}}),twice=ctx.SameEndInviteCheck.cleanReport(once);assert.equal(twice.joining.clientDelivery.deliveredGoodputBps,1200000);assert.equal(twice.joining.clientDelivery.baselineReserveFraction,290/300);assert.equal(twice.joining.clientDelivery.recommendation.applied,false);assert.equal(twice.joining.clientDelivery.capacityKnown,false);assert(!JSON.stringify(twice).includes('PRIVATE-CLIENT'));
 const hostile=ctx.SameEndInviteCheck.cleanReport({joining:{clientDelivery:{...cd,recommendation:{status:'PRIVATE-CLIENT',reason:'PRIVATE-CLIENT',applied:true,candidateInitialDelaySeconds:0}}}}).joining.clientDelivery;assert.equal(hostile.recommendation.status,null);assert.equal(hostile.recommendation.reason,null);assert.equal(hostile.recommendation.applied,null);assert.equal(hostile.recommendation.candidateInitialDelaySeconds,null);
 assert.equal(ctx.SameEndInviteCheck.cleanReport({}).joining.clientDelivery,null);
});


test('common start survives repeated host report cleaning with no private decision data',async()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:''},location:{hash:''},document:{getElementById(){return null}},addEventListener(){}});ctx.window=ctx;
 runInContext(await readFile(new URL('../diagnostics-core.js',import.meta.url),'utf8'),ctx);runInContext(code,ctx);
 const input={joining:{groupDelaySeconds:30,commonStart:{enabled:true,state:'selected',delaySeconds:30,reserveSeconds:6,reason:'verified-delivery',conflict:false,fallbackDelaySeconds:300,decisionId:'PRIVATE-ID',issuedAt:123456}},testSession:{reportId:'0123456789abcdef',lastStatus:{commonStart:{enabled:true,state:'fallback',delaySeconds:300,reason:'observation-timeout',fallbackDelaySeconds:300,decisionId:'PRIVATE-ID'}}}};
 const report=ctx.SameEndInviteCheck.cleanReport(ctx.SameEndInviteCheck.cleanReport(input));
 assert.equal(report.joining.groupDelaySeconds,30);assert.equal(report.joining.commonStart.delaySeconds,30);assert.equal(report.testSession.lastStatus.commonStart.delaySeconds,300);assert(!JSON.stringify(report).includes('PRIVATE-ID'));assert(!JSON.stringify(report).includes('issuedAt'));
 const bad=ctx.SameEndInviteCheck.cleanReport({joining:{commonStart:{state:'PRIVATE',delaySeconds:29,reserveSeconds:Infinity,reason:'PRIVATE'}}}).joining.commonStart;
 assert.equal(bad.state,null);assert.equal(bad.delaySeconds,null);assert.equal(bad.reserveSeconds,null);assert.equal(bad.reason,null);
});


test('route reports distinguish measured relay, direct and unavailable evidence',()=>{
 const ctx=createContext({URLSearchParams,Uint8Array,Date,Math,JSON,setTimeout(){},setInterval(){},navigator:{userAgent:'',onLine:true},location:{hash:''},document:{visibilityState:'visible',getElementById(){return null},createElement(){return {canPlayType:()=>''}}},addEventListener(){}});ctx.window=ctx;
 let network={selectedRoute:'relay',localCandidateType:'relay',remoteCandidateType:'host',relayConfigured:false,fallbackState:'connected',address:'PRIVATE-IP'};ctx.PrivateCast={snapshot:()=>({network})};runInContext(code,ctx);
 let j=ctx.SameEndInviteCheck.report().joining;assert.equal(j.connectionMode,'relay');assert.equal(j.relayFallbackConfigured,null);assert.equal(j.relayOfferConfigured,false);assert.equal(j.network.localCandidateType,'relay');assert(!JSON.stringify(j).includes('PRIVATE-IP'));
 network={selectedRoute:'direct',localCandidateType:'srflx',remoteCandidateType:'host',relayConfigured:true};j=ctx.SameEndInviteCheck.report().joining;assert.equal(j.connectionMode,'direct');assert.equal(j.relayFallbackConfigured,null);assert.equal(j.relayOfferConfigured,true);
 network={selectedRoute:'PRIVATE-ROUTE',localCandidateType:'PRIVATE-CANDIDATE'};j=ctx.SameEndInviteCheck.report().joining;assert.equal(j.connectionMode,'unknown');assert.equal(j.relayFallbackConfigured,null);assert.equal(j.network.localCandidateType,null);assert(!JSON.stringify(j).includes('PRIVATE'));
});
