# Privacy choices and aggregate analytics

The consent-first implementation counts only three fixed events on HTTP(S) app visits: `page_view`, `share_started`, `invitation_copied`. It neither sets analytics cookies nor creates a visitor identifier. Its optional purpose is improving Same End. The app's pre-existing functional storage and hosted sign-in remain separate. This is an implementation description, not a compliance certification.

## Visitor controls

A small non-modal banner offers equally styled **Allow analytics**, **No thanks**, and **Details**. The footer's **Privacy choices** control reopens it. Missing, invalid, expired or inaccessible consent disables collection. The purpose-versioned choice expires after 180 days. It contains the choice and local save time, not an ID. Choosing no keeps room/chat/account features usable. Storage events propagate withdrawal; every attempted send rechecks current consent expiry. Outstanding requests are aborted on withdrawal or pagehide. Already accepted aggregate counts cannot be attributed to someone for deletion. No historical events are queued or replayed after permission is granted. Saved file copies send no analytics.

There are at most three in-flight requests and 60 attempts per page lifecycle. Failures are ignored without retries; analytics must never block an invitation or capture. Page loads are counted at most once per document, successful source starts on a source-state transition, and invitation copies after the standard room-invitation clipboard write succeeds. These are activity counts, not unique users, consent rates or individual journeys. Native share outcomes, other copy routes and activity before opting in are outside these counters.

## Backend and staff view

`POST /v1/analytics/events` accepts exactly `{v:1,event:<allowlisted-name>}` as JSON, up to 256 bytes. It requires an allowed Origin and rejects auth headers, query fields, custom events and extra metadata. The server supplies the UTC date and atomically increments a daily aggregate. It does not store raw event records, URLs, referrers, accounts, room IDs or user-agent metadata in analytics records. The configured first-party control service is hosted on AWS; it still receives ordinary connection metadata.

A separate daily hashed-address abuse counter permits at most 600 events per network address per UTC day; the entire service has a 10,000-event daily cap. Security keys rotate daily and expire at the next UTC day plus one hour. These security counters are not visitor profiles. The existing infrastructure throttling/log/back-up configuration is unchanged.

`GET /v1/community/admin/analytics?days=7|30|90` uses the existing JWT-authorized staff routes. Only the admin role can read it; editor/support/moderator and unsigned users cannot. The staff Analytics section offers daily UTC counts and period totals, including a clear empty state. Reads exclude expired aggregates. Daily aggregates expire after 90 days; DynamoDB TTL cleanup is eventual and the existing backups may outlast live records.

The standalone public policy is built from `PRIVACY.md` as `/privacy.html`. The app embeds its short disclosure for offline use; the separate full policy page is not an offline app-shell asset. No new analytics vendor, account, subscription or external script is required.

## Review and release

1. Build and run `npm test`, `npm run test:privacy`, and the existing static security/install checks on this branch.
2. Review the local desktop/mobile screenshots, staff totals and privacy copy. Browser fixtures exercise controlled local API calls; they do not establish physical-phone, production JWT or deployed analytics acceptance.
3. After approval, update the existing backend stack using the normal deployment workflow before releasing the frontend. Do not send artificial events to the production collector to inflate real counts. Read the protected production staff summary and verify consent gating on a fresh public visit after release.
4. Existing app and backend releases remain unchanged until that reviewed release. Rollback can remove the banner/collector wiring; existing aggregates still follow expiry unless an operator deletes them through the established backend procedure.

## Sources checked on 26 October 2026

- [ICO: storage and access technologies, including web storage](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/)
- [ICO: managing consent in practice](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-we-manage-consent-in-practice/)
- [ICO: purpose-specific exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/)

Some qualifying statistical uses may fall under an exception; this implementation deliberately requests opt-in rather than relying on that exception. Cookie terminology is not used to imply that browser storage sits outside the rules.
