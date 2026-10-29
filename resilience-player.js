/* One independent audio clock and a replaceable, muted video decoder. */
import { Player, canPlay } from './hls-player.js';
import { NativePlayer, canPlayNative } from './hls-native.js';
import { decodeBundle } from './hls-protocol.js';
const VIDEO_MODES = ['v360', 'v480'];
export class ResilientPlayer {
  constructor(video, config = {}, callbacks = {}) {
    this.video = video; this.config = config; this.callbacks = callbacks; this.mode = 'v480'; this.pendingMode = null;
    this.closed = false; this.audioElement = document.createElement('audio'); this.audioElement.muted = true;
    this.audioElement.setAttribute('playsinline', ''); this.audioElement.setAttribute('data-same-end-audio', ''); this.audioElement.hidden = true; this.audioElement.preload = 'auto';
    if (!video.parentNode) throw new Error('The video element must be attached to the page.');
    video.parentNode.insertBefore(this.audioElement, video.nextSibling);
    this.VideoPlayer = canPlay() ? Player : canPlayNative(video) ? NativePlayer : null;
    if (!this.VideoPlayer) { this.audioElement.remove(); throw new Error('This browser cannot play HLS.'); }
    try { this.audio = new this.VideoPlayer(this.audioElement, config, callbacks); }
    catch (error) { this.audioElement.remove(); throw error; }
    this.videoPlayer = null; this.queues = { v360: [], v480: [] }; this.queueBytes = { v360: 0, v480: 0 };
    this.target = null; this.suspended = false; this.startupHold = false; this.blocked = false;
    video.muted = true;
  }
  enqueue(piece, epoch) {
    if (this.closed || !piece?.meta || !(piece.buf instanceof ArrayBuffer)) return;
    const name = piece.meta.rendition;
    if (name === 'audio') { this.audio.enqueue(piece, epoch); return; }
    if (!VIDEO_MODES.includes(name)) return;
    // Validate before staging; every cache is bounded independently.
    try { decodeBundle(piece.buf); } catch (error) { this.callbacks.onError?.('Invalid video rendition: ' + error.message); return; }
    const queue = this.queues[name]; queue.push({ piece, epoch }); this.queueBytes[name] += piece.buf.byteLength;
    while (queue.length > 1 && (this.queueBytes[name] > 32 * 1024 * 1024 || piece.meta.start - queue[0].piece.meta.start > 60000)) this.queueBytes[name] -= queue.shift().piece.buf.byteLength;
    if (this.videoPlayer && this.mode === name) this.videoPlayer.enqueue(piece, epoch);
    this.trySwitch();
  }
  setMode(mode) {
    if (!['audio', ...VIDEO_MODES].includes(mode) || this.closed) return false;
    if (mode === 'audio') { this.pendingMode = null; this.mode = mode; this.videoPlayer?.close(); this.videoPlayer = null; this.video.hidden = true; return true; }
    if (this.mode === mode && this.videoPlayer) return true;
    this.pendingMode = mode; return this.trySwitch();
  }
  trySwitch() {
    const name = this.pendingMode || (!this.videoPlayer && this.mode !== 'audio' ? this.mode : null);
    if (!name || this.target === null) return false;
    const queue = this.queues[name], target = this.audio.programTime() ?? this.target;
    const candidate = queue.filter(item => (item.piece.meta.start - item.epoch) / 1000 + item.piece.meta.duration / 1000 >= target - 2);
    if (!candidate.length) return false;
    let end = target;
    for (const item of candidate) { const start = (item.piece.meta.start - item.epoch) / 1000; if (start > end + .25) break; end = Math.max(end, start + item.piece.meta.duration / 1000); }
    if (end - target < 4) return false;
    this.videoPlayer?.close(); this.video.muted = true; this.video.hidden = false;
    this.videoPlayer = new this.VideoPlayer(this.video, this.config, this.callbacks);
    this.videoPlayer.startupHold = this.startupHold;
    this.mode = name; this.pendingMode = null;
    for (const item of candidate) this.videoPlayer.enqueue(item.piece, item.epoch);
    this.videoPlayer.setPlaybackWindow(target, this.suspended);
    return true;
  }
  sync(target) {
    if (this.closed) return { waiting: true, drift: null, playing: false };
    this.target = target; this.audio.startupHold = this.startupHold;
    const result = this.audio.sync(target); this.trySwitch();
    if (this.videoPlayer) { this.videoPlayer.startupHold = this.startupHold; this.videoPlayer.sync(this.audio.programTime() ?? target); }
    this.blocked = this.audio.blocked; return result;
  }
  programTime() { return this.audio.programTime(); }
  playheadTime() { return this.audio.playheadTime(); }
  getPlaybackTarget(t) { return this.audio.getPlaybackTarget(t); }
  setPlaybackWindow(t, hidden = false) { this.target = t; this.suspended = hidden; this.audio.setPlaybackWindow(t, hidden); this.videoPlayer?.setPlaybackWindow(this.audio.programTime() ?? t, hidden); this.trySwitch(); }
  prepareStartup(t, reserve) {
    this.target = t;
    const audio = this.audio.prepareStartup(t, reserve);
    this.trySwitch();
    if ((this.pendingMode || this.mode) !== 'audio') this.videoPlayer?.prepareStartup(t, reserve);
    return audio ? this.startupFacts(t) : null;
  }
  commitStartup(t, reserve) {
    const facts = this.startupFacts(t), goal = Math.max(reserve, facts.minimumReserveSeconds);
    if (!Number.isFinite(goal) || goal > 12 || !facts.ready || !facts.aligned || facts.cacheAheadSeconds + .001 < goal || facts.decoderAheadSeconds + .08 < goal) return false;
    if ((this.pendingMode || this.mode) !== 'audio' && !this.videoPlayer?.commitStartup(t, reserve)) return false;
    if (!this.audio.commitStartup(t, reserve)) return false;
    this.startupHold = false;
    return true;
  }
  startupFacts(t) {
    const audio = this.audio.startupFacts(t), selected = this.pendingMode || this.mode;
    if (selected === 'audio') return { ...audio, audioReady: audio.ready, pictureReady: null, awaitingPicture: false };
    const video = !this.pendingMode && this.videoPlayer ? this.videoPlayer.startupFacts(t) : null;
    const minimum = video && Number.isFinite(audio.minimumReserveSeconds) && Number.isFinite(video.minimumReserveSeconds) ? Math.max(audio.minimumReserveSeconds, video.minimumReserveSeconds) : null;
    return { ...audio, minimumReserveSeconds: minimum, cacheAheadSeconds: video ? Math.min(audio.cacheAheadSeconds, video.cacheAheadSeconds) : 0,
      decoderAheadSeconds: video ? Math.min(audio.decoderAheadSeconds, video.decoderAheadSeconds) : 0,
      ready: !!(video && audio.ready && video.ready), aligned: !!(video && audio.aligned && video.aligned),
      audioReady: audio.ready, pictureReady: !!(video && video.ready && video.aligned), awaitingPicture: !(video && video.ready && video.aligned) };
  }
  lookAheadSeconds() { return this.audio.lookAheadSeconds(); }
  requestSound() { return this.audio.requestSound(); }
  muteSound() { return this.audio.muteSound(); }
  play() { return this.audio.play(); }
  get startupHold() { return this._startupHold === true; }
  set startupHold(value) {
    this._startupHold = value === true;
    if (this.audio) { this.audio.startupHold = this._startupHold; if (this._startupHold) this.audioElement.pause(); }
    if (this.videoPlayer) { this.videoPlayer.startupHold = this._startupHold; if (this._startupHold) this.video.pause(); }
  }
  get soundBlocked() { return this.audio.soundBlocked; }
  get soundRequested() { return this.audio.soundRequested; }
  set soundRequested(value) { this.audio.soundRequested = value === true; }
  get adaptive() { return this.audio.adaptive; }
  get startupPreparation() { return this.audio.startupPreparation; }
  facts() {
    const audio = this.audio.facts(), video = this.videoPlayer?.facts() || null;
    const selected = this.pendingMode || this.mode, pictureReady = this.mode !== 'audio' && !!this.videoPlayer && this.video.readyState >= 2 && !this.video.seeking && !this.video.paused;
    return { ...audio, pictureReady, awaitingPicture: selected !== 'audio' && (!!this.pendingMode || !pictureReady), actualMode: this.mode === 'audio' ? 'audio' : pictureReady ? this.mode : 'waiting-picture', decodedFrames: video?.decodedFrames ?? null, droppedFrames: video?.droppedFrames ?? null, width: video?.width ?? 0, height: video?.height ?? 0, presentedFrameTime: video?.presentedFrameTime ?? null, mediaMode: this.mode, pendingMode: this.pendingMode, audio, video };
  }
  close() { if (this.closed) return; this.closed = true; this.audio.close(); this.audioElement.remove(); this.videoPlayer?.close(); this.queues.v360.length = this.queues.v480.length = 0; }
}
