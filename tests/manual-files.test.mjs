import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const engine=await readFile(new URL('../engine.js',import.meta.url),'utf8');
const slice=(from,to)=>engine.slice(engine.indexOf(from),engine.indexOf(to,engine.indexOf(from)));
function setup({failure,wait=false,actualGather=false}={}){
 const elements=new Map(),timers=[];let allocations=0,opened=0,resolveGather;
 const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:'',disabled:false,attrs:{},setAttribute(k,v){this.attrs[k]=v},classList:{items:new Set(),add(x){this.items.add(x)},remove(x){this.items.delete(x)},toggle(x,yes){yes?this.items.add(x):this.items.delete(x)}}});return elements.get(id)};
 const state={config:{id:'same-cast'},clockReady:true,stopped:false,role:'viewer',peers:new Map(),trail:[],nodeId:'self',lastReceivedAt:1000};
 const pc={iceGatheringState:'gathering',createDataChannel(){return {}},async createOffer(){if(failure)throw Error(failure);return {type:'offer',sdp:'synthetic'}},async setLocalDescription(s){this.localDescription={toJSON:()=>s}},addEventListener(){},removeEventListener(){}};
 const ctx={state,Math,Number,Date,Map,Set,Promise,Error,crypto:{randomUUID:()=> 'manual-offer'},$:el,phoneLeaf:()=>false,resilient:()=>false,now:()=>1000,relayLimit:()=>2,label:()=> 'Synthetic',setTimeout(fn,ms){timers.push({fn,ms});return timers.length},clearTimeout(){},attach(){},status(){},
  makePeer(id,direction){allocations++;const p={id,direction,pc,timers:[],closed:false};state.peers.set(id,p);return p},dropPeer(p){p.closed=true;state.peers.delete(p.id)},
  gather:()=>wait?new Promise(r=>resolveGather=r):Promise.resolve(),setOut(obj,kind){opened++;state.out={obj,kind};el('outgoing').value=JSON.stringify(obj);el('outgoing-wrap').classList.remove('hidden')},update(){ctx.renderManualInvitation()}};
 vm.createContext(ctx);vm.runInContext(slice('function manualInvitationBlocked(','function validateOffer('),ctx);
 if(actualGather)vm.runInContext(slice('async function gather(pc){','function setOut('),ctx);
 return {ctx,state,el,pc,timers,counts:()=>({allocations,opened}),release:()=>resolveGather()};
}
test('an existing invitation reopens the same file without allocating another slot',async()=>{
 const h=setup();await h.ctx.makeInvite();const file=h.el('outgoing').value,offer=h.state.out.obj;h.el('outgoing-wrap').classList.add('hidden');
 h.ctx.renderManualInvitation();assert.equal(h.el('invite').disabled,false);assert.equal(h.el('invite').textContent,'Show invitation file');assert.equal(h.el('cancel-offer').classList.items.has('hidden'),false);
 await h.ctx.makeInvite();assert.equal(h.el('outgoing').value,file);assert.equal(h.state.out.obj,offer);assert.deepEqual(h.counts(),{allocations:1,opened:2});assert.equal(h.el('outgoing-wrap').classList.items.has('hidden'),false);
});
test('preparation remains disabled through maintenance updates and duplicate clicks',async()=>{
 const h=setup({wait:true}),pending=h.ctx.makeInvite();await flush();h.ctx.renderManualInvitation();assert.equal(h.el('invite').disabled,true);assert.match(h.el('manual-invite-status').textContent,/Preparing/);assert.equal(h.el('invite').attrs['aria-busy'],'true');
 await h.ctx.makeInvite();assert.equal(h.counts().allocations,1);h.release();await pending;assert.equal(h.el('invite').disabled,false);assert.equal(h.el('invite').attrs['aria-busy'],'false');
});
test('offer creation failure is visible beside the button and frees its pending peer',async()=>{
 const h=setup({failure:'Connection preparation failed'});await assert.rejects(h.ctx.makeInvite(),/preparation failed/);assert.match(h.el('manual-invite-status').textContent,/Could not make.*preparation failed/);assert.equal(h.state.peers.size,0);assert.equal(h.state.manualInviteAttempt,null);assert.equal(h.el('invite').disabled,false);
});
test('the real discovery timeout is displayed locally and a later try remains possible',async()=>{
 const h=setup({actualGather:true}),pending=h.ctx.makeInvite();await flush();const timeout=h.timers.find(t=>t.ms===12000);assert(timeout);timeout.fn();await assert.rejects(pending,/discovery timed out/);assert.match(h.el('manual-invite-status').textContent,/discovery timed out/);assert.equal(h.state.peers.size,0);assert.equal(h.el('invite').disabled,false);
});
test('leaving during preparation cannot resurrect a file or error in a new cast',async()=>{
 const h=setup({wait:true}),pending=h.ctx.makeInvite();await flush();h.state.config={id:'new-cast'};h.state.manualInviteAttempt=null;h.state.manualInviteMessage='';h.release();await pending;assert.equal(h.counts().opened,0);assert.equal(h.state.pendingOffer,undefined);assert.equal(h.state.manualInviteMessage,'');
});
test('a full sender retains its admission limit with a visible explanation',()=>{
 const h=setup();h.state.peers.set('a',{direction:'down'});h.state.peers.set('b',{direction:'down'});h.ctx.renderManualInvitation();assert.equal(h.el('invite').disabled,true);assert.match(h.el('manual-invite-status').textContent,/slots.*in use/);assert.equal(h.counts().allocations,0);
});

test('losing a free slot during discovery cannot publish a new invitation',async()=>{
 const h=setup({wait:true}),pending=h.ctx.makeInvite();await flush();h.ctx.relayLimit=()=>1;h.state.peers.set('existing',{id:'existing',direction:'down'});h.release();await assert.rejects(pending,/slots.*in use/);assert.equal(h.counts().opened,0);assert.equal(h.state.peers.has('manual-offer'),false);assert.equal(h.state.peers.has('existing'),true);
});

function fileHarness(){
 const fields=new Map();const el=id=>{if(!fields.has(id))fields.set(id,{value:'',textContent:'',scrollIntoView(){this.scrolled=true}});return fields.get(id)};
 const state={pending:null};let reject=true,reads=0;
 const ctx={state,$:el,Error,String,readIncoming:async()=>{reads++;if(reject)throw Error('Leave your current cast before accepting another invitation.');state.pending={type:'offer'}}};vm.createContext(ctx);vm.runInContext(slice('async function readConnectionFile(e){','async function readIncoming(){'),ctx);
 const file={size:40,text:async()=> 'synthetic offer'},input={files:[file],value:'same-file.castinvite'};
 return {ctx,state,input,el,allow:()=>reject=false,reads:()=>reads};
}
test('a rejected import clears the selected file and reports the error next to the picker',async()=>{
 const h=fileHarness();await assert.rejects(h.ctx.readConnectionFile({target:h.input}),/Leave your current cast/);assert.equal(h.input.value,'');assert.match(h.el('manual-file-status').textContent,/Could not open.*Leave your current cast/);assert.equal(h.state.pending,null);
});
test('the same file can be selected again after the failed cast has been left',async()=>{
 const h=fileHarness();await assert.rejects(h.ctx.readConnectionFile({target:h.input}));h.allow();h.input.value='same-file.castinvite';await h.ctx.readConnectionFile({target:h.input});assert.equal(h.reads(),2);assert.equal(h.input.value,'');assert.match(h.el('manual-file-status').textContent,/Invitation opened/);assert.equal(h.el('confirm').scrolled,true);
});
test('size and read failures also clear the selection for another attempt',async()=>{
 const h=fileHarness();h.input.files=[{size:100001,text:()=>{throw Error('must not read')}}];await assert.rejects(h.ctx.readConnectionFile({target:h.input}),/too large/);assert.equal(h.input.value,'');h.input.value='unreadable.castinvite';h.input.files=[{size:10,text:async()=>{throw Error('File could not be read')}}];await assert.rejects(h.ctx.readConnectionFile({target:h.input}),/could not be read/);assert.equal(h.input.value,'');assert.equal(h.reads(),0);
});
