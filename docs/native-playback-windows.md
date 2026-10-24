# Buffered native playback and picture diagnostics

Native compatibility playback can assemble matching, verified MP4 pieces into a local presentation of up to 16 seconds. It uses one video element, preserving that element's sound permission. Signed source pieces, their hashes, forwarding and the group clock stay unchanged.

The bounded parser requires fragmented H.264/AAC MP4 with moof-relative data offsets, valid sample ranges and decode times, no edit lists or composition offsets, and matching sample descriptions and timescales. It remaps changing track IDs, preserves all fragments, rebases timestamps onto source time, updates movie/track durations and omits stale indexes. Configuration changes, missing sequences and unsupported structures end a window; individual-file playback remains available. A joined-window decode error disables joining for that player and retries the original pieces. Larger windows reduce source replacements; they do not guarantee seamless transitions on every native player.

Native mode stages up to 22 seconds ahead from the already verified cache. Playback owns at most 24 pieces / 20 MiB plus one bounded window. Old windows and URLs are released. The encoded picture is not transcoded. Small capture gaps retain their source-clock position; the player bridges only already-buffered gaps of at most 150 ms.

## Diagnostics

Reports retain allowlisted capture settings, actual media bitrate (including audio/container), capture age/recording latency, whether the required piece is verified and its arrival lead, playable reserve, player mode, decoded dimensions/frame counts, native source changes and startup readiness timing. Capture measurements exist only on the source device. There is no raw content, URL, invitation, chat text, peer address, key or error string in the additional metrics.

Assessment is evidence, not a root-cause verdict. Missing required pieces after warmup indicate delivery trouble. A present piece with poor readiness indicates startup/decode readiness trouble. No frame growth while an active target advances indicates a playback stall only across comparable visible/unpaused/unblocked samples without a source replacement. Source capture that stops producing pieces is distinguished from a viewer's missing data. Low bitrate/resolution alone is not called a fault. The existing explicit Send summary to host path includes the new sanitized facts; automatic uploading is not introduced.

## Acceptance state, 24 October 2026

- Fully fetched generated 720p25 MP4/AAC, forced compatibility mode on local Chrome: 3 source replacements over 20 seconds versus 11 for the original per-piece control. Both had advancing video and decoded tone. Largest measured window-playback frame gap was about 98 ms; programme drift stayed below 0.25 seconds in that run.
- Local WebKit diagnostic comparison: 3 versus 11 replacements, but low frame callback cadence and zero analyser sound in both modes. This is not an Apple playback pass. Diagnostic mode never labels these disabled gates as passed.
- Authentication retry succeeded (HTTP200, freeAutomate plan); earlier401 came from an incorrectly captured username. Physical iPad Pro12.9(2020), iOS14:273 samples, all12pieces loaded before playback, media error4 in joined and original-piece fallback, no decoded picture/tone. This is a failed native-path acceptance result. A known-good nativeMP4 control is needed to isolate container/codec versus blob playback. No paid plan was purchased.
- Deployment must remain held until the older Apple picture/sound check is resolved. Full-match, actual family device/network acceptance and human-audible sound are separate from local engine checks.

Run `npm run test:native-window`. It generates synthetic media, fetches every piece before playout, forces native compatibility and compares the new path with the individual-piece control. `SAMEEND_NATIVE_REUSE=1` reuses the generated local manifest; `SAMEEND_NATIVE_ENGINES=webkit` selects an engine. `SAMEEND_NATIVE_DIAGNOSTIC=1` records failed gate evidence without claiming acceptance. Do not use that mode as the release gate.
