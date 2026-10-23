/* Local invitation feedback states; all connection and clock inputs are synthetic. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from '/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const html=await readFile(new URL('../dist/watch.html',import.meta.url),'utf8');
const server=http.createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(html));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{const real=Date.now.bind(Date);let offset=0;Date.now=()=>real()+offset;window.advanceClock=ms=>{offset+=ms};});
const origin='http://127.0.0.1:'+server.address().port;
try{
 await page.goto(origin);await page.waitForFunction(()=>window.SameEndInviteCheck&&window.PrivateCast);
 await page.evaluate(()=>{window.feedbackSnapshot={role:'viewer',config:null,peers:[],clockReady:false};PrivateCast.snapshot=()=>feedbackSnapshot;PrivateCast.canRetryJoin=()=>true;window.retryCount=0;PrivateCast.retryJoin=()=>{retryCount++;SameEndInviteCheck.start('screen',{fresh:true});};SameEndInviteCheck.start('screen',{fresh:true});});
 await page.evaluate(()=>SameEndInviteCheck.fail('room-unavailable'));
 const dialog=page.locator('#invite-check');await page.waitForFunction(()=>document.querySelector('#invite-check')?.classList.contains('is-failure-dialog'));
 await page.evaluate(()=>SameEndInviteCheck.fail('chat-unavailable'));assert.equal(await page.locator('#invite-check-title').innerText(),'The picture didn’t connect','parallel late chat failure cannot hide fatal picture failure');assert.equal(await dialog.getAttribute('role'),'alertdialog');assert.equal(await page.locator('#invite-check-title').innerText(),'The picture didn’t connect');
 assert.equal(await page.locator('#invite-check-retry').isVisible(),true);assert.equal(await page.locator('#invite-check-dismiss').isVisible(),true);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'invite-check','failure dialog receives focus');
 await mkdir(new URL('../privatework/invite-feedback-20261023/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../privatework/invite-feedback-20261023/failure-phone.png',import.meta.url).pathname});
 await page.keyboard.press('Escape');assert.equal(await dialog.evaluate(el=>el.classList.contains('is-failure-dialog')),false);assert.equal(await page.locator('#invite-check').isVisible(),true,'dismissal leaves persistent error panel');
 await page.click('#invite-check-help');assert.equal(await dialog.evaluate(el=>el.classList.contains('is-failure-dialog')),true,'help reopens failure dialog');
 await page.click('#invite-check-retry');assert.equal(await page.evaluate(()=>retryCount),1);assert.equal(await dialog.evaluate(el=>el.classList.contains('is-failure-dialog')),false,'retry resets terminal dialog');
 await page.evaluate(()=>SameEndInviteCheck.fail('playback-blocked'));assert.equal(await page.locator('#invite-check-play').isVisible(),true);
 await page.evaluate(()=>{feedbackSnapshot={role:'viewer',config:{epoch:Date.now(),delay:300,audio:true},clockReady:true,offset:0,peers:[{ready:true,state:'connected'}],mime:'video/mp4',received:1};SameEndInviteCheck.start('screen',{fresh:true});});
 await page.waitForFunction(()=>SameEndInviteCheck.report().joining.phase==='waiting-for-group');assert.equal(await page.locator('#invite-check').evaluate(el=>el.classList.contains('is-failure-dialog')),false);
 await page.evaluate(()=>{feedbackSnapshot={role:'viewer',config:null,peers:[]};SameEndInviteCheck.start('screen',{fresh:true});advanceClock(45000)});await page.waitForTimeout(1200);
 assert.equal(await page.locator('#invite-check').evaluate(el=>el.classList.contains('is-failure-dialog')),false,'45 seconds of connection work remains a warning');
 assert.match(await page.locator('#invite-check-message').innerText(),/slow|still/i,'slow connection keeps an amber message');
 await page.evaluate(()=>{feedbackSnapshot={role:'viewer',config:{epoch:Date.now()-20000,delay:10,audio:true},clockReady:true,offset:0,peers:[{ready:true,state:'connected'}],mime:'video/mp4',received:1};const v=document.querySelector('#player');Object.defineProperty(v,'readyState',{configurable:true,value:4});Object.defineProperty(v,'paused',{configurable:true,value:false});Object.defineProperty(v,'currentTime',{configurable:true,get:()=>100+performance.now()/1000});SameEndInviteCheck.start('screen',{fresh:true});});
 await page.waitForFunction(()=>SameEndInviteCheck.report().joining.phase==='playing'&&getComputedStyle(document.querySelector('#invite-check')).display==='none',{timeout:5000});
 assert.equal(await page.locator('#invite-check').isVisible(),false,'advancing video clears the warning');assert.equal(await page.evaluate(()=>Number.isFinite(SameEndInviteCheck.report().startup.firstPictureMs)),true,'first visible picture has a measured startup time');
 await page.evaluate(()=>{feedbackSnapshot={role:'viewer',config:null,peers:[]};SameEndInviteCheck.start('screen',{fresh:true});if(document.querySelector('#invite-check').hidden)throw Error('Fresh attempt must show connecting feedback after prior success');if(SameEndInviteCheck.report().startup.firstPictureMs!==null)throw Error('Fresh attempt must reset startup timings');advanceClock(91000)});await page.waitForTimeout(1200);
 assert.equal(await page.locator('#invite-check').evaluate(el=>el.classList.contains('is-failure-dialog')),true,'over 90 seconds without picture escalates to a clear failure');
 assert.equal(await page.locator('#invite-check-title').innerText(),'The picture hasn’t connected');
 await page.evaluate(()=>{SameEndInviteCheck.start('screen',{fresh:true});SameEndInviteCheck.fail('room-unavailable')});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'failure dialog fits 390px viewport');
 assert.equal(await page.locator('#invite-check-share').count(),1,'host report action remains available');assert.deepEqual(errors,[]);
 // Exercise the actual engine retry hook without contacting any tracker or peer.
 const retryPage=await context.newPage();retryPage.on('pageerror',e=>errors.push(e.message));await retryPage.goto(origin);await retryPage.waitForFunction(()=>window.PrivateCast);
 await retryPage.evaluate(async()=>{window.joinAttempts=[];window.CastMagnetTransport=class{async join(link){joinAttempts.push(link);await new Promise(r=>setTimeout(r,30));throw Error('Synthetic direct connection failure');}snapshot(){return {network:{phase:'failed',problem:'no-direct-peer'}};}async close(){}};window.fakeLink='magnet:?xt=urn:btih:'+('a'.repeat(40))+'#pc=synthetic-test-key';const pending=PrivateCast.joinMagnet(fakeLink).catch(()=>{});if(PrivateCast.canRetryJoin())throw Error('Must not retry during an active attempt');await pending;});
 await retryPage.waitForFunction(()=>!document.querySelector('#invite-check-retry').disabled&&!document.querySelector('#invite-check-retry').hidden);await retryPage.click('#invite-check-retry');await retryPage.waitForFunction(()=>joinAttempts.length===2&&!PrivateCast.snapshot().joiningBusy);
 assert(await retryPage.evaluate(()=>joinAttempts.every(link=>link===fakeLink)),'actual retry reuses the private invitation in memory');
 assert.equal(await retryPage.evaluate(()=>JSON.stringify(SameEndInviteCheck.report()).includes(fakeLink)||document.documentElement.outerHTML.includes(fakeLink)||JSON.stringify(localStorage).includes(fakeLink)),false,'retry link is not put in reports, DOM or local storage');
 const saved=retryPage.waitForEvent('download');await retryPage.evaluate(()=>document.querySelector('#save-app').click());const savedApp=await readFile(await (await saved).path(),'utf8');assert(!savedApp.includes('synthetic-test-key'),'saved standalone app excludes retry invitation');
 await retryPage.evaluate(()=>document.querySelector('#stop').onclick());assert.equal(await retryPage.evaluate(()=>PrivateCast.canRetryJoin()),false,'stop handler clears remembered retry invitation');await retryPage.close();assert.deepEqual(errors,[]);
 console.log('PASS: terminal invite failure dialog, focus/Escape, persistent panel/help reopen, retry reset, playback-blocked action, connected group wait, 45s warning, recovery on playback, host report action, and 390px width. All connection state and time are synthetic; no real invite or network connection tested.');
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
