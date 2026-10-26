// Isolated local browser regression for bounded reply pages and client merging.
// All identities, text, accounts and media are fixtures; no external APIs are used.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {LocalFileStore} from '../backend/local-file-store.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=process.env.SAMEEND_PLAYWRIGHT||path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {chromium}=await import(runtime);
const evidenceDir=path.join(root,'privatework/community-pagination-browser');await mkdir(evidenceDir,{recursive:true});
const temp=await mkdtemp(path.join(tmpdir(),'sameend-community-pagination-'));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const webPort=await freePort(),apiPort=await freePort(),origin='http://127.0.0.1:'+webPort,apiOrigin='http://127.0.0.1:'+apiPort;
execFileSync(process.execPath,['build-pwa.mjs'],{cwd:root,env:{...process.env,SAME_END_LOCAL:'1'},stdio:'ignore'});
const credential=randomBytes(32).toString('base64url'),pilot='pagination-fixture-pilot',hash=createHash('sha256').update(credential).digest('hex');
const apiEnv={...process.env,PORT:String(apiPort),SAME_END_LOCAL_WEB_PORT:String(webPort),SAME_END_LOCAL_STATE_FILE:path.join(temp,'state.json'),SAME_END_LOCAL_ADMIN_TOKEN_HASH:hash};
const startAPI=()=>spawn(process.execPath,['tests/helpers/community-account-server.mjs'],{cwd:root,env:apiEnv,stdio:'ignore'});
let api=startAPI();const web=spawn(process.execPath,['serve.mjs'],{cwd:root,env:{...process.env,PORT:String(webPort),SAME_END_LOCAL_API_PORT:String(apiPort)},stdio:'ignore'});
async function waitServer(){for(let i=0;i<120;i++){try{const r=await fetch(apiOrigin+'/v1/community/config');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Local community API did not start.');}
async function stop(child){if(child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await done;}
const external=[],errors=[],threadReads=[];let browser;
const threadId=randomUUID(),rootId='00000000-0000-4000-8000-000000000099',nestedId='00000000-0000-4000-8000-000000000001',topLevelIds=[];
const marker=i=>`Pagination fixture reply ${String(i).padStart(2,'0')}`;
async function request(pathname,{method='GET',body}={}){const response=await fetch(apiOrigin+'/v1/community/member'+pathname,{method,headers:{authorization:'Bearer fixture-account-alice','content-type':'application/json',origin},...(body?{body:JSON.stringify(body)}:{})});let json;try{json=await response.json()}catch{}assert.ok(response.ok,`${method} ${pathname} failed (${response.status} ${json?.code||'no code'})`);return json;}
async function seen(page,locator){await locator.waitFor({state:'visible',timeout:10000});}
async function openForum(page){await seen(page,page.locator('#fan-forum'));if(await page.locator('#ff-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#ff-toggle').click();await seen(page,page.locator('#ff-body'));}
async function signIn(page){await openForum(page);const guest=page.getByRole('button',{name:'Sign in / Create account',exact:true});if(await guest.isVisible()){await guest.click();await seen(page,page.getByRole('button',{name:'Sign out',exact:true}));}}
async function join(page){await signIn(page);await page.getByRole('button',{name:'Join the conversation',exact:true}).first().click();await seen(page,page.locator('#fc-code'));await page.locator('#fc-name').fill('Pagination Reader');await page.locator('#fc-code').fill(pilot);await page.locator('#fc-agree').check();await page.getByRole('button',{name:'Join and start posting',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ff-me-name')?.textContent.includes('Posting as'));}
async function waitThreadReadCount(n){for(let i=0;i<200;i++){if(threadReads.length>=n)return;await new Promise(r=>setTimeout(r,25));}throw Error(`Expected ${n} thread page reads; observed ${threadReads.length}.`);}
function rowIds(page){return page.locator('.ff-comments .ff-c[id^="ff-c-"]');}
try{
 await waitServer();browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const context=await browser.newContext({viewport:{width:1280,height:980}});
 await context.addInitScript(token=>{let current=null,changed=[];const auth={config:null,configure(value){auth.config=value;},signIn(){current=token;changed.forEach(fn=>fn({type:'signed-in'}));return Promise.resolve();},signOut(){current=null;changed.forEach(fn=>fn({type:'signed-out'}));return Promise.resolve();},clearSession(){current=null;changed.forEach(fn=>fn({type:'signed-out'}));},signedIn(){return !!current;},accessToken(){return current;},onChange(fn){changed.push(fn);return()=>{changed=changed.filter(x=>x!==fn);};}};Object.defineProperty(window,'SameEndFanAuth',{configurable:false,get(){return auth;},set(_value){}});},'fixture-account-alice');
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack||e.message));page.on('response',async response=>{try{const u=new URL(response.url());if(u.origin===origin&&u.pathname.endsWith('/threads/'+threadId)&&response.request().method()==='GET')threadReads.push(await response.json());}catch{}});
 // Enable a private pilot through the real local staff UI.
 await page.goto(origin+'/manage.html');await page.locator('#review-token').fill(credential);await page.getByRole('button',{name:'Enter local review',exact:true}).click();await seen(page,page.locator('#desk'));
 await page.locator('#sections').getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Set or rotate pilot joining code').fill(pilot);await page.getByLabel('Allow forum membership and discussion').check();await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice')?.textContent.includes('Forum settings saved'));
 // Join through the browser, then seed the actual API with an ordered 45-reply thread.
 await page.goto(origin+'/');await join(page);
 await request('/threads',{method:'POST',body:{id:threadId,category:'general',title:'Forty-five reply pagination fixture',text:'A private local thread for page and merge checks.',spoiler:false}});
 // Seed source rows while the local API is stopped: its real per-fan write cap
 // is 20/minute, while this read fixture deliberately needs 45 source rows.
 await stop(api);let fixtureStore=await LocalFileStore.open(apiEnv.SAME_END_LOCAL_STATE_FILE);
 try{
  const pk='COMMUNITY#PILOT',fanRows=await fixtureStore.query(pk,{from:'FAN#',to:'FAN#\uffff',limit:200}),fan=fanRows.find(row=>row.name==='Pagination Reader'&&row.forumMember);
  assert.ok(fan,'browser membership should have created the fixture fan');const thread=await fixtureStore.get(pk,`THREAD#${threadId}`);assert.ok(thread);
  const created=Date.now()+1000;
  for(let i=1;i<=44;i++){
   const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0');if(i>1)topLevelIds.push(id);
   await fixtureStore.put({pk,sk:`REPLY#${threadId}#${id}`,id,threadId,parentId:i===1?rootId:null,depth:i===1?2:1,text:marker(i),authorId:fan.id,authorName:fan.name,hidden:false,deleted:false,createdAt:created+i,version:1,rev:randomUUID(),expiresAt:Math.floor((created+365*86400000)/1000)});
  }
  await fixtureStore.put({pk,sk:`REPLY#${threadId}#${rootId}`,id:rootId,threadId,parentId:null,depth:1,text:'Pagination root full text must replace its earlier context placeholder.',authorId:fan.id,authorName:fan.name,hidden:false,deleted:false,createdAt:created,version:1,rev:randomUUID(),expiresAt:Math.floor((created+365*86400000)/1000)});
  await fixtureStore.put({...thread,replyCount:45,updatedAt:created+45,version:(thread.version||1)+1,rev:randomUUID()});
 }finally{await fixtureStore.close();}
 api=startAPI();await waitServer();
 assert.equal((await request(`/threads/${threadId}`)).replyCount,45);
 await page.evaluate(()=>window.SameEndCommunity.refresh());await page.waitForFunction(title=>[...document.querySelectorAll('#ff-view button')].some(b=>b.textContent.includes(title)),'Forty-five reply pagination fixture');
 await page.getByRole('button',{name:/Forty-five reply pagination fixture/}).click();await waitThreadReadCount(1);
 const first=threadReads[0];assert.equal(first.pageReplyIds.length,20);assert.ok(first.cursor,'a full first source page should expose a cursor');assert.equal(first.replyCount,45);assert.ok(first.replies.some(r=>r.id===rootId&&r.context===true),'first-page nested child needs an ancestor context placeholder');assert.ok(!first.pageReplyIds.includes(rootId),'root source row must arrive on a later page');
 const contextRow=page.locator('#ff-c-'+rootId);await seen(page,contextRow);assert.equal(await contextRow.getAttribute('data-context'),'true');assert.ok(await contextRow.getAttribute('class').then(x=>x.includes('ff-c-context')));const contextText=await contextRow.locator(':scope > .ff-c-row').innerText();assert.match(contextText,/Earlier comment/);assert.match(contextText,/Load more comments to read this earlier reply/);assert.ok(!contextText.includes('Pagination root full text'));assert.ok(!contextText.includes('Pagination Reader'),'context placeholder has no actual author name');assert.equal(await contextRow.locator(':scope > .ff-c-row > .ff-c-body .ff-c-actions, :scope > .ff-c-row > .ff-c-body .ff-meta-btn, :scope > .ff-c-row > .ff-c-body .ff-menu-wrap, :scope > .ff-c-row > .ff-c-body [data-like], :scope > .ff-c-row > .ff-c-body form.ff-reply-nested').count(),0,'context row has no like, reply, moderation or menu actions');
 // Three source pages (20 + 20 + 5) must remain reachable and merge by ID.
 const allSourceIds=new Set(first.pageReplyIds);let pageCount=1;
 while(await page.getByRole('button',{name:'Load more comments',exact:true}).count()){
  await page.getByRole('button',{name:'Load more comments',exact:true}).click();pageCount++;await waitThreadReadCount(pageCount);
  const data=threadReads[pageCount-1];for(const id of data.pageReplyIds){assert.ok(!allSourceIds.has(id),'reply source row repeated across pages: '+id);allSourceIds.add(id);}
  assert.equal(data.replyCount,45);
 }
 assert.equal(pageCount,3,'45 source rows should require exactly three pages');assert.equal(allSourceIds.size,45);assert.equal(threadReads[1].pageReplyIds.length,20);assert.equal(threadReads[2].pageReplyIds.length,5);assert.equal(threadReads[2].cursor,null);
 await page.waitForFunction(({id,text})=>{const row=document.getElementById('ff-c-'+id);return row&&row.getAttribute('data-context')==='false'&&row.textContent.includes(text);},{id:rootId,text:'Pagination root full text must replace its earlier context placeholder.'});
 assert.equal(await page.locator('#ff-c-'+rootId).getAttribute('data-context'),'false');assert.equal(await page.locator('#ff-c-'+rootId).locator('.ff-c-actions button').count()>0,true,'loaded full reply regains normal member actions');
 const domIds=await rowIds(page).evaluateAll(rows=>rows.map(row=>row.id.slice('ff-c-'.length)));assert.equal(new Set(domIds).size,domIds.length,'merged comment tree has no duplicate IDs');assert.equal(domIds.length,45,'all source replies and the merged root should be present');assert.equal(await page.getByRole('button',{name:'Load more comments',exact:true}).count(),0,'no Load more control remains after final page');
 // Delete a previously loaded leaf and use the UI reset to ensure old pages/text are dropped.
 const deletedId=topLevelIds[0],deletedText=marker(2);assert.ok(domIds.includes(deletedId));await request('/posts/delete',{method:'POST',body:{threadId,postId:deletedId,expectedVersion:1}});
 await page.getByRole('button',{name:'Refresh discussion',exact:true}).click();await waitThreadReadCount(4);const refreshed=threadReads[3];assert.ok(refreshed.pageReplyIds.includes(deletedId),'refresh should still account for the source row examined');assert.ok(!refreshed.replies.some(r=>r.id===deletedId&&!r.context),'deleted leaf must be omitted from refreshed visible rows');
 await page.waitForFunction(id=>!document.getElementById('ff-c-'+id),deletedId);assert.equal(await page.getByText(deletedText,{exact:true}).count(),0,'refetch removes the previously loaded deleted reply text');assert.equal(await page.getByText(marker(44),{exact:true}).count(),0,'reset to first page drops rows from old later pages');assert.equal(await page.getByRole('button',{name:'Load more comments',exact:true}).count(),1,'refetched first page retains its continuation');
 await page.route(`**/api/v1/community/member/threads/${threadId}*`,route=>route.request().method()==='GET'?route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'thread_not_found'})}):route.continue());
 await page.getByRole('button',{name:'Refresh discussion',exact:true}).click();await seen(page,page.getByText('This discussion is no longer available.',{exact:true}));assert.equal(await rowIds(page).count(),0,'authoritative thread_not_found clears all previously loaded reply pages');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS: three bounded reply pages; unique source IDs; generic no-action context; context replaced by full ancestor row; refresh drops deleted and prior-page content.');
} finally {await browser?.close();await stop(api);await stop(web);await rm(temp,{recursive:true,force:true});}
