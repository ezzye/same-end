import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../diagnostics-core.js', import.meta.url), 'utf8'); let randomByte=6;
function setup({storage, random=true}={}) {
  let wall=1792796400000, mono=0;
  const crypto=random?{getRandomValues(a){a.fill(++randomByte);return a;}}:undefined;
  const window={crypto,performance:{now:()=>mono}};
  vm.runInNewContext(source, {window,globalThis:window,Uint8Array,Math,Date,JSON});
  const c=new window.SameEndDiagnosticsCore.Collector({now:()=>wall,monotonic:()=>mono,storage,build:'abcdef1'});
  const config={id:'SECRET-CAST-123',delay:10};
  function observe(extra={},p={},env={}) { return c.observe({config,role:'viewer',programTime:4,drift:-1,sourceAudio:{status:'quiet'},recovery:{state:'idle'},...extra},p,env); }
  return {c,observe,advance(ms){wall+=ms;mono+=ms;}};
}
function memoryStorage(){const m=new Map();return {m,getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};}

test('exports only allowlisted values and excludes secrets from local report and summary',()=>{
  const {c,observe}=setup();observe({source:'https://secret.test/path',url:'https://secret.test',sourceId:'SOURCE-SECRET',supplier:'PEER-SECRET',key:'AUTH-SECRET'}, {user:'NAME',ua:'UA-SECRET'});
  c.appError('player-failed');c.mark('sound-heard');c.mark('https://secret.test');
  const serialized=JSON.stringify(c.report())+JSON.stringify(c.summary());
  for(const secret of ['SECRET-CAST','SOURCE-SECRET','PEER-SECRET','AUTH-SECRET','secret.test','NAME','UA-SECRET'])assert.equal(serialized.includes(secret),false);
  assert.equal(c.report().samples.length,1);assert.equal(c.report().events.some(e=>e.type==='mark'&&e.value==='sound-heard'),true);
  assert.equal(c.report().samples[0].sourceAudio,'quiet');
});

test('maps real delivery, peer queue, player ready state, and epoch timestamps safely',()=>{
  const {c,observe}=setup();observe({delivery:{measured:true,deliveredMbps:1.5,aggregateMbps:99,queue:99,relayLimit:2,peers:[{health:'congested',measured:true,pendingBytes:14,oldestPendingMs:12000}]},clockReady:true,offset:-20,peers:[{id:'PRIVATE-PEER',queued:100},{id:'PRIVATE-PEER2',queued:30}],supplier:{id:'PRIVATE-SUPPLIER'}} ,{ready:4,paused:false});
  const s=c.report();assert.equal(s.startedAt,1792796400000);assert.equal(s.samples[0].aggregateMbps,1.5);assert.equal(s.samples[0].queue,130);assert.equal(s.samples[0].peerCount,2);assert.equal(s.samples[0].clockOffsetMs,-20);assert.equal(s.samples[0].congestedChildren,1);assert.equal(s.samples[0].pendingBytes,14);assert.equal(s.samples[0].ready,4);assert.equal(JSON.stringify(s).includes('PRIVATE-'),false);
});

test('allows only coded playback diagnostics and round-trips them through restore',()=>{
  const storage=memoryStorage(),first=setup({storage});
  first.observe({playbackMode:'clips',playbackFallbackReason:'decode-error',mediaErrorCode:3},{droppedFrames:7});
  const status=first.c.report().status;
  assert.deepEqual([status.playbackMode,status.playbackFallbackReason,status.mediaErrorCode,status.droppedFrames],['clips','decode-error',3,7]);
  const restored=setup({storage}).c.report().status;
  assert.deepEqual([restored.playbackMode,restored.playbackFallbackReason,restored.mediaErrorCode,restored.droppedFrames],['clips','decode-error',3,7]);
  first.observe({playbackMode:'SECRET_MODE',playbackFallbackReason:'raw decoder error: TOKEN',mediaErrorCode:5,rawError:'RAW_SECRET'},{droppedFrames:-1});
  const serialized=JSON.stringify(first.c.report());
  for(const secret of ['SECRET_MODE','TOKEN','RAW_SECRET'])assert.equal(serialized.includes(secret),false);
  const latest=first.c.report().status;
  assert.deepEqual([latest.playbackMode,latest.playbackFallbackReason,latest.mediaErrorCode,latest.droppedFrames],[null,null,null,0]);
});

test('samples every five seconds, exposes gaps, and caps the two-hour history',()=>{
  const {c,observe,advance}=setup();observe();advance(5000);observe();advance(16000);observe();assert.equal(c.report().samples.length,3);assert.equal(c.report().samples[2].gapSeconds,11);
  for(let i=0;i<1500;i++){advance(5000);observe();}assert.equal(c.report().samples.length,1440);
});

test('bounds events and marks only fixed codes',()=>{const {c,observe}=setup();observe();for(let i=0;i<250;i++){c.mark('chat-ok');c.appError('render-error');}assert.equal(c.report().events.length,200);assert.equal(c.report().counts.marks,250);assert.equal(c.mark('person-name'),false);});

test('finish and reload preserve the last report and new cast identity starts a clean session',()=>{
  const storage=memoryStorage(),first=setup({storage});first.observe();first.advance(12000);first.observe();const prior=first.c.finish('left');
  const restored=setup({storage});assert.equal(restored.c.report().reportId,prior.reportId);assert.equal(restored.c.report().finish,'left');
  restored.observe({config:{id:'ANOTHER-SECRET',delay:30}});assert.notEqual(restored.c.report().reportId,prior.reportId);assert.equal(restored.c.report().samples.length,1);
  const reloaded=setup({storage});assert.equal(reloaded.c.report().finish,'interrupted');assert.equal(reloaded.c.report().endedAt,null);
});

test('interrupted recording is reported as interrupted and never treated as a clean finish',()=>{const storage=memoryStorage();setup({storage}).observe();const c=setup({storage}).c;assert.equal(c.report().finish,'interrupted');assert.equal(c.report().endedAt,null);});

test('tag validation, compact summary sanitizer, and summary byte limit',()=>{
  const {c,observe}=setup();observe();c.setCastTag('aabbccddeeff');assert.equal(c.summary().castTag,'aabbccddeeff');
  const clean=globalThis; // sanitizer is evaluated in the same isolated browser global below
  const w={};vm.runInNewContext(source,{window:w,globalThis:w,Uint8Array,Math,Date,JSON});
  const sanitize=w.SameEndDiagnosticsCore.cleanSummary(JSON.stringify({...c.summary(),extra:'AUTH',lastStatus:{url:'https://x',drift:3,playbackMode:'mse',playbackFallbackReason:'buffer-append',mediaErrorCode:4,droppedFrames:11,rawError:'RAW_SECRET'},events:[{type:'mark',value:'chat-ok'},{type:'mark',value:'private-name'}]}));
  assert.equal(sanitize.events.length,1);assert.equal(sanitize.lastStatus.drift,3);assert.equal('url' in sanitize.lastStatus,false);assert.deepEqual([sanitize.lastStatus.playbackMode,sanitize.lastStatus.playbackFallbackReason,sanitize.lastStatus.mediaErrorCode,sanitize.lastStatus.droppedFrames],['mse','buffer-append',4,11]);assert.equal('rawError' in sanitize.lastStatus,false);assert.ok(JSON.stringify(sanitize).length<=4096);assert.equal(clean,globalThis);
});

test('storage failures and quota exhaustion remain in memory and report failure',()=>{
  const failing={getItem(){throw Error('do not expose this message');},setItem(){throw Error('QUOTA_SECRET');},removeItem(){}};const {c,observe}=setup({storage:failing});observe();assert.equal(c.report().samples.length,1);assert.equal(c.report().persisted,false);assert.equal(JSON.stringify(c.report()).includes('QUOTA_SECRET'),false);
});

test('persistence is bounded and clear purges current and previous report',()=>{
  const storage=memoryStorage(),{c,observe,advance}=setup({storage});observe();for(let i=0;i<1440;i++){advance(5000);observe();}c.finish('ended');const raw=[...storage.m.values()][0];assert.ok(raw.length<=2*1024*1024);c.clear();assert.equal(storage.m.size,0);assert.equal(c.report(),null);
});


test('retains a full 90 minute history and final status across reload',()=>{
 const storage=memoryStorage(),{c,observe,advance}=setup({storage});observe();
 for(let i=0;i<1080;i++){advance(5000);observe({programTime:i});}
 c.mark('sound-heard');const report=c.report();assert.equal(report.samples.length,1081);assert.equal(report.samplesDropped,0);
 advance(1000);observe({programTime:1081});c.mark('picture-ok');
 const restored=setup({storage}).c.report();assert.equal(restored.finish,'interrupted');assert.equal(restored.status.programTime,1081);assert.equal(restored.samples.at(-1).programTime,1079);
 assert.equal(report.build,'abcdef1');
});

test('stopped logging can restart in the same cast without losing the prior report',()=>{
 const storage=memoryStorage(),{c,observe}=setup({storage});observe();const id=c.report().reportId;c.finish('recording-stopped');observe();
 assert.notEqual(c.report().reportId,id);const data=JSON.parse([...storage.m.values()][0]);assert.equal(data.last.reportId,id);assert.equal(data.last.finish,'recording-stopped');
});

test('retains sample and event truncation counts and actual watchdog reasons',()=>{
 const {c,observe,advance}=setup();observe();advance(5000);observe({recovery:{state:'searching',recoveries:1,reason:'supplier-unresponsive'}});
 assert(c.report().events.some(e=>e.value==='searching-1-supplier-unresponsive'));
 for(let i=0;i<1450;i++){advance(5000);observe();}for(let i=0;i<201;i++)c.mark('chat-ok');
 assert(c.report().samplesDropped>0);assert(c.report().eventsDropped>0);assert(c.report().events.every(e=>e.value));
});

test('sanitises structured media diagnostics and preserves older reports without inventing facts',()=>{
 const {c,observe}=setup();observe({role:'source',mediaDiagnostics:{capture:{width:1920,height:1080,frameRate:30,targetVideoMbps:4,actualMediaMbps:3.2,lastPieceAgeSeconds:2,recordingLatencyMs:80,sourceAudio:'sound',rawError:'RAW_SECRET',url:'https://SECRET.test'},delivery:{requiredPiecePresent:true,requiredPieceLeadMs:-120,verifiedReserveSeconds:8,token:'TOKEN_SECRET'},playback:{mode:'native-window',windowSeconds:5,srcChanges:2,width:1280,height:720,decodedFrames:30,errorCode:4,message:'ERROR_SECRET'}}});
 const status=c.report().status, text=JSON.stringify(c.report());
 assert.deepEqual([status.mediaDiagnostics.capture.actualMediaMbps,status.mediaDiagnostics.capture.recordingLatencyMs,status.mediaDiagnostics.delivery.requiredPieceLeadMs,status.mediaDiagnostics.playback.mode,status.mediaDiagnostics.playback.windowSeconds],[3.2,80,-120,'native-window',5]);
 for(const secret of ['RAW_SECRET','SECRET.test','TOKEN_SECRET','ERROR_SECRET'])assert.equal(text.includes(secret),false);
 assert.equal(status.mediaDiagnostics.playback.message,undefined);
 const viewer=setup();viewer.observe({mediaDiagnostics:{capture:{width:1920,lastPieceAgeSeconds:999}}});assert.equal(viewer.c.report().status.mediaDiagnostics.capture,null);
 const old={...c.report(),status:{role:'viewer',ready:4},samples:[{at:1,role:'viewer',ready:4}]};delete old.status.mediaDiagnostics;
 const w={};vm.runInNewContext(source,{window:w,globalThis:w,Uint8Array,Math,Date,JSON});
 const oldClean=w.SameEndDiagnosticsCore.cleanSummary({...c.summary(),lastStatus:old.status});
 assert.equal(oldClean.lastStatus.mediaDiagnostics,undefined);
});

test('assesses delivery, decoder, warmup, autoplay, stalled playback, source capture, and unknown separately',()=>{
 const w={};vm.runInNewContext(source,{window:w,globalThis:w,Uint8Array,Math,Date,JSON});
 const assess=w.SameEndDiagnosticsCore.assessMediaDiagnostics;
 const result=(status,samples=[])=>assess(status,samples);
 assert.equal(result({role:'viewer',targetProgramTime:0,mediaDiagnostics:{delivery:{requiredPiecePresent:false}}}).findings[0].code,'required-piece-missing');
 assert.equal(result({role:'viewer',targetProgramTime:-1,mediaDiagnostics:{delivery:{requiredPiecePresent:false}}}).state,'unknown');
 assert.equal(result({role:'viewer',ready:1,targetProgramTime:0,mediaDiagnostics:{delivery:{requiredPiecePresent:true}}}).findings[0].code,'decoder-startup-evidence');
 assert.equal(result({role:'viewer',ready:1,targetProgramTime:-1,mediaDiagnostics:{delivery:{requiredPiecePresent:true}}}).state,'unknown');
 assert.equal(result({role:'viewer',ready:4,playbackBlocked:true,mediaDiagnostics:{delivery:{requiredPiecePresent:true}}}).findings[0].code,'playback-blocked');
 assert.equal(result({role:'viewer',ready:1,targetProgramTime:0,playbackBlocked:true,mediaDiagnostics:{delivery:{requiredPiecePresent:true}}}).findings[0].code,'playback-blocked');
 assert.equal(result({role:'source',mediaDiagnostics:{capture:{lastPieceAgeSeconds:11}}}).findings[0].code,'source-piece-stale');
 assert.equal(result({role:'viewer',mediaDiagnostics:{capture:{lastPieceAgeSeconds:900}}}).state,'unknown');
 const prior={at:1000,targetProgramTime:2,programTime:5,decodedFrames:20,visible:true,paused:false,playbackBlocked:false,mediaDiagnostics:{delivery:{requiredPiecePresent:true},playback:{decodedFrames:20}}};
 const current={at:4000,targetProgramTime:5,programTime:5,decodedFrames:20,visible:true,paused:false,playbackBlocked:false,mediaDiagnostics:{delivery:{requiredPiecePresent:true},playback:{decodedFrames:20}}};
 assert.equal(result({role:'viewer'},[prior,current]).findings[0].code,'no-frame-growth');
 assert.equal(result({role:'viewer'},[prior,{...current,visible:false}]).findings.some(f=>f.code==='no-frame-growth'),false);
 assert.equal(result({role:'viewer'},[{...prior,paused:true},current]).findings.some(f=>f.code==='no-frame-growth'),false);
 assert.equal(result({role:'viewer'},[prior,{...current,at:2500}]).findings.some(f=>f.code==='no-frame-growth'),false);
 assert.equal(result({role:'viewer',mediaDiagnostics:{capture:{width:320,frameRate:5,targetVideoMbps:0.2,actualMediaMbps:0.1}}}).state,'unknown');
});
