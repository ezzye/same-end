import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const window = {};
vm.runInNewContext(await readFile(new URL('../common-start.js', import.meta.url), 'utf8'), { window, Math, isFinite, Object });
const { Policy, reportFromMeasurement, validReport, validateDecision, canonicalDecision } = window.SameEndCommonStart;
const epoch = 1000000;
const config = { commonStartVersion: 1, delay: 300, epoch, id: 'cast', sourceId: 'source', sourceEpoch: 0, programId: 'programme' };
const measurement = (changes = {}) => ({ state: 'observing', classification: 'live', recordCount: 11, observationSeconds: 20,
  lastProgressAgeSeconds: 0, routeAgeSeconds: 21, gapP95Seconds: 2, gapStddevSeconds: 0,
  deliveryToStreamRatio: .968, sourceAgeTrendSecondsPerSecond: 0,
  recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 9, candidateReserveSeconds: 6 }, ...changes });
const report = (changes = {}, at = epoch + 22000) => reportFromMeasurement(measurement(changes), at);
const input = (changes = {}) => ({ sourceNowMs: epoch + 22000, hostReport: report(), reports: [report()], hasViewers: true, hostReady: true, ...changes });
const signedFields = proposal => ({ ...proposal, cast: config.id, sourceId: config.sourceId, sourceEpoch: config.sourceEpoch, programId: config.programId });

test('fresh source and viewer evidence chooses one shared future programme-zero start', () => {
  const p = new Policy({ epoch });
  assert.equal(p.update(input({ sourceNowMs: epoch + 19000 })), null);
  const d = p.update(input());
  assert.equal(d.delaySeconds, 30); assert.equal(d.startsAt, epoch + 30000); assert.equal(d.reason, 'verified-delivery');
  assert.equal(d.reserveSeconds, 6); assert.equal(validateDecision(signedFields(d), config), true);
  assert.strictEqual(p.update(input({ unsupportedPeer: true, sourceNowMs: epoch + 80000 })), d);
  assert.equal(p.snapshot().state, 'decided'); assert.equal(Object.isFrozen(d), true);
  const snapshot = p.snapshot(); snapshot.decision.delaySeconds = 300;
  assert.equal(p.snapshot().decision.delaySeconds, 30);
});

test('maximum supported participant candidate and reserve win, with two-second rounding and four-second lead', () => {
  const reports = [report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 47.1, candidateReserveSeconds: 9.2 } }), report()];
  const d = new Policy({ epoch }).update(input({ reports }));
  assert.equal(d.delaySeconds, 48); assert.equal(d.reserveSeconds, 10);
  const at = epoch + 51001;
  const later = new Policy({ epoch }).update(input({ sourceNowMs: at, hostReport: report({}, at), reports: [report({}, at)] }));
  assert.equal(later.delaySeconds, 56); assert(later.startsAt - later.issuedAt >= 4000);
});

test('measured host and worst-viewer candidates can each select a longer common delay', () => {
  const candidate = seconds => report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: seconds, candidateReserveSeconds: 6 } });
  assert.equal(new Policy({ epoch }).update(input({ hostReport: candidate(8), reports: [candidate(8)] })).delaySeconds, 30);
  assert.equal(new Policy({ epoch }).update(input({ hostReport: candidate(8), reports: [candidate(54)] })).delaySeconds, 54);
  assert.equal(new Policy({ epoch }).update(input({ hostReport: candidate(54), reports: [candidate(8)] })).delaySeconds, 54);
});

test('missing viewers, any missing report or host preparation cannot authorize shortening', () => {
  for (const changes of [{ hasViewers: false }, { reports: [] }, { reports: [null] }, { hostReport: null }, { hostReady: false }, { reports: Array(65).fill(report()) }]) {
    const p = new Policy({ epoch }); assert.equal(p.update(input(changes)), null);
    const d = p.update(input({ ...changes, sourceNowMs: epoch + 60000 }));
    assert.equal(d.delaySeconds, 300); assert.equal(d.reason, 'observation-timeout');
    assert.equal(validateDecision(signedFields(d), config), true);
    assert.strictEqual(p.update(input()), d);
  }
  const at = epoch + 60000;
  assert.equal(new Policy({ epoch }).update(input({ sourceNowMs: at, hostReport: report({}, at), reports: [report({}, at)] })).delaySeconds, 300);
});

test('unsupported early peers and sustained observed deficits latch conservative fallback', () => {
  assert.equal(new Policy({ epoch }).update(input({ unsupportedPeer: true })).reason, 'unsupported-peer');
  const deficit = report({ observationSeconds: 50, routeAgeSeconds: 51, deliveryToStreamRatio: .95,
    sourceAgeTrendSecondsPerSecond: .05, gapStddevSeconds: .03 });
  assert.equal(deficit.blocking, true);
  assert.equal(new Policy({ epoch }).update(input({ reports: [deficit] })).reason, 'sustained-delivery-deficit');
  const explicit = report({ state: 'constrained', recommendation: { status: 'insufficient-throughput' } });
  assert.equal(new Policy({ epoch }).update(input({ hostReport: explicit })).delaySeconds, 300);
  const noisy = report({ observationSeconds: 59.747, routeAgeSeconds: 60, deliveryToStreamRatio: .97335,
    sourceAgeTrendSecondsPerSecond: .02717, gapStddevSeconds: 1.897, gapP95Seconds: 4.644 });
  assert.equal(noisy.blocking, false); assert.equal(noisy.eligible, true);
});

test('a young near-stream backlog waits for the later historical deficit veto instead of irreversibly accelerating', () => {
  const p = new Policy({ epoch });
  // Scalar samples from android-group-below95-v3; no private cast identity.
  for (const sample of [
    { elapsed: 26.30180029296875, span: 22.06, ratio: .9178002408472764, trend: .05390495809802681, std: .0037483624166242077 },
    { elapsed: 34.30169995117188, span: 30.059800048828127, ratio: .939976320286583, trend: .053656060530040565, std: .003710604208291401 }
  ]) {
    const at = epoch + sample.elapsed * 1000;
    const r = report({ observationSeconds: sample.span, routeAgeSeconds: sample.elapsed, deliveryToStreamRatio: sample.ratio,
      sourceAgeTrendSecondsPerSecond: sample.trend, gapStddevSeconds: sample.std }, at);
    assert.equal(r.eligible, false); assert.equal(r.blocking, false, 'uncertainty is not a sustained-deficit diagnosis');
    assert.equal(p.update(input({ sourceNowMs: at, hostReport: report({}, at), reports: [r] })), null);
  }
  const at = epoch + 42302;
  const r = report({ observationSeconds: 38.06, routeAgeSeconds: 42.302, deliveryToStreamRatio: .95,
    sourceAgeTrendSecondsPerSecond: 2.049 / 38.06, gapStddevSeconds: .004 }, at);
  assert.equal(r.blocking, true);
  assert.equal(p.update(input({ sourceNowMs: at, hostReport: report({}, at), reports: [r] })).delaySeconds, 300);
  assert.equal(p.snapshot().reason, 'sustained-delivery-deficit');
});

test('flat-age near-stream quantization and sustainable noisy bursts remain eligible for a common start', () => {
  for (const changes of [
    { deliveryToStreamRatio: .95, sourceAgeTrendSecondsPerSecond: 0 },
    { observationSeconds: 59.747, routeAgeSeconds: 60, deliveryToStreamRatio: .97335,
      sourceAgeTrendSecondsPerSecond: .02717, gapStddevSeconds: 1.897, gapP95Seconds: 4.644 }
  ]) {
    const r = report(changes); assert.equal(r.eligible, true); assert.equal(r.blocking, false);
    assert.equal(new Policy({ epoch }).update(input({ reports: [r] })).delaySeconds, 30);
  }
});

test('catchup, route resets, unhealthy, stale and insufficient evidence wait for fallback', () => {
  for (const changes of [{ classification: 'catchup' }, { routeAgeSeconds: 3 }, { recordCount: 5 }, { observationSeconds: 19.99 },
    { state: 'offline' }, { state: 'clock-unknown' }, { state: 'path-absent' }, { lastProgressAgeSeconds: 4 },
    { recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 15, candidateReserveSeconds: 13 } }]) {
    const r = report(changes); assert.equal(r.eligible, false); assert.equal(r.blocking, false);
    assert.equal(new Policy({ epoch }).update(input({ reports: [r] })), null);
  }
  assert.equal(validReport(report({}, epoch + 999), epoch + 14000), false);
  assert.equal(validReport(report({}, epoch + 24001), epoch + 22000), false);
  assert.equal(validReport(report({}, epoch + 22000), epoch + 25000), true);
  assert.equal(validReport(report({}, epoch + 22000), epoch + 25001), false, 'forwarding cannot rejuvenate a live observation');
  assert.equal(validReport(report({ lastProgressAgeSeconds: 2 }), epoch + 23001), false, 'reported piece age and transport age accumulate');
  assert.equal(new Policy({ epoch }).update(input({ reports: [report({}, epoch)] })), null);
});

test('candidate over the 120-second support ceiling falls back rather than being clipped', () => {
  const r = report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 120.01, candidateReserveSeconds: 6 } });
  const d = new Policy({ epoch }).update(input({ reports: [r] }));
  assert.equal(d.delaySeconds, 300); assert.equal(d.reason, 'candidate-exceeds-limit');
  const upper = new Policy({ epoch }).update(input({ reports: [report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 120, candidateReserveSeconds: 12 } })] }));
  assert.equal(upper.delaySeconds, 120); assert.equal(upper.reserveSeconds, 12);
});

test('the signed reserve includes the host decoder minimum and unsupported native requirements wait for fallback', () => {
  const d = new Policy({ epoch }).update(input({ hostMinimumReserveSeconds: 12 }));
  assert.equal(d.reserveSeconds, 12);
  for (const minimum of [null, NaN, Infinity, 3, 12.01, '12']) {
    const p = new Policy({ epoch });
    assert.equal(p.update(input({ hostMinimumReserveSeconds: minimum })), null);
    assert.equal(p.update(input({ hostMinimumReserveSeconds: minimum, sourceNowMs: epoch + 60000 })).delaySeconds, 300);
  }
});

test('report sanitization rejects arbitrary timing, nonfinite fields and forged outcome booleans', () => {
  assert.equal(reportFromMeasurement(null, epoch), null); assert.equal(reportFromMeasurement(measurement(), NaN), null);
  for (const changes of [{ sourceAgeTrendSecondsPerSecond: Infinity }, { routeAgeSeconds: '25' }, { observationSeconds: 1000000 },
    { recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: -1, candidateReserveSeconds: 6 } }]) {
    const r = report(changes); assert.equal(r.eligible, false); assert.equal(validReport(r, epoch + 22000), true);
  }
  for (const changes of [{ eligible: false }, { blocking: true }, { reason: 'do-what-i-say' }, { reserveSeconds: Infinity },
    { candidateDelaySeconds: '30' }, { recordCount: 999 }, { version: 2 }, { routeAgeSeconds: undefined }]) {
    assert.equal(validReport({ ...report(), ...changes }, epoch + 22000), false);
  }
  assert.equal(new Policy({ epoch }).update(input({ sourceNowMs: Infinity })), null);
  assert.equal(new Policy({ epoch }).update(input({ sourceNowMs: epoch - 1 })), null);
  assert.throws(() => new Policy({ epoch, fallbackDelaySeconds: 60 }));
});

test('decision structural validation binds the configured identity, baseline and bounded timeline', () => {
  const d = signedFields(new Policy({ epoch }).update(input()));
  for (const changes of [{ type: 'hello' }, { version: 2 }, { decisionNumber: 2 }, { cast: 'other' }, { sourceId: 'other' },
    { sourceEpoch: 1 }, { programId: 'other' }, { delaySeconds: 31, startsAt: epoch + 31000 },
    { delaySeconds: 28, startsAt: epoch + 28000 }, { delaySeconds: 122, startsAt: epoch + 122000 },
    { startsAt: epoch + 30001 }, { issuedAt: epoch - 1 }, { issuedAt: epoch + 27000 },
    { reserveSeconds: 13 }, { reason: 'arbitrary' }, { delaySeconds: NaN }]) {
    assert.equal(validateDecision({ ...d, ...changes }, config), false, JSON.stringify(changes));
  }
  assert.equal(validateDecision(d, { ...config, epoch: epoch + 1 }), false);
  assert.equal(validateDecision(d, { ...config, commonStartVersion: undefined }), false);
  assert.equal(validateDecision(d, { ...config, delay: 60 }), false);
  assert.equal(validateDecision({ ...d, delaySeconds: 300, startsAt: epoch + 300000 }, config), false);
});

test('canonical signatures survive key reordering and reject any changed decision field', async () => {
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const d = signedFields(new Policy({ epoch }).update(input())), bytes = value => new TextEncoder().encode(canonicalDecision(value));
  const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, bytes(d));
  const verify = candidate => webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, signature, bytes(candidate));
  assert.equal(await verify(Object.fromEntries(Object.entries(d).reverse())), true);
  for (const [field, changed] of Object.entries({ version: 2, cast: 'other', sourceId: 'other', sourceEpoch: 1, programId: 'other',
    decisionNumber: 2, delaySeconds: 32, reserveSeconds: 8, issuedAt: d.issuedAt + 1, startsAt: d.startsAt + 1, reason: 'unsupported-peer' })) {
    assert.equal(await verify({ ...d, [field]: changed }), false, field);
  }
});

const v2Input = (elapsed, changes = {}) => {
  const at = epoch + elapsed * 1000;
  return input({ sourceNowMs: at, hostReport: report({}, at), reports: [report({}, at)], ...changes });
};
const openV2 = (p, elapsed) => p.update(v2Input(elapsed, { hostReport: null, reports: [] }));
const v2Config = { ...config, commonStartVersion: 2 };

test('v1 canonical bytes remain unchanged when the module also supports v2', () => {
  const d = signedFields(new Policy({ epoch }).update(input()));
  assert.equal(canonicalDecision(d), JSON.stringify(['common-start', 1, 'cast', 'source', 0, 'programme', 1,
    30, 6, epoch + 22000, epoch + 30000, 'verified-delivery']));
});

test('v2 waits indefinitely for its first viewer instead of locking fallback at capture sixty seconds', () => {
  const p = new Policy({ epoch, version: 2 });
  for (const elapsed of [0, 60, 300, 900]) {
    assert.equal(p.update(v2Input(elapsed, { hasViewers: false, unsupportedPeer: true })), null);
    assert.equal(p.snapshot().deadlineAtSourceMs, null); assert.equal(p.preview(), null);
  }
  assert.equal(openV2(p, 901), null); assert.equal(p.snapshot().observationStartedAt, epoch + 901000);
  p.update(v2Input(910, { hasViewers: false })); p.update(v2Input(920));
  assert.equal(p.snapshot().deadlineAtSourceMs, epoch + 961000, 'leave/rejoin does not renew the first window');
});

for (const firstJoin of [0, 90, 900]) test('v2 first viewer at '+firstJoin+'s gets one measured common delay independent of capture age', () => {
  const p = new Policy({ epoch, version: 2 }); assert.equal(openV2(p, firstJoin), null);
  assert.equal(p.update(v2Input(firstJoin + 19.9)), null); assert.equal(p.preview(), null);
  assert.equal(p.update(v2Input(firstJoin + 20)), null);
  const preview = p.preview(); assert(Object.isFrozen(preview)); assert.equal(preview.delaySeconds, 30);
  assert.equal(preview.programmeTime, firstJoin + 2); assert.equal(preview.startsAt, epoch + (firstJoin + 32) * 1000);
  p.update(v2Input(firstJoin + 21, { preparedProgrammeTime: preview.programmeTime + 1 }));
  assert.strictEqual(p.preview(), preview, 'an unaligned host cannot move the target or publish');
  const d = p.update(v2Input(firstJoin + 21, { preparedProgrammeTime: preview.programmeTime }));
  assert.equal(d.version, 2); assert.equal(d.delaySeconds, 30); assert.equal(d.programmeTime, preview.programmeTime);
  assert.equal(d.observationStartedAt, epoch + firstJoin * 1000); assert.equal(d.startsAt - d.issuedAt, 11000);
  assert.equal(validateDecision(signedFields(d), v2Config), true);
  assert.strictEqual(p.update(v2Input(firstJoin + 100, { unsupportedPeer: true })), d);
  assert.equal(p.preview(), null);
});

test('v2 chooses the worst measured candidate and host minimum, including a longer early-capture warmup', () => {
  const p = new Policy({ epoch, version: 2 }); openV2(p, 0);
  const at = epoch + 20000, slow = report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 53.1, candidateReserveSeconds: 9 } }, at);
  p.update(v2Input(20, { reports: [slow], hostMinimumReserveSeconds: 12 })); const preview = p.preview();
  assert.equal(preview.delaySeconds, 54); assert.equal(preview.reserveSeconds, 12); assert.equal(preview.programmeTime, 0);
  const d = p.update(v2Input(20, { reports: [slow], hostMinimumReserveSeconds: 12, preparedProgrammeTime: 0 }));
  assert.equal(d.startsAt, epoch + 54000); assert.equal(validateDecision(signedFields(d), v2Config), true);
});

test('v2 uses actual first signed media as its minimum programme position without fabricating a sample at zero', () => {
  const p = new Policy({ epoch, version: 2 }); openV2(p, 0);
  const at = epoch + 20000, slower = report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 54, candidateReserveSeconds: 6 } }, at);
  p.update(v2Input(20, { reports: [slower], minimumProgrammeTime: .196 }));
  const preview = p.preview(); assert(Math.abs(preview.programmeTime - .196) < 1e-9);
  assert.equal(preview.startsAt, epoch + 54196);
  const d = p.update(v2Input(20, { reports: [slower], minimumProgrammeTime: .196, preparedProgrammeTime: preview.programmeTime }));
  assert.equal(validateDecision(signedFields(d), v2Config), true);
});

test('v2 late 120-second candidate starts from the bounded live bootstrap position and keeps its target pinned', () => {
  const p = new Policy({ epoch, version: 2 }); openV2(p, 900);
  const at = epoch + 920000, slower = report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 120, candidateReserveSeconds: 6 } }, at);
  p.update(v2Input(920, { reports: [slower], minimumProgrammeTime: 900 }));
  const preview = p.preview(); assert.equal(preview.delaySeconds, 120); assert.equal(preview.programmeTime, 900);
  assert.equal(preview.startsAt, epoch + 1020000);
  const fresh = report({ recommendation: { status: 'unvalidated-candidate', candidateInitialDelaySeconds: 120, candidateReserveSeconds: 6 } }, epoch + 925000);
  p.update(v2Input(925, { reports: [fresh], minimumProgrammeTime: 905, hostReady: false }));
  assert.strictEqual(p.preview(), preview, 'a moving live lower bound must not slide the active decoder target');
  const d = p.update(v2Input(925, { reports: [fresh], minimumProgrammeTime: 905, preparedProgrammeTime: 900 }));
  assert.equal(d.programmeTime, 900); assert.equal(validateDecision(signedFields(d), v2Config), true);
  for (const minimumProgrammeTime of [null, -1, Infinity, '900', 921]) {
    const q = new Policy({ epoch, version: 2 }); openV2(q, 900);
    assert.equal(q.update(v2Input(920, { minimumProgrammeTime })), null); assert.equal(q.preview(), null);
  }
});

test('v2 missing, stale and uncertain reports wait for the fixed first-connection deadline; fallback has a future common start', () => {
  for (const changes of [{ reports: [] }, { reports: [null] }, { hostReport: null }, { hasViewers: false },
    { hostMinimumReserveSeconds: null }, { hostMinimumReserveSeconds: 15 },
    { reports: [report({}, epoch + 900000)] }]) {
    const p = new Policy({ epoch, version: 2 }); openV2(p, 900);
    assert.equal(p.update(v2Input(920, changes)), null); assert.equal(p.preview(), null);
    const d = p.update(v2Input(960, changes));
    assert.equal(d.delaySeconds, 300); assert.equal(d.startsAt, epoch + 964000); assert.equal(d.programmeTime, 664);
    assert.equal(d.reason, 'observation-timeout'); assert.equal(validateDecision(signedFields(d), v2Config), true);
  }
  const p = new Policy({ epoch, version: 2 }); openV2(p, 90);
  const uncertain = report({ deliveryToStreamRatio: .95, sourceAgeTrendSecondsPerSecond: .05 }, epoch + 110000);
  p.update(v2Input(110, { reports: [uncertain] })); assert.equal(p.preview(), null);
});

test('v2 unsupported peers and actual sustained deficits force fallback without claiming sufficient throughput', () => {
  for (const [changes, reason] of [
    [{ unsupportedPeer: true }, 'unsupported-peer'],
    [{ reports: [report({ recommendation: { status: 'insufficient-throughput' } }, epoch + 920000)] }, 'sustained-delivery-deficit']
  ]) {
    const p = new Policy({ epoch, version: 2 }); openV2(p, 900);
    const d = p.update(v2Input(920, changes)); assert.equal(d.delaySeconds, 300); assert.equal(d.reason, reason);
    assert.equal(validateDecision(signedFields(d), v2Config), true);
  }
  const p = new Policy({ epoch, version: 2 });
  const d = p.update(v2Input(10, { unsupportedPeer: true }));
  assert.equal(d.startsAt, epoch + 300000); assert.equal(d.programmeTime, 0);
});

test('v2 preview renewals preserve the first deadline, revoke changed evidence and remain bounded', () => {
  const p = new Policy({ epoch, version: 2 }); openV2(p, 900);
  p.update(v2Input(920)); const first = p.preview();
  p.update(v2Input(921, { hostReady: false })); assert.strictEqual(p.preview(), first);
  p.update(v2Input(929, { preparedProgrammeTime: first.programmeTime }));
  const renewed = p.preview(); assert(renewed.programmeTime > first.programmeTime); assert.equal(renewed.revision, 2);
  assert.equal(p.snapshot().deadlineAtSourceMs, epoch + 960000);
  p.update(v2Input(930, { reports: [] })); assert.equal(p.preview(), null);
  for (let revision = 3; revision <= 5; revision++) {
    p.update(v2Input(930 + revision)); assert.equal(p.preview().revision, revision);
    p.update(v2Input(930 + revision, { reports: [] }));
  }
  p.update(v2Input(940)); assert.equal(p.preview(), null, 'repeated withdrawals cannot churn unlimited decoder previews');
  assert.equal(p.update(v2Input(960)).delaySeconds, 300);
  const q = new Policy({ epoch, version: 2 }); openV2(q, 900); q.update(v2Input(920));
  q.update(v2Input(921, { hostMinimumReserveSeconds: 12 }));
  assert.equal(q.preview().revision, 2); assert.equal(q.preview().reserveSeconds, 12);
});

test('v2 structural validation and real signatures bind observation window, programme target and decision identity', async () => {
  const p = new Policy({ epoch, version: 2 }); openV2(p, 900); p.update(v2Input(920));
  const d = signedFields(p.update(v2Input(921, { preparedProgrammeTime: p.preview().programmeTime })));
  assert.equal(validateDecision(d, config), false); assert.equal(validateDecision({ ...d, version: 1 }, v2Config), false);
  for (const changes of [{ programmeTime: -1 }, { programmeTime: d.programmeTime + 1 }, { startsAt: d.startsAt + 1 },
    { issuedAt: d.startsAt - 3000 }, { observationStartedAt: d.issuedAt + 1 }, { observationStartedAt: epoch - 1 },
    { observationStartedAt: d.issuedAt - 60000 }, { sourceId: 'other' }, { version: 3 }, { delaySeconds: 31 }])
    assert.equal(validateDecision({ ...d, ...changes }, v2Config), false, JSON.stringify(changes));
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const bytes = value => new TextEncoder().encode(canonicalDecision(value));
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes(d));
  assert(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, sig, bytes(d)));
  for (const changes of [{ programmeTime: d.programmeTime + .001 }, { observationStartedAt: d.observationStartedAt + 1 }, { startsAt: d.startsAt + 1 }])
    assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, sig, bytes({ ...d, ...changes })), false);
  assert.throws(() => new Policy({ epoch, version: 3 }));
});
