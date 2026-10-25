import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {encodeBundle,decodeBundle} from '../hls-protocol.js';

const engine = await readFile(new URL('../engine.js', import.meta.url), 'utf8');
const deliveryCode = await readFile(new URL('../delivery-health.js', import.meta.url), 'utf8');
const enc = new TextEncoder();
const nowValue = 1700000000000;
const keyPair = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);

function sliceBetween(start, end) {
  const from = engine.indexOf(start);
  const to = engine.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `could not find engine source slice ${start}`);
  return engine.slice(from, to).trim();
}

function harness(overrides = {}, Estimator = null, InitialDelayPolicy = null) {
  const sent = [];
  const state = {
    config:{id:'cast-1',epoch:nowValue-60000,delay:10,mime:'video/webm',segmentVersion:2,sourceId:'source-1',sourceEpoch:0,programId:'match-1'},
    stopped:false,pub:keyPair.publicKey,seen:new Set(),cache:[],cacheBytes:0,received:0,
    offset:125,clockReady:false,peers:new Map(),sourceReachable:true,role:'viewer',
    recovery:{state:'idle'}, ...overrides
  };
  const window = Estimator ? {SameEndClientDelivery:{Estimator}} : {};
  if(InitialDelayPolicy){window.SameEndInitialDelay={Policy:InitialDelayPolicy};window.SameEndConfig={automaticInitialDelay:true};}
  const ctx = {
    window, state, sent, SameEndHLS:{decodeBundle}, crypto:webcrypto, enc, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    Number, Math, JSON, Set, Map, Promise, Error, Date, Buffer,
    btoa:value=>Buffer.from(value,'binary').toString('base64'),
    atob:value=>Buffer.from(value,'base64').toString('binary'),
    performance:{now:()=>nowValue},
    now:()=>nowValue, MAX_CLIP:4*1024*1024, MAX_CACHE:192*1024*1024,
    SameEndDelivery:window.SameEndDelivery,
    log:()=>{}, update:()=>{}, lifecycle:()=>{ctx.lifecycleCount=(ctx.lifecycleCount||0)+1}, stageWindow:()=>{}, renderDelivery:()=>{},verifiedReserve:()=>5,
    cleanCache:()=>{},
    send:(peer,message)=>sent.push({peer,message}),
    downstream:()=>[...state.peers.values()].filter(p=>p.direction==='down'&&!p.closed),
    lastMaintenance:0, relayLimitOverride:null, stallOutgoing:null,
    magnetTransport:null
  };
  vm.createContext(ctx);
  vm.runInContext(deliveryCode,ctx);
  ctx.SameEndDelivery=ctx.window.SameEndDelivery;
  const b64Line=engine.split('\n').find(line=>line.startsWith('const b64='));
  const un64Line=engine.split('\n').find(line=>line.startsWith('const un64='));
  const canonicalLine=engine.split('\n').find(line=>line.startsWith('const canonical='));
  const identityLine=engine.split('\n').find(line=>line.startsWith('const segmentKey='));
  const hashLine=engine.split('\n').find(line=>line.startsWith('const hash='));
  for (const line of [b64Line,un64Line,canonicalLine,identityLine,hashLine]) assert.ok(line);
  vm.runInContext([
    engine.split('\n').find(line=>line.startsWith('function isHlsConfig(')),
    b64Line.replace('const b64=','globalThis.b64='),
    un64Line.replace('const un64=','globalThis.un64='),
    canonicalLine.replace('const canonical=','globalThis.canonical='),
    identityLine.replace('const segmentKey=','globalThis.segmentKey='),
    hashLine.replace('const hash=','globalThis.hash=')
  ].join('\n'),ctx);
  for (const [start,end] of [
    ['function resetClientDelivery()', 'function deliverySnapshot()'],
    ['function receipt(', 'function resumeAfter()'],
    ['function resumeAfter()', 'function maintainDelivery()'],
    ['function maintainDelivery()', 'const enc='],
    ['function relayLimit()', 'function verifiedReserve()'],
    ['function cleanCache()', 'async function acceptSegment('],
    ['async function acceptSegment(', 'async function waitBuffer(']
  ]) vm.runInContext(sliceBetween(start,end),ctx);
  ctx.resetClientDelivery();
  return {ctx,state,sent};
}

async function signedPiece(ctx,{seq=1,start=nowValue,duration=2000,bytes=new Uint8Array([1,2,3,4])}={}) {
  const buf=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const meta={v:2,cast:'cast-1',sourceId:'source-1',sourceEpoch:0,programId:'match-1',programStartTime:start-ctx.state.config.epoch,alignmentVersion:1,seq,start,duration,size:buf.byteLength,mime:ctx.state.config.mime,hash:await ctx.hash(buf)};
  meta.sig=ctx.b64(new Uint8Array(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keyPair.privateKey,enc.encode(ctx.canonical(meta)))));
  return {meta,buf};
}

test('receipt is emitted only after digest and source signature validation; legacy peers receive none',async()=>{
  const {ctx,state,sent}=harness();
  const sourcePeer={deliveryVersion:1,highestSeq:-1};
  const valid=await signedPiece(ctx,{});
  const invalid={...valid,meta:{...valid.meta,sig:'invalid'}};
  await assert.rejects(()=>ctx.acceptSegment(invalid.meta,invalid.buf,sourcePeer));
  const corrupt=new Uint8Array(valid.buf.slice(0));
  corrupt[0]^=0xff;
  await assert.rejects(()=>ctx.acceptSegment(valid.meta,corrupt.buffer,sourcePeer));
  const moved=await signedPiece(ctx,{seq:3,start:nowValue+4000});
  moved.meta.programStartTime+=0.5; // within alignment tolerance, but outside the signed position
  await assert.rejects(()=>ctx.acceptSegment(moved.meta,moved.buf,sourcePeer));
  assert.equal(state.cache.length,0);
  assert.equal(sent.length,0);
  await ctx.acceptSegment(valid.meta,valid.buf,sourcePeer);
  assert.equal(state.cache.length,1);
  assert.equal(sent.length,1);
  assert.equal(sent[0].message.type,'delivery-receipt');
  assert.equal(sent[0].message.seq,valid.meta.seq);

  const legacy=await signedPiece(ctx,{seq:2,start:nowValue+2000});
  await ctx.acceptSegment(legacy.meta,legacy.buf,{deliveryVersion:0,highestSeq:1});
  assert.equal(state.cache.length,2);
  assert.equal(sent.length,1);
});

test('out-of-order signed pieces repair gaps in sorted order without false progress; duplicates do not grow cache',async()=>{
  const {ctx,state}=harness();
  const supplier={deliveryVersion:0,highestSeq:-1,lastProgressAt:nowValue-5000,lastVerifiedAt:nowValue-5000};
  const newer=await signedPiece(ctx,{seq:9,start:nowValue});
  await ctx.acceptSegment(newer.meta,newer.buf,supplier);
  const count=state.cache.length, bytes=state.cacheBytes, progress=supplier.lastProgressAt;
  await ctx.acceptSegment(newer.meta,newer.buf,supplier);
  assert.equal(state.cache.length,count);
  assert.equal(state.cacheBytes,bytes);
  const older=await signedPiece(ctx,{seq:8,start:nowValue-2000});
  await ctx.acceptSegment(older.meta,older.buf,supplier);
  assert.equal(state.cache.length,count+1,'a verified missing piece is retained for repair');
  assert.deepEqual(state.cache.map(piece=>piece.meta.seq),[8,9]);
  assert.equal(supplier.highestSeq,9);
  assert.equal(supplier.lastProgressAt,progress);
  await ctx.acceptSegment(older.meta,older.buf,supplier);
  assert.equal(state.cache.length,count+1,'the repaired piece remains deduplicated');
  assert.equal(supplier.highestSeq,9);
  assert.equal(supplier.lastProgressAt,progress);
  assert.equal(state.offset,125);
});

test('resumeAfter selects only the highest contiguous recent cached sequence before the first gap',()=>{
  const {ctx,state}=harness();
  const target=nowValue+state.offset-state.config.delay*1000-4000;
  state.cache=[
    {meta:{seq:0,start:nowValue-5*60*1000,duration:2000}},
    {meta:{seq:1,start:target-1000,duration:2000}},
    {meta:{seq:2,start:target+1000,duration:2000}},
    {meta:{seq:90,start:target+1500,duration:1000}},
  ];
  assert.equal(ctx.resumeAfter(),2);
  state.cache=[{meta:{seq:7,start:target+1000,duration:2000}}];
  assert.equal(ctx.resumeAfter(),-1,'future cache cannot certify the missing play point');
});

test('concurrent replacement and old-supplier verification cannot retain the same signed piece twice',async()=>{
  const {ctx,state,sent}=harness();
  const piece=await signedPiece(ctx,{seq:4});
  await Promise.all([ctx.acceptSegment(piece.meta,piece.buf,{deliveryVersion:1,highestSeq:-1}),ctx.acceptSegment(piece.meta,piece.buf,{deliveryVersion:1,highestSeq:-1})]);
  assert.equal(state.cache.length,1);assert.equal(state.cacheBytes,piece.buf.byteLength);
  assert.equal(state.received,1);assert.equal(sent.length,1);
});

test('relay limit never exceeds two and falls to current child count under measured queue/receipt congestion',()=>{
  const {ctx,state}=harness();
  state.peers.set('a',{id:'a',direction:'down',queued:0,closed:false});
  state.peers.set('b',{id:'b',direction:'down',queued:0,closed:false});
  state.peers.set('c',{id:'c',direction:'down',queued:0,closed:false});
  assert.equal(ctx.relayLimit(),2);
  state.peers.get('a').queued=2*1024*1024+1;
  assert.equal(ctx.relayLimit(),2);
  state.peers.delete('c');
  assert.equal(ctx.relayLimit(),2);
  state.peers.delete('b');
  assert.equal(ctx.relayLimit(),1);
  state.peers.get('a').queued=0;
  state.peers.get('a').deliveryVersion=1;
  state.peers.get('a').meter=new ctx.SameEndDelivery.Meter(()=>nowValue);
  state.peers.get('a').meter.sent({seq:1,hash:'piece',size:10},nowValue-12000);
  assert.equal(state.peers.get('a').meter.snapshot(nowValue).health,'congested');
  assert.equal(ctx.relayLimit(),1);
});

test('supplier recovery preserves epoch, delay and offset; quiet with recent verified progress does not recover',()=>{
  const {ctx,state}=harness();
  const before={epoch:state.config.epoch,delay:state.config.delay,offset:state.offset};
  const parent={direction:'up',closed:false,ready:true,connectedAt:nowValue-20000,lastControlAt:nowValue,lastProgressAt:nowValue-1000,lastVerifiedAt:nowValue-1000};
  state.peers.set('parent',parent);
  let recoveries=0,reason;
  ctx.magnetTransport={recoverSupplier(value){recoveries++;reason=value;return true;}};
  ctx.maintainDelivery();
  assert.equal(recoveries,0,'track/source quiet alone cannot classify a recent-progress connection as stalled');
  parent.lastProgressAt=nowValue-13000;
  ctx.maintainDelivery();
  assert.equal(recoveries,1);
  assert.equal(reason,'source-progress-stalled');
  assert.deepEqual({epoch:state.config.epoch,delay:state.config.delay,offset:state.offset},before);
});

test('a buffered downstream gives its responsive parent bounded recovery priority without hiding a dead connection',()=>{
  const {ctx,state}=harness({trail:['source','relay']});ctx.verifiedReserve=()=>60;
  const parent={direction:'up',ready:true,connectedAt:nowValue-60000,lastControlAt:nowValue,lastProgressAt:nowValue-13000,lastVerifiedAt:nowValue-13000};state.peers.set('parent',parent);
  let calls=0;ctx.magnetTransport={recoverSupplier(){calls++;return true;}};
  ctx.maintainDelivery();assert.equal(calls,0);assert.equal(state.supplierHealth,'upstream-recovering');
  parent.lastProgressAt=nowValue-17000;ctx.maintainDelivery();assert.equal(calls,1,'depth grace must expire');
  state.sourceReachable=false;parent.pathLostAt=null;ctx.maintainDelivery();assert.equal(calls,1,'new root loss grants a bounded repair interval');
  parent.pathLostAt=nowValue-16000;ctx.maintainDelivery();assert.equal(calls,2,'root-loss grace must expire');
  parent.pathLostAt=nowValue;parent.lastControlAt=nowValue-13000;ctx.maintainDelivery();assert.equal(calls,3,'unresponsive control bypasses repair grace');
  state.sourceReachable=true;parent.lastControlAt=nowValue;parent.lastProgressAt=nowValue-13000;ctx.verifiedReserve=()=>5;ctx.maintainDelivery();assert.equal(calls,4,'a shallow reserve cannot defer recovery');
});

test('viewer can change only its local player without replacing the cast, clock or peer connections',()=>{
 const calls=[],config={id:'room',epoch:1,delay:300},peers=new Map(),state={role:'viewer',config,offset:40,clockReady:true,peers,player:{mode:'mse',nativeMime:'video/mp4',fallback(message,reason){calls.push(reason);this.mode='clips'}}};
 const ctx={state,Error,stageWindow:()=>calls.push('stage'),syncPlayback:()=>calls.push('sync'),status:()=>{},update:()=>{}};vm.createContext(ctx);vm.runInContext(sliceBetween('function useAlternativePlayer(){','function download('),ctx);ctx.useAlternativePlayer();
 assert.deepEqual(calls,['manual-compatibility','stage','sync']);assert.equal(state.config,config);assert.equal(state.offset,40);assert.equal(state.peers,peers);assert.equal(state.clockReady,true);
 state.player.mode='mse';state.role='source';assert.throws(()=>ctx.useAlternativePlayer());assert.equal(state.player.mode,'mse');
});

test('HLS transport preserves short final intervals and rejects signed envelope timeline mismatch before accounting',async()=>{
 const {ctx,state,sent}=harness();Object.assign(state.config,{mime:'application/vnd.apple.mpegurl',mediaProfile:'hls-cmaf-v1'});
 const buf=encodeBundle({start:60,duration:.042667,playlistStart:60,files:[{path:'master.m3u8',mime:'application/vnd.apple.mpegurl',bytes:enc.encode('#EXTM3U\n')}]});
 const piece=await signedPiece(ctx,{bytes:new Uint8Array(buf),duration:42.667});
 const mismatch={...piece,meta:{...piece.meta,programStartTime:61000,start:nowValue+1000}};
 mismatch.meta.sig=ctx.b64(new Uint8Array(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keyPair.privateKey,enc.encode(ctx.canonical(mismatch.meta)))));
 await assert.rejects(()=>ctx.acceptSegment(mismatch.meta,piece.buf,{deliveryVersion:1}),/signed programme interval/);
 assert.equal(state.received,0);assert.equal(state.seen.size,0);assert.equal(state.cacheBytes,0);assert.equal(sent.length,0);
 await ctx.acceptSegment(piece.meta,piece.buf,{deliveryVersion:1,highestSeq:-1});assert.equal(state.received,1);assert.equal(state.cache.length,1);assert.equal(sent.length,1);
});


test('authenticated first hello reveals chat once and duplicate hellos do not repeat lifecycle',async()=>{
 const {ctx:h}=harness();vm.runInContext(sliceBetween('async function handleControl(', 'function dropPeer('),h);const p={direction:'up',ready:false,lastControlAt:0};await h.handleControl(p,{type:'hello',cast:'cast-1',label:'Generated peer'});assert.equal(p.ready,true);assert.equal(h.lifecycleCount,1);await h.handleControl(p,{type:'hello',cast:'cast-1'});assert.equal(h.lifecycleCount,1);
});

test('adaptive HLS stages, reserves, and resumes the earlier effective window while forwarding per child',()=>{
 const {ctx,state}=harness({clockReady:true,appendedSeq:new Set(),lastAppendSeq:-1});
 Object.assign(state.config,{mime:'application/vnd.apple.mpegurl',mediaProfile:'hls-cmaf-v1',epoch:nowValue-180000});
 const nominal=ctx.nominalProgramTime(),effective=nominal-60,appended=[],forwarded=[];
 ctx.document={visibilityState:'visible'};ctx.enqueue=(peer,piece)=>forwarded.push([peer.id,piece.meta.seq]);
 state.player={getPlaybackTarget:()=>effective,setPlaybackWindow:t=>assert.equal(t,nominal),enqueue:piece=>appended.push(piece.meta.seq)};
 const origin=state.config.epoch+effective*1000;
 state.cache=[{meta:{seq:1,start:origin-4000,duration:4000},buf:new ArrayBuffer(1)},{meta:{seq:2,start:origin,duration:2000},buf:new ArrayBuffer(1)},{meta:{seq:3,start:origin+2000,duration:2000},buf:new ArrayBuffer(1)},{meta:{seq:30,start:state.config.epoch+nominal*1000,duration:2000},buf:new ArrayBuffer(1)}];
 state.cacheBytes=4;
 state.peers.set('lagging',{id:'lagging',direction:'down',ready:true,queued:0,lastSentSeq:-1,playbackLagSeconds:60});
 state.peers.set('legacy',{id:'legacy',direction:'down',ready:true,queued:0,lastSentSeq:-1});
 vm.runInContext(sliceBetween('function stageWindow()', 'function syncPlayback()'),ctx);ctx.stageWindow();
 assert.deepEqual(appended,[1,2,3]);assert.deepEqual(forwarded,[['lagging',1],['lagging',2],['legacy',30]]);
 assert.equal(ctx.nominalProgramTime(),nominal);assert.equal(ctx.effectiveProgramTime(),effective);
 assert.equal(ctx.resumeAfter(),3,'resume is contiguous from the effective playback floor');
 vm.runInContext(sliceBetween('function verifiedReserve()', 'function mediaDiagnostics()'),ctx);
 assert.equal(ctx.verifiedReserve(),4);
 ctx.stageWindow();assert.equal(forwarded.filter(([id,seq])=>id==='lagging'&&seq===1).length,1,'old history is queued once');
 state.player.getPlaybackTarget=()=>nominal-900;assert.equal(ctx.effectiveProgramTime(),nominal-60);
 assert.equal(ctx.effectiveProgramTime(-4),-4,'negative nominal warmup is preserved');
 state.config.mime='video/webm';delete state.config.mediaProfile;assert.equal(ctx.effectiveProgramTime(),nominal);
});

test('child lag hints are HLS-only, bounded, and repeated hello does not rewind sent history',async()=>{
 const {ctx,state}=harness();Object.assign(state.config,{mime:'application/vnd.apple.mpegurl',mediaProfile:'hls-cmaf-v1'});
 vm.runInContext(sliceBetween('async function handleControl(', 'function dropPeer('),ctx);
 const peer={direction:'down',ready:false,lastSentSeq:-1};
 await ctx.handleControl(peer,{type:'hello',cast:'cast-1',deliveryVersion:1,playbackLagSeconds:1e9,resumeAfter:4});assert.equal(peer.playbackLagSeconds,60);assert.equal(peer.lastSentSeq,4);
 peer.lastSentSeq=90;await ctx.handleControl(peer,{type:'hello',cast:'cast-1',deliveryVersion:1,playbackLagSeconds:1e9,resumeAfter:-1});assert.equal(peer.lastSentSeq,90);
 for(const value of [Infinity,NaN,'60',{},-1])assert.equal(ctx.boundedPlaybackLag(value),0);
 state.config.mime='video/webm';assert.equal(ctx.boundedPlaybackLag(60),0);
 const legacy={direction:'down',ready:false,lastSentSeq:-1};await ctx.handleControl(legacy,{type:'hello',cast:'cast-1',resumeAfter:7});assert.equal(legacy.playbackLagSeconds,0);assert.equal(legacy.lastSentSeq,-1);
});

test('HLS signed replay extends only the bounded age floor and preserves source signatures and memory ceiling',async()=>{
 const {ctx,state}=harness();Object.assign(state.config,{mime:'application/vnd.apple.mpegurl',mediaProfile:'hls-cmaf-v1',epoch:nowValue-180000});
 const bundle=start=>new Uint8Array(encodeBundle({start,duration:2,playlistStart:start,files:[{path:'master.m3u8',mime:'application/vnd.apple.mpegurl',bytes:enc.encode('#EXTM3U\n')}]}));
 const valid=await signedPiece(ctx,{seq:1,start:nowValue-80000,bytes:bundle(100)});
 await ctx.acceptSegment(valid.meta,valid.buf,{deliveryVersion:0,highestSeq:-1});assert.equal(state.cache.length,1);
 const expired=await signedPiece(ctx,{seq:2,start:nowValue-110000,bytes:bundle(70)});await ctx.acceptSegment(expired.meta,expired.buf,null);assert.equal(state.cache.length,1);
 const forged=await signedPiece(ctx,{seq:3,start:nowValue-78000,bytes:bundle(102)});forged.meta.sig='forged';await assert.rejects(()=>ctx.acceptSegment(forged.meta,forged.buf,null));assert.equal(state.cache.length,1);
 state.cacheBytes=ctx.MAX_CACHE+1;ctx.cleanCache();assert.equal(state.cache.length,0,'192 MiB limit still wins over longer replay');
 state.config.mime='video/webm';delete state.config.mediaProfile;assert.equal(ctx.retentionCutoff(),nowValue+state.offset-40000);
});

test('expanding child lag replays only newly earlier media and retains the live production watermark',async()=>{
 const {ctx,state}=harness({clockReady:true,appendedSeq:new Set(),lastAppendSeq:-1});
 Object.assign(state.config,{mime:'application/vnd.apple.mpegurl',mediaProfile:'hls-cmaf-v1',epoch:nowValue-180000});
 const nominalMs=state.config.epoch+ctx.nominalProgramTime()*1000,forwarded=[];
 ctx.document={visibilityState:'visible'};ctx.enqueue=(peer,piece)=>forwarded.push(piece.meta.seq);
 state.cache=[0,1,2,3].map((seq)=>({meta:{seq,start:nominalMs+[-20000,-10000,-6000,0][seq],duration:2000},buf:new ArrayBuffer(1)}));state.cacheBytes=4;
 const peer={direction:'down',ready:true,queued:0,lastSentSeq:3,playbackLagSeconds:0};state.peers.set('child',peer);
 vm.runInContext(sliceBetween('async function handleControl(', 'function dropPeer('),ctx);vm.runInContext(sliceBetween('function stageWindow()', 'function syncPlayback()'),ctx);
 await ctx.handleControl(peer,{type:'hello',cast:'cast-1',deliveryVersion:1,playbackLagSeconds:10,resumeAfter:-1});ctx.stageWindow();ctx.stageWindow();
 assert.deepEqual(forwarded,[1,2]);assert.equal(peer.lastSentSeq,3);
 await ctx.handleControl(peer,{type:'hello',cast:'cast-1',deliveryVersion:1,playbackLagSeconds:20,resumeAfter:-1});ctx.stageWindow();ctx.stageWindow();
 assert.deepEqual(forwarded,[1,2,0]);assert.equal(peer.lastSentSeq,3,'replay does not masquerade as new source progress');
});


class ClientEstimatorSpy {
 constructor(now){this.now=now;this.observations=[];this.samples=[];this.resets=0;}
 observe(value){this.observations.push(value);}
 sample(value){this.samples.push(value);return this.snapshot();}
 resetRoute(){this.resets++;}
 snapshot(){return {state:'warming',confidence:'none',observations:this.observations.length};}
}

test('client observations require verified unique upstream media and use local receive timestamps',async()=>{
 const {ctx,state}=harness({clockReady:true},ClientEstimatorSpy),meter=state.clientDelivery;
 const supplier={id:'up',direction:'up',deliveryVersion:0,highestSeq:-1};state.peers.set('up',supplier);state.supplier={id:'up'};
 const piece=await signedPiece(ctx,{});
 const forged={...piece.meta,sig:'invalid'};
 await assert.rejects(()=>ctx.acceptSegment(forged,piece.buf,supplier,nowValue-100));assert.equal(meter.observations.length,0);
 await ctx.acceptSegment(piece.meta,piece.buf,supplier,nowValue-100);
 assert.equal(meter.observations.length,1);
 assert.deepEqual({...meter.observations[0]},{seq:1,size:4,durationMs:2000,programStartMs:nowValue,receiveStartedAtMs:nowValue-100,verifiedAtMs:nowValue,sourceNowMs:nowValue+125});
 await ctx.acceptSegment(piece.meta,piece.buf,supplier,nowValue-50);assert.equal(meter.observations.length,1,'replays never count twice');
 const local=await signedPiece(ctx,{seq:2});await ctx.acceptSegment(local.meta,local.buf,null,nowValue-100);assert.equal(meter.observations.length,1,'locally produced bytes are not network delivery');
 const noTiming=await signedPiece(ctx,{seq:3});noTiming.meta.receiveStartedAtMs=nowValue-100000;await ctx.acceptSegment(noTiming.meta,noTiming.buf,supplier);assert.equal(meter.observations.length,1,'sender metadata cannot invent receive timing');
 const closed=await signedPiece(ctx,{seq:4});supplier.closed=true;await ctx.acceptSegment(closed.meta,closed.buf,supplier,nowValue-10);assert.equal(meter.observations.length,1,'old closed suppliers cannot contaminate replacement-route estimates');
});

test('client estimator is optional for legacy harnesses and is recreated per cast; sources have none',()=>{
 const legacy=harness();assert.equal(legacy.ctx.clientDeliverySnapshot(),null);legacy.ctx.maintainDelivery();
 const {ctx,state}=harness({},ClientEstimatorSpy),previous=state.clientDelivery;
 ctx.resetClientDelivery();assert.notEqual(state.clientDelivery,previous);assert.equal(state.clientDeliverySourceEndMs,null);assert.equal(state.clientDeliveryRoute,null);
 state.role='source';ctx.resetClientDelivery();assert.equal(state.clientDelivery,null);assert.equal(ctx.clientDeliverySnapshot(),null);
 assert.match(engine,/state\.config=config;state\.role=role;resetClientDelivery\(\)/,'cast initialization owns a fresh estimator');
});

test('client samples keep reserve, decoder headroom, signed source age and route confidence separate',()=>{
 const {ctx,state}=harness({clockReady:true,playbackStarted:true,supplier:{id:'relay'},trail:['source','relay']},ClientEstimatorSpy),meter=state.clientDelivery;
 ctx.document={visibilityState:'visible'};ctx.navigator={onLine:true};ctx.$=()=>({paused:false});state.player={facts:()=>({playableAheadSeconds:3,extraDelaySeconds:7})};state.clientDeliverySourceEndMs=nowValue-1000;
 ctx.maintainDelivery();const sample=meter.samples.at(-1);
 assert.deepEqual({...sample},{nowMs:nowValue,baselineDelaySeconds:10,reserveSeconds:5,decoderAheadSeconds:3,extraDelaySeconds:7,visible:true,online:true,clockReady:true,sourceReachable:true,playing:true,sourceAgeSeconds:1.125});
 assert.equal(meter.resets,0);ctx.sampleClientDelivery();assert.equal(meter.resets,0,'routine samples retain confidence');
 state.trail=['source','new-parent','relay'];ctx.sampleClientDelivery();assert.equal(meter.resets,1,'changed path resets even with same immediate supplier');
 state.sourceReachable=false;ctx.sampleClientDelivery();assert.equal(meter.resets,2,'route loss clears confidence immediately');
 state.sourceReachable=true;state.supplier={id:'replacement'};ctx.sampleClientDelivery();assert.equal(meter.resets,3);
 ctx.document.visibilityState='hidden';ctx.navigator.onLine=false;ctx.sampleClientDelivery();assert.equal(meter.samples.at(-1).visible,false);assert.equal(meter.samples.at(-1).online,false);
 state.clockReady=false;ctx.sampleClientDelivery();assert.equal(meter.samples.at(-1).sourceAgeSeconds,null);
});

test('incoming header records the local start outside sender metadata and binary assembly retains it',async()=>{
 const {ctx}=harness();vm.runInContext(sliceBetween('async function handleControl(', 'function dropPeer('),ctx);
 const peer={id:'up',direction:'up',ready:true};await ctx.handleControl(peer,{type:'segment',meta:{size:4,receiveStartedAtMs:7}});
 assert.equal(peer.incoming.receiveStartedAtMs,nowValue);assert.equal(peer.incoming.meta.receiveStartedAtMs,7);
 assert.match(engine,/acceptSegment\(a\.meta,joined\.buffer,p,a\.receiveStartedAtMs\)/,'assembled verified bytes retain the locally observed header time');
});


test('handover credits only the active supplier while retaining valid unique pieces from other open upstreams',async()=>{
 const {ctx,state}=harness({clockReady:true},ClientEstimatorSpy),meter=state.clientDelivery;
 const oldPeer={id:'old',direction:'up',deliveryVersion:1,highestSeq:-1},activePeer={id:'magnet:new',nodeId:'new',direction:'up',deliveryVersion:1,highestSeq:-1};
 state.peers.set(oldPeer.id,oldPeer);state.peers.set(activePeer.id,activePeer);state.supplier={id:'old'};
 const first=await signedPiece(ctx,{seq:1});await ctx.acceptSegment(first.meta,first.buf,oldPeer,nowValue-100);assert.equal(meter.observations.length,1);
 state.supplier={id:'new'};ctx.sampleClientDelivery();assert.equal(meter.resets,1);
 const oldUnique=await signedPiece(ctx,{seq:2});await ctx.acceptSegment(oldUnique.meta,oldUnique.buf,oldPeer,nowValue-100);
 assert.equal(state.cache.length,2,'old-route media remains available for playback and forwarding');assert.equal(meter.observations.length,1,'an open old supplier cannot credit the new route');
 const replacement=await signedPiece(ctx,{seq:3});await ctx.acceptSegment(replacement.meta,replacement.buf,activePeer,nowValue-100);
 assert.equal(meter.observations.length,2,'magnet supplier node identity matches its prefixed peer-map entry');assert.equal(meter.observations.at(-1).seq,3);
 state.supplier=null;const unassigned=await signedPiece(ctx,{seq:4});await ctx.acceptSegment(unassigned.meta,unassigned.buf,activePeer,nowValue-100);
 assert.equal(state.cache.length,4);assert.equal(meter.observations.length,2,'no active supplier means no attributed rate observation');
});


test('client reserve remains unknown during countdown and becomes measurable at programme time zero',()=>{
 const {ctx,state}=harness({clockReady:true},ClientEstimatorSpy),meter=state.clientDelivery;
 state.config.delay=300;state.config.epoch=nowValue+state.offset-299000;state.player={facts:()=>({playableAheadSeconds:4})};ctx.verifiedReserve=()=>0;
 ctx.sampleClientDelivery();assert.equal(ctx.effectiveProgramTime(),-1);assert.equal(meter.samples.at(-1).reserveSeconds,null,'countdown is not evidence of an empty playpoint reserve');assert.equal(meter.samples.at(-1).decoderAheadSeconds,4);
 state.config.epoch-=1000;ctx.sampleClientDelivery();assert.equal(ctx.effectiveProgramTime(),0);assert.equal(meter.samples.at(-1).reserveSeconds,0,'a real empty playpoint remains measured zero');
 state.clockReady=false;ctx.sampleClientDelivery();assert.equal(meter.samples.at(-1).reserveSeconds,null,'unclocked reserve is unknown');
});

test('viewer startup commits locally while room clock, retention, signatures and child forwarding stay nominal',async()=>{
 const holder={};vm.runInNewContext(await readFile(new URL('../initial-delay.js',import.meta.url),'utf8'),{window:holder,isFinite,Math});
 const config={id:'cast-1',epoch:nowValue-400000,delay:300,mime:'application/vnd.apple.mpegurl',mediaProfile:'hls-cmaf-v1'};
 const {ctx,state}=harness({config,clockReady:true,supplier:{id:'relay'},appendedSeq:new Set()},null,holder.SameEndInitialDelay.Policy);
 ctx.document={visibilityState:'visible'};ctx.navigator={onLine:true};const video={muted:true};ctx.$=()=>video;
 ctx.sampleClientDelivery=()=>({state:'observing',classification:'live',recordCount:11,observationSeconds:20,lastProgressAgeSeconds:0,gapP95Seconds:2,deliveryToStreamRatio:.968,sourceAgeTrendSecondsPerSecond:0,recommendation:{status:'unvalidated-candidate',candidateInitialDelaySeconds:9,candidateReserveSeconds:6}});
 const windows=[],prepared=[],forwarded=[];let position=null;
 state.player={adaptive:{everPlayed:false},setPlaybackWindow:t=>windows.push(t),lookAheadSeconds:()=>16,getPlaybackTarget:nominal=>position??nominal,programTime:()=>position,
 prepareStartup(target){prepared.push(target);position=target;return{programTime:target,minimumReserveSeconds:4,ready:true,aligned:true,cacheAheadSeconds:12,decoderAheadSeconds:12}},commitStartup:()=>true};
 vm.runInContext(sliceBetween('function stageWindow()', 'function syncPlayback()'),ctx);
 const before={nominal:ctx.nominalProgramTime(),cutoff:ctx.retentionCutoff(),offset:state.offset,config:JSON.stringify(config)};
 ctx.advanceInitialDelay();assert.equal(state.initialDelayPolicy.state,'committed');assert.equal(state.initialDelayPolicy.selectedDelaySeconds,9);
 assert.equal(ctx.viewerProgramTime()-ctx.nominalProgramTime(),291);assert.equal(ctx.effectiveProgramTime(),position);assert.equal(ctx.initialDelaySnapshot().commitCount,1);
 assert.equal(ctx.nominalProgramTime(),before.nominal);assert.equal(ctx.retentionCutoff(),before.cutoff);assert.equal(state.offset,before.offset);assert.equal(JSON.stringify(config),before.config);
 const meta={seq:1,start:config.epoch+before.nominal*1000,duration:2000};state.cache=[{meta,buf:new ArrayBuffer(1)}];state.peers.set('child',{direction:'down',ready:true,queued:0,lastSentSeq:-1});ctx.enqueue=(peer,piece)=>forwarded.push(piece);
 ctx.stageWindow();assert.equal(forwarded[0].meta,meta,'old room-target media still forwards when this viewer watches newer media');
 assert(windows.at(-1)>before.nominal);ctx.advanceInitialDelay();assert.equal(state.initialDelayPolicy.commitCount,1);assert.equal(prepared.length,2);
 state.role='source';ctx.resetClientDelivery();assert.equal(state.initialDelayPolicy.state,'disabled');assert.equal(ctx.viewerProgramTime(),before.nominal);
});
