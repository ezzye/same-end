/* Exact browser-produced HLS/CMAF acceptance. No ffmpeg repackaging, timestamp
 * rewriting or Apple WebAudio graph. The optional private server also drives
 * simulator/emulator checks with the same fully prefetched transport bytes. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { decodeBundle } from '../hls-protocol.js';

const root = new URL('../', import.meta.url), captureDir = new URL('privatework/hls-capture/', root), out = new URL('privatework/hls-produced/', root);
await mkdir(out, { recursive: true });
let batches;
try { batches = JSON.parse(await readFile(new URL('batches.json', captureDir))); if (!batches.every(b => b.transport?.path)) throw Error('Missing exact transport fixture'); }
catch { execFileSync(process.execPath, [new URL('tests/hls-capture-browser.test.mjs', root).pathname], { cwd: root.pathname, stdio: 'inherit', timeout: 100000 }); batches = JSON.parse(await readFile(new URL('batches.json', captureDir))); }
const sourceEvidence = JSON.parse(await readFile(new URL('evidence.json', captureDir)));
assert(sourceEvidence.capture.frames > 750); assert.equal(sourceEvidence.capture.stats.videoEncoderConfigurations, 1); assert.equal(sourceEvidence.capture.stats.audioEncoderConfigurations, 1);
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', new URL('master.m3u8', captureDir).pathname], { encoding: 'utf8' }));
const video = probe.streams.find(s => s.codec_type === 'video'), audio = probe.streams.find(s => s.codec_type === 'audio');
assert.equal(video.codec_name, 'h264'); assert.equal(video.profile, 'High'); assert.equal(video.width, 1280); assert.equal(video.height, 720); assert.equal(audio.codec_name, 'aac');
const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), publicKey = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
const pieces = await Promise.all(batches.map(async b => {
  const bytes = await readFile(new URL(b.transport.path, captureDir)), hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, b.transport.sha256, 'Stored producer transport changed'); const decoded = decodeBundle(bytes);
  assert.equal(decoded.start, b.start); assert.equal(decoded.duration, b.duration);
  for (const file of decoded.files) assert.equal(file.bytes.byteLength, b.files.find(f => f.path === file.path).bytes);
  return { start: b.start, duration: b.duration, sha256: hash, bytes: bytes.toString('base64'), signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes)).toString('base64') };
}));
assert(Math.max(...pieces.map(p => p.start + p.duration)) >= 31);
const [playerBuild, workerBuild] = await Promise.all([
  build({ entryPoints: [new URL('streaming-entry.js', root).pathname], bundle: true, write: false, format: 'esm', target: ['es2017', 'safari12.1'] }),
  build({ entryPoints: [new URL('hls-sw-handler.js', root).pathname], bundle: true, write: false, format: 'iife', globalName: 'SameEndHLSWorker', target: ['es2017', 'safari12.1'] }),
]);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Same End actual producer acceptance</title><style>body{font:16px system-ui;background:#092e22;color:white;margin:0;padding:16px}video{width:100%;max-height:65vh;background:black}button{font:inherit;padding:14px 22px;border:0;border-radius:8px;background:#e72a24;color:white;margin:14px 0}pre{white-space:pre-wrap}canvas{display:none}</style><h1>Actual Same End picture and sound</h1><video id=v playsinline muted></video><button id=start disabled>Play picture and sound</button><p id=status>Preparing the private generated test…</p><pre id=metrics></pre><canvas id=canvas width=32 height=18></canvas><script type=module>
import {HlsPlayer,NativePlayer} from '/player.js';
const q=new URLSearchParams(location.search),mode=q.get('mode')||'hls',target=Number(q.get('target')||0),duration=Number(q.get('duration')||30),device=(q.get('device')||mode).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60),epoch=1700000000000;
const ctx=canvas.getContext('2d');window.errors=[];window.samples=[];window.frames=[];window.clicks=0;window.ready=false;window.finished=false;window.prefetched=false;let frameId,timer,measurementTimer;
const bytes=x=>Uint8Array.from(atob(x),c=>c.charCodeAt(0)),hex=a=>Array.from(new Uint8Array(a),x=>x.toString(16).padStart(2,'0')).join('');
const measure=()=>{const facts=player.facts(),wave=window.an?new Float32Array(an.fftSize):null;if(wave)an.getFloatTimeDomainData(wave);let pixels=null;try{ctx.drawImage(v,0,0,32,18);pixels=Array.from(ctx.getImageData(0,0,32,18).data).reduce((h,x)=>((h*31+x)>>>0),0)}catch{}return{at:performance.now()-t0,target:target+(performance.now()-t0)/1000,program:player.programTime(),ready:v.readyState,paused:v.paused,muted:v.muted,width:v.videoWidth,height:v.videoHeight,pixels,rms:wave?Math.sqrt(wave.reduce((n,x)=>n+x*x,0)/wave.length):null,facts}};
async function postMeasurement(final=false){if(!window.player||!window.t0)return;const s=measure(),payload={device,mode,final,at:s.at,target:s.target,program:s.program,drift:s.program===null?null:s.target-s.program,ready:s.ready,paused:s.paused,muted:s.muted,decodedFrames:s.facts.decodedFrames,width:s.width,height:s.height,errorCount:errors.length,sourceChanges:s.facts.srcChanges,cacheBytes:s.facts.cacheBytes};try{await fetch('/measurements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})}catch{}}
window.prepare=async()=>{try{const key=await crypto.subtle.importKey('jwk',${JSON.stringify(publicKey)},{name:'ECDSA',namedCurve:'P-256'},false,['verify']),packed=await(await fetch('/pieces')).json();window.input=await Promise.all(packed.map(async(p,i)=>{const buf=bytes(p.bytes).buffer;if(hex(await crypto.subtle.digest('SHA-256',buf))!==p.sha256||!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,bytes(p.signature),buf))throw Error('Actual producer bytes failed verification');return{meta:{seq:i,start:epoch+p.start*1000,duration:p.duration*1000},buf}}));prefetched=true;v.autoplay=true;window.player=new(mode==='native'?NativePlayer:HlsPlayer)(v,{audio:true},{onError:e=>{errors.push(e);document.querySelector('#status').textContent=e}});player.cache.maxBytes=32*1024*1024;player.cache.retainSeconds=60;player.setPlaybackWindow(-1);for(const piece of input)player.enqueue(piece,epoch);if(player.ready)await player.ready;await new Promise(r=>setTimeout(r,200));if(player.started||v.autoplay||!v.paused||(v.getVideoPlaybackQuality?.().totalVideoFrames||0)>0)throw Error('Picture or legacy autoplay escaped the warm-up');window.warmupHeld=true;player.setPlaybackWindow(target);window.ready=true;start.disabled=false;document.querySelector('#status').textContent='Ready. One tap starts 30 seconds of generated picture and sound.';}catch(e){errors.push(e.message);document.querySelector('#status').textContent=e.stack||e.message;throw e}};
start.onclick=()=>{if(window.t0)return;clicks++;if(q.get('analyser')==='1'){window.ac=new AudioContext();window.an=ac.createAnalyser();an.fftSize=2048;ac.createMediaElementSource(v).connect(an);an.connect(ac.destination);ac.resume()}player.requestSound().catch(()=>{});window.t0=performance.now();let last=null;if(v.requestVideoFrameCallback){const frame=(now,m)=>{if(last!==null)frames.push({at:now-t0,gap:now-last,program:player.origin+m.mediaTime,target:target+(now-t0)/1000});last=now;frameId=v.requestVideoFrameCallback(frame)};frameId=v.requestVideoFrameCallback(frame)}timer=setInterval(()=>{const t=target+(performance.now()-t0)/1000,sync=player.sync(t),s=measure();s.waiting=sync.waiting;s.drift=sync.drift;samples.push(s);metrics.textContent=JSON.stringify({mode,seconds:Math.floor(s.at/1000),picture:s.width+'×'+s.height,frames:s.facts.decodedFrames,groupDrift:s.program===null?null:Math.round((s.target-s.program)*1000),paused:s.paused,soundOn:!s.muted,errors},null,2)},100);measurementTimer=setInterval(()=>postMeasurement(),1000);setTimeout(()=>window.done(),duration*1000)};
window.done=()=>{if(!window.finished){clearInterval(timer);clearInterval(measurementTimer);if(frameId!==undefined)v.cancelVideoFrameCallback?.(frameId);postMeasurement(true);window.finalFacts=player.facts();player.setPlaybackWindow(player.target,true);window.finished=true;document.querySelector('#status').textContent='Test complete. Picture stayed on this device; results were saved privately.'}return{samples,frames,errors,clicks,warmupHeld,verified:input.length,facts:finalFacts,webAudioConnected:!!window.ac}};
if(q.has('mode'))prepare().catch(()=>{});
</script></html>`;
const requests = [], measurements = []; let saving = Promise.resolve();
const safeNumber = v => typeof v === 'number' && Number.isFinite(v) ? Math.max(-1e12, Math.min(1e12, v)) : null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push({ path: url.pathname, method: req.method });
  if (url.pathname === '/player.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(playerBuild.outputFiles[0].text);
  if (url.pathname === '/sw.js') return res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }).end(workerBuild.outputFiles[0].text + ';SameEndHLSWorker.install(self);self.addEventListener("message",e=>{if(e.data?.type==="ACTIVATE_UPDATE")self.skipWaiting()});self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));');
  if (url.pathname === '/pieces') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(pieces));
  if (url.pathname === '/measurements' && req.method === 'POST') {
    try { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Error('Too large'); chunks.push(chunk); } const data = JSON.parse(Buffer.concat(chunks));
      const clean = { recordedAt: new Date().toISOString(), device: typeof data.device === 'string' ? data.device.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) : '', mode: ['hls', 'native'].includes(data.mode) ? data.mode : null, final: data.final === true };
      for (const field of ['at', 'target', 'program', 'drift', 'ready', 'decodedFrames', 'width', 'height', 'errorCount', 'sourceChanges', 'cacheBytes']) clean[field] = safeNumber(data[field]);
      for (const field of ['paused', 'muted']) clean[field] = typeof data[field] === 'boolean' ? data[field] : null;
      measurements.push(clean); if (measurements.length > 1200) measurements.shift(); saving = saving.then(() => writeFile(new URL('device-measurements.json', out), JSON.stringify(measurements, null, 2))); await saving;
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"saved":true}');
    } catch { return res.writeHead(400).end(); }
  }
  if (url.pathname.startsWith('/_sameend/hls/') || /\.(m3u8|m4s|mp4)$/.test(url.pathname)) return res.writeHead(403).end('Video is supplied only by the verified page cache');
  return res.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': 'no-referrer' }).end(html);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.PORT) || 0, '127.0.0.1', resolve); });
const origin = 'http://127.0.0.1:' + server.address().port;
const report = { scope: 'Exact HLS/CMAF envelopes emitted by hls-capture.js; fully prefetched without repackaging', physicalDevice: false, networkRoute: false, source: { width: video.width, height: video.height, codec: video.codec_name, profile: video.profile, level: video.level, audio: audio.codec_name, sourceFrames: sourceEvidence.capture.frames, videoPackets: sourceEvidence.capture.stats.videoPackets, audioRms: sourceEvidence.decoded.audioRms, batchCount: pieces.length, transportSHA256: pieces.map(p => p.sha256) }, scenarios: [] };
await writeFile(new URL('fixture-proof.json', out), JSON.stringify(report, null, 2));
if (process.env.SERVE_ONLY === '1') {
  console.log(JSON.stringify({ ready: true, nodePid: process.pid, origin, native: origin + '/?mode=native&target=0&duration=30&device=apple', hls: origin + '/?mode=hls&target=0&duration=30&device=android', measurements: new URL('device-measurements.json', out).pathname }));
  await new Promise(resolve => { for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(resolve)); }); await saving;
} else {
  const pw = await import(process.env.SAMEEND_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const duration = Number(process.env.DURATION || 20); assert(duration >= 15 && duration <= 24);
  try {
    for (const [engine, mode] of [['chromium', 'hls'], ['webkit', 'hls'], ['webkit', 'native']]) {
      const browser = await pw[engine].launch(engine === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true });
      try { const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(origin + '/?mode=' + mode + '&target=4&duration=' + duration + '&device=' + engine + '-' + mode + (engine === 'chromium' ? '&analyser=1' : ''));
        await page.waitForFunction(() => ready, null, { timeout: 25000 }); const prefetchedAt = requests.length; await page.locator('#start').click();
        console.log(JSON.stringify({ scenarioStarted: engine + '-' + mode, nodePid: process.pid })); await page.waitForFunction(() => finished, null, { timeout: (duration + 8) * 1000 });
        const raw = await page.evaluate(() => done()), stable = raw.samples.filter(s => s.at >= 3000 && s.at <= duration * 1000 - 300), frames = raw.frames.filter(f => f.at >= 3000);
        const summary = { engine, mode, duration, exactProducerBytes: true, webAudioConnected: raw.webAudioConnected, warmupHeld: raw.warmupHeld, verified: raw.verified, sourceChanges: raw.facts.srcChanges, errorCount: raw.errors.length, pageErrors: errors, waitingSamples: stable.filter(s => s.waiting).length, pausedSamples: stable.filter(s => s.paused).length, maxAbsDrift: Math.max(0, ...stable.filter(s => s.program !== null).map(s => Math.abs(s.target - s.program))), frameSamples: frames.length, maxFrameGapMs: Math.max(0, ...frames.map(f => f.gap)), distinctFramePixels: new Set(stable.map(s => s.pixels).filter(x => x !== null)).size, decodedIncrease: stable.length ? stable.at(-1).facts.decodedFrames - stable[0].facts.decodedFrames : 0, audibleSamples: stable.filter(s => s.rms > .005 && !s.muted && !s.paused).length, width: raw.facts.width, height: raw.facts.height, cacheBytes: raw.facts.cacheBytes, syncSeeks: raw.facts.syncSeekRequests, backendMediaRequests: requests.slice(prefetchedAt).filter(x => x.path.startsWith('/_sameend/hls/') || /\.(m3u8|m4s|mp4)$/.test(x.path)) };
        report.scenarios.push(summary); await writeFile(new URL(engine + '-' + mode + '.json', out), JSON.stringify({ summary, ...raw }, null, 2)); console.log(JSON.stringify(summary));
        assert.equal(raw.verified, pieces.length); assert.equal(raw.warmupHeld, true); assert.equal(raw.facts.srcChanges, 1); assert.equal(errors.length, 0); assert.deepEqual(raw.errors, []); assert.equal(summary.width, 1280); assert.equal(summary.height, 720); assert(summary.cacheBytes <= 32 * 1024 * 1024); assert.equal(summary.backendMediaRequests.length, 0); assert.equal(summary.waitingSamples, 0); assert.equal(summary.pausedSamples, 0); assert(summary.maxAbsDrift < .85, 'Actual producer shared timeline drift'); assert(summary.distinctFramePixels > (duration - 4) * 6, 'Actual producer moving picture'); assert(summary.decodedIncrease > (duration - 4) * 20, 'Actual producer decode cadence'); if (frames.length) assert(summary.maxFrameGapMs < 600, 'Actual producer frame cadence stalled'); assert(raw.facts.syncSeekRequests <= 3, 'Repeated synchronization seeks');
        if (engine === 'chromium') assert(summary.audibleSamples > stable.length * .85, 'Actual producer AAC decoded tone'); else assert.equal(raw.webAudioConnected, false, 'Apple output graph must remain unmodified');
        await page.evaluate(() => player.close());
      } finally { await browser.close(); }
    }
    report.result = 'pass'; report.appleAudioEvidence = 'Unmodified output route; encoded source AAC is independently audible. Native speaker output requires separate owned-process capture.';
  } catch (error) { report.result = 'fail'; report.error = error.stack; throw error; }
  finally { await saving; await new Promise(r => server.close(r)); await writeFile(new URL('report.json', out), JSON.stringify(report, null, 2)); }
}
