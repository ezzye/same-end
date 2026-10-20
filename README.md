# Same End

**Your match. Your mates.** A small, browser-based experiment in private group viewing, using the group's own computers to distribute the video.

Open the [test website](https://ezzye.github.io/same-end/) in desktop Chrome or Edge. No account, Electron download or browser extension is required. A PWA installation is optional.

1. Start **Try the test picture**. For a quick check, choose the **10 seconds · connection test** delay first.
2. Make an invitation and copy its **browser invitation**. Send it privately to a friend.
3. Your friend opens that invitation in their browser. Both keep the app open and watch its delayed player. No reply file is needed.
4. For normal use, start a new cast with the default **five-minute delay**, then choose **Share a tab or screen** and select a source in the browser's picker. Enable tab audio if offered.

The original captured screen is still live. Watch the Same End player to see the same delayed moment as the group. Each viewer may need to select **Turn sound on**. Ending the source cast ends the session.

## Run locally

Requires Node.js 20 or newer. There are no install-time dependencies.

```sh
git clone https://github.com/ezzye/same-end.git
cd same-end
npm run build
npm start
```

Open `http://localhost:8792/`. This address works only on that computer. Use the public HTTPS website for invitations between computers. `PORT=8793 npm start` chooses another local port. After source edits, run `npm run build` again.

The build generates `dist/`. GitHub Actions builds and publishes that folder to GitHub Pages on pushes to `main`. The app shell is about 300 KB before compression; the video stays in a bounded rolling memory buffer.

## What is implemented

- Browser capture of a chosen tab, window or screen, plus a moving test picture.
- A shared playback clock: five minutes by default, with shorter connection-test options.
- Private browser invitation URLs containing a real BitTorrent magnet and a random cast key in the URL fragment.
- WebTorrent peer introduction and an encrypted, tiny bootstrap descriptor. A custom BitTorrent extension carries source-signed live pieces over WebRTC; viewers can relay them to other viewers.
- PWA installation and offline reopening of the app shell. Joining still requires internet and available peers.
- No account, public room directory, analytics, subscription credentials or cloud video storage.

A magnet is an entry point for Same End. Ordinary torrent players cannot play this custom live extension. This is a small relay tree, rather than a general-purpose live torrent swarm.

## Limits to test with your group

This remains experimental. Chrome on one Mac has been used to check separate browser sessions, shared timing, relay, invitation handling, offline reopening and browser capture. Those checks do not prove cross-home reliability, Windows operation, mobile support, long-event stability or performance on your network. Mac and Windows laptops using Chrome or Edge are the intended starting point. Phone viewing is unverified; phone capture is not supported as a tested workflow.

There is no TURN media-relay fallback. Some routers, VPNs and firewalls prevent direct connections. Public tracker availability can delay or prevent joining. Keep each laptop awake and the app in the foreground. A relay leaving can interrupt downstream viewers; seamless recovery is not guaranteed. Clip boundaries may be visible or audible. The fixed delay is cooperative synchronization, not copy protection.

## Privacy and use

The website and source code are public. Cast invitations are private bearer links: anyone with the complete link can attempt to join while that cast is active. There is no per-person approval or revocation list. End the cast and start a new one to replace its invitation. A recipient can retain received material.

Peer introduction uses a public WebTorrent tracker and a STUN service. They can see connection metadata and IP addresses; peers can see one another's network addresses. The tracker does not carry video or receive the fragment key. The static website host receives ordinary web requests. See [PRIVACY.md](PRIVACY.md).

Use material you are entitled to capture and share. A provider's terms or DRM may prevent this. Same End does not bypass protected capture, subscription controls or geographic restrictions.

Original code: MIT. WebTorrent: MIT; attribution in [THIRD_PARTY.md](THIRD_PARTY.md) and `vendor/WEBTORRENT-LICENSE.txt`.
