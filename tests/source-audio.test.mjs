import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const source = await readFile(new URL('../source-audio.js', import.meta.url), 'utf8');

function harness({audioTracks = [{}], state = 'running'} = {}) {
  let now = 1000, timerFn = null, timerCleared = false, stopped = false;
  let ctx;
  class Track {
    constructor(options = {}) { this.readyState = options.readyState || 'live'; this.muted = !!options.muted; this.stopCalls = 0; this.handlers = new Map(); }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    removeEventListener(name, fn) { if (this.handlers.get(name) === fn) this.handlers.delete(name); }
    stop() { this.stopCalls++; }
  }
  const tracks = audioTracks.map(t => t instanceof Track ? t : new Track(t));
  class FakeStream { constructor(inputTracks) { this.tracks = inputTracks; } }
  class FakeAudioContext {
    constructor() { this.state = state; this.closeCalls = 0; this.resumeCalls = 0; ctx = this; }
    createAnalyser() {
      return {fftSize: 0, disconnected: false, bytes: new Uint8Array(1024).fill(128),
        getByteTimeDomainData(out) { out.set(this.bytes); }, disconnect() { this.disconnected = true; }};
    }
    createMediaStreamSource(stream) {
      this.input = stream;
      return {connections: [], disconnected: false, connect(node) { this.connections.push(node); }, disconnect() { this.disconnected = true; }};
    }
    resume() { this.resumeCalls++; this.state = 'running'; return Promise.resolve(); }
    close() { this.closeCalls++; this.state = 'closed'; return Promise.resolve(); }
  }
  const window = {};
  const context = createContext({window, Uint8Array, Date: {now: () => now},
    setInterval(fn) { timerFn = fn; return 1; }, clearInterval() { timerCleared = true; }});
  runInContext(source, context);
  const changes = [];
  const monitor = new window.SameEndSourceAudio.Monitor({getAudioTracks: () => tracks}, {
    onChange: state => changes.push(state), AudioContextCtor: FakeAudioContext, MediaStreamCtor: FakeStream,
    now: () => now, setIntervalFn: fn => { timerFn = fn; return 1; }, clearIntervalFn: () => { timerCleared = true; }
  });
  return {window, monitor, tracks, changes, context: () => ctx, tick(ms = 500) { now += ms; timerFn?.(); }, setByte(value) { monitor.analyser.bytes.fill(value); },
    stopped: () => stopped, timerCleared: () => timerCleared};
}

test('centred time-domain bytes represent exact silence and signal amplitude is measured around 128', () => {
  const api = harness().window.SameEndSourceAudio;
  assert.equal(api.rmsFromTimeDomain(new Uint8Array(128).fill(128)), 0);
  assert(api.rmsFromTimeDomain(new Uint8Array(128).fill(129)) > 0.001);
  assert.equal(api.classifyTimeDomain(new Uint8Array(128).fill(128), 14999).status, 'checking');
  assert.equal(api.classifyTimeDomain(new Uint8Array(128).fill(128), 15000).status, 'quiet');
  assert.equal(api.classifyTimeDomain(new Uint8Array(128).fill(129), 30000).status, 'sound');
});

test('monitor reports captured sound, continuous quiet after 15 seconds, then immediate recovery', () => {
  const h = harness();
  assert.equal(h.monitor.start().status, 'checking');
  for (let i = 0; i < 29; i++) h.tick(500);
  assert.equal(h.monitor.state.status, 'checking');
  h.tick(500);
  assert.equal(h.monitor.state.status, 'quiet');
  h.setByte(129); h.tick(500);
  assert.equal(h.monitor.state.status, 'sound');
  assert.equal(h.monitor.state.silenceSeconds, 0);
  assert(h.changes.some(x => x.status === 'quiet'));
  assert(h.changes.some(x => x.status === 'sound'));
});

test('suspended context is unavailable, and trusted resume clears the condition', async () => {
  const h = harness({state: 'suspended'});
  assert.equal(h.monitor.start().status, 'unavailable');
  assert.equal(h.monitor.state.reason, 'context-suspended');
  await h.monitor.resume();
  assert.equal(h.context().resumeCalls, 1);
  assert.equal(h.monitor.state.status, 'checking');
});

test('long timer gaps restart silence continuity instead of reporting background time as quiet', () => {
  const h = harness(); h.monitor.start();
  for (let i = 0; i < 5; i++) h.tick(500);
  h.tick(20000);
  assert.equal(h.monitor.state.status, 'checking');
  assert.equal(h.monitor.state.silenceSeconds, 0);
  for (let i = 0; i < 30; i++) h.tick(500);
  assert.equal(h.monitor.state.status, 'quiet');
});

test('missing and ended tracks are distinguished without creating an audio context', () => {
  const noTrack = harness({audioTracks: []});
  assert.deepEqual(JSON.parse(JSON.stringify(noTrack.monitor.start())), {status: 'no-track', silenceSeconds: 0, reason: 'no-track'});
  assert.equal(noTrack.context(), undefined);
  const ended = harness({audioTracks: [{readyState: 'ended'}]});
  assert.equal(ended.monitor.start().reason, 'track-ended');
});

test('unsupported Web Audio reports unavailable without throwing', () => {
  const h = harness();
  const unsupported = new h.window.SameEndSourceAudio.Monitor({getAudioTracks: () => h.tracks}, {
    AudioContextCtor: null, MediaStreamCtor: null,
    onChange() { throw new Error('monitor isolates consumer callback errors'); }
  });
  assert.equal(unsupported.start().status, 'unavailable');
  assert.equal(unsupported.state.reason, 'unsupported');
});

test('muted tracks are checking, with no analyser path to audible output', () => {
  const h = harness({audioTracks: [{muted: true}]});
  assert.equal(h.monitor.start().reason, 'track-muted');
  assert.deepEqual(h.monitor.source.connections, [h.monitor.analyser]);
  assert.equal('destination' in h.context(), false);
});

test('sustained all-track mute warns after 15 seconds and unmuted signal recovers immediately', () => {
  const h = harness({audioTracks: [{muted: true}]});
  h.monitor.start();
  for (let i = 0; i < 29; i++) h.tick(500);
  assert.equal(h.monitor.state.status, 'checking');
  assert.equal(h.monitor.state.reason, 'track-muted');
  h.tick(500);
  assert.equal(h.monitor.state.status, 'quiet');
  assert.equal(h.monitor.state.reason, 'track-muted');
  h.tracks[0].muted = false;
  h.setByte(129);
  h.tick(500);
  assert.equal(h.monitor.state.status, 'sound');
  assert.equal(h.monitor.state.reason, 'none');
});

test('suspended context clears silence continuity so resume does not inherit stale quiet time', async () => {
  const h = harness(); h.monitor.start();
  for (let i = 0; i < 28; i++) h.tick(500);
  assert.equal(h.monitor.state.silenceSeconds, 14);
  h.context().state = 'suspended';
  h.tick(500);
  assert.equal(h.monitor.state.status, 'unavailable');
  assert.equal(h.monitor.state.reason, 'context-suspended');
  for (let i = 0; i < 30; i++) h.tick(500);
  await h.monitor.resume();
  assert.equal(h.monitor.state.status, 'checking');
  assert.equal(h.monitor.state.silenceSeconds, 0);
});

test('repeated start keeps one analyser graph and one sampling timer', () => {
  const h = harness(); h.monitor.start();
  const source = h.monitor.source, analyser = h.monitor.analyser;
  h.monitor.start();
  assert.equal(h.monitor.source, source);
  assert.equal(h.monitor.analyser, analyser);
  assert.equal(h.context().input.tracks.length, 1);
});

test('close disconnects owned nodes and context but never stops captured tracks', () => {
  const h = harness(); h.monitor.start();
  const {source, analyser} = h.monitor;
  h.monitor.close();
  assert.equal(source.disconnected, true);
  assert.equal(analyser.disconnected, true);
  assert.equal(h.context().closeCalls, 1);
  assert.equal(h.timerCleared(), true);
  assert.equal(h.tracks[0].stopCalls, 0);
  assert.equal(h.monitor.closed, true);
});
