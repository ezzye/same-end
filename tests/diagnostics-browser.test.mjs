/* Built-app local diagnostics acceptance: isolated browser and generated demo media. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);let playwright;
try{playwright=require('playwright');}catch{playwright=await import(process.env.SAMEEND_PLAYWRIGHT||'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');}
const origin='http://127.0.0.1:18897',dist=new URL('../dist/',import.meta.url);
const html=(await readFile(new URL('index.html',dist),'utf8')).replace(/"apiBase"\s*:\s*"https:[^"]+"/,'"apiBase":"/api"');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,origin);if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','referrer-policy':'no-referrer'}).end(html);return;}const name=u.pathname.replace(/^\//,'');if(!/^[a-zA-Z0-9._/-]+$/.test(name)||name.includes('..')){res.writeHead(404).end();return;}try{const data=await readFile(new URL(name,dist));res.writeHead(200,{'content-type':mime[name.slice(name.lastIndexOf('.'))]||'application/octet-stream'}).end(data);}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(18897,'127.0.0.1',resolve));
const engine=process.env.SAMEEND_DIAGNOSTICS_ENGINE||'chromium',browser=await playwright[engine].launch({...engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{},headless:true});
const contexts=[],errors=[];
async function newPage(viewport={width:1280,height:900}){const c=await browser.newContext({viewport,serviceWorkers:'block',acceptDownloads:true});contexts.push(c);const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(15000);await p.goto(origin);await p.waitForFunction(()=>window.SameEndSocial?.snapshot().ready);return p;}
try{
 const p=await newPage();await p.locator('#settings > summary').click();await p.locator('#test-log').waitFor({state:'visible'});await p.locator('#test-log > summary').click();
 const enabled=await p.locator('#test-log-record').isChecked();assert.equal(enabled,true,'local logging starts enabled');
 await p.evaluate(()=>PrivateCast.testing.startDemo({delay:10}));await p.waitForFunction(()=>SameEndDiagnostics?.summary()?.durationSeconds>=1);
 await p.locator('#test-log-observation').selectOption('picture-ok');await p.locator('#test-log-mark').click();
 await p.locator('#test-log-observation').selectOption('sound-heard');await p.locator('#test-log-mark').click();
 const before=await p.evaluate(()=>SameEndDiagnostics.report());assert(before.events.some(e=>e.type==='mark'&&e.value==='picture-ok'));assert(before.events.some(e=>e.type==='mark'&&e.value==='sound-heard'));
 await p.locator('#test-log .test-log-body > details > summary').click();
 const secret='MAGNET-SECRET-DO-NOT-EXPORT';await p.evaluate(s=>{window.__testSecrets={castid:PrivateCast.snapshot().config.id,key:s,url:'https://private.invalid/'+s,chat:'PRIVATE-CHAT-SECRET'};},secret);
 const jsonEvent=p.waitForEvent('download');await p.locator('#test-log-json').click();const jsonDownload=await jsonEvent;const report=JSON.parse(await readFile(await jsonDownload.path(),'utf8'));
 const serialized=JSON.stringify(report);const actualCastId=await p.evaluate(()=>PrivateCast.snapshot().config.id);for(const s of [actualCastId,secret,'PRIVATE-CHAT-SECRET','https://private.invalid','"castId"','"key"','peerId','nodeId'])assert(!serialized.includes(s),`JSON excludes ${s}`);
 const htmlEvent=p.waitForEvent('download');await p.locator('#test-log-download').click();const htmlDownload=await htmlEvent;assert.equal(htmlDownload.suggestedFilename(),'same-end-test-report.html');const htmlPath=await htmlDownload.path();const saved=await readFile(htmlPath,'utf8');assert(saved.includes('Same End test report')&&/picture looks good/i.test(saved)&&saved.includes('Share file'));
 const evidence=new URL('../privatework/test-observability-20261023/browser/',import.meta.url);await mkdir(evidence,{recursive:true});const offlineFile=new URL('downloaded-report.html',evidence);await htmlDownload.saveAs(fileURLToPath(offlineFile));
 const offlineContext=await browser.newContext({acceptDownloads:true});contexts.push(offlineContext);const offline=await offlineContext.newPage();offline.on('pageerror',e=>errors.push(e.message));await offline.goto(offlineFile.href);await offline.locator('h1').waitFor();assert.match(await offline.title(),/Same End test report/);assert((await offline.locator('body').innerText()).toLowerCase().includes('picture looks good'));assert((await offline.locator('body').innerText()).includes('Save HTML'));
 const savedAgain=offline.waitForEvent('download');await offline.locator('#save').click();assert.equal((await savedAgain).suggestedFilename(),'same-end-test-report.html');
 // Force the no-native-file-share branch; OS share sheets require a person.
 await offline.evaluate(()=>Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false}));
 const fallback=offline.waitForEvent('download');await offline.locator('#share').click();const fallbackFile=await fallback;assert.equal(fallbackFile.suggestedFilename(),'same-end-test-report.html');assert.match(await offline.locator('#file-status').textContent(),/downloaded; attach it privately/i);
 await p.locator('#test-log-record').uncheck();await p.waitForFunction(()=>SameEndDiagnostics.report()?.finish==='recording-stopped');
 const stopped=await p.evaluate(()=>SameEndDiagnostics.report());assert.equal(stopped.finish,'recording-stopped');
 await p.reload();await p.waitForFunction(()=>window.SameEndDiagnostics?.summary());assert.equal(await p.evaluate(()=>SameEndDiagnostics.report()?.finish),'recording-stopped','finished report survives reload');
 await p.locator('#settings > summary').click().catch(()=>{});if(!await p.locator('#test-log > summary').isVisible()){await p.locator('#settings > summary').click();}await p.locator('#test-log > summary').click();
 await p.locator('#test-log-record').check();await p.waitForTimeout(1200);assert(await p.evaluate(()=>SameEndDiagnostics.summary()),'logging toggle remains usable after reload');
 await p.locator('#test-log .test-log-body details > summary').click();await p.locator('#test-log-clear').click();await p.waitForFunction(()=>!SameEndDiagnostics.summary());assert.match(await p.locator('#test-log-status').textContent(),/logging is off/i);
 await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'phone settings have no horizontal overflow');
 await p.screenshot({path:fileURLToPath(new URL('report-phone.png',evidence)),fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: local marks, generated demo report, JSON secret filtering, offline HTML reopen, HTML share-download fallback, saved report after reload, recording toggle, clear, and 390px overflow.');
}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();await new Promise(resolve=>server.close(resolve));}
