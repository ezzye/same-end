import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const client=await readFile(new URL('../coordinator-client.js',import.meta.url),'utf8');
const transport=(await readFile(new URL('../magnet-transport.js',import.meta.url),'utf8')).replace("import WebTorrent from './vendor/webtorrent.min.js';",'');
function setup(){const ctx={window:{},TextEncoder,TextDecoder,crypto:webcrypto,btoa,atob,URL,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval};vm.createContext(ctx);vm.runInContext(client,ctx);vm.runInContext(transport,ctx);return ctx.window;}
test('lease client serializes actions and retains monotonically increasing sequence across errors',async()=>{
 const w=setup(),calls=[];let release;const held=new Promise(r=>release=r);
 const c=w.SameEndCoordinator.create({cast:'cast',nodeId:'node',request:async payload=>{calls.push(payload);if(calls.length===1)await held;if(calls.length===2)throw Error('offline');return {leaseToken:'token',expiresAt:Date.now()+15000,recommendations:[]};}});
 const a=c.report({}),b=c.reserve('supplier'),d=c.report({});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);release();await a;assert.equal(await b,null);await d;
 assert.deepEqual(calls.map(x=>x.seq),[1,2,3]);assert.equal(calls[1].leaseToken,'token');assert.equal(calls[2].leaseToken,'token');
});
test('outbound queue adapter reads pinned peer connection buffers, not incoming bytes',()=>{
 const w=setup();let channel;const t=new w.CastMagnetTransport({getStatus:()=>({nodeId:'self',clockReady:true}),onPeer:p=>channel=p.channel});t.role='viewer';t.sessionReady=true;t.recovery={};const wire={readableLength:999999,writableLength:5,destroyed:false,extended(){}};
 const s={wire,auth:true,remote:{nodeId:'root',trail:[],role:'source'},direction:'up'};t.wires.set(wire,s);t.torrent={_peers:new Map([['root',{wire,conn:{_channel:{bufferedAmount:100},writableLength:7}}]])};t._open(s);
 assert.equal(channel.bufferedAmount,112);t.torrent._peers={root:{wire,conn:{_channel:{bufferedAmount:9}}}};assert.equal(channel.bufferedAmount,14);
});
test('leaf and stale candidates do not receive offers',()=>{
 const w=setup();const t=new w.CastMagnetTransport({getStatus:()=>({nodeId:'self',clockReady:true})});t.role='viewer';t.sessionReady=true;t._recover();const make=(nodeId,extra)=>({auth:true,wire:{},remote:{nodeId,role:'source',trail:[],clockReady:true,downCount:0,relayLimit:2,...extra}});
 const leaf=make('leaf',{leafOnly:true}),stale=make('stale',{health:{sourceAgeSeconds:31}});t._assign(leaf);t._assign(stale);assert.equal(t.parentRequest,null);
});
test('edge refresh changes future offers while preserving existing connections',async()=>{
 const w=setup();let answer={expiresAt:Math.floor(Date.now()/1000)+60,iceServers:[{urls:'turn:edge.example:3478',username:'u',credential:'c'}]};
 const t=new w.CastMagnetTransport({getIceServers:async()=>answer});t.client={tracker:{}};const tracker={_rtcConfig:{}};t.torrent={discovery:{tracker}};t.network={};
 t._refreshIce();await new Promise(resolve=>setImmediate(resolve));assert.equal(tracker._rtcConfig.iceServers.length,3);assert.equal(t.network.relayConfigured,true);
 answer={iceServers:[]};t._refreshIce();await new Promise(resolve=>setImmediate(resolve));assert.equal(tracker._rtcConfig.iceServers.length,2);assert.equal(t.network.relayConfigured,false);
});

test('unknown outbound capacity limits local admission to one child',()=>{
 const w=setup();const t=new w.CastMagnetTransport({getStatus:()=>({nodeId:'self',clockReady:true,relayLimit:2,health:{outgoingMbps:null}})});t.role='viewer';assert.equal(t.getStatus().relayLimit,1);assert.equal(t.getStatus().health.outgoingMbps,null);
});
test('coordinator report retains unknown child rate and maps measured health',async()=>{
 const w=setup();let submitted;const t=new w.CastMagnetTransport({getStatus:()=>({nodeId:'self',clockReady:true,health:{outgoingMbps:null}}),getCoordinatorReport:()=>({sourceAgeSeconds:null,children:[{nodeId:'child',queuedBytes:3,deliveredMbps:null,health:'healthy'}]})});
 t.role='source';t.sessionReady=true;t.networkStarted=Date.now();t.coordinator={latest:()=>null,report:async r=>{submitted=r;}};
 const wire={destroyed:false};t.wires.set(wire,{wire,auth:true,opened:true,direction:'down',remote:{nodeId:'child'}});t._statusTick();await Promise.resolve();
 assert.equal(submitted.sourceAgeSeconds,null);assert.equal(submitted.children[0].deliveredMbps,null);assert.equal(submitted.children[0].health,'good');
});

test('expired edge credentials are never used and provider failure restores STUN for new offers',async()=>{
 const w=setup();let answer={expiresAt:Math.floor(Date.now()/1000)-1,iceServers:[{urls:'turn:edge.example:3478',username:'u',credential:'c'}]};
 const t=new w.CastMagnetTransport({getIceServers:async()=>{if(answer===null)throw Error('unavailable');return answer;}});t.client={tracker:{}};const tracker={_rtcConfig:{}};t.torrent={discovery:{tracker}};t.network={};
 t._refreshIce();await new Promise(resolve=>setImmediate(resolve));assert.equal(tracker._rtcConfig.iceServers.length,2);
 answer={expiresAt:Math.floor(Date.now()/1000)+60,iceServers:[{urls:'turn:edge.example:3478',username:'u',credential:'c'}]};t._refreshIce();await new Promise(resolve=>setImmediate(resolve));assert.equal(tracker._rtcConfig.iceServers.length,3);
 answer=null;t._refreshIce();await new Promise(resolve=>setImmediate(resolve));assert.equal(tracker._rtcConfig.iceServers.length,2);assert.equal(t.network.relayConfigured,false);
});

test('unmeasured source advertises its declared bounded two-slot budget',()=>{
 const w=setup();const t=new w.CastMagnetTransport({getStatus:()=>({nodeId:'source',clockReady:true,relayLimit:2,health:{outgoingMbps:null}})});t.role='source';assert.equal(t.getStatus().relayLimit,2);assert.equal(t.getStatus().health.outgoingMbps,null);
});
test('a relay delivery rate alone does not increase the declared relay budget',()=>{
 const w=setup();const t=new w.CastMagnetTransport({getStatus:()=>({nodeId:'viewer',clockReady:true,relayLimit:2,health:{outgoingMbps:2}})});t.role='viewer';assert.equal(t.getStatus().relayLimit,1);
});

test('v3 descriptor requires internally consistent HLS audio and video capabilities',()=>{
 const exposed=transport.replace('  function MemoryStore(', '  window.validateConfig=configOK;\n  function MemoryStore(');
 const context={window:{},TextEncoder,TextDecoder,crypto:webcrypto,btoa,atob,URL,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval};vm.createContext(context);vm.runInContext(exposed,context);
 const check=context.window.validateConfig, base={id:'cast',epoch:1,delay:10,mime:'application/vnd.apple.mpegurl',mediaProfile:'hls-cmaf-v1',publicKey:{kty:'EC',crv:'P-256'},segmentVersion:3,sourceId:'source',sourceEpoch:0,programId:'program',alignmentVersion:1,audio:true,sourceAudioAvailable:true,renditions:['audio','v360','v480'],startRendition:'v480',maxRendition:'v480'};
 assert.equal(check(base),true);assert.equal(check({...base,audio:false,sourceAudioAvailable:false}),true);
 assert.equal(check({...base,renditions:['audio','v360'],startRendition:'v360',maxRendition:'v360'}),true);
 for(const patch of [{mime:'video/webm'}, {mediaProfile:'other'}, {audio:false}, {sourceAudioAvailable:null}, {renditions:['v360','v480']}, {renditions:['audio','v480']}, {renditions:['audio','v360','v360']}, {startRendition:'audio'}, {startRendition:'v480',maxRendition:'v360'}, {renditions:['audio','v360'],startRendition:'v480'}, {maxRendition:undefined}])assert.equal(!!check({...base,...patch}),false,JSON.stringify(patch));
 assert.equal(!!check({...base,segmentVersion:2,audio:undefined,sourceAudioAvailable:undefined,renditions:undefined,startRendition:undefined,maxRendition:undefined}),true);
});

test('legacy v2 source routes without a rendition catalogue or coordinator report',()=>{
 const w=setup();let created=0,offers=0;w.SameEndSocial={coordinateRoom:async()=>{throw Error('unexpected coordinator request');}};
 w.SameEndCoordinator.create=()=>{created++;throw Error('legacy should not create coordinator');};
 const t=new w.CastMagnetTransport({getStatus:()=>({nodeId:'self',clockReady:true}),getCoordinatorReport:()=>({requestedRenditions:['audio','v360'],neededRange:{start:1,end:5},cache:[]})});
 t.config={id:'legacy-cast',segmentVersion:2};t.role='viewer';t.sessionReady=true;t._send=()=>offers++;t._start();
 const wire={destroyed:false,extended(){}};const supplier={wire,auth:true,remote:{nodeId:'source',role:'source',trail:[],clockReady:true,downCount:0,relayLimit:2,health:{cache:[],sourceAgeSeconds:null}}};t.wires.set(wire,supplier);t._assign(supplier);
 assert.equal(created,0);assert.equal(offers,1);assert.equal(t.parentRequest,supplier);clearInterval(t.timer);
});
