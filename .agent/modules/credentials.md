# Module: Credentials

## Design Statement

Rainver holds exactly one kind of runtime credential: a **managed
subscription** — a Claude Pro/Max or OpenAI Codex OAuth grant an instance admin
completed here, stored as an encrypted database credential and spent through
the in-process provider channel (ADR 0008).

A vendor CLI's login is **not** one of them. Since ADR 0016 a CLI runs only on
an execution host, and its login lives with the copy on that host — the
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
  (`packages/host-daemon/src/tools.ts`), which is why keeping the previous
  version directory makes a rollback a step rather than a re-login.
- The control plane never sees the credential, its path, or its contents
  (BOUNDARIES B64). What crosses the wire about it is: logged in or not,
  account ids and kinds, and subscription percentages.

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
and "no subscription quota" for everything else rather than a CLI launch that
learns nothing. Only numbers, reset times and a reason come back. The control
plane caches them (`hosts/usageService.ts`), refreshes on a schedule, folds in
the live reading a finished Run carries, and shows the result beside the copy
on the host card.

## Retired in ADR 0016

`cli_credential_profiles`, `cli_credential_space_grants`,
`cli_credential_events`, the `CredentialBroker`, the server-side login engine
and its adapters, `runtime_tool_bindings`, `space_runtime_tool_policies` and
`cli_usage_import_cursors` are gone, dropped by the `0002` maintenance
migration. `runtime-tools/` and `secrets/cli-credentials/` under
`$RAINVER_HOME` are no longer read; `start.sh` names them after migrating and
leaves them alone, because a script that deletes a secrets directory is a
script nobody can trust.

## Related

- [ADR 0008 — credential channel isolation](../decisions/0008-credential-channel-isolation.md)
- [ADR 0016 — execution hosts](../decisions/0016-control-plane-execution-hosts.md)
- [modules/hosts.md](hosts.md) — the host card, installations and logins
- [architecture/CREDENTIAL_STORAGE.md](../architecture/CREDENTIAL_STORAGE.md)
