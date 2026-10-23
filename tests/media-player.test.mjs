import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const source=await readFile(new URL('../media-player.js',import.meta.url),'utf8');
const MiB=1024*1024, epoch=1700000000000;

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
