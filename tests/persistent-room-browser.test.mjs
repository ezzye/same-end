/* Persistent watch invitations: isolated encrypted backend and mocked media lifecycle. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createApi } from '../backend/api.mjs';
import { MemoryStore } from '../backend/store.mjs';
const require = createRequire(import.meta.url);
let chromium, webkit;
try { ({ chromium, webkit } = require('playwright')); } catch { ({ chromium, webkit } = await import(process.env.SAMEEND_PLAYWRIGHT || '/Users/errolelliott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')); }
const root = new URL('../', import.meta.url), js = await readFile(new URL('social.js', root), 'utf8'), css = await readFile(new URL('social.css', root), 'utf8');

const engineSource=await readFile(new URL('engine.js',root),'utf8');
const discoverySource=engineSource.slice(engineSource.indexOf('async function joinMagnet('),engineSource.indexOf('\nfunction canRetryJoin()'));
const discoveryFixture=`window.useEngineDiscoveryFixture=({holdCleanup=false}={})=>{
 const state={config:null,active:false,stopped:true,role:'viewer'};let startingCapture=false,magnetBusy=false,magnetTransport=null,magnetJoinGeneration=0,lastJoinLink=null,lastNetworkCheck=null;
 let releaseCleanup;const magnetCleanup=holdCleanup?new Promise(resolve=>releaseCleanup=resolve):Promise.resolve();
 const calls=[],created=[],closed=[],$=id=>document.getElementById(id);function update(){}
 async function end(){magnetJoinGeneration++;state.config=null;state.active=false;}
 function createMagnetTransport(){let rejectJoin,done=false;const transport={snapshot:()=>({network:null}),async join(m){created.push(m);if(m==='magnet:?xt=urn:btih:dead')await new Promise((resolve,reject)=>{rejectJoin=reject});if(done)throw Error('cancelled transport');state.config={id:m};state.active=false;},async close(){if(done)return;done=true;closed.push(transport);rejectJoin?.(Error('cancelled transport'));}};return transport;}
 ${discoverySource}
 window.PrivateCast={calls,created,closed,releaseCleanup:()=>releaseCleanup?.(),get generation(){return magnetJoinGeneration},joinMagnet:async m=>{calls.push(m);return joinMagnet(m)},leaveRoom,cancelPendingJoin,snapshot:()=>({config:state.config,role:state.role,active:state.active,joiningBusy:magnetBusy,peers:[]})};
};`;

const origin = 'http://127.0.0.1:18894', store = new MemoryStore();
const api = createApi({ store, push: { enabled: false }, allowedOrigins: [origin] });
let heldPath = null, heldRequest = null, releaseHeld;
const held = new Promise(resolve => { heldRequest = resolve; });
let offline = false, holdPut = false, heldPut, releasePut;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, origin);
  if (heldPath === u.pathname && req.method === 'GET') {
    heldPath = null; heldRequest();
    await new Promise(resolve => { releaseHeld = resolve; });
  }
  if (offline && u.pathname.startsWith('/api/v1/clubs/')) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"offline chat fixture"}'); return; }
  if(holdPut && req.method==='PUT'){holdPut=false;heldPut?.();await new Promise(resolve=>{releasePut=resolve});}
  if (u.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const result = await api.handler({ rawPath: u.pathname.slice(4), headers: req.headers, body: Buffer.concat(chunks).toString(), queryStringParameters: Object.fromEntries(u.searchParams), requestContext: { http: { method: req.method, sourceIp: 'startup-social-test' } } });
    res.writeHead(result.statusCode, result.headers).end(result.body); return;
  }
  if (u.pathname === '/fixtures.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"fixtures":[]}'); return; }
  res.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': 'no-referrer' }).end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:20px;font:16px system-ui}button,input,textarea,select{font:inherit}input,textarea,select{width:100%}[hidden]{display:none!important}${css}</style><main><section id="club-social"></section><section id="watch-room"><div class="stage"><video id="player"></video></div><button id="stop">Leave</button><input id="magnet-link"><div id="magnet-progress"></div><div id="room-status"></div><div id="room-social-status"></div><div id="room-chat"></div></section></main><script>window.SameEndConfig={apiBase:'/api'};window.SameEndFixtures=[];window.PrivateCast={calls:[],leaves:0,published:0,role:'viewer',active:false,config:null,hold:null,failNext:0,
joinMagnet:async function(m){this.calls.push(m);if(this.failNext){this.failNext--;throw Error('fixture join failed')}if(this.hold)await new Promise(resolve=>{this.release=resolve});this.config={id:m};this.active=false;this.role='viewer';dispatchEvent(new Event('sameend:castchange'));},
leaveRoom:async function(){this.leaves++;this.config=null;this.active=false;dispatchEvent(new Event('sameend:castchange'));},
publishInvitation:async function(){this.published++;document.getElementById('magnet-link').value='magnet:?xt=urn:btih:'+this.config.id;dispatchEvent(new Event('sameend:castchange'));},
source:function(id,magnet=''){this.config=id?{id}:null;this.role='source';this.active=!!id;document.getElementById('magnet-link').value=magnet;dispatchEvent(new Event('sameend:castchange'));},
snapshot:function(){return {active:this.active,role:this.role,config:this.config,peers:[]}}};</script><script>${discoveryFixture}</script><script>${js}</script>`);
});
await new Promise(resolve => server.listen(18894, '127.0.0.1', resolve));
const useWebKit=process.env.SAMEEND_SOCIAL_ENGINE==='webkit';
const browser = await (useWebKit?webkit:chromium).launch(useWebKit?{headless:true}:{ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const contexts = [], errors = [];
async function page() { const c = await browser.newContext(); contexts.push(c); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(origin); await p.waitForFunction(() => window.SameEndSocial?.snapshot().ready); return p; }
try {
  const old='magnet:?xt=urn:btih:old', fresh='magnet:?xt=urn:btih:new';
  const owner=await page();
  await owner.evaluate(()=>SameEndSocial.createClub({name:'Persistent club'}));
  await owner.evaluate(m=>PrivateCast.source('old',m),old);
  const invite=await owner.evaluate(m=>SameEndSocial.castInvitation(m),old);
  assert.match(invite, /&watch=1$/);assert(!invite.includes('owner=')&&!invite.includes('join=')&&!invite.includes('magnet'));
  const ownerLink=await owner.evaluate(()=>{document.getElementById('club-owner-reveal').click();return document.getElementById('club-owner-url').value});
  const viewer=await page();await viewer.goto(invite);
  await viewer.waitForFunction(m=>PrivateCast.config?.id===m,old);
  assert.equal(await viewer.evaluate(()=>SameEndSocial.snapshot().saved),false,'watch invitation does not save member key');
  await owner.evaluate(()=>SameEndSocial.sendChat('Chat survives restarts','Host'));
  await viewer.waitForFunction(()=>SameEndSocial.snapshot().chatCount===1);
  await owner.evaluate(()=>PrivateCast.source(null));
  await viewer.waitForFunction(()=>!PrivateCast.config&&SameEndSocial.snapshot().watching);
  assert.equal(await viewer.locator('#club-chat-shell').isVisible(),true,'waiting room keeps chat');
  const waiting=await page();await waiting.goto(invite);
  await waiting.waitForFunction(()=>SameEndSocial.snapshot().connected);
  assert.equal(await waiting.evaluate(()=>PrivateCast.calls.length),0,'no stale screen in stopped-room invite');
  assert.equal(await waiting.evaluate(()=>document.body.classList.contains('watch-intent')),true);
  // Explicitly reopening a stopped club retires an adopted stale viewer.
  const staleWaiting=await page();await staleWaiting.evaluate(m=>{PrivateCast.config={id:m};PrivateCast.active=false},old);
  await staleWaiting.evaluate(link=>SameEndSocial.joinCastLink(link),invite);
  await staleWaiting.waitForFunction(()=>!PrivateCast.config&&SameEndSocial.snapshot().watching);
  assert.equal(await staleWaiting.evaluate(()=>PrivateCast.leaves),1,'explicit stopped-room invitation closes only its adopted viewer');
  assert.equal(await staleWaiting.evaluate(()=>PrivateCast.calls.length),0,'stopped room must not rejoin a stale capture');
  await owner.evaluate(()=>PrivateCast.source('new'));
  await viewer.waitForFunction(m=>PrivateCast.config?.id===m,fresh);
  await waiting.waitForFunction(m=>PrivateCast.config?.id===m,fresh);
  assert.equal(await owner.evaluate(()=>PrivateCast.published),1,'source restart automatically creates descriptor');
  assert.equal(await owner.evaluate(()=>SameEndSocial.snapshot().watchInvitation),invite,'same stable invitation after restart');
  assert.equal(await viewer.evaluate(()=>SameEndSocial.snapshot().chatCount),1,'chat survives media replacement');
  const late=await page();await late.goto(invite);await late.waitForFunction(m=>PrivateCast.config?.id===m,fresh);
  assert.deepEqual(await late.evaluate(()=>PrivateCast.calls),[fresh],'stable late join resolves only fresh live');
  // Reopening the same invitation in an already-open stale receiver should adopt
  // that room and follow the current cast instead of treating it as unrelated.
  const resumed=await page();await resumed.evaluate(m=>{PrivateCast.config={id:m};PrivateCast.active=false},old);
  await resumed.evaluate(link=>SameEndSocial.joinCastLink(link),invite);
  await resumed.waitForFunction(m=>PrivateCast.config?.id===m,fresh,{timeout:5000});
  assert.deepEqual(await resumed.evaluate(()=>PrivateCast.calls),[fresh]);
  await resumed.evaluate(m=>{document.getElementById('stop').click();PrivateCast.config={id:m};PrivateCast.active=false},old);
  await resumed.locator('#club-join-live').click();
  await resumed.waitForFunction(m=>PrivateCast.config?.id===m,fresh,{timeout:5000});
  assert.equal(await resumed.evaluate(()=>PrivateCast.leaves),2,'explicit Join live adopts the previous receiver');
  // A receiver is active:false in the real engine (active means source capture).
  // Healthy viewer configs must not be repeatedly torn down.
  const healthyCalls=await late.evaluate(()=>PrivateCast.calls.length);
  await late.evaluate(()=>{for(let i=0;i<4;i++){dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))}});
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(await late.evaluate(()=>PrivateCast.calls.length),healthyCalls,'healthy active:false viewer does not rejoin on polls or network hints');
  // A dropped owned config must rejoin even when the club version is unchanged.
  const callsBeforeLoss=await late.evaluate(()=>PrivateCast.calls.length);
  await late.evaluate(()=>{PrivateCast.config=null;PrivateCast.active=false;dispatchEvent(new Event('sameend:castchange'))});
  await late.waitForFunction(([m,n])=>PrivateCast.config?.id===m&&PrivateCast.calls.length===n+1,[fresh,callsBeforeLoss],{timeout:5000});
  await new Promise(resolve=>setTimeout(resolve,100));
  await late.evaluate(()=>{PrivateCast.failNext=1});
  const callsBeforeInactive=await late.evaluate(()=>PrivateCast.calls.length);
  await late.evaluate(()=>{PrivateCast.config=null;PrivateCast.active=false;dispatchEvent(new Event('sameend:castchange'))});
  await late.waitForFunction(([m,n])=>PrivateCast.calls.length===n+1,[fresh,callsBeforeInactive],{timeout:5000});
  await late.evaluate(()=>{for(let i=0;i<4;i++){dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))}});
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(await late.evaluate(()=>PrivateCast.calls.length),callsBeforeInactive+1,'online/foreground signals coalesce and respect retry backoff');
  await late.waitForFunction(([m,n])=>PrivateCast.config?.id===m&&PrivateCast.calls.length===n+2,[fresh,callsBeforeInactive],{timeout:13000});
  // Legacy combined invitation discovers its embedded picture immediately, then uses latest state.
  const legacy=await page();await legacy.goto(invite.replace('&watch=1','')+'&join='+encodeURIComponent(old));
  await legacy.waitForFunction(m=>PrivateCast.config?.id===m,fresh);
  assert.deepEqual(await legacy.evaluate(()=>PrivateCast.calls),[old,fresh]);
  assert.equal(await legacy.evaluate(()=>PrivateCast.leaves),1);
  // Leave during discovery invalidates the old join even when it resolves late.
  const pending=await page();await pending.evaluate(()=>{PrivateCast.hold=true});
  const pendingJoin=pending.evaluate(link=>SameEndSocial.joinCastLink(link),invite.replace('&watch=1','')+'&join='+encodeURIComponent(fresh));
  await pending.waitForFunction(()=>typeof PrivateCast.release==='function');
  await pending.evaluate(()=>{document.getElementById('stop').click();PrivateCast.hold=false;PrivateCast.release()});
  await pendingJoin;
  assert.equal(await pending.evaluate(()=>PrivateCast.config),null,'late cancelled discovery is closed');
  assert.equal(await pending.evaluate(()=>SameEndSocial.snapshot().watching),false);
  // Explicit Leave is respected while chat stays open.
  await viewer.evaluate(()=>{document.getElementById('stop').click();return PrivateCast.leaveRoom()});
  await owner.evaluate(()=>PrivateCast.source('third'));
  await waiting.waitForFunction(()=>PrivateCast.config?.id==='magnet:?xt=urn:btih:third');
  assert.equal(await viewer.evaluate(()=>SameEndSocial.snapshot().watching),false);
  assert.equal(await viewer.evaluate(()=>PrivateCast.config),null);
  // A manually opened unrelated cast may never be switched by club polling.
  await late.waitForFunction(()=>PrivateCast.config?.id==='magnet:?xt=urn:btih:third');
  const callsBeforeForeign=await late.evaluate(()=>PrivateCast.calls.length);
  await late.evaluate(()=>{PrivateCast.config={id:'manual-unrelated'};PrivateCast.active=false;dispatchEvent(new Event('sameend:castchange'))});
  await owner.evaluate(()=>PrivateCast.source('fourth'));
  await waiting.waitForFunction(()=>PrivateCast.config?.id==='magnet:?xt=urn:btih:fourth');
  assert.equal(await late.evaluate(()=>PrivateCast.config.id),'manual-unrelated');
  await late.evaluate(()=>{PrivateCast.config=null;PrivateCast.active=false;dispatchEvent(new Event('sameend:castchange'))});
  await new Promise(resolve=>setTimeout(resolve,2500));
  assert.equal(await late.evaluate(()=>PrivateCast.calls.length),callsBeforeForeign,'closing a foreign manual room does not resume the old follower');
  const recoveringBootstrap=await page();offline=true;await recoveringBootstrap.goto(invite);
  await recoveringBootstrap.waitForFunction(()=>SameEndSocial.snapshot().watching);
  assert.equal(await recoveringBootstrap.evaluate(()=>SameEndSocial.snapshot().connected),false,'transient first club fetch stays in memory and retries');
  offline=false;await recoveringBootstrap.evaluate(()=>{dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))});
  await recoveringBootstrap.waitForFunction(()=>SameEndSocial.snapshot().connected,null,{timeout:8000});
  await recoveringBootstrap.waitForFunction(m=>PrivateCast.config?.id===m,'magnet:?xt=urn:btih:fourth',{timeout:5000});
  // A queued old clear conflicts with a newer owner publish and must preserve it.
  const secondOwner=await page();await secondOwner.evaluate(link=>SameEndSocial.joinClub(link,{save:true}),ownerLink);
  let notifyPut;const putSeen=new Promise(resolve=>{notifyPut=resolve});heldPut=notifyPut;holdPut=true;
  const clear=owner.evaluate(()=>SameEndSocial.clearLive());await putSeen;
  await secondOwner.evaluate(()=>{PrivateCast.source('newest','magnet:?xt=urn:btih:newest');return SameEndSocial.castInvitation('magnet:?xt=urn:btih:newest')});
  releasePut();await clear;
  const newest=await page();await newest.goto(invite);await newest.waitForFunction(()=>PrivateCast.config?.id==='magnet:?xt=urn:btih:newest');
  // Resolve fresh live while the real engine is suspended in old discovery/cleanup.
  for(const holdCleanup of [true,false]){
    const preempt=await page();await preempt.evaluate(holdCleanup=>useEngineDiscoveryFixture({holdCleanup}),holdCleanup);
    const started=Date.now();
    const opening=preempt.evaluate(link=>SameEndSocial.joinCastLink(link),invite.replace('&watch=1','')+'&join='+encodeURIComponent('magnet:?xt=urn:btih:dead'));
    if(holdCleanup){await preempt.waitForFunction(()=>PrivateCast.generation>=2,null,{timeout:5000});await preempt.evaluate(()=>PrivateCast.releaseCleanup());}
    await preempt.waitForFunction(()=>PrivateCast.snapshot().config?.id==='magnet:?xt=urn:btih:newest',null,{timeout:5000});
    await opening;
    assert.deepEqual(await preempt.evaluate(()=>PrivateCast.calls),['magnet:?xt=urn:btih:dead','magnet:?xt=urn:btih:newest'],'dead old discovery preempted exactly once');
    assert.deepEqual(await preempt.evaluate(()=>PrivateCast.created),holdCleanup?['magnet:?xt=urn:btih:newest']:['magnet:?xt=urn:btih:dead','magnet:?xt=urn:btih:newest']);
    assert(Date.now()-started<10000,'no old discovery timeout required');
  }
  // Owner refresh restores only the saved club ID and republishes on capture start.
  await secondOwner.reload();await secondOwner.waitForFunction(()=>SameEndSocial.snapshot().owner);
  assert.equal(await secondOwner.evaluate(()=>SameEndSocial.snapshot().watchInvitation),invite);
  await secondOwner.evaluate(()=>PrivateCast.source('reload'));
  await secondOwner.waitForFunction(()=>PrivateCast.published===1);
  assert.deepEqual(errors,[]);
  console.log('PASS: stable private URL, current/late/legacy join, waiting chat, source restart, stale receiver and Join live adoption, missing/inactive cast repair, foreign manual cast guard after close, transient invitation bootstrap retry, explicit Leave, stale clear conflict, owner refresh, and pending-join preemption.');
} finally {
  releaseHeld?.();releasePut?.();
  await Promise.all(contexts.map(c => c.close())); await browser.close(); await new Promise(resolve => server.close(resolve));
}
