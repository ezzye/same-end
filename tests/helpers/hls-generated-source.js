// Generated, moving test media only. No camera, microphone or external content.
export async function generatedSource() {
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
  document.body.append(canvas); const context = canvas.getContext('2d');
  const video = canvas.captureStream(0), videoTrack = video.getVideoTracks()[0];
  const audio = new AudioContext({ sampleRate: 48000 }); await audio.resume();
  const oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
  oscillator.frequency.value = 440; gain.gain.value = 0.15;
  oscillator.connect(gain).connect(destination); oscillator.start();
  const audioTrack = destination.stream.getAudioTracks()[0]; let frames = 0;
  const draw = () => {
    const phase = frames++;
    context.fillStyle = phase % 50 < 25 ? '#16263e' : '#d3eaf1'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fb592b'; context.fillRect(phase * 9 % canvas.width, 50, 70, 180);
    context.fillStyle = '#28dbb9'; context.fillRect(canvas.width - phase * 7 % canvas.width, 240, 90, 60);
    context.fillStyle = '#ffffff'; context.font = '32px sans-serif'; context.fillText(`Frame ${phase}`, 15, 40);
    videoTrack.requestFrame();
  };
  draw(); const timer = setInterval(draw, 40);
  return { stream: new MediaStream([videoTrack, audioTrack]), canvas, audioTrack,
    get frames() { return frames; }, async close() { clearInterval(timer); oscillator.stop(); videoTrack.stop(); audioTrack.stop(); await audio.close(); canvas.remove(); } };
}
