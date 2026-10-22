/* Invitation preflight is local. Seeded secrets must never enter reports. */
import assert from 'node:assert/strict';import http from 'node:http';import{readFile,writeFile,mkdir}from'node:fs/promises';
import{chromium,webkit}from'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const code=await readFile(new URL('../invite-check.js',import.meta.url),'utf8'),sample=await readFile(new URL('../invite-sample.js',import.meta.url),'utf8'),css=await readFile(new URL('../invite-check.css',import.meta.url),'utf8');
const secret='SUPER_PRIVATE_SECRET_1234567890123456789012345',chat='PRIVATE_CHAT_WORDS',ip='192.0.2.123',id='01234567-89ab-4cde-8fab-0123456789ab';
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main><header class="topbar">Same End</header><video id="player" muted playsinline></video><button id="room-check-help">Connection help</button></main><script>window.SameEndConfig={buildId:'abcdef123456'};window.PrivateCast={snapshot:()=>({role:'viewer',config:null,peers:[],received:0,secret:'${secret}',nodeId:'${id}',chat:'${chat}',sdp:'candidate ${ip}'})};</script><script>${sample}</script><script>${code}</script>`;
const server=http.createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(html));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const results=[];
for(const [name,engine]of[['chromium',chromium],['webkit',webkit]]){
 const b=await engine.launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});const c=await b.newContext({viewport:{width:390,height:844}}),p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));let requests=0;p.on('request',r=>{if(/^https?:/.test(r.url()))requests++});
 try{
  await p.addInitScript(()=>{window.shared=[];Object.defineProperty(navigator,'share',{configurable:true,value:async value=>{window.shared.push(value)}});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text}}});});
  await p.goto(origin+'/#club='+id+'.'+secret+'&join='+encodeURIComponent('magnet:?xt=urn:btih:0123456789012345678901234567890123456789#pc='+secret));await p.waitForFunction(()=>window.SameEndInviteCheck?.report().silentSample!=='not-run');
  await p.waitForFunction(()=>!['not-run'].includes(SameEndInviteCheck.report().silentSample));await p.waitForTimeout(500);assert(await p.locator('#invite-check').isVisible());
  assert.equal(await p.evaluate(()=>shared.length),0);assert.equal(requests,1,'sample and diagnostics must make no upload or external media request');
  await p.evaluate(()=>{SameEndInviteCheck.fail('app-error');dispatchEvent(new ErrorEvent('error',{message:'https://evil.invalid/#owner=RAW_ERROR_SECRET'}))});
  const r=await p.evaluate(()=>SameEndInviteCheck.report()),packed=JSON.stringify(r);for(const forbidden of[secret,chat,ip,id,'RAW_ERROR_SECRET','magnet:','candidate','evil.invalid'])assert(!packed.includes(forbidden));assert.equal(r.problem,'app-error');
  await p.click('#invite-check-share');const shared=await p.evaluate(()=>window.shared);assert.equal(shared.length,1);assert.deepEqual(Object.keys(shared[0]).sort(),['text','title']);assert(!shared[0].text.includes(secret));assert(!shared[0].url);
  await p.click('#invite-check-copy');assert((await p.evaluate(()=>window.copied)).startsWith('Same End connection check'));
  const[d]=await Promise.all([p.waitForEvent('download'),p.click('#invite-check-save')]);assert.equal(d.suggestedFilename(),'same-end-connection-report.json');
  await p.evaluate(()=>{Object.defineProperty(navigator,'share',{configurable:true,value:undefined});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied')}}});});await p.click('#invite-check-share');assert.equal(await p.locator('#invite-check-report').evaluate(el=>el.selectionEnd-el.selectionStart>0),true);
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  await p.goto(origin+'/?case=club#club='+id+'.'+secret);await p.evaluate(()=>{PrivateCast.snapshot=()=>({role:null,config:null,peers:[]});window.SameEndSocial={snapshot:()=>({connected:true})};SameEndInviteCheck.phase('club-ready');});assert.equal(await p.locator('#invite-check').isVisible(),false);
  // A deliberate five-minute communal delay is a connected success, not a timeout.
  await p.goto(origin+'/?case=delay#join=anything');await p.evaluate(()=>{PrivateCast.snapshot=()=>({role:'viewer',config:{epoch:Date.now(),delay:300,audio:true},clockReady:true,offset:0,peers:[{ready:true,state:'connected',id:'secret-peer-id'}],mime:'video/mp4',received:1});});await p.waitForFunction(()=>SameEndInviteCheck.report().joining.phase==='waiting-for-group');assert.equal(await p.evaluate(()=>SameEndInviteCheck.report().problem),null);
  results.push({engine:name,pass:true,silentSample:r.silentSample,automaticSend:false,privacy:true,shareCopyDownloadFallback:true,phoneOverflow:false,delay300NotFailure:true});
 }finally{await b.close();}
}
await new Promise(r=>server.close(r));await mkdir(new URL('../privatework/',import.meta.url),{recursive:true});await writeFile(new URL('../privatework/invite-check-browser.json',import.meta.url),JSON.stringify(results,null,2));console.log('PASS invitation preflight, privacy, explicit share, copy/download fallbacks, club-only and300s wait in Chromium and WebKit.');
