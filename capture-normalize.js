/* Convert captured video pixels to one fixed sRGB/BT.709 shape before recording.
 * The owner must await ready and call close when sharing ends. */
(function (root) {
  'use strict';
  const WIDTH = 1280, HEIGHT = 720, FRAME_US = 40000, MAX_INPUT_PIXELS = 3840 * 2160;
  const COLOR = { matrix: 'rgb', primaries: 'bt709', transfer: 'iec61966-2-1', fullRange: true };
  const friendlyError = () => new Error('The shared picture could not be prepared. Please stop sharing and try again.');
  function normalize(stream, { onError } = {}) {
    const stats = { status: 'starting', frames: 0, meanMs: 0, maxMs: 0, resized: 0, dropped: 0, errors: 0, targetFrameRate: 25 };
    const input = stream.getVideoTracks()[0];
    const supported = !!(input && root.MediaStreamTrackProcessor && root.MediaStreamTrackGenerator && root.VideoFrame?.prototype?.copyTo && root.OffscreenCanvas);
    if (!supported) {
      stats.status = 'unsupported';
      return { stream, stats, ready: Promise.resolve({ status: 'unsupported' }), close() { stream.getTracks().forEach(track => track.stop()); return Promise.resolve(); } };
    }
    let canvas, context;
    try {
      canvas = new OffscreenCanvas(WIDTH, HEIGHT);
      context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      if (!context) throw new Error('No 2D context');
    } catch {
      stats.status = 'unsupported';
      return { stream, stats, ready: Promise.resolve({ status: 'unsupported' }), close() { stream.getTracks().forEach(track => track.stop()); return Promise.resolve(); } };
    }
    const processor = new MediaStreamTrackProcessor({ track: input, maxBufferSize: 1 });
    const generated = new MediaStreamTrackGenerator({ kind: 'video' });
    const reader = processor.readable.getReader(), writer = generated.writable.getWriter();
    const output = new MediaStream([generated, ...stream.getAudioTracks()]);
    let ended = false, settled = false, timer, resolveReady, rejectReady, notified = false;
    let firstTimestamp, lastBucket = -1;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A caller may close without awaiting ready; keep that rejection handled.
    ready.catch(() => {});
    function settle(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) rejectReady(error); else resolveReady({ status: 'ready' });
    }
    function stopTracks() {
      for (const track of stream.getTracks()) track.stop();
      generated.stop();
    }
    function stopPipeline() {
      if (ended) return;
      ended = true;
      stopTracks();
      void reader.cancel().catch(() => {});
      void writer.abort().catch(() => {});
    }
    function fail() {
      if (ended) return;
      stats.status = 'error'; stats.errors = 1;
      const error = friendlyError();
      settle(error);
      stopPipeline();
      if (!notified) { notified = true; try { onError?.(error); } catch {} }
    }
    async function convert(frame) {
      const width = frame.displayWidth, height = frame.displayHeight;
      if (!width || !height || !frame.codedWidth || !frame.codedHeight ||
          frame.codedWidth * frame.codedHeight > MAX_INPUT_PIXELS ||
          width * height > MAX_INPUT_PIXELS) throw friendlyError();
      const visible = frame.visibleRect;
      const exact = frame.codedWidth === WIDTH && frame.codedHeight === HEIGHT &&
        width === WIDTH && height === HEIGHT &&
        visible?.x === 0 && visible?.y === 0 && visible?.width === WIDTH && visible?.height === HEIGHT &&
        (frame.rotation === undefined || frame.rotation === 0) && !frame.flip;
      let rgba;
      if (exact) {
        rgba = new Uint8Array(WIDTH * HEIGHT * 4);
        await frame.copyTo(rgba, { format: 'RGBA', colorSpace: 'srgb' });
      } else {
        stats.resized++;
        context.fillStyle = '#000'; context.fillRect(0, 0, WIDTH, HEIGHT);
        const scale = Math.min(WIDTH / width, HEIGHT / height);
        const drawWidth = Math.round(width * scale), drawHeight = Math.round(height * scale);
        context.drawImage(frame, Math.floor((WIDTH - drawWidth) / 2), Math.floor((HEIGHT - drawHeight) / 2), drawWidth, drawHeight);
        rgba = context.getImageData(0, 0, WIDTH, HEIGHT, { colorSpace: 'srgb' }).data;
      }
      return new VideoFrame(rgba, { format: 'RGBA', codedWidth: WIDTH, codedHeight: HEIGHT,
        timestamp: frame.timestamp, duration: frame.duration || undefined, colorSpace: COLOR });
    }
    timer = setTimeout(fail, 5000);
    input.addEventListener('ended', () => { if (!ended) fail(); }, { once: true });
    const pump = (async () => {
      try {
        while (!ended) {
          const next = await reader.read();
          if (next.done) { if (!ended) fail(); break; }
          const frame = next.value, started = performance.now();
          if (firstTimestamp === undefined) firstTimestamp = frame.timestamp;
          // Capture timestamps can be about 1 ms early; keep nominal 25 fps.
          const bucket = Math.floor((frame.timestamp - firstTimestamp + 2000) / FRAME_US);
          if (bucket <= lastBucket) { stats.dropped++; frame.close(); continue; }
          lastBucket = bucket;
          let converted;
          try { converted = await convert(frame); }
          finally { frame.close(); }
          try {
            if (ended) break;
            await writer.ready;
            if (ended) break;
            await writer.write(converted);
            const ms = performance.now() - started;
            stats.frames++; stats.meanMs += (ms - stats.meanMs) / stats.frames;
            stats.maxMs = Math.max(stats.maxMs, ms);
            if (!settled) { stats.status = 'active'; settle(); }
          } finally { converted.close(); }
        }
      } catch { if (!ended) fail(); }
      finally { if (!ended) stopPipeline(); }
    })();
    return {
      stream: output, ready, stats,
      close() {
        if (!ended) { stats.status = 'closed'; settle(friendlyError()); stopPipeline(); }
        return pump;
      }
    };
  }
  root.SameEndCapture = { normalize };
})(window);
