/* Shorter common room start acceptance using actual signed HLS over WebRTC.
 * Build first. Examples:
 * INITIAL_DEVICE=chromium INITIAL_PROFILE=steady node tests/common-start-platform-browser.test.mjs
 * INITIAL_DEVICE=android ANDROID_CDP=http://127.0.0.1:18967 ...
 * INITIAL_DEVICE=ios ...  (open externalViewerURL, tap #initial-join)
 * Windows: BROWSER_CHANNEL=chrome|msedge; CHROME_PATH overrides channel.
 * No clock/frame fabrication or HTTP media fallback. Queue pacing is application
 * callback scheduling AFTER real P2P receipt, never physical capacity evidence.
 * Deficit runs check refusal of an accelerated start; fallback playback is reported separately.
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createApi } from '../backend/api.mjs';
import { MemoryStore } from '../backend/store.mjs';
import { initialDelayPageProbe } from './helpers/initial-delay-page.mjs';
import { createLocalTestTLS } from './helpers/local-test-tls.mjs';

const root = new URL('../', import.meta.url), rootPath = fileURLToPath(root);
const forceNative=process.env.INITIAL_NATIVE==='1',audioTee=process.env.INITIAL_AUDIO_TEE!=='0';
const device = process.env.INITIAL_DEVICE || 'chromium', profile = process.env.INITIAL_PROFILE || 'steady';
const forceFallback=process.env.INITIAL_FORCE_FALLBACK==='1',lateProfile=process.env.INITIAL_LATE_PROFILE||null;
assert(lateProfile===null||['slow','bursty','below95'].includes(lateProfile));
assert(!forceFallback||profile==='steady','Forced observation-timeout fallback uses steady media delivery');
const lateDeficit=lateProfile==='below95';
const label = process.env.INITIAL_LABEL || `${device}-${profile}-${Date.now()}`;
assert(['chromium','android','ios'].includes(device)); assert(['steady','slow','bursty','below95','below65'].includes(profile)); assert(/^[\w-]+$/.test(label));
const playbackSeconds = Number(process.env.INITIAL_PLAYBACK_SECONDS || 120);
const roomDelay = Number(process.env.INITIAL_ROOM_DELAY || 300); assert.equal(roomDelay,300,'Signed fallback remains 300 seconds');
const deficitSeconds = Number(process.env.INITIAL_DEFICIT_SECONDS || 95);
const startupSeconds = Number(process.env.INITIAL_STARTUP_SECONDS || 420);
const port = Number(process.env.INITIAL_PORT || 19036), deficit = profile.startsWith('below');
assert(playbackSeconds >= 120 && playbackSeconds <= 180); assert(deficitSeconds >= 90 && deficitSeconds <= 180); assert(startupSeconds >= 90 && startupSeconds <= 440); assert(port > 1024 && port < 65536);
const runtimeInput = process.env.SAMEEND_PLAYWRIGHT || (process.env.HOME || process.env.USERPROFILE) + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const runtimeURL = /^file:/i.test(runtimeInput) ? new URL(runtimeInput) : pathToFileURL(runtimeInput);
const { chromium } = await import(runtimeURL.href), require = createRequire(import.meta.url);
const { wsServer: WebSocketServer } = require(join(dirname(dirname(fileURLToPath(runtimeURL))), 'playwright-core/lib/utilsBundle.js'));
const output = new URL(`privatework/common-start-platform/${label}/`, root);
await mkdir(output, { recursive: true });
const originalHTML = await readFile(new URL('dist/watch.html', root), 'utf8');
await writeFile(new URL('app-under-test.html',output),originalHTML);
const localTLS = createLocalTestTLS(), runNonce=randomBytes(16).toString('hex');
await writeFile(new URL('owned-test-root-cert.pem',output),localTLS.cert);
const publicBase = JSON.parse(await readFile(new URL('public-config.json', root), 'utf8')).apiBase;
const git = (...args) => spawnSync('git', args, { cwd: rootPath, encoding: 'utf8' }).stdout?.trim() || null;
const report = { schema: 1, startedAt: new Date().toISOString(), pass: false,
  identity: { commit: git('rev-parse','HEAD'), dirtyFiles: git('status','--porcelain'), buildSHA256: createHash('sha256').update(originalHTML).digest('hex') },
  environment: { hostPlatform: process.platform, device, profile, forceFallback, lateProfile, lateDeficit, browserChannel: process.env.BROWSER_CHANNEL || 'chrome',
    realWebRTC: true, realSignedHLS: true, generatedChangingChirps: true, applicationReceiveCallbackPacing: true,
    physicalCapacityMeasurement: false, physicalDeviceAcceptance: false, autoplayOverride: false,
    testChromeSpeakerOutputMuted: true, nativeAudioAnalyserUsed: false, stalePageMetricsRejected:true,
    belowStreamScope: deficit ? 'bounded deficit/admission observation; fallback playback recorded separately; no perpetual smoothness claim' : null },
  bounds: { playbackSeconds, startupSeconds, deficitSeconds }, stages: [], samples: [], errors: [],
  tracker: { connections: 0, offers: 0, answers: 0, announces: 0 }, mediaHTTPAttempts: [], apiCleartextMedia: false };
const latest = new Map(), commands = [], contexts = [], ownedPages = [], swarms = new Map();
let origin, api, invitation, source, viewer, browser, remoteBrowser, heartbeat;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (res, value, code = 200) => res.writeHead(code, { 'content-type':'application/json', 'cache-control':'no-store' }).end(JSON.stringify(value));
const save = async () => writeFile(new URL('progress.json', output), JSON.stringify(report, null, 2));
const progress = async (stage, details = {}) => { report.stages.push({ stage, at: Date.now(), ...details }); await save(); console.log(JSON.stringify({ stage, device, profile, ...details })); };
const safeError = error => String(error?.stack || error).replace(/https?:\/\/\S*#[^\s]+/g,'[isolated invitation removed]').replace(/magnet:\S+/g,'[magnet removed]');
async function until(check, seconds, failure) {
  const stop = Date.now() + seconds * 1000;
  while (Date.now() < stop) { if (await check()) return; await sleep(250); }
  throw Error(failure);
}
async function body(req, max = 1024 * 1024) { const chunks = []; let length = 0; for await (const chunk of req) { length += chunk.length; if (length > max) throw Error('Acceptance body exceeds bound'); chunks.push(chunk); } return Buffer.concat(chunks).toString(); }
const mime = { '.js':'text/javascript', '.json':'application/json', '.webmanifest':'application/manifest+json', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const server = https.createServer(localTLS, async (req, res) => {
  try {
    const url = new URL(req.url, origin || `https://127.0.0.1:${port}`);
    if (url.pathname === '/metrics' && req.method === 'POST') {
      if(url.searchParams.get('run')!==runNonce)return json(res,{expired:true},410);
      const value = JSON.parse(await body(req)); if (!['viewer','source','downstream'].includes(url.searchParams.get('role'))) return json(res, {}, 400);
      const role=url.searchParams.get('role'),previous=latest.get(role);latest.set(role,value);if(JSON.stringify(previous?.commonStart)!==JSON.stringify(value.commonStart)){report.commonTransitions??=[];report.commonTransitions.push({role,at:Date.now(),elapsed:value.elapsed,commonStart:value.commonStart,measurement:value.clientDelivery});}if(role==='viewer'&&value.initialDelay?.state==='preparing'){report.preparationSamples??=[];report.preparationSamples.push({elapsed:value.elapsed,initialDelay:value.initialDelay,playback:value.playback,ready:value.ready,seeking:value.seeking,paused:value.paused,rawBuffered:value.rawBuffered,rawSeekable:value.rawSeekable});if(report.preparationSamples.length>80)report.preparationSamples.shift();}if(role==='viewer'&&JSON.stringify([previous?.initialDelay?.state,previous?.initialDelay?.reason])!==JSON.stringify([value.initialDelay?.state,value.initialDelay?.reason])){report.initialTransitions??=[];report.initialTransitions.push({at:Date.now(),elapsed:value.elapsed,initialDelay:value.initialDelay,measurement:value.clientDelivery,clockReady:value.clockReady,visibility:value.visibility,received:value.received});}return json(res,{ok:true});
    }
    if (url.pathname === '/commands' && url.searchParams.get('run')!==runNonce)return json(res,[{id:1000000000,type:'visibility',hidden:true}],410);
    if (url.pathname === '/commands') return json(res, commands.filter(c => c.role === (url.searchParams.get('role') || 'viewer') && c.id > Number(url.searchParams.get('after') || 0)));
    if(url.pathname==='/operator'&&req.method==='POST'){const data=JSON.parse(await body(req));if(data.type!=='audio-mute'||typeof data.muted!=='boolean')return json(res,{},400);commands.push({id:commands.length+1,role:'viewer',type:'audio-mute',muted:data.muted});return json(res,{ok:true});}
    if (url.pathname === '/status') return json(res, { device, profile, latest: Object.fromEntries(latest), stages: report.stages, pass: report.pass });
    if (url.pathname.startsWith('/api/')) {
      const raw = await body(req); if (/magnet:|video\/mp4|segment-\d|#EXTM3U/.test(raw)) report.apiCleartextMedia = true;
      const result = await api.handler({ rawPath: url.pathname.slice(4), headers: req.headers, body: raw, queryStringParameters: Object.fromEntries(url.searchParams), requestContext: { http: { method: req.method, sourceIp: 'initial-delay-owned-test' } } });
      return res.writeHead(result.statusCode, result.headers).end(result.body);
    }
    if (/\.(?:m3u8|m4s|mp4|ts)(?:$|[?#])/i.test(url.pathname) || url.pathname.startsWith('/_sameend/hls/')) {
      report.mediaHTTPAttempts.push({ path: url.pathname, at: Date.now() }); return res.writeHead(403).end('Media must arrive from authenticated peers and the local native bridge.');
    }
    if (['/','/watch.html','/viewer'].includes(url.pathname)) {
      const options = JSON.stringify({ device, profile, forceNative, runNonce, audioTee, commonStart:true, forceFallback, lateProfile }).replace(/</g,'\\u003c');
      const redirect = url.pathname === '/viewer' && invitation ? `if(!location.hash)location.hash=${JSON.stringify(new URL(invitation).hash)};` : '';
      const probe = `<script>${redirect}(${initialDelayPageProbe.toString()})(${options});</script>`;
      const html = originalHTML.replaceAll(publicBase, '/api').replace(/wss:\/\/tracker\.[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_/-]*)?/g, origin.replace('https:','wss:') + '/tracker').replace('<head>','<head>' + probe);
      return res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' }).end(html);
    }
    const file = resolve(rootPath, 'dist', '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(resolve(rootPath,'dist') + '/')) return res.writeHead(403).end();
    try { return res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control':'no-store', ...(url.pathname === '/sw.js' ? { 'service-worker-allowed':'/' } : {}) }).end(await readFile(file)); }
    catch { return res.writeHead(404).end(); }
  } catch (error) { report.errors.push(safeError(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
});
const tracker = new WebSocketServer({ server, path: '/tracker' });
const send = (socket, value) => { if (socket?.readyState === 1) socket.send(JSON.stringify(value)); };
tracker.on('connection', socket => {
  report.tracker.connections++; socket.memberships = [];
  socket.on('error', error => report.errors.push('Tracker: ' + error.name));
  socket.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString()); if (m.action !== 'announce' || typeof m.info_hash !== 'string' || typeof m.peer_id !== 'string') return;
      report.tracker.announces++; let swarm = swarms.get(m.info_hash); if (!swarm) { swarm = new Map(); swarms.set(m.info_hash, swarm); }
      if (m.event === 'stopped') { swarm.delete(m.peer_id); return; }
      swarm.set(m.peer_id, socket); socket.memberships.push([m.info_hash,m.peer_id]);
      if (m.answer && m.to_peer_id) { report.tracker.answers++; send(swarm.get(m.to_peer_id), { action:'announce', info_hash:m.info_hash, peer_id:m.peer_id, offer_id:m.offer_id, answer:m.answer }); return; }
      send(socket, { action:'announce', info_hash:m.info_hash, interval:2, complete:1, incomplete:Math.max(0,swarm.size-1) });
      const peers = [...swarm].filter(([id, peer]) => id !== m.peer_id && peer.readyState === 1);
      for (let i = 0; i < Math.min(peers.length,m.offers?.length || 0); i++) { const offer = m.offers[i]; report.tracker.offers++; send(peers[i][1], { action:'announce', info_hash:m.info_hash, peer_id:m.peer_id, offer_id:offer.offer_id, offer:offer.offer }); }
    } catch { report.errors.push('Malformed tracker message'); }
  });
  socket.on('close', () => { for (const [hash,id] of socket.memberships) { const swarm = swarms.get(hash); if (swarm?.get(id) === socket) swarm.delete(id); if (!swarm?.size) swarms.delete(hash); } });
});
await new Promise((ok, fail) => { server.once('error',fail); server.listen(port,'127.0.0.1',ok); });
origin = `https://127.0.0.1:${port}`;
api = createApi({ store: new MemoryStore(), push: { enabled: false }, allowedOrigins: [origin, origin.replace('127.0.0.1','localhost')] });
async function newLocalPage(role, url) {
  const context = await browser.newContext({ ignoreHTTPSErrors:true, serviceWorkers: role === 'source' ? 'block' : 'allow', viewport:{ width:1280,height:900 } }); contexts.push(context);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); ownedPages.push(page); await openPage(page, url || `${origin}/?testRole=${role}`); return page;
}
async function openPage(page, url) {
  page.on('pageerror', error => report.errors.push(safeError(error)));
  await page.goto(url); await page.waitForFunction(() => window.PrivateCast?.testing && window.SameEndSocial?.snapshot().ready);
  await page.locator('#name').evaluate((input, value) => { input.value = value; }, 'Initial delay owned test');
}
const current = role => latest.get(role);
const identity = state => state?.config;
const command = (role, type, values = {}) => commands.push({ id: commands.length + 1, role, type, ...values });
async function assertChat(stage) {
  const text = 'initial-delay-chat-' + Date.now(), at = Date.now(); command('viewer','chat',{text});
  await until(() => current('source')?.probe.chatReceipts.some(r => r.text === text), 12, 'Encrypted chat failed during ' + stage);
  const latencyMs = current('source').probe.chatReceipts.find(r => r.text === text).at - at;
  assert(latencyMs < 4000, 'Chat remains immediate while media callbacks are queued');
  report.chat ??= []; report.chat.push({ stage, latencyMs });
}
const validateBaseline = state => {
  assert.equal(state.config.delay,300);
  assert.equal(state.config.commonStartVersion,1);
  assert.deepEqual(identity(state), identity(current('source')), 'Signed room/source/programme identity is unchanged');
  assert(state.cacheBytes <= 192 * 1024 * 1024, 'Signed cache remains within hard bound');
  if(deficit){assert.equal(state.initialDelay?.applied,false,'Deficit never applies accelerated local startup');assert.equal(state.initialDelay?.commitCount,0,'Deficit never commits accelerated local startup');const host=current('source');if(state.commonStart?.decisionId&&host?.commonStart?.decisionId)assert.equal(state.commonStart.decisionId,host.commonStart.decisionId,'Deficit source and viewer share the signed fallback decision');}
  assert(Number.isFinite(state.signedTarget),'Signed fallback target is observable');
  assert(Math.abs(state.signedTarget-(state.elapsed-300))<1.5,'Signed fallback clock mapping remains 300 seconds');
  if(['selected','fallback'].includes(state.commonStart?.state)){
    const delay=state.commonStart.delaySeconds;
    if(deficit||forceFallback){assert.equal(state.commonStart.state,'fallback');assert.equal(delay,300);if(forceFallback)assert.equal(state.commonStart.reason,'observation-timeout');}
    else assert(Number.isFinite(delay)&&delay>0&&delay<300,'Actual selected common delay is shorter than fallback');
    assert(state.commonStart.decisionId,'Common selection has a decision identity');
    assert(Math.abs(state.sharedTarget-(state.elapsed-delay))<1.5,'Shared target follows selected common clock');
    assert(Math.abs(state.target-state.sharedTarget)<1.5,'Nominal UI target follows selected common clock');
  }

};
try {
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath:process.env.CHROME_PATH } : { channel:process.env.BROWSER_CHANNEL || 'chrome' }), headless:process.env.INITIAL_HEADED !== '1',
    args:['--mute-audio','--ignore-certificate-errors','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-features=WebRtcHideLocalIpsWithMdns'] });
  source = await newLocalPage('source');
  await source.evaluate(delay => { const b = document.createElement('button'); b.id = 'start-initial-source'; b.textContent = 'Start generated HLS'; b.onclick = () => window.initialSourceStart = PrivateCast.testing.startDemo({ delay:delay,profile:'hls' }); document.body.append(b); }, roomDelay);
  await source.locator('#start-initial-source').click(); await source.evaluate(() => initialSourceStart);
  await source.locator('#initial-join').click();
  await source.evaluate(() => PrivateCast.testing.setRelayLimit(1)); await source.locator('#make-magnet').click();
  await source.waitForFunction(() => { const value=document.querySelector('#browser-invitation').value; if(!value)return false; const q=new URLSearchParams(new URL(value).hash.slice(1)); return q.has('club')&&q.get('watch')==='1'&&!q.has('owner'); }, null, { timeout:45000 });
  invitation = await source.locator('#browser-invitation').inputValue();
  const invite = new URL(invitation); invite.searchParams.set('testRole','viewer');
  await progress('source-started', { server:origin, externalViewerURL:`${origin}/viewer?testRole=viewer`, sourceDelay:roomDelay, evidenceDirectory:fileURLToPath(output), testCertificate:fileURLToPath(new URL('owned-test-root-cert.pem',output)) });
  if (device === 'android') {
    remoteBrowser = await chromium.connectOverCDP(process.env.ANDROID_CDP || 'http://127.0.0.1:18967');
    const context = remoteBrowser.contexts()[0]; assert(context, 'Android CDP has an existing owned test context');
    viewer = await context.newPage(); ownedPages.push(viewer);
    const session = await context.newCDPSession(viewer); await session.send('Security.setIgnoreCertificateErrors',{ignore:true});
    await openPage(viewer, invite.href);
  } else if (device === 'chromium') viewer = await newLocalPage('viewer', invite.href);
  await progress('waiting-for-viewer-connection-and-trusted-sound-gesture');
  await until(() => current('viewer')?.clockReady && current('viewer')?.received >= 2 && current('viewer')?.supplier && current('viewer')?.chatConnected, device === 'ios' ? 150 : 65, 'Viewer did not attach signed media, source clock and encrypted chat');
  if (viewer) await viewer.locator('#initial-join').click();
  command('viewer','relay',{limit:1});
  await until(() => current('viewer')?.probe.gestureCount >= 1, device === 'ios' ? 90 : 15, 'Trusted sound gesture was not observed');
  report.environment.actualViewerUserAgent = current('viewer').userAgent;
  if (device === 'android') assert(/Android/.test(current('viewer').userAgent), 'Android acceptance must run in Android Chrome');
  if (device === 'ios') assert(/iPhone|iPad|Macintosh/.test(current('viewer').userAgent) && /Safari/.test(current('viewer').userAgent), 'External native acceptance requires Safari');
  assert.equal(current('viewer').secureContext,true, 'Loopback page is a secure context');
  assert.equal(current('viewer').commonStart?.enabled,true, 'Test-server-only common startup switch is active');
  await assertChat('startup');
  const collect = () => {
    const state = current('viewer'); if (!state) return;
    report.samples.push({ ...state, source:current('source'), downstream:current('downstream') });
  };
  heartbeat = setInterval(() => { collect(); save().catch(() => {}); }, 2000);
  if (deficit) {
    await progress('below-stream-admission-observation', { seconds:deficitSeconds, ratio:profile === 'below95' ? .95 : .65 });
    const began = Date.now();
    while (Date.now() - began < deficitSeconds * 1000) {
      const s = current('viewer'); validateBaseline(s);
      assert.notEqual(s.commonStart?.state,'selected','Below-stream observation must not authorize a shorter common start');
      assert.equal(current('source')?.commonStart?.state==='selected',false,'Source must not accelerate a deficit room');
      if(s.probe.frames>0&&s.probe.firstFrame)assert(s.probe.firstFrame.sourceAge>=297,'Deficit never starts ahead of signed fallback');
      await sleep(1000);
    }
    const s = current('viewer');
    assert(s.probe.verified.length >= 8 && s.probe.connectedPeers > 0, 'Deficit uses multiple actually verified P2P media pieces');
    assert(s.probe.queuedBytes > 0, 'Sustained deficit accumulates actual received callback bytes');
    assert(s.elapsed < roomDelay+deficitSeconds+40,'Deficit observation stays bounded');
    assert(s.clientDelivery?.state === 'constrained' || s.clientDelivery?.recommendation?.status === 'insufficient-throughput' || /throughput|deficit|constrain/i.test(s.commonStart?.reason || s.initialDelay?.reason || ''), 'Actual below-stream observations refuse a throughput-fixing recommendation');
    await assertChat('sustained-deficit');
    report.admission = { observedSeconds:deficitSeconds, commonStart:s.commonStart, initialDelay:s.initialDelay, delivery:s.clientDelivery, verifiedPieces:s.probe.verified.length, queuedBytes:s.probe.queuedBytes, fallbackPlaybackObserved:s.probe.frames>0,continuousFallbackAcceptanceClaimed:false };
  } else {
    const playing=role=>{const s=current(role);return s?.probe.frames>12&&!s.paused&&s.ready>=2&&Number.isFinite(s.programTime)};
    await progress('waiting-for-actual-common-start',{timeoutSeconds:startupSeconds});
    await until(()=>{
      for(const role of ['source','viewer'])if(!forceFallback&&current(role)?.commonStart?.state==='fallback')throw Error(role+' common start fell back: '+current(role).commonStart.reason);
      return playing('source')&&playing('viewer');
    },startupSeconds,'Host and viewer did not decode actual moving HLS pictures');
    const first=current('viewer');validateBaseline(first);
    const common=first.commonStart.delaySeconds,decisionId=first.commonStart.decisionId;
    const expectedCommonState=forceFallback?'fallback':'selected';
    assert.equal(first.commonStart.state,expectedCommonState);
    if(forceFallback)assert(first.probe.withheldFeedbackHellos>0,'Real viewer hellos withheld measurements only');
    const validateCommon=(role,requirePicture=true)=>{
      const s=current(role);assert(Date.now()-s.at<2500,role+' metrics are current');validateBaseline(s);
      assert.equal(s.commonStart.state,expectedCommonState,role+' retains selected common start');
      assert.equal(s.commonStart.decisionId,decisionId,role+' shares latched session decision');
      assert.equal(s.commonStart.delaySeconds,common,role+' retains common delay');
      if(requirePicture){assert(s.probe.firstFrame?.commonStart?.state===expectedCommonState,role+' selection precedes first advancing picture');
      assert.equal(s.probe.firstFrame.commonStart.decisionId,decisionId);
      assert(s.probe.firstFrame.sourceAge>=common-3&&s.probe.firstFrame.sourceAge<=common+72,role+' actual first picture is within bounded local extra');}
      return s;
    };
    validateCommon('source');validateCommon('viewer');
    if(device==='ios'&&forceNative){assert.equal(first.mode,'hls-native');assert.equal(first.serviceWorkerControlled,true);}
    else if(device==='ios')assert(['hls','hls-native'].includes(first.mode));else assert.equal(first.mode,'hls');
    report.startup={commonStart:first.commonStart,firstFrame:first.probe.firstFrame,hostFirstFrame:current('source').probe.firstFrame,firstPlaybackMode:first.mode,signedFallbackSeconds:300};
    await progress('common-start-actually-playing',{commonDelaySeconds:common,decisionId,observedSourceAgeSeconds:first.probe.firstFrame.sourceAge,mode:first.mode});
    const downstreamURL=new URL(invitation);downstreamURL.searchParams.set('testRole','downstream');
    const downstream=await newLocalPage('downstream',downstreamURL.href);
    await until(()=>current('downstream')?.clockReady&&current('downstream')?.received>2&&current('downstream')?.supplier,60,'Late viewer did not receive actual signed pieces');
    await downstream.locator('#initial-join').click();
    if(!lateDeficit)await until(()=>playing('downstream'),90,'Late viewer did not decode actual moving HLS pictures');
    else await until(()=>current('downstream')?.commonStart?.decisionId===decisionId,20,'Deficit late viewer did not inherit common decision');
    validateCommon('downstream',!lateDeficit);
    report.downstream={commonStart:current('downstream').commonStart,firstFrame:current('downstream').probe.firstFrame,config:current('downstream').config,decodingClaimed:!lateDeficit,profile:lateProfile||'unpaced',purpose:lateDeficit?'bounded late deficit observation; no continuous playback claim':lateProfile?'late bounded device; original room decision fixed':'late join; original room decision fixed'};
    const roles=lateDeficit?['source','viewer']:['source','viewer','downstream'],stableStart=Date.now(),before=Object.fromEntries(roles.map(role=>[role,current(role)])),stable=Object.fromEntries(roles.map(role=>[role,[]]));let maxGroupSeparation=0,maxSourceMainSeparation=0;
    await progress('continuous-common-playback',{durationSeconds:playbackSeconds,roles});
    while(Date.now()-stableStart<playbackSeconds*1000){
      for(const role of roles){
        const s=validateCommon(role);stable[role].push(s);
        assert.equal(s.paused,false,role+' remains playing');assert(s.ready>=2,role+' decoder stays ready');
        assert(s.sourceAge>=common-3&&s.sourceAge<=common+61,role+' actual delay stays within common plus bounded extra');
        assert(Date.now()-s.probe.lastFrameAt<2500,role+' has no unexpected decoded-frame gap');
        assert.equal(s.stalls,before[role].stalls,role+' has no post-start rebuffer');
        const sourceMainSeparation=Math.abs(current('source').programTime-current('viewer').programTime);maxSourceMainSeparation=Math.max(maxSourceMainSeparation,sourceMainSeparation);assert(sourceMainSeparation<=8,'Actual source/main viewer separation stays within8 seconds');
        const positions=roles.map(r=>current(r).programTime),separation=Math.max(...positions)-Math.min(...positions);maxGroupSeparation=Math.max(maxGroupSeparation,separation);assert(separation<=10,'Actual healthy group separation stays within10 seconds');
      }
      if(lateDeficit){const late=validateCommon('downstream',false);if(Number.isFinite(late.programTime)&&late.probe.frames>0)assert(Math.abs(current('source').programTime-late.programTime)<=61,'Late deficit decoded position remains within bounded extra');}
      await sleep(500);
    }
    if(lateDeficit){const late=current('downstream');assert(late.probe.verified.length>=8,'Late deficit uses verified media');report.lateAdmission={observedSeconds:(Date.now()-stableStart)/1000,commonStart:late.commonStart,clientDelivery:late.clientDelivery,queuedBytes:late.probe.queuedBytes,verifiedPieces:late.probe.verified.length,continuousPlaybackClaimed:false};}
    report.continuity={measuredSeconds:(Date.now()-stableStart)/1000,commonDelaySeconds:common,signedFallbackSeconds:300,decisionId,maxGroupSeparationSeconds:maxGroupSeparation,maxSourceMainSeparationSeconds:maxSourceMainSeparation,acceptanceBounds:{sourceMainGapSeconds:8,healthyGroupGapSeconds:10,lateDeficitGapSeconds:61},roles:{}};
    report.audio={};
    for(const role of roles){
      const end=current(role),start=before[role],rows=stable[role],wall=(end.at-start.at)/1000;
      const mediaWallRatio=(end.programTime-start.programTime)/wall,elementWallRatio=(end.currentTime-start.currentTime)/wall;
      const presentedWallRatio=(end.probe.presentedFrameTime-start.probe.presentedFrameTime)/wall;
      assert(mediaWallRatio>=.95&&mediaWallRatio<=1.05,role+' program advances at normal media speed');
      assert(elementWallRatio>=.95&&elementWallRatio<=1.05,role+' media element advances at normal speed');
      assert(presentedWallRatio>=.95&&presentedWallRatio<=1.05,role+' actual presented frames advance at normal speed');
      const addedSeeks=end.probe.seeks.filter(e=>e.at>stableStart+2000);
      const stableEnd=Date.now(),gaps=rows.flatMap(row=>row.probe.recentFrameGaps||[]).filter(gap=>gap.fromAt>=stableStart&&gap.at<=stableEnd),stableMaxFrameGapMs=gaps.length?Math.max(...gaps.map(gap=>gap.ms)):null;
      assert(stableMaxFrameGapMs!==null&&stableMaxFrameGapMs<2500,role+' actual stable cadence has no gap over2.5 seconds');
      assert(end.probe.frames-start.probe.frames>playbackSeconds*8,role+' real moving frames advance throughout interval');
      assert(addedSeeks.length<=2,role+' has no repeated post-start seeking');
      report.continuity.roles[role]={mediaWallRatio,elementWallRatio,presentedWallRatio,decodedFrameCallbacks:end.probe.frames-start.probe.frames,maxFrameGapMs:stableMaxFrameGapMs,stableMaxFrameGapMs,lifetimeMaxFrameGapMs:end.probe.maxFrameGapMs,frameGapScope:'Only callbacks with both ends inside measured continuity interval',addedSeeks:addedSeeks.length,stallsBefore:start.stalls,stallsAfter:end.stalls,finalSourceAgeSeconds:end.sourceAge};
      if(role==='viewer'&&device==='ios')report.audio[role]={route:'unchanged native output',result:'requires separate owned-process capture by operator',analyserUsed:false};
      else{
        const audio=rows.filter(s=>s.rms>.001&&!s.muted&&s.audioContextState==='running');
        assert(audio.length>=rows.length*.9,role+' actual decoded chirps remain present');
        assert(Math.max(...audio.map(s=>s.peakFrequency))-Math.min(...audio.map(s=>s.peakFrequency))>400,role+' measured sound contains changing chirps');
        report.audio[role]={route:audioTee?'owned capture-stream tee analyser':'owned media-element analyser',positiveSamples:audio.length,totalSamples:rows.length,audibleSpeakerClaim:false};
      }
    }
    await assertChat('continuous-common-playback');
    // The late viewer also sends encrypted chat while sharing the selected clock.
    const lateText='initial-delay-chat-late-'+Date.now(),lateAt=Date.now();command('downstream','chat',{text:lateText});
    await until(()=>current('source')?.probe.chatReceipts.some(r=>r.text===lateText),12,'Late viewer encrypted chat failed');
    const lateLatency=current('source').probe.chatReceipts.find(r=>r.text===lateText).at-lateAt;assert(lateLatency<4000);report.chat.push({stage:'late-viewer',latencyMs:lateLatency});
    command('viewer','visibility',{hidden:true}); await sleep(1500);
    command('viewer','visibility',{hidden:false}); await sleep(2500);
    command('viewer','visibility-restore');await sleep(600);
    const resumed = current('viewer');
    assert.equal(resumed.waitingOverlayHidden,true,'Returning after first picture keeps startup buffering explanation hidden');
    report.supplementalVisibility = { syntheticOwnedDocumentEvent:true, physicalBackgroundAcceptance:false, waitingOverlayHidden:resumed.waitingOverlayHidden, recoveryState:resumed.playback?.adaptivePhase, lastFrameAt:resumed.probe.lastFrameAt };
    if (viewer) await viewer.screenshot({ path:fileURLToPath(new URL('viewer-final.png',output)) });
    await downstream.close();
  }
  report.acceptanceScope={commonStart:!deficit,deficitObservation:deficit,physicalDeviceAcceptance:false,forcedFallback:forceFallback,lateProfile,lateDeficitContinuousPlaybackClaimed:false,nativeViewerSoundSeparatelyRequired:device==='ios',continuousNativeViewerSoundClaimed:false};
  assert.equal(report.apiCleartextMedia,false); assert.equal(report.mediaHTTPAttempts.length,0, 'HTTP never supplies programme media');
  assert(report.tracker.offers > 0 && report.tracker.answers > 0, 'Local discovery completes actual WebRTC offer/answer');
  for(const role of (deficit?['source','viewer']:['source','viewer','downstream'])){assert.equal(current(role).probe.errors.length,0,role+' has no page/runtime errors');assert.equal(current(role).probe.commandErrors.length,0,role+' has no command errors');}
  report.pass = true; await progress(deficit ? 'admission-pass-no-accelerated-start' : 'actual-recommended-playback-pass');
} catch (error) {
  report.error = safeError(error); await progress('failed', { error:report.error });
  for (const [i,page] of ownedPages.entries()) if (!page.isClosed()) await page.screenshot({ path:fileURLToPath(new URL(`failure-${i}.png`,output)) }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  report.finalStates=Object.fromEntries(latest);
  for(const role of ['source','viewer','downstream'])command(role,'end-test');await sleep(800); report.finishedAt = new Date().toISOString();
  for (const page of ownedPages) await page.close().catch(() => {});
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  // In Playwright's connectOverCDP path close disconnects its transport; it does
  // not send Chromium Browser.close. Only pages we created above are closed.
  await remoteBrowser?.close().catch(() => {});
  for (const socket of tracker.clients) socket.terminate();
  tracker.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r));
  await writeFile(new URL('report.json',output),JSON.stringify(report,null,2)); await save();
  console.log(JSON.stringify({ result:report.pass ? 'pass' : 'fail', report:fileURLToPath(new URL('report.json',output)), audio:report.audio, error:report.error }));
}
