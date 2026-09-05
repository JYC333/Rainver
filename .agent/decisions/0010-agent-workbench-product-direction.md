# ADR 0010: Personal + Small-Team Agent Workbench Direction

Date: 2026-07-11

## Status

Accepted.

## Decision

For the two quarters from 2026-07, Rainver is a **server-authoritative Agent
Workbench for individuals, households, and small teams**, intended to carry
substantial daily work: research, writing, knowledge synthesis, project
execution, recurring workflows, automation, and code.

The product does not begin as single-user software with collaboration
deferred. Personal, household, and small-team Spaces are first-order product
contexts from the start. Shared tasks and work products, member permissions,
private-versus-shared context, and auditable human/agent collaboration are
core requirements.

Memory, Knowledge, Context, Sources, Artifacts, Tasks, and Proposals are the
durable substrate. Agent orchestration and automation are execution
capabilities. Controlled self-evolution is a supporting internal capability,
not the product identity.

## Runtime stance

CLI subscription capacity and paid APIs are **dual primary funding paths**,
selected by task shape rather than by a universal API-first rule
([ADR 0008](0008-credential-channel-isolation.md) decision 3).

- Subscription usage is a real product resource for substantial
  user-initiated or user-supervised work.
- Claude Code, Codex CLI, and OpenCode are peer local CLI runtimes, all
  driven through the Agent Client Protocol ([ADR 0007](0007-multi-cli-mvp.md)
  decision 3). None is the preferred universal runtime, none replaces the
  managed API path, and none receives a global preference order. Each is
  independently disableable, and no core workbench authority depends on any
  of them.
- A subscription is spent only through the vendor's own CLI (Claude Pro/Max
  through Claude Code, ChatGPT plans through Codex, each reached via its ACP
  wrapper) or through Rainver's in-process managed subscription OAuth channel
  ([ADR 0008](0008-credential-channel-isolation.md)); it is never routed
  through another vendor's runtime.
- Managed API work uses `model_api` / `ts_agent_host` and the in-process
  provider invocation boundary. Separately, a CLI may use an explicit
  ModelProvider proxy binding under ADR 0008; that does not replace the managed
  API path or release the upstream key to the CLI.
- Provider capability, remaining subscription allowance, API cost, latency,
  sandbox level, audit needs, and vendor terms all participate in routing.
  Routing must expose allowance, cost, and failure state without conflating
  subscription with API spend.
- Consumer CLI credentials stay isolated through `CredentialBroker`.
  Subscription sessions are never converted into ambient API credentials or
  shared across users.
- Unattended programmatic driving of a consumer subscription is not assumed
  to be permitted merely because interactive use is. Where vendor terms are
  ambiguous or restrictive, the unattended path uses the vendor's API/SDK or
  stays disabled.

## Consequences

- Prioritisation favours end-to-end work outcomes and shared-Space usability
  over isolated infrastructure breadth.
- Personal privacy stays first-class inside household/team deployments
  ([ADR 0013](0013-personal-team-content-boundary.md)).
- The memory system is judged by how well it supports ongoing work, not by
  volume.
- Self-evolution stays subordinate to human-reviewed reliability and real
  use.
