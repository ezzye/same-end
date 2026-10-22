# Third-party software

The `vendor/webtorrent.min.js` file is the official WebTorrent 3.0.21 browser bundle, used for WebRTC peer introduction and BitTorrent descriptor exchange. It is distributed under the MIT license; see `vendor/WEBTORRENT-LICENSE.txt`. The same notice is embedded in the standalone app.

Upstream: https://github.com/webtorrent/webtorrent

The build requires Node.js 20 or newer and uses its standard library. There are no install-time npm dependencies. Peer introduction currently uses `tracker.openwebtorrent.com`; STUN uses `stun.l.google.com:19302`. These are external services with separate availability and operator policies.

The runtime uses `vendor/webtorrent-legacy.js`, derived from that pinned bundle with esbuild 0.25.12 (`--bundle --format=iife --global-name=SameEndTorrentModule --target=es2020,safari14.1,ios14.5,chrome90,edge90,firefox90 --minify`), followed by `window.WebTorrent=SameEndTorrentModule.default`. This lowers newer syntax for the compatibility target; the conditional browser shim supplies the byte methods used by upstream. The original upstream module is retained. Same End removes upstream’s eager origin-private disk cleanup because descriptors use its bounded memory store; the runtime never needs to delete a disk chunk directory. Run `npm run build:vendor` to reproduce the pinned transform and this reviewed patch. Rebuild this runtime bundle when updating WebTorrent. This syntax target is not a claim of physical-device acceptance.
