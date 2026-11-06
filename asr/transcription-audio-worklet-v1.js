"use strict";
(() => {
  // src/transcription-audio-worklet.ts
  var SharedAudioSamples = class extends AudioWorkletProcessor {
    buffer = new Float32Array(2048);
    used = 0;
    firstFrame = 0;
    credit = 1;
    stopped = false;
    constructor() {
      super();
      this.port.onmessage = (event) => {
        if (event.data?.type === "credit") this.credit = 1;
        if (event.data?.type === "stop") this.stopped = true;
      };
    }
    process(inputs) {
      if (this.stopped) return false;
      const channels = inputs[0];
      if (!channels?.length) return true;
      for (let n = 0; n < channels[0].length; n++) {
        if (!this.used) this.firstFrame = currentFrame + n;
        let value = 0;
        for (const channel of channels) value += channel[n] / channels.length;
        this.buffer[this.used++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        if (this.used === this.buffer.length) {
          if (this.credit) {
            this.credit = 0;
            this.port.postMessage({ type: "pcm", frame: this.firstFrame, pcm: this.buffer.buffer }, [this.buffer.buffer]);
            this.buffer = new Float32Array(2048);
          }
          this.used = 0;
        }
      }
      return true;
    }
  };
  registerProcessor("same-end-shared-audio-v1", SharedAudioSamples);
})();
