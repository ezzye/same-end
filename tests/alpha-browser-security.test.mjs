import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const {chromium}=await import(process.env.SAMEEND_PLAYWRIGHT||'/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const origin='https://alpha-browser.test';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
test.after(()=>browser.close());

test('obsolete private-club joins cannot reopen after close, a newer selection, or a new invitation',async()=>{
 const source=await readFile(new URL('social.js',root),'utf8');
 for(const mode of ['close','newer-selection','new-invitation']){
  const context=await browser.newContext();
  try{
   const page=await context.newPage(); let release,requested,envelopes,held=false;
   const requestSeen=new Promise(r=>requested=r);
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><section id="club-social"></section><script>window.SameEndConfig={apiBase:location.origin};window.SameEndFixtures=[]</script><script src="/social.js"></script>'});
    if(u.pathname==='/social.js')return route.fulfill({contentType:'text/javascript',body:source});
    if(u.pathname.endsWith('/messages'))return route.fulfill({json:{messages:[],cursor:''}});
    if(u.pathname.startsWith('/v1/clubs/')){
     const id=u.pathname.split('/')[3];
     if(id.endsWith('12')&&!held){held=true;release=()=>route.fulfill({json:{state:envelopes.a,version:1}});requested();return;}
     return route.fulfill({json:{state:id.endsWith('12')?envelopes.a:envelopes.b,version:1}});
    }
    return route.abort();
   });
   await page.goto(origin);await page.waitForFunction(()=>SameEndSocial.snapshot().ready);
   envelopes=await page.evaluate(async()=>{
    const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const bytes=new Uint8Array(32).fill(7),secret=b64(bytes);
    window.fixtureClub={id:'12345678-1234-4234-8234-123456789012',secret};
    window.fixtureB={id:'12345678-1234-4234-8234-123456789013',secret};
    async function envelope(club,name){
     const iv=crypto.getRandomValues(new Uint8Array(12)),aes=await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt']);
     const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('sameend/state/v1/'+club.id)},aes,new TextEncoder().encode(JSON.stringify({schema:1,name,theme:'terrace',events:[]}))));
     return {v:1,iv:b64(iv),data:b64(cipher)};
    }
    return {a:await envelope(fixtureClub,'Private club A'),b:await envelope(fixtureB,'Private club B')};
   });
   await page.evaluate(()=>{window.joinOutcome=SameEndSocial.joinClub(fixtureClub,{save:true}).then(()=>true,e=>e.message);});
   await requestSeen;
   if(mode==='close')await page.evaluate(()=>SameEndSocial.closeClub());
   if(mode==='newer-selection')await page.evaluate(()=>SameEndSocial.joinClub(fixtureB));
   if(mode==='new-invitation'){
    await page.evaluate(()=>{location.hash='club='+fixtureB.id+'.'+fixtureB.secret;});
    await page.waitForFunction(()=>!location.hash&&!document.getElementById('club-pending-info').hidden);
   }
   await release();
   assert.match(await page.evaluate(()=>joinOutcome),/cancelled/,mode+' invalidates the old join');
   assert.equal(await page.evaluate(()=>SameEndSocial.snapshot().id),mode==='newer-selection'?'12345678-1234-4234-8234-123456789013':null);
   if(mode==='new-invitation'){
    assert.equal(await page.locator('#club-join-submit').isEnabled(),true);
    await page.locator('#club-join-submit').click();
    await page.waitForFunction(()=>SameEndSocial.snapshot().id===fixtureB.id);
   }
  }finally{await context.close();}
 }
});

test('pagehide cancels a pending staff callback, including after BFCache restoration',async()=>{
 const context=await browser.newContext();
 try{
  const auth={issuer:'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Fixture',domain:'https://fixture.auth.eu-west-2.amazoncognito.com',clientId:'fixtureStaff123',redirectUri:origin+'/manage.html'};
  const tx={state:'S'.repeat(43),verifier:'V'.repeat(43),nonce:'N'.repeat(43),createdAt:Date.now(),redirectUri:auth.redirectUri};
  await context.addInitScript(tx=>sessionStorage.setItem('sameend.staff.pkce.v1',JSON.stringify(tx)),tx);
  const files=Object.fromEntries(await Promise.all(['manage.html','manage.js','staff-mfa.js','manage.css','staff-mfa.css'].map(async name=>[name,await readFile(new URL(name,root),'utf8')])));
  let release,seen;const tokenSeen=new Promise(r=>seen=r);
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type,x-amz-target'}});
   const headers={'Access-Control-Allow-Origin':origin};
   if(u.origin===origin&&files[u.pathname.slice(1)])return route.fulfill({contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'text/html',body:files[u.pathname.slice(1)].replace('__SAME_END_CONFIG__',JSON.stringify({apiBase:origin}))});
   if(u.pathname.endsWith('/config'))return route.fulfill({json:{adminAuth:auth}});
   if(u.pathname==='/oauth2/token'){release=()=>{
    const now=Math.floor(Date.now()/1000),claims={iss:auth.issuer,aud:auth.clientId,nonce:tx.nonce,token_use:'id',sub:'fixture-staff',iat:now,exp:now+300,'cognito:groups':['sameend-support']};
    const token='eyJhbGciOiJSUzI1NiJ9.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture-signature';
    return route.fulfill({headers,json:{id_token:token,access_token:'fixture-access'}});
   };seen();return;}
   if(req.headers()['x-amz-target'])return route.fulfill({headers,json:{UserMFASettingList:['SOFTWARE_TOKEN_MFA']}});
   if(u.pathname.endsWith('/admin/feedback'))return route.fulfill({json:{items:[]}});
   return route.abort();
  });
  const page=await context.newPage();await page.goto(auth.redirectUri+'?code=fixture-code&state='+tx.state);
  await tokenSeen;
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  assert.equal(await page.locator('#desk').isVisible(),false);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await release();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#desk').isVisible(),false,'The old callback cannot activate on a restored page');
  assert.equal(await page.locator('#session').textContent(),'Signed out');
  assert.equal(await page.locator('#panel').textContent(),'');
 }finally{await context.close();}
});

test('staff thread detail merges every reply page, continues empty pages, and drops late pages on sign-out',async()=>{
 const context=await browser.newContext();
 try{
  const localOrigin='http://localhost:18999',threadId='12345678-1234-4234-8234-123456789012';
  const files=Object.fromEntries(await Promise.all(['manage.html','manage.js','staff-mfa.js','manage.css','staff-mfa.css'].map(async name=>[name,await readFile(new URL(name,root),'utf8')])));
  const thread={id:threadId,title:'Audit thread',text:'Thread text',category:'general',authorId:'staff-fixture',authorName:'Staff',createdAt:1,version:1,replyCount:45};
  const reply=n=>({id:'reply-'+String(n).padStart(3,'0'),text:'Reply '+n,authorId:'fan-fixture',authorName:'Fan',createdAt:n*1000,version:1});
  const range=(from,to)=>Array.from({length:to-from+1},(_,i)=>reply(from+i));
  let holdNext=false,release,heldResolve;const held=new Promise(resolve=>heldResolve=resolve);
  const requests=[];
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url()),name=u.pathname.slice(1);
   if(files[name])return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:files[name].replace('__SAME_END_CONFIG__',JSON.stringify({apiBase:localOrigin}))});
   if(u.pathname.endsWith('/config'))return route.fulfill({json:{}});
   if(u.pathname.endsWith('/admin/feedback'))return route.fulfill({json:{items:[]}});
   if(u.pathname.endsWith('/admin/threads'))return route.fulfill({json:{items:[thread]}});
   if(u.pathname.endsWith('/admin/threads/'+threadId)){
    const cursor=u.searchParams.get('cursor');requests.push(cursor);
    const page=cursor==='one'?{replies:[{...reply(20),text:'Reply 20 updated'},...range(21,39)],cursor:'two'}:cursor==='two'?{replies:[],cursor:'three'}:cursor==='three'?{replies:range(40,45),cursor:null}:{replies:range(1,20),cursor:'one'};
    const response={thread,...page,pageReplyIds:page.replies.map(r=>r.id),replyCount:45};
    if(cursor==='one'&&holdNext){holdNext=false;release=()=>route.fulfill({json:{...response,replies:[{...reply(21),text:'Private late reply'}]}});heldResolve();return;}
    return route.fulfill({json:response});
   }
   if(u.pathname.endsWith('/community-starters.json'))return route.fulfill({json:{items:[]}});
   return route.abort();
  });
  const page=await context.newPage();await page.goto(localOrigin+'/manage.html');
  await page.locator('#review-token').fill('isolated-review-fixture');await page.locator('#review-signin button').click();
  await page.getByRole('button',{name:'Forum',exact:true}).click();await page.getByRole('button',{name:'Audit thread',exact:true}).click();
  const more=page.getByRole('button',{name:'Load more replies',exact:true});
  await more.waitFor({state:'visible'});assert.equal(await page.locator('#panel .body').count(),21);
  await more.click();await page.waitForFunction(()=>document.querySelectorAll('#panel .body').length===40);assert.equal(await page.locator('#panel .body').count(),40);
  assert.equal(await page.getByText('Reply 20 updated',{exact:true}).count(),1);assert.equal(await page.getByText('Reply 20',{exact:true}).count(),0);
  await more.click();assert.equal(await more.isVisible(),true,'empty source batches preserve their continuation');
  await more.click();await more.waitFor({state:'hidden'});assert.equal(await more.isVisible(),false);
  const texts=await page.locator('#panel .body').allTextContents();assert.equal(texts.length,46);assert.equal(new Set(texts).size,46);assert.equal(texts.at(-1),'Reply 45');
  assert.deepEqual(requests,[null,'one','two','three']);
  await page.getByRole('button',{name:'← Back to threads',exact:true}).click();await page.getByRole('button',{name:'Audit thread',exact:true}).click();
  await more.waitFor({state:'visible'});holdNext=true;await more.click();await held;await page.locator('#signout').click();await release();
  await page.waitForTimeout(80);assert.equal(await page.locator('#desk').isVisible(),false);assert.equal(await page.locator('#panel').textContent(),'');assert.equal(await page.getByText('Private late reply',{exact:true}).count(),0);
 }finally{await context.close();}
});
