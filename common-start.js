(function (root) {
  'use strict';

  // The source alone signs this proposal. Reports are bounded observations,
  // never permission for a receiver or relay to change the common clock.
  var DEADLINE_SECONDS = 60, LEAD_SECONDS = 4, MIN_DELAY = 30, MAX_DELAY = 120;
  var MAX_REPORTS = 64, MAX_REPORT_AGE_SECONDS = 12, MAX_RESERVE = 12;
  var PREVIEW_LEAD_SECONDS = 12, MAX_PREVIEWS = 5;
  var states = ['observing', 'risk', 'constrained', 'insufficient-data', 'offline', 'suspended', 'clock-unknown', 'path-absent', 'stale'];
  var classifications = ['live', 'catchup', 'unknown'];
  var statuses = ['unvalidated-candidate', 'insufficient-throughput', 'catchup', 'insufficient-data'];
  var fallbackReasons = ['observation-timeout', 'unsupported-peer', 'sustained-delivery-deficit', 'candidate-exceeds-limit'];
  function number(value) { return typeof value === 'number' && isFinite(value); }
  function bounded(value, low, high) { return number(value) && value >= low && value <= high; }
  function timestamp(value) { return bounded(value, 0, 9007199254740991); }
  function integer(value, low, high) { return bounded(value, low, high) && Math.floor(value) === value; }
  function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 100; }
  function includes(list, value) { return list.indexOf(value) !== -1; }
  function metric(value, low, high) { return bounded(value, low, high) ? value : null; }
  function nullable(value, low, high) { return value === null || bounded(value, low, high); }

  function canonicalDecision(m) {
    var fields = ['common-start', m.version, m.cast, m.sourceId, m.sourceEpoch, m.programId,
      m.decisionNumber, m.delaySeconds, m.reserveSeconds, m.issuedAt, m.startsAt, m.reason];
    if (m.version === 2) fields.push(m.observationStartedAt, m.programmeTime);
    return JSON.stringify(fields);
  }
  // Structural checks precede signature work. ECDSA and current-cast checks after
  // awaiting verification remain the caller's responsibility.
  function validateDecision(m, config) {
    if (config && config.commonStartVersion === 2) return validateDecisionV2(m, config);
    if (!m || !config || config.commonStartVersion !== 1 || config.delay !== 300 ||
        !timestamp(config.epoch) || !text(config.id) || !text(config.sourceId) || !text(config.programId) ||
        !integer(config.sourceEpoch, 0, 9007199254740991) || m.type !== 'common-start' ||
        m.version !== 1 || m.decisionNumber !== 1 || m.cast !== config.id ||
        m.sourceId !== config.sourceId || m.sourceEpoch !== config.sourceEpoch || m.programId !== config.programId ||
        !timestamp(m.issuedAt) || m.issuedAt < config.epoch || !timestamp(m.startsAt) ||
        !integer(m.reserveSeconds, 4, MAX_RESERVE) || !number(m.delaySeconds) ||
        m.startsAt !== config.epoch + m.delaySeconds * 1000) return false;
    if (m.delaySeconds === config.delay) return includes(fallbackReasons, m.reason);
    return integer(m.delaySeconds, MIN_DELAY, MAX_DELAY) && m.delaySeconds % 2 === 0 &&
      m.reason === 'verified-delivery' && m.issuedAt <= config.epoch + DEADLINE_SECONDS * 1000 &&
      m.startsAt >= m.issuedAt + LEAD_SECONDS * 1000;
  }
  function validateDecisionV2(m, config) {
    if (!m || config.delay !== 300 || !timestamp(config.epoch) || !text(config.id) ||
        !text(config.sourceId) || !text(config.programId) || !integer(config.sourceEpoch, 0, 9007199254740991) ||
        m.type !== 'common-start' || m.version !== 2 || m.decisionNumber !== 1 ||
        m.cast !== config.id || m.sourceId !== config.sourceId || m.sourceEpoch !== config.sourceEpoch || m.programId !== config.programId ||
        !timestamp(m.issuedAt) || !timestamp(m.startsAt) || !timestamp(m.observationStartedAt) ||
        m.observationStartedAt < config.epoch || m.issuedAt < m.observationStartedAt ||
        !bounded(m.programmeTime, 0, 9007199254740991) || !integer(m.reserveSeconds, 4, MAX_RESERVE) ||
        !number(m.delaySeconds) ||
        Math.abs(m.startsAt - (config.epoch + (m.programmeTime + m.delaySeconds) * 1000)) > .001 ||
        m.startsAt < m.issuedAt + LEAD_SECONDS * 1000) return false;
    if (m.delaySeconds === config.delay) return includes(fallbackReasons, m.reason) &&
      m.startsAt === Math.max(config.epoch + config.delay * 1000, m.issuedAt + LEAD_SECONDS * 1000);
    return integer(m.delaySeconds, MIN_DELAY, MAX_DELAY) && m.delaySeconds % 2 === 0 &&
      m.reason === 'verified-delivery' && m.issuedAt - m.observationStartedAt >= 20000 &&
      m.issuedAt - m.observationStartedAt < DEADLINE_SECONDS * 1000 &&
      m.programmeTime <= (m.issuedAt - config.epoch) / 1000 + .000001 &&
      m.startsAt <= m.issuedAt + m.delaySeconds * 1000;
  }

  function reportOutcome(r) {
    var fresh = number(r.lastProgressAgeSeconds) && r.lastProgressAgeSeconds <= Math.min(MAX_REPORT_AGE_SECONDS, Math.max(3, (r.gapP95Seconds || 2) * 1.5));
    var evidence = r.observationSeconds !== null && r.observationSeconds >= 20 && r.recordCount >= 6 &&
      r.routeAgeSeconds !== null && r.routeAgeSeconds >= 20 && fresh &&
      r.classification === 'live' && includes(['observing', 'risk', 'constrained'], r.state);
    var ageGrowth = r.sourceAgeTrendSecondsPerSecond === null || r.observationSeconds === null ? null :
      r.sourceAgeTrendSecondsPerSecond * Math.min(60, r.observationSeconds);
    var noise = r.gapStddevSeconds === null ? null : 2 + 2 * r.gapStddevSeconds;
    var blocking = evidence && (r.recommendationStatus === 'insufficient-throughput' ||
      r.deliveryToStreamRatio !== null && r.deliveryToStreamRatio < .99 && ageGrowth !== null && noise !== null && ageGrowth > noise);
    // A modest growing backlog may be too young to diagnose a sustained
    // deficit, but already too uncertain to authorize a one-time acceleration.
    var uncertainShortfall = r.deliveryToStreamRatio !== null && r.deliveryToStreamRatio < .99 &&
      r.sourceAgeTrendSecondsPerSecond !== null && r.sourceAgeTrendSecondsPerSecond > 0 &&
      ageGrowth !== null && r.gapStddevSeconds !== null && ageGrowth > .25 + 2 * r.gapStddevSeconds;
    var supported = r.candidateDelaySeconds !== null && r.reserveSeconds !== null && r.reserveSeconds <= MAX_RESERVE;
    var eligible = evidence && !blocking && !uncertainShortfall && includes(['observing', 'risk'], r.state) &&
      r.recommendationStatus === 'unvalidated-candidate' && r.sourceAgeTrendSecondsPerSecond !== null &&
      r.deliveryToStreamRatio !== null && r.gapStddevSeconds !== null && supported;
    return { eligible: eligible, blocking: blocking,
      reason: blocking ? 'sustained-delivery-deficit' : eligible ? 'verified-delivery' : 'need-fresh-live-observations' };
  }
  function reportFromMeasurement(m, atSourceMs) {
    if (!m || typeof m !== 'object' || !timestamp(atSourceMs)) return null;
    var recommendation = m.recommendation || {};
    var r = { version: 1, atSourceMs: atSourceMs,
      state: includes(states, m.state) ? m.state : 'insufficient-data',
      classification: includes(classifications, m.classification) ? m.classification : 'unknown',
      observationSeconds: metric(m.observationSeconds, 0, 61),
      recordCount: integer(m.recordCount, 0, 128) ? m.recordCount : 0,
      lastProgressAgeSeconds: metric(m.lastProgressAgeSeconds, 0, 86400),
      routeAgeSeconds: metric(m.routeAgeSeconds, 0, 86400),
      gapP95Seconds: metric(m.gapP95Seconds, 0, 60), gapStddevSeconds: metric(m.gapStddevSeconds, 0, 60),
      deliveryToStreamRatio: metric(m.deliveryToStreamRatio, 0, 100),
      sourceAgeTrendSecondsPerSecond: metric(m.sourceAgeTrendSecondsPerSecond, -100, 100),
      recommendationStatus: includes(statuses, recommendation.status) ? recommendation.status : 'insufficient-data',
      candidateDelaySeconds: metric(recommendation.candidateInitialDelaySeconds, 6, 420),
      reserveSeconds: metric(recommendation.candidateReserveSeconds, 4, 60) };
    var outcome = reportOutcome(r);
    r.eligible = outcome.eligible; r.blocking = outcome.blocking; r.reason = outcome.reason;
    return r;
  }
  function validReport(r, atSourceMs) {
    if (!r || r.version !== 1 || !timestamp(r.atSourceMs) || !timestamp(atSourceMs) ||
        r.atSourceMs > atSourceMs + 1000 || atSourceMs - r.atSourceMs > MAX_REPORT_AGE_SECONDS * 1000 ||
        !includes(states, r.state) || !includes(classifications, r.classification) || !includes(statuses, r.recommendationStatus) ||
        !nullable(r.observationSeconds, 0, 61) || !integer(r.recordCount, 0, 128) ||
        !nullable(r.lastProgressAgeSeconds, 0, 86400) || !nullable(r.routeAgeSeconds, 0, 86400) ||
        !nullable(r.gapP95Seconds, 0, 60) || !nullable(r.gapStddevSeconds, 0, 60) ||
        !nullable(r.deliveryToStreamRatio, 0, 100) || !nullable(r.sourceAgeTrendSecondsPerSecond, -100, 100) ||
        !nullable(r.candidateDelaySeconds, 6, 420) || !nullable(r.reserveSeconds, 4, 60)) return false;
    var outcome = reportOutcome(r);
    if (r.eligible !== outcome.eligible || r.blocking !== outcome.blocking || r.reason !== outcome.reason) return false;
    // Forwarding must age the original observation, never refresh it. A report
    // that was fresh when written may already be unusable at the source.
    if (r.eligible || r.blocking) {
      var currentProgressAge = r.lastProgressAgeSeconds + Math.max(0, atSourceMs - r.atSourceMs) / 1000;
      if (currentProgressAge > Math.min(MAX_REPORT_AGE_SECONDS, Math.max(3, (r.gapP95Seconds || 2) * 1.5))) return false;
    }
    return true;
  }

  function Policy(options) {
    options = options || {};
    if (!timestamp(options.epoch) || options.fallbackDelaySeconds !== undefined && options.fallbackDelaySeconds !== 300 ||
        options.version !== undefined && options.version !== 1 && options.version !== 2) throw new Error('Unsupported common-start settings.');
    this.epoch = options.epoch; this.fallbackDelaySeconds = 300;
    this.state = 'observing'; this.reason = 'need-fresh-live-observations'; this.decision = null;
    this.version = options.version || 1; this.observationStartedAt = null; this._preview = null; this._previewCount = 0;
  }
  Policy.prototype._decide = function (sourceNowMs, delaySeconds, reserveSeconds, reason) {
    this.state = 'decided'; this.reason = reason;
    this.decision = Object.freeze({ type: 'common-start', version: 1, decisionNumber: 1,
      delaySeconds: delaySeconds, reserveSeconds: reserveSeconds, issuedAt: sourceNowMs,
      startsAt: this.epoch + delaySeconds * 1000, reason: reason });
    return this.decision;
  };
  Policy.prototype.update = function (input) {
    input = input || {};
    if (this.decision) return this.decision;
    if (this.version === 2) return this._updateV2(input);
    var sourceNow = input.sourceNowMs;
    if (!timestamp(sourceNow) || sourceNow < this.epoch) return null;
    var elapsed = (sourceNow - this.epoch) / 1000;
    if (input.unsupportedPeer === true) return this._decide(sourceNow, 300, 6, 'unsupported-peer');
    var reports = Array.isArray(input.reports) && input.reports.length <= MAX_REPORTS ? input.reports : [];
    var all = [input.hostReport].concat(reports), valid = [], complete = input.hasViewers === true && reports.length > 0;
    for (var i = 0; i < all.length; i++) {
      var report = all[i];
      if (!validReport(report, sourceNow)) { complete = false; continue; }
      if (report.blocking) return this._decide(sourceNow, 300, 6, 'sustained-delivery-deficit');
      if (!report.eligible) complete = false;
      else valid.push(report);
    }
    // The source deadline wins over fresh evidence first arriving on that tick.
    if (elapsed >= DEADLINE_SECONDS) return this._decide(sourceNow, 300, 6, 'observation-timeout');
    if (!complete || input.hostReady !== true || elapsed < 20) return null;
    var minimum = input.hostMinimumReserveSeconds === undefined ? 4 : input.hostMinimumReserveSeconds;
    if (!bounded(minimum, 4, MAX_RESERVE)) return null;
    var delay = Math.max(MIN_DELAY, elapsed + LEAD_SECONDS), reserve = Math.ceil(minimum);
    for (var j = 0; j < valid.length; j++) {
      delay = Math.max(delay, valid[j].candidateDelaySeconds);
      reserve = Math.max(reserve, Math.ceil(valid[j].reserveSeconds));
    }
    delay = Math.ceil(delay / 2) * 2;
    if (delay > MAX_DELAY) return this._decide(sourceNow, 300, 6, 'candidate-exceeds-limit');
    return this._decide(sourceNow, delay, reserve, 'verified-delivery');
  };
  Policy.prototype.preview = function () { return this._preview; };
  Policy.prototype._decideV2 = function (sourceNow, delay, reserve, reason, preview) {
    var startsAt = preview ? preview.startsAt : Math.max(this.epoch + delay * 1000, sourceNow + LEAD_SECONDS * 1000);
    var programmeTime = preview ? preview.programmeTime : (startsAt - this.epoch) / 1000 - delay;
    this.state = 'decided'; this.reason = reason; this._preview = null;
    this.decision = Object.freeze({ type: 'common-start', version: 2, decisionNumber: 1, delaySeconds: delay,
      reserveSeconds: reserve, issuedAt: sourceNow, startsAt: startsAt, programmeTime: programmeTime,
      observationStartedAt: this.observationStartedAt, reason: reason });
    return this.decision;
  };
  Policy.prototype._updateV2 = function (input) {
    var sourceNow = input.sourceNowMs;
    if (!timestamp(sourceNow) || sourceNow < this.epoch) return null;
    if (this.observationStartedAt === null) {
      if (input.hasViewers !== true) return null;
      this.observationStartedAt = sourceNow;
    }
    if (sourceNow < this.observationStartedAt) return null;
    if (input.unsupportedPeer === true) return this._decideV2(sourceNow, 300, 6, 'unsupported-peer');
    var reports = Array.isArray(input.reports) && input.reports.length <= MAX_REPORTS ? input.reports : [];
    var all = [input.hostReport].concat(reports), complete = input.hasViewers === true && reports.length > 0;
    var delay = MIN_DELAY, minimum = input.hostMinimumReserveSeconds === undefined ? 4 : input.hostMinimumReserveSeconds;
    var minimumProgramme = input.minimumProgrammeTime === undefined ? 0 : input.minimumProgrammeTime;
    var reserve = bounded(minimum, 4, MAX_RESERVE) ? Math.ceil(minimum) : null;
    if (reserve === null || !bounded(minimumProgramme, 0, (sourceNow - this.epoch) / 1000)) complete = false;
    for (var i = 0; i < all.length; i++) {
      var report = all[i];
      if (!validReport(report, sourceNow)) { complete = false; continue; }
      if (report.blocking) return this._decideV2(sourceNow, 300, 6, 'sustained-delivery-deficit');
      if (!report.eligible) complete = false;
      else { delay = Math.max(delay, report.candidateDelaySeconds); reserve = Math.max(reserve || 4, Math.ceil(report.reserveSeconds)); }
    }
    if (sourceNow - this.observationStartedAt >= DEADLINE_SECONDS * 1000) return this._decideV2(sourceNow, 300, 6, 'observation-timeout');
    delay = Math.ceil(delay / 2) * 2;
    if (complete && delay > MAX_DELAY) return this._decideV2(sourceNow, 300, 6, 'candidate-exceeds-limit');
    // Revoke a prepared candidate if its supporting evidence, reserve or delay
    // requirement changes. Never slide a live preview's programme position.
    if (this._preview && (!complete || reserve > this._preview.reserveSeconds || delay > this._preview.delaySeconds ||
        sourceNow > this._preview.startsAt - LEAD_SECONDS * 1000)) this._preview = null;
    if (!complete || sourceNow - this.observationStartedAt < 20000) { this.state = 'observing'; return null; }
    if (!this._preview) {
      if (this._previewCount >= MAX_PREVIEWS) { this.state = 'observing'; return null; }
      var startsAt = Math.max(this.epoch + delay * 1000, sourceNow + PREVIEW_LEAD_SECONDS * 1000,
        this.epoch + (minimumProgramme + delay) * 1000);
      var programmeTime = (startsAt - this.epoch) / 1000 - delay;
      this._preview = Object.freeze({ version: 2, revision: ++this._previewCount, delaySeconds: delay, reserveSeconds: reserve,
        programmeTime: programmeTime, startsAt: startsAt,
        observationStartedAt: this.observationStartedAt });
    }
    this.state = 'preparing';
    var candidate = this._preview;
    if (input.hostReady !== true || !number(input.preparedProgrammeTime) ||
        Math.abs(input.preparedProgrammeTime - candidate.programmeTime) > .001) return null;
    return this._decideV2(sourceNow, candidate.delaySeconds, candidate.reserveSeconds, 'verified-delivery', candidate);
  };
  Policy.prototype.snapshot = function () {
    return { state: this.state, reason: this.reason, epoch: this.epoch, fallbackDelaySeconds: this.fallbackDelaySeconds,
      deadlineAtSourceMs: this.version === 2 ? this.observationStartedAt === null ? null : this.observationStartedAt + DEADLINE_SECONDS * 1000 : this.epoch + DEADLINE_SECONDS * 1000,
      version: this.version, observationStartedAt: this.observationStartedAt, preview: this._preview ? Object.assign({}, this._preview) : null,
      decision: this.decision ? Object.assign({}, this.decision) : null };
  };
  root.SameEndCommonStart = { canonicalDecision: canonicalDecision, validateDecision: validateDecision,
    reportFromMeasurement: reportFromMeasurement, validReport: validReport, Policy: Policy,
    DEADLINE_SECONDS: DEADLINE_SECONDS, MAX_REPORT_AGE_SECONDS: MAX_REPORT_AGE_SECONDS,
    MIN_DELAY_SECONDS: MIN_DELAY, MAX_DELAY_SECONDS: MAX_DELAY, MAX_RESERVE_SECONDS: MAX_RESERVE, MAX_REPORTS: MAX_REPORTS,
    PREVIEW_LEAD_SECONDS: PREVIEW_LEAD_SECONDS, MAX_PREVIEWS: MAX_PREVIEWS };
}(typeof window !== 'undefined' ? window : this));
