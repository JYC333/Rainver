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
`GET /api/v1/providers` lists a disabled provider (or a disabled grant) only
to the provider's owner, so they can enable it again; nobody else sees it, a
run never resolves it, and pickers use the client's `providersApi.usable()`,
which keeps only enabled providers with an enabled grant.

Auxiliary system tasks can bind to provider/model chains through
`provider_task_policies`. The retrieval settings UI surfaces the retrieval
tasks `retrieval_embedding`, `retrieval_rerank`, and
`retrieval_query_rewrite` as space-scoped provider/model choices; owner/admin
users edit these policies, while invocation still resolves credentials through
the provider command store and pool/fallback path. Retrieval embedding dimension
is a normalized space setting; provider adapters map it to request parameters
where supported and validate the returned vector length. Vectors are matched
to inputs by position, so a batched adapter (Cohere) also refuses a batch that
returns fewer vectors than it was sent rather than shifting every later vector
onto the neighbouring chunk.

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
/api/v1/providers/subscription-quota-policy`, owner/admin to change through
`provider.subscription_quota_policy.set`, shown on
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
`cli_profile_or_model_provider`.** Claude Code and Codex CLI declare
`cli_profile`: they run on the execution Host's own vendor login, and
`assertBackendModeBinding` refuses a `model_provider` Profile for them with
422. `server/test/runtimeAuthority.test.ts` pins the registry fact that refusal
reads — `supportsRuntimeBackendMode("claude_code", "model_provider")` is
`false` — not the route's status code. The frame builders for an Anthropic
or Codex provider binding are in `runs/remoteProviderBinding.ts`. No Profile
can select the mode that reaches them. Do not treat those builders as a live
path.

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
`AgentRuntimeProfile` may select a ModelProvider granted to the Space and explicit model
when the runtime supports that protocol (`backend_mode = model_provider`) and
the Profile names an execution Host and installation — the built-in Server
Runtime or a paired Host. Native mode instead uses the runtime's login on the
selected Host. The Profile snapshot is frozen into each Run, so changing a live Profile
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


## Provider Risks to Document

| Provider | Risk |
|---|---|
| Anthropic (Claude) | Data sent to Anthropic servers; not for private/sensitive enterprise data without a data processing agreement |
| OpenAI (Codex) | Same; OpenAI API terms apply |
| Any cloud LLM | Accepted Runtime Context Delivery may include Memory and Project data. Review egress policy and sensitivity ceilings before using a third-party provider |
| Trusted local deployment | No external data transmission when the declaration holds; see "Local deployments" below |

## Local deployments

Whether a Provider call is a *local* egress (allowed while a Space's
`external_egress_enabled` is off, and for Sources whose class is
`local_provider_allowed`) is decided by `providerEgressDestination`
(`retrieval/egress/egressPolicy.ts`) from three facts that must all hold:

1. The Provider is declared `deployment: "trusted_local"` (stored in
   `model_providers.config_json`, exposed as `deployment` on the DTO). Only a
   self-hostable vendor (`VendorDescriptor.selfHostable`: `ollama`,
   `openai_compatible`) may carry the declaration, and only a Space owner or
   admin may make it (`ProviderCommandStore.requireSpaceOwnerOrAdmin`); the
   Provider owner alone cannot. The same vouch is required again whenever a
   declared Provider is pointed at another endpoint (`base_url` or either
   compatible bridge URL), changes vendor, or is re-declared. The declaration
   counts only in the Provider's home Space (`model_providers.space_id`),
   where it was vouched: granted into another Space, nobody there vouched for
   it, so there it is external.
2. The endpoint the call will reach is inside this instance's network
   (`isInstanceNetworkUrl`): `localhost`/loopback, a private, link-local or
   otherwise non-public address, a single-label name such as a Compose
   service, or a `.local`/`.lan`/`.internal`/`.home.arpa` style suffix. A
   public address or public-looking name is external however it is declared.
   For a CLI runtime bound to the Provider, the endpoint judged is the
   compatible bridge URL the runtime will actually use.
3. The model the call will run is not one the vendor serves from the cloud:
   Ollama's `-cloud`/`:cloud` models are forwarded by a local daemon to the
   vendor's hosted service and are external.

The vendor name proves nothing (the same Ollama daemon serves hosted models),
and a loopback URL proves nothing (a local gateway may forward anywhere), so
an undeclared Provider is external. A Run's model override or a runtime's own
configuration cannot change the classification: the declaration and the
endpoint are the Provider's, and a cloud model chosen at run time is judged as
such. Every judgement uses the model the call will actually run: for a Run,
`effectiveRunProviderModel` (`runs/remoteProviderBinding.ts`) — the frozen
Runtime Profile's model, then the Run's override, then the Provider default,
then its first listed model, the order the binding uses — never the default
alone. A proxy lease issued for a destination judged local carries that model
(`pinned_model`), and the provider proxy refuses a request naming any other
model (`403 provider_proxy_model_not_leased`).

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


## Prompt method revision

Reading description generation and controlled method comparisons are bounded
ProviderTask Runs (`prompt_revision` / `prompt_method_comparison`), not personal
research Agents. The default is the enabled task-policy primary or granted Space
chat default; explicit advanced overrides retain credential eligibility and live
grant checks. Calls pin one concrete Provider/model with no cross-provider fallback.
`boundedProviderTaskRun.authorizeAttempt` permits a domain guard in the canonical
Delivery transaction; Reading uses it to fence Source/full-audience authority and
actual destination. The optional shared abort deadline propagates through the
existing Pi provider fetch/stream path. See [Reading methods](../architecture/READING_METHODS.md)
for private origins, two-target versions, quotas and cancellation limits.

## API subscription plan quota

The Usage page's subscription tab includes owner-only API plan quota, separate
from the historical Token/cost ledger and CLI account pools. `GET
/api/v1/providers/plan-usage` lists supported enabled API-key Providers owned by
the viewer with an enabled grant and active membership in the current Space;
it never contacts a vendor. `POST /api/v1/providers/:configId/plan-usage` is
`provider.plan_usage.refresh`, a system command (`SYSTEM_ACTIONS.md` "System
settings and tool configuration commands"): it answers a receipt, the worker
makes one read-only quota request using that Provider's primary credential
after commit, and the snapshot is released only by the issuer's status read
`GET /api/v1/system/commands/:commandId`.
Sharing permission to invoke a Provider does not share its account quota.

`providers/planUsage/` owns endpoint selection, vendor parsing and the read
service. It reuses the encrypted Credential resolver and active grant's
NetworkProfile; there is no new credential store, scheduler, quota cache table,
model call, pool rotation or pool health update. The settled snapshot lives
only in the command's own intent row (`system_command_intents`, the settings
block's durable command owner) for the issuer's status read. The quota page automatically queries every listed API Provider on entry and with
its shared "Refresh all quotas" action. At most three API requests run at once
within the section, each card updating as its own answer arrives, and one
account's failure does not stop the remaining accounts; a card stops showing
refresh activity once its own answer settles. A second refresh by the
same person for the same Provider and Space while one is active is refused
(409 `system_command_busy`, with the active command's id) instead of a second
vendor request; inside one worker, concurrent queries for the same key revision
still share one request. After the
vendor answers, the server re-reads the caller's grant and refuses (409) if the
Provider, key revision, base URL or effective NetworkProfile changed meanwhile —
a different profile id (a Space grant's profile changes without moving the
Provider's revision) or the same profile edited or disabled in place (its
`updated_at`, which every profile edit moves). The worker's settle step then rechecks the
person's live actor and Provider authority before recording the snapshot, and
every status read resolves the reader's own session: a session signed out
during the vendor wait gets the 401 a new request would, and an account
disabled meanwhile leaves the command `needs_attention` with no snapshot kept. Existing
same-page readings remain visible with their measured time while refreshing;
returning to the page always queries again. No browser persistent quota cache or
background interval is used. Results remain only in the current page. A failed query clears that account's
reading; the UI distinguishes not queried, failure, measured zero and exhaustion.
Provider/key revisions and access are rechecked after the network request.
No account identity is inferred from the Rainver user or API key, so distinct
Provider connections remain separate rather than claiming a shared account.
Additional pool credentials are not queried by this first API-plan integration.

Only exact official HTTPS origins are eligible; custom gateways are excluded.
MiniMax's domestic/international API origins select the matching official
`www.minimaxi.com` / `www.minimax.io` `/v1/token_plan/remains` endpoint.
MiniMax reset times follow MiniMax's own CLI (`mmx-cli` 1.0.28,
`QuotaModelRemain`): `end_time`/`weekly_end_time` are epoch milliseconds and
`remains_time`/`weekly_remains_time` are millisecond durations. A future end
time wins; an end already past, below epoch-millisecond magnitude, or more than
31 days ahead falls back to the duration, and no reset is shown when neither is
plausible. Values are never rescaled by guesswork.
Kimi Code uses `/coding/v1/usages` on `api.kimi.com` / `api.kimi.ai`; Z.ai and
BigModel Coding Plan use `/api/monitor/usage/quota/limit` on `api.z.ai` /
`open.bigmodel.cn`. General Moonshot/prepaid Z.ai balance APIs are not plan
quota and are excluded. Redirects are refused, requests time out after 15s,
and only normalized windows/timestamps leave the collector. Error bodies and
credential-bearing transport errors are not returned or logged. Rainver uses
its own User-Agent, not another client's identity.

Official references (checked 2026-11-07):

- [MiniMax domestic Token Plan](https://platform.minimaxi.com/subscribe/coding-plan)
  and [international Token Plan](https://platform.minimax.io/subscribe/token-plan).
- [Kimi Code API configuration](https://www.kimi.com/code/docs/) and
  [official usage implementation](https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/managed-usage.ts).
- [Z.ai official usage-query implementation](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs).

MiniMax was verified with the existing test instance's real subscription on
2026-11-07; both 5-hour and weekly readings were returned. Kimi and Z.ai are
implemented from official references and intentionally not account-tested in
this change, per the requested scope. They are labelled unverified in the UI.


### Delivery and verification record

The CLI quota/account presentation is documented in [Credentials](credentials.md#subscription-quota)
and [Hosts](hosts.md); the API-plan implementation was merged to `dev` as
`89203593` on 2026-11-08. Final native-session checks passed: 9 provider-contract
cases, 78 server cases (including real PostgreSQL authorization, credential changes
and route checks), and 65 web cases; affected type checks and server/web builds
also passed. Earlier full-suite runs had unrelated failures and are not evidence
of an entirely green suite. MiniMax's real-account verification and Kimi/Z.ai's
explicitly untested status remain as described above.

The completed subscription-usage implementation plan was retired on 2026-11-08;
its step-by-step implementation and historical test logs remain in Git history.
This guide and the linked owning module guides retain the current behavior,
permissions and supported limits; the retired plan is not an active work queue.
