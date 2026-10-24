/* New-room acceptance: real continuous HLS/CMAF capture, signed WebRTC media,
 * automatic combined invitations, encrypted live chat, late join and recovery.
 * Four clean Chrome contexts on ONE Mac; local WSS discovery and ephemeral chat
 * API only. No TURN, HTTP media, public service, fake clocks or OS/device claim.
 * Build first, then node tests/hls-room-flow-browser.test.mjs (~3 minutes).
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../backend/api.mjs';
import { MemoryStore } from '../backend/store.mjs';

const runtime = process.env.SAMEEND_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(runtime), require = createRequire(import.meta.url);
const { wsServer: WebSocketServer } = require(join(dirname(dirname(runtime)), 'playwright-core/lib/utilsBundle.js'));
const root = new URL('../', import.meta.url), output = new URL('privatework/hls-room-flow/', root);
await mkdir(output, { recursive: true });
const originalHTML = await readFile(new URL('dist/watch.html', root), 'utf8');
// Dormant transport code is injected only when an invitation is made. Parse it
// explicitly so build-time HTML insertion cannot silently corrupt that path.
for (const id of ['magnet-module', 'magnet-vendor']) {
  const asset = originalHTML.match(new RegExp('<script[^>]*id=\"' + id + '\"[^>]*>([\\s\\S]*?)<\\/script>'));
  assert(asset, 'Built app contains ' + id);
  assert.doesNotThrow(() => new Function(asset[1]), 'Built deferred asset parses: ' + id);
}
const publicBase = JSON.parse(await readFile(new URL('public-config.json', root), 'utf8')).apiBase;
const certDir = await mkdtemp(join(tmpdir(), 'sameend-hls-room-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-subj', '/CN=localhost'], { stdio: 'ignore' });
let origin, servedHTML, api;
const requests = [], mediaAttempts = [], externalRequests = [], trackerErrors = [];
const server = https.createServer({ key: await readFile(join(certDir, 'key.pem')), cert: await readFile(join(certDir, 'cert.pem')) }, async (req, res) => {
  try {
    const url = new URL(req.url, origin); requests.push(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const result = await api.handler({ rawPath: url.pathname.slice(4), headers: req.headers, body: Buffer.concat(chunks).toString(), queryStringParameters: Object.fromEntries(url.searchParams), requestContext: { http: { method: req.method, sourceIp: 'hls-room-test' } } });
      return res.writeHead(result.statusCode, result.headers).end(result.body);
    }
    if (/\.(?:m3u8|m4s|mp4|ts)(?:$|[?#])/i.test(url.pathname)) { mediaAttempts.push(url.pathname); return res.writeHead(403).end('Video must arrive from peers.'); }
    if (url.pathname === '/sw.js') return res.writeHead(404).end();
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(servedHTML);
  } catch { res.writeHead(500).end('Isolated test server failed.'); }
});
const tracker = new WebSocketServer({ server, path: '/tracker' }), swarms = new Map();
const trackerStats = { connections: 0, announces: 0, offers: 0, answers: 0 };
const send = (socket, message) => { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); };
tracker.on('connection', socket => {
  trackerStats.connections++; socket.memberships = [];
  socket.on('error', error => trackerErrors.push(error.name));
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.action !== 'announce' || typeof message.info_hash !== 'string' || typeof message.peer_id !== 'string') return;
      trackerStats.announces++;
      let swarm = swarms.get(message.info_hash); if (!swarm) { swarm = new Map(); swarms.set(message.info_hash, swarm); }
      if (message.event === 'stopped') { swarm.delete(message.peer_id); return; }
      swarm.set(message.peer_id, socket); socket.memberships.push([message.info_hash, message.peer_id]);
      if (message.answer && message.to_peer_id) {
        trackerStats.answers++; send(swarm.get(message.to_peer_id), { action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id, offer_id: message.offer_id, answer: message.answer }); return;
      }
      send(socket, { action: 'announce', info_hash: message.info_hash, interval: 2, complete: 1, incomplete: Math.max(0, swarm.size - 1) });
      const peers = [...swarm].filter(([id, peer]) => id !== message.peer_id && peer.readyState === 1);
      for (let i = 0; i < Math.min(peers.length, message.offers?.length || 0); i++) {
        const offer = message.offers[i]; trackerStats.offers++; send(peers[i][1], { action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id, offer_id: offer.offer_id, offer: offer.offer });
      }
    } catch { trackerErrors.push('MalformedTrackerMessage'); }
  });
  socket.on('close', () => { for (const [hash, id] of socket.memberships) { const swarm = swarms.get(hash); if (swarm?.get(id) === socket) swarm.delete(id); if (!swarm?.size) swarms.delete(hash); } });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = 'https://127.0.0.1:' + server.address().port;
api = createApi({ store: new MemoryStore(), push: { enabled: false }, allowedOrigins: [origin] });
assert(originalHTML.includes('wss://tracker.openwebtorrent.com'), 'Built production tracker configuration must be present');
servedHTML = originalHTML.replaceAll(publicBase, '/api').replace(/wss:\/\/tracker\.[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_/-]*)?/g, origin.replace('https:', 'wss:') + '/tracker');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const pages = {}, contexts = [], pageErrors = [];
const report = { schema: 1, startedAt: new Date().toISOString(), buildSHA256: createHash('sha256').update(originalHTML).digest('hex'), environment: { oneComputer: true, actualWebRTC: true, isolatedChromeContexts: true, localWssDiscovery: true, ephemeralLocalEncryptedChat: true, generatedMedia: true, autoplayOverride: false, localSelfSignedCertificateOverride: true, physicalDevices: false, separateNetworks: false, cloudVideoRelay: false, delay: 60 }, tracker: trackerStats, events: [], samples: [], pass: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sanitize = value => String(value).replace(/https?:\/\/\S*#\S*/g, '[private invitation removed]').replace(/magnet:\S+/g, '[magnet invitation removed]').replace(/#pc=[A-Za-z0-9_-]+/g, '#pc=[removed]');
async function until(check, timeout, message) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await pause(250); } throw Error(message); }
async function page(label, invitation) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } }); contexts.push(context);
  await context.route('**/*', route => { const url = route.request().url(); if (!url.startsWith(origin + '/')) { externalRequests.push(new URL(url).hostname); if (/\.(?:m3u8|m4s|mp4|ts)(?:$|[?#])/i.test(url)) mediaAttempts.push('[blocked external media]'); return route.abort(); } return route.continue(); });
  const result = await context.newPage(); pages[label] = result;
  result.on('pageerror', error => pageErrors.push({ label, error: sanitize(error.stack || error.message) }));
  await result.goto(invitation || origin + '/');
  await result.waitForFunction(() => window.PrivateCast?.testing && window.SameEndSocial?.snapshot().ready);
  await result.locator('#name').evaluate((input, value) => { input.value = value; }, 'HLS ' + label);
  return result;
}
async function snapshot(page) {
  if (page.isClosed()) return { closed: true };
  return page.evaluate(() => {
    const state = PrivateCast.snapshot(), video = document.querySelector('#player'), probe = window.hlsRoomProbe;
    let rms = null;
    if (probe) { const data = new Float32Array(probe.analyser.fftSize); probe.analyser.getFloatTimeDomainData(data); rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length); }
    return { sampledAt: Date.now(), nodeId: state.nodeId, config: state.config, sourceReachable: state.sourceReachable, sourceEnded: state.sourceEnded, role: state.role, supplier: state.supplier, clockReady: state.clockReady, received: state.received, reserveSeconds: state.reserveSeconds, recovery: state.recovery, stalls: state.stalls, programTime: state.programTime, target: state.targetProgramTime, drift: state.drift, peers: state.peers, mode: state.playbackMode, cacheBytes: state.cacheBytes, playback: state.mediaDiagnostics.playback, delivery: state.delivery, chatCount: SameEndSocial.snapshot().chatCount, chatConnected: SameEndSocial.snapshot().connected, chatHidden: document.querySelector('#club-chat-shell')?.hidden, chatParent: document.querySelector('#club-chat-shell')?.parentElement?.className || null, frames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0, frameCallbacks: probe?.frames || 0, lastFrameAt: probe?.lastFrameAt || null, rms, ready: video.readyState, paused: video.paused, width: video.videoWidth, height: video.videoHeight, status: document.querySelector('#play-state').textContent };
  }).catch(error => { if (page.isClosed()) return { closed: true }; throw error; });
}
async function record(label) { const states = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, page]) => [name, await snapshot(page)]))); report.events.push({ label, at: Date.now(), states }); console.log(JSON.stringify({ stage: label })); return states; }
async function probe(page) {
  await page.evaluate(() => {
    const video = document.querySelector('#player'), context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaElementSource(video).connect(analyser); analyser.connect(context.destination);
    const probe = window.hlsRoomProbe = { context, analyser, frames: 0, lastFrameAt: null };
    const frame = () => { probe.frames++; probe.lastFrameAt = Date.now(); video.requestVideoFrameCallback(frame); }; video.requestVideoFrameCallback(frame);
    const button = document.createElement('button'); button.id = 'resume-test-audio'; button.textContent = 'Measure generated test sound'; button.onclick = () => context.resume(); document.body.append(button);
  });
  await page.locator('#resume-test-audio').click(); await page.locator('#sound').click();
}
async function sendChat(page, message) {
  await page.locator('#club-chat-input').fill(message); await page.locator('#club-send-chat').click();
  await page.waitForFunction(() => document.querySelector('#club-chat-input').value === '');
}
async function received(page) { await until(async () => { const state = await snapshot(page); return state.clockReady && state.received > 2 && state.supplier && state.chatConnected; }, 45000, 'Automatic combined invitation did not connect signed video and chat'); }
async function playing(page) { await until(async () => { const state = await snapshot(page); return state.mode === 'hls' && state.frames > 10 && state.frameCallbacks > 5 && state.ready >= 2 && !state.paused && state.rms > .001 && Number.isFinite(state.programTime); }, 85000, 'Generated HLS picture, sound and shared clock did not play'); }
const identity = state => state.config && Object.fromEntries(['id', 'epoch', 'delay', 'sourceId', 'sourceEpoch', 'programId', 'mediaProfile'].map(key => [key, state.config[key]]));
async function measureWindow(labels, seconds = 7) {
  const start = Date.now(), samples = [];
  while (Date.now() - start < seconds * 1000) { const states = Object.fromEntries(await Promise.all(labels.map(async label => [label, await snapshot(pages[label])]))); const sample = { at: Date.now(), states }; samples.push(sample); report.samples.push(sample); await pause(250); }
  const spreads = samples.map(row => { const positions = labels.map(label => { const state = row.states[label]; return state.programTime + (row.at - state.sampledAt) / 1000; }); return Math.max(...positions) - Math.min(...positions); });
  for (const label of labels) {
    const states = samples.map(row => row.states[label]);
    assert(states.every(state => state.mode === 'hls' && !state.paused && state.ready >= 2), label + ' remains in continuous HLS playback');
    assert(states.at(-1).frames > states[0].frames + seconds * 10, label + ' must keep decoding moving pictures');
    assert(states.filter(state => state.rms > .001).length >= states.length * .9, label + ' must keep decoded test sound');
    assert(Math.max(...states.map(state => state.sampledAt - state.lastFrameAt)) < 1800, label + ' must avoid multi-second decoded-frame gaps');
  }
  assert(Math.max(...spreads) < 1, 'All participants remain within one second of the shared programme moment');
  return { seconds, samples: samples.length, maxSpreadSeconds: Math.max(...spreads) };
}
let monitorRunning = false, monitor;
async function continuityMonitor() { while (monitorRunning) { const states = Object.fromEntries(await Promise.all(['source', 'sibling', 'late'].map(async label => [label, await snapshot(pages[label])]))); report.samples.push({ at: Date.now(), recoveryMonitor: true, states }); await pause(350); } }
async function run() {
  const source = await page('source');
  await source.evaluate(() => { const button = document.createElement('button'); button.id = 'start-generated-hls'; button.textContent = 'Start generated room'; button.onclick = () => window.generatedHlsStart = PrivateCast.testing.startDemo({ delay: 60, profile: 'hls' }); document.body.append(button); });
  await source.locator('#start-generated-hls').click(); await source.evaluate(() => generatedHlsStart);
  console.log(JSON.stringify({ stage: 'continuous HLS source started' }));
  await source.evaluate(() => PrivateCast.testing.setRelayLimit(1));
  // Use the actual product invitation action, including automatic private-club setup.
  await source.locator('#make-magnet').click();
  await source.waitForFunction(() => document.querySelector('#browser-invitation').value.includes('&join='), null, { timeout: 45000 });
  const invitation = await source.locator('#browser-invitation').inputValue();
  console.log(JSON.stringify({ stage: 'combined private video and chat invitation created' }));
  assert(new URL(invitation).hash.includes('#club=') && new URL(invitation).hash.includes('&join='), 'One private invitation carries picture and live-chat access');
  assert.equal(await source.evaluate(() => PrivateCast.snapshot().config.mediaProfile), 'hls-cmaf-v1');
  const relay = await page('relay', invitation); await relay.evaluate(() => PrivateCast.testing.setRelayLimit(0)); await received(relay);
  await source.evaluate(() => PrivateCast.testing.setRelayLimit(2));
  const sibling = await page('sibling', invitation); await sibling.evaluate(() => PrivateCast.testing.setRelayLimit(0)); await received(sibling);
  for (const participant of [source, relay, sibling]) await probe(participant);
  await Promise.all([source, relay, sibling].map(playing));
  const beforeLate = await record('automatic invitation: source and two viewers have picture sound and chat');
  assert.equal(beforeLate.relay.supplier.id, beforeLate.source.nodeId); assert.equal(beforeLate.sibling.supplier.id, beforeLate.source.nodeId);
  assert((Date.now() - beforeLate.source.config.epoch) > 60000, 'Late viewer arrives after the source is already playing');
  await relay.evaluate(() => PrivateCast.testing.setRelayLimit(1));
  const lateAt = Date.now(), late = await page('late', invitation); await late.evaluate(() => PrivateCast.testing.setRelayLimit(0)); await received(late); await probe(late); await playing(late);
  const baseline = await record('late viewer bootstrapped from already watching family peer');
  assert.equal(baseline.late.supplier.id, baseline.relay.nodeId, 'Late viewer must use the family relay');
  assert.deepEqual(identity(baseline.late), identity(baseline.source), 'Late join preserves source programme identity and epoch');
  assert.equal(await late.evaluate(() => location.hash), '', 'Private invitation is removed from browser address');
  await late.locator('#club-chat-shell').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await late.locator('#club-chat-shell').isVisible(), true, 'Combined invitation presents live chat beside the picture');
  report.lateJoinMs = Date.now() - lateAt;
  await sendChat(late, 'Generated HLS late viewer is watching');
  await source.waitForFunction(() => SameEndSocial.snapshot().chatCount > 0);
  assert.equal(await source.locator('.club-message p').last().textContent(), 'Generated HLS late viewer is watching');
  report.normalView = await measureWindow(['source', 'relay', 'sibling', 'late']);
  report.views = [];
  // Real UI actions; report the browser fullscreen implementation separately
  // from the product's full-room CSS fallback, without fabricating fullscreen.
  for (const [label, participant] of [['source', source], ['late', late]]) {
    await participant.locator('#room-fullscreen').click();
    await participant.waitForFunction(() => (document.fullscreenElement?.id === 'watch-room' || document.querySelector('#watch-room').classList.contains('room-expanded')) && document.querySelector('#room-fullscreen').getAttribute('aria-pressed') === 'true');
    assert.equal(await participant.locator('#room-fullscreen').getAttribute('aria-pressed'), 'true');
    assert.equal(await participant.locator('#club-chat-shell').isVisible(), true);
    const fullRoom = await participant.evaluate(() => ({ native: document.fullscreenElement?.id === 'watch-room', cssFallback: document.querySelector('#watch-room').classList.contains('room-expanded') }));
    await measureWindow([label], 3);
    await participant.screenshot({ path: fileURLToPath(new URL(label + '-full-room.png', output)) });
    await participant.locator('#room-fullscreen').click();
    await participant.waitForFunction(() => !document.fullscreenElement && !document.querySelector('#watch-room').classList.contains('room-expanded') && document.querySelector('#room-fullscreen').getAttribute('aria-pressed') === 'false');
    await participant.locator('#fullscreen').click(); await participant.waitForFunction(() => document.fullscreenElement?.id === 'player');
    await measureWindow([label], 3);
    await participant.screenshot({ path: fileURLToPath(new URL(label + '-picture-only.png', output)) });
    await participant.evaluate(() => document.exitFullscreen());
    const afterView = await snapshot(participant);
    assert.equal(afterView.playback.srcChanges, baseline[label].playback.srcChanges, label + ' view changes must not replace the continuous media source');
    report.views.push({ label, fullRoom, pictureOnlyNativeFullscreen: true, mediaSourceChanges: afterView.playback.srcChanges });
  }
  await sibling.evaluate(() => PrivateCast.testing.setRelayLimit(1));
  const stallBefore = await record('before connected relay stalls media'), stallAt = Date.now();
  assert(stallBefore.late.reserveSeconds > 30, 'Late viewer has measured verified reserve before fault');
  monitorRunning = true; monitor = continuityMonitor();
  await relay.evaluate(() => PrivateCast.testing.stallOutgoing({ enabled: true }));
  await pause(5000);
  const stillConnected = await record('relay media withheld with control connection still open');
  assert.equal(stillConnected.late.supplier?.id, stallBefore.relay.nodeId, 'The injected fault initially retains the supplying control connection');
  assert(stillConnected.late.received <= stallBefore.late.received + 1, 'Fault injection actually withholds media');
  await until(async () => { const state = await snapshot(late); return state.supplier?.id && state.supplier.id !== stallBefore.relay.nodeId && state.sourceReachable && state.recovery.recoveries > stallBefore.late.recovery.recoveries && state.received > stallBefore.late.received + 2; }, 45000, 'Existing automatic recovery did not replace control-alive stalled supplier');
  const afterStall = await record('late viewer automatically replaced stalled supplier');
  assert.deepEqual(identity(afterStall.late), identity(stallBefore.late));
  report.connectedStallRecoveryMs = Date.now() - stallAt;
  await relay.evaluate(() => PrivateCast.testing.stallOutgoing({ enabled: false }));
  report.afterStall = await measureWindow(['source', 'relay', 'sibling', 'late']);
  // A real current supplier leaves. No invocation of the viewer's retry button.
  const departureSupplier = afterStall.late.supplier.id;
  const leavingLabel = Object.entries(afterStall).find(([label, state]) => label !== 'source' && state.nodeId === departureSupplier)?.[0];
  assert(leavingLabel, 'Expected a family peer to be the recovered supplier');
  const spareLabel = leavingLabel === 'sibling' ? 'relay' : 'sibling';
  await pages[spareLabel].evaluate(() => PrivateCast.testing.setRelayLimit(1));
  const leaveBefore = await snapshot(late), leaveAt = Date.now();
  await pages[leavingLabel].close();
  await until(async () => { const state = await snapshot(late); return state.supplier?.id && state.supplier.id !== departureSupplier && state.sourceReachable && state.received > leaveBefore.received + 2; }, 45000, 'Viewer did not recover after its supplying browser departed');
  const leaveAfter = await snapshot(late); assert.deepEqual(identity(leaveAfter), identity(leaveBefore)); assert.equal(leaveAfter.sourceEnded, false);
  report.abruptSupplierDepartureRecoveryMs = Date.now() - leaveAt;
  report.afterDeparture = await measureWindow(['source', spareLabel, 'late']);
  monitorRunning = false; await monitor;
  const continuity = report.samples.filter(row => row.recoveryMonitor);
  report.recoveryContinuity = {};
  for (const label of ['source', 'late']) {
    const states = continuity.map(row => row.states[label]);
    const maxFrameGapMs = Math.max(...states.map(state => state.sampledAt - state.lastFrameAt));
    assert(maxFrameGapMs < 1800, label + ' reserve must hide recovery without a multi-second video freeze');
    assert.equal(states.at(-1).stalls, states[0].stalls, label + ' must not enter a new missing-piece wait during recovery');
    assert(states.filter(state => state.rms > .001).length > states.length * .9, label + ' keeps decoded sound through recovery');
    report.recoveryContinuity[label] = { maxFrameGapMs, additionalStalls: states.at(-1).stalls - states[0].stalls, samples: states.length };
  }
  await sendChat(late, 'Generated HLS still watching after recovery');
  await source.waitForFunction(() => SameEndSocial.snapshot().chatCount > 1);
  assert.equal(await source.locator('.club-message p').last().textContent(), 'Generated HLS still watching after recovery');
  const network = await late.evaluate(() => SameEndInviteCheck.report().joining);
  assert.equal(network.connectionMode, 'direct-only'); assert.equal(network.relayFallbackConfigured, false); assert.equal(network.network.relayConfigured, false);
  assert.deepEqual(pageErrors, []); assert.deepEqual(trackerErrors, []); assert.deepEqual(mediaAttempts, []); assert.deepEqual(externalRequests, []);
  report.pass = true; await record('automatic HLS picture sound chat fullscreen late join and recovery passed');
  console.log(JSON.stringify({ pass: true, lateJoinMs: report.lateJoinMs, connectedStallRecoveryMs: report.connectedStallRecoveryMs, abruptSupplierDepartureRecoveryMs: report.abruptSupplierDepartureRecoveryMs, cloudVideoRelay: false }));
}
try { await Promise.race([run(), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('HLS room acceptance exceeded its five-minute bound')), 300000); timer.unref(); })]); }
catch (error) { report.error = sanitize(error.stack || error.message); console.error(report.error); process.exitCode = 1; await record('failure').catch(() => {}); }
finally {
  monitorRunning = false; await monitor?.catch(() => {}); report.completedAt = new Date().toISOString(); report.pageErrors = pageErrors; report.trackerErrors = trackerErrors; report.httpMediaAttempts = mediaAttempts; report.externalRequestCount = externalRequests.length;
  await writeFile(new URL('result.json', output), JSON.stringify(report, null, 2));
  await Promise.all(contexts.map(context => context.close())); await browser.close();
  for (const socket of tracker.clients) socket.terminate(); await new Promise(resolve => tracker.close(resolve)); await new Promise(resolve => server.close(resolve)); await rm(certDir, { recursive: true, force: true });
}
