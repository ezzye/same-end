/* Isolated, generated-data WebRTC control. No app, real room, or browser profile.
 * Only sealed.json may be transferred. Other output contains aggregate facts.
 */
import {readFile,writeFile,mkdir,rename,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';

const args={};for(let i=2;i<process.argv.length;i++){const k=process.argv[i];if(!/^--[a-z-]+$/.test(k)||i+1>=process.argv.length||process.argv[i+1].startsWith('--')||k in args)throw Error('Invalid probe arguments.');args[k]=process.argv[++i];}
const allowed=new Set(['--role','--work-dir','--duration-seconds','--recipient-key','--private-key','--sealed-config','--playwright','--chrome','--network-permission']);
if(Object.keys(args).some(k=>!allowed.has(k)))throw Error('Unknown probe argument.');
const role=args['--role'],seconds=Number(args['--duration-seconds']||180);
const networkPermission=args['--network-permission']||'default';if(!['default','grant'].includes(networkPermission))throw Error('Invalid test permission mode.');
if(!['source','viewer'].includes(role)||!args['--work-dir']||!Number.isInteger(seconds)||seconds<30||seconds>600)throw Error('Choose source/viewer, a private work directory and duration from 30 to 600 seconds.');
if(role==='source'&&!args['--recipient-key']||role==='viewer'&&(!args['--private-key']||!args['--sealed-config']))throw Error('Missing encryption inputs.');
const directory=resolve(args['--work-dir']);await mkdir(directory,{recursive:true,mode:0o700});
const playwrightPath=args['--playwright']||process.env.SAMEEND_PLAYWRIGHT||join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright','index.mjs');
const fixture='https://www.sameend.com/watch.html?synthetic-rtc-probe',deadline=Date.now()+480000;
let browser,context,page,expiry;const result={schema:1,role,synthetic:true,generatedData:true,actualWebRTC:true,productionOrigin:true,networkPermission,phase:'starting',samples:[],pass:false};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function writeSafe(name,value){const tmp=join(directory,name+'.tmp');await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,join(directory,name));}
async function progress(phase){result.phase=phase;await writeSafe('status.json',result);console.log('Probe '+phase);}
try{
 await progress('loading');
 const {chromium}=await import(pathToFileURL(resolve(playwrightPath)).href);
 browser=await chromium.launch({headless:true,...(args['--chrome']?{executablePath:args['--chrome']}:{channel:'chrome'}),args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 context=await browser.newContext({serviceWorkers:'block'});
 if(networkPermission==='grant')await context.grantPermissions(['local-network-access'],{origin:'https://www.sameend.com'});
 await context.route('**/*',r=>{const q=r.request();return q.method()==='GET'&&q.url()===fixture?r.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><title>Generated WebRTC control</title>',headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}}):r.abort();});
 if(typeof context.routeWebSocket!=='function')throw Error('WebSocket isolation unavailable.');
 await context.routeWebSocket('**/*',ws=>{let u;try{u=new URL(ws.url());}catch{return ws.close();}if(u.protocol==='wss:'&&['tracker.openwebtorrent.com','tracker.webtorrent.dev'].includes(u.hostname)&&(!u.port||u.port==='443'))ws.connectToServer();else ws.close();});
 page=await context.newPage();await page.goto(fixture,{waitUntil:'domcontentloaded',timeout:30000});
 result.permissionStates=await page.evaluate(async()=>{const out={};for(const name of ['local-network-access','local-network','loopback-network']){try{const s=await navigator.permissions.query({name});out[name]=['granted','prompt','denied'].includes(s.state)?s.state:'unknown';}catch{out[name]='unsupported';}}return out;});
 let payload;
 if(role==='source'){
  const {sealProbe}=await import('./helpers/sealed-probe.mjs'),now=Date.now();payload={kind:'generated-same-end-test',mode:'raw-rtc',infoHashBase64:randomBytes(20).toString('base64'),createdAt:now,expiresAt:Math.min(now+seconds*1000,deadline)};
  await writeSafe('sealed.json',await sealProbe(payload,args['--recipient-key']));expiry=payload.expiresAt;await progress('sealed-config-ready');
 }else{
  const {openProbe}=await import('./helpers/sealed-probe.mjs');payload=await openProbe(JSON.parse(await readFile(args['--sealed-config'],'utf8')),await readFile(args['--private-key'],'utf8'));
  if(payload?.kind!=='generated-same-end-test'||payload.mode!=='raw-rtc'||typeof payload.infoHashBase64!=='string'||!/^[A-Za-z0-9+/]{27}=$/.test(payload.infoHashBase64)||Buffer.from(payload.infoHashBase64,'base64').length!==20||!Number.isFinite(payload.createdAt)||!Number.isFinite(payload.expiresAt)||payload.createdAt>Date.now()+60000||payload.expiresAt<=Date.now()||payload.expiresAt-payload.createdAt>480000)throw Error('Invalid or expired sealed fixture.');
  expiry=payload.expiresAt-3000;if(expiry-Date.now()<30000)throw Error('Insufficient source time remaining.');
 }
 await page.evaluate(({role,hash64})=>{
  const raw=b=>Array.from(b,x=>String.fromCharCode(x)).join(''),random=()=>raw(crypto.getRandomValues(new Uint8Array(20)));
  const hash=atob(hash64),peer=random(),trackers=['wss://tracker.openwebtorrent.com','wss://tracker.webtorrent.dev'],servers=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}];
  const counts={trackerConnections:0,trackerReplies:0,announces:0,offersSent:0,offersReceived:0,answersSent:0,answersReceived:0,remoteDescriptionsApplied:0,signallingErrors:0,iceErrors:0,iceErrorCodes:{},gatherCompleted:0,gatherTimedOut:0,channelsOpened:0,packetsSent:0,packetsReceived:0,acksReceived:0,bytesSent:0,bytesReceived:0,localCandidates:{host:0,srflx:0,prflx:0,relay:0},remoteCandidates:{host:0,srflx:0,prflx:0,relay:0}};
  const sockets=[],pcs=[],offers=new Map(),bounded=n=>Math.min(1000000000,n+1);let stopped=false,connected=false;
  const candidateType=(target,sdp)=>{for(const m of String(sdp||'').matchAll(/(?:^|\r?\n)a=candidate:[^\r\n]* typ (host|srflx|prflx|relay)(?: |\r|\n|$)/g)){target[m[1]]=bounded(target[m[1]]);}};
  const send=(ws,msg)=>{if(ws.readyState!==WebSocket.OPEN)return false;try{ws.send(JSON.stringify(msg));return true;}catch{counts.signallingErrors=bounded(counts.signallingErrors);return false;}};
  const announce=(ws,extra={})=>{if(send(ws,{action:'announce',info_hash:hash,peer_id:peer,uploaded:0,downloaded:0,left:1,numwant:role==='viewer'?0:1,...extra}))counts.announces=bounded(counts.announces);};
  function connectChannel(dc){dc.binaryType='arraybuffer';dc.onopen=()=>{connected=true;counts.channelsOpened=bounded(counts.channelsOpened);const packet=new Uint8Array(4096);crypto.getRandomValues(packet);dc.timer=setInterval(()=>{if(dc.readyState==='open'&&dc.bufferedAmount<262144){dc.send(packet);counts.packetsSent=bounded(counts.packetsSent);counts.bytesSent=Math.min(1e12,counts.bytesSent+packet.length);}},250);};dc.onmessage=e=>{if(typeof e.data==='string'){if(e.data==='a')counts.acksReceived=bounded(counts.acksReceived);return;}const size=e.data?.byteLength||0;if(size>0&&size<=4096){counts.packetsReceived=bounded(counts.packetsReceived);counts.bytesReceived=Math.min(1e12,counts.bytesReceived+size);if(dc.readyState==='open')dc.send('a');}};dc.onclose=()=>clearInterval(dc.timer);}
  function connection(){const pc=new RTCPeerConnection({iceServers:servers});pc.__probeCreatedAt=Date.now();pcs.push(pc);pc.addEventListener('icecandidate',e=>{const t=e.candidate?.type;if(Object.hasOwn(counts.localCandidates,t))counts.localCandidates[t]=bounded(counts.localCandidates[t]);});pc.addEventListener('icecandidateerror',e=>{counts.iceErrors=bounded(counts.iceErrors);const code=Number.isInteger(e.errorCode)&&e.errorCode>=0&&e.errorCode<=999?String(e.errorCode):'unknown';counts.iceErrorCodes[code]=bounded(counts.iceErrorCodes[code]||0);});pc.ondatachannel=e=>connectChannel(e.channel);return pc;}
  async function gather(pc){if(pc.iceGatheringState==='complete'){counts.gatherCompleted=bounded(counts.gatherCompleted);return;}await new Promise(resolve=>{const timer=setTimeout(done,10000);function done(){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);resolve();}function changed(){if(pc.iceGatheringState==='complete')done();}pc.addEventListener('icegatheringstatechange',changed);});if(pc.iceGatheringState==='complete')counts.gatherCompleted=bounded(counts.gatherCompleted);else counts.gatherTimedOut=bounded(counts.gatherTimedOut);}
  function prune(){const now=Date.now();if(role==='viewer')for(const pc of pcs)if(pc.connectionState!=='connected'&&pc.connectionState!=='closed'&&(pc.connectionState==='failed'||now-pc.__probeCreatedAt>60000))pc.close();for(const [id,entry] of offers)if(now-entry.created>60000&&!entry.connected){entry.pc.close();offers.delete(id);}while(offers.size>12){const [id,entry]=offers.entries().next().value;entry.pc.close();offers.delete(id);}}
  async function makeOffer(ws){if(stopped||connected||ws.readyState!==WebSocket.OPEN)return;prune();const pc=connection(),id=random(),entry={pc,ws,created:Date.now(),connected:false};offers.set(id,entry);pc.addEventListener('connectionstatechange',()=>{if(pc.connectionState==='connected')entry.connected=true;});try{connectChannel(pc.createDataChannel('generated-control',{ordered:true}));await pc.setLocalDescription(await pc.createOffer());await gather(pc);if(stopped||pc.signalingState!=='have-local-offer')return;const offer=pc.localDescription?.toJSON();if(offer&&send(ws,{action:'announce',info_hash:hash,peer_id:peer,uploaded:0,downloaded:0,left:1,numwant:1,offers:[{offer,offer_id:id}]})){counts.announces=bounded(counts.announces);counts.offersSent=bounded(counts.offersSent);}}catch{counts.signallingErrors=bounded(counts.signallingErrors);pc.close();offers.delete(id);}}
  async function handle(ws,m){if(!m||m.action!=='announce'||m.info_hash!==hash)return;counts.trackerReplies=bounded(counts.trackerReplies);
   if(role==='viewer'&&m.offer&&typeof m.peer_id==='string'&&m.peer_id.length===20&&typeof m.offer_id==='string'&&m.offer_id.length===20){counts.offersReceived=bounded(counts.offersReceived);if(connected||pcs.filter(p=>p.connectionState!=='closed').length>=12)return;const pc=connection();try{candidateType(counts.remoteCandidates,m.offer.sdp);await pc.setRemoteDescription(m.offer);counts.remoteDescriptionsApplied=bounded(counts.remoteDescriptionsApplied);await pc.setLocalDescription(await pc.createAnswer());await gather(pc);const answer=pc.localDescription?.toJSON();if(answer&&send(ws,{action:'announce',info_hash:hash,peer_id:peer,uploaded:0,downloaded:0,left:1,to_peer_id:m.peer_id,offer_id:m.offer_id,answer}))counts.answersSent=bounded(counts.answersSent);}catch{counts.signallingErrors=bounded(counts.signallingErrors);pc.close();}}
   if(role==='source'&&m.answer&&typeof m.offer_id==='string'){counts.answersReceived=bounded(counts.answersReceived);const e=offers.get(m.offer_id);if(!e||e.ws!==ws||e.pc.signalingState!=='have-local-offer')return;try{candidateType(counts.remoteCandidates,m.answer.sdp);await e.pc.setRemoteDescription(m.answer);counts.remoteDescriptionsApplied=bounded(counts.remoteDescriptionsApplied);}catch{counts.signallingErrors=bounded(counts.signallingErrors);}}
  }
  for(const url of trackers){const ws=new WebSocket(url);sockets.push(ws);ws.onopen=()=>{counts.trackerConnections=bounded(counts.trackerConnections);announce(ws,{event:'started'});if(role==='source')void makeOffer(ws);};ws.onmessage=e=>{try{void handle(ws,JSON.parse(e.data));}catch{counts.signallingErrors=bounded(counts.signallingErrors);}};ws.onerror=()=>{counts.signallingErrors=bounded(counts.signallingErrors);};}
  const timer=setInterval(()=>{for(const ws of sockets){if(role==='source')void makeOffer(ws);else announce(ws);}prune();},15000);
  window.__rawProbe={async sample(){
   const states={new:0,connecting:0,connected:0,disconnected:0,failed:0,closed:0},iceStates={new:0,checking:0,connected:0,completed:0,disconnected:0,failed:0,closed:0};
   const pairStates={frozen:0,waiting:0,'in-progress':0,failed:0,succeeded:0,unknown:0},dtlsStates={new:0,connecting:0,connected:0,closed:0,failed:0,unknown:0};
   const addressCounts=()=>({mdns:0,'private-ip':0,'public-ip':0,ipv6:0,unknown:0}),protocolCounts=()=>({udp:0,tcp:0,unknown:0});
   const candidateAddresses={local:addressCounts(),remote:addressCounts()},candidateProtocols={local:protocolCounts(),remote:protocolCounts()};
   const checkNames=['requestsSent','responsesReceived','requestsReceived','responsesSent'],checks=Object.fromEntries(checkNames.map(k=>[k,null]));let selected=null;
   const allowedType=t=>['host','srflx','prflx','relay'].includes(t)?t:null;
   const classifyAddress=input=>{
    if(typeof input!=='string'||!input)return 'unknown';const address=input.toLowerCase();if(address.endsWith('.local'))return 'mdns';
    if(address.includes(':'))return 'ipv6';const octets=address.split('.');if(octets.length!==4||octets.some(x=>!/^\d{1,3}$/.test(x)||Number(x)>255))return 'unknown';
    const [a,b]=octets.map(Number);if(a===0||a>=224)return 'unknown';if(a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127)return 'private-ip';return 'public-ip';
   };
   for(const pc of pcs){
    if(Object.hasOwn(states,pc.connectionState))states[pc.connectionState]++;if(Object.hasOwn(iceStates,pc.iceConnectionState))iceStates[pc.iceConnectionState]++;
    try{const stats=await pc.getStats();for(const x of stats.values()){
     if(x.type==='local-candidate'||x.type==='remote-candidate'){const side=x.type==='local-candidate'?'local':'remote',address=classifyAddress(x.address??x.ip),protocol=String(x.protocol||'').toLowerCase();candidateAddresses[side][address]++;candidateProtocols[side][['udp','tcp'].includes(protocol)?protocol:'unknown']++;}
     if(x.type==='transport'){const state=Object.hasOwn(dtlsStates,x.dtlsState)?x.dtlsState:'unknown';dtlsStates[state]++;}
     if(x.type==='candidate-pair'){
      const state=Object.hasOwn(pairStates,x.state)?x.state:'unknown';pairStates[state]++;
      for(const key of checkNames)if(typeof x[key]==='number'&&Number.isFinite(x[key])&&x[key]>=0)checks[key]=Math.min(1e12,(checks[key]??0)+x[key]);
      if(x.selected||x.nominated&&x.state==='succeeded'){const l=stats.get(x.localCandidateId),r=stats.get(x.remoteCandidateId),pr=String(l?.protocol||'').toLowerCase();selected={localType:allowedType(l?.candidateType),remoteType:allowedType(r?.candidateType),protocol:['udp','tcp'].includes(pr)?pr:null,bytesSent:Number.isFinite(x.bytesSent)?Math.min(1e12,Math.max(0,x.bytesSent)):null,bytesReceived:Number.isFinite(x.bytesReceived)?Math.min(1e12,Math.max(0,x.bytesReceived)):null};}
     }
    }}catch{}
   }
   return {...counts,pcStates:states,iceStates,candidatePairStates:pairStates,connectivityChecks:checks,candidateAddresses,candidateProtocols,dtlsStates,selected};
  },stop(){stopped=true;clearInterval(timer);for(const p of pcs)p.close();for(const w of sockets)w.close();}};
 },{role,hash64:payload.infoHashBase64});
 await progress('observing');const observedAt=Date.now(),end=Math.min(Date.now()+seconds*1000,expiry);let stopped=false;
 while(Date.now()<end){try{await access(join(directory,'stop.request'));stopped=true;break;}catch{}const x=await page.evaluate(()=>window.__rawProbe.sample());x.elapsedSeconds=Math.round((Date.now()-observedAt)/1000);result.samples.push(x);if(result.samples.length>125)result.samples.shift();await writeSafe('status.json',result);await pause(Math.min(5000,Math.max(0,end-Date.now())));}
 const last=await page.evaluate(()=>window.__rawProbe.sample());last.elapsedSeconds=Math.round((Date.now()-observedAt)/1000);result.samples.push(last);result.pass=last.channelsOpened>0&&last.bytesReceived>0&&last.packetsReceived>0;result.phase=stopped?'stopped':'complete';result.summary={offersSent:last.offersSent,offersReceived:last.offersReceived,answersSent:last.answersSent,answersReceived:last.answersReceived,remoteDescriptionsApplied:last.remoteDescriptionsApplied,channelsOpened:last.channelsOpened,packetsReceived:last.packetsReceived,bytesReceived:last.bytesReceived,selected:last.selected};await writeSafe('result.json',result);await writeSafe('status.json',result);console.log(stopped?'Probe stopped cleanly.':result.pass?'Probe complete: generated data received.':'Probe complete: no generated data received.');if(!result.pass&&!stopped)process.exitCode=1;
}catch(error){const failedAt=result.phase;result.phase='failed';result.failure={failedAt,name:['Error','TypeError','TimeoutError','AbortError'].includes(error?.name)?error.name:'Error',code:['ENOENT','EACCES','EPERM','ECONNRESET','ETIMEDOUT','ENOTFOUND','ERR_MODULE_NOT_FOUND'].includes(error?.code)?error.code:null};await writeSafe('result.json',result);await writeSafe('status.json',result);console.error('Probe failed; see sanitised status.');process.exitCode=1;}
finally{await page?.evaluate(()=>window.__rawProbe?.stop()).catch(()=>{});await context?.close().catch(()=>{});await browser?.close().catch(()=>{});}
