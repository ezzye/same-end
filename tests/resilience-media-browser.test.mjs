import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = await import(process.env.SAMEEND_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'); }
const root = new URL('../', import.meta.url);
const built = await build({ stdin: { contents: "import './capture-normalize.js'; import {createResilientCapture} from './resilience-capture.js'; import {canCapture} from './hls-capture.js'; import {ResilientPlayer} from './resilience-player.js'; import {encodeBundle,decodeBundle} from './hls-protocol.js'; import {generatedSource} from './tests/helpers/hls-generated-source.js'; Object.assign(window,{createResilientCapture,canCapture,ResilientPlayer,encodeBundle,decodeBundle,generatedSource});", resolveDir: fileURLToPath(root) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const server = createServer((req,res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? built.outputFiles[0].text : '<!doctype html><video id="video" muted playsinline></video><script src="/bundle.js"></script>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await playwright.chromium.launch({ ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'}), headless:true, args:['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] });
try {
 const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result = await page.evaluate(async () => {
  const source=await generatedSource(), epoch=Date.now(), batches={audio:[],v360:[],v480:[]}, errors=[];
  const originalProbe=VideoEncoder.isConfigSupported, checked=[]; VideoEncoder.isConfigSupported=async config=>{checked.push({width:config.width,height:config.height,bitrate:config.bitrate}); return config.width>640 ? {supported:false,config} : originalProbe.call(VideoEncoder,config);};
  const lowSupported=await canCapture(new MediaStream([source.stream.getVideoTracks()[0]]),{width:640,height:360,frameRate:25,bitrate:400000}); VideoEncoder.isConfigSupported=originalProbe; if(!lowSupported||!checked.some(c=>c.width===640&&c.height===360&&c.bitrate===400000)) throw Error('Low-profile capability checked wrong dimensions or bitrate');
  const fake=await navigator.mediaDevices.getUserMedia({audio:true}); source.stream.removeTrack(source.audioTrack); source.stream.addTrack(fake.getAudioTracks()[0]);
  let player; const producer=await createResilientCapture(source.stream,{epoch,onError:(e,n)=>errors.push(n+': '+e.message),onBatch(batch){ const buf=encodeBundle(batch); const piece={buf,meta:{rendition:batch.rendition,start:epoch+batch.start*1000,duration:batch.duration*1000}}; batches[batch.rendition].push(piece); if(player)player.enqueue(piece,epoch); }});
  await new Promise(r=>setTimeout(r,10000));
  const startupVideo=document.createElement('video'); startupVideo.muted=true; document.body.append(startupVideo);
  const prepared=new ResilientPlayer(startupVideo,{}, {onError:e=>errors.push(e)}); prepared.startupHold=true; prepared.setMode('v360');
  batches.audio.forEach(piece=>prepared.enqueue(piece,epoch));
  for(let i=0;i<8;i++){prepared.prepareStartup(1,4); await new Promise(r=>setTimeout(r,200));}
  const missing=prepared.startupFacts(1), premature=prepared.commitStartup(1,4);
  batches.v360.forEach(piece=>prepared.enqueue(piece,epoch)); let aligned;
  for(let i=0;i<40;i++){aligned=prepared.prepareStartup(1,4); if(aligned?.ready && aligned.aligned && aligned.cacheAheadSeconds>=4 && aligned.decoderAheadSeconds>=3.92)break; await new Promise(r=>setTimeout(r,200));}
  const committed=prepared.commitStartup(1,4), holdAfterCommit=prepared.startupHold; let warmTarget=1; const warmTicker=setInterval(()=>{prepared.sync(warmTarget);warmTarget+=.2},200); await new Promise(r=>setTimeout(r,1500)); const clockBefore=prepared.programTime(),framesBefore=startupVideo.getVideoPlaybackQuality().totalVideoFrames; await new Promise(r=>setTimeout(r,1000)); const clockAfter=prepared.programTime(),framesAfter=startupVideo.getVideoPlaybackQuality().totalVideoFrames; clearInterval(warmTicker); const startup={missing,premature,aligned,committed,holdAfterCommit,clockBefore,clockAfter,framesBefore,framesAfter}; prepared.close(); startupVideo.remove();
  player=new ResilientPlayer(document.querySelector('#video'),{}, {onError:e=>errors.push(e)}); if(document.querySelector('[data-same-end-audio]')!==player.audioElement || !player.audioElement.hidden) throw Error('Audio clock element missing'); player.soundRequested=true; if(!player.audio.soundRequested || player.adaptive!==player.audio.adaptive || player.facts().mode!==player.audio.mode) throw Error('Engine player proxies mismatch');
  for(const name of Object.keys(batches)) for(const piece of batches[name]) player.enqueue(piece,epoch);
  let target=1; const pump=setInterval(()=>{player.sync(target); target+=.2},200);
  await new Promise(r=>setTimeout(r,3500));
  const before=player.programTime(); const first=player.mode;
  player.setMode('audio'); await new Promise(r=>setTimeout(r,1200)); const audio=player.programTime();
  const switched=player.setMode('v360'); await new Promise(r=>setTimeout(r,2500)); const after=player.programTime(); const liveFacts=player.facts(); const videoState={programTime:player.videoPlayer?.programTime(),width:player.video.videoWidth, time:player.video.currentTime, ready:player.video.readyState, frames:player.video.getVideoPlaybackQuality().totalVideoFrames};
  clearInterval(pump); const initText=name=>new TextDecoder('latin1').decode(decodeBundle(batches[name][0].buf).files.find(f=>f.path.endsWith('.mp4')).bytes); const tracks={audio:initText('audio'),v360:initText('v360')}; const trackKinds={audioSound:tracks.audio.includes('soun'),audioVideo:tracks.audio.includes('vide'),videoSound:tracks.v360.includes('soun'),videoVideo:tracks.v360.includes('vide')}; const videoTimes=batches.v360.map(x=>[Math.round((x.meta.start-epoch)),Math.round(x.meta.duration)]); const info={startup,liveFacts,trackKinds,videoState,videoTimes,counts:Object.fromEntries(Object.entries(batches).map(([k,v])=>[k,v.length])), first,before,audio,after,switched,mode:player.mode,errors, audioFiles:batches.audio[0]&&decodeBundle(batches.audio[0].buf).files.map(f=>f.path), stats:producer.stats};
  player.close(); if(document.querySelector('[data-same-end-audio]')) throw Error('Audio clock element leaked'); await producer.close(); fake.getTracks().forEach(t=>t.stop()); await source.close(); return info;
 });
 console.log(JSON.stringify(result));
 assert(result.counts.audio>=2 && result.counts.v360>=2 && result.counts.v480>=2);
 assert.deepEqual(result.errors,[]); assert.equal(result.startup.missing.ready,false); assert.equal(result.startup.missing.awaitingPicture,true); assert.equal(result.startup.premature,false); assert.equal(result.startup.committed,true); assert.equal(result.startup.holdAfterCommit,false); assert(result.startup.clockAfter>result.startup.clockBefore, 'committed audio clock must advance'); assert(result.startup.framesAfter>result.startup.framesBefore, 'committed video must decode more frames'); assert.deepEqual(result.trackKinds,{audioSound:true,audioVideo:false,videoSound:false,videoVideo:true}); assert(result.audioFiles.includes('master.m3u8'));
 const synthetic = await page.evaluate(async () => {
  const source=await generatedSource(); source.stream.removeTrack(source.audioTrack);
  const batches=[],errors=[],epoch=Date.now(); let player;
  const producer=await createResilientCapture(source.stream,{epoch,renditions:['v360'],onError:(error,name)=>errors.push(name+': '+error.message),onBatch(batch){if(batch.rendition==='audio') { const piece={buf:encodeBundle(batch),meta:{rendition:'audio',start:epoch+batch.start*1000,duration:batch.duration*1000}}; batches.push(piece); if(player)player.enqueue(piece,epoch); }}});
  await new Promise(r=>setTimeout(r,7500));
  player=new ResilientPlayer(document.querySelector('#video'),{sourceAudioAvailable:false},{onError:error=>errors.push(error)}); player.setMode('audio'); batches.forEach(piece=>player.enqueue(piece,epoch)); let target=1; const ticker=setInterval(()=>{player.sync(target);target+=0.2},200); await new Promise(r=>setTimeout(r,4000)); const clock1=player.programTime(); player.startupHold=true; const holdPaused=player.audioElement.paused && player.audio.startupHold; await new Promise(r=>setTimeout(r,300)); player.startupHold=false; await new Promise(r=>setTimeout(r,1000)); const clock2=player.programTime(); clearInterval(ticker);
  const result={sourceAudioAvailable:producer.sourceAudioAvailable,syntheticAudio:producer.syntheticAudio,renditions:Object.keys(producer.renditions),audioBatches:batches.length,progress:batches.length>1?(batches[batches.length-1].meta.start-batches[0].meta.start)/1000:null,clock1,clock2,holdPaused,errors};
  player.close(); await producer.close(); await source.close(); return result;
 });
 console.log('synthetic',JSON.stringify(synthetic));
 assert.equal(synthetic.sourceAudioAvailable,false); assert.equal(synthetic.syntheticAudio,true); assert.deepEqual(synthetic.renditions,['audio','v360']);
 assert(synthetic.audioBatches>=2 && synthetic.progress>0, 'synthetic audio capture must advance'); assert(synthetic.clock1!==null && synthetic.clock2>synthetic.clock1, 'synthetic audio playback clock must advance'); assert.equal(synthetic.holdPaused,true); assert.deepEqual(synthetic.errors,[]);
 assert(result.before!==null && result.audio!==null && result.after!==null); assert(result.audio>result.before); assert.equal(result.mode,'v360'); assert.equal(result.liveFacts.pictureReady,true); assert.equal(result.liveFacts.actualMode,'v360'); assert(result.videoState.width===640 && result.videoState.frames>0, 'v360 must actually decode frames'); assert(Math.abs(result.videoState.programTime-result.after)<1, 'video must align with audio clock');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
