# Automatic room reconnection

The normal video-and-chat invitation identifies a private room, not one recording. Keep that same invitation when the host restarts sharing. Old combined club-and-magnet invitations resolve the current room after unlocking it. An advanced video-only magnet identifies one capture and cannot discover a replacement source.

## Rooms without a source

**Invite your mates** creates or restores the saved organiser room before capture. Its member invitation opens chat immediately; it does not depend on a currently published video magnet. A source can join later from that saved organiser browser, and waiting members automatically follow it. The room has no global video capacity limit: each visible supplying peer has its own bounded downstream capacity. Source takeover by arbitrary members is not added by this change.

Optional source presence is carried inside the existing encrypted schema-1 club state. A current source renews a 60-second lease at most once per 15 seconds, bound to its exact published capture configuration and publication session. Successful renewal extends the descriptor lifetime. A clean owner stop is distinct from an expired lease. A viewer that receives an authenticated source-end remembers that exact ended descriptor, so delayed club updates cannot make it rediscover the old capture; a new descriptor still joins automatically. An expired lease means **unreachable**, not proof that the owner left; timer throttling or loss of the club connection can also expire it. A source-free room remains open for chat. Late arrivals wait for a fresh owner update; already-playing authenticated media is not stopped merely because presence is stale. Legacy records without presence remain **unknown**.

The waiting picture explains source-not-started, positively stopped sharing, unreachable source, reported device offline, locally observed supplier capacity, and an unresolved direct route separately. Capacity evidence is authenticated, current and bounded to the peers this device can see; no-peer timeouts never become “room full.” This is room/chat resilience using the existing encrypted control service. Video remains peer-to-peer and still requires a source and a usable direct route.

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

A direct connection alone is not playback acceptance. After an outage, HLS playback waits for verified files and useful decoder headroom at its effective local target, preserving the sound preference. It retains extra local delay instead of repeatedly seeking to the nominal group target. Startup and recovery never reveal the source's live edge. A material extra delay is shown in the room.

Extra active delay is bounded to 60 seconds. A paused viewer can fall further behind during a long outage; recovery then chooses an available window within that bound, so material can be missed. Smooth playback, every missed frame and finite delay cannot all be guaranteed on an indefinitely slow route. Networks that block every direct route may still fail to connect. See [adaptive playback](adaptive-playback.md).

## Diagnostics and validation

Connection reports include allowlisted room/source classifications, fresh authenticated supplier counts and typed admission rejections, as well as discovery-renewal state, reset count, bootstrap retry count and retry countdown. The local test timeline retains the same coded evidence. Reports exclude raw tracker/socket objects, addresses, invitation keys and chat.

Build before running browser acceptance:

```sh
npm run build
npm test
npm run test:persistent-room
npm run test:reconnection-webkit
npm run test:invite-feedback
npm run test:automatic-reconnection
HLS_RECONNECT_SCENARIO=room npm run test:automatic-reconnection
```

The automatic-reconnection harness uses generated HLS/CMAF video and sound, real signed WebRTC media, a local secure WebSocket tracker and an ephemeral encrypted club API. It closes actual test peer connections and blocks test tracker sockets; merely setting the browser offline is insufficient. It tests a loss longer than the short test buffer, automatic recovery, source replacement, unchanged invitations, chat, sound preference, decoded frame growth and distance from the group clock. It rejects HTTP video delivery and external media requests.

Browser fixtures and desktop WebKit are not physical iPhone/iPad acceptance. Installed Windows Chrome/Edge acceptance must be reported separately. A simulated route change is not proof that every carrier or VPN permits direct connections. Tests use isolated browser profiles and generated programmes; they must not operate or reload a live family room.

## Safe application updates

The PWA shell defers update activation and automatic reload while a room is joining, playing or connected to its club. Publishing a new build must not force active viewers to reload. Existing pages retain their loaded JavaScript; load the update after the current viewing session before testing the new recovery behavior.

Focused player checks also cover naturally advancing targets after withheld media, initial-load HLS timeouts and native WebKit HLS through the private Service Worker bridge. Native output audio is not measured by those native-player tests; analyser evidence from hls.js is reported separately.
