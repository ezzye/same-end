/* Real, isolated Chrome tab capture of a generated tone. No user tabs or live API. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createApi} from '../backend/api.mjs';
import {MemoryStore} from '../backend/store.mjs';
const {chromium}=await import(process.env.SAMEEND_PLAYWRIGHT||'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const out=new URL('../privatework/source-audio-warning/',import.meta.url);await mkdir(out,{recursive:true});
const title='Same End audio fixture '+crypto.randomUUID();
let html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
html=html.replace(/window\.SameEndConfig\s*=\s*\{[^}]*\}/,"window.SameEndConfig={apiBase:'/api',buildId:'local'}");
const sourceHTML=`<!doctype html><title>${title}</title><h1>Generated test source</h1><button id="start">Start tone</button><button id="source-mute">Mute original player</button><canvas id="canvas" width="640" height="360"></canvas><audio id="tone"></audio><script>
let ac,osc;const audio=document.querySelector('#tone');start.onclick=async()=>{ac=new AudioContext();await ac.resume();const dest=ac.createMediaStreamDestination(),gain=ac.createGain();gain.gain.value=.025;osc=ac.createOscillator();osc.frequency.value=220;osc.connect(gain).connect(dest);osc.start();audio.srcObject=dest.stream;await audio.play();document.body.dataset.ready='yes'};document.querySelector('#source-mute').onclick=()=>{audio.muted=!audio.muted;document.querySelector('#source-mute').textContent=audio.muted?'Unmute original player':'Mute original player'};const c=document.querySelector('canvas'),x=c.getContext('2d');let n=0;setInterval(()=>{x.fillStyle='#073d2b';x.fillRect(0,0,640,360);x.fillStyle='#fff';x.font='30px system-ui';x.fillText('Same End source sound check',20,70);x.fillText(new Date().toISOString().slice(11,23),20,130);x.fillStyle='#e93625';x.fillRect((n++*5)%500,210,90,70)},40);
</script>`;
let api,origin;const requests=[];
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,origin||'http://127.0.0.1');requests.push(u.pathname);if(u.pathname.startsWith('/api/')){const chunks=[];for await(const c of req)chunks.push(c);const r=await api.handler({rawPath:u.pathname.slice(4),headers:req.headers,body:Buffer.concat(chunks).toString(),queryStringParameters:Object.fromEntries(u.searchParams),requestContext:{http:{method:req.method,sourceIp:'source-audio-test'}}});res.writeHead(r.statusCode,r.headers).end(r.body);return}if(u.pathname==='/source')return res.writeHead(200,{'Content-Type':'text/html'}).end(sourceHTML);if(u.pathname==='/fixtures.json')return res.writeHead(200,{'Content-Type':'application/json'}).end('{"fixtures":[]}');res.writeHead(200,{'Content-Type':'text/html'}).end(html)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;api=createApi({store:new MemoryStore(),push:{enabled:false},allowedOrigins:[origin]});
const browser=await chromium.launch({channel:'chrome',headless:false,args:['--auto-select-desktop-capture-source='+title,'--enable-usermedia-screen-capturing','--no-first-run','--no-default-browser-check']});
const result={scope:'Actual Chrome tab capture, synthetic220Hz original audio element, real source monitor and full SameEnd UI; in-memory API',autoplayOverride:false,originalUserSessionTouched:false,checks:{}};
try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}});const source=await context.newPage();await source.goto(origin+'/source');await source.click('#start');await source.waitForFunction(()=>document.body.dataset.ready==='yes');
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>SameEndSocial?.snapshot().ready);await page.locator('#settings > summary').click();await page.selectOption('#delay','10');await page.click('#capture');await page.waitForFunction(()=>PrivateCast.snapshot().role==='source',{timeout:20000});
 await page.waitForFunction(()=>PrivateCast.snapshot().sourceAudio?.status==='sound',null,{timeout:15000});
 result.checks.sound=await page.evaluate(()=>({health:PrivateCast.snapshot().sourceAudio,tracks:PrivateCast.snapshot().tracks,cardVisible:!document.querySelector('#source-audio').hidden,help:document.querySelector('#source-audio-help').textContent}));
 assert(result.checks.sound.tracks.some(t=>t.kind==='audio'&&t.localPlaybackSuppressed));
 assert.match(result.checks.sound.help,/Keep sound ON in the original player/);
 await page.locator('#watch-room').scrollIntoViewIfNeeded();await page.screenshot({path:new URL('source-sound-ok.png',out).pathname,mask:[page.locator('#browser-invitation'),page.locator('#magnet-link'),page.locator('#club-invite-url'),page.locator('#club-owner-url')]});
 const mutedAt=Date.now();await source.click('#source-mute');await page.bringToFront();
 await page.waitForFunction(()=>PrivateCast.snapshot().sourceAudio?.status==='quiet',null,{timeout:23000});
 result.checks.quiet={elapsedMs:Date.now()-mutedAt,...await page.evaluate(()=>({health:PrivateCast.snapshot().sourceAudio,text:document.querySelector('#source-audio').innerText,roomMuted:document.querySelector('#player').muted}))};
 assert(result.checks.quiet.elapsedMs>=14000);assert.match(result.checks.quiet.text,/unmute the original player/);
 await page.locator('#source-audio').scrollIntoViewIfNeeded();await page.screenshot({path:new URL('source-sound-warning.png',out).pathname,mask:[page.locator('#browser-invitation'),page.locator('#magnet-link'),page.locator('#club-invite-url'),page.locator('#club-owner-url')]});
 await source.click('#source-mute');await page.bringToFront();await page.waitForFunction(()=>PrivateCast.snapshot().sourceAudio?.status==='sound',null,{timeout:4000});result.checks.recovery=true;
 await page.click('#sound');assert.equal(await page.locator('#sound').textContent(),'Mute my sound');assert.equal(await source.locator('#tone').evaluate(v=>v.muted),false);result.checks.roomMuteIsIndependent=true;
 // Chrome's automated capture window can remain "visible" with background tabs.
 // Exercise the existing visibility event handler explicitly, without changing production logic.
 await page.click('#sound');assert.equal(await page.locator('#player').evaluate(v=>v.muted),true);assert.equal(await source.locator('#tone').evaluate(v=>v.muted),false);assert.equal(await page.evaluate(()=>PrivateCast.snapshot().sourceAudio.status),'sound');await page.click('#sound');
 await page.evaluate(()=>{window.testPageVisibility='hidden';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.testPageVisibility});document.dispatchEvent(new Event('visibilitychange'))});
 await page.waitForFunction(()=>document.querySelector('#player').paused,null,{timeout:4000,polling:200});result.checks.hiddenEventPaused=true;
 await page.evaluate(()=>{window.testPageVisibility='visible';document.dispatchEvent(new Event('visibilitychange'))});await page.waitForFunction(()=>!document.querySelector('#player').paused,null,{timeout:4000,polling:200});result.checks.visibleEventResumed=true;result.visibilityTest='Simulated hidden/visible document events; actual automated capture window reported visible while backgrounded';
 await page.setViewportSize({width:390,height:844});await page.locator('#source-audio').scrollIntoViewIfNeeded();result.checks.mobileOverflow=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(result.checks.mobileOverflow.scroll,result.checks.mobileOverflow.viewport);
 await page.click('#stop');await page.waitForFunction(()=>document.querySelector('#source-audio').hidden);result.checks.closedCardHidden=true;
 result.errors=errors;assert.deepEqual(errors,[]);result.noExternalBackend=requests.every(x=>!x.includes('execute-api'));result.pass=true;
}catch(e){result.error=String(e).slice(0,800);throw e}finally{await writeFile(new URL('browser-acceptance.json',out),JSON.stringify(result,null,2));await browser.close();await new Promise(r=>server.close(r));console.log(JSON.stringify(result))}
