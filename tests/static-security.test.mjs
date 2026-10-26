// Isolated builds and browser routing: no live provider or production requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,cp,symlink,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(path.join(tmpdir(),'sameend-static-security-'));
const builds={};
for(const mode of ['production','local']){
 const target=path.join(scratch,mode);await cp(sourceRoot,target,{recursive:true,filter:from=>{
  const relative=path.relative(sourceRoot,from),first=relative.split(path.sep)[0];
  return !relative||!['.git','dist','node_modules','privatework','tests','backend','docs'].includes(first);
 }});
 await symlink(path.join(sourceRoot,'node_modules'),path.join(target,'node_modules'),'dir');
 const env={...process.env};delete env.SAME_END_LOCAL;delete env.SAME_END_API_BASE;
 if(mode==='local')env.SAME_END_LOCAL='1';
 execFileSync(process.execPath,['build-pwa.mjs'],{cwd:target,env,stdio:'pipe',timeout:60000});
 builds[mode]=path.join(target,'dist');
}
test.after(()=>rm(scratch,{recursive:true,force:true}));
const pages=['index.html','watch.html','manage.html','fan-signin.html'];
function policy(html){return /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)?.[1];}

test('final static pages carry exact inline hashes and restrictive script/object/base policies',async()=>{
 for(const mode of ['production','local'])for(const file of pages){
  const html=await readFile(path.join(builds[mode],file),'utf8'),csp=policy(html);
  assert.ok(csp,mode+' '+file+' has an actual CSP meta element');
  assert.ok(html.indexOf('http-equiv="Content-Security-Policy"')<html.indexOf('<script'),file+' policy precedes every script');
  const scripts=csp.split(';').find(d=>d.trim().startsWith('script-src '));
  assert.doesNotMatch(scripts,/unsafe-inline|unsafe-eval|https:|data:|blob:/);
  assert.match(csp,/object-src 'none'/);assert.match(csp,/base-uri 'none'/);assert.match(csp,/worker-src 'self' blob:/);assert.match(csp,/media-src 'self' blob:/);
  assert.doesNotMatch(csp,/frame-ancestors/,'meta cannot enforce ancestor restrictions');
  for(const [,attrs,body]of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
   if(!body.trim()||/\bsrc\s*=|id=["']webtorrent-license["']|type=["']application\/json["']/i.test(attrs))continue;
   const digest=createHash('sha256').update(body.replace(/\r\n?/g,'\n')).digest('base64');
   assert.ok(scripts.includes("'sha256-"+digest+"'"),file+' final script hash');
  }
  if(mode==='local')assert.match(csp,/http:\/\/127\.0\.0\.1:\*/);
  else assert.doesNotMatch(csp,/http:|ws:/,'production policy has no insecure service allowances');
 }
});

test('browser enforces CSP while normal boot, lazy bundles, and saved app continue working',async()=>{
 const playwright=await import(process.env.SAMEEND_PLAYWRIGHT||'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
 const engine=process.env.SAMEEND_STATIC_ENGINE||'chromium';assert.ok(['chromium','webkit'].includes(engine));
 const browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const origin='https://www.sameend.com';
 try{
  for(const file of pages){
   const context=await browser.newContext({serviceWorkers:'block'}),errors=[];
   try{
    await context.addInitScript(()=>{window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>cspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));});
    await context.route('**/*',async route=>{
     const u=new URL(route.request().url());
     if(u.pathname==='/csp-probe.js')return route.fulfill({contentType:'text/javascript',body:'window.externalProbeLoaded=true;try{eval("window.evalExecuted=true")}catch(e){window.evalBlocked=e.name==="EvalError"}'});
     if(u.pathname.includes('/v1/community/'))return route.fulfill({json:u.pathname.endsWith('/config')?{adminAuth:{issuer:'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Fixture',domain:'https://fixture.auth.eu-west-2.amazoncognito.com',clientId:'fixtureStaff123',redirectUri:origin+'/manage.html'}}:{items:[]},headers:{'Access-Control-Allow-Origin':origin}});
     try{
      const name=u.pathname.slice(1)||'index.html';
      let body=await readFile(path.join(builds.production,name));
      if(name.endsWith('.html'))body=Buffer.from(body.toString().replace(/<\/body>(?=<\/html>\s*$)/,'<button id="unknown-handler" onclick="window.handlerExecuted=true">Probe</button><script>window.unknownInlineExecuted=true</script></body>'));
      return route.fulfill({body,contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'application/octet-stream'});
     }catch{return route.abort();}
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/'+file);
    await page.locator('#unknown-handler').click();
    if(file==='manage.html')await page.waitForFunction(()=>document.getElementById('session').textContent==='Signed out');
    else if(file==='fan-signin.html')assert.match(await page.locator('#title').textContent(),/You can return/);
    else{
     await page.waitForFunction(()=>SameEndSocial.snapshot().ready&&!!SameEndCommunity&&!!PrivateCast);
     const lazy=await page.evaluate(()=>{
      for(const id of ['magnet-vendor','magnet-module','same-end-hls-capture']){const asset=document.getElementById(id),script=document.createElement('script');script.textContent=asset.textContent;document.head.append(script);script.remove();}
      return {torrent:typeof WebTorrent,transport:typeof CastMagnetTransport,capture:typeof SameEndHLSCapture.createCapture};
     });
     assert.deepEqual(lazy,{torrent:'function',transport:'function',capture:'function'});
     const downloaded=page.waitForEvent('download');await page.locator('#save-app').evaluate(button=>button.click());
     const download=await downloaded,saved=await readFile(await download.path(),'utf8');assert.ok(policy(saved),'saved app preserves its CSP');
     const savedPath=path.join(scratch,'saved-'+file);await writeFile(savedPath,saved);
     const offline=await browser.newContext({serviceWorkers:'block'});
     try{
      await offline.route(/^https?:/,route=>route.abort());
      const reopened=await offline.newPage(),offlineErrors=[];reopened.on('pageerror',e=>offlineErrors.push(e.message));
      await reopened.goto('file://'+savedPath);
      await reopened.waitForFunction(()=>SameEndSocial.snapshot().ready&&!!SameEndCommunity&&!!PrivateCast);
      assert.deepEqual(offlineErrors,[],file+' saved HTML opens offline under its CSP');
     }finally{await offline.close();}
    }
    await page.evaluate(()=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/csp-probe.js';script.onload=resolve;script.onerror=reject;document.head.append(script);}));
    assert.deepEqual(await page.evaluate(()=>({inline:!!window.unknownInlineExecuted,handler:!!window.handlerExecuted,eval:!!window.evalExecuted,evalBlocked:window.evalBlocked,external:window.externalProbeLoaded})),{inline:false,handler:false,eval:false,evalBlocked:true,external:true});
    const violations=await page.evaluate(()=>cspViolations);
    assert.ok(violations.some(v=>v.blocked==='inline'&&v.directive.startsWith('script-src')));
    assert.ok(violations.some(v=>v.blocked==='eval'));
    assert.deepEqual(errors,[],file+' expected scripts boot without page errors');
   }finally{await context.close();}
  }
 }finally{await browser.close();}
});
