/* Regression: repeated MP4 recording with source-size changes must stay in continuous MSE playback. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {chromium}=await import(process.env.SAMEEND_PLAYWRIGHT||process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const root=new URL('../',import.meta.url),out=new URL('../privatework/media-resize/',import.meta.url);
await mkdir(out,{recursive:true});
const player=await readFile(process.env.SAMEEND_MEDIA_SOURCE||new URL('media-player.js',root),'utf8');
const html=`<!doctype html><title>Isolated generated resize test</title><button id="start">Start generated media</button><video id="video" muted playsinline></video><script src="/player.js"></script><script>
window.events=[];window.samples=[];window.pieces=[];window.finished=false;
const video=document.querySelector('video');
video.addEventListener('error',()=>events.push({kind:'video-error',code:video.error?.code,message:video.error?.message}));
start.onclick=async()=>{
 const mime=window.testMime,canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
 const ctx=canvas.getContext('2d');let n=0;const draw=()=>{ctx.fillStyle='#073d2b';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='white';ctx.fillRect((n++*17)%(canvas.width-40),40,40,100)};draw();const drawTimer=setInterval(draw,40);
 const ac=new AudioContext();await ac.resume();const oscillator=ac.createOscillator(),gain=ac.createGain(),dest=ac.createMediaStreamDestination();gain.gain.value=.035;oscillator.frequency.value=440;oscillator.connect(gain).connect(dest);oscillator.start();
 const stream=new MediaStream([...canvas.captureStream(25).getVideoTracks(),...dest.stream.getAudioTracks()]);
 const analyser=ac.createAnalyser();ac.createMediaElementSource(video).connect(analyser);analyser.connect(ac.destination);
 const epoch=performance.now();window.player=new SameEndMedia.Player(video,mime,{onMode:(mode,message)=>events.push({kind:'mode',mode,message}),onError:message=>events.push({kind:'player-error',message})});video.muted=false;video.play().catch(()=>{});
 const sync=setInterval(()=>{const target=(performance.now()-epoch)/1000-6,result=player.sync(target),wave=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(wave);samples.push({at:(performance.now()-epoch)/1000,target,time:player.programTime(),mode:player.mode,waiting:result.waiting,ready:video.readyState,paused:video.paused,frames:video.getVideoPlaybackQuality?.().totalVideoFrames,width:video.videoWidth,height:video.videoHeight,rms:Math.sqrt(wave.reduce((sum,x)=>sum+x*x,0)/wave.length)})},100);
 let seq=0;function record(){const id=seq++,started=performance.now(),parts=[];let ended=started;const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:1500000,audioBitsPerSecond:96000});
 recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)};recorder.onstop=async()=>{if(seq<6)record();const buf=await new Blob(parts,{type:mime}).arrayBuffer();pieces.push({id,size:buf.byteLength});player.enqueue({meta:{seq:id,start:started,duration:ended-started},buf},epoch)};
 recorder.start();setTimeout(()=>{canvas.width=id%2?1280:960;canvas.height=id%2?720:540;draw()},700);setTimeout(()=>{ended=performance.now();recorder.stop()},2000);
 }record();setTimeout(()=>{clearInterval(sync);clearInterval(drawTimer);stream.getTracks().forEach(t=>t.stop());player.close();ac.close();finished=true},18500);
};</script>`;
const server=http.createServer((req,res)=>res.writeHead(200,{'content-type':req.url==='/player.js'?'text/javascript':'text/html'}).end(req.url==='/player.js'?player:html));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),report={browser:browser.version(),sourceSHA256:createHash('sha256').update(player).digest('hex'),scope:'Generated 720p25 H264/AAC; six immediate same-stream recorder restarts with within-piece resolution changes; one isolated browser, no physical-device or live-game claim',cases:[]};
try{for(const codec of (process.env.SAMEEND_RESIZE_COMPARE==='1'?['avc1','selected']:['selected'])){const page=await browser.newPage();const messages=[];page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')messages.push(m.text())});page.on('pageerror',e=>messages.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
const mime=codec==='selected'?await page.evaluate(()=>SameEndMedia.recordingMime(true)):'video/mp4;codecs=avc1.42001f,mp4a.40.2';const caps=await page.evaluate(mime=>({record:MediaRecorder.isTypeSupported(mime),mse:MediaSource.isTypeSupported(mime),play:!!video.canPlayType(mime)}),mime);
const result={codec,mime,caps};if(caps.record&&caps.play){await page.evaluate(mime=>window.testMime=mime,mime);await page.locator('#start').click();await page.waitForFunction(()=>finished,null,{timeout:25000});Object.assign(result,await page.evaluate(()=>({events,samples,pieces})));result.console=messages;}
report.cases.push(result);await page.close();
if(codec==='selected'){assert(caps.record&&caps.mse&&caps.play,'Required local MP4/MSE support');assert.equal(result.pieces.length,6);assert(result.events.every(e=>e.kind==='mode'&&e.mode==='mse'),'Capture resize must not cause decode failure or compatibility fallback');const active=result.samples.filter(s=>s.at>=8&&s.at<=17.5);assert(active.length>=80);assert(active.every(s=>s.mode==='mse'&&!s.waiting&&!s.paused),'Source resizing must not cause repeated player pauses or fallback');const longest=predicate=>{let run=0,max=0;for(const sample of active){run=predicate(sample)?run+.1:0;max=Math.max(max,run)}return max};result.resizeTransitions={maxNotReadySeconds:longest(s=>s.ready<2),maxLowToneSeconds:longest(s=>s.rms<=.005),samples:active.length};assert(result.resizeTransitions.maxNotReadySeconds<=.3,'A real resolution change must recover decoded picture within300ms');assert(result.resizeTransitions.maxLowToneSeconds<=.3,'A real resolution change must recover the measured tone within300ms');assert(new Set(active.map(s=>s.width)).size>=2,'Decoded picture must reflect changing source dimensions');assert(active.at(-1).frames>active[0].frames+150,'Decoded frames must advance across six segments');assert(active.every(s=>Number.isFinite(s.time)&&Math.abs(s.time-s.target)<.5),'Retain the group-clock programme position');result.pass=true;}
console.log(JSON.stringify({codec,mime,pass:result.pass??null,caps,events:result.events,sampleCount:result.samples?.length}));}
}finally{await browser.close();server.close();await writeFile(new URL('evidence.json',out),JSON.stringify(report,null,2));}
