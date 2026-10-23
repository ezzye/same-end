# Source identity, relay recovery and independent backups

## Implemented playback behaviour

A magnet viewer keeps the cast configuration, shared clock offset, verified clip
cache, MediaSource and downstream connections when its supplying wire closes.
The existing authenticated swarm is searched for a rooted supplier of the **same
cast and original source bytes**. Each recovery window allows at most eight
requests or 45 seconds, with a five-second request timeout/cooldown. Exhausted
windows retry automatically with bounded backoff. A user or rehearsal can also
start a fresh bounded window with `PrivateCast.recoverSupplier()`.
This does not create an alternative tracker or network route.

Updated peers measure acknowledged delivery and rotate an open-but-stalled
supplier after a conservative watchdog grace. They preserve the same clock and
skip already verified history during handover. Capacity-aware admission keeps
the existing two-child ceiling. See [delivery and recovery](delivery-recovery.md)
for the negotiated receipt/resume fields, bounded measurements and test limits.

A supplier reserves pending downstream slots before accepting, so two concurrent
children cannot be overcommitted by a third request. Both sides check full source
ancestry, and an upstream's changing ancestry is carried to its children. An
orphan retains its cache and ancestry but advertises `rooted: false`, so cached
video cannot masquerade as a live source path. Maximum downstream fan-out stays
two, maximum discovery wires twelve and ancestry is bounded to twelve nodes.
Clock samples from a previous supplier are cleared on connection while the
current offset stays in force until a fresh sample is available.

A departing relay sends `relay-leave`. A capture source sends an ECDSA-signed
`source-end` binding the cast, source, epoch and end time. Only a verified source
end propagates to stop the cast. An old ambiguous `end` is treated as a departed
supplier, which prevents a relay from accidentally stopping everyone. Losing
the actual capture source cannot create future video: only already cached
pieces remain, and the player pauses when the shared play point has no piece.
This is bounded resilience, not a guarantee of uninterrupted playback.

`PrivateCast.snapshot()` includes non-secret supplier, ancestry, recovery attempt
and recovery count, source-reachability, last received time and stall data.
`sameend:castchange` carries non-secret lifecycle information. The explicitly
named `PrivateCast.testing` helpers start a synthetic demo, publish an invitation,
end this page's room or disconnect only this viewer's own upstream. They cannot
operate another browser or silently capture a desktop. Invitation publication
returns the private invitation to its caller; snapshots and lifecycle events do
not expose it.

## Signed segment contract

Old descriptors without `segmentVersion` keep the v1 canonical JSON array:

```
[cast, seq, start, duration, size, mime, hash]
```

New descriptors set `segmentVersion: 2`, `sourceId`, `sourceEpoch`, `programId`
and `alignmentVersion: 1`. Their signed canonical array is:

```
[2, cast, sourceId, sourceEpoch, programId, programStartTime,
 alignmentVersion, seq, start, duration, size, mime, hash]
```

`start` is the origin capture clock in milliseconds. `programStartTime` is the
source-relative programme position in milliseconds; for the current single
capture it equals `start - config.epoch`. This source-relative coordinate makes
future alignment expressible. It does **not** establish that another independent
capture contains the same programme frame. New v2 descriptors require v2 media;
they cannot downgrade to a weaker v1 signature. The current engine accepts only
the configured source/epoch/programme; it does not apply backup promotions.

Deduplication is `(cast, sourceId, sourceEpoch, seq)`. Legacy clips use a derived
legacy source plus their descriptor's epoch. Hashes identify and verify bytes;
two captures can show the same frame and still have different hashes, clip
boundaries, codec state or audio timing. A source epoch is a new capture sequence
space and must never be silently confused with an old sequence.

Existing v1 magnet descriptors and the original source accept handshake remain
readable. Older relay software cannot advertise the new rooted ancestry or
verify source-end signatures, so resilient mixed-version relay trees are not
claimed. Open pages need a refresh before starting a new cast to use this engine.

## Testable independent-source foundation

`backup-protocol.js` is an ESM helper module; it is not enabled in the live
network or decoder. An authority-signed version 1 source manifest binds the cast,
programme, exact feed/edition, monotonic revision, expiry, source IDs/epochs,
per-source verification keys, codecs, validity windows and measured capture to
programme mappings. At most four sources and eight alignment records are
accepted. `verifyManifest()` checks the signature and validity, enforces a caller
supplied minimum revision, then returns a frozen verified manifest. Callers must
persist the highest accepted revision to prevent rollback across restarts.

An alignment record must identify the exact pair of authorised epochs and exact
feed/programme, use `verified-program-offset`, carry an evidence ID, measured
offset, uncertainty and validity window. It must come from trusted content
alignment work. Merely using the same match title, setting equal device clocks,
matching timecodes or comparing hashes does not create this record. Distinct
commentary, ads, edits and broadcaster delay are different feeds unless content
alignment explicitly accounts for them.

`mapCaptureToProgram()` maps an authorised capture anchor into programme time.
`planPromotion()` accepts only a manifest returned by `verifyManifest()`; it
requires a future programme boundary with at least four seconds' default lead,
source and alignment validity covering that boundary, matching codec identity,
and a measured offset consistent with the programme mapping within a default
40 ms uncertainty limit. It returns a **plan**, marked
`decoderTransition: required-and-unverified`. `canonicalPromotion()` defines
bytes for a future authority signature; the current network does not send,
receive or execute these plans.

Before independent captures can be switched live, further work must prove a
content alignment method, authority-approved switch distribution/replay rules,
clip/keyframe boundaries, decoder reset or dual decoder handoff, audio continuity,
late-join/late-promotion policy and failure behaviour on real devices/networks.
A signed plan and a synthetic offset test do not prove a seamless decoder switch.

## Evidence

Run `node --test tests/backup-protocol.test.mjs tests/magnet-recovery.test.mjs`.
Tests include a synthetic 7.5-second offset between captures of the same known
programme frame; a mismatched feed is rejected. They also cover signature
binding, stale/unauthorised epochs, absent/uncertain/inconsistent alignment,
expired or tampered manifests, future-boundary enforcement, relay capacity,
loop prevention, ancestry updates, bounded recovery and v1 canonical compatibility.

The private browser rehearsal lives under `../work/same-end-social/recovery/`.
Its JSON records are the authority for whether a real tracker rehearsal passed;
unit tests alone do not establish discovery or decoded playback. One-Mac browser
contexts do not establish different-home delivery, real phones or independent
capture switching.

## Social control and rehearsal boundary

The club service distributes an encrypted live invitation and encrypted rehearsal
control messages. It does not carry media, obtain the club decryption key or turn
its cloud storage into a video relay. The organiser can publish and clear the
club's current room invitation; clearing it does not close existing peer media
connections. A persistent club invitation and a one-capture room invitation have
separate lifetimes and access effects.

The installed-Chrome four-context public-tracker rehearsal passed against the
canonical engine/transport hashes recorded in the private evidence JSON. A relay
reparent preserved its downstream viewer, clock and cache. Closing the relay
browser led its child to reattach in about 17.7 seconds with one measured stall
in the ten-second quick-test delay. The source-signed end propagated. A separate
actual-source-loss scenario retained the viewer session and five saved clips,
then paused when the cached window ended; it did not report a signed source end
or promise future capture. This is one-Mac synthetic-video evidence, not proof
of different-home, physical-device or seamless independent-capture delivery.

The club's **Try it together · three-laptop rehearsal** coordinates explicitly
enrolled browser sessions using organiser-owned encrypted state and encrypted
member observations. It can select 10- or 300-second generated-picture delay,
exercise only a viewer's own supplier connection and export bounded measurements.
It never invokes personal desktop capture or automatically writes a private link
to the clipboard. Remote metrics and physical-device labels are self-reported;
reported decoded playback is separate from independent proof of hardware/network
separation. This rehearsal controller does not execute independent-source
promotions from the helper module.
