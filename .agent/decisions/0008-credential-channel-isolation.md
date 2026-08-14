# ADR 0008 - Credential Channel Isolation

## Status

Accepted - 2026-06-02.

## Context

An earlier internal policy required all Anthropic/Claude execution to go through
`adapter_type=claude_code`, framed as "Anthropic is CLI-only." That framing was too
broad. The real concern was never to forbid the Anthropic API — it was to prevent a
specific operational failure: an Anthropic API key leaking into the environment of a
**Claude Code CLI** subprocess, which conflicts with Claude Code's own auth (OAuth /
login state) and causes environment-conflict bugs.

Three model-execution credential channels exist and are architecturally separate:

- **CLI channel** — `claude_code` / `codex_cli` run as subprocesses. Their environment
  is rebuilt from an allowlist by `server/src/modules/runs/vendorCliAdapter.ts::buildSubprocessEnv`
  (only `PATH`, `TERM`, `SHELL`, `LANG`, `LC_*`, plus keys the `CredentialBroker`
  explicitly injects for a configured credential profile). Ambient `os.environ` is NOT
  inherited wholesale.
- **In-process API channel** — the provider command/runtime path
  (`server/src/modules/providers/` and managed API runtime adapters),
  `/api/v1/providers/chat`, and the `model_api` runtime adapter resolve the key
  from the encrypted `ModelProvider` Credential (`resolveProviderApiKey`) and pass it
  to litellm as a parameter. This channel never writes `os.environ`, so it is
  unreachable from any subprocess.
- **In-process managed subscription channel** — Claude Pro/Max and OpenAI Codex
  OAuth credentials are connected by the instance admin, encrypted in DB
  `Credential` rows, refreshed under a cross-process row lock, and passed only
  to pi-ai's in-process provider transport. This channel never borrows or
  mutates CLI profiles and never participates in API-key pools or rotation.

## Decision

The governing invariant is **credential channel isolation**, not "Anthropic is CLI-only":

> An Anthropic API key must never enter the environment of a Claude Code CLI subprocess.

The same isolation applies to managed OAuth material: no Claude or Codex OAuth
access/refresh token may enter another user's request, a CLI profile, a pool, an
ambient environment, or a persisted execution artifact.

Consequences of this reframing:

- The in-process encrypted API channel **may serve any provider, including Anthropic**,
  as long as the key is passed in-process (litellm parameter) and never written to
  `os.environ`.
- The reflector no longer rejects `provider_type=anthropic`.
- A generic, vendor-neutral `model_api` runtime adapter (native, no-tools, no-file
  sandbox, `credential_mode=model_provider_api_key`) is sanctioned and may select any
  configured `ModelProvider` + model, Anthropic included. It must obey the invariant:
  resolve via `resolveProviderApiKey`, pass as a litellm parameter, never via env.
- The in-process subscription channel may serve only its credential owner. Login,
  quota refresh, and disconnect additionally require the configured instance
  admin; invocation checks ownership before decrypting or refreshing the token.

## Invariants

- `claude_code` remains a `local_cli` `RuntimeAdapterSpec` using `cli_profile`
  credentials granted by `CredentialBroker`; it is the path for agentic / tool-using /
  filesystem Claude work.
- No ambient `ANTHROPIC_API_KEY` fallback for CLI runtime execution.
- `build_subprocess_env` allowlist is the enforcement point keeping CLI subprocess
  environments clean. Canonical runtime adapters must not read `ANTHROPIC_API_KEY` from
  ambient env/settings (guarded by provider/runtime adapter tests such as
  `server/test/runVendorCliAdapter.test.ts` and `server/test/providersCredentialsAuthority.test.ts`).
- The runtime adapter standard stays vendor-neutral; vendor CLI support is
  RuntimeAdapterSpec data, not Agent/provider foundation code.

## Channel selection

Execution shape and **funding/capacity source** are equal selectors, consistent with the
dual funding/access paths in ADR 0010. A rule based on execution shape alone would make a
user's paid CLI subscription unreachable for conversation, forcing separate API spend for a
model they already pay for.

- Tool-using / filesystem / agentic work uses a CLI runtime adapter.
- No-tools text generation may use either channel. The in-process API channel is the
  default; a local CLI runtime is selected when the user is spending subscription
  capacity rather than API budget.
- Conversation is therefore a supported CLI runtime surface, not an API-only surface.

Anthropic is permitted on all applicable channels, and the isolation invariant applies equally:
a provider API key must never enter a CLI subprocess environment. When a CLI runs against a
configured ModelProvider it receives only a local provider-proxy URL and a short-lived lease
token; the upstream key is resolved inside the server proxy boundary.

CLI credentials remain user-owned. A conversation backed by CLI subscription capacity
resolves the credential profile of the signed-in speaker, never a space-shared profile,
so one member's capacity is not spent on another member's instruction.
The selected `(runtime_profile_id, credential_profile_id)` is stored on the
user × session conversation binding and frozen into each Run's conversation
backend override. `AgentRuntimeProfile` contains transport/model policy only
and has no credential-profile field.

## Consequences

- Channel choice is a routing decision over execution shape, funding source, credential
  availability, trust level, and sandbox requirement — not a fixed vendor or shape rule.
- The in-process API channel remains the system's LLM primitive layer (embedding, rerank,
  query rewrite, synthesis, session condensing, intent planning, summary generation). That
  layer is not replaceable by a CLI runtime and also supplies CLI provider mode through the
  provider proxy.
- `model_api` is that layer's projection into the run domain, not a competitor to the CLI
  runtimes.

## Amended — 2026-08-14

The in-process API channel no longer passes the key to litellm. Managed chat
runs through `@earendil-works/pi-ai` behind a single adapter, and the key is
resolved by `resolveProviderApiKey` and handed to that adapter as a parameter.

**The decision is unchanged.** What this ADR forbids is a credential reaching a
provider through ambient environment or a CLI subprocess env, and what it
requires is that the server resolve it in process and pass it explicitly. Both
still hold; only the callee's name has changed. Read every "litellm parameter"
above as "a parameter to the managed chat adapter" — the isolation property was
never a property of litellm, and naming the library in the invariant is what
made the wording go stale when the library did.

Managed subscription OAuth, added after this ADR, follows the same rule: the
refresh token is DB-encrypted, the access token is decrypted in process and
passed as a parameter, and it never reaches a subprocess environment.
