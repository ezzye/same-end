/* Isolated single-Mac WebRTC regression; not physical mobile/5G acceptance. */
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createApi } from '../backend/api.mjs';
import { MemoryStore } from '../backend/store.mjs';
import { createLocalTestTLS } from './helpers/local-test-tls.mjs';

const runtimeInput=process.env.SAMEEND_PLAYWRIGHT||(process.env.HOME||process.env.USERPROFILE)+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const runtimeURL=/^file:/i.test(runtimeInput)?new URL(runtimeInput):pathToFileURL(runtimeInput),runtimePath=fileURLToPath(runtimeURL);
const {chromium}=await import(runtimeURL.href),require=createRequire(import.meta.url);
const {wsServer:WebSocketServer}=require(join(dirname(dirname(runtimePath)),'playwright-core/lib/utilsBundle.js'));
const root = new URL('../', import.meta.url), runLabel='resilience-room', outageSeconds=105, output = new URL('privatework/resilience/room-'+(process.env.RESILIENCE_DELAY||10)+'/', root);
assert(/^[A-Za-z0-9_-]+$/.test(runLabel));assert(outageSeconds>=30&&outageSeconds<=150);const blockedClients=new Set();
await mkdir(output, { recursive: true });
const originalHTML = await readFile(process.env.HLS_RECONNECT_HTML||process.env.SAMEEND_RECONNECT_HTML||new URL('dist/watch.html', root), 'utf8');
await writeFile(new URL('app-under-test.html',output),originalHTML);
// Dormant transport code is injected only when an invitation is made. Parse it
// explicitly so build-time HTML insertion cannot silently corrupt that path.
for (const id of ['magnet-module', 'magnet-vendor']) {
  const asset = originalHTML.match(new RegExp('<script[^>]*id=\"' + id + '\"[^>]*>([\\s\\S]*?)<\\/script>'));
  assert(asset, 'Built app contains ' + id);
  assert.doesNotThrow(() => new Function(asset[1]), 'Built deferred asset parses: ' + id);
}
const publicBase = JSON.parse(await readFile(new URL('public-config.json', root), 'utf8')).apiBase;
const localTLS = createLocalTestTLS();
let origin, servedHTML, api;
const apiBodies = [];
const requests = [], mediaAttempts = [], externalRequests = [], trackerErrors = [];
const server = https.createServer(localTLS, async (req, res) => {
  try {
    const url = new URL(req.url, origin); requests.push(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const rawBody=Buffer.concat(chunks).toString(); if(rawBody)apiBodies.push({method:req.method,bytes:Buffer.byteLength(rawBody),keys:Object.keys(JSON.parse(rawBody)),cleartextMedia:/magnet:|video\/mp4|segment-\d|#EXTM3U/.test(rawBody)});
      const result = await api.handler({ rawPath: url.pathname.slice(4), headers: req.headers, body: Buffer.concat(chunks).toString(), queryStringParameters: Object.fromEntries(url.searchParams), requestContext: { http: { method: req.method, sourceIp: 'hls-room-test' } } });
      return res.writeHead(result.statusCode, result.headers).end(result.body);
    }
    if (/\.(?:m3u8|m4s|mp4|ts)(?:$|[?#])/i.test(url.pathname)) { mediaAttempts.push(url.pathname); return res.writeHead(403).end('Video must arrive from peers.'); }
    if (url.pathname === '/sw.js') return res.writeHead(404).end();
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(servedHTML);
  } catch { res.writeHead(500).end('Isolated test server failed.'); }
});
const tracker = new WebSocketServer({ server, path: '/tracker' }), swarms = new Map();
const trackerStats = { connections:0, announces:0, offers:0, answers:0, byClient:{}, replies:[] };
const send=(socket,message)=>{if(socket?.readyState===1){const client=socket.testClient||'unknown',type=message.offer?'offer':message.answer?'answer':'announce';trackerStats.byClient[client]??={};trackerStats.byClient[client][type]=(trackerStats.byClient[client][type]||0)+1;trackerStats.replies.push({at:Date.now(),client,type});trackerStats.replies=trackerStats.replies.slice(-60);socket.send(JSON.stringify(message));}};
tracker.on('connection', (socket,request) => {
  socket.testClient=new URL(request.url,origin).searchParams.get('testClient')||'unknown';if(blockedClients.has(socket.testClient)){trackerStats.blockedConnections=(trackerStats.blockedConnections||0)+1;socket.terminate();return;}
  trackerStats.connections++; socket.memberships = [];
  socket.on('error', error => trackerErrors.push(error.name));
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.action !== 'announce' || typeof message.info_hash !== 'string' || typeof message.peer_id !== 'string') return;
      trackerStats.announces++;
      let swarm = swarms.get(message.info_hash); if (!swarm) { swarm = new Map(); swarms.set(message.info_hash, swarm); }
      if (message.event === 'stopped') { swarm.delete(message.peer_id); return; }
      swarm.set(message.peer_id, socket); socket.memberships.push([message.info_hash, message.peer_id]);
      if (message.answer && message.to_peer_id) {
        trackerStats.answers++; send(swarm.get(message.to_peer_id), { action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id, offer_id: message.offer_id, answer: message.answer }); return;
      }
      send(socket, { action: 'announce', info_hash: message.info_hash, interval: 2, complete: 1, incomplete: Math.max(0, swarm.size - 1) });
      const peers = [...swarm].filter(([id, peer]) => id !== message.peer_id && peer.readyState === 1);
      for (let i = 0; i < Math.min(peers.length, message.offers?.length || 0); i++) {
        const offer = message.offers[i]; trackerStats.offers++; send(peers[i][1], { action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id, offer_id: offer.offer_id, offer: offer.offer });
      }
    } catch { trackerErrors.push('MalformedTrackerMessage'); }
  });
  socket.on('close', () => { for (const [hash, id] of socket.memberships) { const swarm = swarms.get(hash); if (swarm?.get(id) === socket) swarm.delete(id); if (!swarm?.size) swarms.delete(hash); } });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = 'https://127.0.0.1:' + server.address().port;
api = createApi({ store: new MemoryStore(), push: { enabled: false }, allowedOrigins: [origin] });
assert(originalHTML.includes('wss://tracker.openwebtorrent.com'), 'Built production tracker configuration must be present');
servedHTML = originalHTML.replaceAll(publicBase, '/api').replace(/wss:\/\/tracker\.[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_/-]*)?/g, origin.replace('https:', 'wss:') + '/tracker');
// Private fixture rewrites endpoint strings; renew only the affected CSP hashes.
const fixtureHashes=[...new Set([...servedHTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([,attrs,source])=>source.trim()&&!/\bsrc\s*=|id=["']webtorrent-license["']|type=["']application\/json["']/i.test(attrs)).map(([,attrs,source])=>"'sha256-"+createHash('sha256').update(source.replace(/\r\n?/g,'\n')).digest('base64')+"'"))];
servedHTML=servedHTML.replace(/script-src 'self' [^;]+;/,"script-src 'self' "+fixtureHashes.join(' ')+';');
// A known loud PCM sine replaces the browser's low-level default fake mic.
// It loops as a fake capture device; no microphone or speaker is used.
const audioFixture=new URL('generated-tone.wav',output), samples=48000,wav=Buffer.alloc(44+samples*2);
wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(2*Math.PI*1000*i/48000)*16000),44+i*2);await writeFile(audioFixture,wav);
const browser = await chromium.launch({ ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:process.env.BROWSER_CHANNEL||'chrome'}), headless: true, args: ['--mute-audio','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+fileURLToPath(audioFixture),'--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const roomDelay=Number(process.env.RESILIENCE_DELAY||10);assert([10,300].includes(roomDelay));
const contexts=[],errors=[],events=[];let result={pass:false,environment:{actualWebRTC:true,physicalDevices:false,separateNetworks:false,generatedMedia:true,autoplayOverride:false,applicationVideoLoss:true}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function snap(p){return p.evaluate(()=>{const s=PrivateCast.snapshot(),v=document.querySelector('#player'),a=document.querySelector('audio[data-same-end-audio]')||v;return {config:s.config,commonStart:s.commonStart,initialDelay:s.initialDelay,diagnostics:s.mediaDiagnostics,target:s.effectiveTargetProgramTime,received:s.received,role:s.role,supplier:s.supplier,transport:s.transport,leafOnly:s.leafOnly,delivery:s.delivery,clockReady:s.clockReady,mediaMode:s.mediaMode,policy:s.renditionPolicy,programTime:s.programTime,sourceReachable:s.sourceReachable,ready:a?.readyState,paused:a?.paused,muted:a?.muted,audioTime:a?.currentTime,rms:(()=>{const p=window.testAudio;if(!p)return null;const d=new Float32Array(2048);p.analyser.getFloatTimeDomainData(d);return Math.sqrt(d.reduce((s,x)=>s+x*x,0)/d.length)})(),videoTime:v.currentTime,width:v.videoWidth,frames:v.getVideoPlaybackQuality().totalVideoFrames,wire:window.testWire,log:document.querySelector('#log')?.textContent?.slice(-2000)};});}
async function until(check,timeout,msg){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await pause(300);}throw Error(msg);}
async function page(label,invitation,phone=false){
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',permissions:['microphone'],viewport:{width:1200,height:900},...(phone?{userAgent:'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'}:{})});contexts.push(context);
 await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
 await context.addInitScript(()=>{
  window.testWire={dropVideo:false,byRendition:{},dropped:0,hellos:[]};let T;
  Object.defineProperty(window,'CastMagnetTransport',{configurable:true,get:()=>T,set:Class=>{T=Class;if(!Class?.prototype?._open||Class.prototype.testWrapped)return;Class.prototype.testWrapped=true;const open=Class.prototype._open;Class.prototype._open=function(...args){const ret=open.apply(this,args),a=args[0]?.adapter;if(a&&!a.testWrapped){a.testWrapped=true;const recv=a.onmessage,send=a.send;let remaining=0,drop=false,kind=null;a.send=function(data){if(typeof data==='string')try{const m=JSON.parse(data);if(m.type==='hello'){testWire.hellos.push({at:Date.now(),requested:m.requestedRenditions});testWire.hellos=testWire.hellos.slice(-40);}}catch{}return send.call(this,data)};a.onmessage=function(e){if(typeof e.data==='string'){let m;try{m=JSON.parse(e.data)}catch{}if(m?.type==='segment'){kind=m.meta.rendition;remaining=m.meta.size;drop=testWire.dropVideo&&kind!=='audio';if(drop){testWire.dropped++;return;}}return recv?.call(this,e);}const n=e.data.byteLength;testWire.byRendition[kind]=(testWire.byRendition[kind]||0)+n;remaining-=n;if(drop){if(remaining<=0)drop=false;return;}return recv?.call(this,e);};}return ret;};}});
 });
 const p=await context.newPage();p.on('pageerror',e=>{if(!errors.length)console.error(e.stack);errors.push({label,message:e.stack})});await p.goto(invitation||origin+'/');try{await p.waitForFunction(()=>window.PrivateCast?.testing&&window.SameEndSocial?.snapshot().ready,null,{timeout:10000})}catch(e){console.error(JSON.stringify(await p.evaluate(()=>({url:location.href,socialType:typeof window.SameEndSocial,scripts:[...document.scripts].slice(-8).map(s=>({id:s.id,type:s.type,bytes:s.textContent.length})),body:document.body.innerHTML.slice(-200)}))));throw e;}return p;
}
async function record(name,ps){const states=await Promise.all(ps.map(snap));events.push({name,at:Date.now(),states});await writeFile(new URL('progress.json',output),JSON.stringify({events,errors,result},null,2));console.log(name);return states;}
try{
 const source=await page('source');
 await source.evaluate((delay)=>{window.fixtureDelay=delay;const b=document.createElement('button');b.id='test-start';b.textContent='Start test';b.onclick=()=>window.testStart=(async()=>{const c=document.createElement('canvas');c.width=960;c.height=540;const x=c.getContext('2d');let f=0;window.testTimer=setInterval(()=>{x.fillStyle='#102a41';x.fillRect(0,0,960,540);x.fillStyle='white';x.font='40px sans-serif';x.fillText('Frame '+f++,30,100);x.fillRect(f*8%850,200,100,100)},40);const stream=c.captureStream(25),fake=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});stream.addTrack(fake.getAudioTracks()[0]);return PrivateCast.testing.startFromStream(stream,{delay:window.fixtureDelay});})();document.body.append(b);},roomDelay);
 await source.locator('#test-start').click();await source.evaluate(()=>testStart);
 await source.locator('#make-magnet').click();await source.waitForFunction(()=>document.querySelector('#browser-invitation').value.includes('&watch=1'),null,{timeout:45000});
 const invitation=await source.locator('#browser-invitation').inputValue();const viewer=await page('viewer',invitation,true);
 let debugAt=0;await until(async()=>{const s=await snap(viewer);if(Date.now()-debugAt>10000){debugAt=Date.now();await record('Startup observation',[source,viewer]);}return s.received>6&&s.clockReady&&s.frames>20&&s.audioTime>0;},roomDelay===300?420000:70000,'Initial v3 picture/audio failed');
 if(await viewer.locator('#sound').isVisible())await viewer.locator('#sound').click();
 await viewer.evaluate(()=>{const b=document.createElement('button');b.id='probe-audio';b.textContent='Measure generated audio';b.onclick=async()=>{const c=new AudioContext(),analyser=c.createAnalyser(),gain=c.createGain();analyser.fftSize=2048;gain.gain.value=0;c.createMediaElementSource(document.querySelector('audio[data-same-end-audio]')).connect(analyser);analyser.connect(gain).connect(c.destination);await c.resume();window.testAudio={context:c,analyser};};document.body.append(b)});await viewer.locator('#probe-audio').click();await pause(500);
 const healthy=await page('healthy-laptop',invitation);await healthy.waitForFunction(()=>PrivateCast.snapshot().config);await healthy.evaluate(()=>PrivateCast.testing.setMediaPreference('v360'));await until(async()=>{const h=await snap(healthy);return h.frames>25&&h.audioTime>0&&!h.paused},50000,'Healthy peer failed to play');
 const [s0,v0,h0]=await record('Initial real P2P playback',[source,viewer,healthy]);assert.equal(v0.leafOnly,true);assert.equal(v0.delivery.relayLimit,0);assert.equal(v0.config.segmentVersion,3);assert(v0.width===640);assert(v0.rms>.001,'Decode actual audio samples');
 await viewer.evaluate(()=>testWire.dropVideo=true);
 await until(async()=>{const s=await snap(viewer);return s.mediaMode==='audio';},40000,'Automatic audio fallback failed');
 await pause(5000);const [a]=await record('Automatic audio fallback',[viewer]);assert(a.audioTime>v0.audioTime+8);assert(a.wire.dropped>0);assert(a.rms>.001,'Audio-only must decode actual samples');
 const before=a.wire.byRendition.v360||0;await pause(6000);const quiet=await snap(viewer);assert.equal(quiet.wire.byRendition.v360||0,before,'Audio mode must stop its video subscription after in-flight bundle');assert(quiet.audioTime>a.audioTime+4);
 await viewer.evaluate(()=>testWire.dropVideo=false);
 await until(async()=>{const s=await snap(viewer);return s.mediaMode==='v360'&&s.frames>a.frames+20;},65000,'Automatic video recovery failed');
 const [recovered]=await record('Fresh video probe and return',[viewer]);assert(recovered.audioTime>quiet.audioTime);assert.equal(recovered.config.id,v0.config.id);
 const healthyAfter=await snap(healthy);assert(healthyAfter.frames>h0.frames+500,'One struggling viewer must leave healthy peer decoding');assert(healthyAfter.audioTime>h0.audioTime+20);assert.equal(healthyAfter.config.id,h0.config.id);
 const beforeFail=await snap(viewer);await viewer.route('**/api/**/coordinator',r=>r.abort());await pause(20000);const failSoft=await snap(viewer);assert.equal(failSoft.transport.coordinator.available,false,'Expired coordinator hints are discarded');assert(failSoft.frames>beforeFail.frames+150,'Coordinator outage must preserve healthy P2P playback');
 result={...result,roomDelay,pass:true,initial:v0,audio:a,recovered,coordinatorOutage:failSoft,healthyPeer:healthyAfter,cloudMetadataRequests:apiBodies.length,cloudMediaAttempts:mediaAttempts.length,errors};assert.equal(mediaAttempts.length,0);assert.deepEqual(errors,[]);
}catch(e){result.error=e.stack;throw e;}finally{result.events=events;result.errors=errors;await writeFile(new URL('result.json',output),JSON.stringify(result,null,2));await browser.close();for(const s of tracker.clients)s.terminate();await new Promise(r=>tracker.close(r));await new Promise(r=>server.close(r));}
