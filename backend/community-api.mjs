import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {Conflict} from './store.mjs';

// Deliberately finite pilot capacity. Lifetime counters fail closed even if TTL
// removes data before an operator reviews capacity; they never create unlimited partitions.
export const COMMUNITY_LIMITS = Object.freeze({requestBytes: 16384, identities: 1000, threads: 1000, replies: 500, votes: 50000, feedback: 1000, feedbackPerFan: 30, reports: 500, content: 30, audit: 1000, blocks: 100, page: 20, packBytes: 50000});
const PK = 'COMMUNITY#PILOT', DAY = 86400000, RETENTION = 365 * DAY;
const HASH = /^[a-f0-9]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Replies nest Reddit-style. Deeper replies attach to the deepest allowed parent and name who they answer.
const MAX_DEPTH = 4, SORTS = ['hot', 'new', 'top'], TEAM_ID = 'same-end-team', TEAM_NAME = 'Same End team';
const CATEGORIES = [{id: 'general', label: 'General'}, {id: 'club', label: 'Club'}, {id: 'match', label: 'Match'}, {id: 'ideas', label: 'Ideas'}];
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => HASH.test(a || '') && HASH.test(b || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
class CommunityError extends Error { constructor(status, code, message) { super(message); Object.assign(this, {status, code}); } }
const fail = (status, code, message) => { throw new CommunityError(status, code, message); };
function shape(body, required, optional = []) {
  if (!object(body) || Object.keys(body).some(k => !required.includes(k) && !optional.includes(k)) || required.some(k => !Object.hasOwn(body, k))) fail(400, 'invalid_fields', 'Check the fields in this update.');
}
function string(value, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'invalid_text', 'Use plain text within the stated limit.');
  return value.trim();
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'invalid_id', 'Refresh and try this action again.'); return value.toLowerCase(); }
function one(value, options) { if (!options.includes(value)) fail(400, 'invalid_choice', 'Choose one of the available options.'); return value; }
function boolean(value) { if (typeof value !== 'boolean') fail(400, 'invalid_boolean', 'Choose yes or no.'); return value; }
const cond = row => row ? {attribute: 'rev', equals: row.rev} : {absent: true};
const profile = row => ({id: row.id, name: row.name, forumMember: row.forumMember, status: row.status, blockedMemberIds: row.blockedMemberIds || [], version: row.version || 1});
const feedbackView = row => ({id: row.id, ownerId: row.ownerId, version: row.version || 1, kind: row.kind, title: row.title, text: row.text, status: row.status, response: row.response, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.contact && {contact: row.contact}), ...(row.diagnostics && {diagnostics: row.diagnostics})});
const postView = row => ({id: row.id, authorId: row.authorId, authorName: row.authorName, version: row.version || 1, text: row.deleted ? '' : row.text, createdAt: row.createdAt, ...(row.threadId && {threadId: row.threadId, parentId: row.parentId || null, depth: row.depth || 1, ...(row.replyToName && {replyToName: row.replyToName})}), ...(row.hidden && {hidden: true}), ...(row.deleted && {deleted: true}), ...(row.staff && {staff: true})});
// A removed reply is kept only as an empty placeholder when other replies hang from it.
const placeholder = (row, reason) => {
  const view = {...postView(row), text: '', authorId: null, authorName: '', [reason]: true};
  delete view.replyToName;
  return view;
};
const threadView = row => ({...postView(row), category: row.category, title: row.deleted ? '[Deleted]' : row.title, spoiler: row.spoiler, locked: row.locked, updatedAt: row.updatedAt, replyCount: row.replyCount});
const summary = row => { const {text, ...view} = threadView(row); return {...view, excerpt: text.slice(0, 180)}; };
const reportView = row => ({id: row.id, threadId: row.threadId, postId: row.postId, reporterId: row.reporterId, version: row.version || 1, reason: row.reason, status: row.status, note: row.note, createdAt: row.createdAt, updatedAt: row.updatedAt});
const contentView = row => Object.fromEntries(['id', 'type', 'title', 'body', 'question', 'choices', 'answerIndex', 'explanation', 'sponsor', 'url', 'startsAt', 'endsAt'].filter(k => row[k] !== undefined).map(k => [k, row[k]]));
function diagnostics(value) {
  shape(value, [], ['build', 'role', 'roomState', 'playbackMode', 'sourceEnded', 'online', 'reserveSeconds']);
  const safe = {};
  for (const k of ['build', 'role', 'roomState', 'playbackMode']) if (value[k] !== undefined) {
    const v = string(value[k], 80);
    // Diagnostic labels only, never arbitrary room URLs, keys, tokens or chat.
    if (!/^[a-zA-Z0-9 ._:/-]+$/.test(v) || /https?:|[a-f0-9]{32}|[A-Za-z0-9_-]{43}/i.test(v)) fail(400, 'invalid_diagnostics', 'Diagnostics can contain status labels only.');
    safe[k] = v;
  }
  for (const k of ['sourceEnded', 'online']) if (value[k] !== undefined) safe[k] = boolean(value[k]);
  if (value.reserveSeconds !== undefined) {
    if (!Number.isFinite(value.reserveSeconds) || value.reserveSeconds < 0 || value.reserveSeconds > 3600) fail(400, 'invalid_diagnostics', 'Check the buffer status.');
    safe.reserveSeconds = Math.round(value.reserveSeconds);
  }
  return safe;
}
function expected(body, current) {
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) fail(400, 'version_required', 'Refresh this item before changing it.');
  if (body.expectedVersion !== (current?.version || 0)) fail(409, 'stale_version', 'This item changed. Reload it before applying your update.');
}
function contentInput(body, time) {
  shape(body, ['id', 'type', 'title', 'body', 'published'], ['question', 'choices', 'answerIndex', 'explanation', 'sponsor', 'url', 'startsAt', 'endsAt', 'expectedVersion']);
  const item = {id: id(body.id), type: one(body.type, ['story', 'quiz', 'ad']), title: string(body.title, 120), body: string(body.body, 4000), published: boolean(body.published)};
  if (body.question !== undefined) item.question = string(body.question, 240);
  if (body.choices !== undefined) {
    if (!Array.isArray(body.choices) || body.choices.length < 2 || body.choices.length > 6) fail(400, 'invalid_quiz', 'Use two to six quiz answers.');
    item.choices = body.choices.map(x => string(x, 160));
  }
  if (body.answerIndex !== undefined) {
    if (!Number.isInteger(body.answerIndex) || !item.choices || body.answerIndex < 0 || body.answerIndex >= item.choices.length) fail(400, 'invalid_quiz', 'Select a valid quiz answer.');
    item.answerIndex = body.answerIndex;
  }
  if (body.explanation !== undefined) item.explanation = string(body.explanation, 1000);
  if (item.type === 'quiz' && (!item.question || !item.choices || item.answerIndex === undefined)) fail(400, 'invalid_quiz', 'Add a question, choices and correct answer.');
  if (item.type !== 'quiz' && ['question', 'choices', 'answerIndex', 'explanation'].some(k => body[k] !== undefined)) fail(400, 'invalid_quiz', 'Quiz fields belong to quiz items.');
  if (body.sponsor !== undefined) item.sponsor = string(body.sponsor, 100);
  if (item.type === 'ad' && !item.sponsor) fail(400, 'sponsor_required', 'Label the sponsor of this item.');
  if (body.url !== undefined) {
    const link = string(body.url, 500); let url;
    try { url = new URL(link); } catch { fail(400, 'invalid_link', 'Use an HTTPS link.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || /(?:^|[?&])(?:token|key|invite|room|club|secret)=/i.test(url.search)) fail(400, 'invalid_link', 'Use an HTTPS link without private invitation details.');
    item.url = url.href;
  }
  for (const k of ['startsAt', 'endsAt']) if (body[k] !== undefined) {
    if (!Number.isSafeInteger(body[k]) || body[k] < 0 || body[k] > time + RETENTION) fail(400, 'invalid_schedule', 'Schedule within the next year.');
    item[k] = body[k];
  }
  if (item.endsAt !== undefined && item.startsAt !== undefined && item.endsAt <= item.startsAt) fail(400, 'invalid_schedule', 'The end must follow the start.');
  if (Object.values(item).flat().some(v => typeof v === 'string' && /<\/?[a-z][^>]*>/i.test(v))) fail(400, 'plain_text_required', 'Waiting content must use plain text.');
  return item;
}

export function createCommunityApi({store, now = Date.now, allowedOrigins = ['https://www.sameend.com'], adminAuth = {}, localAdminTokenHash} = {}) {
  if (!store) throw new Error('A persistent store is required');
  // Explicit injection is confined to the isolated runner. Lambda and any configured
  // production issuer disable it, regardless of whether a caller accidentally passes it.
  const localEnabled = !!localAdminTokenHash && !process.env.AWS_LAMBDA_FUNCTION_NAME && !adminAuth.issuer && process.env.NODE_ENV !== 'production';
  const active = row => row && row.expiresAt > now() / 1000;
  const get = sk => store.get(PK, sk);
  const row = (sk, fields) => ({pk: PK, sk, ...fields, version: (fields.version || 0) + 1, rev: randomUUID(), expiresAt: fields.expiresAt ?? Math.floor((now() + RETENTION) / 1000)});
  const put = (value, before) => ({put: value, condition: cond(before)});
  const cap = (name, maximum) => ({key: {pk: PK, sk: `COUNT#${name}`}, add: {count: 1}, condition: {attribute: 'count', lt: maximum}});
  async function retry(action) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await action(); } catch (e) { if (!(e instanceof Conflict)) throw e; }
    }
    fail(409, 'conflict', 'This changed while you were working. Refresh and try again.');
  }
  async function rate(key, limit, period) {
    const sk = `RATE#${key}`;
    return retry(async () => {
      const before = await get(sk), window = Math.floor(now() / period), count = before?.window === window ? before.count : 0;
      if (count >= limit) fail(429, 'rate_limited', 'Give it a moment, then try again.');
      await store.put({pk: PK, sk, window, count: count + 1, rev: randomUUID(), expiresAt: Math.ceil((now() + 2 * period) / 1000)}, cond(before));
    });
  }
  async function limited(name, maximum) {
    const count = await get(`COUNT#${name}`);
    if ((count?.count || 0) >= maximum) fail(429, 'pilot_capacity', 'This pilot has reached its capacity. Ask the organiser to review it.');
  }
  async function collection(prefix, maximum) { return (await store.query(PK, {from: prefix, to: `${prefix}\uffff`, limit: maximum})).filter(active); }
  function page(rows, cursor, scope, project = x => x) {
    let after = '';
    if (cursor) {
      if (typeof cursor !== 'string' || cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400, 'invalid_cursor', 'Refresh this list.');
      try { const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (decoded.scope !== scope || typeof decoded.after !== 'string' || decoded.after.length > 180 || Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor) throw new Error(); after = decoded.after; } catch { fail(400, 'invalid_cursor', 'Refresh this list.'); }
    }
    const remaining = rows.filter(x => x.sk > after).sort((a, b) => a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0), selected = remaining.slice(0, COMMUNITY_LIMITS.page);
    return {items: selected.map(project), cursor: remaining.length > selected.length ? Buffer.from(JSON.stringify({scope, after: selected.at(-1).sk})).toString('base64url') : null};
  }
  async function settings() { const current = await get('SETTINGS'); return current || {forumEnabled: false, joinCodeHash: '', version: 0, rev: ''}; }
  const safeSettings = s => ({forumEnabled: !!s.forumEnabled && !!s.joinCodeHash, hasJoinCode: !!s.joinCodeHash, version: s.version || 0});
  async function fan(token, member = false) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').length !== 32 || Buffer.from(token, 'base64url').toString('base64url') !== token) fail(401, 'fan_auth_required', 'Use your saved fan identity.');
    const key = await get(`TOKEN#${digest(token)}`), current = key && await get(`FAN#${key.id}`);
    if (!active(key) || !active(current) || !equal(current.tokenHash, digest(token))) fail(401, 'fan_auth_required', 'Use your saved fan identity.');
    if (member && (!current.forumMember || current.status !== 'active' || !safeSettings(await settings()).forumEnabled)) fail(403, 'membership_required', 'Join the forum pilot to take part.');
    return current;
  }
  function staff(event, token, permission) {
    const raw = event.requestContext?.authorizer?.jwt?.claims;
    if (raw && adminAuth.issuer && (adminAuth.clientId || adminAuth.audience)) {
      const audience = adminAuth.clientId || adminAuth.audience, exp = Number(raw.exp);
      if (raw.iss !== adminAuth.issuer || raw.aud !== audience || raw.token_use !== 'id' || !Number.isFinite(exp) || exp <= now() / 1000 || (raw.nbf !== undefined && (!Number.isFinite(Number(raw.nbf)) || Number(raw.nbf) > now() / 1000)) || typeof raw.sub !== 'string' || raw.sub.length > 200 || !raw.sub) fail(401, 'staff_auth_required', 'Sign in with your staff account.');
      let groups = raw['cognito:groups'];
      if (typeof groups === 'string') {
        if(groups.length>2048)groups=[];
        else if (groups.startsWith('[')) {
          try { groups = JSON.parse(groups); }
          catch { groups=/^\[[A-Za-z0-9_\s,.-]*\]$/.test(groups)?groups.slice(1,-1).trim().split(/[,\s]+/):[]; }
        } else groups = groups.split(/[,\s]+/);
      }
      if (!Array.isArray(groups)||groups.length>100||groups.some(group=>typeof group!=='string'||group.length>128)) groups = [];
      if (!groups.includes('sameend-admin') && !groups.includes(`sameend-${permission}`)) fail(403, 'staff_role_required', 'Your staff role cannot make this change.');
      return {id: digest(`${raw.iss}/${raw.sub}`).slice(0, 32)};
    }
    if (localEnabled && typeof token === 'string' && token.length <= 256 && equal(digest(token), localAdminTokenHash)) return {id: 'isolated-local-admin'};
    fail(401, 'staff_auth_required', 'Sign in with your staff account.');
  }
  async function adminWrite(actor, action, target, reason, build) {
    return retry(async () => {
      const before = await get('AUDITSEQ'), sequence = (before?.sequence || 0) + 1;
      const change = await build();
      const audit = row(`AUDIT#${String(sequence % COMMUNITY_LIMITS.audit).padStart(4, '0')}`, {id: randomUUID(), actorId: actor.id, action, target, time: now(), ...(reason && {reason: reason.slice(0, 300)})});
      await store.transact([...change.ops, put({pk: PK, sk: 'AUDITSEQ', sequence, rev: randomUUID()}, before), {put: audit}]);
      return change.result;
    });
  }
  async function thread(idValue, admin = false, viewer) {
    const current = await get(`THREAD#${idValue}`);
    if (!active(current) || (!admin && (current.hidden || current.deleted || viewer.blockedMemberIds?.includes(current.authorId)))) fail(404, 'thread_not_found', 'This conversation is unavailable.');
    return current;
  }
  async function targetPost(threadId, postId, admin = false, viewer) {
    const parent = await thread(threadId, admin, viewer);
    const post = postId === threadId ? parent : await get(`REPLY#${threadId}#${postId}`);
    if (!active(post) || (!admin && (post.hidden || post.deleted || viewer.blockedMemberIds?.includes(post.authorId)))) fail(404, 'post_not_found', 'This post is unavailable.');
    return {parent, post};
  }
  async function scores(prefix, maximum) { return new Map((await collection(prefix, maximum)).map(x => [x.postId, x.score || 0])); }
  async function myVotes(viewer, prefix = '') {
    if (!viewer || viewer.guest) return new Map();
    return new Map((await collection(`VOTE#${viewer.id}#${prefix}`, COMMUNITY_LIMITS.votes)).filter(x => x.value === 1).map(x => [x.postId, 1]));
  }
  function hot(row, score) {
    const hours = Math.max(0, now() - row.createdAt) / 3600000;
    return (score + (row.replyCount || 0) * 0.5 + 1) / Math.pow(hours + 2, 1.5);
  }
  async function listThreads(query, admin, viewer) {
    const category = query.category === undefined || query.category === 'all' ? undefined : one(query.category, CATEGORIES.map(x => x.id));
    const rows = (await collection('THREAD#', COMMUNITY_LIMITS.threads)).filter(x => (!category || x.category === category) && (admin || !x.hidden && !x.deleted && !viewer.blockedMemberIds?.includes(x.authorId)));
    const scope = `${admin ? 'admin' : viewer.id}:threads:${category || '*'}`;
    if (query.sort === undefined) return page(rows, query.cursor, scope, summary);
    const sort = one(query.sort, SORTS), score = await scores('TSCORE#', COMMUNITY_LIMITS.threads), votes = await myVotes(viewer);
    const ranked = rows.map(x => ({row: x, score: score.get(x.id) || 0}));
    const order = {
      new: (a, b) => b.row.createdAt - a.row.createdAt,
      top: (a, b) => b.score - a.score || (b.row.replyCount || 0) - (a.row.replyCount || 0) || b.row.createdAt - a.row.createdAt,
      hot: (a, b) => hot(b.row, b.score) - hot(a.row, a.score) || b.row.createdAt - a.row.createdAt,
    }[sort];
    ranked.sort(order);
    let offset = 0;
    const sortedScope = `${scope}:${sort}`;
    if (query.cursor) {
      if (typeof query.cursor !== 'string' || query.cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) fail(400, 'invalid_cursor', 'Refresh this list.');
      try { const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); if (decoded.scope !== sortedScope || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error(); offset = decoded.offset; } catch { fail(400, 'invalid_cursor', 'Refresh this list.'); }
    }
    const selected = ranked.slice(offset, offset + COMMUNITY_LIMITS.page), next = offset + selected.length;
    return {
      items: selected.map(x => ({...summary(x.row), score: x.score, myVote: votes.get(x.row.id) || 0})),
      cursor: next < ranked.length ? Buffer.from(JSON.stringify({scope: sortedScope, offset: next})).toString('base64url') : null,
      total: ranked.length, latest: rows.reduce((n, x) => Math.max(n, x.updatedAt || x.createdAt || 0), 0),
    };
  }
  async function readThread(threadId, query, admin, viewer) {
    const current = await thread(threadId, admin, viewer), all = await collection(`REPLY#${threadId}#`, COMMUNITY_LIMITS.replies);
    if (admin) {
      const result = page(all, query.cursor, `admin:replies:${threadId}`, postView);
      return {thread: threadView(current), replies: result.items, cursor: result.cursor};
    }
    // Members and guests receive the whole bounded conversation in time order, as a tree.
    const removed = x => x.hidden ? 'hidden' : x.deleted ? 'deleted' : viewer.blockedMemberIds?.includes(x.authorId) ? 'blocked' : null;
    const children = new Map(); for (const x of all) { const key = x.parentId || threadId; if (!children.has(key)) children.set(key, []); children.get(key).push(x); }
    const keep = new Map(), visit = x => { if (keep.has(x.id)) return keep.get(x.id); keep.set(x.id, false); const value = !removed(x) || (children.get(x.id) || []).some(visit); keep.set(x.id, value); return value; };
    const score = await scores(`RSCORE#${threadId}#`, COMMUNITY_LIMITS.replies), votes = await myVotes(viewer, `${threadId}#`), threadScore = (await get(`TSCORE#${threadId}`))?.score || 0;
    const byId = new Map(all.map(x => [x.id, x]));
    const replies = all.filter(visit).sort((a, b) => a.createdAt - b.createdAt || (a.sk < b.sk ? -1 : 1))
      .map(x => {
        const reason = removed(x), view = reason ? placeholder(x, reason) : postView(x);
        if (view.replyToName) {
          const target = x.replyToId && byId.get(x.replyToId);
          if (!target || removed(target)) delete view.replyToName;
        }
        return {...view, score: score.get(x.id) || 0, myVote: votes.get(x.id) || 0};
      });
    return {thread: {...threadView(current), score: threadScore, myVote: votes.get(threadId) || 0}, replies, cursor: null};
  }
  async function route(method, path, query, body, token, event, ipSlot) {
    if (path === '/config' && method === 'GET') {
      const s = await settings(); return {forumEnabled: safeSettings(s).forumEnabled, categories: CATEGORIES, adminAuth: {issuer: adminAuth.issuer || '', clientId: adminAuth.clientId || '', domain: adminAuth.domain || '', redirectUri: adminAuth.redirectUri || '', enrollmentClientId: adminAuth.enrollmentClientId || ''}, retentionDays: 365};
    }
    if (path === '/content' && method === 'GET') {
      const revision = await get('CONTENTREV'), items = (await collection('CONTENT#', COMMUNITY_LIMITS.content)).filter(x => x.published && (x.startsAt === undefined || x.startsAt <= now()) && (x.endsAt === undefined || x.endsAt > now())).map(contentView);
      const pack = {revision: revision?.version || 0, items};
      if (Buffer.byteLength(JSON.stringify(pack)) > COMMUNITY_LIMITS.packBytes) fail(503, 'content_unavailable', 'Waiting content is temporarily unavailable.');
      return pack;
    }
    if (path === '/identities' && method === 'POST') {
      shape(body, ['id', 'tokenHash', 'name']);
      const fanId = id(body.id), name = string(body.name, 40);
      if (typeof body.tokenHash !== 'string' || !HASH.test(body.tokenHash)) fail(400, 'invalid_credential', 'Create a fresh fan identity.');
      await rate('registration-global', 200, DAY); await rate(`registration-ip-${ipSlot}`, 8, DAY);
      return retry(async () => {
        const existing = await get(`FAN#${fanId}`), key = await get(`TOKEN#${body.tokenHash}`);
        if (active(existing) && active(key) && equal(existing.tokenHash, body.tokenHash) && key.id === fanId) return profile(existing);
        if (existing || key) fail(409, 'identity_conflict', 'This identity already exists. Use the saved credential.');
        await limited('identities', COMMUNITY_LIMITS.identities);
        const current = row(`FAN#${fanId}`, {id: fanId, tokenHash: body.tokenHash, name, forumMember: false, status: 'active', blockedMemberIds: [], feedbackCount: 0, createdAt: now()});
        await store.transact([put(current), put(row(`TOKEN#${body.tokenHash}`, {id: fanId})), cap('identities', COMMUNITY_LIMITS.identities)]);
        return profile(current);
      });
    }
    if (path.startsWith('/admin/')) return adminRoute(method, path, query, body, token, event);
    // Anyone may read the forum while it is open. A saved fan identity adds votes and blocks.
    if (method === 'GET' && (path === '/threads' || /^\/threads\/[a-f0-9-]+$/i.test(path))) {
      if (!safeSettings(await settings()).forumEnabled) fail(403, 'forum_closed', 'The fan forum is not open yet.');
      const reader = token ? await fan(token) : {id: 'guest', guest: true, blockedMemberIds: []};
      return path === '/threads' ? listThreads(query, false, reader) : readThread(id(path.slice(9)), query, false, reader);
    }
    const viewer = await fan(token, !['/me', '/feedback', '/membership'].includes(path));
    if (method !== 'GET') {
      await rate('write-global', 1000, 60000); await rate(`write-ip-${ipSlot}`, 50, 60000);
      // Votes are small, frequent toggles; they have their own per-fan allowance.
      if (path === '/votes') await rate(`vote-${viewer.id}`, 120, 60000); else await rate(`fan-${viewer.id}`, 20, 60000);
    }
    if (path === '/me' && method === 'GET') return profile(viewer);
    if (path === '/membership' && method === 'POST') {
      shape(body, ['code', 'agree'], ['name']); if (body.agree !== true) fail(400, 'rules_required', 'Accept the forum rules to join.');
      const code = string(body.code, 128, 8), chosenName = body.name === undefined ? undefined : string(body.name, 40), s = await settings();
      if (!safeSettings(s).forumEnabled || !equal(digest(code), s.joinCodeHash)) fail(403, 'join_unavailable', 'Check the pilot code with the organiser.');
      return retry(async () => {
        const current = await fan(token);
        if (current.status !== 'active') fail(403, 'member_suspended', 'This identity cannot join the forum.');
        if (current.forumMember) return profile(current);
        const updated = row(current.sk, {...current, ...(chosenName !== undefined && {name: chosenName}), forumMember: true, joinedAt: now()});
        // Also condition the settings snapshot: a disabled or rotated pilot cannot
        // grant membership using an earlier code while the request was in flight.
        await store.transact([put(updated, current), {put: s, condition: cond(s)}]); return profile(updated);
      });
    }
    if (path === '/feedback' && method === 'GET') {
      const items = await collection(`FEEDBACK#${viewer.id}#`, COMMUNITY_LIMITS.feedbackPerFan); return {items: items.map(feedbackView)};
    }
    if (path === '/feedback' && method === 'POST') {
      shape(body, ['id', 'kind', 'title', 'text'], ['contact', 'diagnostics']);
      const recordId = id(body.id), value = {id: recordId, ownerId: viewer.id, kind: one(body.kind, ['problem', 'suggestion', 'worked']), title: string(body.title, 120), text: string(body.text, 6000)};
      if (body.contact !== undefined && body.contact !== '') value.contact = string(body.contact, 200);
      if (body.diagnostics !== undefined) value.diagnostics = diagnostics(body.diagnostics);
      return retry(async () => {
        const sk = `FEEDBACK#${viewer.id}#${recordId}`, existing = await get(sk);
        if (active(existing)) return feedbackView(existing);
        if (existing) fail(409, 'expired_id', 'Create a new feedback item.');
        const index = await get(`FEEDBACKID#${recordId}`);
        if (index) fail(409, 'feedback_conflict', 'Create a new feedback item.');
        const current = await fan(token);
        if ((current.feedbackCount || 0) >= COMMUNITY_LIMITS.feedbackPerFan) fail(429, 'feedback_limit', 'This pilot identity has reached its feedback limit.');
        await limited('feedback', COMMUNITY_LIMITS.feedback);
        const feedback = row(sk, {...value, status: 'received', response: '', createdAt: now(), updatedAt: now()}), updated = row(current.sk, {...current, feedbackCount: (current.feedbackCount || 0) + 1});
        await store.transact([put(feedback), put(row(`FEEDBACKID#${recordId}`, {feedbackSk: sk})), put(updated, current), cap('feedback', COMMUNITY_LIMITS.feedback)]); return feedbackView(feedback);
      });
    }
    if (path === '/threads' && method === 'POST') {
      shape(body, ['id', 'category', 'title', 'text', 'spoiler']); const threadId = id(body.id), category = one(body.category, CATEGORIES.map(x => x.id));
      const value = {id: threadId, category, title: string(body.title, 120), text: string(body.text, 4000), spoiler: category === 'match' || boolean(body.spoiler)};
      boolean(body.spoiler);
      return retry(async () => {
        const existing = await get(`THREAD#${threadId}`);
        if (active(existing) && existing.authorId === viewer.id) return threadView(existing);
        if (existing) fail(409, 'post_conflict', 'Create a new conversation.');
        await limited('threads', COMMUNITY_LIMITS.threads);
        const current = row(`THREAD#${threadId}`, {...value, authorId: viewer.id, authorName: viewer.name, locked: false, hidden: false, deleted: false, replyCount: 0, createdAt: now(), updatedAt: now()});
        await store.transact([put(current), {put: viewer, condition: cond(viewer)}, cap('threads', COMMUNITY_LIMITS.threads)]); return threadView(current);
      });
    }
    let match = path.match(/^\/threads\/([a-f0-9-]+)$/i);
    match = path.match(/^\/threads\/([a-f0-9-]+)\/replies$/i);
    if (match && method === 'POST') {
      shape(body, ['id', 'text'], ['parentId']); const threadId = id(match[1]), replyId = id(body.id), text = string(body.text, 4000), parentInput = body.parentId === undefined || body.parentId === null ? threadId : id(body.parentId);
      return retry(async () => {
        const existing = await get(`REPLY#${threadId}#${replyId}`);
        if (active(existing) && existing.authorId === viewer.id) return postView(existing);
        if (existing) fail(409, 'post_conflict', 'Create a new reply.');
        const current = await thread(threadId, false, viewer);
        if (current.locked) fail(403, 'thread_locked', 'This conversation is locked.');
        if (current.replyCount >= COMMUNITY_LIMITS.replies) fail(429, 'reply_limit', 'This conversation has reached the pilot reply limit.');
        let parentId = null, depth = 1, replyToName, replyToId, parent;
        if (parentInput !== threadId) {
          parent = await get(`REPLY#${threadId}#${parentInput}`);
          if (!active(parent) || parent.hidden || parent.deleted || viewer.blockedMemberIds?.includes(parent.authorId)) fail(404, 'post_not_found', 'That comment is no longer available.');
          const parentDepth = parent.depth || 1;
          if (parentDepth >= MAX_DEPTH) { parentId = parent.parentId || null; depth = MAX_DEPTH; replyToName = parent.authorName; replyToId = parent.id; }
          else { parentId = parent.id; depth = parentDepth + 1; }
        }
        const reply = row(`REPLY#${threadId}#${replyId}`, {id: replyId, threadId, parentId, depth, ...(replyToName && {replyToName}), ...(replyToId && {replyToId}), text, authorId: viewer.id, authorName: viewer.name, hidden: false, deleted: false, createdAt: now()}), updated = row(current.sk, {...current, replyCount: current.replyCount + 1, updatedAt: now()});
        await store.transact([put(reply), put(updated, current), ...(parent ? [put(parent, parent)] : []), {put: viewer, condition: cond(viewer)}]); return postView(reply);
      });
    }
    if (path === '/votes' && method === 'POST') {
      shape(body, ['threadId', 'postId', 'value']); const threadId = id(body.threadId), postId = id(body.postId);
      if (body.value !== 0 && body.value !== 1) fail(400, 'invalid_vote', 'Choose like or remove your like.');
      return retry(async () => {
        await targetPost(threadId, postId, false, viewer);
        const voteSk = `VOTE#${viewer.id}#${threadId}#${postId}`, scoreSk = postId === threadId ? `TSCORE#${threadId}` : `RSCORE#${threadId}#${postId}`;
        const vote = await get(voteSk), tally = await get(scoreSk), before = active(vote) ? vote.value : 0, score = tally?.score || 0;
        if (before === body.value) return {threadId, postId, score, myVote: before};
        if (!vote) await limited('votes', COMMUNITY_LIMITS.votes);
        const nextScore = Math.max(0, score + body.value - before);
        // Scores live beside posts, so liking never changes a post version used by author or moderator edits.
        await store.transact([put(row(scoreSk, {postId, threadId, score: nextScore}), tally), put(row(voteSk, {postId, threadId, value: body.value}), vote), ...(vote ? [] : [cap('votes', COMMUNITY_LIMITS.votes)])]);
        return {threadId, postId, score: nextScore, myVote: body.value};
      });
    }
    if (path === '/reports' && method === 'POST') {
      shape(body, ['id', 'threadId', 'postId', 'reason']); const reportId = id(body.id), threadId = id(body.threadId), postId = id(body.postId), reason = string(body.reason, 300);
      return retry(async () => {
        const existing = await get(`REPORT#${reportId}`);
        if (active(existing) && existing.reporterId === viewer.id) return {id: reportId, status: existing.status};
        if (existing) fail(409, 'report_conflict', 'Create a new report.');
        await targetPost(threadId, postId, false, viewer); await limited('reports', COMMUNITY_LIMITS.reports);
        const report = row(`REPORT#${reportId}`, {id: reportId, threadId, postId, reporterId: viewer.id, reason, status: 'open', note: '', createdAt: now(), updatedAt: now()});
        await store.transact([put(report), {put: viewer, condition: cond(viewer)}, cap('reports', COMMUNITY_LIMITS.reports)]); return {id: reportId, status: 'open'};
      });
    }
    if (path === '/posts/delete' && method === 'POST') {
      shape(body, ['threadId', 'postId', 'expectedVersion']); const threadId = id(body.threadId), postId = id(body.postId);
      return retry(async () => {
        const {parent, post} = await targetPost(threadId, postId, true);
        expected(body, post);
        if (post.authorId !== viewer.id) fail(403, 'post_owner_required', 'Only the author can delete this post.');
        if (post.deleted) return {ok: true};
        const updated = row(post.sk, {...post, text: '', ...(postId === threadId && {title: '[Deleted]'}), deleted: true, updatedAt: now()});
        await store.transact([put(updated, post), ...(postId !== threadId ? [{put: parent, condition: cond(parent)}] : [])]); return {ok: true};
      });
    }
    if (path === '/blocks' && method === 'POST') {
      shape(body, ['memberId', 'blocked']); const memberId = id(body.memberId), blocked = boolean(body.blocked);
      if (memberId === viewer.id || !active(await get(`FAN#${memberId}`))) fail(400, 'invalid_member', 'Choose another forum member.');
      return retry(async () => {
        const current = await fan(token, true), members = new Set(current.blockedMemberIds);
        blocked ? members.add(memberId) : members.delete(memberId);
        if (members.size > COMMUNITY_LIMITS.blocks) fail(429, 'block_limit', 'This pilot has reached its block list limit.');
        const updated = row(current.sk, {...current, blockedMemberIds: [...members]}); await store.put(updated, cond(current)); return profile(updated);
      });
    }
    fail(404, 'route_not_found', 'This community action is unavailable.');
  }
  async function adminRoute(method, path, query, body, token, event) {
    let permission;
    if (path.startsWith('/admin/feedback')) permission = 'support';
    else if (path.startsWith('/admin/threads') || path.startsWith('/admin/moderation') || path.startsWith('/admin/reports') || path.startsWith('/admin/members')) permission = 'moderator';
    else if (path.startsWith('/admin/content')) permission = 'editor';
    else permission = 'admin';
    const actor = staff(event, token, permission);
    if (method !== 'GET') { await rate('staff-global', 200, 60000); await rate(`staff-${digest(actor.id).slice(0, 2)}`, 60, 60000); }
    if (path === '/admin/feedback' && method === 'GET') return page(await collection('FEEDBACK#', COMMUNITY_LIMITS.feedback), query.cursor, 'admin:feedback', feedbackView);
    let match = path.match(/^\/admin\/feedback\/([a-f0-9-]+)$/i);
    if (match && method === 'POST') {
      shape(body, ['status', 'response', 'expectedVersion']); const recordId = id(match[1]), status = one(body.status, ['received', 'investigating', 'answered', 'fixed']), response = string(body.response, 4000, 0);
      return adminWrite(actor, 'feedback.update', recordId, '', async () => {
        const index = await get(`FEEDBACKID#${recordId}`), current = index && await get(index.feedbackSk);
        if (!active(index) || !active(current)) fail(404, 'feedback_not_found', 'This feedback is unavailable.');
        expected(body, current);
        const updated = row(current.sk, {...current, status, response, updatedAt: now()}); return {ops: [put(updated, current)], result: feedbackView(updated)};
      });
    }
    if (path === '/admin/threads' && method === 'GET') return listThreads(query, true);
    // Staff publish clearly labelled team discussions (for example a starter pack). Fixed IDs make republishing idempotent.
    if (path === '/admin/threads' && method === 'POST') {
      shape(body, ['id', 'category', 'title', 'text', 'spoiler']); const threadId = id(body.id), category = one(body.category, CATEGORIES.map(x => x.id));
      const value = {id: threadId, category, title: string(body.title, 120), text: string(body.text, 4000), spoiler: category === 'match' || boolean(body.spoiler)};
      const existing = await get(`THREAD#${threadId}`);
      if (active(existing) && existing.staff) return {...threadView(existing), created: false};
      if (existing) fail(409, 'post_conflict', 'This discussion ID is already used.');
      return adminWrite(actor, 'thread.publish', threadId, '', async () => {
        await limited('threads', COMMUNITY_LIMITS.threads);
        const current = row(`THREAD#${threadId}`, {...value, authorId: TEAM_ID, authorName: TEAM_NAME, staff: true, locked: false, hidden: false, deleted: false, replyCount: 0, createdAt: now(), updatedAt: now()});
        return {ops: [put(current), cap('threads', COMMUNITY_LIMITS.threads)], result: {...threadView(current), created: true}};
      });
    }
    match = path.match(/^\/admin\/threads\/([a-f0-9-]+)$/i);
    if (match && method === 'GET') return readThread(id(match[1]), query, true);
    if (path === '/admin/moderation' && method === 'POST') {
      shape(body, ['threadId', 'postId', 'action', 'reason', 'expectedVersion']); const threadId = id(body.threadId), postId = id(body.postId), action = one(body.action, ['hide', 'restore', 'lock', 'unlock']), reason = string(body.reason, 300);
      if (['lock', 'unlock'].includes(action) && postId !== threadId) fail(400, 'invalid_moderation', 'Lock the conversation itself.');
      return adminWrite(actor, `post.${action}`, `${threadId}/${postId}`, reason, async () => {
        const {parent, post} = await targetPost(threadId, postId, true);
        expected(body, post);
        if (action === 'restore' && post.deleted) fail(409, 'post_deleted', 'Author-deleted text cannot be restored.');
        const updated = row(post.sk, {...post, ...(['lock', 'unlock'].includes(action) ? {locked: action === 'lock'} : {hidden: action === 'hide'}), updatedAt: now()});
        return {ops: [put(updated, post), ...(postId !== threadId ? [{put: parent, condition: cond(parent)}] : [])], result: {ok: true}};
      });
    }
    if (path === '/admin/reports' && method === 'GET') return page(await collection('REPORT#', COMMUNITY_LIMITS.reports), query.cursor, 'admin:reports', reportView);
    match = path.match(/^\/admin\/reports\/([a-f0-9-]+)$/i);
    if (match && method === 'POST') {
      shape(body, ['status', 'note', 'expectedVersion']); const reportId = id(match[1]), status = one(body.status, ['open', 'resolved']), note = string(body.note, 1000, 0);
      return adminWrite(actor, 'report.update', reportId, '', async () => {
        const current = await get(`REPORT#${reportId}`); if (!active(current)) fail(404, 'report_not_found', 'This report is unavailable.');
        expected(body, current);
        const updated = row(current.sk, {...current, status, note, updatedAt: now()}); return {ops: [put(updated, current)], result: reportView(updated)};
      });
    }
    match = path.match(/^\/admin\/members\/([a-f0-9-]+)$/i);
    if (match && method === 'GET') {
      const current = await get(`FAN#${id(match[1])}`); if (!active(current)) fail(404, 'member_not_found', 'This member is unavailable.');
      return {id: current.id, name: current.name, status: current.status, version: current.version};
    }
    if (match && method === 'POST') {
      shape(body, ['status', 'expectedVersion']); const memberId = id(match[1]), status = one(body.status, ['active', 'suspended']);
      return adminWrite(actor, 'member.status', memberId, '', async () => {
        const current = await get(`FAN#${memberId}`); if (!active(current)) fail(404, 'member_not_found', 'This member is unavailable.');
        expected(body, current);
        const updated = row(current.sk, {...current, status}); return {ops: [put(updated, current)], result: {id: updated.id, name: updated.name, status: updated.status, version: updated.version}};
      });
    }
    if (path === '/admin/settings' && method === 'GET') return safeSettings(await settings());
    if (path === '/admin/settings' && method === 'POST') {
      shape(body, ['forumEnabled', 'expectedVersion'], ['joinCode']); const enabled = boolean(body.forumEnabled), code = body.joinCode !== undefined ? string(body.joinCode, 128, 8) : undefined;
      return adminWrite(actor, 'settings.update', 'pilot', '', async () => {
        const before = await get('SETTINGS'); expected(body, before); const joinCodeHash = code === undefined ? before?.joinCodeHash || '' : digest(code);
        if (enabled && !joinCodeHash) fail(400, 'join_code_required', 'Set a pilot code before enabling the forum.');
        const updated = {pk: PK, sk: 'SETTINGS', forumEnabled: enabled, joinCodeHash, version: (before?.version || 0) + 1, rev: randomUUID()};
        return {ops: [put(updated, before)], result: safeSettings(updated)};
      });
    }
    if (path === '/admin/content' && method === 'GET') {
      const revision = await get('CONTENTREV'); return {items: (await collection('CONTENT#', COMMUNITY_LIMITS.content)).map(x => ({...contentView(x), version: x.version, published: x.published, ...(x.startsAt !== undefined && {startsAt: x.startsAt}), ...(x.endsAt !== undefined && {endsAt: x.endsAt})})), revision: revision?.version || 0};
    }
    if (path === '/admin/content' && method === 'POST') {
      const value = contentInput(body, now());
      return adminWrite(actor, 'content.save', value.id, '', async () => {
        const current = await get(`CONTENT#${value.id}`), revision = await get('CONTENTREV'), all = await collection('CONTENT#', COMMUNITY_LIMITS.content), updated = row(`CONTENT#${value.id}`, {...value, version: current?.version || 0});
        expected(body, current);
        if (!current) await limited('content', COMMUNITY_LIMITS.content);
        const nextItems = [...all.filter(x => x.id !== value.id), updated];
        // Count all published schedules together. No future overlap can expand the pack.
        if (Buffer.byteLength(JSON.stringify({revision: (revision?.version || 0) + 1, items: nextItems.filter(x => x.published).map(contentView)})) > COMMUNITY_LIMITS.packBytes) fail(400, 'content_pack_too_large', 'Keep the complete published waiting pack below 50 KB.');
        return {ops: [put(updated, current), put({pk: PK, sk: 'CONTENTREV', version: (revision?.version || 0) + 1, rev: randomUUID()}, revision), ...(!current ? [cap('content', COMMUNITY_LIMITS.content)] : [])], result: {...contentView(updated), version: updated.version, published: updated.published, ...(updated.startsAt !== undefined && {startsAt: updated.startsAt}), ...(updated.endsAt !== undefined && {endsAt: updated.endsAt})}};
      });
    }
    match = path.match(/^\/admin\/content\/([a-f0-9-]+)$/i);
    if (match && method === 'DELETE') {
      shape(body, ['expectedVersion']); const contentId = id(match[1]);
      return adminWrite(actor, 'content.delete', contentId, '', async () => {
        const current = await get(`CONTENT#${contentId}`), revision = await get('CONTENTREV');
        expected(body, current);
        return {ops: [...(current ? [{key: {pk: PK, sk: current.sk}, delete: true, condition: cond(current)}, {key: {pk: PK, sk: 'COUNT#content'}, add: {count: -1}}] : []), put({pk: PK, sk: 'CONTENTREV', version: (revision?.version || 0) + 1, rev: randomUUID()}, revision)], result: {ok: true}};
      });
    }
    if (path === '/admin/audit' && method === 'GET') return page(await collection('AUDIT#', COMMUNITY_LIMITS.audit), query.cursor, 'admin:audit', x => ({id: x.id, actorId: x.actorId, action: x.action, target: x.target, time: x.time, ...(x.reason && {reason: x.reason})}));
    fail(404, 'route_not_found', 'This staff action is unavailable.');
  }
  async function handler(event) {
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), origin = headers.origin;
    const outHeaders = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Origin'};
    if (origin && allowedOrigins.includes(origin)) Object.assign(outHeaders, {'access-control-allow-origin': origin, 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '600'});
    const reply = (statusCode, data) => ({statusCode, headers: outHeaders, body: JSON.stringify(data)});
    try {
      if (origin && !allowedOrigins.includes(origin)) fail(403, 'origin_not_allowed', 'Open Same End from its usual address.');
      const method = event.requestContext?.http?.method || event.httpMethod;
      if (method === 'OPTIONS') return reply(204, null);
      // Bound before allocating/decoding a potentially very large request body.
      if (typeof event.body !== 'undefined' && typeof event.body !== 'string') fail(400, 'invalid_json', 'Send a JSON object.');
      if ((event.body || '').length > COMMUNITY_LIMITS.requestBytes * (event.isBase64Encoded ? 1.4 : 1)) fail(413, 'payload_too_large', 'This update is too large.');
      const raw = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
      if (raw.length > COMMUNITY_LIMITS.requestBytes) fail(413, 'payload_too_large', 'This update is too large.');
      let body = {};
      if (raw.length) {
        if (!/^application\/json(?:;|$)/i.test(headers['content-type'] || '')) fail(415, 'json_required', 'Send this update as JSON.');
        try { body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'invalid_json', 'This update could not be read.'); }
        if (!object(body)) fail(400, 'invalid_json', 'Send a JSON object.');
      }
      const fullPath = event.rawPath || event.path || '';
      if (!fullPath.startsWith('/v1/community/')) fail(404, 'route_not_found', 'This community action is unavailable.');
      const token = headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
      // 64 fixed network shards bound unauthenticated limiter rows and retain no IP.
      const ipSlot = parseInt(digest(`${Math.floor(now() / DAY)}/${event.requestContext?.http?.sourceIp || 'isolated'}`).slice(0, 8), 16) % 64;
      await rate('request-global', 3000, 60000); await rate(`request-ip-${ipSlot}`, 300, 60000);
      return reply(200, await route(method, fullPath.slice('/v1/community'.length), event.queryStringParameters || {}, body, token, event, ipSlot));
    } catch (e) {
      if (e instanceof CommunityError) return reply(e.status, {code: e.code, error: e.message});
      if (e instanceof Conflict) return reply(409, {code: 'conflict', error: 'This changed while you were working. Refresh and try again.'});
      return reply(503, {code: 'service_unavailable', error: 'The community service is temporarily unavailable. Try again shortly.'});
    }
  }
  return {handler};
}
