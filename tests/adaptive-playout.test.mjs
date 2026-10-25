import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePlayout, MAX_EXTRA_DELAY_SECONDS, contiguousRanges, headroomAt } from '../adaptive-playout.js';
import { VerifiedHlsCache, Player } from '../hls-player.js';
import { NativePlayer } from '../hls-native.js';
const range = (start, end) => [{ start, end }];
const input = (nominal, actual, end = actual + 12, extra = {}) => ({ nominal, actual, ready: true, cacheRanges: range(0, end), decoderRanges: range(0, end), now: nominal * 1000, ...extra });
const playing = (nominal = 20) => { const p = new AdaptivePlayout(); assert.equal(p.update(input(nominal, nominal)).play, true); return p; };

test('warmup never starts a future source; fresh capture has fresh state', () => {
  const p = new AdaptivePlayout();
  assert.equal(p.target(-3), -3); assert.equal(p.update(input(-2, 100)).play, false); assert.equal(p.phase, 'warmup');
  assert.equal(p.update(input(0, 0, 3.9)).play, false); assert.equal(p.bufferGoalSeconds, 4);
  assert.equal(p.update(input(1, 0, 8)).play, true); assert.equal(p.target(1, 0), 0);
  p.update(input(5, 1, 1, { underflow: true })); assert.equal(p.rebufferCount, 1);
  p.reset(); assert.equal(p.phase, 'warmup'); assert.equal(p.position, null); assert.equal(p.rebufferCount, 0); assert.equal(p.adaptiveSeekCount, 0);
});
test('startup freezes a chosen position while data arrives, not an ever moving nominal', () => {
  const p = new AdaptivePlayout(); p.target(30);
  for (let t = 30; t < 36; t++) { const result = p.update(input(t, 30, 33)); assert.equal(result.play, false); assert.equal(p.target(t, 30), 30); }
  assert.equal(p.update(input(36, 30, 38)).play, true); assert.equal(p.extraDelaySeconds, 6);
});
test('jitter, clock slips and low headroom do not pause or seek a healthy decoder', () => {
  const p = playing();
  for (let i = 1; i <= 1000; i++) {
    const actual = 20 + i / 10, nominal = actual + 2 + Math.sin(i) * .5;
    const action = p.update(input(nominal, actual, actual + .15, { cacheRanges: [] }));
    assert.equal(action.play, true); assert.equal(action.seek, null);
    assert.equal(p.target(nominal, actual), actual);
  }
  assert.equal(p.adaptiveSeekCount, 0); assert.equal(p.rebufferCount, 0);
});
test('a real underflow accumulates delay and requires useful contiguous decoder headroom', () => {
  const p = playing();
  assert.equal(p.update(input(24, 22, 22, { underflow: true })).play, false); assert.equal(p.phase, 'rebuffering'); assert.equal(p.rebufferCount, 1);
  for (let i = 0; i < 10; i++) assert.equal(p.update(input(25 + i, 22, 24)).play, false, 'one two-second fragment cannot cycle playback');
  assert.equal(p.target(35, 22), 22); assert.equal(p.extraDelaySeconds, 13);
  assert.equal(p.update(input(35, 22, 30, { decoderRanges: range(22, 24) })).play, false, 'cached future bytes alone are insufficient');
  assert.equal(p.update(input(35, 22, 30, { ready: false })).play, false, 'decoder readiness is required');
  assert.equal(p.update(input(35, 22, 30)).play, true); assert.equal(p.extraDelaySeconds, 13); assert.equal(p.adaptiveSeekCount, 0);
});
test('sample timestamp rounding does not make six useful seconds wait for another whole fragment', () => {
  const p = playing(); p.update(input(24, 22.021, 22.021, { underflow: true }));
  assert.equal(p.update(input(30, 22.021, 28, { cacheRanges: range(22, 30) })).play, true);
});
test('repeated genuine starvation increases buffer goal with a finite cap', () => {
  const p = playing();
  for (let i = 0; i < 20; i++) {
    const time = 21 + i * 2;
    assert.equal(p.update(input(time, time, time, { underflow: true })).play, false);
    assert(p.bufferGoalSeconds <= 10); assert(p.bufferGoalSeconds >= 6);
    assert.equal(p.update(input(time + 1, time, time + 12)).play, true);
  }
  assert.equal(p.bufferGoalSeconds, 10); assert.equal(p.rebufferCount, 20);
});
test('gaps split verified windows and recovery seeks once to a useful historical interval', () => {
  const p = playing(); p.update(input(24, 22, 22, { underflow: true }));
  const windows = contiguousRanges([{ start: 22, end: 24 }, { start: 26, end: 28 }, { start: 28, end: 34 }]);
  assert.equal(headroomAt(windows, 22), 2); assert.equal(headroomAt(windows, 25), 0);
  // Give the partially available old range its bounded repair opportunity.
  assert.equal(p.update(input(29, 22, 24, { cacheRanges: windows })).seek, null);
  const action = p.update(input(31, 22, 22, { cacheRanges: range(26, 38) }));
  assert.equal(action.seek, 26); p.seeked(31000);
  assert.equal(p.update(input(32, 22, 22, { cacheRanges: range(26, 38) })).seek, null);
  assert.equal(p.update(input(33, 26, 38, { cacheRanges: range(26, 38) })).play, true);
});
test('transient missing old media gets a repair grace; a permanent gap eventually recovers', () => {
  const p = playing(); p.update(input(24, 22, 22, { underflow: true }));
  const future = range(26, 40);
  assert.equal(p.update(input(25, 22, 22, { cacheRanges: future })).seek, null);
  assert.equal(p.target(25, 22), 22);
  assert.equal(p.update(input(28, 22, 22, { cacheRanges: future })).seek, null);
  assert.equal(p.update(input(29, 22, 36)).play, true, 'late old media resumes without skipping');
  assert.equal(p.adaptiveSeekCount, 0); assert.equal(p.target(29, 22), 22);
  const permanent = playing(); permanent.update(input(24, 22, 22, { underflow: true }));
  assert.equal(permanent.update(input(25, 22, 22, { cacheRanges: future })).seek, null);
  assert.equal(permanent.update(input(31, 22, 22, { cacheRanges: future })).seek, 26);
});
test('partial old ranges recover after repair grace while timely fragment repair avoids a skip', () => {
  const partial = [{ start: 22, end: 24 }, { start: 26, end: 100 }];
  const p = playing(); p.update(input(24, 22, 22, { underflow: true }));
  for (const nominal of [25, 27, 29]) {
    const result = p.update(input(nominal, 22, 24, { cacheRanges: partial, decoderRanges: range(22, 24) }));
    assert.equal(result.play, false); assert.equal(result.seek, null); assert.equal(p.target(nominal, 22), 22);
  }
  const recovery = p.update(input(30, 22, 24, { cacheRanges: partial, decoderRanges: range(22, 24) }));
  assert.equal(recovery.seek, 26, 'two old seconds cannot strand recovery until the sixty-second limit');
  p.seeked(30000);
  assert.equal(p.update(input(31, 26, 40, { cacheRanges: partial, decoderRanges: range(26, 40) })).play, true);
  const repaired = playing(); repaired.update(input(24, 22, 22, { underflow: true }));
  assert.equal(repaired.update(input(28, 22, 24, { cacheRanges: partial })).seek, null);
  const restored = repaired.update(input(29, 22, 30, { cacheRanges: range(22, 100), decoderRanges: range(22, 30) }));
  assert.equal(restored.play, true); assert.equal(restored.seek, null); assert.equal(repaired.target(29, 22), 22); assert.equal(repaired.adaptiveSeekCount, 0);
});
test('suspension keeps its playhead; actual delay can exceed max while demand stays bounded', () => {
  const p = playing(); p.suspend(25, 21);
  assert.equal(p.phase, 'suspended'); assert.equal(p.target(110, 21), 50); assert.equal(p.extraDelaySeconds, 89);
  const action = p.update(input(110, 21, 21, { cacheRanges: range(50, 122) }));
  assert.equal(action.seek, 56); assert.equal(p.phase, 'recovering'); assert.equal(p.bufferGoalSeconds, 6);
  p.seeked(110000); assert.equal(p.update(input(111, 56, 75, { cacheRanges: range(50, 122) })).play, true);
  assert.equal(p.extraDelaySeconds, MAX_EXTRA_DELAY_SECONDS - 5);
  for (let i = 1; i <= 100; i++) {
    const result = p.update(input(111 + i / 10, 56 + i / 10, 100, { cacheRanges: range(50, 122) }));
    assert.equal(result.play, true); assert.equal(result.seek, null);
  }
});
test('stale outage waits for retained history and never substitutes live or future-only media', () => {
  const p = playing(); p.update(input(25, 22, 22, { underflow: true }));
  for (const cacheRanges of [[], range(0, 20), range(501, 540)]) {
    const result = p.update(input(200, 22, 22, { cacheRanges })); assert.equal(result.play, false); assert.equal(result.seek, null);
    assert.equal(p.target(200, 22), 140);
  }
  const result = p.update(input(200, 22, 22, { cacheRanges: range(180, 212) })); assert.equal(result.seek, 180); assert(result.seek <= 200); assert(result.seek >= 140);
});
test('a native decoder ahead of nominal must recover behind nominal before playing', () => {
  const p = new AdaptivePlayout(); p.target(30);
  const result = p.update(input(30, 40, 50)); assert.equal(result.play, false); assert.equal(result.seek, 30);
  p.seeked(30000); assert.equal(p.update(input(31, 30, 42)).play, true); assert.equal(p.adaptiveSeekCount, 1);
});
test('ready-one metadata identifies expired and indefinitely pending seeks for bounded retarget', () => {
  const p = playing();
  const first = p.update(input(116, 40, 40, { ready: false, seeking: true, cacheRanges: range(60, 100), now: 12000 }));
  assert.equal(first.play, false); assert.equal(first.seek, 60); p.seeked(12000);
  assert.equal(p.update(input(120, 40, 40, { ready: false, seeking: true, cacheRanges: range(60, 100), now: 16000 })).seek, null, 'pending seek cannot cycle faster than cooldown');
  const retry = p.update(input(124, 40, 40, { ready: false, seeking: true, cacheRanges: range(60, 100), now: 20000 }));
  assert.equal(retry.play, false); assert(retry.seek >= 64 && retry.seek <= 124); p.seeked(20000);
  assert.equal(p.update(input(125, retry.seek, 100, { ready: false, cacheRanges: range(60, 100), now: 21000 })).play, false, 'metadata never substitutes for decoded readiness');
  assert.equal(p.update(input(125, retry.seek, 100, { cacheRanges: range(60, 100), now: 22000 })).play, true);
  assert.equal(p.adaptiveSeekCount, 2);
});
test('mapped metadata playhead survives ready-one while visible programme time stays unavailable', () => {
  for (const C of [Player, NativePlayer]) {
    const p = Object.create(C.prototype); Object.assign(p, { closed: false, origin: 24, initialProgrammeStart: null, video: { readyState: 1, currentTime: 16.021332, seekable: { length: 0 } } });
    assert.equal(p.programTime(), null); assert.equal(p.playheadTime(), 40.021332);
    p.video.readyState = 0; assert.equal(p.playheadTime(), null);
    p.video.readyState = 1; p.closed = true; assert.equal(p.playheadTime(), null);
  }
});
test('MSE recovery preloads a real target window before seeking beyond old decoder duration', () => {
  const p = Object.create(Player.prototype), calls = [], writes = [];
  let time = 13, ranges = [[6, 16]];
  const buffered = { get length() { return ranges.length; }, start(i) { return ranges[i][0]; }, end(i) { return ranges[i][1]; } };
  const video = { readyState: 1, seeking: true, paused: true, playbackRate: 1, buffered, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, get currentTime() { return time; }, set currentTime(value) { writes.push(value); time = value; } };
  Object.assign(p, { video, adaptive: playing(31), cache: { target: null, listeners: new Set(), contiguousWindows: () => range(60, 90), contiguousAhead: target => headroomAt(range(60, 90), target) }, hls: { stopLoad() { calls.push(['stop']); }, startLoad(...args) { calls.push(['load', ...args]); } }, closed: false, started: true, origin: 24, presented: null, lastRecoveryAttempt: -Infinity, syncSeekRequests: 0 });
  assert.equal(p.sync(116).waiting, true); assert.equal(p.hls.recoveryLoading, true); assert.deepEqual(writes, []); assert.deepEqual(calls.at(-1), ['load', 36, true]); assert.equal(p.adaptive.adaptiveSeekCount, 0);
  ranges = [[6, 16], [36, 66]];
  assert.equal(p.sync(116.1).waiting, true); assert.deepEqual(writes, [36]); assert.equal(p.hls.recoveryLoading, false); assert.equal(p.adaptive.adaptiveSeekCount, 1);
  video.readyState = 2; video.seeking = false;
  assert.equal(p.sync(116.2).waiting, false); assert.equal(video.paused, false); assert.equal(p.programTime(), 60);
});
test('verified contiguous cache helpers require init and retain byte/time resource limits', () => {
  const c = new VerifiedHlsCache({ maxBytes: 4096, retainSeconds: 60 }); const bytes = text => new TextEncoder().encode(text);
  for (let i = 0; i < 500; i++) {
    const files = [{ path: 'video.m3u8', bytes: bytes('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + i + '\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\ns' + i + '.m4s\n') }, { path: 's' + i + '.m4s', bytes: bytes('segment') }];
    if (i > 0) files.push({ path: 'init.mp4', bytes: bytes('init') });
    c.add({ start: i * 2, duration: 2, playlistStart: i * 2, files });
    assert.equal(c.contiguousAhead(i * 2), i ? 2 : 0); assert(c.bytes <= 4096); assert(c.timeline.size <= 32); assert(c.files.size <= 34);
  }
  c.clear(); assert.deepEqual(c.contiguousWindows(), []); assert.equal(c.bytes, 0);
});
