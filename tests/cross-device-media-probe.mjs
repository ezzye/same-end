/* Isolated, generated-media WebRTC probe. No real room, browser profile, or media.
 * The work directory is private and must not be synced; only sealed.json may be
 * transferred to the receiving device. status.json and result.json are aggregate.
 */
import {readFile, writeFile, mkdir, rename, access} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';

const args={};
for(let i=2;i<process.argv.length;i++){
  const k=process.argv[i];if(!/^--[a-z-]+$/.test(k)||i+1>=process.argv.length||process.argv[i+1].startsWith('--'))throw Error('Invalid probe arguments.');
  if(k in args)throw Error('Duplicate probe argument.');args[k]=process.argv[++i];
}
const allowed=new Set(['--role','--work-dir','--duration-seconds','--recipient-key','--private-key','--sealed-config','--html','--playwright','--chrome','--network-permission']);
if(Object.keys(args).some(k=>!allowed.has(k)))throw Error('Unknown probe argument.');
const role=args['--role'],seconds=Number(args['--duration-seconds']||180);
const networkPermission=args['--network-permission']||'default';if(!['default','grant'].includes(networkPermission))throw Error('Invalid test permission mode.');
if(!['source','viewer'].includes(role)||!args['--work-dir']||!Number.isInteger(seconds)||seconds<30||seconds>600)throw Error('Choose source/viewer, a private work directory, and a duration from 30 to 600 seconds.');
if(role==='source'&&!args['--recipient-key']||role==='viewer'&&(!args['--private-key']||!args['--sealed-config']))throw Error('Missing encryption inputs for this role.');
const directory=resolve(args['--work-dir']);await mkdir(directory,{recursive:true,mode:0o700});
const pageUrl='https://www.sameend.com/watch.html?synthetic-net-probe';
const playwrightPath=args['--playwright']||process.env.SAMEEND_PLAYWRIGHT||join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright','index.mjs');
let browser,context,page,observationDeadline=null;const sourceDeadline=Date.now()+480000;const result={schema:1,role,synthetic:true,physicalDevices:true,generatedMedia:true,realWebRTC:true,productionOrigin:true,durationSeconds:seconds,networkPermission,phase:'starting',samples:[],pass:false};
const bounded=(n,max=1000000000000)=>typeof n==='number'&&Number.isFinite(n)&&n>=0?Math.min(max,Math.round(n*1000)/1000):null;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function writeSafe(name,value){const tmp=join(directory,name+'.tmp');await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,join(directory,name));}
async function progress(phase,extra={}){result.phase=phase;Object.assign(result,extra);await writeSafe('status.json',result);console.log('Probe '+phase);}
async function sample(){
 return page.evaluate(async()=>{
  const s=window.PrivateCast?.snapshot?.()||{}, v=document.querySelector('#player'),n=s.network||s.transport?.network||{},a=s.transport?.availability||{};
  const finite=(x,max=1e12)=>typeof x==='number'&&Number.isFinite(x)&&x>=0?Math.min(x,max):null;
  const type=x=>['host','srflx','prflx','relay'].includes(x)?x:null;
  const protocol=x=>['udp','tcp'].includes(String(x).toLowerCase())?String(x).toLowerCase():null;
  const pcs=window.__probe?.connections||[],states={new:0,connecting:0,connected:0,disconnected:0,failed:0,closed:0};let selected=null;
  for(const pc of pcs){if(Object.hasOwn(states,pc.connectionState))states[pc.connectionState]++;try{const stats=await pc.getStats();for(const x of stats.values()){if(x.type!=='candidate-pair'||!(x.selected||x.nominated&&x.state==='succeeded'))continue;const l=stats.get(x.localCandidateId),r=stats.get(x.remoteCandidateId);selected={localType:type(l?.candidateType),remoteType:type(r?.candidateType),protocol:protocol(l?.protocol),bytesSent:finite(x.bytesSent),bytesReceived:finite(x.bytesReceived)};break;}}catch{}}
  const p=window.__probe||{};return {elapsedSeconds:finite((Date.now()-p.started)/1000,3600),joinState:['pending','descriptor-ready','failed'].includes(window.__joinResult)?window.__joinResult:null,role:['source','viewer'].includes(s.role)?s.role:null,configReady:!!s.config,clockReady:s.clockReady===true,sourceReachable:s.sourceReachable===true,verifiedPieces:finite(s.received,1e7),sentBytes:finite(s.sentBytes),mediaMode:['audio','v360','v480'].includes(s.mediaMode)?s.mediaMode:null,playbackMode:['hls','hls-native','mse','clips'].includes(s.playbackMode)?s.playbackMode:null,decodedFrames:finite(v?.getVideoPlaybackQuality?.().totalVideoFrames,1e9),droppedFrames:finite(v?.getVideoPlaybackQuality?.().droppedVideoFrames,1e9),width:finite(v?.videoWidth,10000),height:finite(v?.videoHeight,10000),playing:!!v&&!v.paused&&v.readyState>=2,bufferedSeconds:finite(s.bufferedSeconds,3600),reserveSeconds:finite(s.reserveSeconds,3600),relayLimit:finite(s.delivery?.relayLimit,2),forwardingCount:finite(s.delivery?.peers?.length,12),authenticatedPeers:finite(a.authenticatedPeers,12),rootedSuppliers:finite(a.rootedSuppliers,12),fullSuppliers:finite(a.fullSuppliers,12),eligibleSuppliers:finite(a.eligibleSuppliers,12),reject:['capacity-full','source-unavailable','not-ready','loop','invalid-status'].includes(a.lastReject)?a.lastReject:null,trackerReplies:finite(n.trackerReplies,10000),peerAttempts:finite(n.peerAttempts,10000),peerErrors:finite(n.peerErrors,10000),iceConnected:finite(n.iceConnected,10000),iceFailed:finite(n.iceFailed,10000),pcStates:states,pcEvents:p.pcEvents||null,iceEvents:p.iceEvents||null,iceCandidateTypes:{host:p.candidates?.host||0,srflx:p.candidates?.srflx||0,prflx:p.candidates?.prflx||0,relay:p.candidates?.relay||0},iceErrors:finite(p.iceErrors,10000),selected};
 });
}
try{
 await progress('loading');
 let html;
 if(args['--html'])html=await readFile(args['--html'],'utf8');else{const response=await fetch('https://www.sameend.com/watch.html',{redirect:'error',signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error('Fixture fetch failed.');html=await response.text();}
 if(html.length>12000000||!html.includes('PrivateCast')||!html.includes('SameEnd'))throw Error('Unsupported fixture.');result.fixtureSha256=createHash('sha256').update(html).digest('hex');
 const {chromium}=await import(pathToFileURL(resolve(playwrightPath)).href);
 browser=await chromium.launch({headless:true,...(args['--chrome']?{executablePath:args['--chrome']}:{channel:'chrome'}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 context=await browser.newContext({serviceWorkers:'block'});
 if(networkPermission==='grant')await context.grantPermissions(['local-network-access'],{origin:'https://www.sameend.com'});
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(req.method()==='GET'&&url.origin==='https://www.sameend.com'&&url.pathname==='/watch.html'&&url.search==='?synthetic-net-probe')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});return route.abort();});
 // Restrict browser WebSockets to the application's public introduction services.
 if(typeof context.routeWebSocket!=='function')throw Error('Playwright WebSocket isolation unavailable.');
 await context.routeWebSocket('**/*',ws=>{let u;try{u=new URL(ws.url());}catch{return ws.close();}if(u.protocol==='wss:'&&['tracker.openwebtorrent.com','tracker.webtorrent.dev'].includes(u.hostname)&&(!u.port||u.port==='443'))ws.connectToServer();else ws.close();});
 await context.addInitScript(()=>{
  const Original=window.RTCPeerConnection,p={started:Date.now(),connections:[],candidates:{host:0,srflx:0,prflx:0,relay:0},iceErrors:0,pcEvents:{new:0,connecting:0,connected:0,disconnected:0,failed:0,closed:0},iceEvents:{new:0,checking:0,connected:0,completed:0,disconnected:0,failed:0,closed:0}};window.__probe=p;
  window.RTCPeerConnection=new Proxy(Original,{construct(target,args,newTarget){const pc=Reflect.construct(target,args,newTarget);p.connections.push(pc);pc.addEventListener('connectionstatechange',()=>{const t=pc.connectionState;if(Object.hasOwn(p.pcEvents,t))p.pcEvents[t]=Math.min(10000,p.pcEvents[t]+1);});pc.addEventListener('iceconnectionstatechange',()=>{const t=pc.iceConnectionState;if(Object.hasOwn(p.iceEvents,t))p.iceEvents[t]=Math.min(10000,p.iceEvents[t]+1);});pc.addEventListener('icecandidate',e=>{const t=e.candidate?.type;if(Object.hasOwn(p.candidates,t))p.candidates[t]=Math.min(10000,p.candidates[t]+1);});pc.addEventListener('icecandidateerror',()=>{p.iceErrors=Math.min(10000,p.iceErrors+1);});return pc;}});
 });
 page=await context.newPage();await page.goto(pageUrl,{waitUntil:'domcontentloaded',timeout:30000});
 result.permissionStates=await page.evaluate(async()=>{const out={};for(const name of ['local-network-access','local-network','loopback-network']){try{const s=await navigator.permissions.query({name});out[name]=['granted','prompt','denied'].includes(s.state)?s.state:'unknown';}catch{out[name]='unsupported';}}return out;});await page.waitForFunction(()=>window.PrivateCast?.testing&&window.SameEndInviteCheck,null,{timeout:20000});
 if(role==='source'){
  await progress('starting-generated-source');await page.evaluate(()=>PrivateCast.testing.startDemo({delay:10,profile:'hls'}));
  const invitation=await page.evaluate(()=>PrivateCast.testing.publishInvitation());if(typeof invitation!=='string'||!invitation.startsWith('magnet:?'))throw Error('No generated invitation.');
  const {sealProbe}=await import('./helpers/sealed-probe.mjs');const now=Date.now(),payload={kind:'generated-same-end-test',mode:'magnet',invite:invitation,createdAt:now,expiresAt:Math.min(now+seconds*1000,sourceDeadline)};
  observationDeadline=payload.expiresAt;const sealed=await sealProbe(payload,args['--recipient-key']);await writeSafe('sealed.json',sealed);await progress('sealed-invitation-ready');
 }else{
  const {openProbe}=await import('./helpers/sealed-probe.mjs');const envelope=JSON.parse(await readFile(args['--sealed-config'],'utf8')),key=await readFile(args['--private-key'],'utf8'),payload=await openProbe(envelope,key);
  if(payload?.kind!=='generated-same-end-test'||payload.mode!=='magnet'||typeof payload.invite!=='string'||!payload.invite.startsWith('magnet:?')||!Number.isFinite(payload.createdAt)||!Number.isFinite(payload.expiresAt)||payload.expiresAt<=Date.now()||payload.createdAt>Date.now()+60000||payload.expiresAt-payload.createdAt>600000)throw Error('Invalid or expired sealed fixture.');
  observationDeadline=payload.expiresAt-3000;if(observationDeadline-Date.now()<30000)throw Error('Insufficient source time remaining.');await progress('joining');await page.evaluate(invite=>{window.__joinResult='pending';PrivateCast.joinMagnet(invite).then(()=>window.__joinResult='descriptor-ready',()=>window.__joinResult='failed');},payload.invite);
 }
 await progress('observing');const end=Math.min(Date.now()+seconds*1000,observationDeadline);
 let stopped=false;while(Date.now()<end){try{await access(join(directory,'stop.request'));stopped=true;break;}catch{}const entry=await sample();result.samples.push(entry);if(result.samples.length>125)result.samples.shift();await writeSafe('status.json',result);await wait(Math.min(5000,Math.max(0,end-Date.now())));}
 const last=await sample();result.samples.push(last);const initial=result.samples.find(x=>x.decodedFrames!==null&&x.playing);result.pass=role==='source'?last.role==='source'&&last.configReady:!!initial&&last.clockReady&&last.sourceReachable&&last.verifiedPieces>2&&last.playing&&last.decodedFrames>initial.decodedFrames+10;
 result.phase=stopped?'stopped':'complete';result.summary={observedFramesAdvance:!!initial&&last.decodedFrames>initial.decodedFrames+10,clockReady:last.clockReady,sourceReachable:last.sourceReachable,verifiedPieces:bounded(last.verifiedPieces,1e7),width:bounded(last.width,10000),height:bounded(last.height,10000)};await writeSafe('result.json',result);await writeSafe('status.json',result);console.log(stopped?'Probe stopped cleanly.':result.pass?'Probe complete: observation criteria met.':'Probe complete: observation criteria not met.');if(!result.pass&&!stopped)process.exitCode=1;
}catch(error){const failedAt=result.phase;result.phase='failed';result.failure={failedAt,category:error?.name==='TimeoutError'?'timeout':'probe-error',name:['Error','TypeError','TimeoutError','AbortError'].includes(error?.name)?error.name:'Error',code:['ENOENT','EACCES','EPERM','ECONNRESET','ETIMEDOUT','ENOTFOUND','ERR_MODULE_NOT_FOUND','ERR_INVALID_URL'].includes(error?.code)?error.code:null};await writeSafe('result.json',result);await writeSafe('status.json',result);console.error('Probe failed; see sanitised status.');process.exitCode=1;}
finally{await context?.close().catch(()=>{});await browser?.close().catch(()=>{});}
