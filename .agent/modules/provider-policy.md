# Module: Provider Policy

## Current Approach (Personal/Family Use)

Provider configuration is database-backed and user-owned through
`ModelProvider` rows. API keys are encrypted server-side into user-owned
`Credential` rows, linked by `model_providers.credential_id`, and exposed
through APIs only as `has_api_key`.

Provider use in a space is explicit through `model_provider_space_grants`.
Creating a provider auto-grants it to the active space. Granting a provider to
another space lets eligible members of that space use it in runs, but only the
provider owner can edit provider metadata or replace secret material. Active
space default selection and provider `network_profile_id` are grant-level
fields.

Auxiliary system tasks can bind to provider/model chains through
`provider_task_policies`. The retrieval settings UI surfaces the retrieval
tasks `retrieval_embedding`, `retrieval_rerank`, and
`retrieval_query_rewrite` as space-scoped provider/model choices; owner/admin
users edit these policies, while invocation still resolves credentials through
the provider command store and pool/fallback path. Retrieval embedding dimension
is a normalized space setting; provider adapters map it to request parameters
where supported and validate the returned vector length.

Retrieval task policies are capability-filtered. `retrieval_embedding` accepts
embedding-capable providers (OpenAI-compatible, Ollama, ZeroEntropy, Cohere, or local
`other`), `retrieval_rerank` is reserved for native rerank providers
(ZeroEntropy or Cohere), and `retrieval_query_rewrite` uses ordinary chat providers.
The provider task-policy route enforces the same compatibility rules as the UI.
Query rewrite prompt text is not stored in the provider policy; it is resolved
through the Prompt Library asset `retrieval.query_rewrite` before the chat
provider call.

The Providers page remains the single place to create and maintain provider
credentials, but it labels provider capabilities explicitly (`Chat`,
`Embeddings`, `Native rerank`) and has separate add flows for ordinary chat
providers, embedding providers, and rerank providers. ZeroEntropy and Cohere
are presented as separate embedding and rerank presets: `zembed-*` /
`embed-v4.0` models configure `retrieval_embedding` and embedding dimensions,
while `zerank-*` / `rerank-v4.0-pro` models configure native rerank task
policies. Embedding and rerank creation do not expose the chat provider
`API protocol` selector; the selected preset owns the backend adapter type.
Provider presets are server-owned under `server/src/modules/providers/presets/`
and exposed through `GET /api/v1/providers/presets`. Frontend code consumes
this catalog but does not hardcode vendor preset facts. Creating a provider
from a preset goes through `POST /api/v1/providers/from-preset`; for embedding
and rerank presets the server also configures the corresponding retrieval task
policy and retrieval settings.

`model_providers.base_url` is required and represents the Provider's managed API
endpoint for server-side model calls. Provider records may additionally carry CLI bridge endpoints in
`config_json`: `claude_compatible_base_url` for Anthropic-compatible Claude CLI
overrides and `openai_compatible_base_url` for OpenAI Responses-compatible Codex
CLI overrides.

Runtime adapters never read provider keys from ambient environment variables.
Managed API runtimes resolve credentials through `server/src/modules/providers/`
after the `runtime.use_credential` policy gate passes. CLI runtimes use the CLI
CredentialBroker profile channel instead.

For managed API chat calls, an explicitly configured
`openai_compatible_base_url` is the preferred transport, including when the
vendor catalogues the provider as `anthropic`. The native Anthropic Messages
transport is used only when no OpenAI-compatible endpoint is configured. This
keeps structured-output Research runs on the OpenAI JSON Schema contract by
default while retaining native Anthropic support for providers that do not
offer an OpenAI-compatible endpoint.

Source post-processing and Project Research synthesis are server-managed runs;
Project Research uses only the managed `model_api` provider path and never a CLI
credential profile. They are not user Automations. When their rule/setup was explicitly configured by the
user, the trusted internal run creator records that scope in the immutable run
contract through the typed managed-execution policy. The credential policy can
then allow the corresponding `job` or `system` run without a second approval
prompt, and the run failure policy keeps provider/CLI failures on the owning
Source or Research operation instead of converting them into a generic
Supervisor review. This does not grant the same exception to
`trigger_origin='automation'`; ordinary unattended Automations still require
their own pre-authorization.

Claude Code can optionally bind to a configured ModelProvider for
Claude-compatible endpoints. The Provider row remains the source of truth:
`config_json.claude_compatible_base_url` stores the Anthropic-compatible base
URL, and `default_model` / `available_models` store model choices. The server
creates a short-lived per-run provider proxy lease and renders only that lease
into the Claude CLI subprocess environment (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`,
and `ANTHROPIC_DEFAULT_HAIKU_MODEL`) only for that run. If no provider is
selected for Claude Code, the server does not set `ANTHROPIC_BASE_URL`; Claude
Code uses its normal default endpoint/login state. Provider API keys are never
released to CLI subprocess environment variables; the provider proxy resolves
the real key server-side and forwards requests to the configured compatible URL
using the selected provider grant's NetworkProfile.

Codex CLI can optionally bind to a configured ModelProvider for OpenAI
Responses-compatible endpoints. The Provider row remains the source of truth:
`config_json.openai_compatible_base_url` stores the OpenAI-compatible base URL,
and `default_model` / `available_models` store model choices. The server creates
a short-lived per-run provider proxy lease, materializes the run's temporary
`CODEX_HOME` directory from the managed Codex profile, and writes a run-scoped
`config.toml` plus `model-catalogs/agent-space-provider.json` there. The
generated Codex config points at the local provider proxy with
`wire_api = "responses"` and stores only the lease token as
`experimental_bearer_token`. If no provider is selected for Codex CLI, the
server still sets `CODEX_HOME` to the run's temporary Codex profile path but
does not write a provider override; Codex uses its normal CLI login/config
state and the selected CLI credential profile's NetworkProfile, if configured.

NetworkProfiles are space-scoped reusable routing profiles. They support
`direct` and `http_proxy` modes. HTTP proxy URLs are not credential carriers;
proxy URLs with embedded usernames or passwords are rejected. `NO_PROXY` values
are applied to both server-side provider fetches and CLI subprocess proxy env.

Provider calls emit best-effort observations to the append-only `usage` module.
Managed API invocations and provider-proxy responses are normalized into
mutually exclusive token buckets; pricing rules may add auditable cost
estimates. Prompts, completions, request/response bodies, credentials, and raw
CLI transcripts are excluded. See `docs/TOKEN_USAGE_METERING.md`.

## Per-Space Model Config (Lightweight Future-Proofing)

Agent records carry `model_config_json` — the model used for a specific agent can differ from the system default:

```json
{
  "model": "claude-opus-4-7",
  "max_tokens": 8192
}
```

This is the only per-agent provider customization implemented now. It covers the personal/family use case (e.g. use a cheaper model for routine tasks).

## What We Have NOT Built

- A separate Space-owned enterprise BYO-key authority beyond the current
  user-owned providers and explicit Space grants
- A general rule-based provider routing table beyond Space defaults,
  provider-task policies, and provider fallback chains
- Provider health dashboard
- Dedicated on-prem fleet administration beyond configurable provider base URLs

These are deferred until commercial need. The current provider store and usage
ledger cover the implemented personal/family operational model: keys are
encrypted, user-owned, Space-granted, policy-gated, and never injected as broad
process environment.

## Provider Risks to Document

| Provider | Risk |
|---|---|
| Anthropic (Claude) | Data sent to Anthropic servers; not for private/sensitive enterprise data without a data processing agreement |
| OpenAI (Codex) | Same; OpenAI API terms apply |
| Any cloud LLM | Prompts include context_snapshot (memory + Project Folder). Review what goes in context before using a third-party provider |
| Ollama / local | No external data transmission; safe for private data |

## When Adding a New Provider

1. Add provider metadata and validation in `server/src/modules/providers/`.
2. Store API keys through the encrypted user-owned `Credential` + `ModelProvider`
   command store path; do not add ambient provider-key env vars.
3. Choose the active grant's `network_profile_id` when the provider needs proxy
   routing; use direct routing for local or internal providers.
4. Create or configure the runtime adapter to use the provider's SDK/CLI through
   the provider resolver or CLI CredentialBroker, depending on adapter type.
5. Document the provider in this file's risk table.
6. Note any license or terms-of-service constraint in `runtime-adapters.md`.

New managed API providers must be covered by provider-command-store tests and
runtime credential policy tests before they are considered wired.

## Related Files
- `server/src/config.ts` — provider/runtime config inputs
- `server/src/modules/projectFolders/` — sandbox/Project Folder boundaries
- `server/src/modules/runs/` and `runtimeAdapters/` — runtime adapter implementations
- `.agent/modules/runtime-adapters.md` — adapter registry and license notes
