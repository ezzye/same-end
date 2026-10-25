# Same End

## Fan forum and feedback

**3 · Fan forum** sits directly after the two steps (and directly after the picture and chat while a room is open). It expands and collapses, and that choice, the topic filter and sort order are remembered on each browser across rooms. Anyone can read without joining; starting discussions, replying and liking need the pilot code. Discussions can be filtered by topic and sorted Hot/New/Top; replies nest up to four levels, with collapsible branches, likes and an OP badge. While the section is open and visible it checks for new posts every 25 seconds and offers a “new comments” pill rather than reshuffling the page. It never reveals private room invitations or encrypted chat. Spoiler topics conceal their title and body until deliberately revealed. **Send feedback** in the footer and in the forum opens private feedback to the Same End team. The initial waiting screen offers a 24-second optional audio introduction and a static graphic, with a transcript. It fetches the 76 KB recording only after Play and stops it when the picture is ready or the guide/page is hidden. A bounded published text/quiz/sponsor pack remains under optional reading. Capture, match sound, group timing and recovery remain separate.

The staff desk at `/manage.html` manages feedback replies/statuses, moderation and reports, member suspension, waiting content/schedules, pilot settings and an audit trail. Production infrastructure adds administrator-created Cognito accounts, required authenticator MFA and role-protected API routes. See [management setup](docs/community-management.md), [API contract](docs/community-contract.md) and [privacy](PRIVACY.md). Production sign-in, deployed persistence and physical-device acceptance require separate verification.

For an isolated review, run `npm run review:community`. It binds only to this computer at `http://127.0.0.1:8972/`, with the staff desk at `/manage.html`. Its random local review credential is in the ignored `privatework/community-review/access.json` file; keep it private and paste it into **Enter local review**. This fixture credential has no production authority. Review data persists under that ignored directory. Stop the launcher with Ctrl+C. The launcher does not deploy or modify the live service.

Validation: `npm run build`, `npm test`, and `SAME_END_LOCAL=1 npm run build && npm run test:community`. Browser checks require Playwright (`SAMEEND_PLAYWRIGHT` can identify its module) and Chrome (`CHROME_PATH` can override its executable). The community harness owns isolated loopback servers and temporary test identities; it never operates a live room. Waiting readiness in that harness is a state fixture, not real-network match acceptance.

**Your match. Your mates.** A private football club for planning the next game, chatting with your mates and watching the same delayed picture together.

Open [Same End](https://www.sameend.com/watch.html) in Safari, Chrome or Edge. The compatibility player supports MP4 viewing on phones, tablets and computers; see the device targets and evidence below. There is no account or extension to install. Installing the app is optional. The standalone [guide](test-guide.html) can be saved and shared as an HTML file.

## Make match day a regular thing

1. Choose **Create your club**, give it a name and pick your colours. The club is saved on this browser.
2. Choose the club's **Invite your mates** and send its member invitation privately. Mates open it and choose **Join & save club**. Keep your separate organiser link for yourself: it can edit the club and diary.
3. Open **Plan a match**. Choose a starter fixture or enter any match manually. Times are entered in London time, with GMT/BST handling and an optional local-time display.
4. Choose **Add to calendar**, or optionally enable match reminders on each browser. Download a fresh calendar entry after a kick-off change; remove old entries in your calendar app.
5. Chat in the club before kick-off. When the organiser's shared screen and invitation are ready, members choose **Join live**. Chat sits beside the player on a wide screen and below it on a narrow screen.

The fixture picker is a small source-checked starter list, checked 21 October 2026. It is not a comprehensive or automatically updated live fixture feed. Check the linked source for changes and add other matches manually. The organiser edits the diary; names in chat are self-chosen and do not verify identity.

Clubs and chat need the control service. The social build includes its deployment configuration; public rollout and real notification delivery must be confirmed separately. If a copy says clubs or reminders are not connected yet, use its quick viewing test or a calendar entry meanwhile.

## Start directly with video and chat

Choose **Share a tab** on a computer. A private chat room opens automatically and is saved on the organiser browser. Choose **Invite your mates** and send its invitation privately: it opens picture and chat automatically. The invitation belongs to the saved room, so it stays the same when sharing restarts. The developer controls include a synthetic ten-second quick test. Keep the app open and each laptop awake.

**Live chat** and **Match reminders** are beside the picture. The reminder controls are visible above the diary. Each person must enable notifications on their own browser; reminders require a planned match. The advanced raw magnet is labelled video-only; use the normal video + chat invitation for social features. Older video-only links continue to play video and ask for a fresh invitation to add chat. The standard invitation is withheld until both video and chat are ready. If chat fails, choose **Retry video + chat invitation**. A separate **Send video only instead** button is an explicit choice; it is never silently copied by the normal invitation action.

Choose **Share a tab** for your source. The browser asks which tab, window or screen to capture; include tab audio if offered. New match shares choose a measured common delay, including the host, with a five-minute conservative fallback. Watch the Same End player, since the original captured screen remains live. Keep the original player unmuted and its volume up: Chrome keeps that tab quiet locally while sharing. Each viewer may need **Turn my sound on**. That control affects only their own listening. Hosts receive a warning after 15 seconds of detected source silence. Settings are inside **Room settings & help**.

HLS viewers now favour smooth playback over exact alignment. After a real interruption they save a useful 6–10 seconds before resuming, allowing up to 60 seconds of extra local delay rather than repeatedly seeking to catch the room clock. A discreet buffer label shows material extra delay; chat remains immediate. See [adaptive playback](docs/adaptive-playback.md) for the policy, limits and test commands.

Each viewer observes verified incoming payload rate, source bitrate, delivery gaps and reserve. These measurements describe observed delivery, not maximum broadband capacity. The existing automatic viewer-start policy is enabled by default and prepares decoder reserve at or behind the room's established common baseline. Initial and later local lag share the existing 60-second cap; a fast viewer cannot independently move ahead of the host. See [viewer startup acceptance](docs/automatic-initial-delay.md) and [client delivery measurements](docs/client-delivery.md).

The separate [measured common-start policy](docs/measured-common-start.md) lets the source choose one shared 30–120-second baseline from fresh host/viewer observations, with the host following that same timeline. It retains the original 300-second configuration for conservative fallback and history. **It is enabled by default after the controlled platform acceptance matrix**; build with `SAMEEND_AUTOMATIC_COMMON_START=0` to disable it. At least one supporting viewer must join and supply enough fresh measured feedback within the first 60 seconds of capture; otherwise the room keeps its five-minute start. Uncertain growing backlogs wait for more evidence. Existing sessions never retime when code changes: update the app and start a fresh share. Saved club and combined room invitations stay the same across sharing restarts; raw video-only magnets remain capture-specific.

On Chrome or Edge on a Mac, the first **Share a tab** shows preparation guidance. macOS may require screen-recording permission, an administrator password or Touch ID in its own system prompt, and **Quit & Reopen** of the browser. Older Macs use System Preferences → Security & Privacy → Privacy → Screen Recording; newer Macs use System Settings → Privacy & Security → Screen & System Audio Recording. Same End never asks for that password and cannot grant or verify this OS permission. Cancelling the tab picker and an OS denial can both appear as `NotAllowedError`, so the help does not claim to distinguish them. Viewers do not need capture permission.

Direct connections are not guaranteed on mobile, hotspot, restricted or carrier-NAT networks. The current picture path uses two secure introduction services and two STUN endpoints, with **no TURN relay fallback**. Initial joining can search for90seconds and request fresh introductions every15seconds, including another invited viewer that can supply the room descriptor and picture. See [direct peer discovery and its limits](docs/direct-peer-discovery.md). A website or chat connection does not establish that a direct picture path is available. Invitation reports now state that mode, whether a descriptor was loaded, and the observed authenticated-peer count (unknown when unavailable), without connection candidates or addresses. A relay needs a separate privacy/cost decision and a real mobile-network test; this update does not fix or certify 5G.

Choose **Invite your mates** before sharing to open a private room and chat first. People can join without a video source. When the same saved organiser browser starts sharing, the picture joins their existing room automatically after its group warm-up.

Normal video + chat invitations use a private `#club=…&watch=1` room link. The encrypted club state resolves its current stream; the media still travels directly between peers. Stopping sharing keeps the room, chat and Copy/Share invitation controls open. On the same saved organiser browser, choose **Share a tab again**; existing viewers automatically wait and reconnect to the new source, with its normal group warm-up. Reloading that browser restores its last hosted saved room. Explicit **Leave room** prevents further automatic picture joins. Clearing site data or forgetting the room removes its saved organiser access. Old combined club + magnet links follow the current source when opened with the updated app; raw video-only magnets remain specific to one capture. Keep member invitations private, and never send your organiser link to viewers.

Automatic recovery keeps the normal invitation open while direct peers and tracker discovery reconnect after a network change. A restarted source is resolved through the encrypted room state; a changed network keeps the existing source identity and group clock. Returning to a suspended phone page also refreshes the room and direct discovery. Explicit **Leave room** stops automatic joining. See [automatic reconnection](docs/automatic-reconnection.md) for behavior, test scope and network limits.



## Rehearse with your own laptops

In an open club, expand **Try it together · three-laptop rehearsal**. The organiser chooses the ten-second warm-up and **Create & join rehearsal**. Select and copy its member invitation yourself; each mate joins the club, labels their laptop and chooses **Join current rehearsal**. Once all three sessions are recently seen, the organiser chooses **Start generated picture**. Enrolled viewers join the generated picture automatically. No desktop capture or automatic clipboard access is used.

Repeat with **5-minute match delay** and allow at least six minutes to observe playback. A viewer can choose **Try one supplier reconnect on this viewer** to exercise its own supplying connection. Use **End rehearsal for everyone** and **Download test report** to keep the observations. Reports include decoded frames, advancing playback, drift, stalls and reconnects; remote observations and physical-device labels are self-reported. They cannot independently attest separate hardware or homes. A ten-second warm-up does not prove five-minute playback, protected-stream capture or notification delivery.

## Keep a private test report

On every device, open **Room settings & help → Your test report**. Local logging starts with a room, keeps a bounded five-second history, survives a normal end or reload, and never uploads itself. **Mark now** records a fixed observation such as sound stopping or a picture freeze. **Download test report** saves an offline HTML file; **Send summary to host** sends only a compact snapshot to the existing encrypted help inbox. Download before changing rooms or clearing browser data. See [test evidence, privacy and limits](docs/test-observability.md). Generated rehearsals now last up to two hours from creation. Real 90-minute, separate-device/network acceptance is still required.

## What runs where

The static app and fixture list are public. A small cloud control service stores encrypted club details, chat and the current live invitation, plus the timing and browser subscription metadata needed for reminders. It does not carry or store the video, subscription-service credentials or club decryption keys.

The captured video travels between peers over WebRTC. WebTorrent introduces peers using a tiny encrypted descriptor and a custom extension carrying source-signed video pieces. Each laptop supplies at most two downstream viewers. New rooms carry standard HLS playlists and CMAF H.264/AAC segments in authenticated transport envelopes. An ordinary torrent client cannot join this live transport. See [the standards-based playback architecture](docs/standard-hls.md).

A lost supplier triggers a bounded search for another authenticated supplier of the same cast. The app preserves its shared clock, verified cache and downstream peers. A relay leaving does not impersonate a whole-source shutdown; an explicit source-signed end propagates. If the original capture disappears, saved pieces cannot supply future video. Independent-capture backup switching is a protocol foundation only; see [backup protocol](docs/backup-protocol.md).

Updated peers also detect connections which stay open but stop delivering verified video or control replies. Recovery keeps the room's chosen match time, skips already cached history and retries exhausted searches with bounded backoff. Delivery receipts measure actual acknowledged payload, and a struggling relay stops offering spare slots within the existing two-child ceiling. Connection details show useful verified picture ahead and outgoing delivery; these do not claim maximum internet speed. See [measured delivery and recovery](docs/delivery-recovery.md) for protocol and test details. Refresh before starting a fresh room to use the updated behaviour; older peers remain compatible but do not gain every new measurement/resume feature.

Web Push is optional and best effort. Its generic notification opens a club already saved on that browser; the push contains no invitation key, team name, chat or live stream address. The scheduler checks once per minute; exact-second delivery is not guaranteed. Browser permission, supported push services, operating-system settings and provider availability all matter. Provider acceptance does not prove a device displayed the notification. **Add to calendar** remains available without push; calendar files contain a private member invitation and should be kept private.

## Evidence and limits

A four-context installed-Chrome rehearsal on one Mac used the actual public tracker and decoded synthetic video/audio. Losing a relay's upstream preserved its downstream viewer, clock and cache while it reparented. Closing the relay browser led its child to reattach after about 17.7 seconds, with one measured stall in the ten-second quick-test delay. An explicit signed source end stopped the surviving viewers. A separate actual-source-loss check preserved the viewer session and played only the remaining cached window before pausing.

Those checks do not establish different-home delivery, physical phone support, long-event stability or seamless independent-source switching. Source sharing is intended for computer browsers. Phones and tablets join as viewers; phone screen capture is not an established workflow. Public tracker discovery can fail or take time. There is no TURN media-relay fallback, so some routers, VPNs and firewalls prevent direct connections. Recovery cannot guarantee uninterrupted playback. New rooms use continuous HLS/CMAF; old invitations retain the legacy clip player and its limitations. The delay is cooperative synchronisation, not copy protection.

The control backend has focused local tests for permissions, encrypted-envelope limits, retention, concurrency and reminder scheduling. Local tests, AWS deployment, public browser checks, push-provider acceptance and visible device notification are separate evidence states. Deployment resources and pilot limits are described in [the control-service review](backend/REVIEW.html).

## Run and build

The static app requires Node.js 20 or newer. Install the pinned build and media libraries before building:

```sh
git clone https://github.com/ezzye/same-end.git
cd same-end
npm ci
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

Original code: MIT. WebTorrent: MIT; hls.js: Apache-2.0; Mediabunny: MPL-2.0. Versioned source links and full notices are in [THIRD_PARTY.md](THIRD_PARTY.md), `vendor/` and the delivered app.

Fresh app entry: `/watch.html` avoids the older app-shell cache. Current service workers fetch page navigations from the network and fall back to the fixed cached shell offline; active viewing is never reloaded by this navigation policy.

## Local fixtures helper (desktop Chrome and Edge)

`npm run build` also produces `dist/same-end-local-fixtures.zip` and the standalone `reader-setup.html` guide. The same unpacked Manifest V3 extension works on Mac and Windows. Install the folder through the browser's extensions page in Developer mode; this prototype has no store listing or automatic extension updates. Keep its folder in place.

The user initiates each import or enables following a BBC team once. Followed fixtures refresh directly from BBC monthly pages daily and after browser restart when the last check is at least six hours old; failed reads preserve the last good fixtures. Browser reminders are rescheduled locally. Calendar exports are snapshots and need a new import after changes. BBC monthly fixtures can be fetched directly after a one-time optional BBC permission; supported BBC and LiveSoccerTV match pages can be read with temporary `activeTab` access. The helper only retains whitelisted fixture fields in `chrome.storage.local`, not sync storage. Source HTML is transient. Personal listings appear in a separate Same End panel after explicit connection; they never enter `SameEndFixtures`, the club event API, or `fixtures.json`. Calendar export is one `.ics` batch with stable event IDs, UTC times and alarms. Calendar import and notification display still depend on the recipient's OS/calendar/browser.

`npm test` covers core parsing/calendar and worker state/access/alarm behavior. `node tests/local-reader-browser.test.mjs` uses the bundled local Playwright installation and an isolated Chrome for Testing profile to check the real extension worker, website connection, local persistence, calendar downloads and absence of listing uploads. It does not install into the user's normal browser profile. Physical Windows acceptance, real toolbar permission flow and OS calendar/banner acceptance are separate checks.

`node tests/local-reader-follow-browser.test.mjs` is an opt-in live BBC check using an isolated staging manifest with BBC permission pre-granted. It checks real page parsing, local refresh alarms, a calendar batch and notification API acceptance. It does not claim to test a normal installation permission dialog or an OS notification banner.

## Browser compatibility (0.3)

The source prefers independently completed H.264/AAC MP4 pieces. Standard MediaSource or iPhone ManagedMediaSource is used when supported; a single-video-element complete-clip fallback follows the same signed clock when neither is available or the buffer fails. The fallback can have visible/audible transitions. Viewers do not need MediaRecorder or screen capture. WebM remains supported for existing invitations and sources that cannot encode MP4, but older Apple viewers need a fresh MP4 cast from a capable host. Encoding happens before signing; receivers verify and forward the original bytes.

Engineering targets, subject to actual browser capabilities:

| Device | Watching and chat | Hosting |
| --- | --- | --- |
| iPhone / iPad, iOS or iPadOS 12.2+ candidate | Complete-clip fallback on older versions; MP4, inline video and tap for sound; iPhone 16 / iOS 27.0.1 remains an explicit target | Use a computer to share a tab |
| macOS Big Sur 11.5.2, Safari 14.1+ | MP4 path plus fallbacks for missing browser methods | Chrome/Edge preferred for tab audio; Safari recording depends on available capture/audio |
| Android | Chrome-compatible browser with WebRTC, Web Crypto and MP4 decoding | Use a computer to share a tab |
| Windows | Chrome/Edge-compatible browsers; older machines must still have the required browser features | Chrome/Edge; MP4 recording must be available for older Apple viewers |
| Chromebook / ChromeOS | Chrome with the required media features | Browser-tab capture and audio when offered by Chrome |
| Linux | Chrome, or a browser build with the needed H.264/AAC decoder | Chrome preferred; open-source Chromium builds can have different codec support, and desktop capture depends on the OS |

These are feature targets, not a claim that every OS version was physically tested. Current-engine WebKit/Chromium/Firefox tests and removed-API tests do not reproduce an iPhone, Big Sur installation, Chromebook or Linux desktop. The web build lowers JavaScript to ES2017 and Safari 12.1 / iOS 12.2, Chrome/Edge 80 and Firefox 78 targets. These versions are engineering candidates, not tested minimum-device guarantees. iOS below 12.2, Internet Explorer and legacy Edge are outside this baseline. Use the most recent browser available for the device. Notification options differ independently: iOS/iPadOS web push needs a Home Screen app and a sufficiently recent OS; calendar downloads remain available. The fixtures extension is still for desktop Chrome/Edge, not mobile Safari.

[Device check](https://www.sameend.com/device-check.html) plays an embedded H.264/AAC sample locally and can save a private report. It asks the person to confirm sound; software cannot confirm they heard it. It uploads no report or invitation. Follow a successful sample check with a real private invitation and the 10-second quick test, then the five-minute mode. Test foreground return, sound, chat, full-room view, and supplier reconnect. Keep the page visible and the screen awake. A browser may suspend a background mobile page even when it is installed as a PWA.

`npm run test:media` checks real decoded pieces, clock recovery and cleanup in available browser engines. `npm run test:peers` checks actual source-signed MP4 transfer and automatic magnet joining, with legacy API removal; `SAMEEND_FULL_DELAY=1` selects five minutes and `SAMEEND_REAL_WEBKIT=1` adds a real WebKit viewer. Tests that alias MediaSource as ManagedMediaSource exercise integration only, not Apple's actual implementation. Some tests deliberately permit autoplay; the media matrix separately tests user-gesture playback without that override.

Primary platform references: [WebKit iPhone streaming](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/), [WebKit original MP4 recorder](https://webkit.org/blog/11353/mediarecorder-api/), [WebM on iOS 17.4](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/), [Chromium media muxers](https://chromium.googlesource.com/chromium/src/+/HEAD/media/muxers/README.md), [Chrome screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls), [Chrome versus Chromium codecs](https://www.chromium.org/audio-video/).

## Automatic invitation check (0.3.1)

Opening a club or room invitation starts a local capability check. Room invitations also try a tiny embedded MP4 silently while joining continues. The sample never gates a real cast: browser tap requirements or an inconclusive sample are not treated as incompatible hardware. Actual peer connection, the shared-delay wait and advancing playback are checked separately. A normal five-minute communal wait is not a connection timeout.

If joining or playback fails, **Send report to your host** sends an encrypted check to the organiser’s **Help inbox** inside Same End. The button requires an invitation with club/chat credentials; video-only invitations offer native sharing or copying instead. Failed delivery remains explicit and can be retried with the same report ID. **Share another way**, **Copy report**, and **Save report** remain available. Reports are never sent automatically. **Connection help & report** in Room settings also opens it after successful playback.

Reports contain only fixed status codes, coarse reported browser/OS versions, a public build ID and allowlisted capability/playback booleans. Private invitations, club names, keys, chat, peer IDs, SDP/IP candidates, full browser strings, URLs and raw errors are excluded. Reports remain on the device until explicitly shared. Host-inbox reports use the existing club AES-GCM encryption with report-ID-bound additional data and a separate reports endpoint; they never enter group chat. The server accepts the member token for submission and only the organiser write token for retrieval. Reports expire after 24 hours and are capped at 30 per club (five submissions per IP per minute and 30 per club per day). The host validates the allowlist again before rendering. The check does not ask for camera, microphone, capture or notification permission and cannot establish that someone heard sound from speakers. Automated current-engine checks remain separate from physical-device acceptance.


## Legacy browser checks (0.3.2)

The compatibility layer covers missing byte converters, secure random UUIDs, plain-data cloning, `globalThis`, microtasks, Blob/File reads, `replaceAll`, `flatMap`, `fromEntries`, `hasOwn` and child replacement. It never substitutes insecure encryption or randomness. The memory-only torrent path does not require `WritableStream` or origin-private file-system access. Basic layout fallbacks cover browsers without `clamp`, `inset` or `aspect-ratio`.

`npm run test:legacy-apis` runs real Blob/File reading and ECDSA/AES-GCM round trips in current Chromium and WebKit with native APIs deleted. `npm run test:host-reports` checks encrypted member-to-host delivery, failure/retry and private access with an isolated backend. `npm run test:peers` removes the newer APIs during an actual signed MP4 peer transfer. These are regression checks, not physical old-device certification. [WebKit’s Safari 12.1 announcement](https://webkit.org/blog/8672/on-the-road-to-webrtc-1-0-including-vp8/) and its [historical iOS data-channel report](https://bugs.webkit.org/show_bug.cgi?id=189503) inform the conservative Apple candidate floor.
