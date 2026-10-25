# Client delivery observations and trial starting delay

This release measures each viewer's verified video delivery and compares it with
the source payload bitrate, actual reserve and decoder headroom. It records an
experimental starting-delay recommendation without applying it. The configured
10/60/300-second room delay, adaptive player, supplier selection and fan-out do
not change.

## What is measured

- **Payload bitrate:** advancing, source-verified bytes divided by their signed
  programme duration. This includes HLS bundle/container bytes, not network headers.
- **Wall-time goodput:** verified advancing payload after the first observation,
  divided by elapsed local time. At least four pieces and eight seconds are needed.
- **Active transfer observation:** payload over locally timed receive-to-verification
  intervals. Overlapping intervals are merged. This includes local work and is not
  maximum line speed.
- **Reserve:** contiguous verified seconds from the effective play point, separate
  from decoder headroom. Before that play point is due during warm-up, reserve is
  unknown, even though signed video is accumulating in memory.
- **Baseline reserve fraction:** reserve divided by the configured room delay,
  capped at one. This differs from coverage of the smaller trial reserve target.
- **Gaps and trends:** mean, standard deviation and 95th-percentile arrival gaps;
  source-to-verification age; and reserve change while playing.

Only the active supplying peer contributes, after signature/identity validation
and deduplication. Old-source, replayed, invalid, duplicate and out-of-order old
pieces cannot inflate fresh progress. Valid older media can still repair a cache
gap. Route changes reset measurement windows while retaining replay high-water
marks; a new cast creates a new estimator. No peer identifiers enter its output.

Observed source-paced goodput often equals the stream bitrate because no more
data was offered. That does not establish spare bandwidth. The WebRTC stats
specification distinguishes data-channel payload counters from congestion-based
RTP bandwidth estimates; those estimates do not supply a dependable maximum
speed for this file-over-data-channel design. No speed-test service, extra media
probe or cloud video relay is introduced. See the [W3C stats specification](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatepairstats-availableincomingbitrate).

## Experimental algorithm

1. Collect a bounded rolling minute: at most 128 piece records and 64 samples.
2. Wait for at least 20 seconds, six fresh age observations and a healthy visible,
   online, clock-confirmed route before producing a candidate.
3. Separate fast historical catch-up from live delivery. Falling old ages with
   media progression above 1.2 programme seconds per wall second are catch-up;
   they cannot establish a shorter starting delay.
4. Trial reserve is `max(6, 2 × p95 piece duration, p95 arrival gap + 2 × gap standard deviation)`,
   limited to 60 seconds. This is a heuristic, not a measured optimum.
5. Trial initial delay is the conservative current/observed source age plus that
   reserve, rounded up. Only candidates within 6–420 seconds are reported. Old
   history, unknown ages, stale progress and excessive observed delay suppress it.
6. Below-stream goodput plus falling reserve or growing source age is a delivery
   deficit. Report no finite delay solution; more delay cannot sustain an
   indefinitely insufficient delivery path. This does not diagnose the ISP as
   the cause.

The result always declares `capacityKnown:false`, `applied:false` and
`validated:false`. Hidden/offline/clock-unconfirmed/unreachable-source periods
clear useful measurement evidence. Quiet source periods revoke a fresh candidate
rather than becoming proof of a client bandwidth fault.

## Finding and sharing the data

Room settings & help contains a collapsed **Connection & buffer measurements**
panel. Private device reports and downloaded local test logs include bounded
measurements and the trial recommendation. Reports are re-sanitised on receipt;
names, chat, invitations, addresses, raw errors and per-piece arrays are excluded.
The organiser's Help inbox displays received rate, stream need, reserve and trial
status. Nothing is automatically uploaded as a new public analytics database.

## Validation

```sh
npm run build
npm test
node tests/client-delivery-ui-browser.test.mjs
npm run test:diagnostics
npm run test:report-help
npm run test:client-delivery
```

The delivery scenario uses actual 300-second warm-up, browser-generated signed
HLS, real WebRTC, a local secure tracker and encrypted chat. Owned receive queues
pace application delivery for steady, bursty, near-stream and below-stream tests.
Those are controlled application bottlenecks, not measurements of physical Wi-Fi,
5G or broadband. CPU, source pacing and verification are included in observations.
Physical devices, separate networks, and an optimal initial-delay policy still
need independent evidence before recommendations control playback.
