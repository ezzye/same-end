# Automatic room reconnection

The normal video-and-chat invitation identifies a private room, not one recording. Keep that same invitation when the host restarts sharing. Old combined club-and-magnet invitations resolve the current room after unlocking it. An advanced video-only magnet identifies one capture and cannot discover a replacement source.

## Source restart and network change are different

When sharing restarts, the organiser publishes its new encrypted descriptor into the same club state. Existing viewers discard only their old owned media session and follow the new source. Chat, membership and local sound preference remain. A new capture has a new epoch and the ordinary group warm-up. Starting a different manually chosen room or selecting Leave prevents the previous follower from taking it over.

When the same source survives a VPN or network change, the capture, signed programme identity, verification keys, buffer and shared clock remain. The transport refreshes direct discovery, creates new offers and reparents to an authenticated available supplier. It does not introduce a TURN service or cloud media relay.

Phone browsers can suspend background tabs or lock-screen pages. Same End checks the room and discovery when the page returns to the foreground or the browser reports that the network is available. This does not promise background playback or execution while the operating system has suspended the app.

## Recovery controls

- Retryable descriptor discovery failures retry with fresh clients and bounded jitter/backoff. Invalid invitations, invalid descriptors and unsupported media do not retry as though they were network outages.
- Active transports reannounce, renew stale discovery and expire half-open peer connections, with grace after browser timer suspension. Healthy peer connections and source capture remain intact. The pinned tracker adapter clears orphan reconnect timers even on already-destroyed tracker handles, limits pending offers, and applies a minimum 15-second announce interval while respecting longer server intervals.
- Club fetch failures retry transient timeouts and server failures. Successful polling reconciles the current source even if the state version has not changed. Foreground/network events request a serialized refresh.
- Explicitly opening a watch invitation or choosing Join live can replace the exact stale viewer session present at that action. Background polling never adopts an unrelated manually opened cast.
- Leave remains available during a pending connection search and cancels its retry timers, async work and remembered invitation intent.

The discovery renewal adapter is deliberately tied to the checked-in WebTorrent bundle. It checks its private discovery/socket/timer APIs before use, avoids retiring healthy sockets shared by other consumers and reports a coded limitation if those APIs change. Vendor upgrades must rerun the discovery and cancellation regression tests. A destroyed underlying torrent/client is reported separately from an ordinary stale discovery wrapper.

## Buffer exhaustion and the shared moment

A direct connection alone is not playback acceptance. After a sufficiently long outage, the player may have no media around the current group target even though old frames remain buffered. Recovery must wait for verified files at the current target and resume the ordinary HLS pipeline there, preserving the existing sound preference. It must not show the live source or play the outdated buffer as if it were synchronized.

If the outage exceeds the group's reserve, material can be missed. Recovery rejoins the group's current moment; it cannot both replay everything missed and remain synchronized with people who kept watching. Networks that block every direct route may still fail to connect.

## Diagnostics and validation

Connection reports include allowlisted discovery-renewal state, reset count, bootstrap retry count and retry countdown. The local test timeline retains the same coded evidence. Reports exclude raw tracker/socket objects, addresses, invitation keys and chat.

Build before running browser acceptance:

```sh
npm run build
npm test
npm run test:persistent-room
npm run test:reconnection-webkit
npm run test:invite-feedback
npm run test:automatic-reconnection
```

The automatic-reconnection harness uses generated HLS/CMAF video and sound, real signed WebRTC media, a local secure WebSocket tracker and an ephemeral encrypted club API. It closes actual test peer connections and blocks test tracker sockets; merely setting the browser offline is insufficient. It tests a loss longer than the short test buffer, automatic recovery, source replacement, unchanged invitations, chat, sound preference, decoded frame growth and distance from the group clock. It rejects HTTP video delivery and external media requests.

Browser fixtures and desktop WebKit are not physical iPhone/iPad acceptance. Installed Windows Chrome/Edge acceptance must be reported separately. A simulated route change is not proof that every carrier or VPN permits direct connections. Tests use isolated browser profiles and generated programmes; they must not operate or reload a live family room.

## Safe application updates

The PWA shell defers update activation and automatic reload while a room is joining, playing or connected to its club. Publishing a new build must not force active viewers to reload. Existing pages retain their loaded JavaScript; load the update after the current viewing session before testing the new recovery behavior.

Focused player checks also cover naturally advancing targets after withheld media, initial-load HLS timeouts and native WebKit HLS through the private Service Worker bridge. Native output audio is not measured by those native-player tests; analyser evidence from hls.js is reported separately.
