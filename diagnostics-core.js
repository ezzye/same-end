(function(root) {
  "use strict";
  const KEY = "same-end-diagnostics-v1", SAMPLE_MS = 5e3, MAX_SAMPLES = 1440, MAX_EVENTS = 200, MAX_BYTES = 2 * 1024 * 1024;
  const enums = { role: ["source", "viewer"], recovery: ["idle", "searching", "connected", "exhausted", "manual-rejoin", "stopped"], reason: ["none", "timeout", "network", "source-ended", "no-supplier", "manual", "unknown", "media-stalled", "supplier-failed", "supplier-disconnected", "automatic-retry", "supplier-unresponsive", "source-path-stalled", "source-progress-stalled"], audio: ["checking", "sound", "quiet", "no-track", "unavailable"], health: ["healthy", "supplier-unresponsive", "source-path-stalled", "source-progress-stalled", "upstream-recovering"], playbackMode: ["mse", "clips", "hls", "hls-native"], playbackFallbackReason: ["unsupported-mse", "decode-error", "buffer-open", "buffer-error", "buffer-append", "buffer-quota", "manual-compatibility", "seek-stalled", "open-timeout", "unknown"], mark: ["sound-heard", "picture-ok", "chat-ok", "no-sound", "picture-frozen", "out-of-sync", "chat-problem", "connection-lost", "relay-leaving", "network-change"], finish: ["ended", "left", "closed", "interrupted", "recording-stopped", "unknown"] };
  const adaptivePhases = ["warmup", "starting", "playing", "rebuffering", "suspended", "recovering"];
  const fields = ["effectiveTargetProgramTime", "extraDelaySeconds", "bufferGoalSeconds", "rebufferCount", "adaptiveSeekCount", "delay", "programTime", "targetProgramTime", "drift", "reserveSeconds", "bufferedSeconds", "received", "sentBytes", "stalls", "recoveryCount", "attempts", "aggregateMbps", "queue", "peerCount", "ready", "paused", "muted", "volume", "decodedFrames", "droppedFrames", "mediaErrorCode", "playbackBlocked", "visible", "online", "sourceReachable", "sourceEnded", "clockReady", "clockOffsetMs", "pendingBytes", "oldestPendingMs", "congestedChildren", "measuredChildren", "relayLimit", "forwardingCount", "leafOnly", "controlFailures", "chatMessageCount"];
  function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? Math.max(-1e12, Math.min(1e12, v)) : null;
  }
  function date(v) {
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1e15, v)) : null;
  }
  function count(v) {
    const n = num(v);
    return n === null ? null : Math.max(0, n);
  }
  function bool(v) {
    return typeof v === "boolean" ? v : null;
  }
  function pick(v, list) {
    return list.includes(v) ? v : null;
  }
  function hashTag(v) {
    return typeof v === "string" && /^[a-f0-9]{12}$/i.test(v) ? v.toLowerCase() : null;
  }
  function safeNetworkRecovery(x) {
    if (!x || typeof x !== "object") return null;
    const bounded = (value, max) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : null;
    return { discoveryResets: bounded(x.discoveryResets, 86400), bootstrapRetries: bounded(x.bootstrapRetries, 86400), resetState: pick(x.resetState, ["idle", "scheduled", "renewing", "renewed", "unsupported", "failed"]), resetProblem: pick(x.resetProblem, ["discovery-adapter-unavailable", "discovery-renewal-failed", "discovery-session-ended"]), retryInSeconds: bounded(x.retryInSeconds, 60) };
  }
  function safeCommonStart(x) {
    if(!x||typeof x!=="object")return null;
    const delay=v=>Number.isInteger(v)&&v>=30&&v<=300?v:null;
    const reserve=v=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=60?v:null;
    return {enabled:bool(x.enabled),state:pick(x.state,["pending","selected","fallback"]),delaySeconds:delay(x.delaySeconds),reserveSeconds:reserve(x.reserveSeconds),reason:pick(x.reason,["waiting-for-source-decision","waiting-for-first-viewer","need-fresh-live-observations","verified-delivery","observation-timeout","unsupported-peer","sustained-delivery-deficit","candidate-exceeds-limit"]),conflict:bool(x.conflict),fallbackDelaySeconds:x.fallbackDelaySeconds===300?300:null,...(x.version===2?{version:2,startRemainingSeconds:typeof x.startRemainingSeconds==='number'&&Number.isFinite(x.startRemainingSeconds)?Math.max(0,Math.min(300,x.startRemainingSeconds)):null}:{})};
  }
  function safeInitialDelay(x) {
    if(!x||typeof x!=="object")return null;
    const bounded=(v,max)=>typeof v==="number"&&Number.isFinite(v)?Math.max(0,Math.min(max,v)):null;
    const reasons=["Trying another player.","candidate-exceeds-group-bound","candidate-not-shorter","checking-verified-decoder-headroom","decoder-preparation-error","decoder-preparation-timeout","feature-disabled","need-fresh-live-observations","observation-timeout","playback-already-started","player-preparation-unavailable","preparation-clock-unknown","preparation-evidence-revoked","preparation-outside-group-bound","preparation-reserve-increased","preparation-route-interrupted","room-start-due","sustained-delivery-deficit","unsupported-native-reserve","unsupported-reserve-goal","verified-decoder-headroom"];
    return {enabled:typeof x.enabled==="boolean"?x.enabled:null,applied:typeof x.applied==="boolean"?x.applied:null,state:pick(x.state,["disabled","observing","preparing","fallback","committed"]),reason:pick(x.reason,reasons),roomDelaySeconds:bounded(x.roomDelaySeconds,420),selectedDelaySeconds:bounded(x.selectedDelaySeconds,420),candidateDelaySeconds:bounded(x.candidateDelaySeconds,420),reserveGoalSeconds:bounded(x.reserveGoalSeconds,60),actualDelaySeconds:bounded(x.actualDelaySeconds,86400),commitCount:bounded(x.commitCount,1)};
  }
  function safeClientDelivery(x) {
    if (!x || typeof x !== "object") return null;
    const o = {
      state: pick(x.state,["insufficient-data","observing","constrained","risk","stale","suspended","offline","clock-unknown","path-absent"]),
      confidence: pick(x.confidence,["none","low","medium"]), classification:pick(x.classification,["unknown","live","catchup"]),
      capacityKnown:x.capacityKnown===false?false:null
    };
    const limits={sourceBitrateBps:1e9,deliveredGoodputBps:1e9,activeTransferGoodputBps:1e10,deliveryToStreamRatio:10000,signedProgressSeconds:3600,gapMeanSeconds:3600,gapStddevSeconds:3600,gapP95Seconds:3600,sourceToVerifiedAgeP95Seconds:86400,reserveSeconds:3600,decoderAheadSeconds:600,extraDelaySeconds:600,baselineDelaySeconds:3600,reserveCoverage:1,baselineReserveFraction:1,deficitSeconds:3600,routeAgeSeconds:86400,lastProgressAgeSeconds:86400,observationSeconds:3600,recordCount:128,sampleCount:64};
    for(const [key,max]of Object.entries(limits))o[key]=typeof x[key]==="number"&&Number.isFinite(x[key])?Math.max(0,Math.min(max,x[key])):null;
    for(const key of ["sourceAgeTrendSecondsPerSecond","reserveTrendSecondsPerSecond"])o[key]=typeof x[key]==="number"&&Number.isFinite(x[key])?Math.max(-1000,Math.min(1000,x[key])):null;
    for(const key of ["recordCount","sampleCount"])if(o[key]!==null)o[key]=Math.floor(o[key]);
    const r=x.recommendation&&typeof x.recommendation==="object"?x.recommendation:{};
    const bounded=(v,max)=>typeof v==="number"&&Number.isFinite(v)&&v>=6&&v<=max?v:null;
    o.recommendation={status:pick(r.status,["insufficient-data","unvalidated-candidate","catchup","insufficient-throughput"]),reason:pick(r.reason,["observed-delivery-deficit","observed-delay-exceeds-bound","historical-catchup-does-not-establish-startup","observed-live-age-plus-gap-reserve","need-fresh-live-observations","insufficient-data","stale","suspended","offline","clock-unknown","path-absent"]),candidateInitialDelaySeconds:bounded(r.candidateInitialDelaySeconds,420),candidateReserveSeconds:bounded(r.candidateReserveSeconds,60),applied:r.applied===false?false:null,validated:r.validated===false?false:null,extraDelayFixesSustainedDeficit:r.extraDelayFixesSustainedDeficit===false?false:null};
    return o;
  }
  function safeState(x) {
    x = x && typeof x === "object" ? x : {};
    const o = {};
    for (const k of fields) {
      let v = x[k];
      o[k] = k === "ready" ? typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(4, v)) : null : k === "mediaErrorCode" ? Number.isInteger(v) && v >= 1 && v <= 4 ? v : null : ["paused", "muted", "playbackBlocked", "visible", "online", "sourceReachable", "sourceEnded", "clockReady", "leafOnly"].includes(k) ? bool(v) : k === "drift" || k === "programTime" || k === "targetProgramTime" || k === "effectiveTargetProgramTime" || k === "clockOffsetMs" ? num(v) : count(v);
    }
    for (const [key, max] of [["extraDelaySeconds",86400],["bufferGoalSeconds",30],["rebufferCount",1000000],["adaptiveSeekCount",1000000]]) o[key] = typeof x[key] === "number" && Number.isFinite(x[key]) ? Math.min(max, Math.max(0, x[key])) : null;
    for(const key of ["rebufferCount","adaptiveSeekCount"])if(o[key]!==null)o[key]=Math.floor(o[key]);
    o.adaptivePhase = pick(x.adaptivePhase, adaptivePhases);
    o.role = pick(x.role, enums.role);
    o.recovery = pick(x.recovery, enums.recovery);
    o.reason = pick(x.reason, enums.reason);
    o.supplierHealth = pick(x.supplierHealth, enums.health);
    o.sourceAudio = pick(x.sourceAudio, enums.audio);
    o.networkRecovery = safeNetworkRecovery(x.networkRecovery);
    o.clientDelivery = safeClientDelivery(x.clientDelivery);
    o.initialDelay = safeInitialDelay(x.initialDelay);
    o.commonStart = safeCommonStart(x.commonStart);
    o.playbackMode = pick(x.playbackMode, enums.playbackMode);
    o.mediaMode = pick(x.mediaMode, ["audio", "v360", "v480"]);
    o.playbackFallbackReason = x.playbackFallbackReason === null ? null : pick(x.playbackFallbackReason, enums.playbackFallbackReason);
    if (x.mediaDiagnostics && typeof x.mediaDiagnostics === "object") {
      o.mediaDiagnostics = safeMediaDiagnostics(x.mediaDiagnostics);
      if (o.role !== "source") o.mediaDiagnostics.capture = null;
    }
    return o;
  }
  function safeMediaDiagnostics(x) {
    x = x && typeof x === "object" ? x : {};
    const metric = (v, max = 1e6) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : null;
    const dimension = (v) => Number.isInteger(v) && v >= 0 && v <= 16384 ? v : null;
    const group = (name, fields) => x[name] && typeof x[name] === "object" ? fields(x[name]) : null;
    // Independent HLS renderers have different clocks and buffers. Keep only
    // bounded, coded facts; never copy raw player errors or identifiers.
    const stream = (p) => p && typeof p === "object" ? {
      decoderBufferedSeconds: metric(p.decoderBufferedSeconds, 86400),
      playableAheadSeconds: metric(p.playableAheadSeconds, 86400),
      mediaElementTime: metric(p.mediaElementTime, 86400),
      extraDelaySeconds: metric(p.extraDelaySeconds, 86400),
      adaptivePhase: pick(p.adaptivePhase, adaptivePhases),
      cacheBytes: metric(p.cacheBytes, 192 * 1024 * 1024),
      cacheFiles: metric(p.cacheFiles, 1e6),
      errorCount: metric(p.errorCount, 1e6),
      playError: pick(p.playError, ["NotAllowedError", "NotSupportedError", "AbortError", "Other"]),
      decodedFrames: metric(p.decodedFrames, 1e12),
      droppedFrames: metric(p.droppedFrames, 1e12)
    } : null;
    return {
      capture: group("capture", (c) => ({ mediaProfile:pick(c.mediaProfile,["hls-cmaf-v1"]),encoderVideoPackets:metric(c.encoderVideoPackets,1e12),encoderAudioPackets:metric(c.encoderAudioPackets,1e12),encoderStartupOffsetSeconds:metric(c.encoderStartupOffsetSeconds,60),pixelNormalization:pick(c.pixelNormalization,["starting","active","unsupported","error","closed"]),normalizedFrames:metric(c.normalizedFrames,1e9),normalizationMeanMs:metric(c.normalizationMeanMs,1e5),normalizationMaxMs:metric(c.normalizationMaxMs,1e5),normalizationTargetFrameRate:metric(c.normalizationTargetFrameRate,240),width: dimension(c.width), height: dimension(c.height), frameRate: metric(c.frameRate, 240), targetVideoMbps: metric(c.targetVideoMbps, 1000), actualMediaMbps: metric(c.actualMediaMbps, 1000), lastPieceSeconds: metric(c.lastPieceSeconds, 3600), lastPieceAgeSeconds: metric(c.lastPieceAgeSeconds, 86400), recordingLatencyMs: metric(c.recordingLatencyMs, 1e7), sourceAudio: pick(c.sourceAudio, enums.audio) })),
      delivery: group("delivery", (d) => ({ requiredPiecePresent: bool(d.requiredPiecePresent), requiredPieceLeadMs: typeof d.requiredPieceLeadMs === "number" && Number.isFinite(d.requiredPieceLeadMs) ? Math.max(-60000, Math.min(600000, d.requiredPieceLeadMs)) : null, verifiedReserveSeconds: metric(d.verifiedReserveSeconds, 86400) })),
      playback: group("playback", (p) => ({ ...(p.audio || p.video ? { audio: stream(p.audio), video: stream(p.video) } : {}), extraDelaySeconds:metric(p.extraDelaySeconds,86400),adaptivePhase:pick(p.adaptivePhase,adaptivePhases),bufferGoalSeconds:metric(p.bufferGoalSeconds,30),rebufferCount:metric(p.rebufferCount,1e6)===null?null:Math.floor(metric(p.rebufferCount,1e6)),adaptiveSeekCount:metric(p.adaptiveSeekCount,1e6)===null?null:Math.floor(metric(p.adaptiveSeekCount,1e6)), hlsVersion:typeof p.hlsVersion==='string'&&/^\d+\.\d+\.\d+$/.test(p.hlsVersion)?p.hlsVersion:null,cacheBytes:metric(p.cacheBytes,192*1024*1024),cacheFiles:metric(p.cacheFiles,1e6),errorCount:metric(p.errorCount,1e6),mseImplementation:pick(p.mseImplementation,["managed","standard"]),mseNormalized:bool(p.mseNormalized),mseProgramOriginSeconds:metric(p.mseProgramOriginSeconds,86400),nativeProgramOriginSeconds:metric(p.nativeProgramOriginSeconds,86400),nativeSeekableStartSeconds:metric(p.nativeSeekableStartSeconds,86400),nativeSeekableEndSeconds:metric(p.nativeSeekableEndSeconds,86400),initialProgrammeStart:metric(p.initialProgrammeStart,86400),presentedFrameTime:metric(p.presentedFrameTime,86400),presentedFrameAgeMs:metric(p.presentedFrameAgeMs,1e7),mediaElementTime:metric(p.mediaElementTime,86400),syncSeekRequests:metric(p.syncSeekRequests,1e7),gapSeekRequests:metric(p.gapSeekRequests,1e7), mseErrorPhase:pick(p.mseErrorPhase,["remove","timestamp-offset","append"]),mseErrorName:pick(p.mseErrorName,["QuotaExceededError","InvalidStateError","NotSupportedError","TypeError","Other"]),mseEvictions:metric(p.mseEvictions),mseQuotaRecoveries:metric(p.mseQuotaRecoveries),decoderBufferedSeconds:metric(p.decoderBufferedSeconds,86400),appendQueuePieces:metric(p.appendQueuePieces,20),seekCount:metric(p.seekCount),seekPendingMs:metric(p.seekPendingMs,1e7),longestSeekMs:metric(p.longestSeekMs,1e7),muted:bool(p.muted),soundBlocked:bool(p.soundBlocked),soundRequested:bool(p.soundRequested),playError:pick(p.playError,["NotAllowedError","NotSupportedError","AbortError","Other"]),mode: pick(p.mode, ["mse", "clips", "native-window", "hls", "hls-native"]), packagingReason: pick(p.packagingReason,["short","configuration","timeline","size","structure","inband-config","overlap","decode"]), fallbackReason: p.fallbackReason === null ? null : pick(p.fallbackReason, enums.playbackFallbackReason), errorCode: Number.isInteger(p.errorCode) && p.errorCode >= 1 && p.errorCode <= 4 ? p.errorCode : null, width: dimension(p.width), height: dimension(p.height), playableAheadSeconds: metric(p.playableAheadSeconds, 86400), windowSeconds: metric(p.windowSeconds, 86400), srcChanges: metric(p.srcChanges, 1e6), lastLoadMs: metric(p.lastLoadMs, 1e7), firstFrameMs: metric(p.firstFrameMs, 1e7), decodedFrames: metric(p.decodedFrames, 1e12), droppedFrames: metric(p.droppedFrames, 1e12) }))
    };
  }
  function assessMediaDiagnostics(status, samples) {
    status = status && typeof status === "object" ? status : {};
    const md = status.mediaDiagnostics || {}, capture = md.capture || {}, delivery = md.delivery || {}, playback = md.playback || {};
    const findings = [];
    const pastWarmup = typeof status.targetProgramTime === "number" && status.targetProgramTime >= 0;
    if (status.role === "source" && typeof capture.lastPieceAgeSeconds === "number" && capture.lastPieceAgeSeconds > 10) findings.push({ layer: "capture", code: "source-piece-stale" });
    if (pastWarmup && delivery.requiredPiecePresent === false) findings.push({ layer: "delivery", code: "required-piece-missing" });
    if (delivery.requiredPiecePresent === true && ((status.playbackBlocked !== true && pastWarmup && typeof status.ready === "number" && status.ready <= 1) || playback.errorCode !== null && playback.errorCode !== undefined || status.mediaErrorCode !== null && status.mediaErrorCode !== undefined)) findings.push({ layer: "playback", code: "decoder-startup-evidence" });
    const prior = Array.isArray(samples) && samples.length > 1 ? samples[samples.length - 2] : null;
    const current = Array.isArray(samples) && samples.length ? samples[samples.length - 1] : null;
    const oldPlayback = prior?.mediaDiagnostics?.playback, currentPlayback = current?.mediaDiagnostics?.playback;
    const frameCount = currentPlayback?.decodedFrames ?? current?.decodedFrames;
    const oldFrameCount = oldPlayback?.decodedFrames ?? prior?.decodedFrames;
    const targetAdvanced = typeof current?.targetProgramTime === "number" && typeof prior?.targetProgramTime === "number" && current.targetProgramTime - prior.targetProgramTime >= 2;
    const intervalMs = typeof current?.at === "number" && typeof prior?.at === "number" ? current.at - prior.at : null;
    const active = (sample) => sample?.visible === true && sample?.paused === false && sample?.playbackBlocked === false;
    if (status.mediaMode !== "audio" && prior?.mediaMode !== "audio" && current?.mediaMode !== "audio" && prior && current && frameCount !== null && frameCount !== undefined && oldFrameCount !== null && oldFrameCount !== undefined && frameCount <= oldFrameCount && active(prior) && active(current) && prior.mediaDiagnostics?.delivery?.requiredPiecePresent === true && current.mediaDiagnostics?.delivery?.requiredPiecePresent === true && targetAdvanced && currentPlayback?.srcChanges === oldPlayback?.srcChanges && (intervalMs === null || intervalMs >= 2000)) findings.push({ layer: "playback", code: "no-frame-growth" });
    if (findings.length) return { state: "evidence", findings };
    if (status.playbackBlocked === true) return { state: "autoplay-or-user-action", findings: [{ layer: "playback", code: "playback-blocked" }] };
    if (status.mediaMode !== "audio" && delivery.requiredPiecePresent === true && playback.decodedFrames > 0) return { state: "observed-playback", findings: [] };
    return { state: "unknown", findings: [] };
  }
  function safeEventValue(e) {
    if (e.type === "mark") return pick(e.value, enums.mark);
    if (e.type === "app-error") return e.value === "error" || e.value === "unhandled-rejection" ? e.value : null;
    if (e.type === "recovery") {
      const m = typeof e.value === "string" && /^(idle|searching|connected|exhausted|manual-rejoin|stopped)-\d{1,9}-(none|timeout|network|source-ended|no-supplier|manual|unknown|media-stalled|supplier-failed|supplier-disconnected|automatic-retry|supplier-unresponsive|source-path-stalled|source-progress-stalled)$/.exec(e.value);
      return m ? e.value : null;
    }
    if (e.type === "supplier-change") return e.value === "changed" ? "changed" : null;
    if (e.type === "source-audio") return pick(e.value, enums.audio);
    if (e.type === "visibility") return e.value === "true" || e.value === "false" ? e.value : null;
    if (e.type === "online") return e.value === "true" || e.value === "false" ? e.value : null;
    return null;
  }
  function cleanReport(x) {
    if (!x || typeof x !== "object") return null;
    const id = typeof x.reportId === "string" && /^[a-f0-9]{16}$/i.test(x.reportId) ? x.reportId.toLowerCase() : null;
    if (!id) return null;
    return { version: 1, reportId: id, build: typeof x.build === "string" && /^(local|[a-f0-9]{7,40})$/.test(x.build) ? x.build : null, castTag: hashTag(x.castTag), startedAt: date(x.startedAt), endedAt: date(x.endedAt), durationSeconds: count(x.durationSeconds), samplesDropped: count(x.samplesDropped) || 0, eventsDropped: count(x.eventsDropped) || 0, finish: pick(x.finish, enums.finish), persisted: bool(x.persisted), samples: Array.isArray(x.samples) ? x.samples.slice(-MAX_SAMPLES).map((s) => ({ at: date(s && s.at), gapSeconds: num(s && s.gapSeconds), ...safeState(s && (s.state || s)) })) : [], events: Array.isArray(x.events) ? x.events.slice(-MAX_EVENTS).map((e) => ({ at: date(e && e.at), atSeconds: num(e && e.atSeconds), type: pick(e && e.type, ["recovery", "supplier-change", "source-audio", "visibility", "online", "app-error", "mark"]), value: safeEventValue(e || {}) })).filter((e) => e.value) : [], counts: x.counts && typeof x.counts === "object" ? { observations: num(x.counts.observations) || 0, supplierChanges: num(x.counts.supplierChanges) || 0, marks: num(x.counts.marks) || 0, errors: num(x.counts.errors) || 0 } : { observations: 0, supplierChanges: 0, marks: 0, errors: 0 }, status: safeState(x.status) };
  }
  function trimSamples(report, n) {
    if (!report || !n) return;
    const removed = report.samples.splice(0, n).length;
    report.samplesDropped = (report.samplesDropped || 0) + removed;
  }
  function randomId() {
    const b = new Uint8Array(8);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b);
    else for (let i = 0; i < 8; i++) b[i] = Math.random() * 256 | 0;
    return [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function Collector(opts) {
    opts = opts || {};
    this.now = opts.now || Date.now;
    this.mono = opts.monotonic || (() => root.performance?.now?.() ?? this.now());
    this.storage = opts.storage || null;
    this.build = typeof opts.build === "string" ? opts.build : null;
    this.castId = null;
    this.lastSupplier = null;
    this.lastState = null;
    this.lastSample = -Infinity;
    this.session = null;
    this.previous = null;
    this.persisted = !!this.storage;
    this._restore();
  }
  Collector.prototype._restore = function() {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return;
      if (raw.length > MAX_BYTES) throw Error();
      const x = JSON.parse(raw);
      this.previous = cleanReport(x?.last);
      if (x?.active && !x.active.endedAt) {
        const interrupted = cleanReport(x.active);
        if (interrupted) {
          interrupted.finish = "interrupted";
          this.previous = interrupted;
        }
      }
    } catch (_) {
      this.previous = null;
      this.persisted = false;
    }
  };
  Collector.prototype._persist = function() {
    try {
      if (!this.storage) throw Error();
      const active = this.session && !this.session.endedAt ? this.session : null;
      const last = this.session?.endedAt ? this.session : this.previous;
      const pack = () => JSON.stringify({ active: cleanReport(active), last: cleanReport(last) });
      if (this.session) this.session.persisted = true;
      let data = pack();
      for (let tries = 0; data.length > MAX_BYTES && tries < 12; tries++) {
        const target = last?.samples.length ? last : active;
        if (!target?.samples.length) break;
        const remove = Math.max(1, Math.ceil(target.samples.length * Math.min(0.8, (data.length - MAX_BYTES) / data.length + 0.05)));
        trimSamples(target, remove);
        data = pack();
      }
      if (data.length > MAX_BYTES) throw Error();
      this.storage.setItem(KEY, data);
      this.persisted = true;
    } catch (_) {
      this.persisted = false;
      if (this.session) this.session.persisted = false;
    }
  };
  Collector.prototype._start = function(cfg) {
    if (this.session) {
      if (!this.session.endedAt) this.finish("left");
      this.previous = cleanReport(this.session);
    }
    this.session = { version: 1, reportId: randomId(), build: this.build, castTag: null, startedAt: date(this.now()), endedAt: null, durationSeconds: 0, finish: null, persisted: this.persisted, samplesDropped: 0, eventsDropped: 0, samples: [], events: [], counts: { observations: 0, supplierChanges: 0, marks: 0, errors: 0 }, status: {} };
    this.session.startedMono = this.mono();
    this.castId = typeof cfg.id === "string" ? cfg.id : null;
    this.lastSupplier = null;
    this.lastState = null;
    this.lastSample = -Infinity;
    this._persist();
  };
  Collector.prototype.setCastTag = function(tag) {
    if (this.session) this.session.castTag = hashTag(tag);
    this._persist();
  };
  Collector.prototype._event = function(type, value) {
    if (!this.session) return;
    this.session.events.push({ at: date(this.now()), atSeconds: num(Math.max(0, (this.mono() - this.session.startedMono) / 1e3)), type, value });
    if (this.session.events.length > MAX_EVENTS) {
      const n = this.session.events.length - MAX_EVENTS;
      this.session.events.splice(0, n);
      this.session.eventsDropped += n;
    }
  };
  Collector.prototype.observe = function(snapshot, playerFacts, environment) {
    snapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    const cfg = snapshot.config;
    if (cfg && typeof cfg.id === "string" && (cfg.id !== this.castId || this.session?.endedAt)) this._start(cfg);
    else if (!cfg && this.session && !this.session.endedAt) this.finish("ended");
    if (!this.session || this.session.endedAt) return this.summary();
    const d = snapshot.delivery || {}, r = snapshot.recovery || {}, p = playerFacts || {}, env = environment || {};
    const network = snapshot.network || snapshot.transport?.network || {};
    const state = safeState({ commonStart:snapshot.commonStart, initialDelay:snapshot.initialDelay, clientDelivery:snapshot.clientDelivery, networkRecovery: { discoveryResets: network.discoveryResets, bootstrapRetries: network.bootstrapRetries, resetState: network.resetState, resetProblem: network.resetProblem, retryInSeconds: Number.isFinite(network.retryAt) ? Math.ceil((network.retryAt - this.now()) / 1000) : null }, role: snapshot.role, mediaMode:snapshot.mediaMode, leafOnly:snapshot.leafOnly, delay: cfg?.delay, programTime: snapshot.programTime, targetProgramTime: snapshot.targetProgramTime, effectiveTargetProgramTime:snapshot.effectiveTargetProgramTime,extraDelaySeconds:snapshot.playbackExtraDelaySeconds,adaptivePhase:snapshot.playbackAdaptivePhase,bufferGoalSeconds:snapshot.mediaDiagnostics?.playback?.bufferGoalSeconds,rebufferCount:snapshot.mediaDiagnostics?.playback?.rebufferCount,adaptiveSeekCount:snapshot.mediaDiagnostics?.playback?.adaptiveSeekCount, drift: snapshot.drift, reserveSeconds: snapshot.reserveSeconds, bufferedSeconds: snapshot.bufferedSeconds, received: snapshot.received, sentBytes: snapshot.sentBytes, stalls: snapshot.stalls, recovery: r.state, recoveryCount: r.recoveries, attempts: r.attempts, reason: r.reason, sourceReachable: snapshot.sourceReachable, sourceEnded: snapshot.sourceEnded, supplierHealth: snapshot.supplierHealth, sourceAudio: snapshot.sourceAudio?.status, clockReady: snapshot.clockReady, clockOffsetMs: snapshot.offset, playbackMode: snapshot.playbackMode, playbackFallbackReason: snapshot.playbackFallbackReason, mediaErrorCode: snapshot.mediaErrorCode, mediaDiagnostics: snapshot.mediaDiagnostics, aggregateMbps: d.measured === true ? d.deliveredMbps : null, pendingBytes: Array.isArray(d.peers) ? d.peers.reduce((a, p2) => a + (count(p2?.pendingBytes) || 0), 0) : null, oldestPendingMs: Array.isArray(d.peers) ? d.peers.reduce((a, p2) => Math.max(a, count(p2?.oldestPendingMs) || 0), 0) : null, congestedChildren: Array.isArray(d.peers) ? d.peers.filter((p2) => p2?.health === "congested").length : null, measuredChildren: Array.isArray(d.peers) ? d.peers.filter((p2) => p2?.measured === true).length : null, relayLimit: d.relayLimit, forwardingCount: Array.isArray(d.peers) ? d.peers.length : null, controlFailures: env.controlFailures, chatMessageCount: env.chatMessageCount, queue: Array.isArray(snapshot.peers) ? snapshot.peers.reduce((a, q) => a + (Number.isFinite(q?.queued) ? q.queued : Number.isFinite(q?.queuedBytes) ? q.queuedBytes : 0), 0) : null, peerCount: Array.isArray(snapshot.peers) ? snapshot.peers.length : null, ready: p.ready, paused: p.paused, muted: p.muted, volume: p.volume, decodedFrames: p.decodedFrames, droppedFrames: p.droppedFrames, playbackBlocked: p.playbackBlocked, visible: env.visible, online: env.online });
    this.session.counts.observations++;
    const prev = this.lastState;
    if (prev) {
      for (const [k, t] of [["sourceAudio", "source-audio"], ["visible", "visibility"], ["online", "online"]]) if (state[k] !== prev[k] && state[k] !== null) this._event(t, String(state[k]));
      if (state.recovery !== prev.recovery || state.recoveryCount !== prev.recoveryCount || state.reason !== prev.reason) {
        const v = [state.recovery || "idle", Math.max(0, Math.round(state.recoveryCount || 0)), state.reason || "unknown"].join("-");
        this._event("recovery", v);
      }
    }
    if (snapshot.supplier && typeof snapshot.supplier === "object" && typeof snapshot.supplier.id === "string") {
      const sid = snapshot.supplier.id;
      if (this.lastSupplier !== null && this.lastSupplier !== sid) {
        this.session.counts.supplierChanges++;
        this._event("supplier-change", "changed");
      }
      this.lastSupplier = sid;
    }
    this.lastState = state;
    this.session.status = state;
    const mt = this.mono(), elapsed = Math.max(0, (mt - this.session.startedMono) / 1e3 || 0);
    this.session.durationSeconds = Math.round(elapsed);
    if (mt - this.lastSample >= SAMPLE_MS) {
      const gap = this.lastSample === -Infinity ? null : Math.max(0, (mt - this.lastSample) / 1e3 - SAMPLE_MS / 1e3);
      this.session.samples.push({ at: date(this.now()), gapSeconds: num(gap), ...state });
      if (this.session.samples.length > MAX_SAMPLES) trimSamples(this.session, this.session.samples.length - MAX_SAMPLES);
      this.lastSample = mt;
      this._persist();
    }
    return this.summary();
  };
  Collector.prototype.mark = function(code) {
    const c = pick(code, enums.mark);
    if (c && this.session) {
      this.session.counts.marks++;
      this._event("mark", c);
      this._persist();
      return true;
    }
    return false;
  };
  Collector.prototype.appError = function(code) {
    if (this.session && !this.session.endedAt) {
      const c = code === "unhandled-rejection" ? "unhandled-rejection" : "error";
      this.session.counts.errors++;
      this._event("app-error", c);
      this._persist();
    }
  };
  Collector.prototype.finish = function(reason) {
    if (!this.session || this.session.endedAt) return this.report();
    this.session.finish = pick(reason, enums.finish) || "unknown";
    this.session.endedAt = date(this.now());
    const mt = this.mono();
    this.session.durationSeconds = Math.round(Math.max(0, (mt - this.session.startedMono) / 1e3 || 0));
    this.session.status = this.lastState || {};
    this.previous = this.session;
    this._persist();
    return this.report();
  };
  Collector.prototype.report = function() {
    return cleanReport(this.session || this.previous);
  };
  Collector.prototype.summary = function() {
    const r = this.session || this.previous;
    if (!r) return null;
    return cleanSummary({ reportId: r.reportId, castTag: r.castTag, durationSeconds: r.durationSeconds, finish: r.finish, counts: r.counts, samplesDropped: r.samplesDropped, eventsDropped: r.eventsDropped, lastStatus: r.status, events: r.events.slice(-12) });
  };
  Collector.prototype.clear = function() {
    this.session = null;
    this.previous = null;
    this.castId = null;
    this.lastState = null;
    this.lastSupplier = null;
    try {
      this.storage?.removeItem(KEY);
    } catch (_) {
      this.persisted = false;
    }
  };
  function cleanSummary(x) {
    try {
      if (typeof x === "string") x = JSON.parse(x);
      if (!x || typeof x !== "object") return null;
      const id = typeof x.reportId === "string" && /^[a-f0-9]{16}$/i.test(x.reportId) ? x.reportId.toLowerCase() : null;
      if (!id) return null;
      const events = Array.isArray(x.events) ? x.events.slice(-12).map((e) => ({ atSeconds: num(e && e.atSeconds), type: pick(e && e.type, ["recovery", "supplier-change", "source-audio", "visibility", "online", "app-error", "mark"]), value: safeEventValue(e || {}) })).filter((e) => e.type && e.value) : [];
      const o = { version: 1, reportId: id, castTag: hashTag(x.castTag), durationSeconds: count(x.durationSeconds), samplesDropped: count(x.samplesDropped) || 0, eventsDropped: count(x.eventsDropped) || 0, finish: pick(x.finish, enums.finish), counts: { observations: num(x.counts?.observations) || 0, supplierChanges: num(x.counts?.supplierChanges) || 0, marks: num(x.counts?.marks) || 0, errors: num(x.counts?.errors) || 0 }, lastStatus: safeState(x.lastStatus), events };
      // Host snapshots have a separate 4 KiB ceiling. Preserve the session and
      // essential current measurements rather than losing it to added detail.
      if(o.lastStatus.clientDelivery){const d=o.lastStatus.clientDelivery,compact={};for(const key of ["state","confidence","classification","capacityKnown","sourceBitrateBps","deliveredGoodputBps","deliveryToStreamRatio","reserveSeconds","baselineDelaySeconds","baselineReserveFraction","decoderAheadSeconds","extraDelaySeconds","gapP95Seconds","recommendation"])compact[key]=d[key];o.lastStatus.clientDelivery=compact;}
      o.summaryDetailsReduced=x.summaryDetailsReduced===true;
      while(o.events.length&&JSON.stringify(o).length>4096){o.events.shift();o.eventsDropped++;o.summaryDetailsReduced=true;}
      return JSON.stringify(o).length <= 4096 ? o : null;
    } catch (_) {
      return null;
    }
  }
  root.SameEndDiagnosticsCore = { Collector, cleanSummary, safeMediaDiagnostics, assessMediaDiagnostics, safeClientDelivery, safeInitialDelay, safeCommonStart };
})(typeof window !== "undefined" ? window : globalThis);
