/* Native HLS uses the same verified page cache as hls.js. Only the local worker
 * capability URL is exposed to the media element; no room credential is a URL. */
import { VerifiedHlsCache, HLS_BASE } from './hls-player.js';
import { decodeBundle } from './hls-protocol.js';
import { HLS_NAMESPACE, HLS_BRIDGE_VERSION, MAX_RESPONSE_BYTES, validResource, byteRange, boundCapability } from './hls-sw-handler.js';
export function canPlayNative(video) {
  if (typeof window === 'undefined' || !window.isSecureContext || !navigator.serviceWorker || !window.MessageChannel || !window.crypto?.getRandomValues || !window.crypto?.subtle?.digest) return false;
  const element = video || document.createElement('video');
  return !!(element.canPlayType('application/vnd.apple.mpegurl') || element.canPlayType('application/x-mpegURL'));
}
export function cacheResponse(cache, path, range = null, method = 'GET') {
  if (!validResource(path) || !['GET', 'HEAD'].includes(method)) return { status: 404 };
  const bytes = cache.read(HLS_BASE + path, true); if (!bytes) return null;
  const total = bytes.byteLength; if (!total || total > MAX_RESPONSE_BYTES) return { status: 503 };
  const file = cache.files.get(path), mime = path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.mime;
  let selected; try { selected = byteRange(range, total); } catch { return { status: 416, total, mime, bytes: new ArrayBuffer(0) }; }
  return { status: selected ? 206 : 200, total, mime, bytes: method === 'HEAD' ? new ArrayBuffer(0) : selected ? bytes.slice(selected.start, selected.end + 1) : bytes };
}
function rpc(worker, message, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel(); const timer = setTimeout(() => finish(Error('The private HLS bridge did not respond.')), timeout);
    function finish(error, data) { clearTimeout(timer); channel.port1.close(); error ? reject(error) : resolve(data); }
    channel.port1.onmessage = e => finish(null, e.data); channel.port1.onmessageerror = () => finish(Error('Invalid HLS bridge reply.'));
    try { worker.postMessage(message, [channel.port2]); } catch (error) { finish(error); }
  });
}
function workerState(worker, states, timeout = 10000) {
  if (states.includes(worker.state)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); worker.removeEventListener('statechange', changed); error ? reject(error) : resolve(); };
    const changed = () => { if (states.includes(worker.state)) finish(); else if (worker.state === 'redundant') finish(Error('The private playback update was replaced. Reopen Same End.')); };
    const timer = setTimeout(() => finish(Error('The private playback update did not finish. Reopen Same End.')), timeout);
    worker.addEventListener('statechange', changed); changed();
  });
}
export class NativePlayer {
  constructor(video, config = {}, { onError = () => {}, onMode = () => {} } = {}) {
    if (!canPlayNative(video)) throw Error('This browser cannot play this HLS room.');
    this.video = video; this.config = config; this.onError = onError; this.mode = 'hls-native'; this.closed = false; this.cache = new VerifiedHlsCache({ maxBytes: 32 * 1024 * 1024, retainSeconds: 60 });
    this.token = null; this.seed = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
    this.target = null; this.origin = null; this.initialProgrammeStart = null; this.seekCount = 0; this.syncSeekRequests = 0; this.lastSeek = -Infinity; this.srcChanges = 0; this.errors = 0; this.presented = null; this.frameRequest = null; this.blocked = false; this.soundBlocked = false; this.soundRequested = false; this.lastPlayError = null; this.pending = new Set();
    video.setAttribute('playsinline', ''); video.autoplay = false; video.disableRemotePlayback = true; video.preload = 'auto';
    this.onMessage = event => {
      const data = event.data, port = event.ports?.[0];
      if (this.closed || !port || event.source !== navigator.serviceWorker.controller || data?.token !== this.token || !this.token) return;
      this.worker = event.source;
      if (data.type === 'sameend:hls:recover') { port.postMessage({ ok: true, seed: this.seed }); port.close(); return; }
      if (data.type !== 'sameend:hls:read' || !validResource(data.path)) return;
      let done = false, timer;
      const deliver = () => {
        if (done) return;
        let result; try { result = this.closed ? { status: 410 } : cacheResponse(this.cache, data.path, data.range, data.method); } catch { result = { status: 503 }; }
        if (!result) return;
        if ((result.status === 200 || result.status === 206) && data.path.endsWith('.m3u8') && this.initialProgrammeStart === null) {
          const source = this.cache.manifest(data.path), list = this.cache.playlists.get(data.path);
          if (list?.segments.length && source) {
            const selected = list.segments.find(s => source.split('\n').includes(s.path.slice(data.path.lastIndexOf('/') + 1)));
            if (selected) this.initialProgrammeStart = this.cache.timeline.get(selected.path)?.start ?? null;
          }
        }
        done = true; clearTimeout(timer); this.cache.listeners.delete(deliver); this.pending.delete(cancel);
        try { port.postMessage(result, result.bytes ? [result.bytes] : []); } finally { port.close(); }
      };
      const cancel = () => { if (done) return; done = true; clearTimeout(timer); this.cache.listeners.delete(deliver); this.pending.delete(cancel); try { port.postMessage({ status: this.closed ? 410 : 503 }); } finally { port.close(); } };
      this.pending.add(cancel); this.cache.listeners.add(deliver); timer = setTimeout(cancel, 10000); deliver();
    };
    navigator.serviceWorker.addEventListener('message', this.onMessage);
    this.onSeeking = () => { this.seekCount++; this.presented = null; };
    this.onMetadata = () => this.mapTimeline();
    this.onMediaError = () => { if (!this.closed) { this.errors++; onError('This device could not play the verified HLS picture.'); } };
    video.addEventListener('seeking', this.onSeeking); video.addEventListener('loadedmetadata', this.onMetadata); video.addEventListener('progress', this.onMetadata); video.addEventListener('error', this.onMediaError);
    if (video.requestVideoFrameCallback) { const frame = (_now, meta) => { if (this.closed) return; this.presented = { time: meta.mediaTime, at: performance.now() }; this.frameRequest = video.requestVideoFrameCallback(frame); }; this.frameRequest = video.requestVideoFrameCallback(frame); }
    this.ready = this.connect().then(() => this.start()).catch(error => { if (!this.closed) { this.errors++; onError(error.message); } });
    onMode(this.mode);
  }
  async connect() {
    const sw = navigator.serviceWorker, base = new URL('./', location.href);
    const registration = await sw.register(new URL('sw.js', base).href, { scope: base.pathname, updateViaCache: 'none' });
    const ready = await Promise.race([sw.ready, new Promise((_, reject) => { this.readyTimer = setTimeout(() => reject(Error('Private playback setup timed out. Reopen this page when the app update is ready.')), 10000); })]); clearTimeout(this.readyTimer);
    if (this.closed) return;
    this.worker = ready.active || registration.active; if (!this.worker) throw Error('Private playback setup is unavailable.');
    const claim = async worker => {
      const answer = await rpc(worker, { type: 'sameend:hls:claim' }, 1500);
      if (!answer?.ok || answer.version !== HLS_BRIDGE_VERSION || typeof answer.clientId !== 'string') throw Error('Private playback needs the app update.');
      return answer;
    };
    let claimed;
    try { claimed = await claim(this.worker); }
    catch (error) {
      if (this.closed) return;
      // The ordinary shell updater can defer activation while a room is
      // joining. A first native join must explicitly finish its bridge update
      // before attaching any media; it never reloads the page.
      if (this.started) throw error;
      let next = registration.waiting || registration.installing;
      if (!next) { await registration.update(); next = registration.waiting || registration.installing; }
      if (!next) throw Error('Reopen Same End to finish its private playback update.');
      await workerState(next, ['installed', 'activated']);
      if (this.closed) return;
      if (next.state !== 'activated') { next.postMessage({ type: 'ACTIVATE_UPDATE' }); await workerState(next, ['activated']); }
      this.worker = next;
      claimed = await claim(this.worker);
    }
    if (sw.controller !== this.worker) {
      await new Promise((resolve, reject) => { const changed = () => { if (sw.controller === this.worker) { clearTimeout(timer); sw.removeEventListener('controllerchange', changed); resolve(); } }; const timer = setTimeout(() => { sw.removeEventListener('controllerchange', changed); reject(Error('Private playback setup could not take control. Reopen this page.')); }, 5000); sw.addEventListener('controllerchange', changed); changed(); });
    }
    this.worker = sw.controller;
    if (this.closed) return;
    this.token = await boundCapability(claimed.clientId, this.seed);
    if (this.closed) return;
    const opened = await rpc(this.worker, { type: 'sameend:hls:open', token: this.token, seed: this.seed });
    if (!opened?.ok || opened.version !== HLS_BRIDGE_VERSION) throw Error('Private playback session could not open.');
    if (this.closed) { this.worker.postMessage({ type: 'sameend:hls:close', token: this.token, seed: this.seed }); return; }
    this.bridgeReady = true; this.keepAlive = setInterval(() => this.touch(), 20000);
    this.sourceBase = new URL(HLS_NAMESPACE + this.token + '/', base).href;
  }
  touch() { if (this.closed || !this.token) return; this.worker = navigator.serviceWorker.controller || this.worker; this.worker?.postMessage({ type: 'sameend:hls:touch', token: this.token, seed: this.seed }); }
  enqueue(piece, epoch) { if (this.closed) return; try { this.cache.add(decodeBundle(piece.buf), { epoch, start: (piece.meta.start - epoch) / 1000, duration: piece.meta.duration / 1000 }); this.start(); } catch (error) { this.onError('The verified HLS media was invalid: ' + error.message); } }
  start() { if (this.closed || this.started || !this.bridgeReady || this.target === null || this.target < 0 || this.suspended || !this.cache.files.has('master.m3u8')) return; this.started = true; this.srcChanges++; this.video.src = this.sourceBase + 'master.m3u8'; this.video.load(); }
  mapTimeline() { if (this.origin === null && this.initialProgrammeStart !== null && this.video.seekable.length) this.origin = this.initialProgrammeStart - this.video.seekable.start(0); }
  setPlaybackWindow(target, hidden = false) { if (!Number.isFinite(target) || this.closed) return; this.target = target; this.cache.target = Math.max(0, target); if (this.suspended && !hidden) this.touch(); this.suspended = hidden; if (hidden || target < 0) this.video.pause(); else this.start(); for (const listener of this.cache.listeners) listener(); }
  lookAheadSeconds() { return 16; }
  mediaTime() { const p = this.presented; return p && !this.video.paused && performance.now() - p.at < 250 ? p.time : this.video.currentTime; }
  sync(target) {
    this.setPlaybackWindow(target, false); this.mapTimeline(); const v = this.video;
    if (target < 0 || this.origin === null) { v.pause(); return { waiting: true, drift: null }; }
    const local = target - this.origin; let inRange = false;
    for (let i = 0; i < v.buffered.length; i++) if (local >= v.buffered.start(i) && local < v.buffered.end(i)) inRange = true;
    if (!inRange || v.readyState < 2) { v.pause(); return { waiting: true, drift: null }; }
    const drift = local - this.mediaTime(), now = performance.now();
    if (Math.abs(drift) > .8 && !v.seeking && now - this.lastSeek > 2500) { this.lastSeek = now; this.syncSeekRequests++; this.presented = null; v.currentTime = local; }
    // Native Apple audio stalls under fractional rate correction. Keep the
    // ordinary media clock and reserve seeking for material clock errors.
    if (v.playbackRate !== 1) v.playbackRate = 1;
    this.play().catch(() => {}); return { waiting: false, drift, playing: !v.paused };
  }
  programTime() { this.mapTimeline(); return this.closed || this.origin === null || this.video.readyState < 2 ? null : this.origin + this.mediaTime(); }
  requestSound() { this.soundRequested = true; this.video.muted = false; return this.play(); }
  muteSound() { this.soundRequested = true; this.soundBlocked = false; this.video.muted = true; }
  play() { if (this.closed || this.suspended || this.target === null || this.target < 0) return Promise.resolve(); const audible = !this.video.muted; if (!this.video.paused) return Promise.resolve(); return Promise.resolve(this.video.play()).then(() => { this.blocked = false; this.lastPlayError = null; if (audible && !this.video.muted) this.soundBlocked = false; }, error => { this.lastPlayError = error.name; if (error.name === 'NotAllowedError') { this.blocked = true; if (audible) { this.soundBlocked = true; this.video.muted = true; Promise.resolve(this.video.play()).catch(() => {}); } } throw error; }); }
  facts() {
    const v = this.video, quality = v.getVideoPlaybackQuality?.(); let ahead = 0, buffered = 0;
    for (let i = 0; i < v.buffered.length; i++) { buffered += v.buffered.end(i) - v.buffered.start(i); if (v.currentTime >= v.buffered.start(i) && v.currentTime < v.buffered.end(i)) ahead = v.buffered.end(i) - v.currentTime; }
    return { mode: this.mode, nativeProgramOriginSeconds: this.origin, initialProgrammeStart: this.initialProgrammeStart, mediaElementTime: v.currentTime, presentedFrameTime: this.presented?.time ?? null, srcChanges: this.srcChanges, seekCount: this.seekCount, syncSeekRequests: this.syncSeekRequests, decodedFrames: quality?.totalVideoFrames ?? v.webkitDecodedFrameCount ?? null, droppedFrames: quality?.droppedVideoFrames ?? v.webkitDroppedFrameCount ?? null, decoderBufferedSeconds: buffered, playableAheadSeconds: ahead, cacheBytes: this.cache.bytes, cacheFiles: this.cache.files.size, muted: v.muted, soundBlocked: this.soundBlocked, soundRequested: this.soundRequested, playError: this.lastPlayError, width: v.videoWidth, height: v.videoHeight, errorCount: this.errors };
  }
  close() { if (this.closed) return; this.closed = true; clearTimeout(this.readyTimer); clearInterval(this.keepAlive); if (this.frameRequest !== null) this.video.cancelVideoFrameCallback?.(this.frameRequest); navigator.serviceWorker.removeEventListener('message', this.onMessage); this.worker?.postMessage({ type: 'sameend:hls:close', token: this.token, seed: this.seed }); for (const cancel of this.pending) cancel(); for (const [type, fn] of [['seeking', this.onSeeking], ['loadedmetadata', this.onMetadata], ['progress', this.onMetadata], ['error', this.onMediaError]]) this.video.removeEventListener(type, fn); this.cache.clear(); this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
}
export { NativePlayer as Player };
