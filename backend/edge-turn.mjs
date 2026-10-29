import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

const MAX_TTL_SECONDS = 3600;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validTurnUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u0020]/.test(value)) return false;
  const match = /^turns?:(?:\/\/)?([^/?#]+)(?:\?transport=(udp|tcp))?$/i.exec(value);
  if (!match || match[1].includes('@')) return false;
  try {
    const host = new URL(`http://${match[1]}`);
    return Boolean(host.hostname) && !host.username && !host.password &&
      (!host.port || Number(host.port) >= 1 && Number(host.port) <= 65535);
  } catch { return false; }
}

export function createEdgeTurnCredentials({urls, secret, nowMs = Date.now(), ttlSeconds = 600} = {}) {
  if (urls == null || urls === '' || (Array.isArray(urls) && urls.length === 0) || secret == null || secret === '') {
    return {iceServers: [], expiresAt: null};
  }
  if (!Array.isArray(urls) || !urls.length || urls.length > 8 || !urls.every(validTurnUrl)) throw new TypeError('Invalid TURN URL configuration');
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512 || /[\u0000-\u001f]/.test(secret)) throw new TypeError('Invalid TURN shared secret');
  if (!finite(nowMs) || nowMs < 0 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS) throw new TypeError('Invalid TURN credential lifetime');
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiresAt}:${randomBytes(18).toString('base64url')}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return {iceServers: [{urls: [...new Set(urls)], username, credential}], expiresAt};
}

export function parseCoturnMetrics(text) {
  if (typeof text !== 'string' || text.length > 1_000_000) return {allocations: null};
  let allocations = 0, seen = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^turn_total_allocations(?:\{([^}]*)\})?\s+([0-9]+(?:\.[0-9]+)?)$/.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 0) continue;
    allocations += value;
    seen = true;
  }
  return {allocations: seen ? allocations : null};
}

export function assessEdgeCapacity({sample, config, nowMs = Date.now()} = {}) {
  const reasons = [], missing = [];
  if (!sample || !config || !finite(sample.sampledAtMs) || !finite(nowMs) || !finite(config.reportTtlMs)) {
    return {state: 'unknown', allowNew: false, reasons: ['missing-report-or-policy'], sampledAtMs: sample?.sampledAtMs ?? null, expiresAtMs: null};
  }
  const expiresAtMs = sample.sampledAtMs + config.reportTtlMs;
  if (sample.sampledAtMs > nowMs || nowMs > expiresAtMs) return {state: 'stale', allowNew: false, reasons: ['report-expired'], sampledAtMs: sample.sampledAtMs, expiresAtMs};

  if (finite(sample.cpuBusyRatio)) {
    if (sample.cpuBusyRatio >= (config.cpuBusyLimit ?? 0.9)) reasons.push('cpu-busy');
  } else missing.push('cpu');
  if (finite(sample.memoryAvailableRatio)) {
    if (sample.memoryAvailableRatio <= (config.minimumMemoryAvailableRatio ?? 0.1)) reasons.push('memory-pressure');
  } else missing.push('memory');
  if (finite(config.uplinkBudgetMbps)) {
    if (!finite(sample.networkTxMbps)) missing.push('network-rate');
    else if (sample.networkTxMbps >= config.uplinkBudgetMbps * (config.uplinkHeadroomRatio ?? 0.8)) reasons.push('uplink-headroom');
  } else missing.push('uplink-budget');
  if (Number.isInteger(config.allocationLimit) && config.allocationLimit > 0) {
    if (!Number.isInteger(sample.allocations)) missing.push('allocations');
    else if (sample.allocations >= Math.ceil(config.allocationLimit * (config.allocationHeadroomRatio ?? 0.9))) reasons.push('allocation-headroom');
  } else missing.push('allocation-limit');
  if (sample.metricError) missing.push('coturn-metrics');
  const state = reasons.length ? 'constrained' : missing.length ? 'unknown' : 'healthy';
  return {state, allowNew: state === 'healthy', reasons: [...new Set([...reasons, ...missing.map(x => `unknown-${x}`)])], sampledAtMs: sample.sampledAtMs, expiresAtMs, metrics: {cpuBusyRatio: sample.cpuBusyRatio ?? null, memoryAvailableRatio: sample.memoryAvailableRatio ?? null, networkTxMbps: sample.networkTxMbps ?? null, uplinkBudgetMbps: config.uplinkBudgetMbps ?? null, allocations: sample.allocations ?? null, allocationLimit: config.allocationLimit ?? null}};
}


const HEALTH_KEY = {pk: 'EDGE#TURN', sk: 'HEALTH'};

export async function getEdgeHealth({store, policy, now = Date.now} = {}) {
  const stored = await store?.get(HEALTH_KEY.pk, HEALTH_KEY.sk);
  return assessEdgeCapacity({sample: stored?.sample ?? null, config: policy, nowMs: now()});
}

export function createEdgeHealthHandler({secret, policy, store, now = Date.now} = {}) {
  if (typeof secret !== 'string' || secret.length < 24 || !policy || !store?.get || !store?.put) throw new TypeError('Edge health authentication, policy and store are required');
  const current = () => getEdgeHealth({store, policy, now});
  const submit = async ({signature, timestamp, rawBody} = {}) => {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : typeof rawBody === 'string' ? rawBody : null;
    if (text === null || Buffer.byteLength(text) > 4096 || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return {status: 400, body: {error: 'invalid_edge_health'}};
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(text).digest('hex');
    const supplied = Buffer.from(signature, 'hex'), actual = Buffer.from(expected, 'hex');
    if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual)) return {status: 401, body: {error: 'unauthorized'}};
    const sentAt = Number(timestamp);
    if (!Number.isSafeInteger(sentAt) || Math.abs(now() - sentAt) > policy.reportTtlMs) return {status: 400, body: {error: 'stale_edge_health'}};
    let body;
    try { body = JSON.parse(text); } catch { return {status: 400, body: {error: 'invalid_edge_health'}}; }
    const allowed = ['sampledAtMs', 'cpuBusyRatio', 'memoryAvailableRatio', 'networkTxMbps', 'allocations', 'metricError'];
    const inRange = value => value === null || finite(value);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)) ||
      !finite(body.sampledAtMs) || body.sampledAtMs !== sentAt || body.sampledAtMs > now() + 5_000 ||
      !(inRange(body.cpuBusyRatio) && (body.cpuBusyRatio === null || body.cpuBusyRatio >= 0 && body.cpuBusyRatio <= 1)) ||
      !(inRange(body.memoryAvailableRatio) && (body.memoryAvailableRatio === null || body.memoryAvailableRatio >= 0 && body.memoryAvailableRatio <= 1)) ||
      !(inRange(body.networkTxMbps) && (body.networkTxMbps === null || body.networkTxMbps >= 0)) ||
      !(body.allocations === null || Number.isSafeInteger(body.allocations) && body.allocations >= 0) ||
      !(body.metricError === undefined || typeof body.metricError === 'boolean')) return {status: 400, body: {error: 'invalid_edge_health'}};
    const previous = await store.get(HEALTH_KEY.pk, HEALTH_KEY.sk);
    if (previous && sentAt <= previous.timestamp) return {status: 409, body: {error: 'replayed_edge_health'}};
    const item = {...HEALTH_KEY, timestamp: sentAt, sample: {...body, metricError: body.metricError === true}, expiresAt: Math.ceil((sentAt + policy.reportTtlMs) / 1000)};
    try { await store.put(item, previous ? {attribute: 'timestamp', equals: previous.timestamp} : {absent: true}); }
    catch (error) { if (error?.name === 'Conflict') return {status: 409, body: {error: 'replayed_edge_health'}}; throw error; }
    return {status: 200, body: assessEdgeCapacity({sample: item.sample, config: policy, nowMs: now()})};
  };
  return {submit, current};
}
