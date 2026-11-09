# Module: Credentials

## Design Statement

Rainver holds exactly one kind of runtime credential: a **managed
subscription** — a Claude Pro/Max or OpenAI Codex OAuth grant an instance admin
completed here, stored as an encrypted database credential and spent through
the in-process provider channel (ADR 0008).

A vendor CLI's login is **not** one of them. A CLI runs only on an execution
host (ADR 0016), and its login lives with the copy on that host — the
built-in host inside `sandbox-runner`, or a paired machine. Nothing is copied,
brokered, or mounted from here, so there is nothing here to broker.

## What this module owns

Managed subscriptions, and only those:

- `GET /api/v1/providers/subscriptions/login/stream?type=anthropic|openai_codex`
- `POST /api/v1/providers/subscriptions/login/input?type=…`
- `POST /api/v1/providers/{provider_id}/subscription/quota`
- `DELETE /api/v1/providers/{provider_id}/subscription`

The OAuth flow runs in-process (`providers/subscriptionOAuth.ts`), the quota
read for those credentials is an HTTP call against the vendor's own endpoint
(`providers/subscriptionQuota.ts`), and the access/refresh state is refreshed
under a database row lock. These credentials are owner-only, never pooled, and
never handed to a subprocess: ADR 0008's rule is that a provider key does not
travel through a CLI's environment, and a managed subscription is spent through
the provider proxy instead. Decrypted material is resolved in-process only;
no HTTP route, including `/internal/*`, returns an API key or OAuth token.

## What a CLI's login is instead

One copy on one host, logged in on that host:

- The Command Center's host card installs a managed copy, opens its login
  terminal, and reports whether it is logged in and which accounts it holds.
- The login state lives inside that copy's own `HOME`
  (`packages/host-daemon/src/tools.ts`). Keeping the previous
  version directory makes a rollback a step rather than a re-login.
- The control plane never sees the credential, its path, or its contents
  (BOUNDARIES B64). What crosses the wire about it is: logged in or not,
  account ids and kinds, opaque subscription identities, and subscription percentages.

Nothing in the control plane resolves a CLI credential for a Run. A Run
dispatched to a host names the host and the installation; whatever that copy is
logged into is what it uses (B67 — a *backend* override still comes only from
control-plane injection, and the daemon's `filterAmbientEnv` allowlist is what
enforces it).

## Subscription quota

Two paths, for two kinds of credential:

| Credential | Read by | Cached in |
| --- | --- | --- |
| Managed subscription (held here) | `providers/subscriptionQuota.ts`, in process | the provider row's metadata |
| A CLI copy's own login (held on a host) | `packages/host-daemon/src/usageProbe.ts`, on the host | `host_runtime_usage` |

The host path answers a `usage_probe` frame: Claude's OAuth usage endpoint for
`claude_code`, Codex's `app-server` `account/rateLimits/read` for `codex_cli`,
Antigravity’s documented native CLI status-line quota JSON for
`acp_antigravity_acp` (`packages/host-daemon/src/antigravityUsage.ts`), and
"no subscription quota" for everything else rather than a CLI launch that
learns nothing. Only whitelisted account identifiers, login email/workspace display metadata, numbers, reset times and
an unavailable reason come back. The control
plane caches them (`hosts/usageService.ts`), refreshes on a schedule, and folds in
the live reading a finished Run carries. `GET /api/v1/hosts/subscription-usage`
projects the currently authorized connections into account/product/organization
quota pools for the Usage page. Command Center shows the full login email and available workspace name, with an account-handle fallback for older probes, and a
link to that same pool, with exhausted-window notices rather than repeated meters.

Claude identity comes from `/api/oauth/profile` using the quota request's token.
Codex identity comes from its own `account/read` RPC before and after quota,
using the authenticated `account.email` (normalized and hashed locally,
`identity_kind=email`) and selected `workspaceRouting.chatgptAccountId`
(the workspace alone would merge different Team seats). Codex 0.166 does not
return a top-level `userId`; workspace routing requires the existing
`experimentalApi` handshake. Only ChatGPT accounts with both scopes qualify.
Missing fields remain unidentified, not inferred from another login. Its optional auth-file fingerprint
is local only and must remain unchanged across the probe. Antigravity status-line JSON
supplies the signed-in email alongside quotas; the capture hashes it locally,
also reports the full email as separate display metadata, and marks `identity_kind=email`. Missing/older identities
remain separate. A failed optional identity read does not discard measured quota.

Identity and per-window measurement clocks extend the existing cache's JSON
contract; no physical schema migration is needed. Login/logout invalidates its
cache and supersedes in-flight probes. New-account refreshes cannot retain the
old account's model windows. Reads do not probe: manual refresh reuses the
existing Host-owner / built-in-instance-admin endpoint and one online connection.
Private Host names/readings are filtered before account grouping; the built-in
quota remains instance-admin readable under the existing quota gate. Historical
Token accounting and Room admission rules are unchanged. API-key Coding Plan
collectors are not implemented by this CLI phase; managed OAuth Providers retain
their separate existing quota path.

## Related

- [ADR 0008 — credential channel isolation](../decisions/0008-credential-channel-isolation.md)
- [ADR 0016 — execution hosts](../decisions/0016-control-plane-execution-hosts.md)
- [modules/hosts.md](hosts.md) — the host card, installations and logins
- [architecture/CREDENTIAL_STORAGE.md](../architecture/CREDENTIAL_STORAGE.md)

Login display metadata uses `account_display` independently of opaque pool keys.
Claude uses the authenticated profile’s account email and organization name;
Codex uses account/read email and workspaceName; Antigravity uses the same native
status-line email as quota. No credential field is returned. Display names never
enter the grouping key, and missing workspace identity may still show a known
email without merging connections. Host-owner/server-admin gates apply to the
full email exactly as they do to quota. Older caches show the existing handle
until their Host is updated and quota refreshed. OpenCode has no independent
subscription quota/login-email probe; no email is inferred for it.
