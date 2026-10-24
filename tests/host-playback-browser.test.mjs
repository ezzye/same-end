/* Real-browser regression for repeated host MediaRecorder segments in the built PWA. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {mkdtemp, rm} from 'node:fs/promises';

const runtime = process.env.SAMEEND_PLAYWRIGHT || '/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium} = await import(runtime);
const distPath = fileURLToPath(new URL('../dist/', import.meta.url));
const outPath = fileURLToPath(new URL('../privatework/host-playback/', import.meta.url));
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const label = process.env.HOST_PLAYBACK_LABEL || 'pwa-acceptance';
const reportURL = join(outPath, `${label}.json`);
await mkdir(outPath, {recursive: true});
const pwaHTML = await readFile(join(distPath, 'watch.html'));
const pieces = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/piece' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const seq = Number(url.searchParams.get('seq'));
      const path = join(outPath, `${label}-piece-${seq}.mp4`);
      await writeFile(path, Buffer.concat(chunks));
      pieces.push(path);
      return res.writeHead(204).end();
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/watch.html' : url.pathname);
    const path = resolve(distPath, `.${relative}`);
    if (!path.startsWith(distPath)) return res.writeHead(403).end();
    const body = relative === '/watch.html' ? pwaHTML : await readFile(path);
    const ext = path.split('.').at(-1);
    const types = {html:'text/html', js:'text/javascript', json:'application/json', webmanifest:'application/manifest+json', png:'image/png', svg:'image/svg+xml', css:'text/css'};
    res.writeHead(200, {'content-type': types[ext] || 'application/octet-stream'}).end(body);
  } catch (error) { res.writeHead(404).end(error.message); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'same-end-pwa-host-'));
const browser = await chromium.launchPersistentContext(profile, {executablePath: chromePath, headless: true, viewport: {width:1440,height:1000}, serviceWorkers:'block'});
const page = browser.pages()[0] || await browser.newPage();
const pageErrors = [], consoleErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const report = {
  schema: 2, createdAt: new Date().toISOString(), buildSHA256: createHash('sha256').update(pwaHTML).digest('hex'),
  scope: 'Built PWA host demo, production recorder/player and actual room/video fullscreen controls; synthetic moving canvas and oscillator audio.',
  trigger: 'Trusted click on built demo control intercepted only to call its existing test hook with a 10-second delay; real engine recording path follows.',
  environment: {chrome:execFileSync(chromePath,['--version'],{encoding:'utf8'}).trim(), autoplayPolicyOverride:false, isolatedProfile:true, physicalDevice:false, separateNetwork:false}
};
let stage = 'startup';
try {
  await page.addInitScript(() => {
    const ev = window.__hostEvidence = {capture:null, records:[], errors:[], audio:null, posts:[], streamIds:new WeakMap(), nextStreamId:1};
    const capture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function(fps) {
      if (this.width === 960 && this.height === 540) {
        this.width = 1280; this.height = 720;
        this.getContext('2d').scale(1280/960, 720/540);
        ev.capture = {width:this.width,height:this.height,fps};
      }
      return capture.call(this,fps);
    };
    const start = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function(...args) {
      const seq = ev.records.length, stream = this.stream;
      if (!ev.streamIds.has(stream)) ev.streamIds.set(stream, ev.nextStreamId++);
      const item = {seq, streamId:ev.streamIds.get(stream), mime:this.mimeType, videoBitsPerSecond:this.videoBitsPerSecond, audioBitsPerSecond:this.audioBitsPerSecond,
        tracks:stream?.getTracks().map(t => {const s=t.getSettings();return {kind:t.kind,width:s.width,height:s.height,frameRate:s.frameRate,channelCount:s.channelCount,sampleRate:s.sampleRate}})};
      ev.records.push(item);
      this.addEventListener('dataavailable', e => {
        if (!e.data.size) return;
        item.bytes=e.data.size; item.type=e.data.type;
        ev.posts.push(fetch('/piece?seq='+seq,{method:'POST',body:e.data}).then(r=>{if(!r.ok)throw Error('segment save failed '+r.status)}));
      });
      return start.apply(this,args);
    };
    document.addEventListener('DOMContentLoaded', () => {
      const video=document.querySelector('#player');
      video?.addEventListener('error',()=>ev.errors.push({at:new Date().toISOString(),code:video.error?.code,message:video.error?.message||'',networkState:video.networkState,readyState:video.readyState}));
      document.querySelector('#sound')?.addEventListener('click',()=>{
        if(ev.audio)return;
        const context=new AudioContext(),analyser=context.createAnalyser(); analyser.fftSize=4096;
        const source=context.createMediaElementSource(video);source.connect(analyser);analyser.connect(context.destination);
        context.resume().catch(e=>ev.errors.push({audioResume:e.message})); ev.audio={context,analyser};
      },true);
      document.querySelector('#demo')?.addEventListener('click',e=>{
        e.preventDefault();e.stopImmediatePropagation();
        PrivateCast.testing.startDemo({delay:10}).catch(error=>ev.errors.push({start:error.message}));
      },true);
    });
  });
  await page.goto(origin+'/watch.html');
  await page.waitForFunction(()=>window.PrivateCast?.testing,{timeout:12000});
  report.codecSupport=await page.evaluate(()=>{
    const types=['video/mp4;codecs=avc1.42001f,mp4a.40.2','video/mp4;codecs=avc3.42001f,mp4a.40.2'],v=document.createElement('video');
    return Object.fromEntries(types.map(m=>[m,{record:MediaRecorder.isTypeSupported(m),mse:!!(MediaSource?.isTypeSupported(m)||window.ManagedMediaSource?.isTypeSupported(m)),nativePlay:!!v.canPlayType(m)}]));
  });
  await page.locator('details#settings > summary').click();
  await page.locator('details#developer-tools > summary').click();
  await page.locator('#demo').click();
  await page.waitForFunction(()=>PrivateCast.snapshot().active,{timeout:12000});
  await page.waitForFunction(()=>__hostEvidence.records.length>=1,{timeout:12000});
  await page.locator('#sound').click();

  const snapshot=()=>page.evaluate(()=>{
    const s=PrivateCast.snapshot(),v=document.querySelector('#player'),a=__hostEvidence.audio;
    let audio=null;
    if(a){const f32=new Float32Array(a.analyser.fftSize),freq=new Float32Array(a.analyser.frequencyBinCount);a.analyser.getFloatTimeDomainData(f32);a.analyser.getFloatFrequencyData(freq);let sum=0,peak=-Infinity,index=0;for(const x of f32)sum+=x*x;for(let i=1;i<freq.length;i++){const hz=i*a.context.sampleRate/a.analyser.fftSize;if(hz>100&&hz<1000&&freq[i]>peak){peak=freq[i];index=i}}audio={rms:Math.sqrt(sum/f32.length),peakHz:index*a.context.sampleRate/a.analyser.fftSize,state:a.context.state}}
    return {at:new Date().toISOString(),targetProgramTime:s.targetProgramTime,programTime:s.programTime,playTime:s.playTime,drift:s.drift,mode:s.playbackMode,ready:s.ready,paused:v.paused,decodedFrames:v.getVideoPlaybackQuality?.().totalVideoFrames??v.webkitDecodedFrameCount??null,videoWidth:v.videoWidth,videoHeight:v.videoHeight,error:v.error?{code:v.error.code,message:v.error.message}:null,audio,fullscreenElement:document.fullscreenElement?.id||null};
  });
  const collect=async(seconds)=>{const samples=[];for(let i=0;i<seconds;i++){await page.waitForTimeout(1000);samples.push(await snapshot())}return samples};
  const quality=samples=>{
    const first=samples[0],last=samples.at(-1),played=samples.filter(s=>s.targetProgramTime>=0&&s.drift!==null);
    return {samples,elapsedSeconds:samples.length,first,last,framesAdvanced:(last.decodedFrames??0)>(first.decodedFrames??0),audioThroughout:samples.every(s=>s.audio&&s.audio.rms>.005&&s.audio.peakHz>180&&s.audio.peakHz<270),modeStayedMSE:samples.every(s=>s.mode==='mse'&&!s.error),maxAbsoluteDriftSeconds:Math.max(...played.map(s=>Math.abs(s.drift??Infinity))),driftSamples:played.length};
  };
  stage='warmup';report.warmup=await collect(12);
  stage='normal';const normal=await collect(8);await page.screenshot({path:join(outPath,`${label}-normal.png`)});
  stage='full room';await page.locator('#room-fullscreen').click();await page.waitForFunction(()=>document.fullscreenElement?.id==='watch-room',{timeout:8000});
  assert.equal(await page.evaluate(()=>document.fullscreenElement===document.querySelector('#watch-room')),true,'Full room requires the real fullscreenElement.');
  const fullRoom=await collect(8);await page.screenshot({path:join(outPath,`${label}-full-room.png`)});
  await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement,{timeout:6000});
  stage='picture only';await page.locator('#fullscreen').click();await page.waitForFunction(()=>document.fullscreenElement?.id==='player',{timeout:8000});
  assert.equal(await page.evaluate(()=>document.fullscreenElement===document.querySelector('#player')),true,'Picture only requires the real video fullscreenElement.');
  const pictureOnly=await collect(8);await page.screenshot({path:join(outPath,`${label}-picture-only.png`)});
  await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement,{timeout:6000});

  stage='background visibility probe';
  const cdp=await browser.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  const second=await browser.newPage();await second.goto(origin+'/watch.html');await second.bringToFront();
  let hiddenObserved=false;
  try { await page.waitForFunction(()=>document.visibilityState==='hidden',{timeout:1800});hiddenObserved=true; } catch {}
  if(hiddenObserved){report.background={status:'observed-hidden',hidden:await snapshot()};await page.waitForTimeout(2500);report.background.hiddenSample=await snapshot();await page.bringToFront();await page.waitForFunction(()=>document.visibilityState==='visible',{timeout:4000});report.background.returned=await collect(4);}
  else report.background={status:'unverified',reason:'Isolated headless Chrome did not expose a hidden document after a second page was foregrounded.'};
  await second.close();

  await Promise.all(await page.evaluate(()=>__hostEvidence.posts));
  const final=await page.evaluate(()=>({source:PrivateCast.snapshot(),capture:__hostEvidence.capture,records:__hostEvidence.records,errors:__hostEvidence.errors}));
  report.final=final;report.views={normal:quality(normal),fullRoom:{...quality(fullRoom),fullscreenElement:'watch-room'},pictureOnly:{...quality(pictureOnly),fullscreenElement:'player'}};
  report.selectedMimeSupport={mime:final.source.mime,...(report.codecSupport[final.source.mime]||{})};
  report.pieces=await Promise.all(pieces.map(async path=>{const b=await readFile(path);return {file:path.split('/').at(-1),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}}));
  report.browserErrors={pageErrors,consoleErrors};
  const views=Object.values(report.views),allSamples=[...normal,...fullRoom,...pictureOnly];
  // Generator settings can be absent before Chromium's first consumer pull.
  // Validate optional settings honestly, and check actual decoded dimensions.
  report.acceptance={decoded720p:allSamples.every(s=>s.videoWidth===1280&&s.videoHeight===720),pixelNormalizationActive:final.source.mediaDiagnostics?.capture?.pixelNormalization==='active'&&final.source.mediaDiagnostics.capture.normalizedFrames>200&&final.source.mediaDiagnostics.capture.normalizationTargetFrameRate===25,selectedAVC3:/codecs=avc3\./i.test(final.source.mime||''),selectedCodecSupported:report.selectedMimeSupport.record===true&&report.selectedMimeSupport.mse===true&&report.selectedMimeSupport.nativePlay===true,sameStream:final.records.length>=12&&new Set(final.records.map(r=>r.streamId)).size===1,segmentsAtLeast12:final.records.length>=12,recorderTarget:final.records.every(r=>r.videoBitsPerSecond===1500000&&r.tracks.some(t=>t.kind==='video'&&(t.width===undefined||t.width===1280)&&(t.height===undefined||t.height===720)&&(t.frameRate===undefined||t.frameRate>0&&t.frameRate<=30))&&r.tracks.some(t=>t.kind==='audio')),normalAdvances:report.views.normal.framesAdvanced,fullRoomAdvances:report.views.fullRoom.framesAdvanced,pictureOnlyAdvances:report.views.pictureOnly.framesAdvanced,audioToneEveryView:views.every(v=>v.audioThroughout),modeStayedMSE:allSamples.every(s=>s.mode==='mse'&&!s.error)&&final.errors.length===0,maxAbsoluteDriftSeconds:Math.max(...views.map(v=>v.maxAbsoluteDriftSeconds))};
  report.result='captured';
  stage='acceptance checks';
  await writeFile(reportURL,JSON.stringify(report,null,2));
  assert(report.acceptance.selectedAVC3,'Production host must select AVC3 for this resize-capable stream.');
  assert(report.acceptance.selectedCodecSupported,'Selected AVC3 must be supported by MediaRecorder, MSE, and native playback.');
  assert(report.acceptance.sameStream,'All repeated recorders must use the same MediaStream.');
  assert(report.acceptance.segmentsAtLeast12,'Expected at least twelve sequential segments.');
  assert(report.acceptance.recorderTarget,'Expected 720p H.264/AAC 1.5 Mbps, with reported track frame rate at most30.');
  assert(report.acceptance.decoded720p,'Actual decoded host picture must be1280x720 in every view.');
  assert(report.acceptance.pixelNormalizationActive,'Actual source frames must pass the colour converter with25fps target, not just be relabelled.');
  assert(views.every(v=>v.framesAdvanced&&v.audioThroughout&&v.modeStayedMSE),'Each actual view must advance frames, carry the generated tone, and remain in MSE.');
  assert(report.acceptance.maxAbsoluteDriftSeconds<.5,'Programme drift must remain below 500 ms.');
  report.result='passed';await writeFile(reportURL,JSON.stringify(report,null,2));
  console.log(JSON.stringify({result:report.result,chrome:report.environment.chrome,mode:final.source.playbackMode,mime:final.source.mime,segments:final.records.length,views:Object.fromEntries(Object.entries(report.views).map(([k,v])=>[k,{elapsedSeconds:v.elapsedSeconds,framesAdvanced:v.framesAdvanced,audioThroughout:v.audioThroughout,maxAbsoluteDriftSeconds:v.maxAbsoluteDriftSeconds}])),background:report.background.status,acceptance:report.acceptance,report:reportURL},null,2));
} catch(error) {
  report.failure={stage,message:error.message};
  try { await writeFile(reportURL,JSON.stringify(report,null,2)); } catch {}
  throw error;
} finally {
  await browser.close();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});
}
