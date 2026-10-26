/* Actual signed media over WebTorrent/WebRTC, isolated Chrome contexts on ONE Mac.
 * Local WSS tracker replaces discovery only. No user tabs, fake RTC, fake clocks,
 * fabricated visibility, live programme, public backend, or physical-device claim.
 * Run after `npm run build`; optional SAMEEND_RECOVERY_CASE=reserve|stall|loss.
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const runtime=process.env.SAMEEND_PLAYWRIGHT||'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(runtime), require=createRequire(import.meta.url);
// Reuse the WebSocket server already bundled with Playwright; no npm install.
const {wsServer:WebSocketServer}=require(join(dirname(dirname(runtime)),'playwright-core/lib/utilsBundle.js'));
const output=new URL('../privatework/delivery-recovery-test-20261023/',import.meta.url);
await mkdir(output,{recursive:true});
const certDir=await mkdtemp(join(tmpdir(),'sameend-recovery-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),'-subj','/CN=localhost'],{stdio:'ignore'});
let servedHTML='',origin;
const originalHTML=await readFile(new URL('../dist/watch.html',import.meta.url),'utf8');
const server=https.createServer({key:await readFile(join(certDir,'key.pem')),cert:await readFile(join(certDir,'cert.pem'))},(req,res)=>{
 if(req.url.startsWith('/sw.js'))return res.writeHead(404).end();
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}).end(servedHTML);
});
const tracker=new WebSocketServer({server,path:'/tracker'}),swarms=new Map(),trackerErrors=[];
const trackerStats={connections:0,announces:0,offers:0,answers:0};
const send=(socket,message)=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};
tracker.on('connection',socket=>{
 trackerStats.connections++;socket.memberships=[];
 socket.on('error',e=>trackerErrors.push(e.message));
 socket.on('message',raw=>{try{
  const m=JSON.parse(raw.toString());if(m.action!=='announce'||typeof m.info_hash!=='string'||typeof m.peer_id!=='string')return;
  trackerStats.announces++;let swarm=swarms.get(m.info_hash);if(!swarm){swarm=new Map();swarms.set(m.info_hash,swarm);}
  if(m.event==='stopped'){swarm.delete(m.peer_id);return;}
  swarm.set(m.peer_id,socket);socket.memberships.push([m.info_hash,m.peer_id]);
  if(m.answer&&m.to_peer_id){trackerStats.answers++;send(swarm.get(m.to_peer_id),{action:'announce',info_hash:m.info_hash,peer_id:m.peer_id,offer_id:m.offer_id,answer:m.answer});return;}
  send(socket,{action:'announce',info_hash:m.info_hash,interval:2,complete:1,incomplete:Math.max(0,swarm.size-1)});
  const peers=[...swarm].filter(([id,s])=>id!==m.peer_id&&s.readyState===1);
  for(let n=0;n<Math.min(peers.length,m.offers?.length||0);n++){
   const offer=m.offers[n];trackerStats.offers++;send(peers[n][1],{action:'announce',info_hash:m.info_hash,peer_id:m.peer_id,offer_id:offer.offer_id,offer:offer.offer});
  }
 }catch(e){trackerErrors.push(e.message);}});
 socket.on('close',()=>{for(const[hash,id]of socket.memberships){const swarm=swarms.get(hash);if(swarm?.get(id)===socket)swarm.delete(id);if(!swarm?.size)swarms.delete(hash);}});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='https://127.0.0.1:'+server.address().port;
const trackerURL=origin.replace('https:','wss:')+'/tracker';
assert(originalHTML.includes('wss://tracker.openwebtorrent.com'),'Expected production tracker configuration');
servedHTML=originalHTML.replace(/wss:\/\/tracker\.[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_/-]*)?/g,trackerURL);
// The isolated tracker changes trusted inline bytes; retain CSP enforcement by
// replacing only the corresponding exact hashes, never weakening script-src.
const originalScripts=[...originalHTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
const fixtureScripts=[...servedHTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
for(let i=0;i<originalScripts.length;i++)if(originalScripts[i][1]!==fixtureScripts[i][1]){
 const hash=body=>"'sha256-"+createHash('sha256').update(body.replace(/\r\n?/g,'\n')).digest('base64')+"'";
 const oldHash=hash(originalScripts[i][1]);assert(servedHTML.includes(oldHash),'Modified fixture script must have an exact CSP hash');
 servedHTML=servedHTML.replaceAll(oldHash,hash(fixtureScripts[i][1]));
}
const report={schema:1,startedAt:new Date().toISOString(),buildSHA256:createHash('sha256').update(originalHTML).digest('hex'),environment:{browser:'Installed Google Chrome',isolatedContexts:true,oneComputer:true,physicalDevices:false,separateNetworks:false,actualWebRTC:true,generatedPictureAnd220HzTone:true,discovery:'In-process local WSS BitTorrent tracker; production tracker URL replaced in served HTML only',autoplayOverride:true,selfSignedLocalCertificateOverride:true,visibilityEmulated:false},cases:[],tracker:trackerStats,trackerErrors,pass:false};
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--ignore-certificate-errors','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms,message){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(250);}throw Error(message);}
const sanitize=s=>String(s).replace(/#pc=[A-Za-z0-9_-]+/g,'#pc=[removed]').replace(/magnet:\S+/g,'[invitation removed]');
async function snapshot(p){if(p.isClosed())return {closed:true};try{return await p.evaluate(()=>{
 const s=PrivateCast.snapshot(),v=document.querySelector('#player'),probe=window.deliveryProbe;
 const data=probe?new Float32Array(probe.analyser.fftSize):null;if(data)probe.analyser.getFloatTimeDomainData(data);
 const rms=data?Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length):null;
 return {...s,sampledAt:Date.now(),decodedFrames:v.getVideoPlaybackQuality?.().totalVideoFrames??null,frameCallbacks:probe?.frames||0,lastFrameAt:probe?.lastFrameAt||null,audioRms:rms,audioContext:probe?.context.state,video:{paused:v.paused,ended:v.ended,currentTime:v.currentTime,ready:v.readyState,width:v.videoWidth,height:v.videoHeight},status:document.querySelector('#status').textContent,playState:document.querySelector('#play-state').textContent};
 });}catch(e){if(p.isClosed())return {closed:true};throw e;}}
async function probe(p){await p.evaluate(async()=>{
 const v=document.querySelector('#player');v.muted=false;v.volume=1;
 const context=new AudioContext();await context.resume();const node=context.createMediaElementSource(v),analyser=context.createAnalyser();analyser.fftSize=2048;node.connect(analyser);analyser.connect(context.destination);
 const probe=window.deliveryProbe={context,analyser,frames:0,lastFrameAt:null};
 const frame=()=>{probe.frames++;probe.lastFrameAt=Date.now();v.requestVideoFrameCallback(frame);};v.requestVideoFrameCallback(frame);
 });}
function identity(s){const c=s.config;return c&&{id:c.id,epoch:c.epoch,delay:c.delay,sourceId:c.sourceId,sourceEpoch:c.sourceEpoch,programId:c.programId};}
function assertIdentity(before,after){assert.deepEqual(identity(after),identity(before),'Recovery must preserve signed cast identity, epoch and delay');assert(after.clockReady,'Retain established shared clock');}
async function group(name,delay){
 const result={name,delay,pass:false,events:[],errors:[],samples:[]};report.cases.push(result);const contexts=[],peers={};
 async function page(label){const c=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1200,height:850}});contexts.push(c);const p=await c.newPage();peers[label]=p;p.on('pageerror',e=>result.errors.push({label,error:sanitize(e.stack||e.message)}));await p.goto(origin);await p.waitForFunction(()=>window.PrivateCast?.testing);await p.locator('#name').evaluate((el,name)=>el.value=name,'Recovery '+label);return p;}
 async function record(label){const states=Object.fromEntries(await Promise.all(Object.entries(peers).map(async([name,p])=>[name,await snapshot(p)])));result.events.push({label,at:Date.now(),states});console.log(name+': '+label);return states;}
 async function limit(p,n){await p.evaluate(n=>PrivateCast.testing.setRelayLimit(n),n);}
 async function received(p){await until(async()=>{const s=await snapshot(p);return s.clockReady&&s.received>1&&s.supplier;},40000,'Signed media did not reach a viewer');}
 let observing=false,monitor;
 try{
  const source=await page('source');await source.evaluate(delay=>PrivateCast.testing.startDemo({delay}),delay);await limit(source,1);
  const magnet=await source.evaluate(()=>PrivateCast.testing.publishInvitation());
  const relay=await page('relay');await limit(relay,0);await relay.evaluate(m=>PrivateCast.joinMagnet(m),magnet);await received(relay);
  await limit(source,2);
  const sibling=await page('sibling');await limit(sibling,0);await sibling.evaluate(m=>PrivateCast.joinMagnet(m),magnet);await received(sibling);
  await limit(relay,1);
  const child=await page('child');await limit(child,0);await child.evaluate(m=>PrivateCast.joinMagnet(m),magnet);await received(child);
  const topology=await record('forced source-relay-child and direct sibling');
  assert.equal(topology.relay.supplier.id,topology.source.nodeId);assert.equal(topology.sibling.supplier.id,topology.source.nodeId);assert.equal(topology.child.supplier.id,topology.relay.nodeId);
  await Promise.all(Object.values(peers).map(probe));
  await until(async()=>{const states=await Promise.all(Object.values(peers).map(snapshot));return states.every(s=>s.decodedFrames>10&&s.frameCallbacks>5&&!s.video.paused&&s.audioRms>.002&&Number.isFinite(s.programTime));},delay*1000+45000,'Decoded moving picture, tone and mapped programme position did not start everywhere');
  const baseline=await record('decoded picture tone and shared clock');
  assert(baseline.source.config.audio,'Generated source must include its actual audio track');
  for(const label of ['source','relay']){
   assert(baseline[label].delivery?.peers?.some(p=>p.receipts&&p.acknowledgedBytes>0),'Real verified-piece delivery receipts must return to '+label);
  }
  for(const p of Object.values(peers)){const s=await snapshot(p);assert(s.video.width>0&&s.video.height>0);}
  observing=true;monitor=(async()=>{while(observing){const states=Object.fromEntries(await Promise.all(Object.entries(peers).map(async([n,p])=>[n,await snapshot(p)])));result.samples.push({at:Date.now(),states});await pause(250);}})();
  await pause(4500);
  return {result,peers,baseline,record,limit,contexts,async finish(){observing=false;await monitor;await Promise.all(contexts.map(c=>c.close()));},async sampleFor(ms){await pause(ms);},async assertPlayback(labels,{maxGapMs=1800,minSamples=8}={}){
   // Use elapsed wall time, not a fixed count: evaluations take time as well as
   // the 250ms sleep. A count can accidentally include the pre-recovery frame.
   const recent=result.samples.filter(row=>row.at>=Date.now()-6500);const spreads=[];
   for(const row of recent){const group=labels.map(n=>row.states[n]).filter(s=>!s.closed&&s.config&&Number.isFinite(s.programTime));if(group.length===labels.length){const at=Math.max(...group.map(s=>s.sampledAt));const positions=group.map(s=>s.programTime+(at-s.sampledAt)/1000);spreads.push(Math.max(...positions)-Math.min(...positions));}}
   assert(spreads.length>=minSamples,'Need simultaneous programme-position samples');assert(Math.max(...spreads)<1,'Shared programme spread must remain below one second; observed '+Math.max(...spreads));
   for(const label of labels){const samples=recent.map(r=>r.states[label]).filter(s=>!s.closed&&s.config);assert(samples.length>=minSamples);assert(samples.at(-1).frameCallbacks>samples[0].frameCallbacks,'Decoded video callbacks must advance: '+label);assert(samples.filter(s=>s.audioRms>.002).length>=minSamples,'Generated tone must remain measurable: '+label);const maxGap=Math.max(...samples.map(s=>s.lastFrameAt?s.sampledAt-s.lastFrameAt:Infinity));assert(maxGap<maxGapMs,'Decoded-frame gap too long for '+label+': '+maxGap);}
   return {maxSpreadSeconds:Math.max(...spreads),sampleCount:spreads.length};
  },assertContinuousSince(at,labels){
   const summary={};for(const label of labels){const samples=result.samples.filter(row=>row.at>=at).map(row=>row.states[label]).filter(s=>!s.closed&&s.config);assert(samples.length>10);const maxGapMs=Math.max(...samples.map(s=>s.sampledAt-s.lastFrameAt));const additionalStalls=samples.at(-1).stalls-samples[0].stalls;summary[label]={maxGapMs,additionalStalls,sampleCount:samples.length};assert(maxGapMs<1800,'Reserve must keep decoded frames moving through recovery for '+label+': '+maxGapMs);assert.equal(additionalStalls,0,'Measured reserve should avoid new playback stalls for '+label);}return summary;
  }};
 }catch(e){result.error=sanitize(e.stack||e.message);await record('failure').catch(()=>{});observing=false;await monitor;await Promise.all(contexts.map(c=>c.close()));throw e;}
}

try{
 const selected=process.env.SAMEEND_RECOVERY_CASE||'all';
 if(selected==='discovery'){
  const result={name:'local tracker cold independent browser discovery',pass:false};report.cases.push(result);const contexts=[];
  try{
   for(let n=0;n<2;n++){const c=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});contexts.push(c);const p=await c.newPage();await p.goto(origin);await p.waitForFunction(()=>window.PrivateCast?.testing);}
   const[source,viewer]=contexts.map(c=>c.pages()[0]);await source.evaluate(()=>PrivateCast.testing.startDemo({delay:10}));const invitation=await source.evaluate(()=>PrivateCast.testing.publishInvitation());await viewer.evaluate(m=>PrivateCast.joinMagnet(m),invitation);
   await until(async()=>{const s=await snapshot(viewer);return s.clockReady&&s.received>1;},35000,'Local tracker did not introduce browsers with real signed media');
   result.viewer=await snapshot(viewer);assert(result.viewer.peers.some(p=>p.direction==='up'&&p.ready));result.pass=true;
  }finally{await Promise.all(contexts.map(c=>c.close()));}
 }
 if(selected==='all'||selected==='reserve'){
  const reserveDelay=process.env.SAMEEND_RESERVE_DELAY==='300'?300:60;
  const g=await group('reserve-relay-stall-and-graceful-leave',reserveDelay),{source,relay,sibling,child}=g.peers;
  try{
   await g.limit(sibling,1);const before=await g.record('before connected supplier media stall');
   assert(before.relay.reserveSeconds>=reserveDelay-30,'Selected delay must provide a measured useful reserve');
   assert(before.child.reserveSeconds>=reserveDelay-30,'Relayed child must hold useful verified reserve');
   assert(before.relay.reserveSeconds<=reserveDelay+5&&before.child.reserveSeconds<=reserveDelay+5,'Reserve is seconds of useful future cache, bounded by source delay');
   const at=Date.now();await source.evaluate(peerId=>PrivateCast.testing.stallOutgoing({enabled:true,peerId}),before.relay.nodeId);
   await g.sampleFor(5500);const openStall=await g.record('media stalled while supplier control connection stays open');assert.equal(openStall.relay.supplier?.id,before.source.nodeId);assert(openStall.relay.peers.some(p=>p.direction==='up'&&p.ready));assert(openStall.relay.received<=before.relay.received+1,'Media should stop while the control connection remains open');
   await until(async()=>{const r=await snapshot(relay);return r.supplier?.id!==before.source.nodeId&&r.sourceReachable&&r.recovery.recoveries>before.relay.recovery.recoveries&&r.received>before.relay.received+2;},45000,'Relay did not replace a control-alive media-stalled supplier');
   const after=await g.record('relay auto recovered with downstream retained');assertIdentity(before.relay,after.relay);assertIdentity(before.child,after.child);assert.equal(after.child.supplier.id,after.relay.nodeId,'Relay supplier recovery must preserve downstream connection');assert(after.relay.peers.some(p=>p.direction==='down'&&p.id===after.child.nodeId));
   g.result.connectedStallRecoveryMs=Date.now()-at;await source.evaluate(()=>PrivateCast.testing.stallOutgoing({enabled:false}));await g.sampleFor(6500);g.result.afterRelayRecovery=await g.assertPlayback(['source','relay','sibling','child']);
   const leaveBefore=await g.record('before graceful relay departure');await relay.evaluate(()=>PrivateCast.testing.endRoom());
   await until(async()=>{const s=await snapshot(child);return s.config&&s.supplier?.id!==leaveBefore.relay.nodeId&&s.sourceReachable&&s.received>leaveBefore.child.received+2;},45000,'Child did not recover after graceful relay departure');
   const leaveAfter=await g.record('child recovered after graceful relay departure');assertIdentity(leaveBefore.child,leaveAfter.child);assert(!leaveAfter.child.sourceEnded,'Relay departure must not impersonate source end');await g.sampleFor(6500);g.result.afterGracefulLeave=await g.assertPlayback(['source','sibling','child']);
   g.result.reserveContinuity=g.assertContinuousSince(at,['source','sibling','child']);
   await child.locator('#player').screenshot({path:fileURLToPath(new URL('reserve-recovered-picture.png',output))});
   await source.evaluate(()=>PrivateCast.testing.endRoom());await until(async()=>(await Promise.all([source,sibling,child].map(snapshot))).every(s=>!s.config&&s.sourceEnded),12000,'Signed source end did not propagate');await g.record('signed source end verified');
   assert.deepEqual(g.result.errors,[]);g.result.pass=true;
  }finally{await g.finish();}
 }
 if(selected==='all'||selected==='stall'){
  const g=await group('child-connected-media-stall-and-resume',10),{source,relay,sibling,child}=g.peers;
  try{
   await g.limit(sibling,1);const before=await g.record('before relay outgoing media stall');const at=Date.now();await relay.evaluate(()=>PrivateCast.testing.stallOutgoing({enabled:true}));
   await g.sampleFor(5500);const openStall=await g.record('child media stalled with upstream connection still ready');assert.equal(openStall.child.supplier?.id,before.relay.nodeId);assert(openStall.child.peers.some(p=>p.direction==='up'&&p.ready));assert(openStall.child.received<=before.child.received+1);
   await until(async()=>{const s=await snapshot(child);return s.config&&s.sourceReachable&&s.supplier?.id!==before.relay.nodeId&&s.recovery.recoveries>before.child.recovery.recoveries&&s.received>before.child.received+2;},45000,'Child did not replace a control-alive media-stalled relay');
   const after=await g.record('child recovered from connected stalled relay');assertIdentity(before.child,after.child);g.result.recoveryMs=Date.now()-at;await relay.evaluate(()=>PrivateCast.testing.stallOutgoing({enabled:false}));await g.sampleFor(7000);g.result.afterMediaResume=await g.assertPlayback(['source','relay','sibling','child']);
   const beforeApplicationLoss=await g.record('before selected upstream application messages are dropped');
   const lossAt=Date.now();await child.evaluate(()=>PrivateCast.testing.stallIncoming({enabled:true}));
   await g.sampleFor(5500);const openLoss=await g.record('application messages absent while transport connection stays open');assert.equal(openLoss.child.supplier?.id,beforeApplicationLoss.child.supplier.id);assert(openLoss.child.peers.some(p=>p.direction==='up'&&p.ready));
   await until(async()=>{const s=await snapshot(child);return s.supplier?.id&&s.supplier.id!==beforeApplicationLoss.child.supplier.id&&s.sourceReachable&&s.received>beforeApplicationLoss.child.received+2;},50000,'Missing application control and media did not trigger automatic supplier replacement');
   await child.evaluate(()=>PrivateCast.testing.stallIncoming({enabled:false}));const afterApplicationLoss=await g.record('selected application path lost and alternate supplier restored');assertIdentity(beforeApplicationLoss.child,afterApplicationLoss.child);g.result.applicationLossRecoveryMs=Date.now()-lossAt;await g.sampleFor(7000);g.result.afterApplicationPathRestore=await g.assertPlayback(['source','relay','sibling','child']);
   await source.evaluate(()=>PrivateCast.testing.endRoom());await until(async()=>(await Promise.all(Object.values(g.peers).map(snapshot))).every(s=>!s.config&&s.sourceEnded),12000,'Signed source end did not propagate');await g.record('signed source end verified');
   await child.waitForFunction(()=>SameEndDiagnostics.report()?.finish==='ended');
   const logs=await Promise.all(Object.values(g.peers).map(p=>p.evaluate(()=>SameEndDiagnostics.report())));
   const childLog=logs[3];assert(childLog.counts.supplierChanges>=1,'local diagnostics retain actual supplier changes');assert(childLog.events.some(e=>e.type==='recovery'&&e.value.includes('searching')),'actual watchdog recovery appears in local timeline');assert(childLog.samples.some(s=>s.programTime>0&&Number.isFinite(s.targetProgramTime)),'mapped group positions are sampled during real playback');
   assert(logs.every(r=>r.finish==='ended'&&r.samples.length>0),'source end preserves local reports on all peers');
   const codes=logs.map(r=>r.castTag);assert(codes.every(c=>c&&c===codes[0]),'one non-secret test code correlates all local reports');g.result.localDiagnostics=logs.map(r=>({reportId:r.reportId,castTag:r.castTag,sampleCount:r.samples.length,supplierChanges:r.counts.supplierChanges,recoveryEvents:r.events.filter(e=>e.type==='recovery'),finish:r.finish}));
   assert.deepEqual(g.result.errors,[]);g.result.pass=true;
  }finally{await g.finish();}
 }
 if(selected==='all'||selected==='loss'){
  const g=await group('abrupt-relay-close-and-source-loss',10),{source,relay,sibling,child}=g.peers;
  try{
   await g.limit(sibling,1);const before=await g.record('before relay browser closes');await relay.close();
   await until(async()=>{const s=await snapshot(child);return s.config&&s.sourceReachable&&s.supplier?.id!==before.relay.nodeId&&s.received>before.child.received+2;},45000,'Child did not recover after relay browser closed');
   const after=await g.record('child recovered from abrupt relay close');assertIdentity(before.child,after.child);await g.sampleFor(7000);g.result.afterAbruptLeave=await g.assertPlayback(['source','sibling','child']);
   const last=await snapshot(child);await source.close();await until(async()=>{const s=await snapshot(child);return !s.sourceReachable&&s.config&&s.clockReady;},15000,'Source loss did not retain the session honestly');
   await until(async()=>{const s=await snapshot(child);return s.stalls>last.stalls&&/source path|saved video|cached window|unavailable/i.test(s.playState);},35000,'Exhausted source cache did not report missing future media');
   const exhausted=await g.record('source lost cached window exhausted');assertIdentity(last,exhausted.child);assert.equal(exhausted.child.sourceEnded,false,'Abrupt source loss is not a signed end');const receivedAtExhaustion=exhausted.child.received;await g.sampleFor(4500);const frozen=await snapshot(child);assert.equal(frozen.received,receivedAtExhaustion,'Offline source cannot invent future signed segments');g.result.sourceLoss={receivedAtExhaustion,receivedAfter:frozen.received,playState:frozen.playState};assert.deepEqual(g.result.errors,[]);g.result.pass=true;
  }finally{await g.finish();}
 }
 assert(report.cases.length,'Unknown SAMEEND_RECOVERY_CASE');assert.deepEqual(trackerErrors,[]);report.pass=report.cases.every(c=>c.pass);console.log('PASS: local real-WebRTC delivery recovery acceptance');
}catch(e){report.error=sanitize(e.stack||e.message);console.error(report.error);process.exitCode=1;}
finally{
 report.completedAt=new Date().toISOString();await writeFile(new URL((process.env.SAMEEND_RECOVERY_CASE||'all')+(process.env.SAMEEND_RESERVE_DELAY==='300'?'-300':'')+'-browser-evidence.json',output),JSON.stringify(report,null,2));
 await browser.close();for(const socket of tracker.clients)socket.terminate();await new Promise(r=>tracker.close(r));await new Promise(r=>server.close(r));await rm(certDir,{recursive:true,force:true});
}
