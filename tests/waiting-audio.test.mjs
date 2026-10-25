import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

test('waiting introduction is chosen explicitly, decodes, and yields without writing match playback',async t=>{
  let chromium;
  try{({chromium}=await import(process.env.SAMEEND_PLAYWRIGHT||path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));}
  catch(error){if(process.env.SAMEEND_REQUIRE_BROWSER==='1')throw error;t.skip('Browser runtime unavailable on this host.');return;}
  const root=new URL('../',import.meta.url),audio=await readFile(new URL('assets/same-end-intro.m4a',root));
  assert.ok(audio.byteLength<100000);
  const scripts=(await readFile(new URL('waiting-core.js',root),'utf8'))+'\n'+await readFile(new URL('waiting.js',root),'utf8');
  const css=await readFile(new URL('waiting.css',root),'utf8');
  const requests=[],pack={revision:'fixture',items:[{id:'a',type:'story',title:'Optional reading',body:'This text stays optional.'}]};
  const fixture=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}.stage{width:100%;min-height:520px}video{width:100%}${css}</style><div class="stage"><video id="player"></video></div><script>
    window.__snapshot={config:{},clockReady:true,targetProgramTime:-60,programTime:null,ready:0,sourceReachable:true};window.__hidden=false;window.__writes=0;
    Object.defineProperty(document,'hidden',{get:()=>window.__hidden});
    const match=document.getElementById('player');match.play=()=>{window.__writes++;return Promise.resolve()};match.pause=()=>window.__writes++;
    for(const key of ['currentTime','muted','volume'])Object.defineProperty(match,key,{get:()=>0,set:()=>window.__writes++});
    window.PrivateCast={snapshot:()=>window.__snapshot};window.SameEndSocial={snapshot:()=>({connected:true})};
    window.SameEndRoomStatus={explain:()=>({code:'finding-route',title:'Finding the picture',detail:'Your room stays open.'})};
  </script><script>${scripts}</script>`;
  const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url==='/same-end-intro.m4a'){res.writeHead(200,{'Content-Type':'audio/mp4','Content-Length':audio.byteLength});res.end(audio);}else if(req.url==='/api/v1/community/content'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(pack));}else{res.setHeader('Content-Type','text/html');res.end(fixture);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(origin);
    await page.locator('#sameend-wait').waitFor({state:'visible'});
    assert.equal(await page.locator('#wait-intro-audio').getAttribute('src'),null);assert.ok(!requests.includes('/same-end-intro.m4a'));assert.ok(!requests.includes('/api/v1/community/content'));
    await page.getByRole('button',{name:'Play quick guide',exact:true}).click();
    await page.waitForFunction(()=>{const a=document.getElementById('wait-intro-audio');return !a.paused&&a.currentTime>.15&&a.duration>20&&a.duration<30;});
    assert.ok(requests.includes('/same-end-intro.m4a'));
    await page.getByRole('button',{name:'Pause quick guide',exact:true}).click();assert.equal(await page.locator('#wait-intro-audio').evaluate(a=>a.paused),true);
    await page.getByRole('button',{name:'Play quick guide',exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('wait-intro-audio').paused);
    await page.evaluate(()=>{window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await page.locator('#wait-intro-audio').getAttribute('src'),null);assert.equal(await page.locator('#wait-intro-audio').evaluate(a=>a.paused),true);
    await page.evaluate(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await page.locator('#wait-intro-audio').getAttribute('src'),null);
    await page.getByRole('button',{name:'Play quick guide',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('wait-intro-audio').paused);
    await page.getByRole('button',{name:'Hide guide',exact:true}).click();assert.equal(await page.locator('#wait-intro-audio').getAttribute('src'),null);
    await page.getByRole('button',{name:'Show guide',exact:true}).click();assert.equal(await page.locator('#wait-intro-audio').getAttribute('src'),null);
    await page.locator('#wait-reading>summary').click();await page.getByText('This text stays optional.',{exact:true}).waitFor();
    assert.equal(requests.filter(x=>x==='/api/v1/community/content').length,1);
    await page.getByRole('button',{name:'Play quick guide',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('wait-intro-audio').paused);
    await page.evaluate(()=>{Object.assign(window.__snapshot,{targetProgramTime:10,programTime:10,ready:2,mediaDiagnostics:{delivery:{requiredPiecePresent:true}}});window.SameEndWaiting.refresh();});
    assert.equal(await page.locator('#sameend-wait').isVisible(),false);assert.equal(await page.locator('#wait-intro-audio').getAttribute('src'),null);
    assert.equal(await page.evaluate(()=>window.__writes),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
