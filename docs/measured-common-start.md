# Measured common start

This implementation can select one shorter **common** initial source delay for a
new standard HLS room. The source uses that delay too. The authenticated room
configuration keeps `delay:300`; source epoch, programme identity and signed media
timestamps are unchanged. The separate source-signed decision supplies the common
playback baseline.

The public build flag is **on by default** after the controlled platform
acceptance matrix below. Build with `SAMEEND_AUTOMATIC_COMMON_START=0` for the
conservative configured-delay mode. These controlled tests do not establish
physical Apple-device, separate-network or full-match acceptance.

## Selection and the shared clock

`common-start.js` exposes `SameEndCommonStart.Policy`, `reportFromMeasurement`,
`validReport`, `canonicalDecision` and `validateDecision`. In `engine.js`,
`resetCommonStart`, `advanceCommonStart`, `handleCommonHello` and
`adoptCommonDecision` own the cast lifecycle and signature checks;
`prepareLateCommonJoin` connects an established decision to viewer admission.

Before first playback, the source collects its own verified source/capture
observations and bounded reports of viewers' verified incoming delivery. A shorter
start requires at least one connected viewer, every collected participant report
to be eligible, and the host's real decoder to be prepared. Source observations
describe the local production pipeline; they are not evidence of viewer network
delivery.

Eligible measurements require at least 20 seconds of fresh observations and route
age, six records, live rather than historical-catch-up classification, known
bounded delivery metrics, and fresh advancing progress. Suspended, offline,
unclocked, absent, stale or recently reset routes cannot authorize shortening.
Report transport time adds to the reported age of the last verified progress;
forwarding preserves the original report timestamp. The report envelope expires
after 12 seconds, with a stricter arrival-cadence freshness gate where applicable.

A young growing backlog can remain too uncertain to permit acceleration before
there is enough evidence to diagnose a sustained deficit. With an observed
delivery-to-stream ratio below 0.99 and positive media-age trend, accumulated age
growth above `0.25 + 2 × gap standard deviation` makes a report ineligible for
acceleration. It waits for more evidence; it does not immediately declare a
sustained fault. The stronger existing deficit veto remains unchanged. Flat-age
near-stream quantization and sufficiently noisy sustainable bursts can remain
eligible. These thresholds are conservative admission heuristics, not guarantees
of future throughput.

The policy takes the maximum eligible host/viewer candidate and computes:

```text
D = round upward to an even number of seconds(
      max(30, source elapsed seconds + 4, largest eligible candidate))
```

An accelerated common delay must be between 30 and 120 seconds. A candidate above
the supported ceiling causes fallback; it is not clipped. Thus observations can
choose, for example, 54 seconds instead of 30. This is a bounded heuristic, not a
claim to find the optimum delay.

The required decoder reserve is the rounded-up maximum of the participant reserve
goals and the host decoder's minimum. Supported reserve is 4–12 seconds. The host
must have aligned, ready media with sufficient contiguous verified cache **and**
actual decoder headroom. Its preparation target is the first retained signed
programme timestamp, which may be slightly after zero. This avoids inventing a
sample at programme zero or rewriting signed timestamps. A native requirement
above 12 seconds cannot authorize acceleration.

Only the source signs a decision. It contains the cast, source ID and epoch,
programme ID, version, decision number one, selected delay and reserve, issue time,
`startsAt = config.epoch + D * 1000`, and a bounded reason. The canonical tuple is
signed with the cast's ECDSA P-256 private key. Before adoption, a receiver checks
the structure, identities, timing bounds and source signature against the public
key from its invitation. It rechecks cast and peer identity after asynchronous
work. Duplicate decisions are inert; a different signed decision is a conflict,
not permission to retime playback. A shorter decision arriving after first
playback is not adopted.

The host and supporting viewers calculate the same nominal programme time:

```text
(source clock now - config.epoch) / 1000 - selected D
```

The minimum announcement lead is four seconds when selecting. If source signing
finishes with fewer than two seconds remaining before the proposed start, the
engine signs a 300-second fallback instead of announcing that shortened start.
The selected baseline is retained through supplier changes and decoder recovery.
It is not reconsidered when another viewer joins.

## Deadline and conservative fallback

The observation deadline is 60 source-clock seconds from the cast epoch. At the
first policy update on or after that deadline, missing evidence or readiness
produces a signed 300-second fallback. This is a policy deadline, not a guarantee
that a suspended browser executes a timer on time. An unsupported early peer or
observed sustained delivery deficit can select fallback sooner.

**If no viewer joins with enough useful evidence before the deadline, the source
retains the five-minute start.** A viewer arriving later cannot shorten it. This
is a current limitation, particularly when the host starts capture before sending
invitations.

Missing reports, unknown measurements, excessive aggregation, unsupported reserve
or incomplete decoder preparation cannot count as good evidence. Near-stream
delivery accompanied by growing media age is vetoed once growth exceeds the
arrival-variance allowance. The estimator's explicit sustained-deficit result
also vetoes acceleration. More delay cannot sustain an indefinitely insufficient
delivery path.

The original 300-second configuration continues to govern retention, with the
existing recovery/history allowances. The existing 192 MiB cache ceiling still
wins; retained history is not guaranteed under memory pressure.

## Peer protocol and old application versions

Feedback and decisions use optional fields in the existing `hello` control
message: `commonStartVersion`, `commonStartNodeId`, `commonStartFeedback`,
`commonStartUnsupported` and `commonStartDecision`. There is no new control type
that an older application would reject. Hellos repeat during the cast and carry
the latched decision to later children and replacement suppliers.

Reports travel up the peer tree; the source-signed decision travels down it. Each
feedback envelope has at most eight deduplicated rows. Missing reports remain
visible, and aggregation overflow propagates an unsupported indication instead
of silently excluding participants.

An old application connected before selection vetoes acceleration and preserves
the common 300-second start. An old application joining after a shorter decision
receives the retained 300-second history, within cache limits, but follows its
original timeline. **It is outside the shortened common-timing protocol and can
be several minutes behind the host.** This compatibility distinction concerns
the application/protocol version, not the device's operating-system version.

Supporting late or slow viewers inherit the established common decision. The
existing adaptive player may add up to 60 seconds of local lag for smoother
startup and recovery; startup and later recovery share that bound. A late
viewer cannot delay the host or select a different common baseline. Chat remains
immediate. Finite reserve cannot guarantee playback on a persistently inadequate
route.

For a common decision received before first picture, the engine first waits
for a confirmed source clock and actual retained signed media at the current
shared target. `prepareLateCommonJoin` then discards the unplayed
decoder and calls `initial-delay.js`'s `Policy.prepareCommonJoin` once, using that
**current** shared target and the established reserve. It does not reuse an old
programme-zero decoder or wait for catch-up delivery to become a 20-second live
measurement. Healthy route state and verified media received within 12 seconds
keep preparation eligible; actual contiguous verified cache, aligned decoder
position and decoded headroom still gate playback. An observed sustained deficit,
the eight-second preparation timeout, native reserve requirements and the total
60-second extra-lag limit still apply. No new common delay is selected.

## Measurement, trust and privacy

The delivery estimator compares actual advancing, signature-verified payload
goodput with the source payload bitrate and tracks source age, arrival gaps,
verified reserve and decoder headroom separately. Source-paced goodput does not
establish spare capacity. This is not a maximum ISP-speed test or an ISP-fault
diagnosis.

Reports are bounded, untrusted claims about receiver observations. Their shape,
age, numeric ranges and derived eligibility/blocking flags are checked. They do
not prove that a remote device verified, decoded or audibly played the media.
The source signature authenticates the decision's origin, not the truth of every
report used to choose it. A viewer's arbitrary suggested timestamp is never
directly installed as the room clock.

The new feedback contains session node IDs and bounded metrics, not chat, names,
invitation URLs, network addresses or raw per-piece arrays. Reports and decisions
are held in cast memory and forwarded over the existing encrypted peer control
path. The source private signing key stays at the source. The invitation and
descriptor remain the trust bootstrap; a decision signature does not identify a
person or make an invitation public-safe. This feature adds no cloud media relay,
speed-test service or public telemetry upload. Existing discovery services retain
their existing metadata visibility.

Local snapshots expose `commonStart`, its selected/fallback delay, reason and
decision identity, alongside the original configured fallback and playback
measurements. Shared diagnostic state uses the bounded `safeCommonStart`
sanitizer; it does not include the raw decision, signature or feedback rows.

## Controls and verification status

`build-pwa.mjs` enables the public runtime option by default. Build with
`SAMEEND_AUTOMATIC_COMMON_START=0` to disable it. When enabled,
only newly created standard HLS rooms configured for 300 seconds advertise
`commonStartVersion:1`. Existing rooms and the 10/60-second rehearsal settings do
not acquire this protocol in place. There is no ordinary room control that
silently enables it.

Update the app and start a fresh share; an existing capture never retimes in place. The saved club and combined
room invitations remain the same across sharing restarts. Raw video-only magnets
remain specific to the capture they identify. At least one supporting viewer
must join and contribute enough fresh measured feedback before the new capture's
60-second deadline; otherwise that capture retains its 300-second fallback.

The local unit-suite snapshot recorded **442 tests passing, zero failing**. This
covers the broader application and includes the common-start policy and actual
engine-slice integration checks. Focused checks include real ECDSA tampering,
one-time adoption, source/viewer shared targets, stale asynchronous work,
verification recovery, feedback overflow, host decoder minimums, nonzero first
signed timestamps, late decision retransmission, legacy forwarding and the
60-second local lag bound.

```sh
npm test
node --test tests/common-start.test.mjs tests/common-start-engine.test.mjs
npm run build
node tests/common-start-ui-browser.test.mjs
npm run test:common-start
```

The UI test covers synthetic presentation lifecycle only. The common-start
platform harness enables the feature inside its isolated test pages, uses real
signed HLS over WebRTC, and can pace application receive callbacks for steady,
slow, bursty and below-stream scenarios. That pacing is not a measurement of a
physical connection. The acceptance result below records the completed platform evidence. A passing
unit suite alone does not establish separate-network, background-recovery,
physical-device sound output or full-match acceptance.

### Late join and early uncertainty corrections

A source-verified selected clock is already authoritative for a later joiner.
Historical catch-up cannot establish spare bandwidth, but verified current HLS
resources can prepare that existing timeline. After the source clock is known,
an unplayed decoder is recreated and silently primed at the current common target.
Fresh verified-media progress, actual aligned decoder headroom, the eight-second
preparation limit and total60-second extra bound remain mandatory. This avoids
waiting for historical catch-up to fall out of the measurement window and then
starting stale programme-zero media.

A small growing delivery backlog also withholds permission to accelerate before
the stronger sustained-deficit threshold is crossed. This is uncertainty, not a
claim that a twenty-second observation proves maximum link capacity. Healthy
flat-age and noisy sustainable-burst observations retain separate regression checks.


## Acceptance result

Controlled tests selected a **30–50-second common baseline**, including the host,
with at least 120 seconds of overlapping moving picture for host, viewer and a
later viewer in each healthy case. Encrypted chat was checked during startup,
playback and late joining. The selected common baseline remained immutable;
healthy maximum measured group gaps stayed below ten seconds. Application receive
queues paced real received signed HLS over actual WebRTC; they simulated steady,
1.25x sustainable slow, and bursty delivery rather than measuring physical access
link capacity.

| Platform | Completed common-start cases | Sound evidence |
| --- | --- | --- |
| Android 16 / Chrome 133 emulator | Steady, slow, bursty; independently bursty late join | Changing decoded chirps measured on all three roles |
| iPhone 16 / iOS 27 simulator | Default MSE steady; native HLS bursty | Scoped generated-audio captures: 63.27 s default, 125.82 s native; intentional page-mute cuts verified |
| iPad A16 / iPadOS 27 simulator | Native HLS slow; default MSE bursty on final rebased build | Scoped generated-audio captures: 127.53 s native, 127.89 s default; intentional page-mute cuts verified |
| MSI Windows 11 / Chrome 155 and Edge 156 | Steady, slow, bursty; actual 300-second fallback followed by 120 s playback | Changing decoded chirps measured through a capture-stream tee, without rerouting the production element |

The iOS process captures explicitly scoped the owned simulator's generated test
output, without microphone or system-mix capture. Capture PCM durations above
120 seconds reflect the observed capture clock; they do not turn a 63-second
sample into 120-second sound proof. Windows and Android analyser evidence proves
decoded signal, not physical loudspeaker output.

Separate 95-second 0.95x and 0.65x sustained-deficit tests refused acceleration,
retained the signed 300-second fallback and kept chat working. They do not claim
endless playback on a path whose delivery stays below source bitrate. The full
Windows fallback case verifies real playback after the complete five-minute wait.

Earlier prototype runs that left late viewers about 56 seconds behind, native
first-frame jumps and an ended test-audio tee are retained as failed/superseded
evidence, not included in acceptance. Pending native viewers now retain a
negative warm-up playback window until the shared clock is due. The native player
also waits for contiguous verified reserve sufficient for its existing standard
precise-start playlist hint before first attachment. This avoids long-paused early
AVPlayer attachment; it does not rewrite signed timestamps or add another format.

Older physical iPads/iPhones, other OS versions, real mobile networks, OS-level
background suspension and a full match remain separate device acceptance. The
native HLS start hint follows [RFC 8216 section 4.3.5.2](https://datatracker.ietf.org/doc/html/rfc8216#section-4.3.5.2).
