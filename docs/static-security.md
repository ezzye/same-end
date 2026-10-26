# Static page security policy

`build-pwa.mjs` puts a Content-Security-Policy meta element before scripts in
`index.html`, `watch.html`, `manage.html` and `fan-signin.html`. Inline scripts use
SHA-256 hashes calculated after the final JavaScript transforms. The hashes also
cover the inert WebTorrent, magnet and capture bundles that are activated later.
New inline scripts, inline event handlers and string evaluation are excluded.
Changes to script bytes require a rebuild; tests verify the exact emitted hashes.

The policy blocks plugins, document base changes and child frames. Styles retain
inline support. Workers and media use the same origin or blob URLs, with
`child-src` retaining the worker fallback used by older browsers. Connections
allow the same origin, HTTPS and secure WebSockets for the configured API,
Cognito and peer introduction services. This is not an HTTPS/WSS egress allowlist.
Only an explicit `SAME_END_LOCAL=1` build adds HTTP/WebSocket loopback allowances;
this changes connection policy, not authentication.

The policy stays in downloaded standalone HTML. Isolated Chromium and WebKit
checks verify normal page startup, delayed engine activation, script/handler/eval
blocking, saving and offline reopening. These local checks do not establish
physical-device acceptance.

## Hosting requirements

A meta policy cannot enforce `frame-ancestors`. The static host must send
`Content-Security-Policy: frame-ancestors 'none'` as an HTTP response header
(or an equivalent enforced host policy), with `X-Frame-Options: DENY` where
legacy-browser coverage is required. No frame-busting script is used. The build
does not configure those hosting headers, and the local checks do not confirm
that they are present in production. The host should also retain its HTTP
`Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` responses.
