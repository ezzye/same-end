# Same End social control API v1

Video stays peer-to-peer. The control API carries club metadata, encrypted state/chat and Web Push subscriptions; no video or provider credentials.

## Browser secrets

`clubId` is a UUID. `clubSecret` and `ownerSecret` are independent 32 random bytes, encoded base64url. Invitation fragment: `#club=<id>.<clubSecret>`. Owner link additionally has `&owner=<ownerSecret>`. Remove fragments before network activity; deliberately saved club keys belong in browser IndexedDB, with a Forget action. Never publish real invitations in source, logs or screenshots.

Read token = base64url HMAC-SHA256(raw clubSecret, UTF8(`sameend/read/v1/`+id)). Write token = base64url HMAC-SHA256(raw ownerSecret, UTF8(`sameend/write/v1/`+id)). API stores lowercase hex SHA256(UTF8 token), never the raw club/owner secret. Authorization: Bearer token. Write token may also read.

Encrypted envelope `{v:1,iv:<12-byte base64url>,data:<base64url AES-GCM ciphertext+tag>}`. AES key is raw clubSecret. State additionalData `sameend/state/v1/<clubId>`; message additionalData `sameend/message/v1/<clubId>/<messageId>`.

## Endpoints

All endpoints below under `/v1`. JSON, finite sizes, no cookies, no credentials in URLs. Backend returns errors as `{error:<friendly message>,code:<stable code>}`.

- `GET /config`: `{vapidPublicKey,serverTime,pushEnabled}`.
- `POST /clubs`: unauthenticated, tightly rate-limited creation. `{id,readTokenHash,writeTokenHash,state:<envelope>,events:[{id,startsAt,notifyAt}]}`. Hashes are 64 lowercase hex. Returns `{id,version:1,updatedAt}`.
- `GET /clubs/:id`: read/write bearer. Returns `{id,version,state,events,updatedAt}`. Never token hashes.
- `PUT /clubs/:id`: owner bearer only, `{expectedVersion,state,events}`. Conflict HTTP409; return new version. Events expose only opaque event IDs and numeric UTC epoch milliseconds. Titles/details are in encrypted state. Max30 events, startsAt within365days, notifyAt within24h before startsAt. Use empty events to clear schedules.
- `GET /clubs/:id/messages?after=<opaqueCursor>`: read bearer. `{messages:[{id,payload:<envelope>,receivedAt,cursor}],cursor}`. Last100, server timestamps/order; short TTL/retention, bounded input. `after` is server cursor, not client clock.
- `POST /clubs/:id/messages`: read bearer, `{id:<UUID>,payload:<envelope>}`. Idempotent per ID. Returns `{id,receivedAt,cursor}`. Maxciphertext12KiB, max2000 decoded text chars enforced client side; backend bounds envelopes. Rate-limit member posting.
- `POST /clubs/:id/subscriptions`: read bearer, `{subscription:<standard PushSubscription>,clientId:<UUID>,eventIds:[<UUID>]}`. Returns `{id}` opaque subscription ID. Validate push endpoint known HTTPS push-service hosts, keys and bounded lengths. Backend derives storage ID from endpoint; scoped to club. Never return subscription keys to other members.
- `DELETE /clubs/:id/subscriptions`: read bearer, `{id}` (previous result). Remove only that club subscription.
- `POST /clubs/:id/reminders/test`: read bearer, `{subscriptionId}`. Generic test push; rate-limited. Sender only sends to a registered subscription belonging to this club.

WebPush payload generic `{title:'Your mates are gathering',body:'Open Same End for your private match room.',clubId,eventId?,url:'https://www.sameend.com/#openclub='+clubId}`. Backend never needs the club key or active magnet. Notification click loads a locally saved club via ID. No invitation key in notification payload or URL. Reminder scheduler once/minute; delivery is best effort, client permission required, prune410 responses. Health/config must honestly indicate if push is disabled.

## Encrypted client state

`{schema:1,name,theme:'terrace'|'red'|'night',description,createdAt,events:[{id,title,home,away,competition,startsAt,notifyAt,sourceUrl?,status:'scheduled'|'live'|'ended'}],live:{magnet,startedAt,eventId?,expiresAt}?}`. Members can read; owner edits. Owner publishes fresh live magnet into encrypted state after starting cast and removes it on explicit end. No permanent media history. Local watch times use Europe/London (GMT/BST), with optional browser-local time.

Chat payload `{kind:'chat',name,text,clientId,createdAt}`. Reserved encrypted rehearsal payloads use `kind:'rehearsal'` and must not render as human chat. Display textContent only. Names are self-chosen, not verified identities. Poll every2s while visible (back off when hidden/errors); abort on leaving. Keep chat bounded200 entries.

## Local integration / deployment

Public runtime `window.SameEndConfig={apiBase:<HTTPS API origin, no trailing slash>,buildId:<commit>}` embedded by build. In localhost development, use same-origin `/api` proxy to backend local server, allowing browser API paths `/api/v1/...`. Backend local server defaults8795. Node app server default8792.

Persist secrets/config only in backend private deploy state outside the public repository; public deploy config contains only apiBase. AWS region defaults current configured eu-west-1. Serverless Lambda + HTTP API + DynamoDB TTL + minute EventBridge job; no always-on media host. Do not deploy until root integration reviews endpoints/privacy. Runtime deployment and actual WebPush delivery are separate verification states.
