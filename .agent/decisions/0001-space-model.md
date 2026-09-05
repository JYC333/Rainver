# ADR 0001: Space As Product-Level Isolation Boundary

Date: 2026-05 (original)

## Status

Accepted.

## Context

The system serves personal users, households, and small teams from a single
deployment and needed one top-level isolation model. Options considered:

- personal-only (one user = one installation);
- tenant model (enterprise multi-tenancy with complex ACLs);
- Space model (product-level containers with flexible membership).

## Decision

### 1. Space is the product-level container

A Space:

- is the primary isolation boundary for all data;
- has a type: `personal`, `household`, or `team`;
- has an owner and members (`space_memberships`);
- contains Projects, Project Folders, Agents, memory, sessions, tasks, and
  runs;
- has its own policy configuration.

"Tenant" is avoided: Spaces are product-level, not infrastructure-level. One
deployment instance hosts many Spaces; an instance per Space is never created.

### 2. Every core record carries `space_id`

`space_id` is required, never optional. Users may belong to several Spaces
through membership. Projects and Project Folders belong to Spaces, not to
users.

The content read gate and the Runtime Context Gateway refuse to resolve
content without an explicit Space; there is no ambient or default Space on
the server side.

### 3. Isolation is user-centred, with one enumerated exception

Data from Space A must never appear in context built for Space B, **except in
a per-user aggregated read where every contributing Space independently
applies its own `contentAccessSql` predicate for that same user.**

The exception exists because [ADR 0013](0013-personal-team-content-boundary.md)
moves all context-free capture into the personal Space, which holds none of
the user's team content; a Space-centred rule would leave the personal
assistant structurally unable to answer anything about the user's own team
work. The invariant that matters is preserved: a user never gains sight of a
row they could not already read in the Space that owns it. What is relaxed is
only the assumption that one context build serves exactly one Space.

The aggregated read is sound only while all five hold:

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
   default). Output fusing two or more Spaces is never persisted
   automatically.
5. **Cross-Space lookup by id still 404s.** A direct read of a resource id
   outside the request Space remains a 404 with no existence oracle. The
   exception applies only to the aggregated retrieval path enumerated in
   ADR 0013.

The other intentional cross-Space exceptions (`/me` aggregation, personal
memory grants, targeted publications, egress approval) are pointer-metadata
reads and are documented in
[`architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
section 8. The aggregated read is the only one whose payload is content —
hence constraint 3.

## Consequences

- Space isolation applies to every module; a new domain joins by carrying
  `space_id` and passing through the canonical read gate.
- Every cross-Space read path must be enumerated and individually justified;
  there is no general mechanism for widening.
- Personal Spaces are high-traffic by design (ADR 0013), which is why the
  aggregated read had to exist rather than being avoided.
