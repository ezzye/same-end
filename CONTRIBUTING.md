# Contributing to Same End

Help can be code, documentation, accessibility fixes, reproducible bug reports or careful device/network observations.

## Start with a small, useful change

Read the [README](README.md) and [HLS architecture](docs/standard-hls.md), then check [issues](https://github.com/ezzye/same-end/issues) and [open PRs](https://github.com/ezzye/same-end/pulls). Discuss large changes in an issue first. Small documentation fixes can go straight to a pull request.

Keep the product focused on private, small-group viewing. Direct P2P media is a project constraint: do not silently add TURN/cloud video relays, public room discovery or default telemetry. Existing analytics require explicit opt-in; changes need a specific purpose, updated disclosure and consent checks. Use authorized media. Do not add DRM circumvention or access-control bypass instructions.

## Set up a development copy

Fork on GitHub, clone your fork, and create a branch:

```sh
git clone https://github.com/YOUR_USERNAME/same-end.git
cd same-end
git switch -c fix/describe-the-change
npm ci
npm ci --prefix backend --ignore-scripts
SAME_END_LOCAL=1 npm run build
npm start
```

Use Node.js 22+ (CI uses 24). Open http://localhost:8792/. Run `npm start --prefix backend` in a second terminal from the repository root for clubs/chat. Data resets when the local service stops. The local build flag selects the local API; an ordinary build uses public configuration. Rebuild after edits.

`npm run review:community` starts an isolated community/staff fixture. Follow its instructions and keep the generated credential private. It has no production authority. Local development requires no production account or AWS credentials.

## Choose the checks for your change

Run `npm run build` and `npm test` before a code PR. Match additional checks to the behavior changed; a documentation edit does not need every long media suite.

| Area | Entry points | Focused checks |
| --- | --- | --- |
| Capture | `hls-capture.js`, `capture-normalize.js` | `npm run test:hls-capture` |
| Envelopes and players | `hls-protocol.js`, `hls-player.js`, `hls-sw-handler.js` | `npm test`, `npm run test:hls-produced`, `npm run test:hls-native` |
| Timing and buffering | `common-start.js`, `adaptive-playout.js` | `npm run test:common-start`, `npm run test:adaptive-playback` |
| Recovery and invitations | `engine.js`, `delivery-health.js`, `social.js` | `npm run test:recovery`, `npm run test:automatic-reconnection` |
| Clubs, forum and backend | `backend/`, `community.js` | `npm test --prefix backend`, `npm run test:community` |
| Layout and installation | `app.html`, `brand.css`, `install.js` | `npm run test:layout`, `npm run test:install` |
| Privacy and access | `analytics-core.js`, `privacy.js`, `backend/` | `npm run test:privacy`, `npm run test:alpha-security` |
| Documentation | `README.md`, `docs/` | Relative links, commands, diagrams and desktop/mobile rendering |

Browser harnesses use isolated profiles. Most support `SAMEEND_PLAYWRIGHT` for the path to `playwright/index.mjs` and `CHROME_PATH` for a Chrome executable. Defaults reflect the maintainer’s Mac setup: inspect your selected test’s imports on other systems, install its Playwright browser engines, and set paths as needed. Capture checks also need ffmpeg. [HLS test notes](docs/standard-hls.md#reproduce-the-checks) explain the scenarios; some wait five minutes. Browser checks can contact introduction services even with generated media.

Local tests do not establish physical-device, different-home, audible-speaker or full-match acceptance. State what you observed, and distinguish a removed-API or emulated-viewport test from an actual old device.

## Report a reproducible bug

Use the [bug form](https://github.com/ezzye/same-end/issues/new/choose). Include steps, expected/actual behavior, app build if known, browser/OS versions, host/viewer role and a coarse network description. Say whether there were separate physical devices and networks; mention the displayed delay and generated or captured source.

**Room settings & help → Your test report** lets you mark and save observations. Review reports before sharing. Public issues should contain a redacted summary. For a security concern, use in-app **Send feedback** to request a private security contact without publishing exploit details or sending credentials in the first message.

## Open a pull request

1. Keep one coherent change per PR. Explain the user problem and resulting behavior.
2. Add a meaningful regression check for a behavior fix where appropriate.
3. Update the relevant guide when behavior, setup or privacy changes.
4. List checks, results and limits. Add redacted screenshots for UI changes.
5. Push your branch, open a PR against `main`, and address checks/review feedback.

Inspect the diff for credentials, private invitations, personal data, local machine paths, captured private media, build output and downloaded runtimes. Do not commit `.env` files, real cast links, deployment state or generated `dist/`. Keep third-party notices beside vendored code and update [THIRD_PARTY.md](THIRD_PARTY.md) when dependencies change.

Treat people respectfully. Make feedback specific and explain your reasoning. Maintainers review against the private-group scope, security/privacy boundaries, reproducible evidence and maintenance cost.
