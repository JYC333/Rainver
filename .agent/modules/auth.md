# Authentication and registration

Rainver authentication uses Better Auth. Better Auth owns
password hashing, OAuth state/callback handling, verification values and the
durable session model; the Rainver facade owns active-user status, bootstrap /
invitation admission, registration provisioning, Space membership, audit facts,
administrator policy and public response contracts.

## Runtime ownership

`server/src/gateway/routeRegistry.ts` constructs one `AuthRuntime` for the
composition. `server/src/modules/auth/betterAuth.ts` is the only production
Better Auth factory; `server/src/db/betterAuthPgAdapter.ts` is the typed custom
PostgreSQL adapter. Runtime auth code does not import the Drizzle query adapter.
Better Auth names the session cookie `better-auth.session_token` on HTTP and
`__Secure-better-auth.session_token` on HTTPS. Rainver reads and clears the name
issued by Better Auth. There is no `session_id` cookie. Do not add a second
OAuth or session writer. Rainver-owned cookies add
`Secure` whenever `PUBLIC_BASE_URL` is HTTPS and remain usable on loopback HTTP.
After ordinary Google sign-in, the callback returns directly to the requested
same-origin destination or `/home`. The destination carries the original deep
link query and fragment. Registration and reauthentication use their own
completion pages.

The auth facade forwards Better Auth's `Set-Cookie` headers from every Google
OAuth start response, including login, registration, reauthentication and account
linking. Sign-in and password-change responses carry the session only in the
cookie: the facade answers `{ ok, user }` and drops Better Auth's `token` body
field. Better Auth is the sole judge of its own cookie — one whose signature it
rejects is not a session — and the request it receives names the client only by
the `request.ip` Fastify resolved. It is also the sole writer of a session's
lifetime: sessions expire after `SESSION_EXPIRE_DAYS` and Better Auth refreshes
one it validates once a day of its window has passed (`session.updateAge`).
The facade validates every session with `getSession({ returnHeaders: true })`
and forwards whatever `Set-Cookie` headers come back — the refreshed session
cookie with Better Auth's own `Max-Age`, `Secure`, `HttpOnly` and `SameSite`,
and no `Max-Age` for a sign-in that asked not to be remembered — on the
response that resolved identity (`resolveIdentity`, `introspectIdentity(…,
reply)`, `getCurrentUser(…, sessionRefreshSink(reply))`). Rainver never
computes a session expiry or issues a second session cookie of its own. Its OAuth errors return to `/login?error=...` rather than an unmounted
Better Auth error endpoint.

Browser sign-out clears local authenticated state immediately and records an
opaque pending intent until Better Auth confirms sign-out. A reload or reconnect
retries the intent before resolving identity. The browser's sign-in and
registration entries settle any pending sign-out before requesting a new session.

## Several accounts in one browser

One browser may be signed in to up to five existing accounts and acts as one
of them in every tab. `browserAccounts.ts` (cookies only) and
`browserAccountSessions.ts` (Better Auth and PostgreSQL) own it, with
`browserAccountLedger.ts` for what requests in flight have not delivered yet;
the facade remains the only route surface.

- Every session the browser holds is one HttpOnly jar cookie
  `rainver.account_<session id>` carrying Better Auth's own signed cookie value
  and whether that sign-in is remembered. The HttpOnly selector
  `rainver.active_account` names the active session id. `sessionTokenFromRequest`
  returns the selected entry, so every identity path (`resolveIdentity`,
  `getCurrentUser`, reauthentication, session lists) acts as the selected
  account. With a jar, a missing or invalid selected entry is no session; it
  never falls back to another cookie. A browser signed in before the jar
  existed (Better Auth's cookie alone) keeps working as one account and joins
  the jar at its next sign-in.
- Every successful sign-in (password, Google, registration, password change)
  passes Better Auth's `Set-Cookie` through `settleSessionCookies`: the new
  session joins the jar and becomes active, a previous session of the same
  person leaves the jar (as a single-account sign-in replaced it, without a
  revocation of its own), and other people's entries stay. Better Auth's own
  cookie still passes through, with no lifetime for an unremembered sign-in.
  Better Auth requests the facade forwards (`sign-out`, `change-password`,
  `link-social`, callbacks) carry the selected account as Better Auth's
  session cookie and no jar cookie.
- Remember-me is per account: an unremembered entry, and the selector while
  it names one, are browser-session cookies. A password change keeps the
  choice of the entry it rotates, read from the request's own jar cookie
  (Better Auth has already deleted that session when the merge runs), and
  answers with the rotated `account_handle`, which the tab adopts before its
  next request. The sliding-window refresh
  (`sessionRefreshSink`) is rewritten onto the active entry's own jar cookie
  and never writes Better Auth's cookie or the selector, so a refresh that
  arrives after a switch cannot switch the browser back, and an unremembered
  entry never gains a lifetime. A browser without a jar keeps Better Auth's
  refresh but drops its `Max-Age` when Better Auth's don't-remember cookie is
  present. Better Auth may still extend an unremembered session row server-side;
  its cookie ends with the browser session.
- `GET /api/v1/auth/browser-accounts` lists the accounts (user id, name,
  email, avatar, active, remembered — never a session id or token) and clears
  entries that are no longer a valid session of an active account, such as one
  revoked from Security on another device. `POST /api/v1/auth/browser-accounts/switch`
  (`user_id`) changes only the selector: no session is created, refreshed or
  revoked, and the recent-authentication cookie is cleared.
- Adding an account is an ordinary sign-in from the avatar menu:
  `POST /auth/sign-in/email` with `add_account: true`, or
  `GET /auth/google?add_account=1&next=...`. A refused password changes no
  cookie. A Google addition carries Better Auth's `errorCallbackURL` back to
  `next`, so a cancelled or failed Google step returns to the page still signed
  in as before, never to Login; the avatar menu then shows why
  (`?error=account_limit` or Better Auth's reason) once and drops it from the
  address. An addition past the limit is refused and its new session revoked;
  an ordinary sign-in at the limit instead signs out the longest-unused account.
  A password sign-in or registration answers with the new `account_handle`.
- Requests in flight together see only the cookies the browser had when they
  left, so the limit and logout also consult `browserAccountLedger.ts`: a
  process-local, 15-minute record joining the verified session ids a browser's
  requests carried, and the tokens proven with them, with every session issued
  to it. A password change also joins the session it proved before Better Auth
  deleted it, with the request's token, so a single-account browser's rotation
  stays tied to the cookie its logout will carry. The limit counts accounts
  issued to the browser whose response it has not applied yet (two concurrent
  additions at four accounts: one succeeds, one gets `account_limit`), minus
  any of them since revoked or whose account is no longer active (read before
  the check; a session issued after that read is still counted); the check
  and the record run without an `await` between them.
- Scope of the ledger: it guards requests that reach the same server process
  while their group is still held (15 minutes idle, at most 4096 browsers, the
  least recently used dropped first), and only requests that carry a cookie of
  the browser: a first sign-in from a browser holding none cannot be tied to a
  logout. The deployed topology is one process per instance: each Compose file
  runs a single `server` service with a fixed `container_name` (it cannot be
  scaled), the image starts one `node dist/index.js` with no cluster or worker
  processes, nginx proxies `/api/` to the one upstream `server:8010`, and a
  cutover recreates the container (`up -d --no-deps server`) rather than
  running two side by side. Running several server processes or replicas
  against one database would need this record in shared storage first; until
  then the guarantees here are per process, not per deployment.
- A Google reauthentication callback must come back as the person who started
  it, from the session that started it (the `rainver.google_reauth` nonce
  names both). Anything else — another person, or a browser that switched
  account meanwhile — is revoked before any cookie is written; the completion
  step then fails as before.
- Logout signs the browser out of every account: it revokes every jar session
  through `repository.logout`, lets Better Auth end the selected one with its
  grants, and clears every jar cookie, the selector and Better Auth's OAuth
  `state` cookie. It is allowed from a stale tab. Before anything else it ends
  the browser in the ledger: sessions already issued to the browser by a
  sign-in, addition or password rotation still in flight are revoked (found
  through the verified sessions or through a token the logout carries, which
  is how a rotated-away session is found), and a request that carried any of
  the browser's ended sessions or tokens is refused when it settles, whether
  it reached the server before or after the logout (409 `signed_out` for a
  password sign-in or registration) with its session revoked. Such a request
  left before the browser applied the logout's cookie clears. A late response
  therefore cannot sign the browser back in, and a Google sign-in begun
  earlier fails its state check. An ended mark lasts 15 minutes whether or
  not anything sweeps the ledger meanwhile (`endedFor` checks its own age).
  A session issued to the browser that no request of it had shown holding
  (a password rotation whose response had not landed, which the logout did
  not carry and no settle verified) is revoked but not marked ended: only a
  response landing after the logout can give the browser its cookie, so
  refusing requests that carry it would refuse every later sign-in,
  addition or rotation of the browser, including those of an account signed
  in since. Its late response can still write back that revoked session's
  jar cookie and selector, displacing an account another tab selected after
  the logout. Recovery is limited to that session and to each request: the
  gateway (`repairLateSelector`, before the stale-tab check) reads the
  request without its jar cookie, without Better Auth's cookie, and, while
  the selector names it, with the selector moved to the session the browser
  selected most recently since the logout (ledger record of sign-ins and
  switches) or with none. The browser's last selection is looked up among
  its jar entries and the sessions the ledger groups with them, so when that
  session's cookie is gone (an account not remembered across a browser
  restart, or a cookie dropped once its session was revoked or expired), or
  it was revoked or expired, the request reads as signed out with Better
  Auth's cookie dropped too: it never falls back to an earlier selection
  among the remaining entries or to a legacy cookie. "Since" is the ledger's
  own event order of logouts and selections; the clock only ages marks, so
  events in one millisecond or a clock stepping back do not reorder them.
  An account is named only when the ledger proves continuity: the last
  selection among the groups of the request's jar entries is the newest
  selection made since the logout in any group born after it. The logout
  ended the browser's groups and cookies, so everything it is given
  afterwards starts in such a group, as does any other browser's fresh
  sign-in; the server cannot tell them apart, and each mark records that
  newest selection when it is made, so a group whose cookies are gone, was
  never shown beside the jar, expired or was evicted for capacity still
  counts. A switch groups every session its request verified (as a sign-in
  groups what it proved). Absence of a later selection is never inferred
  from the cookies a request shows: otherwise the request reads as signed
  out, never as a remaining account, and the person signs in again with
  every other valid entry kept. A tab of the account selected since
  is not refused, a reload finds that account, and nothing else is signed
  out. The response only clears that session's own jar cookie: it can never
  be valid again, so the clear is right in whatever order the browser
  applies responses. No response writes the selector or Better Auth's
  cookie from this repair, so an earlier request's answer that lands after a
  sign-in, switch or logout cannot undo it. The browser keeps the
  written-back selector until one of those replaces it (a logout clears it
  even when the request was read without it); the ledger's mark, keyed by
  the session id the selector names, recognizes it after its jar cookie is
  gone and is renewed by every request it repairs. The tab whose
  change answered after a sign-out began or reached the server takes no
  handle from it and rejects the change call (`signed_out`); it does not sign
  the browser out again. A `GET /me` that finds no account also drops every
  jar cookie Better Auth no longer accepts (never the selector). The ledger
  needs no persistence: it only outlasts requests in flight, which a restart
  cuts. After a restart, or 15 minutes without a request of the browser
  relying on the mark, a written-back selector is no longer repaired and
  behaves as any revoked selected session: the signed-out page. A switch
  needs a valid selected account, so the jar entries still saved stay in the
  browser but can be switched to only after signing in again.
- A Google reauthentication that rotates the active session keeps that
  session's remember-me choice, as a password change does.
- `GET /me` returns `account_handle` (the selected session id, or `-` without a
  jar). The web client sends it as `X-Rainver-Account` on every control-plane
  request and stream; the gateway answers a different handle with 409
  `account_switched` (header `x-rainver-account-switched`) from cookies alone,
  before any route runs, so a tab loaded for one account never writes as
  another. Every path that reads a response itself (streams, the image upload
  XHR, artifact export) reports that refusal like `request` does.
- The tab that switches or completes an addition clears `localStorage`, its
  `sessionStorage` and in-memory residue first, then announces
  `account-changed` on the `rainver:auth` BroadcastChannel, drops the API cache
  and reloads. Every other tab, on that message or on
  its first refused request, clears its own `sessionStorage` and in-memory
  residue, aborts every stream opened through `accountFetch` (and refuses new
  ones locally) and reloads; shared storage is left to the switching tab so a
  late clear cannot erase the next person's state. No tab clears its account
  handle while leaving: a `keepalive` write on `pagehide`, or any request after
  the person cancelled the unload, still names the old account and is refused.
  A tab asks to leave only once. A switch or addition of the tab's own that is
  refused because another tab switched first (or the tab was already stale)
  reloads the tab as the browser's account and reports no failure.
- A sign-in or registration from a public page (also on the return from
  Google) clears the shared storage before announcing, as a switch does, and
  the tab adopts the answer's `account_handle`.
- Signing out never drops the tab's handle. Once the logout reaches
  the server the tab names `-`, the server's handle for a browser with no
  account, and announces `signed-out`; other tabs still naming the handle they
  had when they were signed out adopt `-` too. The same page can therefore
  sign in again, while a tab that signed out and then lost the race to another
  tab's sign-in is still refused. A session that merely ended (a 401) leaves
  the browser's account selected on the server, so the tab keeps its handle. Server-side, an open stream keeps the cookies
  it was opened with and is not ended by a switch; its closing relies on this
  client behaviour.

Evidence and choice: Better Auth's official `multiSession` plugin was run
against this adapter on real PostgreSQL (Better Auth 1.7.5) and rejected.
`list-device-sessions` returns raw session tokens to page script and `set-active`
needs one back; because the adapter stores only digests, after a restart (a new
adapter instance) the list returns row ids instead and every `set-active`
answers 401. Its per-account cookie is also issued with `Max-Age` for a
`rememberMe: false` sign-in, breaking remember-me. Persisting raw tokens to make
it work would undo digest-only storage. The facade instead keeps Better Auth's
signed cookie values in its own HttpOnly cookies and lets Better Auth validate
them (`getSession` with `disableRefresh`).

## Admission and registration

The first intent is admitted only when its normalized email matches
`INSTANCE_ADMIN_EMAIL`. After the first account becomes active, new registration
requires an unexpired `available` email-bound invitation. Instance administrators
create account-only invitations from **Instance Settings → Users & Security →
Invite to register** (`POST /api/v1/auth/admin/invitations`). These create the
account and its Personal Space without granting administrator rights or shared
Space membership. Space owners/admins retain their existing invitation entry:
a new user registers and joins that non-Personal Space; an existing account
accepts it directly. Both invitation types expire after seven days and use the
same claim page, digest-only token storage, reservation, retry and consumption
lifecycle in `user_invitations`. A null `space_id` and null `role` identify an
instance invitation; Space invitations require both fields. Registration intents
record `instance_invitation` or `space_invitation` as their authority.
Email normalization is trim plus lowercase only, without provider-specific
alias rules. Display name is optional and defaults to the part before `@`;
it is bounded (`REGISTRATION_DISPLAY_NAME_MAX`) so that both
`users.display_name` and the derived `<name>'s Personal Space` fit their
columns, and a longer name is refused at the route before any identity exists.
An invitation admits
registration but does not verify ownership of that email address. Intent claim
secrets and invitation tokens are stored only as SHA-256 digests. A pending
Better Auth identity is not admitted to product routes until
`RegistrationService.complete` creates the Personal Space, defaults, invitation
membership (only for a Space invitation) and active status in one transaction.
If signup created a pending
identity before completion failed, a newly requested authorized bootstrap or
invitation flow rotates the existing intent claim, binds that identity, and
signs in to resume instead of creating a second account. An intent expires
30 minutes after issuance or an authorized restart; updating its activity
timestamp alone does not extend that deadline. The five-minute reconciliation
job and a new admission attempt expire stale intents and release invitation
reservations. Cleanup revokes incomplete sessions and accounts and deletes the
now-unreferenced pending identity so the email can retry while the invitation
remains valid. The same cleanup deletes a pending identity that no active intent
binds or names once it is 30 minutes old, such as one created when a different
Google account was chosen, so it cannot hold the bootstrap user slot.

Invitation links are `/invitations/claim#token=...`. The web page removes the
fragment with `history.replaceState` before any network request, so the token is
not sent in a URL or Referer. There is no other claim path or accept endpoint.
An active account with the invited email can instead accept the same link via
authenticated `POST /api/v1/invitations/accept` (core `space.invitation.accept`,
keyed; the request fingerprint keys the token, which is never stored); the Space
writer locks and consumes the available invitation while activating the
membership in one transaction. For an instance-only invitation it consumes the token without any
membership change and returns `space_id: null`. A signed-out existing user signs
in and reopens the original link;
the raw token is not saved in browser storage for a login handoff.
The public auth configuration reports only whether bootstrap registration is
currently available. The login page uses that flag to show administrator setup
for an empty instance or a resumable pending bootstrap, and hides the generic
registration entry after initialization; invited users always enter through
their dedicated invitation link.
The public Login, registration, invitation-claim, and password-reset pages offer
a browser-local English/Simplified Chinese UI choice. English is the default
and fallback; this presentation preference survives logout and never changes
invitation-token handling, session authority, or API payloads.

## Account security

Email/password uses an 8–128 Unicode-code-point policy in explicit
`dev`/`test` instances and a 15–128 policy everywhere else. The public auth
configuration endpoint exposes the active bounds. Spaces are allowed, with no
character-class composition or periodic-rotation rule. Passwords are hashed
with Argon2id. Candidate passwords — on registration sign-up as on set, change
and recovery — use the guarded HIBP range check, which sends only a SHA-1
prefix; an unavailable check allows the operation and records a degraded
security event. Login errors are generic and combine Better Auth
path/IP limits with a bounded normalized-email/IP progressive limiter. Safe
success/failure/throttled and degraded HIBP events use the allowlisted
`auth_security_events` details.
Google provider access, refresh and ID tokens are scrubbed before persistence;
linking Google requires an explicit authenticated action, and unlinking cannot
remove the last remaining login account. Later Google sign-ins do not overwrite
the Rainver profile. Every Better Auth session creation records `last_login_at`.
`GET /api/v1/me` returns `default_space_id`: the Space a session lands in
when a request names none (`selectDefaultSpace`). It is the personal Space the
person owns, else their oldest active membership; a personal Space they only
belong to is never their default. The web shell uses it after the URL's and
the last visited Space.
A Google reauthentication nonce is one-time and bound to the user and session
that initiated it. Successful reauthentication replaces the browser's session;
Rainver records the session issued by a successful Google callback, then revokes
only the prior session after the browser presents that exact new session and
issues the recent-auth grant. It is issued only after Better Auth accepts the
flow, and the pending table is bounded (oldest dropped past 2048) like the login
limiter's.

A recent-authentication grant (`auth_reauth_grants`, `auth/reauth.ts`) is
what a sensitive mutation spends. Verifying a password or completing a Google
reauthentication inserts one: an unpredictable token, stored only as its
digest, bound to the user and to the session the browser holds (after a
Google reauthentication, the newly issued session), valid for ten minutes,
sent to the browser as the HttpOnly `rainver.reauth` cookie.
`GET /api/v1/auth/reauth/status` only reads it. Password set/change and
Google link/unlink *consume* it with one conditional update — unconsumed,
unexpired, this user, this session — inside the mutation's own transaction
where the mutation is local, and before the call where Better Auth performs
it, so a replayed cookie, another session's cookie and two concurrent uses of
one grant all answer 403 `reauthentication_required`. The grant goes with its
session: logout revokes it and clears the cookie, and session revocation,
revoke-others, reauthentication's own session replacement and account
disabling delete session rows, which cascade to their grants.

`/settings/security` wraps recent password or Google reauthentication, password setup/change,
Google link/unlink and safe session list/revoke operations. Session responses
contain a server-owned session id and metadata only, never a raw cookie or
stored digest. The page fetches the authenticated, no-store
`GET /api/v1/auth/reauth/status` result and hides login methods, password
settings and sessions until the 10-minute grant is valid; it relocks at
expiry or after a mutation consumes the grant. Google-only accounts can use
Google reauthentication instead of a password. Password recovery delegates
issuance/consumption to Better Auth's hashed, single-use verification path;
reset links expire after 30 minutes. The current delivery adapter is manual-copy:
an authenticated instance administrator can retrieve a reset link exactly
once; unauthenticated recovery responses never reveal it. `pnpm
auth:recovery` is the sole-admin local CLI path.

## Administration

The retained admin user enable/disable POST URLs are strict, keyed core
commands (`auth.user.enable`, `auth.user.disable`). They admit a current active
instance administrator independently of the request Space; the actual owned
Personal Space stores their receipt and policy audit. A Space owner alone has
no instance authority. Self-disable and pending registration are refused with
422; revoked instance authority withholds cached output. Disable discovers and
locks all retained/destination Projects in id order before locking both user
roots in id order, then rechecks the reference set. Status, consent revocation,
session deletion, mandatory audit and receipt commit or roll back together.
Enable changes status only and never restores consent or sessions.

Instance admins can issue account-only registration invitations, list users,
disable/enable admitted accounts (disable
invalidates sessions and permanently revokes retained cross-Project Room grants
issued by that Agent owner, with pending cross-Project invitations invalidated
in the same transaction; ordinary private-Room grants retain their policy.
Re-enabling the account does not revive revoked consent. A `pending` identity belongs to `RegistrationService`
and both core routes answer 422 for it), issue a one-time reset link and inspect
pending intents. No
impersonation, arbitrary email editing, Space-admin recovery or open signup is
implemented. The recovery and registration lifecycles expose one link
boundary. Do not add a second token issuer or change token semantics.

See [SECURITY_AND_ACCESS_BOUNDARIES.md](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md),
[DATABASE_AND_TRANSACTIONS.md](../architecture/DATABASE_AND_TRANSACTIONS.md),
and [ADR 0023](../decisions/0023-authentication-foundation-schema-epoch.md)
for the current access, transaction, and schema-epoch boundaries.

Reuse / Dependency Check (browser accounts): Better Auth's `multiSession`
plugin was evaluated first and rejected on the evidence above. The jar reuses
Better Auth's session validation, cookie signatures and session refresh, the
facade's forwarding and `authCookieHeader`, `repository.logout` for revocation,
the web client's sign-out residue clearing and its `rainver:auth`
BroadcastChannel, and the shared Dialog, Input, Button and UserAvatar. No
dependency, table, migration or token issuer is added.

Reuse / Dependency Check: instance invitations extend the existing invitation
rows and RegistrationService lifecycle, Better Auth, shared Zod contracts,
Input/Button and OneTimeLink. No new auth engine, token issuer mechanism or
dependency is introduced. Migration 0010 renames the existing invitation table
and extends its constraints without dropping invitation or intent data. Because
the old release still reads the old table name, the migration is maintenance-only
and must be applied with stopped writers and the matching release (COMMANDS).
