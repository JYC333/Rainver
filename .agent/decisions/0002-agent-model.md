# ADR 0002: Agent Is A Separate Model From User

Date: 2026-05 (original)

## Status

Accepted. Runtime selection is governed by
[ADR 0022](0022-acp-runtime-authority-and-schema-epoch.md): AgentVersion
selects no runtime, and runtime deployment is the `AgentRuntimeProfile`'s
authority.

## Context

Early designs conflated "user" and "agent", treating an AI agent as a type of
user. That left three questions unanswerable: who owns what data, whose
permissions apply, and how one user has several agents.

## Decision

### 1. Two models

- A **User** is a human person, identified by `user_id`.
- An **Agent** is an AI runtime entity with its own row in `agents`. One user
  may create and own many agents.

An Agent is owned by a user (`owner_user_id`), shared by a Space, or bound to
a Project (`project_id`); `agent_kind` distinguishes standard agents from
system-provided ones. No concrete built-in agents are seeded: built-in
behaviour ships as system Agent Templates (factories), and concrete agents are
created on demand by copy-on-create.

An Agent's behaviour is described by its versioned record — role
instruction, context policy, memory policy (including `requires_proposal`),
capabilities, and tool/output policy. Runtime and model selection belong to
the `AgentRuntimeProfile` that deploys it, not to the version. The column set
is code-owned (`server/src/db/schema/agents.ts`) and is not enumerated here.

### 2. The instructing human is resolved per message

A Run's instructing human is not a property of the container the Run was
started from. In a multi-party conversation it is resolved from the specific
message that triggered the Run — that message's sender, not the conversation's
creator or owner. A container may record an originator for ownership and
lifecycle, but that originator grants no speaking rights and is never
substituted for the per-message instructing human.

This is a security boundary, not a convenience. `instructed_by_user_id` is the
retrieval viewer identity: policy denies retrieval tools outright when it is
absent, and an agent sees only what the instructing human may see. Resolving
it from the container would let one speaker's instruction execute under
another member's retrieval visibility and spend another member's credential
capacity.

## Consequences

- Users and agents have independent identity, permissions, and memory
  policies.
- Several users may share a Space-owned or system agent.
- Runtime deployment is chosen by the Agent's `AgentRuntimeProfile`, not by
  the Agent or its version (ADR 0022).
- An Agent Run carries `agent_id` (the executing agent) and
  `instructed_by_user_id` (the human, per message); the latter is nullable,
  and retrieval tools are denied when it is absent.
- Memory policy on the Agent restricts which memory scopes it may read,
  enforced at the Runtime Context and memory read boundaries.
