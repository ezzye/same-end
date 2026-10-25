import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context={TextEncoder,URL,window:{}};vm.createContext(context);vm.runInContext(await readFile(new URL('../waiting-core.js',import.meta.url),'utf8'),context);const core=context.window.SameEndWaitingCore;
test('only a verified playable frame at the actual group target yields the waiting screen',()=>{
 const ready={config:{},clockReady:true,targetProgramTime:12,programTime:12,ready:2,mediaDiagnostics:{delivery:{requiredPiecePresent:true}}};
 assert.equal(core.explain(ready,{},{}).visible,false);
 for(const patch of [{ready:1},{programTime:2},{mediaDiagnostics:{delivery:{requiredPiecePresent:false}}},{clockReady:false},{targetProgramTime:-10}])assert.equal(core.explain({...ready,...patch},{},{}).visible,true);
});
test('source absence and stale presence preserve honest explanations without a fixed timer or sponsor',()=>{
 for(const code of ['source-stopped','source-unreachable','waiting-for-source']){const r=core.explain({}, {connected:true},{code,title:'Known source status',detail:'Still in the room'});assert.equal(r.visible,true);assert.equal(r.title,'Known source status');assert.equal(r.seconds,null);assert.equal(r.allowSponsor,false);assert.equal(r.canFetch,false);}
});
test('adaptive playback uses its effective position and never covers healthy locally delayed video',()=>{
 const s={config:{},clockReady:true,targetProgramTime:70,effectiveTargetProgramTime:20,programTime:20,ready:2,paused:false,playbackAdaptivePhase:'playing',mediaDiagnostics:{delivery:{requiredPiecePresent:false}}};
 assert.equal(core.explain(s,{},{}).visible,false);
 for(const phase of ['starting','rebuffering','recovering'])assert.equal(core.explain({...s,playbackAdaptivePhase:phase,mediaDiagnostics:{delivery:{requiredPiecePresent:true}}},{},{code:'buffering',title:'Building a smoother picture'}).visible,true);
});
test('warmup follows source clock and late join never adds a fresh five minutes',()=>{
 const r=core.explain({config:{},clockReady:true,targetProgramTime:-14.2,sourceReachable:true},{},{code:'warming-up'});assert.equal(r.seconds,15);assert.match(r.detail,/0:15/);
 const later=core.explain({config:{},clockReady:true,targetProgramTime:20,sourceReachable:true},{},{code:'finding-route'});assert.equal(later.seconds,null);assert.equal(later.allowSponsor,false);assert.equal(later.title,'Preparing the picture');
});
test('initial buffer content stays hidden after a picture while a returning tab rebuilds locally',()=>{
 const s={config:{},clockReady:true,targetProgramTime:25,programTime:22,ready:1,paused:true,sourceReachable:true,playbackAdaptivePhase:'rebuffering'};
 assert.equal(core.explain(s,{},{code:'buffering'}).visible,true,'first join still explains preparation');
 for(const patch of [{},{clockReady:false},{targetProgramTime:-8},{playbackAdaptivePhase:'recovering'}]){
  const r=core.explain({...s,...patch},{},{code:'buffering'},{hasPlayed:true});assert.equal(r.visible,false);assert.equal(r.state,'resuming');
 }
 const failure=core.explain({...s,sourceReachable:false},{connected:true},{code:'source-unreachable',title:'The source left'},{hasPlayed:true});assert.equal(failure.visible,true);assert.equal(failure.title,'The source left');
});
test('waiting pack rejects oversized/unknown formats and removes links, media and invitation material',()=>{
 assert.equal(core.cleanPack({items:[{body:'x'.repeat(50001)}]}),null);
 const pack=core.cleanPack({revision:'r1',items:[{id:'a',type:'story',title:'Good',body:'Useful text',html:'<img>',video:'https://x'},{id:'b',type:'video',title:'No',body:'Video'},{id:'c',type:'story',title:'Private #club=secret',body:'Do not include'},{id:'d',type:'ad',title:'Sponsor',body:'Supported',sponsor:'Test',url:'javascript:alert(1)'}]});
 assert.equal(pack.items.length,2);assert.equal(pack.items[0].html,undefined);assert.equal(pack.items[0].video,undefined);assert.equal(pack.items[1].url,'');
});
test('quiz answer structure and campaign schedule are bounded',()=>{
 const quiz={id:'quiz',type:'quiz',title:'Question',body:'Pick one',choices:['A','B'],answerIndex:1};
 assert.equal(core.cleanPack({items:[quiz]},100).items.length,1);
 for(const patch of [{answerIndex:8},{choices:['A']},{endsAt:100},{startsAt:200}])assert.equal(core.cleanPack({items:[{...quiz,...patch}]},100).items.length,0);
});
