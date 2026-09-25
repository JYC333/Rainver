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
embedding-capable providers (OpenAI, OpenRouter, OpenAI-compatible endpoints,
Ollama, ZeroEntropy, or Cohere), `retrieval_rerank` is reserved for native rerank providers
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
this catalog but does not hardcode vendor preset facts. `GET
/api/v1/providers/vendors` serves the vendor registry itself — identity,
protocol, capability flags, published endpoint, and whether a credential is
required — and is the single source the web client and `providerSupportsTask`
both read. None of those facts is restated in the client or in a per-task
table. Creating a provider
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
after `authorizeCredentialSpend` decides the spend. CLI runtimes resolve none
here: their login is held by the copy on the execution host that runs them
(ADR 0016). A CLI Run bound to a ModelProvider still reaches it through the
expiring proxy lease, which is only minted from a decided spend, never through
a key in its environment.

`model_providers.provider_type` records vendor identity (`openai`,
`openai_codex`, `anthropic`, `minimax`, `openrouter`, `deepseek`, `ollama`,
`cohere`, `zeroentropy`, or the explicitly unknown `openai_compatible`), not a
wire protocol. The server-owned
vendor registry resolves that identity to the chat protocol and the capability
profile, and to nothing about a chat implementation: which pi-ai catalog
describes a vendor's models is a fact about pi-ai and lives with the adapter.
Managed chat calls run through
`@earendil-works/pi-ai`; per-space `base_url`, NetworkProfile fetch routing,
Rainver credential pools, egress authorization, usage recording, and
structured-output validation remain outside pi-ai. MiniMax uses its
Anthropic-compatible endpoint. A requested model uses its pi-ai catalog entry
when one exists. Completion-budget
authority is ordered: an explicit caller `max_tokens` wins, then an
Rainver `modelSpecs` recommendation when one is independently registered;
otherwise the Pi Model's `maxTokens` governs (the pi-ai catalog value for a
catalogued model, or the adapter's 16,384 fallback for an uncatalogued model).
The catalog fallback is intentionally not copied into `modelSpecs`, whose
limits also drive Runtime Context planning and therefore require their own
vendor provenance. `openai_compatible_base_url` and
`claude_compatible_base_url` remain CLI bridge configuration and do not select
the managed chat protocol.

Managed Claude and OpenAI Codex subscription Providers are owner-only. They may
be selected for that owner's direct managed work, including Project Research
and Question Refinement, but cannot back a space-wide `provider_task_policy`.
Codex structured output is implemented as a single constrained tool over the
Responses transport and uses the protocol-native `tool_choice: "required"`;
ordinary OpenAI-compatible chat retains the Chat Completions function-choice
shape.

CLI subscription logins (a host's copy of Claude Code or Codex running on its
own login, not bound to a Provider) are rationed by a Space policy rather than
a spend cap: `subscription_quota { warn_pct: 70, reserve_pct: 85 }`
(`providers/subscriptionQuotaPolicy.ts`, `GET|PUT
/api/v1/providers/subscription-quota-policy`, owner/admin to change, shown on
the Providers page). Past the reserve line Agent-triggered Room turns wait for
the window; a person's turns never do (`modules/rooms.md`, "Subscription quota
gate").

Source post-processing and Project Research synthesis are server-managed work,
not user Automations. Project Research stage executions are ordinary Agent
Runs pinned to the selected AgentRuntimeProfile; bounded provider operations
use ProviderTask policy and accounting rather than a managed API Agent runtime.
When their rule/setup was explicitly configured by the user, the trusted
internal run creator records that scope in the immutable run contract through
the typed managed-execution policy. The credential policy can then allow the
corresponding `job` or `system` Run without a second approval prompt, and the
failure policy keeps provider/CLI failures on the owning Source or Research
operation instead of converting them into a generic Supervisor review. This
does not grant the same exception to
`trigger_origin='automation'`; ordinary unattended Automations still require
their own pre-authorization.

The AgentRuntimeProfile owns runtime backend selection, and which runtimes may
be Provider-backed is a registry fact, not a Host fact. A Profile may choose
`backend_mode = "model_provider"` only when its runtime's
`AgentRuntimeDefinition` reports `supports_model_provider`, which comes from
the spec's `credentials.credential_mode`
(`runtimeAdapters/runtimeDefinitions.ts`). **Only OpenCode declares
`cli_profile_or_model_provider` today.** Claude Code and Codex CLI declare
`cli_profile`: they run on the execution Host's own vendor login, and
`assertBackendModeBinding` refuses a `model_provider` Profile for them with
422. `server/test/runtimeAuthority.test.ts` pins the registry fact that refusal
reads — `supportsRuntimeBackendMode("claude_code", "model_provider")` is
`false` — not the route's status code. The frames that
would render an Anthropic or Codex provider binding still exist in
`runs/remoteProviderBinding.ts`, but no Profile can select the mode that
reaches them.

For an OpenCode `model_provider` Profile the Provider row remains the source of
truth, and its vendor protocol picks the endpoint: an `anthropic_messages`
vendor uses `config_json.claude_compatible_base_url` on an `anthropic`-route
lease, registered in OpenCode as `@ai-sdk/anthropic`; an `openai_completions`
vendor uses `config_json.openai_compatible_base_url` on an `openai`-route
lease as `@ai-sdk/openai-compatible` (`runs/adapterProviderRequirement.ts`).
`default_model` / `available_models` store model choices. The
server creates a short-lived per-run provider proxy lease and writes a
Run-scoped `opencode.json` into the Run's isolated runtime profile
(`OPENCODE_CONFIG`) containing the proxy address, the lease token and the
selected model — never the upstream key. The Profile must also name an
execution Host and installation; either Host kind qualifies, since the daemon
receives a lease address rather than a credential. Provider API keys are never
released into a runtime subprocess environment: the provider proxy resolves the
real key server-side and forwards requests to the configured compatible URL
using the selected provider grant's NetworkProfile.

NetworkProfiles are space-scoped reusable routing profiles. They support
`direct` and `http_proxy` modes. HTTP proxy URLs are not credential carriers;
proxy URLs with embedded usernames or passwords are rejected. `NO_PROXY` values
are applied to both server-side provider fetches and CLI subprocess proxy env.

Provider calls emit best-effort observations to the append-only `usage` module.
Managed API invocations record pi-ai's per-call token detail once at the
Rainver provider boundary; provider-proxy responses use their existing
path. Both normalize into mutually exclusive token buckets. Prompts,
completions, request/response bodies, credentials, and raw CLI transcripts are
excluded. See `docs/TOKEN_USAGE_METERING.md`.

## Agent Runtime Profile model binding

`AgentVersion` contains no provider/model deployment binding. An
`AgentRuntimeProfile` may select a same-Space ModelProvider and explicit model
when the runtime supports that protocol and the Profile executes on the built-in
Server Runtime. Native mode instead uses the runtime's login on the selected
Host. The Profile snapshot is frozen into each Run, so changing a live Profile
does not rebind an existing Run or conversation.

The optional Space provisioning template is a separate choice for future
default Profiles; it never changes existing Profiles or supplies a dispatch
fallback.

## What We Have NOT Built

- A separate Space-owned enterprise BYO-key authority beyond the current
  user-owned providers and explicit Space grants
- A general rule-based provider routing table beyond Space defaults,
  provider-task policies, and provider fallback chains
- Provider health dashboard
- Dedicated on-prem fleet administration beyond configurable provider base URLs

These are not implemented. The current provider store and usage
ledger cover the implemented personal/family operational model: keys are
encrypted, user-owned, Space-granted, policy-gated, and never injected as broad
process environment.

Unimplemented commercial provider surfaces:
[unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §18.

## Provider Risks to Document

| Provider | Risk |
|---|---|
| Anthropic (Claude) | Data sent to Anthropic servers; not for private/sensitive enterprise data without a data processing agreement |
| OpenAI (Codex) | Same; OpenAI API terms apply |
| Any cloud LLM | Accepted Runtime Context Delivery may include Memory and Project data. Review egress policy and sensitivity ceilings before using a third-party provider |
| Ollama / local | No external data transmission; safe for private data |

## When Adding a New Provider

1. Add provider metadata and validation in `server/src/modules/providers/`.
2. Store API keys through the encrypted user-owned `Credential` + `ModelProvider`
   command store path; do not add ambient provider-key env vars.
3. Choose the active grant's `network_profile_id` when the provider needs proxy
   routing; use direct routing for local or internal providers.
4. Create or configure the runtime adapter to reach the provider through the
   provider resolver, or — for a CLI runtime — through the proxy lease its
   daemon binding receives.
5. Document the provider in this file's risk table.
6. Note any license or terms-of-service constraint in `runtime-adapters.md`.

New managed API providers must be covered by provider-command-store tests and
runtime credential policy tests before they are considered wired.

## Related Files
- `server/src/config.ts` — provider/runtime config inputs
- `server/src/modules/projectFolders/` — sandbox/Project Folder boundaries
- `server/src/modules/runs/` and `runtimeAdapters/` — runtime adapter implementations
- `.agent/modules/runtime-adapters.md` — adapter registry and license notes
