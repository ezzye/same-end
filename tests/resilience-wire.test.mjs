import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const scope={window:{},module:{exports:{}},JSON,Array,Math,isFinite}; vm.runInNewContext(await readFile(new URL('../resilience-wire.js',import.meta.url),'utf8'),scope);
const w=scope.module.exports;
const config={segmentVersion:3,id:'cast',sourceId:'source',sourceEpoch:0,programId:'programme',alignmentVersion:1,epoch:100000,mime:'application/vnd.apple.mpegurl',renditions:['audio','v360','v480']};
const item=(overrides={})=>({v:3,cast:'cast',sourceId:'source',sourceEpoch:0,programId:'programme',programStartTime:0,alignmentVersion:1,seq:1,rendition:'v360',start:100000,duration:2000,size:100,mime:config.mime,hash:'A'.repeat(43),...overrides});
const plain=x=>JSON.parse(JSON.stringify(x));
test('v3 canonical data binds rendition and every timing and source field',()=>{
 assert.equal(scope.window.SameEndResilienceWire,w); const m=item(); assert.equal(w.validate(m,config),true);
 const data=JSON.parse(w.canonical(m)); assert.equal(data[0],'same-end-piece'); assert.equal(data[1],3); assert.equal(data[9],'v360');
 assert.notEqual(w.canonical(m),w.canonical({...m,rendition:'audio'})); assert.notEqual(w.identity(m),w.identity({...m,rendition:'audio'}));
 for(const field of ['cast','sourceId','sourceEpoch','programId','programStartTime','alignmentVersion','seq','start','duration','size','mime','hash']) assert.notEqual(w.canonical(m),w.canonical({...m,[field]:typeof m[field]==='number'?m[field]+1:m[field]+'x'}));
});
test('refuses downgrade, unknown rendition and inconsistent source, time, size and hash',()=>{
 const m=item(); for(const broken of [{v:2},{rendition:'v720'},{sourceId:'other'},{programId:'other'},{sourceEpoch:1},{programStartTime:10},{size:4194305},{duration:0},{hash:'bad'}]) assert.throws(()=>w.validate({...m,...broken},config));
 assert.throws(()=>w.validate(m,{...config,segmentVersion:2})); assert.throws(()=>w.validate(m,{...config,renditions:['audio']}));
});
test('ranges group only source-bound verified feed intervals by time, not sequence',()=>{
 const pieces=[item(),item({seq:5,start:102050,programStartTime:2050}),item({seq:6,start:104200,programStartTime:4200}),item({seq:2,rendition:'audio'}),item({seq:7,sourceId:'other',start:102000,programStartTime:2000}),item({seq:8,programStartTime:1,start:100010})];
 assert.deepEqual(plain(w.ranges(pieces,config.epoch)),[{rendition:'audio',start:0,end:2,firstSeq:2,lastSeq:2},{rendition:'v360',start:0,end:4.05,firstSeq:1,lastSeq:5},{rendition:'v360',start:4.2,end:6.2,firstSeq:6,lastSeq:6}]);
});
test('range list retains at most 16 recent intervals per feed',()=>{
 const p=Array.from({length:20},(_,i)=>item({seq:i,start:100000+i*4000,programStartTime:i*4000,duration:1000}));
 const r=plain(w.ranges(p,config.epoch)); assert.equal(r.length,16); assert.equal(r[0].firstSeq,4); assert.equal(r[15].lastSeq,19);
});
