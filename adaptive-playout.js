/* Local, normal-rate playout. The room clock remains nominal; interruptions
 * add local delay rather than making a healthy decoder chase that clock. */
export const MAX_EXTRA_DELAY_SECONDS = 60;
export const STARTUP_BUFFER_SECONDS = 4;
export const REBUFFER_SECONDS = 6;
export const MAX_REBUFFER_SECONDS = 10;
const EPSILON = .08;

export function contiguousRanges(ranges, tolerance = EPSILON) {
  const sorted = ranges.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start).map(r => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const r of sorted) { const last = merged[merged.length - 1]; if (last && r.start <= last.end + tolerance) last.end = Math.max(last.end, r.end); else merged.push(r); }
  return merged;
}
export function headroomAt(ranges, position) {
  if (!Number.isFinite(position)) return 0;
  const range = ranges.find(r => position >= r.start - EPSILON && position < r.end);
  return range ? Math.max(0, range.end - Math.max(position, range.start)) : 0;
}
export function mediaRanges(timeRanges, origin = 0) {
  const ranges = [];
  if (Number.isFinite(origin)) for (let i = 0; i < timeRanges.length; i++) ranges.push({ start: origin + timeRanges.start(i), end: origin + timeRanges.end(i) });
  return contiguousRanges(ranges);
}

export class AdaptivePlayout {
  constructor() { this.reset(); }
  reset() {
    this.phase = 'warmup'; this.position = null; this.nominal = null; this.extraDelaySeconds = 0; this.bufferGoalSeconds = STARTUP_BUFFER_SECONDS;
    this.rebufferCount = 0; this.adaptiveSeekCount = 0; this.playAllowed = false; this.everPlayed = false; this.lastSeekAt = -Infinity; this.gapWaitSince = null;
  }
  target(nominal, actual = null) {
    if (!Number.isFinite(nominal)) return null;
    this.nominal = nominal;
    if (nominal < 0) { this.extraDelaySeconds = 0; return nominal; }
    // During startup/recovery retain the selected position until it is ready.
    // During ordinary playback the actual decoder is the local clock.
    if (this.position === null) this.position = nominal;
    if (this.phase === 'playing' && Number.isFinite(actual)) this.position = actual;
    this.extraDelaySeconds = Math.max(0, nominal - (Number.isFinite(actual) && this.everPlayed ? actual : this.position));
    return Math.max(0, nominal - MAX_EXTRA_DELAY_SECONDS, Math.min(nominal, this.position));
  }
  suspend(nominal, actual = null) {
    this.target(nominal, actual);
    if (Number.isFinite(actual) && this.everPlayed) this.position = actual;
    this.phase = 'suspended'; this.playAllowed = false;
  }
  seeked(now) { this.lastSeekAt = now; this.adaptiveSeekCount++; }
  update({ nominal, actual = null, cacheRanges = [], decoderRanges = [], ready = false, seeking = false, underflow = false, hidden = false, now = 0 }) {
    this.target(nominal, actual);
    const result = (play = false, seek = null) => { this.playAllowed = play; return { play, seek, target: this.position, phase: this.phase, waiting: !play, drift: Number.isFinite(actual) ? nominal - actual : null }; };
    if (hidden) { this.suspend(nominal, actual); return result(); }
    if (nominal < 0) { this.phase = 'warmup'; this.position = null; return result(); }
    if (this.phase === 'warmup') this.phase = 'starting';
    if (this.phase === 'suspended') { this.phase = this.everPlayed ? 'rebuffering' : 'starting'; if (this.everPlayed) this.bufferGoalSeconds = Math.max(REBUFFER_SECONDS, this.bufferGoalSeconds); }
    const ahead = headroomAt(decoderRanges, actual);
    // A low buffer alone is not starvation. Keep running while the decoder can
    // consume samples, even if the corresponding old cache entry was pruned.
    const tooOld = Number.isFinite(actual) && nominal - actual > MAX_EXTRA_DELAY_SECONDS;
    const tooNew = Number.isFinite(actual) && actual > nominal + .8;
    if (this.phase === 'playing' && !tooOld && !tooNew && !(underflow && ahead <= .25)) {
      if (Number.isFinite(actual)) this.position = actual;
      return result(!seeking);
    }
    if (this.phase === 'playing' && underflow && ahead <= .25) {
      this.phase = 'rebuffering'; this.rebufferCount++; this.gapWaitSince = now;
      this.bufferGoalSeconds = Math.min(MAX_REBUFFER_SECONDS, REBUFFER_SECONDS + Math.max(0, this.rebufferCount - 1) * 2);
      if (Number.isFinite(actual)) this.position = actual;
    }
    // Bound recovery to historical programme time. Lack of future media is a
    // wait condition, never permission to jump to the source's live edge.
    const desired = this.position;
    const atDesired = headroomAt(cacheRanges, desired);
    const desiredExpired = desired < nominal - MAX_EXTRA_DELAY_SECONDS;
    const desiredAhead = desired > nominal + .8;
    let candidate = desired;
    const insufficientHeadroom = atDesired + EPSILON < this.bufferGoalSeconds && headroomAt(decoderRanges, desired) + EPSILON < this.bufferGoalSeconds;
    if (desiredExpired || desiredAhead || insufficientHeadroom || this.phase === 'playing' && (tooOld || tooNew)) {
      // A missing peer fragment may simply be late. Preserve its playhead for
      // one useful rebuffer interval before considering a forward gap seek.
      if (this.everPlayed && !tooOld && !tooNew && !desiredExpired && !desiredAhead) {
        this.gapWaitSince ??= now;
        if (now - this.gapWaitSince < this.bufferGoalSeconds * 1000) return result();
      }
      // Leave a little room inside the bound so the next clock tick does
      // not immediately classify a just-recovered decoder as too old again.
      const lower = Math.max(0, nominal - MAX_EXTRA_DELAY_SECONDS + (desiredExpired || this.phase === 'playing' && tooOld ? this.bufferGoalSeconds : 0));
      const available = cacheRanges.map(r => ({ start: Math.max(lower, r.start), end: r.end })).filter(r => r.start <= nominal && r.end - r.start >= this.bufferGoalSeconds);
      // Prefer the old position when retained; otherwise use the earliest
      // useful window after it. A long outage recovers within the 60s bound.
      const preferred = desiredAhead ? nominal : Math.max(lower, desired);
      const found = available.find(r => Math.max(r.start, preferred) <= nominal && r.end - Math.max(r.start, preferred) >= this.bufferGoalSeconds) || available.find(r => r.start >= preferred);
      if (found) candidate = Math.min(nominal, Math.max(found.start, Math.min(preferred, found.end - this.bufferGoalSeconds)));
      else { if (tooOld || tooNew || desiredExpired || desiredAhead) this.phase = 'recovering'; return result(); }
      this.position = candidate; this.phase = 'recovering';
    }
    if (Number.isFinite(actual) && Math.abs(actual - candidate) > .8) {
      // A browser can leave an expired, out-of-buffer seek pending forever.
      // Mapped metadata time still identifies it; permit a bounded retarget.
      const cooledDown = now - this.lastSeekAt >= 8000;
      const staleSeek = seeking && this.phase === 'recovering' && (!ready || ahead <= .25) && cooledDown;
      if (headroomAt(cacheRanges, candidate) >= this.bufferGoalSeconds && (!seeking || staleSeek) && cooledDown) return result(false, candidate);
      return result();
    }
    if (!Number.isFinite(actual) || seeking || !ready || headroomAt(decoderRanges, actual) + EPSILON < this.bufferGoalSeconds || headroomAt(cacheRanges, candidate) < this.bufferGoalSeconds) return result();
    this.phase = 'playing'; this.everPlayed = true; this.position = actual; this.gapWaitSince = null;
    this.extraDelaySeconds = Math.max(0, nominal - actual);
    return result(true);
  }
  facts() { return { adaptivePhase: this.phase, extraDelaySeconds: this.extraDelaySeconds, bufferGoalSeconds: this.bufferGoalSeconds, rebufferCount: this.rebufferCount, adaptiveSeekCount: this.adaptiveSeekCount }; }
}
