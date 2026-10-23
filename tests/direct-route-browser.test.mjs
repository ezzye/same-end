/* Real WebRTC on ONE Mac, with synthetic discovery withholding only.
 * Run after npm run build: node tests/direct-route-browser.test.mjs
 * No TURN, cloud media relay, mocked RTC, physical devices or NAT/5G emulation.
 * Descriptor and signed media must cross an already-joined family helper.
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const runtime=process.env.SAMEEND_PLAYWRIGHT||'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(runtime),require=createRequire(import.meta.url);
const {wsServer:WebSocketServer}=require(join(dirname(dirname(runtime)),'playwright-core/lib/utilsBundle.js'));
const output=new URL('../privatework/direct-route-test-20261023/',import.meta.url);
await mkdir(output,{recursive:true});
const originalHTML=await readFile(new URL('../dist/watch.html',import.meta.url),'utf8');
const certDir=await mkdtemp(join(tmpdir(),'sameend-direct-route-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),'-subj','/CN=localhost'],{stdio:'ignore'});
let origin;
const roles=new Set(['source','helper','late','alone']);
const trackerStats={connections:0,announces:0,offersForwarded:{},answersForwarded:{},offersWithheld:{},answersWithheld:{}};
const report={schema:1,startedAt:new Date().toISOString(),buildSHA256:createHash('sha256').update(originalHTML).digest('hex'),environment:{oneComputer:true,isolatedChromeContexts:true,actualWebRTC:true,generatedPictureAndTone:true,localWssDiscovery:true,selfSignedCertificateOverride:true,autoplayOverride:true,physicalDevices:false,separateNetworks:false,natOr5gEmulation:false,turnConfigured:false,cloudMediaRelay:false},tracker:trackerStats,pass:false};
const server=https.createServer({key:await readFile(join(certDir,'key.pem')),cert:await readFile(join(certDir,'cert.pem'))},(req,res)=>{
 if(req.url.startsWith('/sw.js'))return res.writeHead(404).end();
 const role=req.url.slice(1).split(/[?#]/)[0];
 if(!roles.has(role))return res.writeHead(404).end();
 const trackerURL=origin.replace('https:','wss:')+'/tracker?role='+role;
 const html=originalHTML.replace(/wss:\/\/tracker\.[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_/-]*)?/g,trackerURL);
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}).end(html);
});
const tracker=new WebSocketServer({server,path:'/tracker'}),swarms=new Map();
const pair=(a,b)=>[a,b].sort().join('-');
let lateGateOpensAt=Infinity;
const allowed=(a,b)=>pair(a,b)==='helper-source'||(pair(a,b)==='helper-late'&&Date.now()>=lateGateOpensAt);
const count=(bucket,a,b)=>{const k=pair(a,b);bucket[k]=(bucket[k]||0)+1;};
const send=(socket,message)=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};
let trackerErrorCount=0;
tracker.on('connection',(socket,req)=>{
 const role=new URL(req.url,'https://local.invalid').searchParams.get('role');
 if(!roles.has(role)){socket.close();return;}
 trackerStats.connections++;socket.memberships=[];
 socket.on('error',()=>trackerErrorCount++);
 socket.on('message',raw=>{try{
  const m=JSON.parse(raw.toString());if(m.action!=='announce'||typeof m.info_hash!=='string'||typeof m.peer_id!=='string')return;
  trackerStats.announces++;let swarm=swarms.get(m.info_hash);if(!swarm){swarm=new Map();swarms.set(m.info_hash,swarm);}
  if(m.event==='stopped'){swarm.delete(m.peer_id);return;}
  swarm.set(m.peer_id,{socket,role});socket.memberships.push([m.info_hash,m.peer_id]);
  if(m.answer&&m.to_peer_id){const recipient=swarm.get(m.to_peer_id);if(!recipient)return;if(!allowed(role,recipient.role)){count(trackerStats.answersWithheld,role,recipient.role);return;}count(trackerStats.answersForwarded,role,recipient.role);send(recipient.socket,{action:'announce',info_hash:m.info_hash,peer_id:m.peer_id,offer_id:m.offer_id,answer:m.answer});return;}
  send(socket,{action:'announce',info_hash:m.info_hash,interval:120,complete:1,incomplete:Math.max(0,swarm.size-1)});
  const peers=[...swarm].filter(([id,p])=>id!==m.peer_id&&p.socket.readyState===1);let n=0;
  for(const [,p]of peers){if(!allowed(role,p.role)){if(m.offers?.length)count(trackerStats.offersWithheld,role,p.role);continue;}const offer=m.offers?.[n++];if(!offer)break;count(trackerStats.offersForwarded,role,p.role);send(p.socket,{action:'announce',info_hash:m.info_hash,peer_id:m.peer_id,offer_id:offer.offer_id,offer:offer.offer});}
 }catch{trackerErrorCount++;}});
 socket.on('close',()=>{for(const[hash,id]of socket.memberships){const swarm=swarms.get(hash);if(swarm?.get(id)?.socket===socket)swarm.delete(id);if(!swarm?.size)swarms.delete(hash);}});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='https://127.0.0.1:'+server.address().port;
assert(originalHTML.includes('wss://tracker.openwebtorrent.com'),'Built production tracker URL must be present');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--ignore-certificate-errors','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const contexts=[],pages={},pageErrors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms,message){const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await pause(250);}throw Error(message);}
async function page(role){const c=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});contexts.push(c);const p=await c.newPage();pages[role]=p;p.on('pageerror',()=>pageErrors.push(role));await p.goto(origin+'/'+role);await p.waitForFunction(()=>window.PrivateCast?.testing&&window.SameEndInviteCheck);await p.locator('#name').evaluate((el,name)=>el.value=name,'Synthetic '+role);return p;}
const snapshot=p=>p.evaluate(()=>{const s=PrivateCast.snapshot(),v=document.querySelector('#player');return {...s,frames:v.getVideoPlaybackQuality?.().totalVideoFrames||0,width:v.videoWidth,height:v.videoHeight,playing:!v.paused&&v.readyState>=2};});
const received=p=>until(async()=>{const s=await snapshot(p);return s.clockReady&&s.received>2&&s.supplier;},45000,'Verified signed media must reach viewer');
function identity(s){const c=s.config;return {id:c.id,epoch:c.epoch,delay:c.delay,sourceId:c.sourceId,sourceEpoch:c.sourceEpoch,programId:c.programId};}
let stage='setup';
try{
 stage='helper joins source';const source=await page('source');await source.evaluate(()=>PrivateCast.testing.startDemo({delay:10}));
 const invitation=await source.evaluate(()=>PrivateCast.testing.publishInvitation());
 const helper=await page('helper');await helper.evaluate(m=>PrivateCast.joinMagnet(m),invitation);await received(helper);
 const baseline={source:await snapshot(source),helper:await snapshot(helper)};
 assert.equal(baseline.helper.supplier.id,baseline.source.nodeId,'Helper must already receive from source');
 assert.equal(baseline.helper.sourceReachable,true);
 stage='late descriptor bootstrap';const late=await page('late');const joinedAt=Date.now();lateGateOpensAt=joinedAt+36000;
 await late.evaluate(m=>{window.lateJoin={settled:false};PrivateCast.joinMagnet(m).then(()=>lateJoin={settled:true,connected:true},()=>lateJoin={settled:true,connected:false});},invitation);
 await pause(35000);const waiting=await snapshot(late),pending=await late.evaluate(()=>lateJoin);
 assert.equal(waiting.config,null,'Descriptor must still be withheld beyond old 30 second timeout');assert.equal(pending.settled,false,'New join must keep waiting at 35 seconds');
 report.delayedDiscovery={allLateIntroductionsWithheldMs:36000,stillWaitingAt35Seconds:true,trackerIntervalSeconds:120};
 await until(()=>late.evaluate(()=>lateJoin.settled),60000,'Late join must settle within the new bounded discovery window');assert.equal(await late.evaluate(()=>lateJoin.connected),true,'Late join must succeed after delayed helper discovery');await received(late);
 stage='actual decoded late picture';await until(async()=>{const s=await snapshot(late);return s.playing&&s.frames>10&&s.width>0&&s.height>0;},45000,'Actual late-viewer video must decode');
 const before=await snapshot(late);await pause(3500);const after=await snapshot(late),sourceAfter=await snapshot(source),helperAfter=await snapshot(helper);
 assert(after.frames>before.frames+5,'Actual decoded video frames must advance');assert(after.received>before.received,'Further signed programme pieces must arrive');
 assert.equal(after.supplier.id,helperAfter.nodeId,'Late programme supplier must be family helper');
 assert.equal(helperAfter.supplier.id,sourceAfter.nodeId,'Helper must stay source-connected');
 assert.equal(after.sourceReachable,true);assert.equal(after.clockReady,true);assert.deepEqual(identity(after),identity(sourceAfter));
 assert(after.peers.some(p=>p.id===helperAfter.nodeId&&p.direction==='up'&&p.ready));
 assert(!after.peers.some(p=>p.id===sourceAfter.nodeId),'Late viewer cannot have a direct source application peer');
 assert(helperAfter.peers.some(p=>p.id===after.nodeId&&p.direction==='down'&&p.ready));
 assert(sourceAfter.peers.every(p=>p.id!==after.nodeId),'Source cannot have a direct late-viewer application peer');
 assert.equal(after.config.audio,true,'Encoded source audio track must be included');
 assert(sourceAfter.tracks.some(t=>t.kind==='audio'&&t.state==='live'),'Generated source must have a real live audio track');
 assert((trackerStats.offersWithheld['late-source']||0)>0,'Tracker must have deliberately withheld source/late introduction');
 assert((trackerStats.offersForwarded['helper-late']||0)>0);assert((trackerStats.answersForwarded['helper-late']||0)>0);
 assert.equal(trackerStats.offersForwarded['late-source']||0,0);assert.equal(trackerStats.answersForwarded['late-source']||0,0);
 stage='sanitized network facts';const check=await late.evaluate(()=>SameEndInviteCheck.report());
 assert.equal(check.joining.network.phase,'connected');assert.equal(check.joining.network.relayConfigured,false);assert.equal(check.joining.network.stunServerCount,2);assert(check.joining.network.reannounces>=2,'Bounded discovery must have reannounced while helper was withheld');
 assert.equal(check.joining.connectionMode,'direct-only');assert.equal(check.joining.relayFallbackConfigured,false);assert.equal(check.joining.descriptorLoaded,true);assert(check.joining.authenticatedPeerCount>=1);assert.equal(check.joining.audioTrackIncluded,true);
 // Browser version is deliberately allowed and can resemble an IPv4 address.
 const encodedCheck=JSON.stringify({...check,device:{...check.device,version:null,browserVersion:null}});assert(!/magnet:|#pc=|candidate:|v=0\r?\n|(?:\d{1,3}\.){3}\d{1,3}/.test(encodedCheck),'Device report must exclude invitations, SDP and IP addresses');
 report.positive={encryptedDescriptorLoadedFromOnlyPermittedHelper:true,signedProgrammeSupplierIsHelper:true,helperRemainsSourceConnected:true,noDirectSourceLatePeers:true,sourceReachable:true,sameCastEpochAndDelay:true,audioEncodedTrackIncluded:true,humanAudibilityClaim:false,decodedFramesBefore:before.frames,decodedFramesAfter:after.frames,receivedPiecesBefore:before.received,receivedPiecesAfter:after.received,joinToPlayingMs:Date.now()-joinedAt,networkFacts:{connectionMode:check.joining.connectionMode,relayFallbackConfigured:check.joining.relayFallbackConfigured,descriptorLoaded:check.joining.descriptorLoaded,authenticatedPeerCount:check.joining.authenticatedPeerCount,network:check.joining.network}};
 stage='no-helper negative control';const alone=await page('alone');await alone.evaluate(m=>{window.boundedJoin={settled:false};PrivateCast.joinMagnet(m).then(()=>boundedJoin={settled:true,connected:true},()=>boundedJoin={settled:true,connected:false});},invitation);
 await until(()=>Promise.resolve((trackerStats.offersWithheld['alone-source']||0)>0),20000,'Negative control must attempt discovery');
 await pause(6000);const noHelper=await snapshot(alone);assert.equal(noHelper.config,null);assert.equal(noHelper.received,0);assert.equal(noHelper.clockReady,false);assert.equal(noHelper.peers.length,0);
 assert.equal(trackerStats.offersForwarded['alone-helper']||0,0);assert.equal(trackerStats.offersForwarded['alone-source']||0,0);
 report.negative={noDiscoverableHelper:true,sourceIntroductionWithheld:true,descriptorLoaded:false,receivedPieces:0,connectedPeers:0,observationAfterFirstOfferMs:6000,abortedBeforeFullDiscoveryTimeout:true};
 await alone.context().close();assert.equal(trackerErrorCount,0);assert.deepEqual(pageErrors,[]);report.pass=true;
 console.log('PASS: encrypted descriptor and advancing signed programme via family helper; bounded no-helper control stays disconnected.');
}catch(e){report.failure={stage,message:e.name==='AssertionError'?e.message.split('\n')[0]:'Operation failed or timed out',errorType:e.name};console.error('FAIL at '+stage+': '+report.failure.message);process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();report.pageErrorRoles=pageErrors;report.trackerErrorCount=trackerErrorCount;await writeFile(new URL('browser-evidence.json',output),JSON.stringify(report,null,2));await browser.close();for(const socket of tracker.clients)socket.terminate();await new Promise(r=>tracker.close(r));await new Promise(r=>server.close(r));await rm(certDir,{recursive:true,force:true});}
