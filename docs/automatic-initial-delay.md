# Viewer-local initial delay acceptance

The automatic-start implementation is behind `SameEndConfig.automaticInitialDelay`.
The production switch remains off until required platform playback evidence passes.
It complements the observed-delivery estimator; it does not measure maximum ISP speed.

## Two timelines

The signed room configuration, source clock, programme identity, retention and
peer forwarding remain unchanged. A viewer may latch a shorter local playback
baseline once before its first picture. The existing adaptive player can then
retain additional local lag for smooth recovery. The source and another viewer
can remain on the signed room baseline.

`targetProgramTime` remains the signed room target. `viewerTargetProgramTime`
and `effectiveTargetProgramTime` describe local playback. `initialDelay`
records candidate and selected delays, reserve goal, one commitment and actual
source-to-playhead delay. Selected delay and actual delay differ by decoder
preparation/recovery time; reports must show that difference honestly.

## Admission

- HLS viewers only; no source/legacy clock rewrite.
- At least 20 seconds of fresh live observations; a 60-second analysis deadline.
- No fast historical catch-up, stale clock/route, invalid signature, or duplicate credit.
- Below-stream delivery combined with growing video age vetoes acceleration,
  including a sustained 0.95x path that is not caught by the diagnostic 0.9 threshold.
- A pinned preparation target is checked against contiguous verified HLS resources,
  including init and fragments, then actual aligned decoder headroom.
- Supported reserve goals are at most 12 seconds with the current manifest window.
  Larger recommendations retain the conservative room fallback; they are not clipped.
- Native HLS additionally needs three target durations ahead. Preparation is bounded
  to eight seconds, silent and unable to play from an early sound gesture.
- Commit once. Supplier changes and background recovery do not reselect or jump back
  to the room baseline. A new cast creates a new startup policy.

The existing five-minute fallback is retained if admission fails. No finite initial
buffer can sustain an indefinitely insufficient delivery path.

## Tests

`npm test` includes pure admission/decoder tests, signed-clock/forwarding integration,
and initial-only waiting-content behavior. `node tests/initial-delay-ui-browser.test.mjs`
checks presentation lifecycle separately from real media.

```
npm run build
INITIAL_DEVICE=chromium INITIAL_PROFILE=steady INITIAL_LABEL=local-steady npm run test:initial-delay
INITIAL_DEVICE=android ANDROID_CDP=http://127.0.0.1:18967 INITIAL_PROFILE=bursty INITIAL_LABEL=android-bursty npm run test:initial-delay
INITIAL_DEVICE=ios INITIAL_PROFILE=slow INITIAL_LABEL=iphone-slow npm run test:initial-delay
```

The owned harness uses a generated signed HLS source, real WebRTC, secure local
signalling and encrypted chat. Application receive queues pace actual received
media for steady, sustainable slow, bursty and sustained-deficit profiles. This
is controlled delivery simulation, not a physical Wi-Fi/5G capacity measurement.
Positive cases require at least 120 seconds of real decoded moving frames and
changing audio chirps (native iOS output needs a separate scoped capture). Deficit
cases stop before the real five-minute fallback; they establish admission refusal,
not endless playback. No family stream, VPN or commercial source is used.

The iOS external mode prints its own ephemeral simulator certificate and viewer
URL. Trust only that test certificate in the selected test simulator before opening
it; use a real sound gesture. Android CDP must name an isolated emulator, not a
personal phone. Chrome/Edge tests use fresh owned profiles with speaker output muted.

The full buffer explanation is shown only until the first picture. Local buffer
rebuilding on return from an inactive tab does not cover the picture with startup
content. Source/network failures retain their explanations. Synthetic lifecycle
checks are recorded separately from real OS background acceptance.

## Group timing revision

The first experimental tests allowed a short local baseline while the source
remained five minutes behind. Although media was smooth, that did not satisfy
watching together. Those results remain prototype evidence only.

The release gate now requires every selected delay to be at least the configured
common room baseline. Initial selection plus later adaptive lag must fit a total
60-second extra budget. The five-minute default is retained; accelerated tests may
explicitly use the existing one-minute room setting. A complete real five-minute
warm-up is tested separately. Initial decoder reserve can vary with delivery
without letting fast viewers jump ahead of the host.
