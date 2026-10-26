/* Full-app responsive layout regression. Uses only local app/API fixtures. */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=process.env.SAMEEND_PLAYWRIGHT||path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {chromium}=await import(runtime);
const baseline=process.argv.includes('--baseline');
const evidence=path.join(root,'privatework/responsive-layout');await mkdir(evidence,{recursive:true});
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const webPort=await freePort(),frontPort=webPort,apiPort=await freePort(),origin=`http://127.0.0.1:${frontPort}`;
if(!baseline)execFileSync(process.execPath,['build-pwa.mjs'],{cwd:root,env:{...process.env,SAME_END_LOCAL:'1'},stdio:'ignore'});
const env={...process.env,PORT:String(apiPort),SAME_END_LOCAL_WEB_PORT:String(frontPort),SAME_END_LOCAL_API_PORT:String(apiPort)};
const api=spawn(process.execPath,['backend/local.mjs'],{cwd:root,env,stdio:'ignore'});
const web=spawn(process.execPath,['serve.mjs'],{cwd:root,env:{...env,PORT:String(webPort)},stdio:'ignore'});
let browser;
async function waitFor(url){for(let i=0;i<120;i++){try{const r=await fetch(url);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error(`Local fixture did not start: ${url}`);}
async function stop(child){if(child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await done;}
function close(a,b){return Math.abs(a-b);}
try{
 await waitFor(`http://127.0.0.1:${apiPort}/v1/community/config`);await waitFor(origin+'/');
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),external=[];
 const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
 if(baseline)await page.route(origin+'/',async route=>route.fulfill({contentType:'text/html',body:await readFile(path.join(evidence,'baseline-index.html'))}));
 await page.goto(origin+'/');await page.waitForFunction(()=>window.SameEndSocial?.snapshot().ready);
 const measurements=[];
 const screenshot=async name=>{await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(evidence,`${baseline?'baseline':'after'}-${name}.png`),fullPage:true});if(name.startsWith('room')||name.startsWith('waiting')||name.startsWith('stopped'))await page.locator('#watch-room').screenshot({path:path.join(evidence,`${baseline?'baseline':'after'}-${name}-crop.png`)});};
 const sizes=[320,390,430,768,1280,1796];
 // Guest home: assert the sections remain available in the normal page flow.
 for(const width of sizes){await page.setViewportSize({width,height:900});
  const box=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth}));
  if(!baseline)assert.ok(box.scroll<=box.w,`guest home horizontal overflow at ${width}px: ${JSON.stringify(box)}`);
  for(const id of ['quick-room','match-extras','club-extras','watch-room','fan-forum','settings'])assert.ok(await page.locator('#'+id).count(),`missing home section #${id}`);
  if(!baseline&&width===320){for(const id of ['match-extras','club-extras','club-create-details','club-join-details','settings'])await page.locator('#'+id).evaluate(d=>d.open=true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Expanded home forms remain within phone width');await screenshot('home-expanded-320');for(const id of ['match-extras','club-extras','club-create-details','club-join-details','settings'])await page.locator('#'+id).evaluate(d=>d.open=false);}
  if(width===320||width===390||width===1280)await screenshot(`home-${width}`);
 }
 // Create a real local private room and three substantial chat messages. This
 // exercises the product DOM and backend while media remains mocked below.
 const invitation=await page.evaluate(()=>SameEndSocial.prepareRoomInvitation());
 await page.waitForFunction(()=>document.body.classList.contains('host-lobby')&&SameEndSocial.snapshot().connected);
 for(const text of [
  'First mate: a long matchday message with enough words to wrap cleanly across a narrow chat panel without pushing the room controls out of place.',
  'Second mate: the away end is singing, the keeper has come up for the corner, and everyone is following the same moment together.',
  'Third mate: after the final whistle we should check the fixture list, set a reminder, and carry on the conversation in the forum.'
 ])await page.evaluate(t=>SameEndSocial.sendChat(t,'Fixture mate'),text);
 await page.waitForFunction(()=>SameEndSocial.snapshot().chatCount>=3);
 const chat=page.locator('#club-chat-shell');await chat.waitFor({state:'visible'});
 await page.locator('#match-extras > summary').click();await page.locator('#club-extras > summary').click();
 await page.locator('#fan-forum').scrollIntoViewIfNeeded();
 const forumOrder=await page.evaluate(()=>{const q=document.querySelector('#quick-room'),f=document.querySelector('#fan-forum');return q&&f&&q.compareDocumentPosition(f)&Node.DOCUMENT_POSITION_FOLLOWING;});
 if(!baseline)assert.ok(forumOrder,'forum follows the quick start section in document flow');
 for(const width of sizes){await page.setViewportSize({width,height:900});
  const state=await page.evaluate(()=>{const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,display:getComputedStyle(e).display,position:getComputedStyle(e).position};};return {width:innerWidth,scroll:document.documentElement.scrollWidth,stage:rect('.stage'),actions:rect('.room-social-actions'),column:rect('.room-picture-column'),layout:rect('.social-watch-layout'),chat:rect('#club-chat-shell'),messages:rect('#club-messages'),forum:rect('#fan-forum'),quick:rect('#quick-room'),input:getComputedStyle(document.querySelector('#club-chat-input')).fontSize,buttons:[...document.querySelectorAll('#watch-room .room-controls button,#watch-room .room-social-actions button')].filter(b=>b.getBoundingClientRect().height>0&&b.getBoundingClientRect().width>0).map(b=>({text:b.innerText,box:b.getBoundingClientRect().height,min:getComputedStyle(b).minHeight})),};});
  measurements.push({kind:'room',...state});
  if(!baseline){
   assert.ok(state.scroll<=width,`room horizontal overflow: ${JSON.stringify(state)}`);
   if(state.stage&&state.actions)assert.ok(state.actions.top-state.stage.bottom<=24,`room actions leave a void below picture: ${JSON.stringify(state)}`);
   assert.ok(state.chat?.width>0&&state.messages?.height>0,`chat is visible and bounded: ${JSON.stringify(state)}`);
   assert.ok(state.input==='16px'||width>760,`mobile chat input should avoid zoom: ${state.input} at ${width}px`);
   assert.ok(state.buttons.every(b=>b.box>=40),`room controls retain touch targets: ${JSON.stringify(state.buttons)}`);
   if(state.forum&&state.quick)assert.ok(state.forum.top>=state.quick.top,`forum remains after quick start: ${JSON.stringify(state)}`);
  }
  if(width===320||width===390||width===430||width===1280||width===1796)await screenshot(`room-${width}`);
 }
 // Use snapshots to show waiting, stopped and picture states without capture
 // permissions or network media. The real host room/chat remains connected.
 const base=await page.evaluate(()=>PrivateCast.snapshot());
 for(const [name,extra] of [
  ['waiting',{config:{id:'responsive-layout-fixture',delay:300,epoch:Date.now()},role:'viewer',sourceReachable:true,clockReady:true,targetProgramTime:-145,programTime:null,ready:0,mediaDiagnostics:{delivery:{requiredPiecePresent:false}},peers:[{ready:true,state:'connected'}]}],
  ['stopped',{config:null,sourceEnded:true,role:'source',peers:[]}],
  ['picture',{config:{id:'responsive-layout-fixture',delay:300,epoch:Date.now()},role:'viewer',clockReady:true,targetProgramTime:0,programTime:0,ready:2,mediaDiagnostics:{delivery:{requiredPiecePresent:true}},peers:[{ready:true,state:'connected'}]}]
 ]){
  await page.evaluate(({base,extra})=>{PrivateCast.snapshot=()=>({...base,...extra});document.body.classList.add('room-active');document.body.classList.toggle('viewer-mode',extra.role==='viewer');dispatchEvent(new Event('sameend:castchange'));window.SameEndWaiting?.refresh();},{base,extra});
  await page.waitForTimeout(100);
  for(const width of [320,390,430,768,1280,1796]){
   await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));
   if(name==='waiting'&&!baseline){await page.locator('.wait-transcript>summary').click();await page.locator('#wait-reading>summary').click();}
   const g=await page.evaluate(()=>{const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};const w=document.querySelector('#sameend-wait');return {intro:rect('#wait-listen'),stage:rect('.stage'),actions:rect('.room-social-actions'),scroll:document.documentElement.scrollWidth,width:innerWidth,waitingVisible:!w.hidden,overflow:getComputedStyle(w).overflowY,nestedScroll:w.scrollHeight>w.clientHeight+1};});
   measurements.push({kind:name,...g});
   if(!baseline){
    assert.ok(g.scroll<=g.width,`${name} horizontal overflow at${width}: ${JSON.stringify(g)}`);
    assert.ok(g.actions.top>=g.stage.bottom&&g.actions.top-g.stage.bottom<=24,`${name} actions overlap or leave a void: ${JSON.stringify(g)}`);
    if(name==='waiting'){assert.equal(g.waitingVisible,true);assert.equal(g.nestedScroll,false,'Guide should use the page rather than clip/scroll inside the picture');assert.ok(g.intro.top>=g.stage.top&&g.intro.bottom<=g.stage.bottom);}
   }
   if(width===390||width===1280)await screenshot(`${name}-${width}`);
   if(name==='waiting'&&!baseline){await page.locator('.wait-transcript>summary').click();await page.locator('#wait-reading>summary').click();}
   if(name==='waiting'&&!baseline&&width===390){
    await page.locator('#room-fullscreen').click();await page.setViewportSize({width:320,height:568});await page.locator('#wait-listen').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#wait-listen').evaluate(b=>{const r=b.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b;}),'Full room audio control stays reachable on a short phone');
    await page.locator('#room-fullscreen').scrollIntoViewIfNeeded();await page.locator('#room-fullscreen').click();
   }
  }
 }
 // Full-room mode may constrain the viewport, but the guide must still be
 // reachable by room scrolling instead of being clipped by the player.
 if(await page.locator('#room-fullscreen').isVisible()){
  await page.locator('#room-fullscreen').click();await page.waitForTimeout(150);
  const fs=await page.evaluate(()=>({active:document.getElementById('watch-room').classList.contains('room-expanded')||document.getElementById('watch-room').classList.contains('is-browser-fullscreen'),scroll:document.documentElement.scrollWidth,width:innerWidth,button:document.querySelector('#room-fullscreen').getBoundingClientRect().toJSON()}));
  if(!baseline)assert.ok(fs.scroll<=fs.width,`fullscreen horizontal overflow: ${JSON.stringify(fs)}`);
  if(!baseline){
   assert.equal(fs.active,true,'Full room opens');
   for(const [width,height] of [[320,568],[390,844],[667,375],[844,390],[1280,800]]){
    await page.setViewportSize({width,height});
    const bounds=await page.evaluate(()=>{const r=document.getElementById('watch-room').getBoundingClientRect(),c=document.getElementById('club-chat-shell').getBoundingClientRect();return{width:innerWidth,height:innerHeight,room:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},chat:{top:c.top,bottom:c.bottom,left:c.left,right:c.right}};});
    assert.ok(bounds.room.top>=-1&&bounds.room.bottom<=height+1&&bounds.room.right<=width+1,`Full room bounds: ${JSON.stringify(bounds)}`);
    assert.ok(await page.locator('#club-messages').evaluate(e=>e.getBoundingClientRect().height>=60),'Full room retains a readable message area');
    assert.ok(bounds.chat.top>=0&&bounds.chat.bottom<=height+1&&bounds.chat.right<=width+1,`Full room chat bounds: ${JSON.stringify(bounds)}`);
    await page.locator('#room-fullscreen').scrollIntoViewIfNeeded();const hit=await page.locator('#room-fullscreen').evaluate(b=>{const r=b.getBoundingClientRect();return{height:r.height,visible:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b};});
    assert.ok(hit.height>=40&&hit.visible,`Full room exit must remain reachable at ${width}x${height}: ${JSON.stringify(hit)}`);
    await screenshot(`fullscreen-${width}`);
   }
   await page.locator('#room-fullscreen').click();
   await page.setViewportSize({width:390,height:844});
  }else await screenshot(`fullscreen-${page.viewportSize().width}`);
 }
 await writeFile(path.join(evidence,`${baseline?'baseline':'after'}-geometry.json`),JSON.stringify(measurements,null,2));
 if(external.length)throw Error(`External requests were attempted: ${external.join(', ')}`);
 assert.deepEqual(pageErrors,[],'full app should have no browser page errors');
 console.log(JSON.stringify({ok:true,baseline,viewports:sizes,roomInvitation:!!invitation,chatMessages:3,states:['waiting','stopped','picture'],screenshots:evidence},null,2));
 if(!baseline){const phone=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});await phone.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const p=await phone.newPage();await p.goto(origin);await p.waitForFunction(()=>SameEndSocial?.snapshot().ready);assert.equal(await p.locator('#capture').isVisible(),false,'Phone hosting control stays hidden');assert.equal(await p.locator('.start-card').isVisible(),false,'Unsupported phone hosting card leaves no empty space');assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:path.join(evidence,'after-phone-home.png'),fullPage:true});await phone.close();}
 await context.close();
}finally{await browser?.close();await stop(web);await stop(api);}
