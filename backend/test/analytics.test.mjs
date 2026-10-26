import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MemoryStore} from '../store.mjs';
import {createApi} from '../api.mjs';
import {createCommunityApi} from '../community-api.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const issuer = 'https://issuer.test', clientId = 'staff-client';
function fixture() {
  let time = Date.UTC(2026, 9, 25, 23, 59, 0); const store = new MemoryStore();
  const api = createApi({store, push: {enabled: false}, now: () => time, allowedOrigins: ['https://sameend.test']});
  const community = createCommunityApi({store, now: () => time, allowedOrigins: ['https://sameend.test'], adminAuth: {issuer, clientId}, localAdminTokenHash: hash('local-review-token')});
  const collect = async (payload, options = {}) => {
    const headers = {origin: 'https://sameend.test', 'content-type': 'application/json', ...(options.headers || {})};
    const response = await api.handler({rawPath: '/v1/analytics/events', requestContext: {http: {method: options.method || 'POST', sourceIp: options.ip || '203.0.113.7'}}, headers, body: options.raw ?? JSON.stringify(payload), isBase64Encoded: options.b64, queryStringParameters: options.query});
    return {...response, json: JSON.parse(response.body || 'null')};
  };
  const preflight = async (headers = {}) => {
    const response = await api.handler({rawPath: '/v1/analytics/events', requestContext: {http: {method: 'OPTIONS', sourceIp: '203.0.113.7'}}, headers: {'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', ...headers}});
    return {...response, json: JSON.parse(response.body || 'null')};
  };
  const admin = async (role = 'admin', days = '7') => {
    const response = await community.handler({rawPath: '/v1/community/admin/analytics', requestContext: {http: {method: 'GET'}, authorizer: {jwt: {claims: {iss: issuer, aud: clientId, token_use: 'id', sub: 'staff', exp: time / 1000 + 1000, 'cognito:groups': [`sameend-${role}`]}}}}, headers: {origin: 'https://sameend.test'}, queryStringParameters: {days}});
    return {...response, json: JSON.parse(response.body)};
  };
  return {store, collect, preflight, admin, advance: n => {time += n;}};
}

test('analytics browser preflight allows the first-party JSON POST without writes', async () => {
  const f = fixture();
  const preflight = await f.preflight({origin: 'https://sameend.test'});
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://sameend.test');
  assert.match(preflight.headers['access-control-allow-methods'], /POST/);
  assert.match(preflight.headers['access-control-allow-headers'], /content-type/i);
  assert.equal(f.store.items.size, 0, 'OPTIONS does not create analytics or rate-limit rows');
  assert.equal((await f.collect({v: 1, event: 'page_view'})).statusCode, 200);
  assert.equal((await f.store.get('ANALYTICS#2026-10-25', 'COUNTERS')).page_view, 1);
  assert.equal((await f.preflight({origin: 'https://evil.test'})).statusCode, 403);
  assert.equal((await f.preflight()).statusCode, 403, 'missing Origin fails closed');
  assert.equal((await f.preflight({origin: 'https://sameend.test', 'access-control-request-method': 'PUT'})).statusCode, 405);
  assert.equal((await f.preflight({origin: 'https://sameend.test', 'access-control-request-headers': 'authorization'})).statusCode, 400);
});

test('analytics accepts only strict low-data events and writes aggregate rows without identifiers', async () => {
  const f = fixture();
  assert.equal((await f.collect({v: 1, event: 'page_view'})).statusCode, 200);
  assert.equal((await f.collect({v: 1, event: 'share_started'})).statusCode, 200);
  assert.equal((await f.collect({v: 1, event: 'invitation_copied'})).statusCode, 200);
  const row = await f.store.get('ANALYTICS#2026-10-25', 'COUNTERS');
  assert.deepEqual(Object.keys(row).sort(), ['day', 'expiresAt', 'invitation_copied', 'page_view', 'pk', 'share_started', 'sk'].sort());
  assert.equal(row.page_view, 1); assert.equal(row.share_started, 1); assert.equal(row.invitation_copied, 1);
  assert.doesNotMatch(JSON.stringify(row), /203\.0\.113|sourceIp|referrer|url|eventId|userAgent/i);
});

test('analytics rejects unsafe shape and request metadata without aggregate writes', async () => {
  const f = fixture();
  for (const [payload, options] of [
    [{v: 1, event: 'page_view', url: 'private'}, {}], [{v: 1, event: 'custom'}, {}], [{v: 1, event: 'page_view'}, {method: 'GET'}],
    [{v: 1, event: 'page_view'}, {query: {x: 'y'}}], [{v: 1, event: 'page_view'}, {headers: {authorization: 'Bearer secret'}}],
    [{v: 1, event: 'page_view'}, {headers: {origin: undefined}}], [{v: 1, event: 'page_view'}, {headers: {origin: 'null'}}], [{v: 1, event: 'page_view'}, {headers: {origin: 'https://evil.test'}}],
    [{}, {raw: JSON.stringify({v: 1, event: 'page_view', extra: 'x'.repeat(300)})}],
    [{}, {raw: Buffer.alloc(257).toString('base64'), b64: true}]
  ]) assert.notEqual((await f.collect(payload, options)).statusCode, 200);
  assert.equal((await f.store.query('ANALYTICS#2026-10-25')).length, 0);
  assert.equal(f.store.items.size, 0, 'invalid payloads do not consume rate-limit rows');
});

test('daily UTC aggregates, abuse cap, finite global cap, TTL and expired-read filtering', async () => {
  const f = fixture();
  for (let i = 0; i < 600; i++) assert.equal((await f.collect({v: 1, event: 'page_view'})).statusCode, 200);
  assert.equal((await f.collect({v: 1, event: 'page_view'})).statusCode, 429);
  f.advance(60000);
  assert.equal((await f.collect({v: 1, event: 'share_started'})).statusCode, 200);
  const summary = await f.admin(); assert.equal(summary.json.days.length, 7);
  assert.equal(summary.json.days.at(-2).day, '2026-10-25');
  assert.equal(summary.json.days.at(-2).page_view, 600); assert.equal(summary.json.days.at(-2).share_started, 0);
  assert.equal(summary.json.days.at(-1).day, '2026-10-26');
  assert.equal(summary.json.days.at(-1).page_view, 0); assert.equal(summary.json.days.at(-1).share_started, 1);
  const row = await f.store.get('ANALYTICS#2026-10-26', 'COUNTERS'); assert.equal(row.share_started, 1);
  const prev = await f.store.get('ANALYTICS#2026-10-25', 'COUNTERS');
  assert.equal(prev.expiresAt, Math.floor(Date.UTC(2026, 9, 25, 23, 59) / 1000) + 90 * 86400);
  prev.expiresAt = 1; await f.store.put(prev);
  assert.equal((await f.admin()).json.days.at(-1).page_view, 0);
  await f.store.transact([{key: {pk: 'RATE#analytics-global', sk: '2026-10-26'}, add: {count: 10000}, set: {expiresAt: 9999999999}}]);
  assert.equal((await f.collect({v: 1, event: 'page_view'}, {ip: '198.51.100.2'})).statusCode, 429);
});

test('analytics summary is admin-only for JWT and isolated local review auth', async () => {
  const f = fixture();
  const unauthenticated = await f.store;
  const noAuth = createCommunityApi({store: unauthenticated, allowedOrigins: ['https://sameend.test'], adminAuth: {issuer, clientId}});
  const missing = await noAuth.handler({rawPath: '/v1/community/admin/analytics', requestContext: {http: {method: 'GET'}}, headers: {origin: 'https://sameend.test'}, queryStringParameters: {days: '7'}});
  assert.equal(missing.statusCode, 401);
  assert.equal((await f.admin('support')).statusCode, 403);
  assert.equal((await f.admin('editor')).statusCode, 403);
  assert.equal((await f.admin('moderator')).statusCode, 403);
  assert.equal((await f.admin('admin', '8')).statusCode, 400);
  const local = await f.store;
  const community = createCommunityApi({store: local, allowedOrigins: ['https://sameend.test'], localAdminTokenHash: hash('local-review-token')});
  const response = await community.handler({rawPath: '/v1/community/admin/analytics', requestContext: {http: {method: 'GET'}}, headers: {origin: 'https://sameend.test', authorization: 'Bearer local-review-token'}, queryStringParameters: {days: '7'}});
  assert.equal(response.statusCode, 200);
});


test('collector rejects non-POST methods and preserves shared-network allowance with atomic increments', async () => {
  const f = fixture();
  for (const method of ['HEAD', 'PUT']) assert.equal((await f.collect({v: 1, event: 'page_view'}, {method})).statusCode, 405);
  const responses = await Promise.all(Array.from({length: 40}, () => f.collect({v: 1, event: 'page_view'}, {ip: '198.51.100.8'})));
  assert.ok(responses.every(x => x.statusCode === 200));
  assert.equal((await f.store.get('ANALYTICS#2026-10-25', 'COUNTERS')).page_view, 40);
  const ipCounters = [...f.store.items.values()].filter(x => x.pk.startsWith('RATE#analytics-ip-'));
  assert.equal(ipCounters.length, 1);
  assert.doesNotMatch(JSON.stringify(ipCounters), /198\.51\.100\.8/);
  f.advance(60000);
  assert.equal((await f.collect({v: 1, event: 'share_started'}, {ip: '198.51.100.8'})).statusCode, 200);
  const dailyIpRows = [...f.store.items.values()].filter(x => x.pk.startsWith('RATE#analytics-ip-'));
  assert.equal(dailyIpRows.length, 2, 'daily hashed IP keys rotate at UTC midnight');
});
