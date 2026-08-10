# Decision 0001: Space as Product-Level Isolation Boundary

## Status
Accepted

## Context
The system needed a top-level isolation model that could serve personal users, households, and small teams from a single deployment. Options considered:
- Personal-only (one user = one installation)
- Tenant model (enterprise multi-tenancy with complex ACLs)
- Space model (product-level containers with flexible membership)

## Decision
Use **Space** as the product-level container instead of personal-only or tenant-only terminology.

A Space:
- Is the primary isolation boundary for all data
- Has a type: `personal`, `household`, or `team`
- Has an owner and members (via SpaceMembership)
- Contains workspaces, agents, memories, sessions, tasks, and runs
- Has its own policy configuration

## Consequences

- All core data records carry `space_id` — required, never optional
- One deployment instance hosts many spaces — do not create one instance per space
- ContextBuilder refuses to build context without an explicit `space_id`
- The term "tenant" is avoided — spaces are product-level, not infra-level
- Users can belong to multiple spaces (via SpaceMembership)
- Workspaces belong to spaces, not users
- Data from space A must never appear in context built for space B
  (**amended 2026-08-06 — see below**)

---

## Amended - 2026-08-06

Amended by [ADR 0013](0013-personal-team-content-boundary.md), which moves all
context-free capture into the personal Space. That makes the personal
assistant's conversation live in a Space that holds none of the user's team
content, and the last consequence above would leave it structurally unable to
answer anything about the user's own team work.

### What changes

The last consequence is narrowed from a Space-centred rule to a **user-centred**
one:

> Data from space A must never appear in context built for space B, **except in
> a per-user aggregated read where every contributing Space independently
> applies its own `contentAccessSql` predicate for that same user.**

The isolation invariant that actually matters is preserved: a user never gains
sight of a row they could not already read in the Space that owns it. What is
relaxed is only the assumption that one context build serves exactly one Space.

### Constraints on the exception

These are part of the amendment, not implementation detail. The aggregated read
is only sound while all five hold:

1. **Per-Space predicate, no union shortcut.** Each contributing Space's rows
   pass through `contentAccessSql` with that Space's membership, scope,
   oversight mode, and grants. There is no cross-Space predicate and no
   "member of any Space" shortcut.
2. **Read-only, and no write follows the read.** The aggregated path resolves
   content for one turn. It grants no write, publish, proposal, or
   grant-management authority in any contributing Space.
3. **Cross-Space results do not persist in the reader's Space.** Only
   `(space_id, resource_type, id)` pointers persist. Content is re-resolved on
   next use, so membership revocation takes effect without a cleanup job.
4. **Derived output is attributed by source Space.** Output attributable to a
   single source Space is written back to that Space (owner-private by
   default). Output fusing two or more Spaces is never persisted automatically.
5. **Cross-space lookup by id still 404s.** Nothing here changes single-resource
   routes: a direct read of a resource id outside the request Space remains a
   404 with no existence oracle. The exception applies only to the aggregated
   retrieval path, which is enumerated in ADR 0013.

The existing intentional cross-space exceptions (`/me` aggregation, personal
memory grants, targeted publications, egress approval) are unchanged and remain
documented in
[`.agent/architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
section 8. This amendment adds a fifth, and it is the only one whose payload is
content rather than pointer metadata — hence constraint 3.
