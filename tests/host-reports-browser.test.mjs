/* Built-app report acceptance: real invite flow, local HTTP API and isolated memory backend. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import { createRequire } from 'node:module';
import { createApi } from '../backend/api.mjs';
import { MemoryStore } from '../backend/store.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = await import(process.env.SAMEEND_PLAYWRIGHT || '/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'); }

const origin = 'http://127.0.0.1:18896', dist = new URL('../dist/', import.meta.url);
const html = (await readFile(new URL('index.html', dist), 'utf8')).replace(/"apiBase"\s*:\s*"https:[^"]+"/, '"apiBase":"/api"');
const store = new MemoryStore(), api = createApi({store, push: {enabled: false}, allowedOrigins: [origin]});
const requests = []; let failNextReport = false, wrongNextReceipt = false, failClubRead = false;
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, origin);
  if (u.pathname.startsWith('/api/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({method:req.method,path:u.pathname,authorization:req.headers.authorization,body});
    if(failClubRead&&req.method==='GET'&&/^\/api\/v1\/clubs\/[0-9a-f-]+$/.test(u.pathname)){res.writeHead(503,{'content-type':'application/json'}).end('{"error":"temporary"}');return;}
    if (u.pathname.endsWith('/reports') && req.method === 'POST' && failNextReport) { failNextReport = false; res.writeHead(503, {'content-type':'application/json'}).end('{"error":"temporary"}'); return; }
    const result = await api.handler({rawPath:u.pathname.slice(4),headers:req.headers,body,queryStringParameters:Object.fromEntries(u.searchParams),requestContext:{http:{method:req.method,sourceIp:'host-reports-browser'}}});
    if(u.pathname.endsWith('/reports')&&req.method==='POST'&&wrongNextReceipt&&result.statusCode===200){wrongNextReceipt=false;result.body=JSON.stringify({id:'00000000-0000-4000-8000-000000000000'});}
    res.writeHead(result.statusCode,result.headers).end(result.body); return;
  }
  if (u.pathname === '/') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','referrer-policy':'no-referrer'}).end(html); return; }
  const name = u.pathname.replace(/^\//,'');
  if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.includes('..')) { res.writeHead(404).end(); return; }
  try { const data = await readFile(new URL(name, dist)); res.writeHead(200,{'content-type':mime[name.slice(name.lastIndexOf('.'))]||'application/octet-stream'}).end(data); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(18896,'127.0.0.1',resolve));
const engine=process.env.SAMEEND_REPORT_ENGINE||'chromium';if(!['chromium','webkit','firefox'].includes(engine))throw Error('Unknown report test engine');
const browser = await playwright[engine].launch({...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),headless:true});
const contexts=[], errors=[];
async function page(){const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});contexts.push(context);const p=await context.newPage();p.on('pageerror',error=>errors.push(error.message));p.setDefaultTimeout(12000);await p.goto(origin);await p.waitForFunction(()=>window.SameEndSocial?.snapshot().ready);return p;}
try {
  const owner=await page();
  const output=new URL('../privatework/host-report-qa/',import.meta.url);await mkdir(output,{recursive:true});
  const checkHome=async(p)=>{const geometry=await p.evaluate(()=>{const rect=id=>{const el=document.querySelector(id),r=el.getBoundingClientRect();return{top:r.top+scrollY,bottom:r.bottom+scrollY,visible:r.height>0}};return{hero:rect('.football-hero'),flow:rect('#quick-room'),clubs:rect('#club-social'),join:!!document.querySelector('#quick-room .join-entry')};});assert(geometry.hero.visible&&geometry.flow.visible);assert(geometry.hero.bottom<=geometry.flow.top+1&&geometry.flow.top-geometry.hero.bottom<=40,'quick start directly follows banner without intervening listings');assert(!geometry.clubs.visible||geometry.flow.bottom<=geometry.clubs.top+1,'quick start and join precede visible clubs');assert(geometry.join,'invitation entry remains in top flow');};
  await checkHome(owner);await owner.screenshot({path:fileURLToPath(new URL('home-desktop.png',output)),fullPage:true});
  await owner.setViewportSize({width:390,height:844});await checkHome(owner);await owner.screenshot({path:fileURLToPath(new URL('home-phone.png',output)),fullPage:true});await owner.setViewportSize({width:1280,height:900});
  await owner.evaluate(()=>SameEndSocial.createClub({name:'Match night report test',theme:'terrace'}));
  await checkHome(owner);
  const invitation=await owner.locator('#club-invite-url').inputValue();
  const member=await page(); await member.evaluate(link=>SameEndSocial.joinClub(link,{save:true}),invitation); await member.waitForFunction(()=>SameEndSocial.snapshot().connected);
  await owner.waitForFunction(()=>SameEndSocial.snapshot().connected);
  assert.equal(await member.locator('#club-host-inbox').isVisible(),false,'member does not see the host inbox control');
  const chatRequest=()=>requests.findLast(r=>r.method==='GET'&&r.path.endsWith('/messages')&&r.authorization);
  for(let i=0;i<30&&!chatRequest();i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(chatRequest(),'member made an authenticated chat poll');
  const denied=await member.evaluate(async({id,authorization})=>{const r=await fetch('/api/v1/clubs/'+id+'/reports',{headers:{authorization}});return r.status;},{id:await member.evaluate(()=>SameEndSocial.snapshot().id),authorization:chatRequest().authorization});
  assert.equal(denied,401,'member capability is denied report inbox GET');

  await member.evaluate(()=>SameEndInviteCheck.start('club'));
  await member.locator('#invite-check-help').click(); await member.locator('#invite-check-share').waitFor({state:'visible'});
  await member.evaluate(()=>{const clean=SameEndInviteCheck.cleanReport;SameEndInviteCheck.cleanReport=input=>({...clean(input),rawError:'RAW-ERROR-DO-NOT-STORE',privateLink:'PRIVATE-INVITE-DO-NOT-STORE',chat:'PRIVATE-CHAT-DO-NOT-STORE'});});
  failNextReport=true; await member.locator('#invite-check-share').click();
  await member.waitForFunction(()=>document.querySelector('#invite-check-share')?.textContent==='Try sending again');
  assert.match(await member.locator('#invite-check-report-status').textContent(),/could not be reached/,'503 leaves a clear retry state');
  const firstPost=requests.findLast(r=>r.method==='POST'&&r.path.endsWith('/reports')); assert.ok(firstPost,'report POST attempted');
  const firstBody=JSON.parse(firstPost.body); assert.equal(firstBody.envelope.v,1); assert.equal(firstBody.envelope.data.includes('RAW-ERROR'),false);
  wrongNextReceipt=true;await member.locator('#invite-check-share').click();await member.waitForFunction(()=>document.querySelector('#invite-check-share')?.textContent==='Try sending again');assert.match(await member.locator('#invite-check-report-status').textContent(),/could not be reached/,'wrong receipt never confirms delivery');
  await member.locator('#invite-check-share').click(); await member.waitForFunction(()=>document.querySelector('#invite-check-share')?.textContent==='Report sent ✓');
  assert.match(await member.locator('#invite-check-report-status').textContent(),/Sent to your host’s inbox/,'only a successful API response confirms delivery');
  const posts=requests.filter(r=>r.method==='POST'&&r.path.endsWith('/reports'));
  assert.equal(posts.length,3);for(const post of posts)assert.deepEqual(JSON.parse(post.body),firstBody); assert.deepEqual(JSON.parse(posts[1].body),firstBody,'retry reuses the same encrypted report id and envelope');
  await member.evaluate(async({club,authorization,body})=>{const result=await fetch('/api/v1/clubs/'+club+'/reports',{method:'POST',headers:{'content-type':'application/json',authorization},body});if(!result.ok)throw Error('Idempotent retry failed: '+result.status);},{club:await member.evaluate(()=>SameEndSocial.snapshot().id),authorization:chatRequest().authorization,body:posts[1].body});
  assert.equal((await store.query('CLUB#'+await member.evaluate(()=>SameEndSocial.snapshot().id),{from:'REPORT#',to:'REPORT#\uffff'})).length,1,'same id is idempotent at the API');
  const serialized=JSON.stringify([...store.items.values()]);
  for(const secret of ['RAW-ERROR-DO-NOT-STORE','PRIVATE-INVITE-DO-NOT-STORE','PRIVATE-CHAT-DO-NOT-STORE'])assert(!serialized.includes(secret),`backend excludes ${secret}`);
  assert.equal((await store.query('CLUB#'+await member.evaluate(()=>SameEndSocial.snapshot().id),{from:'MSG#',to:'MSG#\uffff'})).length,0,'device report is not chat');
  await owner.locator('#club-host-inbox').click(); await owner.locator('#host-report-inbox').waitFor({state:'visible'});
  await owner.waitForFunction(()=>document.querySelector('#host-report-state')?.textContent==='Inbox is up to date.');
  assert((await owner.locator('#host-report-list').innerText()).includes(await member.evaluate(()=>SameEndInviteCheck.report().device.browser)));
  for(const secret of ['RAW-ERROR-DO-NOT-STORE','PRIVATE-INVITE-DO-NOT-STORE','PRIVATE-CHAT-DO-NOT-STORE'])assert(!(await owner.locator('#host-report-list').innerText()).includes(secret));
  await owner.screenshot({path:fileURLToPath(new URL('owner-inbox.png',output)),mask:[owner.locator('#club-invite-url'),owner.locator('#club-owner-url')]});
  await owner.setViewportSize({width:390,height:844}); await member.setViewportSize({width:390,height:844});
  assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'owner layout has no horizontal overflow at 390px');
  assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'member layout has no horizontal overflow at 390px');
  const flow=await owner.evaluate(()=>{const a=document.querySelector('#club-social'),b=document.querySelector('#watch-room'),y=el=>el.getBoundingClientRect().top+scrollY;return {club:y(a),watch:y(b),before:!!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)}});
  assert.equal(flow.before,true,'club social flow precedes the watch room in document order');

  const memberId=await member.evaluate(()=>SameEndSocial.snapshot().id);failClubRead=true;
  assert.equal(await member.evaluate(async id=>{SameEndSocial.closeClub();try{await SameEndSocial.openClub(id)}catch{}return SameEndSocial.canSendDeviceReport();},memberId),true,'saved-club credentials survive a failed state fetch for reporting');
  await member.evaluate(()=>SameEndInviteCheck.fail('room-unavailable'));await member.locator('#invite-check-share').click();await member.waitForFunction(()=>document.querySelector('#invite-check-share')?.textContent==='Report sent ✓');failClubRead=false;
  const offline=await page(); await offline.evaluate(()=>SameEndInviteCheck.start('screen')); await offline.locator('#settings > summary').click(); await offline.locator('#room-check-help').click();
  await offline.locator('#invite-check-share').waitFor({state:'visible'});
  await offline.evaluate(()=>{window.noInboxHistory=[];const status=document.querySelector('#invite-check-report-status');new MutationObserver(()=>window.noInboxHistory.push(status.textContent)).observe(status,{childList:true,subtree:true,characterData:true});});
  await offline.locator('#invite-check-share').click();
  assert((await offline.evaluate(()=>window.noInboxHistory.join('\n'))).includes('no connected host inbox'),'missing inbox states the sharing fallback');
  assert.equal(await offline.locator('#invite-check-copy').isVisible(),true); assert.equal(await offline.locator('#invite-check-save').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: built-app member report retry and owner inbox; read-token GET denied; ciphertext and sanitized content; idempotent retry; no chat leakage; missing-inbox fallback; 390px layout and club-before-watch flow.');
} finally { await Promise.all(contexts.map(context=>context.close())); await browser.close(); await new Promise(resolve=>server.close(resolve)); }
