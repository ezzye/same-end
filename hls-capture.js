/* Continuous H.264/AAC capture; all HLS/CMAF packaging belongs to Mediabunny.
 * Caller owns the input tracks (including the original, unmodified audio track).
 * `epoch` is Unix milliseconds. Native synced-zero timestamps are untouched;
 * startupOffsetSeconds maps that timeline onto the requested programme epoch.
 */
import {
  Output, HlsOutputFormat, CmafOutputFormat, PathedTarget, BufferTarget,
  MediaStreamVideoTrackSource, MediaStreamAudioTrackSource, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';

const WINDOW = 180, MAX_PENDING_BYTES = 16 * 1024 * 1024;
const DELIVERY_TIMEOUT_MS = 3000, MAX_DELIVERY_SAMPLES = 150;
const VIDEO = { codec: 'avc', bitrate: 1500000, keyFrameInterval: 2, hardwareAcceleration: 'prefer-software' };
const AUDIO = { codec: 'aac', bitrate: 96000 };

export async function canCapture(stream) {
  try {
    if (typeof MediaStream === 'undefined' || typeof VideoEncoder === 'undefined') return false;
    const video = stream?.getVideoTracks()[0], audio = stream?.getAudioTracks()[0];
    if ((!stream || audio) && typeof AudioEncoder === 'undefined') return false;
    if (stream && (!video || video.readyState !== 'live' || (audio && audio.readyState !== 'live'))) return false;
    const settings = video?.getSettings() || {};
    const audioSettings = audio?.getSettings() || {};
    const supported = await Promise.all([
      canEncodeVideo('avc', { width: settings.width || 1280, height: settings.height || 720, bitrate: VIDEO.bitrate, frameRate: settings.frameRate || 25, latencyMode: 'realtime', hardwareAcceleration: VIDEO.hardwareAcceleration }),
      !stream || audio ? canEncodeAudio('aac', { numberOfChannels: audioSettings.channelCount || 2, sampleRate: audioSettings.sampleRate || 48000, bitrate: AUDIO.bitrate }) : true,
    ]);
    return supported.every(Boolean);
  } catch { return false; }
}

export async function createCapture(stream, { epoch, bitrate = VIDEO.bitrate, onBatch, onError, now = Date.now } = {}) {
  if (!Number.isFinite(epoch) || epoch < 0) throw new TypeError('Capture epoch must be Unix milliseconds.');
  if (!Number.isInteger(bitrate) || bitrate <= 0) throw new TypeError('Capture bitrate must be a positive integer.');
  if (typeof onBatch !== 'function') throw new TypeError('Capture needs an onBatch callback.');
  if (!await canCapture(stream)) throw new Error('Continuous H.264/AAC capture is unavailable in this browser.');
  const stats = { status: 'starting', epoch, startupOffsetSeconds: null, videoPackets: 0, audioPackets: 0, videoEncoderConfigurations: 0, audioEncoderConfigurations: 0, batches: 0, segments: 0, pendingBytes: 0, peakPendingBytes: 0, retainedFiles: 0, peakDeliverySamples: 0, end: 0 };
  const snapshots = new Map(), pending = new Map(), segmentInfo = new Map(), playlists = new Map(), firstPackets = new Map();
  let resolveReady, rejectReady, output, closing, failure, firstSample = false, lastFiles = [], lastInterval, rejectFailure, delivering = false, deliverySamples = 0;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The caller may attach its handler after createCapture resolves.
  ready.catch(() => {});
  const failureSignal = new Promise((resolve, reject) => { rejectFailure = reject; });
  failureSignal.catch(() => {});
  const tracks = [stream.getVideoTracks()[0], stream.getAudioTracks()[0]].filter(Boolean);
  const listeners = [];
  const clear = () => {
    listeners.splice(0).forEach(([track, listener]) => track.removeEventListener('ended', listener));
    snapshots.clear(); pending.clear(); segmentInfo.clear(); playlists.clear(); lastFiles = [];
    stats.pendingBytes = 0; stats.retainedFiles = 0;
  };
  const fail = error => {
    if (failure || stats.status === 'closed') return;
    failure = error instanceof Error ? error : new Error(String(error));
    stats.status = 'error'; rejectReady(failure); rejectFailure(failure);
    try { onError?.(failure); } catch { /* Error reporting must not block cleanup. */ }
    // Never await cancellation inside a target's finalize callback (muxer mutex).
    queueMicrotask(() => { void output?.cancel().catch(() => {}).finally(clear); });
  };
  const observedSample = sample => {
    if (delivering) {
      stats.peakDeliverySamples = Math.max(stats.peakDeliverySamples, ++deliverySamples);
      if (deliverySamples > MAX_DELIVERY_SAMPLES) fail(new Error('HLS delivery is too far behind capture.'));
    }
    if (!firstSample) {
      firstSample = true;
      stats.startupOffsetSeconds = (now() - epoch) / 1000 - sample.timestamp;
    }
  };
  const encoded = kind => packet => {
    stats[kind + 'Packets']++;
    if (!firstPackets.has(kind)) firstPackets.set(kind, packet.timestamp);
  };
  const refreshCount = () => { stats.retainedFiles = snapshots.size + pending.size + lastFiles.length; };
  async function emit(playlistOnly = false) {
    if (failure) throw failure;
    if (!snapshots.has('master.m3u8') || (!pending.size && !playlistOnly)) return;
    const newFiles = [...pending.values()];
    const filesToSend = newFiles.length ? newFiles : playlistOnly ? lastFiles : [];
    if (!filesToSend.length) return;
    if (newFiles.some(file => !Number.isFinite(file.start) || !Number.isFinite(file.duration))) throw new Error('HLS segment completed without playlist timing.');
    const start = newFiles.length ? Math.min(...newFiles.map(file => file.start)) : lastInterval.start;
    const end = newFiles.length ? Math.max(...newFiles.map(file => file.start + file.duration)) : start + lastInterval.duration;
    const mediaPlaylists = [...snapshots.values()].filter(file => file.path !== 'master.m3u8' && file.path.endsWith('.m3u8'));
    const batch = { files: [...snapshots.values(), ...filesToSend], start, duration: end - start, ...(playlistOnly ? { final: true } : {}), playlistStart: Math.min(...mediaPlaylists.map(file => file.start)) };
    // Await the consumer, with a finite bound on samples held by the live source
    // while its encoder callbacks are waiting for the muxer.
    let deliveryTimer; delivering = true; deliverySamples = 0;
    try {
      await Promise.race([Promise.resolve().then(() => onBatch(batch)), failureSignal,
        new Promise((resolve, reject) => { deliveryTimer = setTimeout(() => reject(new Error('HLS delivery timed out.')), DELIVERY_TIMEOUT_MS); }),
      ]);
    } finally { clearTimeout(deliveryTimer); delivering = false; }
    for (const file of newFiles) { pending.delete(file.path); stats.pendingBytes -= file.bytes.byteLength; }
    if (newFiles.length) { lastFiles = newFiles; lastInterval = { start, duration: end - start }; }
    stats.batches++; stats.segments += newFiles.length; stats.end = Math.max(stats.end, end);
    refreshCount();

  }
  function timePlaylist(text, info) {
    // Only standard EXTINF + URI lines from the maintained writer are read.
    // The public onEncodedPacket hook supplies the first native timestamp; no MP4 bytes are parsed.
    let playlist = playlists.get(info.n);
    if (!playlist) {
      const first = Math.min(...info.tracks.map(track => firstPackets.get(track.type)).filter(Number.isFinite));
      if (!Number.isFinite(first)) throw new Error('HLS playlist has no initial encoded timestamp.');
      playlist = { next: first + stats.startupOffsetSeconds, timings: new Map() }; playlists.set(info.n, playlist);
    }
    const entries = []; let duration;
    for (const line of text.split('\n')) {
      if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
      else if (line && !line.startsWith('#') && duration !== undefined) {
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid generated HLS duration.');
        if (Math.round(duration) > 2) throw new Error('Generated HLS segment exceeded the two-second target duration.');
        let timing = playlist.timings.get(line);
        if (!timing) {
          timing = { start: playlist.next, duration }; playlist.timings.set(line, timing); playlist.next += duration;
        }
        const file = pending.get(line); if (file) Object.assign(file, timing);
        entries.push(line); duration = undefined;
      }
    }
    const keep = new Set(entries);
    for (const path of playlist.timings.keys()) if (!keep.has(path)) { playlist.timings.delete(path); segmentInfo.delete(path); }
    if (playlist.timings.size > WINDOW) throw new Error('Generated HLS window exceeded its bound.');
    return entries.length ? playlist.timings.get(entries[0]).start : playlist.next;
  }
  const format = new HlsOutputFormat({
    segmentFormat: new CmafOutputFormat(), live: true, targetDuration: 2, maxLiveSegmentCount: WINDOW,
    getPlaylistPath(info) { return `playlist-${info.n}.m3u8`; },
    getInitPath(info) { return `init-${info.n}.mp4`; },
    getSegmentPath(info) {
      const path = `segment-${info.playlist.n}-${info.n}.m4s`;
      segmentInfo.set(path, info); return path;
    },
    onPlaylist(text, info) { const start = timePlaylist(text, info); playlists.get(info.n).start = start; },
  });
  output = new Output({ format, target: new PathedTarget('master.m3u8', request => new BufferTarget({
    async onFinalize(bytes) {
      try {
        if (failure) throw failure;
        const file = { path: request.path, mime: request.mimeType, bytes };
        if (request.path.endsWith('.m4s')) {
          if (!segmentInfo.has(request.path)) throw new Error('Unexpected generated HLS segment.');
          pending.set(request.path, file); stats.pendingBytes += bytes.byteLength;
          stats.peakPendingBytes = Math.max(stats.peakPendingBytes, stats.pendingBytes);
          if (stats.pendingBytes > MAX_PENDING_BYTES || pending.size > 8) throw new Error('HLS delivery is too far behind capture.');
        } else {
          if (request.path !== 'master.m3u8' && request.path.endsWith('.m3u8')) {
            const info = Number(request.path.match(/^playlist-(\d+)\.m3u8$/)?.[1]);
            file.start = playlists.get(info)?.start;
          }
          snapshots.set(request.path, file);
        }
        refreshCount();
        if (request.path === 'master.m3u8') await emit();
      } catch (error) { fail(error); throw error; }
    },
  })) });
  const video = new MediaStreamVideoTrackSource(tracks[0], { ...VIDEO, bitrate,
    onEncodedSample: observedSample, onEncodedPacket: encoded('video'),
    onEncoderConfig() { stats.videoEncoderConfigurations++; },
  }, { timestampBase: 'synced-zero', frameRate: null });
  output.addVideoTrack(video);
  const sources = [video];
  if (tracks[1]) {
    const audio = new MediaStreamAudioTrackSource(tracks[1], { ...AUDIO,
      onEncodedSample: observedSample, onEncodedPacket: encoded('audio'),
      onEncoderConfig() { stats.audioEncoderConfigurations++; },
    }, { timestampBase: 'synced-zero' });
    output.addAudioTrack(audio); sources.push(audio);
  }
  for (const source of sources) source.errorPromise.catch(fail);
  for (const track of tracks) {
    const listener = () => { if (!closing) fail(new Error(`The captured ${track.kind} track ended.`)); };
    track.addEventListener('ended', listener); listeners.push([track, listener]);
  }
  try { await output.start(); stats.status = 'capturing'; resolveReady({ epoch }); } catch (error) { fail(error); await output.cancel().catch(() => {}); clear(); throw error; }
  return { ready, stats, close() {
    if (closing) return closing;
    closing = (async () => {
      try {
        if (failure) { await output.cancel(); return; }
        await output.finalize();
        await emit(true); // Includes the library's final ENDLIST snapshots.
        stats.status = 'closed';
      } catch (error) { fail(error); throw error; }
      finally { clear(); }
    })();
    return closing;
  } };
}
