import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const code=await readFile(new URL('../engine.js',import.meta.url),'utf8');
const start=code.slice(code.indexOf("async function start(stream,"),code.indexOf('\nfunction record(){'));
const join=code.split('\n').find(x=>x.startsWith('async function joinMagnet('));
const approve=code.split('\n').find(x=>x.startsWith('async function approve('));
assert(start&&join&&approve);
function setup({joining=false}={}){
 let release,normalizes=0,closed=0,ends=0,cleanups=0,stops=0;
 const ready=new Promise(resolve=>{release=resolve;});
 const track={stop(){stops++;},addEventListener(){}};
 const stream={getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};
 const state={config:null,active:false,pending:{type:'offer'}};
 const context={state,startingCapture:false,magnetBusy:joining,captureNormalizer:null,captureStats:null,lastNetworkCheck:null,lastJoinLink:null,
  window:{SameEndCapture:{normalize(input){normalizes++;assert.equal(input,stream);return{stream,ready,close(){closed++;}};}}},
  SameEndMedia:{recordingMime:()=> 'video/mp4',canPlay:()=>true},crypto:{randomUUID:()=> 'source-id',subtle:{generateKey:async()=>({publicKey:{},privateKey:{}}),exportKey:async()=>({})}},
  now:()=>1700000000000,$:()=>({value:10}),checkPlatform(){},monitorSourceAudio(){},showSourcePreview(){},lifecycle(){},record(){},status(){},
  async init(config,role){if(state.config)throw Error('Another room is open');state.config=config;state.role=role;},
  async end(){ends++;state.active=false;state.config=null;}
 };
 vm.createContext(context);vm.runInContext([start,join,approve,'this.api={start,joinMagnet,approve};'].join('\n'),context);
 return{context,state,stream,release,start:()=>context.api.start(stream,()=>cleanups++),counts:()=>({normalizes,closed,ends,cleanups,stops})};
}
test('a join or invitation approval cannot replace a source awaiting its first converted frame',async()=>{
 const h=setup(),pending=h.start();
 assert.equal(h.context.startingCapture,true);assert.equal(h.state.config,null);
 await assert.rejects(h.context.api.joinMagnet('magnet:?test'),/still being prepared/);
 await assert.rejects(h.context.api.approve(),/still being prepared/);
 h.release();await pending;
 assert.equal(h.state.role,'source');assert.equal(h.state.active,true);assert.equal(h.context.startingCapture,false);
 assert.equal(h.counts().ends,0);assert.equal(h.counts().closed,0);
 h.state.demoCleanup();assert.equal(h.counts().closed,1);assert.equal(h.counts().cleanups,1);
});
test('capture cannot overtake an already pending magnet join',async()=>{
 const h=setup({joining:true});await assert.rejects(h.start(),/Leave your current cast/);
 assert.equal(h.counts().normalizes,0);assert.equal(h.counts().stops,1);assert.equal(h.counts().cleanups,1);assert.equal(h.counts().ends,0);assert.equal(h.state.config,null);
});
