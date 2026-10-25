import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script,createContext,runInContext} from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import * as webStreams from 'node:stream/web';
import {unzipSync} from 'fflate';
test('generated app includes artwork, clubs, rehearsal and syntactically valid inline scripts',async()=>{const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');assert.match(html,/data:image\/webp;base64/);assert.match(html,/same-end-social/);assert.match(html,/SameEndRehearsal/);assert.doesNotMatch(html,/__HERO_IMAGE__|__CLUB_IMAGE__/);for(const[,attr,body]of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)){if(/type="application\/json"|id="webtorrent-license"/.test(attr))continue;new Script(body);}assert.match(html,/Private club keys and video are not included/);});
test('standalone byte shim lets the bundled WebTorrent client initialize without modern typed-array methods',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const shim=html.match(/<script id="browser-compat">([\s\S]*?)<\/script>/)?.[1];
  const vendor=html.match(/<script type="application\/x-privatecast" id="magnet-vendor">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(shim&&vendor,'built app must include shim before the vendor script');
  assert.ok(html.indexOf('id="browser-compat"')<html.indexOf('id="magnet-vendor"'));
  let diskReads=0;
  const cryptoMock={getRandomValues:a=>{a.fill(7);return a},subtle:globalThis.crypto.subtle};
  const context=createContext({Uint8Array,Uint16Array,ArrayBuffer,DataView,performance,console,setTimeout,clearTimeout,btoa:s=>Buffer.from(s,'binary').toString('base64'),TextEncoder,TextDecoder,URL,Blob,crypto:cryptoMock,WebSocket:class{},navigator:{storage:{getDirectory:()=>{diskReads++;return Promise.reject(Error('Origin private storage unavailable'));}}},...webStreams,MessageChannel});
  runInContext('window=globalThis;self=globalThis;delete Uint8Array.prototype.toBase64;delete Uint8Array.prototype.toHex;delete Uint8Array.fromHex;delete Object.hasOwn;delete crypto.randomUUID;delete globalThis.structuredClone',context);
  runInContext(shim,context);runInContext(vendor,context);
  runInContext('client=new WebTorrent({dht:false,tracker:false})',context);
  assert.equal(diskReads,0,'in-memory descriptors must not trigger upstream filesystem cleanup');
  assert.equal(runInContext("new Uint8Array([0,15,255]).toHex()",context),'000fff');
  assert.equal(runInContext("new Uint8Array([77,97,110]).toBase64()",context),'TWFu');
  assert.equal(runInContext("Array.from(Uint8Array.fromHex('000fff')).join(',')",context),'0,15,255');
  assert.equal(runInContext("crypto.randomUUID()",context),'07070707-0707-4707-8707-070707070707');
  assert.equal(runInContext("Object.hasOwn({own:1},'own')&&!Object.hasOwn({},'own')",context),true);
  assert.equal(runInContext("JSON.stringify(structuredClone({nested:[1,{ok:true}]}))",context),'{"nested":[1,{"ok":true}]}');
  assert.equal(runInContext("(()=>{const c=structuredClone({missing:undefined,items:[undefined]});return Object.hasOwn(c,'missing')&&Object.hasOwn(c.items,0)&&c.missing===undefined&&c.items[0]===undefined})()",context),true);
  assert.equal(runInContext("(()=>{try{structuredClone(new Date());return false}catch(e){return e instanceof TypeError}})()",context),true);
});
test('service worker caches fixed shell only and routes generic notifications without secret links',async()=>{const code=await readFile(new URL('../dist/sw.js',import.meta.url),'utf8');const handlers={},shown=[],opened=[];const context=createContext({URL,Set,Promise,console,self:{location:{href:'https://www.sameend.com/sw.js'},addEventListener:(kind,fn)=>handlers[kind]=fn,registration:{showNotification:(title,options)=>{shown.push({title,options});return Promise.resolve()}},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}}});runInContext(code,context);const id='60b837fe-b197-46e2-a836-f4439e06bf2c';let promise;handlers.push({data:{json:()=>({clubId:id,url:'https://evil.invalid/#owner=secret',title:'private match name',body:'private chat'})},waitUntil:p=>promise=p});await promise;assert.equal(shown[0].title,'Same End');assert.doesNotMatch(JSON.stringify(shown),/evil|secret|private chat|private match name/);handlers.notificationclick({notification:{data:{clubId:id},close(){}},waitUntil:p=>promise=p});await promise;assert.equal(opened[0],'https://www.sameend.com/#openclub='+id);assert.doesNotMatch(opened[0],/(?:#|&)club=|owner=/);assert.match(code,/index.html.*manifest.webmanifest.*icon-192.png.*icon-512.png/);assert.match(code,/searchParams\.set\(["']v["'],\s*CACHE\)/);assert.match(code,/c.put\(key.href,response\)/);});

test('a waiting app update never activates or reloads a joining, playing or club-connected room',async()=>{
 const source=await readFile(new URL('../build-pwa.mjs',import.meta.url),'utf8');
 const code=source.split('\n').find(line=>line.startsWith("if('serviceWorker' in navigator"));assert(code,'app shell update handler is present');
 for(const state of [{config:{id:'playing'}},{joining:true},{connected:true},{edited:true},{}]){
  const handlers={},messages=[],timers=[];let reloads=0;
  const registration={waiting:{postMessage:message=>messages.push(message)},addEventListener(){}};
  const context=createContext({console,window:{PrivateCast:{snapshot:()=>({config:state.config||null})},SameEndSocial:{snapshot:()=>({connected:!!state.connected})}},document:{body:{classList:{contains:()=>!!state.joining}},querySelectorAll:()=>state.edited?[{value:'edited',defaultValue:''}]:[]},navigator:{serviceWorker:{addEventListener:(kind,handler)=>handlers[kind]=handler,register:async()=>registration}},location:{protocol:'https:',hostname:'www.sameend.com',reload:()=>reloads++},setInterval:fn=>timers.push(fn),$:()=>({})});
  runInContext(code,context);await new Promise(resolve=>setImmediate(resolve));
  timers.forEach(fn=>fn());handlers.controllerchange();
  const idle=!Object.keys(state).length;
  assert.equal(messages.length,idle?2:0,JSON.stringify(state));assert.equal(reloads,idle?1:0,JSON.stringify(state));
 }
});


test('portable extension ZIP contains only the reviewed files under its installation folder',async()=>{
 const zip=unzipSync(new Uint8Array(await readFile(new URL('../dist/same-end-local-fixtures.zip',import.meta.url))));const names=Object.keys(zip).sort();assert.equal(names.length,10);assert(names.every(n=>n.startsWith('Same-End-Local-Fixtures/')));const prefix='Same-End-Local-Fixtures/';for(const file of names){assert.deepEqual(Buffer.from(zip[file]),await readFile(new URL('../extension/'+file.slice(prefix.length),import.meta.url)));}
});
