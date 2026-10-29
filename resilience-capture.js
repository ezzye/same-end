/* Independent, source-clock-bound media streams. Each rendition has its own
 * HLS namespace/cache; no receiver needs to unpack audio from video. */
import { createCapture } from './hls-capture.js';

export async function createResilientCapture(inputStream, { epoch, now = Date.now, onBatch, onError = () => {}, renditions: selectedRenditions = ['audio', 'v360', 'v480'] } = {}) {
  if (!inputStream?.getVideoTracks()[0] || typeof onBatch !== 'function') throw new Error('A video track and batch consumer are required.');
  if (!Array.isArray(selectedRenditions) || selectedRenditions.some(name => !['audio', 'v360', 'v480'].includes(name)) || !selectedRenditions.some(name => name === 'v360' || name === 'v480')) throw new Error('Select at least one supported video rendition.');
  const definitions = [
    { name: 'audio', audioOnly: true, audioBitrate: 64000 },
    { name: 'v360', width: 640, height: 360, frameRate: 25, bitrate: 400000, videoOnly: true },
    { name: 'v480', width: 854, height: 480, frameRate: 25, bitrate: 700000, videoOnly: true },
  ].filter(definition => definition.name === 'audio' || selectedRenditions.includes(definition.name));
  const stats = { status: 'starting', renditions: {} }, renditions = {}, owned = [], normalizers = [], producers = [];
  let closed = false, audioContext, silentSource;
  let audio = inputStream.getAudioTracks()[0];
  const sourceAudioAvailable = !!audio, syntheticAudio = !sourceAudioAvailable;
  if (!audio) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error('A captured audio track or supported silent audio clock is required.');
    audioContext = new AC(); await audioContext.resume();
    const destination = audioContext.createMediaStreamDestination();
    silentSource = audioContext.createConstantSource(); const gain = audioContext.createGain(); gain.gain.value = 0;
    silentSource.connect(gain).connect(destination); silentSource.start();
    audio = destination.stream.getAudioTracks()[0]; owned.push(audio);
  }
  async function close() {
    if (closed) return; closed = true; stats.status = 'closed';
    await Promise.allSettled(producers.map(p => p.close()));
    await Promise.allSettled(normalizers.map(n => n.close()));
    owned.forEach(track => track.stop());
    if (silentSource) silentSource.stop();
    if (audioContext) await audioContext.close().catch(() => {});
  }
  try {
    for (const definition of definitions) {
      const name = definition.name;
      stats.renditions[name] = { status: 'starting' };
      try {
      const track = definition.audioOnly ? audio : inputStream.getVideoTracks()[0].clone(); if (!definition.audioOnly) owned.push(track);
      let stream = new MediaStream([track]);
      if (!definition.audioOnly) {
        if (!globalThis.SameEndCapture?.normalize) throw new Error('Frame normalization is unavailable.');
        const normalizer = globalThis.SameEndCapture.normalize(stream, { width: definition.width, height: definition.height, frameRate: 25,
          onError: error => { stats.renditions[name].status = 'error'; onError(error, name); } });
        normalizers.push(normalizer); await normalizer.ready;
        if (normalizer.stats.status !== 'active') throw new Error('Required video normalization is unavailable.');
        stream = normalizer.stream;
      }
      const producer = await createCapture(stream, { epoch, now, ...definition,
        onBatch: batch => onBatch({ ...batch, rendition: name }),
        onError: error => { stats.renditions[name].status = 'error'; onError(error, name); },
      });
      producers.push(producer); renditions[name] = producer; stats.renditions[name] = producer.stats;
      } catch (error) {
        stats.renditions[name].status = 'error'; onError(error, name);
        if (definition.audioOnly) throw error;
      }
    }
    stats.status = 'capturing';
    return { ready: Promise.all(producers.map(p => p.ready)), close, stats, renditions, sourceAudioAvailable, syntheticAudio };
  } catch (error) { await close(); throw error; }
}
