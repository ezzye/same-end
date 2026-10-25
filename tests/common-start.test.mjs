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
