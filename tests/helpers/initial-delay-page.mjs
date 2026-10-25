// This function is serialized into the isolated acceptance server's HTML before
// app boot. It changes only the owned test's media receive callback scheduling.
export function initialDelayPageProbe(options) {
  const role = new URL(location.href).searchParams.get('testRole') || 'viewer';
  const isSource = role === 'source', isNative = options.device === 'ios';
  const telemetry = window.initialAcceptance = {
    role, profile: options.profile, startedAt: Date.now(), errors: [],
    frames: 0, lastFrameAt: null, maxFrameGapMs: 0, firstFrame: null,
    events: [], seeks: [], controls: 0, wireBytes: 0, deliveredBytes: 0,
    wirePieces: 0, deliveredPieces: 0, queuedBytes: 0, verified: [],
    connectedPeers: 0, chatReceipts: [], gestureCount: 0, commandErrors: [],
  };
  let config;
  Object.defineProperty(window, 'SameEndConfig', { configurable: true,
    get: () => config, set: value => { config = { ...value, automaticInitialDelay: !isSource && role !== 'downstream' }; },
  });
  const NativePC = window.RTCPeerConnection;
  if (NativePC) window.RTCPeerConnection = class extends NativePC {
    constructor(...args) { super(...args); this.addEventListener('connectionstatechange', () => {
      if (this.connectionState === 'connected') telemetry.connectedPeers++;
    }); }
  };
  if (isSource) {
    const NativeAudio = window.AudioContext;
    window.AudioContext = class extends NativeAudio {
      createOscillator() {
        const oscillator = super.createOscillator(), start = oscillator.start.bind(oscillator), context = this;
        oscillator.start = (...args) => {
          const t = context.currentTime + .01; oscillator.frequency.cancelScheduledValues(0);
          for (let i = 0; i < 1000; i++) {
            oscillator.frequency.setValueAtTime(600, t + i * 1.6);
            oscillator.frequency.linearRampToValueAtTime(1800, t + i * 1.6 + .8);
            oscillator.frequency.linearRampToValueAtTime(600, t + (i + 1) * 1.6);
          }
          return start(...args);
        };
        return oscillator;
      }
    };
  }
  if(!isSource&&options.forceNative){let hls;Object.defineProperty(window,'SameEndHLS',{configurable:true,get:()=>hls,set:module=>{hls={...module,canPlay:()=>false}}});}
  let deliveryModule;
  Object.defineProperty(window, 'SameEndClientDelivery', { configurable: true,
    get: () => deliveryModule, set: module => {
      deliveryModule = module; const proto = module?.Estimator?.prototype;
      if (!proto || proto.initialAcceptanceWrapped) return;
      proto.initialAcceptanceWrapped = true; const observe = proto.observe;
      proto.observe = function(value) {
        const accepted = observe.call(this, value);
        if (accepted) { telemetry.verified.push({ ...value, at: Date.now() }); if (telemetry.verified.length > 256) telemetry.verified.shift(); }
        return accepted;
      };
    },
  });
  const ratio = { steady: 2.2, slow: 1.25, bursty: 6, below95: .95, below65: .65 }[options.profile];
  let transport;
  Object.defineProperty(window, 'CastMagnetTransport', { configurable: true,
    get: () => transport, set: Class => {
      transport = Class; const proto = Class?.prototype;
      if (!proto?._open || proto.initialAcceptanceWrapped) return;
      proto.initialAcceptanceWrapped = true; const open = proto._open;
      proto._open = function(...args) {
        const result = open.apply(this, args), adapter = args[0]?.adapter;
        if (isSource || role === 'downstream' || !adapter || adapter.initialAcceptanceWrapped) return result;
        adapter.initialAcceptanceWrapped = true;
        const receive = adapter.onmessage, close = adapter.onclose, items = [];
        let active = false, closed = false, bitrate = null, burstEpoch = performance.now();
        const pump = () => {
          if (active || closed || !items.length) return;
          active = true; const item = items[0]; let delay = 0;
          if (options.profile === 'bursty') {
            const phase = (performance.now() - burstEpoch) % 5000;
            if (phase < 3000) delay = 3000 - phase;
          }
          if (item.bytes && item.bitrate > 0) delay += item.bytes * 8 / (item.bitrate * ratio) * 1000;
          setTimeout(() => {
            active = false; if (closed) return; items.shift(); telemetry.queuedBytes -= item.bytes;
            telemetry.deliveredBytes += item.bytes; if (item.header) telemetry.deliveredPieces++;
            receive?.call(adapter, item.event); pump();
          }, delay);
        };
        adapter.onmessage = function(event) {
          let header;
          if (typeof event.data === 'string') {
            try { const m = JSON.parse(event.data); if (m.type === 'segment') header = m; } catch {}
            if (!header) { telemetry.controls++; return receive?.call(this, event); }
          }
          if (header) {
            telemetry.wirePieces++;
            // Signed envelope metadata chooses only the deterministic scheduler's
            // per-piece pacing rate. The app still verifies the real payload.
            if (header.meta.size > 0 && header.meta.duration > 0) bitrate = header.meta.size * 8 / (header.meta.duration / 1000);
          }
          const bytes = event.data instanceof ArrayBuffer ? event.data.byteLength : 0;
          telemetry.wireBytes += bytes; telemetry.queuedBytes += bytes;
          items.push({ event, bytes, header: !!header, bitrate }); pump();
        };
        adapter.onclose = function(...values) {
          closed = true; telemetry.queuedBytes -= items.reduce((n, item) => n + item.bytes, 0); items.length = 0;
          return close?.apply(this, values);
        };
        return result;
      };
    },
  });
  addEventListener('error', event => telemetry.errors.push(String(event.message).slice(0, 400)));
  addEventListener('unhandledrejection', event => telemetry.errors.push(String(event.reason).slice(0, 400)));
  let analyser, audioContext, meterSource, peakFrequency = null, lastFrame = null, frameRequest = null, commandId = 0;
  const snapshot = () => {
    const s = window.PrivateCast?.snapshot(), video = document.querySelector('#player');
    if (!s || !video) return null;
    if(options.audioTee&&audioContext&&analyser&&!meterSource&&video.readyState>=2){
      try{const capture=video.captureStream(),audio=new MediaStream(capture.getAudioTracks());for(const track of capture.getVideoTracks())track.stop();if(audio.getAudioTracks().length){meterSource=audioContext.createMediaStreamSource(audio);meterSource.connect(analyser)}}catch(error){telemetry.errors.push('Audio tee: '+error.message)}
    }
    let rms = null;
    if (analyser) {
      const wave = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(wave);
      rms = Math.sqrt(wave.reduce((n, x) => n + x * x, 0) / wave.length);
      const bins = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
      let best = -Infinity, index = 0;
      for (let i = Math.floor(350 * analyser.fftSize / audioContext.sampleRate); i < Math.min(bins.length, Math.ceil(2300 * analyser.fftSize / audioContext.sampleRate)); i++) {
        if (bins[i] > best) { best = bins[i]; index = i; }
      }
      peakFrequency = index * audioContext.sampleRate / analyser.fftSize;
    }
    const elapsed = s.config ? (Date.now() + (s.offset || 0) - s.config.epoch) / 1000 : null;
    const sourceAge = Number.isFinite(elapsed) && Number.isFinite(s.programTime) ? elapsed - s.programTime : null;
    const social = window.SameEndSocial?.snapshot();
    const chats = [...document.querySelectorAll('.club-message p')].map(p => p.textContent).filter(t => /^initial-delay-chat-/.test(t));
    for (const text of chats) if (!telemetry.chatReceipts.some(row => row.text === text)) telemetry.chatReceipts.push({ text, at: Date.now() });
    return { at: Date.now(), elapsed, sourceAge, initialDelay: s.initialDelay ?? null,
      config: s.config && Object.fromEntries(['id','epoch','delay','sourceId','sourceEpoch','programId','mediaProfile'].map(k => [k, s.config[k]])),
      programTime: s.programTime, target: s.targetProgramTime, viewerTarget: s.viewerTargetProgramTime, effectiveTarget: s.effectiveTargetProgramTime,
      clientDelivery: s.clientDelivery, reserveSeconds: s.reserveSeconds, playback: s.mediaDiagnostics?.playback,
      received: s.received, clockReady: s.clockReady, supplier: !!s.supplier, stalls: s.stalls,
      mode: s.playbackMode, width: video.videoWidth, height: video.videoHeight, paused: video.paused,
      ready: video.readyState, seeking: video.seeking, muted: video.muted, currentTime: video.currentTime,rawBuffered:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)]),rawSeekable:Array.from({length:video.seekable.length},(_,i)=>[video.seekable.start(i),video.seekable.end(i)]),
      decodedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? null,
      audioContextState: audioContext?.state ?? null,audioContextTime:audioContext?.currentTime??null,performanceTime:performance.now(),audioRoute:options.audioTee?'capture-stream-tee':'media-element-source', rms, peakFrequency,
      chatConnected: !!social?.connected, chatCount: social?.chatCount, cacheBytes: s.cacheBytes,
      secureContext: window.isSecureContext, serviceWorkerControlled: !!navigator.serviceWorker?.controller,
      waitingOverlayHidden: !document.querySelector('#sameend-wait') || document.querySelector('#sameend-wait').hidden || getComputedStyle(document.querySelector('#sameend-wait')).display === 'none',
      userAgent: navigator.userAgent, visibility: document.visibilityState,
      probe: { ...telemetry, verified: telemetry.verified.slice(-80) },
    };
  };
  window.initialAcceptanceSnapshot = snapshot;
  const setup = () => {
    const video = document.querySelector('#player'); if (!video) return;
    for (const name of ['waiting','stalled','playing','pause','error']) video.addEventListener(name, () => {
      telemetry.events.push({ name, at: Date.now(), currentTime: video.currentTime });
      if (telemetry.events.length > 200) telemetry.events.shift();
    });
    video.addEventListener('seeking', () => telemetry.seeks.push({ at: Date.now(), time: video.currentTime }));
    const frame = (now, metadata) => {
      frameRequest = null; const wall = Date.now(); telemetry.frames++; telemetry.lastFrameAt = wall;
      if (lastFrame !== null) telemetry.maxFrameGapMs = Math.max(telemetry.maxFrameGapMs, now - lastFrame);
      lastFrame = now;
      if (!telemetry.firstFrame && !video.paused && video.readyState >= 2) {
        const s = snapshot(); if (Number.isFinite(s?.programTime)) telemetry.firstFrame = { at: wall, mediaTime: metadata.mediaTime, programTime: s.programTime, sourceAge: s.sourceAge, initialDelay: s.initialDelay, paused: video.paused };
      }
      frameRequest = video.requestVideoFrameCallback(frame);
    };
    // Arm against the active native resource at its load/play boundaries,
    // rather than relying solely on a request made before a long warm-up.
    const armFrames = () => { if (!video.requestVideoFrameCallback) return;
      if (frameRequest !== null) video.cancelVideoFrameCallback?.(frameRequest);
      frameRequest = video.requestVideoFrameCallback(frame);
    };
    video.addEventListener('loadeddata', armFrames); video.addEventListener('playing', armFrames);
    armFrames();
    if (!isSource) {
      const button = document.createElement('button'); button.id = 'initial-join'; button.textContent = 'Start test with sound';
      Object.assign(button.style, { position: 'fixed', top: '8px', left: '8px', zIndex: '2147483647' });
      button.onclick = () => {
        telemetry.gestureCount++;
        if (!isNative && !analyser) {
          try { audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;
            if(!options.audioTee){meterSource=audioContext.createMediaElementSource(video);meterSource.connect(analyser);}
            const silentOutput = audioContext.createGain(); silentOutput.gain.value = 0; analyser.connect(silentOutput); silentOutput.connect(audioContext.destination);
          } catch (error) { telemetry.errors.push('Audio probe: ' + error.message); }
        }
        audioContext?.resume().catch(() => {});
        document.querySelector('#sound')?.click(); button.textContent = 'Test sound requested';
      };
      document.body.append(button);
    }
    setInterval(async () => {
      const state = snapshot(); if (!state) return;
      try { await fetch('/metrics?role=' + role+'&run='+options.runNonce, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state), cache: 'no-store' }); } catch {}
    }, 500);
    if (!isSource) setInterval(async () => {
      try {
        const commands = await (await fetch('/commands?after=' + commandId + '&role=' + role+'&run='+options.runNonce, { cache: 'no-store' })).json();
        for (const c of commands) {
          commandId = Math.max(commandId, c.id);
          if (c.type === 'chat') { const input = document.querySelector('#club-chat-input'); input.value = c.text; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#club-send-chat').click(); }
          if(c.type==='audio-mute'){document.querySelector('#player').muted=c.muted;telemetry.audioCuts??=[];telemetry.audioCuts.push({at:Date.now(),muted:c.muted});}
          if (c.type === 'relay') window.PrivateCast?.testing.setRelayLimit(c.limit);
          if(c.type==='end-test'){audioContext?.close().catch(()=>{});delete document.hidden;delete document.visibilityState;await window.PrivateCast?.stop?.();document.querySelector('#player')?.pause();document.querySelector('#player').muted=true;}
          if(c.type==='visibility-restore'){delete document.hidden;delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));}
          if (c.type === 'visibility') {
            // Supplemental owned-document lifecycle stimulus; explicitly not
            // evidence of a real OS background/foreground transition.
            Object.defineProperty(document, 'hidden', { configurable:true, get:() => c.hidden });
            Object.defineProperty(document, 'visibilityState', { configurable:true, get:() => c.hidden ? 'hidden' : 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
          }
        }
      } catch (error) { telemetry.commandErrors.push(String(error.message)); }
    }, 250);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', setup, { once: true }); else setup();
}
