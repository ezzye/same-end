/* Passive health check for audio already present in a captured source stream. */
(() => {
  'use strict';

  const DEFAULT_QUIET_AFTER_MS = 15000;
  const DEFAULT_SAMPLE_MS = 500;
  const MAX_SAMPLE_GAP_MS = 3000;
  const RMS_THRESHOLD = 0.001;

  function rmsFromTimeDomain(bytes) {
    if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      const value = (bytes[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / bytes.length);
  }

  function classifyRms(rms, silenceMs, quietAfterMs = DEFAULT_QUIET_AFTER_MS, threshold = RMS_THRESHOLD) {
    const silence = Math.max(0, Number(silenceMs) || 0);
    return rms >= threshold
      ? {status: 'sound', silenceSeconds: 0}
      : {status: silence >= quietAfterMs ? 'quiet' : 'checking', silenceSeconds: silence / 1000};
  }

  function classifyTimeDomain(bytes, silenceMs, quietAfterMs = DEFAULT_QUIET_AFTER_MS, threshold = RMS_THRESHOLD) {
    return classifyRms(rmsFromTimeDomain(bytes), silenceMs, quietAfterMs, threshold);
  }

  class Monitor {
    constructor(stream, {onChange = () => {}, quietAfterMs = DEFAULT_QUIET_AFTER_MS, sampleMs = DEFAULT_SAMPLE_MS,
      now = () => Date.now(), setIntervalFn = (...args) => setInterval(...args), clearIntervalFn = id => clearInterval(id),
      AudioContextCtor, MediaStreamCtor} = {}) {
      this.stream = stream;
      this.onChange = typeof onChange === 'function' ? onChange : () => {};
      this.quietAfterMs = Math.max(0, Number(quietAfterMs) || DEFAULT_QUIET_AFTER_MS);
      this.sampleMs = Math.max(50, Number(sampleMs) || DEFAULT_SAMPLE_MS);
      this.now = now;
      this.setIntervalFn = setIntervalFn;
      this.clearIntervalFn = clearIntervalFn;
      this.AudioContextCtor = AudioContextCtor;
      this.MediaStreamCtor = MediaStreamCtor;
      this.audioContext = null;
      this.analyser = null;
      this.source = null;
      this.timer = null;
      this.tracks = [];
      this.listeners = [];
      this.lastSampleAt = null;
      this.silenceStartedAt = null;
      this.closed = false;
      this.started = false;
      this.state = {status: 'checking', silenceSeconds: 0, reason: 'none'};
    }

    publish(status, reason = 'none', silenceSeconds = this.state.silenceSeconds) {
      const next = {status, silenceSeconds: Math.max(0, silenceSeconds || 0), reason};
      if (next.status === this.state.status && next.reason === this.state.reason && next.silenceSeconds === this.state.silenceSeconds) return next;
      this.state = next;
      try { this.onChange({...next}); } catch (_) { /* Consumer UI must not break monitoring. */ }
      return next;
    }

    start() {
      if (this.closed) return this.state;
      if (this.started) return this.state;
      this.started = true;
      let tracks;
      try { tracks = this.stream && typeof this.stream.getAudioTracks === 'function' ? this.stream.getAudioTracks() : []; }
      catch (_) { tracks = []; }
      this.tracks = Array.isArray(tracks) ? tracks : [];
      if (!this.tracks.length) return this.publish('no-track', 'no-track', 0);

      for (const track of this.tracks) {
        if (!track) continue;
        const listen = event => {
          if (typeof track.addEventListener !== 'function') return;
          const handler = () => this.check();
          try { track.addEventListener(event, handler); this.listeners.push([track, event, handler]); } catch (_) {}
        };
        listen('mute'); listen('unmute'); listen('ended');
      }

      try {
        const Ctx = this.AudioContextCtor || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
          (typeof AudioContext !== 'undefined' ? AudioContext : null);
        const StreamCtor = this.MediaStreamCtor || (typeof window !== 'undefined' && window.MediaStream) ||
          (typeof MediaStream !== 'undefined' ? MediaStream : null);
        if (!Ctx || !StreamCtor) return this.publish('unavailable', 'unsupported', 0);
        this.audioContext = new Ctx();
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 1024;
        this.samples = new Uint8Array(this.analyser.fftSize);
        const audioOnly = new StreamCtor(this.tracks);
        this.source = this.audioContext.createMediaStreamSource(audioOnly);
        this.source.connect(this.analyser);
        this.timer = this.setIntervalFn(() => this.check(), this.sampleMs);
        return this.check();
      } catch (_) {
        this.disconnectGraph();
        const context = this.audioContext;
        this.audioContext = null;
        if (context && typeof context.close === 'function') {
          try { const result = context.close(); if (result && typeof result.catch === 'function') result.catch(() => {}); } catch (_) {}
        }
        return this.publish('unavailable', 'unsupported', 0);
      }
    }

    resetContinuity() {
      this.lastSampleAt = null;
      this.silenceStartedAt = null;
    }

    recordSilence(now, reason = 'none') {
      if (this.lastSampleAt !== null && now - this.lastSampleAt > MAX_SAMPLE_GAP_MS) this.silenceStartedAt = null;
      this.lastSampleAt = now;
      if (this.silenceStartedAt === null) this.silenceStartedAt = now;
      const silenceMs = Math.max(0, now - this.silenceStartedAt);
      const result = classifyRms(0, silenceMs, this.quietAfterMs);
      return this.publish(result.status, reason, result.silenceSeconds);
    }

    check() {
      if (this.closed) return this.state;
      const tracks = this.tracks.filter(Boolean);
      if (!tracks.length) return this.publish('no-track', 'no-track', 0);
      const liveTracks = tracks.filter(track => track.readyState !== 'ended');
      if (!liveTracks.length) { this.resetContinuity(); return this.publish('unavailable', 'track-ended', 0); }
      const now = this.now();
      const audibleTracks = liveTracks.filter(track => !track.muted);
      if (!audibleTracks.length) return this.recordSilence(now, 'track-muted');
      if (!this.audioContext || !this.analyser) return this.state;
      if (this.audioContext.state !== 'running') {
        this.resetContinuity();
        return this.publish('unavailable', 'context-suspended', 0);
      }

      if (this.lastSampleAt !== null && now - this.lastSampleAt > MAX_SAMPLE_GAP_MS) this.silenceStartedAt = null;
      this.lastSampleAt = now;
      try { this.analyser.getByteTimeDomainData(this.samples); }
      catch (_) { return this.publish('unavailable', 'unsupported', 0); }
      const rms = rmsFromTimeDomain(this.samples);
      if (rms >= RMS_THRESHOLD) {
        this.silenceStartedAt = null;
        return this.publish('sound', 'none', 0);
      }
      if (this.silenceStartedAt === null) this.silenceStartedAt = now;
      const silenceMs = Math.max(0, now - this.silenceStartedAt);
      const result = classifyRms(rms, silenceMs, this.quietAfterMs);
      return this.publish(result.status, 'none', result.silenceSeconds);
    }

    resume() {
      if (this.closed || !this.audioContext || typeof this.audioContext.resume !== 'function') return Promise.resolve(this.state);
      let result;
      try { result = this.audioContext.resume(); }
      catch (_) { this.publish('unavailable', 'context-suspended', 0); return Promise.resolve(this.state); }
      return Promise.resolve(result).then(() => this.check(), () => this.publish('unavailable', 'context-suspended', 0));
    }

    disconnectGraph() {
      try { if (this.source) this.source.disconnect(); } catch (_) {}
      try { if (this.analyser) this.analyser.disconnect(); } catch (_) {}
      this.source = null;
      this.analyser = null;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.timer !== null) { try { this.clearIntervalFn(this.timer); } catch (_) {} this.timer = null; }
      for (const [track, event, handler] of this.listeners) {
        try { track.removeEventListener(event, handler); } catch (_) {}
      }
      this.listeners.length = 0;
      this.disconnectGraph();
      const context = this.audioContext;
      this.audioContext = null;
      if (context && typeof context.close === 'function') {
        try { const result = context.close(); if (result && typeof result.catch === 'function') result.catch(() => {}); } catch (_) {}
      }
    }
  }

  const api = {Monitor, rmsFromTimeDomain, classifyRms, classifyTimeDomain};
  if (typeof window !== 'undefined') window.SameEndSourceAudio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
