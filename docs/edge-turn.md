# Edge-only TURN preparation and continuous capacity health

This is a preparation package for an operator-designated edge host. No TURN host has been selected or deployed. It does not install coturn, open ports, change a firewall, create DNS, or turn on a cloud media relay. Keep the TURN secret in a protected environment or secret manager; never commit it to the app, client bundle, sample config, or logs.

## How it fits

The coordinator issues short-lived, expiring TURN REST credentials only when an operator has configured the edge URLs and shared secret and a fresh edge-health report says `healthy`. The contract is `createEdgeTurnCredentials({urls, secret, nowMs, ttlSeconds})`, returning `{iceServers, expiresAt}`. With no URLs or secret it returns an empty `iceServers` list. Usernames contain an expiry timestamp and random nonce; the credential is HMAC-SHA1 over that username, encoded as base64, as coturn's TURN REST authentication expects. TTL is limited to 60–3600 seconds. TURN URLs must use `turn:` or `turns:` with a host and cannot contain username/password authentication.

The edge agent sends only allowlisted host measurements and state metadata to `POST /v1/edge-health`; it never sends media, user identity, room identifiers, TURN credentials, or coturn secrets. The signature is HMAC-SHA256 in lowercase hex over the exact UTF-8 body bytes prefixed by `<x-edge-timestamp>.`. The timestamp is Unix milliseconds, must equal the JSON `sampledAtMs`, and must be fresh. The coordinator persists the latest report with conditional writes and rejects a timestamp that does not advance. The report expires after `reportTtlMs` (15 seconds by default).

A report is `healthy` only when CPU, available memory, outbound rate, coturn allocation count, and administrator-declared uplink and allocation budgets are all known and within configured headroom. A known threshold breach is `constrained`; missing required readings or an unconfigured capacity budget is `unknown`; an expired report is `stale`. All states except `healthy` deny new ICE credentials/admission. Existing allocations are not terminated. A previously issued credential may remain valid until expiry and can potentially be reused, so coordinator admission gating alone does not guarantee that no new allocation is made during that window.

## Continuous host agent

`edge-turn/config.example.json` is a template. Copy it to a private operator-managed location, select actual budget values from measured or declared provider capacity, and set `reportUrl` only after the coordinator endpoint is deployed. Set `EDGE_TURN_HEALTH_SECRET` in the agent's protected environment; it must match the coordinator's `EDGE_TURN_HEALTH_SECRET`. The config contains no secret by design. Supply coturn's separate TURN REST shared secret using a protected runtime config/database mechanism; coturn does not expand arbitrary environment variables in its sample config.

Use Node.js 20 or later. The agent has no install step and takes no action without an explicit config path:

```sh
node edge-turn/agent.mjs --selftest
node edge-turn/agent.mjs --config /secure/path/edge-turn.json --once --dry-run
node edge-turn/agent.mjs --config /secure/path/edge-turn.json --serve
```

`--selftest` is local and network-free. `--once --dry-run` samples once and prints a bounded report without sending it. `--serve` remains in the foreground and samples in a serial loop at the configured interval (1–60 seconds), so slow samples cannot overlap. It provides an allowlisted local-only `GET /health` endpoint bound to `127.0.0.1` and posts a fresh signed heartbeat each cycle when `reportUrl` is set. Configure `reportUrl` and `EDGE_TURN_HEALTH_SECRET` together; without them, there is no remote heartbeat and the coordinator eventually marks the edge report stale and denies new ICE credentials. If a scrape or POST fails, the process keeps sampling and retrying; its local health changes to `unknown` and `allowNew:false`. Repeated identical failures are logged once until recovery. The report TTL must exceed the sample interval by at least five seconds; the example uses a 5-second interval and 15-second TTL. The body carries a new sample timestamp each cycle, and the coordinator rejects stale or replayed signatures. The endpoint omits host names, interface names, raw coturn output, and secrets.

For later use on a selected Linux host, `edge-turn/edge-turn-agent.service.example` is a systemd supervision template. Adapt and review it on that host; it is not installed or enabled here. Configure automatic restart after process failure and monitor the service plus coordinator health state. Keep the host agent and coturn Prometheus exporter on loopback/private access. Do not treat an active systemd process alone as a healthy report.

The sampler uses Node's CPU counters and reads Linux `MemAvailable` from `/proc/meminfo`. Memory pressure is deliberately `unknown` outside Linux, where this agent has no platform-native pressure API. It reads `/proc/net/dev` for aggregate outbound byte deltas on Linux; stacked interfaces can double-count traffic, making this a conservative host estimate. Network rate is deliberately `unknown` on macOS and other platforms without a supported sampler. The first CPU and network samples are unknown because a rate needs a prior sample. It does not run speed tests. Coturn metrics are fetched from the configured local URL with a 1.2 second timeout.

## Operator limits and overload behavior

Set `uplinkBudgetMbps` from an administrator measured or provider declared sustained egress capacity. The monitor constrains new admission at `uplinkBudgetMbps * uplinkHeadroomRatio` (80% by default) using the sampled current outbound rate. No active speed test is run. This rate is host-wide Linux interface accounting and can overcount stacked interfaces; unknown readings fail closed. Set `allocationLimit` to the configured total coturn allocation quota. New admission becomes constrained at its configured headroom (90% by default), while coturn `total-quota` and `user-quota` remain the server-side allocation limits. CPU busy at or above 90% and available memory at or below 10% also constrain new admission. Tune these thresholds only after the selected host has been measured under representative TURN traffic.

When reports become unknown, constrained, or stale, the coordinator withholds new edge ICE credentials. Direct peer reservations remain independent. This does not instantly revoke already-issued credentials, cancel authenticated allocations, or disconnect sessions. Short credential TTLs narrow the admission window; coturn allocation quotas and `bps-capacity` / `max-bps` are needed to cap allocations and bandwidth at the server. A static quota is the actual overload safety boundary while an issued credential remains usable.

## Coturn configuration boundary

`edge-turn/turnserver.conf.example` lists preparation directives only. It leaves ports, TLS files, and limits commented out, and includes no real domain or secret. Choose limits only after a real operator has selected the host and confirmed provider/network capacity. Coturn's `user-quota`, `total-quota`, `max-bps`, and `bps-capacity` are server-side controls and are the enforcement boundary for valid credentials that remain usable. The policy monitor is an admission signal; it does not dynamically rewrite coturn limits or terminate sessions.

When available, the monitor reads coturn's named `turn_total_allocations{type="..."}` gauge. It sums that exact gauge across types and does not guess other metric names. If coturn metrics are disabled/unavailable or the gauge is absent, allocation capacity is unknown, so new admission is denied. Current coturn documentation says Prometheus can be enabled with `--prometheus` and defaults to port 9641; bind the exporter to loopback or otherwise restrict access. See the [coturn Prometheus documentation](https://github.com/coturn/coturn/blob/master/docs/Prometheus.md), [coturn metrics source](https://github.com/coturn/coturn/blob/master/src/apps/relay/prom_server.c), and [coturn server options](https://github.com/coturn/coturn/wiki/turnserver) for the metric and quota/bandwidth semantics.

## Current evidence and limits

The credential helper, input validation, metrics parser, policy, and local agent self-test are testable in this checkout. No edge machine has been chosen, no operator capacity has been measured or declared, and no network reachability, coturn startup, TURN allocation, cross-home traversal, or real device call has been verified. Treat this as prepared software and configuration guidance, not an operational relay or capacity certification. The existing product remains peer-to-peer media by default; TURN is an explicitly configured fallback path.
