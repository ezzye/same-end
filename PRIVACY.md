# Privacy

Same End is intended for small, invitation-only groups. It has no public room listing and the app has no analytics.

When the magnet transport connects, it contacts a public WebTorrent tracker over secure WebSockets to introduce peers and exchange an encrypted cast descriptor. The tracker can see your IP address and swarm metadata. The cast descriptor is encrypted; its decryption key is carried in the magnet fragment and is not sent to the tracker. The tracker does not carry video. Media travels between group peers over WebRTC. Connected peers can learn one another's network IP addresses as part of that connection.

A complete invitation magnet is a bearer invitation: anyone who obtains it may attempt to join while the cast is available. Share it privately and revoke access by ending the cast. Do not put invitation links in public posts, issue trackers, screenshots, or logs.

The public website host receives ordinary page and asset requests, including network metadata. The invitation fragment is removed from the address bar before joining and is not sent in those HTTP requests. The offline cache contains only four fixed app-shell assets; it does not store invitations or video.

The source is captured locally in the browser and sent to the group. The app keeps a rolling media window in memory (up to 192 MiB of application media cache, plus browser/transport buffers); stopping a cast clears its application session state. The app does not make a cloud recording. The browser, operating system and invited peers can retain data outside that application state.

The tracker and STUN service are third-party network services. Their operators may log connection metadata under their own policies. This project cannot promise anonymity or prevent peers from recording content they can view.
