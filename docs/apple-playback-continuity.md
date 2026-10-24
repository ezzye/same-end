# Apple playback continuity

Same End sends signed, independently recorded MP4 pieces between peers. A large
verified reserve proves delivery, not successful continuous decoding.

Three independent playback problems need different treatment:

1. Repeated clock corrections can keep an Apple decoder seeking instead of
   presenting frames. Frame-clock observations, a bounded seek policy and the
   existing 750 ms deadband address that loop.
2. Native compatibility playback replaces a local MP4 periodically. Replacing
   the source can briefly interrupt both picture and sound, even with all bytes
   already on the device. This remains a limit on browsers without a usable
   streaming-buffer API.
3. Capture can change H.264 colour signalling within a piece. A controlled
   iPhone 16 / iOS 27.0 simulator test failed at such a transition, with all media
   fetched before playback. Correcting only a timestamp overlap did not cure it.
   A colour-only diagnostic counterfactual did; relabelling colour metadata is
   **not** a safe production fix.

## Capture and playback contract

`capture-normalize.js` converts actual source pixels into fixed 1280×720 sRGB
RGBA frames before MediaRecorder encodes and signs them. It preserves audio
track identity, letterboxes changes in shape, and caps frame delivery at 25 fps
with a small timestamp jitter allowance. It uses native frame delivery and
backpressure rather than animation timers. Unsupported APIs retain the original
capture path and explicitly report `pixelNormalization: unsupported`.

For Apple streaming playback, `native-mp4.js` produces bounded playback copies
with stable track IDs and fragment times. `media-player.js` starts a late join
near zero in its local decoder, while mapping it back to the original programme
clock. Signed cache bytes, peer forwarding and the group delay remain unchanged.
Other browser decoders keep their established append path.

Diagnostics distinguish source pixel normalization, source sound, verified
reserve, selected streaming API, playback normalization, decoder errors, seeks
and source replacements. They do not include source pixels or private links.

## Reproduce the generated-media checks

Browser checks require local Chrome and Playwright/WebKit. The browser tests
also accept `SAMEEND_PLAYWRIGHT` for an existing Playwright module.

```sh
npm run build
npm test
npm run test:capture-normalization
FIXTURES=privatework/capture-normalize-test SCENARIOS=chromium-mse,webkit-mse DURATION=180 START_AT=31.8 node tests/apple-clock-browser.test.mjs
npm run test:host-playback
npm run test:alternate-player
```

Fixtures are generated locally under ignored `privatework/`. The capture test
checks actual limited/full-range pixel conversion, resize/crop/rotation, cleanup,
failure, timing jitter, audio identity and stable H.264 configuration through
twelve independent recordings. The continuous-player test fails on silent
fallback, source replacement, large frame gaps or departure from the group clock.

## Support boundary

API availability is not device acceptance. iPhone Managed Media Source arrived
with Safari 17.1; iPad gained Media Source Extensions with Safari 13 and Managed
Media Source with Safari 17. Older native-file paths can still have boundary
pauses. This work does not certify every old OS, hardware decoder, browser,
network or broadcaster player.

The verified iOS 27.0 result is an official simulator picture/clock test, not a
physical iPhone speaker test. Desktop decoded-audio checks are separate. A fresh
host share in an updated supporting browser is needed to use source pixel
normalization; an already running host cannot acquire it from a viewer reload.

References: [WebKit Safari 17.1](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/),
[WebKit Safari 13](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/),
[MP4 byte-stream rules](https://www.w3.org/TR/mse-byte-stream-format-isobmff/),
[WebCodecs pixel conversion](https://www.w3.org/TR/webcodecs/).
