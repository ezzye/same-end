// Browser integration uses an isolated Chrome for Testing profile and synthetic public fixtures.
// It never writes to the live club service or the user's normal browser profile.
const {chromium}=await import(process.env.SAME_END_PLAYWRIGHT_MODULE||process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const root=path.resolve('.'),profile=await fs.mkdtemp(path.join(os.tmpdir(),'sameend-reader-')),evidence=path.resolve('../work/browser-extension');let context;
const launch=()=>chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
const fixture={id:'bbc:private-local-test',title:'PRIVATE LOCAL TEST v Family',home:'PRIVATE LOCAL TEST',away:'Family',competition:'Local test',startsAt:Date.now()+3600000,status:'scheduled',tv:[{country:'GB',channel:'Local Test Channel'}],sourceUrl:'https://www.bbc.co.uk/sport/football/teams/aston-villa/scores-fixtures',sourceName:'BBC',checkedAt:Date.now()};
let requests=[],errors=[];const downloadText=async download=>fs.readFile(await download.path(),'utf8');
try{
context=await launch();let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
await context.route('**/*',async route=>{const req=route.request();requests.push({url:req.url(),method:req.method(),body:req.postData()});const u=new URL(req.url());if(u.protocol==='chrome-extension:'){await route.continue();return}if(u.origin==='https://www.sameend.com'){
if(u.pathname==='/'||u.pathname==='/watch.html'){await route.fulfill({status:200,contentType:'text/html',body:await fs.readFile('dist/watch.html')});return}
if(['/sw.js','/manifest.webmanifest','/icon-192.png','/icon-512.png'].includes(u.pathname)){await route.fulfill({status:200,body:await fs.readFile('dist'+u.pathname),contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.png')?'image/png':'application/json'});return}
}await route.abort();});
const popup=await context.newPage();popup.on('pageerror',e=>errors.push(e.message));await popup.goto(`chrome-extension://${id}/popup.html`);
const send=(action,payload={})=>popup.evaluate(async q=>chrome.runtime.sendMessage({type:'SE_LOCAL',...q}),{action,...payload});
assert.equal((await send('SAVE',{matches:[fixture]})).ok,true);
const alarms=await worker.evaluate(()=>chrome.alarms.getAll());assert.ok(alarms.some(a=>a.name.includes('private-local-test')),'alarm registered');
// The seeded record goes through the real worker; page extraction is tested separately.
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://www.sameend.com/watch.html?local=1');
await page.locator('#personal-listings').waitFor();await page.waitForFunction(()=>document.querySelector('#personal-listings button')?.textContent==='Connect my local matches');
assert.equal(await page.locator('#personal-listings .pl-match').count(),0,'not exposed before connection');
const rejected=await page.evaluate(()=>new Promise(resolve=>{const id='untrusted';const fn=e=>{if(e.data?.type==='SAMEEND_LOCAL_RESPONSE'&&e.data.id===id){removeEventListener('message',fn);resolve(e.data)}};addEventListener('message',fn);postMessage({type:'SAMEEND_LOCAL_REQUEST',id,action:'CONNECT'},location.origin)}));assert.equal(rejected.ok,false,'forged gesture rejected');
await page.getByRole('button',{name:'Connect my local matches',exact:true}).click();await page.getByText('PRIVATE LOCAL TEST v Family',{exact:true}).waitFor();
assert.equal(await page.getByText('Local Test Channel',{exact:true}).count(),1);

const downloadWait=page.waitForEvent('download');await page.getByRole('button',{name:'Add all to calendar',exact:true}).click();const ics=await downloadText(await downloadWait);assert.match(ics,/BEGIN:VEVENT/);assert.match(ics,/TRIGGER:-PT15M/);assert.match(ics,/PRIVATE LOCAL TEST v Family/);
await page.locator('#personal-listings input[type=checkbox]').click();await page.waitForTimeout(200);assert.equal((await send('GET')).settings.remindersEnabled,false);
await page.locator('#personal-listings input[type=checkbox]').click();await popup.locator('#minutes').selectOption('5');await popup.waitForFunction(()=>state?.settings.reminderMinutes===5);assert.equal((await send('GET')).settings.reminderMinutes,5);
await page.screenshot({path:path.join(evidence,'local-matches-browser.png'),fullPage:true});
const popupDownload=popup.waitForEvent('download');await popup.getByRole('button',{name:'Add all to calendar',exact:true}).click();assert.match(await downloadText(await popupDownload),/TRIGGER:-PT5M/);
await popup.getByRole('button',{name:'Open Same End',exact:true}).click();await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('Same End opened')); 
const noUploads=()=>requests.every(r=>!JSON.stringify(r).includes('PRIVATE LOCAL TEST')&&!JSON.stringify(r).includes('Local Test Channel')&&!r.url.includes('/v1/clubs'));
assert.ok(noUploads(),'no listing data in network requests');
await context.close();context=await launch();worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const reopened=await context.newPage();await reopened.goto(`chrome-extension://${id}/popup.html`);const persisted=await reopened.evaluate(()=>chrome.runtime.sendMessage({type:'SE_LOCAL',action:'GET'}));assert.equal(persisted.matches.length,1);assert.equal(persisted.settings.reminderMinutes,5);
// Cancelled updates remove existing alarms and calendar alarm, keeping the same fixture ID.
const cancelled=await reopened.evaluate(m=>chrome.runtime.sendMessage({type:'SE_LOCAL',action:'SAVE',matches:[m]}),{...fixture,status:'cancelled',checkedAt:Date.now()});assert.equal(cancelled.matches[0].status,'cancelled');assert.equal((await worker.evaluate(()=>chrome.alarms.getAll())).filter(a=>a.name.startsWith('sameend-local:')).length,0);
assert.deepEqual(errors,[]);
await fs.writeFile(path.join(evidence,'browser-evidence.json'),JSON.stringify({checkedAt:new Date().toISOString(),browser:context.browser()?.version(),extensionId:id,checks:['real MV3 worker','local storage persistence across browser restart','connection gesture required','Same End local display','country TV display','calendar batch downloads from website and popup','settings update','alarm scheduled and cancelled','no fixture data in network requests'],notVerified:['physical Windows device','OS notification banner','calendar application import','browser toolbar activeTab grant'],requests:requests.map(r=>({url:r.url.replace(/#.*/,''),method:r.method})),errors},null,2));
console.log('PASS local reader worker, website, privacy, calendar and persistence');
}finally{await context?.close();await fs.rm(profile,{recursive:true,force:true})}
