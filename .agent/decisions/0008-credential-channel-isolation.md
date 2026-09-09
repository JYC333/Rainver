# ADR 0008: Credential Channel Isolation

Date: 2026-06-02 · revised 2026-09-08

## Status

Accepted. Storage detail lives in
[`architecture/CREDENTIAL_STORAGE.md`](../architecture/CREDENTIAL_STORAGE.md).
Revised 2026-09-08: the invariant is unchanged, but the CLI channel it
describes moved off the server. [ADR 0016](0016-control-plane-execution-hosts.md)
retired the credential broker, the CLI credential profiles and the server-side
subprocess allowlist; the enforcement point named below is the host daemon's
environment filter now.

## Context

An earlier internal policy required all Anthropic execution to go through the
Claude Code CLI, framed as "Anthropic is CLI-only". That framing was too
broad. The real concern was one operational failure: an Anthropic API key
leaking into the environment of a Claude Code subprocess, where it conflicts
with the CLI's own OAuth login state.

Three model-execution credential channels exist and are architecturally
separate:

- **CLI channel.** Local CLIs run on an execution host, never in the server
  process. Since [ADR 0016](0016-control-plane-execution-hosts.md) the control
  plane brokers no CLI credential at all: a CLI's login lives with the copy on
  the host. The environment rule moved to the daemon
  (`packages/host-daemon/src/execution.ts`,
  `packages/host-daemon/src/providerBinding.ts`), and the rule differs by trust
  mode. On a **strict** host every Run's environment is allowlist-filtered,
  bound or not — the container is nobody's machine, so it contributes nothing.
  On a **trusted** host, a Run **bound to a ModelProvider** is filtered and
  given the lease the control plane injected, so the machine contributes no
  backend or credential (B67); an unbound Run there keeps the owner's own
  environment and spends the copy's own login, which is the point of pairing
  it.
- **In-process API channel.** Provider tasks, `/api/v1/providers/chat`, and
  the `model_api` / `ts_agent_host` adapters resolve the key from the
  encrypted ModelProvider credential (`resolveProviderApiKey`) and pass it as a
  parameter to the managed chat adapter (`@earendil-works/pi-ai` behind a
  single adapter). The channel never writes the environment, so it is
  unreachable from any subprocess. Which library sits behind the adapter is
  incidental and not part of the invariant.
- **In-process managed subscription channel.** Claude Pro/Max and OpenAI
  Codex OAuth credentials are connected by the instance admin, encrypted in
  DB rows, refreshed under a cross-process row lock, and passed only to the
  in-process provider transport. They never borrow or mutate CLI profiles and
  never join API-key pools or rotation.

## Decision

### 1. The invariant is channel isolation, not vendor routing

> An Anthropic API key must never enter the environment of a Claude Code
> subprocess.

The same holds for managed OAuth material: no Claude or Codex OAuth
access/refresh token may enter another user's request, a CLI profile, a
pool, an ambient environment, or a persisted execution artifact.

Therefore:

- the in-process API channel may serve **any** provider, Anthropic included,
  as long as the key is passed in process and never written to the
  environment;
- vendor-neutral managed API adapters are sanctioned; their model calls stay
  in-process, governed tool calls use the System Action boundary, and they
  provide no file sandbox merely by selecting a provider;
- the subscription channel serves only its credential owner; login, quota
  refresh, and disconnect additionally require the instance admin, and
  invocation checks ownership before decrypting or refreshing.

### 2. Enforcement points

- `claude_code` and every other local CLI remain `local_cli` specs. They carry
  no credential reference: the control plane refuses a `credential_profile_id`
  on an Agent runtime profile outright (`agents/routes.ts`,
  `agents/repository.ts`), because a CLI Agent names an execution host and an
  installation on it instead.
- There is no ambient `ANTHROPIC_API_KEY` fallback for CLI execution, and no
  canonical adapter reads provider keys from ambient env or settings. The
  enforcement point is now the daemon's environment filter, guarded by
  `packages/host-daemon/test/providerBinding.test.ts` and
  `packages/host-daemon/test/execution.test.ts`; the control-plane half is
  guarded by `server/test/providersCredentialsAuthority.test.ts`.
- Vendor CLI support is spec data, not Agent or provider foundation code.

### 3. Channel selection weighs execution shape and funding source equally

Consistent with the dual funding paths of
[ADR 0010](0010-agent-workbench-product-direction.md), a rule based on
execution shape alone would make a user's paid subscription unreachable for
conversation:

- filesystem execution uses a supported CLI adapter and its host boundary;
  managed API agent loops may use explicitly granted server-side tools; tool
  use alone does not require a CLI or permit arbitrary filesystem access;
- no-tools text generation may use either channel — the in-process API
  channel by default, a local CLI when the user is spending subscription
  capacity rather than API budget;
- conversation is therefore a supported CLI surface, not an API-only one.

A CLI-backed conversation binds the signed-in speaker's own choice of host and
installation, stored on the user × session binding and frozen into each Run.
`AgentRuntimeProfile` carries transport/model policy only and has no credential
field. On a **paired** host that choice is the owner's own machine, so one
member's capacity is not spent on another's instruction. On the **built-in**
host there is one copy per instance and everyone spends it — inherent to a
shared host, and stated in [ADR 0016](0016-control-plane-execution-hosts.md) §3
rather than papered over here.

### 4. A CLI in provider mode holds a lease, never the key

When a CLI runs against a configured ModelProvider it receives a
provider-proxy URL and a short-lived lease token; the upstream key is resolved
inside the server proxy boundary and substituted there. Locality of the proxy
is not the property doing the work: the proxy binds `0.0.0.0`, the URL is
built from `SANDBOX_RUNNER_SERVER_HOST` (the Compose service name) and
`PROVIDER_PROXY_PORT`, and a paired execution host
([ADR 0016](0016-control-plane-execution-hosts.md)) reaches it across the
user's private network. Transport protection for the token is a deployment
property (see the deferred register's TLS rows), not a channel-isolation
property.

State the lease's real scope, because this is the basis remote bindings are
reviewed against. A lease pins the upstream **base URL**, the route family
(`anthropic` / `openai`), and attribution metadata. It does **not** pin the
model (`lease.model` is attribution only; the proxy forwards the body
verbatim), the path under the base URL, or request count or spend. Its TTL is
the Run timeout plus 300 s, and every CLI spec's `max_timeout_seconds` is
3600, so a worst-case lease lives about 65 minutes. A holder of a live token
can spend the Space's provider credential against any model and endpoint at
that upstream until the Run ends or the lease is revoked.

What stays true, and is the channel-isolation claim: no API key and no OAuth
token ever becomes network-reachable. **B67** adds the host-side counterpart:
a provider-bound Run must not inherit ambient backend selection from the
executing machine.

## Consequences

- Channel choice is a routing decision over execution shape, funding source,
  credential availability, trust level, and sandbox requirement — not a fixed
  vendor rule.
- The in-process API channel is the system's LLM primitive layer (embedding,
  rerank, query rewrite, synthesis, checkpoint extraction, intent planning)
  and also supplies CLI provider mode through the proxy. A CLI runtime cannot
  replace it; `model_api` is its projection into the Run domain, not a
  competitor to the CLI runtimes.
