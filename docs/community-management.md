# Same End community staff desk

The staff desk is `/manage.html`. It is separate from fan identities, room invitations, room chat and peer-to-peer match delivery. It manages persistent feedback, a shared opt-in text forum, reports, member participation, and bounded waiting-content packs. No video, audio, tracking advertisement, third-party script or arbitrary HTML is accepted by the content editor. Sponsor cards are text and optional HTTPS links; this release does not include paid advertisement operation.

## Build and backend integration

1. Copy `manage.html`, `manage.js` and `manage.css` into the PWA distribution. Replace `__SAME_END_CONFIG__` in `manage.html` with escaped JSON containing the existing `apiBase`. The HTML is an application shell, not an offline administrative database. Keep staff pages/API responses outside service-worker content caches.
2. Import `addCommunityInfrastructure` from `backend/community-infrastructure.mjs` and pass the existing control CloudFormation template through it before deployment. It returns a clone and expects existing logical resources `Api`, `Integration` and `Control`. Apply it once. Existing fan/control routes and environment variables remain intact.
3. Pass Lambda environment variables into `createCommunityApi` as `adminAuth: {issuer: process.env.COMMUNITY_ADMIN_ISSUER, clientId: process.env.COMMUNITY_ADMIN_CLIENT_ID, domain: process.env.COMMUNITY_ADMIN_DOMAIN, redirectUri: process.env.COMMUNITY_ADMIN_REDIRECT_URI}`. Its public `/v1/community/config` returns those public configuration values. They are identifiers, not credentials. Keep `localAdminTokenHash` absent in Lambda.
4. Dispatch `/v1/community` requests into the community API. API Gateway adds JWT authorization to both `ANY /v1/community/admin` and `ANY /v1/community/admin/{proxy+}` using the existing integration. The Lambda must also validate trusted gateway issuer/audience, `token_use: id` and group claims. A fan bearer, self-decoded JWT, user-provided role header or token in a URL never grants staff access.
5. Include `backend/test/community-infrastructure.test.mjs` in verification alongside community API tests. Its browser test uses the installed bundled Playwright and Google Chrome (override `SAMEEND_PLAYWRIGHT` / `CHROME_PATH` for another installation).

CloudFormation adds a Cognito user pool with administrator-created accounts only, required software-token MFA, a public client with authorization-code flow only, a classic hosted sign-in domain, four groups, a JWT authorizer and outputs `StaffUserPoolId`, `StaffIssuer`, `StaffClientId`, `StaffDomain`, `StaffRedirectUri`. Callback and logout URI are exactly `https://www.sameend.com/manage.html`; no localhost production callback is added. The domain prefix combines account ID and the lower-case stack UUID to remain unique and below Cognito's 63-character limit. The staff pool has deletion protection and retention: removing the application stack must not accidentally destroy staff accounts.

## Initial administrator and MFA enrollment

The staff page keeps its short-lived PKCE request only while deliberately navigating to hosted sign-in. Ordinary navigation, explicit sign-out, callback consumption and expired/mismatched callbacks clear it; no ID token is stored. A full outbound-and-return browser regression covers this lifecycle.

The hosted OAuth scope includes `aws.cognito.signin.user.admin` solely for the signed-in user's Cognito MFA operations. Before opening management, the page checks `GetUser` for an enabled software-token authenticator. A first-time one-use setup token opens a private manual-key enrollment screen; the key, password, code and provider sessions never enter Same End APIs, browser storage, logs or external QR services. Completion clears them and requires a fresh hosted sign-in.

If the initial setup token was lost, choose **Finish authenticator setup** on the management page. Enter the permanent password already chosen, directly into the first-party form that posts over HTTPS to Cognito. A distinct public enrollment-only client permits `USER_PASSWORD_AUTH` and receives the provider's `MFA_SETUP` challenge, then associates/verifies the token and completes that challenge. Its ID-token audience is not accepted by the staff gateway/API. No password reset, MFA weakening or administrator privilege is introduced by recovery. Challenge sessions allow15minutes; the page's setup window expires after10minutes. Cancel/page exit abort pending calls and clear private fields. Existing registered authenticators are never replaced by this flow.

See [AWS TOTP setup and lost-token recovery](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-totp.html) and [Cognito authentication-session validity](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_UserPoolClientType.html).

After an explicitly approved infrastructure deployment, an AWS account administrator should use the Cognito console to open the output `StaffUserPoolId`, create the named staff user with their email address and a temporary password, and add that user to `sameend-admin`. Self-registration is disabled. Account creation and invitation delivery are separate owner-authorized operational actions; this change does not create or contact real users.

The new administrator opens the production staff desk and chooses **Sign in securely**. Cognito handles password entry and replacement of the temporary password. If authenticator setup is incomplete, the staff page offers the private setup key for the user's own authenticator and verifies its generated code. Complete enrollment, then choose **Sign in securely** again. Store passwords and authenticator recovery material in the organisation's approved secure place, never the audit log, screenshots, tickets or this repository. Only the operator should handle enrollment secrets. Accounts without a staff group cannot use this desk.

Account recovery is `admin_only`. An AWS administrator must use Cognito's supported reset/re-enrollment procedures after independently verifying the staff user's identity. Do not weaken mandatory MFA to resolve an enrollment failure. Have a separately protected AWS administration/recovery route available before real staff use. Add a second approved administrator through the same process when operationally required.

## Roles and daily work

| Cognito group | Desk access |
| --- | --- |
| `sameend-admin` | All sections, forum enable/code rotation and audit |
| `sameend-support` | Private feedback status and replies, contact and submitted diagnostics |
| `sameend-moderator` | All forum content including hidden posts, report decisions, hide/restore, lock/unlock, member suspension |
| `sameend-editor` | Waiting stories/quizzes/sponsor cards, previews, publication and schedules |

Grant the narrowest suitable role. Group changes take effect in newly issued tokens; sign out and sign in again after changing a role. Issued ID tokens last 15 minutes. A removed/disabled user's already issued JWT can remain accepted until expiry because API Gateway verifies the token independently of Cognito account state. For an incident requiring immediate blanket removal, explicitly approve and change or disable the affected API access path rather than assuming logout/revocation instantly invalidates an issued JWT.

The desk replies to feedback in the fan's own feedback history. It does not send email. A report can be resolved without hiding the associated post; moderators open the reported thread to make the separate content decision. Author-deleted text cannot be restored. Thread and reply metadata expose an opaque member ID for participation review. Suspending participation leaves the feedback route available. Moderation reasons are required and bounded.

The content editor previews safe text, quiz choices/answers and sponsor labels. Unpublished drafts never appear in fan packs. Optional start/end dates are entered in the editor's local time and sent as epoch milliseconds; a published item appears only while its schedule is active. The API bounds every field and the complete published pack to 50 KB, including schedules that might overlap later. Saving a new draft allocates a UUID. Existing IDs stay fixed. Pilot content is not an editorial/source or advertising-rights approval.

Every staff edit submits `expectedVersion` from the loaded record (`0` for a new item/settings). Updates, deletion and audit writes are atomic. A `409` means the record changed; use Refresh, review current content and then reapply the intended change. The desk does not silently overwrite another staff member's changes. No automatic sensitive-data polling is performed. Lists and thread replies have explicit **Load more** controls.

## Sign-in and local review boundary

Production uses Cognito hosted sign-in with authorization code plus SHA-256 PKCE, random state and nonce. The transaction is kept transiently in `sessionStorage`, expires after ten minutes and is removed when the callback is taken. Callback query/fragment data is removed before API or token-exchange calls. Issuer/client/redirect/nonce/token purpose/expiry/group checks in the browser govern presentation; only the gateway and backend are the authorization boundary.

The ID token is held in module memory and sent only in the API Authorization bearer header. Access/refresh tokens are discarded; reload requires sign-in again. Staff credentials are never saved in `localStorage`, placed into API URLs or logged. Sign-out and expiry clear the visible records and credential. Production sign-out also opens Cognito logout to end its hosted browser session. Back/forward cache restoration clears the desk. Sign-out on this device does not log out other devices.

On exactly `localhost`, `127.0.0.1` or `::1`, the desk additionally displays **Local review only**. The operator may enter an explicitly configured test credential, retained in memory for at most 30 minutes. The API verifies that credential independently; production/Lambda must never enable this path. Local review presents all sections to exercise the isolated fixture. It establishes neither Cognito identity, verified groups, required MFA, production persistence nor a deployed gateway authorizer.

## Verification and release acceptance

The focused automated suite checks nonmutating template integration, exact protected admin paths, ID-token audience authorizer, no self-signup, required TOTP MFA, code-only/public client, domain constraints, role filtering, PKCE randomness/challenge, state/age/redirect rejection, nonce and ID token checks, callback URL cleanup, content serialization and an intercepted Chrome sign-in flow. The browser check verifies support-only sections, safe rendering of hostile text, empty credential storage, a bearer ID token on admin calls, sign-out clearing and refusal to exchange an invalid state.

These checks do not create AWS resources or verify a real hosted sign-in. Before production acceptance separately confirm: CloudFormation deployment completes; initial real administrator can replace password and enroll TOTP; wrong client/issuer/access tokens and fan credentials are rejected at the deployed gateway/API; every role can access only its intended routes; expired sessions clear the desk; concurrent edits receive conflicts; published schedules and feedback replies reach the intended fan. Do not log tokens or copy them into external JWT inspection sites during validation.

## Primary references checked 25 October 2026

- [CloudFormation Cognito user pool](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html) — account creation policy, required MFA, retention/deletion configuration.
- [CloudFormation user-pool client](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpoolclient.html) — code grant, public client, callbacks and token validity.
- [CloudFormation hosted domain](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpooldomain.html) — prefix constraints and classic hosted UI version.
- [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html) — authorization code, state, nonce and PKCE.
- [Cognito TOTP MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-totp.html) — authenticator registration and administrator-created users.
- [API Gateway HTTP JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) — signature/issuer/audience/time checks and trusted claims. This application's contract deliberately uses an ID token; Lambda must enforce `token_use: id` because the gateway does not distinguish token purpose automatically.

Gateway claim-shape reference: the [AWS-owned REST migration sample](https://github.com/aws-solutions-library-samples/accelerated-intelligent-document-processing-on-aws/blob/main/docs/migration-appsync-to-rest.md) documents that gateway group claims can be flattened into a bracketed string such as `[Admin Author]` or a comma-joined form; do not assume the Lambda receives the original JWT JSON array. Normalize only trusted authorizer claims and compare complete role names.

## Starter discussions

`community-starters.json` holds a small, dated pack of team discussions (currently Premier League topics prepared on 25 October 2026, with sources). The build copies it beside the staff desk. In **Forum**, a moderator or admin chooses **Publish starter discussions**: each item is posted as the clearly labelled “Same End team”, with fixed IDs so publishing again never duplicates anything. Match results are spoiler-protected automatically. Topical facts age quickly — review the pack (and its sources) before publishing, and edit or replace it for later weeks rather than presenting old results as new. Team posts are never written in invented fans’ voices.


## Waiting introduction

The initial buffering screen includes the previously reviewed 24-second ElevenLabs Jamie introduction, a static SVG and the script as a transcript. The original script is `assets/same-end-intro.txt`; the recording is mono AAC at 24 kbit/s, 76,381 bytes, and the build enforces a 100 KB ceiling. It is a static file outside the eager app-shell cache, requested only after Play. Hiding the guide, hiding/leaving the page, or picture readiness pauses and releases it. The newer keep-the-picture-visible recovery behavior is preserved. Staff-managed text/quiz/sponsor cards remain under optional reading; the editor accepts no arbitrary media URLs or uploads.

## Alpha security migration: ordered listings and separate capacity pools

Public thread lists use same-table ordered pointer rows (`TLIST#`), public summaries (`TSUM#`) and small category counts (`TLISTMETA#`). Each request examines at most 40 pointers and summaries, returns at most 20 visible summaries, and reads personal votes only for those returned summaries. No public request falls back to loading all thread bodies. New and Top have exact ordered keys. Hot stores the existing age-decay score at thread activity: creation, thread likes, replies and thread moderation refresh that thread's score. It is an activity snapshot, not a continuously recomputed wall-clock ranking. An operator backfill refreshes all Hot scores. Cursor ordering can move when threads receive activity; refresh begins a fresh view. A heavily blocked/expired batch can return an empty page with a continuation cursor. Keep following the explicit Load more cursor. Counts are category-wide and may temporarily include expired records pending maintenance; blocks affect the returned items.

Thread/source versions stay unchanged by index maintenance. Index maintenance and application thread mutations commit atomically. Hidden/deleted threads have no public pointers; moderator source access remains available. Staff thread lists also examine a fixed 40-source batch rather than scanning every source row. A missing `TLISTREADY` schema-1 marker returns `503 forum_index_not_ready` for public lists until the operator completes verified backfill. Local development and the isolated account fixture explicitly bootstrap their own local index; Lambda never runs maintenance automatically.

Unsigned browser identities retain the bounded existing `COUNT#identities` / `COUNT#feedback` pools. Verified profiles and new verified feedback use independent `COUNT#identities-verified` / `COUNT#feedback-verified` pools, each bounded at 1,000. Claiming a legacy identity preserves its ID, suspension, feedback receipts and credentials rules while allocating verified capacity. Existing legacy feedback remains in its original pool when its stored capacity marker says so. This split prevents unsigned traffic from exhausting verified capacity. Per-fan feedback remains bounded at 30. Public routes cannot reset capacity.

Before making the deployment publicly available, the AWS operator must perform this explicit migration using the deployed matching source and the correct existing table, with authorised table credentials:

```js
import {DynamoDBStore} from './store.mjs';
import {createCommunityApi} from './community-api.mjs';
if (!process.env.TABLE_NAME) throw new Error('Choose the existing table explicitly');
const maintenance = createCommunityApi({store: new DynamoDBStore(process.env.TABLE_NAME)});
// Read-only by default. Output counts only; never print source rows or credentials.
console.log(await maintenance.reconcileCapacity());
console.log(await maintenance.backfillListings());
```

Review those counts against the intended pilot inventory. Then, in the same operator-owned context, explicitly apply:

```js
console.log(await maintenance.reconcileCapacity({dryRun: false}));
console.log(await maintenance.backfillListings({dryRun: false}));
```

Capacity reconciliation accounts for existing account-bound profiles and old feedback before allocating the new verified pools. It conditionally replaces all four counters together, rejecting concurrent allocations rather than overwriting them. It does not remove or update users, suspensions, feedback, post text, source versions, content retention or settings. Expired records can be excluded from recovered capacity, but are not deleted. It fails closed if unfiltered record counts exceed its supported 2,000-record bound; review/wait for ordinary TTL cleanup instead of accepting a partial count. Review and rerun after a conflict; do not force a counter write.

Backfill rereads each source and uses conditional transactions, checks every surviving source and pointer, then writes readiness only after verification. It is safe to rerun after interruption. The default two-second pause between source transactions limits migration pressure on the shared pilot table; do not set `paceMs: 0` against production. A verification conflict leaves initial readiness unset; rerun after reviewing the conflict. There is no HTTP maintenance route.

After apply, verify guest New/Top/Hot and every category, existing discussions across successive pages, hidden-content exclusion, member blocks, likes/replies/moderation, own feedback history and staff source views. Confirm `reconcileCapacity()` reports the applied values, and record only counts and IDs needed for acceptance. Deployment, successful migration, public gateway checks and device acceptance are separate outcomes.

### Bounded reply pages

Guest, member and staff thread reads now query 20 reply source rows at a time using a cursor tied to the thread and viewer scope. Pages follow stable reply-ID order; each returned page's visible replies are arranged by creation time. The 500-reply source cap and existing source content are unchanged. `pageReplyIds` lists the raw source IDs examined, including removed rows; `replyCount` retains the source thread count. A full 20-row batch provides a continuation cursor, so an exact multiple may require one final empty page. Hidden/expired-only batches can also be empty with a cursor. No reply, score or vote collection is scanned in full for a thread read.

To retain the tree across pages, a member/guest response may include up to three ancestor placeholders per visible source reply, at most 60 ancestor source reads for a 20-row page. These ancestors have `context: true`, structural IDs/depth/time, empty text and names, and no author ID. Hidden/deleted/blocked flags survive redaction. The ancestor's complete visible text is available when its own source page is loaded. Flattened reply-to names receive a separate bounded privacy check. Scores and personal votes use targeted reads only for the page's visible source replies, plus the thread itself. Context rows carry no score or personal vote.

Clients merge pages by reply ID, replace a context row when its own visible source page arrives, and retain all previously loaded source pages. A refreshed page uses `pageReplyIds` to remove text that is now omitted/redacted. A hidden/deleted/blocked context row must replace any previously loaded author/text immediately. The public client revalidates one loaded page per polling interval in rotation, so a large discussion does not multiply background request load. Moderation changes on older loaded pages appear when their page is next revalidated. If a refreshed page boundary changes, the public client discards later cached pages and follows the new continuation so lexical inserts cannot leave a gap. Authoritative thread-not-found/forum-closed responses clear the cached view immediately. Refresh discussion immediately discards the accumulated pages and loads a fresh first page. Any client must refresh all loaded page cursors before treating its entire accumulated view as current; refreshing only the first page does not refresh moderation on older pages. Reply sorting over an incomplete loaded set must clearly state that scope, and Load more must remain available until the cursor is absent. Thread counts include removed source rows and need not equal visible comment counts.

These bounded operations reduce request amplification; they do not establish sustained public-load resilience. The shared pilot table remains capped at 100 read units/second and 50 write units/second, with five Lambda invocations and an API stage configured for 20 requests/second. Community application limits are 3,000 requests/minute globally and 300/minute per daily network shard, using 64 fixed shards. These are abuse/cost boundaries, not a promise that expensive reply pages can sustain those rates. Ancestor reads still consume capacity on the shared table. Monitor throttling and separately validate a permitted real pilot workload before expanding capacity or audience.

The local operator wrapper is `backend/maintain-community.mjs` (excluded from the application bundle). It requires an explicit AWS region, `TABLE_NAME`, and an identical `--table` argument. Run with no `--apply` for a dry run; add `--apply` only for the reviewed mutation. It reserves a new private report before mutation, snapshots thread source IDs/versions/hashes before and after each apply phase, and fails for review if any source changes. Standard output contains status/counts and the private report path; it never prints source text, identities or feedback. Production backfill pacing is fixed at 2,000 ms per thread. An interrupted apply may have safely committed capacity/index work; inspect its private report and rerun rather than forcing readiness or overwriting counters.
