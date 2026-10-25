# Measured common start: gated implementation

This implementation can select one shorter **common** initial source delay for a
new standard HLS room. The source uses that delay too. The authenticated room
configuration keeps `delay:300`; source epoch, programme identity and signed media
timestamps are unchanged. The separate source-signed decision supplies the common
playback baseline.

The public build flag is **off by default**, pending the platform acceptance
matrix. The implementation and unit checks do not establish physical-device,
separate-network or full-match acceptance.

## Selection and the shared clock

`common-start.js` exposes `SameEndCommonStart.Policy`, `reportFromMeasurement`,
`validReport`, `canonicalDecision` and `validateDecision`. In `engine.js`,
`resetCommonStart`, `advanceCommonStart`, `handleCommonHello` and
`adoptCommonDecision` own the cast lifecycle and signature checks.

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

`build-pwa.mjs` enables the public runtime option only when
`SAMEEND_AUTOMATIC_COMMON_START=1`. Omission, or `=0`, leaves it off. When enabled,
only newly created standard HLS rooms configured for 300 seconds advertise
`commonStartVersion:1`. Existing rooms and the 10/60-second rehearsal settings do
not acquire this protocol in place. There is no ordinary room control that
silently enables it.

The local unit-suite snapshot recorded **414 tests passing, zero failing**. This
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
physical connection. The platform acceptance matrix is still pending at this
documentation checkpoint. Do not treat a passing unit suite, a test harness or an
individual local run as Android, iPhone, iPad, Windows, separate-network,
background-recovery, sound-output or full-match acceptance. Keep the public flag
off until the required platform evidence is reviewed.
