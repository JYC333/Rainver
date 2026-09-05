# ADR 0002: Agent Is A Separate Model From User

Date: 2026-05 (original)

## Status

Accepted.

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

An Agent's behaviour is fully described by its versioned record — role
instruction, model configuration, runtime policy (including
`allowed_adapter_types`), memory policy (including `requires_proposal`),
capabilities, and tool/output policy. The column set is code-owned
(`server/src/db/schema/agents.ts`) and is not enumerated here.

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
- `allowed_adapter_types` on the Agent restricts which runtime adapters a Run
  may select.
- Every Run carries both `instructed_by_user_id` (the human, per message) and
  `agent_id` (the executing agent).
- Memory policy on the Agent restricts which memory scopes it may read,
  enforced at the Runtime Context and memory read boundaries.
