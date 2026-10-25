import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { commitStartup } from '../hls-player.js';
import { contiguousRanges, headroomAt } from '../adaptive-playout.js';
import { encodeBundle, decodeBundle } from '../hls-protocol.js';

const engine = await readFile(new URL('../engine.js', import.meta.url), 'utf8');
const commonCode = await readFile(new URL('../common-start.js', import.meta.url), 'utf8');
const initialCode = await readFile(new URL('../initial-delay.js', import.meta.url), 'utf8');
const enc = new TextEncoder(), epoch = 1700000000000;
const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const b64 = value => Buffer.from(value).toString('base64url');
const measurement = () => ({ state: 'observing', classification: 'live', recordCount: 11, observationSeconds: 20,
  lastProgressAgeSeconds: 0, routeAgeSeconds: 22, gapP95Seconds: 2, gapStddevSeconds: 0,
  deliveryToStreamRatio: 1, sourceAgeTrendSecondsPerSecond: 0,
  recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 9, candidateReserveSeconds: 6 } });
function slice(start, end) {
  const from = engine.indexOf(start), to = engine.indexOf(end, from);
  assert(from >= 0 && to > from, `missing engine slice: ${start}`);
  return engine.slice(from, to);
}
function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), release: value => resolve(value) };
}
function harness({ role = 'viewer', subtle = webcrypto.subtle, nativeMinimum = 4, decoderAhead = 12, version = 1, cacheHeadroom = false } = {}) {
  let time = epoch + 22000;
  const sent = [], trace = [], elements = {}, enqueued = [];
  const config = { id: 'cast', epoch, delay: 300, mime: 'application/vnd.apple.mpegurl', mediaProfile: 'hls-cmaf-v1',
    commonStartVersion: version, segmentVersion: 2, sourceId: 'source', sourceEpoch: 0, programId: 'programme' };
  const state = { config, role, key, pub: key.publicKey, offset: 0, clockReady: true, stopped: false,
    peers: new Map(), cache: [{ meta: { seq: 0, start: epoch, duration: 2000 } }], cacheBytes: 0, appendedSeq: new Set(), lastAppendSeq: -1,
    nodeId: role === 'source' ? 'root-node' : 'viewer-node', sourceReachable: true, playbackStarted: false,
    stalls: 0, waiting: false, drift: null };
  function player() {
    const p = { startupHold: role !== 'source' || version !== 2, startupPreparation: null, soundRequested: true,
      adaptive: { everPlayed: false, reset() { this.everPlayed = false; } },
      startupFacts: target => ({ minimumReserveSeconds: nativeMinimum, programTime: target, ready: true, aligned: true,
        cacheAheadSeconds: cacheHeadroom ? headroomAt(contiguousRanges(state.cache.map(piece => ({ start: (piece.meta.start - epoch) / 1000, end: (piece.meta.start + piece.meta.duration - epoch) / 1000 }))), target) : 12,
        decoderAheadSeconds: p.decoderAhead }), decoderAhead,
      prepareStartup(target, reserve) { trace.push(['prepare', target, reserve]); this.startupPreparation ||= { target, reserve }; return this.startupFacts(target); },
      commitStartup(target, reserve) { trace.push(['commit', target, reserve]); return commitStartup(this, target, reserve); },
      close() { trace.push(['close']); }, facts: () => ({}), enqueue() {}, lookAheadSeconds: () => 16,
      setPlaybackWindow(target) { trace.push(['window', target]); }, getPlaybackTarget: target => target,
      sync(target) { trace.push(['sync', target]); if (target < 0) return { waiting: true }; this.adaptive.everPlayed = true; return { waiting: false, drift: 0 }; } };
    return p;
  }
  state.player = player();
  const ctx = { state, window: { SameEndConfig: { automaticInitialDelay: true } }, crypto: { subtle }, enc,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, Number, Math, Object, JSON, Map, Set, Promise,
    now: () => time, un64: value => new Uint8Array(Buffer.from(value, 'base64url')), b64,
    hash: async value => b64(new Uint8Array(await webcrypto.subtle.digest('SHA-256', value))),
    $: id => elements[id] ||= { muted: true, paused: true, textContent: '', pause() { trace.push(['element-pause']); this.paused = true; } },
    document: { visibilityState: 'visible' }, navigator: { onLine: true },
    downstream: () => [...state.peers.values()].filter(p => p.direction === 'down' && !p.closed),
    label: () => 'friend', lifecycle: () => trace.push(['lifecycle']), status: value => trace.push(['status', value]), update() {},
    clientDeliverySnapshot: measurement, sampleClientDelivery: measurement,
    createRoomPlayer: player, roomPlayerCallbacks: () => ({}), cleanCache() {},
    enqueue: (p, piece) => enqueued.push({ peer: p.id, seq: piece.meta.seq }),
    stallOutgoing: null, resumeAfter: () => -1 };
  vm.createContext(ctx);
  vm.runInContext(commonCode + '\n' + initialCode, ctx);
  vm.runInContext(engine.split('\n').find(line => line.startsWith('function isHlsConfig(')), ctx);
  for (const [start, end] of [
    ['function commonDelaySeconds()', 'function playbackStatus()'],
    ['function resetCommonStart()', 'function advanceInitialDelay()'],
    ['function send(', 'function makePeer('],
    ['function stageWindow()', 'async function end('],
    ['async function handleControl(', 'function dropPeer(']
  ]) vm.runInContext(slice(start, end), ctx);
  ctx.advanceInitialDelay = () => {};
  ctx.resetCommonStart();
  return { ctx, state, sent, trace, enqueued, elements, tick: delta => { time += delta; },
    peer(id, direction = 'up') {
      const p = { id, direction, ready: true, closed: false, commonStartVersion: version, commonNodeId: id,
        queued: 0, lastSentSeq: -1, playbackLagSeconds: 0,
        channel: { readyState: 'open', send: text => sent.push({ peer: id, message: JSON.parse(text) }) } };
      state.peers.set(id, p); return p;
    },
    report: () => ctx.window.SameEndCommonStart.reportFromMeasurement(measurement(), time),
    async signingDone() {
      // WebCrypto settles on a worker; a count of immediate ticks can exhaust in
      // a few milliseconds on CI before that worker has run.
      const deadline = performance.now() + 2000;
      while (state.commonStart?.signing && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(state.commonStart?.signing, false, 'source signing did not settle');
    } };
}
async function decision(h, changes = {}, signer = key) {
  const c = h.state.config;
  const d = { type: 'common-start', version: c.commonStartVersion, decisionNumber: 1, cast: c.id, sourceId: c.sourceId,
    sourceEpoch: c.sourceEpoch, programId: c.programId, delaySeconds: 30, reserveSeconds: 6,
    issuedAt: epoch + 22000, startsAt: c.epoch + 30000, reason: 'verified-delivery',
    ...(c.commonStartVersion === 2 ? { startsAt: c.epoch + 34000, programmeTime: 4, observationStartedAt: epoch + 2000 } : {}), ...changes };
  d.sig = b64(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey,
    enc.encode(h.ctx.window.SameEndCommonStart.canonicalDecision(d))));
  return d;
}
const hello = (h, d, fields = {}) => ({ type: 'hello', cast: h.state.config.id, commonStartVersion: h.state.config.commonStartVersion, commonStartDecision: d, ...fields });

test('pending common start prepares source programme zero while keeping the viewer playback window negative', () => {
  for (const role of ['source', 'viewer']) {
    const h = harness({ role }); h.ctx.syncPlayback();
    assert.equal(h.state.commonStart.decision, null); assert.equal(h.state.player.startupHold, true);
    assert.equal(h.ctx.effectiveProgramTime(), 0); assert.equal(h.ctx.nominalProgramTime(), -278);
    assert.equal(h.trace.some(row => row[0] === 'sync'), false);
    assert.equal(h.trace.filter(row => row[0] === 'window').at(-1)[1], role === 'source' ? 0 : -278);
  }
});

test('a pending viewer keeps cache delivery and forwarding active while its actual staged window stays negative until the selected common moment', async () => {
  const h = harness(), parent = h.peer('parent'); h.peer('child', 'down');
  const local = []; h.state.player.enqueue = piece => local.push(piece.meta.seq);
  h.ctx.stageWindow();
  assert.equal(h.trace.filter(row => row[0] === 'window').at(-1)[1], -278);
  assert.deepEqual(local, [0], 'verified media still enters the local cache-backed player during warmup');
  assert.deepEqual(h.enqueued.filter(row => row.peer === 'child').map(row => row.seq), [0]);
  await h.ctx.handleCommonHello(parent, hello(h, await decision(h)));
  h.state.cache.push({ meta: { seq: 1, start: epoch + 2000, duration: 2000 } });
  h.ctx.stageWindow();
  assert.equal(h.trace.filter(row => row[0] === 'window').at(-1)[1], -8);
  assert.deepEqual(local, [0, 1]);
  assert.deepEqual(h.enqueued.filter(row => row.peer === 'child').map(row => row.seq), [0, 1]);
  h.tick(7000); h.ctx.stageWindow();
  assert.equal(h.trace.filter(row => row[0] === 'window').at(-1)[1], -1);
  assert(h.trace.filter(row => row[0] === 'window').every(row => row[1] < 0));
  h.tick(2000); h.ctx.stageWindow();
  assert.equal(h.trace.filter(row => row[0] === 'window').at(-1)[1], 1);
  assert.equal(h.ctx.commonDelaySeconds(), 30);
  // This checks the real staging input, not AVPlayer behavior. The native
  // headroom guard alone did not prove the warmup jump fixed; browser evidence
  // must establish the combined path independently.
});

test('only the source selects and signs; host preparation commits once and viewers share its signed timeline', async () => {
  const source = harness({ role: 'source' }), child = source.peer('child', 'down');
  child.commonReports = [{ id: 'child', report: source.report() }];
  source.ctx.advanceCommonStart(); await source.signingDone();
  const d = source.state.commonStart.decision;
  assert(d); assert.equal(d.delaySeconds, 30); assert.equal(source.state.config.delay, 300);
  assert.equal(source.state.player.startupPreparation, null); assert.equal(source.state.player.startupHold, false);
  assert.deepEqual(source.trace.filter(row => row[0] === 'commit'), [['commit', 0, 6]]);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey,
    Buffer.from(d.sig, 'base64url'), enc.encode(source.ctx.window.SameEndCommonStart.canonicalDecision(d))), true);
  const viewer = harness(), parent = viewer.peer('parent');
  viewer.ctx.advanceCommonStart(); assert.equal(viewer.state.commonStart.decision, null, 'viewer cannot sign its own choice');
  await viewer.ctx.handleControl(parent, hello(viewer, d));
  assert.equal(viewer.ctx.nominalProgramTime(), source.ctx.nominalProgramTime());
  assert.equal(viewer.ctx.commonDelaySeconds(), 30); assert.equal(viewer.state.initialDelayPolicy.roomDelaySeconds, 30);
  assert.equal(viewer.state.player.startupHold, true, 'viewer still proves its own decoder admission');
  source.ctx.advanceCommonStart(); assert.equal(source.trace.filter(row => row[0] === 'commit').length, 1);
});

test('signed decisions travel in existing hello and new downstream peers receive the latched decision', async () => {
  const h = harness(), parent = h.peer('parent'), child = h.peer('child', 'down'), d = await decision(h);
  await h.ctx.handleCommonHello(parent, hello(h, d));
  const broadcasts = h.sent.filter(row => row.message.commonStartDecision);
  assert(broadcasts.some(row => row.peer === 'child'));
  assert(broadcasts.every(row => row.message.type === 'hello'));
  const late = h.peer('late-child', 'down'); h.ctx.send(late, { type: 'hello', cast: h.state.config.id });
  assert.equal(h.sent.at(-1).message.commonStartDecision.sig, d.sig);
  assert.equal(h.sent.at(-1).message.commonStartVersion, 1);
});

test('wrong identity and downstream decisions cannot authorize timing; wrong signing key is rejected', async () => {
  const h = harness(), parent = h.peer('parent'), child = h.peer('child', 'down');
  await h.ctx.handleCommonHello(parent, hello(h, await decision(h, { sourceId: 'other' })));
  assert.equal(h.state.commonStart.decision, null);
  await h.ctx.handleCommonHello(child, hello(h, await decision(h)));
  assert.equal(h.state.commonStart.decision, null);
  const otherKey = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await assert.rejects(h.ctx.handleCommonHello(parent, hello(h, await decision(h, {}, otherKey))), /Unverified shared starting time/);
  assert.equal(h.state.commonStart.decision, null);
});

test('one signed decision latches; replays are inert and a second valid signature is a conflict without retiming', async () => {
  const h = harness(), parent = h.peer('parent'), d = await decision(h);
  await h.ctx.handleCommonHello(parent, hello(h, d));
  const latch = h.state.commonStart.decision, id = h.state.commonStart.decisionId, nominal = h.ctx.nominalProgramTime();
  await h.ctx.handleCommonHello(parent, hello(h, d));
  assert.strictEqual(h.state.commonStart.decision, latch); assert.equal(h.state.commonStart.decisionId, id);
  h.tick(600);
  await assert.rejects(h.ctx.handleCommonHello(parent, hello(h, await decision(h, { delaySeconds: 32, startsAt: epoch + 32000 }))), /Conflicting shared starting time/);
  assert.equal(h.state.commonStart.conflict, true); assert.strictEqual(h.state.commonStart.decision, latch);
  assert(Math.abs(h.ctx.nominalProgramTime() - nominal - .6) < 1e-9);
});

test('a bad supplier signature does not poison verification for its valid replacement', async () => {
  const h = harness(), bad = h.peer('bad'), d = await decision(h), forged = { ...d, sig: b64(new Uint8Array(64)) };
  await assert.rejects(h.ctx.handleCommonHello(bad, hello(h, forged)), /Unverified shared starting time/);
  bad.closed = true; h.state.peers.delete(bad.id); const replacement = h.peer('replacement');
  await h.ctx.handleCommonHello(replacement, hello(h, d));
  assert.equal(h.state.commonStart.decision.delaySeconds, 30);
});

test('an old-cast signature finishing asynchronously cannot adopt into a replacement cast', async () => {
  const gate = deferred(), entered = deferred();
  const subtle = { async verify(...args) { entered.release(); await gate.promise; return webcrypto.subtle.verify(...args); } };
  const h = harness({ subtle }), parent = h.peer('parent'), task = h.ctx.handleCommonHello(parent, hello(h, await decision(h)));
  await entered.promise;
  h.state.config = { ...h.state.config, id: 'replacement-cast' }; h.ctx.resetCommonStart();
  gate.release(); await task;
  assert.equal(h.state.commonStart.decision, null); assert.equal(h.state.commonStart.conflict, false);
});

test('supplier departure during verification and a decision after first picture cannot retime playback', async () => {
  const gate = deferred(), entered = deferred();
  const h = harness({ subtle: { async verify(...args) { entered.release(); await gate.promise; return webcrypto.subtle.verify(...args); } } });
  const parent = h.peer('parent'), task = h.ctx.handleCommonHello(parent, hello(h, await decision(h)));
  await entered.promise; parent.closed = true; h.state.peers.delete(parent.id); gate.release(); await task;
  assert.equal(h.state.commonStart.decision, null);
  const played = harness(), supplier = played.peer('parent'); played.state.playbackStarted = true;
  await played.ctx.handleCommonHello(supplier, hello(played, await decision(played)));
  assert.equal(played.state.commonStart.decision, null); assert.equal(played.state.commonStart.conflict, true);
});

test('host signing completion from a superseded cast cannot resurrect its decision', async () => {
  const gate = deferred(), entered = deferred();
  const h = harness({ role: 'source', subtle: { async sign(...args) { entered.release(); await gate.promise; return webcrypto.subtle.sign(...args); } } });
  const child = h.peer('child', 'down'); child.commonReports = [{ id: 'child', report: h.report() }];
  h.ctx.advanceCommonStart(); await entered.promise;
  const previous = h.state.commonStart; h.state.config = { ...h.state.config, id: 'replacement-cast' }; h.ctx.resetCommonStart();
  gate.release();
  for (let i = 0; previous.signing && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(previous.signing, false); assert.equal(h.state.commonStart.decision, null);
});

test('modern forwarding follows common delay; legacy children retain the configured history and local lag stays bounded', async () => {
  const h = harness(), parent = h.peer('parent'); await h.ctx.handleCommonHello(parent, hello(h, await decision(h)));
  parent.closed = true; h.state.peers.delete(parent.id); h.tick(378000);
  h.peer('modern', 'down'); const legacy = h.peer('legacy', 'down'); legacy.commonStartVersion = 0;
  h.state.cache = [{ meta: { seq: 1, start: epoch + 110000, duration: 2000 } }, { meta: { seq: 2, start: epoch + 365000, duration: 2000 } }];
  h.ctx.stageWindow();
  assert.deepEqual(h.enqueued.filter(row => row.peer === 'modern').map(row => row.seq), [2]);
  assert.deepEqual(h.enqueued.filter(row => row.peer === 'legacy').map(row => row.seq), [1, 2]);
  assert.equal(h.ctx.retentionCutoff(), epoch + 10000);
  const nominal = h.ctx.nominalProgramTime(); h.state.player.getPlaybackTarget = () => nominal - 200;
  assert.equal(h.ctx.effectiveProgramTime(), nominal - 60);
  assert.equal(h.state.config.delay, 300); assert.equal(h.ctx.commonDelaySeconds(), 30);
});

test('aggregation overflow remains visible rather than silently excluding an unready descendant', () => {
  const h = harness({ role: 'source' }), child = h.peer('child', 'down');
  child.commonReports = Array.from({ length: 8 }, (_, i) => ({ id: `descendant-${i}`, report: i === 7 ? null : h.report() }));
  const fields = h.ctx.commonHelloFields();
  assert.equal(fields.commonStartUnsupported, true);
  h.ctx.advanceCommonStart();
  assert.equal(h.state.commonStart.policy.snapshot().decision.delaySeconds, 300);
});

test('host decoder minimum is covered before signing and becomes part of the signed reserve', async () => {
  const h = harness({ role: 'source', nativeMinimum: 12, decoderAhead: 6 }), child = h.peer('child', 'down');
  child.commonReports = [{ id: 'child', report: h.report() }];
  h.ctx.advanceCommonStart(); assert.equal(h.state.commonStart.signing, false); assert.equal(h.state.commonStart.decision, null);
  h.state.player.decoderAhead = 12; h.ctx.advanceCommonStart(); await h.signingDone();
  assert.equal(h.state.commonStart.decision.reserveSeconds, 12);
  assert.deepEqual(h.trace.filter(row => row[0] === 'commit'), [['commit', 0, 12]]);
  assert.equal(h.trace.some(row => row[0] === 'close'), false, 'a signed accelerated choice must not immediately discard unprepared host media');
});

test('the host prepares the actual first signed timestamp without rewriting the common logical clock', async () => {
  const h = harness({ role: 'source' }), child = h.peer('child', 'down');
  h.state.cache[0].meta.start = epoch + 196;
  child.commonReports = [{ id: 'child', report: h.report() }];
  h.ctx.advanceCommonStart(); await h.signingDone();
  assert.equal(h.state.commonStart.preparationTarget, .196);
  assert.deepEqual(h.trace.filter(row => row[0] === 'commit'), [['commit', .196, 6]]);
  assert.equal(h.state.commonStart.decision.startsAt, epoch + 30000);
  assert.equal(h.ctx.nominalProgramTime(), -8);
  assert.equal(h.state.config.epoch, epoch); assert.equal(h.state.cache[0].meta.start, epoch + 196);
});

test('a late common decision waits for the source clock before silently pinning the current target once', async () => {
  const h = harness(), parent = h.peer('parent'), previousPlayer = h.state.player;
  h.state.clockReady = false;
  await h.ctx.handleCommonHello(parent, hello(h, await decision(h)));
  assert.equal(h.state.commonStart.joinCheckPending, true);
  assert.equal(h.state.initialDelayPolicy.state, 'observing');
  assert.equal(h.state.initialDelayPolicy.targetProgramTime, null);
  assert.strictEqual(h.state.player, previousPlayer);
  assert.equal(h.trace.some(row => row[0] === 'close'), false);
  h.tick(48000); h.state.clockReady = true; h.ctx.advanceCommonStart();
  assert.equal(h.state.commonStart.joinCheckPending, false);
  assert.equal(h.state.initialDelayPolicy.state, 'preparing');
  assert.equal(h.state.initialDelayPolicy._commonJoin, true);
  assert.equal(h.state.initialDelayPolicy.targetProgramTime, 40);
  assert.equal(h.state.initialDelayPolicy.selectedDelaySeconds, 30);
  assert.notStrictEqual(h.state.player, previousPlayer);
  assert.equal(h.state.player.startupHold, true);
  assert.deepEqual(h.trace.filter(row => row[0] === 'prepare'), [['prepare', 40, 6]]);
  h.tick(1000); h.ctx.advanceCommonStart();
  assert.equal(h.trace.filter(row => row[0] === 'close').length, 1);
  assert.equal(h.trace.filter(row => row[0] === 'prepare').length, 1);
  assert.equal(h.state.initialDelayPolicy.targetProgramTime, 40);
});

const fallbackDecision = h => decision(h, { delaySeconds: 300, startsAt: epoch + 300000,
  issuedAt: epoch + 60000, reason: 'observation-timeout' });

test('a late 300-second common fallback prepares the current subsecond target instead of an old programme-zero decoder', async () => {
  const h = harness(), parent = h.peer('parent');
  h.tick(278400); h.state.cache[0].meta.start = epoch + 200;
  await h.ctx.handleCommonHello(parent, hello(h, await fallbackDecision(h)));
  assert.equal(h.state.commonStart.decision.delaySeconds, 300);
  assert.equal(h.state.commonStart.joinCheckPending, false);
  assert.equal(h.state.initialDelayPolicy.state, 'preparing');
  assert.equal(h.state.initialDelayPolicy._commonJoin, true);
  assert(Math.abs(h.state.initialDelayPolicy.targetProgramTime - .4) < 1e-9);
  assert.equal(h.state.initialDelayPolicy.selectedDelaySeconds, 300);
  assert.equal(h.trace.filter(row => row[0] === 'close').length, 1);
  assert(Math.abs(h.trace.find(row => row[0] === 'prepare')[1] - .4) < 1e-9);
  h.ctx.advanceCommonStart();
  assert.equal(h.trace.filter(row => row[0] === 'prepare').length, 1);
});

test('an old fallback received before its start waits for both the common moment and the first signed timestamp', async () => {
  const h = harness(), parent = h.peer('parent');
  h.tick(273000); h.state.cache[0].meta.start = epoch + 200;
  await h.ctx.handleCommonHello(parent, hello(h, await fallbackDecision(h)));
  assert.equal(h.state.commonStart.joinCheckPending, true);
  assert.equal(h.state.initialDelayPolicy.targetProgramTime, null);
  const policyUpdate = h.state.initialDelayPolicy.update;
  h.state.initialDelayPolicy.update = () => assert.fail('pending common-join check must not enter ordinary historical-delivery admission');
  vm.runInContext(slice('function advanceInitialDelay()', 'function deliverySnapshot()'), h.ctx);
  h.ctx.advanceInitialDelay();
  h.tick(5000); h.ctx.advanceCommonStart();
  assert.equal(h.state.commonStart.joinCheckPending, true, 'programme zero precedes the actual first signed sample at .2');
  h.ctx.advanceInitialDelay();
  h.state.initialDelayPolicy.update = policyUpdate;
  h.tick(300); h.ctx.advanceCommonStart();
  assert.equal(h.state.commonStart.joinCheckPending, false);
  assert.equal(h.state.initialDelayPolicy._commonJoin, true);
  assert(Math.abs(h.state.initialDelayPolicy.targetProgramTime - .3) < 1e-9);
  assert.equal(h.trace.filter(row => row[0] === 'prepare').length, 1);
  h.tick(1000); h.ctx.advanceCommonStart();
  assert.equal(h.trace.filter(row => row[0] === 'prepare').length, 1);
});

test('a late fallback without signed cache cannot pin a decoder until actual media arrives', async () => {
  const h = harness(), parent = h.peer('parent'); h.state.cache = []; h.tick(278400);
  await h.ctx.handleCommonHello(parent, hello(h, await fallbackDecision(h)));
  assert.equal(h.state.commonStart.joinCheckPending, true);
  assert.equal(h.state.initialDelayPolicy.targetProgramTime, null);
  assert.equal(h.trace.some(row => row[0] === 'prepare' || row[0] === 'close'), false);
  h.ctx.advanceCommonStart(); assert.equal(h.state.commonStart.joinCheckPending, true);
  h.state.cache.push({ meta: { seq: 0, start: epoch + 200, duration: 2000 } });
  h.ctx.advanceCommonStart();
  assert.equal(h.state.commonStart.joinCheckPending, false);
  assert(Math.abs(h.state.initialDelayPolicy.targetProgramTime - .4) < 1e-9);
  assert.equal(h.trace.filter(row => row[0] === 'close').length, 1);
  assert.equal(h.trace.filter(row => row[0] === 'prepare').length, 1);
});

test('a fresh fallback decision before programme start retains ordinary initial-member admission', async () => {
  const h = harness(), parent = h.peer('parent'); h.tick(39000);
  await h.ctx.handleCommonHello(parent, hello(h, await fallbackDecision(h)));
  assert.equal(h.state.commonStart.joinCheckPending, false);
  assert.equal(h.state.initialDelayPolicy.state, 'observing');
  assert.equal(h.state.initialDelayPolicy._commonJoin, false);
  assert.equal(h.state.initialDelayPolicy.targetProgramTime, null);
  assert.equal(h.trace.some(row => row[0] === 'prepare' || row[0] === 'close'), false);
});

function actualCache(h, from, end) {
  h.state.cache = Array.from({ length: Math.ceil((end - from) / 2) }, (_, index) => {
    const programme = from + index * 2;
    return { meta: { seq: Math.round(programme / 2), start: epoch + programme * 1000, duration: 2000, sig: 'retained-source-signature-' + programme } };
  });
}
async function selectLateV2Source() {
  const h = harness({ role: 'source', version: 2, cacheHeadroom: true });
  h.tick(878000); actualCache(h, 600, 900); h.ctx.syncPlayback();
  const oldPlayer = h.state.player, child = h.peer('child', 'down');
  child.commonReports = []; h.ctx.advanceCommonStart();
  assert.equal(h.state.commonStart.policy.observationStartedAt, epoch + 900000);
  h.tick(19000); actualCache(h, 600, 920); child.commonReports = [{ id: 'child', report: h.report() }];
  h.ctx.advanceCommonStart(); assert.equal(h.state.commonStart.policy.preview(), null);
  h.tick(1000); child.commonReports = [{ id: 'child', report: h.report() }]; h.ctx.advanceCommonStart(); await h.signingDone();
  return { ...h, child, oldPlayer };
}

test('v2 source remains undecided beyond 900 seconds without viewers and plays its unchanged solo 300-second timeline', () => {
  const h = harness({ role: 'source', version: 2, cacheHeadroom: true }); h.tick(879000); actualCache(h, 600, 902);
  h.ctx.syncPlayback();
  assert.equal(h.state.commonStart.decision, null); assert.equal(h.state.commonStart.policy.observationStartedAt, null);
  assert.equal(h.ctx.soloCommonPlayback(), true); assert.equal(h.ctx.nominalProgramTime(), 601);
  assert.equal(h.ctx.effectiveProgramTime(), 601); assert.equal(h.state.player.startupHold, false);
  assert.deepEqual(h.trace.filter(row => row[0] === 'sync'), [['sync', 601]]);
  assert.equal(h.trace.some(row => row[0] === 'close'), false);
});

test('v2 first late viewer supplies twenty fresh seconds before the already-playing host resets once and signs a real retained target', async () => {
  const h = await selectLateV2Source(), d = h.state.commonStart.decision;
  assert(d); assert.equal(d.version, 2); assert.equal(d.delaySeconds, 30); assert.equal(d.programmeTime, 902);
  assert.equal(d.observationStartedAt, epoch + 900000); assert.equal(d.startsAt, epoch + 932000);
  assert.equal(h.ctx.window.SameEndCommonStart.validateDecision(d, h.state.config), true);
  assert.equal(h.state.playbackStarted, true, 'source solo playback before the coordinated catch-up is allowed');
  assert.notStrictEqual(h.state.player, h.oldPlayer); assert.equal(h.oldPlayer.adaptive.everPlayed, true);
  assert.equal(h.trace.filter(row => row[0] === 'close').length, 1);
  assert.deepEqual(h.trace.filter(row => row[0] === 'commit'), [['commit', 902, 6]]);
  assert.equal(h.state.player.startupFacts(902).cacheAheadSeconds, 18, 'prepared target is actually retained in source cache');
  const canonical = h.ctx.window.SameEndCommonStart.canonicalDecision(d);
  assert(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, Buffer.from(d.sig, 'base64url'), enc.encode(canonical)));
  h.ctx.advanceCommonStart(); assert.equal(h.trace.filter(row => row[0] === 'close').length, 1);
});

test('v2 host and viewer use the signed shared clock but neither starts its new timeline before startsAt', async () => {
  const source = await selectLateV2Source(), d = source.state.commonStart.decision;
  const viewer = harness({ version: 2, cacheHeadroom: true }), parent = viewer.peer('parent');
  viewer.tick(898000); actualCache(viewer, 898, 920); viewer.state.supplier = { id: parent.id }; viewer.state.lastReceivedAt = epoch + 920000;
  Object.assign(parent, { highestSeq: 459, lastProgressAt: epoch + 919000 });
  await viewer.ctx.handleCommonHello(parent, hello(viewer, d));
  assert.equal(parent.highestSeq, 459); assert.equal(parent.lastProgressAt, epoch + 919000, 'short selection preserves live supplier progress');
  assert.equal(viewer.ctx.nominalProgramTime(), source.ctx.nominalProgramTime());
  assert.equal(viewer.ctx.scheduledCommonStart(), true);
  const sourceSyncs = source.trace.filter(row => row[0] === 'sync').length;
  source.ctx.syncPlayback(); viewer.ctx.syncPlayback();
  assert.equal(viewer.trace.some(row => row[0] === 'sync'), false);
  assert.equal(viewer.trace.filter(row => row[0] === 'window').at(-1)[1], -1);
  assert.equal(source.trace.filter(row => row[0] === 'sync').length, sourceSyncs);
  source.tick(11999); viewer.tick(11999); source.ctx.syncPlayback(); viewer.ctx.syncPlayback();
  assert.equal(viewer.trace.some(row => row[0] === 'sync'), false); assert.equal(source.ctx.scheduledCommonStart(), true);
  source.tick(1); viewer.tick(1); viewer.state.lastReceivedAt = epoch + 932000;
  vm.runInContext(slice('function advanceInitialDelay()', 'function deliverySnapshot()'), viewer.ctx);
  source.ctx.syncPlayback(); viewer.ctx.syncPlayback();
  assert.equal(source.ctx.scheduledCommonStart(), false); assert.equal(viewer.ctx.scheduledCommonStart(), false);
  assert.equal(source.trace.filter(row => row[0] === 'sync').at(-1)[1], 902);
  assert.equal(viewer.state.initialDelayPolicy.state, 'committed');
  assert.equal(viewer.state.initialDelayPolicy.targetProgramTime, 902);
  assert.equal(viewer.trace.filter(row => row[0] === 'sync').at(-1)[1], 902);
  assert.equal(viewer.trace.filter(row => row[0] === 'close').length, 1);
});

test('v2 short selection preserves the bootstrap live cursor and schedules new children at the signed programme range', async () => {
  const h = harness({ role: 'source', version: 2, cacheHeadroom: true }); h.tick(878000); actualCache(h, 600, 900);
  const child = h.peer('child', 'down'); h.ctx.stageWindow(); h.ctx.stageWindow();
  const bootstrap = h.enqueued.filter(row => row.peer === 'child').map(row => row.seq * 2);
  assert(bootstrap.length > 0); assert(bootstrap.every(programme => programme >= 894), 'no five-minute historical backlog enters the measurement bootstrap');
  child.commonReports = []; h.ctx.advanceCommonStart(); h.tick(20000); actualCache(h, 600, 920);
  child.commonReports = [{ id: 'child', report: h.report() }]; child.lastSentSeq = 459;
  const retained = h.state.cache.find(piece => piece.meta.seq === 451), before = JSON.stringify(retained.meta);
  h.ctx.advanceCommonStart(); await h.signingDone();
  assert.equal(child.lastSentSeq, 459, 'short selection must not resend already verified bootstrap media');
  h.enqueued.length = 0; for (let count = 0; count < 12; count++) h.ctx.stageWindow();
  assert.equal(h.enqueued.filter(row => row.peer === 'child').length, 0, 'no duplicate backlog may starve live source progress');
  h.state.cache.push({ meta: { seq: 460, start: epoch + 920000, duration: 2000 } });
  h.ctx.stageWindow(); assert.deepEqual(h.enqueued.filter(row => row.peer === 'child').map(row => row.seq), [460]);
  h.peer('new-child', 'down'); h.ctx.stageWindow();
  const fresh = h.enqueued.filter(row => row.peer === 'new-child'); assert(fresh.length > 0);
  const d = h.state.commonStart.decision;
  assert(fresh.every(row => row.seq * 2 + 2 >= d.programmeTime - 4), 'scheduled forwarding starts at the signed programme range, not twelve seconds of earlier nominal history');
  assert.equal(JSON.stringify(retained.meta), before); assert.equal(h.state.config.delay, 300); assert.equal(h.state.config.epoch, epoch);
});

test('v2 conservative fallback rewinds its retained range and renews upstream progress for genuine older unique signed media', async () => {
  const source = harness({ role: 'source', version: 2, cacheHeadroom: true }); source.tick(878000); actualCache(source, 600, 900);
  source.ctx.syncPlayback(); const child = source.peer('child', 'down'); child.commonReports = [];
  source.ctx.advanceCommonStart(); source.tick(60000); actualCache(source, 600, 960); child.lastSentSeq = 479;
  source.ctx.advanceCommonStart(); await source.signingDone();
  const d = source.state.commonStart.decision; assert.equal(d.delaySeconds, 300); assert.equal(d.programmeTime, 664);
  assert.equal(child.lastSentSeq, -1, 'fallback actually needs history preceding the fresh-measurement bootstrap');
  source.enqueued.length = 0; source.ctx.stageWindow();
  assert(source.enqueued.some(row => row.seq < 479));
  assert(source.enqueued.every(row => row.seq * 2 + 2 >= d.programmeTime - 4));

  const viewer = harness({ version: 2 }), parent = viewer.peer('parent'); viewer.tick(938000); actualCache(viewer, 898, 960);
  Object.assign(parent, { highestSeq: 479, lastProgressAt: epoch + 959000, lastVerifiedAt: epoch + 959000, deliveryVersion: 1 });
  viewer.state.supplier = { id: parent.id };
  await viewer.ctx.handleCommonHello(parent, hello(viewer, d));
  assert.equal(parent.highestSeq, -1); assert.equal(parent.lastProgressAt, epoch + 960000);
  Object.assign(viewer.state, { seen: new Set(), received: 0 }); viewer.ctx.MAX_CLIP = 4 * 1024 * 1024;
  viewer.ctx.SameEndHLS = { decodeBundle };
  for (const prefix of ['const canonical=', 'const segmentKey=']) vm.runInContext(engine.split('\n').find(line => line.startsWith(prefix)), viewer.ctx);
  vm.runInContext(slice('function receipt(', 'function resumeAfter()'), viewer.ctx);
  vm.runInContext(slice('async function acceptSegment(', 'async function waitBuffer('), viewer.ctx);
  const buf = encodeBundle({ start: 664, duration: 2, playlistStart: 664,
    files: [{ path: 'master.m3u8', mime: 'application/vnd.apple.mpegurl', bytes: enc.encode('#EXTM3U\n') }] });
  const meta = { v: 2, cast: 'cast', sourceId: 'source', sourceEpoch: 0, programId: 'programme',
    alignmentVersion: 1, seq: 332, start: epoch + 664000, programStartTime: 664000, duration: 2000,
    size: buf.byteLength, mime: viewer.state.config.mime, hash: await viewer.ctx.hash(buf) };
  const canonical = vm.runInContext('canonical', viewer.ctx);
  meta.sig = b64(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(canonical(meta))));
  await viewer.ctx.acceptSegment(meta, buf, parent, epoch + 959990);
  assert.equal(parent.highestSeq, 332, 'retained unique media can establish progress after fallback despite the previous live bootstrap high-water mark');
  assert.equal(parent.lastProgressAt, epoch + 960000); assert.equal(viewer.state.received, 1);
  assert(viewer.sent.some(row => row.message.type === 'delivery-receipt' && row.message.seq === 332));
});

test('v2 rejects forged signatures and post-play viewer retiming while only the source may replace prior solo playback', async () => {
  const h = harness({ version: 2 }), parent = h.peer('parent'), d = await decision(h);
  await assert.rejects(h.ctx.handleCommonHello(parent, hello(h, { ...d, sig: b64(new Uint8Array(64)) })), /Unverified shared starting time/);
  h.tick(600); h.state.playbackStarted = true;
  await h.ctx.handleCommonHello(parent, hello(h, d));
  assert.equal(h.state.commonStart.decision, null); assert.equal(h.state.commonStart.conflict, true);
});

test('v2 asynchronous old-source verification cannot adopt into a replacement cast', async () => {
  const entered = deferred(), gate = deferred();
  const h = harness({ version: 2, subtle: { async verify(...args) { entered.release(); await gate.promise; return webcrypto.subtle.verify(...args); } } });
  const parent = h.peer('parent'), task = h.ctx.handleCommonHello(parent, hello(h, await decision(h)));
  await entered.promise; h.state.config = { ...h.state.config, id: 'replacement-v2' }; h.ctx.resetCommonStart(); gate.release(); await task;
  assert.equal(h.state.commonStart.decision, null); assert.equal(h.state.commonStart.conflict, false);
});

test('v2 pending bootstrap ignores stale sixty-second hints and first adoption clears hints before real bounded recovery resumes', async () => {
  const h = harness({ role: 'source', version: 2, cacheHeadroom: true }); h.tick(878000); actualCache(h, 600, 900);
  const child = h.peer('child', 'down'); Object.assign(child, { playbackLagSeconds: 60, announcedPlaybackLag: 60 });
  h.ctx.stageWindow();
  const bootstrap = h.enqueued.filter(row => row.peer === child.id).map(row => row.seq * 2);
  assert(bootstrap.length > 0); assert(bootstrap.every(programme => programme + 2 >= 896), 'an unplayed hint must not turn live bootstrap into sixty seconds of history');
  child.commonReports = []; h.ctx.advanceCommonStart(); h.tick(20000); actualCache(h, 600, 920);
  child.commonReports = [{ id: child.id, report: h.report() }]; h.ctx.advanceCommonStart(); await h.signingDone();
  assert.equal(h.state.commonStart.decision.delaySeconds, 30);
  assert.equal(child.playbackLagSeconds, 0); assert.equal(child.announcedPlaybackLag, 0);
  h.tick(12000); h.enqueued.length = 0;
  await h.ctx.handleControl(child, hello(h, undefined, { deliveryVersion: 1, playbackLagSeconds: 1e9, resumeAfter: -1 }));
  assert.equal(child.playbackLagSeconds, 60, 'after a signed clock, genuine adaptive recovery may still use the bounded lag allowance');
  assert(h.enqueued.some(row => row.peer === child.id && row.seq * 2 < h.ctx.nominalProgramTime() - 50));
  assert(h.enqueued.every(row => row.peer !== child.id || row.seq * 2 + 2 >= h.ctx.nominalProgramTime() - 64));
});

test('v2 pending upstream hellos advertise zero rather than an unplayed clock difference, with recovery expansion restored after adoption', async () => {
  const h = harness({ version: 2 }), parent = h.peer('parent'); h.tick(898000); actualCache(h, 898, 920);
  Object.assign(parent, { playbackLagSeconds: 60, announcedPlaybackLag: 60 });
  h.ctx.stageWindow(); h.ctx.broadcastCommonHello();
  const pending = h.sent.filter(row => row.peer === parent.id && row.message.type === 'hello');
  assert(pending.length > 0); assert(pending.every(row => row.message.playbackLagSeconds === 0));
  await h.ctx.handleCommonHello(parent, hello(h, await decision(h, { issuedAt: epoch + 920000, startsAt: epoch + 932000,
    programmeTime: 902, observationStartedAt: epoch + 900000 })));
  assert.equal(parent.playbackLagSeconds, 0); assert.equal(parent.announcedPlaybackLag, 0);
  h.tick(12000); h.ctx.advanceCommonStart();
  h.state.initialDelayPolicy.state = 'committed'; h.state.commonStart.joinCheckPending = false;
  h.state.player.adaptive.everPlayed = true; h.state.playbackStarted = true;
  h.state.player.getPlaybackTarget = nominal => nominal - 100;
  h.sent.length = 0; h.ctx.stageWindow();
  const expansion = h.sent.find(row => row.peer === parent.id && row.message.type === 'hello');
  assert(expansion); assert.equal(expansion.message.playbackLagSeconds, 60); assert.equal(parent.announcedPlaybackLag, 60);
});
