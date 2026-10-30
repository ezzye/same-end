# Resilient delivery: opt-in build and current evidence

This note describes the resilience implementation. The Pages deployment builds version 3 with `npm run build:resilience`; an ordinary local build still uses version 2. Physical-device reports and bounded generated tests do not establish separate-home, sustained real-match or full-match acceptance.

## Build gate and compatibility

The ordinary `npm run build` keeps the existing media version 2 source path. Version 3 is enabled only for a review/test build by either:

```sh
npm run build:resilience
# or
SAMEEND_RESILIENT_DELIVERY=1 npm run build
```

These gates select version 3 for newly started shares; they do not deploy the build. Updated clients can still read existing version 1 and 2 invitations. An older deployed client must refresh to an updated bundle before it can read a version 3 share. Existing rooms do not change version in place.

## Independent media and source quality choices

New version 3 shares use separate CMAF/HLS renditions on a shared programme timeline. The UI offers two source-quality choices:

- **Lower data:** encodes only the independent audio stream and 360p picture.
- **Standard picture:** encodes independent audio plus 360p and 480p picture, so the viewer policy can select between both video renditions.

| Rendition | Target encoder rate | Content |
| --- | ---: | --- |
| `audio` | 64 kbit/s | AAC commentary/audio only |
| `v360` | 400 kbit/s | 640×360 H.264 video only |
| `v480` | 700 kbit/s | 854×480 H.264 video only |

These are encoder targets, not measured delivery rates or guaranteed quality. They exclude container, playlist, envelope, signature, WebRTC and network overhead. A viewer normally requests audio plus one picture rendition; while probing it can request another picture rendition. Phones/tablets are leaf viewers: they do not host or relay and their maximum picture rendition is capped at 360p. The source runs separate encoders for the selected renditions concurrently; CPU, thermal and battery cost has not been measured on a production host. Playback aligns independent audio and video to the shared programme clock; no receiver needs to unpack sound from a video stream.

A video rendition encoder error marks that rendition unavailable and allows policy to continue with the remaining rendition(s), including audio when healthy. An audio-clock encoder failure stops the share. The sender pacer prioritizes bounded audio pieces while valid video bundles wait for available pacing credit. A valid video bundle may borrow against a full token bucket once; its entire debt is retained so later bundles wait for that debt to recover. Each bundle remains capped at 4 MiB. These controls bound application queues and pacing; they are not a measured network capacity guarantee.

## Adaptive policy and actual playhead

Each viewer tracks verified media reserve and media age per rendition. The policy allows a 12-second startup grace. A sustained deficit is recognized after six seconds when reserve falls below two seconds or media age exceeds eight seconds. It can step down from 480p to 360p, then to audio, when those renditions are available. Switching enters a 30-second cooldown. Upgrade requires healthy evidence: reserve of at least six seconds and media age no greater than five seconds. Audio-to-360p waits 20 seconds of stability; 360p-to-480p waits 60 seconds. Upgrade probes are bounded to 20 seconds and need at least two fresh verified video pieces plus usable reserve/age before becoming active. A failed probe returns to cooldown.

Fresh transfer evidence is timed against the current clock, while video-piece position is compared with the viewer's actual playhead. That distinction matters for a 300-second shared delay: media near the playhead remains relevant even though it is several minutes behind capture. Probe success still requires new transfers after the probe begins, verified video near that playhead, and the reserve/age conditions; delayed playback does not turn old cache alone into a successful probe.

The transport requests bounded, clock-relevant cache ranges per rendition rather than replaying a large backlog. The room coordinator receives requested renditions, the needed media interval, and at most 12 reported cached ranges. It can recommend peers whose fresh report says they cover the requested interval, are rooted in the source path, and have a declared forwarding slot. These are scheduling hints; only an authenticated direct peer connection and signature-verified media establish delivery.

A phone/tablet viewer can watch and chat but does not host capture or forward media. The source has two declared downstream slots. In version 3, desktop viewers have at most one forwarding slot in both the local magnet transport and coordinator recommendations. These limits bound the protocol; they are not proof that a machine's CPU or uplink can sustain those rates.

The recovery path retries supplier discovery while retaining verified cache and the shared room clock. It does not promise zero outage. Make-before-break media handover—establishing and verifying replacement media before removing the current supplier—is not implemented, so a handover can pause. No amount of local buffer can bridge loss of future source content indefinitely.

The connection report labels independent audio and video playback facts under `mediaDiagnostics.playback.audio` and `.video`. Each buffer total sums retained decoder ranges, including ranges behind the playhead; `playableAheadSeconds` counts only the range containing that renderer's current time. Legacy top-level playback fields remain for compatibility and mostly describe the audio clock, while picture dimensions and frame counts describe video. A zero verified reserve measures contiguous verified media at the requested target, not total cached bytes.

`extraDelaySeconds` describes actual playhead lag behind the nominal room target. During a long outage it can exceed 60 seconds while playback waits for recoverable media. The requested recovery target is bounded to 60 seconds behind the nominal target; the actual playhead cannot reach that bound until suitable verified and decoder-ready media is available. The reported actual lag is therefore not capped to 60 seconds.

## Diagnosing a fourth viewer

**Connection help & report → Save report** includes current `joining.serving` and `joining.sending` facts even when a test recording was not started. Serving reports this device's effective forwarding limit, child count, available declared slots, leaf/root/clock status, recent source age, queue bytes and cached rendition names. It omits peer identities and cache programme positions. Sending reports measured acknowledged payload Mbps, child count and congested-child count. Unknown measurements remain null; zero remains a valid measured rate. Neither field measures internet uplink capacity or network overhead.

The generated four-peer check runs after `npm run build:resilience`:

```sh
npm run test:four-peers
```

It fills the source's two slots with a desktop helper and a phone leaf, then permits a new viewer to discover only the helper. It also checks a later join after the helper selects 480p and stops receiving 360p. Acceptance requires signed media and a decoded picture through that helper while both source slots remain occupied. Discovery is deliberately controlled; this does not establish public-tracker introductions, Windows-to-Mac ICE, physical-device behavior, TURN or mobile handover.

## Metadata coordinator and optional edge TURN

The room coordinator is separate from the WebTorrent tracker and carries no video or audio. It stores bounded, expiring metadata keyed by cast: a participant's role, clock/source reachability, parent/child topology, requested renditions, needed media interval, cached time ranges, queue size, optional outgoing-rate report, and declared relay limit. Reports and reservations live for 15 seconds. The coordinator client reports about every four seconds and renews its short lease; reservations expire with either participant's lease. At most 64 live nodes and five recommendations are retained for a cast.

Outgoing delivery rate measures recently acknowledged payload, not spare capacity. A measured zero can describe an idle supplier and does not by itself disqualify a free declared slot; source freshness, queue backlog, cache coverage, rooting and slot checks still apply. Outgoing delivery rate can be unknown. In that case, a source can be considered using its operator-declared slot, while a peer recommendation is labelled provisional. The coordinator does not treat an unknown value as measured capacity. Recommendation score, cache overlap, a declared slot or a fresh report does not prove internet uplink, sustained performance, successful ICE negotiation or useful delivery. The direct authenticated connection remains authoritative.

The optional `/v1/clubs/:id/ice` path can return short-lived TURN REST credentials only when edge TURN URLs/secrets are configured and the latest signed edge-health state is fresh and admissible. The backend uses 60-second credentials. Without a healthy report, it returns no TURN credentials and the client continues with direct STUN/tracker discovery. If configured, TURN media traverses only the operator-designated edge coturn host. No machine has been chosen; no coturn service, DNS record, certificate, firewall rule or host-agent service is installed. The control cloud does not relay media. See [edge TURN preparation](edge-turn.md).

## Verification and rollout state

There are 545 passing automated checks. The separate backend suite passes 126 checks, overlapping the combined total. Focused Chromium media checks cover separate tracks, silent-clock truth, selected-picture startup readiness, and continued audio/frame progression after commitment. Three isolated browser contexts passed automatic audio-only fallback, verified video return, a healthy second viewer, and a 20-second coordinator outage beyond the metadata TTL. No HTTP media was delivered. The normal 300-second automatic room setting also passed; its source selected a 30-second common start. A deterministic policy test separately covers a playback target 300 seconds behind capture. This does not establish physical five-minute-buffer recovery.

Normal and resilience builds compile. No deployment has been performed. No edge machine has been chosen, and there has been no production coturn allocation, measured access-link capacity, separate-home acceptance, native Safari device acceptance or full-match acceptance. The edge-agent self-test and safe dry-run pass; unavailable capacity readings on this Mac correctly return unknown and deny new admission. The 64-node schema bound is not validated room capacity. Existing cloud request ceilings remain unchanged.

## 29 October continuation checkpoint

The metadata backend was updated successfully in the existing AWS stack, preserving deployed notification keys and existing settings. The frontend changes remain in PR #50. Default new resilient captures now use audio plus 360p; Standard picture can add 480p. A full real-time fixed 300-second local P2P run passed audio fallback, video return and the healthy-second-viewer check. Source and recovered playout were about 300.1 seconds behind capture. Late joins are limited to a 20-second forward window with independent audio/video pacing, preventing audio history from starving video.

Local WebKit separate-native testing measured A/V alignment and preserved its local-only media bridge, but native audible PCM remains unmeasurable in that harness and real Safari acceptance is outstanding. The older single-stream native harness still fails its clock-drift assertion; broad native acceptance is not claimed.

The user selected this Mac as host and edge TURN machine. A private coturn 4.18 runtime was built with Prometheus and an OpenSSL ABI matching Homebrew libevent. Certificate-verified local TLS and an external, temporary control-plane probe passed UDP/TLS authentication plus 64 bytes of bidirectional relay diagnostics. No programme media traversed the cloud probe. Mac capacity sampling works. Persistent host supervision, automatic certificate renewal, full router mapping verification and the live frontend release remain unfinished. The test relay is being stopped and cloud TURN URLs disabled at this budget checkpoint. Installed binaries and protected configuration are retained privately; no credentials or home addresses are committed.
