/* Four isolated browser contexts on one Mac, generated HLS media and local
 * discovery; run after npm run build:resilience. This is not acceptance on
 * physical devices or separate networks. Late peers can only discover the helper.
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const runtime=process.env.SAMEEND_PLAYWRIGHT||(process.env.HOME||process.env.USERPROFILE)+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(runtime),require=createRequire(import.meta.url);
const {wsServer:WebSocketServer}=require(join(dirname(dirname(runtime)),'playwright-core/lib/utilsBundle.js'));
const output=new URL('../privatework/manual-invitation-browser/',import.meta.url);
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
 stage='source and viewers';console.log('Stage: '+stage);const source=await page('source');await source.evaluate(()=>PrivateCast.testing.startDemo({delay:10,profile:'hls'}));
 const invitation=await source.evaluate(()=>PrivateCast.testing.publishInvitation());const helper=await page('helper');await helper.evaluate(m=>PrivateCast.joinMagnet(m),invitation);await received(helper);
 const phone=await page('phone');await phone.evaluate(m=>PrivateCast.joinMagnet(m),invitation);await received(phone);
 await until(async()=>(await snapshot(source)).peers.filter(p=>p.direction==='down'&&p.ready).length===2,30000,'Source should have two ready viewers');
 await source.locator('#invite').evaluate(el=>{for(let node=el.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;});await helper.locator('#invite').evaluate(el=>{for(let node=el.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;});
 assert(await source.locator('#invite').isDisabled(),'Source manual invitation must be disabled when full');const sourceStatus=await source.locator('#manual-invite-status').innerText();console.log('Source availability:',sourceStatus);assert.match(sourceStatus,/All outgoing picture slots/);assert(await helper.locator('#invite').isEnabled(),'Helper manual invitation must be enabled');
 stage='visible preparation failure';console.log('Stage: '+stage);await helper.evaluate(()=>{window.testCreateOffer=RTCPeerConnection.prototype.createOffer;RTCPeerConnection.prototype.createOffer=async()=>{throw Error('Synthetic offer failure');};});await helper.locator('#invite').click();await helper.waitForFunction(()=>document.querySelector('#manual-invite-status').textContent.includes('Synthetic offer failure'),null,{timeout:10000});assert(await helper.locator('#manual-invite-status').isVisible(),'Failure must be visible beside the invitation button');await helper.evaluate(()=>{RTCPeerConnection.prototype.createOffer=window.testCreateOffer;delete window.testCreateOffer;});assert(await helper.locator('#invite').isEnabled());
 stage='manual offer';console.log('Stage: '+stage);await helper.locator('#invite').click();await helper.waitForFunction(()=>!!document.querySelector('#outgoing').value&&document.querySelector('#invite').textContent==='Show invitation file',null,{timeout:20000});
 assert(await helper.locator('#cancel-offer').isVisible(),'Cancel must be visible beside the invitation button');const buttonBox=await helper.locator('#invite').boundingBox(),feedbackBox=await helper.locator('#manual-invite-status').boundingBox(),cancelBox=await helper.locator('#cancel-offer').boundingBox();const left=Math.min(buttonBox.x,cancelBox.x,feedbackBox.x),top=Math.min(buttonBox.y,cancelBox.y),right=Math.max(buttonBox.x+buttonBox.width,cancelBox.x+cancelBox.width,feedbackBox.x+feedbackBox.width),bottom=feedbackBox.y+feedbackBox.height;await helper.screenshot({path:fileURLToPath(new URL('manual-controls.png',output)),clip:{x:left,y:top,width:right-left,height:bottom-top}});const originalCode=await helper.locator('#outgoing').inputValue(),count=(await snapshot(helper)).peers.length;await helper.evaluate(()=>document.querySelector('#outgoing-wrap').classList.add('hidden'));await helper.locator('#invite').click();assert(await helper.locator('#outgoing-wrap').isVisible(),'Existing invitation must reopen');assert.equal(await helper.locator('#outgoing').inputValue(),originalCode,'Reopen must retain the same invitation');assert.equal((await snapshot(helper)).peers.length,count,'Reopen must not create another peer');
 const offerEvent=helper.waitForEvent('download');await helper.evaluate(()=>document.querySelector('#save-code').click());const offer=await offerEvent;const offerPath=new URL('offer.castinvite',output);await offer.saveAs(fileURLToPath(offerPath));
 const late=await page('late');await late.evaluate(()=>PrivateCast.testing.startDemo({delay:10,profile:'hls'}));await late.locator('#import-file').evaluate(el=>{for(let node=el.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;});stage='same file retry';console.log('Stage: '+stage);await late.locator('#import-file').setInputFiles(fileURLToPath(offerPath));await late.waitForFunction(()=>document.querySelector('#manual-file-status')?.textContent.includes('Leave your current cast'),null,{timeout:10000});assert(await late.locator('#manual-file-status').isVisible(),'File error should appear beside the chooser');assert.equal(await late.locator('#import-file').inputValue(),'','Rejected file selection must reset');assert(await late.locator('#confirm').evaluate(el=>el.classList.contains('hidden')),'Rejected file must not open confirmation');await late.evaluate(()=>document.querySelector('#stop').click());await late.waitForFunction(()=>!PrivateCast.snapshot().config,null,{timeout:15000});await late.locator('#import-file').setInputFiles(fileURLToPath(offerPath));await late.waitForFunction(()=>!document.querySelector('#confirm').classList.contains('hidden'),null,{timeout:10000});await late.evaluate(()=>document.querySelector('#approve').click());await late.waitForFunction(()=>!!document.querySelector('#outgoing').value,null,{timeout:20000});
 const replyEvent=late.waitForEvent('download');await late.evaluate(()=>document.querySelector('#save-code').click());const reply=await replyEvent;const replyPath=new URL('reply.castreplay',output);await reply.saveAs(fileURLToPath(replyPath));
 await helper.locator('#import-file').setInputFiles(fileURLToPath(replyPath));await helper.waitForFunction(()=>!document.querySelector('#confirm').classList.contains('hidden'),null,{timeout:10000});await helper.evaluate(()=>document.querySelector('#approve').click());
 stage='manual media';console.log('Stage: '+stage);await received(late);await until(async()=>{const s=await snapshot(late);return s.frames>10&&s.width>0;},45000,'Manual viewer must decode picture');
 const a=await snapshot(late),h=await snapshot(helper);assert(a.peers.some(p=>p.direction==='up'&&p.ready),'Manual viewer must receive from its manual connection');assert(h.peers.some(p=>p.direction==='down'&&p.ready),'Helper must serve manual connection');
 report.observation={sourceTwoSlotsFull:true,sourceManualInviteDisabled:true,helperManualInviteEnabled:true,offerFileSavedAndAccepted:true,replyFileSavedAndAccepted:true,pendingReopenedWithoutNewOffer:true,visiblePreparationFailure:true,sameFileRetryAfterLeaving:true,receiverClockReady:a.clockReady,verifiedPieces:a.received,decodedFrames:a.frames,pictureWidth:a.width,helperForwards:true};report.pass=true;console.log('PASS: manual file exchange yielded signed media and decoded picture.');
}catch(e){report.failure={stage,errorType:e.name,message:e.name==='AssertionError'?e.message.split('\n')[0]:'Operation failed or timed out'};console.error('FAIL at '+stage+': '+report.failure.message);process.exitCode=1;}
finally{await rm(new URL('offer.castinvite',output),{force:true});await rm(new URL('reply.castreplay',output),{force:true});report.pageErrorRoles=pageErrors;report.trackerErrorCount=trackerErrorCount;await writeFile(new URL('browser-evidence.json',output),JSON.stringify(report,null,2));await browser.close();for(const socket of tracker.clients)socket.terminate();await new Promise(r=>tracker.close(r));await new Promise(r=>server.close(r));await rm(certDir,{recursive:true,force:true});}
