# Same End

**Your match. Your mates.** A private football club for planning the next game, chatting with your mates and watching the same delayed picture together.

Open [Same End](https://www.sameend.com/) in desktop Chrome or Edge. There is no account or extension to install. Installing the app is optional. The standalone [guide](test-guide.html) can be saved and shared as an HTML file.

## Make match day a regular thing

1. Choose **Create your club**, give it a name and pick your colours. The club is saved on this browser.
2. Choose the club's **Invite your mates** and send its member invitation privately. Mates open it and choose **Join & save club**. Keep your separate organiser link for yourself: it can edit the club and diary.
3. Open **Plan a match**. Choose a starter fixture or enter any match manually. Times are entered in London time, with GMT/BST handling and an optional local-time display.
4. Choose **Add to calendar**, or optionally enable match reminders on each browser. Download a fresh calendar entry after a kick-off change; remove old entries in your calendar app.
5. Chat in the club before kick-off. When the organiser's shared screen and invitation are ready, members choose **Join live**. Chat sits beside the player on a wide screen and below it on a narrow screen.

The fixture picker is a small source-checked starter list, checked 21 October 2026. It is not a comprehensive or automatically updated live fixture feed. Check the linked source for changes and add other matches manually. The organiser edits the diary; names in chat are self-chosen and do not verify identity.

Clubs and chat need the control service. The social build includes its deployment configuration; public rollout and real notification delivery must be confirmed separately. If a copy says clubs or reminders are not connected yet, use its quick viewing test or a calendar entry meanwhile.

## Start directly with video and chat

Choose **Try a quick test** for a synthetic moving picture with a ten-second shared delay. A private chat room opens automatically and is saved on the organiser browser. Choose **Invite your mates** and send the new invitation privately: it opens both video and chat automatically. An explicitly opened organiser club is used when present; otherwise only a previously automatic room is reused. Mates can save the club to return another day. Keep the app open and each laptop awake.

**Live chat** and **Match reminders** are beside the picture. The reminder controls are visible above the diary. Each person must enable notifications on their own browser; reminders require a planned match. Older video-only links continue to play video and ask for a fresh invitation to add chat. If the control service fails, the app labels the video-only fallback explicitly.

For your own source, end the test and choose **Share a tab**. The browser asks which tab, window or screen to capture; include tab audio if offered. Normal match rooms use a five-minute shared delay. Watch the Same End player, since the original captured screen remains live. Each viewer may need **Turn sound on**. Settings are inside **Room settings & help**.

A club invitation returns to the same club and diary. A room invitation belongs to one capture session. Starting a new room creates a new room invitation, which the organiser's open club can publish to its members. Ending a source room clears its live invitation when the control service can be reached; a stale entry otherwise expires after six hours. Clearing a live invitation alone does not end an existing media connection.

## Rehearse with your own laptops

In an open club, expand **Try it together · three-laptop rehearsal**. The organiser chooses the ten-second warm-up and **Create & join rehearsal**. Select and copy its member invitation yourself; each mate joins the club, labels their laptop and chooses **Join current rehearsal**. Once all three sessions are recently seen, the organiser chooses **Start generated picture**. Enrolled viewers join the generated picture automatically. No desktop capture or automatic clipboard access is used.

Repeat with **5-minute match delay** and allow at least six minutes to observe playback. A viewer can choose **Try one supplier reconnect on this viewer** to exercise its own supplying connection. Use **End rehearsal for everyone** and **Download test report** to keep the observations. Reports include decoded frames, advancing playback, drift, stalls and reconnects; remote observations and physical-device labels are self-reported. They cannot independently attest separate hardware or homes. A ten-second warm-up does not prove five-minute playback, protected-stream capture or notification delivery.

## What runs where

The static app and fixture list are public. A small cloud control service stores encrypted club details, chat and the current live invitation, plus the timing and browser subscription metadata needed for reminders. It does not carry or store the video, subscription-service credentials or club decryption keys.

The captured video travels between peers over WebRTC. WebTorrent introduces peers using a tiny encrypted descriptor and a custom extension carrying source-signed video pieces. Each laptop supplies at most two downstream viewers. An ordinary torrent player cannot play this custom live format.

A lost supplier triggers a bounded search for another authenticated supplier of the same cast. The app preserves its shared clock, verified cache and downstream peers. A relay leaving does not impersonate a whole-source shutdown; an explicit source-signed end propagates. If the original capture disappears, saved pieces cannot supply future video. Independent-capture backup switching is a protocol foundation only; see [backup protocol](docs/backup-protocol.md).

Web Push is optional and best effort. Its generic notification opens a club already saved on that browser; the push contains no invitation key, team name, chat or live stream address. The scheduler checks once per minute; exact-second delivery is not guaranteed. Browser permission, supported push services, operating-system settings and provider availability all matter. Provider acceptance does not prove a device displayed the notification. **Add to calendar** remains available without push; calendar files contain a private member invitation and should be kept private.

## Evidence and limits

A four-context installed-Chrome rehearsal on one Mac used the actual public tracker and decoded synthetic video/audio. Losing a relay's upstream preserved its downstream viewer, clock and cache while it reparented. Closing the relay browser led its child to reattach after about 17.7 seconds, with one measured stall in the ten-second quick-test delay. An explicit signed source end stopped the surviving viewers. A separate actual-source-loss check preserved the viewer session and played only the remaining cached window before pausing.

Those checks do not establish different-home delivery, physical Windows or phone support, long-event stability or seamless independent-source switching. Mac and Windows laptops with Chrome or Edge are intended starting points; physical Windows acceptance and phone viewing still need testing. Phone capture is not an established workflow. Public tracker discovery can fail or take time. There is no TURN media-relay fallback, so some routers, VPNs and firewalls prevent direct connections. Recovery cannot guarantee uninterrupted playback, and clip boundaries can be visible or audible. The delay is cooperative synchronisation, not copy protection.

The control backend has focused local tests for permissions, encrypted-envelope limits, retention, concurrency and reminder scheduling. Local tests, AWS deployment, public browser checks, push-provider acceptance and visible device notification are separate evidence states. Deployment resources and pilot limits are described in [the control-service review](backend/REVIEW.html).

## Run and build

The static app requires Node.js 20 or newer and has no install-time dependencies:

```sh
git clone https://github.com/ezzye/same-end.git
cd same-end
npm run build
npm start
```

Open `http://localhost:8792/`. That address works on this computer only. Use the public HTTPS app for invitations between computers. `PORT=8793 npm start` chooses another local port. Rebuild after edits: the generated `dist/index.html` embeds the canonical engine and transport for offline file sharing. GitHub Actions publishes `dist/` to GitHub Pages when `main` is pushed.

Local club development also needs the API from `backend/` (`npm ci`, then `npm start`, default port 8795) and an app `/api` proxy or configured HTTPS API origin. Local API data is temporary and push is disabled unless genuine VAPID settings are provided. See [the API contract](social-contract.md). Keep deployment state and credentials outside public source and builds.

Run the media/protocol checks with:

```sh
node --test tests/backup-protocol.test.mjs tests/magnet-recovery.test.mjs
```

The installed PWA can reopen its app shell offline. Live clubs, chat, reminders, joining and incoming video still need connectivity and available services or peers.

## Keep the circle private

Member and room invitations are bearer links: anyone with one can forward it. There is no per-person admission, approval or revocation list. Ending and replacing a room rotates that room's access; it does not revoke the separate club invitation. To replace club access, create a new club and share it with the intended people. **Forget club on this browser** removes local saved access, not other members or server records.

Club records expire 400 days after their last organiser update; server chat expires after 24 hours and reminder registrations after 90 days without refresh. Database cleanup is eventual. Read [PRIVACY.md](PRIVACY.md) for local storage, metadata and retention details.

Use material you are entitled to capture and share. Same End does not bypass DRM, subscription controls or geographic restrictions. Providers can prohibit or block capture. Recipients can retain material they receive.

Original code: MIT. WebTorrent: MIT; attribution in [THIRD_PARTY.md](THIRD_PARTY.md) and `vendor/WEBTORRENT-LICENSE.txt`.
