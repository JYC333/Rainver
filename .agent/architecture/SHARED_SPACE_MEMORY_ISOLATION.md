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

`memory_entries.agent_id` is producing-Agent provenance only. It does not make
a Memory readable through that Agent and is absent from every Memory selection
and authorization predicate.

The database accepts only `scope_type IN ('user', 'project')`. User Memory has
no `project_id`; Project Memory requires one. `memory_entries` has no Project
Folder column: Project is the sole shared Memory attribution layer. System rules
live in `policies`, and Agent/capability learning lives in `evolvable_assets`.

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
normal-sensitivity write about the person in the turn applies directly and is
read afterwards ([ADR 0003](../decisions/0003-memory-proposal-flow.md)). Since
a direct write is private to one person by construction, nothing here changes
what crosses a Space boundary. New user-owned memory defaults to `private` in
personal, household, and team Spaces. Sharing is an explicit post-approval
policy update. Owner and subject are distinct fields; accepting a
proposal never transfers ownership to the reviewer.

## Runtime

HTTP reads, retrieval revalidation, maintenance, and context injection use the
same SQL predicate from `server/src/modules/access/contentAccessSql.ts`.
Memory-specific code may only add sensitivity and redaction
restrictions. It must not implement a second owner/visibility rule.
