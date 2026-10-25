import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {MemoryStore, Conflict} from '../store.mjs';
import {createCommunityApi, COMMUNITY_LIMITS} from '../community-api.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const issuer = 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Pilot';
const clientId = 'pilotclient';
function fixture(options = {}) {
  let time = Date.UTC(2026, 9, 25, 10);
  const store = options.store || new MemoryStore(), adminAuth = options.adminAuth || {issuer, clientId, domain: 'https://pilot.auth.eu-west-2.amazoncognito.com', redirectUri: 'https://sameend.test/manage.html'};
  const api = createCommunityApi({store, now: () => time, allowedOrigins: ['https://sameend.test'], adminAuth, ...options});
  async function request(method, suffix, body, {token, role, claims, origin = 'https://sameend.test', ip = '192.0.2.1', query, raw, headers = {}} = {}) {
    const event = {rawPath: `/v1/community${suffix}`, requestContext: {http: {method, sourceIp: ip}}, headers: {origin, ...(body !== undefined && {'content-type': 'application/json'}), ...(token && {authorization: `Bearer ${token}`}), ...headers}, queryStringParameters: query, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)};
    if (role || claims) event.requestContext.authorizer = {jwt: {claims: {iss: issuer, aud: clientId, token_use: 'id', sub: 'staff-opaque', exp: Math.floor(time / 1000) + 3600, 'cognito:groups': [`sameend-${role || 'admin'}`], ...claims}}};
    const result = await api.handler(event); return {...result, json: JSON.parse(result.body)};
  }
  const admin = (method, suffix, body, options = {}) => request(method, `/admin${suffix}`, body, {role: 'admin', ...options});
  async function identity(name = 'Fan', extra = {}) {
    const token = randomBytes(32).toString('base64url'), fanId = randomUUID();
    const response = await request('POST', '/identities', {id: fanId, tokenHash: hash(token), name}, extra);
    assert.equal(response.statusCode, 200, JSON.stringify(response.json));
    return {id: fanId, token, profile: response.json};
  }
  async function enable() { const before = await admin('GET', '/settings'); return admin('POST', '/settings', {forumEnabled: true, joinCode: 'pilot-rules-2026', expectedVersion: before.json.version}); }
  async function member(name = 'Fan') {
    const who = await identity(name); const result = await request('POST', '/membership', {code: 'pilot-rules-2026', agree: true}, who); assert.equal(result.statusCode, 200, JSON.stringify(result.json)); return {...who, profile: result.json};
  }
  async function thread(who, extra = {}) {
    const response = await request('POST', '/threads', {id: randomUUID(), category: 'general', title: 'A conversation', text: 'A plain text thought.', spoiler: false, ...extra}, who); assert.equal(response.statusCode, 200, JSON.stringify(response.json)); return response.json;
  }
  return {store, request, admin, identity, member, thread, enable, now: () => time, advance: amount => {time += amount;}};
}
const ok = response => assert.equal(response.statusCode, 200, JSON.stringify(response.json));

test('verified gateway group claims accept bounded AWS string encodings without partial role matches',async()=>{
 const f=fixture();
 for(const groups of ['[sameend-admin]','[sameend-support sameend-editor]','[sameend-support,sameend-editor]','["sameend-support"]','sameend-support'])ok(await f.request('GET','/admin/feedback',undefined,{claims:{'cognito:groups':groups}}));
 for(const groups of ['[sameend-administrator]','[sameend-support.evil]','["sameend-support",7]','x'.repeat(2049)])assert.equal((await f.request('GET','/admin/feedback',undefined,{claims:{'cognito:groups':groups}})).statusCode,403);
});

test('fan identity is distinct from room keys, registration is credential-bound, config contains no code/hash', async () => {
  const f = fixture(), a = await f.identity('Alice');
  ok(await f.request('POST', '/identities', {id: a.id, tokenHash: hash(a.token), name: 'Changed'}));
  assert.equal((await f.request('GET', '/me', undefined, a)).json.name, 'Alice');
  assert.equal((await f.request('POST', '/identities', {id: a.id, tokenHash: hash('different'), name: 'Other'})).statusCode, 409);
  assert.equal((await f.request('POST', '/identities', {id: randomUUID(), tokenHash: hash(a.token), name: 'Other'})).statusCode, 409);
  assert.equal((await f.request('GET', '/me', undefined, {token: randomBytes(32).toString('base64url')})).statusCode, 401);
  await f.store.put({pk: 'CLUB#unrelated', sk: 'META', readTokenHash: hash(a.token), expiresAt: f.now() / 1000 + 1000});
  const roomToken = randomBytes(32).toString('base64url');
  await f.store.put({pk: 'CLUB#other', sk: 'META', readTokenHash: hash(roomToken), expiresAt: f.now() / 1000 + 1000});
  assert.equal((await f.request('GET', '/me', undefined, {token: roomToken})).statusCode, 401);
  const config = await f.request('GET', '/config'); ok(config); assert.equal(config.json.forumEnabled, false); assert.equal(config.json.retentionDays, 365);
  assert.doesNotMatch(config.body, /tokenHash|joinCode|pilot-rules/);
  assert.equal((await f.request('GET', '/threads', undefined, a)).statusCode, 403);
});

test('feedback works without joining, remains owner/support private, persists and idempotently retains original body', async () => {
  const f = fixture(), a = await f.identity('Alice'), b = await f.identity('Bob'), feedbackId = randomUUID();
  const body = {id: feedbackId, kind: 'problem', title: 'No sound', text: 'My playback was quiet.', contact: 'alice@example.test', diagnostics: {build: 'v120', role: 'viewer', roomState: 'connected', online: true, reserveSeconds: 6}};
  const first = await f.request('POST', '/feedback', body, a); ok(first); assert.equal(first.json.status, 'received'); assert.equal(first.json.version, 1);
  const duplicate = await f.request('POST', '/feedback', {...body, text: 'Do not overwrite'}, a); assert.deepEqual(duplicate.json, first.json);
  assert.equal((await f.request('GET', '/feedback', undefined, b)).json.items.length, 0);
  assert.equal((await f.request('GET', '/feedback', undefined, a)).json.items[0].contact, body.contact);
  const restarted = createCommunityApi({store: f.store, now: f.now, adminAuth: {issuer, clientId}, allowedOrigins: []});
  const persisted = await restarted.handler({rawPath: '/v1/community/feedback', requestContext: {http: {method: 'GET'}}, headers: {authorization: `Bearer ${a.token}`}});
  assert.equal(JSON.parse(persisted.body).items[0].text, body.text);
  assert.equal((await f.admin('GET', '/feedback', undefined, {role: 'moderator'})).statusCode, 403);
  assert.equal((await f.admin('GET', '/feedback', undefined, {role: 'editor'})).statusCode, 403);
  const listing = await f.admin('GET', '/feedback', undefined, {role: 'support'}); ok(listing); assert.equal(listing.json.items[0].ownerId, a.id);
  for (const [index, status] of ['investigating', 'answered', 'fixed'].entries()) {
    const result = await f.admin('POST', `/feedback/${feedbackId}`, {status, response: `Reply ${index}`, expectedVersion: index + 1}, {role: 'support'}); ok(result); assert.equal(result.json.version, index + 2);
  }
  const owner = await f.request('GET', '/feedback', undefined, a); assert.equal(owner.json.items[0].status, 'fixed'); assert.equal(owner.json.items[0].response, 'Reply 2');
  const audit = await f.admin('GET', '/audit'); assert.equal(audit.json.items.length, 3); assert.doesNotMatch(audit.body, /alice@|playback was|No sound|Reply 2/);
});

test('production staff trusts verified gateway claims only and validates issuer/audience/token type/expiry/groups', async () => {
  const f = fixture(), fan = await f.identity();
  assert.equal((await f.request('GET', '/admin/settings', undefined, fan)).statusCode, 401);
  const forged = Buffer.from(JSON.stringify({iss: issuer, aud: clientId, 'cognito:groups': ['sameend-admin']})).toString('base64url');
  assert.equal((await f.request('GET', '/admin/settings', undefined, {token: `e30.${forged}.fake`, headers: {'x-role': 'sameend-admin'}})).statusCode, 401);
  for (const claims of [{iss: 'https://attacker.test'}, {aud: 'wrong'}, {token_use: 'access'}, {exp: f.now() / 1000 - 1}, {nbf: f.now() / 1000 + 60}, {sub: ''}]) assert.equal((await f.admin('GET', '/settings', undefined, {claims})).statusCode, 401);
  for (const role of ['support', 'moderator', 'editor', 'unknown']) assert.equal((await f.admin('GET', '/settings', undefined, {role})).statusCode, 403);
  ok(await f.admin('GET', '/settings', undefined, {claims: {'cognito:groups': '["sameend-admin"]'}}));
  assert.equal((await f.admin('GET', '/audit', undefined, {role: 'support'})).statusCode, 403);
  assert.equal((await f.admin('GET', '/threads', undefined, {role: 'support'})).statusCode, 403);
  assert.equal((await f.admin('GET', '/content', undefined, {role: 'moderator'})).statusCode, 403);
});

test('local injected admin is isolated from configured production and Lambda', async () => {
  const token = randomBytes(32).toString('base64url'), localHash = hash(token);
  const local = fixture({adminAuth: {}, localAdminTokenHash: localHash}); ok(await local.request('GET', '/admin/settings', undefined, {token}));
  assert.equal((await local.request('GET', '/me', undefined, {token})).statusCode, 401);
  const production = fixture({localAdminTokenHash: localHash}); assert.equal((await production.request('GET', '/admin/settings', undefined, {token})).statusCode, 401);
  const original = process.env.AWS_LAMBDA_FUNCTION_NAME;
  try {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-lambda';
    const lambda = fixture({adminAuth: {}, localAdminTokenHash: localHash}); assert.equal((await lambda.request('GET', '/admin/settings', undefined, {token})).statusCode, 401);
  } finally { if (original === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME; else process.env.AWS_LAMBDA_FUNCTION_NAME = original; }
});

test('forum requires opt-in rules and separate hashed pilot code; settings persist and stale changes fail', async () => {
  const f = fixture(), a = await f.identity();
  assert.equal((await f.admin('POST', '/settings', {forumEnabled: true, expectedVersion: 0})).statusCode, 400);
  ok(await f.enable());
  assert.equal((await f.request('POST', '/membership', {code: 'pilot-rules-2026', agree: false}, a)).statusCode, 400);
  assert.equal((await f.request('POST', '/membership', {code: 'incorrect-code', agree: true}, a)).statusCode, 403);
  const joined = await f.request('POST', '/membership', {code: 'pilot-rules-2026', agree: true}, a); ok(joined); assert.equal(joined.json.forumMember, true);
  assert.doesNotMatch(JSON.stringify(await f.store.get('COMMUNITY#PILOT', 'SETTINGS')), /pilot-rules/);
  assert.equal((await f.admin('POST', '/settings', {forumEnabled: false, expectedVersion: 0})).statusCode, 409);
  const settings = await f.admin('GET', '/settings'); assert.deepEqual(settings.json, {forumEnabled: true, hasJoinCode: true, version: 1});
  ok(await f.admin('POST', '/settings', {forumEnabled: false, expectedVersion: 1}));
  assert.equal((await f.request('GET', '/threads', undefined, a)).statusCode, 403);
  ok(await f.request('GET', '/feedback', undefined, a));
});

test('two separate fans share threads/replies, match spoiler protection, privacy and idempotent posts', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob');
  const thread = await f.thread(a, {category: 'match', spoiler: false, text: '<script>alert("text")</script>'}); assert.equal(thread.spoiler, true);
  const duplicate = await f.request('POST', '/threads', {id: thread.id, category: 'general', title: 'Changed', text: 'Changed', spoiler: false}, a); assert.deepEqual(duplicate.json, thread);
  const replyBody = {id: randomUUID(), text: 'A separate fan replies.'};
  const reply = await f.request('POST', `/threads/${thread.id}/replies`, replyBody, b); ok(reply); assert.equal(reply.json.authorId, b.id);
  assert.deepEqual((await f.request('POST', `/threads/${thread.id}/replies`, {...replyBody, text: 'Changed'}, b)).json, reply.json);
  const read = await f.request('GET', `/threads/${thread.id}`, undefined, b); ok(read); assert.equal(read.json.replies.length, 1); assert.equal(read.json.thread.version, 2);
  assert.equal(read.json.thread.text, '<script>alert("text")</script>');
  const list = await f.request('GET', '/threads', undefined, b); assert.equal(list.json.items[0].replyCount, 1); assert.doesNotMatch(list.body, /tokenHash|blockedMemberIds|contact|diagnostics|reason/);
  assert.equal((await f.request('POST', '/posts/delete', {threadId: thread.id, postId: reply.json.id, expectedVersion: 1}, a)).statusCode, 403);
});

test('moderation hides posts, locks threads, cannot restore author-deleted text, blocks omit authors', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob'), t = await f.thread(a);
  const r = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Reply to moderate'}, b); ok(r);
  const moderate = (postId, action, expectedVersion) => f.admin('POST', '/moderation', {threadId: t.id, postId, action, reason: 'Forum rules', expectedVersion}, {role: 'moderator'});
  ok(await moderate(r.json.id, 'hide', 1));
  assert.equal((await f.request('GET', `/threads/${t.id}`, undefined, a)).json.replies.length, 0);
  const adminRead = await f.admin('GET', `/threads/${t.id}`, undefined, {role: 'moderator'}); assert.equal(adminRead.json.replies[0].hidden, true);
  ok(await moderate(r.json.id, 'restore', 2));
  ok(await moderate(t.id, 'lock', 2));
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Locked reply'}, b)).statusCode, 403);
  assert.equal((await moderate(t.id, 'unlock', 2)).statusCode, 409);
  ok(await moderate(t.id, 'unlock', 3));
  ok(await f.request('POST', '/posts/delete', {threadId: t.id, postId: r.json.id, expectedVersion: 3}, b));
  assert.equal((await moderate(r.json.id, 'restore', 4)).statusCode, 409);
  assert.equal((await f.admin('GET', `/threads/${t.id}`, undefined, {role: 'moderator'})).json.replies[0].text, '');
  const blocked = await f.request('POST', '/blocks', {memberId: a.id, blocked: true}, b); ok(blocked); assert.deepEqual(blocked.json.blockedMemberIds, [a.id]);
  assert.equal((await f.request('GET', '/threads', undefined, b)).json.items.length, 0);
  assert.equal((await f.request('GET', `/threads/${t.id}`, undefined, b)).statusCode, 404);
  ok(await f.request('POST', '/blocks', {memberId: a.id, blocked: false}, b));
  ok(await moderate(t.id, 'hide', 4));
  assert.equal((await f.request('GET', '/threads', undefined, b)).json.items.length, 0);
  assert.equal((await f.request('GET', `/threads/${t.id}`, undefined, a)).statusCode, 404);
  assert.equal((await f.admin('GET', '/threads', undefined, {role: 'moderator'})).json.items[0].hidden, true);
  ok(await f.request('POST', '/posts/delete', {threadId: t.id, postId: t.id, expectedVersion: 5}, a));
  const deleted = await f.admin('GET', `/threads/${t.id}`, undefined, {role: 'moderator'}); assert.equal(deleted.json.thread.deleted, true); assert.equal(deleted.json.thread.text, '');
});

test('reports are private staff work items, resolution persists, suspension blocks participation but preserves own feedback', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob'), t = await f.thread(a), reportId = randomUUID();
  const result = await f.request('POST', '/reports', {id: reportId, threadId: t.id, postId: t.id, reason: 'Private report reason'}, b); ok(result); assert.deepEqual(result.json, {id: reportId, status: 'open'});
  const reports = await f.admin('GET', '/reports', undefined, {role: 'moderator'}); assert.equal(reports.json.items[0].reporterId, b.id);
  ok(await f.admin('POST', `/reports/${reportId}`, {status: 'resolved', note: 'Staff-only note', expectedVersion: 1}, {role: 'moderator'}));
  assert.equal((await f.admin('POST', `/reports/${reportId}`, {status: 'open', note: 'Stale', expectedVersion: 1})).statusCode, 409);
  assert.doesNotMatch((await f.request('GET', `/threads/${t.id}`, undefined, a)).body, /Private report|Staff-only/);
  const before = await f.admin('GET', `/members/${b.id}`, undefined, {role: 'moderator'}); ok(before);
  assert.deepEqual(Object.keys(before.json).sort(), ['id', 'name', 'status', 'version']);
  const suspended = await f.admin('POST', `/members/${b.id}`, {status: 'suspended', expectedVersion: before.json.version}, {role: 'moderator'}); ok(suspended);
  // Reading is public; a suspended identity can read like any guest but cannot take part.
  ok(await f.request('GET', '/threads', undefined, b));
  assert.equal((await f.request('POST', '/threads', {id: randomUUID(), category: 'general', title: 'Suspended', text: 'Should fail', spoiler: false}, b)).statusCode, 403);
  assert.equal((await f.request('POST', '/votes', {threadId: t.id, postId: t.id, value: 1}, b)).statusCode, 403);
  ok(await f.request('GET', '/feedback', undefined, b));
  assert.equal((await f.request('POST', '/membership', {code: 'pilot-rules-2026', agree: true}, b)).statusCode, 403);
});

test('sponsor and quiz fields are labelled, safe HTTPS only, scheduling and 50 KB pack enforced', async () => {
  const f = fixture();
  const ad = {id: randomUUID(), type: 'ad', title: 'Pilot sponsor', body: 'Example sponsor message', sponsor: 'Test sponsor', url: 'https://example.test/offer', published: true, expectedVersion: 0};
  assert.equal((await f.admin('POST', '/content', {...ad, sponsor: undefined}, {role: 'editor'})).statusCode, 400);
  for (const url of ['http://example.test/', 'javascript:alert(1)', 'https://example.test/#invite', 'https://example.test/?token=private', 'https://user:pass@example.test/']) assert.equal((await f.admin('POST', '/content', {...ad, url}, {role: 'editor'})).statusCode, 400);
  assert.equal((await f.admin('POST', '/content', {...ad, body: '<img src="https://tracker.test/pixel">'}, {role: 'editor'})).statusCode, 400);
  const saved = await f.admin('POST', '/content', ad, {role: 'editor'}); ok(saved); assert.equal(saved.json.version, 1);
  const quiz = {id: randomUUID(), type: 'quiz', title: 'Football question', body: 'A short quiz', question: 'How many?', choices: ['Ten', 'Eleven'], answerIndex: 1, explanation: 'Eleven players.', published: true, startsAt: f.now() + 1000, endsAt: f.now() + 3000, expectedVersion: 0};
  ok(await f.admin('POST', '/content', quiz, {role: 'editor'}));
  let pack = await f.request('GET', '/content'); assert.equal(pack.json.items.length, 1); assert.equal(pack.json.items[0].sponsor, 'Test sponsor'); assert.equal(pack.json.items[0].type, 'ad'); assert.equal(pack.json.items[0].published, undefined);
  f.advance(1500); pack = await f.request('GET', '/content'); assert.equal(pack.json.items.length, 2); assert.equal(pack.json.items.find(x => x.type === 'quiz').answerIndex, 1); assert.equal(pack.json.items.find(x => x.type === 'quiz').endsAt, quiz.endsAt);
  f.advance(2000); assert.equal((await f.request('GET', '/content')).json.items.length, 1);
  assert.equal((await f.admin('POST', '/content', {...ad, title: 'Stale'})).statusCode, 409);
  for (let i = 0; i < 12; i++) ok(await f.admin('POST', '/content', {id: randomUUID(), type: 'story', title: `Story ${i}`, body: 'a'.repeat(4000), published: true, expectedVersion: 0}, {role: 'editor'}));
  assert.equal((await f.admin('POST', '/content', {id: randomUUID(), type: 'story', title: 'Too much', body: 'a'.repeat(4000), published: true, expectedVersion: 0}, {role: 'editor'})).statusCode, 400);
  pack = await f.request('GET', '/content'); assert.ok(Buffer.byteLength(pack.body) <= COMMUNITY_LIMITS.packBytes);
  ok(await f.admin('DELETE', `/content/${ad.id}`, {expectedVersion: 1}, {role: 'editor'}));
  assert.equal((await f.request('GET', '/content')).json.items.some(x => x.id === ad.id), false);
});

test('validation, origin, request size, bounded diagnostics and private error handling', async () => {
  const f = fixture(), a = await f.identity();
  assert.equal((await f.request('GET', '/config', undefined, {origin: 'https://attacker.test'})).statusCode, 403);
  const preflight = await f.request('OPTIONS', '/feedback'); assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], 'https://sameend.test');
  assert.equal((await f.request('POST', '/feedback', undefined, {raw: '{broken', headers: {'content-type': 'application/json'}})).statusCode, 400);
  assert.equal((await f.request('POST', '/feedback', undefined, {raw: 'x'.repeat(16385)})).statusCode, 413);
  const body = {id: randomUUID(), kind: 'problem', title: 'Test', text: 'Test'};
  for (const extra of [{roomId: 'secret'}, {diagnostics: {invite: 'secret'}}, {diagnostics: {build: 'https://private.test/'}}, {diagnostics: {reserveSeconds: -1}}, {text: 'x'.repeat(6001)}, {title: 'bad\u0000text'}, {kind: 'unknown'}]) assert.equal((await f.request('POST', '/feedback', {...body, ...extra}, a)).statusCode, 400);
  f.store.consume = async () => { throw new Error('unused store method'); };
  const original = f.store.get; f.store.get = async () => { throw new Error('credential database private secret'); };
  const failure = await f.request('GET', '/config'); assert.equal(failure.statusCode, 503); assert.doesNotMatch(failure.body, /credential|database|secret/); f.store.get = original;
});

test('expiry is enforced during reads, independently of physical TTL deletion', async () => {
  const f = fixture(); await f.enable(); const a = await f.member(), t = await f.thread(a);
  ok(await f.request('POST', '/feedback', {id: randomUUID(), kind: 'worked', title: 'Worked', text: 'It worked'}, a));
  ok(await f.admin('POST', '/content', {id: randomUUID(), type: 'story', title: 'Story', body: 'Body', published: true, expectedVersion: 0}));
  f.advance(366 * 86400000);
  assert.equal((await f.request('GET', '/me', undefined, a)).statusCode, 401);
  assert.equal((await f.request('GET', '/content')).json.items.length, 0);
  assert.equal((await f.admin('GET', '/feedback')).json.items.length, 0);
  assert.equal((await f.admin('GET', '/threads')).json.items.length, 0);
  assert.equal((await f.admin('GET', `/threads/${t.id}`)).statusCode, 404);
  assert.equal((await f.admin('GET', '/audit')).json.items.length, 0);
});

test('filtered lists paginate without dropping visible rows and reject cross-scope cursor reuse', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob');
  for (let i = 0; i < 23; i++) { f.advance(61000); await f.thread(a, {title: `Thread ${i}`}); }
  const first = await f.request('GET', '/threads', undefined, b); assert.equal(first.json.items.length, 20); assert.ok(first.json.cursor);
  const second = await f.request('GET', '/threads', undefined, {...b, query: {cursor: first.json.cursor}}); assert.equal(second.json.items.length, 3); assert.equal(second.json.cursor, null);
  assert.equal(new Set([...first.json.items, ...second.json.items].map(x => x.id)).size, 23);
  assert.equal((await f.request('GET', '/threads', undefined, {...a, query: {cursor: first.json.cursor}})).statusCode, 400);
  assert.equal((await f.admin('GET', '/threads', undefined, {query: {cursor: first.json.cursor}})).statusCode, 400);
  const victim = first.json.items[0]; ok(await f.admin('POST', '/moderation', {threadId: victim.id, postId: victim.id, action: 'hide', reason: 'Rules', expectedVersion: 1}));
  const remaining = await f.request('GET', '/threads', undefined, b); assert.equal(remaining.json.items.length, 20); assert.ok(!remaining.json.items.some(x => x.id === victim.id));
});

test('hard pilot collection limits and fixed rate slots bound storage even with different sources', async () => {
  const f = fixture(), a = await f.identity();
  await f.store.put({pk: 'COMMUNITY#PILOT', sk: 'COUNT#identities', count: COMMUNITY_LIMITS.identities});
  const denied = await f.request('POST', '/identities', {id: randomUUID(), tokenHash: hash(randomBytes(32)), name: 'At capacity'}); assert.equal(denied.statusCode, 429); assert.equal(denied.json.code, 'pilot_capacity');
  await f.store.put({pk: 'COMMUNITY#PILOT', sk: 'COUNT#feedback', count: COMMUNITY_LIMITS.feedback});
  assert.equal((await f.request('POST', '/feedback', {id: randomUUID(), kind: 'problem', title: 'Capacity', text: 'Capacity'}, a)).statusCode, 429);
  for (let i = 0; i < 300; i++) { f.advance(61000); await f.request('GET', '/config', undefined, {ip: `192.0.${Math.floor(i / 255)}.${i % 255}`}); }
  const rateRows = [...f.store.items.values()].filter(x => x.sk.startsWith('RATE#'));
  assert.ok(rateRows.length <= 135, `${rateRows.length} fixed limiter rows`);
  assert.ok(!JSON.stringify(rateRows).includes('192.0.'));
});

test('rate limiting is enforced and duplicate concurrent creation has one persistent row', async () => {
  const f = fixture(), a = await f.identity(), body = {id: randomUUID(), kind: 'problem', title: 'Concurrent', text: 'Only once'};
  const results = await Promise.all([f.request('POST', '/feedback', body, a), f.request('POST', '/feedback', body, a)]); results.forEach(ok); assert.deepEqual(results[0].json, results[1].json);
  assert.equal((await f.store.get('COMMUNITY#PILOT', 'COUNT#feedback')).count, 1);
  assert.equal((await f.store.get('COMMUNITY#PILOT', `FAN#${a.id}`)).feedbackCount, 1);
  for (let i = 0; i < 19; i++) await f.request('POST', '/feedback', {...body, id: randomUUID()}, a);
  const limited = await f.request('POST', '/feedback', {...body, id: randomUUID()}, a); assert.equal(limited.statusCode, 429); assert.equal(limited.json.code, 'rate_limited');
});

test('concurrent stale staff writes cannot overwrite each other and audit commits exactly with state', async () => {
  const f = fixture(), a = await f.identity(), record = await f.request('POST', '/feedback', {id: randomUUID(), kind: 'problem', title: 'Race', text: 'Body'}, a);
  const results = await Promise.all(['First', 'Second'].map(response => f.admin('POST', `/feedback/${record.json.id}`, {status: 'answered', response, expectedVersion: 1}, {role: 'support'})));
  assert.deepEqual(results.map(x => x.statusCode).sort(), [200, 409]);
  const audit = await f.admin('GET', '/audit'); assert.equal(audit.json.items.length, 1);
  const current = (await f.admin('GET', '/feedback')).json.items[0]; assert.equal(current.version, 2); assert.ok(['First', 'Second'].includes(current.response));
  const transact = f.store.transact.bind(f.store);
  f.store.transact = async ops => { if (ops.some(x => x.put?.sk.startsWith('AUDIT#'))) throw new Error('database unavailable'); return transact(ops); };
  assert.equal((await f.admin('POST', `/feedback/${record.json.id}`, {status: 'fixed', response: 'Must roll back', expectedVersion: 2})).statusCode, 503);
  f.store.transact = transact;
  assert.equal((await f.admin('GET', '/feedback')).json.items[0].status, 'answered');
  assert.equal((await f.admin('GET', '/audit')).json.items.length, 1);
});

test('concurrent replies preserve all reply counts and moderation changes through CAS retries', async () => {
  const f = fixture(); await f.enable(); const a = await f.member(), t = await f.thread(a);
  const results = await Promise.all([1, 2, 3, 4].map(i => f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: `Reply ${i}`}, a))); results.forEach(ok);
  const read = await f.request('GET', `/threads/${t.id}`, undefined, a); assert.equal(read.json.thread.replyCount, 4); assert.equal(read.json.replies.length, 4); assert.equal(read.json.thread.version, 5);
  const before = await f.store.get('COMMUNITY#PILOT', `THREAD#${t.id}`);
  await f.store.put({...before, replyCount: COMMUNITY_LIMITS.replies, rev: randomUUID()});
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Beyond limit'}, a)).statusCode, 429);
});

test('Dynamo-compatible transactions have no duplicate keys and bounded operations', async () => {
  const store = new MemoryStore(), transact = store.transact.bind(store); let transactions = 0;
  store.transact = async ops => {
    const keys = ops.map(x => `${(x.put || x.key).pk}\u0000${(x.put || x.key).sk}`); assert.equal(new Set(keys).size, keys.length); assert.ok(ops.length <= 100); transactions++; return transact(ops);
  };
  const f = fixture({store}); await f.enable(); const a = await f.member(), t = await f.thread(a);
  const r = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Reply'}, a); ok(r);
  ok(await f.admin('POST', '/moderation', {threadId: t.id, postId: r.json.id, action: 'hide', reason: 'Rules', expectedVersion: 1}));
  assert.ok(transactions > 10);
});


test('feedback-first identity chooses its forum name on first opt-in and retains private feedback receipts', async () => {
  const f = fixture(), a = await f.identity('Fan');
  const feedback = await f.request('POST', '/feedback', {id: randomUUID(), kind: 'problem', title: 'Before joining', text: 'A private report before forum membership', contact: 'owner@example.test'}, a); ok(feedback);
  await f.enable();
  assert.equal((await f.request('POST', '/membership', {code: 'pilot-rules-2026', agree: true, name: 'a'.repeat(41)}, a)).statusCode, 400);
  const joined = await f.request('POST', '/membership', {code: 'pilot-rules-2026', agree: true, name: 'Chosen Fan'}, a); ok(joined);
  assert.equal(joined.json.id, a.id); assert.equal(joined.json.name, 'Chosen Fan'); assert.equal(joined.json.forumMember, true);
  const receipts = await f.request('GET', '/feedback', undefined, a); ok(receipts); assert.deepEqual(receipts.json.items, [feedback.json]);
  const post = await f.thread(a); assert.equal(post.authorId, a.id); assert.equal(post.authorName, 'Chosen Fan');
  const repeated = await f.request('POST', '/membership', {code: 'pilot-rules-2026', agree: true, name: 'Rename attempt'}, a); ok(repeated); assert.equal(repeated.json.name, 'Chosen Fan');
});

test('anyone can read an open forum without an identity; closed forums stay closed', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', '/threads')).statusCode, 403);
  await f.enable(); const a = await f.member('Alice'), t = await f.thread(a, {title: 'Open to readers'});
  const list = await f.request('GET', '/threads', undefined, {query: {sort: 'new'}}); ok(list);
  assert.equal(list.json.items[0].title, 'Open to readers'); assert.equal(list.json.items[0].myVote, 0); assert.equal(list.json.total, 1);
  assert.doesNotMatch(list.body, /tokenHash|blockedMemberIds|contact|diagnostics/);
  ok(await f.request('GET', `/threads/${t.id}`));
  const guest = await f.identity('Guest'); ok(await f.request('GET', '/threads', undefined, {...guest, query: {sort: 'hot'}}));
  // Taking part still needs the pilot code.
  assert.equal((await f.request('POST', '/threads', {id: randomUUID(), category: 'general', title: 'x', text: 'y', spoiler: false}, guest)).statusCode, 403);
  assert.equal((await f.request('POST', '/votes', {threadId: t.id, postId: t.id, value: 1}, guest)).statusCode, 403);
  assert.equal((await f.request('POST', '/threads', {id: randomUUID(), category: 'general', title: 'x', text: 'y', spoiler: false})).statusCode, 401);
});

test('replies nest to a bounded depth, keep time order and keep placeholders for removed parents', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob'), t = await f.thread(a);
  const post = async (who, text, parentId) => { f.advance(1000); const r = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text, ...(parentId && {parentId})}, who); ok(r); return r.json; };
  const top = await post(b, 'Top level');
  assert.equal(top.parentId, null); assert.equal(top.depth, 1);
  let parent = top; const chain = [top];
  for (let i = 2; i <= 4; i++) { parent = await post(i % 2 ? b : a, `Depth ${i}`, parent.id); chain.push(parent); assert.equal(parent.depth, i); assert.equal(parent.parentId, chain[i - 2].id); }
  const flattened = await post(b, 'Too deep', parent.id);
  assert.equal(flattened.depth, 4); assert.equal(flattened.parentId, chain[2].id); assert.equal(flattened.replyToName, 'Alice');
  const second = await post(a, 'Second top level');
  const read = await f.request('GET', `/threads/${t.id}`, undefined, b); ok(read);
  assert.deepEqual(read.json.replies.map(x => x.text), ['Top level', 'Depth 2', 'Depth 3', 'Depth 4', 'Too deep', 'Second top level']);
  assert.equal(read.json.cursor, null);
  // Removing a comment with replies leaves an anonymous placeholder; a removed leaf disappears.
  ok(await f.request('POST', '/posts/delete', {threadId: t.id, postId: top.id, expectedVersion: 1}, b));
  ok(await f.request('POST', '/posts/delete', {threadId: t.id, postId: second.id, expectedVersion: 1}, a));
  const after = await f.request('GET', `/threads/${t.id}`, undefined, b);
  const holder = after.json.replies.find(x => x.id === top.id);
  assert.equal(holder.deleted, true); assert.equal(holder.text, ''); assert.equal(holder.authorName, ''); assert.equal(holder.authorId, null);
  assert.ok(!after.json.replies.some(x => x.id === second.id));
  // Replying to a removed comment is refused.
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'late', parentId: top.id}, a)).statusCode, 404);
  // A parent must belong to this conversation.
  const other = await f.thread(a, {title: 'Other'});
  assert.equal((await f.request('POST', `/threads/${other.id}/replies`, {id: randomUUID(), text: 'cross', parentId: chain[1].id}, a)).statusCode, 404);
});

test('reply parents respect blocks and moderation races; flattened replies hide unavailable target names', async () => {
  const f = fixture(); await f.enable();
  const alice = await f.member('Alice'), bob = await f.member('Bob'), cara = await f.member('Cara');
  const t = await f.thread(cara);
  const post = async (who, text, parentId) => {
    const response = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text, ...(parentId && {parentId})}, who);
    ok(response); return response.json;
  };
  const holder = await post(alice, 'Placeholder parent');
  await post(cara, 'Visible child', holder.id);
  const holderRow = await f.store.get('COMMUNITY#PILOT', `REPLY#${t.id}#${holder.id}`);
  await f.store.put({...holderRow, replyToName: 'Private placeholder name', replyToId: randomUUID(), rev: randomUUID()});
  const target = await post(alice, 'Alice comment');
  ok(await f.request('POST', '/blocks', {memberId: alice.id, blocked: true}, bob));
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'blocked reply', parentId: target.id}, bob)).statusCode, 404);

  // Model moderation landing after the reply handler reads its parent but before its transaction.
  const originalTransact = f.store.transact.bind(f.store); let raced = false;
  f.store.transact = async ops => {
    if (!raced && ops.some(op => op.put?.sk.startsWith(`REPLY#${t.id}#`) && op.put.id !== target.id) && ops.some(op => op.put?.sk === `REPLY#${t.id}#${target.id}`)) {
      raced = true;
      const current = await f.store.get('COMMUNITY#PILOT', `REPLY#${t.id}#${target.id}`);
      await originalTransact([{put: {...current, hidden: true, rev: randomUUID()}}]);
    }
    return originalTransact(ops);
  };
  const raceReply = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'raced reply', parentId: target.id}, cara);
  f.store.transact = originalTransact;
  assert.equal(raced, true);
  assert.equal(raceReply.statusCode, 404);

  // Create a separate depth-four chain, flatten one reply, then hide its referenced target.
  const root = await post(alice, 'Root'); let parent = root; const chain = [root];
  for (let depth = 2; depth <= 4; depth++) { parent = await post(depth % 2 ? alice : cara, `Depth ${depth}`, parent.id); chain.push(parent); }
  const flattened = await post(bob, 'Flattened', parent.id);
  assert.equal(flattened.replyToName, 'Cara');
  const targetRow = await f.store.get('COMMUNITY#PILOT', `REPLY#${t.id}#${parent.id}`);
  await f.store.put({...targetRow, replyToName: 'Private target name', replyToId: root.id, rev: randomUUID()});
  ok(await f.admin('POST', '/moderation', {threadId: t.id, postId: parent.id, action: 'hide', reason: 'Rules', expectedVersion: 1}, {role: 'moderator'}));
  const read = await f.request('GET', `/threads/${t.id}`); ok(read);
  const visibleReply = read.json.replies.find(x => x.id === flattened.id);
  assert.equal(visibleReply.replyToName, undefined);
  ok(await f.request('POST', '/posts/delete', {threadId: t.id, postId: holder.id, expectedVersion: 1}, alice));
  const placeholderRead = await f.request('GET', `/threads/${t.id}`); ok(placeholderRead);
  const placeholder = placeholderRead.json.replies.find(x => x.id === holder.id);
  assert.equal(placeholder?.deleted, true);
  assert.equal(placeholder.replyToName, undefined);
});

test('likes are one per fan, idempotent, reversible and never change post versions', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob'), c = await f.member('Cara'), t = await f.thread(a);
  const r = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Like me'}, a); ok(r);
  const vote = (who, postId, value) => f.request('POST', '/votes', {threadId: t.id, postId, value}, who);
  assert.equal((await vote(b, t.id, 1)).json.score, 1);
  assert.equal((await vote(b, t.id, 1)).json.score, 1);
  assert.equal((await vote(c, t.id, 1)).json.score, 2);
  assert.equal((await vote(c, t.id, 0)).json.score, 1);
  assert.equal((await vote(b, r.json.id, 1)).json.myVote, 1);
  assert.equal((await vote(b, t.id, 2)).statusCode, 400);
  const read = await f.request('GET', `/threads/${t.id}`, undefined, b);
  assert.equal(read.json.thread.score, 1); assert.equal(read.json.thread.myVote, 1); assert.equal(read.json.thread.version, 2);
  assert.equal(read.json.replies[0].score, 1); assert.equal(read.json.replies[0].myVote, 1); assert.equal(read.json.replies[0].version, 1);
  assert.equal((await f.request('GET', `/threads/${t.id}`, undefined, c)).json.thread.myVote, 0);
  // Author deletion with the unchanged version still works after likes.
  ok(await f.request('POST', '/posts/delete', {threadId: t.id, postId: r.json.id, expectedVersion: 1}, a));
});

test('discussions can be listed across all topics and sorted by new, top and hot with stable paging', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob');
  const made = [];
  for (let i = 0; i < 23; i++) { f.advance(3600000); made.push(await f.thread(a, {title: `T${i}`, category: ['general', 'club', 'ideas'][i % 3]})); }
  ok(await f.request('POST', '/votes', {threadId: made[3].id, postId: made[3].id, value: 1}, b));
  const newest = await f.request('GET', '/threads', undefined, {...b, query: {category: 'all', sort: 'new'}});
  assert.equal(newest.json.items[0].title, 'T22'); assert.equal(newest.json.items.length, 20); assert.equal(newest.json.total, 23);
  const rest = await f.request('GET', '/threads', undefined, {...b, query: {category: 'all', sort: 'new', cursor: newest.json.cursor}});
  assert.equal(rest.json.items.length, 3); assert.equal(rest.json.cursor, null);
  assert.equal(new Set([...newest.json.items, ...rest.json.items].map(x => x.id)).size, 23);
  assert.equal((await f.request('GET', '/threads', undefined, {...b, query: {category: 'all', sort: 'top', cursor: newest.json.cursor}})).statusCode, 400);
  const top = await f.request('GET', '/threads', undefined, {...b, query: {sort: 'top'}});
  assert.equal(top.json.items[0].title, 'T3'); assert.equal(top.json.items[0].score, 1); assert.equal(top.json.items[0].myVote, 1);
  const clubs = await f.request('GET', '/threads', undefined, {...b, query: {category: 'club', sort: 'hot'}});
  assert.ok(clubs.json.items.every(x => x.category === 'club'));
  assert.equal((await f.request('GET', '/threads', undefined, {...b, query: {sort: 'random'}})).statusCode, 400);
});

test('staff publish labelled team discussions idempotently; fans can read, like and reply but not delete them', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice');
  const body = {id: randomUUID(), category: 'general', title: 'Welcome to the Fan forum', text: 'Introduce yourself.', spoiler: false};
  assert.equal((await f.request('POST', '/admin/threads', body, a)).statusCode, 401);
  assert.equal((await f.admin('POST', '/threads', body, {role: 'support'})).statusCode, 403);
  const first = await f.admin('POST', '/threads', body, {role: 'moderator'}); ok(first);
  assert.equal(first.json.staff, true); assert.equal(first.json.authorName, 'Same End team'); assert.equal(first.json.created, true);
  const again = await f.admin('POST', '/threads', {...body, title: 'Changed'}, {role: 'moderator'}); ok(again);
  assert.equal(again.json.created, false); assert.equal(again.json.title, 'Welcome to the Fan forum');
  const match = await f.admin('POST', '/threads', {...body, id: randomUUID(), category: 'match', title: 'Result', spoiler: false}, {role: 'admin'}); ok(match); assert.equal(match.json.spoiler, true);
  const list = await f.request('GET', '/threads', undefined, {query: {sort: 'new'}}); ok(list); assert.equal(list.json.items.filter(x => x.staff).length, 2);
  ok(await f.request('POST', '/votes', {threadId: body.id, postId: body.id, value: 1}, a));
  ok(await f.request('POST', `/threads/${body.id}/replies`, {id: randomUUID(), text: 'Hello from Alice'}, a));
  const current = (await f.request('GET', `/threads/${body.id}`, undefined, a)).json.thread; assert.equal(current.staff, true);
  assert.equal((await f.request('POST', '/posts/delete', {threadId: body.id, postId: body.id, expectedVersion: current.version}, a)).statusCode, 403);
  const audit = await f.admin('GET', '/audit'); ok(audit); assert.ok(audit.json.items.some(x => x.action === 'thread.publish' && x.target === body.id));
  // A fan-created thread ID cannot be taken over by staff publishing.
  const fanThread = await f.thread(a); assert.equal((await f.admin('POST', '/threads', {...body, id: fanThread.id}, {role: 'moderator'})).statusCode, 409);
});
