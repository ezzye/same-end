/* Actual continuous HLS reconnection acceptance. All faults affect owned isolated
 * browser contexts: peer connections are really closed and per-client local WSS
 * discovery is blocked. Offline/hidden/frozen events are additional stimuli.
 * No public rooms, no user profile, no TURN/HTTP media, no autoplay override.
 * Build externally first. HLS_RECONNECT_HTML can select a preserved baseline.
 * HLS_RECONNECT_SCENARIO=baseline runs only the hintless >90-second viewer fault.
 * HLS_RECONNECT_SCENARIO=room checks source-independent rooms and source leases.
 * HLS_RECONNECT_LABEL selects the evidence folder. CHROME_PATH, BROWSER_CHANNEL
 * and SAMEEND_PLAYWRIGHT support isolated Chrome/Edge on another host.
 */
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
const root = new URL('../', import.meta.url), runLabel=process.env.HLS_RECONNECT_LABEL||'current', scenario=process.env.HLS_RECONNECT_SCENARIO||'full', outageSeconds=Number(process.env.HLS_RECONNECT_OUTAGE_SECONDS||105), output = new URL('privatework/automatic-reconnection-hls/'+runLabel+'/', root);
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
const browser = await chromium.launch({ ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:process.env.BROWSER_CHANNEL||'chrome'}), headless: true, args: ['--mute-audio','--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const pages = {}, contexts = [], pageErrors = [],contextByLabel={};
const report = { schema: 1, startedAt: new Date().toISOString(), buildSHA256: createHash('sha256').update(originalHTML).digest('hex'), environment: { hostPlatform:process.platform,browserChannel:process.env.BROWSER_CHANNEL||'chrome',oneComputer: true, actualWebRTC: true, isolatedChromeContexts: true, localWssDiscovery: true, ephemeralLocalEncryptedChat: true, generatedMedia: true, generatedChirps: true, testBrowserSpeakerOutputMuted:true, scenario, outageSeconds, simulatedPhoneVisibility:false, actualOwnedRendererFreeze:false, autoplayOverride: false, localSelfSignedCertificateOverride: true, physicalDevices: false, separateNetworks: false, cloudVideoRelay: false, delay: 10 }, tracker: trackerStats, events: [], samples: [], pass: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sanitize = value => String(value).replace(/https?:\/\/\S*#\S*/g, '[private invitation removed]').replace(/magnet:\S+/g, '[magnet invitation removed]').replace(/#pc=[A-Za-z0-9_-]+/g, '#pc=[removed]');
async function until(check, timeout, message) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await pause(250); } throw Error(message); }
async function page(label, invitation, storageState) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, ...(storageState ? {storageState} : {}) }); contexts.push(context);contextByLabel[label]=context;
  await context.route('**/*', route => { const url = route.request().url(); if (!url.startsWith(origin + '/')) { externalRequests.push(new URL(url).hostname); if (/\.(?:m3u8|m4s|mp4|ts)(?:$|[?#])/i.test(url)) mediaAttempts.push('[blocked external media]'); return route.abort(); } return route.continue(); });
  await instrument(context,label);
  const result = await context.newPage(); pages[label] = result;
  result.on('pageerror', error => pageErrors.push({ label, error: sanitize(error.stack || error.message) }));
  await result.goto(invitation || origin + '/');
  await result.waitForFunction(() => window.PrivateCast?.testing && window.SameEndSocial?.snapshot().ready);
  await result.locator('#name').evaluate((input, value) => { input.value = value; }, 'HLS ' + label);
  return result;
}
async function snapshot(page) {
  if (page.isClosed()) return { closed: true };
  return page.evaluate(() => {
    const state = PrivateCast.snapshot(), video = document.querySelector('#player'), probe = window.hlsRoomProbe;
    let rms = null;
    if(probe){const spectrum=new Float32Array(probe.analyser.frequencyBinCount);probe.analyser.getFloatFrequencyData(spectrum);let best=-Infinity,index=0;for(let i=Math.floor(350*probe.analyser.fftSize/probe.context.sampleRate);i<Math.min(spectrum.length,Math.ceil(2300*probe.analyser.fftSize/probe.context.sampleRate));i++)if(spectrum[i]>best){best=spectrum[i];index=i;}probe.peakFrequency=index*probe.context.sampleRate/probe.analyser.fftSize;}
    if (probe) { const data = new Float32Array(probe.analyser.fftSize); probe.analyser.getFloatTimeDomainData(data); rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length); }
    return { roomSource:(()=>{const source=SameEndSocial.snapshot().roomSource;return source?{state:source.state,fresh:source.fresh}:null;})(), roomConnection:{state:document.body.dataset.roomState||'',title:document.querySelector('#stage-title')?.textContent||'',detail:document.querySelector('#stage-help')?.textContent||'',status:document.querySelector('#room-status')?.textContent||''},joinFailureVisible:document.body.classList.contains('has-join-failure'),inviteCheckTitle:document.querySelector('#invite-check-title')?.textContent||'',inviteCheckMessage:document.querySelector('#invite-check-message')?.textContent||'', social:(()=>{const {roomInvitation,watchInvitation,...safe}=SameEndSocial.snapshot();return safe;})(), calls:window.acceptanceCalls, ownedNetwork:window.ownedNetwork?.stats(), audioContextState:probe?.context.state, measuredOutputGain:probe?.outputGain.gain.value??null, peakFrequency:probe?.peakFrequency??null, hlsFailureMessages:(document.querySelector('#log')?.textContent||'').split('\n').filter(line=>/HLS|buffer|fragment|decode/i.test(line)).slice(0,8), hlsCaches:[...(window.ownedHlsCaches||[])].map(c=>({hasTargetPiece:window.ownedCacheObserve?.(c)||false,freshTargetReturns:c.ownedFreshReturns||[],target:c.target,newest:c.newest,bytes:c.bytes,files:c.files.size,availableSegments:[...c.timeline.values()].filter(t=>c.files.has(t.path)&&(!Number.isFinite(c.target)||t.end>=c.target-4&&t.start<=c.target+20)).map(t=>({start:t.start,end:t.end})),lastMisses:c.ownedMisses||[]})), muted:video.muted, sampledAt: Date.now(), nodeId: state.nodeId, transport:state.transport, network:state.network, active:state.active, capture:state.mediaDiagnostics.capture, config: state.config, sourceReachable: state.sourceReachable, sourceEnded: state.sourceEnded, role: state.role, supplier: state.supplier, clockReady: state.clockReady, received: state.received, reserveSeconds: state.reserveSeconds, recovery: state.recovery, stalls: state.stalls, programTime: state.programTime, target: state.targetProgramTime, drift: state.drift, peers: state.peers, mode: state.playbackMode, cacheBytes: state.cacheBytes, playback: state.mediaDiagnostics.playback, delivery: state.delivery, chatCount: SameEndSocial.snapshot().chatCount, chatConnected: SameEndSocial.snapshot().connected, chatHidden: document.querySelector('#club-chat-shell')?.hidden, chatParent: document.querySelector('#club-chat-shell')?.parentElement?.className || null, frames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0, frameCallbacks: probe?.frames || 0, lastFrameAt: probe?.lastFrameAt || null, rms, ready: video.readyState, paused: video.paused, width: video.videoWidth, height: video.videoHeight, status: document.querySelector('#play-state').textContent };
  }).catch(error => { if (page.isClosed()) return { closed: true }; throw error; });
}
async function record(label) { const states = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, page]) => [name, await snapshot(page)]))); report.events.push({ label, at: Date.now(), states }); await writeFile(new URL('progress.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify({ stage: label })); return states; }
async function probe(page) {
  await page.evaluate(() => {
    const video = document.querySelector('#player'), context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaElementSource(video).connect(analyser);const outputGain=context.createGain();analyser.connect(outputGain);outputGain.connect(context.destination);const updateGain=()=>{outputGain.gain.value=video.muted?0:video.volume;};video.addEventListener('volumechange',updateGain);updateGain();
    const probe = window.hlsRoomProbe = { context, analyser, outputGain, frames: 0, lastFrameAt: null };
    const frame = () => { probe.frames++; probe.lastFrameAt = Date.now(); video.requestVideoFrameCallback(frame); }; video.requestVideoFrameCallback(frame);
    const button = document.createElement('button'); button.id = 'resume-test-audio'; button.textContent = 'Measure generated test sound'; button.onclick = () => context.resume(); document.body.append(button);
  });
  await page.locator('#resume-test-audio').click(); if(await page.locator('#player').evaluate(v=>v.muted))await page.locator('#sound').click();
}
async function sendChat(page, message) {
  await page.locator('#club-chat-input').fill(message); await page.locator('#club-send-chat').click();
  await page.waitForFunction(() => document.querySelector('#club-chat-input').value === '');
}
async function received(page) { await until(async () => { const state = await snapshot(page); return state.clockReady && state.received > 2 && state.supplier && state.chatConnected; }, 45000, 'Automatic combined invitation did not connect signed video and chat'); }
async function playing(page) { await until(async () => { const state = await snapshot(page); return state.mode === 'hls' && state.frames > 10 && state.frameCallbacks > 5 && state.ready >= 2 && !state.paused && state.rms > .001 && Number.isFinite(state.programTime); }, 85000, 'Generated HLS picture, sound and shared clock did not play'); }
const identity = state => state.config && Object.fromEntries(['id', 'epoch', 'delay', 'sourceId', 'sourceEpoch', 'programId', 'mediaProfile'].map(key => [key, state.config[key]]));
async function measureWindow(labels, seconds = 7) {
  const start = Date.now(), samples = [];
  while (Date.now() - start < seconds * 1000) { const states = Object.fromEntries(await Promise.all(labels.map(async label => [label, await snapshot(pages[label])]))); const sample = { at: Date.now(), states }; samples.push(sample); report.samples.push(sample); await pause(250); }
  const spreads = samples.map(row => { const positions = labels.map(label => { const state = row.states[label]; return state.programTime + (row.at - state.sampledAt) / 1000; }); return Math.max(...positions) - Math.min(...positions); });
  for (const label of labels) {
    const states = samples.map(row => row.states[label]);
    assert(states.every(state=>state.calls?.joins===states[0].calls?.joins),label+' must not repeatedly rejoin during stable playback');
    assert(states.every(state => state.mode === 'hls' && !state.paused && state.ready >= 2), label + ' remains in continuous HLS playback');
    assert(states.at(-1).frames > states[0].frames + seconds * 10, label + ' must keep decoding moving pictures');
    if(label!=='source'&&!states[0].muted){assert(states.filter(state => state.rms > .001).length >= states.length * .9,label+' has decoded chirp sound');const frequencies=states.filter(s=>s.rms>.001).map(s=>s.peakFrequency);assert(Math.max(...frequencies)-Math.min(...frequencies)>400,label+' measured changing chirp frequency');}
    assert(Math.max(...states.map(s=>Math.abs(s.drift)))<.85,label+' drift remains below .85 seconds');
    if(label!=='source')assert(Math.max(...states.map(state => state.sampledAt - state.lastFrameAt)) < 1800, label + ' must avoid multi-second decoded-frame gaps');
  }
  assert(Math.max(...spreads) < .8, 'All participants remain within .8 seconds of the shared programme moment');
  return { seconds, samples: samples.length, maxSpreadSeconds: Math.max(...spreads) };
}

async function startSource(source) {
  await source.evaluate(() => {const button=document.createElement('button');button.id='start-stable-hls';button.textContent='Start generated HLS';button.onclick=()=>window.stableHlsStart=PrivateCast.testing.startDemo({delay:10,profile:'hls'});document.body.append(button);});
  await source.locator('#start-stable-hls').last().click();await source.evaluate(()=>stableHlsStart);
  return (await snapshot(source)).config;
}
async function attached(participant,config) {
  await until(async()=>{const s=await snapshot(participant);return s.config?.id===config.id&&s.clockReady&&s.received>2&&s.supplier&&s.chatConnected;},50000,'Stable invitation did not attach fresh signed source '+config.id);
}
async function matching(participant,config){const s=await snapshot(participant);assert.deepEqual(identity(s),identity({config}));return s;}
async function chatEverywhere(sender,participants,text) {
  await sendChat(sender,text);await Promise.all(participants.map(p=>p.waitForFunction(text=>[...document.querySelectorAll('.club-message p')].some(p=>p.textContent===text),text,{timeout:12000})));
}

async function instrument(context,label){
 await context.addInitScript(({label})=>{
  const peers=new Set(),sockets=new Set(),NativePC=window.RTCPeerConnection,NativeWS=window.WebSocket;
  let blocked=false,closedPeers=0,createdPeers=0,createdSockets=0,everConnected=0;const peerTransitions=[];
  const closePeers=()=>{let count=0;for(const pc of peers)if(pc.connectionState!=='closed'){try{pc.close();count++;closedPeers++;}catch{}}return count;};
  class ObservedPC extends NativePC{constructor(...args){super(...args);peers.add(this);const id=++createdPeers;this.addEventListener('connectionstatechange',()=>{if(this.connectionState==='closed')peers.delete(this);if(this.connectionState==='connected')everConnected++;peerTransitions.push({at:Date.now(),id,state:this.connectionState});if(peerTransitions.length>40)peerTransitions.shift();});}close(){try{return super.close();}finally{peers.delete(this);}}}
  window.RTCPeerConnection=ObservedPC;if(window.webkitRTCPeerConnection)window.webkitRTCPeerConnection=ObservedPC;
  class ObservedWS extends NativeWS{constructor(url,protocols){const u=new URL(url,location.href);if(u.pathname==='/tracker')u.searchParams.set('testClient',label);if(protocols===undefined)super(u.href);else super(u.href,protocols);sockets.add(this);createdSockets++;this.addEventListener('close',()=>sockets.delete(this),{once:true});}}
  window.WebSocket=ObservedWS;
  window.ownedNetwork={setBlocked(value){blocked=value;let count=0;if(blocked){count=closePeers();for(const socket of sockets)if(socket.readyState<2)try{socket.close();}catch{}}return {closedNow:count,...this.stats()};},stats(){return {blocked,createdPeers,closedPeers,everConnected,peerTransitions:[...peerTransitions],openPeerConnections:[...peers].filter(p=>p.connectionState!=='closed').length,connectedPeerConnections:[...peers].filter(p=>p.connectionState==='connected').length,createdSockets};}};
  setInterval(()=>{if(blocked)closePeers();},100);
  if(label==='source'){
   const NativeAudio=window.AudioContext;
   window.AudioContext=class extends NativeAudio{createOscillator(){const oscillator=super.createOscillator(),originalStart=oscillator.start.bind(oscillator),context=this;oscillator.start=(...args)=>{const t=context.currentTime+.01;oscillator.frequency.cancelScheduledValues(0);for(let i=0;i<600;i++){oscillator.frequency.setValueAtTime(600,t+i*1.6);oscillator.frequency.linearRampToValueAtTime(1800,t+i*1.6+.8);oscillator.frequency.linearRampToValueAtTime(600,t+(i+1)*1.6);}return originalStart(...args);};return oscillator;}};
  }
  let transportClass;Object.defineProperty(window,'CastMagnetTransport',{configurable:true,get:()=>transportClass,set:Class=>{
   transportClass=Class;if(!Class?.prototype?.snapshot||Class.prototype.ownedAcceptanceWrapped)return;
   const original=Class.prototype.snapshot;Class.prototype.ownedAcceptanceWrapped=true;
   const count=value=>Number.isFinite(value)?value:null,bool=value=>typeof value==='boolean'?value:null,values=value=>value instanceof Map?[...value.values()]:value&&typeof value==='object'?Object.values(value):[];
   Class.prototype.snapshot=function(...args){const base=original.apply(this,args),torrent=this.torrent,peers=values(torrent?._peers),states={},peerDetails={};for(const peer of peers){const pc=peer?.conn?._pc||peer?._pc,state=pc?.connectionState||'none',ice=pc?.iceConnectionState||'none',allowed=['new','checking','connecting','connected','completed','disconnected','failed','closed','none'];const code=(allowed.includes(state)?state:'other')+'/'+(allowed.includes(ice)?ice:'other');states[code]=(states[code]||0)+1;const conn=peer?.conn,wire=peer?.wire,channel=conn?._channel?.readyState,flags=JSON.stringify({peerConnected:bool(peer?.connected),peerDestroyed:bool(peer?.destroyed),wireExists:!!wire,wireDestroyed:bool(wire?.destroyed),wireHandshakePresent:!!wire?.peerExtendedHandshake,connConnected:bool(conn?.connected),connDestroyed:bool(conn?.destroyed),dataChannelState:['connecting','open','closing','closed'].includes(channel)?channel:null,pcState:allowed.includes(state)?state:'other',iceState:allowed.includes(ice)?ice:'other'});peerDetails[flags]=(peerDetails[flags]||0)+1;}const discovery=torrent?.discovery,trackers=values(discovery?.tracker?._trackers);return {...base,ownedLowerLayer:{torrentExists:!!torrent,torrentDestroyed:bool(torrent?.destroyed),torrentPaused:bool(torrent?.paused),numPeers:count(torrent?.numPeers),numConns:count(torrent?.numConns),queueLength:count(torrent?._queue?.length),peerEntries:peers.length,peerConnectionStates:states,peerDetails:Object.entries(peerDetails).map(([state,count])=>({...JSON.parse(state),count})),torrentWireCount:count(torrent?.wires?.length),transportWireCount:count(this.wires?.size),transportAuthenticatedCount:[...this.wires?.values?.()||[]].filter(w=>w.auth).length,discoveryExists:!!discovery,discoveryDestroyed:bool(discovery?.destroyed),trackers:trackers.map(t=>{const socket=t?.socket||t?._socket;return {destroyed:bool(t?.destroyed),reconnecting:bool(t?.reconnecting),peersCount:count(t?.peersCount),socketConnected:bool(socket?.connected),socketDestroyed:bool(socket?.destroyed),socketConsumers:count(socket?.consumers)};})}};};
  }});
  addEventListener('DOMContentLoaded',()=>{if(!window.PrivateCast)return;window.ownedHlsCaches=new Set();window.ownedCacheObserve=c=>{const target=c.target,has=Number.isFinite(target)&&[...c.timeline.values()].some(t=>c.files.has(t.path)&&t.start<=target&&t.end>target);if(has&&!c.ownedHadTarget){c.ownedFreshReturns??=[];c.ownedFreshReturns.push({at:Date.now(),target,newest:c.newest});c.ownedFreshReturns=c.ownedFreshReturns.slice(-20);}c.ownedHadTarget=has;return has;};if(window.SameEndHLS?.VerifiedHlsCache){const proto=SameEndHLS.VerifiedHlsCache.prototype,add=proto.add,read=proto.read;proto.add=function(...args){ownedHlsCaches.add(this);const result=add.apply(this,args);ownedCacheObserve(this);return result;};proto.read=function(...args){const result=read.apply(this,args);ownedCacheObserve(this);if(result===null){this.ownedMisses??=[];this.ownedMisses.push({at:Date.now(),target:this.target,path:String(args[0]).replace(/^.*\/hls\//,'')});this.ownedMisses=this.ownedMisses.slice(-8);}return result;};}window.acceptanceCalls={joins:0,publishes:0,leaves:0};for(const [name,count]of [['joinMagnet','joins'],['publishInvitation','publishes'],['leaveRoom','leaves']]){const original=PrivateCast[name];PrivateCast[name]=function(...args){acceptanceCalls[count]++;return original.apply(this,args);};}});
 },{label});
}
async function signalBlock(label,blocked){
 if(blocked){blockedClients.add(label);for(const socket of tracker.clients)if(socket.testClient===label)socket.terminate();}
 else blockedClients.delete(label);
 const result=await pages[label].evaluate(value=>ownedNetwork.setBlocked(value),blocked);
 report.faults??=[];report.faults.push({label,blocked,at:Date.now(),...result});return result;
}
async function sampleOutage(label,seconds){
 for(let elapsed=0;elapsed<seconds;elapsed++){await pause(1000);const state=await snapshot(pages[label]);report.samples.push({at:Date.now(),fault:label,elapsed,states:{[label]:state}});if(elapsed%20===19){await writeFile(new URL('progress.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify({stage:'owned routes remain broken',label,seconds:elapsed+1,received:state.received,ready:state.ready,paused:state.paused,recovery:state.recovery?.state,fatalMessages:state.hlsFailureMessages}));}}
}
async function waitRecovery(label,config,before){
 let lastWrite=0;
 await until(async()=>{const s=await snapshot(pages[label]);if(Date.now()-lastWrite>5000){lastWrite=Date.now();report.samples.push({at:lastWrite,recoveryObservation:true,states:{[label]:s}});await writeFile(new URL('progress.json',output),JSON.stringify(report,null,2));}if(s.playback?.soundBlocked)report.browserSoundBoundary={label,sampledAt:s.sampledAt,muted:s.muted,playError:s.playback.playError};return s.config?.id===config.id&&s.sourceReachable&&s.supplier&&s.received>before.received+2&&s.ready>=2&&!s.paused&&s.frames>before.frames+20&&(s.muted||s.rms>.001);},90000,'Automatic recovery failed without a user retry: '+label);
 assert.deepEqual(identity(await snapshot(pages[label])),identity({config}));
}
async function startNamedPage(label,context){
 await instrument(context,label);contextByLabel[label]=context;const result=await context.newPage();pages[label]=result;result.on('pageerror',e=>pageErrors.push({label,error:sanitize(e.stack||e.message)}));await result.goto(origin+'/');await result.waitForFunction(()=>window.PrivateCast?.testing&&SameEndSocial.snapshot().ready);return result;
}
// This branch uses the same owned TLS/API/tracker, real WebRTC and signed HLS
// fixture as full/baseline. No Date override touches media clocks or source leases.
function healthyRoom(state, expected, label, needsEmptySource = false) {
 assert.equal(state.chatConnected,true,label+' keeps private chat connected');
 assert.equal(state.chatHidden,false,label+' exposes chat without a source');
 assert.equal(state.social.watching,true,label+' keeps the original room watching intent');
 assert.equal(state.roomSource?.state,expected,label+' source presence is '+expected);
 assert.equal(state.joinFailureVisible,false,label+' must not open a fatal join dialog');
 assert.equal(state.roomConnection.state,expected==='not-started'?'waiting-for-source':'source-unreachable',label+' exposes the correct visible room state');
 const feedback=[state.roomConnection.title,state.roomConnection.detail,state.roomConnection.status,state.inviteCheckTitle,state.inviteCheckMessage].join(' ');
 assert(!/room (?:is )?full|could(?:n.t| not) join|unable to join|failed to join/i.test(feedback),label+' must not report room capacity or join failure while waiting');
 assert(/wait|start|ready|check|unavailable|connection|stopped|reconnect|reach the source/i.test([state.roomConnection.title,state.roomConnection.detail,state.roomConnection.status].join(' ')),label+' explains room waiting or connection state');
 if(needsEmptySource){assert.equal(state.config,null,label+' has no media source');assert.equal(state.social.watchWaiting,true,label+' waits automatically for a source');}
}
async function waitInRoom(labels,seconds,expected,needsEmptySource=false) {
 const started=Date.now();let elapsed=0;
 while(Date.now()-started<seconds*1000){
  await pause(Math.min(5000,seconds*1000-(Date.now()-started)));
  const states=Object.fromEntries(await Promise.all(labels.map(async label=>[label,await snapshot(pages[label])])));
  for(const [label,state]of Object.entries(states))healthyRoom(state,expected,label,needsEmptySource);
  report.samples.push({at:Date.now(),roomWaiting:true,states});
  if(Date.now()-started>elapsed+20000){elapsed=Date.now()-started;await writeFile(new URL('progress.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify({stage:'private room remains available without source',seconds:Math.floor(elapsed/1000),sourceState:expected}));}
 }
 return Date.now()-started;
}
async function runRoom(){
 let source=await page('source');
 assert.equal((await snapshot(source)).config,null,'Host starts without capture');
 await source.locator('#make-magnet').waitFor({state:'visible'});
 await source.waitForFunction(()=>SameEndSocial.snapshot().ready&&!document.querySelector('#make-magnet').disabled,null,{timeout:10000});
 assert.equal(await source.locator('#make-magnet').isEnabled(),true,'Invite mates is available before capture');
 await source.locator('#make-magnet').click();
 await source.waitForFunction(()=>document.querySelector('#browser-invitation').value.includes('&watch=1'),null,{timeout:45000});
 const invitation=await source.locator('#browser-invitation').inputValue(),q=new URLSearchParams(new URL(invitation).hash.slice(1));
 assert(q.has('club')&&q.get('watch')==='1'&&!q.has('owner')&&!q.has('join'));
 assert.equal((await snapshot(source)).config,null,'Preparing the invitation does not start capture');
 const roomId=(await snapshot(source)).social.id;
 report.stableInvitationShape=true;report.room={invitedBeforeCapture:true,realWaitingClock:true};
 const viewer1=await page('viewer1',invitation),viewer2=await page('viewer2',invitation);
 for(const viewer of [viewer1,viewer2]){await viewer.waitForFunction(()=>SameEndSocial.snapshot().connected&&SameEndSocial.snapshot().watching);assert.equal(await viewer.locator('#club-chat-input').isVisible(),true,'Chat composer is visible before sharing');}
 await chatEverywhere(viewer1,[source,viewer2],'Our private room is ready before the shared screen');
 await record('room invitation opens chat before any source');
 report.room.waitingBeforeSourceMs=await waitInRoom(['viewer1','viewer2'],95,'not-started',true);
 await chatEverywhere(viewer2,[source,viewer1],'Still chatting after the former ninety second join boundary');
 await record('source-free room remains usable beyond ninety seconds');
 let config=await startSource(source);await source.evaluate(()=>PrivateCast.testing.setRelayLimit(2));
 for(const viewer of [viewer1,viewer2]){await attached(viewer,config);await probe(viewer);await playing(viewer);await matching(viewer,config);}
 assert.equal(await source.evaluate(()=>SameEndSocial.snapshot().watchInvitation),invitation);
 await chatEverywhere(viewer1,[source,viewer2],'The shared screen joined our existing room automatically');
 report.room.initialPlayback=await measureWindow(['source','viewer1','viewer2'],5);
 await viewer2.locator('#sound').click();assert.equal((await snapshot(viewer2)).muted,true);
 const beforeLoss=await record('same room automatically attaches first signed HLS source with changing chirps');
 for(const label of ['source','viewer1','viewer2'])assert.equal(beforeLoss[label].roomSource?.state,'sharing');
 const saved=await contextByLabel.source.storageState({indexedDB:true}),oldConfigId=config.id;
 await contextByLabel.source.close();const disappearedAt=Date.now();
 await chatEverywhere(viewer1,[viewer2],'Our conversation continues after the source disappears');
 // Wait beyond the real 60-second owner lease. Existing media is free to exhaust
 // its bounded buffer; the presence lease alone must not become a chat failure.
 for(let elapsed=0;elapsed<65;elapsed+=5){await pause(5000);report.samples.push({at:Date.now(),sourceAbsent:true,states:{viewer1:await snapshot(viewer1),viewer2:await snapshot(viewer2)}});if(elapsed%20===15)await record('waiting for real source lease expiry');}
 report.room.sourceAbsentMs=Date.now()-disappearedAt;
 await until(async()=>{const states=await Promise.all([viewer1,viewer2].map(snapshot));return states.every(s=>s.roomSource?.state==='unreachable'&&!s.roomSource.fresh);},12000,'Owner source lease did not expire after abrupt context loss');
 for(const [label,viewer]of [['viewer1',viewer1],['viewer2',viewer2]])healthyRoom(await snapshot(viewer),'unreachable',label);
 await chatEverywhere(viewer2,[viewer1],'The source is unreachable and our private chat still works');
 const late=await page('late',invitation);
 await late.waitForFunction(()=>SameEndSocial.snapshot().connected&&SameEndSocial.snapshot().watching);
 healthyRoom(await snapshot(late),'unreachable','late',true);assert.equal(await late.locator('#club-chat-input').isVisible(),true,'Late viewer can see chat while source is away');
 await chatEverywhere(late,[viewer1,viewer2],'I joined the original invitation while the source was away');
 report.room.lateJoinsWithoutSource=true;await record('late original invitation opens waiting room and chat after real source lease expires');
 // Preserve all three viewers. Source fanout stays two and the existing peer tree
 // must carry the third viewer rather than silently raising source capacity.
 source=await page('source',undefined,saved);
 await source.waitForFunction(()=>SameEndSocial.snapshot().owner&&SameEndSocial.snapshot().watchInvitation,null,{timeout:15000});
 assert.equal((await snapshot(source)).social.id,roomId);
 assert.equal(await source.evaluate(()=>SameEndSocial.snapshot().watchInvitation),invitation);
 config=await startSource(source);await source.evaluate(()=>PrivateCast.testing.setRelayLimit(2));assert.notEqual(config.id,oldConfigId);
 for(const viewer of [viewer1,viewer2,late])await attached(viewer,config);
 await playing(viewer1);await probe(late);await playing(late);
 await until(async()=>{const state=await snapshot(viewer2);return state.ready>=2&&!state.paused;},30000,'Muted existing viewer did not follow restored owner source');
 assert.equal((await snapshot(viewer1)).muted,false);assert.equal((await snapshot(viewer2)).muted,true);assert.equal((await snapshot(late)).muted,false);
 for(const viewer of [viewer1,viewer2,late])await matching(viewer,config);
 await chatEverywhere(late,[source,viewer1,viewer2],'The same original invitation follows our restored shared screen');
 report.room.restoredPlayback=await measureWindow(['source','viewer1','viewer2','late'],5);
 report.organizerRestoredFromSavedIndexedDB=true;report.room.threeViewersFollowAtSourceFanoutTwo=true;
 await record('restored owner storage reuses same room; old and late viewers follow signed HLS with sound preferences');
 // Explicit Leave remains final even when another signed source is published.
 await viewer2.locator('#stop').click();await viewer2.waitForFunction(()=>!SameEndSocial.snapshot().watching&&!PrivateCast.snapshot().config);
 const leftBefore=await snapshot(viewer2);await source.locator('#stop').click();
 await chatEverywhere(viewer1,[source,late],'Chat continues while the restored source is deliberately stopped');
 config=await startSource(source);await source.evaluate(()=>PrivateCast.testing.setRelayLimit(2));
 for(const viewer of [viewer1,late])await attached(viewer,config);
 await playing(viewer1);await playing(late);const left=await snapshot(viewer2);
 assert.equal(left.social.watching,false);assert.equal(left.config,null);assert.equal(left.calls.joins,leftBefore.calls.joins);
 report.leaveStopsRetries=true;report.room.finalPlayback=await measureWindow(['source','viewer1','late'],4);
 const joining=await viewer1.evaluate(()=>SameEndInviteCheck.report().joining);
 assert.equal(joining.connectionMode,'direct-only');assert.equal(joining.relayFallbackConfigured,false);assert.equal(joining.network.relayConfigured,false);
 assert(apiBodies.every(body=>!body.cleartextMedia));await record('explicit Leave remains left after fresh source; original room and chat remain usable');report.pass=true;
}
async function run(){
 if(scenario==='room')return runRoom();
 let source=await page('source'),config=await startSource(source);await source.evaluate(()=>PrivateCast.testing.setRelayLimit(2));await source.locator('#make-magnet').click();await source.waitForFunction(()=>document.querySelector('#browser-invitation').value.includes('&watch=1'),null,{timeout:45000});
 const invitation=await source.locator('#browser-invitation').inputValue(),q=new URLSearchParams(new URL(invitation).hash.slice(1));assert(q.has('club')&&q.get('watch')==='1'&&!q.has('owner')&&!q.has('join'));report.stableInvitationShape=true;
 const viewer1=await page('viewer1',invitation),viewer2=await page('viewer2',invitation);
 for(const v of [viewer1,viewer2]){await received(v);await probe(v);await playing(v);await matching(v,config);}
 await chatEverywhere(viewer1,[source,viewer2],'Chirps and encrypted chat before faults');report.initial=await measureWindow(['source','viewer1','viewer2'],5);await viewer2.locator('#sound').click();assert.equal((await snapshot(viewer2)).muted,true);await record('initial signed HLS picture measured chirps chat; viewer2 chooses mute');
 if(scenario!=='baseline'){
  await source.locator('#stop').click();await Promise.all([viewer1,viewer2].map(v=>v.waitForFunction(()=>!PrivateCast.snapshot().config&&SameEndSocial.snapshot().watching,null,{timeout:20000})));await chatEverywhere(viewer1,[source,viewer2],'Chat while source stopped');const next=await startSource(source);assert.notEqual(next.id,config.id);config=next;for(const v of [viewer1,viewer2])await attached(v,config);await playing(viewer1);await until(async()=>{const s=await snapshot(viewer2);return s.ready>=2&&!s.paused;},30000,'Muted viewer did not resume');assert.equal((await snapshot(viewer1)).muted,false);assert.equal((await snapshot(viewer2)).muted,true);report.stopStart=await measureWindow(['source','viewer1','viewer2'],4);await record('source stop/start same stable invitation automatically followed');
 }
 // Hintless viewer outage: real peer closure + blocked discovery, beyond buffer and >90s.
 const before=await snapshot(viewer1),fault=await signalBlock('viewer1',true);assert(fault.closedNow>0,'fault closes actual peer connections');await until(async()=>!(await snapshot(viewer1)).supplier,10000,'Closed peer did not remove supplier');await sampleOutage('viewer1',outageSeconds);const cut=await snapshot(viewer1);assert.equal(cut.ownedNetwork.connectedPeerConnections,0);assert(cut.received<=before.received+2,'media delivery must actually stop');assert(cut.paused||cut.reserveSeconds<1,'outage exceeds actual useful buffer');report.viewerOutageSeconds=outageSeconds;await record('viewer real peer/discovery outage exceeded reserve');
 const restoredAt=Date.now();await signalBlock('viewer1',false);await waitRecovery('viewer1',config,before);report.viewerRecoveryMs=Date.now()-restoredAt;report.afterViewerOutage=await measureWindow(['source','viewer1','viewer2'],5);assert.equal((await snapshot(viewer1)).muted,false);assert.equal((await snapshot(viewer2)).muted,true);await record('viewer recovered automatically without online/retry/reload hint');
 if(scenario==='baseline'){report.pass=true;return;}
 // Source-side network refresh: retain capture/key/epoch; online is a distinct hint.
 const sourceBefore=await snapshot(source),v1Before=await snapshot(viewer1),v2Before=await snapshot(viewer2);await signalBlock('source',true);await sampleOutage('source',35);const sourceDuring=await snapshot(source);assert(sourceDuring.active&&sourceDuring.received>sourceBefore.received+5,'source capture continues during network outage');assert(sourceDuring.capture.encoderVideoPackets>sourceBefore.capture.encoderVideoPackets+500,'same encoder keeps producing through source route loss');await signalBlock('source',false);await source.evaluate(()=>dispatchEvent(new Event('online')));await waitRecovery('viewer1',config,v1Before);await waitRecovery('viewer2',config,v2Before);assert.deepEqual(identity(await snapshot(source)),identity(sourceBefore));report.sourceNetwork=await measureWindow(['source','viewer1','viewer2'],5);await record('source network restored without restarting capture or invitation');
 // Phone-like sleep uses actual renderer freeze, offline network and closed peers.
 const phoneBefore=await snapshot(viewer1),cdp=await contextByLabel.viewer1.newCDPSession(viewer1);await signalBlock('viewer1',true);await contextByLabel.viewer1.setOffline(true);await viewer1.evaluate(()=>{window.testHidden=true;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>testHidden?'hidden':'visible'});Object.defineProperty(document,'hidden',{configurable:true,get:()=>testHidden});document.dispatchEvent(new Event('visibilitychange'));});await cdp.send('Page.setWebLifecycleState',{state:'frozen'});report.environment.simulatedPhoneVisibility=true;report.environment.actualOwnedRendererFreeze=true;await pause(25000);await contextByLabel.viewer1.setOffline(false);blockedClients.delete('viewer1');await cdp.send('Page.setWebLifecycleState',{state:'active'});await signalBlock('viewer1',false);await viewer1.evaluate(()=>{testHidden=false;document.dispatchEvent(new Event('visibilitychange'));dispatchEvent(new Event('online'));});await waitRecovery('viewer1',config,phoneBefore);report.afterSleep=await measureWindow(['source','viewer1','viewer2'],4);await record('owned frozen hidden offline viewer recovered on resume without gesture');
 // Actual source context disappears; restore only its saved organizer storage in a new context.
 const saved=await contextByLabel.source.storageState({indexedDB:true}),oldId=config.id;await contextByLabel.source.close();await chatEverywhere(viewer1,[viewer2],'Chat survives abrupt host context loss');await pause(12000);
 const restored=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1280,height:900},storageState:saved});contexts.push(restored);await restored.route('**/*',route=>{const url=route.request().url();if(!url.startsWith(origin+'/')){externalRequests.push(new URL(url).hostname);return route.abort();}return route.continue();});source=await startNamedPage('source',restored);await source.waitForFunction(()=>SameEndSocial.snapshot().owner&&SameEndSocial.snapshot().watchInvitation,null,{timeout:15000});assert.equal(await source.evaluate(()=>SameEndSocial.snapshot().watchInvitation),invitation);config=await startSource(source);assert.notEqual(config.id,oldId);for(const v of [viewer1,viewer2])await attached(v,config);await playing(viewer1);await until(async()=>{const s=await snapshot(viewer2);return s.ready>=2&&!s.paused;},30000,'Muted viewer did not resume after context loss');assert.equal((await snapshot(viewer2)).muted,true);report.afterSourceContextLoss=await measureWindow(['source','viewer1','viewer2'],5);report.organizerRestoredFromSavedIndexedDB=true;await record('abrupt source context loss and saved organizer restoration automatically followed');
 // Explicit Leave stops future automatic picture joins, even after route restoration.
 await viewer2.locator('#stop').click();await viewer2.waitForFunction(()=>!SameEndSocial.snapshot().watching&&!PrivateCast.snapshot().config);const leftBefore=await snapshot(viewer2);await signalBlock('viewer2',true);await pause(3000);await signalBlock('viewer2',false);await viewer2.evaluate(()=>dispatchEvent(new Event('online')));await pause(12000);const left=await snapshot(viewer2);assert.equal(left.social.watching,false);assert.equal(left.config,null);assert.equal(left.calls.joins,leftBefore.calls.joins);assert.equal(left.ownedNetwork.connectedPeerConnections,0);report.leaveStopsRetries=true;
 const late=await page('late',invitation);await received(late);await probe(late);await playing(late);await matching(late,config);await chatEverywhere(late,[source,viewer1],'Same original invitation after all recoveries');report.final=await measureWindow(['source','viewer1','late'],4);await record('explicit Leave remains left; late original invitation resolves current source');
 const joining=await viewer1.evaluate(()=>SameEndInviteCheck.report().joining);assert.equal(joining.connectionMode,'direct-only');assert.equal(joining.relayFallbackConfigured,false);assert.equal(joining.network.relayConfigured,false);assert(apiBodies.every(b=>!b.cleartextMedia));report.pass=true;
}
try{await Promise.race([run(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Automatic reconnection acceptance exceeded15-minute bound')),900000);timer.unref();})]);assert.deepEqual(pageErrors,[]);assert.deepEqual(mediaAttempts,[]);assert.deepEqual(externalRequests,[]);}
catch(error){report.pass=false;report.error=sanitize(error.stack||error.message);console.error(report.error);process.exitCode=1;await record('failure').catch(()=>{});}
finally{report.completedAt=new Date().toISOString();report.pageErrors=pageErrors;report.trackerErrors=trackerErrors;report.httpMediaAttempts=mediaAttempts;report.externalRequestCount=externalRequests.length;report.backend={apiBodies,cleartextMediaBodies:apiBodies.filter(b=>b.cleartextMedia).length};await writeFile(new URL('result.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,error:report.error,buildSHA256:report.buildSHA256,viewerRecoveryMs:report.viewerRecoveryMs}));await Promise.all(contexts.map(c=>c.close().catch(()=>{})));await browser.close();for(const socket of tracker.clients)socket.terminate();await new Promise(r=>tracker.close(r));await new Promise(r=>server.close(r));}
