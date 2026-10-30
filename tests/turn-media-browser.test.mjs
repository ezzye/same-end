/* Real WebRTC and generated picture through an operator-provided external TURN.
 * Build first: npm run build:resilience
 * Run with SAMEEND_TURN_AUTH_FILE=/private/path/auth.json node tests/turn-media-browser.test.mjs
 * The protected auth JSON contains {apiBase, clubId, readToken}; the harness
 * forwards authenticated ICE requests to the normal coordinator endpoint.
 * Alternatively set SAMEEND_TURN_TEST_ICE_FILE to a protected ICE response.
 * SAMEEND_TURN_TEST_MODE=direct-baseline runs only a direct control and makes
 * no TURN acceptance claim. SAMEEND_TURN_TEST_LABEL selects the evidence name.
 * The owner-only JSON file has the same shape as the authenticated ICE response:
 * {"expiresAt": <unix seconds>, "iceServers": [{"urls": ["turn:..."], "username": "...", "credential": "..."}]}.
 * It must remain valid throughout the test. Never print or save the file contents.
 * Auth mode exercises the real health-gated credential endpoint with a normal
 * read token. It does not test the production UI deriving that token.
 * One computer, two isolated browser contexts and a local tracker: this is not
 * a physical 5G test. The test injects credentials only at the app's provider
 * boundary; production authentication and server-health admission are separate.
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createLocalTestTLS} from './helpers/local-test-tls.mjs';

const authFile=process.env.SAMEEND_TURN_AUTH_FILE,configFile=process.env.SAMEEND_TURN_TEST_ICE_FILE;
if(!!authFile===!!configFile)throw Error('Set exactly one protected ICE or authenticated-provider file.');
let provider;try{provider=JSON.parse(await readFile(authFile||configFile,'utf8'));}catch{throw Error('Could not read the protected provider file as JSON.');}
if(authFile){
 let base;try{base=new URL(provider.apiBase);}catch{throw Error('Protected auth file has an invalid API base.');}assert.equal(base.protocol,'https:');assert(!base.username&&!base.password&&!base.search&&!base.hash&&['','/'].includes(base.pathname),'API base must be an HTTPS origin.');
 assert(/^[a-f0-9-]{36}$/i.test(provider.clubId)&&/^[A-Za-z0-9_-]{43}$/.test(provider.readToken),'Protected auth file must contain a valid club ID and read token.');
}else{
 assert(Number.isFinite(provider.expiresAt)&&provider.expiresAt>Date.now()/1000+360,'ICE response must remain valid for at least 360 seconds.');
 assert(Array.isArray(provider.iceServers)&&provider.iceServers.some(x=>x&&x.urls&&typeof x.username==='string'&&typeof x.credential==='string'),'ICE response must include TURN credentials.');
}
let iceRequests=0,iceGranted=0,iceEmpty=0,iceEndpointErrors=0,iceRequestErrors=0;
const runtimeInput=process.env.SAMEEND_PLAYWRIGHT||(process.env.HOME||process.env.USERPROFILE)+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const runtimeURL=/^file:/i.test(runtimeInput)?new URL(runtimeInput):pathToFileURL(runtimeInput),runtimePath=fileURLToPath(runtimeURL);
const {chromium}=await import(runtimeURL.href),require=createRequire(import.meta.url);
const {wsServer:WebSocketServer}=require(join(dirname(dirname(runtimePath)),'playwright-core/lib/utilsBundle.js'));
const html=await readFile(new URL('../dist/watch.html',import.meta.url),'utf8');
const output=new URL('../privatework/turn-media-browser/',import.meta.url);await mkdir(output,{recursive:true});
const label=process.env.SAMEEND_TURN_TEST_LABEL||'current';assert(/^[A-Za-z0-9_-]{1,40}$/.test(label),'Invalid evidence label.');
const mode=process.env.SAMEEND_TURN_TEST_MODE||'full';assert(['full','direct-baseline'].includes(mode),'Invalid test mode.');
const report={schema:1,startedAt:new Date().toISOString(),buildSHA256:createHash('sha256').update(html).digest('hex'),environment:{mode,oneComputer:true,isolatedChromeContexts:true,externalTurnTested:mode==='full',generatedPicture:true,localTracker:true,privateIceFile:!authFile,authenticatedIceEndpoint:!!authFile,productionAppAuthenticationTested:false,physicalDevices:false,networkSwitchEmulated:mode==='full',physical5GTested:false},pass:false};
const relayDeadline=Number(process.env.SAMEEND_TURN_TEST_TIMEOUT_MS||150000);assert(Number.isFinite(relayDeadline)&&relayDeadline>=3000&&relayDeadline<=150000,'Relay deadline must be between 3000 and 150000 ms.');
let origin,stage='server setup',errors=0;
const server=https.createServer(createLocalTestTLS(),async(req,res)=>{
 if(req.url==='/api/ice'&&authFile){
  iceRequests++;
  try{
   const response=await fetch(new URL('/v1/clubs/'+provider.clubId+'/ice',provider.apiBase),{headers:{Authorization:'Bearer '+provider.readToken},redirect:'error',signal:AbortSignal.timeout(14000)});
   if(!response.ok){iceEndpointErrors++;return res.writeHead(503).end();}
   const answer=await response.json();if(Array.isArray(answer.iceServers)&&answer.iceServers.length)iceGranted++;else iceEmpty++;
   return res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(answer));
  }catch{iceRequestErrors++;return res.writeHead(503).end();}
 }
 const role=new URL(req.url,origin).pathname.slice(1);
 if(!['source','relay','recovery'].includes(role))return res.writeHead(404).end();
 const trackerURL=origin.replace('https:','wss:')+'/tracker?role='+role;
 const hashes=[];
 let page=html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,(_,open,body,close)=>{const changed=body.replace(/wss:\/\/tracker\.[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_/-]*)?/g,trackerURL);if(changed!==body)hashes.push([createHash('sha256').update(body).digest('base64'),createHash('sha256').update(changed).digest('base64')]);return open+changed+close;});
 for(const [oldHash,newHash] of hashes)page=page.replaceAll('sha256-'+oldHash,'sha256-'+newHash);
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}).end(page);
});
const tracker=new WebSocketServer({server,path:'/tracker'}),swarms=new Map();
const send=(socket,message)=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};
tracker.on('connection',socket=>{
 socket.memberships=[];socket.on('error',()=>errors++);
 socket.on('message',raw=>{try{
  const m=JSON.parse(raw.toString());if(m.action!=='announce'||typeof m.info_hash!=='string'||typeof m.peer_id!=='string')return;
  let swarm=swarms.get(m.info_hash);if(!swarm){swarm=new Map();swarms.set(m.info_hash,swarm);}
  if(m.event==='stopped'){swarm.delete(m.peer_id);return;}
  swarm.set(m.peer_id,{socket});socket.memberships.push([m.info_hash,m.peer_id]);
  if(m.answer&&m.to_peer_id){const target=swarm.get(m.to_peer_id);if(target)send(target.socket,{action:'announce',info_hash:m.info_hash,peer_id:m.peer_id,offer_id:m.offer_id,answer:m.answer});return;}
  send(socket,{action:'announce',info_hash:m.info_hash,interval:15,complete:1,incomplete:Math.max(0,swarm.size-1)});
  const peers=[...swarm].filter(([id,p])=>id!==m.peer_id&&p.socket.readyState===1);let n=0;
  for(const [,peer] of peers){const offer=m.offers?.[n++];if(offer)send(peer.socket,{action:'announce',info_hash:m.info_hash,peer_id:m.peer_id,offer_id:offer.offer_id,offer:offer.offer});}
 }catch{errors++;}});
 socket.on('close',()=>{for(const[hash,id]of socket.memberships){const swarm=swarms.get(hash);if(swarm?.get(id)?.socket===socket)swarm.delete(id);if(!swarm?.size)swarms.delete(hash);}});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='https://127.0.0.1:'+server.address().port;
let browser;const contexts=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms,message){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(250);}throw Error(message);}
const snapshot=p=>p.evaluate(()=>{const s=PrivateCast.snapshot(),v=document.querySelector('#player');return {received:s.received||0,frames:v.getVideoPlaybackQuality?.().totalVideoFrames||0,width:v.videoWidth,height:v.videoHeight,playing:!v.paused&&v.readyState>=2,clockReady:s.clockReady===true,sourceReachable:s.sourceReachable===true,reserveSeconds:Number.isFinite(s.reserveSeconds)?s.reserveSeconds:null,route:s.network?.selectedRoute||s.transport?.network?.selectedRoute||'unknown',localCandidateType:s.network?.localCandidateType||s.transport?.network?.localCandidateType||null,remoteCandidateType:s.network?.remoteCandidateType||s.transport?.network?.remoteCandidateType||null};});
async function page(role,forceRelay){
 const c=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});contexts.push(c);
 await c.addInitScript(({force})=>{
  window.__turnTest={force,connections:[]};
  const Original=window.RTCPeerConnection;
  function Wrapped(config,...args){const next=window.__turnTest.force?{...(config||{}),iceTransportPolicy:'relay'}:config;const pc=new Original(next,...args);window.__turnTest.connections.push(pc);return pc;}
  Wrapped.prototype=Original.prototype;Object.setPrototypeOf(Wrapped,Original);window.RTCPeerConnection=Wrapped;
 },{force:forceRelay});
 const p=await c.newPage();p.on('pageerror',()=>errors++);await p.goto(origin+'/'+role);await p.waitForFunction(()=>window.PrivateCast?.testing&&window.SameEndSocial);
 if(role!=='source'){if(authFile)await p.evaluate(()=>{window.SameEndSocial.edgeIceServers=async()=>{const r=await fetch('/api/ice',{cache:'no-store'});return r.ok?await r.json():{iceServers:[],expiresAt:null};};});else await p.evaluate(answer=>{window.SameEndSocial.edgeIceServers=async()=>answer;},provider);}
 return p;
}
async function joinViewer(p,invitation){await p.evaluate(m=>{window.__join={done:false,ok:false};PrivateCast.joinMagnet(m).then(()=>{window.__join={done:true,ok:true};},()=>{window.__join={done:true,ok:false};});},invitation);}
async function picture(p,route,ms){await until(async()=>{const s=await snapshot(p);return s.route===route&&s.clockReady&&s.sourceReachable&&s.playing&&s.width>0&&s.height>0&&s.frames>10&&s.received>2;},ms,'Picture and selected route did not become ready in time.');}
async function advance(p){const before=await snapshot(p);let last=before.frames,decodedFrameAdvance=0,frameCounterResets=0,after=before;for(let i=0;i<8;i++){await pause(500);after=await snapshot(p);if(after.frames<last)frameCounterResets++;else decodedFrameAdvance+=after.frames-last;last=after.frames;}assert(decodedFrameAdvance>5,'Decoded picture frames must advance.');assert(after.received>before.received,'Signed programme pieces must advance.');return {framesBefore:before.frames,framesAfter:after.frames,decodedFrameAdvance,frameCounterResets,piecesBefore:before.received,piecesAfter:after.received,reserveBeforeSeconds:before.reserveSeconds,reserveAfterSeconds:after.reserveSeconds,route:after.route,localCandidateType:after.localCandidateType,remoteCandidateType:after.remoteCandidateType};}
try{
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--ignore-certificate-errors','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 stage='generated source';const source=await page('source',false);await source.evaluate(()=>PrivateCast.testing.startDemo({delay:10}));const invitation=await source.evaluate(()=>PrivateCast.testing.publishInvitation());
 if(mode==='direct-baseline'){
  stage='direct control';const viewer=await page('recovery',false),started=Date.now();await joinViewer(viewer,invitation);await picture(viewer,'direct',90000);report.directControl={joinToPictureMs:Date.now()-started,...await advance(viewer)};
  const facts=await viewer.evaluate(()=>{const j=SameEndInviteCheck.report().joining;return {connectionMode:j.connectionMode,localCandidateType:j.network?.localCandidateType,remoteCandidateType:j.network?.remoteCandidateType,audioTrackIncluded:j.audioTrackIncluded,videoPiecesReceived:j.videoPiecesReceived};});
  assert.equal(facts.connectionMode,'direct');assert(['host','srflx','prflx'].includes(facts.localCandidateType));assert(['host','srflx','prflx'].includes(facts.remoteCandidateType));assert.equal(facts.audioTrackIncluded,true);assert.equal(facts.videoPiecesReceived,true);report.directControl.safeReport=facts;assert.equal(errors,0,'Tracker and page error count must be zero.');report.pass=true;
  console.log('PASS: generated picture and signed pieces advanced over an observed direct WebRTC route; TURN was not tested.');
 }else{
 stage='relay-only initial join';const relay=await page('relay',true),joinAt=Date.now();await joinViewer(relay,invitation);await picture(relay,'relay',relayDeadline);report.relayOnly={joinToPictureMs:Date.now()-joinAt,...await advance(relay)};assert([report.relayOnly.localCandidateType,report.relayOnly.remoteCandidateType].includes('relay'));
 await relay.context().close();
 stage='direct baseline';const recovery=await page('recovery',false),directAt=Date.now();await joinViewer(recovery,invitation);await picture(recovery,'direct',90000);const baseline=await advance(recovery);report.recovery={directJoinToPictureMs:Date.now()-directAt,before:baseline};
 stage='controlled connection loss and relay fallback';const faultAt=Date.now();const closed=await recovery.evaluate(()=>{window.__turnTest.force=true;let count=0;for(const pc of window.__turnTest.connections)if(pc.connectionState!=='closed'){count++;pc.close();}return count;});assert(closed>0,'The test must close at least one live peer connection.');
 report.recovery.closedPeerConnections=closed;let lastFrames=baseline.framesAfter,lastMovement=Date.now(),longestGap=0,samples=0,minReserve=null,frameCounterResets=0,relayPreviousFrames=null;
 await until(async()=>{const s=await snapshot(recovery),now=Date.now();samples++;if(Number.isFinite(s.reserveSeconds))minReserve=minReserve===null?s.reserveSeconds:Math.min(minReserve,s.reserveSeconds);if(s.frames<lastFrames)frameCounterResets++;else if(s.frames>lastFrames){longestGap=Math.max(longestGap,now-lastMovement);lastMovement=now;}lastFrames=s.frames;const relayFrameAdvanced=s.route==='relay'&&relayPreviousFrames!==null&&s.frames>relayPreviousFrames;relayPreviousFrames=s.route==='relay'?s.frames:null;return relayFrameAdvanced&&s.clockReady&&s.sourceReachable&&s.playing&&s.width>0&&s.height>0&&s.received>baseline.piecesAfter;},relayDeadline,'Relay picture did not recover in time.');
 report.recovery.relayPictureAfterFaultMs=Date.now()-faultAt;report.recovery.observation={samples,frameCounterResets,longestObservedNoFrameMs:Math.max(longestGap,Date.now()-lastMovement),minimumReserveSeconds:minReserve};report.recovery.after=await advance(recovery);assert([report.recovery.after.localCandidateType,report.recovery.after.remoteCandidateType].includes('relay'));assert.equal(errors,0,'Tracker and page error count must be zero.');report.pass=true;
 console.log('PASS: generated picture and signed pieces advanced through TURN on initial join and direct-to-relay recovery.');
 }
}catch(error){report.failedStage=stage;report.errorKind=String(error?.name||'Error').slice(0,40);console.error('FAIL: controlled TURN media test did not complete at stage: '+stage);process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();report.errorCount=errors;report.iceRequests=iceRequests;report.iceGranted=iceGranted;report.iceEmpty=iceEmpty;report.iceEndpointErrors=iceEndpointErrors;report.iceRequestErrors=iceRequestErrors;await writeFile(new URL('evidence-'+label+'.json',output),JSON.stringify(report,null,2));for(const c of contexts)await c.close().catch(()=>{});if(browser)await browser.close();for(const socket of tracker.clients)socket.terminate();await new Promise(resolve=>tracker.close(resolve));await new Promise(resolve=>server.close(resolve));}
