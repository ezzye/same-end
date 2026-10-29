/* Local, conservative rendition selection. Thresholds are policy defaults,
 * not measured network capacity or device acceptance. All times use the same
 * source-adjusted Unix clock as signed media metadata. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SameEndResiliencePolicy = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var MODES = ['audio', 'v360', 'v480'];
  var STARTUP_MS = 12000, DEFICIT_MS = 6000, AUDIO_STABLE_MS = 20000, VIDEO_STABLE_MS = 60000;
  var PROBE_MS = 20000, COOLDOWN_MS = 30000, FRESH_MS = 15000, MAX_RECORDS = 128;
  function validNumber(n) { return typeof n === 'number' && isFinite(n); }
  function validMode(mode) { return MODES.indexOf(mode) !== -1; }
  function rank(mode) { return MODES.indexOf(mode); }
  function Policy(options) {
    options = options || {}; this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.audioAvailable = options.audioAvailable !== false;
    this.maxMode = options.maxMode === 'v360' ? 'v360' : 'v480';
    this.mode = validMode(options.initialMode) ? options.initialMode : 'v360';
    if ((!this.audioAvailable && this.mode === 'audio') || rank(this.mode) > rank(this.maxMode)) this.mode = 'v360';
    this.preference = 'auto'; this.probe = null; this.phase = 'startup'; this.reason = 'startup-grace'; this.changed = false;
    this.startedAt = this.now(); this.healthySince = null; this.deficitSince = null; this.cooldownUntil = 0;
    this.records = []; this.keys = {}; this.recordSerial = 0; this.available = ['audio', 'v360', 'v480']; this.context = null;
  }
  Policy.prototype.record = function (meta, bytes, atMs) {
    var at = validNumber(atMs) ? atMs : this.now();
    if (!meta || !validMode(meta.rendition) || !validNumber(meta.seq) || meta.seq < 0 || Math.floor(meta.seq) !== meta.seq || !validNumber(meta.start) || !validNumber(meta.duration) || meta.duration <= 0 || !validNumber(bytes) || bytes <= 0 || !validNumber(at)) return false;
    var key = meta.rendition + ':' + meta.seq;
    if (this.keys[key]) return false;
    var entry = { key: key, rendition: meta.rendition, at: at, end: meta.start + meta.duration, serial: ++this.recordSerial };
    this.keys[key] = true; this.records.push(entry);
    while (this.records.length > MAX_RECORDS) delete this.keys[this.records.shift().key];
    return true;
  };
  Policy.prototype.snapshot = function () { return { mode: this.mode, probe: this.probe ? this.probe.mode : null, phase: this.phase, reason: this.reason, changed: this.changed }; };
  Policy.prototype.setPreference = function (preference) {
    if (preference !== 'auto' && !validMode(preference)) throw new Error('Invalid rendition preference.');
    if (preference === 'audio' && !this.audioAvailable) return false;
    if (validMode(preference) && rank(preference) > rank(this.maxMode)) return false;
    this.preference = preference; this.healthySince = null; return true;
  };
  Policy.prototype.requestedRenditions = function (children) {
    var desired = ['audio', this.mode], available = this.available;
    if (this.probe) desired.push(this.probe.mode);
    (Array.isArray(children) ? children : []).forEach(function (mode) { if (validMode(mode)) desired.push(mode); });
    return desired.filter(function (mode, index) { return validMode(mode) && available.indexOf(mode) !== -1 && desired.indexOf(mode) === index; });
  };
  Policy.prototype.update = function (context) {
    context = context || {}; var t = validNumber(context.nowMs) ? context.nowMs : this.now();
    var available = Array.isArray(context.availableRenditions) ? context.availableRenditions.filter(validMode) : [];
    this.available = available; this.context = context; this.changed = false;
    var move = function (self, mode, reason) { if (mode !== self.mode) { self.mode = mode; self.changed = true; } self.phase = 'cooldown'; self.reason = reason; self.probe = null; self.deficitSince = null; self.healthySince = null; self.cooldownUntil = t + COOLDOWN_MS; };
    if (!context.visible || !context.online || !context.sourceReachable) {
      this.phase = 'paused'; this.reason = !context.visible ? 'hidden' : !context.online ? 'offline' : 'source-unreachable';
      this.probe = null; this.deficitSince = null; this.healthySince = null; this.startedAt = t; this.cooldownUntil = Math.max(this.cooldownUntil, t + STARTUP_MS); return this.snapshot();
    }
    if (available.indexOf(this.mode) < 0) {
      var fallback = available.indexOf('v360') >= 0 ? 'v360' : this.audioAvailable && available.indexOf('audio') >= 0 ? 'audio' : available.indexOf('v480') >= 0 && this.maxMode === 'v480' ? 'v480' : null;
      if (fallback) move(this, fallback, 'rendition-unavailable');
      else { this.phase = 'unavailable'; this.reason = 'no-eligible-rendition'; this.probe = null; }
      return this.snapshot();
    }
    if (!context.playing || t - this.startedAt < STARTUP_MS) { this.phase = 'startup'; this.reason = 'startup-grace'; this.deficitSince = null; this.healthySince = null; return this.snapshot(); }
    var reserve = context.reserve || {}, age = context.lastAge || {}, r = reserve[this.mode], a = age[this.mode];
    var known = validNumber(r) && r >= 0 && validNumber(a) && a >= 0;
    var healthy = known && r >= 6 && a <= 5;
    var deficit = known && (r < 2 || a > 8);
    if (this.preference === 'audio' && this.mode !== 'audio' && this.audioAvailable && available.indexOf('audio') >= 0) { move(this, 'audio', 'user-preference'); return this.snapshot(); }
    if (this.preference !== 'auto' && validMode(this.preference) && rank(this.preference) < rank(this.mode) && available.indexOf(this.preference) >= 0) { move(this, this.preference, 'user-preference'); return this.snapshot(); }
    if (this.probe && deficit) { this.probe = null; this.cooldownUntil = t + COOLDOWN_MS; }
    if (this.probe) {
      var p = this.probe, pr = reserve[p.mode], pa = age[p.mode];
      if (available.indexOf(p.mode) < 0 || t - p.startedAt >= PROBE_MS) { this.probe = null; this.healthySince = null; this.cooldownUntil = t + COOLDOWN_MS; this.phase = 'cooldown'; this.reason = 'probe-failed'; return this.snapshot(); }
      // Receipt freshness is measured against the current clock; media position
      // is measured against the actual playhead, which may be minutes behind.
      var hasPlayhead = Object.prototype.hasOwnProperty.call(context, 'playbackNowMs');
      var target = hasPlayhead ? context.playbackNowMs : t;
      var evidence = validNumber(target) ? this.records.filter(function (entry) { return entry.rendition === p.mode && entry.serial > p.recordSerial && entry.at >= p.startedAt && entry.at <= t && entry.at >= t - FRESH_MS && entry.end <= target + 5000 && entry.end >= target - FRESH_MS; }) : [];
      if (evidence.length >= 2 && validNumber(pr) && pr >= 5 && validNumber(pa) && pa <= 5) { move(this, p.mode, 'probe-verified'); return this.snapshot(); }
      this.phase = 'probing'; this.reason = 'awaiting-fresh-video'; return this.snapshot();
    }
    if (deficit) {
      this.healthySince = null; if (this.deficitSince === null) this.deficitSince = t;
      if (t - this.deficitSince >= DEFICIT_MS) {
        var lower = this.mode === 'v480' && available.indexOf('v360') >= 0 ? 'v360' : this.mode !== 'audio' && this.audioAvailable && available.indexOf('audio') >= 0 ? 'audio' : null;
        if (lower) { move(this, lower, 'sustained-deficit'); return this.snapshot(); }
        this.phase = 'degraded'; this.reason = 'no-lower-rendition'; return this.snapshot();
      }
      this.phase = 'observing'; this.reason = 'possible-deficit'; return this.snapshot();
    }
    this.deficitSince = null;
    if (!healthy) { this.healthySince = null; this.phase = 'observing'; this.reason = 'insufficient-data'; return this.snapshot(); }
    if (this.healthySince === null) this.healthySince = t;
    var wanted = this.preference === 'auto' ? (this.mode === 'audio' ? 'v360' : this.mode === 'v360' && this.maxMode === 'v480' ? 'v480' : null) : this.preference;
    if (validMode(wanted) && rank(wanted) < rank(this.mode) && available.indexOf(wanted) >= 0) { move(this, wanted, 'user-preference'); return this.snapshot(); }
    var wait = this.mode === 'audio' ? AUDIO_STABLE_MS : VIDEO_STABLE_MS;
    if (wanted && rank(wanted) > rank(this.mode) && available.indexOf(wanted) >= 0 && t >= this.cooldownUntil && t - this.healthySince >= wait) {
      this.probe = { mode: wanted, startedAt: t, recordSerial: this.recordSerial }; this.phase = 'probing'; this.reason = 'checking-video'; return this.snapshot();
    }
    this.phase = t < this.cooldownUntil ? 'cooldown' : 'healthy'; this.reason = 'stable'; return this.snapshot();
  };
  return { Policy: Policy };
});
