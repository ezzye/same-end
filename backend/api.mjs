import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Conflict } from './store.mjs';
import { payloadFor, validateSubscription } from './push.mjs';
import {createAnalytics} from './analytics.mjs';
import {createCoordinator} from './coordinator.mjs';
import {createEdgeTurnCredentials, createEdgeHealthHandler, getEdgeHealth} from './edge-turn.mjs';

export const LIMITS = Object.freeze({requestBytes: 65536, stateBytes: 32768, messageBytes: 12288, reportBytes: 12288, reports: 30, events: 30, subscriptions: 50, chatSeconds: 86400, clubSeconds: 400 * 86400});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const DAY = 86400000;
const hash = value => createHash('sha256').update(value).digest('hex');
const pkFor = id => `CLUB#${id}`;
const expiry = (now, seconds) => Math.floor(now / 1000) + seconds;
const pad = n => String(n).padStart(16, '0');
export class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
function envelope(value, maxBytes) {
  if (!object(value) || value.v !== 1 || !b64(value.iv, 12, 12) || !b64(value.data, 16, maxBytes)) fail(400, 'invalid_envelope', 'That encrypted content is not valid or is too large.');
  return {v: 1, iv: value.iv, data: value.data};
}
function b64(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) + 2 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const buffer = Buffer.from(value, 'base64url');
  return buffer.length >= min && buffer.length <= max && buffer.toString('base64url') === value;
}
function eventsList(value, now) {
  if (!Array.isArray(value) || value.length > LIMITS.events) fail(400, 'invalid_events', 'Use up to 30 match dates.');
  const seen = new Set();
  return value.map(e => {
    if (!object(e) || !uuid(e.id) || seen.has(e.id) || !Number.isSafeInteger(e.startsAt) || !Number.isSafeInteger(e.notifyAt) || Math.abs(e.startsAt - now) > 365 * DAY || e.notifyAt > e.startsAt || e.notifyAt < e.startsAt - DAY) fail(400, 'invalid_events', 'Check those match dates and reminder times.');
    seen.add(e.id); return {id: e.id, startsAt: e.startsAt, notifyAt: e.notifyAt};
  });
}
export function jobFor(clubId, event, now) {
  const generation = hash(`${event.id}/${event.startsAt}/${event.notifyAt}`).slice(0, 24);
  return {pk: pkFor(clubId), sk: `JOB#${event.id}#${generation}`, clubId, eventId: event.id, generation, startsAt: event.startsAt, notifyAt: event.notifyAt, dueAt: event.notifyAt, gpk: 'DUE', gsk: `${pad(event.notifyAt)}#${clubId}#${event.id}`, rev: 1, attempts: 0, expiresAt: expiry(Math.max(now, event.notifyAt), 86400)};
}
function jobsFor(id, events, now) { return events.filter(e => e.notifyAt >= now - 15 * 60000 && e.startsAt >= now - 15 * 60000).map(e => jobFor(id, e, now)); }
const publicClub = c => ({id: c.id, version: c.version, state: c.state, events: c.events, updatedAt: c.updatedAt});
const publicMessage = m => ({id: m.id, payload: m.payload, receivedAt: m.receivedAt, cursor: m.cursor});
const messageReceipt = m => ({id: m.id, receivedAt: m.receivedAt, cursor: m.cursor});
function cursorFor(id, count) { return Buffer.from(`m1:${id}:${pad(count)}`).toString('base64url'); }
function cursorCount(cursor, id) {
  if (!cursor) return 0;
  if (typeof cursor !== 'string' || cursor.length > 100 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400, 'invalid_cursor', 'Refresh the club chat.');
  const decoded = Buffer.from(cursor, 'base64url').toString();
  const match = decoded.match(/^m1:([0-9a-f-]{36}):([0-9]{16})$/i);
  if (!match || match[1] !== id || !Number.isSafeInteger(Number(match[2])) || Buffer.from(decoded).toString('base64url') !== cursor) fail(400, 'invalid_cursor', 'Refresh the club chat.');
  return Number(match[2]);
}
const equalHash = (a, b) => HASH.test(a || '') && HASH.test(b || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export function createApi({store, push, now = Date.now, allowedOrigins = ['https://www.sameend.com'], edgeTurn = {}} = {}) {
  const analytics = createAnalytics({store, now});
  const coordinate = createCoordinator({store, now});
  const edgeHealth = edgeTurn.healthSecret ? createEdgeHealthHandler({secret: edgeTurn.healthSecret, policy: edgeTurn.policy, store, now}) : null;
  async function rate(key, limit, milliseconds) {
    const time = now(), bucket = Math.floor(time / milliseconds);
    try { await store.consume(`${key}:${bucket}`, limit, expiry((bucket + 1) * milliseconds, 3600)); }
    catch (e) { if (e instanceof Conflict) fail(429, 'rate_limited', key.startsWith('create-ip:')?'This network has reached today’s new-room limit. Open a saved club, or create a new room tomorrow.':key==='create-global'?'New rooms are at today’s service limit. Saved clubs still work; try creating a room tomorrow.':'Give it a moment, then try again.'); throw e; }
  }
  async function authorised(id, token, write = false) {
    if (!uuid(id)) fail(401, 'unauthorised', 'Open your private club invitation again.');
    const club = await store.get(pkFor(id), 'META');
    const digest = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token) : '';
    if (!club || club.expiresAt <= now() / 1000 || !(equalHash(digest, club.writeTokenHash) || !write && equalHash(digest, club.readTokenHash))) fail(401, 'unauthorised', write ? 'The organiser link is needed to change this club.' : 'Open your private club invitation again.');
    return club;
  }
  async function reportAuthorised(id, token, role) {
    if (!uuid(id)) fail(401, 'unauthorised', 'Open your private club invitation again.');
    const club = await store.get(pkFor(id), 'META');
    const digest = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token) : '';
    const allowed = role === 'owner' ? equalHash(digest, club?.writeTokenHash) : equalHash(digest, club?.readTokenHash);
    if (!club || club.expiresAt <= now() / 1000 || !allowed) fail(401, 'unauthorised', role === 'owner' ? 'The organiser link is needed to read reports.' : 'Open your private club invitation again.');
    return club;
  }
  async function clearExpiredReports(pk, time) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await store.query(pk, {from: 'REPORT#', to: 'REPORT#\uffff', limit: LIMITS.reports});
      const expired = rows.filter(row => row.expiresAt <= time / 1000);
      if (!expired.length) return rows.filter(row => row.expiresAt > time / 1000);
      const counter = await store.get(pk, 'REPORTCOUNT');
      const markerReads = await Promise.all(expired.map(row => store.get(pk, `REPORTID#${row.id}`)));
      const markerDeletes = expired.flatMap((row, index) => markerReads[index]?.reportSk === row.sk ? [{key: {pk, sk: `REPORTID#${row.id}`}, delete: true, condition: {attribute: 'reportSk', equals: row.sk}}] : []);
      try {
        const counterCondition = counter ? counter.rev ? {attribute: 'rev', equals: counter.rev} : {attribute: 'count', equals: counter.count} : null;
        await store.transact([...expired.map(row => ({key: {pk, sk: row.sk}, delete: true, condition: {attribute: 'expiresAt', equals: row.expiresAt}})), ...markerDeletes, ...(counter ? [{key: {pk, sk: 'REPORTCOUNT'}, add: {count: -expired.length}, set: {rev: randomUUID()}, condition: counterCondition}] : [])]);
      } catch (e) { if (!(e instanceof Conflict)) throw e; }
    }
    return (await store.query(pk, {from: 'REPORT#', to: 'REPORT#\uffff', limit: LIMITS.reports})).filter(row => row.expiresAt > time / 1000);
  }
  async function reconcileReportCount(pk) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await store.get(pk, 'REPORTCOUNT');
      const currentRows = (await store.query(pk, {from: 'REPORT#', to: 'REPORT#\uffff', limit: LIMITS.reports})).filter(row => row.expiresAt > now() / 1000);
      const counter = await store.get(pk, 'REPORTCOUNT');
      if ((before?.rev || null) !== (counter?.rev || null) || (before?.count || 0) !== (counter?.count || 0)) continue;
      if ((counter?.count || 0) === currentRows.length) return;
      try {
        if (!currentRows.length && counter) await store.transact([{key: {pk, sk: 'REPORTCOUNT'}, delete: true, condition: counter.rev ? {attribute: 'rev', equals: counter.rev} : {attribute: 'count', equals: counter.count}}]);
        else if (currentRows.length) await store.transact([{put: {pk, sk: 'REPORTCOUNT', count: currentRows.length, rev: randomUUID(), expiresAt: Math.max(...currentRows.map(row => row.expiresAt))}, condition: counter ? counter.rev ? {attribute: 'rev', equals: counter.rev} : {attribute: 'count', equals: counter.count} : {absent: true}}]);
        return;
      } catch (e) { if (!(e instanceof Conflict)) throw e; }
    }
    fail(503, 'report_busy', 'The club report inbox is busy. Try again shortly.');
  }
  async function deleteSubscription(clubId, id) {
    const key = {pk: pkFor(clubId), sk: `SUB#${id}`};
    try { await store.transact([{key, delete: true, condition: {exists: true}}, {key: {pk: pkFor(clubId), sk: 'SUBCOUNT'}, add: {count: -1, rev: 1}}]); } catch (e) { if (!(e instanceof Conflict)) throw e; }
  }
  async function sendTest(clubId, subscriptionId) {
    if (!push.enabled) fail(503, 'push_disabled', 'Reminders are not available yet.');
    const s = await store.get(pkFor(clubId), `SUB#${subscriptionId}`);
    if (!s || s.expiresAt <= now() / 1000) fail(404, 'subscription_missing', 'Enable reminders on this device again.');
    try { await push.send(s.subscription, payloadFor(clubId)); }
    catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) { await deleteSubscription(clubId, subscriptionId); fail(410, 'subscription_expired', 'Enable reminders on this device again.'); }
      fail(503, 'push_failed', 'The reminder service could not accept that test. Try again later.');
    }
    return {accepted: true};
  }
  async function route(method, path, query, body, token, ip) {
    if (method === 'GET' && path === '/v1/config') return {vapidPublicKey: push.enabled ? push.publicKey : '', serverTime: now(), pushEnabled: !!push.enabled};
    if (method === 'POST' && path === '/v1/clubs') {
      const time = now();
      if (!uuid(body.id) || !HASH.test(body.readTokenHash) || !HASH.test(body.writeTokenHash) || body.readTokenHash === body.writeTokenHash) fail(400, 'invalid_club', 'That private club could not be created.');
      const state = envelope(body.state, LIMITS.stateBytes), events = eventsList(body.events, time);
      await rate(`create-ip:${ip}`, 10, DAY); await rate('create-global', 50, DAY);
      const club = {pk: pkFor(body.id), sk: 'META', id: body.id, version: 1, readTokenHash: body.readTokenHash, writeTokenHash: body.writeTokenHash, state, events, updatedAt: time, expiresAt: expiry(time, LIMITS.clubSeconds)};
      try { await store.transact([{put: club, condition: {absent: true}}, ...jobsFor(body.id, events, time).map(put => ({put}))]); }
      catch (e) { if (e instanceof Conflict) fail(409, 'club_exists', 'That club already exists. Open its saved invitation.'); throw e; }
      return {id: club.id, version: 1, updatedAt: time};
    }
    const coordinatorMatch = path.match(/^\/v1\/clubs\/([0-9a-f-]+)\/(coordinator|ice)$/i);
    if (coordinatorMatch) {
      const [, id, action] = coordinatorMatch;
      await authorised(id, token);
      if (action === 'ice' && method === 'GET') {
        await rate(`ice:${id}:${ip}`, 600, 60000);
        if (!edgeHealth || !(await getEdgeHealth({store, policy: edgeTurn.policy, now})).allowNew) return {iceServers: [], expiresAt: null};
        return createEdgeTurnCredentials({...edgeTurn, nowMs: now(), ttlSeconds: 60});
      }
      if (action === 'coordinator' && method === 'POST') {
        await rate(`coordinator:${id}:${ip}`, 1200, 60000);
        try { return await coordinate(id, body); }
        catch (e) { if (e.status) fail(e.status, e.code, e.message); throw e; }
      }
      fail(405, 'method_not_allowed', 'That club action is not available.');
    }
    const reportMatch = path.match(/^\/v1\/clubs\/([0-9a-f-]+)\/reports$/i);
    if (reportMatch && (method === 'POST' || method === 'GET')) {
      const [, id] = reportMatch, time = now(), pk = pkFor(id);
      await reportAuthorised(id, token, method === 'GET' ? 'owner' : 'member');
      await rate(`read:${id}:${ip}`, 600, 60000);
      if (method === 'POST') {
        if (Object.keys(body).some(key => !['id', 'envelope'].includes(key)) || Object.keys(body).length !== 2 || !uuid(body.id) || !object(body.envelope) || Object.keys(body.envelope).some(key => !['v', 'iv', 'data'].includes(key)) || Object.keys(body.envelope).length !== 3) fail(400, 'invalid_report', 'That encrypted report could not be accepted.');
        const payload = envelope(body.envelope, LIMITS.reportBytes);
        const rows = await clearExpiredReports(pk, time);
        const marker = await store.get(pk, `REPORTID#${body.id}`);
        if (marker && marker.expiresAt > time / 1000) return {id: body.id, receivedAt: marker.receivedAt};
        const duplicate = rows.find(row => row.id === body.id);
        if (duplicate) return {id: duplicate.id, receivedAt: duplicate.receivedAt};
        await reconcileReportCount(pk);
        if (rows.length >= LIMITS.reports) fail(429, 'report_limit', 'This club has reached its private report limit. Try again after older reports expire.');
        await rate(`report:${id}:${ip}`, 5, 60000); await rate(`report-day:${id}`, 30, DAY);
        const receivedAt = time, expiresAt = expiry(time, LIMITS.chatSeconds), report = {pk, sk: `REPORT#${pad(time)}#${body.id}`, id: body.id, envelope: payload, receivedAt, expiresAt}, markerItem = {pk, sk: `REPORTID#${body.id}`, id: body.id, reportSk: report.sk, receivedAt, expiresAt};
        try {
          const markerCondition = marker ? {attribute: 'expiresAt', lt: Math.floor(time / 1000) + 1} : {absent: true};
          await store.transact([{put: report, condition: {absent: true}}, {put: markerItem, condition: markerCondition}, {key: {pk, sk: 'REPORTCOUNT'}, add: {count: 1}, set: {expiresAt, rev: randomUUID()}, condition: {attribute: 'count', lt: LIMITS.reports}}]);
          return {id: report.id, receivedAt};
        } catch (e) {
          if (e instanceof Conflict) {
            const existingMarker = await store.get(pk, `REPORTID#${body.id}`);
            if (existingMarker && existingMarker.expiresAt > time / 1000) return {id: body.id, receivedAt: existingMarker.receivedAt};
            const current = await store.query(pk, {from: 'REPORT#', to: 'REPORT#\uffff', limit: LIMITS.reports});
            const same = current.find(row => row.id === body.id);
            if (same) return {id: same.id, receivedAt: same.receivedAt};
            fail(429, 'report_limit', 'This club has reached its private report limit. Try again after older reports expire.');
          }
          throw e;
        }
      }
      const reports = (await clearExpiredReports(pk, time)).sort((a, b) => b.sk.localeCompare(a.sk)).slice(0, LIMITS.reports);
      return {reports: reports.map(report => ({id: report.id, envelope: report.envelope, receivedAt: report.receivedAt}))};
    }
    const match = path.match(/^\/v1\/clubs\/([0-9a-f-]+)(\/(?:messages|subscriptions|reminders\/test))?$/i);
    if (!match) fail(404, 'not_found', 'That club action could not be found.');
    const [, id, suffix = ''] = match, time = now(), pk = pkFor(id);
    const club = await authorised(id, token, method === 'PUT' && !suffix);
    await rate(`read:${id}:${ip}`, 600, 60000);
    if (!suffix && method === 'GET') return publicClub(club);
    if (!suffix && method === 'PUT') {
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) fail(400, 'invalid_version', 'Refresh the club before saving.');
      const state = envelope(body.state, LIMITS.stateBytes), events = eventsList(body.events, time);
      if (body.expectedVersion !== club.version) fail(409, 'version_conflict', 'The club has changed. Refresh it before saving.');
      await rate(`edit:${id}`, 20, 60000);
      const oldJobs = club.events.map(e => jobFor(id, e, time)), newJobs = jobsFor(id, events, time);
      const oldKeys = new Set(oldJobs.map(j => j.sk)), newKeys = new Set(newJobs.map(j => j.sk));
      const updated = {...club, state, events, version: club.version + 1, updatedAt: time, expiresAt: expiry(time, LIMITS.clubSeconds)};
      try { await store.transact([{put: updated, condition: {attribute: 'version', equals: club.version}}, ...oldJobs.filter(j => !newKeys.has(j.sk)).map(key => ({key: {pk, sk: key.sk}, delete: true})), ...newJobs.filter(j => !oldKeys.has(j.sk)).map(put => ({put}))]); }
      catch (e) { if (e instanceof Conflict) fail(409, 'version_conflict', 'The club has changed. Refresh it before saving.'); throw e; }
      return {id, version: updated.version, updatedAt: time};
    }
    if (suffix === '/messages' && method === 'GET') {
      const after = cursorCount(query.after, id);
      const messages = (await store.query(pk, {from: `MSG#${pad(after + 1)}`, to: 'MSG#\uffff', reverse: true, limit: 100})).filter(m => m.expiresAt > time / 1000).reverse();
      return {messages: messages.map(publicMessage), cursor: messages.at(-1)?.cursor || query.after || null};
    }
    if (suffix === '/messages' && method === 'POST') {
      if (!uuid(body.id)) fail(400, 'invalid_message', 'That message could not be sent.');
      const payload = envelope(body.payload, LIMITS.messageBytes), existing = await store.get(pk, `MID#${body.id}`);
      if (existing && existing.expiresAt > time / 1000) return messageReceipt(existing);
      await rate(`post:${id}:${ip}`, 20, 60000); await rate(`post-day:${id}`, 2000, DAY);
      // Allocate the sequence in the same transaction as the message. A reserved
      // sequence that commits late could otherwise disappear behind a newer cursor.
      for (let attempt = 0; attempt < 8; attempt++) {
        const previous = await store.get(pk, 'SEQUENCE');
        const seq = (previous?.count || 0) + 1;
        const receipt = {id: body.id, receivedAt: Math.max(time, previous?.receivedAt || 0), cursor: cursorFor(id, seq), expiresAt: expiry(time, LIMITS.chatSeconds)};
        try {
          await store.transact([
            {put: {pk, sk: 'SEQUENCE', count: seq, receivedAt: receipt.receivedAt, expiresAt: expiry(time, LIMITS.clubSeconds)}, condition: previous ? {attribute: 'count', equals: previous.count} : {absent: true}},
            {put: {pk, sk: `MID#${body.id}`, ...receipt}, condition: existing ? {attribute: 'expiresAt', equals: existing.expiresAt} : {absent: true}},
            {put: {pk, sk: `MSG#${pad(seq)}`, ...receipt, payload}}
          ]);
          return messageReceipt(receipt);
        } catch (e) {
          if (e instanceof Conflict) { const duplicate = await store.get(pk, `MID#${body.id}`); if (duplicate && duplicate.expiresAt > time / 1000) return messageReceipt(duplicate); }
          else throw e;
        }
      }
      fail(503, 'chat_busy', 'The club chat is busy. Try sending that message again.');
    }
    if (suffix === '/subscriptions' && method === 'POST') {
      if (!uuid(body.clientId) || !Array.isArray(body.eventIds) || body.eventIds.length > 30 || body.eventIds.some(x => !uuid(x)) || new Set(body.eventIds).size !== body.eventIds.length) fail(400, 'invalid_subscription', 'Choose valid match reminders.');
      let subscription; try { subscription = validateSubscription(body.subscription); } catch { fail(400, 'invalid_subscription', 'This browser reminder service is not supported.'); }
      await rate(`subscribe:${id}:${ip}`, 10, 60000);
      const subId = hash(`${id}/${subscription.endpoint}`), key = {pk, sk: `SUB#${subId}`};
      const item = {...key, rev: randomUUID(), id: subId, clientId: body.clientId, subscription, eventIds: body.eventIds, expiresAt: expiry(time, 90 * 86400)};
      // Every update is conditional. A concurrent delete must not resurrect a row
      // without allocating its capacity again; competing creates retry the same path.
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await store.get(pk, key.sk);
        if (existing) {
          try {
            await store.put(item, existing.rev ? {attribute: 'rev', equals: existing.rev} : {attribute: 'rev', missing: true});
            return {id: subId};
          } catch (e) { if (!(e instanceof Conflict)) throw e; continue; }
        }
        const counter = await store.get(pk, 'SUBCOUNT');
        if (counter?.count >= LIMITS.subscriptions) {
          const registered = await store.query(pk, {from: 'SUB#', to: 'SUB#\uffff', limit: 51});
          for (const sub of registered.filter(s => s.expiresAt <= time / 1000)) await deleteSubscription(id, sub.id);
          const snapshot = await store.get(pk, 'SUBCOUNT');
          const current = await store.query(pk, {from: 'SUB#', to: 'SUB#\uffff', limit: 51});
          if (snapshot) {
            try { await store.put({...snapshot, count: current.length, rev: snapshot.rev + 1}, {attribute: 'rev', equals: snapshot.rev}); }
            catch (e) { if (!(e instanceof Conflict)) throw e; }
          }
        }
        try {
          await store.transact([{put: item, condition: {absent: true}}, {key: {pk, sk: 'SUBCOUNT'}, add: {count: 1, rev: 1}, set: {expiresAt: expiry(time, LIMITS.clubSeconds)}, condition: {attribute: 'count', lt: LIMITS.subscriptions}}]);
          return {id: subId};
        } catch (e) {
          if (!(e instanceof Conflict)) throw e;
          if (!await store.get(pk, key.sk)) fail(429, 'subscription_limit', 'This pilot club has reached its device reminder limit.');
        }
      }
      fail(409, 'subscription_changed', 'Reminder settings changed. Try again.');
    }
    if (suffix === '/subscriptions' && method === 'DELETE') {
      if (!HASH.test(body.id)) fail(400, 'invalid_subscription', 'Choose this device reminder subscription.');
      await deleteSubscription(id, body.id); return {removed: true};
    }
    if (suffix === '/reminders/test' && method === 'POST') {
      if (!HASH.test(body.subscriptionId)) fail(400, 'invalid_subscription', 'Enable reminders on this device first.');
      await rate(`test:${id}:${ip}`, 2, 60000); await rate(`test-club:${id}`, 20, DAY);
      return sendTest(id, body.subscriptionId);
    }
    fail(405, 'method_not_allowed', 'That club action is not available.');
  }
  async function handler(event) {
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const origin = headers.origin;
    const responseHeaders = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'vary': 'Origin'};
    if (origin && allowedOrigins.includes(origin)) Object.assign(responseHeaders, {'access-control-allow-origin': origin, 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-max-age': '600'});
    const reply = (statusCode, body) => ({statusCode, headers: responseHeaders, body: JSON.stringify(body)});
    try {
      if (origin && !allowedOrigins.includes(origin)) fail(403, 'origin_not_allowed', 'Open Same End from its usual address.');
      const method = event.requestContext?.http?.method || event.httpMethod;
      const path = event.rawPath || event.path || '';
      const query = event.queryStringParameters || {};
      if (path === '/v1/edge-health') {
        if (method !== 'POST') fail(405, 'method_not_allowed', 'That action is not available.');
        const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '');
        if (rawBody.length > 2048) fail(413, 'payload_too_large', 'That update is too large.');
        if (!edgeHealth) fail(503, 'edge_unavailable', 'Edge health is not configured.');
        const result = await edgeHealth.submit({signature: headers['x-edge-signature'], timestamp: headers['x-edge-timestamp'], rawBody});
        return reply(result.status, result.body);
      }
      if (path === '/v1/analytics/events') {
        if (method === 'OPTIONS') {
          if (!origin || !allowedOrigins.includes(origin)) fail(403, 'origin_not_allowed', 'Open Same End from its usual address.');
          if (headers['access-control-request-method']?.toUpperCase() !== 'POST') fail(405, 'method_not_allowed', 'That analytics action is not available.');
          const requestedHeaders = (headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
          if (requestedHeaders.some(value => value !== 'content-type')) fail(400, 'invalid_metadata', 'That analytics request is not valid.');
          if (Object.keys(query).length || Object.keys(event.multiValueQueryStringParameters || {}).length || event.rawQueryString) fail(400, 'invalid_metadata', 'That analytics request is not valid.');
          return reply(204, null);
        }
        if (method !== 'POST') fail(405, 'method_not_allowed', 'That analytics action is not available.');
        if (Object.keys(query).length || Object.keys(event.multiValueQueryStringParameters || {}).length || event.rawQueryString) fail(400, 'invalid_metadata', 'That analytics request is not valid.');
        if (headers.authorization) fail(400, 'invalid_metadata', 'That analytics request is not valid.');
        const rawEvent = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '');
        if (rawEvent.length > 256) fail(413, 'payload_too_large', 'That analytics event is too large.');
        if (!/^application\/json(?:;|$)/i.test(headers['content-type'] || '')) fail(415, 'json_required', 'Send this event as JSON.');
        let payload; try { payload = JSON.parse(rawEvent.toString('utf8')); } catch { fail(400, 'invalid_json', 'That analytics event could not be read.'); }
        try { return reply(200, await analytics.collect(payload, origin, allowedOrigins, event.requestContext?.http?.sourceIp)); }
        catch (e) { if (e.status) fail(e.status, e.code, e.message); throw e; }
      }
      if (method === 'OPTIONS') return reply(204, null);
      const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '');
      if (raw.length > LIMITS.requestBytes) fail(413, 'payload_too_large', 'That club update is too large.');
      let body = {};
      if (raw.length) {
        if (!/^application\/json(?:;|$)/i.test(headers['content-type'] || '')) fail(415, 'json_required', 'Send this update as JSON.');
        try { body = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'invalid_json', 'That club update could not be read.'); }
        if (!object(body)) fail(400, 'invalid_json', 'That club update could not be read.');
      }
      const auth = headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
      // Hash IP addresses into short-lived quota buckets; never store raw network addresses.
      const ip = hash(`${Math.floor(now() / DAY)}/${event.requestContext?.http?.sourceIp || 'local'}`);
      return reply(200, await route(method, path, query, body, auth?.[1], ip));
    } catch (e) {
      if (e instanceof ApiError) return reply(e.status, {error: e.message, code: e.code});
      // Never return/log SDK errors, endpoints, subscriptions, bearer capabilities or encrypted bodies.
      return reply(503, {error: 'The private club service is temporarily unavailable. Try again shortly.', code: 'service_unavailable'});
    }
  }
  return {handler, deleteSubscription};
}
