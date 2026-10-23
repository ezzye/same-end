# Private test evidence

Normal casts and generated rehearsals now have a **Room settings & help → Your test report** panel. Recording is on by default and can be switched off or deleted. It observes the existing cast snapshot and player; it never seeks, changes the shared clock, captures a microphone, or sends telemetry automatically.

## Evidence collected

- Actual mapped programme position and group target, drift, clock readiness/offset and verified contiguous reserve.
- Recovery states, coded watchdog reasons, attempts, supplier-change count, decoded frame count and playback stalls.
- Aggregate acknowledged downstream delivery (null until measured), pending acknowledgement age/bytes, congestion count, forwarding count and queues. These are delivery observations, not maximum broadband speed estimates.
- Source signal state, listener mute/volume, player readiness/paused/blocked state, document visibility, online flag, control-service failures and chat-message count. These do not prove audible output, readable picture or chat receipt.
- Fixed manual observations (picture, sound, chat, freeze, silence, sync issue, relay departure, network change) and generic error categories, without raw errors/stacks.

One browser report is not a room-wide trace. Device clocks can differ; compare mapped positions/targets and observations with the same hashed test code, allowing for sample times. Remote rehearsal statuses are sparse, self-reported summaries. Full individual reports are needed for a detailed investigation.

## Limits and persistence

The in-memory collector keeps at most 1,440 samples at five-second intervals and 200 events. Storage is bounded to 2 MiB shared between the active and previous report, removing previous-report samples first and counting dropped entries. Unit clock tests retain all 1,081 samples of a simulated 90-minute session; this is not a physical 90-minute media run. Storage failure is visible; the in-memory report can still be downloaded. Private mode, browser cleanup or quota pressure can remove saved evidence.

Normal end keeps the finished report. Reload restores the latest saved report as interrupted rather than claiming a clean finish. At most the unsaved interval (normally five seconds; longer if the browser suspends) can be missing. Starting another room replaces the displayed report; download before switching rooms. Storage retains one previous report for bounded recovery, not a browsable archive. Switching logging back on within a running cast starts a new report.

No invitations, keys, peer/node identifiers, IP addresses, URLs, names, programme content, audio recordings or chat text are exported. A truncated SHA-256 cast tag correlates reports; it cannot join a cast. Browser/OS versions in the downloaded report and existing host check remain identifying metadata: share privately. Reports remain accessible to scripts on the same origin and are not a secret vault.

## Explicit sharing

**Download test report** creates a self-contained offline HTML report, with Save HTML and Share file/download fallback. Measurements JSON is optional. The full history stays local unless the tester shares that file.

**Send summary to host** uses the existing encrypted help-inbox route only on an explicit click. The additional summary is allowlisted and at most 4 KiB: report/test codes, last status, counters and latest 12 events. It excludes sample history. The API's existing 12 KiB envelope limit, organiser-only inbox and 24-hour expiry remain. Failed retries reuse an id/envelope; a new send after acknowledgement gets a fresh id and fresh data. The inbox is not an indefinite archive.

## Rehearsal corrections

The generated rehearsal lasts up to two hours from creation, rather than 45 minutes. Local rehearsal history samples every five seconds and keeps up to two hours. Measurements use mapped programme time across compatibility-clip resets. A failed start now saves the failed phase before finalizing its report.

## Test still required

Use separate physical devices and networks, including the oldest intended browser. Run the five-minute match delay for 90 minutes, confirm picture/sound/chat manually, and test late join, an actual forwarding viewer leaving, a temporary connection interruption, and sleep/return. Confirm another route has capacity; if all capacity or the source disappears the app cannot invent missing media. During a long suspension playback may pause and later rejoin the current group moment; this is different from seamless buffered relay recovery.

Pass criteria must be recorded per scenario, with report files from each affected device. Test notification delivery separately. Adaptive fan-out above two children, warm standby, explicit missing-range repair, per-viewer quality, background audio, live delay changes and independently captured source failover remain later work.
