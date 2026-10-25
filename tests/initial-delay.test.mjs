import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { AdaptivePlayout } from '../adaptive-playout.js';
import { Player, VerifiedHlsCache } from '../hls-player.js';
import { NativePlayer } from '../hls-native.js';

const code = await readFile(new URL('../initial-delay.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(code, { window, isFinite, Math });
const { Policy } = window.SameEndInitialDelay;
const measurement = (changes = {}) => ({
  state: 'observing', classification: 'live', recordCount: 11, observationSeconds: 20,
  lastProgressAgeSeconds: 0, gapP95Seconds: 2, deliveryToStreamRatio: .968,
  sourceAgeTrendSecondsPerSecond: 0,
  recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 9, candidateReserveSeconds: 6 }, ...changes
});
const input = (changes = {}) => ({ nowMs: 100000, sourceNowMs: 1300000, epoch: 1000000, healthy: true, everPlayed: false, measurement: measurement(), ...changes });
const facts = (changes = {}) => ({ minimumReserveSeconds: 4, programTime: 0, ready: true, aligned: true, cacheAheadSeconds: 8, decoderAheadSeconds: 8, ...changes });
const policy = () => new Policy({ enabled: true, roomDelaySeconds: 300 });

test('runtime default is disabled; healthy twenty-second live evidence pins exactly one target', () => {
  const disabled = new Policy({ roomDelaySeconds: 300 }); disabled.update(input());
  assert.equal(disabled.state, 'disabled'); assert.equal(disabled.selectedDelaySeconds, 300);
  const p = policy(); p.update(input({ measurement: measurement({ observationSeconds: 19.99 }) })); assert.equal(p.state, 'observing');
  p.update(input()); assert.equal(p.state, 'preparing'); assert.equal(p.targetProgramTime, 0); assert.equal(p.selectedDelaySeconds, 300);
  p.update(input({ nowMs: 101000, sourceNowMs: 1301000 })); assert.equal(p.targetProgramTime, 0, 'preparation cannot chase advancing source time');
  assert(p.commit(facts(), 1301000, 101000)); assert.equal(p.selectedDelaySeconds, 300); assert.equal(p.commitCount, 1);
  assert.equal(p.commit(facts(), 1302000, 102000), false); p.update(input({ healthy: false, everPlayed: true }));
  assert.equal(p.state, 'committed'); assert.equal(p.commitCount, 1);
  const snapshot = p.snapshot(1302000, 1000000, 2); assert.equal(snapshot.actualDelaySeconds, 300); assert.equal(snapshot.applied, true); assert.equal(snapshot.committedAtMs, 101000);
});

test('historical catchup, stale arrivals, unclocked or unhealthy routes cannot shorten startup', () => {
  for (const change of [
    { measurement: measurement({ classification: 'catchup' }) },
    { measurement: measurement({ lastProgressAgeSeconds: 4 }) },
    { sourceNowMs: null }, { healthy: false },
    { measurement: measurement({ recordCount: 5 }) }
  ]) { const p = policy(); p.update(input(change)); assert.equal(p.state, 'observing'); assert.equal(p.commitCount, 0); }
});

test('sustained .95x steady delivery with growing age is vetoed once growth exceeds arrival variance', () => {
  const p = policy(); p.update(input({ measurement: measurement({ observationSeconds: 50, deliveryToStreamRatio: .95, sourceAgeTrendSecondsPerSecond: .05, gapStddevSeconds: .03 }) }));
  assert.equal(p.state, 'fallback'); assert.equal(p.reason, 'sustained-delivery-deficit'); assert.equal(p.selectedDelaySeconds, 300);
  const quantised = policy(); quantised.update(input({ measurement: measurement({ deliveryToStreamRatio: .956, sourceAgeTrendSecondsPerSecond: 0 }) }));
  assert.equal(quantised.state, 'preparing', 'source-paced byte quantisation alone does not establish sustained deficit');
});
test('sustainable native bursts do not turn endpoint phase noise into a sustained deficit', () => {
 const p=policy();
 const burst=measurement({observationSeconds:59.747,deliveryToStreamRatio:.97335,sourceAgeTrendSecondsPerSecond:.02717,gapStddevSeconds:1.897,gapP95Seconds:4.644,recordCount:30});
 p.update(input({measurement:burst}));assert.equal(p.state,'preparing');assert.equal(p.selectedDelaySeconds,300);
 p.update(input({nowMs:101000,sourceNowMs:1301000,measurement:burst}));assert.equal(p.state,'preparing');assert(p.commit(facts(),1301000,101000));
});
test('early near-stream noise needs more evidence while explicit estimator throughput failure remains decisive', () => {
 const p=policy();p.update(input({sourceNowMs:1030000,measurement:measurement({deliveryToStreamRatio:.95,sourceAgeTrendSecondsPerSecond:.05,gapStddevSeconds:.03})}));assert.equal(p.state,'observing');
 p.update(input({nowMs:130000,sourceNowMs:1060000,measurement:measurement({observationSeconds:50,deliveryToStreamRatio:.95,sourceAgeTrendSecondsPerSecond:.05,gapStddevSeconds:.03})}));assert.equal(p.reason,'sustained-delivery-deficit');
 const explicit=policy();explicit.update(input({measurement:measurement({deliveryToStreamRatio:.65,sourceAgeTrendSecondsPerSecond:.01,gapStddevSeconds:3,recommendation:{status:'insufficient-throughput'}})}));assert.equal(explicit.reason,'sustained-delivery-deficit');
});

test('unsupported reserve, excessive group lag and already-started playback use conservative fallback', () => {
  for (const [change, reason] of [
    [{ measurement: measurement({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 30, candidateReserveSeconds: 13 } }) }, 'unsupported-reserve-goal'],
    [{ measurement: measurement({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 361, candidateReserveSeconds: 6 } }) }, 'candidate-exceeds-group-bound'],
    [{ everPlayed: true }, 'playback-already-started']
  ]) { const p = policy(); p.update(input(change)); assert.equal(p.state, 'fallback'); assert.equal(p.reason, reason); }
});

test('cache and decoder must separately cover the entire goal, aligned and ready', () => {
  const p = policy(); p.update(input());
  for (const change of [{ cacheAheadSeconds: 5.9 }, { decoderAheadSeconds: 5.8 }, { aligned: false }, { ready: false }, { minimumReserveSeconds: null }, { programTime: null }]) assert.equal(p.commit(facts(change), 1300000), false);
  assert(p.commit(facts({ minimumReserveSeconds: 6 }), 1300000));
  const native = policy(); native.update(input()); assert.equal(native.commit(facts({ minimumReserveSeconds: 15, decoderAheadSeconds: 20, cacheAheadSeconds: 20 }), 1300000), false);
  assert.equal(native.reason, 'unsupported-native-reserve');
});

test('route, clock, freshness, reserve increase and bounded preparation time revoke the pinned trial', () => {
  for (const change of [
    { healthy: false }, { sourceNowMs: null }, { measurement: measurement({ state: 'stale' }) },
    { measurement: measurement({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 10, candidateReserveSeconds: 7 } }) },
    { nowMs: 108001, sourceNowMs: 1308001 }
  ]) { const p = policy(); p.update(input()); p.update(input(change)); assert.equal(p.state, 'fallback'); p.update(input()); assert.equal(p.state, 'fallback', 'failed preparation cannot keep selecting new targets'); }
});

const bytes = value => new TextEncoder().encode(value);
function cache({ missingInit = false, gap = false, targetDuration = 2 } = {}) {
  const c = new VerifiedHlsCache();
  const files = [{ path: 'master.m3u8', bytes: bytes('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8\n') },
    { path: 'video.m3u8', bytes: bytes('#EXTM3U\n#EXT-X-TARGETDURATION:' + targetDuration + '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n' + Array.from({ length: 8 }, (_, i) => '#EXTINF:2,\ns' + i + '.m4s\n').join('')) },
    ...Array.from({ length: 8 }, (_, i) => ({ path: 's' + i + '.m4s', bytes: bytes('segment' + i) }))];
  if (!missingInit) files.push({ path: 'init.mp4', bytes: bytes('init') });
  c.add({ start: 14, duration: 2, playlistStart: 0, files: gap ? files.filter(file => file.path !== 's3.m4s') : files }); return c;
}
function decoder(C, options = {}) {
  const calls = [], p = Object.create(C.prototype), v = { currentTime: 4, readyState: 2, seeking: false, paused: true, muted: true,
    buffered: { length: 1, start: () => 0, end: () => 16 }, seekable: { length: 1, start: () => 0, end: () => 16 },
    pause() { calls.push('pause'); this.paused = true; }, play() { calls.push('play'); this.paused = false; return Promise.resolve(); } };
  Object.assign(p, { video: v, origin: 0, cache: cache(options), adaptive: new AdaptivePlayout(), closed: false, started: true, target: null,
    hls: { startLoad(...args) { calls.push(args); }, stopLoad() {} }, bridgeReady: true, initialProgrammeStart: 0, presented: null });
  return { p, v, calls };
}
for (const C of [Player, NativePlayer]) {
  test(C.name + ' prepares verified samples silently and only commits a ready contiguous window', async () => {
    const { p, v, calls } = decoder(C);
    const ready = p.prepareStartup(4, 6); assert.equal(ready.cacheAheadSeconds, 12); assert.equal(ready.decoderAheadSeconds, 12);
    await p.requestSound(); assert.equal(calls.includes('play'), false); assert(v.paused);
    assert.equal(p.sync(5).playing, false); assert.equal(p.adaptive.everPlayed, false);
    assert.equal(p.prepareStartup(5, 6), null, 'fixed preparation target');
    assert(p.commitStartup(4, 6)); assert.equal(p.adaptive.bufferGoalSeconds, 6); assert.equal(p.adaptive.position, 4);
    assert.equal(p.commitStartup(4, 6), false); assert.equal(p.sync(5).playing, true); assert.equal(p.adaptive.everPlayed, true);
  });
  test(C.name + ' rejects missing init and fragment gaps even when decoder metadata looks ready', () => {
    for (const options of [{ missingInit: true }, { gap: true }]) { const { p } = decoder(C, options); p.prepareStartup(4, 6); assert.equal(p.commitStartup(4, 6), false); }
  });
}
test('native preparation enforces three target durations and rejects unreachable goals', () => {
  const { p } = decoder(NativePlayer, { targetDuration: 5 }); p.prepareStartup(4, 6);
  assert.equal(p.startupFacts(4).minimumReserveSeconds, 15); assert.equal(p.commitStartup(4, 6), false);
});
test('native preparation may request missing target samples once, with commitment still waiting for decoding', () => {
 const {p,v}=decoder(NativePlayer);let current=0;const writes=[];
 Object.defineProperty(v,'currentTime',{get:()=>current,set:value=>{writes.push(value);current=value;}});
 v.buffered={length:1,start:()=>2,end:()=>14};v.seekable={length:1,start:()=>0,end:()=>14};
 const first=p.prepareStartup(.188,6);assert.equal(writes.length,1);assert.equal(writes[0],.188);
 assert.equal(first.decoderAheadSeconds,0);assert.equal(p.commitStartup(.188,6),false,'verified bytes and a completed seek cannot substitute for decoded samples');
 p.prepareStartup(.188,6);p.prepareStartup(.188,6);assert.equal(writes.length,1,'preparation cannot repeatedly seek');
 v.buffered={length:1,start:()=>0,end:()=>14};assert(p.commitStartup(.188,6));
});

test('late joins still observe once, and observation has a finite conservative deadline', () => {
 const p = policy(); p.update(input({ sourceNowMs: 1600000 })); assert.equal(p.state, 'preparing'); assert.equal(p.targetProgramTime, 300);
 const waiting = policy(); waiting.update(input({ measurement: null })); waiting.update(input({ nowMs: 160000, measurement: null })); assert.equal(waiting.state, 'fallback'); assert.equal(waiting.reason, 'observation-timeout');
});

for (const C of [Player, NativePlayer]) test(C.name + ' early sound gesture cannot bypass observation hold', async () => {
 const { p, calls } = decoder(C); p.startupHold = true; p.nominalTarget = 4; p.target = 4;
 await p.requestSound(); assert.equal(calls.includes('play'), false); assert.equal(p.adaptive.everPlayed, false);
 p.prepareStartup(4, 6); assert(p.commitStartup(4, 6)); assert.equal(p.startupHold, false);
});

test('common five-minute baseline survives the entire warmup and short estimates cannot accelerate it', () => {
 const p = policy();
 p.update(input({nowMs:100000,sourceNowMs:1030000}));
 assert.equal(p.state,'observing');assert.equal(p.candidateDelaySeconds,300);assert.equal(p.selectedDelaySeconds,300);
 p.update(input({nowMs:369000,sourceNowMs:1299000}));assert.equal(p.state,'observing');assert.equal(p.targetProgramTime,null);
 p.update(input({nowMs:370000,sourceNowMs:1300000}));assert.equal(p.state,'preparing');assert.equal(p.targetProgramTime,0);
 assert(p.commit(facts(),1300000,370000));assert.equal(p.selectedDelaySeconds,300);
});
test('device starting lag stays within sixty seconds of the common baseline', () => {
 const p=policy(),m=measurement({recommendation:{status:'unvalidated-candidate',candidateInitialDelaySeconds:316,candidateReserveSeconds:6}});
 p.update(input({measurement:m}));assert.equal(p.state,'observing');assert.equal(p.candidateDelaySeconds,316);
 p.update(input({nowMs:116000,sourceNowMs:1316000,measurement:m}));assert.equal(p.state,'preparing');assert.equal(p.targetProgramTime,0);assert(p.commit(facts(),1316000,116000));assert.equal(p.selectedDelaySeconds,316);
});
test('preparation cannot play an un-due target or consume more than the total group lag allowance', () => {
 const p=policy(),m=measurement({recommendation:{status:'unvalidated-candidate',candidateInitialDelaySeconds:360,candidateReserveSeconds:6}});
 p.update(input({sourceNowMs:1360000,measurement:m}));assert.equal(p.state,'preparing');
 assert.equal(p.commit(facts(),1360100,100100),false);assert.equal(p.reason,'preparation-outside-group-bound');
 const unDue=policy();unDue.update(input());assert.equal(unDue.commit(facts(),1299999,100001),false);
});
test('a pinned decoder tolerates an arrival-phase recommendation withdrawal without chasing or bypassing headroom', () => {
 const p=policy();p.update(input({measurement:measurement({routeAgeSeconds:60})}));
 const transient=measurement({lastProgressAgeSeconds:3.5,routeAgeSeconds:63.5,recommendation:{status:'insufficient-data',reason:'need-fresh-live-observations',candidateInitialDelaySeconds:null,candidateReserveSeconds:null}});
 p.update(input({nowMs:103500,sourceNowMs:1303500,measurement:transient}));
 assert.equal(p.state,'preparing');assert.equal(p.targetProgramTime,0);assert.equal(p.commitCount,0);
 assert.equal(p.commit(facts({decoderAheadSeconds:3}),1303500,103500),false);
 assert(p.commit(facts(),1303500,103500));assert.equal(p.commitCount,1);assert.equal(p.selectedDelaySeconds,300);
});
test('a pinned trial still aborts stale or unknown progress, reset routes and unclocked media', () => {
 for(const change of [
  {lastProgressAgeSeconds:12.1}, {state:'stale'}, {classification:'unknown'},
  {recordCount:0,observationSeconds:0,state:'insufficient-data'}, {routeAgeSeconds:1}
 ]){const p=policy();p.update(input({measurement:measurement({routeAgeSeconds:60})}));p.update(input({nowMs:101000,sourceNowMs:1301000,measurement:measurement(change)}));assert.equal(p.state,'fallback');assert.equal(p.commit(facts(),1301000,101000),false);}
});
