/* Private generated-media capture check; no device, microphone or external media. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = await import(process.env.SAMEEND_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'); }
const root = new URL('../', import.meta.url), out = new URL('privatework/capture-normalize-test/', root);
await mkdir(out, { recursive: true });
const helper = await readFile(new URL('capture-normalize.js', root), 'utf8');
const native = await readFile(new URL('native-mp4.js', root), 'utf8');
const browser = await playwright.chromium.launch({ ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}), headless: true });
const saved = [];
try {
  const page = await browser.newPage(), pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('about:blank'); await page.addScriptTag({ content: helper });
  await page.exposeFunction('savePiece', async ({ seq, base64, meta }) => {
    const file = `piece-${seq}.mp4`, bytes = Buffer.from(base64, 'base64');
    await writeFile(new URL(file, out), bytes);
    saved.push({ file, meta, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  });
  const checks = await page.evaluate(async () => {
    const limited = { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false };
    async function oneFrame(frame) {
      const source = new MediaStreamTrackGenerator({ kind: 'video' });
      const write = source.writable.getWriter();
      const normalized = SameEndCapture.normalize(new MediaStream([source]));
      const read = new MediaStreamTrackProcessor({ track: normalized.stream.getVideoTracks()[0] }).readable.getReader();
      const pending = read.read(); await write.write(frame); frame.close();
      const result = (await pending).value; await normalized.ready;
      const rgba = new Uint8Array(1280 * 720 * 4); await result.copyTo(rgba, { format: 'RGBA' });
      const info = { width: result.displayWidth, height: result.displayHeight, color: result.colorSpace.toJSON(), timestamp: result.timestamp, settings: normalized.stream.getVideoTracks()[0].getSettings(), stats: { ...normalized.stats }, rgba };
      result.close(); await read.cancel(); await normalized.close(); return info;
    }
    const exactData = new Uint8Array(1280 * 720 * 3 / 2); exactData.fill(16, 0, 1280 * 720);
    for (let y = 0; y < 720; y++) exactData.fill(235, y * 1280 + 640, y * 1280 + 1280);
    exactData.fill(128, 1280 * 720);
    const exact = await oneFrame(new VideoFrame(exactData, { format: 'I420', codedWidth: 1280, codedHeight: 720, timestamp: 40000, colorSpace: limited }));
    const pixel = (image, x, y) => image.rgba[(y * 1280 + x) * 4];
    const exactResult = { black: pixel(exact, 200, 360), white: pixel(exact, 1000, 360), width: exact.width, height: exact.height, timestamp: exact.timestamp, color: exact.color, resized: exact.stats.resized, targetFrameRate: exact.stats.targetFrameRate, settings: exact.settings };
    const small = new Uint8Array(640 * 480 * 3 / 2); small.fill(235, 0, 640 * 480); small.fill(128, 640 * 480);
    const resized = await oneFrame(new VideoFrame(small, { format: 'I420', codedWidth: 640, codedHeight: 480, timestamp: 80000, colorSpace: limited }));
    const resizeResult = { leftBar: pixel(resized, 10, 360), center: pixel(resized, 640, 360), rightBar: pixel(resized, 1270, 360), width: resized.width, height: resized.height, resized: resized.stats.resized };
    const cropData = new Uint8Array(4 * 2 * 4);
    for (let y=0;y<2;y++) for (let x=0;x<4;x++) {
      const p=(y*4+x)*4; cropData[p]=x<2?255:0; cropData[p+1]=x<2?0:255; cropData[p+3]=255;
    }
    const rotated = await oneFrame(new VideoFrame(cropData, { format:'RGBA', codedWidth:4, codedHeight:2, timestamp:120000,
      visibleRect:{x:1,y:0,width:2,height:2}, displayWidth:2, displayHeight:2, rotation:90 }));
    const colour = (image,x,y) => [...image.rgba.slice((y*1280+x)*4,(y*1280+x)*4+3)];
    const cropResult = { leftBar:colour(rotated,10,360), top:colour(rotated,640,150), bottom:colour(rotated,640,570), resized:rotated.stats.resized };
    const old = window.MediaStreamTrackProcessor; window.MediaStreamTrackProcessor = undefined;
    const unsupportedSource = new MediaStreamTrackGenerator({ kind: 'video' }), unsupportedStream = new MediaStream([unsupportedSource]);
    const unsupported = SameEndCapture.normalize(unsupportedStream); const unsupportedResult = { sameStream: unsupported.stream === unsupportedStream, ready: await unsupported.ready, status: unsupported.stats.status };
    await unsupported.close(); unsupportedResult.trackEnded = unsupportedSource.readyState === 'ended'; window.MediaStreamTrackProcessor = old;
    const badSource = new MediaStreamTrackGenerator({ kind: 'video' }), badWriter = badSource.writable.getWriter();
    const badAudio = new AudioContext(), destination = badAudio.createMediaStreamDestination();
    let errors = 0; const failing = SameEndCapture.normalize(new MediaStream([badSource, destination.stream.getAudioTracks()[0]]), { onError() { errors++; } });
    const tooWide = new VideoFrame(new Uint8Array(3842 * 2160 * 3 / 2), { format: 'I420', codedWidth: 3842, codedHeight: 2160, timestamp: 0, colorSpace: limited });
    await badWriter.write(tooWide).catch(() => {}); tooWide.close();
    let rejected = false; try { await failing.ready; } catch { rejected = true; }
    await failing.close();
    const failureResult = { rejected, errors, status: failing.stats.status, sourceEnded: badSource.readyState === 'ended', audioEnded: destination.stream.getAudioTracks()[0].readyState === 'ended' };
    await badAudio.close();
    const endedSource=new MediaStreamTrackGenerator({kind:'video'}), endedWriter=endedSource.writable.getWriter();
    let endedErrors=0;const endedCapture=SameEndCapture.normalize(new MediaStream([endedSource]),{onError(){endedErrors++;}});
    const endedReader=new MediaStreamTrackProcessor({track:endedCapture.stream.getVideoTracks()[0]}).readable.getReader();
    const firstEndedFrame=endedReader.read();
    const endedFrame=new VideoFrame(new Uint8Array(2*2*4),{format:'RGBA',codedWidth:2,codedHeight:2,timestamp:0});
    await endedWriter.write(endedFrame);endedFrame.close();(await firstEndedFrame).value.close();await endedCapture.ready;
    endedSource.dispatchEvent(new Event('ended'));await endedCapture.close();await endedReader.cancel().catch(()=>{});
    const endedResult={errors:endedErrors,status:endedCapture.stats.status,sourceEnded:endedSource.readyState==='ended',outputEnded:endedCapture.stream.getVideoTracks()[0].readyState==='ended'};
    const fastSource = new MediaStreamTrackGenerator({kind:'video'}), fastWriter=fastSource.writable.getWriter();
    const capped = SameEndCapture.normalize(new MediaStream([fastSource]));
    const fastReader = new MediaStreamTrackProcessor({track:capped.stream.getVideoTracks()[0]}).readable.getReader();
    const timestamps=[];
    const consume=(async()=>{for(let i=0;i<10;i++){const value=(await fastReader.read()).value;timestamps.push(value.timestamp);value.close();}})();
    for(let i=0;i<12;i++){
      const frame=new VideoFrame(new Uint8Array(2*2*4),{format:'RGBA',codedWidth:2,codedHeight:2,timestamp:i*33333,duration:33333});
      await fastWriter.write(frame);frame.close();
      await new Promise(resolve=>setTimeout(resolve,33));
    }
    await consume; await capped.ready; const capResult={timestamps,dropped:capped.stats.dropped,target:capped.stats.targetFrameRate};
    await fastReader.cancel(); await capped.close();
    const jitterSource=new MediaStreamTrackGenerator({kind:'video'}), jitterWriter=jitterSource.writable.getWriter();
    const jittered=SameEndCapture.normalize(new MediaStream([jitterSource]));
    const jitterReader=new MediaStreamTrackProcessor({track:jittered.stream.getVideoTracks()[0]}).readable.getReader();
    const jitterTimestamps=[];
    const receive=(async()=>{for(let i=0;i<8;i++){const value=(await jitterReader.read()).value;jitterTimestamps.push(value.timestamp);value.close();}})();
    for(let i=0;i<8;i++){
      const timestamp=i*40000+(i%2?-1000:1000);
      const frame=new VideoFrame(new Uint8Array(2*2*4),{format:'RGBA',codedWidth:2,codedHeight:2,timestamp,duration:40000});
      await jitterWriter.write(frame);frame.close();await new Promise(resolve=>setTimeout(resolve,40));
    }
    await receive;await jittered.ready;
    const jitterResult={timestamps:jitterTimestamps,dropped:jittered.stats.dropped};
    await jitterReader.cancel();await jittered.close();
    return { exactResult, resizeResult, cropResult, unsupportedResult, failureResult, endedResult, capResult, jitterResult };
  });
  assert(checks.exactResult.black <= 3 && checks.exactResult.white >= 252, 'actual limited pixels were not converted');
  assert.equal(checks.exactResult.resized, 0); assert.equal(checks.exactResult.timestamp, 40000);
  assert.equal(checks.exactResult.settings.width, 1280); assert.equal(checks.exactResult.settings.height, 720); assert.equal(checks.exactResult.targetFrameRate, 25);
  assert.equal(checks.exactResult.color.fullRange, true);
  assert(checks.resizeResult.leftBar <= 3 && checks.resizeResult.rightBar <= 3 && checks.resizeResult.center >= 252, 'resize letterbox pixels failed');
  assert.equal(checks.resizeResult.resized, 1);
  assert.deepEqual(checks.cropResult, {leftBar:[0,0,0],top:[255,0,0],bottom:[0,255,0],resized:1});
  assert.deepEqual(checks.unsupportedResult, { sameStream: true, ready: { status: 'unsupported' }, status: 'unsupported', trackEnded: true });
  assert.deepEqual(checks.failureResult, { rejected: true, errors: 1, status: 'error', sourceEnded: true, audioEnded: true });
  assert.deepEqual(checks.endedResult, { errors:1,status:'error',sourceEnded:true,outputEnded:true });
  assert.equal(checks.capResult.timestamps.length,10); assert.equal(checks.capResult.dropped,2); assert.equal(checks.capResult.target,25);
  assert.equal(checks.jitterResult.timestamps.length,8); assert.equal(checks.jitterResult.dropped,0);
  const capture = await page.evaluate(async () => {
    const limited = { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false };
    const full = { matrix: 'rgb', primaries: 'bt709', transfer: 'iec61966-2-1', fullRange: true };
    const width = 1280, height = 720, source = new MediaStreamTrackGenerator({ kind: 'video' }), writer = source.writable.getWriter();
    const audio = new AudioContext(); await audio.resume();
    const tone = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
    tone.frequency.value = 220; gain.gain.value = .03; tone.connect(gain).connect(destination); tone.start();
    const inputAudio = destination.stream.getAudioTracks()[0];
    const normalized = SameEndCapture.normalize(new MediaStream([source, inputAudio]));
    const audioIdentity = normalized.stream.getAudioTracks()[0] === inputAudio;
    const begin = performance.now(); let frames = 0, busy = false, lateTicks = 0, errors = [], pending = Promise.resolve();
    const tick = setInterval(() => {
      if (busy) { lateTicks++; return; }
      busy = true; const index = frames++;
      pending = (async () => {
        const isFull = index % 50 < 25, x = index * 13 % width;
        let pixels, frame;
        if (isFull) {
          pixels = new Uint8Array(width * height * 4);
          for (let y = 0, p = 0; y < height; y++) for (let col = 0; col < width; col++, p += 4) {
            const bright = (col + x) % 160 < 80 !== (y % 200 < 100), v = bright ? 255 : 0;
            pixels[p] = v; pixels[p+1] = v; pixels[p+2] = v; pixels[p+3] = 255;
          }
          frame = new VideoFrame(pixels, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: index * 40000, duration: 40000, colorSpace: full });
        } else {
          pixels = new Uint8Array(width * height * 3 / 2);
          for (let y = 0, p = 0; y < height; y++) for (let col = 0; col < width; col++, p++) pixels[p] = ((col + x) % 160 < 80 !== (y % 200 < 100)) ? 235 : 16;
          pixels.fill(128, width * height);
          frame = new VideoFrame(pixels, { format: 'I420', codedWidth: width, codedHeight: height, timestamp: index * 40000, duration: 40000, colorSpace: limited });
        }
        try { await writer.ready; await writer.write(frame); } finally { frame.close(); }
      })().catch(error => errors.push(String(error))).finally(() => { busy = false; });
    }, 40);
    const manifest = [];
    try {
      await normalized.ready;
      for (let seq = 0; seq < 12; seq++) {
        const began = performance.now(), chunks = [];
        const recorder = new MediaRecorder(normalized.stream, { mimeType: 'video/mp4;codecs=avc3.42001f,mp4a.40.2', videoBitsPerSecond: 1500000, audioBitsPerSecond: 96000 });
        await new Promise((resolve, reject) => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onerror = e => reject(e.error || new Error('recorder error')); recorder.onstop = resolve; recorder.start(); setTimeout(() => recorder.stop(), 2000); });
        const ended = performance.now(), bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        const meta = { seq, start: 1700000000000 + began - begin, duration: ended - began };
        await savePiece({ seq, base64: btoa(binary), meta }); manifest.push({ file: `piece-${seq}.mp4`, meta });
      }
    } finally { clearInterval(tick); await pending; await normalized.close(); tone.stop(); await audio.close(); }
    return { manifest, audioIdentity, frames, lateTicks, errors, stats: { ...normalized.stats }, sourceEnded: source.readyState === 'ended', audioEnded: inputAudio.readyState === 'ended', elapsedMs: performance.now() - begin };
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(capture.errors, []); assert.equal(saved.length, 12);
  assert.equal(capture.audioIdentity, true); assert.equal(capture.sourceEnded, true); assert.equal(capture.audioEnded, true);
  assert(capture.stats.frames >= 550, 'capture frame count too low'); assert.equal(capture.lateTicks, 0);
  saved.sort((a,b)=>a.meta.seq-b.meta.seq);
  await writeFile(new URL('manifest.json', out), JSON.stringify(saved.map(({file,meta})=>({file,meta})), null, 2));
  const context = { window: {} }; vm.runInNewContext(native.replace('function compatible(a,b)', 'root.__parse=parser;function compatible(a,b)'), context);
  const codec = [];
  for (const item of saved) {
    const bytes = await readFile(new URL(item.file, out)), parsed = context.window.__parse(bytes), video = parsed.tracks.find(t=>t.handler==='vide');
    const sps = new Set(), pps = new Set();
    for (const sample of video.samples) {
      let at = sample.data;
      while (at < sample.data + sample.size) {
        let size = 0; for (let i=0;i<video.nalLength;i++) size = size*256 + bytes[at+i]; at += video.nalLength;
        const nal = bytes.subarray(at,at+size), type = nal[0] & 31;
        if (type === 7) sps.add(createHash('sha256').update(nal).digest('hex'));
        if (type === 8) pps.add(createHash('sha256').update(nal).digest('hex'));
        at += size;
      }
    }
    codec.push({ file: item.file, samples: video.samples.length, avcC: createHash('sha256').update(Buffer.from(video.description,'hex')).digest('hex'), sps: [...sps], pps: [...pps] });
  }
  const distinctSps = new Set(codec.flatMap(c=>c.sps)), distinctAvcC = new Set(codec.map(c=>c.avcC));
  assert.equal(distinctSps.size, 1, 'in-band SPS changed'); assert.equal(distinctAvcC.size, 1, 'avcC changed');
  assert(codec.every(c=>c.sps.length===1 && c.pps.length===1), 'piece changed configuration internally');
  await writeFile(new URL('metrics.json', out), JSON.stringify({ checks, capture, codec, pageErrors }, null, 2));
  console.log(JSON.stringify({ checks, capture: { frames:capture.stats.frames, meanMs:capture.stats.meanMs, maxMs:capture.stats.maxMs, lateTicks:capture.lateTicks, elapsedMs:capture.elapsedMs }, pieces:codec.length, distinctSps:distinctSps.size, distinctAvcC:distinctAvcC.size, fixturePath:out.pathname }));
} finally { await browser.close(); }
