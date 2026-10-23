# Direct peer discovery and mobile networks

Same End remains peer-to-peer. The application uses no TURN/cloud video relay and does not promise that every mobile network combination can connect. A phone can watch, but the current screen/tab capture experience starts on a supported computer.

## Initial route search

A new viewer first needs the small encrypted room descriptor. A connected invited viewer keeps that descriptor available through WebTorrent and can supply it to another viewer. That friend can also forward signed media if its upstream reaches the source and it has capacity. Each link remains a direct peer connection; the existing two-child limit remains.

Previously the descriptor stage gave up after 30 seconds, before application-level alternate-supplier recovery could operate. The search now lasts at most 90 seconds and requests fresh peer introductions no more often than every 15 seconds, asking for four peers per refresh. It uses two secure WebSocket introduction services and two STUN endpoints (Google UDP19302 and Cloudflare UDP3478). STUN assists address discovery; it never carries the picture. WebTorrent connections are capped at12. Successful connections keep the existing shared epoch, chosen delay, signature verification and cache/recovery behavior.

The second tracker is `wss://tracker.webtorrent.dev`; the existing `wss://tracker.openwebtorrent.com` remains. Both accepted secure WebSocket connections from the development Mac. This is a reachability observation, not an uptime or mobile-provider guarantee. Trackers see connection metadata and the opaque encrypted-descriptor swarm identifier. STUN servers see the network-address queries. Neither receives programme pieces through this app's media path.

On timeout, error or close, pending discovery timers are cleared, the client is destroyed, and late descriptor callbacks cannot open a room. Refreshing introductions during a later supplier search uses the same rate bound. No unsolicited new room, delay change, public channel or cloud video relay is created.

## Network evidence

Invitation checks and explicit host reports now include an allowlisted `joining.network` summary: search phase and coarse failure category, elapsed seconds, tracker/STUN counts, refreshes, replies, warnings, observed peer attempts/errors and ICE connection/failure counts. Optional candidate-event counts retain only host/reflexive categories. No address, port, SDP, candidate string, peer identifier, magnet or key is retained in that summary.

Monitoring a pinned WebTorrent peer's native connection is feature-checked and best effort; missing early events or unsupported interfaces can leave counts at zero. These are observed events, not a complete ICE trace. Zero candidates is not proof that the network blocked them. A generic discovery failure does not establish carrier NAT as its cause. The last failed search summary remains available to the invitation report even after transport cleanup.

## Validation and limits

`npm run test:direct-routes` uses actual WebRTC and generated signed video in isolated Chrome contexts on one Mac. A local secure introduction service withholds every host-to-late-viewer introduction and withholds helper-to-late-viewer introductions for36seconds. Its ordinary tracker interval is120seconds. The late viewer is still waiting without a descriptor at35seconds, then the app's15second refresh finds the helper and playback begins around49seconds. Frames and signed pieces advance; cast identity, epoch and delay remain unchanged. No host-to-late introductions are forwarded. A no-helper control receives no descriptor or media and is aborted early. Encoded audio is present; no human-audibility claim is made.

This is discovery withholding, not a real 5G firewall/NAT simulation. It proves the helper path and search behavior, not universal mobile connectivity. Shared-hotspot isolation, carrier routing, unsupported browsers, sleeping phones, poor throughput, a stopped host and exhausted peer capacity remain possible causes of failure. If no participating pair offers a workable path, software cannot force one through network restrictions. The next acceptance check uses the user's same-hotspot and separate-5G configurations, with an already-watching invited computer on home Wi-Fi as an optional helper.

Primary references: [WebTorrent API](https://webtorrent.io/docs), [tracker client API](https://github.com/webtorrent/bittorrent-tracker), [STUN service and transport documentation](https://developers.cloudflare.com/realtime/turn/), [WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity). The Cloudflare reference describes STUN here; its TURN service has not been configured.
