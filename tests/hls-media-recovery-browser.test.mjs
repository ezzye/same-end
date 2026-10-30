/* Two isolated browser contexts on one Mac, generated HLS media and local
 * discovery; run after npm run build:resilience. A synthetic fatal media marker
 * and controlled seek exercise real HLS recovery, not an actual codec/NAT fault.
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const runtime=process.env.SAMEEND_PLAYWRIGHT||(process.env.HOME||process.env.USERPROFILE)+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(runtime),require=createRequire(import.meta.url);
const {wsServer:WebSocketServer}=require(join(dirname(dirname(runtime)),'playwright-core/lib/utilsBundle.js'));
const output=new URL('../privatework/hls-recovery-browser/',import.meta.url);
await mkdir(output,{recursive:true});
const originalHTML=await readFile(new URL('../dist/watch.html',import.meta.url),'utf8');
const certDir=await mkdtemp(join(tmpdir(),'sameend-direct-route-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),'-subj','/CN=localhost'],{stdio:'ignore'});
let origin;
const roles=new Set(['source','helper','phone','early','late']);
const trackerStats={connections:0,announces:0,offersForwarded:{},answersForwarded:{},offersWithheld:{},answersWithheld:{}};
const report={schema:1,startedAt:new Date().toISOString(),buildSHA256:createHash('sha256').update(originalHTML).digest('hex'),environment:{oneComputer:true,isolatedChromeContexts:true,actualWebRTC:true,generatedPictureAndTone:true,localWssDiscovery:true,selfSignedCertificateOverride:true,autoplayOverride:true,physicalDevices:false,separateNetworks:false,natOr5gEmulation:false,turnConfigured:false,cloudMediaRelay:false},tracker:trackerStats,pass:false};
const server=https.createServer({key:await readFile(join(certDir,'key.pem')),cert:await readFile(join(certDir,'cert.pem'))},(req,res)=>{
 if(req.url.startsWith('/sw.js'))return res.writeHead(404).end();
 const role=req.url.slice(1).split(/[?#]/)[0];
 if(!roles.has(role))return res.writeHead(404).end();
 const trackerURL=origin.replace('https:','wss:')+'/tracker?role='+role;
 let html=originalHTML.replace(/wss:\/\/tracker\.[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_/-]*)?/g,trackerURL).replaceAll('stun:stun.l.google.com:19302','stun:127.0.0.1:9').replaceAll('stun:stun.cloudflare.com:3478','stun:127.0.0.1:9');
 const hashes=[...new Set([...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([,attrs,source])=>source.trim()&&!/\bsrc\s*=|id=["']webtorrent-license["']|type=["']application\/json["']/i.test(attrs)).map(([,attrs,source])=>"'sha256-"+createHash('sha256').update(source.replace(/\r\n?/g,'\n')).digest('base64')+"'"))];
 html=html.replace(/script-src 'self' [^;]+;/,"script-src 'self' "+hashes.join(' ')+';');
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}).end(html);
});
const tracker=new WebSocketServer({server,path:'/tracker'}),swarms=new Map();
const pair=(a,b)=>[a,b].sort().join('-');
const allowed=(a,b)=>['helper-source','phone-source','early-helper','helper-late'].includes(pair(a,b));
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
async function page(role){const c=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',...(role==='phone'?{userAgent:'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'}:{})});contexts.push(c);await c.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());const p=await c.newPage();pages[role]=p;p.on('pageerror',()=>pageErrors.push(role));await p.goto(origin+'/'+role);await p.waitForFunction(()=>window.PrivateCast?.testing&&window.SameEndInviteCheck,null,{timeout:15000});await p.locator('#name').evaluate((el,name)=>el.value=name,'Synthetic '+role);return p;}
const snapshot=p=>p.evaluate(()=>{const s=PrivateCast.snapshot(),v=document.querySelector('#player');return {...s,frames:v.getVideoPlaybackQuality?.().totalVideoFrames||0,width:v.videoWidth,height:v.videoHeight,playing:!v.paused&&v.readyState>=2};});
const received=p=>until(async()=>{const s=await snapshot(p);return s.clockReady&&s.received>2&&s.supplier;},45000,'Verified signed media must reach viewer');
function identity(s){const c=s.config;return {id:c.id,epoch:c.epoch,delay:c.delay,sourceId:c.sourceId,sourceEpoch:c.sourceEpoch,programId:c.programId};}
let stage='setup';
try {
 stage='source and viewer';console.log('Stage: '+stage);const source=await page('source');await source.evaluate(()=>PrivateCast.testing.startDemo({delay:10,profile:'hls'}));const invitation=await source.evaluate(()=>PrivateCast.testing.publishInvitation());const helper=await page('helper');
 await helper.evaluate(()=>{const proto=SameEndHLS.HlsPlayer.prototype,original=proto.sync;proto.sync=function(...args){if(this.video===document.querySelector('#player'))window.testPicture=this;return original.apply(this,args);};});
 await helper.evaluate(m=>PrivateCast.joinMagnet(m),invitation);await received(helper);await until(async()=>{const s=await snapshot(helper);return s.frames>40&&s.playing&&s.width>0;},45000,'Viewer must decode picture');
 const before=await snapshot(helper),sourceBefore=await snapshot(source);assert.equal(before.supplier.id,sourceBefore.nodeId);const ready=await helper.evaluate(()=>{const p=window.testPicture;if(!p||!p.hls||typeof p.hls.recoverMediaError!=='function'||p.video!==document.querySelector('#player'))return false;window.hlsRecoveryTest={calls:0,forcedSeekActions:0};const original=p.hls.recoverMediaError;p.hls.recoverMediaError=function(...args){window.hlsRecoveryTest.calls++;return original.apply(this,args);};return true;});assert(ready,'Actual HlsPlayer with recovery API required');
 stage='healthy control';console.log('Stage: '+stage);await pause(3500);assert.equal(await helper.evaluate(()=>hlsRecoveryTest.calls),0,'Healthy playback must not invoke recovery');const healthy=await snapshot(helper);assert(healthy.frames>before.frames+10,'Healthy frames advance');
 stage='synthetic fatal marker and seek';console.log('Stage: '+stage);await helper.evaluate(()=>{const p=window.testPicture,originalUpdate=p.adaptive.update;p.adaptive.update=function(input){const result=originalUpdate.call(this,input);p.adaptive.update=originalUpdate;window.hlsRecoveryTest.forcedSeekActions++;return {...result,seek:Number.isFinite(input.actual)?input.actual:input.nominal,play:false,waiting:true};};p.hls.stopLoad();p.lastRecoveryAttempt=-Infinity;p.lastFatalType='mediaError';});
 await until(()=>helper.evaluate(()=>hlsRecoveryTest.calls>=1&&hlsRecoveryTest.forcedSeekActions===1),10000,'Synthetic fatal media marker must trigger actual HLS recovery despite seek');const immediately=await snapshot(helper);await until(async()=>{const s=await snapshot(helper);return s.frames>immediately.frames+20&&s.playing;},45000,'Decoded picture must advance after actual media reset');const after=await snapshot(helper),sourceAfter=await snapshot(source);assert.equal(after.supplier.id,sourceAfter.nodeId,'Viewer must retain its supplying peer');assert(after.received>healthy.received,'Verified media must continue arriving');
 report.observation={syntheticFatalMarker:true,syntheticSeekAction:true,actualHlsRecoveryInvoked:true,healthyRecoveryCalls:0,decodedFramesBefore:healthy.frames,decodedFramesAfter:after.frames,verifiedPiecesBefore:healthy.received,verifiedPiecesAfter:after.received,upstreamRetained:true};report.pass=true;console.log('PASS: real HLS reset, picture and peer recovered after synthetic fatal marker.');
}catch(e){report.failure={stage,errorType:e.name,message:e.name==='AssertionError'?e.message.split('\n')[0]:'Operation failed or timed out'};console.error('FAIL at '+stage+': '+report.failure.message);process.exitCode=1;}
finally{report.pageErrorRoles=pageErrors;report.trackerErrorCount=trackerErrorCount;await writeFile(new URL('browser-evidence.json',output),JSON.stringify(report,null,2));await browser.close();for(const socket of tracker.clients)socket.terminate();await new Promise(r=>tracker.close(r));await new Promise(r=>server.close(r));await rm(certDir,{recursive:true,force:true});}
