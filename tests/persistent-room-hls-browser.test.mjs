/* Stable private-room acceptance with real continuous HLS/CMAF capture,
 * signed WebRTC media, local WSS discovery and ephemeral encrypted club API.
 * Tests two viewers, Stop/waiting chat, automatic restart, late same-URL join,
 * owner reload/start and explicit Leave. All browser contexts are isolated on
 * ONE Mac; no physical-device, separate-network or public-service claim.
 * Build first, then node tests/persistent-room-hls-browser.test.mjs (~2 minutes).
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../backend/api.mjs';
import { MemoryStore } from '../backend/store.mjs';

const runtime = process.env.SAMEEND_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(runtime), require = createRequire(import.meta.url);
const { wsServer: WebSocketServer } = require(join(dirname(dirname(runtime)), 'playwright-core/lib/utilsBundle.js'));
const root = new URL('../', import.meta.url), output = new URL('privatework/persistent-room-hls/', root);
await mkdir(output, { recursive: true });
const originalHTML = await readFile(new URL('dist/watch.html', root), 'utf8');
// Dormant transport code is injected only when an invitation is made. Parse it
// explicitly so build-time HTML insertion cannot silently corrupt that path.
for (const id of ['magnet-module', 'magnet-vendor']) {
  const asset = originalHTML.match(new RegExp('<script[^>]*id=\"' + id + '\"[^>]*>([\\s\\S]*?)<\\/script>'));
  assert(asset, 'Built app contains ' + id);
  assert.doesNotThrow(() => new Function(asset[1]), 'Built deferred asset parses: ' + id);
}
const publicBase = JSON.parse(await readFile(new URL('public-config.json', root), 'utf8')).apiBase;
const certDir = await mkdtemp(join(tmpdir(), 'sameend-hls-room-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-subj', '/CN=localhost'], { stdio: 'ignore' });
let origin, servedHTML, api;
const apiBodies = [];
const requests = [], mediaAttempts = [], externalRequests = [], trackerErrors = [];
const server = https.createServer({ key: await readFile(join(certDir, 'key.pem')), cert: await readFile(join(certDir, 'cert.pem')) }, async (req, res) => {
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
const trackerStats = { connections: 0, announces: 0, offers: 0, answers: 0 };
const send = (socket, message) => { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); };
tracker.on('connection', socket => {
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
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const pages = {}, contexts = [], pageErrors = [];
const report = { schema: 1, startedAt: new Date().toISOString(), buildSHA256: createHash('sha256').update(originalHTML).digest('hex'), environment: { oneComputer: true, actualWebRTC: true, isolatedChromeContexts: true, localWssDiscovery: true, ephemeralLocalEncryptedChat: true, generatedMedia: true, autoplayOverride: false, localSelfSignedCertificateOverride: true, physicalDevices: false, separateNetworks: false, cloudVideoRelay: false, delay: 10 }, tracker: trackerStats, events: [], samples: [], pass: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sanitize = value => String(value).replace(/https?:\/\/\S*#\S*/g, '[private invitation removed]').replace(/magnet:\S+/g, '[magnet invitation removed]').replace(/#pc=[A-Za-z0-9_-]+/g, '#pc=[removed]');
async function until(check, timeout, message) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await pause(250); } throw Error(message); }
async function page(label, invitation) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } }); contexts.push(context);
  await context.route('**/*', route => { const url = route.request().url(); if (!url.startsWith(origin + '/')) { externalRequests.push(new URL(url).hostname); if (/\.(?:m3u8|m4s|mp4|ts)(?:$|[?#])/i.test(url)) mediaAttempts.push('[blocked external media]'); return route.abort(); } return route.continue(); });
  await context.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    if(!window.PrivateCast)return; window.acceptanceCalls={joins:0,publishes:0,leaves:0};
    for(const [name,count] of [['joinMagnet','joins'],['publishInvitation','publishes'],['leaveRoom','leaves']]) {const original=PrivateCast[name];PrivateCast[name]=function(...args){acceptanceCalls[count]++;return original.apply(this,args);};}
  }));
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
    if (probe) { const data = new Float32Array(probe.analyser.fftSize); probe.analyser.getFloatTimeDomainData(data); rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length); }
    return { social:SameEndSocial.snapshot(), calls:window.acceptanceCalls, muted:video.muted, sampledAt: Date.now(), nodeId: state.nodeId, config: state.config, sourceReachable: state.sourceReachable, sourceEnded: state.sourceEnded, role: state.role, supplier: state.supplier, clockReady: state.clockReady, received: state.received, reserveSeconds: state.reserveSeconds, recovery: state.recovery, stalls: state.stalls, programTime: state.programTime, target: state.targetProgramTime, drift: state.drift, peers: state.peers, mode: state.playbackMode, cacheBytes: state.cacheBytes, playback: state.mediaDiagnostics.playback, delivery: state.delivery, chatCount: SameEndSocial.snapshot().chatCount, chatConnected: SameEndSocial.snapshot().connected, chatHidden: document.querySelector('#club-chat-shell')?.hidden, chatParent: document.querySelector('#club-chat-shell')?.parentElement?.className || null, frames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0, frameCallbacks: probe?.frames || 0, lastFrameAt: probe?.lastFrameAt || null, rms, ready: video.readyState, paused: video.paused, width: video.videoWidth, height: video.videoHeight, status: document.querySelector('#play-state').textContent };
  }).catch(error => { if (page.isClosed()) return { closed: true }; throw error; });
}
async function record(label) { const states = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, page]) => [name, await snapshot(page)]))); report.events.push({ label, at: Date.now(), states }); console.log(JSON.stringify({ stage: label })); return states; }
async function probe(page) {
  await page.evaluate(() => {
    const video = document.querySelector('#player'), context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaElementSource(video).connect(analyser); analyser.connect(context.destination);
    const probe = window.hlsRoomProbe = { context, analyser, frames: 0, lastFrameAt: null };
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
    assert(states.every(state => state.mode === 'hls' && !state.paused && state.ready >= 2), label + ' remains in continuous HLS playback');
    assert(states.at(-1).frames > states[0].frames + seconds * 10, label + ' must keep decoding moving pictures');
    if(label!=='source')assert(states.filter(state => state.rms > .001).length >= states.length * .9, label + ' must keep decoded test sound');
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
async function captureUI(label,participant,{mobile=false}={}) {
  if(mobile)await participant.setViewportSize({width:390,height:844});
  await participant.evaluate(async()=>{scrollTo(0,0);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const layout=await participant.evaluate(()=>{
    const video=document.querySelector('#player'),stage=video.closest('.stage'),chat=document.querySelector('#club-chat-shell');
    const geometry=element=>{if(!element)return null;const r=element.getBoundingClientRect(),s=getComputedStyle(element);return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right,position:s.position,display:s.display,overflow:s.overflow,objectFit:s.objectFit,transform:s.transform};};
    return {viewport:innerWidth,viewportHeight:innerHeight,scrollX,scrollY,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,watching:SameEndSocial.snapshot().watching,waiting:SameEndSocial.snapshot().watchWaiting,playing:!video.paused&&video.readyState>=2,stage:geometry(stage),video:geometry(video),chat:geometry(chat)};
  });
  const masks=[participant.locator('input'),participant.locator('textarea')];
  if(mobile)await participant.screenshot({path:fileURLToPath(new URL(label+'-viewport.png',output)),fullPage:false,mask:masks});
  await participant.screenshot({path:fileURLToPath(new URL(label+'.png',output)),fullPage:true,mask:masks});
  (report.ui||(report.ui=[])).push({label,mobile,layout,screenshot:label+'.png',...(mobile?{viewportScreenshot:label+'-viewport.png'}:{})});
  assert(layout.documentWidth<=layout.viewport+1&&layout.bodyWidth<=layout.viewport+1,label+' has no horizontal overflow');
  if(mobile&&layout.playing){const {video:v,stage:t,chat:c}=layout;assert(v.width>0&&v.height>0&&v.left>=t.left-2&&v.right<=t.right+2&&v.top>=t.top-2&&v.bottom<=t.bottom+2,label+' video element stays inside its stage');assert(v.bottom<=c.top+2&&t.bottom<=c.top+2,label+' picture and stage stay above mobile chat');}
}
async function run(){
 const source=await page('source'),first=await startSource(source);await source.evaluate(()=>PrivateCast.testing.setRelayLimit(2));
 await source.locator('#make-magnet').click();
 await source.waitForFunction(()=>document.querySelector('#browser-invitation').value.includes('&watch=1'),null,{timeout:45000});
 const stable=await source.locator('#browser-invitation').inputValue(),url=new URL(stable),q=new URLSearchParams(url.hash.slice(1));
 assert(q.has('club'));assert.equal(q.get('watch'),'1');assert(!q.has('owner'));assert(!q.has('join'));assert(!stable.includes('magnet:'));report.stableUrlShape={club:true,watch:true,owner:false,magnet:false};
 const v1=await page('viewer1',stable),v2=await page('viewer2',stable);
 for(const viewer of [v1,v2]){await received(viewer);await probe(viewer);await playing(viewer);await matching(viewer,first);}
 await chatEverywhere(v1,[source,v2],'Before restart: both viewers watching');
 report.source1=await measureWindow(['source','viewer1','viewer2'],5);await record('source1 stable URL two viewers picture sound encrypted chat');
 // Real product Stop in the source page; viewers must keep the club and chat.
 await source.locator('#stop').click();
 await Promise.all([v1,v2].map(v=>v.waitForFunction(()=>!PrivateCast.snapshot().config&&SameEndSocial.snapshot().watching&&SameEndSocial.snapshot().connected,null,{timeout:20000})));
 await chatEverywhere(v2,[source,v1],'While waiting: chat still works');await record('source1 stopped: waiting viewers retain chat');
 await captureUI('host-waiting',source);await captureUI('viewer-waiting',v1);await captureUI('mobile-waiting',v2,{mobile:true});
 const second=await startSource(source);assert.notEqual(second.id,first.id);assert.notEqual(second.epoch,first.epoch);await source.evaluate(()=>PrivateCast.testing.setRelayLimit(2));
 await source.waitForFunction(()=>SameEndSocial.snapshot().hasLive,null,{timeout:25000});
 assert.equal(await source.evaluate(()=>SameEndSocial.snapshot().watchInvitation),stable,'same original invitation after restart');
 // No invitation click, sound click, join call or reload on either viewer.
 for(const viewer of [v1,v2]){await attached(viewer,second);await playing(viewer);const s=await matching(viewer,second);assert.equal(s.muted,false,'audible preference survives new source');}
 report.source2=await measureWindow(['source','viewer1','viewer2'],5);await record('source2 auto-published and existing viewers automatically playing with sound');
 await captureUI('mobile-source2-playing',v2,{mobile:true});
 const late=await page('late',stable);await received(late);await probe(late);await playing(late);await matching(late,second);
 await chatEverywhere(late,[source,v1,v2],'Late viewer resolved current source2');report.source2Late=await measureWindow(['source','viewer1','viewer2','late'],4);await record('late viewer original stable URL resolves source2');
 // Explicit Leave must cancel follow intent and remain left across next restart.
 await late.locator('#stop').click();await late.waitForFunction(()=>!SameEndSocial.snapshot().watching&&!PrivateCast.snapshot().config);
 const lateCalls=(await snapshot(late)).calls.joins;
 // Reload source while source2 is active, restore saved host room, start source3.
 await source.reload();await source.waitForFunction(()=>SameEndSocial.snapshot().owner&&SameEndSocial.snapshot().watchInvitation,null,{timeout:15000});
 assert.equal(await source.evaluate(()=>SameEndSocial.snapshot().watchInvitation),stable,'saved owner room restores identical invitation');
 const third=await startSource(source);assert.notEqual(third.id,second.id);assert.notEqual(third.epoch,second.epoch);await source.evaluate(()=>PrivateCast.testing.setRelayLimit(2));
 await source.waitForFunction(()=>SameEndSocial.snapshot().hasLive&&document.querySelector('#magnet-link').value,null,{timeout:30000});
 for(const viewer of [v1,v2]){await attached(viewer,third);await playing(viewer);const s=await matching(viewer,third);assert.equal(s.muted,false);}
 await chatEverywhere(v1,[source,v2],'After owner reload: source3 and same chat');
 report.source3=await measureWindow(['source','viewer1','viewer2'],5);await record('source3 reload restoration automatically followed; explicit Leave respected');
 const left=await snapshot(late);assert.equal(left.social.watching,false);assert.equal(left.config,null);assert.equal(left.calls.joins,lateCalls,'explicit Leave prevents automatic new joins');
 report.joinCounts={};for(const label of ['viewer1','viewer2','late']){const s=await snapshot(pages[label]);report.joinCounts[label]=s.calls;assert(s.calls.joins<=(label==='late'?1:3),'no repeated join storm: '+label);}
 assert.equal(await source.evaluate(()=>SameEndSocial.snapshot().watchInvitation),stable);
 assert.deepEqual(pageErrors,[]);assert.deepEqual(trackerErrors,[]);assert.deepEqual(mediaAttempts,[]);assert.deepEqual(externalRequests,[]);assert(apiBodies.every(b=>!b.cleartextMedia));
 report.backend={mediaRequests:mediaAttempts.length,apiBodyMetadata:apiBodies,encryptedStateAndMessagesOnly:true};
 report.pass=true;console.log(JSON.stringify({pass:true,joinCounts:report.joinCounts,source1:report.source1,source2:report.source2,source2Late:report.source2Late,source3:report.source3}));
}
try{await Promise.race([run(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Stable HLS acceptance exceeded eight-minute bound')),480000);timer.unref();})]);}
catch(error){report.error=sanitize(error.stack||error.message);console.error(report.error);process.exitCode=1;await record('failure').catch(()=>{});}
finally{
 report.completedAt=new Date().toISOString();report.pageErrors=pageErrors;report.trackerErrors=trackerErrors;report.httpMediaAttempts=mediaAttempts;report.externalRequestCount=externalRequests.length;
 await writeFile(new URL('result.json',output),JSON.stringify(report,null,2));
 await Promise.all(contexts.map(c=>c.close()));await browser.close();for(const socket of tracker.clients)socket.terminate();await new Promise(resolve=>tracker.close(resolve));await new Promise(resolve=>server.close(resolve));await rm(certDir,{recursive:true,force:true});
}
