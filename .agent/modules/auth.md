# Authentication and registration

Rainver authentication is a clean Better Auth cutover. Better Auth owns
password hashing, OAuth state/callback handling, verification values and the
durable session model; the Rainver facade owns active-user status, bootstrap /
invitation admission, registration provisioning, Space membership, audit facts,
administrator policy and public response contracts.

## Runtime ownership

`server/src/gateway/routeRegistry.ts` constructs one `AuthRuntime` for the
composition. `server/src/modules/auth/betterAuth.ts` is the only production
Better Auth factory; `server/src/db/betterAuthPgAdapter.ts` is the typed custom
PostgreSQL adapter. Runtime auth code does not import the Drizzle query adapter.
The session cookie is `better-auth.session_token`; there is no legacy
`session_id` cookie or handwritten OAuth/session writer. Rainver-owned cookies add
`Secure` whenever `FRONTEND_URL` is HTTPS and remain usable on loopback HTTP.

## Admission and registration

The first intent is admitted only when its normalized email matches
`INSTANCE_ADMIN_EMAIL`. After the first account becomes active, new registration
requires an unexpired `available` invitation to a non-Personal Space; Space
owners/admins may create one for a specific email, and it expires after seven
days. Email normalization is trim plus lowercase only, without provider-specific
alias rules. Display name is optional and defaults to the part before `@`.
An invitation admits
registration but does not verify ownership of that email address. Intent claim
secrets and invitation tokens are stored only as SHA-256 digests. A pending
Better Auth identity is not admitted to product routes until
`RegistrationService.complete` creates the Personal Space, defaults, invitation
membership and active status in one transaction. If signup created a pending
identity before completion failed, a newly requested authorized bootstrap or
invitation flow rotates the existing intent claim, binds that identity, and
signs in to resume instead of creating a second account. An intent expires
30 minutes after issuance or an authorized restart; updating its activity
timestamp alone does not extend that deadline. The five-minute reconciliation
job and a new admission attempt expire stale intents and release invitation
reservations. Cleanup revokes incomplete sessions and accounts and deletes the
now-unreferenced pending identity so the email can retry while the invitation
remains valid.

Invitation links are `/invitations/claim#token=...`. The web page removes the
fragment with `history.replaceState` before any network request, so the token is
not sent in a URL or Referer. The old path and old accept endpoint do not exist.
An active account with the invited email can instead accept the same link via
authenticated `POST /api/v1/invitations/accept`; the Space repository locks and
consumes the available invitation while activating the membership in one
transaction. A signed-out existing user signs in and reopens the original link;
the raw token is not saved in browser storage for a login handoff.
The public auth configuration reports only whether bootstrap registration is
currently available. The login page uses that flag to show administrator setup
for an empty instance or a resumable pending bootstrap, and hides the generic
registration entry after initialization; invited users always enter through
their dedicated invitation link.

## Account security

Email/password uses an 8–128 Unicode-code-point policy in explicit
`dev`/`test` instances and a 15–128 policy everywhere else. The public auth
configuration endpoint exposes the active bounds. Spaces are allowed, with no
character-class composition or periodic-rotation rule. Passwords are hashed
with Argon2id. Candidate passwords use the guarded HIBP range check, which sends
only a SHA-1 prefix; an unavailable check allows the operation and records a
degraded security event. Login errors are generic and combine Better Auth
path/IP limits with a bounded normalized-email/IP progressive limiter. Safe
success/failure/throttled and degraded HIBP events use the allowlisted
`auth_security_events` details.
Google provider access, refresh and ID tokens are scrubbed before persistence;
linking Google requires an explicit authenticated action, and unlinking cannot
remove the last remaining login account. Later Google sign-ins do not overwrite
the Rainver profile. Every Better Auth session creation records `last_login_at`.
A Google reauthentication nonce is one-time and bound to the user who initiated
it before a recent-auth grant can be issued.

`/settings/security` wraps recent password or Google reauthentication, password setup/change,
Google link/unlink and safe session list/revoke operations. Session responses
contain a server-owned session id and metadata only, never a raw cookie or
stored digest. The page fetches the authenticated, no-store
`GET /api/v1/auth/reauth/status` result and hides login methods, password
settings and sessions until the signed 10-minute grant is valid; it relocks at
expiry or after a mutation consumes the grant. Google-only accounts can use
Google reauthentication instead of a password. Password recovery delegates
issuance/consumption to Better Auth's hashed, single-use verification path;
reset links expire after 30 minutes. The current delivery adapter is manual-copy:
an authenticated instance administrator can retrieve a reset link exactly
once; unauthenticated recovery responses never reveal it. `pnpm
auth:recovery` is the sole-admin local CLI path.

## Administration and future delivery

Instance admins can list users, disable/enable accounts (which invalidates
sessions), issue a one-time reset link and inspect pending intents. No
impersonation, arbitrary email editing, Space-admin recovery or open signup is
implemented. The recovery and registration lifecycles expose stable link
boundaries so a future mail adapter can deliver the same links without adding a
second token issuer or changing token semantics.

See [SECURITY_AND_ACCESS_BOUNDARIES.md](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md),
[DATABASE_AND_TRANSACTIONS.md](../architecture/DATABASE_AND_TRANSACTIONS.md),
and [ADR 0023](../decisions/0023-authentication-foundation-schema-epoch.md)
for the current access, transaction, and schema-epoch boundaries. The completed
implementation's phase history remains in Git.
