import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const source=await readFile(new URL('../media-player.js',import.meta.url),'utf8');
const MiB=1024*1024, epoch=1700000000000;

function selection(supported,playable=supported){
  const recorder={isTypeSupported:m=>supported.includes(m)};
  const context=createContext({window:{MediaRecorder:recorder},MediaRecorder:recorder,document:{createElement:()=>({canPlayType:m=>playable.includes(m)?'probably':''})}});
  runInContext(source,context);return context.window.SameEndMedia;
}
test('recording prefers resize-safe in-band H264 with AAC and keeps older-host alternatives',()=>{
  const modern='video/mp4;codecs=avc3.42001f,mp4a.40.2',legacy='video/mp4;codecs=avc1.42001f,mp4a.40.2';
  assert.equal(selection([legacy,modern]).recordingMime(true),modern);
  assert.equal(selection([legacy]).recordingMime(true),legacy);
  assert.equal(selection([legacy,modern],[legacy]).recordingMime(true),legacy,'encoding support alone must not select an unplayable format');
  assert.equal(selection(['video/webm;codecs=vp8,opus']).recordingMime(true),'video/webm;codecs=vp8,opus');
  assert.equal(selection([]).recordingMime(true),null);
  assert.equal(selection([]).allowedMime(legacy),true,'old room invitations remain accepted');
});
test('video-only source selects in-band H264 without inventing an audio track',()=>{
  const modern='video/mp4;codecs=avc3.42001f',legacy='video/mp4;codecs=avc1.42001f';
  assert.equal(selection([modern,legacy]).recordingMime(false),modern);
  assert.equal(selection([legacy]).recordingMime(false),legacy);
});
test('native Apple compatibility changes only declared MP4 labels on a copy, never signed media payloads',()=>{
  const media=selection([]),box=(type,payload)=>{const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length);b.write(type,4);payload.copy(b,8);return b;};
  const header=Buffer.alloc(8);header.writeUInt32BE(1,4);
  const sample=box('avc3',Buffer.from('configuration'));
  let moov=box('stsd',Buffer.concat([header,sample]));for(const type of ['stbl','minf','mdia','trak','moov'])moov=box(type,moov);
  const original=Buffer.concat([box('ftyp',Buffer.from('isom0000avc3')),moov,box('mdat',Buffer.from('avc3 encoded media unchanged'))]),saved=Buffer.from(original);
  const converted=Buffer.from(media.nativeMP4(original));assert(original.equals(saved));
  assert(converted.includes(Buffer.from('avc1')));assert(converted.includes(Buffer.from('avc3 encoded media unchanged')));assert.equal(converted.length,original.length);
  const truncated=original.subarray(0,original.length-1);assert.equal(media.nativeMP4(truncated),truncated,'malformed containers must remain untouched');
});

function harness(){
  class Events{
    constructor(){this.handlers=new Map();}
    addEventListener(name,fn){const handlers=this.handlers.get(name)||[];handlers.push(fn);this.handlers.set(name,handlers);}
    removeEventListener(name,fn){this.handlers.set(name,(this.handlers.get(name)||[]).filter(handler=>handler!==fn));}
    emit(name){for(const fn of this.handlers.get(name)||[])fn();}
  }
  class Buffer extends Events{
    constructor(){super();this.updating=false;this.buffered={length:0};this.appended=[];}
    appendBuffer(bytes){assert.equal(this.updating,false);this.appended.push(new DataView(bytes).getUint32(0));this.updating=true;}
    complete(){this.updating=false;this.emit('updateend');}
  }
  class ManagedSource extends Events{
    static isTypeSupported(){return true;}
    addSourceBuffer(){this.buffer=new Buffer();return this.buffer;}
  }
  const video=Object.assign(new Events(),{
    currentTime:0,readyState:4,paused:true,buffered:{length:0},
    canPlayType:()=> 'probably',setAttribute(){},removeAttribute(){this.src=null;},load(){},
    pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}
  });
  let clock=10000,nextURL=0;
  const liveURLs=new Set();
  const context=createContext({window:{ManagedMediaSource:ManagedSource},document:{createElement:()=>video},
    Blob,Date:{now:()=>clock},setTimeout:()=>1,clearTimeout(){},
    URL:{createObjectURL(){const url='blob:test/'+(++nextURL);liveURLs.add(url);return url;},revokeObjectURL(url){liveURLs.delete(url);}}});
  runInContext(source,context);
  const player=new context.window.SameEndMedia.Player(video,'video/mp4');
  const managed=player.source;managed.emit('sourceopen');managed.emit('endstreaming');
  return {player,video,managed,liveURLs,tick(){clock+=1300;},drain(){
    managed.emit('startstreaming');let remaining=30;
    while(player.sb?.updating&&remaining-->0)player.sb.complete();
    assert(remaining>0,'resuming demand must drain a bounded queue');
  }};
}

function piece(seq,size=4096){
  const buf=new ArrayBuffer(size);new DataView(buf).setUint32(0,seq);
  return {meta:{seq,start:epoch+seq*2000,duration:2000},buf};
}

function assertBounded(player){
  // Both owners must release full buffers, rather than only reducing a statistic.
  const pieceBytes=player.pieces.reduce((n,p)=>n+p.buf.byteLength,0);
  const queueBytes=player.queue.reduce((n,p)=>n+p.buf.byteLength,0);
  assert(player.pieces.length<=24,'playback cache grows while the browser refuses media');
  assert(player.queue.length<=20,'pending appends grow while streaming demand is stopped');
  assert(pieceBytes<=20*MiB,'playback cache exceeds its memory allowance');
  assert(queueBytes<=20*MiB,'pending appends retain more than their memory allowance');
  assert.equal(player.pieceBytes,pieceBytes,'playback cache accounting diverges from retained buffers');
  assert.equal(player.queueBytes,queueBytes,'append accounting diverges from retained buffers');
}

test('decoded programme position maps compatibility clip time and never reports a desired target as playout',()=>{
  const h=harness(),{player,video}=h;
  video.currentTime=7.25;assert.equal(player.programTime(),7.25);
  player.enqueue(piece(9),epoch);player.fallback('test');player.sync(18.2);
  video.currentTime=.25;assert.equal(player.programTime(),18.25);
  video.readyState=0;assert.equal(player.programTime(),null);
  player.close();assert.equal(player.programTime(),null);
});

test('fallback preserves a coded decoder cause without retaining raw browser errors',()=>{
  const {player,video}=harness();
  assert.equal(player.fallbackReason,null);
  video.error={code:3,message:'private browser error details'};video.emit('error');
  assert.equal(player.mode,'clips');assert.equal(player.fallbackReason,'decode-error');assert.equal(player.mediaErrorCode,3);
  assert.equal(Object.values(player).includes(video.error.message),false);
  player.close();
});

test('MSE bridges a short captured-media gap without pausing, while a real missing range still waits',()=>{
  const {player,video}=harness();
  const ranges=[[0,1.94],[2.05,4]];
  video.buffered={length:ranges.length,start:i=>ranges[i][0],end:i=>ranges[i][1]};
  video.currentTime=1.94;video.paused=false;
  assert.equal(player.sync(2).waiting,false);assert.equal(video.paused,false);
  assert(Math.abs(video.currentTime-2.051)<.001);assert.equal(player.programTime(),video.currentTime);
  assert(Math.abs(player.programTime()-2)<.15,'gap handling must retain bounded programme-clock drift');
  assert.equal(player.sync(3.99).waiting,false,'do not pause forty milliseconds before a buffered piece ends');
  ranges[1][0]=2.4;video.currentTime=1.94;
  assert.equal(player.sync(2).waiting,true);assert.equal(video.paused,true,'network/media gaps cannot be hidden');
  player.close();
});

test('suspended streaming stays bounded through 1000 pieces and resumes at the current clock window',()=>{
  const h=harness(),{player,managed}=h;
  for(let seq=0;seq<1000;seq++){player.enqueue(piece(seq),epoch);assertBounded(player);}
  assert.equal(player.mode,'mse');assert.equal(player.demand,false);
  assert.equal(managed.buffer.appended.length,0,'endstreaming must stop decoder work');
  const target=1998.2,cutoff=epoch+target*1000-4000;
  assert.equal(player.sync(target).waiting,true);
  assert(player.queue.every(p=>p.meta.start+p.meta.duration>=cutoff),'resume must discard stale queued playback');
  assert(player.pieces.every(p=>p.meta.start+p.meta.duration>=cutoff),'resume must release stale compatibility buffers');
  h.drain();assert(managed.buffer.appended.includes(999),'the current source moment must remain playable after suspension');
  assert(managed.buffer.appended.every(seq=>seq>=997),'resuming must not replay the suspended backlog');
  assert.equal(player.queue.length,0);assertBounded(player);player.close();
});

test('maximum-size pieces cannot bypass memory bounds while decoder demand is stopped',()=>{
  const h=harness(),{player}=h;
  // 32 incoming maximum-size clips exercise the byte limit before the count limit.
  for(let seq=0;seq<32;seq++){player.enqueue(piece(seq,4*MiB),epoch);assertBounded(player);}
  assert(player.queue.length<20,'the byte limit must take effect before the count limit');
  assert(player.pieces.some(p=>p.meta.seq===31),'newly received media must survive pressure');
  player.sync(62.2);h.drain();assertBounded(player);
  assert.equal(player.queueBytes,0,'consuming queued buffers must release their byte accounting');
  player.close();assert.equal(player.pieceBytes,0);assert.equal(player.queueBytes,0);
});

test('browser eviction repairs from retained media without duplicate growth, and fallback/close release ownership',()=>{
  const h=harness(),{player,managed,liveURLs}=h;
  for(let seq=0;seq<10;seq++)player.enqueue(piece(seq,4*MiB),epoch);
  h.drain();assert.equal(player.queue.length,0);
  managed.emit('endstreaming');
  for(let i=0;i<1000;i++){h.tick();player.sync(18.2);assertBounded(player);}
  assert.equal(player.queue.length,1,'repeated eviction checks must not duplicate the repair');
  assert.equal(player.queue[0].meta.seq,9,'repair must use the piece at the source clock target');
  h.drain();assert.equal(player.queueBytes,0);
  managed.emit('endstreaming');h.tick();player.sync(18.2);
  player.fallback('test decoder failure');assert.equal(player.mode,'clips');
  assert.equal(player.queue.length,0);assert.equal(player.queueBytes,0);
  assert.equal(player.sync(18.2).waiting,false,'verified media must survive a streaming-buffer failure');
  assert(liveURLs.size>0,'compatibility playback should own a clip URL');
  player.close();assert.equal(liveURLs.size,0,'leaving must revoke every media URL');
  assert.equal(player.queue.length,0);assert.equal(player.pieces.length,0);
  assert.equal(player.queueBytes,0);assert.equal(player.pieceBytes,0);
  player.enqueue(piece(100),epoch);assert.equal(player.pieces.length,0,'a closed player must not retain new data');
});


test('fully cached native windows survive internal boundaries and piece pruning; a rejected window recovers once to original pieces',async()=>{
 const {make}=await import('./helpers/native-mp4-fixture.mjs');const native=await readFile(new URL('../native-mp4.js',import.meta.url),'utf8');
 const handlers=new Map();let loads=0,next=0;const live=new Set(),blobTypes=[];
 const video={currentTime:0,readyState:4,paused:true,buffered:{length:1,start:()=>0,end:()=>16},canPlayType:()=> 'probably',setAttribute(){},removeAttribute(){},load(){loads++;},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},addEventListener(n,f){handlers.set(n,f);},removeEventListener(n){handlers.delete(n);}};
 const context=createContext({window:{},document:{createElement:()=>video},Blob,Date,setTimeout:()=>0,clearTimeout(){},URL:{createObjectURL(blob){blobTypes.push(blob.type);const u='blob:'+ ++next;live.add(u);return u;},revokeObjectURL(u){live.delete(u);}}});runInContext(native,context);runInContext(source,context);const player=new context.window.SameEndMedia.Player(video,'video/mp4');
 const inputs=Array.from({length:8},(_,seq)=>({meta:{seq,start:epoch+seq*2000,duration:2000},buf:make({swap:seq%2===1})}));for(const p of inputs)player.enqueue(p,epoch);
 for(let n=0;n<12;n++){video.currentTime=n+.1;assert.equal(player.sync(n+.1).waiting,false);}
 assert.equal(blobTypes[0],'video/mp4','native file MIME must stay container-only on older iPads');assert.equal(video.playbackRate,1,'native Apple playback must keep normal speed to preserve sound');assert.equal(loads,1,'internal two-second boundaries must not replace the source');assert.equal(player.facts().mode,'native-window');assert.equal(player.programTime(),11.1);assert(!player.pieces.some(p=>p.meta.seq===0),'test actually pruned the first source piece');
 video.error={code:3};handlers.get('error')();assert.equal(player.nativeJoinDisabled,true);assert.equal(player.nativeWindow,null);video.currentTime=.1;player.sync(12.1);assert.equal(player.facts().mode,'clips');assert.equal(player.facts().packagingReason,'decode');assert.equal(loads,3,'one clear plus one original-piece retry');player.close();assert.equal(live.size,0,'all window and piece URLs released');
});

test('audible autoplay refusal preserves muted picture and remembers sound permission until a direct retry succeeds',async()=>{const {player,video}=harness();let permitted=false;video.muted=true;video.play=function(){if(!this.muted&&!permitted)return Promise.reject(Object.assign(new Error('private permission details'),{name:'NotAllowedError'}));this.paused=false;return Promise.resolve()};await assert.rejects(player.requestSound(),{name:'NotAllowedError'});await Promise.resolve();assert.equal(video.muted,true);assert.equal(video.paused,false);assert.equal(player.soundBlocked,true);await player.play();assert.equal(player.soundBlocked,true,'muted success cannot claim audible permission');assert.equal(player.facts().playError,null);permitted=true;await player.requestSound();assert.equal(video.muted,false);assert.equal(player.soundBlocked,false);assert.equal(player.soundRequested,true);player.muteSound();assert.equal(video.muted,true);assert.equal(player.soundBlocked,false);player.close();});
