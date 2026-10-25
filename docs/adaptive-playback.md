# Adaptive playback delay

HLS rooms favour a continuous picture over exact alignment between viewers. The
source epoch and normal five-minute delay remain the nominal room reference.
Every viewer plays from verified media and its decoder buffer, not directly from
the next arriving packet. Chat remains immediate.

The HLS playlists, CMAF media, H.264/AAC codecs and signed transport format are
unchanged. This is a local playout and delivery policy, not a replacement video
format or a new HLS/DASH protocol.

## Policy

| State | Behaviour |
| --- | --- |
| Warm-up | Never play before the chosen baseline delay, including after an early sound tap. |
| Starting | Require four contiguous seconds in both the verified cache and decoder. |
| Playing | Use the actual decoder playhead at normal speed. A low buffer alone does not pause a working player. |
| Rebuffering | After real starvation, pause for six contiguous seconds; repeated starvation raises the goal to eight, then ten. |
| Repair | Keep the old playhead for one rebuffer interval so a late fragment can repair it before a gap seek. |
| Recovering | If history expired or a gap remains, choose a useful available window within 60 seconds of extra delay. |
| Suspended | Pause locally when hidden; reassess retained media on return. Operating-system suspension still limits execution. |

No fractional playback-rate correction is used. The hls.js automatic live-edge
seek is disabled so it cannot compete with this policy or replay an earlier
fragment after starvation. Native HLS can initially choose its own point; the
controller still performs the necessary bounded initial positioning.

When a long outage expires the old decoder window, MSE recovery first loads
actual target samples before writing a new playhead position. Otherwise browsers
can clamp a seek to the old media duration and leave it pending indefinitely.
Mapped metadata time is available internally for this recovery even when no
frame is ready; it is not reported as proof of decoded playback. Stale pending
seeks can be retargeted after an eight-second cooldown.

## Delivery and storage

The engine stages media at the effective local target. Updated viewers announce
a bounded `playbackLagSeconds` hint to their supplier in the existing `hello`.
Suppliers can replay the newly needed earlier interval without resetting the
live transmission cursor. Old peers can ignore the additive field, but mixed
versions cannot guarantee the full adaptive historical replay behaviour.

Signed HLS history gains 60 seconds beyond the baseline delay and 30-second
safety window. The 192 MiB engine limit and 32 MiB player limit remain. These
limits can reduce available history at high bitrates. No persistent disk store,
new codec, cloud video relay or relay-admission experiment is included.

The player exposes nominal time, effective demand, actual playhead, contiguous
verified reserve, decoder headroom, adaptive phase, extra delay, and rebuffer and
adaptive-seek counts. Host reports retain only bounded allowlisted values.
Intentional buffering has a neutral waiting message rather than a generic
connection failure. Source absence and real decoder/browser errors remain
separate. Once playing, extra delay of at least ten seconds appears discreetly
beside the room delay, rounded down to five-second steps.

## Limits

Adaptive buffering absorbs temporary jitter; it cannot make a route sustain a
bitrate higher than its long-run capacity. Long outages can exceed retained
history and require skipping forward. A stopped source cannot supply future
frames. Independent captures are not interchangeable backup sources. Legacy
clip invitations do not acquire this HLS policy. Physical device and separate
home acceptance remain distinct from local browser tests.

## Reproduce

```sh
npm ci
npm ci --prefix backend --ignore-scripts
npm run build
npm test
npm run test:adaptive-playback
npm run test:adaptive-room
```

The direct-player harness uses generated continuous HLS with fully prefetched
healthy playback and controlled missing/trickled/burst delivery. The room test
uses real signed WebRTC media, a temporary secure tracker and encrypted club
state, exercises a long network outage and source replacement, and rejects HTTP
or external media delivery. Both use isolated profiles; they must not reload or
change a live family room. Muted native-player checks establish picture cadence,
not physical speaker output.
