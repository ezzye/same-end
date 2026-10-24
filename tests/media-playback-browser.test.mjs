/* Local generated media only. Browser engines on one Mac; no physical iOS/Big Sur/network acceptance. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = await import(process.env.SAMEEND_PLAYWRIGHT || (process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')); }
const root = new URL('../', import.meta.url), out = new URL(process.env.SAMEEND_MEDIA_OUT || 'privatework/media-playback/', root);
await mkdir(out, { recursive: true });
const code = await readFile(new URL('media-player.js', root), 'utf8');
const mime = process.env.SAMEEND_MEDIA_MIME || 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
let manifest = [];
const html = `<!doctype html><meta charset="utf-8"><title>Generated media compatibility acceptance</title><style>body{font:18px system-ui;background:#152817;color:white}video{width:640px;max-width:95vw}button{font:inherit;padding:12px}</style><video id="video" muted controls playsinline></video><p><button id="sound">Turn sound on</button><button id="play">Play</button></p><canvas id="sample" width="32" height="18" hidden></canvas><script src="/media-player.js"></script><script>
window.errors=[];window.modes=[];window.frameCallbacks=0;window.liveURLs=new Set();
const makeURL=URL.createObjectURL.bind(URL),revokeURL=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=(o)=>{const s=makeURL(o);liveURLs.add(s);return s};URL.revokeObjectURL=(s)=>{liveURLs.delete(s);revokeURL(s)};
window.sampleFrame=()=>{try{const c=document.querySelector('#sample'),x=c.getContext('2d',{willReadFrequently:true});x.drawImage(video,0,0,32,18);const d=x.getImageData(0,0,32,18).data;let sum=0,lit=0;for(let i=0;i<d.length;i+=4){sum=(sum+d[i]*3+d[i+1]*5+d[i+2]*7)%1000000007;if(d[i]+d[i+1]+d[i+2]>60)lit++}return{sum,lit}}catch{return null}};
if(video.requestVideoFrameCallback){const cb=()=>{frameCallbacks++;video.requestVideoFrameCallback(cb)};video.requestVideoFrameCallback(cb)}
window.sampleAudio=()=>{if(!window.analyser)return null;const wave=new Float32Array(analyser.fftSize),spectrum=new Float32Array(analyser.frequencyBinCount);analyser.getFloatTimeDomainData(wave);analyser.getFloatFrequencyData(spectrum);let sum=0,index=0,peak=-Infinity;for(const v of wave)sum+=v*v;for(let i=1;i<spectrum.length;i++){const hz=i*audioContext.sampleRate/analyser.fftSize;if(hz>100&&hz<1000&&spectrum[i]>peak){peak=spectrum[i];index=i}}return{rms:Math.sqrt(sum/wave.length),peakHz:index*audioContext.sampleRate/analyser.fftSize,state:audioContext.state}};
sound.onclick=()=>{video.muted=!video.muted;sound.textContent=video.muted?'Turn sound on':'Mute';if(!video.muted){if(!window.audioContext){window.audioContext=new AudioContext();window.analyser=audioContext.createAnalyser();analyser.fftSize=4096;window.audioSource=audioContext.createMediaElementSource(video);audioSource.connect(analyser);analyser.connect(audioContext.destination)}audioContext.resume().catch(e=>errors.push(e.message))}player.play().catch(e=>errors.push(e.message))};
play.onclick=()=>player.play().catch(e=>errors.push(e.message));
window.setup=async(manifest,mime)=>{window.manifest=manifest;window.buffers=await Promise.all(manifest.map(async p=>(await fetch('/pieces/'+p.file)).arrayBuffer()));window.epoch=1700000000000;window.player=new SameEndMedia.Player(video,mime,{onError:s=>errors.push(s),onMode:(mode,message)=>modes.push({mode,message})});window.enqueue=(i,start=manifest[i].start,seq=i)=>player.enqueue({meta:{seq,start:epoch+start*1000,duration:manifest[i].duration*1000},buf:buffers[i]},epoch);window.snapshot=()=>({mode:player.mode,current:player.current,time:video.currentTime,paused:video.paused,muted:video.muted,controls:video.controls,playsInline:video.hasAttribute('playsinline'),disableRemotePlayback:video.disableRemotePlayback,readyState:video.readyState,error:video.error?.message||null,frames:video.getVideoPlaybackQuality?.().totalVideoFrames??video.webkitDecodedFrameCount??null,frameCallbacks,frame:sampleFrame(),errors:[...errors],buffered:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)]),liveURLs:liveURLs.size,queue:player.queue.length});};
</script>`;
const server = http.createServer(async(req,res)=>{
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/media-player.js') return res.writeHead(200, {'content-type':'text/javascript'}).end(code);
    if (path.startsWith('/pieces/') && /^\/pieces\/piece-\d+\.mp4$/.test(path)) return res.writeHead(200, {'content-type':'video/mp4'}).end(await readFile(new URL(path.split('/').at(-1), out)));
    res.writeHead(200, {'content-type':'text/html'}).end(html);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {schema:1,date:new Date().toISOString(),sourceSHA256:createHash('sha256').update(code).digest('hex'),scope:'Independent MP4 recordings decoded through SameEndMedia.Player in local browser engines on one Mac',physicalDevicesTested:false,separateNetworksTested:false,autoplayPolicyOverride:false,limitations:['Playwright WebKit is the installed current desktop engine, not physical iOS or Big Sur Safari.','ManagedMediaSource alias is a constructor-selection simulation, not native ManagedMediaSource acceptance.','Audio analyser observes decoded tone; speaker output is not independently heard.'],fixtures:[],engines:[],result:'incomplete'};
const browsers = [];
async function recordFixtures() {
  if (process.env.SAMEEND_MEDIA_REUSE === '1') {
    try { manifest = JSON.parse(await readFile(new URL('fixtures.json',out),'utf8')); assert.equal(manifest.length,14);assert(manifest.every(p=>p.recordedMime.toLowerCase()===mime.toLowerCase()));await Promise.all(manifest.map(async p=>assert.equal(createHash('sha256').update(await readFile(new URL(p.file,out))).digest('hex'),p.sha256)));return; } catch {manifest=[];}
  }
  const captured=[];
  // Isolate the recording process as well as the recorder. Hardware encoders
  // can otherwise still be tearing down when the next short recording starts.
  for(let seed=0;seed<14;seed++) {
  const browser = await pw.chromium.launch({executablePath:process.env.SAMEEND_CAPTURE_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}); browsers.push(browser);
  report.captureBrowser={name:'Google Chrome (Chromium)',version:browser.version(),autoplayPolicyOverride:false};
  const page = await browser.newPage(); await page.goto(origin);
  await page.evaluate(({mime,seed})=>{window.captureFixtures=async()=>{
    if (!MediaRecorder.isTypeSupported(mime)) throw Error('Chromium cannot record required H264/AAC fixture');
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;canvas.style.cssText='position:fixed;left:0;top:0';document.body.replaceChildren(canvas);const ctx=canvas.getContext('2d');
    let count=0,piece=seed,captureTrack;const draw=()=>{ctx.fillStyle=`hsl(${piece*29},80%,45%)`;ctx.fillRect(0,0,320,180);ctx.fillStyle='white';ctx.fillRect((count++*7)%300,70,20,40);ctx.font='24px sans-serif';ctx.fillText('Generated clip '+piece,20,45);captureTrack?.requestFrame()};draw();const timer=setInterval(draw,33);
    const audio=new AudioContext();await audio.resume();const osc=audio.createOscillator(),gain=audio.createGain();osc.frequency.value=220;gain.gain.value=.03;osc.connect(gain);osc.start();
    const result=[],recordings=[],dest=audio.createMediaStreamDestination();gain.connect(dest);captureTrack=canvas.captureStream(30).getVideoTracks()[0];const stream=new MediaStream([captureTrack,...dest.stream.getAudioTracks()]);
    await new Promise((resolve,reject)=>{draw();const chunks=[],rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:250000,audioBitsPerSecond:48000});rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};rec.onerror=e=>reject(Error(e.error?.message||'Generated recording failed'));rec.onstop=()=>{recordings.push({blob:new Blob(chunks,{type:mime}),mime:rec.mimeType});resolve()};rec.start();setTimeout(()=>rec.stop(),1050)});
    for(const recording of recordings){const b=new Uint8Array(await recording.blob.arrayBuffer());let s='';for(const v of b)s+=String.fromCharCode(v);result.push({base64:btoa(s),mime:recording.mime,audioState:audio.state})}
    clearInterval(timer);stream.getTracks().forEach(t=>t.stop());gain.disconnect(dest);osc.stop();await audio.close();return result;
  };const button=document.createElement('button');button.id='record';button.textContent='Record generated fixtures';button.onclick=()=>window.recording=window.captureFixtures();document.body.append(button);},{mime,seed});
  await page.locator('#record').click();
  captured.push(...await page.evaluate(()=>recording));await page.close();await browser.close();browsers.pop();
  }
  await writeFile(new URL('recording-sizes.json',out),JSON.stringify(captured.map(p=>({mime:p.mime,bytes:Buffer.from(p.base64,'base64').length})),null,2));
  for(let i=0;i<captured.length;i++)await writeFile(new URL(`piece-${i}.mp4`,out),Buffer.from(captured[i].base64,'base64'));
  let start=0;
  for (let i=0;i<captured.length;i++) {
    const file=`piece-${i}.mp4`,buf=Buffer.from(captured[i].base64,'base64'); await writeFile(new URL(file,out),buf);
    const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',new URL(file,out).pathname],{encoding:'utf8'}));
    assert(probe.streams.some(s=>s.codec_name==='h264'),file+' missing H264');assert(probe.streams.some(s=>s.codec_name==='aac'),file+' missing AAC');
    const duration=Number(probe.format.duration);assert(duration>.4&&duration<1.5);
    manifest.push({file,start,duration,bytes:buf.length,sha256:createHash('sha256').update(buf).digest('hex'),recordedMime:captured[i].mime,codecs:probe.streams.map(s=>s.codec_name)});start+=duration;
  }
  await writeFile(new URL('fixtures.json',out),JSON.stringify(manifest,null,2));
}
async function runScenario(browser,engine,variant) {
  const context=await browser.newContext({viewport:{width:850,height:650}}),page=await context.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  const result={engine,browserVersion:browser.version(),variant,result:'incomplete'};report.engines.push(result);
  try {
    if(variant==='clips-no-recorder') await page.addInitScript(()=>{Object.defineProperty(window,'MediaSource',{value:undefined,configurable:true});Object.defineProperty(window,'ManagedMediaSource',{value:undefined,configurable:true});Object.defineProperty(window,'MediaRecorder',{value:undefined,configurable:true});});
    if(variant==='managed-alias-simulation') await page.addInitScript(()=>{const Native=window.MediaSource;window.managedCalls=0;if(Native){class Alias extends Native {constructor(){super();window.managedCalls++}}Object.defineProperty(window,'ManagedMediaSource',{value:Alias,configurable:true});Object.defineProperty(window,'MediaSource',{value:undefined,configurable:true});}});
    await page.goto(origin);result.capabilities=await page.evaluate(mime=>({mediaSource:!!window.MediaSource,managedMediaSource:!!window.ManagedMediaSource,mseSupported:!!(window.MediaSource?.isTypeSupported(mime)||window.ManagedMediaSource?.isTypeSupported(mime)),mediaRecorder:!!window.MediaRecorder,canPlay:SameEndMedia.canPlay(mime),nativeVideo:video.canPlayType(mime),recordingMime:SameEndMedia.recordingMime(true)}),mime);
    assert.equal(await page.evaluate(()=>SameEndMedia.canPlay('video/not-a-codec')),false);
    assert.match(await page.evaluate(()=>{try{new SameEndMedia.Player(video,'video/not-a-codec');return ''}catch(e){return e.message}}),/Ask the host.*fresh room/);
    if(!result.capabilities.canPlay) {result.result='unsupported-codec-action-passed';return;}
    await page.evaluate(({manifest,mime})=>setup(manifest,mime),{manifest,mime});
    await page.evaluate(()=>{for(let i=0;i<12;i++)enqueue(i);});
    await page.waitForFunction(()=>{player.sync(.18);return video.readyState>=2;},null,{timeout:15000});
    await page.locator('#play').click();
    await page.waitForFunction(()=>!video.paused);
    if(variant==='clips-no-recorder'){assert.equal(await page.evaluate(()=>player.mode),'clips');assert.equal(result.capabilities.recordingMime,null);}
    if(variant==='managed-alias-simulation') assert.equal(await page.evaluate(()=>managedCalls),1);
    const initial=await page.evaluate(()=>snapshot());assert(initial.controls&&initial.playsInline&&initial.disableRemotePlayback);assert.equal(initial.muted,true);
    await page.locator('#sound').click();assert.equal(await page.evaluate(()=>video.muted),false);
    try {
      await page.waitForFunction(()=>{const a=sampleAudio();return a?.rms>.0005&&a.peakHz>190&&a.peakHz<250;},null,{timeout:5000});
      result.decodedTone={result:'observed',...await page.evaluate(()=>sampleAudio())};
    } catch(error) {
      // WebKit's streaming-media/WebAudio path can return zero samples even
      // while video advances. Keep this an explicit gap in audio evidence.
      if(engine!=='webkit'||await page.evaluate(()=>player.mode)!=='mse')throw error;
      result.decodedTone={result:'unverified',...await page.evaluate(()=>sampleAudio()),reason:'WebKit MSE analyser produced zero samples; audible output not independently observed',relatedIssue:'https://bugs.webkit.org/show_bug.cgi?id=306493',relatedIssueScope:'The issue covers HLS/fMP4, so it is an analogy rather than proof of the cause here.'};
    }
    result.initial=initial;
    const samples=await page.evaluate(async()=>{
      const samples=[],t0=performance.now();let previous='';const stop=manifest[9].start+.22;
      while((performance.now()-t0)/1000+.18<stop){const target=(performance.now()-t0)/1000+.18;const state=player.sync(target),snap=snapshot();const idx=manifest.findIndex(p=>target>=p.start&&target<p.start+p.duration);const key=String(idx);if(!state.waiting&&snap.frame?.lit>20&&key!==previous){samples.push({target,index:idx,localTime:snap.time,expectedLocal:player.mode==='mse'?target:target-manifest[idx].start,drift:state.drift,frame:snap.frame,mode:snap.mode});previous=key}await new Promise(r=>setTimeout(r,45))}return samples;
    });
    result.samples=samples;assert(samples.length>=7,`Only ${samples.length} independently recorded pieces observed`);assert(new Set(samples.map(s=>s.frame.sum)).size>=6,'Rendered frames do not vary across recordings');assert(samples.every(s=>Math.abs(s.localTime-s.expectedLocal)<.5),'Clock alignment outside 500ms across pieces');
    await page.waitForFunction(()=>{const state=player.sync(manifest[9].start+.3);return!state.waiting&&!video.paused;},null,{timeout:15000});
    result.afterUnmutedPieces=await page.evaluate(()=>({muted:video.muted,paused:video.paused}));assert.equal(result.afterUnmutedPieces.muted,false);assert.equal(result.afterUnmutedPieces.paused,false);
    await page.locator('#sound').click();assert.equal(await page.evaluate(()=>video.muted),true);
    assert.equal(await page.evaluate(()=>{const s=player.sync(-1);return s.waiting&&video.paused}),true);
    result.gap=await page.evaluate(()=>{const target=manifest[11].start+manifest[11].duration+1;return{target,...player.sync(target),time:video.currentTime}});assert.equal(result.gap.waiting,true);
    const future=manifest[11].start+manifest[11].duration+3;
    await page.evaluate(({future})=>{enqueue(12,future,100);enqueue(13,future+manifest[12].duration,101);},{future});
    await page.waitForFunction(({future})=>{const state=player.sync(future+.2),expected=player.mode==='mse'?future+.2:.2;return!state.waiting&&!video.paused&&!video.seeking&&Math.abs(video.currentTime-expected)<.5&&sampleFrame()?.lit>20;},{future},{timeout:15000});
    result.recovery=await page.evaluate(({future})=>({target:future+.2,...snapshot(),expectedLocal:player.mode==='mse'?future+.2:.2}),{future});
    assert(Math.abs(result.recovery.time-result.recovery.expectedLocal)<.5,'Recovery did not seek to current delayed clock');
    await page.screenshot({path:new URL(`${engine}-${variant}.png`,out).pathname});
    result.beforeClose=await page.evaluate(()=>snapshot());
    if(await page.evaluate(()=>!!video.requestVideoFrameCallback))assert(result.beforeClose.frameCallbacks>20,'Received clips did not present enough distinct video frames');
    if(result.capabilities.mseSupported)assert.equal(result.beforeClose.mode,'mse');
    result.afterClose=await page.evaluate(async()=>{player.close();audioSource?.disconnect();analyser?.disconnect();await audioContext?.close();return{...snapshot(),audioContextState:audioContext?.state,pieceCount:player.pieces.length,source:!!player.source,sb:!!player.sb,src:video.getAttribute('src')}});
    assert.equal(result.afterClose.liveURLs,0);assert.equal(result.afterClose.pieceCount,0);assert.equal(result.afterClose.queue,0);assert.equal(result.afterClose.src,null);assert.equal(result.afterClose.paused,true);assert.equal(result.afterClose.source,false);assert.equal(result.afterClose.sb,false);assert.equal(result.afterClose.audioContextState,'closed');assert.deepEqual(pageErrors,[]);assert.deepEqual(result.beforeClose.errors,[]);
    result.modes=await page.evaluate(()=>modes);result.result='passed';
  }catch(error){result.result='failed';result.error=error.stack;result.pageErrors=pageErrors;result.snapshot=await page.evaluate(()=>window.snapshot?.()).catch(()=>null);result.audioDiagnostic=await page.evaluate(()=>({sample:window.sampleAudio?.(),decodedAudioBytes:video.webkitAudioDecodedByteCount,audioTracks:video.audioTracks?.length,volume:video.volume,duration:video.duration})).catch(()=>null);throw error;}finally{await context.close();}
}
try {
  await recordFixtures(); report.fixtures=manifest;
  const names=(process.env.SAMEEND_MEDIA_ENGINES || 'chromium,webkit,firefox').split(',');
  for(const engine of names){let browser;try{browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'chromium'}:{})});browsers.push(browser);}catch(error){report.engines.push({engine,result:'unavailable',reason:error.message});continue;}
    for(const variant of ['native','clips-no-recorder',...(engine==='chromium'?['managed-alias-simulation']:[])]){try{await runScenario(browser,engine,variant);}catch(error){console.error(`FAIL ${engine}/${variant}: ${error.message}`);process.exitCode=1;}}
    await browser.close();browsers.pop();
  }
  if(names.includes('chromium'))assert(report.engines.some(r=>r.engine==='chromium'&&r.result==='passed'),'Required Chromium playback missing');
  report.result=report.engines.some(r=>r.result==='failed')?'failed':report.engines.some(r=>r.decodedTone?.result==='unverified')?'passed-with-audio-evidence-limitations':'passed';
}catch(error){report.result='failed';report.error=error.stack;process.exitCode=1;}finally{await Promise.all(browsers.map(b=>b.close().catch(()=>{})));await new Promise(resolve=>server.close(resolve));await writeFile(new URL('evidence.json',out),JSON.stringify(report,null,2));}
console.log(JSON.stringify({result:report.result,scenarios:report.engines.map(({engine,variant,result})=>({engine,variant,result})),evidence:new URL('evidence.json',out).pathname},null,2));
