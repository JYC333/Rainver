# ADR 0003: Agent Memory Writes Are Bounded and Reviewable, Not Pre-Approved

Date: 2026-05 (original)
Rewritten: 2026-08-28

## Status

Accepted.

## Context

In early versions agents wrote memory directly. That produced unreviewed,
low-quality memories with no audit trail, took control of what the Agent
"believes" long-term away from the user, and made bad memories hard to find
and prune. The 2026-05 decision answered with a gate: every memory change
became a proposal a person approves before it applies.

The gate fixed provenance and control at the volume of 2026-05. It does not
survive the product ADR 0010 describes, in which an Agent carries daily work
and memory changes arrive by the dozen: a person cannot review every one, so
either the Agent stops learning or the person stops reading and approves in
bulk. The second is what happens, and a gate that is approved without reading
protects nothing while still costing the ceremony. The person's own archive
of an entry they created also raises a proposal for themself to approve.

In this deployment the gate has never been exercised: `memory_entries` holds
no rows and no memory proposal has ever been created. Room and chat Agents
have no memory-write action at all — only `memory.retrieval.search` and
`memory.retrieval.brief` — and the pipelines that do draft memory proposals
(daily reports, activity extraction, run materialization) have produced none.
The Agent does not learn; the only thing it retains across sessions is the
derived runtime-context checkpoint of ADR 0014, which is reference context,
not memory. The bottleneck is therefore not the person reviewing writes; it
is that no write path exists for the person to be a bottleneck on. This ADR
defines that path and its governance together, so the path does not arrive
first and the governance later.

Meanwhile the schema grew the properties that make pre-approval unnecessary
for most writes: every entry is a version (`supersedes_memory_id`,
`root_memory_id`), carries provenance (`created_by`, `source_id`,
`source_trust`, `created_from_proposal_id`, session and run), and has
`visibility`, `sensitivity_level`, `subject_user_id` and `scope_type`
columns that say exactly what a write would expose. A write with those
properties is reversible and attributable — which is what the 2026-05 gate
was standing in for.

## Decision

**Agents write memory within bounds and under review-after; a person
approves in advance only the writes that change reach.** This applies ADR
0017 to memory.

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
  and one action restores it;
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
  session, and an unbounded surface is what this exists to prevent;
- **an Agent's memory policy may still opt into `requires_proposal`**, which
  restores the 2026-05 gate for that Agent. This is a real enforcement point
  in the applier, not the context-widening heuristic the earlier text called
  one.

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

- Room and chat Agents gain a memory-write action (`memory.remember`, or a
  capture of the same shape) that lands in the applier under §1/§2. Until it
  exists this ADR governs nothing, which was the situation before this ADR
  was implemented.
- The proposal applier remains the only writer of `memory_entries`; §2
  writes go through it with the acting Agent as author and no approver, and
  the applier enforces §1 and §2's conditions — no adapter, job or route
  inserts directly.
- External chat capture still creates Activity records first (B12).
- Memory quality is governed by versioning, provenance and pruning rather
  than by pre-approval; a bad memory is found and reversed, not prevented by
  a queue nobody reads.
- B10 is rewritten to state this decision.

## Revision history

- **2026-05** — accepted: agents do not directly write active memory; every
  change is a proposal a person approves.
- **2026-08-27** — rewritten for current names; decision unchanged.
- **2026-08-28** — rewritten and accepted under ADR 0017: pre-approval kept only
  for writes that widen reach; other Agent writes bounded, versioned and
  reviewable after. The 2026-05 reasoning (control, audit, quality) is kept;
  the mechanism delivering it changes because the original one no longer
  delivers it at volume.
- **2026-08-28** — implemented. Three corrections from the implementation: §3's
  "Space activity" is the Project's updates, the surface that exists; and the
  circuit breaker counts what still stands — active entries plus pending
  proposals from that session — so ordinary revision does not walk toward the
  limit and archiving what an over-eager session wrote is what lets it write
  again.
  The breaker is also per person within a session, for the reason §2 now
  states. "One action restores it" is the pair of actions the version chain
  actually allows: archive the version that replaced it, then restore the one
  it replaced — a single Restore while the newer version still stands is
  refused, because two active rows on one chain have no answer to which one
  the memory is.
- **2026-08-28** — two corrections after implementation review: §1 names
  another Agent's content as well as a person's (an Agent revises what *it*
  wrote), and §2's breaker counts within the Run where a conversation has no
  session.
