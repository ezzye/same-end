/* Behavioural clock tests, not a physical 90-minute media acceptance run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const code=await readFile(new URL('../rehearsal.js',import.meta.url),'utf8');
async function setup({failPublish=false}={}){
 let wall=1792796400000, receive, tick, cast={};
 const nodes=new Map(),node=()=>({value:'',hidden:false,textContent:'',classList:{toggle(){}},append(){},replaceChildren(){},getVideoPlaybackQuality:()=>({totalVideoFrames:100}),currentTime:1,paused:false,readyState:4});
 const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
 const snapshot={ready:true,connected:true,owner:true,id:webcrypto.randomUUID(),hasLive:false};
 class Clock extends Date{static now(){return wall}}
 const context={console,Date:Clock,URL,URLSearchParams,crypto:webcrypto,navigator:{userAgent:'test'},structuredClone,Event,document:{readyState:'loading',addEventListener(){},getElementById:get,createElement:node,head:{append(){}}},setTimeout(){},setInterval(fn){tick=fn;return 1}};context.window=context;context.location={hash:''};
 context.SameEndSocial={snapshot:()=>snapshot,updateClub:async patch=>Object.assign(snapshot,patch),onMessage:fn=>{receive=fn;return()=>{}},postEncryptedMessage:async()=>({})};
 context.PrivateCast={snapshot:()=>cast,testing:{startDemo:async()=>{const id=webcrypto.randomUUID();cast={config:{id},role:'source',programTime:0,clockReady:true,ready:4,paused:false,peers:[],recovery:{state:'idle'},drift:0};return{id}},publishInvitation:async()=>{if(failPublish)throw Error('Synthetic publish failure')},endRoom(){cast={}}}};
 vm.runInNewContext(code,context);const r=context.SameEndRehearsal;r.init();await Promise.resolve();await r.create({delay:300,expectedDevices:2});await r.join({environment:'simulated-browser'});
 receive({receivedAt:wall,payload:{kind:'rehearsal',rehearsalId:snapshot.rehearsal.id,type:'status',deviceId:webcrypto.randomUUID(),environment:'simulated-browser',metrics:{}}});
 return{r,snapshot,cast:()=>cast,async advance(ms){wall+=ms;await tick();await Promise.resolve()}};
}
test('rehearsal allows a full-match window and records mapped programme time across clip resets',async()=>{
 const t=await setup();assert.equal(t.snapshot.rehearsal.expiresAt-t.snapshot.rehearsal.createdAt,7200000);await t.r.start();
 t.cast().programTime=120;await t.advance(5000);assert.equal(t.r.report().localSamples.at(-1).playTime,120);
 t.cast().programTime=125;await t.advance(5000);assert.equal(t.r.report().localSamples.at(-1).playTime,125);assert(t.r.report().localSamples.at(-1).playbackAdvances>0);
 await t.advance(91*60000);assert.equal(t.r.snapshot().config.phase,'running');assert(t.cast().config,'90-minute clock advance does not expire the room');
});
test('failed rehearsal start retains failed phase in its finished report',async()=>{
 const t=await setup({failPublish:true});await assert.rejects(()=>t.r.start(),/Synthetic publish failure/);const report=t.r.report();assert.equal(report.rehearsal.phase,'failed');assert.equal(report.stoppedBecause,'start-failed');assert.equal(t.cast().config,undefined);
});
