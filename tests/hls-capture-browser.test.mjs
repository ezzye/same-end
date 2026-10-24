/* Generated standard HLS/CMAF evidence, using the maintained muxer and real browser encoders. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = await import(process.env.SAMEEND_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'); }
const captureSeconds = Number(process.env.CAPTURE_SECONDS || 32);
assert(Number.isFinite(captureSeconds) && captureSeconds >= 32 && captureSeconds <= 240, 'CAPTURE_SECONDS must be between 32 and 240.');
const root = new URL('../', import.meta.url);
const out = new URL((process.env.HLS_CAPTURE_DIR || 'privatework/hls-capture/').replace(/\/?$/, '/'), root);
assert.equal(out.protocol, 'file:', 'HLS_CAPTURE_DIR must be a local output directory.');
const minimumVideoFrames = Math.max(750, Math.floor(captureSeconds * 25 * .94));
const minimumAudioFrames = Math.max(1400, Math.floor(captureSeconds * 48000 / 1024 * .93));
await mkdir(out, { recursive: true });
const bundle = await build({ stdin: { contents: "import * as capture from './hls-capture.js'; import {encodeBundle} from './hls-protocol.js'; import {generatedSource} from './tests/helpers/hls-generated-source.js'; window.HLSCapture=capture; window.HLSEncodeBundle=encodeBundle; window.generatedSource=generatedSource;", resolveDir: root.pathname }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/capture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/capture.js' ? bundle.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><script src="/capture.js"></script>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await playwright.chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true });
const batches = [], errors = [];
try {
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('saveBatch', async batch => {
    // Preserve the exact production transport envelope from onBatch. Later
    // browser tests replay these bytes rather than recreating HLS with ffmpeg.
    const transportBytes = Buffer.from(batch.transportBase64, 'base64');
    const transport = { path: 'transport-' + String(batches.length).padStart(4, '0') + '.bin', bytes: transportBytes.length, sha256: createHash('sha256').update(transportBytes).digest('hex') };
    await writeFile(new URL(transport.path, out), transportBytes);
    const files = [];
    for (const file of batch.files) {
      assert.match(file.path, /^(master\.m3u8|playlist-\d+\.m3u8|init-\d+\.mp4|segment-\d+-\d+\.m4s)$/);
      const bytes = Buffer.from(file.base64, 'base64'); await writeFile(new URL(file.path, out), bytes);
      files.push({ path: file.path, mime: file.mime, bytes: bytes.length, start: file.start, duration: file.duration });
    }
    const { transportBase64, ...metadata } = batch;
    batches.push({ ...metadata, files, transport });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const capture = await page.evaluate(async captureSeconds => {
    const fixture = await generatedSource(), problems = [];
    const supported = await HLSCapture.canCapture(fixture.stream);
    const AudioEncoderSaved = window.AudioEncoder; window.AudioEncoder = undefined;
    const unsupported = await HLSCapture.canCapture(fixture.stream); window.AudioEncoder = AudioEncoderSaved;
    const encode = bytes => { let text = ''; for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte); return btoa(text); };
    let inFlight = 0, peakInFlight = 0;
    const epoch = Date.now(), start = performance.now();
    const producer = await HLSCapture.createCapture(fixture.stream, { epoch, onError: error => problems.push(error.message), async onBatch(batch) {
      inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
      try { await new Promise(resolve => setTimeout(resolve, 80)); await saveBatch({ ...batch, transportBase64: encode(HLSEncodeBundle(batch)), files: batch.files.map(file => ({ ...file, bytes: undefined, base64: encode(file.bytes) })) }); }
      finally { inFlight--; }
    } });
    await producer.ready; const readyMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, captureSeconds * 1000));
    await producer.close(); const after = producer.stats.batches;
    await producer.close(); await new Promise(resolve => setTimeout(resolve, 200));
    const result = { supported, unsupported, readyMs, problems, peakInFlight, noBatchesAfterClose: after === producer.stats.batches, frames: fixture.frames, stats: { ...producer.stats }, inputsStillLive: fixture.stream.getTracks().every(track => track.readyState === 'live'), audioIdentity: fixture.stream.getAudioTracks()[0] === fixture.audioTrack };
    await fixture.close(); return result;
  }, captureSeconds);
  assert.equal(capture.supported, true); assert.equal(capture.unsupported, false);
  assert(capture.readyMs < 1500, 'ready waited for a segment');
  assert.deepEqual(capture.problems, []); assert.equal(capture.peakInFlight, 1); assert.equal(capture.noBatchesAfterClose, true);
  assert(capture.frames > minimumVideoFrames); assert.equal(capture.inputsStillLive, true); assert.equal(capture.audioIdentity, true);
  assert.equal(capture.stats.status, 'closed'); assert.equal(capture.stats.retainedFiles, 0);
  assert.equal(capture.stats.videoEncoderConfigurations, 1, 'video encoder restarted');
  assert.equal(capture.stats.audioEncoderConfigurations, 1, 'audio encoder restarted');
  assert(capture.stats.peakPendingBytes < 16 * 1024 * 1024);
  assert(batches.length >= Math.floor(captureSeconds / 2) - 1); assert.equal(batches.at(-1).final, true);
  for (const batch of batches) {
    assert(batch.duration > 0 && batch.duration < 2.2, `segment batch duration ${batch.duration}`);
    assert(batch.files.some(file => file.path === 'master.m3u8'));
    assert(batch.files.some(file => file.path.startsWith('init-')));
    assert(batch.files.some(file => file.path.startsWith('playlist-') && Number.isFinite(file.start)));
    assert(batch.files.some(file => file.path.endsWith('.m4s')));
    assert(Number.isFinite(batch.playlistStart));
  }
  const checks = await page.evaluate(async () => {
    async function failureCase(mode) {
      const fixture = await generatedSource(); let errorCount = 0, lastError;
      const producer = await HLSCapture.createCapture(fixture.stream, { epoch: Date.now(), onBatch() { if (mode === 'stuck') return new Promise(() => {}); if (mode === 'delivery') throw new Error('fixture downstream failure'); }, onError(error) { errorCount++; lastError = error.message; } });
      await producer.ready;
      if (mode === 'encoder') { await new Promise(resolve => setTimeout(resolve, 500)); fixture.canvas.width = 642; fixture.canvas.height = 362; }
      if (mode === 'track') fixture.audioTrack.dispatchEvent(new Event('ended'));
      const deadline = performance.now() + 6500;
      while (!errorCount && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      await producer.close().catch(() => {}); await fixture.close();
      return { errorCount, lastError, stats: { ...producer.stats } };
    }
    return { delivery: await failureCase('delivery'), encoder: await failureCase('encoder'), track: await failureCase('track'), stuck: await failureCase('stuck') };
  });
  for (const [name, result] of Object.entries(checks)) {
    assert.equal(result.errorCount, 1, `${name} should report once: ${JSON.stringify(result)}`);
    assert.equal(result.stats.status, 'error'); assert.equal(result.stats.retainedFiles, 0);
  }
  assert.match(checks.delivery.lastError, /fixture downstream failure/);
  assert.match(checks.encoder.lastError, /dimension|size/i);
  assert.match(checks.track.lastError, /audio track ended/);
  assert.match(checks.stuck.lastError, /behind capture|timed out/);
  assert.deepEqual(errors, []);
  const master = new URL('master.m3u8', out).pathname;
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-allowed_extensions', 'ALL', '-show_streams', '-show_format', '-of', 'json', master], { encoding: 'utf8' }));
  assert(probe.streams.some(stream => stream.codec_name === 'h264')); assert(probe.streams.some(stream => stream.codec_name === 'aac'));
  const decoded = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-allowed_extensions', 'ALL', '-count_frames', '-show_streams', '-of', 'json', master], { encoding: 'utf8' }));
  const video = decoded.streams.find(stream => stream.codec_type === 'video'), audio = decoded.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.width, 1280); assert.equal(video.height, 720);
  assert.equal(video.profile, 'High');
  assert(Number(video.nb_read_frames) > minimumVideoFrames); assert(Number(audio.nb_read_frames) > minimumAudioFrames);
  // Independent full decoding verifies changing pictures and a sustained audible tone.
  const hashes = execFileSync('ffmpeg', ['-v', 'error', '-allowed_extensions', 'ALL', '-i', master, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const distinctPictures = new Set(hashes.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim())).size;
  assert(distinctPictures > Math.max(700, Math.floor(captureSeconds * 25 * .87)), 'moving picture was not preserved');
  // execFileSync returns stdout; use PCM samples for an explicit, independent signal measurement.
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-allowed_extensions', 'ALL', '-i', master, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: Math.ceil(captureSeconds * 8000 * 4 + 65536) });
  assert(pcm.length / 4 / 8000 >= captureSeconds - .5, 'decoded audio did not cover the requested duration');
  let sum = 0; for (let i = 0; i < pcm.length; i += 4) sum += pcm.readFloatLE(i) ** 2;
  const rms = Math.sqrt(sum / (pcm.length / 4)); assert(rms > 0.03, 'audio is silent');
  const summary = { captureSeconds, capture, checks, batchCount: batches.length, firstBatch: batches[0], finalBatch: batches.at(-1), decoded: { videoFrames: video.nb_read_frames, audioFrames: audio.nb_read_frames, distinctPictures, audioSeconds: pcm.length / 4 / 8000, audioRms: rms }, pageErrors: errors };
  await writeFile(new URL('evidence.json', out), JSON.stringify(summary, null, 2));
  await writeFile(new URL('batches.json', out), JSON.stringify(batches, null, 2));
  console.log(JSON.stringify(summary));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
