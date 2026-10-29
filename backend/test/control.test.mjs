import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID, createECDH } from 'node:crypto';
import { createApi, LIMITS } from '../api.mjs';
import { MemoryStore, DynamoDBStore, Conflict } from '../store.mjs';
import { runReminders } from '../reminders.mjs';
import { validateSubscription, createPushTransport } from '../push.mjs';
import { template, artifactTemplate } from '../cloudformation.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const envelope = bytes => ({v: 1, iv: randomBytes(12).toString('base64url'), data: randomBytes(bytes || 48).toString('base64url')});
function subscription(endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`) { const dh = createECDH('prime256v1'); return {endpoint, expirationTime: null, keys: {p256dh: dh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url')}}; }
// A recording transport exists in tests only. It never reports real delivery.
function fixture({enabled = true, send} = {}) {
  const store = new MemoryStore(), deliveries = [];
  let time = Date.UTC(2026, 9, 21, 12);
  const push = {enabled, publicKey: enabled ? 'test-public-key' : '', async send(sub, payload) { if (send) await send(sub, payload); deliveries.push({subscription: structuredClone(sub), payload}); }};
  const now = () => time;
  const api = createApi({store, push, now});
  const id = randomUUID(), clubSecret = randomBytes(32), ownerSecret = randomBytes(32);
  const read = createHmac('sha256', clubSecret).update(`sameend/read/v1/${id}`).digest('base64url');
  const write = createHmac('sha256', ownerSecret).update(`sameend/write/v1/${id}`).digest('base64url');
  const event = {id: randomUUID(), startsAt: time + 3600000, notifyAt: time + 60000};
  const club = {id, readTokenHash: sha(read), writeTokenHash: sha(write), state: envelope(), events: [event]};
  async function request(method, path, body, token = read, ip = '192.0.2.1', headers = {}) {
    const url = new URL(path.startsWith('/v1') ? path : `/v1/clubs/${id}${path}`, 'https://api.example.invalid');
    const result = await api.handler({rawPath: url.pathname, queryStringParameters: Object.fromEntries(url.searchParams), headers: {'content-type': 'application/json', ...(token && {authorization: `Bearer ${token}`}), ...headers}, body: body === undefined ? '' : JSON.stringify(body), requestContext: {http: {method, sourceIp: ip}}});
    return {...result, json: JSON.parse(result.body)};
  }
  return {store, api, push, now, deliveries, id, read, write, club, event, request, async create() { const result = await request('POST', '/v1/clubs', club, undefined); assert.equal(result.statusCode, 200); return result; }, advance(ms) {time += ms;}, async register(sub = subscription(), eventIds = [event.id], ip) { return request('POST', '/subscriptions', {subscription: sub, clientId: randomUUID(), eventIds}, read, ip); }, async reminders() { return runReminders({store, push, now, deleteSubscription: api.deleteSubscription}); }};
}

test('capabilities read/write obey owner scope and hashes never leave server', async () => {
  const f = fixture(); await f.create();
  for (const token of ['', randomBytes(32).toString('base64url')]) {
    assert.equal((await f.request('GET', '', undefined, token)).statusCode, 401);
    assert.equal((await f.request('POST', '/messages', {id: randomUUID(), payload: envelope()}, token)).statusCode, 401);
    assert.equal((await f.request('PUT', '', {expectedVersion: 1, state: envelope(), events: []}, token)).statusCode, 401);
  }
  assert.equal((await f.request('GET', '', undefined, f.write)).statusCode, 200);
  const read = await f.request('GET', '');
  assert.equal(read.statusCode, 200); assert.deepEqual(read.json.state, f.club.state);
  assert.ok(!read.body.includes('TokenHash')); assert.ok(!read.body.includes(f.read));
  assert.equal((await f.request('PUT', '', {expectedVersion: 1, state: envelope(), events: []})).statusCode, 401);
});

test('owner optimistic updates are atomic and schedules clear', async () => {
  const f = fixture(); await f.create();
  const update = {expectedVersion: 1, state: envelope(), events: []};
  const results = await Promise.all([f.request('PUT', '', update, f.write), f.request('PUT', '', update, f.write)]);
  assert.deepEqual(results.map(x => x.statusCode).sort(), [200, 409]);
  assert.equal((await f.request('GET', '')).json.version, 2);
  assert.equal((await f.store.query('DUE', {index: true})).length, 0);
  assert.equal((await f.request('PUT', '', update, f.write)).json.code, 'version_conflict');
});

test('wrong club token and missing club use the same unauthorised response', async () => {
  const a = fixture(), b = fixture(); await a.create(); await b.create();
  const wrong = await a.request('GET', '', undefined, b.read);
  const missing = await a.request('GET', `/v1/clubs/${randomUUID()}`, undefined, a.read);
  assert.equal(wrong.statusCode, 401); assert.deepEqual(wrong.json, missing.json);
});

test('input boundaries reject malformed envelopes, metadata and excessive bodies', async () => {
  const f = fixture(); await f.create();
  assert.equal((await f.request('POST', '/messages', {id: randomUUID(), payload: envelope(LIMITS.messageBytes + 1)})).statusCode, 400);
  assert.equal((await f.request('PUT', '', {expectedVersion: 1, state: envelope(LIMITS.stateBytes + 1), events: []}, f.write)).statusCode, 400);
  assert.equal((await f.request('PUT', '', {expectedVersion: 1, state: envelope(), events: Array(31).fill(f.event)}, f.write)).statusCode, 400);
  assert.equal((await f.request('PUT', '', {expectedVersion: 1, state: envelope(), events: [{...f.event, notifyAt: f.event.startsAt + 1}]}, f.write)).statusCode, 400);
  assert.equal((await f.request('PUT', '', {expectedVersion: 1, state: {...envelope(), iv: 'bad'}, events: []}, f.write)).statusCode, 400);
  assert.equal((await f.request('POST', '/messages', {excess: 'x'.repeat(70000)})).statusCode, 413);
  assert.equal((await f.request('POST', '/messages', {}, f.read, undefined, {'content-type': 'text/plain'})).statusCode, 415);
});

test('public creation and chat posting have enforced bounded quotas', async () => {
  const f = fixture(); await f.create();
  for (let i = 0; i < 9; i++) { const id = randomUUID(); assert.equal((await f.request('POST', '/v1/clubs', {...f.club, id})).statusCode, 200); }
  assert.equal((await f.request('POST', '/v1/clubs', {...f.club, id: randomUUID()})).statusCode, 429);
  for (let i = 0; i < 20; i++) assert.equal((await f.request('POST', '/messages', {id: randomUUID(), payload: envelope()})).statusCode, 200);
  assert.equal((await f.request('POST', '/messages', {id: randomUUID(), payload: envelope()})).statusCode, 429);
});

test('chat is idempotent, server ordered and cursor scoped', async () => {
  const f = fixture(); await f.create();
  const a = {id: randomUUID(), payload: envelope()}, b = {id: randomUUID(), payload: envelope()};
  const first = await f.request('POST', '/messages', a), duplicate = await f.request('POST', '/messages', a);
  assert.deepEqual(first.json, duplicate.json);
  const second = await f.request('POST', '/messages', b);
  const all = await f.request('GET', '/messages');
  assert.deepEqual(all.json.messages.map(x => x.id), [a.id, b.id]);
  const after = await f.request('GET', `/messages?after=${first.json.cursor}`);
  assert.deepEqual(after.json.messages.map(x => x.id), [b.id]); assert.equal(after.json.cursor, second.json.cursor);
  const empty = await f.request('GET', `/messages?after=${second.json.cursor}`);
  assert.deepEqual(empty.json.messages, []); assert.equal(empty.json.cursor, second.json.cursor);
  assert.equal((await f.request('GET', '/messages?after=1700000000000')).statusCode, 400);
  const alien = Buffer.from(`m1:${randomUUID()}:0000000000000001`).toString('base64url');
  assert.equal((await f.request('GET', `/messages?after=${alien}`)).statusCode, 400);
});

test('private reports accept member ciphertext and expose it only to the owner', async () => {
  const f = fixture(), other = fixture(); await f.create(); await other.create();
  const report = {id: randomUUID(), envelope: envelope(64)};
  const sent = await f.request('POST', '/reports', report, f.read);
  assert.equal(sent.statusCode, 200);
  assert.equal((await f.request('GET', '/reports', undefined, f.read)).statusCode, 401);
  assert.equal((await f.request('POST', '/reports', {id: randomUUID(), envelope: envelope()}, f.write)).statusCode, 401);
  assert.equal((await other.request('GET', '/reports', undefined, f.write)).statusCode, 401);
  assert.equal((await other.request('POST', '/reports', report, f.read)).statusCode, 401);
  const read = await f.request('GET', '/reports', undefined, f.write);
  assert.equal(read.statusCode, 200); assert.deepEqual(read.json.reports, [{id: report.id, envelope: report.envelope, receivedAt: f.now()}]);
  assert.ok(!read.body.includes('TokenHash')); assert.ok(!read.body.includes(f.read));
});

test('reports validate bounded encrypted envelopes, are idempotent, expire and respect club quota', async () => {
  const f = fixture(); await f.create();
  const report = {id: randomUUID(), envelope: envelope(64)};
  assert.equal((await f.request('POST', '/reports', {...report, extra: true})).statusCode, 400);
  assert.equal((await f.request('POST', '/reports', {id: randomUUID(), envelope: {...envelope(), extra: true}})).statusCode, 400);
  assert.equal((await f.request('POST', '/reports', {id: randomUUID(), envelope: envelope(LIMITS.reportBytes + 1)})).statusCode, 400);
  const first = await f.request('POST', '/reports', report), duplicate = await f.request('POST', '/reports', report);
  assert.deepEqual(first.json, duplicate.json);
  assert.equal((await f.store.query(`CLUB#${f.id}`, {from: 'REPORT#', to: 'REPORT#\uffff'})).length, 1);
  assert.equal((await f.store.get(`CLUB#${f.id}`, `REPORTID#${report.id}`)).reportSk.startsWith('REPORT#'), true);
  for (let i = 1; i < LIMITS.reports; i++) {
    f.advance(60001);
    assert.equal((await f.request('POST', '/reports', {id: randomUUID(), envelope: envelope(32)})).statusCode, 200);
  }
  assert.equal((await f.request('POST', '/reports', {id: randomUUID(), envelope: envelope(32)})).json.code, 'report_limit');
  assert.equal((await f.store.get(`CLUB#${f.id}`, 'REPORTCOUNT')).count, LIMITS.reports);
  f.advance(LIMITS.chatSeconds * 1000 + 1);
  const stalePhysical = await f.store.query(`CLUB#${f.id}`, {from: 'REPORT#', to: 'REPORT#\uffff'});
  await f.store.transact(stalePhysical.map(row => ({key: {pk: row.pk, sk: row.sk}, delete: true})));
  const replacement = {id: report.id, envelope: envelope(64)};
  assert.equal((await f.request('POST', '/reports', replacement)).statusCode, 200, 'expired marker and asynchronously removed ciphertext do not hold quota');
  assert.equal((await f.store.get(`CLUB#${f.id}`, 'REPORTCOUNT')).count, 1);
  assert.deepEqual((await f.store.get(`CLUB#${f.id}`, `REPORTID#${report.id}`)).reportSk, (await f.store.query(`CLUB#${f.id}`, {from: 'REPORT#', to: 'REPORT#\uffff'}))[0].sk);
  assert.equal((await f.store.query(`CLUB#${f.id}`, {from: 'REPORTID#', to: 'REPORTID#\uffff'})).length, LIMITS.reports, 'orphaned TTL markers do not count as inbox reports');
});

test('concurrent different-millisecond retries keep one report, marker and quota entry', async () => {
  const f = fixture(); await f.create();
  const report = {id: randomUUID(), envelope: envelope(64)}, changedCipher = {id: report.id, envelope: envelope(64)};
  const originalQuery = f.store.query.bind(f.store); let entered = 0, firstEnteredResolve, bothEnteredResolve;
  const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; });
  const bothEntered = new Promise(resolve => { bothEnteredResolve = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.store.query = async (pk, options) => {
    if (pk === `CLUB#${f.id}` && options?.from === 'REPORT#') {
      entered++; if (entered === 1) firstEnteredResolve(); if (entered === 2) bothEnteredResolve(); await gate;
    }
    return originalQuery(pk, options);
  };
  const firstTime = f.now(), first = f.request('POST', '/reports', report);
  await firstEntered; f.advance(1); const secondTime = f.now(), second = f.request('POST', '/reports', changedCipher);
  await bothEntered; release();
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(firstTime, secondTime);
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200); assert.equal(a.json.receivedAt, b.json.receivedAt);
  const pk = `CLUB#${f.id}`, rows = await originalQuery(pk, {from: 'REPORT#', to: 'REPORT#\uffff'});
  assert.equal(rows.length, 1); assert.equal((await f.store.get(pk, 'REPORTCOUNT')).count, 1);
  const marker = await f.store.get(pk, `REPORTID#${report.id}`);
  assert.equal(marker.reportSk, rows[0].sk); assert.deepEqual(rows[0].envelope, report.envelope);
  const retry = await f.request('POST', '/reports', changedCipher);
  assert.deepEqual(retry.json, a.json); assert.deepEqual((await f.store.get(pk, rows[0].sk)).envelope, report.envelope);
});

test('report count reconciliation detects an insert-delete ABA via its revision', async () => {
  const f = fixture(); await f.create();
  await f.request('POST', '/reports', {id: randomUUID(), envelope: envelope(32)});
  const pk = `CLUB#${f.id}`, originalQuery = f.store.query.bind(f.store); let reportQueries = 0, injected = false;
  f.store.query = async (queryPk, options) => {
    if (!injected && queryPk === pk && options?.from === 'REPORT#' && ++reportQueries === 2) {
      injected = true;
      const id = randomUUID(), expiresAt = Math.floor(f.now() / 1000) + 86400, report = {pk, sk: `REPORT#${String(f.now() + 1).padStart(16, '0')}#${id}`, id, envelope: envelope(32), receivedAt: f.now() + 1, expiresAt};
      const marker = {pk, sk: `REPORTID#${id}`, id, reportSk: report.sk, receivedAt: report.receivedAt, expiresAt};
      await f.store.transact([{put: report, condition: {absent: true}}, {put: marker, condition: {absent: true}}, {key: {pk, sk: 'REPORTCOUNT'}, add: {count: 1}, set: {rev: randomUUID()}, condition: {attribute: 'count', lt: LIMITS.reports}}]);
      const observedDuringInsert = await originalQuery(pk, options);
      await f.store.transact([{key: {pk, sk: report.sk}, delete: true}, {key: {pk, sk: marker.sk}, delete: true}, {key: {pk, sk: 'REPORTCOUNT'}, add: {count: -1}, set: {rev: randomUUID()}}]);
      return observedDuringInsert;
    }
    return originalQuery(queryPk, options);
  };
  assert.equal((await f.request('POST', '/reports', {id: randomUUID(), envelope: envelope(32)})).statusCode, 200);
  const active = await originalQuery(pk, {from: 'REPORT#', to: 'REPORT#\uffff'});
  const counter = await f.store.get(pk, 'REPORTCOUNT');
  assert.equal(active.length, 2); assert.equal(counter.count, active.length); assert.equal(typeof counter.rev, 'string');
});

test('report submissions have a short-window per-IP rate limit', async () => {
  const f = fixture(); await f.create();
  const results = await Promise.all(Array.from({length: 6}, () => f.request('POST', '/reports', {id: randomUUID(), envelope: envelope(32)})));
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 200, 200, 200, 200, 429]);
  assert.equal(results.find(result => result.statusCode === 429).json.code, 'rate_limited');
});

test('concurrent chat commits allocate unique cursors without losing late messages', async () => {
  const f = fixture(); await f.create();
  const payloads = Array.from({length: 8}, () => ({id: randomUUID(), payload: envelope()}));
  const results = await Promise.all(payloads.map((payload, i) => f.request('POST', '/messages', payload, f.read, `192.0.2.${i + 2}`)));
  assert.ok(results.every(r => r.statusCode === 200)); assert.equal(new Set(results.map(r => r.json.cursor)).size, 8);
  const all = (await f.request('GET', '/messages')).json.messages;
  assert.equal(all.length, 8); assert.deepEqual(new Set(all.map(m => m.id)), new Set(payloads.map(m => m.id)));
});

test('chat returns last 100 and expires old ciphertext even before Dynamo TTL deletion', async () => {
  const f = fixture(); await f.create();
  const ids = [];
  for (let i = 0; i < 112; i++) { f.advance(60001); const id = randomUUID(); ids.push(id); assert.equal((await f.request('POST', '/messages', {id, payload: envelope()})).statusCode, 200); }
  const last = await f.request('GET', '/messages');
  assert.equal(last.json.messages.length, 100); assert.deepEqual(last.json.messages.map(m => m.id), ids.slice(-100));
  f.advance(86400001); assert.deepEqual((await f.request('GET', '/messages')).json.messages, []);
});

test('push validation rejects SSRF, malformed keys, unsupported hosts and credentials', () => {
  const good = subscription(); assert.equal(validateSubscription(good).endpoint, good.endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/send/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://fcm.googleapis.com.evil.invalid/x', 'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com/x#secret']) assert.throws(() => validateSubscription({...good, endpoint}));
  assert.throws(() => validateSubscription({...good, keys: {...good.keys, auth: 'x'}}));
  assert.throws(() => validateSubscription({...good, keys: {...good.keys, p256dh: randomBytes(65).toString('base64url')}}));
});

test('subscriptions are private, idempotent and club scoped', async () => {
  const f = fixture(), other = fixture(); await f.create(); await other.create();
  const sub = subscription(), first = await f.register(sub), second = await f.register(sub);
  assert.equal(first.statusCode, 200); assert.equal(first.json.id, second.json.id);
  assert.equal((await f.store.get(`CLUB#${f.id}`, 'SUBCOUNT')).count, 1);
  assert.equal((await other.request('POST', '/reminders/test', {subscriptionId: first.json.id})).statusCode, 404);
  const club = await f.request('GET', ''); assert.ok(!club.body.includes(sub.endpoint)); assert.ok(!club.body.includes(sub.keys.auth));
  assert.equal((await f.request('DELETE', '/subscriptions', {id: first.json.id})).statusCode, 200);
  assert.equal((await f.request('DELETE', '/subscriptions', {id: first.json.id})).statusCode, 200);
  assert.equal((await f.store.get(`CLUB#${f.id}`, 'SUBCOUNT')).count, 0);
});

test('subscription capacity is bounded and reconciles asynchronously expired items', async () => {
  const f = fixture(); await f.create();
  for (let i = 0; i < 50; i++) assert.equal((await f.register(subscription(), [f.event.id], `192.0.2.${i + 1}`)).statusCode, 200);
  assert.equal((await f.register(subscription(), [f.event.id], '192.0.2.200')).statusCode, 429);
  const all = await f.store.query(`CLUB#${f.id}`, {from: 'SUB#', to: 'SUB#\uffff'});
  await f.store.transact([{key: {pk: all[0].pk, sk: all[0].sk}, delete: true}]); // Simulate background TTL removal.
  assert.equal((await f.register(subscription(), [f.event.id], '192.0.2.201')).statusCode, 200);
  assert.equal((await f.store.get(`CLUB#${f.id}`, 'SUBCOUNT')).count, 50);
});

test('disabled push is honest and actual transport cannot fake successful delivery', async () => {
  const f = fixture({enabled: false}); await f.create(); const registered = await f.register();
  assert.deepEqual((await f.request('GET', '/v1/config')).json, {vapidPublicKey: '', serverTime: f.now(), pushEnabled: false});
  assert.equal((await f.request('POST', '/reminders/test', {subscriptionId: registered.json.id})).statusCode, 503);
  const transport = createPushTransport(); assert.equal(transport.enabled, false);
  await assert.rejects(transport.send(subscription(), {}), /not configured/);
  f.advance(60001); assert.equal((await f.reminders()).enabled, false); assert.equal(f.deliveries.length, 0);
});

test('test reminder is generic, accepted only after transport success and rate bounded', async () => {
  const f = fixture(); await f.create(); const sub = await f.register();
  assert.equal((await f.request('POST', '/reminders/test', {subscriptionId: sub.json.id})).statusCode, 200);
  assert.equal(f.deliveries.length, 1); const payload = f.deliveries[0].payload;
  assert.equal(payload.url, `https://www.sameend.com/#openclub=${f.id}`); assert.equal(payload.title, 'Your mates are gathering');
  assert.ok(!JSON.stringify(payload).includes(f.read));
  assert.equal((await f.request('POST', '/reminders/test', {subscriptionId: sub.json.id})).statusCode, 200);
  assert.equal((await f.request('POST', '/reminders/test', {subscriptionId: sub.json.id})).statusCode, 429);
});

test('a 410 response prunes the private subscription and fails honestly', async () => {
  const f = fixture({send: async () => {throw Object.assign(new Error('gone'), {statusCode: 410});}}); await f.create(); const sub = await f.register();
  const result = await f.request('POST', '/reminders/test', {subscriptionId: sub.json.id});
  assert.equal(result.statusCode, 410); assert.equal(result.json.code, 'subscription_expired');
  assert.equal(await f.store.get(`CLUB#${f.id}`, `SUB#${sub.json.id}`), undefined); assert.equal(f.deliveries.length, 0);
});

test('scheduler sends selected event once across repeated and simultaneous invocations', async () => {
  const f = fixture(); await f.create(); await f.register(); await f.register(subscription(), []);
  assert.equal((await f.reminders()).sent, 0); f.advance(60001);
  await Promise.all([f.reminders(), f.reminders()]); await f.reminders();
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].payload.eventId, f.event.id);
  assert.equal((await f.store.query('DUE', {index: true})).length, 0);
});

test('scheduler retries transient failures without resending accepted subscriptions', async () => {
  let calls = 0;
  const f = fixture({send: async sub => { if (sub.endpoint.endsWith('/retry') && calls++ === 0) throw Object.assign(new Error('transient'), {statusCode: 503}); }});
  await f.create(); await f.register(subscription('https://fcm.googleapis.com/fcm/send/retry')); await f.register();
  f.advance(60001); const first = await f.reminders(); assert.equal(first.sent, 1); assert.equal(first.failed, 1);
  assert.equal(f.deliveries.length, 1); assert.equal((await f.reminders()).sent, 0);
  f.advance(120001); const second = await f.reminders(); assert.equal(second.sent, 1); assert.equal(f.deliveries.length, 2);
  f.advance(1000000); await f.reminders(); assert.equal(f.deliveries.length, 2);
});

test('scheduler limits failed delivery attempts, prunes 410 and ignores cleared schedules', async () => {
  let attempts = 0;
  const f = fixture({send: async () => {attempts++; throw Object.assign(new Error('unavailable'), {statusCode: 503});}});
  await f.create(); await f.register();
  for (let i = 0; i < 7; i++) {f.advance(10 * 60000); await f.reminders();}
  assert.equal(attempts, 4);
  const gone = fixture({send: async () => {throw Object.assign(new Error('gone'), {statusCode: 410});}}); await gone.create(); await gone.register(); gone.advance(60001);
  assert.equal((await gone.reminders()).pruned, 1); assert.equal((await gone.store.query(`CLUB#${gone.id}`, {from: 'SUB#', to: 'SUB#\uffff'})).length, 0);
  const cleared = fixture(); await cleared.create(); await cleared.register(); await cleared.request('PUT', '', {expectedVersion: 1, state: envelope(), events: []}, cleared.write); cleared.advance(60001); await cleared.reminders(); assert.equal(cleared.deliveries.length, 0);
});

test('scheduler persists progress across a bounded 30-delivery invocation', async () => {
  const f = fixture(); await f.create();
  for (let i = 0; i < 35; i++) assert.equal((await f.register(subscription(), [f.event.id], `192.0.2.${i + 1}`)).statusCode, 200);
  f.advance(60001); assert.equal((await f.reminders()).sent, 30); assert.equal(f.deliveries.length, 30);
  f.advance(60001); assert.equal((await f.reminders()).sent, 5); assert.equal(f.deliveries.length, 35);
});

test('CORS is exact and SDK/provider details stay out of error responses', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', '/v1/config', undefined, undefined, undefined, {origin: 'https://www.sameend.com'})).headers['access-control-allow-origin'], 'https://www.sameend.com');
  const evil = await f.request('GET', '/v1/config', undefined, undefined, undefined, {origin: 'https://www.sameend.com.evil.invalid'});
  assert.equal(evil.statusCode, 403); assert.equal(evil.headers['access-control-allow-origin'], undefined);
  f.store.consume = async () => {throw new Error('private endpoint bearer provider account secret');};
  const failed = await f.request('POST', '/v1/clubs', f.club);
  assert.equal(failed.statusCode, 503); assert.ok(!failed.body.includes('bearer')); assert.equal(failed.json.code, 'service_unavailable');
});

test('Dynamo adapter emits bounded conditional writes, query keys and consistent reads', async () => {
  const commands = [];
  const client = {async send(command) {commands.push(command); if (command.constructor.name === 'GetCommand') return {Item: {id: 'x'}}; return {Items: [], Attributes: {count: 1}};}};
  const store = new DynamoDBStore('own-table', {client});
  assert.deepEqual(await store.get('p', 's'), {id: 'x'}); assert.equal(commands.at(-1).input.ConsistentRead, true);
  await store.transact([{put: {pk: 'p', sk: 's', version: 2}, condition: {attribute: 'version', equals: 1}}, {key: {pk: 'p', sk: 'count'}, add: {count: 1, rev: 1}, set: {expiresAt: 123}, condition: {attribute: 'count', lt: 50}}]);
  const tx = commands.at(-1).input.TransactItems; assert.equal(tx[0].Put.ConditionExpression, '#condition = :condition'); assert.equal(tx[1].Update.ExpressionAttributeValues[':condition'], 50); assert.equal(tx[1].Update.TableName, 'own-table');
  await store.query('DUE', {index: true, limit: 5, to: '0000000000000001#\uffff'}); assert.equal(commands.at(-1).input.IndexName, 'due'); assert.equal(commands.at(-1).input.Limit, 5); assert.equal(commands.at(-1).input.ConsistentRead, undefined);
  const failed = new DynamoDBStore('own-table', {client: {async send() {throw Object.assign(new Error('internal'), {name: 'TransactionCanceledException', CancellationReasons: [{Code: 'ConditionalCheckFailed'}]});}}});
  await assert.rejects(failed.transact([{put: {pk: 'a', sk: 'b'}, condition: {absent: true}}]), Conflict);
});

test('CloudFormation scopes IAM, enables TTL, caps throughput and hides private key', () => {
  assert.equal(template.Parameters.VapidPrivateKey.NoEcho, true);
  assert.equal(template.Resources.Control.Properties.Runtime, 'nodejs24.x');
  assert.equal(template.Resources.Clubs.Properties.TimeToLiveSpecification.AttributeName, 'expiresAt');
  assert.equal(template.Resources.Stage.Properties.DefaultRouteSettings.ThrottlingRateLimit, 20);
  assert.equal(template.Resources.Stage.Properties.DefaultRouteSettings.ThrottlingBurstLimit, 40);
  assert.equal(template.Resources.Clubs.Properties.OnDemandThroughput.MaxWriteRequestUnits, 50);
  const policies = template.Resources.RuntimeRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.ok(policies.every(p => p.Resource !== '*')); assert.ok(policies.every(p => !p.Action.includes('s3:*')));
  assert.deepEqual(template.Resources.Api.Properties.CorsConfiguration.AllowOrigins, ['https://www.sameend.com']);
  assert.equal(template.Resources.Reminders.Properties.ScheduleExpression, 'rate(1 minute)');
  assert.equal(artifactTemplate.Resources.Artifacts.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
});


test('eight same-IP contexts can poll both club and chat for one minute', async () => {
  const f = fixture(); await f.create();
  const failures = [];
  for (let cycle = 0; cycle < 30; cycle++) {
    const results = await Promise.all(Array.from({length: 8}, async () => {
      const state = await f.request('GET', '', undefined, f.read, '192.0.2.10');
      const chat = await f.request('GET', '/messages', undefined, f.read, '192.0.2.10');
      return [state.statusCode, chat.statusCode];
    }));
    failures.push(...results.flat().filter(code => code !== 200));
    f.advance(1999);
  }
  assert.deepEqual(failures, []);
  const receipts = await Promise.all(Array.from({length: 3}, (_, i) => f.request('POST', '/messages', {id: randomUUID(), payload: envelope()}, f.read, '192.0.2.10')));
  assert.ok(receipts.every(r => r.statusCode === 200));
  assert.equal((await f.request('GET', '/messages')).json.messages.length, 3);
});


test('Dynamo adapter follows 1 MiB continuation pages up to the requested chat count', async () => {
  const messages = Array.from({length: 100}, (_, n) => ({pk: 'p', sk: 'MSG#' + String(100 - n).padStart(16, '0'), payload: envelope(LIMITS.messageBytes)}));
  const calls = [], next = {pk: 'p', sk: messages[59].sk};
  const store = new DynamoDBStore('own-table', {client: {async send(command) {
    calls.push(command.input);
    return calls.length === 1 ? {Items: messages.slice(0, 60), LastEvaluatedKey: next} : {Items: messages.slice(60)};
  }}});
  const result = await store.query('p', {from: 'MSG#', to: 'MSG#\uffff', reverse: true, limit: 100});
  assert.equal(result.length, 100); assert.deepEqual(result, messages);
  assert.equal(calls.length, 2); assert.equal(calls[0].Limit, 100); assert.equal(calls[1].Limit, 40);
  assert.deepEqual(calls[1].ExclusiveStartKey, next); assert.equal(calls[1].ScanIndexForward, false);
});

test('maximum owner rescheduling stays below DynamoDB transaction item and size limits', async () => {
  const f = fixture(), counts = [], sizes = [], original = f.store.transact.bind(f.store);
  f.store.transact = async ops => { counts.push(ops.length); sizes.push(Buffer.byteLength(JSON.stringify(ops))); return original(ops); };
  const events = Array.from({length: 30}, (_, n) => ({id: randomUUID(), startsAt: f.now() + (n + 1) * 86400000, notifyAt: f.now() + (n + 1) * 86400000 - 900000}));
  f.club.events = events; f.club.state = envelope(LIMITS.stateBytes); await f.create();
  const result = await f.request('PUT', '', {expectedVersion: 1, state: envelope(LIMITS.stateBytes), events: events.map(e => ({...e, startsAt: e.startsAt + 3600000, notifyAt: e.notifyAt + 3600000}))}, f.write);
  assert.equal(result.statusCode, 200); assert.equal(Math.max(...counts), 61); assert.ok(Math.max(...sizes) < 4 * 1024 * 1024);
});

test('coordinator and ICE require a club capability', async () => {
  const f = fixture(); await f.create();
  const report = {role:'source',leafOnly:false,clockReady:true,sourceReachable:true,trail:[],parentId:null,children:[],relayLimit:1,sourceAgeSeconds:0,reserveSeconds:0,requestedRenditions:['audio'],cache:[{rendition:'audio',start:0,end:1,firstSeq:0,lastSeq:1}],outgoingMbps:1,queueBytes:0};
  const body={action:'report',cast:'cast',nodeId:'source',seq:1,report};
  assert.equal((await f.request('POST','/coordinator',body,'')).statusCode,401);
  assert.equal((await f.request('GET','/ice',undefined,'')).statusCode,401);
  const result=await f.request('POST','/coordinator',body);
  assert.equal(result.statusCode,200); assert.ok(result.json.leaseToken);
  const ice=await f.request('GET','/ice'); assert.equal(ice.statusCode,200); assert.deepEqual(ice.json.iceServers,[]);
});

test('signed fresh edge health gates credential issuance', async () => {
  const f=fixture(); await f.create(); const secret='a'.repeat(32), time=f.now();
  const policy={reportTtlMs:15000,uplinkBudgetMbps:100,allocationLimit:100};
  const api=createApi({store:f.store,push:f.push,now:f.now,edgeTurn:{urls:['turn:edge.example.com:3478'],secret:'b'.repeat(32),healthSecret:secret,policy}});
  const request=async(method,path,body,headers={})=>api.handler({rawPath:path,headers,body:body||'',requestContext:{http:{method,sourceIp:'local'}}});
  const ice=async()=>JSON.parse((await request('GET',`/v1/clubs/${f.id}/ice`,'',{authorization:`Bearer ${f.read}`})).body);
  assert.deepEqual((await ice()).iceServers,[]);
  const body=JSON.stringify({sampledAtMs:time,cpuBusyRatio:0.1,memoryAvailableRatio:0.8,networkTxMbps:1,allocations:1});
  const signature=createHmac('sha256',secret).update(`${time}.`).update(body).digest('hex');
  const headers={'x-edge-timestamp':String(time),'x-edge-signature':signature};
  assert.equal((await request('POST','/v1/edge-health',body,headers)).statusCode,200);
  assert.equal((await ice()).iceServers.length,1);
  assert.equal((await request('POST','/v1/edge-health',body,headers)).statusCode,409);
  f.advance(1); const pressure=JSON.stringify({sampledAtMs:f.now(),cpuBusyRatio:0.99,memoryAvailableRatio:0.8,networkTxMbps:1,allocations:1});
  const pressureHeaders={'x-edge-timestamp':String(f.now()),'x-edge-signature':createHmac('sha256',secret).update(`${f.now()}.`).update(pressure).digest('hex')};
  assert.equal((await request('POST','/v1/edge-health',pressure,pressureHeaders)).statusCode,200);
  assert.deepEqual((await ice()).iceServers,[],'fresh constrained health stops issuing new credentials');
  f.advance(15001); assert.deepEqual((await ice()).iceServers,[]);
});
