# Continuous HLS over private peers

New rooms use maintained standard media implementations. Mediabunny 1.62.1 continuously encodes H.264 video and AAC audio and emits live HLS playlists plus CMAF fragmented MP4. hls.js 1.7.3 plays these on MediaSource/ManagedMediaSource browsers. Safari's native HLS player is the fallback when a compatible MediaSource is absent. A viewer never evaluates the modern encoder bundle.

## What changed

The old source restarted MediaRecorder for each approximately two-second file. Joining independent recordings demanded custom MP4 configuration, timestamp and decoder continuity repairs; switching file URLs restarted older players. A full network buffer cannot repair an incompatible decoder configuration or a discontinuous media clock. The new source keeps one encoder configuration and media timeline, with keyframe-aligned independently decodable segments and ordinary HLS manifests. Same End does not parse, rewrite or synthesize MP4 boxes on this path.

This addresses a demonstrated failure class, not proof that every historical family glitch had one cause. Capture starvation, peer delivery, decoder behaviour, sound activation and Apple media-clock issues need distinct evidence. Source/player diagnostics retain those layers.

## End-to-end route

1. A capable computer captures a permitted tab and normalizes its actual source pixels, preserving its audio track. The packager uses one continuous recording timeline and roughly two-second segments. Phone hosting stays hidden.
2. Same End wraps unmodified standard playlist/init/segment bytes in a bounded binary transport envelope. The source signs the envelope hash, cast identity and programme interval using the existing v2 signature protocol. The descriptor explicitly declares `mediaProfile: hls-cmaf-v1` and MIME `application/vnd.apple.mpegurl`.
3. Existing private WebRTC data channels transfer and relay those envelopes. Signature and interval validation precede cache accounting. WebTorrent trackers introduce peers; the social API carries encrypted invitations and chat, never video. There is no TURN or HTTP video fallback.
4. After verification, hls.js reads only the in-page cache through its custom loader. Native Safari requests ordinary HLS URLs; a same-origin service worker answers from that same page's verified cache by message passing. Those requests do not reach the server. Media is never written to persistent CacheStorage.
5. The existing shared programme clock chooses the five-minute-delayed moment. A source-start offset relates the encoder's zero-based media timestamps to that clock without rewriting the media. A late join begins at the group's current moment, rather than at the source's live edge. Native HLS may initially choose its own live point: the controller must seek into a valid seekable group target before requiring that target to be buffered. A native-only standard `EXT-X-START` hint also requests the intended first moment, while bounded seeking handles browsers that ignore it. Otherwise it can wait for the group to catch a later already-loaded frame. This startup ordering is covered by an actual-producer regression, without changing media timestamps.

A transport envelope is not a new video format. Its index is bounded to 64 KiB, 24 files and 4 MiB total, with safe relative paths, declared file types and finite intervals. A signature authorizes source bytes; it does not allow external URLs. Playlist resources must remain inside the verified-cache namespace. Arbitrary URLs, path traversal, external keys and unsupported resource-loading tags fail closed.

## Player and memory behaviour

The engine retains the configured delay plus 30 seconds of safety and up to 60 seconds of adaptive history (192 MiB ceiling); each player keeps a separately bounded verified cache (32 MiB, normally 60 seconds), with a small decoder window (24–36 seconds). The source manifest retains 180 completed segments. Missing intervals are represented with standard `EXT-X-GAP` duration and sequence semantics rather than timestamp compression. These are memory stores; this release does not add disk caching.

The player stays at normal speed. Repeated fractional playback-rate updates disturbed WebKit's audio clock in testing. The shared clock now supplies a nominal reference, while healthy playback follows its own decoder clock. Startup needs four seconds of verified and decoder headroom; real starvation waits for six seconds, increasing to eight and ten on recurrence. Playback may retain up to 60 seconds of extra local delay. An overdue fragment receives a repair interval before a forward gap correction. Seeking is reserved for initial positioning, a real unrepaired gap or expired history; hls.js's competing automatic live-edge seek is disabled. Warm-up still gates loading/playback, including early sound taps. See [adaptive playback](adaptive-playback.md). This is cooperative synchronization, not copy protection.

Native HLS uses an opaque, client-bound capability URL. The private seed never appears in that URL. Worker termination can rediscover the owning page without giving another tab control of its session. Closing the player revokes its capability, cancels pending reads and releases media/cache resources. Browser service-worker support and secure HTTPS are required for that native bridge; a saved file cannot supply it.

## Compatibility boundaries

- Hosting requires desktop tab capture plus supported WebCodecs H.264 and AAC encoders. Capability probing runs before encoding; unsupported hosting reports an actionable error. A browser's name or OS label alone does not prove its installed codecs work.
- Viewing requires H.264/AAC plus a supported MediaSource/ManagedMediaSource route, or native HLS plus the service-worker bridge. Android/Windows/Linux/ChromeOS generally use hls.js; Apple can use either route. Exact old iPad/Big Sur acceptance requires that physical OS/browser, not a responsive viewport.
- Existing legacy invitations remain viewable using the legacy player. They do not turn into HLS in place. The organiser must reload and start a fresh share to create a standard HLS room.
- Native Safari may require a sound tap after loading media. A visible sound toggle is not proof of audible output. Source silence warnings and independent listener controls remain.
- The peer network and two-child forwarding ceiling are unchanged. Buffers cannot supply future video after source loss, and direct-only routes cannot guarantee connection across every VPN/firewall/mobile network. The separate relay-admission robustness branch is not included.

## Reproduce the checks

After `npm ci` and `npm ci --prefix backend --ignore-scripts`:

- `npm run build && npm test`: deterministic old/new protocol, cache, signature, bridge security and regression checks.
- `npm run test:hls-capture`: generated continuous source; real encoder output, independence, audio and lifecycle checks. Requires installed Chrome and ffmpeg.
- `npm run test:hls-player`: fully prefetched continuous HLS, 185-second Chrome and WebKit cadence/clock checks, no network after prefetch. WebKit sound must additionally be measured from its unmodified output: inserting a WebAudio measurement graph is not equivalent evidence.
- `npm run test:hls-produced`: actual browser-encoded 1280×720 H.264/AAC envelopes, fully prefetched and independently hash/signature-checked, through Chrome/WebKit JS and native Apple players.
- `npm run test:hls-native`: native WebKit HLS served by the peer-cache bridge; ordinary HTTP media is rejected by the test server.
- `npm run test:hls-room` and `npm run test:hls-five-minute`: built app, real signed WebRTC, generated source, sound, encrypted chat and group synchronization. The second actually waits five minutes.
- `npm run test:hls-flow`: automatic combined invitation, late join and existing peer-recovery acceptance.
- `npm run test:adaptive-playback`: fully buffered healthy playback plus withheld, trickled and burst-delivered media through actual browser players.
- `npm run test:adaptive-room`: real signed peer delivery, a long outage, recovery, source replacement, chat and unchanged room invitations.

These local tests create isolated profiles and ephemeral chat data. They do not establish physical iPad/phone speakers, different-home connectivity or a 90-minute match. Keep that acceptance separate from build, deployment and simulator evidence.

## Primary references

- [Mediabunny live HLS output](https://mediabunny.dev/guide/writing-hls)
- [Mediabunny media sources](https://mediabunny.dev/guide/media-sources)
- [hls.js compatibility and browser requirements](https://github.com/video-dev/hls.js#compatibility)
- [HLS RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html)
- [Apple HLS authoring specification](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html)

Full upstream licences and versioned source availability: [THIRD_PARTY.md](../THIRD_PARTY.md).
