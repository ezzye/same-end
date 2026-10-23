# Measured delivery and automatic supplier recovery

This release preserves the shared programme epoch and chosen delay while a magnet
viewer changes supplier. The player resumes at the group's current moment; it
does not replay the interruption or invent a separate personal delay. A brief
pause remains possible if recovery outlasts the viewer's verified reserve.

## Measurements and admission

New peers announce `deliveryVersion: 1` in their existing application `hello`.
Only a peer which announced that capability receives `delivery-receipt` messages.
Receipts bind the current cast, sequence, hash and byte size. A receiver sends
one only after validating the source identity, programme position, digest and
signature. The sender counts only a matching actually sent record; mismatched,
unsolicited and duplicate receipts cannot increase the measurement. Concurrent
verification during handover cannot insert the same piece twice.

`delivery-health.js` retains at most 128 pending/acknowledged records per link
and expires records after 60 seconds. A rate requires multiple acknowledgements
spanning five seconds and reports payload Mbps over the recent five-second
window. It is observed delivery, not maximum broadband capacity, proof of
decoded playback or a cryptographic claim about another person's behaviour.
Actual upload/download costs include additional transport overhead.

The two-child safety ceiling remains. If a child's send queue exceeds 2 MiB, or
an acknowledged-delivery link has a pending receipt at least 12 seconds old,
the relay stops advertising spare capacity above its current child count.
Existing children are not evicted just to change that advertisement. Admission
and confirmation both respect the advertised limit and pending reservations.
Legacy peers default to two; a new limit cannot make older relays capacity-aware.
No speed test, extra encoder, background bandwidth probe or larger fan-out is
enabled by this release.

The app reports contiguous verified media ahead of the current shared play point,
separately from total memory and decoder-buffer size. The calculation accepts
overlapping/out-of-order pieces, bridges at most 100 ms of recorder jitter and
stops at a larger gap. A five-minute configuration is not proof of five minutes
of playable reserve, especially immediately after joining.

## Recovery policy

The engine checks progress once per second, independently of whether this
device's player is currently visible. A 12-second connection grace and progress
window detects an open supplier which no longer advances verified source pieces.
Missing application control replies also detect an unresponsive supplier; an
unrooted path is distinguished from a rooted-but-stalled path. Source audio
silence is never used to decide that a network route failed. A sampling gap over
five seconds resets the local watchdog grace after browser suspension.

To avoid a parent and child competing for the same replacement slot, a deeper
viewer with more than 20 seconds of verified reserve gives a responsive parent
four additional seconds per hop (capped at 12 extra seconds). A newly unrooted
parent gets a bounded 15-second repair interval. Missing control replies bypass
this grace, and a shallow reserve does not defer recovery. The parent retains
its children while repairing its own upstream; a still-stalled parent is
eventually replaced rather than trusted indefinitely.

`recoverSupplier(reason)` closes only the failed upstream wire and gives that
supplier a 20-second cooldown. The authenticated swarm searches existing
source-rooted alternatives, preserving downstream connections, clock offset,
verified cache and player ownership. Full ancestry checks prevent relay loops.
This is alternate-supplier recovery, not an independent recording switch.

Each search window still permits at most eight requests or 45 seconds. Exhausted
windows retry automatically after exponential backoff with jitter (about five
seconds initially, capped at 60 seconds). Explicit retry and returning online
can start a new bounded search. Closing the room cancels recovery and clears its
state. No additional tracker or TURN media relay is introduced.

Updated viewers include `resumeAfter` in `hello`, calculated from contiguous
recent cached sequences. An updated supplier skips that verified prefix rather
than retransmitting the entire delayed history before the missing pieces. A
future-only cache cannot certify a missing current play point. Signed pieces
arriving out of order can repair holes without falsely advancing the supplier's
latest progress. Older suppliers ignore this additive handshake field.

Only a verified `source-end` can end everybody's room. A relay departure triggers
recovery. Abrupt capture-source loss retains the session and remaining cache,
then pauses honestly when the shared play point has no future source bytes.

## User interface and reports

The room briefly explains automatic reconnection when needed. Connection details
show verified picture ahead and acknowledged outgoing Mbps, with the capacity
limitation stated. Picture quality, room delay and selected-tab-only sound
behaviour are unchanged. Private reports to the host add rounded reserve,
allowlisted supplier health and recovery count; they exclude peer IDs, addresses,
keys, invitations, raw errors, chat and media.

## Verification

Run the normal build and `npm test`. Focused tests cover receipt validation,
bounded accounting, contiguous reserve, stalled/control-silent suppliers,
reservations, cooldowns, retry windows, signature failures, concurrent duplicate
verification and clock/cache preservation. The old-browser syntax floor and
fallback decoder paths remain part of the existing regression suite.

`npm run test:recovery` starts isolated installed-Chrome contexts, a generated
moving picture and 220 Hz tone, and a temporary local WSS introduction tracker.
Media still uses actual WebTorrent/WebRTC peers. The test records actual decoded
frame callbacks, audio signal, mapped programme positions, reserve, stalls and
source/relay identities, and saves detailed evidence under ignored `privatework/`.

For a focused run use `SAMEEND_RECOVERY_CASE=reserve`, `stall` or `loss`.
`SAMEEND_RECOVERY_CASE=reserve SAMEEND_RESERVE_DELAY=300 npm run test:recovery`
exercises the actual five-minute default. Controlled stalls block selected
application media, or a viewer's incoming application messages, while leaving
the connection open. These are not physical router cuts. The harness uses
isolated-browser autoplay and local certificate overrides, but no fake clock,
fake WebRTC or fabricated page visibility. Unit checks of background grace do
not establish locked-phone/background operation on real hardware.

These tests establish one-computer synthetic-media behaviour. They do not prove
different-home connectivity, real-device acceptance, congested access networks,
90-minute event stability, protected-stream capture or seamless source failover.
