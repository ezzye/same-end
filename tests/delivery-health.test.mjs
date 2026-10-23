import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../delivery-health.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Date, isFinite, Array, Math });
const api = window.SameEndDelivery;

test('only matching acknowledgements of sent records count; rejects duplicates and malformed/future acks', () => {
  let now = 10000;
  const meter = new api.Meter(() => now);
  assert.equal(meter.sent({ seq: 1, hash: 'a', size: 100 }, 9000), true);
  assert.equal(meter.acknowledge({ seq: 1, hash: 'wrong', size: 100 }, 9500), false);
  assert.equal(meter.acknowledge({ seq: 1, hash: 'a', size: 99 }, 9500), false);
  assert.equal(meter.acknowledge({ seq: 2, hash: 'b', size: 100 }, 9500), false);
  assert.equal(meter.acknowledge({ seq: 1, hash: 'a', size: 100 }, 11000), false);
  assert.equal(meter.acknowledge({ seq: 1, hash: 'a', size: 100 }, 8999), false);
  assert.equal(meter.acknowledge({ seq: 1, hash: 'a', size: -1 }, 9500), false);
  assert.equal(meter.sent({ seq: 2, hash: 'x', size: 0 }, 9000), false);
  assert.equal(meter.sent({ seq: 2, hash: 'x', size: 4 * 1024 * 1024 + 1 }, 9000), false);
  assert.equal(meter.sent({ seq: Number.MAX_SAFE_INTEGER + 1, hash: 'x', size: 1 }, 9000), false);
  assert.equal(meter.sent({ seq: 2, hash: 'x'.repeat(129), size: 1 }, 9000), false);
  assert.equal(meter.acknowledge({ seq: 1, hash: 'a', size: 100 }, 9500), true);
  assert.equal(meter.acknowledge({ seq: 1, hash: 'a', size: 100 }, 9600), false);
  assert.equal(meter.snapshot(10000).acknowledgedBytes, 100);
  assert.equal(meter.sent({ seq: 2, hash: 'b', size: 1 }, 8900), false); // Sent timestamps cannot move backwards.
});

test('reports measuring for an isolated ack and measures sustained acknowledged throughput after five seconds', () => {
  let now = 0;
  const meter = new api.Meter(() => now);
  meter.sent({ seq: 1, hash: 'h1', size: 100000 }, 0);
  meter.acknowledge({ seq: 1, hash: 'h1', size: 100000 }, 0);
  now = 4999;
  assert.equal(meter.snapshot(now).health, 'measuring');
  now = 5000;
  assert.equal(meter.snapshot(now).measured, false);
  now = 5000;
  meter.sent({ seq: 2, hash: 'h2', size: 100000 }, 5000);
  meter.acknowledge({ seq: 2, hash: 'h2', size: 100000 }, 5000);
  const snapshot = meter.snapshot(now);
  assert.equal(snapshot.measured, true);
  assert.equal(snapshot.health, 'healthy');
  assert.equal(snapshot.samples, 2);
  assert.equal(snapshot.acknowledgedBytes, 200000);
  assert.equal(snapshot.deliveredMbps, 0.32);
  assert.equal(snapshot.pendingBytes, 0);

  const lagging = new api.Meter(() => now);
  lagging.sent({ seq: 3, hash: 'h3', size: 50 }, 0);
  assert.equal(lagging.snapshot(11999).health, 'measuring');
  assert.equal(lagging.snapshot(12000).health, 'congested');
});

test('bounds retained records and expires old pending and acknowledged records within one minute', () => {
  let now = 0;
  const meter = new api.Meter(() => now);
  for (let i = 0; i < 200; i++) {
    now = i;
    assert.equal(meter.sent({ seq: i, hash: 'h' + i, size: 1 }, now), true);
    if (i % 2 === 0) meter.acknowledge({ seq: i, hash: 'h' + i, size: 1 }, now);
  }
  let snapshot = meter.snapshot(now);
  assert.ok(snapshot.samples + Math.ceil(snapshot.pendingBytes) <= 128);
  now = 61000;
  snapshot = meter.snapshot(now);
  assert.equal(snapshot.acknowledgedBytes, 0);
  assert.equal(snapshot.pendingBytes, 0);
  assert.equal(snapshot.samples, 0);
});

test('reserves forward from an absolute millisecond target across contiguous intervals only', () => {
  const segments = [
    { start: 3008, end: 5000 },
    { start: 1000, end: 3000 },
    { start: 0, end: 900 }
  ];
  assert.equal(api.reserveSeconds(segments, 2000), 3);
  assert.equal(api.reserveSeconds([{ start: 0, end: 2000 }, { start: 2201, end: 5000 }], 2050), 0);
  assert.equal(api.reserveSeconds([{ start: 0, end: 2000 }, { start: 2090, end: 5000 }], 2050), 2.95);
  assert.equal(api.reserveSeconds([{ start: 0, end: 900 }, { start: 1100, end: 5000 }], 1000), 4);
  assert.equal(api.reserveSeconds([{ start: 3000, end: 5000 }], 2000), 0);
  assert.equal(api.reserveSeconds([{ start: 3008, end: 5000 }, { start: 1000, end: 3000 }], 3000), 2);
  assert.equal(api.reserveSeconds([{ start: 0, end: 3000 }, { start: 2000, end: 5000 }], 1000), 4);
});

test('supplier watchdog waits for fresh control plus a long verified-progress stall', () => {
  const input = {
    connectedAt: 0, lastVerifiedAt: 2000, lastProgressAt: 2000,
    sourceNowMs: 12000, rooted: true, lastControlAt: 13000,
    nowMs: 13000, delaySeconds: 3, sampleGapMs: 40
  };
  assert.equal(api.assessSupplier(input), null);
  input.nowMs = 14000;
  input.lastControlAt = 14000;
  assert.equal(api.assessSupplier(input), 'source-progress-stalled');
  input.lastProgressAt = 13900; // A late joiner can still be receiving newer backlog.
  assert.equal(api.assessSupplier(input), null);
  input.lastProgressAt = 2000;
  input.sampleGapMs = 6000;
  assert.equal(api.assessSupplier(input), null);
  input.sampleGapMs = 40;
  input.rooted = false;
  assert.equal(api.assessSupplier(input), 'source-path-stalled');
  input.rooted = true;
  input.lastProgressAt = 13900;
  input.lastControlAt = 1000;
  assert.equal(api.assessSupplier(input), 'supplier-unresponsive');
});
