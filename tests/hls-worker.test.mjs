import test from 'node:test';
import assert from 'node:assert/strict';
import { install, byteRange, boundCapability } from '../hls-sw-handler.js';
import { cacheResponse, NativePlayer } from '../hls-native.js';
import { VerifiedHlsCache } from '../hls-player.js';
function harness(options = {}) {
  const handlers = {}, clients = options.clients || new Map();
  const scope = { location: { href: 'https://example.test/app/sw.js' }, clients: { claim: async () => {}, get: async id => clients.get(id), matchAll: async () => [...clients.values()] }, addEventListener(type, fn) { handlers[type] = fn; } };
  const bridge = install(scope, { timeoutMs: 20, recoveryTimeoutMs: 20, ...options });
  const owner = (id, response) => { const client = { id, type: 'window', url: 'https://example.test/app/watch.html', postMessage(data, ports) { if (response) ports[0].postMessage(response(data)); } }; clients.set(id, client); return client; };
  const message = (source, type, token, proofSeed = seed) => new Promise(resolve => { handlers.message({ source, data: { type: 'sameend:hls:' + type, token, seed: proofSeed }, ports: [{ postMessage: resolve }], waitUntil() {} }); });
  const fetch = async (token, path = 'master.m3u8', { id = 'a', range, method = 'GET', suffix = '' } = {}) => { let result; handlers.fetch({ clientId: id, request: new Request('https://example.test/app/_sameend/hls/' + token + '/' + path + suffix, { method, headers: range ? { range } : {} }), respondWith(p) { result = p; } }); return await result; };
  return { handlers, bridge, owner, message, fetch, clients };
}
const seed = '0123456789abcdef0123456789abcdef', token = await boundCapability('a', seed);
test('byte ranges reject ambiguous and unsafe bounds', () => {
  assert.deepEqual(byteRange('bytes=1-3', 5), { start: 1, end: 3 }); assert.deepEqual(byteRange('bytes=-2', 5), { start: 3, end: 4 }); assert.deepEqual(byteRange('bytes=2-', 5), { start: 2, end: 4 });
  for (const x of ['bytes=5-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'bytes=9007199254740993-']) assert.throws(() => byteRange(x, 5));
});
test('capability binds owner, refuses takeover and close from another page', async () => {
  const h = harness(), a = h.owner('a', () => ({ status: 200, total: 4, mime: 'video/mp4', bytes: new Uint8Array([1, 2, 3, 4]).buffer })), b = h.owner('b');
  assert.equal((await h.message(a, 'open', token)).ok, true); assert.equal((await h.message(b, 'open', token)).ok, false); assert.equal((await h.message(b, 'close', token)).ok, false);
  assert.equal((await h.fetch(token, 'init.mp4', { id: 'b' })).status, 403); assert.equal((await h.fetch(token, 'init.mp4')).status, 200);
  assert.equal((await h.message(a, 'close', token)).ok, true); assert.equal((await h.fetch(token)).status, 403); assert.equal(h.bridge.sessionCount(), 0);
});
test('range response is validated again by worker; no backend fallback on malformed/missing data', async () => {
  let payload = { status: 206, total: 5, mime: 'video/mp4', bytes: new Uint8Array([2, 3]).buffer };
  const h = harness(), a = h.owner('a', () => payload); await h.message(a, 'open', token);
  let response = await h.fetch(token, 'init.mp4', { range: 'bytes=1-2' }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 1-2/5'); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3]);
  payload = { ...payload, bytes: new Uint8Array([2]).buffer }; assert.equal((await h.fetch(token, 'init.mp4', { range: 'bytes=1-2' })).status, 503);
  payload = { status: 416, total: 5, bytes: new ArrayBuffer(0) }; assert.equal((await h.fetch(token, 'init.mp4', { range: 'bytes=8-' })).status, 416);
  assert.equal((await h.fetch(token, 'init.mp4', { range: 'bytes=0-1,3-4' })).status, 416);
  assert.equal((await h.fetch(token, 'master.m3u8', { suffix: '?room=secret' })).status, 403);
  assert.equal((await h.fetch(token, '%2e%2e/init.mp4')).status, 403);
});
test('bounded lifecycle expires sessions, caps map, drops missing owner and times out RPC', async () => {
  let clock = 0; const h = harness({ now: () => clock, ttlMs: 50, maxSessions: 1 }), a = h.owner('a');
  await h.message(a, 'open', token); const secondSeed='a'.repeat(32); assert.equal((await h.message(a, 'open', await boundCapability('a',secondSeed), secondSeed)).ok, false);
  assert.equal((await h.fetch(token)).status, 503); clock = 60; assert.equal(h.bridge.sessionCount(), 0);
  assert.equal((await h.fetch(token)).status, 403); await h.message(a, 'open', token); h.clients.delete('a'); assert.equal((await h.fetch(token)).status, 410);
});
test('only private HLS namespace is intercepted', () => {
  const h = harness(); let intercepted = false; h.handlers.fetch({ request: new Request('https://example.test/app/watch.html'), respondWith() { intercepted = true; } }); assert.equal(intercepted, false);
});

test('inflight RPC is bounded and close revokes an outstanding response', async () => {
  const ports = []; const h = harness({ timeoutMs: 1000 }), a = h.owner('a');
  a.postMessage = (_data, p) => ports.push(p[0]); await h.message(a, 'open', token);
  const reads = Array.from({ length: 32 }, () => h.fetch(token));
  await new Promise(r => setTimeout(r, 0)); assert.equal((await h.fetch(token)).status, 503);
  await h.message(a, 'close', token);
  for (const port of ports) port.postMessage({ status: 200, total: 1, bytes: new Uint8Array([1]).buffer });
  const results = await Promise.all(reads); assert(results.every(r => r.status === 410));
});

test('page responses copy only verified-cache bytes with exact range and HEAD semantics', () => {
 const cache = new VerifiedHlsCache(); cache.add({ start:0, duration:2, files:[{path:'init.mp4',mime:'video/mp4',bytes:new Uint8Array([1,2,3,4,5])}] });
 const result = cacheResponse(cache,'init.mp4','bytes=1-3'); assert.equal(result.status,206); assert.equal(result.total,5); assert.deepEqual([...new Uint8Array(result.bytes)],[2,3,4]);
 assert.deepEqual([...new Uint8Array(cacheResponse(cache,'init.mp4','bytes=-2').bytes)],[4,5]); assert.equal(cacheResponse(cache,'init.mp4','bytes=8-').status,416); assert.equal(cacheResponse(cache,'init.mp4',null,'HEAD').bytes.byteLength,0);
 assert.equal(cacheResponse(cache,'missing.mp4'),null); assert.equal(cacheResponse(cache,'../init.mp4').status,404); new Uint8Array(result.bytes)[0]=255; assert.equal(cache.files.get('init.mp4').bytes[1],2);
});

test('fresh worker recovers an active owner without media HTTP or a new URL', async () => {
 const first=harness(), messages=[];
 const a=first.owner('a',data=>{messages.push(data.type);return data.type==='sameend:hls:recover'?{ok:true,seed}:{status:200,total:2,mime:'video/mp4',bytes:new Uint8Array([7,8]).buffer};});
 await first.message(a,'open',token); assert.equal((await first.fetch(token,'init.mp4')).status,200);
 const restarted=harness({clients:first.clients}); assert.equal(restarted.bridge.sessionCount(),0);
 const result=await restarted.fetch(token,'init.mp4'); assert.equal(result.status,200);assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[7,8]);assert.equal(restarted.bridge.sessionCount(),1);assert(messages.includes('sameend:hls:recover'));
 const b=restarted.owner('b',()=>({ok:true,seed})); assert.equal((await restarted.message(b,'open',token)).ok,false);assert.equal((await restarted.fetch(token,'init.mp4',{id:'b'})).status,403);
});
test('empty native clientId recovers only a cryptographically bound live owner', async () => {
 const h=harness(), probes=[];
 h.owner('b',d=>{probes.push({client:'b',data:d});return {ok:true,seed};});
 h.owner('a',d=>{probes.push({client:'a',data:d});return d.type==='sameend:hls:recover'?{ok:true,seed}:{status:200,total:1,bytes:new Uint8Array([9]).buffer};});
 assert.equal((await h.fetch(token,'init.mp4',{id:''})).status,200);assert.equal(h.bridge.sessionCount(),1);
 assert(probes.filter(x=>x.data.type==='sameend:hls:recover').every(x=>Object.keys(x.data).sort().join(',')==='token,type'));
 assert.equal((await h.fetch(token,'init.mp4',{id:'b'})).status,403);
});
test('URL possession cannot take over an absent session or forge recovery after restart', async () => {
 const h=harness(), b=h.owner('b',()=>({ok:true,seed}));
 assert.equal((await h.message(b,'open',token)).ok,false);assert.equal((await h.fetch(token,'init.mp4',{id:'b'})).status,403);assert.equal((await h.fetch(token,'init.mp4',{id:''})).status,403);assert.equal(h.bridge.sessionCount(),0);
});
test('expired active sessions re-register by touch or native recovery; closed pages stay revoked after restart', async () => {
 let clock=0, live=true;const h=harness({now:()=>clock,ttlMs:50}), a=h.owner('a',d=>d.type==='sameend:hls:recover'?(live?{ok:true,seed}:{ok:false}):{status:200,total:1,bytes:new Uint8Array([1]).buffer});
 await h.message(a,'open',token);clock=60;assert.equal(h.bridge.sessionCount(),0);assert.equal((await h.message(a,'touch',token)).ok,true);assert.equal((await h.fetch(token)).status,200);
 clock=120;assert.equal(h.bridge.sessionCount(),0);assert.equal((await h.fetch(token,'init.mp4',{id:''})).status,200);
 live=false;await h.message(a,'close',token);assert.equal((await h.message(a,'touch',token)).ok,false);assert.equal((await h.fetch(token,'init.mp4',{id:''})).status,403);
 const restarted=harness({clients:h.clients});assert.equal((await restarted.fetch(token,'init.mp4',{id:''})).status,403);
});
test('close during owner rediscovery cannot resurrect an in-flight session', async () => {
 let pending;const h=harness(),a=h.owner('a');a.postMessage=(_d,ports)=>{pending=ports[0];};
 const result=h.fetch(token);while(!pending)await new Promise(r=>setTimeout(r,0));await h.message(a,'close',token);pending.postMessage({ok:true,seed});assert.equal((await result).status,403);assert.equal(h.bridge.sessionCount(),0);
});
test('empty-client rediscovery bounds candidate probes and concurrent recoveries', async () => {
 const h=harness({maxSessions:2,recoveryTimeoutMs:40});let count=0;
 for(let i=0;i<6;i++){const c=h.owner(String(i));c.postMessage=()=>count++;}
 const requests=[h.fetch(token,'init.mp4',{id:''}),h.fetch('a'.repeat(32),'init.mp4',{id:''})];await new Promise(r=>setTimeout(r,0));assert.equal(h.bridge.pendingRecoveries(),2);assert.equal((await h.fetch('b'.repeat(32),'init.mp4',{id:''})).status,403);await Promise.all(requests);assert.equal(count,4);assert.equal(h.bridge.pendingRecoveries(),0);
});

test('native constructor clears inherited autoplay and preserves negative-clock and hidden play gates', async () => {
 const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),connect=NativePlayer.prototype.connect;
 const serviceWorker={controller:null,addEventListener(){},removeEventListener(){}};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true,MessageChannel,crypto}});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serviceWorker}});
 NativePlayer.prototype.connect=async()=>{};
 let plays=0;const video={autoplay:true,muted:true,paused:true,readyState:0,currentTime:0,buffered:{length:0},canPlayType(){return 'probably'},setAttribute(){},addEventListener(){},removeEventListener(){},play(){plays++;return Promise.resolve()},pause(){},removeAttribute(){},load(){}};
 let player;
 try{let mode;player=new NativePlayer(video,{}, {onMode:value=>mode=value});await player.ready;assert.equal(mode,'hls-native');assert.equal(video.autoplay,false);player.setPlaybackWindow(-1);await player.play();assert.equal(plays,0);player.setPlaybackWindow(0,true);await player.play();assert.equal(plays,0);assert.equal(player.srcChanges,0);}
 finally{player?.close();NativePlayer.prototype.connect=connect;if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else delete globalThis.window;if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;}
});

test('first native join activates a waiting bridge over a legacy controller without reloading or attaching media', async () => {
 const saved={window:Object.getOwnPropertyDescriptor(globalThis,'window'),navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),location:Object.getOwnPropertyDescriptor(globalThis,'location')};
 const messages=[],listeners=new Set(),stateListeners=new Set();let registration;
 const old={state:'activated',postMessage(data){messages.push('old:'+data.type)}};
 const serviceWorker={controller:old,register:async()=>registration,addEventListener(type,fn){if(type==='controllerchange')listeners.add(fn)},removeEventListener(type,fn){if(type==='controllerchange')listeners.delete(fn)}};
 const next={state:'installed',addEventListener(type,fn){if(type==='statechange')stateListeners.add(fn)},removeEventListener(type,fn){if(type==='statechange')stateListeners.delete(fn)},postMessage(data,ports){messages.push('new:'+data.type);if(data.type==='ACTIVATE_UPDATE'){this.state='activated';serviceWorker.controller=this;registration.active=this;registration.waiting=null;for(const fn of stateListeners)fn();for(const fn of listeners)fn();return}ports?.[0]?.postMessage({ok:true,version:2,clientId:'upgrade-client'});}};
 registration={active:old,waiting:next,installing:null,update:async()=>{}};serviceWorker.ready=Promise.resolve(registration);
 Object.defineProperty(globalThis,'window',{configurable:true,value:{isSecureContext:true,MessageChannel,crypto}});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serviceWorker}});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://example.test/app/watch.html',reload(){throw Error('Unexpected page reload')}}});
 const video={autoplay:true,paused:true,canPlayType(){return 'probably'},setAttribute(){},addEventListener(){},removeEventListener(){},pause(){},removeAttribute(){},load(){}};let player;
 try{const errors=[];player=new NativePlayer(video,{}, {onError:e=>errors.push(e)});await player.ready;assert.deepEqual(errors,[]);assert.equal(player.worker,next);assert.equal(player.bridgeReady,true);assert.equal(player.started,undefined);assert.equal(player.srcChanges,0);assert.equal(video.autoplay,false);assert(messages.includes('new:ACTIVATE_UPDATE'));assert.equal(player.token,await boundCapability('upgrade-client',player.seed));}
 finally{player?.close();for(const [name,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
});
