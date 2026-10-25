import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client-delivery.js', import.meta.url), 'utf8');
const window = {};
// Exercise the ES5 implementation without Number.isFinite / Number.isSafeInteger.
vm.runInNewContext(source, { window, Date, isFinite, Array, Math, Number: {} });
const { Estimator } = window.SameEndClientDelivery;

function fixture() {
  let now = 100000;
  const estimator = new Estimator(() => now);
  const options = { baselineDelaySeconds: 300, reserveSeconds: 30, decoderAheadSeconds: 4, extraDelaySeconds: 0,
    visible: true, online: true, clockReady: true, sourceReachable: true, playing: true, sourceAgeSeconds: 3 };
  function sample(at = now, change = {}) {
    now = at;
    Object.assign(options, change);
    return estimator.sample({ nowMs: now, ...options });
  }
  function observe(seq, at, change = {}) {
    now = at;
    return estimator.observe({ seq, size: 250000, durationMs: 2000, programStartMs: seq * 2000,
      receiveStartedAtMs: Math.max(100000, at - 200), verifiedAtMs: at,
      sourceNowMs: seq * 2000 + 5000, ...change });
  }
  sample();
  return { estimator, sample, observe, now: () => now };
}

function trace({ interval = 2000, pieces = 21, age = 3, reserve = () => 30, receiveMs = 200, gaps } = {}) {
  const f = fixture();
  let at = 100000;
  for (let i = 0; i < pieces; i++) {
    if (i) {
      const next = at + (gaps ? gaps[(i - 1) % gaps.length] : interval);
      for (let tick = at + 1000; tick < next; tick += 1000) f.sample(tick, { reserveSeconds: reserve((tick - 100000) / 1000) });
      at = next;
    }
    f.sample(at, { reserveSeconds: reserve((at - 100000) / 1000) });
    const currentAge = typeof age === 'function' ? age(i, (at - 100000) / 1000) : age;
    assert.equal(f.observe(i, at, { receiveStartedAtMs: Math.max(100000, at - receiveMs),
      sourceNowMs: currentAge === null ? null : i * 2000 + 2000 + currentAge * 1000 }), true);
  }
  return { ...f, result: f.estimator.snapshot(at) };
}

function assertSafe(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value) && value >= -86400 && value <= Number.MAX_SAFE_INTEGER);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) assertSafe(item);
  else assert.ok(value === null || typeof value === 'string' || typeof value === 'boolean');
}

test('fresh clock-aware live observations produce a shadow alternative without changing the baseline', () => {
  const { result } = trace();
  assert.equal(result.state, 'observing');
  assert.equal(result.classification, 'live');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.sourceBitrateBps, 1000000);
  assert.equal(result.deliveredGoodputBps, 1000000); // First packet anchors the interval, it is not double counted.
  assert.equal(result.deliveryToStreamRatio, 1);
  assert.equal(result.baselineDelaySeconds, 300);
  assert.equal(result.recommendation.status, 'unvalidated-candidate');
  assert.equal(result.recommendation.candidateReserveSeconds, 6);
  assert.equal(result.recommendation.candidateInitialDelaySeconds, 9);
  assert.equal(result.recommendation.applied, false);
  assert.equal(result.recommendation.validated, false);
  assert.equal(result.capacityKnown, false);
  assertSafe(result);
});

test('fast transfers and nearly whole-piece-time transfers both leave maximum broadband unknown', () => {
  const fast = trace({ receiveMs: 100, age: 2 }).result;
  const nearStream = trace({ receiveMs: 1800, age: 5 }).result;
  assert.equal(fast.deliveredGoodputBps, nearStream.deliveredGoodputBps);
  assert.ok(fast.activeTransferGoodputBps > nearStream.activeTransferGoodputBps * 10);
  assert.equal(fast.capacityKnown, false);
  assert.equal(nearStream.capacityKnown, false);
  assert.equal(fast.state, 'observing');
  assert.equal(nearStream.state, 'observing');
  assert.ok(fast.recommendation.candidateInitialDelaySeconds < nearStream.recommendation.candidateInitialDelaySeconds);
});

test('bursty arrivals recommend more reserve than steady arrivals, with bounded candidates', () => {
  const steady = trace().result;
  const bursty = trace({ pieces: 31, gaps: [0, 0, 6000], age: 5 }).result;
  assert.ok(bursty.gapStddevSeconds > steady.gapStddevSeconds);
  assert.ok(bursty.recommendation.candidateReserveSeconds > steady.recommendation.candidateReserveSeconds);
  assert.ok(bursty.recommendation.candidateInitialDelaySeconds >= steady.recommendation.candidateInitialDelaySeconds);
  assert.ok(bursty.recommendation.candidateReserveSeconds <= 60);
  assert.ok(bursty.recommendation.candidateInitialDelaySeconds <= 420);
});

test('sustained below-stream delivery plus falling reserve has no finite delay remedy', () => {
  const { result } = trace({ interval: 3000, pieces: 19, age: (i) => 3 + i,
    reserve: (seconds) => 30 - seconds / 3 });
  assert.equal(result.sourceBitrateBps, 1000000);
  assert.ok(result.deliveryToStreamRatio < 0.7);
  assert.ok(result.reserveTrendSecondsPerSecond < -0.3);
  assert.equal(result.state, 'constrained');
  assert.equal(result.recommendation.status, 'insufficient-throughput');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.recommendation.candidateReserveSeconds, null);
  assert.equal(result.recommendation.extraDelayFixesSustainedDeficit, false);
});

test('growing source age plus below-stream delivery establishes pipeline shortfall even without falling reserve', () => {
  const { result } = trace({ interval: 3000, pieces: 19, age: (i) => 3 + i });
  assert.equal(result.state, 'constrained');
  assert.equal(result.capacityKnown, false);
  assert.equal(result.recommendation.status, 'insufficient-throughput');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
});

test('old backlog delivered rapidly is catchup rather than proof of fast live startup', () => {
  const { result } = trace({ interval: 1000, pieces: 31, age: (i) => 80 - i });
  assert.equal(result.classification, 'catchup');
  assert.equal(result.deliveredGoodputBps, 2000000);
  assert.equal(result.recommendation.status, 'catchup');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.capacityKnown, false);
});

test('stable high-latency delivery is distinct from falling-age catchup and never caps away observed age', () => {
  const delayed = trace({ age: 100 }).result;
  assert.equal(delayed.classification, 'live');
  assert.equal(delayed.recommendation.candidateInitialDelaySeconds, 106);
  const beyondBound = trace({ age: 600 }).result;
  assert.equal(beyondBound.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(beyondBound.recommendation.status, 'insufficient-data');
});

test('duplicates, replays, out-of-order and overlapping programme intervals cannot inflate rate or fresh progress', () => {
  const f = trace({ pieces: 12 });
  const before = f.estimator.snapshot(f.now());
  const at = f.now();
  assert.equal(f.observe(11, at + 100, { size: 4000000 }), false);
  assert.equal(f.observe(3, at + 200), false);
  assert.equal(f.observe(12, at + 300, { programStartMs: 20000 }), false);
  const after = f.estimator.snapshot(at);
  assert.equal(after.recordCount, before.recordCount);
  assert.equal(after.signedProgressSeconds, before.signedProgressSeconds);
  assert.equal(after.sourceBitrateBps, before.sourceBitrateBps);
  assert.equal(after.lastProgressAgeSeconds, before.lastProgressAgeSeconds);
});

test('malformed metadata and impossible local timing are rejected', () => {
  const f = fixture();
  const bad = [{ seq: -1 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: 0.5 }, { size: 0 },
    { size: 4 * 1024 * 1024 + 1 }, { durationMs: NaN }, { durationMs: 0 }, { durationMs: 10001 },
    { programStartMs: -1 }, { verifiedAtMs: Infinity }, { verifiedAtMs: 100001 },
    { receiveStartedAtMs: 100001 }];
  for (const change of bad) assert.equal(f.observe(0, 100000, change), false, JSON.stringify(change));
  assert.equal(f.observe(0, 100000), true);
  assert.equal(f.observe(1, 101000, { verifiedAtMs: 99999 }), false);
  assert.equal(f.estimator.snapshot().recordCount, 1);
});

test('no receive timestamp leaves active transfer observation unknown', () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    f.sample(100000 + i * 2000);
    f.observe(i, 100000 + i * 2000, { receiveStartedAtMs: null });
  }
  const result = f.estimator.snapshot();
  assert.equal(result.activeTransferGoodputBps, null);
  assert.equal(result.deliveredGoodputBps, 1000000);
});

test('overlapping active receive intervals use their union rather than summing overlap', () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) {
    const at = 100000 + i * 1000;
    f.sample(at);
    f.observe(i, at, { receiveStartedAtMs: Math.max(100000, at - 2000), sourceNowMs: i * 2000 + 5000 });
  }
  const result = f.estimator.snapshot();
  assert.equal(result.activeTransferGoodputBps, 2000000);
});

test('a stale arrival gap revokes the candidate and cannot be counted as fresh progress', () => {
  const f = trace();
  const until = f.now() + 14000;
  for (let at = f.now() + 1000; at <= until; at += 1000) f.sample(at);
  const result = f.estimator.snapshot();
  assert.equal(result.state, 'stale');
  assert.equal(result.confidence, 'none');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.lastProgressAgeSeconds, 14);
});

for (const [change, expected] of [[{ clockReady: false }, 'clock-unknown'], [{ visible: false }, 'suspended'],
  [{ online: false }, 'offline'], [{ sourceReachable: false }, 'path-absent']]) {
  test(expected + ' suppresses rates and candidates, then recovery requires fresh evidence', () => {
    const f = trace();
    let at = f.now() + 1000;
    let result = f.sample(at, change);
    assert.equal(result.state, expected);
    assert.equal(result.confidence, 'none');
    assert.equal(result.recordCount, 0);
    assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
    assert.equal(f.observe(21, at, { sourceNowMs: 47000 }), false);
    const restore = Object.fromEntries(Object.keys(change).map((key) => [key, true]));
    result = f.sample(++at, restore);
    assert.equal(result.state, 'insufficient-data');
    assert.equal(result.recordCount, 0);
    assert.equal(result.deliveredGoodputBps, null);
    assert.equal(f.observe(21, ++at), false); // Suspended progress remains replay, even after recovery.
    assert.equal(f.observe(22, ++at), true);
    assert.equal(f.estimator.snapshot().recordCount, 1);
  });
}

test('missing source clock never permits a startup recommendation despite measured local goodput', () => {
  const { result } = trace({ age: null });
  assert.equal(result.classification, 'unknown');
  assert.equal(result.sourceToVerifiedAgeP95Seconds, null);
  assert.equal(result.deliveredGoodputBps, 1000000);
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.confidence, 'low');
});

test('a timer suspension discards the contaminated window and recovers through warmup', () => {
  const f = trace();
  let result = f.estimator.snapshot(f.now() + 11000);
  assert.equal(result.state, 'stale');
  result = f.sample(f.now() + 11000);
  assert.equal(result.recordCount, 0);
  assert.equal(result.sampleCount, 1);
  assert.equal(result.state, 'insufficient-data');
});

test('route change clears samples and candidate but retains scalar replay protection', () => {
  const f = trace();
  f.estimator.resetRoute();
  let result = f.estimator.snapshot();
  assert.equal(result.recordCount, 0);
  assert.equal(result.sampleCount, 0);
  assert.equal(result.routeAgeSeconds, 0);
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(f.observe(20, f.now()), false);
  assert.equal(f.observe(21, f.now() + 1000, { receiveStartedAtMs: f.now() - 1 }), false);
  assert.equal(f.observe(22, f.now() + 1000), true);
  result = f.estimator.snapshot();
  assert.equal(result.recordCount, 1);
  assert.equal(JSON.stringify(result).includes('supplier'), false);
});

test('records and reserve samples stay bounded and expire; old duplicate remains rejected', () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) {
    const at = 100000 + i * 100;
    f.sample(at);
    assert.equal(f.observe(i, at, { programStartMs: i * 100, durationMs: 100, size: 12500,
      receiveStartedAtMs: null, sourceNowMs: i * 100 + 3100 }), true);
  }
  let result = f.estimator.snapshot();
  assert.ok(result.recordCount <= 128);
  assert.ok(result.sampleCount <= 64);
  assertSafe(result);
  const later = f.now() + 61000;
  result = f.estimator.snapshot(later);
  assert.equal(result.recordCount, 0);
  assert.equal(result.sampleCount, 0);
  assert.equal(result.deliveredGoodputBps, null);
  assert.equal(f.observe(999, later), false);
});

test('reserve coverage and deficit are bounded and never double-count decoded reserve', () => {
  const f = trace({ reserve: () => 2 });
  const result = f.sample(f.now(), { decoderAheadSeconds: 50 });
  assert.equal(result.state, 'risk');
  assert.equal(result.reserveSeconds, 2);
  assert.equal(result.decoderAheadSeconds, 50);
  assert.equal(result.reserveCoverage, 1 / 3);
  assert.equal(result.deficitSeconds, 4);
});

test('paused or empty playback does not hide source-age evidence of a delivery deficit', () => {
  const f = trace({ interval: 3000, pieces: 19, age: (i) => 3 + i,
    reserve: (seconds) => 30 - seconds / 3 });
  const result = f.sample(f.now(), { playing: false });
  assert.equal(result.reserveTrendSecondsPerSecond, null);
  assert.equal(result.state, 'constrained');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.capacityKnown, false);
});

test('baseline reserve fraction answers five-minute coverage independently of six-second reserve goal', () => {
  const f = trace({ reserve: () => 30 });
  assert.equal(f.result.baselineReserveFraction, 0.1);
  assert.equal(f.result.reserveCoverage, 1);
  assert.equal(f.sample(f.now(), { baselineDelaySeconds: 0 }).baselineReserveFraction, null);
  assert.equal(f.sample(f.now(), { baselineDelaySeconds: 300, reserveSeconds: 600 }).baselineReserveFraction, 1);
  assert.equal(f.sample(f.now(), { reserveSeconds: null }).baselineReserveFraction, null);
});

test('a newly unclocked piece revokes a candidate based on older clocked observations', () => {
  const f = trace();
  f.sample(f.now() + 2000);
  assert.equal(f.observe(21, f.now(), { sourceNowMs: null }), true);
  const result = f.estimator.snapshot();
  assert.equal(result.classification, 'unknown');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
});

test('paused empty viewer with growing source age cannot receive a finite delay candidate', () => {
  const f = fixture();
  for (let i = 0; i < 19; i++) {
    const at = 100000 + i * 3000;
    f.sample(at, { playing: false, reserveSeconds: 0 });
    f.observe(i, at, { sourceNowMs: i * 2000 + 2000 + (3 + i) * 1000 });
  }
  const result = f.estimator.snapshot();
  assert.equal(result.reserveTrendSecondsPerSecond, null);
  assert.equal(result.state, 'constrained');
  assert.equal(result.recommendation.status, 'insufficient-throughput');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
});

test('current sample age floors the candidate, and missing arrivals revoke it before the general stale timeout', () => {
  const f = trace();
  const lastAt = f.now();
  assert.equal(f.result.recommendation.candidateInitialDelaySeconds, 9);
  let result = f.sample(lastAt + 1000, { sourceAgeSeconds: 4, reserveSeconds: 30 });
  assert.equal(result.recommendation.candidateInitialDelaySeconds, 10);
  result = f.estimator.snapshot(lastAt + 2000);
  assert.equal(result.recommendation.candidateInitialDelaySeconds, 11);
  for (let i = 2; i <= 10; i++) result = f.sample(lastAt + i * 1000, { sourceAgeSeconds: 3 + i });
  assert.equal(result.state, 'observing'); // A quiet source is not an ISP-capacity finding.
  assert.equal(result.lastProgressAgeSeconds, 10);
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.recommendation.status, 'insufficient-data');
  assert.equal(result.confidence, 'low');
  assert.equal(result.capacityKnown, false);
  result = f.sample(lastAt + 14000, { sourceAgeSeconds: 17 });
  assert.equal(result.state, 'stale');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  f.sample(lastAt + 15000, { sourceAgeSeconds: 3 });
  assert.equal(f.observe(21, lastAt + 15000), true);
  result = f.estimator.snapshot();
  assert.notEqual(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.recommendation.applied, false);
});

test('unknown current sample age suppresses startup recommendation despite older clocked pieces', () => {
  const f = trace();
  const result = f.sample(f.now(), { sourceAgeSeconds: null });
  assert.equal(result.classification, 'live');
  assert.equal(result.recommendation.candidateInitialDelaySeconds, null);
  assert.equal(result.recommendation.reason, 'need-fresh-live-observations');
  assert.equal(result.confidence, 'low');
});
