# Privacy

Same End is owned by **Unsigned Media Ltd**.

Same End is designed for small groups with private invitations. It has no public room directory. Optional first-party analytics are off unless a visitor opts in. The static website and source code are public. Clubs and chat use a separate control service; video travels between the group's peers.

## Browser storage and optional analytics

The core room/chat app does not set cookies. It uses browser storage for saved access and settings, and an offline app-shell cache. Account sign-in is separate: the hosted sign-in provider may retain a session cookie. Declining optional analytics does not block rooms, chat or account features.

The **Privacy choices** banner offers equally prominent **Allow analytics** and **No thanks** controls. No analytics request is sent until a valid opt-in is present. The browser stores this purpose-specific choice for 180 days; an expired, missing or unavailable choice keeps analytics off. The same **Privacy choices** control lets a visitor withdraw or change it. Withdrawal stops new requests in open tabs; already delivered daily totals cannot be attributed back to a visitor and removed individually. If a browser cannot save the choice, analytics stay off.

With permission, the app sends only a fixed event name: page load, successful sharing start, or room-invitation copy. There are no visitor IDs, per-person histories, names, room/club identifiers, invitations, source URLs, query strings, fragments, chat, account tokens, referrers or device details in the analytics payload. Saved file copies do not send analytics. Declined activity is not queued or replayed after permission changes. There is no advertising, cross-site tracking or third-party analytics script.

The existing AWS-hosted control service combines accepted events immediately into daily UTC action counts and expires the totals after 90 days, with expiry checks excluding them from reports. Database TTL cleanup is eventual and existing backup retention also applies. It stores no individual event log. Only administrators can read a 7-, 30- or 90-day summary. These are opted-in action counts, not unique people, reliable conversion journeys or a complete count of all visits. Network failures, blocked requests and abuse caps can lower the totals.

As with normal service requests, infrastructure receives network metadata. Separate security counters use a daily hash of the network address with an expiry at the following UTC day plus one hour; they cap submissions and are not added to the analytics totals as identities. The service has a finite daily event cap. No new provider, analytics account or public telemetry stream is introduced.

## Invitations and control

A club member invitation contains its random ID and decryption secret in the URL fragment. A separate organiser link also contains the authority to edit the club and diary. The app removes invitation fragments from the address bar before its joining requests. Fragments are not sent as part of the website's ordinary HTTP request, but a person, browser, messaging app or calendar holding the complete link can retain or forward it.

There is no per-person approval, verified membership identity or individual revocation list. Anyone with a member link can read the club, post encrypted chat and manage a reminder registration in that club. Chat names are self-chosen. Keep the organiser link for yourself; someone holding it can edit the club and diary.

A live room invitation is a separate bearer link tied to one capture session. End and replace the room to replace that invitation. Doing so does not revoke the club link. Create a new club to replace club access. Clearing a live invitation from the diary does not close already established media connections.

## What stays in the browser

The browser encrypts club details, the live room invitation and chat using AES-GCM and the club secret. The server receives encrypted envelopes and derived access tokens over HTTPS; it stores access-token hashes rather than the raw club or organiser secrets. These are client-side encryption boundaries, not a promise of anonymity or protection from a compromised device, browser or website build.

Starting a quick test or sharing a tab opens a private room: it uses an explicitly open organiser club, reuses an automatically created room, or creates and saves a new one. The organiser sees that the room is saved for the next match. A direct screen invitation opens its club in memory; saving access or enabling reminders is a separate choice. Creating a named club or choosing **Join & save club** saves club keys in this browser's IndexedDB. Saved records can also include the organiser key, club name/colour, self-chosen display name, local client ID and reminder-registration ID. Reminder links use only the club ID, so that browser needs its previously saved key to open the club. Saved access does not automatically transfer to a new browser, device, profile or installation.

**Forget club on this browser** removes that saved club record and tries to remove this browser's server reminder registration first. The key can still be forgotten if the network request fails. Forgetting does not delete the club, remove other members, clear their saved invitations or revoke their access. If registration removal fails, an existing generic reminder may continue until it is disabled or expires. Browser/OS storage cleanup and notification permissions are also under your control.

Downloaded calendar entries contain the match details and a complete private member invitation. Your calendar app, account provider or anyone receiving the file may retain them. Downloading an entry does not automatically update it when the organiser changes kick-off; update or remove old calendar entries in your calendar app.

## What the control service can see

The deployment configuration uses a small serverless control service for encrypted club state/chat and optional Web Push. It does not receive the club decryption key, carry video or store provider login credentials. The service can see random club/event/message IDs, access-token hashes, ciphertext sizes and versions, update/message times, kick-off and reminder times, and reminder-subscription metadata. An active room's magnet is inside encrypted club state, not a server-readable stream address.

Browser reminder registrations expose their push endpoint, push-encryption keys, local client ID and selected opaque event IDs to the control service. Other members do not receive those registration details in normal API responses. The API sees network addresses during requests; application rate limits retain a daily hash derived from the address. Infrastructure providers and network services can independently process or log network metadata. Deployment configuration keeps application logs for seven days and omits access tokens, encrypted bodies and subscription details from application error output. Public deployment and provider/device notification outcomes require separate verification.

The configured retention is:

- Club metadata and encrypted diary/state: expires 400 days after creation or the last organiser update. Reading or chatting does not extend the club's lifetime.
- Encrypted chat messages and message receipts: expire after 24 hours. The API returns at most the latest 100 messages; an open browser can retain its bounded displayed history beyond server expiry, and members can retain received content.
- Reminder registrations: expire 90 days after registration or refresh. Enable or refresh reminders again when necessary. Expired provider endpoints are pruned when detected.
- Reminder jobs and their delivery receipts: short expiry associated with their scheduled reminder, normally 24 hours after the relevant job time.

Expired clubs/messages/subscriptions are rejected or filtered by application checks where used. Database TTL cleanup is eventual. The deployment enables point-in-time recovery, whose backups can retain earlier encrypted values for up to 35 days; expiry is not a promise of immediate physical erasure from every provider system or backup. This release does not offer a server-side delete-club button.

A generated-picture rehearsal exchanges encrypted member observations through the same club-message service. These can include chosen device labels, browser/platform, a self-reported device type, presence times, decoded-frame/playback/drift/stall/reconnect measurements and rehearsal phase. Other club members can read them. They are not independent proof of hardware identity or network separation. Downloaded JSON reports omit invitation keys but retain labels and observations; share them privately. The rehearsal generates its own picture and does not invoke desktop capture or automatically copy an invitation to your clipboard.

## Notifications

### Optional Fans’ corner and waiting content

The fan forum is a separate, opt-in service. Pilot accounts use email and password in a dedicated Amazon Cognito user pool, with email verification and email password recovery. Cognito handles the password; the forum service maps a hash of the pool and account identifier to an opaque fan profile, rather than using an email address as a public profile. Your email is not shown on posts. Accounts do not grant access to private rooms or clubs, and starting or joining a room never requires signup. Signing in does not change room retention, invitation storage or room access. Forum joining additionally requires a pilot code and rules acceptance; display names are self-chosen, not verified real identities.

Sign-in opens a separate account tab so the room page stays in place. The account callback relays only a one-use code; its verifier and account tokens remain in the original tab's memory, never browser local/session storage. Reloading or closing that tab loses its account session; the provider's browser session may let you sign in again. Sign-out clears this tab and opens the fan provider's logout separately. It does not sign out other devices or staff accounts. Issued access tokens can remain accepted until their one-hour expiry; server-side forum suspension is checked independently.

Private feedback remains available without signup through a separate random browser credential saved in local storage; the service stores only its hash. Clearing that browser storage loses access to those unsigned receipts. When first signing in from a browser with older posts or feedback, you explicitly choose whether to claim that history or start a new profile. A claim consumes the old credential and transfers its existing fan profile and receipt access to the account; it does not extend content retention. The original browser credential is required: email or display-name matching cannot recover or claim someone else's history.

Forum posts, replies and like counts are public: anyone using Same End can read them without an identity. Posting, replying and liking need forum membership. A like is stored against the liker’s fan identity so it can be removed; only totals are shown to others. The forum’s open/closed state, topic filter, sort order and last-visit time are saved in this browser’s local storage only. They are not encrypted with private club keys. Feedback text, optional contact details and staff replies are private to the sender and authorised support staff; they are server-readable. This browser UI attaches no diagnostics, club invitations, room membership or chat automatically. Do not put private viewing links or sensitive personal details in posts or feedback. Fans can report or block authors and delete their own posts; deletion removes the post text while retaining the bounded record needed for conversation structure. Contact support for other removal requests during the pilot.

Account ownership mappings and their bound fan profiles persist until removed through operator support, so an account does not acquire a new identity when old content expires. Feedback, forum, report, vote and unsigned browser-identity records expire 365 days after creation. Ordinary reads and staff updates do not renew that lifetime; application reads enforce expiry before eventual database TTL cleanup. This is the implemented pilot retention period, not the earlier illustrative 90-day-after-resolution proposal. Staff audit retains at most the latest 1,000 bounded actions, with no feedback bodies, contact details or credentials. Provider backups can retain earlier values under the recovery policy described above. Hard pilot capacity limits require operator review before expansion.

Feedback drafts are kept in this tab's session storage for reload/retry and removed after confirmed submission; the app download excludes rendered personal content. Waiting content uses a bounded public text/quiz/sponsor pack stored in this browser; a later page accepts that stored pack only while it is less than one minute old. The current page can retain its public text for the rest of that page session, while scheduled expiry is still checked. It makes at most one optional pack request per loaded page while a source is available and the picture is not ready. No audio/video, remote images, advertising beacons or third-party scripts are added. Sponsor links open only on an explicit click. Staff sign-in uses a separate Cognito account with an authenticator and assigned roles; staff tokens remain in memory and administrative API responses are not cached.

Reminders are optional, permission-based and best effort. Generic notifications contain a club ID, an optional opaque event ID and a link to open the locally saved club. They do not include the club secret, organiser secret, match title, chat, team names or live room invitation. Push providers receive the endpoint and encrypted push delivery traffic; the device may show the generic notification on a lock screen.

A successful request or provider receipt does not prove a device displayed a notification. The scheduler checks once per minute, so reminders are not guaranteed at an exact second. Settings, connectivity and device/browser support can block or delay them; bounded retries can still produce a duplicate after certain failures. **Quiet notifications** removes that club's registration on this browser when the request succeeds. Calendar reminders are managed separately in the calendar app.

## Video and peer metadata

WebTorrent contacts a public tracker over secure WebSockets to introduce peers and exchange a tiny encrypted cast descriptor. The tracker can see IP addresses and swarm metadata, but does not carry video or receive the cast's fragment key. A STUN service helps peers discover a direct route. Connected peers can learn one another's network addresses. These operators may keep metadata under their own policies.

Capture happens locally after the browser's source picker. Video/audio pieces travel between peers over WebRTC and carry the source's signature. The app retains a rolling media window in memory, up to 192 MiB of application cache plus browser/transport buffers. A temporary supplier loss preserves that window and the shared clock while recovery is attempted. An actual missing source cannot supply future picture. Ending a session clears application media state; this does not erase copies retained by recipients, the browser or operating system.

The offline service worker caches the fixed app-shell assets. It does not cache live API responses, chat history or video. Saved club credentials are separate, deliberate IndexedDB records. Opening the shell offline does not make the live club service or remote peers available.

The static host receives ordinary page and asset requests and associated network metadata. Same End cannot promise anonymity or stop recipients from retaining content they can view. Use only material you are entitled to capture and share; provider restrictions and protected capture still apply.

### Optional local fixtures extension

The desktop helper stores only normalized fixture details, selected country, reminder preferences, connection consent and fired reminder identifiers in `chrome.storage.local` in the current browser profile. It does not use browser sync, analytics, cookies, passwords, page history or a Same End listing database. Source page HTML is read transiently on import or an explicitly enabled daily BBC refresh and is not persisted. BBC following stores the team slug, enabled state, last check and any short error locally; you can turn it off in the helper. BBC following requests only validated football-team monthly fixture URLs directly from the BBC with credentials omitted; that provider still receives the normal connection metadata.

Choosing Connect or Open Same End allows the Same End website to read these local records on this computer through its restricted content-script bridge. Records are held in page memory for display and calendar export. This feature does not send them to Same End's backend, private club diary or other devices. Disconnect stops website access; Remove deletes a fixture and its reminder, and uninstalling removes the extension's local storage. Ordinary browser-profile or device backups may retain local data under the user's own backup settings.

Calendar export places the selected fixtures and source links in a file. A calendar application may sync imported events to its own service. This is separate from Same End; calendar alerts, updates and deletion follow that calendar's behavior. Local browser alarms can be delayed or missed while the browser/device is closed or asleep. The extension requests no access to personal calendars.
