/* Exact browser-produced HLS/CMAF acceptance. No ffmpeg repackaging, timestamp
 * rewriting or Apple WebAudio graph. The optional private server also drives
 * simulator/emulator checks with the same fully prefetched transport bytes. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { decodeBundle } from '../hls-protocol.js';

const root = new URL('../', import.meta.url), captureDirectory = process.env.HLS_CAPTURE_DIR || 'privatework/hls-capture/', captureDir = new URL(captureDirectory.endsWith('/') ? captureDirectory : captureDirectory + '/', root), outputTag = process.env.OUTPUT_TAG ? process.env.OUTPUT_TAG.replace(/[^a-zA-Z0-9_-]/g, '_') + '/' : '', out = new URL('privatework/hls-produced/' + outputTag, root);
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
const sourceDuration = Math.max(...pieces.map(p => p.start + p.duration)); assert(sourceDuration >= 31);
const [playerBuild, workerBuild] = await Promise.all([
  build({ entryPoints: [new URL('streaming-entry.js', root).pathname], bundle: true, write: false, format: 'esm', target: ['es2017', 'safari12.1'] }),
  build({ entryPoints: [new URL('hls-sw-handler.js', root).pathname], bundle: true, write: false, format: 'iife', globalName: 'SameEndHLSWorker', target: ['es2017', 'safari12.1'] }),
]);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Same End actual producer acceptance</title><style>body{font:16px system-ui;background:#092e22;color:white;margin:0;padding:16px}video{width:100%;max-height:65vh;background:black}button{font:inherit;padding:14px 22px;border:0;border-radius:8px;background:#e72a24;color:white;margin:14px 0}pre{white-space:pre-wrap}canvas{display:none}</style><h1>Actual Same End picture and sound</h1><video id=v playsinline muted></video><button id=start disabled>Play picture and sound</button><p id=status>Preparing the private generated test…</p><pre id=metrics></pre><canvas id=canvas width=32 height=18></canvas><script type=module>
import {HlsPlayer,NativePlayer} from '/player.js';
const q=new URLSearchParams(location.search),mode=q.get('mode')||'hls',target=Number(q.get('target')||0),duration=Number(q.get('duration')||30),device=(q.get('device')||mode).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60),epoch=1700000000000;
const ctx=canvas.getContext('2d');window.errors=[];window.samples=[];window.frames=[];window.clicks=0;window.ready=false;window.finished=false;window.prefetched=false;let frameId,timer,measurementTimer;
const bytes=x=>Uint8Array.from(atob(x),c=>c.charCodeAt(0)),hex=a=>Array.from(new Uint8Array(a),x=>x.toString(16).padStart(2,'0')).join('');
const ranges=r=>Array.from({length:r.length},(_,i)=>[r.start(i),r.end(i)]);
const measure=()=>{const facts=player.facts(),wave=window.an?new Float32Array(an.fftSize):null;if(wave)an.getFloatTimeDomainData(wave);let pixels=null;try{ctx.drawImage(v,0,0,32,18);pixels=Array.from(ctx.getImageData(0,0,32,18).data).reduce((h,x)=>((h*31+x)>>>0),0)}catch{}return{at:performance.now()-t0,target:target+(performance.now()-t0)/1000,program:player.programTime(),ready:v.readyState,paused:v.paused,muted:v.muted,width:v.videoWidth,height:v.videoHeight,buffered:ranges(v.buffered),seekable:ranges(v.seekable),pixels,rms:wave?Math.sqrt(wave.reduce((n,x)=>n+x*x,0)/wave.length):null,facts}};
async function postMeasurement(final=false){if(!window.player||!window.t0)return;const s=measure(),payload={device,mode,final,at:s.at,target:s.target,program:s.program,drift:s.program===null?null:s.target-s.program,ready:s.ready,paused:s.paused,muted:s.muted,decodedFrames:s.facts.decodedFrames,width:s.width,height:s.height,errorCount:errors.length,sourceChanges:s.facts.srcChanges,cacheBytes:s.facts.cacheBytes};try{await fetch('/measurements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})}catch{}}
window.prepare=async()=>{try{const key=await crypto.subtle.importKey('jwk',${JSON.stringify(publicKey)},{name:'ECDSA',namedCurve:'P-256'},false,['verify']),packed=await(await fetch('/pieces')).json();window.input=await Promise.all(packed.map(async(p,i)=>{const buf=bytes(p.bytes).buffer;if(hex(await crypto.subtle.digest('SHA-256',buf))!==p.sha256||!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,bytes(p.signature),buf))throw Error('Actual producer bytes failed verification');return{meta:{seq:i,start:epoch+p.start*1000,duration:p.duration*1000},buf}}));prefetched=true;v.autoplay=true;window.player=new(mode==='native'?NativePlayer:HlsPlayer)(v,{audio:true},{onError:e=>{errors.push(e);document.querySelector('#status').textContent=e}});player.cache.maxBytes=32*1024*1024;player.cache.retainSeconds=60;window.staged=new Set();window.stage=t=>{player.setPlaybackWindow(t);for(let i=0;i<input.length;i++){const piece=input[i],start=(piece.meta.start-epoch)/1000,end=start+piece.meta.duration/1000;if(!staged.has(i)&&end>=t-4&&start<=t+player.lookAheadSeconds()){player.enqueue(piece,epoch);staged.add(i)}}};stage(-1);if(player.ready)await player.ready;await new Promise(r=>setTimeout(r,200));if(player.started||v.autoplay||!v.paused||(v.getVideoPlaybackQuality?.().totalVideoFrames||0)>0)throw Error('Picture or legacy autoplay escaped the warm-up');window.warmupHeld=true;stage(target);window.ready=true;start.disabled=false;document.querySelector('#status').textContent='Ready. One tap starts '+duration+' seconds of generated picture and sound.';}catch(e){errors.push(e.message);document.querySelector('#status').textContent=e.stack||e.message;throw e}};
start.onclick=()=>{if(window.t0)return;clicks++;if(q.get('analyser')==='1'){window.ac=new AudioContext();window.an=ac.createAnalyser();an.fftSize=2048;ac.createMediaElementSource(v).connect(an);an.connect(ac.destination);ac.resume()}player.requestSound().catch(()=>{});window.t0=performance.now();let last=null;if(v.requestVideoFrameCallback){const frame=(now,m)=>{if(last!==null)frames.push({at:now-t0,gap:now-last,program:player.origin+m.mediaTime,target:target+(now-t0)/1000});last=now;frameId=v.requestVideoFrameCallback(frame)};frameId=v.requestVideoFrameCallback(frame)}timer=setInterval(()=>{const t=target+(performance.now()-t0)/1000;stage(t);const sync=player.sync(t),s=measure();s.waiting=sync.waiting;s.drift=sync.drift;samples.push(s);metrics.textContent=JSON.stringify({mode,seconds:Math.floor(s.at/1000),picture:s.width+'×'+s.height,frames:s.facts.decodedFrames,groupDrift:s.program===null?null:Math.round((s.target-s.program)*1000),paused:s.paused,soundOn:!s.muted,errors},null,2)},100);measurementTimer=setInterval(()=>postMeasurement(),1000);setTimeout(()=>window.done(),duration*1000)};
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
const report = { scope: 'Exact HLS/CMAF envelopes emitted by hls-capture.js; all input prefetched and only the group window staged into the bounded player cache; no repackaging', physicalDevice: false, networkRoute: false, runtimeSHA256: createHash('sha256').update(playerBuild.outputFiles[0].text).digest('hex'), workerSHA256: createHash('sha256').update(workerBuild.outputFiles[0].text).digest('hex'), source: { fixtureDirectory: captureDir.pathname, sourceDuration, width: video.width, height: video.height, codec: video.codec_name, profile: video.profile, level: video.level, audio: audio.codec_name, sourceFrames: sourceEvidence.capture.frames, videoPackets: sourceEvidence.capture.stats.videoPackets, audioRms: sourceEvidence.decoded.audioRms, batchCount: pieces.length, transportSHA256: pieces.map(p => p.sha256) }, scenarios: [] };
await writeFile(new URL('fixture-proof.json', out), JSON.stringify(report, null, 2));
function processRows() { return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), parent: Number(m[2]), command: m[3] })); }
const isCachedWebKitGPU = r => r.command.includes('/Library/Caches/ms-playwright/webkit-') && r.command.includes('/com.apple.WebKit.GPU.xpc/');
function maxPixelHold(samples) {
  const pixels = samples.filter(s => s.pixels !== null); if (pixels.length < 2) return null;
  let previous = pixels[0], changedAt = previous.at, maximum = 0;
  for (const sample of pixels.slice(1)) { if (sample.pixels !== previous.pixels) { maximum = Math.max(maximum, sample.at - changedAt); changedAt = sample.at; } previous = sample; }
  return Math.max(maximum, pixels.at(-1).at - changedAt);
}
async function captureOwnedAudio(label, preflight) {
  const rows = processRows(), byId = new Map(rows.map(r => [r.pid, r]));
  const lineage = pid => { const result = []; for (let current = byId.get(pid); current; current = byId.get(current.parent)) { result.push(current); if (current.pid === process.pid) return result; if (result.length > 30) break; } return null; };
  const browsers = rows.filter(r => r.command.endsWith('/Playwright.app/Contents/MacOS/Playwright')).map(r => ({ process: r, lineage: lineage(r.pid) })).filter(r => r.lineage);
  assert.equal(browsers.length, 1, 'Audio tap requires one owned Playwright browser descended from this test process');
  // XPC graphics processes are reparented to launchd on macOS. Associate only
  // the sole freshly created GPU in this owned browser's exact cache directory.
  // Other Safari/simulator GPUs and any ambiguous pre-existing browser refuse.
  assert.equal(preflight.gpu.length, 0, 'Another cached Playwright GPU existed before this isolated launch');
  const browserBase = browsers[0].process.command.split('/Playwright.app/')[0], owned = rows.filter(r => isCachedWebKitGPU(r) && r.command.startsWith(browserBase + '/com.apple.WebKit.GPU.xpc/'));
  assert.equal(owned.length, 1, 'Audio tap requires one new GPU in the owned browser cache');
  const started = execFileSync('ps', ['-p', String(owned[0].pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); assert(Date.parse(started) >= preflight.at - 2000, 'GPU predates the owned browser launch');
  const scope = { nodePid: process.pid, targetPid: owned[0].pid, browserLineage: browsers[0].lineage, gpu: { ...owned[0], started }, preflight, scopeEvidence: 'No cached Playwright GPU before launch; sole new GPU uses exact owned browser cache and matching start time; XPC GPU is reparented to launchd', durationSeconds: 14, systemDefaultDeviceChanged: false, microphone: false };
  await writeFile(new URL(label + '-audio-scope.json', out), JSON.stringify(scope, null, 2));
  const path = new URL(label + '-output.wav', out).pathname, helper = process.env.SAMEEND_AUDIO_TAP || '/Users/errolelliott/IdeaProjects/same-end/privatework/rannie-cutouts-20261024/audio-capture/process-tap-capture';
  const child = spawn(helper, [String(scope.targetPid), '14', path], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('Owned-process sound capture failed: ' + code + ' ' + output))); });
  await writeFile(new URL(label + '-audio-capture.log', out), output);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.3', '-t', '13.2', '-i', path, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 2 * 1024 * 1024 }), samples = Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4));
  const energy = samples.reduce((n, x) => n + x * x, 0) / samples.length, rms = Math.sqrt(energy); let tonePowerFraction = 0, peakFrequency = null;
  for (let step = 0; step <= 40; step++) { const frequency = 439 + step * .05; let sine = 0, cosine = 0; for (let i = 0; i < samples.length; i++) { const phase = 2 * Math.PI * frequency * i / 8000; sine += samples[i] * Math.sin(phase); cosine += samples[i] * Math.cos(phase); } const power = 2 * (sine * sine + cosine * cosine) / (samples.length * samples.length) / energy; if (power > tonePowerFraction) { tonePowerFraction = power; peakFrequency = frequency; } }
  let silentWindows80ms = 0; for (let start = 0; start + 640 <= samples.length; start += 640) { let sum = 0; for (let i = start; i < start + 640; i++) sum += samples[i] * samples[i]; if (Math.sqrt(sum / 640) < .005) silentWindows80ms++; }
  const evidence = { ...scope, outputFile: path, measuredSeconds: samples.length / 8000, trimStartSeconds: .3, rms, peakFrequency, tonePowerFraction, silentWindows80ms };
  await writeFile(new URL(label + '-audio-analysis.json', out), JSON.stringify(evidence, null, 2)); return evidence;
}
if (process.env.SERVE_ONLY === '1') {
  console.log(JSON.stringify({ ready: true, nodePid: process.pid, origin, native: origin + '/?mode=native&target=0&duration=30&device=apple', hls: origin + '/?mode=hls&target=0&duration=30&device=android', measurements: new URL('device-measurements.json', out).pathname }));
  await new Promise(resolve => { for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(resolve)); }); await saving;
} else {
  const pw = await import(process.env.SAMEEND_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const duration = Number(process.env.DURATION || 20); assert(duration >= 15 && duration <= 185); assert(duration + 4 < sourceDuration, 'Producer fixture does not cover the requested actual programme interval');
  const scenarios = [['chromium', 'hls'], ['webkit', 'hls'], ['webkit', 'native']].filter(([engine, mode]) => !process.env.SCENARIOS || process.env.SCENARIOS.split(',').includes(engine + '-' + mode)); assert(scenarios.length, 'No requested scenarios');
  try {
    for (const [engine, mode] of scenarios) {
      const audioPreflight = process.env.CAPTURE_AUDIO === '1' && engine === 'webkit' ? { at: Date.now(), gpu: processRows().filter(isCachedWebKitGPU) } : null;
      const browser = await pw[engine].launch(engine === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true });
      try { const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(origin + '/?mode=' + mode + '&target=4&duration=' + duration + '&device=' + engine + '-' + mode + (engine === 'chromium' ? '&analyser=1' : ''));
        await page.waitForFunction(() => ready, null, { timeout: 25000 }); const prefetchedAt = requests.length; await page.locator('#start').click();
        console.log(JSON.stringify({ scenarioStarted: engine + '-' + mode, nodePid: process.pid }));
        let audioCapture, lateAudioCapture;
        if (process.env.CAPTURE_AUDIO === '1' && engine === 'webkit') {
          assert(duration >= 20, 'Audio capture needs at least 20 seconds of playback'); await page.waitForTimeout(3000); audioCapture = captureOwnedAudio(engine + '-' + mode, audioPreflight).then(value => value, error => ({ error: error.stack }));
          if (duration >= 120) lateAudioCapture = page.waitForTimeout((duration - 23) * 1000).then(() => captureOwnedAudio(engine + '-' + mode + '-late', audioPreflight)).then(value => value, error => ({ error: error.stack }));
        }
        await page.waitForFunction(() => finished, null, { timeout: (duration + 8) * 1000 });
        const raw = await page.evaluate(() => done()), stable = raw.samples.filter(s => s.at >= 3000 && s.at <= duration * 1000 - 300), frames = raw.frames.filter(f => f.at >= 3000);
        const summary = { engine, mode, duration, exactProducerBytes: true, webAudioConnected: raw.webAudioConnected, warmupHeld: raw.warmupHeld, verified: raw.verified, sourceChanges: raw.facts.srcChanges, errorCount: raw.errors.length, pageErrors: errors, waitingSamples: stable.filter(s => s.waiting).length, pausedSamples: stable.filter(s => s.paused).length, maxAbsDrift: Math.max(0, ...stable.filter(s => s.program !== null).map(s => Math.abs(s.target - s.program))), frameSamples: frames.length, maxFrameGapMs: frames.length ? Math.max(...frames.map(f => f.gap)) : null, maxSampledPixelHoldMs: maxPixelHold(stable), cadenceEvidence: frames.length ? 'Presented-frame callback intervals plus decoded counts and sampled pixels' : 'Native frame callbacks unavailable; decoded counts plus changing sampled pixels', distinctFramePixels: new Set(stable.map(s => s.pixels).filter(x => x !== null)).size, decodedIncrease: stable.length ? stable.at(-1).facts.decodedFrames - stable[0].facts.decodedFrames : 0, audibleSamples: stable.filter(s => s.rms > .005 && !s.muted && !s.paused).length, width: raw.facts.width, height: raw.facts.height, cacheBytes: raw.facts.cacheBytes, maxCacheBytes: Math.max(...stable.map(s => s.facts.cacheBytes)), syncSeeks: raw.facts.syncSeekRequests, backendMediaRequests: requests.slice(prefetchedAt).filter(x => x.path.startsWith('/_sameend/hls/') || /\.(m3u8|m4s|mp4)$/.test(x.path)) };
        if (audioCapture) summary.outputAudio = await audioCapture;
        if (lateAudioCapture) summary.lateOutputAudio = await lateAudioCapture;
        report.scenarios.push(summary); await writeFile(new URL(engine + '-' + mode + '.json', out), JSON.stringify({ summary, ...raw }, null, 2)); console.log(JSON.stringify(summary));
        assert.equal(raw.verified, pieces.length); assert.equal(raw.warmupHeld, true); assert.equal(raw.facts.srcChanges, 1); assert.equal(errors.length, 0); assert.deepEqual(raw.errors, []); assert.equal(summary.width, 1280); assert.equal(summary.height, 720); assert(summary.maxCacheBytes <= 32 * 1024 * 1024); assert.equal(summary.backendMediaRequests.length, 0); assert.equal(summary.waitingSamples, 0); assert.equal(summary.pausedSamples, 0); assert(summary.maxAbsDrift < .85, 'Actual producer shared timeline drift'); assert(summary.distinctFramePixels > (duration - 4) * 6, 'Actual producer moving picture'); assert(summary.decodedIncrease > (duration - 4) * 20, 'Actual producer decode cadence'); assert(summary.maxSampledPixelHoldMs < 600, 'Actual producer sampled picture held still'); if (frames.length) assert(summary.maxFrameGapMs < 600, 'Actual producer frame cadence stalled'); assert(raw.facts.syncSeekRequests <= 3, 'Repeated synchronization seeks');
        if (engine === 'chromium') assert(summary.audibleSamples > stable.length * .85, 'Actual producer AAC decoded tone'); else assert.equal(raw.webAudioConnected, false, 'Apple output graph must remain unmodified');
        for (const evidence of [summary.outputAudio, summary.lateOutputAudio].filter(Boolean)) { assert(!evidence.error, evidence.error); assert(evidence.rms > .02, 'Owned Apple output was silent'); assert(evidence.tonePowerFraction > .8, 'Owned Apple output did not contain the generated AAC tone'); assert.equal(evidence.silentWindows80ms, 0, 'Owned Apple sound had an 80ms cutout'); }
        await page.evaluate(() => player.close());
      } finally { await browser.close(); }
    }
    report.result = 'pass'; report.appleAudioEvidence = report.scenarios.some(s => s.engine === 'webkit' && s.outputAudio?.rms > .02 && s.outputAudio.tonePowerFraction > .8 && !s.outputAudio.silentWindows80ms) ? 'Actual AAC tone measured at the owned WebKit GPU output, with no WebAudio graph or 80ms silence windows.' : 'Unmodified output route; encoded source AAC is independently audible. Native speaker output requires separate owned-process capture.';
  } catch (error) { report.result = 'fail'; report.error = error.stack; throw error; }
  finally { await saving; await new Promise(r => server.close(r)); await writeFile(new URL('report.json', out), JSON.stringify(report, null, 2)); }
}
