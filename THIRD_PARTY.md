# Third-party software

The `vendor/webtorrent.min.js` file is the official WebTorrent 3.0.21 browser bundle, used for WebRTC peer introduction and BitTorrent descriptor exchange. It is distributed under the MIT license; see `vendor/WEBTORRENT-LICENSE.txt`. The same notice is embedded in the standalone app.

Upstream: https://github.com/webtorrent/webtorrent

The build requires Node.js 20 or newer and the pinned esbuild development dependency. The delivered web app has no npm installation step. Peer introduction currently uses `tracker.openwebtorrent.com`; STUN uses `stun.l.google.com:19302`. These are external services with separate availability and operator policies.

The runtime uses `vendor/webtorrent-legacy.js`, derived from that pinned bundle with esbuild 0.25.12 (`--bundle --format=iife --global-name=SameEndTorrentModule --target=es2017,safari12.1,ios12.2,chrome80,edge80,firefox78 --minify`), followed by `window.WebTorrent=SameEndTorrentModule.default`. This lowers newer syntax for the compatibility target; the conditional browser shim supplies the byte methods used by upstream. The original upstream module is retained. Same End removes upstream’s eager origin-private disk cleanup because descriptors use its bounded memory store; the runtime never needs to delete a disk chunk directory. The unused File System Access helper is gated when WritableStream is absent; no global stream implementation is invented. Run `npm run build:vendor` to reproduce the pinned transform and this reviewed patch. Rebuild this runtime bundle when updating WebTorrent. This syntax target is not a claim of physical-device acceptance.

## Standards-based live media

New rooms bundle hls.js **1.7.3** (Apache-2.0) and Mediabunny **1.62.1** (MPL-2.0), pinned in `package-lock.json`. These libraries run on the participants' computers. No runtime library CDN or media server is used.

- hls.js: https://github.com/video-dev/hls.js/tree/v1.7.3 — full notice in `vendor/HLSJS-LICENSE.txt`.
- Mediabunny: https://github.com/Vanilagy/mediabunny/tree/v1.62.1 — full licence in `vendor/MEDIABUNNY-LICENSE.txt`. Exact package source is available at https://www.npmjs.com/package/mediabunny/v/1.62.1 (and its versioned npm source archive).

The libraries are bundled without upstream source modifications. Same End's transport, player adapters and capture adapter are separate MIT-licensed modules. Library notices remain in the generated scripts; the full notices and source links are also included in the delivered HTML and `third-party.html`. esbuild only bundles and lowers syntax. MPL-covered Mediabunny source remains available from its upstream version; building with `npm ci && npm run build` reproduces the integration.
