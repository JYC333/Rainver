# ADR 0003: Agent Memory Writes Are Bounded and Reviewable, Not Pre-Approved

Date: 2026-05 (original)

## Status

Accepted.

## Context

Memory needs provenance, versioning, visibility controls, and a practical way
for a person to inspect and reverse writes. Requiring separate approval for
every low-risk entry creates a repetitive queue that obscures the decisions
that actually widen reach. This ADR keeps approval for those decisions and
requires bounded, attributable, reversible writes for the rest.

## Decision

**Agents write memory within bounds and under review-after.** The conditions
in section 1 and the Agent's `requires_proposal` policy determine which writes
need approval in advance. This applies ADR 0017 to memory.

### 1. Gated writes (a proposal, approved per instance)

A memory write is a proposal when it would:

- widen `visibility` (private → space-shared or team), or raise
  `sensitivity_level` above `normal`;
- concern another person (`subject_user_id` is not the acting user);
- replace or archive content a person authored (`created_by` is a user), or
  content another Agent authored — an Agent revises what it wrote, and
  someone else's record of the same person is the person's call;
- originate from any trigger origin other than a person in a conversation
  (`manual`) — post-session reflection, activity-to-memory pipelines,
  consolidation and maintenance jobs, and every external import keep the
  proposal flow unchanged;
- be a `memory_maintenance_packet` (bulk change by construction).

### 2. Bounded writes (applied directly, as a new version)

Everything else — an Agent in a `manual`-origin session creating a personal,
normal-sensitivity entry, or revising one it authored — applies directly,
subject to:

- **always a new version**, never in place: the prior version is retained
  and restoration archives the superseding version before restoring the prior
  one; two versions on the same chain must not be active together;
- **provenance is mandatory**: session, run, rationale, and `created_by =
  agent:<id>`; a write without them is rejected at the applier, not
  approved by a person;
- **no count limit.** A cap on how many memories a session may write was
  considered and rejected: memory's risks are reach and quality, both
  governed above and by pruning, not volume — and a cap whose overflow
  becomes proposals reinstates the human queue this ADR removes. The only
  volume mechanism is an operational circuit breaker: a person's writing,
  past an anomalous number of entries, is paused and flagged as a fault to
  investigate, never re-routed to a person to approve. It counts per person
  rather than per session because a Room conversation is one session shared
  by its members, and the way to clear it — archiving what was written — is
  only available to the owner of those entries. It counts within the session,
  or within the Run where there is none: a conversation outside a Room has no
  session. Count active entries plus pending proposals for that person and
  scope; ordinary revision does not increase the count, and archiving reduces it;
- **an Agent's memory policy may still opt into `requires_proposal`**, which
  requires proposal approval for that Agent even when the other conditions
  permit direct application. The canonical applier enforces it.

### 3. The counterpart: memory is observable and undoable

Direct writes are conditional on the person being able to see and reverse
them without ceremony:

- the Memory page shows every entry's provenance and version chain, filters
  by "written by an Agent since I last looked", and offers **archive and
  restore as direct actions for the person** — a person's own archive is not
  a proposal;
- each bounded write made during Project work appears in that Project's
  updates with a one-step undo (`archive_memory`); a write in a session with
  no Project is read on the Memory page, which is the only surface a
  Space-wide feed would have duplicated;
- the user's stated line stands: memory is never a black box.

Runtime continuity checkpoints (ADR 0014) remain derived reference context
and grant no authority to write memory; promotion from a checkpoint is a
write under this ADR.

## Consequences

- Room and chat memory-write actions land in the canonical applier under
  sections 1 and 2; adapters, jobs, and routes do not insert memory directly.
- The proposal applier remains the only writer of `memory_entries`; §2
  writes go through it with the acting Agent as author and no approver, and
  the applier enforces §1 and §2's conditions — no adapter, job or route
  inserts directly.
- External chat capture still creates Activity records first (B12).
- Memory quality is governed by versioning, provenance and pruning rather
  than by pre-approval; a bad memory is found and reversed, not prevented by
  a queue nobody reads.
- B10 is rewritten to state this decision.
