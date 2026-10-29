import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const code = await readFile(new URL('../resilience-policy.js', import.meta.url), 'utf8');
const scope = { window: {}, module: { exports: {} }, Date, Math, Array, isFinite }; vm.runInNewContext(code, scope);
const { Policy } = scope.module.exports;
function fixture(options = {}) {
  let time = 100000;
  const policy = new Policy({ now: () => time, ...options });
  let state = { playing: true, visible: true, online: true, sourceReachable: true, reserve: { audio: 12, v360: 12, v480: 12 }, lastAge: { audio: 1, v360: 1, v480: 1 }, availableRenditions: ['audio','v360','v480'] };
  return { policy, tick(seconds, patch = {}) { time += seconds * 1000; state = { ...state, ...patch }; return policy.update({ ...state, nowMs: time }); }, record(rendition, seq, endOffset=0) { return policy.record({ rendition, seq, start: time - 2000 + endOffset, duration: 2000 }, 1000, time); }, get time() { return time; } };
}
const plain = v => JSON.parse(JSON.stringify(v));
test('exports for browser and CommonJS; startup and sustained deficits with cooldown', () => {
  assert.equal(scope.window.SameEndResiliencePolicy.Policy, Policy);
  const f=fixture({initialMode:'v480'}); assert.equal(f.tick(1,{reserve:{v480:1},lastAge:{v480:1}}).mode,'v480');
  assert.equal(f.tick(12).mode,'v480'); const down=f.tick(6); assert.equal(down.mode,'v360'); assert.equal(down.reason,'sustained-deficit'); assert.equal(down.changed,true);
  assert.equal(f.tick(1,{reserve:{v360:1},lastAge:{v360:1}}).mode,'v360'); assert.equal(f.tick(6).mode,'audio');
});
test('audio stability cannot prove video; probe requires fresh distinct video records and reserve', () => {
  const f=fixture({initialMode:'audio'}); f.tick(13); assert.equal(f.tick(20).probe,'v360');
  for(let i=0;i<4;i++) { f.record('audio',i); f.tick(1); }
  assert.equal(f.policy.snapshot().mode,'audio');
  f.record('v360',1,-40000); f.record('v360',2,-40000); assert.equal(f.tick(1).mode,'audio');
  assert.equal(f.record('v360',3),true); assert.equal(f.record('v360',3),false); assert.equal(f.tick(1,{reserve:{audio:12,v360:2},lastAge:{audio:1,v360:1}}).mode,'audio');
  f.record('v360',4); const promoted=f.tick(1,{reserve:{audio:12,v360:6},lastAge:{audio:1,v360:1}}); assert.equal(promoted.mode,'v360'); assert.equal(promoted.reason,'probe-verified');
});
test('probe timeout backs off; hidden, offline and unknown observations cannot trigger a fall or upgrade', () => {
  const f=fixture({initialMode:'audio'}); f.tick(13); f.tick(20); assert.equal(f.tick(20).reason,'probe-failed');
  assert.equal(f.tick(2,{visible:false}).phase,'paused'); assert.equal(f.tick(20,{visible:true,playing:false}).phase,'startup');
  assert.equal(f.tick(12,{playing:true,reserve:{audio:null},lastAge:{audio:null}}).reason,'insufficient-data'); assert.equal(f.tick(200).mode,'audio');
  assert.equal(f.tick(1,{online:false}).reason,'offline');
});
test('no source sound cannot switch to audio and explicit preference respects cap', () => {
  const f=fixture({audioAvailable:false, maxMode:'v360'}); assert.equal(f.policy.setPreference('audio'),false); assert.equal(f.policy.setPreference('v480'),false);
  f.tick(13,{reserve:{v360:0},lastAge:{v360:9}}); const r=f.tick(7); assert.equal(r.mode,'v360'); assert.equal(r.reason,'no-lower-rendition');
});
test('available feed failure and requested union avoid unavailable renditions', () => {
  const f=fixture({initialMode:'v480'}); const state=f.tick(1,{availableRenditions:['audio','v360']}); assert.equal(state.mode,'v360'); assert.equal(state.reason,'rendition-unavailable');
  assert.deepEqual(plain(f.policy.requestedRenditions(['v480','v360','audio'])),['audio','v360']);
  assert.equal(f.tick(1,{availableRenditions:[]}).phase,'unavailable'); assert.deepEqual(plain(f.policy.requestedRenditions(['v360'])),[]);
});
test('video upgrade waits longer, tests target specifically, and preference can lower immediately', () => {
  const f=fixture(); f.tick(13); assert.equal(f.tick(59).probe,null); assert.equal(f.tick(1).probe,'v480');
  f.record('v360',1); f.record('v360',2); assert.equal(f.tick(1).mode,'v360'); f.record('v480',3); f.record('v480',4);
  assert.equal(f.tick(1).mode,'v480'); f.policy.setPreference('v360'); assert.equal(f.tick(1).mode,'v360');
});

test('five-minute delayed playout promotes only new, recently transferred pieces near the playhead', () => {
 const f=fixture({initialMode:'audio'});f.tick(13);const oldTarget=f.time-300000;
 f.policy.record({rendition:'v360',seq:1,start:oldTarget-2000,duration:2000},1000,f.time);
 f.tick(20,{playbackNowMs:f.time+20000-300000});assert.equal(f.policy.snapshot().probe,'v360');
 const target=f.time-300000;
 // A replay with the same key and two unrelated near-live pieces cannot pass.
 assert.equal(f.policy.record({rendition:'v360',seq:1,start:target-2000,duration:2000},1000,f.time),false);
 f.policy.record({rendition:'v360',seq:2,start:f.time-2000,duration:2000},1000,f.time);
 f.policy.record({rendition:'v360',seq:3,start:f.time-2000,duration:2000},1000,f.time);
 assert.equal(f.tick(1,{playbackNowMs:f.time+1000-300000}).mode,'audio');
 f.policy.record({rendition:'v360',seq:4,start:target-2000,duration:2000},1000,f.time);
 assert.equal(f.tick(1,{playbackNowMs:f.time+1000-300000}).mode,'audio');
 f.policy.record({rendition:'v360',seq:5,start:target,duration:2000},1000,f.time);
 assert.equal(f.tick(1,{playbackNowMs:f.time+1000-300000}).reason,'probe-verified');
});
test('unknown playhead and old receipts cannot authorize an upgrade', () => {
 const f=fixture({initialMode:'audio'});f.tick(13);f.tick(20,{playbackNowMs:null});
 f.record('v360',1);f.record('v360',2);assert.equal(f.tick(1).mode,'audio');
 assert.equal(f.tick(19).reason,'probe-failed');
 const g=fixture({initialMode:'audio'});g.tick(13);g.tick(20,{playbackNowMs:g.time+20000-300000});
 const target=g.time-300000;g.policy.record({rendition:'v360',seq:10,start:target-2000,duration:2000},1000,g.time);
 g.policy.record({rendition:'v360',seq:11,start:target,duration:2000},1000,g.time);
 assert.equal(g.tick(16,{playbackNowMs:target+16000}).mode,'audio');
 assert.equal(g.tick(4,{playbackNowMs:target+20000}).reason,'probe-failed');
});
