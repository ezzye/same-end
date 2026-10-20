# Third-party software

The `vendor/webtorrent.min.js` file is the official WebTorrent 3.0.21 browser bundle, used for WebRTC peer introduction and BitTorrent descriptor exchange. It is distributed under the MIT license; see `vendor/WEBTORRENT-LICENSE.txt`. The same notice is embedded in the standalone app.

Upstream: https://github.com/webtorrent/webtorrent

The build requires Node.js 20 or newer and uses its standard library. There are no install-time npm dependencies. Peer introduction currently uses `tracker.openwebtorrent.com`; STUN uses `stun.l.google.com:19302`. These are external services with separate availability and operator policies.
