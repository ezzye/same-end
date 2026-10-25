/* Standard HLS playback. Only authenticated peer bytes enter this cache.
 * hls.js is pinned and bundled at build time; this loader has no network route. */
import Hls from 'hls.js';
import { decodeBundle } from './hls-protocol.js';

export const HLS_BASE = 'https://sameend.invalid/hls/';
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();
const MAX_FILE = 32 * 1024 * 1024;
export function safePath(path) {
  if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) || path.includes('//') || path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid HLS cache path');
  return path;
}
export function cachePath(url) {
  if (typeof url !== 'string' || !url.startsWith(HLS_BASE)) throw Error('HLS network access is disabled');
  return safePath(url.slice(HLS_BASE.length));
}
function resolvePath(uri, path) {
  safePath(uri);
  return safePath(path.slice(0, path.lastIndexOf('/') + 1) + uri);
}
function inspectManifest(source, path) {
  if (source.length > 1024 * 1024 || !source.startsWith('#EXTM3U')) throw Error('Invalid HLS playlist');
  const lines = source.replace(/\r/g, '').split('\n'), segments = [];
  let sequence = 0, duration = null, pdt = null, elapsed = 0;
  for (const line of lines) {
    if (/^#EXT-X-(KEY|SESSION-KEY|CONTENT-STEERING|SESSION-DATA|PRELOAD-HINT|RENDITION-REPORT|PART)(:|$)/.test(line)) throw Error('Unsupported HLS resource tag');
    if (/URI\s*=/.test(line)) {
      const attrs = [], attributePattern = /(?:^|[, :])(?:[A-Z-]*URI)="([^"]*)"/g; let attribute; while ((attribute = attributePattern.exec(line))) attrs.push(attribute);
      if (!attrs.length || attrs.length !== (line.match(/URI\s*=/g) || []).length) throw Error('Invalid HLS resource URI');
      for (const attr of attrs) resolvePath(attr[1], path);
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice(22));
    if (line.startsWith('#EXTINF:')) { duration = Number(line.slice(8).split(',')[0]); if (!(duration > 0 && duration <= 30)) throw Error('Invalid HLS segment duration'); }
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { pdt = Date.parse(line.slice(25)); if (!Number.isFinite(pdt)) throw Error('Invalid HLS programme time'); }
    if (line && !line.startsWith('#')) {
      const resource = resolvePath(line, path);
      if (duration !== null) { segments.push({ path: resource, sequence: sequence + segments.length, duration, pdt, offset: elapsed }); elapsed += duration; if (pdt !== null) pdt += duration * 1000; duration = null; }
    }
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0 || segments.length > 10000) throw Error('Invalid HLS media sequence');
  return { source, path, lines, segments, sequence, duration: elapsed, endSequence: sequence + segments.length };
}

export class VerifiedHlsCache {
  constructor({ maxBytes = 128 * 1024 * 1024, retainSeconds = 330, aheadSeconds = 12 } = {}) {
    this.files = new Map(); this.playlists = new Map(); this.timeline = new Map(); this.listeners = new Set();
    this.maxBytes = maxBytes; this.retainSeconds = retainSeconds; this.aheadSeconds = aheadSeconds; this.bytes = 0; this.target = null; this.newest = 0; this.epoch = null;
  }
  add(bundle, { epoch, start, duration } = {}) {
    if (!bundle || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 512) throw Error('Invalid HLS bundle');
    const batch = bundle.files.map(file => {
      const path = safePath(file.path), bytes = file.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes) : ArrayBuffer.isView(file.bytes) ? new Uint8Array(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength) : null;
      if (!bytes || !bytes.length || bytes.length > MAX_FILE) throw Error('Invalid HLS file');
      return { path, start: file.start, bytes: bytes.slice(), mime: file.mime || '', playlist: path.endsWith('.m3u8') ? inspectManifest(textDecoder.decode(bytes), path) : null };
    });
    if (batch.reduce((n, f) => n + f.bytes.length, 0) > this.maxBytes) throw Error('HLS bundle exceeds cache limit');
    for (const file of batch) { const old = this.files.get(file.path); if (old && !file.playlist && (old.bytes.length !== file.bytes.length || old.bytes.some((b, i) => b !== file.bytes[i]))) throw Error('HLS media path changed'); }
    const programStart = Number.isFinite(bundle.start) ? bundle.start : start;
    const programDuration = Number.isFinite(bundle.duration) ? bundle.duration : duration;
    if (Number.isFinite(epoch)) this.epoch = epoch;
    // Existing sequence anchors win. Otherwise the batch start anchors the
    // newly completed media file, rather than the beginning of a sliding list.
    for (const file of batch) if (file.playlist?.segments.length) {
      const list = file.playlist, known = list.segments.find(s => this.timeline.has(s.path));
      let origin = Number.isFinite(file.start) ? file.start : Number.isFinite(bundle.playlistStart) ? bundle.playlistStart : known ? this.timeline.get(known.path).start - known.offset : null;
      if (origin === null && this.epoch !== null) { const dated = list.segments.find(s => s.pdt !== null); if (dated) origin = (dated.pdt - this.epoch) / 1000 - dated.offset; }
      if (origin === null && Number.isFinite(programStart)) {
        const supplied = list.segments.filter(s => batch.some(f => f.path === s.path));
        const anchor = supplied[0] || list.segments[0]; origin = programStart - anchor.offset;
      }
      if (origin === null) throw Error('HLS playlist has no programme timeline');
      for (const s of list.segments) this.timeline.set(s.path, { ...s, start: origin + s.offset, end: origin + s.offset + s.duration });
    }
    const end = Number.isFinite(programStart) ? programStart + (programDuration || 0) : this.newest;
    this.newest = Math.max(this.newest, end);
    for (const file of batch) {
      const old = this.files.get(file.path);
      if (old && !file.playlist && (old.bytes.length !== file.bytes.length || old.bytes.some((b, i) => b !== file.bytes[i]))) throw Error('HLS media path changed');
      if (file.playlist) { const previous = this.playlists.get(file.path); if (previous && previous.endSequence > file.playlist.endSequence) continue; this.playlists.set(file.path, file.playlist); }
      this.bytes -= old?.bytes.length || 0; this.files.set(file.path, { ...file, end: this.timeline.get(file.path)?.end ?? end }); this.bytes += file.bytes.length;
    }
    this.prune(); for (const listener of this.listeners) listener();
  }
  prune() {
    const removable = [...this.files].filter(([p]) => !p.endsWith('.m3u8') && this.timeline.has(p)).sort((a, b) => a[1].end - b[1].end);
    for (const [path, file] of removable) if (file.end < this.newest - this.retainSeconds || this.bytes > this.maxBytes) { this.files.delete(path); this.bytes -= file.bytes.length; }
    if (this.bytes > this.maxBytes) { this.files.clear(); this.playlists.clear(); this.timeline.clear(); this.bytes = 0; throw Error('HLS bootstrap exceeds cache limit'); }
    for (const [path, timing] of this.timeline) if (timing.end < this.newest - this.retainSeconds && !this.files.has(path)) this.timeline.delete(path);
  }
  manifest(path) {
    const list = this.playlists.get(path); if (!list) return null;
    if (!list.segments.length) return list.source;
    const chosen = list.segments.filter(s => { const t = this.timeline.get(s.path); return this.files.has(s.path) && (this.target === null || t.start <= this.target + this.aheadSeconds) && (this.target === null || t.end >= this.target - 24); });
    if (!chosen.length) return null;
    const first = chosen[0], last = chosen[chosen.length - 1], selected = new Set(list.segments.filter(s => s.sequence >= first.sequence && s.sequence <= last.sequence).map(s => s.path));
    const out = []; let segmentLines = [], pendingSegment = false;
    for (const line of list.lines) {
      if (line === '#EXTM3U') { out.push(line); if (!list.lines.some(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))) out.push('#EXT-X-MEDIA-SEQUENCE:' + first.sequence); continue; }
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { out.push('#EXT-X-MEDIA-SEQUENCE:' + first.sequence); continue; }
      if (line === '#EXT-X-ENDLIST') continue; // A bounded peer window is refreshed as the shared clock advances.
      if (line.startsWith('#EXTINF:') || line.startsWith('#EXT-X-PROGRAM-DATE-TIME:') || line.startsWith('#EXT-X-BYTERANGE:') || line === '#EXT-X-DISCONTINUITY') { segmentLines.push(line); pendingSegment = true; continue; }
      if (line && !line.startsWith('#')) { if (selected.has(resolvePath(line, path))) out.push(...segmentLines, ...(this.files.has(resolvePath(line, path)) ? [] : ['#EXT-X-GAP']), line); segmentLines = []; pendingSegment = false; continue; }
      if (pendingSegment) segmentLines.push(line); else out.push(line);
    }
    return out.join('\n') + '\n';
  }
  hasPlayableAt(target) {
    for (const [path, timing] of this.timeline) if (this.files.has(path) && !path.endsWith('.m3u8') && timing.start <= target + 2.5 && timing.end >= target - 2.5) return true;
    return false;
  }
  read(url, arraybuffer = false, rangeStart, rangeEnd) {
    const path = cachePath(url), file = this.files.get(path); if (!file) return null;
    const source = path.endsWith('.m3u8') ? this.manifest(path) : null;
    if (path.endsWith('.m3u8') && source === null) return null;
    let bytes = source === null ? file.bytes : textEncoder.encode(source);
    if (rangeStart !== undefined || rangeEnd !== undefined) { const start = rangeStart ?? 0, end = rangeEnd ?? bytes.length; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length) throw Error('Invalid HLS byte range'); bytes = bytes.subarray(start, end); }
    return arraybuffer ? bytes.slice().buffer : textDecoder.decode(bytes);
  }
  clear() { this.files.clear(); this.playlists.clear(); this.timeline.clear(); this.bytes = 0; this.listeners.clear(); }
}
export function createVerifiedLoader(cache) {
  return class VerifiedLoader {
    constructor() { this.stats = { aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } }; }
    load(context, config, callbacks) {
      this.context = context; this.callbacks = callbacks; this.stats.loading.start = performance.now();
      this.deliver = () => {
        if (this.done) return;
        try {
          const data = cache.read(context.url, context.responseType === 'arraybuffer', context.rangeEnd > 0 ? context.rangeStart : undefined, context.rangeEnd > 0 ? context.rangeEnd : undefined); if (data === null) return;
          this.done = true; this.cleanup(); const length = typeof data === 'string' ? textEncoder.encode(data).length : data.byteLength;
          this.stats.loaded = this.stats.total = length; this.stats.loading.first = this.stats.loading.end = performance.now();
          callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, null);
        } catch (error) { this.done = true; this.cleanup(); callbacks.onError({ code: 403, text: error.message }, context, null, this.stats); }
      };
      cache.listeners.add(this.deliver); this.timer = setTimeout(() => { if (!this.done) { this.done = true; this.cleanup(); callbacks.onTimeout(this.stats, context, null); } }, Math.min(config.timeout || 10000, 15000)); queueMicrotask(this.deliver);
    }
    cleanup() { clearTimeout(this.timer); cache.listeners.delete(this.deliver); }
    abort() { const pending = !this.done; this.stats.aborted = true; this.done = true; this.cleanup(); if (pending) this.callbacks?.onAbort?.(this.stats, this.context, null); }
    destroy() { this.callbacks = null; this.abort(); this.context = null; }
    getCacheAge() { return 0; }
    getResponseHeader() { return null; }
  };
}

export class Player {
  constructor(video, config = {}, { onError = () => {}, onMode = () => {} } = {}) {
    if (!Hls.isSupported()) throw Error('This browser cannot play this HLS room. Use an updated browser with streaming media support.');
    this.video = video; this.config = config; this.onError = onError; this.mode = 'hls'; this.closed = false; this.blocked = false; this.soundBlocked = false; this.soundRequested = false; this.lastPlayError = null;
    this.cache = new VerifiedHlsCache({maxBytes:32*1024*1024,retainSeconds:60}); this.target = null; this.origin = null; this.seekCount = 0; this.syncSeekRequests = 0; this.lastSeek = -Infinity; this.lastRecoveryAttempt = -Infinity; this.bufferedOnce = false; this.lastFatalType = null; this.srcChanges = 0; this.presented = null; this.frameRequest = null; this.errors = 0; this.started = false;
    video.autoplay=false; video.setAttribute('playsinline', ''); video.disableRemotePlayback = true; video.preload = 'auto';
    const Loader = createVerifiedLoader(this.cache);
    this.hls = new Hls({ loader: Loader, enableWorker: false, autoStartLoad: false, lowLatencyMode: false, startFragPrefetch: false, maxBufferLength: 24, maxMaxBufferLength: 36, backBufferLength: 24, maxBufferSize: 24 * 1024 * 1024, liveSyncDuration: 12, liveMaxLatencyDuration: Infinity, maxLiveSyncPlaybackRate: 1, capLevelToPlayerSize: false, testBandwidth: false });
    this.hls.on(Hls.Events.MEDIA_ATTACHED, () => { this.srcChanges++; this.attached = true; this.start(); });
    this.hls.on(Hls.Events.MANIFEST_PARSED, () => { this.hls.startLoad(0); });
    this.hls.on(Hls.Events.LEVEL_LOADED, (_event, { details }) => {
      const first = details.fragments[0]; if (!first) return;
      let path; try { path = cachePath(first.url); } catch { return; }
      const t = this.cache.timeline.get(path); if (t) this.origin = t.start - first.start;
      if (this.target !== null && this.origin !== null && !this.initialPosition) { this.hls.startLoad(Math.max(0, this.target - this.origin)); this.initialPosition = true; }
    });
    this.hls.on(Hls.Events.FRAG_CHANGED, (_event, { frag }) => { let path; try { path = cachePath(frag.url); } catch { return; } const timing = this.cache.timeline.get(path); if (timing) this.origin = timing.start - frag.start; });
    this.hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal && !this.closed) { this.errors++;this.lastFatalType=data.type;onError('This device could not play the verified HLS picture. ' + data.details + ': ' + (data.response?.text || data.error?.message || '')); } });
    this.onSeeking = () => { this.seekCount++; this.presented = null; }; video.addEventListener('seeking', this.onSeeking);
    if (video.requestVideoFrameCallback) { const frame = (_now, meta) => { if (this.closed) return; this.presented = { time: meta.mediaTime, at: performance.now() }; this.frameRequest = video.requestVideoFrameCallback(frame); }; this.frameRequest = video.requestVideoFrameCallback(frame); }
    this.hls.attachMedia(video); onMode(this.mode);
  }
  enqueue(piece, epoch) {
    if (this.closed) return;
    try { this.epoch = epoch; this.cache.add(decodeBundle(piece.buf), { epoch, start: (piece.meta.start - epoch) / 1000, duration: piece.meta.duration / 1000 }); this.start(); } catch (error) { this.onError('The verified HLS media was invalid: ' + error.message); }
  }
  start() {
    if (this.closed || this.started || !this.attached || this.target === null || this.target < 0 || this.suspended) return;
    const master = [...this.cache.playlists.keys()].find(p => !this.cache.playlists.get(p).segments.length) || [...this.cache.playlists.keys()][0];
    if (!master) return; this.started = true; this.hls.loadSource(HLS_BASE + master);
  }
  setPlaybackWindow(target, hidden = false) {
    if (!Number.isFinite(target) || this.closed) return;
    this.target = target; this.cache.target = Math.max(0, target); this.suspended = hidden;
    if (hidden) { this.hls.stopLoad(); this.video.pause(); } else { this.start(); if (this.wasSuspended && this.started) this.hls.startLoad(Math.max(0, target - (this.origin || 0))); }
    this.wasSuspended = hidden; for (const listener of this.cache.listeners) listener();
  }
  lookAheadSeconds() { return 16; }
  mediaTime() { const p = this.presented; return p && !this.video.paused && performance.now() - p.at < 250 ? p.time : this.video.currentTime; }
  sync(target) {
    this.setPlaybackWindow(target, false); const v = this.video;
    if (target < 0) { v.pause(); return { waiting: true, drift: null }; }
    const networkFatal=this.lastFatalType===Hls.ErrorTypes.NETWORK_ERROR;
    if (this.origin === null) {
      v.pause();
      if(networkFatal&&this.cache.hasPlayableAt(target)&&performance.now()-this.lastRecoveryAttempt>=5000){
        this.lastRecoveryAttempt=performance.now();this.hls.stopLoad();this.hls.startLoad(0);this.lastFatalType=null;
      }
      return { waiting: true, drift: null };
    }
    const local = target - this.origin; let inRange = false;
    for (let i = 0; i < v.buffered.length; i++) if (local >= v.buffered.start(i) && local < v.buffered.end(i)) inRange = true;
    if (!inRange || v.readyState < 2) {
      v.pause();
      const now=performance.now(),farGap=Math.abs(local-v.currentTime)>24;
      if((this.bufferedOnce||networkFatal)&&(farGap||networkFatal)&&this.cache.hasPlayableAt(target)&&now-this.lastRecoveryAttempt>=5000){
        this.lastRecoveryAttempt=now;
        if(this.lastFatalType===Hls.ErrorTypes.MEDIA_ERROR&&typeof this.hls.recoverMediaError==='function'){
          this.hls.recoverMediaError();this.lastFatalType=null;
        }else{
          // A verified target has arrived outside the old decoder buffer. Ask
          // hls.js to resume from that programme position; keep this video and
          // its user-selected sound state intact.
          this.hls.stopLoad();this.hls.startLoad(local);
          this.lastFatalType=null;
        }
      }
      return { waiting: true, drift: null };
    }
    this.bufferedOnce=true;
    const drift = local - this.mediaTime(), now = performance.now();
    if (v.seeking) { v.pause(); return { waiting: true, drift: null }; }
    if (Math.abs(drift) > .8 && now - this.lastSeek > 2500) { this.lastSeek = now; this.syncSeekRequests++; this.presented = null; v.currentTime = local; v.pause(); return { waiting: true, drift: null }; }
    // Repeated fractional-rate writes disturb WebKit's streaming media clock.
    // Leave its decoder at normal speed and reserve correction for real drift.
    if (!v.seeking && v.playbackRate !== 1) v.playbackRate = 1;
    this.play().catch(() => {}); return { waiting: false, drift, playing: !v.paused };
  }
  programTime() { return this.closed || this.origin === null || this.video.readyState < 2 ? null : this.origin + this.mediaTime(); }
  requestSound() { this.soundRequested = true; this.video.muted = false; return this.play(); }
  muteSound() { this.soundRequested = true; this.soundBlocked = false; this.video.muted = true; }
  play() {
    // A sound preference during warm-up must not reveal the live source.
    if(this.closed||this.suspended||this.target===null||this.target<0)return Promise.resolve();
    const audible = !this.video.muted;
    return Promise.resolve(this.video.play()).then(() => { this.blocked = false; this.lastPlayError = null; if (audible && !this.video.muted) this.soundBlocked = false; }, error => {
      this.lastPlayError = error.name; if (error.name === 'NotAllowedError') { this.blocked = true; if (audible) { this.soundBlocked = true; this.video.muted = true; Promise.resolve(this.video.play()).catch(() => {}); } } throw error;
    });
  }
  facts() {
    const v = this.video, quality = v.getVideoPlaybackQuality?.(); let ahead = 0, buffered = 0;
    for (let i = 0; i < v.buffered.length; i++) { buffered += v.buffered.end(i) - v.buffered.start(i); if (v.currentTime >= v.buffered.start(i) && v.currentTime < v.buffered.end(i)) ahead = v.buffered.end(i) - v.currentTime; }
    return { mode: this.mode, hlsVersion: Hls.version, mseProgramOriginSeconds: this.origin, mediaElementTime: v.currentTime, presentedFrameTime: this.presented?.time ?? null, srcChanges: this.srcChanges, seekCount: this.seekCount, syncSeekRequests: this.syncSeekRequests, decodedFrames: quality?.totalVideoFrames ?? v.webkitDecodedFrameCount ?? null, droppedFrames: quality?.droppedVideoFrames ?? v.webkitDroppedFrameCount ?? null, decoderBufferedSeconds: buffered, playableAheadSeconds: ahead, cacheBytes: this.cache.bytes, cacheFiles: this.cache.files.size, muted: v.muted, soundBlocked: this.soundBlocked, soundRequested: this.soundRequested, playError: this.lastPlayError, width: v.videoWidth, height: v.videoHeight, errorCount: this.errors };
  }
  close() { if (this.closed) return; this.closed = true; if (this.frameRequest !== null) this.video.cancelVideoFrameCallback?.(this.frameRequest); this.video.removeEventListener('seeking', this.onSeeking); this.hls.destroy(); this.cache.clear(); this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
}
export const canPlay = () => Hls.isSupported();
