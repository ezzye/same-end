/* Real signed chunks + automatic magnet joining on one Mac. Capability removal
 * exercises old-browser paths; it does NOT emulate physical OS/hardware. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const {chromium,webkit}=await import(process.env.SAMEEND_PLAYWRIGHT||process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const html=await readFile(new URL('../dist/watch.html',import.meta.url),'utf8');
const server=http.createServer((req,res)=>{if(req.url.startsWith('/sw.js'))return res.writeHead(404).end();res.writeHead(200,{'content-type':'text/html','referrer-policy':'no-referrer'}).end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const delay=process.env.SAMEEND_FULL_DELAY==='1'?300:10;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const apple=process.env.SAMEEND_REAL_WEBKIT==='1'?await webkit.launch():null;
const pages=[],errors=[],report={physicalDevices:false,separateNetworks:false,delay,realWebKit:!!apple,autoplayOverride:true,pass:false};
async function page(kind){
 const c=await (kind==='clips'&&apple?apple:browser).newContext({serviceWorkers:'block',viewport:kind==='clips'?{width:390,height:844}:{width:1280,height:900}});const p=await c.newPage();pages.push(p);p.on('pageerror',e=>errors.push(kind+': '+(e.stack||e.message)));
 await p.addInitScript(kind=>{
  delete Uint8Array.prototype.toBase64;delete Uint8Array.prototype.toHex;delete Uint8Array.fromHex;delete crypto.randomUUID;delete Object.hasOwn;delete window.structuredClone;delete window.globalThis;delete window.queueMicrotask;delete Blob.prototype.arrayBuffer;delete Blob.prototype.text;delete Object.fromEntries;delete Array.prototype.flatMap;delete String.prototype.replaceAll;delete Element.prototype.replaceChildren;delete window.WritableStream;
  if(kind==='clips'){window.MediaSource=undefined;window.ManagedMediaSource=undefined;window.MediaRecorder=undefined;}
  if(kind==='managed'){window.ManagedMediaSource=window.MediaSource;window.MediaSource=undefined;window.MediaRecorder=undefined;}
 },kind);await p.goto(origin);await p.waitForFunction(()=>window.PrivateCast);return p;
}
async function playing(p){await p.waitForFunction(()=>{const v=document.getElementById('player'),s=PrivateCast.snapshot();return s.clockReady&&s.received>3&&v.readyState>=2&&!v.paused&&v.getVideoPlaybackQuality().totalVideoFrames>5;},null,{timeout:delay*1000+90000});}
try{
 const source=await page('source');await source.evaluate(delay=>PrivateCast.testing.startDemo({delay}),delay);assert.match(await source.evaluate(()=>PrivateCast.snapshot().mime),/^video\/mp4/);
 const magnet=await source.evaluate(()=>PrivateCast.testing.publishInvitation());
 const clip=await page('clips');await clip.evaluate(link=>PrivateCast.joinMagnet(link),magnet);
 const managed=await page('managed');await managed.evaluate(link=>PrivateCast.joinMagnet(link),magnet);
 await Promise.all([source,clip,managed].map(playing));
 assert.equal(await clip.evaluate(()=>PrivateCast.snapshot().playbackMode),'clips');assert.equal(await managed.evaluate(()=>PrivateCast.snapshot().playbackMode),'mse');
 report.samples=[];
 for(let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,500));
  report.samples.push(await Promise.all([source,clip,managed].map(p=>p.evaluate(()=>{const s=PrivateCast.snapshot(),v=document.getElementById('player');return{mode:s.playbackMode,mime:s.mime,received:s.received,clockReady:s.clockReady,drift:s.drift,ready:v.readyState,playing:!v.paused,frames:v.getVideoPlaybackQuality().totalVideoFrames,peers:s.peers.length};}))));
 }
 for(let n=0;n<3;n++){const samples=report.samples.map(s=>s[n]);assert(samples.filter(s=>s.playing&&s.frames>0).length>=8,'picture must advance across boundaries');assert(samples.some(s=>s.drift!==null&&Math.abs(s.drift)<.5),'shared-clock alignment');}
 assert(await clip.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 // Losing a supplier must retain the viewer identity/clock/cache, then recover.
 const id=await clip.evaluate(()=>PrivateCast.snapshot().config.id);await clip.evaluate(()=>PrivateCast.testing.disconnectUpstream());await clip.waitForFunction(()=>PrivateCast.snapshot().recovery.recoveries>=1,null,{timeout:60000});await playing(clip);assert.equal(await clip.evaluate(()=>PrivateCast.snapshot().config.id),id);
 report.recovery=true;report.errors=errors;assert.deepEqual(errors,[]);report.pass=true;
 console.log('PASS signed MP4 peers: missing-modern-API source, no-recorder/no-MSE viewer, simulated MMS viewer, shared delay, relay recovery.');
}catch(e){report.error=e.message;report.states=await Promise.all(pages.map(p=>p.evaluate(()=>({snapshot:PrivateCast.snapshot(),status:document.getElementById('status').textContent,play:document.getElementById('play-state').textContent})).catch(()=>({closed:true}))));console.error(e);process.exitCode=1;}
finally{await mkdir(new URL('../privatework/',import.meta.url),{recursive:true});await writeFile(new URL('../privatework/platform-peer-'+delay+(apple?'-webkit':'')+'.json',import.meta.url),JSON.stringify(report,null,2));await apple?.close();await browser.close();await new Promise(r=>server.close(r));}
