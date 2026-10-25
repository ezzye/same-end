import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../engine.js',import.meta.url),'utf8');
const publish=source.slice(source.indexOf('async function makeMagnet(){'),source.indexOf('async function joinMagnet('));
function publication(){
 let resolve,closes=0,events=0;const pending=new Promise(r=>resolve=r),fields={};
 let markEntered;const entered=new Promise(resolve=>markEntered=resolve);
 const transport={publish:()=>{markEntered();return pending},close:async()=>{closes++;}};
 const state={config:{id:'old'},active:true,role:'source'};
 const context={state,magnetBusy:false,magnetCleanup:Promise.resolve(),magnetTransport:null,update(){},lifecycle(){events++;},createMagnetTransport:()=>transport,$:id=>fields[id]||(fields[id]={value:'',disabled:true})};
 vm.createContext(context);vm.runInContext(publish+';this.publish=makeMagnet;',context);
 return{context,state,fields,transport,resolve,entered,counts:()=>({closes,events})};
}
test('a late descriptor cannot reappear after its source stops',async()=>{
 const h=publication(),task=h.context.publish();await h.entered;
 h.state.active=false;h.state.config=null;h.context.magnetTransport=null;h.resolve('old-private-descriptor');
 await assert.rejects(task,/Sharing changed/);assert.equal(h.fields['magnet-link']?.value||'','');assert.equal(h.counts().events,0);assert.equal(h.context.magnetBusy,false);
});
test('failed old publication cannot close or clear a newer transport',async()=>{
 const h=publication(),task=h.context.publish();await h.entered;
 const newer={close:async()=>assert.fail('new transport was closed')};h.state.config={id:'new'};h.context.magnetTransport=newer;h.resolve('old-private-descriptor');
 await assert.rejects(task,/Sharing changed/);assert.equal(h.context.magnetTransport,newer);assert.equal(h.counts().closes,1);
});
test('an unchanged source publishes exactly one descriptor',async()=>{
 const h=publication(),task=h.context.publish();await h.entered;
 await assert.rejects(h.context.publish(),/already being prepared/);h.resolve('current-private-descriptor');await task;
 assert.equal(h.fields['magnet-link'].value,'current-private-descriptor');assert.equal(h.counts().events,1);assert.equal(h.counts().closes,0);
});

const joinSource=source.slice(source.indexOf('async function joinMagnet('),source.indexOf('\nfunction canRetryJoin()'));
function discovery({holdCleanup=true}={}){
 let releaseCleanup,releaseJoin,enteredJoin,created=0,closed=0,failures=0;
 const cleanup=new Promise(resolve=>releaseCleanup=resolve),joined=new Promise(resolve=>releaseJoin=resolve),entered=new Promise(resolve=>enteredJoin=resolve);
 const transport={async join(){enteredJoin();await joined;},async close(){closed++;},snapshot:()=>({network:null})};
 const context={state:{config:null,stopped:true},startingCapture:false,magnetBusy:false,magnetTransport:null,magnetJoinGeneration:0,magnetCleanup:holdCleanup?cleanup:Promise.resolve(),lastJoinLink:null,lastNetworkCheck:null,
  update(){},$:()=>({textContent:''}),window:{SameEndInviteCheck:{start(){},phase(){},fail(){failures++;}}},
  createMagnetTransport(){created++;return transport;},async end(){context.magnetJoinGeneration++;context.state.config=null;}
 };
 vm.createContext(context);vm.runInContext(joinSource+';this.api={joinMagnet,leaveRoom,cancelPendingJoin};',context);
 return{context,transport,releaseCleanup,releaseJoin,entered,counts:()=>({created,closed,failures})};
}
test('Leave cancels discovery suspended before its transport exists',async()=>{
 const h=discovery(),task=h.context.api.joinMagnet('magnet:?test');
 assert.equal(h.context.magnetTransport,null);assert.equal(h.context.state.config,null);
 await h.context.api.leaveRoom();h.releaseCleanup();
 await assert.rejects(task,/cancelled/);
 assert.equal(h.counts().created,0,'cleanup cannot revive a cancelled discovery');
 assert.equal(h.context.state.config,null);assert.equal(h.context.magnetTransport,null);assert.equal(h.context.lastJoinLink,null);assert.equal(h.context.magnetBusy,false);assert.equal(h.counts().failures,0);
});
test('cancelled asynchronous discovery closes only its own old transport',async()=>{
 const h=discovery({holdCleanup:false}),task=h.context.api.joinMagnet('magnet:?test');await h.entered;
 await h.context.api.leaveRoom();
 const newer={close:async()=>assert.fail('a stale discovery closed the new transport')};h.context.magnetTransport=newer;h.context.state.config={id:'newer'};
 h.releaseJoin();await assert.rejects(task,/cancelled/);
 assert.equal(h.context.magnetTransport,newer);assert.equal(h.context.state.config.id,'newer');assert.equal(h.context.magnetBusy,false);assert.equal(h.counts().failures,0);
});

test('preemption only cancels the exact pending invitation',async()=>{
 const h=discovery(),task=h.context.api.joinMagnet('magnet:?old');
 assert.equal(await h.context.api.cancelPendingJoin('magnet:?unrelated'),false);assert.equal(h.context.magnetJoinGeneration,1);
 assert.equal(await h.context.api.cancelPendingJoin('magnet:?old'),true);h.releaseCleanup();await assert.rejects(task,/cancelled/);assert.equal(h.counts().created,0);
});


test('foreground visibility wakes pending bootstrap with no accepted media config',()=>{
 let handler;const hints=[],context={document:{visibilityState:'visible',addEventListener(name,fn){handler=fn}},state:{config:null},magnetTransport:{refreshNetwork:reason=>hints.push(reason)}};
 vm.createContext(context);vm.runInContext(source.split('\n').find(line=>line.startsWith("document.addEventListener('visibilitychange'")),context);handler();assert.deepEqual(hints,['visible']);context.document.visibilityState='hidden';handler();assert.deepEqual(hints,['visible']);
});
