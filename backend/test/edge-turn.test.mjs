import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createEdgeTurnCredentials, parseCoturnMetrics, assessEdgeCapacity, createEdgeHealthHandler, getEdgeHealth} from '../edge-turn.mjs';
import {MemoryStore} from '../store.mjs';

const now = 1_800_000_000_000;
const policy = {reportTtlMs: 15_000, cpuBusyLimit: 0.9, minimumMemoryAvailableRatio: 0.1, uplinkBudgetMbps: 50, uplinkHeadroomRatio: 0.8, allocationLimit: 100, allocationHeadroomRatio: 0.9};
const healthy = {sampledAtMs: now, cpuBusyRatio: 0.2, memoryAvailableRatio: 0.5, networkTxMbps: 1, allocations: 1, metricError: false};

test('TURN REST credentials are expiring HMAC-SHA1 values and secret never appears in output', () => {
  const secret = 'private-shared-secret-value';
  const result = createEdgeTurnCredentials({urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:5349'], secret, nowMs: now, ttlSeconds: 300});
  const entry = result.iceServers[0];
  assert.equal(result.expiresAt, Math.floor(now / 1000) + 300);
  assert.match(entry.username, new RegExp(`^${result.expiresAt}:[A-Za-z0-9_-]+$`));
  assert.equal(entry.credential, createHmac('sha1', secret).update(entry.username).digest('base64'));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(createEdgeTurnCredentials({urls: [], secret}), {iceServers: [], expiresAt: null});
});

test('TURN URL and lifetime validation rejects embedded auth and unbounded settings', () => {
  assert.throws(() => createEdgeTurnCredentials({urls: ['turn:user:pass@relay.test:3478'], secret: '1234567890123456'}), /URL/);
  assert.throws(() => createEdgeTurnCredentials({urls: ['https://relay.test'], secret: '1234567890123456'}), /URL/);
  assert.throws(() => createEdgeTurnCredentials({urls: ['turn:relay.test'], secret: '1234567890123456', ttlSeconds: 3601}), /lifetime/);
});

test('capacity is unknown when budget or required measurements are unknown', () => {
  assert.equal(assessEdgeCapacity({sample: healthy, config: {...policy, uplinkBudgetMbps: null}, nowMs: now}).state, 'unknown');
  assert.equal(assessEdgeCapacity({sample: {...healthy, networkTxMbps: null}, config: policy, nowMs: now}).state, 'unknown');
  assert.equal(assessEdgeCapacity({sample: {...healthy, allocations: null}, config: policy, nowMs: now}).allowNew, false);
});

test('capacity denies new admission under CPU, memory, network, or allocation pressure', () => {
  const cases = [
    [{...healthy, cpuBusyRatio: 0.95}, 'cpu-busy'],
    [{...healthy, memoryAvailableRatio: 0.05}, 'memory-pressure'],
    [{...healthy, networkTxMbps: 41}, 'uplink-headroom'],
    [{...healthy, allocations: 90}, 'allocation-headroom']
  ];
  for (const [sample, reason] of cases) {
    const result = assessEdgeCapacity({sample, config: policy, nowMs: now});
    assert.equal(result.state, 'constrained');
    assert.equal(result.allowNew, false);
    assert.ok(result.reasons.includes(reason));
  }
});

test('expired reports become stale and coturn allocation gauge parses only the verified metric name', () => {
  assert.equal(assessEdgeCapacity({sample: healthy, config: policy, nowMs: now + 15_001}).state, 'stale');
  assert.deepEqual(parseCoturnMetrics('# HELP turn_total_allocations current\nturn_total_allocations{type="udp"} 3\nturn_total_allocations{type="tcp"} 2\nother_allocations 99'), {allocations: 5});
  assert.deepEqual(parseCoturnMetrics('unknown_metric 4'), {allocations: null});
});

test('signed health reports authenticate raw bytes, reject replay, and expire from persisted state', async () => {
  const store = new MemoryStore(), secret = 'test-only-health-signing-secret';
  const handler = createEdgeHealthHandler({secret, policy, store, now: () => now});
  const rawBody = JSON.stringify(healthy), timestamp = String(now);
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  assert.equal((await handler.submit({signature, timestamp, rawBody})).body.state, 'healthy');
  assert.equal((await handler.submit({signature, timestamp, rawBody})).status, 409);
  assert.equal((await getEdgeHealth({store, policy, now: () => now + 15_001})).state, 'stale');
  const tamper = await createEdgeHealthHandler({secret, policy, store: new MemoryStore(), now: () => now}).submit({signature, timestamp, rawBody: rawBody + ' '});
  assert.equal(tamper.status, 401);
});
