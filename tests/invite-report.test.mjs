import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{createContext,runInContext}from'node:vm';
const code=await readFile(new URL('../invite-check.js',import.meta.url),'utf8');
test('diagnostics report allowlists facts even when every underlying object contains secrets',()=>{
 const secret='PRIVATE_INVITE_KEY_DONT_EXPORT';const ctx=createContext({URLSearchParams,Blob,Uint8Array,Date,console,setInterval:()=>0,clearInterval(){},setTimeout:()=>0,clearTimeout(){},navigator:{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) Version/27.0 Mobile PRIVATE_INVITE_KEY_DONT_EXPORT Safari/604.1',onLine:true},location:{hash:''},document:{visibilityState:'visible',getElementById:()=>({muted:true}),createElement:()=>({canPlayType:()=> 'probably'})}});ctx.window=ctx;ctx.crypto={subtle:{}};ctx.isSecureContext=true;ctx.RTCPeerConnection=function(){};ctx.addEventListener=()=>{};ctx.SameEndConfig={buildId:secret};ctx.PrivateCast={snapshot:()=>({secret,url:'https://example.invalid/#owner='+secret,chat:secret,nodeId:secret,config:{id:secret,delay:300,epoch:1,audio:true},reserveSeconds:13.6,supplierHealth:'source-progress-stalled',recovery:{recoveries:2,private:secret},delivery:{private:secret},transport:{authenticatedPeers:2,availability:{authenticatedPeers:2,rootedSuppliers:1,fullSuppliers:1,eligibleSuppliers:0,unrootedPeers:1,lastReject:'capacity-full',peer:secret}},network:{phase:'finding-peers',problem:null,relayConfigured:false,trackerCount:2,stunServerCount:2,peerAttempts:4,ip:'192.0.2.123',candidate:'PRIVATE_INVITE_KEY_DONT_EXPORT'},role:'viewer',mime:'video/mp4;secret='+secret,playbackMode:'mse',clockReady:true,received:2,peers:[{id:secret,ip:'192.0.2.123',ready:true,state:'connected',label:secret}]})};
 runInContext(code,ctx);const report=ctx.SameEndInviteCheck.report(),text=JSON.stringify(report);assert(!text.includes(secret));for(const x of['192.0.2.123','example.invalid','#owner=','nodeId','sdp'])assert(!text.includes(x));assert.equal(report.build,'unknown');assert.equal(report.device.version,'27.0.1');assert.equal(report.joining.peerConnected,true);assert.equal(report.joining.groupDelaySeconds,300);assert.equal(report.joining.mediaFormat,'mp4');assert.equal(report.joining.verifiedReserveSeconds,14);assert.equal(report.joining.supplierHealth,'source-progress-stalled');assert.equal(report.joining.recoveries,2);assert.equal(report.joining.connectionMode,'direct-only');assert.equal(report.joining.relayFallbackConfigured,false);assert.equal(report.joining.authenticatedPeerCount,2);assert.deepEqual({...report.joining.availability},{authenticatedPeers:2,rootedSuppliers:1,fullSuppliers:1,eligibleSuppliers:0,unrootedPeers:1,lastReject:'capacity-full'});assert.equal(report.joining.roomState,null);assert.equal(report.joining.sourceState,null);assert.equal(report.joining.network.phase,'finding-peers');assert.equal(report.joining.network.peerAttempts,4);assert.equal(report.joining.network.relayConfigured,false);
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
