import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context={window:{}};
vm.createContext(context);
vm.runInContext(await readFile(new URL('../room-status.js',import.meta.url),'utf8'),context);
const explain=context.window.SameEndRoomStatus.explain;
const room=state=>({connected:true,roomSource:{state}});
test('room without a source remains a chat room after ninety seconds',()=>{
  const result=explain({room:room('not-started'),elapsedSeconds:600});
  assert.equal(result.code,'waiting-for-source');assert.equal(result.waiting,true);assert.equal(result.roomJoined,true);
});
test('clean stopped sharing and an expired source lease have different explanations',()=>{
  assert.equal(explain({room:room('stopped')}).code,'source-stopped');
  assert.equal(explain({room:room('unreachable')}).code,'source-unreachable');
  assert.doesNotMatch(explain({room:room('unreachable')}).detail,/has left|has stopped|full/);
});
test('legacy presence and absence of peers cannot imply no source or full capacity',()=>{
  assert.equal(explain({room:room('unknown'),elapsedSeconds:91}).code,'no-direct-route');
  assert.equal(explain({room:room('sharing'),elapsedSeconds:91}).code,'no-direct-route');
  assert.equal(explain({snapshot:{joiningBusy:true},elapsedSeconds:91}).code,'no-direct-route');
});
test('playing authenticated cached media takes priority over stale presence or offline hint',()=>{
  const snapshot={config:{},role:'viewer',ready:4,paused:false,sourceReachable:false};
  const result=explain({snapshot,room:room('unreachable'),online:false});
  assert.equal(result.code,'playing');assert.match(result.detail,/saved video/);
  assert.equal(explain({snapshot,room:room('unreachable'),pictureMoving:false}).code,'source-unreachable');
});
test('connected source path wins over stale room presence',()=>{
  const snapshot={config:{},sourceReachable:true,clockReady:true,targetProgramTime:-8};
  assert.equal(explain({snapshot,room:room('unreachable')}).code,'warming-up');
});
test('capacity needs positive current local evidence and never claims a full room',()=>{
  const status=availability=>explain({snapshot:{transport:{availability}},room:room('sharing')});
  assert.equal(status({rootedSuppliers:0,fullSuppliers:0,eligibleSuppliers:0}).code,'finding-route');
  assert.equal(status({rootedSuppliers:2,fullSuppliers:1,eligibleSuppliers:1}).code,'finding-route');
  const full=status({rootedSuppliers:2,fullSuppliers:2,eligibleSuppliers:0});
  assert.equal(full.code,'suppliers-full');assert.doesNotMatch(full.title,/room is full/);
  assert.equal(status({lastReject:'capacity-full'}).code,'suppliers-full');
  assert.equal(status({lastReject:'unknown-private-reason'}).code,'finding-route');
});
test('offline and group warm-up are distinct from failed direct routing',()=>{
  assert.equal(explain({room:room('sharing'),online:false}).code,'offline');
  assert.equal(explain({snapshot:{config:{},clockReady:true,targetProgramTime:-300},room:room('sharing')}).code,'finding-route');
  assert.equal(explain({snapshot:{config:{},recovery:{state:'exhausted'}},room:room('sharing')}).code,'no-direct-route');
});
test('policy output contains only static messages and bounded classifications',()=>{
  const result=explain({room:{...room('unknown'),id:'private-key',name:'private-name'},snapshot:{config:{id:'private-id'},network:{phase:'failed',problem:'private-error'}}});
  assert.doesNotMatch(JSON.stringify(result),/private-/);assert.equal(typeof result.roomJoined,'boolean');
});

test('authenticated capture end remains a known stop while room state still advertises the old source',()=>{
 const result=explain({snapshot:{sourceEnded:true,config:null},room:room('sharing')});
 assert.equal(result.code,'source-stopped');assert.equal(result.roomJoined,true);assert.match(result.detail,/still in the room/);
});

test('adaptive rebuffering is an intentional wait, while moving playback and source evidence take priority',()=>{
 const snapshot={config:{},sourceReachable:true,clockReady:true,targetProgramTime:75,playbackAdaptivePhase:'rebuffering'};
 const result=explain({snapshot,room:room('sharing'),pictureMoving:false});
 assert.equal(result.code,'buffering');assert.equal(result.waiting,true);assert.match(result.detail,/chatting/);
 assert.equal(explain({snapshot:{...snapshot,ready:4,paused:false},room:room('sharing'),pictureMoving:true}).code,'playing');
 assert.equal(explain({snapshot:{...snapshot,sourceReachable:false},room:room('unreachable'),pictureMoving:false}).code,'source-unreachable');
 assert.equal(explain({snapshot:{...snapshot,sourceReachable:false},room:room('sharing'),pictureMoving:false}).code,'finding-route','lost path is not described as saving incoming media');
 assert.equal(explain({snapshot:{...snapshot,targetProgramTime:-2},room:room('sharing')}).code,'warming-up');
 assert.equal(explain({snapshot:{...snapshot,playbackAdaptivePhase:'PRIVATE'},room:room('sharing')}).code,'finding-route');
});


test('common delay presentation separates pending selection and the signed fallback',()=>{
 const groupDelay=context.window.SameEndRoomStatus.groupDelay,base={config:{delay:300}};
 assert.equal(groupDelay(base).label,'5-minute group delay');
 const pending={...base,clockReady:true,sourceReachable:true,targetProgramTime:-280,commonStart:{enabled:true,state:'pending'}};
 assert.equal(groupDelay(pending).seconds,null);assert.equal(explain({snapshot:pending}).title,'Checking group delay');
 assert.equal(groupDelay({...base,commonStart:{enabled:true,state:'selected',delaySeconds:30}}).label,'30-second group delay');
 assert.equal(groupDelay({...base,commonStart:{enabled:true,state:'fallback',delaySeconds:300}}).seconds,300);
 assert.equal(groupDelay({...base,commonStart:{enabled:true,state:'selected',delaySeconds:Infinity}}).seconds,300);
});

test('pending schedule needs a rooted clock-ready media path before capacity is classified',()=>{
 const pending={config:{},clockReady:false,sourceReachable:false,targetProgramTime:-280,commonStart:{enabled:true,state:'pending'},transport:{availability:{rootedSuppliers:1,fullSuppliers:1,eligibleSuppliers:0}}};
 assert.equal(explain({snapshot:pending,elapsedSeconds:0}).code,'suppliers-full');
 const noSupplier={...pending,transport:{availability:{rootedSuppliers:0,fullSuppliers:0,eligibleSuppliers:0}}};
 assert.equal(explain({snapshot:noSupplier,elapsedSeconds:0}).code,'finding-route');
 assert.equal(explain({snapshot:noSupplier,elapsedSeconds:91}).code,'no-direct-route');
});

test('scheduled warm-up still appears for a clock-ready active source, and generic target warm-up needs a path',()=>{
 const pending={config:{},role:'source',active:true,clockReady:true,commonStart:{enabled:true,state:'pending',reason:'waiting-for-first-viewer'}};
 assert.equal(explain({snapshot:pending}).title,'Ready for your mates');
 assert.equal(explain({snapshot:{config:{},clockReady:true,targetProgramTime:-2}}).code,'finding-route');
 assert.equal(explain({snapshot:{config:{},clockReady:true,sourceReachable:true,targetProgramTime:-2}}).code,'warming-up');
});
