// Owned instrumentation check: two generated local resources, unchanged element audio output.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {initialDelayPageProbe} from './helpers/initial-delay-page.mjs';
const {chromium}=await import(process.env.SAMEEND_PLAYWRIGHT||pathToFileURL(process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
const output=new URL('../privatework/common-start-audio-tee/',import.meta.url);await mkdir(output,{recursive:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<video id="player" muted playsinline loop></video><button id="sound">Sound</button><button id="make">Generate owned fixtures</button>');
 await page.evaluate(()=>{
  window.PrivateCast={snapshot:()=>({role:'viewer',ready:4,programTime:0})};
  document.querySelector('#sound').onclick=()=>{const v=document.querySelector('#player');v.muted=false;v.play()};
  document.querySelector('#make').onclick=()=>window.fixturesReady=(async()=>{
   const ac=new AudioContext();await ac.resume();const blobs=[];
   for(const frequency of [900,1600]){
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');let n=0;
    const timer=setInterval(()=>{ctx.fillStyle=++n%2?'green':'blue';ctx.fillRect(0,0,160,90)},40);
    const osc=ac.createOscillator(),dest=ac.createMediaStreamDestination();osc.frequency.value=frequency;osc.connect(dest);osc.start();
    const video=canvas.captureStream(25),stream=new MediaStream([...video.getVideoTracks(),...dest.stream.getAudioTracks()]);
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8,opus'}),chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);
    const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();await new Promise(resolve=>setTimeout(resolve,1500));recorder.stop();await stopped;
    blobs.push(URL.createObjectURL(new Blob(chunks,{type:recorder.mimeType})));osc.stop();for(const track of stream.getTracks())track.stop();clearInterval(timer);
   }
   await ac.close();window.ownedResources=blobs;document.querySelector('#player').src=blobs[0];
  })();
 });
 await page.locator('#make').click();await page.evaluate(()=>fixturesReady);
 await page.evaluate(probe=>{(0,eval)('('+probe+')')({device:'chromium',profile:'steady',audioTee:true,runNonce:'owned-tee-test'})},initialDelayPageProbe.toString());
 await page.locator('#initial-join').click();
 await page.waitForFunction(()=>{const s=initialAcceptanceSnapshot();return s.rms>.001&&s.peakFrequency>700&&s.peakFrequency<1100},null,{timeout:8000});
 const before=await page.evaluate(()=>initialAcceptanceSnapshot());
 await page.evaluate(()=>{const v=document.querySelector('#player');v.pause();v.removeAttribute('src');v.load();v.src=ownedResources[1];v.play()});
 await page.waitForFunction(generation=>{const s=initialAcceptanceSnapshot();return s.probe.audioTee.generation>generation&&s.rms>.001&&s.peakFrequency>1400&&s.peakFrequency<1800},before.probe.audioTee.generation,{timeout:8000});
 const after=await page.evaluate(()=>initialAcceptanceSnapshot());
 assert(after.probe.audioTee.generation>before.probe.audioTee.generation);assert(after.probe.audioTee.trackStates.every(t=>t.readyState==='live'));
 assert(after.probe.audioTeeResets.some(r=>['emptied','loadstart','audio-track-ended'].includes(r.reason)));
 assert.equal(after.muted,false);assert.equal(after.paused,false);assert.equal(after.audioContextState,'running');assert.deepEqual(errors,[]);assert.deepEqual(after.probe.errors,[]);
 const report={pass:true,scope:'Generated local resource reset verifies analyser tee only; no production media/device acceptance',before:{rms:before.rms,peakFrequency:before.peakFrequency,tee:before.probe.audioTee},after:{rms:after.rms,peakFrequency:after.peakFrequency,tee:after.probe.audioTee,resets:after.probe.audioTeeResets},nativeOutputRerouted:false,pageErrors:errors};
 await writeFile(new URL('result.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close()}
