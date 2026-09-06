# Shared Space memory isolation

## Invariant

A Space is the outer collaboration boundary, not a shared mind. Every Memory
read first requires active Space membership, then Project scope access, then
canonical content access.

## Memory layers

| Layer | Carrier | Boundary |
|---|---|---|
| Personal | `memory_entries.scope_type=user` | owner-private |
| Project | `memory_entries.scope_type=project` | `project_members` ACL |
| Capability | `evolvable_assets` | Agent/capability evolution policy |
| Agent | `memory_entries.scope_type=agent` | the Agent, with its owner as the person who reads and reverses |

In the `user` and `project` layers `memory_entries.agent_id` is
producing-Agent provenance only: it does not make a Memory readable through
that Agent and is absent from every Memory selection and authorization
predicate there. The `agent` layer is the exception the column exists for
([ADR 0003](../decisions/0003-memory-proposal-flow.md) §4) — there it is the
ownership key, and `agentMemoryDelivery.ts` selects on it. That layer is
private by CHECK, Project-free, has no subject, and is excluded from the
person-facing retrieval index entirely: what an Agent knows about itself and
about a Room reaches the Agent through its own delivery path, under an
audience filter, and reaches nobody else but the Agent's owner on the Memory
page — Space oversight included, which is the one place the general access
model below does not extend to (`memoryAgentScopeReadSql`): an admin who is not
on the origin Room's roster is not the audience the note was delivered to.

The database accepts `scope_type IN ('user', 'project', 'agent')`. User Memory
has no `project_id`; Project Memory requires one; Agent Memory has none and
requires both an `agent_id` and an `owner_user_id`. `memory_entries` has no
Project Folder column: Project is the sole *shared* Memory attribution layer.
System rules live in `policies`, and Agent/capability learning — how an Agent
*works*, as opposed to what it knows — lives in `evolvable_assets`.

## Access model

| Visibility | Readers |
|---|---|
| `private` | owner base access; grants are never consulted |
| `space_shared` | scope-eligible active Space members; optional grants may upgrade disclosure |
| `selected_users` | owner and active same-Space grantees in `content_access_grants` |

An active Space owner/admin may additionally receive read-only oversight over
otherwise-hidden rows when the Space's immutable creation-time mode is
`summary`, `content`, or `full`. Oversight does not bypass scope and grants no
write, publication, proposal, or grant-management authority.

`access_level` is independent. Effective disclosure is widest-wins across the
ordinary visibility result, an active grant, and eligible oversight:
`space_shared` grants can upgrade summary to full, while a `selected_users`
grant's level is authoritative for that reader. `sensitivity_level=highly_restricted`
requires `private` visibility and remains owner-only except for an eligible
owner/admin in a `full`-oversight Space. It remains excluded from shared context
blends, digests, public summaries, and maintenance outputs.

Project placement is a scope gate, not a visibility value. Project Memory is
only considered after the caller passes the Project membership check.

## Writes

A write that would widen reach is proposal-gated; an Agent's own private,
normal-sensitivity write applies directly and is read afterwards
([ADR 0003](../decisions/0003-memory-proposal-flow.md)). Two kinds qualify: a
`user`-scope entry about the person in the turn, and an `agent`-scope entry the
Agent writes about itself or about the Room it is in, owned by the Agent's
owner. Both are private to one person by construction, so nothing here changes
what crosses a Space boundary. New user-owned memory defaults to `private` in
personal, household, and team Spaces. Sharing is an explicit post-approval
policy update. Owner and subject are distinct fields; accepting a
proposal never transfers ownership to the reviewer.

## Runtime

HTTP reads, retrieval revalidation, maintenance, and context injection use the
same SQL predicate from `server/src/modules/access/contentAccessSql.ts`.
Memory-specific code may only add sensitivity and redaction
restrictions. It must not implement a second owner/visibility rule.
