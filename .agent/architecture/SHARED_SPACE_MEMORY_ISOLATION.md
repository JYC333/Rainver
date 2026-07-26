# Shared Space memory isolation

## Invariant

A Space is the outer collaboration boundary, not a shared mind. Every Memory
read first requires active Space membership, then Project Folder/project scope
access, then canonical content access.

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

Project Folder and project placement are scope gates, not visibility values. A
Project Folder-scoped `space_shared` memory is only considered after the caller
passes the Project Folder/project access check.

## Writes

Memory writes remain proposal-gated. New user-owned memory defaults to
`private` in personal, household, and team Spaces. Sharing is an explicit
post-approval policy update. Owner and subject are distinct fields; accepting a
proposal never transfers ownership to the reviewer.

## Runtime

HTTP reads, retrieval revalidation, maintenance, and context injection use the
same SQL predicate from `server/src/modules/access/contentAccessSql.ts`.
Memory-specific code may only add sensitivity, system-scope, and redaction
restrictions. It must not implement a second owner/visibility rule.
