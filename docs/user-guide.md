# Using Same End

[Project overview](../README.md) · [Open Same End](https://www.sameend.com/watch.html)

## Start a room

On a capable computer choose **Share a tab**, select authorized material and include tab audio when offered. Keep the source playing and unmuted. Chrome may keep a shared source quiet locally while still capturing its sound. Watch the Same End player for the group’s delayed picture.

Choose **Invite your mates** and send the normal picture + chat invitation privately. You can invite mates and chat before sharing. If necessary choose **Retry video + chat invitation**; the video-only alternative is a separate explicit choice. Viewers may need **Turn my sound on**, which affects their own listening. The host’s source-silence warning checks a different part of the path. **Full room** keeps chat available beside/below the picture.

While the room prepares, the host can check the selected tab in the muted **Live source preview**. The room shows a countdown once its start is scheduled. If playback pauses to rebuild its buffer, a small status below the picture shows progress when available.

New shares can choose 30–120 seconds of common delay after enough fresh observations; otherwise they keep five minutes. An interrupted viewer can add up to 60 seconds of local delay. Chat stays immediate. Read [measured start](measured-common-start.md), [buffering](adaptive-playback.md) and [sound](source-audio.md).

For the advanced video-only file workflow, open **Room settings & help → Connect using a file instead** on a connected computer. **Make invitation file** prepares a connection; **Save invitation file** saves it. Your friend opens and accepts the file, saves a reply, and returns it for you to open and accept. If a file is already waiting for a reply, **Show invitation file** reopens it without making another connection. **Cancel pending invitation** releases that unused connection. Progress, errors and reasons that a new invitation is unavailable appear beside the button.

## Save a club and plan a match

1. Choose **Create your club**, name it and pick its colours. Save it on this browser.
2. Send the member invitation privately. Mates choose **Join & save club**. Keep your organiser link private: it can edit the club and diary.
3. Use **Plan a match** for a starter fixture or manual entry. Times use London time, with GMT/BST handling and an optional local display.
4. Choose **Add to calendar**, or enable optional reminders on each browser. Calendar exports are snapshots: replace old entries after changes.
5. Chat before kick-off and choose **Join live** when sharing is ready.

The starter fixture list is small and dated, not a complete live feed. Check linked sources for changes. Reminders are best effort: provider acceptance does not prove that a device displayed one.

The normal picture + chat invitation belongs to the saved room and can follow sharing restarts from its saved organiser browser. Stopping video keeps room/chat context; **Share a tab again** starts a new source and warm-up. Explicit **Leave room** stops automatic joining. Clearing browser data can remove organiser access. Raw video-only magnets remain capture-specific. See [reconnection](automatic-reconnection.md).

## Install and check devices

Installation is optional. **Install** opens an available Android prompt or guidance. In iPhone/iPad Safari use Share → Add to Home Screen → Add. Keep the original private invitation: the installed start page does not include its key.

Phones/tablets watch and chat; computers host. Keep pages visible and devices awake: installing a PWA does not prevent suspension. The offline shell does not supply live chat or incoming video.

Start with [Device check](https://www.sameend.com/device-check.html), then test a real invitation. A local sample, modern browser engine or phone-sized viewport does not certify physical old devices, audible sound or different-home connectivity. Current requirements are in [HLS compatibility](standard-hls.md#compatibility-boundaries). Older invitations can retain a legacy clip player.

## Rehearse and save observations

In a club expand **Try it together · three-laptop rehearsal**. The organiser creates a rehearsal and privately shares its member invitation. Once enrolled viewers are present, start the generated picture. Begin with the ten-second warm-up, then repeat the five-minute mode. This requires no desktop capture.

On each device open **Room settings & help → Your test report**, mark problems and download before changing rooms or clearing data. Logging is bounded/local and never uploads itself. **Send summary to host** deliberately sends a compact observation through the encrypted help inbox. See [test privacy/limits](test-observability.md) and the [standalone guide](../test-guide.html).

Labels and remote observations are self-reported. A rehearsal cannot independently prove separate hardware, protected-source capture, notification display or a 90-minute match. Public bugs need a redacted summary, not private invitations or personal reports.

## Forum and privacy choices

The public fan forum is separate from private rooms. Guests can read; posting/replies/likes need a verified account, pilot code and rules acceptance. Private rooms need no account. **Send feedback** goes privately to support. See [pilot accounts](pilot-accounts.md).

**Privacy choices** in the footer controls optional analytics. Declining leaves room/chat usable. Counts measure actions, not unique people. Saved access/settings use browser storage; hosted sign-in can use separate cookies. Read [PRIVACY.md](../PRIVACY.md).

Invitations can be forwarded. **Forget club on this browser** removes local access only. There is no individual revocation list; replace club access by creating a new club and inviting the intended people.

## Optional desktop fixtures helper

The Chrome/Edge helper imports supported fixture pages and can follow a BBC team after explicit permission. It keeps normalized fixtures/reminders locally, without browser sync or Same End listing uploads. Personal listings stay separate from the shared diary. Refresh calendar exports after fixture changes.

`npm run build` creates `dist/same-end-local-fixtures.zip` and `dist/reader-setup.html`. Read that setup guide before using the unpacked Developer-mode extension; it has no store listing or automatic updates. Permission prompts, OS notifications and calendar behavior need their own device checks.
