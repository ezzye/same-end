(function (root) {
  'use strict';

  var MAX_RECORDS = 128;
  var MAX_AGE_MS = 60000;
  var RATE_WINDOW_MS = 5000;
  var MAX_PIECE_BYTES = 4 * 1024 * 1024;

  function finiteNonNegative(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0;
  }

  function Meter(nowFn) {
    this._now = typeof nowFn === 'function' ? nowFn : function () { return Date.now(); };
    this._sent = [];
    this._acked = [];
    this._lastAt = -1;
  }

  function validMeta(meta) {
    return !!meta && typeof meta.seq === 'number' && Number.isSafeInteger(meta.seq) && meta.seq >= 0 &&
      typeof meta.hash === 'string' && meta.hash.length > 0 && meta.hash.length <= 128 &&
      typeof meta.size === 'number' && Number.isSafeInteger(meta.size) && meta.size > 0 && meta.size <= MAX_PIECE_BYTES;
  }

  Meter.prototype._prune = function (atMs) {
    var cutoff = atMs - MAX_AGE_MS;
    this._sent = this._sent.filter(function (r) { return r.at >= cutoff; });
    this._acked = this._acked.filter(function (r) { return r.at >= cutoff; });
    while (this._sent.length + this._acked.length > MAX_RECORDS) {
      if (!this._sent.length || (this._acked.length && this._acked[0].at <= this._sent[0].at)) this._acked.shift();
      else this._sent.shift();
    }
  };

  Meter.prototype.sent = function (meta, atMs) {
    atMs = atMs === undefined ? this._now() : atMs;
    if (!validMeta(meta) || !finiteNonNegative(atMs) || atMs > this._now() || atMs < this._lastAt) return false;
    this._prune(atMs);
    for (var i = 0; i < this._sent.length; i++) if (this._sent[i].seq === meta.seq) return false;
    for (var j = 0; j < this._acked.length; j++) if (this._acked[j].seq === meta.seq) return false;
    this._sent.push({ seq: meta.seq, hash: meta.hash, size: meta.size, at: atMs });
    this._lastAt = atMs;
    this._prune(atMs);
    return true;
  };

  Meter.prototype.acknowledge = function (ack, atMs) {
    atMs = atMs === undefined ? this._now() : atMs;
    if (!validMeta(ack) || !finiteNonNegative(atMs) || atMs > this._now() || atMs < this._lastAt) return false;
    this._prune(atMs);
    var index = -1;
    for (var i = 0; i < this._sent.length; i++) {
      if (this._sent[i].seq === ack.seq && this._sent[i].hash === ack.hash && this._sent[i].size === ack.size) {
        index = i;
        break;
      }
    }
    if (index < 0 || atMs < this._sent[index].at) return false;
    var record = this._sent.splice(index, 1)[0];
    this._acked.push({ seq: record.seq, size: record.size, at: atMs });
    this._lastAt = atMs;
    this._prune(atMs);
    return true;
  };

  Meter.prototype.snapshot = function (atMs) {
    atMs = atMs === undefined ? this._now() : atMs;
    if (!finiteNonNegative(atMs)) atMs = this._now();
    this._prune(atMs);
    var bytes = 0;
    var oldest = null;
    var firstAck = null;
    for (var i = 0; i < this._acked.length; i++) {
      var ack = this._acked[i];
      if (ack.at > atMs) continue;
      bytes += ack.size;
      if (firstAck === null || ack.at < firstAck) firstAck = ack.at;
      if (ack.at >= atMs - RATE_WINDOW_MS && (oldest === null || ack.at < oldest)) oldest = ack.at;
    }
    var windowStart = Math.max(atMs - RATE_WINDOW_MS, firstAck === null ? atMs : firstAck);
    var elapsed = atMs - windowStart;
    var windowBytes = 0;
    for (var j = 0; j < this._acked.length; j++) {
      if (this._acked[j].at >= windowStart && this._acked[j].at <= atMs) windowBytes += this._acked[j].size;
    }
    var measured = elapsed >= RATE_WINDOW_MS && this._acked.length >= 2;
    var mbps = measured ? (windowBytes * 8 / (elapsed / 1000) / 1000000) : null;
    var pendingBytes = 0;
    var oldestPending = null;
    for (var k = 0; k < this._sent.length; k++) {
      var sent = this._sent[k];
      pendingBytes += sent.size;
      var age = Math.max(0, atMs - sent.at);
      if (oldestPending === null || age > oldestPending) oldestPending = age;
    }
    var health = measured && mbps >= 0.1 ? 'healthy' : 'measuring';
    if (oldestPending !== null && oldestPending >= 12000) health = 'congested';
    return {
      acknowledgedBytes: bytes,
      deliveredMbps: mbps,
      samples: this._acked.length,
      pendingBytes: pendingBytes,
      oldestPendingMs: oldestPending,
      health: health,
      measured: measured
    };
  };

  // Returns contiguous cached seconds available from an absolute source-clock target in ms.
  // Small recorder jitter may be bridged up to 100 ms; larger gaps stop coverage.
  function reserveSeconds(segments, targetMs, options) {
    options = options || {};
    if (!Array.isArray(segments) || !finiteNonNegative(targetMs)) return 0;
    var tolerance = finiteNonNegative(options.toleranceMs) ? Math.min(options.toleranceMs, 100) : 100;
    var list = [];
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (s && finiteNonNegative(s.start) && finiteNonNegative(s.end) && s.end > s.start) {
        list.push({ start: s.start, end: s.end });
      }
    }
    list.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var index = -1;
    for (var j = 0; j < list.length; j++) {
      if (list[j].start <= targetMs && list[j].end >= targetMs) { index = j; break; }
      if (list[j].start > targetMs) {
        if (list[j].start - targetMs <= tolerance) index = j;
        break;
      }
    }
    if (index < 0) return 0;
    var end = list[index].end;
    for (var k = index + 1; k < list.length; k++) {
      var next = list[k];
      if (next.start <= end) end = Math.max(end, next.end);
      else if (next.start - end <= tolerance) end = next.end;
      else break;
    }
    return Math.max(0, end - targetMs) / 1000;
  }

  // A watchdog for verified source advancement. Silence of the media track is
  // deliberately absent from this decision.
  function assessSupplier(input) {
    if (!input || !finiteNonNegative(input.nowMs) ||
        !finiteNonNegative(input.connectedAt) || !finiteNonNegative(input.lastControlAt) ||
        !finiteNonNegative(input.lastProgressAt) || !finiteNonNegative(input.lastVerifiedAt) ||
        !finiteNonNegative(input.sourceNowMs)) return null;
    var now = input.nowMs;
    var age = now - input.lastProgressAt;
    var controlAge = now - input.lastControlAt;
    if (controlAge < 0 || now - input.connectedAt < 12000 ||
        (finiteNonNegative(input.sampleGapMs) && input.sampleGapMs > 5000)) return null;
    if (input.lastProgressAt > now || input.lastVerifiedAt > now || input.sourceNowMs < 0) return null;
    if (controlAge >= 12000) return 'supplier-unresponsive';
    if (age < 12000) return null;
    if (input.rooted !== true) return 'source-path-stalled';
    return 'source-progress-stalled';
  }

  root.SameEndDelivery = {
    Meter: Meter,
    reserveSeconds: reserveSeconds,
    assessSupplier: assessSupplier
  };
}(typeof window !== 'undefined' ? window : this));
