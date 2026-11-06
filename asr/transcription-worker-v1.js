"use strict";
(() => {
  // asr-assets.mjs
  var ASR_MODEL = Object.freeze({
    "bytes": 32166155,
    "sha256": "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b",
    "parts": [
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-00.bin",
        "bytes": 4194304,
        "sha256": "1f1ac551e2d7b6d974ca05cbf557173d9d161619e0368dad0845b9df81e9849f"
      },
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-01.bin",
        "bytes": 4194304,
        "sha256": "d15a8bfbe7a1223285bcd6aeb261a5d1cf006baf0e096b82e64cfbaa421ed223"
      },
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-02.bin",
        "bytes": 4194304,
        "sha256": "4db565001e5e20306eb0575851170254e8059d5c11a8d1450fda084c5acd31a9"
      },
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-03.bin",
        "bytes": 4194304,
        "sha256": "706a21acb580dd31617af05abe85a515a2c6880734afc73c5988302256b7e3b8"
      },
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-04.bin",
        "bytes": 4194304,
        "sha256": "74e92edb8164a6cb6cc2b03dc87101d6c5483d93224176c95f579ffc95311556"
      },
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-05.bin",
        "bytes": 4194304,
        "sha256": "aa9fce4a96bcb68b2609851f5eac9b3d3969beda335d5335b33b7ab22fbf1dda"
      },
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-06.bin",
        "bytes": 4194304,
        "sha256": "23ee3abb18edbedc258eb484b156de15eb72ddc95081965c0b93c6819a06f89d"
      },
      {
        "path": "/asr/tiny-en-q5_1-c77c5766-07.bin",
        "bytes": 2806027,
        "sha256": "6bcf1b0548c0fa373cd6f690da1fa911130c68a03eff6a01c4c9c19e283aac32"
      }
    ]
  });
  var ASR_RUNTIME = Object.freeze({
    "script": "/asr/same-end-asr-7aa36f392106.js",
    "wasm": "/asr/same-end-asr-f6b7434fe7ba.wasm",
    "worker": "/asr/transcription-worker-v1.js",
    "worklet": "/asr/transcription-audio-worklet-v1.js"
  });
  var ASR_HTTP_ASSETS = Object.freeze({
    "/asr/same-end-asr-7aa36f392106.js": {
      "mime": "text/javascript; charset=utf-8",
      "bytes": 11614,
      "sha256": "7aa36f392106d2902734321aa09636379c8d50840385e3bf1c6684abe5c8f5f2",
      "vendor": "same-end-asr.js"
    },
    "/asr/same-end-asr-f6b7434fe7ba.wasm": {
      "mime": "application/wasm",
      "bytes": 1228142,
      "sha256": "f6b7434fe7bade5ed76d5604bda3b8f1b804d92bf6857c70eebe8a2b51252f0f",
      "vendor": "same-end-asr.wasm"
    },
    "/asr/transcription-worker-v1.js": {
      "mime": "text/javascript; charset=utf-8"
    },
    "/asr/transcription-audio-worklet-v1.js": {
      "mime": "text/javascript; charset=utf-8"
    },
    "/asr/tiny-en-q5_1-c77c5766-00.bin": {
      "mime": "application/octet-stream",
      "bytes": 4194304,
      "sha256": "1f1ac551e2d7b6d974ca05cbf557173d9d161619e0368dad0845b9df81e9849f"
    },
    "/asr/tiny-en-q5_1-c77c5766-01.bin": {
      "mime": "application/octet-stream",
      "bytes": 4194304,
      "sha256": "d15a8bfbe7a1223285bcd6aeb261a5d1cf006baf0e096b82e64cfbaa421ed223"
    },
    "/asr/tiny-en-q5_1-c77c5766-02.bin": {
      "mime": "application/octet-stream",
      "bytes": 4194304,
      "sha256": "4db565001e5e20306eb0575851170254e8059d5c11a8d1450fda084c5acd31a9"
    },
    "/asr/tiny-en-q5_1-c77c5766-03.bin": {
      "mime": "application/octet-stream",
      "bytes": 4194304,
      "sha256": "706a21acb580dd31617af05abe85a515a2c6880734afc73c5988302256b7e3b8"
    },
    "/asr/tiny-en-q5_1-c77c5766-04.bin": {
      "mime": "application/octet-stream",
      "bytes": 4194304,
      "sha256": "74e92edb8164a6cb6cc2b03dc87101d6c5483d93224176c95f579ffc95311556"
    },
    "/asr/tiny-en-q5_1-c77c5766-05.bin": {
      "mime": "application/octet-stream",
      "bytes": 4194304,
      "sha256": "aa9fce4a96bcb68b2609851f5eac9b3d3969beda335d5335b33b7ab22fbf1dda"
    },
    "/asr/tiny-en-q5_1-c77c5766-06.bin": {
      "mime": "application/octet-stream",
      "bytes": 4194304,
      "sha256": "23ee3abb18edbedc258eb484b156de15eb72ddc95081965c0b93c6819a06f89d"
    },
    "/asr/tiny-en-q5_1-c77c5766-07.bin": {
      "mime": "application/octet-stream",
      "bytes": 2806027,
      "sha256": "6bcf1b0548c0fa373cd6f690da1fa911130c68a03eff6a01c4c9c19e283aac32"
    },
    "/asr/NOTICE.txt": {
      "mime": "text/plain; charset=utf-8"
    }
  });

  // src/transcription-segments.ts
  function normalizeTranscriptionSegments(result, duration) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 1e4 || !result || typeof result !== "object" || Array.isArray(result)) throw Error("Invalid transcription result.");
    const raw = result.segments;
    if (!Array.isArray(raw) || raw.length > 64) throw Error("Invalid transcription result.");
    const segments = [];
    let omittedSegments = 0, adjustedSegments = 0;
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("Invalid transcription segment.");
      const { text, startMs, endMs } = item;
      if (typeof text !== "string" || text.length > 500 || typeof startMs !== "number" || typeof endMs !== "number" || !Number.isFinite(startMs) || !Number.isFinite(endMs)) throw Error("Invalid transcription segment.");
      const start = Math.max(0, startMs), end = Math.min(duration, endMs), trimmed = text.trim();
      if (!trimmed || endMs <= startMs || end <= start) {
        omittedSegments++;
        continue;
      }
      if (start !== startMs || end !== endMs) adjustedSegments++;
      segments.push({ text: trimmed, startMs: start, endMs: end });
    }
    return { segments, omittedSegments, adjustedSegments };
  }

  // src/transcription-worker.ts
  var scope = globalThis;
  var engine;
  var initializing = false;
  var processing = false;
  var errorText = (error) => error instanceof Error ? error.message.slice(0, 160) : "Local transcription failed.";
  var digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((n) => n.toString(16).padStart(2, "0")).join("");
  scope.onmessage = (event) => {
    void handle(event.data).catch((error) => scope.postMessage({ type: "error", message: errorText(error) }));
  };
  async function handle(message) {
    if (!message || typeof message !== "object") throw Error("Invalid transcription request.");
    const m = message;
    if (m.type === "init") {
      if (engine || initializing || !(m.model instanceof ArrayBuffer) || m.model.byteLength !== ASR_MODEL.bytes) throw Error("Invalid model initialization.");
      initializing = true;
      if (await digest(m.model) !== ASR_MODEL.sha256) throw Error("Local model integrity check failed.");
      scope.importScripts(ASR_RUNTIME.script);
      const candidate = await createSameEndAsr({ locateFile: () => ASR_RUNTIME.wasm, print: () => {
      }, printErr: () => {
      } });
      let pointer2 = 0;
      try {
        pointer2 = candidate._malloc(m.model.byteLength);
        if (!pointer2) throw Error("Not enough memory for local transcription.");
        candidate.HEAPU8.set(new Uint8Array(m.model), pointer2);
        if (candidate._asr_init(pointer2, m.model.byteLength) !== 0) throw Error(candidate.UTF8ToString(candidate._asr_error()));
      } catch (error) {
        candidate._asr_destroy();
        throw error;
      } finally {
        if (pointer2) candidate._free(pointer2);
      }
      engine = candidate;
      scope.postMessage({ type: "ready", memoryBytes: engine.HEAPU8.buffer.byteLength });
      return;
    }
    if (m.type !== "chunk" || !engine || processing || !Number.isSafeInteger(m.id) || !(m.pcm instanceof ArrayBuffer) || m.pcm.byteLength < 16e3 * 4 || m.pcm.byteLength > 16e4 * 4 || m.pcm.byteLength % 4) throw Error("Invalid audio window.");
    processing = true;
    let pointer = 0;
    const started = performance.now();
    try {
      const pcm = new Float32Array(m.pcm);
      for (const sample of pcm) if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw Error("Invalid audio sample.");
      pointer = engine._malloc(m.pcm.byteLength);
      if (!pointer) throw Error("Not enough memory for an audio window.");
      engine.HEAPF32.set(pcm, pointer >>> 2);
      if (engine._asr_transcribe(pointer, pcm.length) !== 0) throw Error(engine.UTF8ToString(engine._asr_error()));
      const raw = engine.UTF8ToString(engine._asr_result());
      if (raw.length > 32768) throw Error("Transcription result exceeded its limit.");
      const result = JSON.parse(raw), duration = pcm.length / 16;
      const { segments, omittedSegments, adjustedSegments } = normalizeTranscriptionSegments(result, duration);
      scope.postMessage({ type: "result", id: m.id, segments, omittedSegments, adjustedSegments, memoryBytes: engine.HEAPU8.buffer.byteLength, elapsedMs: performance.now() - started });
    } finally {
      if (pointer) engine._free(pointer);
      processing = false;
    }
  }
})();
