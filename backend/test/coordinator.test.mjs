import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../store.mjs';
import {createCoordinator} from '../coordinator.mjs';

const base=(changes={})=>({role:'viewer',leafOnly:false,clockReady:true,sourceReachable:true,trail:[],parentId:null,children:[],relayLimit:1,sourceAgeSeconds:1,reserveSeconds:5,requestedRenditions:['audio'],cache:[{rendition:'audio',start:1,end:10,firstSeq:1,lastSeq:10}],outgoingMbps:2,queueBytes:0,...changes});
const report=(nodeId,report,seq=1,leaseToken)=>({action:'report',cast:'cast1',nodeId,seq,report,...(leaseToken?{leaseToken}:{})});
const setup=()=>{let time=1_000_000; const store=new MemoryStore(), coord=createCoordinator({store,now:()=>time}); return {store,coord,advance:ms=>time+=ms};};
test('lease binds updates to a node, sequence, cast, and expiry',async()=>{
 const {coord,advance}=setup(); const a=await coord('club',report('a',base()));
 await assert.rejects(coord('club',report('a',base(),2)),{code:'coordinator_lease'});
 await assert.rejects(coord('club',report('a',base(),1,a.leaseToken)),{code:'coordinator_lease'});
 await assert.rejects(coord('club',{...report('a',base(),2,a.leaseToken),cast:'other'}),{code:'coordinator_lease'});
 await coord('club',report('a',base(),2,a.leaseToken)); advance(15001);
 await assert.rejects(coord('club',report('a',base(),3,a.leaseToken)),{code:'coordinator_lease'});
 assert.ok((await coord('club',report('a',base()))).leaseToken);
});
test('only one racing reservation takes a supplier slot',async()=>{
 const {coord}=setup(); await coord('club',report('root',base({role:'source'})));
 const a=await coord('club',report('a',base({leafOnly:true}))),b=await coord('club',report('b',base({leafOnly:true})));
 const reserve=(nodeId,leaseToken)=>coord('club',{action:'reserve',cast:'cast1',nodeId,seq:2,leaseToken,supplierId:'root'});
 const results=await Promise.allSettled([reserve('a',a.leaseToken),reserve('b',b.leaseToken)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.find(x=>x.status==='rejected').reason.code,'coordinator_capacity');
});
test('filters leaf, stale, unrooted, loop, unknown bandwidth and missing rendition',async()=>{
 const {coord,advance}=setup(); await coord('club',report('root',base({role:'source',relayLimit:8})));
 await coord('club',report('leaf',base({leafOnly:true,parentId:'root'})));
 await coord('club',report('unrooted',base()));
 await coord('club',report('unknown',base({parentId:'root',outgoingMbps:null})));
 await coord('club',report('missing',base({parentId:'root',cache:[]})));
 await coord('club',report('loop',base({parentId:'viewer'})));
 const v=await coord('club',report('viewer',base({leafOnly:true})));
 assert.deepEqual(v.recommendations.map(x=>x.nodeId),['root','unknown']);
 advance(15001); const fresh=await coord('club',report('fresh',base({leafOnly:true})));
 assert.deepEqual(fresh.recommendations,[]);
});
test('rejects private or unbounded metadata and bounds responses',async()=>{
 const {coord,store}=setup();
 await assert.rejects(coord('club',report('bad',base({url:'https://secret'}))),{code:'invalid_coordinator'});
 await assert.rejects(coord('club',report('__proto__',base())),{code:'invalid_coordinator'});
 for(let i=0;i<8;i++) await coord('club',report(`s${i}`,base({role:'source',relayLimit:8})));
 const result=await coord('club',report('v',base({leafOnly:true})));
 assert.equal(result.recommendations.length,5); assert.deepEqual(Object.keys(result.recommendations[0]).sort(),['nodeId','reason','score']);
 assert.ok(!JSON.stringify(result).includes('tokenHash'));
 assert.equal((await store.get('CLUB#club','COORD#cast1')).expiresAt,1015);
});
test('release frees pending capacity and active parent consumes capacity',async()=>{
 const {coord}=setup(); await coord('club',report('root',base({role:'source'})));
 const a=await coord('club',report('a',base({leafOnly:true}))), b=await coord('club',report('b',base({leafOnly:true})));
 await coord('club',{action:'reserve',cast:'cast1',nodeId:'a',seq:2,leaseToken:a.leaseToken,supplierId:'root'});
 await coord('club',{action:'release',cast:'cast1',nodeId:'a',seq:3,leaseToken:a.leaseToken});
 await coord('club',{action:'reserve',cast:'cast1',nodeId:'b',seq:2,leaseToken:b.leaseToken,supplierId:'root'});
 await coord('club',report('b',base({leafOnly:true,parentId:'root'}),3,b.leaseToken));
 await assert.rejects(coord('club',{action:'reserve',cast:'cast1',nodeId:'a',seq:4,leaseToken:a.leaseToken,supplierId:'root'}),{code:'coordinator_capacity'});
});
test('limits a cast to 64 live nodes',async()=>{
 const {coord}=setup(); for(let i=0;i<64;i++) await coord('club',report(`n${i}`,base({leafOnly:true})));
 await assert.rejects(coord('club',report('extra',base())),{code:'coordinator_lease'});
});
test('neededRange requires complete rendition cache coverage',async()=>{
 const {coord}=setup(); await coord('club',report('root',base({role:'source'})));
 const a=await coord('club',report('a',base({leafOnly:true,neededRange:{start:2,end:9}})));
 const b=await coord('club',report('b',base({leafOnly:true,neededRange:{start:2,end:11}})));
 assert.equal(a.recommendations[0].nodeId,'root'); assert.equal(b.recommendations.length,0);
});

test('unmeasured viewer has one provisional slot; source has a declared two-slot budget',async()=>{
 const {coord,store}=setup(); const source=base({role:'source',relayLimit:2,outgoingMbps:null,sourceAgeSeconds:null,children:[]});
 await coord('club',report('root',source));const item=await store.get('CLUB#club','COORD#cast1');assert.equal(item.nodes.root.report.sourceAgeSeconds,null);
 const clients=[];for(const nodeId of ['x','y','z'])clients.push(await coord('club',report(nodeId,base({leafOnly:true,neededRange:{start:2,end:9}}))));
 assert.match(clients[0].recommendations[0].reason,/declared source slot; capacity unmeasured/);
 const reserve=(nodeId,client)=>coord('club',{action:'reserve',cast:'cast1',nodeId,seq:2,leaseToken:client.leaseToken,supplierId:'root'});
 const results=await Promise.allSettled(clients.map((c,i)=>reserve(['x','y','z'][i],c)));assert.equal(results.filter(x=>x.status==='fulfilled').length,2);assert.equal(results.filter(x=>x.status==='rejected').length,1);
});
test('an unmeasured rooted viewer has only one provisional slot',async()=>{
 const {coord,store}=setup();await coord('club',report('root',base({role:'source',relayLimit:2})));
 await coord('club',report('relay',base({parentId:'root',relayLimit:2,outgoingMbps:null,sourceAgeSeconds:null,children:[{nodeId:'child',queuedBytes:0,deliveredMbps:null,health:'degraded'}]})));
 const item=await store.get('CLUB#club','COORD#cast1');assert.equal(item.nodes.relay.report.children[0].deliveredMbps,null);
 const viewer=await coord('club',report('viewer',base({leafOnly:true})));assert.ok(!viewer.recommendations.some(x=>x.nodeId==='relay'));
});
test('zero recent throughput does not hide a source slot when its queue and relay budget allow it',async()=>{
 const {coord}=setup();
 await coord('club',report('source',base({role:'source',relayLimit:2,sourceAgeSeconds:null,outgoingMbps:0,children:[{nodeId:'existing',queuedBytes:0,deliveredMbps:0,health:'degraded'}]})));
 const viewer=await coord('club',report('viewer',base({leafOnly:true})));
 assert.ok(viewer.recommendations.some(candidate=>candidate.nodeId==='source'));
});
test('four concurrent peers renew across report intervals and expired leases can re-register',async()=>{
 const {coord,advance}=setup();const ids=['root','a','b','c'];
 const created=await Promise.all(ids.map(node=>coord('club',report(node,base(node==='root'?{role:'source',relayLimit:2}:{leafOnly:true})))));
 advance(4000);const renewed=await Promise.all(ids.map((node,i)=>coord('club',report(node,base(node==='root'?{role:'source',relayLimit:2}:{leafOnly:true}),2,created[i].leaseToken))));
 assert.ok(renewed.every((x,i)=>x.leaseToken===created[i].leaseToken));assert.ok(renewed.slice(1).every(x=>x.recommendations.some(r=>r.nodeId==='root')));
 advance(15001);await assert.rejects(coord('club',report('a',base({leafOnly:true}),3,renewed[1].leaseToken)),{code:'coordinator_lease'});
 const next=await coord('club',report('a',base({leafOnly:true})));assert.notEqual(next.leaseToken,created[1].leaseToken);
});
