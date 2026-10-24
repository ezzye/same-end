/* This worker is a transient bridge to one owning page. It never fetches or
 * stores programme bytes. The opaque capability is unrelated to room keys. */
export const HLS_NAMESPACE = '_sameend/hls/';
export const HLS_BRIDGE_VERSION = 2;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export function validResource(path) {
  return typeof path === 'string' && path.length <= 240 && /^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.(m3u8|mp4|m4s)$/.test(path) && !path.split('/').some(p => !p || p === '.' || p === '..');
}
export function byteRange(value, length) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 80 || !/^bytes=\d*-\d*$/.test(value)) throw Error('Invalid byte range');
  const [a, b] = value.slice(6).split('-');
  let start, end;
  if (!a) { const count = Number(b); if (!Number.isSafeInteger(count) || count <= 0) throw Error('Invalid byte range'); start = Math.max(0, length - count); end = length - 1; }
  else { start = Number(a); end = b ? Number(b) : length - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= length || end < start) throw Error('Unsatisfiable byte range');
  return { start, end: Math.min(end, length - 1) };
}
// A capability is bound to a browser Client ID without exposing that ID or the
// random page seed in its URL. Another client cannot re-register a copied URL.
export async function boundCapability(owner, seed) {
  if (typeof owner !== 'string' || !owner || owner.length > 256 || !/^[a-f0-9]{32}$/.test(seed || '')) throw Error('Invalid HLS ownership proof');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sameend:hls:v2:' + owner + ':' + seed));
  return [...new Uint8Array(bytes).subarray(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function install(scope, { ttlMs = 60000, timeoutMs = 12000, recoveryTimeoutMs = 1500, maxSessions = 32, now = Date.now } = {}) {
  const base = new URL('./', scope.location.href), prefix = base.pathname + HLS_NAMESPACE, sessions = new Map(), closed = new Map(), recovering = new Map();
  const reply = (event, data) => { try { event.ports?.[0]?.postMessage(data); } catch {} };
  const inScope = owner => { try { const u = new URL(owner.url); return !!owner.id && u.origin === base.origin && u.pathname.startsWith(base.pathname); } catch { return false; } };
  const prune = () => {
    for (const map of [sessions, closed]) for (const [key, entry] of map) if (now() - entry.at > ttlMs) map.delete(key);
  };
  const request = (client, data, timeout) => new Promise(resolve => {
    const channel = new MessageChannel(); let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); channel.port1.close(); resolve(result); };
    const timer = setTimeout(() => finish(null), timeout);
    channel.port1.onmessage = event => finish(event.data); channel.port1.onmessageerror = () => finish(null);
    try { client.postMessage(data, [channel.port2]); } catch { finish(null); }
  });
  const proofMatches = async (client, token, seed) => { try { return inScope(client) && await boundCapability(client.id, seed) === token; } catch { return false; } };
  const recover = async (token, clientId) => {
    if (closed.has(token) || sessions.size >= maxSessions) return null;
    const key = token + ':' + (clientId || 'native');
    if (recovering.has(key)) return recovering.get(key);
    if (recovering.size >= maxSessions) return null;
    const work = (async () => {
      // Ordinary fetches probe only their requesting client. Native stacks can
      // omit clientId, so probe at most32 controlled in-scope windows. These
      // messages contain an opaque capability only, never playlists or media.
      const candidates = clientId ? [await scope.clients.get(clientId)] : (await scope.clients.matchAll({ type: 'window', includeUncontrolled: false })).filter(inScope).slice(0, maxSessions);
      const found = await Promise.all(candidates.filter(client => client && inScope(client)).map(async client => {
        const answer = await request(client, { type: 'sameend:hls:recover', token }, recoveryTimeoutMs);
        return answer?.ok && await proofMatches(client, token, answer.seed) ? client : null;
      }));
      const owner = found.find(Boolean);
      if (!owner || closed.has(token)) return null;
      const existing = sessions.get(token);
      if (existing) return existing.owner === owner.id ? existing : null;
      if (sessions.size >= maxSessions) return null;
      const entry = { owner: owner.id, at: now(), pending: 0 }; sessions.set(token, entry); return entry;
    })();
    recovering.set(key, work);
    try { return await work; } finally { recovering.delete(key); }
  };
  scope.addEventListener('message', event => {
    const d = event.data; if (!d || !/^sameend:hls:/.test(d.type || '')) return;
    const work = (async () => {
      const owner = event.source; if (!owner || !inScope(owner)) return reply(event, { ok: false });
      if (d.type === 'sameend:hls:claim') { await scope.clients.claim(); return reply(event, { ok: true, version: HLS_BRIDGE_VERSION, clientId: owner.id }); }
      if (!/^[a-f0-9]{32}$/.test(d.token || '') || !await proofMatches(owner, d.token, d.seed)) return reply(event, { ok: false });
      prune(); const existing = sessions.get(d.token);
      if (existing && existing.owner !== owner.id) return reply(event, { ok: false });
      if (d.type === 'sameend:hls:close') {
        sessions.delete(d.token); closed.set(d.token, { owner: owner.id, at: now() });
        while (closed.size > maxSessions * 2) closed.delete(closed.keys().next().value);
        return reply(event, { ok: true });
      }
      if (d.type === 'sameend:hls:open' || d.type === 'sameend:hls:touch') {
        if (closed.has(d.token) || (!existing && sessions.size >= maxSessions)) return reply(event, { ok: false });
        sessions.set(d.token, existing || { owner: owner.id, at: now(), pending: 0 }); if (existing) existing.at = now();
        return reply(event, { ok: true, version: HLS_BRIDGE_VERSION });
      }
      reply(event, { ok: false });
    })().catch(() => reply(event, { ok: false }));
    event.waitUntil?.(work);
  });
  const failure = (status = 503) => new Response(null, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  scope.addEventListener('fetch', event => {
    const url = new URL(event.request.url); if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return;
    event.respondWith((async () => {
      prune();
      if (url.search || url.hash || !['GET', 'HEAD'].includes(event.request.method)) return failure(403);
      const tail = url.pathname.slice(prefix.length), slash = tail.indexOf('/'), token = tail.slice(0, slash), path = tail.slice(slash + 1);
      if (!/^[a-f0-9]{32}$/.test(token) || !validResource(path)) return failure(403);
      const entry = sessions.get(token) || await recover(token, event.clientId);
      // Some native media stacks omit clientId. The unguessable capability then
      // still selects exactly one previously authenticated page owner.
      if (!entry || (event.clientId && event.clientId !== entry.owner)) return failure(403);
      const client = await scope.clients.get(entry.owner); if (!client) { sessions.delete(token); return failure(410); }
      const range = event.request.headers.get('range');
      if (range && (range.length > 80 || !/^bytes=\d*-\d*$/.test(range))) return failure(416);
      if (entry.pending >= 32) return failure();
      entry.at = now(); entry.pending++;
      const payload = await request(client, { type: 'sameend:hls:read', token, path, range, method: event.request.method }, timeoutMs);
      entry.pending--;
      if (sessions.get(token) !== entry) return failure(410);
      if (!payload || ![200, 206, 404, 410, 416, 503].includes(payload.status)) return failure();
      if (![200, 206, 416].includes(payload.status)) return failure(payload.status);
      if (!Number.isSafeInteger(payload.total) || payload.total < 1 || payload.total > MAX_RESPONSE_BYTES) return failure();
      const bytes = payload.bytes;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_RESPONSE_BYTES) return failure();
      const headers = { 'cache-control': 'no-store', 'content-type': /mpegurl/i.test(payload.mime || '') ? 'application/vnd.apple.mpegurl' : /^(video|audio)\/(mp4|iso.segment)$/.test(payload.mime || '') ? payload.mime : 'application/octet-stream', 'accept-ranges': 'bytes', 'referrer-policy': 'no-referrer' };
      let expectedRange; try { expectedRange = byteRange(range, payload.total); } catch { expectedRange = false; }
      if (payload.status === 416) { if (expectedRange !== false || bytes.byteLength) return failure(); headers['content-range'] = 'bytes */' + payload.total; return new Response(null, { status: 416, headers }); }
      if (expectedRange === false || (payload.status === 206) !== !!expectedRange) return failure();
      const expected = expectedRange ? expectedRange.end - expectedRange.start + 1 : payload.total;
      if (bytes.byteLength !== (event.request.method === 'HEAD' ? 0 : expected)) return failure();
      headers['content-length'] = String(expected);
      if (expectedRange) headers['content-range'] = `bytes ${expectedRange.start}-${expectedRange.end}/${payload.total}`;
      return new Response(event.request.method === 'HEAD' ? null : bytes, { status: payload.status, headers });
    })().catch(() => failure()));
  });
  return { sessionCount: () => { prune(); return sessions.size; }, pendingRecoveries: () => recovering.size };
}
