# Viewer-local startup and measured common-start integration

Automatic startup is enabled by default through `SameEndConfig.automaticInitialDelay`
after the controlled platform acceptance matrix. Build with
`SAMEEND_AUTOMATIC_INITIAL_DELAY=0` to disable it without changing room settings.
It complements the observed-delivery estimator; it does not measure maximum ISP speed.

This viewer-local admission policy is distinct from the newer
[measured common-start policy](measured-common-start.md), which lets the source
select a shorter baseline for everyone, including itself. That separate public
flag, `SAMEEND_AUTOMATIC_COMMON_START`, remains **off by default pending platform
acceptance**. Its 30–120-second common start is not enabled by the acceptance
results recorded for viewer-local startup below.

## Two timelines

Viewer-local admission does not rewrite room configuration, source clock,
programme identity, retention or peer forwarding. It may prepare one starting
position on or behind the established common baseline before first picture. The
existing adaptive player can then retain additional local lag for smooth recovery.
The source and other viewers can remain on that common baseline.

In ordinary rooms the common baseline is the configured delay. In a new room
using the gated common-start protocol it is the source-signed decision's delay;
the original configuration still retains 300 seconds for fallback and history.
The host uses the decision too, so 300 seconds is not a universal minimum when
that separate protocol is enabled.

`targetProgramTime`, `sharedTargetProgramTime` and `viewerTargetProgramTime` expose
the current common nominal target. `signedTargetProgramTime` retains the target
derived from the original configuration. `effectiveTargetProgramTime` describes
the bounded local playback target. `initialDelay`
records candidate and selected delays, reserve goal, one commitment and actual
source-to-playhead delay. Selected delay and actual delay differ by decoder
preparation/recovery time; reports must show that difference honestly.

## Admission

- HLS viewers only; viewer admission cannot choose a different common source clock.
- Ordinary local selection requires at least 20 seconds of fresh live observations;
  its 60-second analysis deadline starts once the shared start is due. The separate
  common-start selection deadline is 60 seconds from capture epoch.
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

If local admission fails, playback retains the established common baseline. That
is five minutes in current public default rooms; it can be shorter after a valid
source-signed common decision in an enabled test/review build. No finite initial
buffer can sustain an indefinitely insufficient delivery path.

## Joining an already decided common timeline

For a supporting viewer joining a shortened common room after its start, the
source has already chosen the baseline. `prepareLateCommonJoin` waits until the
source clock is known; it does not pin a target from an unconfirmed local clock.
If the shared nominal target is more than one second into the programme, it
discards the unplayed decoder and calls `Policy.prepareCommonJoin` with the
**current** shared target, selected reserve and captured source-clock value.

This path selects no new delay and credits no historical catch-up as live
bandwidth evidence. Preparation is silent and one-time. It requires a healthy
route and verified media received within 12 seconds, followed by contiguous
verified cache, an aligned ready decoder and sufficient decoded headroom at that
current target. It does not wait for a new 20-second live-delivery classification.
An already observed sustained deficit still vetoes admission. The eight-second
preparation timeout, native minimum reserve, and total 60-second local-lag bound
remain in force. Earlier viewers still use normal local admission.

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
changing audio chirps (native iOS output needs a separate scoped capture). The 95-second deficit cases use the one-minute test room and establish
admission refusal; some conservative fallback playback is observed separately,
without claiming endless playback. No family stream, VPN or commercial source is used.

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

Every viewer-local selected delay must be at least the **established common
baseline**, with initial selection and later adaptive lag sharing a total
60-second extra budget. Without a common-start decision this is the configured
baseline, including the five-minute public default. With a valid shorter decision
it is that source-selected baseline, which the host follows too. The separate
one-minute rehearsal and full five-minute warm-up remain useful tests of their
configured modes; neither establishes acceptance of the new common-start path.

Ordinary automatic admission applies to HLS rooms with a configured baseline of
at least 60 seconds. Supporting common-start rooms also admit against their
accepted shorter baseline. The hidden ten-second developer rehearsal retains its existing startup.
The generic Apple gesture project is in `tests/ios-lab`; device identifiers, output
paths, certificates, private room links and captured audio are not committed.

## Acceptance result and boundaries

The results below cover viewer-local startup and its established-baseline modes.
They do not establish acceptance of the separately gated source-selected common
start or its new late-join admission path.

Controlled Android16/Chrome133 emulator, iOS27 iPhone16 and iPad A16 simulators
(default MSE and forced native HLS), and real MSI Windows11 Chrome155/Edge156
runs exercised actual moving picture, changing audio and encrypted chat. Positive
traces ran at least120 seconds after starting; Android and native iPad also used
actual five-minute warm-ups. Steady,1.25x sustainable slow, bursty and0.95x/0.65x
sustained-deficit delivery are distinct scenarios. Stable-window media/wall speed
is checked, not just decoded-frame counts. The fully prefetched WebKit185-second
regression passes with no stalls or repeated seeking when run without concurrent
encoders. Its MSE analyser limitation is not audio-output proof; Apple sound is
instead verified with scoped simulator-process captures and intentional quiet cuts.

On the MSI test browser, routing media output through the test WebAudio analyser
slowed the media clock. A separate capture-stream tee preserves the element output
and measured near-normal media speed while that analyser's clock remained slow.
Use `INITIAL_AUDIO_TEE=1` for Windows acceptance; `=0` retains the old probe for
comparison. This changes test instrumentation, not the production audio route.

Native long-warm-up frame measurement is armed at loaded/playing boundaries.
Failed and superseded tests remain separate from accepted runs. No simulation
establishes physical iPad/iPhone speakers, older iPadOS versions, separate mobile
networks, background OS suspension or a full match. Those remain device acceptance.

The new common-start protocol requires a supporting viewer and enough measured
feedback before its 60-second capture deadline; a host starting alone retains
the five-minute fallback. Old sessions never retime in place. After a reviewed
release enables the feature, update the app and start a fresh share. Saved club
and combined room invitations remain reusable across that restart; video-only
magnets still identify one capture.
