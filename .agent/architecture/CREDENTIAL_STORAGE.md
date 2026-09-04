# Credential Storage

The system stores secrets in **four distinct channels**. Do not conflate them.

| Channel | What | Where stored | Doc |
|---|---|---|---|
| **ModelProvider API key** | API keys for in-process LLM calls (OpenAI, Anthropic, …) | AES-256-GCM ciphertext in a DB `Credential` row | this doc |
| **Managed subscription OAuth** | Instance-admin Claude Pro/Max and OpenAI Codex subscription credentials for in-process calls | AES-256-GCM OAuth envelope in a DB `Credential` row | this doc |
| **CLI login state** | Claude Code / Codex CLI login profiles for sandboxed runs | files under `instance/secrets/cli-credentials/…`, brokered per run | [modules/credentials.md](../modules/credentials.md) |
| **Custom Source fetch credential** | Header-based credential (API key / bearer token) for an Sources Custom Source's outbound fetches | AES-256-GCM ciphertext in the same DB `credentials` table, distinct `credential_type` and `secret_ref` prefix | [modules/sources.md](../modules/sources.md), [architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md](SOURCE_CUSTOM_SOURCE_HANDLERS.md) |

This doc covers the **ModelProvider API key** and **managed subscription OAuth**
channels used by the `model_api` runtime adapter and bounded server-owned
Provider tasks. There is no public Provider Chat execution route; agent-facing
model calls enter through Runtime Context Delivery.
The **Custom Source fetch credential** channel reuses this channel's DB table and master key
(`server/src/modules/sources/customSources/customSourceCredentialCrypto.ts`,
`server/src/modules/sources/customSources/customSourceCredentialService.ts`) but is functionally distinct: it
resolves to a request header injected only by the trusted Custom Source fetch layer
(`customSourceEndpointFetch.ts`, `customSourcePipelineInterpreter.ts`), never by generated or
interpreted handler code, and it is never pooled/rotated the way ModelProvider keys are.

## At-rest encryption

- **Cipher:** AES-256-GCM (`server/src/modules/providers/secretRefCrypto.ts`). Plaintext → `(ciphertext, nonce)`, both base64.
- **Master key:** a 32-byte random key in a file on disk at
  `RAINVER_HOME/secrets/provider_keys.key` (auto-generated on first use, `chmod 0600`).
  **The master key is NOT in the database.** A database-only compromise does not reveal keys —
  the on-disk key file is also required.

## Database layout

The plaintext API key is **never** stored. The encrypted material lives in:

| Table | Field | Holds |
|---|---|---|
| `model_providers` | `owner_user_id`, `credential_id` (FK) | user-owned provider resource and pointer to the **primary** Credential row. `config_json` does **not** contain the key (any `encrypted_key` is popped before persist). |
| `credentials` | `owner_user_id`, `secret_ref`, `metadata_json` | user-owned encrypted material. API keys use `model_provider_api_key:v1:…` with `credential_type="api_key"`. Managed subscriptions use `model_provider_oauth:v1:…` with `credential_type="subscription_oauth"`; only secret-free quota snapshots live in metadata. |
| `model_provider_space_grants` | grant metadata | explicit provider-to-space grants. Grant rows carry active-space `enabled`, `is_default`, and `network_profile_id` semantics. |
| `model_provider_credentials` | pool membership | 1→N credential **pool** per provider: position, enabled, rotation health (`healthy`, `cooldown_until`, `last_failure_class`, request/failure counters). Holds **no secret material** — only FKs to `credentials`. The primary credential is lazily enrolled as the position-0 member. |
| `provider_task_policies` | per-task chains | one ordered provider/model chain per (space, task) for auxiliary tasks (reflector, checkpoint extractor, …). No secret material. |

`secret_ref` scheme is defined in
`server/src/modules/providers/secretRefCrypto.ts`
(`encodeModelProviderApiKeySecretRef` / `resolveApiKeyFromSecretRef`).

Rotation strategy (`fill_first` | `round_robin` | `least_used` | `random`) and the
provider fallback chain (`fallback_provider_ids`) remain provider-level
configuration in `model_providers.config_json`. Default provider selection and
NetworkProfile routing are active-space grant fields.

CLI login state is a distinct credential class: it is **never pooled or rotated**, and
the pool tables never reference it. A user × session conversation backend
binding selects the user's enabled active-space CLI grant; shared Agent
profiles never hold a user credential id. At execution, the broker creates a
clean run-private `HOME` and copies only the runtime's credential file. It does
not share CLI sessions, transcripts, databases, or general configuration.
Quota probe homes are unique and short-lived, and their cache is keyed by both
runtime and credential profile id.

Managed subscription OAuth is also never pooled or rotated. Only the configured
instance admin may connect, refresh quota, or disconnect it. The resulting
provider remains owner-bound: another space member cannot list it, receive its
access token, trigger token refresh, or invoke through it. Refresh is performed
under a database row lock so concurrent server processes cannot race refresh-token
rotation. It never reads or mutates Claude Code or Codex CLI profile files.

## Save flow

Providers page → `POST /api/v1/providers` with `api_key` →
`server/src/modules/providers/providerCommandStore.ts`: encrypt API key
→ encode `secret_ref` → create/replace a `Credential` row → set
`ModelProvider.credential_id` → create an enabled grant to the active space.
Only the provider owner can edit provider metadata or API-key material.

Managed subscription flow → `GET /api/v1/providers/subscriptions/login/stream`
→ pi-ai OAuth for Claude or OpenAI Codex → encrypt the returned access/refresh
credential → create an owner-bound ModelProvider and active-space grant. Quota
refresh and disconnect use the provider-specific subscription endpoints; public
DTOs expose only connection state and quota percentages/reset timestamps.

## Runtime resolution

`server/src/modules/providers/providerCommandStore.ts` is the canonical
resolver. It first resolves an enabled `model_provider_space_grants` row for
the active run space, then loads the `Credential` → `resolveApiKeyFromSecretRef`
→ AES-GCM decrypt with the on-disk master key → returns plaintext. The
decrypted key is passed to provider invocation **as a parameter** and is never
written to `process.env` — per [ADR 0008](../decisions/0008-credential-channel-isolation.md)
it cannot leak into a CLI subprocess environment. The server store draws keys
from the credential pool with rotation/cooldown state and the same master-key
file. Exactly one side decides credential release: the server.

For a managed subscription provider, the same resolver verifies the invoking
subject is the provider owner, decrypts the OAuth envelope in-process, refreshes
it under `SELECT … FOR UPDATE` when near expiry, and passes the access token only
to pi-ai's Anthropic Messages or OpenAI Codex Responses transport. Subscription
credentials never enter API-key pools or subprocess environments.

Claude-compatible CLI provider bindings use the same invariant. The Claude
subprocess receives only a short-lived provider-proxy lease token through
`ANTHROPIC_AUTH_TOKEN`; the proxy resolves the real ModelProvider API key
inside the server process and replaces the lease token before forwarding the
request upstream. The proxy URL is not loopback — its host comes from
`SANDBOX_RUNNER_SERVER_HOST` (default `server`, the Compose service name), so
it is reachable within the deployment's own network. Reaching it from a paired
execution host additionally requires `PROVIDER_PROXY_PORT` (a fixed port, since
an OS-assigned one moves on restart) and `PROVIDER_PROXY_EXTERNAL_BASE_URL`
(the address that host should use); without both, a bound remote run fails with
a stated reason rather than receiving a URL it cannot resolve. A remote run's
lease carries the Host it was issued for, so revoking that Host revokes the
lease rather than leaving it live until its TTL;
[ADR 0008](../decisions/0008-credential-channel-isolation.md)'s 2026-08-24
amendment records why that is a transport change rather than a
channel-isolation change.

Codex OpenAI-compatible CLI provider bindings follow the same invariant. For a
selected Codex provider, the server writes only a run-scoped temporary
`CODEX_HOME/config.toml`; its `experimental_bearer_token` is a short-lived
provider-proxy lease token, not the ModelProvider API key. `CODEX_HOME` points
at the run's temporary Codex profile directory. Login-backed Codex runs copy
only `auth.json`; they do not link the user's shared Codex sessions or config.
The proxy resolves the real key inside the server process and forwards the
request to the configured `openai_compatible_base_url`.

## Invariants

- Plaintext key exists only transiently in memory at decrypt time; never in the DB, `config_json`,
  environment variables, or logs (`server/src/modules/runs/evidenceRedaction.ts` redacts RunStep/artifact content).
- The API never returns the key. `ModelProviderOut` exposes only
  `has_api_key: bool`, ownership metadata, and active grant metadata; editing
  supports *replacing* the key, not reading it.
- A provider or credential that lacks an enabled active-space grant fails closed
  before secret resolution.
- Managed OAuth credentials are instance-admin connected, owner-only at use time,
  and isolated from CLI login profiles and API-key rotation pools.
- Guarded by server provider/runtime adapter tests (adapters must not read ambient `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)
  and runtime governance redaction tests.

## Current limitation

The master key is a **local-file symmetric key**, not KMS/HSM-managed. Consequences:

- Whoever can read both `RAINVER_HOME/secrets/provider_keys.key` and the database can decrypt all
  keys — keep sensitive recovery archives (`secrets/` plus the reviewed mode `.env` snapshot)
  separate from normal DB/data backups; combining them
  carries decryptable material.
- This is appropriate for a single self-hosted instance. Stronger setups (multi-tenant, compliance)
  would move to envelope encryption with a KMS (KMS-wrapped master key, per-space derived subkeys).
  Not implemented today.
