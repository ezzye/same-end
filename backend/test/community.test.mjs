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

test('inline replies persist a same-thread parent, validate visibility and preserve legacy root replies', async () => {
  const f = fixture(); await f.enable(); const a = await f.member('Alice'), b = await f.member('Bob');
  const t = await f.thread(a), other = await f.thread(a);
  const rootReply = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Root-level reply'}, a); ok(rootReply);
  assert.equal(rootReply.json.parentId, t.id);
  const childBody = {id: randomUUID(), text: 'Inline response', parentId: rootReply.json.id};
  const child = await f.request('POST', `/threads/${t.id}/replies`, childBody, b); ok(child);
  assert.equal(child.json.parentId, rootReply.json.id);
  assert.equal((await f.store.get('COMMUNITY#PILOT', `REPLY#${t.id}#${child.json.id}`)).parentId, rootReply.json.id);
  // Recreating the API over the same persistent store preserves the parent link.
  const reloaded = createCommunityApi({store: f.store, now: f.now, allowedOrigins: ['https://sameend.test'], adminAuth: {issuer, clientId}});
  const read = await reloaded.handler({rawPath: `/v1/community/threads/${t.id}`, requestContext: {http: {method: 'GET'}}, headers: {origin: 'https://sameend.test', authorization: `Bearer ${b.token}`}});
  assert.equal(JSON.parse(read.body).replies.find(x => x.id === child.json.id).parentId, rootReply.json.id);
  assert.deepEqual((await f.request('POST', `/threads/${t.id}/replies`, {...childBody, text: 'Changed retry'}, b)).json, child.json);
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Cross-thread', parentId: other.id}, b)).statusCode, 404);
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Malformed', parentId: 'not-a-uuid'}, b)).statusCode, 400);
  const hidden = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Will hide'}, a); ok(hidden);
  ok(await f.admin('POST', '/moderation', {threadId: t.id, postId: hidden.json.id, action: 'hide', reason: 'Private reason', expectedVersion: 1}, {role: 'moderator'}));
  const rejectHidden = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Hidden target', parentId: hidden.json.id}, b);
  assert.equal(rejectHidden.statusCode, 404); assert.doesNotMatch(rejectHidden.body, /Private reason|Will hide/);
  const deleted = await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Will delete'}, a); ok(deleted);
  ok(await f.request('POST', '/posts/delete', {threadId: t.id, postId: deleted.json.id, expectedVersion: 1}, a));
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Deleted target', parentId: deleted.json.id}, b)).statusCode, 404);
  const blocked = await f.request('POST', '/threads/' + t.id + '/replies', {id: randomUUID(), text: 'Alice authored'}, a); ok(blocked);
  ok(await f.request('POST', '/blocks', {memberId: a.id, blocked: true}, b));
  assert.equal((await f.request('POST', `/threads/${t.id}/replies`, {id: randomUUID(), text: 'Blocked target', parentId: blocked.json.id}, b)).statusCode, 404);
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
  assert.equal((await f.request('GET', '/threads', undefined, b)).statusCode, 403);
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
