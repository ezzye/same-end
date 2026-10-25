// Actual helper and callback in isolated HTTPS browser routes. No provider or real accounts.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=await import(process.env.SAMEEND_PLAYWRIGHT||'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const origin='https://www.sameend.com', domain='https://sameend-fixture.auth.eu-west-2.amazoncognito.com';
const config={domain,issuer:'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Fixture',clientId:'fixtureClient123',redirectUri:origin+'/fan-signin.html',scope:'sameend-community/use'};
const files=Object.fromEntries(await Promise.all(['fan-auth.js','fan-signin.html','fan-signin.js','fan-signin.css'].map(async n=>[n,await readFile(path.join(root,n),'utf8')])));
const jwt=claims=>Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture-signature';
const checks=[],errors=[];
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
async function fixture({nonceMismatch=false,seconds=300,orphan=false,blocked=false,channels=true}={}){
 const context=await browser.newContext();let authorize,exchanges=[],unexpected=[],logout=0;
 await context.addInitScript(({orphan,blocked,channels})=>{
  window.__writes=[];const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){window.__writes.push([k,v]);return original.call(this,k,v);};
  if(!channels)window.BroadcastChannel=undefined;
  if(orphan&&location.pathname==='/fan-signin.html')window.opener=null;
  if(blocked&&location.pathname==='/room')window.open=()=>null;
 },{orphan,blocked,channels});
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 await context.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin===origin){
   if(u.pathname==='/room')return route.fulfill({contentType:'text/html',body:`<!doctype html><button id="signin">Sign in</button><button id="signout">Sign out</button><canvas id="canvas" width="64" height="64"></canvas><video id="video" autoplay muted></video><script src="/fan-auth.js"></script><script>SameEndFanAuth.configure(${JSON.stringify(config)});window.events=[];SameEndFanAuth.onChange(e=>events.push(e));signin.onclick=()=>{window.outcome='pending';SameEndFanAuth.signIn().then(()=>window.outcome='ok',e=>window.outcome=e.message)};signout.onclick=()=>SameEndFanAuth.signOut();window.stream=canvas.captureStream(10);video.srcObject=stream;window.paint=setInterval(()=>{canvas.getContext('2d').fillStyle='rgb('+Math.floor(Math.random()*255)+',0,0)';canvas.getContext('2d').fillRect(0,0,64,64)},40);</script>`});
   const name=u.pathname.slice(1);if(files[name])return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:files[name]});
  }
  if(u.origin===domain){
   if(u.pathname==='/oauth2/authorize'){authorize=u;return route.fulfill({contentType:'text/html',body:'<!doctype html><p>Isolated account provider</p>'});}
   if(u.pathname==='/logout'){logout++;return route.fulfill({contentType:'text/html',body:'<!doctype html><p>Provider signed out</p>'});}
   if(u.pathname==='/oauth2/token'){
    const body=new URLSearchParams(req.postData());exchanges.push(Object.fromEntries(body));
    assert.equal(req.method(),'POST');assert.equal(req.headers()['referer'],undefined);assert.equal(req.headers()['cookie'],undefined);
    assert.equal(body.get('grant_type'),'authorization_code');assert.equal(body.get('client_id'),config.clientId);assert.equal(body.get('redirect_uri'),config.redirectUri);
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),authorize.searchParams.get('code_challenge'));
    const now=Math.floor(Date.now()/1000),base={iss:config.issuer,sub:'fixture-user',iat:now,exp:now+seconds};
    return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':origin},body:JSON.stringify({access_token:jwt({...base,token_use:'access',client_id:config.clientId,scope:config.scope}),id_token:jwt({...base,token_use:'id',aud:config.clientId,nonce:nonceMismatch?'wrong-nonce':authorize.searchParams.get('nonce'),email_verified:true}),token_type:'Bearer',expires_in:seconds})});
   }
  }
  unexpected.push(req.url());return route.abort();
 });
 const page=await context.newPage();await page.goto(origin+'/room?invite=fixture#watch');
 const parentURL=page.url();
 async function start(){const opened=context.waitForEvent('page');await page.locator('#signin').click();const child=await opened;await child.waitForURL(domain+'/oauth2/authorize?**');assert.equal(authorize.searchParams.get('response_type'),'code');assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');assert.match(authorize.searchParams.get('state'),/^[\w-]{43}$/);assert.match(authorize.searchParams.get('nonce'),/^[\w-]{43}$/);return child;}
 async function callback(child){await child.evaluate(url=>location.assign(url),config.redirectUri+'?code=fixture-code&state='+authorize.searchParams.get('state'));await child.waitForURL(config.redirectUri);}
 async function intact(){assert.equal(page.url(),parentURL);assert.deepEqual(await page.evaluate(()=>({state:stream.getVideoTracks()[0].readyState,muted:stream.getVideoTracks()[0].muted,paused:video.paused})),{state:'live',muted:false,paused:false});for(const p of context.pages()){assert.deepEqual(await p.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage),writes:window.__writes})),{local:[],session:[],writes:[]});}assert.deepEqual(unexpected,[]);}
 return {context,page,start,callback,intact,exchanges,get authorize(){return authorize;},get logout(){return logout;}};
}
try{
 {
  const f=await fixture(),child=await f.start();await f.callback(child);await f.page.waitForFunction(()=>outcome==='ok');
  assert.equal(await f.page.evaluate(()=>SameEndFanAuth.signedIn()),true);assert.match(await f.page.evaluate(()=>SameEndFanAuth.accessToken()),/\.fixture-signature$/);assert.equal(f.exchanges.length,1);
  await child.locator('#title').filter({hasText:'You’re signed in'}).waitFor();assert.equal(child.url(),config.redirectUri);
  // One-use transaction: repeat both supported transports after successful exchange.
  await child.evaluate(state=>{if(opener)opener.postMessage({type:'sameend-fan-code-v1',state,code:'replay'},location.origin);const c=new BroadcastChannel('sameend-fan-'+state);c.postMessage({type:'sameend-fan-code-v1',state,code:'replay'});c.close();},f.authorize.searchParams.get('state'));
  await f.page.waitForTimeout(100);assert.equal(f.exchanges.length,1);await f.intact();
  await f.page.locator('#signout').click();await f.page.waitForFunction(()=>!SameEndFanAuth.signedIn()&&SameEndFanAuth.accessToken()==='');await f.page.waitForTimeout(100);assert.equal(f.logout,1);await f.intact();await f.context.close();checks.push('Actual separate-tab PKCE callback succeeds, scrubs code, keeps captured media live, stores no credentials, ignores replay and signs out without room navigation');
 }
 {
  const f=await fixture(),child=await f.start(),state=f.authorize.searchParams.get('state');
  // Wrong source, a provider-origin sender, and a trusted callback with wrong state must not exchange.
  await f.page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:window,data:{type:'sameend-fan-code-v1',state,code:'wrong-source'}})),state);
  await child.evaluate(({state,origin})=>opener.postMessage({type:'sameend-fan-code-v1',state,code:'wrong-origin'},origin),{state,origin});
  await child.evaluate(url=>location.assign(url),origin+'/fan-signin.html?code=wrong-state&state='+'a'.repeat(43));await child.waitForURL(config.redirectUri);await f.page.waitForTimeout(150);assert.equal(f.exchanges.length,0);assert.equal(await f.page.evaluate(()=>SameEndFanAuth.signedIn()),false);
  await f.page.evaluate(()=>SameEndFanAuth.clearSession());await f.intact();await f.context.close();checks.push('Wrong message origin/source and wrong callback state never exchange a code');
 }
 {
  const f=await fixture({nonceMismatch:true}),child=await f.start();await f.callback(child);await f.page.waitForFunction(()=>outcome!=='pending');assert.notEqual(await f.page.evaluate(()=>outcome),'ok');assert.equal(await f.page.evaluate(()=>SameEndFanAuth.accessToken()),'');assert.equal(f.exchanges.length,1);await f.intact();await f.context.close();checks.push('ID-token nonce mismatch rejects the session');
 }
 {
  const f=await fixture({channels:false}),child=await f.start();await f.callback(child);await f.page.waitForFunction(()=>outcome==='ok',null,{timeout:5000});assert.equal(await child.evaluate(()=>!!opener),true);await f.intact();await f.context.close();checks.push('Callback also succeeds through validated window postMessage with BroadcastChannel unavailable');
 }
 {
  const f=await fixture({orphan:true}),child=await f.start();await f.callback(child);assert.equal(await child.evaluate(()=>opener),null);await f.page.waitForFunction(()=>outcome==='ok');await f.intact();await f.context.close();checks.push('Callback succeeds through BroadcastChannel when opener is null');
 }
 {
  const f=await fixture({seconds:2}),child=await f.start();await f.callback(child);await f.page.waitForFunction(()=>outcome==='ok');const tabs=f.context.pages().length;await f.page.waitForFunction(()=>events.some(e=>e.type==='expired'),null,{timeout:5000});assert.equal(await f.page.evaluate(()=>SameEndFanAuth.accessToken()),'');assert.equal(f.context.pages().length,tabs);assert.equal(f.logout,0);await f.intact();await f.context.close();checks.push('Token expiry clears the session without opening an account tab');
 }
 {
  const f=await fixture({blocked:true});await f.page.locator('#signin').click();await f.page.waitForFunction(()=>outcome!=='pending');assert.match(await f.page.evaluate(()=>outcome),/Allow Same End to open an account tab/);assert.equal(f.context.pages().length,1);assert.equal(f.exchanges.length,0);await f.intact();await f.context.close();checks.push('Blocked popup returns actionable feedback while room URL and capture remain intact');
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',checks,limits:['Isolated mocked provider validates browser transaction handling, not Cognito configuration, signature verification, real-user access or physical-device playback']},null,2));
}finally{await browser.close();}
