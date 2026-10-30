import test from 'node:test';
import assert from 'node:assert/strict';
import Hls from 'hls.js';
import { Player } from '../hls-player.js';

function controlledPlayer({ actions, fatalType = null, recover = true } = {}) {
  const events = [];
  const video = {
    buffered: { length: 1, start: () => 0, end: () => 12 },
    readyState: 4, seeking: false, currentTime: 1, paused: true, playbackRate: 1,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
  const adaptiveActions = [...actions];
  const player = Object.create(Player.prototype);
  const hls = {
    recoveryLoading: false,
    startLoad(...args) { events.push(['startLoad', ...args]); },
    stopLoad() { events.push(['stopLoad']); },
    ...(recover ? { recoverMediaError() { events.push(['recoverMediaError']); } } : {}),
  };
  Object.assign(player, {
    closed: false, startupPreparation: null, startupHold: false, suspended: false,
    video, origin: 0, started: true, starved: false, hls,
    adaptive: {
      update() { return adaptiveActions.shift(); },
      target: target => target,
      seeked() { events.push(['adaptive.seeked']); },
      bufferGoalSeconds: 4,
    },
    cache: { contiguousWindows: () => [], contiguousAhead: () => 0, target: null },
    lastRecoveryAttempt: -Infinity, lastFatalType: fatalType,
    seekCount: 0, syncSeekRequests: 0, lastSeek: -Infinity, presented: null,
    bufferedOnce: false, play: () => { events.push(['play']); return Promise.resolve(); },
    playheadTime: () => 1,
    setPlaybackWindow(target) { this.nominalTarget = target; this.target = target; },
  });
  return { player, events, video };
}

const seek = { play: false, waiting: true, seek: 2 };
const wait = { play: false, waiting: true, seek: null };

test('fatal MEDIA_ERROR is reset before a recovery seek can consume it', () => {
  const { player, events, video } = controlledPlayer({ actions: [seek], fatalType: Hls.ErrorTypes.MEDIA_ERROR });
  player.sync(5);
  assert.deepEqual(events, [['recoverMediaError']]);
  assert.equal(video.currentTime, 1, 'the adaptive seek waits until the media reset completes');
  assert.equal(player.lastFatalType, null);
});

test('MEDIA_ERROR survives cooldown and is retried before seeking', () => {
  const { player, events, video } = controlledPlayer({ actions: [seek, wait], fatalType: Hls.ErrorTypes.MEDIA_ERROR });
  player.lastRecoveryAttempt = performance.now() - 1000;
  player.sync(5);
  assert.deepEqual(events, []);
  assert.equal(video.currentTime, 1);
  assert.equal(player.lastFatalType, Hls.ErrorTypes.MEDIA_ERROR);
  player.lastRecoveryAttempt = performance.now() - 6000;
  player.sync(5);
  assert.deepEqual(events, [['recoverMediaError']]);
  assert.equal(player.lastFatalType, null);
});

test('missing recoverMediaError does not throw, load around the decoder error, or lose it', () => {
  const { player, events, video } = controlledPlayer({ actions: [seek], fatalType: Hls.ErrorTypes.MEDIA_ERROR, recover: false });
  assert.doesNotThrow(() => player.sync(5));
  assert.deepEqual(events, []);
  assert.equal(video.currentTime, 1);
  assert.equal(player.lastFatalType, Hls.ErrorTypes.MEDIA_ERROR);
});

test('a pending MEDIA_ERROR blocks adaptive playback during cooldown', () => {
  const { player, events, video } = controlledPlayer({
    actions: [{ play: true, waiting: false, seek: null }],
    fatalType: Hls.ErrorTypes.MEDIA_ERROR,
  });
  player.lastRecoveryAttempt = performance.now() - 1000;
  const result = player.sync(5);
  assert.deepEqual(result, { waiting: true, drift: undefined, playing: false });
  assert.deepEqual(events, []);
  assert.equal(video.paused, true);
  assert.equal(player.lastFatalType, Hls.ErrorTypes.MEDIA_ERROR);
});

test('missing media reset API still blocks adaptive playback without throwing', () => {
  const { player, events, video } = controlledPlayer({
    actions: [{ play: true, waiting: false, seek: null }],
    fatalType: Hls.ErrorTypes.MEDIA_ERROR,
    recover: false,
  });
  assert.doesNotThrow(() => player.sync(5));
  assert.deepEqual(events, []);
  assert.equal(video.paused, true);
  assert.equal(player.lastFatalType, Hls.ErrorTypes.MEDIA_ERROR);
});

test('a successful media reset also blocks same-tick adaptive playback', () => {
  const { player, events, video } = controlledPlayer({
    actions: [{ play: true, waiting: false, seek: null }],
    fatalType: Hls.ErrorTypes.MEDIA_ERROR,
  });
  const result = player.sync(5);
  assert.deepEqual(result, { waiting: true, drift: undefined, playing: false });
  assert.deepEqual(events, [['recoverMediaError']]);
  assert.equal(video.paused, true);
});

test('NETWORK_ERROR remains a loader restart and never invokes media reset', () => {
  const { player, events } = controlledPlayer({ actions: [seek], fatalType: Hls.ErrorTypes.NETWORK_ERROR });
  player.sync(5);
  assert.deepEqual(events, [['adaptive.seeked'], ['startLoad', 2, true]]);
  assert.equal(player.lastFatalType, null);
});

test('healthy buffered playback does not trigger a media reset', () => {
  const { player, events } = controlledPlayer({ actions: [{ play: true, waiting: false, seek: null }] });
  player.sync(5);
  assert.deepEqual(events, [['play']]);
});

test('closed, startup-preparing, and startup-held players do not reset media', () => {
  for (const gate of ['closed', 'startupPreparation', 'startupHold']) {
    const { player, events } = controlledPlayer({ actions: [seek], fatalType: Hls.ErrorTypes.MEDIA_ERROR });
    if (gate === 'closed') player.closed = true;
    if (gate === 'startupPreparation') player.startupPreparation = { target: 5, reserve: 4 };
    if (gate === 'startupHold') player.startupHold = true;
    player.sync(5);
    assert.equal(events.some(event => event[0] === 'recoverMediaError'), false, `${gate} gate must remain ahead of media recovery`);
    if (gate !== 'startupPreparation') assert.deepEqual(events, []);
    assert.equal(player.lastFatalType, Hls.ErrorTypes.MEDIA_ERROR);
  }
});
