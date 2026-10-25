(function (root) {
  'use strict';

  // Observation only. These estimates never change a player or its five-minute baseline.
  var MAX_RECORDS = 128;
  var MAX_SAMPLES = 64;
  var WINDOW_MS = 60000;
  var MIN_RATE_MS = 8000;
  var MIN_CANDIDATE_MS = 20000;
  var SAMPLE_GAP_MS = 10000;
  var MAX_SAFE = 9007199254740991;

  function number(value) { return typeof value === 'number' && isFinite(value); }
  function nonnegative(value) { return number(value) && value >= 0 && value <= MAX_SAFE; }
  function integer(value) { return nonnegative(value) && Math.floor(value) === value; }
  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
  function seconds(value, maximum) { return nonnegative(value) && value <= maximum ? value : null; }
  function quantile(values, fraction) {
    if (!values.length) return null;
    values = values.slice().sort(function (a, b) { return a - b; });
    return values[Math.ceil((values.length - 1) * fraction)];
  }
  function health(context) {
    if (!context) return 'insufficient-data';
    if (!context.online) return 'offline';
    if (!context.visible) return 'suspended';
    if (!context.clockReady) return 'clock-unknown';
    if (!context.sourceReachable) return 'path-absent';
    return null;
  }

  function Estimator(nowFn) {
    this._now = typeof nowFn === 'function' ? nowFn : function () { return Date.now(); };
    this._highestSeq = -1;
    this._programEnd = -1;
    this._context = null;
    this._lastSampleAt = null;
    this._lastVerifiedAt = null;
    this._records = [];
    this._samples = [];
    this._routeStartedAt = this._time();
  }

  Estimator.prototype._time = function (at) {
    if (nonnegative(at)) return at;
    var current = this._now();
    return nonnegative(current) ? current : 0;
  };
  Estimator.prototype._clearWindow = function () {
    this._records = [];
    this._samples = [];
    this._lastVerifiedAt = null;
  };
  Estimator.prototype._prune = function (at) {
    var cutoff = at - WINDOW_MS;
    while (this._records.length && this._records[0].at < cutoff) this._records.shift();
    while (this._samples.length && this._samples[0].at < cutoff) this._samples.shift();
    while (this._records.length > MAX_RECORDS) this._records.shift();
    while (this._samples.length > MAX_SAMPLES) this._samples.shift();
  };
  Estimator.prototype.resetRoute = function () {
    this._clearWindow();
    this._routeStartedAt = this._time();
    this._lastSampleAt = null;
    // Retain scalar programme progress, never supplier IDs. A new programme needs
    // a new Estimator; replay from a replacement supplier is not fresh progress.
  };

  // Call only after signature validation and application-level deduplication.
  // Programme start and source-now share the source clock; receive and verify
  // timestamps use the local clock. Null source-now means unknown source age.
  Estimator.prototype.observe = function (piece) {
    if (!piece || !integer(piece.seq) || !integer(piece.size) || piece.size < 1 || piece.size > 4 * 1024 * 1024 ||
        !number(piece.durationMs) || piece.durationMs < 1 || piece.durationMs > 10000 ||
        !nonnegative(piece.programStartMs) || !nonnegative(piece.programStartMs + piece.durationMs) ||
        !nonnegative(piece.verifiedAtMs) || piece.verifiedAtMs > this._time() ||
        piece.seq <= this._highestSeq || piece.programStartMs < this._programEnd - 1 ||
        (this._lastVerifiedAt !== null && piece.verifiedAtMs < this._lastVerifiedAt)) return false;
    var receive = nonnegative(piece.receiveStartedAtMs) ? piece.receiveStartedAtMs : null;
    if (receive !== null && receive > piece.verifiedAtMs) return false;
    this._highestSeq = piece.seq;
    this._programEnd = piece.programStartMs + piece.durationMs;
    if ((this._context && health(this._context)) || piece.verifiedAtMs < this._routeStartedAt ||
        (receive !== null && receive < this._routeStartedAt)) return false;
    // A long unobserved gap cannot masquerade as a continuous route measurement.
    if (this._lastVerifiedAt !== null && piece.verifiedAtMs - this._lastVerifiedAt > WINDOW_MS) this._clearWindow();
    var age = null;
    if (nonnegative(piece.sourceNowMs) && piece.sourceNowMs >= this._programEnd) {
      age = seconds((piece.sourceNowMs - this._programEnd) / 1000, 86400);
    }
    this._records.push({ at: piece.verifiedAtMs, receive: receive, bytes: piece.size, duration: piece.durationMs / 1000, age: age });
    this._lastVerifiedAt = piece.verifiedAtMs;
    this._prune(piece.verifiedAtMs);
    return true;
  };

  Estimator.prototype.sample = function (input) {
    input = input || {};
    var at = this._time(input.nowMs);
    if (this._lastSampleAt !== null && at < this._lastSampleAt) return this.snapshot(this._lastSampleAt);
    var previousHealth = health(this._context);
    var context = {
      visible: input.visible === true, online: input.online === true,
      clockReady: input.clockReady === true, sourceReachable: input.sourceReachable === true,
      playing: input.playing === true,
      baseline: seconds(input.baselineDelaySeconds, 3600), reserve: seconds(input.reserveSeconds, 3600),
      decoder: seconds(input.decoderAheadSeconds, 600), extra: seconds(input.extraDelaySeconds, 600),
      sourceAge: seconds(input.sourceAgeSeconds, 86400)
    };
    var currentHealth = health(context);
    var interrupted = this._lastSampleAt !== null && at - this._lastSampleAt > SAMPLE_GAP_MS;
    if (currentHealth || (previousHealth && previousHealth !== 'insufficient-data') || interrupted) this._clearWindow();
    this._context = context;
    this._lastSampleAt = at;
    if (!currentHealth && context.playing && context.reserve !== null &&
        (!this._samples.length || at - this._samples[this._samples.length - 1].at >= 1000)) {
      this._samples.push({ at: at, reserve: context.reserve });
    } else if (!context.playing) this._samples = [];
    this._prune(at);
    return this.snapshot(at);
  };

  Estimator.prototype.snapshot = function (at) {
    at = this._time(at);
    this._prune(at);
    var records = this._records;
    var context = this._context;
    var count = records.length;
    var gaps = [], ages = [], bytes = 0, media = 0, elapsed = 0, intervalBytes = 0, intervalMedia = 0;
    var gapSum = 0, gapSquares = 0, activeBytes = 0, activeMs = 0, timedCount = 0, intervals = [];
    for (var i = 0; i < count; i++) {
      var r = records[i];
      bytes += r.bytes;
      media += r.duration;
      if (r.age !== null) ages.push({ at: r.at, age: r.age });
      if (i) {
        var gap = Math.max(0, r.at - records[i - 1].at) / 1000;
        gaps.push(gap); gapSum += gap; gapSquares += gap * gap;
        intervalBytes += r.bytes; intervalMedia += r.duration;
      }
      if (r.receive !== null && r.at > r.receive) {
        intervals.push({ start: r.receive, end: r.at });
        activeBytes += r.bytes; timedCount++;
      }
    }
    intervals.sort(function (a, b) { return a.start - b.start; });
    var start = null, end = null;
    for (var j = 0; j < intervals.length; j++) {
      if (start === null) { start = intervals[j].start; end = intervals[j].end; }
      else if (intervals[j].start <= end) end = Math.max(end, intervals[j].end);
      else { activeMs += end - start; start = intervals[j].start; end = intervals[j].end; }
    }
    if (start !== null) activeMs += end - start;
    if (count) elapsed = Math.max(0, at - records[0].at);
    var measured = count >= 4 && elapsed >= MIN_RATE_MS;
    var sourceBitrate = media > 0 ? bytes * 8 / media : null;
    var goodput = measured ? intervalBytes * 8000 / elapsed : null;
    var deliveryRatio = measured && sourceBitrate ? goodput / sourceBitrate : null;
    var mean = gaps.length ? gapSum / gaps.length : null;
    var stddev = mean === null ? null : Math.sqrt(Math.max(0, gapSquares / gaps.length - mean * mean));
    var gapP95 = quantile(gaps, 0.95);
    var pieceP95 = quantile(records.map(function (record) { return record.duration; }), 0.95);
    var reserveGoal = count >= 4 ? clamp(Math.max(6, pieceP95 * 2, gapP95 + 2 * stddev), 6, 60) : null;
    var samples = this._samples;
    var trendSpan = samples.length > 1 ? samples[samples.length - 1].at - samples[0].at : 0;
    var trend = samples.length >= 4 && trendSpan >= MIN_RATE_MS ?
      (samples[samples.length - 1].reserve - samples[0].reserve) * 1000 / trendSpan : null;
    var ageSpan = ages.length > 1 ? ages[ages.length - 1].at - ages[0].at : 0;
    var ageTrend = ageSpan >= MIN_RATE_MS ? (ages[ages.length - 1].age - ages[0].age) * 1000 / ageSpan : null;
    var ageP95 = quantile(ages.map(function (age) { return age.age; }), 0.95);
    var classification = 'unknown';
    if (ages.length >= 4 && ageSpan >= MIN_RATE_MS && count && records[count - 1].age !== null) {
      classification = ageTrend < -0.15 && ages[0].age > Math.max(12, (pieceP95 || 0) * 4) &&
        intervalMedia * 1000 / Math.max(1, elapsed) > 1.2 ? 'catchup' : 'live';
    }
    var lastAge = count ? Math.max(0, at - records[count - 1].at) / 1000 : null;
    var staleAfter = Math.max(12, (pieceP95 || 2) * 4);
    var state = health(context);
    if (!state && (this._lastSampleAt === null || at - this._lastSampleAt > SAMPLE_GAP_MS)) state = 'stale';
    if (!state && lastAge !== null && lastAge > staleAfter) state = 'stale';
    if (!state && !measured) state = 'insufficient-data';
    var deficit = context && context.reserve !== null && reserveGoal !== null ? Math.max(0, reserveGoal - context.reserve) : null;
    var fallingReserve = context && context.playing && trend !== null && trend < -0.1;
    var growingAge = ageSpan >= MIN_CANDIDATE_MS && ageTrend !== null && ageTrend > 0.1;
    // This is a shortfall in the observed delivery pipeline, never an ISP-capacity diagnosis.
    var constrained = measured && elapsed >= MIN_CANDIDATE_MS && deliveryRatio < 0.9 &&
      (fallingReserve || growingAge) && classification !== 'catchup';
    if (!state) state = constrained ? 'constrained' : deficit > 0 || trend !== null && trend < -0.1 ? 'risk' : 'observing';
    var enoughLive = count >= 6 && elapsed >= MIN_CANDIDATE_MS && classification === 'live' &&
      ages.length >= 6 && ageSpan >= MIN_CANDIDATE_MS;
    // An old age percentile cannot establish current startup latency. Require a
    // known current clock sample and progress within the observed arrival cadence.
    var progressFresh = lastAge !== null && lastAge <= Math.max(3, (gapP95 || pieceP95 || 2) * 1.5);
    var currentAgeKnown = context && context.sourceAge !== null && this._lastSampleAt !== null;
    var currentAge = currentAgeKnown ? context.sourceAge + Math.max(0, at - this._lastSampleAt) / 1000 : null;
    var latestAge = count && records[count - 1].age !== null ? records[count - 1].age + lastAge : null;
    var candidateAge = currentAge !== null && latestAge !== null && ageP95 !== null ?
      Math.max(ageP95, currentAge, latestAge) : null;
    var candidateWithinBounds = candidateAge !== null && reserveGoal !== null && candidateAge + reserveGoal <= 420;
    var eligible = (state === 'observing' || state === 'risk') && enoughLive && progressFresh && currentAgeKnown && candidateWithinBounds;
    var confidence = state === 'observing' || state === 'risk' || state === 'constrained' ?
      enoughLive && progressFresh && currentAgeKnown ? 'medium' : 'low' : 'none';
    var recommendationStatus = constrained && state === 'constrained' ? 'insufficient-throughput' :
      eligible ? 'unvalidated-candidate' : classification === 'catchup' && state !== 'stale' ? 'catchup' : 'insufficient-data';
    var reason = recommendationStatus === 'insufficient-throughput' ? 'observed-delivery-deficit' :
      recommendationStatus === 'catchup' ? 'historical-catchup-does-not-establish-startup' :
      eligible ? 'observed-live-age-plus-gap-reserve' : enoughLive && candidateAge !== null && !candidateWithinBounds ? 'observed-delay-exceeds-bound' :
      state === 'observing' || state === 'risk' ? 'need-fresh-live-observations' : state;
    return {
      state: state, confidence: confidence, classification: classification, capacityKnown: false,
      sourceBitrateBps: sourceBitrate, deliveredGoodputBps: goodput,
      activeTransferGoodputBps: timedCount >= 3 && activeMs >= 250 ? activeBytes * 8000 / activeMs : null,
      deliveryToStreamRatio: deliveryRatio, signedProgressSeconds: media,
      gapMeanSeconds: mean, gapStddevSeconds: stddev, gapP95Seconds: gapP95,
      sourceToVerifiedAgeP95Seconds: ageP95, sourceAgeTrendSecondsPerSecond: ageTrend,
      reserveSeconds: context ? context.reserve : null, decoderAheadSeconds: context ? context.decoder : null,
      extraDelaySeconds: context ? context.extra : null, baselineDelaySeconds: context ? context.baseline : null,
      reserveTrendSecondsPerSecond: trend,
      reserveCoverage: context && context.reserve !== null && reserveGoal !== null ? clamp(context.reserve / reserveGoal, 0, 1) : null,
      baselineReserveFraction: context && context.reserve !== null && context.baseline !== null && context.baseline > 0 ?
        clamp(context.reserve / context.baseline, 0, 1) : null,
      deficitSeconds: deficit, routeAgeSeconds: clamp((at - this._routeStartedAt) / 1000, 0, 86400),
      lastProgressAgeSeconds: lastAge, observationSeconds: elapsed / 1000,
      recordCount: count, sampleCount: samples.length,
      recommendation: {
        status: recommendationStatus, reason: reason,
        candidateInitialDelaySeconds: eligible ? clamp(Math.ceil(candidateAge + reserveGoal), 6, 420) : null,
        candidateReserveSeconds: eligible ? Math.ceil(reserveGoal) : null,
        applied: false, validated: false, extraDelayFixesSustainedDeficit: false
      }
    };
  };

  root.SameEndClientDelivery = { Estimator: Estimator };
}(typeof window !== 'undefined' ? window : this));
