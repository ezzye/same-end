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

function harness(overrides = {}) {
  const sent = [];
  const state = {
    config:{id:'cast-1',epoch:nowValue-60000,delay:10,mime:'video/webm',segmentVersion:2,sourceId:'source-1',sourceEpoch:0,programId:'match-1'},
    stopped:false,pub:keyPair.publicKey,seen:new Set(),cache:[],cacheBytes:0,received:0,
    offset:125,clockReady:false,peers:new Map(),sourceReachable:true,role:'viewer',
    recovery:{state:'idle'}, ...overrides
  };
  const window = {};
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
    ['function receipt(', 'function resumeAfter()'],
    ['function resumeAfter()', 'function maintainDelivery()'],
    ['function maintainDelivery()', 'const enc='],
    ['function relayLimit()', 'function verifiedReserve()'],
    ['function cleanCache()', 'async function acceptSegment('],
    ['async function acceptSegment(', 'async function waitBuffer(']
  ]) vm.runInContext(sliceBetween(start,end),ctx);
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
