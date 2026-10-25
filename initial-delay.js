(function (root) {
  'use strict';
  // Admission is deliberately separate from the signed room configuration and
  // from adaptive recovery. One prepared programme position, one commitment.
  var MAX_RESERVE = 12, MAX_PREPARATION_MS = 8000, MAX_OBSERVATION_MS = 60000;
  function finite(value) { return typeof value === 'number' && isFinite(value); }
  function Policy(options) {
    options = options || {};
    this.enabled = options.enabled === true;
    this.roomDelaySeconds = finite(options.roomDelaySeconds) ? options.roomDelaySeconds : 300;
    this.state = this.enabled ? 'observing' : 'disabled';
    this.reason = this.enabled ? 'need-fresh-live-observations' : 'feature-disabled';
    this.selectedDelaySeconds = this.roomDelaySeconds;
    this.candidateDelaySeconds = null; this.reserveGoalSeconds = null;
    this.targetProgramTime = null; this.preparedAtMs = null;
    this.observationStartedAtMs = null;
    this.sharedStartDueAtMs = null;
    this.committedAtSourceMs = null; this.committedAtMs = null; this.committedProgramTime = null;
    this.commitCount = 0;
  }
  Policy.prototype.fallback = function (reason) {
    if (this.state !== 'committed') { this.state = 'fallback'; this.reason = reason; }
  };
  Policy.prototype.update = function (input) {
    input = input || {};
    if (this.state === 'disabled' || this.state === 'fallback' || this.state === 'committed') return;
    var preparing = this.state === 'preparing', m = input.measurement, r = m && m.recommendation;
    if (input.everPlayed) { this.fallback('playback-already-started'); return; }
    if (!finite(input.nowMs) || !finite(input.sourceNowMs) || !finite(input.epoch)) { if (preparing) this.fallback('preparation-clock-unknown'); return; }
    if (this.observationStartedAtMs === null) this.observationStartedAtMs = input.nowMs;
    var elapsed = (input.sourceNowMs - input.epoch) / 1000;
    if (preparing && (elapsed < this.candidateDelaySeconds || elapsed - this.targetProgramTime - this.roomDelaySeconds > 60)) { this.fallback('preparation-outside-group-bound'); return; }
    if (elapsed >= this.roomDelaySeconds && this.sharedStartDueAtMs === null) this.sharedStartDueAtMs = input.nowMs;
    if (!preparing && this.sharedStartDueAtMs !== null && input.nowMs - this.sharedStartDueAtMs >= MAX_OBSERVATION_MS) { this.fallback('observation-timeout'); return; }
    if (!input.healthy) { if (preparing) this.fallback('preparation-route-interrupted'); return; }
    if (m && m.observationSeconds >= 20 &&
        (r && r.status === 'insufficient-throughput' ||
         finite(m.deliveryToStreamRatio) && m.deliveryToStreamRatio < .99 &&
         finite(m.sourceAgeTrendSecondsPerSecond) && m.sourceAgeTrendSecondsPerSecond > .025)) {
      this.fallback('sustained-delivery-deficit'); return;
    }
    var fresh = m && finite(m.lastProgressAgeSeconds) && m.lastProgressAgeSeconds <= Math.max(3, (m.gapP95Seconds || 2) * 1.5);
    var eligible = m && r && r.status === 'unvalidated-candidate' && m.classification === 'live' &&
      (m.state === 'observing' || m.state === 'risk') && m.recordCount >= 6 && m.observationSeconds >= 20 && fresh &&
      finite(m.sourceAgeTrendSecondsPerSecond) && finite(r.candidateInitialDelaySeconds) && finite(r.candidateReserveSeconds);
    if (!eligible) { if (preparing) this.fallback('preparation-evidence-revoked'); return; }
    if (r.candidateReserveSeconds < 4 || r.candidateReserveSeconds > MAX_RESERVE) { this.fallback('unsupported-reserve-goal'); return; }
    var candidate = Math.max(this.roomDelaySeconds, r.candidateInitialDelaySeconds);
    if (r.candidateInitialDelaySeconds < 6 || r.candidateInitialDelaySeconds > 420 || candidate > this.roomDelaySeconds + 60) { this.fallback('candidate-exceeds-group-bound'); return; }
    if (preparing) {
      if (input.nowMs - this.preparedAtMs > MAX_PREPARATION_MS) this.fallback('decoder-preparation-timeout');
      else if (r.candidateReserveSeconds > this.reserveGoalSeconds) this.fallback('preparation-reserve-increased');
      return;
    }
    this.candidateDelaySeconds = candidate; this.reserveGoalSeconds = r.candidateReserveSeconds;
    var target = elapsed - candidate;
    if (target < 0) return;
    this.state = 'preparing'; this.reason = 'checking-verified-decoder-headroom';
    this.targetProgramTime = target; this.preparedAtMs = input.nowMs; this._epoch = input.epoch;
  };
  Policy.prototype.canCommit = function (facts) {
    if (this.state !== 'preparing' || !facts || !finite(facts.minimumReserveSeconds)) return false;
    if (facts.minimumReserveSeconds > MAX_RESERVE) { this.fallback('unsupported-native-reserve'); return false; }
    var goal = Math.max(this.reserveGoalSeconds, facts.minimumReserveSeconds);
    return facts.ready === true && facts.aligned === true && finite(facts.programTime) && facts.cacheAheadSeconds + .001 >= goal && facts.decoderAheadSeconds + .08 >= goal;
  };
  Policy.prototype.commit = function (facts, sourceNowMs, nowMs) {
    if (!finite(sourceNowMs) || !this.canCommit(facts)) return false;
    var elapsed = (sourceNowMs - this._epoch) / 1000;
    if (elapsed < this.candidateDelaySeconds || elapsed - this.targetProgramTime - this.roomDelaySeconds > 60) { this.fallback('preparation-outside-group-bound'); return false; }
    this.state = 'committed'; this.reason = 'verified-decoder-headroom';
    this.selectedDelaySeconds = this.candidateDelaySeconds;
    this.reserveGoalSeconds = Math.max(this.reserveGoalSeconds, facts.minimumReserveSeconds);
    this.committedAtSourceMs = sourceNowMs; this.committedAtMs = finite(nowMs) ? nowMs : null; this.committedProgramTime = facts.programTime;
    this.commitCount++; return true;
  };
  Policy.prototype.snapshot = function (sourceNowMs, epoch, programTime) {
    return { enabled: this.enabled, applied: this.state === 'committed', state: this.state, reason: this.reason,
      roomDelaySeconds: this.roomDelaySeconds, selectedDelaySeconds: this.selectedDelaySeconds,
      candidateDelaySeconds: this.candidateDelaySeconds, reserveGoalSeconds: this.reserveGoalSeconds,
      targetProgramTime: this.targetProgramTime, committedAtMs: this.committedAtMs, committedAtSourceMs: this.committedAtSourceMs,
      committedProgramTime: this.committedProgramTime, commitCount: this.commitCount,
      actualDelaySeconds: finite(sourceNowMs) && finite(epoch) && finite(programTime) ? Math.max(0, (sourceNowMs - epoch) / 1000 - programTime) : null };
  };
  root.SameEndInitialDelay = { Policy: Policy, MAX_RESERVE_SECONDS: MAX_RESERVE, MAX_PREPARATION_MS: MAX_PREPARATION_MS };
}(typeof window !== 'undefined' ? window : this));
